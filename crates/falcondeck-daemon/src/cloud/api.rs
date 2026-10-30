use crate::{app::AppState, error::DaemonError};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    routing::{get, post},
};
use falcondeck_core::*;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/cloud/settings", get(settings).put(update_settings))
        .route("/api/cloud/capture", post(capture))
        .route("/api/cloud/jobs", get(list).post(create))
        .route("/api/cloud/jobs/{id}", get(job))
        .route("/api/cloud/jobs/{id}/detail", get(detail))
        .route(
            "/api/cloud/jobs/{id}/turns",
            post(turn).layer(DefaultBodyLimit::max(56 << 20)),
        )
        .route("/api/cloud/jobs/{id}/interrupt", post(interrupt))
        .route(
            "/api/cloud/jobs/{id}/approvals/{request_id}",
            post(approval),
        )
        .route(
            "/api/cloud/jobs/{id}/interactive/{request_id}",
            post(interactive),
        )
        .route("/api/cloud/jobs/{id}/collect", post(collect))
        .route("/api/cloud/jobs/{id}/import", post(import))
        .route("/api/cloud/jobs/{id}/stop", post(stop))
        .route("/api/cloud/jobs/{id}/resume", post(resume))
}
async fn root(state: &AppState, workspace_id: &str) -> Result<std::path::PathBuf, DaemonError> {
    state
        .workspace_path(workspace_id)
        .await
        .map(Into::into)
        .ok_or_else(|| DaemonError::NotFound("Local workspace not found".into()))
}
async fn settings(State(s): State<AppState>) -> Result<Json<CloudSettings>, DaemonError> {
    Ok(Json(s.cloud_manager().settings().await?))
}
async fn update_settings(
    State(s): State<AppState>,
    Json(r): Json<UpdateCloudSettingsRequest>,
) -> Result<Json<CloudSettings>, DaemonError> {
    Ok(Json(s.cloud_manager().update_settings(r).await?))
}
async fn capture(
    State(s): State<AppState>,
    Json(r): Json<CaptureCloudSourceRequest>,
) -> Result<Json<CloudSourcePreview>, DaemonError> {
    let path = root(&s, &r.workspace_id).await?;
    Ok(Json(s.cloud_manager().capture(r.workspace_id, path).await?))
}
async fn create(
    State(s): State<AppState>,
    Json(r): Json<CreateCloudJobRequest>,
) -> Result<Json<CloudJob>, DaemonError> {
    let path = root(&s, &r.workspace_id).await?;
    Ok(Json(s.cloud_manager().create(r, path).await?))
}
async fn list(State(s): State<AppState>) -> Result<Json<Vec<CloudJob>>, DaemonError> {
    Ok(Json(s.cloud_manager().list().await?))
}
async fn job(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CloudJob>, DaemonError> {
    Ok(Json(s.cloud_manager().get(&id).await?))
}
async fn detail(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CloudJobDetail>, DaemonError> {
    Ok(Json(s.cloud_manager().detail_with_requests(&id).await?))
}
async fn turn(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(r): Json<SendTurnRequest>,
) -> Result<Json<CommandResponse>, DaemonError> {
    Ok(Json(s.cloud_manager().send_turn(&id, r).await?))
}
async fn interrupt(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CommandResponse>, DaemonError> {
    Ok(Json(s.cloud_manager().interrupt(&id).await?))
}
async fn approval(
    State(s): State<AppState>,
    Path((id, rid)): Path<(String, String)>,
    Json(r): Json<ApprovalResponseRequest>,
) -> Result<Json<CommandResponse>, DaemonError> {
    Ok(Json(
        s.cloud_manager()
            .respond(&id, &rid, true, serde_json::to_value(r)?)
            .await?,
    ))
}
async fn interactive(
    State(s): State<AppState>,
    Path((id, rid)): Path<(String, String)>,
    Json(r): Json<InteractiveResponseRequest>,
) -> Result<Json<CommandResponse>, DaemonError> {
    Ok(Json(
        s.cloud_manager()
            .respond(&id, &rid, false, serde_json::to_value(r)?)
            .await?,
    ))
}
async fn collect(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CloudJob>, DaemonError> {
    Ok(Json(s.cloud_manager().collect(&id).await?))
}
async fn import(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CloudJob>, DaemonError> {
    Ok(Json(s.cloud_manager().import(&id).await?))
}
async fn stop(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CloudJob>, DaemonError> {
    Ok(Json(s.cloud_manager().stop(&id).await?))
}

async fn resume(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CloudJob>, DaemonError> {
    Ok(Json(s.cloud_manager().resume(&id).await?))
}
