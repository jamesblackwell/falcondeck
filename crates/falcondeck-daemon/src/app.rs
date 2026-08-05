use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use chrono::Utc;
use falcondeck_core::{
    AgentCapabilitySummary, AgentProvider, ApprovalDecision, CollaborationModeSummary,
    CommandResponse, ConnectWorkspaceRequest, ConversationItem, DaemonInfo, DaemonSnapshot,
    EventEnvelope, FalconDeckPreferences, HealthResponse, InteractiveRequest,
    InteractiveRequestKind, InteractiveResponsePayload, PairingPublicKeyBundle,
    PairingStatusResponse, RemoteConnectionStatus, RemotePairingSession, RemoteStatusResponse,
    SendTurnRequest, ServiceLevel, SkillSummary, SnapshotRequest, StartPairingRequest,
    StartPairingResponse, StartRemotePairingRequest, StartReviewRequest, StartThreadRequest,
    ThreadAgentParams, ThreadAttention, ThreadDetail, ThreadDetailRequest, ThreadHandle,
    ThreadStatus, ThreadSummary, UnifiedEvent, UpdatePreferencesRequest, UpdateThreadRequest,
    WorkspaceAgentSummary, WorkspaceStatus, WorkspaceSummary,
    crypto::{
        LocalBoxKeyPair, build_pairing_public_key_bundle, generate_data_key,
        verify_pairing_public_key_bundle,
    },
};
use serde_json::{Value, json};
use tokio::{
    sync::mpsc,
    sync::{Mutex, broadcast},
    task::JoinHandle,
    time::{Duration, sleep, timeout},
};
use tracing::debug;
use uuid::Uuid;

use crate::{
    claude::{ClaudeBootstrap, ClaudeProviderMetadata, ClaudeRuntime},
    codex::{
        CodexBootstrap, CodexProviderMetadata, CodexSession, extract_string, extract_thread_id,
        extract_thread_title, parse_account, parse_thread_plan,
    },
    error::DaemonError,
    skills::{
        discover_file_backed_skills, merge_skills, parse_codex_provider_skills, skills_for_provider,
    },
};

mod agent_helpers;
pub(crate) mod conversation_helpers;
mod notifications;
mod remote_bridge;
mod storage;
mod threads;
mod workspace_ops;

use agent_helpers::*;
use conversation_helpers::*;
use remote_bridge::*;
use storage::*;
use threads::{interactive_request_counts, refresh_thread_attention};

const WORKSPACE_RESTORE_TIMEOUT: Duration = Duration::from_secs(30);

/// Classifies errors from the remote relay connection so the retry loop can
/// apply appropriate backoff.  Most errors (network drops, broadcast lag) are
/// transient and should retry quickly.  Only permanent failures (channel
/// closed, internal shutdown) use exponential backoff.
enum RemoteBridgeError {
    Transient(String),
    Persistent(String),
}

impl RemoteBridgeError {
    fn message(&self) -> &str {
        match self {
            Self::Transient(msg) | Self::Persistent(msg) => msg,
        }
    }

    fn is_transient(&self) -> bool {
        matches!(self, Self::Transient(_))
    }
}

/// All bare `String` errors produced by `.map_err(|e| format!(...))` are
/// treated as transient by default — only explicitly-constructed `Persistent`
/// values bypass fast retry.
impl From<String> for RemoteBridgeError {
    fn from(s: String) -> Self {
        Self::Transient(s)
    }
}

fn relay_error_detail_from_body(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }

    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| Some(trimmed.to_string()))
}

async fn relay_request_error(response: reqwest::Response, context: &str) -> String {
    let status = response.status();
    let detail = match response.text().await {
        Ok(body) => relay_error_detail_from_body(&body),
        Err(_) => None,
    };

    match detail {
        Some(detail) => format!("{context} failed with status {status}: {detail}"),
        None => format!("{context} failed with status {status}"),
    }
}

fn should_clear_persisted_remote_for_bridge_error(
    error_msg: &str,
    has_trusted_device: bool,
) -> bool {
    !has_trusted_device && is_remote_bridge_missing_session_error(error_msg)
}

fn is_remote_bridge_auth_error(error_msg: &str) -> bool {
    error_msg.contains("invalid daemon token") || error_msg.contains("invalid session token")
}

fn is_remote_bridge_missing_session_error(error_msg: &str) -> bool {
    error_msg.contains("session not found")
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<InnerState>,
}

struct InnerState {
    daemon: DaemonInfo,
    codex_bin: String,
    claude_bin: String,
    state_path: PathBuf,
    preferences_path: PathBuf,
    sequence: AtomicU64,
    broadcaster: broadcast::Sender<EventEnvelope>,
    workspaces: Mutex<HashMap<String, ManagedWorkspace>>,
    saved_workspaces: Mutex<HashMap<String, PersistedWorkspaceState>>,
    interactive_requests: Mutex<HashMap<(String, String), PendingServerRequest>>,
    preferences: Mutex<FalconDeckPreferences>,
    remote: Mutex<RemoteBridgeState>,
}

struct ManagedWorkspace {
    summary: WorkspaceSummary,
    codex_session: Option<Arc<CodexSession>>,
    claude_runtime: Option<Arc<ClaudeRuntime>>,
    threads: HashMap<String, ManagedThread>,
}

struct ManagedThread {
    summary: ThreadSummary,
    items: Vec<ConversationItem>,
    assistant_items: HashMap<String, usize>,
    reasoning_items: HashMap<String, usize>,
    tool_items: HashMap<String, usize>,
    manual_title: bool,
    ai_title_generated: bool,
    ai_title_in_flight: bool,
    requires_resume: bool,
}

#[derive(Clone)]
struct PendingServerRequest {
    raw_id: Value,
    request: InteractiveRequest,
}

struct RemoteBridgeState {
    status: RemoteConnectionStatus,
    relay_url: Option<String>,
    pairing: Option<RemotePairingState>,
    pending_pairing: Option<RemotePairingState>,
    daemon_token: Option<String>,
    last_error: Option<String>,
    task: Option<JoinHandle<()>>,
    pairing_watch_task: Option<JoinHandle<()>>,
    command_tx: Option<mpsc::UnboundedSender<RemoteBridgeCommand>>,
}

