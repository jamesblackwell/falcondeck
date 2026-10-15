use std::{collections::HashMap, os::unix::fs::PermissionsExt, path::Path};

use falcondeck_core::AgentProvider;
use serde_json::json;
use tokio::time::sleep;

use super::*;

async fn blocked_workspaces(
    count: usize,
) -> (tempfile::TempDir, AppState, Vec<PersistedWorkspaceState>) {
    let temp = tempfile::tempdir().unwrap();
    let codex = temp.path().join("codex");
    let script = r#"#!/usr/bin/env python3
import json, pathlib, sys, time
root = pathlib.Path(__ROOT__)
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request: continue
    method = request['method']
    result = {}
    if method == 'account/read': result = {'account': {'type': 'chatgpt'}}
    elif method in ('model/list', 'collaborationMode/list', 'skills/list'): result = {'data': []}
    elif method == 'thread/list':
        (root / ('started-' + pathlib.Path.cwd().name)).write_text('started')
        while not (root / 'release').exists(): time.sleep(0.01)
        result = {'data': []}
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
"#
    .replace("__ROOT__", &serde_json::to_string(temp.path()).unwrap());
    std::fs::write(&codex, script).unwrap();
    std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o700)).unwrap();
    let app = AppState::new_with_state_path(
        "test".into(),
        HashMap::from([
            (AgentProvider::CODEX, codex.to_string_lossy().into_owned()),
            (AgentProvider::CLAUDE, "/usr/bin/false".into()),
            (AgentProvider::AGY, "/usr/bin/false".into()),
        ]),
        temp.path().join("state.json"),
    );
    let mut workspaces = Vec::new();
    for index in 0..count {
        let path = temp.path().join(format!("project-{index}"));
        std::fs::create_dir(&path).unwrap();
        let workspace = PersistedWorkspaceState {
            id: Some(format!("workspace-{index}")),
            path: path.canonicalize().unwrap().to_string_lossy().into_owned(),
            ..Default::default()
        };
        app.restore_workspace_placeholder(&workspace, WorkspaceStatus::Connecting, None)
            .await
            .unwrap();
        workspaces.push(workspace);
    }
    (temp, app, workspaces)
}

fn started(root: &Path) -> usize {
    std::fs::read_dir(root)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("started-")
        })
        .count()
}

#[tokio::test]
async fn timed_out_restores_retry_without_admitting_more_than_four_projects() {
    let (temp, app, workspaces) = blocked_workspaces(8).await;
    let restore = tokio::spawn({
        let app = app.clone();
        async move {
            app.restore_workspaces_with_deadline(workspaces, false, Duration::from_secs(1))
                .await
        }
    });
    timeout(Duration::from_secs(5), async {
        while started(temp.path()) < 4 {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    sleep(Duration::from_millis(1100)).await;
    assert_eq!(
        started(temp.path()),
        4,
        "timeout retries must keep their original restore slots"
    );
    std::fs::write(temp.path().join("release"), "").unwrap();
    timeout(Duration::from_secs(5), restore)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(started(temp.path()), 8);
    assert!(
        app.snapshot()
            .await
            .workspaces
            .iter()
            .all(|workspace| workspace.status == WorkspaceStatus::Ready)
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn repeated_timeout_settles_startup_and_allows_a_later_open() {
    let (temp, app, workspaces) = blocked_workspaces(1).await;
    timeout(
        Duration::from_secs(5),
        app.restore_workspaces_with_deadline(workspaces, false, Duration::from_millis(300)),
    )
    .await
    .unwrap();
    assert_eq!(started(temp.path()), 1);
    let snapshot = app.snapshot().await;
    assert_eq!(snapshot.workspaces[0].status, WorkspaceStatus::Ready);
    assert!(
        snapshot.workspaces[0]
            .last_error
            .as_deref()
            .unwrap()
            .contains("timed out")
    );
    assert!(
        app.inner
            .lazy_workspaces
            .lock()
            .await
            .contains("workspace-0")
    );
    std::fs::write(temp.path().join("release"), "").unwrap();
    app.connect_workspace_on_demand("workspace-0")
        .await
        .unwrap();
    assert!(app.inner.lazy_workspaces.lock().await.is_empty());
    assert!(app.snapshot().await.workspaces[0].last_error.is_none());
    app.shutdown().await.unwrap();
}

#[test]
fn archived_interruptions_stay_lazy_but_queued_work_is_restored() {
    let workspace: PersistedWorkspaceState = serde_json::from_value(json!({
        "path": "/project", "archived_thread_ids": ["archived"],
        "thread_states": [{"thread_id": "archived", "status": "running"}]
    }))
    .unwrap();
    assert!(!needs_startup_connection(&workspace));
    let queued: PersistedWorkspaceState = serde_json::from_value(json!({
        "path": "/project", "thread_states": [{"thread_id": "queued", "status": "idle",
            "queued_requests": [{"id": "queue-1", "summary": {"id": "queue-1", "preview": "Continue", "queued_at": "2026-10-15T00:00:00Z"},
                "request": {"workspace_id": "workspace-1", "thread_id": "queued", "inputs": []}}]}]
    })).unwrap();
    assert!(needs_startup_connection(&queued));
}
