use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use chrono::{Duration as ChronoDuration, Utc};
use falcondeck_core::{
    AgentCapabilitySummary, AgentProvider, ApprovalDecision, CollaborationModeSummary,
    CommandResponse, ConnectWorkspaceRequest, ContentLifecycle, ConversationItem,
    DaemonCapabilities, DaemonInfo, DaemonSnapshot, EventEnvelope, ExtensionActionResponse,
    ExtensionSnapshot, ExtensionSummary, FalconDeckPreferences, ForkThreadRequest, HealthResponse,
    InteractiveRequest, InteractiveRequestKind, InteractiveResponsePayload,
    InvokeExtensionActionRequest, OperationalCondition, PairingPublicKeyBundle,
    RemoteConnectionStatus, SendTurnRequest, ServiceLevel, ServiceNotice, SkillSummary,
    SnapshotRequest, StartReviewRequest, StartThreadRequest, TextDeltaTarget, ThreadAgentParams,
    ThreadAttention, ThreadDetail, ThreadDetailRequest, ThreadHandle, ThreadPlan, ThreadStatus,
    ThreadSummary, ThreadTokenUsage, UnifiedEvent, UpdatePreferencesRequest,
    UpdateScheduledTaskRequest, UpdateThreadRequest, WorkspaceAgentSummary, WorkspaceStatus,
    WorkspaceSummary,
    control::{AgentControlSettings, ControlGetRequest, ControlSearchRequest, ControlStateChanged},
    crypto::LocalBoxKeyPair,
};
use serde_json::{Value, json};
use tokio::{
    sync::mpsc,
    sync::{Mutex, Notify, OnceCell, Semaphore, broadcast, oneshot},
    task::{JoinHandle, spawn_blocking},
    time::{Duration, timeout},
};
use tracing::debug;
use uuid::Uuid;

use crate::{
    agy::{AgyProviderMetadata, AgyRuntime},
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
mod extension_events;
mod extension_host;
mod extensions;
pub(crate) mod harness_manager;
pub(crate) mod host_provisioning;
mod notifications;
mod opencode_threads;
mod provider_runtime;
mod provider_usage;
mod remote_bridge;
mod remote_lifecycle;
mod runtime_health;
mod scheduled_tasks;
mod speech;
mod storage;
mod thread_search;
mod threads;
mod utility_model;
mod workspace_ops;

use agent_helpers::*;
use conversation_helpers::*;
use provider_runtime::*;
use remote_bridge::*;
use remote_lifecycle::*;
pub(crate) use speech::*;
use storage::*;
use threads::{interactive_request_counts, refresh_thread_attention};

const WORKSPACE_RESTORE_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_INTERRUPTED_TURN_ERROR: &str = "FalconDeck was closed while this turn was running";
const MAX_EXTENSION_THREAD_SUMMARIES: usize = 1_000;
const MAX_EXTENSION_THREAD_TITLE_CHARS: usize = 256;
const MAX_EXTENSION_THREAD_SUMMARY_BYTES: usize = 2 * 1024 * 1024;
/// Daemon-owned tool on the extensions MCP bridge. Not an extension: agents
/// in this conversation use it to rename the thread when the work has moved on.
const BUILTIN_RENAME_THREAD_TOOL: &str = "falcondeck_rename_thread";

/// How long `schedule_persist` waits before writing, so a burst of streamed
/// updates costs one state snapshot instead of one per chunk.
const PERSIST_COALESCE_WINDOW: Duration = Duration::from_millis(750);

#[derive(Clone)]
pub struct AppState {
    inner: Arc<InnerState>,
}

/// Keyed `(workspace_id, provider)` startup locks for ACP agent processes.
type AcpRuntimeGates = HashMap<(String, AgentProvider), Arc<Mutex<()>>>;

struct InnerState {
    daemon: DaemonInfo,
    /// Agent binary name or path per provider id. Providers absent from the map
    /// fall back to their id; see `AppState::provider_bin`.
    provider_bins: HashMap<AgentProvider, String>,
    state_path: PathBuf,
    preferences_path: PathBuf,
    scheduled_tasks_path: PathBuf,
    sequence: AtomicU64,
    broadcaster: broadcast::Sender<EventEnvelope>,
    workspaces: Mutex<HashMap<String, ManagedWorkspace>>,
    /// Per-workspace/provider gates prevent background metadata hydration and
    /// a first user turn from spawning competing ACP processes.
    acp_runtime_gates: Mutex<AcpRuntimeGates>,
    /// Process-tree pressure state and the global optional-runtime start cap.
    runtime_health: runtime_health::RuntimeHealth,
    saved_workspaces: Mutex<HashMap<String, PersistedWorkspaceState>>,
    /// Serializes full state snapshots so an older concurrent snapshot cannot
    /// overwrite newer remote pairing metadata.
    persistence: Mutex<()>,
    interactive_requests: Mutex<HashMap<(String, String), PendingServerRequest>>,
    /// Capped session-level notices for workspace events without a transcript target.
    service_notices: StdMutex<Vec<ServiceNotice>>,
    /// Current workspace degradation keyed by `(workspace_id, semantic_key)`.
    operational_conditions: StdMutex<HashMap<(String, String), OperationalCondition>>,
    /// Latest high-frequency token usage keyed by thread id.
    thread_token_usage: StdMutex<HashMap<String, ThreadTokenUsage>>,
    /// User-message excerpts per provider session, for content search.
    thread_search: StdMutex<thread_search::ThreadSearchIndex>,
    /// When the excerpt index last finished a scan of the session files.
    thread_search_scanned_at: StdMutex<Option<std::time::Instant>>,
    /// Serializes scans so concurrent searches trigger at most one walk.
    thread_search_scan: Mutex<()>,
    /// Active realtime transcript parts keyed by (thread id, provider role).
    realtime_transcripts: StdMutex<HashMap<(String, String), RealtimeTranscriptState>>,
    /// Pending Claude PreToolUse approvals keyed by (workspace_id, request_id);
    /// the hook handler blocks on the receiver until the UI responds.
    claude_approvals: Mutex<HashMap<(String, String), oneshot::Sender<ApprovalDecision>>>,
    /// Tools the user always-allowed for a thread, keyed by
    /// (workspace_id, thread_id).
    claude_always_allowed_tools: Mutex<HashMap<(String, String), HashSet<String>>>,
    /// Base HTTP URL the daemon is actually reachable on after binding.
    local_base_url: OnceLock<String>,
    /// Short-lived lease for a visible local desktop client. The lease is
    /// refreshed by the desktop heartbeat and expires automatically if the
    /// app crashes or is force-quit.
    desktop_active_until: StdMutex<Option<chrono::DateTime<Utc>>>,
    preferences: Mutex<FalconDeckPreferences>,
    /// Definitions and bounded run ledgers owned by this daemon.
    scheduled_tasks: Mutex<scheduled_tasks::ScheduledTaskRegistry>,
    /// Makes the lightweight task-store restore a readiness prerequisite and
    /// prevents the slower general restore from loading it over live edits.
    scheduled_tasks_restored: OnceCell<()>,
    scheduled_mutation: Mutex<()>,
    /// Wakes the single scheduler loop after definition changes.
    scheduled_notify: Notify,
    /// Prevents duplicate scheduler loops when restore/create race.
    scheduled_scheduler_started: AtomicBool,
    /// Global cap for unattended scheduled executions.
    scheduled_run_slots: Semaphore,
    /// Installed extension catalog, private state, and synchronized projections.
    extensions: Mutex<extensions::ExtensionRegistry>,
    /// Lazily started Deno sidecars, isolated and serialized per extension.
    extension_hosts: Mutex<extension_host::ExtensionHostPool>,
    /// Bounded, independent lifecycle-event queue for each enabled extension.
    extension_event_queues: extension_events::ExtensionEventQueues,
    /// Cached OpenRouter speech credential from the daemon secret store.
    speech_credentials: speech::SpeechCredentialCache,
    remote: Mutex<RemoteBridgeState>,
    /// Coalesces at-least-once relay delivery for mutating RPCs across bridge
    /// reconnects so an action cannot execute twice in one daemon process.
    remote_rpc_deduplicator: remote_bridge::RemoteRpcDeduplicator,
    /// SSH provisioning jobs keyed by job id. Progress lives only in memory:
    /// a job is meaningless across a daemon restart, since the background task
    /// driving it is gone.
    provision_jobs: Mutex<HashMap<String, host_provisioning::ProvisionJob>>,
    /// Harness (agent CLI) probe results keyed by host (`"local"` or an SSH
    /// target), with the probe time for TTL checks.
    harness_cache:
        StdMutex<HashMap<String, (std::time::Instant, falcondeck_core::HarnessesOverview)>>,
    /// Harness install/upgrade jobs keyed by job id. In-memory only, like
    /// provisioning jobs.
    harness_jobs: Mutex<HashMap<String, falcondeck_core::HarnessUpgradeJob>>,
    /// Set at the start of `shutdown` so respawn/reconnect paths cannot race
    /// the teardown with fresh agent processes.
    shutting_down: AtomicBool,
    /// True while a deferred `persist_local_state` is scheduled; lets bursts of
    /// small changes coalesce into one write. See `schedule_persist`.
    persist_pending: AtomicBool,
    /// Agent control service: settings, automations, runs and audit.
    control: crate::control::ControlService,
    /// Threads whose ACP transcript rehydration is currently in flight, keyed
    /// by (workspace_id, thread_id). The entry is removed when the attempt
    /// finishes so a later open can retry if the transcript is still empty.
    acp_hydrations_started: StdMutex<HashSet<(String, String)>>,
    /// Threads that already forced a second `session/load` this daemon run
    /// after a registered session had no transcript. One retry is enough to
    /// recover from a workspace rebuild wiping a replay; looping would respawn
    /// the agent on every open of a session that truly has nothing to replay.
    acp_hydration_reloads: StdMutex<HashSet<(String, String)>>,
    /// Threads with a background Codex goal refresh in flight, keyed by
    /// (workspace_id, thread_id). `thread.detail` triggers the refresh but
    /// returns without waiting on it; the set collapses concurrent opens of
    /// the same thread into one app-server round trip.
    codex_goal_refreshes_in_flight: StdMutex<HashSet<(String, String)>>,
}

struct ManagedWorkspace {
    summary: WorkspaceSummary,
    codex_session: Option<Arc<CodexSession>>,
    claude_runtime: Option<Arc<ClaudeRuntime>>,
    agy_runtime: Option<Arc<AgyRuntime>>,
    opencode_runtime: Option<Arc<crate::opencode::OpenCodeRuntime>>,
    /// Live ACP agent processes keyed by provider id, started lazily on use.
    acp_runtimes: HashMap<AgentProvider, Arc<crate::acp::AcpRuntime>>,
    threads: HashMap<String, ManagedThread>,
}

struct ManagedThread {
    summary: ThreadSummary,
    items: Vec<ConversationItem>,
    assistant_items: HashMap<String, usize>,
    reasoning_items: HashMap<String, usize>,
    plan_items: HashMap<String, usize>,
    tool_items: HashMap<String, usize>,
    manual_title: bool,
    ai_title_generated: bool,
    ai_title_in_flight: bool,
    /// Titler runs spent on this thread since the daemon started. Titling is
    /// now attempted as soon as a thread becomes eligible rather than once per
    /// turn, so a utility chain that is missing or unauthenticated would
    /// otherwise spawn a CLI for every item a long turn produces.
    ai_title_attempts: u8,
    /// The current title is only a provider-side preview of the opening prompt
    /// (Claude sessions without their own title, Codex previews). It reads like
    /// a real title, so the titler needs this flag to know it may replace it.
    title_is_provider_preview: bool,
    requires_resume: bool,
    /// Whether the daemon's transcript for a native OpenCode thread is known
    /// to match the agent's session storage. False after a restore (items are
    /// not persisted) and after a turn whose end-of-turn projection failed,
    /// because both leave a prefix that the `items.is_empty()`-only hydration
    /// guard would otherwise never repair.
    native_transcript_synced: bool,
    /// True only while a native OpenCode turn's monitor task is live, from
    /// admission to the terminal projection. `WaitingForInput` is set from
    /// inside that monitor, but the status is also persisted and restored
    /// verbatim after an ungraceful daemon death — so hydration eligibility
    /// must key off this flag, not the status, for waiting threads.
    opencode_turn_in_flight: bool,
    /// True once the user asked to interrupt the in-flight native OpenCode
    /// turn. OpenCode reports its own cancellation as a `step.failed`
    /// ("Provider turn interrupted"), which must settle as an interruption
    /// with the partial transcript kept, not as a failed turn.
    opencode_interrupt_requested: bool,
    /// Full requests behind `summary.queued_turns`, same order, matched by
    /// the summary entry's id. Persisted before an enqueue is acknowledged.
    queued_requests: Vec<QueuedTurnRequest>,
    /// Queue entry currently crossing the non-transactional provider boundary.
    /// It stays in persisted state until the provider accepts it, so a daemon
    /// crash can replay the message instead of silently dropping it.
    dispatching_request: Option<QueuedTurnRequest>,
    /// Retained idempotency key and prompt payload of the most recent native
    /// OpenCode steer whose admission outcome is unresolved. OpenCode resolves
    /// a reused message id to its stored admission and rejects a differing
    /// payload with a conflict, so the key is only reusable for identical
    /// input; it is cleared once an admission is confirmed.
    pending_opencode_steer: Option<(String, serde_json::Value)>,
}

#[derive(Clone)]
struct RealtimeTranscriptState {
    id: String,
    text: String,
    created_at: chrono::DateTime<Utc>,
}

/// A send accepted while the thread was busy, held until the active turn ends.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct QueuedTurnRequest {
    id: String,
    request: SendTurnRequest,
    summary: falcondeck_core::QueuedTurnSummary,
}

