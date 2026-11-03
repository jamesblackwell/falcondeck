//! Auto routing: one classification when a thread is created, then a
//! deterministic, user-editable rule table picks the harness, model and effort.
//!
//! The classifier (Jev by default) only answers fixed questions about the
//! brief: task type, difficulty, production risk, need for social data. Rules
//! are evaluated top to bottom; the first match whose targets include an
//! available model wins. See `docs/ROUTING.md`.

use serde::{Deserialize, Serialize};

use crate::AgentProvider;

/// OpenRouter decisions model used to classify briefs.
pub const DEFAULT_ROUTING_CLASSIFIER_MODEL: &str = "typesafe/jev-1.13";
/// Marker callers pass as `model` (or `provider`) to request auto routing.
pub const AUTO_ROUTE_MARKER: &str = "auto";

/// Auto routing settings persisted with the daemon preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutingPreferences {
    /// When off, `auto` requests are rejected and callers must name a model.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// OpenRouter decisions model that classifies the brief.
    #[serde(default = "default_classifier_model")]
    pub classifier_model: String,
    /// Below this task-type confidence (0–100) the fallback targets are used.
    #[serde(default = "default_min_confidence")]
    pub min_confidence_percent: u8,
    /// A target is skipped while any usage window of its subscription is at or
    /// above this share (0–100). 100 disables the check.
    #[serde(default = "default_usage_ceiling")]
    pub usage_ceiling_percent: u8,
    /// Task types the classifier chooses between.
    #[serde(default = "default_task_types")]
    pub task_types: Vec<RoutingTaskType>,
    /// Ordered rules; the first matching rule with an available target wins.
    #[serde(default = "default_rules")]
    pub rules: Vec<RoutingRule>,
    /// Targets used when no rule matches, the classifier is unsure or offline.
    #[serde(default = "default_fallback")]
    pub fallback: Vec<RoutingTarget>,
}

impl Default for RoutingPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            classifier_model: default_classifier_model(),
            min_confidence_percent: default_min_confidence(),
            usage_ceiling_percent: default_usage_ceiling(),
            task_types: default_task_types(),
            rules: default_rules(),
            fallback: default_fallback(),
        }
    }
}

/// One answer the classifier may give for "what kind of work is this?".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutingTaskType {
    /// Stable id referenced by rules, e.g. `ui`.
    pub id: String,
    /// Plain-language description the classifier reads.
    pub description: String,
}

/// A rule: conditions on the classification, then targets in preference order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutingRule {
    /// Short name shown in decisions and settings.
    #[serde(default)]
    pub label: String,
    /// Task type ids this rule covers; empty matches any type.
    #[serde(default)]
    pub task_types: Vec<String>,
    /// Lowest difficulty (1–5, rounded classifier score) this rule covers.
    #[serde(default)]
    pub min_difficulty: Option<u8>,
    /// Highest difficulty (1–5) this rule covers.
    #[serde(default)]
    pub max_difficulty: Option<u8>,
    /// Require the production-risk flag to be this value; `None` ignores it.
    #[serde(default)]
    pub production_risk: Option<bool>,
    /// Require the needs-social-data flag to be this value; `None` ignores it.
    #[serde(default)]
    pub needs_social: Option<bool>,
    /// Harness and model choices, best first.
    #[serde(default)]
    pub targets: Vec<RoutingTarget>,
}

/// One harness + model + effort choice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutingTarget {
    /// Harness id, e.g. `codex`, `claude`, `opencode`, `grok`.
    pub provider: AgentProvider,
    /// Provider-native model id; `None` uses the harness default.
    #[serde(default)]
    pub model_id: Option<String>,
    /// Reasoning effort; `None` uses the model default.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

/// What the classifier said about a brief.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteClassification {
    /// Chosen task type id.
    pub task_type: String,
    /// Classifier confidence in the task type, 0–100.
    pub confidence_percent: u8,
    /// Difficulty on a 1.0–5.0 scale.
    pub difficulty: f32,
    /// Probability (0–100) that the task touches production, deploys,
    /// migrations, auth, payments or secrets.
    pub production_risk_percent: u8,
    /// Probability (0–100) that the task needs live X or social data.
    pub needs_social_percent: u8,
    /// Model that answered.
    pub classifier_model: String,
    /// Round-trip time of the classification call.
    pub latency_ms: u64,
}

/// A target that was considered and passed over.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RouteSkip {
    /// The target that was skipped.
    pub target: RoutingTarget,
    /// Why, e.g. "codex weekly limit at 93%".
    pub reason: String,
}

/// The outcome of routing one brief.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteDecision {
    /// Classifier output; `None` when it was unavailable.
    pub classification: Option<RouteClassification>,
    /// Label of the rule that produced the target; `None` means fallback.
    pub rule: Option<String>,
    /// Chosen target; `None` when nothing configured is available.
    pub target: Option<RoutingTarget>,
    /// Targets passed over on the way, with reasons.
    #[serde(default)]
    pub skipped: Vec<RouteSkip>,
    /// One-line human explanation.
    pub reason: String,
}

/// Body for `POST /api/routing/preview` and the `routing.preview` RPC.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutePreviewRequest {
    /// Project whose installed harnesses decide availability.
    pub workspace_id: String,
    /// The brief to classify.
    pub prompt: String,
}

