use std::{collections::HashMap, path::Path, sync::Arc};

use chrono::Utc;
use falcondeck_core::{
    AgentProvider, ContentLifecycle, ConversationItem, ThreadStatus, TurnInputItem, WorkspaceStatus,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::{Duration, timeout};

use crate::{acp::AcpRuntime, app::AppState};

async fn fixture() -> (TempDir, AppState) {
    let (temp, app, old, _events, _) = super::hermes_tests::fixture().await;
    old.shutdown().await;
    app.inner
        .workspaces
        .lock()
        .await
        .get_mut("workspace")
        .unwrap()
        .acp_runtimes
        .clear();
    app.with_thread_mut("workspace", "thread", |thread| {
        thread.native_session_id = None;
        thread.status = ThreadStatus::Idle;
    })
    .await
    .unwrap();
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hermes_history_agent.mjs");
    std::fs::write(temp.path().join("providers.json"), serde_json::to_vec(&json!({
        "providers": {"hermes": {"label": "Hermes", "command": ["node", script],
            "env": {"HERMES_FIXTURE_STORE": temp.path().join("native.json")}, "transport": "acp"}}
    })).unwrap()).unwrap();
    app.set_local_base_url("http://127.0.0.1:1".into());
    {
        let mut extensions = app.inner.extensions.lock().await;
        extensions.restore().await.unwrap();
        extensions
            .update_enabled("falcondeck.follow-up-suggestions", true)
            .await
            .unwrap();
        extensions
            .update_permission(
                "falcondeck.follow-up-suggestions",
                "agent-tools:register",
                true,
            )
            .await
            .unwrap();
    }
    (temp, app)
}

async fn runtime(app: &AppState, thread: &str) -> Arc<AcpRuntime> {
    app.acp_runtime_for_thread("workspace", &AgentProvider::new("hermes"), Some(thread))
        .await
        .unwrap()
}

async fn turn(app: &AppState, thread: &str, text: &str) {
    app.with_thread_mut("workspace", thread, |thread| {
        thread.status = ThreadStatus::Running;
    })
    .await
    .unwrap();
    app.push_conversation_item(
        "workspace",
        thread,
        ConversationItem::UserMessage {
            id: uuid::Uuid::new_v4().to_string(),
            text: text.into(),
            created_at: Utc::now(),
            attachments: vec![],
            turn_id: None,
            previous_turn_id: None,
        },
        true,
    )
    .await
    .unwrap();
    super::start_acp_turn(
        app,
        "workspace",
        thread,
        &AgentProvider::new("hermes"),
        &[TurnInputItem::Text {
            id: None,
            text: text.into(),
        }],
        &[],
        super::AcpTurnStartOptions {
            wait_for_startup: true,
            resume_interrupted: false,
        },
    )
    .await
    .unwrap();
    timeout(Duration::from_secs(10), async {
        loop {
            if app
                .thread_summary("workspace", thread)
                .await
                .unwrap()
                .status
                != ThreadStatus::Running
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        app.thread_summary("workspace", thread)
            .await
            .unwrap()
            .status,
        ThreadStatus::Idle
    );
    runtime(app, thread).await.drain_events().await.unwrap();
}

async fn retire(app: &AppState, thread: &str) {
    let key = super::AcpRuntimeKey::new(&AgentProvider::new("hermes"), Some(thread));
    let removed = app
        .inner
        .workspaces
        .lock()
        .await
        .get_mut("workspace")
        .unwrap()
        .acp_runtimes
        .remove(&key)
        .unwrap();
    let _exclusive = removed.retirement_guard().await;
    removed.shutdown().await;
}

async fn counts(app: &AppState, thread: &str) -> (usize, usize, usize) {
    let workspaces = app.inner.workspaces.lock().await;
    let items = &workspaces["workspace"].threads[thread].items;
    (
        items
            .iter()
            .filter(|i| matches!(i, ConversationItem::UserMessage { .. }))
            .count(),
        items
            .iter()
            .filter(|i| matches!(i, ConversationItem::AssistantMessage { .. }))
            .count(),
        items
            .iter()
            .filter(|i| matches!(i, ConversationItem::ToolCall { .. }))
            .count(),
    )
}

#[tokio::test]
async fn warm_replacement_keeps_the_handle_and_never_duplicates_native_messages() {
    let (_temp, app) = fixture().await;
    turn(&app, "thread", "first").await;
    let handle = app
        .thread_summary("workspace", "thread")
        .await
        .unwrap()
        .native_session_id
        .unwrap();
    assert_eq!(counts(&app, "thread").await, (1, 1, 1));
    turn(&app, "thread", "/compress").await;
    let state = runtime(&app, "thread")
        .await
        .request("probe/state", json!({}))
        .await
        .unwrap();
    assert_ne!(state["sessions"][&handle]["head"], handle);
    retire(&app, "thread").await;
    turn(&app, "thread", "second").await;
    assert_eq!(
        app.thread_summary("workspace", "thread")
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some(handle.as_str())
    );
    assert_eq!(counts(&app, "thread").await, (3, 3, 2));
    let state = runtime(&app, "thread")
        .await
        .request("probe/state", json!({}))
        .await
        .unwrap();
    assert_eq!(
        state["sessions"][&handle]["history"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        state["requests"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "session/load" && r["params"]["sessionId"] == handle)
    );
    retire(&app, "thread").await;
    app.hydrate_acp_thread("workspace", "thread", true)
        .await
        .unwrap();
    assert_eq!(counts(&app, "thread").await, (3, 3, 2));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn restored_long_history_is_fully_applied_and_settled_before_the_next_prompt() {
    let (temp, app) = fixture().await;
    turn(&app, "thread", "seed").await;
    let handle = app
        .thread_summary("workspace", "thread")
        .await
        .unwrap()
        .native_session_id
        .unwrap();
    runtime(&app, "thread")
        .await
        .request(
            "probe/seed",
            json!({"sessionId": handle, "count": 600, "repeated": true}),
        )
        .await
        .unwrap();
    app.persist_local_state().await.unwrap();
    let persisted = crate::app::load_persisted_app_state(&temp.path().join("state.json"))
        .await
        .unwrap();
    assert_eq!(
        persisted.workspaces[0].thread_states[0]
            .native_session_id
            .as_deref(),
        Some(handle.as_str())
    );
    app.shutdown().await.unwrap();
    let restored = AppState::new_with_state_path(
        "test".into(),
        HashMap::new(),
        temp.path().join("state.json"),
    );
    restored
        .restore_workspace_placeholder(&persisted.workspaces[0], WorkspaceStatus::Ready, None)
        .await
        .unwrap();
    let count = restored
        .hydrate_acp_thread("workspace", "thread", false)
        .await
        .unwrap();
    assert!(
        count >= 1800,
        "all replay items must arrive before hydration returns: {count}"
    );
    assert_eq!(counts(&restored, "thread").await, (600, 600, 600));
    {
        let workspaces = restored.inner.workspaces.lock().await;
        assert!(
            workspaces["workspace"].threads["thread"]
                .items
                .iter()
                .all(|i| !matches!(
                    i,
                    ConversationItem::AssistantMessage {
                        lifecycle: ContentLifecycle::Streaming | ContentLifecycle::Pending,
                        ..
                    } | ConversationItem::Reasoning {
                        lifecycle: ContentLifecycle::Streaming | ContentLifecycle::Pending,
                        ..
                    }
                ))
        );
    }
    restored
        .send_turn(
            serde_json::from_value(json!({
                "workspace_id": "workspace", "thread_id": "thread",
                "inputs": [{"type": "text", "text": "after restart"}]
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    timeout(Duration::from_secs(10), async {
        loop {
            if restored
                .thread_summary("workspace", "thread")
                .await
                .unwrap()
                .status
                == ThreadStatus::Idle
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    runtime(&restored, "thread")
        .await
        .drain_events()
        .await
        .unwrap();
    assert_eq!(counts(&restored, "thread").await, (601, 601, 601));
    assert_eq!(
        restored
            .thread_summary("workspace", "thread")
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some(handle.as_str())
    );
    restored.shutdown().await.unwrap();
}

#[tokio::test]
async fn sending_directly_to_an_empty_restored_thread_recovers_history_before_the_new_user() {
    let (temp, app) = fixture().await;
    turn(&app, "thread", "first").await;
    app.persist_local_state().await.unwrap();
    let persisted = crate::app::load_persisted_app_state(&temp.path().join("state.json"))
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    let restored = AppState::new_with_state_path(
        "test".into(),
        HashMap::new(),
        temp.path().join("state.json"),
    );
    restored
        .restore_workspace_placeholder(&persisted.workspaces[0], WorkspaceStatus::Ready, None)
        .await
        .unwrap();
    restored.send_turn(serde_json::from_value(json!({
        "workspace_id": "workspace", "thread_id": "thread", "inputs": [{"type": "text", "text": "second"}]
    })).unwrap()).await.unwrap();
    timeout(Duration::from_secs(10), async {
        loop {
            if restored
                .thread_summary("workspace", "thread")
                .await
                .unwrap()
                .status
                == ThreadStatus::Idle
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    runtime(&restored, "thread")
        .await
        .drain_events()
        .await
        .unwrap();
    assert_eq!(counts(&restored, "thread").await, (2, 2, 2));
    let workspaces = restored.inner.workspaces.lock().await;
    let users: Vec<_> = workspaces["workspace"].threads["thread"]
        .items
        .iter()
        .filter_map(|i| {
            if let ConversationItem::UserMessage { text, .. } = i {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(users, ["first", "second"]);
    drop(workspaces);
    restored.shutdown().await.unwrap();
}

#[tokio::test]
async fn unavailable_native_session_fails_visibly_without_replacement() {
    let (temp, app) = fixture().await;
    turn(&app, "thread", "first").await;
    let handle = app
        .thread_summary("workspace", "thread")
        .await
        .unwrap()
        .native_session_id
        .unwrap();
    retire(&app, "thread").await;
    std::fs::write(temp.path().join("native.json"), "{}").unwrap();
    app.with_thread_mut("workspace", "thread", |thread| {
        thread.status = ThreadStatus::Running;
    })
    .await
    .unwrap();
    super::start_acp_turn(
        &app,
        "workspace",
        "thread",
        &AgentProvider::new("hermes"),
        &[TurnInputItem::Text {
            id: None,
            text: "must not run".into(),
        }],
        &[],
        super::AcpTurnStartOptions {
            wait_for_startup: false,
            resume_interrupted: false,
        },
    )
    .await
    .unwrap();
    timeout(Duration::from_secs(10), async {
        loop {
            if app
                .thread_summary("workspace", "thread")
                .await
                .unwrap()
                .status
                == ThreadStatus::Error
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let thread = app.thread_summary("workspace", "thread").await.unwrap();
    assert_eq!(thread.native_session_id.as_deref(), Some(handle.as_str()));
    assert!(
        thread
            .last_error
            .unwrap()
            .contains("Native session is unavailable")
    );
    let state = runtime(&app, "thread")
        .await
        .request("probe/state", json!({}))
        .await
        .unwrap();
    assert!(
        !state["requests"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "session/prompt")
    );
    assert!(state["sessions"].get(&handle).is_none());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn connector_edits_replace_only_the_thread_owner_and_load_the_same_handle() {
    let (temp, app) = fixture().await;
    let path = temp.path().join(".falcondeck/connectors.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let config = |revision| json!({"mcpServers": {"identity": {"command": "fixture-mcp", "env": {"REVISION": revision}}}});
    std::fs::write(&path, config("one").to_string()).unwrap();
    app.upsert_thread("workspace", "other", |thread| {
        thread.provider = AgentProvider::new("hermes");
    })
    .await
    .unwrap();
    let other = runtime(&app, "other").await;
    app.with_thread_mut("workspace", "other", |thread| {
        thread.status = ThreadStatus::Running;
    })
    .await
    .unwrap();
    turn(&app, "thread", "first").await;
    let first = runtime(&app, "thread").await;
    assert_ne!(first.child_pid(), other.child_pid());
    assert_eq!(first.config.env["FALCONDECK_CONTROL_THREAD"], "thread");
    assert_eq!(other.config.env["FALCONDECK_CONTROL_THREAD"], "other");
    let capability = &first.config.env[crate::extension_mcp::ENV_EXTENSION_CAPABILITY];
    let other_capability = &other.config.env[crate::extension_mcp::ENV_EXTENSION_CAPABILITY];
    assert_ne!(capability, other_capability);
    assert_eq!(
        app.extension_bridge_context(Some(capability))
            .await
            .unwrap()
            .thread_id
            .as_deref(),
        Some("thread")
    );
    assert_eq!(
        app.extension_bridge_context(Some(other_capability))
            .await
            .unwrap()
            .thread_id
            .as_deref(),
        Some("other")
    );
    app.invoke_extension_tool(
        serde_json::from_value(json!({
            "name": "falcondeck_rename_thread", "arguments": {"title": "Bound to owner"},
            "thread_id": "other", "bridge_capability": capability
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        app.thread_summary("workspace", "thread")
            .await
            .unwrap()
            .title,
        "Bound to owner"
    );
    assert_ne!(
        app.thread_summary("workspace", "other")
            .await
            .unwrap()
            .title,
        "Bound to owner"
    );
    let handle = app
        .thread_summary("workspace", "thread")
        .await
        .unwrap()
        .native_session_id
        .unwrap();
    std::fs::write(&path, config("two").to_string()).unwrap();
    turn(&app, "thread", "second").await;
    let second = runtime(&app, "thread").await;
    assert!(!Arc::ptr_eq(&first, &second));
    assert!(first.is_closed());
    assert!(Arc::ptr_eq(&other, &runtime(&app, "other").await));
    let state = second.request("probe/state", json!({})).await.unwrap();
    let identity = state["loaded"][&handle]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "identity")
        .unwrap();
    assert!(
        identity["env"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "REVISION" && e["value"] == "two")
    );
    let extension = state["loaded"][&handle]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == crate::connectors::BUILTIN_EXTENSIONS_CONNECTOR_NAME)
        .unwrap();
    let env = extension["env"].as_array().unwrap();
    let capability = env
        .iter()
        .find(|e| e["name"] == crate::extension_mcp::ENV_EXTENSION_CAPABILITY)
        .unwrap()["value"]
        .as_str()
        .unwrap();
    assert_eq!(
        app.extension_bridge_context(Some(capability))
            .await
            .unwrap()
            .thread_id
            .as_deref(),
        Some("thread")
    );
    assert_eq!(counts(&app, "thread").await, (2, 2, 2));
    assert_eq!(
        app.thread_summary("workspace", "thread")
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some(handle.as_str())
    );
    // Same connector snapshot and fresh built-in tokens must keep it warm.
    turn(&app, "thread", "third").await;
    assert!(Arc::ptr_eq(&second, &runtime(&app, "thread").await));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn opening_an_unavailable_native_session_shows_the_error_and_can_retry() {
    let (temp, app) = fixture().await;
    turn(&app, "thread", "first").await;
    let native_path = temp.path().join("native.json");
    let saved_native = std::fs::read(&native_path).unwrap();
    app.persist_local_state().await.unwrap();
    let persisted = crate::app::load_persisted_app_state(&temp.path().join("state.json"))
        .await
        .unwrap();
    let handle = persisted.workspaces[0].thread_states[0]
        .native_session_id
        .clone();
    app.shutdown().await.unwrap();
    std::fs::write(&native_path, "{}").unwrap();
    let restored = AppState::new_with_state_path(
        "test".into(),
        HashMap::new(),
        temp.path().join("state.json"),
    );
    restored
        .restore_workspace_placeholder(&persisted.workspaces[0], WorkspaceStatus::Ready, None)
        .await
        .unwrap();
    restored.schedule_acp_thread_hydration("workspace", "thread");
    timeout(Duration::from_secs(10), async {
        loop {
            if restored
                .thread_summary("workspace", "thread")
                .await
                .unwrap()
                .status
                == ThreadStatus::Error
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let summary = restored
        .thread_summary("workspace", "thread")
        .await
        .unwrap();
    assert_eq!(summary.native_session_id, handle);
    assert!(
        summary
            .last_error
            .unwrap()
            .contains("Native session is unavailable")
    );
    assert_eq!(counts(&restored, "thread").await, (0, 0, 0));
    std::fs::write(&native_path, saved_native).unwrap();
    let gate = restored.acp_hydration_gate("workspace", "thread").await;
    let _guard = gate.lock().await;
    restored
        .hydrate_acp_thread("workspace", "thread", false)
        .await
        .unwrap();
    assert_eq!(counts(&restored, "thread").await, (1, 1, 1));
    let summary = restored
        .thread_summary("workspace", "thread")
        .await
        .unwrap();
    assert_eq!(summary.status, ThreadStatus::Idle);
    assert!(summary.last_error.is_none());
    assert_eq!(summary.native_session_id, handle);
    restored.shutdown().await.unwrap();
}

#[tokio::test]
async fn generic_adapters_still_share_a_workspace_runtime() {
    let provider = AgentProvider::new("custom");
    assert_eq!(
        super::AcpRuntimeKey::new(&provider, Some("a")),
        super::AcpRuntimeKey::new(&provider, Some("b"))
    );
    let value: Value = super::user_connector_snapshot(r#"[{"name":"identity","env":{"VALUE":"one"}},{"name":"falcondeck-extensions","env":{"CAP":"fixture"}}]"#).unwrap();
    assert_eq!(value.as_array().unwrap().len(), 1);
    let (temp, app) = fixture().await;
    let path = temp.path().join("providers.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    config["providers"]["custom"] = config["providers"]["hermes"].clone();
    std::fs::write(path, config.to_string()).unwrap();
    let a = app
        .acp_runtime_for_thread("workspace", &provider, Some("thread"))
        .await
        .unwrap();
    let b = app
        .acp_runtime_for_thread("workspace", &provider, Some("other"))
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&a, &b));
    assert!(!a.config.env.contains_key("FALCONDECK_CONTROL_THREAD"));
    assert_eq!(
        a.config.env["FALCONDECK_CONTROL_WORKSPACE"],
        temp.path().to_string_lossy()
    );
    let capability = &a.config.env[crate::extension_mcp::ENV_EXTENSION_CAPABILITY];
    assert!(
        app.extension_bridge_context(Some(capability))
            .await
            .unwrap()
            .thread_id
            .is_none()
    );
    app.shutdown().await.unwrap();
}