#[derive(Debug, Clone)]
struct RemotePairingState {
    pairing_id: String,
    pairing_code: String,
    session_id: Option<String>,
    device_id: Option<String>,
    trusted_at: Option<chrono::DateTime<Utc>>,
    expires_at: chrono::DateTime<Utc>,
    client_bundle: Option<PairingPublicKeyBundle>,
    local_key_pair: LocalBoxKeyPair,
    data_key: [u8; 32],
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
struct PersistedAppState {
    #[serde(default, deserialize_with = "deserialize_persisted_workspaces")]
    workspaces: Vec<PersistedWorkspaceState>,
    remote: Option<PersistedRemoteState>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct PersistedWorkspaceState {
    path: String,
    current_thread_id: Option<String>,
    updated_at: Option<chrono::DateTime<Utc>>,
    #[serde(default = "default_persisted_provider")]
    default_provider: Option<AgentProvider>,
    #[serde(default)]
    last_error: Option<String>,
    #[serde(default)]
    archived_thread_ids: Vec<String>,
    #[serde(default)]
    thread_states: Vec<PersistedThreadState>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct PersistedThreadState {
    thread_id: String,
    #[serde(default)]
    provider: Option<AgentProvider>,
    #[serde(default)]
    native_session_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    manual_title: bool,
    #[serde(default)]
    ai_title_generated: bool,
    #[serde(default)]
    status: Option<ThreadStatus>,
    #[serde(default)]
    last_error: Option<String>,
    #[serde(default)]
    last_read_seq: u64,
    #[serde(default)]
    last_agent_activity_seq: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
enum PersistedWorkspaceEntry {
    LegacyPath(String),
    State(PersistedWorkspaceState),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedRemoteState {
    relay_url: String,
    daemon_token: String,
    pairing_id: String,
    pairing_code: String,
    session_id: Option<String>,
    device_id: Option<String>,
    trusted_at: Option<chrono::DateTime<Utc>>,
    expires_at: chrono::DateTime<Utc>,
    #[serde(default)]
    client_bundle: Option<PairingPublicKeyBundle>,
    #[serde(default)]
    client_public_key: Option<String>,
    #[serde(default)]
    secure_storage_key: Option<String>,
    #[serde(default)]
    local_secret_key_base64: Option<String>,
    #[serde(default)]
    data_key_base64: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedRemoteSecrets {
    local_secret_key_base64: String,
    data_key_base64: String,
}

#[derive(Debug, Clone)]
enum RemoteBridgeCommand {
    PublishBootstrap {
        pairing: RemotePairingState,
        client_bundle: PairingPublicKeyBundle,
    },
}

impl AppState {
    pub fn new(version: String, codex_bin: String, claude_bin: String) -> Self {
        Self::new_with_state_path(version, codex_bin, claude_bin, default_state_path())
    }

    pub fn new_with_state_path(
        version: String,
        codex_bin: String,
        claude_bin: String,
        state_path: PathBuf,
    ) -> Self {
        let (broadcaster, _) = broadcast::channel(2048);
        let preferences_path = default_preferences_path(&state_path);
        Self {
            inner: Arc::new(InnerState {
                daemon: DaemonInfo {
                    version,
                    started_at: Utc::now(),
                },
                codex_bin,
                claude_bin,
                state_path,
                preferences_path,
                sequence: AtomicU64::new(1),
                broadcaster,
                workspaces: Mutex::new(HashMap::new()),
                saved_workspaces: Mutex::new(HashMap::new()),
                interactive_requests: Mutex::new(HashMap::new()),
                preferences: Mutex::new(FalconDeckPreferences::default()),
                remote: Mutex::new(RemoteBridgeState {
                    status: RemoteConnectionStatus::Inactive,
                    relay_url: None,
                    pairing: None,
                    pending_pairing: None,
                    daemon_token: None,
                    last_error: None,
                    task: None,
                    pairing_watch_task: None,
                    command_tx: None,
                }),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.inner.broadcaster.subscribe()
    }

    pub async fn restore_local_state(&self) -> Result<(), DaemonError> {
        let preferences = load_preferences(&self.inner.preferences_path).await?;
        {
            let mut current = self.inner.preferences.lock().await;
            *current = preferences.clone();
        }
        persist_preferences(&self.inner.preferences_path, &preferences).await?;

        let persisted = load_persisted_app_state(&self.inner.state_path).await?;
        {
            let mut saved_workspaces = self.inner.saved_workspaces.lock().await;
            saved_workspaces.clear();
            for workspace in &persisted.workspaces {
                let mut normalized_workspace = workspace.clone();
                normalized_workspace.path = normalize_workspace_path(&workspace.path);
                saved_workspaces.insert(normalized_workspace.path.clone(), normalized_workspace);
            }
        }

        let mut workspaces_to_restore = Vec::new();
        for mut workspace in persisted.workspaces {
            workspace.path = normalize_workspace_path(&workspace.path);
            let restored = self
                .restore_workspace_placeholder(
                    &workspace,
                    WorkspaceStatus::Connecting,
                    workspace.last_error.clone(),
                )
                .await?;
            self.emit(
                Some(restored.id.clone()),
                None,
                UnifiedEvent::Snapshot {
                    snapshot: self.snapshot().await,
                },
            );
            workspaces_to_restore.push(workspace);
        }

        if !workspaces_to_restore.is_empty() {
            let app = self.clone();
            tokio::spawn(async move {
                for workspace in workspaces_to_restore {
                    let result = timeout(
                        WORKSPACE_RESTORE_TIMEOUT,
                        app.connect_workspace_internal(
                            ConnectWorkspaceRequest {
                                path: workspace.path.clone(),
                            },
                            Some(&workspace),
                        ),
                    )
                    .await;

                    if let Err(error) = match result {
                        Ok(Ok(_)) => Ok(()),
                        Ok(Err(error)) => Err(error.to_string()),
                        Err(_) => Err("workspace restore timed out".to_string()),
                    } {
                        tracing::warn!("failed to restore workspace {}: {error}", workspace.path);
                        let _ = app
                            .update_workspace_placeholder_status(
                                &workspace.path,
                                WorkspaceStatus::Disconnected,
                                Some(error),
                            )
                            .await;
                    }
                }
            });
        }

        if let Some(remote) = persisted.remote {
            let should_migrate_secure_storage = remote.secure_storage_key.is_none()
                || remote.local_secret_key_base64.is_some()
                || remote.data_key_base64.is_some();
            if remote.device_id.is_none() && relay_url_looks_legacy_loopback(&remote.relay_url) {
                tracing::info!(
                    "skipping legacy loopback remote pairing {} for relay {}",
                    remote.pairing_id,
                    remote.relay_url
                );
                self.clear_remote_bridge_state().await;
                self.persist_local_state().await?;
            } else if remote.device_id.is_none() && remote.expires_at <= Utc::now() {
                tracing::info!(
                    "skipping expired persisted remote pairing {}",
                    remote.pairing_id
                );
                self.clear_remote_bridge_state().await;
                self.persist_local_state().await?;
            } else if let Some(reason) = invalid_persisted_remote_reason(&remote) {
                tracing::info!(
                    "discarding persisted remote pairing {}: {reason}",
                    remote.pairing_id
                );
                self.clear_remote_bridge_state().await;
                self.persist_local_state().await?;
            } else if let Err(error) = self.resume_remote_bridge(remote).await {
                tracing::warn!("failed to restore remote bridge: {error}");
            } else if should_migrate_secure_storage {
                self.persist_local_state().await?;
            }
        }

        Ok(())
    }

    async fn restore_workspace_placeholder(
        &self,
        persisted_workspace: &PersistedWorkspaceState,
        status: WorkspaceStatus,
        last_error: Option<String>,
    ) -> Result<WorkspaceSummary, DaemonError> {
        let path_string = normalize_workspace_path(&persisted_workspace.path);
        let now = Utc::now();
        let workspace_id = format!("workspace-{}", Uuid::new_v4().simple());
        let workspace_last_error = last_error
            .clone()
            .or_else(|| persisted_workspace.last_error.clone());
        let current_thread_id = persisted_workspace.current_thread_id.clone().or_else(|| {
            persisted_workspace
                .thread_states
                .iter()
                .max_by_key(|thread| thread.thread_id.clone())
                .map(|thread| thread.thread_id.clone())
        });
        let mut threads = HashMap::new();
        for state in &persisted_workspace.thread_states {
            let status = match state.status.clone().unwrap_or(ThreadStatus::Idle) {
                ThreadStatus::Running => ThreadStatus::Error,
                other => other,
            };
            let thread_last_error = state.last_error.clone().or_else(|| {
                matches!(state.status, Some(ThreadStatus::Running))
                    .then(|| "FalconDeck was closed while this turn was running".to_string())
            });
            let summary = ThreadSummary {
                id: state.thread_id.clone(),
                workspace_id: workspace_id.clone(),
                title: state
                    .title
                    .clone()
                    .unwrap_or_else(|| "Restored thread".to_string()),
                provider: state.provider.clone().unwrap_or(AgentProvider::Codex),
                native_session_id: state.native_session_id.clone(),
                status,
                updated_at: now,
                last_message_preview: None,
                latest_turn_id: None,
                latest_plan: None,
                latest_diff: None,
                last_tool: None,
                last_error: thread_last_error.or_else(|| workspace_last_error.clone()),
                agent: ThreadAgentParams::default(),
                attention: ThreadAttention {
                    last_read_seq: state.last_read_seq,
                    last_agent_activity_seq: state.last_agent_activity_seq,
                    ..ThreadAttention::default()
                },
                is_archived: persisted_workspace
                    .archived_thread_ids
                    .contains(&state.thread_id),
            };
            let mut thread = ManagedThread::new(summary);
            thread.manual_title = state.manual_title;
            thread.ai_title_generated = state.ai_title_generated
                || (!is_placeholder_thread_title(&thread.summary.title)
                    && !is_provisional_thread_title(&thread.summary.title));
            threads.insert(state.thread_id.clone(), thread);
        }
        let summary = WorkspaceSummary {
            id: workspace_id.clone(),
            path: path_string.clone(),
            status,
            agents: vec![
                WorkspaceAgentSummary {
                    provider: AgentProvider::Codex,
                    account: falcondeck_core::AccountSummary {
                        status: falcondeck_core::AccountStatus::Unknown,
                        label: "Codex reconnecting".to_string(),
                    },
                    models: Vec::new(),
                    collaboration_modes: Vec::new(),
                    skills: Vec::new(),
                    supports_plan_mode: true,
                    supports_native_plan_mode: true,
                    capabilities: AgentCapabilitySummary {
                        supports_review: true,
                    },
                },
                WorkspaceAgentSummary {
                    provider: AgentProvider::Claude,
                    account: falcondeck_core::AccountSummary {
                        status: falcondeck_core::AccountStatus::Unknown,
                        label: "Claude reconnecting".to_string(),
                    },
                    models: Vec::new(),
                    collaboration_modes: Vec::new(),
                    skills: Vec::new(),
                    supports_plan_mode: true,
                    supports_native_plan_mode: true,
                    capabilities: AgentCapabilitySummary {
                        supports_review: false,
                    },
                },
            ],
            skills: Vec::new(),
            default_provider: persisted_workspace
                .default_provider
                .clone()
                .unwrap_or(AgentProvider::Codex),
            models: Vec::new(),
            collaboration_modes: Vec::new(),
            supports_plan_mode: true,
            supports_native_plan_mode: true,
            account: falcondeck_core::AccountSummary {
                status: falcondeck_core::AccountStatus::Unknown,
                label: "Reconnecting".to_string(),
            },
            current_thread_id,
            connected_at: now,
            updated_at: persisted_workspace.updated_at.unwrap_or(now),
            last_error: workspace_last_error,
        };

        let mut workspaces = self.inner.workspaces.lock().await;
        if let Some(existing) = workspaces
            .values_mut()
            .find(|workspace| workspace.summary.path == path_string)
        {
            existing.summary = summary.clone();
            existing.threads = threads;
            return Ok(existing.summary.clone());
        }

        workspaces.insert(
            workspace_id,
            ManagedWorkspace {
                summary: summary.clone(),
                codex_session: None,
                claude_runtime: None,
                threads,
            },
        );
        Ok(summary)
    }

    async fn update_workspace_placeholder_status(
        &self,
        workspace_path: &str,
        status: WorkspaceStatus,
        last_error: Option<String>,
    ) -> Result<(), DaemonError> {
        let canonical_path = normalize_workspace_path(workspace_path);
        let workspace_id = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .values_mut()
                .find(|workspace| workspace.summary.path == canonical_path)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            workspace.summary.status = status;
            workspace.summary.last_error = last_error.clone();
            for thread in workspace.threads.values_mut() {
                if thread.summary.last_error.is_none() {
                    thread.summary.last_error = last_error.clone();
                }
            }
            workspace.summary.id.clone()
        };
        self.emit(
            Some(workspace_id),
            None,
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );
        self.persist_local_state().await?;
        Ok(())
    }

    pub async fn health(&self) -> HealthResponse {
        let workspaces = self.inner.workspaces.lock().await.len();
        HealthResponse {
            ok: true,
            version: self.inner.daemon.version.clone(),
            workspaces,
        }
    }

    pub async fn shutdown(&self) -> Result<(), DaemonError> {
        let snapshots = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .values()
                .map(|workspace| {
                    (
                        workspace.summary.id.clone(),
                        workspace.summary.path.clone(),
                        workspace.codex_session.clone(),
                        workspace.claude_runtime.clone(),
                        workspace
                            .threads
                            .values()
                            .map(|thread| {
                                (
                                    thread.summary.id.clone(),
                                    matches!(thread.summary.status, ThreadStatus::Running),
                                )
                            })
                            .collect::<Vec<_>>(),
                    )
                })
                .collect::<Vec<_>>()
        };

        for (workspace_id, _path, codex_session, claude_runtime, threads) in snapshots {
            if let Some(runtime) = claude_runtime {
                let _ = runtime.shutdown().await;
            }
            if let Some(session) = codex_session {
                let _ = session.shutdown().await;
            }
            for (thread_id, was_running) in threads {
                if !was_running {
                    continue;
                }
                let _ = self
                    .with_thread_mut(&workspace_id, &thread_id, |thread| {
                        thread.status = ThreadStatus::Error;
                        thread.last_error =
                            Some("FalconDeck was closed while this turn was running".to_string());
                        thread.updated_at = Utc::now();
                    })
                    .await;
            }
        }

        self.persist_local_state().await
    }

    async fn clear_remote_bridge_state(&self) {
        let mut remote = self.inner.remote.lock().await;
        if let (Some(relay_url), Some(pairing)) =
            (remote.relay_url.as_ref(), remote.pairing.as_ref())
        {
            if let Err(error) = delete_remote_secrets(remote_secret_storage_key(
                relay_url,
                &pairing.pairing_id,
                pairing.session_id.as_deref(),
            )) {
                tracing::warn!("failed to clear remote secure storage: {error}");
            }
        }
        if let Some(task) = remote.task.take() {
            task.abort();
        }
        if let Some(task) = remote.pairing_watch_task.take() {
            task.abort();
        }
        remote.status = RemoteConnectionStatus::Inactive;
        remote.relay_url = None;
        remote.pairing = None;
        remote.pending_pairing = None;
        remote.daemon_token = None;
        remote.last_error = None;
        remote.command_tx = None;
    }

    pub async fn remote_status(&self) -> RemoteStatusResponse {
        let snapshot = {
            let mut remote = self.inner.remote.lock().await;
            reconcile_remote_runtime_state(&mut remote);
            (
                build_remote_status_response(&remote),
                remote.relay_url.clone(),
                remote
                    .pairing
                    .as_ref()
                    .and_then(|pairing| pairing.session_id.clone()),
                remote.daemon_token.clone(),
            )
        };

        let (mut status, relay_url, session_id, daemon_token) = snapshot;
        if let (Some(relay_url), Some(session_id), Some(daemon_token)) =
            (relay_url, session_id, daemon_token)
        {
            if let Ok(remote_status) = self
                .fetch_remote_status(&relay_url, &session_id, &daemon_token)
                .await
            {
                status.trusted_devices = remote_status.devices;
                status.presence = Some(remote_status.presence);
            }
        }

        status
    }

    pub async fn start_remote_pairing(
        &self,
        request: StartRemotePairingRequest,
    ) -> Result<RemoteStatusResponse, DaemonError> {
        let relay_url = normalize_relay_url(&request.relay_url)?;
        let existing_remote = {
            let mut remote = self.inner.remote.lock().await;
            reconcile_remote_runtime_state(&mut remote);
            let has_live_task = has_live_remote_task(&remote);
            let should_reuse_pending = remote.relay_url.as_deref() == Some(relay_url.as_str())
                && status_pairing(&remote).is_some_and(|pairing| pairing.expires_at > Utc::now())
                && has_live_task
                && (matches!(remote.status, RemoteConnectionStatus::PairingPending)
                    || remote.pending_pairing.is_some());
            if should_reuse_pending {
                return Ok(build_remote_status_response(&remote));
            }
            if remote.relay_url.as_deref() == Some(relay_url.as_str()) {
                remote.pairing.clone().zip(remote.daemon_token.clone())
            } else {
                None
            }
        };

        {
            let remote = self.inner.remote.lock().await;
            if remote.relay_url.as_deref() == Some(relay_url.as_str())
                && matches!(
                    remote.status,
                    RemoteConnectionStatus::Revoked | RemoteConnectionStatus::Error
                )
            {
                drop(remote);
                self.clear_remote_bridge_state().await;
            }
        }
        let client = reqwest::Client::new();
        let (local_key_pair, data_key, existing_session_id, existing_daemon_token, seed_pairing) =
            if let Some((pairing, daemon_token)) = existing_remote {
                (
                    pairing.local_key_pair.clone(),
                    pairing.data_key,
                    pairing.session_id.clone(),
                    Some(daemon_token),
                    Some(pairing),
                )
            } else {
                (
                    LocalBoxKeyPair::generate(),
                    generate_data_key(),
                    None,
                    None,
                    None,
                )
            };
        let response = client
            .post(format!("{relay_url}/v1/pairings"))
            .json(&StartPairingRequest {
                label: Some(host_label()),
                ttl_seconds: Some(600),
                existing_session_id: existing_session_id.clone(),
                daemon_token: existing_daemon_token.clone(),
                daemon_bundle: Some(build_pairing_public_key_bundle(&local_key_pair)),
            })
            .send()
            .await
            .map_err(|error| DaemonError::Rpc(format!("failed to contact relay: {error}")))?;
        let response = if response.status().is_success() {
            response
        } else {
            return Err(DaemonError::Rpc(
                relay_request_error(response, "relay pairing request").await,
            ));
        };
        let pairing = response
            .json::<StartPairingResponse>()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to parse relay pairing response: {error}"))
            })?;

        let remote_pairing = if let Some(previous_pairing) = seed_pairing {
            RemotePairingState {
                pairing_id: pairing.pairing_id.clone(),
                pairing_code: pairing.pairing_code.clone(),
                session_id: Some(pairing.session_id.clone()),
                device_id: previous_pairing.device_id,
                trusted_at: previous_pairing.trusted_at,
                expires_at: pairing.expires_at,
                client_bundle: None,
                local_key_pair,
                data_key,
            }
        } else {
            RemotePairingState {
                pairing_id: pairing.pairing_id.clone(),
                pairing_code: pairing.pairing_code.clone(),
                session_id: Some(pairing.session_id.clone()),
                device_id: None,
                trusted_at: None,
                expires_at: pairing.expires_at,
                client_bundle: None,
                local_key_pair,
                data_key,
            }
        };

        let response = {
            let mut remote = self.inner.remote.lock().await;
            reconcile_remote_runtime_state(&mut remote);
            let additional_pairing = remote.task.is_some();
            if !additional_pairing {
                if let Some(task) = remote.task.take() {
                    task.abort();
                }
            }
            if let Some(task) = remote.pairing_watch_task.take() {
                task.abort();
            }
            if !additional_pairing {
                remote.status = RemoteConnectionStatus::PairingPending;
            }
            remote.relay_url = Some(relay_url.clone());
            remote.daemon_token = Some(pairing.daemon_token.clone());
            remote.last_error = None;

            if additional_pairing {
                remote.pending_pairing = Some(RemotePairingState {
                    device_id: None,
                    trusted_at: None,
                    client_bundle: None,
                    ..remote_pairing.clone()
                });
                let app = self.clone();
                let watch_task = tokio::spawn(async move {
                    app.watch_pairing_claim(relay_url, pairing.daemon_token, pairing.pairing_id)
                        .await;
                });
                remote.pairing_watch_task = Some(watch_task);
            } else {
                remote.pending_pairing = None;
                remote.pairing = Some(remote_pairing.clone());
                let (command_tx, command_rx) = mpsc::unbounded_channel();
                let app = self.clone();
                let task = tokio::spawn(async move {
                    app.run_remote_bridge(relay_url, pairing.daemon_token, command_rx)
                        .await;
                });
                remote.command_tx = Some(command_tx);
                remote.task = Some(task);
            }
            build_remote_status_response(&remote)
        };

        self.persist_local_state().await?;

        Ok(response)
    }

    pub async fn revoke_remote_device(
        &self,
        device_id: &str,
    ) -> Result<RemoteStatusResponse, DaemonError> {
        let (relay_url, session_id, daemon_token) =
            {
                let remote = self.inner.remote.lock().await;
                let relay_url = remote.relay_url.clone().ok_or_else(|| {
                    DaemonError::Rpc("remote relay is not configured".to_string())
                })?;
                let session_id = remote
                    .pairing
                    .as_ref()
                    .and_then(|pairing| pairing.session_id.clone())
                    .ok_or_else(|| DaemonError::Rpc("remote session is not ready".to_string()))?;
                let daemon_token = remote.daemon_token.clone().ok_or_else(|| {
                    DaemonError::Rpc("remote daemon token is missing".to_string())
                })?;
                (relay_url, session_id, daemon_token)
            };

        let response = reqwest::Client::new()
            .delete(format!(
                "{}/v1/sessions/{}/devices/{}",
                relay_url.trim_end_matches('/'),
                session_id,
                device_id
            ))
            .bearer_auth(&daemon_token)
            .send()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to revoke remote device: {error}"))
            })?;
        if !response.status().is_success() {
            return Err(DaemonError::Rpc(
                relay_request_error(response, "remote device revoke request").await,
            ));
        }

        Ok(self.remote_status().await)
    }

    pub async fn snapshot(&self) -> DaemonSnapshot {
        let workspaces = self.inner.workspaces.lock().await;
        let interactive_requests = self.inner.interactive_requests.lock().await;
        let preferences = self.inner.preferences.lock().await.clone();

        let mut workspace_list = workspaces
            .values()
            .map(|workspace| workspace.summary.clone())
            .collect::<Vec<_>>();
        workspace_list.sort_by(|left, right| left.path.cmp(&right.path));

        let mut threads = workspaces
            .values()
            .flat_map(|workspace| {
                workspace.threads.values().map(|thread| {
                    let mut summary = thread.summary.clone();
                    let (pending_approval_count, pending_question_count) =
                        interactive_request_counts(&interactive_requests, &summary.id);
                    refresh_thread_attention(
                        &mut summary,
                        pending_approval_count,
                        pending_question_count,
                    );
                    summary
                })
            })
            .collect::<Vec<_>>();
        threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

        let mut interactive_request_list = interactive_requests
            .values()
            .map(|request| request.request.clone())
            .collect::<Vec<_>>();
        interactive_request_list.sort_by(|left, right| right.created_at.cmp(&left.created_at));

        DaemonSnapshot {
            daemon: self.inner.daemon.clone(),
            workspaces: workspace_list,
            threads,
            interactive_requests: interactive_request_list,
            preferences,
        }
    }

    pub async fn snapshot_with_request(&self, request: &SnapshotRequest) -> DaemonSnapshot {
        let mut snapshot = self.snapshot().await;
        if request.include_archived_threads {
            return snapshot;
        }

        let visible_thread_ids = snapshot
            .threads
            .iter()
            .filter(|thread| !thread.is_archived)
            .map(|thread| thread.id.clone())
            .collect::<std::collections::HashSet<_>>();

        snapshot
            .threads
            .retain(|thread| visible_thread_ids.contains(&thread.id));
        snapshot.workspaces.iter_mut().for_each(|workspace| {
            if workspace
                .current_thread_id
                .as_ref()
                .is_some_and(|thread_id| !visible_thread_ids.contains(thread_id))
            {
                workspace.current_thread_id = None;
            }
        });
        snapshot.interactive_requests.retain(|request| {
            request
                .thread_id
                .as_ref()
                .is_none_or(|thread_id| visible_thread_ids.contains(thread_id))
        });
        snapshot
    }

    pub async fn preferences(&self) -> FalconDeckPreferences {
        self.inner.preferences.lock().await.clone()
    }

    pub async fn update_preferences(
        &self,
        request: UpdatePreferencesRequest,
    ) -> Result<FalconDeckPreferences, DaemonError> {
        let updated = {
            let preferences = self.inner.preferences.lock().await;
            let mut next = preferences.clone();
            apply_preferences_patch(&mut next, request);
            next
        };
        persist_preferences(&self.inner.preferences_path, &updated).await?;
        {
            let mut preferences = self.inner.preferences.lock().await;
            *preferences = updated.clone();
        }
        self.emit(
            None,
            None,
            UnifiedEvent::PreferencesUpdated {
                preferences: updated.clone(),
            },
        );
        self.emit(
            None,
            None,
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );
        Ok(updated)
    }

    pub async fn connect_workspace(
        &self,
        request: ConnectWorkspaceRequest,
    ) -> Result<WorkspaceSummary, DaemonError> {
        workspace_ops::connect_workspace(self, request).await
    }

    async fn connect_workspace_internal(
        &self,
        request: ConnectWorkspaceRequest,
        persisted_workspace: Option<&PersistedWorkspaceState>,
    ) -> Result<WorkspaceSummary, DaemonError> {
        workspace_ops::connect_workspace_internal(self, request, persisted_workspace).await
    }

    pub async fn start_thread(
        &self,
        request: StartThreadRequest,
    ) -> Result<ThreadHandle, DaemonError> {
        workspace_ops::start_thread(self, request).await
    }

    pub async fn archive_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        workspace_ops::archive_thread(self, workspace_id, thread_id).await
    }

    pub async fn unarchive_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        workspace_ops::unarchive_thread(self, workspace_id, thread_id).await
    }

