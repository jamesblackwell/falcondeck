use std::{collections::HashMap, path::PathBuf, sync::Arc};

use chrono::{DateTime, Duration, Utc};
use falcondeck_core::{
    ClaimPairingRequest, ClaimPairingResponse, EncryptedEnvelope, MachinePresence,
    PairingChallengeRequest, PairingChallengeResponse, PairingPublicKeyBundle, PairingStatus,
    PairingStatusResponse, QueuedRemoteAction, QueuedRemoteActionStatus, RelayClientMessage,
    RelayHealthResponse, RelayPeerRole, RelayRpcFailureCode, RelayServerMessage, RelayUpdate,
    RelayUpdateBody, RelayUpdatesResponse, StartPairingRequest, StartPairingResponse,
    SubmitQueuedActionRequest, SyncCursor, TrustedDevice, TrustedDeviceStatus,
    TrustedDevicesResponse,
    crypto::{
        generate_pairing_challenge, verify_pairing_claim_challenge,
        verify_pairing_public_key_bundle,
    },
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc};
use tracing::warn;
use uuid::Uuid;

use crate::error::RelayError;

const PEER_QUEUE_CAPACITY: usize = 256;
const WS_TICKET_TTL_SECONDS: i64 = 30;
/// Keep replay responses small enough that a slow client can process a
/// reconnect incrementally. A single unusually large encrypted update is
/// still sent on its own; the websocket's 16 MiB cap remains the final guard.
const WS_SYNC_CHUNK_MAX_UPDATES: usize = 128;
const WS_SYNC_CHUNK_MAX_BYTES: usize = 512 << 10;
/// Reconnect replay is only a fast-path. Beyond this window clients rebuild
/// from `snapshot.current`, which avoids flooding their bounded decrypt queues
/// with an arbitrarily large burst of stale incremental state.
const WS_SYNC_REPLAY_MAX_UPDATES: usize = 1_024;
/// How long a claim challenge stays valid; challenges are single-use and a
/// new challenge request replaces any outstanding one for the pairing.
const PAIRING_CHALLENGE_TTL_SECONDS: i64 = 300;
const PENDING_RPC_TTL_SECONDS: i64 = 30;
/// A daemon that drops usually reconnects within seconds (its supervisor
/// retries on a 1-10s backoff). Calls arriving in this window after a
/// disconnect are parked for re-dispatch instead of failing fast, so a
/// client that was just told "connected" does not see a spurious error.
const DAEMON_RECONNECT_GRACE_SECONDS: i64 = 20;
/// An authoritative snapshot and thread detail are the minimum RPC
/// capabilities remote clients need before a connected daemon can be
/// considered ready to sync. The phone requests the snapshot first and then
/// immediately fetches the selected thread, so advertising readiness after
/// only the first registration exposes a short, avoidable `thread.detail is
/// not registered` race on every reconnect.
const REQUIRED_SYNC_RPC_METHOD: &str = "snapshot.current";
const REQUIRED_THREAD_DETAIL_RPC_METHOD: &str = "thread.detail";
/// Default Expo Push API endpoint; override (or disable with an empty value)
/// via `FALCONDECK_RELAY_EXPO_PUSH_URL`.
const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
/// Expo receipt endpoint; receipt polling catches device tokens that expire
/// after the initial ticket has been accepted.
const EXPO_RECEIPTS_URL: &str = "https://exp.host/--/api/v2/push/getReceipts";
const PUSH_RECEIPT_DELAY_SECONDS: u64 = 15;
/// Minimum spacing between pushes for the same session/kind/thread.
const PUSH_DEDUPE_SECONDS: i64 = 60;
/// Request timeout for push delivery so a stalled endpoint cannot pin the
/// dispatch task.
const PUSH_REQUEST_TIMEOUT_SECONDS: u64 = 15;
const PUSH_MAX_ATTEMPTS: usize = 3;
const PUSH_RETRY_BASE_MS: u64 = 500;
/// Expo accepts up to 100 messages per HTTP request.
const EXPO_MAX_MESSAGES_PER_REQUEST: usize = 100;
/// Each dispatched action enqueues two messages into the daemon peer
/// channel (`ActionRequested` + the `ActionStatus` update broadcast), so
/// cap dispatch passes well below `PEER_QUEUE_CAPACITY / 2` to keep
/// headroom for other traffic. Remaining actions stay `Queued` and are
/// picked up on subsequent passes.
const MAX_ACTIONS_PER_DISPATCH: usize = 64;
/// How often the background task sweeps retained state; pruning no longer
/// runs on the request path.
const PRUNE_INTERVAL_SECONDS: u64 = 60;
/// Upper bound on client-chosen RPC request identifiers.
const MAX_RPC_REQUEST_ID_LENGTH: usize = 128;

fn sync_messages(response: RelayUpdatesResponse) -> Vec<RelayServerMessage> {
    // Once retention has removed any part of the requested window, or the
    // intact window is too large for safe incremental catch-up, replay is not
    // a trustworthy or bounded base for client state. Tell the client where
    // the skipped window ends and let it rebuild from the daemon snapshot;
    // live updates emitted after this marker are still delivered normally and
    // are raced against that snapshot by the clients.
    if response.cursor.history_truncated || response.updates.len() > WS_SYNC_REPLAY_MAX_UPDATES {
        return vec![RelayServerMessage::Sync {
            updates: Vec::new(),
            next_seq: response.next_seq,
            history_truncated: true,
            presence: response.presence,
        }];
    }

    let chunks = chunk_replay_updates(response.updates);
    if chunks.is_empty() {
        return vec![RelayServerMessage::Sync {
            updates: Vec::new(),
            next_seq: response.next_seq,
            history_truncated: response.cursor.history_truncated,
            presence: response.presence,
        }];
    }

    chunks
        .into_iter()
        .map(|updates| RelayServerMessage::Sync {
            updates,
            next_seq: response.next_seq,
            history_truncated: false,
            presence: response.presence.clone(),
        })
        .collect()
}

fn chunk_replay_updates(updates: Vec<RelayUpdate>) -> Vec<Vec<RelayUpdate>> {
    let mut chunks = Vec::new();
    let mut chunk = Vec::new();
    let mut chunk_bytes = 0usize;

    for update in updates {
        let update_bytes = serde_json::to_vec(&update)
            .map(|encoded| encoded.len())
            .unwrap_or(0);
        let would_exceed_limits = !chunk.is_empty()
            && (chunk.len() >= WS_SYNC_CHUNK_MAX_UPDATES
                || chunk_bytes.saturating_add(update_bytes) > WS_SYNC_CHUNK_MAX_BYTES);
        if would_exceed_limits {
            chunks.push(chunk);
            chunk = Vec::new();
            chunk_bytes = 0;
        }
        chunk_bytes = chunk_bytes.saturating_add(update_bytes);
        chunk.push(update);
    }

    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

#[derive(Debug, Clone)]
pub struct RetentionConfig {
    pub update_retention: Duration,
    pub max_updates_per_session: usize,
    /// Approximate in-memory payload bytes retained per session. Replay is a
    /// reconnect aid, not the source of truth; clients recover a truncated
    /// window from `snapshot.current`.
    pub max_update_bytes_per_session: usize,
    pub trusted_device_retention: Duration,
    pub claimed_pairing_retention: Duration,
    pub completed_action_retention: Duration,
}

impl Default for RetentionConfig {
    fn default() -> Self {
        Self {
            update_retention: Duration::days(7),
            max_updates_per_session: 10_000,
            max_update_bytes_per_session: 64 * 1024 * 1024,
            trusted_device_retention: Duration::days(180),
            claimed_pairing_retention: Duration::days(1),
            completed_action_retention: Duration::days(3),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<InnerState>,
}

struct InnerState {
    version: String,
    default_pairing_ttl: Duration,
    retention: RetentionConfig,
    store: Arc<Mutex<Store>>,
    backend: Arc<dyn crate::persistence::PersistenceBackend>,
    /// True when the backend is file-based and needs a full-state flush
    /// after each granular persist call.
    needs_flush: bool,
    /// Shared HTTP client for push delivery, built once with a request
    /// timeout so a stalled push endpoint cannot pin tasks forever.
    push_client: reqwest::Client,
    /// Push endpoint resolved once at startup; an empty value disables
    /// push delivery.
    push_endpoint: String,
    /// Optional EAS access token for projects that enable authenticated Expo
    /// Push API access.
    push_access_token: Option<String>,
    /// Receipt endpoint resolved once at startup, with an override retained
    /// for local relay integration tests.
    push_receipts_endpoint: String,
}

struct Store {
    data: PersistedState,
    live_sessions: HashMap<String, LiveSession>,
    ws_tickets: HashMap<String, WebSocketTicket>,
    /// Outstanding single-use claim challenges keyed by pairing id.
    /// Challenges are short-lived and deliberately in-memory only: a relay
    /// restart simply forces the client to request a fresh challenge.
    pairing_challenges: HashMap<String, PairingChallenge>,
    /// Last push-notification time per (session, kind, thread), so bursts
    /// of the same attention event collapse into one push per window
    /// without one kind (e.g. turn-complete) swallowing another (approval).
    push_dedupe: HashMap<(String, String, String), DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct PairingChallenge {
    challenge: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct PersistedState {
    #[serde(default)]
    pub(crate) pairings: HashMap<String, PairingRecord>,
    #[serde(default)]
    pub(crate) sessions: HashMap<String, SessionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PairingRecord {
    pub(crate) pairing_id: String,
    pub(crate) pairing_code: String,
    pub(crate) daemon_token: String,
    pub(crate) label: Option<String>,
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) device_id: Option<String>,
    pub(crate) daemon_bundle: Option<PairingPublicKeyBundle>,
    pub(crate) client_bundle: Option<PairingPublicKeyBundle>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionRecord {
    pub(crate) session_id: String,
    pub(crate) pairing_id: String,
    pub(crate) daemon_token: String,
    #[serde(default)]
    pub(crate) daemon_last_seen_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub(crate) devices: HashMap<String, TrustedDeviceRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) device_created_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) client_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) client_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) client_public_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) client_last_seen_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) revoked_at: Option<DateTime<Utc>>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
    #[serde(default = "default_next_seq")]
    pub(crate) next_seq: u64,
    /// One past the highest sequence number ever dropped by retention
    /// pruning. Superseded presence rows are deliberately excluded: their
    /// removal loses nothing a client needs, so it must not report
    /// truncation. Zero means no update was ever pruned.
    #[serde(default)]
    pub(crate) oldest_lost_seq: u64,
    pub(crate) updates: Vec<RelayUpdate>,
    #[serde(default)]
    pub(crate) actions: HashMap<String, QueuedActionRecord>,
}

/// Scalar session fields consumed by backend session upserts, so hot
/// paths never clone the full update history or action map under the
/// store lock just to persist a row.
#[derive(Debug, Clone)]
pub(crate) struct SessionMeta {
    pub(crate) session_id: String,
    pub(crate) pairing_id: String,
    pub(crate) daemon_token: String,
    pub(crate) daemon_last_seen_at: Option<DateTime<Utc>>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
    pub(crate) next_seq: u64,
    pub(crate) oldest_lost_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TrustedDeviceRecord {
    pub(crate) device_id: String,
    pub(crate) client_token: String,
    pub(crate) label: Option<String>,
    pub(crate) public_key: Option<String>,
    /// Ed25519 identity public key the device proved possession of when it
    /// claimed. Re-attaching to this device requires the same identity key:
    /// the self-signed bundle does not bind the box key to the identity
    /// key, so the box key alone must never authorize a re-attach. `None`
    /// only on legacy rows, which are backfilled on their next claim.
    #[serde(default)]
    pub(crate) identity_public_key: Option<String>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) last_seen_at: Option<DateTime<Utc>>,
    pub(crate) revoked_at: Option<DateTime<Utc>>,
    /// Expo push token registered by the device for attention notifications.
    /// Never exposed through the trusted-devices API responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) push_token: Option<String>,
}

#[derive(Default)]
struct LiveSession {
    peers: HashMap<String, PeerHandle>,
    /// Live daemon peers in registration order. Connections can overlap
    /// during reconnect, so new actions should prefer the newest peer.
    daemon_peer_ids: Vec<String>,
    /// Live daemon peers in registration order for each method. Connections
    /// can overlap during reconnect; the most recently registered owner serves
    /// new calls while older owners remain as deterministic fallbacks.
    rpc_methods: HashMap<String, Vec<String>>,
    pending_rpc: HashMap<String, PendingRpc>,
    /// When the most recent daemon peer disconnected. Used to park new RPC
    /// calls during the reconnect grace window instead of failing them.
    daemon_disconnected_at: Option<DateTime<Utc>>,
}

struct PendingRpc {
    method: String,
    requester_peer_id: String,
    /// Daemon peer currently serving the call; `None` while the call is
    /// parked waiting for a daemon peer to (re)register the method.
    responder_peer_id: Option<String>,
    /// Retained so a parked call can be re-dispatched to a new daemon peer.
    params: EncryptedEnvelope,
    expires_at: DateTime<Utc>,
}

impl LiveSession {
    fn daemon_connected(&self) -> bool {
        self.peers
            .values()
            .any(|peer| matches!(peer.role, RelayPeerRole::Daemon))
    }

    fn rpc_owner(&self, method: &str) -> Option<(&str, &PeerHandle)> {
        self.rpc_methods
            .get(method)?
            .iter()
            .rev()
            .find_map(|peer_id| {
                self.peers
                    .get(peer_id)
                    .filter(|peer| matches!(peer.role, RelayPeerRole::Daemon))
                    .map(|peer| (peer_id.as_str(), peer))
            })
    }

    fn newest_daemon_peer(&self) -> Option<(&str, &PeerHandle)> {
        self.daemon_peer_ids.iter().rev().find_map(|peer_id| {
            self.peers
                .get(peer_id)
                .filter(|peer| matches!(peer.role, RelayPeerRole::Daemon))
                .map(|peer| (peer_id.as_str(), peer))
        })
    }

    fn daemon_rpc_ready(&self) -> bool {
        [REQUIRED_SYNC_RPC_METHOD, REQUIRED_THREAD_DETAIL_RPC_METHOD]
            .into_iter()
            .all(|method| self.rpc_owner(method).is_some())
    }

    /// Remove expired pending RPC entries, returning the requester peers
    /// (if still connected) that should receive a failure result. The
    /// returned request ids have their peer namespace stripped, ready to
    /// deliver to the requester.
    fn take_expired_rpcs(
        &mut self,
        now: DateTime<Utc>,
    ) -> Vec<(String, String, String, mpsc::Sender<RelayServerMessage>)> {
        let expired_request_ids = self
            .pending_rpc
            .iter()
            .filter(|(_, pending)| pending.expires_at <= now)
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        let mut notify = Vec::new();
        for request_id in expired_request_ids {
            if let Some(pending) = self.pending_rpc.remove(&request_id)
                && let Some(requester) = self.peers.get(&pending.requester_peer_id)
            {
                notify.push((
                    strip_rpc_request_id_namespace(&pending.requester_peer_id, &request_id),
                    pending.method,
                    pending.requester_peer_id.clone(),
                    requester.tx.clone(),
                ));
            }
        }
        notify
    }
}

