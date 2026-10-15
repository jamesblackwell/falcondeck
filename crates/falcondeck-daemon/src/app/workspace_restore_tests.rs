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
    let claude = temp.path().join("claude");
    std::fs::write(
        &claude,
        r#"#!/usr/bin/env python3
import json, os, pathlib, time
root = pathlib.Path(__ROOT__)
(root / 'claude-pid').write_text(str(os.getpid()))
while (root / 'pause-claude').exists(): time.sleep(0.01)
print(json.dumps({'authenticated': True}), flush=True)
"#
        .replace("__ROOT__", &serde_json::to_string(temp.path()).unwrap()),
    )
    .unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o700)).unwrap();
    let app = AppState::new_with_state_path(
        "test".into(),
        HashMap::from([
            (AgentProvider::CODEX, codex.to_string_lossy().into_owned()),
            (AgentProvider::CLAUDE, claude.to_string_lossy().into_owned()),
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
    let idle = serde_json::from_value(json!({
        "thread_id": "idle", "provider": "codex", "status": "idle"
    }))
    .unwrap();
    let mut workspace = workspaces[0].clone();
    workspace.thread_states.push(idle);
    app.restore_workspace_placeholder(&workspace, WorkspaceStatus::Connecting, None)
        .await
        .unwrap();
    // Keep process startup outside the short test deadline; only the native
    // history discovery below is deliberately blocked.
    drop(app.session_for("workspace-0").await.unwrap());
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
        snapshot.threads[0].last_error.is_none(),
        "workspace discovery warnings must not become thread errors"
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

#[tokio::test]
async fn closing_or_removing_a_project_during_discovery_does_not_reopen_it() {
    for remove in [false, true] {
        let (temp, app, _) = blocked_workspaces(1).await;
        std::fs::write(temp.path().join("pause-claude"), "").unwrap();
        app.inner
            .lazy_workspaces
            .lock()
            .await
            .insert("workspace-0".into());
        let connect = tokio::spawn({
            let app = app.clone();
            async move { app.connect_workspace_on_demand("workspace-0").await }
        });
        timeout(Duration::from_secs(5), async {
            while started(temp.path()) == 0 || !temp.path().join("claude-pid").exists() {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if remove {
            app.remove_workspace("workspace-0").await.unwrap();
        } else {
            app.close_workspace("workspace-0").await.unwrap();
        }
        std::fs::remove_file(temp.path().join("pause-claude")).unwrap();
        let result = timeout(Duration::from_secs(5), connect)
            .await
            .unwrap()
            .unwrap();
        let snapshot = app.snapshot().await;
        app.shutdown().await.unwrap();
        assert!(
            result.is_err(),
            "a closed project's discovery must be discarded"
        );
        assert!(snapshot.workspaces.is_empty());
    }
}

#[tokio::test]
async fn cancelling_discovery_stops_its_provider_probes() {
    let (temp, app, workspaces) = blocked_workspaces(1).await;
    std::fs::write(temp.path().join("pause-claude"), "").unwrap();
    let connect = tokio::spawn({
        let app = app.clone();
        let workspace = workspaces[0].clone();
        async move {
            app.connect_workspace_internal(
                ConnectWorkspaceRequest {
                    path: workspace.path.clone(),
                    kind: workspace_kind_for_path(&workspace.path),
                },
                Some(&workspace),
            )
            .await
        }
    });
    timeout(Duration::from_secs(5), async {
        while !temp.path().join("claude-pid").exists() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(temp.path().join("claude-pid"))
        .unwrap()
        .parse()
        .unwrap();
    connect.abort();
    let _ = connect.await;
    let stopped = timeout(Duration::from_secs(2), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    std::fs::remove_file(temp.path().join("pause-claude")).unwrap();
    app.shutdown().await.unwrap();
    assert!(
        stopped,
        "cancelled discovery must not leave detached auth probes running"
    );
}

#[tokio::test]
async fn closing_a_project_waiting_for_a_startup_slot_cancels_discovery() {
    let (temp, app, workspaces) = blocked_workspaces(1).await;
    std::fs::write(temp.path().join("release"), "").unwrap();
    app.inner
        .lazy_workspaces
        .lock()
        .await
        .insert("workspace-0".into());
    let slots = app
        .inner
        .workspace_start_slots
        .acquire_many(4)
        .await
        .unwrap();
    let connect = tokio::spawn({
        let app = app.clone();
        async move { app.connect_workspace_on_demand("workspace-0").await }
    });
    timeout(Duration::from_secs(5), async {
        loop {
            let gate = app
                .inner
                .workspace_connect_gates
                .lock()
                .await
                .get(&workspaces[0].path)
                .cloned();
            if gate.is_some_and(|gate| gate.try_lock().is_err()) {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    app.close_workspace("workspace-0").await.unwrap();
    drop(slots);
    let result = timeout(Duration::from_secs(5), connect)
        .await
        .unwrap()
        .unwrap();
    let snapshot = app.snapshot().await;
    app.shutdown().await.unwrap();
    assert!(result.is_err());
    assert!(snapshot.workspaces.is_empty());
    assert_eq!(started(temp.path()), 0);
}

#[tokio::test]
async fn startup_skips_a_project_closed_before_its_restore_worker_is_admitted() {
    let (temp, app, workspaces) = blocked_workspaces(5).await;
    let restore = tokio::spawn({
        let app = app.clone();
        async move { app.restore_workspaces(workspaces, false).await }
    });
    timeout(Duration::from_secs(5), async {
        while started(temp.path()) < 4 {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    app.close_workspace("workspace-4").await.unwrap();
    std::fs::write(temp.path().join("release"), "").unwrap();
    timeout(Duration::from_secs(5), restore)
        .await
        .unwrap()
        .unwrap();
    let snapshot = app.snapshot().await;
    app.shutdown().await.unwrap();
    assert_eq!(started(temp.path()), 4);
    assert!(
        !snapshot
            .workspaces
            .iter()
            .any(|workspace| workspace.id == "workspace-4")
    );
}

#[tokio::test]
async fn workspace_discovery_preserves_negotiated_optional_provider_metadata() {
    let (temp, app, workspaces) = blocked_workspaces(1).await;
    std::fs::write(temp.path().join("release"), "").unwrap();
    std::fs::write(temp.path().join("providers.json"), serde_json::to_vec(&json!({
        "providers": {"custom": {"command": ["/usr/bin/false"], "label": "Custom", "transport": "acp"}}
    })).unwrap()).unwrap();
    let prior = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces.get_mut("workspace-0").unwrap();
        let mut agent = workspace.summary.agents[0].clone();
        agent.provider = AgentProvider::new("custom");
        agent.label = "Custom".into();
        agent.account.label = "Custom connected".into();
        agent.account.status = falcondeck_core::AccountStatus::Ready;
        agent.models.push(
            serde_json::from_value(json!({
                "id": "negotiated", "label": "Negotiated model", "is_default": true,
                "supported_reasoning_efforts": []
            }))
            .unwrap(),
        );
        workspace.summary.agents.push(agent.clone());
        agent
    };
    app.restore_workspaces(workspaces, false).await;
    let snapshot = app.snapshot().await;
    let agent = snapshot.workspaces[0]
        .agents
        .iter()
        .find(|agent| agent.provider == prior.provider)
        .unwrap();
    app.shutdown().await.unwrap();
    assert_eq!(agent, &prior);
}

#[tokio::test]
async fn optional_only_projects_do_not_require_a_builtin_provider_to_connect() {
    let (temp, _, workspaces) = blocked_workspaces(1).await;
    std::fs::write(temp.path().join("providers.json"), serde_json::to_vec(&json!({
        "providers": {"custom": {"command": ["/usr/bin/false"], "label": "Custom", "transport": "acp"}}
    })).unwrap()).unwrap();
    let bins = [
        AgentProvider::CODEX,
        AgentProvider::CLAUDE,
        AgentProvider::AGY,
    ]
    .into_iter()
    .map(|provider| {
        let bin = temp
            .path()
            .join(format!("missing-{provider}"))
            .to_string_lossy()
            .into_owned();
        (provider, bin)
    })
    .collect();
    let app = AppState::new_with_state_path("test".into(), bins, temp.path().join("state.json"));
    app.restore_workspace_placeholder(&workspaces[0], WorkspaceStatus::Ready, None)
        .await
        .unwrap();
    app.inner
        .lazy_workspaces
        .lock()
        .await
        .insert("workspace-0".into());
    let result = app.connect_workspace_on_demand("workspace-0").await;
    let snapshot = app.snapshot().await;
    app.shutdown().await.unwrap();
    assert!(
        result.is_ok(),
        "an installed optional agent must remain usable when Codex and Claude are absent: {result:?}"
    );
    assert!(
        snapshot.workspaces[0]
            .agents
            .iter()
            .any(|agent| agent.provider.as_str() == "custom")
    );
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
