//! Auto routing for new threads. One classifier call per brief (Jev through
//! OpenRouter's decisions endpoint), then a deterministic walk of the user's
//! rule table that skips unavailable harnesses and exhausted subscriptions.

use std::collections::BTreeMap;
use std::time::Instant;

use falcondeck_core::{
    AccountStatus, AgentProvider, ProviderUsage, ProviderUsageOverview, RouteClassification,
    RouteDecision, RoutePreviewRequest, RouteSkip, RoutingPreferences, RoutingTarget,
    DEFAULT_ROUTING_CLASSIFIER_MODEL,
};
use serde_json::{Value, json};
use tokio::time::Duration;

use super::{AppState, speech::OPENROUTER_CLIENT};
use crate::error::DaemonError;

const DECISIONS_URL: &str = "https://openrouter.ai/api/alpha/decisions";
const CLASSIFY_TIMEOUT: Duration = Duration::from_secs(8);
/// Briefs past this are cut; the opening states the task.
const MAX_STATE_CHARS: usize = 12_000;
/// Flag probabilities at or above this count as yes.
const FLAG_THRESHOLD: u8 = 50;
const DIFFICULTY_LEVELS: [&str; 5] = [
    "trivial: obvious steps",
    "easy: clear steps, little judgment",
    "moderate: some design decisions or debugging",
    "hard: ambiguous, cross-cutting, or subtle",
    "very hard: novel architecture or deep investigation",
];

