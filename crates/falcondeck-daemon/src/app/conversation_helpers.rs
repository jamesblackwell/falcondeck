use std::{path::Path, sync::LazyLock};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use falcondeck_core::{
    ApprovalDecision, AssistantMessagePhase, ContentLifecycle, ConversationArtifact,
    ConversationFileChange, ConversationImage, ConversationItem, ConversationMemoryCitation,
    ConversationWebSearch, InteractiveQuestion, InteractiveQuestionOption,
    InteractiveResponsePayload, MemoryCitationEntry, ServiceLevel, ThreadPlan, ToolActivityKind,
    ToolArtifactKind, ToolCallDetail, ToolCallDisplay, ToolCommandAction, ToolHistoryMode,
    ToolMcpAppContext, ToolOutputContentItem, ToolProviderOutputSummary, ToolTestSummary,
    TurnInputItem, WebSearchActionKind,
};
use futures_util::future::join_all;
use regex::Regex;
use serde_json::Value;
use uuid::Uuid;

const RENDERABLE_IMAGE_URL_PREFIXES: [&str; 5] =
    ["data:", "http://", "https://", "blob:", "asset:"];

/// Skill files are agent instructions, not useful tool output for a chat
/// transcript. Keep the activity row, but never retain or transport the full
/// markdown body when an agent reads or loads one.
pub(crate) fn should_suppress_tool_output(title: &str, kind: &str) -> bool {
    let normalized_title = title.to_ascii_lowercase();
    let normalized_kind = kind.to_ascii_lowercase();

    normalized_title.starts_with("load skill")
        || normalized_title.contains(".agents/skills/")
        || normalized_title.contains(".codex/skills/")
        || normalized_title.contains(".claude/commands/")
        || normalized_title.contains("/skill.md")
        || normalized_title
            .split(|character: char| character.is_whitespace() || matches!(character, '/' | ':'))
            .any(|part| part == "skill.md")
        || matches!(
            normalized_kind.as_str(),
            "skill" | "skill_load" | "skillload" | "load_skill"
        )
}

/// Removes sensitive/noisy skill bodies before an item enters daemon state or
/// is emitted to clients. Recompute display metadata because an output-less
/// skill row is not a command-output artifact.
pub(crate) fn sanitize_conversation_item(item: &mut ConversationItem) {
    let ConversationItem::ToolCall {
        title,
        tool_kind,
        output,
        exit_code,
        display,
        detail,
        status,
        ..
    } = item
    else {
        return;
    };

    if should_suppress_tool_output(title, tool_kind) {
        *output = None;
        **display = tool_display_metadata(title, tool_kind, status, *exit_code, None);
    }
    display.provider_output_summary = match detail.as_deref() {
        Some(ToolCallDetail::Mcp { result, .. }) => {
            Some(mcp_provider_output_summary(result.as_ref()))
        }
        _ => None,
    };
}

fn mcp_provider_output_summary(result: Option<&Value>) -> ToolProviderOutputSummary {
    let mut summary = ToolProviderOutputSummary::default();
    let Some(result) = result.and_then(Value::as_object) else {
        return summary;
    };

    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content {
            let Some(item) = item.as_object() else {
                continue;
            };
            match item.get("type").and_then(Value::as_str) {
                Some("text") if item.get("text").is_some_and(Value::is_string) => {
                    summary.text_blocks += 1;
                }
                Some("image") if has_mcp_media_source(item) => summary.images += 1,
                Some("audio") if has_mcp_media_source(item) => summary.audio += 1,
                Some("resource_link")
                    if has_nonempty_string(item.get("uri"))
                        && has_nonempty_string(item.get("name")) =>
                {
                    summary.resource_links += 1;
                }
                Some("resource")
                    if item
                        .get("resource")
                        .and_then(Value::as_object)
                        .is_some_and(|resource| has_nonempty_string(resource.get("uri"))) =>
                {
                    summary.embedded_resources += 1;
                }
                _ => {}
            }
        }
    }
    if result
        .get("structuredContent")
        .filter(|value| !value.is_null())
        .or_else(|| {
            result
                .get("structured_content")
                .filter(|value| !value.is_null())
        })
        .is_some()
    {
        summary.structured_results = 1;
    }
    summary
}

fn has_mcp_media_source(item: &serde_json::Map<String, Value>) -> bool {
    has_nonempty_string(item.get("url"))
        || item
            .get("data")
            .and_then(Value::as_str)
            .is_some_and(is_normalized_base64)
}

fn has_nonempty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

fn is_normalized_base64(value: &str) -> bool {
    let mut symbols = 0_usize;
    let mut padding = 0_u8;
    let mut saw_padding = false;
    for character in value.chars().filter(|character| !character.is_whitespace()) {
        symbols += 1;
        if character == '=' {
            saw_padding = true;
            padding += 1;
            if padding > 2 {
                return false;
            }
        } else if character.is_ascii_alphanumeric() || matches!(character, '+' | '/') {
            if saw_padding {
                return false;
            }
        } else {
            return false;
        }
    }
    symbols > 0 && symbols.is_multiple_of(4)
}

#[cfg(test)]
mod provider_output_summary_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitizing_an_mcp_call_derives_lightweight_provider_output_metadata() {
        let mut item = ConversationItem::ToolCall {
            id: "mcp-1".to_string(),
            title: "Provider · Search".to_string(),
            tool_kind: "mcp".to_string(),
            status: "completed".to_string(),
            output: None,
            exit_code: None,
            display: Box::new(tool_display_metadata(
                "Provider · Search",
                "mcp",
                "completed",
                None,
                None,
            )),
            detail: Some(Box::new(ToolCallDetail::Mcp {
                server: "provider".to_string(),
                tool: "search".to_string(),
                arguments: json!({}),
                result: Some(json!({
                    "content": [
                        { "type": "text", "text": "Canonical output" },
                        { "type": "image", "data": "aGVs\nbG8=", "mimeType": "image/png" },
                        { "type": "image", "data": "not base64!", "mimeType": "image/png" },
                        { "type": "audio", "url": "https://example.com/audio.wav" },
                        { "type": "resource_link", "uri": "https://example.com/page", "name": "Page" },
                        { "type": "resource_link", "uri": "https://example.com/missing-name" },
                        { "type": "resource", "resource": { "uri": "file:///tmp/report.pdf", "blob": "not base64!" } },
                        { "type": "resource", "resource": { "text": "missing uri" } }
                    ],
                    "structured_content": { "count": 3 }
                })),
                error: None,
                duration_ms: Some(12),
                app_context: None,
            })),
            created_at: Utc::now(),
            completed_at: Some(Utc::now()),
        };

        sanitize_conversation_item(&mut item);

        let ConversationItem::ToolCall { display, .. } = item else {
            panic!("expected tool call");
        };
        assert_eq!(
            display.provider_output_summary,
            Some(ToolProviderOutputSummary {
                text_blocks: 1,
                images: 1,
                audio: 1,
                resource_links: 1,
                embedded_resources: 1,
                structured_results: 1,
            })
        );
    }

    #[test]
    fn base64_validation_accepts_whitespace_but_rejects_malformed_padding() {
        assert!(is_normalized_base64("aGVs\nbG8="));
        assert!(!is_normalized_base64("AA=A"));
        assert!(!is_normalized_base64("AAAA==="));
        assert!(!is_normalized_base64("A"));
    }
}

/// Rehydrates compact on-disk image references for clients that cannot load
/// daemon-local paths directly (notably remote web and mobile clients).
///
/// The stored conversation item remains compact; this clone is only used at
/// the transport boundary.
pub(super) async fn with_renderable_attachment_previews(
    mut item: ConversationItem,
) -> ConversationItem {
    match &mut item {
        ConversationItem::UserMessage { attachments, .. } => {
            for attachment in attachments {
                if let Some(url) = renderable_image_preview(
                    &attachment.url,
                    attachment.local_path.as_deref(),
                    attachment.mime_type.as_deref(),
                )
                .await
                {
                    attachment.url = url;
                }
            }
        }
        ConversationItem::Image { image, .. } => {
            if let Some(url) = renderable_image_preview(
                &image.url,
                image.local_path.as_deref(),
                image.mime_type.as_deref(),
            )
            .await
            {
                image.url = url;
            }
        }
        _ => {}
    }

    item
}

async fn renderable_image_preview(
    url: &str,
    local_path: Option<&str>,
    mime_type: Option<&str>,
) -> Option<String> {
    if RENDERABLE_IMAGE_URL_PREFIXES
        .iter()
        .any(|prefix| url.trim().starts_with(prefix))
    {
        return None;
    }
    let local_path = local_path.map(str::trim).filter(|path| !path.is_empty())?;
    let mime_type = attachment_preview_mime_type(mime_type, local_path)?;
    let bytes = tokio::fs::read(local_path).await.ok()?;
    Some(format!("data:{mime_type};base64,{}", BASE64.encode(bytes)))
}

pub(crate) fn codex_image_conversation_item(
    item: &Value,
    created_at: chrono::DateTime<Utc>,
    fallback_lifecycle: ContentLifecycle,
) -> Option<ConversationItem> {
    let id = item.get("id")?.as_str()?.to_string();
    let kind = item
        .get("type")
        .or_else(|| item.get("kind"))
        .and_then(Value::as_str)?;
    let lifecycle = content_lifecycle_for_status(
        item.get("status").and_then(Value::as_str),
        fallback_lifecycle,
    );
    let (title, alt_text, raw_url) = codex_image_fields(kind, item)?;
    let raw_url = raw_url.trim();
    let is_renderable_url = RENDERABLE_IMAGE_URL_PREFIXES
        .iter()
        .any(|prefix| raw_url.starts_with(prefix));
    let is_local_path = Path::new(raw_url).is_absolute();
    let url = if raw_url.is_empty() || is_renderable_url || is_local_path {
        raw_url.to_string()
    } else if BASE64.decode(raw_url).is_ok() {
        format!("data:image/png;base64,{raw_url}")
    } else {
        String::new()
    };
    let local_path = is_local_path.then(|| raw_url.to_string());
    let name = local_path.as_deref().and_then(|path| {
        Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
    });
    let mime_type = local_path
        .as_deref()
        .and_then(|path| attachment_preview_mime_type(None, path))
        .or_else(|| {
            url.starts_with("data:image/png")
                .then(|| "image/png".to_string())
        });

    Some(ConversationItem::Image {
        id: id.clone(),
        title,
        image: ConversationImage {
            id: format!("{id}-image"),
            name,
            mime_type,
            url,
            local_path,
            alt_text,
        },
        lifecycle,
        created_at,
    })
}

pub(crate) fn content_lifecycle_for_status(
    status: Option<&str>,
    fallback: ContentLifecycle,
) -> ContentLifecycle {
    match status
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
        .as_str()
    {
        "pending" | "queued" => ContentLifecycle::Pending,
        "running" | "streaming" | "in_progress" | "inprogress" => ContentLifecycle::Streaming,
        "failed" | "failure" | "error" | "errored" => ContentLifecycle::Error,
        "interrupted" | "cancelled" | "canceled" | "aborted" | "stopped" | "denied"
        | "declined" | "rejected" => ContentLifecycle::Interrupted,
        "completed" | "complete" | "success" | "succeeded" | "done" => ContentLifecycle::Complete,
        _ => fallback,
    }
}

/// Builds the terminal assistant receipt needed when a turn fails or is
/// interrupted before it emits a final/legacy assistant block. The provider's
/// turn id keeps live delivery and later `thread/read` hydration on one stable
/// identity; providers without one fall back to the authoritative user item.
///
/// Commentary does not count as a terminal answer. A turn can stream progress
/// and then fail before answering, and the transcript must preserve both facts.
pub(crate) fn terminal_assistant_receipt(
    turn_items: &[ConversationItem],
    terminal: ContentLifecycle,
    created_at: DateTime<Utc>,
    turn_id_hint: Option<&str>,
) -> Option<ConversationItem> {
    terminal_assistant_receipt_with_error(turn_items, terminal, created_at, turn_id_hint, None)
}

pub(crate) fn terminal_assistant_receipt_with_error(
    turn_items: &[ConversationItem],
    terminal: ContentLifecycle,
    created_at: DateTime<Utc>,
    turn_id_hint: Option<&str>,
    error: Option<&str>,
) -> Option<ConversationItem> {
    if !matches!(
        terminal,
        ContentLifecycle::Interrupted | ContentLifecycle::Error
    ) {
        return None;
    }

    let latest_user_index = turn_items
        .iter()
        .rposition(|item| matches!(item, ConversationItem::UserMessage { .. }));
    let current_turn = latest_user_index
        .map(|index| &turn_items[index..])
        .unwrap_or(turn_items);
    let has_answer = current_turn.iter().any(|item| {
        matches!(
            item,
            ConversationItem::AssistantMessage {
                phase: None | Some(AssistantMessagePhase::FinalAnswer),
                ..
            } | ConversationItem::CodeReview { .. }
        )
    });
    if has_answer {
        return None;
    }

    // Prefer the user boundary itself. `latest_turn_id` can still name the
    // previous completed Codex turn when provider startup fails before
    // `turn/started`, while the just-added user item is already authoritative.
    let source_id = current_turn
        .iter()
        .find_map(|item| match item {
            ConversationItem::UserMessage { id, turn_id, .. } => {
                Some(turn_id.clone().unwrap_or_else(|| id.clone()))
            }
            _ => None,
        })
        .or_else(|| turn_id_hint.map(str::to_string))?;
    let id = format!("falcondeck-turn-receipt-{source_id}");
    if turn_items.iter().any(|item| {
        matches!(item, ConversationItem::AssistantMessage { id: existing, .. } if existing == &id)
    }) {
        return None;
    }

    Some(ConversationItem::AssistantMessage {
        id,
        text: String::new(),
        phase: None,
        memory_citation: None,
        citations: Vec::new(),
        lifecycle: terminal,
        error: bounded_turn_error(error),
        created_at,
    })
}

pub(super) fn bounded_turn_error(error: Option<&str>) -> Option<String> {
    error
        .map(str::trim)
        .filter(|error| !error.is_empty())
        .map(|error| error.chars().take(2_000).collect())
}

