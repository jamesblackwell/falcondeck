use std::{collections::HashMap, path::Path};

use falcondeck_core::{
    AgentProvider, ConversationCitation, ConversationCitationLocator, ImageInput,
    SelectedSkillReference, SkillSummary, ThreadIsolation, ToolCallDetail, TurnInputItem,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    app::{
        conversation_helpers::{should_suppress_tool_output, synthesize_tool_title},
        harness_user_text::falcondeck_skill_path_preamble,
        mcp_presentation::{claude_tool_detail, keeps_claude_tool_input, tool_search_title},
    },
    codex::extract_string,
    skills::{canonical_skill_alias, slash_command_aliases_in_text},
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
        .filter_map(|selection| resolve_one_selected_skill(available_skills, selection, provider))
        .collect()
}

/// Resolves explicit picker selections, then any `/alias` mentions in the
/// turn text against the live catalog so a skill added after connect still
/// applies when the user types it.
pub(super) fn resolve_turn_skills(
    available_skills: &[SkillSummary],
    selected_skills: &[SelectedSkillReference],
    inputs: &[TurnInputItem],
    provider: &AgentProvider,
) -> Vec<ResolvedSelectedSkill> {
    let mut resolved = resolve_selected_skills(available_skills, selected_skills, provider);
    let mut seen: std::collections::HashSet<String> = resolved
        .iter()
        .map(|skill| skill.summary.id.clone())
        .collect();
    for selection in selected_skill_refs_from_inputs(inputs, available_skills) {
        let Some(skill) = resolve_one_selected_skill(available_skills, &selection, provider) else {
            continue;
        };
        if !seen.insert(skill.summary.id.clone()) {
            continue;
        }
        resolved.push(skill);
    }
    resolved
}

fn resolve_one_selected_skill(
    available_skills: &[SkillSummary],
    selection: &SelectedSkillReference,
    provider: &AgentProvider,
) -> Option<ResolvedSelectedSkill> {
    available_skills
        .iter()
        .find(|skill| {
            skill.id == selection.skill_id
                || skill.alias.eq_ignore_ascii_case(&selection.alias)
                || canonical_skill_alias(&skill.alias) == canonical_skill_alias(&selection.alias)
        })
        .filter(|skill| skill.supports_provider(provider))
        .cloned()
        .map(|summary| ResolvedSelectedSkill {
            alias: selection.alias.clone(),
            summary,
        })
}

