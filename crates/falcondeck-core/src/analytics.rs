//! Local activity analytics: compact records of how the user and agents work.
//! Kept on the computer running the daemon; never sent over the relay.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// User-controlled recording settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsSettings {
    /// Record activity metadata (no message content).
    #[serde(default = "enabled")]
    pub enabled: bool,
    /// Also keep the full text of messages the user sends.
    #[serde(default = "enabled")]
    pub record_prompts: bool,
    /// Record per-turn token usage. Independent of `enabled`, so turning
    /// activity analytics off does not silently stop usage accounting.
    #[serde(default = "enabled")]
    pub record_usage: bool,
    /// Months of activity metadata to keep; the user's messages are kept until cleared.
    #[serde(default = "default_retention")]
    pub retention_months: u32,
}

fn enabled() -> bool {
    true
}

fn default_retention() -> u32 {
    12
}

impl Default for AnalyticsSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            record_prompts: true,
            record_usage: true,
            retention_months: default_retention(),
        }
    }
}

/// Settings plus where the files live and how much space they use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsStatus {
    /// Current settings.
    pub settings: AnalyticsSettings,
    /// Folder holding the monthly files.
    pub folder: String,
    /// Bytes used by activity metadata.
    pub events_bytes: u64,
    /// Bytes used by the user's message log.
    pub prompts_bytes: u64,
    /// Bytes used by the token usage log.
    #[serde(default)]
    pub usage_bytes: u64,
    /// Usage records dropped because the writer queue was full, since startup.
    #[serde(default)]
    pub dropped_usage_records: u64,
    #[serde(default)]
    /// Per-provider capture diagnostics since startup.
    pub usage_health: Vec<AnalyticsUsageHealth>,
}

/// Capture health since daemon startup. Multiple models may produce several rows per turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsUsageHealth {
    /// Harness/provider identifier.
    pub provider: String,
    /// Observed live turns reaching idle or error while recording usage.
    pub completed_turns: u64,
    /// Model rows successfully appended by the writer.
    pub usage_records_written: u64,
    /// Distinct thread/turn keys with at least one written model row.
    pub turns_with_usage: u64,
    /// Completed turns minus captured turns, saturated at zero.
    pub missing_usage_turns: u64,
}

/// Counts for the requested period.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsTotals {
    /// Messages the user sent to agents.
    pub user_messages: u64,
    /// Messages scheduled tasks sent.
    pub scheduled_messages: u64,
    /// Messages agents sent to other threads or bots.
    pub agent_messages: u64,
    /// Agent messages that look like acknowledgements or chit-chat.
    pub ack_like_messages: u64,
    /// Tasks agents created.
    pub delegations: u64,
    /// Agent turns that finished.
    pub turns: u64,
    /// Turns that ended with an error.
    pub failed_turns: u64,
    /// File writes by agents.
    pub file_writes: u64,
    /// Successful `git commit`s made by agents.
    #[serde(default)]
    pub commits: u64,
}

/// One day of activity.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsDay {
    /// Local calendar date, `YYYY-MM-DD`.
    pub date: String,
    /// Messages the user sent.
    pub user_messages: u64,
    /// Messages between agents.
    pub agent_messages: u64,
    /// Finished agent turns.
    pub turns: u64,
    /// Successful `git commit`s made by agents.
    #[serde(default)]
    pub commits: u64,
    /// Messages scheduled tasks sent.
    #[serde(default)]
    pub scheduled: u64,
}

/// Messages from one thread or bot to another.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsAgentPair {
    /// Sending thread.
    pub from: String,
    /// Sender's latest title.
    pub from_title: String,
    /// Receiving thread.
    pub to: String,
    /// Receiver's latest title.
    pub to_title: String,
    /// Messages sent.
    pub messages: u64,
    /// Average message length in characters.
    pub avg_chars: u64,
    /// How many looked like acknowledgements.
    pub ack_like: u64,
}

/// Local HTTP response for one task's agent communication; never in snapshots or RPC.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsThreadActivity {
    /// Matching inbound and outbound messages, newest first.
    pub messages: Vec<AnalyticsThreadMessage>,
    /// Historical dispatch times for origins predating `dispatched_at`.
    pub dispatches: Vec<AnalyticsThreadDispatch>,
    /// Whether agent message recording is enabled.
    pub analytics_enabled: bool,
}

/// A recorded delegation's original time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsThreadDispatch {
    /// Dispatched task identifier.
    pub thread_id: String,
    /// When the task was dispatched.
    pub at: DateTime<Utc>,
}