    pub async fn send_turn(
        &self,
        request: SendTurnRequest,
    ) -> Result<CommandResponse, DaemonError> {
        workspace_ops::send_turn(self, request).await
    }

    pub async fn update_thread(
        &self,
        request: UpdateThreadRequest,
    ) -> Result<ThreadHandle, DaemonError> {
        workspace_ops::update_thread(self, request).await
    }

    pub async fn start_review(
        &self,
        request: StartReviewRequest,
    ) -> Result<CommandResponse, DaemonError> {
        workspace_ops::start_review(self, request).await
    }

    pub async fn interrupt_turn(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<CommandResponse, DaemonError> {
        workspace_ops::interrupt_turn(self, workspace_id, thread_id).await
    }

    pub async fn respond_to_interactive_request(
        &self,
        workspace_id: String,
        request_id: String,
        response: InteractiveResponsePayload,
    ) -> Result<CommandResponse, DaemonError> {
        workspace_ops::respond_to_interactive_request(self, workspace_id, request_id, response)
            .await
    }

    pub async fn collaboration_modes(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<CollaborationModeSummary>, DaemonError> {
        workspace_ops::collaboration_modes(self, workspace_id).await
    }

    pub async fn thread_detail(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadDetail, DaemonError> {
        workspace_ops::thread_detail(
            self,
            &ThreadDetailRequest {
                workspace_id: workspace_id.to_string(),
                thread_id: thread_id.to_string(),
                mode: falcondeck_core::ThreadDetailMode::Full,
                limit: None,
                before_item_id: None,
            },
        )
        .await
    }

    pub async fn thread_detail_with_request(
        &self,
        request: &ThreadDetailRequest,
    ) -> Result<ThreadDetail, DaemonError> {
        workspace_ops::thread_detail(self, request).await
    }

    pub async fn mark_thread_read(
        &self,
        workspace_id: &str,
        thread_id: &str,
        read_seq: u64,
    ) -> Result<ThreadSummary, DaemonError> {
        workspace_ops::mark_thread_read(self, workspace_id, thread_id, read_seq).await
    }

    async fn run_remote_bridge(
        &self,
        relay_url: String,
        daemon_token: String,
        mut command_rx: mpsc::UnboundedReceiver<RemoteBridgeCommand>,
    ) {
        let mut backoff_seconds = 1u64;
        loop {
            let Some(pairing) = ({
                let remote = self.inner.remote.lock().await;
                current_pairing_for_remote_attempt(&remote, &relay_url, &daemon_token)
            }) else {
                break;
            };

            let result = self
                .wait_for_claim_and_connect(
                    relay_url.clone(),
                    daemon_token.clone(),
                    pairing.clone(),
                    &mut command_rx,
                )
                .await;
            match result {
                Ok(()) => {
                    backoff_seconds = 1;
                }
                Err(error) => {
                    let error_msg = error.message().to_string();
                    let is_transient = error.is_transient();

                    let mut remote = self.inner.remote.lock().await;
                    let has_trusted_device = remote
                        .pairing
                        .as_ref()
                        .is_some_and(|pairing| pairing.device_id.is_some());
                    let should_clear_pairing = remote.pairing.as_ref().is_some_and(|pairing| {
                        pairing.device_id.is_none() && pairing.expires_at <= Utc::now()
                    });
                    let should_reset_persisted_remote =
                        should_clear_persisted_remote_for_bridge_error(
                            &error_msg,
                            has_trusted_device,
                        );
                    let auth_error = is_remote_bridge_auth_error(&error_msg);
                    remote.status = if should_clear_pairing {
                        RemoteConnectionStatus::Inactive
                    } else if should_reset_persisted_remote {
                        RemoteConnectionStatus::Revoked
                    } else if auth_error
                        || (has_trusted_device
                            && is_remote_bridge_missing_session_error(&error_msg))
                    {
                        RemoteConnectionStatus::Error
                    } else if !is_transient && backoff_seconds >= 8 {
                        RemoteConnectionStatus::Offline
                    } else {
                        RemoteConnectionStatus::Degraded
                    };
                    remote.last_error = Some(error_msg);
                    if should_clear_pairing || should_reset_persisted_remote {
                        if let (Some(current_relay_url), Some(current_pairing)) =
                            (remote.relay_url.as_ref(), remote.pairing.as_ref())
                        {
                            if let Err(error) = delete_remote_secrets(remote_secret_storage_key(
                                current_relay_url,
                                &current_pairing.pairing_id,
                                current_pairing.session_id.as_deref(),
                            )) {
                                tracing::warn!("failed to clear remote secure storage: {error}");
                            }
                        }
                        remote.relay_url = None;
                        remote.daemon_token = None;
                        remote.pairing = None;
                    }
                    drop(remote);
                    let _ = self.persist_local_state().await;
                    if should_clear_pairing || should_reset_persisted_remote {
                        break;
                    }
                    if is_transient {
                        sleep(Duration::from_secs(backoff_seconds)).await;
                        backoff_seconds = (backoff_seconds * 2).min(10);
                    } else {
                        sleep(Duration::from_secs(backoff_seconds)).await;
                        backoff_seconds = (backoff_seconds * 2).min(16);
                    }
                }
            }
        }
    }

    async fn wait_for_claim_and_connect(
        &self,
        relay_url: String,
        daemon_token: String,
        pairing: RemotePairingState,
        command_rx: &mut mpsc::UnboundedReceiver<RemoteBridgeCommand>,
    ) -> Result<(), RemoteBridgeError> {
        // If we already have a trusted device with a session, skip polling the
        // pairing endpoint entirely. Older trusted sessions may not have a
        // persisted signed client bundle, but they can still resume by relying
        // on the previously stored data key.
        let (session_id, device_id, client_bundle) = if let (Some(session_id), Some(device_id)) =
            (pairing.session_id.clone(), pairing.device_id.clone())
        {
            let client_bundle = match pairing.client_bundle.clone() {
                Some(client_bundle) => {
                    verify_pairing_public_key_bundle(&client_bundle).map_err(|error| {
                            RemoteBridgeError::Persistent(format!(
                                "trusted client bundle is not signed; please pair the remote device again: {error}"
                            ))
                        })?;
                    Some(client_bundle)
                }
                None => {
                    tracing::warn!(
                        "trusted remote restored without client bootstrap material; relying on persisted client data key"
                    );
                    None
                }
            };

            tracing::info!(
                "trusted device already present, skipping pairing poll (session={session_id}, device={device_id})"
            );
            (session_id, device_id, client_bundle)
        } else {
            // No trusted device yet — poll pairing status until claimed
            let client = reqwest::Client::new();
            loop {
                let response = client
                    .get(format!("{relay_url}/v1/pairings/{}", pairing.pairing_id))
                    .bearer_auth(&daemon_token)
                    .send()
                    .await
                    .map_err(|error| format!("failed to poll relay pairing: {error}"))?;
                let response = if response.status().is_success() {
                    response
                } else {
                    return Err(RemoteBridgeError::Transient(
                        relay_request_error(response, "relay pairing status").await,
                    ));
                };
                let response = response
                    .json::<PairingStatusResponse>()
                    .await
                    .map_err(|error| format!("failed to parse relay pairing status: {error}"))?;

                if let Some(client_bundle) = response.client_bundle.as_ref() {
                    verify_pairing_public_key_bundle(client_bundle).map_err(|error| {
                        RemoteBridgeError::Persistent(format!(
                            "relay pairing returned an invalid client bundle: {error}"
                        ))
                    })?;
                }

                if response.status == falcondeck_core::PairingStatus::Expired {
                    return Err(RemoteBridgeError::Persistent(
                        "relay pairing expired before it was claimed".to_string(),
                    ));
                }

                {
                    let mut remote = self.inner.remote.lock().await;
                    if let Some(current_pairing) = remote.pairing.as_mut() {
                        current_pairing.session_id = response.session_id.clone();
                        current_pairing.device_id = response.device_id.clone();
                        current_pairing.client_bundle = response.client_bundle.clone();
                        if response.device_id.is_some() && current_pairing.trusted_at.is_none() {
                            current_pairing.trusted_at = Some(Utc::now());
                        }
                    }
                }

                if let (Some(session_id), Some(device_id)) =
                    (response.session_id, response.device_id)
                {
                    let client_bundle = response.client_bundle.ok_or_else(|| {
                        RemoteBridgeError::Persistent(
                            "relay pairing completed without client key material".to_string(),
                        )
                    })?;
                    break (session_id, device_id, Some(client_bundle));
                }

                {
                    let mut remote = self.inner.remote.lock().await;
                    remote.status = RemoteConnectionStatus::PairingPending;
                    remote.last_error = None;
                }
                sleep(Duration::from_secs(2)).await;
            }
        };

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::DeviceTrusted;
            if let Some(current_pairing) = remote.pairing.as_mut() {
                current_pairing.device_id = Some(device_id.clone());
                current_pairing.client_bundle = client_bundle.clone();
                if current_pairing.trusted_at.is_none() {
                    current_pairing.trusted_at = Some(Utc::now());
                }
            }
            remote.last_error = None;
        }

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::Connecting;
            if let Some(current_pairing) = remote.pairing.as_mut() {
                current_pairing.session_id = Some(session_id.clone());
            }
            remote.last_error = None;
        }

        self.persist_local_state()
            .await
            .map_err(|error| format!("failed to persist remote pairing state: {error}"))?;

        self.connect_remote_session(
            relay_url,
            daemon_token,
            session_id,
            pairing,
            client_bundle,
            command_rx,
        )
        .await
    }

    async fn watch_pairing_claim(
        &self,
        relay_url: String,
        daemon_token: String,
        pairing_id: String,
    ) {
        let client = reqwest::Client::new();
        loop {
            let response = match client
                .get(format!("{relay_url}/v1/pairings/{pairing_id}"))
                .bearer_auth(&daemon_token)
                .send()
                .await
            {
                Ok(response) => {
                    let response = if response.status().is_success() {
                        response
                    } else {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            relay_request_error(response, "relay pairing status").await,
                        )
                        .await;
                        sleep(Duration::from_secs(2)).await;
                        continue;
                    };

                    match response.json::<PairingStatusResponse>().await {
                        Ok(payload) => payload,
                        Err(error) => {
                            self.set_pairing_watch_error(
                                &relay_url,
                                &daemon_token,
                                &pairing_id,
                                format!("failed to parse relay pairing status: {error}"),
                            )
                            .await;
                            sleep(Duration::from_secs(2)).await;
                            continue;
                        }
                    }
                }
                Err(error) => {
                    self.set_pairing_watch_error(
                        &relay_url,
                        &daemon_token,
                        &pairing_id,
                        format!("failed to poll relay pairing: {error}"),
                    )
                    .await;
                    sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };

            if let Some(client_bundle) = response.client_bundle.as_ref() {
                if let Err(error) = verify_pairing_public_key_bundle(client_bundle) {
                    self.set_pairing_watch_error(
                        &relay_url,
                        &daemon_token,
                        &pairing_id,
                        format!("relay pairing returned an invalid client bundle: {error}"),
                    )
                    .await;
                    sleep(Duration::from_secs(2)).await;
                    continue;
                }
            }

            if !self
                .pairing_watch_still_current(&relay_url, &daemon_token, &pairing_id)
                .await
            {
                return;
            }

            match response.status {
                falcondeck_core::PairingStatus::Pending => {
                    {
                        let mut remote = self.inner.remote.lock().await;
                        if let Some(current_pairing) = remote.pending_pairing.as_mut() {
                            if current_pairing.pairing_id == pairing_id {
                                current_pairing.session_id = response.session_id.clone();
                                current_pairing.client_bundle = response.client_bundle.clone();
                            }
                        }
                        remote.last_error = None;
                    }
                    sleep(Duration::from_secs(2)).await;
                }
                falcondeck_core::PairingStatus::Expired => {
                    let should_persist = {
                        let mut remote = self.inner.remote.lock().await;
                        if remote.relay_url.as_deref() != Some(relay_url.as_str())
                            || remote.daemon_token.as_deref() != Some(daemon_token.as_str())
                        {
                            false
                        } else {
                            if let Some(current_pairing) = remote.pending_pairing.as_ref() {
                                if current_pairing.pairing_id == pairing_id {
                                    remote.last_error = Some(
                                        "remote pairing expired before it was claimed".to_string(),
                                    );
                                }
                            }
                            remote.pending_pairing = None;
                            remote.pairing_watch_task = None;
                            true
                        }
                    };
                    if should_persist {
                        let _ = self.persist_local_state().await;
                    }
                    return;
                }
                falcondeck_core::PairingStatus::Claimed => {
                    let Some(session_id) = response.session_id.clone() else {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            "relay pairing was claimed without a session id".to_string(),
                        )
                        .await;
                        return;
                    };
                    let Some(device_id) = response.device_id.clone() else {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            "relay pairing was claimed without a device id".to_string(),
                        )
                        .await;
                        return;
                    };
                    let Some(client_bundle) = response.client_bundle.clone() else {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            "relay pairing completed without client key material".to_string(),
                        )
                        .await;
                        return;
                    };

                    let (command_to_publish, should_persist) = {
                        let mut remote = self.inner.remote.lock().await;
                        if remote.relay_url.as_deref() != Some(relay_url.as_str())
                            || remote.daemon_token.as_deref() != Some(daemon_token.as_str())
                            || remote
                                .pending_pairing
                                .as_ref()
                                .is_none_or(|current_pairing| {
                                    current_pairing.pairing_id != pairing_id
                                })
                        {
                            (None, false)
                        } else {
                            let Some(current_pairing) = remote.pending_pairing.as_mut() else {
                                return;
                            };
                            current_pairing.session_id = Some(session_id);
                            current_pairing.device_id = Some(device_id);
                            current_pairing.client_bundle = Some(client_bundle.clone());
                            if current_pairing.trusted_at.is_none() {
                                current_pairing.trusted_at = Some(Utc::now());
                            }
                            let pairing_snapshot = current_pairing.clone();
                            remote.pending_pairing = None;
                            remote.pairing_watch_task = None;
                            if let Some(command_tx) = remote.command_tx.clone() {
                                remote.last_error = None;
                                (
                                    Some((
                                        command_tx,
                                        RemoteBridgeCommand::PublishBootstrap {
                                            pairing: pairing_snapshot,
                                            client_bundle,
                                        },
                                    )),
                                    true,
                                )
                            } else {
                                remote.last_error = Some(
                                    "Additional remote pairing finished after the desktop relay bridge stopped. Generate a fresh pairing code.".to_string(),
                                );
                                remote.status = if remote
                                    .pairing
                                    .as_ref()
                                    .is_some_and(|pairing| pairing.device_id.is_some())
                                {
                                    RemoteConnectionStatus::Offline
                                } else {
                                    RemoteConnectionStatus::Inactive
                                };
                                (None, true)
                            }
                        }
                    };

                    if let Some((command_tx, command)) = command_to_publish {
                        let _ = command_tx.send(command);
                    }
                    if should_persist {
                        let _ = self.persist_local_state().await;
                    }
                    return;
                }
            }
        }
    }

    async fn resume_remote_bridge(&self, remote: PersistedRemoteState) -> Result<(), DaemonError> {
        let secure_storage_key = remote.secure_storage_key.clone().unwrap_or_else(|| {
            remote_secret_storage_key(
                &remote.relay_url,
                &remote.pairing_id,
                remote.session_id.as_deref(),
            )
        });
        let secrets = load_remote_secrets(&remote, &secure_storage_key)?;
        let local_key_pair = LocalBoxKeyPair::from_secret_key_base64(
            &secrets.local_secret_key_base64,
        )
        .map_err(|error| {
            DaemonError::BadRequest(format!("invalid persisted local key pair: {error}"))
        })?;
        let data_key = decode_fixed_base64::<32>(&secrets.data_key_base64).map_err(|error| {
            DaemonError::BadRequest(format!("invalid persisted relay data key: {error}"))
        })?;
        let pairing = RemotePairingState {
            pairing_id: remote.pairing_id,
            pairing_code: remote.pairing_code,
            session_id: remote.session_id,
            device_id: remote.device_id,
            trusted_at: remote.trusted_at,
            expires_at: remote.expires_at,
            client_bundle: remote.client_bundle,
            local_key_pair,
            data_key,
        };
        let relay_url = remote.relay_url;
        let daemon_token = remote.daemon_token;

        {
            let mut current = self.inner.remote.lock().await;
            if let Some(task) = current.task.take() {
                task.abort();
            }
            current.status = if pairing.device_id.is_some() {
                RemoteConnectionStatus::DeviceTrusted
            } else if pairing.session_id.is_some() {
                RemoteConnectionStatus::Connecting
            } else {
                RemoteConnectionStatus::PairingPending
            };
            current.relay_url = Some(relay_url.clone());
            current.daemon_token = Some(daemon_token.clone());
            current.pairing = Some(pairing.clone());
            current.pending_pairing = None;
            current.last_error = None;

            let (command_tx, command_rx) = mpsc::unbounded_channel();
            let app = self.clone();
            let task = tokio::spawn(async move {
                app.run_remote_bridge(relay_url, daemon_token, command_rx)
                    .await;
            });
            current.command_tx = Some(command_tx);
            current.task = Some(task);
        }

        Ok(())
    }

    async fn persist_local_state(&self) -> Result<(), DaemonError> {
        let saved_workspaces = self.inner.saved_workspaces.lock().await.clone();
        let mut persisted_workspaces = HashMap::new();
        for workspace in saved_workspaces.into_values() {
            let mut normalized_workspace = workspace;
            normalized_workspace.path = normalize_workspace_path(&normalized_workspace.path);
            persisted_workspaces.insert(normalized_workspace.path.clone(), normalized_workspace);
        }
        let workspaces = self.inner.workspaces.lock().await;
        for workspace in workspaces.values() {
            let normalized_path = normalize_workspace_path(&workspace.summary.path);
            let archived_thread_ids = workspace
                .threads
                .values()
                .filter(|thread| thread.summary.is_archived)
                .map(|thread| thread.summary.id.clone())
                .collect();
            let mut thread_states = workspace
                .threads
                .values()
                .map(|thread| PersistedThreadState {
                    thread_id: thread.summary.id.clone(),
                    provider: Some(thread.summary.provider.clone()),
                    native_session_id: thread.summary.native_session_id.clone(),
                    title: Some(thread.summary.title.clone()),
                    manual_title: thread.manual_title,
                    ai_title_generated: thread.ai_title_generated,
                    status: Some(thread.summary.status.clone()),
                    last_error: thread.summary.last_error.clone(),
                    last_read_seq: thread.summary.attention.last_read_seq,
                    last_agent_activity_seq: thread.summary.attention.last_agent_activity_seq,
                })
                .collect::<Vec<_>>();
            thread_states.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
            persisted_workspaces.insert(
                normalized_path.clone(),
                PersistedWorkspaceState {
                    path: normalized_path,
                    current_thread_id: workspace.summary.current_thread_id.clone(),
                    updated_at: Some(workspace.summary.updated_at),
                    default_provider: Some(workspace.summary.default_provider.clone()),
                    last_error: workspace.summary.last_error.clone(),
                    archived_thread_ids,
                    thread_states,
                },
            );
        }
        let mut persisted_workspaces = persisted_workspaces.into_values().collect::<Vec<_>>();
        persisted_workspaces.sort_by(|left, right| left.path.cmp(&right.path));
        persisted_workspaces.dedup_by(|left, right| left.path == right.path);
        drop(workspaces);

        let remote = self.inner.remote.lock().await;
        let persisted = PersistedAppState {
            workspaces: persisted_workspaces,
            remote: persisted_remote_state(&remote)?,
        };
        drop(remote);

        persist_app_state(&self.inner.state_path, &persisted).await
    }

    pub async fn ingest_notification(
        &self,
        workspace_id: &str,
        method: &str,
        params: Value,
    ) -> Result<(), DaemonError> {
        notifications::ingest_notification(self, workspace_id, method, params).await
    }

    pub async fn ingest_server_request(
        &self,
        workspace_id: &str,
        raw_id: Value,
        method: &str,
        params: Value,
    ) -> Result<(), DaemonError> {
        notifications::ingest_server_request(self, workspace_id, raw_id, method, params).await
    }

    pub fn emit_service(
        &self,
        workspace_id: Option<String>,
        thread_id: Option<String>,
        level: ServiceLevel,
        message: String,
        raw_method: Option<String>,
    ) -> Result<(), DaemonError> {
        if let (Some(workspace_id), Some(thread_id)) = (workspace_id.clone(), thread_id.clone()) {
            let app = self.clone();
            let service_message = message.clone();
            let service_level = level.clone();
            tokio::spawn(async move {
                let _ = app
                    .push_conversation_item(
                        &workspace_id,
                        &thread_id,
                        ConversationItem::Service {
                            id: format!("service-{}", Uuid::new_v4().simple()),
                            level: service_level,
                            message: service_message,
                            created_at: Utc::now(),
                        },
                        false,
                    )
                    .await;
            });
        }
        self.emit(
            workspace_id,
            thread_id,
            UnifiedEvent::Service {
                level,
                message,
                raw_method,
            },
        );
        Ok(())
    }

    fn emit(&self, workspace_id: Option<String>, thread_id: Option<String>, event: UnifiedEvent) {
        let envelope = EventEnvelope {
            seq: self.inner.sequence.fetch_add(1, Ordering::Relaxed),
            emitted_at: Utc::now(),
            workspace_id,
            thread_id,
            event,
        };
        let _ = self.inner.broadcaster.send(envelope);
    }

    pub async fn git_status(
        &self,
        workspace_id: &str,
    ) -> Result<falcondeck_core::GitStatusResponse, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        crate::git::git_status(&workspace.summary.path).await
    }

    pub async fn git_diff(
        &self,
        workspace_id: &str,
        path: Option<&str>,
    ) -> Result<falcondeck_core::GitDiffResponse, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        crate::git::git_diff(&workspace.summary.path, path).await
    }
}

