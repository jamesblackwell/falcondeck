//! Cheap structured digests and change feeds for coordinating agents.
//!
//! Digests read the daemon summary, pending interactive requests, and items
//! already in memory. Native transcripts load only with `hydrate: true`.
use super::*;
use chrono::DateTime;
use falcondeck_core::{InteractiveRequest, InteractiveRequestKind};
use std::sync::LazyLock;

const SCAN_ITEMS: usize = 2000;
const HYDRATE_THREADS: usize = 5;
const MAX_IDS: usize = 20;
const DEFAULT_SUMMARY_CHARS: usize = 8000;
const DEFAULT_CHANGES_CHARS: usize = 6000;
/// Commit output is short and leads its command's output.
const COMMIT_SCAN_BYTES: usize = 16 * 1024;

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(super) struct SummaryArgs {
    thread_id: Option<String>,
    #[serde(default)]
    thread_ids: Vec<String>,
    #[serde(default)]
    hydrate: bool,
    max_chars: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ChangesArgs {
    since: String,
    limit: Option<usize>,
    #[serde(default)]
    include_archived: bool,
    max_chars: Option<usize>,
}

pub(super) fn item_created_at(item: &ConversationItem) -> DateTime<Utc> {
    match item {
        ConversationItem::UserMessage { created_at, .. }
        | ConversationItem::AssistantMessage { created_at, .. }
        | ConversationItem::Reasoning { created_at, .. }
        | ConversationItem::CodeReview { created_at, .. }
        | ConversationItem::ContextCompaction { created_at, .. }
        | ConversationItem::Artifact { created_at, .. }
        | ConversationItem::Unsupported { created_at, .. }
        | ConversationItem::Image { created_at, .. }
        | ConversationItem::WebSearch { created_at, .. }
        | ConversationItem::FileChange { created_at, .. }
        | ConversationItem::ToolCall { created_at, .. }
        | ConversationItem::Plan { created_at, .. }
        | ConversationItem::Diff { created_at, .. }
        | ConversationItem::Service { created_at, .. }
        | ConversationItem::InteractiveRequest { created_at, .. } => *created_at,
    }
}

pub(super) fn stamp(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn ago(at: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let seconds = (now - at).num_seconds().max(0);
    match seconds {
        0..60 => format!("{seconds}s ago"),
        60..3600 => format!("{}m ago", seconds / 60),
        3600..86_400 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

/// RFC 3339 timestamp, or a relative window such as `90s`, `15m`, `2h`, `1d`.
fn parse_since(value: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, DaemonError> {
    let value = value.trim();
    if let Ok(at) = DateTime::parse_from_rfc3339(value) {
        return Ok(at.with_timezone(&Utc));
    }
    let invalid = || {
        DaemonError::BadRequest(
            "since must be an RFC 3339 timestamp or a window like 90s, 15m, 2h, 1d".into(),
        )
    };
    let split = value
        .find(|c: char| !c.is_ascii_digit())
        .ok_or_else(invalid)?;
    let (amount, unit) = value.split_at(split);
    let amount: i64 = amount.parse().map_err(|_| invalid())?;
    let seconds = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        _ => return Err(invalid()),
    };
    amount
        .checked_mul(seconds)
        .filter(|s| *s <= 366 * 86_400)
        .map(|s| now - chrono::Duration::seconds(s))
        .ok_or_else(invalid)
}

fn status_name(status: &ThreadStatus) -> &'static str {
    match status {
        ThreadStatus::Idle => "idle",
        ThreadStatus::Running => "running",
        ThreadStatus::WaitingForInput => "waiting_for_input",
        ThreadStatus::Error => "error",
    }
}

/// One line naming what the thread is blocked on, if anything. Approvals and
/// questions are answered in the FalconDeck UI, never through these tools.
pub(super) fn attention(summary: &ThreadSummary, pending: &[InteractiveRequest]) -> Option<String> {
    let describe = |request: &InteractiveRequest| {
        let subject = request
            .questions
            .first()
            .map(|q| q.question.as_str())
            .filter(|_| request.kind == InteractiveRequestKind::Question)
            .or(request.command.as_deref())
            .or(request.path.as_deref())
            .unwrap_or("");
        if subject.is_empty() || request.title.contains(subject) {
            format!("\"{}\"", line(&request.title, 120))
        } else {
            format!("\"{}\" ({})", line(&request.title, 80), line(subject, 120))
        }
    };
    let approvals: Vec<_> = pending
        .iter()
        .filter(|r| r.kind != InteractiveRequestKind::Question)
        .collect();
    let questions: Vec<_> = pending
        .iter()
        .filter(|r| r.kind == InteractiveRequestKind::Question)
        .collect();
    let mut parts = Vec::new();
    for (label, requests) in [("approval", &approvals), ("user question", &questions)] {
        if let Some(first) = requests.first() {
            parts.push(format!(
                "waiting on {label}{} {}",
                if requests.len() > 1 {
                    format!(" ({})", requests.len())
                } else {
                    String::new()
                },
                describe(first)
            ));
        }
    }
    if !parts.is_empty() {
        return Some(format!(
            "ATTENTION: {} — resolve in FalconDeck UI.",
            parts.join("; ")
        ));
    }
    // Summary counts stand in when the request map was not consulted (list).
    let (approvals, questions) = (
        summary.attention.pending_approval_count,
        summary.attention.pending_question_count,
    );
    if approvals + questions > 0 {
        return Some(format!(
            "ATTENTION: waiting on {approvals} approval(s), {questions} user question(s) — resolve in FalconDeck UI."
        ));
    }
    match summary.status {
        ThreadStatus::WaitingForInput => {
            Some("ATTENTION: waiting for user input — resolve in FalconDeck UI.".into())
        }
        ThreadStatus::Error => Some(format!(
            "ATTENTION: errored{}",
            summary
                .last_error
                .as_deref()
                .map(|e| format!(": {}", line(e, 200)))
                .unwrap_or_default()
        )),
        _ => None,
    }
}

impl AppState {
    pub(super) async fn pending_requests(
        &self,
        workspace: &str,
    ) -> HashMap<String, Vec<InteractiveRequest>> {
        let requests = self.inner.interactive_requests.lock().await;
        let mut by_thread: HashMap<String, Vec<InteractiveRequest>> = HashMap::new();
        for pending in requests.values() {
            if pending.request.workspace_id == workspace
                && let Some(thread) = &pending.request.thread_id
            {
                by_thread
                    .entry(thread.clone())
                    .or_default()
                    .push(pending.request.clone());
            }
        }
        for list in by_thread.values_mut() {
            list.sort_by_key(|r| r.created_at);
        }
        by_thread
    }

    /// Status and attention header lines for one thread.
    pub(super) async fn thread_status_lines(
        &self,
        workspace: &str,
        thread: &str,
    ) -> Result<String, DaemonError> {
        let summary = self.thread_summary(workspace, thread).await?;
        let pending = self
            .pending_requests(workspace)
            .await
            .remove(thread)
            .unwrap_or_default();
        let mut text = format!(
            "Status: {} | Last activity: {}\n",
            status_name(&summary.status),
            stamp(summary.updated_at)
        );
        if let Some(flag) = attention(&summary, &pending) {
            text.push_str(&flag);
            text.push('\n');
        }
        Ok(text)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum CheckKind {
    Autoreview,
    Tests,
    Typecheck,
}

struct Check {
    command: String,
    outcome: &'static str,
    at: DateTime<Utc>,
    runs: usize,
}

struct Message {
    id: String,
    text: String,
    at: DateTime<Utc>,
}

#[derive(Default)]
struct Digest {
    scanned: usize,
    /// The scan reached the window boundary rather than the item cap.
    complete: bool,
    last_item_at: Option<DateTime<Utc>>,
    last_user: Option<Message>,
    last_assistant: Option<Message>,
    user_messages: usize,
    assistant_messages: usize,
    files: Vec<String>,
    commits: Vec<(String, String)>,
    checks: Vec<(CheckKind, Check)>,
    failed_tools: usize,
    last_failure: Option<String>,
}

static COMMIT_LINE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?m)^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$").unwrap()
});
static TEST_COMMAND: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"\b(cargo (nextest|test)|(npm|pnpm|yarn|bun)( run)? test|vitest|jest|pytest|go test|make test|swift test|xcodebuild test)\b",
    )
    .unwrap()
});
static TYPECHECK_COMMAND: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"\b(tsc|typecheck|cargo (check|clippy)|mypy|pyright)\b").unwrap()
});