fn selected_skill_refs_from_inputs(
    inputs: &[TurnInputItem],
    available_skills: &[SkillSummary],
) -> Vec<SelectedSkillReference> {
    let mut selections = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for input in inputs {
        let TurnInputItem::Text { text, .. } = input else {
            continue;
        };
        for alias in slash_command_aliases_in_text(text) {
            let Some(skill) = available_skills
                .iter()
                .find(|skill| canonical_skill_alias(&skill.alias) == alias)
            else {
                continue;
            };
            if !seen.insert(skill.id.clone()) {
                continue;
            }
            selections.push(SelectedSkillReference {
                skill_id: skill.id.clone(),
                alias: skill.alias.clone(),
            });
        }
    }
    selections
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
                if attachment_kind(image) == AttachmentKind::Document {
                    // Codex has no document input; the file lives beside the
                    // thread, so the path is what makes it reachable.
                    json!({
                        "type": "text",
                        "text": attachment_reference_text(image),
                    })
                } else if let Some(local_path) = image
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

pub(super) fn agy_prompt_from_inputs(
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
) -> String {
    let text = inputs
        .iter()
        .filter_map(|input| match input {
            TurnInputItem::Text { text, .. } => Some(text.as_str()),
            TurnInputItem::Image(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let preambles = selected_skills
        .iter()
        .map(|skill| skill.alias.as_str())
        .filter(|alias| !alias.is_empty() && !text.contains(alias))
        .collect::<Vec<_>>();
    if preambles.is_empty() {
        return text;
    }
    if text.trim().is_empty() {
        return preambles.join(" ");
    }
    format!("{}\n\n{text}", preambles.join(" "))
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

/// What an attachment is for, decided from its media type or file name.
/// Images are embedded into the provider payload; everything else is handed
/// over as a path the agent can open with its own file tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AttachmentKind {
    Image,
    Document,
}

pub(crate) fn attachment_kind(image: &ImageInput) -> AttachmentKind {
    if let Some(mime) = image
        .mime_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return if mime.to_ascii_lowercase().starts_with("image/") {
            AttachmentKind::Image
        } else {
            AttachmentKind::Document
        };
    }
    let url = image.url.trim();
    if url.to_ascii_lowercase().starts_with("data:image/") {
        return AttachmentKind::Image;
    }
    let name = image
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            image
                .local_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });
    match name.and_then(|value| Path::new(value).extension()) {
        Some(extension) => {
            if is_image_file_extension(&extension.to_string_lossy().to_ascii_lowercase()) {
                AttachmentKind::Image
            } else {
                AttachmentKind::Document
            }
        }
        // Legacy clients sent images with no media type and no name.
        None => AttachmentKind::Image,
    }
}

pub(crate) fn is_image_file_extension(extension: &str) -> bool {
    matches!(
        extension,
        "avif"
            | "bmp"
            | "gif"
            | "heic"
            | "heif"
            | "jpeg"
            | "jpg"
            | "png"
            | "svg"
            | "tif"
            | "tiff"
            | "webp"
    )
}

/// Text stand-in for an attachment the provider cannot embed.
///
/// Documents always take this path: the daemon has already written the file
/// beside the thread, so naming the path is what lets the agent open it.
/// Images land here only when embedding failed (missing file, over budget),
/// where a reference still beats the attachment vanishing.
pub(crate) fn attachment_reference_text(image: &ImageInput) -> String {
    let label = match attachment_kind(image) {
        AttachmentKind::Image => "image attachment",
        AttachmentKind::Document => "file attachment",
    };

    if let Some(local_path) = image
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return format!("[{label}: {local_path}]");
    }

    if let Some(name) = image
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("[{label}: {name}]");
    }

    if let Some(mime_type) = image
        .mime_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("[{label}: {mime_type}]");
    }

    let url = image.url.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        return format!("[{label}: {url}]");
    }

    format!("[{label}]")
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
            skill
                .summary
                .provider_translations
                .claude
                .as_ref()
                .and_then(|translation| {
                    if translation.command_name.is_some() {
                        None
                    } else {
                        translation
                            .prompt_reference_path
                            .as_ref()
                            .map(|path| falcondeck_skill_path_preamble(path))
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

pub(super) fn replace_selected_skill_aliases<F>(
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

/// Collect every tool block, including parallel calls in one assistant message.
pub(crate) fn extract_claude_tool_events(value: &Value) -> Vec<ClaudeToolEvent> {
    if let Some(content) = value.pointer("/message/content").and_then(Value::as_array) {
        return content
            .iter()
            .filter(|block| {
                matches!(
                    block.get("type").and_then(Value::as_str),
                    Some("tool_use" | "tool_result")
                )
            })
            .filter_map(|block| extract_claude_tool_event_with_block(value, Some(block)))
            .collect();
    }
    extract_claude_tool_event(value).into_iter().collect()
}

/// Stable per-child identities prevent start/echo/result duplicates. Nothing is
/// evicted: mobile projects this evidence out of bounded thread.detail pages.
#[derive(Default)]
pub(crate) struct ClaudeSubagentActivity {
    calls: Vec<falcondeck_core::ClaudeNestedCall>,
}

impl ClaudeSubagentActivity {
    pub(crate) fn record(&mut self, value: &Value) {
        for event in extract_claude_tool_events(value) {
            if let Some(call) = self.calls.iter_mut().find(|call| call.id == event.id) {
                if let Some(input) = event
                    .input
                    .filter(|v| v.as_object().is_none_or(|v| !v.is_empty()))
                {
                    call.arguments = input;
                    call.title = event.title.unwrap_or_else(|| call.title.clone());
                }
                call.status = event.status;
                if call.status != "failed" && (should_suppress_tool_output(&call.title, &call.tool_kind)
                    || call
                        .arguments
                        .get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|c| should_suppress_tool_output(c, &call.tool_kind)))
                {
                    call.output = None;
                } else if event.output.is_some() {
                    call.output = event.output;
                }
            } else {
                let title = event.title.unwrap_or_else(|| "Claude tool".to_string());
                let tool_kind = event.tool_kind.unwrap_or_default();
                let suppressed = event.status != "failed" && (should_suppress_tool_output(&title, &tool_kind)
                    || event
                        .input
                        .as_ref()
                        .and_then(|v| v.get("command"))
                        .and_then(Value::as_str)
                        .is_some_and(|c| should_suppress_tool_output(c, &tool_kind)));
                self.calls.push(falcondeck_core::ClaudeNestedCall {
                    id: event.id,
                    title,
                    tool_kind,
                    status: event.status,
                    arguments: event.input.unwrap_or(Value::Null),
                    output: if suppressed { None } else { event.output },
                });
            }
        }
    }

    pub(crate) fn summary(&self) -> String {
        let mut lines = vec!["Sub-agent activity:".to_string()];
        let skipped = self.calls.len().saturating_sub(8);
        if skipped > 0 {
            lines.push(format!("… {skipped} earlier calls; expand for details"));
        }
        for call in self.calls.iter().skip(skipped) {
            lines.push(format!(
                "· {}: {} [{}]",
                call.tool_kind,
                call.title.chars().take(120).collect::<String>(),
                call.status
            ));
        }
        lines.join("\n")
    }

    pub(crate) fn apply(&self, detail: &mut Option<ToolCallDetail>) {
        if let Some(ToolCallDetail::Dynamic {
            claude: Some(evidence),
            ..
        }) = detail
        {
            evidence.calls = self.calls.clone();
        }
    }
}

pub(crate) fn extract_claude_tool_event(value: &Value) -> Option<ClaudeToolEvent> {
    extract_claude_tool_event_with_block(value, None)
}

fn extract_claude_tool_event_with_block(
    value: &Value,
    selected: Option<&Value>,
) -> Option<ClaudeToolEvent> {
    let top_level_type = extract_string(value, &["type"]);
    let event = claude_event_value(value);
    let event_type =
        extract_string(event, &["type", "event"]).or_else(|| top_level_type.clone())?;

    if top_level_type.as_deref() == Some("user") {
        let tool_result = selected.or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find(|item| {
                        extract_string(item, &["type"]).as_deref() == Some("tool_result")
                    })
                })
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
        let tool_use_result = value
            .get("toolUseResult")
            .or_else(|| value.get("tool_use_result"));
        let failed = tool_result
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || tool_use_result
                .and_then(Value::as_str)
                .is_some_and(|result| result.trim_start().starts_with("Error:"));
        let is_async_launch = tool_use_result.is_some_and(|result| {
            result.get("isAsync").and_then(Value::as_bool) == Some(true)
                || result.get("is_async").and_then(Value::as_bool) == Some(true)
                || extract_string(result, &["status"]).as_deref() == Some("async_launched")
        });
        return Some(ClaudeToolEvent {
            id,
            title: title.clone(),
            tool_kind: title,
            input: None,
            status: if failed {
                "failed"
            } else if is_async_launch {
                "running"
            } else {
                "completed"
            }
            .to_string(),
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
            input: content_block.get("input").cloned(),
            status: "running".to_string(),
            output: None,
            images: Vec::new(),
        });
    }

    if top_level_type.as_deref() == Some("assistant") {
        let tool_use = selected.or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| extract_string(item, &["type"]).as_deref() == Some("tool_use"))
                })
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
                input: tool_use.get("input").cloned(),
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
        input: event.get("input").cloned(),
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
    /// The call's arguments, on events that carry them.
    pub input: Option<Value>,
    pub status: String,
    pub output: Option<String>,
    /// Base64 images carried by the tool_result (screenshots, image reads).
    pub images: Vec<ClaudeToolResultImage>,
}

