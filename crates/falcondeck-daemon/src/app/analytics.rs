//! Local activity analytics. Compact metadata records (no message content)
//! plus an optional log of the user's own messages, appended to monthly JSONL
//! files under `<state dir>/analytics/`. Never projected over the relay.
//!
//! Recording must never slow a turn: callers serialize a line and `try_send`
//! it to a writer thread, dropping it when the queue is full. A second thread
//! follows the event stream for turn timing, token usage and Codex file events.
use super::*;
use chrono::{DateTime, Datelike, Local, NaiveDate};
use falcondeck_core::control::AUTOMATION_MESSAGE_PREFIX;
use falcondeck_core::{
    AnalyticsAgentMessage, AnalyticsAgentPair, AnalyticsAutomation, AnalyticsBot,
    AnalyticsClearTarget, AnalyticsDay, AnalyticsFile, AnalyticsProject, AnalyticsPrompt,
    AnalyticsProvider, AnalyticsSettings, AnalyticsStatus, AnalyticsSummary, AnalyticsTotals,
    AnalyticsTriggers, AnalyticsWaiting,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufWriter, Write as _};
use tokio::sync::{mpsc, oneshot};

const QUEUE: usize = 4096;
const EXCERPT_CHARS: usize = 160;
/// Claude tools whose title is `<Tool> <path>`.
const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const AGENT_MESSAGE_PREFIX: &str = "Message from FalconDeck thread ";

/// One activity record. Field names are short because there are many lines.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "e", rename_all = "snake_case")]
enum Record {
    /// A message reached an agent. `o` is `user` or `scheduled`.
    User {
        t: DateTime<Utc>,
        ws: String,
        th: String,
        n: u64,
        o: String,
    },
    /// An agent messaged another thread or bot.
    Agent {
        t: DateTime<Utc>,
        from: String,
        to: String,
        n: u64,
        d: String,
        ack: bool,
        x: String,
    },
    /// An agent created a task.
    Delegate {
        t: DateTime<Utc>,
        parent: String,
        child: String,
        n: u64,
    },
    /// A turn finished.
    Turn {
        t: DateTime<Utc>,
        th: String,
        ok: bool,
        ms: u64,
        /// Input/output tokens used; only providers reporting per-request usage.
        i: u64,
        out: u64,
        /// Peak context size during the turn, in tokens.
        #[serde(default)]
        ctx: u64,
    },
    /// An agent wrote a file.
    File {
        t: DateTime<Utc>,
        th: String,
        path: String,
    },
    /// Context FalconDeck added to a bot turn, in estimated tokens.
    Context {
        t: DateTime<Utc>,
        th: String,
        tok: u64,
    },
    /// An approval or question waited on the user; `k` is `approval` or `question`.
    Wait {
        t: DateTime<Utc>,
        th: String,
        ms: u64,
        k: String,
    },
    /// An agent made a successful `git commit`.
    Commit {
        t: DateTime<Utc>,
        ws: String,
        th: String,
    },
}

enum Job {
    Event(String),
    Prompt(String),
    Flush(oneshot::Sender<()>),
    Clear(AnalyticsClearTarget, oneshot::Sender<std::io::Result<()>>),
}

pub(super) struct Recorder {
    dir: PathBuf,
    settings: Arc<StdMutex<AnalyticsSettings>>,
    tx: mpsc::Sender<Job>,
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

fn month_of(time: DateTime<Utc>) -> String {
    format!("{:04}-{:02}", time.year(), time.month())
}

/// Months from `since` to now inclusive, `YYYY-MM`.
fn months_since(since: DateTime<Utc>) -> Vec<String> {
    let mut months = Vec::new();
    let (mut year, mut month) = (since.year(), since.month());
    let now = Utc::now();
    while (year, month) <= (now.year(), now.month()) {
        months.push(format!("{year:04}-{month:02}"));
        (year, month) = if month == 12 {
            (year + 1, 1)
        } else {
            (year, month + 1)
        };
    }
    months
}

fn files_with_prefix(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix) && name.ends_with(".jsonl"))
        })
        .collect();
    files.sort();
    files
}