#[derive(Debug, Clone)]
struct WebSocketTicket {
    session_id: String,
    role: RelayPeerRole,
    device_id: Option<String>,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct QueuedActionRecord {
    pub(crate) action_id: String,
    pub(crate) session_id: String,
    pub(crate) device_id: String,
    pub(crate) action_type: String,
    pub(crate) idempotency_key: String,
    pub(crate) payload: EncryptedEnvelope,
    pub(crate) status: QueuedRemoteActionStatus,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
    pub(crate) error: Option<String>,
    pub(crate) result: Option<EncryptedEnvelope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) owner_peer_id: Option<String>,
}

#[derive(Clone)]
struct PeerHandle {
    role: RelayPeerRole,
    device_id: Option<String>,
    tx: mpsc::Sender<RelayServerMessage>,
}

#[derive(Debug, Clone)]
pub struct SessionAuth {
    pub session_id: String,
    pub role: RelayPeerRole,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum PersistMode {
    Deferred,
    Immediate,
}

fn default_next_seq() -> u64 {
    1
}

impl AppState {
    pub async fn load(
        version: String,
        state_path: PathBuf,
        default_pairing_ttl: Duration,
    ) -> Result<Self, RelayError> {
        Self::load_with_retention(
            version,
            state_path,
            default_pairing_ttl,
            RetentionConfig::default(),
        )
        .await
    }

    pub async fn load_with_retention(
        version: String,
        state_path: PathBuf,
        default_pairing_ttl: Duration,
        retention: RetentionConfig,
    ) -> Result<Self, RelayError> {
        let mut data = crate::persistence::load_file_state(&state_path).await?;
        for session in data.sessions.values_mut() {
            session.migrate_legacy_device_fields();
            session.ensure_next_seq();
        }
        let normalized = normalize_in_flight_actions(&mut data);
        let backend = Arc::new(crate::persistence::FileBackend::new(state_path));
        let state = Self::from_parts(version, default_pairing_ttl, retention, data, backend, true);
        let pruned = !state.prune_expired_state().await?.is_empty();
        if normalized || pruned {
            state.persist_current().await?;
        }
        state.spawn_prune_task();
        Ok(state)
    }

    pub async fn load_postgres(
        version: String,
        database_url: String,
        default_pairing_ttl: Duration,
    ) -> Result<Self, RelayError> {
        Self::load_postgres_with_retention(
            version,
            database_url,
            default_pairing_ttl,
            RetentionConfig::default(),
        )
        .await
    }

    pub async fn load_postgres_with_retention(
        version: String,
        database_url: String,
        default_pairing_ttl: Duration,
        retention: RetentionConfig,
    ) -> Result<Self, RelayError> {
        let pg = crate::persistence::PostgresBackend::connect(&database_url).await?;
        // Prune in Postgres before decoding replay rows. Loading every row and
        // pruning afterward made a multi-gigabyte replay table require several
        // gigabytes of RAM just to start, repeatedly OOM-killing the service.
        pg.prune_updates_before_load(&retention, Utc::now()).await?;
        let mut data = crate::persistence::load_postgres_state(&pg).await?;
        for session in data.sessions.values_mut() {
            session.migrate_legacy_device_fields();
            session.ensure_next_seq();
        }
        let normalized = normalize_in_flight_actions(&mut data);
        let normalized_action_sessions = normalized.then(|| {
            data.sessions
                .values()
                .filter(|session| !session.actions.is_empty())
                .map(|session| {
                    (
                        session.meta(),
                        session.actions.values().cloned().collect::<Vec<_>>(),
                    )
                })
                .collect::<Vec<_>>()
        });
        let backend = Arc::new(pg);
        let state = Self::from_parts(
            version,
            default_pairing_ttl,
            retention,
            data,
            backend,
            false,
        );
        // Only action rows can change during startup normalization. Persist
        // them directly; rewriting every Postgres table here used to churn
        // the large replay relation and briefly duplicate its storage.
        if let Some(sessions) = normalized_action_sessions {
            for (session, actions) in sessions {
                state
                    .inner
                    .backend
                    .persist_action(&session, &actions)
                    .await?;
            }
        }
        // Use the same targeted deletes as the background pass. A full
        // Postgres rewrite here bloated the replay table on every startup.
        state.prune_retained_state().await?;
        state.spawn_prune_task();
        Ok(state)
    }

    fn from_parts(
        version: String,
        default_pairing_ttl: Duration,
        retention: RetentionConfig,
        data: PersistedState,
        backend: Arc<dyn crate::persistence::PersistenceBackend>,
        needs_flush: bool,
    ) -> Self {
        let push_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(PUSH_REQUEST_TIMEOUT_SECONDS))
            .build()
            // Building only configures a timeout; fall back to the default
            // client rather than failing startup.
            .unwrap_or_else(|_| reqwest::Client::new());
        let push_endpoint = std::env::var("FALCONDECK_RELAY_EXPO_PUSH_URL")
            .unwrap_or_else(|_| EXPO_PUSH_URL.to_string());
        let push_receipts_endpoint = std::env::var("FALCONDECK_RELAY_EXPO_RECEIPTS_URL")
            .unwrap_or_else(|_| EXPO_RECEIPTS_URL.to_string());
        let push_access_token = std::env::var("FALCONDECK_RELAY_EXPO_ACCESS_TOKEN")
            .ok()
            .filter(|value| !value.trim().is_empty());
        Self {
            inner: Arc::new(InnerState {
                version,
                default_pairing_ttl,
                retention,
                store: Arc::new(Mutex::new(Store {
                    data,
                    live_sessions: HashMap::new(),
                    ws_tickets: HashMap::new(),
                    pairing_challenges: HashMap::new(),
                    push_dedupe: HashMap::new(),
                })),
                backend,
                needs_flush,
                push_client,
                push_endpoint,
                push_access_token,
                push_receipts_endpoint,
            }),
        }
    }

    pub async fn health(&self) -> RelayHealthResponse {
        let store = self.inner.store.lock().await;
        let now = Utc::now();
        let pending_pairings = store
            .data
            .pairings
            .values()
            .filter(|pairing| pairing.device_id.is_none() && pairing.expires_at > now)
            .count();
        let connected_sessions = store
            .live_sessions
            .values()
            .filter(|live| !live.peers.is_empty())
            .count();

        RelayHealthResponse {
            ok: true,
            service: "falcondeck-relay".to_string(),
            version: self.inner.version.clone(),
            pending_pairings,
            active_sessions: store.data.sessions.len(),
            connected_sessions,
        }
    }

    pub async fn start_pairing(
        &self,
        request: StartPairingRequest,
    ) -> Result<StartPairingResponse, RelayError> {
        let ttl_seconds = request
            .ttl_seconds
            .unwrap_or_else(|| self.inner.default_pairing_ttl.num_seconds().max(1) as u64);
        if ttl_seconds == 0 || ttl_seconds > 86_400 {
            return Err(RelayError::BadRequest(
                "ttl_seconds must be between 1 and 86400".to_string(),
            ));
        }
        if request.daemon_bundle.is_none() {
            return Err(RelayError::BadRequest(
                "daemon_bundle with a public key is required".to_string(),
            ));
        }
        if let Some(bundle) = request.daemon_bundle.as_ref() {
            verify_pairing_public_key_bundle(bundle).map_err(|_| {
                RelayError::BadRequest("daemon_bundle signature is invalid".to_string())
            })?;
        }

        let now = Utc::now();
        let expires_at = now + Duration::seconds(ttl_seconds as i64);
        let pairing_id = format!("pairing-{}", Uuid::new_v4().simple());
        let mut session_id = format!("session-{}", Uuid::new_v4().simple());
        let pairing_code;
        let mut daemon_token = format!("daemon-{}", Uuid::new_v4().simple());

        let (session_snapshot, pairing_snapshot) = {
            let mut store = self.inner.store.lock().await;
            pairing_code = generate_pairing_code(&store.data);
            let session_snapshot;
            if let Some(existing_session_id) = request.existing_session_id.as_ref() {
                let session = store
                    .data
                    .sessions
                    .get_mut(existing_session_id)
                    .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
                let provided_token = request.daemon_token.as_deref().ok_or_else(|| {
                    RelayError::Unauthorized("daemon token is required".to_string())
                })?;
                if !constant_time_eq(&session.daemon_token, provided_token) {
                    return Err(RelayError::Unauthorized("invalid daemon token".to_string()));
                }
                session.updated_at = now;
                session_id = existing_session_id.clone();
                daemon_token = session.daemon_token.clone();
                session_snapshot = session.meta();
            } else {
                let session = SessionRecord {
                    session_id: session_id.clone(),
                    pairing_id: pairing_id.clone(),
                    daemon_token: daemon_token.clone(),
                    daemon_last_seen_at: None,
                    devices: HashMap::new(),
                    device_id: None,
                    device_created_at: None,
                    client_token: None,
                    client_label: None,
                    client_public_key: None,
                    client_last_seen_at: None,
                    revoked_at: None,
                    created_at: now,
                    updated_at: now,
                    next_seq: 1,
                    oldest_lost_seq: 0,
                    updates: Vec::new(),
                    actions: HashMap::new(),
                };
                session_snapshot = session.meta();
                store.data.sessions.insert(session_id.clone(), session);
            }
            let pairing = PairingRecord {
                pairing_id: pairing_id.clone(),
                pairing_code: pairing_code.clone(),
                daemon_token: daemon_token.clone(),
                label: request.label,
                session_id: session_id.clone(),
                device_id: None,
                daemon_bundle: request.daemon_bundle,
                client_bundle: None,
                created_at: now,
                expires_at,
            };
            store
                .data
                .pairings
                .insert(pairing_id.clone(), pairing.clone());
            (session_snapshot, pairing)
        };

        self.persist_pairing_state(
            Some(&session_snapshot),
            Some(&pairing_snapshot),
            PersistMode::Immediate,
        )
        .await?;

        Ok(StartPairingResponse {
            pairing_id,
            session_id,
            pairing_code,
            daemon_token,
            expires_at,
        })
    }

    /// Issues a single-use challenge that a client must sign with its
    /// identity secret key before `claim_pairing` accepts the claim. The
    /// pairing code is the capability here, exactly as for the claim itself.
    pub async fn create_pairing_challenge(
        &self,
        request: PairingChallengeRequest,
    ) -> Result<PairingChallengeResponse, RelayError> {
        let pairing_code = request.pairing_code.trim().to_uppercase();
        if pairing_code.is_empty() {
            return Err(RelayError::BadRequest(
                "pairing_code is required".to_string(),
            ));
        }

        let now = Utc::now();
        let mut store = self.inner.store.lock().await;
        store
            .pairing_challenges
            .retain(|_, challenge| challenge.expires_at > now);
        // Expired unclaimed pairings are treated as absent even before the
        // background sweep removes them; claimed pairings stay addressable
        // so re-claims keep their existing expiry semantics.
        let (pairing_id, expires_at) = store
            .data
            .pairings
            .values()
            .find(|pairing| {
                constant_time_eq(&pairing.pairing_code, &pairing_code)
                    && (pairing.device_id.is_some() || pairing.expires_at > now)
            })
            .map(|pairing| (pairing.pairing_id.clone(), pairing.expires_at))
            .ok_or_else(|| RelayError::NotFound("pairing not found".to_string()))?;
        if expires_at <= now {
            return Err(RelayError::Conflict("pairing has expired".to_string()));
        }

        let challenge = generate_pairing_challenge();
        // Inserting replaces any outstanding challenge for the pairing, so
        // at most one challenge is valid at a time.
        store.pairing_challenges.insert(
            pairing_id.clone(),
            PairingChallenge {
                challenge: challenge.clone(),
                expires_at: now + Duration::seconds(PAIRING_CHALLENGE_TTL_SECONDS),
            },
        );

        Ok(PairingChallengeResponse {
            pairing_id,
            challenge,
        })
    }

