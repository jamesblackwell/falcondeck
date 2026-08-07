use axum::{
    Json, Router,
    extract::{
        Path, Query, Request, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use futures_util::StreamExt;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};

use falcondeck_core::{
    ApprovalResponseRequest, ConnectWorkspaceRequest, InteractiveResponseRequest,
    MarkThreadReadRequest, SendTurnRequest, SetThreadGoalRequest, SnapshotRequest,
    StartRemotePairingRequest, StartReviewRequest, StartThreadRequest, ThreadDetailMode,
    ThreadDetailRequest, UnifiedEvent, UpdatePreferencesRequest, UpdateThreadRequest,
};

use crate::{app::AppState, error::DaemonError};

/// Browser origins allowed to call the daemon API: the Tauri webview only
/// (dev server plus the prod webview origins). The API is unauthenticated and
/// includes approval endpoints, so arbitrary web pages must never be able to
/// read responses or send permitted cross-origin writes.
const ALLOWED_BROWSER_ORIGINS: [&str; 5] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];

/// Rejects any request whose `Host` is not a loopback authority. CORS cannot
/// stop DNS rebinding (the origin looks same-site to the browser), but the
/// rebound request still carries the attacker's hostname in `Host`, so this
/// check defeats it. Requests without an `Origin` header (the Claude hook's
/// curl POST, native clients) are unaffected: they always target
/// `127.0.0.1:<port>` directly.
async fn require_loopback_host(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        // HTTP/2 requests carry the authority in the URI instead of a header.
        .or_else(|| {
            request
                .uri()
                .authority()
                .map(|authority| authority.to_string())
        });
    match host {
        Some(host) if is_loopback_host(&host) => next.run(request).await,
        _ => StatusCode::FORBIDDEN.into_response(),
    }
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    let name = if let Some(rest) = host.strip_prefix('[') {
        // Bracketed IPv6 authority: `[::1]` with an optional `:port` suffix.
        let Some((address, port)) = rest.split_once(']') else {
            return false;
        };
        if !(port.is_empty() || port.starts_with(':')) {
            return false;
        }
        address
    } else {
        host.rsplit_once(':').map(|(name, _)| name).unwrap_or(host)
    };
    name.eq_ignore_ascii_case("localhost") || matches!(name, "127.0.0.1" | "::1")
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/snapshot", get(snapshot))
        .route(
            "/api/preferences",
            get(preferences).patch(update_preferences),
        )
        .route("/api/remote/status", get(remote_status))
        .route("/api/remote/pairing", post(start_remote_pairing))
        .route(
            "/api/remote/devices/{device_id}",
            delete(revoke_remote_device),
        )
        .route("/api/events", get(events))
        .route("/api/workspaces/connect", post(connect_workspace))
        .route("/api/workspaces/{workspace_id}", delete(remove_workspace))
        .route(
            "/api/workspaces/{workspace_id}/collaboration-modes",
            get(collaboration_modes),
        )
        .route("/api/workspaces/{workspace_id}/threads", post(start_thread))
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}",
            get(thread_detail).patch(update_thread),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/archive",
            post(archive_thread),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/unarchive",
            post(unarchive_thread),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/turns",
            post(send_turn),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/read",
            post(mark_thread_read),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/goal",
            post(set_thread_goal).delete(clear_thread_goal),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/interrupt",
            post(interrupt_turn),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/review",
            post(start_review),
        )
        .route(
            "/api/workspaces/{workspace_id}/interactive-requests/{request_id}/respond",
            post(respond_interactive_request),
        )
        .route(
            "/api/workspaces/{workspace_id}/approvals/{request_id}/respond",
            post(respond_approval),
        )
        .route("/api/workspaces/{workspace_id}/git/status", get(git_status))
        .route("/api/workspaces/{workspace_id}/git/diff", get(git_diff))
        .route("/api/claude/hooks/pre-tool-use", post(claude_pre_tool_use))
        .layer(
            CorsLayer::new()
                .allow_origin(ALLOWED_BROWSER_ORIGINS.map(HeaderValue::from_static))
                .allow_methods(Any)
                .allow_headers(Any),
        )
        // Added after the CORS layer so it runs first: a DNS-rebound request
        // must be rejected before anything else sees it.
        .layer(middleware::from_fn(require_loopback_host))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<falcondeck_core::HealthResponse> {
    Json(state.health().await)
}

