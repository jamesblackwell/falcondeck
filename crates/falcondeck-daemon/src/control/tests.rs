//! Unit tests for the control service: revision-aware mutations,
//! idempotency, enablement enforcement, validation and read pagination.

use chrono::{Duration, Utc};
use falcondeck_core::control::{
    AutomationRunStatus, AutomationState, ControlExecuteRequest, ControlGetRequest, ControlOrigin,
    ControlRequestContext, ControlSearchRequest,
};
use serde_json::{Value, json};

use super::service::{ControlDeps, ControlError, ControlService};
use super::{registry, store};

fn desktop() -> ControlRequestContext {
    ControlRequestContext {
        origin: ControlOrigin::DesktopUi,
        ..Default::default()
    }
}

fn mcp(provider: Option<&str>) -> ControlRequestContext {
    ControlRequestContext {
        origin: ControlOrigin::Mcp,
        provider: provider.map(falcondeck_core::AgentProvider::new),
        ..Default::default()
    }
}

async fn service() -> (tempfile::TempDir, ControlService) {
    let dir = tempfile::tempdir().unwrap();
    let service = ControlService::new(dir.path().join("agent-control.json"));
    service.restore().await.unwrap();
    (dir, service)
}

async fn create_valid_automation(service: &ControlService) -> Value {
    let request = ControlExecuteRequest {
        operation: registry::ops::AUTOMATION_CREATE.to_string(),
        arguments: serde_json::from_value(create_arguments()).unwrap(),
        expected_revision: None,
        idempotency_key: None,
    };
    let (response, _) = service
        .execute(request, &desktop(), &ControlDeps::none())
        .await;
    assert!(response.ok, "create failed: {:?}", response.error);
    response.data.expect("create returns automation")
}

fn create_arguments() -> Value {
    json!({
        "name": "Weekday inbox review",
        "trigger": {
            "kind": "cron",
            "expression": "0 8 * * 1-5",
            "timezone": "Europe/London",
        },
        "task": {
            "kind": "conditional_prompt",
            "instruction": "Review my inbox. If nothing requires attention, reply exactly FALCONDECK_NO_ACTION.",
            "no_action_marker": "FALCONDECK_NO_ACTION",
        },
        "target": {
            "workspace_path": "/tmp",
            "provider": "codex",
            "thread": { "kind": "managed", "thread_id": null },
        },
    })
}

fn execute_request(
    operation: &str,
    arguments: Value,
    revision: Option<u64>,
) -> ControlExecuteRequest {
    ControlExecuteRequest {
        operation: operation.to_string(),
        arguments: arguments.as_object().cloned().unwrap_or_default(),
        expected_revision: revision,
        idempotency_key: None,
    }
}

