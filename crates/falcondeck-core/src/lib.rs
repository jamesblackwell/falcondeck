//! Shared `FalconDeck` protocol types.
//!
//! This crate defines the daemon, relay, and client payloads that are exchanged
//! across the local daemon API, relay replay stream, and remote pairing flows.
//! It also exports the cryptography helpers used by the pairing protocol.
#![deny(missing_docs)]

/// Shared wire types for the agent control interface.
pub mod control;
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
    /// Optional daemon features clients may negotiate without version checks.
    #[serde(default)]
    pub capabilities: DaemonCapabilities,
}

/// Feature capabilities supported by a daemon instance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DaemonCapabilities {
    /// Whether this daemon owns and executes scheduled tasks.
    #[serde(default)]
    pub scheduled_tasks: bool,
}

/// Global FalconDeck preferences persisted by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FalconDeckPreferences {
    /// Schema version for the on-disk preferences file.
    #[serde(default = "default_preferences_version")]
    pub version: u32,
    /// User-defined order for workspaces in project navigation.
    #[serde(default)]
    pub workspace_order: Vec<String>,
    /// Conversation and thread display preferences.
    #[serde(default)]
    pub conversation: ConversationPreferences,
    /// Notifications and cross-device attention policy.
    #[serde(default)]
    pub notifications: NotificationPreferences,
    /// Cheap models FalconDeck uses for its own background work.
    #[serde(default)]
    pub utility_models: UtilityModelPreferences,
}

impl Default for FalconDeckPreferences {
    fn default() -> Self {
        Self {
            version: default_preferences_version(),
            workspace_order: Vec::new(),
            conversation: ConversationPreferences::default(),
            notifications: NotificationPreferences::default(),
            utility_models: UtilityModelPreferences::default(),
        }
    }
}

/// Models used for FalconDeck's own background work — currently thread
/// titles — rather than for user turns. These runs are short, tool-free
/// and frequent, so they default to the cheapest model each provider offers and
/// fall back across providers because most users have only one CLI installed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UtilityModelPreferences {
    /// Providers to try in order; the first installed and ready one wins.
    #[serde(default = "default_utility_provider_order")]
    pub provider_order: Vec<AgentProvider>,
    /// Per-provider model override. A provider missing here (or mapped to an
    /// empty string) runs on its own default model.
    #[serde(default)]
    pub models: Vec<UtilityModelChoice>,
}

impl Default for UtilityModelPreferences {
    fn default() -> Self {
        Self {
            provider_order: default_utility_provider_order(),
            // Only Claude ships a stable curated id for its cheapest model;
            // the other CLIs discover models at runtime, so they stay on their
            // own default until the user picks one.
            models: vec![UtilityModelChoice {
                provider: AgentProvider::CLAUDE,
                model_id: "haiku".to_string(),
            }],
        }
    }
}

impl UtilityModelPreferences {
    /// Returns the configured model id for a provider, if any.
    pub fn model_for(&self, provider: &AgentProvider) -> Option<&str> {
        self.models
            .iter()
            .find(|choice| &choice.provider == provider)
            .map(|choice| choice.model_id.trim())
            .filter(|model_id| !model_id.is_empty())
    }
}

/// A provider-scoped utility model selection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UtilityModelChoice {
    /// Provider the model belongs to.
    pub provider: AgentProvider,
    /// Provider-native model id, or an empty string for the provider default.
    pub model_id: String,
}

fn default_utility_provider_order() -> Vec<AgentProvider> {
    vec![
        AgentProvider::CLAUDE,
        AgentProvider::CODEX,
        AgentProvider::new("opencode"),
        AgentProvider::new("grok"),
    ]
}

/// User-configurable policy for agent attention notifications.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationPreferences {
    /// Master switch for agent attention notifications.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Notify when an agent finishes a turn successfully.
    #[serde(default = "default_true")]
    pub notify_on_turn_complete: bool,
    /// Notify when an agent needs an approval or answer.
    #[serde(default = "default_true")]
    pub notify_on_input_required: bool,
    /// Notify when an agent turn fails.
    #[serde(default = "default_true")]
    pub notify_on_error: bool,
    /// Suppress remote-device pushes while the desktop client is actively open.
    #[serde(default = "default_true")]
    pub suppress_when_desktop_active: bool,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            notify_on_turn_complete: true,
            notify_on_input_required: true,
            notify_on_error: true,
            suppress_when_desktop_active: true,
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
            // Collapsed is the shipped default (every surveyed product landed
            // on collapsed-by-default; docs/ADAPTERS.md §7): tool activity
            // folds behind a single "Worked for…" line, expanded on demand.
            tool_details_mode: ToolDetailsMode::Collapsed,
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
    /// Fold contiguous tool runs behind a single "Worked for…" line.
    #[default]
    Collapsed,
    /// Group low-signal read-only tool chatter and expand only important artifacts.
    Auto,
    /// Prefer expanded tool details with minimal collapsing.
    Expanded,
    /// Prefer compact grouped tool details; suppress read-only output by default.
    Compact,
    /// Hide raw read-only tool detail bodies while keeping summary rows visible.
    HideReadOnlyDetails,
}

/// Partial preferences update payload accepted by the daemon API.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct UpdatePreferencesRequest {
    /// Optional workspace order update for project navigation.
    #[serde(default)]
    pub workspace_order: Option<Vec<String>>,
    /// Optional conversation preference updates.
    #[serde(default)]
    pub conversation: Option<ConversationPreferencesPatch>,
    /// Optional notification preference updates.
    #[serde(default)]
    pub notifications: Option<NotificationPreferencesPatch>,
    /// Optional background utility model updates.
    #[serde(default)]
    pub utility_models: Option<UtilityModelPreferencesPatch>,
}

/// Partial update payload for background utility model preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct UtilityModelPreferencesPatch {
    /// Optional replacement provider fallback order.
    #[serde(default)]
    pub provider_order: Option<Vec<AgentProvider>>,
    /// Optional replacement per-provider model selections.
    #[serde(default)]
    pub models: Option<Vec<UtilityModelChoice>>,
}

/// Partial update payload for notification preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct NotificationPreferencesPatch {
    /// Optional master switch update.
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Optional completed-turn notification update.
    #[serde(default)]
    pub notify_on_turn_complete: Option<bool>,
    /// Optional approval/question notification update.
    #[serde(default)]
    pub notify_on_input_required: Option<bool>,
    /// Optional failed-turn notification update.
    #[serde(default)]
    pub notify_on_error: Option<bool>,
    /// Optional desktop-active suppression update.
    #[serde(default)]
    pub suppress_when_desktop_active: Option<bool>,
}

/// Update sent by a local client to advertise whether the desktop UI is active.
/// The daemon treats an active state as a short lease and expires it when the
/// client stops heartbeating, so a crashed desktop cannot suppress pushes
/// forever.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClientActivityRequest {
    /// Whether the desktop client is currently visible and usable.
    pub active: bool,
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
    /// Provider-independent lifecycle used by clients for status presentation.
    #[serde(default)]
    pub lifecycle: ToolLifecycle,
    /// Artifact classification used by clients to decide prominence.
    #[serde(default)]
    pub artifact_kind: ToolArtifactKind,
    /// Normalized activity kind for grouping live and historical tool activity.
    #[serde(default)]
    pub activity_kind: ToolActivityKind,
    /// Whether this tool should stay inline in history or collapse into summaries.
    #[serde(default)]
    pub history_mode: ToolHistoryMode,
    /// Optional short summary hint for grouped tool-burst headers.
    #[serde(default)]
    pub summary_hint: Option<String>,
    /// Best-effort structured counts parsed from a provider's test-run output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_summary: Option<ToolTestSummary>,
    /// Cheap provider-output signals for transcript grouping and collapsed rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_output_summary: Option<ToolProviderOutputSummary>,
}

/// Provider-independent counts derived without decoding the retained raw output.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ToolProviderOutputSummary {
    /// Canonical text blocks already represented by structured tool detail.
    #[serde(default)]
    pub text_blocks: u64,
    /// Renderable image blocks.
    #[serde(default)]
    pub images: u64,
    /// Renderable audio blocks.
    #[serde(default)]
    pub audio: u64,
    /// Provider reference links.
    #[serde(default)]
    pub resource_links: u64,
    /// Embedded resources with stable URIs.
    #[serde(default)]
    pub embedded_resources: u64,
    /// Structured result objects outside the ordered content list.
    #[serde(default)]
    pub structured_results: u64,
}

/// Provider-independent summary of a test run. Raw output remains authoritative.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ToolTestSummary {
    /// Detected runner (`vitest`, `jest`, `pytest`, `cargo`, `go`, or newer).
    #[serde(default)]
    pub framework: Option<String>,
    /// Total individual tests when reported or safely derived.
    #[serde(default)]
    pub total: Option<u64>,
    /// Passed individual tests.
    #[serde(default)]
    pub passed: Option<u64>,
    /// Failed individual tests.
    #[serde(default)]
    pub failed: Option<u64>,
    /// Skipped, ignored, pending, or otherwise not-run tests.
    #[serde(default)]
    pub skipped: Option<u64>,
    /// Total suites/files when the runner reports them separately.
    #[serde(default)]
    pub suites_total: Option<u64>,
    /// Passed suites/files.
    #[serde(default)]
    pub suites_passed: Option<u64>,
    /// Failed suites/files.
    #[serde(default)]
    pub suites_failed: Option<u64>,
    /// Runner-reported wall duration, normalized to milliseconds.
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

/// Best-effort semantic action parsed from a shell command by the provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCommandAction {
    /// Open-ended action kind (`read`, `list_files`, `search`, or newer).
    pub action_kind: String,
    /// Command fragment associated with this action.
    pub command: String,
    /// Optional filename supplied for read actions.
    #[serde(default)]
    pub name: Option<String>,
    /// Optional path affected or inspected by the action.
    #[serde(default)]
    pub path: Option<String>,
    /// Optional search query supplied by the provider.
    #[serde(default)]
    pub query: Option<String>,
}

/// Application identity attached to an MCP tool invocation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolMcpAppContext {
    /// Stable connector identifier.
    pub connector_id: String,
    /// Human-readable application name, when supplied.
    #[serde(default)]
    pub app_name: Option<String>,
    /// Application action name, when supplied.
    #[serde(default)]
    pub action_name: Option<String>,
    /// Provider link identifier, when supplied.
    #[serde(default)]
    pub link_id: Option<String>,
    /// Resource URI used by the action, when supplied.
    #[serde(default)]
    pub resource_uri: Option<String>,
    /// Application template identifier, when supplied.
    #[serde(default)]
    pub template_id: Option<String>,
}

/// Structured content returned by a provider-defined dynamic tool.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolOutputContentItem {
    /// Text returned by the tool.
    Text {
        /// Exact returned text.
        text: String,
    },
    /// Image returned by the tool.
    Image {
        /// Renderable image URL or data URL.
        url: String,
    },
}

/// Latest status reported for one collaboration target thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCollabAgentState {
    /// Open-ended Codex state (`running`, `completed`, `errored`, and newer).
    pub status: String,
    /// Optional human-readable provider status detail.
    #[serde(default)]
    pub message: Option<String>,
}

/// One typed line emitted by a Codex hook run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolHookOutputEntry {
    /// Entry severity/category (`warning`, `stop`, `feedback`, `context`, or `error`).
    pub entry_kind: String,
    /// Exact hook output text.
    pub text: String,
}

