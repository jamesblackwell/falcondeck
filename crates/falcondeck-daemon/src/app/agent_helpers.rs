use falcondeck_core::{
    AgentProvider, CollaborationModeSummary, SelectedSkillReference, SkillSummary, TurnInputItem,
    WorkspaceSummary,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{codex::extract_string, skills::canonical_skill_alias};

#[derive(Debug, Clone)]
pub(super) struct ResolvedSelectedSkill {
    pub(super) alias: String,
    pub(super) summary: SkillSummary,
}

pub(super) fn resolve_selected_skills(
    available_skills: &[SkillSummary],
    selected_skills: &[SelectedSkillReference],
    provider: &AgentProvider,
) -> Vec<ResolvedSelectedSkill> {
    selected_skills
        .iter()
        .filter_map(|selection| {
            available_skills
                .iter()
                .find(|skill| {
                    skill.id == selection.skill_id
                        || skill.alias.eq_ignore_ascii_case(&selection.alias)
                        || canonical_skill_alias(&skill.alias)
                            == canonical_skill_alias(&selection.alias)
                })
                .filter(|skill| {
                    matches!(
                        (provider, &skill.availability),
                        (
                            AgentProvider::Codex,
                            falcondeck_core::SkillAvailability::Codex
                        ) | (
                            AgentProvider::Codex,
                            falcondeck_core::SkillAvailability::Both
                        ) | (
                            AgentProvider::Claude,
                            falcondeck_core::SkillAvailability::Claude
                        ) | (
                            AgentProvider::Claude,
                            falcondeck_core::SkillAvailability::Both
                        )
                    )
                })
                .cloned()
                .map(|summary| ResolvedSelectedSkill {
                    alias: selection.alias.clone(),
                    summary,
                })
        })
        .collect()
}

pub(super) fn codex_inputs(
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
) -> Vec<Value> {
    let fallback_text_skill_names = selected_skills
        .iter()
        .filter_map(|skill| {
            skill
                .summary
                .provider_translations
                .codex
                .as_ref()
                .and_then(|translation| {
                    if translation.native_id.is_some() {
                        None
                    } else {
                        translation.native_name.clone()
                    }
                })
        })
        .collect::<Vec<_>>();
    let mut structured_skill_inputs = selected_skills
        .iter()
        .filter_map(|skill| {
            skill
                .summary
                .provider_translations
                .codex
                .as_ref()
                .and_then(|translation| translation.native_id.clone())
                .map(|native_id| {
                    let name = skill
                        .summary
                        .provider_translations
                        .codex
                        .as_ref()
                        .and_then(|translation| translation.native_name.clone())
                        .unwrap_or_else(|| native_id.clone());
                    json!({
                        "type": "skill",
                        "id": native_id,
                        "name": name,
                    })
                })
        })
        .collect::<Vec<_>>();
    let mut translated_inputs = Vec::new();

    if !structured_skill_inputs.is_empty() {
        translated_inputs.append(&mut structured_skill_inputs);
    }

    inputs
        .iter()
        .map(|item| match item {
            TurnInputItem::Text { text, .. } => {
                let translated = replace_selected_skill_aliases(text, selected_skills, |skill| {
                    skill
                        .summary
                        .provider_translations
                        .codex
                        .as_ref()
                        .and_then(|translation| {
                            if translation.native_id.is_some() {
                                None
                            } else {
                                translation.native_name.clone()
                            }
                        })
                        .map(|name| format!("${name}"))
                });
                json!({
                    "type": "text",
                    "text": translated,
                })
            }
            TurnInputItem::Image(image) => {
                if let Some(local_path) = image
                    .local_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                {
                    json!({
                        "type": "localImage",
                        "path": local_path,
                    })
                } else if image.url.starts_with("http://")
                    || image.url.starts_with("https://")
                    || image.url.starts_with("data:")
                {
                    json!({
                        "type": "image",
                        "url": image.url,
                    })
                } else {
                    json!({
                        "type": "localImage",
                        "path": image.url,
                    })
                }
            }
        })
        .for_each(|item| translated_inputs.push(item));

    if translated_inputs
        .iter()
        .all(|entry| entry.get("type").and_then(Value::as_str) != Some("text"))
        && !fallback_text_skill_names.is_empty()
    {
        translated_inputs.push(json!({
            "type": "text",
            "text": fallback_text_skill_names
                .into_iter()
                .map(|name| format!("${name}"))
                .collect::<Vec<_>>()
                .join("\n"),
        }));
    }

    translated_inputs
}

pub(super) fn claude_prompt_from_inputs(
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
) -> String {
    inputs
        .iter()
        .map(|input| match input {
            TurnInputItem::Text { text, .. } => translate_claude_text_input(text, selected_skills),
            TurnInputItem::Image(image) => image
                .local_path
                .as_ref()
                .map(|path| format!("[image attachment: {path}]"))
                .unwrap_or_else(|| format!("[image attachment: {}]", image.url)),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn translate_claude_text_input(text: &str, selected_skills: &[ResolvedSelectedSkill]) -> String {
    let mut translated = replace_selected_skill_aliases(text, selected_skills, |skill| {
        skill
            .summary
            .provider_translations
            .claude
            .as_ref()
            .and_then(|translation| translation.command_name.clone())
            .map(|name| format!("/{name}"))
    });

    let prompt_preambles = selected_skills
        .iter()
        .filter_map(|skill| {
            skill.summary
                .provider_translations
                .claude
                .as_ref()
                .and_then(|translation| {
                    if translation.command_name.is_some() {
                        None
                    } else {
                        translation.prompt_reference_path.as_ref().map(|path| {
                            format!(
                                "Use the FalconDeck skill defined at {path}. Follow it as the governing skill for this request."
                            )
                        })
                    }
                })
        })
        .collect::<Vec<_>>();

    if translated.trim().is_empty() && !selected_skills.is_empty() {
        translated = selected_skills
            .iter()
            .filter_map(|skill| {
                skill
                    .summary
                    .provider_translations
                    .claude
                    .as_ref()
                    .and_then(|translation| translation.command_name.clone())
                    .map(|name| format!("/{name}"))
            })
            .collect::<Vec<_>>()
            .join("\n");
    }

    if prompt_preambles.is_empty() {
        translated
    } else if translated.trim().is_empty() {
        prompt_preambles.join("\n\n")
    } else {
        format!("{}\n\n{translated}", prompt_preambles.join("\n\n"))
    }
}

fn replace_selected_skill_aliases<F>(
    text: &str,
    selected_skills: &[ResolvedSelectedSkill],
    replacement_for_skill: F,
) -> String
where
    F: Fn(&ResolvedSelectedSkill) -> Option<String>,
{
    let mut translated = text.to_string();
    for skill in selected_skills {
        let alias = canonical_skill_alias(&skill.alias);
        let Some(replacement) = replacement_for_skill(skill) else {
            continue;
        };
        if translated.contains(&alias) {
            translated = translated.replacen(&alias, &replacement, 1);
        }
    }
    translated
}

pub(super) fn is_claude_plan_mode(mode_id: Option<&str>) -> bool {
    mode_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.eq_ignore_ascii_case("plan"))
        .unwrap_or(false)
}

pub(super) fn extract_claude_text_delta(value: &Value) -> Option<String> {
    if matches!(extract_string(value, &["type"]).as_deref(), Some("result")) {
        return extract_string(value, &["result"]);
    }

    let event = claude_event_value(value);
    if let Some(text) = extract_string(event, &["text", "completion"]) {
        return Some(text);
    }
    if let Some(text) = event
        .get("delta")
        .and_then(|delta| extract_string(delta, &["text"]))
    {
        return Some(text);
    }
    if let Some(text) = value
        .get("message")
        .and_then(claude_message_text)
        .filter(|text| !text.is_empty())
    {
        return Some(text);
    }
    if let Some(text) = extract_string(value, &["text", "completion"]) {
        return Some(text);
    }
    value
        .get("delta")
        .and_then(|delta| extract_string(delta, &["text"]))
}

pub(super) fn extract_claude_tool_event(
    value: &Value,
) -> Option<(String, String, String, Option<String>)> {
    let top_level_type = extract_string(value, &["type"]);
    let event = claude_event_value(value);
    let event_type =
        extract_string(event, &["type", "event"]).or_else(|| top_level_type.clone())?;

    if top_level_type.as_deref() == Some("user") {
        let tool_result = value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| extract_string(item, &["type"]).as_deref() == Some("tool_result"))
            })?;
        let id = extract_string(tool_result, &["tool_use_id", "toolUseId", "id"])
            .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
        let output = extract_string(tool_result, &["content", "text"]);
        return Some((
            id,
            "Claude tool".to_string(),
            "completed".to_string(),
            output,
        ));
    }

    if event_type == "content_block_start" {
        let content_block = event.get("content_block")?;
        if extract_string(content_block, &["type"]).as_deref() != Some("tool_use") {
            return None;
        }
        let id = extract_string(content_block, &["id"])
            .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
        let title =
            extract_string(content_block, &["name"]).unwrap_or_else(|| "Claude tool".to_string());
        return Some((id, title, "running".to_string(), None));
    }

    if top_level_type.as_deref() == Some("assistant") {
        let tool_use = value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| extract_string(item, &["type"]).as_deref() == Some("tool_use"))
            });
        if let Some(tool_use) = tool_use {
            let id = extract_string(tool_use, &["id"])
                .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
            let title =
                extract_string(tool_use, &["name"]).unwrap_or_else(|| "Claude tool".to_string());
            return Some((id, title, "running".to_string(), None));
        }
    }

    if !(event_type.contains("tool") || event.get("tool_name").is_some()) {
        return None;
    }

    let id = extract_string(event, &["tool_use_id", "toolUseId", "id"])
        .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
    let title = extract_string(event, &["tool_name", "toolName", "name"])
        .unwrap_or_else(|| "Claude tool".to_string());
    let status = if event_type.contains("end") || event_type.contains("result") {
        "completed"
    } else {
        "running"
    };
    let output = extract_string(event, &["output", "result", "text"]);
    Some((id, title, status.to_string(), output))
}