    pub async fn claim_pairing(
        &self,
        request: ClaimPairingRequest,
    ) -> Result<ClaimPairingResponse, RelayError> {
        let pairing_code = request.pairing_code.trim().to_uppercase();
        if pairing_code.is_empty() {
            return Err(RelayError::BadRequest(
                "pairing_code is required".to_string(),
            ));
        }
        let Some(client_bundle) = request.client_bundle.as_ref() else {
            return Err(RelayError::BadRequest(
                "client_bundle with a public key is required".to_string(),
            ));
        };

        let now = Utc::now();
        let claimed_public_key = request
            .client_bundle
            .as_ref()
            .map(|bundle| bundle.public_key.clone());
        let (response, session_snapshot, pairing_snapshot, device_snapshot) = {
            let mut store = self.inner.store.lock().await;
            // Expired unclaimed pairings are treated as absent even before
            // the background sweep removes them; claimed pairings fall
            // through to the expiry check below.
            let pairing_id = store
                .data
                .pairings
                .iter()
                .find_map(|(pairing_id, pairing)| {
                    (constant_time_eq(&pairing.pairing_code, &pairing_code)
                        && (pairing.device_id.is_some() || pairing.expires_at > now))
                        .then_some(pairing_id.clone())
                })
                .ok_or_else(|| RelayError::NotFound("pairing not found".to_string()))?;
            let (
                session_id,
                claimed_device_id,
                stored_client_bundle,
                daemon_bundle,
                pairing_snapshot,
            ) = {
                let pairing = store
                    .data
                    .pairings
                    .get(&pairing_id)
                    .ok_or_else(|| RelayError::NotFound("pairing not found".to_string()))?;
                if pairing.expires_at <= now {
                    return Err(RelayError::Conflict("pairing has expired".to_string()));
                }
                (
                    pairing.session_id.clone(),
                    pairing.device_id.clone(),
                    pairing.client_bundle.clone(),
                    pairing.daemon_bundle.clone(),
                    pairing.clone(),
                )
            };

            // Take the outstanding challenge for this pairing. Removing it up
            // front makes every challenge single-use even when the claim
            // fails further down.
            let challenge = store
                .pairing_challenges
                .remove(&pairing_id)
                .filter(|challenge| challenge.expires_at > now)
                .ok_or_else(|| {
                    RelayError::BadRequest(
                        "pairing challenge missing or expired; request a new challenge".to_string(),
                    )
                })?;
            verify_pairing_public_key_bundle(client_bundle).map_err(|_| {
                RelayError::BadRequest("client_bundle signature is invalid".to_string())
            })?;
            // Proof of possession: the claimer must have signed the relay's
            // challenge with the secret half of the bundle's identity key, so
            // a stolen bundle alone can neither claim nor re-attach.
            verify_pairing_claim_challenge(
                &client_bundle.identity_public_key,
                &pairing_code,
                &challenge.challenge,
                &request.challenge_signature,
            )
            .map_err(|_| {
                RelayError::Unauthorized("pairing challenge signature is invalid".to_string())
            })?;

            let session = store
                .data
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
            if let Some(claimed_device_id) = claimed_device_id {
                // Re-attaching to an already-claimed pairing requires the
                // existing device to be active, its stored identity key
                // (when present) to match the claimer's, and the box key to
                // match either the device record or the bundle stored at
                // the original claim. The bundle's self-signature does NOT
                // bind the box key to the identity key, so a box-key match
                // alone must never hand out the device's client token.
                let matches_claimed_device =
                    session
                        .devices
                        .get(&claimed_device_id)
                        .is_some_and(|device| {
                            device.revoked_at.is_none()
                                && device.identity_public_key.as_ref().is_none_or(|identity| {
                                    identity == &client_bundle.identity_public_key
                                })
                                && (device.public_key.as_ref() == claimed_public_key.as_ref()
                                    || stored_client_bundle
                                        .as_ref()
                                        .zip(claimed_public_key.as_ref())
                                        .is_some_and(|(bundle, public_key)| {
                                            &bundle.public_key == public_key
                                                && (bundle.identity_public_key.is_empty()
                                                    || bundle.identity_public_key
                                                        == client_bundle.identity_public_key)
                                        }))
                        });
                if !matches_claimed_device {
                    return Err(RelayError::Conflict(
                        "pairing has already been claimed".to_string(),
                    ));
                }

                let client_token = {
                    let existing =
                        session.devices.get_mut(&claimed_device_id).ok_or_else(|| {
                            RelayError::NotFound("existing trusted device not found".to_string())
                        })?;
                    existing.label = request.label.clone();
                    existing.last_seen_at = Some(now);
                    if existing.public_key.is_none() {
                        existing.public_key = claimed_public_key.clone();
                    }
                    if existing.identity_public_key.is_none() {
                        existing.identity_public_key =
                            Some(client_bundle.identity_public_key.clone());
                    }
                    existing.client_token.clone()
                };
                session.updated_at = now;
                session.clear_legacy_device_fields();

                let trusted_device = session
                    .trusted_devices()
                    .into_iter()
                    .find(|device| device.device_id == claimed_device_id)
                    .ok_or_else(|| {
                        RelayError::Conflict("trusted device was not created".to_string())
                    })?;
                let session_snapshot = session.meta();
                let device_snapshot = session.devices.get(&claimed_device_id).cloned();

                (
                    ClaimPairingResponse {
                        pairing_id: pairing_id.clone(),
                        session_id,
                        device_id: claimed_device_id.clone(),
                        client_token,
                        trusted_device,
                        daemon_bundle,
                    },
                    session_snapshot,
                    pairing_snapshot,
                    device_snapshot,
                )
            } else {
                let existing_device_id = claimed_public_key.as_ref().and_then(|public_key| {
                    session.devices.iter().find_map(|(device_id, device)| {
                        (device.revoked_at.is_none()
                            && device.public_key.as_ref() == Some(public_key)
                            && device.identity_public_key.as_ref().is_none_or(|identity| {
                                identity == &client_bundle.identity_public_key
                            }))
                        .then_some(device_id.clone())
                    })
                });
                let (device_id, client_token) = if let Some(existing_device_id) = existing_device_id
                {
                    let existing =
                        session
                            .devices
                            .get_mut(&existing_device_id)
                            .ok_or_else(|| {
                                RelayError::NotFound(
                                    "existing trusted device not found".to_string(),
                                )
                            })?;
                    existing.label = request.label.clone();
                    existing.last_seen_at = Some(now);
                    if existing.public_key.is_none() {
                        existing.public_key = claimed_public_key.clone();
                    }
                    if existing.identity_public_key.is_none() {
                        existing.identity_public_key =
                            Some(client_bundle.identity_public_key.clone());
                    }
                    (existing_device_id, existing.client_token.clone())
                } else {
                    let device_id = format!("device-{}", Uuid::new_v4().simple());
                    let client_token = format!("client-{}", Uuid::new_v4().simple());
                    session.devices.insert(
                        device_id.clone(),
                        TrustedDeviceRecord {
                            device_id: device_id.clone(),
                            client_token: client_token.clone(),
                            label: request.label.clone(),
                            public_key: claimed_public_key.clone(),
                            identity_public_key: Some(client_bundle.identity_public_key.clone()),
                            created_at: now,
                            last_seen_at: Some(now),
                            revoked_at: None,
                            push_token: None,
                        },
                    );
                    (device_id, client_token)
                };
                session.updated_at = now;
                session.clear_legacy_device_fields();

                let trusted_device = session
                    .trusted_devices()
                    .into_iter()
                    .find(|device| device.device_id == device_id)
                    .ok_or_else(|| {
                        RelayError::Conflict("trusted device was not created".to_string())
                    })?;
                let session_snapshot = session.meta();
                let device_snapshot = session.devices.get(&device_id).cloned();
                let pairing = store
                    .data
                    .pairings
                    .get_mut(&pairing_id)
                    .ok_or_else(|| RelayError::NotFound("pairing not found".to_string()))?;
                pairing.client_bundle = request.client_bundle.clone();
                pairing.device_id = Some(device_id.clone());
                let daemon_bundle = pairing.daemon_bundle.clone();
                let pairing_snapshot = pairing.clone();

                (
                    ClaimPairingResponse {
                        pairing_id: pairing_id.clone(),
                        session_id,
                        device_id: device_id.clone(),
                        client_token,
                        trusted_device,
                        daemon_bundle,
                    },
                    session_snapshot,
                    pairing_snapshot,
                    device_snapshot,
                )
            }
        };

        self.persist_pairing_state(
            Some(&session_snapshot),
            Some(&pairing_snapshot),
            PersistMode::Immediate,
        )
        .await?;
        self.persist_device_state(
            &session_snapshot,
            device_snapshot.as_ref(),
            PersistMode::Immediate,
        )
        .await?;
        Ok(response)
    }

    pub async fn pairing_status(
        &self,
        pairing_id: &str,
        daemon_token: &str,
    ) -> Result<PairingStatusResponse, RelayError> {
        let store = self.inner.store.lock().await;
        let pairing = store
            .data
            .pairings
            .get(pairing_id)
            .ok_or_else(|| RelayError::NotFound("pairing not found".to_string()))?;

        if !constant_time_eq(&pairing.daemon_token, daemon_token) {
            return Err(RelayError::Unauthorized("invalid daemon token".to_string()));
        }

        Ok(PairingStatusResponse {
            pairing_id: pairing.pairing_id.clone(),
            label: pairing.label.clone(),
            status: pairing.status(),
            session_id: Some(pairing.session_id.clone()),
            device_id: pairing.device_id.clone(),
            expires_at: pairing.expires_at,
            daemon_bundle: pairing.daemon_bundle.clone(),
            client_bundle: pairing.client_bundle.clone(),
        })
    }

    pub async fn session_updates(
        &self,
        session_id: &str,
        token: &str,
        after_seq: u64,
    ) -> Result<RelayUpdatesResponse, RelayError> {
        let _ = self.authenticate_session(session_id, token).await?;

        let store = self.inner.store.lock().await;
        let session = store
            .data
            .sessions
            .get(session_id)
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
        let history_truncated = session.history_truncated(after_seq);

        Ok(RelayUpdatesResponse {
            session_id: session.session_id.clone(),
            updates: session
                .updates
                .iter()
                .filter(|update| update.seq > after_seq)
                .cloned()
                .collect(),
            next_seq: session.next_seq(),
            cursor: SyncCursor {
                session_id: session.session_id.clone(),
                next_seq: session.next_seq(),
                last_acknowledged_seq: after_seq,
                requires_bootstrap: after_seq == 0,
                history_truncated,
            },
            presence: session.machine_presence(store.live_sessions.get(session_id)),
        })
    }

    pub async fn authenticate_session(
        &self,
        session_id: &str,
        token: &str,
    ) -> Result<SessionAuth, RelayError> {
        let mut store = self.inner.store.lock().await;
        let session = store
            .data
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
        session.migrate_legacy_device_fields();

        let (role, device_id) = if constant_time_eq(&session.daemon_token, token) {
            (RelayPeerRole::Daemon, None)
        } else if let Some(device) = session.devices.values().find(|device| {
            constant_time_eq(&device.client_token, token) && device.revoked_at.is_none()
        }) {
            (RelayPeerRole::Client, Some(device.device_id.clone()))
        } else {
            return Err(RelayError::Unauthorized(
                "invalid session token".to_string(),
            ));
        };

        Ok(SessionAuth {
            session_id: session_id.to_string(),
            role,
            device_id,
        })
    }

    pub async fn issue_ws_ticket(
        &self,
        session_id: &str,
        token: &str,
    ) -> Result<falcondeck_core::RelayWebSocketTicketResponse, RelayError> {
        let auth = self.authenticate_session(session_id, token).await?;
        let expires_at = Utc::now() + Duration::seconds(WS_TICKET_TTL_SECONDS);
        let ticket = format!("wst-{}", Uuid::new_v4().simple());
        let mut store = self.inner.store.lock().await;
        store
            .ws_tickets
            .retain(|_, entry| entry.expires_at > Utc::now());
        store.ws_tickets.insert(
            ticket.clone(),
            WebSocketTicket {
                session_id: auth.session_id.clone(),
                role: auth.role,
                device_id: auth.device_id,
                expires_at,
            },
        );
        Ok(falcondeck_core::RelayWebSocketTicketResponse { ticket, expires_at })
    }

    pub async fn consume_ws_ticket(
        &self,
        session_id: &str,
        ticket: &str,
    ) -> Result<SessionAuth, RelayError> {
        let mut store = self.inner.store.lock().await;
        store
            .ws_tickets
            .retain(|_, entry| entry.expires_at > Utc::now());
        let matched = store
            .ws_tickets
            .keys()
            .find(|candidate| constant_time_eq(candidate, ticket))
            .cloned();
        let entry = matched
            .and_then(|key| store.ws_tickets.remove(&key))
            .ok_or_else(|| RelayError::Unauthorized("invalid websocket ticket".to_string()))?;
        if entry.session_id != session_id {
            return Err(RelayError::Unauthorized(
                "websocket ticket does not match session".to_string(),
            ));
        }
        // The device may have been revoked between ticket issuance and use;
        // re-check the record so a pre-issued ticket cannot bypass revocation.
        if matches!(entry.role, RelayPeerRole::Client) {
            let device_active =
                store
                    .data
                    .sessions
                    .get_mut(&entry.session_id)
                    .is_some_and(|session| {
                        session.migrate_legacy_device_fields();
                        entry.device_id.as_deref().is_some_and(|device_id| {
                            session
                                .devices
                                .get(device_id)
                                .is_some_and(|device| device.revoked_at.is_none())
                        })
                    });
            if !device_active {
                return Err(RelayError::Unauthorized(
                    "trusted device is revoked or missing".to_string(),
                ));
            }
        }
        Ok(SessionAuth {
            session_id: entry.session_id,
            role: entry.role,
            device_id: entry.device_id,
        })
    }

    pub async fn register_peer(
        &self,
        session_id: &str,
        role: RelayPeerRole,
        device_id: Option<String>,
    ) -> Result<
        (
            String,
            mpsc::Receiver<RelayServerMessage>,
            RelayServerMessage,
        ),
        RelayError,
    > {
        let (tx, rx) = mpsc::channel(PEER_QUEUE_CAPACITY);
        let mut store = self.inner.store.lock().await;
        let session = store
            .data
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
        session.migrate_legacy_device_fields();
        let now = Utc::now();
        match role {
            RelayPeerRole::Daemon => {
                session.daemon_last_seen_at = Some(now);
            }
            RelayPeerRole::Client => {
                let device = device_id
                    .as_ref()
                    .and_then(|current_device_id| session.devices.get_mut(current_device_id))
                    .filter(|device| device.revoked_at.is_none())
                    .ok_or_else(|| {
                        RelayError::Unauthorized("trusted device is revoked or missing".to_string())
                    })?;
                device.last_seen_at = Some(now);
            }
        }
        session.updated_at = now;
        let next_seq = session.next_seq();
        let peer_id = format!("peer-{}", Uuid::new_v4().simple());
        let live = store
            .live_sessions
            .entry(session_id.to_string())
            .or_default();
        live.peers.insert(
            peer_id.clone(),
            PeerHandle {
                role: role.clone(),
                device_id,
                tx,
            },
        );
        if matches!(role, RelayPeerRole::Daemon) {
            live.daemon_peer_ids.push(peer_id.clone());
        }

        Ok((
            peer_id,
            rx,
            RelayServerMessage::Ready {
                session_id: session_id.to_string(),
                role,
                next_seq,
            },
        ))
    }

    pub async fn after_peer_ready(&self, session_id: &str, role: RelayPeerRole) {
        if matches!(role, RelayPeerRole::Daemon) {
            self.dispatch_pending_actions(session_id).await;
        }
        self.broadcast_presence(session_id).await;
    }

