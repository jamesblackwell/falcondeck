//! Capability registry: the authoritative catalogue of control operations.
//!
//! The registry is the single source of stable operation ids, titles,
//! descriptions, domains, schemas, behavioural metadata, examples and
//! related-operation links. `falcondeck_execute` only accepts operations
//! registered here — never an internal route or arbitrary method name — and
//! `falcondeck_search` ranks against it deterministically without any
//! language-model call.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use falcondeck_core::CommandResponse;
use falcondeck_core::control::{
    AutomationConcurrencyPolicy, AutomationMisfirePolicy, AutomationTarget, AutomationTask,
    AutomationTrigger, CapabilityBehaviorInfo, CapabilitySummary, ConfirmationPolicy,
    ControlSearchRequest, ProviderControlSettings, SearchDetail,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

/// Behavioural metadata attached to a capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityBehavior {
    /// Whether the operation only reads state.
    pub read_only: bool,
    /// Whether the operation destroys state.
    pub destructive: bool,
    /// Whether repeated identical calls are safe.
    pub idempotent: bool,
    /// Confirmation class surfaced to clients.
    pub confirmation_class: ConfirmationClass,
}

/// Where a capability applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlScope {
    /// Daemon-wide.
    Host,
    /// One workspace.
    Workspace,
}

/// Confirmation class of an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmationClass {
    /// No confirmation needed.
    None,
    /// Ordinary mutation.
    Mutation,
    /// Sensitive mutation.
    Sensitive,
    /// Destructive mutation.
    Destructive,
}

impl ConfirmationClass {
    fn as_str(self) -> &'static str {
        match self {
            ConfirmationClass::None => "none",
            ConfirmationClass::Mutation => "mutation",
            ConfirmationClass::Sensitive => "sensitive",
            ConfirmationClass::Destructive => "destructive",
        }
    }
}

/// One worked example attached to a capability.
pub struct CapabilityExample {
    /// What the example demonstrates.
    pub description: &'static str,
    /// Example `falcondeck_execute` arguments.
    pub arguments: Value,
}

/// A registered control operation.
pub struct Capability {
    /// Stable operation identifier.
    pub id: &'static str,
    /// Short display title.
    pub title: &'static str,
    /// What the operation does.
    pub description: &'static str,
    /// Grouping such as `automation` or `agent_control`.
    pub domain: &'static str,
    /// Supported scopes.
    pub scopes: &'static [ControlScope],
    /// JSON Schema of the operation arguments.
    pub input_schema: Value,
    /// JSON Schema of the operation result.
    pub output_schema: Value,
    /// Behavioural metadata.
    pub behavior: CapabilityBehavior,
    /// Worked examples.
    pub examples: Vec<CapabilityExample>,
    /// Related operation ids.
    pub related_operations: &'static [&'static str],
}

/// Arguments for `automation.create`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateAutomationArgs {
    /// Human-readable name, 1-120 characters.
    pub name: String,
    /// Optional longer description.
    #[serde(default)]
    pub description: Option<String>,
    /// When the automation runs: once, cron or interval.
    pub trigger: AutomationTrigger,
    /// What the agent is asked to do.
    pub task: AutomationTask,
    /// Where and with which provider the work runs.
    pub target: AutomationTarget,
    /// Connector names the automation depends on.
    #[serde(default)]
    pub required_connectors: Vec<String>,
    /// Behaviour when an occurrence overlaps a running one.
    #[serde(default)]
    pub concurrency_policy: AutomationConcurrencyPolicy,
    /// Behaviour for occurrences missed while the daemon was stopped.
    #[serde(default)]
    pub misfire_policy: AutomationMisfirePolicy,
}

/// Arguments for `automation.update`. Absent fields keep their current
/// values; the automation revision must be supplied as `expected_revision`.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateAutomationArgs {
    /// The automation to update.
    pub automation_id: String,
    /// New name.
    #[serde(default)]
    pub name: Option<String>,
    /// New description.
    #[serde(default)]
    pub description: Option<String>,
    /// New trigger.
    #[serde(default)]
    pub trigger: Option<AutomationTrigger>,
    /// New task.
    #[serde(default)]
    pub task: Option<AutomationTask>,
    /// New target.
    #[serde(default)]
    pub target: Option<AutomationTarget>,
    /// New required connectors.
    #[serde(default)]
    pub required_connectors: Option<Vec<String>>,
    /// New concurrency policy.
    #[serde(default)]
    pub concurrency_policy: Option<AutomationConcurrencyPolicy>,
    /// New misfire policy.
    #[serde(default)]
    pub misfire_policy: Option<AutomationMisfirePolicy>,
}

