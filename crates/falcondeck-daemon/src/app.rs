#[cfg(test)]
use std::sync::OnceLock;
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use chrono::Utc;
use falcondeck_core::{
    AgentCapabilitySummary, AgentProvider, ApprovalDecision, CollaborationModeSummary,
    CommandResponse, ConnectWorkspaceRequest, ConversationAutoExpandPreferencesPatch,
    ConversationItem, DaemonInfo, DaemonSnapshot, EncryptedEnvelope, EventEnvelope,
    FalconDeckPreferences, HealthResponse, InteractiveQuestion, InteractiveQuestionOption,
    InteractiveRequest, InteractiveRequestKind, InteractiveResponsePayload, PairingPublicKeyBundle,
    PairingStatusResponse, RelayClientMessage, RelayServerMessage, RelayUpdateBody,
    RelayWebSocketTicketResponse, RemoteConnectionStatus, RemotePairingSession,
    RemoteStatusResponse, SelectedSkillReference, SendTurnRequest, ServiceLevel,
    SessionKeyMaterial, SkillSummary, StartPairingRequest, StartPairingResponse,
    StartRemotePairingRequest, StartReviewRequest, StartThreadRequest, ThreadAgentParams,
    ThreadAttention, ThreadAttentionLevel, ThreadDetail, ThreadHandle, ThreadStatus, ThreadSummary,
    ToolArtifactKind, ToolCallDisplay, ToolDetailsMode, TurnInputItem, UnifiedEvent,
    UpdatePreferencesRequest, UpdateThreadRequest, WorkspaceAgentSummary, WorkspaceStatus,
    WorkspaceSummary,
    crypto::{
        LocalBoxKeyPair, LocalIdentityKeyPair, build_pairing_public_key_bundle, decrypt_json,
        encrypt_json, generate_data_key, sign_session_key_material,
        verify_pairing_public_key_bundle,
    },
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    fs,
    io::AsyncBufReadExt,
    process::Command,
    sync::mpsc,
    sync::{Mutex, broadcast},
    task::JoinHandle,
    time::{Duration, sleep, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::debug;
use uuid::Uuid;

use crate::{
    agent_binary::resolve_agent_binary,
    claude::{ClaudeBootstrap, ClaudeRuntime},
    codex::{
        CodexBootstrap, CodexSession, extract_datetime_or_timestamp, extract_string,
        extract_thread_id, extract_thread_title, parse_account, parse_thread_plan,
    },
    error::DaemonError,
    skills::{
        canonical_skill_alias, discover_file_backed_skills, merge_skills,
        parse_codex_provider_skills, skills_for_provider,
    },
};

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

struct AiThreadTitleInput {
    workspace_path: String,
    prompt: String,
    prefer_claude: bool,
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

            let app = self.clone();
            tokio::spawn(async move {
                let result = timeout(
                    Duration::from_secs(8),
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
                        drop(workspaces);
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

    async fn connect_remote_session(
        &self,
        relay_url: String,
        daemon_token: String,
        session_id: String,
        pairing: RemotePairingState,
        client_bundle: PairingPublicKeyBundle,
        command_rx: &mut mpsc::UnboundedReceiver<RemoteBridgeCommand>,
    ) -> Result<(), RemoteBridgeError> {
        let ws_ticket = self
            .fetch_relay_ws_ticket(&relay_url, &session_id, &daemon_token)
            .await
            .map_err(|error| format!("failed to issue relay websocket ticket: {error}"))?;
        let ws_url = relay_ws_url(&relay_url, &session_id, &ws_ticket.ticket);
        let (socket, _) = connect_async(&ws_url)
            .await
            .map_err(|error| format!("failed to connect daemon relay websocket: {error}"))?;
        let (mut writer, mut reader) = socket.split();

        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        let mut events = self.subscribe();
        let fence_seq = self.inner.sequence.load(Ordering::Relaxed);
        let snapshot = self.snapshot().await;

        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "snapshot.current".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "interactive.respond".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "thread.start".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "thread.detail".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "turn.start".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "turn.interrupt".to_string(),
            },
        )
        .await?;
        self.publish_session_bootstrap(&mut writer, &pairing, &client_bundle)
            .await?;
        self.publish_remote_snapshot(&mut writer, &pairing.data_key, snapshot)
            .await?;

        while let Ok(event) = events.try_recv() {
            if event.seq >= fence_seq {
                send_relay_message(
                    &mut writer,
                    &RelayClientMessage::Update {
                        body: RelayUpdateBody::Encrypted {
                            envelope: encrypt_remote_daemon_event(&pairing.data_key, &event)?,
                        },
                    },
                )
                .await?;
            }
        }

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::Connected;
            remote.last_error = None;
        }

        self.persist_local_state()
            .await
            .map_err(|error| format!("failed to persist connected remote state: {error}"))?;

        let min_forward_seq: u64 = fence_seq;
        loop {
            tokio::select! {
                event = events.recv() => {
                    match event {
                        Ok(event) => {
                            if event.seq < min_forward_seq {
                                continue;
                            }
                            send_relay_message(
                                &mut writer,
                                &RelayClientMessage::Update {
                                    body: RelayUpdateBody::Encrypted {
                                        envelope: encrypt_remote_daemon_event(&pairing.data_key, &event)?,
                                    },
                                },
                            ).await?;
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!("remote daemon event stream lagged, skipped {skipped} events; sending fresh snapshot");
                            self.publish_remote_snapshot(&mut writer, &pairing.data_key, self.snapshot().await)
                                .await?;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            return Err(RemoteBridgeError::Persistent(
                                "remote event stream closed".to_string(),
                            ));
                        }
                    }
                }
                _ = heartbeat.tick() => {
                    send_relay_message(&mut writer, &RelayClientMessage::Ping).await?;
                }
                command = command_rx.recv() => {
                    if let Some(command) = command {
                        match command {
                            RemoteBridgeCommand::PublishBootstrap { pairing, client_bundle } => {
                                self.publish_session_bootstrap(&mut writer, &pairing, &client_bundle).await?;
                            }
                        }
                    }
                }
                message = reader.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let parsed = serde_json::from_str::<RelayServerMessage>(&text)
                                .map_err(|error| format!("invalid relay message: {error}"))?;
                            match parsed {
                                RelayServerMessage::RpcRequest { request_id, method, params } => {
                                    self.handle_remote_rpc(&mut writer, &pairing.data_key, request_id, method, params).await?;
                                }
                                RelayServerMessage::ActionRequested { action, payload } => {
                                    self.handle_queued_remote_action(&mut writer, &pairing.data_key, action.action_id, action.action_type, payload).await?;
                                }
                                RelayServerMessage::Pong | RelayServerMessage::Presence { .. } | RelayServerMessage::ActionUpdated { .. } | RelayServerMessage::Ready { .. } | RelayServerMessage::Sync { .. } | RelayServerMessage::Update { .. } | RelayServerMessage::Ephemeral { .. } | RelayServerMessage::RpcRegistered { .. } | RelayServerMessage::RpcUnregistered { .. } | RelayServerMessage::RpcResult { .. } | RelayServerMessage::Error { .. } => {}
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            return Err("relay websocket disconnected".to_string().into());
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => {
                            return Err(format!("relay websocket error: {error}").into());
                        }
                    }
                }
            }
        }
    }

    async fn fetch_remote_status(
        &self,
        relay_url: &str,
        session_id: &str,
        daemon_token: &str,
    ) -> Result<falcondeck_core::TrustedDevicesResponse, DaemonError> {
        reqwest::Client::new()
            .get(format!(
                "{}/v1/sessions/{}/devices",
                relay_url.trim_end_matches('/'),
                session_id
            ))
            .bearer_auth(daemon_token)
            .send()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to fetch relay remote status: {error}"))
            })?
            .error_for_status()
            .map_err(|error| {
                DaemonError::Rpc(format!("relay remote status request failed: {error}"))
            })?
            .json::<falcondeck_core::TrustedDevicesResponse>()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to parse relay remote status: {error}"))
            })
    }

    async fn fetch_relay_ws_ticket(
        &self,
        relay_url: &str,
        session_id: &str,
        daemon_token: &str,
    ) -> Result<RelayWebSocketTicketResponse, DaemonError> {
        reqwest::Client::new()
            .post(format!(
                "{}/v1/sessions/{}/ws-ticket",
                relay_url.trim_end_matches('/'),
                session_id
            ))
            .bearer_auth(daemon_token)
            .send()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to fetch relay websocket ticket: {error}"))
            })?
            .error_for_status()
            .map_err(|error| {
                DaemonError::Rpc(format!("relay websocket ticket request failed: {error}"))
            })?
            .json::<RelayWebSocketTicketResponse>()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to parse relay websocket ticket: {error}"))
            })
    }

    async fn publish_session_bootstrap(
        &self,
        writer: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        pairing: &RemotePairingState,
        client_bundle: &PairingPublicKeyBundle,
    ) -> Result<(), String> {
        let session_id = pairing
            .session_id
            .as_ref()
            .ok_or_else(|| "missing session id for remote bootstrap".to_string())?;
        let daemon_identity_key_pair =
            LocalIdentityKeyPair::from_box_key_pair(&pairing.local_key_pair);
        let client_wrapped_data_key = pairing
            .local_key_pair
            .wrap_data_key(&client_bundle.public_key, &pairing.data_key)
            .map_err(|error| format!("failed to wrap remote session key: {error}"))?;
        let daemon_wrapped_data_key = pairing
            .local_key_pair
            .wrap_data_key(
                pairing.local_key_pair.public_key_base64(),
                &pairing.data_key,
            )
            .map_err(|error| format!("failed to wrap daemon session key: {error}"))?;
        let mut session_material = SessionKeyMaterial {
            encryption_variant: falcondeck_core::EncryptionVariant::DataKeyV1,
            identity_variant: falcondeck_core::IdentityVariant::Ed25519V1,
            pairing_id: pairing.pairing_id.clone(),
            session_id: session_id.clone(),
            daemon_public_key: pairing.local_key_pair.public_key_base64().to_string(),
            daemon_identity_public_key: daemon_identity_key_pair.public_key_base64().to_string(),
            client_public_key: client_bundle.public_key.clone(),
            client_identity_public_key: client_bundle.identity_public_key.clone(),
            client_wrapped_data_key,
            daemon_wrapped_data_key: Some(daemon_wrapped_data_key),
            signature: String::new(),
        };
        sign_session_key_material(&daemon_identity_key_pair, &mut session_material)
            .map_err(|error| format!("failed to sign remote session bootstrap: {error}"))?;

        send_relay_message(
            writer,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::SessionBootstrap {
                    material: session_material,
                },
            },
        )
        .await
    }

    async fn publish_remote_snapshot(
        &self,
        writer: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        data_key: &[u8; 32],
        snapshot: DaemonSnapshot,
    ) -> Result<(), String> {
        let snapshot_event = EventEnvelope {
            seq: 0,
            emitted_at: Utc::now(),
            workspace_id: None,
            thread_id: None,
            event: UnifiedEvent::Snapshot { snapshot },
        };
        send_relay_message(
            writer,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::Encrypted {
                    envelope: encrypt_remote_daemon_event(data_key, &snapshot_event)?,
                },
            },
        )
        .await
    }

    async fn send_remote_rpc_result(
        &self,
        writer: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        data_key: &[u8; 32],
        request_id: String,
        rpc_result: Result<Value, String>,
    ) -> Result<(), String> {
        let (ok, result, error) = match rpc_result {
            Ok(value) => (
                true,
                Some(
                    encrypt_json(data_key, &value)
                        .map_err(|error| format!("failed to encrypt rpc result: {error}"))?,
                ),
                None,
            ),
            Err(message) => (
                false,
                None,
                Some(
                    encrypt_json(data_key, &json!({ "message": message }))
                        .map_err(|error| format!("failed to encrypt rpc error: {error}"))?,
                ),
            ),
        };
        send_relay_message(
            writer,
            &RelayClientMessage::RpcResult {
                request_id,
                ok,
                result,
                error,
            },
        )
        .await
    }

    async fn send_remote_action_failure(
        &self,
        writer: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        action_id: String,
        message: &str,
    ) -> Result<(), String> {
        send_relay_message(
            writer,
            &RelayClientMessage::ActionUpdate {
                action_id,
                status: falcondeck_core::QueuedRemoteActionStatus::Failed,
                error: Some(message.to_string()),
                result: None,
            },
        )
        .await
    }

    async fn pairing_watch_still_current(
        &self,
        relay_url: &str,
        daemon_token: &str,
        pairing_id: &str,
    ) -> bool {
        let remote = self.inner.remote.lock().await;
        remote.relay_url.as_deref() == Some(relay_url)
            && remote.daemon_token.as_deref() == Some(daemon_token)
            && remote
                .pending_pairing
                .as_ref()
                .is_some_and(|pairing| pairing.pairing_id == pairing_id)
    }

    async fn set_pairing_watch_error(
        &self,
        relay_url: &str,
        daemon_token: &str,
        pairing_id: &str,
        error: String,
    ) {
        let should_persist = {
            let mut remote = self.inner.remote.lock().await;
            if remote.relay_url.as_deref() != Some(relay_url)
                || remote.daemon_token.as_deref() != Some(daemon_token)
                || !remote
                    .pending_pairing
                    .as_ref()
                    .is_some_and(|pairing| pairing.pairing_id == pairing_id)
            {
                false
            } else {
                remote.last_error = Some(error);
                true
            }
        };
        if should_persist {
            let _ = self.persist_local_state().await;
        }
    }

    async fn handle_remote_rpc(
        &self,
        writer: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        data_key: &[u8; 32],
        request_id: String,
        method: String,
        params: EncryptedEnvelope,
    ) -> Result<(), String> {
        let params: Value = match decrypt_json(data_key, &params) {
            Ok(params) => params,
            Err(error) => {
                tracing::warn!("failed to decrypt remote rpc payload: {error}");
                self.send_remote_rpc_result(
                    writer,
                    data_key,
                    request_id,
                    Err("invalid remote rpc payload".to_string()),
                )
                .await?;
                return Ok(());
            }
        };
        let required = |keys: &[&str]| {
            extract_string(&params, keys).ok_or_else(|| "invalid remote rpc payload".to_string())
        };
        let rpc_result = match method.as_str() {
            "snapshot.current" => serde_json::to_value(self.snapshot().await)
                .map_err(|error| format!("failed to serialize snapshot: {error}")),
            "preferences.read" => serde_json::to_value(self.preferences().await)
                .map_err(|error| format!("failed to serialize preferences: {error}")),
            "thread.start" => {
                let request = StartThreadRequest {
                    workspace_id: required(&["workspaceId", "workspace_id"])?,
                    provider: extract_string(&params, &["provider"]).and_then(parse_agent_provider),
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                    approval_policy: extract_string(
                        &params,
                        &["approvalPolicy", "approval_policy"],
                    ),
                };
                self.start_thread(request)
                    .await
                    .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "thread.detail" => {
                let workspace_id = required(&["workspaceId", "workspace_id"])?;
                let thread_id = required(&["threadId", "thread_id"])?;
                self.thread_detail(&workspace_id, &thread_id)
                    .await
                    .and_then(|detail| serde_json::to_value(detail).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "thread.update" => {
                let request = UpdateThreadRequest {
                    workspace_id: required(&["workspaceId", "workspace_id"])?,
                    thread_id: required(&["threadId", "thread_id"])?,
                    title: extract_string(&params, &["title"]),
                    provider: extract_string(&params, &["provider"]).and_then(parse_agent_provider),
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    reasoning_effort: extract_string(
                        &params,
                        &["reasoningEffort", "reasoning_effort"],
                    ),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                };
                self.update_thread(request)
                    .await
                    .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "thread.mark_read" => {
                let workspace_id = required(&["workspaceId", "workspace_id"])?;
                let thread_id = required(&["threadId", "thread_id"])?;
                let read_seq = params
                    .get("readSeq")
                    .or_else(|| params.get("read_seq"))
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "invalid remote rpc payload".to_string())?;
                self.mark_thread_read(&workspace_id, &thread_id, read_seq)
                    .await
                    .and_then(|thread| serde_json::to_value(thread).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "turn.start" => {
                let request = SendTurnRequest {
                    workspace_id: required(&["workspaceId", "workspace_id"])?,
                    thread_id: required(&["threadId", "thread_id"])?,
                    inputs: params
                        .get("inputs")
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                        .unwrap_or_default(),
                    selected_skills: params
                        .get("selectedSkills")
                        .or_else(|| params.get("selected_skills"))
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                        .unwrap_or_default(),
                    provider: extract_string(&params, &["provider"]).and_then(parse_agent_provider),
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    reasoning_effort: extract_string(
                        &params,
                        &["reasoningEffort", "reasoning_effort"],
                    ),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                    approval_policy: extract_string(
                        &params,
                        &["approvalPolicy", "approval_policy"],
                    ),
                    service_tier: extract_string(&params, &["serviceTier", "service_tier"]),
                };
                self.send_turn(request)
                    .await
                    .and_then(|response| serde_json::to_value(response).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "turn.interrupt" => {
                let workspace_id = required(&["workspaceId", "workspace_id"])?;
                let thread_id = required(&["threadId", "thread_id"])?;
                self.interrupt_turn(workspace_id, thread_id)
                    .await
                    .and_then(|response| serde_json::to_value(response).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "interactive.respond" | "approval.respond" => {
                let workspace_id = required(&["workspaceId", "workspace_id"])?;
                let request_id_param = required(&["requestId", "request_id"])?;
                let response = parse_interactive_response_params(&params)
                    .map_err(|_| "invalid remote rpc payload".to_string())?;
                self.respond_to_interactive_request(workspace_id, request_id_param, response)
                    .await
                    .and_then(|response| serde_json::to_value(response).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "preferences.update" => {
                let request: UpdatePreferencesRequest = serde_json::from_value(params.clone())
                    .map_err(|_| "invalid remote rpc payload".to_string())?;
                self.update_preferences(request)
                    .await
                    .and_then(|preferences| {
                        serde_json::to_value(preferences).map_err(DaemonError::from)
                    })
                    .map_err(|error| error.to_string())
            }
            _ => Err(format!("unsupported remote rpc method `{method}`")),
        };

        self.send_remote_rpc_result(writer, data_key, request_id, rpc_result)
            .await
    }

    async fn handle_queued_remote_action(
        &self,
        writer: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        data_key: &[u8; 32],
        action_id: String,
        action_type: String,
        payload: EncryptedEnvelope,
    ) -> Result<(), String> {
        let params: Value = match decrypt_json(data_key, &payload) {
            Ok(params) => params,
            Err(error) => {
                tracing::warn!("failed to decrypt queued action payload: {error}");
                self.send_remote_action_failure(writer, action_id, "invalid queued action payload")
                    .await?;
                return Ok(());
            }
        };
        let required = |keys: &[&str]| extract_string(&params, keys);

        send_relay_message(
            writer,
            &RelayClientMessage::ActionUpdate {
                action_id: action_id.clone(),
                status: falcondeck_core::QueuedRemoteActionStatus::Executing,
                error: None,
                result: None,
            },
        )
        .await?;

        let outcome: Result<Value, DaemonError> = match action_type.as_str() {
            "preferences.update" => {
                match serde_json::from_value::<UpdatePreferencesRequest>(params.clone()) {
                    Ok(request) => self
                        .update_preferences(request)
                        .await
                        .and_then(|preferences| {
                            serde_json::to_value(preferences).map_err(DaemonError::from)
                        }),
                    Err(_) => Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    )),
                }
            }
            "thread.start" => {
                if let Some(workspace_id) = required(&["workspaceId", "workspace_id"]) {
                    let request = StartThreadRequest {
                        workspace_id,
                        provider: extract_string(&params, &["provider"])
                            .and_then(parse_agent_provider),
                        model_id: extract_string(&params, &["modelId", "model_id"]),
                        collaboration_mode_id: extract_string(
                            &params,
                            &["collaborationModeId", "collaboration_mode_id"],
                        ),
                        approval_policy: extract_string(
                            &params,
                            &["approvalPolicy", "approval_policy"],
                        ),
                    };
                    self.start_thread(request)
                        .await
                        .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.update" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    let request = UpdateThreadRequest {
                        workspace_id,
                        thread_id,
                        title: extract_string(&params, &["title"]),
                        provider: extract_string(&params, &["provider"])
                            .and_then(parse_agent_provider),
                        model_id: extract_string(&params, &["modelId", "model_id"]),
                        reasoning_effort: extract_string(
                            &params,
                            &["reasoningEffort", "reasoning_effort"],
                        ),
                        collaboration_mode_id: extract_string(
                            &params,
                            &["collaborationModeId", "collaboration_mode_id"],
                        ),
                    };
                    self.update_thread(request)
                        .await
                        .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.mark_read" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    if let Some(read_seq) = params
                        .get("readSeq")
                        .or_else(|| params.get("read_seq"))
                        .and_then(Value::as_u64)
                    {
                        self.mark_thread_read(&workspace_id, &thread_id, read_seq)
                            .await
                            .and_then(|thread| {
                                serde_json::to_value(thread).map_err(DaemonError::from)
                            })
                    } else {
                        Err(DaemonError::BadRequest(
                            "invalid queued action payload".to_string(),
                        ))
                    }
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "turn.start" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    let inputs = params
                        .get("inputs")
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                        .unwrap_or_default();
                    let request = SendTurnRequest {
                        workspace_id,
                        thread_id,
                        inputs,
                        selected_skills: params
                            .get("selectedSkills")
                            .or_else(|| params.get("selected_skills"))
                            .cloned()
                            .and_then(|value| serde_json::from_value(value).ok())
                            .unwrap_or_default(),
                        provider: extract_string(&params, &["provider"])
                            .and_then(parse_agent_provider),
                        model_id: extract_string(&params, &["modelId", "model_id"]),
                        reasoning_effort: extract_string(
                            &params,
                            &["reasoningEffort", "reasoning_effort"],
                        ),
                        collaboration_mode_id: extract_string(
                            &params,
                            &["collaborationModeId", "collaboration_mode_id"],
                        ),
                        approval_policy: extract_string(
                            &params,
                            &["approvalPolicy", "approval_policy"],
                        ),
                        service_tier: extract_string(&params, &["serviceTier", "service_tier"]),
                    };
                    self.send_turn(request).await.and_then(|response| {
                        serde_json::to_value(response).map_err(DaemonError::from)
                    })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "turn.interrupt" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    self.interrupt_turn(workspace_id, thread_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.archive" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    self.archive_thread(&workspace_id, &thread_id)
                        .await
                        .and_then(|summary| {
                            serde_json::to_value(summary).map_err(DaemonError::from)
                        })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.unarchive" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    self.unarchive_thread(&workspace_id, &thread_id)
                        .await
                        .and_then(|summary| {
                            serde_json::to_value(summary).map_err(DaemonError::from)
                        })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "interactive.respond" | "approval.respond" => {
                if let (Some(workspace_id), Some(request_id_param)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["requestId", "request_id"]),
                ) {
                    match parse_interactive_response_params(&params).map_err(|_| {
                        DaemonError::BadRequest("invalid queued action payload".to_string())
                    }) {
                        Ok(response) => self
                            .respond_to_interactive_request(
                                workspace_id,
                                request_id_param,
                                response,
                            )
                            .await
                            .and_then(|response| {
                                serde_json::to_value(response).map_err(DaemonError::from)
                            }),
                        Err(error) => Err(error),
                    }
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            other => Err(DaemonError::BadRequest(format!(
                "unsupported queued action `{other}`"
            ))),
        };

        match outcome {
            Ok(value) => {
                send_relay_message(
                    writer,
                    &RelayClientMessage::ActionUpdate {
                        action_id,
                        status: falcondeck_core::QueuedRemoteActionStatus::Completed,
                        error: None,
                        result: Some(encrypt_json(data_key, &value).map_err(|error| {
                            format!("failed to encrypt queued action result: {error}")
                        })?),
                    },
                )
                .await?;
            }
            Err(error) => {
                send_relay_message(
                    writer,
                    &RelayClientMessage::ActionUpdate {
                        action_id,
                        status: falcondeck_core::QueuedRemoteActionStatus::Failed,
                        error: Some(error.to_string()),
                        result: None,
                    },
                )
                .await?;
            }
        }

        Ok(())
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

    async fn session_for(&self, workspace_id: &str) -> Result<Arc<CodexSession>, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.codex_session.as_ref())
            .map(Arc::clone)
            .ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "workspace {workspace_id} is not currently connected to Codex"
                ))
            })
    }

    async fn claude_runtime_for(
        &self,
        workspace_id: &str,
    ) -> Result<Arc<ClaudeRuntime>, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.claude_runtime.as_ref())
            .map(Arc::clone)
            .ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "workspace {workspace_id} is not currently connected to Claude"
                ))
            })
    }

    async fn thread_provider(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<AgentProvider, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        workspace
            .threads
            .get(thread_id)
            .map(|thread| thread.summary.provider.clone())
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))
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

    async fn upsert_thread<F>(
        &self,
        workspace_id: &str,
        thread_id: &str,
        updater: F,
    ) -> Result<ThreadSummary, DaemonError>
    where
        F: FnOnce(&mut ThreadSummary),
    {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let now = Utc::now();
        let thread = workspace
            .threads
            .entry(thread_id.to_string())
            .or_insert_with(|| {
                ManagedThread::new(ThreadSummary {
                    id: thread_id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    title: "Untitled thread".to_string(),
                    provider: AgentProvider::Codex,
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
        let before = thread.summary.updated_at;
        updater(&mut thread.summary);
        if thread.summary.updated_at == before {
            thread.summary.updated_at = now;
        }
        workspace.summary.current_thread_id = Some(thread.summary.id.clone());
        if thread.summary.updated_at > workspace.summary.updated_at {
            workspace.summary.updated_at = thread.summary.updated_at;
        }
        Ok(thread.summary.clone())
    }

    async fn with_thread_mut<F>(
        &self,
        workspace_id: &str,
        thread_id: &str,
        updater: F,
    ) -> Result<(), DaemonError>
    where
        F: FnOnce(&mut ThreadSummary),
    {
        self.upsert_thread(workspace_id, thread_id, updater).await?;
        Ok(())
    }

    async fn with_managed_thread_mut<F>(
        &self,
        workspace_id: &str,
        thread_id: &str,
        updater: F,
    ) -> Result<(), DaemonError>
    where
        F: FnOnce(&mut ManagedThread),
    {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        updater(thread);
        let updated_at = thread.summary.updated_at;
        workspace.summary.current_thread_id = Some(thread.summary.id.clone());
        if updated_at > workspace.summary.updated_at {
            workspace.summary.updated_at = updated_at;
        }
        Ok(())
    }

    async fn thread_summary(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let summary = thread.summary.clone();
        drop(workspaces);
        Ok(self.build_thread_summary_from_clone(summary).await)
    }

    async fn build_thread_summary_from_clone(&self, mut summary: ThreadSummary) -> ThreadSummary {
        let interactive_requests = self.inner.interactive_requests.lock().await;
        let (pending_approval_count, pending_question_count) =
            interactive_request_counts(&interactive_requests, &summary.id);
        refresh_thread_attention(&mut summary, pending_approval_count, pending_question_count);
        summary
    }

    async fn maybe_schedule_ai_thread_title(&self, workspace_id: String, thread_id: String) {
        let title_input = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get_mut(&workspace_id) else {
                return;
            };
            let Some(thread) = workspace.threads.get_mut(&thread_id) else {
                return;
            };
            if thread.manual_title || thread.ai_title_generated || thread.ai_title_in_flight {
                return;
            }
            if !should_generate_ai_thread_title(thread) {
                return;
            }
            thread.ai_title_in_flight = true;
            AiThreadTitleInput {
                workspace_path: workspace.summary.path.clone(),
                prompt: build_ai_thread_title_prompt(&thread.items),
                prefer_claude: workspace.summary.agents.iter().any(|agent| {
                    agent.provider == AgentProvider::Claude
                        && matches!(agent.account.status, falcondeck_core::AccountStatus::Ready)
                }),
            }
        };

        let app = self.clone();
        tokio::spawn(async move {
            let generated = app.generate_ai_thread_title(&title_input).await;
            match generated {
                Some(title) => {
                    let _ = app
                        .with_managed_thread_mut(&workspace_id, &thread_id, |thread| {
                            if thread.manual_title
                                || thread.ai_title_generated
                                || (!is_placeholder_thread_title(&thread.summary.title)
                                    && !is_provisional_thread_title(&thread.summary.title))
                            {
                                thread.ai_title_in_flight = false;
                                return;
                            }
                            thread.summary.title = title.clone();
                            thread.summary.updated_at = Utc::now();
                            thread.ai_title_generated = true;
                            thread.ai_title_in_flight = false;
                        })
                        .await;
                    if let Ok(thread) = app.thread_summary(&workspace_id, &thread_id).await {
                        app.emit(
                            Some(workspace_id.clone()),
                            Some(thread_id.clone()),
                            UnifiedEvent::ThreadUpdated { thread },
                        );
                        let _ = app.persist_local_state().await;
                    }
                }
                None => {
                    let _ = app
                        .with_managed_thread_mut(&workspace_id, &thread_id, |thread| {
                            thread.ai_title_in_flight = false;
                        })
                        .await;
                }
            }
        });
    }

    async fn generate_ai_thread_title(&self, input: &AiThreadTitleInput) -> Option<String> {
        if input.prefer_claude {
            if let Some(title) = self.generate_ai_thread_title_with_claude(input).await {
                return Some(title);
            }
        }
        self.generate_ai_thread_title_with_codex(input).await
    }

    async fn generate_ai_thread_title_with_claude(
        &self,
        input: &AiThreadTitleInput,
    ) -> Option<String> {
        let resolved = resolve_agent_binary("claude", &self.inner.claude_bin);
        let output = timeout(
            Duration::from_secs(20),
            Command::new(&resolved.executable)
                .arg("-p")
                .arg(&input.prompt)
                .arg("--model")
                .arg("haiku")
                .arg("--output-format")
                .arg("text")
                .arg("--tools")
                .arg("")
                .arg("--no-session-persistence")
                .current_dir(&input.workspace_path)
                .stdin(Stdio::null())
                .output(),
        )
        .await
        .ok()?
        .ok()?;

        if !output.status.success() {
            return None;
        }

        normalize_generated_thread_title(String::from_utf8_lossy(&output.stdout).as_ref())
    }

    async fn generate_ai_thread_title_with_codex(
        &self,
        input: &AiThreadTitleInput,
    ) -> Option<String> {
        let resolved = resolve_agent_binary("codex", &self.inner.codex_bin);
        let output_path = std::env::temp_dir().join(format!(
            "falcondeck-thread-title-{}.txt",
            Uuid::new_v4().simple()
        ));
        let output = timeout(
            Duration::from_secs(25),
            Command::new(&resolved.executable)
                .arg("exec")
                .arg("--skip-git-repo-check")
                .arg("--ephemeral")
                .arg("--color")
                .arg("never")
                .arg("-s")
                .arg("read-only")
                .arg("-o")
                .arg(&output_path)
                .arg(&input.prompt)
                .current_dir(&input.workspace_path)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output(),
        )
        .await
        .ok()?
        .ok()?;

        if !output.status.success() {
            let _ = fs::remove_file(&output_path).await;
            return None;
        }

        let generated = fs::read_to_string(&output_path).await.ok();
        let _ = fs::remove_file(&output_path).await;
        normalize_generated_thread_title(generated.as_deref().unwrap_or_default())
    }

    async fn monitor_claude_turn(
        &self,
        workspace_id: String,
        thread_id: String,
        _session_id: String,
        stdout: Option<tokio::process::ChildStdout>,
        stderr: Option<tokio::process::ChildStderr>,
    ) {
        let assistant_id = format!("claude-assistant-{}", Uuid::new_v4().simple());
        let mut assistant_text = String::new();
        let mut turn_error: Option<String> = None;
        let mut saw_agent_output = false;
        let stderr_task = stderr.map(|stderr| {
            let app = self.clone();
            let workspace_id = workspace_id.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let message = line.trim();
                    if message.is_empty() {
                        continue;
                    }
                    let _ = app.emit_service(
                        Some(workspace_id.clone()),
                        Some(thread_id.clone()),
                        ServiceLevel::Info,
                        message.to_string(),
                        Some("claude-stderr".to_string()),
                    );
                }
            })
        });

        if let Some(stdout) = stdout {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(value) => {
                        if let Some(delta) = extract_claude_text_delta(&value) {
                            assistant_text = merge_claude_assistant_text(&assistant_text, &delta);
                            saw_agent_output = true;
                            let item = ConversationItem::AssistantMessage {
                                id: assistant_id.clone(),
                                text: assistant_text.clone(),
                                created_at: Utc::now(),
                            };
                            let _ = self
                                .push_conversation_item(&workspace_id, &thread_id, item, true)
                                .await;
                        } else if let Some((tool_id, title, status, output)) =
                            extract_claude_tool_event(&value)
                        {
                            saw_agent_output = true;
                            let completed_at = if status == "running" {
                                None
                            } else {
                                Some(Utc::now())
                            };
                            let item = ConversationItem::ToolCall {
                                id: tool_id,
                                title: title.clone(),
                                tool_kind: "claude_tool".to_string(),
                                status: status.clone(),
                                output: output.clone(),
                                exit_code: None,
                                display: tool_display_metadata(
                                    &title,
                                    "claude_tool",
                                    &status,
                                    None,
                                    output.as_deref(),
                                ),
                                created_at: Utc::now(),
                                completed_at,
                            };
                            let _ = self
                                .push_conversation_item(&workspace_id, &thread_id, item, true)
                                .await;
                        } else if let Some(message) = extract_claude_service_message(&value) {
                            let _ = self.emit_service(
                                Some(workspace_id.clone()),
                                Some(thread_id.clone()),
                                ServiceLevel::Info,
                                message,
                                Some("claude".to_string()),
                            );
                        }
                        if let Some(error) = extract_claude_error(&value) {
                            turn_error = Some(error);
                        }
                    }
                    Err(_) => {
                        let _ = self.emit_service(
                            Some(workspace_id.clone()),
                            Some(thread_id.clone()),
                            ServiceLevel::Info,
                            trimmed.to_string(),
                            Some("claude".to_string()),
                        );
                    }
                }
            }
        }

        if let Some(stderr_task) = stderr_task {
            let _ = stderr_task.await;
        }

        if let Ok(runtime) = self.claude_runtime_for(&workspace_id).await {
            match runtime.finish_turn(&thread_id).await {
                Ok(Some(status)) if !status.success() && turn_error.is_none() => {
                    turn_error = Some(match status.code() {
                        Some(code) => format!("Claude turn failed with exit code {code}"),
                        None => "Claude turn failed".to_string(),
                    });
                }
                Ok(Some(status))
                    if status.success() && !saw_agent_output && turn_error.is_none() =>
                {
                    turn_error = Some(
                        "Claude turn completed without emitting any assistant output".to_string(),
                    );
                }
                Ok(_) | Err(_) => {}
            }
        }
        let final_error = turn_error.clone();
        let _ = self
            .with_thread_mut(&workspace_id, &thread_id, |thread| {
                thread.status = if final_error.is_some() {
                    ThreadStatus::Error
                } else {
                    ThreadStatus::Idle
                };
                thread.last_error = final_error.clone();
                thread.updated_at = Utc::now();
            })
            .await;
        if let Ok(thread) = self.thread_summary(&workspace_id, &thread_id).await {
            self.emit(
                Some(workspace_id.clone()),
                Some(thread_id.clone()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        if turn_error.is_none() && saw_agent_output {
            self.maybe_schedule_ai_thread_title(workspace_id, thread_id)
                .await;
        }
    }
}

impl ManagedThread {
    fn new(summary: ThreadSummary) -> Self {
        let ai_title_generated = !is_placeholder_thread_title(&summary.title)
            && !is_provisional_thread_title(&summary.title);
        Self {
            summary,
            items: Vec::new(),
            assistant_items: HashMap::new(),
            reasoning_items: HashMap::new(),
            tool_items: HashMap::new(),
            manual_title: false,
            ai_title_generated,
            ai_title_in_flight: false,
            requires_resume: false,
        }
    }

    fn with_items(summary: ThreadSummary, items: Vec<ConversationItem>) -> Self {
        let mut thread = Self::new(summary);
        for (index, item) in items.into_iter().enumerate() {
            let id = conversation_item_identity(&item).to_string();
            match &item {
                ConversationItem::AssistantMessage { .. } => {
                    thread.assistant_items.insert(id, index);
                }
                ConversationItem::Reasoning { .. } => {
                    thread.reasoning_items.insert(id, index);
                }
                ConversationItem::ToolCall { .. } => {
                    thread.tool_items.insert(id, index);
                }
                _ => {}
            }
            thread.items.push(item);
        }
        thread.requires_resume = true;
        thread
    }
}

impl ManagedWorkspace {
    fn has_runtime(&self) -> bool {
        self.codex_session.is_some() && self.claude_runtime.is_some()
    }
}

impl AppState {
    async fn push_conversation_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        item: ConversationItem,
        update_existing: bool,
    ) -> Result<(), DaemonError> {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;

        let id = conversation_item_identity(&item);
        let existing_index = match &item {
            ConversationItem::AssistantMessage { .. } => thread.assistant_items.get(id).copied(),
            ConversationItem::Reasoning { .. } => thread.reasoning_items.get(id).copied(),
            ConversationItem::ToolCall { .. } => thread.tool_items.get(id).copied(),
            _ => thread
                .items
                .iter()
                .position(|entry| conversation_item_identity(entry) == id),
        };

        if update_existing {
            if let Some(index) = existing_index {
                thread.items[index] = item.clone();
                let track_attention = marks_agent_activity(&item);
                if track_attention {
                    thread.summary.attention.last_agent_activity_seq = thread
                        .summary
                        .attention
                        .last_agent_activity_seq
                        .max(self.inner.sequence.load(Ordering::Relaxed));
                }
                drop(workspaces);
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::ConversationItemUpdated { item },
                );
                if track_attention {
                    let thread = self.thread_summary(workspace_id, thread_id).await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.to_string()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    self.persist_local_state().await?;
                }
                return Ok(());
            }
        }

        let index = thread.items.len();
        match &item {
            ConversationItem::AssistantMessage { .. } => {
                thread.assistant_items.insert(id.to_string(), index);
            }
            ConversationItem::Reasoning { .. } => {
                thread.reasoning_items.insert(id.to_string(), index);
            }
            ConversationItem::ToolCall { .. } => {
                thread.tool_items.insert(id.to_string(), index);
            }
            _ => {}
        }
        thread.items.push(item.clone());
        let track_attention = marks_agent_activity(&item);
        if track_attention {
            thread.summary.attention.last_agent_activity_seq = thread
                .summary
                .attention
                .last_agent_activity_seq
                .max(self.inner.sequence.load(Ordering::Relaxed));
        }
        drop(workspaces);
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ConversationItemAdded { item },
        );
        if track_attention {
            let thread = self.thread_summary(workspace_id, thread_id).await?;
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ThreadUpdated { thread },
            );
            self.persist_local_state().await?;
        }
        Ok(())
    }

    async fn resolve_interactive_request_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), DaemonError> {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let Some(index) = thread.items.iter().position(|item| match item {
            ConversationItem::InteractiveRequest { id, .. } => id == request_id,
            _ => false,
        }) else {
            return Ok(());
        };
        if let ConversationItem::InteractiveRequest { resolved, .. } = &mut thread.items[index] {
            *resolved = true;
        }
        let item = thread.items[index].clone();
        drop(workspaces);
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ConversationItemUpdated { item },
        );
        Ok(())
    }
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

