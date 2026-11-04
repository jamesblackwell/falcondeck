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
    AnalyticsProvider, AnalyticsSettings, AnalyticsStatus, AnalyticsSummary, AnalyticsUsage,
    AnalyticsUsageReport, AnalyticsUsageRow, AnalyticsUsageThread, AnalyticsUsageTotals,
    AnalyticsThreadActivity, AnalyticsThreadDispatch, AnalyticsThreadMessage, AnalyticsTotals,
    AnalyticsTriggers, AnalyticsWaiting,
};
use falcondeck_core::TokenUsageBreakdown;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufWriter, Write as _};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{mpsc, oneshot};

use crate::claude::ClaudeModelUsage;

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
    /// A model choice for a new thread or a routing preview. `auto` is false
    /// when the creator named the model itself; `th` is absent for previews.
    Route {
        t: DateTime<Utc>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        th: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
        auto: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        /// Task-type confidence and flag probabilities, 0–100.
        #[serde(default)]
        conf: u8,
        /// Difficulty × 10 (10–50); 0 when unclassified.
        #[serde(default)]
        diff: u8,
        #[serde(default)]
        risk: u8,
        #[serde(default)]
        social: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rule: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        m: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        eff: Option<String>,
    },
}

/// One model's usage in one finished turn, written to `usage-YYYY-MM.jsonl`.
/// Attribution is frozen at write time; nothing is resolved at read time
/// except display labels. Field names are short because there are many lines.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct UsageRecord {
    t: DateTime<Utc>,
    /// Turn identity within the provider, e.g. `claude:<session>:<ms>`.
    id: String,
    /// `live`; a backfill importer will reuse the file with `backfill`.
    src: String,
    th: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    par: Option<String>,
    /// Root of the thread's spawn chain (the thread itself when top-level).
    root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bot: Option<String>,
    /// `user`, `agent_spawn`, `scheduled` or `automation`.
    org: String,
    ws: String,
    prov: String,
    model: String,
    /// Uncached input tokens.
    #[serde(rename = "in")]
    uncached_input: u64,
    cr: u64,
    cw: u64,
    out: u64,
    /// Reasoning tokens, a subset of `out`.
    #[serde(default)]
    think: u64,
    /// Model calls the totals were built from, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    calls: Option<u64>,
    /// Provider-reported (or converted) API-equivalent USD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cost: Option<f64>,
    /// `provider`, `provider_unverified` or `none`.
    cost_src: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    /// Raw vendor cost field (Grok `costUsdTicks`), kept because its unit is
    /// unconfirmed and the conversion may need correcting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cost_ticks: Option<u64>,
}

/// Wrapper giving usage lines the same `"e"` tag as activity records, so one
/// reader can tell record kinds apart when the backfill importer arrives.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "e", rename_all = "snake_case")]
enum UsageEntry {
    Usage(UsageRecord),
}

/// One model's usage in one finished turn, handed over by a capture point.
/// Borrowed fields are copied before the recording task is spawned.
pub(super) struct TurnUsage<'a> {
    pub workspace_id: &'a str,
    pub thread_id: &'a str,
    /// Provider id; empty to read it from the thread summary.
    pub provider: &'a str,
    /// Model id as the harness reported it; empty to fall back to the
    /// thread's agent selection.
    pub model: &'a str,
    /// Uncached input tokens.
    pub uncached_input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    /// Reasoning tokens, a subset of `output`.
    pub reasoning: u64,
    pub calls: Option<u64>,
    pub cost: Option<f64>,
    /// `provider`, `provider_unverified` or `none`.
    pub cost_source: &'a str,
    pub tier: Option<String>,
    pub effort: Option<String>,
    pub cost_ticks: Option<u64>,
    /// Record id, unique per turn and model, e.g. `grok:<prompt_id>`.
    pub id: String,
}

/// Owned copy of [`TurnUsage`] moved into the recording task.
struct OwnedTurnUsage {
    workspace_id: String,
    thread_id: String,
    provider: String,
    model: String,
    uncached_input: u64,
    cache_read: u64,
    cache_write: u64,
    output: u64,
    reasoning: u64,
    calls: Option<u64>,
    cost: Option<f64>,
    cost_source: String,
    tier: Option<String>,
    effort: Option<String>,
    cost_ticks: Option<u64>,
    id: String,
}

impl TurnUsage<'_> {
    fn owned(&self) -> OwnedTurnUsage {
        OwnedTurnUsage {
            workspace_id: self.workspace_id.to_string(),
            thread_id: self.thread_id.to_string(),
            provider: self.provider.to_string(),
            model: self.model.to_string(),
            uncached_input: self.uncached_input,
            cache_read: self.cache_read,
            cache_write: self.cache_write,
            output: self.output,
            reasoning: self.reasoning,
            calls: self.calls,
            cost: self.cost,
            cost_source: self.cost_source.to_string(),
            tier: self.tier.clone(),
            effort: self.effort.clone(),
            cost_ticks: self.cost_ticks,
            id: self.id.clone(),
        }
    }
}

/// Codex token totals in one report snapshot. The five typed fields come from
/// the shared `parse_thread_token_usage`; cache writes ride alongside because
/// the shared `ThreadTokenUsage` type has no field for them.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
struct CodexTotals {
    input_tokens: u64,
    cached_input_tokens: u64,
    cache_write_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
}

impl CodexTotals {
    fn from_breakdown(total: &TokenUsageBreakdown, cache_write: u64) -> Self {
        Self {
            input_tokens: total.input_tokens,
            cached_input_tokens: total.cached_input_tokens,
            cache_write_tokens: cache_write,
            output_tokens: total.output_tokens,
            reasoning_tokens: total.reasoning_output_tokens,
        }
    }

    fn is_zero(self) -> bool {
        self == Self::default()
    }

    /// This minus `baseline`, per field, never below zero.
    fn delta_since(self, baseline: Self) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_sub(baseline.input_tokens),
            cached_input_tokens: self
                .cached_input_tokens
                .saturating_sub(baseline.cached_input_tokens),
            cache_write_tokens: self
                .cache_write_tokens
                .saturating_sub(baseline.cache_write_tokens),
            output_tokens: self.output_tokens.saturating_sub(baseline.output_tokens),
            reasoning_tokens: self
                .reasoning_tokens
                .saturating_sub(baseline.reasoning_tokens),
        }
    }
}

/// Usage accumulated for one Codex turn. Codex reports cumulative thread
/// totals, so a turn is the difference between the totals at its end and
/// where the previous turn ended (or `total - last` for a thread's very first
/// report, which already includes that turn's first request). Repeated
/// reports with unchanged totals are ignored, which also makes replayed or
/// duplicated notifications harmless.
#[derive(Default, Debug)]
pub(super) struct CodexTurnUsage {
    /// Totals last seen, kept across turns as the next turn's baseline.
    last_totals: Option<CodexTotals>,
    /// Turn (the notification's `turnId`) the current accumulation belongs to.
    turn: Option<String>,
    /// Totals where the current turn started.
    baseline: Option<CodexTotals>,
    /// Totals at the turn's latest report.
    end: Option<CodexTotals>,
    /// Reports with changed totals; each is one model request.
    calls: u64,
    /// Model selected when the turn started, when the turn notification
    /// carried one.
    model: Option<String>,
}

impl CodexTurnUsage {
    /// Folds one `thread/tokenUsage/updated` report into the accumulator.
    fn note(
        &mut self,
        turn_id: &str,
        usage: &ThreadTokenUsage,
        total_cache_write: u64,
        last_cache_write: u64,
    ) {
        // Post-compaction reports carry an all-zero `last`; they represent no
        // model request.
        if let Some(last) = &usage.last
            && last.input_tokens == 0
            && last.output_tokens == 0
            && last.reasoning_output_tokens == 0
        {
            return;
        }
        let totals = CodexTotals::from_breakdown(&usage.total, total_cache_write);
        if self.last_totals == Some(totals) {
            return;
        }
        if self.turn.as_deref() != Some(turn_id) {
            self.turn = Some(turn_id.to_string());
            self.baseline = self.last_totals;
            self.end = None;
            self.calls = 0;
        }
        if self.baseline.is_none() {
            // First report this thread has ever sent. If it names the latest
            // request, the totals before it are where the turn started;
            // otherwise nothing earlier is known, so the turn starts at the
            // current totals rather than claiming the thread's whole history.
            self.baseline = Some(usage.last.as_ref().map_or(totals, |last| {
                totals.delta_since(CodexTotals::from_breakdown(last, last_cache_write))
            }));
        }
        self.end = Some(totals);
        self.last_totals = Some(totals);
        self.calls += 1;
    }

    /// Registers the turn the next reports will belong to, with the model the
    /// turn selected. Anything accumulated for a different, never-completed
    /// turn is dropped; `last_totals` survives as the new turn's baseline.
    fn start(&mut self, turn_id: &str, model: Option<&str>) {
        if self.turn.as_deref() != Some(turn_id) {
            self.turn = Some(turn_id.to_string());
            self.baseline = None;
            self.end = None;
            self.calls = 0;
        }
        if model.is_some() {
            self.model = model.map(str::to_string);
        }
    }

    /// Closes the current accumulation, if any recorded report exists.
    fn finish(&mut self) -> Option<CodexTurnDelta> {
        let end = self.end.take()?;
        let turn = self.turn.take()?;
        let baseline = self.baseline.take().unwrap_or_default();
        let calls = std::mem::take(&mut self.calls);
        let delta = end.delta_since(baseline);
        if delta.is_zero() {
            return None;
        }
        Some(CodexTurnDelta {
            turn,
            delta,
            calls,
            model: self.model.take(),
        })
    }
}

/// One Codex turn's accumulated usage, ready to record.
pub(super) struct CodexTurnDelta {
    turn: String,
    delta: CodexTotals,
    calls: u64,
    model: Option<String>,
}

/// Per-model Claude totals last seen for one (long-lived) CLI process, used
/// to difference the cumulative `modelUsage` fallback across turns.
#[derive(Clone, Copy, Default)]
pub(super) struct ClaudeModelTotals {
    /// `[input, cache read, cache write, output, thinking]`.
    tokens: [u64; 5],
    cost_usd: f64,
}

/// The delta that carries the turn's `calls` count: the busiest model. A
/// result with several models (Opus plus a Haiku summariser) reports the
/// turn's call count once, not once per model.
fn calls_carrier(deltas: &[(&str, [u64; 5], Option<f64>)]) -> Option<usize> {
    let (index, _) = deltas
        .iter()
        .enumerate()
        .max_by_key(|(_, (_, tokens, _))| tokens.iter().sum::<u64>())?;
    Some(index)
}

