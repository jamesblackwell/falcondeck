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
    pub role: Option<Role>,
    pub preview_chars: Option<usize>,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Role {
    User,
    Assistant,
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
    let preview = args.preview_chars.unwrap_or(1200).clamp(200, MAX_CHARS);
    let status = app.thread_status_lines(workspace, thread).await?;
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
    let budget = cap.saturating_sub(400 + status.chars().count());
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
                // Plain reads list file paths. Search has to see patch bodies.
                let (heading, body) = item_parts(item, query.is_some());
                let offset = if let Some(query) = &query {
                    let Some(offset) = match_offset(query, item, &body) else {
                        scanned += 1;
                        before = Some(id.into());
                        if scanned == SCAN_LIMIT {
                            has_older = detail.has_older || index > 0;
                            break 'pages;
                        }
                        continue;
                    };
                    offset
                } else {
                    0
                };
                let at = Some(super::digest::item_created_at(item));
                let length = if query.is_some() { 600 } else { preview };
                let cited = query.is_some();
                let section = excerpt(&heading, id, at, &body, offset, length, cited);
                let size = section.chars().count() + 2;
                if used + size > budget && !sections.is_empty() {
                    has_older = true;
                    break 'pages;
                }
                // Keep IDs and continuation offsets intact even when the first body fills the budget.
                let overhead = excerpt(&heading, id, at, &body, offset, 0, cited)
                    .chars()
                    .count()
                    + 20;
                let length = budget.saturating_sub(used + overhead + 2).min(length);
                sections.push(excerpt(&heading, id, at, &body, offset, length, cited));
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
            "Older: before={} (keep query and filters).",
            line(before.as_deref().unwrap_or(""), 128)
        )
    } else {
        "No older items.".into()
    };
    let scope = match args.role {
        Some(Role::User) => "user".into(),
        Some(Role::Assistant) => "assistant".into(),
        None => format!(
            "user/assistant{}{}",
            if args.include_tools { ", activity" } else { "" },
            if args.include_reasoning {
                ", reasoning"
            } else {
                ""
            }
        ),
    };
    let empty = if sections.is_empty() {
        "No matching messages in scanned history.\n"
    } else {
        ""
    };
    Ok(capped(
        &format!(
            "{status}Scope: {scope}, newest last. Shown {}; scanned {scanned} items. {navigation}\n\n{empty}{}",
            sections.len(),
            sections.join("\n\n")
        ),
        cap,
    ))
}

fn selected(item: &ConversationItem, args: &ViewArgs) -> bool {
    if let Some(role) = args.role {
        return match item {
            ConversationItem::UserMessage { .. } => role == Role::User,
            ConversationItem::AssistantMessage { .. } => role == Role::Assistant,
            _ => false,
        };
    }
    match item {
        ConversationItem::UserMessage { .. } | ConversationItem::AssistantMessage { .. } => true,
        ConversationItem::Reasoning { .. } => args.include_reasoning,
        _ => args.include_tools,
    }
}

