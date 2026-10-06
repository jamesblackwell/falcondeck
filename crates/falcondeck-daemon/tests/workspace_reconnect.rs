#![cfg(unix)]

use falcondeck_core::{AgentProvider, WorkspaceStatus};
use falcondeck_daemon::AppState;
use serde_json::json;
use std::{collections::HashMap, os::unix::fs::PermissionsExt, path::Path};
use tokio::time::{Duration, Instant, sleep, timeout};

fn executable(path: &Path, script: &str) {
    std::fs::write(path, script).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

async fn fixture(barrier: bool) -> (tempfile::TempDir, AppState) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let codex = root.join("codex");
    let claude = root.join("claude");
    let script = r#"#!/usr/bin/env python3
import json, os, pathlib, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
root = pathlib.Path(__ROOT__)
barrier = __BARRIER__
lock = threading.Lock()

def respond(request):
    method = request['method']
    params = request.get('params', {})
    result = {}
    if method in ('account/read', 'model/list', 'collaborationMode/list'):
        time.sleep(0.1)
    if method == 'account/read':
        result = {'account': {'type': 'chatgpt'}}
    elif method == 'model/list':
        result = {'data': [{'id': 'test-model', 'isDefault': True}]}
    elif method == 'thread/list':
        if params.get('sourceKinds') == ['subAgent']:
            time.sleep(0.4)
        else:
            with (root / ('started-' + pathlib.Path.cwd().name)).open('w') as log:
                log.write('started')
            if barrier:
                while not (root / 'release').exists(): time.sleep(0.01)
            else:
                time.sleep(0.25)
        result = {'data': []}
    elif method == 'skills/list':
        time.sleep(0.1)
        result = {'data': []}
    with lock:
        print(json.dumps({'id': request['id'], 'result': result}), flush=True)

with ThreadPoolExecutor(max_workers=8) as executor:
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' in request: executor.submit(respond, request)
"#;
    executable(
        &codex,
        &script
            .replace("__ROOT__", &serde_json::to_string(&root).unwrap())
            .replace("__BARRIER__", if barrier { "True" } else { "False" }),
    );
    executable(
        &claude,
        "#!/bin/sh\nsleep 0.12\necho '{\"authenticated\":true}'\n",
    );
    let mut workspaces = Vec::new();
    for index in 0..8 {
        let project = root.join(format!("project-{index}"));
        std::fs::create_dir(&project).unwrap();
        workspaces.push(json!({
            "path": project, "id": format!("workspace-{index}"), "in_sidebar": true,
            "thread_states": [{"thread_id": format!("session-{index}"), "provider": "codex", "native_session_id": format!("session-{index}"), "title": "Saved session", "status": if index == 7 {"running"} else {"idle"}}]
        }));
    }
    let state = root.join("state.json");
    std::fs::write(
        &state,
        serde_json::to_vec(&json!({"workspaces": workspaces, "remote": null})).unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join("falcondeck.json"),
        serde_json::to_vec(&json!({"version": 1, "auto_resume_interrupted_sessions": false}))
            .unwrap(),
    )
    .unwrap();
    let app = AppState::new_with_state_path(
        "test".into(),
        HashMap::from([
            (AgentProvider::CODEX, codex.to_string_lossy().into()),
            (AgentProvider::CLAUDE, claude.to_string_lossy().into()),
            (
                AgentProvider::AGY,
                root.join("missing-agy").to_string_lossy().into(),
            ),
        ]),
        state,
    );
    (temp, app)
}

fn started(root: &Path) -> Vec<String> {
    std::fs::read_dir(root)
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            name.strip_prefix("started-").map(str::to_owned)
        })
        .collect()
}

async fn ready(app: &AppState) {
    timeout(Duration::from_secs(15), async {
        while !app.snapshot().await.workspaces.iter().all(|workspace| workspace.status == WorkspaceStatus::Ready) {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let snapshot = app.snapshot().await;
    assert_eq!(snapshot.workspaces.len(), 8);
    assert!(
        snapshot
            .workspaces
            .iter()
            .all(|workspace| workspace.status == WorkspaceStatus::Ready)
    );
    assert_eq!(snapshot.threads.len(), 8);
}

#[tokio::test]
async fn restore_overlaps_four_projects_prioritizes_interrupted_and_preserves_all_sessions() {
    let (temp, app) = fixture(true).await;
    app.restore_local_state().await.unwrap();
    timeout(Duration::from_secs(5), async {
        while started(temp.path()).len() < 4 {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("four projects should reach discovery without waiting for a prior project");
    sleep(Duration::from_millis(150)).await;
    let first = started(temp.path());
    assert_eq!(first.len(), 4, "startup concurrency must remain bounded");
    assert!(
        first.iter().any(|name| name == "project-7"),
        "interrupted project belongs in the first batch"
    );
    assert!(app.snapshot().await.workspaces.iter().all(|workspace| workspace.status == WorkspaceStatus::Connecting));
    std::fs::write(temp.path().join("release"), "").unwrap();
    ready(&app).await;
    assert_eq!(started(temp.path()).len(), 8);
    let snapshot = app.snapshot().await;
    assert!(
        snapshot
            .threads
            .iter()
            .any(|thread| thread.id == "session-7" && thread.last_error.is_some())
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "controlled reconnect latency measurement; run with --ignored --nocapture"]
async fn measure_eight_workspace_reconnect() {
    for sample in 0..3 {
        let (_temp, app) = fixture(false).await;
        let start = Instant::now();
        app.restore_local_state().await.unwrap();
        ready(&app).await;
        println!(
            "{}",
            json!({"sample": sample, "workspace_count": 8, "restore_ms": start.elapsed().as_secs_f64() * 1000.0})
        );
        app.shutdown().await.unwrap();
    }
}