/// Cleans user-edited settings: trims ids, drops empty or duplicate task
/// types and targets without a provider, clamps percentages.
pub(super) fn normalize_routing(mut routing: RoutingPreferences) -> RoutingPreferences {
    routing.classifier_model = routing.classifier_model.trim().to_string();
    if routing.classifier_model.is_empty() {
        routing.classifier_model = DEFAULT_ROUTING_CLASSIFIER_MODEL.to_string();
    }
    routing.min_confidence_percent = routing.min_confidence_percent.min(100);
    routing.usage_ceiling_percent = routing.usage_ceiling_percent.min(100);
    let mut seen = Vec::new();
    routing.task_types.retain_mut(|task| {
        task.id = task.id.trim().to_ascii_lowercase();
        task.description = task.description.trim().to_string();
        let keep = !task.id.is_empty() && !task.description.is_empty() && !seen.contains(&task.id);
        seen.push(task.id.clone());
        keep
    });
    // Jev's choice question accepts at most 255 options.
    routing.task_types.truncate(255);
    if routing.task_types.is_empty() {
        routing.task_types = falcondeck_core::default_task_types();
    }
    let clean = |targets: &mut Vec<RoutingTarget>| {
        targets.retain(|t| !t.provider.as_str().trim().is_empty());
        for target in targets.iter_mut() {
            target.model_id = trimmed(target.model_id.take());
            target.reasoning_effort = trimmed(target.reasoning_effort.take());
        }
    };
    for rule in &mut routing.rules {
        rule.label = rule.label.trim().to_string();
        rule.task_types = rule
            .task_types
            .iter()
            .map(|id| id.trim().to_ascii_lowercase())
            .filter(|id| !id.is_empty())
            .collect();
        rule.min_difficulty = rule.min_difficulty.map(|d| d.clamp(1, 5));
        rule.max_difficulty = rule.max_difficulty.map(|d| d.clamp(1, 5));
        clean(&mut rule.targets);
    }
    clean(&mut routing.fallback);
    routing
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The decisions request: one choice, one score, two yes/no flags.
fn decision_request(routing: &RoutingPreferences, prompt: &str) -> Value {
    let criteria: serde_json::Map<String, Value> = routing
        .task_types
        .iter()
        .map(|task| (task.id.clone(), Value::String(task.description.clone())))
        .collect();
    let state: String = prompt.chars().take(MAX_STATE_CHARS).collect();
    json!({
        "model": routing.classifier_model,
        "state": state,
        "questions": {
            "task_type": {"type": "choice", "instructions": "What kind of work does this task brief ask a coding agent to do?", "criteria": criteria},
            "difficulty": {"type": "score", "instructions": "How much judgment and capability does this task need from a coding agent?", "criteria": DIFFICULTY_LEVELS},
            "production_risk": {"type": "noul", "instructions": "Could this task change production systems, deploy, migrate data, or touch auth, payments or secrets?"},
            "needs_social": {"type": "noul", "instructions": "Does this task need live information from X (Twitter) or social media?"}
        }
    })
}

fn percent(value: Option<f64>) -> u8 {
    (value.unwrap_or(0.0).clamp(0.0, 1.0) * 100.0).round() as u8
}

fn parse_classification(
    body: &Value,
    classifier_model: &str,
    latency_ms: u64,
) -> Result<RouteClassification, String> {
    let answers = body
        .get("answers")
        .ok_or_else(|| "classifier returned no answers".to_string())?;
    let task = &answers["task_type"];
    let task_type = task["choice"]
        .as_str()
        .ok_or_else(|| "classifier returned no task type".to_string())?
        .to_string();
    // The score is a 0-based index into DIFFICULTY_LEVELS.
    let difficulty = answers["difficulty"]["score"].as_f64().unwrap_or(2.0) + 1.0;
    Ok(RouteClassification {
        task_type,
        confidence_percent: percent(task["confidence"].as_f64()),
        difficulty: (difficulty.clamp(1.0, 5.0) * 10.0).round() as f32 / 10.0,
        production_risk_percent: percent(answers["production_risk"]["noul"].as_f64()),
        needs_social_percent: percent(answers["needs_social"]["noul"].as_f64()),
        classifier_model: body["model"]
            .as_str()
            .unwrap_or(classifier_model)
            .to_string(),
        latency_ms,
    })
}

/// What the router may use in one workspace right now.
#[derive(Debug, Default, Clone)]
pub(super) struct Availability {
    /// Installed harnesses: sign-in state and offered model ids.
    pub agents: BTreeMap<String, (AccountStatus, Vec<String>)>,
    /// Highest window use per subscription key (`codex`, `claude`, `zai`…).
    pub usage: BTreeMap<String, (u32, String)>,
}

/// Subscription that bills a target, matching `ProviderUsageOverview` fields.
fn usage_key(target: &RoutingTarget) -> Option<&'static str> {
    let model = target.model_id.as_deref().unwrap_or("");
    Some(match target.provider.as_str() {
        "codex" => "codex",
        "claude" => "claude",
        "grok" => "grok",
        "cursor" => "cursor",
        "agy" => "agy",
        "opencode" if model.starts_with("zai-coding-plan/") => "zai",
        "opencode" if model.starts_with("openrouter/") => "openrouter",
        _ => return None,
    })
}

fn usage_map(overview: &ProviderUsageOverview) -> BTreeMap<String, (u32, String)> {
    let entries = [
        ("codex", &overview.codex),
        ("claude", &overview.claude_code),
        ("grok", &overview.grok),
        ("cursor", &overview.cursor),
        ("agy", &overview.agy),
        ("zai", &overview.zai),
        ("openrouter", &overview.openrouter),
    ];
    entries
        .into_iter()
        .filter_map(|(key, usage)| match usage {
            ProviderUsage::Ok { windows, .. } => windows
                .iter()
                .max_by_key(|w| w.used_percent)
                .map(|w| (key.to_string(), (w.used_percent, w.label.clone()))),
            _ => None,
        })
        .collect()
}

fn describe(target: &RoutingTarget) -> String {
    let mut text = target.provider.as_str().to_string();
    if let Some(model) = &target.model_id {
        text.push(' ');
        text.push_str(model);
    }
    if let Some(effort) = &target.reasoning_effort {
        text.push_str(&format!(" ({effort})"));
    }
    text
}