/// Local agent communication with stable navigation identifiers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsThreadMessage {
    /// When the message was sent.
    pub at: DateTime<Utc>,
    /// Sender task identifier.
    pub from: String,
    /// Receiver task identifier.
    pub to: String,
    /// Requested steer or queue delivery.
    pub delivery: String,
    /// Stored, shortened message excerpt.
    pub excerpt: String,
}

/// A recent message between agents, shortened.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsAgentMessage {
    /// When it was sent.
    pub at: DateTime<Utc>,
    /// Sender title.
    pub from_title: String,
    /// Receiver title.
    pub to_title: String,
    /// Full length in characters.
    pub chars: u64,
    /// Whether it looked like an acknowledgement.
    pub ack_like: bool,
    /// Start of the message.
    pub excerpt: String,
}

/// A file agents wrote to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsFile {
    /// Path as reported by the agent.
    pub path: String,
    /// Writes in the period.
    pub writes: u64,
    /// Distinct threads that wrote it.
    pub threads: u64,
    /// Days on which more than one thread wrote it.
    pub contested_days: u64,
}

/// Activity for one bot's home conversation and its delegated tasks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsBot {
    /// Bot name.
    pub name: String,
    /// Home-conversation turns.
    pub turns: u64,
    /// Average turn duration in milliseconds.
    pub avg_turn_ms: u64,
    /// Average context FalconDeck added to each turn, in estimated tokens.
    pub avg_context_tokens: u64,
    /// Tasks it created.
    pub delegations: u64,
    /// Messages it sent to other threads or bots.
    pub messages_sent: u64,
    /// Commits made in its conversation or by tasks it created.
    #[serde(default)]
    pub commits: u64,
}

/// Turns per provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsProvider {
    /// Provider id.
    pub provider: String,
    /// Finished turns.
    pub turns: u64,
    /// Turns that ended with an error.
    pub failed: u64,
    /// Average turn duration in milliseconds.
    pub avg_turn_ms: u64,
    /// Input tokens used by finished turns (providers reporting per-request usage).
    pub input_tokens: u64,
    /// Output tokens reported for finished turns.
    pub output_tokens: u64,
    /// Average peak context size per turn, in tokens.
    #[serde(default)]
    pub avg_peak_context_tokens: u64,
}

/// The user's messages per project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsProject {
    /// Project folder name, or the bot name for bot conversations.
    pub project: String,
    /// Messages sent.
    pub messages: u64,
    /// Average length in characters.
    pub avg_chars: u64,
    /// Commits agents made in this project.
    #[serde(default)]
    pub commits: u64,
}

/// What started each finished turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsTriggers {
    /// A message from the user.
    pub user: u64,
    /// A scheduled task.
    pub scheduled: u64,
    /// A message from another agent or bot.
    pub agent: u64,
    /// A brief from the agent that created the task.
    pub delegation: u64,
    /// Anything else, such as continuing queued work or resuming.
    pub other: u64,
}

/// How long work waited on the user.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsWaiting {
    /// Approvals and questions the user answered.
    pub requests: u64,
    /// Median time an approval or question waited, in milliseconds.
    pub median_request_wait_ms: u64,
    /// Replies the user sent after an agent finished a turn.
    pub replies: u64,
    /// Median time from an agent finishing to the user's next message there.
    pub median_reply_ms: u64,
    /// 90th percentile of the same.
    pub p90_reply_ms: u64,
}

/// Token counts attributed to finished turns. `input_tokens` is uncached
/// input; cache reads and writes are separate. Cost is provider-reported
/// API-equivalent USD where a harness reports one, never a guess.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsUsageTotals {
    /// Uncached input tokens.
    pub input_tokens: u64,
    /// Prompt tokens served from the provider cache.
    pub cache_read_tokens: u64,
    /// Prompt tokens written to the provider cache.
    pub cache_write_tokens: u64,
    /// Generated tokens, reasoning included.
    pub output_tokens: u64,
    /// Usage records (one per turn per model) in the period.
    pub turns: u64,
    /// Provider-reported API-equivalent cost in USD.
    pub cost_usd: f64,
}

/// One row of a usage aggregation: everything in `AnalyticsUsageTotals` for
/// one value of the requested grouping.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsUsageRow {
    /// Grouping value: bot id, provider, model, thread id or `YYYY-MM-DD`.
    pub key: String,
    /// Display label for the key, resolved when the report was computed.
    pub label: String,
    /// Usage totals for the group.
    pub totals: AnalyticsUsageTotals,
    /// Cost sources that contributed: `provider`, `provider_unverified`.
    /// Empty when no contributing record carried a cost.
    pub cost_sources: Vec<String>,
    /// Thread detail, filled for `group=thread` rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<AnalyticsUsageThread>,
}

