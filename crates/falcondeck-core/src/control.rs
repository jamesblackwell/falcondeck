//! Shared wire types for the FalconDeck agent control interface.
//!
//! The agent control interface exposes a deliberately small surface —
//! `falcondeck_search`, `falcondeck_get` and `falcondeck_execute` — above a
//! daemon-owned control service and capability registry. The types in this
//! module are the serialisable contract that crosses the daemon/client
//! boundary: automation definitions and run records, agent-control settings,
//! request/response envelopes, structured errors, and the control
//! state-change event. Behaviour (scheduling, persistence, validation) lives
//! in the daemon; only shared protocol types live here.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::AgentProvider;

/// Global and per-provider settings for the conversational control surface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentControlSettings {
    /// Controls whether MCP-originated FalconDeck control is accepted.
    pub enabled: bool,

    /// Provider-specific overrides. Missing providers inherit `enabled`.
    #[serde(default)]
    pub providers: BTreeMap<AgentProvider, ProviderControlSettings>,

    /// Default timezone offered when creating recurring schedules.
    pub default_timezone: String,

    /// Whether creation of automations using elevated permission modes is
    /// allowed.
    pub allow_elevated_automations: bool,

    /// Client-facing confirmation preferences.
    pub confirmation_policy: ConfirmationPolicy,
}

/// Per-provider override of the agent-control surface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProviderControlSettings {
    /// Whether FalconDeck control is enabled for this provider.
    pub enabled: bool,
}

/// Which operation classes ask the client for explicit confirmation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfirmationPolicy {
    /// Confirm destructive operations before execution.
    pub destructive_operations: bool,
    /// Confirm sensitive operations before execution.
    pub sensitive_operations: bool,
}

impl Default for ConfirmationPolicy {
    fn default() -> Self {
        Self {
            destructive_operations: true,
            sensitive_operations: true,
        }
    }
}

impl Default for AgentControlSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            providers: BTreeMap::new(),
            default_timezone: "Europe/London".to_string(),
            allow_elevated_automations: false,
            confirmation_policy: ConfirmationPolicy::default(),
        }
    }
}

/// Durable definition that causes an agent instruction to run on a schedule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Automation {
    /// Stable unique identifier.
    pub id: String,
    /// Monotonically increasing version; definition mutations increment it.
    pub revision: u64,

    /// Human-readable name.
    pub name: String,
    /// Optional longer description.
    #[serde(default)]
    pub description: Option<String>,

    /// When the automation runs.
    pub trigger: AutomationTrigger,
    /// What the agent is asked to do.
    pub task: AutomationTask,
    /// Where and with which provider the work runs.
    pub target: AutomationTarget,

    /// Lifecycle state.
    pub state: AutomationState,
    /// Behaviour when a due occurrence overlaps a running one.
    pub concurrency_policy: AutomationConcurrencyPolicy,
    /// Behaviour for occurrences missed while the daemon was stopped.
    pub misfire_policy: AutomationMisfirePolicy,

    /// Whether the captured authority settings count as elevated.
    #[serde(default)]
    pub elevated: bool,

    /// Connector names the automation depends on.
    #[serde(default)]
    pub required_connectors: Vec<String>,

    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Last definition change timestamp.
    pub updated_at: DateTime<Utc>,

    /// Next scheduled occurrence, if one is calculable.
    pub next_run_at: Option<DateTime<Utc>>,
    /// Most recent dispatch timestamp.
    #[serde(default)]
    pub last_run_at: Option<DateTime<Utc>>,
    /// Bounded summary of the latest run.
    #[serde(default)]
    pub latest_outcome: Option<AutomationOutcomeSummary>,
}

/// Bounded summary of the most recent automation run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationOutcomeSummary {
    /// Terminal status of the run.
    pub status: AutomationRunStatus,
    /// When the run finished.
    pub finished_at: DateTime<Utc>,
    /// Short outcome preview, never the full provider transcript.
    #[serde(default)]
    pub preview: Option<String>,
}

/// When an automation runs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationTrigger {
    /// Absolute instant. The supplied RFC 3339 value must include an offset.
    Once {
        /// Instant the automation runs at.
        run_at: DateTime<Utc>,
    },

    /// Five-field cron expression evaluated in an IANA timezone.
    Cron {
        /// `minute hour day-of-month month day-of-week` expression.
        expression: String,
        /// IANA timezone identifier such as `Europe/London`.
        timezone: String,
    },

    /// Fixed elapsed interval. Suitable for polling-style checks.
    Interval {
        /// Seconds between runs; at least 60.
        every_seconds: u64,
        /// Instant the interval grid is anchored to.
        anchor_at: DateTime<Utc>,
    },
}

