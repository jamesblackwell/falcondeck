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
    /// Input tokens reported for finished turns.
    pub input_tokens: u64,
    /// Output tokens reported for finished turns.
    pub output_tokens: u64,
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
}

/// Aggregated activity for the last `days` days.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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
    /// Both.
    All,
}
