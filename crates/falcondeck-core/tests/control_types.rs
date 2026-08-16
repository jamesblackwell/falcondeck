use falcondeck_core::AgentProvider;
use falcondeck_core::control::{
    AgentControlSettings, Automation, AutomationConcurrencyPolicy, AutomationMisfirePolicy,
    AutomationRun, AutomationRunStatus, AutomationState, AutomationTask, AutomationThreadTarget,
    AutomationTrigger, ControlAuditEntry, ControlDomain, ControlErrorDetail, ControlExecuteRequest,
    ControlExecuteResponse, ControlGetRequest, ControlOrigin, ControlRequestContext,
    ControlSearchRequest, ControlStateChanged, FieldError, SearchDetail,
};
use serde_json::json;

fn automation_payload() -> serde_json::Value {
    json!({
        "id": "automation-9fc78b39",
        "revision": 3,
        "name": "Weekday inbox review",
        "description": null,
        "trigger": {
            "kind": "cron",
            "expression": "0 8 * * 1-5",
            "timezone": "Europe/London",
        },
        "task": {
            "kind": "conditional_prompt",
            "instruction": "Review my inbox.",
            "no_action_marker": "FALCONDECK_NO_ACTION",
        },
        "target": {
            "workspace_path": "/Users/james/Code/quizgecko",
            "provider": "codex",
            "thread": { "kind": "managed", "thread_id": null },
            "model_id": null,
            "permission_mode": null,
            "sandbox_mode": "workspace-write",
            "selected_skills": [],
        },
        "state": "enabled",
        "concurrency_policy": "skip",
        "misfire_policy": "skip",
        "elevated": false,
        "required_connectors": ["gmail"],
        "created_at": "2026-08-16T14:00:00Z",
        "updated_at": "2026-08-16T14:22:10Z",
        "next_run_at": "2026-08-17T07:00:00Z",
        "last_run_at": null,
        "latest_outcome": null,
    })
}

#[test]
fn automation_round_trips_every_trigger_and_task_kind() {
    let automation: Automation =
        serde_json::from_value(automation_payload()).expect("cron automation parses");
    assert_eq!(automation.revision, 3);
    assert!(matches!(
        automation.trigger,
        AutomationTrigger::Cron {
            ref expression,
            ref timezone,
        } if expression == "0 8 * * 1-5" && timezone == "Europe/London"
    ));
    assert!(matches!(
        automation.task,
        AutomationTask::ConditionalPrompt { ref no_action_marker, .. }
            if no_action_marker == "FALCONDECK_NO_ACTION"
    ));
    assert_eq!(automation.target.provider, AgentProvider::CODEX);
    assert!(matches!(
        automation.target.thread,
        AutomationThreadTarget::Managed { thread_id: None }
    ));
    let encoded = serde_json::to_value(&automation).expect("automation encodes");
    assert_eq!(encoded, automation_payload());

    let once: Automation = serde_json::from_value(json!({
        "id": "automation-1",
        "revision": 1,
        "name": "Release checklist",
        "trigger": { "kind": "once", "run_at": "2026-08-17T10:00:00+01:00" },
        "task": { "kind": "prompt", "instruction": "Review the checklist." },
        "target": {
            "workspace_path": "/repo",
            "provider": "claude",
            "thread": { "kind": "new_each_run" },
        },
        "state": "enabled",
        "concurrency_policy": "allow",
        "misfire_policy": "run_once",
        "created_at": "2026-08-16T14:00:00Z",
        "updated_at": "2026-08-16T14:00:00Z",
        "next_run_at": "2026-08-17T09:00:00Z",
    }))
    .expect("once automation parses");
    assert!(matches!(once.trigger, AutomationTrigger::Once { .. }));
    // Offsets are normalised to UTC on the wire.
    assert_eq!(
        serde_json::to_value(&once).unwrap()["trigger"]["run_at"],
        json!("2026-08-17T09:00:00Z")
    );

    let interval: Automation = serde_json::from_value(json!({
        "id": "automation-2",
        "revision": 1,
        "name": "Deploy check",
        "trigger": {
            "kind": "interval",
            "every_seconds": 1800,
            "anchor_at": "2026-08-16T00:00:00Z",
        },
        "task": { "kind": "prompt", "instruction": "Check deployments." },
        "target": {
            "workspace_path": "/repo",
            "provider": "codex",
            "thread": { "kind": "existing", "thread_id": "thread-7" },
        },
        "state": "paused",
        "concurrency_policy": "queue_one",
        "misfire_policy": "skip",
        "created_at": "2026-08-16T14:00:00Z",
        "updated_at": "2026-08-16T14:00:00Z",
        "next_run_at": null,
    }))
    .expect("interval automation parses");
    assert!(matches!(
        interval.trigger,
        AutomationTrigger::Interval {
            every_seconds: 1800,
            ..
        }
    ));
    assert_eq!(interval.state, AutomationState::Paused);
    assert_eq!(
        interval.concurrency_policy,
        AutomationConcurrencyPolicy::QueueOne
    );
    assert_eq!(interval.misfire_policy, AutomationMisfirePolicy::Skip);
}

