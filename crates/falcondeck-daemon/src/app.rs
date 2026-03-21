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
    SendTurnRequest, ServiceLevel, SkillSummary, StartPairingRequest, StartPairingResponse,
    StartRemotePairingRequest, StartReviewRequest, StartThreadRequest, ThreadAgentParams,
    ThreadAttention, ThreadDetail, ThreadHandle, ThreadStatus, ThreadSummary, UnifiedEvent,
    UpdatePreferencesRequest, UpdateThreadRequest, WorkspaceAgentSummary, WorkspaceStatus,
    WorkspaceSummary,
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
mod conversation_helpers;
mod remote_bridge;
mod storage;
mod threads;

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
            let remote = self.inner.remote.lock().await;
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
            let remote = self.inner.remote.lock().await;
            let should_reuse_pending = remote.relay_url.as_deref() == Some(relay_url.as_str())
                && status_pairing(&remote).is_some_and(|pairing| pairing.expires_at > Utc::now())
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
        let pairing = client
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
            .map_err(|error| DaemonError::Rpc(format!("failed to contact relay: {error}")))?
            .error_for_status()
            .map_err(|error| DaemonError::Rpc(format!("relay pairing request failed: {error}")))?
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

        reqwest::Client::new()
            .delete(format!(
                "{}/v1/sessions/{}/devices/{}",
                relay_url.trim_end_matches('/'),
                session_id,
                device_id
            ))
            .bearer_auth(&daemon_token)
            .send()
            .await
            .map_err(|error| DaemonError::Rpc(format!("failed to revoke remote device: {error}")))?
            .error_for_status()
            .map_err(|error| {
                DaemonError::Rpc(format!("remote device revoke request failed: {error}"))
            })?;

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
        self.connect_workspace_internal(request, None).await
    }

    async fn connect_workspace_internal(
        &self,
        request: ConnectWorkspaceRequest,
        persisted_workspace: Option<&PersistedWorkspaceState>,
    ) -> Result<WorkspaceSummary, DaemonError> {
        let requested_path = PathBuf::from(request.path.trim());
        if request.path.trim().is_empty() {
            return Err(DaemonError::BadRequest(
                "workspace path is required".to_string(),
            ));
        }

        let path = requested_path
            .canonicalize()
            .map_err(|error| DaemonError::BadRequest(format!("invalid workspace path: {error}")))?;
        let path_string = path.to_string_lossy().to_string();
        let persisted_workspace = match persisted_workspace.cloned() {
            Some(workspace) => Some(workspace),
            None => self
                .inner
                .saved_workspaces
                .lock()
                .await
                .get(&path_string)
                .cloned(),
        };
        let persisted_workspace_ref = persisted_workspace.as_ref();

        let existing_workspace_id = {
            let mut workspaces = self.inner.workspaces.lock().await;
            if let Some(existing_id) = workspaces
                .values()
                .find(|workspace| workspace.summary.path == path_string)
                .map(|workspace| workspace.summary.id.clone())
            {
                let should_upgrade_placeholder = workspaces
                    .get(&existing_id)
                    .map(|workspace| !workspace.has_runtime())
                    .unwrap_or(false);
                if should_upgrade_placeholder {
                    Some(existing_id)
                } else if let Some(existing) = workspaces.get(&existing_id) {
                    let existing_summary = existing.summary.clone();
                    let preferred_thread_id = persisted_workspace_ref
                        .and_then(|workspace| workspace.current_thread_id.as_deref())
                        .and_then(|thread_id| {
                            existing
                                .threads
                                .contains_key(thread_id)
                                .then(|| thread_id.to_string())
                        })
                        .or(existing_summary.current_thread_id.clone());
                    if let Some(workspace) = workspaces.get_mut(&existing_id) {
                        workspace.summary.current_thread_id = preferred_thread_id;
                        if let Some(default_provider) = persisted_workspace_ref
                            .and_then(|workspace| workspace.default_provider.clone())
                        {
                            workspace.summary.default_provider = default_provider;
                        }
                        if let Some(updated_at) =
                            persisted_workspace_ref.and_then(|workspace| workspace.updated_at)
                        {
                            workspace.summary.updated_at = updated_at;
                        }
                        let summary = workspace.summary.clone();
                        let should_refresh_metadata = workspace.has_runtime();
                        drop(workspaces);
                        if should_refresh_metadata {
                            return self
                                .refresh_connected_workspace_metadata(&existing_id)
                                .await;
                        }
                        self.persist_local_state().await?;
                        return Ok(summary);
                    }
                    return Ok(existing_summary);
                } else {
                    None
                }
            } else {
                None
            }
        };
        let workspace_id = existing_workspace_id
            .unwrap_or_else(|| format!("workspace-{}", Uuid::new_v4().simple()));
        let CodexBootstrap {
            session: codex_session,
            account: codex_account,
            models: codex_models,
            collaboration_modes: codex_collaboration_modes,
            threads: codex_threads,
        } = CodexSession::connect(
            workspace_id.clone(),
            path_string.clone(),
            self.inner.codex_bin.clone(),
            self.clone(),
        )
        .await?;
        let ClaudeBootstrap {
            runtime: claude_runtime,
            account: claude_account,
            models: claude_models,
            collaboration_modes: claude_collaboration_modes,
            capabilities: claude_capabilities,
            threads: claude_threads,
        } = ClaudeRuntime::connect(path_string.clone(), self.inner.claude_bin.clone()).await?;
        let file_backed_skills = discover_file_backed_skills(&path_string);
        let codex_provider_skills = self
            .load_codex_provider_skills(&codex_session)
            .await
            .unwrap_or_default();
        let merged_skills = merge_skills(
            file_backed_skills
                .into_iter()
                .chain(codex_provider_skills)
                .collect(),
        );
        let codex_skills = skills_for_provider(&merged_skills, AgentProvider::Codex);
        let claude_skills = skills_for_provider(&merged_skills, AgentProvider::Claude);

        let now = Utc::now();
        let mut threads = codex_threads;
        threads.extend(claude_threads.into_iter().map(|mut thread| {
            thread.summary.workspace_id = workspace_id.clone();
            crate::codex::HydratedThread {
                summary: thread.summary,
                items: thread.items,
            }
        }));
        threads.sort_by(|left, right| right.summary.updated_at.cmp(&left.summary.updated_at));
        let persisted_thread_states = persisted_workspace_ref
            .map(|workspace| {
                workspace
                    .thread_states
                    .iter()
                    .map(|state| (state.thread_id.clone(), state.clone()))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        for state in persisted_thread_states.values() {
            if threads
                .iter()
                .any(|thread| thread.summary.id == state.thread_id)
            {
                continue;
            }
            let restored_status = match state.status.clone().unwrap_or(ThreadStatus::Idle) {
                ThreadStatus::Running => ThreadStatus::Error,
                other => other,
            };
            let restored_last_error = state.last_error.clone().or_else(|| {
                matches!(state.status, Some(ThreadStatus::Running))
                    .then(|| "FalconDeck was closed while this turn was running".to_string())
            });
            threads.push(crate::codex::HydratedThread {
                summary: ThreadSummary {
                    id: state.thread_id.clone(),
                    workspace_id: workspace_id.clone(),
                    title: state
                        .title
                        .clone()
                        .unwrap_or_else(|| "Restored thread".to_string()),
                    provider: state.provider.clone().unwrap_or(AgentProvider::Codex),
                    native_session_id: state.native_session_id.clone(),
                    status: restored_status,
                    updated_at: now,
                    last_message_preview: None,
                    latest_turn_id: None,
                    latest_plan: None,
                    latest_diff: None,
                    last_tool: None,
                    last_error: restored_last_error,
                    agent: ThreadAgentParams::default(),
                    attention: ThreadAttention::default(),
                    is_archived: false,
                },
                items: Vec::new(),
            });
        }
        let current_thread_id = persisted_workspace_ref
            .and_then(|workspace| workspace.current_thread_id.as_deref())
            .and_then(|thread_id| {
                threads
                    .iter()
                    .find(|thread| thread.summary.id == thread_id)
                    .map(|thread| thread.summary.id.clone())
            })
            .or_else(|| threads.first().map(|thread| thread.summary.id.clone()));
        let agents = vec![
            WorkspaceAgentSummary {
                provider: AgentProvider::Codex,
                account: codex_account.clone(),
                models: codex_models.clone(),
                collaboration_modes: codex_collaboration_modes.clone(),
                skills: codex_skills.clone(),
                supports_plan_mode: true,
                supports_native_plan_mode: true,
                capabilities: AgentCapabilitySummary {
                    supports_review: true,
                },
            },
            WorkspaceAgentSummary {
                provider: AgentProvider::Claude,
                account: claude_account.clone(),
                models: claude_models.clone(),
                collaboration_modes: claude_collaboration_modes.clone(),
                skills: claude_skills.clone(),
                supports_plan_mode: true,
                supports_native_plan_mode: true,
                capabilities: claude_capabilities,
            },
        ];
        let default_provider = persisted_workspace_ref
            .and_then(|workspace| workspace.default_provider.clone())
            .unwrap_or(AgentProvider::Codex);
        let summary = WorkspaceSummary {
            id: workspace_id.clone(),
            path: path_string.clone(),
            status: if agents.iter().all(|agent| {
                matches!(
                    agent.account.status,
                    falcondeck_core::AccountStatus::NeedsAuth
                )
            }) {
                WorkspaceStatus::NeedsAuth
            } else {
                WorkspaceStatus::Ready
            },
            agents,
            skills: merged_skills,
            default_provider: default_provider.clone(),
            models: codex_models,
            collaboration_modes: codex_collaboration_modes.clone(),
            supports_plan_mode: true,
            supports_native_plan_mode: true,
            account: codex_account,
            current_thread_id,
            connected_at: now,
            updated_at: persisted_workspace_ref
                .and_then(|workspace| workspace.updated_at)
                .unwrap_or(now),
            last_error: None,
        };

        self.inner.workspaces.lock().await.insert(
            workspace_id.clone(),
            ManagedWorkspace {
                summary: summary.clone(),
                codex_session: Some(codex_session),
                claude_runtime: Some(claude_runtime),
                threads: threads
                    .into_iter()
                    .map(|mut thread| {
                        if persisted_workspace_ref
                            .map(|pw| pw.archived_thread_ids.contains(&thread.summary.id))
                            .unwrap_or(false)
                        {
                            thread.summary.is_archived = true;
                        }
                        if let Some(state) = persisted_thread_states.get(&thread.summary.id) {
                            if let Some(provider) = state.provider.clone() {
                                thread.summary.provider = provider;
                            }
                            if state.native_session_id.is_some() {
                                thread.summary.native_session_id = state.native_session_id.clone();
                            }
                            thread.summary.attention.last_read_seq = state.last_read_seq;
                            thread.summary.attention.last_agent_activity_seq =
                                state.last_agent_activity_seq;
                        }
                        (thread.summary.id.clone(), {
                            let mut managed =
                                ManagedThread::with_items(thread.summary, thread.items);
                            if let Some(state) = persisted_thread_states.get(&managed.summary.id) {
                                managed.manual_title = state.manual_title;
                                managed.ai_title_generated = state.ai_title_generated
                                    || (!is_placeholder_thread_title(&managed.summary.title)
                                        && !is_provisional_thread_title(&managed.summary.title));
                            }
                            managed
                        })
                    })
                    .collect(),
            },
        );
        self.inner.saved_workspaces.lock().await.insert(
            path_string,
            persisted_workspace_ref
                .cloned()
                .unwrap_or(PersistedWorkspaceState {
                    path: summary.path.clone(),
                    current_thread_id: summary.current_thread_id.clone(),
                    updated_at: Some(summary.updated_at),
                    default_provider: Some(summary.default_provider.clone()),
                    last_error: None,
                    archived_thread_ids: Vec::new(),
                    thread_states: Vec::new(),
                }),
        );

        self.emit(
            Some(workspace_id),
            None,
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );

        self.persist_local_state().await?;

        Ok(summary)
    }

    pub async fn start_thread(
        &self,
        request: StartThreadRequest,
    ) -> Result<ThreadHandle, DaemonError> {
        let (provider, supports_native_plan_mode, default_model_id) = {
            let workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get(&request.workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let provider = request
                .provider
                .clone()
                .unwrap_or_else(|| workspace.summary.default_provider.clone());
            let agent = workspace
                .summary
                .agents
                .iter()
                .find(|agent| agent.provider == provider)
                .cloned();
            (
                provider,
                agent
                    .as_ref()
                    .map(|agent| agent.supports_native_plan_mode)
                    .unwrap_or(workspace.summary.supports_native_plan_mode),
                agent.and_then(|agent| {
                    agent
                        .models
                        .iter()
                        .find(|model| model.is_default)
                        .or_else(|| agent.models.first())
                        .map(|model| model.id.clone())
                }),
            )
        };
        let approval_policy = request
            .approval_policy
            .unwrap_or_else(|| "on-request".to_string());
        let model_id = request.model_id.clone().or(default_model_id);
        let (thread_id, title, native_session_id) = match provider {
            AgentProvider::Codex => {
                let session = self.session_for(&request.workspace_id).await?;
                let workspace_path = session.workspace_path().to_string();
                let result = session
                    .send_request(
                        "thread/start",
                        json!({
                            "cwd": workspace_path,
                            "model": model_id,
                            "collaborationMode": collaboration_mode_payload(
                                request.collaboration_mode_id.as_deref(),
                                model_id.as_deref(),
                                None,
                                supports_native_plan_mode,
                            ),
                            "approvalPolicy": approval_policy
                        }),
                    )
                    .await?;
                (
                    extract_thread_id(&result).ok_or_else(|| {
                        DaemonError::Rpc("thread/start did not return a thread id".to_string())
                    })?,
                    extract_thread_title(&result).unwrap_or_else(|| "New thread".to_string()),
                    extract_thread_id(&result),
                )
            }
            AgentProvider::Claude => (
                format!("claude-thread-{}", Uuid::new_v4().simple()),
                "New Claude thread".to_string(),
                None,
            ),
        };
        let now = Utc::now();

        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = ThreadSummary {
            id: thread_id.clone(),
            workspace_id: request.workspace_id.clone(),
            title,
            provider: provider.clone(),
            native_session_id,
            status: ThreadStatus::Idle,
            updated_at: now,
            last_message_preview: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: None,
            last_tool: None,
            last_error: None,
            agent: ThreadAgentParams {
                model_id,
                reasoning_effort: None,
                collaboration_mode_id: request.collaboration_mode_id,
                approval_policy: Some(approval_policy),
                service_tier: None,
            },
            attention: ThreadAttention::default(),
            is_archived: false,
        };
        workspace.summary.current_thread_id = Some(thread_id.clone());
        workspace.summary.default_provider = provider;
        workspace.summary.updated_at = now;
        workspace
            .threads
            .insert(thread_id.clone(), ManagedThread::new(thread.clone()));
        let workspace_summary = workspace.summary.clone();
        drop(workspaces);

        let thread = self
            .thread_summary(&request.workspace_id, &thread.id)
            .await?;
        self.emit(
            Some(request.workspace_id),
            Some(thread.id.clone()),
            UnifiedEvent::ThreadStarted {
                thread: thread.clone(),
            },
        );

        Ok(ThreadHandle {
            workspace: workspace_summary,
            thread,
        })
    }

    pub async fn archive_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        thread.summary.is_archived = true;
        drop(workspaces);
        let summary = self.thread_summary(workspace_id, thread_id).await?;
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );
        let _ = self.persist_local_state().await;
        Ok(summary)
    }

    pub async fn unarchive_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        thread.summary.is_archived = false;
        drop(workspaces);
        let summary = self.thread_summary(workspace_id, thread_id).await?;
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );
        let _ = self.persist_local_state().await;
        Ok(summary)
    }

    pub async fn send_turn(
        &self,
        request: SendTurnRequest,
    ) -> Result<CommandResponse, DaemonError> {
        let inputs = if request.inputs.is_empty() {
            return Err(DaemonError::BadRequest(
                "at least one input item is required".to_string(),
            ));
        } else {
            request.inputs.clone()
        };
        let approval_policy = request
            .approval_policy
            .unwrap_or_else(|| "on-request".to_string());

        let user_message = build_user_message_item(&inputs);
        let (thread, requires_resume, use_plan_mode_shim, provider, selected_skills) = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get_mut(&request.workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let now = Utc::now();
            let provider = request
                .provider
                .clone()
                .or_else(|| {
                    workspace
                        .threads
                        .get(&request.thread_id)
                        .map(|thread| thread.summary.provider.clone())
                })
                .unwrap_or_else(|| workspace.summary.default_provider.clone());
            let managed = workspace
                .threads
                .entry(request.thread_id.clone())
                .or_insert_with(|| {
                    ManagedThread::new(ThreadSummary {
                        id: request.thread_id.clone(),
                        workspace_id: request.workspace_id.clone(),
                        title: "Untitled thread".to_string(),
                        provider: provider.clone(),
                        native_session_id: None,
                        status: ThreadStatus::Idle,
                        updated_at: now,
                        last_message_preview: None,
                        latest_turn_id: None,
                        latest_plan: None,
                        latest_diff: None,
                        last_tool: None,
                        last_error: None,
                        agent: ThreadAgentParams::default(),
                        attention: ThreadAttention::default(),
                        is_archived: false,
                    })
                });
            managed.summary.provider = provider.clone();
            managed.summary.status = ThreadStatus::Running;
            managed.summary.agent.model_id = request.model_id.clone().or(managed
                .summary
                .agent
                .model_id
                .clone());
            managed.summary.agent.reasoning_effort = request.reasoning_effort.clone().or(managed
                .summary
                .agent
                .reasoning_effort
                .clone());
            managed.summary.agent.collaboration_mode_id = request
                .collaboration_mode_id
                .clone()
                .or(managed.summary.agent.collaboration_mode_id.clone());
            managed.summary.agent.approval_policy = Some(approval_policy.clone());
            managed.summary.agent.service_tier = request.service_tier.clone().or(managed
                .summary
                .agent
                .service_tier
                .clone());
            let use_plan_mode_shim = should_use_plan_mode_shim(
                &workspace.summary,
                &provider,
                request.collaboration_mode_id.as_deref(),
            );
            let selected_skills = resolve_selected_skills(
                &workspace.summary.skills,
                &request.selected_skills,
                &provider,
            );
            if !managed.manual_title
                && !managed.ai_title_generated
                && is_placeholder_thread_title(&managed.summary.title)
            {
                if let Some(title) = provisional_thread_title_from_inputs(&inputs) {
                    managed.summary.title = title;
                }
            }
            managed.summary.updated_at = now;
            workspace.summary.current_thread_id = Some(managed.summary.id.clone());
            workspace.summary.default_provider = provider.clone();
            workspace.summary.updated_at = now;
            (
                managed.summary.clone(),
                managed.requires_resume,
                use_plan_mode_shim,
                provider,
                selected_skills,
            )
        };
        self.push_conversation_item(
            &request.workspace_id,
            &request.thread_id,
            user_message.clone(),
            false,
        )
        .await?;
        self.emit(
            Some(request.workspace_id.clone()),
            Some(request.thread_id.clone()),
            UnifiedEvent::ThreadUpdated {
                thread: thread.clone(),
            },
        );

        let start_result: Result<(), DaemonError> = match provider {
            AgentProvider::Codex => {
                let session = self.session_for(&request.workspace_id).await?;
                let workspace_path = session.workspace_path().to_string();
                if requires_resume {
                    session.resume_thread(&request.thread_id).await?;
                    let mut workspaces = self.inner.workspaces.lock().await;
                    if let Some(workspace) = workspaces.get_mut(&request.workspace_id) {
                        if let Some(thread) = workspace.threads.get_mut(&request.thread_id) {
                            thread.requires_resume = false;
                        }
                    }
                }

                session
                    .send_request(
                        "turn/start",
                        json!({
                            "threadId": request.thread_id,
                            "input": codex_inputs_with_plan_mode_shim(&inputs, &selected_skills, use_plan_mode_shim),
                            "cwd": workspace_path,
                            "model": request.model_id,
                            "effort": request.reasoning_effort,
                            "collaborationMode": collaboration_mode_payload(
                                request.collaboration_mode_id.as_deref(),
                                request.model_id.as_deref(),
                                request.reasoning_effort.as_deref(),
                                !use_plan_mode_shim,
                            ),
                            "approvalPolicy": approval_policy,
                            "serviceTier": request.service_tier
                        }),
                    )
                    .await?;
                Ok(())
            }
            AgentProvider::Claude => {
                let runtime = self.claude_runtime_for(&request.workspace_id).await?;
                let session_id = thread.native_session_id.clone();
                let spawn = runtime
                    .spawn_turn(
                        &request.thread_id,
                        session_id.as_deref(),
                        &claude_prompt_from_inputs(&inputs, &selected_skills),
                        thread.agent.model_id.as_deref(),
                        thread.agent.reasoning_effort.as_deref(),
                        is_claude_plan_mode(thread.agent.collaboration_mode_id.as_deref()),
                    )
                    .await?;
                self.with_thread_mut(&request.workspace_id, &request.thread_id, |thread| {
                    thread.native_session_id = Some(spawn.session_id.clone());
                })
                .await?;
                let app = self.clone();
                let workspace_id = request.workspace_id.clone();
                let thread_id = request.thread_id.clone();
                tokio::spawn(async move {
                    app.monitor_claude_turn(
                        workspace_id,
                        thread_id,
                        spawn.session_id,
                        spawn.stdout,
                        spawn.stderr,
                    )
                    .await;
                });
                Ok(())
            }
        };

        if let Err(error) = start_result {
            let error_message = error.to_string();
            let _ = self
                .with_thread_mut(&request.workspace_id, &request.thread_id, |thread| {
                    thread.status = ThreadStatus::Error;
                    thread.last_error = Some(error_message.clone());
                    thread.updated_at = Utc::now();
                })
                .await;
            if let Ok(thread) = self
                .thread_summary(&request.workspace_id, &request.thread_id)
                .await
            {
                self.emit(
                    Some(request.workspace_id.clone()),
                    Some(request.thread_id.clone()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
            return Err(error);
        }

        Ok(CommandResponse {
            ok: true,
            message: Some("turn started".to_string()),
        })
    }

    pub async fn update_thread(
        &self,
        request: UpdateThreadRequest,
    ) -> Result<ThreadHandle, DaemonError> {
        let workspace_summary = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get_mut(&request.workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let thread = workspace
                .threads
                .get_mut(&request.thread_id)
                .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
            let now = Utc::now();

            if let Some(provider) = request.provider.clone() {
                if provider != thread.summary.provider {
                    return Err(DaemonError::BadRequest(
                        "threads are permanently bound to their original provider".to_string(),
                    ));
                }
            }

            if let Some(title) = request.title.as_deref().map(str::trim) {
                if title.is_empty() {
                    return Err(DaemonError::BadRequest(
                        "thread title cannot be empty".to_string(),
                    ));
                }
                thread.summary.title = title.to_string();
                thread.manual_title = true;
                thread.ai_title_generated = true;
                thread.ai_title_in_flight = false;
            }

            thread.summary.agent.model_id = request.model_id.clone();
            thread.summary.agent.reasoning_effort = request.reasoning_effort.clone();
            thread.summary.agent.collaboration_mode_id = request.collaboration_mode_id.clone();
            thread.summary.updated_at = now;
            workspace.summary.current_thread_id = Some(request.thread_id.clone());
            workspace.summary.updated_at = now;

            workspace.summary.clone()
        };
        let thread = self
            .thread_summary(&request.workspace_id, &request.thread_id)
            .await?;

        self.emit(
            Some(request.workspace_id.clone()),
            Some(request.thread_id.clone()),
            UnifiedEvent::ThreadUpdated {
                thread: thread.clone(),
            },
        );
        let _ = self.persist_local_state().await;

        Ok(ThreadHandle {
            workspace: workspace_summary,
            thread,
        })
    }

    pub async fn start_review(
        &self,
        request: StartReviewRequest,
    ) -> Result<CommandResponse, DaemonError> {
        let provider = self
            .thread_provider(&request.workspace_id, &request.thread_id)
            .await?;
        if provider != AgentProvider::Codex {
            return Err(DaemonError::BadRequest(
                "code review is only available for Codex threads in this milestone".to_string(),
            ));
        }
        let session = self.session_for(&request.workspace_id).await?;
        session
            .send_request(
                "review/start",
                json!({
                    "threadId": request.thread_id,
                    "target": request.target
                }),
            )
            .await?;

        Ok(CommandResponse {
            ok: true,
            message: Some("review started".to_string()),
        })
    }

    pub async fn interrupt_turn(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<CommandResponse, DaemonError> {
        let provider = self.thread_provider(&workspace_id, &thread_id).await?;
        if provider == AgentProvider::Claude {
            let runtime = self.claude_runtime_for(&workspace_id).await?;
            runtime.interrupt_turn(&thread_id).await?;
            return Ok(CommandResponse {
                ok: true,
                message: Some("interrupt requested".to_string()),
            });
        }

        let session = self.session_for(&workspace_id).await?;
        let turn_id = {
            let workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get(&workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            workspace
                .threads
                .get(&thread_id)
                .and_then(|thread| thread.summary.latest_turn_id.clone())
                .ok_or_else(|| DaemonError::BadRequest("no active turn to interrupt".to_string()))?
        };

        session
            .send_request(
                "turn/interrupt",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                }),
            )
            .await?;

        Ok(CommandResponse {
            ok: true,
            message: Some("interrupt requested".to_string()),
        })
    }

    pub async fn respond_to_interactive_request(
        &self,
        workspace_id: String,
        request_id: String,
        response: InteractiveResponsePayload,
    ) -> Result<CommandResponse, DaemonError> {
        let pending = {
            let requests = self.inner.interactive_requests.lock().await;
            requests
                .get(&(workspace_id.clone(), request_id.clone()))
                .cloned()
                .ok_or_else(|| DaemonError::NotFound("interactive request not found".to_string()))?
        };
        if let Some(thread_id) = pending.request.thread_id.as_deref() {
            let provider = self.thread_provider(&workspace_id, thread_id).await?;
            if provider != AgentProvider::Codex {
                return Err(DaemonError::BadRequest(
                    "Claude interactive requests are not yet routable through FalconDeck"
                        .to_string(),
                ));
            }
        }
        let session = self.session_for(&workspace_id).await?;

        let result = match (&pending.request.kind, response) {
            (
                InteractiveRequestKind::Approval,
                InteractiveResponsePayload::Approval { decision },
            ) => {
                let decision = match decision {
                    ApprovalDecision::Allow => "allow",
                    ApprovalDecision::Deny => "deny",
                    ApprovalDecision::AlwaysAllow => "always_allow",
                };
                json!({
                    "decision": decision,
                    "acceptSettings": {"forSession": true}
                })
            }
            (
                InteractiveRequestKind::Question,
                InteractiveResponsePayload::Question { answers },
            ) => json!({
                "answers": answers
                    .into_iter()
                    .map(|(question_id, question_answers)| {
                        (question_id, json!({ "answers": question_answers }))
                    })
                    .collect::<serde_json::Map<String, Value>>()
            }),
            (InteractiveRequestKind::Approval, _) => {
                return Err(DaemonError::BadRequest(
                    "interactive approval requires an approval response".to_string(),
                ));
            }
            (InteractiveRequestKind::Question, _) => {
                return Err(DaemonError::BadRequest(
                    "interactive question requires question answers".to_string(),
                ));
            }
        };

        session.respond_to_request(pending.raw_id, result).await?;

        self.inner
            .interactive_requests
            .lock()
            .await
            .remove(&(workspace_id.clone(), request_id.clone()));

        if let Some(thread_id) = pending.request.thread_id {
            self.with_thread_mut(&workspace_id, &thread_id, |thread| {
                thread.status = ThreadStatus::Running;
            })
            .await?;
            self.resolve_interactive_request_item(&workspace_id, &thread_id, &request_id)
                .await?;
        }

        self.emit(
            Some(workspace_id),
            None,
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );

        Ok(CommandResponse {
            ok: true,
            message: Some("response sent".to_string()),
        })
    }

    pub async fn collaboration_modes(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<CollaborationModeSummary>, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        Ok(workspace
            .summary
            .agents
            .iter()
            .find(|agent| agent.provider == workspace.summary.default_provider)
            .map(|agent| agent.collaboration_modes.clone())
            .unwrap_or_else(|| workspace.summary.collaboration_modes.clone()))
    }

    async fn load_codex_provider_skills(
        &self,
        session: &Arc<CodexSession>,
    ) -> Result<Vec<SkillSummary>, DaemonError> {
        let value = session
            .send_request("skills/list", json!({ "limit": 200 }))
            .await
            .unwrap_or(Value::Null);
        Ok(parse_codex_provider_skills(&value))
    }

    async fn refresh_connected_workspace_metadata(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceSummary, DaemonError> {
        let (workspace_path, codex_session, claude_runtime) = {
            let workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            (
                workspace.summary.path.clone(),
                workspace.codex_session.clone(),
                workspace.claude_runtime.clone(),
            )
        };

        let codex_metadata = match codex_session.as_ref() {
            Some(session) => Some(session.provider_metadata().await?),
            None => None,
        };
        let claude_metadata = match claude_runtime.as_ref() {
            Some(runtime) => Some(runtime.provider_metadata().await),
            None => None,
        };
        let file_backed_skills = discover_file_backed_skills(&workspace_path);
        let codex_provider_skills = match codex_session.as_ref() {
            Some(session) => self
                .load_codex_provider_skills(session)
                .await
                .unwrap_or_default(),
            None => Vec::new(),
        };
        let merged_skills = merge_skills(
            file_backed_skills
                .into_iter()
                .chain(codex_provider_skills)
                .collect(),
        );
        let codex_skills = skills_for_provider(&merged_skills, AgentProvider::Codex);
        let claude_skills = skills_for_provider(&merged_skills, AgentProvider::Claude);

        let summary = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get_mut(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            workspace.summary.skills = merged_skills;

            if let Some(metadata) = codex_metadata {
                update_workspace_agent_summary(
                    &mut workspace.summary.agents,
                    AgentProvider::Codex,
                    metadata,
                    codex_skills,
                );
            }
            if let Some(metadata) = claude_metadata {
                update_workspace_agent_summary(
                    &mut workspace.summary.agents,
                    AgentProvider::Claude,
                    metadata,
                    claude_skills,
                );
            }

            workspace.summary.status = if workspace.summary.agents.iter().all(|agent| {
                matches!(
                    agent.account.status,
                    falcondeck_core::AccountStatus::NeedsAuth
                )
            }) {
                WorkspaceStatus::NeedsAuth
            } else {
                WorkspaceStatus::Ready
            };

            workspace.summary.clone()
        };

        self.persist_local_state().await?;
        Ok(summary)
    }

    pub async fn thread_detail(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadDetail, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let workspace_summary = workspace.summary.clone();
        let thread_summary = thread.summary.clone();
        let items = thread.items.clone();
        drop(workspaces);

        Ok(ThreadDetail {
            workspace: workspace_summary,
            thread: self.build_thread_summary_from_clone(thread_summary).await,
            items,
        })
    }

    pub async fn mark_thread_read(
        &self,
        workspace_id: &str,
        thread_id: &str,
        read_seq: u64,
    ) -> Result<ThreadSummary, DaemonError> {
        let mut changed = false;
        {
            let mut workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get_mut(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let thread = workspace
                .threads
                .get_mut(thread_id)
                .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
            if read_seq > thread.summary.attention.last_read_seq {
                thread.summary.attention.last_read_seq = read_seq;
                changed = true;
            }
        }

        let thread = self.thread_summary(workspace_id, thread_id).await?;
        if changed {
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ThreadUpdated {
                    thread: thread.clone(),
                },
            );
            self.persist_local_state().await?;
        }
        Ok(thread)
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
                    let should_clear_pairing = remote.pairing.as_ref().is_some_and(|pairing| {
                        pairing.device_id.is_none() && pairing.expires_at <= Utc::now()
                    });
                    let revoked = error_msg.contains("invalid session token")
                        || error_msg.contains("session not found")
                        || error_msg.contains("trusted device");
                    remote.status = if should_clear_pairing {
                        RemoteConnectionStatus::Inactive
                    } else if revoked {
                        RemoteConnectionStatus::Revoked
                    } else if !is_transient && backoff_seconds >= 8 {
                        RemoteConnectionStatus::Offline
                    } else {
                        RemoteConnectionStatus::Degraded
                    };
                    remote.last_error = Some(error_msg);
                    if should_clear_pairing || revoked {
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
                    if should_clear_pairing || revoked {
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
        // If we already have a trusted device with session + client key material,
        // skip polling the pairing endpoint entirely — the pairing may have expired
        // but the session is still valid.
        let (session_id, device_id, client_bundle) = if let (
            Some(session_id),
            Some(device_id),
            Some(client_bundle),
        ) = (
            pairing.session_id.clone(),
            pairing.device_id.clone(),
            pairing.client_bundle.clone(),
        ) {
            verify_pairing_public_key_bundle(&client_bundle).map_err(|error| {
                RemoteBridgeError::Persistent(format!(
                    "trusted client bundle is not signed; please pair the remote device again: {error}"
                ))
            })?;
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
                    .map_err(|error| format!("failed to poll relay pairing: {error}"))?
                    .error_for_status()
                    .map_err(|error| format!("relay pairing status failed: {error}"))?
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
                    break (session_id, device_id, client_bundle);
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
                current_pairing.client_bundle = Some(client_bundle.clone());
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
                Ok(response) => match response.error_for_status() {
                    Ok(response) => match response.json::<PairingStatusResponse>().await {
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
                    },
                    Err(error) => {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            format!("relay pairing status failed: {error}"),
                        )
                        .await;
                        sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                },
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

                    let command_to_publish =
                        {
                            let mut remote = self.inner.remote.lock().await;
                            if remote.relay_url.as_deref() != Some(relay_url.as_str())
                                || remote.daemon_token.as_deref() != Some(daemon_token.as_str())
                            {
                                None
                            } else if remote.pending_pairing.as_ref().is_none_or(
                                |current_pairing| current_pairing.pairing_id != pairing_id,
                            ) {
                                None
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
                                remote.last_error = None;
                                remote.pending_pairing = None;
                                remote.pairing_watch_task = None;
                                remote.command_tx.clone().map(|command_tx| {
                                    (
                                        command_tx,
                                        RemoteBridgeCommand::PublishBootstrap {
                                            pairing: pairing_snapshot,
                                            client_bundle,
                                        },
                                    )
                                })
                            }
                        };

                    if let Some((command_tx, command)) = command_to_publish {
                        let _ = command_tx.send(command);
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
        match method {
            "thread/started" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let title = extract_thread_title(&params)
                        .unwrap_or_else(|| "Untitled thread".to_string());
                    let updated_at =
                        notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.title = title.clone();
                            thread.status = ThreadStatus::Idle;
                            thread.updated_at = updated_at;
                            if let Some(model_id) =
                                extract_string(&params, &["model", "modelId", "model_id"])
                            {
                                thread.agent.model_id = Some(model_id);
                            }
                            if let Some(reasoning_effort) = extract_string(
                                &params,
                                &["effort", "reasoningEffort", "reasoning_effort"],
                            ) {
                                thread.agent.reasoning_effort = Some(reasoning_effort);
                            }
                            if let Some(approval_policy) =
                                extract_string(&params, &["approvalPolicy", "approval_policy"])
                            {
                                thread.agent.approval_policy = Some(approval_policy);
                            }
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadStarted { thread },
                    );
                }
            }
            "thread/name/updated" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let title = extract_thread_title(&params)
                        .unwrap_or_else(|| "Untitled thread".to_string());
                    let updated_at =
                        notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                    self.with_managed_thread_mut(workspace_id, &thread_id, |thread| {
                        thread.summary.title = title.clone();
                        thread.summary.updated_at = updated_at;
                        if !is_placeholder_thread_title(&title)
                            && !is_provisional_thread_title(&title)
                        {
                            thread.ai_title_generated = true;
                            thread.ai_title_in_flight = false;
                        }
                    })
                    .await?;
                    let thread = self.thread_summary(workspace_id, &thread_id).await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                }
            }
            "turn/started" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let turn_id = extract_string(&params, &["turnId", "turn_id"])
                        .unwrap_or_else(|| "turn".to_string());
                    let updated_at =
                        notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.status = ThreadStatus::Running;
                            thread.latest_turn_id = Some(turn_id.clone());
                            thread.last_error = None;
                            thread.updated_at = updated_at;
                            if let Some(model_id) =
                                extract_string(&params, &["model", "modelId", "model_id"])
                            {
                                thread.agent.model_id = Some(model_id);
                            }
                            if let Some(reasoning_effort) = extract_string(
                                &params,
                                &["effort", "reasoningEffort", "reasoning_effort"],
                            ) {
                                thread.agent.reasoning_effort = Some(reasoning_effort);
                            }
                            if let Some(approval_policy) =
                                extract_string(&params, &["approvalPolicy", "approval_policy"])
                            {
                                thread.agent.approval_policy = Some(approval_policy);
                            }
                            if let Some(service_tier) =
                                extract_string(&params, &["serviceTier", "service_tier"])
                            {
                                thread.agent.service_tier = Some(service_tier);
                            }
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::TurnStart { turn_id },
                    );
                }
            }
            "turn/completed" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let turn_id = extract_string(&params, &["turnId", "turn_id"])
                        .unwrap_or_else(|| "turn".to_string());
                    let status = extract_string(&params, &["status"])
                        .unwrap_or_else(|| "completed".to_string());
                    let error = extract_string(&params, &["error"]).or_else(|| {
                        extract_string(params.get("error").unwrap_or(&Value::Null), &["message"])
                    });
                    let updated_at =
                        notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.status = if error.is_some() {
                                ThreadStatus::Error
                            } else {
                                ThreadStatus::Idle
                            };
                            thread.last_error = error.clone();
                            thread.updated_at = updated_at;
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::TurnEnd {
                            turn_id,
                            status,
                            error,
                        },
                    );
                    self.maybe_schedule_ai_thread_title(workspace_id.to_string(), thread_id)
                        .await;
                }
            }
            "turn/step/started" | "turn/step/completed" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let step = extract_string(&params, &["step"]);
                    let status = plan_step_status(method, &params);
                    let turn_id = extract_string(&params, &["turnId", "turn_id"]);
                    let updated_at =
                        notification_timestamp(method, &params).unwrap_or_else(Utc::now);

                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.updated_at = updated_at;
                            if let Some(plan) = &mut thread.latest_plan {
                                if let Some(s) = step.clone() {
                                    if let Some(step_obj) =
                                        plan.steps.iter_mut().find(|st| st.step == s)
                                    {
                                        if let Some(st) = status.clone() {
                                            step_obj.status = st;
                                        }
                                    }
                                }
                            }
                        })
                        .await?;

                    if let (Some(turn_id), Some(plan)) = (turn_id, thread.latest_plan.clone()) {
                        self.push_conversation_item(
                            workspace_id,
                            &thread_id,
                            ConversationItem::Plan {
                                id: format!("plan-{turn_id}"),
                                plan,
                                created_at: updated_at,
                            },
                            true,
                        )
                        .await?;
                    }

                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                }
            }
            "turn/plan/updated" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let plan = parse_thread_plan(&params);
                    let updated_at =
                        notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.latest_plan = plan.clone();
                            thread.updated_at = updated_at;
                        })
                        .await?;
                    if let Some(plan) = plan {
                        self.push_conversation_item(
                            workspace_id,
                            &thread_id,
                            ConversationItem::Plan {
                                id: format!(
                                    "plan-{}",
                                    extract_string(&params, &["turnId", "turn_id"])
                                        .unwrap_or_else(|| thread_id.clone())
                                ),
                                plan,
                                created_at: updated_at,
                            },
                            true,
                        )
                        .await?;
                    }
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                }
            }
            "turn/diff/updated" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let diff = extract_string(&params, &["diff", "patch"]);
                    if let Some(diff) = diff {
                        let updated_at =
                            notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                        let thread = self
                            .upsert_thread(workspace_id, &thread_id, |thread| {
                                thread.latest_diff = Some(diff.clone());
                                thread.updated_at = updated_at;
                            })
                            .await?;
                        self.push_conversation_item(
                            workspace_id,
                            &thread_id,
                            ConversationItem::Diff {
                                id: format!(
                                    "diff-{}",
                                    extract_string(&params, &["turnId", "turn_id"])
                                        .unwrap_or_else(|| thread_id.clone())
                                ),
                                diff,
                                created_at: updated_at,
                            },
                            true,
                        )
                        .await?;
                        self.emit(
                            Some(workspace_id.to_string()),
                            Some(thread_id),
                            UnifiedEvent::ThreadUpdated { thread },
                        );
                    }
                }
            }
            "item/agentMessage/delta" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let item_id = extract_string(&params, &["itemId", "item_id"])
                        .unwrap_or_else(|| "message".to_string());
                    let delta = extract_string(&params, &["delta"]).unwrap_or_default();

                    let next = {
                        let mut workspaces = self.inner.workspaces.lock().await;
                        let workspace = workspaces.get_mut(workspace_id).ok_or_else(|| {
                            DaemonError::NotFound("workspace not found".to_string())
                        })?;
                        let thread = workspace
                            .threads
                            .get_mut(&thread_id)
                            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;

                        thread.summary.last_message_preview = Some(truncate_preview(
                            &format!(
                                "{}{}",
                                thread
                                    .summary
                                    .last_message_preview
                                    .clone()
                                    .unwrap_or_default(),
                                delta
                            ),
                            160,
                        ));
                        thread.summary.updated_at = Utc::now();
                        workspace.summary.current_thread_id = Some(thread_id.clone());
                        workspace.summary.updated_at = Utc::now();

                        let existing_index = thread.assistant_items.get(&item_id).copied();
                        let next = match existing_index.and_then(|i| thread.items.get(i)) {
                            Some(ConversationItem::AssistantMessage {
                                id,
                                text,
                                created_at,
                            }) => ConversationItem::AssistantMessage {
                                id: id.clone(),
                                text: format!("{text}{delta}"),
                                created_at: *created_at,
                            },
                            _ => ConversationItem::AssistantMessage {
                                id: item_id.clone(),
                                text: delta.clone(),
                                created_at: Utc::now(),
                            },
                        };

                        if let Some(index) = existing_index {
                            thread.items[index] = next.clone();
                        } else {
                            thread.items.push(next.clone());
                            thread
                                .assistant_items
                                .insert(item_id.clone(), thread.items.len() - 1);
                        }
                        next
                    };

                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::Text { item_id, delta },
                    );
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ConversationItemUpdated { item: next },
                    );
                }
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let item_id = extract_string(&params, &["itemId", "item_id"])
                        .unwrap_or_else(|| "reasoning".to_string());
                    let delta = extract_string(&params, &["delta"]).unwrap_or_default();

                    let next = {
                        let mut workspaces = self.inner.workspaces.lock().await;
                        let workspace = workspaces.get_mut(workspace_id).ok_or_else(|| {
                            DaemonError::NotFound("workspace not found".to_string())
                        })?;
                        let thread = workspace
                            .threads
                            .get_mut(&thread_id)
                            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;

                        thread.summary.updated_at = Utc::now();
                        workspace.summary.current_thread_id = Some(thread_id.clone());
                        workspace.summary.updated_at = Utc::now();

                        let existing_index = thread.reasoning_items.get(&item_id).copied();
                        let next = match existing_index.and_then(|i| thread.items.get(i)) {
                            Some(ConversationItem::Reasoning {
                                id,
                                summary,
                                content,
                                created_at,
                            }) => {
                                if method.ends_with("summaryTextDelta") {
                                    ConversationItem::Reasoning {
                                        id: id.clone(),
                                        summary: Some(format!(
                                            "{}{}",
                                            summary.as_deref().unwrap_or_default(),
                                            delta
                                        )),
                                        content: content.clone(),
                                        created_at: *created_at,
                                    }
                                } else {
                                    ConversationItem::Reasoning {
                                        id: id.clone(),
                                        summary: summary.clone(),
                                        content: format!("{content}{delta}"),
                                        created_at: *created_at,
                                    }
                                }
                            }
                            _ => ConversationItem::Reasoning {
                                id: item_id.clone(),
                                summary: if method.ends_with("summaryTextDelta") {
                                    Some(delta.clone())
                                } else {
                                    None
                                },
                                content: if method.ends_with("summaryTextDelta") {
                                    String::new()
                                } else {
                                    delta.clone()
                                },
                                created_at: Utc::now(),
                            },
                        };

                        if let Some(index) = existing_index {
                            thread.items[index] = next.clone();
                        } else {
                            thread.items.push(next.clone());
                            thread
                                .reasoning_items
                                .insert(item_id.clone(), thread.items.len() - 1);
                        }
                        next
                    };

                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ConversationItemUpdated { item: next },
                    );
                }
            }
            "item/started" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let item = params.get("item").unwrap_or(&params);
                    let item_id =
                        extract_string(item, &["id"]).unwrap_or_else(|| "item".to_string());
                    let kind = extract_string(item, &["kind", "type"])
                        .unwrap_or_else(|| "tool".to_string());
                    if !should_surface_tool_item(&kind) {
                        return Ok(());
                    }
                    let title = extract_string(item, &["title", "label", "command"])
                        .or_else(|| {
                            extract_string(
                                item.get("command").unwrap_or(&Value::Null),
                                &["command"],
                            )
                        })
                        .unwrap_or_else(|| kind.clone());
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.status = ThreadStatus::Running;
                            thread.last_tool = Some(title.clone());
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ToolCallStart {
                            item_id: item_id.clone(),
                            title: title.clone(),
                            kind: kind.clone(),
                        },
                    );
                    self.push_conversation_item(
                        workspace_id,
                        &thread_id,
                        {
                            let display =
                                tool_display_metadata(&title, &kind, "running", None, None);
                            ConversationItem::ToolCall {
                                id: item_id,
                                title,
                                tool_kind: kind,
                                status: "running".to_string(),
                                output: None,
                                exit_code: None,
                                display,
                                created_at: Utc::now(),
                                completed_at: None,
                            }
                        },
                        true,
                    )
                    .await?;
                }
            }
            "item/completed" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let item = params.get("item").unwrap_or(&params);
                    let item_id =
                        extract_string(item, &["id"]).unwrap_or_else(|| "item".to_string());
                    let kind = extract_string(item, &["kind", "type"])
                        .unwrap_or_else(|| "tool".to_string());
                    if !should_surface_tool_item(&kind) {
                        return Ok(());
                    }
                    let title = extract_string(item, &["title", "label", "command"])
                        .or_else(|| {
                            extract_string(
                                item.get("command").unwrap_or(&Value::Null),
                                &["command"],
                            )
                        })
                        .unwrap_or_else(|| kind.clone());
                    let status = extract_string(item, &["status"])
                        .unwrap_or_else(|| "completed".to_string());
                    let exit_code = item
                        .get("exitCode")
                        .or_else(|| item.get("exit_code"))
                        .and_then(Value::as_i64)
                        .map(|value| value as i32);
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.last_tool = Some(title.clone());
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ToolCallEnd {
                            item_id: item_id.clone(),
                            title: title.clone(),
                            kind: kind.clone(),
                            status: status.clone(),
                            exit_code,
                        },
                    );
                    let existing_output = item
                        .get("output")
                        .or_else(|| item.get("result"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    self.push_conversation_item(
                        workspace_id,
                        &thread_id,
                        {
                            let display = tool_display_metadata(
                                &title,
                                &kind,
                                &status,
                                exit_code,
                                item.get("output")
                                    .or_else(|| item.get("result"))
                                    .and_then(Value::as_str),
                            );
                            ConversationItem::ToolCall {
                                id: item_id.clone(),
                                title: title.clone(),
                                tool_kind: kind.clone(),
                                status: status.clone(),
                                output: existing_output,
                                exit_code,
                                display,
                                created_at: Utc::now(),
                                completed_at: Some(Utc::now()),
                            }
                        },
                        true,
                    )
                    .await?;
                    if kind.eq_ignore_ascii_case("fileChange")
                        || kind.eq_ignore_ascii_case("file_change")
                    {
                        self.emit(
                            Some(workspace_id.to_string()),
                            Some(thread_id),
                            UnifiedEvent::File {
                                item_id: Some(item_id),
                                path: extract_string(item, &["path"]),
                                summary: title,
                            },
                        );
                    }
                }
            }
            "error" => {
                let thread_id = extract_thread_id(&params);
                let message =
                    extract_string(&params, &["message"]).unwrap_or_else(|| params.to_string());
                self.emit_service(
                    Some(workspace_id.to_string()),
                    thread_id,
                    ServiceLevel::Error,
                    message,
                    Some(method.to_string()),
                )?;
            }
            "account/updated" => {
                let mut workspaces = self.inner.workspaces.lock().await;
                if let Some(workspace) = workspaces.get_mut(workspace_id) {
                    workspace.summary.account = parse_account(&params);
                    if let Some(agent) = workspace
                        .summary
                        .agents
                        .iter_mut()
                        .find(|agent| agent.provider == AgentProvider::Codex)
                    {
                        agent.account = workspace.summary.account.clone();
                    }
                    workspace.summary.status = workspace_status_after_account_update(
                        &workspace.summary.status,
                        &workspace.summary.account.status,
                    );
                    workspace.summary.updated_at = Utc::now();
                }
            }
            "model/rerouted" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let rerouted_model = extract_string(
                        &params,
                        &[
                            "toModel",
                            "to_model",
                            "model",
                            "modelId",
                            "model_id",
                            "reroutedModel",
                            "rerouted_model",
                        ],
                    );
                    if let Some(model_id) = rerouted_model {
                        let thread = self
                            .upsert_thread(workspace_id, &thread_id, |thread| {
                                thread.agent.model_id = Some(model_id.clone());
                            })
                            .await?;
                        self.emit(
                            Some(workspace_id.to_string()),
                            Some(thread_id),
                            UnifiedEvent::ThreadUpdated { thread },
                        );
                    }
                }
            }
            _ => {
                debug!("ignoring unsupported codex notification: {method}");
            }
        }

        Ok(())
    }

    pub async fn ingest_server_request(
        &self,
        workspace_id: &str,
        raw_id: Value,
        method: &str,
        params: Value,
    ) -> Result<(), DaemonError> {
        if method.ends_with("requestApproval") || method == "item/tool/requestUserInput" {
            let request_id = normalize_request_id(&raw_id);
            let request = if method.ends_with("requestApproval") {
                InteractiveRequest {
                    request_id: request_id.clone(),
                    workspace_id: workspace_id.to_string(),
                    thread_id: extract_thread_id(&params),
                    method: method.to_string(),
                    kind: InteractiveRequestKind::Approval,
                    title: extract_string(&params, &["reason", "title"])
                        .unwrap_or_else(|| approval_title(method)),
                    detail: extract_string(&params, &["message", "description"]),
                    command: extract_string(&params, &["command"]),
                    path: extract_string(&params, &["path"]),
                    turn_id: extract_string(&params, &["turnId", "turn_id"]),
                    item_id: extract_string(&params, &["itemId", "item_id"]),
                    questions: Vec::new(),
                    created_at: Utc::now(),
                }
            } else {
                let questions = parse_interactive_questions(&params);
                InteractiveRequest {
                    request_id: request_id.clone(),
                    workspace_id: workspace_id.to_string(),
                    thread_id: extract_thread_id(&params),
                    method: method.to_string(),
                    kind: InteractiveRequestKind::Question,
                    title: extract_string(&params, &["title"])
                        .unwrap_or_else(|| "Answer question".to_string()),
                    detail: extract_string(&params, &["message", "description"]).or_else(|| {
                        Some(format!(
                            "{} question{} from the agent.",
                            questions.len(),
                            if questions.len() == 1 { "" } else { "s" }
                        ))
                    }),
                    command: None,
                    path: None,
                    turn_id: extract_string(&params, &["turnId", "turn_id"]),
                    item_id: extract_string(&params, &["itemId", "item_id"]),
                    questions,
                    created_at: Utc::now(),
                }
            };

            self.inner.interactive_requests.lock().await.insert(
                (workspace_id.to_string(), request_id.clone()),
                PendingServerRequest {
                    raw_id,
                    request: request.clone(),
                },
            );

            if let Some(thread_id) = request.thread_id.clone() {
                self.with_thread_mut(workspace_id, &thread_id, |thread| {
                    thread.status = ThreadStatus::WaitingForInput;
                })
                .await?;
            }

            self.emit(
                Some(workspace_id.to_string()),
                request.thread_id.clone(),
                UnifiedEvent::InteractiveRequest {
                    request: request.clone(),
                },
            );
            if let Some(thread_id) = request.thread_id.clone() {
                self.push_conversation_item(
                    workspace_id,
                    &thread_id,
                    ConversationItem::InteractiveRequest {
                        id: request_id,
                        request,
                        created_at: Utc::now(),
                        resolved: false,
                    },
                    false,
                )
                .await?;
            }
            return Ok(());
        }

        self.emit_service(
            Some(workspace_id.to_string()),
            extract_thread_id(&params),
            ServiceLevel::Warning,
            format!("FalconDeck has not implemented interactive handling for {method} yet."),
            Some(method.to_string()),
        )?;

        Ok(())
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
                    status: if matches!(remote.status, RemoteConnectionStatus::Revoked) {
                        falcondeck_core::TrustedDeviceStatus::Revoked
                    } else {
                        falcondeck_core::TrustedDeviceStatus::Active
                    },
                    created_at: trusted_at,
                    last_seen_at: matches!(remote.status, RemoteConnectionStatus::Connected)
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
                daemon_connected: matches!(remote.status, RemoteConnectionStatus::Connected),
                last_seen_at: matches!(remote.status, RemoteConnectionStatus::Connected)
                    .then(Utc::now),
            })
    });

    RemoteStatusResponse {
        status: remote.status.clone(),
        relay_url: remote.relay_url.clone(),
        pairing: status_pairing(remote).map(|pairing| pairing.to_response()),
        trusted_devices,
        presence,
        last_error: remote.last_error.clone(),
    }
}

