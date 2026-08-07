use falcondeck_core::{
    AgentProvider, ImageInput, SelectedSkillReference, SkillSummary, ThreadIsolation, TurnInputItem,
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
                .filter(|skill| skill.supports_provider(provider))
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
    // Images are not inlined here: they travel separately to spawn_turn where
    // build_claude_stream_json_input embeds them (or degrades to a reference).
    inputs
        .iter()
        .filter_map(|input| match input {
            TurnInputItem::Text { text, .. } => {
                Some(translate_claude_text_input(text, selected_skills))
            }
            TurnInputItem::Image(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(crate) fn claude_image_reference(image: &ImageInput) -> String {
    if let Some(local_path) = image
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return format!("[image attachment: {local_path}]");
    }

    if let Some(name) = image
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("[image attachment: {name}]");
    }

    if let Some(mime_type) = image
        .mime_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("[image attachment: {mime_type}]");
    }

    let url = image.url.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        return format!("[image attachment: {url}]");
    }

    "[image attachment]".to_string()
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

/// Assistant text pulled from one Claude stream line.
pub(crate) struct ClaudeTextChunk {
    pub text: String,
    /// True for incremental token deltas, which must be concatenated
    /// verbatim. Whole-message echoes (complete `assistant` messages and the
    /// final `result`) instead supersede or dedupe against what is already
    /// accumulated, and are merged heuristically.
    pub is_delta: bool,
}

impl ClaudeTextChunk {
    fn delta(text: String) -> Self {
        Self {
            text,
            is_delta: true,
        }
    }

    fn full(text: String) -> Self {
        Self {
            text,
            is_delta: false,
        }
    }
}

pub(crate) fn extract_claude_text_chunk(value: &Value) -> Option<ClaudeTextChunk> {
    if matches!(extract_string(value, &["type"]).as_deref(), Some("result")) {
        // Error results are surfaced via `extract_claude_error`; folding them
        // into the assistant message would render the failure as agent prose.
        if value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return None;
        }
        return extract_string(value, &["result"]).map(ClaudeTextChunk::full);
    }

    // Token deltas are checked first: `content_block_delta` carries its text
    // under `delta.text`, and treating it as a whole message would re-join
    // tokens with invented whitespace ("I" + "'ll" -> "I 'll").
    let event = claude_event_value(value);
    if let Some(text) = event
        .get("delta")
        .and_then(|delta| extract_string(delta, &["text"]))
    {
        return Some(ClaudeTextChunk::delta(text));
    }
    if let Some(text) = value
        .get("delta")
        .and_then(|delta| extract_string(delta, &["text"]))
    {
        return Some(ClaudeTextChunk::delta(text));
    }
    // Legacy `completion` streaming is incremental too.
    if let Some(text) = extract_string(event, &["completion"]) {
        return Some(ClaudeTextChunk::delta(text));
    }
    if let Some(text) = extract_string(event, &["text"]) {
        return Some(ClaudeTextChunk::full(text));
    }
    if let Some(text) = value
        .get("message")
        .and_then(claude_message_text)
        .filter(|text| !text.is_empty())
    {
        return Some(ClaudeTextChunk::full(text));
    }
    if let Some(text) = extract_string(value, &["completion"]) {
        return Some(ClaudeTextChunk::delta(text));
    }
    extract_string(value, &["text"]).map(ClaudeTextChunk::full)
}

pub(crate) fn extract_claude_text_delta(value: &Value) -> Option<String> {
    extract_claude_text_chunk(value).map(|chunk| chunk.text)
}

/// Appends one streamed token delta verbatim. Whitespace inside deltas is
/// meaningful — trimming or separator heuristics belong to the whole-message
/// path in [`merge_claude_assistant_text`], not here.
pub(crate) fn append_claude_text_delta(current: &str, delta: &str) -> String {
    if current.is_empty() {
        return delta.trim_start().to_string();
    }
    format!("{current}{delta}")
}

