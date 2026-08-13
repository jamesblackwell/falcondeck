use falcondeck_core::{
    ExtensionUiDocument, ExtensionUiFilterOperator, ExtensionUiNode, ExtensionUiTone,
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
