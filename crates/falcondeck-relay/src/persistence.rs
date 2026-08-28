use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt, sync::Mutex, task::JoinHandle};
use tokio_postgres::{Client as PostgresClient, Config as PostgresConfig, NoTls, config::Host};
use tracing::warn;

use crate::error::RelayError;

use falcondeck_core::RelayUpdate;

use super::app::{
    PairingRecord, PersistedState, QueuedActionRecord, RetentionConfig, SessionMeta, SessionRecord,
    TrustedDeviceRecord,
};

const FILE_PERSIST_DEBOUNCE_MS: u64 = 150;
/// Upper bound on how long deferred persist requests may coalesce: the
/// debounce timer resets on every request, so sustained update traffic
/// would otherwise starve persistence forever.
const FILE_PERSIST_MAX_DEBOUNCE_MS: u64 = 1_000;

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
        session: Option<&SessionMeta>,
        pairing: Option<&PairingRecord>,
    ) -> Result<(), RelayError>;

    async fn persist_device(
        &self,
        session: &SessionMeta,
        device: Option<&TrustedDeviceRecord>,
    ) -> Result<(), RelayError>;

    async fn persist_action(
        &self,
        session: &SessionMeta,
        actions: &[QueuedActionRecord],
    ) -> Result<(), RelayError>;

    async fn persist_update(
        &self,
        session: &SessionMeta,
        update: &RelayUpdate,
    ) -> Result<(), RelayError>;

    /// Delete specific update rows (e.g. superseded presence snapshots).
    async fn remove_updates(
        &self,
        session_id: &str,
        update_ids: &[String],
    ) -> Result<(), RelayError>;

    /// Delete update rows older than the oldest retained sequence.
    async fn prune_updates(
        &self,
        session_id: &str,
        oldest_retained_seq: u64,
    ) -> Result<(), RelayError>;

    /// Delete a trusted device row outright (purge of a revoked device).
    async fn remove_device(&self, session_id: &str, device_id: &str) -> Result<(), RelayError>;

    /// Delete sessions by id (dependent rows cascade).
    async fn remove_sessions(&self, session_ids: &[String]) -> Result<(), RelayError>;

    /// Delete pairings by id.
    async fn remove_pairings(&self, pairing_ids: &[String]) -> Result<(), RelayError>;

    /// Delete queued actions by id.
    async fn remove_actions(&self, action_ids: &[String]) -> Result<(), RelayError>;

    /// Write the entire persisted state (used for pruning, startup
    /// normalization, and the file backend's debounced flush).
    async fn flush_all(&self, state: &PersistedState) -> Result<(), RelayError>;
}

// ── File backend ─────────────────────────────────────────────────────

pub(crate) struct FileBackend {
    state_path: PathBuf,
    /// Serializes all writes to the state file, including those made by the
    /// spawned deferred-flush task.
    persist_lock: std::sync::Arc<Mutex<()>>,
    deferred_task: Mutex<Option<DeferredFlush>>,
}

/// Holds the state needed to execute a deferred flush.
struct DeferredFlush {
    handle: JoinHandle<()>,
    /// When the oldest un-flushed deferred request was made, used to cap
    /// how long back-to-back requests can keep resetting the debounce.
    first_requested_at: tokio::time::Instant,
}

