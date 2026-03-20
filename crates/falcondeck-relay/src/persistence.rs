use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::{fs, sync::Mutex, task::JoinHandle};
use tokio_postgres::{Client as PostgresClient, NoTls};
use tracing::warn;

use crate::error::RelayError;

use falcondeck_core::RelayUpdate;

use super::app::{
    PersistedState, PairingRecord, QueuedActionRecord, SessionRecord,
    TrustedDeviceRecord,
};

const FILE_PERSIST_DEBOUNCE_MS: u64 = 150;

// ── Trait ────────────────────────────────────────────────────────────

/// Abstraction over file-based and Postgres-backed relay persistence.
///
/// Granular methods (`persist_pairing`, etc.) are called after each
/// mutation.  The file backend ignores the individual records and
/// schedules a debounced full-state dump; the Postgres backend upserts
/// only the affected rows.
#[async_trait::async_trait]
pub(crate) trait PersistenceBackend: Send + Sync {
    /// Downcast support so AppState can reach FileBackend-specific methods.
    fn as_any(&self) -> &dyn std::any::Any;

    async fn persist_pairing(
        &self,
        session: Option<&SessionRecord>,
        pairing: Option<&PairingRecord>,
    ) -> Result<(), RelayError>;

    async fn persist_device(
        &self,
        session: &SessionRecord,
        device_id: Option<&str>,
    ) -> Result<(), RelayError>;

    async fn persist_action(
        &self,
        session: &SessionRecord,
        action_ids: Option<&[&str]>,
    ) -> Result<(), RelayError>;

    async fn persist_update(
        &self,
        session: &SessionRecord,
        update: &RelayUpdate,
    ) -> Result<(), RelayError>;

    /// Write the entire persisted state (used for pruning, startup
    /// normalization, and the file backend's debounced flush).
    async fn flush_all(&self, state: &PersistedState) -> Result<(), RelayError>;
}

// ── File backend ─────────────────────────────────────────────────────

pub(crate) struct FileBackend {
    state_path: PathBuf,
    persist_lock: Mutex<()>,
    deferred_task: Mutex<Option<DeferredFlush>>,
}

/// Holds the state needed to execute a deferred flush.
struct DeferredFlush {
    handle: JoinHandle<()>,
}

impl FileBackend {
    pub(crate) fn new(state_path: PathBuf) -> Self {
        Self {
            state_path,
            persist_lock: Mutex::new(()),
            deferred_task: Mutex::new(None),
        }
    }

    /// Cancel any pending deferred flush.
    async fn cancel_deferred(&self) {
        let mut task = self.deferred_task.lock().await;
        if let Some(deferred) = task.take() {
            deferred.handle.abort();
        }
    }

    /// Immediately write `state` to disk (atomic tmp + rename).
    async fn write_now(&self, state: &PersistedState) -> Result<(), RelayError> {
        self.cancel_deferred().await;
        let _guard = self.persist_lock.lock().await;
        persist_state_to_file(&self.state_path, state).await
    }
}

#[async_trait::async_trait]
impl PersistenceBackend for FileBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    async fn persist_pairing(
        &self,
        _session: Option<&SessionRecord>,
        _pairing: Option<&PairingRecord>,
    ) -> Result<(), RelayError> {
        // File backend ignores granular changes — AppState will call
        // schedule_flush to trigger a debounced or immediate full dump.
        Ok(())
    }

    async fn persist_device(
        &self,
        _session: &SessionRecord,
        _device_id: Option<&str>,
    ) -> Result<(), RelayError> {
        Ok(())
    }

    async fn persist_action(
        &self,
        _session: &SessionRecord,
        _action_ids: Option<&[&str]>,
    ) -> Result<(), RelayError> {
        Ok(())
    }

    async fn persist_update(
        &self,
        _session: &SessionRecord,
        _update: &RelayUpdate,
    ) -> Result<(), RelayError> {
        Ok(())
    }

    async fn flush_all(&self, state: &PersistedState) -> Result<(), RelayError> {
        self.write_now(state).await
    }
}

impl FileBackend {
    /// Schedule a debounced full-state flush.  Called by `AppState` for
    /// deferred writes.  The `snapshot_fn` is invoked *after* the
    /// debounce delay to capture the latest state.
    pub(crate) async fn schedule_deferred_flush<F>(&self, snapshot_fn: F)
    where
        F: FnOnce() -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<PersistedState, RelayError>> + Send>,
            > + Send
            + 'static,
    {
        let mut task = self.deferred_task.lock().await;
        if let Some(deferred) = task.take() {
            deferred.handle.abort();
        }

        // We need a reference to self for write_now, but we can't move self
        // into the spawned task.  Instead, capture just the path and lock.
        // Since the lock is behind Arc in AppState, we'll handle the actual
        // write in the closure.
        let state_path = self.state_path.clone();
        *task = Some(DeferredFlush {
            handle: tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(FILE_PERSIST_DEBOUNCE_MS))
                    .await;
                if let Ok(snapshot) = snapshot_fn().await {
                    let _ = persist_state_to_file(&state_path, &snapshot).await;
                }
            }),
        });
    }
}

