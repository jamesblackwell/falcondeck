use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use chrono::Utc;
use falcondeck_core::{
    AgentCapabilitySummary, AgentProvider, ApprovalDecision, CollaborationModeSummary,
    CommandResponse, ConnectWorkspaceRequest, ConversationItem, DaemonInfo, DaemonSnapshot,
    EventEnvelope, FalconDeckPreferences, HealthResponse, InteractiveRequest,
    InteractiveRequestKind, InteractiveResponsePayload, PairingPublicKeyBundle,
    RemoteConnectionStatus, SendTurnRequest, ServiceLevel, SkillSummary, SnapshotRequest,
    StartReviewRequest, StartThreadRequest, ThreadAgentParams, ThreadAttention, ThreadDetail,
    ThreadDetailRequest, ThreadHandle, ThreadStatus, ThreadSummary, UnifiedEvent,
    UpdatePreferencesRequest, UpdateThreadRequest, WorkspaceAgentSummary, WorkspaceStatus,
    WorkspaceSummary, crypto::LocalBoxKeyPair,
};
use serde_json::{Value, json};
use tokio::{
    sync::mpsc,
    sync::{Mutex, broadcast, oneshot},
    task::JoinHandle,
    time::{Duration, timeout},
};
use tracing::debug;
use uuid::Uuid;

use crate::{
    claude::{ClaudeBootstrap, ClaudeProviderMetadata, ClaudeRuntime},
    codex::{
        CodexBootstrap, CodexProviderMetadata, CodexSession, extract_string, extract_thread_id,
        extract_thread_title, parse_account, parse_thread_goal, parse_thread_plan,
    },
    error::DaemonError,
    skills::{
        discover_file_backed_skills, merge_skills, parse_codex_provider_skills, skills_for_provider,
    },
};

mod acp_threads;
pub(crate) mod agent_helpers;
pub(crate) mod conversation_helpers;
pub(crate) mod host_provisioning;
mod notifications;
mod provider_runtime;
mod remote_bridge;
mod remote_lifecycle;
mod storage;
mod threads;
mod workspace_ops;

use agent_helpers::*;
use conversation_helpers::*;
use provider_runtime::*;
use remote_bridge::*;
use remote_lifecycle::*;
use storage::*;
use threads::{interactive_request_counts, refresh_thread_attention};

const WORKSPACE_RESTORE_TIMEOUT: Duration = Duration::from_secs(30);

/// How long `schedule_persist` waits before writing, so a burst of streamed
/// updates costs one state snapshot instead of one per chunk.
const PERSIST_COALESCE_WINDOW: Duration = Duration::from_millis(750);

#[derive(Clone)]
pub struct AppState {
    inner: Arc<InnerState>,
}

struct InnerState {
    daemon: DaemonInfo,
    /// Agent binary name or path per provider id. Providers absent from the map
    /// fall back to their id; see `AppState::provider_bin`.
    provider_bins: HashMap<AgentProvider, String>,
    state_path: PathBuf,
    preferences_path: PathBuf,
    sequence: AtomicU64,
    broadcaster: broadcast::Sender<EventEnvelope>,
    workspaces: Mutex<HashMap<String, ManagedWorkspace>>,
    saved_workspaces: Mutex<HashMap<String, PersistedWorkspaceState>>,
    /// Serializes full state snapshots so an older concurrent snapshot cannot
    /// overwrite newer remote pairing metadata.
    persistence: Mutex<()>,
    interactive_requests: Mutex<HashMap<(String, String), PendingServerRequest>>,
    /// Pending Claude PreToolUse approvals keyed by (workspace_id, request_id);
    /// the hook handler blocks on the receiver until the UI responds.
    claude_approvals: Mutex<HashMap<(String, String), oneshot::Sender<ApprovalDecision>>>,
    /// Tools the user always-allowed for a thread, keyed by
    /// (workspace_id, thread_id).
    claude_always_allowed_tools: Mutex<HashMap<(String, String), HashSet<String>>>,
    /// Base HTTP URL the daemon is actually reachable on after binding.
    local_base_url: OnceLock<String>,
    preferences: Mutex<FalconDeckPreferences>,
    remote: Mutex<RemoteBridgeState>,
    /// SSH provisioning jobs keyed by job id. Progress lives only in memory:
    /// a job is meaningless across a daemon restart, since the background task
    /// driving it is gone.
    provision_jobs: Mutex<HashMap<String, host_provisioning::ProvisionJob>>,
    /// Set at the start of `shutdown` so respawn/reconnect paths cannot race
    /// the teardown with fresh agent processes.
    shutting_down: AtomicBool,
    /// True while a deferred `persist_local_state` is scheduled; lets bursts of
    /// small changes coalesce into one write. See `schedule_persist`.
    persist_pending: AtomicBool,
}