/// Provider-native structured detail retained for a generic tool call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolCallDetail {
    /// Codex command execution metadata beyond its streamed output.
    CommandExecution {
        /// Exact shell command requested by the agent.
        command: String,
        /// Working directory in which the process ran.
        cwd: String,
        /// Best-effort semantic actions parsed by Codex.
        #[serde(default)]
        actions: Vec<ToolCommandAction>,
        /// Underlying PTY process identifier, when available.
        #[serde(default)]
        process_id: Option<String>,
        /// Total provider-reported duration in milliseconds.
        #[serde(default)]
        duration_ms: Option<u64>,
        /// Open-ended command source (`agent`, `userShell`, or newer).
        #[serde(default)]
        source: Option<String>,
    },
    /// Model Context Protocol tool invocation and its structured result.
    Mcp {
        /// MCP server name.
        server: String,
        /// MCP tool name.
        tool: String,
        /// Provider-native JSON arguments.
        arguments: Value,
        /// Provider-native MCP result, including content and structured content.
        #[serde(default)]
        result: Option<Value>,
        /// Provider error message, when the call failed.
        #[serde(default)]
        error: Option<String>,
        /// Provider-reported duration in milliseconds.
        #[serde(default)]
        duration_ms: Option<u64>,
        /// Connected application context, when available.
        #[serde(default)]
        app_context: Option<ToolMcpAppContext>,
    },
    /// Provider-defined dynamic tool invocation and typed returned content.
    Dynamic {
        /// Dynamic tool name.
        tool: String,
        /// Optional tool namespace.
        #[serde(default)]
        namespace: Option<String>,
        /// Provider-native JSON arguments.
        arguments: Value,
        /// Ordered text and image outputs.
        #[serde(default)]
        content_items: Vec<ToolOutputContentItem>,
        /// Provider success flag, when terminal.
        #[serde(default)]
        success: Option<bool>,
        /// Provider-reported duration in milliseconds.
        #[serde(default)]
        duration_ms: Option<u64>,
    },
    /// A Codex collaboration operation involving one or more agent threads.
    CollabAgent {
        /// Operation (`spawnAgent`, `sendInput`, `resumeAgent`, `wait`, or `closeAgent`).
        tool: String,
        /// Thread issuing the operation.
        sender_thread_id: String,
        /// Target or newly spawned thread ids.
        #[serde(default)]
        receiver_thread_ids: Vec<String>,
        /// Exact delegated prompt or follow-up input, when available.
        #[serde(default)]
        prompt: Option<String>,
        /// Requested model for a spawn.
        #[serde(default)]
        model: Option<String>,
        /// Requested reasoning effort for a spawn.
        #[serde(default)]
        reasoning_effort: Option<String>,
        /// Last known state keyed by target thread id.
        #[serde(default)]
        agent_states: std::collections::BTreeMap<String, ToolCollabAgentState>,
    },
    /// Lifecycle activity emitted by a spawned sub-agent thread.
    SubagentActivity {
        /// Activity (`started`, `interacted`, or `interrupted`).
        activity: String,
        /// Stable spawned thread id.
        agent_thread_id: String,
        /// Provider agent path/name.
        agent_path: String,
    },
    /// A Codex hook execution and its typed output.
    Hook {
        /// Hook lifecycle event (`preToolUse`, `subagentStart`, and newer).
        event_name: String,
        /// Handler implementation (`command`, `prompt`, or `agent`).
        handler_type: String,
        /// Whether the hook ran synchronously or asynchronously.
        execution_mode: String,
        /// Hook scope (`thread` or `turn`).
        scope: String,
        /// Provider-reported hook source file.
        source_path: String,
        /// Provider-reported runtime in milliseconds.
        #[serde(default)]
        duration_ms: Option<u64>,
        /// Optional terminal status detail.
        #[serde(default)]
        status_message: Option<String>,
        /// Ordered typed hook outputs.
        #[serde(default)]
        entries: Vec<ToolHookOutputEntry>,
    },
    /// A provider safety review of a potentially sensitive action.
    GuardianReview {
        /// Stable provider review identifier.
        review_id: String,
        /// Reviewed action category (`command`, `applyPatch`, `networkAccess`, and newer).
        action_kind: String,
        /// Human-readable exact action target or command.
        action: String,
        /// Working directory for filesystem or process actions, when supplied.
        #[serde(default)]
        cwd: Option<String>,
        /// Item or tool call under review, when the provider can identify one.
        #[serde(default)]
        target_item_id: Option<String>,
        /// Provider review state (`inProgress`, `approved`, `denied`, and newer).
        status: String,
        /// Provider-assigned risk level.
        #[serde(default)]
        risk_level: Option<String>,
        /// Provider-assigned user authorization level.
        #[serde(default)]
        user_authorization: Option<String>,
        /// Exact provider rationale, when supplied.
        #[serde(default)]
        rationale: Option<String>,
        /// Source of the terminal decision, when supplied.
        #[serde(default)]
        decision_source: Option<String>,
        /// Provider-reported review duration in milliseconds.
        #[serde(default)]
        duration_ms: Option<u64>,
    },
}

impl Default for ToolCallDisplay {
    fn default() -> Self {
        Self {
            is_read_only: false,
            has_side_effect: false,
            is_error: false,
            lifecycle: ToolLifecycle::Unknown,
            artifact_kind: ToolArtifactKind::None,
            activity_kind: ToolActivityKind::Other,
            history_mode: ToolHistoryMode::Full,
            summary_hint: None,
            test_summary: None,
            provider_output_summary: None,
        }
    }
}

/// Provider-independent lifecycle for one tool invocation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolLifecycle {
    /// The provider has not supplied a recognized lifecycle yet.
    #[default]
    Unknown,
    /// The call is accepted but has not started.
    Queued,
    /// The call is paused until the user approves it.
    AwaitingApproval,
    /// The tool is actively executing or streaming output.
    Running,
    /// The tool finished successfully.
    Succeeded,
    /// The tool finished with an error or non-zero exit code.
    Failed,
    /// The user or policy denied the invocation.
    Denied,
    /// Execution stopped before reaching a terminal result.
    Interrupted,
}

/// Lifecycle for assistant-authored text and reasoning content.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContentLifecycle {
    /// The provider announced content but has not emitted its first fragment.
    Pending,
    /// Content is actively receiving fragments.
    Streaming,
    /// Content reached a normal terminal state.
    #[default]
    Complete,
    /// The user or provider stopped the turn before content completed.
    Interrupted,
    /// The turn failed while producing this content.
    Error,
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

/// Normalized activity kind associated with a tool call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolActivityKind {
    /// Read or inspect a file or resource.
    Read,
    /// Search within a workspace or index.
    Search,
    /// List files, directories, or entries.
    List,
    /// Run a general command.
    Command,
    /// Edit or write source material.
    Edit,
    /// Run tests or verifications.
    Test,
    /// Approval or permission related action.
    Approval,
    /// Produce or inspect a diff.
    Diff,
    /// Search the web.
    WebSearch,
    /// View an image.
    ImageView,
    /// Context or compaction related action.
    Context,
    /// Fallback when no better semantic classification exists.
    #[default]
    Other,
}

/// History treatment associated with a tool call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolHistoryMode {
    /// Collapse low-signal tools into a compact summary block.
    Summary,
    /// Keep the tool inline as a full history item.
    #[default]
    Full,
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
    /// Recent workspace-level operational notices that do not belong in a transcript.
    #[serde(default)]
    pub service_notices: Vec<ServiceNotice>,
    /// Active, keyed workspace conditions. Unlike service notices, these describe
    /// current degradation and disappear when the underlying problem recovers.
    #[serde(default)]
    pub operational_conditions: Vec<OperationalCondition>,
    /// Latest provider-reported token usage keyed by thread id. Kept separate
    /// from thread summaries so frequent usage updates do not churn sidebars.
    #[serde(default)]
    pub thread_token_usage: std::collections::BTreeMap<String, ThreadTokenUsage>,
    /// Global FalconDeck preferences persisted by the daemon.
    #[serde(default)]
    pub preferences: FalconDeckPreferences,
    /// Installed extensions and their synchronized client-facing projections.
    #[serde(default)]
    pub extensions: ExtensionSnapshot,
    /// Bounded summaries for automation owned by this daemon.
    #[serde(default)]
    pub scheduled_tasks: Vec<ScheduledTaskSummary>,
}

/// Current lifecycle of a scheduled task definition.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledTaskStatus {
    /// Future occurrences may be dispatched.
    #[default]
    Active,
    /// Future occurrences are suppressed until resumed.
    Paused,
    /// A one-time task reached a terminal run.
    Completed,
}

/// Recurrence definition evaluated in an explicit IANA timezone.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScheduledTaskSchedule {
    /// A single wall-clock occurrence.
    Once {
        /// UTC instant at which the task is due.
        run_at: DateTime<Utc>,
        /// IANA timezone retained for display and edits.
        timezone: String,
    },
    /// A recurring RFC 5545 rule from the supported FalconDeck subset.
    Recurring {
        /// RFC 5545 RRULE string.
        rrule: String,
        /// IANA timezone used to resolve future wall-clock occurrences.
        timezone: String,
    },
}

/// State of one scheduled invocation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledTaskRunStatus {
    /// Accepted but waiting for daemon capacity.
    Queued,
    /// Native agent execution is active.
    Running,
    /// The provider requires a user response or approval.
    AwaitingInput,
    /// The native turn completed successfully.
    Succeeded,
    /// The native turn failed.
    Failed,
    /// Execution ended because the daemon or user interrupted it.
    Interrupted,
    /// An offline or overlapping recurring occurrence was intentionally omitted.
    Skipped,
}

/// Why a scheduled task invocation was created.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledTaskRunTrigger {
    /// The scheduler reached the next occurrence normally.
    Scheduled,
    /// A missed one-time occurrence was recovered after daemon startup.
    Late,
    /// A user explicitly selected Run now.
    Manual,
}

/// Bounded ledger entry for a scheduled invocation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledTaskRunSummary {
    /// Stable run identifier.
    pub id: String,
    /// Owning scheduled task identifier.
    pub task_id: String,
    /// Run lifecycle state.
    pub status: ScheduledTaskRunStatus,
    /// Source of this invocation.
    pub trigger: ScheduledTaskRunTrigger,
    /// Occurrence time that caused the run.
    pub scheduled_for: DateTime<Utc>,
    /// Actual execution start, when dispatch began.
    #[serde(default)]
    pub started_at: Option<DateTime<Utc>>,
    /// Terminal time, when available.
    #[serde(default)]
    pub completed_at: Option<DateTime<Utc>>,
    /// Native workspace containing the generated thread.
    pub workspace_id: String,
    /// Native provider-backed thread created for this run.
    #[serde(default)]
    pub thread_id: Option<String>,
    /// Short result or failure preview; transcripts remain provider-owned.
    #[serde(default)]
    pub preview: Option<String>,
}

/// Compact scheduled task representation included in daemon snapshots.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledTaskSummary {
    /// Stable task identifier.
    pub id: String,
    /// User-visible title.
    pub title: String,
    /// Short prompt excerpt for bounded list/search presentation.
    #[serde(default)]
    pub prompt_preview: String,
    /// Current lifecycle state.
    pub status: ScheduledTaskStatus,
    /// Recurrence definition.
    pub schedule: ScheduledTaskSchedule,
    /// Workspace that receives generated threads.
    pub workspace_id: String,
    /// Provider used for every run.
    pub provider: AgentProvider,
    /// Next due UTC instant, absent for paused or completed tasks.
    #[serde(default)]
    pub next_run_at: Option<DateTime<Utc>>,
    /// Latest ledger entry, when the task has run.
    #[serde(default)]
    pub last_run: Option<ScheduledTaskRunSummary>,
    /// Last definition update time.
    pub updated_at: DateTime<Utc>,
}

/// Complete daemon-owned scheduled task definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledTaskDetail {
    /// Snapshot-friendly summary fields.
    #[serde(flatten)]
    pub summary: ScheduledTaskSummary,
    /// Durable prompt sent in a fresh native thread for every invocation.
    pub prompt: String,
    /// Optional provider model override.
    #[serde(default)]
    pub model_id: Option<String>,
    /// Optional reasoning effort override.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// Optional provider collaboration mode.
    #[serde(default)]
    pub collaboration_mode_id: Option<String>,
    /// Captured approval policy for unattended execution.
    #[serde(default)]
    pub approval_policy: Option<String>,
    /// Captured provider permission mode.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Captured Codex sandbox mode.
    #[serde(default)]
    pub sandbox_mode: Option<String>,
    /// Whether each run uses the project folder or an isolated checkout.
    #[serde(default)]
    pub isolation: ThreadIsolation,
    /// Skills explicitly selected for every run.
    #[serde(default)]
    pub selected_skills: Vec<SelectedSkillReference>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
}

