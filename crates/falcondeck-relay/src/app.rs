use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use chrono::{DateTime, Duration, Utc};
use falcondeck_core::{
    ClaimPairingRequest, ClaimPairingResponse, PairingStatus, PairingStatusResponse,
    RelayClientMessage, RelayHealthResponse, RelayPeerRole, RelayServerMessage, RelayUpdate,
    RelayUpdatesResponse, StartPairingRequest, StartPairingResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    fs,
    sync::{Mutex, mpsc},
};
use tracing::warn;
use uuid::Uuid;

use crate::error::RelayError;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<InnerState>,
}

struct InnerState {
    version: String,
    state_path: PathBuf,
    default_pairing_ttl: Duration,
    store: Mutex<Store>,
}

struct Store {
    data: PersistedState,
    live_sessions: HashMap<String, LiveSession>,
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
    session_id: Option<String>,
    daemon_bundle: Option<Value>,
    client_bundle: Option<Value>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionRecord {
    session_id: String,
    pairing_id: String,
    daemon_token: String,
    client_token: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    updates: Vec<RelayUpdate>,
}

#[derive(Default)]
struct LiveSession {
    peers: HashMap<String, PeerHandle>,
    rpc_methods: HashMap<String, String>,
    pending_rpc: HashMap<String, PendingRpc>,
}

struct PendingRpc {
    requester_peer_id: String,
}

#[derive(Clone)]
struct PeerHandle {
    role: RelayPeerRole,
    tx: mpsc::UnboundedSender<RelayServerMessage>,
}

#[derive(Debug, Clone)]
pub struct SessionAuth {
    pub session_id: String,
    pub role: RelayPeerRole,
}

impl AppState {
    pub async fn load(
        version: String,
        state_path: PathBuf,
        default_pairing_ttl: Duration,
    ) -> Result<Self, RelayError> {
        let data = load_state(&state_path).await?;
        Ok(Self {
            inner: Arc::new(InnerState {
                version,
                state_path,
                default_pairing_ttl,
                store: Mutex::new(Store {
                    data,
                    live_sessions: HashMap::new(),
                }),
            }),
        })
    }