fn conversation_item_identity(item: &ConversationItem) -> &str {
    match item {
        ConversationItem::UserMessage { id, .. }
        | ConversationItem::AssistantMessage { id, .. }
        | ConversationItem::Reasoning { id, .. }
        | ConversationItem::ToolCall { id, .. }
        | ConversationItem::Plan { id, .. }
        | ConversationItem::Diff { id, .. }
        | ConversationItem::Service { id, .. }
        | ConversationItem::InteractiveRequest { id, .. } => id,
    }
}

#[derive(Debug, Clone)]
struct ResolvedSelectedSkill {
    alias: String,
    summary: SkillSummary,
}

fn resolve_selected_skills(
    available_skills: &[SkillSummary],
    selected_skills: &[SelectedSkillReference],
    provider: &AgentProvider,
) -> Vec<ResolvedSelectedSkill> {
    selected_skills
        .iter()
        .filter_map(|selection| {
            available_skills
                .iter()
                .find(|skill| {
                    skill.id == selection.skill_id
                        || skill.alias.eq_ignore_ascii_case(&selection.alias)
                        || canonical_skill_alias(&skill.alias)
                            == canonical_skill_alias(&selection.alias)
                })
                .filter(|skill| {
                    matches!(
                        (provider, &skill.availability),
                        (
                            AgentProvider::Codex,
                            falcondeck_core::SkillAvailability::Codex
                        ) | (
                            AgentProvider::Codex,
                            falcondeck_core::SkillAvailability::Both
                        ) | (
                            AgentProvider::Claude,
                            falcondeck_core::SkillAvailability::Claude
                        ) | (
                            AgentProvider::Claude,
                            falcondeck_core::SkillAvailability::Both
                        )
                    )
                })
                .cloned()
                .map(|summary| ResolvedSelectedSkill {
                    alias: selection.alias.clone(),
                    summary,
                })
        })
        .collect()
}