trait IntoWorkspaceAgentUpdate {
    fn into_agent_summary(
        self,
        provider: AgentProvider,
        skills: Vec<SkillSummary>,
    ) -> WorkspaceAgentSummary;
}

impl IntoWorkspaceAgentUpdate for CodexProviderMetadata {
    fn into_agent_summary(
        self,
        provider: AgentProvider,
        skills: Vec<SkillSummary>,
    ) -> WorkspaceAgentSummary {
        WorkspaceAgentSummary {
            provider,
            account: self.account,
            models: self.models,
            collaboration_modes: self.collaboration_modes,
            skills,
            supports_plan_mode: true,
            supports_native_plan_mode: true,
            capabilities: AgentCapabilitySummary {
                supports_review: true,
            },
        }
    }
}

impl IntoWorkspaceAgentUpdate for ClaudeProviderMetadata {
    fn into_agent_summary(
        self,
        provider: AgentProvider,
        skills: Vec<SkillSummary>,
    ) -> WorkspaceAgentSummary {
        WorkspaceAgentSummary {
            provider,
            account: self.account,
            models: self.models,
            collaboration_modes: self.collaboration_modes,
            skills,
            supports_plan_mode: true,
            supports_native_plan_mode: true,
            capabilities: self.capabilities,
        }
    }
}

