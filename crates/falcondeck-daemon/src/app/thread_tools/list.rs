//! Filtered, sorted, paged workspace thread listing for in-session coordinators.
//!
//! Reads daemon summaries, transcript items already in memory, and the cached
//! search-index excerpts. It never hydrates native history.
use super::*;
use chrono::{DateTime, Duration};
use std::path::Path;

const DEFAULT_LIMIT: usize = 30;
const PREVIEW_CHARS: usize = 300;
const EXCERPT_CHARS: usize = 240;

#[derive(Deserialize, Default, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Sort {
    #[default]
    #[serde(alias = "last_activity", alias = "updated_at")]
    Updated,
    #[serde(alias = "started", alias = "created_at")]
    Created,
    Title,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum Order {
    Asc,
    Desc,
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum Archived {
    #[default]
    Exclude,
    Include,
    Only,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Idle,
    Running,
    #[serde(alias = "waiting")]
    WaitingForInput,
    #[serde(alias = "failed")]
    Error,
    #[serde(alias = "waiting_approval", alias = "needs_approval")]
    AwaitingApproval,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OneOrMany<T> {
    One(T),
    Many(Vec<T>),
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(super) struct ListArgs {
    limit: Option<usize>,
    max_chars: Option<usize>,
    offset: Option<usize>,
    #[serde(default)]
    sort: Sort,
    order: Option<Order>,
    status: Option<OneOrMany<Status>>,
    provider: Option<String>,
    folder: Option<String>,
    #[serde(default)]
    archived: Archived,
    pinned: Option<bool>,
    has_pending_approval: Option<bool>,
    updated_since: Option<String>,
    updated_before: Option<String>,
    query: Option<String>,
}

pub(super) fn schema() -> Value {
    let status = json!({"type":"string", "enum":["idle","running","waiting_for_input","error","awaiting_approval"]});
    json!({
        "limit": {"type":"integer", "minimum":1, "maximum":100, "default":DEFAULT_LIMIT},
        "max_chars": {"type":"integer", "minimum":512, "maximum":24000, "default":24000},
        "offset": {"type":"integer", "minimum":0, "default":0, "description":"Skip this many matching threads. Follow the returned next offset; keep sort and filters unchanged."},
        "sort": {"type":"string", "enum":["updated","created","title"], "default":"updated", "description":"updated = last activity. created = native session start, best effort; unknown sorts last."},
        "order": {"type":"string", "enum":["asc","desc"], "description":"Defaults to desc for updated/created and asc for title."},
        "status": {"anyOf":[status, {"type":"array", "items":status, "minItems":1}], "description":"Match any. awaiting_approval = pending approvals or questions."},
        "provider": {"type":"string", "minLength":1, "description":"Provider id, e.g. claude or codex."},
        "folder": {"type":"string", "minLength":1, "description":"Project folder name or id (case-insensitive)."},
        "archived": {"type":"string", "enum":["exclude","include","only"], "default":"exclude"},
        "pinned": {"type":"boolean"},
        "has_pending_approval": {"type":"boolean"},
        "updated_since": {"type":"string", "description":"RFC 3339 timestamp, YYYY-MM-DD, or relative age like 30m, 24h, 7d, 2w."},
        "updated_before": {"type":"string", "description":"Same formats as updated_since."},
        "query": {"type":"string", "minLength":1, "maxLength":256, "description":"Case-insensitive literal match on title, id, previews, and cached user excerpts."}
    })
}

/// Everything one entry needs, captured without holding locks across awaits.
struct Row {
    summary: ThreadSummary,
    folder: Option<String>,
    /// Latest assistant then user text from items already in memory.
    memory_assistant: Option<String>,
    memory_user: Option<String>,
    memory_started: Option<DateTime<Utc>>,
    opening: Option<String>,
    recent: Option<String>,
    session_path: Option<PathBuf>,
    started: Option<DateTime<Utc>>,
}

impl Row {
    fn preview(&self) -> (&'static str, Option<&str>) {
        fn nonempty(text: &Option<String>) -> Option<&str> {
            text.as_deref().filter(|text| !text.trim().is_empty())
        }
        if let Some(text) = nonempty(&self.summary.last_message_preview) {
            ("Last preview", Some(text))
        } else if let Some(text) = nonempty(&self.memory_assistant) {
            ("Last assistant", Some(text))
        } else if let Some(text) = nonempty(&self.memory_user) {
            ("Last user", Some(text))
        } else if let Some(text) = nonempty(&self.recent) {
            ("Recent user", Some(text))
        } else if let Some(text) = nonempty(&self.opening) {
            ("Opening user", Some(text))
        } else {
            ("Last preview", None)
        }
    }

    fn matches_query(&self, needle: &str) -> bool {
        let summary = &self.summary;
        [
            Some(summary.title.as_str()),
            Some(summary.id.as_str()),
            summary.last_message_preview.as_deref(),
            self.memory_assistant.as_deref(),
            self.memory_user.as_deref(),
            self.opening.as_deref(),
            self.recent.as_deref(),
            summary.goal.as_ref().map(|g| g.objective.as_str()),
        ]
        .into_iter()
        .flatten()
        .any(|text| text.to_lowercase().contains(needle))
    }
}

fn bad(message: impl Into<String>) -> DaemonError {
    DaemonError::BadRequest(message.into())
}

/// Accepts RFC 3339, a bare UTC date, or a relative age (`90s`, `30m`, `24h`, `7d`, `2w`).
fn parse_time(field: &str, value: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, DaemonError> {
    let value = value.trim();
    if let Ok(time) = DateTime::parse_from_rfc3339(value) {
        return Ok(time.with_timezone(&Utc));
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Ok(date.and_hms_opt(0, 0, 0).unwrap().and_utc());
    }
    let relative = value.strip_suffix(" ago").unwrap_or(value);
    let split = relative.char_indices().last().map_or(0, |(i, _)| i);
    let (amount, unit) = relative.split_at(split);
    if let Ok(amount) = amount.trim().parse::<i64>() {
        let duration = match unit {
            "s" => Duration::try_seconds(amount),
            "m" => Duration::try_minutes(amount),
            "h" => Duration::try_hours(amount),
            "d" => Duration::try_days(amount),
            "w" => Duration::try_weeks(amount),
            _ => None,
        };
        if let Some(time) = duration
            .filter(|_| amount >= 0)
            .and_then(|duration| now.checked_sub_signed(duration))
        {
            return Ok(time);
        }
    }
    Err(bad(format!(
        "{field} must be an RFC 3339 timestamp, YYYY-MM-DD, or a relative age like 24h, 7d"
    )))
}

fn ago(time: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let seconds = (now - time).num_seconds().max(0);
    match seconds {
        0..60 => format!("{seconds}s ago"),
        60..3600 => format!("{}m ago", seconds / 60),
        3600..86_400 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

fn stamp(time: DateTime<Utc>, now: DateTime<Utc>) -> String {
    format!(
        "{} ({})",
        time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        ago(time, now)
    )
}

fn status_name(status: &ThreadStatus) -> &'static str {
    match status {
        ThreadStatus::Idle => "idle",
        ThreadStatus::Running => "running",
        ThreadStatus::WaitingForInput => "waiting_for_input",
        ThreadStatus::Error => "error",
    }
}

fn pending(summary: &ThreadSummary) -> bool {
    summary.attention.pending_approval_count > 0 || summary.attention.pending_question_count > 0
}

fn status_matches(summary: &ThreadSummary, status: Status) -> bool {
    match status {
        Status::Idle => summary.status == ThreadStatus::Idle,
        Status::Running => summary.status == ThreadStatus::Running,
        Status::WaitingForInput => summary.status == ThreadStatus::WaitingForInput,
        Status::Error => summary.status == ThreadStatus::Error,
        Status::AwaitingApproval => pending(summary),
    }
}

fn session_started(path: &Path) -> Option<DateTime<Utc>> {
    std::fs::metadata(path)
        .and_then(|meta| meta.created())
        .ok()
        .map(DateTime::<Utc>::from)
}

fn entry(row: &Row, now: DateTime<Utc>) -> String {
    let t = &row.summary;
    let mut text = format!(
        "## {}\n\n- Id: {} | Provider: {} | Status: {} | Updated: {}\n",
        line(&t.title, 256),
        line(&t.id, 256),
        t.provider,
        status_name(&t.status),
        stamp(t.updated_at, now),
    );
    let attention = &t.attention;
    let mut facts = Vec::new();
    if let Some(started) = row.started {
        facts.push(format!("Started: {}", stamp(started, now)));
    }
    if let Some(folder) = &row.folder {
        facts.push(format!("Folder: {}", line(folder, 120)));
    }
    if let Some(variant) = &t.variant {
        facts.push(format!("Isolated: {}", line(&variant.branch, 120)));
    }
    if t.is_pinned || t.is_pinned_in_project {
        facts.push("Pinned".into());
    }
    if t.is_archived {
        facts.push("Archived".into());
    }
    for (label, count) in [
        ("Pending approvals", attention.pending_approval_count),
        ("Pending questions", attention.pending_question_count),
        ("Background tasks", attention.background_task_count),
        ("Queued turns", t.queued_turns.len() as u32),
    ] {
        if count > 0 {
            facts.push(format!("{label}: {count}"));
        }
    }
    if attention.unread {
        facts.push("Unread".into());
    }
    if let Some(ThreadOrigin::AgentSpawn { parent_thread_id }) = &t.origin {
        facts.push(format!("Parent: {}", line(parent_thread_id, 256)));
    }
    if !facts.is_empty() {
        text.push_str(&format!("- {}\n", facts.join(" | ")));
    }
    if let Some(goal) = &t.goal {
        text.push_str(&format!(
            "- Goal: {}\n",
            line(&goal.objective, EXCERPT_CHARS)
        ));
    }
    let (label, preview) = row.preview();
    text.push_str(&format!(
        "- {label}: {}\n",
        preview.map_or_else(|| "(none)".into(), |p| line(p, PREVIEW_CHARS))
    ));
    for (label, excerpt) in [("Opening user", &row.opening), ("Recent user", &row.recent)] {
        if let Some(excerpt) = excerpt.as_deref().filter(|e| Some(*e) != preview) {
            text.push_str(&format!("- {label}: {}\n", line(excerpt, EXCERPT_CHARS)));
        }
    }
    if t.status == ThreadStatus::Error
        && let Some(error) = &t.last_error
    {
        text.push_str(&format!("- Last error: {}\n", line(error, EXCERPT_CHARS)));
    }
    text.push('\n');
    text
}

pub(super) async fn list(
    app: &AppState,
    workspace: &str,
    args: ListArgs,
) -> Result<String, DaemonError> {
    let now = Utc::now();
    let cap = args.max_chars.unwrap_or(MAX_CHARS).clamp(512, MAX_CHARS);
    let limit = args.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_ITEMS);
    let offset = args.offset.unwrap_or(0);
    let since = args
        .updated_since
        .as_deref()
        .map(|v| parse_time("updated_since", v, now))
        .transpose()?;
    let before = args
        .updated_before
        .as_deref()
        .map(|v| parse_time("updated_before", v, now))
        .transpose()?;
    let needle = match args.query.as_deref() {
        Some(q) if q.trim().is_empty() || q.chars().count() > 256 => {
            return Err(bad("query must be 1–256 characters"));
        }
        Some(q) => Some(q.to_lowercase()),
        None => None,
    };
    let statuses = match args.status {
        None => Vec::new(),
        Some(OneOrMany::One(status)) => vec![status],
        Some(OneOrMany::Many(statuses)) if statuses.is_empty() => {
            return Err(bad("status must list at least one value"));
        }
        Some(OneOrMany::Many(statuses)) => statuses,
    };
    let folders: Vec<_> = app
        .preferences()
        .await
        .project_folders
        .into_iter()
        .filter(|f| f.workspace_id == workspace)
        .collect();
    let folder_filter = match args.folder.as_deref().map(str::trim) {
        Some("") => return Err(bad("folder must be nonempty")),
        Some(wanted) => Some(
            folders
                .iter()
                .find(|f| f.id == wanted || f.name.eq_ignore_ascii_case(wanted))
                .ok_or_else(|| {
                    bad(format!(
                        "no folder named {} in this project",
                        line(wanted, 120)
                    ))
                })?
                .id
                .clone(),
        ),
        None => None,
    };
    let folder_of = |id: &str| {
        folders
            .iter()
            .find(|f| f.thread_ids.iter().any(|t| t == id))
    };

    let (project, total, mut rows) = {
        let workspaces = app.inner.workspaces.lock().await;
        let ws = workspaces
            .get(workspace)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
        let rows: Vec<Row> = ws
            .threads
            .values()
            .filter(|thread| {
                let t = &thread.summary;
                (match args.archived {
                    Archived::Exclude => !t.is_archived,
                    Archived::Include => true,
                    Archived::Only => t.is_archived,
                }) && args
                    .pinned
                    .is_none_or(|p| p == (t.is_pinned || t.is_pinned_in_project))
                    && args.has_pending_approval.is_none_or(|p| p == pending(t))
                    && (statuses.is_empty() || statuses.iter().any(|s| status_matches(t, *s)))
                    && args
                        .provider
                        .as_deref()
                        .is_none_or(|p| t.provider.as_str().eq_ignore_ascii_case(p.trim()))
                    && since.is_none_or(|since| t.updated_at >= since)
                    && before.is_none_or(|before| t.updated_at < before)
                    && folder_filter
                        .as_deref()
                        .is_none_or(|wanted| folder_of(&t.id).is_some_and(|f| f.id == wanted))
            })
            .map(|thread| {
                let text = |assistant: bool| {
                    thread.items.iter().rev().find_map(|item| match item {
                        ConversationItem::AssistantMessage { text, .. } if assistant => {
                            Some(capped(text, PREVIEW_CHARS)).filter(|t| !t.trim().is_empty())
                        }
                        ConversationItem::UserMessage { text, .. } if !assistant => {
                            Some(capped(text, PREVIEW_CHARS)).filter(|t| !t.trim().is_empty())
                        }
                        _ => None,
                    })
                };
                Row {
                    folder: folder_of(&thread.summary.id).map(|f| f.name.clone()),
                    memory_assistant: text(true),
                    memory_user: text(false),
                    memory_started: thread.items.iter().find_map(|item| match item {
                        ConversationItem::UserMessage { created_at, .. }
                        | ConversationItem::AssistantMessage { created_at, .. } => {
                            Some(*created_at)
                        }
                        _ => None,
                    }),
                    summary: thread.summary.clone(),
                    opening: None,
                    recent: None,
                    session_path: None,
                    started: None,
                }
            })
            .collect();
        (ws.summary.path.clone(), ws.threads.len(), rows)
    };
    {
        let index = app
            .inner
            .thread_search
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for row in &mut rows {
            if let Some(excerpt) = row
                .summary
                .native_session_id
                .as_ref()
                .and_then(|id| index.sessions.get(id))
            {
                row.opening = excerpt.opening.first().cloned();
                row.recent = excerpt.recent.last().cloned();
                row.session_path = Some(excerpt.path.clone());
            }
        }
    }
    if let Some(needle) = &needle {
        rows.retain(|row| row.matches_query(needle));
    }
    let resolve_started = |row: &mut Row| {
        row.started = row
            .session_path
            .as_deref()
            .and_then(session_started)
            .or(row.memory_started);
    };
    if args.sort == Sort::Created {
        rows.iter_mut().for_each(resolve_started);
    }
    let order = args.order.unwrap_or(match args.sort {
        Sort::Title => Order::Asc,
        _ => Order::Desc,
    });
    rows.sort_by(|a, b| {
        let (x, y) = (&a.summary, &b.summary);
        let primary = match args.sort {
            Sort::Updated => x.updated_at.cmp(&y.updated_at),
            Sort::Title => x.title.to_lowercase().cmp(&y.title.to_lowercase()),
            // Unknown start times sort last in either direction.
            Sort::Created => match (a.started, b.started) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => return std::cmp::Ordering::Less,
                (None, Some(_)) => return std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            },
        };
        let primary = match order {
            Order::Asc => primary,
            Order::Desc => primary.reverse(),
        };
        primary
            .then_with(|| y.updated_at.cmp(&x.updated_at))
            .then_with(|| x.id.cmp(&y.id))
    });

    let matched = rows.len();
    let mut markdown = format!(
        "# Workspace threads\n\nProject: {}\nMatched {matched} of {total} threads; sorted by {} {}.\n\n",
        line(&project, 160),
        match args.sort {
            Sort::Updated => "updated",
            Sort::Created => "created",
            Sort::Title => "title",
        },
        match order {
            Order::Asc => "asc",
            Order::Desc => "desc",
        },
    );
    let mut shown = 0;
    for row in rows.iter_mut().skip(offset).take(limit) {
        if row.started.is_none() {
            resolve_started(row);
        }
        let mut text = entry(row, now);
        // Room for the footer, which carries the next offset.
        let room = cap.saturating_sub(markdown.chars().count() + 120);
        if text.chars().count() > room {
            if shown > 0 {
                break;
            }
            // A lone oversized entry shrinks to its id so paging cannot stall
            // past a thread the caller never saw.
            text = format!(
                "## {}\n\n- Id: {}\n\n",
                line(&row.summary.title, 40),
                line(&row.summary.id, 256)
            );
            if text.chars().count() > room {
                text = format!("- Id: {}\n\n", line(&row.summary.id, 256));
            }
            if text.chars().count() > room {
                break;
            }
        }
        markdown.push_str(&text);
        shown += 1;
    }
    let start = offset.min(matched);
    let end = start + shown;
    if shown == 0 {
        markdown.push_str(&format!("No threads in this page (offset {offset}).\n"));
    } else {
        markdown.push_str(&format!(
            "Shown {}–{end} of {matched} matching threads.\n",
            start + 1
        ));
    }
    if end < matched {
        markdown.push_str(&format!(
            "Next page: offset={end} (keep sort and filters unchanged).\n"
        ));
    } else {
        markdown.push_str("End of results.\n");
    }
    Ok(capped(&markdown, cap))
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::tests::{call, fixture};
    use falcondeck_core::ProjectFolder;

    /// Adds `count` threads `t00..`, each a minute older than the last.
    async fn seed(app: &AppState, count: usize, edit: impl Fn(usize, &mut ThreadSummary)) {
        let mut workspaces = app.inner.workspaces.lock().await;
        let ws = workspaces.get_mut("workspace-1").unwrap();
        let template = ws.threads["thread-1"].summary.clone();
        for i in 0..count {
            let mut summary = template.clone();
            summary.id = format!("t{i:02}");
            summary.title = format!("Task {i:02}");
            summary.native_session_id = None;
            summary.updated_at = Utc::now() - Duration::minutes(i as i64 + 1);
            edit(i, &mut summary);
            ws.threads
                .insert(summary.id.clone(), ManagedThread::new(summary));
        }
    }

    async fn list_text(app: &AppState, arguments: Value) -> String {
        app.invoke_extension_tool(call(LIST, arguments))
            .await
            .unwrap()
            .result
            .as_str()
            .unwrap()
            .to_string()
    }

    fn ids(text: &str) -> Vec<String> {
        text.lines()
            .filter_map(|l| l.strip_prefix("- Id: "))
            .map(|l| l.split(" | ").next().unwrap().to_string())
            .collect()
    }

    fn next_offset(text: &str) -> Option<usize> {
        text.split("Next page: offset=")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .map(|n| n.parse().unwrap())
    }

    #[tokio::test]
    async fn offset_pages_reach_every_thread_in_activity_order() {
        let (app, _temp) = fixture().await;
        seed(&app, 45, |_, _| {}).await;
        let (mut offset, mut seen) = (0, Vec::new());
        loop {
            let text = list_text(&app, json!({"limit":20, "offset":offset})).await;
            assert!(text.contains("Matched 46 of 46"), "{text}");
            assert!(text.contains("Updated: 20"), "{text}");
            seen.extend(ids(&text));
            match next_offset(&text) {
                Some(next) => offset = next,
                None => {
                    assert!(text.contains("End of results"));
                    break;
                }
            }
        }
        let mut expected = vec!["thread-1".to_string()];
        expected.extend((0..45).map(|i| format!("t{i:02}")));
        assert_eq!(seen, expected);
        let oldest = list_text(&app, json!({"order":"asc","limit":1})).await;
        assert_eq!(ids(&oldest), ["t44"]);
        let titled = list_text(&app, json!({"sort":"title","limit":2})).await;
        assert_eq!(ids(&titled), ["thread-1", "t00"]);
        // A budget too small for one entry still advances instead of stalling.
        let tight = list_text(&app, json!({"max_chars":512, "limit":100})).await;
        assert!(tight.chars().count() <= 512, "{tight}");
        assert!(next_offset(&tight).is_some_and(|n| n >= 1), "{tight}");
        app.with_thread_mut("workspace-1", "t00", |t| t.title = "終".repeat(256))
            .await
            .unwrap();
        let tight = list_text(&app, json!({"max_chars":512, "limit":1})).await;
        assert!(tight.chars().count() <= 512, "{tight}");
        // The edit bumped t00 to newest; its oversized entry shrinks but keeps the id.
        assert_eq!(ids(&tight), ["t00"], "{tight}");
        let tight = list_text(&app, json!({"max_chars":512, "limit":1, "offset":1})).await;
        assert_eq!(ids(&tight), ["thread-1"], "{tight}");
    }

    #[tokio::test]
    async fn filters_combine_and_reject_bad_input() {
        let (app, _temp) = fixture().await;
        seed(&app, 6, |i, t| match i {
            0 => t.status = ThreadStatus::Running,
            1 => {
                t.status = ThreadStatus::WaitingForInput;
                t.attention.pending_approval_count = 2;
            }
            2 => {
                t.status = ThreadStatus::Error;
                t.last_error = Some("boom".into());
                t.provider = AgentProvider::new("codex");
            }
            3 => t.is_archived = true,
            4 => t.is_pinned_in_project = true,
            _ => t.updated_at = Utc::now() - Duration::days(3),
        })
        .await;
        app.inner.preferences.lock().await.project_folders = vec![ProjectFolder {
            id: "f1".into(),
            workspace_id: "workspace-1".into(),
            name: "Coordinator".into(),
            collapsed: false,
            thread_ids: vec!["t00".into(), "t03".into()],
        }];
        let check = async |arguments: Value, expected: &[&str]| {
            let text = list_text(&app, arguments.clone()).await;
            assert_eq!(ids(&text), expected, "{arguments}: {text}");
        };
        check(json!({"status":"running"}), &["t00"]).await;
        check(json!({"status":["failed","waiting"]}), &["t01", "t02"]).await;
        check(json!({"status":"awaiting_approval"}), &["t01"]).await;
        check(
            json!({"has_pending_approval":false, "provider":"CODEX"}),
            &["t02"],
        )
        .await;
        check(json!({"archived":"only"}), &["t03"]).await;
        check(
            json!({"folder":"coordinator", "archived":"include"}),
            &["t00", "t03"],
        )
        .await;
        check(json!({"pinned":true}), &["t04"]).await;
        check(json!({"updated_before":"2d"}), &["t05"]).await;
        check(
            json!({"updated_since":"4m", "status":"idle"}),
            &["thread-1"],
        )
        .await;
        let text = list_text(&app, json!({"status":"error"})).await;
        assert!(
            text.contains("Last error: boom") && text.contains("Provider: codex"),
            "{text}"
        );
        let text = list_text(&app, json!({"folder":"f1"})).await;
        assert!(
            text.contains("Folder: Coordinator") && text.contains("Matched 1 of 7"),
            "{text}"
        );
        for arguments in [
            json!({"updated_since":"yesterday"}),
            json!({"folder":"missing"}),
            json!({"status":"paused"}),
            json!({"status":[]}),
            json!({"query":" "}),
            json!({"thread_id":"t00"}),
        ] {
            assert!(
                app.invoke_extension_tool(call(LIST, arguments.clone()))
                    .await
                    .is_err(),
                "{arguments}"
            );
        }
    }

    #[tokio::test]
    async fn previews_fall_back_and_query_matches_cached_excerpts() {
        let (app, _temp) = fixture().await;
        seed(&app, 3, |i, t| {
            t.native_session_id = Some(format!("session-{i}"));
            if i == 2 {
                t.last_message_preview = Some("summary preview".into());
            }
        })
        .await;
        {
            let mut workspaces = app.inner.workspaces.lock().await;
            let thread = workspaces
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("t00")
                .unwrap();
            thread.items = vec![
                serde_json::from_value(json!({"kind":"user_message","id":"u","text":"please do it","attachments":[],"created_at":Utc::now()})).unwrap(),
                serde_json::from_value(json!({"kind":"assistant_message","id":"a","text":"Shipped the Needle fix","created_at":Utc::now()})).unwrap(),
            ];
        }
        app.inner.thread_search.lock().unwrap().sessions.insert(
            "session-1".into(),
            thread_search::SessionExcerpt {
                path: "/missing/transcript".into(),
                modified_ms: 0,
                size: 0,
                opening: vec!["opening goal".into(), "second".into()],
                recent: vec!["older".into(), "latest haystack request".into()],
            },
        );
        let text = list_text(&app, json!({})).await;
        for part in [
            "- Last assistant: Shipped the Needle fix",
            "- Recent user: latest haystack request\n- Opening user: opening goal",
            "- Last preview: summary preview",
            "- Last preview: (none)",
        ] {
            assert!(text.contains(part), "{part}: {text}");
        }
        let found = list_text(&app, json!({"query":"HAYSTACK"})).await;
        assert_eq!(ids(&found), ["t01"]);
        let found = list_text(&app, json!({"query":"needle"})).await;
        assert_eq!(ids(&found), ["t00"]);
        let found = list_text(&app, json!({"query":"task 02"})).await;
        assert_eq!(ids(&found), ["t02"]);
        let started = list_text(&app, json!({"sort":"created", "limit":1})).await;
        assert!(
            ids(&started) == ["t00"] && started.contains("Started: "),
            "{started}"
        );
    }

    #[test]
    fn parses_absolute_and_relative_times() {
        let now = DateTime::parse_from_rfc3339("2026-10-16T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let at = |v: &str| parse_time("t", v, now).map(|t| t.to_rfc3339());
        assert_eq!(at("24h").unwrap(), "2026-10-15T12:00:00+00:00");
        assert_eq!(at("2w ago").unwrap(), "2026-10-02T12:00:00+00:00");
        assert_eq!(at("30m").unwrap(), "2026-10-16T11:30:00+00:00");
        assert_eq!(at("2026-10-01").unwrap(), "2026-10-01T00:00:00+00:00");
        assert_eq!(
            at("2026-10-16T09:00:00+02:00").unwrap(),
            "2026-10-16T07:00:00+00:00"
        );
        for invalid in ["", "h", "-3h", "3y", "yesterday", "終h", "10000000000000s"] {
            assert!(at(invalid).is_err(), "{invalid}");
        }
    }
}
