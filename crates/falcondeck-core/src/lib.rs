//! Shared `FalconDeck` protocol types.
//!
//! This crate defines the daemon, relay, and client payloads that are exchanged
//! across the local daemon API, relay replay stream, and remote pairing flows.
//! It also exports the cryptography helpers used by the pairing protocol.
#![deny(missing_docs)]

/// Cryptography helpers for pairing, key exchange, and encrypted payloads.
pub mod crypto;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Default localhost port for the `FalconDeck` daemon HTTP server.
pub const DEFAULT_DAEMON_PORT: u16 = 4123;
/// Default port for the `FalconDeck` relay HTTP and websocket server.
pub const DEFAULT_RELAY_PORT: u16 = 8787;

fn default_true() -> bool {
    true
}

/// Basic metadata about a running daemon instance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DaemonInfo {
    /// Build or application version reported by the daemon.
    pub version: String,
    /// Timestamp when the daemon process started.
    pub started_at: DateTime<Utc>,
}

/// Global FalconDeck preferences persisted by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FalconDeckPreferences {
    /// Schema version for the on-disk preferences file.
    #[serde(default = "default_preferences_version")]
    pub version: u32,
    /// Conversation and thread display preferences.
    #[serde(default)]
    pub conversation: ConversationPreferences,
}

impl Default for FalconDeckPreferences {
    fn default() -> Self {
        Self {
            version: default_preferences_version(),
            conversation: ConversationPreferences::default(),
        }
    }
}

/// User-configurable conversation rendering preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationPreferences {
    /// Controls how tool details are expanded or collapsed by default.
    #[serde(default)]
    pub tool_details_mode: ToolDetailsMode,
    /// Important artifact types that should auto-expand.
    #[serde(default)]
    pub auto_expand: ConversationAutoExpandPreferences,
    /// Whether read-only tool runs should be grouped into compact bursts.
    #[serde(default = "default_true")]
    pub group_read_only_tools: bool,
    /// Whether thread-level expand/collapse controls should be shown.
    #[serde(default = "default_true")]
    pub show_expand_all_controls: bool,
}

impl Default for ConversationPreferences {
    fn default() -> Self {
        Self {
            tool_details_mode: ToolDetailsMode::Compact,
            auto_expand: ConversationAutoExpandPreferences::default(),
            group_read_only_tools: true,
            show_expand_all_controls: true,
        }
    }
}

/// Auto-expand preferences for high-signal conversation artifacts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationAutoExpandPreferences {
    /// Auto-expand approval requests and approval-related artifacts.
    #[serde(default = "default_true")]
    pub approvals: bool,
    /// Auto-expand error states.
    #[serde(default = "default_true")]
    pub errors: bool,
    /// Auto-expand the first diff shown in a thread.
    #[serde(default = "default_true")]
    pub first_diff: bool,
    /// Auto-expand failed test runs.
    #[serde(default = "default_true")]
    pub failed_tests: bool,
}

impl Default for ConversationAutoExpandPreferences {
    fn default() -> Self {
        Self {
            approvals: true,
            errors: true,
            first_diff: true,
            failed_tests: true,
        }
    }
}

/// Available tool detail presentation modes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolDetailsMode {
    /// Group low-signal read-only tool chatter and expand only important artifacts.
    Auto,
    /// Prefer expanded tool details with minimal collapsing.
    Expanded,
    /// Prefer compact grouped tool details; suppress read-only output by default.
    #[default]
    Compact,
    /// Hide raw read-only tool detail bodies while keeping summary rows visible.
    HideReadOnlyDetails,
}

/// Partial preferences update payload accepted by the daemon API.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct UpdatePreferencesRequest {
    /// Optional conversation preference updates.
    #[serde(default)]
    pub conversation: Option<ConversationPreferencesPatch>,
}

/// Partial update payload for conversation preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ConversationPreferencesPatch {
    /// Optional tool detail mode update.
    #[serde(default)]
    pub tool_details_mode: Option<ToolDetailsMode>,
    /// Optional auto-expand preference updates.
    #[serde(default)]
    pub auto_expand: Option<ConversationAutoExpandPreferencesPatch>,
    /// Optional read-only grouping update.
    #[serde(default)]
    pub group_read_only_tools: Option<bool>,
    /// Optional expand-all control visibility update.
    #[serde(default)]
    pub show_expand_all_controls: Option<bool>,
}

/// Partial update payload for auto-expand preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ConversationAutoExpandPreferencesPatch {
    /// Optional approvals auto-expand update.
    #[serde(default)]
    pub approvals: Option<bool>,
    /// Optional errors auto-expand update.
    #[serde(default)]
    pub errors: Option<bool>,
    /// Optional first-diff auto-expand update.
    #[serde(default)]
    pub first_diff: Option<bool>,
    /// Optional failed-tests auto-expand update.
    #[serde(default)]
    pub failed_tests: Option<bool>,
}

/// Tool-call display metadata derived by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCallDisplay {
    /// Whether the tool is considered a read-only inspection action.
    #[serde(default)]
    pub is_read_only: bool,
    /// Whether the tool had or likely had side effects.
    #[serde(default)]
    pub has_side_effect: bool,
    /// Whether the tool is in an error state.
    #[serde(default)]
    pub is_error: bool,
    /// Artifact classification used by clients to decide prominence.
    #[serde(default)]
    pub artifact_kind: ToolArtifactKind,
    /// Optional short summary hint for grouped tool-burst headers.
    #[serde(default)]
    pub summary_hint: Option<String>,
}

impl Default for ToolCallDisplay {
    fn default() -> Self {
        Self {
            is_read_only: false,
            has_side_effect: false,
            is_error: false,
            artifact_kind: ToolArtifactKind::None,
            summary_hint: None,
        }
    }
}

/// High-level artifact type associated with a tool call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolArtifactKind {
    /// No special artifact classification.
    #[default]
    None,
    /// Diff-producing tool call.
    Diff,
    /// Test-related tool call.
    Test,
    /// General command output worth surfacing.
    CommandOutput,
    /// Approval or permission-related tool call.
    ApprovalRelated,
}

