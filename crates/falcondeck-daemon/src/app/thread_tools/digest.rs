//! Cheap structured digests and change feeds for coordinating agents.
//!
//! Digests read the daemon summary, pending interactive requests, and items
//! already in memory. Native transcripts load only with `hydrate: true`.
use super::glance::{self, Glance, RowContext, ago};
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

    /// Title line, state, and any attention for one thread.
    pub(super) async fn thread_status_lines(
        &self,
        workspace: &str,
        thread: &str,
    ) -> Result<String, DaemonError> {
        let summary = self
            .build_thread_summary_from_clone(self.thread_summary(workspace, thread).await?)
            .await;
        let pending = self
            .pending_requests(workspace)
            .await
            .remove(thread)
            .unwrap_or_default();
        let mut text = format!(
            "# {} `{}`\n{} · {} · {}\n",
            line(&summary.title, 160),
            line(&summary.id, 128),
            glance::state(&summary),
            ago(summary.updated_at, Utc::now()),
            summary.provider,
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
    runs: usize,
}

struct Message {
    id: String,
    text: String,
    /// Scan position, newest first. Codex items can share one fallback
    /// timestamp, so order comes from the transcript, not the clock.
    pos: usize,
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
/// Commit output from a command we cannot see (Codex code-mode `exec`): the
/// stat line that follows rules out a quoted `[main abc1234]` in a file read.
static COMMIT_WITH_STAT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?m)^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)\n \d+ files? changed",
    )
    .unwrap()
});
/// Test runner summaries, for commands hidden inside scripts.
static TEST_RESULT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?m)^(?:test result: (ok|FAILED)\.|\s*Test Files\s+.*?(failed|passed))")
        .unwrap()
});
/// The script's own report, not a file that quotes it.
static AUTOREVIEW_RESULT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?m)^autoreview target: ").unwrap());
static SHELL_WRAPPER: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?s)^(?:\S*/)?(?:ba|z)?sh\s+-l?c\s+(?:'(.*)'|"(.*)")\s*$"#).unwrap()
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

/// The command inside `zsh -lc '...'` (how Codex reports shell calls),
/// without a leading `cd <dir> &&`.
fn unwrap_shell(command: &str) -> &str {
    let inner = SHELL_WRAPPER
        .captures(command.trim())
        .and_then(|c| c.get(1).or(c.get(2)))
        .map_or(command, |m| m.as_str())
        .trim_start();
    match inner
        .strip_prefix("cd ")
        .and_then(|rest| rest.split_once("&& "))
    {
        Some((dir, rest)) if !dir.contains([';', '|', '&']) => rest.trim_start(),
        _ => inner,
    }
}

/// Short label for a check: the matched command when it is not near the start.
fn check_label(command: &str, at: usize) -> String {
    if at < 40 {
        line(command, 80)
    } else {
        format!("…{}", line(&command[at..], 80))
    }
}

/// Outputs of the scripts a Codex code-mode `exec` call ran, one per JSON
/// line, with each script's exit code.
fn exec_outputs(output: &str) -> Vec<(String, Option<i32>)> {
    output
        .lines()
        .filter(|l| l.starts_with("{\"i\":"))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| {
            let value = v.get("value")?;
            Some((
                value.get("output")?.as_str()?.to_string(),
                value
                    .get("exit_code")
                    .and_then(Value::as_i64)
                    .and_then(|c| i32::try_from(c).ok()),
            ))
        })
        .collect()
}