/// Deletes event files older than the retention window.
fn prune(dir: &Path, retention_months: u32) {
    let now = Utc::now();
    let total = now.year() * 12 + now.month0() as i32 - retention_months.max(1) as i32 + 1;
    let oldest = format!("events-{:04}-{:02}.jsonl", total / 12, total % 12 + 1);
    for path in files_with_prefix(dir, "events-") {
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n < oldest.as_str())
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct Appender {
    month: String,
    file: BufWriter<std::fs::File>,
}

fn append(dir: &Path, kind: &str, slot: &mut Option<Appender>, line: &str) -> std::io::Result<()> {
    let month = month_of(Utc::now());
    if slot.as_ref().is_none_or(|open| open.month != month) {
        if let Some(mut open) = slot.take() {
            open.file.flush()?;
        }
        std::fs::create_dir_all(dir)?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(dir.join(format!("{kind}-{month}.jsonl")))?;
        *slot = Some(Appender {
            month,
            file: BufWriter::new(file),
        });
    }
    let open = slot.as_mut().expect("appender opened above");
    open.file.write_all(line.as_bytes())?;
    open.file.write_all(b"\n")
}

fn write_loop(
    dir: PathBuf,
    settings: Arc<StdMutex<AnalyticsSettings>>,
    mut rx: mpsc::Receiver<Job>,
) {
    let retention = |settings: &Arc<StdMutex<AnalyticsSettings>>| {
        settings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retention_months
    };
    prune(&dir, retention(&settings));
    let (mut events, mut prompts) = (None::<Appender>, None::<Appender>);
    let mut pruned_month = month_of(Utc::now());
    while let Some(first) = rx.blocking_recv() {
        let mut next = Some(first);
        // Drain what is already queued, then flush once.
        while let Some(job) = next {
            match job {
                Job::Event(line) => {
                    if let Err(error) = append(&dir, "events", &mut events, &line) {
                        tracing::debug!(%error, "analytics event dropped");
                    }
                }
                Job::Prompt(line) => {
                    if let Err(error) = append(&dir, "prompts", &mut prompts, &line) {
                        tracing::debug!(%error, "analytics prompt dropped");
                    }
                }
                Job::Flush(done) => {
                    for open in [&mut events, &mut prompts].into_iter().flatten() {
                        let _ = open.file.flush();
                    }
                    let _ = done.send(());
                }
                Job::Clear(target, done) => {
                    let prefixes: &[&str] = match target {
                        AnalyticsClearTarget::Prompts => {
                            prompts = None;
                            &["prompts-"]
                        }
                        AnalyticsClearTarget::Events => {
                            events = None;
                            &["events-"]
                        }
                        AnalyticsClearTarget::All => {
                            (events, prompts) = (None, None);
                            &["events-", "prompts-"]
                        }
                    };
                    let result = prefixes
                        .iter()
                        .flat_map(|prefix| files_with_prefix(&dir, prefix))
                        .try_for_each(std::fs::remove_file);
                    let _ = done.send(result);
                }
            }
            next = rx.try_recv().ok();
        }
        for open in [&mut events, &mut prompts].into_iter().flatten() {
            let _ = open.file.flush();
        }
        let month = month_of(Utc::now());
        if month != pruned_month {
            prune(&dir, retention(&settings));
            pruned_month = month;
        }
    }
}

/// What the listener remembers about a thread between events.
#[derive(Default)]
struct ThreadTrack {
    /// When the current turn began (status entered running).
    started: Option<DateTime<Utc>>,
    /// When the thread began waiting on the user, and for what.
    waiting: Option<(DateTime<Utc>, &'static str)>,
    /// Providers that report per-request usage (`last`, e.g. Codex) also send a
    /// cumulative total; turn usage is its change across the turn.
    latest: Option<(u64, u64)>,
    at_start: Option<(u64, u64)>,
    /// Others (Claude, ACP) report how full the context is: tracked as a peak.
    peak: u64,
}

/// Follows the event stream. Turns are timed from thread status changes, which
/// every provider emits, rather than provider-specific turn events.
fn listen_loop(
    mut events: broadcast::Receiver<Arc<CachedEnvelope>>,
    settings: Arc<StdMutex<AnalyticsSettings>>,
    tx: mpsc::Sender<Job>,
) {
    let mut threads: HashMap<String, ThreadTrack> = HashMap::new();
    loop {
        let cached = match events.blocking_recv() {
            Ok(cached) => cached,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return,
        };
        if !settings.lock().unwrap_or_else(|p| p.into_inner()).enabled {
            continue;
        }
        let envelope = &cached.envelope;
        let now = envelope.emitted_at;
        let mut records = Vec::new();
        match &envelope.event {
            UnifiedEvent::ThreadStarted { thread } | UnifiedEvent::ThreadUpdated { thread } => {
                let track = threads.entry(thread.id.clone()).or_default();
                let in_turn = matches!(
                    thread.status,
                    ThreadStatus::Running | ThreadStatus::WaitingForInput
                );
                if in_turn && track.started.is_none() {
                    track.started = Some(now);
                    track.at_start = track.latest;
                    track.peak = 0;
                }
                let attention = &thread.attention;
                let needs_user = if attention.pending_approval_count > 0 {
                    Some("approval")
                } else if attention.pending_question_count > 0
                    || matches!(thread.status, ThreadStatus::WaitingForInput)
                {
                    Some("question")
                } else {
                    None
                };
                match (needs_user, track.waiting) {
                    (Some(kind), None) => track.waiting = Some((now, kind)),
                    (None, Some((since, kind))) => {
                        track.waiting = None;
                        records.push(Record::Wait {
                            t: now,
                            th: thread.id.clone(),
                            ms: (now - since).num_milliseconds().max(0) as u64,
                            k: kind.into(),
                        });
                    }
                    _ => {}
                }
                if !in_turn && let Some(start) = track.started.take() {
                    // No baseline means no usage was reported during the turn.
                    let (i, out) = match (track.latest, track.at_start.take()) {
                        (Some(end), Some(start)) => {
                            (end.0.saturating_sub(start.0), end.1.saturating_sub(start.1))
                        }
                        _ => (0, 0),
                    };
                    records.push(Record::Turn {
                        t: now,
                        th: thread.id.clone(),
                        ok: !matches!(thread.status, ThreadStatus::Error),
                        ms: (now - start).num_milliseconds().max(0) as u64,
                        i,
                        out,
                        ctx: std::mem::take(&mut track.peak),
                    });
                }
            }
            UnifiedEvent::ThreadTokenUsageUpdated { usage } => {
                let Some(thread) = envelope.thread_id.clone() else {
                    continue;
                };
                let track = threads.entry(thread).or_default();
                let in_turn = track.started.is_some();
                let context = match &usage.last {
                    Some(last) => {
                        let total = (usage.total.input_tokens, usage.total.output_tokens);
                        // First report with no baseline (e.g. after a restart): the
                        // total before this request is where the turn started.
                        if in_turn && track.at_start.is_none() {
                            track.at_start = Some((
                                total.0.saturating_sub(last.input_tokens),
                                total.1.saturating_sub(last.output_tokens),
                            ));
                        }
                        track.latest = Some(total);
                        last.input_tokens
                    }
                    None => usage.total.total_tokens,
                };
                if in_turn {
                    track.peak = track.peak.max(context);
                }
            }
            UnifiedEvent::File {
                path: Some(path), ..
            } if !path.trim().is_empty() => {
                if let Some(thread) = envelope.thread_id.clone() {
                    records.push(Record::File {
                        t: now,
                        th: thread,
                        path: path.clone(),
                    });
                }
            }
            _ => {}
        }
        for record in records {
            if let Ok(line) = serde_json::to_string(&record) {
                let _ = tx.try_send(Job::Event(line));
            }
        }
    }
}

impl Recorder {
    pub(super) fn new(state_path: &Path, events: broadcast::Receiver<Arc<CachedEnvelope>>) -> Self {
        let dir = state_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("analytics");
        let saved = std::fs::read(settings_path(&dir))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let settings = Arc::new(StdMutex::new(saved));
        let (tx, rx) = mpsc::channel(QUEUE);
        let writer = (dir.clone(), settings.clone());
        let spawned = std::thread::Builder::new()
            .name("falcondeck-analytics-writer".into())
            .spawn(move || write_loop(writer.0, writer.1, rx));
        if spawned.is_ok() {
            let listener = (settings.clone(), tx.clone());
            let _ = std::thread::Builder::new()
                .name("falcondeck-analytics-events".into())
                .spawn(move || listen_loop(events, listener.0, listener.1));
        }
        Self { dir, settings, tx }
    }

    fn settings(&self) -> AnalyticsSettings {
        self.settings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn record(&self, record: Record) {
        if self.settings().enabled
            && let Ok(line) = serde_json::to_string(&record)
        {
            let _ = self.tx.try_send(Job::Event(line));
        }
    }

    fn prompt(&self, prompt: &AnalyticsPrompt) {
        let settings = self.settings();
        if settings.enabled
            && settings.record_prompts
            && let Ok(line) = serde_json::to_string(prompt)
        {
            let _ = self.tx.try_send(Job::Prompt(line));
        }
    }

    /// Waits until everything queued so far is on disk.
    async fn flush(&self) {
        let (done, wait) = oneshot::channel();
        if self.tx.send(Job::Flush(done)).await.is_ok() {
            let _ = wait.await;
        }
    }
}

/// Short, content-free replies that add no information.
fn ack_like(message: &str) -> bool {
    let text = message.trim().to_lowercase();
    let words = text.split_whitespace().count();
    const OPENERS: [&str; 16] = [
        "ok",
        "okay",
        "thanks",
        "thank you",
        "got it",
        "noted",
        "ack",
        "acknowledged",
        "will do",
        "sounds good",
        "great",
        "perfect",
        "understood",
        "done",
        "cheers",
        "👍",
    ];
    words <= 3 || (words <= 20 && OPENERS.iter().any(|opener| text.starts_with(opener)))
}

/// A tool call that reached a final state.
struct FinishedTool<'a> {
    kind: &'a str,
    title: &'a str,
    /// Full command when the provider supplies it; titles can be truncated.
    command: &'a str,
    output: &'a str,
    /// Completed without a failing exit code.
    ok: bool,
}

fn finished_tool(item: &ConversationItem) -> Option<FinishedTool<'_>> {
    let ConversationItem::ToolCall {
        title,
        tool_kind,
        status,
        exit_code,
        output,
        detail,
        ..
    } = item
    else {
        return None;
    };
    let completed = status.eq_ignore_ascii_case("completed");
    if !completed && !status.eq_ignore_ascii_case("failed") && !status.eq_ignore_ascii_case("error")
    {
        return None;
    }
    let command = match detail.as_deref() {
        Some(falcondeck_core::ToolCallDetail::CommandExecution { command, .. }) => command.as_str(),
        _ => title.as_str(),
    };
    Some(FinishedTool {
        kind: tool_kind.as_str(),
        title: title.as_str(),
        command,
        output: output.as_deref().unwrap_or_default(),
        ok: completed && !exit_code.is_some_and(|code| code != 0),
    })
}

/// Splits a shell line into commands at unquoted `&&`, `||`, `;`, `|` and
/// newlines, returning each command with the operator that follows it.
fn shell_commands(line: &str) -> Vec<(String, Option<&'static str>)> {
    let mut commands = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(open), c) if c == open => {
                quote = None;
                current.push(c);
            }
            (Some(_), c) => current.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                current.push(c);
            }
            (None, '&') if chars.peek() == Some(&'&') => {
                chars.next();
                commands.push((std::mem::take(&mut current), Some("&&")));
            }
            (None, '|') if chars.peek() == Some(&'|') => {
                chars.next();
                commands.push((std::mem::take(&mut current), Some("||")));
            }
            (None, '|') => commands.push((std::mem::take(&mut current), Some("|"))),
            (None, ';' | '\n') => commands.push((std::mem::take(&mut current), Some(";"))),
            (None, c) => current.push(c),
        }
    }
    commands.push((current, None));
    commands.retain(|(command, _)| !command.trim().is_empty());
    commands
}

