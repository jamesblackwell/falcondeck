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
        background_restore: false,
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
    let registration = client
        .post(format!("{base_url}/api/workspaces/connect"))
        .json(&json!({ "path": workspace }))
        .send()
        .await
        .unwrap();
    assert!(
        registration.status().is_success(),
        "workspace registration failed: {}",
        registration.text().await.unwrap_or_default()
    );

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

#[tokio::test]
async fn queue_one_holds_the_occurrence_until_the_active_run_finishes() {
    // A bare AppState (no spawned scheduler loop) keeps the run states
    // deterministic while the dispatch gate is exercised directly.
    let dir = tempfile::tempdir().unwrap();
    let app = falcondeck_daemon::AppState::new_with_state_path(
        "test".to_string(),
        [
            (
                falcondeck_core::AgentProvider::CODEX,
                "/nonexistent/codex".to_string(),
            ),
            (
                falcondeck_core::AgentProvider::CLAUDE,
                "/nonexistent/claude".to_string(),
            ),
        ]
        .into_iter()
        .collect(),
        dir.path().join("daemon-state.json"),
    );
    app.restore_control_state().await.unwrap();
    let context = falcondeck_core::control::ControlRequestContext::default();
    let deps = falcondeck_daemon::control::ControlDeps::none();

    let create = falcondeck_core::control::ControlExecuteRequest {
        operation: "automation.create".to_string(),
        arguments: serde_json::from_value(json!({
            "name": "Queue probe",
            "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
            "task": { "kind": "prompt", "instruction": "Probe." },
            "target": {
                "workspace_path": "/tmp",
                "provider": "codex",
                "thread": { "kind": "managed" },
            },
            "concurrency_policy": "queue_one",
        }))
        .unwrap(),
        expected_revision: None,
        idempotency_key: None,
    };
    let (created, _) = app.control().execute(create, &context, &deps).await;
    assert!(created.ok, "{:?}", created.error);
    let id = created.data.unwrap()["id"].as_str().unwrap().to_string();

    let manual = || falcondeck_daemon::control::RunSource::Manual {
        origin: falcondeck_core::control::ControlOrigin::DesktopUi,
    };
    let first = app
        .control()
        .enqueue_run(&id, None, manual())
        .await
        .unwrap();
    app.control()
        .mark_run_running(&first.id, "workspace-probe", "thread-probe")
        .await
        .unwrap();

    // The second occurrence is queued by policy, and the dispatch gate holds
    // it while the first is running.
    let queued = app
        .control()
        .enqueue_run(&id, None, manual())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&queued).unwrap()["status"],
        json!("queued")
    );
    let dispatched =
        falcondeck_daemon::control::scheduler::try_execute_queued(&app, &queued.id).await;
    assert!(!dispatched, "queue_one holds the occurrence");
    let still_queued = app.control().run(&queued.id).await.unwrap();
    assert_eq!(
        still_queued.status,
        falcondeck_core::control::AutomationRunStatus::Queued
    );

    // Finishing the active run releases the occurrence.
    app.control()
        .finish_run(
            &first.id,
            falcondeck_core::control::AutomationRunStatus::Succeeded,
            Some("done".into()),
            None,
        )
        .await
        .unwrap();
    let released =
        falcondeck_daemon::control::scheduler::try_execute_queued(&app, &queued.id).await;
    assert!(released, "the occurrence dispatches once free");
    for _ in 0..50 {
        let run = app.control().run(&queued.id).await.unwrap();
        if run.status.is_terminal() {
            assert_ne!(
                run.status,
                falcondeck_core::control::AutomationRunStatus::Queued
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("queued occurrence never reached a terminal state");
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
async fn allow_policy_overlaps_occurrences() {
    // A bare AppState keeps run states deterministic while the claim gate
    // is exercised directly.
    let dir = tempfile::tempdir().unwrap();
    let app = falcondeck_daemon::AppState::new_with_state_path(
        "test".to_string(),
        Default::default(),
        dir.path().join("daemon-state.json"),
    );
    app.restore_control_state().await.unwrap();
    let context = falcondeck_core::control::ControlRequestContext::default();
    let deps = falcondeck_daemon::control::ControlDeps::none();

    let create = falcondeck_core::control::ControlExecuteRequest {
        operation: "automation.create".to_string(),
        arguments: serde_json::from_value(json!({
            "name": "Allow probe",
            "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
            "task": { "kind": "prompt", "instruction": "Probe." },
            "target": {
                "workspace_path": "/tmp",
                "provider": "codex",
                "thread": { "kind": "managed" },
            },
            "concurrency_policy": "allow",
        }))
        .unwrap(),
        expected_revision: None,
        idempotency_key: None,
    };
    let (created, _) = app.control().execute(create, &context, &deps).await;
    assert!(created.ok, "{:?}", created.error);
    let id = created.data.unwrap()["id"].as_str().unwrap().to_string();

    let manual = || falcondeck_daemon::control::RunSource::Manual {
        origin: falcondeck_core::control::ControlOrigin::DesktopUi,
    };
    let first = app
        .control()
        .enqueue_run(&id, None, manual())
        .await
        .unwrap();
    app.control().claim_run_if_automation_free(&first.id).await;

    // An allow-policy occurrence is claimed even while the first runs.
    let second = app
        .control()
        .enqueue_run(&id, None, manual())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&second).unwrap()["status"],
        json!("queued")
    );
    let claimed = app.control().claim_run_if_automation_free(&second.id).await;
    assert!(claimed, "allow overlaps occurrences");
    let second_run = app.control().run(&second.id).await.unwrap();
    assert_eq!(
        second_run.status,
        falcondeck_core::control::AutomationRunStatus::Running
    );

    // A skip-policy sibling still holds, proving the policy distinction.
    let skip_create = falcondeck_core::control::ControlExecuteRequest {
        operation: "automation.create".to_string(),
        arguments: serde_json::from_value(json!({
            "name": "Skip probe",
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
    let (skip_created, _) = app.control().execute(skip_create, &context, &deps).await;
    assert!(skip_created.ok);
    let skip_id = skip_created.data.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let skip_first = app
        .control()
        .enqueue_run(&skip_id, None, manual())
        .await
        .unwrap();
    app.control()
        .claim_run_if_automation_free(&skip_first.id)
        .await;
    let skip_second = app
        .control()
        .enqueue_run(&skip_id, None, manual())
        .await
        .unwrap();
    // Default skip policy already recorded skipped_overlap.
    assert_eq!(
        serde_json::to_value(&skip_second).unwrap()["status"],
        json!("skipped_overlap")
    );
}

#[tokio::test]
async fn scheduler_does_not_dispatch_paused_automations() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace = dir.path().join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let workspace = workspace.display().to_string();
    let base = daemon.base_url();

    let automation = create_automation(&client, &base, &workspace, due_in(2)).await;
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

    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
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

#[cfg(unix)]
async fn precheck_fixture() -> (
    falcondeck_daemon::EmbeddedDaemonHandle,
    tempfile::TempDir,
    String,
) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("repo");
    std::fs::create_dir(&workspace).unwrap();
    let bin = dir.path().join("codex-fixture");
    let script = r#"#!/usr/bin/env python3
import json, pathlib, subprocess, sys
root = pathlib.Path(__ROOT__)
if 'app-server' not in sys.argv:
    print('codex-cli 0.200.0'); sys.exit(0)
for line in sys.stdin:
    req = json.loads(line)
    if 'id' not in req: continue
    method = req['method']
    with (root / 'rpc.jsonl').open('a') as log:
        log.write(json.dumps(req) + '\n')
    result = {}
    if method == 'model/list': result = {'data': [{'id':'test-model', 'isDefault':True}]}
    elif method in ('thread/list', 'skills/list', 'collaborationMode/list'): result = {'data':[]}
    elif method == 'thread/start': result = {'thread': {'id':'precheck-thread', 'name':'Gate'}}
    elif method == 'command/exec':
        p = req['params']
        try:
            done = subprocess.run(p['command'], cwd=p['cwd'], capture_output=True, timeout=p['timeoutMs']/1000)
            result = {'exitCode': done.returncode, 'stdout': done.stdout[:p['outputBytesCap']].decode('utf8', errors='replace'), 'stderr': done.stderr[:p['outputBytesCap']].decode('utf8', errors='replace')}
        except subprocess.TimeoutExpired:
            result = {'exitCode':124,'stdout':'','stderr':'deadline'}
    if method == 'turn/start':
        print(json.dumps({'id':req['id'], 'error':{'code':-32000, 'message':'intentional fixture turn failure'}}), flush=True)
    else:
        print(json.dumps({'id':req['id'], 'result':result}), flush=True)
"#.replace("__ROOT__", &serde_json::to_string(&dir.path().to_string_lossy()).unwrap());
    std::fs::write(&bin, script).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut config = config_with_state_path(dir.path().join("daemon-state.json"));
    config
        .provider_bins
        .insert("codex".into(), bin.to_string_lossy().into_owned());
    let mut daemon = spawn_embedded(config).await.unwrap();
    daemon.wait_until_restored().await.unwrap();
    (daemon, dir, workspace.to_string_lossy().into_owned())
}

#[cfg(unix)]
async fn run_gate(client: &Client, base: &str, id: &str, count: usize) -> Vec<Value> {
    let response: Value = client
        .post(format!("{base}/api/control/execute"))
        .json(&json!({"operation":"automation.run_now", "arguments":{"automation_id":id}}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let runs = wait_for_runs(client, base, id, count).await;
    assert_eq!(runs.len(), count);
    assert!(
        runs.iter()
            .all(|run| !matches!(run["status"].as_str(), Some("running" | "queued")))
    );
    runs
}

#[cfg(unix)]
#[tokio::test]
async fn precheck_noop_fire_failure_and_health_use_no_inference_until_needed() {
    let (daemon, dir, workspace) = precheck_fixture().await;
    let client = Client::new();
    let base = daemon.base_url();
    // This command executes an argv vector. Shell punctuation is literal data.
    let code = "import pathlib,sys; print('literal ; $(echo injected)'); sys.exit(int(pathlib.Path('code').read_text()))";
    std::fs::write(std::path::Path::new(&workspace).join("code"), "0").unwrap();
    let automation = create_automation(&client, &base, &workspace, json!({
        "target": {"workspace_path":workspace,"provider":"codex","thread":{"kind":"new_each_run"},"sandbox_mode":"read-only"},
        "precheck":{"argv":["/usr/bin/python3","-c",code],"cwd":workspace,"timeout_seconds":5}
    })).await;
    let id = automation["id"].as_str().unwrap();
    let runs = run_gate(&client, &base, id, 1).await;
    assert_eq!(runs[0]["status"], "skipped_unchanged");
    assert!(runs[0]["thread_id"].is_null());
    assert!(runs[0]["input_tokens"].is_null());
    let log = std::fs::read_to_string(dir.path().join("rpc.jsonl")).unwrap();
    assert!(!log.contains("thread/start"));
    assert!(!log.contains("turn/start"));
    let request: Value = log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|request| request["method"] == "command/exec")
        .unwrap();
    assert_eq!(request["params"]["sandboxPolicy"]["type"], "readOnly");
    assert_eq!(request["params"]["outputBytesCap"], 8192);
    assert!(
        request["params"].get("env").is_none(),
        "no additional secrets or overrides"
    );

    std::fs::write(std::path::Path::new(&workspace).join("code"), "3").unwrap();
    run_gate(&client, &base, id, 2).await;
    let log = std::fs::read_to_string(dir.path().join("rpc.jsonl")).unwrap();
    let turn: Value = log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|request| request["method"] == "turn/start")
        .expect("fire code dispatches");
    let text = turn.to_string();
    assert!(text.contains("untrusted data"));
    assert!(text.contains("literal ; $(echo injected)"));

    std::fs::write(std::path::Path::new(&workspace).join("code"), "2").unwrap();
    run_gate(&client, &base, id, 3).await;
    let turns_before = std::fs::read_to_string(dir.path().join("rpc.jsonl"))
        .unwrap()
        .matches("turn/start")
        .count();
    let runs = run_gate(&client, &base, id, 4).await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("rpc.jsonl"))
            .unwrap()
            .matches("turn/start")
            .count(),
        turns_before
    );
    assert_eq!(
        runs.iter()
            .filter(|r| r["precheck"]["failure_dispatched"] == true)
            .count(),
        1
    );
    assert!(
        runs.iter()
            .filter(|r| r["precheck"]["exit_code"] == 2)
            .all(|r| r["precheck"]["error"].is_string())
    );
    let health: Value = client
        .post(format!("{base}/api/control/get"))
        .json(&json!({"resource":"automation.health"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let row = health["data"]["automations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == id)
        .unwrap();
    assert_eq!(row["precheck"]["fire_codes"], json!([3]));
    assert_eq!(row["last_precheck"]["exit_code"], 2);
    daemon.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn precheck_timeout_is_a_recorded_rate_limited_failure() {
    let (daemon, _dir, workspace) = precheck_fixture().await;
    let client = Client::new();
    let base = daemon.base_url();
    let automation = create_automation(&client, &base, &workspace, json!({
        "target":{"workspace_path":workspace,"provider":"codex","thread":{"kind":"new_each_run"},"sandbox_mode":"read-only"},
        "precheck":{"argv":["/usr/bin/python3","-c","import time; time.sleep(20)"],"cwd":workspace,"timeout_seconds":1}
    })).await;
    let id = automation["id"].as_str().unwrap();
    run_gate(&client, &base, id, 1).await;
    let runs = run_gate(&client, &base, id, 2).await;
    assert!(runs.iter().all(|r| {
        r["precheck"]["error"]
            .as_str()
            .unwrap()
            .contains("timed out")
    }));
    assert_eq!(
        runs.iter()
            .filter(|r| r["precheck"]["failure_dispatched"] == true)
            .count(),
        1
    );
    assert!(runs.iter().any(|r| r["thread_id"].is_null()));
    daemon.shutdown().await.unwrap();
}
