use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::IntoResponse,
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tower_http::cors::{Any, CorsLayer};

use falcondeck_core::{
    ClaimPairingRequest, RelayClientMessage, RelayServerMessage, RelayUpdatesQuery,
    StartPairingRequest, SubmitQueuedActionRequest,
};

use crate::{
    app::{AppState, SessionAuth},
    error::RelayError,
};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/health", get(health))
        .route("/v1/pairings", post(start_pairing))
        .route("/v1/pairings/claim", post(claim_pairing))
        .route("/v1/pairings/{pairing_id}", get(pairing_status))
        .route("/v1/sessions/{session_id}/updates", get(session_updates))
        .route("/v1/sessions/{session_id}/actions", post(submit_action))
        .route(
            "/v1/sessions/{session_id}/actions/{action_id}",
            get(action_status),
        )
        .route("/v1/sessions/{session_id}/devices", get(trusted_devices))
        .route(
            "/v1/sessions/{session_id}/devices/{device_id}",
            axum::routing::delete(revoke_trusted_device),
        )
        .route("/v1/updates/ws", get(updates_ws))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct UpdatesRequestQuery {
    after_seq: Option<u64>,
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PairingAuthQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WebSocketQuery {
    session_id: String,
    token: String,
}

async fn health(State(state): State<AppState>) -> Json<falcondeck_core::RelayHealthResponse> {
    Json(state.health().await)
}

async fn start_pairing(
    State(state): State<AppState>,
    Json(request): Json<StartPairingRequest>,
) -> Result<Json<falcondeck_core::StartPairingResponse>, RelayError> {
    Ok(Json(state.start_pairing(request).await?))
}

async fn claim_pairing(
    State(state): State<AppState>,
    Json(request): Json<ClaimPairingRequest>,
) -> Result<Json<falcondeck_core::ClaimPairingResponse>, RelayError> {
    Ok(Json(state.claim_pairing(request).await?))
}

async fn pairing_status(
    State(state): State<AppState>,
    Path(pairing_id): Path<String>,
    Query(query): Query<PairingAuthQuery>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::PairingStatusResponse>, RelayError> {
    let token = auth_token(&headers, query.token.as_deref())?;
    Ok(Json(state.pairing_status(&pairing_id, &token).await?))
}

async fn session_updates(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<UpdatesRequestQuery>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::RelayUpdatesResponse>, RelayError> {
    let relay_query = RelayUpdatesQuery {
        after_seq: query.after_seq,
    };
    let token = auth_token(&headers, query.token.as_deref())?;
    Ok(Json(
        state
            .session_updates(&session_id, &token, relay_query.after_seq.unwrap_or(0))
            .await?,
    ))
}

async fn updates_ws(
    ws: WebSocketUpgrade,
    Query(query): Query<WebSocketQuery>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, RelayError> {
    let auth = state
        .authenticate_session(&query.session_id, &query.token)
        .await?;
    Ok(ws.on_upgrade(move |socket| socket_loop(socket, state, auth)))
}

async fn socket_loop(socket: WebSocket, state: AppState, auth: SessionAuth) {
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

    let (mut sender, mut receiver) = socket.split();
    if send_message(&mut sender, &ready).await.is_err() {
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

    loop {
        tokio::select! {
            maybe_message = rx.recv() => {
                match maybe_message {
                    Some(message) => {
                        if send_message(&mut sender, &message).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        last_activity = tokio::time::Instant::now();
                        let parsed = serde_json::from_str::<RelayClientMessage>(&text);
                        match parsed {
                            Ok(message) => {
                                if let Err(error) = state
                                    .handle_message(&auth.session_id, &peer_id, auth.role.clone(), message)
                                    .await
                                {
                                    let server_message = RelayServerMessage::Error {
                                        message: error.to_string(),
                                    };
                                    if send_message(&mut sender, &server_message).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(error) => {
                                let server_message = RelayServerMessage::Error {
                                    message: format!("invalid websocket payload: {error}"),
                                };
                                if send_message(&mut sender, &server_message).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {
                        last_activity = tokio::time::Instant::now();
                    }
                    Some(Ok(Message::Binary(_))) => {
                        last_activity = tokio::time::Instant::now();
                        let server_message = RelayServerMessage::Error {
                            message: "binary websocket payloads are not supported".to_string(),
                        };
                        if send_message(&mut sender, &server_message).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
            _ = idle_check.tick() => {
                if last_activity.elapsed() > idle_timeout {
                    tracing::warn!(
                        session_id = %auth.session_id,
                        peer_id = %peer_id,
                        "peer idle for {:?}, closing connection",
                        last_activity.elapsed()
                    );
                    break;
                }
            }
        }
    }

    state.unregister_peer(&auth.session_id, &peer_id).await;
}

async fn submit_action(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<SubmitQueuedActionRequest>,
) -> Result<Json<falcondeck_core::QueuedRemoteAction>, RelayError> {
    let token = auth_token(&headers, None)?;
    Ok(Json(
        state.submit_action(&session_id, &token, request).await?,
    ))
}

async fn action_status(
    State(state): State<AppState>,
    Path((session_id, action_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::QueuedRemoteAction>, RelayError> {
    let token = auth_token(&headers, None)?;
    Ok(Json(
        state.action_status(&session_id, &token, &action_id).await?,
    ))
}

async fn trusted_devices(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::TrustedDevicesResponse>, RelayError> {
    let token = auth_token(&headers, None)?;
    Ok(Json(state.trusted_devices(&session_id, &token).await?))
}

async fn revoke_trusted_device(
    State(state): State<AppState>,
    Path((session_id, device_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<falcondeck_core::TrustedDevicesResponse>, RelayError> {
    let token = auth_token(&headers, None)?;
    Ok(Json(
        state
            .revoke_trusted_device(&session_id, &token, &device_id)
            .await?,
    ))
}

async fn send_message(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &RelayServerMessage,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(message)
        .map_err(|error| axum::Error::new(std::io::Error::other(error.to_string())))?;
    sender.send(Message::Text(payload.into())).await
}

async fn send_raw_error(mut socket: WebSocket, message: String) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(&RelayServerMessage::Error { message })
        .map_err(|error| axum::Error::new(std::io::Error::other(error.to_string())))?;
    socket.send(Message::Text(payload.into())).await
}

fn auth_token(headers: &HeaderMap, fallback: Option<&str>) -> Result<String, RelayError> {
    if let Some(header) = headers.get(axum::http::header::AUTHORIZATION) {
        if let Ok(value) = header.to_str() {
            if let Some(token) = value.strip_prefix("Bearer ") {
                let trimmed = token.trim();
                if !trimmed.is_empty() {
                    return Ok(trimmed.to_string());
                }
            }
        }
    }

    if let Some(token) = fallback {
        if !token.trim().is_empty() {
            return Ok(token.trim().to_string());
        }
    }

    Err(RelayError::Unauthorized("missing bearer token".to_string()))
}

#[cfg(test)]
mod tests {
    use super::auth_token;

    #[test]
    fn falls_back_to_query_token() {
        let headers = axum::http::HeaderMap::new();
        let token = auth_token(&headers, Some("abc123")).unwrap();
        assert_eq!(token, "abc123");
    }
}