/// Whether one command (not a whole line) is `git … commit`, excluding dry runs.
fn runs_git_commit(command: &str) -> bool {
    let words: Vec<&str> = command
        .split_whitespace()
        // Leading `VAR=value` assignments are not the command.
        .skip_while(|word| word.contains('=') && !word.starts_with('-'))
        .collect();
    let Some(program) = words.first() else {
        return false;
    };
    if *program != "git" && !program.ends_with("/git") {
        return false;
    }
    let mut next = 1;
    while let Some(word) = words.get(next) {
        match *word {
            "-C" | "-c" | "--git-dir" | "--work-tree" => next += 2,
            flag if flag.starts_with('-') => next += 1,
            subcommand => {
                return subcommand == "commit" && !words.contains(&"--dry-run");
            }
        }
    }
    false
}

/// A line git prints for a new commit, such as `[main 1a2b3c4] Message`.
fn is_commit_summary(line: &str) -> bool {
    let Some(rest) = line.trim_start().strip_prefix('[') else {
        return false;
    };
    let Some((inside, _)) = rest.split_once(']') else {
        return false;
    };
    let words: Vec<&str> = inside.split_whitespace().collect();
    words.len() >= 2
        && words.last().is_some_and(|hash| {
            (7..=40).contains(&hash.len()) && hash.chars().all(|c| c.is_ascii_hexdigit())
        })
}

