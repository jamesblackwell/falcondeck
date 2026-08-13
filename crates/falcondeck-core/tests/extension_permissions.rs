use chrono::{TimeZone, Utc};
use falcondeck_core::{ExtensionThreadSummary, ThreadStatus, UpdateExtensionPermissionRequest};

#[test]
fn extension_thread_summaries_use_the_reduced_camel_case_wire_shape() {
    let summary = ExtensionThreadSummary {
        id: "thread-1".to_string(),
        workspace_id: "workspace-1".to_string(),
        title: "Review the release".to_string(),
        status: ThreadStatus::WaitingForInput,
        updated_at: Utc
            .with_ymd_and_hms(2026, 8, 13, 8, 0, 0)
            .single()
            .expect("fixture timestamp"),
        pending_approval_count: 1,
        pending_question_count: 0,
    };

    let value = serde_json::to_value(summary).expect("summary should serialize");
    assert_eq!(
        value,
        serde_json::json!({
            "id": "thread-1",
            "workspaceId": "workspace-1",
            "title": "Review the release",
            "status": "waiting_for_input",
            "updatedAt": "2026-08-13T08:00:00Z",
            "pendingApprovalCount": 1,
            "pendingQuestionCount": 0,
        })
    );
    assert!(value.get("lastMessagePreview").is_none());
    assert!(value.get("items").is_none());
}

#[test]
fn permission_updates_are_explicit_grant_mutations() {
    assert_eq!(
        serde_json::to_value(UpdateExtensionPermissionRequest {
            permission: "threads:read".to_string(),
            granted: true,
        })
        .expect("grant request should serialize"),
        serde_json::json!({ "permission": "threads:read", "granted": true })
    );
}
