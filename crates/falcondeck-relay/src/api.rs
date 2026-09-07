use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, OnceLock},
};

use axum::{
    Json, Router,
    extract::{
        ConnectInfo, DefaultBodyLimit, Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, Method, header},
    response::{Html, IntoResponse},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tower_http::cors::{AllowOrigin, CorsLayer};

use falcondeck_core::{
    ClaimPairingRequest, PairingChallengeRequest, RelayClientMessage, RelayServerMessage,
    StartPairingRequest, SubmitQueuedActionRequest,
};

use crate::{
    app::{AppState, RELAY_WS_MAX_MESSAGE_BYTES, SessionAuth},
    error::RelayError,
};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(landing_page))
        .route("/health", get(health))
        .route("/v1/health", get(health))
        .route(
            "/v1/pairings",
            post(start_pairing).layer(DefaultBodyLimit::max(PAIRING_REQUEST_BODY_LIMIT_BYTES)),
        )
        .route(
            "/v1/pairings/challenge",
            post(pairing_challenge).layer(DefaultBodyLimit::max(PAIRING_REQUEST_BODY_LIMIT_BYTES)),
        )
        .route(
            "/v1/pairings/claim",
            post(claim_pairing).layer(DefaultBodyLimit::max(PAIRING_REQUEST_BODY_LIMIT_BYTES)),
        )
        .route("/v1/pairings/{pairing_id}", get(pairing_status))
        .route("/v1/sessions/{session_id}/updates", get(session_updates))
        .route("/v1/sessions/{session_id}/actions", post(submit_action))
        .route("/v1/sessions/{session_id}/ws-ticket", post(issue_ws_ticket))
        .route(
            "/v1/sessions/{session_id}/actions/{action_id}",
            get(action_status),
        )
        .route("/v1/sessions/{session_id}/devices", get(trusted_devices))
        .route(
            "/v1/sessions/{session_id}/devices/{device_id}",
            axum::routing::delete(revoke_trusted_device),
        )
        .route(
            "/v1/sessions/{session_id}/devices/{device_id}/push-token",
            post(register_push_token),
        )
        .route("/v1/updates/ws", get(updates_ws))
        .layer(relay_cors_layer())
        .with_state(state)
}

