//! Cache health and waste report: turns usage and activity records into
//! rebuild causes, a cost mix and a ranked list of offenders. Plain rules with
//! thresholds in one place, shown in the panel so any flag can be explained.
//! See `docs/ANALYTICS.md`.
use super::*;
use falcondeck_core::control::{AutomationRun, AutomationRunStatus};
use falcondeck_core::{
    AnalyticsBotOverhead, AnalyticsCacheHitRate, AnalyticsCacheReport, AnalyticsCostMix,
    AnalyticsHomeThreadCache, AnalyticsPrice, AnalyticsRebuildCause, AnalyticsRebuildGroup,
    AnalyticsWasteItem, AnalyticsWasteRule,
};

/// Records with no turn identity join only when this close and on another model.
const SAME_TURN_SECONDS: f64 = 2.0;
/// How far a `turn` event may sit from the usage record it belongs to.
const TURN_EVENT_SECONDS: f64 = 20.0;
/// Slack around a turn or run window when joining other records to it.
const WINDOW_SECONDS: f64 = 30.0;

/// Below this a write is ordinary growth, whatever else is true.
const MIN_REBUILD_WRITE: u64 = 20_000;
/// A rebuild writes this share of the previous context beyond normal growth.
const REBUILD_SHARE: f64 = 0.5;
/// Claude's cache TTL: reads stop sharply at 60 minutes.
const TTL_MINUTES: f64 = 60.0;
/// A real break writes about the whole context. Outside this band of write
/// over context, sub-agent writes are the likelier explanation.
const REBUILD_BAND: (f64, f64) = (0.8, 1.2);
/// Providers without write figures: idle this long before new input is shown.
const QUIET_GAP_MINUTES: f64 = 5.0;

const REPEAT_REBUILDS: u64 = 3;
const REPEAT_REBUILD_USD: f64 = 2.0;
const BIG_REBUILD_USD: f64 = 3.0;
const SWITCH_USD: f64 = 1.0;
const POSSIBLE_PREFIX_WRITE: u64 = 50_000;
const REPEAT_COMPACTIONS: u64 = 3;
const NO_ACTION_MIN_RUNS: u64 = 5;
const NO_ACTION_SHARE: f64 = 0.8;
const NO_ACTION_STREAK: u64 = 10;
const NO_ACTION_USD: f64 = 1.0;
const FAILED_USD: f64 = 1.0;
const QUIET_MAX_OUTPUT: u64 = 300;
const QUIET_MAX_CALLS: u64 = 2;
const QUIET_MIN_TURNS: u64 = 5;
const QUIET_USD: f64 = 1.0;
const OUTLIER_MULTIPLE: f64 = 3.0;
const OUTLIER_MIN_CONTEXT: u64 = 400_000;
const OUTLIER_MIN_THREADS: usize = 5;
const GROWING_MIN_TURNS: usize = 8;
const GROWING_MIN_CONTEXT: u64 = 300_000;
const GROWING_FACTOR: f64 = 1.5;
/// A context this much smaller than the turn before means it was compacted.
const COMPACTED_DROP: f64 = 0.7;

/// How far before the period usage is read, so a period's first turn is
/// compared with the turn before it rather than read as a first turn.
pub(super) const LOOKBACK_DAYS: i64 = 30;

const REBUILD_ROWS: usize = 200;
/// Report lists are capped; rule counts and totals still cover everything.
const WASTE_ROWS_PER_GROUP: usize = 100;
const HIT_RATE_ROWS: usize = 50;
const BOT_ROWS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Price {
    input: f64,
    read: f64,
    write: Option<f64>,
    output: f64,
}

const fn price(input: f64, read: f64, write: Option<f64>, output: f64) -> Price {
    Price {
        input,
        read,
        write,
        output,
    }
}

const ANTHROPIC: &str = "Anthropic pricing page, 1-hour cache writes";
const OPENAI: &str = "OpenAI list price via third-party listings; long-context tier ignored";
const XAI: &str = "xAI list price via third-party listings; long-context tier ignored";

/// List prices per million tokens. Longest prefix wins; anything not listed
/// has no estimate rather than an invented one.
const PRICES: &[(&str, &str, Price, &str)] = &[
    (
        "claude",
        "claude-fable-5-1",
        price(10.0, 0.25, Some(20.0), 50.0),
        ANTHROPIC,
    ),
    (
        "claude",
        "claude-fable-5",
        price(10.0, 1.0, Some(20.0), 50.0),
        ANTHROPIC,
    ),
    (
        "claude",
        "claude-opus-5-5",
        price(4.0, 0.2, Some(8.0), 20.0),
        ANTHROPIC,
    ),
    (
        "claude",
        "claude-opus-5",
        price(5.0, 0.5, Some(10.0), 25.0),
        ANTHROPIC,
    ),
    (
        "claude",
        "claude-sonnet-5-5",
        price(2.0, 0.1, Some(4.0), 10.0),
        ANTHROPIC,
    ),
    (
        "claude",
        "claude-sonnet-5",
        price(2.0, 0.2, Some(4.0), 10.0),
        ANTHROPIC,
    ),
    (
        "claude",
        "claude-haiku-5-5",
        price(0.1, 0.01, Some(0.2), 0.5),
        ANTHROPIC,
    ),
    ("codex", "gpt-6.1-sol", price(2.0, 0.1, None, 10.0), OPENAI),
    (
        "codex",
        "gpt-6.1-terra",
        price(1.0, 0.05, None, 5.0),
        OPENAI,
    ),
    (
        "grok",
        "grok-4.7-build-fast",
        price(4.0, 1.0, None, 12.0),
        XAI,
    ),
    ("grok", "grok-4.7-build", price(2.0, 0.5, None, 6.0), XAI),
];
/// Haiku 5.5 costs five times more once a prompt passes 100k tokens.
const HAIKU_LONG: Price = price(0.5, 0.05, Some(1.0), 2.5);
const HAIKU_LONG_PROMPT: u64 = 100_000;

pub(super) fn price_for(provider: &str, model: &str, prompt_per_call: u64) -> Option<Price> {
    let listed = PRICES
        .iter()
        .filter(|(owner, prefix, ..)| *owner == provider && model.starts_with(prefix))
        .max_by_key(|(_, prefix, ..)| prefix.len())?;
    if listed.1 == "claude-haiku-5-5" && prompt_per_call > HAIKU_LONG_PROMPT {
        return Some(HAIKU_LONG);
    }
    Some(listed.2)
}

/// Dollars per bucket of a usage record.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(super) struct Dollars {
    pub fresh: f64,
    pub write: f64,
    pub read: f64,
    pub output: f64,
}

impl Dollars {
    fn total(self) -> f64 {
        self.fresh + self.write + self.read + self.output
    }
}

pub(super) fn dollars(price: Price, fresh: u64, read: u64, write: u64, output: u64) -> Dollars {
    let million = |tokens: u64, rate: f64| tokens as f64 * rate / 1_000_000.0;
    Dollars {
        fresh: million(fresh, price.input),
        write: million(write, price.write.unwrap_or(price.input)),
        read: million(read, price.read),
        output: million(output, price.output),
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Turn {
    pub thread: String,
    pub workspace: String,
    pub provider: String,
    /// Model with the largest prompt in the turn; sub-agents can run others.
    pub model: String,
    pub models: Vec<String>,
    pub effort: Option<String>,
    pub bot: Option<String>,
    pub start: f64,
    pub end: f64,
    pub fresh: u64,
    pub read: u64,
    pub write: u64,
    pub output: u64,
    pub calls: u64,
    /// Peak context, falling back to the mean prompt per call.
    pub context: u64,
    pub ok: bool,
    /// Main chain's first call `(cache read, cache write)`, when captured.
    pub first_call: Option<(u64, u64)>,
    /// Model of that call. `model` can be a sub-agent's; this cannot.
    pub first_model: Option<String>,
    pub usd: Dollars,
    /// False when a model in the turn has no known price.
    pub priced: bool,
}

impl Turn {
    /// What the turn paid to put tokens in cache. Only Claude reports writes;
    /// elsewhere new input is the nearest measure and is not called a write.
    fn written(&self) -> u64 {
        if self.reports_writes() {
            self.write
        } else {
            self.fresh
        }
    }

    fn written_usd(&self) -> f64 {
        if self.reports_writes() {
            self.usd.write
        } else {
            self.usd.fresh
        }
    }

    fn reports_writes(&self) -> bool {
        self.provider == "claude"
    }
}

fn seconds(at: DateTime<Utc>) -> f64 {
    at.timestamp_millis() as f64 / 1000.0
}

fn prompt(record: &UsageRecord) -> u64 {
    record.uncached_input + record.cr + record.cw
}

/// One `turn` event: end time, duration, peak context, finished cleanly.
type TurnEvent = (f64, u64, u64, bool);

/// Peak context and timing per thread from `turn` events, oldest first.
fn turn_events(records: &[Record]) -> HashMap<&str, Vec<TurnEvent>> {
    let mut events: HashMap<&str, Vec<TurnEvent>> = HashMap::new();
    for record in records {
        if let Record::Turn {
            t, th, ok, ms, ctx, ..
        } = record
        {
            events
                .entry(th)
                .or_default()
                .push((seconds(*t), *ms, *ctx, *ok));
        }
    }
    for list in events.values_mut() {
        list.sort_by(|a, b| a.0.total_cmp(&b.0));
    }
    events
}

/// The turn a record belongs to, stable across arrival order. Claude ids end
/// in a stamp shared by a turn's models; other providers append the model to
/// a per-turn id. `None` when an id has neither shape.
fn turn_key(record: &UsageRecord) -> Option<String> {
    let turn = if record.prov == "claude" {
        let (_, stamp) = record.id.rsplit_once(':')?;
        (!stamp.is_empty() && stamp.bytes().all(|byte| byte.is_ascii_digit())).then_some(stamp)?
    } else {
        record
            .id
            .strip_suffix(&format!(":{}", record.model))
            .unwrap_or(&record.id)
    };
    Some(format!("{}:{turn}", record.prov))
}

/// Without a key, only another model of the same provider moments later can
/// be the same turn: one model never writes two records for one turn.
fn joins_unkeyed(group: &[&UsageRecord], record: &UsageRecord) -> bool {
    let last = group[group.len() - 1];
    last.prov == record.prov
        && seconds(record.t) - seconds(last.t) < SAME_TURN_SECONDS
        && group.iter().all(|other| other.model != record.model)
}

/// Splits one thread's records, oldest first, into turns.
fn group_turns<'a>(records: &[&'a UsageRecord]) -> Vec<Vec<&'a UsageRecord>> {
    let mut groups: Vec<Vec<&UsageRecord>> = Vec::new();
    let mut keyed: HashMap<String, usize> = HashMap::new();
    for record in records.iter().copied() {
        let Some(key) = turn_key(record) else {
            match groups.last_mut() {
                Some(group) if turn_key(group[0]).is_none() && joins_unkeyed(group, record) => {
                    group.push(record);
                }
                _ => groups.push(vec![record]),
            }
            continue;
        };
        let at = *keyed.entry(key).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[at].push(record);
    }
    groups
}