/// Commits a finished shell call made. Git's own summary lines are the evidence;
/// a quiet commit counts only when the whole call succeeded with nothing after
/// it that could have masked a failure (`||`).
fn commits_made(tool: &FinishedTool) -> u64 {
    let kind = tool.kind.to_ascii_lowercase();
    if !["bash", "shell", "command", "exec"]
        .iter()
        .any(|shell| kind.contains(shell))
    {
        return 0;
    }
    let commands = shell_commands(tool.command);
    let Some(first) = commands
        .iter()
        .position(|(command, _)| runs_git_commit(command))
    else {
        return 0;
    };
    let confirmed = tool
        .output
        .lines()
        .filter(|line| is_commit_summary(line))
        .count() as u64;
    if confirmed > 0 {
        return confirmed;
    }
    let masked = commands[first..]
        .iter()
        .any(|(_, operator)| *operator == Some("||"));
    if tool.ok && !masked {
        commands
            .iter()
            .filter(|(command, _)| runs_git_commit(command))
            .count() as u64
    } else {
        0
    }
}

fn excerpt(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT_CHARS {
        flat
    } else {
        format!("{}…", flat.chars().take(EXCERPT_CHARS).collect::<String>())
    }
}

fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4)
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Reads records newer than `since` from the monthly files.
fn read_records(dir: &Path, since: DateTime<Utc>) -> Vec<Record> {
    months_since(since)
        .iter()
        .filter_map(|month| std::fs::File::open(dir.join(format!("events-{month}.jsonl"))).ok())
        .flat_map(|file| std::io::BufReader::new(file).lines().map_while(Result::ok))
        .filter_map(|line| serde_json::from_str::<Record>(&line).ok())
        .filter(|record| record_time(record) >= since)
        .collect()
}

fn record_time(record: &Record) -> DateTime<Utc> {
    match record {
        Record::User { t, .. }
        | Record::Agent { t, .. }
        | Record::Delegate { t, .. }
        | Record::Turn { t, .. }
        | Record::File { t, .. }
        | Record::Context { t, .. }
        | Record::Wait { t, .. }
        | Record::Commit { t, .. } => *t,
    }
}

/// Current names for threads, bots and projects, used to label stored ids.
struct Labels {
    titles: HashMap<String, String>,
    providers: HashMap<String, String>,
    projects: HashMap<String, String>,
    bots: HashMap<String, String>,
    /// Task thread to the thread that created it.
    parents: HashMap<String, String>,
}

impl Labels {
    fn title(&self, thread: &str) -> String {
        self.bots
            .get(thread)
            .or_else(|| self.titles.get(thread))
            .cloned()
            .unwrap_or_else(|| thread.to_string())
    }

    /// The bot whose home this is, or whose task this is.
    fn bot_of(&self, thread: &str) -> Option<&String> {
        self.bots.get(thread).or_else(|| {
            self.parents
                .get(thread)
                .and_then(|parent| self.bots.get(parent))
        })
    }
}

/// Value at quantile `q` (0–1) of `values`, or 0 when empty.
fn quantile(values: &mut [u64], q: f64) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let index = ((values.len() - 1) as f64 * q).round() as usize;
    values[index.min(values.len() - 1)]
}