/// Payload used to create a daemon-owned scheduled task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateScheduledTaskRequest {
    /// User-visible title.
    pub title: String,
    /// Durable prompt sent on every invocation.
    pub prompt: String,
    /// Workspace that receives generated threads.
    pub workspace_id: String,
    /// Explicit provider used on every invocation.
    pub provider: AgentProvider,
    /// One-time or recurring schedule.
    pub schedule: ScheduledTaskSchedule,
    /// Optional provider model override.
    #[serde(default)]
    pub model_id: Option<String>,
    /// Optional reasoning effort override.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// Optional provider collaboration mode.
    #[serde(default)]
    pub collaboration_mode_id: Option<String>,
    /// Captured approval policy.
    #[serde(default)]
    pub approval_policy: Option<String>,
    /// Captured permission mode.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Captured sandbox mode.
    #[serde(default)]
    pub sandbox_mode: Option<String>,
    /// Checkout isolation for generated threads.
    #[serde(default)]
    pub isolation: ThreadIsolation,
    /// Skills explicitly selected for every run.
    #[serde(default)]
    pub selected_skills: Vec<SelectedSkillReference>,
}

/// Partial update for a scheduled task definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct UpdateScheduledTaskRequest {
    /// Replacement title.
    #[serde(default)]
    pub title: Option<String>,
    /// Replacement durable prompt.
    #[serde(default)]
    pub prompt: Option<String>,
    /// Replacement status; completed is reserved for scheduler transitions.
    #[serde(default)]
    pub status: Option<ScheduledTaskStatus>,
    /// Replacement recurrence definition.
    #[serde(default)]
    pub schedule: Option<ScheduledTaskSchedule>,
    /// Replacement workspace on the same owning daemon.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Replacement provider on the same owning host and workspace.
    #[serde(default)]
    pub provider: Option<AgentProvider>,
    /// Replacement model; omitted leaves the current value unchanged.
    #[serde(default, deserialize_with = "deserialize_present_option")]
    pub model_id: Option<Option<String>>,
    /// Replacement reasoning effort.
    #[serde(default, deserialize_with = "deserialize_present_option")]
    pub reasoning_effort: Option<Option<String>>,
    /// Replacement collaboration mode.
    #[serde(default, deserialize_with = "deserialize_present_option")]
    pub collaboration_mode_id: Option<Option<String>>,
    /// Replacement approval policy.
    #[serde(default, deserialize_with = "deserialize_present_option")]
    pub approval_policy: Option<Option<String>>,
    /// Replacement permission mode.
    #[serde(default, deserialize_with = "deserialize_present_option")]
    pub permission_mode: Option<Option<String>>,
    /// Replacement sandbox mode.
    #[serde(default, deserialize_with = "deserialize_present_option")]
    pub sandbox_mode: Option<Option<String>>,
    /// Replacement checkout isolation.
    #[serde(default)]
    pub isolation: Option<ThreadIsolation>,
    /// Replacement selected skills.
    #[serde(default)]
    pub selected_skills: Option<Vec<SelectedSkillReference>>,
}

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Installed extension catalog plus bounded client-facing view state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ExtensionSnapshot {
    /// Extensions known to this daemon.
    pub catalog: Vec<ExtensionSummary>,
    /// Latest non-secret view state published by enabled extensions.
    pub views: Vec<ExtensionView>,
}

/// Client-visible state for an installed extension.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtensionSummary {
    /// Globally unique extension id.
    pub id: String,
    /// User-facing extension name.
    pub name: String,
    /// Installed semantic version.
    pub version: String,
    /// Bundled, local-path, or packed-archive source label.
    pub source: String,
    /// Whether this package ships with FalconDeck.
    pub bundled: bool,
    /// Whether FalconDeck should activate the extension.
    pub enabled: bool,
    /// Current lifecycle state.
    pub status: ExtensionStatus,
    /// Latest activation or action failure.
    #[serde(default)]
    pub last_error: Option<String>,
    /// Named UI and action contribution points.
    #[serde(default)]
    pub contributes: ExtensionContributions,
    /// Capabilities requested by the manifest.
    #[serde(default)]
    pub permissions: Vec<String>,
    /// User-approved capabilities currently available to this extension.
    #[serde(default)]
    pub granted_permissions: Vec<String>,
}

/// Reduced thread projection exposed by the `threads:read` extension facet.
/// Transcript content and message previews are intentionally absent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionThreadSummary {
    /// Stable thread identifier.
    pub id: String,
    /// Stable owning workspace identifier.
    pub workspace_id: String,
    /// User-visible thread title.
    pub title: String,
    /// Current thread lifecycle state.
    pub status: ThreadStatus,
    /// Last summary update time.
    pub updated_at: DateTime<Utc>,
    /// Count of unresolved approval requests.
    pub pending_approval_count: u32,
    /// Count of unresolved question requests.
    pub pending_question_count: u32,
}

/// Extension lifecycle visible in Settings and diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionStatus {
    /// Installed but not activated.
    #[default]
    Disabled,
    /// Ready to handle actions.
    Active,
    /// Activation or execution failed without affecting the daemon.
    Error,
}

/// Stable named surfaces an extension contributes to FalconDeck clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionContributions {
    /// Actions shown in a thread context menu.
    #[serde(default)]
    pub thread_menu_actions: Vec<ExtensionActionContribution>,
    /// Decorations rendered on thread rows.
    #[serde(default)]
    pub thread_decorations: Vec<ExtensionViewContribution>,
    /// Filters made available above the thread list.
    #[serde(default)]
    pub sidebar_filters: Vec<ExtensionViewContribution>,
    /// Named full-main-area surfaces rendered by clients.
    #[serde(default)]
    pub panels: Vec<ExtensionViewContribution>,
}

/// Declared action contribution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtensionActionContribution {
    /// Identifier unique within the extension.
    pub id: String,
    /// User-facing action title.
    pub title: String,
}

/// Declared contribution bound to synchronized view state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtensionViewContribution {
    /// Identifier unique within the extension.
    pub id: String,
    /// User-facing title when the host surface has one.
    #[serde(default)]
    pub title: Option<String>,
    /// Manifest-declared view id consumed by the contribution.
    pub view: String,
    /// Optional declarative fallback rendered before the host publishes a view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<ExtensionUiDocument>,
}

/// Versioned declarative UI rendered by FalconDeck clients without extension code.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExtensionUiDocument {
    /// Declarative component vocabulary version.
    pub version: u16,
    /// Root component for this contribution.
    pub root: ExtensionUiNode,
}

/// A bounded component in the extension declarative UI vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ExtensionUiNode {
    /// Vertical layout.
    Stack {
        /// Spacing between children.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gap: Option<ExtensionUiGap>,
        /// Child components.
        children: Vec<ExtensionUiNode>,
    },
    /// Horizontal layout.
    Row {
        /// Spacing between children.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gap: Option<ExtensionUiGap>,
        /// Whether children may wrap onto another line.
        #[serde(default)]
        wrap: bool,
        /// Child components.
        children: Vec<ExtensionUiNode>,
    },
    /// Plain localized display text supplied by the extension.
    Text {
        /// Text content.
        text: String,
        /// Semantic text treatment.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<ExtensionUiTextStyle>,
        /// Semantic colour treatment.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tone: Option<ExtensionUiTone>,
    },
    /// Compact label.
    Badge {
        /// Badge content.
        text: String,
        /// Semantic colour treatment.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tone: Option<ExtensionUiTone>,
    },
    /// Visual and semantic separation between adjacent content.
    Divider {},
    /// Button bound to a manifest-declared extension action.
    Button {
        /// Visible control label.
        label: String,
        /// Action invocation data.
        action: ExtensionUiActionBinding,
        /// Semantic button treatment.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        variant: Option<ExtensionUiButtonVariant>,
        /// Whether the control is unavailable.
        #[serde(default, skip_serializing_if = "is_false")]
        disabled: bool,
    },
    /// Semantic list of declarative child components.
    List {
        /// Items rendered in source order.
        items: Vec<ExtensionUiNode>,
    },
    /// Client-local selection bound to bounded thread-scoped extension views.
    Select {
        /// Stable state key within this document.
        id: String,
        /// Accessible and visible control label.
        label: String,
        /// Whether more than one option can be selected.
        #[serde(default)]
        multiple: bool,
        /// Available choices.
        options: Vec<ExtensionUiSelectOption>,
        /// Declarative predicate applied by the client.
        binding: ExtensionUiFilterBinding,
    },
    /// Standard lifecycle, empty, or failure presentation.
    State {
        /// State presentation kind.
        state: ExtensionUiStateKind,
        /// Short state title.
        title: String,
        /// Optional supporting copy.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Spacing tokens available to declarative extension layouts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionUiGap {
    /// No added spacing.
    None,
    /// Compact spacing.
    Small,
    /// Default spacing.
    Medium,
    /// Spacious grouping.
    Large,
}

/// Typography roles available to extension text.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionUiTextStyle {
    /// Default body copy.
    Body,
    /// Section heading.
    Heading,
    /// Supporting copy.
    Caption,
    /// Machine-readable content.
    Mono,
}

/// Semantic colours mapped to the active FalconDeck theme.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionUiTone {
    /// Default foreground.
    Default,
    /// De-emphasized foreground.
    Muted,
    /// FalconDeck accent.
    Accent,
    /// Successful state.
    Success,
    /// Warning state.
    Warning,
    /// Dangerous or failed state.
    Danger,
    /// Informational state.
    Info,
    /// Neutral grey swatch.
    Gray,
    /// Red swatch.
    Red,
    /// Orange swatch.
    Orange,
    /// Yellow swatch.
    Yellow,
    /// Green swatch.
    Green,
    /// Blue swatch.
    Blue,
    /// Purple swatch.
    Purple,
    /// Pink swatch.
    Pink,
}

/// Semantic visual treatments for extension buttons.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionUiButtonVariant {
    /// Standard secondary action.
    Secondary,
    /// Primary action.
    Primary,
    /// Low-emphasis action.
    Ghost,
    /// Destructive action.
    Danger,
}

/// Manifest-declared action invocation emitted by a declarative button.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionUiActionBinding {
    /// Action identifier declared by this extension.
    pub action_id: String,
    /// Bounded action-specific input.
    #[serde(default)]
    pub input: Value,
    /// Optional literal entity target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ExtensionViewScope>,
}

/// Choice available in a declarative select control.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExtensionUiSelectOption {
    /// Stable value used by the binding.
    pub value: String,
    /// Visible option label.
    pub label: String,
    /// Optional semantic swatch or tone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<ExtensionUiTone>,
}

/// Bounded client-side filter over thread-scoped extension projections.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionUiFilterBinding {
    /// Thread-scoped view id containing filter membership values.
    pub view: String,
    /// Object-key path to an array of option values.
    pub path: Vec<String>,
    /// Matching operation.
    pub operator: ExtensionUiFilterOperator,
}

/// Matching operations supported by declarative extension filters.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionUiFilterOperator {
    /// A thread matches when any selected value appears in its projection.
    IncludesAny,
}

/// Standard presentation kinds for declarative states.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionUiStateKind {
    /// Work is in progress.
    Loading,
    /// No content is available.
    Empty,
    /// Content could not be produced.
    Error,
}

/// Bounded non-secret extension state synchronized to clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtensionView {
    /// Publishing extension id.
    pub extension_id: String,
    /// Manifest-declared view id.
    pub view_id: String,
    /// Optional entity scope; absent means daemon-global.
    #[serde(default)]
    pub scope: Option<ExtensionViewScope>,
    /// JSON payload interpreted by the declared contribution.
    pub value: Value,
    /// Last successful publication time.
    pub updated_at: DateTime<Utc>,
}

/// Entity associated with an extension projection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ExtensionViewScope {
    /// Open entity kind such as `thread` or `workspace`.
    pub kind: String,
    /// FalconDeck entity id.
    pub id: String,
}

