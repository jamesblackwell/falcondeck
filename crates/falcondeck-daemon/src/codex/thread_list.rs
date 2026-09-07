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

pub(super) fn parse_collaboration_modes(value: &Value) -> Vec<CollaborationModeSummary> {
    value
        .get("result")
        .and_then(|result| result.get("data"))
        .or_else(|| value.get("data"))
        .or_else(|| value.get("modes"))
        .or_else(|| value.as_array().map(|_| value))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let mode = extract_string(entry, &["mode", "id"])?;
            Some(CollaborationModeSummary {
                id: mode.clone(),
                label: extract_string(entry, &["name", "label"]).unwrap_or_else(|| mode.clone()),
                mode: Some(mode),
                model_id: extract_string(entry, &["model", "modelId", "model_id"]),
                reasoning_effort: extract_string(entry, &["reasoningEffort", "reasoning_effort"]),
                is_native: true,
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

// User-created forks also have forkedFromId, so only source/parent metadata
// identifies child agents. Older app-servers may omit parentThreadId.
fn is_subagent_thread(thread: &Value) -> bool {
    thread
        .get("parentThreadId")
        .and_then(Value::as_str)
        .is_some()
        || thread
            .get("source")
            .and_then(|source| source.get("subAgent"))
            .is_some()
}

impl CodexSession {
    /// Identify saved sidebar entries created by older daemons. Only metadata
    /// is listed; native sessions and transcripts are never deleted.
    pub(crate) async fn subagent_thread_ids(&self) -> Result<HashSet<String>, DaemonError> {
        let mut ids = HashSet::new();
        let mut cursor = None::<String>;
        loop {
            let page = self
                .send_control_request(
                    "thread/list",
                    json!({
                        "limit": 100,
                        "cwd": self.workspace_path(),
                        "sourceKinds": ["subAgent"],
                        "cursor": cursor,
                    }),
                )
                .await?;
            ids.extend(
                extract_thread_entries(&page)
                    .into_iter()
                    .filter(|thread| is_subagent_thread(thread))
                    .filter_map(extract_thread_id),
            );
            let next = extract_string(&page, &["nextCursor"]);
            if next.is_none() || next == cursor {
                break;
            }
            cursor = next;
        }
        Ok(ids)
    }
}

#[derive(Default)]
pub(super) struct SubagentNotifications {
    thread_ids: HashSet<String>,
}

impl SubagentNotifications {
    pub(super) fn should_ignore(&mut self, method: &str, params: &Value) -> bool {
        let Some(thread_id) = extract_thread_id(params) else {
            return false;
        };
        if method == "thread/started" && is_subagent_thread(params.get("thread").unwrap_or(params))
        {
            self.thread_ids.insert(thread_id.clone());
        }
        // Keep IDs for this app-server's lifetime: status/turn/item events
        // omit source metadata and can otherwise recreate sidebar entries.
        self.thread_ids.contains(&thread_id)
    }
}

pub(super) fn parse_threads(
    workspace_id: &str,
    workspace_path: &str,
    value: &Value,
) -> Vec<HydratedThread> {
    let entries = extract_thread_entries(value);
    let now = Utc::now();

    entries
        .into_iter()
        .filter(|entry| !is_subagent_thread(entry))
        .filter(|entry| {
            extract_string(entry, &["cwd"])
                .map(|cwd| cwd == workspace_path)
                .unwrap_or(true)
        })
        .filter_map(|entry| {
            let id = extract_thread_id(entry)?;
            let preview =
                extract_string(entry, &["preview"]).and_then(|text| sanitize_codex_preview(&text));
            let provider_title = extract_thread_title(entry);
            Some(HydratedThread {
                summary: ThreadSummary {
                    id: id.clone(),
                    workspace_id: workspace_id.to_string(),
                    title: provider_title
                        .clone()
                        .or(preview.clone())
                        .map(|title| truncate_preview(&title))
                        .unwrap_or_else(|| "Untitled thread".to_string()),
                    provider: AgentProvider::CODEX,
                    native_session_id: Some(id),
                    provider_transport: None,
                    handoff_from: None,
                    origin: None,
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
                    last_message_preview: preview.as_deref().map(truncate_preview),
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
                    is_pinned_in_project: false,
                    goal: None,
                    queued_turns: Vec::new(),
                    variant: None,
                },
                items: Vec::new(),
                title_is_provider_preview: provider_title.is_none() && preview.is_some(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_list_excludes_codex_subagents_but_keeps_user_forks() {
        let threads = parse_threads(
            "workspace",
            "/repo",
            &json!({"data": [
                {"id": "root", "source": "appServer"},
                {"id": "child", "source": {"subAgent": {"thread_spawn": {
                    "parent_thread_id": "root", "depth": 1
                }}}},
                {"id": "review", "source": {"subAgent": "review"}},
                {"id": "compact", "source": {"subAgent": "compact"}},
                {"id": "other", "source": {"subAgent": {"other": "worker"}}},
                {"id": "parent-marked", "source": "unknown", "parentThreadId": "root"},
                {"id": "fork", "source": "cli", "forkedFromId": "root", "parentThreadId": null},
                {"id": "legacy"}
            ]}),
        );
        assert_eq!(
            threads
                .iter()
                .map(|thread| thread.summary.id.as_str())
                .collect::<Vec<_>>(),
            ["root", "fork", "legacy"]
        );
    }

    #[test]
    fn subagent_notifications_filter_the_entire_child_lifecycle() {
        let mut filter = SubagentNotifications::default();
        for child in [
            json!({"id": "child", "source": {"subAgent": {"thread_spawn": {
                "parent_thread_id": "root", "depth": 1
            }}}}),
            json!({"id": "parent-marked", "parentThreadId": "root"}),
        ] {
            assert!(filter.should_ignore("thread/started", &json!({"thread": child})));
            for method in [
                "thread/status/changed",
                "turn/started",
                "item/started",
                "item/agentMessage/delta",
                "turn/completed",
                "thread/closed",
                "thread/status/changed",
            ] {
                assert!(
                    filter.should_ignore(method, &json!({"threadId": child["id"]})),
                    "{method}"
                );
                assert!(
                    !filter.should_ignore(method, &json!({"threadId": "root"})),
                    "{method}"
                );
            }
        }
        // Collaboration activity belongs to the parent transcript and stays visible.
        assert!(!filter.should_ignore(
            "item/started",
            &json!({
                "threadId": "root", "item": {"type": "subAgentActivity", "threadId": "child"}
            })
        ));
        assert!(!filter.should_ignore(
            "thread/started",
            &json!({"thread": {
                "id": "fork", "forkedFromId": "root", "source": "appServer", "parentThreadId": null
            }})
        ));
        assert!(!filter.should_ignore("account/updated", &json!({})));
    }
}