    pub async fn unregister_peer(&self, session_id: &str, peer_id: &str) {
        let mut deferred = Vec::new();
        let mut requeued_actions = Vec::new();
        let mut requeued_records = Vec::new();
        let mut session_snapshot = None;
        let mut should_redispatch = false;
        let mut removed_peer = false;
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                removed_peer = live.peers.remove(peer_id).is_some();
                if removed_peer
                    && live
                        .daemon_peer_ids
                        .iter()
                        .any(|daemon_peer_id| daemon_peer_id == peer_id)
                {
                    live.daemon_disconnected_at = Some(Utc::now());
                }
                live.daemon_peer_ids
                    .retain(|daemon_peer_id| daemon_peer_id != peer_id);
                live.rpc_methods.retain(|_, owner_peer_ids| {
                    owner_peer_ids.retain(|owner_peer_id| owner_peer_id != peer_id);
                    !owner_peer_ids.is_empty()
                });

                let stale_request_ids = live
                    .pending_rpc
                    .iter()
                    .filter_map(|(request_id, pending)| {
                        if pending.requester_peer_id == peer_id {
                            Some(request_id.clone())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>();
                for request_id in stale_request_ids {
                    live.pending_rpc.remove(&request_id);
                }

                let orphaned_request_ids = live
                    .pending_rpc
                    .iter()
                    .filter_map(|(request_id, pending)| {
                        if pending.responder_peer_id.as_deref() == Some(peer_id) {
                            Some(request_id.clone())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>();
                for request_id in orphaned_request_ids {
                    // Overlapping daemon connections are routine during a
                    // reconnect, and a lone daemon usually returns within
                    // seconds — so hand the call to a surviving owner, or
                    // park it for the next one to adopt, instead of failing
                    // a request the client was just told would work. The
                    // TTL sweep still fails calls no daemon ever picks up.
                    let Some(method) = live
                        .pending_rpc
                        .get(&request_id)
                        .map(|pending| pending.method.clone())
                    else {
                        continue;
                    };
                    let surviving_owner = live
                        .rpc_owner(&method)
                        .map(|(owner_peer_id, owner)| (owner_peer_id.to_owned(), owner.tx.clone()));
                    let Some(pending) = live.pending_rpc.get_mut(&request_id) else {
                        continue;
                    };
                    match surviving_owner {
                        Some((owner_peer_id, owner_tx)) => {
                            pending.responder_peer_id = Some(owner_peer_id.clone());
                            deferred.push((
                                owner_peer_id,
                                owner_tx,
                                RelayServerMessage::RpcRequest {
                                    request_id,
                                    method,
                                    params: pending.params.clone(),
                                },
                            ));
                        }
                        None => {
                            warn!(
                                session_id,
                                request_id,
                                method,
                                responder_peer_id = peer_id,
                                "relay rpc responder disconnected; parking call for the next daemon peer"
                            );
                            pending.responder_peer_id = None;
                        }
                    }
                }

                if live.peers.is_empty() {
                    store.live_sessions.remove(session_id);
                }
            }
            if let Some(session) = store.data.sessions.get_mut(session_id) {
                let now = Utc::now();
                for action in session.actions.values_mut() {
                    if action.owner_peer_id.as_deref() != Some(peer_id) {
                        continue;
                    }
                    if !matches!(
                        action.status,
                        QueuedRemoteActionStatus::Dispatched | QueuedRemoteActionStatus::Executing
                    ) {
                        continue;
                    }
                    action.status = QueuedRemoteActionStatus::Queued;
                    action.updated_at = now;
                    action.error = None;
                    action.result = None;
                    action.owner_peer_id = None;
                    requeued_actions.push(action.to_public());
                    requeued_records.push(action.clone());
                    should_redispatch = true;
                }
                if removed_peer || !requeued_records.is_empty() {
                    session.updated_at = now;
                    session_snapshot = Some(session.meta());
                }
            }
        }

        // `queue_message` spawns one unregister task per failed send, so a
        // burst can call this for a peer that is already gone; skip the
        // persist/broadcast tail instead of bumping timestamps and burning
        // a presence sequence number for a no-op.
        if !removed_peer && requeued_records.is_empty() && deferred.is_empty() {
            return;
        }

        if let Some(session) = session_snapshot.as_ref() {
            let _ = self
                .persist_action_state(session, &requeued_records, PersistMode::Immediate)
                .await;
        }
        for (requester_peer_id, tx, message) in deferred {
            self.queue_message(session_id, &requester_peer_id, &tx, message);
        }
        for action in requeued_actions {
            let _ = self
                .append_update(
                    session_id,
                    RelayUpdateBody::ActionStatus { action },
                    PersistMode::Immediate,
                )
                .await;
        }
        if should_redispatch {
            self.dispatch_pending_actions(session_id).await;
        }
        self.broadcast_presence(session_id).await;
    }

    pub async fn handle_message(
        &self,
        session_id: &str,
        peer_id: &str,
        role: RelayPeerRole,
        message: RelayClientMessage,
    ) -> Result<(), RelayError> {
        match message {
            RelayClientMessage::Ping => {
                let current_device_id = {
                    let store = self.inner.store.lock().await;
                    store
                        .live_sessions
                        .get(session_id)
                        .and_then(|live| live.peers.get(peer_id))
                        .and_then(|peer| peer.device_id.clone())
                };
                self.touch_presence(session_id, role.clone(), current_device_id.as_deref())
                    .await;
                self.send_to_peer(session_id, peer_id, RelayServerMessage::Pong)
                    .await;
            }
            RelayClientMessage::Sync { after_seq } => {
                self.send_sync_to_peer(session_id, peer_id, after_seq.unwrap_or(0))
                    .await?;
            }
            RelayClientMessage::Update { body } => {
                // Only the daemon writes durable updates; a client peer must
                // not be able to forge Presence/ActionStatus/SessionBootstrap
                // bodies into the replay log.
                if !matches!(role, RelayPeerRole::Daemon) {
                    return Err(RelayError::Unauthorized(
                        "only daemon peers may submit durable updates".to_string(),
                    ));
                }
                self.append_update(session_id, body, PersistMode::Deferred)
                    .await?;
            }
            RelayClientMessage::Ephemeral { body } => {
                // The sender already has the payload; echoing it back only
                // burns queue capacity.
                self.broadcast_except(
                    session_id,
                    Some(peer_id),
                    RelayServerMessage::Ephemeral { body },
                )
                .await;
            }
            RelayClientMessage::RpcRegister { method } => {
                if !matches!(role, RelayPeerRole::Daemon) {
                    return Err(RelayError::Unauthorized(
                        "only daemon peers may register rpc handlers".to_string(),
                    ));
                }
                self.register_rpc_method(session_id, peer_id, method).await;
            }
            RelayClientMessage::RpcUnregister { method } => {
                if !matches!(role, RelayPeerRole::Daemon) {
                    return Err(RelayError::Unauthorized(
                        "only daemon peers may unregister rpc handlers".to_string(),
                    ));
                }
                self.unregister_rpc_method(session_id, peer_id, method)
                    .await;
            }
            RelayClientMessage::RpcCall {
                request_id,
                method,
                params,
            } => {
                if !matches!(role, RelayPeerRole::Client) {
                    return Err(RelayError::Unauthorized(
                        "only client peers may initiate rpc calls".to_string(),
                    ));
                }
                if request_id.len() > MAX_RPC_REQUEST_ID_LENGTH {
                    return Err(RelayError::BadRequest(format!(
                        "rpc request_id must not exceed {MAX_RPC_REQUEST_ID_LENGTH} characters"
                    )));
                }
                self.forward_rpc_call(session_id, peer_id, request_id, method, params)
                    .await;
            }
            RelayClientMessage::RpcResult {
                request_id,
                ok,
                result,
                error,
            } => {
                if !matches!(role, RelayPeerRole::Daemon) {
                    return Err(RelayError::Unauthorized(
                        "only daemon peers may resolve rpc calls".to_string(),
                    ));
                }
                self.resolve_rpc(session_id, peer_id, request_id, ok, result, error)
                    .await;
            }
            RelayClientMessage::ActionUpdate {
                action_id,
                status,
                error,
                result,
            } => {
                if !matches!(role, RelayPeerRole::Daemon) {
                    return Err(RelayError::Unauthorized(
                        "only daemon peers may update queued actions".to_string(),
                    ));
                }
                self.update_action(session_id, peer_id, &action_id, status, error, result)
                    .await?;
                // Dispatch passes are capped at MAX_ACTIONS_PER_DISPATCH, so
                // re-run after each daemon action update to drain any backlog.
                self.dispatch_pending_actions(session_id).await;
            }
            RelayClientMessage::Notify {
                kind,
                workspace_id,
                thread_id,
            } => {
                if !matches!(role, RelayPeerRole::Daemon) {
                    return Err(RelayError::Unauthorized(
                        "only daemon peers may request push notifications".to_string(),
                    ));
                }
                self.dispatch_push_notifications(session_id, kind, workspace_id, thread_id)
                    .await;
            }
        }

        Ok(())
    }

    async fn append_update(
        &self,
        session_id: &str,
        body: RelayUpdateBody,
        persist_mode: PersistMode,
    ) -> Result<(), RelayError> {
        let (update, session, superseded_presence_ids) = {
            let mut store = self.inner.store.lock().await;
            self.append_update_locked(&mut store, session_id, body)?
        };
        self.persist_appended_update(
            session_id,
            &session,
            &update,
            &superseded_presence_ids,
            persist_mode,
        )
        .await
    }

    /// Append an update to the session's replay log and fan it out to the
    /// connected peers, all under the store lock: try_send is non-blocking,
    /// and releasing the lock first would let two concurrent appends
    /// deliver seq N+1 before seq N. Callers must follow up with
    /// `persist_appended_update` once the lock is released.
    fn append_update_locked(
        &self,
        store: &mut Store,
        session_id: &str,
        body: RelayUpdateBody,
    ) -> Result<(RelayUpdate, SessionMeta, Vec<String>), RelayError> {
        let update;
        let session_snapshot;
        let mut superseded_presence_ids = Vec::new();
        {
            let session = store
                .data
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
            if matches!(body, RelayUpdateBody::Presence { .. }) {
                // Clients only care about the latest presence snapshot;
                // dropping the superseded rows keeps churny peers from
                // pushing real updates out of the retained window.
                // Sequence numbers are never reused.
                superseded_presence_ids = session
                    .updates
                    .iter()
                    .filter(|update| matches!(update.body, RelayUpdateBody::Presence { .. }))
                    .map(|update| update.id.clone())
                    .collect();
                if !superseded_presence_ids.is_empty() {
                    session
                        .updates
                        .retain(|update| !matches!(update.body, RelayUpdateBody::Presence { .. }));
                }
            }
            update = RelayUpdate {
                id: format!("update-{}", Uuid::new_v4().simple()),
                seq: session.next_seq,
                body,
                created_at: Utc::now(),
            };
            session.next_seq = session.next_seq.saturating_add(1);
            session.updated_at = update.created_at;
            session.updates.push(update.clone());
            session_snapshot = session.meta();
        }
        if let Some(live) = store.live_sessions.get(session_id) {
            for (peer_id, peer) in &live.peers {
                self.queue_message(
                    session_id,
                    peer_id,
                    &peer.tx,
                    RelayServerMessage::Update {
                        update: update.clone(),
                    },
                );
            }
        }
        Ok((update, session_snapshot, superseded_presence_ids))
    }

    /// Persist the durable side effects of `append_update_locked` after the
    /// store lock has been released.
    async fn persist_appended_update(
        &self,
        session_id: &str,
        session: &SessionMeta,
        update: &RelayUpdate,
        superseded_presence_ids: &[String],
        persist_mode: PersistMode,
    ) -> Result<(), RelayError> {
        if !superseded_presence_ids.is_empty() {
            self.inner
                .backend
                .remove_updates(session_id, superseded_presence_ids)
                .await?;
        }
        self.persist_update_state(session, update, persist_mode)
            .await
    }

    async fn register_rpc_method(&self, session_id: &str, peer_id: &str, method: String) {
        let mut ack = None;
        let mut readiness_changed = false;
        let mut adopted = Vec::new();
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                let was_ready = live.daemon_rpc_ready();
                let owners = live.rpc_methods.entry(method.clone()).or_default();
                if !owners.iter().any(|owner_peer_id| owner_peer_id == peer_id) {
                    owners.push(peer_id.to_string());
                }
                readiness_changed = was_ready != live.daemon_rpc_ready();
                ack = live.peers.get(peer_id).map(|peer| peer.tx.clone());
                // Calls parked while no daemon owned this method (responder
                // vanished mid-flight or the daemon flapped) are adopted by
                // the newly registered owner instead of waiting to expire.
                if let Some(tx) = ack.as_ref() {
                    let parked_request_ids = live
                        .pending_rpc
                        .iter()
                        .filter(|(_, pending)| {
                            pending.responder_peer_id.is_none() && pending.method == method
                        })
                        .map(|(request_id, _)| request_id.clone())
                        .collect::<Vec<_>>();
                    for request_id in parked_request_ids {
                        if let Some(pending) = live.pending_rpc.get_mut(&request_id) {
                            pending.responder_peer_id = Some(peer_id.to_string());
                            adopted.push((
                                tx.clone(),
                                RelayServerMessage::RpcRequest {
                                    request_id,
                                    method: method.clone(),
                                    params: pending.params.clone(),
                                },
                            ));
                        }
                    }
                }
            }
        }

        if let Some(tx) = ack {
            self.queue_message(
                session_id,
                peer_id,
                &tx,
                RelayServerMessage::RpcRegistered { method },
            );
        }
        for (tx, message) in adopted {
            self.queue_message(session_id, peer_id, &tx, message);
        }
        if readiness_changed {
            self.broadcast_presence(session_id).await;
        }
    }

    async fn unregister_rpc_method(&self, session_id: &str, peer_id: &str, method: String) {
        let mut ack = None;
        let mut readiness_changed = false;
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                let was_ready = live.daemon_rpc_ready();
                if live.rpc_methods.get(&method).is_some_and(|owners| {
                    owners.iter().any(|owner_peer_id| owner_peer_id == peer_id)
                }) && let Some(owners) = live.rpc_methods.get_mut(&method)
                {
                    owners.retain(|owner_peer_id| owner_peer_id != peer_id);
                    if owners.is_empty() {
                        live.rpc_methods.remove(&method);
                    }
                }
                readiness_changed = was_ready != live.daemon_rpc_ready();
                ack = live.peers.get(peer_id).map(|peer| peer.tx.clone());
            }
        }

        if let Some(tx) = ack {
            self.queue_message(
                session_id,
                peer_id,
                &tx,
                RelayServerMessage::RpcUnregistered { method },
            );
        }
        if readiness_changed {
            self.broadcast_presence(session_id).await;
        }
    }