pub(super) fn extract_claude_service_message(value: &Value) -> Option<String> {
    let event_type = extract_string(claude_event_value(value), &["type", "event"])
        .or_else(|| extract_string(value, &["type"]))?;
    if matches!(event_type.as_str(), "system" | "status" | "result") {
        return extract_string(claude_event_value(value), &["message", "status", "summary"])
            .or_else(|| extract_string(value, &["message", "status", "summary"]));
    }
    None
}

pub(super) fn extract_claude_error(value: &Value) -> Option<String> {
    if extract_string(value, &["type"]).as_deref() == Some("result")
        && value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return extract_string(value, &["result"])
            .or_else(|| extract_string(value, &["subtype"]))
            .or_else(|| Some("Claude turn failed".to_string()));
    }

    let event = claude_event_value(value);
    extract_string(event, &["error", "message"])
        .or_else(|| extract_string(value, &["error", "message"]))
        .filter(|_| {
            extract_string(event, &["type", "event"])
                .or_else(|| extract_string(value, &["type"]))
                .map(|event| event.contains("error"))
                .unwrap_or(false)
                || value.get("error").is_some()
        })
}

pub(super) fn merge_claude_assistant_text(current: &str, next_chunk: &str) -> String {
    if current.is_empty() {
        return next_chunk.to_string();
    }
    if next_chunk.is_empty() || current == next_chunk {
        return current.to_string();
    }
    if next_chunk.starts_with(current) {
        return next_chunk.to_string();
    }
    format!("{current}{next_chunk}")
}

