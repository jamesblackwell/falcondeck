use falcondeck_core::{
    AgentProvider, ConversationCitation, ConversationCitationLocator, ImageInput,
    SelectedSkillReference, SkillSummary, ThreadIsolation, TurnInputItem,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    app::conversation_helpers::should_suppress_tool_output, codex::extract_string,
    skills::canonical_skill_alias,
};

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
    /// Citation objects explicitly attached to this content by Claude. Search
    /// tool calls alone never populate this field.
    pub citations: Vec<ConversationCitation>,
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
            citations: Vec::new(),
            is_delta: true,
        }
    }

    fn full(text: String, citations: Vec<ConversationCitation>) -> Self {
        Self {
            text,
            citations,
            is_delta: false,
        }
    }
}

pub(crate) fn extract_claude_text_chunk(value: &Value) -> Option<ClaudeTextChunk> {
    // User records carry prompts, steering echoes, and tool results — never
    // assistant prose. Without this guard their text lands in the assistant
    // transcript: hydrated sessions show the user's own prompts as agent
    // bubbles, and a steered message gets folded into the live reply.
    if matches!(extract_string(value, &["type"]).as_deref(), Some("user")) {
        return None;
    }
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
        return extract_string(value, &["result"])
            .map(|text| ClaudeTextChunk::full(text, Vec::new()));
    }

    let citations = extract_claude_citations(value);

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
        return Some(ClaudeTextChunk::full(text, citations));
    }
    if let Some(text) = value
        .get("message")
        .and_then(claude_message_text)
        .filter(|text| !text.is_empty())
    {
        return Some(ClaudeTextChunk::full(text, citations));
    }
    if let Some(text) = extract_string(value, &["completion"]) {
        return Some(ClaudeTextChunk::delta(text));
    }
    if let Some(text) = extract_string(value, &["text"]) {
        return Some(ClaudeTextChunk::full(text, citations));
    }
    (!citations.is_empty()).then(|| ClaudeTextChunk::full(String::new(), citations))
}

/// Thinking content pulled from one Claude stream line: `thinking_delta`
/// stream events plus complete `thinking` content blocks (assistant echoes
/// and session-file records). Delta/full semantics match [`ClaudeTextChunk`].
pub(crate) fn extract_claude_thinking_chunk(value: &Value) -> Option<ClaudeTextChunk> {
    if matches!(
        extract_string(value, &["type"]).as_deref(),
        Some("user") | Some("result")
    ) {
        return None;
    }
    let event = claude_event_value(value);
    for delta in [event.get("delta"), value.get("delta")]
        .into_iter()
        .flatten()
    {
        if let Some(text) = extract_string(delta, &["thinking"]) {
            return Some(ClaudeTextChunk::delta(text));
        }
    }
    value
        .get("message")
        .and_then(claude_message_thinking)
        .map(|text| ClaudeTextChunk::full(text, Vec::new()))
}

/// Message id of the API message a stream line belongs to: complete
/// `assistant` echoes carry it as `message.id`, `message_start` events under
/// `event.message.id`. Deltas carry none and belong to the current message.
pub(crate) fn claude_stream_message_id(value: &Value) -> Option<String> {
    if extract_string(value, &["type"]).as_deref() == Some("assistant") {
        return value
            .get("message")
            .and_then(|message| extract_string(message, &["id"]));
    }
    if is_claude_message_start(value) {
        return claude_event_value(value)
            .get("message")
            .and_then(|message| extract_string(message, &["id"]));
    }
    None
}

pub(crate) fn is_claude_message_start(value: &Value) -> bool {
    extract_string(claude_event_value(value), &["type"]).as_deref() == Some("message_start")
}