    async fn forward_rpc_call(
        &self,
        session_id: &str,
        peer_id: &str,
        request_id: String,
        method: String,
        params: EncryptedEnvelope,
    ) {
        let mut response = None;
        let mut target = None;
        let mut parked = false;
        let mut expired = Vec::new();
        // Forwarded calls carry a peer-namespaced request id so identical
        // client-chosen ids from different devices cannot collide or route
        // a late daemon result to the wrong device; the namespace is
        // stripped again before results reach the requester.
        let namespaced_request_id = namespaced_rpc_request_id(peer_id, &request_id);
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                // Sweeping first also means a duplicate request_id whose
                // previous entry expired is replaced instead of failed.
                expired = live.take_expired_rpcs(Utc::now());
                let requester = live.peers.get(peer_id).map(|peer| peer.tx.clone());
                if live.pending_rpc.contains_key(&namespaced_request_id) {
                    warn!(
                        session_id,
                        peer_id,
                        request_id,
                        method,
                        "rejecting duplicate in-flight relay rpc request"
                    );
                    response = requester.map(|tx| {
                        (
                            peer_id.to_string(),
                            tx,
                            RelayServerMessage::RpcResult {
                                request_id: request_id.clone(),
                                ok: false,
                                result: None,
                                error: None,
                                failure: Some(RelayRpcFailureCode::RequestConflict),
                            },
                        )
                    });
                } else if let Some((owner_peer_id, owner_tx)) = live
                    .rpc_owner(&method)
                    .map(|(peer_id, peer)| (peer_id.to_owned(), peer.tx.clone()))
                {
                    live.pending_rpc.insert(
                        namespaced_request_id.clone(),
                        PendingRpc {
                            method: method.clone(),
                            requester_peer_id: peer_id.to_string(),
                            responder_peer_id: Some(owner_peer_id.clone()),
                            params: params.clone(),
                            expires_at: Utc::now() + Duration::seconds(PENDING_RPC_TTL_SECONDS),
                        },
                    );
                    target = Some((owner_peer_id, owner_tx));
                } else if !live.daemon_connected()
                    && live.daemon_disconnected_at.is_some_and(|disconnected_at| {
                        Utc::now().signed_duration_since(disconnected_at)
                            <= Duration::seconds(DAEMON_RECONNECT_GRACE_SECONDS)
                    })
                {
                    // The daemon was here moments ago and its supervisor
                    // reconnects on a short backoff: park the call so the
                    // reconnect flap resolves invisibly instead of erroring.
                    // A registered-but-missing method on a *connected* daemon
                    // stays a fast failure below — that is version skew, not
                    // a flap. The TTL sweep fails parked calls if no daemon
                    // returns in time.
                    warn!(
                        session_id,
                        peer_id,
                        request_id,
                        method,
                        "daemon just disconnected; parking relay rpc for its reconnect"
                    );
                    live.pending_rpc.insert(
                        namespaced_request_id.clone(),
                        PendingRpc {
                            method: method.clone(),
                            requester_peer_id: peer_id.to_string(),
                            responder_peer_id: None,
                            params: params.clone(),
                            expires_at: Utc::now() + Duration::seconds(PENDING_RPC_TTL_SECONDS),
                        },
                    );
                    parked = true;
                } else {
                    warn!(
                        session_id,
                        peer_id,
                        request_id,
                        method,
                        daemon_connected = live.daemon_connected(),
                        "relay rpc method is unavailable"
                    );
                    response = requester.map(|tx| {
                        (
                            peer_id.to_string(),
                            tx,
                            RelayServerMessage::RpcResult {
                                request_id: request_id.clone(),
                                ok: false,
                                result: None,
                                error: None,
                                failure: Some(RelayRpcFailureCode::MethodUnavailable),
                            },
                        )
                    });
                }
            }
        }

        self.notify_expired_rpcs(session_id, expired);
        let dispatched = target.is_some();
        if let Some((owner_peer_id, tx)) = target {
            self.queue_message(
                session_id,
                &owner_peer_id,
                &tx,
                RelayServerMessage::RpcRequest {
                    request_id: namespaced_request_id,
                    method,
                    params,
                },
            );
        } else if let Some((requester_peer_id, tx, message)) = response {
            self.queue_message(session_id, &requester_peer_id, &tx, message);
        }
        if dispatched || parked {
            // The websocket idle sweep is only a fallback and can run almost
            // ten seconds after the nominal deadline. Schedule a per-request
            // sweep so the relay's structured timeout reaches clients before
            // their 35-second delivery deadline.
            let state = self.clone();
            let session_id = session_id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(
                    PENDING_RPC_TTL_SECONDS as u64,
                ))
                .await;
                state.sweep_expired_rpcs(&session_id).await;
            });
        }
    }

    /// Drop pending RPC entries older than their TTL and fail them back to
    /// the requester, so an unanswered call cannot poison its request_id
    /// forever. Called from RPC paths and the websocket idle-check tick.
    pub async fn sweep_expired_rpcs(&self, session_id: &str) {
        let expired = {
            let mut store = self.inner.store.lock().await;
            store
                .live_sessions
                .get_mut(session_id)
                .map(|live| live.take_expired_rpcs(Utc::now()))
                .unwrap_or_default()
        };
        self.notify_expired_rpcs(session_id, expired);
    }

    fn notify_expired_rpcs(
        &self,
        session_id: &str,
        expired: Vec<(String, String, String, mpsc::Sender<RelayServerMessage>)>,
    ) {
        for (request_id, method, requester_peer_id, tx) in expired {
            warn!(
                session_id,
                request_id, method, "relay rpc request timed out before the daemon replied"
            );
            self.queue_message(
                session_id,
                &requester_peer_id,
                &tx,
                RelayServerMessage::RpcResult {
                    request_id,
                    ok: false,
                    result: None,
                    error: None,
                    failure: Some(RelayRpcFailureCode::TimedOut),
                },
            );
        }
    }

    async fn resolve_rpc(
        &self,
        session_id: &str,
        peer_id: &str,
        request_id: String,
        ok: bool,
        result: Option<EncryptedEnvelope>,
        error: Option<EncryptedEnvelope>,
    ) {
        let mut response = None;
        let mut expired = Vec::new();
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                expired = live.take_expired_rpcs(Utc::now());
                // The daemon echoes the namespaced request id it received,
                // so the pending entry is keyed by exactly that id.
                if let Some(pending) = live.pending_rpc.remove(&request_id) {
                    if pending.responder_peer_id.as_deref() != Some(peer_id) {
                        warn!(
                            session_id,
                            request_id,
                            peer_id,
                            owner_peer_id =
                                pending.responder_peer_id.as_deref().unwrap_or("<parked>"),
                            "rejecting rpc result from non-owner daemon peer"
                        );
                        live.pending_rpc.insert(request_id.clone(), pending);
                    } else {
                        response = live.peers.get(&pending.requester_peer_id).map(|peer| {
                            (
                                strip_rpc_request_id_namespace(
                                    &pending.requester_peer_id,
                                    &request_id,
                                ),
                                pending.requester_peer_id.clone(),
                                peer.tx.clone(),
                            )
                        });
                    }
                } else {
                    warn!(
                        session_id,
                        request_id, "dropping rpc result for an expired or unknown request"
                    );
                }
            }
        }

        self.notify_expired_rpcs(session_id, expired);
        if let Some((request_id, requester_peer_id, tx)) = response {
            self.queue_message(
                session_id,
                &requester_peer_id,
                &tx,
                RelayServerMessage::RpcResult {
                    request_id,
                    ok,
                    result,
                    error,
                    failure: None,
                },
            );
        }
    }

    pub async fn submit_action(
        &self,
        session_id: &str,
        token: &str,
        request: SubmitQueuedActionRequest,
    ) -> Result<QueuedRemoteAction, RelayError> {
        let auth = self.authenticate_session(session_id, token).await?;
        if !matches!(auth.role, RelayPeerRole::Client) {
            return Err(RelayError::Unauthorized(
                "only client peers may submit queued actions".to_string(),
            ));
        }
        let device_id = auth
            .device_id
            .ok_or_else(|| RelayError::Unauthorized("missing trusted device".to_string()))?;
        let (action, record, update, session, superseded_presence_ids) = {
            let mut store = self.inner.store.lock().await;
            let record = {
                let session = store
                    .data
                    .sessions
                    .get_mut(session_id)
                    .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;

                if let Some(existing) = session
                    .actions
                    .values()
                    .find(|action| {
                        action.device_id == device_id
                            && action.idempotency_key == request.idempotency_key
                    })
                    .cloned()
                {
                    if existing.action_type != request.action_type
                        || existing.payload != request.payload
                    {
                        return Err(RelayError::Conflict(
                            "idempotency key already used for a different queued action"
                                .to_string(),
                        ));
                    }
                    existing
                } else {
                    let now = Utc::now();
                    let action = QueuedActionRecord {
                        action_id: format!("action-{}", Uuid::new_v4().simple()),
                        session_id: session_id.to_string(),
                        device_id: device_id.clone(),
                        action_type: request.action_type,
                        idempotency_key: request.idempotency_key,
                        payload: request.payload,
                        status: QueuedRemoteActionStatus::Queued,
                        created_at: now,
                        updated_at: now,
                        error: None,
                        result: None,
                        owner_peer_id: None,
                    };
                    session
                        .actions
                        .insert(action.action_id.clone(), action.clone());
                    session.updated_at = now;
                    action
                }
            };
            let action = record.to_public();
            // Append the Queued status while still holding the lock that
            // inserted the action, so its sequence number always precedes
            // any Dispatched status a concurrent dispatch pass appends.
            let (update, session, superseded_presence_ids) = self.append_update_locked(
                &mut store,
                session_id,
                RelayUpdateBody::ActionStatus {
                    action: action.clone(),
                },
            )?;
            (action, record, update, session, superseded_presence_ids)
        };

        self.persist_action_state(
            &session,
            std::slice::from_ref(&record),
            PersistMode::Immediate,
        )
        .await?;
        self.persist_appended_update(
            session_id,
            &session,
            &update,
            &superseded_presence_ids,
            PersistMode::Immediate,
        )
        .await?;
        self.dispatch_pending_actions(session_id).await;
        Ok(action)
    }

    pub async fn action_status(
        &self,
        session_id: &str,
        token: &str,
        action_id: &str,
    ) -> Result<QueuedRemoteAction, RelayError> {
        let _ = self.authenticate_session(session_id, token).await?;
        let store = self.inner.store.lock().await;
        let session = store
            .data
            .sessions
            .get(session_id)
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
        let action = session
            .actions
            .get(action_id)
            .ok_or_else(|| RelayError::NotFound("queued action not found".to_string()))?;
        Ok(action.to_public())
    }

    pub async fn trusted_devices(
        &self,
        session_id: &str,
        token: &str,
    ) -> Result<TrustedDevicesResponse, RelayError> {
        let _ = self.authenticate_session(session_id, token).await?;
        self.trusted_devices_response(session_id).await
    }

    /// Build the devices response with per-device liveness overlaid from the
    /// live peer map. Callers must have authenticated already.
    async fn trusted_devices_response(
        &self,
        session_id: &str,
    ) -> Result<TrustedDevicesResponse, RelayError> {
        let store = self.inner.store.lock().await;
        let session = store
            .data
            .sessions
            .get(session_id)
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
        let live = store.live_sessions.get(session_id);
        let connected_device_ids: std::collections::HashSet<&str> = live
            .map(|live| {
                live.peers
                    .values()
                    .filter(|peer| matches!(peer.role, RelayPeerRole::Client))
                    .filter_map(|peer| peer.device_id.as_deref())
                    .collect()
            })
            .unwrap_or_default();
        let mut devices = session.trusted_devices();
        for device in &mut devices {
            device.connected = connected_device_ids.contains(device.device_id.as_str());
        }
        Ok(TrustedDevicesResponse {
            session_id: session_id.to_string(),
            devices,
            presence: session.machine_presence(live),
        })
    }

    pub async fn revoke_trusted_device(
        &self,
        session_id: &str,
        token: &str,
        device_id: &str,
    ) -> Result<TrustedDevicesResponse, RelayError> {
        let auth = self.authenticate_session(session_id, token).await?;
        // A device may remove itself (unpairing on the phone), so its record
        // does not linger in the desktop's device list forever. Self-removal
        // purges in one call: revoking would invalidate the device's own
        // token and leave it unable to complete the revoke-then-purge pair.
        let is_self_revoke = matches!(auth.role, RelayPeerRole::Client)
            && auth.device_id.as_deref() == Some(device_id);
        if !matches!(auth.role, RelayPeerRole::Daemon) && !is_self_revoke {
            return Err(RelayError::Unauthorized(
                "only the daemon or the device itself may revoke a trusted device".to_string(),
            ));
        }
        let (revoked_peer_ids, session, device_snapshot) = {
            let mut store = self.inner.store.lock().await;
            let session_snapshot;
            let device_snapshot;
            {
                let session = store
                    .data
                    .sessions
                    .get_mut(session_id)
                    .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
                session.migrate_legacy_device_fields();
                let device = session
                    .devices
                    .get_mut(device_id)
                    .ok_or_else(|| RelayError::NotFound("trusted device not found".to_string()))?;
                if is_self_revoke || device.revoked_at.is_some() {
                    // Revoking an already-revoked device purges it entirely —
                    // this is how the UI's "Remove" clears dead entries. A
                    // self-revoke purges immediately (see above).
                    session.devices.remove(device_id);
                    device_snapshot = None;
                } else {
                    device.revoked_at = Some(Utc::now());
                    device_snapshot = Some(device.clone());
                }
                session.updated_at = Utc::now();
                session_snapshot = session.meta();
            }
            let revoked_peer_ids = store
                .live_sessions
                .get(session_id)
                .map(|live| {
                    live.peers
                        .iter()
                        .filter_map(|(peer_id, peer)| {
                            if matches!(peer.role, RelayPeerRole::Client)
                                && peer.device_id.as_deref() == Some(device_id)
                            {
                                Some(peer_id.clone())
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (revoked_peer_ids, session_snapshot, device_snapshot)
        };
        match device_snapshot.as_ref() {
            Some(device) => {
                self.persist_device_state(&session, Some(device), PersistMode::Immediate)
                    .await?;
            }
            None => {
                self.inner
                    .backend
                    .remove_device(session_id, device_id)
                    .await?;
                self.persist_device_state(&session, None, PersistMode::Immediate)
                    .await?;
            }
        }
        for peer_id in revoked_peer_ids {
            self.unregister_peer(session_id, &peer_id).await;
        }
        self.broadcast_presence(session_id).await;
        // Not `trusted_devices`: a self-revoked device's token was just
        // invalidated, so re-authenticating with it would fail the response.
        self.trusted_devices_response(session_id).await
    }

    /// Store (or clear) the Expo push token for a trusted device. Clients may
    /// only register their own device's token; the daemon may manage any.
    pub async fn register_push_token(
        &self,
        session_id: &str,
        token: &str,
        device_id: &str,
        push_token: Option<String>,
    ) -> Result<(), RelayError> {
        let auth = self.authenticate_session(session_id, token).await?;
        if matches!(auth.role, RelayPeerRole::Client)
            && auth.device_id.as_deref() != Some(device_id)
        {
            return Err(RelayError::Unauthorized(
                "clients may only register their own push token".to_string(),
            ));
        }
        let (session, device_snapshot) = {
            let mut store = self.inner.store.lock().await;
            let session = store
                .data
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
            session.migrate_legacy_device_fields();
            let device = session
                .devices
                .get_mut(device_id)
                .ok_or_else(|| RelayError::NotFound("trusted device not found".to_string()))?;
            if device.revoked_at.is_some() {
                return Err(RelayError::Unauthorized(
                    "trusted device is revoked".to_string(),
                ));
            }
            device.push_token = push_token
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let device_snapshot = device.clone();
            session.updated_at = Utc::now();
            (session.meta(), device_snapshot)
        };
        self.persist_device_state(&session, Some(&device_snapshot), PersistMode::Immediate)
            .await?;
        Ok(())
    }

    /// Send a generic attention push to every active trusted device that has
    /// a push token and is not currently connected. The push carries no
    /// conversation content — only routing identifiers.
    async fn dispatch_push_notifications(
        &self,
        session_id: &str,
        kind: String,
        workspace_id: Option<String>,
        thread_id: Option<String>,
    ) {
        let endpoint = self.inner.push_endpoint.clone();
        if endpoint.trim().is_empty() {
            return;
        }
        let recipients = {
            let mut store = self.inner.store.lock().await;
            let now = Utc::now();
            let dedupe_window = Duration::seconds(PUSH_DEDUPE_SECONDS);
            store
                .push_dedupe
                .retain(|_, last| *last + dedupe_window > now);
            let dedupe_key = push_dedupe_key(session_id, &kind, thread_id.as_deref());
            if store.push_dedupe.contains_key(&dedupe_key) {
                return;
            }
            let connected_devices = store
                .live_sessions
                .get(session_id)
                .map(|live| {
                    live.peers
                        .values()
                        .filter_map(|peer| peer.device_id.clone())
                        .collect::<std::collections::HashSet<_>>()
                })
                .unwrap_or_default();
            let Some(session) = store.data.sessions.get_mut(session_id) else {
                return;
            };
            session.migrate_legacy_device_fields();
            let recipients = session
                .devices
                .values()
                .filter(|device| device.revoked_at.is_none())
                .filter(|device| !connected_devices.contains(&device.device_id))
                .filter_map(|device| device.push_token.clone())
                .collect::<Vec<_>>();
            if recipients.is_empty() {
                return;
            }
            store.push_dedupe.insert(dedupe_key, now);
            recipients
        };

        let (title, body) = match kind.as_str() {
            "approval" => ("FalconDeck", "An agent is waiting for your approval"),
            "question" => ("FalconDeck", "An agent asked you a question"),
            "turn-complete" => ("FalconDeck", "An agent finished its turn"),
            "turn-error" => ("FalconDeck", "An agent turn failed"),
            _ => ("FalconDeck", "An agent needs your attention"),
        };
        for recipient_chunk in recipients.chunks(EXPO_MAX_MESSAGES_PER_REQUEST) {
            let chunk_recipients = recipient_chunk.to_vec();
            let messages = chunk_recipients
                .iter()
                .map(|token| {
                    serde_json::json!({
                        "to": token,
                        "title": title,
                        "body": body,
                        "sound": "default",
                        "priority": "high",
                        "channelId": "default",
                        "ttl": 86400,
                        "data": {
                            "sessionId": session_id,
                            "workspaceId": workspace_id,
                            "threadId": thread_id,
                            "kind": kind,
                        },
                    })
                })
                .collect::<Vec<_>>();
            let session_id = session_id.to_string();
            let state = self.clone();
            let client = self.inner.push_client.clone();
            let access_token = self.inner.push_access_token.clone();
            let endpoint = endpoint.clone();
            tokio::spawn(async move {
                for attempt in 0..PUSH_MAX_ATTEMPTS {
                    let mut request = client.post(&endpoint).json(&messages);
                    if let Some(access_token) = access_token.as_deref() {
                        request = request.bearer_auth(access_token);
                    }
                    match request.send().await {
                        Ok(response)
                            if response.status().as_u16() == 429
                                || response.status().is_server_error() =>
                        {
                            if attempt + 1 < PUSH_MAX_ATTEMPTS {
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    PUSH_RETRY_BASE_MS * 2u64.saturating_pow(attempt as u32),
                                ))
                                .await;
                                continue;
                            }
                            warn!(
                                session_id,
                                status = %response.status(),
                                "push notification delivery failed after retries"
                            );
                        }
                        Ok(response) if !response.status().is_success() => {
                            warn!(
                                session_id,
                                status = %response.status(),
                                "push notification delivery was rejected"
                            );
                        }
                        Ok(response) => {
                            state
                                .handle_push_tickets(&session_id, &chunk_recipients, response)
                                .await;
                        }
                        Err(_error) if attempt + 1 < PUSH_MAX_ATTEMPTS => {
                            tokio::time::sleep(std::time::Duration::from_millis(
                                PUSH_RETRY_BASE_MS * 2u64.saturating_pow(attempt as u32),
                            ))
                            .await;
                            continue;
                        }
                        Err(error) => {
                            warn!(session_id, %error, "failed to deliver push notification after retries");
                        }
                    }
                    break;
                }
            });
        }
    }

    /// Best-effort parse of the Expo push response: tickets come back in
    /// the same order as the submitted messages, so a `DeviceNotRegistered`
    /// ticket maps to the recipient token at the same index and that
    /// device's stored push token is cleared.
    async fn handle_push_tickets(
        &self,
        session_id: &str,
        recipients: &[String],
        response: reqwest::Response,
    ) {
        let tickets = match response.json::<ExpoPushResponse>().await {
            Ok(parsed) => parsed.data,
            Err(error) => {
                warn!(session_id, %error, "failed to parse push ticket response");
                return;
            }
        };
        let receipt_tickets = tickets
            .iter()
            .zip(recipients)
            .filter_map(|(ticket, token)| ticket.id.clone().map(|id| (id, token.clone())))
            .collect::<Vec<_>>();
        let dead_tokens = tickets
            .iter()
            .zip(recipients)
            .filter(|(ticket, _)| {
                ticket.status.as_deref() == Some("error")
                    && ticket
                        .details
                        .as_ref()
                        .and_then(|details| details.error.as_deref())
                        == Some("DeviceNotRegistered")
            })
            .map(|(_, token)| token.clone())
            .collect::<Vec<_>>();
        if !dead_tokens.is_empty() {
            warn!(
                session_id,
                count = dead_tokens.len(),
                "clearing push tokens for unregistered devices"
            );
            self.clear_dead_push_tokens(session_id, &dead_tokens).await;
        }
        if receipt_tickets.is_empty() {
            return;
        }

        let state = self.clone();
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            state.poll_push_receipts(&session_id, receipt_tickets).await;
        });
    }

    async fn poll_push_receipts(&self, session_id: &str, tickets: Vec<(String, String)>) {
        tokio::time::sleep(std::time::Duration::from_secs(PUSH_RECEIPT_DELAY_SECONDS)).await;

        let ids = tickets.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
        let mut request = self
            .inner
            .push_client
            .post(&self.inner.push_receipts_endpoint)
            .json(&serde_json::json!({ "ids": ids }));
        if let Some(access_token) = self.inner.push_access_token.as_deref() {
            request = request.bearer_auth(access_token);
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                warn!(session_id, %error, "failed to fetch push receipts");
                return;
            }
        };
        if !response.status().is_success() {
            warn!(
                session_id,
                status = %response.status(),
                "push receipt request was rejected"
            );
            return;
        }

        let receipts = match response.json::<ExpoReceiptResponse>().await {
            Ok(parsed) => parsed.data,
            Err(error) => {
                warn!(session_id, %error, "failed to parse push receipt response");
                return;
            }
        };
        let dead_tokens = tickets
            .iter()
            .filter_map(|(id, token)| {
                let receipt = receipts.get(id)?;
                (receipt.status.as_deref() == Some("error")
                    && receipt
                        .details
                        .as_ref()
                        .and_then(|details| details.error.as_deref())
                        == Some("DeviceNotRegistered"))
                .then_some(token.clone())
            })
            .collect::<Vec<_>>();
        if !dead_tokens.is_empty() {
            warn!(
                session_id,
                count = dead_tokens.len(),
                "clearing push tokens for devices rejected by push receipt"
            );
            self.clear_dead_push_tokens(session_id, &dead_tokens).await;
        }
    }

    async fn clear_dead_push_tokens(&self, session_id: &str, dead_tokens: &[String]) {
        let (session, cleared_devices) = {
            let mut store = self.inner.store.lock().await;
            let Some(session) = store.data.sessions.get_mut(session_id) else {
                return;
            };
            let mut cleared_devices = Vec::new();
            for device in session.devices.values_mut() {
                if device
                    .push_token
                    .as_ref()
                    .is_some_and(|token| dead_tokens.contains(token))
                {
                    device.push_token = None;
                    cleared_devices.push(device.clone());
                }
            }
            if cleared_devices.is_empty() {
                return;
            }
            session.updated_at = Utc::now();
            (session.meta(), cleared_devices)
        };
        for device in &cleared_devices {
            if let Err(error) = self
                .persist_device_state(&session, Some(device), PersistMode::Immediate)
                .await
            {
                warn!(session_id, device_id = %device.device_id, %error, "failed to persist cleared push token");
            }
        }
    }

    async fn update_action(
        &self,
        session_id: &str,
        peer_id: &str,
        action_id: &str,
        status: QueuedRemoteActionStatus,
        error: Option<String>,
        result: Option<EncryptedEnvelope>,
    ) -> Result<(), RelayError> {
        let (action, record, session) = {
            let mut store = self.inner.store.lock().await;
            let session = store
                .data
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
            let action = session
                .actions
                .get_mut(action_id)
                .ok_or_else(|| RelayError::NotFound("queued action not found".to_string()))?;
            if action.owner_peer_id.as_deref() != Some(peer_id) {
                warn!(
                    session_id,
                    action_id,
                    peer_id,
                    owner_peer_id = ?action.owner_peer_id,
                    "rejecting queued action update from non-owner daemon peer"
                );
                return Err(RelayError::Conflict(
                    "queued action is owned by a different daemon peer".to_string(),
                ));
            }
            action.status = status;
            action.error = error;
            action.result = result;
            if matches!(
                action.status,
                QueuedRemoteActionStatus::Completed | QueuedRemoteActionStatus::Failed
            ) {
                action.owner_peer_id = None;
            }
            action.updated_at = Utc::now();
            let record = action.clone();
            session.updated_at = record.updated_at;
            (record.to_public(), record, session.meta())
        };
        self.persist_action_state(
            &session,
            std::slice::from_ref(&record),
            PersistMode::Immediate,
        )
        .await?;
        self.append_update(
            session_id,
            RelayUpdateBody::ActionStatus { action },
            PersistMode::Immediate,
        )
        .await
    }

    async fn touch_presence(&self, session_id: &str, role: RelayPeerRole, device_id: Option<&str>) {
        let mut session_snapshot = None;
        let mut touched_device = None;
        let mut store = self.inner.store.lock().await;
        if let Some(session) = store.data.sessions.get_mut(session_id) {
            let now = Utc::now();
            session.migrate_legacy_device_fields();
            match role {
                RelayPeerRole::Daemon => session.daemon_last_seen_at = Some(now),
                RelayPeerRole::Client => {
                    if let Some(current_device_id) = device_id
                        && let Some(device) = session.devices.get_mut(current_device_id)
                    {
                        device.last_seen_at = Some(now);
                        touched_device = Some(device.clone());
                    }
                }
            }
            session.updated_at = now;
            session_snapshot = Some(session.meta());
        }
        drop(store);
        if let Some(session) = session_snapshot.as_ref() {
            let _ = self
                .persist_device_state(session, touched_device.as_ref(), PersistMode::Deferred)
                .await;
        }
    }

    async fn broadcast_presence(&self, session_id: &str) {
        let presence = {
            let store = self.inner.store.lock().await;
            let Some(session) = store.data.sessions.get(session_id) else {
                return;
            };
            session.machine_presence(store.live_sessions.get(session_id))
        };
        self.broadcast(
            session_id,
            RelayServerMessage::Presence {
                presence: presence.clone(),
            },
        )
        .await;
        let _ = self
            .append_update(
                session_id,
                RelayUpdateBody::Presence { presence },
                PersistMode::Deferred,
            )
            .await;
    }

    async fn dispatch_pending_actions(&self, session_id: &str) {
        let mut to_send = Vec::new();
        let mut dispatched_records = Vec::new();
        let mut dispatched_updates = Vec::new();
        let session_snapshot = {
            let mut store = self.inner.store.lock().await;
            let Some(live) = store.live_sessions.get(session_id) else {
                return;
            };
            let Some((target_peer_id, target)) = live
                .newest_daemon_peer()
                .map(|(peer_id, peer)| (peer_id.to_string(), peer.tx.clone()))
            else {
                return;
            };
            {
                let Some(session) = store.data.sessions.get_mut(session_id) else {
                    return;
                };
                for action in session.actions.values_mut() {
                    if to_send.len() >= MAX_ACTIONS_PER_DISPATCH {
                        break;
                    }
                    if !matches!(action.status, QueuedRemoteActionStatus::Queued) {
                        continue;
                    }
                    action.status = QueuedRemoteActionStatus::Dispatched;
                    action.updated_at = Utc::now();
                    action.error = None;
                    action.result = None;
                    action.owner_peer_id = Some(target_peer_id.clone());
                    dispatched_records.push(action.clone());
                    to_send.push((
                        target_peer_id.clone(),
                        target.clone(),
                        action.to_public(),
                        action.payload.clone(),
                    ));
                }
            }

            // Reserve and fan out every Dispatched sequence while still
            // holding the action-transition lock. The daemon cannot report a
            // later state until these rows precede it in the replay log.
            for (_, _, action, _) in &to_send {
                let Ok(appended) = self.append_update_locked(
                    &mut store,
                    session_id,
                    RelayUpdateBody::ActionStatus {
                        action: action.clone(),
                    },
                ) else {
                    return;
                };
                dispatched_updates.push(appended);
            }
            store.data.sessions.get(session_id).map(SessionRecord::meta)
        };

        if let Some(session) = session_snapshot.as_ref()
            && !dispatched_records.is_empty()
        {
            let _ = self
                .persist_action_state(session, &dispatched_records, PersistMode::Immediate)
                .await;
        }

        for (update, session, superseded_presence_ids) in dispatched_updates {
            let _ = self
                .persist_appended_update(
                    session_id,
                    &session,
                    &update,
                    &superseded_presence_ids,
                    PersistMode::Immediate,
                )
                .await;
        }

        for (peer_id, tx, action, payload) in to_send {
            self.queue_message(
                session_id,
                &peer_id,
                &tx,
                RelayServerMessage::ActionRequested {
                    action: action.clone(),
                    payload,
                },
            );
        }
    }

    fn session_updates_for_ws_locked(
        &self,
        store: &Store,
        session_id: &str,
        after_seq: u64,
    ) -> Result<RelayUpdatesResponse, RelayError> {
        let session = store
            .data
            .sessions
            .get(session_id)
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
        let history_truncated = session.history_truncated(after_seq);

        Ok(RelayUpdatesResponse {
            session_id: session_id.to_string(),
            updates: session
                .updates
                .iter()
                .filter(|update| update.seq > after_seq)
                .cloned()
                .collect(),
            next_seq: session.next_seq(),
            cursor: SyncCursor {
                session_id: session_id.to_string(),
                next_seq: session.next_seq(),
                last_acknowledged_seq: after_seq,
                requires_bootstrap: after_seq == 0,
                history_truncated,
            },
            presence: session.machine_presence(store.live_sessions.get(session_id)),
        })
    }

    async fn send_sync_to_peer(
        &self,
        session_id: &str,
        peer_id: &str,
        after_seq: u64,
    ) -> Result<(), RelayError> {
        // Keep history selection and queue insertion under the same lock as
        // append_update_locked's live fanout. This closes the only window in
        // which a newer live update could jump ahead of replay chunks.
        let store = self.inner.store.lock().await;
        let response = self.session_updates_for_ws_locked(&store, session_id, after_seq)?;
        let Some(tx) = store
            .live_sessions
            .get(session_id)
            .and_then(|live| live.peers.get(peer_id))
            .map(|peer| peer.tx.clone())
        else {
            return Ok(());
        };
        for message in sync_messages(response) {
            self.queue_message(session_id, peer_id, &tx, message);
        }
        Ok(())
    }

    async fn send_to_peer(&self, session_id: &str, peer_id: &str, message: RelayServerMessage) {
        self.send_messages_to_peer(session_id, peer_id, vec![message])
            .await;
    }

    /// Enqueue a group of messages while holding the peer-map lock. This is
    /// used by ordinary control fanout; replay has the stronger history
    /// selection + enqueue fence in `send_sync_to_peer`.
    async fn send_messages_to_peer(
        &self,
        session_id: &str,
        peer_id: &str,
        messages: Vec<RelayServerMessage>,
    ) {
        let store = self.inner.store.lock().await;
        let Some(tx) = store
            .live_sessions
            .get(session_id)
            .and_then(|live| live.peers.get(peer_id))
            .map(|peer| peer.tx.clone())
        else {
            return;
        };

        for message in messages {
            self.queue_message(session_id, peer_id, &tx, message);
        }
    }

    async fn broadcast(&self, session_id: &str, message: RelayServerMessage) {
        self.broadcast_except(session_id, None, message).await;
    }

    async fn broadcast_except(
        &self,
        session_id: &str,
        exclude_peer_id: Option<&str>,
        message: RelayServerMessage,
    ) {
        let recipients = {
            let store = self.inner.store.lock().await;
            store
                .live_sessions
                .get(session_id)
                .map(|live| {
                    live.peers
                        .iter()
                        .filter(|(peer_id, _)| exclude_peer_id != Some(peer_id.as_str()))
                        .map(|(peer_id, peer)| (peer_id.clone(), peer.tx.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };

        for (peer_id, tx) in recipients {
            self.queue_message(session_id, &peer_id, &tx, message.clone());
        }
    }

    fn queue_message(
        &self,
        session_id: &str,
        peer_id: &str,
        tx: &mpsc::Sender<RelayServerMessage>,
        message: RelayServerMessage,
    ) {
        match tx.try_send(message) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                warn!(
                    session_id,
                    peer_id, "disconnecting slow relay peer after outbound queue overflow"
                );
                let state = self.clone();
                let session_id = session_id.to_string();
                let peer_id = peer_id.to_string();
                tokio::spawn(async move {
                    state.unregister_peer(&session_id, &peer_id).await;
                });
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                let state = self.clone();
                let session_id = session_id.to_string();
                let peer_id = peer_id.to_string();
                tokio::spawn(async move {
                    state.unregister_peer(&session_id, &peer_id).await;
                });
            }
        }
    }

    async fn persist_pairing_state(
        &self,
        session: Option<&SessionMeta>,
        pairing: Option<&PairingRecord>,
        mode: PersistMode,
    ) -> Result<(), RelayError> {
        self.inner.backend.persist_pairing(session, pairing).await?;
        self.schedule_flush(mode).await
    }

    async fn persist_device_state(
        &self,
        session: &SessionMeta,
        device: Option<&TrustedDeviceRecord>,
        mode: PersistMode,
    ) -> Result<(), RelayError> {
        self.inner.backend.persist_device(session, device).await?;
        self.schedule_flush(mode).await
    }

    async fn persist_action_state(
        &self,
        session: &SessionMeta,
        actions: &[QueuedActionRecord],
        mode: PersistMode,
    ) -> Result<(), RelayError> {
        self.inner.backend.persist_action(session, actions).await?;
        self.schedule_flush(mode).await
    }

    async fn persist_update_state(
        &self,
        session: &SessionMeta,
        update: &RelayUpdate,
        mode: PersistMode,
    ) -> Result<(), RelayError> {
        self.inner.backend.persist_update(session, update).await?;
        self.schedule_flush(mode).await
    }

    async fn schedule_flush(&self, mode: PersistMode) -> Result<(), RelayError> {
        if !self.inner.needs_flush {
            return Ok(());
        }
        match mode {
            PersistMode::Immediate => self.persist_current().await,
            PersistMode::Deferred => {
                let backend = Arc::clone(&self.inner.backend);
                let store = self.inner.store.clone();
                if let Some(file_backend) = backend
                    .as_any()
                    .downcast_ref::<crate::persistence::FileBackend>()
                {
                    file_backend
                        .schedule_deferred_flush(move || {
                            Box::pin(async move {
                                let snapshot = store.lock().await.data.clone();
                                Ok(snapshot)
                            })
                        })
                        .await;
                }
                Ok(())
            }
        }
    }

    async fn persist_current(&self) -> Result<(), RelayError> {
        let snapshot = {
            let store = self.inner.store.lock().await;
            store.data.clone()
        };
        self.inner.backend.flush_all(&snapshot).await
    }

    async fn prune_expired_state(&self) -> Result<PruneReport, RelayError> {
        let report = {
            let mut store = self.inner.store.lock().await;
            let now = Utc::now();
            // Sweep the short-lived in-memory maps alongside retained
            // state so idle relays do not accumulate expired entries.
            store
                .pairing_challenges
                .retain(|_, challenge| challenge.expires_at > now);
            store.ws_tickets.retain(|_, entry| entry.expires_at > now);
            let dedupe_window = Duration::seconds(PUSH_DEDUPE_SECONDS);
            store
                .push_dedupe
                .retain(|_, last| *last + dedupe_window > now);
            let live_session_ids = store.live_sessions.keys().cloned().collect();
            prune_state(
                &mut store.data,
                &live_session_ids,
                &self.inner.retention,
                now,
            )
        };
        Ok(report)
    }

    /// Run a retention prune pass immediately. Production pruning runs on
    /// the background interval task; this exists so tests (and operational
    /// tooling) can force a deterministic pass.
    pub async fn force_prune(&self) -> Result<(), RelayError> {
        self.prune_retained_state().await.map(|_| ())
    }

    async fn prune_retained_state(&self) -> Result<bool, RelayError> {
        let report = self.prune_expired_state().await?;
        if report.is_empty() {
            return Ok(false);
        }
        if self.inner.needs_flush {
            // The file backend always snapshots the whole state.
            self.persist_current().await?;
        } else {
            self.apply_prune_report(&report).await?;
        }
        Ok(true)
    }

    /// Everything `prune_state` removes is covered by a targeted delete:
    /// removed sessions cascade to their dependent rows, and per-session
    /// update pruning always drops a prefix of the sequence range.
    async fn apply_prune_report(&self, report: &PruneReport) -> Result<(), RelayError> {
        let backend = &self.inner.backend;
        backend.remove_sessions(&report.removed_session_ids).await?;
        backend.remove_pairings(&report.removed_pairing_ids).await?;
        backend.remove_actions(&report.removed_action_ids).await?;
        for (session_id, device_id) in &report.removed_devices {
            backend.remove_device(session_id, device_id).await?;
        }
        for (session, oldest_retained_seq) in &report.pruned_update_sessions {
            backend
                .prune_updates(&session.session_id, *oldest_retained_seq)
                .await?;
            // Upsert the session row too so the advanced oldest_lost_seq
            // survives a restart even when no later update touches it.
            backend.persist_pairing(Some(session), None).await?;
        }
        Ok(())
    }

    /// Sweep retained state periodically in the background so request
    /// handlers no longer pay for a full-store prune pass.
    fn spawn_prune_task(&self) {
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(PRUNE_INTERVAL_SECONDS));
            // A stalled runtime must not replay every missed tick as an
            // immediate burst of prune passes.
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            interval.tick().await; // consume the immediate first tick
            loop {
                interval.tick().await;
                let Some(inner) = inner.upgrade() else {
                    break;
                };
                let state = AppState { inner };
                if let Err(error) = state.prune_retained_state().await {
                    warn!(%error, "failed to prune retained relay state");
                }
            }
        });
    }
}

