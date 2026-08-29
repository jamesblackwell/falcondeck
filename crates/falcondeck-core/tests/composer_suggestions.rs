use falcondeck_core::{ComposerSuggestion, ComposerSuggestionSet};

fn suggestion(description: Option<&str>) -> ComposerSuggestionSet {
    ComposerSuggestionSet {
        actions: vec![ComposerSuggestion {
            id: "continue".to_string(),
            label: "Continue".to_string(),
            description: description.map(str::to_string),
            prompt: "Continue the task".to_string(),
        }],
        preferred_action_id: None,
        turn_id: None,
    }
}

#[test]
fn description_rejects_every_line_break() {
    assert!(suggestion(Some("first\nsecond")).validate().is_err());
    assert!(suggestion(Some("first\rsecond")).validate().is_err());
}