/// Diffs a Claude result's per-model usage against what the process last
/// reported, updating `baselines`. `cumulative` marks the fallback path where
/// `modelUsage` carries process totals rather than the per-turn
/// `model_usage_since_last_result` delta; baselines only track that path, so
/// a per-turn delta never poisons a later cumulative diff. Returns per-model
/// turn deltas; models that used nothing this turn are omitted.
fn claude_model_deltas<'a>(
    baselines: &mut HashMap<String, ClaudeModelTotals>,
    models: &[ClaudeModelUsage<'a>],
    cumulative: bool,
) -> Vec<(&'a str, [u64; 5], Option<f64>)> {
    let mut deltas = Vec::new();
    for model in models {
        let current = ClaudeModelTotals {
            tokens: [
                model.input_tokens,
                model.cache_read_input_tokens,
                model.cache_creation_input_tokens,
                model.output_tokens,
                model.thinking_tokens.unwrap_or(0),
            ],
            cost_usd: model.cost_usd.unwrap_or(0.0),
        };
        let mut delta = current.tokens;
        let mut cost = model.cost_usd;
        if cumulative {
            let previous = baselines.get(model.model).copied().unwrap_or_default();
            for (index, value) in current.tokens.iter().enumerate() {
                delta[index] = value.saturating_sub(previous.tokens[index]);
            }
            // The CLI's cost figure follows the same cumulative totals.
            cost = Some((current.cost_usd - previous.cost_usd).max(0.0));
            baselines.insert(model.model.to_string(), current);
        }
        if delta.iter().any(|value| *value > 0) {
            deltas.push((model.model, delta, cost));
        }
    }
    deltas
}

