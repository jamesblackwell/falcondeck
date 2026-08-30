//! Public contracts for bounded orchestration runs owned by extensions.
//!
//! The daemon owns durability, admission limits and provider dispatch. An
//! extension owns the domain-specific checkpoint and may request one of the
//! bounded effects below. Keeping this contract neutral lets Missions be an
//! ordinary extension rather than a private daemon feature.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Maximum automatic provider turns admitted by a v1 run.
pub const MAX_AUTOMATIC_TURNS: u32 = 4;
/// Initial v1 lease duration in minutes.
pub const DEFAULT_LEASE_MINUTES: i64 = 30;
/// Maximum cumulative lease duration after human extensions.
pub const MAX_LEASE_MINUTES: i64 = 120;
/// Maximum bytes in an inline automatic-turn prompt.
pub const MAX_OPERATION_PROMPT_BYTES: usize = 32 * 1024;
/// Maximum bytes in an extension-owned checkpoint.
pub const MAX_CHECKPOINT_BYTES: usize = 128 * 1024;

/// Whether an orchestration run may admit more automatic work.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionRunGate {
    /// Automatic work may be admitted within the remaining lease.
    Open,
    /// No new work is admitted until an explicit human resume.
    Paused,
    /// No new work is admitted because the run is terminal.
    Closed,
}

/// Authoritative terminal result of an orchestration run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionRunOutcome {
    /// The human accepted the extension's completion proposal.
    Completed,
    /// The human closed the run without accepting completion.
    ClosedIncomplete,
    /// The hard deadline elapsed before completion was accepted.
    Expired,
    /// The owner extension was removed or the run was explicitly cancelled.
    Cancelled,
}

/// Lifecycle of one durable provider-dispatch intent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionOperationStatus {
    /// Persisted and waiting for its coordinator task to become idle.
    Queued,
    /// The provider admission call is currently executing.
    Dispatching,
    /// The provider accepted the automatic turn.
    Acknowledged,
    /// The provider turn reached a definitive terminal task state.
    Settled,
    /// FalconDeck cannot prove whether the provider accepted the turn.
    OutcomeUnknown,
    /// The intent was rejected before or during admission.
    Rejected,
    /// The intent was cancelled before admission.
    Cancelled,
}

impl ExtensionOperationStatus {
    /// Whether the operation no longer occupies the run's unresolved slot.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Settled | Self::Rejected | Self::Cancelled)
    }
}

/// Bounded audit record for one automatic coordinator turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRunOperation {
    /// Stable operation identifier supplied by the owner extension.
    pub id: String,
    /// Immutable prompt persisted before provider admission.
    pub prompt: String,
    /// Current durable lifecycle state.
    pub status: ExtensionOperationStatus,
    /// When the intent was accepted by the broker.
    pub created_at: DateTime<Utc>,
    /// Most recent lifecycle transition.
    pub updated_at: DateTime<Utc>,
    /// Provider turn identifier when the harness exposes one.
    #[serde(default)]
    pub provider_turn_id: Option<String>,
    /// Provider turn visible immediately before dispatch. A later terminal
    /// state is only attributed to this operation when a different turn id is
    /// observed.
    #[serde(default)]
    pub source_turn_id_before_dispatch: Option<String>,
    /// Bounded failure or reconciliation note.
    #[serde(default)]
    pub message: Option<String>,
}

/// A continuation requested from inside a still-running coordinator turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPendingContinuation {
    /// Stable successor operation identifier.
    pub operation_id: String,
    /// Immutable prompt to admit after the source task settles.
    pub prompt: String,
    /// Owner-defined fingerprint used to reject no-progress loops.
    pub progress_fingerprint: String,
    /// When the request was durably recorded.
    pub requested_at: DateTime<Utc>,
}

