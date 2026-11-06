use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, atomic::Ordering},
};

use chrono::Utc;
use falcondeck_core::{
    EncryptedEnvelope, EventEnvelope, ForkThreadRequest, PairingPublicKeyBundle,
    RelayClientMessage, RelayServerMessage, RelayUpdateBody, RelayWebSocketTicketResponse,
    RemoteConnectionStatus, SendTurnRequest, SessionKeyMaterial, SnapshotRequest,
    StartThreadRequest, ThreadDetailMode, ThreadDetailRequest, UnifiedEvent,
    UpdatePreferencesRequest, UpdateThreadRequest,
    control::{ControlExecuteRequest, ControlGetRequest, ControlOrigin, ControlRequestContext},
    crypto::{
        LocalIdentityKeyPair, decrypt_json, encrypt_json, sign_session_key_material,
        verify_pairing_public_key_bundle,
    },
};
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, mpsc, oneshot},
    time::{Duration, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::remote_lifecycle::RemoteBridgeRetry;
use super::{
    AppState, CachedEnvelope, EVENT_COALESCE_INTERVAL, EventCoalescer, RemoteBridgeCommand,
    RemoteBridgeError, RemotePairingState, extract_string, parse_agent_provider,
    parse_interactive_response_params, parse_thread_isolation, relay_request_error,
};
use crate::error::DaemonError;

#[path = "remote_scope.rs"]
mod scope;

#[derive(Clone)]
struct RelayWriter {
    transport: falcondeck_core::relay_transport::TransportSender,
    full_snapshots_required: bool,
    /// Every connected client opted into scoped events, so thread summaries
    /// may drop `latest_diff` / `latest_plan`. Never set by older relays.
    lean_events: bool,
}
impl std::ops::Deref for RelayWriter {
    type Target = falcondeck_core::relay_transport::TransportSender;
    fn deref(&self) -> &Self::Target {
        &self.transport
    }
}

const RELAY_HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const REMOTE_RPC_DEDUPE_TTL: Duration = Duration::from_secs(120);
const REMOTE_RPC_DEDUPE_MAX_ENTRIES: usize = 256;
const REMOTE_RPC_DEDUPE_MAX_RESULT_BYTES: usize = 256 * 1024;

/// Cache the logical RPC outcome, not a transport message encrypted with the
/// session key that happened to be current when the operation completed. A
/// device revocation rotates that key; retries must be encryptable with the
/// new key instead of replaying undecryptable old ciphertext.
type RemoteRpcOutcome = Result<Value, String>;

#[cfg(test)]
struct RemoteRpcOutboxMessage {
    key_generation: u64,
    message: RelayClientMessage,
}

#[cfg(test)]
impl RemoteRpcOutboxMessage {
    fn into_current_message(self, current_key_generation: u64) -> Option<RelayClientMessage> {
        (self.key_generation == current_key_generation).then_some(self.message)
    }
}

enum RemoteRpcDedupeEntry {
    InFlight(Vec<oneshot::Sender<RemoteRpcOutcome>>),
    Completed {
        outcome: Option<RemoteRpcOutcome>,
        completed_at: tokio::time::Instant,
    },
}

#[derive(Debug, PartialEq)]
enum RemoteRpcDedupeResult {
    Outcome(RemoteRpcOutcome),
    CompletedWithoutReplay,
    AtCapacity,
}

#[derive(Default)]
pub(super) struct RemoteRpcDeduplicator {
    entries: Mutex<HashMap<String, RemoteRpcDedupeEntry>>,
}

struct RemoteRpcExecutionGuard<'a> {
    deduplicator: &'a RemoteRpcDeduplicator,
    request_id: Option<String>,
}

impl RemoteRpcExecutionGuard<'_> {
    fn complete(
        mut self,
        outcome: Option<RemoteRpcOutcome>,
    ) -> Vec<oneshot::Sender<RemoteRpcOutcome>> {
        let request_id = self
            .request_id
            .take()
            .expect("an armed rpc execution guard has a request id");
        let mut entries = self.deduplicator.lock_entries();
        let waiters = match entries.remove(&request_id) {
            Some(RemoteRpcDedupeEntry::InFlight(waiters)) => waiters,
            _ => Vec::new(),
        };
        entries.insert(
            request_id,
            RemoteRpcDedupeEntry::Completed {
                outcome,
                completed_at: tokio::time::Instant::now(),
            },
        );
        waiters
    }
}

impl Drop for RemoteRpcExecutionGuard<'_> {
    fn drop(&mut self) {
        let Some(request_id) = self.request_id.take() else {
            return;
        };
        let mut entries = self.deduplicator.lock_entries();
        if matches!(
            entries.get(&request_id),
            Some(RemoteRpcDedupeEntry::InFlight(_))
        ) {
            // Dropping the stored senders wakes every follower with a closed
            // channel. A reconnect can then claim and execute this id again.
            entries.remove(&request_id);
        }
    }
}

impl RemoteRpcDeduplicator {
    fn lock_entries(&self) -> MutexGuard<'_, HashMap<String, RemoteRpcDedupeEntry>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn execute<F, Fut>(&self, request_id: String, operation: F) -> RemoteRpcDedupeResult
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = RemoteRpcOutcome>,
    {
        enum Claim {
            Execute,
            Wait(oneshot::Receiver<RemoteRpcOutcome>),
            Cached(RemoteRpcOutcome),
            CompletedWithoutReplay,
            AtCapacity,
        }

        let claim = {
            let now = tokio::time::Instant::now();
            let mut entries = self.lock_entries();
            entries.retain(|_, entry| {
                matches!(entry, RemoteRpcDedupeEntry::InFlight(_))
                    || matches!(
                        entry,
                        RemoteRpcDedupeEntry::Completed { completed_at, .. }
                            if now.duration_since(*completed_at) < REMOTE_RPC_DEDUPE_TTL
                    )
            });
            if let Some(entry) = entries.get_mut(&request_id) {
                match entry {
                    RemoteRpcDedupeEntry::InFlight(waiters) => {
                        let (sender, receiver) = oneshot::channel();
                        waiters.push(sender);
                        Claim::Wait(receiver)
                    }
                    RemoteRpcDedupeEntry::Completed {
                        outcome: Some(outcome),
                        ..
                    } => Claim::Cached(outcome.clone()),
                    RemoteRpcDedupeEntry::Completed { outcome: None, .. } => {
                        Claim::CompletedWithoutReplay
                    }
                }
            } else if entries.len() >= REMOTE_RPC_DEDUPE_MAX_ENTRIES {
                Claim::AtCapacity
            } else {
                entries.insert(
                    request_id.clone(),
                    RemoteRpcDedupeEntry::InFlight(Vec::new()),
                );
                Claim::Execute
            }
        };

        match claim {
            Claim::Wait(receiver) => match receiver.await {
                Ok(outcome) => RemoteRpcDedupeResult::Outcome(outcome),
                Err(_) => RemoteRpcDedupeResult::Outcome(Err(
                    "remote rpc execution ended before producing a result".to_string(),
                )),
            },
            Claim::Cached(outcome) => RemoteRpcDedupeResult::Outcome(outcome),
            Claim::CompletedWithoutReplay => RemoteRpcDedupeResult::CompletedWithoutReplay,
            Claim::AtCapacity => RemoteRpcDedupeResult::AtCapacity,
            Claim::Execute => {
                let execution = RemoteRpcExecutionGuard {
                    deduplicator: self,
                    request_id: Some(request_id),
                };
                let outcome = operation().await;
                let replayable =
                    remote_rpc_outcome_size(&outcome) <= REMOTE_RPC_DEDUPE_MAX_RESULT_BYTES;
                let waiters = execution.complete(replayable.then(|| outcome.clone()));
                for waiter in waiters {
                    let _ = waiter.send(outcome.clone());
                }
                RemoteRpcDedupeResult::Outcome(outcome)
            }
        }
    }
}

fn remote_rpc_outcome_size(outcome: &RemoteRpcOutcome) -> usize {
    match outcome {
        Ok(value) => serde_json::to_vec(value)
            .map(|encoded| encoded.len())
            .unwrap_or(REMOTE_RPC_DEDUPE_MAX_RESULT_BYTES + 1),
        Err(message) => message.len(),
    }
}

/// What one `file.stat` / `file.read_range` call may read. The roots are
/// rebuilt per call so a newly registered project or bot space is readable at
/// once and a removed one stops being.
pub(super) struct FilePreviewAccess {
    policy: crate::file_preview::FileAccessPolicy,
    home: Option<PathBuf>,
    base_dir: Option<PathBuf>,
    workspace_dir: Option<PathBuf>,
}

impl FilePreviewAccess {
    /// The policy plus the home and thread folders path resolution needs.
    pub(super) fn into_parts(
        self,
    ) -> (
        crate::file_preview::FileAccessPolicy,
        Option<PathBuf>,
        Option<PathBuf>,
    ) {
        (self.policy, self.home, self.workspace_dir)
    }

    fn target<'a>(&'a self, path: &'a str) -> crate::file_preview::FileTarget<'a> {
        crate::file_preview::FileTarget {
            path,
            base_dir: self.base_dir.as_deref(),
            workspace_dir: self.workspace_dir.as_deref(),
            home: self.home.as_deref(),
        }
    }
}

impl AppState {
    /// The file-preview policy and path bases for a local client such as the
    /// desktop app, built from the same roots as phone previews.
    pub(crate) async fn file_preview_parts(
        &self,
        params: &Value,
    ) -> (
        crate::file_preview::FileAccessPolicy,
        Option<PathBuf>,
        Option<PathBuf>,
    ) {
        self.file_preview_access(params).await.into_parts()
    }

    /// Allowed roots for phone file previews: project folders and the working
    /// directories of their threads (isolated copies included), bot document
    /// spaces, and the places agents publish work to review, namely the
    /// FalconDeck `artifacts`, `context`, `variants` and `worktrees` folders,
    /// Codex's artifacts folder and the system temp directories. See
    /// `file_preview` for the rest of the policy.
    pub(super) async fn file_preview_access(&self, params: &Value) -> FilePreviewAccess {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let mut roots: Vec<PathBuf> = Vec::new();
        {
            let workspaces = self.inner.workspaces.lock().await;
            for workspace in workspaces.values() {
                roots.push(PathBuf::from(&workspace.summary.path));
                for thread in workspace.threads.values() {
                    roots.push(PathBuf::from(
                        thread.summary.working_directory(&workspace.summary.path),
                    ));
                }
            }
        }
        for bot in &self.inner.preferences.lock().await.bots {
            roots.push(PathBuf::from(&bot.space_path));
        }
        if let Some(state_dir) = self.inner.state_path.parent() {
            for folder in ["artifacts", "context", "variants", "worktrees", "reviews"] {
                roots.push(state_dir.join(folder));
            }
        }
        if let Some(home) = &home {
            roots.push(home.join(".local/share/codex-artifacts"));
        }
        roots.push(std::env::temp_dir());
        roots.push(PathBuf::from("/tmp"));
        roots.push(PathBuf::from("/private/tmp"));

        let workspace_id = extract_string(params, &["workspaceId", "workspace_id"]);
        let mut workspace_dir = match &workspace_id {
            Some(workspace_id) => {
                let thread_id = extract_string(params, &["threadId", "thread_id"]);
                self.git_root(workspace_id, thread_id.as_deref())
                    .await
                    .ok()
                    .map(PathBuf::from)
            }
            None => None,
        };
        // Bots write paths relative to their document space (`STATUS.md`), which
        // sits inside their workspace; use it when the file is only found there.
        let space = match &workspace_id {
            Some(id) => self
                .inner
                .preferences
                .lock()
                .await
                .bots
                .iter()
                .find(|bot| bot.workspace_id == *id)
                .map(|bot| PathBuf::from(&bot.space_path)),
            None => None,
        };
        // Plain relative names only, so the probe never looks outside the space.
        let relative = extract_string(params, &["path"])
            .map(|path| path.trim().to_string())
            .filter(|path| {
                let path = std::path::Path::new(path);
                !path.as_os_str().is_empty()
                    && path
                        .components()
                        .all(|part| matches!(part, std::path::Component::Normal(_)))
                    && !path.to_string_lossy().contains("://")
            });
        if let (Some(space), Some(relative)) = (space, relative) {
            let in_workspace = workspace_dir
                .as_ref()
                .is_some_and(|dir| dir.join(&relative).exists());
            if !in_workspace && space.join(&relative).exists() {
                workspace_dir = Some(space);
            }
        }
        FilePreviewAccess {
            policy: crate::file_preview::FileAccessPolicy::build(roots, home.as_deref()).await,
            base_dir: extract_string(params, &["baseDir", "base_dir"]).map(PathBuf::from),
            workspace_dir,
            home,
        }
    }
}

fn remote_rpc_is_read_only(method: &str) -> bool {
    matches!(
        method,
        "snapshot.current"
            | "sync.index"
            | "sync.threads"
            | "sync.extensions"
            | "control.get"
            | "tickets.list"
            | "ticket.get"
            | "reviews.list"
            | "review.get"
            | "notifications.list"
            | "notification.get"
            | "thread.search"
            | "thread.detail"
            | "thread.item"
            | "thread.queue.attachment_preview"
            | "preferences.read"
            | "speech.status"
            | "speech.models"
            | "bots.documents"
            | "bots.document.read"
            | "bots.context"
            | "context_files.list"
            | "context_files.read"
            | "workspace.files"
            | "workspace.file.read"
            | "file.stat"
            | "file.read_range"
            | "workspace.icon"
            | "workspace.skills"
            | "workspace.prompts"
            | "git.status"
            | "git.diff"
            | "connectors.read"
            | "skills.read"
            | "skills.registry.search"
            | "providers.read"
            | "providers.usage"
            | "cloud.settings.get"
            | "cloud.jobs.list"
            | "cloud.jobs.get"
            | "cloud.jobs.detail"
            | "harnesses.read"
            | "harnesses.job"
            | "extensions.read"
            | "scheduled.list"
            | "scheduled.detail"
            | "scheduled.runs"
            | "computerUse.read"
    )
}

/// Every method the encrypted RPC dispatcher understands must be registered
/// with the relay or it fails the call without consulting the daemon
/// (rpc-call routes via the registration table only). The test below binds
/// this list to `dispatch_remote_rpc`'s match arms.
pub(super) const REMOTE_RPC_METHODS: &[&str] = &[
    "snapshot.current",
    // The phone requests this immediately after its first snapshot. Keep the
    // pair adjacent so the relay cannot advertise a ready daemon while the
    // required detail handler is still waiting in its registration queue.
    "thread.detail",
    "thread.item",
    "thread.search",
    "sync.index",
    "sync.threads",
    "sync.extensions",
    "preferences.read",
    "preferences.update",
    "cloud.settings.get",
    "cloud.settings.update",
    "cloud.capture",
    "cloud.jobs.list",
    "cloud.jobs.create",
    "cloud.jobs.get",
    "cloud.jobs.detail",
    "cloud.jobs.turn",
    "cloud.jobs.interrupt",
    "cloud.jobs.approval",
    "cloud.jobs.interactive",
    "cloud.jobs.collect",
    "cloud.jobs.import",
    "cloud.jobs.stop",
    "cloud.jobs.resume",
    // The control service owns the current automations UI. Keep these generic
    // methods beside other daemon-level state so every paired client uses the
    // same validation, revisions, audit log, and state-change events.
    "control.get",
    "tickets.list",
    "ticket.get",
    "reviews.list",
    "review.get",
    "review.respond",
    "notifications.list",
    "notification.get",
    "notifications.mark_read",
    "control.execute",
    "speech.status",
    "speech.models",
    "speech.transcribe",
    "speech.synthesize",
    "interactive.respond",
    "approval.respond",
    "thread.start",
    "thread.fork",
    "thread.update",
    "thread.suggestTitle",
    "routing.preview",
    "thread.archive",
    "thread.archiveAll",
    "thread.unarchive",
    "thread.delete",
    "thread.mark_read",
    "thread.mark_unread",
    "thread.goal.set",
    "thread.goal.clear",
    "thread.compact",
    "turn.start",
    "turn.steer",
    "turn.interrupt",
    "thread.queue.remove",
    "thread.queue.steer",
    "thread.queue.edit",
    "thread.queue.attachment_preview",
    "thread.queue.reorder",
    "chat.create",
    "bots.mutate",
    "bots.documents",
    "bots.document.read",
    "bots.document.mutate",
    "bots.context",
    "context_files.list",
    "context_files.read",
    "context_files.write",
    "workspace.connect",
    "workspace.remove",
    "workspace.close",
    "provider.hydrate",
    "workspace.skills",
    "workspace.prompts",
    "workspace.files",
    "workspace.file.read",
    "workspace.file.write",
    "file.stat",
    "file.read_range",
    "workspace.icon",
    "git.status",
    "git.diff",
    "git.commit",
    "thread.ship",
    "connectors.read",
    "connectors.update",
    "skills.read",
    "skills.registry.search",
    "skills.install",
    "skills.uninstall",
    "providers.read",
    "providers.update",
    "providers.usage",
    "providers.usage.consumeReset",
    "harnesses.read",
    "harnesses.refresh",
    "harnesses.upgrade",
    "harnesses.job",
    "extensions.read",
    "extensions.update",
    "extensions.permission.update",
    "extensions.action.invoke",
    "scheduled.list",
    "scheduled.create",
    "scheduled.detail",
    "scheduled.update",
    "scheduled.delete",
    "scheduled.run",
    "scheduled.runs",
    "computerUse.read",
    "computerUse.update",
    "computerUse.restart",
    "computerUse.test",
];