struct ManagedWorkspace {
    summary: WorkspaceSummary,
    codex_session: Option<Arc<CodexSession>>,
    claude_runtime: Option<Arc<ClaudeRuntime>>,
    /// Live ACP agent processes keyed by provider id; spawned lazily.
    acp_runtimes: HashMap<AgentProvider, Arc<crate::acp::AcpRuntime>>,
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
    /// Full requests behind `summary.queued_turns`, same order, matched by
    /// the summary entry's id. In-memory only: a queued turn does not survive
    /// a daemon restart (neither does the turn it was waiting on).
    queued_requests: Vec<QueuedTurnRequest>,
}

/// A send accepted while the thread was busy, held until the active turn ends.
#[derive(Clone)]
struct QueuedTurnRequest {
    id: String,
    request: SendTurnRequest,
}

impl AppState {
    /// Directory holding daemon-owned config files (providers.json,
    /// connectors.json, daemon-state.json).
    pub(crate) fn state_dir(&self) -> Option<std::path::PathBuf> {
        self.inner
            .state_path
            .parent()
            .map(std::path::Path::to_path_buf)
    }

    /// Workspace agent entries for every configured ACP provider. Accounts
    /// start Unknown and flip to Ready after the first successful handshake.
    pub(crate) fn acp_agent_summaries(&self) -> Vec<WorkspaceAgentSummary> {
        // Fresh read so providers added to providers.json appear without a
        // daemon restart; live runtimes refine these entries after connect.
        self.fresh_acp_provider_configs()
            .iter()
            .map(|config| WorkspaceAgentSummary {
                provider: AgentProvider::new(config.id.clone()),
                label: config.label.clone(),
                account: falcondeck_core::AccountSummary {
                    status: falcondeck_core::AccountStatus::Unknown,
                    label: format!("{} not started", config.label),
                },
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                skills: Vec::new(),
                capabilities: AgentCapabilitySummary::acp_minimal(),
            })
            .collect()
    }
}

/// Display label for built-in providers; ACP providers carry their configured
/// label on the workspace agent entry instead.
fn provider_label(provider: &AgentProvider) -> String {
    ProviderRuntime::for_provider(provider).label()
}

#[derive(Clone)]
struct PendingServerRequest {
    raw_id: Value,
    request: InteractiveRequest,
    /// Raw JSON-RPC params of the originating request. Needed at response
    /// time: permissions approvals echo the requested profile back as the
    /// grant, which the normalized `InteractiveRequest` does not carry.
    params: Value,
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
    /// Client bundles that completed a pairing claim on this daemon. The
    /// ephemeral request-bootstrap path only serves the data key to bundles in
    /// this list, so a compromised relay cannot mint its own bundle and be
    /// handed the key.
    trusted_client_bundles: Vec<PairingPublicKeyBundle>,
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
    pinned_thread_ids: Vec<String>,
    #[serde(default)]
    thread_states: Vec<PersistedThreadState>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct PersistedThreadState {
    thread_id: String,
    #[serde(default)]
    updated_at: Option<chrono::DateTime<Utc>>,
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
    /// Isolated checkout backing the thread. Persisted so a daemon restart
    /// keeps running the thread in its own directory — and still knows what to
    /// clean up when the thread is deleted.
    #[serde(default)]
    variant: Option<falcondeck_core::ThreadVariant>,
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
    #[serde(default)]
    trusted_client_bundles: Vec<PairingPublicKeyBundle>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedRemoteSecrets {
    local_secret_key_base64: String,
    data_key_base64: String,
}

#[derive(Debug, Clone)]
enum RemoteBridgeCommand {
    PublishBootstrap {
        // Boxed to keep the enum small; NotifyAttention is sent far more often.
        pairing: Box<RemotePairingState>,
        client_bundle: Box<PairingPublicKeyBundle>,
    },
    /// Ask the relay to push a generic attention notification to trusted
    /// devices that are not currently connected.
    NotifyAttention {
        kind: String,
        workspace_id: Option<String>,
        thread_id: Option<String>,
    },
}

impl AppState {
    pub fn new(version: String, provider_bins: HashMap<AgentProvider, String>) -> Self {
        Self::new_with_state_path(version, provider_bins, default_state_path())
    }

    pub fn new_with_state_path(
        version: String,
        provider_bins: HashMap<AgentProvider, String>,
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
                provider_bins,
                state_path,
                preferences_path,
                sequence: AtomicU64::new(1),
                broadcaster,
                workspaces: Mutex::new(HashMap::new()),
                saved_workspaces: Mutex::new(HashMap::new()),
                persistence: Mutex::new(()),
                interactive_requests: Mutex::new(HashMap::new()),
                claude_approvals: Mutex::new(HashMap::new()),
                claude_always_allowed_tools: Mutex::new(HashMap::new()),
                local_base_url: OnceLock::new(),
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
                    trusted_client_bundles: Vec::new(),
                }),
                provision_jobs: Mutex::new(HashMap::new()),
                shutting_down: AtomicBool::new(false),
                persist_pending: AtomicBool::new(false),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.inner.broadcaster.subscribe()
    }