impl PairingRecord {
    fn status(&self) -> PairingStatus {
        if self.device_id.is_some() {
            PairingStatus::Claimed
        } else if self.expires_at <= Utc::now() {
            PairingStatus::Expired
        } else {
            PairingStatus::Pending
        }
    }
}

impl SessionRecord {
    fn meta(&self) -> SessionMeta {
        SessionMeta {
            session_id: self.session_id.clone(),
            pairing_id: self.pairing_id.clone(),
            daemon_token: self.daemon_token.clone(),
            daemon_last_seen_at: self.daemon_last_seen_at,
            created_at: self.created_at,
            updated_at: self.updated_at,
            next_seq: self.next_seq,
            oldest_lost_seq: self.oldest_lost_seq,
        }
    }

    fn ensure_next_seq(&mut self) {
        let derived = self
            .updates
            .last()
            .map(|update| update.seq.saturating_add(1))
            .unwrap_or(1);
        if self.next_seq < derived {
            self.next_seq = derived;
        }
        if self.next_seq == 0 {
            self.next_seq = 1;
        }
    }

    fn migrate_legacy_device_fields(&mut self) {
        if !self.devices.is_empty() {
            self.clear_legacy_device_fields();
            return;
        }
        if let (Some(device_id), Some(client_token)) =
            (self.device_id.clone(), self.client_token.clone())
        {
            self.devices.insert(
                device_id.clone(),
                TrustedDeviceRecord {
                    device_id,
                    client_token,
                    label: self.client_label.clone(),
                    public_key: self.client_public_key.clone(),
                    identity_public_key: None,
                    created_at: self.device_created_at.unwrap_or(self.created_at),
                    last_seen_at: self.client_last_seen_at,
                    revoked_at: self.revoked_at,
                    push_token: None,
                },
            );
        }
        self.clear_legacy_device_fields();
    }