fn update_workspace_agent_summary<T: IntoWorkspaceAgentUpdate>(
    agents: &mut Vec<WorkspaceAgentSummary>,
    provider: AgentProvider,
    metadata: T,
    skills: Vec<SkillSummary>,
) {
    let updated = metadata.into_agent_summary(provider.clone(), skills);
    if let Some(agent) = agents.iter_mut().find(|agent| agent.provider == provider) {
        *agent = updated;
        return;
    }
    agents.push(updated);
}

impl RemotePairingState {
    fn to_response(&self) -> RemotePairingSession {
        RemotePairingSession {
            pairing_id: self.pairing_id.clone(),
            pairing_code: self.pairing_code.clone(),
            session_id: self.session_id.clone(),
            expires_at: self.expires_at,
        }
    }
}

fn build_remote_status_response(remote: &RemoteBridgeState) -> RemoteStatusResponse {
    let status = effective_remote_status(remote);
    let trusted_devices = remote
        .pairing
        .as_ref()
        .and_then(|pairing| {
            pairing
                .device_id
                .as_ref()
                .zip(pairing.trusted_at)
                .map(|(device_id, trusted_at)| falcondeck_core::TrustedDevice {
                    device_id: device_id.clone(),
                    session_id: pairing.session_id.clone().unwrap_or_default(),
                    label: Some("FalconDeck Remote".to_string()),
                    status: if matches!(&status, RemoteConnectionStatus::Revoked) {
                        falcondeck_core::TrustedDeviceStatus::Revoked
                    } else {
                        falcondeck_core::TrustedDeviceStatus::Active
                    },
                    created_at: trusted_at,
                    last_seen_at: matches!(&status, RemoteConnectionStatus::Connected)
                        .then(Utc::now),
                    revoked_at: None,
                })
        })
        .into_iter()
        .collect();
    let presence = remote.pairing.as_ref().and_then(|pairing| {
        pairing
            .session_id
            .as_ref()
            .map(|session_id| falcondeck_core::MachinePresence {
                session_id: session_id.clone(),
                daemon_connected: matches!(&status, RemoteConnectionStatus::Connected),
                last_seen_at: matches!(&status, RemoteConnectionStatus::Connected).then(Utc::now),
            })
    });

    RemoteStatusResponse {
        status,
        relay_url: remote.relay_url.clone(),
        pairing: response_pairing(remote).map(|pairing| pairing.to_response()),
        trusted_devices,
        presence,
        last_error: remote.last_error.clone(),
    }
}