/// Why a target cannot be used, or `None` when it can.
fn unavailable(
    target: &RoutingTarget,
    availability: &Availability,
    ceiling: u8,
) -> Option<String> {
    let provider = target.provider.as_str();
    let Some((status, models)) = availability.agents.get(provider) else {
        return Some(format!("{provider} is not installed for this project"));
    };
    if matches!(status, AccountStatus::NeedsAuth) {
        return Some(format!("{provider} needs sign-in"));
    }
    // Lazy harnesses list only `default` until hydrated; trust the id then.
    if let Some(model) = &target.model_id
        && models.len() > 1
        && !models.iter().any(|m| m == model)
    {
        return Some(format!("{provider} does not offer {model}"));
    }
    if ceiling < 100
        && let Some(key) = usage_key(target)
        && let Some((used, label)) = availability.usage.get(key)
        && *used >= u32::from(ceiling)
    {
        return Some(format!("{key} {} at {used}%", label.to_lowercase()));
    }
    None
}

/// Walks rules, then fallback, returning the first usable target. Pure so
/// the table is testable without a classifier or harnesses.
pub(super) fn resolve(
    routing: &RoutingPreferences,
    classification: Option<&RouteClassification>,
    classifier_error: Option<&str>,
    availability: &Availability,
    only_provider: Option<&AgentProvider>,
) -> RouteDecision {
    let mut skipped = Vec::new();
    let confident = classification
        .filter(|c| c.confidence_percent >= routing.min_confidence_percent);
    let mut candidates: Vec<(Option<&str>, &RoutingTarget)> = Vec::new();
    if let Some(c) = confident {
        let difficulty = c.difficulty.round().clamp(1.0, 5.0) as u8;
        let risk = c.production_risk_percent >= FLAG_THRESHOLD;
        let social = c.needs_social_percent >= FLAG_THRESHOLD;
        for rule in routing
            .rules
            .iter()
            .filter(|rule| rule.matches(&c.task_type, difficulty, risk, social))
        {
            candidates.extend(rule.targets.iter().map(|t| (Some(rule.label.as_str()), t)));
        }
    }
    candidates.extend(routing.fallback.iter().map(|t| (None, t)));
    if let Some(provider) = only_provider {
        candidates.retain(|(_, target)| &target.provider == provider);
    }
    // A target listed under several matching rules is judged once.
    let mut seen = Vec::new();
    candidates.retain(|(_, target)| {
        let fresh = !seen.contains(target);
        if fresh {
            seen.push(*target);
        }
        fresh
    });

    let why = match (classification, classifier_error) {
        (Some(c), _) if confident.is_none() => format!(
            "{} at {}% confidence, below the {}% bar",
            c.task_type, c.confidence_percent, routing.min_confidence_percent
        ),
        (Some(c), _) => format!(
            "{} · difficulty {:.1} · {}%{}{}",
            c.task_type,
            c.difficulty,
            c.confidence_percent,
            if c.production_risk_percent >= FLAG_THRESHOLD { " · production risk" } else { "" },
            if c.needs_social_percent >= FLAG_THRESHOLD { " · needs X/social" } else { "" },
        ),
        (None, Some(error)) => format!("classifier unavailable ({error})"),
        (None, None) => "not classified".to_string(),
    };

    // Second pass ignores subscription limits: an exhausted plan beats none.
    for ceiling in [routing.usage_ceiling_percent, 100] {
        for (rule, target) in &candidates {
            match unavailable(target, availability, ceiling) {
                None => {
                    let source = rule.map_or_else(
                        || "fallback".to_string(),
                        |label| format!("rule \"{label}\""),
                    );
                    let over = if ceiling == 100 && routing.usage_ceiling_percent < 100 {
                        " (every option is past its usage limit)"
                    } else {
                        ""
                    };
                    return RouteDecision {
                        classification: classification.cloned(),
                        rule: rule.map(str::to_string),
                        target: Some((*target).clone()),
                        reason: format!("{why} → {source} → {}{over}", describe(target)),
                        skipped,
                    };
                }
                Some(reason) if ceiling == routing.usage_ceiling_percent => {
                    skipped.push(RouteSkip {
                        target: (*target).clone(),
                        reason,
                    })
                }
                Some(_) => {}
            }
        }
    }
    // Restricted to one harness with no configured target: use its default.
    if let Some(provider) = only_provider
        && availability.agents.contains_key(provider.as_str())
    {
        let target = RoutingTarget {
            provider: provider.clone(),
            model_id: None,
            reasoning_effort: None,
        };
        return RouteDecision {
            classification: classification.cloned(),
            rule: None,
            reason: format!("{why} → no {} target configured → its default model", provider.as_str()),
            target: Some(target),
            skipped,
        };
    }
    RouteDecision {
        classification: classification.cloned(),
        rule: None,
        target: None,
        reason: format!("{why} → no configured model is available"),
        skipped,
    }
}

