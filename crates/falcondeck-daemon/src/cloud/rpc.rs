use crate::app::AppState;
use falcondeck_core::{
    CaptureCloudSourceRequest, CreateCloudJobRequest, SendTurnRequest, UpdateCloudSettingsRequest,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

pub(crate) async fn dispatch(app: &AppState, method: &str, params: Value) -> Result<Value, String> {
    let manager = app.cloud_manager();
    let value = match method {
        "cloud.settings.get" => serde_json::to_value(manager.settings().await.map_err(error)?),
        "cloud.settings.update" => serde_json::to_value(
            manager
                .update_settings(decode::<UpdateCloudSettingsRequest>(params)?)
                .await
                .map_err(error)?,
        ),
        "cloud.capture" => {
            let r = decode::<CaptureCloudSourceRequest>(params)?;
            let root = workspace(app, &r.workspace_id).await?;
            serde_json::to_value(manager.capture(r.workspace_id, root).await.map_err(error)?)
        }
        "cloud.jobs.list" => serde_json::to_value(manager.list().await.map_err(error)?),
        "cloud.jobs.create" => {
            let r = decode::<CreateCloudJobRequest>(params)?;
            let root = workspace(app, &r.workspace_id).await?;
            serde_json::to_value(manager.create(r, root).await.map_err(error)?)
        }
        "cloud.jobs.get" => serde_json::to_value(manager.get(id(&params)?).await.map_err(error)?),
        "cloud.jobs.detail" => serde_json::to_value(
            manager
                .detail_with_requests(id(&params)?)
                .await
                .map_err(error)?,
        ),
        "cloud.jobs.turn" => {
            let job_id = id(&params)?.to_string();
            let r = decode::<SendTurnRequest>(params.get("request").cloned().unwrap_or(params))?;
            serde_json::to_value(manager.send_turn(&job_id, r).await.map_err(error)?)
        }
        "cloud.jobs.interrupt" => {
            serde_json::to_value(manager.interrupt(id(&params)?).await.map_err(error)?)
        }
        "cloud.jobs.approval" | "cloud.jobs.interactive" => {
            let job_id = id(&params)?;
            let request_id = params
                .get("request_id")
                .and_then(Value::as_str)
                .ok_or("Missing native request identifier")?;
            let body = params
                .get("request")
                .cloned()
                .unwrap_or_else(|| params.clone());
            serde_json::to_value(
                manager
                    .respond(job_id, request_id, method == "cloud.jobs.approval", body)
                    .await
                    .map_err(error)?,
            )
        }
        "cloud.jobs.collect" => {
            serde_json::to_value(manager.collect(id(&params)?).await.map_err(error)?)
        }
        "cloud.jobs.import" => {
            serde_json::to_value(manager.import(id(&params)?).await.map_err(error)?)
        }
        "cloud.jobs.resume" => {
            serde_json::to_value(manager.resume(id(&params)?).await.map_err(error)?)
        }
        "cloud.jobs.stop" => serde_json::to_value(manager.stop(id(&params)?).await.map_err(error)?),
        _ => return Err("Unsupported cloud method".into()),
    };
    value.map_err(|_| "Cloud response could not be encoded".into())
}
fn error(e: crate::error::DaemonError) -> String {
    e.to_string()
}
fn decode<T: DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|_| "Invalid cloud request".into())
}
fn id(v: &Value) -> Result<&str, String> {
    v.get("job_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing cloud job identifier".into())
}
async fn workspace(app: &AppState, id: &str) -> Result<std::path::PathBuf, String> {
    app.workspace_path(id)
        .await
        .map(Into::into)
        .ok_or_else(|| "Local workspace not found on this coordinator".into())
}