async fn snapshot(
    State(state): State<AppState>,
    Query(request): Query<SnapshotRequest>,
) -> Json<falcondeck_core::DaemonSnapshot> {
    Json(state.snapshot_with_request(&request).await)
}

async fn preferences(
    State(state): State<AppState>,
) -> Json<falcondeck_core::FalconDeckPreferences> {
    Json(state.preferences().await)
}

async fn update_preferences(
    State(state): State<AppState>,
    Json(request): Json<UpdatePreferencesRequest>,
) -> Result<Json<falcondeck_core::FalconDeckPreferences>, DaemonError> {
    Ok(Json(state.update_preferences(request).await?))
}

async fn remote_status(
    State(state): State<AppState>,
) -> Json<falcondeck_core::RemoteStatusResponse> {
    Json(state.remote_status().await)
}

async fn start_remote_pairing(
    State(state): State<AppState>,
    Json(request): Json<StartRemotePairingRequest>,
) -> Result<Json<falcondeck_core::RemoteStatusResponse>, DaemonError> {
    Ok(Json(state.start_remote_pairing(request).await?))
}

async fn revoke_remote_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
) -> Result<Json<falcondeck_core::RemoteStatusResponse>, DaemonError> {
    Ok(Json(state.revoke_remote_device(&device_id).await?))
}

async fn remove_workspace(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(state.remove_workspace(&workspace_id).await?))
}

async fn connect_workspace(
    State(state): State<AppState>,
    Json(request): Json<ConnectWorkspaceRequest>,
) -> Result<Json<falcondeck_core::WorkspaceSummary>, DaemonError> {
    Ok(Json(state.connect_workspace(request).await?))
}

async fn collaboration_modes(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<falcondeck_core::CollaborationModeSummary>>, DaemonError> {
    Ok(Json(state.collaboration_modes(&workspace_id).await?))
}

async fn start_thread(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Json(mut request): Json<StartThreadRequest>,
) -> Result<Json<falcondeck_core::ThreadHandle>, DaemonError> {
    request.workspace_id = workspace_id;
    Ok(Json(state.start_thread(request).await?))
}

async fn thread_detail(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
    Query(query): Query<ThreadDetailQuery>,
) -> Result<Json<falcondeck_core::ThreadDetail>, DaemonError> {
    Ok(Json(
        state
            .thread_detail_with_request(&ThreadDetailRequest {
                workspace_id,
                thread_id,
                mode: query.mode,
                limit: query.limit,
                before_item_id: query.before_item_id,
            })
            .await?,
    ))
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ThreadDetailQuery {
    #[serde(default)]
    mode: ThreadDetailMode,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    before_item_id: Option<String>,
}

async fn update_thread(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
    Json(mut request): Json<UpdateThreadRequest>,
) -> Result<Json<falcondeck_core::ThreadHandle>, DaemonError> {
    request.workspace_id = workspace_id;
    request.thread_id = thread_id;
    Ok(Json(state.update_thread(request).await?))
}

async fn archive_thread(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
) -> Result<Json<falcondeck_core::ThreadSummary>, DaemonError> {
    Ok(Json(state.archive_thread(&workspace_id, &thread_id).await?))
}

async fn unarchive_thread(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
) -> Result<Json<falcondeck_core::ThreadSummary>, DaemonError> {
    Ok(Json(
        state.unarchive_thread(&workspace_id, &thread_id).await?,
    ))
}

async fn send_turn(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
    Json(mut request): Json<SendTurnRequest>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    request.workspace_id = workspace_id;
    request.thread_id = thread_id;
    Ok(Json(state.send_turn(request).await?))
}

async fn mark_thread_read(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
    Json(request): Json<MarkThreadReadRequest>,
) -> Result<Json<falcondeck_core::ThreadSummary>, DaemonError> {
    Ok(Json(
        state
            .mark_thread_read(&workspace_id, &thread_id, request.read_seq)
            .await?,
    ))
}

async fn set_thread_goal(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
    Json(mut request): Json<SetThreadGoalRequest>,
) -> Result<Json<falcondeck_core::ThreadSummary>, DaemonError> {
    request.workspace_id = workspace_id;
    request.thread_id = thread_id;
    Ok(Json(state.set_thread_goal(request).await?))
}

async fn clear_thread_goal(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
) -> Result<Json<falcondeck_core::ThreadSummary>, DaemonError> {
    Ok(Json(
        state.clear_thread_goal(&workspace_id, &thread_id).await?,
    ))
}

async fn interrupt_turn(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(state.interrupt_turn(workspace_id, thread_id).await?))
}

async fn start_review(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
    Json(mut request): Json<StartReviewRequest>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    request.workspace_id = workspace_id;
    request.thread_id = thread_id;
    Ok(Json(state.start_review(request).await?))
}

async fn respond_interactive_request(
    State(state): State<AppState>,
    Path((workspace_id, request_id)): Path<(String, String)>,
    Json(request): Json<InteractiveResponseRequest>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(
        state
            .respond_to_interactive_request(workspace_id, request_id, request.response)
            .await?,
    ))
}