impl FileBackend {
    pub(crate) fn new(state_path: PathBuf) -> Self {
        Self {
            state_path,
            persist_lock: std::sync::Arc::new(Mutex::new(())),
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
        _session: Option<&SessionMeta>,
        _pairing: Option<&PairingRecord>,
    ) -> Result<(), RelayError> {
        // File backend ignores granular changes — AppState will call
        // schedule_flush to trigger a debounced or immediate full dump.
        Ok(())
    }

    async fn persist_device(
        &self,
        _session: &SessionMeta,
        _device: Option<&TrustedDeviceRecord>,
    ) -> Result<(), RelayError> {
        Ok(())
    }

    async fn remove_device(&self, _session_id: &str, _device_id: &str) -> Result<(), RelayError> {
        // Covered by the full-state flush, same as other granular changes.
        Ok(())
    }

    async fn persist_action(
        &self,
        _session: &SessionMeta,
        _actions: &[QueuedActionRecord],
    ) -> Result<(), RelayError> {
        Ok(())
    }

    async fn persist_update(
        &self,
        _session: &SessionMeta,
        _update: &RelayUpdate,
    ) -> Result<(), RelayError> {
        Ok(())
    }

    async fn remove_updates(
        &self,
        _session_id: &str,
        _update_ids: &[String],
    ) -> Result<(), RelayError> {
        Ok(())
    }

    async fn prune_updates(
        &self,
        _session_id: &str,
        _oldest_retained_seq: u64,
    ) -> Result<(), RelayError> {
        Ok(())
    }

    async fn remove_sessions(&self, _session_ids: &[String]) -> Result<(), RelayError> {
        Ok(())
    }

    async fn remove_pairings(&self, _pairing_ids: &[String]) -> Result<(), RelayError> {
        Ok(())
    }

    async fn remove_actions(&self, _action_ids: &[String]) -> Result<(), RelayError> {
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
        let first_requested_at = match task.take() {
            // Carry the pending request's age forward so resets cannot
            // starve persistence; a finished handle means its flush already
            // ran, so the age window starts over.
            Some(deferred) if !deferred.handle.is_finished() => {
                deferred.handle.abort();
                deferred.first_requested_at
            }
            _ => tokio::time::Instant::now(),
        };
        let deadline = (tokio::time::Instant::now()
            + std::time::Duration::from_millis(FILE_PERSIST_DEBOUNCE_MS))
        .min(first_requested_at + std::time::Duration::from_millis(FILE_PERSIST_MAX_DEBOUNCE_MS));

        let state_path = self.state_path.clone();
        let persist_lock = std::sync::Arc::clone(&self.persist_lock);
        *task = Some(DeferredFlush {
            first_requested_at,
            handle: tokio::spawn(async move {
                tokio::time::sleep_until(deadline).await;
                // Hold the persist lock across the write so the deferred
                // task cannot race an immediate flush on the same file.
                let _guard = persist_lock.lock().await;
                if let Ok(snapshot) = snapshot_fn().await {
                    let _ = persist_state_to_file(&state_path, &snapshot).await;
                }
            }),
        });
    }
}

// ── Postgres backend ─────────────────────────────────────────────────

pub(crate) struct PostgresBackend {
    /// Kept so a dropped connection can be re-established: PostgreSQL
    /// restarts (package upgrades, operator restarts) otherwise wedge the
    /// relay into failing every write with "connection closed" until the
    /// relay process itself is restarted.
    database_url: String,
    client: Mutex<PostgresClient>,
    /// Bumped every time a connection is re-established. Writes attempted
    /// while the connection was down never reached PostgreSQL, so the
    /// in-memory state has to be flushed wholesale before the stored rows
    /// are trustworthy again.
    reconnect_epoch: AtomicU64,
    /// Highest reconnect epoch a caller has already re-flushed.
    resynced_epoch: AtomicU64,
}

/// Run statements against a live client, reconnecting and retrying once if
/// the connection died underneath them. A closure-based helper would have to
/// quantify the client borrow with a higher-ranked bound, which then rejects
/// the request-scoped references the bodies also capture.
macro_rules! with_reconnect {
    ($backend:expr, |$client:ident| $body:block) => {{
        let backend = $backend;
        let mut guard = backend.locked_client().await?;
        let outcome = {
            let $client = &mut *guard;
            async move { $body }.await
        };
        match outcome {
            Err(error) if connection_lost(&guard, &error).await => {
                warn!("postgres relay connection lost mid-statement: {error}; reconnecting");
                *guard = connect_postgres_client(&backend.database_url).await?;
                backend.reconnect_epoch.fetch_add(1, Ordering::SeqCst);
                let $client = &mut *guard;
                async move { $body }.await
            }
            outcome => outcome,
        }
    }};
}

impl PostgresBackend {
    pub(crate) async fn connect(database_url: &str) -> Result<Self, RelayError> {
        require_local_postgres_without_tls(database_url)?;
        let client = connect_postgres_client(database_url).await?;
        init_postgres_schema(&client).await?;
        Ok(Self {
            database_url: database_url.to_string(),
            client: Mutex::new(client),
            reconnect_epoch: AtomicU64::new(0),
            resynced_epoch: AtomicU64::new(0),
        })
    }

    /// The reconnect epoch still awaiting a full re-flush, if any. Callers
    /// that hold the authoritative in-memory state use this to repair
    /// everything an outage dropped.
    pub(crate) fn pending_resync_epoch(&self) -> Option<u64> {
        let epoch = self.reconnect_epoch.load(Ordering::SeqCst);
        (epoch > self.resynced_epoch.load(Ordering::SeqCst)).then_some(epoch)
    }

    /// Record that the state was re-flushed for `epoch`. A reconnect that
    /// happened during the flush bumps the epoch past this one and so stays
    /// pending.
    pub(crate) fn mark_resynced(&self, epoch: u64) {
        self.resynced_epoch.fetch_max(epoch, Ordering::SeqCst);
    }

