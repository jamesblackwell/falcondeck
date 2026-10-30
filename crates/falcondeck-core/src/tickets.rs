//! Big-picture company work only: hours, days or weeks. Most changes should just
//! be done; never create a ticket for work under a few hours.
use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::control::ControlRequestContext;

/// Ticket lifecycle; completion and cancellation both require an outcome.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum TicketState {
    #[default]
    Backlog,
    Active,
    Blocked,
    WaitingOnJames,
    Done,
    Dropped,
}
impl TicketState {
    /// Whether this state closes the ticket.
    pub fn is_closed(self) -> bool {
        matches!(self, Self::Done | Self::Dropped)
    }
}

/// P0 is urgent; P3 is lowest priority.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[allow(missing_docs)]
pub enum TicketPriority {
    P0,
    P1,
    #[default]
    P2,
    P3,
}

/// Daemon-attributed author, never accepted from mutation arguments.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[allow(missing_docs)]
pub struct TicketActor {
    pub name: String,
    pub context: ControlRequestContext,
}

/// A concise note for the record, separate from native conversation history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[allow(missing_docs)]
pub struct TicketComment {
    pub id: String,
    pub author: TicketActor,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

/// A sizeable piece of company work. Children have at most one parent level.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[allow(missing_docs)]
pub struct Ticket {
    pub id: String,
    pub title: String,
    pub description: String,
    pub state: TicketState,
    pub priority: TicketPriority,
    pub owner: Option<String>,
    pub project: Option<String>,
    pub parent_id: Option<String>,
    pub linked_thread_ids: Vec<String>,
    pub created_by: TicketActor,
    pub updated_by: TicketActor,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub closing_note: Option<String>,
    pub comments: Vec<TicketComment>,
}

/// Create big-picture work only; most changes should just be done.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct CreateTicketArgs {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub state: TicketState,
    #[serde(default)]
    pub priority: TicketPriority,
    pub owner: Option<String>,
    pub project: Option<String>,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub linked_thread_ids: Vec<String>,
    pub closing_note: Option<String>,
}

/// Omitted fields stay unchanged. Empty owner/project/parent_id clears it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct UpdateTicketArgs {
    pub ticket_id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub state: Option<TicketState>,
    pub priority: Option<TicketPriority>,
    pub owner: Option<String>,
    pub project: Option<String>,
    pub parent_id: Option<String>,
    pub linked_thread_ids: Option<Vec<String>>,
    pub closing_note: Option<String>,
}

/// Add a concise comment to a ticket or sub-ticket.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(missing_docs)]
pub struct CommentTicketArgs {
    pub ticket_id: String,
    pub body: String,
}