fn extract_claude_citations(value: &Value) -> Vec<ConversationCitation> {
    fn non_empty_string(entry: &Value, key: &str) -> Option<String> {
        entry
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    fn locator(entry: &Value, kind: &str) -> Option<ConversationCitationLocator> {
        let integer = |key: &str| entry.get(key).and_then(Value::as_u64);
        let file_id = non_empty_string(entry, "file_id");
        match kind {
            "web_search_result_location" => Some(ConversationCitationLocator::WebSearch {
                encrypted_index: non_empty_string(entry, "encrypted_index")?,
            }),
            "search_result_location" => Some(ConversationCitationLocator::SearchResult {
                search_result_index: integer("search_result_index")?,
                start_block_index: integer("start_block_index")?,
                end_block_index: integer("end_block_index")?,
            }),
            "char_location" => Some(ConversationCitationLocator::Char {
                document_index: integer("document_index")?,
                start_char_index: integer("start_char_index")?,
                end_char_index: integer("end_char_index")?,
                file_id,
            }),
            "page_location" => Some(ConversationCitationLocator::Page {
                document_index: integer("document_index")?,
                start_page_number: integer("start_page_number")?,
                end_page_number: integer("end_page_number")?,
                file_id,
            }),
            "content_block_location" => Some(ConversationCitationLocator::ContentBlock {
                document_index: integer("document_index")?,
                start_block_index: integer("start_block_index")?,
                end_block_index: integer("end_block_index")?,
                file_id,
            }),
            _ => None,
        }
    }

    fn push_from_array(output: &mut Vec<ConversationCitation>, value: Option<&Value>) {
        let Some(entries) = value.and_then(Value::as_array) else {
            return;
        };
        for entry in entries {
            let Some(kind) = extract_string(entry, &["type"]).filter(|kind| !kind.is_empty())
            else {
                continue;
            };
            let locator = locator(entry, &kind);
            let citation = ConversationCitation {
                id: None,
                kind,
                url: extract_string(entry, &["url"]),
                source: extract_string(entry, &["source"]),
                title: extract_string(entry, &["title", "document_title"]),
                cited_text: extract_string(entry, &["cited_text"]),
                locator,
            };
            if (citation.url.is_some()
                || citation.source.is_some()
                || citation.title.is_some()
                || citation.cited_text.is_some())
                && !output.contains(&citation)
            {
                output.push(citation);
            }
        }
    }

    let mut citations = Vec::new();
    if let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    {
        for block in content {
            push_from_array(&mut citations, block.get("citations"));
        }
    }
    let event = claude_event_value(value);
    push_from_array(
        &mut citations,
        event
            .get("content_block")
            .and_then(|block| block.get("citations")),
    );
    for delta in [event.get("delta"), value.get("delta")]
        .into_iter()
        .flatten()
    {
        if let Some(citation) = delta.get("citation") {
            push_from_array(&mut citations, Some(&Value::Array(vec![citation.clone()])));
        }
    }
    citations
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

/// Sub-agent traffic in the stream is tagged with the id of the Task/Agent
/// tool call that spawned it; main-loop events carry no such tag. Everything
/// tagged must be kept out of the main transcript accumulation paths.
pub(crate) fn claude_parent_tool_use_id(value: &Value) -> Option<&str> {
    value.get("parent_tool_use_id").and_then(Value::as_str)
}

/// Most recent steps a sub-agent has taken, rendered as the spawning tool
/// call's live output so the card has something truthful to show while the
/// sub-agent works out of view.
pub(crate) const SUBAGENT_ACTIVITY_KEPT_STEPS: usize = 24;

pub(crate) fn format_subagent_activity(steps: &[String], dropped: usize) -> String {
    let mut lines = Vec::with_capacity(steps.len() + 2);
    lines.push("Sub-agent activity:".to_string());
    if dropped > 0 {
        lines.push(format!(
            "… {dropped} earlier step{} hidden",
            plural_s(dropped)
        ));
    }
    for step in steps {
        lines.push(format!("· {step}"));
    }
    lines.join("\n")
}

fn plural_s(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
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
        let output = if title
            .as_deref()
            .is_some_and(|title| should_suppress_tool_output(title, ""))
        {
            None
        } else {
            claude_tool_result_output(value, tool_result)
        };
        // A failed tool is still delivered as an ordinary tool_result — only
        // the is_error flag (or an "Error:" toolUseResult string) says so.
        let failed = tool_result
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || value
                .get("toolUseResult")
                .and_then(Value::as_str)
                .is_some_and(|result| result.trim_start().starts_with("Error:"));
        return Some(ClaudeToolEvent {
            id,
            title: title.clone(),
            tool_kind: title,
            status: if failed { "failed" } else { "completed" }.to_string(),
            output,
            images: claude_tool_result_images(value, tool_result),
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
            images: Vec::new(),
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
                images: Vec::new(),
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
    let output = if should_suppress_tool_output(&title, name.as_deref().unwrap_or_default()) {
        None
    } else {
        extract_string(event, &["output", "text"])
            .or_else(|| stringify_claude_value(event.get("result")))
            .or_else(|| stringify_claude_value(value.get("toolUseResult")))
    };
    Some(ClaudeToolEvent {
        id,
        tool_kind: name.or_else(|| Some(title.clone())),
        title: Some(title),
        status: status.to_string(),
        output,
        images: claude_tool_result_images(value, event),
    })
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ClaudeToolEvent {
    pub id: String,
    pub title: Option<String>,
    pub tool_kind: Option<String>,
    pub status: String,
    pub output: Option<String>,
    /// Base64 images carried by the tool_result (screenshots, image reads).
    pub images: Vec<ClaudeToolResultImage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClaudeToolResultImage {
    pub media_type: String,
    pub data: String,
}

/// Collects base64 image blocks from a tool_result (and its session-file
/// `toolUseResult` mirror). Text extraction drops these, which previously
/// meant a screenshot the model saw left no trace in the transcript.
fn claude_tool_result_images(value: &Value, tool_result: &Value) -> Vec<ClaudeToolResultImage> {
    // Persisted thread items embed these as data URLs, so keep hard budgets:
    // enough for real screenshots, small enough not to bloat state files.
    const MAX_IMAGES: usize = 4;
    const MAX_ENCODED_CHARS: usize = 5_000_000;
    let mut images = Vec::new();
    let sources = [
        tool_result.get("content"),
        value.pointer("/toolUseResult/content"),
    ];
    for blocks in sources.into_iter().flatten().filter_map(Value::as_array) {
        for block in blocks {
            if images.len() >= MAX_IMAGES {
                return images;
            }
            if extract_string(block, &["type"]).as_deref() != Some("image") {
                continue;
            }
            let Some(source) = block.get("source") else {
                continue;
            };
            if extract_string(source, &["type"]).as_deref() != Some("base64") {
                continue;
            }
            let Some(data) = source
                .get("data")
                .and_then(Value::as_str)
                .filter(|data| !data.is_empty() && data.len() <= MAX_ENCODED_CHARS)
            else {
                continue;
            };
            let media_type = extract_string(source, &["media_type", "mediaType"])
                .unwrap_or_else(|| "image/png".to_string());
            let image = ClaudeToolResultImage {
                media_type,
                data: data.to_string(),
            };
            // The stream event and the session-file mirror can both carry the
            // same block; keep one.
            if !images.contains(&image) {
                images.push(image);
            }
        }
    }
    images
}

/// Builds renderable image items for a tool result's base64 images, keyed
/// deterministically per tool call so re-emits replace rather than duplicate.
pub(crate) fn claude_tool_result_image_items(
    tool_id: &str,
    title: &str,
    images: &[ClaudeToolResultImage],
) -> Vec<falcondeck_core::ConversationItem> {
    images
        .iter()
        .enumerate()
        .map(|(index, image)| {
            let id = format!("{tool_id}-image-{index}");
            falcondeck_core::ConversationItem::Image {
                id: id.clone(),
                title: Some(title.to_string()),
                image: falcondeck_core::ConversationImage {
                    id: format!("{id}-asset"),
                    name: None,
                    mime_type: Some(image.media_type.clone()),
                    url: format!("data:{};base64,{}", image.media_type, image.data),
                    local_path: None,
                    alt_text: None,
                },
                lifecycle: falcondeck_core::ContentLifecycle::Complete,
                created_at: chrono::Utc::now(),
            }
        })
        .collect()
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
        return accept_claude_user_text(text);
    }

    let message = value.get("message")?;
    if let Some(content) = message.get("content") {
        if let Some(text) = content.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return accept_claude_user_text(trimmed.to_string());
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
                return accept_claude_user_text(trimmed.to_string());
            }
        }
    }

    extract_string(message, &["text"]).and_then(accept_claude_user_text)
}

/// Recovers pasted image attachments from a Claude session-log user message.
///
/// Tool-result messages are skipped: images inside them belong to the
/// assistant's tool output, not to the user's prompt. Base64 blocks come back
/// as inline data URLs so the hydrator can materialize them to disk; url
/// blocks pass through as-is.
pub(crate) fn extract_claude_user_message_images(value: &Value) -> Vec<ImageInput> {
    if extract_string(value, &["type"]).as_deref() != Some("user") {
        return Vec::new();
    }
    let Some(blocks) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    if blocks
        .iter()
        .any(|block| extract_string(block, &["type"]).as_deref() == Some("tool_result"))
    {
        return Vec::new();
    }

    blocks
        .iter()
        .filter(|block| extract_string(block, &["type"]).as_deref() == Some("image"))
        .filter_map(|block| {
            let source = block.get("source")?;
            let media_type = extract_string(source, &["media_type"])
                .filter(|media_type| media_type.starts_with("image/"));
            match extract_string(source, &["type"]).as_deref() {
                Some("base64") => {
                    let data = extract_string(source, &["data"])?;
                    let media_type = media_type.unwrap_or_else(|| "image/png".to_string());
                    Some(ImageInput {
                        id: format!("claude-img-{:016x}", fnv1a_64(data.as_bytes())),
                        name: None,
                        mime_type: Some(media_type.clone()),
                        url: format!("data:{media_type};base64,{data}"),
                        local_path: None,
                    })
                }
                Some("url") => {
                    let url = extract_string(source, &["url"])?;
                    Some(ImageInput {
                        id: format!("claude-img-{:016x}", fnv1a_64(url.as_bytes())),
                        name: None,
                        mime_type: media_type,
                        url,
                        local_path: None,
                    })
                }
                _ => None,
            }
        })
        .collect()
}

/// Stable 64-bit FNV-1a hash used to mint deterministic attachment ids, so
/// re-hydration across daemon restarts maps an image back to the same file.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Claude records slash-command envelopes, their captured stdout, and
/// interrupt notices as user messages. They are session bookkeeping, not
/// something the user typed, and must neither render as user bubbles nor seed
/// provisional titles and previews.
fn accept_claude_user_text(text: String) -> Option<String> {
    let probe = text.trim_start();
    let internal = probe.starts_with("<command-name>")
        || probe.starts_with("<local-command-stdout>")
        || probe.starts_with("[Request interrupted");
    (!internal).then_some(text)
}

pub(crate) fn merge_claude_assistant_text(current: &str, next_chunk: &str) -> String {
    let next_chunk = next_chunk.trim();
    if current.is_empty() {
        return next_chunk.to_string();
    }
    // Echo checks compare trimmed text: accumulated deltas often end in
    // trailing whitespace the whole-message echo lacks ("Done.\n" vs "Done."),
    // and a missed match here renders the reply twice.
    let current_trimmed = current.trim_end();
    if next_chunk.is_empty() || current_trimmed == next_chunk {
        return current.to_string();
    }
    if next_chunk.len() > 24 && current.contains(next_chunk) {
        return current.to_string();
    }
    if next_chunk.starts_with(current_trimmed) {
        return next_chunk.to_string();
    }
    // The stream repeats full message text after deltas (complete `assistant`
    // messages, then the final `result`). If the accumulated text already ends
    // with this chunk it is an echo, not new output.
    if current_trimmed.ends_with(next_chunk) {
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
        // Byte offsets inside a multibyte char are not sliceable; skipping
        // them keeps the scan panic-free on non-ASCII text.
        .filter(|size| next.is_char_boundary(*size))
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
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        // Each content block is its own paragraph; joining bare welds the next
        // block's first word onto the previous block's final sentence. The
        // separator must match the one the delta path inserts at block starts,
        // or these whole-message echoes stop deduping against accumulated text.
        Some(parts.join("\n\n"))
    }
}

fn claude_message_thinking(value: &Value) -> Option<String> {
    let content = value.get("content")?.as_array()?;
    let mut parts = Vec::new();
    for item in content {
        if extract_string(item, &["type"]).as_deref() != Some("thinking") {
            continue;
        }
        if let Some(text) = extract_string(item, &["thinking"]) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

/// True when the stream opens a fresh `text` content block. The token deltas
/// that follow are a new paragraph: appended verbatim they weld onto the
/// previous block's last sentence ("…at the bottom.Also updating…").
pub(crate) fn is_claude_text_block_start(value: &Value) -> bool {
    let event = claude_event_value(value);
    extract_string(event, &["type"]).as_deref() == Some("content_block_start")
        && event
            .get("content_block")
            .and_then(|block| extract_string(block, &["type"]))
            .as_deref()
            == Some("text")
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

#[cfg(test)]
mod tool_result_status_tests {
    use super::*;
    use serde_json::json;

    fn tool_result_line(block_extra: Value, tool_use_result: Value) -> Value {
        let mut block = json!({
            "type": "tool_result",
            "tool_use_id": "toolu_1",
            "content": "boom"
        });
        block
            .as_object_mut()
            .unwrap()
            .extend(block_extra.as_object().unwrap().clone());
        let mut line = json!({
            "type": "user",
            "message": { "role": "user", "content": [block] }
        });
        if !tool_use_result.is_null() {
            line.as_object_mut()
                .unwrap()
                .insert("toolUseResult".to_string(), tool_use_result);
        }
        line
    }

    #[test]
    fn tool_result_is_error_flag_maps_to_failed() {
        let event =
            extract_claude_tool_event(&tool_result_line(json!({ "is_error": true }), Value::Null))
                .unwrap();
        assert_eq!(event.status, "failed");
        assert_eq!(event.id, "toolu_1");
    }

    #[test]
    fn error_prefixed_tool_use_result_string_maps_to_failed() {
        let event = extract_claude_tool_event(&tool_result_line(
            json!({}),
            json!("Error: ENOENT: no such file"),
        ))
        .unwrap();
        assert_eq!(event.status, "failed");
    }

    #[test]
    fn successful_tool_results_stay_completed() {
        for line in [
            tool_result_line(json!({}), Value::Null),
            tool_result_line(json!({ "is_error": false }), Value::Null),
            tool_result_line(json!({}), json!("42 tests passed")),
        ] {
            let event = extract_claude_tool_event(&line).unwrap();
            assert_eq!(event.status, "completed", "{line}");
        }
    }
}

#[cfg(test)]
mod user_message_tests {
    use super::*;
    use serde_json::json;

    fn user_line(content: Value) -> Value {
        json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        })
    }

    #[test]
    fn claude_internal_user_records_yield_no_message() {
        for content in [
            "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
            "<local-command-stdout>(no content)</local-command-stdout>",
            "[Request interrupted by user]",
            "[Request interrupted by user for tool use]",
        ] {
            assert_eq!(
                extract_claude_user_message_text(&user_line(json!(content))),
                None,
                "{content} must not become a user message"
            );
        }
    }

    #[test]
    fn real_user_prompts_still_pass() {
        assert_eq!(
            extract_claude_user_message_text(&user_line(json!("fix the login bug"))).as_deref(),
            Some("fix the login bug")
        );
        assert_eq!(
            extract_claude_user_message_text(&user_line(
                json!([{ "type": "text", "text": "and add a test" }])
            ))
            .as_deref(),
            Some("and add a test")
        );
    }
}

#[cfg(test)]
mod thinking_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn thinking_deltas_are_incremental_chunks() {
        let line = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "Let me check" }
            }
        });
        let chunk = extract_claude_thinking_chunk(&line).unwrap();
        assert!(chunk.is_delta);
        assert_eq!(chunk.text, "Let me check");
    }

    #[test]
    fn complete_thinking_blocks_are_full_chunks() {
        let line = json!({
            "type": "assistant",
            "message": {
                "id": "msg_1",
                "content": [
                    { "type": "thinking", "thinking": "hmm, tests first", "signature": "sig" },
                    { "type": "text", "text": "Running the tests." }
                ]
            }
        });
        let chunk = extract_claude_thinking_chunk(&line).unwrap();
        assert!(!chunk.is_delta);
        assert_eq!(chunk.text, "hmm, tests first");
        // The same line still yields its text blocks as assistant prose.
        assert_eq!(
            extract_claude_text_chunk(&line).unwrap().text,
            "Running the tests."
        );
    }

    #[test]
    fn non_thinking_lines_yield_no_thinking_chunk() {
        for line in [
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "prose" }
                }
            }),
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "signature_delta", "signature": "sig" }
                }
            }),
            json!({ "type": "user", "message": { "content": "thinking about it" } }),
            json!({ "type": "result", "result": "done" }),
        ] {
            assert!(extract_claude_thinking_chunk(&line).is_none(), "{line}");
        }
    }
}