    /// Lock the client, replacing it first if its connection task has ended.
    async fn locked_client(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, PostgresClient>, RelayError> {
        let mut guard = self.client.lock().await;
        if guard.is_closed() {
            warn!("postgres relay connection is closed; reconnecting");
            *guard = connect_postgres_client(&self.database_url).await?;
            self.reconnect_epoch.fetch_add(1, Ordering::SeqCst);
        }
        Ok(guard)
    }

    /// Enforce replay retention before rows are decoded into memory. The
    /// retained window is always a contiguous sequence suffix, so deleting a
    /// prefix and advancing `oldest_lost_seq` preserves truncation recovery.
    pub(crate) async fn prune_updates_before_load(
        &self,
        retention: &RetentionConfig,
        now: DateTime<Utc>,
    ) -> Result<u64, RelayError> {
        let update_cutoff = now
            .checked_sub_signed(retention.update_retention)
            .unwrap_or(DateTime::<Utc>::MIN_UTC);
        let max_updates = i64::try_from(retention.max_updates_per_session).unwrap_or(i64::MAX);
        let max_bytes = i64::try_from(retention.max_update_bytes_per_session).unwrap_or(i64::MAX);
        let client = self.locked_client().await?;
        let deleted = client
            .execute(
                r"
                WITH ranked AS (
                    SELECT
                        session_id,
                        seq,
                        ROW_NUMBER() OVER (
                            PARTITION BY session_id ORDER BY seq DESC
                        ) AS reverse_rank,
                        -- pg_column_size returns integer, whose SUM is bigint.
                        -- Casting each input to bigint would make SUM return
                        -- numeric and reject the driver's i64 byte limit.
                        SUM(pg_column_size(body)) OVER (
                            PARTITION BY session_id
                            ORDER BY seq DESC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                        ) AS newer_bytes,
                        MAX(seq) FILTER (WHERE created_at < $1) OVER (
                            PARTITION BY session_id
                        ) AS age_cutoff_seq
                    FROM relay_updates
                ),
                cutoffs AS (
                    SELECT session_id, MAX(seq) AS highest_pruned_seq
                    FROM ranked
                    WHERE seq <= COALESCE(age_cutoff_seq, 0)
                       OR reverse_rank > $2
                       OR (newer_bytes > $3 AND reverse_rank > 1)
                    GROUP BY session_id
                ),
                updated_sessions AS (
                    UPDATE relay_sessions AS session
                    SET oldest_lost_seq = GREATEST(
                        session.oldest_lost_seq,
                        cutoffs.highest_pruned_seq + 1
                    )
                    FROM cutoffs
                    WHERE session.session_id = cutoffs.session_id
                    RETURNING session.session_id
                )
                DELETE FROM relay_updates AS target
                USING cutoffs
                WHERE target.session_id = cutoffs.session_id
                  AND target.seq <= cutoffs.highest_pruned_seq
                  AND EXISTS (
                      SELECT 1 FROM updated_sessions
                      WHERE updated_sessions.session_id = target.session_id
                  )
                ",
                &[&update_cutoff, &max_updates, &max_bytes],
            )
            .await
            .map_err(|error| {
                RelayError::StateLoad(format!(
                    "failed to prune replay before loading Postgres state: {error}"
                ))
            })?;
        if deleted > 0 {
            warn!(deleted, "pruned retained replay before loading relay state");
        }
        Ok(deleted)
    }
}

/// How long a failed statement waits for the client to admit its connection
/// died before the failure is treated as an ordinary query error.
const CONNECTION_LOSS_SETTLE: Duration = Duration::from_millis(100);

/// Whether a failed statement lost its connection rather than hitting a query
/// error. A server-side termination (PostgreSQL restart, `pg_terminate_backend`)
/// surfaces on the statement as an opaque db error, and the client only reports
/// `is_closed` once its background connection task has processed the shutdown —
/// so give that task a moment to settle instead of mistaking a dead connection
/// for a rejected statement.
async fn connection_lost(client: &PostgresClient, error: &RelayError) -> bool {
    if client.is_closed() || error.to_string().contains("connection closed") {
        return true;
    }
    let deadline = tokio::time::Instant::now() + CONNECTION_LOSS_SETTLE;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(5)).await;
        if client.is_closed() {
            return true;
        }
    }
    false
}

/// Open a client and drive its connection task in the background.
async fn connect_postgres_client(database_url: &str) -> Result<PostgresClient, RelayError> {
    let (client, connection) = tokio_postgres::connect(database_url, NoTls)
        .await
        .map_err(|error| RelayError::StateLoad(error.to_string()))?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            warn!("postgres relay connection ended: {error}");
        }
    });
    Ok(client)
}

/// `NoTls` is only safe for a local database connection. Refuse a remote
/// database rather than silently sending relay credentials and replay data in
/// cleartext. TLS support can be added later without weakening this default.
fn require_local_postgres_without_tls(database_url: &str) -> Result<(), RelayError> {
    let config: PostgresConfig = database_url
        .parse()
        .map_err(|error| RelayError::StateLoad(format!("invalid PostgreSQL URL: {error}")))?;
    let is_local = config.get_hosts().iter().all(|host| match host {
        Host::Unix(_) => true,
        Host::Tcp(host) => {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        }
    });
    if is_local {
        Ok(())
    } else {
        Err(RelayError::StateLoad(
            "remote PostgreSQL connections require TLS; configure a local/Unix-socket database or add TLS support"
                .to_string(),
        ))
    }
}

