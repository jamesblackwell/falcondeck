//! Local disk inventory and daemon-owned cleanup; native agent stores are read-only.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
/// Switches for the daily daemon policy and local disk warnings.
pub struct StoragePreferences {
    /// Enable the daily daemon-owned cleanup worker.
    pub scheduled: bool,
    /// Remove eligible ignored build caches after three idle days.
    pub clear_caches: bool,
    /// Reclaim eligible archived or fourteen-day-idle checkouts, retaining branches.
    pub reclaim_checkouts: bool,
    /// Opt in to deletion of eligible artifacts unmodified for thirty days.
    pub delete_old_artifacts: bool,
    /// Opt in to deletion of eligible experiments unmodified for thirty days.
    pub delete_old_experiments: bool,
    /// Enable low-disk warnings on this daemon.
    pub warnings: bool,
}
impl Default for StoragePreferences {
    fn default() -> Self {
        Self {
            scheduled: true,
            clear_caches: true,
            reclaim_checkouts: true,
            delete_old_artifacts: false,
            delete_old_experiments: false,
            warnings: true,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
/// Allocated size, owning task and current safety status of a retained variant.
pub struct StorageVariant {
    /// Workspace which owns the variant.
    pub workspace_id: String,
    /// Native task which owns the variant.
    pub thread_id: String,
    /// Task title shown in Storage settings.
    pub title: String,
    /// Main project checkout path used for attribution.
    pub project: String,
    /// Absolute retained path on the daemon host.
    pub path: String,
    /// Allocated bytes in this path, including any build caches.
    pub bytes: u64,
    /// Allocated bytes in ignored, untracked ecosystem cache directories.
    pub cache_bytes: u64,
    /// Whole elapsed days since the task last changed.
    pub idle_days: i64,
    /// Whether the owning task is archived.
    pub archived: bool,
    /// Local status: clean, dirty or running (including queued work).
    pub status: String,
    /// Reason deletion is unavailable, if a safety rule prevents it.
    pub blocked: Option<String>,
    /// Cache-only refusal; dirty files and cache mtimes do not block this action.
    pub cache_blocked: Option<String>,
    /// Manual snapshot refusal for a dirty checkout idle more than seven days.
    pub snapshot_blocked: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
/// An artifact or experiment with no changes in the last 30 days.
pub struct StorageCandidate {
    /// Candidate category: artifacts or experiments.
    pub category: String,
    /// Absolute retained path on the daemon host.
    pub path: String,
    /// Allocated bytes in this path, including any build caches.
    pub bytes: u64,
    /// Reason deletion is unavailable, if a safety rule prevents it.
    pub blocked: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
/// One bounded audit record for a scheduled or explicitly requested cleanup.
pub struct StorageRun {
    #[serde(default)]
    /// Unique run identifier, independent of second-resolution timestamps.
    pub id: String,
    /// Unix seconds when the audit record was persisted before cleanup.
    pub started_at: i64,
    /// Unix seconds when the run finished; absent for an unfinished run.
    pub finished_at: Option<i64>,
    /// Bounded summaries of actions and safety refusals.
    pub entries: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
/// Local data-volume inventory; allocated sizes can count APFS shared extents twice.
pub struct StorageReport {
    /// Unix seconds when this inventory started.
    pub generated_at: i64,
    /// Available bytes on the data volume, or unknown if measurement failed.
    pub free_bytes: Option<u64>,
    /// Allocated category totals; cache/content subtotals are parts of variants.
    pub categories: BTreeMap<String, u64>,
    /// Allocated retained-variant totals keyed by main project path.
    pub projects: BTreeMap<String, u64>,
    /// Retained task-owned variants, largest first.
    pub variants: Vec<StorageVariant>,
    /// Aged artifact and experiment paths, including safety refusals.
    pub candidates: Vec<StorageCandidate>,
    /// Effective storage policy switches.
    pub preferences: StoragePreferences,
    /// The most recent bounded cleanup audit records.
    pub runs: Vec<StorageRun>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Explicitly confirmed action on one task-owned checkout.
pub struct StorageActionRequest {
    /// Workspace which owns the variant.
    pub workspace_id: String,
    /// Native task which owns the variant.
    pub thread_id: String,
    /// Whether to clear caches or reclaim the checkout.
    pub action: StorageAction,
    /// The caller explicitly confirmed the destructive action.
    pub confirmed: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
/// Explicit storage actions; dirty checkout reclamation requires a manual snapshot.
pub enum StorageAction {
    /// Remove only ignored regenerable cache directories.
    ClearCaches,
    /// Remove the checkout through shared reclamation, preserving its branch and recipe.
    Reclaim,
    /// Preserve a verified dirty working tree in a snapshot ref, then reclaim manually.
    SnapshotReclaim,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Explicit confirmation to run the configured cleanup policy now.
pub struct StorageCleanupRequest {
    /// The caller explicitly confirmed the destructive action.
    pub confirmed: bool,
}

/// One task explicitly selected for a local snapshot and checkout reclamation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageSnapshotTarget {
    /// Owning workspace id.
    pub workspace_id: String,
    /// Selected dirty task id.
    pub thread_id: String,
}
/// A manual-only batch. No scheduled policy constructs this request.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageSnapshotRequest {
    /// Explicit selection, limited to one hundred distinct variants.
    pub targets: Vec<StorageSnapshotTarget>,
    /// The user confirmed snapshot creation and checkout removal.
    pub confirmed: bool,
}