/// Tool titles that name a non-shell action. Anything else may be a shell
/// command titled by its own text (Claude's Bash tool, for example).
const NON_COMMAND_TITLES: &[&str] = &[
    "Read",
    "Edit",
    "Write",
    "List",
    "Find",
    "Search",
    "Web",
    "Agent",
    "Load skill",
    "Update plan",
    "Present plan",
    "Stop command",
];

fn command_text<'a>(
    title: &'a str,
    detail: &'a Option<Box<falcondeck_core::ToolCallDetail>>,
) -> Option<&'a str> {
    match detail.as_deref() {
        Some(falcondeck_core::ToolCallDetail::CommandExecution { command, .. }) => Some(command),
        Some(_) => None,
        None => (!title.contains(" · ")
            && !NON_COMMAND_TITLES.iter().any(|p| title.starts_with(p)))
        .then_some(title),
    }
}

fn edited_path(title: &str) -> Option<&str> {
    ["Edit notebook ", "Edit ", "Write "]
        .iter()
        .find_map(|prefix| title.strip_prefix(prefix))
        .map(str::trim)
        .filter(|path| !path.is_empty())
}

fn outcome(status: &str, exit_code: Option<i32>) -> &'static str {
    match exit_code {
        Some(0) => "passed",
        Some(_) => "failed",
        None => match status.to_ascii_lowercase().as_str() {
            "failed" | "error" | "errored" | "declined" => "failed",
            "running" | "in_progress" | "inprogress" | "pending" => "running",
            "completed" | "complete" | "success" | "succeeded" | "done" => "ok",
            _ => "unknown",
        },
    }
}