/// Request to enable or disable an installed extension.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateExtensionRequest {
    /// Desired activation state.
    pub enabled: bool,
}

/// Request to grant or revoke one manifest-declared extension permission.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateExtensionPermissionRequest {
    /// Stable permission identifier such as `threads:read`.
    pub permission: String,
    /// Whether the permission should be present in the daemon-owned grant set.
    pub granted: bool,
}

/// Generic invocation of a manifest-declared extension action.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InvokeExtensionActionRequest {
    /// Optional entity that initiated the action.
    #[serde(default)]
    pub target: Option<ExtensionViewScope>,
    /// Action-specific, size-bounded input.
    #[serde(default)]
    pub input: Value,
}

/// Result returned by a generic extension action.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtensionActionResponse {
    /// Action-specific result suitable for declarative clients.
    #[serde(default)]
    pub result: Value,
    /// Projections changed by the action.
    #[serde(default)]
    pub updated_views: Vec<ExtensionView>,
}

/// Retained operational notice scoped to a workspace rather than a thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServiceNotice {
    /// Stable notice identity for replay deduplication and local dismissal.
    pub id: String,
    /// Workspace affected by the notice.
    pub workspace_id: String,
    /// Notice severity.
    pub level: ServiceLevel,
    /// Human-readable provider detail.
    pub message: String,
    /// Provider notification method, when known.
    #[serde(default)]
    pub raw_method: Option<String>,
    /// When FalconDeck received the notice.
    pub created_at: DateTime<Utc>,
}

/// Active workspace-level degradation that remains relevant until explicitly cleared.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OperationalCondition {
    /// Stable identity retained across updates to the same condition.
    pub id: String,
    /// Stable semantic key within the workspace, such as `codex_connection`.
    pub key: String,
    /// Workspace affected by the condition.
    pub workspace_id: String,
    /// Current severity.
    pub level: ServiceLevel,
    /// Human-readable explanation and recovery guidance when known.
    pub message: String,
    /// Provider or daemon source associated with the condition.
    #[serde(default)]
    pub source: Option<String>,
    /// When this condition first became active.
    pub created_at: DateTime<Utc>,
    /// When its severity or message last changed.
    pub updated_at: DateTime<Utc>,
}

/// Provider-reported token counts for one scope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenUsageBreakdown {
    /// Total tokens in this breakdown.
    pub total_tokens: u64,
    /// Non-cached prompt tokens.
    pub input_tokens: u64,
    /// Prompt tokens served from provider cache.
    pub cached_input_tokens: u64,
    /// Generated response tokens.
    pub output_tokens: u64,
    /// Generated reasoning tokens, when separately reported.
    pub reasoning_output_tokens: u64,
}

/// Latest context usage reported for a thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadTokenUsage {
    /// Aggregate usage for the active thread context.
    pub total: TokenUsageBreakdown,
    /// Usage attributed to the latest model call.
    #[serde(default)]
    pub last: Option<TokenUsageBreakdown>,
    /// Maximum model context size in tokens, when reported.
    #[serde(default)]
    pub model_context_window: Option<u64>,
    /// Provider notification time, when available.
    #[serde(default)]
    pub updated_at: Option<DateTime<Utc>>,
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
    /// Optional native collaboration mode for the new thread.
    #[serde(default)]
    pub collaboration_mode_id: Option<String>,
    /// Optional approval policy for the new thread.
    pub approval_policy: Option<String>,
    /// Optional Codex sandbox mode for the new thread.
    #[serde(default)]
    pub sandbox_mode: Option<String>,
    /// Optional Claude permission mode for the new thread.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Where the thread's turns run. Fixed at creation — a thread cannot move
    /// between the project folder and an isolated copy afterwards.
    #[serde(default)]
    pub isolation: ThreadIsolation,
    /// Source thread when this thread is a cross-provider continuation.
    /// The source session remains unchanged; this only records navigation and
    /// provenance for the newly created destination thread.
    #[serde(default)]
    pub handoff_from: Option<ThreadHandoffSource>,
}

/// Provenance for a thread created by handing work to another provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadHandoffSource {
    /// FalconDeck thread that supplied the handoff context.
    pub thread_id: String,
    /// Provider that owns the source thread.
    pub provider: AgentProvider,
}

/// Request payload used to fork a provider-owned thread at a completed turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForkThreadRequest {
    /// Workspace identifier that owns the source thread.
    pub workspace_id: String,
    /// Provider thread to branch without modifying the source.
    pub thread_id: String,
    /// Last completed provider turn to retain, inclusive.
    pub last_turn_id: String,
}

/// Working directory a thread's turns run in.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThreadIsolation {
    /// Run in the workspace folder itself, on whatever branch is checked out.
    #[default]
    ProjectFolder,
    /// Run in a private checkout on its own branch.
    Isolated,
}

/// How an isolated checkout was materialized. New checkouts use worktrees;
/// clone remains in the protocol so existing clone-backed threads can be
/// rehydrated and cleaned up safely.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadVariantKind {
    /// Legacy copy-on-write copy of the whole working tree.
    Clone,
    /// `git worktree` checkout plus an allowlist of untracked files.
    Worktree,
}

/// The isolated checkout backing one thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadVariant {
    /// Short identifier, unique within the project; also the branch suffix.
    pub slug: String,
    /// Absolute path to the checkout on the machine owning the workspace.
    pub path: String,
    /// Branch the checkout was switched to.
    pub branch: String,
    /// Mechanism used to create it.
    pub kind: ThreadVariantKind,
}

/// Request payload used to update thread-level agent settings.
///
/// Fields wrapped in a double `Option` distinguish "leave unchanged" (absent)
/// from "clear the value" (explicit `null`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateThreadRequest {
    /// Workspace identifier that owns the thread.
    pub workspace_id: String,
    /// Thread identifier being updated.
    pub thread_id: String,
    /// Optional thread title override.
    #[serde(default)]
    pub title: Option<String>,
    /// Optional provider override for the thread.
    #[serde(default)]
    pub provider: Option<AgentProvider>,
    /// Model identifier override for future turns; absent leaves it unchanged.
    #[serde(default, deserialize_with = "deserialize_explicit_option")]
    pub model_id: Option<Option<String>>,
    /// Reasoning effort override for future turns; absent leaves it unchanged.
    #[serde(default, deserialize_with = "deserialize_explicit_option")]
    pub reasoning_effort: Option<Option<String>>,
    /// Collaboration mode override for future turns; explicit `null` clears it.
    #[serde(default, deserialize_with = "deserialize_explicit_option")]
    pub collaboration_mode_id: Option<Option<String>>,
    /// Service tier override for future turns; explicit `null` clears it.
    #[serde(default, deserialize_with = "deserialize_explicit_option")]
    pub service_tier: Option<Option<String>>,
    /// Optional pin state override for the thread.
    #[serde(default)]
    pub pinned: Option<bool>,
    /// Clear the retained app-shutdown interruption after the user has seen it.
    #[serde(default)]
    pub acknowledge_interruption: Option<bool>,
    /// Claude permission mode override; explicit `null` clears it.
    #[serde(default, deserialize_with = "deserialize_explicit_option")]
    pub permission_mode: Option<Option<String>>,
    /// Codex approval policy override; explicit `null` clears it.
    #[serde(default, deserialize_with = "deserialize_explicit_option")]
    pub approval_policy: Option<Option<String>>,
    /// Codex sandbox mode override; explicit `null` clears it.
    #[serde(default, deserialize_with = "deserialize_explicit_option")]
    pub sandbox_mode: Option<Option<String>>,
}

/// Deserializes a present-but-possibly-null field into `Some(inner)`, so a
/// missing field (`None` via `#[serde(default)]`) is distinguishable from an
/// explicit `null` (`Some(None)`).
fn deserialize_explicit_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
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

/// Renderable image produced or inspected by an agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationImage {
    /// Stable asset identifier, independent of the enclosing conversation item.
    pub id: String,
    /// Optional display filename.
    pub name: Option<String>,
    /// Optional image MIME type.
    pub mime_type: Option<String>,
    /// Client-renderable URL or compact daemon-local path.
    pub url: String,
    /// Absolute daemon-local path when the asset is file-backed.
    pub local_path: Option<String>,
    /// Provider-supplied description used for accessibility.
    pub alt_text: Option<String>,
}

/// Open-ended provider-native action represented by a web-search item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct WebSearchActionKind(String);

impl WebSearchActionKind {
    /// Creates an action kind without discarding provider extensions.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Returns the normalized known action or raw provider extension.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Structured web research activity emitted by an agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationWebSearch {
    /// Stable action identifier, independent of the enclosing item.
    pub id: String,
    /// Provider's top-level display query.
    pub query: String,
    /// Open-ended provider action. Known values are `search`, `open_page`, and
    /// `find_in_page`; newer values remain intact for forward-compatible UI.
    pub action_kind: WebSearchActionKind,
    /// All search queries when a batched search action supplied them.
    #[serde(default)]
    pub queries: Vec<String>,
    /// Page URL for open-page and find-in-page actions.
    pub url: Option<String>,
    /// Match pattern for find-in-page actions.
    pub pattern: Option<String>,
}

/// One provider-reported file mutation within a file-change item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationFileChange {
    /// Workspace-relative or absolute path supplied by the provider.
    pub path: String,
    /// Open-ended provider change kind (`add`, `delete`, `update`, or newer).
    pub change_kind: String,
    /// Unified diff for this path, when available.
    #[serde(default)]
    pub diff: String,
    /// Destination path when an update also moves or renames the file.
    #[serde(default)]
    pub move_path: Option<String>,
}

/// Provider-supplied role of an assistant message within a turn.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantMessagePhase {
    /// Interim narration; more work or output may follow.
    Commentary,
    /// Terminal answer for the current turn.
    FinalAnswer,
}

/// A file-backed citation attached to an assistant message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryCitationEntry {
    /// File or memory-note path supplied by the provider.
    pub path: String,
    /// Inclusive one-based start line when available.
    pub line_start: u32,
    /// Inclusive one-based end line when available.
    pub line_end: u32,
    /// Provider explanation of what the cited range supports.
    pub note: String,
}

/// Structured memory evidence attached to a Codex assistant response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationMemoryCitation {
    /// Cited file ranges and provider notes.
    #[serde(default)]
    pub entries: Vec<MemoryCitationEntry>,
    /// Native threads from which the memory evidence originated.
    #[serde(default)]
    pub thread_ids: Vec<String>,
}

/// Provider-emitted evidence attached to an assistant response.
///
/// `kind` remains open-ended so newer providers can add citation families
/// without breaking older FalconDeck clients. A citation is evidence only
/// when the provider attaches it to assistant content; tool/search activity
/// is intentionally represented elsewhere.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationCitation {
    /// Stable FalconDeck identity assigned when this evidence first joins an
    /// assistant message. Older daemon history may omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Provider citation discriminator, for example
    /// `web_search_result_location` or `search_result_location`.
    pub kind: String,
    /// Canonical web URL supplied by the provider, when applicable.
    #[serde(default)]
    pub url: Option<String>,
    /// Stable non-web source identifier supplied by the provider.
    #[serde(default)]
    pub source: Option<String>,
    /// Human-readable source title supplied by the provider.
    #[serde(default)]
    pub title: Option<String>,
    /// Exact supporting excerpt supplied by the provider.
    #[serde(default)]
    pub cited_text: Option<String>,
    /// Provider location metadata used to preserve citation identity and show
    /// the exact document, page, block, or search-result range when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locator: Option<ConversationCitationLocator>,
}