/// Full daemon snapshot returned to newly connected clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DaemonSnapshot {
    /// Metadata about the daemon process.
    pub daemon: DaemonInfo,
    /// Known connected workspaces.
    pub workspaces: Vec<WorkspaceSummary>,
    /// Known threads across all workspaces.
    pub threads: Vec<ThreadSummary>,
    /// Outstanding approvals or questions awaiting user input.
    pub interactive_requests: Vec<InteractiveRequest>,
    /// Global FalconDeck preferences persisted by the daemon.
    #[serde(default)]
    pub preferences: FalconDeckPreferences,
}

/// Health-check response for daemon HTTP endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthResponse {
    /// Whether the service considers itself healthy.
    pub ok: bool,
    /// Build or application version reported by the daemon.
    pub version: String,
    /// Number of workspaces currently tracked by the daemon.
    pub workspaces: usize,
}

/// Request payload used to connect a workspace path to the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectWorkspaceRequest {
    /// Filesystem path for the workspace to connect.
    pub path: String,
}

/// Optional filters applied when materializing a daemon snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SnapshotRequest {
    /// Whether archived threads should be included in the snapshot thread list.
    #[serde(default = "default_true")]
    pub include_archived_threads: bool,
}

/// Request payload used to start a new thread in a workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartThreadRequest {
    /// Workspace identifier that will own the thread.
    pub workspace_id: String,
    /// Optional provider override for the new thread.
    #[serde(default)]
    pub provider: Option<AgentProvider>,
    /// Optional model identifier override for the new thread.
    pub model_id: Option<String>,
    /// Optional collaboration mode override for the new thread.
    pub collaboration_mode_id: Option<String>,
    /// Optional approval policy for the new thread.
    pub approval_policy: Option<String>,
}

/// Request payload used to update thread-level agent settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateThreadRequest {
    /// Workspace identifier that owns the thread.
    pub workspace_id: String,
    /// Thread identifier being updated.
    pub thread_id: String,
    /// Optional thread title override.
    pub title: Option<String>,
    /// Optional provider override for the thread.
    #[serde(default)]
    pub provider: Option<AgentProvider>,
    /// Optional model identifier override for future turns.
    pub model_id: Option<String>,
    /// Optional reasoning effort override for future turns.
    pub reasoning_effort: Option<String>,
    /// Optional collaboration mode override for future turns.
    pub collaboration_mode_id: Option<String>,
}

/// Request payload used to mark thread events as read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarkThreadReadRequest {
    /// Highest event sequence observed by the client.
    pub read_seq: u64,
}

/// Fetch mode used by thread-detail requests.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThreadDetailMode {
    /// Return the full thread history.
    #[default]
    Full,
    /// Return the newest page of thread history.
    Tail,
    /// Return a page of items that appear before a given item id.
    Before,
}

/// Request payload used to load a thread detail window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadDetailRequest {
    /// Workspace identifier that owns the thread.
    pub workspace_id: String,
    /// Thread identifier being loaded.
    pub thread_id: String,
    /// History fetch mode for the request.
    #[serde(default)]
    pub mode: ThreadDetailMode,
    /// Optional page size override for paged history modes.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Optional item id that bounds a `before` history page.
    #[serde(default)]
    pub before_item_id: Option<String>,
}

/// Image attachment metadata used in turn inputs and conversation history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImageInput {
    /// Stable attachment identifier.
    pub id: String,
    /// Optional display name for the image.
    pub name: Option<String>,
    /// Optional MIME type supplied by the client.
    pub mime_type: Option<String>,
    /// Remote or local URL used to reference the image.
    pub url: String,
    /// Optional absolute local path when the image exists on disk.
    pub local_path: Option<String>,
}

/// Normalized provider availability for a skill entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillAvailability {
    /// The skill can only be used with Codex.
    Codex,
    /// The skill can only be used with Claude.
    Claude,
    /// The skill can be translated for both providers.
    Both,
}

/// Source classification used when merging skill catalogs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillSourceKind {
    /// Native provider-reported entry.
    ProviderNative,
    /// Project-local file-backed entry.
    ProjectFile,
    /// Home-directory/global file-backed entry.
    HomeFile,
}

/// Provider-specific Codex translation metadata for a skill.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CodexSkillTranslation {
    /// Native skill identifier, if Codex reported one.
    pub native_id: Option<String>,
    /// Native skill name, if Codex reported one.
    pub native_name: Option<String>,
}

/// Provider-specific Claude translation metadata for a skill.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ClaudeSkillTranslation {
    /// Native slash command name for Claude, without the leading slash.
    pub command_name: Option<String>,
    /// Optional file path FalconDeck should reference in a prompt preamble.
    pub prompt_reference_path: Option<String>,
}

/// Provider-specific skill translation metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SkillProviderTranslations {
    /// Codex translation details, when available.
    pub codex: Option<CodexSkillTranslation>,
    /// Claude translation details, when available.
    pub claude: Option<ClaudeSkillTranslation>,
}

/// Normalized skill summary exposed to FalconDeck clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillSummary {
    /// Stable FalconDeck skill identifier.
    pub id: String,
    /// Human-readable display name.
    pub label: String,
    /// Canonical slash alias including the leading slash.
    pub alias: String,
    /// Which providers can use this skill.
    pub availability: SkillAvailability,
    /// Winning merged source for this entry.
    pub source_kind: SkillSourceKind,
    /// Optional source file path when the entry is file-backed.
    pub source_path: Option<String>,
    /// Short description shown in the picker, if available.
    pub description: Option<String>,
    /// Provider-specific translation metadata.
    #[serde(default)]
    pub provider_translations: SkillProviderTranslations,
}

/// Structured skill selection carried alongside a turn payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SelectedSkillReference {
    /// Stable FalconDeck skill identifier from the workspace catalog.
    pub skill_id: String,
    /// Canonical slash alias selected by the user.
    pub alias: String,
}

/// Individual input items accepted by a user turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnInputItem {
    /// Plain text entered by the user.
    Text {
        /// Optional stable input item identifier.
        id: Option<String>,
        /// Text content supplied by the user.
        text: String,
    },
    /// Image attachment provided by the user.
    Image(ImageInput),
}

/// Agent configuration captured on a thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ThreadAgentParams {
    /// Selected model identifier for the thread.
    pub model_id: Option<String>,
    /// Selected reasoning effort for the thread.
    pub reasoning_effort: Option<String>,
    /// Selected collaboration mode for the thread.
    pub collaboration_mode_id: Option<String>,
    /// Approval policy applied to the thread.
    pub approval_policy: Option<String>,
    /// Optional provider-specific service tier.
    pub service_tier: Option<String>,
}

