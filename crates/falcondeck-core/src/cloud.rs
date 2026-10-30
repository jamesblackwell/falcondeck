//! Local coordinator metadata for isolated cloud coding jobs.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Sanitized cloud configuration. Credentials are only accepted on writes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudSettings {
    /// Whether launch is explicitly enabled.
    pub enabled: bool,
    /// Whether a private provider token is configured.
    pub has_provider_token: bool,
    /// Whether a private model API key is configured.
    pub has_openai_api_key: bool,
    /// Optional provider team scope.
    pub team_id: Option<String>,
    /// Optional provider project scope.
    pub project_id: Option<String>,
    /// Worker image used for future jobs.
    pub image: String,
    /// Maximum sandbox lifetime in minutes, capped at one day.
    pub timeout_minutes: u32,
    /// Executable used to invoke the runtime adapter.
    pub node_binary: String,
    /// Absolute path to the installed runtime adapter entry point.
    pub runtime_path: String,
    /// Public HTTPS URL of the pinned worker daemon binary.
    pub worker_daemon_url: String,
    /// SHA-256 of that daemon binary.
    pub worker_daemon_sha256: String,
    /// Explicit network domains available to the worker.
    pub allowed_domains: Vec<String>,
}

/// Private credential/configuration input. Empty credential strings clear them.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct UpdateCloudSettingsRequest {
    /// Enable or disable new launches.
    pub enabled: Option<bool>,
    /// Provider access token; never echoed in responses.
    pub provider_token: Option<String>,
    /// Model API key; never echoed in responses.
    pub openai_api_key: Option<String>,
    /// Provider team scope.
    pub team_id: Option<String>,
    /// Provider project scope.
    pub project_id: Option<String>,
    /// Worker image.
    pub image: Option<String>,
    /// Sandbox lifetime; 1–1440 minutes.
    pub timeout_minutes: Option<u32>,
    /// Node executable.
    pub node_binary: Option<String>,
    /// Adapter entry point.
    pub runtime_path: Option<String>,
    /// Pinned worker daemon download URL.
    pub worker_daemon_url: Option<String>,
    /// SHA-256 for the pinned worker binary.
    pub worker_daemon_sha256: Option<String>,
    /// Explicit worker network allowlist.
    pub allowed_domains: Option<Vec<String>>,
}

/// Request to review a bounded capture of a local workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureCloudSourceRequest {
    /// Connected local workspace.
    pub workspace_id: String,
}

/// Secret-free description of captured source. File contents stay private.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudSourcePreview {
    /// Durable capture identifier for a subsequent launch.
    pub id: String,
    /// Originating local workspace.
    pub workspace_id: String,
    /// Local source revision when available.
    pub base_head: Option<String>,
    /// Fingerprint of the exact included file tree.
    pub tree_hash: String,
    /// Included paths, including safe untracked and modified files.
    pub included_paths: Vec<String>,
    /// Excluded paths; no excluded contents are transmitted.
    pub excluded_paths: Vec<String>,
    /// Total included file bytes.
    pub total_bytes: u64,
    /// Capture creation time.
    pub created_at: DateTime<Utc>,
}

/// Request to create one native cloud task, deduplicated durably.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCloudJobRequest {
    /// Local workspace to capture or use as the import destination.
    pub workspace_id: String,
    /// User's first prompt.
    pub prompt: String,
    /// Previously reviewed capture; omission creates one at launch.
    pub source_capture_id: Option<String>,
    /// Stable client-generated retry key, scoped to this coordinator.
    pub idempotency_key: String,
    /// Optional native Codex model.
    pub model_id: Option<String>,
}

/// Coordinator lifecycle, separate from the native transcript.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloudJobStatus {
    /// Source saved; allocation may already be in progress.
    Provisioning,
    /// A native turn is running remotely.
    Running,
    /// Native thread is waiting for user input.
    AwaitingInput,
    /// Native thread is idle; results can be collected.
    Completed,
    /// A definite failure occurred.
    Failed,
    /// Provider or request admission outcome is unknown; inspect before retrying.
    Unknown,
    /// Stop was requested and requires reconciliation.
    Stopping,
    /// Remote compute has been stopped.
    Stopped,
    /// Remote lifetime ended.
    Expired,
}

/// Native worker identifiers. Credentials and gateway URLs remain private.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudWorkerLocator {
    /// Native remote workspace identifier.
    pub workspace_id: String,
    /// Native remote thread identifier.
    pub thread_id: String,
    /// Harness that owns the native transcript.
    pub provider: String,
}

/// Locally retained result metadata, with explicit manual import state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudJobResult {
    /// Collection time.
    pub collected_at: DateTime<Utc>,
    /// Result tree fingerprint.
    pub tree_hash: String,
    /// Changed or added source paths.
    pub changed_paths: Vec<String>,
    /// Removed source paths.
    pub deleted_paths: Vec<String>,
    /// Count of native session artifacts retained privately.
    pub native_session_count: usize,
    /// Time a checked manual import completed.
    pub imported_at: Option<DateTime<Utc>>,
}

/// Public job summary. Conversation content belongs to the native worker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudJob {
    /// Durable coordinator job ID.
    pub id: String,
    /// Originating local workspace.
    pub workspace_id: String,
    /// Source capture provenance.
    pub source: CloudSourcePreview,
    /// Native job lifecycle.
    pub status: CloudJobStatus,
    /// Prompt shown in the task list.
    pub prompt: String,
    /// Selected model, if explicit.
    pub model_id: Option<String>,
    /// Remote native conversation identity once available.
    pub worker: Option<CloudWorkerLocator>,
    /// Collection metadata once results are saved locally.
    pub result: Option<CloudJobResult>,
    /// Sanitized actionable error; never raw provider output.
    pub error: Option<String>,
    /// Job creation time.
    pub created_at: DateTime<Utc>,
    /// Last coordinator update.
    pub updated_at: DateTime<Utc>,
    /// Remote sandbox expiry, bounded to one day from launch.
    pub expires_at: Option<DateTime<Utc>>,
}

/// Native conversation detail plus the worker's pending interactive requests.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudJobDetail {
    /// Unmodified normal native thread detail fields.
    #[serde(flatten)]
    pub detail: crate::ThreadDetail,
    /// Native approvals and questions for this exact remote thread.
    pub interactive_requests: Vec<crate::InteractiveRequest>,
    /// Whether the response came from the currently reachable native worker.
    pub is_live: bool,
    /// Collection timestamp when returning a saved projection of native exports.
    pub collected_at: Option<DateTime<Utc>>,
}