/// Arguments and result metadata for Claude calls. Complete assistant echoes
/// supply the input after an empty streamed start; results must preserve it.
#[derive(Debug, Default)]
pub(crate) struct ClaudeToolInputs {
    inputs: HashMap<String, Value>,
    results: HashMap<String, Value>,
}

impl ClaudeToolInputs {
    /// `content_block_start` carries an empty `{}`, which must not replace the
    /// real input or read as one.
    pub(crate) fn record(&mut self, id: &str, tool_kind: &str, input: Option<&Value>) {
        if keeps_claude_tool_input(tool_kind)
            && let Some(input) = input.filter(|input| {
                input.as_object().is_none_or(|object| !object.is_empty()) && !input.is_null()
            })
        {
            self.inputs.insert(id.to_string(), input.clone());
        }
    }

    pub(crate) fn detail(&self, id: &str, tool_kind: &str) -> Option<ToolCallDetail> {
        let mut detail = claude_tool_detail(tool_kind, self.inputs.get(id));
        if let Some(ToolCallDetail::Dynamic {
            claude: Some(evidence),
            duration_ms,
            success,
            ..
        }) = &mut detail
        {
            let path = self
                .inputs
                .get(id)
                .and_then(|v| {
                    v.get("file_path")
                        .or_else(|| v.get("path"))
                        .or_else(|| v.get("command"))
                })
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !should_suppress_tool_output(path, tool_kind) {
                evidence.result = self.results.get(id).cloned();
            }
            *duration_ms = evidence
                .result
                .as_ref()
                .and_then(|r| r.get("durationMs").or_else(|| r.get("totalDurationMs")))
                .and_then(Value::as_u64);
            *success = evidence
                .result
                .as_ref()
                .and_then(|r| r.get("success"))
                .and_then(Value::as_bool);
        }
        detail
    }

    pub(crate) fn record_result(&mut self, id: &str, value: &Value) {
        if let Some(result) = value
            .get("toolUseResult")
            .or_else(|| value.get("tool_use_result"))
        {
            if let Some(metadata) = claude_result_metadata(result) {
                self.results.insert(id.to_string(), metadata);
            }
        }
    }

    pub(crate) fn clear(&mut self) {
        self.inputs.clear();
        self.results.clear();
    }
}

/// Keep result metadata without duplicating output, file bodies, or invocation
/// arguments. Build from borrowed fields so even transient ingestion stays small.
fn claude_result_metadata(result: &Value) -> Option<Value> {
    let object = result.as_object()?;
    let mut metadata = serde_json::Map::new();
    for (key, value) in object {
        if matches!(
            key.as_str(),
            "stdout"
                | "stderr"
                | "content"
                | "originalFile"
                | "original_file"
                | "oldString"
                | "newString"
                | "prompt"
                | "description"
        ) {
            continue;
        }
        if key == "file" {
            if let Some(file) = value.as_object() {
                let file = file
                    .iter()
                    .filter(|(k, _)| !matches!(k.as_str(), "content" | "base64"))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<serde_json::Map<_, _>>();
                if !file.is_empty() {
                    metadata.insert(key.clone(), Value::Object(file));
                }
            }
        } else {
            metadata.insert(key.clone(), value.clone());
        }
    }
    (!metadata.is_empty()).then_some(Value::Object(metadata))
}