pub(crate) fn codex_assistant_conversation_item(
    item: &Value,
    created_at: chrono::DateTime<Utc>,
    lifecycle: ContentLifecycle,
) -> Option<ConversationItem> {
    let id = item.get("id")?.as_str()?.to_string();
    let kind = item
        .get("type")
        .or_else(|| item.get("kind"))
        .and_then(Value::as_str)?;
    if !matches!(kind, "agentMessage" | "agent_message") {
        return None;
    }
    let (phase, memory_citation) = codex_assistant_message_metadata(item);
    Some(ConversationItem::AssistantMessage {
        id,
        text: item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        phase,
        memory_citation,
        citations: Vec::new(),
        lifecycle,
        error: None,
        created_at,
    })
}

pub(crate) fn codex_context_compaction_conversation_item(
    item: &Value,
    created_at: chrono::DateTime<Utc>,
    lifecycle: falcondeck_core::ToolLifecycle,
    completed_at: Option<chrono::DateTime<Utc>>,
) -> Option<ConversationItem> {
    let kind = extract_string(item, &["kind", "type"])?;
    if !kind.eq_ignore_ascii_case("contextCompaction")
        && !kind.eq_ignore_ascii_case("context_compaction")
    {
        return None;
    }

    Some(ConversationItem::ContextCompaction {
        id: extract_string(item, &["id"]).unwrap_or_else(|| "context-compaction".to_string()),
        lifecycle,
        created_at,
        completed_at,
    })
}