/// Supported agent providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentProvider {
    /// `OpenAI` Codex-backed agent sessions.
    #[default]
    Codex,
    /// Claude CLI-backed agent sessions.
    Claude,
}

/// Request payload used to send a turn to an existing thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SendTurnRequest {
    /// Workspace identifier that owns the thread.
    pub workspace_id: String,
    /// Target thread identifier.
    pub thread_id: String,
    /// Ordered input items for the turn.
    pub inputs: Vec<TurnInputItem>,
    /// Structured skill selections parsed from the user-authored prompt.
    #[serde(default)]
    pub selected_skills: Vec<SelectedSkillReference>,
    /// Optional provider override for this turn.
    #[serde(default)]
    pub provider: Option<AgentProvider>,
    /// Optional model identifier override for this turn.
    pub model_id: Option<String>,
    /// Optional reasoning effort override for this turn.
    pub reasoning_effort: Option<String>,
    /// Optional collaboration mode override for this turn.
    pub collaboration_mode_id: Option<String>,
    /// Optional approval policy override for this turn.
    pub approval_policy: Option<String>,
    /// Optional provider-specific service tier for this turn.
    pub service_tier: Option<String>,
}

/// Request payload used to start a code review flow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartReviewRequest {
    /// Workspace identifier that owns the review target.
    pub workspace_id: String,
    /// Thread identifier where review output should be posted.
    pub thread_id: String,
    /// File or target path to review.
    pub target: String,
}

/// Request payload used to answer an approval prompt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalResponseRequest {
    /// Decision selected by the user.
    pub decision: ApprovalDecision,
}

/// Request payload used to answer an interactive question.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveResponseRequest {
    /// Structured response payload returned by the user.
    pub response: InteractiveResponsePayload,
}

/// Possible responses to an approval request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    /// Approve the current request once.
    Allow,
    /// Reject the current request.
    Deny,
    /// Approve the current and similar future requests.
    AlwaysAllow,
}

/// Structured payload returned when resolving an interactive request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InteractiveResponsePayload {
    /// Response payload for approval-style prompts.
    Approval {
        /// Decision selected by the user.
        decision: ApprovalDecision,
    },
    /// Response payload for question-style prompts.
    Question {
        /// Answers grouped by question identifier.
        answers: std::collections::HashMap<String, Vec<String>>,
    },
}

/// Generic command result returned by mutating endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandResponse {
    /// Whether the command succeeded.
    pub ok: bool,
    /// Optional human-readable status message.
    pub message: Option<String>,
}

/// Summary of a daemon-connected workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceSummary {
    /// Stable workspace identifier.
    pub id: String,
    /// Filesystem path for the workspace root.
    pub path: String,
    /// Current lifecycle state for the workspace.
    pub status: WorkspaceStatus,
    /// Provider-specific agent summaries for the workspace.
    #[serde(default)]
    pub agents: Vec<WorkspaceAgentSummary>,
    /// Merged workspace-level skill catalog for the universal picker.
    #[serde(default)]
    pub skills: Vec<SkillSummary>,
    /// Default provider used for new threads in the workspace.
    #[serde(default)]
    pub default_provider: AgentProvider,
    // Legacy aliases kept during the provider-aware migration.
    /// Legacy model list retained for older clients.
    #[serde(default)]
    pub models: Vec<ModelSummary>,
    /// Collaboration modes exposed by the workspace.
    #[serde(default)]
    pub collaboration_modes: Vec<CollaborationModeSummary>,
    /// Whether plan mode is supported through a compatibility layer.
    #[serde(default = "default_true")]
    pub supports_plan_mode: bool,
    /// Whether the provider supports plan mode natively.
    #[serde(default = "default_true")]
    pub supports_native_plan_mode: bool,
    /// Account status for the default provider.
    #[serde(default)]
    pub account: AccountSummary,
    /// Currently selected thread, if any.
    pub current_thread_id: Option<String>,
    /// Timestamp when the workspace was connected.
    pub connected_at: DateTime<Utc>,
    /// Timestamp when the workspace summary last changed.
    pub updated_at: DateTime<Utc>,
    /// Most recent workspace-level error, if any.
    pub last_error: Option<String>,
}

/// Provider capability flags exposed in workspace summaries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct AgentCapabilitySummary {
    /// Whether the provider can start review flows.
    #[serde(default)]
    pub supports_review: bool,
}

/// Per-provider summary for a workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceAgentSummary {
    /// Provider represented by this summary.
    pub provider: AgentProvider,
    /// Account state reported by the provider.
    pub account: AccountSummary,
    /// Models available for the provider.
    #[serde(default)]
    pub models: Vec<ModelSummary>,
    /// Collaboration modes available for the provider.
    #[serde(default)]
    pub collaboration_modes: Vec<CollaborationModeSummary>,
    /// Provider-scoped skill catalog for the workspace.
    #[serde(default)]
    pub skills: Vec<SkillSummary>,
    /// Whether plan mode is supported through a compatibility layer.
    #[serde(default = "default_true")]
    pub supports_plan_mode: bool,
    /// Whether the provider supports plan mode natively.
    #[serde(default = "default_true")]
    pub supports_native_plan_mode: bool,
    /// Capability flags reported by the provider.
    #[serde(default)]
    pub capabilities: AgentCapabilitySummary,
}

/// Description of a supported reasoning effort.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReasoningEffortSummary {
    /// Provider-specific reasoning effort identifier.
    pub reasoning_effort: String,
    /// Human-readable explanation of the effort level.
    pub description: String,
}

/// Lifecycle state of a connected workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatus {
    /// The daemon is still establishing the workspace connection.
    Connecting,
    /// The workspace is ready to accept work.
    Ready,
    /// The provider needs authentication before the workspace can be used.
    NeedsAuth,
    /// The workspace currently has active work in flight.
    Busy,
    /// The workspace connection has been dropped.
    Disconnected,
    /// The workspace hit an unrecoverable error.
    Error,
}