impl AppState {
    pub(super) async fn connect_remote_session(
        &self,
        relay_url: String,
        daemon_token: String,
        session_id: String,
        mut pairing: RemotePairingState,
        client_bundle: Option<PairingPublicKeyBundle>,
        command_rx: &mut mpsc::UnboundedReceiver<RemoteBridgeCommand>,
        retry: &mut RemoteBridgeRetry,
    ) -> Result<(), RemoteBridgeError> {
        let ws_ticket = self
            .fetch_relay_ws_ticket(&relay_url, &session_id, &daemon_token)
            .await
            .map_err(|error| format!("failed to issue relay websocket ticket: {error}"))?;
        let ws_url = relay_ws_url(&relay_url, &session_id, &ws_ticket.ticket);
        let (socket, _) = timeout(Duration::from_secs(20), connect_async(&ws_url))
            .await
            .map_err(|_| {
                RemoteBridgeError::Transient(
                    "relay websocket connection timed out; retrying".to_string(),
                )
            })?
            .map_err(|error| format!("failed to connect daemon relay websocket: {error}"))?;
        let (sink, stream) = socket.split();
        let sink = sink.with(|text: String| {
            futures_util::future::ready(Ok::<_, tokio_tungstenite::tungstenite::Error>(
                Message::Text(text.into()),
            ))
        });
        let stream = stream.map(|message| match message {
            Ok(Message::Text(text)) => Ok(text.to_string()),
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => Ok(r#"{"type":"pong"}"#.to_string()),
            Ok(_) => Err("relay socket closed or unsupported frame".to_string()),
            Err(error) => Err(error.to_string()),
        });
        let (transport, mut reader, _transport) =
            falcondeck_core::relay_transport::spawn_transport(sink, stream, false);
        let mut writer = RelayWriter {
            transport,
            full_snapshots_required: true,
            lean_events: false,
        };

        // Detect silently-dead connections: outbound sends can keep buffering
        // long after the peer is gone, so track inbound traffic (pongs count)
        // and force a reconnect when the relay goes quiet for several
        // heartbeat intervals.
        // Two full heartbeat cycles of silence plus slack: the relay answers
        // every ping, so 35s of nothing inbound means the socket is gone.
        // Kept tight because remote clients ride out the resulting outage —
        // the longer this is, the longer a phone stares at a stale "offline".
        const INBOUND_IDLE_TIMEOUT: Duration = Duration::from_secs(35);
        let mut last_inbound = tokio::time::Instant::now();
        let mut events = self.subscribe();
        let fence_seq = self.inner.sequence.load(Ordering::Relaxed);
        register_remote_rpc_methods(&mut writer).await?;
        if let Some(client_bundle) = client_bundle.as_ref() {
            self.publish_session_bootstrap(&mut writer, &pairing, client_bundle)
                .await?;
        } else {
            tracing::warn!(
                "skipping bootstrap for restored trusted session {session_id}; client must already have the persisted data key"
            );
        }
        // New relays announce whether any legacy client needs a full push.
        // Give that profile one second to arrive; old relays keep the fallback.
        let initial_snapshot_due = tokio::time::Instant::now() + Duration::from_secs(1);
        let mut initial_snapshot_pending = true;

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::Connected;
            remote.last_error = None;
        }
        // A connected session normally exits with an error when its socket
        // eventually drops. Reset here, not in the supervisor's unreachable
        // successful-return path, so old outages do not delay a fresh retry.
        retry.connected();
        tracing::info!(%session_id, "remote relay bridge connected");
        send_relay_message(&writer, &RelayClientMessage::Ping).await?;
        // interval() ticks immediately. Re-registering all methods on that
        // tick doubled the startup burst beyond the 128-message urgent queue.
        let mut heartbeat = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(15),
            Duration::from_secs(15),
        );
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        // Once the transport is live, persistence failures are durability
        // warnings rather than connection failures. Tearing down a healthy
        // socket here made a transient credential-store problem look like a
        // network outage and trapped the supervisor in a reconnect loop.
        if let Err(error) = self.persist_local_state().await {
            tracing::warn!(%error, "failed to persist connected remote state");
        }

        let min_forward_seq: u64 = fence_seq;
        // A trusted client that lost its persisted data key cannot use the
        // encrypted RPC channel, so it asks for a fresh bootstrap over the
        // relay's plaintext ephemeral channel. Track the last publish per
        // client public key so a misbehaving peer cannot flood the durable
        // update log with bootstrap material.
        // Only pinned, trusted bundles reach the publish branch. Coalesce
        // bursts per device without a lifetime budget that eventually disables
        // recovery on a long-lived desktop connection.
        const BOOTSTRAP_REQUEST_MIN_INTERVAL: Duration = Duration::from_secs(2);
        // Refusals are cheap ephemerals but still rate-limited so an
        // attacker minting fresh bundles cannot use us as a broadcast pump.
        const BOOTSTRAP_REFUSAL_MIN_INTERVAL: Duration = Duration::from_secs(5);
        let mut bootstrap_request_publishes: HashMap<String, tokio::time::Instant> = HashMap::new();
        let mut last_bootstrap_refusal: Option<tokio::time::Instant> = None;
        let mut key_generation = 0u64;
        // Anything written while the relay was out of reach goes up now.
        self.spawn_report_sync();
        let push_wake = self.inner.remote.lock().await.held_pushes.wake();
        push_wake.notify_one();
        // Collapses the per-chunk stream storm before it reaches the phone.
        let mut coalescer = EventCoalescer::default();
        let mut coalesce_flush = tokio::time::interval(EVENT_COALESCE_INTERVAL);
        coalesce_flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut pending_delivery: Option<BoxFuture<'static, Result<(), String>>> = None;
        let mut push_drain: Option<tokio::task::JoinHandle<Result<(), String>>> = None;
        let mut snapshot_pending = false;
        loop {
            if pending_delivery.is_none() && snapshot_pending {
                snapshot_pending = false;
                let app = self.clone();
                let mut snapshot_writer = writer.clone();
                let data_key = pairing.data_key;
                pending_delivery = Some(Box::pin(async move {
                    app.publish_remote_snapshot(&mut snapshot_writer, &data_key, key_generation)
                        .await
                }));
            }
            tokio::select! {
                result = async {
                    match pending_delivery.as_mut() {
                        Some(delivery) => delivery.await,
                        None => std::future::pending().await,
                    }
                } => {
                    result?;
                    pending_delivery = None;
                }
                _ = tokio::time::sleep_until(initial_snapshot_due), if initial_snapshot_pending => {
                    initial_snapshot_pending = false;
                    if writer.full_snapshots_required {
                        snapshot_pending = true;
                    }
                }
                // Backpressure pauses only event intake. The broadcast remains
                // bounded; RPC requests, heartbeats and key changes keep running.
                event = events.recv(), if pending_delivery.is_none() => {
                    match event {
                        Ok(event) => {
                            if event.seq < min_forward_seq {
                                continue;
                            }
                            let outgoing = coalescer.push(event);
                            if !outgoing.is_empty() {
                                pending_delivery = Some(Box::pin(send_remote_events(
                                    writer.clone(), pairing.data_key, key_generation, outgoing,
                                )));
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!("remote daemon event stream lagged, skipped {skipped} events; sending fresh snapshot");
                            // Held updates predate the snapshot about to be
                            // sent, so they go first or not at all.
                            pending_delivery = Some(Box::pin(send_remote_events(
                                writer.clone(), pairing.data_key, key_generation, coalescer.drain(),
                            )));
                            snapshot_pending = true;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            return Err(RemoteBridgeError::Persistent(
                                "remote event stream closed".to_string(),
                            ));
                        }
                    }
                }
                _ = coalesce_flush.tick(), if !coalescer.is_empty() && pending_delivery.is_none() => {
                    pending_delivery = Some(Box::pin(send_remote_events(
                        writer.clone(), pairing.data_key, key_generation, coalescer.drain(),
                    )));
                }
                _ = heartbeat.tick() => {
                    if last_inbound.elapsed() > INBOUND_IDLE_TIMEOUT {
                        return Err(RemoteBridgeError::Transient(
                            "relay websocket went quiet; reconnecting".to_string(),
                        ));
                    }
                    send_relay_message(&mut writer, &RelayClientMessage::Ping).await?;
                    // The relay's method registry is intentionally ephemeral.
                    // Reassert it with every heartbeat so a partial relay
                    // state loss self-heals without requiring either side to
                    // reconnect (the websocket can remain healthy throughout).
                    register_remote_rpc_methods(&mut writer).await?;
                }
                result = async {
                    match push_drain.as_mut() {
                        Some(drain) => drain.await,
                        None => std::future::pending().await,
                    }
                } => {
                    push_drain = None;
                    match result {
                        Ok(written) => written?,
                        Err(error) => tracing::warn!(%error, "attention push drain stopped"),
                    }
                }
                _ = push_wake.notified(), if push_drain.is_none() => {
                    push_drain = Some(self.spawn_push_drain(&writer));
                }
                command = command_rx.recv() => {
                    if let Some(command) = command {
                        match command {
                            RemoteBridgeCommand::PublishBootstrap { pairing, client_bundle } => {
                                self.publish_session_bootstrap(&mut writer, &pairing, &client_bundle).await?;
                            }
                            RemoteBridgeCommand::RotateSessionKey {
                                pairing: next_pairing,
                                client_bundles,
                                completed,
                            } => {
                                key_generation = key_generation.wrapping_add(1);
                                writer.advance_generation();
                                pending_delivery = None;
                                // Its barrier was just invalidated, which is not a
                                // broken socket. The push goes out on the next wake.
                                push_drain = None;
                                coalescer.drain();
                                snapshot_pending = false;
                                pairing = *next_pairing;
                                let result = async {
                                    for client_bundle in &client_bundles {
                                        self.publish_session_bootstrap(
                                            &mut writer,
                                            &pairing,
                                            client_bundle,
                                        )
                                        .await?;
                                    }
                                    self.publish_remote_snapshot(
                                        &mut writer,
                                        &pairing.data_key,
                                        key_generation,
                                    )
                                    .await
                                }
                                .await;
                                match result {
                                    Ok(()) => {
                                        let _ = completed.send(Ok(()));
                                        // Hosted reports are unreadable under the new key.
                                        self.spawn_report_sync();
                                    }
                                    Err(error) => {
                                        let _ = completed.send(Err(error.clone()));
                                        return Err(RemoteBridgeError::Transient(error));
                                    }
                                }
                            }
                        }
                    }
                }
                message = reader.recv() => {
                    let message = message.map(|r| r.map(|m| Message::Text(m.text.into())));
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            last_inbound = tokio::time::Instant::now();
                            // An unknown or malformed message (e.g. from a
                            // newer relay) must not tear down the bridge —
                            // skip it and keep the connection alive.
                            let parsed = match serde_json::from_str::<RelayServerMessage>(&text) {
                                Ok(parsed) => parsed,
                                Err(error) => {
                                    tracing::warn!("ignoring unrecognized relay message: {error}");
                                    continue;
                                }
                            };
                            match parsed {
                                RelayServerMessage::SyncProfile { full_snapshots_required, lean_events } => {
                                    let was_required = writer.full_snapshots_required;
                                    writer.full_snapshots_required = full_snapshots_required;
                                    writer.lean_events = lean_events;
                                    if !full_snapshots_required && initial_snapshot_pending {
                                        initial_snapshot_pending = false;
                                        // A new bridge may represent a restarted daemon. Repair cached
                                        // views once, without pushing a second full bootstrap.
                                        snapshot_pending = true;
                                    }
                                    if full_snapshots_required && !was_required {
                                        snapshot_pending = true;
                                    }
                                }
                                RelayServerMessage::RpcRequest { request_id, method, params } => {
                                    // Handled on its own task: awaiting inline
                                    // serialized every RPC behind the slowest
                                    // in-flight call (and stalled event
                                    // forwarding) for all paired devices.
                                    let app = self.clone();
                                    let data_key = pairing.data_key;
                                    let rpc_key_generation = key_generation;
                                    let permit = self.inner.remote_rpc_slots.clone().try_acquire_owned().or_else(|error| {
                                        if matches!(method.as_str(), "turn.start" | "turn.steer" | "turn.interrupt" | "approval.respond" | "interactive.respond") {
                                            self.inner.remote_urgent_rpc_slots.clone().try_acquire_owned()
                                        } else { Err(error) }
                                    });
                                    let Ok(permit) = permit else {
                                        let message = self.remote_rpc_result_message(&data_key, request_id, Err("Desktop is busy; this request was not executed. Try again shortly.".into()))?;
                                        send_relay_message(&mut writer, &message).await?;
                                        continue;
                                    };
                                    let outbox = writer.clone();
                                    self.spawn_background_task(async move {
                                        let _permit = permit;
                                        if let Err(error) = app
                                            .handle_remote_rpc(
                                                &outbox,
                                                rpc_key_generation,
                                                &data_key,
                                                request_id,
                                                method,
                                                params,
                                            )
                                            .await
                                        {
                                            tracing::warn!(%error, "remote rpc handling failed");
                                        }
                                    });
                                }
                                RelayServerMessage::ActionRequested { action, payload } => {
                                    self.handle_queued_remote_action(&mut writer, &pairing.data_key, action.action_id, action.action_type, payload).await?;
                                }
                                RelayServerMessage::Ephemeral { body } => {
                                    if let Some(client_bundle) = parse_bootstrap_request(&body) {
                                        // Self-signed validity is not trust: only bundles the
                                        // daemon saw complete a pairing claim may be handed the
                                        // data key, otherwise a compromised relay could mint its
                                        // own bundle and decrypt the whole session.
                                        let trusted = {
                                            let remote = self.inner.remote.lock().await;
                                            is_trusted_client_bundle(&remote.trusted_client_bundles, &client_bundle)
                                        };
                                        let now = tokio::time::Instant::now();
                                        bootstrap_request_publishes
                                            .retain(|_, last| now.duration_since(*last) < BOOTSTRAP_REQUEST_MIN_INTERVAL);
                                        let recently_served = bootstrap_request_publishes
                                            .get(&client_bundle.public_key)
                                            .is_some_and(|last| now.duration_since(*last) < BOOTSTRAP_REQUEST_MIN_INTERVAL);
                                        if !trusted {
                                            tracing::warn!("refusing bootstrap request from a client bundle that never completed pairing");
                                            // Tell the requesting device it is not
                                            // recognized instead of dropping the
                                            // request silently — without this the
                                            // phone spins on "Securing session…"
                                            // forever with no hint that re-pairing
                                            // is the only way out.
                                            let refusal_throttled = last_bootstrap_refusal
                                                .is_some_and(|last| now.duration_since(last) < BOOTSTRAP_REFUSAL_MIN_INTERVAL);
                                            if !refusal_throttled {
                                                last_bootstrap_refusal = Some(now);
                                                send_relay_message(
                                                    &mut writer,
                                                    &RelayClientMessage::Ephemeral {
                                                        body: serde_json::json!({
                                                            "kind": "bootstrap-refused",
                                                            "client_public_key": client_bundle.public_key,
                                                        }),
                                                    },
                                                ).await?;
                                            }
                                        } else if recently_served {
                                            tracing::debug!("ignoring bootstrap request inside the publish rate window");
                                        } else {
                                            bootstrap_request_publishes.insert(client_bundle.public_key.clone(), now);
                                            self.publish_session_bootstrap(&mut writer, &pairing, &client_bundle).await?;
                                            tracing::info!("republished session bootstrap for a keyless trusted client");
                                        }
                                    }
                                }
                                RelayServerMessage::Pong | RelayServerMessage::Presence { .. } | RelayServerMessage::ActionUpdated { .. } | RelayServerMessage::Ready { .. } | RelayServerMessage::Sync { .. } | RelayServerMessage::Update { .. } | RelayServerMessage::RpcRegistered { .. } | RelayServerMessage::RpcUnregistered { .. } | RelayServerMessage::RpcResult { .. } | RelayServerMessage::Error { .. } => {}
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            return Err("relay websocket disconnected".to_string().into());
                        }
                        Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {
                            last_inbound = tokio::time::Instant::now();
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => {
                            return Err(format!("relay websocket error: {error}").into());
                        }
                    }
                }
            }
        }
    }