/// Title and kind for a tool event, given what the `tool_use` already said. A
/// result's own fields describe its payload: an MCP result with a `query` key
/// must not retitle the row or replace the kind its label is derived from.
pub(crate) fn resolve_claude_tool_identity(
    title: Option<String>,
    tool_kind: Option<String>,
    known: Option<&(String, String)>,
) -> (String, String) {
    if let Some((known_title, known_kind)) = known.filter(|(_, kind)| keeps_claude_tool_input(kind))
    {
        let title = if !known_title.is_empty() {
            known_title.clone()
        } else {
            title.unwrap_or_else(|| known_title.clone())
        };
        return (title, known_kind.clone());
    }
    let title = title
        .or_else(|| known.map(|(title, _)| title.clone()))
        .unwrap_or_else(|| "Claude tool".to_string());
    let tool_kind = tool_kind
        .or_else(|| known.map(|(_, tool_kind)| tool_kind.clone()))
        .unwrap_or_else(|| title.clone());
    (title, tool_kind)
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
        .filter_map(|(index, image)| {
            let url = super::conversation_helpers::cap_synced_image_url(format!(
                "data:{};base64,{}",
                image.media_type, image.data
            ))?;
            let id = format!("{tool_id}-image-{index}");
            Some(falcondeck_core::ConversationItem::Image {
                id: id.clone(),
                title: Some(title.to_string()),
                image: falcondeck_core::ConversationImage {
                    id: format!("{id}-asset"),
                    name: None,
                    mime_type: Some(image.media_type.clone()),
                    url,
                    local_path: None,
                    alt_text: None,
                },
                lifecycle: falcondeck_core::ContentLifecycle::Complete,
                created_at: chrono::Utc::now(),
            })
        })
        .collect()
}

pub(crate) fn claude_tool_exit_code(value: &Value) -> Option<i32> {
    let result = value
        .get("toolUseResult")
        .or_else(|| value.get("tool_use_result"));
    result
        .and_then(|r| r.get("exitCode").or_else(|| r.get("exit_code")))
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
}

fn empty_hook_value(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty())
        || v.as_array().is_some_and(Vec::is_empty)
        || v.as_object().is_some_and(serde_json::Map::is_empty))
}

fn hook_exit(value: &Value) -> Option<&Value> {
    value.get("exit_code").filter(|v| !v.is_null())
        .or_else(|| value.get("exitCode").filter(|v| !v.is_null()))
}

fn hook_has_decision(value: &Value) -> bool {
    (value.get("outcome").is_some() && value.get("outcome").and_then(Value::as_str) != Some("success"))
        || ["decision", "reason", "additionalContext", "systemMessage"].iter()
            .any(|key| !empty_hook_value(value.get(*key)))
}

fn silent_hook_payload(value: &Value, success: bool) -> bool {
    if !value.is_object() { return false; }
    let exit = hook_exit(value);
    if exit.is_some_and(|code| code.as_f64() != Some(0.0)) || hook_has_decision(value) { return false; }
    let empty = ["stdout", "stderr", "output", "content", "message", "text", "context", "errors", "error"]
        .iter().all(|key| empty_hook_value(value.get(*key)));
    empty && (success || exit.is_some() || value.get("context").is_some())
}

/// Also recognizes receipts persisted before silent hooks were filtered.
pub(crate) fn is_empty_claude_hook_receipt(message: &str) -> bool {
    let (payload, success) = if let Some(payload) = message.strip_prefix("Claude hook output: ") {
        (payload, false)
    } else if let Some(payload) = message.strip_prefix("Claude hook success: ") {
        (payload, true)
    } else { return false; };
    serde_json::from_str::<Value>(payload).is_ok_and(|value| silent_hook_payload(&value, success))
}

pub(crate) fn is_silent_claude_hook_item(item: &falcondeck_core::ConversationItem) -> bool {
    matches!(item, falcondeck_core::ConversationItem::Service { message, .. } if is_empty_claude_hook_receipt(message))
}

fn hook_message(value: &Value, success: bool) -> Option<String> {
    if silent_hook_payload(value, success) { return None; }
    let hook = extract_string(value, &["hook_name", "hookName", "hook"]).unwrap_or_else(|| "response".into());
    // Preserve decisions and malformed exits verbatim, even alongside stream text.
    if hook_has_decision(value) || hook_exit(value).is_some_and(|code| code.as_i64().is_none() && code.as_f64() != Some(0.0)) {
        return Some(format!("Claude hook output: {value}"));
    }
    let mut parts = Vec::new();
    for key in ["output", "stdout", "stderr", "content", "message", "text"] {
        if let Some(text) = stringify_claude_value(value.get(key)) {
            if !parts.contains(&text) { parts.push(text); }
        }
    }
    let exit = hook_exit(value).and_then(Value::as_i64);
    let failure = exit.filter(|code| *code != 0).map(|code| format!(" failed (exit {code})")).unwrap_or_default();
    if parts.is_empty() && failure.is_empty() {
        return Some(format!("Claude hook output: {value}")); // Already non-silent: keep packets without display text or an integer failure verbatim.
    }
    Some(format!("Claude hook {hook}{failure}{}{}", if parts.is_empty() { "" } else { ": " }, parts.join("\n")))
}

