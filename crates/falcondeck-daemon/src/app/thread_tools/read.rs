//! Compact, searchable projections of native thread history.
use super::*;
use std::borrow::Cow;

const DEFAULT_CHARS: usize = 6000;
const DEFAULT_ITEMS: usize = 20;
const SCAN_LIMIT: usize = 1000;
const PAGE_SIZE: usize = 100;

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(super) struct ViewArgs {
    pub thread_id: Option<String>,
    pub before: Option<String>,
    pub limit: Option<usize>,
    pub max_chars: Option<usize>,
    #[serde(default)]
    pub include_tools: bool,
    #[serde(default)]
    pub include_reasoning: bool,
    pub query: Option<String>,
    pub item_id: Option<String>,
    pub offset: Option<usize>,
}

pub(super) async fn view(
    app: &AppState,
    workspace: &str,
    thread: &str,
    args: &ViewArgs,
) -> Result<String, DaemonError> {
    let cap = args
        .max_chars
        .unwrap_or(DEFAULT_CHARS)
        .clamp(512, MAX_CHARS);
    if let Some(id) = &args.item_id {
        if id.is_empty() || args.before.is_some() || args.query.is_some() {
            return Err(DaemonError::BadRequest(
                "item_id cannot be empty or combined with before/query".into(),
            ));
        }
        let item = app.thread_item(workspace, thread, id).await?;
        return expand(thread, &item, args.offset.unwrap_or(0), cap);
    }
    if args.offset.is_some() {
        return Err(DaemonError::BadRequest("offset requires item_id".into()));
    }
    let query = args
        .query
        .as_deref()
        .map(|query| {
            if query.trim().is_empty() || query.chars().count() > 256 {
                return Err(DaemonError::BadRequest(
                    "query must contain 1–256 characters of literal text".into(),
                ));
            }
            regex::RegexBuilder::new(&regex::escape(query))
                .case_insensitive(true)
                .build()
                .map_err(|e| DaemonError::BadRequest(e.to_string()))
        })
        .transpose()?;
    let limit = args.limit.unwrap_or(DEFAULT_ITEMS).clamp(1, MAX_ITEMS);
    let budget = cap.saturating_sub(400);
    let mut sections = Vec::new();
    let mut used = 0;
    let mut scanned = 0;
    let mut before = args.before.clone();
    let mut has_older;
    'pages: loop {
        let detail = app
            .thread_detail_with_request(&ThreadDetailRequest {
                workspace_id: workspace.into(),
                thread_id: thread.into(),
                mode: if before.is_some() {
                    ThreadDetailMode::Before
                } else {
                    ThreadDetailMode::Tail
                },
                limit: Some(PAGE_SIZE),
                before_item_id: before.clone(),
                inline_images: Some(false),
                // Search must inspect the full output, including matches beyond previews.
                tool_output_bytes: if query.is_some() && args.include_tools {
                    None
                } else {
                    Some(2000)
                },
                strict_limit: Some(true),
                compact_workspace: Some(true),
                refresh_native: None,
            })
            .await?;
        // Tail pages may prepend a distant prompt. It isn't part of the contiguous window.
        let start = detail
            .oldest_item_id
            .as_deref()
            .and_then(|id| {
                detail
                    .items
                    .iter()
                    .position(|item| workspace_ops::conversation_item_id(item) == id)
            })
            .unwrap_or(0);
        let items = &detail.items[start..];
        has_older = detail.has_older;
        for (index, item) in items.iter().enumerate().rev() {
            let id = workspace_ops::conversation_item_id(item);
            if selected(item, args) {
                let (heading, body) = item_parts(item);
                let offset = if let Some(query) = &query {
                    let Some(found) = query.find(&body) else {
                        scanned += 1;
                        before = Some(id.into());
                        if scanned == SCAN_LIMIT {
                            has_older = detail.has_older || index > 0;
                            break 'pages;
                        }
                        continue;
                    };
                    body[..found.start()].chars().count().saturating_sub(120)
                } else {
                    0
                };
                let section = excerpt(
                    &heading,
                    id,
                    &body,
                    offset,
                    if query.is_some() { 600 } else { 1200 },
                );
                let size = section.chars().count() + 2;
                if used + size > budget && !sections.is_empty() {
                    has_older = true;
                    break 'pages;
                }
                // Keep IDs and continuation offsets intact even when the first body fills the budget.
                let overhead = excerpt(&heading, id, &body, offset, 0).chars().count() + 20;
                let length = budget
                    .saturating_sub(used + overhead + 2)
                    .min(if query.is_some() { 600 } else { 1200 });
                sections.push(excerpt(&heading, id, &body, offset, length));
                used += sections.last().map_or(0, |s| s.chars().count() + 2);
            }
            scanned += 1;
            before = Some(id.into());
            if sections.len() == limit || scanned == SCAN_LIMIT {
                has_older = detail.has_older || index > 0;
                break 'pages;
            }
        }
        if !has_older || items.is_empty() {
            break;
        }
        if scanned >= SCAN_LIMIT {
            break;
        }
    }
    sections.reverse();
    let navigation = if has_older {
        format!(
            "Older items: before={} (keep query/filters).",
            line(before.as_deref().unwrap_or(""), 128)
        )
    } else {
        "No older items.".into()
    };
    let scope = format!(
        "user/assistant{}{}",
        if args.include_tools { ", activity" } else { "" },
        if args.include_reasoning {
            ", reasoning"
        } else {
            ""
        }
    );
    let empty = if sections.is_empty() {
        "No matching messages in scanned history.\n"
    } else {
        ""
    };
    Ok(capped(
        &format!(
            "# Thread {}\n\n{navigation}\nScope: {scope}. Shown {}; scanned {scanned} items.\nExpand with item_id; use offset for more body text.\n\n{empty}{}",
            line(thread, 128),
            sections.len(),
            sections.join("\n\n")
        ),
        cap,
    ))
}