fn codex_inputs(inputs: &[TurnInputItem], selected_skills: &[ResolvedSelectedSkill]) -> Vec<Value> {
    let fallback_text_skill_names = selected_skills
        .iter()
        .filter_map(|skill| {
            skill
                .summary
                .provider_translations
                .codex
                .as_ref()
                .and_then(|translation| {
                    if translation.native_id.is_some() {
                        None
                    } else {
                        translation.native_name.clone()
                    }
                })
        })
        .collect::<Vec<_>>();
    let mut structured_skill_inputs = selected_skills
        .iter()
        .filter_map(|skill| {
            skill
                .summary
                .provider_translations
                .codex
                .as_ref()
                .and_then(|translation| translation.native_id.clone())
                .map(|native_id| {
                    let name = skill
                        .summary
                        .provider_translations
                        .codex
                        .as_ref()
                        .and_then(|translation| translation.native_name.clone())
                        .unwrap_or_else(|| native_id.clone());
                    json!({
                        "type": "skill",
                        "id": native_id,
                        "name": name,
                    })
                })
        })
        .collect::<Vec<_>>();
    let mut translated_inputs = Vec::new();

    if !structured_skill_inputs.is_empty() {
        translated_inputs.append(&mut structured_skill_inputs);
    }

    inputs
        .iter()
        .map(|item| match item {
            TurnInputItem::Text { text, .. } => {
                let translated = replace_selected_skill_aliases(text, selected_skills, |skill| {
                    skill
                        .summary
                        .provider_translations
                        .codex
                        .as_ref()
                        .and_then(|translation| {
                            if translation.native_id.is_some() {
                                None
                            } else {
                                translation.native_name.clone()
                            }
                        })
                        .map(|name| format!("${name}"))
                });
                json!({
                    "type": "text",
                    "text": translated,
                })
            }
            TurnInputItem::Image(image) => {
                if let Some(local_path) = image
                    .local_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                {
                    json!({
                        "type": "localImage",
                        "path": local_path,
                    })
                } else if image.url.starts_with("http://")
                    || image.url.starts_with("https://")
                    || image.url.starts_with("data:")
                {
                    json!({
                        "type": "image",
                        "url": image.url,
                    })
                } else {
                    json!({
                        "type": "localImage",
                        "path": image.url,
                    })
                }
            }
        })
        .for_each(|item| translated_inputs.push(item));

    if translated_inputs
        .iter()
        .all(|entry| entry.get("type").and_then(Value::as_str) != Some("text"))
        && !fallback_text_skill_names.is_empty()
    {
        translated_inputs.push(json!({
            "type": "text",
            "text": fallback_text_skill_names
                .into_iter()
                .map(|name| format!("${name}"))
                .collect::<Vec<_>>()
                .join("\n"),
        }));
    }

    translated_inputs
}