    pub async fn health(&self) -> RelayHealthResponse {
        let store = self.inner.store.lock().await;
        let now = Utc::now();
        let pending_pairings = store
            .data
            .pairings
            .values()
            .filter(|pairing| pairing.session_id.is_none() && pairing.expires_at > now)
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
        let ttl_seconds = request
            .ttl_seconds
            .unwrap_or_else(|| self.inner.default_pairing_ttl.num_seconds().max(1) as u64);
        if ttl_seconds == 0 || ttl_seconds > 86_400 {
            return Err(RelayError::BadRequest(
                "ttl_seconds must be between 1 and 86400".to_string(),
            ));
        }

        let now = Utc::now();
        let expires_at = now + Duration::seconds(ttl_seconds as i64);
        let pairing_id = format!("pairing-{}", Uuid::new_v4().simple());
        let pairing_code;
        let daemon_token = format!("daemon-{}", Uuid::new_v4().simple());

        let snapshot = {
            let mut store = self.inner.store.lock().await;
            pairing_code = generate_pairing_code(&store.data);
            store.data.pairings.insert(
                pairing_id.clone(),
                PairingRecord {
                    pairing_id: pairing_id.clone(),
                    pairing_code: pairing_code.clone(),
                    daemon_token: daemon_token.clone(),
                    label: request.label,
                    session_id: None,
                    daemon_bundle: request.daemon_bundle,
                    client_bundle: None,
                    created_at: now,
                    expires_at,
                },
            );
            store.data.clone()
        };

        self.persist(snapshot).await?;

        Ok(StartPairingResponse {
            pairing_id,
            pairing_code,
            daemon_token,
            expires_at,
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

        let now = Utc::now();
        let (response, snapshot) = {
            let mut store = self.inner.store.lock().await;
            let pairing = store
                .data
                .pairings
                .values_mut()
                .find(|pairing| pairing.pairing_code == pairing_code)
                .ok_or_else(|| RelayError::NotFound("pairing not found".to_string()))?;

            if pairing.session_id.is_some() {
                return Err(RelayError::Conflict(
                    "pairing has already been claimed".to_string(),
                ));
            }
            if pairing.expires_at <= now {
                return Err(RelayError::Conflict("pairing has expired".to_string()));
            }

            let session_id = format!("session-{}", Uuid::new_v4().simple());
            let client_token = format!("client-{}", Uuid::new_v4().simple());

            pairing.client_bundle = request.client_bundle;
            if pairing.label.is_none() {
                pairing.label = request.label;
            }
            pairing.session_id = Some(session_id.clone());

            let daemon_bundle = pairing.daemon_bundle.clone();
            let pairing_id = pairing.pairing_id.clone();
            let daemon_token = pairing.daemon_token.clone();

            store.data.sessions.insert(
                session_id.clone(),
                SessionRecord {
                    session_id: session_id.clone(),
                    pairing_id,
                    daemon_token,
                    client_token: client_token.clone(),
                    created_at: now,
                    updated_at: now,
                    updates: Vec::new(),
                },
            );

            (
                ClaimPairingResponse {
                    session_id,
                    client_token,
                    daemon_bundle,
                },
                store.data.clone(),
            )
        };

        self.persist(snapshot).await?;
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
            session_id: pairing.session_id.clone(),
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

        Ok(RelayUpdatesResponse {
            session_id: session.session_id.clone(),
            updates: session
                .updates
                .iter()
                .filter(|update| update.seq > after_seq)
                .cloned()
                .collect(),
            next_seq: session.next_seq(),
        })
    }

    pub async fn authenticate_session(
        &self,
        session_id: &str,
        token: &str,
    ) -> Result<SessionAuth, RelayError> {
        let store = self.inner.store.lock().await;
        let session = store
            .data
            .sessions
            .get(session_id)
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;

        let role = if session.daemon_token == token {
            RelayPeerRole::Daemon
        } else if session.client_token == token {
            RelayPeerRole::Client
        } else {
            return Err(RelayError::Unauthorized(
                "invalid session token".to_string(),
            ));
        };

        Ok(SessionAuth {
            session_id: session_id.to_string(),
            role,
        })
    }

    pub async fn register_peer(
        &self,
        session_id: &str,
        role: RelayPeerRole,
    ) -> Result<
        (
            String,
            mpsc::UnboundedReceiver<RelayServerMessage>,
            RelayServerMessage,
        ),
        RelayError,
    > {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut store = self.inner.store.lock().await;
        let session = store
            .data
            .sessions
            .get(session_id)
            .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
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

    pub async fn unregister_peer(&self, session_id: &str, peer_id: &str) {
        let mut deferred = Vec::new();
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                let removed_role = live.peers.remove(peer_id).map(|peer| peer.role);
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

                if matches!(removed_role, Some(RelayPeerRole::Daemon)) {
                    let failed_request_ids = live.pending_rpc.keys().cloned().collect::<Vec<_>>();
                    for request_id in failed_request_ids {
                        if let Some(pending) = live.pending_rpc.remove(&request_id) {
                            if let Some(requester) = live.peers.get(&pending.requester_peer_id) {
                                deferred.push((
                                    requester.tx.clone(),
                                    RelayServerMessage::RpcResult {
                                        request_id,
                                        ok: false,
                                        result: None,
                                        error: Some("rpc target disconnected".to_string()),
                                    },
                                ));
                            }
                        }
                    }
                }

                if live.peers.is_empty() {
                    store.live_sessions.remove(session_id);
                }
            }
        }

        for (tx, message) in deferred {
            let _ = tx.send(message);
        }
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
                    },
                )
                .await;
            }
            RelayClientMessage::Update { body } => {
                self.append_update(session_id, body).await?;
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
                self.resolve_rpc(session_id, request_id, ok, result, error)
                    .await;
            }
        }

        Ok(())
    }

    async fn append_update(&self, session_id: &str, body: Value) -> Result<(), RelayError> {
        let (update, recipients, snapshot) = {
            let mut store = self.inner.store.lock().await;
            let session = store
                .data
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| RelayError::NotFound("session not found".to_string()))?;
            let update = RelayUpdate {
                id: format!("update-{}", Uuid::new_v4().simple()),
                seq: session.next_seq(),
                body,
                created_at: Utc::now(),
            };
            session.updated_at = update.created_at;
            session.updates.push(update.clone());
            let recipients = store
                .live_sessions
                .get(session_id)
                .map(|live| {
                    live.peers
                        .values()
                        .map(|peer| peer.tx.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (update, recipients, store.data.clone())
        };

        self.persist(snapshot).await?;

        for tx in recipients {
            let _ = tx.send(RelayServerMessage::Update {
                update: update.clone(),
            });
        }

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
            let _ = tx.send(RelayServerMessage::RpcRegistered { method });
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
            let _ = tx.send(RelayServerMessage::RpcUnregistered { method });
        }
    }

    async fn forward_rpc_call(
        &self,
        session_id: &str,
        peer_id: &str,
        request_id: String,
        method: String,
        params: Value,
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
                            tx,
                            RelayServerMessage::RpcResult {
                                request_id: request_id.clone(),
                                ok: false,
                                result: None,
                                error: Some("rpc request_id is already in flight".to_string()),
                            },
                        )
                    });
                } else if let Some(owner_peer_id) = live.rpc_methods.get(&method).cloned() {
                    if let Some(owner) = live.peers.get(&owner_peer_id) {
                        live.pending_rpc.insert(
                            request_id.clone(),
                            PendingRpc {
                                requester_peer_id: peer_id.to_string(),
                            },
                        );
                        target = Some(owner.tx.clone());
                    } else {
                        live.rpc_methods.remove(&method);
                        response = requester.map(|tx| {
                            (
                                tx,
                                RelayServerMessage::RpcResult {
                                    request_id: request_id.clone(),
                                    ok: false,
                                    result: None,
                                    error: Some(format!("rpc method `{method}` is not available")),
                                },
                            )
                        });
                    }
                } else {
                    response = requester.map(|tx| {
                        (
                            tx,
                            RelayServerMessage::RpcResult {
                                request_id: request_id.clone(),
                                ok: false,
                                result: None,
                                error: Some(format!("rpc method `{method}` is not registered")),
                            },
                        )
                    });
                }
            }
        }

        if let Some(tx) = target {
            let _ = tx.send(RelayServerMessage::RpcRequest {
                request_id,
                method,
                params,
            });
        } else if let Some((tx, message)) = response {
            let _ = tx.send(message);
        }
    }

    async fn resolve_rpc(
        &self,
        session_id: &str,
        request_id: String,
        ok: bool,
        result: Option<Value>,
        error: Option<String>,
    ) {
        let mut response = None;
        {
            let mut store = self.inner.store.lock().await;
            if let Some(live) = store.live_sessions.get_mut(session_id) {
                if let Some(pending) = live.pending_rpc.remove(&request_id) {
                    response = live
                        .peers
                        .get(&pending.requester_peer_id)
                        .map(|peer| peer.tx.clone());
                }
            }
        }

        if let Some(tx) = response {
            let _ = tx.send(RelayServerMessage::RpcResult {
                request_id,
                ok,
                result,
                error,
            });
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

        Ok(RelayUpdatesResponse {
            session_id: session_id.to_string(),
            updates: session
                .updates
                .iter()
                .filter(|update| update.seq > after_seq)
                .cloned()
                .collect(),
            next_seq: session.next_seq(),
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
            let _ = tx.send(message);
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
                        .values()
                        .map(|peer| peer.tx.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };

        for tx in recipients {
            let _ = tx.send(message.clone());
        }
    }

    async fn persist(&self, snapshot: PersistedState) -> Result<(), RelayError> {
        persist_state(&self.inner.state_path, &snapshot).await
    }
}

impl PairingRecord {
    fn status(&self) -> PairingStatus {
        if self.session_id.is_some() {
            PairingStatus::Claimed
        } else if self.expires_at <= Utc::now() {
            PairingStatus::Expired
        } else {
            PairingStatus::Pending
        }
    }
}

impl SessionRecord {
    fn next_seq(&self) -> u64 {
        self.updates
            .last()
            .map(|update| update.seq + 1)
            .unwrap_or(1)
    }
}

async fn load_state(path: &Path) -> Result<PersistedState, RelayError> {
    match fs::read_to_string(path).await {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|error| RelayError::StateLoad(error.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PersistedState::default()),
        Err(error) => Err(RelayError::StateLoad(error.to_string())),
    }
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
    for _ in 0..16 {
        let candidate = Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>()
            .to_uppercase();
        if state
            .pairings
            .values()
            .all(|pairing| pairing.pairing_code != candidate)
        {
            return candidate;
        }
    }

    warn!("pairing code generation retried more than expected");
    Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(12)
        .collect::<String>()
        .to_uppercase()
}