impl UpdateAutomationArgs {
    /// Whether any field was supplied.
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.description.is_none()
            && self.trigger.is_none()
            && self.task.is_none()
            && self.target.is_none()
            && self.required_connectors.is_none()
            && self.concurrency_policy.is_none()
            && self.misfire_policy.is_none()
    }
}

/// Arguments identifying one automation.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationRefArgs {
    /// The automation to operate on.
    pub automation_id: String,
}

/// Arguments for `agent_control.settings.update`. Absent fields keep their
/// current values.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateSettingsArgs {
    /// Global agent-control toggle.
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Provider-specific overrides. Missing providers inherit `enabled`.
    #[serde(default)]
    pub providers: Option<BTreeMap<String, ProviderControlSettings>>,
    /// Default IANA timezone for new recurring schedules.
    #[serde(default)]
    pub default_timezone: Option<String>,
    /// Whether elevated-permission automations may be created.
    #[serde(default)]
    pub allow_elevated_automations: Option<bool>,
    /// Client-facing confirmation preferences.
    #[serde(default)]
    pub confirmation_policy: Option<ConfirmationPolicy>,
}

impl UpdateSettingsArgs {
    /// Whether any field was supplied.
    pub fn is_empty(&self) -> bool {
        self.enabled.is_none()
            && self.providers.is_none()
            && self.default_timezone.is_none()
            && self.allow_elevated_automations.is_none()
            && self.confirmation_policy.is_none()
    }
}

fn schema<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).expect("static schema serializes")
}

macro_rules! example {
    ($description:expr, $arguments:expr) => {
        CapabilityExample {
            description: $description,
            arguments: $arguments,
        }
    };
}

/// Stable operation ids used across the registry.
pub mod ops {
    /// Update agent-control settings.
    pub const SETTINGS_UPDATE: &str = "agent_control.settings.update";
    /// Create an automation.
    pub const AUTOMATION_CREATE: &str = "automation.create";
    /// Update an automation definition.
    pub const AUTOMATION_UPDATE: &str = "automation.update";
    /// Pause an automation.
    pub const AUTOMATION_PAUSE: &str = "automation.pause";
    /// Resume a paused automation.
    pub const AUTOMATION_RESUME: &str = "automation.resume";
    /// Dispatch an automation immediately.
    pub const AUTOMATION_RUN_NOW: &str = "automation.run_now";
    /// Delete an automation.
    pub const AUTOMATION_DELETE: &str = "automation.delete";
}