fn claude_prompt_from_inputs(
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
) -> String {
    inputs
        .iter()
        .map(|input| match input {
            TurnInputItem::Text { text, .. } => translate_claude_text_input(text, selected_skills),
            TurnInputItem::Image(image) => image
                .local_path
                .as_ref()
                .map(|path| format!("[image attachment: {path}]"))
                .unwrap_or_else(|| format!("[image attachment: {}]", image.url)),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn translate_claude_text_input(text: &str, selected_skills: &[ResolvedSelectedSkill]) -> String {
    let mut translated = replace_selected_skill_aliases(text, selected_skills, |skill| {
        skill
            .summary
            .provider_translations
            .claude
            .as_ref()
            .and_then(|translation| translation.command_name.clone())
            .map(|name| format!("/{name}"))
    });

    let prompt_preambles = selected_skills
        .iter()
        .filter_map(|skill| {
            skill.summary
                .provider_translations
                .claude
                .as_ref()
                .and_then(|translation| {
                    if translation.command_name.is_some() {
                        None
                    } else {
                        translation.prompt_reference_path.as_ref().map(|path| {
                            format!(
                                "Use the FalconDeck skill defined at {path}. Follow it as the governing skill for this request."
                            )
                        })
                    }
                })
        })
        .collect::<Vec<_>>();

    if translated.trim().is_empty() && !selected_skills.is_empty() {
        translated = selected_skills
            .iter()
            .filter_map(|skill| {
                skill
                    .summary
                    .provider_translations
                    .claude
                    .as_ref()
                    .and_then(|translation| translation.command_name.clone())
                    .map(|name| format!("/{name}"))
            })
            .collect::<Vec<_>>()
            .join("\n");
    }

    if prompt_preambles.is_empty() {
        translated
    } else if translated.trim().is_empty() {
        prompt_preambles.join("\n\n")
    } else {
        format!("{}\n\n{translated}", prompt_preambles.join("\n\n"))
    }
}

fn replace_selected_skill_aliases<F>(
    text: &str,
    selected_skills: &[ResolvedSelectedSkill],
    replacement_for_skill: F,
) -> String
where
    F: Fn(&ResolvedSelectedSkill) -> Option<String>,
{
    let mut translated = text.to_string();
    for skill in selected_skills {
        let alias = canonical_skill_alias(&skill.alias);
        let Some(replacement) = replacement_for_skill(skill) else {
            continue;
        };
        if translated.contains(&alias) {
            translated = translated.replacen(&alias, &replacement, 1);
        }
    }
    translated
}

fn is_claude_plan_mode(mode_id: Option<&str>) -> bool {
    mode_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.eq_ignore_ascii_case("plan"))
        .unwrap_or(false)
}

fn extract_claude_text_delta(value: &Value) -> Option<String> {
    if matches!(extract_string(value, &["type"]).as_deref(), Some("result")) {
        return extract_string(value, &["result"]);
    }

    let event = claude_event_value(value);
    if let Some(text) = extract_string(event, &["text", "completion"]) {
        return Some(text);
    }
    if let Some(text) = event
        .get("delta")
        .and_then(|delta| extract_string(delta, &["text"]))
    {
        return Some(text);
    }
    if let Some(text) = value
        .get("message")
        .and_then(claude_message_text)
        .filter(|text| !text.is_empty())
    {
        return Some(text);
    }
    if let Some(text) = extract_string(value, &["text", "completion"]) {
        return Some(text);
    }
    value
        .get("delta")
        .and_then(|delta| extract_string(delta, &["text"]))
}

fn extract_claude_tool_event(value: &Value) -> Option<(String, String, String, Option<String>)> {
    let top_level_type = extract_string(value, &["type"]);
    let event = claude_event_value(value);
    let event_type =
        extract_string(event, &["type", "event"]).or_else(|| top_level_type.clone())?;

    if top_level_type.as_deref() == Some("user") {
        let tool_result = value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| extract_string(item, &["type"]).as_deref() == Some("tool_result"))
            })?;
        let id = extract_string(tool_result, &["tool_use_id", "toolUseId", "id"])
            .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
        let output = extract_string(tool_result, &["content", "text"]);
        return Some((
            id,
            "Claude tool".to_string(),
            "completed".to_string(),
            output,
        ));
    }

    if event_type == "content_block_start" {
        let content_block = event.get("content_block")?;
        if extract_string(content_block, &["type"]).as_deref() != Some("tool_use") {
            return None;
        }
        let id = extract_string(content_block, &["id"])
            .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
        let title =
            extract_string(content_block, &["name"]).unwrap_or_else(|| "Claude tool".to_string());
        return Some((id, title, "running".to_string(), None));
    }

    if top_level_type.as_deref() == Some("assistant") {
        let tool_use = value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| extract_string(item, &["type"]).as_deref() == Some("tool_use"))
            });
        if let Some(tool_use) = tool_use {
            let id = extract_string(tool_use, &["id"])
                .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
            let title =
                extract_string(tool_use, &["name"]).unwrap_or_else(|| "Claude tool".to_string());
            return Some((id, title, "running".to_string(), None));
        }
    }

    if !(event_type.contains("tool") || event.get("tool_name").is_some()) {
        return None;
    }

    let id = extract_string(event, &["tool_use_id", "toolUseId", "id"])
        .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
    let title = extract_string(event, &["tool_name", "toolName", "name"])
        .unwrap_or_else(|| "Claude tool".to_string());
    let status = if event_type.contains("end") || event_type.contains("result") {
        "completed"
    } else {
        "running"
    };
    let output = extract_string(event, &["output", "result", "text"]);
    Some((id, title, status.to_string(), output))
}

