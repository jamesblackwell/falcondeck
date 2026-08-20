use std::{collections::HashMap, sync::atomic::Ordering};

use chrono::Utc;
use falcondeck_core::{
    DaemonSnapshot, EncryptedEnvelope, EventEnvelope, ForkThreadRequest, PairingPublicKeyBundle,
    RelayClientMessage, RelayServerMessage, RelayUpdateBody, RelayWebSocketTicketResponse,
    RemoteConnectionStatus, SendTurnRequest, SessionKeyMaterial, SnapshotRequest,
    StartThreadRequest, ThreadDetailMode, ThreadDetailRequest, UnifiedEvent,
    UpdatePreferencesRequest, UpdateThreadRequest,
    crypto::{
        LocalIdentityKeyPair, decrypt_json, encrypt_json, sign_session_key_material,
        verify_pairing_public_key_bundle,
    },
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, mpsc},
    time::Duration,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::{
    AppState, RemoteBridgeCommand, RemoteBridgeError, RemotePairingState, extract_string,
    parse_agent_provider, parse_interactive_response_params, parse_thread_isolation,
    relay_request_error,
};
use crate::error::DaemonError;

type RelayWriter = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

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
    "preferences.read",
    "preferences.update",
    "speech.status",
    "speech.models",
    "speech.transcribe",
    "speech.synthesize",
    "interactive.respond",
    "approval.respond",
    "thread.start",
    "thread.fork",
    "thread.update",
    "thread.archive",
    "thread.unarchive",
    "thread.delete",
    "thread.mark_read",
    "thread.mark_unread",
    "thread.goal.set",
    "thread.goal.clear",
    "turn.start",
    "turn.steer",
    "turn.interrupt",
    "thread.queue.remove",
    "thread.queue.steer",
    "thread.queue.edit",
    "thread.queue.reorder",
    "workspace.connect",
    "workspace.remove",
    "workspace.files",
    "workspace.file.read",
    "workspace.file.write",
    "git.status",
    "git.diff",
    "git.commit",
    "thread.ship",
    "connectors.read",
    "connectors.update",
    "providers.read",
    "providers.update",
    "providers.usage",
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
];