    fn clear_legacy_device_fields(&mut self) {
        self.device_id = None;
        self.device_created_at = None;
        self.client_token = None;
        self.client_label = None;
        self.client_public_key = None;
        self.client_last_seen_at = None;
        self.revoked_at = None;
    }

    fn next_seq(&self) -> u64 {
        self.next_seq.max(1)
    }

    fn oldest_retained_seq(&self) -> u64 {
        self.updates
            .first()
            .map(|update| update.seq)
            .unwrap_or_else(|| self.next_seq())
    }

    fn history_truncated(&self, after_seq: u64) -> bool {
        // A brand-new client (after_seq == 0) must also learn that early
        // history is gone so it recovers from a fresh daemon snapshot.
        // Only retention pruning advances `oldest_lost_seq`: superseded
        // presence rows leave gaps in the retained sequence range without
        // losing anything a client needs to replay.
        after_seq.saturating_add(1) < self.oldest_lost_seq
    }

    fn trusted_devices(&self) -> Vec<TrustedDevice> {
        // Liveness is a property of the live peer map, not the durable
        // record; callers with access to `live_sessions` overlay `connected`
        // via `AppState::trusted_devices`.
        let mut devices = self
            .devices
            .values()
            .map(|device| TrustedDevice {
                device_id: device.device_id.clone(),
                session_id: self.session_id.clone(),
                label: device.label.clone(),
                status: if device.revoked_at.is_some() {
                    TrustedDeviceStatus::Revoked
                } else {
                    TrustedDeviceStatus::Active
                },
                connected: false,
                created_at: device.created_at,
                last_seen_at: device.last_seen_at,
                revoked_at: device.revoked_at,
            })
            .collect::<Vec<_>>();
        devices.sort_by_key(|device| device.created_at);
        devices
    }

    fn machine_presence(&self, live: Option<&LiveSession>) -> MachinePresence {
        MachinePresence {
            session_id: self.session_id.clone(),
            daemon_connected: live.is_some_and(LiveSession::daemon_connected),
            daemon_rpc_ready: live.is_some_and(LiveSession::daemon_rpc_ready),
            last_seen_at: self.daemon_last_seen_at,
        }
    }
}

impl QueuedActionRecord {
    fn to_public(&self) -> QueuedRemoteAction {
        QueuedRemoteAction {
            action_id: self.action_id.clone(),
            session_id: self.session_id.clone(),
            device_id: self.device_id.clone(),
            action_type: self.action_type.clone(),
            idempotency_key: self.idempotency_key.clone(),
            status: self.status.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            error: self.error.clone(),
            result: self.result.clone(),
        }
    }
}

/// Subset of the Expo push API response: one ticket per submitted message,
/// in submission order.
#[derive(Debug, Deserialize)]
struct ExpoPushResponse {
    #[serde(default)]
    data: Vec<ExpoPushTicket>,
}

#[derive(Debug, Deserialize)]
struct ExpoPushTicket {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    details: Option<ExpoPushTicketDetails>,
}

#[derive(Debug, Deserialize)]
struct ExpoReceiptResponse {
    #[serde(default)]
    data: HashMap<String, ExpoPushTicket>,
}

#[derive(Debug, Deserialize)]
struct ExpoPushTicketDetails {
    #[serde(default)]
    error: Option<String>,
}

/// Namespace a client-chosen rpc request id with the requesting peer's
/// relay-generated id so identical ids from different peers cannot collide
/// in `pending_rpc` or misroute a late daemon result to the wrong device.
/// Peer ids are relay-generated (`peer-<uuid>`) and never contain `:`, so
/// the prefix is unambiguous.
fn namespaced_rpc_request_id(requester_peer_id: &str, request_id: &str) -> String {
    format!("{requester_peer_id}:{request_id}")
}

/// Strip the requester-peer prefix before delivering a result back, so the
/// client sees the request id it chose.
fn strip_rpc_request_id_namespace(requester_peer_id: &str, namespaced: &str) -> String {
    namespaced
        .strip_prefix(requester_peer_id)
        .and_then(|rest| rest.strip_prefix(':'))
        .unwrap_or(namespaced)
        .to_string()
}

/// Push dedupe key: pushes collapse per (session, kind, thread) so an
/// approval push is never swallowed by an earlier push of a different kind
/// on the same thread.
fn push_dedupe_key(
    session_id: &str,
    kind: &str,
    thread_id: Option<&str>,
) -> (String, String, String) {
    (
        session_id.to_string(),
        kind.to_string(),
        thread_id.unwrap_or_default().to_string(),
    )
}

fn saturating_add(instant: DateTime<Utc>, duration: Duration) -> DateTime<Utc> {
    instant
        .checked_add_signed(duration)
        .unwrap_or(DateTime::<Utc>::MAX_UTC)
}

fn saturating_sub(instant: DateTime<Utc>, duration: Duration) -> DateTime<Utc> {
    instant
        .checked_sub_signed(duration)
        .unwrap_or(DateTime::<Utc>::MIN_UTC)
}

/// What a prune pass removed, so the Postgres backend can delete only the
/// affected rows instead of rewriting all five tables.
#[derive(Debug, Default)]
struct PruneReport {
    /// Sessions whose oldest retained update advanced, with the new oldest
    /// retained sequence (update pruning always removes a prefix of the
    /// sequence range). The session meta snapshot lets the backend persist
    /// the advanced `oldest_lost_seq` alongside the row deletions.
    pruned_update_sessions: Vec<(SessionMeta, u64)>,
    removed_action_ids: Vec<String>,
    removed_session_ids: Vec<String>,
    removed_pairing_ids: Vec<String>,
    /// Individual stale device rows removed from sessions that are otherwise
    /// retained, as `(session_id, device_id)` pairs.
    removed_devices: Vec<(String, String)>,
}

impl PruneReport {
    fn is_empty(&self) -> bool {
        self.pruned_update_sessions.is_empty()
            && self.removed_action_ids.is_empty()
            && self.removed_session_ids.is_empty()
            && self.removed_pairing_ids.is_empty()
            && self.removed_devices.is_empty()
    }
}

