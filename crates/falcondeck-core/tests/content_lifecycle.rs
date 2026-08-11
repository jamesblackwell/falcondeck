use falcondeck_core::{ContentLifecycle, ConversationItem};
use serde_json::json;

#[test]
fn legacy_assistant_and_reasoning_items_default_to_complete() {
    for payload in [
        json!({
            "kind": "assistant_message",
            "id": "assistant-1",
            "text": "Done",
            "created_at": "2026-08-08T20:00:00Z"
        }),
        json!({
            "kind": "reasoning",
            "id": "reasoning-1",
            "summary": null,
            "content": "Done thinking",
            "created_at": "2026-08-08T20:00:00Z"
        }),
    ] {
        let item: ConversationItem = serde_json::from_value(payload).expect("legacy content item");
        match item {
            ConversationItem::AssistantMessage { lifecycle, .. }
            | ConversationItem::Reasoning { lifecycle, .. } => {
                assert_eq!(lifecycle, ContentLifecycle::Complete)
            }
            _ => panic!("expected assistant-authored content"),
        }
    }
}

#[test]
fn content_lifecycle_serializes_as_stable_snake_case() {
    let item = ConversationItem::AssistantMessage {
        id: "assistant-1".to_string(),
        text: "Partial".to_string(),
        phase: None,
        memory_citation: None,
        citations: Vec::new(),
        lifecycle: ContentLifecycle::Interrupted,
        created_at: chrono::DateTime::parse_from_rfc3339("2026-08-08T20:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc),
    };

    let payload = serde_json::to_value(item).expect("content item");
    assert_eq!(payload["lifecycle"], "interrupted");
}

#[test]
fn reasoning_duration_is_optional_and_round_trips_in_milliseconds() {
    let item: ConversationItem = serde_json::from_value(json!({
        "kind": "reasoning",
        "id": "reasoning-1",
        "summary": "Inspecting",
        "content": "Reading the implementation",
        "duration_ms": 2690,
        "created_at": "2026-08-09T10:00:00Z"
    }))
    .expect("reasoning item");

    assert!(matches!(
        item,
        ConversationItem::Reasoning {
            duration_ms: Some(2690),
            lifecycle: ContentLifecycle::Complete,
            ..
        }
    ));
}