/// Autoreview exits 0 with findings; its report says which.
fn autoreview_outcome(output: Option<&str>, result: &'static str) -> &'static str {
    match output {
        Some(o) if o.contains("autoreview clean") => "passed",
        Some(o) if o.contains("autoreview findings:") => "found issues",
        _ => result,
    }
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

    fn record_check(&mut self, kind: CheckKind, label: String, outcome: &'static str) {
        // Newest-first scan: the first sighting is the latest run.
        if let Some((_, check)) = self.checks.iter_mut().find(|(k, _)| *k == kind) {
            check.runs += 1;
        } else {
            self.checks.push((
                kind,
                Check {
                    command: label,
                    outcome,
                    runs: 1,
                },
            ));
        }
    }

    fn record_commits(&mut self, pattern: &regex::Regex, output: &str) {
        let mut end = output.len().min(COMMIT_SCAN_BYTES);
        while !output.is_char_boundary(end) {
            end -= 1;
        }
        for found in pattern.captures_iter(&output[..end]) {
            let sha = found[1].to_string();
            if !self.commits.iter().any(|(s, _)| *s == sha) {
                self.commits.push((sha, line(&found[2], 120)));
            }
        }
    }

    /// Checks and commits visible only in output, for commands we cannot read.
    fn record_from_output(&mut self, label: &str, output: &str, result: &'static str) {
        // Cargo prints one summary per test binary; any failure fails the run.
        let summaries: Vec<_> = TEST_RESULT
            .captures_iter(output)
            .filter_map(|c| c.get(1).or(c.get(2)))
            .map(|m| m.as_str())
            .collect();
        if !summaries.is_empty() {
            let outcome =
                if result == "failed" || summaries.iter().any(|s| *s != "ok" && *s != "passed") {
                    "failed"
                } else if result == "running" {
                    "running"
                } else {
                    "passed"
                };
            self.record_check(CheckKind::Tests, line(label, 80), outcome);
        }
        if AUTOREVIEW_RESULT.is_match(output) {
            let outcome = autoreview_outcome(Some(output), result);
            self.record_check(CheckKind::Autoreview, line(label, 80), outcome);
        }
        self.record_commits(&COMMIT_WITH_STAT, output);
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
        if since.is_some_and(|since| item_created_at(item) <= since) {
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
                        pos: d.scanned,
                    });
                }
            }
            ConversationItem::AssistantMessage { id, text, .. } if !text.trim().is_empty() => {
                d.assistant_messages += 1;
                if d.last_assistant.is_none() {
                    d.last_assistant = Some(Message {
                        id: id.clone(),
                        text: text.clone(),
                        pos: d.scanned,
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
                let Some(command) = command_text(title, detail) else {
                    if title.to_ascii_lowercase().contains("autoreview") {
                        let outcome = autoreview_outcome(output.as_deref(), result);
                        d.record_check(CheckKind::Autoreview, line(title, 80), outcome);
                    }
                    continue;
                };
                let command = unwrap_shell(command);
                let lower = command.to_ascii_lowercase();
                if let Some(at) = lower.find("autoreview") {
                    let outcome = autoreview_outcome(output.as_deref(), result);
                    d.record_check(CheckKind::Autoreview, check_label(command, at), outcome);
                } else if let Some(found) = TEST_COMMAND.find(&lower) {
                    d.record_check(
                        CheckKind::Tests,
                        check_label(command, found.start()),
                        result,
                    );
                } else if let Some(found) = TYPECHECK_COMMAND.find(&lower) {
                    d.record_check(
                        CheckKind::Typecheck,
                        check_label(command, found.start()),
                        result,
                    );
                } else if let Some(output) = output {
                    let scripts = exec_outputs(output);
                    if scripts.is_empty() {
                        d.record_from_output(command, output, result);
                    }
                    // Newest first, like the item scan, so the latest script wins.
                    for (script, code) in scripts.into_iter().rev() {
                        d.record_from_output(command, &script, outcome(status, code));
                    }
                }
                if lower.contains("commit")
                    && let Some(output) = output
                {
                    d.record_commits(&COMMIT_LINE, output);
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
    glance: Glance,
    digest: Option<Digest>,
    hydrate_error: Option<String>,
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
        let index = self
            .inner
            .thread_search
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        ids.iter()
            .map(|id| {
                let thread = ws.threads.get(id).ok_or_else(|| {
                    DaemonError::NotFound(format!("thread not found: {}", line(id, 128)))
                })?;
                let root = thread
                    .summary
                    .working_directory(&ws.summary.path)
                    .to_string();
                let excerpt = thread
                    .summary
                    .native_session_id
                    .as_ref()
                    .and_then(|session| index.sessions.get(session));
                Ok(Snapshot {
                    digest: (!thread.items.is_empty()).then(|| digest(&thread.items, since, &root)),
                    glance: Glance::of(thread, excerpt),
                    summary: thread.summary.clone(),
                    root,
                    hydrate_error: None,
                })
            })
            .collect()
    }
}

/// `cross_project` resolves each id's own workspace, for bots holding ids
/// from an all-project list.
pub(super) async fn summary(
    app: &AppState,
    workspace: &str,
    cross_project: bool,
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
    app.refresh_excerpts().await;
    let mut snapshots = Vec::with_capacity(ids.len());
    for id in &ids {
        let owner = if cross_project {
            app.thread_workspace(id).await?
        } else {
            workspace.to_string()
        };
        snapshots.extend(
            app.snapshots(&owner, std::slice::from_ref(id), None)
                .await?,
        );
    }
    if args.hydrate {
        for snapshot in snapshots
            .iter_mut()
            .filter(|s| s.digest.is_none() && s.summary.native_session_id.is_some())
            .take(HYDRATE_THREADS)
        {
            let detail = app
                .thread_detail_with_request(&ThreadDetailRequest {
                    workspace_id: snapshot.summary.workspace_id.clone(),
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
                .await;
            // One unreadable native session must not hide the other digests.
            match detail {
                Ok(detail) if !detail.items.is_empty() => {
                    let mut d = digest(&detail.items, None, &snapshot.root);
                    d.complete &= !detail.has_older;
                    snapshot.digest = Some(d);
                }
                Ok(_) => {}
                Err(error) => snapshot.hydrate_error = Some(line(&error.to_string(), 200)),
            }
        }
    }
    let mut pending = HashMap::new();
    for snapshot in &snapshots {
        let owner = &snapshot.summary.workspace_id;
        if !pending.contains_key(owner) {
            pending.insert(owner.clone(), app.pending_requests(owner).await);
        }
    }
    let now = Utc::now();
    let per_thread = (cap.saturating_sub(200) / ids.len()).max(400);
    let mut markdown = String::new();
    let mut omitted = Vec::new();
    for snapshot in snapshots {
        let summary = app.build_thread_summary_from_clone(snapshot.summary).await;
        let requests = pending
            .get_mut(&summary.workspace_id)
            .and_then(|requests| requests.remove(&summary.id))
            .unwrap_or_default();
        let entry = capped(
            &render_summary(
                &summary,
                &requests,
                &snapshot.glance,
                snapshot.digest.as_ref(),
                snapshot.hydrate_error.as_deref(),
                now,
            ),
            per_thread,
        );
        if markdown.chars().count() + entry.chars().count() + 120 > cap {
            omitted.push(line(&summary.id, 128));
            continue;
        }
        markdown.push_str(&entry);
        markdown.push('\n');
    }
    if !omitted.is_empty() {
        markdown.push_str(&format!(
            "Omitted for max_chars: {}. Request them separately.\n",
            omitted.join(", ")
        ));
    }
    Ok(capped(&markdown, cap))
}

/// `text` capped at `cap`, pointing at the item to expand when cut.
fn message_line(text: &str, id: &str, cap: usize) -> String {
    let shown = line(text, cap);
    if text.chars().count() > cap {
        format!("{shown} (expand: item_id={})", line(id, 128))
    } else {
        shown
    }
}

fn render_summary(
    summary: &ThreadSummary,
    pending: &[InteractiveRequest],
    glance: &Glance,
    digest: Option<&Digest>,
    hydrate_error: Option<&str>,
    now: DateTime<Utc>,
) -> String {
    let last_activity = digest
        .and_then(|d| d.last_item_at)
        .map_or(summary.updated_at, |at| at.max(summary.updated_at));
    let mut facts = vec![
        glance::state(summary),
        ago(last_activity, now),
        match summary.agent.model_id.as_deref() {
            Some(model) => format!("{} {}", summary.provider, line(model, 60)),
            None => summary.provider.to_string(),
        },
    ];
    if !summary.queued_turns.is_empty() {
        facts.push(format!("{} queued", summary.queued_turns.len()));
    }
    if summary.attention.background_task_count > 0 {
        facts.push(format!(
            "{} background",
            summary.attention.background_task_count
        ));
    }
    if summary.is_archived {
        facts.push("archived".into());
    }
    let mut text = format!(
        "## {} `{}`\n- {}\n",
        line(&summary.title, 160),
        line(&summary.id, 128),
        facts.join(" · ")
    );
    if let Some(flag) = attention(summary, pending) {
        text.push_str(&format!("- {flag}\n"));
    }
    if let Some(goal) = &summary.goal {
        text.push_str(&format!("- Goal: {}\n", line(&goal.objective, 200)));
    }
    let Some(d) = digest else {
        if let Some(asked) = &glance.asked {
            text.push_str(&format!("- Asked: {}\n", line(asked, 300)));
        }
        if let Some(latest) = &glance.latest {
            text.push_str(&format!("- Latest: {}\n", line(latest, 600)));
        }
        if let Some(error) = &summary.last_error {
            text.push_str(&format!("- Error: {}\n", line(error, 300)));
        }
        match hydrate_error {
            Some(error) => text.push_str(&format!("- Transcript could not load: {error}\n")),
            None => text.push_str(
                "- Transcript not loaded; hydrate=true adds files, commits, and checks.\n",
            ),
        }
        return text;
    };
    if let Some(user) = &d.last_user {
        text.push_str(&format!(
            "- Asked: {}\n",
            message_line(&user.text, &user.id, 300)
        ));
    }
    match &d.last_assistant {
        Some(reply) => {
            let stale = d.last_user.as_ref().is_some_and(|u| u.pos < reply.pos);
            text.push_str(&format!(
                "- Latest{}: {}\n",
                if stale { " (before that request)" } else { "" },
                message_line(&reply.text, &reply.id, 600)
            ));
        }
        None => text.push_str("- Latest: no reply in scanned items\n"),
    }
    if d.files.is_empty() && d.commits.is_empty() && d.checks.is_empty() {
        text.push_str("- No file edits, commits, or checks seen.\n");
    } else {
        text.push_str(&files_line(&d.files));
        text.push_str(&commits_line(&d.commits));
        text.push_str(&checks_line(&d.checks));
    }
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
    if !d.complete {
        text.push_str(&format!("- Scanned the newest {} items only.\n", d.scanned));
    }
    text
}

fn files_line(files: &[String]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let shown: Vec<_> = files.iter().take(12).map(|f| line(f, 160)).collect();
    format!(
        "- Files ({}): {}{}\n",
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
        return String::new();
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

fn check_name(kind: CheckKind) -> &'static str {
    match kind {
        CheckKind::Tests => "tests",
        CheckKind::Typecheck => "typecheck",
        CheckKind::Autoreview => "autoreview",
    }
}

/// Latest outcome per check kind, in a fixed order.
fn checks_line(checks: &[(CheckKind, Check)]) -> String {
    let parts: Vec<_> = [
        CheckKind::Tests,
        CheckKind::Typecheck,
        CheckKind::Autoreview,
    ]
    .into_iter()
    .filter_map(|kind| {
        let (_, check) = checks.iter().find(|(k, _)| *k == kind)?;
        Some(format!(
            "{} {}{} (`{}`)",
            check_name(kind),
            check.outcome,
            if check.runs > 1 {
                format!(", {} runs", check.runs)
            } else {
                String::new()
            },
            check.command.replace('`', "'"),
        ))
    })
    .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("- Checks: {}\n", parts.join("; "))
    }
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
        parts.push(format!("{} {}", check_name(*kind), check.outcome));
    }
    if d.failed_tools > 0 {
        parts.push(format!("{} failed tool(s)", d.failed_tools));
    }
    if parts.is_empty() {
        "Since: activity".into()
    } else {
        format!("Since: {}", parts.join(", "))
    }
}

pub(super) async fn changes(
    app: &AppState,
    scope: &[String],
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
    let multi = scope.len() > 1;
    app.refresh_excerpts().await;
    let (mut rows, mut total) = (Vec::new(), 0);
    for workspace in scope {
        let mut pending = app.pending_requests(workspace).await;
        let (project, ids, count) = {
            let workspaces = app.inner.workspaces.lock().await;
            let ws = workspaces
                .get(workspace)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
            let ids: Vec<String> = ws
                .threads
                .values()
                .filter(|t| {
                    t.summary.id != caller && (args.include_archived || !t.summary.is_archived)
                })
                .filter(|t| {
                    t.summary.updated_at > since
                        || t.items.last().is_some_and(|i| item_created_at(i) > since)
                        || pending
                            .get(&t.summary.id)
                            .is_some_and(|r| r.iter().any(|r| r.created_at > since))
                })
                .map(|t| t.summary.id.clone())
                .collect();
            let count = ws
                .threads
                .values()
                .filter(|t| {
                    t.summary.id != caller && (args.include_archived || !t.summary.is_archived)
                })
                .count();
            (
                glance::project_name(&ws.summary.path).to_string(),
                ids,
                count,
            )
        };
        total += count;
        for snapshot in app.snapshots(workspace, &ids, Some(since)).await? {
            let summary = app.build_thread_summary_from_clone(snapshot.summary).await;
            let requests = pending.remove(&summary.id).unwrap_or_default();
            let flag = attention(&summary, &requests);
            let last = snapshot
                .digest
                .as_ref()
                .and_then(|d| d.last_item_at)
                .map_or(summary.updated_at, |at| at.max(summary.updated_at));
            let mut extra = Vec::new();
            if let Some(flag) = &flag {
                extra.push(line(flag, 300));
            }
            if let Some(d) = snapshot.digest.as_ref().filter(|d| d.scanned > 0) {
                extra.push(delta(d));
            }
            let mut shown = summary.clone();
            shown.updated_at = last;
            let cx = RowContext {
                now,
                caller,
                project: multi.then_some(project.as_str()),
                folder: None,
                excerpts: true,
            };
            let row = glance::row(&shown, &snapshot.glance, &cx, &extra);
            rows.push((flag.is_some(), last, row));
        }
    }
    // Blocked threads first, then most recent.
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let changed = rows.len();
    let mut markdown = format!(
        "# Changes since {}\nNow: {} (pass as since next time)\n{changed} of {total} threads changed{}{}.\n\n",
        stamp(since),
        // Exact, so a follow-up window neither repeats nor skips this instant.
        now.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
        if multi {
            format!(" across {} projects", scope.len())
        } else {
            String::new()
        },
        if args.include_archived {
            ", not counting you"
        } else {
            ", not counting you or archived threads"
        }
    );
    let mut shown = 0;
    for (_, _, row) in rows.iter().take(limit) {
        if markdown.chars().count() + row.chars().count() + 120 > cap {
            break;
        }
        markdown.push_str(row);
        shown += 1;
    }
    if shown < changed {
        markdown.push_str(&format!(
            "\nShown {shown} of {changed}. Raise limit or max_chars, or narrow since.\n"
        ));
    }
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
    fn code_mode_exec_scripts_report_commits_and_tests() {
        let script = |i: usize, code: i32, output: &str| {
            json!({"i":i, "status":"fulfilled", "value":{"exit_code":code, "output":output}})
                .to_string()
        };
        let output = format!(
            "Script completed\nOutput:\n{}\n{}\n{}",
            script(
                0,
                0,
                "[main cb948cd1] Quiet notices\n 7 files changed, 9 insertions(+)\n"
            ),
            script(
                1,
                0,
                "running 55 tests\ntest result: ok. 55 passed; 0 failed\n"
            ),
            // A file that merely quotes commit output is not a commit.
            script(2, 0, "[main 2896d18] Add Chrome action\nfn main() {}\n"),
        );
        let rerun = format!(
            "{}\n{}\n{}",
            script(0, 0, "test result: ok. 3 passed\n"),
            script(
                1,
                101,
                "test result: ok. 1 passed\ntest result: FAILED. 0 passed; 1 failed\n"
            ),
            script(2, 0, "autoreview target: commit\nautoreview findings: 2\n"),
        );
        let items: Vec<ConversationItem> = vec![
            serde_json::from_value(json!({
                "kind":"tool_call", "id":"x1", "title":"exec", "tool_kind":"command",
                "status":"completed", "output":output, "created_at":Utc::now()
            }))
            .unwrap(),
            serde_json::from_value(json!({
                "kind":"tool_call", "id":"x2", "title":"/bin/zsh -lc 'npx tsc --noEmit'",
                "tool_kind":"command", "status":"completed", "exit_code":0, "created_at":Utc::now()
            }))
            .unwrap(),
        ];
        let d = digest(&items, None, "/repo");
        assert_eq!(
            d.commits,
            [("cb948cd1".to_string(), "Quiet notices".to_string())]
        );
        // The last script ran last; any failing binary fails the run.
        let failing: Vec<ConversationItem> = vec![
            serde_json::from_value(json!({
                "kind":"tool_call", "id":"x3", "title":"exec", "tool_kind":"command",
                "status":"completed", "output":rerun, "created_at":Utc::now()
            }))
            .unwrap(),
        ];
        let latest = checks_line(&digest(&failing, None, "/repo").checks);
        assert!(
            latest.contains("tests failed, 2 runs") && latest.contains("autoreview found issues"),
            "{latest}"
        );
        let line = checks_line(&d.checks);
        assert!(
            line.contains("tests passed (`exec`)")
                && line.contains("typecheck passed (`npx tsc --noEmit`)"),
            "{line}"
        );
        assert_eq!(unwrap_shell("bash -c \"cargo test\""), "cargo test");
        assert_eq!(unwrap_shell("cargo test"), "cargo test");
        assert_eq!(
            unwrap_shell("/bin/zsh -lc 'cd /repo && cargo test -p x'"),
            "cargo test -p x"
        );
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