/// All registered capabilities in a fixed, deterministic order.
pub fn capabilities() -> &'static [Capability] {
    static REGISTRY: OnceLock<Vec<Capability>> = OnceLock::new();
    REGISTRY.get_or_init(|| vec![
        Capability {
            id: ops::SETTINGS_UPDATE,
            title: "Update agent control settings",
            description: "Update global and per-provider agent-control settings such as the enabled flag, default timezone or elevated-automation permission.",
            domain: "agent_control",
            scopes: &[ControlScope::Host],
            input_schema: schema::<UpdateSettingsArgs>(),
            output_schema: schema::<falcondeck_core::control::AgentControlSettings>(),
            behavior: CapabilityBehavior {
                read_only: false,
                destructive: false,
                idempotent: true,
                confirmation_class: ConfirmationClass::Sensitive,
            },
            examples: vec![example!(
                "Disable conversational control for Codex only",
                json!({
                    "enabled": true,
                    "providers": { "codex": { "enabled": false } }
                })
            )],
            related_operations: &[ops::AUTOMATION_CREATE],
        },
        Capability {
            id: ops::AUTOMATION_CREATE,
            title: "Create automation",
            description: "Create a recurring, interval, one-time or conditional-prompt automation that runs an agent instruction on a schedule.",
            domain: "automation",
            scopes: &[ControlScope::Host, ControlScope::Workspace],
            input_schema: schema::<CreateAutomationArgs>(),
            output_schema: schema::<falcondeck_core::control::Automation>(),
            behavior: CapabilityBehavior {
                read_only: false,
                destructive: false,
                idempotent: false,
                confirmation_class: ConfirmationClass::Mutation,
            },
            examples: vec![
                example!(
                    "Every weekday at 08:00 Europe/London, review an inbox and only surface items needing attention",
                    json!({
                        "name": "Weekday inbox review",
                        "trigger": {
                            "kind": "cron",
                            "expression": "0 8 * * 1-5",
                            "timezone": "Europe/London"
                        },
                        "task": {
                            "kind": "conditional_prompt",
                            "instruction": "Review my inbox. Surface messages that need my attention. If nothing requires attention, reply exactly FALCONDECK_NO_ACTION.",
                            "no_action_marker": "FALCONDECK_NO_ACTION"
                        },
                        "target": {
                            "workspace_path": "/Users/james/Code/quizgecko",
                            "provider": "codex",
                            "thread": { "kind": "managed", "thread_id": null },
                            "sandbox_mode": "workspace-write",
                            "selected_skills": []
                        },
                        "required_connectors": ["gmail"],
                        "concurrency_policy": "skip",
                        "misfire_policy": "skip"
                    })
                ),
                example!(
                    "One-time reminder tomorrow at 10:00",
                    json!({
                        "name": "Release checklist review",
                        "trigger": {
                            "kind": "once",
                            "run_at": "2026-08-17T10:00:00+01:00"
                        },
                        "task": {
                            "kind": "prompt",
                            "instruction": "Review the release checklist in this project and report anything incomplete."
                        },
                        "target": {
                            "workspace_path": "/Users/james/Code/quizgecko",
                            "provider": "claude",
                            "thread": { "kind": "new_each_run" }
                        }
                    })
                ),
                example!(
                    "Poll every 30 minutes for failed deployments",
                    json!({
                        "name": "Deployment watchdog",
                        "trigger": {
                            "kind": "interval",
                            "every_seconds": 1800,
                            "anchor_at": "2026-08-16T00:00:00Z"
                        },
                        "task": {
                            "kind": "conditional_prompt",
                            "instruction": "Check for failed production deployments. If everything is healthy reply exactly FALCONDECK_NO_ACTION.",
                            "no_action_marker": "FALCONDECK_NO_ACTION"
                        },
                        "target": {
                            "workspace_path": "/Users/james/Code/ops",
                            "provider": "codex",
                            "thread": { "kind": "managed", "thread_id": null }
                        }
                    })
                ),
            ],
            related_operations: &[
                ops::AUTOMATION_UPDATE,
                ops::AUTOMATION_PAUSE,
                ops::AUTOMATION_RUN_NOW,
            ],
        },
        Capability {
            id: ops::AUTOMATION_UPDATE,
            title: "Update automation",
            description: "Change an automation definition. Requires the revision that was read; a stale revision is rejected with revision_conflict.",
            domain: "automation",
            scopes: &[ControlScope::Host, ControlScope::Workspace],
            input_schema: schema::<UpdateAutomationArgs>(),
            output_schema: schema::<falcondeck_core::control::Automation>(),
            behavior: CapabilityBehavior {
                read_only: false,
                destructive: false,
                idempotent: false,
                confirmation_class: ConfirmationClass::Mutation,
            },
            examples: vec![example!(
                "Move a schedule to 09:30 using the revision from falcondeck_get",
                json!({
                    "automation_id": "automation-9fc78b39",
                    "trigger": {
                        "kind": "cron",
                        "expression": "30 9 * * 1-5",
                        "timezone": "Europe/London"
                    }
                })
            )],
            related_operations: &[ops::AUTOMATION_PAUSE, ops::AUTOMATION_RESUME],
        },
        Capability {
            id: ops::AUTOMATION_PAUSE,
            title: "Pause automation",
            description: "Pause an enabled automation. Idempotent: pausing a paused automation succeeds. Requires the revision that was read.",
            domain: "automation",
            scopes: &[ControlScope::Host, ControlScope::Workspace],
            input_schema: schema::<AutomationRefArgs>(),
            output_schema: schema::<falcondeck_core::control::Automation>(),
            behavior: CapabilityBehavior {
                read_only: false,
                destructive: false,
                idempotent: true,
                confirmation_class: ConfirmationClass::Mutation,
            },
            examples: vec![example!(
                "Pause the inbox review automation",
                json!({ "automation_id": "automation-9fc78b39" })
            )],
            related_operations: &[ops::AUTOMATION_RESUME, ops::AUTOMATION_UPDATE],
        },
        Capability {
            id: ops::AUTOMATION_RESUME,
            title: "Resume automation",
            description: "Resume a paused automation and recalculate its next run. Idempotent. Requires the revision that was read.",
            domain: "automation",
            scopes: &[ControlScope::Host, ControlScope::Workspace],
            input_schema: schema::<AutomationRefArgs>(),
            output_schema: schema::<falcondeck_core::control::Automation>(),
            behavior: CapabilityBehavior {
                read_only: false,
                destructive: false,
                idempotent: true,
                confirmation_class: ConfirmationClass::Mutation,
            },
            examples: vec![example!(
                "Resume the inbox review automation",
                json!({ "automation_id": "automation-9fc78b39" })
            )],
            related_operations: &[ops::AUTOMATION_PAUSE, ops::AUTOMATION_RUN_NOW],
        },
        Capability {
            id: ops::AUTOMATION_RUN_NOW,
            title: "Run automation now",
            description: "Dispatch one manual occurrence immediately, respecting the automation's concurrency policy. Does not require the automation revision.",
            domain: "automation",
            scopes: &[ControlScope::Host, ControlScope::Workspace],
            input_schema: schema::<AutomationRefArgs>(),
            output_schema: schema::<falcondeck_core::control::AutomationRun>(),
            behavior: CapabilityBehavior {
                read_only: false,
                destructive: false,
                idempotent: false,
                confirmation_class: ConfirmationClass::Mutation,
            },
            examples: vec![example!(
                "Run the deployment watchdog without waiting for the interval",
                json!({ "automation_id": "automation-9fc78b39" })
            )],
            related_operations: &[ops::AUTOMATION_PAUSE],
        },
        Capability {
            id: ops::AUTOMATION_DELETE,
            title: "Delete automation",
            description: "Permanently delete an automation definition. Destructive; run history is retained. Requires the revision that was read.",
            domain: "automation",
            scopes: &[ControlScope::Host, ControlScope::Workspace],
            input_schema: schema::<AutomationRefArgs>(),
            output_schema: schema::<CommandResponse>(),
            behavior: CapabilityBehavior {
                read_only: false,
                destructive: true,
                idempotent: true,
                confirmation_class: ConfirmationClass::Destructive,
            },
            examples: vec![example!(
                "Delete the one-off reminder after it completed",
                json!({ "automation_id": "automation-9fc78b39" })
            )],
            related_operations: &[ops::AUTOMATION_PAUSE],
        },
    ])
}