#[async_trait::async_trait]
impl PersistenceBackend for PostgresBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    async fn persist_pairing(
        &self,
        session: Option<&SessionMeta>,
        pairing: Option<&PairingRecord>,
    ) -> Result<(), RelayError> {
        with_reconnect!(self, |client| {
            if let Some(session) = session {
                upsert_session(client, session).await?;
            }
            if let Some(pairing) = pairing {
                upsert_pairing(client, pairing).await?;
            }
            Ok(())
        })
    }

    async fn persist_device(
        &self,
        session: &SessionMeta,
        device: Option<&TrustedDeviceRecord>,
    ) -> Result<(), RelayError> {
        with_reconnect!(self, |client| {
            upsert_session(client, session).await?;
            if let Some(device) = device {
                upsert_device(client, &session.session_id, device).await?;
            }
            Ok(())
        })
    }

    async fn remove_device(&self, session_id: &str, device_id: &str) -> Result<(), RelayError> {
        with_reconnect!(self, |client| {
            client
                .execute(
                    "DELETE FROM relay_devices WHERE session_id = $1 AND device_id = $2",
                    &[&session_id, &device_id],
                )
                .await
                .map_err(|error| {
                    RelayError::StatePersist(format!("failed to delete device: {error}"))
                })?;
            Ok(())
        })
    }

    async fn persist_action(
        &self,
        session: &SessionMeta,
        actions: &[QueuedActionRecord],
    ) -> Result<(), RelayError> {
        with_reconnect!(self, |client| {
            upsert_session(client, session).await?;
            upsert_actions_batch(client, actions).await?;
            Ok(())
        })
    }

    async fn persist_update(
        &self,
        session: &SessionMeta,
        update: &RelayUpdate,
    ) -> Result<(), RelayError> {
        with_reconnect!(self, |client| {
            upsert_session(client, session).await?;
            upsert_relay_update(client, &session.session_id, update).await?;
            Ok(())
        })
    }

    async fn remove_updates(
        &self,
        session_id: &str,
        update_ids: &[String],
    ) -> Result<(), RelayError> {
        if update_ids.is_empty() {
            return Ok(());
        }
        with_reconnect!(self, |client| {
            client
                .execute(
                    "DELETE FROM relay_updates WHERE session_id = $1 AND update_id = ANY($2)",
                    &[&session_id, &update_ids],
                )
                .await
                .map_err(|error| RelayError::StatePersist(error.to_string()))?;
            Ok(())
        })
    }

    async fn prune_updates(
        &self,
        session_id: &str,
        oldest_retained_seq: u64,
    ) -> Result<(), RelayError> {
        let oldest = i64::try_from(oldest_retained_seq)
            .map_err(|_| RelayError::StatePersist("update sequence overflow".to_string()))?;
        with_reconnect!(self, |client| {
            client
                .execute(
                    "DELETE FROM relay_updates WHERE session_id = $1 AND seq < $2",
                    &[&session_id, &oldest],
                )
                .await
                .map_err(|error| RelayError::StatePersist(error.to_string()))?;
            Ok(())
        })
    }

    async fn remove_sessions(&self, session_ids: &[String]) -> Result<(), RelayError> {
        if session_ids.is_empty() {
            return Ok(());
        }
        // Devices, updates, actions, and pairings cascade on delete.
        with_reconnect!(self, |client| {
            client
                .execute(
                    "DELETE FROM relay_sessions WHERE session_id = ANY($1)",
                    &[&session_ids],
                )
                .await
                .map_err(|error| RelayError::StatePersist(error.to_string()))?;
            Ok(())
        })
    }

    async fn remove_pairings(&self, pairing_ids: &[String]) -> Result<(), RelayError> {
        if pairing_ids.is_empty() {
            return Ok(());
        }
        with_reconnect!(self, |client| {
            client
                .execute(
                    "DELETE FROM relay_pairings WHERE pairing_id = ANY($1)",
                    &[&pairing_ids],
                )
                .await
                .map_err(|error| RelayError::StatePersist(error.to_string()))?;
            Ok(())
        })
    }

    async fn remove_actions(&self, action_ids: &[String]) -> Result<(), RelayError> {
        if action_ids.is_empty() {
            return Ok(());
        }
        with_reconnect!(self, |client| {
            client
                .execute(
                    "DELETE FROM relay_actions WHERE action_id = ANY($1)",
                    &[&action_ids],
                )
                .await
                .map_err(|error| RelayError::StatePersist(error.to_string()))?;
            Ok(())
        })
    }

    async fn flush_all(&self, state: &PersistedState) -> Result<(), RelayError> {
        with_reconnect!(self, |client| { flush_postgres_state(client, state).await })
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
    let client = backend.locked_client().await?;
    load_postgres_state_from_client(&client).await
}

// ── File helpers ─────────────────────────────────────────────────────

