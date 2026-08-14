use axum::{
    Json, Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Path, Query, Request, State,
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
    ApprovalResponseRequest, ClientActivityRequest, ConnectWorkspaceRequest,
    CreateScheduledTaskRequest, ForkThreadRequest, HandoffBriefRequest, InteractiveResponseRequest,
    InvokeExtensionActionRequest, MarkThreadReadRequest, SendTurnRequest, SetThreadGoalRequest,
    SnapshotRequest, StartRemotePairingRequest, StartReviewRequest, StartThreadRequest,
    ThreadDetailMode, ThreadDetailRequest, UnifiedEvent, UpdateExtensionRequest,
    UpdatePreferencesRequest, UpdateScheduledTaskRequest, UpdateThreadRequest,
};

use crate::{
    app::{
        AppState,
        host_provisioning::{
            HostCommandRequest, HostCommandResponse, ProvisionHostRequest, ProvisionJob,
            StartProvisionResponse,
        },
    },
    error::DaemonError,
    ssh_config::SshHostsResponse,
};

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
        .route("/api/client-activity", post(client_activity))
        .route("/api/remote/status", get(remote_status))
        .route("/api/remote/pairing", post(start_remote_pairing))
        .route(
            "/api/remote/devices/{device_id}",
            delete(revoke_remote_device),
        )
        .route("/api/ssh/hosts", get(ssh_hosts))
        .route("/api/hosts/provision", post(provision_host))
        .route("/api/hosts/provision/{job_id}", get(provision_host_status))
        .route("/api/hosts/command", post(host_command))
        .route("/api/events", get(events))
        .route(
            "/api/scheduled-tasks",
            get(scheduled_tasks).post(create_scheduled_task),
        )
        .route(
            "/api/scheduled-tasks/{task_id}",
            get(scheduled_task)
                .patch(update_scheduled_task)
                .delete(delete_scheduled_task),
        )
        .route(
            "/api/scheduled-tasks/{task_id}/run",
            post(run_scheduled_task),
        )
        .route(
            "/api/scheduled-tasks/{task_id}/runs",
            get(scheduled_task_runs),
        )
        .route("/api/workspaces/connect", post(connect_workspace))
        .route("/api/workspaces/{workspace_id}", delete(remove_workspace))
        .route(
            "/api/workspaces/{workspace_id}/collaboration-modes",
            get(collaboration_modes),
        )
        .route("/api/workspaces/{workspace_id}/threads", post(start_thread))
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/fork",
            post(fork_thread),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}",
            get(thread_detail)
                .patch(update_thread)
                .delete(delete_thread),
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
            "/api/workspaces/{workspace_id}/threads/{thread_id}/unread",
            post(mark_thread_unread),
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
            "/api/workspaces/{workspace_id}/threads/{thread_id}/queue/{queued_id}",
            delete(remove_queued_turn).patch(edit_queued_turn),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/queue/reorder",
            post(reorder_queued_turns),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/queue/{queued_id}/steer",
            post(steer_queued_turn),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/queue/{queued_id}/attachment-preview",
            get(queued_turn_attachment_preview),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/review",
            post(start_review),
        )
        .route(
            "/api/workspaces/{workspace_id}/threads/{thread_id}/handoff-brief",
            post(handoff_brief),
        )
        .route(
            "/api/workspaces/{workspace_id}/interactive-requests/{request_id}/respond",
            post(respond_interactive_request),
        )
        .route(
            "/api/workspaces/{workspace_id}/approvals/{request_id}/respond",
            post(respond_approval),
        )
        .route(
            "/api/connectors",
            get(read_connectors).put(update_connectors),
        )
        .route("/api/providers", get(read_providers).put(update_providers))
        .route(
            "/api/speech/openrouter-key",
            get(speech_openrouter_status)
                .put(save_speech_openrouter_key)
                .delete(delete_speech_openrouter_key),
        )
        .route("/api/speech/models", get(speech_models))
        .route(
            "/api/speech/transcribe",
            post(speech_transcribe).layer(DefaultBodyLimit::max(12 * 1024 * 1024)),
        )
        .route("/api/extensions", get(extensions))
        .route(
            "/api/extensions/{extension_id}",
            axum::routing::patch(update_extension),
        )
        .route(
            "/api/extensions/{extension_id}/permissions",
            axum::routing::patch(update_extension_permission),
        )
        .route(
            "/api/extensions/{extension_id}/actions/{action_id}",
            post(invoke_extension_action),
        )
        .route("/api/workspaces/{workspace_id}/git/status", get(git_status))
        .route("/api/workspaces/{workspace_id}/git/diff", get(git_diff))
        .route("/api/workspaces/{workspace_id}/files", get(workspace_files))
        .route(
            "/api/workspaces/{workspace_id}/files/content",
            get(workspace_file).put(write_workspace_file),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/branches",
            get(git_branches),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/checkout",
            post(git_checkout),
        )
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

