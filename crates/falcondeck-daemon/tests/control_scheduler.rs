//! Scheduler integration tests. Providers point at a nonexistent binary so
//! dispatch is exercised deterministically: runs appear, transition and fail
//! without needing a live Codex or Claude installation.

use std::path::PathBuf;

use falcondeck_core::control::ControlExecuteResponse;
use falcondeck_daemon::{DaemonConfig, spawn_embedded};
use reqwest::Client;
use serde_json::{Value, json};

fn config_with_state_path(path: PathBuf) -> DaemonConfig {
    DaemonConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        state_path: Some(path),
        // A missing provider binary makes thread creation fail fast, which
        // exercises the failure paths without a live provider.
        provider_bins: [
            ("codex".to_string(), "/nonexistent/codex".to_string()),
            ("claude".to_string(), "/nonexistent/claude".to_string()),
        ]
        .into_iter()
        .collect(),
        ..DaemonConfig::default()
    }
}

async fn spawn() -> (falcondeck_daemon::EmbeddedDaemonHandle, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let config = config_with_state_path(dir.path().join("daemon-state.json"));
    let mut daemon = spawn_embedded(config).await.unwrap();
    daemon.wait_until_restored().await.unwrap();
    (daemon, dir)
}

async fn create_automation(
    client: &Client,
    base_url: &str,
    workspace: &str,
    extra: Value,
) -> Value {
    let mut arguments = json!({
        "name": "Scheduler probe",
        "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
        "task": { "kind": "prompt", "instruction": "Probe." },
        "target": {
            "workspace_path": workspace,
            "provider": "codex",
            "thread": { "kind": "managed" },
        },
    });
    if let Some(map) = extra.as_object() {
        for (key, value) in map {
            arguments[key] = value.clone();
        }
    }
    let response: ControlExecuteResponse = client
        .post(format!("{base_url}/api/control/execute"))
        .json(&json!({ "operation": "automation.create", "arguments": arguments }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(response.ok, "{:?}", response.error);
    response.data.unwrap()
}

async fn runs_for(client: &Client, base_url: &str, automation_id: &str) -> Vec<Value> {
    let response: Value = client
        .post(format!("{base_url}/api/control/get"))
        .json(&json!({ "resource": "automation.runs", "id": automation_id, "limit": 100 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    response["data"].as_array().unwrap().clone()
}

async fn wait_for_runs(
    client: &Client,
    base_url: &str,
    automation_id: &str,
    minimum: usize,
) -> Vec<Value> {
    for _ in 0..100 {
        let runs = runs_for(client, base_url, automation_id).await;
        if runs.len() >= minimum
            && runs
                .iter()
                .all(|run| !matches!(run["status"].as_str().unwrap_or(""), "queued" | "running"))
        {
            return runs;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    runs_for(client, base_url, automation_id).await
}

/// An interval anchored so the next occurrence is `seconds` away.
fn due_in(seconds: i64) -> Value {
    let anchor = chrono::Utc::now() - chrono::Duration::seconds(3600 - seconds);
    json!({
        "trigger": {
            "kind": "interval",
            "every_seconds": 3600,
            "anchor_at": anchor.to_rfc3339(),
        }
    })
}

#[tokio::test]
async fn due_automation_dispatches_exactly_once() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace = dir.path().join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let workspace = workspace.display().to_string();

    let automation = create_automation(&client, &daemon.base_url(), &workspace, due_in(1)).await;
    let id = automation["id"].as_str().unwrap().to_string();

    let runs = wait_for_runs(&client, &daemon.base_url(), &id, 1).await;
    assert_eq!(runs.len(), 1, "the due occurrence dispatches exactly once");
    assert_eq!(
        runs[0]["status"],
        json!("failed"),
        "missing provider binary fails the run"
    );
    assert!(
        runs[0]["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("workspace")
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn scheduler_does_not_dispatch_paused_automations() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace = dir.path().join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let workspace = workspace.display().to_string();
    let base = daemon.base_url();

    let automation = create_automation(&client, &base, &workspace, due_in(1)).await;
    let id = automation["id"].as_str().unwrap().to_string();

    // Pause before the occurrence is due.
    let paused: ControlExecuteResponse = client
        .post(format!("{base}/api/control/execute"))
        .json(&json!({
            "operation": "automation.pause",
            "expected_revision": automation["revision"],
            "arguments": { "automation_id": id },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(paused.ok, "{:?}", paused.error);

    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let runs = runs_for(&client, &base, &id).await;
    assert!(
        runs.is_empty(),
        "paused automations never dispatch: {runs:?}"
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_required_connector_skips_the_run() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace_dir = dir.path().join("repo");
    std::fs::create_dir_all(workspace_dir.join(".falcondeck")).unwrap();
    // The connector exists at creation time...
    std::fs::write(
        workspace_dir.join(".falcondeck").join("connectors.json"),
        r#"{"mcpServers":{"gmail":{"command":"/nonexistent/mcp-gmail"}}}"#,
    )
    .unwrap();
    let workspace = workspace_dir.display().to_string();
    let base = daemon.base_url();

    let automation = create_automation(
        &client,
        &base,
        &workspace,
        json!({ "required_connectors": ["gmail"] }),
    )
    .await;
    let id = automation["id"].as_str().unwrap().to_string();

    // ...and disappears before execution.
    std::fs::remove_file(workspace_dir.join(".falcondeck").join("connectors.json")).unwrap();

    let ran: ControlExecuteResponse = client
        .post(format!("{base}/api/control/execute"))
        .json(&json!({ "operation": "automation.run_now", "arguments": { "automation_id": id } }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(ran.ok, "{:?}", ran.error);

    let runs = wait_for_runs(&client, &base, &id, 1).await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["status"], json!("skipped_dependency"));
    assert!(
        runs[0]["outcome_preview"]
            .as_str()
            .unwrap_or_default()
            .contains("gmail")
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn manual_run_now_dispatches_through_the_scheduler() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace = dir.path().join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let workspace = workspace.display().to_string();
    let base = daemon.base_url();

    // Far-future schedule so only the manual run happens.
    let automation = create_automation(&client, &base, &workspace, due_in(3000)).await;
    let id = automation["id"].as_str().unwrap().to_string();

    let ran: ControlExecuteResponse = client
        .post(format!("{base}/api/control/execute"))
        .json(&json!({ "operation": "automation.run_now", "arguments": { "automation_id": id } }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(ran.ok, "{:?}", ran.error);

    let runs = wait_for_runs(&client, &base, &id, 1).await;
    assert_eq!(runs.len(), 1, "manual runs never consume the schedule");
    assert_eq!(runs[0]["status"], json!("failed"));

    // The scheduled occurrence is still pending, not advanced by the manual
    // dispatch.
    let detail: Value = client
        .post(format!("{base}/api/control/get"))
        .json(&json!({ "resource": "automation", "id": id }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(detail["data"]["next_run_at"].is_string());

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn once_automation_completes_after_its_run() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace = dir.path().join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let workspace = workspace.display().to_string();
    let base = daemon.base_url();

    let run_at = (chrono::Utc::now() + chrono::Duration::seconds(1)).to_rfc3339();
    let automation = create_automation(
        &client,
        &base,
        &workspace,
        json!({ "trigger": { "kind": "once", "run_at": run_at } }),
    )
    .await;
    let id = automation["id"].as_str().unwrap().to_string();

    let runs = wait_for_runs(&client, &base, &id, 1).await;
    assert_eq!(runs.len(), 1);

    let detail: Value = client
        .post(format!("{base}/api/control/get"))
        .json(&json!({ "resource": "automation", "id": id }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail["data"]["state"], json!("completed"));
    assert!(detail["data"]["next_run_at"].is_null());

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn overlap_policy_records_one_skip_while_running() {
    // A standalone service (no scheduler loop) so the running occurrence
    // stays put deterministically while the second one is evaluated.
    let dir = tempfile::tempdir().unwrap();
    let service =
        falcondeck_daemon::control::ControlService::new(dir.path().join("agent-control.json"));
    service.restore().await.unwrap();
    let context = falcondeck_core::control::ControlRequestContext::default();
    let deps = falcondeck_daemon::control::ControlDeps::none();

    let create = falcondeck_core::control::ControlExecuteRequest {
        operation: "automation.create".to_string(),
        arguments: serde_json::from_value(json!({
            "name": "Overlap probe",
            "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
            "task": { "kind": "prompt", "instruction": "Probe." },
            "target": {
                "workspace_path": "/tmp",
                "provider": "codex",
                "thread": { "kind": "managed" },
            },
        }))
        .unwrap(),
        expected_revision: None,
        idempotency_key: None,
    };
    let (created, _) = service.execute(create, &context, &deps).await;
    assert!(created.ok, "{:?}", created.error);
    let id = created.data.unwrap()["id"].as_str().unwrap().to_string();

    let first = service
        .enqueue_run(
            &id,
            None,
            falcondeck_daemon::control::RunSource::Manual {
                origin: falcondeck_core::control::ControlOrigin::DesktopUi,
            },
        )
        .await
        .unwrap();
    service
        .mark_run_running(&first.id, "workspace-probe", "thread-probe")
        .await
        .unwrap();

    let second = service
        .enqueue_run(
            &id,
            None,
            falcondeck_daemon::control::RunSource::Manual {
                origin: falcondeck_core::control::ControlOrigin::DesktopUi,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&second).unwrap()["status"],
        json!("skipped_overlap")
    );
}