pub(crate) fn codex_assistant_message_metadata(
    item: &Value,
) -> (
    Option<AssistantMessagePhase>,
    Option<ConversationMemoryCitation>,
) {
    let phase = match item.get("phase").and_then(Value::as_str) {
        Some("commentary") => Some(AssistantMessagePhase::Commentary),
        Some("final_answer" | "finalAnswer") => Some(AssistantMessagePhase::FinalAnswer),
        _ => None,
    };
    let memory_citation = item
        .get("memoryCitation")
        .or_else(|| item.get("memory_citation"))
        .filter(|citation| citation.is_object())
        .map(|citation| ConversationMemoryCitation {
            entries: citation
                .get("entries")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    let path = entry.get("path")?.as_str()?.to_string();
                    let line_start = u32::try_from(
                        entry
                            .get("lineStart")
                            .or_else(|| entry.get("line_start"))?
                            .as_u64()?,
                    )
                    .ok()?;
                    let line_end = u32::try_from(
                        entry
                            .get("lineEnd")
                            .or_else(|| entry.get("line_end"))?
                            .as_u64()?,
                    )
                    .ok()?;
                    if line_start == 0 || line_end < line_start {
                        return None;
                    }
                    Some(MemoryCitationEntry {
                        path,
                        line_start,
                        line_end,
                        note: entry
                            .get("note")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect(),
            thread_ids: citation
                .get("threadIds")
                .or_else(|| citation.get("thread_ids"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        })
        .filter(|citation| !citation.entries.is_empty() || !citation.thread_ids.is_empty());
    (phase, memory_citation)
}

pub(crate) fn codex_web_search_conversation_item(
    item: &Value,
    created_at: chrono::DateTime<Utc>,
    fallback_lifecycle: ContentLifecycle,
) -> Option<ConversationItem> {
    let id = item.get("id")?.as_str()?.to_string();
    let kind = item
        .get("type")
        .or_else(|| item.get("kind"))
        .and_then(Value::as_str)?;
    if !matches!(kind, "webSearch" | "web_search") {
        return None;
    }

    let top_level_query = item
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let action = item.get("action").filter(|value| value.is_object());
    let action_type = action
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("search");
    let action_kind = WebSearchActionKind::new(match action_type {
        "openPage" => "open_page",
        "findInPage" => "find_in_page",
        other => other,
    });
    let mut queries = action
        .and_then(|value| value.get("queries"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(query) = action
        .and_then(|value| value.get("query"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|query| !query.is_empty())
        && !queries.iter().any(|entry| entry == query)
    {
        queries.insert(0, query.to_string());
    }
    if queries.is_empty() && !top_level_query.is_empty() {
        queries.push(top_level_query.clone());
    }

    let lifecycle = content_lifecycle_for_status(
        item.get("status").and_then(Value::as_str),
        fallback_lifecycle,
    );
    Some(ConversationItem::WebSearch {
        id: id.clone(),
        search: ConversationWebSearch {
            id: format!("{id}-search"),
            query: top_level_query,
            action_kind,
            queries,
            url: action
                .and_then(|value| value.get("url"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(str::to_string),
            pattern: action
                .and_then(|value| value.get("pattern"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|pattern| !pattern.is_empty())
                .map(str::to_string),
        },
        lifecycle,
        created_at,
    })
}

pub(crate) fn codex_file_change_conversation_item(
    item: &Value,
    created_at: chrono::DateTime<Utc>,
    fallback_status: &str,
    completed_at: Option<chrono::DateTime<Utc>>,
) -> Option<ConversationItem> {
    let id = item.get("id")?.as_str()?.to_string();
    let kind = item
        .get("type")
        .or_else(|| item.get("kind"))
        .and_then(Value::as_str)?;
    if !matches!(kind, "fileChange" | "file_change") {
        return None;
    }

    let changes = item
        .get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|change| {
            let path = change.get("path")?.as_str()?.trim();
            if path.is_empty() {
                return None;
            }
            let kind_value = change.get("kind");
            let change_kind = kind_value
                .and_then(Value::as_str)
                .or_else(|| {
                    kind_value
                        .and_then(|value| value.get("type"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("update")
                .to_string();
            let move_path = change
                .get("movePath")
                .or_else(|| change.get("move_path"))
                .or_else(|| kind_value.and_then(|value| value.get("movePath")))
                .or_else(|| kind_value.and_then(|value| value.get("move_path")))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            Some(ConversationFileChange {
                path: path.to_string(),
                change_kind,
                diff: change
                    .get("diff")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                move_path,
            })
        })
        .collect::<Vec<_>>();
    let status = item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(fallback_status)
        .to_string();
    let lifecycle = tool_display_metadata("File change", kind, &status, None, None).lifecycle;

    Some(ConversationItem::FileChange {
        id,
        changes,
        status,
        lifecycle,
        created_at,
        completed_at,
    })
}

pub(crate) fn codex_tool_call_detail(item: &Value) -> Option<ToolCallDetail> {
    let kind = item
        .get("type")
        .or_else(|| item.get("kind"))
        .and_then(Value::as_str)?;
    let duration_ms = item
        .get("durationMs")
        .or_else(|| item.get("duration_ms"))
        .and_then(Value::as_u64);
    match kind {
        "commandExecution" | "command_execution" => {
            let command = item.get("command")?.as_str()?.to_string();
            let actions = item
                .get("commandActions")
                .or_else(|| item.get("command_actions"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|action| ToolCommandAction {
                    action_kind: action
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    command: action
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: action
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    path: action
                        .get("path")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    query: action
                        .get("query")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
                .collect();
            Some(ToolCallDetail::CommandExecution {
                command,
                cwd: item
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                actions,
                process_id: item
                    .get("processId")
                    .or_else(|| item.get("process_id"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                duration_ms,
                source: item
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        }
        "mcpToolCall" | "mcp_tool_call" => {
            let app_context = item
                .get("appContext")
                .or_else(|| item.get("app_context"))
                .filter(|context| !context.is_null())
                .and_then(|context| {
                    Some(ToolMcpAppContext {
                        connector_id: context
                            .get("connectorId")
                            .or_else(|| context.get("connector_id"))
                            .and_then(Value::as_str)?
                            .to_string(),
                        app_name: optional_json_string(context, "appName", "app_name"),
                        action_name: optional_json_string(context, "actionName", "action_name"),
                        link_id: optional_json_string(context, "linkId", "link_id"),
                        resource_uri: optional_json_string(context, "resourceUri", "resource_uri"),
                        template_id: optional_json_string(context, "templateId", "template_id"),
                    })
                });
            Some(ToolCallDetail::Mcp {
                server: item.get("server")?.as_str()?.to_string(),
                tool: item.get("tool")?.as_str()?.to_string(),
                arguments: item.get("arguments").cloned().unwrap_or(Value::Null),
                result: item
                    .get("result")
                    .filter(|result| !result.is_null())
                    .cloned(),
                error: item.get("error").and_then(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| error.as_str())
                        .map(str::to_string)
                }),
                duration_ms,
                app_context,
            })
        }
        "dynamicToolCall" | "dynamic_tool_call" => Some(ToolCallDetail::Dynamic {
            tool: item.get("tool")?.as_str()?.to_string(),
            namespace: item
                .get("namespace")
                .and_then(Value::as_str)
                .map(str::to_string),
            arguments: item.get("arguments").cloned().unwrap_or(Value::Null),
            content_items: item
                .get("contentItems")
                .or_else(|| item.get("content_items"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(
                    |content| match content.get("type").and_then(Value::as_str) {
                        Some("inputText") | Some("input_text") => {
                            Some(ToolOutputContentItem::Text {
                                text: content.get("text")?.as_str()?.to_string(),
                            })
                        }
                        Some("inputImage") | Some("input_image") => {
                            Some(ToolOutputContentItem::Image {
                                url: content
                                    .get("imageUrl")
                                    .or_else(|| content.get("image_url"))?
                                    .as_str()?
                                    .to_string(),
                            })
                        }
                        _ => None,
                    },
                )
                .collect(),
            success: item.get("success").and_then(Value::as_bool),
            duration_ms,
        }),
        "collabAgentToolCall" | "collab_agent_tool_call" => Some(ToolCallDetail::CollabAgent {
            tool: item.get("tool")?.as_str()?.to_string(),
            sender_thread_id: item
                .get("senderThreadId")
                .or_else(|| item.get("sender_thread_id"))?
                .as_str()?
                .to_string(),
            receiver_thread_ids: item
                .get("receiverThreadIds")
                .or_else(|| item.get("receiver_thread_ids"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            prompt: optional_json_string(item, "prompt", "prompt"),
            model: optional_json_string(item, "model", "model"),
            reasoning_effort: optional_json_string(item, "reasoningEffort", "reasoning_effort"),
            agent_states: item
                .get("agentsStates")
                .or_else(|| item.get("agent_states"))
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter_map(|(thread_id, state)| {
                    Some((
                        thread_id.clone(),
                        falcondeck_core::ToolCollabAgentState {
                            status: state.get("status")?.as_str()?.to_string(),
                            message: state
                                .get("message")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        },
                    ))
                })
                .collect(),
        }),
        "subAgentActivity" | "sub_agent_activity" => Some(ToolCallDetail::SubagentActivity {
            activity: item.get("kind")?.as_str()?.to_string(),
            agent_thread_id: item
                .get("agentThreadId")
                .or_else(|| item.get("agent_thread_id"))?
                .as_str()?
                .to_string(),
            agent_path: item
                .get("agentPath")
                .or_else(|| item.get("agent_path"))?
                .as_str()?
                .to_string(),
        }),
        _ => None,
    }
}

fn optional_json_string(value: &Value, camel: &str, snake: &str) -> Option<String> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) fn codex_tool_call_output(item: &Value) -> Option<String> {
    match codex_tool_call_detail(item)? {
        ToolCallDetail::Mcp { result, error, .. } => error.or_else(|| {
            let result = result?;
            let text = result
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|content| content.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }),
        ToolCallDetail::Dynamic { content_items, .. } => {
            let text = content_items
                .into_iter()
                .filter_map(|content| match content {
                    ToolOutputContentItem::Text { text } => Some(text),
                    ToolOutputContentItem::Image { .. } => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        ToolCallDetail::CommandExecution { .. }
        | ToolCallDetail::CollabAgent { .. }
        | ToolCallDetail::SubagentActivity { .. }
        | ToolCallDetail::Hook { .. }
        | ToolCallDetail::GuardianReview { .. } => None,
    }
}

pub(crate) fn codex_tool_call_title(item: &Value) -> Option<String> {
    let kind = item
        .get("type")
        .or_else(|| item.get("kind"))
        .and_then(Value::as_str)?;
    match kind {
        "commandExecution" | "command_execution" => item
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string),
        "mcpToolCall" | "mcp_tool_call" => {
            let context = item.get("appContext").or_else(|| item.get("app_context"));
            let app = context.and_then(|value| {
                optional_json_string(value, "appName", "app_name")
                    .or_else(|| optional_json_string(value, "connectorId", "connector_id"))
            });
            let action =
                context.and_then(|value| optional_json_string(value, "actionName", "action_name"));
            match (app, action) {
                (Some(app), Some(action)) => Some(format!("{app} · {action}")),
                _ => Some(format!(
                    "{} · {}",
                    item.get("server")?.as_str()?,
                    item.get("tool")?.as_str()?
                )),
            }
        }
        "dynamicToolCall" | "dynamic_tool_call" => {
            let tool = item.get("tool")?.as_str()?;
            Some(match item.get("namespace").and_then(Value::as_str) {
                Some(namespace) if !namespace.is_empty() => format!("{namespace} · {tool}"),
                _ => tool.to_string(),
            })
        }
        "collabAgentToolCall" | "collab_agent_tool_call" => Some(
            match item.get("tool").and_then(Value::as_str)? {
                "spawnAgent" => "Spawn sub-agent",
                "sendInput" => "Send input to sub-agent",
                "resumeAgent" => "Resume sub-agent",
                "wait" => "Wait for sub-agents",
                "closeAgent" => "Close sub-agent",
                tool => tool,
            }
            .to_string(),
        ),
        "subAgentActivity" | "sub_agent_activity" => {
            let activity = item.get("kind")?.as_str()?;
            Some(format!("Sub-agent {activity}"))
        }
        "sleep" => item
            .get("durationMs")
            .or_else(|| item.get("duration_ms"))
            .and_then(Value::as_u64)
            .map(|duration| format!("Wait {}", format_duration_ms(duration))),
        _ => None,
    }
}

fn format_duration_ms(duration: u64) -> String {
    if duration < 1_000 {
        format!("{duration} ms")
    } else if duration.is_multiple_of(1_000) {
        format!("{}s", duration / 1_000)
    } else {
        format!("{:.1}s", duration as f64 / 1_000.0)
    }
}

pub(crate) fn codex_plan_conversation_item(
    item: &Value,
    created_at: DateTime<Utc>,
) -> Option<ConversationItem> {
    let kind = item
        .get("type")
        .or_else(|| item.get("kind"))
        .and_then(Value::as_str)?;
    if kind != "plan" {
        return None;
    }
    Some(ConversationItem::Plan {
        id: item.get("id")?.as_str()?.to_string(),
        plan: ThreadPlan {
            explanation: item.get("text").and_then(Value::as_str).map(str::to_string),
            steps: Vec::new(),
        },
        created_at,
    })
}

pub(crate) fn codex_hook_prompt_conversation_item(
    item: &Value,
    created_at: DateTime<Utc>,
) -> Option<ConversationItem> {
    let kind = item
        .get("type")
        .or_else(|| item.get("kind"))
        .and_then(Value::as_str)?;
    if !matches!(kind, "hookPrompt" | "hook_prompt") {
        return None;
    }
    let message = item
        .get("fragments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|fragment| fragment.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!message.is_empty()).then_some(ConversationItem::Service {
        id: item.get("id")?.as_str()?.to_string(),
        level: ServiceLevel::Info,
        message,
        created_at,
    })
}

pub(crate) fn codex_hook_run_conversation_item(
    run: &Value,
    created_at: DateTime<Utc>,
    completed_at: Option<DateTime<Utc>>,
) -> Option<ConversationItem> {
    let id = run.get("id")?.as_str()?.to_string();
    let event_name = run.get("eventName")?.as_str()?.to_string();
    let status = run
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(if completed_at.is_some() {
            "completed"
        } else {
            "running"
        })
        .to_string();
    let title = format!("Hook · {}", humanize_camel_case(&event_name));
    let entries = run
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some(falcondeck_core::ToolHookOutputEntry {
                entry_kind: entry.get("kind")?.as_str()?.to_string(),
                text: entry.get("text")?.as_str()?.to_string(),
            })
        })
        .collect::<Vec<_>>();
    let display = tool_display_metadata(&title, "hookRun", &status, None, None);
    Some(ConversationItem::ToolCall {
        id,
        title,
        tool_kind: "hookRun".to_string(),
        status,
        output: None,
        exit_code: None,
        display: Box::new(display),
        detail: Some(Box::new(ToolCallDetail::Hook {
            event_name,
            handler_type: run.get("handlerType")?.as_str()?.to_string(),
            execution_mode: run.get("executionMode")?.as_str()?.to_string(),
            scope: run.get("scope")?.as_str()?.to_string(),
            source_path: run.get("sourcePath")?.as_str()?.to_string(),
            duration_ms: run.get("durationMs").and_then(Value::as_u64),
            status_message: run
                .get("statusMessage")
                .and_then(Value::as_str)
                .map(str::to_string),
            entries,
        })),
        created_at,
        completed_at,
    })
}

pub(super) fn humanize_camel_case(value: &str) -> String {
    let mut result = String::with_capacity(value.len() + 4);
    for (index, character) in value.chars().enumerate() {
        if index > 0 && character.is_uppercase() {
            result.push(' ');
        }
        result.extend(character.to_lowercase());
    }
    result
}

fn codex_image_fields<'a>(
    kind: &str,
    item: &'a Value,
) -> Option<(Option<String>, Option<String>, &'a str)> {
    let fields = match kind {
        "imageGeneration" | "image_generation" => {
            let revised_prompt = item
                .get("revisedPrompt")
                .or_else(|| item.get("revised_prompt"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let url = item
                .get("savedPath")
                .or_else(|| item.get("saved_path"))
                .and_then(Value::as_str)
                .or_else(|| item.get("result").and_then(Value::as_str))
                .unwrap_or_default();
            (Some("Generated image".to_string()), revised_prompt, url)
        }
        "imageView" | "image_view" => {
            let path = item.get("path").and_then(Value::as_str).unwrap_or_default();
            let name = Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Image");
            (
                Some(name.to_string()),
                Some(format!("Viewed image {name}")),
                path,
            )
        }
        _ => return None,
    };
    Some(fields)
}

pub(super) async fn with_renderable_attachment_previews_for_items(
    items: Vec<ConversationItem>,
) -> Vec<ConversationItem> {
    join_all(items.into_iter().map(with_renderable_attachment_previews)).await
}

fn attachment_preview_mime_type(
    declared_mime_type: Option<&str>,
    local_path: &str,
) -> Option<String> {
    if let Some(mime_type) = declared_mime_type
        .map(str::trim)
        .filter(|mime_type| mime_type.starts_with("image/"))
    {
        return Some(mime_type.to_string());
    }

    match Path::new(local_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png".to_string()),
        Some("jpg" | "jpeg") => Some("image/jpeg".to_string()),
        Some("gif") => Some("image/gif".to_string()),
        Some("webp") => Some("image/webp".to_string()),
        Some("bmp") => Some("image/bmp".to_string()),
        Some("tif" | "tiff") => Some("image/tiff".to_string()),
        Some("svg") => Some("image/svg+xml".to_string()),
        Some("heic") => Some("image/heic".to_string()),
        Some("heif") => Some("image/heif".to_string()),
        _ => None,
    }
}

use super::ManagedThread;
use crate::codex::{extract_datetime_or_timestamp, extract_string};

/// Accepts a client-supplied item id only when it is unmistakably one of ours:
/// `user-` followed by 1–64 id-safe characters. Anything else falls back to a
/// fresh uuid so a buggy or hostile client cannot mint arbitrary ids (which
/// key transcript reconciliation on every client).
pub(super) fn sanitize_user_item_id(requested: Option<&str>) -> Option<String> {
    let requested = requested?;
    let suffix = requested.strip_prefix("user-")?;
    if suffix.is_empty() || suffix.len() > 64 {
        return None;
    }
    suffix
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        .then(|| requested.to_string())
}

pub(super) fn build_user_message_item(
    inputs: &[TurnInputItem],
    requested_id: Option<&str>,
    turn_id: Option<String>,
    previous_turn_id: Option<String>,
) -> ConversationItem {
    let mut text = String::new();
    let mut attachments = Vec::new();

    for input in inputs {
        match input {
            TurnInputItem::Text { text: next, .. } => {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(next);
            }
            TurnInputItem::Image(image) => attachments.push(image.clone()),
        }
    }

    ConversationItem::UserMessage {
        id: sanitize_user_item_id(requested_id)
            .unwrap_or_else(|| format!("user-{}", Uuid::new_v4().simple())),
        text,
        attachments,
        turn_id,
        previous_turn_id,
        created_at: Utc::now(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ToolSettlement {
    Completed,
    Failed,
    Interrupted,
}

impl ToolSettlement {
    fn status(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }

    fn lifecycle(self) -> falcondeck_core::ToolLifecycle {
        match self {
            Self::Completed => falcondeck_core::ToolLifecycle::Succeeded,
            Self::Failed => falcondeck_core::ToolLifecycle::Failed,
            Self::Interrupted => falcondeck_core::ToolLifecycle::Interrupted,
        }
    }
}

fn is_transient_tool_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "created"
            | "running"
            | "in_progress"
            | "inprogress"
            | "streaming"
            | "pending"
            | "queued"
            | "awaiting_confirmation"
            | "awaiting_approval"
            | "pending_approval"
    )
}

/// Closes transient tool calls with the actual turn outcome. Terminal tool
/// notifications remain authoritative and are never overwritten.
pub(super) fn settle_tool_call_items(
    items: &mut [ConversationItem],
    settled_at: chrono::DateTime<Utc>,
    settlement: ToolSettlement,
) -> Vec<ConversationItem> {
    let mut updated = Vec::new();
    for item in items {
        match item {
            ConversationItem::ToolCall {
                status,
                completed_at,
                title,
                tool_kind,
                output,
                exit_code,
                display,
                ..
            } if is_transient_tool_status(status) => {
                *status = settlement.status().to_string();
                *completed_at = Some(settled_at);
                **display =
                    tool_display_metadata(title, tool_kind, status, *exit_code, output.as_deref());
                updated.push(item.clone());
            }
            ConversationItem::FileChange {
                status,
                lifecycle,
                completed_at,
                ..
            } if is_transient_tool_status(status) => {
                *status = settlement.status().to_string();
                *lifecycle = settlement.lifecycle();
                *completed_at = Some(settled_at);
                updated.push(item.clone());
            }
            ConversationItem::ContextCompaction {
                lifecycle,
                completed_at,
                ..
            } if matches!(
                lifecycle,
                falcondeck_core::ToolLifecycle::Unknown
                    | falcondeck_core::ToolLifecycle::Queued
                    | falcondeck_core::ToolLifecycle::Running
            ) =>
            {
                *lifecycle = settlement.lifecycle();
                *completed_at = Some(settled_at);
                updated.push(item.clone());
            }
            _ => {}
        }
    }
    updated
}

/// Settles only transient assistant/reasoning/image/research blocks. Hydrated history and
/// earlier completed turns remain untouched when a later turn terminates.
pub(super) fn settle_content_items(
    items: &mut [ConversationItem],
    terminal: ContentLifecycle,
    settled_at: DateTime<Utc>,
    error: Option<&str>,
) -> Vec<ConversationItem> {
    debug_assert!(matches!(
        terminal,
        ContentLifecycle::Complete | ContentLifecycle::Interrupted | ContentLifecycle::Error
    ));
    let mut updated = Vec::new();
    for item in items {
        let lifecycle = match item {
            ConversationItem::AssistantMessage { lifecycle, .. }
            | ConversationItem::Reasoning { lifecycle, .. }
            | ConversationItem::CodeReview { lifecycle, .. }
            | ConversationItem::Artifact { lifecycle, .. }
            | ConversationItem::Unsupported { lifecycle, .. }
            | ConversationItem::Image { lifecycle, .. }
            | ConversationItem::WebSearch { lifecycle, .. } => lifecycle,
            _ => continue,
        };
        if matches!(
            lifecycle,
            ContentLifecycle::Pending | ContentLifecycle::Streaming
        ) {
            *lifecycle = terminal;
            if let ConversationItem::AssistantMessage {
                error: item_error, ..
            } = item
            {
                *item_error = if terminal == ContentLifecycle::Error {
                    bounded_turn_error(error)
                } else {
                    None
                };
            }
            if let ConversationItem::Reasoning {
                duration_ms,
                created_at,
                ..
            } = item
                && duration_ms.is_none()
            {
                *duration_ms = u64::try_from((settled_at - *created_at).num_milliseconds()).ok();
            }
            updated.push(item.clone());
        }
    }
    updated
}

pub(super) fn provisional_thread_title_from_inputs(inputs: &[TurnInputItem]) -> Option<String> {
    let text = inputs.iter().find_map(|input| match input {
        TurnInputItem::Text { text, .. } => Some(text.as_str()),
        TurnInputItem::Image(_) => None,
    })?;
    provisional_thread_title_from_text(text)
}

pub(super) fn provisional_thread_title_from_text(text: &str) -> Option<String> {
    let words = text.split_whitespace().take(4).collect::<Vec<_>>();
    if words.is_empty() {
        return None;
    }
    Some(format!("{}...", words.join(" ")))
}

pub(super) fn should_generate_ai_thread_title(thread: &ManagedThread) -> bool {
    let has_user_message = thread
        .items
        .iter()
        .any(|item| matches!(item, ConversationItem::UserMessage { .. }));
    let has_agent_output = thread.items.iter().any(|item| {
        matches!(
            item,
            ConversationItem::AssistantMessage { .. } | ConversationItem::ToolCall { .. }
        )
    });

    has_user_message
        && has_agent_output
        && !thread.manual_title
        && !thread.ai_title_generated
        && (thread.title_is_provider_preview
            || is_placeholder_thread_title(&thread.summary.title)
            || is_provisional_thread_title(&thread.summary.title))
}

pub(super) fn is_placeholder_thread_title(title: &str) -> bool {
    matches!(
        title.trim().to_ascii_lowercase().as_str(),
        "" | "untitled thread"
            | "new thread"
            | "new claude thread"
            | "claude thread"
            | "restored thread"
    )
}

pub(super) fn is_provisional_thread_title(title: &str) -> bool {
    let trimmed = title.trim();
    trimmed.ends_with("...") || trimmed.ends_with('…')
}

pub(super) fn build_ai_thread_title_prompt(items: &[ConversationItem]) -> String {
    let mut excerpts = Vec::new();
    let user_messages = items
        .iter()
        .filter_map(|item| match item {
            ConversationItem::UserMessage { text, .. } => Some(text.trim()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    if let Some(first) = user_messages.first() {
        excerpts.push(format!(
            "First user message:\n{}",
            truncate_preview(first, 600)
        ));
    }

    let recent = items
        .iter()
        .rev()
        .filter_map(|item| match item {
            ConversationItem::UserMessage { text, .. } => Some(format!("User: {}", text.trim())),
            ConversationItem::AssistantMessage { text, .. } => {
                Some(format!("Assistant: {}", text.trim()))
            }
            ConversationItem::ToolCall { title, output, .. } => Some(format!(
                "Tool: {}{}",
                title.trim(),
                output
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!(" -> {}", truncate_preview(value, 180)))
                    .unwrap_or_default()
            )),
            _ => None,
        })
        .filter(|text| !text.trim().is_empty())
        .take(4)
        .collect::<Vec<_>>();
    if !recent.is_empty() {
        let ordered_recent = recent.into_iter().rev().collect::<Vec<_>>().join("\n");
        excerpts.push(format!("Recent messages:\n{ordered_recent}"));
    }

    format!(
        "You are a session renaming tool.\n\
Write a short, specific thread title for this coding conversation.\n\
\n\
Rules:\n\
- 3 to 7 words\n\
- no quotes\n\
- no trailing punctuation\n\
- prefer concrete task nouns\n\
- avoid generic titles like Debugging or Code Help\n\
- return only the title\n\
\n\
{}\n",
        excerpts.join("\n\n")
    )
}

pub(super) fn normalize_generated_thread_title(output: &str) -> Option<String> {
    let candidate = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| is_valid_generated_title_line(line))?;
    let candidate = candidate
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '`')
        .trim()
        .trim_end_matches(['.', '!', '?', ':', ';', ','])
        .trim();
    if candidate.is_empty()
        || is_placeholder_thread_title(candidate)
        || is_provisional_thread_title(candidate)
    {
        return None;
    }
    Some(truncate_preview(candidate, 80))
}

fn is_valid_generated_title_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    let normalized = trimmed.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "user" | "assistant" | "codex" | "claude" | "tokens used"
    ) {
        return false;
    }

    if normalized.starts_with("openai codex v") || normalized.starts_with("workdir:") {
        return false;
    }

    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_digit() || ch == ',' || ch == '.' || ch.is_whitespace())
    {
        return false;
    }

    true
}

pub(super) fn approval_title(method: &str) -> String {
    match method {
        "item/commandExecution/requestApproval" => "Approve command".to_string(),
        "item/fileChange/requestApproval" => "Approve file change".to_string(),
        "skill/requestApproval" => "Approve skill".to_string(),
        other => format!("Approve {}", other.rsplit('/').next().unwrap_or("request")),
    }
}

pub(super) fn notification_timestamp(
    method: &str,
    params: &Value,
) -> Option<chrono::DateTime<Utc>> {
    let preferred_keys: &[&str] = match method {
        "thread/started" => &[
            "timestamp",
            "startedAt",
            "started_at",
            "createdAt",
            "created_at",
        ],
        "thread/name/updated" | "turn/plan/updated" | "turn/diff/updated" => &[
            "timestamp",
            "updatedAt",
            "updated_at",
            "createdAt",
            "created_at",
        ],
        "turn/started" => &[
            "timestamp",
            "startedAt",
            "started_at",
            "createdAt",
            "created_at",
        ],
        "turn/completed" => &[
            "timestamp",
            "completedAt",
            "completed_at",
            "updatedAt",
            "updated_at",
        ],
        _ => &[
            "timestamp",
            "updatedAt",
            "updated_at",
            "createdAt",
            "created_at",
        ],
    };
    extract_datetime_or_timestamp(params, preferred_keys)
}

pub(super) fn parse_interactive_questions(params: &Value) -> Vec<InteractiveQuestion> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .map(|question| InteractiveQuestion {
                    id: extract_string(question, &["id"])
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    header: extract_string(question, &["header"])
                        .unwrap_or_else(|| "Question".to_string()),
                    question: extract_string(question, &["question"])
                        .unwrap_or_else(|| "Provide additional input.".to_string()),
                    is_other: question
                        .get("isOther")
                        .or_else(|| question.get("is_other"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    is_secret: question
                        .get("isSecret")
                        .or_else(|| question.get("is_secret"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    options: question
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .map(|option| InteractiveQuestionOption {
                                    label: extract_string(option, &["label"])
                                        .unwrap_or_else(|| "Option".to_string()),
                                    description: extract_string(option, &["description"])
                                        .unwrap_or_default(),
                                })
                                .collect()
                        }),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_interactive_response_params(
    params: &Value,
) -> Result<InteractiveResponsePayload, String> {
    if let Some(response) = params.get("response")
        && let Some(kind) = extract_string(response, &["kind"])
    {
        return match kind.as_str() {
            "approval" => match extract_string(response, &["decision"]).as_deref() {
                Some("allow") => Ok(InteractiveResponsePayload::Approval {
                    decision: ApprovalDecision::Allow,
                }),
                Some("deny") => Ok(InteractiveResponsePayload::Approval {
                    decision: ApprovalDecision::Deny,
                }),
                Some("always_allow") => Ok(InteractiveResponsePayload::Approval {
                    decision: ApprovalDecision::AlwaysAllow,
                }),
                _ => Err("unsupported approval decision".to_string()),
            },
            "question" => Ok(InteractiveResponsePayload::Question {
                answers: response
                    .get("answers")
                    .and_then(Value::as_object)
                    .map(|answers| {
                        answers
                            .iter()
                            .map(|(question_id, value)| {
                                let answer_values = value
                                    .as_array()
                                    .map(|items| {
                                        items
                                            .iter()
                                            .filter_map(Value::as_str)
                                            .map(str::to_string)
                                            .collect::<Vec<_>>()
                                    })
                                    .or_else(|| {
                                        value.get("answers").and_then(Value::as_array).map(
                                            |items| {
                                                items
                                                    .iter()
                                                    .filter_map(Value::as_str)
                                                    .map(str::to_string)
                                                    .collect::<Vec<_>>()
                                            },
                                        )
                                    })
                                    .unwrap_or_default();
                                (question_id.clone(), answer_values)
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            }),
            _ => Err("unsupported interactive response kind".to_string()),
        };
    }

    match extract_string(params, &["decision"]).as_deref() {
        Some("allow") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::Allow,
        }),
        Some("deny") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::Deny,
        }),
        Some("always_allow") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::AlwaysAllow,
        }),
        _ => Err("interactive response payload is missing a supported response".to_string()),
    }
}

pub(super) fn truncate_preview(input: &str, limit: usize) -> String {
    let trimmed = input.trim();
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

pub(crate) fn should_surface_tool_item(kind: &str) -> bool {
    !matches!(
        kind,
        "userMessage"
            | "user_message"
            | "agentMessage"
            | "agent_message"
            | "reasoning"
            | "reasoningSummary"
            | "reasoning_summary"
            | "plan"
            | "hookPrompt"
            | "hook_prompt"
    )
}

pub(super) fn is_known_tool_item(kind: &str) -> bool {
    matches!(
        kind,
        "commandExecution"
            | "command_execution"
            | "mcpToolCall"
            | "mcp_tool_call"
            | "dynamicToolCall"
            | "dynamic_tool_call"
            | "collabAgentToolCall"
            | "collab_agent_tool_call"
            | "subAgentActivity"
            | "sub_agent_activity"
            | "sleep"
    )
}

fn bounded_artifact_string(value: &Value, keys: &[&str], max_chars: usize) -> Option<String> {
    let value = extract_string(value, keys)?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(max_chars).collect())
}

fn provider_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        let text = text.trim();
        return (!text.is_empty()).then(|| text.to_string());
    }
    let joined = value
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.is_empty()).then_some(joined)
}

pub(crate) fn codex_reasoning_conversation_item(
    item: &Value,
    created_at: DateTime<Utc>,
    fallback_lifecycle: ContentLifecycle,
    completed_at: Option<DateTime<Utc>>,
) -> Option<ConversationItem> {
    const MAX_REASONING_DURATION_MS: u64 = 365 * 24 * 60 * 60 * 1_000;

    let output_kind = extract_string(item, &["type", "kind"])?;
    if !matches!(
        output_kind.as_str(),
        "reasoning" | "reasoningSummary" | "reasoning_summary"
    ) {
        return None;
    }
    let duration_ms = item
        .get("durationMs")
        .or_else(|| item.get("duration_ms"))
        .and_then(Value::as_u64)
        .filter(|duration| *duration <= MAX_REASONING_DURATION_MS)
        .or_else(|| {
            let completed_at = completed_at.or_else(|| {
                extract_datetime_or_timestamp(item, &["completedAt", "completed_at"])
            })?;
            u64::try_from((completed_at - created_at).num_milliseconds())
                .ok()
                .filter(|duration| *duration <= MAX_REASONING_DURATION_MS)
        });

    Some(ConversationItem::Reasoning {
        id: extract_string(item, &["id", "itemId", "item_id"])?,
        summary: provider_text(item.get("summary")),
        content: provider_text(item.get("content")).unwrap_or_default(),
        lifecycle: content_lifecycle_for_status(
            extract_string(item, &["status"]).as_deref(),
            fallback_lifecycle,
        ),
        duration_ms,
        created_at,
    })
}

pub(crate) fn codex_artifact_conversation_item(
    item: &Value,
    created_at: DateTime<Utc>,
    fallback_lifecycle: ContentLifecycle,
) -> Option<ConversationItem> {
    const MAX_ARTIFACT_ITEM_BYTES: usize = 64 * 1024;

    let output_kind = extract_string(item, &["type", "kind"])?;
    if !matches!(
        output_kind.as_str(),
        "artifactPreview" | "artifact_preview" | "artifact"
    ) {
        return None;
    }
    let id = extract_string(item, &["id", "itemId", "item_id"])?;
    let artifact = item.get("artifact").unwrap_or(item);
    let encoded = serde_json::to_vec(artifact).ok();
    let payload_within_limit = encoded
        .as_ref()
        .is_some_and(|encoded| encoded.len() <= MAX_ARTIFACT_ITEM_BYTES);
    let payload = if payload_within_limit {
        artifact.clone()
    } else {
        serde_json::json!({
            "title": bounded_artifact_string(artifact, &["title", "name", "label"], 240),
            "truncated": true,
            "message": "Provider artifact exceeded the 64 KiB display limit"
        })
    };
    let title = bounded_artifact_string(artifact, &["title", "name", "label"], 240)
        .unwrap_or_else(|| "Artifact".to_string());
    let artifact_kind = bounded_artifact_string(
        artifact,
        &["artifactType", "artifact_type", "type", "kind"],
        80,
    )
    .unwrap_or_else(|| "artifact".to_string());
    let content = payload_within_limit
        .then(|| bounded_artifact_string(artifact, &["content", "text", "preview"], 60_000))
        .flatten();

    Some(ConversationItem::Artifact {
        id,
        artifact: ConversationArtifact {
            title,
            artifact_kind,
            url: bounded_artifact_string(artifact, &["url", "uri", "href"], 4_096),
            mime_type: bounded_artifact_string(
                artifact,
                &["mimeType", "mime_type", "mediaType", "media_type"],
                160,
            ),
            version: bounded_artifact_string(
                artifact,
                &["version", "versionId", "version_id"],
                160,
            ),
            content,
            payload,
        },
        lifecycle: content_lifecycle_for_status(
            extract_string(item, &["status"]).as_deref(),
            fallback_lifecycle,
        ),
        created_at,
    })
}

pub(crate) fn unsupported_conversation_item(
    item: &Value,
    created_at: DateTime<Utc>,
    fallback_lifecycle: ContentLifecycle,
) -> Option<ConversationItem> {
    const MAX_UNSUPPORTED_ITEM_BYTES: usize = 64 * 1024;

    let id = extract_string(item, &["id", "itemId", "item_id"])?;
    let output_kind = extract_string(item, &["type", "kind"])?;
    let lifecycle = content_lifecycle_for_status(
        extract_string(item, &["status"]).as_deref(),
        fallback_lifecycle,
    );
    let payload = serde_json::to_vec(item)
        .ok()
        .filter(|encoded| encoded.len() <= MAX_UNSUPPORTED_ITEM_BYTES)
        .map(|_| item.clone())
        .unwrap_or_else(|| {
            serde_json::json!({
                "id": id,
                "type": output_kind,
                "truncated": true,
                "message": "Provider item exceeded the 64 KiB display limit"
            })
        });

    Some(ConversationItem::Unsupported {
        id,
        output_kind,
        reason: "Provider output is not supported by this FalconDeck version".to_string(),
        payload,
        lifecycle,
        created_at,
    })
}

pub(crate) fn codex_review_mode_conversation_item(
    item: &Value,
    created_at: DateTime<Utc>,
    fallback_lifecycle: ContentLifecycle,
) -> Option<ConversationItem> {
    let id = extract_string(item, &["id"])?;
    let kind = extract_string(item, &["type", "kind"])?;
    let review = extract_string(item, &["review"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let lifecycle = content_lifecycle_for_status(
        extract_string(item, &["status"]).as_deref(),
        fallback_lifecycle,
    );
    let (subject, content) = match kind.as_str() {
        "enteredReviewMode" | "entered_review_mode" => (review, String::new()),
        "exitedReviewMode" | "exited_review_mode" => (None, review.unwrap_or_default()),
        _ => return None,
    };

    Some(ConversationItem::CodeReview {
        id,
        subject,
        content,
        lifecycle,
        created_at,
    })
}

/// Retains the entry subject and first-observed timestamp when the provider
/// replaces a running review-mode item with its final review body.
pub(crate) fn merge_code_review_item(existing: &ConversationItem, next: &mut ConversationItem) {
    let (
        ConversationItem::CodeReview {
            id: existing_id,
            subject: existing_subject,
            content: existing_content,
            created_at: existing_created_at,
            ..
        },
        ConversationItem::CodeReview {
            id: next_id,
            subject: next_subject,
            content: next_content,
            created_at: next_created_at,
            ..
        },
    ) = (existing, next)
    else {
        return;
    };
    if existing_id != next_id {
        return;
    }
    if next_subject.is_none() {
        *next_subject = existing_subject.clone();
    }
    if next_content.is_empty() {
        next_content.clone_from(existing_content);
    }
    *next_created_at = *existing_created_at;
}

pub(crate) fn tool_display_metadata(
    title: &str,
    kind: &str,
    status: &str,
    exit_code: Option<i32>,
    output: Option<&str>,
) -> ToolCallDisplay {
    let normalized_title = title.to_ascii_lowercase();
    let normalized_kind = kind.to_ascii_lowercase();
    let normalized_output = output.unwrap_or_default().to_ascii_lowercase();
    let errored = matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "failed" | "failure" | "error" | "errored" | "denied" | "rejected" | "declined"
    ) || exit_code.unwrap_or_default() != 0;
    let activity_kind = classify_tool_activity_kind(
        &normalized_title,
        &normalized_kind,
        &normalized_output,
        errored,
    );

    let is_read_only = matches!(
        activity_kind,
        ToolActivityKind::Read
            | ToolActivityKind::Search
            | ToolActivityKind::List
            | ToolActivityKind::WebSearch
            | ToolActivityKind::ImageView
            | ToolActivityKind::Context
    ) || normalized_title.starts_with("git status")
        || normalized_title.starts_with("pwd")
        || normalized_title.starts_with("ls ")
        || normalized_title.starts_with("find ")
        || normalized_title.starts_with("rg ");

    let artifact_kind = if matches!(activity_kind, ToolActivityKind::Diff) {
        ToolArtifactKind::Diff
    } else if matches!(activity_kind, ToolActivityKind::Test) {
        ToolArtifactKind::Test
    } else if matches!(activity_kind, ToolActivityKind::Approval) {
        ToolArtifactKind::ApprovalRelated
    } else if output
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        ToolArtifactKind::CommandOutput
    } else {
        ToolArtifactKind::None
    };

    let is_error = errored;
    let has_side_effect = !is_read_only
        || normalized_kind.contains("write")
        || normalized_kind.contains("edit")
        || normalized_kind.contains("patch")
        || normalized_title.contains("apply_patch")
        || normalized_title.contains("npm install")
        || normalized_title.contains("cargo add")
        || normalized_title.contains("curl ")
        || normalized_title.contains("wget ")
        || is_error;
    let history_mode = if is_error
        || has_side_effect
        || !matches!(
            activity_kind,
            ToolActivityKind::Read
                | ToolActivityKind::Search
                | ToolActivityKind::List
                | ToolActivityKind::Command
                | ToolActivityKind::WebSearch
                | ToolActivityKind::ImageView
                | ToolActivityKind::Context
        ) {
        ToolHistoryMode::Full
    } else {
        ToolHistoryMode::Summary
    };
    let summary_hint = summarize_tool_title(title, activity_kind.clone());
    let lifecycle = tool_lifecycle(status, exit_code, activity_kind.clone());
    let test_summary = if matches!(activity_kind, ToolActivityKind::Test) {
        summarize_test_run(title, output)
    } else {
        None
    };

    ToolCallDisplay {
        is_read_only,
        has_side_effect,
        is_error,
        lifecycle,
        artifact_kind,
        activity_kind,
        history_mode,
        summary_hint,
        test_summary,
        provider_output_summary: None,
    }
}

static ANSI_ESCAPE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("valid ANSI escape regex"));
static TEST_COUNT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)([0-9][0-9,]*)\s+(passed|failed|skipped|ignored|pending|todo|cancelled|canceled)\b",
    )
    .expect("valid test count regex")
});
static TESTS_STATUS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([0-9][0-9,]*)\s+tests?\s+(passed|failed|skipped)\b")
        .expect("valid tests status regex")
});
static XCTEST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)executed\s+([0-9,]+)\s+tests?,\s+with\s+([0-9,]+)\s+failures?")
        .expect("valid XCTest summary regex")
});
static TAP_COUNT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^#\s*(tests|pass|fail|skipped|todo)\s+([0-9,]+)\s*$")
        .expect("valid TAP summary regex")
});
static DURATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([0-9]+(?:\.[0-9]+)?)\s*(ms|s|sec|secs|second|seconds)\b")
        .expect("valid test duration regex")
});

#[derive(Default)]
struct ParsedCounts {
    passed: Option<u64>,
    failed: Option<u64>,
    skipped: Option<u64>,
}

fn summarize_test_run(title: &str, output: Option<&str>) -> Option<ToolTestSummary> {
    let raw_output = output.unwrap_or_default();
    let clean_output = ANSI_ESCAPE_RE.replace_all(raw_output, "");
    let normalized = format!("{}\n{}", title, clean_output).to_ascii_lowercase();
    let framework = if normalized.contains("vitest") || normalized.contains("test files") {
        Some("vitest")
    } else if normalized.contains("jest") || normalized.contains("test suites:") {
        Some("jest")
    } else if normalized.contains("pytest") || normalized.contains(" passed in ") {
        Some("pytest")
    } else if normalized.contains("nextest") {
        Some("nextest")
    } else if normalized.contains("cargo test") || normalized.contains("test result:") {
        Some("cargo")
    } else if normalized.contains("go test") {
        Some("go")
    } else if normalized.contains("xctest")
        || normalized.contains("xcodebuild test")
        || normalized.contains("swift test")
        || normalized.contains("executed ") && normalized.contains(" tests, with ")
    {
        Some("xctest")
    } else if normalized.contains("node --test") || normalized.contains("\n# tests ") {
        Some("node")
    } else {
        None
    };

    let mut tests = ParsedCounts::default();
    let mut suites = ParsedCounts::default();
    let mut explicit_total = None;
    let mut explicit_suites_total = None;
    let mut duration_ms = None;

    for raw_line in clean_output.lines() {
        let line = raw_line.trim();
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("test files") || lower.starts_with("test suites:") {
            suites = counts_from_line(line);
            explicit_suites_total = total_from_line(line);
        } else if lower.contains("test result:") {
            let mut line_counts = counts_from_line(line);
            normalize_counts(&mut line_counts);
            explicit_total = add_optional(explicit_total, count_total(&line_counts));
            add_counts(&mut tests, &line_counts);
        } else if lower.starts_with("tests")
            || lower.contains("tests run:")
            || ((lower.contains("passed") || lower.contains("failed"))
                && (lower.contains(" in ") || lower.starts_with('=')))
        {
            tests = counts_from_line(line);
            explicit_total = total_from_line(line);
        }

        if let Some(captures) = XCTEST_RE.captures(line) {
            let total = parse_count(captures.get(1).map(|value| value.as_str()));
            let failed = parse_count(captures.get(2).map(|value| value.as_str()));
            if let (Some(total), Some(failed)) = (total, failed) {
                let line_counts = ParsedCounts {
                    passed: Some(total.saturating_sub(failed)),
                    failed: Some(failed),
                    skipped: Some(0),
                };
                add_counts(&mut tests, &line_counts);
                explicit_total = add_optional(explicit_total, Some(total));
            }
        }

        if let Some(captures) = TAP_COUNT_RE.captures(line) {
            let value = parse_count(captures.get(2).map(|entry| entry.as_str()));
            match captures
                .get(1)
                .map(|entry| entry.as_str().to_ascii_lowercase())
                .as_deref()
            {
                Some("tests") => explicit_total = value,
                Some("pass") => tests.passed = value,
                Some("fail") => tests.failed = value,
                Some("skipped" | "todo") => tests.skipped = value,
                _ => {}
            }
        }

        let duration_line = lower.starts_with("duration")
            || lower.starts_with("time:")
            || lower.contains("finished in")
            || lower.contains(" tests, with ")
            || ((lower.contains("passed") || lower.contains("failed")) && lower.contains(" in "));
        if duration_line && let Some(captures) = DURATION_RE.captures(line) {
            let parsed_duration = duration_to_ms(
                captures.get(1).map(|value| value.as_str()),
                captures.get(2).map(|value| value.as_str()),
            );
            duration_ms = if lower.contains("test result:") || XCTEST_RE.is_match(line) {
                add_optional(duration_ms, parsed_duration)
            } else {
                parsed_duration
            };
        }
    }

    normalize_counts(&mut tests);
    normalize_counts(&mut suites);
    let total = explicit_total.or_else(|| count_total(&tests));
    let suites_total = explicit_suites_total.or_else(|| count_total(&suites));
    let summary = ToolTestSummary {
        framework: framework.map(str::to_string),
        total,
        passed: tests.passed,
        failed: tests.failed,
        skipped: tests.skipped,
        suites_total,
        suites_passed: suites.passed,
        suites_failed: suites.failed,
        duration_ms,
    };
    (summary.framework.is_some()
        || summary.total.is_some()
        || summary.suites_total.is_some()
        || summary.duration_ms.is_some())
    .then_some(summary)
}

fn counts_from_line(line: &str) -> ParsedCounts {
    let mut counts = ParsedCounts::default();
    for captures in TEST_COUNT_RE
        .captures_iter(line)
        .chain(TESTS_STATUS_RE.captures_iter(line))
    {
        let value = parse_count(captures.get(1).map(|entry| entry.as_str()));
        match captures
            .get(2)
            .map(|entry| entry.as_str().to_ascii_lowercase())
            .as_deref()
        {
            Some("passed") => counts.passed = value,
            Some("failed") => counts.failed = value,
            Some("skipped" | "ignored" | "pending" | "todo" | "cancelled" | "canceled") => {
                counts.skipped = value
            }
            _ => {}
        }
    }
    counts
}

fn normalize_counts(counts: &mut ParsedCounts) {
    if counts.passed.is_some() || counts.failed.is_some() || counts.skipped.is_some() {
        counts.passed.get_or_insert(0);
        counts.failed.get_or_insert(0);
        counts.skipped.get_or_insert(0);
    }
}

fn add_counts(target: &mut ParsedCounts, incoming: &ParsedCounts) {
    target.passed = add_optional(target.passed, incoming.passed);
    target.failed = add_optional(target.failed, incoming.failed);
    target.skipped = add_optional(target.skipped, incoming.skipped);
}

fn add_optional(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.saturating_add(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn count_total(counts: &ParsedCounts) -> Option<u64> {
    (counts.passed.is_some() || counts.failed.is_some() || counts.skipped.is_some()).then(|| {
        counts.passed.unwrap_or(0) + counts.failed.unwrap_or(0) + counts.skipped.unwrap_or(0)
    })
}

fn total_from_line(line: &str) -> Option<u64> {
    let words =
        line.split(|character: char| character.is_whitespace() || matches!(character, ',' | ';'));
    let mut previous = None;
    for word in words {
        let normalized = word.trim_matches(|character: char| !character.is_ascii_alphanumeric());
        if normalized.eq_ignore_ascii_case("total") {
            return parse_count(previous);
        }
        previous = Some(normalized);
    }
    None
}

fn parse_count(value: Option<&str>) -> Option<u64> {
    value?.replace(',', "").parse().ok()
}

fn duration_to_ms(value: Option<&str>, unit: Option<&str>) -> Option<u64> {
    let value = value?.parse::<f64>().ok()?;
    let multiplier = if unit?.eq_ignore_ascii_case("ms") {
        1.0
    } else {
        1_000.0
    };
    Some((value * multiplier).round().max(0.0) as u64)
}

pub(crate) fn tool_lifecycle(
    status: &str,
    exit_code: Option<i32>,
    activity_kind: ToolActivityKind,
) -> falcondeck_core::ToolLifecycle {
    use falcondeck_core::ToolLifecycle;

    if exit_code.is_some_and(|code| code != 0) {
        return ToolLifecycle::Failed;
    }

    let normalized = status.trim().to_ascii_lowercase().replace(['-', ' '], "_");
    match normalized.as_str() {
        "queued" | "pending" | "created" => ToolLifecycle::Queued,
        "awaiting_confirmation" | "awaiting_approval" | "pending_approval" => {
            ToolLifecycle::AwaitingApproval
        }
        "running" | "in_progress" | "inprogress" | "streaming" => {
            if matches!(activity_kind, ToolActivityKind::Approval) {
                ToolLifecycle::AwaitingApproval
            } else {
                ToolLifecycle::Running
            }
        }
        "completed" | "complete" | "success" | "succeeded" | "done" => ToolLifecycle::Succeeded,
        "failed" | "failure" | "error" | "errored" | "blocked" => ToolLifecycle::Failed,
        "denied" | "rejected" | "declined" => ToolLifecycle::Denied,
        "interrupted" | "cancelled" | "canceled" | "aborted" | "stopped" => {
            ToolLifecycle::Interrupted
        }
        _ => ToolLifecycle::Unknown,
    }
}

fn classify_tool_activity_kind(
    normalized_title: &str,
    normalized_kind: &str,
    normalized_output: &str,
    errored: bool,
) -> ToolActivityKind {
    // Only the CLI's own "requested permissions" denial marks approval
    // traffic, and a denial always accompanies a failed call. Matching the
    // bare word "permission" in outputs or titles turned every `Read` of a
    // file mentioning permission_mode (and any `git log` whose history
    // discusses permissions) into an auto-expanded approval card, shattering
    // the transcript's work-session fold; a successful grep quoting the
    // denial phrase must not count either. Titles are free text (a Codex
    // shell title like `rg approval` merely mentions the word), so only the
    // provider-authoritative kind marks approval traffic — a Running tool
    // classified Approval renders as AwaitingApproval.
    if (errored && normalized_output.contains("requested permissions"))
        || normalized_kind.contains("approval")
    {
        ToolActivityKind::Approval
    } else if normalized_kind.contains("filechange")
        || normalized_kind.contains("file_change")
        || normalized_kind.contains("diff")
        || normalized_title.contains("apply_patch")
        || normalized_title.starts_with("git diff")
    {
        ToolActivityKind::Diff
    } else if title_is_test_invocation(normalized_title)
        || normalized_kind.contains("test")
        || normalized_output.contains("test failed")
        || normalized_output.contains("failing")
    {
        ToolActivityKind::Test
    } else if normalized_kind.contains("webfetch")
        || normalized_title.starts_with("web fetch")
        || normalized_kind.contains("websearch")
        || normalized_kind.contains("web_search")
        || normalized_title.starts_with("web search")
    {
        ToolActivityKind::WebSearch
    } else if normalized_kind.contains("toolsearch") || normalized_title.starts_with("search tools")
    {
        ToolActivityKind::Search
    } else if normalized_kind.contains("imageview")
        || normalized_kind.contains("image_view")
        || normalized_title.starts_with("image view")
    {
        ToolActivityKind::ImageView
    } else if normalized_kind.contains("contextcompact")
        || normalized_kind.contains("context_compaction")
        || normalized_kind.contains("compaction")
        || normalized_title.contains("context compaction")
    {
        ToolActivityKind::Context
    } else if let Some(shell_kind) = classify_shell_command(normalized_title) {
        // Shell-first agents (Codex) surface most work as raw commands;
        // parsing the command line is what lets `grep`/`cat`/`sed -i` group
        // and collapse as richly as native Read/Search/Edit tools do.
        shell_kind
    } else if normalized_kind.contains("edit")
        || normalized_kind.contains("write")
        || normalized_kind.contains("patch")
        || normalized_title.starts_with("edit ")
    {
        ToolActivityKind::Edit
    } else if normalized_kind.contains("skill") || normalized_title.starts_with("load skill") {
        ToolActivityKind::Context
    } else if normalized_kind.contains("read")
        || normalized_kind.contains("inspect")
        || normalized_title.starts_with("cat ")
        || normalized_title.starts_with("sed -n ")
        || normalized_title.starts_with("read ")
        || normalized_title.starts_with("read /")
    {
        ToolActivityKind::Read
    } else if normalized_kind.contains("glob") || normalized_title.starts_with("find ") {
        ToolActivityKind::List
    } else if normalized_kind.contains("grep")
        || normalized_kind.contains("search")
        || normalized_title.starts_with("read ")
        || normalized_title.starts_with("rg ")
    {
        ToolActivityKind::Search
    } else if normalized_kind.contains("list") || normalized_title.starts_with("ls ") {
        ToolActivityKind::List
    } else if normalized_kind.contains("command")
        || normalized_kind.contains("bash")
        || normalized_title.starts_with("bash:")
        || normalized_title.starts_with("python")
        || normalized_title.starts_with("python3")
        || normalized_title.starts_with("node ")
        || normalized_title.starts_with("/bin/")
        || normalized_title.starts_with("git ")
        || normalized_title.starts_with("pwd")
    {
        ToolActivityKind::Command
    } else {
        ToolActivityKind::Other
    }
}

/// Classifies a raw shell command line by what it does. Unwraps `bash -c`
/// style wrappers, walks pipeline/`&&`/`;` segments, and takes the
/// highest-impact classification across them (an edit anywhere makes the
/// whole line an edit). Returns `None` for lines that don't start with a
/// recognized command, so non-shell tool titles fall through untouched.
fn classify_shell_command(raw: &str) -> Option<ToolActivityKind> {
    let command_line = unwrap_shell_wrapper(raw.trim());
    let mut result: Option<ToolActivityKind> = None;
    for segment in split_shell_segments(&command_line) {
        let kind = classify_shell_segment(segment)?;
        result = Some(match (result, kind) {
            // Impact order: an edit taints the pipeline; a search outranks
            // plain reads/lists (`cat x | grep y` is a search).
            (Some(ToolActivityKind::Edit), _) | (_, ToolActivityKind::Edit) => {
                ToolActivityKind::Edit
            }
            (Some(ToolActivityKind::WebSearch), _) | (_, ToolActivityKind::WebSearch) => {
                ToolActivityKind::WebSearch
            }
            (Some(ToolActivityKind::Search), _) | (_, ToolActivityKind::Search) => {
                ToolActivityKind::Search
            }
            (Some(ToolActivityKind::Read), _) | (_, ToolActivityKind::Read) => {
                ToolActivityKind::Read
            }
            (_, kind) => kind,
        });
    }
    result
}

/// Strips `bash -lc "…"` / `sh -c '…'` wrappers down to the inner command.
fn unwrap_shell_wrapper(raw: &str) -> String {
    let mut tokens = raw.splitn(3, char::is_whitespace);
    let shell = tokens.next().unwrap_or_default();
    let flags = tokens.next().unwrap_or_default();
    if matches!(
        shell,
        "bash" | "sh" | "zsh" | "/bin/bash" | "/bin/sh" | "/bin/zsh"
    ) && flags.starts_with('-')
        && flags.contains('c')
        && let Some(inner) = tokens.next()
    {
        return inner
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .to_string();
    }
    raw.to_string()
}

/// Splits a command line at pipeline and sequencing operators. Quote-blind on
/// purpose: a false split only yields an unrecognized segment, which aborts
/// classification rather than misclassifying.
fn split_shell_segments(command_line: &str) -> impl Iterator<Item = &str> {
    command_line
        .split(['|', ';'])
        .flat_map(|part| part.split("&&"))
        .map(str::trim)
        .filter(|part| !part.is_empty() && !part.starts_with('&'))
}

fn classify_shell_segment(segment: &str) -> Option<ToolActivityKind> {
    // `FOO=bar cmd` and `sudo cmd` classify by the real command.
    let mut words = segment
        .split_whitespace()
        .skip_while(|word| word.contains('=') && !word.starts_with('-'));
    let mut program = words.next()?;
    if matches!(program, "sudo" | "command" | "xargs" | "time") {
        program = words.next()?;
    }
    let program = program.rsplit('/').next().unwrap_or(program);

    if has_file_write_redirect(segment) {
        return Some(ToolActivityKind::Edit);
    }
    Some(match program {
        "cat" | "head" | "tail" | "less" | "more" | "bat" | "wc" | "stat" | "file" | "readlink" => {
            ToolActivityKind::Read
        }
        "sed" => {
            if segment.contains(" -i") {
                ToolActivityKind::Edit
            } else {
                ToolActivityKind::Read
            }
        }
        "grep" | "rg" | "ag" | "ack" | "fgrep" | "egrep" | "awk" | "fd" | "which" | "whereis" => {
            ToolActivityKind::Search
        }
        "find" => ToolActivityKind::Search,
        "ls" | "tree" | "pwd" | "du" | "df" => ToolActivityKind::List,
        "curl" | "wget" => ToolActivityKind::WebSearch,
        "tee" | "chmod" | "chown" | "rm" | "mv" | "cp" | "mkdir" | "touch" | "ln" | "rmdir"
        | "install" | "patch" | "truncate" => ToolActivityKind::Edit,
        _ => return None,
    })
}

/// Whether a segment redirects stdout/stderr into a real file (`>`/`>>` to
/// anything but /dev/null or another descriptor).
fn has_file_write_redirect(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    for (index, _) in segment.match_indices('>') {
        // `2>&1`, `>&2` redirect between descriptors; `<` handled by skip.
        if index > 0 && bytes[index - 1] == b'<' {
            continue;
        }
        let rest = segment[index + 1..].trim_start_matches('>').trim_start();
        if rest.starts_with('&') {
            continue;
        }
        let target = rest.split_whitespace().next().unwrap_or_default();
        if target.is_empty() || target == "/dev/null" {
            continue;
        }
        return true;
    }
    false
}

/// Whether a tool title is a recognized test-runner invocation. A bare
/// `contains("test")` turned every `Read foo.test.ts` / `cat foo.test.ts`
/// into a loud Test card, so the runner must appear at command position in
/// one of the title's shell segments.
fn title_is_test_invocation(normalized_title: &str) -> bool {
    let command_line = unwrap_shell_wrapper(normalized_title.trim());
    split_shell_segments(&command_line).any(is_test_runner_segment)
}

fn is_test_runner_segment(segment: &str) -> bool {
    // Standalone runners: the program itself is the test framework.
    const TEST_RUNNERS: &[&str] = &["pytest", "vitest", "jest", "mocha", "rspec", "phpunit"];

    let mut words = segment
        .split_whitespace()
        .skip_while(|word| word.contains('=') && !word.starts_with('-'));
    let Some(program) = words.next() else {
        return false;
    };
    let program = program.rsplit('/').next().unwrap_or(program);
    if TEST_RUNNERS.contains(&program) {
        return true;
    }

    let subcommand = words.find(|word| !word.starts_with('-'));
    match program {
        // Package-runner wrappers launch the framework as their argument.
        "npx" | "bunx" => subcommand
            .is_some_and(|word| TEST_RUNNERS.contains(&word.rsplit('/').next().unwrap_or(word))),
        // Toolchains with a `test` subcommand (plus `npm run test` style).
        "cargo" | "go" | "npm" | "yarn" | "pnpm" | "bun" | "swift" | "dotnet" | "mix"
        | "xcodebuild" => match subcommand {
            Some("test") => true,
            Some("run") => words.next() == Some("test"),
            _ => false,
        },
        "node" => segment.split_whitespace().any(|word| word == "--test"),
        _ => false,
    }
}

fn summarize_tool_title(title: &str, activity_kind: ToolActivityKind) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(path) = trimmed.strip_prefix("cat ") {
        return Some(format!("Read {}", path.trim()));
    }
    if let Some(path) = trimmed.strip_prefix("sed -n ") {
        return Some(format!("Inspect {}", path.trim()));
    }
    if trimmed.starts_with("rg ") {
        return Some("Search workspace".to_string());
    }
    if trimmed.starts_with("search tools") {
        return Some("Search tools".to_string());
    }
    if trimmed.starts_with("ls ") {
        return Some("List files".to_string());
    }
    if trimmed.starts_with("find ") {
        return Some("List files".to_string());
    }
    if trimmed.starts_with("git status") {
        return Some("Check git status".to_string());
    }
    if trimmed.starts_with("pwd") {
        return Some("Show working directory".to_string());
    }

    match activity_kind {
        ToolActivityKind::Read => Some("Read file".to_string()),
        ToolActivityKind::Search => Some("Search workspace".to_string()),
        ToolActivityKind::List => Some("List files".to_string()),
        ToolActivityKind::WebSearch => Some("Search web".to_string()),
        ToolActivityKind::ImageView => Some("View image".to_string()),
        ToolActivityKind::Context => Some("Compact context".to_string()),
        ToolActivityKind::Diff => Some("Update files".to_string()),
        ToolActivityKind::Edit => Some("Edit files".to_string()),
        ToolActivityKind::Test => Some("Run tests".to_string()),
        ToolActivityKind::Approval => Some("Request approval".to_string()),
        ToolActivityKind::Command | ToolActivityKind::Other => None,
    }
}

#[cfg(test)]
mod attachment_preview_tests {
    use super::*;
    use falcondeck_core::{ConversationImage, ImageInput};

    #[tokio::test]
    async fn rehydrates_local_images_without_changing_the_stored_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let image_path = temp_dir.path().join("preview.png");
        std::fs::write(&image_path, b"png-bytes").unwrap();
        let local_path = image_path.to_string_lossy().to_string();
        let item = ConversationItem::UserMessage {
            id: "message-1".to_string(),
            text: "See screenshot".to_string(),
            attachments: vec![ImageInput {
                id: "image-1".to_string(),
                name: Some("preview.png".to_string()),
                mime_type: Some("image/png".to_string()),
                url: local_path.clone(),
                local_path: Some(local_path.clone()),
            }],
            turn_id: None,
            previous_turn_id: None,
            created_at: Utc::now(),
        };

        let rendered = with_renderable_attachment_previews(item).await;
        let ConversationItem::UserMessage { attachments, .. } = rendered else {
            panic!("expected user message");
        };

        assert_eq!(
            attachments[0].local_path.as_deref(),
            Some(local_path.as_str())
        );
        assert_eq!(attachments[0].url, "data:image/png;base64,cG5nLWJ5dGVz");
    }

    #[tokio::test]
    async fn leaves_remote_image_urls_unchanged() {
        let url = "https://example.com/preview.png";
        let item = ConversationItem::UserMessage {
            id: "message-1".to_string(),
            text: String::new(),
            attachments: vec![ImageInput {
                id: "image-1".to_string(),
                name: None,
                mime_type: Some("image/png".to_string()),
                url: url.to_string(),
                local_path: Some("/path/that/should/not/be/read.png".to_string()),
            }],
            turn_id: None,
            previous_turn_id: None,
            created_at: Utc::now(),
        };

        let rendered = with_renderable_attachment_previews(item).await;
        let ConversationItem::UserMessage { attachments, .. } = rendered else {
            panic!("expected user message");
        };

        assert_eq!(attachments[0].url, url);
    }

    #[tokio::test]
    async fn rehydrates_agent_image_outputs_for_remote_clients() {
        let temp_dir = tempfile::tempdir().unwrap();
        let image_path = temp_dir.path().join("generated.png");
        std::fs::write(&image_path, b"generated-bytes").unwrap();
        let local_path = image_path.to_string_lossy().to_string();
        let item = ConversationItem::Image {
            id: "generated-1".to_string(),
            title: Some("Generated image".to_string()),
            image: ConversationImage {
                id: "generated-1-image".to_string(),
                name: Some("generated.png".to_string()),
                mime_type: Some("image/png".to_string()),
                url: local_path.clone(),
                local_path: Some(local_path.clone()),
                alt_text: Some("A generated falcon".to_string()),
            },
            lifecycle: ContentLifecycle::Complete,
            created_at: Utc::now(),
        };

        let rendered = with_renderable_attachment_previews(item).await;
        let ConversationItem::Image { image, .. } = rendered else {
            panic!("expected image output");
        };
        assert_eq!(image.local_path.as_deref(), Some(local_path.as_str()));
        assert_eq!(image.url, "data:image/png;base64,Z2VuZXJhdGVkLWJ5dGVz");
    }

    #[test]
    fn maps_codex_image_generation_without_flattening_the_result() {
        let item = codex_image_conversation_item(
            &serde_json::json!({
                "id": "generation-1",
                "type": "imageGeneration",
                "status": "completed",
                "result": "aGVsbG8=",
                "revisedPrompt": "A falcon over a dark control deck"
            }),
            Utc::now(),
            ContentLifecycle::Streaming,
        )
        .expect("image generation item");

        let ConversationItem::Image {
            image, lifecycle, ..
        } = item
        else {
            panic!("expected image output");
        };
        assert_eq!(lifecycle, ContentLifecycle::Complete);
        assert_eq!(image.url, "data:image/png;base64,aGVsbG8=");
        assert_eq!(
            image.alt_text.as_deref(),
            Some("A falcon over a dark control deck")
        );
    }

    #[test]
    fn maps_codex_find_in_page_without_flattening_the_action() {
        let item = codex_web_search_conversation_item(
            &serde_json::json!({
                "id": "search-1",
                "type": "webSearch",
                "query": "React streaming chat",
                "action": {
                    "type": "findInPage",
                    "url": "https://example.com/chat",
                    "pattern": "streaming"
                }
            }),
            Utc::now(),
            ContentLifecycle::Streaming,
        )
        .expect("web search item");

        let ConversationItem::WebSearch {
            search, lifecycle, ..
        } = item
        else {
            panic!("expected web search output");
        };
        assert_eq!(lifecycle, ContentLifecycle::Streaming);
        assert_eq!(search.action_kind.as_str(), "find_in_page");
        assert_eq!(search.url.as_deref(), Some("https://example.com/chat"));
        assert_eq!(search.pattern.as_deref(), Some("streaming"));
        assert_eq!(search.queries, vec!["React streaming chat"]);
    }

    #[test]
    fn maps_codex_batched_search_queries() {
        let item = codex_web_search_conversation_item(
            &serde_json::json!({
                "id": "search-2",
                "type": "webSearch",
                "query": "AI chat UI",
                "action": {
                    "type": "search",
                    "query": "AI chat UI React",
                    "queries": ["streaming UX", "message parts"]
                }
            }),
            Utc::now(),
            ContentLifecycle::Complete,
        )
        .expect("web search item");

        let ConversationItem::WebSearch { search, .. } = item else {
            panic!("expected web search output");
        };
        assert_eq!(search.action_kind.as_str(), "search");
        assert_eq!(
            search.queries,
            vec!["AI chat UI React", "streaming UX", "message parts"]
        );
    }

    #[test]
    fn maps_codex_future_web_action_without_collapsing_it() {
        let item = codex_web_search_conversation_item(
            &serde_json::json!({
                "id": "search-future",
                "type": "webSearch",
                "action": { "type": "capturePage" }
            }),
            Utc::now(),
            ContentLifecycle::Streaming,
        )
        .expect("web search item");

        let ConversationItem::WebSearch { search, .. } = item else {
            panic!("expected web search output");
        };
        assert_eq!(search.action_kind.as_str(), "capturePage");
    }

    #[test]
    fn maps_codex_file_changes_without_losing_rename_or_diff_metadata() {
        let completed_at = Utc::now();
        let item = codex_file_change_conversation_item(
            &serde_json::json!({
                "id": "patch-1",
                "type": "fileChange",
                "status": "completed",
                "changes": [{
                    "path": "src/old.rs",
                    "kind": { "type": "update", "move_path": "src/new.rs" },
                    "diff": "@@ -1 +1 @@\n-old\n+new"
                }]
            }),
            completed_at,
            "inProgress",
            Some(completed_at),
        )
        .expect("file change item");

        let ConversationItem::FileChange {
            changes,
            lifecycle,
            completed_at: actual_completed_at,
            ..
        } = item
        else {
            panic!("expected file change");
        };
        assert_eq!(lifecycle, falcondeck_core::ToolLifecycle::Succeeded);
        assert_eq!(actual_completed_at, Some(completed_at));
        assert_eq!(changes[0].path, "src/old.rs");
        assert_eq!(changes[0].change_kind, "update");
        assert_eq!(changes[0].move_path.as_deref(), Some("src/new.rs"));
        assert!(changes[0].diff.contains("+new"));
    }

    #[test]
    fn maps_codex_command_execution_metadata() {
        let detail = codex_tool_call_detail(&serde_json::json!({
            "id": "command-1",
            "type": "commandExecution",
            "command": "rg streaming src",
            "cwd": "/workspace",
            "commandActions": [{
                "type": "search",
                "command": "rg streaming src",
                "path": "src",
                "query": "streaming"
            }],
            "processId": "4242",
            "durationMs": 37,
            "source": "agent"
        }))
        .expect("command detail");

        let ToolCallDetail::CommandExecution {
            command,
            cwd,
            actions,
            process_id,
            duration_ms,
            source,
        } = detail
        else {
            panic!("expected command execution detail");
        };
        assert_eq!(command, "rg streaming src");
        assert_eq!(cwd, "/workspace");
        assert_eq!(actions[0].action_kind, "search");
        assert_eq!(actions[0].path.as_deref(), Some("src"));
        assert_eq!(actions[0].query.as_deref(), Some("streaming"));
        assert_eq!(process_id.as_deref(), Some("4242"));
        assert_eq!(duration_ms, Some(37));
        assert_eq!(source.as_deref(), Some("agent"));
    }

    #[test]
    fn maps_codex_mcp_and_dynamic_tool_evidence() {
        let mcp = serde_json::json!({
            "id": "mcp-1",
            "type": "mcpToolCall",
            "server": "notion",
            "tool": "search",
            "arguments": {"query": "streaming"},
            "result": {"content": [{"type": "text", "text": "Found 3 pages"}]},
            "status": "completed",
            "durationMs": 42,
            "appContext": {"connectorId": "notion", "appName": "Notion", "actionName": "Search"}
        });
        assert_eq!(
            codex_tool_call_title(&mcp).as_deref(),
            Some("Notion · Search")
        );
        assert_eq!(
            codex_tool_call_output(&mcp).as_deref(),
            Some("Found 3 pages")
        );
        assert!(matches!(
            codex_tool_call_detail(&mcp),
            Some(ToolCallDetail::Mcp { duration_ms: Some(42), app_context: Some(context), .. })
                if context.connector_id == "notion"
        ));

        let dynamic = serde_json::json!({
            "id": "dynamic-1",
            "type": "dynamicToolCall",
            "namespace": "design",
            "tool": "render",
            "arguments": {"prompt": "radar"},
            "contentItems": [
                {"type": "inputText", "text": "Rendered"},
                {"type": "inputImage", "imageUrl": "data:image/png;base64,aGVsbG8="}
            ],
            "success": true,
            "status": "completed",
            "durationMs": 84
        });
        assert_eq!(
            codex_tool_call_title(&dynamic).as_deref(),
            Some("design · render")
        );
        assert_eq!(
            codex_tool_call_output(&dynamic).as_deref(),
            Some("Rendered")
        );
        assert!(matches!(
            codex_tool_call_detail(&dynamic),
            Some(ToolCallDetail::Dynamic { content_items, success: Some(true), .. })
                if content_items.len() == 2
        ));
    }

    #[test]
    fn maps_codex_collaboration_and_subagent_activity() {
        let collab = serde_json::json!({
            "id": "collab-1",
            "type": "collabAgentToolCall",
            "tool": "spawnAgent",
            "status": "completed",
            "senderThreadId": "thread-parent",
            "receiverThreadIds": ["thread-child"],
            "prompt": "Audit accessibility",
            "model": "gpt-5.6-terra",
            "reasoningEffort": "high",
            "agentsStates": {
                "thread-child": {"status": "running", "message": "Inspecting iOS"}
            }
        });
        assert_eq!(
            codex_tool_call_title(&collab).as_deref(),
            Some("Spawn sub-agent")
        );
        assert!(matches!(
            codex_tool_call_detail(&collab),
            Some(ToolCallDetail::CollabAgent {
                tool,
                receiver_thread_ids,
                agent_states,
                ..
            }) if tool == "spawnAgent"
                && receiver_thread_ids == vec!["thread-child"]
                && agent_states["thread-child"].status == "running"
        ));

        let activity = serde_json::json!({
            "id": "activity-1",
            "type": "subAgentActivity",
            "kind": "interacted",
            "agentThreadId": "thread-child",
            "agentPath": "qa/mobile"
        });
        assert_eq!(
            codex_tool_call_title(&activity).as_deref(),
            Some("Sub-agent interacted")
        );
        assert!(matches!(
            codex_tool_call_detail(&activity),
            Some(ToolCallDetail::SubagentActivity { agent_thread_id, agent_path, .. })
                if agent_thread_id == "thread-child" && agent_path == "qa/mobile"
        ));
    }

    #[test]
    fn maps_codex_hook_run_with_typed_entries() {
        let now = Utc::now();
        let item = codex_hook_run_conversation_item(
            &serde_json::json!({
                "id": "hook-1",
                "eventName": "preToolUse",
                "handlerType": "command",
                "executionMode": "sync",
                "scope": "turn",
                "sourcePath": "/workspace/.codex/hooks/check.sh",
                "status": "completed",
                "statusMessage": "Completed with a warning",
                "durationMs": 18,
                "entries": [{"kind": "warning", "text": "Review migrations"}]
            }),
            now,
            Some(now),
        )
        .expect("hook item");
        assert!(matches!(
            item,
            ConversationItem::ToolCall {
                title,
                detail,
                ..
            } if title == "Hook · pre tool use"
                && matches!(detail.as_deref(), Some(ToolCallDetail::Hook {
                    entries,
                    duration_ms: Some(18),
                    ..
                }) if entries[0].entry_kind == "warning"
                    && entries[0].text == "Review migrations")
        ));
    }

    #[test]
    fn maps_codex_assistant_phase_and_memory_citations() {
        let item = codex_assistant_conversation_item(
            &serde_json::json!({
                "id": "assistant-1",
                "type": "agentMessage",
                "text": "The replay invariant is documented.",
                "phase": "commentary",
                "memoryCitation": {
                    "entries": [{
                        "path": "docs/PLATFORM.md",
                        "lineStart": 170,
                        "lineEnd": 178,
                        "note": "Defines replay ordering."
                    }],
                    "threadIds": ["thread-earlier"]
                }
            }),
            Utc::now(),
            ContentLifecycle::Complete,
        )
        .expect("assistant item");

        let ConversationItem::AssistantMessage {
            phase,
            memory_citation,
            ..
        } = item
        else {
            panic!("expected assistant message");
        };
        assert_eq!(phase, Some(AssistantMessagePhase::Commentary));
        let citation = memory_citation.expect("memory citation");
        assert_eq!(citation.thread_ids, vec!["thread-earlier"]);
        assert_eq!(citation.entries[0].path, "docs/PLATFORM.md");
        assert_eq!(citation.entries[0].line_start, 170);
        assert_eq!(citation.entries[0].line_end, 178);
        assert_eq!(citation.entries[0].note, "Defines replay ordering.");
    }
}

#[cfg(test)]
mod tool_settlement_tests {
    use super::*;

    fn tool_item(status: &str) -> ConversationItem {
        ConversationItem::ToolCall {
            id: "tool-1".to_string(),
            title: "git add .".to_string(),
            tool_kind: "commandExecution".to_string(),
            status: status.to_string(),
            output: Some("done".to_string()),
            exit_code: Some(0),
            display: Box::new(tool_display_metadata(
                "git add .",
                "commandExecution",
                status,
                Some(0),
                Some("done"),
            )),
            detail: None,
            created_at: Utc::now(),
            completed_at: None,
        }
    }

    fn file_change_item(status: &str) -> ConversationItem {
        ConversationItem::FileChange {
            id: "patch-1".to_string(),
            changes: vec![ConversationFileChange {
                path: "src/lib.rs".to_string(),
                change_kind: "update".to_string(),
                diff: "@@ -1 +1 @@\n-old\n+new".to_string(),
                move_path: None,
            }],
            status: status.to_string(),
            lifecycle: falcondeck_core::ToolLifecycle::Running,
            created_at: Utc::now(),
            completed_at: None,
        }
    }

    #[test]
    fn settles_transient_tool_status_when_turn_is_over() {
        for transient_status in ["created", "running"] {
            let settled_at = Utc::now();
            let mut items = vec![tool_item(transient_status)];

            let updated = settle_tool_call_items(&mut items, settled_at, ToolSettlement::Completed);

            let ConversationItem::ToolCall {
                status,
                completed_at,
                ..
            } = &items[0]
            else {
                panic!("expected tool call");
            };
            assert_eq!(
                (status.as_str(), *completed_at, updated.len()),
                ("completed", Some(settled_at), 1),
                "transient status {transient_status} was left open"
            );
        }
    }

    #[test]
    fn preserves_failed_and_interrupted_turn_outcomes_for_transient_tools() {
        let cases = [
            (
                ToolSettlement::Failed,
                "failed",
                falcondeck_core::ToolLifecycle::Failed,
            ),
            (
                ToolSettlement::Interrupted,
                "interrupted",
                falcondeck_core::ToolLifecycle::Interrupted,
            ),
        ];

        for (settlement, expected_status, expected_lifecycle) in cases {
            let settled_at = Utc::now();
            let mut items = vec![tool_item("awaiting_approval")];
            let updated = settle_tool_call_items(&mut items, settled_at, settlement);

            let ConversationItem::ToolCall {
                status,
                completed_at,
                display,
                ..
            } = &items[0]
            else {
                panic!("expected tool call");
            };
            assert_eq!(status, expected_status);
            assert_eq!(*completed_at, Some(settled_at));
            assert_eq!(display.lifecycle, expected_lifecycle);
            assert_eq!(updated.len(), 1);
        }
    }

    #[test]
    fn settles_context_compaction_with_the_turn_outcome() {
        for (settlement, expected) in [
            (
                ToolSettlement::Completed,
                falcondeck_core::ToolLifecycle::Succeeded,
            ),
            (
                ToolSettlement::Failed,
                falcondeck_core::ToolLifecycle::Failed,
            ),
            (
                ToolSettlement::Interrupted,
                falcondeck_core::ToolLifecycle::Interrupted,
            ),
        ] {
            let settled_at = Utc::now();
            let mut items = vec![ConversationItem::ContextCompaction {
                id: "compact-1".to_string(),
                lifecycle: falcondeck_core::ToolLifecycle::Running,
                created_at: settled_at - chrono::Duration::seconds(1),
                completed_at: None,
            }];

            let updated = settle_tool_call_items(&mut items, settled_at, settlement);

            assert!(matches!(
                items.as_slice(),
                [ConversationItem::ContextCompaction {
                    lifecycle,
                    completed_at: Some(completed_at),
                    ..
                }] if *lifecycle == expected && *completed_at == settled_at
            ));
            assert_eq!(updated.len(), 1);
        }
    }

    #[test]
    fn settles_file_changes_without_discarding_patch_evidence() {
        let settled_at = Utc::now();
        let mut items = vec![file_change_item("inProgress")];

        let updated = settle_tool_call_items(&mut items, settled_at, ToolSettlement::Interrupted);

        assert!(matches!(
            &items[0],
            ConversationItem::FileChange {
                status,
                lifecycle: falcondeck_core::ToolLifecycle::Interrupted,
                completed_at: Some(completed_at),
                changes,
                ..
            } if status == "interrupted"
                && *completed_at == settled_at
                && changes[0].diff.contains("+new")
        ));
        assert_eq!(updated.len(), 1);
    }

    #[test]
    fn leaves_terminal_tool_status_unchanged() {
        let mut items = vec![tool_item("failed")];

        let updated = settle_tool_call_items(&mut items, Utc::now(), ToolSettlement::Completed);

        assert!(updated.is_empty());
    }
}

#[cfg(test)]
mod content_settlement_tests {
    use super::*;

    fn assistant(id: &str, lifecycle: ContentLifecycle) -> ConversationItem {
        ConversationItem::AssistantMessage {
            id: id.to_string(),
            text: id.to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle,
            error: None,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn settles_only_transient_content_to_the_turn_outcome() {
        let mut items = vec![
            assistant("earlier", ContentLifecycle::Complete),
            assistant("current", ContentLifecycle::Streaming),
            ConversationItem::Reasoning {
                id: "reasoning".to_string(),
                summary: None,
                content: "working".to_string(),
                lifecycle: ContentLifecycle::Pending,
                duration_ms: None,
                created_at: Utc::now(),
            },
            ConversationItem::Unsupported {
                id: "future".to_string(),
                output_kind: "artifactPreview".to_string(),
                reason: "Unsupported".to_string(),
                payload: serde_json::json!({ "title": "Prototype" }),
                lifecycle: ContentLifecycle::Streaming,
                created_at: Utc::now(),
            },
            ConversationItem::CodeReview {
                id: "review".to_string(),
                subject: Some("current changes".to_string()),
                content: "Partial finding".to_string(),
                lifecycle: ContentLifecycle::Streaming,
                created_at: Utc::now(),
            },
        ];

        let settled_at = Utc::now();
        let updated =
            settle_content_items(&mut items, ContentLifecycle::Interrupted, settled_at, None);

        assert_eq!(updated.len(), 4);
        assert!(matches!(
            &items[0],
            ConversationItem::AssistantMessage {
                lifecycle: ContentLifecycle::Complete,
                ..
            }
        ));
        assert!(items[1..].iter().all(|item| matches!(
            item,
            ConversationItem::AssistantMessage {
                lifecycle: ContentLifecycle::Interrupted,
                ..
            } | ConversationItem::Reasoning {
                lifecycle: ContentLifecycle::Interrupted,
                ..
            } | ConversationItem::Unsupported {
                lifecycle: ContentLifecycle::Interrupted,
                ..
            } | ConversationItem::CodeReview {
                lifecycle: ContentLifecycle::Interrupted,
                ..
            }
        )));
    }

    #[test]
    fn settles_failed_content_to_error() {
        let mut items = vec![assistant("current", ContentLifecycle::Streaming)];
        settle_content_items(&mut items, ContentLifecycle::Error, Utc::now(), None);
        assert!(matches!(
            &items[0],
            ConversationItem::AssistantMessage {
                lifecycle: ContentLifecycle::Error,
                ..
            }
        ));
    }

    #[test]
    fn attaches_provider_error_when_settling_assistant_content() {
        let mut items = vec![assistant("current", ContentLifecycle::Streaming)];

        settle_content_items(
            &mut items,
            ContentLifecycle::Error,
            Utc::now(),
            Some("  DeepSeek rejected the request  "),
        );

        assert!(matches!(
            &items[0],
            ConversationItem::AssistantMessage {
                lifecycle: ContentLifecycle::Error,
                error: Some(error),
                ..
            } if error == "DeepSeek rejected the request"
        ));
    }

    #[test]
    fn creates_a_stable_receipt_when_a_turn_fails_before_answering() {
        let created_at = Utc::now();
        let items = vec![ConversationItem::UserMessage {
            id: "user-1".to_string(),
            text: "Please continue".to_string(),
            attachments: Vec::new(),
            turn_id: Some("turn-1".to_string()),
            previous_turn_id: None,
            created_at,
        }];

        let receipt =
            terminal_assistant_receipt(&items, ContentLifecycle::Error, created_at, Some("turn-1"))
                .expect("failed turn receipt");

        assert!(matches!(
            receipt,
            ConversationItem::AssistantMessage {
                id,
                text,
                lifecycle: ContentLifecycle::Error,
                ..
            } if id == "falcondeck-turn-receipt-turn-1" && text.is_empty()
        ));
    }

    #[test]
    fn current_user_identity_wins_over_a_stale_previous_turn_hint() {
        let created_at = Utc::now();
        let items = vec![ConversationItem::UserMessage {
            id: "new-user".to_string(),
            text: "Please continue".to_string(),
            attachments: Vec::new(),
            turn_id: None,
            previous_turn_id: Some("previous-turn".to_string()),
            created_at,
        }];

        let receipt = terminal_assistant_receipt(
            &items,
            ContentLifecycle::Error,
            created_at,
            Some("previous-turn"),
        )
        .expect("failed start receipt");

        assert!(matches!(
            receipt,
            ConversationItem::AssistantMessage { id, .. }
                if id == "falcondeck-turn-receipt-new-user"
        ));
    }

    #[test]
    fn commentary_does_not_hide_a_missing_terminal_answer() {
        let created_at = Utc::now();
        let items = vec![
            ConversationItem::UserMessage {
                id: "user-1".to_string(),
                text: "Please continue".to_string(),
                attachments: Vec::new(),
                turn_id: Some("turn-1".to_string()),
                previous_turn_id: None,
                created_at,
            },
            ConversationItem::AssistantMessage {
                id: "commentary-1".to_string(),
                text: "Working on it".to_string(),
                phase: Some(AssistantMessagePhase::Commentary),
                memory_citation: None,
                citations: Vec::new(),
                lifecycle: ContentLifecycle::Interrupted,
                error: None,
                created_at,
            },
        ];

        assert!(
            terminal_assistant_receipt(
                &items,
                ContentLifecycle::Interrupted,
                created_at,
                Some("turn-1"),
            )
            .is_some()
        );
    }

    #[test]
    fn existing_final_or_legacy_answers_prevent_duplicate_receipts() {
        let created_at = Utc::now();
        for phase in [None, Some(AssistantMessagePhase::FinalAnswer)] {
            let items = vec![assistant("answer", ContentLifecycle::Error)]
                .into_iter()
                .map(|item| match item {
                    ConversationItem::AssistantMessage {
                        id,
                        text,
                        memory_citation,
                        citations,
                        lifecycle,
                        error,
                        created_at,
                        ..
                    } => ConversationItem::AssistantMessage {
                        id,
                        text,
                        phase,
                        memory_citation,
                        citations,
                        lifecycle,
                        error,
                        created_at,
                    },
                    item => item,
                })
                .collect::<Vec<_>>();
            assert!(
                terminal_assistant_receipt(
                    &items,
                    ContentLifecycle::Error,
                    created_at,
                    Some("turn-1"),
                )
                .is_none()
            );
        }
    }

    #[test]
    fn code_review_prevents_a_duplicate_empty_assistant_receipt() {
        let created_at = Utc::now();
        let items = vec![ConversationItem::CodeReview {
            id: "review-1".to_string(),
            subject: Some("current changes".to_string()),
            content: "Partial finding".to_string(),
            lifecycle: ContentLifecycle::Error,
            created_at,
        }];

        assert!(
            terminal_assistant_receipt(
                &items,
                ContentLifecycle::Error,
                created_at,
                Some("turn-1"),
            )
            .is_none()
        );
    }
}

#[cfg(test)]
mod shell_classification_tests {
    use super::*;

    fn classify(raw: &str) -> Option<ToolActivityKind> {
        classify_shell_command(raw)
    }

    #[test]
    fn unwraps_bash_wrappers_and_classifies_by_intent() {
        assert_eq!(
            classify("bash -lc 'grep -rn foo src/'"),
            Some(ToolActivityKind::Search)
        );
        assert_eq!(classify("cat Cargo.toml"), Some(ToolActivityKind::Read));
        assert_eq!(classify("ls -la crates/"), Some(ToolActivityKind::List));
        assert_eq!(
            classify("curl -s https://example.com"),
            Some(ToolActivityKind::WebSearch)
        );
    }

    #[test]
    fn edits_taint_the_whole_pipeline() {
        assert_eq!(
            classify("cat notes.md | tee out.md"),
            Some(ToolActivityKind::Edit)
        );
        assert_eq!(
            classify("sed -i '' 's/a/b/' src/lib.rs"),
            Some(ToolActivityKind::Edit)
        );
        assert_eq!(
            classify("echo hi > file.txt"),
            Some(ToolActivityKind::Edit),
            "a file redirect is an edit regardless of the program"
        );
        assert_eq!(classify("cat a.txt > b.txt"), Some(ToolActivityKind::Edit));
    }

    #[test]
    fn searches_outrank_reads_in_pipelines() {
        assert_eq!(
            classify("cat error.log | grep -i panic"),
            Some(ToolActivityKind::Search)
        );
        assert_eq!(
            classify("head -50 a.rs && tail -50 a.rs"),
            Some(ToolActivityKind::Read)
        );
    }

    #[test]
    fn stderr_and_null_redirects_are_not_edits() {
        assert_eq!(
            classify("grep -rn foo src/ 2>/dev/null"),
            Some(ToolActivityKind::Search)
        );
        assert_eq!(classify("cat a.txt 2>&1"), Some(ToolActivityKind::Read));
        assert_eq!(
            classify("find . -name '*.rs' > /dev/null"),
            Some(ToolActivityKind::Search)
        );
    }

    #[test]
    fn unrecognized_commands_fall_through() {
        assert_eq!(classify("git status"), None);
        assert_eq!(classify("cargo build"), None);
        assert_eq!(classify("Read /path/to/file"), None);
        assert_eq!(
            classify("FOO=bar sudo rm -rf target"),
            Some(ToolActivityKind::Edit)
        );
    }

    #[test]
    fn test_cards_require_a_runner_at_command_position() {
        for title in [
            "cargo test -p falcondeck-daemon",
            "npm test",
            "npm run test",
            "pnpm test",
            "go test ./...",
            "pytest tests/",
            "npx vitest run",
            "node --test",
            "bash -lc 'cargo build && cargo test'",
        ] {
            assert!(
                title_is_test_invocation(title),
                "{title} should be a test run"
            );
        }
        for title in [
            "read foo.test.ts",
            "cat foo.test.ts",
            "rg testcase src/",
            "ls tests/",
            "npm run build",
            "cargo build --tests",
        ] {
            assert!(
                !title_is_test_invocation(title),
                "{title} is not a test run"
            );
        }

        let display = tool_display_metadata(
            "cat foo.test.ts",
            "commandExecution",
            "completed",
            Some(0),
            None,
        );
        assert_eq!(display.activity_kind, ToolActivityKind::Read);
    }

    #[test]
    fn approval_classification_ignores_free_text_titles() {
        // A Codex shell title merely mentioning "approval" must not render a
        // running command as AwaitingApproval.
        let display = tool_display_metadata(
            "rg approval src/",
            "commandExecution",
            "running",
            None,
            None,
        );
        assert_eq!(display.activity_kind, ToolActivityKind::Search);

        let display =
            tool_display_metadata("Approve command", "approvalRequest", "running", None, None);
        assert_eq!(display.activity_kind, ToolActivityKind::Approval);
    }

    #[test]
    fn structures_vitest_counts_and_duration() {
        let summary = summarize_test_run(
            "npm test",
            Some(
                " Test Files  1 failed | 58 passed (59)\n      Tests  2 failed | 534 passed | 3 skipped (539)\n   Duration  2.69s",
            ),
        )
        .expect("vitest summary");

        assert_eq!(summary.framework.as_deref(), Some("vitest"));
        assert_eq!(summary.total, Some(539));
        assert_eq!(summary.passed, Some(534));
        assert_eq!(summary.failed, Some(2));
        assert_eq!(summary.skipped, Some(3));
        assert_eq!(summary.suites_total, Some(59));
        assert_eq!(summary.suites_passed, Some(58));
        assert_eq!(summary.suites_failed, Some(1));
        assert_eq!(summary.duration_ms, Some(2_690));
    }

    #[test]
    fn completed_test_tool_display_carries_the_structured_summary() {
        let display = tool_display_metadata(
            "npm test",
            "commandExecution",
            "failed",
            Some(1),
            Some(
                "Test Files  1 failed | 4 passed (5)\nTests  1 failed | 42 passed (43)\nDuration 1.24s",
            ),
        );

        assert_eq!(display.artifact_kind, ToolArtifactKind::Test);
        let summary = display.test_summary.expect("wired test summary");
        assert_eq!(summary.framework.as_deref(), Some("vitest"));
        assert_eq!(summary.failed, Some(1));
        assert_eq!(summary.suites_failed, Some(1));
        assert_eq!(summary.duration_ms, Some(1_240));
    }

    #[test]
    fn structures_cargo_pytest_jest_tap_and_xctest_summaries() {
        let cases = [
            (
                "cargo test",
                "test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured; finished in 0.04s",
                "cargo",
                13,
                12,
                0,
                1,
            ),
            (
                "pytest",
                "================ 2 failed, 5 passed, 1 skipped in 0.34s ================",
                "pytest",
                8,
                5,
                2,
                1,
            ),
            (
                "npx jest",
                "Test Suites: 1 failed, 2 passed, 3 total\nTests: 2 failed, 7 passed, 9 total\nTime: 3.2 s",
                "jest",
                9,
                7,
                2,
                0,
            ),
            (
                "node --test",
                "# tests 5\n# pass 4\n# fail 0\n# skipped 1",
                "node",
                5,
                4,
                0,
                1,
            ),
            (
                "xcodebuild test",
                "Executed 12 tests, with 2 failures (0 unexpected) in 0.123 seconds",
                "xctest",
                12,
                10,
                2,
                0,
            ),
        ];

        for (title, output, framework, total, passed, failed, skipped) in cases {
            let summary = summarize_test_run(title, Some(output)).expect(framework);
            assert_eq!(summary.framework.as_deref(), Some(framework));
            assert_eq!(summary.total, Some(total), "{framework}");
            assert_eq!(summary.passed, Some(passed), "{framework}");
            assert_eq!(summary.failed, Some(failed), "{framework}");
            assert_eq!(summary.skipped, Some(skipped), "{framework}");
        }
    }

    #[test]
    fn aggregates_multiple_cargo_test_binaries_without_losing_failures() {
        let summary = summarize_test_run(
            "cargo test --workspace",
            Some(
                "test result: ok. 12 passed; 0 failed; 1 ignored; finished in 0.04s\n\
                 test result: FAILED. 3 passed; 2 failed; 0 ignored; finished in 0.06s",
            ),
        )
        .expect("cargo workspace summary");

        assert_eq!(summary.total, Some(18));
        assert_eq!(summary.passed, Some(15));
        assert_eq!(summary.failed, Some(2));
        assert_eq!(summary.skipped, Some(1));
        assert_eq!(summary.duration_ms, Some(100));
    }

    #[test]
    fn ignores_non_test_output_even_when_it_contains_numbers() {
        assert!(summarize_test_run("Run checks", Some("compiled 43 modules in 2.1s")).is_none());
    }
}

#[cfg(test)]
mod user_item_id_tests {
    use super::*;

    fn text_inputs(text: &str) -> Vec<TurnInputItem> {
        vec![TurnInputItem::Text {
            id: None,
            text: text.to_string(),
        }]
    }

    #[test]
    fn accepts_well_formed_client_ids() {
        let id = format!("user-{}", "a".repeat(64));
        assert_eq!(sanitize_user_item_id(Some(&id)), Some(id.clone()));
        assert_eq!(
            sanitize_user_item_id(Some("user-3f2A_b-9")),
            Some("user-3f2A_b-9".to_string())
        );
    }

    #[test]
    fn rejects_foreign_or_malformed_ids() {
        assert_eq!(sanitize_user_item_id(None), None);
        assert_eq!(sanitize_user_item_id(Some("assistant-abc")), None);
        assert_eq!(sanitize_user_item_id(Some("user-")), None);
        assert_eq!(sanitize_user_item_id(Some("user-has space")), None);
        assert_eq!(sanitize_user_item_id(Some("user-emoji-🦀")), None);
        let oversized = format!("user-{}", "a".repeat(65));
        assert_eq!(sanitize_user_item_id(Some(&oversized)), None);
    }

    #[test]
    fn build_honours_the_requested_id() {
        let item = build_user_message_item(&text_inputs("hi"), Some("user-abc123"), None, None);
        let ConversationItem::UserMessage { id, .. } = item else {
            panic!("expected user message");
        };
        assert_eq!(id, "user-abc123");
    }

    #[test]
    fn build_falls_back_to_a_fresh_id_when_the_request_is_malformed() {
        let item = build_user_message_item(&text_inputs("hi"), Some("evil id"), None, None);
        let ConversationItem::UserMessage { id, .. } = item else {
            panic!("expected user message");
        };
        assert_ne!(id, "evil id");
        assert!(id.starts_with("user-"));
    }
}