#[test]
fn automation_rejects_unknown_and_missing_fields() {
    let mut payload = automation_payload();
    payload["task"]["surprise"] = json!(true);
    assert!(serde_json::from_value::<Automation>(payload).is_err());

    let mut payload = automation_payload();
    payload.as_object_mut().unwrap().remove("state");
    assert!(serde_json::from_value::<Automation>(payload).is_err());
}

#[test]
fn once_trigger_requires_an_rfc3339_offset() {
    // A naive timestamp without an offset must not be silently interpreted.
    let mut payload = automation_payload();
    payload["trigger"] = json!({ "kind": "once", "run_at": "2026-08-17T10:00:00" });
    assert!(serde_json::from_value::<Automation>(payload).is_err());
}

#[test]
fn run_record_and_status_round_trip() {
    let run: AutomationRun = serde_json::from_value(json!({
        "id": "run-1",
        "automation_id": "automation-9fc78b39",
        "automation_name": "Weekday inbox review",
        "automation_revision": 3,
        "status": "succeeded_no_action",
        "scheduled_for": "2026-08-17T07:00:00Z",
        "queued_at": "2026-08-17T07:00:01Z",
        "started_at": "2026-08-17T07:00:02Z",
        "finished_at": "2026-08-17T07:01:02Z",
        "runtime_workspace_id": "workspace-1",
        "thread_id": "thread-1",
        "turn_id": "turn-1",
        "outcome_preview": "FALCONDECK_NO_ACTION",
        "error": null,
    }))
    .expect("run parses");
    assert_eq!(run.status, AutomationRunStatus::SucceededNoAction);
    assert!(run.status.is_terminal());
    assert!(!AutomationRunStatus::Running.is_terminal());
    assert!(!AutomationRunStatus::Queued.is_terminal());
}

#[test]
fn settings_default_and_provider_overrides_round_trip() {
    let settings = AgentControlSettings::default();
    assert!(settings.enabled);
    assert!(!settings.allow_elevated_automations);
    assert!(settings.confirmation_policy.destructive_operations);

    let encoded: AgentControlSettings = serde_json::from_value(json!({
        "enabled": true,
        "providers": {
            "claude": { "enabled": false },
            "codex": { "enabled": true },
        },
        "default_timezone": "Europe/Berlin",
        "allow_elevated_automations": true,
        "confirmation_policy": {
            "destructive_operations": false,
            "sensitive_operations": true,
        },
    }))
    .expect("settings parse");
    assert!(!encoded.providers[&AgentProvider::CLAUDE].enabled);
    assert!(encoded.providers[&AgentProvider::CODEX].enabled);
}