fn extract_claude_service_message(value: &Value) -> Option<String> {
    let event_type = extract_string(claude_event_value(value), &["type", "event"])
        .or_else(|| extract_string(value, &["type"]))?;
    if matches!(event_type.as_str(), "system" | "status" | "result") {
        return extract_string(claude_event_value(value), &["message", "status", "summary"])
            .or_else(|| extract_string(value, &["message", "status", "summary"]));
    }
    None
}

fn extract_claude_error(value: &Value) -> Option<String> {
    if extract_string(value, &["type"]).as_deref() == Some("result")
        && value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return extract_string(value, &["result"])
            .or_else(|| extract_string(value, &["subtype"]))
            .or_else(|| Some("Claude turn failed".to_string()));
    }

    let event = claude_event_value(value);
    extract_string(event, &["error", "message"])
        .or_else(|| extract_string(value, &["error", "message"]))
        .filter(|_| {
            extract_string(event, &["type", "event"])
                .or_else(|| extract_string(value, &["type"]))
                .map(|event| event.contains("error"))
                .unwrap_or(false)
                || value.get("error").is_some()
        })
}

fn merge_claude_assistant_text(current: &str, next_chunk: &str) -> String {
    if current.is_empty() {
        return next_chunk.to_string();
    }
    if next_chunk.is_empty() || current == next_chunk {
        return current.to_string();
    }
    if next_chunk.starts_with(current) {
        return next_chunk.to_string();
    }
    format!("{current}{next_chunk}")
}

