use super::*;

#[tokio::test]
async fn create_full_model_without_effort_survives_snapshot_and_restart() {
    let (app, temp) = fixture().await;
    let mut events = app.subscribe();
    let result = app
        .invoke_extension_tool(call(
            CREATE,
            json!({"provider": "claude", "model": "claude-opus-5-5"}),
        ))
        .await
        .unwrap();
    let id = created_id(&result);
    let snapshot = app.snapshot().await;
    let thread = snapshot.threads.iter().find(|t| t.id == id).unwrap();
    assert_eq!(thread.agent.model_id.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(thread.agent.reasoning_effort, None);

    let mut saw_update = false;
    while let Ok(event) = events.try_recv() {
        if let UnifiedEvent::ThreadUpdated { thread: updated } = &event.envelope.event
            && updated.id == id
        {
            assert_eq!(updated.agent, thread.agent);
            saw_update = true;
        }
    }
    assert!(
        saw_update,
        "create must publish the recorded settings to relay clients"
    );

    let persisted: PersistedAppState = serde_json::from_str(
        &std::fs::read_to_string(temp.path().join("daemon-state.json")).unwrap(),
    )
    .unwrap();
    let restored = AppState::new_with_state_path(
        "test".into(),
        HashMap::new(),
        temp.path().join("restored-state.json"),
    );
    restored
        .restore_workspace_placeholder(&persisted.workspaces[0], WorkspaceStatus::Ready, None)
        .await
        .unwrap();
    let restored_thread = restored.thread_summary("workspace-1", &id).await.unwrap();
    assert_eq!(restored_thread.agent, thread.agent);
}

#[tokio::test]
async fn create_explicit_reasoning_survives_snapshot_and_restart() {
    for effort in ["high", "xhigh"] {
        let (app, temp) = fixture().await;
        let result = app
            .invoke_extension_tool(call(
                CREATE,
                json!({
                    "provider": "claude", "model": "test-model", "reasoning_effort": effort
                }),
            ))
            .await
            .unwrap();
        let id = created_id(&result);
        let snapshot = app.snapshot().await;
        let thread = snapshot.threads.iter().find(|t| t.id == id).unwrap();
        assert_eq!(thread.agent.reasoning_effort.as_deref(), Some(effort));
        let persisted: PersistedAppState = serde_json::from_str(
            &std::fs::read_to_string(temp.path().join("daemon-state.json")).unwrap(),
        )
        .unwrap();
        let restored = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            temp.path().join("restored-state.json"),
        );
        restored
            .restore_workspace_placeholder(&persisted.workspaces[0], WorkspaceStatus::Ready, None)
            .await
            .unwrap();
        assert_eq!(
            restored
                .thread_summary("workspace-1", &id)
                .await
                .unwrap()
                .agent,
            thread.agent
        );
    }
}

#[tokio::test]
async fn create_rejects_blank_reasoning_before_creating_thread() {
    let (app, _temp) = fixture().await;
    for effort in ["", "   "] {
        assert!(
            app.invoke_extension_tool(call(
                CREATE,
                json!({
                    "reasoning_effort": effort
                })
            ))
            .await
            .is_err()
        );
    }
    assert_eq!(app.snapshot().await.threads.len(), 1);
}

#[test]
fn create_catalog_advertises_reasoning_effort() {
    let tool = catalog().into_iter().find(|t| t.name == CREATE).unwrap();
    let effort = &tool.input_schema["properties"]["reasoning_effort"];
    assert_eq!(effort["type"], "string");
    assert_eq!(effort["minLength"], 1);
    assert!(effort["description"].as_str().unwrap().contains("xhigh"));
}