#[test]
fn audit_entry_and_context_round_trip() {
    let entry: ControlAuditEntry = serde_json::from_value(json!({
        "id": "audit-1",
        "occurred_at": "2026-08-16T14:22:10Z",
        "context": {
            "origin": "mcp",
            "provider": "codex",
            "workspace_path": "/Users/james/Code/quizgecko",
            "thread_id": null,
            "device_id": null,
        },
        "operation": "automation.create",
        "resource_type": "automation",
        "resource_id": "automation-9fc78b39",
        "result": "success",
        "summary": "Created automation 'Weekday inbox review'",
    }))
    .expect("audit entry parses");
    assert_eq!(entry.context.origin, ControlOrigin::Mcp);
    assert_eq!(
        entry.context.provider.as_ref().map(AgentProvider::as_str),
        Some("codex")
    );
    assert_eq!(entry.result, falcondeck_core::control::AuditResult::Success);
    // Omitted optional context falls back to the desktop default.
    let minimal: ControlRequestContext =
        serde_json::from_value(json!({ "origin": "desktop_ui" })).expect("minimal context");
    assert_eq!(minimal, ControlRequestContext::default());
}

#[test]
fn request_envelopes_round_trip_and_default_limits() {
    let search: ControlSearchRequest =
        serde_json::from_value(json!({ "query": "create a scheduled task" }))
            .expect("search parses");
    assert_eq!(search.limit, 8);
    assert_eq!(search.detail, SearchDetail::Summary);
    assert!(
        serde_json::from_value::<ControlSearchRequest>(json!({
            "query": "x", "unknown": true
        }))
        .is_err()
    );

    let get: ControlGetRequest =
        serde_json::from_value(json!({ "resource": "automations" })).expect("get parses");
    assert_eq!(get.limit, 20);
    assert!(get.filters.is_empty());
    assert!(
        serde_json::from_value::<ControlGetRequest>(json!({
            "resource": "automations", "limit": 101
        }))
        .is_ok(),
        "limit ceiling is enforced by the service, not serde"
    );

    let execute: ControlExecuteRequest = serde_json::from_value(json!({
        "operation": "automation.create",
        "arguments": { "name": "x" },
        "idempotency_key": "inbox-weekday-8am-2026-08-16",
    }))
    .expect("execute parses");
    assert_eq!(execute.expected_revision, None);
}

#[test]
fn execute_response_and_error_detail_round_trip() {
    let ok = ControlExecuteResponse {
        ok: true,
        operation: "automation.create".to_string(),
        data: Some(json!({ "id": "automation-9fc78b39", "revision": 1 })),
        error: None,
    };
    let encoded = serde_json::to_value(&ok).unwrap();
    assert!(encoded.get("error").is_none(), "nulls are omitted");

    let failure: ControlErrorDetail = serde_json::from_value(json!({
        "code": "invalid_timezone",
        "message": "Timezone 'London' is not an IANA timezone identifier.",
        "retryable": true,
        "field_errors": [
            { "field": "trigger.timezone", "message": "Use an identifier such as Europe/London." }
        ],
        "current_revision": null,
        "suggested_action": "Retry with trigger.timezone set to Europe/London.",
    }))
    .expect("error parses");
    assert_eq!(failure.field_errors.len(), 1);
    assert_eq!(
        failure.field_errors[0],
        FieldError {
            field: "trigger.timezone".to_string(),
            message: "Use an identifier such as Europe/London.".to_string(),
        }
    );
}

#[test]
fn state_change_event_round_trips() {
    let change: ControlStateChanged = serde_json::from_value(json!({
        "store_revision": 42,
        "domains": ["automations", "audit"],
    }))
    .expect("change parses");
    assert_eq!(change.store_revision, 42);
    assert_eq!(
        change.domains,
        vec![ControlDomain::Automations, ControlDomain::Audit]
    );
}

#[test]
fn capability_schemas_generate_for_shared_argument_types() {
    // The registry publishes JSON Schemas for these request bodies, so every
    // shared argument type must be schema-generatable.
    let search = schemars::schema_for!(ControlSearchRequest);
    let encoded = serde_json::to_value(&search).expect("search schema serializes");
    assert!(encoded.is_object());

    let execute = schemars::schema_for!(ControlExecuteRequest);
    assert!(serde_json::to_value(&execute).is_ok());

    let automation = schemars::schema_for!(Automation);
    let encoded = serde_json::to_value(&automation).expect("automation schema serializes");
    // AgentProvider is an open string identifier on the wire, so its schema
    // must be a plain string, not a closed enum.
    assert!(
        encoded["$defs"]["AgentProvider"]["type"] == "string",
        "provider schema should be an open string type"
    );
}