/// Host-readable summary of one durable extension-owned run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRunSummary {
    /// Stable run identifier.
    pub id: String,
    /// Extension that exclusively owns policy and checkpoint updates.
    pub owner_extension_id: String,
    /// Workspace containing the coordinator task.
    pub workspace_id: String,
    /// Existing FalconDeck task acting as coordinator.
    pub coordinator_thread_id: String,
    /// Short human-facing title.
    pub title: String,
    /// Human-approved objective attached to the task's existing context.
    pub objective: String,
    /// Automatic dispatch gate.
    pub gate: ExtensionRunGate,
    /// Terminal result, present only when the gate is closed.
    #[serde(default)]
    pub outcome: Option<ExtensionRunOutcome>,
    /// Human-readable reason for a paused or closed gate.
    #[serde(default)]
    pub pause_reason: Option<String>,
    /// Extension-owned bounded checkpoint.
    #[serde(default)]
    pub checkpoint: Value,
    /// Compare-and-swap revision for policy/checkpoint mutations.
    pub policy_revision: u64,
    /// Monotonic journal revision for operation changes.
    pub journal_sequence: u64,
    /// Incremented whenever a human reopens or extends authority.
    pub approval_generation: u64,
    /// Automatic provider turns permanently admitted so far.
    pub automatic_turns_started: u32,
    /// Hard automatic-turn ceiling.
    pub max_automatic_turns: u32,
    /// Lease start.
    pub created_at: DateTime<Utc>,
    /// Most recent run mutation.
    pub updated_at: DateTime<Utc>,
    /// Hard automatic-work deadline.
    pub deadline_at: DateTime<Utc>,
    /// Most recent progress fingerprint admitted for a continuation.
    #[serde(default)]
    pub last_progress_fingerprint: Option<String>,
    /// Continuation waiting for its source task to settle.
    #[serde(default)]
    pub pending_continuation: Option<ExtensionPendingContinuation>,
    /// Whether the owner proposed completion pending human review.
    #[serde(default)]
    pub completion_proposed: bool,
    /// Bounded operation journal, newest operation last.
    #[serde(default)]
    pub operations: Vec<ExtensionRunOperation>,
}

/// Human-only mutation exposed through an extension action.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionRunCommand {
    /// Close the automatic dispatch gate.
    Pause,
    /// Reopen a paused gate without adding a turn by itself.
    Resume,
    /// Add another 30 minutes, within the cumulative lease ceiling.
    Extend,
    /// Accept the owner's completion proposal and close successfully.
    AcceptCompletion,
    /// Close without claiming completion.
    CloseIncomplete,
}

/// One owner-extension effect returned by a short host callback.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ExtensionOrchestrationEffect {
    /// Create a run and optionally queue its first automatic coordinator turn.
    CreateRun {
        /// Stable owner-generated run identifier.
        run_id: String,
        /// Existing workspace containing the coordinator task.
        workspace_id: String,
        /// Existing task to adopt as coordinator.
        coordinator_thread_id: String,
        /// Human-facing title.
        title: String,
        /// Human-approved objective.
        objective: String,
        /// Initial domain checkpoint.
        checkpoint: Value,
        /// First coordinator prompt. Its presence opens the gate and admits
        /// the first bounded turn; absence creates a paused draft run.
        #[serde(default)]
        initial_prompt: Option<String>,
    },
    /// Atomically replace the domain checkpoint without admitting work.
    UpdateCheckpoint {
        /// Owned run.
        run_id: String,
        /// Compare-and-swap policy revision.
        expected_policy_revision: u64,
        /// New bounded checkpoint.
        checkpoint: Value,
    },
    /// Save a checkpoint and request one successor after the source task settles.
    RequestContinuation {
        /// Owned run.
        run_id: String,
        /// Compare-and-swap policy revision.
        expected_policy_revision: u64,
        /// Stable successor operation identifier.
        operation_id: String,
        /// New bounded checkpoint.
        checkpoint: Value,
        /// Owner-defined progress fingerprint.
        progress_fingerprint: String,
        /// Immutable successor prompt.
        prompt: String,
    },
    /// Save evidence and pause for human completion review after settlement.
    ProposeCompletion {
        /// Owned run.
        run_id: String,
        /// Compare-and-swap policy revision.
        expected_policy_revision: u64,
        /// New bounded checkpoint containing the proposal and evidence.
        checkpoint: Value,
    },
    /// Save a checkpoint and close the automatic gate for human input.
    PauseForHuman {
        /// Owned run.
        run_id: String,
        /// Compare-and-swap policy revision.
        expected_policy_revision: u64,
        /// New bounded checkpoint describing the obstacle or decision.
        checkpoint: Value,
        /// Bounded human-readable pause reason.
        reason: String,
    },
    /// Apply one explicit human command.
    HumanCommand {
        /// Owned run.
        run_id: String,
        /// Compare-and-swap policy revision.
        expected_policy_revision: u64,
        /// Command selected in a trusted FalconDeck surface.
        command: ExtensionRunCommand,
        /// Optional prompt to queue when resuming a paused run.
        #[serde(default)]
        resume_prompt: Option<String>,
        /// Stable operation id paired with `resume_prompt`.
        #[serde(default)]
        operation_id: Option<String>,
    },
}