/// Looks up one capability by operation id.
pub fn find(operation: &str) -> Option<&'static Capability> {
    capabilities()
        .iter()
        .find(|capability| capability.id == operation)
}

fn behavior_info(behavior: CapabilityBehavior) -> CapabilityBehaviorInfo {
    CapabilityBehaviorInfo {
        read_only: behavior.read_only,
        destructive: behavior.destructive,
        idempotent: behavior.idempotent,
        confirmation_class: behavior.confirmation_class.as_str().to_string(),
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 2)
        .map(str::to_string)
        .collect()
}

fn example_text(capability: &Capability) -> String {
    let mut text = String::new();
    for example in &capability.examples {
        text.push_str(example.description);
        text.push(' ');
        if let Ok(serialized) = serde_json::to_string(&example.arguments) {
            text.push_str(&serialized);
            text.push(' ');
        }
    }
    text
}

fn score(capability: &Capability, query_tokens: &[String]) -> i64 {
    let title_tokens = tokenize(capability.title);
    let description_tokens = tokenize(capability.description);
    let examples = tokenize(&example_text(capability));
    let related = tokenize(&capability.related_operations.join(" "));
    let mut score = 0;
    for token in query_tokens {
        if title_tokens.iter().any(|candidate| candidate == token) {
            score += 30;
        } else if title_tokens
            .iter()
            .any(|candidate| candidate.contains(token.as_str()))
        {
            score += 15;
        }
        if description_tokens
            .iter()
            .any(|candidate| candidate == token)
        {
            score += 10;
        } else if description_tokens
            .iter()
            .any(|candidate| candidate.contains(token.as_str()))
        {
            score += 5;
        }
        if examples
            .iter()
            .any(|candidate| candidate.contains(token.as_str()))
        {
            score += 4;
        }
        if related
            .iter()
            .any(|candidate| candidate.contains(token.as_str()))
        {
            score += 8;
        }
    }
    score
}