/// What the scheduled agent is asked to do.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationTask {
    /// A plain instruction for the agent.
    Prompt {
        /// Full instruction text.
        instruction: String,
    },

    /// A scheduled agent execution that classifies itself as requiring no
    /// action when the final reply is exactly `no_action_marker`.
    ConditionalPrompt {
        /// Full instruction text, normally telling the agent about the marker.
        instruction: String,
        /// Single-line marker compared against the trimmed final reply.
        no_action_marker: String,
    },
}

impl AutomationTask {
    /// The instruction text, regardless of task kind.
    pub fn instruction(&self) -> &str {
        match self {
            AutomationTask::Prompt { instruction } => instruction,
            AutomationTask::ConditionalPrompt { instruction, .. } => instruction,
        }
    }
}

/// Durable execution target of an automation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationTarget {
    /// Durable canonical path, not the runtime-generated workspace id.
    pub workspace_path: String,

    /// Open `AgentProvider` identifier such as `codex` or `claude`.
    pub provider: AgentProvider,

    /// Which native thread the work runs in.
    pub thread: AutomationThreadTarget,

    /// Optional current-provider-default model resolution.
    #[serde(default)]
    pub model_id: Option<String>,

    /// Explicit authority settings captured by the automation.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Explicit authority settings captured by the automation.
    #[serde(default)]
    pub sandbox_mode: Option<String>,

    /// Skills to select for the dispatched turn.
    #[serde(default)]
    pub selected_skills: Vec<String>,
}

/// Which native thread an automation runs in.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationThreadTarget {
    /// Default. FalconDeck creates a dedicated thread and remembers its id.
    Managed {
        /// Thread id once FalconDeck has created the managed thread.
        #[serde(default)]
        thread_id: Option<String>,
    },

    /// Run in a user-selected existing thread.
    Existing {
        /// The chosen thread id.
        thread_id: String,
    },

    /// Create a clean native thread for every execution.
    NewEachRun,
}

/// Lifecycle state of an automation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum AutomationState {
    /// Scheduled and dispatchable.
    #[default]
    Enabled,
    /// Not dispatchable until resumed; keeps its definition.
    Paused,
    /// Terminal state for one-time automations after an execution attempt.
    Completed,
    /// Terminal state after an unrecoverable execution failure.
    Failed,
}

/// Behaviour when a due occurrence overlaps a still-running one.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum AutomationConcurrencyPolicy {
    /// Do not overlap runs; skip the due occurrence.
    #[default]
    Skip,
    /// Keep at most one additional pending occurrence.
    QueueOne,
    /// Allow overlapping runs, subject to the daemon-wide limit.
    Allow,
}

/// Behaviour for occurrences missed while the daemon was stopped.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum AutomationMisfirePolicy {
    /// Do not replay occurrences missed while FalconDeck was stopped.
    #[default]
    Skip,
    /// Execute at most one missed occurrence after restart.
    RunOnce,
}

/// One attempted execution of an automation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationRun {
    /// Stable unique identifier.
    pub id: String,
    /// Automation the run belongs to.
    pub automation_id: String,

    /// Snapshot of the name for useful history after renames.
    pub automation_name: String,
    /// Definition revision at dispatch time.
    pub automation_revision: u64,

    /// Lifecycle status of the run.
    pub status: AutomationRunStatus,
    /// Occurrence time this run was scheduled for, if any.
    #[serde(default)]
    pub scheduled_for: Option<DateTime<Utc>>,

    /// When the run entered the queue.
    pub queued_at: DateTime<Utc>,
    /// When dispatch to the provider began.
    #[serde(default)]
    pub started_at: Option<DateTime<Utc>>,
    /// When the run reached a terminal status.
    #[serde(default)]
    pub finished_at: Option<DateTime<Utc>>,

    /// Runtime workspace id; never the durable automation locator.
    #[serde(default)]
    pub runtime_workspace_id: Option<String>,
    /// Native thread the turn ran in.
    #[serde(default)]
    pub thread_id: Option<String>,
    /// Provider turn id, once known.
    #[serde(default)]
    pub turn_id: Option<String>,

    /// Bounded outcome preview; the full reply stays in the native thread.
    #[serde(default)]
    pub outcome_preview: Option<String>,
    /// Structured failure detail.
    #[serde(default)]
    pub error: Option<ControlErrorDetail>,
}