fn bound_extension_thread_summaries(
    mut summaries: Vec<falcondeck_core::ExtensionThreadSummary>,
) -> Vec<falcondeck_core::ExtensionThreadSummary> {
    for summary in &mut summaries {
        summary.title = summary
            .title
            .chars()
            .take(MAX_EXTENSION_THREAD_TITLE_CHARS)
            .collect();
    }
    summaries.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut encoded_bytes = 2usize;
    summaries
        .into_iter()
        .take(MAX_EXTENSION_THREAD_SUMMARIES)
        .take_while(|summary| {
            let item_bytes = serde_json::to_vec(summary)
                .map(|encoded| encoded.len().saturating_add(1))
                .unwrap_or(MAX_EXTENSION_THREAD_SUMMARY_BYTES);
            if encoded_bytes.saturating_add(item_bytes) > MAX_EXTENSION_THREAD_SUMMARY_BYTES {
                return false;
            }
            encoded_bytes = encoded_bytes.saturating_add(item_bytes);
            true
        })
        .collect()
}

fn builtin_rename_thread_tool() -> falcondeck_core::ExtensionAgentTool {
    falcondeck_core::ExtensionAgentTool {
        name: BUILTIN_RENAME_THREAD_TOOL.to_string(),
        extension_id: "falcondeck".to_string(),
        tool_id: "rename_thread".to_string(),
        title: "Rename thread".to_string(),
        description: "Rename this FalconDeck conversation in the sidebar. Call when the current title is stale because the work has evolved. Pass a 3-7 word title that names the concrete task now underway: no quotes, no trailing punctuation, no generic labels like Debugging. This applies the name immediately. Only this thread can be renamed.".to_string(),
        input_schema: json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false,
            "required": ["title"],
            "properties": {
                "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 80,
                    "description": "3-7 word thread title reflecting the current work."
                }
            }
        }),
    }
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
            .map(|config| {
                let mut capabilities = AgentCapabilitySummary::acp_minimal();
                let mut models = Vec::new();
                // Mirror post-handshake Grok override so paste is available
                // before the first connect refreshes the agent entry.
                capabilities.supports_images =
                    crate::acp::acp_supports_images(&config.id, capabilities.supports_images);
                if config.id.eq_ignore_ascii_case("grok") {
                    // Same idea as Claude's hardcoded catalog: Grok's ACP
                    // process takes long enough to start that a new-thread
                    // composer would otherwise sit on a greyed picker.
                    capabilities = crate::acp::grok_placeholder_capabilities();
                    models = crate::acp::grok_placeholder_models();
                }
                if config.id.eq_ignore_ascii_case("opencode")
                    && crate::app::opencode_threads::requested_native_transport(config)
                {
                    capabilities = crate::app::opencode_threads::native_capabilities();
                    models.push(crate::app::opencode_threads::native_default_model());
                }
                WorkspaceAgentSummary {
                    provider: AgentProvider::new(config.id.clone()),
                    label: config.label.clone(),
                    account: falcondeck_core::AccountSummary {
                        status: falcondeck_core::AccountStatus::Unknown,
                        label: format!("{} not started", config.label),
                    },
                    models,
                    collaboration_modes: Vec::new(),
                    skills: Vec::new(),
                    capabilities,
                }
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
    /// Persisted remote state that failed to resume (e.g. a transient
    /// secure-storage error at startup). Held so `persist_local_state` can
    /// round-trip it instead of writing `remote: null` — which would
    /// permanently destroy the pairing over a transient keychain failure.
    unresumed_remote: Option<Box<PersistedRemoteState>>,
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
    /// Workspace id reused across daemon restarts. Remote clients cache
    /// snapshots between connections; a restart that minted fresh ids made
    /// every cached workspace reference dangle ("workspace not found").
    #[serde(default)]
    id: Option<String>,
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
    provider_transport: Option<String>,
    #[serde(default)]
    handoff_from: Option<falcondeck_core::ThreadHandoffSource>,
    #[serde(default)]
    origin: Option<falcondeck_core::ThreadOrigin>,
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
    /// Model/effort/tier/mode selections on the thread. Provider hydration
    /// only restores the fields its own records carry, so these fill the gaps
    /// after a restart.
    #[serde(default)]
    agent: ThreadAgentParams,
    /// Accepted user messages which have not crossed the provider boundary.
    #[serde(default)]
    queued_requests: Vec<QueuedTurnRequest>,
    /// Goal attached to the thread. Codex re-fetches it from the session on
    /// demand; Claude has no goal record, so persistence is its only recall.
    #[serde(default)]
    goal: Option<falcondeck_core::ThreadGoal>,
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
        let deno_bin = std::env::var("FALCONDECK_DENO_BIN").unwrap_or_else(|_| "deno".to_string());
        Self::new_with_state_path_and_extension_runtime(
            version,
            provider_bins,
            state_path,
            deno_bin,
        )
    }

    pub fn new_with_state_path_and_extension_runtime(
        version: String,
        provider_bins: HashMap<AgentProvider, String>,
        state_path: PathBuf,
        deno_bin: String,
    ) -> Self {
        let (broadcaster, _) = broadcast::channel(2048);
        let preferences_path = default_preferences_path(&state_path);
        let scheduled_tasks_path = scheduled_tasks::scheduled_tasks_path(&state_path);
        let control_store = crate::control::store::control_store_path(&state_path);
        let extension_registry = extensions::ExtensionRegistry::new(&state_path);
        let extension_hosts = extension_host::ExtensionHostPool::new(state_path.clone(), deno_bin);
        Self {
            inner: Arc::new(InnerState {
                daemon: DaemonInfo {
                    version,
                    started_at: Utc::now(),
                    capabilities: DaemonCapabilities {
                        scheduled_tasks: true,
                    },
                },
                provider_bins,
                state_path,
                preferences_path,
                scheduled_tasks_path,
                sequence: AtomicU64::new(1),
                broadcaster,
                workspaces: Mutex::new(HashMap::new()),
                acp_runtime_gates: Mutex::new(HashMap::new()),
                runtime_health: runtime_health::RuntimeHealth::default(),
                saved_workspaces: Mutex::new(HashMap::new()),
                persistence: Mutex::new(()),
                interactive_requests: Mutex::new(HashMap::new()),
                service_notices: StdMutex::new(Vec::new()),
                operational_conditions: StdMutex::new(HashMap::new()),
                thread_token_usage: StdMutex::new(HashMap::new()),
                thread_search: StdMutex::new(thread_search::ThreadSearchIndex::default()),
                thread_search_scanned_at: StdMutex::new(None),
                thread_search_scan: Mutex::new(()),
                realtime_transcripts: StdMutex::new(HashMap::new()),
                claude_approvals: Mutex::new(HashMap::new()),
                claude_always_allowed_tools: Mutex::new(HashMap::new()),
                local_base_url: OnceLock::new(),
                desktop_active_until: StdMutex::new(None),
                preferences: Mutex::new(FalconDeckPreferences::default()),
                scheduled_tasks: Mutex::new(scheduled_tasks::ScheduledTaskRegistry::default()),
                scheduled_tasks_restored: OnceCell::new(),
                scheduled_mutation: Mutex::new(()),
                scheduled_notify: Notify::new(),
                scheduled_scheduler_started: AtomicBool::new(false),
                scheduled_run_slots: Semaphore::new(scheduled_tasks::MAX_CONCURRENT_RUNS),
                extensions: Mutex::new(extension_registry),
                extension_hosts: Mutex::new(extension_hosts),
                extension_event_queues: StdMutex::new(HashMap::new()),
                speech_credentials: speech::SpeechCredentialCache::default(),
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
                    unresumed_remote: None,
                }),
                remote_rpc_deduplicator: remote_bridge::RemoteRpcDeduplicator::default(),
                provision_jobs: Mutex::new(HashMap::new()),
                harness_cache: StdMutex::new(HashMap::new()),
                harness_jobs: Mutex::new(HashMap::new()),
                control: crate::control::ControlService::new(control_store),
                shutting_down: AtomicBool::new(false),
                persist_pending: AtomicBool::new(false),
                acp_hydrations_started: StdMutex::new(HashSet::new()),
                acp_hydration_reloads: StdMutex::new(HashSet::new()),
                codex_goal_refreshes_in_flight: StdMutex::new(HashSet::new()),
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

    /// The daemon-owned agent control service.
    pub fn control(&self) -> &crate::control::ControlService {
        &self.inner.control
    }

    /// Loads the agent control store. A degraded store (malformed or
    /// unsupported) surfaces as an operational condition instead of failing
    /// daemon startup; scheduling stays off until the file is repaired.
    pub async fn restore_control_state(&self) -> Result<(), DaemonError> {
        match self.inner.control.restore().await {
            Ok(None) => {
                self.clear_operational_condition("", "agent-control-store");
                Ok(())
            }
            Ok(Some(warning)) => {
                tracing::warn!(%warning, "agent control store degraded");
                self.upsert_operational_condition(
                    "".to_string(),
                    "agent-control-store",
                    ServiceLevel::Warning,
                    warning,
                    Some("agent-control".to_string()),
                )?;
                Ok(())
            }
            Err(error) => Err(DaemonError::BadRequest(error)),
        }
    }

    /// Emits one event on the unified stream from outside the app module.
    pub(crate) fn emit_event(
        &self,
        workspace_id: Option<String>,
        thread_id: Option<String>,
        event: UnifiedEvent,
    ) {
        self.emit(workspace_id, thread_id, event);
    }

    /// Emits the lightweight control state-change event after a mutation.
    pub fn emit_control_state_change(&self, change: ControlStateChanged) {
        self.emit(None, None, UnifiedEvent::ControlStateChanged { change });
    }

    /// Capability discovery through the control service.
    pub async fn control_search(
        &self,
        request: ControlSearchRequest,
        context: &falcondeck_core::control::ControlRequestContext,
    ) -> Result<falcondeck_core::control::ControlSearchResponse, crate::control::ControlError> {
        self.inner.control.search(request, context).await
    }

    /// Control reads through the control service.
    pub async fn control_get(
        &self,
        request: ControlGetRequest,
        context: &falcondeck_core::control::ControlRequestContext,
    ) -> Result<falcondeck_core::control::ControlGetResponse, crate::control::ControlError> {
        self.inner.control.get(request, context).await
    }

    /// Computes the built-in FalconDeck control connector for one provider
    /// spawn, or `None` when agent control is disabled globally or for the
    /// provider. Evaluated at every spawn boundary so setting changes apply
    /// on the next turn (Claude) or next process start (Codex, ACP).
    pub async fn builtin_control_spec(
        &self,
        provider: &AgentProvider,
        workspace_path: &str,
        thread_id: Option<&str>,
    ) -> Option<crate::connectors::BuiltinControlSpec> {
        let settings = self.inner.control.settings_snapshot().await;
        self.inner
            .control
            .ensure_mcp_enabled(&settings, Some(provider))
            .ok()?;
        Some(crate::connectors::BuiltinControlSpec {
            daemon_url: self.local_base_url()?,
            provider: provider.to_string(),
            workspace_path: workspace_path.to_string(),
            thread_id: thread_id.map(str::to_string),
        })
    }

    /// Computes every built-in connector for one provider spawn. Evaluated
    /// at each spawn boundary, so enabling or disabling agent control or an
    /// extension applies on the next turn (Claude) or next process start
    /// (Codex, ACP).
    pub async fn builtin_connectors(
        &self,
        provider: &AgentProvider,
        workspace_path: &str,
        thread_id: Option<&str>,
    ) -> crate::connectors::BuiltinConnectors {
        crate::connectors::BuiltinConnectors {
            control: self
                .builtin_control_spec(provider, workspace_path, thread_id)
                .await,
            extensions: self
                .builtin_extensions_spec(workspace_path, thread_id)
                .await,
        }
    }

    /// The extensions MCP bridge for one spawn, or `None` when no enabled
    /// extension currently publishes a granted tool. Skipping the connector
    /// entirely avoids spawning a bridge that could only report an empty
    /// catalogue.
    async fn builtin_extensions_spec(
        &self,
        workspace_path: &str,
        thread_id: Option<&str>,
    ) -> Option<crate::connectors::BuiltinExtensionsSpec> {
        if self.inner.extensions.lock().await.agent_tools().is_empty() {
            return None;
        }
        Some(crate::connectors::BuiltinExtensionsSpec {
            daemon_url: self.local_base_url()?,
            workspace_path: workspace_path.to_string(),
            thread_id: thread_id.map(str::to_string),
        })
    }

    /// Whether the FalconDeck agent context (short instruction append plus
    /// bundled control skill) is enabled for this provider right now.
    /// Evaluated at every spawn boundary alongside
    /// [`Self::builtin_control_spec`] so setting changes apply on the next
    /// turn (Claude) or next process start (Codex, ACP).
    async fn agent_context_enabled(
        &self,
        provider: &AgentProvider,
    ) -> Option<AgentControlSettings> {
        let settings = self.inner.control.settings_snapshot().await;
        self.inner
            .control
            .ensure_mcp_enabled(&settings, Some(provider))
            .ok()?;
        if !settings.inject_agent_context {
            return None;
        }
        Some(settings)
    }

    /// The short always-on instruction append for one provider spawn, or
    /// `None` when agent context injection is disabled.
    pub async fn agent_context_instructions(&self, provider: &AgentProvider) -> Option<String> {
        self.agent_context_enabled(provider).await?;
        let staged = crate::agent_context::stage_skill(&self.inner.state_path);
        if let Err(error) = &staged {
            tracing::warn!(%error, "failed to stage falcondeck-control skill");
        }
        Some(crate::agent_context::append_instructions(
            staged.as_deref().ok(),
        ))
    }

    /// Root directory of staged bundled skills, for providers that accept
    /// skill directories natively (Codex `skills/extraRoots`).
    pub async fn agent_skill_root(&self, provider: &AgentProvider) -> Option<std::path::PathBuf> {
        self.agent_context_enabled(provider).await?;
        match crate::agent_context::stage_skill(&self.inner.state_path) {
            Ok(_) => Some(crate::agent_context::skills_root(&self.inner.state_path)),
            Err(error) => {
                tracing::warn!(%error, "failed to stage falcondeck-control skill");
                None
            }
        }
    }

    /// Resolves the connected workspace whose canonical path matches, or
    /// connects the path through the normal flow. Automation definitions
    /// store canonical paths, never runtime workspace ids.
    pub async fn resolve_or_connect_workspace_path(
        &self,
        workspace_path: &str,
    ) -> Result<WorkspaceSummary, DaemonError> {
        let canonical = std::path::PathBuf::from(workspace_path)
            .canonicalize()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| workspace_path.to_string());
        let existing = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .values()
                .find(|workspace| workspace.summary.path == canonical)
                .map(|workspace| workspace.summary.clone())
        };
        if let Some(summary) = existing {
            return Ok(summary);
        }
        self.connect_workspace(ConnectWorkspaceRequest {
            path: workspace_path.to_string(),
        })
        .await
    }

    /// Executes one control operation and broadcasts the resulting
    /// state-change event.
    pub async fn control_execute(
        &self,
        request: falcondeck_core::control::ControlExecuteRequest,
        context: &falcondeck_core::control::ControlRequestContext,
    ) -> falcondeck_core::control::ControlExecuteResponse {
        let deps = crate::control::ControlDeps { app: Some(self) };
        let (response, event) = self.inner.control.execute(request, context, &deps).await;
        if let Some(change) = event {
            self.emit_control_state_change(change);
        }
        response
    }

    /// Whether a provider id can run on this daemon: a configured binary or
    /// a discovered ACP provider.
    pub async fn is_known_provider(&self, provider: &AgentProvider) -> bool {
        if self.inner.provider_bins.contains_key(provider) {
            return true;
        }
        crate::acp::known_provider_ids(&self.inner.state_path).contains(&provider.to_string())
    }

    pub async fn restore_local_state(&self) -> Result<(), DaemonError> {
        self.inner.extensions.lock().await.restore().await?;
        self.sync_extension_event_workers().await;
        let preferences = load_preferences(&self.inner.preferences_path).await?;
        {
            let mut current = self.inner.preferences.lock().await;
            *current = preferences.clone();
        }
        persist_preferences(&self.inner.preferences_path, &preferences).await?;

        let persisted = load_persisted_app_state(&self.inner.state_path).await?;
        // Attention seqs are stamped from this counter but persist across
        // restarts, so a counter that restarts at 1 makes cross-boot values
        // incomparable: a mark-read written with a small this-boot seq can
        // never catch an activity seq from the previous boot (the thread reads
        // as unread forever), and new activity in an already-read thread never
        // climbs past its old stamp (the thread never reads as unread again).
        // Seed the counter past everything ever persisted so both eras compare.
        let max_persisted_seq = persisted
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.thread_states.iter())
            .map(|thread| thread.last_read_seq.max(thread.last_agent_activity_seq))
            .max()
            .unwrap_or(0);
        self.inner
            .sequence
            .fetch_max(max_persisted_seq.saturating_add(1), Ordering::Relaxed);
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
            } else if let Err(error) = self.resume_remote_bridge(remote.clone()).await {
                tracing::warn!("failed to restore remote bridge: {error}");
                // Keep the un-resumed pairing so persistence round-trips it;
                // otherwise the next persist_local_state writes remote: null
                // and a transient keychain error destroys the pairing.
                let mut current = self.inner.remote.lock().await;
                if current.pairing.is_none() {
                    current.unresumed_remote = Some(Box::new(remote));
                    current.status = RemoteConnectionStatus::Error;
                    current.last_error = Some(format!("failed to restore remote pairing: {error}"));
                }
            } else if should_migrate_secure_storage {
                self.persist_local_state().await?;
            }
        }

        // Restore the remote bridge before reconnecting workspaces. Workspace
        // reconnects can persist state; starting them first could race with
        // remote restoration and overwrite a valid pairing with `remote: null`.
        self.restore_scheduled_tasks().await?;
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
                // A restored task may be immediately due. Wait until every
                // persisted workspace has either reconnected or settled into
                // a visible disconnected state before dispatching it.
                scheduled_tasks::start_scheduler(&app);
            });
        } else {
            scheduled_tasks::start_scheduler(self);
        }
        Ok(())
    }

    pub(crate) async fn restore_scheduled_tasks(&self) -> Result<(), DaemonError> {
        self.inner
            .scheduled_tasks_restored
            .get_or_try_init(|| async { scheduled_tasks::restore(self).await })
            .await
            .map(|_| ())
    }

    async fn restore_workspace_placeholder(
        &self,
        persisted_workspace: &PersistedWorkspaceState,
        status: WorkspaceStatus,
        last_error: Option<String>,
    ) -> Result<WorkspaceSummary, DaemonError> {
        let path_string = normalize_workspace_path(&persisted_workspace.path);
        let now = Utc::now();
        let acp_agents = self.acp_agent_summaries();
        let mut workspaces = self.inner.workspaces.lock().await;
        // Reuse the persisted id (or an already-registered entry's id) so
        // paired devices holding a pre-restart snapshot keep addressing this
        // workspace; a fresh uuid is a migration/collision fallback only.
        let workspace_id = workspaces
            .values()
            .find(|workspace| workspace.summary.path == path_string)
            .map(|workspace| workspace.summary.id.clone())
            .or_else(|| {
                persisted_workspace
                    .id
                    .clone()
                    .filter(|id| !id.is_empty() && !workspaces.contains_key(id))
            })
            .unwrap_or_else(|| format!("workspace-{}", Uuid::new_v4().simple()));
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
                    .then(|| SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string())
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
                provider_transport: state.provider_transport.clone(),
                handoff_from: state.handoff_from.clone(),
                origin: state.origin.clone(),
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
                goal: state.goal.clone(),
                queued_turns: Vec::new(),
                variant: state.variant.clone(),
            };
            let mut thread = ManagedThread::new(summary);
            thread.manual_title = state.manual_title;
            thread.ai_title_generated = state.ai_title_generated
                || (!is_placeholder_thread_title(&thread.summary.title)
                    && !is_provisional_thread_title(&thread.summary.title));
            // Preview-vs-real can't be told apart from persisted state alone;
            // connecting the workspace re-reads the session file and sets
            // `title_is_provider_preview` properly.
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
                    WorkspaceAgentSummary {
                        provider: AgentProvider::AGY,
                        label: "Antigravity".to_string(),
                        account: falcondeck_core::AccountSummary {
                            status: falcondeck_core::AccountStatus::Unknown,
                            label: "Antigravity reconnecting".to_string(),
                        },
                        models: Vec::new(),
                        collaboration_modes: Vec::new(),
                        skills: Vec::new(),
                        capabilities: AgentCapabilitySummary::agy(),
                    },
                ];
                agents.extend(acp_agents);
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
                agy_runtime: None,
                opencode_runtime: None,
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
            workspace.summary.status = status.clone();
            workspace.summary.last_error = last_error.clone();
            for thread in workspace.threads.values_mut() {
                if status == WorkspaceStatus::Disconnected
                    && thread.summary.status == ThreadStatus::Running
                {
                    thread.summary.status = ThreadStatus::Error;
                    thread.summary.last_error = Some(SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string());
                }
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

    pub(crate) async fn fail_active_provider_threads(
        &self,
        workspace_id: &str,
        provider: &AgentProvider,
        error: &str,
    ) {
        let now = Utc::now();
        let changed = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get_mut(workspace_id) else {
                return;
            };
            workspace
                .threads
                .values_mut()
                .filter_map(|thread| {
                    (thread.summary.provider == *provider
                        && matches!(
                            thread.summary.status,
                            ThreadStatus::Running | ThreadStatus::WaitingForInput
                        ))
                    .then(|| {
                        thread.summary.status = ThreadStatus::Error;
                        thread.summary.last_error = Some(error.to_string());
                        thread.summary.updated_at = now;
                        thread.summary.clone()
                    })
                })
                .collect::<Vec<_>>()
        };

        for thread in &changed {
            self.settle_turn_items_with_error(
                workspace_id,
                &thread.id,
                now,
                ToolSettlement::Failed,
                Some(error),
            )
            .await;
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread.id.clone()),
                UnifiedEvent::ThreadUpdated {
                    thread: thread.clone(),
                },
            );
        }
        if !changed.is_empty() {
            let _ = self.persist_local_state().await;
        }
    }

    pub async fn shutdown(&self) -> Result<(), DaemonError> {
        // Flag first: reconnect/respawn paths check this before spawning new
        // agent processes, so nothing new starts while we tear down.
        self.inner.shutting_down.store(true, Ordering::Release);
        self.inner.scheduled_notify.notify_waiters();
        scheduled_tasks::interrupt_active_runs(self).await?;
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
                        workspace.agy_runtime.clone(),
                        workspace.opencode_runtime.clone(),
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

        for (
            workspace_id,
            _path,
            codex_session,
            claude_runtime,
            agy_runtime,
            opencode_runtime,
            threads,
        ) in snapshots
        {
            if let Some(runtime) = claude_runtime {
                let _ = runtime.shutdown().await;
            }
            if let Some(runtime) = agy_runtime {
                let _ = runtime.shutdown().await;
            }
            if let Some(session) = codex_session {
                let _ = session.shutdown().await;
            }
            if let Some(runtime) = opencode_runtime {
                runtime.shutdown().await;
            }
            for (thread_id, was_running) in threads {
                if !was_running {
                    continue;
                }
                let _ = self
                    .with_thread_mut(&workspace_id, &thread_id, |thread| {
                        thread.status = ThreadStatus::Error;
                        thread.last_error = Some(SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string());
                        thread.updated_at = Utc::now();
                    })
                    .await;
            }
        }

        self.stop_extension_event_workers();
        let extension_hosts = self.inner.extension_hosts.lock().await.drain();
        for host in extension_hosts {
            host.lock().await.stop().await;
        }
        self.persist_local_state().await
    }

    /// How long an excerpt index is trusted before a search triggers another
    /// scan. Unchanged files are skipped by mtime, so a rescan is cheap.
    const THREAD_SEARCH_TTL: Duration = Duration::from_secs(60);

    /// Loads the persisted excerpt index and kicks off a first scan, so the
    /// first search after launch has content to match against.
    pub fn start_thread_search_index(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let path = thread_search::index_path(&state.inner.state_path);
            if let Ok(contents) = tokio::fs::read_to_string(&path).await
                && let Ok(index) =
                    serde_json::from_str::<thread_search::ThreadSearchIndex>(&contents)
            {
                *state
                    .inner
                    .thread_search
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = index;
            }
            state.refresh_thread_search_index(true).await;
        });
    }

    /// Rescans provider session files into the excerpt index. With `wait` the
    /// caller is blocked until the scan lands; otherwise it runs detached.
    async fn refresh_thread_search_index(&self, wait: bool) {
        let state = self.clone();
        let scan = async move {
            let _guard = state.inner.thread_search_scan.lock().await;
            // Another task may have refreshed while this one queued.
            if state.thread_search_index_is_fresh() {
                return;
            }
            let previous = state
                .inner
                .thread_search
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let Ok(index) = spawn_blocking(move || thread_search::rescan(&previous)).await else {
                return;
            };

            let path = thread_search::index_path(&state.inner.state_path);
            if let Ok(serialized) = serde_json::to_string(&index) {
                if let Err(error) = tokio::fs::write(&path, serialized).await {
                    // A missing cache only costs one rescan next launch.
                    tracing::debug!("could not persist thread search index: {error}");
                }
            }
            *state
                .inner
                .thread_search
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = index;
            *state
                .inner
                .thread_search_scanned_at
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(std::time::Instant::now());
        };
        if wait {
            scan.await;
        } else {
            tokio::spawn(scan);
        }
    }

    fn thread_search_index_is_fresh(&self) -> bool {
        self.inner
            .thread_search_scanned_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some_and(|scanned| scanned.elapsed() < Self::THREAD_SEARCH_TTL)
    }

    /// Keyword search across the indexed user messages of every known thread.
    pub async fn search_thread_messages(
        &self,
        request: falcondeck_core::ThreadMessageSearchRequest,
    ) -> falcondeck_core::ThreadMessageSearchResponse {
        // The first search after launch waits for the scan; later ones answer
        // from the current index and refresh behind the response.
        let indexed_before = self.thread_search_index_is_fresh();
        if !indexed_before {
            self.refresh_thread_search_index(true).await;
        }

        let threads = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .values()
                .filter(|workspace| {
                    request
                        .workspace_id
                        .as_ref()
                        .is_none_or(|workspace_id| workspace_id == &workspace.summary.id)
                })
                .flat_map(|workspace| {
                    workspace.threads.values().filter_map(|thread| {
                        Some(thread_search::SearchableThread {
                            thread_id: thread.summary.id.clone(),
                            workspace_id: thread.summary.workspace_id.clone(),
                            session_id: thread.summary.native_session_id.clone()?,
                        })
                    })
                })
                .collect::<Vec<_>>()
        };

        let index = self
            .inner
            .thread_search
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let limit = request.limit.unwrap_or(thread_search::MAX_MATCHES);
        let matches = thread_search::search(&index, &threads, &request.query, limit);
        let indexed_threads = threads
            .iter()
            .filter(|thread| index.sessions.contains_key(&thread.session_id))
            .count();

        if indexed_before && !self.thread_search_index_is_fresh() {
            self.refresh_thread_search_index(false).await;
        }

        falcondeck_core::ThreadMessageSearchResponse {
            matches,
            indexed_threads,
            indexing: false,
        }
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
        let extensions = self.inner.extensions.lock().await.snapshot();
        let scheduled_tasks = self.inner.scheduled_tasks.lock().await.summaries();
        let service_notices = self
            .inner
            .service_notices
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let mut operational_conditions = self
            .inner
            .operational_conditions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        operational_conditions.sort_by_key(|condition| condition.updated_at);
        let thread_token_usage = self
            .inner
            .thread_token_usage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(thread_id, usage)| (thread_id.clone(), usage.clone()))
            .collect();

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
                        || agent.provider == AgentProvider::AGY
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
            service_notices,
            operational_conditions,
            thread_token_usage,
            preferences,
            extensions,
            scheduled_tasks,
        }
    }

    /// Returns the installed extension catalog and synchronized view state.
    pub async fn extension_snapshot(&self) -> ExtensionSnapshot {
        self.inner.extensions.lock().await.snapshot()
    }

    async fn extension_thread_summaries(&self) -> Vec<falcondeck_core::ExtensionThreadSummary> {
        let workspaces = self.inner.workspaces.lock().await;
        let summaries = workspaces
            .values()
            .flat_map(|workspace| workspace.threads.values())
            .map(|thread| falcondeck_core::ExtensionThreadSummary {
                id: thread.summary.id.clone(),
                workspace_id: thread.summary.workspace_id.clone(),
                title: thread.summary.title.clone(),
                status: thread.summary.status.clone(),
                updated_at: thread.summary.updated_at,
                pending_approval_count: thread.summary.attention.pending_approval_count,
                pending_question_count: thread.summary.attention.pending_question_count,
            })
            .collect::<Vec<_>>();
        bound_extension_thread_summaries(summaries)
    }

    /// Enables or disables one installed extension without deleting its data.
    pub async fn update_extension(
        &self,
        extension_id: &str,
        enabled: bool,
    ) -> Result<ExtensionSummary, DaemonError> {
        if !self
            .inner
            .extensions
            .lock()
            .await
            .contains_extension(extension_id)
        {
            return Err(DaemonError::NotFound("extension not found".to_string()));
        }
        // Share the per-extension action gate so disable cannot interleave
        // with an action's storage read, host call, and commit.
        let host = self.inner.extension_hosts.lock().await.host(extension_id);
        let mut host = host.lock().await;
        let updated = self
            .inner
            .extensions
            .lock()
            .await
            .update_enabled(extension_id, enabled)
            .await?;
        if !enabled {
            host.stop().await;
        }
        drop(host);
        if !enabled {
            self.inner.extension_hosts.lock().await.remove(extension_id);
        }
        self.sync_extension_event_workers().await;
        let (catalog, retained_views) = {
            let extensions = self.inner.extensions.lock().await;
            (
                extensions.snapshot().catalog,
                extensions.retained_views(extension_id),
            )
        };
        self.emit(
            None,
            None,
            UnifiedEvent::ExtensionCatalogUpdated { catalog },
        );
        // Clients only receive active views in snapshots. Remove retained views
        // when disabling and replay them when enabling so every connected client
        // observes the same projection without deleting extension-owned data.
        for view in retained_views {
            self.emit(
                None,
                view.scope
                    .as_ref()
                    .filter(|scope| scope.kind == "thread")
                    .map(|scope| scope.id.clone()),
                UnifiedEvent::ExtensionViewUpdated {
                    extension_id: view.extension_id.clone(),
                    view_id: view.view_id.clone(),
                    scope: view.scope.clone(),
                    view: enabled.then_some(view),
                },
            );
        }
        Ok(updated)
    }

    /// Grants or revokes one manifest-declared permission under the same
    /// per-extension gate used by callbacks, so revocation cannot race an
    /// in-flight read or commit.
    pub async fn update_extension_permission(
        &self,
        extension_id: &str,
        permission: &str,
        granted: bool,
    ) -> Result<ExtensionSummary, DaemonError> {
        if !self
            .inner
            .extensions
            .lock()
            .await
            .contains_extension(extension_id)
        {
            return Err(DaemonError::NotFound("extension not found".to_string()));
        }
        let host = self.inner.extension_hosts.lock().await.host(extension_id);
        let _host = host.lock().await;
        let (updated, revoked_views) = {
            let mut extensions = self.inner.extensions.lock().await;
            let revoked_views =
                if !granted && extensions.permission_granted(extension_id, permission) {
                    extensions.retained_views(extension_id)
                } else {
                    Vec::new()
                };
            let updated = extensions
                .update_permission(extension_id, permission, granted)
                .await?;
            (updated, revoked_views)
        };
        let catalog = self.inner.extensions.lock().await.snapshot().catalog;
        self.emit(
            None,
            None,
            UnifiedEvent::ExtensionCatalogUpdated { catalog },
        );
        for view in revoked_views {
            self.emit(
                None,
                view.scope
                    .as_ref()
                    .filter(|scope| scope.kind == "thread")
                    .map(|scope| scope.id.clone()),
                UnifiedEvent::ExtensionViewUpdated {
                    extension_id: view.extension_id,
                    view_id: view.view_id,
                    scope: view.scope,
                    view: None,
                },
            );
        }
        Ok(updated)
    }

    /// Invokes a manifest-declared action through the isolated extension host.
    pub async fn invoke_extension_action(
        &self,
        extension_id: &str,
        action_id: &str,
        request: InvokeExtensionActionRequest,
    ) -> Result<ExtensionActionResponse, DaemonError> {
        extensions::ExtensionRegistry::validate_action_input(&request.input)?;
        extensions::ExtensionRegistry::validate_action_target(request.target.as_ref())?;
        if !self
            .inner
            .extensions
            .lock()
            .await
            .contains_extension(extension_id)
        {
            return Err(DaemonError::NotFound("extension not found".to_string()));
        }
        // Each extension host serializes its own code. Keep the same guard across the
        // storage read and commit so concurrent clients cannot both derive
        // updates from one stale snapshot and overwrite each other.
        let host = self.inner.extension_hosts.lock().await.host(extension_id);
        let mut host = host.lock().await;
        let (package, storage, can_read_threads) = {
            let registry = self.inner.extensions.lock().await;
            (
                registry.package(extension_id, action_id)?,
                registry.storage(extension_id),
                registry.has_grant(extension_id, extensions::THREADS_READ_PERMISSION),
            )
        };
        let thread_summaries = if can_read_threads {
            Some(self.extension_thread_summaries().await)
        } else {
            None
        };
        let host_result = host
            .invoke(
                &package,
                action_id,
                request.target.as_ref(),
                &request.input,
                &storage,
                thread_summaries.as_deref(),
            )
            .await;
        let host_result = match host_result {
            Ok(result) => result,
            Err(error) => {
                self.inner
                    .extensions
                    .lock()
                    .await
                    .mark_error(extension_id, &error.to_string())
                    .await?;
                let catalog = self.inner.extensions.lock().await.snapshot().catalog;
                self.emit(
                    None,
                    None,
                    UnifiedEvent::ExtensionCatalogUpdated { catalog },
                );
                drop(host);
                return Err(error);
            }
        };
        let updated_views = self
            .inner
            .extensions
            .lock()
            .await
            .commit_action(
                extension_id,
                host_result.storage,
                host_result.published_views,
            )
            .await?;
        drop(host);
        self.emit_extension_view_updates(&updated_views);
        Ok(ExtensionActionResponse {
            result: host_result.result,
            updated_views,
        })
    }

    /// The agent tools the `falcondeck-extensions` MCP bridge may publish
    /// right now. Recomputed per request so a disable or revoke is reflected
    /// the next time a harness lists tools. Includes the daemon-owned rename
    /// tool so an agent can retitle this conversation without an extension.
    pub async fn extension_agent_tools(&self) -> falcondeck_core::ExtensionAgentToolList {
        let mut tools = vec![builtin_rename_thread_tool()];
        tools.extend(self.inner.extensions.lock().await.agent_tools());
        tools.sort_by(|left, right| left.name.cmp(&right.name));
        falcondeck_core::ExtensionAgentToolList { tools }
    }

    /// Routes one MCP bridge tool call to its extension host.
    ///
    /// Enablement and the `agent-tools:register` grant are re-checked here,
    /// so a call from a harness that cached a stale tool list fails
    /// immediately instead of running disabled extension code.
    pub async fn invoke_extension_tool(
        &self,
        request: falcondeck_core::InvokeExtensionToolRequest,
    ) -> Result<falcondeck_core::ExtensionToolResponse, DaemonError> {
        if serde_json::to_vec(&request.arguments)?.len() > extensions::MAX_TOOL_ARGUMENT_BYTES {
            return Err(DaemonError::BadRequest(format!(
                "extension tool arguments exceed {} bytes",
                extensions::MAX_TOOL_ARGUMENT_BYTES
            )));
        }
        if request.name == BUILTIN_RENAME_THREAD_TOOL {
            return self.invoke_builtin_rename_thread_tool(request).await;
        }
        let (package, tool_id) = self
            .inner
            .extensions
            .lock()
            .await
            .tool_package(&request.name)?;
        // Harnesses report a thread id and a filesystem path; extensions only
        // ever see stable identifiers, so resolve one here.
        let workspace_id = self
            .extension_call_workspace_id(
                request.thread_id.as_deref(),
                request.workspace_path.as_deref(),
            )
            .await;
        let host = self.inner.extension_hosts.lock().await.host(&package.id);
        let mut host = host.lock().await;
        let (storage, can_read_threads) = {
            let registry = self.inner.extensions.lock().await;
            // Re-check under the host gate: disable cannot interleave here.
            registry.tool_package(&request.name)?;
            (
                registry.storage(&package.id),
                registry.has_grant(&package.id, extensions::THREADS_READ_PERMISSION),
            )
        };
        let thread_summaries = if can_read_threads {
            Some(self.extension_thread_summaries().await)
        } else {
            None
        };
        let host_result = host
            .invoke_tool(
                &package,
                &tool_id,
                &request.arguments,
                request.thread_id.as_deref(),
                workspace_id.as_deref(),
                &storage,
                thread_summaries.as_deref(),
            )
            .await;
        let host_result = match host_result {
            Ok(result) => result,
            // A model passing arguments the extension rejects is ordinary
            // traffic. Hand the message back to the agent without marking the
            // extension broken in Settings.
            Err(extension_host::ExtensionToolError::Rejected(message)) => {
                drop(host);
                return Err(DaemonError::BadRequest(message));
            }
            Err(extension_host::ExtensionToolError::Failed(error)) => {
                self.inner
                    .extensions
                    .lock()
                    .await
                    .mark_error(&package.id, &error.to_string())
                    .await?;
                let catalog = self.inner.extensions.lock().await.snapshot().catalog;
                self.emit(
                    None,
                    None,
                    UnifiedEvent::ExtensionCatalogUpdated { catalog },
                );
                drop(host);
                return Err(error);
            }
        };
        let updated_views = self
            .inner
            .extensions
            .lock()
            .await
            .commit_action(
                &package.id,
                host_result.storage,
                host_result.published_views,
            )
            .await?;
        drop(host);
        self.emit_extension_view_updates(&updated_views);
        Ok(falcondeck_core::ExtensionToolResponse {
            result: host_result.result,
        })
    }

    async fn invoke_builtin_rename_thread_tool(
        &self,
        request: falcondeck_core::InvokeExtensionToolRequest,
    ) -> Result<falcondeck_core::ExtensionToolResponse, DaemonError> {
        let Some(thread_id) = request
            .thread_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            return Err(DaemonError::BadRequest(
                "this turn is not attached to a thread, so nothing was renamed".to_string(),
            ));
        };
        let title = request
            .arguments
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .ok_or_else(|| DaemonError::BadRequest("title is required".to_string()))?;
        let workspace_id = self
            .extension_call_workspace_id(Some(thread_id), request.workspace_path.as_deref())
            .await
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let handle = self
            .update_thread(UpdateThreadRequest {
                workspace_id,
                thread_id: thread_id.to_string(),
                title: Some(title.to_string()),
                provider: None,
                model_id: None,
                reasoning_effort: None,
                collaboration_mode_id: None,
                service_tier: None,
                pinned: None,
                acknowledge_interruption: None,
                permission_mode: None,
                approval_policy: None,
                sandbox_mode: None,
            })
            .await?;
        Ok(falcondeck_core::ExtensionToolResponse {
            result: json!({
                "renamed": true,
                "title": handle.thread.title,
            }),
        })
    }

    /// Retires a thread's composer suggestions because a new turn is
    /// starting. Called from the one provider-independent turn-start path, so
    /// offers from a finished turn never reappear beside newer work.
    pub(crate) async fn retire_composer_suggestions(&self, thread_id: &str) {
        let retired = self
            .inner
            .extensions
            .lock()
            .await
            .retire_composer_suggestions(thread_id)
            .await;
        let retired = match retired {
            Ok(retired) => retired,
            Err(error) => {
                tracing::warn!(%error, %thread_id, "failed to retire composer suggestions");
                return;
            }
        };
        for view in retired {
            self.emit(
                None,
                Some(thread_id.to_string()),
                UnifiedEvent::ExtensionViewUpdated {
                    extension_id: view.extension_id,
                    view_id: view.view_id,
                    scope: view.scope,
                    // No view: clients drop the projection outright rather
                    // than rendering an empty offer set.
                    view: None,
                },
            );
        }
    }

    /// Resolves the workspace id for one agent tool call, preferring the
    /// thread the turn belongs to and falling back to the spawn's path.
    async fn extension_call_workspace_id(
        &self,
        thread_id: Option<&str>,
        workspace_path: Option<&str>,
    ) -> Option<String> {
        let workspaces = self.inner.workspaces.lock().await;
        if let Some(thread_id) = thread_id
            && let Some(workspace) = workspaces
                .values()
                .find(|workspace| workspace.threads.contains_key(thread_id))
        {
            return Some(workspace.summary.id.clone());
        }
        let workspace_path = workspace_path?;
        let canonical = std::path::PathBuf::from(workspace_path)
            .canonicalize()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| workspace_path.to_string());
        workspaces
            .values()
            .find(|workspace| workspace.summary.path == canonical)
            .map(|workspace| workspace.summary.id.clone())
    }

    /// Broadcasts changed projections so every connected client re-renders.
    fn emit_extension_view_updates(&self, views: &[falcondeck_core::ExtensionView]) {
        for view in views {
            self.emit(
                None,
                view.scope
                    .as_ref()
                    .filter(|scope| scope.kind == "thread")
                    .map(|scope| scope.id.clone()),
                UnifiedEvent::ExtensionViewUpdated {
                    extension_id: view.extension_id.clone(),
                    view_id: view.view_id.clone(),
                    scope: view.scope.clone(),
                    view: Some(view.clone()),
                },
            );
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
        snapshot.extensions.views.retain(|view| {
            view.scope.as_ref().is_none_or(|scope| {
                scope.kind != "thread" || visible_thread_ids.contains(&scope.id)
            })
        });
        snapshot
    }

    pub async fn preferences(&self) -> FalconDeckPreferences {
        self.inner.preferences.lock().await.clone()
    }

    pub fn set_desktop_activity(&self, active: bool) {
        let mut lease = self
            .inner
            .desktop_active_until
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *lease = active.then(|| Utc::now() + ChronoDuration::seconds(45));
    }

    pub fn desktop_is_active(&self) -> bool {
        let now = Utc::now();
        let mut lease = self
            .inner
            .desktop_active_until
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if lease.is_some_and(|expires_at| expires_at <= now) {
            *lease = None;
        }
        lease.is_some()
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

    pub async fn fork_thread(
        &self,
        request: ForkThreadRequest,
    ) -> Result<ThreadHandle, DaemonError> {
        workspace_ops::fork_thread(self, request).await
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

    pub async fn scheduled_tasks(&self) -> Vec<falcondeck_core::ScheduledTaskSummary> {
        scheduled_tasks::list(self).await
    }

    pub async fn scheduled_task(
        &self,
        task_id: &str,
    ) -> Result<falcondeck_core::ScheduledTaskDetail, DaemonError> {
        scheduled_tasks::detail(self, task_id).await
    }

    pub async fn create_scheduled_task(
        &self,
        request: falcondeck_core::CreateScheduledTaskRequest,
    ) -> Result<falcondeck_core::ScheduledTaskDetail, DaemonError> {
        scheduled_tasks::create(self, request).await
    }

    pub async fn update_scheduled_task(
        &self,
        task_id: &str,
        request: UpdateScheduledTaskRequest,
    ) -> Result<falcondeck_core::ScheduledTaskDetail, DaemonError> {
        scheduled_tasks::update(self, task_id, request).await
    }

    pub async fn delete_scheduled_task(
        &self,
        task_id: &str,
    ) -> Result<CommandResponse, DaemonError> {
        scheduled_tasks::delete(self, task_id).await
    }

    pub async fn run_scheduled_task(
        &self,
        task_id: &str,
    ) -> Result<falcondeck_core::ScheduledTaskRunSummary, DaemonError> {
        scheduled_tasks::run_now(self, task_id).await
    }

    pub async fn scheduled_task_runs(
        &self,
        task_id: &str,
    ) -> Result<Vec<falcondeck_core::ScheduledTaskRunSummary>, DaemonError> {
        scheduled_tasks::runs(self, task_id).await
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

    pub async fn mark_thread_unread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        workspace_ops::mark_thread_unread(self, workspace_id, thread_id).await
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
                    provider_transport: thread.summary.provider_transport.clone(),
                    handoff_from: thread.summary.handoff_from.clone(),
                    origin: thread.summary.origin.clone(),
                    title: Some(thread.summary.title.clone()),
                    manual_title: thread.manual_title,
                    ai_title_generated: thread.ai_title_generated,
                    status: Some(
                        if workspace.summary.status == WorkspaceStatus::Disconnected
                            && thread.summary.status == ThreadStatus::Running
                        {
                            ThreadStatus::Error
                        } else {
                            thread.summary.status.clone()
                        },
                    ),
                    last_error: if workspace.summary.status == WorkspaceStatus::Disconnected
                        && thread.summary.status == ThreadStatus::Running
                    {
                        Some(SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string())
                    } else {
                        thread.summary.last_error.clone()
                    },
                    last_read_seq: thread.summary.attention.last_read_seq,
                    last_agent_activity_seq: thread.summary.attention.last_agent_activity_seq,
                    variant: thread.summary.variant.clone(),
                    agent: thread.summary.agent.clone(),
                    goal: thread.summary.goal.clone(),
                    queued_requests: thread
                        .dispatching_request
                        .iter()
                        .chain(thread.queued_requests.iter())
                        .cloned()
                        .collect(),
                })
                .collect::<Vec<_>>();
            thread_states.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
            persisted_workspaces.insert(
                normalized_path.clone(),
                PersistedWorkspaceState {
                    path: normalized_path,
                    id: Some(workspace.summary.id.clone()),
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
        let unresumed_remote = remote.unresumed_remote.clone();
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
            // A pairing that failed to resume still round-trips as-is (its
            // secret-store entry on disk is untouched) so a transient
            // secure-storage error cannot erase it.
            None => (unresumed_remote.map(|remote| *remote), None),
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

    /// Adds a durable diagnostic to one conversation, awaiting the transcript
    /// push instead of spawning it. Callers that follow a diagnostic with a
    /// terminal status change must use this: the spawned variant re-reads the
    /// thread summary after its own await point, so its `ThreadUpdated` can
    /// carry a stale `Running` status and land *after* the caller's `Idle`
    /// one — stranding the thread as a permanent spinner in every client.
    pub async fn push_conversation_diagnostic(
        &self,
        workspace_id: &str,
        thread_id: &str,
        level: ServiceLevel,
        message: String,
        raw_method: Option<String>,
    ) {
        let _ = self
            .push_conversation_item(
                workspace_id,
                thread_id,
                ConversationItem::Service {
                    id: format!("service-{}", Uuid::new_v4().simple()),
                    level: level.clone(),
                    message: message.clone(),
                    created_at: Utc::now(),
                },
                false,
            )
            .await;
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::Service {
                level,
                message,
                raw_method,
                notice: None,
            },
        );
    }

    /// Adds a durable diagnostic to one conversation. This path must not be
    /// used for workspace or application health.
    pub fn emit_conversation_diagnostic(
        &self,
        workspace_id: String,
        thread_id: String,
        level: ServiceLevel,
        message: String,
        raw_method: Option<String>,
    ) -> Result<(), DaemonError> {
        let app = self.clone();
        let event_workspace_id = workspace_id.clone();
        let event_thread_id = thread_id.clone();
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
        self.emit(
            Some(event_workspace_id),
            Some(event_thread_id),
            UnifiedEvent::Service {
                level,
                message,
                raw_method,
                notice: None,
            },
        );
        Ok(())
    }

    /// Creates or replaces one active workspace condition. Reusing `key`
    /// preserves identity, so repeated failures cannot turn into a banner log.
    pub fn upsert_operational_condition(
        &self,
        workspace_id: String,
        key: impl Into<String>,
        level: ServiceLevel,
        message: String,
        source: Option<String>,
    ) -> Result<(), DaemonError> {
        let key = key.into();
        let now = Utc::now();
        let condition = {
            let mut conditions = self
                .inner
                .operational_conditions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let map_key = (workspace_id.clone(), key.clone());
            let existing = conditions.get(&map_key);
            let created_at = existing.map_or(now, |condition| condition.created_at);
            let updated_at = existing
                .filter(|condition| {
                    condition.level == level
                        && condition.message == message
                        && condition.source == source
                })
                .map_or(now, |condition| condition.updated_at);
            let id = existing.map_or_else(
                || format!("condition-{}", Uuid::new_v4().simple()),
                |condition| condition.id.clone(),
            );
            let condition = OperationalCondition {
                id,
                key,
                workspace_id: workspace_id.clone(),
                level: level.clone(),
                message: message.clone(),
                source: source.clone(),
                created_at,
                updated_at,
            };
            conditions.insert(map_key, condition.clone());
            condition
        };

        // Keep the legacy snapshot/event projection until older paired clients
        // no longer depend on `service_notices`.
        let legacy_notice = ServiceNotice {
            id: condition.id.clone(),
            workspace_id: workspace_id.clone(),
            level: level.clone(),
            message: message.clone(),
            raw_method: source.clone(),
            created_at: condition.created_at,
        };
        {
            let mut notices = self
                .inner
                .service_notices
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            notices.retain(|notice| notice.id != legacy_notice.id);
            notices.push(legacy_notice.clone());
            if notices.len() > 32 {
                let excess = notices.len() - 32;
                notices.drain(0..excess);
            }
        }

        self.emit(
            Some(workspace_id.clone()),
            None,
            UnifiedEvent::OperationalConditionUpserted {
                condition: condition.clone(),
            },
        );
        self.emit(
            Some(workspace_id),
            None,
            UnifiedEvent::Service {
                level,
                message,
                raw_method: source,
                notice: Some(legacy_notice),
            },
        );
        Ok(())
    }

    /// Clears a recovered workspace condition. Unknown keys are a no-op.
    pub fn clear_operational_condition(&self, workspace_id: &str, key: &str) {
        let removed = self
            .inner
            .operational_conditions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&(workspace_id.to_string(), key.to_string()));
        let Some(condition) = removed else {
            return;
        };
        self.inner
            .service_notices
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|notice| notice.id != condition.id);
        self.emit(
            Some(workspace_id.to_string()),
            None,
            UnifiedEvent::OperationalConditionCleared {
                key: key.to_string(),
                condition_id: condition.id,
            },
        );
    }

    fn emit(&self, workspace_id: Option<String>, thread_id: Option<String>, event: UnifiedEvent) {
        let extension_event = extension_events::lifecycle_event(
            workspace_id.as_deref(),
            thread_id.as_deref(),
            &event,
        );
        let envelope = EventEnvelope {
            seq: self.inner.sequence.fetch_add(1, Ordering::Relaxed),
            emitted_at: Utc::now(),
            workspace_id,
            thread_id,
            event,
        };
        let _ = self.inner.broadcaster.send(envelope);
        if let Some(event) = extension_event {
            self.enqueue_extension_event(event);
        }
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

    pub async fn git_commit(
        &self,
        request: &falcondeck_core::GitCommitRequest,
    ) -> Result<falcondeck_core::GitCommitResponse, DaemonError> {
        let (checkout, title) = self
            .isolated_checkout(&request.workspace_id, &request.thread_id)
            .await?;
        let message = request
            .message
            .as_deref()
            .filter(|message| !message.trim().is_empty())
            .unwrap_or(&title);
        crate::ship::commit_checkout(&checkout, message).await
    }

    pub async fn ship_thread(
        &self,
        request: &falcondeck_core::ShipThreadRequest,
    ) -> Result<falcondeck_core::ShipThreadResponse, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(&request.thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let variant = thread.summary.variant.clone().ok_or_else(|| {
            DaemonError::BadRequest(
                "only isolated threads can be merged or opened as a pull request".to_string(),
            )
        })?;
        let title = thread.summary.title.clone();
        let project_path = workspace.summary.path.clone();
        drop(workspaces);
        crate::ship::ship_variant(&project_path, &variant, &title, request.mode).await
    }

    async fn isolated_checkout(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<(String, String), DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        if thread.summary.variant.is_none() {
            return Err(DaemonError::BadRequest(
                "only isolated threads can be committed from this control".to_string(),
            ));
        }
        Ok((
            thread
                .summary
                .working_directory(&workspace.summary.path)
                .to_string(),
            thread.summary.title.clone(),
        ))
    }

    pub async fn workspace_files(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
    ) -> Result<falcondeck_core::WorkspaceFilesResponse, DaemonError> {
        crate::workspace_files::list_files(&self.git_root(workspace_id, thread_id).await?).await
    }

    pub async fn workspace_file(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
        path: &str,
    ) -> Result<falcondeck_core::WorkspaceFileResponse, DaemonError> {
        crate::workspace_files::read_file(&self.git_root(workspace_id, thread_id).await?, path)
            .await
    }

    pub async fn write_workspace_file(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
        path: &str,
        request: &falcondeck_core::WriteWorkspaceFileRequest,
    ) -> Result<falcondeck_core::WorkspaceFileResponse, DaemonError> {
        crate::workspace_files::write_file(
            &self.git_root(workspace_id, thread_id).await?,
            path,
            request,
        )
        .await
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

impl IntoWorkspaceAgentUpdate for AgyProviderMetadata {
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
            collaboration_modes: Vec::new(),
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