    pub fn set_local_base_url(&self, url: String) {
        let _ = self.inner.local_base_url.set(url);
    }

    pub fn local_base_url(&self) -> Option<String> {
        self.inner.local_base_url.get().cloned()
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

        // Restore the remote bridge before reconnecting workspaces. Workspace
        // reconnects can persist state; starting them first could race with
        // remote restoration and overwrite a valid pairing with `remote: null`.
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
                provider: state.provider.clone().unwrap_or(AgentProvider::CODEX),
                native_session_id: state.native_session_id.clone(),
                status,
                updated_at: state
                    .updated_at
                    .or(persisted_workspace.updated_at)
                    .unwrap_or(now),
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
                is_pinned: persisted_workspace
                    .pinned_thread_ids
                    .contains(&state.thread_id),
                goal: None,
                queued_turns: Vec::new(),
                variant: state.variant.clone(),
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
            agents: {
                let mut agents = vec![
                    WorkspaceAgentSummary {
                        provider: AgentProvider::CODEX,
                        label: "Codex".to_string(),
                        account: falcondeck_core::AccountSummary {
                            status: falcondeck_core::AccountStatus::Unknown,
                            label: "Codex reconnecting".to_string(),
                        },
                        models: Vec::new(),
                        collaboration_modes: Vec::new(),
                        skills: Vec::new(),
                        capabilities: AgentCapabilitySummary::codex(),
                    },
                    WorkspaceAgentSummary {
                        provider: AgentProvider::CLAUDE,
                        label: "Claude".to_string(),
                        account: falcondeck_core::AccountSummary {
                            status: falcondeck_core::AccountStatus::Unknown,
                            label: "Claude reconnecting".to_string(),
                        },
                        models: Vec::new(),
                        collaboration_modes: Vec::new(),
                        skills: Vec::new(),
                        capabilities: AgentCapabilitySummary::claude(),
                    },
                ];
                agents.extend(self.acp_agent_summaries());
                agents
            },
            skills: Vec::new(),
            default_provider: persisted_workspace
                .default_provider
                .clone()
                .unwrap_or(AgentProvider::CODEX),
            models: Vec::new(),
            collaboration_modes: Vec::new(),
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
                acp_runtimes: HashMap::new(),
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

    pub(crate) fn is_shutting_down(&self) -> bool {
        self.inner.shutting_down.load(Ordering::Acquire)
    }

    /// Counts local threads whose current turns have not reached a terminal state.
    pub async fn active_thread_count(&self) -> usize {
        self.inner
            .workspaces
            .lock()
            .await
            .values()
            .flat_map(|workspace| workspace.threads.values())
            .filter(|thread| {
                matches!(
                    thread.summary.status,
                    ThreadStatus::Running | ThreadStatus::WaitingForInput
                )
            })
            .count()
    }

    pub async fn shutdown(&self) -> Result<(), DaemonError> {
        // Flag first: reconnect/respawn paths check this before spawning new
        // agent processes, so nothing new starts while we tear down.
        self.inner.shutting_down.store(true, Ordering::Release);
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
                                    matches!(
                                        thread.summary.status,
                                        ThreadStatus::Running | ThreadStatus::WaitingForInput
                                    ),
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

    pub async fn snapshot(&self) -> DaemonSnapshot {
        // Reading providers.json resolves each configured binary, and a
        // missing binary falls through to a blocking login-shell probe —
        // never do that while holding the global workspaces lock, which
        // would stall every approval and turn behind each snapshot.
        let fresh_acp_agents = self.acp_agent_summaries();
        let fresh_acp_ids = fresh_acp_agents
            .iter()
            .map(|agent| agent.provider.clone())
            .collect::<std::collections::HashSet<_>>();

        let workspaces = self.inner.workspaces.lock().await;
        let interactive_requests = self.inner.interactive_requests.lock().await;
        let preferences = self.inner.preferences.lock().await.clone();

        // Reconcile providers.json edits onto each workspace's agent list:
        // additions appear (placeholder entries; live runtimes refine the
        // stored copy), and removed ACP providers disappear unless their
        // runtime is still alive — an already-spawned agent keeps serving its
        // threads until restart.
        let mut workspace_list = workspaces
            .values()
            .map(|workspace| {
                let mut summary = workspace.summary.clone();
                summary.agents.retain(|agent| {
                    agent.provider == AgentProvider::CODEX
                        || agent.provider == AgentProvider::CLAUDE
                        || fresh_acp_ids.contains(&agent.provider)
                        || workspace
                            .acp_runtimes
                            .get(&agent.provider)
                            .is_some_and(|runtime| !runtime.is_closed())
                });
                for agent in &fresh_acp_agents {
                    if !summary
                        .agents
                        .iter()
                        .any(|existing| existing.provider == agent.provider)
                    {
                        summary.agents.push(agent.clone());
                    }
                }
                summary
            })
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
        threads.sort_by_key(|thread| std::cmp::Reverse(thread.updated_at));

        let mut interactive_request_list = interactive_requests
            .values()
            .map(|request| request.request.clone())
            .collect::<Vec<_>>();
        interactive_request_list.sort_by_key(|request| std::cmp::Reverse(request.created_at));

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

    pub async fn remove_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<falcondeck_core::CommandResponse, DaemonError> {
        workspace_ops::remove_workspace(self, workspace_id).await
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

    pub async fn delete_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<CommandResponse, DaemonError> {
        workspace_ops::delete_thread(self, workspace_id, thread_id).await?;
        Ok(CommandResponse {
            ok: true,
            message: Some("thread deleted".to_string()),
        })
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

    pub async fn set_thread_goal(
        &self,
        request: falcondeck_core::SetThreadGoalRequest,
    ) -> Result<ThreadSummary, DaemonError> {
        workspace_ops::set_thread_goal(self, request).await
    }

    pub async fn clear_thread_goal(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        workspace_ops::clear_thread_goal(self, workspace_id, thread_id).await
    }

    pub async fn mark_thread_read(
        &self,
        workspace_id: &str,
        thread_id: &str,
        read_seq: u64,
    ) -> Result<ThreadSummary, DaemonError> {
        workspace_ops::mark_thread_read(self, workspace_id, thread_id, read_seq).await
    }

    /// Persists soon, coalescing bursts into one write. Streaming a turn
    /// touches thread state on every chunk; snapshotting and fsyncing the full
    /// state file each time starves the turn monitors, so the agent's stdout
    /// pipe fills and the CLI itself stalls. Anything that changes state at
    /// stream frequency must use this instead of `persist_local_state`; the
    /// window only defers the write, `shutdown`'s final persist still runs
    /// after it.
    pub(crate) fn schedule_persist(&self) {
        if self.inner.persist_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(PERSIST_COALESCE_WINDOW).await;
            app.inner.persist_pending.store(false, Ordering::Release);
            if let Err(error) = app.persist_local_state().await {
                tracing::warn!(%error, "deferred state persist failed");
            }
        });
    }

    async fn persist_local_state(&self) -> Result<(), DaemonError> {
        let _persistence_guard = self.inner.persistence.lock().await;
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
            let pinned_thread_ids = workspace
                .threads
                .values()
                .filter(|thread| thread.summary.is_pinned)
                .map(|thread| thread.summary.id.clone())
                .collect();
            let mut thread_states = workspace
                .threads
                .values()
                .map(|thread| PersistedThreadState {
                    thread_id: thread.summary.id.clone(),
                    updated_at: Some(thread.summary.updated_at),
                    provider: Some(thread.summary.provider.clone()),
                    native_session_id: thread.summary.native_session_id.clone(),
                    title: Some(thread.summary.title.clone()),
                    manual_title: thread.manual_title,
                    ai_title_generated: thread.ai_title_generated,
                    status: Some(thread.summary.status.clone()),
                    last_error: thread.summary.last_error.clone(),
                    last_read_seq: thread.summary.attention.last_read_seq,
                    last_agent_activity_seq: thread.summary.attention.last_agent_activity_seq,
                    variant: thread.summary.variant.clone(),
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
                    pinned_thread_ids,
                    thread_states,
                },
            );
        }
        let mut persisted_workspaces = persisted_workspaces.into_values().collect::<Vec<_>>();
        persisted_workspaces.sort_by(|left, right| left.path.cmp(&right.path));
        persisted_workspaces.dedup_by(|left, right| left.path == right.path);
        drop(workspaces);

        let remote = self.inner.remote.lock().await;
        let persisted_remote = persisted_remote_state(&remote)?;
        drop(remote);

        let (persisted_remote, remote_secret_write) = match persisted_remote {
            Some((persisted_remote, secrets)) => {
                let secure_storage_key =
                    persisted_remote.secure_storage_key.clone().ok_or_else(|| {
                        DaemonError::Process(
                            "persisted remote state is missing its secure storage key".to_string(),
                        )
                    })?;
                (Some(persisted_remote), Some((secure_storage_key, secrets)))
            }
            None => (None, None),
        };
        let persisted = PersistedAppState {
            workspaces: persisted_workspaces,
            remote: persisted_remote,
        };

        if let Some((secure_storage_key, secrets)) = remote_secret_write {
            save_remote_secrets_async(secure_storage_key, secrets).await?;
        }

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

    pub async fn handle_claude_pre_tool_use(&self, payload: Value) -> Value {
        notifications::handle_claude_pre_tool_use(self, payload).await
    }

    /// Fire-and-forget recovery for a Codex app-server that exited without a
    /// shutdown request. Backs off between attempts; see `run_codex_reconnect`.
    pub(crate) fn schedule_codex_reconnect(&self, workspace_id: String) {
        if self.is_shutting_down() {
            return;
        }
        let app = self.clone();
        tokio::spawn(async move {
            workspace_ops::run_codex_reconnect(&app, &workspace_id).await;
        });
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
        thread_id: Option<&str>,
    ) -> Result<falcondeck_core::GitStatusResponse, DaemonError> {
        crate::git::git_status(&self.git_root(workspace_id, thread_id).await?).await
    }

    // Branch listing and switching act on the project folder only: an isolated
    // thread's checkout is fixed at creation, so there is no thread variant.
    pub async fn git_branches(
        &self,
        workspace_id: &str,
    ) -> Result<falcondeck_core::GitBranchesResponse, DaemonError> {
        crate::git::git_branches(&self.git_root(workspace_id, None).await?).await
    }

    pub async fn git_checkout(
        &self,
        workspace_id: &str,
        branch: &str,
        create: bool,
    ) -> Result<falcondeck_core::GitBranchesResponse, DaemonError> {
        crate::git::git_checkout(&self.git_root(workspace_id, None).await?, branch, create).await
    }

    pub async fn git_diff(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
        path: Option<&str>,
        status: Option<&falcondeck_core::GitFileStatus>,
    ) -> Result<falcondeck_core::GitDiffResponse, DaemonError> {
        crate::git::git_diff(&self.git_root(workspace_id, thread_id).await?, path, status).await
    }

    /// Directory git status and diffs are read from: an isolated thread's own
    /// checkout, otherwise the workspace folder. An unknown thread id falls
    /// back to the workspace rather than failing — clients ask about threads
    /// the daemon may have already dropped.
    async fn git_root(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
    ) -> Result<String, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        Ok(thread_id
            .and_then(|thread_id| workspace.threads.get(thread_id))
            .map(|thread| thread.summary.working_directory(&workspace.summary.path))
            .unwrap_or(&workspace.summary.path)
            .to_string())
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
            label: provider_label(&provider),
            provider,
            account: self.account,
            models: self.models,
            collaboration_modes: self.collaboration_modes,
            skills,
            capabilities: AgentCapabilitySummary::codex(),
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
            label: provider_label(&provider),
            provider,
            account: self.account,
            models: self.models,
            collaboration_modes: self.collaboration_modes,
            skills,
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
    if !bytes.len().is_multiple_of(4) {
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