/// Groups usage into turns, each thread oldest first.
pub(super) fn build_turns(usage: &[UsageRecord], records: &[Record]) -> Vec<Vec<Turn>> {
    let events = turn_events(records);
    let mut by_thread: BTreeMap<&str, Vec<&UsageRecord>> = BTreeMap::new();
    for record in usage {
        by_thread.entry(&record.th).or_default().push(record);
    }
    let mut threads = Vec::with_capacity(by_thread.len());
    for (thread, mut list) in by_thread {
        list.sort_by_key(|record| record.t);
        let thread_events = events.get(thread).map_or(&[][..], Vec::as_slice);
        let mut used = vec![false; thread_events.len()];
        threads.push(
            group_turns(&list)
                .iter()
                .map(|group| build_turn(group, thread_events, &mut used))
                .collect(),
        );
    }
    threads
}

/// Claims the closest unclaimed event near `end`, so one event cannot lend its
/// context or failure to two turns. Sorted events keep this to the window.
fn claim_event(events: &[TurnEvent], used: &mut [bool], end: f64) -> Option<TurnEvent> {
    let from = events.partition_point(|event| event.0 <= end - TURN_EVENT_SECONDS);
    let to = events.partition_point(|event| event.0 < end + TURN_EVENT_SECONDS);
    let at = (from..to).filter(|at| !used[*at]).min_by(|a, b| {
        (events[*a].0 - end)
            .abs()
            .total_cmp(&(events[*b].0 - end).abs())
    })?;
    used[at] = true;
    Some(events[at])
}

fn build_turn(group: &[&UsageRecord], events: &[TurnEvent], used: &mut [bool]) -> Turn {
    let primary = group
        .iter()
        .max_by_key(|record| prompt(record))
        .expect("a turn has at least one record");
    // The first record marks the turn's end; a slower model's record for the
    // same turn may land after the next turn has begun.
    let end = seconds(group[0].t);
    let event = claim_event(events, used, end);
    let calls = group
        .iter()
        .filter_map(|record| record.calls)
        .sum::<u64>()
        .max(1);
    let prompts = group.iter().map(|record| prompt(record)).sum::<u64>();
    let mean_prompt = prompts / calls;
    let mut turn = Turn {
        thread: primary.th.clone(),
        workspace: primary.ws.clone(),
        provider: primary.prov.clone(),
        model: primary.model.clone(),
        effort: primary.effort.clone(),
        bot: primary.bot.clone(),
        start: end - event.map_or(0.0, |event| event.1 as f64 / 1000.0),
        end,
        calls,
        context: event
            .map(|event| event.2)
            .filter(|peak| *peak > 0)
            .unwrap_or(mean_prompt),
        ok: event.is_none_or(|event| event.3),
        first_call: group.iter().find_map(|record| record.first_call()),
        first_model: group.iter().find_map(|record| record.fcm.clone()),
        priced: true,
        ..Turn::default()
    };
    for record in group {
        if !turn.models.contains(&record.model) {
            turn.models.push(record.model.clone());
        }
        turn.fresh += record.uncached_input;
        turn.read += record.cr;
        turn.write += record.cw;
        turn.output += record.out;
        let per_call = prompt(record) / record.calls.unwrap_or(calls).max(1);
        match price_for(&record.prov, &record.model, per_call) {
            Some(price) => {
                let usd = dollars(
                    price,
                    record.uncached_input,
                    record.cr,
                    record.cw,
                    record.out,
                );
                turn.usd.fresh += usd.fresh;
                turn.usd.write += usd.write;
                turn.usd.read += usd.read;
                turn.usd.output += usd.output;
            }
            None => turn.priced = false,
        }
    }
    turn
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(super) enum Cause {
    FirstTurn,
    IdleGap,
    ModelSwitch,
    EffortSwitch,
    Compaction,
    /// A warm first call missed, same main model and effort on record, no
    /// compaction. The miss is proven; who or what caused it is not.
    PrefixChange,
    /// Looks like a prefix change, on records that cannot rule the rest out.
    PossiblePrefixChange,
    /// Large write that sub-agents or compaction could equally explain.
    Unclear,
    /// New input after a gap, on a provider that reports no writes.
    InputAfterGap,
}

impl Cause {
    fn id(self) -> &'static str {
        match self {
            Self::FirstTurn => "first_turn",
            Self::IdleGap => "idle_gap",
            Self::ModelSwitch => "model_switch",
            Self::EffortSwitch => "effort_switch",
            Self::Compaction => "compaction",
            Self::PrefixChange => "prefix_change",
            Self::PossiblePrefixChange => "possible_prefix_change",
            Self::Unclear => "unclear",
            Self::InputAfterGap => "input_after_gap",
        }
    }
}

/// Did the main chain's first call miss the cache? `None` on records from
/// before first calls were captured.
fn first_call_missed(turn: &Turn) -> Option<bool> {
    turn.first_call.map(|(read, write)| {
        write >= MIN_REBUILD_WRITE && write as f64 >= REBUILD_SHARE * (read + write) as f64
    })
}

/// Why a turn rewrote the cache, or `None` when it did not. The write is
/// compared with the thread's previous context, not a fixed size: only what
/// exceeds normal growth counts. `compacted` is a recorded compaction.
///
/// A captured first-call hit outranks every cause: the cache was warm, so
/// whatever wrote those tokens did not break it on the way in. That sends a
/// compaction partway through a turn to `Unclear` too, which errs towards a
/// missed flag over a false one.
pub(super) fn classify(turn: &Turn, previous: Option<&Turn>, compacted: bool) -> Option<Cause> {
    let written = turn.written();
    if written < MIN_REBUILD_WRITE {
        return None;
    }
    let missed = first_call_missed(turn);
    let Some(previous) = previous else {
        return Some(if missed == Some(false) {
            Cause::Unclear
        } else {
            Cause::FirstTurn
        });
    };
    let growth = turn.context.saturating_sub(previous.context);
    if ((written.saturating_sub(growth)) as f64) < REBUILD_SHARE * previous.context as f64 {
        return None;
    }
    let gap = (turn.start - previous.end) / 60.0;
    if !turn.reports_writes() {
        // New input and a rebuild look the same here, so no cause is claimed.
        return (gap >= QUIET_GAP_MINUTES).then_some(Cause::InputAfterGap);
    }
    if missed == Some(false) {
        return Some(Cause::Unclear);
    }
    if gap >= TTL_MINUTES {
        return Some(Cause::IdleGap);
    }
    if compacted {
        return Some(Cause::Compaction);
    }
    let ratio = written as f64 / turn.context.max(1) as f64;
    if missed.is_none() && !(REBUILD_BAND.0..=REBUILD_BAND.1).contains(&ratio) {
        return Some(Cause::Unclear);
    }
    // Main-chain models when both are captured: the aggregate `model` can be
    // a sub-agent's and hide a real switch, or invent one.
    let main_models = turn.first_model.as_ref().zip(previous.first_model.as_ref());
    let switched = match main_models {
        Some((now, before)) => now != before,
        None => !turn.models.contains(&previous.model),
    };
    if switched {
        return Some(Cause::ModelSwitch);
    }
    let efforts = turn.effort.as_ref().zip(previous.effort.as_ref());
    if efforts.is_some_and(|(now, before)| now != before) {
        return Some(Cause::EffortSwitch);
    }
    // Proven only when the same model and effort are on record for both turns.
    Some(
        if missed == Some(true) && main_models.is_some() && efforts.is_some() {
            Cause::PrefixChange
        } else {
            Cause::PossiblePrefixChange
        },
    )
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Rebuild {
    pub turn: Turn,
    pub cause: Cause,
    pub gap_minutes: Option<f64>,
    /// Automation whose run this turn belonged to.
    pub automation: Option<(String, String)>,
}

/// Everything the report is computed from.
pub(super) struct CacheInput<'a> {
    pub days: u32,
    pub since: DateTime<Utc>,
    /// Usage from `LOOKBACK_DAYS` before `since`.
    pub usage: &'a [UsageRecord],
    /// Activity for the period, from the same lookback.
    pub records: &'a [Record],
    pub runs: &'a [AutomationRun],
    pub automations: &'a [AnalyticsAutomation],
    pub labels: &'a Labels,
}

fn compactions(records: &[Record]) -> HashMap<&str, Vec<f64>> {
    let mut found: HashMap<&str, Vec<f64>> = HashMap::new();
    for record in records {
        if let Record::Compact { t, th } = record {
            found.entry(th).or_default().push(seconds(*t));
        }
    }
    sort_times(&mut found);
    found
}

/// Whether sorted `times` holds a moment in `from..=to`.
fn any_within(times: &[f64], from: f64, to: f64) -> bool {
    let at = times.partition_point(|time| *time < from);
    times.get(at).is_some_and(|time| *time <= to)
}

fn sort_times(times: &mut HashMap<&str, Vec<f64>>) {
    for list in times.values_mut() {
        list.sort_by(f64::total_cmp);
    }
}

fn run_window(run: &AutomationRun) -> Option<(f64, f64)> {
    let start = run.started_at?;
    let finish = run.finished_at?;
    Some((
        seconds(start) - WINDOW_SECONDS,
        seconds(finish) + WINDOW_SECONDS,
    ))
}

fn is_finished(status: &AutomationRunStatus) -> bool {
    matches!(
        status,
        AutomationRunStatus::Succeeded
            | AutomationRunStatus::SucceededNoAction
            | AutomationRunStatus::Failed
            | AutomationRunStatus::Cancelled
    )
}

/// Runs by thread, so a turn can be tied to the automation that caused it.
fn runs_by_thread(runs: &[AutomationRun]) -> HashMap<&str, Vec<&AutomationRun>> {
    let mut found: HashMap<&str, Vec<&AutomationRun>> = HashMap::new();
    for run in runs {
        if let Some(thread) = run.thread_id.as_deref() {
            found.entry(thread).or_default().push(run);
        }
    }
    found
}

fn run_of<'a>(
    turn: &Turn,
    runs: &HashMap<&str, Vec<&'a AutomationRun>>,
) -> Option<&'a AutomationRun> {
    runs.get(turn.thread.as_str())?.iter().copied().find(|run| {
        run_window(run).is_some_and(|(start, end)| turn.end >= start && turn.end <= end)
    })
}

