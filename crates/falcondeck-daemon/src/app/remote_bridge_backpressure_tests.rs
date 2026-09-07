use std::sync::atomic::AtomicUsize;

use axum::{
    Json, Router,
    extract::{WebSocketUpgrade, ws},
    routing::{get, post},
};
use falcondeck_core::{
    crypto::LocalBoxKeyPair,
    relay_transport::{CHUNK_BYTES, WINDOW_CHUNKS},
};

use super::*;

struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

enum ProbeEvent {
    Ping {
        registrations: usize,
    },
    BulkWindowFilled,
    RpcReply {
        request_id: String,
        ok: bool,
        result: Option<EncryptedEnvelope>,
        registrations: usize,
    },
}

async fn next_probe_event(
    events: &mut mpsc::Receiver<ProbeEvent>,
    bridge: &mut AbortOnDrop<Result<(), String>>,
    deadline: Duration,
) -> ProbeEvent {
    timeout(deadline, async {
        tokio::select! {
            event = events.recv() => event.expect("the fake relay stopped receiving"),
            result = &mut bridge.0 => panic!("bridge exited under event pressure: {result:?}"),
        }
    })
    .await
    .expect("the bridge stopped servicing the relay while its event queue was full")
}

fn preferences_request(request_id: &str, data_key: &[u8; 32]) -> String {
    serde_json::to_string(&RelayServerMessage::RpcRequest {
        request_id: request_id.into(),
        method: "preferences.read".into(),
        params: encrypt_json(data_key, &json!({})).unwrap(),
    })
    .unwrap()
}

