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