/// Lifecycle status of an automation run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    /// Accepted and awaiting dispatch.
    Queued,
    /// Dispatched to the provider.
    Running,
    /// Provider turn completed successfully.
    Succeeded,
    /// Completed with the configured no-action marker.
    SucceededNoAction,
    /// Provider execution failed.
    Failed,
    /// Skipped because a previous occurrence was still running.
    SkippedOverlap,
    /// Skipped because a required connector was unavailable.
    SkippedDependency,
    /// Cancelled before execution.
    Cancelled,
}

impl AutomationRunStatus {
    /// Whether the status allows no further transitions.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            AutomationRunStatus::Succeeded
                | AutomationRunStatus::SucceededNoAction
                | AutomationRunStatus::Failed
                | AutomationRunStatus::SkippedOverlap
                | AutomationRunStatus::SkippedDependency
                | AutomationRunStatus::Cancelled
        )
    }
}

/// Where a control request came from. Informational audit context, not a
/// separate security identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum ControlOrigin {
    /// The desktop graphical interface.
    #[default]
    DesktopUi,
    /// The built-in FalconDeck MCP server spawned inside an agent.
    Mcp,
    /// A paired remote client over the relay.
    RemoteRpc,
    /// The daemon's own scheduler.
    Scheduler,
    /// Daemon-internal maintenance.
    System,
}

/// Context attached to every control request for enforcement and audit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ControlRequestContext {
    /// Where the request entered the control service.
    pub origin: ControlOrigin,
    /// Provider that issued the request, for MCP-originated calls.
    #[serde(default)]
    pub provider: Option<AgentProvider>,
    /// Workspace path the requesting agent is running in, when known.
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// Thread the requesting agent turn runs in, when known.
    #[serde(default)]
    pub thread_id: Option<String>,
    /// Paired device the request came from, when known.
    #[serde(default)]
    pub device_id: Option<String>,
}

/// Outcome of an audited mutation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuditResult {
    /// The mutation changed control state.
    Success,
    /// The mutation was rejected.
    Failure,
}

/// One bounded audit record for a control mutation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ControlAuditEntry {
    /// Stable unique identifier.
    pub id: String,
    /// When the mutation was attempted.
    pub occurred_at: DateTime<Utc>,
    /// Request context captured with the mutation.
    pub context: ControlRequestContext,

    /// Stable operation identifier that was invoked.
    pub operation: String,
    /// Resource type touched, when known.
    #[serde(default)]
    pub resource_type: Option<String>,
    /// Resource id touched, when known.
    #[serde(default)]
    pub resource_id: Option<String>,

    /// Whether the mutation succeeded.
    pub result: AuditResult,

    /// Redacted summary only; never the full automation instruction.
    pub summary: String,
}

/// One field-level validation failure inside a structured control error.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FieldError {
    /// Dotted path of the offending argument field.
    pub field: String,
    /// What was wrong and, where possible, how to fix it.
    pub message: String,
}

/// Structured error returned by every control operation failure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ControlErrorDetail {
    /// Stable error code from the control error catalogue.
    pub code: String,
    /// Human-readable explanation.
    pub message: String,

    /// Whether retrying the same request can plausibly succeed.
    pub retryable: bool,

    /// Field-level validation failures.
    #[serde(default)]
    pub field_errors: Vec<FieldError>,

    /// Current resource revision, for revision conflicts.
    #[serde(default)]
    pub current_revision: Option<u64>,
    /// Concrete next step for the caller.
    #[serde(default)]
    pub suggested_action: Option<String>,
}

/// Control domains a state-change event can report.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ControlDomain {
    /// Agent-control settings changed.
    Settings,
    /// Automation definitions changed.
    Automations,
    /// Run records changed.
    Runs,
    /// Audit records changed.
    Audit,
}

/// Lightweight notification that control state changed. Clients refetch the
/// affected resources; the full store is never broadcast.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ControlStateChanged {
    /// Store revision after the change.
    pub store_revision: u64,
    /// Domains the mutation touched.
    pub domains: Vec<ControlDomain>,
}

/// Behavioural metadata for a capability, as surfaced to clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CapabilityBehaviorInfo {
    /// Whether the operation only reads state.
    pub read_only: bool,
    /// Whether the operation destroys state.
    pub destructive: bool,
    /// Whether repeated identical calls are safe.
    pub idempotent: bool,
    /// Confirmation class: `none`, `mutation`, `sensitive` or `destructive`.
    pub confirmation_class: String,
}