fn selected(item: &ConversationItem, args: &ViewArgs) -> bool {
    match item {
        ConversationItem::UserMessage { .. } | ConversationItem::AssistantMessage { .. } => true,
        ConversationItem::Reasoning { .. } => args.include_reasoning,
        _ => args.include_tools,
    }
}

// Search and expansion use original text, not the capped handoff preview.
fn item_parts(item: &ConversationItem) -> (String, Cow<'_, str>) {
    let (heading, text) = match item {
        ConversationItem::UserMessage {
            text, attachments, ..
        } => {
            let heading = if attachments.is_empty() {
                "User".into()
            } else {
                format!("User — {} attachment(s)", attachments.len())
            };
            return (heading, Cow::Borrowed(text));
        }
        ConversationItem::AssistantMessage { text, .. } => ("Assistant", text.as_str()),
        ConversationItem::Reasoning { content, .. } => ("Reasoning", content.as_str()),
        ConversationItem::CodeReview { content, .. } => ("Code review", content.as_str()),
        ConversationItem::ToolCall {
            title,
            output,
            exit_code,
            ..
        } => {
            let exit = exit_code
                .filter(|code| *code != 0)
                .map(|code| format!(" (exit {code})"))
                .unwrap_or_default();
            return (
                format!("Tool — {}{exit}", line(title, 100)),
                Cow::Borrowed(output.as_deref().unwrap_or("")),
            );
        }
        ConversationItem::Artifact { artifact, .. } => {
            return (
                format!("Artifact — {}", line(&artifact.title, 100)),
                Cow::Borrowed(artifact.content.as_deref().unwrap_or("")),
            );
        }
        ConversationItem::Service { message, .. } => ("Service", message.as_str()),
        ConversationItem::FileChange { changes, .. } => {
            return (
                "Files edited".into(),
                Cow::Owned(
                    changes
                        .iter()
                        .map(|change| format!("- {}", change.path))
                        .collect::<Vec<_>>()
                        .join("\n"),
                ),
            );
        }
        ConversationItem::Plan { plan, .. } => {
            return (
                "Plan".into(),
                Cow::Owned(format!(
                    "{}\n{}",
                    plan.explanation.as_deref().unwrap_or(""),
                    plan.steps
                        .iter()
                        .map(|step| format!("- {}", step.step))
                        .collect::<Vec<_>>()
                        .join("\n")
                )),
            );
        }
        ConversationItem::ContextCompaction { .. } => (
            "Context compaction",
            "Earlier conversation was summarized for continuity.",
        ),
        ConversationItem::Image { image, .. } => {
            ("Image", image.alt_text.as_deref().unwrap_or("Image"))
        }
        ConversationItem::WebSearch { search, .. } => ("Web search", search.query.as_str()),
        ConversationItem::Unsupported { reason, .. } => ("Unsupported output", reason.as_str()),
        ConversationItem::Diff { .. } => ("Diff", "Diff omitted from bounded handoff."),
        ConversationItem::InteractiveRequest { resolved, .. } => (
            "Interactive request",
            if *resolved {
                "Resolved in FalconDeck."
            } else {
                "Awaiting response in FalconDeck UI."
            },
        ),
    };
    (heading.into(), Cow::Borrowed(text))
}

fn excerpt(heading: &str, id: &str, body: &str, offset: usize, length: usize) -> String {
    let text: String = body.chars().skip(offset).take(length).collect();
    let end = offset + text.chars().count();
    let more = body.chars().nth(end).is_some();
    format!(
        "## {heading}\n\nId: {} | offset={offset}{}\n\n{}{text}{}",
        line(id, 128),
        if more {
            format!(" | next_offset={end}")
        } else {
            String::new()
        },
        if offset > 0 { "…" } else { "" },
        if more { "…" } else { "" }
    )
}

fn expand(
    thread: &str,
    item: &ConversationItem,
    offset: usize,
    cap: usize,
) -> Result<String, DaemonError> {
    let (heading, body) = item_parts(item);
    if offset > body.chars().count() {
        return Err(DaemonError::BadRequest(
            "offset exceeds item body length".into(),
        ));
    }
    let section = excerpt(
        &heading,
        workspace_ops::conversation_item_id(item),
        &body,
        offset,
        cap.saturating_sub(400),
    );
    Ok(capped(
        &format!("# Thread {}\n\n{section}", line(thread, 128)),
        cap,
    ))
}