fn summarize(records: Vec<Record>, labels: &Labels, days: u32) -> AnalyticsSummary {
    #[derive(Default)]
    struct PairStats {
        messages: u64,
        chars: u64,
        ack: u64,
    }
    #[derive(Default)]
    struct BotStats {
        turns: u64,
        ms: u64,
        context: u64,
        context_turns: u64,
        delegations: u64,
        messages: u64,
        commits: u64,
    }
    #[derive(Default)]
    struct FileStats {
        writes: u64,
        threads: HashSet<String>,
        by_day: HashMap<NaiveDate, HashSet<String>>,
    }
    #[derive(Default)]
    struct ProjectStats {
        messages: u64,
        chars: u64,
        commits: u64,
    }
    /// A turn can start this long after its cue (recorded once accepted) …
    const CUE_AFTER: i64 = 60;
    /// … or this long before (a message queued behind a running turn).
    const CUE_BEFORE: i64 = 300;
    /// Replies later than this are returns to old work, not waiting.
    const REPLY_WINDOW_DAYS: i64 = 3;

    let mut totals = AnalyticsTotals::default();
    let today = Local::now().date_naive();
    let first_day = today - chrono::Duration::days(i64::from(days.max(1)) - 1);
    let mut daily: BTreeMap<NaiveDate, AnalyticsDay> = BTreeMap::new();
    let mut day = first_day;
    while day <= today {
        daily.insert(
            day,
            AnalyticsDay {
                date: day.format("%Y-%m-%d").to_string(),
                ..AnalyticsDay::default()
            },
        );
        day += chrono::Duration::days(1);
    }
    let mut pairs: HashMap<(String, String), PairStats> = HashMap::new();
    let mut recent = Vec::new();
    let mut files: HashMap<String, FileStats> = HashMap::new();
    let mut bots: HashMap<String, BotStats> = HashMap::new();
    let mut providers: HashMap<String, (u64, u64, u64, u64, u64, u64, u64)> = HashMap::new();
    let mut projects: HashMap<String, ProjectStats> = HashMap::new();
    let mut cues: HashMap<String, Vec<(DateTime<Utc>, &'static str)>> = HashMap::new();
    let mut turn_starts: Vec<(String, DateTime<Utc>, DateTime<Utc>)> = Vec::new();
    let mut turn_ends: HashMap<String, Vec<DateTime<Utc>>> = HashMap::new();
    let mut replies: Vec<(String, DateTime<Utc>)> = Vec::new();
    let mut request_waits = Vec::new();
    let project_of = |ws: &str, th: &str| {
        labels
            .bots
            .get(th)
            .or_else(|| labels.projects.get(ws))
            .cloned()
            .unwrap_or_else(|| ws.to_string())
    };
    for record in records {
        let date = record_time(&record).with_timezone(&Local).date_naive();
        let entry = daily.get_mut(&date);
        match record {
            Record::User { t, ws, th, n, o } => {
                if o == "scheduled" {
                    totals.scheduled_messages += 1;
                    cues.entry(th).or_default().push((t, "scheduled"));
                    continue;
                }
                totals.user_messages += 1;
                if let Some(day) = entry {
                    day.user_messages += 1;
                }
                let stats = projects.entry(project_of(&ws, &th)).or_default();
                stats.messages += 1;
                stats.chars += n;
                cues.entry(th.clone()).or_default().push((t, "user"));
                replies.push((th, t));
            }
            Record::Agent {
                t,
                from,
                to,
                n,
                ack,
                x,
                ..
            } => {
                totals.agent_messages += 1;
                totals.ack_like_messages += u64::from(ack);
                if let Some(day) = entry {
                    day.agent_messages += 1;
                }
                if let Some(bot) = labels.bots.get(&from) {
                    bots.entry(bot.clone()).or_default().messages += 1;
                }
                cues.entry(to.clone()).or_default().push((t, "agent"));
                recent.push(AnalyticsAgentMessage {
                    at: t,
                    from_title: labels.title(&from),
                    to_title: labels.title(&to),
                    chars: n,
                    ack_like: ack,
                    excerpt: x,
                });
                let stats = pairs.entry((from, to)).or_default();
                stats.messages += 1;
                stats.chars += n;
                stats.ack += u64::from(ack);
            }
            Record::Delegate {
                t, parent, child, ..
            } => {
                totals.delegations += 1;
                if let Some(bot) = labels.bots.get(&parent) {
                    bots.entry(bot.clone()).or_default().delegations += 1;
                }
                cues.entry(child).or_default().push((t, "delegation"));
            }
            Record::Turn {
                t,
                th,
                ok,
                ms,
                i,
                out,
                ctx,
            } => {
                totals.turns += 1;
                totals.failed_turns += u64::from(!ok);
                if let Some(day) = entry {
                    day.turns += 1;
                }
                if let Some(bot) = labels.bots.get(&th) {
                    let stats = bots.entry(bot.clone()).or_default();
                    stats.turns += 1;
                    stats.ms += ms;
                }
                let provider = labels
                    .providers
                    .get(&th)
                    .cloned()
                    .unwrap_or_else(|| "unknown".into());
                let stats = providers.entry(provider).or_default();
                stats.0 += 1;
                stats.1 += u64::from(!ok);
                stats.2 += ms;
                stats.3 += i;
                stats.4 += out;
                stats.5 += ctx;
                // Only turns with a context reading count toward its average.
                stats.6 += u64::from(ctx > 0);
                let start = t - chrono::Duration::milliseconds(ms as i64);
                turn_starts.push((th.clone(), start, t));
                turn_ends.entry(th).or_default().push(t);
            }
            Record::File { th, path, .. } => {
                totals.file_writes += 1;
                let stats = files.entry(path).or_default();
                stats.writes += 1;
                stats.threads.insert(th.clone());
                stats.by_day.entry(date).or_default().insert(th);
            }
            Record::Context { th, tok, .. } => {
                if let Some(bot) = labels.bots.get(&th) {
                    let stats = bots.entry(bot.clone()).or_default();
                    stats.context += tok;
                    stats.context_turns += 1;
                }
            }
            Record::Wait { ms, .. } => request_waits.push(ms),
            Record::Commit { ws, th, .. } => {
                totals.commits += 1;
                if let Some(day) = entry {
                    day.commits += 1;
                }
                if let Some(bot) = labels.bot_of(&th) {
                    bots.entry(bot.clone()).or_default().commits += 1;
                }
                projects.entry(project_of(&ws, &th)).or_default().commits += 1;
            }
        }
    }

    // What started each turn: the closest unused cue for that thread around its
    // start. Each cue starts at most one turn; later turns are continuations.
    let mut triggers = AnalyticsTriggers::default();
    let mut used: HashSet<(String, usize)> = HashSet::new();
    turn_starts.sort_by_key(|(_, start, _)| *start);
    for (thread, start, end) in &turn_starts {
        let cue = cues.get(thread).and_then(|cues| {
            cues.iter()
                .enumerate()
                .filter(|(index, (at, _))| {
                    // Nothing after a turn ended can have started it.
                    let offset = (*at - *start).num_seconds();
                    (-CUE_BEFORE..=CUE_AFTER).contains(&offset)
                        && at <= end
                        && !used.contains(&(thread.clone(), *index))
                })
                .min_by_key(|(_, (at, _))| (*at - *start).num_seconds().abs())
                .map(|(index, (_, kind))| (index, *kind))
        });
        let cue = cue.map(|(index, kind)| {
            used.insert((thread.clone(), index));
            kind
        });
        match cue {
            Some("user") => triggers.user += 1,
            Some("scheduled") => triggers.scheduled += 1,
            Some("agent") => triggers.agent += 1,
            Some("delegation") => triggers.delegation += 1,
            _ => triggers.other += 1,
        }
    }

    // How long a finished agent waited for the user's next message there.
    let mut reply_times = Vec::new();
    let mut answered: HashSet<(String, DateTime<Utc>)> = HashSet::new();
    replies.sort_by_key(|(_, at)| *at);
    for (thread, at) in replies {
        let finished = turn_ends
            .get(&thread)
            .and_then(|ends| ends.iter().filter(|end| **end <= at).max().copied());
        if let Some(end) = finished
            && at - end <= chrono::Duration::days(REPLY_WINDOW_DAYS)
            && answered.insert((thread, end))
        {
            reply_times.push((at - end).num_milliseconds().max(0) as u64);
        }
    }
    let waiting = AnalyticsWaiting {
        requests: request_waits.len() as u64,
        median_request_wait_ms: quantile(&mut request_waits, 0.5),
        replies: reply_times.len() as u64,
        median_reply_ms: quantile(&mut reply_times, 0.5),
        p90_reply_ms: quantile(&mut reply_times, 0.9),
    };

    let mut agent_pairs: Vec<_> = pairs
        .into_iter()
        .map(|((from, to), stats)| AnalyticsAgentPair {
            from_title: labels.title(&from),
            to_title: labels.title(&to),
            from,
            to,
            messages: stats.messages,
            avg_chars: stats.chars / stats.messages.max(1),
            ack_like: stats.ack,
        })
        .collect();
    agent_pairs.sort_by(|a, b| {
        b.messages
            .cmp(&a.messages)
            .then(a.from_title.cmp(&b.from_title))
    });
    agent_pairs.truncate(20);
    recent.sort_by(|a, b| b.at.cmp(&a.at));
    recent.truncate(20);
    let mut files: Vec<_> = files
        .into_iter()
        .map(|(path, stats)| AnalyticsFile {
            path,
            writes: stats.writes,
            threads: stats.threads.len() as u64,
            contested_days: stats
                .by_day
                .values()
                .filter(|threads| threads.len() > 1)
                .count() as u64,
        })
        .collect();
    files.sort_by(|a, b| b.writes.cmp(&a.writes).then(a.path.cmp(&b.path)));
    files.truncate(25);
    let mut bots: Vec<_> = bots
        .into_iter()
        .map(|(name, stats)| AnalyticsBot {
            name,
            turns: stats.turns,
            avg_turn_ms: stats.ms / stats.turns.max(1),
            avg_context_tokens: stats.context / stats.context_turns.max(1),
            delegations: stats.delegations,
            messages_sent: stats.messages,
            commits: stats.commits,
        })
        .collect();
    bots.sort_by(|a, b| b.turns.cmp(&a.turns).then(a.name.cmp(&b.name)));
    let mut providers: Vec<_> = providers
        .into_iter()
        .map(
            |(provider, (turns, failed, ms, i, out, ctx, measured))| AnalyticsProvider {
                provider,
                turns,
                failed,
                avg_turn_ms: ms / turns.max(1),
                input_tokens: i,
                output_tokens: out,
                avg_peak_context_tokens: ctx / measured.max(1),
            },
        )
        .collect();
    providers.sort_by(|a, b| b.turns.cmp(&a.turns).then(a.provider.cmp(&b.provider)));
    let mut projects: Vec<_> = projects
        .into_iter()
        .map(|(project, stats)| AnalyticsProject {
            project,
            messages: stats.messages,
            avg_chars: stats.chars / stats.messages.max(1),
            commits: stats.commits,
        })
        .collect();
    projects.sort_by(|a, b| {
        (b.messages + b.commits)
            .cmp(&(a.messages + a.commits))
            .then(a.project.cmp(&b.project))
    });
    projects.truncate(15);
    AnalyticsSummary {
        days,
        generated_at: Utc::now(),
        totals,
        daily: daily.into_values().collect(),
        agent_pairs,
        recent_agent_messages: recent,
        files,
        bots,
        providers,
        projects,
        triggers,
        waiting,
        automations: Vec::new(),
    }
}

/// Runs per scheduled task, busiest first.
fn summarize_automations(
    runs: Vec<falcondeck_core::control::AutomationRun>,
) -> Vec<AnalyticsAutomation> {
    use falcondeck_core::control::AutomationRunStatus as Status;
    let mut by_name: BTreeMap<String, (AnalyticsAutomation, HashSet<String>)> = BTreeMap::new();
    for run in runs {
        let (summary, threads) = by_name
            .entry(run.automation_name.clone())
            .or_insert_with(|| {
                (
                    AnalyticsAutomation {
                        name: run.automation_name.clone(),
                        runs: 0,
                        no_action: 0,
                        failed: 0,
                        skipped: 0,
                        threads: 0,
                    },
                    HashSet::new(),
                )
            });
        summary.runs += 1;
        match run.status {
            Status::SucceededNoAction => summary.no_action += 1,
            Status::Failed => summary.failed += 1,
            Status::SkippedOverlap | Status::SkippedDependency => summary.skipped += 1,
            _ => {}
        }
        if let Some(thread) = run.thread_id {
            threads.insert(thread);
        }
    }
    let mut automations: Vec<_> = by_name
        .into_values()
        .map(|(mut summary, threads)| {
            summary.threads = threads.len() as u64;
            summary
        })
        .collect();
    automations.sort_by(|a, b| b.runs.cmp(&a.runs).then(a.name.cmp(&b.name)));
    automations
}

impl AppState {
    fn analytics(&self) -> &Recorder {
        &self.inner.analytics
    }

    /// Called for each live (not replayed) conversation item when it is first added.
    pub(super) fn analytics_new_item(
        &self,
        workspace_id: &str,
        project_path: Option<&str>,
        thread: &ManagedThread,
        item: &ConversationItem,
    ) {
        match item {
            ConversationItem::UserMessage { id, text, .. } => {
                // Resumes and automatic retries are not new messages.
                if id.starts_with("user-resume-")
                    || super::harness_user_text::is_transient_retry_user_text(text)
                {
                    return;
                }
                let summary = &thread.summary;
                // Agent messages are recorded by the messaging tool; a delegated
                // task's first message is its brief, recorded at creation.
                let delegated_brief = matches!(
                    summary.origin,
                    Some(falcondeck_core::ThreadOrigin::AgentSpawn { .. })
                ) && thread
                    .items
                    .iter()
                    .filter(|item| matches!(item, ConversationItem::UserMessage { .. }))
                    .count()
                    <= 1;
                let scheduled = text.starts_with(AUTOMATION_MESSAGE_PREFIX);
                let now = Utc::now();
                self.analytics_bot_context(&summary.id);
                if text.starts_with(AGENT_MESSAGE_PREFIX) || delegated_brief {
                    return;
                }
                self.analytics().record(Record::User {
                    t: now,
                    ws: workspace_id.to_string(),
                    th: summary.id.clone(),
                    n: text.chars().count() as u64,
                    o: if scheduled { "scheduled" } else { "user" }.into(),
                });
                if !scheduled {
                    self.analytics().prompt(&AnalyticsPrompt {
                        at: now,
                        project: project_path.map(folder_name).unwrap_or_default(),
                        thread_id: summary.id.clone(),
                        title: summary.title.clone(),
                        provider: summary.provider.to_string(),
                        text: text.clone(),
                    });
                }
            }
            ConversationItem::ToolCall { .. } => self.analytics_tool(thread, item),
            _ => {}
        }
    }

    /// Called when a live item is replaced; counts a tool's effect once it completes.
    pub(super) fn analytics_updated_item(
        &self,
        thread: &ManagedThread,
        previous: &ConversationItem,
        item: &ConversationItem,
    ) {
        if finished_tool(previous).is_none() {
            self.analytics_tool(thread, item);
        }
    }

    /// File writes and commits from a tool call that finished successfully.
    fn analytics_tool(&self, thread: &ManagedThread, item: &ConversationItem) {
        let Some(tool) = finished_tool(item) else {
            return;
        };
        let th = thread.summary.id.clone();
        if EDIT_TOOLS.contains(&tool.kind) {
            let path = tool
                .title
                .strip_prefix(tool.kind)
                .map(str::trim)
                .unwrap_or_default();
            if tool.ok && !path.is_empty() {
                self.analytics().record(Record::File {
                    t: Utc::now(),
                    th,
                    path: path.to_string(),
                });
            }
            return;
        }
        for _ in 0..commits_made(&tool) {
            self.analytics().record(Record::Commit {
                t: Utc::now(),
                ws: thread.summary.workspace_id.clone(),
                th: th.clone(),
            });
        }
    }

    /// Records how much context a bot turn carries, off the caller's path.
    fn analytics_bot_context(&self, thread_id: &str) {
        if !self.analytics().settings().enabled {
            return;
        }
        let app = self.clone();
        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            if let Some(context) = app.bot_context(&thread_id).await {
                app.analytics().record(Record::Context {
                    t: Utc::now(),
                    th: thread_id,
                    tok: estimate_tokens(&context),
                });
            }
        });
    }

    pub(super) fn analytics_agent_message(
        &self,
        from: &str,
        to: &str,
        message: &str,
        delivery: &str,
    ) {
        self.analytics().record(Record::Agent {
            t: Utc::now(),
            from: from.to_string(),
            to: to.to_string(),
            n: message.chars().count() as u64,
            d: delivery.to_string(),
            ack: ack_like(message),
            x: excerpt(message),
        });
    }

    pub(super) fn analytics_delegation(&self, parent: &str, child: &str, prompt: Option<&str>) {
        self.analytics().record(Record::Delegate {
            t: Utc::now(),
            parent: parent.to_string(),
            child: child.to_string(),
            n: prompt.map_or(0, |prompt| prompt.chars().count() as u64),
        });
    }

    pub async fn analytics_status(&self) -> AnalyticsStatus {
        let recorder = self.analytics();
        recorder.flush().await;
        let dir = recorder.dir.clone();
        let (events_bytes, prompts_bytes) = tokio::task::spawn_blocking(move || {
            let size = |prefix| {
                files_with_prefix(&dir, prefix)
                    .iter()
                    .filter_map(|path| std::fs::metadata(path).ok())
                    .map(|meta| meta.len())
                    .sum::<u64>()
            };
            (size("events-"), size("prompts-"))
        })
        .await
        .unwrap_or_default();
        AnalyticsStatus {
            settings: recorder.settings(),
            folder: recorder.dir.to_string_lossy().into(),
            events_bytes,
            prompts_bytes,
        }
    }

    pub async fn update_analytics_settings(
        &self,
        settings: AnalyticsSettings,
    ) -> Result<AnalyticsStatus, DaemonError> {
        if !(1..=120).contains(&settings.retention_months) {
            return Err(DaemonError::BadRequest(
                "Keep activity for 1 to 120 months".into(),
            ));
        }
        let recorder = self.analytics();
        super::storage::write_atomically(
            &settings_path(&recorder.dir),
            serde_json::to_vec_pretty(&settings)?,
        )
        .await?;
        *recorder.settings.lock().unwrap_or_else(|p| p.into_inner()) = settings.clone();
        let dir = recorder.dir.clone();
        let _ = tokio::task::spawn_blocking(move || prune(&dir, settings.retention_months)).await;
        Ok(self.analytics_status().await)
    }

    pub async fn clear_analytics(
        &self,
        target: AnalyticsClearTarget,
    ) -> Result<AnalyticsStatus, DaemonError> {
        let (done, wait) = oneshot::channel();
        self.analytics()
            .tx
            .send(Job::Clear(target, done))
            .await
            .map_err(|_| DaemonError::Process("analytics writer stopped".into()))?;
        wait.await
            .map_err(|_| DaemonError::Process("analytics writer stopped".into()))??;
        Ok(self.analytics_status().await)
    }

    async fn analytics_labels(&self) -> Labels {
        let (mut titles, mut providers, mut projects, mut parents) = (
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        );
        for workspace in self.inner.workspaces.lock().await.values() {
            projects.insert(
                workspace.summary.id.clone(),
                folder_name(&workspace.summary.path),
            );
            for thread in workspace.threads.values() {
                titles.insert(thread.summary.id.clone(), thread.summary.title.clone());
                providers.insert(
                    thread.summary.id.clone(),
                    thread.summary.provider.to_string(),
                );
                if let Some(falcondeck_core::ThreadOrigin::AgentSpawn { parent_thread_id }) =
                    &thread.summary.origin
                {
                    parents.insert(thread.summary.id.clone(), parent_thread_id.clone());
                }
            }
        }
        let bots = self
            .inner
            .preferences
            .lock()
            .await
            .bots
            .iter()
            .map(|bot| (bot.thread_id.clone(), bot.name.clone()))
            .collect();
        Labels {
            titles,
            providers,
            projects,
            bots,
            parents,
        }
    }

    pub async fn analytics_summary(&self, days: u32) -> Result<AnalyticsSummary, DaemonError> {
        let days = days.clamp(1, 366);
        self.analytics().flush().await;
        let labels = self.analytics_labels().await;
        let dir = self.analytics().dir.clone();
        // Start at local midnight of the first charted day, so totals and the
        // daily buckets cover the same calendar days.
        let first_day = Local::now().date_naive() - chrono::Duration::days(i64::from(days) - 1);
        let since = first_day
            .and_hms_opt(0, 0, 0)
            .and_then(|midnight| midnight.and_local_timezone(Local).earliest())
            .map_or_else(
                || Utc::now() - chrono::Duration::days(i64::from(days)),
                |start| start.with_timezone(&Utc),
            );
        let runs = self.control().runs_since(since).await;
        let mut summary = tokio::task::spawn_blocking(move || {
            summarize(read_records(&dir, since), &labels, days)
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))?;
        summary.automations = summarize_automations(runs);
        Ok(summary)
    }

    /// The user's recorded messages, newest first.
    pub async fn analytics_prompts(
        &self,
        query: Option<String>,
        limit: usize,
    ) -> Result<Vec<AnalyticsPrompt>, DaemonError> {
        self.analytics().flush().await;
        let dir = self.analytics().dir.clone();
        let needle = query
            .map(|query| query.trim().to_lowercase())
            .filter(|query| !query.is_empty());
        let limit = limit.clamp(1, 500);
        tokio::task::spawn_blocking(move || {
            let mut found = Vec::new();
            for path in files_with_prefix(&dir, "prompts-").iter().rev() {
                let Ok(file) = std::fs::File::open(path) else {
                    continue;
                };
                let mut month: Vec<AnalyticsPrompt> = std::io::BufReader::new(file)
                    .lines()
                    .map_while(Result::ok)
                    .filter_map(|line| serde_json::from_str::<AnalyticsPrompt>(&line).ok())
                    .filter(|prompt| {
                        needle.as_ref().is_none_or(|needle| {
                            [&prompt.text, &prompt.title, &prompt.project]
                                .iter()
                                .any(|field| field.to_lowercase().contains(needle))
                        })
                    })
                    .collect();
                month.sort_by(|a, b| b.at.cmp(&a.at));
                found.extend(month);
                if found.len() >= limit {
                    break;
                }
            }
            found.truncate(limit);
            found
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acknowledgements_are_flagged_but_substance_is_not() {
        assert!(ack_like("Thanks, got it."));
        assert!(ack_like("OK"));
        assert!(ack_like(
            "Noted — will pick this up after the current turn."
        ));
        assert!(!ack_like(
            "Blocked: the relay deploy needs your approval before I can continue the migration."
        ));
    }

    fn shell(command: &str, output: &str, ok: bool) -> u64 {
        commits_made(&FinishedTool {
            kind: "Bash",
            title: command,
            command,
            output,
            ok,
        })
    }

    #[test]
    fn commits_count_only_when_git_commit_runs_and_succeeds() {
        let made = "[main 1a2b3c4] Fix the thing\n 1 file changed";
        // Git's summary line is the evidence, even if a later command fails.
        assert_eq!(shell("git commit -m fix && git push", made, false), 1);
        assert_eq!(shell("cd /repo && git -C . commit -m fix", made, true), 1);
        assert_eq!(
            shell(
                "/usr/bin/git commit --amend --no-edit",
                "[detached HEAD 9f8e7d6] x",
                true
            ),
            1
        );
        // Quiet commits count only when nothing could have masked a failure.
        assert_eq!(shell("git add a && git commit -q -m x", "", true), 1);
        assert_eq!(shell("git commit -q -m x || true", "", true), 0);
        assert_eq!(shell("git commit -m x", "nothing to commit", false), 0);
        // Text that merely mentions a commit runs none.
        assert_eq!(shell("echo please run git commit", made, true), 0);
        assert_eq!(shell("echo 'git commit -m x' > notes.txt", made, true), 0);
        assert_eq!(shell("git commit-tree abc -p def -m x", "abc1234", true), 0);
        assert_eq!(shell("git commit --dry-run", "", true), 0);
        assert_eq!(shell("git log --grep commit", made, true), 0);
        // Not a shell tool.
        assert_eq!(
            commits_made(&FinishedTool {
                kind: "WebSearch",
                title: "git commit",
                command: "git commit",
                output: made,
                ok: true,
            }),
            0
        );
    }

    #[test]
    fn excerpts_flatten_whitespace_and_cap_length() {
        assert_eq!(excerpt("a\n\n  b"), "a b");
        let long = "word ".repeat(100);
        assert!(excerpt(&long).chars().count() <= EXCERPT_CHARS + 1);
    }

    #[test]
    fn retention_keeps_the_current_window() {
        let dir = tempfile::tempdir().unwrap();
        let now = Utc::now();
        let current = format!("events-{}.jsonl", month_of(now));
        for name in [
            current.as_str(),
            "events-2000-01.jsonl",
            "prompts-2000-01.jsonl",
        ] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }
        prune(dir.path(), 12);
        assert!(dir.path().join(&current).exists());
        assert!(!dir.path().join("events-2000-01.jsonl").exists());
        // The user's messages are never pruned automatically.
        assert!(dir.path().join("prompts-2000-01.jsonl").exists());
    }

    #[test]
    fn months_since_spans_year_boundaries() {
        let since = Utc::now() - chrono::Duration::days(400);
        let months = months_since(since);
        assert!(months.len() >= 13);
        assert_eq!(months.last().unwrap(), &month_of(Utc::now()));
    }
}