#[cfg(test)]
mod message_boundary_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn assistant_echoes_and_message_starts_carry_the_message_id() {
        let echo = json!({
            "type": "assistant",
            "message": { "id": "msg_a", "content": [{ "type": "text", "text": "hi" }] }
        });
        assert_eq!(claude_stream_message_id(&echo).as_deref(), Some("msg_a"));

        let start = json!({
            "type": "stream_event",
            "event": { "type": "message_start", "message": { "id": "msg_b" } }
        });
        assert_eq!(claude_stream_message_id(&start).as_deref(), Some("msg_b"));
        assert!(is_claude_message_start(&start));
    }

    #[test]
    fn deltas_and_user_lines_are_not_message_boundaries() {
        for line in [
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "hi" }
                }
            }),
            // User records may carry a uuid/id but never open an assistant
            // message.
            json!({
                "type": "user",
                "uuid": "record-1",
                "message": { "role": "user", "content": "hello" }
            }),
            json!({ "type": "result", "result": "done" }),
        ] {
            assert_eq!(claude_stream_message_id(&line), None, "{line}");
            assert!(!is_claude_message_start(&line), "{line}");
        }
    }
}

#[cfg(test)]
mod merge_text_tests {
    use super::*;

    #[test]
    fn whole_message_echoes_dedupe_across_trailing_whitespace() {
        // Accumulated deltas often end in a newline the echo lacks.
        assert_eq!(merge_claude_assistant_text("Done.\n", "Done."), "Done.\n");
        assert_eq!(
            merge_claude_assistant_text("All tests pass.\n\n", "All tests pass."),
            "All tests pass.\n\n"
        );
        // And an echo that extends the accumulated text supersedes it.
        assert_eq!(
            merge_claude_assistant_text("Done.\n", "Done. Committing next."),
            "Done. Committing next."
        );
    }