/// Cache-write tokens from a raw usage breakdown; the shared
/// `ThreadTokenUsage` type has no field for them.
fn raw_cache_write_tokens(value: &Value) -> u64 {
    value
        .get("cacheWriteInputTokens")
        .or_else(|| value.get("cache_write_input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}


enum Job {
    Event(String),
    Prompt(String),
    Usage(String),
    Flush(oneshot::Sender<()>),
    Clear(AnalyticsClearTarget, oneshot::Sender<std::io::Result<()>>),
}

pub(super) struct Recorder {
    dir: PathBuf,
    settings: Arc<StdMutex<AnalyticsSettings>>,
    tx: mpsc::Sender<Job>,
    /// Usage records lost to a full or closed writer queue. Billing data must
    /// not vanish silently, so the count is surfaced in the status response.
    dropped_usage: AtomicU64,
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

/// Deletes event and usage files older than the retention window.
fn prune(dir: &Path, retention_months: u32) {
    let now = Utc::now();
    let total = now.year() * 12 + now.month0() as i32 - retention_months.max(1) as i32 + 1;
    let month = format!("{:04}-{:02}", total / 12, total % 12 + 1);
    for prefix in ["events-", "usage-"] {
        let oldest = format!("{prefix}{month}.jsonl");
        for path in files_with_prefix(dir, prefix) {
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n < oldest.as_str())
            {
                let _ = std::fs::remove_file(path);
            }
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
    let (mut events, mut prompts, mut usage) =
        (None::<Appender>, None::<Appender>, None::<Appender>);
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
                Job::Usage(line) => {
                    if let Err(error) = append(&dir, "usage", &mut usage, &line) {
                        tracing::debug!(%error, "analytics usage dropped");
                    }
                }
                Job::Flush(done) => {
                    for open in [&mut events, &mut prompts, &mut usage]
                        .into_iter()
                        .flatten()
                    {
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
                        AnalyticsClearTarget::Usage => {
                            usage = None;
                            &["usage-"]
                        }
                        AnalyticsClearTarget::All => {
                            (events, prompts, usage) = (None, None, None);
                            &["events-", "usage-", "prompts-"]
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
        for open in [&mut events, &mut prompts, &mut usage]
            .into_iter()
            .flatten()
        {
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
        Self {
            dir,
            settings,
            tx,
            dropped_usage: AtomicU64::new(0),
        }
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

    /// Appends one usage record. Gated on `record_usage` alone — usage
    /// accounting is independent of the activity switch — and counts drops so
    /// billing data never disappears silently.
    fn usage(&self, record: UsageRecord) {
        if !self.settings().record_usage {
            return;
        }
        let Ok(line) = serde_json::to_string(&UsageEntry::Usage(record)) else {
            return;
        };
        if self.tx.try_send(Job::Usage(line)).is_err() {
            let dropped = self.dropped_usage.fetch_add(1, Ordering::Relaxed) + 1;
            if dropped == 1 || dropped.is_multiple_of(1000) {
                tracing::warn!(dropped, "usage records dropped (analytics writer queue full)");
            }
        }
    }

    /// Usage records lost since startup.
    fn dropped_usage(&self) -> u64 {
        self.dropped_usage.load(Ordering::Relaxed)
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
/// `Some(wrapped)` when the command is `git … commit`; `wrapped` means it sits
/// behind something like `env` or `sudo`, whose options might stop git running.
fn git_commit_command(command: &str) -> Option<bool> {
    // Leading `VAR=value` assignments and wrappers such as `env` are not the command.
    const WRAPPERS: [&str; 6] = ["command", "env", "sudo", "nohup", "time", "exec"];
    let all: Vec<&str> = command.split_whitespace().collect();
    let words: Vec<&str> = all
        .iter()
        .copied()
        .skip_while(|word| {
            WRAPPERS.contains(word)
                || word.starts_with('-')
                || (word.contains('=') && !word.starts_with('-'))
        })
        .collect();
    let wrapped = all
        .iter()
        .take(all.len() - words.len())
        .any(|word| !(word.contains('=') && !word.starts_with('-')));
    let program = words.first()?;
    if *program != "git" && !program.ends_with("/git") {
        return None;
    }
    let mut next = 1;
    while let Some(word) = words.get(next) {
        match *word {
            "-C" | "-c" | "--git-dir" | "--work-tree" => next += 2,
            flag if flag.starts_with('-') => next += 1,
            subcommand => {
                return (subcommand == "commit" && !words.contains(&"--dry-run"))
                    .then_some(wrapped);
            }
        }
    }
    None
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
/// a quiet commit counts only when the line is a pure `&&` chain that succeeded,
/// so every command in it must have run and succeeded.
fn commits_made(tool: &FinishedTool) -> u64 {
    let kind = tool.kind.to_ascii_lowercase();
    if !["bash", "shell", "command", "exec"]
        .iter()
        .any(|shell| kind.contains(shell))
    {
        return 0;
    }
    let commands = shell_commands(tool.command);
    if !commands
        .iter()
        .any(|(command, _)| git_commit_command(command).is_some())
    {
        return 0;
    }
    let confirmed = tool
        .output
        .lines()
        .filter(|line| is_commit_summary(line))
        .count() as u64;
    if confirmed > 0 {
        return confirmed;
    }
    let all_chained = commands
        .iter()
        .all(|(_, operator)| matches!(*operator, None | Some("&&")));
    if tool.ok && all_chained {
        commands
            .iter()
            // Only a bare `git commit` is trusted without git's own output.
            .filter(|(command, _)| git_commit_command(command) == Some(false))
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

/// Reads usage records newer than `since` from the monthly usage files.
/// Duplicate record ids (a replayed notification, a re-delivered turn) count
/// once.
fn read_usage_records(dir: &Path, since: DateTime<Utc>) -> Vec<UsageRecord> {
    let mut seen: HashSet<String> = HashSet::new();
    months_since(since)
        .iter()
        .filter_map(|month| std::fs::File::open(dir.join(format!("usage-{month}.jsonl"))).ok())
        .flat_map(|file| std::io::BufReader::new(file).lines().map_while(Result::ok))
        .filter_map(|line| serde_json::from_str::<UsageEntry>(&line).ok())
        .map(|UsageEntry::Usage(record)| record)
        .filter(|record| record.t >= since && seen.insert(record.id.clone()))
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
        | Record::Commit { t, .. }
        | Record::Route { t, .. } => *t,
    }
}

/// Adds one record to a totals bucket.
fn add_usage(totals: &mut AnalyticsUsageTotals, record: &UsageRecord) {
    totals.input_tokens += record.uncached_input;
    totals.cache_read_tokens += record.cr;
    totals.cache_write_tokens += record.cw;
    totals.output_tokens += record.out;
    totals.turns += 1;
    if let Some(cost) = record.cost {
        totals.cost_usd += cost;
    }
}

/// Total tokens across every field; the sort key for usage rows.
fn usage_token_total(totals: &AnalyticsUsageTotals) -> u64 {
    totals.input_tokens
        + totals.cache_read_tokens
        + totals.cache_write_tokens
        + totals.output_tokens
}

/// Key and display label a record contributes to under the requested grouping.
fn usage_group_key(record: &UsageRecord, group: &str, labels: &Labels) -> (String, String) {
    match group {
        "bot" => match &record.bot {
            Some(bot) => (bot.clone(), labels.bot_name(bot)),
            None => (String::new(), "No bot".to_string()),
        },
        "provider" => (record.prov.clone(), record.prov.clone()),
        "thread" => (record.th.clone(), labels.title(&record.th)),
        "day" => {
            let day = record
                .t
                .with_timezone(&Local)
                .format("%Y-%m-%d")
                .to_string();
            (day.clone(), day)
        }
        _ => (record.model.clone(), record.model.clone()),
    }
}

/// Accumulator for grouped usage: totals plus the cost sources seen.
type UsageGroup = (AnalyticsUsageTotals, HashSet<String>);

/// Per-group extras needed to build thread rows: prompt context, model calls,
/// and the provider/model mix.
#[derive(Default)]
struct ThreadExtras {
    /// Uncached input + cache reads + writes, summed over records that
    /// report a call count.
    context: u64,
    /// Model calls, from the same records.
    calls: u64,
    /// Tokens per provider/model combination, to pick the dominant one.
    models: HashMap<(String, String), u64>,
    /// Frozen attribution from the latest record.
    bot: Option<String>,
    workspace: String,
    origin: String,
}

/// Groups usage records one way, busiest first. See `GET /api/analytics/usage`.
/// Thread rows carry per-thread detail (bot, origin, dominant model, average
/// context per call).
fn aggregate_usage(
    records: &[UsageRecord],
    labels: &Labels,
    days: u32,
    group: &str,
) -> AnalyticsUsageReport {
    let by_thread = group == "thread";
    let mut totals = AnalyticsUsageTotals::default();
    let mut rows: HashMap<(String, String), UsageGroup> = HashMap::new();
    let mut threads: HashMap<String, ThreadExtras> = HashMap::new();
    for record in records {
        add_usage(&mut totals, record);
        let (key, label) = usage_group_key(record, group, labels);
        let entry = rows.entry((key.clone(), label)).or_default();
        add_usage(&mut entry.0, record);
        if record.cost.is_some() {
            entry.1.insert(record.cost_src.clone());
        }
        if by_thread {
            let extras = threads.entry(key).or_default();
            // Context per call needs a call count; records without one are
            // excluded from both numerator and denominator rather than
            // pretending a whole turn was one call.
            if let Some(record_calls) = record.calls {
                extras.context += record.uncached_input + record.cr + record.cw;
                extras.calls += record_calls;
            }
            let tokens = record.uncached_input + record.cr + record.cw + record.out;
            *extras
                .models
                .entry((record.prov.clone(), record.model.clone()))
                .or_default() += tokens;
            extras.bot = record.bot.clone();
            extras.workspace = record.ws.clone();
            extras.origin = record.org.clone();
        }
    }
    let mut rows: Vec<_> = rows
        .into_iter()
        .map(|((key, label), (totals, sources))| {
            let mut cost_sources: Vec<_> = sources.into_iter().collect();
            cost_sources.sort();
            let thread = by_thread.then(|| {
                let extras = threads.remove(&key).unwrap_or_default();
                // The busiest combination names the thread's harness and model.
                let (provider, model) = extras
                    .models
                    .into_iter()
                    .max_by_key(|(_, tokens)| *tokens)
                    .map_or_else(
                        || (String::new(), String::new()),
                        |((provider, model), _)| (provider, model),
                    );
                AnalyticsUsageThread {
                    bot: extras.bot.as_ref().map(|bot| labels.bot_name(bot)),
                    project: labels.project_of(&extras.workspace),
                    workspace: extras.workspace,
                    origin: extras.origin,
                    automation: labels.automations.get(&key).cloned(),
                    provider,
                    model,
                    avg_context_per_call: (extras.calls > 0)
                        .then(|| extras.context / extras.calls),
                }
            });
            AnalyticsUsageRow {
                key,
                label,
                totals,
                cost_sources,
                thread,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        usage_token_total(&b.totals)
            .cmp(&usage_token_total(&a.totals))
            .then_with(|| a.label.cmp(&b.label))
    });
    AnalyticsUsageReport {
        days,
        group: group.to_string(),
        totals,
        rows,
    }
}

/// Usage rollup for the analytics summary: bot by harness by model.
fn usage_rollup(records: &[UsageRecord], labels: &Labels) -> Vec<AnalyticsUsage> {
    let mut groups: HashMap<(Option<String>, String, String), UsageGroup> = HashMap::new();
    for record in records {
        let bot = record.bot.as_ref().map(|bot| labels.bot_name(bot));
        let entry = groups
            .entry((bot, record.prov.clone(), record.model.clone()))
            .or_default();
        add_usage(&mut entry.0, record);
        if record.cost.is_some() {
            entry.1.insert(record.cost_src.clone());
        }
    }
    let mut usage: Vec<_> = groups
        .into_iter()
        .map(|((bot, provider, model), (totals, sources))| {
            let mut cost_sources: Vec<_> = sources.into_iter().collect();
            cost_sources.sort();
            AnalyticsUsage {
                bot,
                provider,
                model,
                totals,
                cost_sources,
            }
        })
        .collect();
    usage.sort_by(|a, b| {
        usage_token_total(&b.totals)
            .cmp(&usage_token_total(&a.totals))
            .then_with(|| a.provider.cmp(&b.provider))
            .then_with(|| a.model.cmp(&b.model))
    });
    usage.truncate(100);
    usage
}

fn thread_activity(
    dir: &Path,
    thread_id: &str,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
    analytics_enabled: bool,
) -> AnalyticsThreadActivity {
    let mut activity = AnalyticsThreadActivity {
        messages: Vec::new(),
        dispatches: Vec::new(),
        analytics_enabled,
    };
    for record in read_records(dir, since) {
        if record_time(&record) > until {
            continue;
        }
        match record {
            Record::Agent {
                t, from, to, d, x, ..
            } if analytics_enabled && (from == thread_id || to == thread_id) => {
                activity.messages.push(AnalyticsThreadMessage {
                    at: t,
                    from,
                    to,
                    delivery: d,
                    excerpt: x,
                });
            }
            Record::Delegate {
                t, parent, child, ..
            } if parent == thread_id => {
                activity.dispatches.push(AnalyticsThreadDispatch {
                    at: t,
                    thread_id: child,
                });
            }
            _ => {}
        }
    }
    activity.messages.sort_by(|a, b| b.at.cmp(&a.at));
    activity.dispatches.sort_by(|a, b| b.at.cmp(&a.at));
    activity
}

/// Current names for threads, bots and projects, used to label stored ids.
struct Labels {
    titles: HashMap<String, String>,
    providers: HashMap<String, String>,
    projects: HashMap<String, String>,
    bots: HashMap<String, String>,
    /// Bot id to bot name.
    bot_names: HashMap<String, String>,
    /// Task thread to the thread that created it.
    parents: HashMap<String, String>,
    /// Thread to the name of the automation that created it.
    automations: HashMap<String, String>,
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

    fn bot_name(&self, bot: &str) -> String {
        self.bot_names
            .get(bot)
            .cloned()
            .unwrap_or_else(|| bot.to_string())
    }

    /// Project folder name for a workspace id, or the id when unknown.
    fn project_of(&self, workspace: &str) -> String {
        self.projects
            .get(workspace)
            .cloned()
            .unwrap_or_else(|| workspace.to_string())
    }
}

/// How far up a spawn chain attribution will walk before treating it as
/// malformed. Real chains are two or three deep.
const CHAIN_DEPTH_CAP: usize = 32;

/// The bot that owns `thread` or one of its ancestors: a bot's home
/// conversation, a bot task's own sub-tasks (grandchildren), or a scheduled
/// thread spawned for the bot. `owned` maps bot-owned thread ids to bot ids,
/// `automation_bots` maps scheduled threads to their `ThreadOrigin::Automation`
/// bot id, and `parent_of` follows `AgentSpawn` origins. Cycle-guarded and
/// depth-capped so a corrupt origin chain cannot spin.
fn chain_bot(
    thread: &str,
    owned: &HashMap<String, String>,
    automation_bots: &HashMap<String, String>,
    parent_of: &HashMap<String, String>,
) -> Option<String> {
    let mut current = thread;
    let mut seen = HashSet::with_capacity(4);
    for _ in 0..CHAIN_DEPTH_CAP {
        if !seen.insert(current) {
            return None;
        }
        if let Some(bot) = owned.get(current).or_else(|| automation_bots.get(current)) {
            return Some(bot.clone());
        }
        current = parent_of.get(current)?;
    }
    None
}

/// The root of a spawn chain: the topmost thread found, or the missing parent
/// the walk stopped at — a deleted ancestor is still the last known root,
/// which beats naming the thread its own root.
fn chain_root(chain: &[ChainLink], missing: Option<&str>, thread: &str) -> String {
    missing
        .map(str::to_string)
        .or_else(|| chain.last().map(|link| link.id.clone()))
        .unwrap_or_else(|| thread.to_string())
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
                    if let Some(day) = entry {
                        day.scheduled += 1;
                    }
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
            // Routing decisions are not part of the overview yet.
            Record::Route { .. } => {}
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
        usage: Vec::new(),
    }
}

/// A unit-like enum's serialized name, such as `succeeded_no_action`.
fn serialized_name(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Runs per scheduled task, with review flags. Enabled tasks with no runs in
/// the period are listed too, so nothing scheduled is invisible.
fn summarize_automations(
    runs: Vec<falcondeck_core::control::AutomationRun>,
    definitions: &[falcondeck_core::control::Automation],
    days: u32,
    bot_home_ids: &HashSet<String>,
    thread_owners: &HashMap<String, String>,
) -> Vec<AnalyticsAutomation> {
    use falcondeck_core::control::{
        AutomationRunStatus as Status, AutomationState, AutomationThreadTarget,
    };
    let blank = |name: &str| AnalyticsAutomation {
        id: None,
        name: name.to_string(),
        state: String::new(),
        schedule: String::new(),
        thread_mode: String::new(),
        runs: 0,
        no_action: 0,
        failed: 0,
        skipped: 0,
        threads: 0,
        agent_ms: 0,
        last_run_at: None,
        last_status: None,
        flags: Vec::new(),
        models: Vec::new(),
        configured_model: None,
        fallback_model: None,
        usage: AnalyticsUsageTotals::default(),
    };
    let mut by_id: BTreeMap<String, (AnalyticsAutomation, HashSet<String>)> = BTreeMap::new();
    for definition in definitions {
        if definition.state == AutomationState::Enabled {
            by_id.insert(
                definition.id.clone(),
                (blank(&definition.name), HashSet::new()),
            );
        }
    }
    let mut latest_queued: HashMap<String, DateTime<Utc>> = HashMap::new();
    let mut large_context_ids = HashSet::new();
    for run in runs {
        if run
            .context_tokens_at_start
            .is_some_and(|tokens| tokens > 100_000)
        {
            large_context_ids.insert(run.automation_id.clone());
        }
        let (summary, threads) = by_id
            .entry(run.automation_id.clone())
            .or_insert_with(|| (blank(&run.automation_name), HashSet::new()));
        summary.runs += 1;
        match run.status {
            Status::SucceededNoAction => summary.no_action += 1,
            Status::Failed => summary.failed += 1,
            Status::SkippedOverlap
            | Status::SkippedDependency
            | Status::SkippedUnchanged
            | Status::SkippedPrecheck => summary.skipped += 1,
            _ => {}
        }
        if let (Some(start), Some(end)) = (run.started_at, run.finished_at) {
            summary.agent_ms += (end - start).num_milliseconds().max(0) as u64;
        }
        // Latest by queue order; the start time (when known) is what's shown.
        if latest_queued
            .get(&run.automation_id)
            .is_none_or(|queued| run.queued_at > *queued)
        {
            latest_queued.insert(run.automation_id.clone(), run.queued_at);
            summary.last_run_at = Some(run.started_at.unwrap_or(run.queued_at));
            summary.last_status = Some(serialized_name(&run.status));
        }
        if let Some(thread) = run.thread_id {
            threads.insert(thread);
        }
    }
    let definitions: HashMap<&str, &falcondeck_core::control::Automation> = definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect();
    let mut automations: Vec<_> = by_id
        .into_iter()
        .map(|(id, (mut summary, threads))| {
            summary.id = Some(id.clone());
            summary.threads = threads.len() as u64;
            if let Some(definition) = definitions.get(id.as_str()) {
                summary.configured_model = definition.target.model_id.clone();
                summary.name = definition.name.clone();
                summary.state = serialized_name(&definition.state);
                summary.schedule =
                    crate::control::automations::schedule_summary(&definition.trigger);
                summary.thread_mode = match definition.target.thread {
                    AutomationThreadTarget::Existing { .. } => "existing",
                    AutomationThreadTarget::Managed { .. } => "managed",
                    AutomationThreadTarget::NewEachRun => "new_each_run",
                    AutomationThreadTarget::Current => "current",
                }
                .into();
                let reused_id = match &definition.target.thread {
                    AutomationThreadTarget::Existing { thread_id }
                    | AutomationThreadTarget::Managed {
                        thread_id: Some(thread_id),
                    } => Some(thread_id),
                    _ => None,
                };
                let bot_home = reused_id.is_some_and(|id| bot_home_ids.contains(id));
                if let Ok(advice) = crate::control::automations::cadence_advice(
                    &definition.trigger,
                    &definition.target,
                    bot_home,
                    Utc::now(),
                ) {
                    summary.flags.extend(
                        advice
                            .iter()
                            .filter_map(|a| a["code"].as_str().map(str::to_string)),
                    );
                }
                if matches!(
                    definition.target.thread,
                    AutomationThreadTarget::Existing { .. }
                        | AutomationThreadTarget::Managed { .. }
                ) && large_context_ids.contains(&id)
                {
                    summary.flags.push("large_reused_context".into());
                }
                let owned = reused_id
                    .is_some_and(|thread| thread_owners.get(thread) == Some(&definition.id));
                if crate::control::automations::reused_thread_model_pin(&definition.target, owned) {
                    summary.flags.push("reused_thread_model_pin".into());
                }
                summary.id = Some(id);
            }
            let finished = summary.runs.saturating_sub(summary.skipped);
            if finished >= 6 && summary.no_action * 10 >= finished * 8 {
                summary.flags.push("rarely_useful".into());
            }
            if summary.runs >= 24 * u64::from(days.max(1)) {
                summary.flags.push("very_frequent".into());
            }
            if summary.failed >= 2 && summary.failed * 10 >= summary.runs * 3 {
                summary.flags.push("failing".into());
            }
            if summary.thread_mode == "new_each_run" && summary.threads > 3 {
                summary.flags.push("thread_per_run".into());
            }
            summary
        })
        .collect();
    automations.sort_by(|a, b| {
        b.flags
            .len()
            .cmp(&a.flags.len())
            .then(b.runs.cmp(&a.runs))
            .then(a.name.cmp(&b.name))
    });
    automations
}

/// Count each usage record once when its thread and timestamp match a finished run.
/// Shared threads also contain manual turns and runs from other automations.
fn summarize_automation_usage(
    summaries: &mut [AnalyticsAutomation],
    runs: &[falcondeck_core::control::AutomationRun],
    definitions: &[falcondeck_core::control::Automation],
    usage: &[UsageRecord],
    thread_models: &HashMap<String, String>,
) {
    use falcondeck_core::control::AutomationThreadTarget as Target;
    for summary in summaries {
        let relevant: Vec<_> = runs
            .iter()
            .filter(|run| Some(&run.automation_id) == summary.id.as_ref())
            .collect();
        let mut windows: HashMap<&str, Vec<(DateTime<Utc>, DateTime<Utc>)>> = HashMap::new();
        for run in &relevant {
            if let (Some(thread), Some(start), Some(end)) = (run.thread_id.as_deref(), run.started_at, run.finished_at) {
                windows.entry(thread).or_default().push((start, end));
            }
        }
        let mut models = std::collections::BTreeSet::new();
        for record in usage {
            if windows.get(record.th.as_str()).is_some_and(|intervals| {
                intervals.iter().any(|(start, end)| record.t >= *start && record.t <= *end)
            }) {
                add_usage(&mut summary.usage, record);
                if !record.model.is_empty() {
                    models.insert(record.model.clone());
                }
            }
        }
        summary.models = models.into_iter().collect();
        let target = definitions
            .iter()
            .find(|d| Some(&d.id) == summary.id.as_ref())
            .and_then(|d| match &d.target.thread {
                Target::Managed {
                    thread_id: Some(id),
                }
                | Target::Existing { thread_id: id } => Some(id),
                _ => None,
            });
        summary.fallback_model = target
            .and_then(|id| thread_models.get(id))
            .cloned()
            .or_else(|| {
                relevant
                    .iter()
                    .filter_map(|r| r.thread_id.as_ref().and_then(|id| thread_models.get(id)))
                    .min()
                    .cloned()
            });
    }
}

/// Attribution frozen into a usage record at write time.
struct UsageAttribution {
    /// `user`, `agent_spawn`, `scheduled` or `automation`.
    org: &'static str,
    /// Immediate parent, when the thread is a spawned task.
    parent: Option<String>,
    /// Top of the spawn chain, or the thread itself.
    root: String,
    bot: Option<String>,
    /// Provider and agent selection from the thread summary, when the thread
    /// still exists.
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

/// One link of a spawn chain walked for attribution.
#[derive(Clone)]
struct ChainLink {
    id: String,
    /// `AgentSpawn` parent, when this thread is a spawned task.
    parent: Option<String>,
    /// Bot id when the thread was created by `ThreadOrigin::Automation`.
    automation_bot: Option<String>,
    /// `user`, `agent_spawn`, `scheduled` or `automation`.
    org: &'static str,
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

    /// Records a routing decision (`auto`) or an explicit model choice.
    pub(super) fn analytics_route(
        &self,
        thread: Option<(&str, &str)>,
        explicit: Option<(&str, Option<&str>, Option<&str>)>,
        decision: Option<&falcondeck_core::RouteDecision>,
    ) {
        let auto = decision.is_some();
        let c = decision.and_then(|d| d.classification.as_ref());
        let target = decision.and_then(|d| d.target.as_ref());
        let (p, m, eff) = match explicit {
            Some((p, m, e)) => (Some(p.to_string()), m.map(str::to_string), e.map(str::to_string)),
            None => (
                target.map(|t| t.provider.as_str().to_string()),
                target.and_then(|t| t.model_id.clone()),
                target.and_then(|t| t.reasoning_effort.clone()),
            ),
        };
        self.analytics().record(Record::Route {
            t: Utc::now(),
            th: thread.map(|(child, _)| child.to_string()),
            parent: thread.map(|(_, parent)| parent.to_string()),
            auto,
            task: c.map(|c| c.task_type.clone()),
            conf: c.map_or(0, |c| c.confidence_percent),
            diff: c.map_or(0, |c| (c.difficulty * 10.0).round() as u8),
            risk: c.map_or(0, |c| c.production_risk_percent),
            social: c.map_or(0, |c| c.needs_social_percent),
            rule: decision.and_then(|d| d.rule.clone()),
            p,
            m,
            eff,
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

    /// Records one model's usage in one finished turn. Never on the turn hot
    /// path and never able to fail one: attribution is resolved in a spawned
    /// task and the line is handed to the writer with `try_send`.
    pub(super) fn record_turn_usage(&self, usage: TurnUsage<'_>) {
        let app = self.clone();
        let capture = usage.owned();
        tokio::spawn(async move {
            let attribution = app.usage_attribution(&capture.thread_id).await;
            let provider = if capture.provider.is_empty() {
                attribution
                    .provider
                    .unwrap_or_else(|| "unknown".to_string())
            } else {
                capture.provider
            };
            let model = if capture.model.is_empty() {
                attribution.model.unwrap_or_default()
            } else {
                capture.model
            };
            app.analytics().usage(UsageRecord {
                t: Utc::now(),
                id: capture.id,
                src: "live".to_string(),
                th: capture.thread_id.clone(),
                par: attribution.parent,
                root: attribution.root,
                bot: attribution.bot,
                org: attribution.org.to_string(),
                ws: capture.workspace_id,
                prov: provider,
                model,
                uncached_input: capture.uncached_input,
                cr: capture.cache_read,
                cw: capture.cache_write,
                out: capture.output,
                think: capture.reasoning,
                calls: capture.calls,
                cost: capture.cost,
                cost_src: capture.cost_source,
                tier: capture.tier,
                effort: capture.effort.or(attribution.effort),
                cost_ticks: capture.cost_ticks,
            });
        });
    }

    /// Records a Claude result's per-model usage. `cumulative` results (only
    /// `modelUsage`, no per-turn delta) are differenced against what the
    /// process last reported, so a long-lived CLI never double-counts.
    /// Returns the summed `(input incl. cache write, cache read)` of the
    /// turn, for automation-run usage.
    pub(super) fn record_claude_turn_usage(
        &self,
        workspace_id: &str,
        thread_id: &str,
        models: &[ClaudeModelUsage<'_>],
        cumulative: bool,
        tier: Option<String>,
        calls: Option<u64>,
    ) -> Option<(u64, u64)> {
        let deltas = {
            let mut baselines = self
                .inner
                .claude_usage_baselines
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = baselines.entry(thread_id.to_string()).or_default();
            claude_model_deltas(entry, models, cumulative)
        };
        if deltas.is_empty() {
            return None;
        }
        // The turn's call count rides on one record only.
        let carrier = calls_carrier(&deltas);
        let stamp = Utc::now().timestamp_millis();
        let mut summed = (0, 0);
        for (index, (model, delta, cost)) in deltas.iter().enumerate() {
            summed.0 += delta[0] + delta[2];
            summed.1 += delta[1];
            self.record_turn_usage(TurnUsage {
                workspace_id,
                thread_id,
                provider: "claude",
                model,
                uncached_input: delta[0],
                cache_read: delta[1],
                cache_write: delta[2],
                output: delta[3],
                reasoning: delta[4],
                calls: (Some(index) == carrier).then_some(calls).flatten(),
                cost: *cost,
                cost_source: if cost.is_some() {
                    "provider"
                } else {
                    "none"
                },
                tier: tier.clone(),
                effort: None,
                cost_ticks: None,
                id: format!("claude:{thread_id}:{model}:{stamp}"),
            });
        }
        Some(summed)
    }

    /// Forgets what a thread's Claude process last reported. Called when a
    /// new CLI process starts: its cumulative `modelUsage` restarts from
    /// zero, and differencing against the old process would swallow every
    /// turn until the new totals caught up.
    pub(super) fn reset_claude_usage_baselines(&self, thread_id: &str) {
        self.inner
            .claude_usage_baselines
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(thread_id);
    }

    /// Folds a Codex `thread/tokenUsage/updated` notification into the
    /// thread's turn accumulator. Bounded work: one map lookup and
    /// arithmetic, never blocking the notification stream.
    pub(super) fn note_codex_token_usage(&self, thread_id: &str, turn_id: &str, params: &Value) {
        // Typed camelCase parse shared with the projection path; only cache
        // writes (absent from the shared type) are read raw.
        let Some(usage) = super::notifications::parse_thread_token_usage(params) else {
            return;
        };
        let report = params
            .get("tokenUsage")
            .or_else(|| params.get("token_usage"))
            .unwrap_or(&Value::Null);
        let (total_write, last_write) = (
            report.get("total").map(raw_cache_write_tokens).unwrap_or(0),
            report.get("last").map(raw_cache_write_tokens).unwrap_or(0),
        );
        self.inner
            .codex_turn_usage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(thread_id.to_string())
            .or_default()
            .note(turn_id, &usage, total_write, last_write);
    }

    /// Registers a newly started Codex turn with the model it selected.
    pub(super) fn start_codex_turn_usage(&self, thread_id: &str, turn_id: &str, model: Option<&str>) {
        self.inner
            .codex_turn_usage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(thread_id.to_string())
            .or_default()
            .start(turn_id, model);
    }

    /// Writes the accumulated usage of a finished Codex turn, if any. The
    /// heavy half runs in the recording task, like every usage capture.
    pub(super) fn flush_codex_turn_usage(&self, workspace_id: &str, thread_id: &str) {
        let Some(accumulated) = self
            .inner
            .codex_turn_usage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(thread_id)
            .and_then(CodexTurnUsage::finish)
        else {
            return;
        };
        // The accumulator normally holds the turn that just completed. A
        // turn whose completion never arrives is dropped when the next turn
        // starts, so its tokens never leak into another turn's record.
        let turn = accumulated.turn.as_str();
        let delta = accumulated.delta;
        self.record_turn_usage(TurnUsage {
            workspace_id,
            thread_id,
            // The notification path is Codex-only, and the model is the one
            // the turn started with.
            provider: "codex",
            model: accumulated.model.as_deref().unwrap_or_default(),
            uncached_input: delta
                .input_tokens
                .saturating_sub(delta.cached_input_tokens),
            cache_read: delta.cached_input_tokens,
            cache_write: delta.cache_write_tokens,
            output: delta.output_tokens,
            reasoning: delta.reasoning_tokens,
            calls: Some(accumulated.calls),
            cost: None,
            cost_source: "none",
            tier: None,
            effort: None,
            cost_ticks: None,
            id: format!("codex:{thread_id}:{turn}:{}", Utc::now().timestamp_millis()),
        });
    }

    /// Resolves a thread's attribution once: the spawn chain under one
    /// workspace lock, then bot ownership under one preferences lock. Only
    /// called from the recording task, off every turn.
    async fn usage_attribution(&self, thread_id: &str) -> UsageAttribution {
        let (chain, selection, missing) = {
            let workspaces = self.inner.workspaces.lock().await;
            let mut chain = Vec::new();
            let mut selection: Option<(String, Option<String>, Option<String>)> = None;
            let mut current = thread_id.to_string();
            let mut seen = HashSet::with_capacity(4);
            let mut missing: Option<String> = None;
            while seen.insert(current.clone()) && chain.len() < CHAIN_DEPTH_CAP {
                let Some(thread) = workspaces
                    .values()
                    .find_map(|workspace| workspace.threads.get(&current))
                else {
                    // The chain names a parent that no longer exists; that id
                    // is the last known root.
                    missing = Some(current.clone());
                    break;
                };
                let summary = &thread.summary;
                let (parent, automation_bot, org) = match &summary.origin {
                    Some(falcondeck_core::ThreadOrigin::AgentSpawn { parent_thread_id, .. }) => {
                        (Some(parent_thread_id.clone()), None, "agent_spawn")
                    }
                    Some(falcondeck_core::ThreadOrigin::ScheduledTask { .. }) => {
                        (None, None, "scheduled")
                    }
                    Some(falcondeck_core::ThreadOrigin::Automation { bot_id, .. }) => {
                        (None, bot_id.clone(), "automation")
                    }
                    None => (None, None, "user"),
                };
                if chain.is_empty() {
                    selection = Some((
                        summary.provider.to_string(),
                        summary.agent.model_id.clone(),
                        summary.agent.reasoning_effort.clone(),
                    ));
                }
                chain.push(ChainLink {
                    id: current.clone(),
                    parent: parent.clone(),
                    automation_bot,
                    org,
                });
                let Some(parent) = parent else {
                    break;
                };
                current = parent;
            }
            (chain, selection, missing)
        };
        let bot = {
            let preferences = self.inner.preferences.lock().await;
            let mut owned = HashMap::with_capacity(preferences.bots.len());
            for bot in &preferences.bots {
                for id in std::iter::once(&bot.thread_id).chain(&bot.previous_thread_ids) {
                    owned.insert(id.clone(), bot.id.clone());
                }
            }
            let automation_bots: HashMap<String, String> = chain
                .iter()
                .filter_map(|link| {
                    link.automation_bot
                        .clone()
                        .map(|bot| (link.id.clone(), bot))
                })
                .collect();
            let parent_of: HashMap<String, String> = chain
                .iter()
                .filter_map(|link| {
                    link.parent.clone().map(|parent| (link.id.clone(), parent))
                })
                .collect();
            chain_bot(thread_id, &owned, &automation_bots, &parent_of)
        };
        UsageAttribution {
            org: chain.first().map_or("user", |link| link.org),
            parent: chain.first().and_then(|link| link.parent.clone()),
            root: chain_root(&chain, missing.as_deref(), thread_id),
            bot,
            provider: selection.as_ref().map(|(provider, _, _)| provider.clone()),
            model: selection.as_ref().and_then(|(_, model, _)| model.clone()),
            effort: selection.as_ref().and_then(|(_, _, effort)| effort.clone()),
        }
    }

    pub async fn analytics_status(&self) -> AnalyticsStatus {
        let recorder = self.analytics();
        recorder.flush().await;
        let dir = recorder.dir.clone();
        let dropped_usage_records = recorder.dropped_usage();
        let (events_bytes, prompts_bytes, usage_bytes) =
            tokio::task::spawn_blocking(move || {
                let size = |prefix| {
                    files_with_prefix(&dir, prefix)
                        .iter()
                        .filter_map(|path| std::fs::metadata(path).ok())
                        .map(|meta| meta.len())
                        .sum::<u64>()
                };
                (size("events-"), size("prompts-"), size("usage-"))
            })
            .await
            .unwrap_or_default();
        AnalyticsStatus {
            settings: recorder.settings(),
            folder: recorder.dir.to_string_lossy().into(),
            events_bytes,
            prompts_bytes,
            usage_bytes,
            dropped_usage_records,
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
        let (mut titles, mut providers, mut projects, mut parents, mut automations) = (
            HashMap::new(),
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
                match &thread.summary.origin {
                    Some(falcondeck_core::ThreadOrigin::AgentSpawn {
                        parent_thread_id, ..
                    }) => {
                        parents.insert(thread.summary.id.clone(), parent_thread_id.clone());
                    }
                    Some(falcondeck_core::ThreadOrigin::Automation { name, .. }) => {
                        automations.insert(thread.summary.id.clone(), name.clone());
                    }
                    _ => {}
                }
            }
        }
        let preferences = self.inner.preferences.lock().await;
        let (mut bots, mut bot_names) = (HashMap::new(), HashMap::new());
        for bot in &preferences.bots {
            bot_names.insert(bot.id.clone(), bot.name.clone());
            for id in std::iter::once(&bot.thread_id).chain(&bot.previous_thread_ids) {
                bots.insert(id.clone(), bot.name.clone());
            }
        }
        Labels {
            titles,
            providers,
            projects,
            bots,
            bot_names,
            parents,
            automations,
        }
    }

    pub async fn analytics_thread(
        &self,
        thread_id: String,
        days: u32,
    ) -> Result<AnalyticsThreadActivity, DaemonError> {
        let recorder = self.analytics();
        let analytics_enabled = recorder.settings().enabled;
        recorder.flush().await;
        let dir = recorder.dir.clone();
        let until = Utc::now();
        let since = until - chrono::Duration::days(i64::from(days.clamp(1, 366)));
        tokio::task::spawn_blocking(move || {
            thread_activity(&dir, &thread_id, since, until, analytics_enabled)
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))
    }

    pub async fn analytics_summary(&self, days: u32) -> Result<AnalyticsSummary, DaemonError> {
        let days = days.clamp(1, 366);
        self.analytics().flush().await;
        let labels = self.analytics_labels().await;
        let dir = self.analytics().dir.clone();
        let since = self.analytics_period_start(days).await;
        let runs = self.control().runs_since(since).await;
        let definitions = self.control().automations_snapshot().await;
        let bot_home_ids = self
            .preferences()
            .await
            .bots
            .into_iter()
            .map(|bot| bot.thread_id)
            .collect();
        let thread_models: HashMap<String, String> = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .flat_map(|workspace| workspace.threads.values())
            .filter_map(|thread| {
                thread
                    .summary
                    .agent
                    .model_id
                    .clone()
                    .map(|model| (thread.summary.id.clone(), model))
            })
            .collect();
        let thread_owners = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .flat_map(|workspace| workspace.threads.values())
            .filter_map(|thread| match &thread.summary.origin {
                Some(falcondeck_core::ThreadOrigin::Automation { automation_id, .. }) => {
                    Some((thread.summary.id.clone(), automation_id.clone()))
                }
                _ => None,
            })
            .collect();
        let summary = tokio::task::spawn_blocking(move || {
            let mut summary = summarize(read_records(&dir, since), &labels, days);
            let usage = read_usage_records(&dir, since);
            summary.usage = usage_rollup(&usage, &labels);
            summary.automations = summarize_automations(
                runs.clone(),
                &definitions,
                days,
                &bot_home_ids,
                &thread_owners,
            );
            summarize_automation_usage(
                &mut summary.automations,
                &runs,
                &definitions,
                &usage,
                &thread_models,
            );
            summary
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))?;
        Ok(summary)
    }

    /// Token usage for the last `days` days, grouped one way. Local only.
    pub async fn analytics_usage(
        &self,
        days: u32,
        group: &str,
    ) -> Result<AnalyticsUsageReport, DaemonError> {
        let days = days.clamp(1, 366);
        self.analytics().flush().await;
        let labels = self.analytics_labels().await;
        let dir = self.analytics().dir.clone();
        let since = self.analytics_period_start(days).await;
        let group = group.to_string();
        tokio::task::spawn_blocking(move || {
            aggregate_usage(&read_usage_records(&dir, since), &labels, days, &group)
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))
    }

    /// Start of the summary window: local midnight of the first charted day,
    /// so totals and daily buckets cover the same calendar days.
    async fn analytics_period_start(&self, days: u32) -> DateTime<Utc> {
        let first_day = Local::now().date_naive() - chrono::Duration::days(i64::from(days) - 1);
        first_day
            .and_hms_opt(0, 0, 0)
            .and_then(|midnight| midnight.and_local_timezone(Local).earliest())
            .map_or_else(
                || Utc::now() - chrono::Duration::days(i64::from(days)),
                |start| start.with_timezone(&Utc),
            )
    }

    /// `falcondeck_get` resource `automation.health`: scheduled-task review data
    /// for agents such as a chief of staff. Local only, like the rest of analytics.
    pub(super) async fn automation_health(
        &self,
        request: &falcondeck_core::control::ControlGetRequest,
        context: &falcondeck_core::control::ControlRequestContext,
    ) -> Result<falcondeck_core::control::ControlGetResponse, crate::control::ControlError> {
        if context.origin == falcondeck_core::control::ControlOrigin::RemoteRpc {
            return Err(crate::control::ControlError::interface_disabled(
                "automation.health is only available on this computer",
            ));
        }
        let days = request
            .filters
            .get("days")
            .and_then(Value::as_u64)
            .unwrap_or(7)
            .clamp(1, 90) as u32;
        let summary = self
            .analytics_summary(days)
            .await
            .map_err(|error| crate::control::ControlError::internal(error.to_string()))?;
        Ok(falcondeck_core::control::ControlGetResponse {
            resource: request.resource.clone(),
            data: json!({
                "days": days,
                "scheduled_messages": summary.totals.scheduled_messages,
                "flags": {
                    "rarely_useful": "at least 80% of finished runs found nothing to do",
                    "very_frequent": "24 or more runs a day",
                    "failing": "30% or more of runs failed",
                    "thread_per_run": "starts a new thread every run",
                    "cache_cold_reuse": "reuses a task with any scanned gap in (cache TTL minus 5 minutes, TTL plus 30 minutes]",
                    "bot_home_frequent": "targets a bot home more often than every four hours",
                    "large_reused_context": "reused task had over 100k context tokens at a run start in this period",
                    "reused_thread_model_pin": "Stored model/effort pins are ignored on tasks this automation does not own. Clear target.model_id and target.reasoning_effort, or use new_each_run with run_as_bot for cheaper bot work.",
                },
                "automations": summary.automations,
            }),
            next_cursor: None,
        })
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

    fn usage_record(
        id: &str,
        thread: &str,
        bot: Option<&str>,
        provider: &str,
        model: &str,
        tokens: (u64, u64, u64, u64),
        cost: Option<f64>,
    ) -> UsageRecord {
        UsageRecord {
            t: Utc::now(),
            id: id.to_string(),
            src: "live".to_string(),
            th: thread.to_string(),
            par: None,
            root: thread.to_string(),
            bot: bot.map(str::to_string),
            org: "user".to_string(),
            ws: "ws".to_string(),
            prov: provider.to_string(),
            model: model.to_string(),
            uncached_input: tokens.0,
            cr: tokens.1,
            cw: tokens.2,
            out: tokens.3,
            think: 0,
            calls: None,
            cost,
            cost_src: cost.map_or("none", |_| "provider").to_string(),
            tier: None,
            effort: None,
            cost_ticks: None,
        }
    }

    fn test_labels() -> Labels {
        Labels {
            titles: HashMap::from([("grandchild".to_string(), "Deep task".to_string())]),
            providers: HashMap::new(),
            projects: HashMap::new(),
            bots: HashMap::new(),
            bot_names: HashMap::from([("bot-1".to_string(), "Juno".to_string())]),
            parents: HashMap::new(),
            automations: HashMap::new(),
        }
    }

    #[test]
    fn usage_records_round_trip_with_short_field_names() {
        let record = usage_record(
            "grok:5df2cb0c",
            "grandchild",
            Some("bot-1"),
            "grok",
            "grok-4.7-build",
            (45837, 445696, 0, 6193),
            Some(0.1195712),
        );
        let line = serde_json::to_string(&UsageEntry::Usage(record.clone())).unwrap();
        assert!(line.starts_with(r#"{"e":"usage""#), "{line}");
        assert!(line.contains(r#""in":45837"#), "{line}");
        let back: UsageEntry = serde_json::from_str(&line).unwrap();
        assert_eq!(back, UsageEntry::Usage(record));
    }

    #[test]
    fn usage_aggregates_by_each_grouping() {
        let labels = test_labels();
        let records = vec![
            usage_record(
                "a",
                "grandchild",
                Some("bot-1"),
                "claude",
                "claude-haiku-5-5",
                (2, 11886, 18949, 4),
                Some(0.00391086),
            ),
            usage_record(
                "b",
                "other",
                None,
                "claude",
                "claude-haiku-5-5",
                (10, 0, 0, 20),
                None,
            ),
            usage_record(
                "c",
                "other",
                None,
                "codex",
                "gpt-6.1-sol",
                (11008, 11008, 512, 257),
                None,
            ),
        ];
        let by_bot = aggregate_usage(&records, &labels, 7, "bot");
        assert_eq!(by_bot.rows.len(), 2);
        // Busiest first: Juno's row carries the large cache figures.
        assert_eq!(by_bot.rows[0].label, "Juno");
        assert_eq!(by_bot.rows[0].totals.cache_read_tokens, 11886);
        assert_eq!(by_bot.rows[1].label, "No bot");
        assert_eq!(by_bot.rows[1].totals.input_tokens, 11018);
        assert_eq!(by_bot.totals.turns, 3);
        assert!((by_bot.totals.cost_usd - 0.00391086).abs() < 1e-12);

        let by_model = aggregate_usage(&records, &labels, 7, "model");
        assert_eq!(by_model.rows[0].key, "claude-haiku-5-5");
        assert_eq!(by_model.rows[0].totals.turns, 2);

        let by_thread = aggregate_usage(&records, &labels, 7, "thread");
        // Titles label the stored ids, and thread rows carry per-thread detail.
        let deep = by_thread
            .rows
            .iter()
            .find(|row| row.label == "Deep task")
            .unwrap();
        let detail = deep.thread.as_ref().unwrap();
        assert_eq!(detail.bot.as_deref(), Some("Juno"));
        assert_eq!(detail.provider, "claude");
        assert_eq!(detail.model, "claude-haiku-5-5");
        // The record reports no call count, so no context-per-call is claimed
        // rather than pretending the whole turn was one call.
        assert_eq!(detail.avg_context_per_call, None);

        let by_day = aggregate_usage(&records, &labels, 7, "day");
        assert_eq!(by_day.rows.len(), 1);
        assert_eq!(
            by_day.rows[0].key,
            Local::now().format("%Y-%m-%d").to_string()
        );

        // A cost-free row lists no cost sources; a costed one does.
        let by_provider = aggregate_usage(&records, &labels, 7, "provider");
        let codex = by_provider
            .rows
            .iter()
            .find(|row| row.key == "codex")
            .unwrap();
        assert!(codex.cost_sources.is_empty());
        let claude = by_provider
            .rows
            .iter()
            .find(|row| row.key == "claude")
            .unwrap();
        assert_eq!(claude.cost_sources, ["provider"]);
    }

    #[test]
    fn thread_rows_detail_origin_project_and_average_context() {
        let labels = Labels {
            titles: HashMap::from([("scheduled-1".to_string(), "Nightly check".to_string())]),
            providers: HashMap::new(),
            projects: HashMap::from([("ws-7".to_string(), "falcondeck".to_string())]),
            bots: HashMap::new(),
            bot_names: HashMap::from([("bot-2".to_string(), "Monitor".to_string())]),
            parents: HashMap::new(),
            automations: HashMap::from([(
                "scheduled-1".to_string(),
                "Nightly repo check".to_string(),
            )]),
        };
        let mut first = usage_record(
            "a",
            "scheduled-1",
            Some("bot-2"),
            "codex",
            "gpt-6.1-sol",
            (11058, 11008, 0, 257),
            None,
        );
        first.org = "automation".to_string();
        first.ws = "ws-7".to_string();
        first.calls = Some(2);
        let mut second = usage_record(
            "b",
            "scheduled-1",
            Some("bot-2"),
            "codex",
            "gpt-6.1-sol",
            (100, 0, 50, 40),
            None,
        );
        second.org = "automation".to_string();
        second.ws = "ws-7".to_string();
        // No call count: contributes one call.
        let records = vec![first, second];
        let report = aggregate_usage(&records, &labels, 30, "thread");
        assert_eq!(report.rows.len(), 1);
        let row = &report.rows[0];
        assert_eq!(row.key, "scheduled-1");
        assert_eq!(row.label, "Nightly check");
        let detail = row.thread.as_ref().unwrap();
        assert_eq!(detail.origin, "automation");
        assert_eq!(detail.automation.as_deref(), Some("Nightly repo check"));
        assert_eq!(detail.bot.as_deref(), Some("Monitor"));
        assert_eq!(detail.project, "falcondeck");
        assert_eq!(detail.workspace, "ws-7");
        assert_eq!(
            (detail.provider.as_str(), detail.model.as_str()),
            ("codex", "gpt-6.1-sol")
        );
        // Context: only the record with a call count counts — (11058 + 11008)
        // over 2 calls; the calls-less record is excluded entirely.
        assert_eq!(detail.avg_context_per_call, Some(11033));
        assert_eq!(row.totals.turns, 2);
        // Other groupings carry no thread detail.
        let by_model = aggregate_usage(&records, &labels, 30, "model");
        assert!(by_model.rows[0].thread.is_none());
    }

    #[test]
    fn usage_rollup_groups_bot_provider_model() {
        let labels = test_labels();
        let records = vec![
            usage_record(
                "a",
                "t1",
                Some("bot-1"),
                "claude",
                "claude-haiku-5-5",
                (1, 2, 3, 4),
                Some(0.5),
            ),
            usage_record(
                "b",
                "t2",
                Some("bot-1"),
                "claude",
                "claude-haiku-5-5",
                (10, 0, 0, 0),
                None,
            ),
            usage_record("c", "t3", None, "grok", "grok-4.7-build", (5, 0, 0, 0), None),
        ];
        let rollup = usage_rollup(&records, &labels);
        assert_eq!(rollup.len(), 2);
        // Busiest first: the two claude records sum above the grok one.
        assert_eq!(rollup[0].bot.as_deref(), Some("Juno"));
        assert_eq!(rollup[0].provider, "claude");
        assert_eq!(rollup[0].totals.turns, 2);
        assert_eq!(rollup[0].totals.input_tokens, 11);
        assert_eq!(rollup[0].cost_sources, ["provider"]);
        assert_eq!(rollup[1].bot, None);
    }

    /// Real `thread/tokenUsage/updated` notification shape (camelCase), as in
    /// `parses_codex_thread_token_usage_without_losing_cached_or_reasoning_counts`.
    fn codex_notification(
        turn_id: &str,
        total: (u64, u64, u64, u64, u64, u64),
        last: Option<(u64, u64, u64, u64, u64, u64)>,
    ) -> Value {
        let breakdown = |(total_tokens, input, cached, cache_write, output, reasoning)| {
            json!({
                "totalTokens": total_tokens, "inputTokens": input,
                "cachedInputTokens": cached, "cacheWriteInputTokens": cache_write,
                "outputTokens": output, "reasoningOutputTokens": reasoning
            })
        };
        let mut token_usage = json!({ "total": breakdown(total) });
        if let Some(last) = last {
            token_usage["last"] = breakdown(last);
        }
        json!({ "threadId": "thread-1", "turnId": turn_id, "tokenUsage": token_usage })
    }

    fn note(
        turn: &mut CodexTurnUsage,
        notification: &Value,
    ) {
        let usage = super::super::notifications::parse_thread_token_usage(notification).unwrap();
        let report = &notification["tokenUsage"];
        turn.note(
            notification["turnId"].as_str().unwrap(),
            &usage,
            super::raw_cache_write_tokens(&report["total"]),
            report
                .get("last")
                .map(|last| super::raw_cache_write_tokens(last))
                .unwrap_or(0),
        );
    }

    #[test]
    fn codex_usage_diffs_cumulative_totals_per_turn() {
        let mut turn = CodexTurnUsage::default();
        // A thread's first report: the request in `last` is all the totals
        // hold, so the turn's baseline is zero.
        note(
            &mut turn,
            &codex_notification("turn-1", (11315, 11058, 11008, 0, 257, 77), Some((11315, 11058, 11008, 0, 257, 77))),
        );
        // Second request in the same turn; totals are cumulative.
        note(
            &mut turn,
            &codex_notification("turn-1", (22849, 22092, 22016, 512, 357, 100), Some((11546, 11034, 11008, 512, 100, 23))),
        );
        let delta = turn.finish().unwrap();
        assert_eq!(delta.turn, "turn-1");
        // Totals at end minus totals at the turn's baseline.
        assert_eq!(delta.delta.input_tokens, 22092);
        assert_eq!(delta.delta.cached_input_tokens, 22016);
        assert_eq!(delta.delta.cache_write_tokens, 512);
        assert_eq!(delta.delta.output_tokens, 357);
        assert_eq!(delta.delta.reasoning_tokens, 100);
        assert_eq!(delta.calls, 2);
        assert!(turn.finish().is_none(), "finish closes the accumulation");

        // The next turn starts where the previous one ended: its delta is
        // exactly its own request, not the whole thread history again.
        note(
            &mut turn,
            &codex_notification("turn-2", (34992, 32092, 32016, 512, 500, 150), Some((12143, 10000, 10000, 0, 143, 50))),
        );
        let delta = turn.finish().unwrap();
        assert_eq!(delta.turn, "turn-2");
        assert_eq!(delta.delta.input_tokens, 10000);
        assert_eq!(delta.delta.cached_input_tokens, 10000);
        assert_eq!(delta.delta.cache_write_tokens, 0);
        assert_eq!(delta.delta.output_tokens, 143);

        // The model the turn started with rides along.
        turn.start("turn-3", Some("gpt-6.1-terra"));
        note(
            &mut turn,
            &codex_notification("turn-3", (36002, 33092, 32016, 512, 510, 151), Some((1010, 1000, 0, 0, 10, 1))),
        );
        let delta = turn.finish().unwrap();
        assert_eq!(delta.model.as_deref(), Some("gpt-6.1-terra"));
        assert_eq!(delta.delta.output_tokens, 10);
    }

    #[test]
    fn codex_usage_ignores_repeats_and_zero_last_reports() {
        let mut turn = CodexTurnUsage::default();
        let report =
            codex_notification("turn-1", (11315, 11058, 11008, 0, 257, 77), Some((11315, 11058, 11008, 0, 257, 77)));
        note(&mut turn, &report);
        // Repeated report with an unchanged total: no extra call, no change.
        note(&mut turn, &report);
        // Post-compaction report: totals moved but `last` is all zero — it
        // describes no model request, so no call is added.
        note(
            &mut turn,
            &codex_notification("turn-1", (11400, 11100, 11008, 0, 300, 92), Some((0, 0, 0, 0, 0, 0))),
        );
        let delta = turn.finish().unwrap();
        assert_eq!(delta.calls, 1);
        assert_eq!(delta.delta.output_tokens, 257);

        // A turn with no reports records nothing.
        let mut quiet = CodexTurnUsage::default();
        quiet.start("turn-9", None);
        assert!(quiet.finish().is_none());
    }

    #[test]
    fn codex_first_report_without_last_starts_at_current_totals() {
        let mut turn = CodexTurnUsage::default();
        // No `last`, no earlier turn: nothing is known about the thread's
        // history, so the turn must not claim all of it.
        note(
            &mut turn,
            &codex_notification("turn-1", (50900, 50000, 40000, 0, 900, 100), None),
        );
        note(
            &mut turn,
            &codex_notification("turn-1", (53000, 52000, 41000, 0, 1000, 150), None),
        );
        let delta = turn.finish().unwrap();
        assert_eq!(delta.delta.input_tokens, 2000);
        assert_eq!(delta.delta.cached_input_tokens, 1000);
        assert_eq!(delta.delta.output_tokens, 100);
    }

    #[test]
    fn chain_bot_attributes_grandchildren_automation_and_survives_cycles() {
        let owned = HashMap::from([("home".to_string(), "bot-1".to_string())]);
        let automation_bots = HashMap::from([("scheduled".to_string(), "bot-2".to_string())]);
        // grandchild -> child -> home.
        let parents = HashMap::from([
            ("grandchild".to_string(), "child".to_string()),
            ("child".to_string(), "home".to_string()),
        ]);
        // A grandchild task two hops below the bot home still attributes.
        assert_eq!(
            chain_bot("grandchild", &owned, &automation_bots, &parents),
            Some("bot-1".to_string())
        );
        assert_eq!(
            chain_bot("home", &owned, &automation_bots, &parents),
            Some("bot-1".to_string())
        );
        // A scheduled thread created for a bot attributes to that bot even
        // without a parent link.
        assert_eq!(
            chain_bot("scheduled", &owned, &automation_bots, &parents),
            Some("bot-2".to_string())
        );
        // A cycle terminates instead of spinning.
        let cyclic = HashMap::from([
            ("a".to_string(), "b".to_string()),
            ("b".to_string(), "a".to_string()),
        ]);
        assert_eq!(chain_bot("a", &owned, &HashMap::new(), &cyclic), None);
        // A chain longer than the depth cap stops cleanly.
        let mut deep = HashMap::new();
        for index in 0..(CHAIN_DEPTH_CAP + 8) {
            deep.insert(format!("t{index}"), format!("t{}", index + 1));
        }
        assert_eq!(
            chain_bot(
                "t0",
                &HashMap::from([("t9999".to_string(), "x".to_string())]),
                &HashMap::new(),
                &deep
            ),
            None
        );
        // Unrelated threads attribute to nothing.
        assert_eq!(
            chain_bot("stranger", &owned, &automation_bots, &parents),
            None
        );
    }

    #[test]
    fn chain_root_prefers_the_last_known_parent() {
        let link = |id: &str| ChainLink {
            id: id.to_string(),
            parent: None,
            automation_bot: None,
            org: "user",
        };
        // Intact chain: the topmost found thread.
        let chain = vec![link("child"), link("home")];
        assert_eq!(chain_root(&chain, None, "child"), "home");
        // The walk stopped at a deleted parent: that id is still the root.
        assert_eq!(chain_root(&chain, Some("gone"), "child"), "gone");
        // Nothing found at all: the thread itself.
        assert_eq!(chain_root(&[], None, "child"), "child");
    }

    #[test]
    fn calls_carrier_puts_the_turn_call_count_on_the_busiest_model() {
        let opus = ("claude-opus-5-5", [10, 100, 20, 4, 0], Some(0.01));
        let haiku = ("claude-haiku-5-5", [1, 2, 0, 1, 0], None);
        // The busiest model carries the count once, not once per model.
        assert_eq!(calls_carrier(&[opus, haiku]), Some(0));
        assert_eq!(calls_carrier(&[haiku, opus]), Some(1));
        // A single model always carries it; nothing to carry when empty.
        assert_eq!(calls_carrier(&[haiku]), Some(0));
        assert_eq!(calls_carrier(&[]), None);
    }

    #[test]
    fn claude_cumulative_model_usage_differences_across_results() {
        let model = |input: u64, cache_read: u64, cache_write: u64, out: u64, cost: f64| {
            ClaudeModelUsage {
                model: "claude-haiku-5-5",
                input_tokens: input,
                cache_read_input_tokens: cache_read,
                cache_creation_input_tokens: cache_write,
                output_tokens: out,
                thinking_tokens: Some(0),
                cost_usd: Some(cost),
            }
        };
        let mut baselines = HashMap::new();
        // Cumulative modelUsage (no per-turn delta): each result records only
        // its growth, so a long-lived process never double-counts.
        let first = claude_model_deltas(&mut baselines, &[model(10, 100, 20, 4, 0.01)], true);
        assert_eq!(first[0].1, [10, 100, 20, 4, 0]);
        assert_eq!(first[0].2, Some(0.01));
        let second = claude_model_deltas(&mut baselines, &[model(12, 150, 25, 9, 0.02)], true);
        assert_eq!(second[0].1, [2, 50, 5, 5, 0]);
        assert_eq!(second[0].2, Some(0.01));
        // An unchanged result contributes nothing and records no row.
        assert!(claude_model_deltas(&mut baselines, &[model(12, 150, 25, 9, 0.02)], true).is_empty());
        // The per-turn delta path records values as-is and leaves baselines
        // untouched (a delta is not a cumulative figure).
        let delta = claude_model_deltas(&mut baselines, &[model(1, 2, 3, 4, 0.5)], false);
        assert_eq!(delta[0].1, [1, 2, 3, 4, 0]);
        assert_eq!(delta[0].2, Some(0.5));
        let cumulative_again = claude_model_deltas(&mut baselines, &[model(13, 160, 30, 12, 0.03)], true);
        assert_eq!(
            cumulative_again[0].1,
            [1, 10, 5, 3, 0],
            "baselines still hold the last cumulative report"
        );
    }

    #[test]
    fn usage_reads_deduplicate_replayed_record_ids() {
        let dir = tempfile::tempdir().unwrap();
        let since = Utc::now() - chrono::Duration::hours(1);
        let record = usage_record(
            "grok:prompt-1",
            "thread-1",
            None,
            "grok",
            "grok-4.7-build",
            (45837, 445696, 0, 6193),
            Some(0.1195712),
        );
        let line = serde_json::to_string(&UsageEntry::Usage(record)).unwrap();
        let path = dir
            .path()
            .join(format!("usage-{}.jsonl", month_of(Utc::now())));
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        // The same turn delivered twice (a replayed vendor notification).
        writeln!(file, "{line}").unwrap();
        writeln!(file, "{line}").unwrap();
        let read = read_usage_records(dir.path(), since);
        assert_eq!(read.len(), 1);
    }

    #[test]
    fn thread_query_filters_both_directions_window_and_orders_across_months() {
        let dir = tempfile::tempdir().unwrap();
        let until = Utc::now();
        // Include the previous month even when the test runs on the first day.
        let since = until - chrono::Duration::days(35);
        let agent = |t, from: &str, to: &str, x: &str| Record::Agent {
            t,
            from: from.into(),
            to: to.into(),
            n: 42,
            d: "queue".into(),
            ack: false,
            x: x.into(),
        };
        let records = vec![
            agent(since, "selected", "other", "boundary"),
            agent(
                until - chrono::Duration::hours(1),
                "other",
                "selected",
                "inbound",
            ),
            agent(
                since - chrono::Duration::seconds(1),
                "selected",
                "other",
                "too old",
            ),
            agent(until, "selected", "other", "outbound"),
            agent(until, "unrelated", "other", "unrelated"),
            agent(
                until + chrono::Duration::seconds(1),
                "selected",
                "other",
                "future",
            ),
            Record::Delegate {
                t: until,
                parent: "selected".into(),
                child: "other".into(),
                n: 42,
            },
        ];
        for record in records {
            let path = dir
                .path()
                .join(format!("events-{}.jsonl", month_of(record_time(&record))));
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .unwrap();
            writeln!(file, "{}", serde_json::to_string(&record).unwrap()).unwrap();
        }
        let activity = thread_activity(dir.path(), "selected", since, until, true);
        let messages = activity.messages;
        assert_eq!(
            messages
                .iter()
                .map(|m| m.excerpt.as_str())
                .collect::<Vec<_>>(),
            vec!["outbound", "inbound", "boundary"]
        );
        assert_eq!(messages[0].from, "selected");
        assert_eq!(messages[1].to, "selected");
        assert_eq!(messages[1].delivery, "queue");
        assert_eq!(activity.dispatches[0].thread_id, "other");
        assert!(
            thread_activity(dir.path(), "missing", since, until, true)
                .messages
                .is_empty()
        );
        assert!(
            thread_activity(dir.path(), "selected", since, until, false)
                .messages
                .is_empty()
        );
    }

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
        assert_eq!(
            shell(
                "false && git commit -q -m skipped; git commit -q --allow-empty -m real",
                "",
                true
            ),
            0
        );
        // Wrappers still run git.
        assert_eq!(shell("command git commit -m fix", made, true), 1);
        assert_eq!(
            shell(
                "env GIT_EDITOR=true git commit --amend --no-edit",
                made,
                true
            ),
            1
        );
        // A wrapper might not run git at all, so it needs git's own output.
        assert_eq!(
            shell("env --help git commit", "Usage: env [OPTION]...", true),
            0
        );
        assert_eq!(shell("GIT_AUTHOR_NAME=x git commit -q -m y", "", true), 1);
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

    fn run(id: &str, automation: &str, status: &str) -> falcondeck_core::control::AutomationRun {
        serde_json::from_value(json!({
            "id": id,
            "automation_id": automation,
            "automation_name": automation,
            "automation_revision": 1,
            "status": status,
            "queued_at": "2026-10-30T08:00:00Z",
            "started_at": "2026-10-30T08:00:00Z",
            "finished_at": "2026-10-30T08:01:00Z",
            "thread_id": format!("thread-{id}"),
        }))
        .unwrap()
    }

    #[test]
    fn scheduled_usage_joins_by_thread_and_run_window_without_double_counting() {
        let mut a_later = run("3", "a", "succeeded");
        a_later.thread_id = Some("thread-1".into());
        a_later.started_at = a_later.started_at.map(|t| t + chrono::Duration::minutes(2));
        a_later.finished_at = a_later.finished_at.map(|t| t + chrono::Duration::minutes(2));
        let mut b_shared = run("2", "b", "succeeded");
        b_shared.thread_id = Some("thread-1".into());
        b_shared.started_at = b_shared.started_at.map(|t| t + chrono::Duration::minutes(4));
        b_shared.finished_at = b_shared.finished_at.map(|t| t + chrono::Duration::minutes(4));
        let mut unfinished = run("4", "c", "running");
        unfinished.thread_id = Some("thread-1".into());
        unfinished.finished_at = None;
        let first_run = run("1", "a", "succeeded");
        // Duplicate/overlapping run windows must not count the same record twice.
        let runs = vec![first_run.clone(), first_run.clone(), a_later.clone(), b_shared.clone(), unfinished];
        let mut rows = summarize_automations(runs.clone(), &[], 7, &HashSet::new(), &HashMap::new());
        let mut first = usage_record("u1", "thread-1", None, "claude", "haiku", (1, 2, 3, 4), None);
        first.t = first_run.started_at.unwrap();
        let mut second = first.clone(); second.id = "u2".into(); second.model = "sonnet".into();
        second.t = a_later.finished_at.unwrap();
        let mut before = first.clone(); before.t -= chrono::Duration::seconds(1);
        let mut between = first.clone(); between.t = first_run.finished_at.unwrap() + chrono::Duration::seconds(1);
        let mut after = first.clone(); after.t = b_shared.finished_at.unwrap() + chrono::Duration::seconds(1);
        let mut other_task = first.clone(); other_task.t = b_shared.started_at.unwrap(); other_task.model = "opus".into();
        let mut unrelated = first.clone(); unrelated.th = "other".into();
        summarize_automation_usage(&mut rows, &runs, &[], &[first, second, before, between, after, other_task, unrelated], &HashMap::new());
        let a = rows.iter().find(|r| r.id.as_deref() == Some("a")).unwrap();
        assert_eq!(a.models, ["haiku", "sonnet"]);
        assert_eq!(usage_token_total(&a.usage), 20);
        assert_eq!(a.usage.turns, 2);
        let b = rows.iter().find(|r| r.id.as_deref() == Some("b")).unwrap();
        assert_eq!(b.models, ["opus"]);
        assert_eq!(usage_token_total(&b.usage), 10);
        let c = rows.iter().find(|r| r.id.as_deref() == Some("c")).unwrap();
        assert!(c.models.is_empty());
        assert_eq!(c.usage.turns, 0);
    }

    #[test]
    fn model_pin_health_flag_exempts_owned_tasks() {
        let mut definition: falcondeck_core::control::Automation = serde_json::from_value(json!({
            "id":"a","revision":1,"name":"Check","trigger":{"kind":"once","run_at":"2026-12-01T00:00:00Z"},
            "task":{"kind":"prompt","instruction":"Check"},"target":{"workspace_path":"/tmp","provider":"claude","thread":{"kind":"managed"}},
            "state":"enabled","concurrency_policy":"skip","misfire_policy":"skip","created_at":"2026-11-03T00:00:00Z","updated_at":"2026-11-03T00:00:00Z","next_run_at":null
        })).unwrap();
        use falcondeck_core::control::AutomationThreadTarget as Target;
        for (thread, reused) in [
            (
                Target::Existing {
                    thread_id: "home".into(),
                },
                true,
            ),
            (Target::Current, true),
            (
                Target::Managed {
                    thread_id: Some("remembered".into()),
                },
                true,
            ),
            (Target::Managed { thread_id: None }, false),
            (Target::NewEachRun, false),
        ] {
            definition.target.thread = thread;
            for effort_only in [false, true] {
                definition.target.model_id = (!effort_only).then(|| "haiku".into());
                definition.target.reasoning_effort = effort_only.then(|| "low".into());
                for owner in ["a", "other"] {
                    let owners = [("remembered".to_string(), owner.to_string())]
                        .into_iter()
                        .collect();
                    let health = summarize_automations(
                        vec![],
                        std::slice::from_ref(&definition),
                        7,
                        &HashSet::new(),
                        &owners,
                    );
                    let owned = owner == "a"
                        && matches!(
                            definition.target.thread,
                            Target::Managed { thread_id: Some(_) }
                        );
                    assert_eq!(
                        health[0]
                            .flags
                            .iter()
                            .any(|f| f == "reused_thread_model_pin"),
                        reused && !owned
                    );
                }
            }
        }
    }

    #[test]
    fn cost_flags_use_schedule_bot_home_and_run_start_context() {
        let definition: falcondeck_core::control::Automation = serde_json::from_value(json!({
            "id": "cost", "revision": 1, "name": "Cost", "trigger": {"kind": "interval", "every_seconds": 3600, "anchor_at": "2026-11-03T00:00:00Z"},
            "task": {"kind": "prompt", "instruction": "Check"}, "target": {"workspace_path": "/tmp", "provider": "claude", "thread": {"kind": "existing", "thread_id": "home"}},
            "state": "enabled", "concurrency_policy": "skip", "misfire_policy": "skip", "created_at": "2026-11-03T00:00:00Z", "updated_at": "2026-11-03T00:00:00Z", "next_run_at": null
        })).unwrap();
        let mut execution = run("r", "cost", "succeeded");
        execution.context_tokens_at_start = Some(100_001);
        let homes = HashSet::from(["home".into()]);
        let health = summarize_automations(
            vec![execution.clone()],
            std::slice::from_ref(&definition),
            7,
            &homes,
            &HashMap::new(),
        );
        assert_eq!(
            health[0].flags,
            [
                "cache_cold_reuse",
                "bot_home_frequent",
                "large_reused_context"
            ]
        );
        execution.context_tokens_at_start = Some(100_000);
        let health = summarize_automations(
            vec![execution],
            std::slice::from_ref(&definition),
            7,
            &HashSet::new(),
            &HashMap::new(),
        );
        assert_eq!(health[0].flags, ["cache_cold_reuse"]);
        let mut fresh = definition;
        fresh.target.thread = falcondeck_core::control::AutomationThreadTarget::NewEachRun;
        assert!(
            summarize_automations(vec![], &[fresh], 7, &homes, &HashMap::new())[0]
                .flags
                .is_empty()
        );
    }

    #[test]
    fn scheduled_tasks_are_flagged_when_they_cost_more_than_they_give() {
        let mut runs = Vec::new();
        // A monitor that almost never finds anything, run 30 times in a day.
        for index in 0..30 {
            let status = if index == 0 {
                "succeeded"
            } else {
                "succeeded_no_action"
            };
            runs.push(run(&format!("m{index}"), "Monitor", status));
        }
        // A task that keeps failing.
        for (index, status) in ["failed", "failed", "succeeded", "failed"]
            .iter()
            .enumerate()
        {
            runs.push(run(&format!("f{index}"), "Flaky", status));
        }
        // A healthy daily task.
        runs.push(run("d0", "Daily", "succeeded"));
        let automations = summarize_automations(runs, &[], 1, &HashSet::new(), &HashMap::new());
        let find = |name: &str| automations.iter().find(|a| a.name == name).unwrap();
        let monitor = find("Monitor");
        assert_eq!(
            (monitor.runs, monitor.no_action, monitor.threads),
            (30, 29, 30)
        );
        assert_eq!(monitor.agent_ms, 30 * 60_000);
        assert!(monitor.flags.contains(&"rarely_useful".to_string()));
        assert!(monitor.flags.contains(&"very_frequent".to_string()));
        assert_eq!(find("Flaky").flags, ["failing"]);
        assert!(find("Daily").flags.is_empty());
        // Flagged tasks sort first.
        assert_eq!(automations[0].name, "Monitor");
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