fn default_true() -> bool {
    true
}
fn default_classifier_model() -> String {
    DEFAULT_ROUTING_CLASSIFIER_MODEL.to_string()
}
fn default_min_confidence() -> u8 {
    50
}
fn default_usage_ceiling() -> u8 {
    90
}

fn task_type(id: &str, description: &str) -> RoutingTaskType {
    RoutingTaskType {
        id: id.into(),
        description: description.into(),
    }
}

/// Default task types, tuned against real FalconDeck delegation briefs.
pub fn default_task_types() -> Vec<RoutingTaskType> {
    vec![
        task_type("ui", "Build or design user interface: new screens, visual polish, layout, interaction, UX flows"),
        task_type("backend", "Write or change server, API, database, infrastructure or app logic code, or debug a defect"),
        task_type("mechanical", "Small, precisely specified edit: rename, copy change, config tweak, test or lint fix"),
        task_type("review", "Read-only review of existing code, a diff or a design, reporting findings"),
        task_type("research", "Investigate, analyse data, or gather information and report back; no product code changes"),
        task_type("writing", "Write documents, marketing copy, plans or content rather than code"),
        task_type("ops", "Deploy, release, migrate data, or operate production systems"),
    ]
}

fn target(provider: &str, model: &str, effort: Option<&str>) -> RoutingTarget {
    RoutingTarget {
        provider: AgentProvider::new(provider),
        model_id: Some(model.into()),
        reasoning_effort: effort.map(str::to_string),
    }
}
fn sol(effort: &str) -> RoutingTarget {
    target("codex", "gpt-6.1-sol", Some(effort))
}
fn opus(effort: &str) -> RoutingTarget {
    target("claude", "opus", Some(effort))
}
/// GLM through OpenCode's Z.AI coding plan. OpenCode efforts are per-model
/// variants, so none is set.
fn glm() -> RoutingTarget {
    target("opencode", "zai-coding-plan/glm-5.3", None)
}

fn rule(label: &str, task_types: &[&str], targets: Vec<RoutingTarget>) -> RoutingRule {
    RoutingRule {
        label: label.into(),
        task_types: task_types.iter().map(|id| id.to_string()).collect(),
        min_difficulty: None,
        max_difficulty: None,
        production_risk: None,
        needs_social: None,
        targets,
    }
}

/// Default rules: risky work and UI stay on frontier models, easy and
/// mechanical work goes to GLM, the rest to Sol.
pub fn default_rules() -> Vec<RoutingRule> {
    vec![
        RoutingRule {
            production_risk: Some(true),
            ..rule("Production risk", &[], vec![sol("high"), opus("high")])
        },
        RoutingRule {
            needs_social: Some(true),
            ..rule("Needs X / social", &[], vec![target("grok", "grok-4.7", None), sol("medium")])
        },
        rule("UI", &["ui"], vec![opus("medium"), sol("medium")]),
        rule("Mechanical", &["mechanical"], vec![glm(), target("claude", "sonnet", Some("low"))]),
        RoutingRule {
            max_difficulty: Some(2),
            ..rule("Easy work", &[], vec![glm(), sol("low")])
        },
        RoutingRule {
            max_difficulty: Some(3),
            ..rule("Research & writing", &["research", "writing"], vec![glm(), sol("medium")])
        },
        rule("Backend & ops", &["backend", "ops"], vec![sol("medium"), opus("medium")]),
        rule("Review", &["review"], vec![sol("medium"), opus("medium")]),
    ]
}

/// Default fallback when nothing else applies.
pub fn default_fallback() -> Vec<RoutingTarget> {
    vec![sol("medium"), opus("medium")]
}

impl RoutingRule {
    /// Whether the classification satisfies every condition on this rule.
    /// `risk` and `social` are the classifier flags already thresholded.
    pub fn matches(&self, task_type: &str, difficulty: u8, risk: bool, social: bool) -> bool {
        (self.task_types.is_empty() || self.task_types.iter().any(|id| id == task_type))
            && self.min_difficulty.is_none_or(|min| difficulty >= min)
            && self.max_difficulty.is_none_or(|max| difficulty <= max)
            && self.production_risk.is_none_or(|want| want == risk)
            && self.needs_social.is_none_or(|want| want == social)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_reference_only_known_task_types() {
        let ids: Vec<_> = default_task_types().into_iter().map(|t| t.id).collect();
        for rule in default_rules() {
            assert!(!rule.targets.is_empty(), "{} has no targets", rule.label);
            for id in &rule.task_types {
                assert!(ids.contains(id), "{} references unknown {id}", rule.label);
            }
        }
    }

    #[test]
    fn rule_conditions_combine() {
        let easy = RoutingRule {
            max_difficulty: Some(2),
            production_risk: Some(false),
            ..rule("x", &["backend"], vec![])
        };
        assert!(easy.matches("backend", 2, false, false));
        assert!(!easy.matches("backend", 3, false, false));
        assert!(!easy.matches("backend", 2, true, false));
        assert!(!easy.matches("ui", 1, false, false));
    }

    #[test]
    fn missing_fields_load_defaults() {
        let prefs: RoutingPreferences = serde_json::from_str("{}").unwrap();
        assert_eq!(prefs, RoutingPreferences::default());
    }
}
