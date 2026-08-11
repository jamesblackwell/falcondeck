use falcondeck_core::{AssistantMessagePhase, ContentLifecycle, ConversationItem};
use serde_json::json;

#[test]
fn assistant_metadata_round_trips_provider_citations() {
    let payload = json!({
        "kind": "assistant_message",
        "id": "assistant-1",
        "text": "The reconnect invariant is documented here.",
        "phase": "final_answer",
        "memory_citation": {
            "entries": [{
                "path": "docs/PLATFORM.md",
                "line_start": 170,
                "line_end": 178,
                "note": "Defines replay identity and ordering."
            }],
            "thread_ids": ["thread-earlier"]
        },
        "citations": [{
            "kind": "web_search_result_location",
            "url": "https://react.dev/blog/2024/12/05/react-19",
            "source": null,
            "title": "React v19",
            "cited_text": "React 19 is now stable!"
        }],
        "lifecycle": "complete",
        "created_at": "2026-08-09T12:00:00Z"
    });

    let item: ConversationItem = serde_json::from_value(payload.clone()).expect("assistant item");
    assert!(matches!(
        item,
        ConversationItem::AssistantMessage {
            phase: Some(AssistantMessagePhase::FinalAnswer),
            ref citations,
            lifecycle: ContentLifecycle::Complete,
            ..
        } if citations.len() == 1 && citations[0].title.as_deref() == Some("React v19")
    ));
    assert_eq!(
        serde_json::to_value(item).expect("serialized item"),
        payload
    );
}

#[test]
fn legacy_assistant_metadata_is_optional() {
    let item: ConversationItem = serde_json::from_value(json!({
        "kind": "assistant_message",
        "id": "assistant-legacy",
        "text": "Legacy response",
        "created_at": "2026-08-09T12:00:00Z"
    }))
    .expect("legacy assistant item");

    assert!(matches!(
        item,
        ConversationItem::AssistantMessage {
            phase: None,
            memory_citation: None,
            citations,
            lifecycle: ContentLifecycle::Complete,
            ..
        } if citations.is_empty()
    ));
}
