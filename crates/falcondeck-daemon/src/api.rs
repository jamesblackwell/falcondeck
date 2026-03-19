use axum::{
    Json, Router,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::{delete, get, post},
};
use futures_util::StreamExt;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};

use falcondeck_core::{
    ApprovalResponseRequest, ConnectWorkspaceRequest, InteractiveResponseRequest,
    MarkThreadReadRequest, SendTurnRequest, StartRemotePairingRequest, StartReviewRequest,
    StartThreadRequest, UnifiedEvent, UpdateThreadRequest,
};

use crate::{app::AppState, error::DaemonError};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/snapshot", get(snapshot))
        .route("/api/remote/status", get(remote_status))
        .route("/api/remote/pairing", post(start_remote_pairing))
        .route(
            "/api/remote/devices/{device_id}",
            delete(revoke_remote_device),
        )
        .route("/api/events", get(events))
        .route("/api/workspaces/connect", post(connect_workspace))
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
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<falcondeck_core::HealthResponse> {
    Json(state.health().await)
}

async fn snapshot(State(state): State<AppState>) -> Json<falcondeck_core::DaemonSnapshot> {
    Json(state.snapshot().await)
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
) -> Result<Json<falcondeck_core::ThreadDetail>, DaemonError> {
    Ok(Json(state.thread_detail(&workspace_id, &thread_id).await?))
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

async fn git_status(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<falcondeck_core::GitStatusResponse>, DaemonError> {
    Ok(Json(state.git_status(&workspace_id).await?))
}

#[derive(serde::Deserialize)]
struct GitDiffQuery {
    path: Option<String>,
}

async fn git_diff(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<GitDiffQuery>,
) -> Result<Json<falcondeck_core::GitDiffResponse>, DaemonError> {
    Ok(Json(
        state.git_diff(&workspace_id, query.path.as_deref()).await?,
    ))
}

async fn events(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| event_socket(socket, state))
}

async fn event_socket(mut socket: WebSocket, state: AppState) {
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

    let mut receiver = state.subscribe();
    loop {
        tokio::select! {
            received = receiver.recv() => {
                match received {
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