fn claude_event_value<'a>(value: &'a Value) -> &'a Value {
    value.get("event").unwrap_or(value)
}

fn claude_message_text(value: &Value) -> Option<String> {
    let content = value.get("content")?.as_array()?;
    let mut parts = Vec::new();
    for item in content {
        if extract_string(item, &["type"]).as_deref() != Some("text") {
            continue;
        }
        if let Some(text) = extract_string(item, &["text"]) {
            parts.push(text);
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(""))
    }
}

fn parse_agent_provider(value: String) -> Option<AgentProvider> {
    match value.trim().to_ascii_lowercase().as_str() {
        "codex" => Some(AgentProvider::Codex),
        "claude" => Some(AgentProvider::Claude),
        _ => None,
    }
}

fn codex_inputs_with_plan_mode_shim(
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
    use_plan_mode_shim: bool,
) -> Vec<Value> {
    if !use_plan_mode_shim {
        return codex_inputs(inputs, selected_skills);
    }

    let mut shimmed_inputs = vec![json!({
        "type": "text",
        "text": plan_mode_prompt_shim(),
    })];
    shimmed_inputs.extend(codex_inputs(inputs, selected_skills));
    shimmed_inputs
}

fn plan_mode_prompt_shim() -> &'static str {
    "Enter plan mode for this turn. Explore first, ask clarifying questions if needed, and produce a decision-complete implementation plan before making repo-tracked changes. Do not perform mutating work until the user explicitly exits plan mode."
}

fn mode_matches_plan(mode: &CollaborationModeSummary) -> bool {
    mode.mode
        .as_deref()
        .unwrap_or(mode.id.as_str())
        .eq_ignore_ascii_case("plan")
}

fn should_use_plan_mode_shim(
    summary: &WorkspaceSummary,
    provider: &AgentProvider,
    mode_id: Option<&str>,
) -> bool {
    let agent = summary
        .agents
        .iter()
        .find(|agent| &agent.provider == provider);
    let supports_plan_mode = agent
        .map(|agent| agent.supports_plan_mode)
        .unwrap_or(summary.supports_plan_mode);
    let supports_native_plan_mode = agent
        .map(|agent| agent.supports_native_plan_mode)
        .unwrap_or(summary.supports_native_plan_mode);

    if !supports_plan_mode || supports_native_plan_mode {
        return false;
    }

    let Some(mode_id) = mode_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };

    agent
        .map(|agent| &agent.collaboration_modes)
        .unwrap_or(&summary.collaboration_modes)
        .iter()
        .find(|mode| mode.id == mode_id)
        .map(mode_matches_plan)
        .unwrap_or_else(|| mode_id.eq_ignore_ascii_case("plan"))
}

fn collaboration_mode_payload(
    mode_id: Option<&str>,
    selected_model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    supports_native_plan_mode: bool,
) -> Value {
    if !supports_native_plan_mode {
        return Value::Null;
    }

    let Some(mode_id) = mode_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Value::Null;
    };

    let mut settings = serde_json::Map::new();
    if let Some(model_id) = selected_model_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        settings.insert("model".to_string(), json!(model_id));
    }
    if let Some(reasoning_effort) = reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        settings.insert("reasoning_effort".to_string(), json!(reasoning_effort));
    }

    json!({
        "mode": mode_id,
        "settings": settings,
    })
}

fn build_user_message_item(inputs: &[TurnInputItem]) -> ConversationItem {
    let mut text = String::new();
    let mut attachments = Vec::new();

    for input in inputs {
        match input {
            TurnInputItem::Text { text: next, .. } => {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(next);
            }
            TurnInputItem::Image(image) => attachments.push(image.clone()),
        }
    }

    ConversationItem::UserMessage {
        id: format!("user-{}", Uuid::new_v4().simple()),
        text,
        attachments,
        created_at: Utc::now(),
    }
}

fn provisional_thread_title_from_inputs(inputs: &[TurnInputItem]) -> Option<String> {
    let text = inputs.iter().find_map(|input| match input {
        TurnInputItem::Text { text, .. } => Some(text.as_str()),
        TurnInputItem::Image(_) => None,
    })?;
    provisional_thread_title_from_text(text)
}

fn provisional_thread_title_from_text(text: &str) -> Option<String> {
    let words = text.split_whitespace().take(4).collect::<Vec<_>>();
    if words.is_empty() {
        return None;
    }
    Some(format!("{}...", words.join(" ")))
}

fn should_generate_ai_thread_title(thread: &ManagedThread) -> bool {
    let has_user_message = thread
        .items
        .iter()
        .any(|item| matches!(item, ConversationItem::UserMessage { .. }));
    let has_agent_output = thread.items.iter().any(|item| {
        matches!(
            item,
            ConversationItem::AssistantMessage { .. } | ConversationItem::ToolCall { .. }
        )
    });

    has_user_message
        && has_agent_output
        && !thread.manual_title
        && !thread.ai_title_generated
        && (is_placeholder_thread_title(&thread.summary.title)
            || is_provisional_thread_title(&thread.summary.title))
}

fn is_placeholder_thread_title(title: &str) -> bool {
    matches!(
        title.trim().to_ascii_lowercase().as_str(),
        "" | "untitled thread"
            | "new thread"
            | "new claude thread"
            | "claude thread"
            | "restored thread"
    )
}

fn is_provisional_thread_title(title: &str) -> bool {
    title.trim().ends_with("...")
}

fn build_ai_thread_title_prompt(items: &[ConversationItem]) -> String {
    let mut excerpts = Vec::new();
    let user_messages = items
        .iter()
        .filter_map(|item| match item {
            ConversationItem::UserMessage { text, .. } => Some(text.trim()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    if let Some(first) = user_messages.first() {
        excerpts.push(format!(
            "First user message:\n{}",
            truncate_preview(first, 600)
        ));
    }

    let recent = items
        .iter()
        .rev()
        .filter_map(|item| match item {
            ConversationItem::UserMessage { text, .. } => Some(format!("User: {}", text.trim())),
            ConversationItem::AssistantMessage { text, .. } => {
                Some(format!("Assistant: {}", text.trim()))
            }
            ConversationItem::ToolCall { title, output, .. } => Some(format!(
                "Tool: {}{}",
                title.trim(),
                output
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!(" -> {}", truncate_preview(value, 180)))
                    .unwrap_or_default()
            )),
            _ => None,
        })
        .filter(|text| !text.trim().is_empty())
        .take(4)
        .collect::<Vec<_>>();
    if !recent.is_empty() {
        let ordered_recent = recent.into_iter().rev().collect::<Vec<_>>().join("\n");
        excerpts.push(format!("Recent messages:\n{ordered_recent}"));
    }

    format!(
        "You are a session renaming tool.\n\
Write a short, specific thread title for this coding conversation.\n\
\n\
Rules:\n\
- 3 to 7 words\n\
- no quotes\n\
- no trailing punctuation\n\
- prefer concrete task nouns\n\
- avoid generic titles like Debugging or Code Help\n\
- return only the title\n\
\n\
{}\n",
        excerpts.join("\n\n")
    )
}

fn normalize_generated_thread_title(output: &str) -> Option<String> {
    let candidate = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| is_valid_generated_title_line(line))?;
    let candidate = candidate
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '`')
        .trim()
        .trim_end_matches(|ch: char| matches!(ch, '.' | '!' | '?' | ':' | ';' | ','))
        .trim();
    if candidate.is_empty()
        || is_placeholder_thread_title(candidate)
        || is_provisional_thread_title(candidate)
    {
        return None;
    }
    Some(truncate_preview(candidate, 80))
}

fn is_valid_generated_title_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    let normalized = trimmed.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "user" | "assistant" | "codex" | "claude" | "tokens used"
    ) {
        return false;
    }

    if normalized.starts_with("openai codex v") || normalized.starts_with("workdir:") {
        return false;
    }

    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_digit() || ch == ',' || ch == '.' || ch.is_whitespace())
    {
        return false;
    }

    true
}

fn approval_title(method: &str) -> String {
    match method {
        "item/commandExecution/requestApproval" => "Approve command".to_string(),
        "item/fileChange/requestApproval" => "Approve file change".to_string(),
        "skill/requestApproval" => "Approve skill".to_string(),
        other => format!("Approve {}", other.rsplit('/').next().unwrap_or("request")),
    }
}

fn notification_timestamp(method: &str, params: &Value) -> Option<chrono::DateTime<Utc>> {
    let preferred_keys: &[&str] = match method {
        "thread/started" => &[
            "timestamp",
            "startedAt",
            "started_at",
            "createdAt",
            "created_at",
        ],
        "thread/name/updated" | "turn/plan/updated" | "turn/diff/updated" => &[
            "timestamp",
            "updatedAt",
            "updated_at",
            "createdAt",
            "created_at",
        ],
        "turn/started" | "turn/step/started" => &[
            "timestamp",
            "startedAt",
            "started_at",
            "createdAt",
            "created_at",
        ],
        "turn/completed" | "turn/step/completed" => &[
            "timestamp",
            "completedAt",
            "completed_at",
            "updatedAt",
            "updated_at",
        ],
        _ => &[
            "timestamp",
            "updatedAt",
            "updated_at",
            "createdAt",
            "created_at",
        ],
    };
    extract_datetime_or_timestamp(params, preferred_keys)
}

fn plan_step_status(method: &str, params: &Value) -> Option<String> {
    extract_string(params, &["status"]).or_else(|| match method {
        "turn/step/started" => Some("in_progress".to_string()),
        "turn/step/completed" => Some("completed".to_string()),
        _ => None,
    })
}