fn status_pairing(remote: &RemoteBridgeState) -> Option<&RemotePairingState> {
    remote.pending_pairing.as_ref().or(remote.pairing.as_ref())
}

fn prune_finished_remote_tasks(remote: &mut RemoteBridgeState) {
    if remote.task.as_ref().is_some_and(|task| task.is_finished()) {
        remote.task = None;
        remote.command_tx = None;
    }
    if remote
        .pairing_watch_task
        .as_ref()
        .is_some_and(|task| task.is_finished())
    {
        remote.pairing_watch_task = None;
    }
}

fn clear_unserviceable_pending_pairing(remote: &mut RemoteBridgeState) {
    if remote.pending_pairing.is_none() {
        return;
    }

    if let Some(task) = remote.pairing_watch_task.take() {
        task.abort();
    }
    remote.pending_pairing = None;
    remote.last_error.get_or_insert_with(|| {
        "Additional remote pairing was cancelled because the desktop relay bridge stopped. Generate a fresh pairing code.".to_string()
    });
}

fn reconcile_remote_runtime_state(remote: &mut RemoteBridgeState) {
    prune_finished_remote_tasks(remote);

    if remote.task.is_none() && remote.pending_pairing.is_some() {
        clear_unserviceable_pending_pairing(remote);
    }

    if remote.pairing_watch_task.is_none() && remote.pending_pairing.is_some() {
        clear_unserviceable_pending_pairing(remote);
    }

    if remote.task.is_none() {
        remote.command_tx = None;
        if !matches!(
            remote.status,
            RemoteConnectionStatus::Inactive
                | RemoteConnectionStatus::Revoked
                | RemoteConnectionStatus::Error
        ) {
            remote.status = if remote
                .pairing
                .as_ref()
                .is_some_and(|pairing| pairing.device_id.is_some())
            {
                RemoteConnectionStatus::Offline
            } else {
                RemoteConnectionStatus::Inactive
            };
        }
    }
}