// Search and expansion use original text, not the capped handoff preview.
// `detailed` includes patch bodies; a plain read lists the paths only, so one
// diff cannot crowd the other files out of the excerpt or copy a whole patch.
fn item_parts(item: &ConversationItem, detailed: bool) -> (String, Cow<'_, str>) {
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
        ConversationItem::Reasoning {
            content, summary, ..
        } => {
            return (
                "Reasoning".into(),
                reasoning_body(summary.as_deref(), content),
            );
        }
        ConversationItem::CodeReview { content, .. } => ("Code review", content.as_str()),
        ConversationItem::ToolCall {
            title,
            output,
            exit_code,
            detail,
            ..
        } => {
            let exit = exit_code
                .filter(|code| *code != 0)
                .map(|code| format!(" (exit {code})"))
                .unwrap_or_default();
            return (
                format!("Tool — {}{exit}", line(title, 100)),
                tool_body(title, detail, output.as_deref().unwrap_or("")),
            );
        }
        ConversationItem::Artifact { artifact, .. } => {
            return (
                format!("Artifact — {}", line(&artifact.title, 100)),
                artifact_body(artifact),
            );
        }
        ConversationItem::Service { message, .. } => ("Service", message.as_str()),
        ConversationItem::FileChange {
            changes, status, ..
        } => {
            return (
                file_change_heading(status),
                Cow::Owned(file_change_body(changes, detailed)),
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
        ConversationItem::Image { title, image, .. } => {
            let label = title
                .as_deref()
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .or_else(|| {
                    image
                        .name
                        .as_deref()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                })
                .unwrap_or("Image");
            return (
                format!("Image — {}", line(label, 100)),
                image_body(title.as_deref(), image),
            );
        }
        ConversationItem::WebSearch { search, .. } => {
            return ("Web search".into(), web_search_body(search));
        }
        ConversationItem::Unsupported { reason, .. } => ("Unsupported output", reason.as_str()),
        ConversationItem::Diff { diff, .. } => return ("Diff".into(), Cow::Borrowed(diff)),
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

/// Char offset of a literal match in `body`. `Some(0)` when the match is only
/// in a title the heading still displays. `None` means no match.
fn match_offset(query: &regex::Regex, item: &ConversationItem, body: &str) -> Option<usize> {
    if let Some(found) = query.find(body) {
        return Some(body[..found.start()].chars().count().saturating_sub(120));
    }
    let title = match item {
        ConversationItem::ToolCall { title, .. } => Some(title.as_str()),
        ConversationItem::Artifact { artifact, .. } => Some(artifact.title.as_str()),
        ConversationItem::Image { title, .. } => title.as_deref(),
        _ => None,
    };
    title
        .is_some_and(|title| query.is_match(title))
        .then_some(0)
}

fn tool_body<'a>(
    title: &'a str,
    detail: &'a Option<Box<falcondeck_core::ToolCallDetail>>,
    output: &'a str,
) -> Cow<'a, str> {
    let command = match detail.as_deref() {
        Some(falcondeck_core::ToolCallDetail::CommandExecution { command, .. })
            if !command.is_empty() =>
        {
            Some(command.as_str())
        }
        _ => None,
    };
    // Headings keep 100 characters. A longer title, and a shell command that
    // is not already in that title or the output, stay in the body.
    let title_extra = title.chars().count() > 100 && !output.contains(title);
    let command_extra = command.is_some_and(|command| {
        command != title && !output.contains(command) && !title.contains(command)
    });
    if !title_extra && !command_extra {
        return Cow::Borrowed(output);
    }
    let mut body = String::new();
    if title_extra {
        body.push_str(title);
        body.push('\n');
    }
    if let Some(command) = command
        && command_extra
    {
        body.push_str(command);
        body.push('\n');
    }
    body.push_str(output);
    Cow::Owned(body)
}

fn reasoning_body<'a>(summary: Option<&'a str>, content: &'a str) -> Cow<'a, str> {
    match summary.map(str::trim).filter(|summary| !summary.is_empty()) {
        Some(summary) if content.is_empty() => Cow::Borrowed(summary),
        Some(summary) if !content.contains(summary) => Cow::Owned(format!("{summary}\n{content}")),
        _ => Cow::Borrowed(content),
    }
}

fn file_change_heading(status: &str) -> String {
    if status.is_empty()
        || matches!(
            status.to_ascii_lowercase().as_str(),
            "completed" | "complete" | "success" | "succeeded" | "done"
        )
    {
        "Files edited".into()
    } else {
        format!("Files edited ({status})")
    }
}

fn push_file_change_line(out: &mut String, change: &falcondeck_core::ConversationFileChange) {
    out.push_str("- ");
    if !change.change_kind.is_empty() {
        out.push_str(&change.change_kind);
        out.push(' ');
    }
    out.push_str(&change.path);
    if let Some(dest) = &change.move_path {
        out.push_str(" -> ");
        out.push_str(dest);
    }
}

fn file_change_body(changes: &[falcondeck_core::ConversationFileChange], detailed: bool) -> String {
    let mut out = String::new();
    for (index, change) in changes.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        push_file_change_line(&mut out, change);
    }
    if !detailed {
        return out;
    }
    for change in changes {
        if change.diff.is_empty() {
            continue;
        }
        out.push_str("\n\n");
        push_file_change_line(&mut out, change);
        out.push('\n');
        out.push_str(&change.diff);
    }
    out
}