/// Provider-native location of one assistant citation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationCitationLocator {
    /// Citation emitted by Anthropic's server-side web-search tool.
    WebSearch {
        /// Opaque provider reference stable across streamed citation updates.
        encrypted_index: String,
    },
    /// Citation into a provider-supplied search-result content block array.
    SearchResult {
        /// Zero-based search-result position in provider context.
        search_result_index: u64,
        /// Inclusive zero-based first content block.
        start_block_index: u64,
        /// Exclusive zero-based end content block.
        end_block_index: u64,
    },
    /// Character range within a cited document.
    Char {
        /// Zero-based document position in provider context.
        document_index: u64,
        /// Inclusive zero-based character offset.
        start_char_index: u64,
        /// Exclusive zero-based character offset.
        end_char_index: u64,
        /// Provider file identity, when the source is an uploaded file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
    },
    /// Page range within a cited document.
    Page {
        /// Zero-based document position in provider context.
        document_index: u64,
        /// Inclusive one-based first page.
        start_page_number: u64,
        /// Inclusive one-based last page.
        end_page_number: u64,
        /// Provider file identity, when the source is an uploaded file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
    },
    /// Content-block range within a cited document.
    ContentBlock {
        /// Zero-based document position in provider context.
        document_index: u64,
        /// Inclusive zero-based first content block.
        start_block_index: u64,
        /// Exclusive zero-based end content block.
        end_block_index: u64,
        /// Provider file identity, when the source is an uploaded file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
    },
}

impl ConversationCitation {
    /// Returns whether two provider payloads describe the same ordered source
    /// part, including legacy evidence that predates stable citation ids.
    pub fn shares_identity_with(&self, other: &Self) -> bool {
        if self.kind.trim() != other.kind.trim() {
            return false;
        }

        if let (Some(left), Some(right)) = (non_empty(&self.id), non_empty(&other.id)) {
            return left == right;
        }
        if let (Some(left), Some(right)) = (&self.locator, &other.locator) {
            return left == right;
        }

        let left_references = [non_empty(&self.url), non_empty(&self.source)];
        let right_references = [non_empty(&other.url), non_empty(&other.source)];
        if left_references
            .iter()
            .flatten()
            .any(|left| right_references.iter().flatten().any(|right| left == right))
        {
            return true;
        }

        let either_has_reference = left_references.iter().flatten().next().is_some()
            || right_references.iter().flatten().next().is_some();
        if either_has_reference {
            return false;
        }

        if let (Some(left), Some(right)) = (non_empty(&self.title), non_empty(&other.title)) {
            return left == right;
        }
        matches!(
            (non_empty(&self.cited_text), non_empty(&other.cited_text)),
            (Some(left), Some(right)) if left == right
        )
    }

    /// Applies newer provider metadata without clearing evidence omitted by a
    /// partial citation delta or changing the part's stable identity.
    pub fn merge_metadata_from(&mut self, next: &Self) {
        if self.id.is_none() {
            self.id = next.id.clone();
        }
        merge_non_empty(&mut self.url, &next.url);
        merge_non_empty(&mut self.source, &next.source);
        merge_non_empty(&mut self.title, &next.title);
        merge_non_empty(&mut self.cited_text, &next.cited_text);
        if next.locator.is_some() {
            self.locator = next.locator.clone();
        }
    }
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn merge_non_empty(current: &mut Option<String>, next: &Option<String>) {
    if non_empty(next).is_some() {
        *current = next.clone();
    }
}

/// Upserts provider citations in first-seen order and assigns stable ids to
/// legacy or streamed evidence before it crosses the client protocol.
pub fn merge_conversation_citations(
    citations: &mut Vec<ConversationCitation>,
    incoming: impl IntoIterator<Item = ConversationCitation>,
    id_prefix: &str,
) {
    for (index, citation) in citations.iter_mut().enumerate() {
        if citation.id.is_none() {
            citation.id = Some(format!("{id_prefix}:citation:{index}"));
        }
    }

    for mut citation in incoming {
        if let Some(existing) = citations
            .iter_mut()
            .find(|existing| existing.shares_identity_with(&citation))
        {
            existing.merge_metadata_from(&citation);
            continue;
        }

        if citation.id.is_none() {
            let mut index = citations.len();
            loop {
                let candidate = format!("{id_prefix}:citation:{index}");
                if citations
                    .iter()
                    .all(|existing| existing.id.as_deref() != Some(candidate.as_str()))
                {
                    citation.id = Some(candidate);
                    break;
                }
                index += 1;
            }
        }
        citations.push(citation);
    }
}

/// Normalized provider availability for a skill entry.
///
/// Legacy two-provider projection kept for wire compatibility; the open
/// `SkillSummary::providers` list is the authoritative field. Derive this
/// with [`skill_availability_from_providers`] rather than choosing by hand.
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

/// Projects an open provider list onto the legacy availability lattice.
/// Lists outside the codex/claude pair collapse to `Both` — the least-wrong
/// value for old clients, which treat it as "offer everywhere".
pub fn skill_availability_from_providers(providers: &[AgentProvider]) -> SkillAvailability {
    let codex = providers.contains(&AgentProvider::CODEX);
    let claude = providers.contains(&AgentProvider::CLAUDE);
    match (codex, claude) {
        (true, false) => SkillAvailability::Codex,
        (false, true) => SkillAvailability::Claude,
        _ => SkillAvailability::Both,
    }
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
    /// Which providers can use this skill (legacy two-provider projection;
    /// prefer `providers`).
    pub availability: SkillAvailability,
    /// Open list of provider ids that can use this skill. Authoritative;
    /// empty only in payloads from daemons that predate the field.
    #[serde(default)]
    pub providers: Vec<AgentProvider>,
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

impl SkillSummary {
    /// Whether a provider can use this skill. Falls back to the legacy
    /// availability lattice when the open list is absent (old daemons).
    pub fn supports_provider(&self, provider: &AgentProvider) -> bool {
        if !self.providers.is_empty() {
            return self.providers.contains(provider);
        }
        match self.availability {
            SkillAvailability::Codex => *provider == AgentProvider::CODEX,
            SkillAvailability::Claude => *provider == AgentProvider::CLAUDE,
            SkillAvailability::Both => {
                *provider == AgentProvider::CODEX || *provider == AgentProvider::CLAUDE
            }
        }
    }
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
    /// Claude permission mode (acceptEdits | auto | dontAsk | bypassPermissions).
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Codex sandbox mode (read-only | workspace-write | danger-full-access).
    #[serde(default)]
    pub sandbox_mode: Option<String>,
}

impl ThreadAgentParams {
    /// Fills every unset field from `fallback`. Used when a provider's session
    /// records rehydrate a thread with partial params (Codex omits the service
    /// tier while it is standard, Claude sessions report nothing): what the
    /// provider states wins, and the rest falls back to the last-known values.
    pub fn merge_missing_from(&mut self, fallback: &Self) {
        fn fill(field: &mut Option<String>, fallback: &Option<String>) {
            if field.is_none() {
                *field = fallback.clone();
            }
        }
        fill(&mut self.model_id, &fallback.model_id);
        fill(&mut self.reasoning_effort, &fallback.reasoning_effort);
        fill(
            &mut self.collaboration_mode_id,
            &fallback.collaboration_mode_id,
        );
        fill(&mut self.approval_policy, &fallback.approval_policy);
        fill(&mut self.service_tier, &fallback.service_tier);
        fill(&mut self.permission_mode, &fallback.permission_mode);
        fill(&mut self.sandbox_mode, &fallback.sandbox_mode);
    }
}

/// Agent provider identifier.
///
/// An open, nominal string id rather than a closed enum so new providers
/// (opencode, grok, any ACP-speaking CLI) can be added without protocol
/// changes. `#[serde(transparent)]` keeps the wire format byte-identical to
/// the previous snake_case enum ("codex" / "claude").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(transparent)]
pub struct AgentProvider(std::borrow::Cow<'static, str>);

impl AgentProvider {
    /// `OpenAI` Codex-backed agent sessions.
    pub const CODEX: Self = Self(std::borrow::Cow::Borrowed("codex"));
    /// Claude CLI-backed agent sessions.
    pub const CLAUDE: Self = Self(std::borrow::Cow::Borrowed("claude"));

    /// Creates a provider id from an arbitrary string.
    pub fn new(id: impl Into<String>) -> Self {
        Self(std::borrow::Cow::Owned(id.into()))
    }

    /// The provider id as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// Deriving Default on the newtype would produce an empty string and silently
// strip providers from persisted state where the field is absent; the
// long-standing default is Codex.
// Capability schemas describe the provider as an open string identifier,
// exactly like the wire format.
impl schemars::JsonSchema for AgentProvider {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "AgentProvider".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        <String as schemars::JsonSchema>::json_schema(generator)
    }
}

impl Default for AgentProvider {
    fn default() -> Self {
        Self::CODEX
    }
}

impl std::fmt::Display for AgentProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl From<&str> for AgentProvider {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
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
    /// Optional approval policy override for this turn.
    pub approval_policy: Option<String>,
    /// Optional provider-specific service tier for this turn.
    pub service_tier: Option<String>,
    /// Optional Claude permission mode for this turn.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Optional Codex sandbox mode for this turn.
    #[serde(default)]
    pub sandbox_mode: Option<String>,
    /// Ask for this message to be injected into the thread's running turn
    /// instead of queued behind it. Honoured only when the thread is busy and
    /// its provider advertises `supports_steering`; otherwise the send falls
    /// back to the queue.
    #[serde(default)]
    pub steer: bool,
    /// Client-chosen id for the user message item this turn creates. Lets a
    /// client render the message optimistically and have the daemon's echo
    /// land on the same id instead of duplicating. Ignored unless it looks
    /// like a well-formed `user-*` id.
    #[serde(default)]
    pub user_item_id: Option<String>,
}

/// Request payload used to start a code review flow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartReviewRequest {
    /// Workspace identifier that owns the review target.
    pub workspace_id: String,
    /// Thread identifier where review output should be posted.
    pub thread_id: String,
    /// What the review should cover.
    pub target: ReviewTarget,
}

/// Target selection for a code review, mirroring the Codex `ReviewTarget`
/// protocol shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ReviewTarget {
    /// Review the working tree: staged, unstaged, and untracked files.
    UncommittedChanges,
    /// Review changes between the current branch and the given base branch.
    BaseBranch {
        /// Base branch to diff against.
        branch: String,
    },
    /// Review the changes introduced by a specific commit.
    Commit {
        /// Commit SHA to review.
        sha: String,
    },
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

/// Possible responses to a provider-authored implementation plan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanApprovalOutcome {
    /// Approve the plan and let the agent begin implementation.
    Approved,
    /// Keep the agent in plan mode and return optional revision feedback.
    Cancelled,
    /// Abandon the proposed plan without beginning implementation.
    Abandoned,
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
    /// Response payload for provider-authored implementation plans.
    PlanApproval {
        /// Terminal outcome expected by the provider's plan-mode request.
        outcome: PlanApprovalOutcome,
        /// Optional revision feedback when the plan is not approved.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
}

/// Non-sensitive outcome retained after an interactive request is resolved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveRequestResolution {
    /// Outcome visible in conversation history.
    pub outcome: InteractiveRequestOutcome,
    /// Timestamp when FalconDeck observed the resolution.
    pub resolved_at: DateTime<Utc>,
}

/// Possible terminal outcomes for an interactive request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractiveRequestOutcome {
    /// The request was allowed once.
    Allowed,
    /// The request and matching future requests were allowed.
    AlwaysAllowed,
    /// The request was denied.
    Denied,
    /// The user submitted answers. Answer values are deliberately not retained.
    Answered,
    /// The implementation plan was approved.
    PlanApproved,
    /// The implementation plan was returned for changes.
    PlanChangesRequested,
    /// The implementation plan was abandoned.
    PlanAbandoned,
    /// The request expired before it could be answered.
    Expired,
    /// The request was cancelled without an answer.
    Cancelled,
}