fn status_pairing(remote: &RemoteBridgeState) -> Option<&RemotePairingState> {
    remote.pending_pairing.as_ref().or(remote.pairing.as_ref())
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
mod tests {
    use std::path::PathBuf;

    use chrono::{Duration, Utc};
    use falcondeck_core::{
        AgentProvider, CollaborationModeSummary, ConversationItem, ImageInput, ThreadAgentParams,
        ThreadAttention, ThreadStatus, ThreadSummary, TurnInputItem, UpdateThreadRequest,
        WorkspaceAgentSummary, WorkspaceStatus, WorkspaceSummary,
        crypto::{LocalBoxKeyPair, build_pairing_public_key_bundle, generate_data_key},
    };
    use serde_json::json;
    use tempfile::tempdir;
    use tokio::time::{Duration as TokioDuration, sleep};

    use super::{
        AppState, PersistedAppState, PersistedRemoteSecrets, PersistedRemoteState, codex_inputs,
        codex_inputs_with_plan_mode_shim, collaboration_mode_payload, encode_base64,
        notification_timestamp, plan_step_status, should_surface_tool_item,
        should_use_plan_mode_shim, workspace_status_after_account_update,
    };

    #[test]
    fn filters_internal_codex_item_kinds_from_tool_timeline() {
        assert!(!should_surface_tool_item("userMessage"));
        assert!(!should_surface_tool_item("agentMessage"));
        assert!(!should_surface_tool_item("reasoning"));
        assert!(should_surface_tool_item("commandExecution"));
    }

    #[test]
    fn builds_structured_collaboration_mode_payload() {
        let payload = collaboration_mode_payload(Some("plan"), Some("gpt-5.4"), Some("high"), true);
        assert_eq!(
            payload,
            json!({
                "mode": "plan",
                "settings": {
                    "model": "gpt-5.4",
                    "reasoning_effort": "high"
                }
            })
        );
    }

    #[test]
    fn skips_structured_collaboration_mode_payload_for_non_native_plan_mode() {
        let payload =
            collaboration_mode_payload(Some("plan"), Some("gpt-5.4"), Some("high"), false);
        assert_eq!(payload, serde_json::Value::Null);
    }

    #[test]
    fn injects_plan_mode_prompt_shim_before_user_inputs() {
        let payload = codex_inputs_with_plan_mode_shim(
            &[TurnInputItem::Text {
                id: None,
                text: "Inspect the repo".to_string(),
            }],
            &[],
            true,
        );
        assert_eq!(payload.len(), 2);
        assert_eq!(payload[0]["type"], "text");
        assert!(
            payload[0]["text"]
                .as_str()
                .unwrap_or_default()
                .contains("Enter plan mode for this turn")
        );
        assert_eq!(payload[1]["text"], "Inspect the repo");
    }

    #[test]
    fn only_uses_plan_mode_shim_for_non_native_plan_mode_workspaces() {
        let workspace = WorkspaceSummary {
            id: "workspace-1".to_string(),
            path: "/tmp/falcondeck".to_string(),
            status: WorkspaceStatus::Ready,
            agents: vec![WorkspaceAgentSummary {
                provider: AgentProvider::Codex,
                account: falcondeck_core::AccountSummary {
                    status: falcondeck_core::AccountStatus::Ready,
                    label: "ready".to_string(),
                },
                models: Vec::new(),
                collaboration_modes: vec![CollaborationModeSummary {
                    id: "plan".to_string(),
                    label: "Plan".to_string(),
                    mode: Some("plan".to_string()),
                    model_id: None,
                    reasoning_effort: Some("medium".to_string()),
                    is_native: false,
                }],
                skills: Vec::new(),
                supports_plan_mode: true,
                supports_native_plan_mode: false,
                capabilities: falcondeck_core::AgentCapabilitySummary {
                    supports_review: true,
                },
            }],
            skills: Vec::new(),
            default_provider: AgentProvider::Codex,
            models: Vec::new(),
            collaboration_modes: vec![CollaborationModeSummary {
                id: "plan".to_string(),
                label: "Plan".to_string(),
                mode: Some("plan".to_string()),
                model_id: None,
                reasoning_effort: Some("medium".to_string()),
                is_native: false,
            }],
            supports_plan_mode: true,
            supports_native_plan_mode: false,
            account: falcondeck_core::AccountSummary {
                status: falcondeck_core::AccountStatus::Ready,
                label: "ready".to_string(),
            },
            current_thread_id: None,
            connected_at: Utc::now(),
            updated_at: Utc::now(),
            last_error: None,
        };

        assert!(should_use_plan_mode_shim(
            &workspace,
            &AgentProvider::Codex,
            Some("plan")
        ));
        assert!(!should_use_plan_mode_shim(
            &workspace,
            &AgentProvider::Codex,
            None
        ));
    }

    #[test]
    fn encodes_local_images_for_codex() {
        let payload = codex_inputs(
            &[TurnInputItem::Image(ImageInput {
                id: "img-1".to_string(),
                name: Some("diagram.png".to_string()),
                mime_type: Some("image/png".to_string()),
                url: "ignored".to_string(),
                local_path: Some("/tmp/diagram.png".to_string()),
            })],
            &[],
        );
        assert_eq!(
            payload,
            vec![json!({
                "type": "localImage",
                "path": "/tmp/diagram.png"
            })]
        );
    }

    #[test]
    fn account_updates_do_not_clobber_runtime_status() {
        assert_eq!(
            workspace_status_after_account_update(
                &WorkspaceStatus::Busy,
                &falcondeck_core::AccountStatus::Ready,
            ),
            WorkspaceStatus::Busy
        );
        assert_eq!(
            workspace_status_after_account_update(
                &WorkspaceStatus::NeedsAuth,
                &falcondeck_core::AccountStatus::Ready,
            ),
            WorkspaceStatus::Ready
        );
        assert_eq!(
            workspace_status_after_account_update(
                &WorkspaceStatus::Error,
                &falcondeck_core::AccountStatus::NeedsAuth,
            ),
            WorkspaceStatus::NeedsAuth
        );
    }

    #[test]
    fn infers_plan_step_status_from_notification_method() {
        assert_eq!(
            plan_step_status("turn/step/started", &json!({ "step": "Inspect" })),
            Some("in_progress".to_string())
        );
        assert_eq!(
            plan_step_status("turn/step/completed", &json!({ "step": "Inspect" })),
            Some("completed".to_string())
        );
        assert_eq!(
            plan_step_status(
                "turn/step/started",
                &json!({ "step": "Inspect", "status": "running" }),
            ),
            Some("running".to_string())
        );
    }

    #[test]
    fn uses_notification_timestamps_when_available() {
        let timestamp = notification_timestamp(
            "turn/completed",
            &json!({
                "timestamp": "2026-03-18T10:15:30Z",
                "completedAt": "2026-03-18T10:15:29Z"
            }),
        )
        .expect("notification timestamp");
        assert_eq!(timestamp.to_rfc3339(), "2026-03-18T10:15:30+00:00");

        let fallback = notification_timestamp(
            "turn/completed",
            &json!({
                "completedAt": "2026-03-18T10:15:29Z"
            }),
        )
        .expect("fallback timestamp");
        assert_eq!(fallback.to_rfc3339(), "2026-03-18T10:15:29+00:00");
    }

    #[test]
    fn extracts_nested_claude_stream_text_and_result_payloads() {
        assert_eq!(
            super::extract_claude_text_delta(&json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {
                        "type": "text_delta",
                        "text": "hi"
                    }
                }
            })),
            Some("hi".to_string())
        );

        assert_eq!(
            super::extract_claude_text_delta(&json!({
                "type": "assistant",
                "message": {
                    "content": [
                        { "type": "text", "text": "hello" }
                    ]
                }
            })),
            Some("hello".to_string())
        );

        assert_eq!(
            super::extract_claude_text_delta(&json!({
                "type": "result",
                "subtype": "success",
                "result": "done"
            })),
            Some("done".to_string())
        );
    }

    #[test]
    fn extracts_nested_claude_tool_use_and_result_events() {
        assert_eq!(
            super::extract_claude_tool_event(&json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu_123",
                        "name": "Glob"
                    }
                }
            })),
            Some((
                "toolu_123".to_string(),
                "Glob".to_string(),
                "running".to_string(),
                None
            ))
        );

        assert_eq!(
            super::extract_claude_tool_event(&json!({
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_123",
                            "content": "match"
                        }
                    ]
                }
            })),
            Some((
                "toolu_123".to_string(),
                "Claude tool".to_string(),
                "completed".to_string(),
                Some("match".to_string())
            ))
        );
    }

    #[test]
    fn persisted_state_reads_legacy_workspace_paths() {
        let payload = json!({
            "workspaces": ["/tmp/project-a", "/tmp/project-b"],
            "remote": null
        });
        let persisted: PersistedAppState = serde_json::from_value(payload).unwrap();
        assert_eq!(
            persisted.workspaces,
            vec![
                super::PersistedWorkspaceState {
                    path: "/tmp/project-a".to_string(),
                    current_thread_id: None,
                    updated_at: None,
                    default_provider: Some(AgentProvider::Codex),
                    last_error: None,
                    archived_thread_ids: Vec::new(),
                    thread_states: Vec::new(),
                },
                super::PersistedWorkspaceState {
                    path: "/tmp/project-b".to_string(),
                    current_thread_id: None,
                    updated_at: None,
                    default_provider: Some(AgentProvider::Codex),
                    last_error: None,
                    archived_thread_ids: Vec::new(),
                    thread_states: Vec::new(),
                },
            ]
        );
    }

    #[test]
    fn persisted_state_reads_workspace_thread_selection() {
        let payload = json!({
            "workspaces": [
                {
                    "path": "/tmp/project-a",
                    "current_thread_id": "thread-123"
                }
            ],
            "remote": null
        });
        let persisted: PersistedAppState = serde_json::from_value(payload).unwrap();
        assert_eq!(
            persisted.workspaces,
            vec![super::PersistedWorkspaceState {
                path: "/tmp/project-a".to_string(),
                current_thread_id: Some("thread-123".to_string()),
                updated_at: None,
                default_provider: Some(AgentProvider::Codex),
                last_error: None,
                archived_thread_ids: Vec::new(),
                thread_states: Vec::new(),
            }]
        );
    }

    #[test]
    fn restored_threads_require_resume_but_new_threads_do_not() {
        let summary = ThreadSummary {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Thread".to_string(),
            provider: AgentProvider::Codex,
            native_session_id: None,
            status: ThreadStatus::Idle,
            updated_at: Utc::now(),
            last_message_preview: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: None,
            last_tool: None,
            last_error: None,
            agent: ThreadAgentParams::default(),
            attention: ThreadAttention::default(),
            is_archived: false,
        };

        let new_thread = super::ManagedThread::new(summary.clone());
        assert!(!new_thread.requires_resume);

        let restored_thread = super::ManagedThread::with_items(
            summary,
            vec![ConversationItem::AssistantMessage {
                id: "assistant-1".to_string(),
                text: "hello".to_string(),
                created_at: Utc::now(),
            }],
        );
        assert!(restored_thread.requires_resume);
    }

    #[test]
    fn provisional_thread_title_uses_first_four_words() {
        assert_eq!(
            super::provisional_thread_title_from_text(
                "Implement session renaming with fast fallback model now"
            ),
            Some("Implement session renaming with...".to_string())
        );
    }

    #[test]
    fn generated_thread_title_uses_last_meaningful_line() {
        assert_eq!(
            super::normalize_generated_thread_title(
                "OpenAI Codex v0.115.0\nuser\nName this thread\ncodex\nSession renaming flow\n"
            ),
            Some("Session renaming flow".to_string())
        );
    }

    #[test]
    fn generated_thread_title_skips_cli_noise_lines() {
        assert_eq!(
            super::normalize_generated_thread_title(
                "OpenAI Codex v0.115.0\ncodex\nImplement session rename\n\
tokens used\n5,767\n"
            ),
            Some("Implement session rename".to_string())
        );
    }

    #[tokio::test]
    async fn update_thread_title_marks_thread_as_manual() {
        let temp_dir = tempdir().unwrap();
        let workspace_path = temp_dir.path().join("project-a");
        std::fs::create_dir_all(&workspace_path).unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            PathBuf::from(&state_path),
        );

        let workspace_id = "workspace-1".to_string();
        let thread_id = "thread-1".to_string();
        app.inner.workspaces.lock().await.insert(
            workspace_id.clone(),
            super::ManagedWorkspace {
                summary: WorkspaceSummary {
                    id: workspace_id.clone(),
                    path: workspace_path.to_string_lossy().to_string(),
                    status: WorkspaceStatus::Ready,
                    agents: Vec::new(),
                    skills: Vec::new(),
                    default_provider: AgentProvider::Codex,
                    models: Vec::new(),
                    collaboration_modes: Vec::new(),
                    supports_plan_mode: true,
                    supports_native_plan_mode: true,
                    account: falcondeck_core::AccountSummary::default(),
                    current_thread_id: Some(thread_id.clone()),
                    connected_at: Utc::now(),
                    updated_at: Utc::now(),
                    last_error: None,
                },
                codex_session: None,
                claude_runtime: None,
                threads: [(
                    thread_id.clone(),
                    super::ManagedThread::new(ThreadSummary {
                        id: thread_id.clone(),
                        workspace_id: workspace_id.clone(),
                        title: "Untitled thread".to_string(),
                        provider: AgentProvider::Codex,
                        native_session_id: None,
                        status: ThreadStatus::Idle,
                        updated_at: Utc::now(),
                        last_message_preview: None,
                        latest_turn_id: None,
                        latest_plan: None,
                        latest_diff: None,
                        last_tool: None,
                        last_error: None,
                        agent: ThreadAgentParams::default(),
                        attention: ThreadAttention::default(),
                        is_archived: false,
                    }),
                )]
                .into_iter()
                .collect(),
            },
        );

        let handle = app
            .update_thread(UpdateThreadRequest {
                workspace_id: workspace_id.clone(),
                thread_id: thread_id.clone(),
                title: Some("Session renaming flow".to_string()),
                provider: None,
                model_id: None,
                reasoning_effort: None,
                collaboration_mode_id: None,
            })
            .await
            .unwrap();

        assert_eq!(handle.thread.title, "Session renaming flow");
        let workspaces = app.inner.workspaces.lock().await;
        let thread = workspaces
            .get(&workspace_id)
            .and_then(|workspace| workspace.threads.get(&thread_id))
            .unwrap();
        assert!(thread.manual_title);
        assert!(thread.ai_title_generated);
        assert_eq!(thread.summary.title, "Session renaming flow");
    }

    #[test]
    fn reconnect_attempt_uses_current_trusted_pairing_state() {
        let initial_pairing = super::RemotePairingState {
            pairing_id: "pairing-1".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: None,
            trusted_at: None,
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: None,
            local_key_pair: LocalBoxKeyPair::generate(),
            data_key: generate_data_key(),
        };
        let updated_pairing = super::RemotePairingState {
            device_id: Some("device-1".to_string()),
            trusted_at: Some(Utc::now()),
            client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
            ..initial_pairing
        };
        let remote = super::RemoteBridgeState {
            status: falcondeck_core::RemoteConnectionStatus::Connected,
            relay_url: Some("https://connect.falcondeck.com".to_string()),
            pairing: Some(updated_pairing.clone()),
            pending_pairing: None,
            daemon_token: Some("daemon-token".to_string()),
            last_error: None,
            task: None,
            pairing_watch_task: None,
            command_tx: None,
        };

        let pairing = super::current_pairing_for_remote_attempt(
            &remote,
            "https://connect.falcondeck.com",
            "daemon-token",
        )
        .expect("current pairing for reconnect");

        assert_eq!(pairing.session_id, updated_pairing.session_id);
        assert_eq!(pairing.device_id, updated_pairing.device_id);
        assert_eq!(
            pairing
                .client_bundle
                .as_ref()
                .map(|bundle| bundle.public_key.as_str()),
            updated_pairing
                .client_bundle
                .as_ref()
                .map(|bundle| bundle.public_key.as_str())
        );
    }

    #[test]
    fn reconnect_attempt_ignores_pending_additional_pairing_state() {
        let active_pairing = super::RemotePairingState {
            pairing_id: "pairing-active".to_string(),
            pairing_code: "ACTIVECODE12".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: Some("device-1".to_string()),
            trusted_at: Some(Utc::now()),
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
            local_key_pair: LocalBoxKeyPair::generate(),
            data_key: generate_data_key(),
        };
        let pending_pairing = super::RemotePairingState {
            pairing_id: "pairing-pending".to_string(),
            pairing_code: "PENDINGCODE1".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: None,
            trusted_at: None,
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: None,
            local_key_pair: LocalBoxKeyPair::generate(),
            data_key: generate_data_key(),
        };
        let remote = super::RemoteBridgeState {
            status: falcondeck_core::RemoteConnectionStatus::Connected,
            relay_url: Some("https://connect.falcondeck.com".to_string()),
            pairing: Some(active_pairing.clone()),
            pending_pairing: Some(pending_pairing),
            daemon_token: Some("daemon-token".to_string()),
            last_error: None,
            task: None,
            pairing_watch_task: None,
            command_tx: None,
        };

        let pairing = super::current_pairing_for_remote_attempt(
            &remote,
            "https://connect.falcondeck.com",
            "daemon-token",
        )
        .expect("current pairing for reconnect");

        assert_eq!(pairing.pairing_id, active_pairing.pairing_id);
        assert_eq!(pairing.device_id, active_pairing.device_id);
        assert!(pairing.client_bundle.is_some());
    }

    #[tokio::test]
    async fn restore_skips_expired_unclaimed_remote_pairing() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let persisted = PersistedAppState {
            workspaces: vec![],
            remote: Some(PersistedRemoteState {
                relay_url: "https://connect.falcondeck.com".to_string(),
                daemon_token: "daemon-token".to_string(),
                pairing_id: "pairing-1".to_string(),
                pairing_code: "ABCDEFGHJKLM".to_string(),
                session_id: None,
                device_id: None,
                trusted_at: None,
                expires_at: Utc::now() - Duration::seconds(5),
                client_bundle: None,
                client_public_key: None,
                secure_storage_key: None,
                local_secret_key_base64: Some(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
                ),
                data_key_base64: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string()),
            }),
        };

        tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
            .await
            .unwrap();

        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            PathBuf::from(&state_path),
        );
        app.restore_local_state().await.unwrap();

        let remote = app.inner.remote.lock().await;
        assert_eq!(
            remote.status,
            falcondeck_core::RemoteConnectionStatus::Inactive
        );
        assert!(remote.relay_url.is_none());
        assert!(remote.daemon_token.is_none());
        assert!(remote.pairing.is_none());
        drop(remote);

        let persisted_after: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        assert!(persisted_after.remote.is_none());
    }

    #[tokio::test]
    async fn restore_keeps_workspace_visible_when_reconnect_fails() {
        let temp_dir = tempdir().unwrap();
        let workspace_path = temp_dir.path().join("project-a");
        std::fs::create_dir_all(&workspace_path).unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let persisted = PersistedAppState {
            workspaces: vec![super::PersistedWorkspaceState {
                path: workspace_path.to_string_lossy().to_string(),
                current_thread_id: Some("thread-1".to_string()),
                updated_at: Some(Utc::now() - Duration::minutes(5)),
                default_provider: Some(AgentProvider::Claude),
                last_error: Some("Previous reconnect failed".to_string()),
                archived_thread_ids: vec!["thread-1".to_string()],
                thread_states: vec![super::PersistedThreadState {
                    thread_id: "thread-1".to_string(),
                    provider: Some(AgentProvider::Claude),
                    native_session_id: Some("native-session-1".to_string()),
                    title: Some("Recovered thread".to_string()),
                    manual_title: false,
                    ai_title_generated: false,
                    status: Some(ThreadStatus::Running),
                    last_error: None,
                    last_read_seq: 2,
                    last_agent_activity_seq: 7,
                }],
            }],
            remote: None,
        };

        tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
            .await
            .unwrap();

        let app = AppState::new_with_state_path(
            "test".to_string(),
            "missing-codex".to_string(),
            "missing-claude".to_string(),
            PathBuf::from(&state_path),
        );
        app.restore_local_state().await.unwrap();

        let initial_snapshot = app.snapshot().await;
        assert_eq!(initial_snapshot.workspaces.len(), 1);
        assert_eq!(initial_snapshot.threads.len(), 1);
        assert_eq!(
            initial_snapshot.workspaces[0].status,
            WorkspaceStatus::Connecting
        );
        assert_eq!(
            initial_snapshot.workspaces[0].last_error.as_deref(),
            Some("Previous reconnect failed")
        );

        let final_snapshot = {
            let mut snapshot = initial_snapshot;
            for _ in 0..20 {
                if matches!(snapshot.workspaces[0].status, WorkspaceStatus::Disconnected) {
                    break;
                }
                sleep(TokioDuration::from_millis(50)).await;
                snapshot = app.snapshot().await;
            }
            snapshot
        };

        let workspace = &final_snapshot.workspaces[0];
        assert_eq!(workspace.status, WorkspaceStatus::Disconnected);
        assert!(workspace.last_error.is_some());
        assert_eq!(workspace.default_provider, AgentProvider::Claude);
        assert_eq!(workspace.current_thread_id.as_deref(), Some("thread-1"));

        let thread = &final_snapshot.threads[0];
        assert_eq!(thread.title, "Recovered thread");
        assert_eq!(thread.provider, AgentProvider::Claude);
        assert_eq!(
            thread.native_session_id.as_deref(),
            Some("native-session-1")
        );
        assert_eq!(thread.status, ThreadStatus::Error);
        assert!(thread.is_archived);
        assert!(thread.last_error.is_some());

        let persisted_after: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        assert_eq!(persisted_after.workspaces.len(), 1);
        assert!(persisted_after.workspaces[0].last_error.is_some());
        assert_eq!(
            persisted_after.workspaces[0].thread_states[0].status,
            Some(ThreadStatus::Error)
        );
    }

    #[tokio::test]
    async fn persist_local_state_merges_saved_workspaces_with_live_workspaces() {
        let temp_dir = tempdir().unwrap();
        let workspace_a = temp_dir.path().join("project-a");
        let workspace_b = temp_dir.path().join("project-b");
        std::fs::create_dir_all(&workspace_a).unwrap();
        std::fs::create_dir_all(&workspace_b).unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            PathBuf::from(&state_path),
        );

        {
            let mut saved = app.inner.saved_workspaces.lock().await;
            saved.insert(
                workspace_a.to_string_lossy().to_string(),
                super::PersistedWorkspaceState {
                    path: workspace_a.to_string_lossy().to_string(),
                    current_thread_id: Some("thread-a".to_string()),
                    updated_at: Some(Utc::now() - Duration::minutes(2)),
                    default_provider: Some(AgentProvider::Codex),
                    last_error: None,
                    archived_thread_ids: Vec::new(),
                    thread_states: vec![super::PersistedThreadState {
                        thread_id: "thread-a".to_string(),
                        provider: Some(AgentProvider::Codex),
                        native_session_id: Some("native-a".to_string()),
                        title: Some("Thread A".to_string()),
                        manual_title: false,
                        ai_title_generated: false,
                        status: Some(ThreadStatus::Idle),
                        last_error: None,
                        last_read_seq: 0,
                        last_agent_activity_seq: 0,
                    }],
                },
            );
            saved.insert(
                workspace_b.to_string_lossy().to_string(),
                super::PersistedWorkspaceState {
                    path: workspace_b.to_string_lossy().to_string(),
                    current_thread_id: Some("thread-b".to_string()),
                    updated_at: Some(Utc::now() - Duration::minutes(1)),
                    default_provider: Some(AgentProvider::Claude),
                    last_error: Some("Still disconnected".to_string()),
                    archived_thread_ids: Vec::new(),
                    thread_states: vec![super::PersistedThreadState {
                        thread_id: "thread-b".to_string(),
                        provider: Some(AgentProvider::Claude),
                        native_session_id: Some("native-b".to_string()),
                        title: Some("Thread B".to_string()),
                        manual_title: false,
                        ai_title_generated: false,
                        status: Some(ThreadStatus::Error),
                        last_error: Some("Still disconnected".to_string()),
                        last_read_seq: 1,
                        last_agent_activity_seq: 3,
                    }],
                },
            );
        }

        let live_workspace_id = "workspace-a".to_string();
        let live_thread = ThreadSummary {
            id: "thread-a".to_string(),
            workspace_id: live_workspace_id.clone(),
            title: "Thread A renamed".to_string(),
            provider: AgentProvider::Codex,
            native_session_id: Some("native-a-2".to_string()),
            status: ThreadStatus::Idle,
            updated_at: Utc::now(),
            last_message_preview: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: None,
            last_tool: None,
            last_error: None,
            agent: ThreadAgentParams::default(),
            attention: ThreadAttention {
                last_read_seq: 4,
                last_agent_activity_seq: 8,
                ..ThreadAttention::default()
            },
            is_archived: false,
        };
        let live_workspace = WorkspaceSummary {
            id: live_workspace_id.clone(),
            path: workspace_a.to_string_lossy().to_string(),
            status: WorkspaceStatus::Ready,
            agents: Vec::new(),
            skills: Vec::new(),
            default_provider: AgentProvider::Codex,
            models: Vec::new(),
            collaboration_modes: Vec::new(),
            supports_plan_mode: true,
            supports_native_plan_mode: true,
            account: falcondeck_core::AccountSummary::default(),
            current_thread_id: Some("thread-a".to_string()),
            connected_at: Utc::now(),
            updated_at: Utc::now(),
            last_error: None,
        };
        app.inner.workspaces.lock().await.insert(
            live_workspace_id,
            super::ManagedWorkspace {
                summary: live_workspace,
                codex_session: None,
                claude_runtime: None,
                threads: [(
                    "thread-a".to_string(),
                    super::ManagedThread::new(live_thread),
                )]
                .into_iter()
                .collect(),
            },
        );

        app.persist_local_state().await.unwrap();

        let persisted_after: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        assert_eq!(persisted_after.workspaces.len(), 2);

        let restored_a = persisted_after
            .workspaces
            .iter()
            .find(|workspace| {
                workspace.path == super::normalize_workspace_path(&workspace_a.to_string_lossy())
            })
            .unwrap();
        assert_eq!(
            restored_a.thread_states[0].title.as_deref(),
            Some("Thread A renamed")
        );
        assert_eq!(
            restored_a.thread_states[0].native_session_id.as_deref(),
            Some("native-a-2")
        );
        assert_eq!(restored_a.thread_states[0].last_read_seq, 4);

        let restored_b = persisted_after
            .workspaces
            .iter()
            .find(|workspace| {
                workspace.path == super::normalize_workspace_path(&workspace_b.to_string_lossy())
            })
            .unwrap();
        assert_eq!(restored_b.current_thread_id.as_deref(), Some("thread-b"));
        assert_eq!(restored_b.last_error.as_deref(), Some("Still disconnected"));
        assert_eq!(
            restored_b.thread_states[0].status,
            Some(ThreadStatus::Error)
        );
    }

    #[tokio::test]
    async fn shutdown_marks_running_threads_as_error_and_persists_them() {
        let temp_dir = tempdir().unwrap();
        let workspace_path = temp_dir.path().join("project-a");
        std::fs::create_dir_all(&workspace_path).unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            PathBuf::from(&state_path),
        );

        let workspace_id = "workspace-1".to_string();
        let thread = ThreadSummary {
            id: "thread-1".to_string(),
            workspace_id: workspace_id.clone(),
            title: "Running thread".to_string(),
            provider: AgentProvider::Codex,
            native_session_id: Some("native-session-1".to_string()),
            status: ThreadStatus::Running,
            updated_at: Utc::now(),
            last_message_preview: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: None,
            last_tool: None,
            last_error: None,
            agent: ThreadAgentParams::default(),
            attention: ThreadAttention::default(),
            is_archived: false,
        };
        let workspace = WorkspaceSummary {
            id: workspace_id.clone(),
            path: workspace_path.to_string_lossy().to_string(),
            status: WorkspaceStatus::Busy,
            agents: Vec::new(),
            skills: Vec::new(),
            default_provider: AgentProvider::Codex,
            models: Vec::new(),
            collaboration_modes: Vec::new(),
            supports_plan_mode: true,
            supports_native_plan_mode: true,
            account: falcondeck_core::AccountSummary::default(),
            current_thread_id: Some("thread-1".to_string()),
            connected_at: Utc::now(),
            updated_at: Utc::now(),
            last_error: None,
        };
        app.inner.workspaces.lock().await.insert(
            workspace_id,
            super::ManagedWorkspace {
                summary: workspace,
                codex_session: None,
                claude_runtime: None,
                threads: [("thread-1".to_string(), super::ManagedThread::new(thread))]
                    .into_iter()
                    .collect(),
            },
        );

        app.shutdown().await.unwrap();

        let snapshot = app.snapshot().await;
        assert_eq!(snapshot.threads.len(), 1);
        assert_eq!(snapshot.threads[0].status, ThreadStatus::Error);
        assert_eq!(
            snapshot.threads[0].last_error.as_deref(),
            Some("FalconDeck was closed while this turn was running")
        );

        let persisted_after: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        assert_eq!(
            persisted_after.workspaces[0].thread_states[0].status,
            Some(ThreadStatus::Error)
        );
        assert_eq!(
            persisted_after.workspaces[0].thread_states[0]
                .last_error
                .as_deref(),
            Some("FalconDeck was closed while this turn was running")
        );
    }

    #[tokio::test]
    async fn restore_skips_legacy_loopback_remote_pairing() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let persisted = PersistedAppState {
            workspaces: vec![],
            remote: Some(PersistedRemoteState {
                relay_url: "http://127.0.0.1:54871".to_string(),
                daemon_token: "daemon-token".to_string(),
                pairing_id: "pairing-legacy".to_string(),
                pairing_code: "ABCDEFGHJKLM".to_string(),
                session_id: None,
                device_id: None,
                trusted_at: None,
                expires_at: Utc::now() + Duration::minutes(10),
                client_bundle: None,
                client_public_key: None,
                secure_storage_key: None,
                local_secret_key_base64: Some(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
                ),
                data_key_base64: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string()),
            }),
        };

        tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
            .await
            .unwrap();

        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            PathBuf::from(&state_path),
        );
        app.restore_local_state().await.unwrap();

        let remote = app.inner.remote.lock().await;
        assert_eq!(
            remote.status,
            falcondeck_core::RemoteConnectionStatus::Inactive
        );
        assert!(remote.relay_url.is_none());
        assert!(remote.daemon_token.is_none());
        assert!(remote.pairing.is_none());
        drop(remote);

        let persisted_after: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        assert!(persisted_after.remote.is_none());
    }

    #[tokio::test]
    async fn restore_skips_trusted_remote_with_legacy_unsigned_client_key() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let persisted = PersistedAppState {
            workspaces: vec![],
            remote: Some(PersistedRemoteState {
                relay_url: "https://connect.falcondeck.com".to_string(),
                daemon_token: "daemon-token".to_string(),
                pairing_id: "pairing-legacy-client".to_string(),
                pairing_code: "ABCDEFGHJKLM".to_string(),
                session_id: Some("session-1".to_string()),
                device_id: Some("device-1".to_string()),
                trusted_at: Some(Utc::now()),
                expires_at: Utc::now() + Duration::minutes(10),
                client_bundle: None,
                client_public_key: Some("legacy-public-key".to_string()),
                secure_storage_key: None,
                local_secret_key_base64: Some(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
                ),
                data_key_base64: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string()),
            }),
        };

        tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
            .await
            .unwrap();

        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            PathBuf::from(&state_path),
        );
        app.restore_local_state().await.unwrap();

        let remote = app.inner.remote.lock().await;
        assert_eq!(
            remote.status,
            falcondeck_core::RemoteConnectionStatus::Inactive
        );
        assert!(remote.relay_url.is_none());
        assert!(remote.daemon_token.is_none());
        assert!(remote.pairing.is_none());
        drop(remote);

        let persisted_after: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        assert!(persisted_after.remote.is_none());
    }

    #[tokio::test]
    async fn persisted_remote_state_moves_secrets_out_of_the_state_file() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            PathBuf::from(&state_path),
        );
        let pairing = super::RemotePairingState {
            pairing_id: "pairing-1".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: Some("device-1".to_string()),
            trusted_at: Some(Utc::now()),
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
            local_key_pair: LocalBoxKeyPair::generate(),
            data_key: generate_data_key(),
        };
        let expected_secret = pairing.local_key_pair.secret_key_base64();
        let expected_data_key = encode_base64(&pairing.data_key);

        {
            let mut remote = app.inner.remote.lock().await;
            remote.status = falcondeck_core::RemoteConnectionStatus::DeviceTrusted;
            remote.relay_url = Some("https://connect.falcondeck.com".to_string());
            remote.daemon_token = Some("daemon-token".to_string());
            remote.pairing = Some(pairing);
            remote.pending_pairing = None;
        }

        app.persist_local_state().await.unwrap();

        let persisted_after: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        let persisted_remote = persisted_after.remote.expect("persisted remote state");
        assert!(persisted_remote.secure_storage_key.is_some());
        assert!(persisted_remote.local_secret_key_base64.is_none());
        assert!(persisted_remote.data_key_base64.is_none());

        let stored = super::load_remote_secrets_from_secure_storage(
            persisted_remote
                .secure_storage_key
                .as_deref()
                .expect("secure storage key"),
        )
        .unwrap();
        assert_eq!(stored.local_secret_key_base64, expected_secret);
        assert_eq!(stored.data_key_base64, expected_data_key);
    }

    #[tokio::test]
    async fn restore_reads_remote_secrets_from_secure_storage() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let secure_storage_key = "https://connect.falcondeck.com|session-1".to_string();
        super::save_remote_secrets_to_secure_storage(
            &secure_storage_key,
            &PersistedRemoteSecrets {
                local_secret_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
                data_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            },
        )
        .unwrap();
        let persisted = PersistedAppState {
            workspaces: vec![],
            remote: Some(PersistedRemoteState {
                relay_url: "https://connect.falcondeck.com".to_string(),
                daemon_token: "daemon-token".to_string(),
                pairing_id: "pairing-1".to_string(),
                pairing_code: "ABCDEFGHJKLM".to_string(),
                session_id: Some("session-1".to_string()),
                device_id: Some("device-1".to_string()),
                trusted_at: Some(Utc::now()),
                expires_at: Utc::now() + Duration::minutes(10),
                client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
                client_public_key: None,
                secure_storage_key: Some(secure_storage_key),
                local_secret_key_base64: None,
                data_key_base64: None,
            }),
        };

        tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
            .await
            .unwrap();

        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            PathBuf::from(&state_path),
        );
        app.restore_local_state().await.unwrap();

        let remote = app.inner.remote.lock().await;
        assert_eq!(
            remote.status,
            falcondeck_core::RemoteConnectionStatus::DeviceTrusted
        );
        assert_eq!(
            remote.relay_url.as_deref(),
            Some("https://connect.falcondeck.com")
        );
        assert!(remote.pairing.is_some());
    }
}