fn relative<'a>(path: &'a str, root: &str) -> &'a str {
    path.strip_prefix(root)
        .and_then(|rest| rest.strip_prefix('/'))
        .unwrap_or(path)
}

impl Digest {
    fn push_file(&mut self, path: String) {
        if !self.files.contains(&path) {
            self.files.push(path);
        }
    }

    fn record_check(
        &mut self,
        kind: CheckKind,
        command: &str,
        outcome: &'static str,
        at: DateTime<Utc>,
    ) {
        // Newest-first scan: the first sighting is the latest run.
        if let Some((_, check)) = self.checks.iter_mut().find(|(k, _)| *k == kind) {
            check.runs += 1;
        } else {
            self.checks.push((
                kind,
                Check {
                    command: line(command, 100),
                    outcome,
                    at,
                    runs: 1,
                },
            ));
        }
    }
}

/// Scan newest-first, at most `SCAN_ITEMS`, stopping at `since` when given.
fn digest(items: &[ConversationItem], since: Option<DateTime<Utc>>, root: &str) -> Digest {
    let mut d = Digest {
        complete: true,
        last_item_at: items.last().map(item_created_at),
        ..Default::default()
    };
    for item in items.iter().rev() {
        let at = item_created_at(item);
        if since.is_some_and(|since| at <= since) {
            break;
        }
        if d.scanned == SCAN_ITEMS {
            d.complete = false;
            break;
        }
        d.scanned += 1;
        let in_latest_turn = d.last_user.is_none();
        match item {
            ConversationItem::UserMessage { id, text, .. } => {
                d.user_messages += 1;
                if d.last_user.is_none() {
                    d.last_user = Some(Message {
                        id: id.clone(),
                        text: text.clone(),
                        at,
                    });
                }
            }
            ConversationItem::AssistantMessage { id, text, .. } if !text.trim().is_empty() => {
                d.assistant_messages += 1;
                if d.last_assistant.is_none() {
                    d.last_assistant = Some(Message {
                        id: id.clone(),
                        text: text.clone(),
                        at,
                    });
                }
            }
            ConversationItem::FileChange {
                changes, status, ..
            } => {
                if outcome(status, None) != "failed" {
                    for change in changes {
                        let path = relative(&change.path, root);
                        d.push_file(match &change.move_path {
                            Some(dest) => format!("{path} -> {}", relative(dest, root)),
                            None => path.to_string(),
                        });
                    }
                }
            }
            ConversationItem::ToolCall {
                title,
                status,
                exit_code,
                output,
                detail,
                ..
            } => {
                let result = outcome(status, *exit_code);
                if result == "failed" && in_latest_turn {
                    d.failed_tools += 1;
                    d.last_failure.get_or_insert_with(|| line(title, 120));
                }
                if result != "failed"
                    && let Some(path) = edited_path(title)
                {
                    d.push_file(relative(path, root).to_string());
                }
                if title.to_ascii_lowercase().contains("autoreview") {
                    d.record_check(CheckKind::Autoreview, title, result, at);
                    continue;
                }
                let Some(command) = command_text(title, detail) else {
                    continue;
                };
                let lower = command.to_ascii_lowercase();
                if lower.contains("autoreview") {
                    d.record_check(CheckKind::Autoreview, command, result, at);
                } else if TEST_COMMAND.is_match(&lower) {
                    d.record_check(CheckKind::Tests, command, result, at);
                } else if TYPECHECK_COMMAND.is_match(&lower) {
                    d.record_check(CheckKind::Typecheck, command, result, at);
                }
                if lower.contains("commit")
                    && let Some(output) = output
                {
                    let mut end = output.len().min(COMMIT_SCAN_BYTES);
                    while !output.is_char_boundary(end) {
                        end -= 1;
                    }
                    for found in COMMIT_LINE.captures_iter(&output[..end]) {
                        let sha = found[1].to_string();
                        if !d.commits.iter().any(|(s, _)| *s == sha) {
                            d.commits.push((sha, line(&found[2], 120)));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    d
}

struct Snapshot {
    summary: ThreadSummary,
    root: String,
    digest: Option<Digest>,
}

impl AppState {
    /// Digests from in-memory items only; `None` when nothing is loaded.
    async fn snapshots(
        &self,
        workspace: &str,
        ids: &[String],
        since: Option<DateTime<Utc>>,
    ) -> Result<Vec<Snapshot>, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let ws = workspaces
            .get(workspace)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
        ids.iter()
            .map(|id| {
                let thread = ws.threads.get(id).ok_or_else(|| {
                    DaemonError::NotFound(format!("thread not found: {}", line(id, 128)))
                })?;
                let root = thread
                    .summary
                    .working_directory(&ws.summary.path)
                    .to_string();
                Ok(Snapshot {
                    digest: (!thread.items.is_empty()).then(|| digest(&thread.items, since, &root)),
                    summary: thread.summary.clone(),
                    root,
                })
            })
            .collect()
    }

    fn cached_recent_user(&self, summary: &ThreadSummary) -> Option<String> {
        let index = self
            .inner
            .thread_search
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        summary
            .native_session_id
            .as_ref()
            .and_then(|id| index.sessions.get(id))
            .and_then(|excerpt| excerpt.recent.last().cloned())
    }
}

pub(super) async fn summary(
    app: &AppState,
    workspace: &str,
    args: &SummaryArgs,
) -> Result<String, DaemonError> {
    let mut ids: Vec<String> = args.thread_id.iter().cloned().collect();
    for id in &args.thread_ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() || ids.len() > MAX_IDS || ids.iter().any(|id| id.trim().is_empty()) {
        return Err(DaemonError::BadRequest(format!(
            "pass 1–{MAX_IDS} nonempty thread ids in thread_id or thread_ids"
        )));
    }
    let cap = args
        .max_chars
        .unwrap_or(DEFAULT_SUMMARY_CHARS)
        .clamp(512, MAX_CHARS);
    let mut snapshots = app.snapshots(workspace, &ids, None).await?;
    if args.hydrate {
        for snapshot in snapshots
            .iter_mut()
            .filter(|s| s.digest.is_none() && s.summary.native_session_id.is_some())
            .take(HYDRATE_THREADS)
        {
            let detail = app
                .thread_detail_with_request(&ThreadDetailRequest {
                    workspace_id: workspace.into(),
                    thread_id: snapshot.summary.id.clone(),
                    mode: ThreadDetailMode::Tail,
                    limit: Some(200),
                    before_item_id: None,
                    inline_images: Some(false),
                    tool_output_bytes: Some(COMMIT_SCAN_BYTES),
                    strict_limit: Some(true),
                    compact_workspace: Some(true),
                    refresh_native: None,
                })
                .await?;
            if !detail.items.is_empty() {
                let mut d = digest(&detail.items, None, &snapshot.root);
                d.complete &= !detail.has_older;
                snapshot.digest = Some(d);
            }
        }
    }
    let mut pending = app.pending_requests(workspace).await;
    let now = Utc::now();
    let per_thread = (cap.saturating_sub(200) / ids.len()).max(400);
    let mut markdown = format!("# Thread summaries\n\nNow: {}\n\n", stamp(now));
    let mut omitted = Vec::new();
    for snapshot in snapshots {
        let summary = app.build_thread_summary_from_clone(snapshot.summary).await;
        let requests = pending.remove(&summary.id).unwrap_or_default();
        let entry = capped(
            &render_summary(app, &summary, &requests, snapshot.digest.as_ref(), now),
            per_thread,
        );
        if markdown.chars().count() + entry.chars().count() + 120 > cap {
            omitted.push(line(&summary.id, 128));
            continue;
        }
        markdown.push_str(&entry);
        markdown.push_str("\n\n");
    }
    if !omitted.is_empty() {
        markdown.push_str(&format!(
            "Omitted for max_chars: {}. Request them separately.\n",
            omitted.join(", ")
        ));
    }
    Ok(capped(&markdown, cap))
}

fn render_summary(
    app: &AppState,
    summary: &ThreadSummary,
    pending: &[InteractiveRequest],
    digest: Option<&Digest>,
    now: DateTime<Utc>,
) -> String {
    let mut text = format!(
        "## {}\n\n- Id: {} | Provider: {}{}\n",
        line(&summary.title, 200),
        line(&summary.id, 128),
        summary.provider,
        summary
            .agent
            .model_id
            .as_deref()
            .map(|m| format!(" | Model: {}", line(m, 80)))
            .unwrap_or_default()
    );
    if let Some(flag) = attention(summary, pending) {
        text.push_str(&format!("- {flag}\n"));
    }
    let last_activity = digest
        .and_then(|d| d.last_item_at)
        .map_or(summary.updated_at, |at| at.max(summary.updated_at));
    text.push_str(&format!(
        "- Status: {}{} | Last activity: {} ({})\n",
        status_name(&summary.status),
        summary
            .latest_turn_id
            .as_deref()
            .map(|t| format!(" | Latest turn: {}", line(t, 80)))
            .unwrap_or_default(),
        stamp(last_activity),
        ago(last_activity, now)
    ));
    let mut extras = Vec::new();
    if !summary.queued_turns.is_empty() {
        extras.push(format!("Queued turns: {}", summary.queued_turns.len()));
    }
    if summary.attention.background_task_count > 0 {
        extras.push(format!(
            "Background tasks: {}",
            summary.attention.background_task_count
        ));
    }
    if summary.is_archived {
        extras.push("Archived".into());
    }
    if !extras.is_empty() {
        text.push_str(&format!("- {}\n", extras.join(" | ")));
    }
    if let Some(goal) = &summary.goal {
        text.push_str(&format!("- Goal: {}\n", line(&goal.objective, 200)));
    }
    let Some(d) = digest else {
        if let Some(user) = app.cached_recent_user(summary) {
            text.push_str(&format!(
                "- Last user request (cached): {}\n",
                line(&user, 300)
            ));
        }
        if let Some(preview) = &summary.last_message_preview {
            text.push_str(&format!("- Last preview: {}\n", line(preview, 400)));
        }
        if let Some(error) = &summary.last_error {
            text.push_str(&format!("- Error: {}\n", line(error, 300)));
        }
        text.push_str("- Transcript: not loaded; pass hydrate=true or use falcondeck_view_thread for outcome, files, commits, and checks.\n");
        return text;
    };
    if let Some(user) = &d.last_user {
        text.push_str(&format!(
            "- Last user request ({}, {}): {}\n",
            stamp(user.at),
            line(&user.id, 80),
            line(&user.text, 300)
        ));
    }
    match &d.last_assistant {
        Some(reply) => {
            let stale = d.last_user.as_ref().is_some_and(|u| u.at > reply.at);
            text.push_str(&format!(
                "- Last assistant outcome ({}, {}){}: {}\n",
                stamp(reply.at),
                line(&reply.id, 80),
                if stale {
                    " [before the latest request]"
                } else {
                    ""
                },
                line(&reply.text, 600)
            ));
        }
        None => text.push_str("- Last assistant outcome: none in scanned items\n"),
    }
    text.push_str(&files_line(&d.files));
    text.push_str(&commits_line(&d.commits));
    text.push_str(&format!("- Checks: {}\n", checks_line(&d.checks)));
    let mut errors = Vec::new();
    if let Some(error) = &summary.last_error {
        errors.push(line(error, 300));
    }
    if d.failed_tools > 0 {
        errors.push(format!(
            "{} failed tool call(s) in the latest turn (last: {})",
            d.failed_tools,
            d.last_failure.as_deref().unwrap_or("")
        ));
    }
    if !errors.is_empty() {
        text.push_str(&format!("- Errors: {}\n", errors.join("; ")));
    }
    text.push_str(&format!(
        "- Transcript: scanned {} items ({}).\n",
        d.scanned,
        if d.complete {
            "complete"
        } else {
            "newest only; older history not scanned"
        }
    ));
    text
}

fn files_line(files: &[String]) -> String {
    if files.is_empty() {
        return "- Files changed: none seen\n".into();
    }
    let shown: Vec<_> = files.iter().take(12).map(|f| line(f, 160)).collect();
    format!(
        "- Files changed ({}): {}{}\n",
        files.len(),
        shown.join(", "),
        if files.len() > shown.len() {
            format!(", +{} more", files.len() - shown.len())
        } else {
            String::new()
        }
    )
}

fn commits_line(commits: &[(String, String)]) -> String {
    if commits.is_empty() {
        return "- Commits: none seen\n".into();
    }
    let shown: Vec<_> = commits
        .iter()
        .take(6)
        .map(|(sha, subject)| format!("{sha} {subject}"))
        .collect();
    format!(
        "- Commits ({}): {}{}\n",
        commits.len(),
        shown.join("; "),
        if commits.len() > shown.len() {
            format!("; +{} more", commits.len() - shown.len())
        } else {
            String::new()
        }
    )
}

fn checks_line(checks: &[(CheckKind, Check)]) -> String {
    [
        (CheckKind::Tests, "tests"),
        (CheckKind::Typecheck, "typecheck"),
        (CheckKind::Autoreview, "autoreview"),
    ]
    .iter()
    .map(
        |(kind, label)| match checks.iter().find(|(k, _)| k == kind) {
            Some((_, check)) => format!(
                "{label} {} at {} (`{}`{})",
                check.outcome,
                stamp(check.at),
                check.command.replace('`', "'"),
                if check.runs > 1 {
                    format!(", {} runs", check.runs)
                } else {
                    String::new()
                }
            ),
            None => format!("{label} not seen"),
        },
    )
    .collect::<Vec<_>>()
    .join("; ")
}

fn delta(d: &Digest) -> String {
    let mut parts = Vec::new();
    for (count, label) in [
        (d.user_messages, "user msg"),
        (d.assistant_messages, "assistant msg"),
        (d.files.len(), "file"),
        (d.commits.len(), "commit"),
    ] {
        if count > 0 {
            parts.push(format!(
                "{count} {label}{}",
                if count == 1 { "" } else { "s" }
            ));
        }
    }
    for (kind, check) in &d.checks {
        let label = match kind {
            CheckKind::Tests => "tests",
            CheckKind::Typecheck => "typecheck",
            CheckKind::Autoreview => "autoreview",
        };
        parts.push(format!("{label} {}", check.outcome));
    }
    if d.failed_tools > 0 {
        parts.push(format!("{} failed tool(s)", d.failed_tools));
    }
    let mut text = if parts.is_empty() {
        "activity".to_string()
    } else {
        parts.join(", ")
    };
    if let Some(reply) = &d.last_assistant {
        text.push_str(&format!("; last reply: {}", line(&reply.text, 160)));
    } else if let Some(user) = &d.last_user {
        text.push_str(&format!("; last request: {}", line(&user.text, 160)));
    }
    text
}

pub(super) async fn changes(
    app: &AppState,
    workspace: &str,
    caller: &str,
    args: &ChangesArgs,
) -> Result<String, DaemonError> {
    let now = Utc::now();
    let since = parse_since(&args.since, now)?;
    let cap = args
        .max_chars
        .unwrap_or(DEFAULT_CHANGES_CHARS)
        .clamp(512, MAX_CHARS);
    let limit = args.limit.unwrap_or(30).clamp(1, 100);
    let mut pending = app.pending_requests(workspace).await;
    let (ids, total) = {
        let workspaces = app.inner.workspaces.lock().await;
        let ws = workspaces
            .get(workspace)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
        let ids: Vec<String> = ws
            .threads
            .values()
            .filter(|t| t.summary.id != caller && (args.include_archived || !t.summary.is_archived))
            .filter(|t| {
                t.summary.updated_at > since
                    || t.items.last().is_some_and(|i| item_created_at(i) > since)
                    || pending
                        .get(&t.summary.id)
                        .is_some_and(|r| r.iter().any(|r| r.created_at > since))
            })
            .map(|t| t.summary.id.clone())
            .collect();
        (ids, ws.threads.len())
    };
    let mut rows = Vec::new();
    for snapshot in app.snapshots(workspace, &ids, Some(since)).await? {
        let summary = app.build_thread_summary_from_clone(snapshot.summary).await;
        let requests = pending.remove(&summary.id).unwrap_or_default();
        let flag = attention(&summary, &requests);
        let last = snapshot
            .digest
            .as_ref()
            .and_then(|d| d.last_item_at)
            .map_or(summary.updated_at, |at| at.max(summary.updated_at));
        let change = match &snapshot.digest {
            Some(d) if d.scanned > 0 => delta(d),
            _ => format!(
                "updated{}",
                summary
                    .last_message_preview
                    .as_deref()
                    .map(|p| format!("; preview: {}", line(p, 160)))
                    .unwrap_or_default()
            ),
        };
        let row = format!(
            "- {}{} (`{}`) — {}, {} ({}): {}",
            flag.as_deref()
                .map(|f| format!("**{}** ", line(f, 200)))
                .unwrap_or_default(),
            line(&summary.title, 120),
            line(&summary.id, 128),
            status_name(&summary.status),
            stamp(last),
            ago(last, now),
            change
        );
        rows.push((flag.is_some(), last, row));
    }
    // Blocked threads first, then most recent.
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let changed = rows.len();
    let mut markdown = format!(
        "# Thread changes since {}\n\nNow: {} (pass as since next time)\nChanged: {changed} of {} threads, excluding this thread{}.\n\n",
        stamp(since),
        // Exact, so a follow-up window neither repeats nor skips this instant.
        now.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
        total.saturating_sub(1),
        if args.include_archived {
            ""
        } else {
            " and archived threads"
        }
    );
    let mut shown = 0;
    for (_, _, row) in rows.iter().take(limit) {
        if markdown.chars().count() + row.chars().count() + 120 > cap {
            break;
        }
        markdown.push_str(row);
        markdown.push('\n');
        shown += 1;
    }
    if changed == 0 {
        markdown.push_str("No thread activity in this window.\n");
    } else if shown < changed {
        markdown.push_str(&format!(
            "\nShown {shown} of {changed}. Raise limit/max_chars or narrow since.\n"
        ));
    }
    markdown.push_str("Use falcondeck_thread_summary for detail.\n");
    Ok(capped(&markdown, cap))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn since_accepts_rfc3339_and_relative_windows() {
        let now = DateTime::parse_from_rfc3339("2026-10-16T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            stamp(parse_since("15m", now).unwrap()),
            "2026-10-16T11:45:00Z"
        );
        assert_eq!(
            stamp(parse_since("2h", now).unwrap()),
            "2026-10-16T10:00:00Z"
        );
        assert_eq!(
            stamp(parse_since("2026-10-16T09:30:00+01:00", now).unwrap()),
            "2026-10-16T08:30:00Z"
        );
        for bad in ["", "m", "15", "15w", "-1h", "999999d", "yesterday"] {
            assert!(parse_since(bad, now).is_err(), "{bad}");
        }
    }

    #[test]
    fn commands_classify_checks_without_matching_file_tools() {
        assert_eq!(
            command_text("cargo test -p x", &None),
            Some("cargo test -p x")
        );
        assert_eq!(command_text("Search cargo test", &None), None);
        assert_eq!(command_text("Gmail · search", &None), None);
        assert!(TEST_COMMAND.is_match("npm run test -- --run"));
        assert!(TEST_COMMAND.is_match("cd x && npx vitest run"));
        assert!(!TEST_COMMAND.is_match("cat latest.txt"));
        assert!(TYPECHECK_COMMAND.is_match("npx tsc --noemit -p apps/desktop"));
        assert_eq!(edited_path("Edit src/a.rs"), Some("src/a.rs"));
        assert_eq!(edited_path("Editorial"), None);
        let found: Vec<_> = COMMIT_LINE
            .captures_iter("[main 2896d18] Add Chrome action\n 1 file changed\n[main (root-commit) abc1234] Init")
            .map(|c| (c[1].to_string(), c[2].to_string()))
            .collect();
        assert_eq!(
            found,
            vec![
                ("2896d18".into(), "Add Chrome action".into()),
                ("abc1234".into(), "Init".into())
            ]
        );
    }
}