/// One capability result in a search response. Summary responses omit the
/// schema and example payloads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CapabilitySummary {
    /// Stable operation identifier.
    pub operation: String,
    /// Short display title.
    pub title: String,
    /// What the operation does.
    pub description: String,
    /// Grouping such as `automation` or `agent_control`.
    pub domain: String,
    /// Behavioural metadata.
    pub behavior: CapabilityBehaviorInfo,
    /// Related operation ids.
    pub related_operations: Vec<String>,
    /// Whether the operation is currently offered to this caller.
    pub available: bool,

    /// Input schema, present only in `full` detail responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
    /// Output schema, present only in `full` detail responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
    /// Examples, present only in `full` detail responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub examples: Option<Vec<CapabilityExampleInfo>>,
}

/// One worked example attached to a capability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CapabilityExampleInfo {
    /// What the example demonstrates.
    pub description: String,
    /// Example `falcondeck_execute` arguments.
    pub arguments: serde_json::Value,
}

/// How much detail a capability search should return.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum SearchDetail {
    /// Compact summaries without schemas.
    #[default]
    Summary,
    /// Complete schemas and examples.
    Full,
}

/// Request body for capability discovery.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ControlSearchRequest {
    /// Natural-language capability search.
    #[serde(default)]
    pub query: Option<String>,
    /// Optional domain such as `automation` or `agent_control`.
    #[serde(default)]
    pub domain: Option<String>,
    /// Exact stable operation identifier.
    #[serde(default)]
    pub operation: Option<String>,

    /// Response detail level.
    #[serde(default)]
    pub detail: SearchDetail,

    /// Maximum number of results.
    #[serde(default = "default_search_limit")]
    pub limit: usize,
}

/// Default and maximum capability-search result count.
pub const CONTROL_SEARCH_LIMIT: usize = 20;

/// Default page size for `falcondeck_get` style reads.
pub const CONTROL_PAGE_LIMIT: usize = 20;

/// Maximum page size for `falcondeck_get` style reads.
pub const CONTROL_PAGE_LIMIT_MAX: usize = 100;

fn default_search_limit() -> usize {
    8
}

impl Default for ControlSearchRequest {
    fn default() -> Self {
        Self {
            query: None,
            domain: None,
            operation: None,
            detail: SearchDetail::default(),
            limit: default_search_limit(),
        }
    }
}

fn default_page_limit() -> usize {
    CONTROL_PAGE_LIMIT
}

impl Default for ControlGetRequest {
    fn default() -> Self {
        Self {
            resource: String::new(),
            id: None,
            filters: serde_json::Map::new(),
            fields: Vec::new(),
            cursor: None,
            limit: default_page_limit(),
        }
    }
}

/// Response body for capability discovery.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ControlSearchResponse {
    /// Matching capabilities, best match first.
    pub results: Vec<CapabilitySummary>,
}

/// Request body for control reads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ControlGetRequest {
    /// Resource selector such as `automations` or `agent_control.settings`.
    pub resource: String,
    /// Resource id for singular resources.
    #[serde(default)]
    pub id: Option<String>,

    /// Equality filters; values may be scalars or arrays.
    #[serde(default)]
    pub filters: serde_json::Map<String, serde_json::Value>,

    /// Dotted field paths to project. Empty keeps the default projection.
    #[serde(default)]
    pub fields: Vec<String>,

    /// Opaque cursor from a previous response.
    #[serde(default)]
    pub cursor: Option<String>,

    /// Page size.
    #[serde(default = "default_page_limit")]
    pub limit: usize,
}

/// Response body for control reads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ControlGetResponse {
    /// Resource selector that was read.
    pub resource: String,
    /// Projected rows or the singular resource value.
    pub data: serde_json::Value,
    /// Cursor to pass back for the next page, when more rows remain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Request body for control mutations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ControlExecuteRequest {
    /// Stable operation identifier returned by `falcondeck_search`.
    pub operation: String,

    /// Operation arguments, validated against the registry schema.
    #[serde(default)]
    pub arguments: serde_json::Map<String, serde_json::Value>,

    /// Definition revision the caller read, for revision-aware mutations.
    #[serde(default)]
    pub expected_revision: Option<u64>,
    /// Idempotency key scoping duplicate retries.
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

/// Response body for control mutations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ControlExecuteResponse {
    /// Whether the operation succeeded.
    pub ok: bool,
    /// Operation identifier that was executed.
    pub operation: String,
    /// Structured result on success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// Structured error on failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlErrorDetail>,
}