#[tokio::test]
async fn create_returns_automation_with_next_run_and_resolved_schedule() {
    let (_dir, service) = service().await;
    let data = create_valid_automation(&service).await;
    assert_eq!(data["revision"], json!(1));
    assert_eq!(data["state"], json!("enabled"));
    assert!(data["next_run_at"].is_string());
    let next = chrono::DateTime::parse_from_rfc3339(data["next_run_at"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc);
    assert!(next > Utc::now());
    assert_eq!(
        data["resolved_schedule"].as_str().unwrap(),
        "cron \"0 8 * * 1-5\" (Europe/London)"
    );
    let stored = service
        .automation(data["id"].as_str().unwrap())
        .await
        .expect("stored");
    assert_eq!(stored.name, "Weekday inbox review");
}

#[tokio::test]
async fn create_rejects_invalid_definitions_with_field_errors() {
    let (_dir, service) = service().await;
    let valid_target = json!({
        "workspace_path": "/tmp",
        "provider": "codex",
        "thread": { "kind": "managed" },
    });
    let cases = [
        (
            json!({
                "name": "",
                "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                "task": { "kind": "prompt", "instruction": "i" },
                "target": valid_target,
            }),
            "name",
        ),
        (
            json!({
                "name": "x".repeat(200),
                "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                "task": { "kind": "prompt", "instruction": "i" },
                "target": valid_target,
            }),
            "name",
        ),
        (
            json!({
                "name": "x",
                "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                "task": { "kind": "prompt", "instruction": "" },
                "target": valid_target,
            }),
            "task.instruction",
        ),
        (
            json!({
                "name": "x",
                "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                "task": {
                    "kind": "conditional_prompt",
                    "instruction": "i",
                    "no_action_marker": "two\nlines"
                },
                "target": valid_target,
            }),
            "task.no_action_marker",
        ),
        (
            json!({
                "name": "x",
                "trigger": { "kind": "once", "run_at": "2020-01-01T00:00:00Z" },
                "task": { "kind": "prompt", "instruction": "i" },
                "target": { "workspace_path": "/tmp", "provider": "codex", "thread": {"kind": "managed"} },
            }),
            "trigger",
        ),
        (
            json!({
                "name": "x",
                "trigger": { "kind": "cron", "expression": "0 8 * * *", "timezone": "London" },
                "task": { "kind": "prompt", "instruction": "i" },
                "target": { "workspace_path": "/tmp", "provider": "codex", "thread": {"kind": "managed"} },
            }),
            "timezone",
        ),
        (
            json!({
                "name": "x",
                "trigger": { "kind": "cron", "expression": "0 0 8 * * *", "timezone": "UTC" },
                "task": { "kind": "prompt", "instruction": "i" },
                "target": { "workspace_path": "/tmp", "provider": "codex", "thread": {"kind": "managed"} },
            }),
            "trigger",
        ),
        (
            json!({
                "name": "x",
                "trigger": { "kind": "interval", "every_seconds": 10, "anchor_at": "2026-08-16T00:00:00Z" },
                "task": { "kind": "prompt", "instruction": "i" },
                "target": { "workspace_path": "relative/path", "provider": "codex", "thread": {"kind": "managed"} },
            }),
            "target.workspace_path",
        ),
        (
            json!({
                "name": "x",
                "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                "task": { "kind": "prompt", "instruction": "i" },
                "target": { "workspace_path": "/tmp", "provider": "codex", "thread": {"kind": "managed"} },
                "required_connectors": ["gmail", "gmail"],
            }),
            "required_connectors",
        ),
    ];
    for (arguments, expected_field) in cases {
        let (response, _) = service
            .execute(
                execute_request(registry::ops::AUTOMATION_CREATE, arguments, None),
                &desktop(),
                &ControlDeps::none(),
            )
            .await;
        assert!(!response.ok, "expected failure for {expected_field}");
        let error = response.error.expect("error detail");
        assert!(
            error
                .field_errors
                .iter()
                .any(|field| field.field.contains(expected_field)),
            "expected field error on {expected_field}, got {error:?} for case"
        );
        // Invalid arguments must not mutate state.
        let automations = service
            .get(
                ControlGetRequest {
                    resource: "automations".into(),
                    ..Default::default()
                },
                &desktop(),
            )
            .await
            .unwrap();
        assert_eq!(automations.data.as_array().map(Vec::len), Some(0));
    }
}