// ── Postgres backend ─────────────────────────────────────────────────

pub(crate) struct PostgresBackend {
    client: Mutex<PostgresClient>,
}

impl PostgresBackend {
    pub(crate) async fn connect(database_url: &str) -> Result<Self, RelayError> {
        let (client, connection) = tokio_postgres::connect(database_url, NoTls)
            .await
            .map_err(|error| RelayError::StateLoad(error.to_string()))?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                warn!("postgres relay connection ended: {error}");
            }
        });
        init_postgres_schema(&client).await?;
        Ok(Self {
            client: Mutex::new(client),
        })
    }
}

#[async_trait::async_trait]
impl PersistenceBackend for PostgresBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    async fn persist_pairing(
        &self,
        session: Option<&SessionRecord>,
        pairing: Option<&PairingRecord>,
    ) -> Result<(), RelayError> {
        let mut client = self.client.lock().await;
        if let Some(session) = session {
            upsert_session(&mut client, session).await?;
        }
        if let Some(pairing) = pairing {
            upsert_pairing(&mut client, pairing).await?;
        }
        Ok(())
    }

    async fn persist_device(
        &self,
        session: &SessionRecord,
        device_id: Option<&str>,
    ) -> Result<(), RelayError> {
        let mut client = self.client.lock().await;
        upsert_session(&mut client, session).await?;
        if let Some(device_id) = device_id {
            if let Some(device) = session.devices.get(device_id) {
                upsert_device(&mut client, &session.session_id, device).await?;
            }
        }
        Ok(())
    }

    async fn persist_action(
        &self,
        session: &SessionRecord,
        action_ids: Option<&[&str]>,
    ) -> Result<(), RelayError> {
        let mut client = self.client.lock().await;
        upsert_session(&mut client, session).await?;
        let actions = if let Some(action_ids) = action_ids {
            action_ids
                .iter()
                .filter_map(|id| session.actions.get(*id))
                .cloned()
                .collect::<Vec<_>>()
        } else {
            session.actions.values().cloned().collect::<Vec<_>>()
        };
        for action in actions {
            upsert_action(&mut client, &action).await?;
        }
        Ok(())
    }

    async fn persist_update(
        &self,
        session: &SessionRecord,
        update: &RelayUpdate,
    ) -> Result<(), RelayError> {
        let mut client = self.client.lock().await;
        upsert_session(&mut client, session).await?;
        upsert_relay_update(&mut client, &session.session_id, update).await?;
        Ok(())
    }

    async fn flush_all(&self, state: &PersistedState) -> Result<(), RelayError> {
        let mut client = self.client.lock().await;
        flush_postgres_state(&mut client, state).await
    }
}

// ── Loading ──────────────────────────────────────────────────────────

pub(crate) async fn load_file_state(path: &Path) -> Result<PersistedState, RelayError> {
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

pub(crate) async fn load_postgres_state(
    backend: &PostgresBackend,
) -> Result<PersistedState, RelayError> {
    let client = backend.client.lock().await;
    load_postgres_state_from_client(&client).await
}

// ── File helpers ─────────────────────────────────────────────────────

async fn persist_state_to_file(path: &Path, state: &PersistedState) -> Result<(), RelayError> {
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

// ── Postgres helpers ─────────────────────────────────────────────────

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

async fn load_postgres_state_from_client(
    client: &PostgresClient,
) -> Result<PersistedState, RelayError> {
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
                devices: std::collections::HashMap::new(),
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
                actions: std::collections::HashMap::new(),
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

async fn upsert_session(
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

async fn upsert_pairing(
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

async fn upsert_device(
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

async fn upsert_relay_update(
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

async fn upsert_action(
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

async fn flush_postgres_state(
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

// ── JSON helpers ─────────────────────────────────────────────────────

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

pub(crate) fn queued_action_status_to_db(
    status: &falcondeck_core::QueuedRemoteActionStatus,
) -> &'static str {
    use falcondeck_core::QueuedRemoteActionStatus;
    match status {
        QueuedRemoteActionStatus::Queued => "queued",
        QueuedRemoteActionStatus::Dispatched => "dispatched",
        QueuedRemoteActionStatus::Executing => "executing",
        QueuedRemoteActionStatus::Completed => "completed",
        QueuedRemoteActionStatus::Failed => "failed",
    }
}

pub(crate) fn queued_action_status_from_db(
    value: &str,
) -> Result<falcondeck_core::QueuedRemoteActionStatus, RelayError> {
    use falcondeck_core::QueuedRemoteActionStatus;
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
