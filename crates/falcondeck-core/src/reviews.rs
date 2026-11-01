//! The review inbox: decisions an agent needs from James, with the evidence
//! to make them. Kept apart from tickets and conversation history so the whole
//! feature can be removed without touching either.
use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::control::ControlRequestContext;

/// Where a review stands. Only `Open` accepts a response.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum ReviewStatus {
    #[default]
    Open,
    Approved,
    ChangesRequested,
    Rejected,
    Withdrawn,
}
impl ReviewStatus {
    /// Whether the review still waits on James.
    pub fn is_open(self) -> bool {
        self == Self::Open
    }
}

/// James's decision on one item, or on the whole review.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum ReviewDecision {
    Approve,
    RequestChanges,
    Reject,
}

/// What a piece of evidence is, inferred by the daemon from its path or URL.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum ReviewEvidenceKind {
    /// A document or other file on the Mac.
    File,
    /// A screenshot, mock-up or other image file on the Mac.
    Image,
    /// A web link.
    Url,
}

/// One thing to look at. Open `open_path` with `file.stat`/`file.read_range`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[allow(missing_docs)]
pub struct ReviewEvidence {
    pub id: String,
    pub kind: ReviewEvidenceKind,
    pub title: Option<String>,
    pub caption: Option<String>,
    /// Absolute path to read: the frozen copy when `snapshotted`, else the
    /// original. Absent for URLs.
    pub open_path: Option<String>,
    /// The path the agent named, for display.
    pub original_path: Option<String>,
    /// Whether a copy was frozen in the review folder at publish time.
    pub snapshotted: bool,
    pub url: Option<String>,
    pub content_type: Option<String>,
    pub size_bytes: Option<u64>,
}

/// One decision within a review.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[allow(missing_docs)]
pub struct ReviewItem {
    pub id: String,
    pub title: String,
    pub note: String,
    pub evidence: Vec<ReviewEvidence>,
    pub decision: Option<ReviewDecision>,
    pub feedback: Option<String>,
}

/// Daemon-attributed author, never accepted from arguments.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[allow(missing_docs)]
pub struct ReviewActor {
    /// Bot name, thread id, provider name or `James`.
    pub name: String,
    pub context: ControlRequestContext,
}

/// Whether James's reply reached the agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum ReviewDelivery {
    /// The message was accepted by the source thread.
    Delivered { at: DateTime<Utc> },
    /// The source thread could not take it. The response is still recorded.
    Failed { at: DateTime<Utc>, error: String },
}

/// A request for James's decision.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[allow(missing_docs)]
pub struct Review {
    /// Sequential id such as `R-12`.
    pub id: String,
    pub title: String,
    /// The one-line question.
    pub ask: String,
    /// What the agent would do, and why.
    pub recommendation: String,
    /// The agent proceeds then unless James says no.
    pub going_ahead_at: Option<DateTime<Utc>>,
    /// Markdown context shown above the items.
    pub body: String,
    pub status: ReviewStatus,
    pub items: Vec<ReviewItem>,
    /// Thread that asked, and where the reply goes.
    pub source_thread_id: Option<String>,
    pub source_workspace_id: Option<String>,
    /// Bot that asked, when the source thread is a bot's home.
    pub bot: Option<String>,
    pub created_by: ReviewActor,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Folder holding the frozen evidence copies.
    pub folder: Option<String>,
    pub responded_at: Option<DateTime<Utc>>,
    /// Whole-review decision when James gave one instead of per item.
    pub overall_decision: Option<ReviewDecision>,
    pub overall_note: Option<String>,
    pub delivery: Option<ReviewDelivery>,
}

/// A file or link to attach. Give exactly one of `path` and `url`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct ReviewEvidenceInput {
    /// Absolute path (or `~/…`) on this Mac. Prefer self-contained files:
    /// PNG/JPEG screenshots, PDF, Markdown, or single-file HTML.
    pub path: Option<String>,
    /// An http(s) link.
    pub url: Option<String>,
    pub title: Option<String>,
    /// One short line saying what to look at.
    pub caption: Option<String>,
}

/// One thing for James to decide on.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct ReviewItemInput {
    pub title: String,
    /// A short note: what changed, what to look for.
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub evidence: Vec<ReviewEvidenceInput>,
}

/// Publish one decision for James. Recommendation required.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct CreateReviewArgs {
    pub title: String,
    /// The one-line question James is answering.
    pub ask: String,
    /// What you recommend and why. Required.
    pub recommendation: String,
    /// RFC 3339 time you will proceed unless James says no.
    pub going_ahead_at: Option<DateTime<Utc>>,
    /// Markdown context shown above the items.
    #[serde(default)]
    pub body: String,
    /// One or more things to decide on, each with its own evidence.
    pub items: Vec<ReviewItemInput>,
}

/// Change your own open review. Omitted fields stay as they are.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct UpdateReviewArgs {
    pub review_id: String,
    pub title: Option<String>,
    pub ask: Option<String>,
    pub recommendation: Option<String>,
    /// An empty string clears the deadline.
    pub going_ahead_at: Option<String>,
    pub body: Option<String>,
    /// Items to append; existing items and their evidence are untouched.
    #[serde(default)]
    pub add_items: Vec<ReviewItemInput>,
}

/// Withdraw your own open review (the decision is no longer needed).
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct WithdrawReviewArgs {
    pub review_id: String,
    /// Optional one line saying why.
    pub reason: Option<String>,
}

/// James's decision on one item.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct ReviewItemResponse {
    pub item_id: String,
    pub decision: ReviewDecision,
    pub feedback: Option<String>,
}

/// James's response. Only James may call this. Give a decision for every item,
/// or one overall `decision` (optionally with a `note`) for items without one.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct RespondReviewArgs {
    pub review_id: String,
    #[serde(default)]
    pub items: Vec<ReviewItemResponse>,
    pub decision: Option<ReviewDecision>,
    pub note: Option<String>,
}

/// Result of a response: the closed review and whether the agent was reached.
pub type RespondReviewResult = Review;
