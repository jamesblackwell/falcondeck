#![cfg(unix)]

use std::{collections::HashMap, os::unix::fs::PermissionsExt, path::Path};

use falcondeck_core::{AgentProvider, DaemonRestorePhase, ThreadStatus};
use falcondeck_daemon::AppState;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::{Duration, sleep, timeout};

async fn restored_app(preferences: Option<Value>) -> (TempDir, AppState) {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let provider = temp.path().join("fake-codex");
    let script = r#"#!/usr/bin/env python3
import json, pathlib, sys
root = pathlib.Path(__ROOT__)
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    with (root / 'requests.jsonl').open('a') as log:
        log.write(json.dumps(request) + '\n')
    method = request['method']
    params = request.get('params', {})
    result = {}
    if method == 'account/read':
        result = {'account': {'type': 'chatgpt', 'email': 'test@example.com'}}
    elif method == 'model/list':
        result = {'data': [{'id': 'saved-model', 'isDefault': True}]}
    elif method in ('thread/list', 'skills/list', 'collaborationMode/list', 'thread/turns/list'):
        result = {'data': []}
    elif method == 'thread/resume':
        if params['threadId'] == 'failed-session':
            print(json.dumps({'id': request['id'], 'error': {'code': -32000, 'message': 'saved session unavailable'}}), flush=True)
            continue
        result = {'thread': {'id': params['threadId'], 'turns': []}}
    elif method == 'turn/start':
        result = {'turn': {'id': 'resumed-turn'}}
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
"#
    .replace("__ROOT__", &serde_json::to_string(&temp.path()).unwrap());
    std::fs::write(&provider, script).unwrap();
    std::fs::set_permissions(&provider, std::fs::Permissions::from_mode(0o755)).unwrap();
    let state_path = temp.path().join("daemon-state.json");
    let thread = |id: &str, status: &str| {
        json!({
            "thread_id": id,
            "title": id,
            "provider": "codex",
            "status": status,
            "agent": {
                "model_id": "saved-model",
                "reasoning_effort": "high",
                "approval_policy": "on-request",
                "service_tier": "fast",
                "sandbox_mode": "read-only"
            }
        })
    };
    std::fs::write(
        &state_path,
        serde_json::to_vec(&json!({
            "workspaces": [{
                "id": "workspace-1", "path": project,
                "default_provider": "codex",
                "archived_thread_ids": ["archived-session"],
                "thread_states": [
                    thread("failed-session", "running"),
                    thread("active-session", "waiting_for_input"),
                    thread("archived-session", "running"),
                    thread("completed-session", "idle"),
                    thread("stopped-session", "idle")
                ]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    if let Some(preferences) = preferences {
        std::fs::write(
            temp.path().join("falcondeck.json"),
            serde_json::to_vec(&preferences).unwrap(),
        )
        .unwrap();
    }
    let app = AppState::new_with_state_path(
        "test".into(),
        HashMap::from([
            (
                AgentProvider::CODEX,
                provider.to_string_lossy().into_owned(),
            ),
            (AgentProvider::CLAUDE, "/usr/bin/false".into()),
            (AgentProvider::AGY, "/usr/bin/false".into()),
        ]),
        state_path,
    );
    app.restore_local_state().await.unwrap();
    (temp, app)
}

fn requests(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("requests.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn startup_resumes_only_shutdown_sessions_without_a_ui_and_survives_one_failure() {
    let (temp, app) = restored_app(None).await;
    timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = app.snapshot().await;
            if snapshot.restore_phase == DaemonRestorePhase::Ready
                && requests(temp.path())
                    .iter()
                    .any(|request| request["method"] == "turn/start")
            {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("automatic recovery should dispatch without a UI client");

    let requests = requests(temp.path());
    let resumes: Vec<_> = requests
        .iter()
        .filter(|request| request["method"] == "thread/resume")
        .collect();
    assert_eq!(resumes.len(), 2);
    assert_eq!(resumes[0]["params"]["threadId"], "failed-session");
    assert_eq!(resumes[1]["params"]["threadId"], "active-session");
    assert!(
        !requests
            .iter()
            .any(|request| request["method"] == "thread/start")
    );
    let turns: Vec<_> = requests
        .iter()
        .filter(|request| request["method"] == "turn/start")
        .collect();
    assert_eq!(turns.len(), 1);
    let params = &turns[0]["params"];
    assert_eq!(params["threadId"], "active-session");
    assert_eq!(params["model"], "saved-model");
    assert_eq!(params["effort"], "high");
    assert_eq!(params["approvalPolicy"], "on-request");
    assert_eq!(params["serviceTier"], "fast");
    assert_eq!(params["sandboxPolicy"]["type"], "readOnly");

    let snapshot = app.snapshot().await;
    let failed = snapshot
        .threads
        .iter()
        .find(|thread| thread.id == "failed-session")
        .unwrap();
    assert_eq!(failed.status, ThreadStatus::Error);
    assert_eq!(
        failed.last_error.as_deref(),
        Some("FalconDeck was closed while this turn was running")
    );
    let detail = app
        .thread_detail("workspace-1", "active-session")
        .await
        .unwrap();
    assert!(
        !detail
            .items
            .iter()
            .any(|item| matches!(item, falcondeck_core::ConversationItem::UserMessage { .. }))
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn startup_keeps_old_installs_and_explicit_opt_out_on_manual_recovery() {
    for preferences in [
        json!({"version": 1}),
        json!({"auto_resume_interrupted_sessions": false}),
    ] {
        let (temp, app) = restored_app(Some(preferences)).await;
        timeout(Duration::from_secs(10), async {
            while app.snapshot().await.restore_phase != DaemonRestorePhase::Ready {
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(!app.preferences().await.auto_resume_interrupted_sessions);
        assert!(!requests(temp.path()).iter().any(
            |request| request["method"] == "turn/start" || request["method"] == "thread/resume"
        ));
        app.shutdown().await.unwrap();
    }
}