/// Summary of an available model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelSummary {
    /// Stable model identifier.
    pub id: String,
    /// Human-readable label displayed to users.
    pub label: String,
    /// Whether this is the provider default.
    pub is_default: bool,
    /// Default reasoning effort for the model, if any.
    pub default_reasoning_effort: Option<String>,
    /// Reasoning efforts supported by the model.
    pub supported_reasoning_efforts: Vec<ReasoningEffortSummary>,
}

/// Summary of an available collaboration mode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollaborationModeSummary {
    /// Stable collaboration mode identifier.
    pub id: String,
    /// Human-readable label displayed to users.
    pub label: String,
    /// Optional provider-specific mode name.
    #[serde(default)]
    pub mode: Option<String>,
    /// Model bound to the collaboration mode, if any.
    pub model_id: Option<String>,
    /// Reasoning effort bound to the collaboration mode, if any.
    pub reasoning_effort: Option<String>,
    /// Whether the mode is implemented natively by the provider.
    #[serde(default = "default_true")]
    pub is_native: bool,
}

/// Account status summary for a provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct AccountSummary {
    /// High-level account readiness state.
    pub status: AccountStatus,
    /// Human-readable label describing the account state.
    pub label: String,
}

/// Authentication status for a provider account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    /// The daemon has not confirmed provider status yet.
    #[default]
    Unknown,
    /// The provider is authenticated and ready.
    Ready,
    /// The provider requires user authentication.
    NeedsAuth,
}

/// Summary of a single thread within a workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadSummary {
    /// Stable thread identifier.
    pub id: String,
    /// Workspace identifier that owns the thread.
    pub workspace_id: String,
    /// User-visible thread title.
    pub title: String,
    /// Provider backing the thread.
    #[serde(default)]
    pub provider: AgentProvider,
    /// Provider-native session identifier, if one exists.
    #[serde(default)]
    pub native_session_id: Option<String>,
    /// Current lifecycle state of the thread.
    pub status: ThreadStatus,
    /// Timestamp when the thread summary last changed.
    pub updated_at: DateTime<Utc>,
    /// Preview text from the latest user- or assistant-visible message.
    pub last_message_preview: Option<String>,
    /// Latest turn identifier, if a turn has been started.
    pub latest_turn_id: Option<String>,
    /// Latest plan emitted into the thread, if any.
    pub latest_plan: Option<ThreadPlan>,
    /// Latest diff summary emitted into the thread, if any.
    pub latest_diff: Option<String>,
    /// Latest tool title observed in the thread, if any.
    pub last_tool: Option<String>,
    /// Latest thread-level error, if any.
    pub last_error: Option<String>,
    /// Effective agent parameters for the thread.
    #[serde(default, alias = "codex")]
    pub agent: ThreadAgentParams,
    /// Attention metadata used for badges and unread counts.
    #[serde(default)]
    pub attention: ThreadAttention,
    /// Whether the thread has been archived.
    #[serde(default)]
    pub is_archived: bool,
}

/// Attention state derived from thread activity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ThreadAttention {
    /// High-level attention category.
    #[serde(default)]
    pub level: ThreadAttentionLevel,
    /// Optional badge label shown in the UI.
    #[serde(default)]
    pub badge_label: Option<String>,
    /// Whether the thread has unread activity.
    #[serde(default)]
    pub unread: bool,
    /// Number of pending approvals.
    #[serde(default)]
    pub pending_approval_count: u32,
    /// Number of pending questions.
    #[serde(default)]
    pub pending_question_count: u32,
    /// Last agent-originated event sequence in the thread.
    #[serde(default)]
    pub last_agent_activity_seq: u64,
    /// Last event sequence acknowledged by the user.
    #[serde(default)]
    pub last_read_seq: u64,
}

/// Badge-level attention category for a thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThreadAttentionLevel {
    /// No attention is currently required.
    #[default]
    None,
    /// The thread has unread activity.
    Unread,
    /// The thread is actively running.
    Running,
    /// The thread is waiting for user input.
    AwaitingResponse,
    /// The thread is in an error state.
    Error,
}

/// Lifecycle state for an individual thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    /// The thread is idle.
    Idle,
    /// The thread is actively processing a turn.
    Running,
    /// The thread is paused pending user input.
    WaitingForInput,
    /// The thread encountered an error.
    Error,
}

/// Structured plan emitted by an agent turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadPlan {
    /// Optional plan explanation supplied by the agent.
    pub explanation: Option<String>,
    /// Ordered plan steps.
    pub steps: Vec<PlanStep>,
}

/// Single step within a thread plan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanStep {
    /// Human-readable step description.
    pub step: String,
    /// Current status for the step.
    pub status: String,
}

/// Interactive request awaiting a user response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveRequest {
    /// Stable request identifier.
    pub request_id: String,
    /// Workspace identifier associated with the request.
    pub workspace_id: String,
    /// Thread identifier associated with the request, if any.
    pub thread_id: Option<String>,
    /// Underlying provider method that produced the request.
    pub method: String,
    /// High-level request kind.
    pub kind: InteractiveRequestKind,
    /// Short user-facing title.
    pub title: String,
    /// Optional user-facing detail text.
    pub detail: Option<String>,
    /// Optional command preview tied to the request.
    pub command: Option<String>,
    /// Optional filesystem path tied to the request.
    pub path: Option<String>,
    /// Optional turn identifier tied to the request.
    pub turn_id: Option<String>,
    /// Optional item identifier tied to the request.
    pub item_id: Option<String>,
    /// Question definitions when the request expects answers.
    pub questions: Vec<InteractiveQuestion>,
    /// Timestamp when the request was created.
    pub created_at: DateTime<Utc>,
}

/// Kind of interactive request emitted by a provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractiveRequestKind {
    /// Approval prompt.
    Approval,
    /// Question prompt.
    Question,
}

/// Single interactive question presented to the user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveQuestion {
    /// Stable question identifier.
    pub id: String,
    /// Short label shown above the question.
    pub header: String,
    /// User-facing question text.
    pub question: String,
    /// Whether this represents an open-ended "other" entry.
    pub is_other: bool,
    /// Whether the answer should be treated as sensitive.
    pub is_secret: bool,
    /// Predefined options, if the question is multiple choice.
    pub options: Option<Vec<InteractiveQuestionOption>>,
}

/// Option for an interactive multiple-choice question.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveQuestionOption {
    /// Short option label.
    pub label: String,
    /// Helper text describing the option.
    pub description: String,
}

