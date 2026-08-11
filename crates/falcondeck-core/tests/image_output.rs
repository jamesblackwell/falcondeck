use falcondeck_core::{ContentLifecycle, ConversationItem};
use serde_json::json;

#[test]
fn image_output_round_trips_structured_asset_metadata() {
    let payload = json!({
        "kind": "image",
        "id": "image-generation-1",
        "title": "Generated image",
        "image": {
            "id": "image-generation-1-image",
            "name": "falcon.png",
            "mime_type": "image/png",
            "url": "https://example.com/falcon.png",
            "local_path": null,
            "alt_text": "A falcon over a dark control deck"
        },
        "lifecycle": "complete",
        "created_at": "2026-08-08T20:00:00Z"
    });

    let item: ConversationItem = serde_json::from_value(payload.clone()).expect("image item");
    assert!(matches!(
        item,
        ConversationItem::Image {
            lifecycle: ContentLifecycle::Complete,
            ..
        }
    ));
    assert_eq!(
        serde_json::to_value(item).expect("serialized image"),
        payload
    );
}

#[test]
fn legacy_image_output_defaults_to_complete() {
    let item: ConversationItem = serde_json::from_value(json!({
        "kind": "image",
        "id": "image-view-1",
        "title": "diagram.png",
        "image": {
            "id": "image-view-1-image",
            "name": "diagram.png",
            "mime_type": "image/png",
            "url": "/tmp/diagram.png",
            "local_path": "/tmp/diagram.png",
            "alt_text": "Viewed image diagram.png"
        },
        "created_at": "2026-08-08T20:00:00Z"
    }))
    .expect("legacy image item");

    assert!(matches!(
        item,
        ConversationItem::Image {
            lifecycle: ContentLifecycle::Complete,
            ..
        }
    ));
}