impl AppState {
    pub(super) async fn connect_remote_session(
        &self,
        relay_url: String,
        daemon_token: String,
        session_id: String,
        pairing: RemotePairingState,
        client_bundle: Option<PairingPublicKeyBundle>,
        command_rx: &mut mpsc::UnboundedReceiver<RemoteBridgeCommand>,
    ) -> Result<(), RemoteBridgeError> {
        let ws_ticket = self
            .fetch_relay_ws_ticket(&relay_url, &session_id, &daemon_token)
            .await
            .map_err(|error| format!("failed to issue relay websocket ticket: {error}"))?;
        let ws_url = relay_ws_url(&relay_url, &session_id, &ws_ticket.ticket);
        let (socket, _) = connect_async(&ws_url)
            .await
            .map_err(|error| format!("failed to connect daemon relay websocket: {error}"))?;
        let (mut writer, mut reader) = socket.split();

        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
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
        let snapshot = self.snapshot().await;

        register_remote_rpc_methods(&mut writer).await?;
        if let Some(client_bundle) = client_bundle.as_ref() {
            self.publish_session_bootstrap(&mut writer, &pairing, client_bundle)
                .await?;
        } else {
            tracing::warn!(
                "skipping bootstrap for restored trusted session {session_id}; client must already have the persisted data key"
            );
        }
        self.publish_remote_snapshot(&mut writer, &pairing.data_key, snapshot)
            .await?;

        while let Ok(event) = events.try_recv() {
            if event.seq >= fence_seq {
                send_relay_message(
                    &mut writer,
                    &remote_event_message(&pairing.data_key, &event)?,
                )
                .await?;
            }
        }

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::Connected;
            remote.last_error = None;
        }

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
        const BOOTSTRAP_REQUEST_MIN_INTERVAL: Duration = Duration::from_secs(60);
        // Keys are attacker-controlled (fresh key pairs are free), so the
        // per-key map alone is not a rate limit: also enforce a global
        // minimum interval between publishes and a hard per-connection
        // budget, and prune the map so it cannot grow unbounded.
        const BOOTSTRAP_GLOBAL_MIN_INTERVAL: Duration = Duration::from_secs(10);
        // Generous: the global interval is the real flood control. A tight
        // budget (this was 5) let a handful of stale devices starve the one
        // phone that genuinely needed its key, with no recovery until the
        // bridge happened to reconnect.
        const BOOTSTRAP_MAX_PUBLISHES_PER_CONNECTION: u32 = 50;
        // Refusals are cheap ephemerals but still rate-limited so an
        // attacker minting fresh bundles cannot use us as a broadcast pump.
        const BOOTSTRAP_REFUSAL_MIN_INTERVAL: Duration = Duration::from_secs(5);
        let mut bootstrap_request_publishes: HashMap<String, tokio::time::Instant> = HashMap::new();
        let mut bootstrap_publishes_used: u32 = 0;
        let mut last_bootstrap_publish: Option<tokio::time::Instant> = None;
        let mut last_bootstrap_refusal: Option<tokio::time::Instant> = None;
        // Concurrent RPC results funnel through this outbox so the select
        // loop stays the only writer to the socket while request handling
        // itself runs on per-RPC tasks.
        let (rpc_outbox, mut rpc_outbox_rx) = mpsc::unbounded_channel::<RelayClientMessage>();
        loop {
            tokio::select! {
                event = events.recv() => {
                    match event {
                        Ok(event) => {
                            if event.seq < min_forward_seq {
                                continue;
                            }
                            send_relay_message(
                                &mut writer,
                                &remote_event_message(&pairing.data_key, &event)?,
                            ).await?;
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!("remote daemon event stream lagged, skipped {skipped} events; sending fresh snapshot");
                            self.publish_remote_snapshot(&mut writer, &pairing.data_key, self.snapshot().await)
                                .await?;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            return Err(RemoteBridgeError::Persistent(
                                "remote event stream closed".to_string(),
                            ));
                        }
                    }
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
                command = command_rx.recv() => {
                    if let Some(command) = command {
                        match command {
                            RemoteBridgeCommand::PublishBootstrap { pairing, client_bundle } => {
                                self.publish_session_bootstrap(&mut writer, &pairing, &client_bundle).await?;
                            }
                            RemoteBridgeCommand::NotifyAttention { kind, workspace_id, thread_id } => {
                                send_relay_message(
                                    &mut writer,
                                    &RelayClientMessage::Notify { kind, workspace_id, thread_id },
                                ).await?;
                            }
                        }
                    }
                }
                rpc_message = rpc_outbox_rx.recv() => {
                    if let Some(message) = rpc_message {
                        send_relay_message(&mut writer, &message).await?;
                    }
                }
                message = reader.next() => {
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
                                RelayServerMessage::RpcRequest { request_id, method, params } => {
                                    // Handled on its own task: awaiting inline
                                    // serialized every RPC behind the slowest
                                    // in-flight call (and stalled event
                                    // forwarding) for all paired devices.
                                    let app = self.clone();
                                    let data_key = pairing.data_key;
                                    let outbox = rpc_outbox.clone();
                                    tokio::spawn(async move {
                                        if let Err(error) = app
                                            .handle_remote_rpc(&outbox, &data_key, request_id, method, params)
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
                                        let globally_throttled = last_bootstrap_publish
                                            .is_some_and(|last| now.duration_since(last) < BOOTSTRAP_GLOBAL_MIN_INTERVAL);
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
                                        } else if bootstrap_publishes_used >= BOOTSTRAP_MAX_PUBLISHES_PER_CONNECTION {
                                            tracing::warn!("ignoring bootstrap request: per-connection publish budget exhausted");
                                        } else if recently_served || globally_throttled {
                                            tracing::debug!("ignoring bootstrap request inside the publish rate window");
                                        } else {
                                            bootstrap_request_publishes.insert(client_bundle.public_key.clone(), now);
                                            bootstrap_publishes_used += 1;
                                            last_bootstrap_publish = Some(now);
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
        let response = reqwest::Client::new()
            .post(format!(
                "{}/v1/sessions/{}/ws-ticket",
                relay_url.trim_end_matches('/'),
                session_id
            ))
            .bearer_auth(daemon_token)
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
        snapshot: DaemonSnapshot,
    ) -> Result<(), String> {
        let snapshot_event = EventEnvelope {
            seq: 0,
            emitted_at: Utc::now(),
            workspace_id: None,
            thread_id: None,
            event: UnifiedEvent::Snapshot { snapshot },
        };
        send_relay_message(
            writer,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::Encrypted {
                    envelope: encrypt_remote_daemon_event(data_key, &snapshot_event)?,
                },
            },
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
    /// bridge outbox so socket writes stay serialized on the loop.
    async fn handle_remote_rpc(
        &self,
        outbox: &mpsc::UnboundedSender<RelayClientMessage>,
        data_key: &[u8; 32],
        request_id: String,
        method: String,
        params: EncryptedEnvelope,
    ) -> Result<(), String> {
        let params: Value = match decrypt_json(data_key, &params) {
            Ok(params) => params,
            Err(error) => {
                tracing::warn!("failed to decrypt remote rpc payload: {error}");
                let message = self.remote_rpc_result_message(
                    data_key,
                    request_id,
                    Err("invalid remote rpc payload".to_string()),
                )?;
                return outbox
                    .send(message)
                    .map_err(|error| format!("rpc outbox closed: {error}"));
            }
        };
        let rpc_result = self.dispatch_remote_rpc(&method, params).await;
        let message = self.remote_rpc_result_message(data_key, request_id, rpc_result)?;
        outbox
            .send(message)
            .map_err(|error| format!("rpc outbox closed: {error}"))
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
                "snapshot.current" => {
                    let request = SnapshotRequest {
                        include_archived_threads: params
                            .get("includeArchivedThreads")
                            .or_else(|| params.get("include_archived_threads"))
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                    };
                    serde_json::to_value(self.snapshot_with_request(&request).await)
                        .map_err(|error| format!("failed to serialize snapshot: {error}"))
                }
                "preferences.read" => serde_json::to_value(self.preferences().await)
                    .map_err(|error| format!("failed to serialize preferences: {error}")),
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
                "providers.usage" => serde_json::to_value(self.provider_usage_overview().await)
                    .map_err(|error| format!("failed to serialize provider usage: {error}")),
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
                "thread.start" => {
                    let request = StartThreadRequest {
                        workspace_id: required(&["workspaceId", "workspace_id"])?,
                        provider: extract_string(&params, &["provider"])
                            .and_then(parse_agent_provider),
                        model_id: extract_string(&params, &["modelId", "model_id"]),
                        collaboration_mode_id: extract_string(
                            &params,
                            &["collaborationModeId", "collaboration_mode_id"],
                        ),
                        approval_policy: extract_string(
                            &params,
                            &["approvalPolicy", "approval_policy"],
                        ),
                        sandbox_mode: extract_string(&params, &["sandboxMode", "sandbox_mode"]),
                        permission_mode: extract_string(
                            &params,
                            &["permissionMode", "permission_mode"],
                        ),
                        isolation: parse_thread_isolation(&params),
                        handoff_from: params
                            .get("handoffFrom")
                            .or_else(|| params.get("handoff_from"))
                            .cloned()
                            .and_then(|value| serde_json::from_value(value).ok()),
                    };
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
                    };
                    self.thread_detail_with_request(&request)
                        .await
                        .and_then(|detail| serde_json::to_value(detail).map_err(DaemonError::from))
                        .map_err(|error| error.to_string())
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
                "workspace.connect" => {
                    let request = falcondeck_core::ConnectWorkspaceRequest {
                        path: required(&["path"])?,
                    };
                    self.connect_workspace(request)
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
                "workspace.files" => {
                    let workspace_id = required(&["workspaceId", "workspace_id"])?;
                    let thread_id = extract_string(&params, &["threadId", "thread_id"]);
                    self.workspace_files(&workspace_id, thread_id.as_deref())
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
            "thread.start" => {
                if let Some(workspace_id) = required(&["workspaceId", "workspace_id"]) {
                    let request = StartThreadRequest {
                        workspace_id,
                        provider: extract_string(&params, &["provider"])
                            .and_then(parse_agent_provider),
                        model_id: extract_string(&params, &["modelId", "model_id"]),
                        collaboration_mode_id: extract_string(
                            &params,
                            &["collaborationModeId", "collaboration_mode_id"],
                        ),
                        approval_policy: extract_string(
                            &params,
                            &["approvalPolicy", "approval_policy"],
                        ),
                        sandbox_mode: extract_string(&params, &["sandboxMode", "sandbox_mode"]),
                        permission_mode: extract_string(
                            &params,
                            &["permissionMode", "permission_mode"],
                        ),
                        isolation: parse_thread_isolation(&params),
                        handoff_from: params
                            .get("handoffFrom")
                            .or_else(|| params.get("handoff_from"))
                            .cloned()
                            .and_then(|value| serde_json::from_value(value).ok()),
                    };
                    self.start_thread(request)
                        .await
                        .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                } else {
                    Err(DaemonError::BadRequest(
                        "invalid queued action payload".to_string(),
                    ))
                }
            }
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

pub(super) fn normalize_relay_url(input: &str) -> Result<String, DaemonError> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(DaemonError::BadRequest("relay_url is required".to_string()));
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(DaemonError::BadRequest(
            "relay_url must start with http:// or https://".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

pub(super) fn relay_ws_url(relay_url: &str, session_id: &str, ticket: &str) -> String {
    let base = if let Some(rest) = relay_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = relay_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        relay_url.to_string()
    };
    format!("{base}/v1/updates/ws?session_id={session_id}&ticket={ticket}")
}

pub(super) fn relay_url_looks_legacy_loopback(relay_url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(relay_url) else {
        return false;
    };

    matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
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
    encrypt_json(
        data_key,
        &json!({
            "kind": "daemon-event",
            "event": event,
        }),
    )
    .map_err(|error| format!("failed to encrypt relay update: {error}"))
}

fn remote_event_message(
    data_key: &[u8; 32],
    event: &EventEnvelope,
) -> Result<RelayClientMessage, String> {
    let envelope = encrypt_remote_daemon_event(data_key, event)?;
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

async fn register_remote_rpc_methods(writer: &mut RelayWriter) -> Result<(), String> {
    for method in REMOTE_RPC_METHODS {
        send_relay_message(
            writer,
            &RelayClientMessage::RpcRegister {
                method: (*method).to_string(),
            },
        )
        .await?;
    }
    Ok(())
}

async fn send_relay_message(
    writer: &mut RelayWriter,
    message: &RelayClientMessage,
) -> Result<(), String> {
    let payload = serde_json::to_string(message)
        .map_err(|error| format!("failed to encode relay message: {error}"))?;
    writer
        .send(Message::Text(payload.into()))
        .await
        .map_err(|error| format!("failed to send relay message: {error}"))
}

/// Reads a string field that distinguishes "absent" from an explicit `null`:
/// a missing key yields `None`, a present key yields `Some(value_or_none)`.
fn explicit_optional_string(params: &Value, keys: &[&str]) -> Option<Option<String>> {
    keys.iter()
        .find_map(|key| params.get(key))
        .map(|value| value.as_str().map(ToOwned::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_events_keep_the_legacy_single_event_envelope() {
        let event = EventEnvelope {
            seq: 10,
            emitted_at: Utc::now(),
            workspace_id: Some("workspace-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            event: UnifiedEvent::Stop { reason: None },
        };
        let message = remote_event_message(&[6; 32], &event).expect("encrypted event");
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

        let message = remote_event_message(&[7; 32], &event).expect("encrypted event");
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
            remote_event_message(&[9; 32], &event).expect("encrypted event"),
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
            remote_event_message(&[8; 32], &event).expect("encrypted event"),
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

    #[test]
    fn registers_snapshot_and_thread_detail_before_optional_remote_actions() {
        assert_eq!(REMOTE_RPC_METHODS.first(), Some(&"snapshot.current"));
        assert_eq!(REMOTE_RPC_METHODS.get(1), Some(&"thread.detail"));
    }
}