fn artifact_body(artifact: &falcondeck_core::ConversationArtifact) -> Cow<'_, str> {
    let content = artifact.content.as_deref().unwrap_or("");
    if artifact.title.chars().count() > 100 && !content.contains(&artifact.title) {
        return Cow::Owned(format!("{}\n{content}", artifact.title));
    }
    Cow::Borrowed(content)
}

fn image_body<'a>(
    title: Option<&'a str>,
    image: &'a falcondeck_core::ConversationImage,
) -> Cow<'a, str> {
    let alt = image.alt_text.as_deref().unwrap_or("");
    let title = title.map(str::trim).filter(|title| !title.is_empty());
    let name = image
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let mut extra = String::new();
    if let Some(title) = title.filter(|title| !alt.contains(*title)) {
        extra.push_str(title);
        extra.push('\n');
    }
    if let Some(name) =
        name.filter(|name| title != Some(*name) && !alt.contains(*name) && !extra.contains(*name))
    {
        extra.push_str(name);
        extra.push('\n');
    }
    if extra.is_empty() {
        return if alt.is_empty() {
            Cow::Borrowed("Image")
        } else {
            Cow::Borrowed(alt)
        };
    }
    if alt.is_empty() {
        extra.pop();
    } else {
        extra.push_str(alt);
    }
    Cow::Owned(extra)
}

fn web_search_body(search: &falcondeck_core::ConversationWebSearch) -> Cow<'_, str> {
    let extras = search.queries.iter().any(|query| query != &search.query)
        || search.url.is_some()
        || search.pattern.is_some();
    if !extras {
        return Cow::Borrowed(&search.query);
    }
    let mut text = search.query.clone();
    for query in &search.queries {
        if query != &search.query {
            text.push('\n');
            text.push_str(query);
        }
    }
    if let Some(url) = &search.url {
        text.push('\n');
        text.push_str(url);
    }
    if let Some(pattern) = &search.pattern {
        text.push('\n');
        text.push_str(pattern);
    }
    Cow::Owned(text)
}

fn excerpt(
    heading: &str,
    id: &str,
    at: Option<chrono::DateTime<Utc>>,
    body: &str,
    offset: usize,
    length: usize,
    cited: bool,
) -> String {
    let text: String = body.chars().skip(offset).take(length).collect();
    let end = offset + text.chars().count();
    let more = body.chars().nth(end).is_some();
    // The id is only needed to read more of this item, or to open a search hit.
    let reference = match (more, offset > 0 || cited) {
        (true, _) => format!("\n[item_id={} offset={end} for more]", line(id, 128)),
        (false, true) => format!("\n[item_id={}]", line(id, 128)),
        (false, false) => String::new(),
    };
    format!(
        "### {heading}{}\n{}{text}{}{reference}",
        at.map(|at| format!(" · {}", at.format("%Y-%m-%d %H:%M")))
            .unwrap_or_default(),
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
    let (heading, body) = item_parts(item, true);
    if offset > body.chars().count() {
        return Err(DaemonError::BadRequest(
            "offset exceeds item body length".into(),
        ));
    }
    let section = excerpt(
        &heading,
        workspace_ops::conversation_item_id(item),
        Some(super::digest::item_created_at(item)),
        &body,
        offset,
        cap.saturating_sub(400),
        false,
    );
    Ok(capped(
        &format!(
            "# Item in `{}` from offset {offset}\n\n{section}",
            line(thread, 128)
        ),
        cap,
    ))
}
