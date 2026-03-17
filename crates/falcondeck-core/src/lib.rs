pub mod crypto;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_DAEMON_PORT: u16 = 4123;
pub const DEFAULT_RELAY_PORT: u16 = 8787;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DaemonInfo {
    pub version: String,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DaemonSnapshot {
    pub daemon: DaemonInfo,
    pub workspaces: Vec<WorkspaceSummary>,
    pub threads: Vec<ThreadSummary>,
    pub interactive_requests: Vec<InteractiveRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthResponse {
    pub ok: bool,
    pub version: String,
    pub workspaces: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectWorkspaceRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartThreadRequest {
    pub workspace_id: String,
    pub model_id: Option<String>,
    pub collaboration_mode_id: Option<String>,
    pub approval_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateThreadRequest {
    pub workspace_id: String,
    pub thread_id: String,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub collaboration_mode_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImageInput {
    pub id: String,
    pub name: Option<String>,
    pub mime_type: Option<String>,
    pub url: String,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnInputItem {
    Text { id: Option<String>, text: String },
    Image(ImageInput),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ThreadCodexParams {
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub collaboration_mode_id: Option<String>,
    pub approval_policy: Option<String>,
    pub service_tier: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SendTurnRequest {
    pub workspace_id: String,
    pub thread_id: String,
    pub inputs: Vec<TurnInputItem>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub collaboration_mode_id: Option<String>,
    pub approval_policy: Option<String>,
    pub service_tier: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartReviewRequest {
    pub workspace_id: String,
    pub thread_id: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalResponseRequest {
    pub decision: ApprovalDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveResponseRequest {
    pub response: InteractiveResponsePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Allow,
    Deny,
    AlwaysAllow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InteractiveResponsePayload {
    Approval {
        decision: ApprovalDecision,
    },
    Question {
        answers: std::collections::HashMap<String, Vec<String>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandResponse {
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceSummary {
    pub id: String,
    pub path: String,
    pub status: WorkspaceStatus,
    pub models: Vec<ModelSummary>,
    pub collaboration_modes: Vec<CollaborationModeSummary>,
    pub account: AccountSummary,
    pub current_thread_id: Option<String>,
    pub connected_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReasoningEffortSummary {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatus {
    Connecting,
    Ready,
    NeedsAuth,
    Busy,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelSummary {
    pub id: String,
    pub label: String,
    pub is_default: bool,
    pub default_reasoning_effort: Option<String>,
    pub supported_reasoning_efforts: Vec<ReasoningEffortSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollaborationModeSummary {
    pub id: String,
    pub label: String,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountSummary {
    pub status: AccountStatus,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    Unknown,
    Ready,
    NeedsAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadSummary {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub status: ThreadStatus,
    pub updated_at: DateTime<Utc>,
    pub last_message_preview: Option<String>,
    pub latest_turn_id: Option<String>,
    pub latest_plan: Option<ThreadPlan>,
    pub latest_diff: Option<String>,
    pub last_tool: Option<String>,
    pub last_error: Option<String>,
    pub codex: ThreadCodexParams,
    #[serde(default)]
    pub is_archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Idle,
    Running,
    WaitingForInput,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadPlan {
    pub explanation: Option<String>,
    pub steps: Vec<PlanStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanStep {
    pub step: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveRequest {
    pub request_id: String,
    pub workspace_id: String,
    pub thread_id: Option<String>,
    pub method: String,
    pub kind: InteractiveRequestKind,
    pub title: String,
    pub detail: Option<String>,
    pub command: Option<String>,
    pub path: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub questions: Vec<InteractiveQuestion>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractiveRequestKind {
    Approval,
    Question,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub is_other: bool,
    pub is_secret: bool,
    pub options: Option<Vec<InteractiveQuestionOption>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveQuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationItem {
    UserMessage {
        id: String,
        text: String,
        attachments: Vec<ImageInput>,
        created_at: DateTime<Utc>,
    },
    AssistantMessage {
        id: String,
        text: String,
        created_at: DateTime<Utc>,
    },
    Reasoning {
        id: String,
        summary: Option<String>,
        content: String,
        created_at: DateTime<Utc>,
    },
    ToolCall {
        id: String,
        title: String,
        tool_kind: String,
        status: String,
        output: Option<String>,
        exit_code: Option<i32>,
        created_at: DateTime<Utc>,
        completed_at: Option<DateTime<Utc>>,
    },
    Plan {
        id: String,
        plan: ThreadPlan,
        created_at: DateTime<Utc>,
    },
    Diff {
        id: String,
        diff: String,
        created_at: DateTime<Utc>,
    },
    Service {
        id: String,
        level: ServiceLevel,
        message: String,
        created_at: DateTime<Utc>,
    },
    InteractiveRequest {
        id: String,
        request: InteractiveRequest,
        created_at: DateTime<Utc>,
        resolved: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadDetail {
    pub workspace: WorkspaceSummary,
    pub thread: ThreadSummary,
    pub items: Vec<ConversationItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventEnvelope {
    pub seq: u64,
    pub emitted_at: DateTime<Utc>,
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
    pub event: UnifiedEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum UnifiedEvent {
    Snapshot {
        snapshot: DaemonSnapshot,
    },
    Start {
        title: Option<String>,
    },
    Stop {
        reason: Option<String>,
    },
    TurnStart {
        turn_id: String,
    },
    TurnEnd {
        turn_id: String,
        status: String,
        error: Option<String>,
    },
    Text {
        item_id: String,
        delta: String,
    },
    Service {
        level: ServiceLevel,
        message: String,
        raw_method: Option<String>,
    },
    ToolCallStart {
        item_id: String,
        title: String,
        kind: String,
    },
    ToolCallEnd {
        item_id: String,
        title: String,
        kind: String,
        status: String,
        exit_code: Option<i32>,
    },
    File {
        item_id: Option<String>,
        path: Option<String>,
        summary: String,
    },
    InteractiveRequest {
        request: InteractiveRequest,
    },
    ThreadStarted {
        thread: ThreadSummary,
    },
    ThreadUpdated {
        thread: ThreadSummary,
    },
    ConversationItemAdded {
        item: ConversationItem,
    },
    ConversationItemUpdated {
        item: ConversationItem,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadHandle {
    pub workspace: WorkspaceSummary,
    pub thread: ThreadSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayHealthResponse {
    pub ok: bool,
    pub service: String,
    pub version: String,
    pub pending_pairings: usize,
    pub active_sessions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EncryptionVariant {
    DataKeyV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingPublicKeyBundle {
    pub encryption_variant: EncryptionVariant,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WrappedDataKey {
    pub encryption_variant: EncryptionVariant,
    pub wrapped_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionKeyMaterial {
    pub encryption_variant: EncryptionVariant,
    pub daemon_public_key: String,
    pub client_public_key: String,
    pub client_wrapped_data_key: WrappedDataKey,
    pub daemon_wrapped_data_key: Option<WrappedDataKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedEnvelope {
    pub encryption_variant: EncryptionVariant,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum RelayUpdateBody {
    SessionBootstrap { material: SessionKeyMaterial },
    Encrypted { envelope: EncryptedEnvelope },
    ActionStatus { action: QueuedRemoteAction },
    Presence { presence: MachinePresence },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StartPairingRequest {
    pub label: Option<String>,
    pub ttl_seconds: Option<u64>,
    pub existing_session_id: Option<String>,
    pub daemon_token: Option<String>,
    pub daemon_bundle: Option<PairingPublicKeyBundle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartPairingResponse {
    pub pairing_id: String,
    pub session_id: String,
    pub pairing_code: String,
    pub daemon_token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimPairingRequest {
    pub pairing_code: String,
    pub label: Option<String>,
    pub client_bundle: Option<PairingPublicKeyBundle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimPairingResponse {
    pub session_id: String,
    pub device_id: String,
    pub client_token: String,
    pub trusted_device: TrustedDevice,
    pub daemon_bundle: Option<PairingPublicKeyBundle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairingStatusResponse {
    pub pairing_id: String,
    pub label: Option<String>,
    pub status: PairingStatus,
    pub session_id: Option<String>,
    pub device_id: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub daemon_bundle: Option<PairingPublicKeyBundle>,
    pub client_bundle: Option<PairingPublicKeyBundle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairingStatus {
    Pending,
    Claimed,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayUpdatesQuery {
    pub after_seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrustedDeviceStatus {
    Active,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustedDevice {
    pub device_id: String,
    pub session_id: String,
    pub label: Option<String>,
    pub status: TrustedDeviceStatus,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MachinePresence {
    pub session_id: String,
    pub daemon_connected: bool,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncCursor {
    pub session_id: String,
    pub next_seq: u64,
    pub last_acknowledged_seq: u64,
    pub requires_bootstrap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelayUpdate {
    pub id: String,
    pub seq: u64,
    pub body: RelayUpdateBody,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelayUpdatesResponse {
    pub session_id: String,
    pub updates: Vec<RelayUpdate>,
    pub next_seq: u64,
    pub cursor: SyncCursor,
    pub presence: MachinePresence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubmitQueuedActionRequest {
    pub idempotency_key: String,
    pub action_type: String,
    pub payload: EncryptedEnvelope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueuedRemoteActionStatus {
    Queued,
    Dispatched,
    Executing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueuedRemoteAction {
    pub action_id: String,
    pub session_id: String,
    pub device_id: String,
    pub action_type: String,
    pub idempotency_key: String,
    pub status: QueuedRemoteActionStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub error: Option<String>,
    pub result: Option<EncryptedEnvelope>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrustedDevicesResponse {
    pub session_id: String,
    pub devices: Vec<TrustedDevice>,
    pub presence: MachinePresence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartRemotePairingRequest {
    pub relay_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemotePairingSession {
    pub pairing_id: String,
    pub pairing_code: String,
    pub session_id: Option<String>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteConnectionStatus {
    Inactive,
    PairingPending,
    DeviceTrusted,
    Connecting,
    Connected,
    Degraded,
    Offline,
    Revoked,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteStatusResponse {
    pub status: RemoteConnectionStatus,
    pub relay_url: Option<String>,
    pub pairing: Option<RemotePairingSession>,
    pub trusted_devices: Vec<TrustedDevice>,
    pub presence: Option<MachinePresence>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayPeerRole {
    Daemon,
    Client,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RelayClientMessage {
    Ping,
    Sync {
        after_seq: Option<u64>,
    },
    Update {
        body: RelayUpdateBody,
    },
    Ephemeral {
        body: Value,
    },
    RpcRegister {
        method: String,
    },
    RpcUnregister {
        method: String,
    },
    RpcCall {
        request_id: String,
        method: String,
        params: EncryptedEnvelope,
    },
    RpcResult {
        request_id: String,
        ok: bool,
        result: Option<EncryptedEnvelope>,
        error: Option<EncryptedEnvelope>,
    },
    ActionUpdate {
        action_id: String,
        status: QueuedRemoteActionStatus,
        error: Option<String>,
        result: Option<EncryptedEnvelope>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RelayServerMessage {
    Ready {
        session_id: String,
        role: RelayPeerRole,
        next_seq: u64,
    },
    Pong,
    Sync {
        updates: Vec<RelayUpdate>,
        next_seq: u64,
    },
    Update {
        update: RelayUpdate,
    },
    Ephemeral {
        body: Value,
    },
    RpcRegistered {
        method: String,
    },
    RpcUnregistered {
        method: String,
    },
    RpcRequest {
        request_id: String,
        method: String,
        params: EncryptedEnvelope,
    },
    RpcResult {
        request_id: String,
        ok: bool,
        result: Option<EncryptedEnvelope>,
        error: Option<EncryptedEnvelope>,
    },
    ActionRequested {
        action: QueuedRemoteAction,
        payload: EncryptedEnvelope,
    },
    ActionUpdated {
        action: QueuedRemoteAction,
    },
    Presence {
        presence: MachinePresence,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Copied,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: GitFileStatus,
    pub insertions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitStatusResponse {
    pub branch: Option<String>,
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitDiffResponse {
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