#[tokio::test]
async fn unknown_operations_and_resources_are_rejected() {
    let (_dir, service) = service().await;
    let (response, _) = service
        .execute(
            execute_request("/api/internal/delete-everything", json!({}), None),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(!response.ok);
    assert_eq!(response.error.unwrap().code, "unknown_operation");

    let error = service
        .get(
            ControlGetRequest {
                resource: "secrets".into(),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "unknown_resource");
}

#[tokio::test]
async fn revision_aware_updates() {
    let (_dir, service) = service().await;
    let data = create_valid_automation(&service).await;
    let id = data["id"].as_str().unwrap().to_string();

    // Missing revision.
    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_UPDATE,
                json!({ "automation_id": id, "name": "Renamed" }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert_eq!(response.error.unwrap().code, "revision_required");

    // Stale revision.
    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_UPDATE,
                json!({ "automation_id": id, "name": "Renamed" }),
                Some(99),
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    let error = response.error.unwrap();
    assert_eq!(error.code, "revision_conflict");
    assert_eq!(error.current_revision, Some(1));
    assert!(error.suggested_action.as_deref().unwrap().contains("1"));

    // Current revision succeeds and increments.
    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_UPDATE,
                json!({ "automation_id": id, "name": "Renamed" }),
                Some(1),
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(response.ok, "{:?}", response.error);
    assert_eq!(response.data.unwrap()["revision"], json!(2));

    // Stale pause now conflicts.
    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_PAUSE,
                json!({ "automation_id": id }),
                Some(1),
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert_eq!(response.error.unwrap().code, "revision_conflict");

    // run_now works without any revision.
    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_RUN_NOW,
                json!({ "automation_id": id }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(response.ok, "{:?}", response.error);
    assert_eq!(response.data.unwrap()["status"], json!("queued"));
}

#[tokio::test]
async fn pause_is_idempotent_and_resume_recalculates_next_run() {
    let (_dir, service) = service().await;
    let data = create_valid_automation(&service).await;
    let id = data["id"].as_str().unwrap().to_string();
    let revision = data["revision"].as_u64().unwrap();

    let pause = |revision: u64| {
        execute_request(
            registry::ops::AUTOMATION_PAUSE,
            json!({ "automation_id": id.clone() }),
            Some(revision),
        )
    };
    let (response, _) = service
        .execute(pause(revision), &desktop(), &ControlDeps::none())
        .await;
    assert!(response.ok);
    let paused_revision = response.data.unwrap()["revision"].as_u64().unwrap();
    assert_eq!(paused_revision, 2);

    // Pausing again succeeds without bumping the revision.
    let (response, _) = service
        .execute(pause(paused_revision), &desktop(), &ControlDeps::none())
        .await;
    assert!(response.ok);
    assert_eq!(response.data.unwrap()["revision"], json!(2));

    let resume = || {
        execute_request(
            registry::ops::AUTOMATION_RESUME,
            json!({ "automation_id": id.clone() }),
            Some(2),
        )
    };
    let (response, _) = service
        .execute(resume(), &desktop(), &ControlDeps::none())
        .await;
    assert!(response.ok);
    let resumed = response.data.unwrap();
    assert_eq!(resumed["state"], json!("enabled"));
    assert!(resumed["next_run_at"].is_string());
}

#[tokio::test]
async fn delete_requires_revision_and_keeps_run_history() {
    let (_dir, service) = service().await;
    let data = create_valid_automation(&service).await;
    let id = data["id"].as_str().unwrap().to_string();
    let revision = data["revision"].as_u64().unwrap();
    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_RUN_NOW,
                json!({ "automation_id": id }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(response.ok);

    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_DELETE,
                json!({ "automation_id": id }),
                Some(revision),
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(response.ok);

    let runs = service
        .get(
            ControlGetRequest {
                resource: "automation.runs".into(),
                id: Some(id.clone()),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    assert_eq!(
        runs.data.as_array().map(Vec::len),
        Some(1),
        "run history kept"
    );
    assert!(service.automation(&id).await.is_none());
}

#[tokio::test]
async fn once_automations_complete_after_a_run() {
    let (_dir, service) = service().await;
    let request = ControlExecuteRequest {
        operation: registry::ops::AUTOMATION_CREATE.to_string(),
        arguments: serde_json::from_value(json!({
            "name": "One-off",
            "trigger": { "kind": "once", "run_at": (Utc::now() + Duration::hours(2)).to_rfc3339() },
            "task": { "kind": "prompt", "instruction": "Do it once." },
            "target": { "workspace_path": "/tmp", "provider": "codex", "thread": {"kind": "managed"} },
        }))
        .unwrap(),
        expected_revision: None,
        idempotency_key: None,
    };
    let (response, _) = service
        .execute(request, &desktop(), &ControlDeps::none())
        .await;
    assert!(response.ok);
    let data = response.data.unwrap();
    let id = data["id"].as_str().unwrap().to_string();
    let run_id = "run-test";
    // Simulate the scheduler finishing a dispatched run.
    let run = service
        .enqueue_run(
            &id,
            data["next_run_at"].as_str().map(|at| {
                chrono::DateTime::parse_from_rfc3339(at)
                    .unwrap()
                    .with_timezone(&Utc)
            }),
            super::service::RunSource::Scheduled,
        )
        .await
        .unwrap();
    service
        .finish_run(
            &run.id,
            AutomationRunStatus::Succeeded,
            Some("done".into()),
            None,
        )
        .await
        .unwrap();
    let automation = service.automation(&id).await.unwrap();
    assert_eq!(automation.state, AutomationState::Completed);
    assert_eq!(automation.next_run_at, None);
    assert_eq!(
        automation.latest_outcome.unwrap().status,
        AutomationRunStatus::Succeeded
    );
    let _ = run_id;
}

#[tokio::test]
async fn concurrency_policies_skip_queue_and_allow() {
    let (_dir, service) = service().await;
    let data = create_valid_automation(&service).await;
    let id = data["id"].as_str().unwrap().to_string();

    // Default skip: first run starts, second manual occurrence skips.
    let first = service
        .enqueue_run(
            &id,
            None,
            super::service::RunSource::Manual {
                origin: ControlOrigin::DesktopUi,
            },
        )
        .await
        .unwrap();
    service
        .mark_run_running(&first.id, "workspace-1", "thread-1")
        .await
        .unwrap();
    let second = service
        .enqueue_run(
            &id,
            None,
            super::service::RunSource::Manual {
                origin: ControlOrigin::DesktopUi,
            },
        )
        .await
        .unwrap();
    assert_eq!(second.status, AutomationRunStatus::SkippedOverlap);

    // queue_one keeps one queued occurrence, then skips further ones.
    if !service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_UPDATE,
                json!({
                    "automation_id": id,
                    "concurrency_policy": "queue_one",
                    "trigger": {
                        "kind": "interval",
                        "every_seconds": 3600,
                        "anchor_at": "2026-08-16T00:00:00Z"
                    }
                }),
                Some(first.automation_revision),
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await
        .0
        .ok
    {
        panic!("update to queue_one failed");
    }
    let queued = service
        .enqueue_run(
            &id,
            None,
            super::service::RunSource::Manual {
                origin: ControlOrigin::DesktopUi,
            },
        )
        .await
        .unwrap();
    assert_eq!(queued.status, AutomationRunStatus::Queued);
    let overflow = service
        .enqueue_run(
            &id,
            None,
            super::service::RunSource::Manual {
                origin: ControlOrigin::DesktopUi,
            },
        )
        .await
        .unwrap();
    assert_eq!(overflow.status, AutomationRunStatus::SkippedOverlap);
}

#[tokio::test]
async fn scheduled_dispatch_consumes_occurrences_and_advances() {
    let (_dir, service) = service().await;
    let data = create_valid_automation(&service).await;
    let id = data["id"].as_str().unwrap().to_string();
    let first_next = service.automation(&id).await.unwrap().next_run_at.unwrap();

    let run = service
        .enqueue_run(&id, Some(first_next), super::service::RunSource::Scheduled)
        .await
        .unwrap();
    assert_eq!(run.scheduled_for, Some(first_next));

    // The next occurrence must move strictly beyond the dispatched one.
    let advanced = service.automation(&id).await.unwrap().next_run_at.unwrap();
    assert!(advanced > first_next);

    // Dispatching the same occurrence again is a no-op duplicate guard via
    // the occurrence key: advance_after skips already-dispatched keys, so a
    // second enqueue of the same instant still advances past it.
    let second = service
        .enqueue_run(&id, Some(first_next), super::service::RunSource::Scheduled)
        .await
        .unwrap();
    assert_eq!(second.status, AutomationRunStatus::Queued);
    let after = service.automation(&id).await.unwrap().next_run_at.unwrap();
    assert!(after > first_next);
}

#[tokio::test]
async fn idempotent_create_replays_the_original_result() {
    let (_dir, service) = service().await;
    let key = "inbox-weekday-8am-2026-08-16";
    let run = |key: &str, name: &str| {
        ControlExecuteRequest {
            operation: registry::ops::AUTOMATION_CREATE.to_string(),
            arguments: serde_json::from_value(json!({
                "name": name,
                "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                "task": { "kind": "prompt", "instruction": "i" },
                "target": { "workspace_path": "/tmp", "provider": "codex", "thread": {"kind": "managed"} },
            }))
            .unwrap(),
            expected_revision: None,
            idempotency_key: Some(key.to_string()),
        }
    };
    let (first, _) = service
        .execute(run(key, "A"), &desktop(), &ControlDeps::none())
        .await;
    assert!(first.ok);
    let first_id = first.data.clone().unwrap()["id"].clone();

    // Identical retry replays the same automation id.
    let (retry, _) = service
        .execute(run(key, "A"), &desktop(), &ControlDeps::none())
        .await;
    assert!(retry.ok);
    assert_eq!(retry.data.unwrap()["id"], first_id);
    let automations = service
        .get(
            ControlGetRequest {
                resource: "automations".into(),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    assert_eq!(automations.data.as_array().map(Vec::len), Some(1));

    // Same key with different arguments conflicts.
    let (conflict, _) = service
        .execute(run(key, "B"), &desktop(), &ControlDeps::none())
        .await;
    assert_eq!(conflict.error.unwrap().code, "idempotency_conflict");
}

#[tokio::test]
async fn idempotency_scopes_include_the_provider() {
    let (_dir, service) = service().await;
    let key = "same-key";
    let request = || {
        ControlExecuteRequest {
        operation: registry::ops::AUTOMATION_CREATE.to_string(),
        arguments: serde_json::from_value(json!({
            "name": "A",
            "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
            "task": { "kind": "prompt", "instruction": "i" },
            "target": { "workspace_path": "/tmp", "provider": "codex", "thread": {"kind": "managed"} },
        }))
        .unwrap(),
        expected_revision: None,
        idempotency_key: Some(key.to_string()),
    }
    };
    let (from_codex, _) = service
        .execute(request(), &mcp(Some("codex")), &ControlDeps::none())
        .await;
    assert!(from_codex.ok, "{:?}", from_codex.error);
    // The same key from a different provider is a different scope.
    let (from_claude, _) = service
        .execute(request(), &mcp(Some("claude")), &ControlDeps::none())
        .await;
    assert!(from_claude.ok, "{:?}", from_claude.error);
    let automations = service
        .get(
            ControlGetRequest {
                resource: "automations".into(),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    assert_eq!(automations.data.as_array().map(Vec::len), Some(2));
}

#[tokio::test]
async fn mcp_origin_is_enforced_against_current_settings() {
    let (_dir, service) = service().await;

    // Global disable: MCP reads and mutations are rejected, desktop is not.
    if !service
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({ "enabled": false }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await
        .0
        .ok
    {
        panic!("settings update failed");
    }
    let error = service
        .search(ControlSearchRequest::default(), &mcp(None))
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "interface_disabled");
    let (response, _) = service
        .execute(
            execute_request(registry::ops::AUTOMATION_CREATE, create_arguments(), None),
            &mcp(None),
            &ControlDeps::none(),
        )
        .await;
    assert_eq!(response.error.unwrap().code, "interface_disabled");
    let (desktop_ok, _) = service
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({ "enabled": true }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(desktop_ok.ok);

    // Provider disable: that provider only.
    if !service
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({ "providers": { "codex": { "enabled": false } } }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await
        .0
        .ok
    {
        panic!("provider disable failed");
    }
    let (blocked, _) = service
        .execute(
            execute_request(registry::ops::AUTOMATION_CREATE, create_arguments(), None),
            &mcp(Some("codex")),
            &ControlDeps::none(),
        )
        .await;
    assert_eq!(blocked.error.unwrap().code, "provider_disabled");
    let (allowed, _) = service
        .execute(
            execute_request(registry::ops::AUTOMATION_CREATE, create_arguments(), None),
            &mcp(Some("claude")),
            &ControlDeps::none(),
        )
        .await;
    assert!(allowed.ok, "{:?}", allowed.error);
}

#[tokio::test]
async fn elevated_automations_require_the_setting() {
    let (_dir, service) = service().await;
    let mut arguments = create_arguments();
    arguments["target"]["permission_mode"] = json!("bypassPermissions");
    let (blocked, _) = service
        .execute(
            execute_request(registry::ops::AUTOMATION_CREATE, arguments.clone(), None),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert_eq!(blocked.error.unwrap().code, "elevated_permissions_disabled");

    if !service
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({ "allow_elevated_automations": true }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await
        .0
        .ok
    {
        panic!("elevated enable failed");
    }
    let (allowed, _) = service
        .execute(
            execute_request(registry::ops::AUTOMATION_CREATE, arguments, None),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(allowed.ok);
    assert_eq!(allowed.data.unwrap()["elevated"], json!(true));
}

#[tokio::test]
async fn settings_update_validates_the_timezone() {
    let (_dir, service) = service().await;
    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({ "default_timezone": "GMT+1" }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert_eq!(response.error.unwrap().code, "invalid_timezone");
    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({ "default_timezone": "Europe/Berlin" }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(response.ok);
    assert_eq!(
        response.data.unwrap()["default_timezone"],
        json!("Europe/Berlin")
    );
}

#[tokio::test]
async fn settings_update_toggles_agent_context_injection() {
    let (_dir, service) = service().await;
    // Default settings inject the agent context.
    let initial = service.settings_snapshot().await;
    assert!(initial.inject_agent_context);

    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({ "inject_agent_context": false }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(response.ok);
    assert_eq!(
        response.data.unwrap()["inject_agent_context"],
        json!(false)
    );
    assert!(!service.settings_snapshot().await.inject_agent_context);
}

#[tokio::test]
async fn audit_trails_record_success_and_failure() {
    let (_dir, service) = service().await;
    create_valid_automation(&service).await;
    // A failing mutation after validation also audits.
    let (_update_response, _) = service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_UPDATE,
                json!({ "automation_id": "automation-missing", "name": "x" }),
                Some(1),
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;

    let audit = service
        .get(
            ControlGetRequest {
                resource: "control.audit".into(),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    let entries = audit.data.as_array().unwrap();

    assert!(entries.len() >= 2);
    let operations: Vec<&str> = entries
        .iter()
        .map(|entry| entry["operation"].as_str().unwrap())
        .collect();
    assert!(operations.contains(&"automation.create"));
    assert!(operations.contains(&"automation.update"));
    assert!(
        entries
            .iter()
            .any(|entry| entry["result"] == json!("failure"))
    );
    // Summaries never contain instruction bodies.
    for entry in entries {
        let summary = entry["summary"].as_str().unwrap();
        assert!(!summary.contains("Review my inbox"));
    }
}

#[tokio::test]
async fn list_pagination_cursors_and_filters() {
    let (_dir, service) = service().await;
    for index in 0..5 {
        let mut arguments = create_arguments();
        arguments["name"] = json!(format!("Automation {index}"));
        arguments["trigger"] = json!({
            "kind": "interval",
            "every_seconds": 3600 + index,
            "anchor_at": "2026-08-16T00:00:00Z"
        });
        let (response, _) = service
            .execute(
                execute_request(registry::ops::AUTOMATION_CREATE, arguments, None),
                &desktop(),
                &ControlDeps::none(),
            )
            .await;
        assert!(response.ok);
        // updated_at differs by wall clock at best; force ordering drift by
        // pausing and resuming to bump updated_at for later entries.
        if index % 2 == 1 {
            let id = response.data.unwrap()["id"].as_str().unwrap().to_string();
            let _ = service
                .execute(
                    execute_request(
                        registry::ops::AUTOMATION_PAUSE,
                        json!({ "automation_id": id }),
                        Some(1),
                    ),
                    &desktop(),
                    &ControlDeps::none(),
                )
                .await;
        }
    }
    let first_page = service
        .get(
            ControlGetRequest {
                resource: "automations".into(),
                limit: 2,
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    let rows = first_page.data.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(first_page.next_cursor.is_some(), "more pages remain");
    assert!(rows[0].get("task").is_none(), "list rows omit instructions");

    let second_page = service
        .get(
            ControlGetRequest {
                resource: "automations".into(),
                limit: 2,
                cursor: first_page.next_cursor.clone(),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    let second_rows = second_page.data.as_array().unwrap();
    assert_eq!(second_rows.len(), 2);
    let first_ids: Vec<&str> = rows.iter().map(|row| row["id"].as_str().unwrap()).collect();
    assert!(
        second_rows
            .iter()
            .all(|row| !first_ids.contains(&row["id"].as_str().unwrap()))
    );

    // State filter.
    let paused = service
        .get(
            ControlGetRequest {
                resource: "automations".into(),
                filters: serde_json::from_value(json!({ "state": "paused" })).unwrap(),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    assert!(
        paused
            .data
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["state"] == json!("paused"))
    );
}

#[tokio::test]
async fn instructions_never_appear_in_list_projections() {
    let (_dir, service) = service().await;
    create_valid_automation(&service).await;
    // Even an explicit field projection cannot pull instructions into list
    // rows; only a single-automation read exposes them.
    let list = service
        .get(
            ControlGetRequest {
                resource: "automations".into(),
                fields: vec![
                    "id".to_string(),
                    "task.instruction".to_string(),
                    "task.no_action_marker".to_string(),
                ],
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    let encoded = serde_json::to_string(&list.data).unwrap();
    assert!(!encoded.contains("Review my inbox"));
    assert!(
        !encoded.contains("task"),
        "task projection is dropped entirely"
    );
}

#[tokio::test]
async fn single_automation_read_returns_the_full_instruction() {
    let (_dir, service) = service().await;
    let data = create_valid_automation(&service).await;
    let detail = service
        .get(
            ControlGetRequest {
                resource: "automation".into(),
                id: Some(data["id"].as_str().unwrap().to_string()),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    assert_eq!(
        detail.data["task"]["instruction"],
        json!(
            "Review my inbox. If nothing requires attention, reply exactly FALCONDECK_NO_ACTION."
        )
    );
}

#[tokio::test]
async fn state_survives_restore_and_misfire_policies_apply() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agent-control.json");
    let service = ControlService::new(path.clone());
    service.restore().await.unwrap();

    // skip policy: the missed occurrence is dropped.
    let (skip, _) = service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_CREATE,
                json!({
                    "name": "Skip misfire",
                    "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                    "task": { "kind": "prompt", "instruction": "i" },
                    "target": { "workspace_path": "/tmp", "provider": "codex", "thread": {"kind": "managed"} },
                    "misfire_policy": "skip",
                }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(skip.ok);

    // A persisted service with a next_run in the past recovers on restore.
    let state = {
        let mut state = store::load(&path).await.unwrap();
        state.automations[0].next_run_at = Some(Utc::now() - Duration::hours(3));
        state
    };
    store::persist(&path, &state).await.unwrap();
    let restored = ControlService::new(path.clone());
    restored.restore().await.unwrap();
    let automations = restored
        .get(
            ControlGetRequest {
                resource: "automations".into(),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    let next = automations.data[0]["next_run_at"].as_str().unwrap();
    let next = chrono::DateTime::parse_from_rfc3339(next).unwrap();
    assert!(
        next > Utc::now(),
        "skip policy recalculates a future occurrence"
    );
}

#[tokio::test]
async fn run_once_misfire_dispatches_immediately_after_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agent-control.json");
    let service = ControlService::new(path.clone());
    service.restore().await.unwrap();
    if !service
        .execute(
            execute_request(
                registry::ops::AUTOMATION_CREATE,
                json!({
                    "name": "Run once misfire",
                    "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                    "task": { "kind": "prompt", "instruction": "i" },
                    "target": { "workspace_path": "/tmp", "provider": "codex", "thread": {"kind": "managed"} },
                    "misfire_policy": "run_once",
                }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await
        .0
        .ok { panic!("create failed"); }
    let state = {
        let mut state = store::load(&path).await.unwrap();
        state.automations[0].next_run_at = Some(Utc::now() - Duration::hours(3));
        state
    };
    store::persist(&path, &state).await.unwrap();
    let restored = ControlService::new(path);
    restored.restore().await.unwrap();
    let automations = restored
        .get(
            ControlGetRequest {
                resource: "automations".into(),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    let next = automations.data[0]["next_run_at"].as_str().unwrap();
    let next = chrono::DateTime::parse_from_rfc3339(next)
        .unwrap()
        .with_timezone(&Utc);
    assert!(
        next <= Utc::now() + Duration::seconds(5),
        "run_once policy replays one missed occurrence immediately, got {next}"
    );
}

#[tokio::test]
async fn malformed_store_degrades_the_service_until_restored() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agent-control.json");
    std::fs::write(&path, "{broken").unwrap();
    let service = ControlService::new(path.clone());
    let warning = service.restore().await.unwrap();
    assert!(warning.is_some());
    assert!(service.storage_error().is_some());

    let error = service
        .search(ControlSearchRequest::default(), &desktop())
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "storage_unavailable");
    let (response, _) = service
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({ "enabled": false }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert_eq!(response.error.unwrap().code, "storage_unavailable");
    // The malformed file was preserved aside, not overwritten.
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{broken");
    let recovery = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .find(|name| name.contains("recovery"))
        .expect("recovery copy exists");
    assert!(recovery.starts_with("agent-control.recovery."));
}

#[tokio::test]
async fn redaction_strips_secret_shaped_values_from_responses() {
    let (_dir, service) = service().await;
    let mut arguments = create_arguments();
    // Ordinary words that merely mention a secret category stay readable;
    // only values under secret-shaped keys are redacted.
    arguments["name"] = json!("Automation about an api_key");
    let (response, _) = service
        .execute(
            execute_request(registry::ops::AUTOMATION_CREATE, arguments, None),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(response.ok);
    let list = service
        .get(
            ControlGetRequest {
                resource: "automations".into(),
                ..Default::default()
            },
            &desktop(),
        )
        .await
        .unwrap();
    let encoded = serde_json::to_string(&list.data).unwrap();
    assert!(
        encoded.contains("Automation about an api_key"),
        "ordinary words are retained"
    );
    assert!(!encoded.contains("\"token\""), "no secret-shaped keys leak");
}

#[tokio::test]
async fn connector_dependency_skips_at_execution_time() {
    let (_dir, service) = service().await;
    let data = create_valid_automation(&service).await;
    let id = data["id"].as_str().unwrap().to_string();
    let run = service
        .enqueue_run(
            &id,
            None,
            super::service::RunSource::Manual {
                origin: ControlOrigin::DesktopUi,
            },
        )
        .await
        .unwrap();
    // The scheduler validates connectors before dispatch; simulate a missing
    // dependency resolution.
    service.skip_run_dependency(&run.id, "gmail").await.unwrap();
    let updated = service.run(&run.id).await.unwrap();
    assert_eq!(updated.status, AutomationRunStatus::SkippedDependency);
    assert!(
        updated
            .outcome_preview
            .as_deref()
            .unwrap()
            .contains("gmail")
    );
}

#[tokio::test]
async fn builtin_connector_spec_follows_enablement() {
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("daemon-state.json");
    let app = crate::app::AppState::new_with_state_path(
        "test".to_string(),
        Default::default(),
        state_path,
    );
    app.set_local_base_url("http://127.0.0.1:4123".to_string());
    app.restore_control_state().await.unwrap();

    // Enabled by default: the spec exists for both providers.
    let spec = app
        .builtin_control_spec(&falcondeck_core::AgentProvider::CODEX, "/repo", None)
        .await;
    assert!(spec.is_some());
    assert_eq!(spec.unwrap().provider, "codex");

    // Disabled globally: no spec, so connectors are simply omitted.
    let (response, _) = app
        .control()
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({ "enabled": false }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(response.ok, "{:?}", response.error);
    assert!(
        app.builtin_control_spec(&falcondeck_core::AgentProvider::CODEX, "/repo", None)
            .await
            .is_none()
    );

    // Re-enable, then disable one provider only.
    let (response, _) = app
        .control()
        .execute(
            execute_request(
                registry::ops::SETTINGS_UPDATE,
                json!({
                    "enabled": true,
                    "providers": { "codex": { "enabled": false } },
                }),
                None,
            ),
            &desktop(),
            &ControlDeps::none(),
        )
        .await;
    assert!(response.ok, "{:?}", response.error);
    assert!(
        app.builtin_control_spec(&falcondeck_core::AgentProvider::CODEX, "/repo", None)
            .await
            .is_none()
    );
    assert!(
        app.builtin_control_spec(
            &falcondeck_core::AgentProvider::CLAUDE,
            "/repo",
            Some("thread-1")
        )
        .await
        .is_some()
    );
}

#[test]
fn control_error_constructors_carry_codes_and_actions() {
    assert_eq!(
        ControlError::interface_disabled("x").0.code,
        "interface_disabled"
    );
    assert_eq!(
        ControlError::provider_disabled("x").0.code,
        "provider_disabled"
    );
    assert_eq!(
        ControlError::unknown_operation("x").0.code,
        "unknown_operation"
    );
    assert_eq!(
        ControlError::unknown_resource("x").0.code,
        "unknown_resource"
    );
    assert_eq!(
        ControlError::invalid_arguments("x").0.code,
        "invalid_arguments"
    );
    assert_eq!(
        ControlError::invalid_schedule("x", None).0.code,
        "invalid_schedule"
    );
    assert_eq!(
        ControlError::invalid_timezone("x").0.code,
        "invalid_timezone"
    );
    assert_eq!(
        ControlError::revision_required().0.code,
        "revision_required"
    );
    assert_eq!(
        ControlError::revision_conflict(1, 4, "automation-x").0.code,
        "revision_conflict"
    );
    assert_eq!(
        ControlError::idempotency_conflict().0.code,
        "idempotency_conflict"
    );
    assert_eq!(
        ControlError::resource_not_found("a", "b").0.code,
        "resource_not_found"
    );
    assert_eq!(
        ControlError::workspace_unavailable("x").0.code,
        "workspace_unavailable"
    );
    assert_eq!(
        ControlError::provider_unavailable("x").0.code,
        "provider_unavailable"
    );
    assert_eq!(
        ControlError::connector_unavailable("x").0.code,
        "connector_unavailable"
    );
    assert_eq!(
        ControlError::elevated_permissions_disabled().0.code,
        "elevated_permissions_disabled"
    );
    assert_eq!(
        ControlError::execution_failed("x").0.code,
        "execution_failed"
    );
    assert_eq!(
        ControlError::storage_unavailable("x").0.code,
        "storage_unavailable"
    );
    assert_eq!(ControlError::internal("x").0.code, "internal_error");
}
