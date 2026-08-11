use falcondeck_core::{
    ConversationCitation, ConversationCitationLocator, merge_conversation_citations,
};
use serde_json::json;

#[test]
fn citation_round_trips_search_result_location() {
    let citation = ConversationCitation {
        id: Some("answer-1:citation:0".to_string()),
        kind: "search_result_location".to_string(),
        url: None,
        source: Some("https://docs.example.com/guide".to_string()),
        title: Some("Guide".to_string()),
        cited_text: Some("Grounded passage".to_string()),
        locator: Some(ConversationCitationLocator::SearchResult {
            search_result_index: 2,
            start_block_index: 4,
            end_block_index: 6,
        }),
    };

    let restored: ConversationCitation =
        serde_json::from_value(serde_json::to_value(&citation).unwrap()).unwrap();

    assert_eq!(restored, citation);
}

#[test]
fn legacy_citation_defaults_to_no_locator() {
    let citation: ConversationCitation = serde_json::from_value(json!({
        "kind": "web_search_result_location",
        "url": "https://example.com",
        "title": "Example"
    }))
    .unwrap();

    assert_eq!(citation.locator, None);
    assert_eq!(citation.id, None);
}

#[test]
fn streamed_citation_metadata_updates_one_stable_part() {
    let initial = ConversationCitation {
        id: None,
        kind: "web_search_result_location".to_string(),
        url: Some("https://example.com/source".to_string()),
        source: None,
        title: None,
        cited_text: None,
        locator: None,
    };
    let enriched = ConversationCitation {
        id: None,
        kind: "web_search_result_location".to_string(),
        url: Some("https://example.com/source".to_string()),
        source: None,
        title: Some("Example source".to_string()),
        cited_text: Some("Supporting evidence".to_string()),
        locator: None,
    };
    let mut citations = Vec::new();

    merge_conversation_citations(&mut citations, [initial], "answer-1");
    let stable_id = citations[0].id.clone();
    merge_conversation_citations(&mut citations, [enriched], "answer-1");

    assert_eq!(citations.len(), 1);
    assert_eq!(citations[0].id, stable_id);
    assert_eq!(citations[0].title.as_deref(), Some("Example source"));
    assert_eq!(
        citations[0].cited_text.as_deref(),
        Some("Supporting evidence")
    );
}

#[test]
fn repeated_source_keeps_first_seen_order() {
    let citation = |url: &str, title: &str| ConversationCitation {
        id: None,
        kind: "web_search_result_location".to_string(),
        url: Some(url.to_string()),
        source: None,
        title: Some(title.to_string()),
        cited_text: None,
        locator: None,
    };
    let mut citations = Vec::new();

    merge_conversation_citations(
        &mut citations,
        [
            citation("https://one.example", "One"),
            citation("https://two.example", "Two"),
        ],
        "answer-2",
    );
    merge_conversation_citations(
        &mut citations,
        [citation("https://one.example", "One updated")],
        "answer-2",
    );

    assert_eq!(citations.len(), 2);
    assert_eq!(citations[0].title.as_deref(), Some("One updated"));
    assert_eq!(citations[0].id.as_deref(), Some("answer-2:citation:0"));
    assert_eq!(citations[1].id.as_deref(), Some("answer-2:citation:1"));
}