pub(crate) fn extract_claude_service_message(value: &Value) -> Option<String> {
    let event_type = extract_string(claude_event_value(value), &["type", "event"])
        .or_else(|| extract_string(value, &["type"]))?;
    if event_type == "attachment" {
        let attachment = value.get("attachment")?;
        let kind = attachment.get("type").and_then(Value::as_str)?;
        if kind == "hook_success" { return hook_message(attachment, true); }
        return matches!(
            kind,
            "hook_blocking_error" | "hook_success" | "read_truncation_notice" | "task_status"
        )
        .then(|| format!("Claude {}: {}", kind.replace('_', " "), attachment));
    }
    if !matches!(event_type.as_str(), "system" | "status" | "result") {
        return None;
    }
    // `task_notification` events carry a bare `status` word ("stopped", "killed",
    // "interrupted") and a long `summary`. The monitor settles the spawning
    // tool card in `claude_task_finished`; surfacing the status here would
    // re-emit it as a free-floating "stopped" diagnostic on every interrupted
    // background task.
    if value.get("type").and_then(Value::as_str) == Some("system")
        && value.get("subtype").and_then(Value::as_str) == Some("task_notification")
    {
        return None;
    }
    if event_type == "system" {
        let subtype = value
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if subtype == "hook_response" {
            return hook_message(value, false);
        }
        if subtype == "api_error" {
            return Some(format!(
                "Claude retry {}/{} in {} ms: {}",
                value.get("retryAttempt").unwrap_or(&Value::Null),
                value.get("maxRetries").unwrap_or(&Value::Null),
                value.get("retryInMs").unwrap_or(&Value::Null),
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("API request failed")
            ));
        }
        if subtype == "stop_hook_summary" {
            if hook_has_decision(value) || hook_exit(value).is_some_and(|code| code.as_f64() != Some(0.0)) {
                return hook_message(value, false);
            }
            let errors = value
                .get("hookErrors")
                .and_then(Value::as_array)
                .filter(|v| !v.is_empty());
            let context = value.get("hookAdditionalContext").filter(|v| {
                !v.is_null()
                    && v.as_str() != Some("")
                    && !v.as_array().is_some_and(Vec::is_empty)
                    && !v.as_object().is_some_and(serde_json::Map::is_empty)
            });
            if errors.is_some() || context.is_some() {
                return Some(format!(
                    "Claude hook output: {}",
                    json!({"errors": errors, "context": context})
                ));
            }
            return None; // Successful silent hooks are lifecycle bookkeeping.
        }
        if let Some(text) = extract_string(value, &["content"]) {
            return Some(text);
        }
    }
    extract_string(claude_event_value(value), &["message", "status", "summary"])
        .or_else(|| extract_string(value, &["message", "status", "summary"]))
        .filter(|message| !is_low_signal_service_message(message))
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
    let error_field = event
        .get("error")
        .or_else(|| value.get("error"))
        .filter(|error| !error.is_null());
    let named_error_event = extract_string(event, &["type", "event"])
        .or_else(|| extract_string(value, &["type"]))
        .map(|kind| kind.contains("error"))
        .unwrap_or(false);
    if !named_error_event && error_field.is_none() {
        return None;
    }
    extract_string(event, &["error", "message"])
        .or_else(|| extract_string(value, &["error", "message"]))
        // A structured error (`{ "type": ..., "message": ... }` nested in an
        // object, or any unfamiliar shape) is still the cause of the failure;
        // verbatim JSON beats reporting nothing.
        .or_else(|| {
            error_field.map(|error| {
                extract_string(error, &["message"]).unwrap_or_else(|| error.to_string())
            })
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
                        url: super::conversation_helpers::cap_synced_image_url(format!(
                            "data:{media_type};base64,{data}"
                        ))?,
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
    match super::harness_user_text::project_user_text(&text) {
        super::harness_user_text::ProjectedUserText::Prompt(text) => Some(text),
        _ => None,
    }
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
        return Some(tool_search_title(&query));
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
    let result = value
        .get("toolUseResult")
        .or_else(|| value.get("tool_use_result"));
    // Bash's structured streams are more precise than its rendered content.
    if result.is_some_and(|r| r.get("stdout").is_some() || r.get("stderr").is_some()) {
        let r = result?;
        let stdout = r.get("stdout").and_then(Value::as_str).unwrap_or_default();
        let stderr = r.get("stderr").and_then(Value::as_str).unwrap_or_default();
        return Some(if stderr.is_empty() {
            stdout.to_string()
        } else {
            format!("{stdout}\nStderr:\n{stderr}")
        });
    }
    extract_string(tool_result, &["content", "text"])
        .or_else(|| stringify_claude_value(tool_result.get("content")))
        .or_else(|| stringify_claude_value(result))
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
        "toolsearch" => input
            .and_then(|input| extract_string(input, &["query"]))
            .or_else(|| result.and_then(|result| extract_string(result, &["query"])))
            .map(|query| tool_search_title(&query))
            .unwrap_or_else(|| "Search tools".to_string()),
        "skill" => input
            .and_then(|input| extract_string(input, &["skill"]))
            .or_else(|| result.and_then(|result| extract_string(result, &["commandName"])))
            .map(|skill| format!("Load skill: {skill}"))
            .unwrap_or_else(|| "Load skill".to_string()),
        // Everything a harness could plausibly share — reads, edits, searches,
        // commands — is titled the same way for every provider. Claude's own
        // result is a second place to find the file, since an edit streams its
        // title before its input arrives.
        _ => synthesize_tool_title(name, input, result).unwrap_or_else(|| name.to_string()),
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
            // Image blocks have their own image item. Do not duplicate the
            // encoded bytes as JSON text when a Read has no textual content.
            if let Some(encoded) = object
                .get("file")
                .and_then(|file| file.get("base64"))
                .and_then(Value::as_str)
            {
                return Some(format!("Image read ({} encoded bytes)", encoded.len()));
            }
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
                serde_json::to_string_pretty(&object_value).ok()
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
    fn silent_hooks_preserve_unknown_exits_and_hook_decisions() {
        for (payload, silent) in [
            ("{\"context\":[],\"exit_code\":\"1\"}", false),
            ("{\"context\":[],\"exit_code\":1.5}", false),
            ("{\"context\":[],\"exit_code\":true}", false),
            ("{\"context\":[],\"exit_code\":18446744073709551616}", false),
            ("{\"context\":[],\"exit_code\":null,\"exitCode\":2}", false),
            ("{\"context\":[],\"exitCode\":\"1\"}", false),
            ("{\"context\":[],\"exit_code\":null,\"exitCode\":0}", true),
            ("{\"context\":[]}", true),
            ("{\"context\":[],\"exit_code\":0,\"outcome\":\"error\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"outcome\":null}", false),
            ("{\"context\":[],\"exit_code\":0,\"outcome\":\"success\"}", true),
            ("{\"context\":[],\"exit_code\":0,\"decision\":\"block\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"reason\":\"denied\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"additionalContext\":\"details\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"systemMessage\":\"notice\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"decision\":\" \",\"reason\":\"\",\"additionalContext\":null,\"systemMessage\":[]}", true),
            ("{\"context\":[],\"exit_code\":0,\"unrelated_metadata\":{\"durationMs\":1}}", true),
        ] {
            for prefix in ["Claude hook output: ", "Claude hook success: "] {
                assert_eq!(is_empty_claude_hook_receipt(&format!("{prefix}{payload}")), silent, "{payload}");
            }
            for subtype in ["hook_response", "stop_hook_summary"] {
                let mut event: Value = serde_json::from_str(payload).unwrap();
                event["type"] = json!("system"); event["subtype"] = json!(subtype);
                assert_eq!(extract_claude_service_message(&event).is_none(), silent, "{subtype}: {payload}");
            }
        }
        let receipt = extract_claude_service_message(&json!({"type":"system", "subtype":"hook_response", "exit_code":0,
            "stdout":r#"{"context":[],"errors":null}"#})).unwrap();
        assert!(receipt.starts_with("Claude hook response: "));
        assert!(!is_empty_claude_hook_receipt(&receipt));
    }

    #[test]
    fn silent_hooks_filter_success_and_preserve_failures_and_text() {
        for hook in ["SessionStart:resume", "UserPromptSubmit"] {
            let mut event = json!({"type":"system", "subtype":"hook_response", "hook_name":hook,
                "exit_code":0, "stdout":" \n", "stderr":"\t", "output":""});
            assert_eq!(extract_claude_service_message(&event), None);
            event["exit_code"] = json!(2);
            assert!(extract_claude_service_message(&event).unwrap().contains("failed (exit 2)"));
            event["exit_code"] = json!(0); event["stdout"] = json!("Useful output");
            assert_eq!(extract_claude_service_message(&event).unwrap(), format!("Claude hook {hook}: Useful output"));
        }
        let mut attachment = json!({"type":"attachment", "attachment":{"type":"hook_success", "hookName":"SessionStart", "content":"  "}});
        assert_eq!(extract_claude_service_message(&attachment), None);
        attachment["attachment"]["content"] = json!("Ready");
        assert_eq!(extract_claude_service_message(&attachment).as_deref(), Some("Claude hook SessionStart: Ready"));
        attachment["attachment"]["content"] = json!(""); attachment["attachment"]["exit_code"] = json!(1);
        assert!(extract_claude_service_message(&attachment).unwrap().contains("failed"));
    }

    #[test]
    fn silent_hooks_recognize_both_stored_shapes_without_hiding_errors() {
        for receipt in [
            "Claude hook output: {\"context\":[],\"errors\":null}",
            "Claude hook output: {\"exit_code\":0,\"hook\":\"UserPromptSubmit\",\"stdout\":\" \",\"stderr\":\"\",\"output\":\"\"}",
            "Claude hook success: {\"type\":\"hook_success\",\"content\":\" \"}",
        ] { assert!(is_empty_claude_hook_receipt(receipt), "{receipt}"); }
        for receipt in [
            "Claude hook output: {\"exit_code\":1,\"output\":\"\"}",
            "Claude hook output: {\"exit_code\":0,\"stdout\":\"Important\"}",
            "Claude hook output: {\"context\":[],\"errors\":[\"failure\"]}",
            r#"Claude hook output: {"context":[],"errors":[""]}"#,
            "Claude hook output: not JSON",
        ] { assert!(!is_empty_claude_hook_receipt(receipt), "{receipt}"); }
    }

    #[test]
    fn claude_empty_stop_hooks_and_duplicate_result_bodies_are_omitted() {
        let stop = json!({"type":"system", "subtype":"stop_hook_summary", "hookAdditionalContext":[], "hookErrors":[], "hookInfos":[{"command":"example", "durationMs":1}], "hookCount":1});
        assert_eq!(extract_claude_service_message(&stop), None);
        let result = json!({"stdout":"body", "stderr":"warning", "originalFile":"before", "oldString":"old", "newString":"new", "content":"body", "file":{"content":"body", "base64":"duplicate-image", "filePath":"file.rs", "numLines":3}, "backgroundTaskId":"bg"});
        assert_eq!(
            claude_result_metadata(&result).unwrap(),
            json!({"file":{"filePath":"file.rs", "numLines":3}, "backgroundTaskId":"bg"})
        );
        assert_eq!(
            stringify_claude_value(Some(&json!({"file":{"base64":"binary"}}))),
            Some("Image read (6 encoded bytes)".into())
        );
        let snake = json!({"type":"user", "tool_use_result":{"stdout":"out", "stderr":"warning"}, "message":{"content":[{"type":"tool_result", "tool_use_id":"b", "content":"out"}]}});
        assert_eq!(
            extract_claude_tool_event(&snake).unwrap().output.as_deref(),
            Some("out\nStderr:\nwarning")
        );
    }

    #[test]
    fn claude_subagent_retains_parallel_calls_results_and_parent_input() {
        let mut activity = ClaudeSubagentActivity::default();
        let calls = json!({"type":"assistant", "message":{"content":[
            {"type":"tool_use","id":"a","name":"Bash","input":{"command":"du -sk *", "description":"Measure files"}},
            {"type":"tool_use","id":"b","name":"Read","input":{"file_path":"src/main.rs"}}
        ]}});
        activity.record(&calls);
        activity.record(&calls); // assistant echoes update, never duplicate
        activity.record(&json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"a","content":"42 files"},
            {"type":"tool_result","tool_use_id":"b","content":"permission denied","is_error":true}
        ]}}));
        let mut inputs = ClaudeToolInputs::default();
        inputs.record(
            "parent",
            "Agent",
            Some(&json!({"description":"Inspect space", "prompt":"Find large files"})),
        );
        let mut detail = inputs.detail("parent", "Agent");
        activity.apply(&mut detail);
        let Some(ToolCallDetail::Dynamic {
            arguments,
            claude: Some(evidence),
            ..
        }) = detail
        else {
            panic!("missing Claude evidence")
        };
        assert_eq!(arguments["prompt"], "Find large files");
        assert_eq!(evidence.calls.len(), 2);
        assert_eq!(evidence.calls[0].arguments["command"], "du -sk *");
        assert_eq!(evidence.calls[0].status, "completed");
        assert_eq!(evidence.calls[0].output.as_deref(), Some("42 files"));
        assert_eq!(evidence.calls[1].status, "failed");
        assert_eq!(
            resolve_claude_tool_identity(
                Some("du -sk *".into()),
                Some("Bash".into()),
                Some(&("Agent: Inspect space".into(), "Agent".into()))
            ),
            ("Agent: Inspect space".into(), "Agent".into())
        );
    }

    #[test]
    fn claude_child_skill_mentions_and_failed_reads_retain_output() {
        let mut activity = ClaudeSubagentActivity::default();
        for (id, command, failed, output) in [
            ("diff", "git diff -- SKILL.md", false, "fixture diff"),
            ("failed", "cat missing/SKILL.md", true, "No such file"),
        ] {
            activity.record(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":"Bash","input":{"command":command}}]}}));
            activity.record(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":failed,"content":output}]}}));
            assert_eq!(activity.calls.last().unwrap().output.as_deref(), Some(output));
        }
    }

    #[test]
    fn claude_skill_bodies_do_not_leak_through_result_metadata() {
        let mut inputs = ClaudeToolInputs::default();
        inputs.record(
            "s",
            "Read",
            Some(&json!({"file_path":"/example/.agents/skills/test/SKILL.md"})),
        );
        inputs.record_result(
            "s",
            &json!({"toolUseResult":{"file":{"content":"instruction body"}}}),
        );
        let Some(ToolCallDetail::Dynamic {
            claude: Some(evidence),
            ..
        }) = inputs.detail("s", "Read")
        else {
            panic!("missing detail")
        };
        assert_eq!(evidence.result, None);
        let mut activity = ClaudeSubagentActivity::default();
        activity.record(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"s","name":"Read","input":{"file_path":"/example/.agents/skills/test/SKILL.md"}}]}}));
        activity.record(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"s","content":"instruction body"}]}}));
        let mut detail = inputs.detail("parent", "Agent");
        activity.apply(&mut detail);
        let Some(ToolCallDetail::Dynamic {
            claude: Some(evidence),
            ..
        }) = detail
        else {
            panic!("missing child detail")
        };
        assert_eq!(evidence.calls[0].output, None);
        inputs.record(
            "bash",
            "Bash",
            Some(&json!({"command":"cat /example/SKILL.md"})),
        );
        inputs.record_result("bash", &json!({"toolUseResult":{"stdout":"instruction body", "originalFile":"instruction body", "content":"instruction body"}}));
        assert!(
            !serde_json::to_string(&inputs.detail("bash", "Bash"))
                .unwrap()
                .contains("instruction body")
        );
    }

    #[test]
    fn claude_preserves_result_metadata_stderr_and_retry_notices() {
        let value = json!({"type":"user","toolUseResult":{"stdout":"out", "stderr":"warning", "exitCode":2, "durationMs":100, "backgroundTaskId":"bg"},"message":{"content":[{"type":"tool_result","tool_use_id":"a", "content":"output", "is_error":true}]}});
        let event = extract_claude_tool_event(&value).unwrap();
        assert_eq!(event.status, "failed");
        assert_eq!(event.output.as_deref(), Some("out\nStderr:\nwarning"));
        assert_eq!(claude_tool_exit_code(&value), Some(2));
        let mut inputs = ClaudeToolInputs::default();
        inputs.record_result("a", &value);
        let Some(ToolCallDetail::Dynamic {
            claude: Some(evidence),
            duration_ms,
            ..
        }) = inputs.detail("a", "Bash")
        else {
            panic!("missing metadata")
        };
        assert_eq!(duration_ms, Some(100));
        assert_eq!(evidence.result.unwrap()["backgroundTaskId"], "bg");
        assert!(extract_claude_service_message(&json!({"type":"system", "subtype":"api_error", "retryAttempt":1, "maxRetries":3, "retryInMs":1000, "error":{"message":"rate limited"}})).unwrap().contains("retry 1/3"));
    }

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
            "<system-reminder>The following skills are available for use:</system-reminder>",
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
    fn async_agent_launch_keeps_the_tool_running() {
        let event = extract_claude_tool_event(&json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_agent",
                    "content": [{ "type": "text", "text": "Async agent launched" }]
                }]
            },
            "tool_use_result": {
                "is_async": true,
                "status": "async_launched",
                "agentId": "agent-1"
            }
        }))
        .unwrap();

        assert_eq!(event.status, "running");
    }
}

