//! Filtered, sorted, paged thread listing for in-session coordinators.
//!
//! Reads daemon summaries, transcript items already in memory, and the cached
//! search-index excerpts. It never hydrates native history.
use super::glance::{self, Glance, RowContext};
use super::*;
use chrono::{DateTime, Duration};
use std::path::Path;

const DEFAULT_LIMIT: usize = 20;

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

#[derive(Deserialize, Default, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Detail {
    Brief,
    #[default]
    Normal,
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
    #[serde(default)]
    detail: Detail,
    status: Option<OneOrMany<Status>>,
    provider: Option<String>,
    folder: Option<String>,
    parent: Option<String>,
    #[serde(default)]
    archived: Archived,
    pinned: Option<bool>,
    /// Superseded by `status: awaiting_approval`; still accepted.
    has_pending_approval: Option<bool>,
    updated_since: Option<String>,
    updated_before: Option<String>,
    query: Option<String>,
}

pub(super) fn schema() -> Value {
    let status = json!({"type":"string", "enum":["idle","running","waiting_for_input","error","awaiting_approval"]});
    json!({
        "limit": {"type":"integer", "minimum":1, "maximum":100, "default":DEFAULT_LIMIT},
        "offset": {"type":"integer", "minimum":0, "description":"Next page: pass the returned offset with the same filters."},
        "detail": {"type":"string", "enum":["brief","normal"], "default":"normal", "description":"brief drops the Asked/Latest lines."},
        "status": {"anyOf":[status, {"type":"array", "items":status, "minItems":1}], "description":"Match any. awaiting_approval = pending approval or question."},
        "updated_since": {"type":"string", "description":"RFC 3339, YYYY-MM-DD, or an age like 30m, 24h, 7d."},
        "updated_before": {"type":"string"},
        "query": {"type":"string", "minLength":1, "maxLength":256, "description":"Case-insensitive literal match on title, id, and message excerpts."},
        "parent": {"type":"string", "minLength":1, "description":"Only threads created by this thread id; \"self\" for your own."},
        "provider": {"type":"string", "minLength":1},
        "folder": {"type":"string", "minLength":1, "description":"Project folder name or id."},
        "pinned": {"type":"boolean"},
        "archived": {"type":"string", "enum":["exclude","include","only"], "default":"exclude"},
        "sort": {"type":"string", "enum":["updated","created","title"], "default":"updated"},
        "order": {"type":"string", "enum":["asc","desc"]},
        "max_chars": {"type":"integer", "minimum":512, "maximum":MAX_CHARS, "default":MAX_CHARS}
    })
}

/// A matching thread's sort keys, gathered without cloning its summary.
struct Candidate {
    /// Index into the scope.
    workspace: usize,
    id: String,
    title: String,
    updated_at: DateTime<Utc>,
    session_path: Option<PathBuf>,
    memory_started: Option<DateTime<Utc>>,
    started: Option<DateTime<Utc>>,
}

fn matches_query(summary: &ThreadSummary, glance: &Glance, needle: &str) -> bool {
    [
        Some(summary.title.as_str()),
        Some(summary.id.as_str()),
        summary.goal.as_ref().map(|g| g.objective.as_str()),
    ]
    .into_iter()
    .flatten()
    .any(|text| text.to_lowercase().contains(needle))
        || glance.matches(needle)
}

fn bad(message: impl Into<String>) -> DaemonError {
    DaemonError::BadRequest(message.into())
}