async fn speech_openrouter_status(
    State(state): State<AppState>,
) -> Result<Json<crate::app::SpeechCredentialStatus>, DaemonError> {
    Ok(Json(state.speech_credential_status().await?))
}

async fn save_speech_openrouter_key(
    State(state): State<AppState>,
    Json(request): Json<crate::app::SaveSpeechCredentialRequest>,
) -> Result<Json<crate::app::SpeechCredentialStatus>, DaemonError> {
    Ok(Json(state.save_speech_credential(request.api_key).await?))
}

async fn delete_speech_openrouter_key(
    State(state): State<AppState>,
) -> Result<Json<crate::app::SpeechCredentialStatus>, DaemonError> {
    Ok(Json(state.delete_speech_credential().await?))
}

async fn speech_models(
    State(state): State<AppState>,
) -> Result<Json<Vec<crate::app::SpeechModel>>, DaemonError> {
    Ok(Json(state.speech_models().await?))
}

async fn speech_transcribe(
    State(state): State<AppState>,
    Json(request): Json<crate::app::SpeechTranscriptionRequest>,
) -> Result<Json<crate::app::SpeechTranscriptionResponse>, DaemonError> {
    Ok(Json(state.transcribe_speech(request).await?))
}

async fn extensions(State(state): State<AppState>) -> Json<falcondeck_core::ExtensionSnapshot> {
    Json(state.extension_snapshot().await)
}

async fn update_extension(
    State(state): State<AppState>,
    Path(extension_id): Path<String>,
    Json(request): Json<UpdateExtensionRequest>,
) -> Result<Json<falcondeck_core::ExtensionSummary>, DaemonError> {
    Ok(Json(
        state
            .update_extension(&extension_id, request.enabled)
            .await?,
    ))
}

async fn update_extension_permission(
    State(state): State<AppState>,
    Path(extension_id): Path<String>,
    Json(request): Json<falcondeck_core::UpdateExtensionPermissionRequest>,
) -> Result<Json<falcondeck_core::ExtensionSummary>, DaemonError> {
    Ok(Json(
        state
            .update_extension_permission(&extension_id, &request.permission, request.granted)
            .await?,
    ))
}

async fn invoke_extension_action(
    State(state): State<AppState>,
    Path((extension_id, action_id)): Path<(String, String)>,
    Json(request): Json<InvokeExtensionActionRequest>,
) -> Result<Json<falcondeck_core::ExtensionActionResponse>, DaemonError> {
    Ok(Json(
        state
            .invoke_extension_action(&extension_id, &action_id, request)
            .await?,
    ))
}

async fn client_activity(
    State(state): State<AppState>,
    Json(request): Json<ClientActivityRequest>,
) -> StatusCode {
    state.set_desktop_activity(request.active);
    StatusCode::NO_CONTENT
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

async fn ssh_hosts() -> Json<SshHostsResponse> {
    Json(crate::ssh_config::list_ssh_hosts().await)
}

async fn provision_host(
    State(state): State<AppState>,
    Json(request): Json<ProvisionHostRequest>,
) -> Result<Json<StartProvisionResponse>, DaemonError> {
    Ok(Json(state.start_host_provision(request).await?))
}

async fn provision_host_status(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<Json<ProvisionJob>, DaemonError> {
    Ok(Json(state.host_provision_job(&job_id).await?))
}

async fn host_command(
    State(state): State<AppState>,
    Json(request): Json<HostCommandRequest>,
) -> Result<Json<HostCommandResponse>, DaemonError> {
    Ok(Json(state.run_host_command(request).await?))
}

async fn scheduled_tasks(
    State(state): State<AppState>,
) -> Json<Vec<falcondeck_core::ScheduledTaskSummary>> {
    Json(state.scheduled_tasks().await)
}

async fn create_scheduled_task(
    State(state): State<AppState>,
    Json(request): Json<CreateScheduledTaskRequest>,
) -> Result<Json<falcondeck_core::ScheduledTaskDetail>, DaemonError> {
    Ok(Json(state.create_scheduled_task(request).await?))
}

async fn scheduled_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<falcondeck_core::ScheduledTaskDetail>, DaemonError> {
    Ok(Json(state.scheduled_task(&task_id).await?))
}

async fn update_scheduled_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Json(request): Json<UpdateScheduledTaskRequest>,
) -> Result<Json<falcondeck_core::ScheduledTaskDetail>, DaemonError> {
    Ok(Json(state.update_scheduled_task(&task_id, request).await?))
}

async fn delete_scheduled_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(state.delete_scheduled_task(&task_id).await?))
}