/// Deterministic capability search. Exact operation ids and domains rank
/// above token matches; ties keep registry order.
pub fn search(
    request: &ControlSearchRequest,
    available: &dyn Fn(&Capability) -> bool,
) -> Vec<CapabilitySummary> {
    let detail = request.detail;
    let limit = request
        .limit
        .clamp(1, falcondeck_core::control::CONTROL_SEARCH_LIMIT);
    let mut candidates: Vec<(i64, usize, &'static Capability)> = Vec::new();

    for (index, capability) in capabilities().iter().enumerate() {
        if let Some(domain) = &request.domain
            && !domain.eq_ignore_ascii_case(capability.domain)
        {
            continue;
        }
        let exact = request
            .operation
            .as_deref()
            .is_some_and(|operation| operation == capability.id);
        if request.operation.is_some() && !exact {
            continue;
        }
        let mut capability_score = score(capability, &query_tokens(request));
        if exact {
            capability_score += 1000;
        }
        if let Some(query) = &request.query {
            if query.eq_ignore_ascii_case(capability.id) {
                capability_score += 1000;
            } else if let Some(operation) = query.strip_prefix("falcondeck_execute ")
                && operation.trim() == capability.id
            {
                capability_score += 1000;
            }
            if query.eq_ignore_ascii_case(capability.domain) {
                capability_score += 200;
            }
        }
        // Unqualified listing: include everything with a base score.
        if request.query.is_none() && request.operation.is_none() {
            capability_score += 1;
        }
        if capability_score > 0 {
            candidates.push((capability_score, index, capability));
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    candidates
        .into_iter()
        .take(limit)
        .map(|(_, _, capability)| {
            let full = detail == SearchDetail::Full
                || request
                    .operation
                    .as_deref()
                    .is_some_and(|operation| operation == capability.id);
            CapabilitySummary {
                operation: capability.id.to_string(),
                title: capability.title.to_string(),
                description: capability.description.to_string(),
                domain: capability.domain.to_string(),
                behavior: behavior_info(capability.behavior),
                related_operations: capability
                    .related_operations
                    .iter()
                    .map(|id| id.to_string())
                    .collect(),
                available: available(capability),
                input_schema: full.then(|| capability.input_schema.clone()),
                output_schema: full.then(|| capability.output_schema.clone()),
                examples: full.then(|| {
                    capability
                        .examples
                        .iter()
                        .map(|example| falcondeck_core::control::CapabilityExampleInfo {
                            description: example.description.to_string(),
                            arguments: example.arguments.clone(),
                        })
                        .collect()
                }),
            }
        })
        .collect()
}

fn query_tokens(request: &ControlSearchRequest) -> Vec<String> {
    request.query.as_deref().map(tokenize).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_available(_: &Capability) -> bool {
        true
    }

    fn search_ids(request: ControlSearchRequest) -> Vec<String> {
        search(&request, &all_available)
            .into_iter()
            .map(|result| result.operation)
            .collect()
    }

    #[test]
    fn operation_ids_are_unique() {
        let capabilities = capabilities();
        let mut ids: Vec<_> = capabilities.iter().map(|c| c.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "duplicate operation ids");
        assert!(total >= 7);
    }

    #[test]
    fn registry_order_is_deterministic() {
        let first: Vec<_> = capabilities().iter().map(|c| c.id).collect();
        let second: Vec<_> = capabilities().iter().map(|c| c.id).collect();
        assert_eq!(first, second);
        assert_eq!(first[0], ops::SETTINGS_UPDATE);
    }

    #[test]
    fn every_mutation_has_input_and_output_schemas() {
        for capability in capabilities() {
            assert!(
                capability
                    .input_schema
                    .as_object()
                    .is_some_and(|m| !m.is_empty()),
                "{} input schema",
                capability.id
            );
            assert!(
                capability
                    .output_schema
                    .as_object()
                    .is_some_and(|m| !m.is_empty()),
                "{} output schema",
                capability.id
            );
            assert!(!capability.scopes.is_empty());
        }
    }

    #[test]
    fn related_operation_ids_exist() {
        let ids: Vec<_> = capabilities().iter().map(|c| c.id).collect();
        for capability in capabilities() {
            for related in capability.related_operations {
                assert!(ids.contains(related), "{} -> {}", capability.id, related);
            }
        }
    }

    #[test]
    fn exact_id_search_ranks_first() {
        let results = search_ids(ControlSearchRequest {
            query: Some("automation.create".to_string()),
            ..Default::default()
        });
        assert_eq!(
            results.first().map(String::as_str),
            Some(ops::AUTOMATION_CREATE)
        );

        let results = search_ids(ControlSearchRequest {
            operation: Some(ops::AUTOMATION_PAUSE.to_string()),
            ..Default::default()
        });
        assert_eq!(results, vec![ops::AUTOMATION_PAUSE.to_string()]);
    }

    #[test]
    fn natural_language_search_finds_capabilities() {
        let results = search_ids(ControlSearchRequest {
            query: Some("create a recurring scheduled task".to_string()),
            ..Default::default()
        });
        assert_eq!(
            results.first().map(String::as_str),
            Some(ops::AUTOMATION_CREATE)
        );

        let results = search_ids(ControlSearchRequest {
            query: Some("pause stop halt an automation".to_string()),
            ..Default::default()
        });
        assert!(results.contains(&ops::AUTOMATION_PAUSE.to_string()));

        let results = search_ids(ControlSearchRequest {
            query: Some("remove delete destroy automation".to_string()),
            ..Default::default()
        });
        assert_eq!(
            results.first().map(String::as_str),
            Some(ops::AUTOMATION_DELETE)
        );
    }

    #[test]
    fn domain_filter_restricts_results() {
        let results = search_ids(ControlSearchRequest {
            domain: Some("agent_control".to_string()),
            ..Default::default()
        });
        assert!(results.iter().all(|id| id.starts_with("agent_control.")));
    }

    #[test]
    fn summary_search_omits_large_schemas() {
        let results = search(
            &ControlSearchRequest {
                query: Some("automation".to_string()),
                ..Default::default()
            },
            &all_available,
        );
        assert!(!results.is_empty());
        for result in &results {
            assert!(result.input_schema.is_none());
            assert!(result.output_schema.is_none());
            assert!(result.examples.is_none());
        }
    }

    #[test]
    fn full_search_includes_schema_and_examples() {
        let results = search(
            &ControlSearchRequest {
                query: Some("create automation".to_string()),
                detail: SearchDetail::Full,
                ..Default::default()
            },
            &all_available,
        );
        let create = results
            .iter()
            .find(|result| result.operation == ops::AUTOMATION_CREATE)
            .expect("create capability");
        assert!(create.input_schema.as_ref().is_some_and(|schema| {
            schema
                .as_object()
                .is_some_and(|map| map.contains_key("properties"))
        }));
        assert!(
            create
                .examples
                .as_ref()
                .is_some_and(|examples| !examples.is_empty())
        );
    }

    #[test]
    fn search_limit_is_enforced() {
        let results = search_ids(ControlSearchRequest {
            limit: 2,
            ..Default::default()
        });
        assert!(results.len() <= 2);
    }

    #[test]
    fn availability_is_reported_per_capability() {
        let results = search(
            &ControlSearchRequest::default(),
            &|capability: &Capability| capability.id != ops::AUTOMATION_DELETE,
        );
        for result in &results {
            let expected = result.operation != ops::AUTOMATION_DELETE;
            assert_eq!(result.available, expected);
        }
    }

    #[test]
    fn typed_argument_structs_reject_unknown_fields() {
        let args = serde_json::from_value::<CreateAutomationArgs>(serde_json::json!({
            "name": "x",
            "trigger": {"kind": "once", "run_at": "2026-08-17T10:00:00Z"},
            "task": {"kind": "prompt", "instruction": "i"},
            "target": {
                "workspace_path": "/w",
                "provider": "codex",
                "thread": {"kind": "managed"}
            },
            "surprise": true,
        }));
        assert!(args.is_err());

        let args: AutomationRefArgs =
            serde_json::from_value(serde_json::json!({ "automation_id": "a1" })).unwrap();
        assert_eq!(args.automation_id, "a1");
        assert!(serde_json::from_value::<AutomationRefArgs>(serde_json::json!({})).is_err());
    }
}