    /// Waiting on a barrier here would stop the session reading from the relay,
    /// so the drain runs beside it. It is a task of its own because a session
    /// can be aborted at any await: a drain cannot, so a push is never left
    /// written but still queued, which would send it twice. Losing the session
    /// closes the transport, which ends the wait.
    fn spawn_push_drain(
        &self,
        writer: &RelayWriter,
    ) -> tokio::task::JoinHandle<Result<(), String>> {
        let app = self.clone();
        let writer = writer.clone();
        tokio::spawn(async move { app.write_held_pushes(&writer).await })
    }

    /// Everything waiting and still worth saying. A push counts as delivered
    /// once written; one the socket refuses stays queued for the next session.
    async fn write_held_pushes(&self, writer: &RelayWriter) -> Result<(), String> {
        while let Some((push, claim)) = self.next_held_push().await {
            let message = RelayClientMessage::Notify {
                kind: push.kind.to_string(),
                workspace_id: push.workspace_id.clone(),
                thread_id: push.thread_id.clone(),
                thread_title: self.push_title(&push).await,
                message_preview: push.preview.clone(),
                review_id: push.review_id.clone(),
                notification_id: push.notification_id.clone(),
                report_id: push.report_id.clone(),
                ignore_presence: push.ignore_presence,
            };
            #[cfg(test)]
            {
                let gate = self
                    .inner
                    .remote
                    .lock()
                    .await
                    .held_pushes
                    .write_gate
                    .clone();
                if let Some(gate) = gate {
                    let _ = gate.acquire().await;
                }
            }
            if let Err(error) = send_relay_message(writer, &message).await {
                tracing::warn!(
                    kind = push.kind,
                    "attention push held: the socket write failed"
                );
                self.push_unwritten(claim).await;
                return Err(error);
            }
            self.push_written(claim).await;
        }
        Ok(())
    }

    pub(super) async fn notification_title(
        &self,
        workspace_id: Option<&str>,
        thread_id: Option<&str>,
    ) -> Option<String> {
        let thread = self.thread_summary(workspace_id?, thread_id?).await.ok()?;
        notification_thread_title(&thread.title)
    }