/// Conversation items stored in thread history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationItem {
    /// User-authored message content.
    UserMessage {
        /// Stable item identifier.
        id: String,
        /// User-visible text content.
        text: String,
        /// Attached images included with the message.
        attachments: Vec<ImageInput>,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Assistant-authored message content.
    AssistantMessage {
        /// Stable item identifier.
        id: String,
        /// Assistant-visible text content.
        text: String,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Provider reasoning content.
    Reasoning {
        /// Stable item identifier.
        id: String,
        /// Optional short summary for the reasoning block.
        summary: Option<String>,
        /// Full reasoning content.
        content: String,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Tool invocation emitted by the agent.
    ToolCall {
        /// Stable item identifier.
        id: String,
        /// User-facing tool title.
        title: String,
        /// Tool kind or category.
        tool_kind: String,
        /// Current tool status.
        status: String,
        /// Optional captured tool output.
        output: Option<String>,
        /// Optional process exit code.
        exit_code: Option<i32>,
        /// Display metadata derived by the daemon.
        #[serde(default)]
        display: ToolCallDisplay,
        /// Timestamp when the tool call started.
        created_at: DateTime<Utc>,
        /// Timestamp when the tool call finished.
        completed_at: Option<DateTime<Utc>>,
    },
    /// Plan emitted by the agent.
    Plan {
        /// Stable item identifier.
        id: String,
        /// Structured plan payload.
        plan: ThreadPlan,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Diff emitted by the agent.
    Diff {
        /// Stable item identifier.
        id: String,
        /// Patch or diff text.
        diff: String,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Service-level status message.
    Service {
        /// Stable item identifier.
        id: String,
        /// Severity level for the message.
        level: ServiceLevel,
        /// Human-readable message text.
        message: String,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Embedded interactive request.
    InteractiveRequest {
        /// Stable item identifier.
        id: String,
        /// Interactive request payload.
        request: InteractiveRequest,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
        /// Whether the request has already been resolved.
        resolved: bool,
    },
}

/// Full thread detail response returned by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadDetail {
    /// Workspace summary for the thread.
    pub workspace: WorkspaceSummary,
    /// Thread summary.
    pub thread: ThreadSummary,
    /// Ordered conversation items for the thread.
    pub items: Vec<ConversationItem>,
    /// Whether older items exist before the returned window.
    #[serde(default)]
    pub has_older: bool,
    /// Oldest item id present in the returned window, if any.
    #[serde(default)]
    pub oldest_item_id: Option<String>,
    /// Newest item id present in the returned window, if any.
    #[serde(default)]
    pub newest_item_id: Option<String>,
    /// Whether the response contains only a partial history window.
    #[serde(default)]
    pub is_partial: bool,
}

/// Sequenced event emitted by the daemon event stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventEnvelope {
    /// Monotonic event sequence number.
    pub seq: u64,
    /// Timestamp when the event was emitted.
    pub emitted_at: DateTime<Utc>,
    /// Workspace associated with the event, if any.
    pub workspace_id: Option<String>,
    /// Thread associated with the event, if any.
    pub thread_id: Option<String>,
    /// Event payload.
    pub event: UnifiedEvent,
}

/// Event payload sent over the unified daemon stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum UnifiedEvent {
    /// Full daemon snapshot.
    Snapshot {
        /// Snapshot payload for the current daemon state.
        snapshot: DaemonSnapshot,
    },
    /// Thread run start marker.
    Start {
        /// Optional title for the run.
        title: Option<String>,
    },
    /// Thread run stop marker.
    Stop {
        /// Optional reason for the stop event.
        reason: Option<String>,
    },
    /// Turn start marker.
    TurnStart {
        /// Started turn identifier.
        turn_id: String,
    },
    /// Turn completion marker.
    TurnEnd {
        /// Completed turn identifier.
        turn_id: String,
        /// Provider-reported turn status.
        status: String,
        /// Optional error message for failed turns.
        error: Option<String>,
    },
    /// Incremental text delta.
    Text {
        /// Item identifier receiving the delta.
        item_id: String,
        /// Text delta content.
        delta: String,
    },
    /// Service-level status update.
    Service {
        /// Severity level for the message.
        level: ServiceLevel,
        /// Human-readable status text.
        message: String,
        /// Provider method associated with the message, if any.
        raw_method: Option<String>,
    },
    /// Tool call start marker.
    ToolCallStart {
        /// Item identifier for the tool call.
        item_id: String,
        /// User-facing tool title.
        title: String,
        /// Tool kind or category.
        kind: String,
    },
    /// Tool call completion marker.
    ToolCallEnd {
        /// Item identifier for the tool call.
        item_id: String,
        /// User-facing tool title.
        title: String,
        /// Tool kind or category.
        kind: String,
        /// Final tool status.
        status: String,
        /// Optional process exit code.
        exit_code: Option<i32>,
    },
    /// File or patch summary emitted during a turn.
    File {
        /// Item identifier for the file event, if one exists.
        item_id: Option<String>,
        /// Path associated with the event, if one exists.
        path: Option<String>,
        /// Human-readable file summary.
        summary: String,
    },
    /// Interactive request emitted during a turn.
    InteractiveRequest {
        /// Request payload.
        request: InteractiveRequest,
    },
    /// Thread creation event.
    ThreadStarted {
        /// Newly created thread summary.
        thread: ThreadSummary,
    },
    /// Thread metadata update event.
    ThreadUpdated {
        /// Updated thread summary.
        thread: ThreadSummary,
    },
    /// Workspace metadata update event.
    WorkspaceUpdated {
        /// Updated workspace summary.
        workspace: WorkspaceSummary,
    },
    /// Global preference update event.
    PreferencesUpdated {
        /// Updated global preferences payload.
        preferences: FalconDeckPreferences,
    },
    /// New conversation item event.
    ConversationItemAdded {
        /// Added conversation item.
        item: ConversationItem,
    },
    /// Existing conversation item update event.
    ConversationItemUpdated {
        /// Updated conversation item.
        item: ConversationItem,
    },
}

/// Severity level for service messages.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceLevel {
    /// Informational message.
    Info,
    /// Warning message.
    Warning,
    /// Error message.
    Error,
}

fn default_preferences_version() -> u32 {
    1
}

/// Pair of workspace and thread summaries returned by creation endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadHandle {
    /// Workspace summary for the thread.
    pub workspace: WorkspaceSummary,
    /// Thread summary.
    pub thread: ThreadSummary,
}