pub(crate) fn extract_claude_tool_event(value: &Value) -> Option<ClaudeToolEvent> {
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
        let title = claude_tool_result_title(value, tool_result);
        let output = claude_tool_result_output(value, tool_result);
        return Some(ClaudeToolEvent {
            id,
            title: title.clone(),
            tool_kind: title,
            status: "completed".to_string(),
            output,
        });
    }

    if event_type == "content_block_start" {
        let content_block = event.get("content_block")?;
        if extract_string(content_block, &["type"]).as_deref() != Some("tool_use") {
            return None;
        }
        let id = extract_string(content_block, &["id"])
            .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
        let name = extract_string(content_block, &["name"]);
        let title = synthesize_claude_tool_title(name.as_deref(), content_block.get("input"), None);
        return Some(ClaudeToolEvent {
            id,
            tool_kind: name.or_else(|| Some(title.clone())),
            title: Some(title),
            status: "running".to_string(),
            output: None,
        });
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
            let name = extract_string(tool_use, &["name"]);
            let title = synthesize_claude_tool_title(name.as_deref(), tool_use.get("input"), None);
            return Some(ClaudeToolEvent {
                id,
                tool_kind: name.or_else(|| Some(title.clone())),
                title: Some(title),
                status: "running".to_string(),
                output: None,
            });
        }
    }

    if !(event_type.contains("tool") || event.get("tool_name").is_some()) {
        return None;
    }

    let id = extract_string(event, &["tool_use_id", "toolUseId", "id"])
        .unwrap_or_else(|| format!("tool-{}", Uuid::new_v4().simple()));
    let name = extract_string(event, &["tool_name", "toolName", "name"]);
    let title = synthesize_claude_tool_title(
        name.as_deref(),
        event.get("input"),
        event.get("result").or_else(|| value.get("toolUseResult")),
    );
    let status = if event_type.contains("end") || event_type.contains("result") {
        "completed"
    } else {
        "running"
    };
    let output = extract_string(event, &["output", "text"])
        .or_else(|| stringify_claude_value(event.get("result")))
        .or_else(|| stringify_claude_value(value.get("toolUseResult")));
    Some(ClaudeToolEvent {
        id,
        tool_kind: name.or_else(|| Some(title.clone())),
        title: Some(title),
        status: status.to_string(),
        output,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ClaudeToolEvent {
    pub id: String,
    pub title: Option<String>,
    pub tool_kind: Option<String>,
    pub status: String,
    pub output: Option<String>,
}

pub(super) fn extract_claude_service_message(value: &Value) -> Option<String> {
    let event_type = extract_string(claude_event_value(value), &["type", "event"])
        .or_else(|| extract_string(value, &["type"]))?;
    if matches!(event_type.as_str(), "system" | "status" | "result") {
        return extract_string(claude_event_value(value), &["message", "status", "summary"])
            .or_else(|| extract_string(value, &["message", "status", "summary"]))
            .filter(|message| !is_low_signal_service_message(message));
    }
    None
}

/// Bare lifecycle words the stream emits around hooks and turn results
/// ("requesting", "completed", …). They carry nothing the tool cards and
/// approval cards don't already show — and as conversation items they split
/// the collapsed work-session runs into one-second fragments.
fn is_low_signal_service_message(message: &str) -> bool {
    matches!(
        message.trim().to_ascii_lowercase().as_str(),
        "" | "requesting"
            | "completed"
            | "complete"
            | "in_progress"
            | "in progress"
            | "pending"
            | "running"
            | "started"
            | "starting"
            | "success"
            | "ok"
            | "done"
    )
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

pub(crate) fn extract_claude_assistant_message_id(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(|message| extract_string(message, &["id"]))
        .or_else(|| extract_string(value, &["uuid", "id"]))
}

pub(crate) fn extract_claude_user_message_text(value: &Value) -> Option<String> {
    if extract_string(value, &["type"]).as_deref() != Some("user") {
        return None;
    }

    if let Some(text) = extract_string(value, &["text"]) {
        return Some(text);
    }

    let message = value.get("message")?;
    if let Some(content) = message.get("content") {
        if let Some(text) = content.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(items) = content.as_array() {
            if items
                .iter()
                .any(|item| extract_string(item, &["type"]).as_deref() == Some("tool_result"))
            {
                return None;
            }

            let combined = items
                .iter()
                .filter(|item| extract_string(item, &["type"]).as_deref() == Some("text"))
                .filter_map(|item| extract_string(item, &["text"]))
                .collect::<Vec<_>>()
                .join("");
            let trimmed = combined.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    extract_string(message, &["text"])
}

pub(crate) fn merge_claude_assistant_text(current: &str, next_chunk: &str) -> String {
    let next_chunk = next_chunk.trim();
    if current.is_empty() {
        return next_chunk.to_string();
    }
    if next_chunk.is_empty() || current == next_chunk {
        return current.to_string();
    }
    if next_chunk.len() > 24 && current.contains(next_chunk) {
        return current.to_string();
    }
    if next_chunk.starts_with(current) {
        return next_chunk.to_string();
    }
    // The stream repeats full message text after deltas (complete `assistant`
    // messages, then the final `result`). If the accumulated text already ends
    // with this chunk it is an echo, not new output.
    if current.ends_with(next_chunk) {
        return current.to_string();
    }
    if let Some(overlap) = longest_suffix_prefix_overlap(current, next_chunk) {
        return format!("{current}{}", &next_chunk[overlap..]);
    }

    let separator = if current.ends_with('\n') || next_chunk.starts_with('\n') {
        ""
    } else if current.ends_with(['.', '!', '?', ':']) {
        "\n\n"
    } else {
        " "
    };
    format!("{current}{separator}{next_chunk}")
}

fn claude_tool_result_title(value: &Value, tool_result: &Value) -> Option<String> {
    if let Some(command_name) = value
        .get("toolUseResult")
        .and_then(|result| extract_string(result, &["commandName"]))
    {
        return Some(format!("Load skill: {command_name}"));
    }

    if let Some(query) = value
        .get("toolUseResult")
        .and_then(|result| extract_string(result, &["query"]))
    {
        return Some(format!("Search tools: {query}"));
    }

    if let Some(file_path) = value
        .get("toolUseResult")
        .and_then(|result| result.get("file"))
        .and_then(|file| extract_string(file, &["filePath", "path"]))
    {
        return Some(format!("Read {file_path}"));
    }

    if let Some(items) = tool_result.get("content").and_then(Value::as_array)
        && let Some(tool_name) = items.iter().find_map(|item| {
            if extract_string(item, &["type"]).as_deref() == Some("tool_reference") {
                extract_string(item, &["tool_name", "toolName", "name"])
            } else {
                None
            }
        })
    {
        return Some(format!("Search tools: {tool_name}"));
    }

    None
}

fn claude_tool_result_output(value: &Value, tool_result: &Value) -> Option<String> {
    stringify_claude_value(value.get("toolUseResult"))
        .or_else(|| extract_string(tool_result, &["content", "text"]))
        .or_else(|| stringify_claude_value(tool_result.get("content")))
}

fn synthesize_claude_tool_title(
    name: Option<&str>,
    input: Option<&Value>,
    result: Option<&Value>,
) -> String {
    let Some(name) = name.map(str::trim).filter(|value| !value.is_empty()) else {
        return "Claude tool".to_string();
    };

    match name.to_ascii_lowercase().as_str() {
        "read" => input
            .and_then(|input| extract_string(input, &["file_path", "filePath", "path"]))
            .map(|path| format!("Read {path}"))
            .unwrap_or_else(|| "Read".to_string()),
        "glob" => input
            .and_then(|input| {
                extract_string(input, &["pattern"]).or_else(|| extract_string(input, &["path"]))
            })
            .map(|pattern| format!("Find {pattern}"))
            .unwrap_or_else(|| "Find files".to_string()),
        "grep" => input
            .and_then(|input| {
                extract_string(input, &["pattern"]).or_else(|| extract_string(input, &["query"]))
            })
            .map(|pattern| format!("Search {pattern}"))
            .unwrap_or_else(|| "Search workspace".to_string()),
        "bash" => input
            .and_then(|input| {
                extract_string(input, &["command"])
                    .or_else(|| extract_string(input, &["description"]))
            })
            .map(|command| truncate_claude_tool_label(&command, 120))
            .unwrap_or_else(|| "Bash".to_string()),
        "webfetch" => input
            .and_then(|input| extract_string(input, &["url"]))
            .map(|url| format!("Web fetch {url}"))
            .unwrap_or_else(|| "Web fetch".to_string()),
        "toolsearch" => input
            .and_then(|input| extract_string(input, &["query"]))
            .or_else(|| result.and_then(|result| extract_string(result, &["query"])))
            .map(|query| format!("Search tools: {query}"))
            .unwrap_or_else(|| "Search tools".to_string()),
        "skill" => input
            .and_then(|input| extract_string(input, &["skill"]))
            .or_else(|| result.and_then(|result| extract_string(result, &["commandName"])))
            .map(|skill| format!("Load skill: {skill}"))
            .unwrap_or_else(|| "Load skill".to_string()),
        _ => name.to_string(),
    }
}

fn stringify_claude_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Object(object) => {
            if let Some(file_content) = object
                .get("file")
                .and_then(|file| extract_string(file, &["content"]))
            {
                return Some(file_content);
            }

            let object_value = Value::Object(object.clone());
            let mut parts = Vec::new();
            if let Some(stdout) = extract_string(&object_value, &["stdout"]) {
                parts.push(stdout);
            }
            if let Some(stderr) = extract_string(&object_value, &["stderr"]) {
                parts.push(stderr);
            }
            if let Some(result) = extract_string(&object_value, &["result"]) {
                parts.push(result);
            }
            if let Some(message) = extract_string(&object_value, &["message"]) {
                parts.push(message);
            }
            if let Some(matches) = object.get("matches").and_then(Value::as_array) {
                let rendered = matches
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ");
                if !rendered.is_empty() {
                    parts.push(rendered);
                }
            }
            if let Some(filenames) = object.get("filenames").and_then(Value::as_array) {
                let rendered = filenames
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n");
                if !rendered.is_empty() {
                    parts.push(rendered);
                }
            }

            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n").trim().to_string())
            }
        }
        Value::Array(items) => {
            let rendered = items
                .iter()
                .filter_map(|item| {
                    extract_string(item, &["text", "tool_name", "toolName", "name"])
                        .or_else(|| item.as_str().map(ToOwned::to_owned))
                })
                .collect::<Vec<_>>()
                .join("\n");
            let trimmed = rendered.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        other => Some(other.to_string()),
    }
}

fn truncate_claude_tool_label(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }

    let mut result = trimmed
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

fn longest_suffix_prefix_overlap(current: &str, next: &str) -> Option<usize> {
    let max = current.len().min(next.len());
    (16..=max)
        .rev()
        .find(|size| current.ends_with(&next[..*size]))
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

// Provider ids are open-ended (ACP providers arrive via providers.json), so any
// non-empty id passes through — mapping unknown providers to None would make
// remote callers silently fall back to the workspace default and run their
// turns on the wrong agent. Mirrors normalizeProvider in client-core.
pub(super) fn parse_agent_provider(value: String) -> Option<AgentProvider> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(AgentProvider::new(normalized))
    }
}

/// Reads the isolation choice off a remote `thread.start` payload. Unlike
/// provider ids, an unrecognised value falls back to the project folder:
/// creating a checkout nobody asked for is the costlier mistake, and it is the
/// one the caller cannot undo.
pub(super) fn parse_thread_isolation(params: &serde_json::Value) -> ThreadIsolation {
    match extract_string(params, &["isolation"]).as_deref() {
        Some("isolated") => ThreadIsolation::Isolated,
        _ => ThreadIsolation::ProjectFolder,
    }
}

#[cfg(test)]
mod service_message_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hook_lifecycle_chatter_is_filtered_from_service_messages() {
        for noise in ["requesting", "completed", "Success", " in_progress "] {
            let event = json!({ "type": "status", "status": noise });
            assert_eq!(
                extract_claude_service_message(&event),
                None,
                "bare '{noise}' must not become a conversation item"
            );
        }
    }

    #[test]
    fn informative_service_messages_still_pass() {
        let event = json!({
            "type": "system",
            "message": "Context low — auto-compacting the conversation"
        });
        assert_eq!(
            extract_claude_service_message(&event).as_deref(),
            Some("Context low — auto-compacting the conversation")
        );
    }
}