impl InteractiveRequestResolution {
    /// Creates the non-sensitive history record for a submitted response.
    #[must_use]
    pub fn from_response(
        response: &InteractiveResponsePayload,
        resolved_at: DateTime<Utc>,
    ) -> Self {
        let outcome = match response {
            InteractiveResponsePayload::Approval { decision } => match decision {
                ApprovalDecision::Allow => InteractiveRequestOutcome::Allowed,
                ApprovalDecision::Deny => InteractiveRequestOutcome::Denied,
                ApprovalDecision::AlwaysAllow => InteractiveRequestOutcome::AlwaysAllowed,
            },
            InteractiveResponsePayload::Question { .. } => InteractiveRequestOutcome::Answered,
            InteractiveResponsePayload::PlanApproval { outcome, .. } => match outcome {
                PlanApprovalOutcome::Approved => InteractiveRequestOutcome::PlanApproved,
                PlanApprovalOutcome::Cancelled => InteractiveRequestOutcome::PlanChangesRequested,
                PlanApprovalOutcome::Abandoned => InteractiveRequestOutcome::PlanAbandoned,
            },
        };
        Self {
            outcome,
            resolved_at,
        }
    }
}

/// Generic command result returned by mutating endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
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
///
/// Every field defaults so old clients and old daemons interoperate with the
/// fields they know. `sandbox_modes` and `permission_modes` are enumerated as
/// lists so the UI can render each provider's real options without a
/// client-side table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct AgentCapabilitySummary {
    /// Whether the provider can start review flows.
    #[serde(default)]
    pub supports_review: bool,
    /// Whether the provider supports thread goals.
    #[serde(default)]
    pub supports_goals: bool,
    /// Whether the provider accepts image inputs.
    #[serde(default)]
    pub supports_images: bool,
    /// Whether the provider exposes skills.
    #[serde(default)]
    pub supports_skills: bool,
    /// Whether running turns can be interrupted.
    #[serde(default)]
    pub supports_interrupt: bool,
    /// Whether a message can be injected into a running turn so the agent
    /// course-corrects without losing its work. Providers without this park
    /// the message in the thread queue instead.
    #[serde(default)]
    pub supports_steering: bool,
    /// Whether the provider can create a history-preserving branch at a turn boundary.
    #[serde(default)]
    pub supports_forking: bool,
    /// Sandbox modes the provider accepts; empty hides the sandbox picker.
    #[serde(default)]
    pub sandbox_modes: Vec<String>,
    /// Permission modes the provider accepts; empty hides the picker.
    #[serde(default)]
    pub permission_modes: Vec<String>,
}

impl AgentCapabilitySummary {
    /// Capability set for the Codex app-server provider.
    pub fn codex() -> Self {
        Self {
            supports_review: true,
            supports_goals: true,
            supports_images: true,
            supports_skills: true,
            supports_interrupt: true,
            supports_steering: true,
            supports_forking: true,
            sandbox_modes: vec![
                "read-only".to_string(),
                "workspace-write".to_string(),
                "danger-full-access".to_string(),
            ],
            // Codex app-server approvalPolicy values. `default` is the UI
            // provider-default choice and is translated to the daemon's safe
            // `on-request` fallback when sent on the wire.
            permission_modes: vec![
                "default".to_string(),
                "untrusted".to_string(),
                "on-failure".to_string(),
                "on-request".to_string(),
                "never".to_string(),
            ],
        }
    }

    /// Capability set for the Claude CLI provider.
    pub fn claude() -> Self {
        Self {
            supports_review: false,
            supports_goals: true,
            supports_images: true,
            supports_skills: true,
            supports_interrupt: true,
            // The Claude CLI reads `--input-format stream-json` for the whole
            // life of a turn, so extra user messages reach the running agent.
            supports_steering: true,
            supports_forking: false,
            sandbox_modes: Vec::new(),
            permission_modes: vec![
                "default".to_string(),
                "acceptEdits".to_string(),
                "auto".to_string(),
                "manual".to_string(),
                "dontAsk".to_string(),
                "plan".to_string(),
                "bypassPermissions".to_string(),
            ],
        }
    }

    /// Conservative capability set for a generic ACP provider; refined after
    /// the initialize handshake where the agent advertises more.
    pub fn acp_minimal() -> Self {
        Self {
            supports_interrupt: true,
            // Steering needs no agent capability: the daemon cancels the
            // in-flight `session/prompt` and re-prompts on the same session,
            // which the ACP contract supports for every agent.
            supports_steering: true,
            ..Self::default()
        }
    }
}

/// Per-provider summary for a workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceAgentSummary {
    /// Provider represented by this summary.
    pub provider: AgentProvider,
    /// Human-readable provider label for pickers.
    #[serde(default)]
    pub label: String,
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
    /// Capability flags reported by the provider.
    #[serde(default)]
    pub capabilities: AgentCapabilitySummary,
}

/// How FalconDeck knows about a coding harness (agent CLI).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HarnessKind {
    /// Native daemon backend (Codex app-server, Claude CLI subprocess).
    Builtin,
    /// Entry declared in `providers.json` speaking ACP.
    Acp,
    /// Known harness detected on the machine but not configured in
    /// FalconDeck yet. Shown so the panel can offer to set it up.
    Detected,
}

/// Install status of one coding harness on one host (local or SSH).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarnessSummary {
    /// Harness id (`codex`, `claude`, `opencode`, …; ACP entries use their
    /// providers.json id).
    pub id: String,
    /// Human-readable label for the settings panel.
    pub label: String,
    /// How FalconDeck knows about this harness.
    pub kind: HarnessKind,
    /// Binary name the daemon resolves and launches.
    pub bin: String,
    /// Absolute path when the binary was found, else `None`.
    #[serde(default)]
    pub resolved_path: Option<String>,
    /// Whether the binary currently exists on the host.
    #[serde(default)]
    pub installed: bool,
    /// Version reported by the binary (`<bin> --version`), when probed.
    #[serde(default)]
    pub version: Option<String>,
    /// Latest published version, when a registry check ran. On-demand only:
    /// this is `None` until the user asks for an update check.
    #[serde(default)]
    pub latest_version: Option<String>,
    /// True when `version` and `latest_version` are both known and differ.
    #[serde(default)]
    pub update_available: Option<bool>,
    /// Best-effort classification of how the binary was installed
    /// (npm, homebrew, cargo, local, unknown) based on its resolved path.
    #[serde(default)]
    pub install_source: Option<String>,
    /// Command FalconDeck can run to install/upgrade the harness, when
    /// managed. `None` for custom ACP entries and unknown harnesses.
    #[serde(default)]
    pub upgrade_command: Option<String>,
    /// Auth/subscription state line reported by the harness, when probed
    /// (e.g. Codex `codex login status`, Claude `claude auth status`).
    #[serde(default)]
    pub account_status: Option<String>,
}

/// Response for `GET /api/harnesses` and `POST /api/harnesses/refresh`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct HarnessesOverview {
    /// Host the statuses describe: `"local"` or the SSH target.
    pub host: String,
    /// One entry per known + configured harness, sorted by label.
    pub harnesses: Vec<HarnessSummary>,
}

/// Request body for `POST /api/harnesses/refresh`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct HarnessRefreshRequest {
    /// SSH alias or `user@host` to probe instead of this machine.
    #[serde(default)]
    pub ssh_target: Option<String>,
    /// Optional SSH port override.
    #[serde(default)]
    pub port: Option<u16>,
    /// Also look up latest published versions (network). Defaults to true;
    /// pass false for a cheap local re-probe.
    #[serde(default = "default_true")]
    pub include_latest: bool,
}

/// Request body for `POST /api/harnesses/upgrade`.
#[derive(Debug, Clone, Deserialize)]
pub struct HarnessUpgradeRequest {
    /// Harness id from the overview to install/upgrade.
    pub harness_id: String,
    /// SSH alias or `user@host` to upgrade on instead of this machine.
    #[serde(default)]
    pub ssh_target: Option<String>,
    /// Optional SSH port override.
    #[serde(default)]
    pub port: Option<u16>,
}

/// Lifecycle state of a harness install/upgrade job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessUpgradeStatus {
    /// Work is still in flight.
    Running,
    /// The install/upgrade command completed successfully.
    Completed,
    /// The command failed or timed out; `error` explains what.
    Failed,
}

/// Install/upgrade job state, also used verbatim as the status response
/// body. Progress lives only in memory, like provisioning jobs.
#[derive(Debug, Clone, Serialize)]
pub struct HarnessUpgradeJob {
    /// Job identifier.
    pub job_id: String,
    /// Harness id being installed/upgraded.
    pub harness_id: String,
    /// Harness label at the time the job started.
    pub label: String,
    /// Host the job runs on: `"local"` or the SSH target.
    pub host: String,
    /// Current lifecycle state.
    pub status: HarnessUpgradeStatus,
    /// Human-readable progress lines, including command output.
    pub log: Vec<String>,
    /// Failure reason when `status` is `failed`.
    pub error: Option<String>,
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
    /// Service tiers the model can run on beyond the provider's standard
    /// tier (e.g. Codex "Fast"); empty hides the speed picker.
    #[serde(default)]
    pub service_tiers: Vec<ServiceTierSummary>,
    /// Catalog default service tier id, when the provider configures one.
    #[serde(default)]
    pub default_service_tier: Option<String>,
}

/// Description of a service tier a model can run on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServiceTierSummary {
    /// Provider-specific tier identifier sent back on turn requests
    /// (Codex fast mode is `"priority"`).
    pub id: String,
    /// Human-readable tier name displayed to users (e.g. "Fast").
    pub name: String,
    /// Human-readable explanation of the tier's trade-off.
    pub description: String,
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
    /// Runtime transport selected when this thread was created.  This is
    /// intentionally thread-scoped: an active OpenCode session must never
    /// silently flip between native HTTP and ACP after an adapter failure.
    #[serde(default)]
    pub provider_transport: Option<String>,
    /// Source thread when this thread was created by a cross-provider handoff.
    #[serde(default)]
    pub handoff_from: Option<ThreadHandoffSource>,
    /// FalconDeck feature that created this native provider-backed thread.
    #[serde(default)]
    pub origin: Option<ThreadOrigin>,
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
    /// Whether the thread is pinned to the top of its project group.
    #[serde(default)]
    pub is_pinned: bool,
    /// Active goal attached to the thread, if any.
    #[serde(default)]
    pub goal: Option<ThreadGoal>,
    /// Turns accepted while the thread was busy, waiting to dispatch when the
    /// active turn ends. Ordered; clients render these as removable chips.
    #[serde(default)]
    pub queued_turns: Vec<QueuedTurnSummary>,
    /// Isolated checkout backing the thread, when it was started isolated.
    /// Absent means the thread runs in the workspace folder.
    #[serde(default)]
    pub variant: Option<ThreadVariant>,
}

/// FalconDeck-owned provenance attached to a native agent thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ThreadOrigin {
    /// A daemon-owned scheduled task created the thread for one invocation.
    ScheduledTask {
        /// Owning task identifier.
        task_id: String,
        /// Task title captured when the invocation started.
        title: String,
    },
    /// A daemon-owned automation created the thread for one invocation.
    Automation {
        /// Owning automation identifier.
        automation_id: String,
        /// Automation name captured when the invocation started.
        name: String,
    },
}

impl ThreadSummary {
    /// Directory this thread's turns, git status, and diffs operate in.
    ///
    /// The single answer to "where does this thread run" — every provider
    /// spawn and git call resolves it through here, because a site that reads
    /// the workspace path directly would silently run an isolated thread's
    /// agent in the project folder.
    pub fn working_directory<'a>(&'a self, workspace_path: &'a str) -> &'a str {
        self.variant
            .as_ref()
            .map_or(workspace_path, |variant| variant.path.as_str())
    }
}

/// Client-visible view of one queued turn. The full request (inputs,
/// attachments, skill selections) stays daemon-side; the wire carries only
/// what chips need.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueuedTurnSummary {
    /// Stable id used to remove the queued turn before it dispatches.
    pub id: String,
    /// Short text preview of the queued message.
    pub preview: String,
    /// Full text of the queued message; what in-place editing starts from
    /// (the preview is truncated, so editing from it would lose the tail).
    #[serde(default)]
    pub text: String,
    /// Number of image attachments riding along.
    #[serde(default)]
    pub attachment_count: usize,
    /// When the turn was queued.
    pub queued_at: chrono::DateTime<Utc>,
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

