use std::{net::SocketAddr, path::PathBuf};

use chrono::Duration;
use falcondeck_core::{
    ClaimPairingRequest, ClaimPairingResponse, EncryptedEnvelope, EncryptionVariant,
    PairingPublicKeyBundle, PairingStatus, PairingStatusResponse, RelayClientMessage,
    RelayServerMessage, RelayUpdate, RelayUpdateBody, RelayUpdatesResponse, StartPairingRequest,
    StartPairingResponse, SubmitQueuedActionRequest, TrustedDevicesResponse,
    crypto::{LocalBoxKeyPair, encrypt_json, generate_data_key},
};
use falcondeck_relay::{AppState, router};
use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use tempfile::TempDir;
use tokio::{
    net::TcpListener,
    task::JoinHandle,
    time::{Duration as TokioDuration, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

struct TestServer {
    temp_dir: Option<TempDir>,
    task: JoinHandle<()>,
    http_base: String,
    ws_base: String,
}

#[tokio::test]
async fn pairing_flow_and_history_round_trip() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();

    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("James Mac".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    let pending = get_json::<PairingStatusResponse>(
        &client,
        &format!("{}/v1/pairings/{}", server.http_base, pairing.pairing_id),
        Some(&pairing.daemon_token),
    )
    .await;
    assert_eq!(pending.status, PairingStatus::Pending);
    assert_eq!(pending.label.as_deref(), Some("James Mac"));

    let claim = post_json::<_, ClaimPairingResponse>(
        &client,
        &format!("{}/v1/pairings/claim", server.http_base),
        &ClaimPairingRequest {
            pairing_code: pairing.pairing_code.clone(),
            label: Some("Phone".to_string()),
            client_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    let claimed = get_json::<PairingStatusResponse>(
        &client,
        &format!("{}/v1/pairings/{}", server.http_base, pairing.pairing_id),
        Some(&pairing.daemon_token),
    )
    .await;
    assert_eq!(claimed.status, PairingStatus::Claimed);
    assert_eq!(
        claimed.session_id.as_deref(),
        Some(claim.session_id.as_str())
    );
    assert!(claimed.client_bundle.is_some());
    assert!(claim.daemon_bundle.is_some());

    let updates = get_json::<RelayUpdatesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/updates",
            server.http_base, claim.session_id
        ),
        Some(&claim.client_token),
    )
    .await;
    assert!(updates.updates.is_empty());
    assert_eq!(updates.next_seq, 1);
}

#[tokio::test]
async fn additional_pairings_attach_new_devices_to_the_same_session() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, first_claim) = create_claimed_session(&client, &server.http_base).await;

    let second_pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: Some(pairing.session_id.clone()),
            daemon_token: Some(pairing.daemon_token.clone()),
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    assert_eq!(second_pairing.session_id, pairing.session_id);
    assert_eq!(second_pairing.daemon_token, pairing.daemon_token);

    let second_claim = post_json::<_, ClaimPairingResponse>(
        &client,
        &format!("{}/v1/pairings/claim", server.http_base),
        &ClaimPairingRequest {
            pairing_code: second_pairing.pairing_code,
            label: Some("tablet".to_string()),
            client_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    assert_eq!(second_claim.session_id, first_claim.session_id);
    assert_ne!(second_claim.device_id, first_claim.device_id);

    let devices = get_json::<TrustedDevicesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/devices",
            server.http_base, first_claim.session_id
        ),
        Some(&pairing.daemon_token),
    )
    .await;
    assert_eq!(devices.devices.len(), 2);
    assert_eq!(
        devices
            .devices
            .iter()
            .filter(|device| device.status == falcondeck_core::TrustedDeviceStatus::Active)
            .count(),
        2
    );
}