    #[test]
    fn distinct_chunks_still_join() {
        assert_eq!(
            merge_claude_assistant_text("First point.", "Second point."),
            "First point.\n\nSecond point."
        );
    }

    #[test]
    fn overlap_scan_survives_multibyte_text() {
        // Byte offsets 16..max land inside '—' here; slicing them panicked.
        let current = "The fix is ready — see the notes below for details";
        let next = "ready — see the notes below for details and next steps";
        assert_eq!(
            merge_claude_assistant_text(current, next),
            "The fix is ready — see the notes below for details and next steps"
        );
    }
}

#[cfg(test)]
mod subagent_stream_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tagged_events_are_recognized_as_subagent_traffic() {
        let tagged = json!({
            "type": "assistant",
            "parent_tool_use_id": "toolu_parent",
            "message": { "content": [{ "type": "text", "text": "sub-agent prose" }] }
        });
        assert_eq!(claude_parent_tool_use_id(&tagged), Some("toolu_parent"));

        let main_loop = json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "main reply" }] }
        });
        assert_eq!(claude_parent_tool_use_id(&main_loop), None);

        // A null tag (serializers love emitting it) is not sub-agent traffic.
        let null_tag = json!({ "type": "assistant", "parent_tool_use_id": null });
        assert_eq!(claude_parent_tool_use_id(&null_tag), None);
    }

    #[test]
    fn activity_log_reports_kept_and_dropped_steps() {
        let steps = vec![
            "Bash: cargo test".to_string(),
            "Read src/lib.rs".to_string(),
        ];
        assert_eq!(
            format_subagent_activity(&steps, 0),
            "Sub-agent activity:\n· Bash: cargo test\n· Read src/lib.rs"
        );
        assert_eq!(
            format_subagent_activity(&steps[..1], 1),
            "Sub-agent activity:\n… 1 earlier step hidden\n· Bash: cargo test"
        );
        assert_eq!(
            format_subagent_activity(&steps[..1], 3),
            "Sub-agent activity:\n… 3 earlier steps hidden\n· Bash: cargo test"
        );
    }
}