/// Per-thread detail on a `group=thread` usage row. Attribution values were
/// frozen when the records were written; names are resolved when the report
/// was computed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsUsageThread {
    /// Bot name, or null for user-driven threads.
    pub bot: Option<String>,
    /// Workspace owning the thread.
    pub workspace: String,
    /// Project folder name, or the workspace id when unknown.
    pub project: String,
    /// What created the thread: `user`, `agent_spawn`, `scheduled` or
    /// `automation`.
    pub origin: String,
    /// Automation name, when the origin is an automation that still exists.
    pub automation: Option<String>,
    /// Dominant provider (the busiest combination).
    pub provider: String,
    /// Dominant model under that provider.
    pub model: String,
    /// Average prompt context per model call: uncached input plus cache reads
    /// and writes, divided by calls. Null when no contributing record
    /// reported a call count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_context_per_call: Option<u64>,
}

/// Token usage for a period, grouped one way.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsUsageReport {
    /// Period length in days, ending now.
    pub days: u32,
    /// Grouping used: `bot`, `provider`, `model`, `thread` or `day`.
    pub group: String,
    /// Totals across every group.
    pub totals: AnalyticsUsageTotals,
    /// One row per group value, busiest first.
    pub rows: Vec<AnalyticsUsageRow>,
}

/// Token usage by bot, harness and model, for the Settings table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsUsage {
    /// Bot name, or null for user-driven threads.
    pub bot: Option<String>,
    /// Provider id.
    pub provider: String,
    /// Model id as the provider reported it.
    pub model: String,
    /// Usage totals for this combination.
    pub totals: AnalyticsUsageTotals,
    /// Cost sources that contributed: `provider`, `provider_unverified`.
    pub cost_sources: Vec<String>,
}

/// A harness and model observed in a scheduled task's usage records.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsAgent {
    /// Harness id, such as `claude` or `codex`.
    pub provider: String,
    /// Model id; empty when the harness did not report one.
    pub model: String,
}

/// Runs of one scheduled task, with signs it may not be earning its keep.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsAutomation {
    /// Automation id from the definition or retained run history.
    #[serde(default)]
    pub id: Option<String>,
    /// Automation name.
    pub name: String,
    /// `enabled`, `paused`, `completed` or `failed`; empty if deleted.
    #[serde(default)]
    pub state: String,
    /// Human-readable schedule, such as "Every 30 minutes".
    #[serde(default)]
    pub schedule: String,
    /// Thread target: `existing`, `managed`, `new_each_run` or `current`.
    #[serde(default)]
    pub thread_mode: String,
    /// Agent time spent across finished runs, in milliseconds.
    #[serde(default)]
    pub agent_ms: u64,
    /// When the latest run in the period started.
    #[serde(default)]
    pub last_run_at: Option<DateTime<Utc>>,
    /// Outcome of that run, such as `succeeded_no_action`.
    #[serde(default)]
    pub last_status: Option<String>,
    /// Review prompts: `rarely_useful`, `very_frequent`, `failing`, `thread_per_run`, `cache_cold_reuse`, `bot_home_frequent`, `large_reused_context`, `reused_thread_model_pin`.
    #[serde(default)]
    pub flags: Vec<String>,
    /// Models observed in usage records on run threads during the reporting window.
    #[serde(default)]
    pub models: Vec<String>,
    /// Harness and model pairs observed in those same usage records.
    #[serde(default)]
    pub agents: Vec<AnalyticsAgent>,
    /// Bot names observed in those records, plus the configured bot if any.
    #[serde(default)]
    pub bots: Vec<String>,
    /// Harness the automation is configured to run on.
    #[serde(default)]
    pub provider: Option<String>,
    /// Current model pin, even when a shared thread ignores it.
    #[serde(default)]
    pub configured_model: Option<String>,
    /// Current thread model when no observed usage is available.
    #[serde(default)]
    pub fallback_model: Option<String>,
    /// Recorded tokens on the automation's run threads in the reporting window.
    #[serde(default)]
    pub usage: AnalyticsUsageTotals,
    /// Runs in the period.
    pub runs: u64,
    /// Runs that found nothing to do.
    pub no_action: u64,
    /// Runs that failed.
    pub failed: u64,
    /// Runs skipped because the previous one was still going or a connector was missing.
    pub skipped: u64,
    /// Distinct threads its runs used.
    pub threads: u64,
}