#[tokio::test]
async fn websocket_fanout_and_rpc_forwarding_work() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = format!(
        "{}/v1/updates/ws?session_id={}&token={}",
        server.ws_base, claim.session_id, pairing.daemon_token
    );
    let client_url = format!(
        "{}/v1/updates/ws?session_id={}&token={}",
        server.ws_base, claim.session_id, claim.client_token
    );

    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let (mut client_ws, _) = connect_async(client_url).await.unwrap();

    let daemon_ready = recv_server_message(&mut daemon_ws).await;
    let remote_ready = recv_server_message(&mut client_ws).await;
    assert!(matches!(daemon_ready, RelayServerMessage::Ready { .. }));
    assert!(matches!(remote_ready, RelayServerMessage::Ready { .. }));

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::RpcRegister {
            method: "approval.respond".to_string(),
        },
    )
    .await;
    let daemon_ack = recv_server_message(&mut daemon_ws).await;
    assert_eq!(
        daemon_ack,
        RelayServerMessage::RpcRegistered {
            method: "approval.respond".to_string(),
        }
    );

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::RpcCall {
            request_id: "req-1".to_string(),
            method: "approval.respond".to_string(),
            params: test_envelope("allow"),
        },
    )
    .await;

    let rpc_request = recv_server_message(&mut daemon_ws).await;
    assert_eq!(
        rpc_request,
        RelayServerMessage::RpcRequest {
            request_id: "req-1".to_string(),
            method: "approval.respond".to_string(),
            params: test_envelope("allow"),
        }
    );

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::RpcResult {
            request_id: "req-1".to_string(),
            ok: true,
            result: Some(test_envelope("ok")),
            error: None,
        },
    )
    .await;

    let rpc_result = recv_server_message(&mut client_ws).await;
    assert_eq!(
        rpc_result,
        RelayServerMessage::RpcResult {
            request_id: "req-1".to_string(),
            ok: true,
            result: Some(test_envelope("ok")),
            error: None,
        }
    );

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::Update {
            body: RelayUpdateBody::Encrypted {
                envelope: test_envelope("abc123"),
            },
        },
    )
    .await;

    let update = recv_until_update(&mut client_ws).await;
    assert!(update.seq >= 1);
    assert_eq!(
        update.body,
        RelayUpdateBody::Encrypted {
            envelope: test_envelope("abc123"),
        }
    );

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::Sync { after_seq: Some(0) },
    )
    .await;
    let sync = recv_server_message(&mut client_ws).await;
    match sync {
        RelayServerMessage::Sync { updates, next_seq } => {
            assert!(next_seq >= 2);
            let encrypted_updates = updates
                .iter()
                .filter(|update| matches!(update.body, RelayUpdateBody::Encrypted { .. }))
                .collect::<Vec<_>>();
            assert_eq!(encrypted_updates.len(), 1);
            assert_eq!(
                encrypted_updates[0].body,
                RelayUpdateBody::Encrypted {
                    envelope: test_envelope("abc123"),
                }
            );
        }
        other => panic!("expected sync response, got {other:?}"),
    }

    let history = get_json::<RelayUpdatesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/updates?after_seq=0",
            server.http_base, claim.session_id
        ),
        Some(&claim.client_token),
    )
    .await;
    let encrypted_history = history
        .updates
        .iter()
        .filter(|update| matches!(update.body, RelayUpdateBody::Encrypted { .. }))
        .collect::<Vec<_>>();
    assert_eq!(encrypted_history.len(), 1);
    assert!(history.next_seq >= 2);

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::RpcCall {
            request_id: "req-2".to_string(),
            method: "missing.method".to_string(),
            params: test_envelope("missing"),
        },
    )
    .await;
    let missing_method = recv_server_message(&mut client_ws).await;
    assert_eq!(
        missing_method,
        RelayServerMessage::RpcResult {
            request_id: "req-2".to_string(),
            ok: false,
            result: None,
            error: None,
        }
    );
}

#[tokio::test]
async fn expired_pairings_cannot_be_claimed() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: None,
            ttl_seconds: Some(1),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    tokio::time::sleep(TokioDuration::from_millis(1100)).await;

    let response = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&ClaimPairingRequest {
            pairing_code: pairing.pairing_code,
            label: None,
            client_bundle: Some(test_bundle()),
        })
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn queued_actions_are_not_redispatched_while_the_daemon_is_still_connected() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = format!(
        "{}/v1/updates/ws?session_id={}&token={}",
        server.ws_base, claim.session_id, pairing.daemon_token
    );
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    let first_action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "idempotency-1".to_string(),
            action_type: "thread.start".to_string(),
            payload: test_envelope("payload-1"),
        },
        Some(&claim.client_token),
    )
    .await;
    let RelayServerMessage::ActionRequested {
        action: first_request,
        ..
    } = recv_until_action_requested(&mut daemon_ws).await
    else {
        unreachable!();
    };
    assert_eq!(first_request.action_id, first_action.action_id);

    let second_action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "idempotency-2".to_string(),
            action_type: "thread.update".to_string(),
            payload: test_envelope("payload-2"),
        },
        Some(&claim.client_token),
    )
    .await;
    let RelayServerMessage::ActionRequested {
        action: second_request,
        ..
    } = recv_until_action_requested(&mut daemon_ws).await
    else {
        unreachable!();
    };
    assert_eq!(second_request.action_id, second_action.action_id);

    let unexpected = timeout(
        TokioDuration::from_millis(250),
        recv_until_action_requested(&mut daemon_ws),
    )
    .await;
    assert!(
        unexpected.is_err(),
        "first queued action was redispatched unexpectedly"
    );
}

