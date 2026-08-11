use falcondeck_core::{ToolCallDisplay, ToolLifecycle, ToolProviderOutputSummary, ToolTestSummary};
use serde_json::json;

#[test]
fn legacy_tool_display_without_lifecycle_defaults_to_unknown() {
    let display: ToolCallDisplay = serde_json::from_value(json!({
        "is_read_only": true,
        "has_side_effect": false,
        "is_error": false,
        "artifact_kind": "none",
        "activity_kind": "read",
        "history_mode": "summary",
        "summary_hint": null
    }))
    .expect("legacy tool display");

    assert_eq!(display.lifecycle, ToolLifecycle::Unknown);
    assert!(display.provider_output_summary.is_none());
}

#[test]
fn provider_output_summary_round_trips_without_copying_provider_payloads() {
    let display = ToolCallDisplay {
        provider_output_summary: Some(ToolProviderOutputSummary {
            text_blocks: 2,
            images: 1,
            audio: 1,
            resource_links: 3,
            embedded_resources: 2,
            structured_results: 1,
        }),
        ..ToolCallDisplay::default()
    };

    let payload = serde_json::to_value(&display).expect("provider output summary payload");
    let restored: ToolCallDisplay =
        serde_json::from_value(payload).expect("provider output summary display");
    assert_eq!(restored, display);
}

#[test]
fn tool_lifecycle_serializes_as_stable_snake_case() {
    let display = ToolCallDisplay {
        lifecycle: ToolLifecycle::AwaitingApproval,
        ..ToolCallDisplay::default()
    };

    let payload = serde_json::to_value(display).expect("tool display");
    assert_eq!(payload["lifecycle"], "awaiting_approval");
}

#[test]
fn structured_test_summary_round_trips_without_breaking_legacy_display() {
    let display = ToolCallDisplay {
        artifact_kind: falcondeck_core::ToolArtifactKind::Test,
        activity_kind: falcondeck_core::ToolActivityKind::Test,
        test_summary: Some(ToolTestSummary {
            framework: Some("vitest".to_string()),
            total: Some(43),
            passed: Some(42),
            failed: Some(1),
            skipped: Some(0),
            suites_total: Some(5),
            suites_passed: Some(4),
            suites_failed: Some(1),
            duration_ms: Some(1_240),
        }),
        ..ToolCallDisplay::default()
    };

    let payload = serde_json::to_value(&display).expect("test summary payload");
    let restored: ToolCallDisplay = serde_json::from_value(payload).expect("test summary display");
    assert_eq!(restored, display);
}
