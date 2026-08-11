use falcondeck_core::{ConversationFileChange, ConversationItem, ToolLifecycle};
use serde_json::json;

#[test]
fn file_change_round_trips_structured_paths_diffs_and_lifecycle() {
    let payload = json!({
        "kind": "file_change",
        "id": "patch-1",
        "changes": [{
            "path": "src/old.rs",
            "change_kind": "update",
            "diff": "@@ -1 +1 @@\n-old\n+new",
            "move_path": "src/new.rs"
        }],
        "status": "completed",
        "lifecycle": "succeeded",
        "created_at": "2026-08-09T10:00:00Z",
        "completed_at": "2026-08-09T10:00:01Z"
    });

    let item: ConversationItem = serde_json::from_value(payload.clone()).expect("file change");
    assert!(matches!(
        &item,
        ConversationItem::FileChange {
            changes,
            lifecycle: ToolLifecycle::Succeeded,
            ..
        } if changes == &vec![ConversationFileChange {
            path: "src/old.rs".to_string(),
            change_kind: "update".to_string(),
            diff: "@@ -1 +1 @@\n-old\n+new".to_string(),
            move_path: Some("src/new.rs".to_string()),
        }]
    ));
    assert_eq!(
        serde_json::to_value(item).expect("serialized file change"),
        payload
    );
}

#[test]
fn legacy_file_change_defaults_unknown_lifecycle_and_missing_move() {
    let item: ConversationItem = serde_json::from_value(json!({
        "kind": "file_change",
        "id": "patch-legacy",
        "changes": [{
            "path": "src/lib.rs",
            "change_kind": "add"
        }],
        "status": "completed",
        "created_at": "2026-08-09T10:00:00Z",
        "completed_at": null
    }))
    .expect("legacy file change");

    assert!(matches!(
        item,
        ConversationItem::FileChange {
            lifecycle: ToolLifecycle::Unknown,
            changes,
            ..
        } if changes[0].diff.is_empty() && changes[0].move_path.is_none()
    ));
}
