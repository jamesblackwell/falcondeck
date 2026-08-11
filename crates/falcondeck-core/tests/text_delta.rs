use falcondeck_core::{TextDeltaTarget, UnifiedEvent};
use serde_json::json;

#[test]
fn text_delta_round_trips_offsets_and_target() {
    let event = UnifiedEvent::Text {
        item_id: "assistant-1".to_string(),
        delta: "🙂".to_string(),
        target: TextDeltaTarget::AssistantText,
        start_offset: Some(3),
        end_offset: Some(5),
    };

    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "type": "text",
            "item_id": "assistant-1",
            "delta": "🙂",
            "target": "assistant_text",
            "start_offset": 3,
            "end_offset": 5
        })
    );
}

#[test]
fn legacy_text_delta_defaults_to_safe_unanchored_assistant_text() {
    let event: UnifiedEvent = serde_json::from_value(json!({
        "type": "text",
        "item_id": "assistant-1",
        "delta": "legacy"
    }))
    .unwrap();

    assert_eq!(
        event,
        UnifiedEvent::Text {
            item_id: "assistant-1".to_string(),
            delta: "legacy".to_string(),
            target: TextDeltaTarget::AssistantText,
            start_offset: None,
            end_offset: None,
        }
    );
}
