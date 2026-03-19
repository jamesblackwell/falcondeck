use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use chrono::{DateTime, Duration, Utc};
use falcondeck_core::{
    ClaimPairingRequest, ClaimPairingResponse, EncryptedEnvelope, MachinePresence,
    PairingPublicKeyBundle, PairingStatus, PairingStatusResponse, QueuedRemoteAction,
    QueuedRemoteActionStatus, RelayClientMessage, RelayHealthResponse, RelayPeerRole,
    RelayServerMessage, RelayUpdate, RelayUpdateBody, RelayUpdatesResponse, StartPairingRequest,
    StartPairingResponse, SubmitQueuedActionRequest, SyncCursor, TrustedDevice,
    TrustedDeviceStatus, TrustedDevicesResponse, crypto::verify_pairing_public_key_bundle,
};
use serde::{Deserialize, Serialize};
use tokio::{
    fs,
    sync::{Mutex, mpsc},
    task::JoinHandle,
};
use tokio_postgres::{Client as PostgresClient, NoTls};
use tracing::warn;
use uuid::Uuid;

use crate::error::RelayError;

const PEER_QUEUE_CAPACITY: usize = 256;
const FILE_PERSIST_DEBOUNCE_MS: u64 = 150;
const WS_TICKET_TTL_SECONDS: i64 = 30;

#[derive(Debug, Clone)]
pub struct RetentionConfig {
    pub update_retention: Duration,
    pub max_updates_per_session: usize,
    pub trusted_device_retention: Duration,
    pub claimed_pairing_retention: Duration,
    pub completed_action_retention: Duration,
}

