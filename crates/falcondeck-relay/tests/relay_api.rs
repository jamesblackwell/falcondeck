use std::{net::SocketAddr, path::PathBuf};

use chrono::Duration;
use falcondeck_core::{
    ClaimPairingRequest, ClaimPairingResponse, PairingStatus, PairingStatusResponse,
    RelayClientMessage, RelayServerMessage, RelayUpdate, RelayUpdatesResponse, StartPairingRequest,
    StartPairingResponse,
};
use falcondeck_relay::{AppState, router};
use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde_json::json;
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
            daemon_bundle: Some(json!({ "pub": "daemon-key" })),
        },
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
            client_bundle: Some(json!({ "pub": "client-key" })),
        },
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
    assert_eq!(claimed.client_bundle, Some(json!({ "pub": "client-key" })));
    assert_eq!(claim.daemon_bundle, Some(json!({ "pub": "daemon-key" })));

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
            params: json!({ "decision": "allow" }),
        },
    )
    .await;

    let rpc_request = recv_server_message(&mut daemon_ws).await;
    assert_eq!(
        rpc_request,
        RelayServerMessage::RpcRequest {
            request_id: "req-1".to_string(),
            method: "approval.respond".to_string(),
            params: json!({ "decision": "allow" }),
        }
    );

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::RpcResult {
            request_id: "req-1".to_string(),
            ok: true,
            result: Some(json!({ "ok": true })),
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
            result: Some(json!({ "ok": true })),
            error: None,
        }
    );

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::Update {
            body: json!({ "ciphertext": "abc123" }),
        },
    )
    .await;

    let update = recv_until_update(&mut client_ws).await;
    assert_eq!(update.seq, 1);
    assert_eq!(update.body, json!({ "ciphertext": "abc123" }));

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::Sync { after_seq: Some(0) },
    )
    .await;
    let sync = recv_server_message(&mut client_ws).await;
    match sync {
        RelayServerMessage::Sync { updates, next_seq } => {
            assert_eq!(next_seq, 2);
            assert_eq!(updates.len(), 1);
            assert_eq!(updates[0].body, json!({ "ciphertext": "abc123" }));
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
    assert_eq!(history.updates.len(), 1);
    assert_eq!(history.next_seq, 2);

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::RpcCall {
            request_id: "req-2".to_string(),
            method: "missing.method".to_string(),
            params: json!({}),
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
            error: Some("rpc method `missing.method` is not registered".to_string()),
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
            daemon_bundle: None,
        },
    )
    .await;

    tokio::time::sleep(TokioDuration::from_millis(1100)).await;

    let response = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&ClaimPairingRequest {
            pairing_code: pairing.pairing_code,
            label: None,
            client_bundle: None,
        })
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
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
            body: json!({ "ciphertext": "persist-me" }),
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
    assert_eq!(history.updates.len(), 1);
    assert_eq!(
        history.updates[0].body,
        json!({ "ciphertext": "persist-me" })
    );
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
            daemon_bundle: Some(json!({ "pub": "daemon-key" })),
        },
    )
    .await;

    let claim = post_json::<_, ClaimPairingResponse>(
        client,
        &format!("{http_base}/v1/pairings/claim"),
        &ClaimPairingRequest {
            pairing_code: pairing.pairing_code.clone(),
            label: Some("remote-web".to_string()),
            client_bundle: Some(json!({ "pub": "client-key" })),
        },
    )
    .await;

    (pairing, claim)
}

async fn post_json<T, R>(client: &reqwest::Client, url: &str, body: &T) -> R
where
    T: serde::Serialize + ?Sized,
    R: DeserializeOwned,
{
    client
        .post(url)
        .json(body)
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
    let message = timeout(TokioDuration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(text) = message else {
        panic!("expected text websocket frame");
    };
    serde_json::from_str::<RelayServerMessage>(&text).unwrap()
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