#[cfg(test)]
mod turn_skill_resolution_tests {
    use falcondeck_core::{
        AgentProvider, SelectedSkillReference, SkillAvailability, SkillProviderTranslations,
        SkillSourceKind, SkillSummary, TurnInputItem,
    };

    use super::{resolve_selected_skills, resolve_turn_skills};

    fn skill(alias: &str, providers: Vec<AgentProvider>) -> SkillSummary {
        SkillSummary {
            id: format!("skill:{}", alias.trim_start_matches('/')),
            label: alias.trim_start_matches('/').to_string(),
            alias: alias.to_string(),
            availability: SkillAvailability::Both,
            providers,
            source_kind: SkillSourceKind::ProjectFile,
            source_path: Some("/tmp/SKILL.md".to_string()),
            description: None,
            provider_translations: SkillProviderTranslations::default(),
        }
    }

    #[test]
    fn turn_text_picks_up_a_catalog_skill_the_client_did_not_select() {
        let lint = skill("/lint", vec![AgentProvider::CODEX, AgentProvider::GROK]);
        let resolved = resolve_turn_skills(
            &[lint],
            &[],
            &[TurnInputItem::Text {
                id: None,
                text: "please run /lint on this".to_string(),
            }],
            &AgentProvider::GROK,
        );
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].summary.alias, "/lint");
    }

    #[test]
    fn turn_text_does_not_select_a_skill_the_provider_cannot_use() {
        let lint = skill("/lint", vec![AgentProvider::CODEX]);
        let resolved = resolve_turn_skills(
            &[lint],
            &[],
            &[TurnInputItem::Text {
                id: None,
                text: "/lint".to_string(),
            }],
            &AgentProvider::GROK,
        );
        assert!(resolved.is_empty());
    }

    #[test]
    fn explicit_selection_still_wins_without_text_mentions() {
        let lint = skill("/lint", vec![AgentProvider::CODEX]);
        let resolved = resolve_selected_skills(
            &[lint],
            &[SelectedSkillReference {
                skill_id: "skill:lint".to_string(),
                alias: "/lint".to_string(),
            }],
            &AgentProvider::CODEX,
        );
        assert_eq!(resolved.len(), 1);
    }
}