async fn run_scheduled_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<falcondeck_core::ScheduledTaskRunSummary>, DaemonError> {
    Ok(Json(state.run_scheduled_task(&task_id).await?))
}

async fn scheduled_task_runs(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<Vec<falcondeck_core::ScheduledTaskRunSummary>>, DaemonError> {
    Ok(Json(state.scheduled_task_runs(&task_id).await?))
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

async fn handoff_brief(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
    Json(mut request): Json<HandoffBriefRequest>,
) -> Result<Json<falcondeck_core::HandoffBriefResponse>, DaemonError> {
    request.workspace_id = workspace_id;
    request.thread_id = thread_id;
    Ok(Json(state.handoff_brief(request).await?))
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

async fn fork_thread(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
    Json(mut request): Json<ForkThreadRequest>,
) -> Result<Json<falcondeck_core::ThreadHandle>, DaemonError> {
    request.workspace_id = workspace_id;
    request.thread_id = thread_id;
    Ok(Json(state.fork_thread(request).await?))
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

async fn delete_thread(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(state.delete_thread(&workspace_id, &thread_id).await?))
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

async fn mark_thread_unread(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
) -> Result<Json<falcondeck_core::ThreadSummary>, DaemonError> {
    Ok(Json(
        state.mark_thread_unread(&workspace_id, &thread_id).await?,
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

/// Isolated threads report the status of their own checkout, so the thread is
/// part of the question. Absent means the workspace folder.
#[derive(serde::Deserialize)]
struct GitStatusQuery {
    thread_id: Option<String>,
}

async fn git_status(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<GitStatusQuery>,
) -> Result<Json<falcondeck_core::GitStatusResponse>, DaemonError> {
    Ok(Json(
        state
            .git_status(&workspace_id, query.thread_id.as_deref())
            .await?,
    ))
}

async fn git_branches(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<falcondeck_core::GitBranchesResponse>, DaemonError> {
    Ok(Json(state.git_branches(&workspace_id).await?))
}

#[derive(serde::Deserialize)]
struct GitCheckoutRequest {
    branch: String,
    #[serde(default)]
    create: bool,
}

/// Switches (or creates) a branch in the project folder and returns the
/// refreshed branch list, so the picker can update from a single round trip.
async fn git_checkout(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Json(request): Json<GitCheckoutRequest>,
) -> Result<Json<falcondeck_core::GitBranchesResponse>, DaemonError> {
    Ok(Json(
        state
            .git_checkout(&workspace_id, &request.branch, request.create)
            .await?,
    ))
}

async fn remove_queued_turn(
    State(state): State<AppState>,
    Path((workspace_id, thread_id, queued_id)): Path<(String, String, String)>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(
        state
            .remove_queued_turn(&workspace_id, &thread_id, &queued_id)
            .await?,
    ))
}

async fn steer_queued_turn(
    State(state): State<AppState>,
    Path((workspace_id, thread_id, queued_id)): Path<(String, String, String)>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(
        state
            .steer_queued_turn(&workspace_id, &thread_id, &queued_id)
            .await?,
    ))
}

#[derive(serde::Deserialize)]
struct EditQueuedTurnRequest {
    text: String,
}

async fn edit_queued_turn(
    State(state): State<AppState>,
    Path((workspace_id, thread_id, queued_id)): Path<(String, String, String)>,
    Json(request): Json<EditQueuedTurnRequest>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(
        state
            .edit_queued_turn(&workspace_id, &thread_id, &queued_id, &request.text)
            .await?,
    ))
}

#[derive(serde::Deserialize)]
struct ReorderQueuedTurnsRequest {
    queued_ids: Vec<String>,
}

async fn reorder_queued_turns(
    State(state): State<AppState>,
    Path((workspace_id, thread_id)): Path<(String, String)>,
    Json(request): Json<ReorderQueuedTurnsRequest>,
) -> Result<Json<falcondeck_core::CommandResponse>, DaemonError> {
    Ok(Json(
        state
            .reorder_queued_turns(&workspace_id, &thread_id, &request.queued_ids)
            .await?,
    ))
}

async fn queued_turn_attachment_preview(
    State(state): State<AppState>,
    Path((workspace_id, thread_id, queued_id)): Path<(String, String, String)>,
) -> Result<Response, DaemonError> {
    let (mime, bytes) = state
        .queued_turn_attachment_preview(&workspace_id, &thread_id, &queued_id)
        .await?;
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "private, max-age=60")
        .body(Body::from(bytes))
        .map_err(|error| DaemonError::Process(error.to_string()))
}

#[derive(serde::Deserialize)]
struct ConnectorsQuery {
    workspace_id: Option<String>,
}

#[derive(serde::Deserialize)]
struct UpdateConnectorsRequest {
    scope: crate::connectors::ConnectorScope,
    workspace_id: Option<String>,
    #[serde(rename = "mcpServers")]
    mcp_servers: serde_json::Value,
}

async fn connectors_workspace_path(
    state: &AppState,
    workspace_id: Option<&str>,
) -> Result<Option<String>, DaemonError> {
    let Some(workspace_id) = workspace_id else {
        return Ok(None);
    };
    let snapshot = state.snapshot().await;
    snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .map(|workspace| Some(workspace.path.clone()))
        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))
}

fn providers_state_dir(state: &AppState) -> Result<std::path::PathBuf, DaemonError> {
    state
        .state_dir()
        .ok_or_else(|| DaemonError::Process("daemon state directory unavailable".to_string()))
}

async fn read_providers(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, DaemonError> {
    Ok(Json(crate::acp::providers_overview(&providers_state_dir(
        &state,
    )?)))
}

#[derive(serde::Deserialize)]
struct UpdateProvidersRequest {
    providers: serde_json::Value,
}

async fn update_providers(
    State(state): State<AppState>,
    Json(request): Json<UpdateProvidersRequest>,
) -> Result<Json<serde_json::Value>, DaemonError> {
    crate::acp::write_providers_file(&providers_state_dir(&state)?, &request.providers)
        .map_err(DaemonError::BadRequest)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn read_connectors(
    State(state): State<AppState>,
    Query(query): Query<ConnectorsQuery>,
) -> Result<Json<serde_json::Value>, DaemonError> {
    let workspace_path = connectors_workspace_path(&state, query.workspace_id.as_deref()).await?;
    Ok(Json(crate::connectors::connectors_overview(
        workspace_path.as_deref(),
    )))
}

async fn update_connectors(
    State(state): State<AppState>,
    Json(request): Json<UpdateConnectorsRequest>,
) -> Result<Json<serde_json::Value>, DaemonError> {
    let workspace_path = connectors_workspace_path(&state, request.workspace_id.as_deref()).await?;
    crate::connectors::write_mcp_servers(
        request.scope,
        workspace_path.as_deref(),
        &request.mcp_servers,
    )
    .map_err(DaemonError::BadRequest)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(serde::Deserialize)]
struct GitDiffQuery {
    path: Option<String>,
    status: Option<falcondeck_core::GitFileStatus>,
    thread_id: Option<String>,
}

async fn git_diff(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<GitDiffQuery>,
) -> Result<Json<falcondeck_core::GitDiffResponse>, DaemonError> {
    Ok(Json(
        state
            .git_diff(
                &workspace_id,
                query.thread_id.as_deref(),
                query.path.as_deref(),
                query.status.as_ref(),
            )
            .await?,
    ))
}

#[derive(serde::Deserialize)]
struct WorkspaceFilesQuery {
    thread_id: Option<String>,
}

async fn workspace_files(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<WorkspaceFilesQuery>,
) -> Result<Json<falcondeck_core::WorkspaceFilesResponse>, DaemonError> {
    Ok(Json(
        state
            .workspace_files(&workspace_id, query.thread_id.as_deref())
            .await?,
    ))
}

#[derive(serde::Deserialize)]
struct WorkspaceFileQuery {
    path: String,
    thread_id: Option<String>,
}

async fn workspace_file(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<WorkspaceFileQuery>,
) -> Result<Json<falcondeck_core::WorkspaceFileResponse>, DaemonError> {
    Ok(Json(
        state
            .workspace_file(&workspace_id, query.thread_id.as_deref(), &query.path)
            .await?,
    ))
}

async fn write_workspace_file(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<WorkspaceFileQuery>,
    Json(request): Json<falcondeck_core::WriteWorkspaceFileRequest>,
) -> Result<Json<falcondeck_core::WorkspaceFileResponse>, DaemonError> {
    Ok(Json(
        state
            .write_workspace_file(
                &workspace_id,
                query.thread_id.as_deref(),
                &query.path,
                &request,
            )
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
