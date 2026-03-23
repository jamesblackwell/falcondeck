use std::sync::atomic::Ordering;

use chrono::Utc;
use falcondeck_core::{
    DaemonSnapshot, EncryptedEnvelope, EventEnvelope, PairingPublicKeyBundle, RelayClientMessage,
    RelayServerMessage, RelayUpdateBody, RelayWebSocketTicketResponse, RemoteConnectionStatus,
    SendTurnRequest, SessionKeyMaterial, StartThreadRequest, UnifiedEvent,
    UpdatePreferencesRequest, UpdateThreadRequest,
    crypto::{LocalIdentityKeyPair, decrypt_json, encrypt_json, sign_session_key_material},
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
    parse_agent_provider, parse_interactive_response_params, relay_request_error,
};
use crate::error::DaemonError;

type RelayWriter = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

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
        let mut events = self.subscribe();
        let fence_seq = self.inner.sequence.load(Ordering::Relaxed);
        let snapshot = self.snapshot().await;

        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "snapshot.current".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "interactive.respond".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "thread.start".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "thread.detail".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "turn.start".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "turn.interrupt".to_string(),
            },
        )
        .await?;
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
                    &RelayClientMessage::Update {
                        body: RelayUpdateBody::Encrypted {
                            envelope: encrypt_remote_daemon_event(&pairing.data_key, &event)?,
                        },
                    },
                )
                .await?;
            }
        }

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::Connected;
            remote.last_error = None;
        }

        self.persist_local_state()
            .await
            .map_err(|error| format!("failed to persist connected remote state: {error}"))?;

        let min_forward_seq: u64 = fence_seq;
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
                                &RelayClientMessage::Update {
                                    body: RelayUpdateBody::Encrypted {
                                        envelope: encrypt_remote_daemon_event(&pairing.data_key, &event)?,
                                    },
                                },
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
                    send_relay_message(&mut writer, &RelayClientMessage::Ping).await?;
                }
                command = command_rx.recv() => {
                    if let Some(command) = command {
                        match command {
                            RemoteBridgeCommand::PublishBootstrap { pairing, client_bundle } => {
                                self.publish_session_bootstrap(&mut writer, &pairing, &client_bundle).await?;
                            }
                        }
                    }
                }
                message = reader.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let parsed = serde_json::from_str::<RelayServerMessage>(&text)
                                .map_err(|error| format!("invalid relay message: {error}"))?;
                            match parsed {
                                RelayServerMessage::RpcRequest { request_id, method, params } => {
                                    self.handle_remote_rpc(&mut writer, &pairing.data_key, request_id, method, params).await?;
                                }
                                RelayServerMessage::ActionRequested { action, payload } => {
                                    self.handle_queued_remote_action(&mut writer, &pairing.data_key, action.action_id, action.action_type, payload).await?;
                                }
                                RelayServerMessage::Pong | RelayServerMessage::Presence { .. } | RelayServerMessage::ActionUpdated { .. } | RelayServerMessage::Ready { .. } | RelayServerMessage::Sync { .. } | RelayServerMessage::Update { .. } | RelayServerMessage::Ephemeral { .. } | RelayServerMessage::RpcRegistered { .. } | RelayServerMessage::RpcUnregistered { .. } | RelayServerMessage::RpcResult { .. } | RelayServerMessage::Error { .. } => {}
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            return Err("relay websocket disconnected".to_string().into());
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

    async fn send_remote_rpc_result(
        &self,
        writer: &mut RelayWriter,
        data_key: &[u8; 32],
        request_id: String,
        rpc_result: Result<Value, String>,
    ) -> Result<(), String> {
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
        send_relay_message(
            writer,
            &RelayClientMessage::RpcResult {
                request_id,
                ok,
                result,
                error,
            },
        )
        .await
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

    async fn handle_remote_rpc(
        &self,
        writer: &mut RelayWriter,
        data_key: &[u8; 32],
        request_id: String,
        method: String,
        params: EncryptedEnvelope,
    ) -> Result<(), String> {
        let params: Value = match decrypt_json(data_key, &params) {
            Ok(params) => params,
            Err(error) => {
                tracing::warn!("failed to decrypt remote rpc payload: {error}");
                self.send_remote_rpc_result(
                    writer,
                    data_key,
                    request_id,
                    Err("invalid remote rpc payload".to_string()),
                )
                .await?;
                return Ok(());
            }
        };
        let required = |keys: &[&str]| {
            extract_string(&params, keys).ok_or_else(|| "invalid remote rpc payload".to_string())
        };
        let rpc_result = match method.as_str() {
            "snapshot.current" => serde_json::to_value(self.snapshot().await)
                .map_err(|error| format!("failed to serialize snapshot: {error}")),
            "preferences.read" => serde_json::to_value(self.preferences().await)
                .map_err(|error| format!("failed to serialize preferences: {error}")),
            "thread.start" => {
                let request = StartThreadRequest {
                    workspace_id: required(&["workspaceId", "workspace_id"])?,
                    provider: extract_string(&params, &["provider"]).and_then(parse_agent_provider),
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                    approval_policy: extract_string(
                        &params,
                        &["approvalPolicy", "approval_policy"],
                    ),
                };
                self.start_thread(request)
                    .await
                    .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "thread.detail" => {
                let workspace_id = required(&["workspaceId", "workspace_id"])?;
                let thread_id = required(&["threadId", "thread_id"])?;
                self.thread_detail(&workspace_id, &thread_id)
                    .await
                    .and_then(|detail| serde_json::to_value(detail).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "thread.update" => {
                let request = UpdateThreadRequest {
                    workspace_id: required(&["workspaceId", "workspace_id"])?,
                    thread_id: required(&["threadId", "thread_id"])?,
                    title: extract_string(&params, &["title"]),
                    provider: extract_string(&params, &["provider"]).and_then(parse_agent_provider),
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    reasoning_effort: extract_string(
                        &params,
                        &["reasoningEffort", "reasoning_effort"],
                    ),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                };
                self.update_thread(request)
                    .await
                    .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
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
            "turn.start" => {
                let request = SendTurnRequest {
                    workspace_id: required(&["workspaceId", "workspace_id"])?,
                    thread_id: required(&["threadId", "thread_id"])?,
                    inputs: params
                        .get("inputs")
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                        .unwrap_or_default(),
                    selected_skills: params
                        .get("selectedSkills")
                        .or_else(|| params.get("selected_skills"))
                        .cloned()
                        .and_then(|value| serde_json::from_value(value).ok())
                        .unwrap_or_default(),
                    provider: extract_string(&params, &["provider"]).and_then(parse_agent_provider),
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    reasoning_effort: extract_string(
                        &params,
                        &["reasoningEffort", "reasoning_effort"],
                    ),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                    approval_policy: extract_string(
                        &params,
                        &["approvalPolicy", "approval_policy"],
                    ),
                    service_tier: extract_string(&params, &["serviceTier", "service_tier"]),
                };
                self.send_turn(request)
                    .await
                    .and_then(|response| serde_json::to_value(response).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "turn.interrupt" => {
                let workspace_id = required(&["workspaceId", "workspace_id"])?;
                let thread_id = required(&["threadId", "thread_id"])?;
                self.interrupt_turn(workspace_id, thread_id)
                    .await
                    .and_then(|response| serde_json::to_value(response).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            "interactive.respond" | "approval.respond" => {
                let workspace_id = required(&["workspaceId", "workspace_id"])?;
                let request_id_param = required(&["requestId", "request_id"])?;
                let response = parse_interactive_response_params(&params)
                    .map_err(|_| "invalid remote rpc payload".to_string())?;
                self.respond_to_interactive_request(workspace_id, request_id_param, response)
                    .await
                    .and_then(|response| serde_json::to_value(response).map_err(DaemonError::from))
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
                    .and_then(|summary| serde_json::to_value(summary).map_err(DaemonError::from))
                    .map_err(|error| error.to_string())
            }
            _ => Err(format!("unsupported remote rpc method `{method}`")),
        };

        self.send_remote_rpc_result(writer, data_key, request_id, rpc_result)
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
                        model_id: extract_string(&params, &["modelId", "model_id"]),
                        reasoning_effort: extract_string(
                            &params,
                            &["reasoningEffort", "reasoning_effort"],
                        ),
                        collaboration_mode_id: extract_string(
                            &params,
                            &["collaborationModeId", "collaboration_mode_id"],
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
                        collaboration_mode_id: extract_string(
                            &params,
                            &["collaborationModeId", "collaboration_mode_id"],
                        ),
                        approval_policy: extract_string(
                            &params,
                            &["approvalPolicy", "approval_policy"],
                        ),
                        service_tier: extract_string(&params, &["serviceTier", "service_tier"]),
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