async fn respond_approval(
    State(state): State<AppState>,
    Path((workspace_id, request_id)): Path<(String, String)>,
    Json(request): Json<ApprovalResponseRequest>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(
        state
            .respond_to_interactive_request(
                workspace_id,
                request_id,
                falcondeck_core::InteractiveResponsePayload::Approval {
                    decision: request.decision,
                },
            )
            .await?,
    ))
}

async fn claude_pre_tool_use(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    Json(state.handle_claude_pre_tool_use(payload).await)
}

async fn git_status(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<falcondeck_core::GitStatusResponse>, DaemonError> {
    Ok(Json(state.git_status(&workspace_id).await?))
}

#[derive(serde::Deserialize)]
struct GitDiffQuery {
    path: Option<String>,
    status: Option<falcondeck_core::GitFileStatus>,
}

async fn git_diff(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<GitDiffQuery>,
) -> Result<Json<falcondeck_core::GitDiffResponse>, DaemonError> {
    Ok(Json(
        state
            .git_diff(&workspace_id, query.path.as_deref(), query.status.as_ref())
            .await?,
    ))
}

async fn events(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| event_socket(socket, state))
}

async fn event_socket(mut socket: WebSocket, state: AppState) {
    // Subscribe before taking the snapshot so no event emitted in between is
    // lost. Events that are already reflected in the snapshot may be
    // re-delivered afterwards, which clients apply as idempotent upserts.
    let mut receiver = state.subscribe();
    let snapshot = state.snapshot().await;
    let initial_event = falcondeck_core::EventEnvelope {
        seq: 0,
        emitted_at: chrono::Utc::now(),
        workspace_id: None,
        thread_id: None,
        event: UnifiedEvent::Snapshot { snapshot },
    };
    if socket
        .send(Message::Text(
            serde_json::to_string(&initial_event)
                .unwrap_or_else(|_| "{}".to_string())
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            event_result = receiver.recv() => {
                match event_result {
                    Ok(event) => {
                        if socket
                            .send(Message::Text(
                                serde_json::to_string(&event)
                                    .unwrap_or_else(|_| "{}".to_string())
                                    .into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!("local daemon event stream lagged, skipped {skipped} events; sending fresh snapshot");
                        let snapshot = state.snapshot().await;
                        let snapshot_event = falcondeck_core::EventEnvelope {
                            seq: 0,
                            emitted_at: chrono::Utc::now(),
                            workspace_id: None,
                            thread_id: None,
                            event: UnifiedEvent::Snapshot { snapshot },
                        };
                        if socket
                            .send(Message::Text(
                                serde_json::to_string(&snapshot_event)
                                    .unwrap_or_else(|_| "{}".to_string())
                                    .into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            message = socket.next() => {
                if message.is_none() {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_loopback_host;

    #[test]
    fn accepts_loopback_hosts_with_and_without_ports() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.0.0.1:4520"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("LocalHost:4520"));
        assert!(is_loopback_host("[::1]"));
        assert!(is_loopback_host("[::1]:4520"));
    }

    #[test]
    fn rejects_non_loopback_hosts() {
        assert!(!is_loopback_host("evil.com"));
        assert!(!is_loopback_host("evil.com:4520"));
        assert!(!is_loopback_host("localhost.evil.com"));
        assert!(!is_loopback_host("127.0.0.1.evil.com"));
        assert!(!is_loopback_host("[2001:db8::1]:4520"));
        assert!(!is_loopback_host("[::1]evil"));
        assert!(!is_loopback_host(""));
    }
}
