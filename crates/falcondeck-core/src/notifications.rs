//! The notification centre: a durable, daemon-owned history of everything that
//! asked for James's attention, plus the notices agents send him. It is a
//! record of attention events, not a conversation store: threads and reviews
//! stay where they are, and a record only points at them.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// What kind of attention event a record is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    /// An approval or question is waiting in a thread.
    InputRequired,
    /// A review is waiting for a decision.
    Review,
    /// A turn finished and nobody else will tell James.
    TurnComplete,
    /// A turn failed.
    Error,
    /// An agent sent a notice: something happened, no decision needed.
    AgentNotice,
}

impl NotificationKind {
    /// Whether this kind asks James to do something.
    pub fn needs_you(self) -> bool {
        matches!(self, Self::InputRequired | Self::Review)
    }
}

/// How hard a notice pushes.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationImportance {
    /// Delivered under the normal rules, including desktop suppression.
    #[default]
    Normal,
    /// Also pushed while James is at the Mac.
    High,
}

/// The list filters every client offers.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationFilter {
    /// Everything.
    #[default]
    All,
    /// Requests and reviews still waiting on James.
    NeedsYou,
    /// Records attributed to a bot, and agent notices.
    Bots,
}

/// Where tapping a record goes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NotificationTarget {
    /// Open a thread.
    Thread {
        /// Workspace that owns the thread.
        workspace_id: String,
        /// Thread to open.
        thread_id: String,
    },
    /// Open a review.
    Review {
        /// Review id, such as `R-12`.
        review_id: String,
    },
}

/// Where a record's long body is hosted for reading while the Mac is asleep.
/// The ciphertext is end-to-end encrypted; see docs/NOTIFICATION-CENTRE.md.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationReportRef {
    /// Opaque relay id. Reveals nothing about the record.
    pub report_id: String,
    /// When the relay copy expires. The daemon keeps its own copy.
    pub expires_at: DateTime<Utc>,
    /// Whether the relay currently holds a copy.
    #[serde(default)]
    pub hosted: bool,
}

/// One entry in the notification centre.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationRecord {
    /// Stable id, such as `N-41`.
    pub id: String,
    /// Monotonic position: bumped when a record is refreshed, never reused.
    pub seq: u64,
    /// What happened.
    pub kind: NotificationKind,
    /// Short heading: a thread or notice title.
    pub title: String,
    /// One or two plain-text lines.
    pub preview: String,
    /// Bot this came from, when it came from one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot: Option<String>,
    /// Source thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Source workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// When this happened, or last happened for a coalesced record.
    pub created_at: DateTime<Utc>,
    /// When James read it, on any device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<DateTime<Utc>>,
    /// When the request or review stopped waiting on James.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<DateTime<Utc>>,
    /// Where tapping goes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<NotificationTarget>,
    /// How hard a notice pushed. Normal for everything else.
    #[serde(default)]
    pub importance: NotificationImportance,
    /// Whether a long Markdown body can be read with `notification.get`.
    #[serde(default)]
    pub has_body: bool,
    /// The Markdown body. Only present on a single-record read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// The relay copy of the body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<NotificationReportRef>,
    /// Further completions folded into this record while it was unread.
    #[serde(default)]
    pub repeat_count: u32,
}

impl NotificationRecord {
    /// Whether James has read this anywhere.
    pub fn is_read(&self) -> bool {
        self.read_at.is_some()
    }

    /// Whether this still waits on James.
    pub fn is_waiting(&self) -> bool {
        self.kind.needs_you() && self.resolved_at.is_none()
    }

    /// Whether a filter shows this record.
    pub fn matches(&self, filter: NotificationFilter) -> bool {
        match filter {
            NotificationFilter::All => true,
            NotificationFilter::NeedsYou => self.is_waiting(),
            NotificationFilter::Bots => {
                self.bot.is_some() || self.kind == NotificationKind::AgentNotice
            }
        }
    }
}

/// What opens a page of the list.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationListRequest {
    /// Filter to apply.
    #[serde(default)]
    pub filter: NotificationFilter,
    /// Page size, clamped by the daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    /// Only records older than this `seq`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_seq: Option<u64>,
}

/// Counts every client shows on its bell.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationCounts {
    /// Unread records, all kinds.
    pub unread_count: usize,
    /// Requests and reviews still waiting on James.
    pub needs_you_count: usize,
    /// Newest `seq`. Pass as `up_to_seq` so mark-all cannot swallow a record
    /// that arrived after James last looked.
    pub latest_seq: u64,
}

/// One page, newest first.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationListResponse {
    /// Records, newest first, without bodies.
    pub items: Vec<NotificationRecord>,
    /// Pass as `before_seq` for the next page. Absent on the last page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_before_seq: Option<u64>,
    /// Counts across the whole store, whatever the filter.
    #[serde(flatten)]
    pub counts: NotificationCounts,
}

/// Mark records read: named ones, everything up to a `seq`, or both.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarkNotificationsReadRequest {
    /// Records to mark.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ids: Vec<String>,
    /// Mark everything at or below this position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub up_to_seq: Option<u64>,
}
