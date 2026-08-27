use falcondeck_core::{
    ExtensionContributions, ExtensionUiDocument, ExtensionUiFilterOperator, ExtensionUiNode,
    ExtensionUiTone,
};
use serde_json::json;

#[test]
fn declarative_ui_v1_round_trips_the_public_wire_shape() {
    let value = json!({
        "version": 1,
        "root": {
            "type": "select",
            "id": "colors",
            "label": "Filter by colour",
            "multiple": true,
            "options": [{ "value": "red", "label": "Red", "tone": "red" }],
            "binding": {
                "view": "thread-tags",
                "path": ["tagIds"],
                "operator": "includes_any"
            }
        }
    });

    let document: ExtensionUiDocument =
        serde_json::from_value(value.clone()).expect("public UI fixture should deserialize");

    let ExtensionUiNode::Select {
        options, binding, ..
    } = &document.root
    else {
        panic!("fixture should remain a select node");
    };
    assert_eq!(options[0].tone, Some(ExtensionUiTone::Red));
    assert_eq!(binding.operator, ExtensionUiFilterOperator::IncludesAny);
    assert_eq!(
        serde_json::to_value(document).expect("public UI fixture should serialize"),
        value
    );
}

#[test]
fn declarative_ui_nodes_reject_unknown_fields() {
    let error = serde_json::from_value::<ExtensionUiDocument>(json!({
        "version": 1,
        "root": { "type": "divider", "script": "alert(1)" }
    }))
    .expect_err("extension UI cannot smuggle executable fields");

    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn panel_contributions_use_the_public_camel_case_wire_shape() {
    let contributions: ExtensionContributions = serde_json::from_value(json!({
        "panels": [{
            "id": "attention",
            "title": "Mini Zen",
            "view": "attention-panel",
            "ui": {
                "version": 1,
                "root": { "type": "text", "text": "One thing at a time" }
            }
        }]
    }))
    .expect("panel contribution should deserialize");

    assert_eq!(contributions.panels.len(), 1);
    assert_eq!(contributions.panels[0].view, "attention-panel");
    assert_eq!(contributions.panels[0].icon, None);
    assert!(contributions.sidebar_filters.is_empty());
}

#[test]
fn panel_icons_round_trip_on_the_public_wire_shape() {
    let contributions: ExtensionContributions = serde_json::from_value(json!({
        "panels": [{
            "id": "notes",
            "title": "Notes",
            "view": "notes",
            "icon": "notebook-pen"
        }]
    }))
    .expect("panel icon should deserialize");

    assert_eq!(
        contributions.panels[0].icon.as_deref(),
        Some("notebook-pen")
    );
}

#[test]
fn declarative_ui_omits_absent_optional_fields_on_the_wire() {
    let value = json!({
        "version": 1,
        "root": {
            "type": "stack",
            "children": [
                { "type": "text", "text": "Ready" },
                {
                    "type": "button",
                    "label": "Run",
                    "action": { "actionId": "run", "input": null }
                },
                { "type": "state", "state": "empty", "title": "Nothing here" }
            ]
        }
    });

    let document: ExtensionUiDocument =
        serde_json::from_value(value.clone()).expect("minimal UI should deserialize");

    assert_eq!(
        serde_json::to_value(document).expect("minimal UI should serialize"),
        value
    );
}