async fn persist_state_to_file(path: &Path, state: &PersistedState) -> Result<(), RelayError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|error| RelayError::StatePersist(error.to_string()))?;
    }
    // Unique tmp name per write: concurrent writers sharing one tmp path
    // can tear each other's files or rename a partial write into place.
    let tmp_path = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    // Compact JSON: the file backend rewrites the entire state (every
    // session's retained replay) per flush, so pretty-printing doubled both
    // the serialized bytes and the fsync window for no benefit — this file is
    // only ever machine-read.
    let json =
        serde_json::to_vec(state).map_err(|error| RelayError::StatePersist(error.to_string()))?;
    let result = async {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let mut file = options.open(&tmp_path).await?;
        file.write_all(&json).await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(&tmp_path, path).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
            // Make the rename durable too. Syncing only the file contents can
            // still lose the directory entry if the host crashes immediately
            // after the atomic replacement.
            if let Some(parent) = path.parent() {
                fs::File::open(parent).await?.sync_all().await?;
            }
        }
        Ok::<(), std::io::Error>(())
    }
    .await;
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(RelayError::StatePersist(error.to_string()));
    }
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
                next_seq BIGINT NOT NULL DEFAULT 1,
                oldest_lost_seq BIGINT NOT NULL DEFAULT 0
            );
            ALTER TABLE relay_sessions
                ADD COLUMN IF NOT EXISTS next_seq BIGINT NOT NULL DEFAULT 1;
            ALTER TABLE relay_sessions
                ADD COLUMN IF NOT EXISTS oldest_lost_seq BIGINT NOT NULL DEFAULT 0;
            CREATE TABLE IF NOT EXISTS relay_pairings (
                pairing_id TEXT PRIMARY KEY,
                pairing_code TEXT NOT NULL UNIQUE,
                daemon_token TEXT NOT NULL,
                label TEXT NULL,
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                device_id TEXT NULL,
                daemon_bundle JSONB NULL,
                client_bundle JSONB NULL,
                pairing_authority JSONB NULL,
                claim_challenge TEXT NULL,
                pairing_authority_signature TEXT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL
            );
            ALTER TABLE relay_pairings ADD COLUMN IF NOT EXISTS pairing_authority JSONB NULL;
            ALTER TABLE relay_pairings ADD COLUMN IF NOT EXISTS claim_challenge TEXT NULL;
            ALTER TABLE relay_pairings ADD COLUMN IF NOT EXISTS pairing_authority_signature TEXT NULL;
            CREATE TABLE IF NOT EXISTS relay_devices (
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                client_token TEXT NOT NULL UNIQUE,
                label TEXT NULL,
                public_key TEXT NULL,
                identity_public_key TEXT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                last_seen_at TIMESTAMPTZ NULL,
                revoked_at TIMESTAMPTZ NULL,
                push_token TEXT NULL,
                PRIMARY KEY (session_id, device_id)
            );
            ALTER TABLE relay_devices ADD COLUMN IF NOT EXISTS push_token TEXT NULL;
            ALTER TABLE relay_devices ADD COLUMN IF NOT EXISTS identity_public_key TEXT NULL;
            CREATE TABLE IF NOT EXISTS relay_updates (
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                seq BIGINT NOT NULL,
                update_id TEXT NOT NULL UNIQUE,
                body JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                PRIMARY KEY (session_id, seq)
            );
            -- Backfill next_seq for rows that predate the column: sequence
            -- numbers must never be reused after pruning, so derive at least
            -- MAX(seq) + 1 from the retained updates.
            UPDATE relay_sessions SET next_seq = GREATEST(
                next_seq,
                (SELECT COALESCE(MAX(seq) + 1, 1) FROM relay_updates u
                 WHERE u.session_id = relay_sessions.session_id)
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
            "SELECT session_id, pairing_id, daemon_token, daemon_last_seen_at, created_at, updated_at, next_seq, oldest_lost_seq FROM relay_sessions",
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
                oldest_lost_seq: row
                    .get::<_, i64>("oldest_lost_seq")
                    .try_into()
                    .map_err(|_| RelayError::StateLoad("invalid lost sequence".to_string()))?,
                updates: Vec::new(),
                actions: std::collections::HashMap::new(),
            },
        );
    }

    for row in client
        .query(
            "SELECT session_id, device_id, client_token, label, public_key, identity_public_key, created_at, last_seen_at, revoked_at, push_token FROM relay_devices ORDER BY created_at ASC",
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
                identity_public_key: row.get("identity_public_key"),
                created_at: row.get("created_at"),
                last_seen_at: row.get("last_seen_at"),
                revoked_at: row.get("revoked_at"),
                push_token: row.get("push_token"),
            };
            session.devices.insert(device.device_id.clone(), device);
        }
    }

    for row in client
        .query(
            "SELECT pairing_id, pairing_code, daemon_token, label, session_id, device_id, daemon_bundle, client_bundle, pairing_authority, claim_challenge, pairing_authority_signature, created_at, expires_at FROM relay_pairings",
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
            pairing_authority: decode_optional_json_field(row.get("pairing_authority"))?,
            claim_challenge: row.get("claim_challenge"),
            pairing_authority_signature: row.get("pairing_authority_signature"),
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
    session: &SessionMeta,
) -> Result<(), RelayError> {
    client
        .execute(
            // Concurrent writers can upsert from stale SessionMeta
            // snapshots; GREATEST/LEAST keep the timestamps and sequence
            // watermarks monotonic (both skip NULLs in Postgres).
            "INSERT INTO relay_sessions (session_id, pairing_id, daemon_token, daemon_last_seen_at, created_at, updated_at, next_seq, oldest_lost_seq)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (session_id) DO UPDATE SET
               pairing_id = EXCLUDED.pairing_id,
               daemon_token = EXCLUDED.daemon_token,
               daemon_last_seen_at = GREATEST(relay_sessions.daemon_last_seen_at, EXCLUDED.daemon_last_seen_at),
               created_at = LEAST(relay_sessions.created_at, EXCLUDED.created_at),
               updated_at = GREATEST(relay_sessions.updated_at, EXCLUDED.updated_at),
               next_seq = GREATEST(relay_sessions.next_seq, EXCLUDED.next_seq),
               oldest_lost_seq = GREATEST(relay_sessions.oldest_lost_seq, EXCLUDED.oldest_lost_seq)",
            &[
                &session.session_id,
                &session.pairing_id,
                &session.daemon_token,
                &session.daemon_last_seen_at,
                &session.created_at,
                &session.updated_at,
                &i64::try_from(session.next_seq)
                    .map_err(|_| RelayError::StatePersist("next sequence overflow".to_string()))?,
                &i64::try_from(session.oldest_lost_seq)
                    .map_err(|_| RelayError::StatePersist("lost sequence overflow".to_string()))?,
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
            "INSERT INTO relay_pairings (pairing_id, pairing_code, daemon_token, label, session_id, device_id, daemon_bundle, client_bundle, pairing_authority, claim_challenge, pairing_authority_signature, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (pairing_id) DO UPDATE SET
               pairing_code = EXCLUDED.pairing_code,
               daemon_token = EXCLUDED.daemon_token,
               label = EXCLUDED.label,
               session_id = EXCLUDED.session_id,
               device_id = EXCLUDED.device_id,
               daemon_bundle = EXCLUDED.daemon_bundle,
               client_bundle = EXCLUDED.client_bundle,
               pairing_authority = EXCLUDED.pairing_authority,
               claim_challenge = EXCLUDED.claim_challenge,
               pairing_authority_signature = EXCLUDED.pairing_authority_signature,
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
                &encode_optional_json_field(pairing.pairing_authority.as_ref())?,
                &pairing.claim_challenge,
                &pairing.pairing_authority_signature,
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
            "INSERT INTO relay_devices (session_id, device_id, client_token, label, public_key, identity_public_key, created_at, last_seen_at, revoked_at, push_token)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (session_id, device_id) DO UPDATE SET
               client_token = EXCLUDED.client_token,
               label = EXCLUDED.label,
               public_key = EXCLUDED.public_key,
               identity_public_key = EXCLUDED.identity_public_key,
               created_at = EXCLUDED.created_at,
               last_seen_at = EXCLUDED.last_seen_at,
               revoked_at = EXCLUDED.revoked_at,
               push_token = EXCLUDED.push_token",
            &[
                &session_id,
                &device.device_id,
                &device.client_token,
                &device.label,
                &device.public_key,
                &device.identity_public_key,
                &device.created_at,
                &device.last_seen_at,
                &device.revoked_at,
                &device.push_token,
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

/// One statement for the whole dispatch batch: action persistence used to
/// issue one round trip per record, and a full dispatch pass can carry 64
/// actions, which serialized the single shared connection on per-row latency.
async fn upsert_actions_batch(
    client: &mut PostgresClient,
    actions: &[QueuedActionRecord],
) -> Result<(), RelayError> {
    if actions.is_empty() {
        return Ok(());
    }
    let action_ids: Vec<&str> = actions.iter().map(|a| a.action_id.as_str()).collect();
    let session_ids: Vec<&str> = actions.iter().map(|a| a.session_id.as_str()).collect();
    let device_ids: Vec<&str> = actions.iter().map(|a| a.device_id.as_str()).collect();
    let action_types: Vec<&str> = actions.iter().map(|a| a.action_type.as_str()).collect();
    let idempotency_keys: Vec<&str> = actions.iter().map(|a| a.idempotency_key.as_str()).collect();
    let mut payloads = Vec::with_capacity(actions.len());
    for action in actions {
        payloads.push(encode_json_field(&action.payload)?);
    }
    let statuses: Vec<&'static str> = actions
        .iter()
        .map(|a| queued_action_status_to_db(&a.status))
        .collect();
    let created_at: Vec<DateTime<Utc>> = actions.iter().map(|a| a.created_at).collect();
    let updated_at: Vec<DateTime<Utc>> = actions.iter().map(|a| a.updated_at).collect();
    let errors: Vec<Option<&str>> = actions.iter().map(|a| a.error.as_deref()).collect();
    let mut results = Vec::with_capacity(actions.len());
    for action in actions {
        results.push(encode_optional_json_field(action.result.as_ref())?);
    }

    client
        .execute(
            "INSERT INTO relay_actions (action_id, session_id, device_id, action_type, idempotency_key, payload, status, created_at, updated_at, error, result)
             SELECT action_id, session_id, device_id, action_type, idempotency_key,
                    payload::jsonb, status, created_at, updated_at, error, result::jsonb
             FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamptz[], $9::timestamptz[], $10::text[], $11::text[])
             AS t(action_id, session_id, device_id, action_type, idempotency_key, payload, status, created_at, updated_at, error, result)
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
                &action_ids,
                &session_ids,
                &device_ids,
                &action_types,
                &idempotency_keys,
                &payloads,
                &statuses,
                &created_at,
                &updated_at,
                &errors,
                &results,
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
            "INSERT INTO relay_sessions (session_id, pairing_id, daemon_token, daemon_last_seen_at, created_at, updated_at, next_seq, oldest_lost_seq)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            &[
                &session.session_id,
                &session.pairing_id,
                &session.daemon_token,
                &session.daemon_last_seen_at,
                &session.created_at,
                &session.updated_at,
                &i64::try_from(session.next_seq)
                    .map_err(|_| RelayError::StatePersist("next sequence overflow".to_string()))?,
                &i64::try_from(session.oldest_lost_seq)
                    .map_err(|_| RelayError::StatePersist("lost sequence overflow".to_string()))?,
            ],
        )
        .await
        .map_err(|error| RelayError::StatePersist(error.to_string()))?;

        for device in session.devices.values() {
            tx.execute(
                "INSERT INTO relay_devices (session_id, device_id, client_token, label, public_key, identity_public_key, created_at, last_seen_at, revoked_at, push_token)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
                &[
                    &session.session_id,
                    &device.device_id,
                    &device.client_token,
                    &device.label,
                    &device.public_key,
                    &device.identity_public_key,
                    &device.created_at,
                    &device.last_seen_at,
                    &device.revoked_at,
                    &device.push_token,
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
            "INSERT INTO relay_pairings (pairing_id, pairing_code, daemon_token, label, session_id, device_id, daemon_bundle, client_bundle, pairing_authority, claim_challenge, pairing_authority_signature, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
            &[
                &pairing.pairing_id,
                &pairing.pairing_code,
                &pairing.daemon_token,
                &pairing.label,
                &pairing.session_id,
                &pairing.device_id,
                &encode_optional_json_field(pairing.daemon_bundle.as_ref())?,
                &encode_optional_json_field(pairing.client_bundle.as_ref())?,
                &encode_optional_json_field(pairing.pairing_authority.as_ref())?,
                &pairing.claim_challenge,
                &pairing.pairing_authority_signature,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_tls_postgres_accepts_only_local_hosts() {
        for url in [
            "postgresql://relay@localhost/falcondeck",
            "postgresql://relay@127.0.0.1/falcondeck",
            "postgresql://relay@[::1]/falcondeck",
            "host=/var/run/postgresql dbname=falcondeck user=relay",
        ] {
            require_local_postgres_without_tls(url).unwrap_or_else(|error| {
                panic!("expected local URL to be accepted ({url}): {error}")
            });
        }
    }

    #[test]
    fn no_tls_postgres_rejects_remote_hosts() {
        for url in [
            "postgresql://relay@db.example.com/falcondeck",
            "postgresql://relay@192.0.2.10/falcondeck",
        ] {
            let error = require_local_postgres_without_tls(url)
                .expect_err("remote NoTls PostgreSQL must be rejected");
            assert!(error.to_string().contains("require TLS"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_state_is_always_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("relay-state.json");
        fs::write(&path, b"stale").await.expect("seed state file");
        fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .await
            .expect("make seeded state permissive");

        persist_state_to_file(&path, &PersistedState::default())
            .await
            .expect("persist state");

        let mode = fs::metadata(&path)
            .await
            .expect("state metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    /// A PostgreSQL restart used to wedge the relay permanently: the single
    /// client was never replaced, so every later write failed with
    /// "connection closed" until the relay process itself restarted.
    #[tokio::test]
    #[ignore = "set FALCONDECK_RELAY_TEST_DATABASE_URL to run the PostgreSQL integration test"]
    async fn postgres_backend_reconnects_after_the_connection_drops() {
        let database_url = std::env::var("FALCONDECK_RELAY_TEST_DATABASE_URL")
            .expect("FALCONDECK_RELAY_TEST_DATABASE_URL is required");
        let backend = PostgresBackend::connect(&database_url)
            .await
            .expect("connect relay PostgreSQL backend");

        let now = Utc::now();
        let session = SessionMeta {
            session_id: format!("reconnect-{}", uuid::Uuid::new_v4().simple()),
            pairing_id: "reconnect-pairing".to_string(),
            daemon_token: "reconnect-token".to_string(),
            daemon_last_seen_at: None,
            created_at: now,
            updated_at: now,
            next_seq: 1,
            oldest_lost_seq: 0,
        };
        backend
            .persist_pairing(Some(&session), None)
            .await
            .expect("persist session before the connection drops");
        assert_eq!(backend.pending_resync_epoch(), None);

        let backend_pid: i32 = {
            let client = backend.client.lock().await;
            client
                .query_one("SELECT pg_backend_pid()", &[])
                .await
                .expect("read backend pid")
                .get(0)
        };
        let (killer, connection) = tokio_postgres::connect(&database_url, NoTls)
            .await
            .expect("connect killer session");
        let killer_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        killer
            .query("SELECT pg_terminate_backend($1)", &[&backend_pid])
            .await
            .expect("terminate the relay backend connection");

        backend
            .persist_pairing(Some(&session), None)
            .await
            .expect("persist session after the connection drops");
        assert!(
            backend.pending_resync_epoch().is_some(),
            "a reconnect must ask the caller to re-flush state lost during the outage"
        );

        {
            let client = backend.client.lock().await;
            let stored: i64 = client
                .query_one(
                    "SELECT COUNT(*) FROM relay_sessions WHERE session_id = $1",
                    &[&session.session_id],
                )
                .await
                .expect("count persisted session")
                .get(0);
            assert_eq!(stored, 1);
            client
                .execute(
                    "DELETE FROM relay_sessions WHERE session_id = $1",
                    &[&session.session_id],
                )
                .await
                .expect("clean up persisted session");
        }

        drop(killer);
        let _ = killer_task.await;
    }

    /// This test uses temporary tables on an explicitly supplied PostgreSQL
    /// instance so it exercises PostgreSQL's real parser and window/CTE
    /// semantics without touching durable schemas or rows.
    #[tokio::test]
    #[ignore = "set FALCONDECK_RELAY_TEST_DATABASE_URL to run the PostgreSQL integration test"]
    async fn postgres_preload_prune_enforces_age_count_and_byte_bounds() {
        let database_url = std::env::var("FALCONDECK_RELAY_TEST_DATABASE_URL")
            .expect("FALCONDECK_RELAY_TEST_DATABASE_URL is required");
        let (client, connection) = tokio_postgres::connect(&database_url, NoTls)
            .await
            .expect("connect to test PostgreSQL");
        let connection_task = tokio::spawn(async move {
            connection.await.expect("test PostgreSQL connection");
        });

        client
            .batch_execute(
                r"
                CREATE TEMP TABLE relay_sessions (
                    session_id TEXT PRIMARY KEY,
                    oldest_lost_seq BIGINT NOT NULL DEFAULT 0
                );
                CREATE TEMP TABLE relay_updates (
                    session_id TEXT NOT NULL,
                    seq BIGINT NOT NULL,
                    body JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (session_id, seq)
                );

                INSERT INTO relay_sessions (session_id)
                VALUES ('count'), ('bytes'), ('age'), ('oversized');

                INSERT INTO relay_updates (session_id, seq, body, created_at) VALUES
                    ('count', 1, jsonb_build_object('payload', 'a'), NOW()),
                    ('count', 2, jsonb_build_object('payload', 'b'), NOW()),
                    ('count', 3, jsonb_build_object('payload', 'c'), NOW()),
                    ('bytes', 1, jsonb_build_object('payload', repeat('a', 700)), NOW()),
                    ('bytes', 2, jsonb_build_object('payload', repeat('b', 700)), NOW()),
                    ('age', 1, jsonb_build_object('payload', 'old'), NOW() - INTERVAL '8 days'),
                    ('age', 2, jsonb_build_object('payload', 'new'), NOW()),
                    ('oversized', 1, jsonb_build_object('payload', repeat('z', 1200)), NOW());
                ",
            )
            .await
            .expect("create PostgreSQL pruning fixtures");

        let backend = PostgresBackend {
            database_url: database_url.clone(),
            client: Mutex::new(client),
            reconnect_epoch: AtomicU64::new(0),
            resynced_epoch: AtomicU64::new(0),
        };
        let retention = RetentionConfig {
            update_retention: chrono::Duration::days(7),
            max_updates_per_session: 2,
            max_update_bytes_per_session: 900,
            trusted_device_retention: chrono::Duration::days(180),
            claimed_pairing_retention: chrono::Duration::days(1),
            completed_action_retention: chrono::Duration::days(3),
        };

        assert_eq!(
            backend
                .prune_updates_before_load(&retention, Utc::now())
                .await
                .expect("prune PostgreSQL replay"),
            3
        );

        let client = backend.client.lock().await;
        for (session_id, expected_seq, expected_oldest_lost_seq) in [
            ("count", vec![2_i64, 3], 2_i64),
            ("bytes", vec![2_i64], 2_i64),
            ("age", vec![2_i64], 2_i64),
            ("oversized", vec![1_i64], 0_i64),
        ] {
            let retained = client
                .query(
                    "SELECT seq FROM relay_updates WHERE session_id = $1 ORDER BY seq",
                    &[&session_id],
                )
                .await
                .expect("query retained replay")
                .into_iter()
                .map(|row| row.get::<_, i64>("seq"))
                .collect::<Vec<_>>();
            assert_eq!(retained, expected_seq, "session {session_id}");

            let oldest_lost_seq = client
                .query_one(
                    "SELECT oldest_lost_seq FROM relay_sessions WHERE session_id = $1",
                    &[&session_id],
                )
                .await
                .expect("query truncation cursor")
                .get::<_, i64>("oldest_lost_seq");
            assert_eq!(
                oldest_lost_seq, expected_oldest_lost_seq,
                "session {session_id}"
            );
        }
        drop(client);
        drop(backend);
        connection_task
            .await
            .expect("join PostgreSQL connection task");
    }
}