#[cfg(test)]
mod attachment_translation_tests {
    use falcondeck_core::{ImageInput, TurnInputItem};

    use super::{AttachmentKind, attachment_kind, codex_inputs};

    #[test]
    fn sends_a_document_attachment_to_codex_as_a_path_reference() {
        let inputs = vec![TurnInputItem::Image(ImageInput {
            id: "doc-1".to_string(),
            name: Some("brief.pdf".to_string()),
            mime_type: Some("application/pdf".to_string()),
            url: "/tmp/attachments/doc-1/brief.pdf".to_string(),
            local_path: Some("/tmp/attachments/doc-1/brief.pdf".to_string()),
        })];

        let translated = codex_inputs(&inputs, &[]);

        assert_eq!(translated[0]["type"], "text");
        assert_eq!(
            translated[0]["text"],
            "[file attachment: /tmp/attachments/doc-1/brief.pdf]"
        );
    }

    #[test]
    fn still_sends_images_to_codex_as_local_images() {
        let inputs = vec![TurnInputItem::Image(ImageInput {
            id: "img-1".to_string(),
            name: Some("shot.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: "/tmp/attachments/img-1.png".to_string(),
            local_path: Some("/tmp/attachments/img-1.png".to_string()),
        })];

        let translated = codex_inputs(&inputs, &[]);

        assert_eq!(translated[0]["type"], "localImage");
        assert_eq!(translated[0]["path"], "/tmp/attachments/img-1.png");
    }

    #[test]
    fn classifies_attachments_without_a_media_type_by_file_name() {
        let named = |name: &str| ImageInput {
            id: "a".to_string(),
            name: Some(name.to_string()),
            mime_type: None,
            url: String::new(),
            local_path: None,
        };

        assert_eq!(attachment_kind(&named("shot.PNG")), AttachmentKind::Image);
        assert_eq!(
            attachment_kind(&named("notes.pdf")),
            AttachmentKind::Document
        );
    }
}