pub(super) fn find_rebuilds(threads: &[Vec<Turn>], input: &CacheInput<'_>) -> Vec<Rebuild> {
    let since = seconds(input.since);
    let compacted = compactions(input.records);
    let runs = runs_by_thread(input.runs);
    let mut rebuilds = Vec::new();
    for turns in threads {
        let marks = turns
            .first()
            .and_then(|turn| compacted.get(turn.thread.as_str()))
            .map_or(&[][..], Vec::as_slice);
        for (index, turn) in turns.iter().enumerate() {
            if turn.end < since {
                continue;
            }
            let previous = index.checked_sub(1).map(|at| &turns[at]);
            let from = previous.map_or(turn.start, |previous| previous.end) - WINDOW_SECONDS;
            let was_compacted = any_within(marks, from, turn.end + WINDOW_SECONDS);
            let Some(cause) = classify(turn, previous, was_compacted) else {
                continue;
            };
            rebuilds.push(Rebuild {
                turn: turn.clone(),
                cause,
                gap_minutes: previous.map(|previous| (turn.start - previous.end) / 60.0),
                automation: run_of(turn, &runs)
                    .map(|run| (run.automation_id.clone(), run.automation_name.clone())),
            });
        }
    }
    rebuilds
}

fn hit_rates(usage: &[&UsageRecord], labels: &Labels) -> Vec<AnalyticsCacheHitRate> {
    let mut rows: BTreeMap<(&'static str, String), AnalyticsCacheHitRate> = BTreeMap::new();
    for record in usage {
        let mut keys = vec![
            ("provider", record.prov.clone(), Some(record.prov.clone())),
            ("model", record.model.clone(), Some(record.prov.clone())),
        ];
        if let Some(bot) = record.bot.as_deref() {
            keys.push(("bot", labels.bot_name(bot), None));
        }
        for (dimension, key, provider) in keys {
            let row =
                rows.entry((dimension, key.clone()))
                    .or_insert_with(|| AnalyticsCacheHitRate {
                        dimension: dimension.to_string(),
                        key,
                        provider,
                        ..AnalyticsCacheHitRate::default()
                    });
            row.fresh_tokens += record.uncached_input;
            row.read_tokens += record.cr;
            row.write_tokens += record.cw;
        }
    }
    let mut rows: Vec<_> = rows.into_values().collect();
    for row in &mut rows {
        let whole = row.fresh_tokens + row.read_tokens + row.write_tokens;
        row.hit_rate = if whole == 0 {
            0.0
        } else {
            row.read_tokens as f64 / whole as f64
        };
    }
    rows.sort_by(|a, b| {
        a.dimension.cmp(&b.dimension).then(
            (b.fresh_tokens + b.read_tokens + b.write_tokens)
                .cmp(&(a.fresh_tokens + a.read_tokens + a.write_tokens)),
        )
    });
    let mut shown: HashMap<String, usize> = HashMap::new();
    rows.retain(|row| {
        let seen = shown.entry(row.dimension.clone()).or_default();
        *seen += 1;
        *seen <= HIT_RATE_ROWS
    });
    rows
}

fn cost_mix(usage: &[&UsageRecord]) -> Vec<AnalyticsCostMix> {
    let mut rows: BTreeMap<&str, AnalyticsCostMix> = BTreeMap::new();
    for record in usage {
        let row = rows
            .entry(&record.prov)
            .or_insert_with(|| AnalyticsCostMix {
                provider: record.prov.clone(),
                write_reporting: "reported_zero".to_string(),
                ..AnalyticsCostMix::default()
            });
        if record.cw > 0 {
            row.write_reporting = "reported".to_string();
        }
        row.recorded_usd += record.cost.unwrap_or(0.0);
        let per_call = prompt(record) / record.calls.unwrap_or(1).max(1);
        match price_for(&record.prov, &record.model, per_call) {
            Some(price) => {
                let usd = dollars(price, record.uncached_input, record.cr, record.cw, 0);
                row.fresh_usd += usd.fresh;
                row.write_usd += usd.write;
                row.read_usd += usd.read;
            }
            None => row.unpriced_tokens += prompt(record),
        }
    }
    rows.into_values().collect()
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    })
}

fn add_group(
    groups: &mut BTreeMap<String, (AnalyticsRebuildGroup, HashMap<Cause, u64>)>,
    key: String,
    label: String,
    rebuild: &Rebuild,
    bot: Option<String>,
) {
    let (group, causes) = groups.entry(key.clone()).or_insert_with(|| {
        (
            AnalyticsRebuildGroup {
                key,
                label,
                workspace: Some(rebuild.turn.workspace.clone()),
                bot,
                ..AnalyticsRebuildGroup::default()
            },
            HashMap::new(),
        )
    });
    group.count += 1;
    group.tokens += rebuild.turn.written();
    group.estimated_usd += rebuild.turn.written_usd();
    *causes.entry(rebuild.cause).or_default() += rebuild.turn.written();
}

fn finish_groups(
    groups: BTreeMap<String, (AnalyticsRebuildGroup, HashMap<Cause, u64>)>,
) -> Vec<AnalyticsRebuildGroup> {
    let mut rows: Vec<_> = groups
        .into_values()
        .map(|(mut group, causes)| {
            group.top_cause = causes
                .into_iter()
                .max_by_key(|(cause, tokens)| (*tokens, *cause))
                .map(|(cause, _)| cause.id().to_string())
                .unwrap_or_default();
            group
        })
        .collect();
    rows.sort_by(|a, b| b.estimated_usd.total_cmp(&a.estimated_usd));
    rows.truncate(REBUILD_ROWS);
    rows
}

/// Rebuilds that say something about the cache: first turns of a new thread
/// are the price of starting and stay out of the bot and thread rollups.
fn add_rebuild_tables(report: &mut AnalyticsCacheReport, rebuilds: &[Rebuild], labels: &Labels) {
    let mut causes: BTreeMap<Cause, AnalyticsRebuildCause> = BTreeMap::new();
    let (mut bots, mut threads) = (BTreeMap::new(), BTreeMap::new());
    for rebuild in rebuilds {
        let row = causes
            .entry(rebuild.cause)
            .or_insert_with(|| AnalyticsRebuildCause {
                cause: rebuild.cause.id().to_string(),
                ..AnalyticsRebuildCause::default()
            });
        row.count += 1;
        row.tokens += rebuild.turn.written();
        row.estimated_usd += rebuild.turn.written_usd();
        if rebuild.cause == Cause::FirstTurn {
            continue;
        }
        let bot = rebuild.turn.bot.as_deref().map(|bot| labels.bot_name(bot));
        if let Some(name) = bot.clone() {
            add_group(&mut bots, name.clone(), name, rebuild, None);
        }
        let thread = &rebuild.turn.thread;
        add_group(
            &mut threads,
            thread.clone(),
            labels.title(thread),
            rebuild,
            bot,
        );
    }
    report.rebuilds_by_cause = causes.into_values().collect();
    report
        .rebuilds_by_cause
        .sort_by(|a, b| b.estimated_usd.total_cmp(&a.estimated_usd));
    report.rebuilds_by_bot = finish_groups(bots);
    report.rebuilds_by_thread = finish_groups(threads);
}

fn home_threads(
    threads: &[Vec<Turn>],
    rebuilds: &[Rebuild],
    since: f64,
    labels: &Labels,
) -> Vec<AnalyticsHomeThreadCache> {
    let mut rebuilt: HashMap<&str, (u64, f64)> = HashMap::new();
    for rebuild in rebuilds {
        let row = rebuilt.entry(&rebuild.turn.thread).or_default();
        row.0 += rebuild.turn.written();
        row.1 += rebuild.turn.written_usd();
    }
    let mut rows = Vec::new();
    for turns in threads {
        let Some(first) = turns.first() else { continue };
        let Some(bot) = labels.bots.get(&first.thread) else {
            continue;
        };
        let mut row = AnalyticsHomeThreadCache {
            thread: first.thread.clone(),
            bot: bot.clone(),
            workspace: Some(first.workspace.clone()),
            ..AnalyticsHomeThreadCache::default()
        };
        let (mut prompts, mut calls, mut gaps) = (0, 0, Vec::new());
        for (index, turn) in turns.iter().enumerate() {
            if turn.end < since {
                continue;
            }
            row.turns += 1;
            prompts += turn.fresh + turn.read + turn.write;
            calls += turn.calls;
            row.peak_context = row.peak_context.max(turn.context);
            let Some(previous) = index.checked_sub(1).map(|at| &turns[at]) else {
                continue;
            };
            let gap = ((turn.start - previous.end) / 60.0).max(0.0);
            gaps.push(gap);
            match gap {
                gap if gap < QUIET_GAP_MINUTES => row.gaps_under_5 += 1,
                gap if gap < TTL_MINUTES => row.gaps_5_to_60 += 1,
                _ => row.gaps_over_60 += 1,
            }
        }
        if row.turns == 0 {
            continue;
        }
        row.context_per_call = prompts / calls.max(1);
        row.median_gap_minutes = median(&mut gaps);
        if let Some((tokens, usd)) = rebuilt.get(row.thread.as_str()) {
            row.rebuild_tokens = *tokens;
            row.rebuild_usd = *usd;
        }
        rows.push(row);
    }
    rows.sort_by(|a, b| b.rebuild_usd.total_cmp(&a.rebuild_usd));
    rows.truncate(BOT_ROWS);
    rows
}

fn overhead(
    threads: &[Vec<Turn>],
    records: &[Record],
    since: f64,
    labels: &Labels,
) -> Vec<AnalyticsBotOverhead> {
    let mut injected: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for record in records {
        if let Record::Context { t, th, tok } = record
            && seconds(*t) >= since
            && let Some(bot) = labels.bot_of(th)
        {
            let row = injected.entry(bot.clone()).or_default();
            row.0 += 1;
            row.1 += tok;
        }
    }
    let mut context: HashMap<&str, (u64, u64)> = HashMap::new();
    for turn in threads.iter().flatten().filter(|turn| turn.end >= since) {
        if let Some(bot) = labels.bot_of(&turn.thread) {
            let row = context.entry(bot).or_default();
            row.0 += 1;
            row.1 += turn.context;
        }
    }
    let mut rows: Vec<_> = injected
        .iter()
        .filter(|(_, (turns, _))| *turns > 0)
        .map(|(bot, (turns, tokens))| {
            let avg_tokens = tokens / turns;
            let avg_context = context
                .get(bot.as_str())
                .filter(|(turns, _)| *turns > 0)
                .map_or(0, |(turns, tokens)| tokens / turns);
            AnalyticsBotOverhead {
                bot: bot.clone(),
                turns: *turns,
                avg_tokens,
                avg_context,
                share: if avg_context == 0 {
                    0.0
                } else {
                    avg_tokens as f64 / avg_context as f64
                },
            }
        })
        .collect();
    rows.sort_by(|a, b| b.avg_tokens.cmp(&a.avg_tokens));
    rows.truncate(BOT_ROWS);
    rows
}

fn tokens_label(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else {
        format!("{}k", tokens / 1000)
    }
}

fn gap_label(minutes: f64) -> String {
    if minutes >= 60.0 {
        format!("{:.1} h", minutes / 60.0)
    } else {
        format!("{minutes:.0} min")
    }
}

fn plural(count: u64, one: &str) -> String {
    format!("{count} {one}{}", if count == 1 { "" } else { "s" })
}

