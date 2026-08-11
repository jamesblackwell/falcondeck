use falcondeck_core::{ConversationItem, ToolCallDetail};

#[test]
fn command_execution_round_trips_structured_evidence() {
    let value = serde_json::json!({
        "kind": "tool_call",
        "id": "command-1",
        "title": "rg streaming src",
        "tool_kind": "commandExecution",
        "status": "completed",
        "output": "src/chat.ts:42",
        "exit_code": 0,
        "display": {
            "is_read_only": false,
            "has_side_effect": false,
            "is_error": false,
            "lifecycle": "unknown",
            "artifact_kind": "none",
            "activity_kind": "other",
            "history_mode": "full",
            "summary_hint": null
        },
        "detail": {
            "kind": "command_execution",
            "command": "rg streaming src",
            "cwd": "/workspace",
            "actions": [{
                "action_kind": "search",
                "command": "rg streaming src",
                "name": null,
                "path": "src",
                "query": "streaming"
            }],
            "process_id": "4242",
            "duration_ms": 37,
            "source": "agent"
        },
        "created_at": "2026-08-09T10:00:00Z",
        "completed_at": "2026-08-09T10:00:01Z"
    });

    let item: ConversationItem = serde_json::from_value(value.clone()).expect("deserialize");
    let ConversationItem::ToolCall { detail, .. } = &item else {
        panic!("expected structured command detail");
    };
    let Some(ToolCallDetail::CommandExecution {
        command,
        cwd,
        actions,
        process_id,
        duration_ms,
        source,
    }) = detail.as_deref()
    else {
        panic!("expected structured command detail");
    };
    assert_eq!(command, "rg streaming src");
    assert_eq!(cwd, "/workspace");
    assert_eq!(actions[0].action_kind, "search");
    assert_eq!(actions[0].path.as_deref(), Some("src"));
    assert_eq!(actions[0].query.as_deref(), Some("streaming"));
    assert_eq!(process_id.as_deref(), Some("4242"));
    assert_eq!(*duration_ms, Some(37));
    assert_eq!(source.as_deref(), Some("agent"));
    assert_eq!(serde_json::to_value(item).expect("serialize"), value);
}

#[test]
fn legacy_tool_call_without_detail_remains_compatible() {
    let item: ConversationItem = serde_json::from_value(serde_json::json!({
        "kind": "tool_call",
        "id": "legacy-command",
        "title": "pwd",
        "tool_kind": "commandExecution",
        "status": "completed",
        "output": "/workspace",
        "exit_code": 0,
        "display": {},
        "created_at": "2026-08-09T10:00:00Z",
        "completed_at": null
    }))
    .expect("legacy tool call");

    assert!(matches!(
        item,
        ConversationItem::ToolCall { detail: None, .. }
    ));
}