impl AppState {
    /// Classifies a brief and resolves a target without starting anything.
    pub async fn preview_route(
        &self,
        request: RoutePreviewRequest,
    ) -> Result<RouteDecision, DaemonError> {
        let prompt = request.prompt.trim();
        if prompt.is_empty() {
            return Err(DaemonError::BadRequest("prompt is required".into()));
        }
        let decision = self.route_brief(&request.workspace_id, prompt, None).await?;
        self.analytics_route(None, None, Some(&decision));
        Ok(decision)
    }

    /// Routes one brief for `workspace_id`. Classifier failures fall back to
    /// the fallback targets rather than failing the caller.
    pub(super) async fn route_brief(
        &self,
        workspace_id: &str,
        prompt: &str,
        only_provider: Option<&AgentProvider>,
    ) -> Result<RouteDecision, DaemonError> {
        let routing = self.inner.preferences.lock().await.routing.clone();
        if !routing.enabled {
            return Err(DaemonError::BadRequest(
                "Auto routing is off (Settings → Routing). Name a provider and model instead.".into(),
            ));
        }
        let availability = self.routing_availability(workspace_id).await?;
        let (classification, error) = match self.classify_brief(&routing, prompt).await {
            Ok(c) => (Some(c), None),
            Err(error) => (None, Some(error)),
        };
        Ok(resolve(
            &routing,
            classification.as_ref(),
            error.as_deref(),
            &availability,
            only_provider,
        ))
    }