/// Where a flag should link: the automation that caused it, else the thread.
fn point_at(
    item: &mut AnalyticsWasteItem,
    turn: &Turn,
    automation: Option<&(String, String)>,
    labels: &Labels,
) {
    item.workspace = Some(turn.workspace.clone());
    item.thread = Some(turn.thread.clone());
    item.bot = labels.bot_of(&turn.thread).cloned();
    item.label = labels.title(&turn.thread);
    if let Some((id, name)) = automation {
        item.automation = Some(id.clone());
        item.label = name.clone();
    }
}

fn item(rule: &str, group: &str, certainty: &str) -> AnalyticsWasteItem {
    AnalyticsWasteItem {
        rule: rule.to_string(),
        group: group.to_string(),
        severity: "normal".to_string(),
        certainty: certainty.to_string(),
        ..AnalyticsWasteItem::default()
    }
}

/// Rebuilds of one cause grouped by what to fix: the automation that caused
/// them when there is one, otherwise the thread.
fn offenders<'a>(
    rebuilds: impl Iterator<Item = &'a Rebuild>,
) -> BTreeMap<String, Vec<&'a Rebuild>> {
    let mut groups: BTreeMap<String, Vec<&Rebuild>> = BTreeMap::new();
    for rebuild in rebuilds {
        let key = rebuild
            .automation
            .as_ref()
            .map_or_else(|| rebuild.turn.thread.clone(), |(id, _)| id.clone());
        groups.entry(key).or_default().push(rebuild);
    }
    groups
}