/// Health-check response for the relay service.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayHealthResponse {
    /// Whether the relay considers itself healthy.
    pub ok: bool,
    /// Service name.
    pub service: String,
    /// Build or application version reported by the relay.
    pub version: String,
    /// Number of pairings waiting to be claimed.
    pub pending_pairings: usize,
    /// Number of active relay sessions.
    pub active_sessions: usize,
}

/// Encryption scheme used by pairing and relay payloads.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EncryptionVariant {
    /// Version 1 data-key based encryption.
    #[default]
    DataKeyV1,
}

/// Signing identity scheme used by pairing payloads.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IdentityVariant {
    /// Version 1 Ed25519 identity keys.
    #[default]
    Ed25519V1,
}

/// Public keys and signature shared during pairing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingPublicKeyBundle {
    /// Encryption scheme used by the bundle.
    #[serde(default)]
    pub encryption_variant: EncryptionVariant,
    /// Identity scheme used by the bundle signature.
    #[serde(default)]
    pub identity_variant: IdentityVariant,
    /// Base64-encoded data-encryption public key.
    pub public_key: String,
    /// Base64-encoded signing public key.
    #[serde(default)]
    pub identity_public_key: String,
    /// Base64-encoded signature over the bundle contents.
    #[serde(default)]
    pub signature: String,
}

/// Encrypted data key for a specific pairing participant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WrappedDataKey {
    /// Encryption scheme used by the wrapped payload.
    #[serde(default)]
    pub encryption_variant: EncryptionVariant,
    /// Base64-encoded wrapped key payload.
    pub wrapped_key: String,
}

/// Signed bootstrap payload used to establish a relay session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionKeyMaterial {
    /// Encryption scheme used by wrapped payloads.
    #[serde(default)]
    pub encryption_variant: EncryptionVariant,
    /// Identity scheme used by the bootstrap signature.
    #[serde(default)]
    pub identity_variant: IdentityVariant,
    /// Pairing identifier that created the session.
    pub pairing_id: String,
    /// Session identifier established by the relay.
    pub session_id: String,
    /// Base64-encoded daemon data-encryption public key.
    pub daemon_public_key: String,
    /// Base64-encoded daemon signing public key.
    #[serde(default)]
    pub daemon_identity_public_key: String,
    /// Base64-encoded client data-encryption public key.
    pub client_public_key: String,
    /// Base64-encoded client signing public key.
    #[serde(default)]
    pub client_identity_public_key: String,
    /// Data key wrapped for the client.
    pub client_wrapped_data_key: WrappedDataKey,
    /// Optional data key wrapped for the daemon.
    pub daemon_wrapped_data_key: Option<WrappedDataKey>,
    /// Base64-encoded daemon signature over the bootstrap payload.
    #[serde(default)]
    pub signature: String,
}

/// Encrypted payload envelope shared across daemon, relay, and clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedEnvelope {
    /// Encryption scheme used by the payload.
    #[serde(default)]
    pub encryption_variant: EncryptionVariant,
    /// Base64-encoded ciphertext bundle.
    pub ciphertext: String,
}

/// Relay update payload body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum RelayUpdateBody {
    /// Bootstrap update that establishes a session key.
    SessionBootstrap {
        /// Signed session bootstrap payload.
        material: SessionKeyMaterial,
    },
    /// Encrypted application payload.
    Encrypted {
        /// Encrypted payload envelope.
        envelope: EncryptedEnvelope,
    },
    /// Status update for a queued remote action.
    ActionStatus {
        /// Remote action snapshot.
        action: QueuedRemoteAction,
    },
    /// Presence update for the paired daemon.
    Presence {
        /// Presence snapshot for the daemon.
        presence: MachinePresence,
    },
}

/// Request payload used to create a relay pairing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StartPairingRequest {
    /// Optional device label shown to the user.
    pub label: Option<String>,
    /// Optional pairing time-to-live in seconds.
    pub ttl_seconds: Option<u64>,
    /// Optional existing session to re-pair against.
    pub existing_session_id: Option<String>,
    /// Optional daemon token authorizing an existing session.
    pub daemon_token: Option<String>,
    /// Optional daemon public key bundle.
    pub daemon_bundle: Option<PairingPublicKeyBundle>,
}

/// Response returned after creating a relay pairing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartPairingResponse {
    /// New pairing identifier.
    pub pairing_id: String,
    /// Session identifier reserved for the pairing.
    pub session_id: String,
    /// Human-entered pairing code.
    pub pairing_code: String,
    /// Daemon token used by the daemon websocket.
    pub daemon_token: String,
    /// Pairing expiration timestamp.
    pub expires_at: DateTime<Utc>,
}

/// Request payload used by a client to claim a pairing code.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimPairingRequest {
    /// Pairing code entered by the user.
    pub pairing_code: String,
    /// Optional device label chosen by the user.
    pub label: Option<String>,
    /// Optional client public key bundle.
    pub client_bundle: Option<PairingPublicKeyBundle>,
}

/// Response returned after a client claims a pairing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimPairingResponse {
    /// Claimed pairing identifier.
    pub pairing_id: String,
    /// Session identifier associated with the pairing.
    pub session_id: String,
    /// Trusted device identifier assigned to the client.
    pub device_id: String,
    /// Client token used by the paired device websocket.
    pub client_token: String,
    /// Trusted device summary for the client.
    pub trusted_device: TrustedDevice,
    /// Daemon public key bundle, if available.
    pub daemon_bundle: Option<PairingPublicKeyBundle>,
}

/// Current status of a pairing code.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairingStatusResponse {
    /// Pairing identifier.
    pub pairing_id: String,
    /// Optional label associated with the pairing.
    pub label: Option<String>,
    /// Current pairing lifecycle status.
    pub status: PairingStatus,
    /// Session identifier, once known.
    pub session_id: Option<String>,
    /// Device identifier, once claimed.
    pub device_id: Option<String>,
    /// Pairing expiration timestamp.
    pub expires_at: DateTime<Utc>,
    /// Daemon public key bundle, if available.
    pub daemon_bundle: Option<PairingPublicKeyBundle>,
    /// Client public key bundle, if available.
    pub client_bundle: Option<PairingPublicKeyBundle>,
}