    pub(super) async fn fetch_remote_status(
        &self,
        relay_url: &str,
        session_id: &str,
        daemon_token: &str,
    ) -> Result<falcondeck_core::TrustedDevicesResponse, DaemonError> {
        let response = reqwest::Client::new()
            .get(format!(
                "{}/v1/sessions/{}/devices",
                relay_url.trim_end_matches('/'),
                session_id
            ))
            .bearer_auth(daemon_token)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to fetch relay remote status: {error}"))
            })?;
        let response = if response.status().is_success() {
            response
        } else {
            return Err(DaemonError::Rpc(
                relay_request_error(response, "relay remote status request").await,
            ));
        };
        response
            .json::<falcondeck_core::TrustedDevicesResponse>()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to parse relay remote status: {error}"))
            })
    }

    async fn fetch_relay_ws_ticket(
        &self,
        relay_url: &str,
        session_id: &str,
        daemon_token: &str,
    ) -> Result<RelayWebSocketTicketResponse, DaemonError> {
        let response =
            relay_ws_ticket_request(&reqwest::Client::new(), relay_url, session_id, daemon_token)
                .send()
                .await
                .map_err(|error| {
                    DaemonError::Rpc(format!("failed to fetch relay websocket ticket: {error}"))
                })?;
        let response = if response.status().is_success() {
            response
        } else {
            return Err(DaemonError::Rpc(
                relay_request_error(response, "relay websocket ticket request").await,
            ));
        };
        response
            .json::<RelayWebSocketTicketResponse>()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to parse relay websocket ticket: {error}"))
            })
    }

    async fn publish_session_bootstrap(
        &self,
        writer: &mut RelayWriter,
        pairing: &RemotePairingState,
        client_bundle: &PairingPublicKeyBundle,
    ) -> Result<(), String> {
        let session_id = pairing
            .session_id
            .as_ref()
            .ok_or_else(|| "missing session id for remote bootstrap".to_string())?;
        let daemon_identity_key_pair =
            LocalIdentityKeyPair::from_box_key_pair(&pairing.local_key_pair);
        let client_wrapped_data_key = pairing
            .local_key_pair
            .wrap_data_key(&client_bundle.public_key, &pairing.data_key)
            .map_err(|error| format!("failed to wrap remote session key: {error}"))?;
        let daemon_wrapped_data_key = pairing
            .local_key_pair
            .wrap_data_key(
                pairing.local_key_pair.public_key_base64(),
                &pairing.data_key,
            )
            .map_err(|error| format!("failed to wrap daemon session key: {error}"))?;
        let mut session_material = SessionKeyMaterial {
            encryption_variant: falcondeck_core::EncryptionVariant::DataKeyV1,
            identity_variant: falcondeck_core::IdentityVariant::Ed25519V1,
            pairing_id: pairing.pairing_id.clone(),
            session_id: session_id.clone(),
            daemon_public_key: pairing.local_key_pair.public_key_base64().to_string(),
            daemon_identity_public_key: daemon_identity_key_pair.public_key_base64().to_string(),
            client_public_key: client_bundle.public_key.clone(),
            client_identity_public_key: client_bundle.identity_public_key.clone(),
            client_wrapped_data_key,
            daemon_wrapped_data_key: Some(daemon_wrapped_data_key),
            signature: String::new(),
        };
        sign_session_key_material(&daemon_identity_key_pair, &mut session_material)
            .map_err(|error| format!("failed to sign remote session bootstrap: {error}"))?;

        send_relay_message(
            writer,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::SessionBootstrap {
                    material: session_material,
                },
            },
        )
        .await
    }

    async fn publish_remote_snapshot(
        &self,
        writer: &mut RelayWriter,
        data_key: &[u8; 32],
        key_generation: u64,
    ) -> Result<(), String> {
        if !writer.full_snapshots_required {
            return send_ordered_relay_message(
                writer,
                &snapshot_invalidation(data_key)?,
                key_generation,
            )
            .await;
        }
        let mut snapshot = self.snapshot().await;
        // No client reads the per-agent skill catalog, and it is repeated once
        // per agent per workspace — on a daemon with many projects it is the
        // largest part of this payload. Everything else is left intact: remote
        // desktops bootstrap from this push and do render plans and diffs.
        for workspace in &mut snapshot.workspaces {
            for agent in &mut workspace.agents {
                agent.skills.clear();
            }
        }
        let snapshot_event = EventEnvelope {
            seq: 0,
            emitted_at: Utc::now(),
            workspace_id: None,
            thread_id: None,
            event: UnifiedEvent::Snapshot { snapshot },
        };
        send_ordered_relay_message(
            writer,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::Encrypted {
                    envelope: encrypt_remote_daemon_event(data_key, &snapshot_event)?,
                },
            },
            key_generation,
        )
        .await
    }

    fn remote_rpc_result_message(
        &self,
        data_key: &[u8; 32],
        request_id: String,
        rpc_result: Result<Value, String>,
    ) -> Result<RelayClientMessage, String> {
        let (ok, result, error) = match rpc_result {
            Ok(value) => (
                true,
                Some(
                    encrypt_json(data_key, &value)
                        .map_err(|error| format!("failed to encrypt rpc result: {error}"))?,
                ),
                None,
            ),
            Err(message) => (
                false,
                None,
                Some(
                    encrypt_json(data_key, &json!({ "message": message }))
                        .map_err(|error| format!("failed to encrypt rpc error: {error}"))?,
                ),
            ),
        };
        Ok(RelayClientMessage::RpcResult {
            request_id,
            ok,
            result,
            error,
        })
    }

    /// Serves one relay RPC off the bridge loop. Called from a dedicated
    /// task (see the `RpcRequest` arm in `connect_remote_session`) so one
    /// slow method — a `thread.detail` waiting on a busy app-server, a long
    /// transcription — cannot head-of-line block every other device's RPCs
    /// and the event stream. The encrypted result is funneled through the
    /// bounded writer queue, leaving incoming requests independently serviced.
    async fn handle_remote_rpc(
        &self,
        outbox: &RelayWriter,
        key_generation: u64,
        data_key: &[u8; 32],
        request_id: String,
        method: String,
        params: EncryptedEnvelope,
    ) -> Result<(), String> {
        let started = tokio::time::Instant::now();
        tracing::info!(%request_id, %method, "remote rpc received");
        let params: Value = match decrypt_json(data_key, &params) {
            Ok(params) => params,
            Err(error) => {
                tracing::warn!("failed to decrypt remote rpc payload: {error}");
                self.republish_bootstrap_for_stale_key().await;
                let message = self.remote_rpc_result_message(
                    data_key,
                    request_id,
                    Err("invalid remote rpc payload".to_string()),
                )?;
                return outbox
                    .send_result(
                        serde_json::to_string(&message).map_err(|e| e.to_string())?,
                        key_generation,
                    )
                    .await
                    .map_err(|error| format!("rpc outbox closed: {error}"));
            }
        };
        let rpc_result = if remote_rpc_is_read_only(&method) {
            self.dispatch_remote_rpc(&method, params).await
        } else {
            match self
                .inner
                .remote_rpc_deduplicator
                .execute(request_id.clone(), || async {
                    self.dispatch_remote_rpc(&method, params).await
                })
                .await
            {
                RemoteRpcDedupeResult::Outcome(outcome) => outcome,
                RemoteRpcDedupeResult::CompletedWithoutReplay => Err(
                    "This action already completed, but its response was too large to replay. Refresh before trying again."
                        .to_string(),
                ),
                RemoteRpcDedupeResult::AtCapacity => Err(
                    "The desktop is handling too many remote actions. Try again in a moment."
                        .to_string(),
                ),
            }
        };
        let dispatched_ms = started.elapsed().as_millis();
        let message = self.remote_rpc_result_message(data_key, request_id.clone(), rpc_result)?;
        let encoded = serde_json::to_string(&message).map_err(|e| e.to_string())?;
        tracing::info!(%request_id, %method, dispatched_ms, key_generation,
            response_bytes = encoded.len(), elapsed_ms = started.elapsed().as_millis(),
            "remote rpc response prepared");
        let result = outbox.send_result(encoded, key_generation).await;
        tracing::info!(%request_id, %method, ok = result.is_ok(),
            elapsed_ms = started.elapsed().as_millis(), "remote rpc response queue completed");
        result.map_err(|error| format!("rpc outbox closed: {error}"))
    }

    async fn send_remote_action_failure(
        &self,
        writer: &mut RelayWriter,
        action_id: String,
        message: &str,
    ) -> Result<(), String> {
        send_relay_message(
            writer,
            &RelayClientMessage::ActionUpdate {
                action_id,
                status: falcondeck_core::QueuedRemoteActionStatus::Failed,
                error: Some(message.to_string()),
                result: None,
            },
        )
        .await
    }

    pub(super) async fn pairing_watch_still_current(
        &self,
        relay_url: &str,
        daemon_token: &str,
        pairing_id: &str,
    ) -> bool {
        let remote = self.inner.remote.lock().await;
        remote.relay_url.as_deref() == Some(relay_url)
            && remote.daemon_token.as_deref() == Some(daemon_token)
            && remote
                .pending_pairing
                .as_ref()
                .is_some_and(|pairing| pairing.pairing_id == pairing_id)
    }

    pub(super) async fn set_pairing_watch_error(
        &self,
        relay_url: &str,
        daemon_token: &str,
        pairing_id: &str,
        error: String,
    ) {
        let should_persist = {
            let mut remote = self.inner.remote.lock().await;
            if remote.relay_url.as_deref() != Some(relay_url)
                || remote.daemon_token.as_deref() != Some(daemon_token)
                || remote
                    .pending_pairing
                    .as_ref()
                    .is_none_or(|pairing| pairing.pairing_id != pairing_id)
            {
                false
            } else {
                remote.last_error = Some(error);
                true
            }
        };
        if should_persist {
            let _ = self.persist_local_state().await;
        }
    }

    /// Resolves an optional workspace id to its filesystem path for the
    /// connectors RPCs; `None` in → `None` out (global scope).
    async fn connectors_rpc_workspace_path(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<Option<String>, String> {
        let Some(workspace_id) = workspace_id else {
            return Ok(None);
        };
        let snapshot = self.snapshot().await;
        snapshot
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .map(|workspace| Some(workspace.path.clone()))
            .ok_or_else(|| "workspace not found".to_string())
    }

    /// Serves one decrypted remote RPC call. Kept free of transport concerns
    /// so a test can assert every method in [`REMOTE_RPC_METHODS`] actually
    /// dispatches: a method registered with the relay but missing an arm here
    /// fails every call with "unsupported" (this exact bug shipped once, as
    /// thread.unarchive), while one dispatched but unregistered is rejected
    /// by the relay without ever consulting the daemon.
    pub(super) async fn dispatch_remote_rpc(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let required = |keys: &[&str]| {
            extract_string(&params, keys).ok_or_else(|| "invalid remote rpc payload".to_string())
        };
        // The dispatch runs inside its own async block so a `?` on a bad
        // request (unknown workspace, missing field) becomes this call's
        // rpc-result error. Propagating it out instead would tear down the
        // whole relay bridge for every connected device and leave the caller
        // waiting out the relay's 30s RPC timeout.
        async {
            match method {
                method if method.starts_with("cloud.") => {
                    crate::cloud::rpc::dispatch(self, method, params.clone()).await
                }
                "thread.search" => {
                    let request = serde_json::from_value::<
                        falcondeck_core::ThreadMessageSearchRequest,
                    >(params.clone())
                    .map_err(|e| e.to_string())?;
                    serde_json::to_value(self.search_thread_messages(request).await)
                        .map_err(|e| e.to_string())
                }
                "sync.index" => serde_json::to_value(
                    self.sync_index_open_with(
                        // Unknown or malformed options mean the original,
                        // option-free index rather than a failed bootstrap.
                        &serde_json::from_value::<falcondeck_core::sync_index::SyncIndexRequest>(
                            params.clone(),
                        )
                        .unwrap_or_default(),
                    )
                    .await?,
                )
                .map_err(|e| e.to_string()),
                "sync.threads" => serde_json::to_value(
                    self.sync_index_threads(
                        &required(&["token"])?,
                        &required(&["workspace_id"])?,
                        params.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize,
                        params
                            .get("sort")
                            .and_then(Value::as_str)
                            .unwrap_or("last_updated"),
                        params
                            .get("limit")
                            .and_then(Value::as_u64)
                            .unwrap_or(50)
                            .clamp(1, 50) as usize,
                        params.get("folder_id").and_then(Value::as_str),
                    )
                    .await?,
                )
                .map_err(|e| e.to_string()),
                "sync.extensions" => {
                    let thread_ids = params.get("thread_ids").and_then(Value::as_array).map(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    });
                    serde_json::to_value(
                        self.sync_index_extensions(&required(&["token"])?, thread_ids.as_deref())
                            .await?,
                    )
                    .map_err(|e| e.to_string())
                }
                "snapshot.current" => {
                    let rpc_bool = |camel: &str, snake: &str| {
                        params
                            .get(camel)
                            .or_else(|| params.get(snake))
                            .and_then(Value::as_bool)
                            .unwrap_or(true)
                    };
                    let request = SnapshotRequest {
                        include_workspace_skills: rpc_bool(
                            "includeWorkspaceSkills",
                            "include_workspace_skills",
                        ),
                        include_archived_threads: rpc_bool(
                            "includeArchivedThreads",
                            "include_archived_threads",
                        ),
                        include_thread_plans: rpc_bool(
                            "includeThreadPlans",
                            "include_thread_plans",
                        ),
                        include_thread_diffs: rpc_bool(
                            "includeThreadDiffs",
                            "include_thread_diffs",
                        ),
                        include_agent_skills: rpc_bool(
                            "includeAgentSkills",
                            "include_agent_skills",
                        ),
                    };
                    serde_json::to_value(self.snapshot_with_request(&request).await)
                        .map_err(|error| format!("failed to serialize snapshot: {error}"))
                }
                "preferences.read" => serde_json::to_value(self.preferences().await)
                    .map_err(|error| format!("failed to serialize preferences: {error}")),
                "backup.export" => serde_json::to_value(
                    self.export_backup()
                        .await
                        .map_err(|err| format!("failed to export backup: {err}"))?,
                )
                .map_err(|error| format!("failed to serialize backup: {error}")),
                "backup.inspect" => {
                    let backup =
                        serde_json::from_value::<falcondeck_core::FalconDeckBackup>(params.clone())
                            .map_err(|error| format!("invalid backup payload: {error}"))?;
                    serde_json::to_value(backup.summarize())
                        .map_err(|error| format!("failed to serialize backup summary: {error}"))
                }
                "backup.import" => {
                    let request = serde_json::from_value::<falcondeck_core::ImportBackupRequest>(
                        params.clone(),
                    )
                    .map_err(|error| format!("invalid backup import payload: {error}"))?;
                    serde_json::to_value(
                        self.import_backup(request)
                            .await
                            .map_err(|err| format!("failed to import backup: {err}"))?,
                    )
                    .map_err(|error| format!("failed to serialize backup import response: {error}"))
                }
                "tickets.list" | "ticket.get" => {
                    let mut payload = params
                        .as_object()
                        .cloned()
                        .ok_or("invalid tickets read payload")?;
                    payload.insert(
                        "resource".into(),
                        serde_json::json!(if method == "tickets.list" {
                            "tickets"
                        } else {
                            "ticket"
                        }),
                    );
                    let request = serde_json::from_value::<ControlGetRequest>(
                        serde_json::Value::Object(payload),
                    )
                    .map_err(|error| format!("invalid tickets read payload: {error}"))?;
                    let context = ControlRequestContext {
                        origin: ControlOrigin::RemoteRpc,
                        ..Default::default()
                    };
                    serde_json::to_value(
                        self.control_get(request, &context)
                            .await
                            .map_err(|error| error.0.message)?,
                    )
                    .map_err(|error| error.to_string())
                }
                "reviews.list" | "review.get" => {
                    let mut payload = params
                        .as_object()
                        .cloned()
                        .ok_or("invalid reviews read payload")?;
                    payload.insert(
                        "resource".into(),
                        serde_json::json!(if method == "reviews.list" {
                            "reviews"
                        } else {
                            "review"
                        }),
                    );
                    let request = serde_json::from_value::<ControlGetRequest>(
                        serde_json::Value::Object(payload),
                    )
                    .map_err(|error| format!("invalid reviews read payload: {error}"))?;
                    let context = ControlRequestContext {
                        origin: ControlOrigin::RemoteRpc,
                        ..Default::default()
                    };
                    serde_json::to_value(
                        self.control_get(request, &context)
                            .await
                            .map_err(|error| error.0.message)?,
                    )
                    .map_err(|error| error.to_string())
                }
                // James answers a review from a paired phone. The origin is
                // fixed here, so an agent can never reach this path.
                "review.respond" => {
                    let arguments = params
                        .as_object()
                        .cloned()
                        .ok_or("invalid review response payload")?;
                    let request = serde_json::from_value::<ControlExecuteRequest>(
                        serde_json::json!({"operation": "review.respond", "arguments": arguments}),
                    )
                    .map_err(|error| format!("invalid review response payload: {error}"))?;
                    let context = ControlRequestContext {
                        origin: ControlOrigin::RemoteRpc,
                        ..Default::default()
                    };
                    serde_json::to_value(self.control_execute(request, &context).await)
                        .map_err(|error| error.to_string())
                }
                "notifications.list" => {
                    let request = serde_json::from_value(params.clone())
                        .map_err(|error| format!("invalid notifications payload: {error}"))?;
                    serde_json::to_value(self.notifications_list(&request).await)
                        .map_err(|error| error.to_string())
                }
                "notification.get" => {
                    let id = params
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .ok_or("invalid notification payload")?;
                    serde_json::to_value(
                        self.notification_get(id)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| error.to_string())
                }
                "notifications.mark_read" => {
                    let request = serde_json::from_value(params.clone())
                        .map_err(|error| format!("invalid notifications payload: {error}"))?;
                    serde_json::to_value(self.notifications_mark_read(&request).await)
                        .map_err(|error| error.to_string())
                }
                "control.get" => {
                    let request = serde_json::from_value::<ControlGetRequest>(params.clone())
                        .map_err(|error| format!("invalid control read payload: {error}"))?;
                    let context = ControlRequestContext {
                        origin: ControlOrigin::RemoteRpc,
                        ..ControlRequestContext::default()
                    };
                    serde_json::to_value(
                        self.control_get(request, &context)
                            .await
                            .map_err(|error| error.0.message)?,
                    )
                    .map_err(|error| format!("failed to serialize control read: {error}"))
                }
                "control.execute" => {
                    let request = serde_json::from_value::<ControlExecuteRequest>(params.clone())
                        .map_err(|error| {
                        format!("invalid control operation payload: {error}")
                    })?;
                    let context = ControlRequestContext {
                        origin: ControlOrigin::RemoteRpc,
                        ..ControlRequestContext::default()
                    };
                    serde_json::to_value(self.control_execute(request, &context).await)
                        .map_err(|error| format!("failed to serialize control result: {error}"))
                }
                "speech.status" => serde_json::to_value(
                    self.speech_credential_status()
                        .await
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("failed to serialize speech status: {error}")),
                "speech.models" => serde_json::to_value(
                    self.speech_models()
                        .await
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("failed to serialize speech models: {error}")),
                "speech.transcribe" => {
                    let request =
                        serde_json::from_value::<super::SpeechTranscriptionRequest>(params.clone())
                            .map_err(|error| {
                                format!("invalid speech transcription payload: {error}")
                            })?;
                    serde_json::to_value(
                        self.transcribe_speech(request)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize transcription: {error}"))
                }
                "speech.synthesize" => {
                    let request =
                        serde_json::from_value::<super::SpeechSynthesisRequest>(params.clone())
                            .map_err(|error| {
                                format!("invalid speech synthesis payload: {error}")
                            })?;
                    serde_json::to_value(
                        self.synthesize_speech(request)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize speech audio: {error}"))
                }
                "providers.read" => {
                    let state_dir = self
                        .state_dir()
                        .ok_or_else(|| "daemon state directory unavailable".to_string())?;
                    Ok(crate::acp::providers_overview(&state_dir))
                }
                "providers.update" => {
                    let state_dir = self
                        .state_dir()
                        .ok_or_else(|| "daemon state directory unavailable".to_string())?;
                    let providers = params
                        .get("providers")
                        .cloned()
                        .ok_or_else(|| "missing providers payload".to_string())?;
                    let result = crate::acp::write_providers_file(&state_dir, &providers)
                        .map(|()| serde_json::json!({ "ok": true }));
                    if result.is_ok() {
                        tracing::info!("agent providers updated by a paired device");
                    }
                    result
                }
                "harnesses.read" => serde_json::to_value(self.harnesses_overview().await)
                    .map_err(|error| format!("failed to serialize harnesses: {error}")),
                "providers.usage" => {
                    let refresh = params
                        .get("refresh")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    serde_json::to_value(self.provider_usage_overview(refresh).await)
                        .map_err(|error| format!("failed to serialize provider usage: {error}"))
                }
                "providers.usage.consumeReset" => {
                    let request = serde_json::from_value::<
                        falcondeck_core::ConsumeProviderResetCreditRequest,
                    >(params.clone())
                    .unwrap_or_default();
                    serde_json::to_value(
                        self.consume_codex_reset_credit(request)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize reset consume: {error}"))
                }
                "harnesses.refresh" => {
                    let request = serde_json::from_value::<falcondeck_core::HarnessRefreshRequest>(
                        params.clone(),
                    )
                    .map_err(|error| format!("invalid harness refresh payload: {error}"))?;
                    serde_json::to_value(
                        self.refresh_harnesses(request)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize harnesses: {error}"))
                }
                "harnesses.upgrade" => {
                    let request = serde_json::from_value::<falcondeck_core::HarnessUpgradeRequest>(
                        params.clone(),
                    )
                    .map_err(|error| format!("invalid harness upgrade payload: {error}"))?;
                    serde_json::to_value(
                        self.start_harness_upgrade(request)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize harness job: {error}"))
                }
                "harnesses.job" => {
                    let job_id = required(&["jobId", "job_id"])?;
                    serde_json::to_value(
                        self.harness_upgrade_job(&job_id)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize harness job: {error}"))
                }
                "extensions.read" => serde_json::to_value(self.extension_snapshot().await)
                    .map_err(|error| format!("failed to serialize extensions: {error}")),
                "extensions.update" => {
                    let extension_id = required(&["extensionId", "extension_id"])?;
                    let enabled = params
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| "invalid remote rpc payload".to_string())?;
                    serde_json::to_value(
                        self.update_extension(&extension_id, enabled)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize extension: {error}"))
                }
                "extensions.permission.update" => {
                    let extension_id = required(&["extensionId", "extension_id"])?;
                    let permission = required(&["permission"])?;
                    let granted = params
                        .get("granted")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| "invalid remote rpc payload".to_string())?;
                    serde_json::to_value(
                        self.update_extension_permission(&extension_id, &permission, granted)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize extension: {error}"))
                }
                "extensions.action.invoke" => {
                    let extension_id = required(&["extensionId", "extension_id"])?;
                    let action_id = required(&["actionId", "action_id"])?;
                    let target = params
                        .get("target")
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(|_| "invalid extension action target".to_string())?;
                    let request = falcondeck_core::InvokeExtensionActionRequest {
                        target,
                        input: params.get("input").cloned().unwrap_or(Value::Null),
                    };
                    serde_json::to_value(
                        self.invoke_extension_action(&extension_id, &action_id, request)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize extension action: {error}"))
                }
                "scheduled.list" => serde_json::to_value(self.scheduled_tasks().await)
                    .map_err(|error| format!("failed to serialize scheduled tasks: {error}")),
                "scheduled.create" => {
                    let request = serde_json::from_value::<
                        falcondeck_core::CreateScheduledTaskRequest,
                    >(params.clone())
                    .map_err(|error| format!("invalid scheduled task payload: {error}"))?;
                    serde_json::to_value(
                        self.create_scheduled_task(request)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize scheduled task: {error}"))
                }
                "scheduled.detail" => {
                    let task_id = required(&["taskId", "task_id"])?;
                    serde_json::to_value(
                        self.scheduled_task(&task_id)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize scheduled task: {error}"))
                }
                "scheduled.update" => {
                    let task_id = required(&["taskId", "task_id"])?;
                    let request_value = params
                        .get("patch")
                        .cloned()
                        .unwrap_or_else(|| params.clone());
                    let request = serde_json::from_value::<
                        falcondeck_core::UpdateScheduledTaskRequest,
                    >(request_value)
                    .map_err(|error| format!("invalid scheduled task patch: {error}"))?;
                    serde_json::to_value(
                        self.update_scheduled_task(&task_id, request)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize scheduled task: {error}"))
                }
                "scheduled.delete" => {
                    let task_id = required(&["taskId", "task_id"])?;
                    serde_json::to_value(
                        self.delete_scheduled_task(&task_id)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| {
                        format!("failed to serialize scheduled task response: {error}")
                    })
                }
                "scheduled.run" => {
                    let task_id = required(&["taskId", "task_id"])?;
                    serde_json::to_value(
                        self.run_scheduled_task(&task_id)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize scheduled task run: {error}"))
                }
                "scheduled.runs" => {
                    let task_id = required(&["taskId", "task_id"])?;
                    serde_json::to_value(
                        self.scheduled_task_runs(&task_id)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize scheduled task runs: {error}"))
                }
                "connectors.read" => {
                    let workspace_path = self
                        .connectors_rpc_workspace_path(
                            extract_string(&params, &["workspaceId", "workspace_id"]).as_deref(),
                        )
                        .await?;
                    Ok(crate::connectors::connectors_overview(
                        workspace_path.as_deref(),
                    ))
                }
                "connectors.update" => {
                    let scope = params
                        .get("scope")
                        .cloned()
                        .and_then(|value| {
                            serde_json::from_value::<crate::connectors::ConnectorScope>(value).ok()
                        })
                        .ok_or_else(|| "invalid connectors scope".to_string())?;
                    let workspace_path = self
                        .connectors_rpc_workspace_path(
                            extract_string(&params, &["workspaceId", "workspace_id"]).as_deref(),
                        )
                        .await?;
                    let servers = params
                        .get("mcpServers")
                        .or_else(|| params.get("mcp_servers"))
                        .cloned()
                        .ok_or_else(|| "missing mcpServers payload".to_string())?;
                    let result = crate::connectors::write_mcp_servers(
                        scope,
                        workspace_path.as_deref(),
                        &servers,
                    )
                    .map(|()| serde_json::json!({ "ok": true }));
                    if result.is_ok() {
                        tracing::info!(
                            scope = match scope {
                                crate::connectors::ConnectorScope::Global => "global",
                                crate::connectors::ConnectorScope::Workspace => "workspace",
                            },
                            "MCP connectors updated by a paired device"
                        );
                    }
                    result
                }
                "skills.read" => match crate::skill_library::library_root() {
                    Ok(root) => Ok(crate::skill_library::library_overview(&root)),
                    Err(error) => Err(error),
                },
                "skills.registry.search" => {
                    let root = crate::skill_library::library_root()?;
                    let query = extract_string(&params, &["q", "query"]).unwrap_or_default();
                    let limit = params
                        .get("limit")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(30) as usize;
                    crate::skill_library::search_registry(&root, &query, limit).await
                }
                "skills.install" => {
                    let root = crate::skill_library::library_root()?;
                    let source = required(&["source"])?;
                    let skill = required(&["skill"])?;
                    let result = crate::skill_library::install_skill(&root, &source, &skill).await;
                    if result.is_ok() {
                        tracing::info!(skill, source, "skill installed by a paired device");
                    }
                    result
                }
                "skills.uninstall" => {
                    let root = crate::skill_library::library_root()?;
                    let skill = required(&["skill", "name"])?;
                    crate::skill_library::uninstall_skill(&root, &skill)
                        .map(|()| serde_json::json!({ "ok": true }))
                }
                "thread.start" => {
                    let request =
                        parse_start_thread_request(&params).map_err(|error| error.to_string())?;
                    self.start_thread(request)
                        .await
                        .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "thread.fork" => {
                    let request = ForkThreadRequest {
                        workspace_id: required(&["workspaceId", "workspace_id"])?,
                        thread_id: required(&["threadId", "thread_id"])?,
                        last_turn_id: required(&["lastTurnId", "last_turn_id"])?,
                    };
                    self.fork_thread(request)
                        .await
                        .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "thread.detail" => {
                    let request = ThreadDetailRequest {
                        workspace_id: required(&["workspaceId", "workspace_id"])?,
                        thread_id: required(&["threadId", "thread_id"])?,
                        mode: params
                            .get("mode")
                            .cloned()
                            .and_then(|value| {
                                serde_json::from_value::<ThreadDetailMode>(value).ok()
                            })
                            .unwrap_or(ThreadDetailMode::Full),
                        limit: params
                            .get("limit")
                            .and_then(Value::as_u64)
                            .and_then(|value| {
                                (value <= usize::MAX as u64).then_some(value as usize)
                            }),
                        before_item_id: extract_string(
                            &params,
                            &["beforeItemId", "before_item_id"],
                        ),
                        inline_images: params
                            .get("inline_images")
                            .or_else(|| params.get("inlineImages"))
                            .and_then(Value::as_bool),
                        tool_output_bytes: params
                            .get("tool_output_bytes")
                            .or_else(|| params.get("toolOutputBytes"))
                            .and_then(Value::as_u64)
                            .and_then(|value| {
                                (value <= usize::MAX as u64).then_some(value as usize)
                            }),
                        strict_limit: params
                            .get("strict_limit")
                            .or_else(|| params.get("strictLimit"))
                            .and_then(Value::as_bool),
                        compact_workspace: params
                            .get("compact_workspace")
                            .or_else(|| params.get("compactWorkspace"))
                            .and_then(Value::as_bool),
                        refresh_native: params
                            .get("refresh_native")
                            .or_else(|| params.get("refreshNative"))
                            .and_then(Value::as_bool),
                    };
                    self.thread_detail_with_request(&request)
                        .await
                        .and_then(|detail| serde_json::to_value(detail).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                // One full conversation item, with inline image previews and
                // untruncated tool output. Pairs with a `thread.detail` page
                // that asked for `inline_images: false` / `tool_output_bytes`.
                "thread.item" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    let item_id = required(&["itemId", "item_id"])?;
                    self.thread_item(&workspace_id, &thread_id, &item_id)
                        .await
                        .map_err(|error| error.to_string())
                        .and_then(super::workspace_ops::bounded_remote_thread_item)
                }
                "thread.update" => {
                    let request = UpdateThreadRequest {
                        workspace_id: required(&["workspaceId", "workspace_id"])?,
                        thread_id: required(&["threadId", "thread_id"])?,
                        title: extract_string(&params, &["title"]),
                        provider: extract_string(&params, &["provider"])
                            .and_then(parse_agent_provider),
                        model_id: explicit_optional_string(&params, &["modelId", "model_id"]),
                        reasoning_effort: explicit_optional_string(
                            &params,
                            &["reasoningEffort", "reasoning_effort"],
                        ),
                        collaboration_mode_id: explicit_optional_string(
                            &params,
                            &["collaborationModeId", "collaboration_mode_id"],
                        ),
                        service_tier: explicit_optional_string(
                            &params,
                            &["serviceTier", "service_tier"],
                        ),
                        pinned: params.get("pinned").and_then(Value::as_bool),
                        pinned_in_project: params
                            .get("pinnedInProject")
                            .or_else(|| params.get("pinned_in_project"))
                            .and_then(Value::as_bool),
                        acknowledge_interruption: params
                            .get("acknowledgeInterruption")
                            .or_else(|| params.get("acknowledge_interruption"))
                            .and_then(Value::as_bool),
                        permission_mode: explicit_optional_string(
                            &params,
                            &["permissionMode", "permission_mode"],
                        ),
                        approval_policy: explicit_optional_string(
                            &params,
                            &["approvalPolicy", "approval_policy"],
                        ),
                        sandbox_mode: explicit_optional_string(
                            &params,
                            &["sandboxMode", "sandbox_mode"],
                        ),
                    };
                    self.update_thread(request)
                        .await
                        .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "thread.suggestTitle" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    self.suggest_thread_title(&workspace_id, &thread_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "routing.preview" => {
                    let request = serde_json::from_value::<falcondeck_core::RoutePreviewRequest>(
                        params.clone(),
                    )
                    .map_err(|error| format!("invalid routing preview: {error}"))?;
                    self.preview_route(request)
                        .await
                        .and_then(|decision| serde_json::to_value(decision).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "workspace.connect" => {
                    let request = falcondeck_core::ConnectWorkspaceRequest {
                        path: required(&["path"])?,
                        kind: falcondeck_core::WorkspaceKind::Project,
                    };
                    self.connect_workspace(request)
                        .await
                        .and_then(|workspace| {
                            serde_json::to_value(workspace).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "bots.mutate" => self
                    .mutate_bot(serde_json::from_value(params.clone()).map_err(|e| e.to_string())?)
                    .await
                    .map_err(|e| e.to_string()),
                "bots.documents" => serde_json::to_value(
                    self.bot_documents(&required(&["id"])?)
                        .await
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string()),
                "bots.document.read" => serde_json::to_value(
                    self.read_bot_document(&required(&["id"])?, &required(&["name"])?)
                        .await
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string()),
                "bots.document.mutate" => self
                    .mutate_bot_document(
                        &required(&["id"])?,
                        serde_json::from_value(
                            params.get("mutation").cloned().unwrap_or(Value::Null),
                        )
                        .map_err(|e| e.to_string())?,
                    )
                    .await
                    .map_err(|e| e.to_string()),
                "bots.context" => serde_json::to_value(
                    self.bot_context_report(&required(&["id"])?)
                        .await
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string()),
                "context_files.list" => {
                    serde_json::to_value(self.context_files().await.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())
                }
                "context_files.read" => serde_json::to_value(
                    self.read_context_file(&required(&["path"])?)
                        .await
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string()),
                "context_files.write" => serde_json::to_value(
                    self.write_context_file(
                        serde_json::from_value(params.clone()).map_err(|e| e.to_string())?,
                    )
                    .await
                    .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string()),
                "chat.create" => {
                    if params.get("create").and_then(Value::as_bool) != Some(true) {
                        return Err("invalid remote rpc payload: create must be true".to_string());
                    }
                    self.create_chat()
                        .await
                        .and_then(|workspace| {
                            serde_json::to_value(workspace).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "workspace.remove" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    self.remove_workspace(&workspace_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "workspace.close" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    self.close_workspace(&workspace_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "provider.hydrate" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let provider = required(&["provider"])?;
                    self.schedule_provider_metadata_hydration(
                        &workspace_id,
                        &falcondeck_core::AgentProvider::new(provider),
                    );
                    Ok(serde_json::json!({ "ok": true }))
                }
                "workspace.skills" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let provider = extract_string(&params, &["provider"])
                        .map(falcondeck_core::AgentProvider::new);
                    self.list_workspace_skills(&workspace_id, provider.as_ref())
                        .await
                        .and_then(|skills| {
                            serde_json::to_value(falcondeck_core::WorkspaceSkillsResponse {
                                skills,
                            })
                            .map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "workspace.prompts" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    self.list_workspace_prompts(&workspace_id)
                        .await
                        .and_then(|prompts| {
                            serde_json::to_value(falcondeck_core::WorkspacePromptsResponse {
                                prompts,
                            })
                            .map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "workspace.files" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = extract_string(&params, &["threadId", "thread_id"]);
                    let query = extract_string(&params, &["query"]);
                    self.workspace_files(&workspace_id, thread_id.as_deref(), query.as_deref())
                        .await
                        .and_then(|files| serde_json::to_value(files).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "workspace.file.read" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = extract_string(&params, &["threadId", "thread_id"]);
                    let path = required(&["path"])?;
                    self.workspace_file(&workspace_id, thread_id.as_deref(), &path)
                        .await
                        .and_then(|file| serde_json::to_value(file).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "file.stat" => {
                    let path = required(&["path"])?;
                    let access = self.file_preview_access(&params).await;
                    crate::file_preview::stat(&access.policy, access.target(&path))
                        .await
                        .and_then(|meta| serde_json::to_value(meta).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "file.read_range" => {
                    let path = required(&["path"])?;
                    let access = self.file_preview_access(&params).await;
                    let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
                    let length = params
                        .get("length")
                        .and_then(Value::as_u64)
                        .unwrap_or(crate::file_preview::MAX_RANGE_BYTES);
                    let version = extract_string(&params, &["version"]);
                    let compress = params.get("compress").and_then(Value::as_bool) == Some(true);
                    crate::file_preview::read_range(
                        &access.policy,
                        access.target(&path),
                        offset,
                        length,
                        version.as_deref(),
                        compress,
                    )
                    .await
                    .and_then(|range| serde_json::to_value(range).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
                }
                "workspace.icon" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let icon = self
                        .workspace_icon(&workspace_id)
                        .await
                        .map_err(|error| error.to_string())?;
                    let mut value = serde_json::json!({
                        "kind": icon.meta.kind,
                        "etag": icon.meta.etag,
                        "source": icon.meta.source,
                        "domain": icon.meta.domain,
                    });
                    if let (Some(bytes), Some(content_type)) = (icon.bytes, icon.content_type) {
                        value["content_type"] = serde_json::Value::String(content_type);
                        value["data"] = serde_json::Value::String(base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            bytes,
                        ));
                    }
                    Ok(value)
                }
                "workspace.file.write" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = extract_string(&params, &["threadId", "thread_id"]);
                    let path = required(&["path"])?;
                    let request = falcondeck_core::WriteWorkspaceFileRequest {
                        content: required(&["content"])?,
                        expected_version: extract_string(
                            &params,
                            &["expectedVersion", "expected_version"],
                        ),
                    };
                    self.write_workspace_file(&workspace_id, thread_id.as_deref(), &path, &request)
                        .await
                        .and_then(|file| serde_json::to_value(file).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "git.status" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = extract_string(&params, &["threadId", "thread_id"]);
                    self.git_status(&workspace_id, thread_id.as_deref())
                        .await
                        .and_then(|status| serde_json::to_value(status).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "git.diff" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = extract_string(&params, &["threadId", "thread_id"]);
                    let path = extract_string(&params, &["path"]);
                    let status = params
                        .get("status")
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok());
                    self.git_diff(
                        &workspace_id,
                        thread_id.as_deref(),
                        path.as_deref(),
                        status.as_ref(),
                    )
                    .await
                    .and_then(|diff| serde_json::to_value(diff).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
                }
                "git.commit" => {
                    let request = falcondeck_core::GitCommitRequest {
                        workspace_id: required(&["workspaceId", "workspace_id"])?,
                        thread_id: required(&["threadId", "thread_id"])?,
                        message: extract_string(&params, &["message"]),
                    };
                    self.git_commit(&request)
                        .await
                        .and_then(|result| serde_json::to_value(result).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "thread.ship" => {
                    let mode = params
                        .get("mode")
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                        .ok_or_else(|| {
                            "thread.ship requires mode: pr, draft_pr or merge".to_string()
                        })?;
                    let request = falcondeck_core::ShipThreadRequest {
                        workspace_id: required(&["workspaceId", "workspace_id"])?,
                        thread_id: required(&["threadId", "thread_id"])?,
                        mode,
                    };
                    self.ship_thread(&request)
                        .await
                        .and_then(|result| serde_json::to_value(result).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "thread.goal.set" => {
                    let request = falcondeck_core::SetThreadGoalRequest {
                        workspace_id: required(&["workspaceId", "workspace_id"])?,
                        thread_id: required(&["threadId", "thread_id"])?,
                        objective: extract_string(&params, &["objective"]),
                        token_budget: params
                            .get("tokenBudget")
                            .or_else(|| params.get("token_budget"))
                            .and_then(Value::as_i64),
                        status: extract_string(&params, &["status"]),
                    };
                    self.set_thread_goal(request)
                        .await
                        .and_then(|thread| serde_json::to_value(thread).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "thread.goal.clear" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    self.clear_thread_goal(&workspace_id, &thread_id)
                        .await
                        .and_then(|thread| serde_json::to_value(thread).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "thread.compact" => {
                    let request = falcondeck_core::CompactThreadRequest {
                        workspace_id: required(&["workspaceId", "workspace_id"])?,
                        thread_id: required(&["threadId", "thread_id"])?,
                        instructions: extract_string(&params, &["instructions"]),
                    };
                    self.compact_thread(request)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "thread.mark_read" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    let read_seq = params
                        .get("readSeq")
                        .or_else(|| params.get("read_seq"))
                        .and_then(Value::as_u64)
                        .ok_or_else(|| "invalid remote rpc payload".to_string())?;
                    self.mark_thread_read(&workspace_id, &thread_id, read_seq)
                        .await
                        .and_then(|thread| serde_json::to_value(thread).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                "thread.mark_unread" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    self.mark_thread_unread(&workspace_id, &thread_id)
                        .await
                        .and_then(|thread| serde_json::to_value(thread).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
                }
                // `turn.steer` is `turn.start` with steering forced on, so a
                // remote client can ask for it without the daemon having to
                // know whether that client knows about the `steer` field.
                "turn.start" | "turn.steer" => {
                    let request = SendTurnRequest {
                        workspace_id: required(&["workspaceId", "workspace_id"])?,
                        thread_id: required(&["threadId", "thread_id"])?,
                        // A malformed inputs array must fail the call: `.ok()`
                        // here silently emptied the whole prompt and the turn
                        // went out as "[empty prompt]".
                        inputs: match params.get("inputs") {
                            Some(value) => serde_json::from_value(value.clone())
                                .map_err(|_| "invalid remote rpc payload".to_string())?,
                            None => Vec::new(),
                        },
                        selected_skills: params
                            .get("selectedSkills")
                            .or_else(|| params.get("selected_skills"))
                            .cloned()
                            .and_then(|value| serde_json::from_value(value).ok())
                            .unwrap_or_default(),
                        provider: extract_string(&params, &["provider"])
                            .and_then(parse_agent_provider),
                        model_id: extract_string(&params, &["modelId", "model_id"]),
                        reasoning_effort: extract_string(
                            &params,
                            &["reasoningEffort", "reasoning_effort"],
                        ),
                        approval_policy: extract_string(
                            &params,
                            &["approvalPolicy", "approval_policy"],
                        ),
                        service_tier: extract_string(&params, &["serviceTier", "service_tier"]),
                        permission_mode: extract_string(
                            &params,
                            &["permissionMode", "permission_mode"],
                        ),
                        sandbox_mode: extract_string(&params, &["sandboxMode", "sandbox_mode"]),
                        steer: method == "turn.steer"
                            || params
                                .get("steer")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        user_item_id: extract_string(&params, &["userItemId", "user_item_id"]),
                        resume_interrupted: params
                            .get("resumeInterrupted")
                            .or_else(|| params.get("resume_interrupted"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    };
                    self.send_turn(request)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "turn.interrupt" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    self.interrupt_turn(workspace_id, thread_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "interactive.respond" | "approval.respond" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let request_id_param = required(&["requestId", "request_id"])?;
                    let response = parse_interactive_response_params(&params)
                        .map_err(|_| "invalid remote rpc payload".to_string())?;
                    self.respond_to_interactive_request(workspace_id, request_id_param, response)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "preferences.update" => {
                    let request: UpdatePreferencesRequest = serde_json::from_value(params.clone())
                        .map_err(|_| "invalid remote rpc payload".to_string())?;
                    self.update_preferences(request)
                        .await
                        .and_then(|preferences| {
                            serde_json::to_value(preferences).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "computerUse.read" => serde_json::to_value(self.computer_use_status().await)
                    .map_err(|error| format!("failed to serialize computer use status: {error}")),
                "computerUse.update" => {
                    let request = serde_json::from_value::<
                        falcondeck_core::ComputerUseSettingsUpdate,
                    >(params.clone())
                    .map_err(|error| format!("invalid computer use payload: {error}"))?;
                    serde_json::to_value(
                        self.update_computer_use(request)
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("failed to serialize computer use status: {error}"))
                }
                "computerUse.restart" => serde_json::to_value(
                    self.restart_computer_use()
                        .await
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("failed to serialize computer use status: {error}")),
                "computerUse.test" => serde_json::to_value(
                    self.test_computer_use()
                        .await
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("failed to serialize computer use test: {error}")),
                "thread.archive" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    self.archive_thread(&workspace_id, &thread_id)
                        .await
                        .and_then(|summary| {
                            serde_json::to_value(summary).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "thread.archiveAll" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    self.archive_all_threads(&workspace_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "thread.unarchive" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    self.unarchive_thread(&workspace_id, &thread_id)
                        .await
                        .and_then(|summary| {
                            serde_json::to_value(summary).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "thread.delete" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    self.delete_thread(&workspace_id, &thread_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "thread.queue.remove" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    let queued_id = required(&["queuedId", "queued_id"])?;
                    self.remove_queued_turn(&workspace_id, &thread_id, &queued_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "thread.queue.steer" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    let queued_id = required(&["queuedId", "queued_id"])?;
                    self.steer_queued_turn(&workspace_id, &thread_id, &queued_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                "thread.queue.edit" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    let queued_id = required(&["queuedId", "queued_id"])?;
                    let text = required(&["text"])?;
                    self.edit_queued_turn(&workspace_id, &thread_id, &queued_id, &text)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                // Remote clients cannot reach the loopback preview route, so
                // the bytes travel as a data URL over the (encrypted) relay.
                // Fetched per chip on demand — never folded into the thread
                // summary, which is broadcast on every thread update.
                "thread.queue.attachment_preview" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    let queued_id = required(&["queuedId", "queued_id"])?;
                    self.queued_turn_attachment_preview_data_url(
                        &workspace_id,
                        &thread_id,
                        &queued_id,
                    )
                    .await
                    .map(|url| serde_json::json!({ "url": url }))
                    .map_err(|error| error.to_string())
                }
                "thread.queue.reorder" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = required(&["threadId", "thread_id"])?;
                    let queued_ids = params
                        .get("queued_ids")
                        .or_else(|| params.get("queuedIds"))
                        .and_then(serde_json::Value::as_array)
                        .ok_or_else(|| "missing queued_ids".to_string())?
                        .iter()
                        .map(|value| value.as_str().map(str::to_string))
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| "queued_ids must be strings".to_string())?;
                    self.reorder_queued_turns(&workspace_id, &thread_id, &queued_ids)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                        .map_err(|error| error.to_string())
                }
                _ => Err(format!("unsupported remote rpc method `{method}`")),
            }
        }
        .await
    }

    async fn handle_queued_remote_action(
        &self,
        writer: &mut RelayWriter,
        data_key: &[u8; 32],
        action_id: String,
        action_type: String,
        payload: EncryptedEnvelope,
    ) -> Result<(), String> {
        let params: Value = match decrypt_json(data_key, &payload) {
            Ok(params) => params,
            Err(error) => {
                tracing::warn!("failed to decrypt queued action payload: {error}");
                self.send_remote_action_failure(writer, action_id, "invalid queued action payload")
                    .await?;
                return Ok(());
            }
        };
        let required = |keys: &[&str]| extract_string(&params, keys);

        send_relay_message(
            writer,
            &RelayClientMessage::ActionUpdate {
                action_id: action_id.clone(),
                status: falcondeck_core::QueuedRemoteActionStatus::Executing,
                error: None,
                result: None,
            },
        )
        .await?;

        let outcome: Result<Value, DaemonError> = match action_type.as_str() {
            "preferences.update" => {
                match serde_json::from_value::<UpdatePreferencesRequest>(params.clone()) {
                    Ok(request) => self
                        .update_preferences(request)
                        .await
                        .and_then(|preferences| {
                            serde_json::to_value(preferences).map_err(DaemonError::from)
                        }),
                    Err(_) => Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    )),
                }
            }
            "thread.start" => match parse_start_thread_request(&params) {
                Ok(request) => self
                    .start_thread(request)
                    .await
                    .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from)),
                Err(error) => Err(error),
            },
            "thread.update" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    let request = UpdateThreadRequest {
                        workspace_id,
                        thread_id,
                        title: extract_string(&params, &["title"]),
                        provider: extract_string(&params, &["provider"])
                            .and_then(parse_agent_provider),
                        model_id: explicit_optional_string(&params, &["modelId", "model_id"]),
                        reasoning_effort: explicit_optional_string(
                            &params,
                            &["reasoningEffort", "reasoning_effort"],
                        ),
                        collaboration_mode_id: explicit_optional_string(
                            &params,
                            &["collaborationModeId", "collaboration_mode_id"],
                        ),
                        service_tier: explicit_optional_string(
                            &params,
                            &["serviceTier", "service_tier"],
                        ),
                        pinned: params.get("pinned").and_then(Value::as_bool),
                        pinned_in_project: params
                            .get("pinnedInProject")
                            .or_else(|| params.get("pinned_in_project"))
                            .and_then(Value::as_bool),
                        acknowledge_interruption: params
                            .get("acknowledgeInterruption")
                            .or_else(|| params.get("acknowledge_interruption"))
                            .and_then(Value::as_bool),
                        permission_mode: explicit_optional_string(
                            &params,
                            &["permissionMode", "permission_mode"],
                        ),
                        approval_policy: explicit_optional_string(
                            &params,
                            &["approvalPolicy", "approval_policy"],
                        ),
                        sandbox_mode: explicit_optional_string(
                            &params,
                            &["sandboxMode", "sandbox_mode"],
                        ),
                    };
                    self.update_thread(request)
                        .await
                        .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.mark_read" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    if let Some(read_seq) = params
                        .get("readSeq")
                        .or_else(|| params.get("read_seq"))
                        .and_then(Value::as_u64)
                    {
                        self.mark_thread_read(&workspace_id, &thread_id, read_seq)
                            .await
                            .and_then(|thread| {
                                serde_json::to_value(thread).map_err(DaemonError::from)
                            })
                    } else {
                        Err(DaemonError::BadRequest(
                            "invalid queued action payload".to_string(),
                        ))
                    }
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.mark_unread" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    self.mark_thread_unread(&workspace_id, &thread_id)
                        .await
                        .and_then(|thread| serde_json::to_value(thread).map_err(DaemonError::from))
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "turn.start" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    let inputs = params
                        .get("inputs")
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                        .unwrap_or_default();
                    let request = SendTurnRequest {
                        workspace_id,
                        thread_id,
                        inputs,
                        selected_skills: params
                            .get("selectedSkills")
                            .or_else(|| params.get("selected_skills"))
                            .cloned()
                            .and_then(|value| serde_json::from_value(value).ok())
                            .unwrap_or_default(),
                        provider: extract_string(&params, &["provider"])
                            .and_then(parse_agent_provider),
                        model_id: extract_string(&params, &["modelId", "model_id"]),
                        reasoning_effort: extract_string(
                            &params,
                            &["reasoningEffort", "reasoning_effort"],
                        ),
                        approval_policy: extract_string(
                            &params,
                            &["approvalPolicy", "approval_policy"],
                        ),
                        service_tier: extract_string(&params, &["serviceTier", "service_tier"]),
                        permission_mode: extract_string(
                            &params,
                            &["permissionMode", "permission_mode"],
                        ),
                        sandbox_mode: extract_string(&params, &["sandboxMode", "sandbox_mode"]),
                        // A queued action replays after a reconnect, long
                        // after the turn it would have steered ended.
                        steer: false,
                        user_item_id: extract_string(&params, &["userItemId", "user_item_id"]),
                        resume_interrupted: params
                            .get("resumeInterrupted")
                            .or_else(|| params.get("resume_interrupted"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    };
                    self.send_turn(request).await.and_then(|response| {
                        serde_json::to_value(response).map_err(DaemonError::from)
                    })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "turn.interrupt" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    self.interrupt_turn(workspace_id, thread_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.archive" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    self.archive_thread(&workspace_id, &thread_id)
                        .await
                        .and_then(|summary| {
                            serde_json::to_value(summary).map_err(DaemonError::from)
                        })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.archiveAll" => {
                if let Some(workspace_id) = required(&["workspaceId", "workspace_id"]) {
                    self.archive_all_threads(&workspace_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.unarchive" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    self.unarchive_thread(&workspace_id, &thread_id)
                        .await
                        .and_then(|summary| {
                            serde_json::to_value(summary).map_err(DaemonError::from)
                        })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "thread.delete" => {
                if let (Some(workspace_id), Some(thread_id)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["threadId", "thread_id"]),
                ) {
                    self.delete_thread(&workspace_id, &thread_id)
                        .await
                        .and_then(|response| {
                            serde_json::to_value(response).map_err(DaemonError::from)
                        })
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "interactive.respond" | "approval.respond" => {
                if let (Some(workspace_id), Some(request_id_param)) = (
                    required(&["workspaceId", "workspace_id"]),
                    required(&["requestId", "request_id"]),
                ) {
                    match parse_interactive_response_params(&params).map_err(|_| {
                        DaemonError::BadRequest("invalid queued action payload".to_string())
                    }) {
                        Ok(response) => self
                            .respond_to_interactive_request(
                                workspace_id,
                                request_id_param,
                                response,
                            )
                            .await
                            .and_then(|response| {
                                serde_json::to_value(response).map_err(DaemonError::from)
                            }),
                        Err(error) => Err(error),
                    }
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
            "computerUse.update" => {
                match serde_json::from_value::<falcondeck_core::ComputerUseSettingsUpdate>(
                    params.clone(),
                ) {
                    Ok(request) => self
                        .update_computer_use(request)
                        .await
                        .and_then(|status| serde_json::to_value(status).map_err(DaemonError::from)),
                    Err(_) => Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    )),
                }
            }
            "computerUse.restart" => self
                .restart_computer_use()
                .await
                .and_then(|status| serde_json::to_value(status).map_err(DaemonError::from)),
            "computerUse.test" => self
                .test_computer_use()
                .await
                .and_then(|status| serde_json::to_value(status).map_err(DaemonError::from)),
            other => Err(DaemonError::BadRequest(format!(
                "unsupported queued action `{other}`"
            ))),
        };

        match outcome {
            Ok(value) => {
                send_relay_message(
                    writer,
                    &RelayClientMessage::ActionUpdate {
                        action_id,
                        status: falcondeck_core::QueuedRemoteActionStatus::Completed,
                        error: None,
                        result: Some(encrypt_json(data_key, &value).map_err(|error| {
                            format!("failed to encrypt queued action result: {error}")
                        })?),
                    },
                )
                .await?;
            }
            Err(error) => {
                send_relay_message(
                    writer,
                    &RelayClientMessage::ActionUpdate {
                        action_id,
                        status: falcondeck_core::QueuedRemoteActionStatus::Failed,
                        error: Some(error.to_string()),
                        result: None,
                    },
                )
                .await?;
            }
        }

        Ok(())
    }
}

// Live RPC and queued actions must preserve the same execution owner. A
// misspelled target must never fall back to running on the coordinator.
fn parse_start_thread_request(params: &Value) -> Result<StartThreadRequest, DaemonError> {
    let execution_target = match params
        .get("execution_target")
        .or_else(|| params.get("executionTarget"))
    {
        None => Default::default(),
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| {
            DaemonError::BadRequest("execution_target must be local or cloud".into())
        })?,
    };
    Ok(StartThreadRequest {
        workspace_id: extract_string(params, &["workspaceId", "workspace_id"])
            .ok_or_else(|| DaemonError::BadRequest("workspace_id is required".into()))?,
        provider: extract_string(params, &["provider"]).and_then(parse_agent_provider),
        model_id: extract_string(params, &["modelId", "model_id"]),
        collaboration_mode_id: extract_string(
            params,
            &["collaborationModeId", "collaboration_mode_id"],
        ),
        approval_policy: extract_string(params, &["approvalPolicy", "approval_policy"]),
        sandbox_mode: extract_string(params, &["sandboxMode", "sandbox_mode"]),
        permission_mode: extract_string(params, &["permissionMode", "permission_mode"]),
        isolation: parse_thread_isolation(params),
        execution_target,
        idempotency_key: extract_string(params, &["idempotencyKey", "idempotency_key"]),
        handoff_from: params
            .get("handoffFrom")
            .or_else(|| params.get("handoff_from"))
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        handoff_context: extract_string(params, &["handoffContext", "handoff_context"]),
    })
}

pub(super) fn notification_thread_title(title: &str) -> Option<String> {
    const MAX_TITLE_CHARS: usize = 256;

    let title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect::<String>();
    (!title.is_empty()).then_some(title)
}

fn relay_ws_ticket_request(
    client: &reqwest::Client,
    relay_url: &str,
    session_id: &str,
    daemon_token: &str,
) -> reqwest::RequestBuilder {
    client
        .post(format!(
            "{}/v1/sessions/{}/ws-ticket",
            relay_url.trim_end_matches('/'),
            session_id
        ))
        .bearer_auth(daemon_token)
        .timeout(RELAY_HTTP_REQUEST_TIMEOUT)
}

pub(super) fn normalize_relay_url(input: &str) -> Result<String, DaemonError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(DaemonError::BadRequest("relay_url is required".to_string()));
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| {
        DaemonError::BadRequest("relay_url must be a valid absolute URL".to_string())
    })?;
    let is_loopback = parsed
        .host_str()
        .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && is_loopback) {
        return Err(DaemonError::BadRequest(
            "relay_url must use HTTPS (HTTP is allowed only for loopback development)".to_string(),
        ));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(DaemonError::BadRequest(
            "relay_url must not contain credentials, a query, or a fragment".to_string(),
        ));
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

pub(super) fn relay_ws_url(relay_url: &str, session_id: &str, ticket: &str) -> String {
    let base = if let Some(rest) = relay_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = relay_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        relay_url.to_string()
    };
    format!("{base}/v1/updates/ws?session_id={session_id}&ticket={ticket}&transport=chunks-v1")
}

pub(super) fn relay_url_looks_legacy_loopback(relay_url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(relay_url) else {
        return false;
    };

    matches!(
        parsed.host_str(),
        Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
    )
}

pub(super) fn host_label() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "FalconDeck desktop".to_string())
}

/// Parses and verifies a `request-bootstrap` ephemeral body sent by a trusted
/// client that lost its session data key. Returns the verified client bundle,
/// or `None` when the body is not a bootstrap request, the bundle is
/// malformed, or its signature does not verify. Signature validity only
/// proves the sender holds the bundle's own keys — anyone can self-sign a
/// fresh bundle — so the caller must additionally check the bundle against
/// the daemon's trusted-client-bundle allowlist before serving the data key.
pub(super) fn parse_bootstrap_request(body: &Value) -> Option<PairingPublicKeyBundle> {
    if body.get("kind").and_then(Value::as_str) != Some("request-bootstrap") {
        return None;
    }
    let bundle_value = body.get("client_bundle")?;
    let client_bundle = match serde_json::from_value::<PairingPublicKeyBundle>(bundle_value.clone())
    {
        Ok(client_bundle) => client_bundle,
        Err(error) => {
            tracing::warn!("ignoring bootstrap request with malformed client bundle: {error}");
            return None;
        }
    };
    if let Err(error) = verify_pairing_public_key_bundle(&client_bundle) {
        tracing::warn!("ignoring bootstrap request with invalid client bundle signature: {error}");
        return None;
    }
    Some(client_bundle)
}

/// True when the requesting bundle exactly matches (encryption public key AND
/// identity public key) a bundle that completed pairing on this daemon.
pub(super) fn is_trusted_client_bundle(
    trusted: &[PairingPublicKeyBundle],
    bundle: &PairingPublicKeyBundle,
) -> bool {
    trusted.iter().any(|candidate| {
        candidate.public_key == bundle.public_key
            && candidate.identity_public_key == bundle.identity_public_key
    })
}

pub(super) fn encrypt_remote_daemon_event(
    data_key: &[u8; 32],
    event: &EventEnvelope,
) -> Result<EncryptedEnvelope, String> {
    #[derive(Serialize)]
    struct RemoteDaemonEventEnvelope<'a> {
        // Keep the discriminator before `event`: clients can identify and
        // skip a replayed full snapshot without parsing its multi-megabyte
        // payload while an authoritative snapshot RPC is already in flight.
        kind: &'static str,
        event: &'a EventEnvelope,
    }

    let mut envelope = encrypt_json(
        data_key,
        &RemoteDaemonEventEnvelope {
            kind: "daemon-event",
            event,
        },
    )
    .map_err(|error| format!("failed to encrypt relay update: {error}"))?;
    envelope.snapshot_hint = matches!(event.event, UnifiedEvent::Snapshot { .. });
    envelope.scope_hint = scope::scope_hint(data_key, event);
    Ok(envelope)
}

fn snapshot_invalidation(data_key: &[u8; 32]) -> Result<RelayClientMessage, String> {
    // Persist ordinary encrypted data so older relays can still restore their
    // replay store after rollback. Only opted-in peers receive a thin marker.
    let mut envelope = encrypt_json(data_key, &json!({ "kind": "sync-invalidated" }))
        .map_err(|e| e.to_string())?;
    envelope.snapshot_hint = true;
    Ok(RelayClientMessage::Update {
        body: RelayUpdateBody::Encrypted { envelope },
    })
}

fn remote_event_message(
    data_key: &[u8; 32],
    event: &EventEnvelope,
    full_snapshots_required: bool,
    lean_events: bool,
) -> Result<RelayClientMessage, String> {
    if !full_snapshots_required && matches!(event.event, UnifiedEvent::Snapshot { .. }) {
        return snapshot_invalidation(data_key);
    }
    // Lean summaries are durable in relay replay, but a legacy client joining
    // flips `full_snapshots_required`, which pushes a fresh full snapshot
    // after (higher seq than) every stripped summary, so replay still ends
    // in complete state. Do not weaken that transition without revisiting this.
    // Copy only the rare thread summary that still carries a diff or plan.
    let lean = lean_events
        .then(|| scope::lean_thread_event(event))
        .flatten();
    let envelope = encrypt_remote_daemon_event(data_key, lean.as_ref().unwrap_or(event))?;
    if matches!(
        event.event,
        UnifiedEvent::RealtimeAudioStarted { .. }
            | UnifiedEvent::RealtimeAudioDelta { .. }
            | UnifiedEvent::RealtimeAudioEnded { .. }
            | UnifiedEvent::RealtimeItemAdded { .. }
    ) {
        return Ok(RelayClientMessage::Ephemeral {
            body: json!({
                "kind": "encrypted-daemon-event",
                "envelope": envelope,
            }),
        });
    }
    Ok(RelayClientMessage::Update {
        body: RelayUpdateBody::Encrypted { envelope },
    })
}

/// One control message per method: wait for lane capacity so the method count
/// can outgrow the control queue without dropping the connection.
async fn register_remote_rpc_methods(writer: &mut RelayWriter) -> Result<(), String> {
    for method in REMOTE_RPC_METHODS {
        let payload = serde_json::to_string(&RelayClientMessage::RpcRegister {
            method: (*method).to_string(),
        })
        .map_err(|error| format!("failed to encode relay message: {error}"))?;
        writer.send_control_wait(payload).await?;
    }
    Ok(())
}

async fn send_remote_events(
    writer: RelayWriter,
    data_key: [u8; 32],
    key_generation: u64,
    events: Vec<Arc<CachedEnvelope>>,
) -> Result<(), String> {
    for event in events {
        let message = remote_event_message(
            &data_key,
            &event,
            writer.full_snapshots_required,
            writer.lean_events,
        )?;
        send_ordered_relay_message(&writer, &message, key_generation).await?;
    }
    Ok(())
}

async fn send_ordered_relay_message(
    writer: &RelayWriter,
    message: &RelayClientMessage,
    key_generation: u64,
) -> Result<(), String> {
    let payload = serde_json::to_string(message)
        .map_err(|error| format!("failed to encode relay message: {error}"))?;
    writer.send_ordered(payload, key_generation).await
}

async fn send_relay_message(
    writer: &RelayWriter,
    message: &RelayClientMessage,
) -> Result<(), String> {
    let payload = serde_json::to_string(message)
        .map_err(|error| format!("failed to encode relay message: {error}"))?;
    let control = matches!(
        message,
        RelayClientMessage::Ping
            | RelayClientMessage::RpcRegister { .. }
            | RelayClientMessage::RpcUnregister { .. }
    );
    // A push counts as delivered, so it has to reach the socket, not the queue.
    if matches!(
        message,
        RelayClientMessage::Notify { .. }
            | RelayClientMessage::Update {
                body: RelayUpdateBody::SessionBootstrap { .. }
            }
    ) {
        writer.send_barrier(payload).await
    } else if control {
        writer.send_control(payload)
    } else {
        writer.send(
            payload,
            matches!(message, RelayClientMessage::RpcResult { .. }),
        )
    }
}

/// Reads a string field that distinguishes "absent" from an explicit `null`:
/// a missing key yields `None`, a present key yields `Some(value_or_none)`.
fn explicit_optional_string(params: &Value, keys: &[&str]) -> Option<Option<String>> {
    keys.iter()
        .find_map(|key| params.get(key))
        .map(|value| value.as_str().map(ToOwned::to_owned))
}

#[cfg(test)]
#[path = "remote_bridge_backpressure_tests.rs"]
mod backpressure_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::CachedEnvelope;
    use falcondeck_core::crypto::decrypt_bytes;
    use falcondeck_core::{ContentLifecycle, ThreadStatus};
    use std::sync::Arc;

    fn coalescer_thread_summary(
        status: ThreadStatus,
        title: &str,
    ) -> falcondeck_core::ThreadSummary {
        falcondeck_core::ThreadSummary {
            execution_target: Default::default(),
            cloud: None,
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: title.to_string(),
            provider: falcondeck_core::AgentProvider::CODEX,
            native_session_id: None,
            provider_transport: None,
            handoff_from: None,
            origin: None,
            status,
            updated_at: Utc::now(),
            last_message_preview: None,
            last_message_at: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: None,
            last_tool: None,
            last_error: None,
            agent: Default::default(),
            attention: Default::default(),
            is_archived: false,
            is_pinned: false,
            is_pinned_in_project: false,
            goal: None,
            queued_turns: Vec::new(),
            variant: None,
        }
    }

    fn coalescer_event(seq: u64, event: UnifiedEvent) -> Arc<CachedEnvelope> {
        Arc::new(CachedEnvelope::new(EventEnvelope {
            seq,
            emitted_at: Utc::now(),
            workspace_id: Some("workspace-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            event,
        }))
    }

    fn coalescer_message(seq: u64, text: &str, lifecycle: ContentLifecycle) -> Arc<CachedEnvelope> {
        coalescer_event(
            seq,
            UnifiedEvent::ConversationItemUpdated {
                item: falcondeck_core::ConversationItem::AssistantMessage {
                    id: "item-1".to_string(),
                    text: text.to_string(),
                    phase: None,
                    memory_citation: None,
                    citations: Vec::new(),
                    lifecycle,
                    error: None,
                    created_at: Utc::now(),
                },
            },
        )
    }

    fn coalescer_text_delta(
        seq: u64,
        delta: &str,
        start_offset: u64,
        end_offset: u64,
    ) -> Arc<CachedEnvelope> {
        coalescer_event(
            seq,
            UnifiedEvent::Text {
                item_id: "item-1".to_string(),
                delta: delta.to_string(),
                target: falcondeck_core::TextDeltaTarget::AssistantText,
                start_offset: Some(start_offset),
                end_offset: Some(end_offset),
            },
        )
    }

    fn coalesced_texts(events: &[Arc<CachedEnvelope>]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match &event.event {
                UnifiedEvent::ConversationItemUpdated {
                    item: falcondeck_core::ConversationItem::AssistantMessage { text, .. },
                } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn coalescer_keeps_only_the_newest_streaming_update() {
        let mut coalescer = EventCoalescer::default();

        for (index, text) in ["a", "ab", "abc"].iter().enumerate() {
            let outgoing = coalescer.push(coalescer_message(
                index as u64,
                text,
                ContentLifecycle::Streaming,
            ));
            assert!(
                outgoing.is_empty(),
                "streaming chunks should be held, not forwarded one by one"
            );
        }

        let drained = coalescer.drain();
        assert_eq!(coalesced_texts(&drained), vec!["abc".to_string()]);
        assert!(coalescer.is_empty());
    }

    #[test]
    fn coalescer_combines_contiguous_text_deltas() {
        let mut coalescer = EventCoalescer::default();
        assert!(
            coalescer
                .push(coalescer_text_delta(1, "hel", 0, 3))
                .is_empty()
        );
        assert!(
            coalescer
                .push(coalescer_text_delta(2, "lo", 3, 5))
                .is_empty()
        );

        let outgoing = coalescer.drain();
        assert_eq!(outgoing.len(), 1);
        assert!(matches!(
            &outgoing[0].event,
            UnifiedEvent::Text {
                delta,
                start_offset: Some(0),
                end_offset: Some(5),
                ..
            } if delta == "hello"
        ));
    }

    #[test]
    fn coalescer_forwards_terminal_updates_immediately() {
        let mut coalescer = EventCoalescer::default();
        assert!(
            coalescer
                .push(coalescer_message(1, "partial", ContentLifecycle::Streaming))
                .is_empty()
        );

        // The final state of an item must never wait in the buffer: a dropped
        // one leaves the client rendering a half-written message forever.
        let outgoing = coalescer.push(coalescer_message(2, "done", ContentLifecycle::Complete));
        // The superseded chunk is dropped rather than sent ahead of it: the
        // terminal update already carries that text.
        assert_eq!(coalesced_texts(&outgoing), vec!["done".to_string()]);
        assert!(coalescer.is_empty());
    }

    #[test]
    fn coalescer_holds_running_summaries_but_not_settled_ones() {
        let mut coalescer = EventCoalescer::default();
        let running = UnifiedEvent::ThreadUpdated {
            thread: coalescer_thread_summary(ThreadStatus::Running, "running"),
        };
        assert!(coalescer.push(coalescer_event(1, running)).is_empty());

        // A terminal summary is what stops the client's spinner.
        let idle = UnifiedEvent::ThreadUpdated {
            thread: coalescer_thread_summary(ThreadStatus::Idle, "idle"),
        };
        let outgoing = coalescer.push(coalescer_event(2, idle));
        assert_eq!(
            outgoing.len(),
            1,
            "the settled summary supersedes the held one"
        );
        assert!(matches!(
            &outgoing[0].event,
            UnifiedEvent::ThreadUpdated { thread } if thread.status == ThreadStatus::Idle
        ));
        assert!(coalescer.is_empty());
    }

    #[test]
    fn coalescer_flushes_held_updates_before_an_unrelated_event() {
        let mut coalescer = EventCoalescer::default();
        assert!(
            coalescer
                .push(coalescer_message(1, "partial", ContentLifecycle::Streaming))
                .is_empty()
        );

        let added = coalescer_event(
            2,
            UnifiedEvent::ConversationItemAdded {
                item: falcondeck_core::ConversationItem::AssistantMessage {
                    id: "item-2".to_string(),
                    text: "next".to_string(),
                    phase: None,
                    memory_citation: None,
                    citations: Vec::new(),
                    lifecycle: ContentLifecycle::Streaming,
                    error: None,
                    created_at: Utc::now(),
                },
            },
        );
        let outgoing = coalescer.push(added);
        // Order matters: the held update describes an earlier moment than the
        // event that displaced it.
        assert_eq!(outgoing.len(), 2);
        assert_eq!(outgoing[0].seq, 1);
        assert_eq!(outgoing[1].seq, 2);
    }

    #[test]
    fn coalescer_keeps_separate_items_and_threads_apart() {
        let mut coalescer = EventCoalescer::default();
        assert!(
            coalescer
                .push(coalescer_message(1, "first", ContentLifecycle::Streaming))
                .is_empty()
        );

        let mut other = coalescer_message(2, "second", ContentLifecycle::Streaming);
        Arc::get_mut(&mut other).map(|cached| {
            cached.envelope.thread_id = Some("thread-2".to_string());
        });
        assert!(coalescer.push(other).is_empty());

        // Same item id, different thread — collapsing these together would
        // drop one conversation's content into another's.
        assert_eq!(coalescer.drain().len(), 2);
    }

    #[test]
    fn notification_titles_are_trimmed_sanitized_and_bounded() {
        assert_eq!(
            notification_thread_title("  Improve\n push notifications  ").as_deref(),
            Some("Improve push notifications")
        );
        assert_eq!(notification_thread_title("\n\t"), None);
        assert_eq!(
            notification_thread_title(&"a".repeat(300))
                .expect("non-empty title")
                .chars()
                .count(),
            256
        );
    }

    fn scoped_test_envelope(event: UnifiedEvent) -> EventEnvelope {
        EventEnvelope {
            seq: 11,
            emitted_at: Utc::now(),
            workspace_id: Some("workspace-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            event,
        }
    }

    fn remote_update_envelope(message: RelayClientMessage) -> EncryptedEnvelope {
        let RelayClientMessage::Update {
            body: RelayUpdateBody::Encrypted { envelope },
        } = message
        else {
            panic!("expected a durable encrypted update");
        };
        envelope
    }

    #[test]
    fn stream_events_carry_the_thread_scope_tag_and_others_stay_untagged() {
        let key = [5u8; 32];
        let stream = scoped_test_envelope(UnifiedEvent::ToolCallStart {
            item_id: "item-1".to_string(),
            title: "ls".to_string(),
            kind: "command".to_string(),
        });
        let envelope = remote_update_envelope(
            remote_event_message(&key, &stream, false, false).expect("encrypted event"),
        );
        assert_eq!(
            envelope.scope_hint,
            Some(scope::scope_tag(&key, "thread-1"))
        );

        let summary = scoped_test_envelope(UnifiedEvent::ThreadUpdated {
            thread: coalescer_thread_summary(ThreadStatus::Running, "t"),
        });
        let envelope = remote_update_envelope(
            remote_event_message(&key, &summary, false, false).expect("encrypted event"),
        );
        assert_eq!(envelope.scope_hint, None);
        // Legacy wire shape: no new key appears when there is no hint.
        let json = serde_json::to_value(&envelope).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["ciphertext", "encryption_variant"]);
    }

    #[test]
    fn lean_events_strip_diff_and_plan_and_non_lean_output_is_unchanged() {
        let key = [4u8; 32];
        let mut thread = coalescer_thread_summary(ThreadStatus::Running, "t");
        thread.latest_diff = Some("diff --git a/x b/x\n+bulky".to_string());
        let event = scoped_test_envelope(UnifiedEvent::ThreadUpdated {
            thread: thread.clone(),
        });

        let decrypted = |lean: bool| -> Vec<u8> {
            let envelope = remote_update_envelope(
                remote_event_message(&key, &event, false, lean).expect("encrypted event"),
            );
            decrypt_bytes(&key, &envelope).expect("decrypt event")
        };
        // Non-lean plaintext is exactly the pre-change daemon-event encoding.
        let expected = serde_json::to_vec(&serde_json::json!({
            "kind": "daemon-event",
            "event": &event,
        }))
        .unwrap();
        let full: Value = serde_json::from_slice(&decrypted(false)).unwrap();
        assert_eq!(full, serde_json::from_slice::<Value>(&expected).unwrap());
        assert_eq!(
            decrypted(false).starts_with(br#"{"kind":"daemon-event","event":"#),
            true
        );

        let lean: Value = serde_json::from_slice(&decrypted(true)).unwrap();
        assert!(lean["event"]["event"]["thread"]["latest_diff"].is_null());
        assert!(lean["event"]["event"]["thread"]["latest_plan"].is_null());
        assert_eq!(lean["event"]["event"]["thread"]["title"], "t");
        assert_eq!(lean["event"]["seq"], 11);
        // The shared original is untouched by the lean projection.
        assert!(matches!(
            &event.event,
            UnifiedEvent::ThreadUpdated { thread } if thread.latest_diff.is_some()
        ));
        // Flipping back restores full summaries immediately.
        let full_again: Value = serde_json::from_slice(&decrypted(false)).unwrap();
        assert!(full_again["event"]["event"]["thread"]["latest_diff"].is_string());
    }

    /// Offline measurement against a real capture of `/api/events`
    /// (`FD_CAPTURE=/path/cap.json`, a JSON array of `{t, e}` where `e` is an
    /// EventEnvelope). Events are pre-coalescer. Sizes are the serialized
    /// daemon->relay messages; the relay adds a ~150 byte update wrapper.
    #[test]
    #[ignore = "needs FD_CAPTURE"]
    fn measure_scoped_lean_projection_on_capture() {
        let path = std::env::var("FD_CAPTURE").expect("set FD_CAPTURE to a capture file");
        let capture: Vec<Value> =
            serde_json::from_slice(&std::fs::read(path).expect("read capture")).expect("json");
        let events: Vec<EventEnvelope> = capture
            .iter()
            .filter_map(|entry| serde_json::from_value(entry["e"].clone()).ok())
            .collect();
        let key = [1u8; 32];
        let mut per_thread = std::collections::HashMap::<String, usize>::new();
        for event in &events {
            if let (true, Some(thread)) = (
                scope::is_stream_class(&event.event),
                event.thread_id.as_ref(),
            ) {
                *per_thread.entry(thread.clone()).or_default() += 1;
            }
        }
        let (open_thread, _) = per_thread
            .iter()
            .max_by_key(|(_, count)| **count)
            .expect("capture has stream events");
        let open_tag = scope::scope_tag(&key, open_thread);

        let measure = |lean: bool, scoped: bool| -> (usize, usize) {
            let (mut count, mut bytes) = (0, 0);
            for event in &events {
                let message =
                    remote_event_message(&key, event, false, lean).expect("encrypted event");
                if let RelayClientMessage::Update {
                    body: RelayUpdateBody::Encrypted { envelope },
                } = &message
                    && scoped
                    && envelope
                        .scope_hint
                        .as_ref()
                        .is_some_and(|tag| *tag != open_tag)
                {
                    continue;
                }
                count += 1;
                bytes += serde_json::to_string(&message).expect("serialize").len();
            }
            (count, bytes)
        };
        let (base_count, base_bytes) = measure(false, false);
        println!(
            "captured={} parsed={} open_thread={open_thread} stream_events_for_it={}",
            capture.len(),
            events.len(),
            per_thread[open_thread]
        );
        for (label, lean, scoped) in [
            ("baseline (legacy)", false, false),
            ("scoped only", false, true),
            ("lean only", true, false),
            ("lean + scoped", true, true),
        ] {
            let (count, bytes) = measure(lean, scoped);
            println!(
                "{label:<18} events={count:>4} bytes={bytes:>8} ({:.0}% of baseline events, {:.0}% of bytes)",
                100.0 * count as f64 / base_count as f64,
                100.0 * bytes as f64 / base_bytes as f64
            );
        }
    }

    #[test]
    fn durable_events_keep_the_legacy_single_event_envelope() {
        let event = EventEnvelope {
            seq: 10,
            emitted_at: Utc::now(),
            workspace_id: Some("workspace-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            event: UnifiedEvent::Stop { reason: None },
        };
        let message = remote_event_message(&[6; 32], &event, true, false).expect("encrypted event");
        let RelayClientMessage::Update {
            body: RelayUpdateBody::Encrypted { envelope },
        } = message
        else {
            panic!("expected a durable encrypted update");
        };
        let payload: Value = decrypt_json(&[6; 32], &envelope).expect("decrypt event");
        assert_eq!(
            payload.get("kind").and_then(Value::as_str),
            Some("daemon-event")
        );
    }

    #[test]
    fn durable_event_prefix_identifies_the_envelope_before_the_event_payload() {
        let event = EventEnvelope {
            seq: 10,
            emitted_at: Utc::now(),
            workspace_id: Some("workspace-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            event: UnifiedEvent::Stop { reason: None },
        };
        let envelope = encrypt_remote_daemon_event(&[6; 32], &event).expect("encrypted event");
        let plaintext = decrypt_bytes(&[6; 32], &envelope).expect("decrypt event");

        assert!(
            plaintext.starts_with(br#"{"kind":"daemon-event","event":"#),
            "the client must identify the envelope before reading a potentially huge event: {}",
            String::from_utf8_lossy(&plaintext),
        );
    }

    #[test]
    fn realtime_audio_uses_encrypted_non_replayed_relay_delivery() {
        let event = EventEnvelope {
            seq: 7,
            emitted_at: Utc::now(),
            workspace_id: Some("workspace-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            event: UnifiedEvent::RealtimeAudioDelta {
                audio: falcondeck_core::RealtimeAudioChunk {
                    item_id: Some("voice-1".to_string()),
                    data: "AAAA".to_string(),
                    sample_rate: 24_000,
                    num_channels: 1,
                    samples_per_channel: Some(1),
                },
            },
        };

        let message = remote_event_message(&[7; 32], &event, true, false).expect("encrypted event");
        assert!(matches!(
            message,
            RelayClientMessage::Ephemeral { body }
                if body.get("kind").and_then(Value::as_str) == Some("encrypted-daemon-event")
                    && body.get("envelope").is_some()
        ));
    }

    #[test]
    fn realtime_items_also_bypass_relay_replay() {
        let event = EventEnvelope {
            seq: 9,
            emitted_at: Utc::now(),
            workspace_id: Some("workspace-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            event: UnifiedEvent::RealtimeItemAdded {
                item: falcondeck_core::RealtimeConversationItem {
                    id: "handoff-1".to_string(),
                    item_type: "handoff_request".to_string(),
                    title: "Voice handoff requested".to_string(),
                    summary: None,
                    payload: json!({ "type": "handoff_request" }),
                    created_at: Utc::now(),
                },
            },
        };

        assert!(matches!(
            remote_event_message(&[9; 32], &event, true, false).expect("encrypted event"),
            RelayClientMessage::Ephemeral { .. }
        ));
    }

    #[test]
    fn durable_daemon_events_still_use_replayed_relay_updates() {
        let event = EventEnvelope {
            seq: 8,
            emitted_at: Utc::now(),
            workspace_id: None,
            thread_id: None,
            event: UnifiedEvent::Stop { reason: None },
        };

        assert!(matches!(
            remote_event_message(&[8; 32], &event, true, false).expect("encrypted event"),
            RelayClientMessage::Update {
                body: RelayUpdateBody::Encrypted { .. }
            }
        ));
    }

    /// Guards the registration↔dispatch invariant: a method advertised to the
    /// relay must have a dispatch arm, or every remote call to it fails with
    /// "unsupported" (the thread.unarchive bug). Empty params are fine — a
    /// dispatched method fails validation ("invalid remote rpc payload",
    /// "workspace not found", …), never the unsupported catch-all.
    #[tokio::test]
    async fn every_registered_remote_rpc_method_dispatches() {
        let temp_dir = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            std::collections::HashMap::new(),
            temp_dir.path().join("daemon-state.json"),
        );
        for method in REMOTE_RPC_METHODS {
            let result = app.dispatch_remote_rpc(method, serde_json::json!({})).await;
            if let Err(error) = &result {
                assert!(
                    !error.contains("unsupported remote rpc method"),
                    "`{method}` is registered with the relay but has no dispatch arm"
                );
            }
        }
    }

    /// Phones open files agents link to through `file.stat`/`file.read_range`.
    /// The roots come from daemon state, so check them end to end.
    #[tokio::test]
    async fn file_preview_rpcs_enforce_the_access_policy() {
        let temp = tempfile::tempdir().unwrap();
        let state_dir = std::fs::canonicalize(temp.path()).unwrap().join("fd-home");
        let artifacts = state_dir.join("artifacts/report");
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(artifacts.join("index.html"), "<link href=\"app.css\">").unwrap();
        std::fs::write(artifacts.join("app.css"), "body{}").unwrap();
        std::fs::write(artifacts.join(".env"), "TOKEN=1").unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            std::collections::HashMap::new(),
            state_dir.join("daemon-state.json"),
        );
        for method in ["file.stat", "file.read_range"] {
            assert!(REMOTE_RPC_METHODS.contains(&method), "{method} must be registered");
            assert!(remote_rpc_is_read_only(method));
        }
        let page = artifacts.join("index.html");
        let stat = app
            .dispatch_remote_rpc("file.stat", json!({"path": page}))
            .await
            .unwrap();
        assert_eq!(stat["kind"], "html");
        assert_eq!(stat["size_bytes"], 21);
        // A relative asset resolves against the document's folder.
        let range = app
            .dispatch_remote_rpc(
                "file.read_range",
                json!({"path": "app.css", "base_dir": artifacts, "offset": 0, "length": 100}),
            )
            .await
            .unwrap();
        assert_eq!(range["data_base64"], "Ym9keXt9");
        assert_eq!(range["eof"], true);
        for denied in [
            artifacts.join(".env").to_string_lossy().into_owned(),
            "/etc/hosts".to_string(),
            "~/.ssh/id_ed25519".to_string(),
            format!("{}/../../daemon-state.json", artifacts.display()),
        ] {
            let error = app
                .dispatch_remote_rpc("file.stat", json!({"path": denied}))
                .await
                .unwrap_err();
            assert!(error.starts_with("file_denied:"), "{denied}: {error}");
        }
        assert!(
            app.dispatch_remote_rpc("file.stat", json!({}))
                .await
                .is_err()
        );
    }

    /// Bots link their files relative to their document space (`STATUS.md`),
    /// which sits below the bot workspace root.
    #[tokio::test]
    async fn bot_relative_links_resolve_in_the_bot_space() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing").to_string_lossy().to_string();
        let app = AppState::new_with_state_path(
            "test".into(),
            std::collections::HashMap::from([
                (falcondeck_core::AgentProvider::CODEX, missing.clone()),
                (falcondeck_core::AgentProvider::CLAUDE, missing),
            ]),
            temp.path().join("daemon-state.json"),
        );
        let result = app
            .mutate_bot(falcondeck_core::BotMutation::Create {
                name: "Planner".into(),
                instructions: "Plan".into(),
                provider: Some(falcondeck_core::AgentProvider::CLAUDE),
                model_id: None,
                thread_id: None,
            })
            .await
            .unwrap();
        let bot: falcondeck_core::BotProfile =
            serde_json::from_value(result["bot"].clone()).unwrap();
        let space = std::path::PathBuf::from(&bot.space_path);
        std::fs::create_dir_all(space.join("finance")).unwrap();
        std::fs::write(space.join("STATUS.md"), "# Status").unwrap();
        std::fs::write(space.join("finance/daily.md"), "ok").unwrap();
        for path in ["STATUS.md", "finance/daily.md"] {
            let stat = app
                .dispatch_remote_rpc(
                    "file.stat",
                    json!({"path": path, "workspace_id": bot.workspace_id}),
                )
                .await
                .unwrap_or_else(|error| panic!("{path}: {error}"));
            assert_eq!(stat["kind"], "markdown", "{path}");
        }
        let error = app
            .dispatch_remote_rpc(
                "file.stat",
                json!({"path": "missing.md", "workspace_id": bot.workspace_id}),
            )
            .await
            .unwrap_err();
        assert!(error.starts_with("file_not_found"), "{error}");
    }

    #[test]
    fn review_rpc_reads_are_read_only_and_the_response_is_not() {
        for method in ["reviews.list", "review.get"] {
            assert!(remote_rpc_is_read_only(method), "{method}");
        }
        assert!(!remote_rpc_is_read_only("review.respond"));
    }

    #[tokio::test]
    async fn tickets_rpc_reads_are_registered_and_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            std::collections::HashMap::new(),
            temp.path().join("state.json"),
        );
        for method in ["tickets.list", "ticket.get"] {
            assert!(REMOTE_RPC_METHODS.contains(&method));
            assert!(remote_rpc_is_read_only(method));
            let result = app
                .dispatch_remote_rpc(method, serde_json::json!({"id":"T-999"}))
                .await;
            assert!(
                !result
                    .as_ref()
                    .err()
                    .is_some_and(|error| error.contains("unsupported remote rpc method"))
            );
        }
        assert!(
            app.dispatch_remote_rpc("tickets.list", serde_json::json!({}))
                .await
                .is_ok()
        );
    }

    #[test]
    fn registers_snapshot_and_thread_detail_before_optional_remote_actions() {
        assert_eq!(REMOTE_RPC_METHODS.first(), Some(&"snapshot.current"));
        assert_eq!(REMOTE_RPC_METHODS.get(1), Some(&"thread.detail"));
    }

    #[tokio::test]
    async fn message_search_is_registered_read_only_and_validates_requests() {
        assert!(REMOTE_RPC_METHODS.contains(&"thread.search"));
        assert!(remote_rpc_is_read_only("thread.search"));
        let temp_dir = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            std::collections::HashMap::new(),
            temp_dir.path().join("daemon-state.json"),
        );
        // Exercise RPC routing against an empty, fresh index without scanning
        // the developer's native agent sessions.
        *app.inner.thread_search_scanned_at.lock().unwrap() = Some(std::time::Instant::now());
        assert!(
            app.dispatch_remote_rpc("thread.search", serde_json::json!({}))
                .await
                .is_err()
        );
        let result = app
            .dispatch_remote_rpc(
                "thread.search",
                serde_json::json!({"query": "", "limit": 12}),
            )
            .await
            .unwrap();
        assert_eq!(result["matches"], serde_json::json!([]));
    }

    #[test]
    fn queued_attachment_preview_is_registered_and_read_only() {
        assert!(REMOTE_RPC_METHODS.contains(&"thread.queue.attachment_preview"));
        assert!(remote_rpc_is_read_only("thread.queue.attachment_preview"));
    }

    #[test]
    fn relay_websocket_ticket_request_has_a_bounded_deadline() {
        let request = relay_ws_ticket_request(
            &reqwest::Client::new(),
            "https://connect.example/",
            "session-1",
            "daemon-token",
        )
        .build()
        .expect("valid websocket ticket request");

        assert_eq!(request.timeout(), Some(&RELAY_HTTP_REQUEST_TIMEOUT));
    }

    #[test]
    fn relay_urls_require_https_except_on_loopback() {
        assert_eq!(
            normalize_relay_url(" https://connect.example/ ").unwrap(),
            "https://connect.example"
        );
        assert_eq!(
            normalize_relay_url("http://127.0.0.1:8787/").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_relay_url("http://[::1]:8787/").unwrap(),
            "http://[::1]:8787"
        );
        for insecure in [
            "http://connect.example",
            "http://192.0.2.10:8787",
            "https://user:secret@connect.example",
            "https://connect.example?token=secret",
        ] {
            assert!(
                normalize_relay_url(insecure).is_err(),
                "expected insecure relay URL to be rejected: {insecure}"
            );
        }
    }

    #[tokio::test]
    async fn remote_rpc_deduplicator_coalesces_in_flight_and_completed_requests() {
        let deduplicator = std::sync::Arc::new(RemoteRpcDeduplicator::default());
        let executions = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let started = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let expected = json!({ "result": "leader" });

        let leader = {
            let deduplicator = deduplicator.clone();
            let executions = executions.clone();
            let started = started.clone();
            let release = release.clone();
            let expected = expected.clone();
            tokio::spawn(async move {
                deduplicator
                    .execute("request-1".to_string(), move || async move {
                        executions.fetch_add(1, Ordering::SeqCst);
                        started.notify_one();
                        release.notified().await;
                        Ok(expected)
                    })
                    .await
            })
        };
        started.notified().await;

        let follower = {
            let deduplicator = deduplicator.clone();
            let executions = executions.clone();
            tokio::spawn(async move {
                deduplicator
                    .execute("request-1".to_string(), move || async move {
                        executions.fetch_add(1, Ordering::SeqCst);
                        Ok(json!({ "result": "follower" }))
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert_eq!(executions.load(Ordering::SeqCst), 1);

        release.notify_waiters();
        let leader_result = leader.await.expect("leader task");
        let follower_result = follower.await.expect("follower task");
        assert_eq!(
            (leader_result, follower_result),
            (
                RemoteRpcDedupeResult::Outcome(Ok(expected.clone())),
                RemoteRpcDedupeResult::Outcome(Ok(expected.clone())),
            )
        );

        let cached = deduplicator
            .execute("request-1".to_string(), {
                let executions = executions.clone();
                move || async move {
                    executions.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({ "result": "cached-operation" }))
                }
            })
            .await;
        assert_eq!(cached, RemoteRpcDedupeResult::Outcome(Ok(expected)));
        assert_eq!(executions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn remote_rpc_deduplicator_suppresses_oversized_completed_replays() {
        let deduplicator = RemoteRpcDeduplicator::default();
        let executions = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let large_message =
            json!({ "payload": "x".repeat(REMOTE_RPC_DEDUPE_MAX_RESULT_BYTES + 1) });

        let first = deduplicator
            .execute("large-request".to_string(), {
                let executions = executions.clone();
                let large_message = large_message.clone();
                move || async move {
                    executions.fetch_add(1, Ordering::SeqCst);
                    Ok(large_message)
                }
            })
            .await;
        assert!(matches!(first, RemoteRpcDedupeResult::Outcome(Ok(_))));

        let duplicate = deduplicator
            .execute("large-request".to_string(), {
                let executions = executions.clone();
                move || async move {
                    executions.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({ "result": "must-not-run" }))
                }
            })
            .await;
        assert!(matches!(
            duplicate,
            RemoteRpcDedupeResult::CompletedWithoutReplay
        ));
        assert_eq!(executions.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn remote_rpc_outbox_drops_ciphertext_from_an_old_key_generation() {
        let stale = RemoteRpcOutboxMessage {
            key_generation: 3,
            message: RelayClientMessage::Ping,
        };
        assert!(stale.into_current_message(4).is_none());

        let current = RemoteRpcOutboxMessage {
            key_generation: 4,
            message: RelayClientMessage::Ping,
        };
        assert_eq!(
            current.into_current_message(4),
            Some(RelayClientMessage::Ping)
        );
    }

    #[tokio::test]
    async fn remote_rpc_deduplicator_releases_a_cancelled_leader_and_its_followers() {
        let deduplicator = std::sync::Arc::new(RemoteRpcDeduplicator::default());
        let started = std::sync::Arc::new(tokio::sync::Notify::new());

        let leader = {
            let deduplicator = deduplicator.clone();
            let started = started.clone();
            tokio::spawn(async move {
                deduplicator
                    .execute("cancelled-request".to_string(), move || async move {
                        started.notify_one();
                        std::future::pending::<RemoteRpcOutcome>().await
                    })
                    .await
            })
        };
        started.notified().await;

        let follower = {
            let deduplicator = deduplicator.clone();
            tokio::spawn(async move {
                deduplicator
                    .execute("cancelled-request".to_string(), || async {
                        Ok(json!({ "result": "follower" }))
                    })
                    .await
            })
        };
        timeout(Duration::from_secs(1), async {
            loop {
                let follower_registered = {
                    let entries = deduplicator.lock_entries();
                    matches!(
                        entries.get("cancelled-request"),
                        Some(RemoteRpcDedupeEntry::InFlight(waiters)) if waiters.len() == 1
                    )
                };
                if follower_registered {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("follower should join the in-flight request");

        leader.abort();
        assert!(
            leader
                .await
                .expect_err("leader should be cancelled")
                .is_cancelled()
        );
        let follower_result = timeout(Duration::from_secs(1), follower)
            .await
            .expect("follower should be released")
            .expect("follower task should not panic");
        assert!(matches!(
            follower_result,
            RemoteRpcDedupeResult::Outcome(Err(message))
                if message.contains("ended before producing a result")
        ));
        assert!(
            !deduplicator
                .lock_entries()
                .contains_key("cancelled-request")
        );

        let retry = deduplicator
            .execute("cancelled-request".to_string(), || async {
                Ok(json!({ "result": "retry" }))
            })
            .await;
        assert_eq!(
            retry,
            RemoteRpcDedupeResult::Outcome(Ok(json!({ "result": "retry" })))
        );
    }

    #[test]
    fn mutating_remote_rpc_methods_are_deduplicated() {
        assert!(!remote_rpc_is_read_only("turn.start"));
        assert!(!remote_rpc_is_read_only("thread.compact"));
        assert!(!remote_rpc_is_read_only("control.execute"));
    }

    #[test]
    fn snapshot_remote_rpc_remains_read_only() {
        assert!(remote_rpc_is_read_only("snapshot.current"));
        assert!(remote_rpc_is_read_only("control.get"));
    }

    #[test]
    fn remote_cloud_creation_preserves_location_and_retry_identity_for_both_wire_styles() {
        for params in [
            json!({"workspace_id":"source","execution_target":"cloud","idempotency_key":"stable-cloud-retry"}),
            json!({"workspaceId":"source","executionTarget":"cloud","idempotencyKey":"stable-cloud-retry"}),
        ] {
            let request = parse_start_thread_request(&params).unwrap();
            assert_eq!(request.workspace_id, "source");
            assert_eq!(
                request.execution_target,
                falcondeck_core::ThreadExecutionTarget::Cloud
            );
            assert_eq!(
                request.idempotency_key.as_deref(),
                Some("stable-cloud-retry")
            );
        }
        let legacy = parse_start_thread_request(&json!({"workspaceId":"source"})).unwrap();
        assert_eq!(
            legacy.execution_target,
            falcondeck_core::ThreadExecutionTarget::Local
        );
    }

    #[test]
    fn invalid_remote_execution_location_never_falls_back_to_local() {
        for target in [json!("cluod"), json!(true), json!({"type":"cloud"})] {
            assert!(
                parse_start_thread_request(&json!({
                    "workspaceId":"source","executionTarget":target,
                }))
                .is_err()
            );
        }
    }
}
