use super::*;

pub(super) fn parse_models(value: &Value) -> Vec<ModelSummary> {
    let models = value
        .get("result")
        .and_then(Value::as_object)
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
        .or_else(|| value.get("data").and_then(Value::as_array))
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.as_array());

    models
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry
                .get("id")
                .or_else(|| entry.get("model"))
                .or_else(|| entry.get("slug"))
                .and_then(Value::as_str)?;
            let label = entry
                .get("displayName")
                .or_else(|| entry.get("display_name"))
                .or_else(|| entry.get("title"))
                .or_else(|| entry.get("label"))
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(id);
            Some(ModelSummary {
                id: id.to_string(),
                label: label.to_string(),
                is_default: entry
                    .get("isDefault")
                    .or_else(|| entry.get("is_default"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_reasoning_effort: extract_string(
                    entry,
                    &["defaultReasoningEffort", "default_reasoning_effort"],
                ),
                supported_reasoning_efforts: parse_reasoning_efforts(entry),
                service_tiers: parse_service_tiers(entry),
                default_service_tier: extract_string(
                    entry,
                    &["defaultServiceTier", "default_service_tier"],
                ),
            })
        })
        .collect()
}

/// Service tiers a model can run on beyond the standard tier. The app-server
/// names each tier for display ("Fast") and keys it by the id the turn request
/// takes back ("priority"); `additionalSpeedTiers` is its deprecated
/// predecessor and carries no display data, so it is ignored.
fn parse_service_tiers(value: &Value) -> Vec<ServiceTierSummary> {
    value
        .get("serviceTiers")
        .or_else(|| value.get("service_tiers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = extract_string(entry, &["id"])?;
            Some(ServiceTierSummary {
                name: extract_string(entry, &["name"]).unwrap_or_else(|| id.clone()),
                description: extract_string(entry, &["description"]).unwrap_or_default(),
                id,
            })
        })
        .collect()
}

fn parse_reasoning_efforts(value: &Value) -> Vec<ReasoningEffortSummary> {
    value
        .get("supportedReasoningEfforts")
        .or_else(|| value.get("supported_reasoning_efforts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let reasoning_effort = extract_string(entry, &["reasoningEffort", "reasoning_effort"])?;
            Some(ReasoningEffortSummary {
                reasoning_effort,
                description: extract_string(entry, &["description"]).unwrap_or_default(),
            })
        })
        .collect()
}

pub(super) fn parse_threads(
    workspace_id: &str,
    workspace_path: &str,
    value: &Value,
) -> Vec<ParsedThreadRecord> {
    let entries = extract_thread_entries(value);
    let now = Utc::now();

    entries
        .into_iter()
        .filter(|entry| {
            extract_string(entry, &["cwd"])
                .map(|cwd| cwd == workspace_path)
                .unwrap_or(true)
        })
        .filter_map(|entry| {
            let id = extract_thread_id(entry)?;
            let preview = extract_string(entry, &["preview"]);
            Some(ParsedThreadRecord {
                summary: ThreadSummary {
                    id,
                    workspace_id: workspace_id.to_string(),
                    title: extract_thread_title(entry)
                        .or(preview.clone())
                        .map(|title| truncate_preview(&title))
                        .unwrap_or_else(|| "Untitled thread".to_string()),
                    provider: AgentProvider::CODEX,
                    native_session_id: None,
                    status: ThreadStatus::Idle,
                    updated_at: extract_datetime_or_timestamp(
                        entry,
                        &[
                            "updatedAt",
                            "updated_at",
                            "lastUpdatedAt",
                            "last_updated_at",
                            "completedAt",
                            "completed_at",
                            "startedAt",
                            "started_at",
                        ],
                    )
                    .unwrap_or(now),
                    last_message_preview: preview.map(|value| truncate_preview(&value)),
                    latest_turn_id: None,
                    latest_plan: None,
                    latest_diff: None,
                    last_tool: None,
                    last_error: None,
                    agent: ThreadAgentParams {
                        model_id: extract_string(entry, &["model", "modelId", "model_id"]),
                        reasoning_effort: extract_string(
                            entry,
                            &["effort", "reasoningEffort", "reasoning_effort"],
                        ),
                        collaboration_mode_id: extract_string(
                            entry,
                            &["collaborationModeId", "collaboration_mode_id"],
                        ),
                        approval_policy: extract_string(
                            entry,
                            &["approvalPolicy", "approval_policy"],
                        ),
                        service_tier: extract_string(entry, &["serviceTier", "service_tier"]),
                        permission_mode: None,
                        sandbox_mode: None,
                    },
                    attention: ThreadAttention::default(),
                    is_archived: false,
                    is_pinned: false,
                    goal: None,
                    queued_turns: Vec::new(),
                    variant: None,
                },
                session_path: extract_string(entry, &["path"]),
            })
        })
        .collect()
}

fn extract_thread_entries(value: &Value) -> Vec<&Value> {
    fn walk(value: &Value) -> Vec<&Value> {
        if let Some(array) = value.get("threads").and_then(Value::as_array) {
            return array.iter().collect();
        }
        if let Some(array) = value.get("data").and_then(Value::as_array) {
            return array.iter().collect();
        }
        if let Some(array) = value.as_array() {
            return array.iter().collect();
        }
        if let Some(object) = value.as_object() {
            for key in ["result", "items", "results"] {
                if let Some(nested) = object.get(key) {
                    let found = walk(nested);
                    if !found.is_empty() {
                        return found;
                    }
                }
            }
        }
        Vec::new()
    }

    walk(value)
}