fn has_live_remote_task(remote: &RemoteBridgeState) -> bool {
    remote.task.is_some()
}

fn effective_remote_status(remote: &RemoteBridgeState) -> RemoteConnectionStatus {
    if has_live_remote_task(remote)
        || matches!(
            remote.status,
            RemoteConnectionStatus::Inactive
                | RemoteConnectionStatus::Revoked
                | RemoteConnectionStatus::Error
        )
    {
        return remote.status.clone();
    }

    if remote
        .pairing
        .as_ref()
        .is_some_and(|pairing| pairing.device_id.is_some())
    {
        RemoteConnectionStatus::Offline
    } else {
        RemoteConnectionStatus::Inactive
    }
}

fn response_pairing(remote: &RemoteBridgeState) -> Option<&RemotePairingState> {
    has_live_remote_task(remote)
        .then(|| status_pairing(remote))
        .flatten()
}

fn current_pairing_for_remote_attempt(
    remote: &RemoteBridgeState,
    relay_url: &str,
    daemon_token: &str,
) -> Option<RemotePairingState> {
    if remote.relay_url.as_deref() != Some(relay_url)
        || remote.daemon_token.as_deref() != Some(daemon_token)
    {
        return None;
    }

    remote.pairing.clone()
}

fn normalize_request_id(value: &Value) -> String {
    match value {
        Value::String(string) => string.clone(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let b0 = bytes[index];
        let b1 = if index + 1 < bytes.len() {
            bytes[index + 1]
        } else {
            0
        };
        let b2 = if index + 2 < bytes.len() {
            bytes[index + 2]
        } else {
            0
        };

        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if index + 1 < bytes.len() {
            output.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if index + 2 < bytes.len() {
            output.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            output.push('=');
        }
        index += 3;
    }
    output
}

fn decode_fixed_base64<const N: usize>(value: &str) -> Result<[u8; N], String> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }

    let mut decoded = Vec::with_capacity((bytes.len() / 4) * 3);
    for chunk in bytes.chunks(4) {
        let c0 = sextet(chunk[0]).ok_or_else(|| "invalid base64 character".to_string())?;
        let c1 = sextet(chunk[1]).ok_or_else(|| "invalid base64 character".to_string())?;
        let c2 = if chunk[2] == b'=' {
            None
        } else {
            Some(sextet(chunk[2]).ok_or_else(|| "invalid base64 character".to_string())?)
        };
        let c3 = if chunk[3] == b'=' {
            None
        } else {
            Some(sextet(chunk[3]).ok_or_else(|| "invalid base64 character".to_string())?)
        };

        decoded.push((c0 << 2) | (c1 >> 4));
        if let Some(c2) = c2 {
            decoded.push(((c1 & 0x0f) << 4) | (c2 >> 2));
            if let Some(c3) = c3 {
                decoded.push(((c2 & 0x03) << 6) | c3);
            }
        }
    }

    <[u8; N]>::try_from(decoded.as_slice()).map_err(|_| "invalid decoded length".to_string())
}

fn workspace_status_after_account_update(
    current_status: &WorkspaceStatus,
    account_status: &falcondeck_core::AccountStatus,
) -> WorkspaceStatus {
    match account_status {
        falcondeck_core::AccountStatus::NeedsAuth => WorkspaceStatus::NeedsAuth,
        _ if matches!(current_status, WorkspaceStatus::NeedsAuth) => WorkspaceStatus::Ready,
        _ => current_status.clone(),
    }
}

#[cfg(test)]
mod tests;