/// Accepts RFC 3339, a bare UTC date, or a relative age (`90s`, `30m`, `24h`, `7d`, `2w`).
pub(super) fn parse_time(
    field: &str,
    value: &str,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, DaemonError> {
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

/// `pending` comes from the live request map; stored summary counts go stale.
fn status_matches(summary: &ThreadSummary, status: Status, pending: bool) -> bool {
    match status {
        Status::Idle => summary.status == ThreadStatus::Idle,
        Status::Running => summary.status == ThreadStatus::Running,
        Status::WaitingForInput => summary.status == ThreadStatus::WaitingForInput,
        Status::Error => summary.status == ThreadStatus::Error,
        Status::AwaitingApproval => pending,
    }
}

fn session_started(path: &Path) -> Option<DateTime<Utc>> {
    std::fs::metadata(path)
        .and_then(|meta| meta.created())
        .ok()
        .map(DateTime::<Utc>::from)
}

/// Counts over every unarchived thread in scope, independent of filters.
#[derive(Default)]
struct Overview {
    total: usize,
    running: usize,
    needs_user: usize,
    errored: usize,
    recent: usize,
}

pub(super) async fn list(
    app: &AppState,
    scope: &[String],
    caller: &str,
    args: ListArgs,
) -> Result<String, DaemonError> {
    let now = Utc::now();
    let cap = args.max_chars.unwrap_or(MAX_CHARS).clamp(512, MAX_CHARS);
    let limit = args.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_ITEMS);
    let offset = args.offset.unwrap_or(0);
    let multi = scope.len() > 1;
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
    let parent = match args.parent.as_deref().map(str::trim) {
        Some("") => return Err(bad("parent must be nonempty")),
        Some("self") => Some(caller.to_string()),
        Some(id) => Some(id.to_string()),
        None => None,
    };
    let folders: Vec<_> = app
        .preferences()
        .await
        .project_folders
        .into_iter()
        .filter(|f| scope.contains(&f.workspace_id))
        .collect();
    let folder_filter = match args.folder.as_deref().map(str::trim) {
        Some(_) if multi => {
            return Err(bad("folder needs a single project; pass workspace_id"));
        }
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

    app.refresh_excerpts().await;
    let counts = app.attention_counts().await;
    let pending_of = |workspace: &String, id: &String| {
        counts
            .get(&(workspace.clone(), id.clone()))
            .copied()
            .unwrap_or_default()
    };
    let mut overview = Overview::default();
    let mut projects = Vec::new();
    let mut candidates = Vec::new();
    {
        let workspaces = app.inner.workspaces.lock().await;
        let index = app
            .inner
            .thread_search
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (position, id) in scope.iter().enumerate() {
            let ws = workspaces
                .get(id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
            projects.push((
                glance::project_name(&ws.summary.path).to_string(),
                ws.summary.path.clone(),
            ));
            for thread in ws.threads.values() {
                let t = &thread.summary;
                if t.id == caller {
                    continue;
                }
                let (approvals, questions) = pending_of(id, &t.id);
                let pending = approvals + questions > 0;
                if !t.is_archived {
                    overview.total += 1;
                    overview.running += usize::from(t.status == ThreadStatus::Running);
                    overview.needs_user +=
                        usize::from(pending || t.status == ThreadStatus::WaitingForInput);
                    overview.errored += usize::from(t.status == ThreadStatus::Error);
                    overview.recent += usize::from(now - t.updated_at < Duration::hours(24));
                }
                let keep = (match args.archived {
                    Archived::Exclude => !t.is_archived,
                    Archived::Include => true,
                    Archived::Only => t.is_archived,
                }) && args
                    .pinned
                    .is_none_or(|p| p == (t.is_pinned || t.is_pinned_in_project))
                    && args.has_pending_approval.is_none_or(|p| p == pending)
                    && (statuses.is_empty()
                        || statuses.iter().any(|s| status_matches(t, *s, pending)))
                    && args
                        .provider
                        .as_deref()
                        .is_none_or(|p| t.provider.as_str().eq_ignore_ascii_case(p.trim()))
                    && since.is_none_or(|since| t.updated_at >= since)
                    && before.is_none_or(|before| t.updated_at < before)
                    && parent.as_deref().is_none_or(|parent| {
                        matches!(&t.origin, Some(ThreadOrigin::AgentSpawn { parent_thread_id }) if parent_thread_id == parent)
                    })
                    && folder_filter
                        .as_deref()
                        .is_none_or(|wanted| folder_of(&t.id).is_some_and(|f| f.id == wanted));
                if !keep {
                    continue;
                }
                let excerpt = t
                    .native_session_id
                    .as_ref()
                    .and_then(|session| index.sessions.get(session));
                if let Some(needle) = &needle
                    && !matches_query(t, &Glance::of(thread, excerpt), needle)
                {
                    continue;
                }
                candidates.push(Candidate {
                    workspace: position,
                    id: t.id.clone(),
                    title: if args.sort == Sort::Title {
                        t.title.to_lowercase()
                    } else {
                        String::new()
                    },
                    updated_at: t.updated_at,
                    session_path: excerpt.map(|e| e.path.clone()),
                    memory_started: thread.items.iter().find_map(|item| match item {
                        ConversationItem::UserMessage { created_at, .. }
                        | ConversationItem::AssistantMessage { created_at, .. } => {
                            Some(*created_at)
                        }
                        _ => None,
                    }),
                    started: None,
                });
            }
        }
    }
    if args.sort == Sort::Created {
        for candidate in &mut candidates {
            candidate.started = candidate
                .session_path
                .as_deref()
                .and_then(session_started)
                .or(candidate.memory_started);
        }
    }
    let order = args.order.unwrap_or(match args.sort {
        Sort::Title => Order::Asc,
        _ => Order::Desc,
    });
    candidates.sort_by(|a, b| {
        let primary = match args.sort {
            Sort::Updated => a.updated_at.cmp(&b.updated_at),
            Sort::Title => a.title.cmp(&b.title),
            // Unknown start times sort last in either direction.
            Sort::Created => match (a.started, b.started) {
                (Some(x), Some(y)) => x.cmp(&y),
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
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });

    let matched = candidates.len();
    let mut markdown = match projects.as_slice() {
        [(name, path)] => format!("# Threads in {} ({})\n", line(name, 80), line(path, 160)),
        _ => format!("# Threads across {} projects\n", projects.len()),
    };
    markdown.push_str(&format!(
        "{} unarchived (not counting you): {} running, {} need the user, {} errored; {} active in 24h.\n\n",
        overview.total, overview.running, overview.needs_user, overview.errored, overview.recent,
    ));
    // Only the page is rendered, so only its summaries are cloned. A thread
    // deleted since the first pass is skipped without counting: the next
    // call's list no longer has it, so `offset + shown` stays aligned.
    let mut shown = 0;
    {
        let workspaces = app.inner.workspaces.lock().await;
        let index = app
            .inner
            .thread_search
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for candidate in candidates.iter().skip(offset) {
            if shown == limit {
                break;
            }
            let workspace = &scope[candidate.workspace];
            // A thread removed since the first pass is skipped.
            let Some(thread) = workspaces
                .get(workspace)
                .and_then(|ws| ws.threads.get(&candidate.id))
            else {
                continue;
            };
            let mut summary = thread.summary.clone();
            let (approvals, questions) = pending_of(workspace, &summary.id);
            refresh_thread_attention(&mut summary, approvals, questions);
            let excerpt = summary
                .native_session_id
                .as_ref()
                .and_then(|session| index.sessions.get(session));
            let cx = RowContext {
                now,
                caller,
                project: multi.then(|| projects[candidate.workspace].0.as_str()),
                folder: folder_of(&summary.id).map(|f| f.name.as_str()),
                excerpts: args.detail == Detail::Normal,
            };
            let mut text = glance::row(&summary, &Glance::of(thread, excerpt), &cx, &[]);
            // Room for the footer, which carries the next offset.
            let room = cap.saturating_sub(markdown.chars().count() + 120);
            if text.chars().count() > room {
                if shown > 0 {
                    break;
                }
                // A lone oversized entry shrinks to its id so paging cannot stall
                // past a thread the caller never saw.
                text = format!(
                    "- **{}** `{}`\n",
                    line(&summary.title, 40),
                    line(&summary.id, 256)
                );
                if text.chars().count() > room {
                    text = format!("- `{}`\n", line(&summary.id, 256));
                }
                if text.chars().count() > room {
                    break;
                }
            }
            markdown.push_str(&text);
            shown += 1;
        }
    }
    let start = offset.min(matched);
    let end = (start + shown).min(matched);
    let sorted = match (args.sort, order) {
        (Sort::Updated, Order::Desc) => "newest activity first",
        (Sort::Updated, Order::Asc) => "oldest activity first",
        (Sort::Created, Order::Desc) => "newest first",
        (Sort::Created, Order::Asc) => "oldest first",
        (Sort::Title, _) => "by title",
    };
    markdown.push('\n');
    markdown.push_str(&if matched == 0 {
        "No threads match.".to_string()
    } else if shown == 0 {
        format!("No threads at offset {offset}; {matched} matched.")
    } else {
        format!("Showing {}–{end} of {matched}, {sorted}.", start + 1)
    });
    if end < matched {
        markdown.push_str(&format!(" More: offset={end}."));
    }
    markdown.push('\n');
    Ok(capped(&markdown, cap))
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::tests::{call, fixture};
    use falcondeck_core::{ProjectFolder, ThreadOrigin};

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
            .filter(|l| l.starts_with("- "))
            .filter_map(|l| l.split('`').nth(1))
            .map(str::to_string)
            .collect()
    }

    fn next_offset(text: &str) -> Option<usize> {
        text.split("More: offset=")
            .nth(1)
            .and_then(|rest| {
                rest.trim_end_matches(|c: char| !c.is_ascii_digit())
                    .split('.')
                    .next()
            })
            .map(|n| n.parse().unwrap())
    }

    #[tokio::test]
    async fn offset_pages_reach_every_thread_in_activity_order() {
        let (app, _temp) = fixture().await;
        seed(&app, 45, |_, _| {}).await;
        let (mut offset, mut seen) = (0, Vec::new());
        loop {
            let text = list_text(&app, json!({"limit":20, "offset":offset})).await;
            assert!(text.contains("of 45, newest activity first"), "{text}");
            assert!(text.contains("45 unarchived (not counting you)"), "{text}");
            assert!(text.contains(" · claude"), "{text}");
            seen.extend(ids(&text));
            match next_offset(&text) {
                Some(next) => offset = next,
                None => break,
            }
        }
        // The calling thread never lists itself.
        let expected: Vec<_> = (0..45).map(|i| format!("t{i:02}")).collect();
        assert_eq!(seen, expected);
        let oldest = list_text(&app, json!({"order":"asc","limit":1})).await;
        assert_eq!(ids(&oldest), ["t44"]);
        let titled = list_text(&app, json!({"sort":"title","limit":2})).await;
        assert_eq!(ids(&titled), ["t00", "t01"]);
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
        assert_eq!(ids(&tight), ["t01"], "{tight}");
    }

    #[tokio::test]
    async fn filters_combine_and_reject_bad_input() {
        let (app, _temp) = fixture().await;
        seed(&app, 7, |i, t| match i {
            0 => t.status = ThreadStatus::Running,
            1 => t.status = ThreadStatus::WaitingForInput,
            2 => {
                t.status = ThreadStatus::Error;
                t.last_error = Some("boom".into());
                t.provider = AgentProvider::new("codex");
            }
            3 => t.is_archived = true,
            4 => t.is_pinned_in_project = true,
            5 => {
                t.origin = Some(ThreadOrigin::AgentSpawn {
                    parent_thread_id: "thread-1".into(),
                })
            }
            _ => t.updated_at = Utc::now() - Duration::days(3),
        })
        .await;
        // Pending counts come from the live request map, not the stored summary.
        let request: falcondeck_core::InteractiveRequest = serde_json::from_value(json!({
            "request_id":"r1", "workspace_id":"workspace-1", "thread_id":"t01",
            "method":"item/commandExecution/requestApproval", "kind":"approval", "title":"Run",
            "detail":null, "command":null, "path":null, "turn_id":null, "item_id":null,
            "questions":[], "created_at":Utc::now()
        }))
        .unwrap();
        app.inner.interactive_requests.lock().await.insert(
            ("workspace-1".into(), "r1".into()),
            super::super::super::PendingServerRequest {
                raw_id: json!(1),
                request,
                params: json!({}),
            },
        );
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
        check(json!({"parent":"self"}), &["t05"]).await;
        check(json!({"parent":"thread-1"}), &["t05"]).await;
        check(json!({"updated_before":"2d"}), &["t06"]).await;
        check(
            json!({"updated_since":"7m", "status":"idle"}),
            &["t04", "t05"],
        )
        .await;
        let text = list_text(&app, json!({})).await;
        for part in [
            "6 unarchived (not counting you): 1 running, 1 need the user, 1 errored; 5 active in 24h.",
            "`t01` — awaiting_approval (approval) · ",
            "`t02` — error · ",
            "  Error: boom",
            "· codex",
            "· your child",
            "· folder Coordinator",
            "· pinned",
        ] {
            assert!(text.contains(part), "missing {part:?} in\n{text}");
        }
        for arguments in [
            json!({"updated_since":"yesterday"}),
            json!({"folder":"missing"}),
            json!({"status":"paused"}),
            json!({"status":[]}),
            json!({"query":" "}),
            json!({"parent":" "}),
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
    async fn rows_show_request_and_reply_without_echoing_the_prompt() {
        let (app, _temp) = fixture().await;
        seed(&app, 5, |i, t| {
            t.native_session_id = Some(format!("session-{i}"));
            match i {
                // Codex previews are the opening prompt, not an outcome.
                2 => {
                    t.last_message_preview =
                        Some("Please can we improve the automations page...".into())
                }
                3 => t.last_message_preview = Some("Deployed the relay.".into()),
                4 => t.last_message_preview = Some("An answer to the previous request.".into()),
                _ => {}
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
        {
            let mut index = app.inner.thread_search.lock().unwrap();
            index.sessions.insert(
                "session-1".into(),
                thread_search::SessionExcerpt {
                    path: "/missing/transcript".into(),
                    opening: vec!["opening goal".into(), "second".into()],
                    recent: vec!["older".into(), "latest haystack request".into()],
                    latest_reply: Some("Indexed reply".into()),
                    ..Default::default()
                },
            );
            index.sessions.insert(
                "session-2".into(),
                thread_search::SessionExcerpt {
                    opening: vec![
                        "Please can we improve the automations page a bit? Group it.".into(),
                    ],
                    recent: vec![
                        "Please can we improve the automations page a bit? Group it.".into(),
                    ],
                    ..Default::default()
                },
            );
            // A new request with no reply yet keeps the old preview out.
            index.sessions.insert(
                "session-4".into(),
                thread_search::SessionExcerpt {
                    recent: vec!["new unanswered request".into()],
                    ..Default::default()
                },
            );
        }
        let text = list_text(&app, json!({})).await;
        for part in [
            "`t00` — idle · 1m ago · claude\n  Asked: please do it\n  Latest: Shipped the Needle fix\n",
            "`t01` — idle · 2m ago · claude\n  Asked: latest haystack request\n  Latest: Indexed reply\n",
            "`t02` — idle · 3m ago · claude\n  Asked: Please can we improve the automations page a bit? Group it.\n- ",
            "`t03` — idle · 4m ago · claude\n  Preview: Deployed the relay.\n",
        ] {
            assert!(text.contains(part), "missing {part:?} in\n{text}");
        }
        assert!(
            text.contains("`t04` — idle · 5m ago · claude\n  Asked: new unanswered request\n")
                && !text.contains("previous request"),
            "{text}"
        );
        let brief = list_text(&app, json!({"detail":"brief"})).await;
        assert!(
            !brief.contains("Asked:") && ids(&brief).len() == 5,
            "{brief}"
        );
        let found = list_text(&app, json!({"query":"HAYSTACK"})).await;
        assert_eq!(ids(&found), ["t01"]);
        let found = list_text(&app, json!({"query":"indexed REPLY"})).await;
        assert_eq!(ids(&found), ["t01"]);
        let found = list_text(&app, json!({"query":"needle"})).await;
        assert_eq!(ids(&found), ["t00"]);
        let found = list_text(&app, json!({"query":"task 02"})).await;
        assert_eq!(ids(&found), ["t02"]);
        let started = list_text(&app, json!({"sort":"created", "limit":1})).await;
        assert_eq!(ids(&started), ["t00"], "{started}");
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