fn claude_event_value(value: &Value) -> &Value {
    value.get("event").unwrap_or(value)
}

fn claude_message_text(value: &Value) -> Option<String> {
    let content = value.get("content")?.as_array()?;
    let mut parts = Vec::new();
    for item in content {
        if extract_string(item, &["type"]).as_deref() != Some("text") {
            continue;
        }
        if let Some(text) = extract_string(item, &["text"]) {
            parts.push(text);
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(""))
    }
}

pub(super) fn parse_agent_provider(value: String) -> Option<AgentProvider> {
    match value.trim().to_ascii_lowercase().as_str() {
        "codex" => Some(AgentProvider::Codex),
        "claude" => Some(AgentProvider::Claude),
        _ => None,
    }
}

pub(super) fn codex_inputs_with_plan_mode_shim(
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
    use_plan_mode_shim: bool,
) -> Vec<Value> {
    if !use_plan_mode_shim {
        return codex_inputs(inputs, selected_skills);
    }

    let mut shimmed_inputs = vec![json!({
        "type": "text",
        "text": plan_mode_prompt_shim(),
    })];
    shimmed_inputs.extend(codex_inputs(inputs, selected_skills));
    shimmed_inputs
}

fn plan_mode_prompt_shim() -> &'static str {
    "Enter plan mode for this turn. Explore first, ask clarifying questions if needed, and produce a decision-complete implementation plan before making repo-tracked changes. Do not perform mutating work until the user explicitly exits plan mode."
}

fn mode_matches_plan(mode: &CollaborationModeSummary) -> bool {
    mode.mode
        .as_deref()
        .unwrap_or(mode.id.as_str())
        .eq_ignore_ascii_case("plan")
}

pub(super) fn should_use_plan_mode_shim(
    summary: &WorkspaceSummary,
    provider: &AgentProvider,
    mode_id: Option<&str>,
) -> bool {
    let agent = summary
        .agents
        .iter()
        .find(|agent| &agent.provider == provider);
    let supports_plan_mode = agent
        .map(|agent| agent.supports_plan_mode)
        .unwrap_or(summary.supports_plan_mode);
    let supports_native_plan_mode = agent
        .map(|agent| agent.supports_native_plan_mode)
        .unwrap_or(summary.supports_native_plan_mode);

    if !supports_plan_mode || supports_native_plan_mode {
        return false;
    }

    let Some(mode_id) = mode_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };

    agent
        .map(|agent| &agent.collaboration_modes)
        .unwrap_or(&summary.collaboration_modes)
        .iter()
        .find(|mode| mode.id == mode_id)
        .map(mode_matches_plan)
        .unwrap_or_else(|| mode_id.eq_ignore_ascii_case("plan"))
}

pub(super) fn collaboration_mode_payload(
    mode_id: Option<&str>,
    selected_model_id: Option<&str>,
    reasoning_effort: Option<&str>,
    supports_native_plan_mode: bool,
) -> Value {
    if !supports_native_plan_mode {
        return Value::Null;
    }

    let Some(mode_id) = mode_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Value::Null;
    };

    let mut settings = serde_json::Map::new();
    if let Some(model_id) = selected_model_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        settings.insert("model".to_string(), json!(model_id));
    }
    if let Some(reasoning_effort) = reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        settings.insert("reasoning_effort".to_string(), json!(reasoning_effort));
    }

    json!({
        "mode": mode_id,
        "settings": settings,
    })
}