fn relay_cors_layer() -> CorsLayer {
    let configured = std::env::var("FALCONDECK_RELAY_CORS_ORIGINS")
        .unwrap_or_else(|_| "https://app.falcondeck.com".to_string());
    let mut origins = configured
        .split(',')
        .filter_map(|origin| origin.trim().parse::<HeaderValue>().ok())
        .collect::<Vec<_>>();
    // Common local web-development origins. Native mobile and the daemon do
    // not send browser Origin headers and are unaffected by this allowlist.
    for origin in ["http://localhost:5173", "http://127.0.0.1:5173"] {
        origins.push(HeaderValue::from_static(origin));
    }
    origins.sort_unstable();
    origins.dedup();

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

const PAIRING_REQUEST_BODY_LIMIT_BYTES: usize = 16 * 1024;
const MAX_PENDING_WS_HANDSHAKES: usize = 64;
const MAX_WS_SESSION_ID_BYTES: usize = 128;
const MAX_WS_TICKET_BYTES: usize = 256;
static WS_HANDSHAKE_LIMITER: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

fn acquire_ws_handshake_permit(
    limiter: Arc<tokio::sync::Semaphore>,
) -> Result<tokio::sync::OwnedSemaphorePermit, RelayError> {
    limiter.try_acquire_owned().map_err(|_| {
        RelayError::TooManyRequests("too many websocket handshakes are pending".to_string())
    })
}

#[derive(Debug, Deserialize)]
struct UpdatesRequestQuery {
    after_seq: Option<u64>,
    /// Caps the replay window; defaults to the relay's standard reconnect
    /// window when absent.
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct WebSocketQuery {
    session_id: String,
    ticket: String,
    transport: Option<String>,
    compact_index: Option<bool>,
}

#[derive(Serialize)]
struct RelayLivenessResponse {
    ok: bool,
}

async fn health() -> Json<RelayLivenessResponse> {
    Json(RelayLivenessResponse { ok: true })
}

const RELAY_LANDING_PAGE: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FalconDeck Relay</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #090b12; color: #f6f7fb; }
    main { width: min(34rem, calc(100% - 3rem)); padding: 2.5rem; border: 1px solid #272c3b; border-radius: 1.25rem; background: #10131d; box-shadow: 0 1.5rem 4rem #0008; }
    .mark { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border-radius: .8rem; background: #6d5dfc; font-weight: 800; }
    h1 { margin: 1.5rem 0 .5rem; font-size: clamp(2rem, 7vw, 3rem); letter-spacing: -.05em; }
    p { color: #aeb5c8; line-height: 1.6; }
    .status { display: inline-flex; align-items: center; gap: .5rem; margin: 1.25rem 0; color: #b9f6c8; font-weight: 700; }
    .dot { width: .6rem; height: .6rem; border-radius: 999px; background: #55d187; box-shadow: 0 0 .8rem #55d187; }
    a { display: inline-block; margin-top: .75rem; color: #fff; font-weight: 700; text-decoration: none; }
    a:hover { text-decoration: underline; }
    small { display: block; margin-top: 2.5rem; color: #70788d; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">F</div>
    <h1>FalconDeck Relay</h1>
    <div class="status"><span class="dot"></span>Operational</div>
    <p>This endpoint securely coordinates FalconDeck pairing, remote connections, and encrypted session updates.</p>
    <a href="https://app.falcondeck.com">Open FalconDeck&nbsp;→</a>
    <small>Service status: <a href="/health">/health</a></small>
  </main>
</body>
</html>"##;

async fn landing_page() -> Html<&'static str> {
    Html(RELAY_LANDING_PAGE)
}

async fn start_pairing(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<StartPairingRequest>,
) -> Result<Json<falcondeck_core::StartPairingResponse>, RelayError> {
    state
        .authorize_pairing_creation(pairing_client_ip(peer_addr, &headers, &trusted_proxy_ips()))
        .await?;
    Ok(Json(state.start_pairing(request).await?))
}

fn trusted_proxy_ips() -> Vec<IpAddr> {
    std::env::var("FALCONDECK_RELAY_TRUSTED_PROXY_IPS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|value| value.trim().parse().ok())
        .collect()
}

fn pairing_client_ip(
    peer_addr: SocketAddr,
    headers: &HeaderMap,
    trusted_proxies: &[IpAddr],
) -> IpAddr {
    // Forwarded identity is trusted only from an explicitly configured proxy.
    // The default is fail-closed, including for arbitrary loopback processes.
    if trusted_proxies.contains(&peer_addr.ip())
        && let Some(forwarded_ip) = headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit(',').next())
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
    {
        return forwarded_ip;
    }
    peer_addr.ip()
}

async fn pairing_challenge(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<PairingChallengeRequest>,
) -> Result<Json<falcondeck_core::PairingChallengeResponse>, RelayError> {
    state
        .authorize_pairing_attempt(pairing_client_ip(peer_addr, &headers, &trusted_proxy_ips()))
        .await?;
    Ok(Json(state.create_pairing_challenge(request).await?))
}

async fn claim_pairing(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<ClaimPairingRequest>,
) -> Result<Json<falcondeck_core::ClaimPairingResponse>, RelayError> {
    state
        .authorize_pairing_attempt(pairing_client_ip(peer_addr, &headers, &trusted_proxy_ips()))
        .await?;
    Ok(Json(state.claim_pairing(request).await?))
}

async fn pairing_status(
    State(state): State<AppState>,
    Path(pairing_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::PairingStatusResponse>, RelayError> {
    let token = auth_token(&headers)?;
    Ok(Json(state.pairing_status(&pairing_id, &token).await?))
}

async fn session_updates(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<UpdatesRequestQuery>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::RelayUpdatesResponse>, RelayError> {
    let token = auth_token(&headers)?;
    Ok(Json(
        state
            .session_updates(
                &session_id,
                &token,
                query.after_seq.unwrap_or(0),
                query.limit,
            )
            .await?,
    ))
}

async fn issue_ws_ticket(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::RelayWebSocketTicketResponse>, RelayError> {
    let token = auth_token(&headers)?;
    Ok(Json(state.issue_ws_ticket(&session_id, &token).await?))
}

/// Peers mostly exchange small JSON control frames, but daemon payloads
/// (full encrypted snapshots, large thread.detail RPC results) ride the
/// same socket and base64 inflates them by a third, so the cap must leave
/// generous headroom. A maximum-size image turn is base64-encoded once as
/// JSON image data and again after encryption, so it can legitimately exceed
/// 24 MiB even though the decoded attachment budget is only 15 MB.
const WS_MAX_MESSAGE_BYTES: usize = RELAY_WS_MAX_MESSAGE_BYTES;

async fn updates_ws(
    ws: WebSocketUpgrade,
    Query(query): Query<WebSocketQuery>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, RelayError> {
    // Cheap syntactic validation only: the single-use ticket is consumed
    // inside the upgrade callback, so an aborted handshake cannot burn it.
    if query.session_id.trim().is_empty() || query.session_id.len() > MAX_WS_SESSION_ID_BYTES {
        return Err(RelayError::BadRequest("session_id is required".to_string()));
    }
    if query.ticket.trim().is_empty() || query.ticket.len() > MAX_WS_TICKET_BYTES {
        return Err(RelayError::BadRequest(
            "valid ticket is required".to_string(),
        ));
    }
    let limiter = WS_HANDSHAKE_LIMITER
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_PENDING_WS_HANDSHAKES)))
        .clone();
    let handshake_permit = acquire_ws_handshake_permit(limiter)?;
    Ok(ws
        .max_message_size(WS_MAX_MESSAGE_BYTES)
        .max_frame_size(WS_MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let authentication = state
                .consume_ws_ticket(&query.session_id, &query.ticket)
                .await;
            // Live peers have their own queue and idle bounds. Release the
            // unauthenticated-handshake budget before entering that loop.
            drop(handshake_permit);
            match authentication {
                Ok(auth) => {
                    socket_loop(
                        socket,
                        state,
                        auth,
                        query.transport.as_deref()
                            == Some(falcondeck_core::relay_transport::TRANSPORT_VERSION),
                        query.compact_index.unwrap_or(false),
                    )
                    .await
                }
                Err(error) => {
                    let _ = send_raw_error(socket, error.to_string()).await;
                }
            }
        }))
}

async fn socket_loop(
    socket: WebSocket,
    state: AppState,
    auth: SessionAuth,
    chunks: bool,
    compact_index: bool,
) {
    let (peer_id, mut rx, ready) = match state
        .register_peer(&auth.session_id, auth.role.clone(), auth.device_id.clone())
        .await
    {
        Ok(values) => values,
        Err(error) => {
            let _ = send_raw_error(socket, error.to_string()).await;
            return;
        }
    };

    let opened_at = tokio::time::Instant::now();
    tracing::info!(session_id = %auth.session_id, %peer_id, role = ?auth.role, chunks, compact_index, "relay peer opened");
    if compact_index {
        state
            .set_peer_compact_index(&auth.session_id, &peer_id)
            .await;
    }
    let (sink, stream) = socket.split();
    let sink = sink.with(|text: String| {
        futures_util::future::ready(Ok::<_, axum::Error>(Message::Text(text.into())))
    });
    // Capture only the numeric close code, never a peer-controlled close reason.
    let close_code = Arc::new(std::sync::atomic::AtomicU16::new(0));
    let observed_close_code = Arc::clone(&close_code);
    let stream = stream.map(move |message| match message {
        Ok(Message::Text(text)) => Ok(text.to_string()),
        Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => Ok(r#"{"type":"ping"}"#.to_string()),
        Ok(Message::Close(frame)) => {
            observed_close_code.store(
                frame.map(|f| f.code).unwrap_or(1005),
                std::sync::atomic::Ordering::Relaxed,
            );
            Err("peer closed websocket".to_string())
        }
        Ok(_) => Err("relay socket closed or unsupported frame".to_string()),
        Err(error) => Err(error.to_string()),
    });
    let (mut sender, mut receiver, _transport) =
        falcondeck_core::relay_transport::spawn_transport(sink, stream, chunks);
    if send_message_with_timeout(&mut sender, &ready)
        .await
        .is_err()
    {
        tracing::info!(session_id = %auth.session_id, %peer_id, reason = "ready_write_failed", "relay peer closed");
        state.unregister_peer(&auth.session_id, &peer_id).await;
        return;
    }
    state
        .after_peer_ready(&auth.session_id, auth.role.clone())
        .await;

    // Peers send heartbeat pings every 15s; 45s without any message
    // indicates a half-open or dead connection.
    let idle_timeout = tokio::time::Duration::from_secs(45);
    let mut last_activity = tokio::time::Instant::now();
    let mut idle_check = tokio::time::interval(tokio::time::Duration::from_secs(10));
    idle_check.tick().await; // consume the immediate first tick

    let mut received_messages = 0u64;
    let mut received_bytes = 0u64;
    let mut queued_messages = 0u64;
    let mut invalid_messages = 0u64;
    let mut handler_errors = 0u64;
    let mut max_handler_ms = 0u64;
    let close_reason = loop {
        tokio::select! {
            maybe_message = rx.recv() => {
                match maybe_message {
                    Some(message) => {
                        if send_message_with_timeout(&mut sender, message.message()).await.is_err() {
                            break "outbound_queue_failed";
                        }
                        queued_messages += 1;
                    }
                    None => break "peer_queue_closed",
                }
            }
            incoming = receiver.recv() => {
                let incoming = incoming.map(|r| r.map(|m| Message::Text(m.text.into())));
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        last_activity = tokio::time::Instant::now();
                        received_messages += 1;
                        received_bytes += text.len() as u64;
                        let parsed = serde_json::from_str::<RelayClientMessage>(&text);
                        match parsed {
                            Ok(message) => {
                                let started = tokio::time::Instant::now();
                                if let Err(error) = state
                                    .handle_message(&auth.session_id, &peer_id, auth.role.clone(), message)
                                    .await
                                {
                                    handler_errors += 1;
                                    let server_message = RelayServerMessage::Error {
                                        message: error.to_string(),
                                    };
                                    if send_message_with_timeout(&mut sender, &server_message)
                                        .await
                                        .is_err()
                                    {
                                        break "error_queue_failed";
                                    }
                                }
                                max_handler_ms = max_handler_ms.max(started.elapsed().as_millis() as u64);
                            }
                            Err(error) => {
                                invalid_messages += 1;
                                let server_message = RelayServerMessage::Error {
                                    message: format!("invalid websocket payload: {error}"),
                                };
                                if send_message_with_timeout(&mut sender, &server_message)
                                    .await
                                    .is_err()
                                {
                                    break "error_queue_failed";
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) => break "peer_close",
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {
                        last_activity = tokio::time::Instant::now();
                    }
                    Some(Ok(Message::Binary(_))) => {
                        last_activity = tokio::time::Instant::now();
                        let server_message = RelayServerMessage::Error {
                            message: "binary websocket payloads are not supported".to_string(),
                        };
                        if send_message_with_timeout(&mut sender, &server_message)
                            .await
                            .is_err()
                        {
                            break "error_queue_failed";
                        }
                    }
                    Some(Err(error)) => {
                        let reason = transport_failure_reason(&error);
                        tracing::warn!(session_id = %auth.session_id, %peer_id, reason,
                            "relay peer transport failed");
                        let server_message = RelayServerMessage::Error {
                            message: format!("Relay transport interrupted ({reason}); reconnecting"),
                        };
                        let _ = send_message_with_timeout(&mut sender, &server_message).await;
                        break "transport_receive_error";
                    }
                    None => break "transport_ended",
                }
            }
            _ = idle_check.tick() => {
                state.sweep_expired_rpcs(&auth.session_id).await;
                if last_activity.elapsed() > idle_timeout {
                    break "idle_timeout";
                }
            }
        }
    };

    let close_code = close_code.load(std::sync::atomic::Ordering::Relaxed);
    let reason = if close_code != 0 { "peer_close" } else { close_reason };
    tracing::info!(session_id = %auth.session_id, %peer_id, role = ?auth.role, reason, close_code,
        duration_ms = opened_at.elapsed().as_millis() as u64,
        idle_ms = last_activity.elapsed().as_millis() as u64,
        received_messages, received_bytes, queued_messages, invalid_messages, handler_errors, max_handler_ms,
        "relay peer closed");
    state.unregister_peer(&auth.session_id, &peer_id).await;
}

// Transport errors may contain peer-controlled text. Retain the failure class,
// never payloads, and do not misdiagnose every disconnect as an oversized frame.
fn transport_failure_reason(error: &str) -> &'static str {
    if error.contains("chunk acknowledgement timed out") {
        "chunk_ack_timeout"
    } else if error.contains("transfer expired") {
        "transfer_timeout"
    } else if error.contains("acknowledgement queue full") {
        "ack_queue_full"
    } else if error.contains("socket write timed out") {
        "write_timeout"
    } else if error.contains("too large") || error.contains("MessageTooLong") {
        "message_too_large"
    } else if error.contains("transfer") || error.contains("chunk") {
        "invalid_transfer"
    } else {
        "connection_closed"
    }
}

async fn submit_action(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<SubmitQueuedActionRequest>,
) -> Result<Json<falcondeck_core::QueuedRemoteAction>, RelayError> {
    let token = auth_token(&headers)?;
    Ok(Json(
        state.submit_action(&session_id, &token, request).await?,
    ))
}

async fn action_status(
    State(state): State<AppState>,
    Path((session_id, action_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::QueuedRemoteAction>, RelayError> {
    let token = auth_token(&headers)?;
    Ok(Json(
        state.action_status(&session_id, &token, &action_id).await?,
    ))
}

async fn trusted_devices(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::TrustedDevicesResponse>, RelayError> {
    let token = auth_token(&headers)?;
    Ok(Json(state.trusted_devices(&session_id, &token).await?))
}

async fn revoke_trusted_device(
    State(state): State<AppState>,
    Path((session_id, device_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::TrustedDevicesResponse>, RelayError> {
    let token = auth_token(&headers)?;
    Ok(Json(
        state
            .revoke_trusted_device(&session_id, &token, &device_id)
            .await?,
    ))
}

async fn register_push_token(
    State(state): State<AppState>,
    Path((session_id, device_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<falcondeck_core::RegisterPushTokenRequest>,
) -> Result<Json<serde_json::Value>, RelayError> {
    let token = auth_token(&headers)?;
    state
        .register_push_token(&session_id, &token, &device_id, request.push_token)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Queue without holding the socket reader behind a stalled write.
async fn send_message_with_timeout(
    sender: &mut falcondeck_core::relay_transport::TransportSender,
    message: &RelayServerMessage,
) -> Result<(), String> {
    if matches!(message, RelayServerMessage::Ready { .. }) {
        return sender
            .send_barrier(serde_json::to_string(message).map_err(|e| e.to_string())?)
            .await;
    }
    let urgent = matches!(
        message,
        RelayServerMessage::Pong
            | RelayServerMessage::ActionRequested { .. }
            | RelayServerMessage::Update {
                update: falcondeck_core::RelayUpdate {
                    body: falcondeck_core::RelayUpdateBody::SessionBootstrap { .. },
                    ..
                }
            }
            | RelayServerMessage::RpcRequest { .. }
            | RelayServerMessage::RpcResult { .. }
            | RelayServerMessage::RpcRegistered { .. }
            | RelayServerMessage::RpcUnregistered { .. }
            | RelayServerMessage::Error { .. }
    );
    sender.send(
        serde_json::to_string(message).map_err(|e| e.to_string())?,
        urgent,
    )
}

async fn send_raw_error(mut socket: WebSocket, message: String) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(&RelayServerMessage::Error { message })
        .map_err(|error| axum::Error::new(std::io::Error::other(error.to_string())))?;
    socket.send(Message::Text(payload.into())).await
}

fn auth_token(headers: &HeaderMap) -> Result<String, RelayError> {
    if let Some(header) = headers.get(axum::http::header::AUTHORIZATION)
        && let Ok(value) = header.to_str()
        && let Some((scheme, token)) = value.split_once(' ')
        && scheme.eq_ignore_ascii_case("Bearer")
    {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    Err(RelayError::Unauthorized("missing bearer token".to_string()))
}

#[cfg(test)]
mod pairing_rate_limit_tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use axum::http::{HeaderMap, HeaderValue};

    use super::pairing_client_ip;

    #[test]
    fn direct_clients_cannot_override_their_rate_limit_identity() {
        let peer = SocketAddr::from(([203, 0, 113, 10], 40_000));
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("198.51.100.20"));

        assert_eq!(pairing_client_ip(peer, &headers, &[]), peer.ip());
    }

    #[test]
    fn unconfigured_loopback_peer_cannot_spoof_forwarded_identity() {
        let peer = SocketAddr::from(([127, 0, 0, 1], 40_000));
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.99, 198.51.100.20"),
        );

        assert_eq!(pairing_client_ip(peer, &headers, &[]), peer.ip());
    }

    #[test]
    fn configured_proxy_uses_the_nearest_forwarded_client_identity() {
        let peer = SocketAddr::from(([127, 0, 0, 1], 40_000));
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.99, 198.51.100.20"),
        );

        assert_eq!(
            pairing_client_ip(peer, &headers, &[peer.ip()]),
            IpAddr::V4(Ipv4Addr::new(198, 51, 100, 20)),
        );
    }

    #[test]
    fn malformed_proxy_identity_falls_back_to_the_connected_peer() {
        let peer = SocketAddr::from(([127, 0, 0, 1], 40_000));
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("not-an-ip"));

        assert_eq!(pairing_client_ip(peer, &headers, &[peer.ip()]), peer.ip());
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{WS_MAX_MESSAGE_BYTES, acquire_ws_handshake_permit, auth_token};

    #[test]
    fn transport_diagnostics_preserve_failure_class_without_peer_text() {
        assert_eq!(
            [
                "relay chunk acknowledgement timed out",
                "relay transfer expired",
                "inconsistent relay transfer",
                "peer closed: private-payload"
            ]
            .map(super::transport_failure_reason),
            [
                "chunk_ack_timeout",
                "transfer_timeout",
                "invalid_transfer",
                "connection_closed"
            ]
        );
    }

    #[test]
    fn websocket_limit_has_headroom_for_an_encrypted_image_turn() {
        let max_turn_json_bytes = 24_usize << 20;
        // AES-GCM envelope: version + nonce + authentication tag, followed by
        // base64 and a small outer RPC JSON envelope.
        let encrypted_rpc_bytes = (max_turn_json_bytes + 1 + 12 + 16).div_ceil(3) * 4 + 1024;
        assert!(WS_MAX_MESSAGE_BYTES > encrypted_rpc_bytes);
    }

    #[test]
    fn pending_websocket_handshakes_are_bounded_before_upgrade() {
        let limiter = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = acquire_ws_handshake_permit(limiter.clone()).unwrap();
        assert!(matches!(
            acquire_ws_handshake_permit(limiter.clone()),
            Err(crate::error::RelayError::TooManyRequests(_))
        ));
        drop(permit);
        assert!(acquire_ws_handshake_permit(limiter).is_ok());
    }

    #[test]
    fn requires_authorization_header() {
        let headers = axum::http::HeaderMap::new();
        let error = auth_token(&headers).unwrap_err();
        assert_eq!(error.to_string(), "missing bearer token");
    }

    #[test]
    fn bearer_auth_scheme_is_case_insensitive() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            axum::http::HeaderValue::from_static("bearer client-token"),
        );

        assert_eq!(auth_token(&headers).unwrap(), "client-token");
    }
}