/// Aggregated activity for the last `days` days.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsSummary {
    /// Period length in days, ending now.
    pub days: u32,
    /// When the summary was computed.
    pub generated_at: DateTime<Utc>,
    /// Totals for the period.
    pub totals: AnalyticsTotals,
    /// One entry per day, oldest first.
    pub daily: Vec<AnalyticsDay>,
    /// Busiest sender and receiver pairs.
    pub agent_pairs: Vec<AnalyticsAgentPair>,
    /// Latest messages between agents, newest first.
    pub recent_agent_messages: Vec<AnalyticsAgentMessage>,
    /// Most-written files.
    pub files: Vec<AnalyticsFile>,
    /// Per-bot activity.
    pub bots: Vec<AnalyticsBot>,
    /// Per-provider turns.
    pub providers: Vec<AnalyticsProvider>,
    /// The user's messages per project.
    pub projects: Vec<AnalyticsProject>,
    /// What started each finished turn.
    #[serde(default)]
    pub triggers: AnalyticsTriggers,
    /// How long work waited on the user.
    #[serde(default)]
    pub waiting: AnalyticsWaiting,
    /// Scheduled tasks, busiest first.
    #[serde(default)]
    pub automations: Vec<AnalyticsAutomation>,
    /// Token usage by bot, harness and model.
    #[serde(default)]
    pub usage: Vec<AnalyticsUsage>,
}

/// One message the user sent, as recorded.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticsPrompt {
    /// When it reached the agent.
    pub at: DateTime<Utc>,
    /// Project folder name, or the bot name.
    pub project: String,
    /// Thread it was sent to.
    pub thread_id: String,
    /// Thread title at the time.
    pub title: String,
    /// Provider id.
    pub provider: String,
    /// Full text.
    pub text: String,
}

/// What to delete.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsClearTarget {
    /// The user's message log.
    Prompts,
    /// Activity metadata.
    Events,
    /// The token usage log.
    Usage,
    /// All of them.
    All,
}

/// Cache health and waste for a period, built from usage and activity records.
/// Costs are estimates at list prices; every new field stays optional on read.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsCacheReport {
    /// Period length in days.
    pub days: u32,
    /// Estimated cost of all priced usage in the period.
    #[serde(default)]
    pub period_cost_usd: f64,
    /// Ranked offenders, most serious first.
    #[serde(default)]
    pub waste: Vec<AnalyticsWasteItem>,
    /// Every waste rule with its thresholds, so a flag can be explained.
    #[serde(default)]
    pub rules: Vec<AnalyticsWasteRule>,
    /// Signals the records cannot give, named rather than guessed.
    #[serde(default)]
    pub limits: Vec<String>,
    /// Hit rate by provider, model and bot.
    #[serde(default)]
    pub hit_rates: Vec<AnalyticsCacheHitRate>,
    /// Rebuilds grouped by cause.
    #[serde(default)]
    pub rebuilds_by_cause: Vec<AnalyticsRebuildCause>,
    /// Rebuilds grouped by bot.
    #[serde(default)]
    pub rebuilds_by_bot: Vec<AnalyticsRebuildGroup>,
    /// Rebuilds grouped by thread.
    #[serde(default)]
    pub rebuilds_by_thread: Vec<AnalyticsRebuildGroup>,
    /// Input cost split per provider.
    #[serde(default)]
    pub cost_mix: Vec<AnalyticsCostMix>,
    /// Bot home threads.
    #[serde(default)]
    pub home_threads: Vec<AnalyticsHomeThreadCache>,
    /// Injected context per bot.
    #[serde(default)]
    pub overhead: Vec<AnalyticsBotOverhead>,
    /// Prices behind the estimates.
    #[serde(default)]
    pub prices: Vec<AnalyticsPrice>,
}

/// One flagged offender for the selected period.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsWasteItem {
    /// Id of the rule that flagged it.
    pub rule: String,
    /// `cache`, `result` or `bloat`.
    pub group: String,
    /// `high` for something FalconDeck broke, otherwise `normal`.
    #[serde(default)]
    pub severity: String,
    /// `proven` from first-call records, otherwise `estimate` or `possible`.
    #[serde(default)]
    pub certainty: String,
    /// Display name.
    pub label: String,
    /// One-line reason, in plain words.
    pub reason: String,
    /// Estimated cost attributed to the flag, in USD.
    pub estimated_usd: f64,
    /// Occurrences behind the flag.
    #[serde(default)]
    pub occurrences: u64,
    /// Thread id, when one applies.
    #[serde(default)]
    pub thread: Option<String>,
    /// Workspace of the thread.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Automation id, when one caused it.
    #[serde(default)]
    pub automation: Option<String>,
    /// Bot name.
    #[serde(default)]
    pub bot: Option<String>,
    /// Existing automation review flags that fed this item.
    #[serde(default)]
    pub flags: Vec<String>,
}