#[tokio::test]
async fn saturated_event_queue_keeps_encrypted_rpc_and_heartbeats_alive() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_url = format!("http://{}", listener.local_addr().unwrap());
    let (event_tx, mut events) = mpsc::channel(8);
    let registration_count = Arc::new(AtomicUsize::new(0));
    let relay_registration_count = registration_count.clone();
    let (request_tx, _) = broadcast::channel::<String>(4);
    let relay_requests = request_tx.clone();
    let relay = Router::new()
        .route(
            "/v1/sessions/session/ws-ticket",
            post(|| async {
                Json(RelayWebSocketTicketResponse {
                    ticket: "test-ticket".into(),
                    expires_at: Utc::now() + chrono::Duration::minutes(1),
                })
            }),
        )
        .route(
            "/v1/updates/ws",
            get(move |upgrade: WebSocketUpgrade| {
                let event_tx = event_tx.clone();
                let registration_count = relay_registration_count.clone();
                let mut requests = relay_requests.subscribe();
                async move {
                    upgrade.on_upgrade(move |mut socket| async move {
                        socket
                            .send(ws::Message::Text(
                                r#"{"type":"transport-ready","version":"chunks-v1"}"#.into(),
                            ))
                            .await
                            .unwrap();
                        socket
                            .send(ws::Message::Text(
                                serde_json::to_string(&RelayServerMessage::SyncProfile {
                                    full_snapshots_required: false,
                                })
                                .unwrap()
                                .into(),
                            ))
                            .await
                            .unwrap();
                        loop {
                            let message = tokio::select! {
                                request = requests.recv() => {
                                    let Ok(request) = request else { break; };
                                    if socket.send(ws::Message::Text(request.into())).await.is_err() {
                                        break;
                                    }
                                    continue;
                                }
                                message = socket.recv() => message,
                            };
                            let Some(Ok(ws::Message::Text(text))) = message else {
                                break;
                            };
                            let value: Value = serde_json::from_str(&text).unwrap();
                            if value["type"] == "transport-chunk" {
                                // A complete unacknowledged window pins the ordered
                                // writer on this transfer while later events queue up.
                                if value["index"].as_u64() == Some(WINDOW_CHUNKS as u64 - 1) {
                                    assert!(
                                        value["total"].as_u64().unwrap()
                                            > (CHUNK_BYTES * WINDOW_CHUNKS) as u64
                                    );
                                    if event_tx.send(ProbeEvent::BulkWindowFilled).await.is_err() {
                                        break;
                                    }
                                }
                                continue;
                            }
                            let event = match serde_json::from_value::<RelayClientMessage>(value)
                                .expect("valid daemon relay message")
                            {
                                RelayClientMessage::Ping => {
                                    if socket
                                        .send(ws::Message::Text(r#"{"type":"pong"}"#.into()))
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                    ProbeEvent::Ping {
                                        registrations: registration_count.load(Ordering::SeqCst),
                                    }
                                }
                                RelayClientMessage::RpcRegister { .. } => {
                                    registration_count.fetch_add(1, Ordering::SeqCst);
                                    continue;
                                }
                                RelayClientMessage::RpcResult {
                                    request_id, ok, result, ..
                                } => ProbeEvent::RpcReply {
                                    request_id,
                                    ok,
                                    result,
                                    registrations: registration_count.load(Ordering::SeqCst),
                                },
                                _ => continue,
                            };
                            if event_tx.send(event).await.is_err() {
                                break;
                            }
                        }
                    })
                }
            }),
        );
    let _server = AbortOnDrop(tokio::spawn(async move {
        axum::serve(listener, relay).await.unwrap();
    }));
    let temp = tempfile::tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".into(),
        Default::default(),
        temp.path().join("state.json"),
    );
    let expected_preferences = serde_json::to_value(app.preferences().await).unwrap();
    let data_key = [7; 32];
    let bridge_app = app.clone();
    let mut bridge = AbortOnDrop(tokio::spawn(async move {
        let pairing = RemotePairingState {
            pairing_id: "pairing".into(),
            pairing_code: String::new(),
            session_id: Some("session".into()),
            device_id: Some("device".into()),
            trusted_at: Some(Utc::now()),
            expires_at: Utc::now() + chrono::Duration::hours(1),
            client_bundle: None,
            local_key_pair: LocalBoxKeyPair::generate(),
            data_key,
        };
        let (_commands, mut commands) = mpsc::unbounded_channel();
        bridge_app
            .connect_remote_session(
                relay_url,
                "daemon-token".into(),
                "session".into(),
                pairing,
                None,
                &mut commands,
                &mut RemoteBridgeRetry::default(),
            )
            .await
            .map_err(|error| match error {
                RemoteBridgeError::Transient(message) | RemoteBridgeError::Persistent(message) => {
                    message
                }
            })
    }));

    let response_deadline = Duration::from_secs(5);
    assert!(matches!(
        next_probe_event(&mut events, &mut bridge, response_deadline).await,
        ProbeEvent::Ping { registrations } if registrations == REMOTE_RPC_METHODS.len()
    ));
    // A round trip confirms the reader consumed transport-ready before the
    // bulk event is emitted, avoiding a negotiation race with legacy framing.
    request_tx
        .send(preferences_request("ready", &data_key))
        .unwrap();
    assert!(matches!(
        next_probe_event(&mut events, &mut bridge, response_deadline).await,
        ProbeEvent::RpcReply { request_id, ok: true, .. } if request_id == "ready"
    ));

    app.emit(
        None,
        None,
        UnifiedEvent::Stop {
            reason: Some("x".repeat(CHUNK_BYTES * (WINDOW_CHUNKS + 1))),
        },
    );
    assert!(matches!(
        next_probe_event(&mut events, &mut bridge, response_deadline).await,
        ProbeEvent::BulkWindowFilled
    ));
    // The transport accepts only 128 queued ordered messages. Yielding lets
    // the bridge consume the burst instead of only filling its broadcast ring.
    for index in 0..256 {
        app.emit(
            None,
            None,
            UnifiedEvent::Stop {
                reason: Some(index.to_string()),
            },
        );
        tokio::task::yield_now().await;
    }
    request_tx
        .send(preferences_request("under-pressure", &data_key))
        .unwrap();
    let ProbeEvent::RpcReply {
        request_id,
        ok,
        result,
        registrations,
    } = next_probe_event(&mut events, &mut bridge, response_deadline).await
    else {
        panic!("expected the encrypted RPC response while bulk delivery was stalled");
    };
    assert_eq!(request_id, "under-pressure");
    assert_eq!(
        registrations,
        REMOTE_RPC_METHODS.len(),
        "startup registered RPCs twice"
    );
    assert!(ok, "read-only RPC failed under event pressure");
    assert_eq!(
        decrypt_json::<Value>(&data_key, &result.expect("encrypted preferences result")).unwrap(),
        expected_preferences
    );
    assert!(matches!(
        next_probe_event(&mut events, &mut bridge, Duration::from_secs(18)).await,
        ProbeEvent::Ping { registrations } if registrations == REMOTE_RPC_METHODS.len()
    ));
    timeout(Duration::from_secs(1), async {
        loop {
            let registrations = registration_count.load(Ordering::SeqCst);
            assert!(
                registrations <= 2 * REMOTE_RPC_METHODS.len(),
                "extra registration batch"
            );
            if registrations == 2 * REMOTE_RPC_METHODS.len() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the next heartbeat did not re-register the RPC methods");
    assert!(
        !bridge.0.is_finished(),
        "the bridge disconnected despite a responsive relay"
    );
}