    async fn classify_brief(
        &self,
        routing: &RoutingPreferences,
        prompt: &str,
    ) -> Result<RouteClassification, String> {
        let key = self
            .openrouter_key_cached()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no OpenRouter key; add one in Settings → Models & keys".to_string())?;
        let started = Instant::now();
        let response = OPENROUTER_CLIENT
            .post(DECISIONS_URL)
            .bearer_auth(key)
            .header("X-Title", "FalconDeck")
            .timeout(CLASSIFY_TIMEOUT)
            .json(&decision_request(routing, prompt))
            .send()
            .await
            .map_err(|e| if e.is_timeout() { "timed out".into() } else { e.to_string() })?;
        let status = response.status();
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let message = body["error"]["message"].as_str().unwrap_or("request failed");
            let first_line = message.lines().next().unwrap_or(message);
            return Err(format!("{status}: {}", first_line.chars().take(160).collect::<String>()));
        }
        parse_classification(
            &body,
            &routing.classifier_model,
            started.elapsed().as_millis() as u64,
        )
    }

    /// Installed harnesses for the workspace plus cached subscription use.
    /// Usage is never fetched inline: a stale cache is fine and an empty one
    /// starts a background refresh for the next decision.
    async fn routing_availability(&self, workspace_id: &str) -> Result<Availability, DaemonError> {
        let agents = {
            let workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
            workspace
                .summary
                .agents
                .iter()
                .map(|agent| {
                    (
                        agent.provider.as_str().to_string(),
                        (
                            agent.account.status.clone(),
                            agent.models.iter().map(|m| m.id.clone()).collect(),
                        ),
                    )
                })
                .collect()
        };
        let cached = self
            .inner
            .usage_cache
            .lock()
            .unwrap()
            .as_ref()
            .map(|(_, overview)| usage_map(overview));
        let usage = match cached {
            Some(usage) => usage,
            None => {
                let app = self.clone();
                tokio::spawn(async move {
                    app.provider_usage_overview(false).await;
                });
                BTreeMap::new()
            }
        };
        Ok(Availability { agents, usage })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classification(task: &str, difficulty: f32, confidence: u8, risk: u8) -> RouteClassification {
        RouteClassification {
            task_type: task.into(),
            confidence_percent: confidence,
            difficulty,
            production_risk_percent: risk,
            needs_social_percent: 2,
            classifier_model: "jev".into(),
            latency_ms: 300,
        }
    }

    fn all_installed() -> Availability {
        let mut availability = Availability::default();
        for (provider, models) in [
            ("codex", vec!["gpt-6.1-sol", "gpt-6-luna"]),
            ("claude", vec!["haiku", "sonnet", "opus"]),
            ("opencode", vec!["default"]),
            ("grok", vec!["grok-4.7", "grok-4.6"]),
        ] {
            availability.agents.insert(
                provider.into(),
                (AccountStatus::Ready, models.into_iter().map(String::from).collect()),
            );
        }
        availability
    }

    fn pick(decision: &RouteDecision) -> String {
        describe(decision.target.as_ref().expect("a target"))
    }

    #[test]
    fn default_table_routes_by_type_difficulty_and_risk() {
        let routing = RoutingPreferences::default();
        let all = all_installed();
        let route = |c| resolve(&routing, Some(&c), None, &all, None);
        assert_eq!(pick(&route(classification("ui", 3.9, 99, 10))), "claude opus (medium)");
        assert_eq!(pick(&route(classification("mechanical", 2.0, 80, 5))), "opencode zai-coding-plan/glm-5.3");
        assert_eq!(pick(&route(classification("backend", 3.8, 99, 20))), "codex gpt-6.1-sol (medium)");
        assert_eq!(pick(&route(classification("backend", 1.6, 99, 20))), "opencode zai-coding-plan/glm-5.3");
        assert_eq!(pick(&route(classification("research", 2.6, 99, 5))), "opencode zai-coding-plan/glm-5.3");
        assert_eq!(pick(&route(classification("research", 4.5, 99, 5))), "codex gpt-6.1-sol (medium)");
        let risky = route(classification("ui", 3.0, 99, 83));
        assert_eq!(pick(&risky), "codex gpt-6.1-sol (high)");
        assert_eq!(risky.rule.as_deref(), Some("Production risk"));
    }

    #[test]
    fn low_confidence_and_classifier_failure_use_fallback() {
        let routing = RoutingPreferences::default();
        let all = all_installed();
        let unsure = resolve(&routing, Some(&classification("ui", 3.0, 30, 0)), None, &all, None);
        assert_eq!(unsure.rule, None);
        assert!(unsure.reason.contains("below the 50% bar"), "{}", unsure.reason);
        let offline = resolve(&routing, None, Some("timed out"), &all, None);
        assert_eq!(pick(&offline), "codex gpt-6.1-sol (medium)");
        assert!(offline.reason.contains("classifier unavailable (timed out)"));
    }

    #[test]
    fn skips_missing_signed_out_and_exhausted_targets() {
        let routing = RoutingPreferences::default();
        let mut availability = all_installed();
        availability.agents.remove("opencode");
        availability
            .usage
            .insert("claude".into(), (95, "Weekly limit".into()));
        let mechanical = resolve(&routing, Some(&classification("mechanical", 1.5, 90, 0)), None, &availability, None);
        // GLM missing, Sonnet over the ceiling: falls through to Easy work's Sol.
        assert_eq!(pick(&mechanical), "codex gpt-6.1-sol (low)");
        let reasons: Vec<_> = mechanical.skipped.iter().map(|s| s.reason.as_str()).collect();
        assert!(reasons.contains(&"opencode is not installed for this project"), "{reasons:?}");
        assert!(reasons.contains(&"claude weekly limit at 95%"), "{reasons:?}");

        availability.usage.insert("codex".into(), (99, "Weekly limit".into()));
        let ui = resolve(&routing, Some(&classification("ui", 3.0, 90, 0)), None, &availability, None);
        // Everything over the limit: second pass ignores limits.
        assert_eq!(pick(&ui), "claude opus (medium)");
        assert!(ui.reason.contains("past its usage limit"));

        availability.agents.insert("codex".into(), (AccountStatus::NeedsAuth, vec![]));
        let backend = resolve(&routing, Some(&classification("backend", 3.0, 90, 0)), None, &availability, None);
        assert_eq!(pick(&backend), "claude opus (medium)");
    }

    #[test]
    fn provider_restriction_keeps_auto_within_one_harness() {
        let routing = RoutingPreferences::default();
        let all = all_installed();
        let claude = AgentProvider::CLAUDE;
        let decision = resolve(&routing, Some(&classification("backend", 3.0, 90, 0)), None, &all, Some(&claude));
        assert_eq!(pick(&decision), "claude opus (medium)");
        let grok = AgentProvider::GROK;
        let decision = resolve(&routing, Some(&classification("backend", 3.0, 90, 0)), None, &all, Some(&grok));
        assert_eq!(pick(&decision), "grok");
    }

    #[test]
    fn parses_a_live_decisions_response() {
        let body: Value = serde_json::from_str(r#"{"model":"typesafe/jev-1.13-20260917","answers":{"task_type":{"type":"choice","choice":"mechanical","probabilities":{"ui":0,"backend":0.31,"mechanical":0.69},"confidence":0.59},"difficulty":{"type":"score","score":1.64,"confidence":0.67},"production_risk":{"type":"noul","noul":0.21},"needs_social":{"type":"noul","noul":0.02}},"usage":{"input_tokens":472,"output_tokens":79,"cost":0.000019824}}"#).unwrap();
        let c = parse_classification(&body, "typesafe/jev-1.13", 312).unwrap();
        assert_eq!(c.task_type, "mechanical");
        assert_eq!(c.confidence_percent, 59);
        assert_eq!(c.difficulty, 2.6);
        assert_eq!(c.production_risk_percent, 21);
        assert_eq!(c.classifier_model, "typesafe/jev-1.13-20260917");
    }

    #[test]
    fn request_lists_configured_task_types() {
        let request = decision_request(&RoutingPreferences::default(), "Fix the login test");
        assert_eq!(request["model"], DEFAULT_ROUTING_CLASSIFIER_MODEL);
        assert_eq!(request["questions"]["task_type"]["criteria"].as_object().unwrap().len(), 7);
        assert_eq!(request["questions"]["difficulty"]["criteria"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn normalize_drops_blank_entries_and_restores_task_types() {
        let mut routing = RoutingPreferences::default();
        routing.task_types = vec![falcondeck_core::RoutingTaskType { id: " ".into(), description: "x".into() }];
        routing.classifier_model = "  ".into();
        routing.fallback.push(RoutingTarget { provider: AgentProvider::new(" "), model_id: None, reasoning_effort: None });
        routing.rules[0].targets[0].model_id = Some("  ".into());
        let routing = normalize_routing(routing);
        assert_eq!(routing.task_types.len(), 7);
        assert_eq!(routing.classifier_model, DEFAULT_ROUTING_CLASSIFIER_MODEL);
        assert_eq!(routing.fallback.len(), 2);
        assert_eq!(routing.rules[0].targets[0].model_id, None);
    }
}