fn parse_interactive_questions(params: &Value) -> Vec<InteractiveQuestion> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .map(|question| InteractiveQuestion {
                    id: extract_string(question, &["id"])
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    header: extract_string(question, &["header"])
                        .unwrap_or_else(|| "Question".to_string()),
                    question: extract_string(question, &["question"])
                        .unwrap_or_else(|| "Provide additional input.".to_string()),
                    is_other: question
                        .get("isOther")
                        .or_else(|| question.get("is_other"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    is_secret: question
                        .get("isSecret")
                        .or_else(|| question.get("is_secret"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    options: question
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .map(|option| InteractiveQuestionOption {
                                    label: extract_string(option, &["label"])
                                        .unwrap_or_else(|| "Option".to_string()),
                                    description: extract_string(option, &["description"])
                                        .unwrap_or_default(),
                                })
                                .collect()
                        }),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_interactive_response_params(params: &Value) -> Result<InteractiveResponsePayload, String> {
    if let Some(response) = params.get("response") {
        if let Some(kind) = extract_string(response, &["kind"]) {
            return match kind.as_str() {
                "approval" => match extract_string(response, &["decision"]).as_deref() {
                    Some("allow") => Ok(InteractiveResponsePayload::Approval {
                        decision: ApprovalDecision::Allow,
                    }),
                    Some("deny") => Ok(InteractiveResponsePayload::Approval {
                        decision: ApprovalDecision::Deny,
                    }),
                    Some("always_allow") => Ok(InteractiveResponsePayload::Approval {
                        decision: ApprovalDecision::AlwaysAllow,
                    }),
                    _ => Err("unsupported approval decision".to_string()),
                },
                "question" => Ok(InteractiveResponsePayload::Question {
                    answers: response
                        .get("answers")
                        .and_then(Value::as_object)
                        .map(|answers| {
                            answers
                                .iter()
                                .map(|(question_id, value)| {
                                    let answer_values = value
                                        .as_array()
                                        .map(|items| {
                                            items
                                                .iter()
                                                .filter_map(Value::as_str)
                                                .map(str::to_string)
                                                .collect::<Vec<_>>()
                                        })
                                        .or_else(|| {
                                            value.get("answers").and_then(Value::as_array).map(
                                                |items| {
                                                    items
                                                        .iter()
                                                        .filter_map(Value::as_str)
                                                        .map(str::to_string)
                                                        .collect::<Vec<_>>()
                                                },
                                            )
                                        })
                                        .unwrap_or_default();
                                    (question_id.clone(), answer_values)
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                }),
                _ => Err("unsupported interactive response kind".to_string()),
            };
        }
    }

    match extract_string(params, &["decision"]).as_deref() {
        Some("allow") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::Allow,
        }),
        Some("deny") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::Deny,
        }),
        Some("always_allow") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::AlwaysAllow,
        }),
        _ => Err("interactive response payload is missing a supported response".to_string()),
    }
}

fn truncate_preview(input: &str, limit: usize) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut result = trimmed
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

fn should_surface_tool_item(kind: &str) -> bool {
    !matches!(
        kind,
        "userMessage"
            | "user_message"
            | "agentMessage"
            | "agent_message"
            | "reasoning"
            | "reasoningSummary"
            | "reasoning_summary"
    )
}

fn tool_display_metadata(
    title: &str,
    kind: &str,
    status: &str,
    exit_code: Option<i32>,
    output: Option<&str>,
) -> ToolCallDisplay {
    let normalized_title = title.to_ascii_lowercase();
    let normalized_kind = kind.to_ascii_lowercase();
    let normalized_output = output.unwrap_or_default().to_ascii_lowercase();

    let is_read_only = normalized_kind.contains("read")
        || normalized_kind.contains("search")
        || normalized_kind.contains("list")
        || normalized_kind.contains("grep")
        || normalized_kind.contains("inspect")
        || normalized_title.starts_with("cat ")
        || normalized_title.starts_with("sed ")
        || normalized_title.starts_with("ls ")
        || normalized_title.starts_with("find ")
        || normalized_title.starts_with("rg ")
        || normalized_title.starts_with("git diff")
        || normalized_title.starts_with("git status")
        || normalized_title.starts_with("pwd");

    let artifact_kind =
        if normalized_kind.contains("filechange") || normalized_kind.contains("file_change") {
            ToolArtifactKind::Diff
        } else if normalized_title.contains("test")
            || normalized_kind.contains("test")
            || normalized_output.contains("test failed")
            || normalized_output.contains("failing")
        {
            ToolArtifactKind::Test
        } else if normalized_title.contains("approval")
            || normalized_kind.contains("approval")
            || normalized_title.contains("permission")
        {
            ToolArtifactKind::ApprovalRelated
        } else if output
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            ToolArtifactKind::CommandOutput
        } else {
            ToolArtifactKind::None
        };

    let is_error = status.eq_ignore_ascii_case("failed")
        || status.eq_ignore_ascii_case("error")
        || exit_code.unwrap_or_default() != 0;
    let has_side_effect = !is_read_only
        || normalized_kind.contains("write")
        || normalized_kind.contains("edit")
        || normalized_kind.contains("patch")
        || normalized_title.contains("apply_patch")
        || normalized_title.contains("npm install")
        || normalized_title.contains("cargo add")
        || normalized_title.contains("curl ")
        || normalized_title.contains("wget ")
        || is_error;
    let summary_hint = summarize_tool_title(title);

    ToolCallDisplay {
        is_read_only,
        has_side_effect,
        is_error,
        artifact_kind,
        summary_hint,
    }
}

fn summarize_tool_title(title: &str) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(path) = trimmed.strip_prefix("cat ") {
        return Some(format!("Read {}", path.trim()));
    }
    if let Some(path) = trimmed.strip_prefix("sed -n ") {
        return Some(format!("Inspect {}", path.trim()));
    }
    if trimmed.starts_with("rg ") {
        return Some("Search workspace".to_string());
    }
    if trimmed.starts_with("ls ") {
        return Some("List files".to_string());
    }
    None
}

fn default_state_path() -> PathBuf {
    let home = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join(".falcondeck").join("daemon-state.json")
}

fn default_preferences_path(state_path: &PathBuf) -> PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("falcondeck.json")
}

fn default_persisted_provider() -> Option<AgentProvider> {
    Some(AgentProvider::Codex)
}

async fn load_persisted_app_state(path: &PathBuf) -> Result<PersistedAppState, DaemonError> {
    match fs::read_to_string(path).await {
        Ok(contents) => serde_json::from_str(&contents).map_err(DaemonError::from),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PersistedAppState::default())
        }
        Err(error) => Err(DaemonError::Io(error)),
    }
}

async fn load_preferences(path: &PathBuf) -> Result<FalconDeckPreferences, DaemonError> {
    match fs::read_to_string(path).await {
        Ok(contents) => {
            let value: Value = serde_json::from_str(&contents)?;
            Ok(merge_preferences_from_value(value))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(FalconDeckPreferences::default())
        }
        Err(error) => Err(DaemonError::Io(error)),
    }
}

fn normalize_workspace_path(path: &str) -> String {
    PathBuf::from(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string()
}

fn deserialize_persisted_workspaces<'de, D>(
    deserializer: D,
) -> Result<Vec<PersistedWorkspaceState>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Vec::<PersistedWorkspaceEntry>::deserialize(deserializer)?;
    Ok(entries
        .into_iter()
        .map(|entry| match entry {
            PersistedWorkspaceEntry::LegacyPath(path) => PersistedWorkspaceState {
                path,
                current_thread_id: None,
                updated_at: None,
                default_provider: Some(AgentProvider::Codex),
                last_error: None,
                archived_thread_ids: Vec::new(),
                thread_states: Vec::new(),
            },
            PersistedWorkspaceEntry::State(workspace) => workspace,
        })
        .collect())
}

async fn persist_app_state(path: &PathBuf, state: &PersistedAppState) -> Result<(), DaemonError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(state)?;
    fs::write(&tmp_path, payload).await?;
    fs::rename(&tmp_path, path).await?;
    Ok(())
}

async fn persist_preferences(
    path: &PathBuf,
    preferences: &FalconDeckPreferences,
) -> Result<(), DaemonError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(preferences)?;
    fs::write(&tmp_path, payload).await?;
    fs::rename(&tmp_path, path).await?;
    Ok(())
}

fn merge_preferences_from_value(value: Value) -> FalconDeckPreferences {
    let mut preferences = FalconDeckPreferences::default();
    if let Some(version) = value.get("version").and_then(Value::as_u64) {
        preferences.version = version as u32;
    }

    if let Some(conversation) = value.get("conversation") {
        if let Some(mode) = extract_string(conversation, &["tool_details_mode"]) {
            preferences.conversation.tool_details_mode = parse_tool_details_mode(&mode);
        }
        if let Some(group) = conversation
            .get("group_read_only_tools")
            .and_then(Value::as_bool)
        {
            preferences.conversation.group_read_only_tools = group;
        }
        if let Some(show) = conversation
            .get("show_expand_all_controls")
            .and_then(Value::as_bool)
        {
            preferences.conversation.show_expand_all_controls = show;
        }
        if let Some(auto_expand) = conversation.get("auto_expand") {
            if let Some(value) = auto_expand.get("approvals").and_then(Value::as_bool) {
                preferences.conversation.auto_expand.approvals = value;
            }
            if let Some(value) = auto_expand.get("errors").and_then(Value::as_bool) {
                preferences.conversation.auto_expand.errors = value;
            }
            if let Some(value) = auto_expand.get("first_diff").and_then(Value::as_bool) {
                preferences.conversation.auto_expand.first_diff = value;
            }
            if let Some(value) = auto_expand.get("failed_tests").and_then(Value::as_bool) {
                preferences.conversation.auto_expand.failed_tests = value;
            }
        }
    }

    preferences
}

fn apply_preferences_patch(
    preferences: &mut FalconDeckPreferences,
    request: UpdatePreferencesRequest,
) {
    let Some(conversation) = request.conversation else {
        return;
    };

    if let Some(mode) = conversation.tool_details_mode {
        preferences.conversation.tool_details_mode = mode;
    }
    if let Some(value) = conversation.group_read_only_tools {
        preferences.conversation.group_read_only_tools = value;
    }
    if let Some(value) = conversation.show_expand_all_controls {
        preferences.conversation.show_expand_all_controls = value;
    }
    if let Some(auto_expand) = conversation.auto_expand {
        apply_auto_expand_patch(&mut preferences.conversation.auto_expand, auto_expand);
    }
}