impl Default for RetentionConfig {
    fn default() -> Self {
        Self {
            update_retention: Duration::days(7),
            max_updates_per_session: 10_000,
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
    state_path: PathBuf,
    default_pairing_ttl: Duration,
    retention: RetentionConfig,
    store: Mutex<Store>,
    persist_lock: Mutex<()>,
    postgres: Option<PostgresPersistence>,
    file_persist_task: Mutex<Option<JoinHandle<()>>>,
}

struct PostgresPersistence {
    client: Mutex<PostgresClient>,
}

struct Store {
    data: PersistedState,
    live_sessions: HashMap<String, LiveSession>,
    ws_tickets: HashMap<String, WebSocketTicket>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PersistedState {
    #[serde(default)]
    pairings: HashMap<String, PairingRecord>,
    #[serde(default)]
    sessions: HashMap<String, SessionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PairingRecord {
    pairing_id: String,
    pairing_code: String,
    daemon_token: String,
    label: Option<String>,
    session_id: String,
    #[serde(default)]
    device_id: Option<String>,
    daemon_bundle: Option<PairingPublicKeyBundle>,
    client_bundle: Option<PairingPublicKeyBundle>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionRecord {
    session_id: String,
    pairing_id: String,
    daemon_token: String,
    #[serde(default)]
    daemon_last_seen_at: Option<DateTime<Utc>>,
    #[serde(default)]
    devices: HashMap<String, TrustedDeviceRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_created_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_public_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_last_seen_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revoked_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    #[serde(default = "default_next_seq")]
    next_seq: u64,
    updates: Vec<RelayUpdate>,
    #[serde(default)]
    actions: HashMap<String, QueuedActionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrustedDeviceRecord {
    device_id: String,
    client_token: String,
    label: Option<String>,
    public_key: Option<String>,
    created_at: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

#[derive(Default)]
struct LiveSession {
    peers: HashMap<String, PeerHandle>,
    rpc_methods: HashMap<String, String>,
    pending_rpc: HashMap<String, PendingRpc>,
}

struct PendingRpc {
    requester_peer_id: String,
    responder_peer_id: String,
}

#[derive(Debug, Clone)]
struct WebSocketTicket {
    session_id: String,
    role: RelayPeerRole,
    device_id: Option<String>,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QueuedActionRecord {
    action_id: String,
    session_id: String,
    device_id: String,
    action_type: String,
    idempotency_key: String,
    payload: EncryptedEnvelope,
    status: QueuedRemoteActionStatus,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    error: Option<String>,
    result: Option<EncryptedEnvelope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_peer_id: Option<String>,
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
        let mut data = load_state(&state_path).await?;
        for session in data.sessions.values_mut() {
            session.migrate_legacy_device_fields();
            session.ensure_next_seq();
        }
        let normalized = normalize_in_flight_actions(&mut data);
        let state = Self {
            inner: Arc::new(InnerState {
                version,
                state_path,
                default_pairing_ttl,
                retention,
                store: Mutex::new(Store {
                    data,
                    live_sessions: HashMap::new(),
                    ws_tickets: HashMap::new(),
                }),
                persist_lock: Mutex::new(()),
                postgres: None,
                file_persist_task: Mutex::new(None),
            }),
        };
        let pruned = state.prune_expired_state().await?;
        if normalized || pruned {
            state.persist_current().await?;
        }
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
        let client = connect_postgres(&database_url).await?;
        let mut data = load_postgres_state(&client).await?;
        for session in data.sessions.values_mut() {
            session.migrate_legacy_device_fields();
            session.ensure_next_seq();
        }
        let normalized = normalize_in_flight_actions(&mut data);
        let state = Self {
            inner: Arc::new(InnerState {
                version,
                state_path: PathBuf::new(),
                default_pairing_ttl,
                retention,
                store: Mutex::new(Store {
                    data,
                    live_sessions: HashMap::new(),
                    ws_tickets: HashMap::new(),
                }),
                persist_lock: Mutex::new(()),
                postgres: Some(PostgresPersistence {
                    client: Mutex::new(client),
                }),
                file_persist_task: Mutex::new(None),
            }),
        };
        let pruned = state.prune_expired_state().await?;
        if normalized || pruned {
            state.persist_current().await?;
        }
        Ok(state)
    }

    pub async fn health(&self) -> RelayHealthResponse {
        let _ = self.prune_retained_state().await;
        let store = self.inner.store.lock().await;
        let now = Utc::now();
        let pending_pairings = store
            .data
            .pairings
            .values()
            .filter(|pairing| pairing.device_id.is_none() && pairing.expires_at > now)
            .count();

        RelayHealthResponse {
            ok: true,
            service: "falcondeck-relay".to_string(),
            version: self.inner.version.clone(),
            pending_pairings,
            active_sessions: store.data.sessions.len(),
        }
    }

    pub async fn start_pairing(
        &self,
        request: StartPairingRequest,
    ) -> Result<StartPairingResponse, RelayError> {
        let _ = self.prune_retained_state().await?;
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
                if session.daemon_token != provided_token {
                    return Err(RelayError::Unauthorized("invalid daemon token".to_string()));
                }
                session.updated_at = now;
                session_id = existing_session_id.clone();
                daemon_token = session.daemon_token.clone();
                session_snapshot = session.clone();
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
                    updates: Vec::new(),
                    actions: HashMap::new(),
                };
                session_snapshot = session.clone();
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

    pub async fn claim_pairing(
        &self,
        request: ClaimPairingRequest,
    ) -> Result<ClaimPairingResponse, RelayError> {
        let _ = self.prune_retained_state().await?;
        let pairing_code = request.pairing_code.trim().to_uppercase();
        if pairing_code.is_empty() {
            return Err(RelayError::BadRequest(
                "pairing_code is required".to_string(),
            ));
        }
        if request.client_bundle.is_none() {
            return Err(RelayError::BadRequest(
                "client_bundle with a public key is required".to_string(),
            ));
        }
        if let Some(bundle) = request.client_bundle.as_ref() {
            verify_pairing_public_key_bundle(bundle).map_err(|_| {
                RelayError::BadRequest("client_bundle signature is invalid".to_string())
            })?;
        }

        let now = Utc::now();
        let claimed_public_key = request
            .client_bundle
            .as_ref()
            .map(|bundle| bundle.public_key.clone());
        let (response, session_snapshot, pairing_snapshot, device_id) = {
            let mut store = self.inner.store.lock().await;
            let pairing_id = store
                .data
                .pairings
                .iter()
                .find_map(|(pairing_id, pairing)| {
                    (pairing.pairing_code == pairing_code).then_some(pairing_id.clone())
                })
                .ok_or_else(|| RelayError::NotFound("pairing not found".to_string()))?;
            let (session_id, claimed_device_id, stored_client_bundle, daemon_bundle, pairing_snapshot) = {
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

            let session = store
                .data
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
            if let Some(claimed_device_id) = claimed_device_id {
                let matches_claimed_device = stored_client_bundle
                    .as_ref()
                    .zip(claimed_public_key.as_ref())
                    .is_some_and(|(bundle, public_key)| &bundle.public_key == public_key)
                    || session.devices.get(&claimed_device_id).is_some_and(|device| {
                        device.revoked_at.is_none()
                            && device.public_key.as_ref() == claimed_public_key.as_ref()
                    });
                if !matches_claimed_device {
                    return Err(RelayError::Conflict(
                        "pairing has already been claimed".to_string(),
                    ));
                }

                let client_token = {
                    let existing = session
                        .devices
                        .get_mut(&claimed_device_id)
                        .ok_or_else(|| {
                            RelayError::NotFound("existing trusted device not found".to_string())
                        })?;
                    existing.label = request.label.clone();
                    existing.last_seen_at = Some(now);
                    if existing.public_key.is_none() {
                        existing.public_key = claimed_public_key.clone();
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
                let session_snapshot = session.clone();

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
                    claimed_device_id,
                )
            } else {
            let existing_device_id = claimed_public_key.as_ref().and_then(|public_key| {
                session.devices.iter().find_map(|(device_id, device)| {
                    (device.revoked_at.is_none() && device.public_key.as_ref() == Some(public_key))
                        .then_some(device_id.clone())
                })
            });
            let (device_id, client_token) = if let Some(existing_device_id) = existing_device_id {
                let existing = session
                    .devices
                    .get_mut(&existing_device_id)
                    .ok_or_else(|| {
                        RelayError::NotFound("existing trusted device not found".to_string())
                    })?;
                existing.label = request.label.clone();
                existing.last_seen_at = Some(now);
                if existing.public_key.is_none() {
                    existing.public_key = claimed_public_key.clone();
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
                        created_at: now,
                        last_seen_at: Some(now),
                        revoked_at: None,
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
            let session_snapshot = session.clone();
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
                    device_id,
                )
            }
        };

        self.persist_pairing_state(
            Some(&session_snapshot),
            Some(&pairing_snapshot),
            PersistMode::Immediate,
        )
        .await?;
        self.persist_device_state(&session_snapshot, Some(&device_id), PersistMode::Immediate)
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

        if pairing.daemon_token != daemon_token {
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
            presence: session.machine_presence(store.live_sessions.get(session_id).is_some_and(
                |live| {
                    live.peers
                        .values()
                        .any(|peer| matches!(peer.role, RelayPeerRole::Daemon))
                },
            )),
        })
    }

    pub async fn authenticate_session(
        &self,
        session_id: &str,
        token: &str,
    ) -> Result<SessionAuth, RelayError> {
        let _ = self.prune_retained_state().await?;
        let store = self.inner.store.lock().await;
        let mut session = store
            .data
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
        session.migrate_legacy_device_fields();

        let (role, device_id) = if session.daemon_token == token {
            (RelayPeerRole::Daemon, None)
        } else if let Some(device) = session
            .devices
            .values()
            .find(|device| device.client_token == token && device.revoked_at.is_none())
        {
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
        let entry = store
            .ws_tickets
            .remove(ticket)
            .ok_or_else(|| RelayError::Unauthorized("invalid websocket ticket".to_string()))?;
        if entry.session_id != session_id {
            return Err(RelayError::Unauthorized(
                "websocket ticket does not match session".to_string(),
            ));
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
                if let Some(current_device_id) = device_id.as_ref() {
                    if let Some(device) = session.devices.get_mut(current_device_id) {
                        device.last_seen_at = Some(now);
                    }
                }
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
        let mut session_snapshot = None;
        let mut should_redispatch = false;
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                live.peers.remove(peer_id);
                live.rpc_methods
                    .retain(|_, owner_peer_id| owner_peer_id != peer_id);

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

                let failed_request_ids = live
                    .pending_rpc
                    .iter()
                    .filter_map(|(request_id, pending)| {
                        if pending.responder_peer_id == peer_id {
                            Some(request_id.clone())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>();
                for request_id in failed_request_ids {
                    if let Some(pending) = live.pending_rpc.remove(&request_id) {
                        if let Some(requester) = live.peers.get(&pending.requester_peer_id) {
                            deferred.push((
                                pending.requester_peer_id.clone(),
                                requester.tx.clone(),
                                RelayServerMessage::RpcResult {
                                    request_id,
                                    ok: false,
                                    result: None,
                                    error: None,
                                },
                            ));
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
                    should_redispatch = true;
                }
                session.updated_at = now;
                session_snapshot = Some(session.clone());
            }
        }

        if let Some(session) = session_snapshot.as_ref() {
            let action_ids = requeued_actions
                .iter()
                .map(|action| action.action_id.as_str())
                .collect::<Vec<_>>();
            let _ = self
                .persist_action_state(
                    session,
                    (!action_ids.is_empty()).then_some(action_ids.as_slice()),
                    PersistMode::Immediate,
                )
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
                let response = self
                    .session_updates_for_ws(session_id, after_seq.unwrap_or(0))
                    .await?;
                self.send_to_peer(
                    session_id,
                    peer_id,
                    RelayServerMessage::Sync {
                        updates: response.updates,
                        next_seq: response.next_seq,
                        history_truncated: response.cursor.history_truncated,
                    },
                )
                .await;
            }
            RelayClientMessage::Update { body } => {
                self.append_update(session_id, body, PersistMode::Deferred)
                    .await?;
            }
            RelayClientMessage::Ephemeral { body } => {
                self.broadcast(session_id, RelayServerMessage::Ephemeral { body })
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
        let (update, session, recipients) = {
            let mut store = self.inner.store.lock().await;
            let update;
            let session_snapshot;
            {
                let session = store
                    .data
                    .sessions
                    .get_mut(session_id)
                    .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
                update = RelayUpdate {
                    id: format!("update-{}", Uuid::new_v4().simple()),
                    seq: session.next_seq,
                    body,
                    created_at: Utc::now(),
                };
                session.next_seq = session.next_seq.saturating_add(1);
                session.updated_at = update.created_at;
                session.updates.push(update.clone());
                session_snapshot = session.clone();
            }
            let recipients = store
                .live_sessions
                .get(session_id)
                .map(|live| {
                    live.peers
                        .iter()
                        .map(|(peer_id, peer)| (peer_id.clone(), peer.tx.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (update, session_snapshot, recipients)
        };

        for (peer_id, tx) in recipients {
            self.queue_message(
                session_id,
                &peer_id,
                &tx,
                RelayServerMessage::Update {
                    update: update.clone(),
                },
            );
        }

        self.persist_update_state(&session, &update, persist_mode)
            .await?;

        Ok(())
    }

    async fn register_rpc_method(&self, session_id: &str, peer_id: &str, method: String) {
        let mut ack = None;
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                live.rpc_methods.insert(method.clone(), peer_id.to_string());
                ack = live.peers.get(peer_id).map(|peer| peer.tx.clone());
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
    }

    async fn unregister_rpc_method(&self, session_id: &str, peer_id: &str, method: String) {
        let mut ack = None;
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                if live
                    .rpc_methods
                    .get(&method)
                    .is_some_and(|owner| owner == peer_id)
                {
                    live.rpc_methods.remove(&method);
                }
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
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                let requester = live.peers.get(peer_id).map(|peer| peer.tx.clone());
                if live.pending_rpc.contains_key(&request_id) {
                    response = requester.map(|tx| {
                        (
                            peer_id.to_string(),
                            tx,
                            RelayServerMessage::RpcResult {
                                request_id: request_id.clone(),
                                ok: false,
                                result: None,
                                error: None,
                            },
                        )
                    });
                } else if let Some(owner_peer_id) = live.rpc_methods.get(&method).cloned() {
                    if let Some(owner) = live.peers.get(&owner_peer_id) {
                        live.pending_rpc.insert(
                            request_id.clone(),
                            PendingRpc {
                                requester_peer_id: peer_id.to_string(),
                                responder_peer_id: owner_peer_id.clone(),
                            },
                        );
                        target = Some((owner_peer_id, owner.tx.clone()));
                    } else {
                        live.rpc_methods.remove(&method);
                        response = requester.map(|tx| {
                            (
                                peer_id.to_string(),
                                tx,
                                RelayServerMessage::RpcResult {
                                    request_id: request_id.clone(),
                                    ok: false,
                                    result: None,
                                    error: None,
                                },
                            )
                        });
                    }
                } else {
                    response = requester.map(|tx| {
                        (
                            peer_id.to_string(),
                            tx,
                            RelayServerMessage::RpcResult {
                                request_id: request_id.clone(),
                                ok: false,
                                result: None,
                                error: None,
                            },
                        )
                    });
                }
            }
        }

        if let Some((owner_peer_id, tx)) = target {
            self.queue_message(
                session_id,
                &owner_peer_id,
                &tx,
                RelayServerMessage::RpcRequest {
                    request_id,
                    method,
                    params,
                },
            );
        } else if let Some((requester_peer_id, tx, message)) = response {
            self.queue_message(session_id, &requester_peer_id, &tx, message);
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
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                if let Some(pending) = live.pending_rpc.remove(&request_id) {
                    if pending.responder_peer_id != peer_id {
                        warn!(
                            session_id,
                            request_id,
                            peer_id,
                            owner_peer_id = %pending.responder_peer_id,
                            "rejecting rpc result from non-owner daemon peer"
                        );
                        live.pending_rpc.insert(request_id.clone(), pending);
                    } else {
                        response = live
                            .peers
                            .get(&pending.requester_peer_id)
                            .map(|peer| (pending.requester_peer_id.clone(), peer.tx.clone()));
                    }
                }
            }
        }

        if let Some((requester_peer_id, tx)) = response {
            self.queue_message(
                session_id,
                &requester_peer_id,
                &tx,
                RelayServerMessage::RpcResult {
                    request_id,
                    ok,
                    result,
                    error,
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
        let (action, session) = {
            let mut store = self.inner.store.lock().await;
            let session = store
                .data
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;

            let action = if let Some(existing) = session
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
                        "idempotency key already used for a different queued action".to_string(),
                    ));
                }
                existing.to_public()
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
                action.to_public()
            };
            (action, session.clone())
        };

        let action_ids = [action.action_id.as_str()];
        self.persist_action_state(&session, Some(&action_ids), PersistMode::Immediate)
            .await?;
        self.append_update(
            session_id,
            RelayUpdateBody::ActionStatus {
                action: action.clone(),
            },
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
        let store = self.inner.store.lock().await;
        let session = store
            .data
            .sessions
            .get(session_id)
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
        Ok(TrustedDevicesResponse {
            session_id: session_id.to_string(),
            devices: session.trusted_devices(),
            presence: session.machine_presence(store.live_sessions.get(session_id).is_some_and(
                |live| {
                    live.peers
                        .values()
                        .any(|peer| matches!(peer.role, RelayPeerRole::Daemon))
                },
            )),
        })
    }

    pub async fn revoke_trusted_device(
        &self,
        session_id: &str,
        daemon_token: &str,
        device_id: &str,
    ) -> Result<TrustedDevicesResponse, RelayError> {
        let auth = self.authenticate_session(session_id, daemon_token).await?;
        if !matches!(auth.role, RelayPeerRole::Daemon) {
            return Err(RelayError::Unauthorized(
                "only daemon peers may revoke trusted devices".to_string(),
            ));
        }
        let (revoked_peer_ids, session) = {
            let mut store = self.inner.store.lock().await;
            let session_snapshot;
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
                device.revoked_at = Some(Utc::now());
                session.updated_at = Utc::now();
                session_snapshot = session.clone();
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
            (revoked_peer_ids, session_snapshot)
        };
        self.persist_device_state(&session, Some(device_id), PersistMode::Immediate)
            .await?;
        for peer_id in revoked_peer_ids {
            self.unregister_peer(session_id, &peer_id).await;
        }
        self.broadcast_presence(session_id).await;
        self.trusted_devices(session_id, daemon_token).await
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
        let (action, session) = {
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
            session.updated_at = action.updated_at;
            (action.to_public(), session.clone())
        };
        let action_ids = [action_id];
        self.persist_action_state(&session, Some(&action_ids), PersistMode::Immediate)
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
        let mut touched_device_id = None;
        let mut store = self.inner.store.lock().await;
        if let Some(session) = store.data.sessions.get_mut(session_id) {
            let now = Utc::now();
            session.migrate_legacy_device_fields();
            match role {
                RelayPeerRole::Daemon => session.daemon_last_seen_at = Some(now),
                RelayPeerRole::Client => {
                    if let Some(current_device_id) = device_id {
                        if let Some(device) = session.devices.get_mut(current_device_id) {
                            device.last_seen_at = Some(now);
                            touched_device_id = Some(current_device_id.to_string());
                        }
                    }
                }
            }
            session.updated_at = now;
            session_snapshot = Some(session.clone());
        }
        drop(store);
        if let Some(session) = session_snapshot.as_ref() {
            let _ = self
                .persist_device_state(session, touched_device_id.as_deref(), PersistMode::Deferred)
                .await;
        }
    }

    async fn broadcast_presence(&self, session_id: &str) {
        let presence = {
            let store = self.inner.store.lock().await;
            let Some(session) = store.data.sessions.get(session_id) else {
                return;
            };
            session.machine_presence(store.live_sessions.get(session_id).is_some_and(|live| {
                live.peers
                    .values()
                    .any(|peer| matches!(peer.role, RelayPeerRole::Daemon))
            }))
        };
        self.broadcast(
            session_id,
            RelayServerMessage::Presence {
                presence: presence.clone(),
            },
        )
        .await;
        let _ = self.append_update(
            session_id,
            RelayUpdateBody::Presence { presence },
            PersistMode::Deferred,
        );
    }

    async fn dispatch_pending_actions(&self, session_id: &str) {
        let mut to_send = Vec::new();
        let session_snapshot = {
            let mut store = self.inner.store.lock().await;
            let Some(live) = store.live_sessions.get_mut(session_id) else {
                return;
            };
            let Some((target_peer_id, target)) = live
                .peers
                .iter()
                .find(|(_, peer)| matches!(peer.role, RelayPeerRole::Daemon))
                .map(|(peer_id, peer)| (peer_id.clone(), peer.tx.clone()))
            else {
                return;
            };
            let Some(session) = store.data.sessions.get_mut(session_id) else {
                return;
            };
            for action in session.actions.values_mut() {
                if !matches!(action.status, QueuedRemoteActionStatus::Queued) {
                    continue;
                }
                action.status = QueuedRemoteActionStatus::Dispatched;
                action.updated_at = Utc::now();
                action.error = None;
                action.result = None;
                action.owner_peer_id = Some(target_peer_id.clone());
                to_send.push((
                    target_peer_id.clone(),
                    target.clone(),
                    action.to_public(),
                    action.payload.clone(),
                ));
            }
            Some(session.clone())
        };

        if let Some(session) = session_snapshot.as_ref() {
            let action_ids = to_send
                .iter()
                .map(|(_, _, action, _)| action.action_id.as_str())
                .collect::<Vec<_>>();
            if !action_ids.is_empty() {
                let _ = self
                    .persist_action_state(
                        session,
                        Some(action_ids.as_slice()),
                        PersistMode::Immediate,
                    )
                    .await;
            }
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
            let _ = self
                .append_update(
                    session_id,
                    RelayUpdateBody::ActionStatus { action },
                    PersistMode::Immediate,
                )
                .await;
        }
    }

    async fn session_updates_for_ws(
        &self,
        session_id: &str,
        after_seq: u64,
    ) -> Result<RelayUpdatesResponse, RelayError> {
        let store = self.inner.store.lock().await;
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
            presence: session.machine_presence(store.live_sessions.get(session_id).is_some_and(
                |live| {
                    live.peers
                        .values()
                        .any(|peer| matches!(peer.role, RelayPeerRole::Daemon))
                },
            )),
        })
    }

    async fn send_to_peer(&self, session_id: &str, peer_id: &str, message: RelayServerMessage) {
        let tx = {
            let store = self.inner.store.lock().await;
            store
                .live_sessions
                .get(session_id)
                .and_then(|live| live.peers.get(peer_id))
                .map(|peer| peer.tx.clone())
        };

        if let Some(tx) = tx {
            self.queue_message(session_id, peer_id, &tx, message);
        }
    }

    async fn broadcast(&self, session_id: &str, message: RelayServerMessage) {
        let recipients = {
            let store = self.inner.store.lock().await;
            store
                .live_sessions
                .get(session_id)
                .map(|live| {
                    live.peers
                        .iter()
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
        session: Option<&SessionRecord>,
        pairing: Option<&PairingRecord>,
        mode: PersistMode,
    ) -> Result<(), RelayError> {
        if let Some(postgres) = &self.inner.postgres {
            let mut client = postgres.client.lock().await;
            if let Some(session) = session {
                upsert_postgres_session(&mut client, session).await?;
            }
            if let Some(pairing) = pairing {
                upsert_postgres_pairing(&mut client, pairing).await?;
            }
            Ok(())
        } else {
            self.persist_file(mode).await
        }
    }

    async fn persist_device_state(
        &self,
        session: &SessionRecord,
        device_id: Option<&str>,
        mode: PersistMode,
    ) -> Result<(), RelayError> {
        if let Some(postgres) = &self.inner.postgres {
            let mut client = postgres.client.lock().await;
            upsert_postgres_session(&mut client, session).await?;
            if let Some(device_id) = device_id {
                if let Some(device) = session.devices.get(device_id) {
                    upsert_postgres_device(&mut client, &session.session_id, device).await?;
                }
            }
            Ok(())
        } else {
            self.persist_file(mode).await
        }
    }

    async fn persist_action_state(
        &self,
        session: &SessionRecord,
        action_ids: Option<&[&str]>,
        mode: PersistMode,
    ) -> Result<(), RelayError> {
        if let Some(postgres) = &self.inner.postgres {
            let mut client = postgres.client.lock().await;
            upsert_postgres_session(&mut client, session).await?;
            let ids = if let Some(action_ids) = action_ids {
                action_ids
                    .iter()
                    .filter_map(|action_id| session.actions.get(*action_id))
                    .cloned()
                    .collect::<Vec<_>>()
            } else {
                session.actions.values().cloned().collect::<Vec<_>>()
            };
            for action in ids {
                upsert_postgres_action(&mut client, &action).await?;
            }
            Ok(())
        } else {
            self.persist_file(mode).await
        }
    }

    async fn persist_update_state(
        &self,
        session: &SessionRecord,
        update: &RelayUpdate,
        mode: PersistMode,
    ) -> Result<(), RelayError> {
        if let Some(postgres) = &self.inner.postgres {
            let mut client = postgres.client.lock().await;
            upsert_postgres_session(&mut client, session).await?;
            upsert_postgres_update(&mut client, &session.session_id, update).await?;
            Ok(())
        } else {
            self.persist_file(mode).await
        }
    }

    async fn persist_file(&self, mode: PersistMode) -> Result<(), RelayError> {
        if self.inner.postgres.is_some() {
            return Ok(());
        }

        match mode {
            PersistMode::Immediate => {
                let mut task = self.inner.file_persist_task.lock().await;
                if let Some(handle) = task.take() {
                    handle.abort();
                }
                drop(task);
                self.persist_current().await
            }
            PersistMode::Deferred => {
                let mut task = self.inner.file_persist_task.lock().await;
                if let Some(handle) = task.take() {
                    handle.abort();
                }
                let state = self.clone();
                *task = Some(tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(FILE_PERSIST_DEBOUNCE_MS))
                        .await;
                    let _ = state.persist_current().await;
                }));
                Ok(())
            }
        }
    }

    async fn persist_current(&self) -> Result<(), RelayError> {
        let _persist_guard = self.inner.persist_lock.lock().await;
        let snapshot = {
            let store = self.inner.store.lock().await;
            store.data.clone()
        };
        if let Some(postgres) = &self.inner.postgres {
            let mut client = postgres.client.lock().await;
            persist_postgres_state(&mut client, &snapshot).await
        } else {
            persist_state(&self.inner.state_path, &snapshot).await
        }
    }

    async fn prune_expired_state(&self) -> Result<bool, RelayError> {
        let changed = {
            let mut store = self.inner.store.lock().await;
            let live_session_ids = store.live_sessions.keys().cloned().collect();
            prune_state(
                &mut store.data,
                &live_session_ids,
                &self.inner.retention,
                Utc::now(),
            )
        };
        Ok(changed)
    }

    async fn prune_retained_state(&self) -> Result<bool, RelayError> {
        let changed = self.prune_expired_state().await?;
        if changed {
            self.persist_current().await?;
        }
        Ok(changed)
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
                    created_at: self.device_created_at.unwrap_or(self.created_at),
                    last_seen_at: self.client_last_seen_at,
                    revoked_at: self.revoked_at,
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
        after_seq > 0 && after_seq.saturating_add(1) < self.oldest_retained_seq()
    }

    fn trusted_devices(&self) -> Vec<TrustedDevice> {
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
                created_at: device.created_at,
                last_seen_at: device.last_seen_at,
                revoked_at: device.revoked_at,
            })
            .collect::<Vec<_>>();
        devices.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        devices
    }

    fn machine_presence(&self, daemon_connected: bool) -> MachinePresence {
        MachinePresence {
            session_id: self.session_id.clone(),
            daemon_connected,
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

fn prune_state(
    state: &mut PersistedState,
    live_session_ids: &std::collections::HashSet<String>,
    retention: &RetentionConfig,
    now: DateTime<Utc>,
) -> bool {
    let mut changed = false;

    for session in state.sessions.values_mut() {
        session.ensure_next_seq();

        let update_cutoff = now - retention.update_retention;
        let before_updates = session.updates.len();
        session
            .updates
            .retain(|update| update.created_at >= update_cutoff);
        if session.updates.len() > retention.max_updates_per_session {
            let drop_count = session.updates.len() - retention.max_updates_per_session;
            session.updates.drain(0..drop_count);
        }
        if session.updates.len() != before_updates {
            changed = true;
        }

        let action_cutoff = now - retention.completed_action_retention;
        let before_actions = session.actions.len();
        session.actions.retain(|_, action| {
            let terminal = matches!(
                action.status,
                QueuedRemoteActionStatus::Completed | QueuedRemoteActionStatus::Failed
            );
            !terminal || action.updated_at >= action_cutoff
        });
        if session.actions.len() != before_actions {
            changed = true;
        }
    }

    let claimed_pairing_cutoff = now - retention.claimed_pairing_retention;
    let before_pairings = state.pairings.len();
    state.pairings.retain(|_, pairing| {
        if pairing.device_id.is_none() {
            pairing.expires_at > now
        } else {
            pairing.created_at >= claimed_pairing_cutoff
        }
    });
    if state.pairings.len() != before_pairings {
        changed = true;
    }

    let session_before = state.sessions.len();
    state.sessions.retain(|session_id, session| {
        if live_session_ids.contains(session_id) {
            return true;
        }

        let trusted_until = session
            .devices
            .values()
            .filter(|device| device.revoked_at.is_none())
            .map(|device| device.last_seen_at.unwrap_or(device.created_at))
            .max()
            .map(|last_seen| last_seen + retention.trusted_device_retention);
        let daemon_until = session
            .daemon_last_seen_at
            .map(|seen| seen + retention.update_retention);
        let session_until = session.updated_at + retention.update_retention;
        let retain_until = trusted_until
            .into_iter()
            .chain(daemon_until)
            .chain(std::iter::once(session_until))
            .max()
            .unwrap_or(session.updated_at);
        retain_until > now
    });
    if state.sessions.len() != session_before {
        changed = true;
    }

    let valid_sessions = state
        .sessions
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let pairings_before = state.pairings.len();
    state
        .pairings
        .retain(|_, pairing| valid_sessions.contains(&pairing.session_id));
    if state.pairings.len() != pairings_before {
        changed = true;
    }

    changed
}

async fn connect_postgres(database_url: &str) -> Result<PostgresClient, RelayError> {
    let (client, connection) = tokio_postgres::connect(database_url, NoTls)
        .await
        .map_err(|error| RelayError::StateLoad(error.to_string()))?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            warn!("postgres relay connection ended: {error}");
        }
    });
    init_postgres_schema(&client).await?;
    Ok(client)
}

async fn upsert_postgres_session(
    client: &mut PostgresClient,
    session: &SessionRecord,
) -> Result<(), RelayError> {
    client
        .execute(
            "INSERT INTO relay_sessions (session_id, pairing_id, daemon_token, daemon_last_seen_at, created_at, updated_at, next_seq)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (session_id) DO UPDATE SET
               pairing_id = EXCLUDED.pairing_id,
               daemon_token = EXCLUDED.daemon_token,
               daemon_last_seen_at = EXCLUDED.daemon_last_seen_at,
               created_at = EXCLUDED.created_at,
               updated_at = EXCLUDED.updated_at,
               next_seq = EXCLUDED.next_seq",
            &[
                &session.session_id,
                &session.pairing_id,
                &session.daemon_token,
                &session.daemon_last_seen_at,
                &session.created_at,
                &session.updated_at,
                &i64::try_from(session.next_seq)
                    .map_err(|_| RelayError::StatePersist("next sequence overflow".to_string()))?,
            ],
        )
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    Ok(())
}

async fn upsert_postgres_pairing(
    client: &mut PostgresClient,
    pairing: &PairingRecord,
) -> Result<(), RelayError> {
    client
        .execute(
            "INSERT INTO relay_pairings (pairing_id, pairing_code, daemon_token, label, session_id, device_id, daemon_bundle, client_bundle, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (pairing_id) DO UPDATE SET
               pairing_code = EXCLUDED.pairing_code,
               daemon_token = EXCLUDED.daemon_token,
               label = EXCLUDED.label,
               session_id = EXCLUDED.session_id,
               device_id = EXCLUDED.device_id,
               daemon_bundle = EXCLUDED.daemon_bundle,
               client_bundle = EXCLUDED.client_bundle,
               created_at = EXCLUDED.created_at,
               expires_at = EXCLUDED.expires_at",
            &[
                &pairing.pairing_id,
                &pairing.pairing_code,
                &pairing.daemon_token,
                &pairing.label,
                &pairing.session_id,
                &pairing.device_id,
                &encode_optional_json_field(pairing.daemon_bundle.as_ref())?,
                &encode_optional_json_field(pairing.client_bundle.as_ref())?,
                &pairing.created_at,
                &pairing.expires_at,
            ],
        )
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    Ok(())
}

async fn upsert_postgres_device(
    client: &mut PostgresClient,
    session_id: &str,
    device: &TrustedDeviceRecord,
) -> Result<(), RelayError> {
    client
        .execute(
            "INSERT INTO relay_devices (session_id, device_id, client_token, label, public_key, created_at, last_seen_at, revoked_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (session_id, device_id) DO UPDATE SET
               client_token = EXCLUDED.client_token,
               label = EXCLUDED.label,
               public_key = EXCLUDED.public_key,
               created_at = EXCLUDED.created_at,
               last_seen_at = EXCLUDED.last_seen_at,
               revoked_at = EXCLUDED.revoked_at",
            &[
                &session_id,
                &device.device_id,
                &device.client_token,
                &device.label,
                &device.public_key,
                &device.created_at,
                &device.last_seen_at,
                &device.revoked_at,
            ],
        )
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    Ok(())
}

async fn upsert_postgres_update(
    client: &mut PostgresClient,
    session_id: &str,
    update: &RelayUpdate,
) -> Result<(), RelayError> {
    let seq = i64::try_from(update.seq)
        .map_err(|_| RelayError::StatePersist("update sequence overflow".to_string()))?;
    client
        .execute(
            "INSERT INTO relay_updates (session_id, seq, update_id, body, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (session_id, seq) DO UPDATE SET
               update_id = EXCLUDED.update_id,
               body = EXCLUDED.body,
               created_at = EXCLUDED.created_at",
            &[
                &session_id,
                &seq,
                &update.id,
                &encode_json_field(&update.body)?,
                &update.created_at,
            ],
        )
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    Ok(())
}

async fn upsert_postgres_action(
    client: &mut PostgresClient,
    action: &QueuedActionRecord,
) -> Result<(), RelayError> {
    client
        .execute(
            "INSERT INTO relay_actions (action_id, session_id, device_id, action_type, idempotency_key, payload, status, created_at, updated_at, error, result)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (action_id) DO UPDATE SET
               session_id = EXCLUDED.session_id,
               device_id = EXCLUDED.device_id,
               action_type = EXCLUDED.action_type,
               idempotency_key = EXCLUDED.idempotency_key,
               payload = EXCLUDED.payload,
               status = EXCLUDED.status,
               created_at = EXCLUDED.created_at,
               updated_at = EXCLUDED.updated_at,
               error = EXCLUDED.error,
               result = EXCLUDED.result",
            &[
                &action.action_id,
                &action.session_id,
                &action.device_id,
                &action.action_type,
                &action.idempotency_key,
                &encode_json_field(&action.payload)?,
                &queued_action_status_to_db(&action.status),
                &action.created_at,
                &action.updated_at,
                &action.error,
                &encode_optional_json_field(action.result.as_ref())?,
            ],
        )
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    Ok(())
}

async fn init_postgres_schema(client: &PostgresClient) -> Result<(), RelayError> {
    client
        .batch_execute(
            r"
            CREATE TABLE IF NOT EXISTS relay_sessions (
                session_id TEXT PRIMARY KEY,
                pairing_id TEXT NOT NULL,
                daemon_token TEXT NOT NULL,
                daemon_last_seen_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                next_seq BIGINT NOT NULL DEFAULT 1
            );
            ALTER TABLE relay_sessions
                ADD COLUMN IF NOT EXISTS next_seq BIGINT NOT NULL DEFAULT 1;
            CREATE TABLE IF NOT EXISTS relay_pairings (
                pairing_id TEXT PRIMARY KEY,
                pairing_code TEXT NOT NULL UNIQUE,
                daemon_token TEXT NOT NULL,
                label TEXT NULL,
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                device_id TEXT NULL,
                daemon_bundle JSONB NULL,
                client_bundle JSONB NULL,
                created_at TIMESTAMPTZ NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL
            );
            CREATE TABLE IF NOT EXISTS relay_devices (
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                client_token TEXT NOT NULL UNIQUE,
                label TEXT NULL,
                public_key TEXT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                last_seen_at TIMESTAMPTZ NULL,
                revoked_at TIMESTAMPTZ NULL,
                PRIMARY KEY (session_id, device_id)
            );
            CREATE TABLE IF NOT EXISTS relay_updates (
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                seq BIGINT NOT NULL,
                update_id TEXT NOT NULL UNIQUE,
                body JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                PRIMARY KEY (session_id, seq)
            );
            CREATE TABLE IF NOT EXISTS relay_actions (
                action_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                payload JSONB NOT NULL,
                status TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                error TEXT NULL,
                result JSONB NULL
            );
            ALTER TABLE relay_actions
                DROP CONSTRAINT IF EXISTS relay_actions_session_idempotency_key_key;
            ALTER TABLE relay_actions
                DROP CONSTRAINT IF EXISTS relay_actions_session_device_idempotency_key_key;
            ALTER TABLE relay_actions
                ADD CONSTRAINT relay_actions_session_device_idempotency_key_key
                UNIQUE (session_id, device_id, idempotency_key);
            CREATE INDEX IF NOT EXISTS relay_updates_session_seq_idx
                ON relay_updates(session_id, seq);
            CREATE INDEX IF NOT EXISTS relay_actions_session_idx
                ON relay_actions(session_id, created_at);
            CREATE INDEX IF NOT EXISTS relay_devices_session_idx
                ON relay_devices(session_id, created_at);
            ",
        )
        .await
        .map_err(|error| RelayError::StateLoad(error.to_string()))?;
    Ok(())
}

async fn load_postgres_state(client: &PostgresClient) -> Result<PersistedState, RelayError> {
    let mut state = PersistedState::default();

    for row in client
        .query(
            "SELECT session_id, pairing_id, daemon_token, daemon_last_seen_at, created_at, updated_at, next_seq FROM relay_sessions",
            &[],
        )
        .await
        .map_err(|error| RelayError::StateLoad(error.to_string()))?
    {
        let session_id: String = row.get("session_id");
        state.sessions.insert(
            session_id.clone(),
            SessionRecord {
                session_id,
                pairing_id: row.get("pairing_id"),
                daemon_token: row.get("daemon_token"),
                daemon_last_seen_at: row.get("daemon_last_seen_at"),
                devices: HashMap::new(),
                device_id: None,
                device_created_at: None,
                client_token: None,
                client_label: None,
                client_public_key: None,
                client_last_seen_at: None,
                revoked_at: None,
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
                next_seq: row
                    .get::<_, i64>("next_seq")
                    .try_into()
                    .map_err(|_| RelayError::StateLoad("invalid next sequence".to_string()))?,
                updates: Vec::new(),
                actions: HashMap::new(),
            },
        );
    }

    for row in client
        .query(
            "SELECT session_id, device_id, client_token, label, public_key, created_at, last_seen_at, revoked_at FROM relay_devices ORDER BY created_at ASC",
            &[],
        )
        .await
        .map_err(|error| RelayError::StateLoad(error.to_string()))?
    {
        let session_id: String = row.get("session_id");
        if let Some(session) = state.sessions.get_mut(&session_id) {
            let device = TrustedDeviceRecord {
                device_id: row.get("device_id"),
                client_token: row.get("client_token"),
                label: row.get("label"),
                public_key: row.get("public_key"),
                created_at: row.get("created_at"),
                last_seen_at: row.get("last_seen_at"),
                revoked_at: row.get("revoked_at"),
            };
            session.devices.insert(device.device_id.clone(), device);
        }
    }

    for row in client
        .query(
            "SELECT pairing_id, pairing_code, daemon_token, label, session_id, device_id, daemon_bundle, client_bundle, created_at, expires_at FROM relay_pairings",
            &[],
        )
        .await
        .map_err(|error| RelayError::StateLoad(error.to_string()))?
    {
        let pairing = PairingRecord {
            pairing_id: row.get("pairing_id"),
            pairing_code: row.get("pairing_code"),
            daemon_token: row.get("daemon_token"),
            label: row.get("label"),
            session_id: row.get("session_id"),
            device_id: row.get("device_id"),
            daemon_bundle: decode_optional_json_field(row.get("daemon_bundle"))?,
            client_bundle: decode_optional_json_field(row.get("client_bundle"))?,
            created_at: row.get("created_at"),
            expires_at: row.get("expires_at"),
        };
        state.pairings.insert(pairing.pairing_id.clone(), pairing);
    }

    for row in client
        .query(
            "SELECT session_id, update_id, seq, body, created_at FROM relay_updates ORDER BY session_id ASC, seq ASC",
            &[],
        )
        .await
        .map_err(|error| RelayError::StateLoad(error.to_string()))?
    {
        let session_id: String = row.get("session_id");
        if let Some(session) = state.sessions.get_mut(&session_id) {
            session.updates.push(RelayUpdate {
                id: row.get("update_id"),
                seq: row
                    .get::<_, i64>("seq")
                    .try_into()
                    .map_err(|_| RelayError::StateLoad("invalid update sequence".to_string()))?,
                body: decode_json_field(row.get("body"))?,
                created_at: row.get("created_at"),
            });
        }
    }

    for row in client
        .query(
            "SELECT session_id, action_id, device_id, action_type, idempotency_key, payload, status, created_at, updated_at, error, result FROM relay_actions",
            &[],
        )
        .await
        .map_err(|error| RelayError::StateLoad(error.to_string()))?
    {
        let session_id: String = row.get("session_id");
        if let Some(session) = state.sessions.get_mut(&session_id) {
            let action = QueuedActionRecord {
                action_id: row.get("action_id"),
                session_id: session_id.clone(),
                device_id: row.get("device_id"),
                action_type: row.get("action_type"),
                idempotency_key: row.get("idempotency_key"),
                payload: decode_json_field(row.get("payload"))?,
                status: queued_action_status_from_db(&row.get::<_, String>("status"))?,
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
                error: row.get("error"),
                result: decode_optional_json_field(row.get("result"))?,
                owner_peer_id: None,
            };
            session.actions.insert(action.action_id.clone(), action);
        }
    }

    Ok(state)
}

async fn persist_postgres_state(
    client: &mut PostgresClient,
    state: &PersistedState,
) -> Result<(), RelayError> {
    let tx = client
        .transaction()
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;

    tx.batch_execute(
        r"
        DELETE FROM relay_pairings;
        DELETE FROM relay_actions;
        DELETE FROM relay_updates;
        DELETE FROM relay_devices;
        DELETE FROM relay_sessions;
        ",
    )
    .await
    .map_err(|error| RelayError::StatePersist(error.to_string()))?;

    for session in state.sessions.values() {
        tx.execute(
            "INSERT INTO relay_sessions (session_id, pairing_id, daemon_token, daemon_last_seen_at, created_at, updated_at, next_seq)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
            &[
                &session.session_id,
                &session.pairing_id,
                &session.daemon_token,
                &session.daemon_last_seen_at,
                &session.created_at,
                &session.updated_at,
                &i64::try_from(session.next_seq)
                    .map_err(|_| RelayError::StatePersist("next sequence overflow".to_string()))?,
            ],
        )
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;

        for device in session.devices.values() {
            tx.execute(
                "INSERT INTO relay_devices (session_id, device_id, client_token, label, public_key, created_at, last_seen_at, revoked_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                &[
                    &session.session_id,
                    &device.device_id,
                    &device.client_token,
                    &device.label,
                    &device.public_key,
                    &device.created_at,
                    &device.last_seen_at,
                    &device.revoked_at,
                ],
            )
            .await
            .map_err(|error| RelayError::StatePersist(error.to_string()))?;
        }

        for update in &session.updates {
            let seq = i64::try_from(update.seq)
                .map_err(|_| RelayError::StatePersist("update sequence overflow".to_string()))?;
            tx.execute(
                "INSERT INTO relay_updates (session_id, update_id, seq, body, created_at)
                 VALUES ($1, $2, $3, $4, $5)",
                &[
                    &session.session_id,
                    &update.id,
                    &seq,
                    &encode_json_field(&update.body)?,
                    &update.created_at,
                ],
            )
            .await
            .map_err(|error| RelayError::StatePersist(error.to_string()))?;
        }

        for action in session.actions.values() {
            tx.execute(
                "INSERT INTO relay_actions (action_id, session_id, device_id, action_type, idempotency_key, payload, status, created_at, updated_at, error, result)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
                &[
                    &action.action_id,
                    &session.session_id,
                    &action.device_id,
                    &action.action_type,
                    &action.idempotency_key,
                    &encode_json_field(&action.payload)?,
                    &queued_action_status_to_db(&action.status),
                    &action.created_at,
                    &action.updated_at,
                    &action.error,
                    &encode_optional_json_field(action.result.as_ref())?,
                ],
            )
            .await
            .map_err(|error| RelayError::StatePersist(error.to_string()))?;
        }
    }

    for pairing in state.pairings.values() {
        tx.execute(
            "INSERT INTO relay_pairings (pairing_id, pairing_code, daemon_token, label, session_id, device_id, daemon_bundle, client_bundle, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            &[
                &pairing.pairing_id,
                &pairing.pairing_code,
                &pairing.daemon_token,
                &pairing.label,
                &pairing.session_id,
                &pairing.device_id,
                &encode_optional_json_field(pairing.daemon_bundle.as_ref())?,
                &encode_optional_json_field(pairing.client_bundle.as_ref())?,
                &pairing.created_at,
                &pairing.expires_at,
            ],
        )
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    }

    tx.commit()
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    Ok(())
}

fn encode_json_field<T: Serialize>(value: &T) -> Result<serde_json::Value, RelayError> {
    serde_json::to_value(value).map_err(|error| RelayError::StatePersist(error.to_string()))
}

fn encode_optional_json_field<T: Serialize>(
    value: Option<&T>,
) -> Result<Option<serde_json::Value>, RelayError> {
    value.map(encode_json_field).transpose()
}

fn decode_json_field<T: for<'de> Deserialize<'de>>(
    value: serde_json::Value,
) -> Result<T, RelayError> {
    serde_json::from_value(value).map_err(|error| RelayError::StateLoad(error.to_string()))
}

fn decode_optional_json_field<T: for<'de> Deserialize<'de>>(
    value: Option<serde_json::Value>,
) -> Result<Option<T>, RelayError> {
    value.map(decode_json_field).transpose()
}

fn queued_action_status_to_db(status: &QueuedRemoteActionStatus) -> &'static str {
    match status {
        QueuedRemoteActionStatus::Queued => "queued",
        QueuedRemoteActionStatus::Dispatched => "dispatched",
        QueuedRemoteActionStatus::Executing => "executing",
        QueuedRemoteActionStatus::Completed => "completed",
        QueuedRemoteActionStatus::Failed => "failed",
    }
}

fn queued_action_status_from_db(value: &str) -> Result<QueuedRemoteActionStatus, RelayError> {
    match value {
        "queued" => Ok(QueuedRemoteActionStatus::Queued),
        "dispatched" => Ok(QueuedRemoteActionStatus::Dispatched),
        "executing" => Ok(QueuedRemoteActionStatus::Executing),
        "completed" => Ok(QueuedRemoteActionStatus::Completed),
        "failed" => Ok(QueuedRemoteActionStatus::Failed),
        other => Err(RelayError::StateLoad(format!(
            "unknown queued action status `{other}`"
        ))),
    }
}

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

async fn load_state(path: &Path) -> Result<PersistedState, RelayError> {
    match fs::read_to_string(path).await {
        Ok(contents) => match serde_json::from_str(&contents) {
            Ok(state) => Ok(state),
            Err(error) => {
                warn!(
                    "failed to parse persisted relay state directly: {error}; attempting legacy migration"
                );
                load_compatible_state(&contents)
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PersistedState::default()),
        Err(error) => Err(RelayError::StateLoad(error.to_string())),
    }
}

fn load_compatible_state(contents: &str) -> Result<PersistedState, RelayError> {
    let raw: serde_json::Value =
        serde_json::from_str(contents).map_err(|error| RelayError::StateLoad(error.to_string()))?;

    let mut state = PersistedState::default();

    if let Some(pairings) = raw.get("pairings").and_then(serde_json::Value::as_object) {
        for (pairing_id, pairing_value) in pairings {
            match serde_json::from_value::<PairingRecord>(pairing_value.clone()) {
                Ok(pairing) => {
                    state.pairings.insert(pairing_id.clone(), pairing);
                }
                Err(error) => {
                    warn!("skipping incompatible legacy pairing record {pairing_id}: {error}");
                }
            }
        }
    }

    if let Some(sessions) = raw.get("sessions").and_then(serde_json::Value::as_object) {
        for (session_id, session_value) in sessions {
            match serde_json::from_value::<SessionRecord>(session_value.clone()) {
                Ok(session) => {
                    state.sessions.insert(session_id.clone(), session);
                }
                Err(first_error) => {
                    // Old updates may use a different serialization format for
                    // RelayUpdateBody (e.g. missing the "t" tag). Clear them and
                    // retry — clients will re-bootstrap on connect anyway.
                    let mut patched = session_value.clone();
                    if let Some(obj) = patched.as_object_mut() {
                        obj.insert("updates".to_string(), serde_json::json!([]));
                        obj.insert("actions".to_string(), serde_json::json!({}));
                    }
                    match serde_json::from_value::<SessionRecord>(patched) {
                        Ok(session) => {
                            warn!(
                                "recovered legacy session {session_id} (cleared incompatible updates)"
                            );
                            state.sessions.insert(session_id.clone(), session);
                        }
                        Err(_) => {
                            warn!(
                                "skipping incompatible legacy session record {session_id}: {first_error}"
                            );
                        }
                    }
                }
            }
        }
    }

    Ok(state)
}

async fn persist_state(path: &Path, state: &PersistedState) -> Result<(), RelayError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    }

    let tmp_path = path.with_extension("tmp");
    let json = serde_json::to_vec_pretty(state)
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    fs::write(&tmp_path, json)
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    fs::rename(&tmp_path, path)
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    Ok(())
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