fn prune_state(
    state: &mut PersistedState,
    live_session_ids: &std::collections::HashSet<String>,
    retention: &RetentionConfig,
    now: DateTime<Utc>,
) -> PruneReport {
    let mut report = PruneReport::default();

    for session in state.sessions.values_mut() {
        session.ensure_next_seq();

        let update_cutoff = saturating_sub(now, retention.update_retention);
        // Cut a true sequence prefix rather than filtering by age alone: a
        // backwards clock step can leave a newer-seq row with an older
        // timestamp, and an age-only filter would then strand a Postgres
        // row that memory dropped (the targeted delete is `seq < bound`).
        let age_cutoff_seq = session
            .updates
            .iter()
            .filter(|update| update.created_at < update_cutoff)
            .map(|update| update.seq)
            .max();
        let age_drop_count = age_cutoff_seq
            .map(|cutoff_seq| {
                session
                    .updates
                    .partition_point(|update| update.seq <= cutoff_seq)
            })
            .unwrap_or(0);
        let count_drop_count = session
            .updates
            .len()
            .saturating_sub(retention.max_updates_per_session);
        // Count limits do not protect memory when an encrypted snapshot is
        // several megabytes. Walk newest-to-oldest and retain a contiguous
        // suffix within the byte budget. Always keep the newest update so a
        // single oversized checkpoint can still seed reconnect recovery.
        let mut retained_bytes = 0usize;
        let mut byte_keep_from = session.updates.len();
        for (index, update) in session.updates.iter().enumerate().rev() {
            let update_bytes = estimated_update_retained_bytes(update);
            if index + 1 == session.updates.len()
                || retained_bytes.saturating_add(update_bytes)
                    <= retention.max_update_bytes_per_session
            {
                retained_bytes = retained_bytes.saturating_add(update_bytes);
                byte_keep_from = index;
            } else {
                break;
            }
        }
        let drop_count = age_drop_count.max(count_drop_count).max(byte_keep_from);
        if drop_count > 0 {
            let highest_pruned_seq = session.updates[drop_count - 1].seq;
            session.updates.drain(0..drop_count);
            // Only genuine retention pruning advances `oldest_lost_seq`;
            // superseded presence removals never count as lost history.
            session.oldest_lost_seq = session
                .oldest_lost_seq
                .max(highest_pruned_seq.saturating_add(1));
            report
                .pruned_update_sessions
                .push((session.meta(), session.oldest_retained_seq()));
        }

        let action_cutoff = saturating_sub(now, retention.completed_action_retention);
        session.actions.retain(|action_id, action| {
            let terminal = matches!(
                action.status,
                QueuedRemoteActionStatus::Completed | QueuedRemoteActionStatus::Failed
            );
            let keep = !terminal || action.updated_at >= action_cutoff;
            if !keep {
                report.removed_action_ids.push(action_id.clone());
            }
            keep
        });

        // Device rows inside a retained session were previously immortal:
        // every re-pair from a lost phone left a row behind forever. Drop
        // revoked rows once their grace window passes, and active rows that
        // nothing has connected with for the trusted-device retention period.
        let session_id = session.session_id.clone();
        let revoked_device_cutoff = saturating_sub(now, retention.completed_action_retention);
        let stale_device_cutoff = saturating_sub(now, retention.trusted_device_retention);
        session.devices.retain(|device_id, device| {
            let keep = match device.revoked_at {
                Some(revoked_at) => revoked_at >= revoked_device_cutoff,
                None => device.last_seen_at.unwrap_or(device.created_at) >= stale_device_cutoff,
            };
            if !keep {
                report
                    .removed_devices
                    .push((session_id.clone(), device_id.clone()));
            }
            keep
        });
    }

    let claimed_pairing_cutoff = saturating_sub(now, retention.claimed_pairing_retention);
    state.pairings.retain(|pairing_id, pairing| {
        let keep = if pairing.device_id.is_none() {
            pairing.expires_at > now
        } else {
            pairing.created_at >= claimed_pairing_cutoff
        };
        if !keep {
            report.removed_pairing_ids.push(pairing_id.clone());
        }
        keep
    });

    state.sessions.retain(|session_id, session| {
        if live_session_ids.contains(session_id) {
            return true;
        }

        // A corrupt state file (or extreme retention config) can push these
        // additions out of chrono's range; saturate instead of panicking.
        let trusted_until = session
            .devices
            .values()
            .filter(|device| device.revoked_at.is_none())
            .map(|device| device.last_seen_at.unwrap_or(device.created_at))
            .max()
            .map(|last_seen| saturating_add(last_seen, retention.trusted_device_retention));
        let daemon_until = session
            .daemon_last_seen_at
            .map(|seen| saturating_add(seen, retention.update_retention));
        let session_until = saturating_add(session.updated_at, retention.update_retention);
        let retain_until = trusted_until
            .into_iter()
            .chain(daemon_until)
            .chain(std::iter::once(session_until))
            .max()
            .unwrap_or(session.updated_at);
        let keep = retain_until > now;
        if !keep {
            report.removed_session_ids.push(session_id.clone());
        }
        keep
    });

    let valid_sessions = state
        .sessions
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    state.pairings.retain(|pairing_id, pairing| {
        let keep = valid_sessions.contains(&pairing.session_id);
        if !keep {
            report.removed_pairing_ids.push(pairing_id.clone());
        }
        keep
    });

    report
}

/// Cheap, conservative retained-memory estimate. Encrypted ciphertext makes
/// up almost all production replay volume; the fixed allowance covers the
/// enum, strings, ids, timestamps, and collection allocation overhead without
/// serializing every retained update again during the minute-level sweep.
fn estimated_update_retained_bytes(update: &RelayUpdate) -> usize {
    const ENTRY_OVERHEAD_BYTES: usize = 512;

    let payload_bytes = match &update.body {
        RelayUpdateBody::Encrypted { envelope } => envelope.ciphertext.len(),
        RelayUpdateBody::SessionBootstrap { material } => {
            material.pairing_id.len()
                + material.session_id.len()
                + material.daemon_public_key.len()
                + material.daemon_identity_public_key.len()
                + material.client_public_key.len()
                + material.client_identity_public_key.len()
                + material.client_wrapped_data_key.wrapped_key.len()
                + material
                    .daemon_wrapped_data_key
                    .as_ref()
                    .map_or(0, |key| key.wrapped_key.len())
                + material.signature.len()
        }
        RelayUpdateBody::ActionStatus { action } => {
            action.action_id.len()
                + action.session_id.len()
                + action.device_id.len()
                + action.action_type.len()
                + action.idempotency_key.len()
                + action.error.as_ref().map_or(0, String::len)
                + action
                    .result
                    .as_ref()
                    .map_or(0, |result| result.ciphertext.len())
        }
        RelayUpdateBody::Presence { presence } => presence.session_id.len(),
    };

    update
        .id
        .len()
        .saturating_add(payload_bytes)
        .saturating_add(ENTRY_OVERHEAD_BYTES)
}

/// Compare two secrets without exiting on the first differing byte, so
/// response timing cannot be used to guess a token prefix. The length
/// check may short-circuit: token lengths are not secret here.
pub(crate) fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0u8, |folded, (left, right)| folded | (left ^ right))
        == 0
}

// Persistence functions moved to crate::persistence module.

fn normalize_in_flight_actions(state: &mut PersistedState) -> bool {
    let now = Utc::now();
    let mut changed = false;
    for session in state.sessions.values_mut() {
        let mut session_changed = false;
        for action in session.actions.values_mut() {
            if matches!(
                action.status,
                QueuedRemoteActionStatus::Dispatched | QueuedRemoteActionStatus::Executing
            ) {
                action.status = QueuedRemoteActionStatus::Queued;
                action.updated_at = now;
                action.error = None;
                action.result = None;
                action.owner_peer_id = None;
                changed = true;
                session_changed = true;
            } else if action.owner_peer_id.is_some() {
                action.owner_peer_id = None;
                changed = true;
                session_changed = true;
            }
        }
        if session_changed {
            session.updated_at = now;
        }
    }
    changed
}

fn generate_pairing_code(state: &PersistedState) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for _ in 0..16 {
        let bytes = *Uuid::new_v4().as_bytes();
        let candidate = bytes
            .iter()
            .take(12)
            .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
            .collect::<String>();
        if state
            .pairings
            .values()
            .all(|pairing| pairing.pairing_code != candidate)
        {
            return candidate;
        }
    }

    warn!("pairing code generation retried more than expected");
    let bytes = *Uuid::new_v4().as_bytes();
    bytes
        .iter()
        .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
        .take(16)
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use falcondeck_core::{
        EncryptedEnvelope, EncryptionVariant, MachinePresence, RelayUpdate, RelayUpdateBody,
        RelayUpdatesResponse, SyncCursor,
    };

    use super::{
        LiveSession, PeerHandle, REQUIRED_SYNC_RPC_METHOD, REQUIRED_THREAD_DETAIL_RPC_METHOD,
        chunk_replay_updates, namespaced_rpc_request_id, push_dedupe_key,
        strip_rpc_request_id_namespace, sync_messages,
    };

    fn test_update(seq: u64) -> RelayUpdate {
        RelayUpdate {
            id: format!("update-{seq}"),
            seq,
            body: RelayUpdateBody::Encrypted {
                envelope: EncryptedEnvelope {
                    encryption_variant: EncryptionVariant::DataKeyV1,
                    ciphertext: "ciphertext".to_string(),
                },
            },
            created_at: Utc::now(),
        }
    }

    #[test]
    fn replay_chunks_bound_update_count_and_preserve_order() {
        let updates = (1..=129).map(test_update).collect::<Vec<_>>();
        let chunks = chunk_replay_updates(updates);

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 128);
        assert_eq!(chunks[1].len(), 1);
        assert_eq!(chunks[0].first().map(|update| update.seq), Some(1));
        assert_eq!(chunks[1].first().map(|update| update.seq), Some(129));
    }

    #[test]
    fn truncated_replay_sends_only_the_recovery_cursor() {
        let response = RelayUpdatesResponse {
            session_id: "session-1".to_string(),
            updates: (1..=129).map(test_update).collect(),
            next_seq: 130,
            cursor: SyncCursor {
                session_id: "session-1".to_string(),
                next_seq: 130,
                last_acknowledged_seq: 0,
                requires_bootstrap: true,
                history_truncated: true,
            },
            presence: MachinePresence {
                session_id: "session-1".to_string(),
                daemon_connected: false,
                daemon_rpc_ready: false,
                last_seen_at: None,
            },
        };

        let messages = sync_messages(response);
        assert_eq!(messages.len(), 1);
        assert!(matches!(
            &messages[0],
            falcondeck_core::RelayServerMessage::Sync {
                updates,
                next_seq: 130,
                history_truncated: true,
                ..
            } if updates.is_empty()
        ));
    }

    #[test]
    fn oversized_replay_uses_snapshot_recovery_instead_of_flooding_clients() {
        let response = RelayUpdatesResponse {
            session_id: "session-1".to_string(),
            updates: (1..=1_025).map(test_update).collect(),
            next_seq: 1_026,
            cursor: SyncCursor {
                session_id: "session-1".to_string(),
                next_seq: 1_026,
                last_acknowledged_seq: 0,
                requires_bootstrap: true,
                history_truncated: false,
            },
            presence: MachinePresence {
                session_id: "session-1".to_string(),
                daemon_connected: true,
                daemon_rpc_ready: true,
                last_seen_at: None,
            },
        };

        let messages = sync_messages(response);
        assert_eq!(messages.len(), 1);
        assert!(matches!(
            &messages[0],
            falcondeck_core::RelayServerMessage::Sync {
                updates,
                next_seq: 1_026,
                history_truncated: true,
                ..
            } if updates.is_empty()
        ));
    }

    #[test]
    fn push_dedupe_key_separates_kinds_on_the_same_thread() {
        assert_ne!(
            push_dedupe_key("session-1", "turn-complete", Some("thread-1")),
            push_dedupe_key("session-1", "approval", Some("thread-1")),
        );
    }

    #[test]
    fn push_dedupe_key_separates_threads_of_the_same_kind() {
        assert_ne!(
            push_dedupe_key("session-1", "approval", Some("thread-1")),
            push_dedupe_key("session-1", "approval", Some("thread-2")),
        );
    }

    #[test]
    fn push_dedupe_key_matches_repeated_events() {
        assert_eq!(
            push_dedupe_key("session-1", "approval", Some("thread-1")),
            push_dedupe_key("session-1", "approval", Some("thread-1")),
        );
        assert_eq!(
            push_dedupe_key("session-1", "turn-complete", None),
            push_dedupe_key("session-1", "turn-complete", None),
        );
    }

    #[test]
    fn rpc_request_id_namespace_round_trips() {
        let namespaced = namespaced_rpc_request_id("peer-abc", "mobile-detail-0");
        assert_eq!(namespaced, "peer-abc:mobile-detail-0");
        assert_eq!(
            strip_rpc_request_id_namespace("peer-abc", &namespaced),
            "mobile-detail-0"
        );
    }

    #[test]
    fn rpc_request_id_namespace_keeps_client_colons_intact() {
        let namespaced = namespaced_rpc_request_id("peer-abc", "scoped:id:1");
        assert_eq!(
            strip_rpc_request_id_namespace("peer-abc", &namespaced),
            "scoped:id:1"
        );
    }

    #[test]
    fn daemon_presence_is_not_sync_ready_until_snapshot_and_thread_detail_are_owned() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut live = LiveSession::default();
        live.peers.insert(
            "daemon-1".to_string(),
            PeerHandle {
                role: falcondeck_core::RelayPeerRole::Daemon,
                device_id: None,
                tx,
            },
        );

        assert!(live.daemon_connected());
        assert!(!live.daemon_rpc_ready());

        live.rpc_methods.insert(
            REQUIRED_SYNC_RPC_METHOD.to_string(),
            vec!["daemon-1".to_string()],
        );
        assert!(!live.daemon_rpc_ready());
        live.rpc_methods.insert(
            REQUIRED_THREAD_DETAIL_RPC_METHOD.to_string(),
            vec!["daemon-1".to_string()],
        );
        assert!(live.daemon_rpc_ready());
    }

    #[test]
    fn rpc_routing_prefers_the_newest_live_daemon_owner() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut live = LiveSession::default();
        for peer_id in ["daemon-1", "daemon-2"] {
            live.peers.insert(
                peer_id.to_string(),
                PeerHandle {
                    role: falcondeck_core::RelayPeerRole::Daemon,
                    device_id: None,
                    tx: tx.clone(),
                },
            );
        }
        live.rpc_methods.insert(
            REQUIRED_SYNC_RPC_METHOD.to_string(),
            vec!["daemon-1".to_string(), "daemon-2".to_string()],
        );

        let owner = live
            .rpc_owner(REQUIRED_SYNC_RPC_METHOD)
            .map(|(peer_id, _)| peer_id);

        assert_eq!(owner, Some("daemon-2"));
    }

    #[test]
    fn action_routing_prefers_the_newest_live_daemon_peer() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut live = LiveSession::default();
        for peer_id in ["daemon-1", "daemon-2"] {
            live.peers.insert(
                peer_id.to_string(),
                PeerHandle {
                    role: falcondeck_core::RelayPeerRole::Daemon,
                    device_id: None,
                    tx: tx.clone(),
                },
            );
            live.daemon_peer_ids.push(peer_id.to_string());
        }

        let owner = live.newest_daemon_peer().map(|(peer_id, _)| peer_id);

        assert_eq!(owner, Some("daemon-2"));
    }
}