#[tokio::test]
async fn dispatched_actions_are_requeued_after_daemon_disconnect() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = format!(
        "{}/v1/updates/ws?session_id={}&token={}",
        server.ws_base, claim.session_id, pairing.daemon_token
    );
    let (mut daemon_ws, _) = connect_async(&daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    let action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "idempotency-requeue".to_string(),
            action_type: "turn.start".to_string(),
            payload: test_envelope("payload-requeue"),
        },
        Some(&claim.client_token),
    )
    .await;
    let RelayServerMessage::ActionRequested {
        action: initial_request,
        ..
    } = recv_until_action_requested(&mut daemon_ws).await
    else {
        unreachable!();
    };
    assert_eq!(initial_request.action_id, action.action_id);

    daemon_ws.close(None).await.unwrap();

    let (mut reconnected_ws, _) = connect_async(daemon_url).await.unwrap();
    let _ = recv_server_message(&mut reconnected_ws).await;
    let RelayServerMessage::ActionRequested {
        action: retried_request,
        ..
    } = recv_until_action_requested(&mut reconnected_ws).await
    else {
        unreachable!();
    };
    assert_eq!(retried_request.action_id, action.action_id);
}

#[tokio::test]
async fn persisted_updates_survive_restart() {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");

    let server = spawn_server_at(state_path.clone()).await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = format!(
        "{}/v1/updates/ws?session_id={}&token={}",
        server.ws_base, claim.session_id, pairing.daemon_token
    );
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;
    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::Update {
            body: RelayUpdateBody::Encrypted {
                envelope: test_envelope("persist-me"),
            },
        },
    )
    .await;
    let _ = recv_until_update(&mut daemon_ws).await;

    server.task.abort();
    let _keep_tempdir = temp_dir;

    let restarted = spawn_server_at(state_path).await;
    let history = get_json::<RelayUpdatesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/updates?after_seq=0",
            restarted.http_base, claim.session_id
        ),
        Some(&claim.client_token),
    )
    .await;
    let encrypted_updates = history
        .updates
        .iter()
        .filter(|update| matches!(update.body, RelayUpdateBody::Encrypted { .. }))
        .collect::<Vec<_>>();
    assert_eq!(encrypted_updates.len(), 1);
    assert_eq!(
        encrypted_updates[0].body,
        RelayUpdateBody::Encrypted {
            envelope: test_envelope("persist-me"),
        }
    );
}

#[tokio::test]
async fn persisted_state_does_not_store_plaintext_session_markers() {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");
    let server = spawn_server_at(state_path.clone()).await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = format!(
        "{}/v1/updates/ws?session_id={}&token={}",
        server.ws_base, claim.session_id, pairing.daemon_token
    );
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    let data_key = generate_data_key();
    let marker = "TOP_SECRET_FALCONDECK_MARKER";
    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::Update {
            body: RelayUpdateBody::Encrypted {
                envelope: encrypt_json(&data_key, &serde_json::json!({ "marker": marker }))
                    .unwrap(),
            },
        },
    )
    .await;
    let _ = recv_until_update(&mut daemon_ws).await;

    let persisted = std::fs::read_to_string(state_path).unwrap();
    assert!(
        !persisted.contains(marker),
        "relay state should not contain plaintext session payloads"
    );
}

#[tokio::test]
async fn legacy_state_recovers_sessions_and_skips_incompatible_pairings() {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");
    std::fs::write(
        &state_path,
        r#"{
  "pairings": {
    "pairing-old": {
      "pairing_id": "pairing-old",
      "pairing_code": "ABC12345",
      "daemon_token": "daemon-old",
      "label": "legacy",
      "session_id": "session-old",
      "daemon_bundle": {"daemonVersion":"0.1.0"},
      "client_bundle": null,
      "created_at": "2026-03-15T12:51:18.340992458Z",
      "expires_at": "2026-03-15T13:01:18.340992458Z"
    }
  },
  "sessions": {
    "session-old": {
      "session_id": "session-old",
      "pairing_id": "pairing-old",
      "daemon_token": "daemon-old",
      "client_token": "client-old",
      "created_at": "2026-03-15T12:51:18.804798247Z",
      "updated_at": "2026-03-15T12:51:21.511622140Z",
      "updates": [{
        "id":"update-old",
        "seq":1,
        "body":{"kind":"daemon-event","event":{"seq":0}},
        "created_at":"2026-03-15T12:51:21.511622140Z"
      }]
    }
  }
}"#,
    )
    .unwrap();

    let state = AppState::load("test".to_string(), state_path, Duration::seconds(300))
        .await
        .unwrap();
    let health = state.health().await;
    // Pairing is skipped (incompatible daemon_bundle format), but the
    // session is recovered with its incompatible updates cleared.
    assert_eq!(health.pending_pairings, 0);
    assert_eq!(health.active_sessions, 1);
}