/// Lifecycle state of a pairing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairingStatus {
    /// Pairing exists and has not been claimed.
    Pending,
    /// Pairing has been claimed by a client.
    Claimed,
    /// Pairing expired before completion.
    Expired,
}

/// Query parameters used to fetch relay replay updates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayUpdatesQuery {
    /// Highest acknowledged sequence number to resume after.
    pub after_seq: Option<u64>,
}

/// Lifecycle state of a trusted device.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrustedDeviceStatus {
    /// Device is active and allowed to reconnect.
    Active,
    /// Device access has been revoked.
    Revoked,
}

/// Trusted device recorded for a relay session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustedDevice {
    /// Stable trusted device identifier.
    pub device_id: String,
    /// Session identifier owned by the device.
    pub session_id: String,
    /// Optional user-visible device label.
    pub label: Option<String>,
    /// Current device status.
    pub status: TrustedDeviceStatus,
    /// Timestamp when the device was created.
    pub created_at: DateTime<Utc>,
    /// Timestamp when the device last connected.
    pub last_seen_at: Option<DateTime<Utc>>,
    /// Timestamp when the device was revoked.
    pub revoked_at: Option<DateTime<Utc>>,
}

/// Presence information for a daemon attached to a relay session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MachinePresence {
    /// Session identifier being reported.
    pub session_id: String,
    /// Whether the daemon websocket is currently connected.
    pub daemon_connected: bool,
    /// Timestamp when the daemon was last seen by the relay.
    pub last_seen_at: Option<DateTime<Utc>>,
}

/// Replay cursor for a relay session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncCursor {
    /// Session identifier that owns the cursor.
    pub session_id: String,
    /// Next sequence the client should request.
    pub next_seq: u64,
    /// Last sequence acknowledged by the client.
    pub last_acknowledged_seq: u64,
    /// Whether the client must bootstrap before consuming replay.
    pub requires_bootstrap: bool,
    /// Whether older relay history has been truncated.
    #[serde(default)]
    pub history_truncated: bool,
}

/// Sequenced relay update stored in replay history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelayUpdate {
    /// Stable relay update identifier.
    pub id: String,
    /// Monotonic replay sequence number.
    pub seq: u64,
    /// Update payload.
    pub body: RelayUpdateBody,
    /// Timestamp when the update was created.
    pub created_at: DateTime<Utc>,
}

/// Replay response for a relay session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelayUpdatesResponse {
    /// Session identifier for the replay stream.
    pub session_id: String,
    /// Ordered updates returned by the relay.
    pub updates: Vec<RelayUpdate>,
    /// Next sequence number available after this response.
    pub next_seq: u64,
    /// Replay cursor after applying the updates.
    pub cursor: SyncCursor,
    /// Current daemon presence snapshot.
    pub presence: MachinePresence,
}

/// Request payload used to enqueue a remote action.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubmitQueuedActionRequest {
    /// Idempotency key used to deduplicate the action.
    pub idempotency_key: String,
    /// Provider-specific action type.
    pub action_type: String,
    /// Encrypted action payload.
    pub payload: EncryptedEnvelope,
}

/// Lifecycle state of a queued remote action.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueuedRemoteActionStatus {
    /// Action has been queued but not yet sent to the daemon.
    Queued,
    /// Action has been dispatched to the daemon.
    Dispatched,
    /// Action is actively executing on the daemon.
    Executing,
    /// Action completed successfully.
    Completed,
    /// Action failed.
    Failed,
}

/// Remote action tracked by the relay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueuedRemoteAction {
    /// Stable action identifier.
    pub action_id: String,
    /// Session identifier that owns the action.
    pub session_id: String,
    /// Trusted device identifier that submitted the action.
    pub device_id: String,
    /// Provider-specific action type.
    pub action_type: String,
    /// Idempotency key used to deduplicate the action.
    pub idempotency_key: String,
    /// Current action status.
    pub status: QueuedRemoteActionStatus,
    /// Timestamp when the action was created.
    pub created_at: DateTime<Utc>,
    /// Timestamp when the action last changed.
    pub updated_at: DateTime<Utc>,
    /// Optional failure message.
    pub error: Option<String>,
    /// Optional encrypted result payload.
    pub result: Option<EncryptedEnvelope>,
}

/// Response containing all trusted devices for a session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrustedDevicesResponse {
    /// Session identifier that owns the devices.
    pub session_id: String,
    /// Trusted devices associated with the session.
    pub devices: Vec<TrustedDevice>,
    /// Current daemon presence snapshot.
    pub presence: MachinePresence,
}

/// Request payload used to start daemon-managed remote pairing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartRemotePairingRequest {
    /// Relay base URL used for pairing.
    pub relay_url: String,
}

/// Pairing state stored by the daemon for remote access.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemotePairingSession {
    /// Pairing identifier on the relay.
    pub pairing_id: String,
    /// Human-entered pairing code.
    pub pairing_code: String,
    /// Session identifier once the pairing is claimed.
    pub session_id: Option<String>,
    /// Pairing expiration timestamp.
    pub expires_at: DateTime<Utc>,
}

/// Short-lived relay websocket ticket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayWebSocketTicketResponse {
    /// Signed ticket value accepted by the relay websocket.
    pub ticket: String,
    /// Ticket expiration timestamp.
    pub expires_at: DateTime<Utc>,
}

/// High-level remote connectivity state reported by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteConnectionStatus {
    /// Remote access is disabled or unconfigured.
    Inactive,
    /// Pairing has started but is not yet claimed.
    PairingPending,
    /// A trusted device exists but the daemon is not yet connected.
    DeviceTrusted,
    /// The daemon is connecting to the relay.
    Connecting,
    /// The daemon is connected to the relay.
    Connected,
    /// The daemon is connected but in a degraded state.
    Degraded,
    /// The daemon is offline from the relay.
    Offline,
    /// Trusted device access has been revoked.
    Revoked,
    /// Remote access is in an error state.
    Error,
}

