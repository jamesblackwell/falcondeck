use std::{collections::HashMap, path::PathBuf, time::Duration};

use chrono::Utc;
use falcondeck_core::{AgentProvider, WorkspaceStatus, WorkspaceSummary};
use tempfile::{TempDir, tempdir};

use super::super::{AppState, ManagedWorkspace};

const WORKSPACE: &str = "metadata-resource-test";
const PROVIDER: &str = "resource-test";

async fn metadata_fixture() -> (TempDir, AppState, PathBuf, PathBuf) {
    let temp = tempdir().unwrap();
    let marker = temp.path().join("metadata-started");
    let release = temp.path().join("release-metadata");
    let script = temp.path().join("agent.mjs");
    std::fs::write(
        &script,
        r#"
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
const [marker, release] = process.argv.slice(2);
const input = createInterface({ input: process.stdin });
const reply = (id, result) => console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    reply(message.id, {protocolVersion:1,agentCapabilities:{}});
  } else if (message.method === 'session/new') {
    writeFileSync(marker, String(process.pid));
    const timer = setInterval(() => {
      if (existsSync(release)) {
        clearInterval(timer);
        reply(message.id, {sessionId:'metadata-session'});
      }
    }, 10);
  }
});
"#,
    )
    .unwrap();
    std::fs::write(
        temp.path().join("providers.json"),
        serde_json::to_vec(&serde_json::json!({"providers": {(PROVIDER): {
            "label": "Resource fixture",
            "command": ["node", script, marker, release],
            "transport": "acp"
        }}}))
        .unwrap(),
    )
    .unwrap();
    let app = AppState::new_with_state_path(
        "test".into(),
        HashMap::new(),
        temp.path().join("daemon-state.json"),
    );
    app.inner.workspaces.lock().await.insert(
        WORKSPACE.into(),
        ManagedWorkspace {
            summary: WorkspaceSummary {
                id: WORKSPACE.into(),
                path: temp.path().to_string_lossy().into_owned(),
                kind: falcondeck_core::WorkspaceKind::Project,
                status: WorkspaceStatus::Ready,
                agents: Vec::new(),
                skills: Vec::new(),
                default_provider: AgentProvider::new(PROVIDER),
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: Default::default(),
                current_thread_id: None,
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
                icon: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: HashMap::new(),
        },
    );
    (temp, app, marker, release)
}

struct FixtureProcess(u32);

impl FixtureProcess {
    async fn started(marker: &std::path::Path) -> Self {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(value) = std::fs::read_to_string(marker) {
                    if let Ok(pid) = value.parse() {
                        return Self(pid);
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture never entered metadata discovery")
    }

    async fn exited(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(2), async {
            while unsafe { libc::kill(self.0 as i32, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
    }
}

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        // Only this test's isolated process group is eligible for cleanup.
        unsafe { libc::kill(-(self.0 as i32), libc::SIGKILL) };
    }
}

#[tokio::test]
async fn cancelling_metadata_bootstrap_stops_the_uninstalled_runtime() {
    let (_temp, app, marker, _release) = metadata_fixture().await;
    let task = tokio::spawn({
        let app = app.clone();
        async move {
            app.acp_runtime_for(WORKSPACE, &AgentProvider::new(PROVIDER))
                .await
        }
    });
    let process = FixtureProcess::started(&marker).await;
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    let exited = process.exited().await;
    app.shutdown().await.unwrap();
    assert!(
        exited,
        "cancelled metadata bootstrap retained its ACP child"
    );
}

#[tokio::test]
async fn removed_workspace_cannot_leave_an_uninstalled_runtime_running() {
    let (_temp, app, marker, release) = metadata_fixture().await;
    let task = tokio::spawn({
        let app = app.clone();
        async move {
            app.acp_runtime_for(WORKSPACE, &AgentProvider::new(PROVIDER))
                .await
        }
    });
    let process = FixtureProcess::started(&marker).await;
    app.inner.workspaces.lock().await.remove(WORKSPACE);
    std::fs::write(release, "ready").unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    let rejected = result.is_err();
    if let Ok(runtime) = result {
        runtime.shutdown().await;
    }
    app.shutdown().await.unwrap();
    assert!(
        rejected,
        "removed workspace returned an unowned ACP runtime"
    );
    assert!(process.exited().await, "uninstalled ACP child survived");
}

#[tokio::test]
async fn installed_runtime_stays_alive_until_its_owner_shuts_down() {
    let (_temp, app, marker, release) = metadata_fixture().await;
    std::fs::write(release, "ready").unwrap();
    let runtime = app
        .acp_runtime_for(WORKSPACE, &AgentProvider::new(PROVIDER))
        .await
        .unwrap();
    let process = FixtureProcess::started(&marker).await;
    assert!(!runtime.is_closed());
    assert_eq!(unsafe { libc::kill(process.0 as i32, 0) }, 0);
    let reused = app
        .acp_runtime_for(WORKSPACE, &AgentProvider::new(PROVIDER))
        .await
        .unwrap();
    assert!(std::sync::Arc::ptr_eq(&runtime, &reused));
    app.shutdown().await.unwrap();
    assert!(
        process.exited().await,
        "managed ACP child survived shutdown"
    );
}