/// A rule as shown in the panel, with how much it flagged.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsWasteRule {
    /// Stable rule id.
    pub id: String,
    /// `cache`, `result` or `bloat`.
    pub group: String,
    /// Display name.
    pub label: String,
    /// The rule and its thresholds, in plain words.
    pub definition: String,
    /// Items flagged in the period.
    #[serde(default)]
    pub flagged: u64,
    /// Estimated cost, in USD.
    #[serde(default)]
    pub estimated_usd: f64,
}

/// Read share of prompt tokens; never the whole story on its own.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsCacheHitRate {
    /// `provider`, `model` or `bot`.
    pub dimension: String,
    /// Group value.
    pub key: String,
    /// Harness id.
    #[serde(default)]
    pub provider: Option<String>,
    /// Uncached input tokens.
    pub fresh_tokens: u64,
    /// Tokens read from cache.
    pub read_tokens: u64,
    /// Tokens written to cache.
    pub write_tokens: u64,
    /// Reads over fresh plus reads plus writes, from 0 to 1.
    pub hit_rate: f64,
}

/// Rebuilds of one cause: `idle_gap`, `first_turn`, `model_switch`,
/// `effort_switch`, `compaction`, `prefix_change`, `possible_prefix_change`,
/// `unclear` or `input_after_gap`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsRebuildCause {
    /// Cause id.
    pub cause: String,
    /// Rebuilds counted.
    pub count: u64,
    /// Tokens written.
    pub tokens: u64,
    /// Estimated cost, in USD.
    pub estimated_usd: f64,
}

/// Rebuilds rolled up by bot or thread.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsRebuildGroup {
    /// Group value.
    pub key: String,
    /// Display name.
    pub label: String,
    /// Workspace of the thread.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Bot name.
    #[serde(default)]
    pub bot: Option<String>,
    /// Rebuilds counted.
    pub count: u64,
    /// Tokens written.
    pub tokens: u64,
    /// Estimated cost, in USD.
    pub estimated_usd: f64,
    /// Cause with the most tokens in this group.
    #[serde(default)]
    pub top_cause: String,
}

/// Estimated input cost split by where the tokens went.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsCostMix {
    /// Harness id.
    pub provider: String,
    /// Estimated cost of fresh input.
    pub fresh_usd: f64,
    /// Estimated cost of cache writes.
    pub write_usd: f64,
    /// Estimated cost of cache reads.
    pub read_usd: f64,
    /// Prompt tokens on models with no known price, left out of the dollars.
    #[serde(default)]
    pub unpriced_tokens: u64,
    /// `reported` when the provider gives cache writes, else `reported_zero`.
    #[serde(default)]
    pub write_reporting: String,
    /// The provider's own cost figure, for comparison, where it gives one.
    #[serde(default)]
    pub recorded_usd: f64,
}

/// Context and idle pattern of one bot home thread.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsHomeThreadCache {
    /// Thread id, when one applies.
    pub thread: String,
    /// Bot name.
    pub bot: String,
    /// Workspace of the thread.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Turns in the period.
    pub turns: u64,
    /// Mean prompt size per model call.
    pub context_per_call: u64,
    /// Largest context in the period.
    pub peak_context: u64,
    /// Median minutes idle between turns.
    #[serde(default)]
    pub median_gap_minutes: Option<f64>,
    /// Gaps under five minutes.
    pub gaps_under_5: u64,
    /// Gaps from five to sixty minutes.
    pub gaps_5_to_60: u64,
    /// Gaps of sixty minutes or more.
    pub gaps_over_60: u64,
    /// Tokens written by rebuilds.
    pub rebuild_tokens: u64,
    /// Estimated cost of those rebuilds.
    pub rebuild_usd: f64,
}

/// What FalconDeck adds to each bot turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsBotOverhead {
    /// Bot name.
    pub bot: String,
    /// Turns in the period.
    pub turns: u64,
    /// Mean injected context per turn, in estimated tokens.
    pub avg_tokens: u64,
    /// Mean peak context of the same bot's turns.
    pub avg_context: u64,
    /// Injected share of that context, from 0 to 1.
    pub share: f64,
}

/// List price per million tokens, as used for the estimates.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnalyticsPrice {
    /// Harness id.
    pub provider: String,
    /// Model id or prefix.
    pub model: String,
    /// Fresh input price.
    pub input: f64,
    /// Cache read price.
    pub cache_read: f64,
    /// Absent where the provider reports no cache writes.
    #[serde(default)]
    pub cache_write: Option<f64>,
    /// Output price.
    pub output: f64,
    /// Where the price came from.
    pub source: String,
}
