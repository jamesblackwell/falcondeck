use falcondeck_core::{ConversationItem, ToolCallDetail, ToolOutputContentItem};

fn tool_with_detail(detail: serde_json::Value) -> ConversationItem {
    serde_json::from_value(serde_json::json!({
        "kind": "tool_call",
        "id": "tool-1",
        "title": "Provider tool",
        "tool_kind": "providerTool",
        "status": "completed",
        "output": null,
        "exit_code": null,
        "display": {},
        "detail": detail,
        "created_at": "2026-08-09T10:00:00Z",
        "completed_at": null
    }))
    .expect("tool detail")
}

#[test]
fn mcp_detail_preserves_arguments_result_error_and_app_context() {
    let item = tool_with_detail(serde_json::json!({
        "kind": "mcp",
        "server": "notion",
        "tool": "search",
        "arguments": {"query": "streaming"},
        "result": {"content": [{"type": "text", "text": "Found 3 pages"}]},
        "error": null,
        "duration_ms": 42,
        "app_context": {
            "connector_id": "notion",
            "app_name": "Notion",
            "action_name": "Search",
            "link_id": null,
            "resource_uri": null,
            "template_id": null
        }
    }));

    assert!(matches!(
        item,
        ConversationItem::ToolCall {
            detail,
            ..
        } if matches!(detail.as_deref(), Some(ToolCallDetail::Mcp {
            server,
            tool,
            duration_ms: Some(42),
            app_context: Some(context),
            ..
        }) if server == "notion" && tool == "search" && context.app_name.as_deref() == Some("Notion"))
    ));
}

#[test]
fn dynamic_detail_preserves_ordered_text_and_image_outputs() {
    let item = tool_with_detail(serde_json::json!({
        "kind": "dynamic",
        "tool": "render",
        "namespace": "design",
        "arguments": {"prompt": "radar"},
        "content_items": [
            {"kind": "text", "text": "Rendered"},
            {"kind": "image", "url": "data:image/png;base64,aGVsbG8="}
        ],
        "success": true,
        "duration_ms": 84
    }));

    let ConversationItem::ToolCall { detail, .. } = item else {
        panic!("expected dynamic detail");
    };
    let Some(ToolCallDetail::Dynamic { content_items, .. }) = detail.as_deref() else {
        panic!("expected dynamic detail");
    };
    assert!(
        matches!(&content_items[0], ToolOutputContentItem::Text { text } if text == "Rendered")
    );
    assert!(
        matches!(&content_items[1], ToolOutputContentItem::Image { url } if url.starts_with("data:image/png"))
    );
}

#[test]
fn collaboration_detail_preserves_thread_identity_and_agent_states() {
    let item = tool_with_detail(serde_json::json!({
        "kind": "collab_agent",
        "tool": "spawnAgent",
        "sender_thread_id": "thread-parent",
        "receiver_thread_ids": ["thread-child"],
        "prompt": "Audit accessibility",
        "model": "gpt-5.6-terra",
        "reasoning_effort": "high",
        "agent_states": {
            "thread-child": {"status": "running", "message": "Inspecting iOS"}
        }
    }));

    assert!(matches!(
        item,
        ConversationItem::ToolCall {
            detail,
            ..
        } if matches!(detail.as_deref(), Some(ToolCallDetail::CollabAgent {
            sender_thread_id,
            receiver_thread_ids,
            agent_states,
            ..
        }) if sender_thread_id == "thread-parent"
            && receiver_thread_ids.as_slice() == ["thread-child"]
            && agent_states["thread-child"].message.as_deref() == Some("Inspecting iOS"))
    ));
}

#[test]
fn subagent_activity_preserves_agent_path_and_thread() {
    let item = tool_with_detail(serde_json::json!({
        "kind": "subagent_activity",
        "activity": "started",
        "agent_thread_id": "thread-child",
        "agent_path": "qa/mobile"
    }));
    assert!(matches!(
        item,
        ConversationItem::ToolCall {
            detail,
            ..
        } if matches!(detail.as_deref(), Some(ToolCallDetail::SubagentActivity {
            activity,
            agent_thread_id,
            agent_path,
        }) if activity == "started" && agent_thread_id == "thread-child" && agent_path == "qa/mobile")
    ));
}