fn automation_flags(input: &CacheInput<'_>, id: Option<&String>, wanted: &[&str]) -> Vec<String> {
    let Some(id) = id else { return Vec::new() };
    input
        .automations
        .iter()
        .find(|automation| automation.id.as_ref() == Some(id))
        .map(|automation| {
            automation
                .flags
                .iter()
                .filter(|flag| wanted.contains(&flag.as_str()))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn cache_waste(rebuilds: &[Rebuild], input: &CacheInput<'_>) -> Vec<AnalyticsWasteItem> {
    let labels = input.labels;
    let mut items = Vec::new();
    let mut repeated: HashSet<*const Rebuild> = HashSet::new();
    for group in offenders(
        rebuilds
            .iter()
            .filter(|rebuild| rebuild.cause == Cause::IdleGap),
    )
    .values()
    {
        let count = group.len() as u64;
        let usd: f64 = group.iter().map(|rebuild| rebuild.turn.written_usd()).sum();
        if count < REPEAT_REBUILDS || usd < REPEAT_REBUILD_USD {
            continue;
        }
        repeated.extend(group.iter().map(|rebuild| std::ptr::from_ref(*rebuild)));
        let mut gaps: Vec<f64> = group
            .iter()
            .filter_map(|rebuild| rebuild.gap_minutes)
            .collect();
        let gap = median(&mut gaps).unwrap_or(0.0);
        let tokens: u64 = group.iter().map(|rebuild| rebuild.turn.write).sum();
        let last = group[group.len() - 1];
        let mut flagged = item("repeat_idle_gap", "cache", "estimate");
        point_at(&mut flagged, &last.turn, last.automation.as_ref(), labels);
        flagged.flags = automation_flags(
            input,
            flagged.automation.as_ref(),
            &["cache_cold_reuse", "bot_home_frequent"],
        );
        let cold = if flagged.flags.iter().any(|flag| flag == "cache_cold_reuse") {
            "; also flagged Cold cache reuse"
        } else {
            ""
        };
        flagged.reason = format!(
            "Cache rebuilt {count} times after idle gaps, median {}, past the 60-minute TTL; {} rewritten{cold}",
            gap_label(gap),
            tokens_label(tokens),
        );
        flagged.estimated_usd = usd;
        flagged.occurrences = count;
        items.push(flagged);
    }
    for rebuild in rebuilds {
        let usd = rebuild.turn.written_usd();
        let in_repeat = repeated.contains(&std::ptr::from_ref(rebuild));
        if rebuild.cause == Cause::IdleGap && !in_repeat && usd >= BIG_REBUILD_USD {
            let mut flagged = item("big_rebuild", "cache", "estimate");
            point_at(
                &mut flagged,
                &rebuild.turn,
                rebuild.automation.as_ref(),
                labels,
            );
            flagged.reason = format!(
                "One rebuild after {} idle rewrote {}",
                gap_label(rebuild.gap_minutes.unwrap_or(0.0)),
                tokens_label(rebuild.turn.write),
            );
            flagged.estimated_usd = usd;
            flagged.occurrences = 1;
            items.push(flagged);
        }
        if matches!(rebuild.cause, Cause::ModelSwitch | Cause::EffortSwitch) && usd >= SWITCH_USD {
            let mut flagged = item("switch", "cache", "estimate");
            point_at(
                &mut flagged,
                &rebuild.turn,
                rebuild.automation.as_ref(),
                labels,
            );
            let what = if rebuild.cause == Cause::ModelSwitch {
                "A model"
            } else {
                "An effort"
            };
            flagged.reason = format!("{what} switch rewrote {}", tokens_label(rebuild.turn.write));
            flagged.estimated_usd = usd;
            flagged.occurrences = 1;
            items.push(flagged);
        }
    }
    for group in offenders(
        rebuilds
            .iter()
            .filter(|rebuild| rebuild.cause == Cause::PrefixChange),
    )
    .values()
    {
        let last = group[group.len() - 1];
        let mut flagged = item("prefix_change", "cache", "proven");
        flagged.severity = "high".to_string();
        point_at(&mut flagged, &last.turn, last.automation.as_ref(), labels);
        let tokens: u64 = group.iter().map(|rebuild| rebuild.turn.write).sum();
        flagged.reason = format!(
            "First call missed a warm cache {}: same main model and effort, no compaction recorded, {} rewritten. The records don't show what changed",
            plural(group.len() as u64, "time"),
            tokens_label(tokens),
        );
        flagged.estimated_usd = group.iter().map(|rebuild| rebuild.turn.written_usd()).sum();
        flagged.occurrences = group.len() as u64;
        items.push(flagged);
    }
    for group in offenders(rebuilds.iter().filter(|rebuild| {
        rebuild.cause == Cause::PossiblePrefixChange && rebuild.turn.write >= POSSIBLE_PREFIX_WRITE
    }))
    .values()
    {
        let last = group[group.len() - 1];
        let mut flagged = item("possible_prefix_change", "cache", "possible");
        point_at(&mut flagged, &last.turn, last.automation.as_ref(), labels);
        let tokens: u64 = group.iter().map(|rebuild| rebuild.turn.write).sum();
        flagged.reason = format!(
            "Rewrote {} while the cache should have been warm. Possibly a prefix change; a compaction or a provider cache drop looks the same",
            tokens_label(tokens),
        );
        flagged.estimated_usd = group.iter().map(|rebuild| rebuild.turn.written_usd()).sum();
        flagged.occurrences = group.len() as u64;
        items.push(flagged);
    }
    for group in offenders(
        rebuilds
            .iter()
            .filter(|rebuild| rebuild.cause == Cause::Compaction),
    )
    .values()
    {
        let count = group.len() as u64;
        if count < REPEAT_COMPACTIONS {
            continue;
        }
        let last = group[group.len() - 1];
        let mut flagged = item("repeat_compaction", "cache", "estimate");
        point_at(&mut flagged, &last.turn, last.automation.as_ref(), labels);
        flagged.reason = format!("Compacted {count} times, rebuilding the cache each time");
        flagged.estimated_usd = group.iter().map(|rebuild| rebuild.turn.written_usd()).sum();
        flagged.occurrences = count;
        items.push(flagged);
    }
    items
}

fn result_waste(threads: &[Vec<Turn>], input: &CacheInput<'_>) -> Vec<AnalyticsWasteItem> {
    let since = seconds(input.since);
    let labels = input.labels;
    let mut items = Vec::new();
    let turns_of: HashMap<&str, &Vec<Turn>> = threads
        .iter()
        .filter_map(|turns| Some((turns.first()?.thread.as_str(), turns)))
        .collect();
    let run_usd = |run: &AutomationRun| -> f64 {
        let (Some(thread), Some((start, end))) = (run.thread_id.as_deref(), run_window(run)) else {
            return 0.0;
        };
        turns_of.get(thread).map_or(0.0, |turns| {
            let from = turns.partition_point(|turn| turn.end < start);
            turns[from..]
                .iter()
                .take_while(|turn| turn.end <= end)
                .map(|turn| turn.usd.total())
                .sum()
        })
    };
    let mut by_automation: BTreeMap<&str, Vec<&AutomationRun>> = BTreeMap::new();
    for run in input.runs.iter().filter(|run| is_finished(&run.status)) {
        by_automation
            .entry(&run.automation_id)
            .or_default()
            .push(run);
    }
    for (id, runs) in &mut by_automation {
        let summary = input
            .automations
            .iter()
            .find(|automation| automation.id.as_deref() == Some(*id));
        // A paused automation has already been dealt with.
        if summary.is_some_and(|automation| automation.state == "paused") {
            continue;
        }
        runs.sort_by_key(|run| run.queued_at);
        let idle: Vec<_> = runs
            .iter()
            .filter(|run| run.status == AutomationRunStatus::SucceededNoAction)
            .collect();
        let streak = runs
            .iter()
            .rev()
            .take_while(|run| run.status == AutomationRunStatus::SucceededNoAction)
            .count() as u64;
        let total = runs.len() as u64;
        let share = idle.len() as f64 / total as f64;
        let usd: f64 = idle.iter().map(|run| run_usd(run)).sum();
        let mostly_idle = total >= NO_ACTION_MIN_RUNS && share >= NO_ACTION_SHARE;
        if usd < NO_ACTION_USD || !(mostly_idle || streak >= NO_ACTION_STREAK) {
            continue;
        }
        let last = runs[runs.len() - 1];
        let mut flagged = item("no_action", "result", "estimate");
        flagged.automation = Some((*id).to_string());
        flagged.label = last.automation_name.clone();
        flagged.bot = last.run_as_bot.clone();
        flagged.flags = automation_flags(
            input,
            flagged.automation.as_ref(),
            &["rarely_useful", "very_frequent"],
        );
        flagged.reason = if streak >= NO_ACTION_STREAK {
            format!(
                "Last {streak} runs found nothing to do; {} of {total} in the period",
                idle.len()
            )
        } else {
            format!("{} of {total} runs found nothing to do", idle.len())
        };
        flagged.estimated_usd = usd;
        flagged.occurrences = idle.len() as u64;
        items.push(flagged);
    }
    let runs = runs_by_thread(input.runs);
    for turn in threads
        .iter()
        .flatten()
        .filter(|turn| turn.end >= since && !turn.ok)
    {
        let usd = turn.usd.total();
        if usd < FAILED_USD {
            continue;
        }
        let run = run_of(turn, &runs);
        let automation = run.map(|run| (run.automation_id.clone(), run.automation_name.clone()));
        let mut flagged = item("failed_spend", "result", "estimate");
        point_at(&mut flagged, turn, automation.as_ref(), labels);
        flagged.reason = format!(
            "Turn ended without finishing after {} of context read and written",
            tokens_label(turn.fresh + turn.read + turn.write)
        );
        flagged.estimated_usd = usd;
        flagged.occurrences = 1;
        items.push(flagged);
    }
    items.extend(quiet_turns(threads, input));
    items
}

/// Moments each thread acted: wrote a file, committed, delegated or messaged.
fn acted(records: &[Record]) -> HashMap<&str, Vec<f64>> {
    let mut found: HashMap<&str, Vec<f64>> = HashMap::new();
    for record in records {
        let (thread, at) = match record {
            Record::File { th, t, .. } | Record::Commit { th, t, .. } => (th, t),
            Record::Delegate { parent, t, .. } => (parent, t),
            Record::Agent { from, t, .. } => (from, t),
            _ => continue,
        };
        found.entry(thread).or_default().push(seconds(*at));
    }
    sort_times(&mut found);
    found
}

/// A bot home turn that replied briefly and did nothing visible.
fn is_quiet(turn: &Turn, actions: &[f64]) -> bool {
    turn.output <= QUIET_MAX_OUTPUT
        && turn.calls <= QUIET_MAX_CALLS
        && !any_within(
            actions,
            turn.start - WINDOW_SECONDS,
            turn.end + WINDOW_SECONDS,
        )
}

fn quiet_turns(threads: &[Vec<Turn>], input: &CacheInput<'_>) -> Vec<AnalyticsWasteItem> {
    let since = seconds(input.since);
    let actions = acted(input.records);
    let mut items = Vec::new();
    for turns in threads {
        let Some(first) = turns.first() else { continue };
        if !input.labels.bots.contains_key(&first.thread) {
            continue;
        }
        let thread_actions = actions
            .get(first.thread.as_str())
            .map_or(&[][..], Vec::as_slice);
        let quiet: Vec<&Turn> = turns
            .iter()
            .filter(|turn| turn.end >= since && is_quiet(turn, thread_actions))
            .collect();
        let usd: f64 = quiet.iter().map(|turn| turn.usd.total()).sum();
        let count = quiet.len() as u64;
        if count < QUIET_MIN_TURNS || usd < QUIET_USD {
            continue;
        }
        let mut flagged = item("quiet_bot_turns", "result", "estimate");
        point_at(&mut flagged, first, None, input.labels);
        flagged.reason =
            format!("{count} home turns replied briefly with no file, commit, task or message",);
        flagged.estimated_usd = usd;
        flagged.occurrences = count;
        items.push(flagged);
    }
    items
}

fn thread_kind(
    thread: &str,
    labels: &Labels,
    runs: &HashMap<&str, Vec<&AutomationRun>>,
) -> &'static str {
    if labels.bots.contains_key(thread) {
        "home"
    } else if labels.automations.contains_key(thread) || runs.contains_key(thread) {
        "automation"
    } else {
        "task"
    }
}

fn bloat_waste(threads: &[Vec<Turn>], input: &CacheInput<'_>) -> Vec<AnalyticsWasteItem> {
    let since = seconds(input.since);
    let runs = runs_by_thread(input.runs);
    let compacted = compactions(input.records);
    let active: Vec<Vec<&Turn>> = threads
        .iter()
        .map(|turns| {
            turns
                .iter()
                .filter(|turn| turn.end >= since)
                .collect::<Vec<_>>()
        })
        .filter(|turns: &Vec<&Turn>| !turns.is_empty())
        .collect();
    let peak = |turns: &[&Turn]| turns.iter().map(|turn| turn.context).max().unwrap_or(0);
    let mut peaks: HashMap<&str, Vec<f64>> = HashMap::new();
    for turns in &active {
        peaks
            .entry(thread_kind(&turns[0].thread, input.labels, &runs))
            .or_default()
            .push(peak(turns) as f64);
    }
    let sizes: HashMap<&str, usize> = peaks
        .iter()
        .map(|(kind, list)| (*kind, list.len()))
        .collect();
    let norms: HashMap<&str, f64> = peaks
        .iter_mut()
        .filter_map(|(kind, list)| Some((*kind, median(list)?)))
        .collect();
    let mut items = Vec::new();
    for turns in &active {
        let top = peak(turns);
        let first = turns[0];
        let last = turns[turns.len() - 1];
        let kind = thread_kind(&first.thread, input.labels, &runs);
        let read_usd: f64 = turns.iter().map(|turn| turn.usd.read).sum();
        let norm = norms.get(kind).copied().unwrap_or(0.0);
        if sizes.get(kind).copied().unwrap_or(0) >= OUTLIER_MIN_THREADS
            && top >= OUTLIER_MIN_CONTEXT
            && top as f64 > OUTLIER_MULTIPLE * norm
        {
            let mut flagged = item("context_outlier", "bloat", "estimate");
            point_at(&mut flagged, last, None, input.labels);
            flagged.reason = format!(
                "Peak context {} is {:.0}× the {} norm for {kind} threads",
                tokens_label(top),
                top as f64 / norm.max(1.0),
                tokens_label(norm as u64),
            );
            flagged.estimated_usd = read_usd * (1.0 - norm / top as f64);
            flagged.occurrences = 1;
            items.push(flagged);
        }
        let shrank = turns
            .windows(2)
            .any(|pair| (pair[1].context as f64) < COMPACTED_DROP * pair[0].context as f64);
        let recorded = compacted.contains_key(first.thread.as_str());
        if turns.len() >= GROWING_MIN_TURNS
            && last.context >= GROWING_MIN_CONTEXT
            && last.context as f64 >= GROWING_FACTOR * first.context as f64
            && !shrank
            && !recorded
        {
            let mut flagged = item("context_growing", "bloat", "estimate");
            point_at(&mut flagged, last, None, input.labels);
            flagged.reason = format!(
                "Grew from {} to {} over {} with no compaction",
                tokens_label(first.context),
                tokens_label(last.context),
                plural(turns.len() as u64, "turn"),
            );
            flagged.estimated_usd = read_usd * (1.0 - first.context as f64 / last.context as f64);
            flagged.occurrences = turns.len() as u64;
            items.push(flagged);
        }
    }
    items
}

fn rules(items: &[AnalyticsWasteItem]) -> Vec<AnalyticsWasteRule> {
    let definitions = [
        (
            "prefix_change",
            "cache",
            "Prefix change",
            format!(
                "A warm Claude turn whose first main-chain call missed the cache, with the same main model and effort on record for both turns and no recorded compaction. The miss is proven, its cause is not. Needs records from this build on."
            ),
        ),
        (
            "possible_prefix_change",
            "cache",
            "Possible prefix change",
            format!(
                "A warm Claude turn that rewrote at least {} tokens, on records too thin to rule out a model switch or an uncaptured compaction. Not proven.",
                tokens_label(POSSIBLE_PREFIX_WRITE),
            ),
        ),
        (
            "repeat_idle_gap",
            "cache",
            "Repeat idle rebuilds",
            format!(
                "{REPEAT_REBUILDS} or more rebuilds after idle gaps past the {TTL_MINUTES:.0}-minute TTL, costing ${REPEAT_REBUILD_USD:.0} or more, on one task or automation."
            ),
        ),
        (
            "big_rebuild",
            "cache",
            "Large rebuild",
            format!("One idle-gap rebuild costing ${BIG_REBUILD_USD:.0} or more."),
        ),
        (
            "switch",
            "cache",
            "Model or effort switch",
            format!(
                "A switch that rewrote about the whole context, costing ${SWITCH_USD:.0} or more."
            ),
        ),
        (
            "repeat_compaction",
            "cache",
            "Repeat compaction",
            format!(
                "{REPEAT_COMPACTIONS} or more recorded compactions that rebuilt the cache on one task."
            ),
        ),
        (
            "no_action",
            "result",
            "Runs with nothing to do",
            format!(
                "An enabled automation with {NO_ACTION_MIN_RUNS}+ runs and {:.0}%+ no action, or the last {NO_ACTION_STREAK}+ runs in a row, spending ${NO_ACTION_USD:.0}+ on them.",
                NO_ACTION_SHARE * 100.0,
            ),
        ),
        (
            "failed_spend",
            "result",
            "Spent, then failed",
            format!(
                "A turn that ended unfinished after costing ${FAILED_USD:.0} or more. Includes turns you interrupted."
            ),
        ),
        (
            "quiet_bot_turns",
            "result",
            "Quiet bot turns",
            format!(
                "{QUIET_MIN_TURNS}+ home turns of at most {QUIET_MAX_CALLS} calls and {QUIET_MAX_OUTPUT} output tokens with no file, commit, task or message, costing ${QUIET_USD:.0}+."
            ),
        ),
        (
            "context_outlier",
            "bloat",
            "Oversized context",
            format!(
                "Peak context over {OUTLIER_MULTIPLE:.0}× the median for home, automation or task threads, and at least {}.",
                tokens_label(OUTLIER_MIN_CONTEXT),
            ),
        ),
        (
            "context_growing",
            "bloat",
            "Growing without compaction",
            format!(
                "{GROWING_MIN_TURNS}+ turns ending at {} or more, up {GROWING_FACTOR}× or more, with no compaction seen.",
                tokens_label(GROWING_MIN_CONTEXT),
            ),
        ),
    ];
    definitions
        .into_iter()
        .map(|(id, group, label, definition)| {
            let flagged = items.iter().filter(|item| item.rule == id);
            AnalyticsWasteRule {
                id: id.to_string(),
                group: group.to_string(),
                label: label.to_string(),
                definition,
                flagged: flagged.clone().count() as u64,
                estimated_usd: flagged.fold(0.0, |sum, item| sum + item.estimated_usd),
            }
        })
        .collect()
}

/// Signals the waste view would use if the records held them.
const LIMITS: &[&str] = &[
    "Heavy tasks with nothing to show are not flagged: commit records miss most commits and nothing records how much a task actually delivered, so the rule would mostly raise false alarms.",
    "Cancelled runs often leave no usage record, so what they spent before stopping is not counted.",
    "Failed turns and turns you interrupted cannot be told apart.",
    "Compaction is only recorded from this build on; before that it cannot be told from other large writes.",
    "Codex, Grok and OpenCode report cache writes as 0. New input is charged at the input rate there, and a rebuild cannot be told from new input, so they get no cache flags.",
    "Dollar figures are estimates at list prices, not bills. Subscription plans are not charged per token.",
];

fn priced_list() -> Vec<AnalyticsPrice> {
    PRICES
        .iter()
        .map(|(provider, model, price, source)| AnalyticsPrice {
            provider: (*provider).to_string(),
            model: (*model).to_string(),
            input: price.input,
            cache_read: price.read,
            cache_write: price.write,
            output: price.output,
            source: (*source).to_string(),
        })
        .collect()
}

/// Keeps each group's best rows, so a costly group cannot push another out of
/// a report whose counts still say it has flags.
fn cap_per_group(ranked: &mut Vec<AnalyticsWasteItem>) {
    let mut kept: HashMap<String, usize> = HashMap::new();
    ranked.retain(|item| {
        let seen = kept.entry(item.group.clone()).or_default();
        *seen += 1;
        *seen <= WASTE_ROWS_PER_GROUP
    });
}

pub(super) fn build_report(input: &CacheInput<'_>) -> AnalyticsCacheReport {
    let since = seconds(input.since);
    let threads = build_turns(input.usage, input.records);
    let rebuilds = find_rebuilds(&threads, input);
    let period: Vec<&UsageRecord> = input
        .usage
        .iter()
        .filter(|record| record.t >= input.since)
        .collect();
    let mut report = AnalyticsCacheReport {
        days: input.days,
        period_cost_usd: threads
            .iter()
            .flatten()
            .filter(|turn| turn.end >= since)
            .map(|turn| turn.usd.total())
            .sum(),
        hit_rates: hit_rates(&period, input.labels),
        cost_mix: cost_mix(&period),
        home_threads: home_threads(&threads, &rebuilds, since, input.labels),
        overhead: overhead(&threads, input.records, since, input.labels),
        limits: LIMITS.iter().map(|limit| (*limit).to_string()).collect(),
        prices: priced_list(),
        ..AnalyticsCacheReport::default()
    };
    add_rebuild_tables(&mut report, &rebuilds, input.labels);
    let mut waste = cache_waste(&rebuilds, input);
    waste.extend(result_waste(&threads, input));
    waste.extend(bloat_waste(&threads, input));
    for flagged in &mut waste {
        if let Some(bot) = flagged.bot.take() {
            flagged.bot = Some(input.labels.bot_names.get(&bot).cloned().unwrap_or(bot));
        }
    }
    waste.sort_by(|a, b| {
        (b.severity == "high")
            .cmp(&(a.severity == "high"))
            .then(b.estimated_usd.total_cmp(&a.estimated_usd))
    });
    report.rules = rules(&waste);
    cap_per_group(&mut waste);
    report.waste = waste;
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    const HOUR: f64 = 3600.0;

    fn turn(context: u64, write: u64, start: f64, end: f64) -> Turn {
        Turn {
            thread: "t".into(),
            workspace: "ws".into(),
            provider: "claude".into(),
            model: "claude-opus-5-5".into(),
            models: vec!["claude-opus-5-5".into()],
            effort: Some("medium".into()),
            start,
            end,
            write,
            read: context.saturating_sub(write),
            output: 1000,
            calls: 4,
            context,
            ok: true,
            priced: true,
            usd: dollars(
                price(4.0, 0.2, Some(8.0), 20.0),
                0,
                context.saturating_sub(write),
                write,
                1000,
            ),
            ..Turn::default()
        }
    }

    #[test]
    fn prices_use_the_published_rates() {
        let opus = price_for("claude", "claude-opus-5-5", 50_000).unwrap();
        // Opus 5.5 reads are 0.05x input, not the usual 0.1x; 1-hour writes 2x.
        assert_eq!((opus.input, opus.read, opus.write), (4.0, 0.2, Some(8.0)));
        let sonnet = price_for("claude", "claude-sonnet-5-5", 50_000).unwrap();
        assert_eq!((sonnet.read, sonnet.write), (0.1, Some(4.0)));
        assert_eq!(
            price_for("claude", "claude-sonnet-5", 50_000).unwrap().read,
            0.2
        );
        assert_eq!(
            price_for("codex", "gpt-6.1-sol", 50_000).unwrap().write,
            None
        );
        assert_eq!(
            price_for("grok", "grok-4.7-build-fast", 50_000)
                .unwrap()
                .output,
            12.0
        );
    }

    #[test]
    fn haiku_changes_price_past_a_hundred_thousand_tokens() {
        assert_eq!(
            price_for("claude", "claude-haiku-5-5", 99_000)
                .unwrap()
                .input,
            0.1
        );
        assert_eq!(
            price_for("claude", "claude-haiku-5-5", 101_000)
                .unwrap()
                .input,
            0.5
        );
    }

    #[test]
    fn unknown_models_get_no_price_rather_than_a_guess() {
        assert_eq!(price_for("opencode", "zai-coding-plan/glm-5.3", 1000), None);
        assert_eq!(price_for("claude", "claude-unknown", 1000), None);
    }

    #[test]
    fn dollars_split_tokens_by_rate() {
        let usd = dollars(
            price(4.0, 0.2, Some(8.0), 20.0),
            1_000_000,
            1_000_000,
            1_000_000,
            1_000_000,
        );
        assert_eq!(
            (usd.fresh, usd.read, usd.write, usd.output),
            (4.0, 0.2, 8.0, 20.0)
        );
        assert_eq!(usd.total(), 32.2);
        // A provider with no write price has nothing at the write rate to add.
        let free = dollars(price(2.0, 0.1, None, 10.0), 0, 1_000_000, 0, 0);
        assert_eq!(free.total(), 0.1);
    }

    #[test]
    fn small_writes_and_normal_growth_are_not_rebuilds() {
        let previous = turn(200_000, 5000, 0.0, 10.0);
        assert_eq!(
            classify(&turn(205_000, 5000, 20.0, 30.0), Some(&previous), false),
            None
        );
        // A large write that is all growth, however big, keeps the cache.
        assert_eq!(
            classify(&turn(330_000, 130_000, 20.0, 30.0), Some(&previous), false),
            None
        );
    }

    #[test]
    fn first_turn_needs_a_real_write() {
        assert_eq!(
            classify(&turn(30_000, 30_000, 0.0, 1.0), None, false),
            Some(Cause::FirstTurn)
        );
        assert_eq!(classify(&turn(9000, 9000, 0.0, 1.0), None, false), None);
    }

    #[test]
    fn the_ttl_edge_decides_an_idle_gap() {
        let previous = turn(200_000, 5000, 0.0, 0.0);
        let late = turn(200_000, 200_000, HOUR + 1.0, HOUR + 2.0);
        assert_eq!(
            classify(&late, Some(&previous), false),
            Some(Cause::IdleGap)
        );
        let warm = turn(200_000, 200_000, HOUR - 300.0, HOUR);
        assert_ne!(
            classify(&warm, Some(&previous), false),
            Some(Cause::IdleGap)
        );
    }

    #[test]
    fn an_idle_gap_outranks_a_compaction_in_the_same_turn() {
        let previous = turn(200_000, 5000, 0.0, 0.0);
        let late = turn(100_000, 100_000, 2.0 * HOUR, 2.0 * HOUR + 1.0);
        assert_eq!(classify(&late, Some(&previous), true), Some(Cause::IdleGap));
    }

    #[test]
    fn a_recorded_compaction_names_the_cause() {
        let previous = turn(200_000, 5000, 0.0, 0.0);
        let compact = turn(80_000, 110_000, 60.0, 90.0);
        assert_eq!(
            classify(&compact, Some(&previous), true),
            Some(Cause::Compaction)
        );
    }

    #[test]
    fn a_switch_needs_a_whole_context_write() {
        let previous = turn(200_000, 5000, 0.0, 0.0);
        let mut switched = turn(200_000, 190_000, 60.0, 90.0);
        switched.model = "claude-sonnet-5-5".into();
        switched.models = vec!["claude-sonnet-5-5".into()];
        assert_eq!(
            classify(&switched, Some(&previous), false),
            Some(Cause::ModelSwitch)
        );
        // Three times the context cannot be one rewrite: sub-agents wrote it.
        switched.write = 600_000;
        assert_eq!(
            classify(&switched, Some(&previous), false),
            Some(Cause::Unclear)
        );
    }

    #[test]
    fn an_effort_switch_is_named() {
        let previous = turn(200_000, 5000, 0.0, 0.0);
        let mut next = turn(200_000, 190_000, 60.0, 90.0);
        next.effort = Some("high".into());
        assert_eq!(
            classify(&next, Some(&previous), false),
            Some(Cause::EffortSwitch)
        );
        // Older records without an effort say nothing about a change.
        next.effort = None;
        assert_eq!(
            classify(&next, Some(&previous), false),
            Some(Cause::PossiblePrefixChange)
        );
    }

    #[test]
    fn only_a_comparable_first_call_miss_proves_a_prefix_change() {
        let mut previous = turn(200_000, 5000, 0.0, 0.0);
        previous.first_model = Some("claude-opus-5-5".into());
        let mut warm = turn(200_000, 200_000, 60.0, 90.0);
        assert_eq!(
            classify(&warm, Some(&previous), false),
            Some(Cause::PossiblePrefixChange)
        );
        warm.first_call = Some((0, 200_000));
        // A miss alone: nothing on record says the main model stayed the same.
        assert_eq!(
            classify(&warm, Some(&previous), false),
            Some(Cause::PossiblePrefixChange)
        );
        warm.first_model = Some("claude-opus-5-5".into());
        assert_eq!(
            classify(&warm, Some(&previous), false),
            Some(Cause::PrefixChange)
        );
        // Either effort missing means sameness is unknown, not proven.
        let mut no_effort = warm.clone();
        no_effort.effort = None;
        assert_eq!(
            classify(&no_effort, Some(&previous), false),
            Some(Cause::PossiblePrefixChange)
        );
        // The first call hit, so sub-agents or a mid-turn event did the writing.
        warm.first_call = Some((199_000, 500));
        assert_eq!(
            classify(&warm, Some(&previous), false),
            Some(Cause::Unclear)
        );
    }

    #[test]
    fn a_sub_agent_cannot_hide_or_invent_a_main_model_switch() {
        let mut previous = turn(200_000, 5000, 0.0, 0.0);
        previous.first_model = Some("claude-opus-5-5".into());
        let mut next = turn(200_000, 200_000, 60.0, 90.0);
        next.first_call = Some((0, 200_000));
        // Aggregate models still list opus, through a sub-agent; main moved on.
        next.models = vec!["claude-opus-5-5".into(), "claude-sonnet-5-5".into()];
        next.first_model = Some("claude-sonnet-5-5".into());
        assert_eq!(
            classify(&next, Some(&previous), false),
            Some(Cause::ModelSwitch)
        );
        // Aggregate model moved to a busy sub-agent; main stayed.
        next.models = vec!["claude-sonnet-5-5".into()];
        next.first_model = Some("claude-opus-5-5".into());
        assert_eq!(
            classify(&next, Some(&previous), false),
            Some(Cause::PrefixChange)
        );
    }

    #[test]
    fn a_first_call_hit_clears_a_model_switch_too() {
        let previous = turn(200_000, 5000, 0.0, 0.0);
        let mut next = turn(200_000, 190_000, 60.0, 90.0);
        next.models = vec!["claude-sonnet-5-5".into()];
        next.first_call = Some((199_000, 500));
        assert_eq!(
            classify(&next, Some(&previous), false),
            Some(Cause::Unclear)
        );
    }

    #[test]
    fn a_first_call_hit_outranks_idle_compaction_and_first_turn() {
        let previous = turn(200_000, 5000, 0.0, 0.0);
        // Warm main chain, 500k of sub-agent writes, a 61-minute gap.
        let mut idle = turn(200_000, 500_000, 61.0 * 60.0, 62.0 * 60.0);
        idle.first_call = Some((199_000, 500));
        assert_eq!(
            classify(&idle, Some(&previous), false),
            Some(Cause::Unclear)
        );
        let mut compacted = turn(200_000, 200_000, 60.0, 90.0);
        compacted.first_call = Some((199_000, 500));
        assert_eq!(
            classify(&compacted, Some(&previous), true),
            Some(Cause::Unclear)
        );
        assert_eq!(classify(&compacted, None, false), Some(Cause::Unclear));
        // A miss keeps the cause it had.
        idle.first_call = Some((0, 200_000));
        assert_eq!(
            classify(&idle, Some(&previous), false),
            Some(Cause::IdleGap)
        );
        compacted.first_call = Some((0, 200_000));
        assert_eq!(
            classify(&compacted, Some(&previous), true),
            Some(Cause::Compaction)
        );
    }

    #[test]
    fn providers_without_write_figures_never_claim_a_cause() {
        let mut previous = turn(200_000, 0, 0.0, 0.0);
        previous.provider = "codex".into();
        let mut next = previous.clone();
        next.fresh = 180_000;
        next.start = 2.0 * HOUR;
        next.end = next.start + 1.0;
        assert_eq!(
            classify(&next, Some(&previous), false),
            Some(Cause::InputAfterGap)
        );
        next.start = previous.end + 60.0;
        assert_eq!(classify(&next, Some(&previous), false), None);
    }

    fn record(
        id: &str,
        thread: &str,
        at: i64,
        model: &str,
        tokens: (u64, u64, u64, u64),
    ) -> UsageRecord {
        UsageRecord {
            t: Utc.timestamp_opt(at, 0).unwrap(),
            id: id.into(),
            src: "live".into(),
            th: thread.into(),
            par: None,
            root: thread.into(),
            bot: None,
            org: "user".into(),
            ws: "ws".into(),
            prov: "claude".into(),
            model: model.into(),
            uncached_input: tokens.0,
            cr: tokens.1,
            cw: tokens.2,
            out: tokens.3,
            think: 0,
            calls: None,
            cost: None,
            cost_src: "none".into(),
            tier: None,
            effort: None,
            cost_ticks: None,
            fcr: None,
            fcw: None,
            fcm: None,
        }
    }

    fn labels() -> Labels {
        Labels {
            titles: HashMap::from([("t".to_string(), "Title".to_string())]),
            providers: HashMap::new(),
            projects: HashMap::new(),
            bots: HashMap::from([("home".to_string(), "Juno".to_string())]),
            bot_names: HashMap::from([("bot-1".to_string(), "Juno".to_string())]),
            parents: HashMap::new(),
            automations: HashMap::new(),
        }
    }

    #[test]
    fn records_of_one_turn_join_and_the_turn_event_supplies_context() {
        let usage = [
            record("a", "t", 1000, "claude-opus-5-5", (1, 900_000, 20_000, 500)),
            record("b", "t", 1001, "claude-haiku-5-5", (1, 5000, 1000, 50)),
            record("c", "t", 2000, "claude-opus-5-5", (1, 900_000, 5000, 500)),
        ];
        let events = [Record::Turn {
            t: Utc.timestamp_opt(1001, 0).unwrap(),
            th: "t".into(),
            ok: false,
            ms: 60_000,
            i: 0,
            out: 0,
            ctx: 123_000,
        }];
        let threads = build_turns(&usage, &events);
        assert_eq!(threads[0].len(), 2);
        let first = &threads[0][0];
        assert_eq!(first.model, "claude-opus-5-5");
        assert_eq!(first.models.len(), 2);
        assert_eq!(
            (first.write, first.context, first.ok),
            (21_000, 123_000, false)
        );
        assert_eq!(first.start, 940.0);
    }

    #[test]
    fn old_records_load_without_the_new_fields() {
        let line = r#"{"t":"2026-11-01T00:00:00Z","id":"x","src":"live","th":"t","root":"t","org":"user","ws":"w","prov":"claude","model":"m","in":1,"cr":2,"cw":3,"out":4,"cost_src":"none"}"#;
        let parsed: UsageRecord = serde_json::from_str(line).unwrap();
        assert_eq!(parsed.first_call(), None);
        let written = serde_json::to_string(&parsed).unwrap();
        assert!(!written.contains("fcr") && !written.contains("fcm"));
        // Rollback: fields and events from a newer build must not stop a read.
        let newer = line.replace("\"in\":1", "\"in\":1,\"fcm\":\"m\",\"unknown\":1");
        assert!(serde_json::from_str::<UsageRecord>(&newer).is_ok());
        let compact = r#"{"e":"compact","t":"2026-11-01T00:00:00Z","th":"t"}"#;
        assert!(matches!(
            serde_json::from_str::<Record>(compact).unwrap(),
            Record::Compact { .. }
        ));
    }

    fn turn_of(usage: &[UsageRecord]) -> Vec<Vec<Turn>> {
        build_turns(usage, &[])
    }

    #[test]
    fn quick_turns_stay_apart_by_their_stable_key() {
        let opus = "claude-opus-5-5";
        let mut first = record(
            "claude:t:claude-opus-5-5:1000",
            "t",
            1000,
            opus,
            (1, 9, 9, 9),
        );
        first.fcr = Some(0);
        first.fcw = Some(9);
        let second = record(
            "claude:t:claude-opus-5-5:1001",
            "t",
            1001,
            opus,
            (1, 9, 9, 9),
        );
        // A sub-agent model on the first turn's stamp, arriving after the second.
        let sub = record(
            "claude:t:claude-haiku-5-5:1000",
            "t",
            1001,
            "claude-haiku-5-5",
            (1, 1, 1, 1),
        );
        let turns = turn_of(&[first, second, sub]);
        assert_eq!(turns[0].len(), 2);
        assert_eq!(turns[0][0].models.len(), 2);
        // A follow-up cannot inherit the first turn's evidence.
        assert!(turns[0][0].first_call.is_some() && turns[0][1].first_call.is_none());
    }

    #[test]
    fn a_quick_provider_switch_never_shares_a_turn() {
        let claude = record("claude:t:m:1000", "t", 1000, "m", (1, 9, 9, 9));
        let mut codex = record("codex:t:turn-1", "t", 1000, "gpt", (1, 9, 0, 9));
        codex.prov = "codex".into();
        let mut old_a = record("a", "u", 1000, "m", (1, 9, 9, 9));
        let mut old_b = record("b", "u", 1000, "n", (1, 9, 9, 9));
        old_a.prov = "grok".into();
        old_b.prov = "codex".into();
        let turns = turn_of(&[claude, codex, old_a, old_b]);
        assert_eq!((turns[0].len(), turns[1].len()), (2, 2));
    }

    #[test]
    fn other_providers_join_models_on_their_per_turn_id() {
        let mut a = record("opencode:s:msg-1:m", "t", 1000, "m", (1, 9, 0, 9));
        let mut b = record("opencode:s:msg-1:n", "t", 1040, "n", (1, 9, 0, 9));
        let mut c = record("opencode:s:msg-2:m", "t", 1001, "m", (1, 9, 0, 9));
        for item in [&mut a, &mut b, &mut c] {
            item.prov = "opencode".into();
        }
        let turns = turn_of(&[a, b, c]);
        assert_eq!(turns[0].len(), 2);
        // The late model record neither reorders the turns nor moves the end.
        assert_eq!(turns[0][0].models.len(), 2);
        assert_eq!(turns[0][0].end, 1000.0);
        assert_eq!(turns[0][1].end, 1001.0);
    }

    #[test]
    fn records_without_a_key_only_join_another_model_moments_later() {
        let turns = turn_of(&[
            record("a", "t", 1000, "m", (1, 9, 9, 9)),
            record("b", "t", 1001, "n", (1, 9, 9, 9)),
            record("c", "t", 1002, "n", (1, 9, 9, 9)),
            record("d", "t", 1010, "x", (1, 9, 9, 9)),
        ]);
        assert_eq!(turns[0].len(), 3);
    }

    fn failed_turn(thread: &str, at: i64) -> Record {
        Record::Turn {
            t: Utc.timestamp_opt(at, 0).unwrap(),
            th: thread.into(),
            ok: false,
            ms: 5,
            i: 0,
            out: 0,
            ctx: 7,
        }
    }

    #[test]
    fn one_turn_event_cannot_fail_two_quick_turns() {
        let usage = [
            record("claude:t:m:1000", "t", 1000, "m", (1, 9, 9, 9)),
            record("claude:t:m:1001", "t", 1001, "m", (1, 9, 9, 9)),
        ];
        let turns = build_turns(&usage, &[failed_turn("t", 1000)]);
        assert_eq!(turns[0].iter().filter(|turn| !turn.ok).count(), 1);
    }

    #[test]
    fn claim_event_takes_the_closest_unclaimed_event_in_the_window() {
        let events = [(100.0, 1, 10, true), (130.0, 2, 20, false)];
        let mut used = [false, false];
        assert_eq!(claim_event(&events, &mut used, 128.0).unwrap().1, 2);
        assert_eq!(claim_event(&events, &mut used, 129.0), None);
        assert_eq!(claim_event(&events, &mut used, 105.0).unwrap().1, 1);
        assert_eq!(claim_event(&events, &mut used, 105.0), None);
    }

    #[test]
    fn any_within_includes_both_ends() {
        let times = [1.0, 5.0, 9.0];
        assert!(any_within(&times, 5.0, 5.0));
        assert!(any_within(&times, 2.0, 5.0));
        assert!(!any_within(&times, 2.0, 4.0));
        assert!(!any_within(&times, 10.0, 20.0));
    }

    #[test]
    fn report_lists_are_capped_but_rules_count_everything() {
        let since = Utc.timestamp_opt(0, 0).unwrap();
        let count = WASTE_ROWS_PER_GROUP + 20;
        let mut usage = Vec::new();
        let mut records = Vec::new();
        for index in 0..count {
            let thread = format!("t{index}");
            let id = format!("claude:{thread}:claude-opus-5-5:1000");
            let mut big = record(
                &id,
                &thread,
                1000,
                "claude-opus-5-5",
                (0, 0, 2_000_000, 100),
            );
            big.bot = Some(format!("bot-{index}"));
            usage.push(big);
            records.push(failed_turn(&thread, 1000));
        }
        let labels = labels();
        let report = build_report(&input(since, &usage, &records, &[], &[], &labels));
        let failed = report
            .rules
            .iter()
            .find(|rule| rule.id == "failed_spend")
            .unwrap();
        assert_eq!(failed.flagged, count as u64);
        assert_eq!(report.waste.len(), WASTE_ROWS_PER_GROUP);
        assert!(
            failed.estimated_usd
                > report
                    .waste
                    .iter()
                    .map(|item| item.estimated_usd)
                    .sum::<f64>()
        );
        let bots = report
            .hit_rates
            .iter()
            .filter(|row| row.dimension == "bot")
            .count();
        assert_eq!(bots, HIT_RATE_ROWS);
    }

    #[test]
    fn a_costly_group_cannot_push_another_out_of_the_list() {
        let mut ranked: Vec<_> = (0..WASTE_ROWS_PER_GROUP + 50)
            .map(|_| item("failed_spend", "result", "estimate"))
            .collect();
        ranked.push(item("big_rebuild", "cache", "estimate"));
        cap_per_group(&mut ranked);
        assert_eq!(ranked.len(), WASTE_ROWS_PER_GROUP + 1);
        assert_eq!(ranked[ranked.len() - 1].group, "cache");
    }

    fn input<'a>(
        since: DateTime<Utc>,
        usage: &'a [UsageRecord],
        records: &'a [Record],
        runs: &'a [AutomationRun],
        automations: &'a [AnalyticsAutomation],
        labels: &'a Labels,
    ) -> CacheInput<'a> {
        CacheInput {
            days: 7,
            since,
            usage,
            records,
            runs,
            automations,
            labels,
        }
    }

    fn idle_rebuilds(thread: &str, base: i64, count: i64) -> Vec<UsageRecord> {
        (0..count)
            .map(|index| {
                record(
                    &format!("{thread}{index}"),
                    thread,
                    base + index * 7200,
                    "claude-opus-5-5",
                    (1, 0, 300_000, 500),
                )
            })
            .collect()
    }

    #[test]
    fn a_repeat_idle_offender_is_flagged_with_its_reason_and_rule_count() {
        let labels = labels();
        let mut usage = vec![record(
            "seed",
            "t",
            1000,
            "claude-opus-5-5",
            (1, 300_000, 0, 10),
        )];
        usage.extend(idle_rebuilds("t", 8200, 4));
        let since = Utc.timestamp_opt(5000, 0).unwrap();
        let report = build_report(&input(since, &usage, &[], &[], &[], &labels));
        let flagged = report
            .waste
            .iter()
            .find(|item| item.rule == "repeat_idle_gap")
            .unwrap();
        assert_eq!(flagged.occurrences, 4);
        assert_eq!(flagged.thread.as_deref(), Some("t"));
        assert_eq!(flagged.estimated_usd, 9.6);
        assert!(flagged.reason.contains("2.0 h"), "{}", flagged.reason);
        assert_eq!(
            report
                .rules
                .iter()
                .find(|rule| rule.id == "repeat_idle_gap")
                .unwrap()
                .flagged,
            1
        );
        assert_eq!(report.rebuilds_by_cause[0].cause, "idle_gap");
        assert_eq!(report.rebuilds_by_thread[0].top_cause, "idle_gap");
    }

    #[test]
    fn a_period_first_turn_is_compared_with_the_lookback() {
        let labels = labels();
        let usage = [
            record("old", "t", 1000, "claude-opus-5-5", (1, 300_000, 0, 10)),
            record("new", "t", 900_000, "claude-opus-5-5", (1, 0, 300_000, 10)),
        ];
        let since = Utc.timestamp_opt(800_000, 0).unwrap();
        let report = build_report(&input(since, &usage, &[], &[], &[], &labels));
        assert_eq!(report.rebuilds_by_cause[0].cause, "idle_gap");
    }

    #[test]
    fn a_proven_prefix_change_outranks_a_costlier_flag() {
        let labels = labels();
        let mut seed = record("seed", "t", 1000, "claude-opus-5-5", (1, 100_000, 0, 10));
        seed.fcm = Some("claude-opus-5-5".into());
        seed.effort = Some("high".into());
        let mut usage = vec![seed];
        let mut broken = record("broke", "t", 1060, "claude-opus-5-5", (1, 0, 100_000, 10));
        broken.effort = Some("high".into());
        broken.fcr = Some(0);
        broken.fcm = Some("claude-opus-5-5".into());
        broken.fcw = Some(100_000);
        usage.push(broken);
        usage.push(record(
            "other",
            "u",
            1000,
            "claude-opus-5-5",
            (1, 0, 100, 10),
        ));
        usage.extend(idle_rebuilds("u", 9000, 4));
        let since = Utc.timestamp_opt(500, 0).unwrap();
        let report = build_report(&input(since, &usage, &[], &[], &[], &labels));
        assert_eq!(report.waste[0].rule, "prefix_change");
        assert_eq!(report.waste[0].severity, "high");
        assert_eq!(report.waste[0].certainty, "proven");
        assert!(
            report
                .waste
                .iter()
                .any(|item| item.rule == "repeat_idle_gap")
        );
    }

    #[test]
    fn hit_rates_and_cost_mix_stay_separate_per_provider() {
        let labels = labels();
        let mut codex = record("c", "x", 1000, "gpt-6.1-sol", (1_000_000, 9_000_000, 0, 0));
        codex.prov = "codex".into();
        let mut unknown = record("o", "y", 1000, "glm-5.3", (2000, 0, 0, 0));
        unknown.prov = "opencode".into();
        let usage = [
            record(
                "a",
                "t",
                1000,
                "claude-opus-5-5",
                (0, 1_000_000, 1_000_000, 0),
            ),
            codex,
            unknown,
        ];
        let since = Utc.timestamp_opt(500, 0).unwrap();
        let report = build_report(&input(since, &usage, &[], &[], &[], &labels));
        let mix = |name: &str| {
            report
                .cost_mix
                .iter()
                .find(|row| row.provider == name)
                .unwrap()
        };
        assert_eq!(mix("claude").write_reporting, "reported");
        assert_eq!(
            (mix("claude").write_usd, mix("claude").read_usd),
            (8.0, 0.2)
        );
        assert_eq!(mix("codex").write_reporting, "reported_zero");
        assert_eq!((mix("codex").fresh_usd, mix("codex").read_usd), (2.0, 0.9));
        assert_eq!(mix("opencode").unpriced_tokens, 2000);
        let rate = report
            .hit_rates
            .iter()
            .find(|row| row.key == "codex")
            .unwrap();
        assert_eq!(rate.hit_rate, 0.9);
    }

    #[test]
    fn home_threads_report_context_and_gap_buckets() {
        let labels = labels();
        let usage: Vec<_> = [1000, 1120, 2000, 10_000]
            .iter()
            .enumerate()
            .map(|(index, at)| {
                record(
                    &format!("h{index}"),
                    "home",
                    *at,
                    "claude-opus-5-5",
                    (0, 50_000, 0, 10),
                )
            })
            .collect();
        let since = Utc.timestamp_opt(500, 0).unwrap();
        let report = build_report(&input(since, &usage, &[], &[], &[], &labels));
        let home = &report.home_threads[0];
        assert_eq!((home.turns, home.context_per_call), (4, 50_000));
        assert_eq!(
            (home.gaps_under_5, home.gaps_5_to_60, home.gaps_over_60),
            (1, 1, 1)
        );
        assert_eq!(home.bot, "Juno");
    }

    #[test]
    fn quiet_means_nothing_happened_in_the_turn() {
        let mut quiet = turn(100_000, 1000, 100.0, 200.0);
        quiet.output = 100;
        quiet.calls = 1;
        assert!(is_quiet(&quiet, &[]));
        assert!(!is_quiet(&quiet, &[150.0]));
        quiet.calls = 3;
        assert!(!is_quiet(&quiet, &[]));
    }

    /// Real-data tuning: `FALCONDECK_CACHE_REPORT_HOME=<state dir>` prints the
    /// rule counts over the last `FALCONDECK_CACHE_REPORT_DAYS` and writes the
    /// report JSON beside `FALCONDECK_CACHE_REPORT_OUT`. Reads only.
    #[test]
    #[ignore = "reads a real state directory"]
    fn report_rule_counts_from_a_real_state_directory() {
        let home = std::env::var("FALCONDECK_CACHE_REPORT_HOME").unwrap();
        let home = std::path::Path::new(&home);
        let days: i64 = std::env::var("FALCONDECK_CACHE_REPORT_DAYS")
            .unwrap_or("4".into())
            .parse()
            .unwrap();
        let since = Utc::now() - chrono::Duration::days(days);
        let dir = home.join("analytics");
        let from = since - chrono::Duration::days(LOOKBACK_DAYS);
        let usage = read_usage_records(&dir, from);
        let records = read_records(&dir, from);
        let store: serde_json::Value =
            serde_json::from_slice(&std::fs::read(home.join("agent-control.json")).unwrap())
                .unwrap();
        let runs: Vec<AutomationRun> = store["runs"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|run| serde_json::from_value::<AutomationRun>(run.clone()).ok())
            .filter(|run| run.queued_at >= since)
            .collect();
        let automations: Vec<AnalyticsAutomation> = store["automations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|automation| AnalyticsAutomation {
                id: automation["id"].as_str().map(str::to_string),
                name: automation["name"].as_str().unwrap_or_default().to_string(),
                state: automation["state"].as_str().unwrap_or_default().to_string(),
                ..serde_json::from_value(serde_json::json!({"name":"","runs":0,"no_action":0,"failed":0,"skipped":0,"threads":0})).unwrap()
            })
            .collect();
        let prefs: serde_json::Value =
            serde_json::from_slice(&std::fs::read(home.join("falcondeck.json")).unwrap()).unwrap();
        let mut labels = labels();
        labels.bots.clear();
        labels.titles.clear();
        for bot in prefs["bots"].as_array().unwrap() {
            let name = bot["name"].as_str().unwrap().to_string();
            labels
                .bot_names
                .insert(bot["id"].as_str().unwrap().to_string(), name.clone());
            let previous = bot["previous_thread_ids"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for id in previous.iter().chain([&bot["thread_id"]]) {
                labels
                    .bots
                    .insert(id.as_str().unwrap().to_string(), name.clone());
            }
        }
        let report = build_report(&input(
            since,
            &usage,
            &records,
            &runs,
            &automations,
            &labels,
        ));
        println!("period ${:.2}", report.period_cost_usd);
        for rule in &report.rules {
            println!(
                "{:<24}{:>4}  ${:.2}",
                rule.id, rule.flagged, rule.estimated_usd
            );
        }
        for row in &report.rebuilds_by_cause {
            println!(
                "{:<24}{:>5} {:>12} ${:.2}",
                row.cause, row.count, row.tokens, row.estimated_usd
            );
        }
        if let Ok(out) = std::env::var("FALCONDECK_CACHE_REPORT_OUT") {
            std::fs::write(out, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        }
    }
}