/// Remote access status returned by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteStatusResponse {
    /// Current remote connectivity state.
    pub status: RemoteConnectionStatus,
    /// Relay URL configured for remote access.
    pub relay_url: Option<String>,
    /// Active pairing session, if one is in progress.
    pub pairing: Option<RemotePairingSession>,
    /// Trusted devices known to the daemon.
    pub trusted_devices: Vec<TrustedDevice>,
    /// Current daemon presence snapshot, if known.
    pub presence: Option<MachinePresence>,
    /// Most recent remote-access error, if any.
    pub last_error: Option<String>,
}

/// Role used when connecting to the relay websocket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayPeerRole {
    /// Daemon-side websocket.
    Daemon,
    /// Client-side websocket.
    Client,
}

/// Messages sent by daemon and clients to the relay websocket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RelayClientMessage {
    /// Keepalive ping.
    Ping,
    /// Request replay updates after an optional sequence.
    Sync {
        /// Highest acknowledged sequence number to resume after.
        after_seq: Option<u64>,
    },
    /// Submit a relay update.
    Update {
        /// Update payload body.
        body: RelayUpdateBody,
    },
    /// Submit an ephemeral message that is not stored in replay.
    Ephemeral {
        /// Arbitrary JSON body.
        body: Value,
    },
    /// Register an RPC method on the websocket.
    RpcRegister {
        /// Method name being registered.
        method: String,
    },
    /// Unregister an RPC method on the websocket.
    RpcUnregister {
        /// Method name being unregistered.
        method: String,
    },
    /// Invoke an encrypted RPC on the opposite peer.
    RpcCall {
        /// Request identifier used to correlate the result.
        request_id: String,
        /// Method being invoked.
        method: String,
        /// Encrypted parameter payload.
        params: EncryptedEnvelope,
    },
    /// Return an encrypted RPC result.
    RpcResult {
        /// Request identifier being resolved.
        request_id: String,
        /// Whether the call succeeded.
        ok: bool,
        /// Encrypted success result payload.
        result: Option<EncryptedEnvelope>,
        /// Encrypted error payload.
        error: Option<EncryptedEnvelope>,
    },
    /// Update the status of a queued remote action.
    ActionUpdate {
        /// Action identifier being updated.
        action_id: String,
        /// New action status.
        status: QueuedRemoteActionStatus,
        /// Optional failure message.
        error: Option<String>,
        /// Optional encrypted result payload.
        result: Option<EncryptedEnvelope>,
    },
}

/// Messages emitted by the relay websocket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RelayServerMessage {
    /// Initial ready message returned after websocket authentication.
    Ready {
        /// Session identifier for the connection.
        session_id: String,
        /// Role assigned to the connection.
        role: RelayPeerRole,
        /// Next replay sequence available on the relay.
        next_seq: u64,
    },
    /// Keepalive pong.
    Pong,
    /// Replay synchronization response.
    Sync {
        /// Ordered replay updates.
        updates: Vec<RelayUpdate>,
        /// Next sequence available after this response.
        next_seq: u64,
        /// Whether older replay history has been truncated.
        #[serde(default)]
        history_truncated: bool,
    },
    /// Single replay update pushed by the relay.
    Update {
        /// Update payload.
        update: RelayUpdate,
    },
    /// Ephemeral message forwarded by the relay.
    Ephemeral {
        /// Arbitrary JSON body.
        body: Value,
    },
    /// Confirmation that an RPC method was registered.
    RpcRegistered {
        /// Registered method name.
        method: String,
    },
    /// Confirmation that an RPC method was unregistered.
    RpcUnregistered {
        /// Unregistered method name.
        method: String,
    },
    /// Encrypted RPC request forwarded to the peer.
    RpcRequest {
        /// Request identifier used to correlate the result.
        request_id: String,
        /// Method being invoked.
        method: String,
        /// Encrypted parameter payload.
        params: EncryptedEnvelope,
    },
    /// Encrypted RPC result forwarded to the peer.
    RpcResult {
        /// Request identifier being resolved.
        request_id: String,
        /// Whether the call succeeded.
        ok: bool,
        /// Encrypted success result payload.
        result: Option<EncryptedEnvelope>,
        /// Encrypted error payload.
        error: Option<EncryptedEnvelope>,
    },
    /// Newly requested remote action for the daemon.
    ActionRequested {
        /// Action metadata.
        action: QueuedRemoteAction,
        /// Encrypted action payload.
        payload: EncryptedEnvelope,
    },
    /// Status update for a remote action.
    ActionUpdated {
        /// Updated action metadata.
        action: QueuedRemoteAction,
    },
    /// Presence update for the daemon.
    Presence {
        /// Presence snapshot.
        presence: MachinePresence,
    },
    /// Error message emitted by the relay.
    Error {
        /// Human-readable error message.
        message: String,
    },
}

/// Git status category for a changed file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitFileStatus {
    /// File was added.
    Added,
    /// File contents were modified.
    Modified,
    /// File was deleted.
    Deleted,
    /// File was renamed.
    Renamed,
    /// File is untracked.
    Untracked,
    /// File was copied.
    Copied,
}

/// Single changed file entry returned by git status endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitStatusEntry {
    /// Repository-relative file path.
    pub path: String,
    /// Git status category.
    pub status: GitFileStatus,
    /// Optional inserted line count.
    pub insertions: Option<u32>,
    /// Optional deleted line count.
    pub deletions: Option<u32>,
}

/// Git status summary returned by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitStatusResponse {
    /// Current branch name, if available.
    pub branch: Option<String>,
    /// Changed file entries.
    pub entries: Vec<GitStatusEntry>,
}

/// Full diff response returned by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitDiffResponse {
    /// Unified diff text.
    pub diff: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_unified_event() {
        let snapshot = DaemonSnapshot {
            daemon: DaemonInfo {
                version: "0.1.0".to_string(),
                started_at: Utc::now(),
            },
            workspaces: Vec::new(),
            threads: Vec::new(),
            interactive_requests: Vec::new(),
            preferences: FalconDeckPreferences::default(),
        };

        let json = serde_json::to_value(UnifiedEvent::Snapshot { snapshot }).unwrap();
        assert_eq!(json["type"], "snapshot");
    }

    #[test]
    fn serializes_relay_server_message() {
        let message = RelayServerMessage::Ready {
            session_id: "session-1".to_string(),
            role: RelayPeerRole::Daemon,
            next_seq: 3,
        };

        let json = serde_json::to_value(message).unwrap();
        assert_eq!(json["type"], "ready");
        assert_eq!(json["role"], "daemon");
    }
}