async fn create_claimed_session(
    client: &reqwest::Client,
    http_base: &str,
) -> (StartPairingResponse, ClaimPairingResponse) {
    let pairing = post_json::<_, StartPairingResponse>(
        client,
        &format!("{http_base}/v1/pairings"),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    let claim = post_json::<_, ClaimPairingResponse>(
        client,
        &format!("{http_base}/v1/pairings/claim"),
        &ClaimPairingRequest {
            pairing_code: pairing.pairing_code.clone(),
            label: Some("remote-web".to_string()),
            client_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    (pairing, claim)
}

async fn post_json<T, R>(client: &reqwest::Client, url: &str, body: &T, bearer: Option<&str>) -> R
where
    T: serde::Serialize + ?Sized,
    R: DeserializeOwned,
{
    let request = client.post(url).json(body);
    let request = if let Some(token) = bearer {
        request.bearer_auth(token)
    } else {
        request
    };

    request
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<R>()
        .await
        .unwrap()
}

async fn get_json<R>(client: &reqwest::Client, url: &str, bearer: Option<&str>) -> R
where
    R: DeserializeOwned,
{
    let request = client.get(url);
    let request = if let Some(token) = bearer {
        request.bearer_auth(token)
    } else {
        request
    };

    request
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<R>()
        .await
        .unwrap()
}

async fn send_client_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    message: &RelayClientMessage,
) {
    let payload = serde_json::to_string(message).unwrap();
    socket.send(Message::Text(payload.into())).await.unwrap();
}

async fn recv_server_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> RelayServerMessage {
    loop {
        let message = timeout(TokioDuration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(text) = message else {
            panic!("expected text websocket frame");
        };
        let parsed = serde_json::from_str::<RelayServerMessage>(&text).unwrap();
        match parsed {
            RelayServerMessage::Presence { .. } | RelayServerMessage::ActionUpdated { .. } => {}
            RelayServerMessage::Update { ref update }
                if matches!(
                    update.body,
                    RelayUpdateBody::Presence { .. } | RelayUpdateBody::ActionStatus { .. }
                ) => {}
            other => return other,
        }
    }
}

async fn recv_until_action_requested(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> falcondeck_core::RelayServerMessage {
    loop {
        match recv_server_message(socket).await {
            message @ RelayServerMessage::ActionRequested { .. } => return message,
            RelayServerMessage::Pong
            | RelayServerMessage::RpcRegistered { .. }
            | RelayServerMessage::RpcUnregistered { .. }
            | RelayServerMessage::RpcResult { .. }
            | RelayServerMessage::Update { .. } => {}
            other => panic!("expected action request, got {other:?}"),
        }
    }
}

async fn recv_until_update(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> RelayUpdate {
    loop {
        match recv_server_message(socket).await {
            RelayServerMessage::Update { update } => return update,
            RelayServerMessage::Pong => {}
            RelayServerMessage::RpcResult { .. } => {}
            RelayServerMessage::Presence { .. } => {}
            other => panic!("expected update message, got {other:?}"),
        }
    }
}

async fn spawn_server() -> TestServer {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");
    let mut server = spawn_server_at(state_path).await;
    server.temp_dir = Some(temp_dir);
    server
}

async fn spawn_server_at(state_path: PathBuf) -> TestServer {
    let state = AppState::load(
        "test".to_string(),
        PathBuf::from(&state_path),
        Duration::seconds(300),
    )
    .await
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, router(state)).await.unwrap();
    });

    TestServer {
        temp_dir: None,
        task,
        http_base: format!("http://{}", format_addr(addr)),
        ws_base: format!("ws://{}", format_addr(addr)),
    }
}

fn format_addr(addr: SocketAddr) -> String {
    match addr {
        SocketAddr::V4(_) => addr.to_string(),
        SocketAddr::V6(_) => format!("[{}]:{}", addr.ip(), addr.port()),
    }
}

fn test_bundle() -> PairingPublicKeyBundle {
    let key_pair = LocalBoxKeyPair::generate();
    PairingPublicKeyBundle {
        encryption_variant: EncryptionVariant::DataKeyV1,
        public_key: key_pair.public_key_base64().to_string(),
    }
}

fn test_envelope(marker: &str) -> EncryptedEnvelope {
    EncryptedEnvelope {
        encryption_variant: EncryptionVariant::DataKeyV1,
        ciphertext: format!("opaque-{marker}"),
    }
}