/// Persistent objective attached to a thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadGoal {
    /// User-provided objective the agent works toward.
    pub objective: String,
    /// Lifecycle status reported by the provider
    /// (active | paused | blocked | usageLimited | budgetLimited | complete).
    #[serde(default = "default_goal_status")]
    pub status: String,
    /// Optional output-token budget for the goal.
    #[serde(default)]
    pub token_budget: Option<i64>,
    /// Tokens consumed so far, when the provider reports usage.
    #[serde(default)]
    pub tokens_used: Option<i64>,
    /// Wall-clock seconds spent on the goal, when reported.
    #[serde(default)]
    pub time_used_seconds: Option<i64>,
}

fn default_goal_status() -> String {
    "active".to_string()
}

/// Request payload used to set or update a thread goal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SetThreadGoalRequest {
    /// Workspace identifier that owns the thread.
    pub workspace_id: String,
    /// Thread the goal applies to.
    pub thread_id: String,
    /// Objective text; required when creating a goal.
    #[serde(default)]
    pub objective: Option<String>,
    /// Optional output-token budget (Codex only).
    #[serde(default)]
    pub token_budget: Option<i64>,
    /// Optional status override, e.g. "paused" or "active" (Codex only).
    #[serde(default)]
    pub status: Option<String>,
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
    /// Provider-stable step identifier when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
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
    /// Exact normalized approval decisions offered by the provider. `None`
    /// denotes a legacy request; `Some([])` means the provider offered no
    /// supported decision and must remain visibly non-actionable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_decisions: Option<Vec<ApprovalDecision>>,
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
    /// Provider-authored implementation plan awaiting review.
    PlanApproval,
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

/// Provider-authored artifact metadata and bounded preview evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationArtifact {
    /// Human-readable artifact title.
    pub title: String,
    /// Open-ended provider artifact discriminator.
    pub artifact_kind: String,
    /// Provider reference or externally openable URL, when supplied.
    pub url: Option<String>,
    /// MIME type supplied by the provider, when known.
    pub mime_type: Option<String>,
    /// Provider version label, when the artifact is versioned.
    pub version: Option<String>,
    /// Text preview supplied inline by the provider, when available.
    pub content: Option<String>,
    /// Size-bounded provider artifact payload retained for inspection.
    pub payload: Value,
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
        /// Provider turn containing this message, when known.
        #[serde(default)]
        turn_id: Option<String>,
        /// Last completed turn before this message; the safe edit/fork boundary.
        #[serde(default)]
        previous_turn_id: Option<String>,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Assistant-authored message content.
    AssistantMessage {
        /// Stable item identifier.
        id: String,
        /// Assistant-visible text content.
        text: String,
        /// Interim commentary versus the terminal answer, when provided.
        #[serde(default)]
        phase: Option<AssistantMessagePhase>,
        /// Structured file-backed evidence supplied by the provider.
        #[serde(default)]
        memory_citation: Option<ConversationMemoryCitation>,
        /// Provider-emitted web, document, or retrieval citations.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        citations: Vec<ConversationCitation>,
        /// Streaming and terminal state for this response block.
        #[serde(default)]
        lifecycle: ContentLifecycle,
        /// Provider-reported explanation when the response failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
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
        /// Streaming and terminal state for this reasoning block.
        #[serde(default)]
        lifecycle: ContentLifecycle,
        /// Provider-reported or authoritatively derived elapsed time.
        #[serde(default)]
        duration_ms: Option<u64>,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Provider-authored code review and its lifecycle.
    CodeReview {
        /// Stable provider item identifier shared by review entry and result.
        id: String,
        /// Target or scope being reviewed, when supplied on entry.
        #[serde(default)]
        subject: Option<String>,
        /// Full provider-authored review findings, when available.
        #[serde(default)]
        content: String,
        /// Running and terminal state for the review operation.
        #[serde(default)]
        lifecycle: ContentLifecycle,
        /// Timestamp when review mode was first observed or restored.
        created_at: DateTime<Utc>,
    },
    /// Provider context compaction lifecycle receipt.
    ContextCompaction {
        /// Stable provider item identifier.
        id: String,
        /// Running or terminal state of the compaction operation.
        #[serde(default)]
        lifecycle: ToolLifecycle,
        /// Timestamp when compaction started or was restored.
        created_at: DateTime<Utc>,
        /// Timestamp when compaction reached a terminal state.
        #[serde(default)]
        completed_at: Option<DateTime<Utc>>,
    },
    /// Provider-authored artifact preview or generated deliverable.
    Artifact {
        /// Stable provider item identifier.
        id: String,
        /// Structured artifact presentation data.
        artifact: ConversationArtifact,
        /// Creating, streaming, ready, interrupted, or failed state.
        #[serde(default)]
        lifecycle: ContentLifecycle,
        /// Timestamp when the artifact was first observed or restored.
        created_at: DateTime<Utc>,
    },
    /// Forward-compatible provider output not understood by this FalconDeck version.
    Unsupported {
        /// Stable provider item identifier.
        id: String,
        /// Provider-native item discriminator.
        output_kind: String,
        /// Human-readable explanation of why the generic receipt is shown.
        reason: String,
        /// Size-bounded provider JSON retained for inspection and future clients.
        payload: Value,
        /// Streaming and terminal state observed for the provider item.
        #[serde(default)]
        lifecycle: ContentLifecycle,
        /// Timestamp when the item was first observed or restored.
        created_at: DateTime<Utc>,
    },
    /// Image generated or viewed by the agent.
    Image {
        /// Stable conversation item identifier.
        id: String,
        /// Optional short label displayed with the image.
        title: Option<String>,
        /// Renderable image asset metadata.
        image: ConversationImage,
        /// Loading and terminal state for the image.
        #[serde(default)]
        lifecycle: ContentLifecycle,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Structured web-search, page-open, or in-page-find activity.
    WebSearch {
        /// Stable conversation item identifier.
        id: String,
        /// Provider-native search action metadata.
        search: ConversationWebSearch,
        /// Loading and terminal state for the research action.
        #[serde(default)]
        lifecycle: ContentLifecycle,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
    },
    /// Structured file mutations emitted by an agent patch operation.
    FileChange {
        /// Stable provider item identifier.
        id: String,
        /// Ordered file mutations in the patch.
        changes: Vec<ConversationFileChange>,
        /// Raw provider status retained for diagnostics and forward compatibility.
        status: String,
        /// Provider-independent lifecycle used for consistent presentation.
        #[serde(default)]
        lifecycle: ToolLifecycle,
        /// Timestamp when the patch operation started.
        created_at: DateTime<Utc>,
        /// Timestamp when the patch operation reached a terminal state.
        #[serde(default)]
        completed_at: Option<DateTime<Utc>>,
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
        /// Display metadata derived by the daemon. Boxed so rich provider
        /// summaries do not inflate every ordinary transcript item.
        #[serde(default)]
        display: Box<ToolCallDisplay>,
        /// Provider-native structured metadata used by specialized renderers.
        /// Boxed so rare, metadata-heavy tools do not inflate every item in a
        /// long conversation vector.
        #[serde(default)]
        detail: Option<Box<ToolCallDetail>>,
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
        /// Interactive request payload. Boxed so rare prompt metadata does not
        /// inflate every ordinary transcript item in long thread vectors.
        request: Box<InteractiveRequest>,
        /// Timestamp when the item was created.
        created_at: DateTime<Utc>,
        /// Whether the request has already been resolved.
        resolved: bool,
        /// Non-sensitive terminal outcome, when FalconDeck observed one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolution: Option<InteractiveRequestResolution>,
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

/// Text field receiving an incremental conversation-item delta.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextDeltaTarget {
    /// The visible body of an assistant message.
    #[default]
    AssistantText,
    /// The short summary attached to a reasoning item.
    ReasoningSummary,
    /// The full content attached to a reasoning item.
    ReasoningContent,
    /// Incremental stdout/stderr aggregated for a tool call.
    ToolOutput,
    /// Streaming free-form plan text before an authoritative structured plan arrives.
    PlanExplanation,
}

/// One streamed PCM audio fragment produced by a realtime conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RealtimeAudioChunk {
    /// Provider item identifier when one is available.
    pub item_id: Option<String>,
    /// Base64-encoded interleaved signed 16-bit little-endian PCM samples.
    pub data: String,
    /// PCM sample rate in hertz.
    pub sample_rate: u32,
    /// Number of interleaved audio channels.
    pub num_channels: u16,
    /// Provider-reported sample frames per channel, when available.
    pub samples_per_channel: Option<u32>,
}

/// Forward-compatible non-audio item emitted by a realtime conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RealtimeConversationItem {
    /// Stable provider item identifier, synthesized when absent.
    pub id: String,
    /// Provider item discriminator such as `handoff_request`.
    pub item_type: String,
    /// Short human-readable label derived without interpreting unstable fields.
    pub title: String,
    /// Best available descriptive text from the item.
    pub summary: Option<String>,
    /// Size-bounded provider JSON retained for inspection and future clients.
    pub payload: Value,
    /// Time the daemon observed the item.
    pub created_at: DateTime<Utc>,
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
        /// Conversation-item field receiving the delta.
        #[serde(default)]
        target: TextDeltaTarget,
        /// UTF-16 offset at which the delta starts, for idempotent replay.
        #[serde(default)]
        start_offset: Option<u64>,
        /// UTF-16 offset immediately after the delta, for idempotent replay.
        #[serde(default)]
        end_offset: Option<u64>,
    },
    /// Service-level status update.
    Service {
        /// Severity level for the message.
        level: ServiceLevel,
        /// Human-readable status text.
        message: String,
        /// Provider method associated with the message, if any.
        raw_method: Option<String>,
        /// Retained workspace notice for events without a thread target.
        #[serde(default)]
        notice: Option<ServiceNotice>,
    },
    /// An active workspace condition was created or changed.
    OperationalConditionUpserted {
        /// Complete replacement condition.
        condition: OperationalCondition,
    },
    /// An active workspace condition recovered.
    OperationalConditionCleared {
        /// Stable semantic key of the recovered condition.
        key: String,
        /// Stable condition identity used to remove the legacy notice projection.
        condition_id: String,
    },
    /// Latest token/context usage for the target thread.
    ThreadTokenUsageUpdated {
        /// Provider-reported usage snapshot.
        usage: ThreadTokenUsage,
    },
    /// A realtime audio session started. Live-only; never retained in snapshots.
    RealtimeAudioStarted {
        /// Provider realtime session identifier, when available.
        session_id: Option<String>,
    },
    /// A streamed realtime PCM fragment. Remote bridges use non-replayed delivery.
    RealtimeAudioDelta {
        /// Audio fragment to enqueue for immediate playback.
        audio: RealtimeAudioChunk,
    },
    /// A realtime audio session reached a terminal state.
    RealtimeAudioEnded {
        /// Provider close or error reason, when available.
        reason: Option<String>,
        /// Whether pending playback should be discarded rather than drained.
        interrupted: bool,
    },
    /// Raw non-audio realtime item. Live-only and delivered without relay replay.
    RealtimeItemAdded {
        /// Forward-compatible item projection.
        item: RealtimeConversationItem,
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
    /// Installed extension catalog or lifecycle status changed.
    ExtensionCatalogUpdated {
        /// Full catalog; small and replaced atomically by clients.
        catalog: Vec<ExtensionSummary>,
    },
    /// An extension published or removed synchronized view state.
    ExtensionViewUpdated {
        /// Publishing extension id.
        extension_id: String,
        /// Manifest-declared view id.
        view_id: String,
        /// Optional entity scope.
        #[serde(default)]
        scope: Option<ExtensionViewScope>,
        /// Replacement view; null removes the prior projection.
        #[serde(default)]
        view: Option<ExtensionView>,
    },
    /// A daemon-owned scheduled task was created.
    ScheduledTaskCreated {
        /// New task summary.
        task: ScheduledTaskSummary,
    },
    /// A daemon-owned scheduled task changed.
    ScheduledTaskUpdated {
        /// Replacement task summary.
        task: ScheduledTaskSummary,
    },
    /// A daemon-owned scheduled task was deleted.
    ScheduledTaskDeleted {
        /// Deleted task identifier.
        task_id: String,
    },
    /// A scheduled invocation was accepted for execution.
    ScheduledTaskRunStarted {
        /// Owning task identifier.
        task_id: String,
        /// New run ledger entry.
        run: ScheduledTaskRunSummary,
    },
    /// A scheduled invocation changed lifecycle state.
    ScheduledTaskRunUpdated {
        /// Owning task identifier.
        task_id: String,
        /// Replacement run ledger entry.
        run: ScheduledTaskRunSummary,
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
    /// Agent control state (settings, automations, runs or audit) changed.
    /// Clients refetch the affected resources; the store itself is never
    /// broadcast.
    ControlStateChanged {
        /// Which store revision and domains changed.
        change: control::ControlStateChanged,
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
    /// Number of sessions with at least one connected peer.
    #[serde(default)]
    pub connected_sessions: usize,
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

/// Request payload used by a client to obtain a pairing claim challenge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingChallengeRequest {
    /// Pairing code entered by the user.
    pub pairing_code: String,
}

/// Response containing a relay-issued single-use pairing claim challenge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingChallengeResponse {
    /// Pairing identifier the challenge is bound to.
    pub pairing_id: String,
    /// Base64-encoded random challenge the claimer must sign.
    pub challenge: String,
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
    /// Base64-encoded Ed25519 signature over the relay-issued claim
    /// challenge, proving possession of the bundle's identity secret key.
    pub challenge_signature: String,
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
    /// Whether the device currently holds a live relay connection. `status`
    /// only tracks trust (active vs revoked); this is the liveness dimension.
    #[serde(default)]
    pub connected: bool,
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
    /// Whether the daemon has registered the RPC required to build an
    /// authoritative client snapshot. A live websocket without this method
    /// can carry presence while every client sync request still fails.
    #[serde(default)]
    pub daemon_rpc_ready: bool,
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

/// Relay-owned reason for an RPC failure that could not carry an encrypted
/// daemon error payload.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayRpcFailureCode {
    /// No connected daemon currently owns the requested method.
    MethodUnavailable,
    /// The same client request identifier is already in flight.
    RequestConflict,
    /// The daemon peer disappeared before resolving the request.
    ResponderDisconnected,
    /// The relay's pending-request deadline elapsed.
    TimedOut,
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
    /// Ask the relay to push a generic attention notification to trusted
    /// devices that are not currently connected. Daemon-only; carries no
    /// conversation content so the relay's zero-plaintext posture holds.
    Notify {
        /// Attention kind, e.g. `approval` or `question`.
        kind: String,
        /// Workspace the attention belongs to, for client-side routing.
        workspace_id: Option<String>,
        /// Thread the attention belongs to, for client-side routing.
        thread_id: Option<String>,
    },
}

/// Request body for registering (or clearing) a trusted device's push token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterPushTokenRequest {
    /// Expo push token for the device, or `None` to clear it.
    pub push_token: Option<String>,
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
        /// Plain relay-routing failure; absent for daemon-owned results.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failure: Option<RelayRpcFailureCode>,
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

/// Local branches of a workspace checkout, for the new-thread branch picker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitBranchesResponse {
    /// Currently checked-out branch, if HEAD is not detached.
    pub current: Option<String>,
    /// Local branch names, most recently committed first.
    pub branches: Vec<String>,
}