fn apply_auto_expand_patch(
    current: &mut falcondeck_core::ConversationAutoExpandPreferences,
    patch: ConversationAutoExpandPreferencesPatch,
) {
    if let Some(value) = patch.approvals {
        current.approvals = value;
    }
    if let Some(value) = patch.errors {
        current.errors = value;
    }
    if let Some(value) = patch.first_diff {
        current.first_diff = value;
    }
    if let Some(value) = patch.failed_tests {
        current.failed_tests = value;
    }
}

fn parse_tool_details_mode(value: &str) -> ToolDetailsMode {
    match value {
        "expanded" => ToolDetailsMode::Expanded,
        "compact" => ToolDetailsMode::Compact,
        "hide_read_only_details" => ToolDetailsMode::HideReadOnlyDetails,
        _ => ToolDetailsMode::Auto,
    }
}

fn persisted_remote_state(
    remote: &RemoteBridgeState,
) -> Result<Option<PersistedRemoteState>, DaemonError> {
    let Some(relay_url) = remote.relay_url.clone() else {
        return Ok(None);
    };
    let Some(daemon_token) = remote.daemon_token.clone() else {
        return Ok(None);
    };
    let Some(pairing) = remote.pairing.as_ref() else {
        return Ok(None);
    };
    let secure_storage_key = remote_secret_storage_key(
        &relay_url,
        &pairing.pairing_id,
        pairing.session_id.as_deref(),
    );
    save_remote_secrets(
        &secure_storage_key,
        &PersistedRemoteSecrets {
            local_secret_key_base64: pairing.local_key_pair.secret_key_base64(),
            data_key_base64: encode_base64(&pairing.data_key),
        },
    )?;
    Ok(Some(PersistedRemoteState {
        relay_url,
        daemon_token,
        pairing_id: pairing.pairing_id.clone(),
        pairing_code: pairing.pairing_code.clone(),
        session_id: pairing.session_id.clone(),
        device_id: pairing.device_id.clone(),
        trusted_at: pairing.trusted_at,
        expires_at: pairing.expires_at,
        client_bundle: pairing.client_bundle.clone(),
        client_public_key: None,
        secure_storage_key: Some(secure_storage_key),
        local_secret_key_base64: None,
        data_key_base64: None,
    }))
}

fn invalid_persisted_remote_reason(remote: &PersistedRemoteState) -> Option<String> {
    if remote.device_id.is_none() {
        return None;
    }

    let Some(client_bundle) = remote.client_bundle.as_ref() else {
        return if remote.client_public_key.is_some() {
            Some("trusted remote only has legacy unsigned client key material".to_string())
        } else {
            Some("trusted remote is missing signed client key material".to_string())
        };
    };

    verify_pairing_public_key_bundle(client_bundle)
        .err()
        .map(|error| format!("trusted remote has invalid signed client key material: {error}"))
}

fn remote_secret_storage_key(
    relay_url: &str,
    pairing_id: &str,
    session_id: Option<&str>,
) -> String {
    let identity = session_id.unwrap_or(pairing_id);
    format!("{relay_url}|{identity}")
}

fn load_remote_secrets(
    remote: &PersistedRemoteState,
    secure_storage_key: &str,
) -> Result<PersistedRemoteSecrets, DaemonError> {
    if let (Some(local_secret_key_base64), Some(data_key_base64)) = (
        remote.local_secret_key_base64.clone(),
        remote.data_key_base64.clone(),
    ) {
        return Ok(PersistedRemoteSecrets {
            local_secret_key_base64,
            data_key_base64,
        });
    }

    load_remote_secrets_from_secure_storage(secure_storage_key)
}

fn save_remote_secrets(
    secure_storage_key: &str,
    secrets: &PersistedRemoteSecrets,
) -> Result<(), DaemonError> {
    save_remote_secrets_to_secure_storage(secure_storage_key, secrets)
}

fn delete_remote_secrets(secure_storage_key: String) -> Result<(), DaemonError> {
    delete_remote_secrets_from_secure_storage(&secure_storage_key)
}

#[cfg(not(test))]
fn save_remote_secrets_to_secure_storage(
    secure_storage_key: &str,
    secrets: &PersistedRemoteSecrets,
) -> Result<(), DaemonError> {
    let payload = serde_json::to_string(secrets)?;
    let entry = keyring::Entry::new("com.falcondeck.daemon.remote", secure_storage_key)
        .map_err(|error| DaemonError::Process(format!("failed to open secure storage: {error}")))?;
    entry
        .set_password(&payload)
        .map_err(|error| DaemonError::Process(format!("failed to write secure storage: {error}")))
}

#[cfg(not(test))]
fn load_remote_secrets_from_secure_storage(
    secure_storage_key: &str,
) -> Result<PersistedRemoteSecrets, DaemonError> {
    let entry = keyring::Entry::new("com.falcondeck.daemon.remote", secure_storage_key)
        .map_err(|error| DaemonError::Process(format!("failed to open secure storage: {error}")))?;
    let payload = entry
        .get_password()
        .map_err(|error| DaemonError::Process(format!("failed to read secure storage: {error}")))?;
    serde_json::from_str::<PersistedRemoteSecrets>(&payload).map_err(|error| {
        DaemonError::BadRequest(format!("invalid secure storage payload: {error}"))
    })
}

#[cfg(not(test))]
fn delete_remote_secrets_from_secure_storage(secure_storage_key: &str) -> Result<(), DaemonError> {
    let entry = keyring::Entry::new("com.falcondeck.daemon.remote", secure_storage_key)
        .map_err(|error| DaemonError::Process(format!("failed to open secure storage: {error}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(DaemonError::Process(format!(
            "failed to delete secure storage entry: {error}"
        ))),
    }
}

#[cfg(test)]
static TEST_REMOTE_SECRET_STORE: OnceLock<std::sync::Mutex<HashMap<String, String>>> =
    OnceLock::new();

#[cfg(test)]
fn test_remote_secret_store() -> &'static std::sync::Mutex<HashMap<String, String>> {
    TEST_REMOTE_SECRET_STORE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn save_remote_secrets_to_secure_storage(
    secure_storage_key: &str,
    secrets: &PersistedRemoteSecrets,
) -> Result<(), DaemonError> {
    let payload = serde_json::to_string(secrets)?;
    test_remote_secret_store()
        .lock()
        .unwrap()
        .insert(secure_storage_key.to_string(), payload);
    Ok(())
}

#[cfg(test)]
fn load_remote_secrets_from_secure_storage(
    secure_storage_key: &str,
) -> Result<PersistedRemoteSecrets, DaemonError> {
    let payload = test_remote_secret_store()
        .lock()
        .unwrap()
        .get(secure_storage_key)
        .cloned()
        .ok_or_else(|| {
            DaemonError::BadRequest("missing persisted relay secrets in secure storage".to_string())
        })?;
    serde_json::from_str::<PersistedRemoteSecrets>(&payload).map_err(|error| {
        DaemonError::BadRequest(format!("invalid secure storage payload: {error}"))
    })
}

#[cfg(test)]
fn delete_remote_secrets_from_secure_storage(secure_storage_key: &str) -> Result<(), DaemonError> {
    test_remote_secret_store()
        .lock()
        .unwrap()
        .remove(secure_storage_key);
    Ok(())
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

fn normalize_relay_url(input: &str) -> Result<String, DaemonError> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(DaemonError::BadRequest("relay_url is required".to_string()));
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(DaemonError::BadRequest(
            "relay_url must start with http:// or https://".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn interactive_request_counts(
    requests: &HashMap<(String, String), PendingServerRequest>,
    thread_id: &str,
) -> (u32, u32) {
    requests
        .values()
        .filter(|request| request.request.thread_id.as_deref() == Some(thread_id))
        .fold(
            (0_u32, 0_u32),
            |(approvals, questions), request| match request.request.kind {
                InteractiveRequestKind::Approval => (approvals + 1, questions),
                InteractiveRequestKind::Question => (approvals, questions + 1),
            },
        )
}

fn refresh_thread_attention(
    thread: &mut ThreadSummary,
    pending_approval_count: u32,
    pending_question_count: u32,
) {
    let unread = thread.attention.last_agent_activity_seq > thread.attention.last_read_seq;
    let level = if matches!(thread.status, ThreadStatus::Error) {
        ThreadAttentionLevel::Error
    } else if pending_approval_count + pending_question_count > 0 {
        ThreadAttentionLevel::AwaitingResponse
    } else if matches!(thread.status, ThreadStatus::Running) {
        ThreadAttentionLevel::Running
    } else if unread {
        ThreadAttentionLevel::Unread
    } else {
        ThreadAttentionLevel::None
    };

    thread.attention.level = level;
    thread.attention.badge_label = if pending_approval_count + pending_question_count > 0 {
        Some("Awaiting response".to_string())
    } else {
        None
    };
    thread.attention.unread = unread;
    thread.attention.pending_approval_count = pending_approval_count;
    thread.attention.pending_question_count = pending_question_count;
}

fn marks_agent_activity(item: &ConversationItem) -> bool {
    !matches!(item, ConversationItem::UserMessage { .. })
}

fn relay_ws_url(relay_url: &str, session_id: &str, ticket: &str) -> String {
    let base = if let Some(rest) = relay_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = relay_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        relay_url.to_string()
    };
    format!("{base}/v1/updates/ws?session_id={session_id}&ticket={ticket}")
}

fn relay_url_looks_legacy_loopback(relay_url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(relay_url) else {
        return false;
    };

    matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
}

fn host_label() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "FalconDeck desktop".to_string())
}

fn encrypt_remote_daemon_event(
    data_key: &[u8; 32],
    event: &EventEnvelope,
) -> Result<EncryptedEnvelope, String> {
    encrypt_json(
        data_key,
        &json!({
            "kind": "daemon-event",
            "event": event,
        }),
    )
    .map_err(|error| format!("failed to encrypt relay update: {error}"))
}

async fn send_relay_message(
    writer: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    message: &RelayClientMessage,
) -> Result<(), String> {
    let payload = serde_json::to_string(message)
        .map_err(|error| format!("failed to encode relay message: {error}"))?;
    writer
        .send(Message::Text(payload.into()))
        .await
        .map_err(|error| format!("failed to send relay message: {error}"))
}
