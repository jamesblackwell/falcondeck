use falcondeck_core::{ContentLifecycle, ConversationItem, WebSearchActionKind};
use serde_json::json;

#[test]
fn web_search_round_trips_provider_action_metadata() {
    let payload = json!({
        "kind": "web_search",
        "id": "search-1",
        "search": {
            "id": "search-1-search",
            "query": "React streaming chat best practices",
            "action_kind": "find_in_page",
            "queries": ["React streaming chat", "AI message parts"],
            "url": "https://example.com/chat",
            "pattern": "streaming"
        },
        "lifecycle": "complete",
        "created_at": "2026-08-09T12:00:00Z"
    });

    let item: ConversationItem = serde_json::from_value(payload.clone()).expect("web search item");
    assert_eq!(
        serde_json::to_value(&item).expect("serialized search"),
        payload
    );
    let ConversationItem::WebSearch { search, .. } = item else {
        panic!("expected web search item")
    };
    assert_eq!(search.action_kind, WebSearchActionKind::new("find_in_page"));
}

#[test]
fn web_search_preserves_future_provider_action() {
    let action: WebSearchActionKind = serde_json::from_value(json!("capturePage")).unwrap();

    assert_eq!(action.as_str(), "capturePage");
}

#[test]
fn legacy_web_search_defaults_to_complete() {
    let item: ConversationItem = serde_json::from_value(json!({
        "kind": "web_search",
        "id": "search-legacy",
        "search": {
            "id": "search-legacy-search",
            "query": "FalconDeck",
            "action_kind": "search",
            "queries": [],
            "url": null,
            "pattern": null
        },
        "created_at": "2026-08-09T12:00:00Z"
    }))
    .expect("legacy web search item");

    assert!(matches!(
        item,
        ConversationItem::WebSearch {
            lifecycle: ContentLifecycle::Complete,
            ..
        }
    ));
}