/// Full diff response returned by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitDiffResponse {
    /// Unified diff text.
    pub diff: String,
    /// Full file contents when no unified diff is available.
    pub content: Option<String>,
}

/// Workspace-relative files available to the code-review browser.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceFilesResponse {
    /// Workspace-relative file paths, sorted lexicographically.
    pub files: Vec<String>,
    /// Whether the daemon stopped listing at its safety limit.
    pub truncated: bool,
}

/// UTF-8 contents and metadata for one workspace file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceFileResponse {
    /// Workspace-relative path that was read.
    pub path: String,
    /// UTF-8 contents, absent for binary or oversized files.
    pub content: Option<String>,
    /// Whether the file is not valid UTF-8.
    pub is_binary: bool,
    /// Whether the file exceeded the viewer's size limit.
    pub truncated: bool,
    /// Opaque filesystem version used for conflict-aware saves.
    pub version: Option<String>,
}

/// Conflict-aware request to replace an existing workspace file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WriteWorkspaceFileRequest {
    /// Complete replacement contents.
    pub content: String,
    /// Opaque version returned by the preceding read.
    pub expected_version: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_capabilities_include_steering() {
        assert!(AgentCapabilitySummary::codex().supports_steering);
    }

    #[test]
    fn serializes_unified_event() {
        let snapshot = DaemonSnapshot {
            daemon: DaemonInfo {
                version: "0.1.0".to_string(),
                started_at: Utc::now(),
                capabilities: DaemonCapabilities::default(),
            },
            workspaces: Vec::new(),
            threads: Vec::new(),
            interactive_requests: Vec::new(),
            service_notices: Vec::new(),
            operational_conditions: Vec::new(),
            thread_token_usage: std::collections::BTreeMap::new(),
            preferences: FalconDeckPreferences::default(),
            extensions: ExtensionSnapshot::default(),
            scheduled_tasks: Vec::new(),
        };

        let json = serde_json::to_value(UnifiedEvent::Snapshot { snapshot }).unwrap();
        assert_eq!(json["type"], "snapshot");
    }

    #[test]
    fn scheduled_task_patch_distinguishes_missing_and_null_values() {
        let missing: UpdateScheduledTaskRequest = serde_json::from_str("{}").unwrap();
        let cleared: UpdateScheduledTaskRequest =
            serde_json::from_str(r#"{"model_id":null}"#).unwrap();
        let replaced: UpdateScheduledTaskRequest = serde_json::from_str(
            r#"{"model_id":"gpt-5","workspace_id":"workspace-2","provider":"claude"}"#,
        )
        .unwrap();

        assert_eq!(missing.model_id, None);
        assert_eq!(cleared.model_id, Some(None));
        assert_eq!(replaced.model_id, Some(Some("gpt-5".to_string())));
        assert_eq!(replaced.workspace_id.as_deref(), Some("workspace-2"));
        assert_eq!(replaced.provider, Some(AgentProvider::CLAUDE));
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

    #[test]
    fn interactive_resolution_retains_outcome_without_question_answers() {
        let response = InteractiveResponsePayload::Question {
            answers: std::collections::HashMap::from([(
                "password".to_string(),
                vec!["do-not-retain-this".to_string()],
            )]),
        };
        let resolution = InteractiveRequestResolution::from_response(
            &response,
            "2026-08-09T12:00:00Z".parse().unwrap(),
        );
        let json = serde_json::to_string(&resolution).unwrap();

        assert_eq!(resolution.outcome, InteractiveRequestOutcome::Answered);
        assert!(
            !json.contains("do-not-retain-this"),
            "resolution leaked answer: {json}"
        );
    }

    #[test]
    fn plan_revision_resolution_does_not_retain_feedback() {
        let response = InteractiveResponsePayload::PlanApproval {
            outcome: PlanApprovalOutcome::Cancelled,
            feedback: Some("do-not-retain-this".to_string()),
        };
        let resolution = InteractiveRequestResolution::from_response(
            &response,
            "2026-08-09T12:00:00Z".parse().unwrap(),
        );
        let json = serde_json::to_string(&resolution).unwrap();

        assert_eq!(
            resolution.outcome,
            InteractiveRequestOutcome::PlanChangesRequested
        );
        assert!(!json.contains("do-not-retain-this"));
    }

    #[test]
    fn interactive_approval_capabilities_preserve_legacy_and_explicit_empty_states() {
        let legacy: InteractiveRequest = serde_json::from_value(serde_json::json!({
            "request_id": "legacy",
            "workspace_id": "workspace-1",
            "thread_id": "thread-1",
            "method": "approval/request",
            "kind": "approval",
            "title": "Allow tests?",
            "detail": null,
            "command": "npm test",
            "path": null,
            "turn_id": null,
            "item_id": null,
            "questions": [],
            "created_at": "2026-08-09T12:00:00Z"
        }))
        .unwrap();
        assert_eq!(legacy.approval_decisions, None);
        assert!(
            serde_json::to_value(&legacy).unwrap()["approval_decisions"].is_null(),
            "legacy capability field should stay omitted"
        );

        let mut explicit_json = serde_json::to_value(&legacy).unwrap();
        explicit_json
            .as_object_mut()
            .unwrap()
            .insert("approval_decisions".to_string(), serde_json::json!([]));
        let explicit_empty: InteractiveRequest = serde_json::from_value(explicit_json).unwrap();
        assert_eq!(explicit_empty.approval_decisions, Some(Vec::new()));
        assert_eq!(
            serde_json::to_value(explicit_empty).unwrap()["approval_decisions"],
            serde_json::json!([])
        );
    }

    #[test]
    fn unsupported_conversation_item_has_a_stable_tagged_shape() {
        let item = ConversationItem::Unsupported {
            id: "future-1".to_string(),
            output_kind: "artifactPreview".to_string(),
            reason: "Unsupported".to_string(),
            payload: serde_json::json!({ "title": "Prototype" }),
            lifecycle: ContentLifecycle::Streaming,
            created_at: "2026-08-09T10:00:00Z".parse().unwrap(),
        };
        let json = serde_json::to_value(item).unwrap();

        assert_eq!(json["kind"], "unsupported");
        assert_eq!(json["output_kind"], "artifactPreview");
        assert_eq!(json["lifecycle"], "streaming");
        assert_eq!(json["payload"]["title"], "Prototype");
    }

    #[test]
    fn artifact_conversation_item_has_a_stable_tagged_shape() {
        let item = ConversationItem::Artifact {
            id: "artifact-1".to_string(),
            artifact: ConversationArtifact {
                title: "Prototype".to_string(),
                artifact_kind: "preview".to_string(),
                url: Some("https://example.com/prototype".to_string()),
                mime_type: Some("text/html".to_string()),
                version: Some("v2".to_string()),
                content: Some("<main>Prototype</main>".to_string()),
                payload: serde_json::json!({ "title": "Prototype" }),
            },
            lifecycle: ContentLifecycle::Complete,
            created_at: "2026-08-09T10:00:00Z".parse().unwrap(),
        };
        let json = serde_json::to_value(item).unwrap();

        assert_eq!(json["kind"], "artifact");
        assert_eq!(json["artifact"]["title"], "Prototype");
        assert_eq!(json["artifact"]["version"], "v2");
        assert_eq!(json["lifecycle"], "complete");
    }

    #[test]
    fn code_review_item_has_a_stable_tagged_shape() {
        let item = ConversationItem::CodeReview {
            id: "review-1".to_string(),
            subject: Some("current changes".to_string()),
            content: "## Findings".to_string(),
            lifecycle: ContentLifecycle::Complete,
            created_at: "2026-08-09T10:00:00Z".parse().unwrap(),
        };
        let json = serde_json::to_value(item).unwrap();

        assert_eq!(json["kind"], "code_review");
        assert_eq!(json["subject"], "current changes");
        assert_eq!(json["content"], "## Findings");
        assert_eq!(json["lifecycle"], "complete");
    }

    #[test]
    fn legacy_resolved_interactive_item_deserializes_without_an_outcome() {
        let item: ConversationItem = serde_json::from_value(serde_json::json!({
            "kind": "interactive_request",
            "id": "request-1",
            "request": {
                "request_id": "request-1",
                "workspace_id": "workspace-1",
                "thread_id": "thread-1",
                "method": "approval/request",
                "kind": "approval",
                "title": "Allow tests?",
                "detail": null,
                "command": "npm test",
                "path": null,
                "turn_id": null,
                "item_id": null,
                "questions": [],
                "created_at": "2026-08-09T12:00:00Z"
            },
            "created_at": "2026-08-09T12:00:00Z",
            "resolved": true
        }))
        .unwrap();

        assert!(matches!(
            item,
            ConversationItem::InteractiveRequest {
                resolved: true,
                resolution: None,
                ..
            }
        ));
    }
}
