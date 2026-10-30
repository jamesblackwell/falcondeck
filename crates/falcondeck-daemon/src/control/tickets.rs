//! Daemon-owned company tickets, separate from native conversation history.
use std::path::PathBuf;

use chrono::Utc;
use falcondeck_core::control::{ControlGetRequest, ControlGetResponse, ControlOrigin};
use falcondeck_core::tickets::*;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::ControlError;

/// Tickets one agent (a bot, or a provider's task threads) may create in 24 hours.
const AGENT_TICKETS_PER_DAY: usize = 5;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Records {
    version: u32,
    next_id: u64,
    tickets: Vec<Ticket>,
}
impl Default for Records {
    fn default() -> Self {
        Self {
            version: 1,
            next_id: 1,
            tickets: vec![],
        }
    }
}

pub(super) struct TicketStore {
    path: PathBuf,
    transaction: Mutex<()>,
}
impl TicketStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            transaction: Mutex::new(()),
        }
    }

    // Reload under the same lock as mutations. A bad/future file is never
    // replaced by a writable empty cache, and failed saves cannot leak into reads.
    async fn load(&self) -> Result<Records, ControlError> {
        let bytes = match tokio::fs::read(&self.path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Records::default());
            }
            Err(error) => return Err(storage_error(error)),
        };
        let records: Records = serde_json::from_slice(&bytes).map_err(storage_error)?;
        if records.version != 1 || records.next_id == 0 {
            return Err(storage_error(
                "unsupported tickets schema version; file left untouched",
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for ticket in &records.tickets {
            let number = ticket
                .id
                .strip_prefix("T-")
                .and_then(|id| id.parse::<u64>().ok());
            if number.is_none_or(|id| id == 0 || id >= records.next_id) || !ids.insert(&ticket.id) {
                return Err(storage_error(
                    "invalid ticket sequence; file left untouched",
                ));
            }
        }
        Ok(records)
    }

    async fn save(&self, records: &Records) -> Result<(), ControlError> {
        let payload = serde_json::to_vec_pretty(records).map_err(storage_error)?;
        crate::app::storage::write_atomically(&self.path, payload)
            .await
            .map_err(storage_error)
    }

    pub async fn get(
        &self,
        request: &ControlGetRequest,
    ) -> Result<ControlGetResponse, ControlError> {
        let _guard = self.transaction.lock().await;
        let records = self.load().await?;
        if request.resource == "ticket" {
            let id = request
                .id
                .as_deref()
                .ok_or_else(|| ControlError::field("id", "Supply a ticket id such as T-42."))?;
            let ticket = find(&records, id)?;
            return Ok(ControlGetResponse {
                resource: "ticket".into(),
                data: serde_json::to_value(ticket).map_err(storage_error)?,
                next_cursor: None,
            });
        }
        let filters = &request.filters;
        let text = |key: &str| filters.get(key).and_then(serde_json::Value::as_str);
        let include_closed = filters
            .get("include_closed")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let offset = request
            .cursor
            .as_deref()
            .unwrap_or("0")
            .parse::<usize>()
            .map_err(|_| ControlError::field("cursor", "Invalid ticket cursor."))?;
        let limit = request.limit.clamp(1, 100) as usize;
        let rows: Vec<_> = records
            .tickets
            .iter()
            .filter(|ticket| {
                (include_closed || text("state").is_some() || !ticket.state.is_closed())
                    && text("owner")
                        .is_none_or(|owner| ticket.owner.as_deref().unwrap_or("") == owner)
                    && text("project")
                        .is_none_or(|project| ticket.project.as_deref().unwrap_or("") == project)
                    && text("priority").is_none_or(|priority| {
                        serde_json::to_value(ticket.priority)
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_owned))
                            .as_deref()
                            == Some(priority)
                    })
                    && text("state").is_none_or(|state| {
                        serde_json::to_value(ticket.state)
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_owned))
                            .as_deref()
                            == Some(state)
                    })
            })
            .collect();
        let page: Vec<_> = rows.iter().skip(offset).take(limit).collect();
        Ok(ControlGetResponse {
            resource: "tickets".into(),
            data: serde_json::to_value(page).map_err(storage_error)?,
            next_cursor: (offset.saturating_add(limit) < rows.len())
                .then(|| (offset + limit).to_string()),
        })
    }

    pub async fn create(
        &self,
        args: CreateTicketArgs,
        actor: TicketActor,
    ) -> Result<Ticket, ControlError> {
        let _guard = self.transaction.lock().await;
        let mut records = self.load().await?;
        let now = Utc::now();
        // Agents (not James on desktop or mobile) get a daily creation cap.
        if !matches!(
            actor.context.origin,
            ControlOrigin::DesktopUi | ControlOrigin::RemoteRpc
        ) {
            let since = now - chrono::Duration::hours(24);
            let recent = records
                .tickets
                .iter()
                .filter(|ticket| ticket.created_by.name == actor.name && ticket.created_at > since)
                .count();
            if recent >= AGENT_TICKETS_PER_DAY {
                return Err(ControlError::new(
                    "ticket_limit",
                    format!(
                        "{} has created {recent} tickets in the last 24 hours, the most an agent may create in a day.",
                        actor.name
                    ),
                    false,
                )
                .with_suggested_action(
                    "Comment on or update an existing ticket instead, or ask James to add this one.",
                ));
            }
        }
        let ticket = Ticket {
            id: format!("T-{}", records.next_id),
            title: args.title.trim().into(),
            description: args.description,
            state: args.state,
            priority: args.priority,
            owner: optional(args.owner),
            project: optional(args.project),
            parent_id: optional(args.parent_id),
            linked_thread_ids: links(args.linked_thread_ids)?,
            created_by: actor.clone(),
            updated_by: actor,
            created_at: now,
            updated_at: now,
            closing_note: optional(args.closing_note),
            comments: vec![],
        };
        validate(&records, &ticket)?;
        records.next_id = records
            .next_id
            .checked_add(1)
            .ok_or_else(|| storage_error("ticket sequence exhausted"))?;
        records.tickets.push(ticket.clone());
        self.save(&records).await?;
        Ok(ticket)
    }

    pub async fn update(
        &self,
        args: UpdateTicketArgs,
        actor: TicketActor,
    ) -> Result<Ticket, ControlError> {
        let _guard = self.transaction.lock().await;
        let mut records = self.load().await?;
        let mut ticket = find(&records, &args.ticket_id)?.clone();
        if args
            .state
            .is_some_and(|state| state.is_closed() && state != ticket.state)
            && args
                .closing_note
                .as_deref()
                .is_none_or(|note| note.trim().is_empty())
        {
            return Err(ControlError::field(
                "closing_note",
                "Moving to done/dropped requires a one-line outcome in this update.",
            ));
        }
        if let Some(value) = args.title {
            ticket.title = value.trim().into();
        }
        if let Some(value) = args.description {
            ticket.description = value;
        }
        if let Some(value) = args.state {
            ticket.state = value;
            if !value.is_closed() {
                ticket.closing_note = None;
            }
        }
        if let Some(value) = args.priority {
            ticket.priority = value;
        }
        if let Some(value) = args.owner {
            ticket.owner = optional(Some(value));
        }
        if let Some(value) = args.project {
            ticket.project = optional(Some(value));
        }
        if let Some(value) = args.parent_id {
            ticket.parent_id = optional(Some(value));
        }
        if let Some(value) = args.linked_thread_ids {
            ticket.linked_thread_ids = links(value)?;
        }
        if let Some(value) = args.closing_note {
            ticket.closing_note = optional(Some(value));
        }
        ticket.updated_at = Utc::now();
        ticket.updated_by = actor;
        validate(&records, &ticket)?;
        *records
            .tickets
            .iter_mut()
            .find(|row| row.id == ticket.id)
            .unwrap() = ticket.clone();
        self.save(&records).await?;
        Ok(ticket)
    }

    pub async fn comment(
        &self,
        args: CommentTicketArgs,
        actor: TicketActor,
    ) -> Result<Ticket, ControlError> {
        text_field("body", args.body.trim(), 16_000, true)?;
        let _guard = self.transaction.lock().await;
        let mut records = self.load().await?;
        find(&records, &args.ticket_id)?;
        let ticket = records
            .tickets
            .iter_mut()
            .find(|row| row.id == args.ticket_id)
            .unwrap();
        let now = Utc::now();
        ticket.comments.push(TicketComment {
            id: Uuid::new_v4().to_string(),
            author: actor.clone(),
            body: args.body.trim().into(),
            created_at: now,
        });
        ticket.updated_at = now;
        ticket.updated_by = actor;
        let result = ticket.clone();
        self.save(&records).await?;
        Ok(result)
    }
}

fn storage_error(error: impl std::fmt::Display) -> ControlError {
    ControlError::new(
        "storage_unavailable",
        format!("Tickets storage: {error}"),
        false,
    )
}
fn optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
fn find<'a>(records: &'a Records, id: &str) -> Result<&'a Ticket, ControlError> {
    records
        .tickets
        .iter()
        .find(|row| row.id == id)
        .ok_or_else(|| ControlError::resource_not_found("ticket", id))
}
fn text_field(field: &str, value: &str, max: usize, required: bool) -> Result<(), ControlError> {
    if (required && value.trim().is_empty()) || value.chars().count() > max {
        return Err(ControlError::field(
            field,
            format!(
                "{field} must be {}-{max} characters.",
                usize::from(required)
            ),
        ));
    }
    Ok(())
}
fn links(values: Vec<String>) -> Result<Vec<String>, ControlError> {
    if values.len() > 100 {
        return Err(ControlError::field(
            "linked_thread_ids",
            "At most 100 linked threads.",
        ));
    }
    let mut result = vec![];
    for value in values {
        let value = value.trim().to_string();
        text_field("linked_thread_ids", &value, 300, true)?;
        if !result.contains(&value) {
            result.push(value);
        }
    }
    Ok(result)
}
fn validate(records: &Records, ticket: &Ticket) -> Result<(), ControlError> {
    text_field("title", &ticket.title, 200, true)?;
    text_field("description", &ticket.description, 64_000, false)?;
    if let Some(owner) = &ticket.owner {
        text_field("owner", owner, 120, true)?;
    }
    if let Some(project) = &ticket.project {
        text_field("project", project, 4096, true)?;
        if !std::path::Path::new(project).is_absolute() {
            return Err(ControlError::field(
                "project",
                "Use an absolute workspace path.",
            ));
        }
    }
    if ticket.state.is_closed() && ticket.closing_note.is_none() {
        return Err(ControlError::field(
            "closing_note",
            "Done/dropped requires a one-line outcome.",
        ));
    }
    if let Some(note) = &ticket.closing_note {
        text_field("closing_note", note, 500, true)?;
        if note.contains(['\n', '\r']) {
            return Err(ControlError::field(
                "closing_note",
                "Use one line saying the outcome.",
            ));
        }
    }
    if let Some(parent_id) = &ticket.parent_id {
        if parent_id == &ticket.id {
            return Err(ControlError::field(
                "parent_id",
                "A ticket cannot parent itself.",
            ));
        }
        let parent = find(records, parent_id)?;
        if parent.parent_id.is_some()
            || records
                .tickets
                .iter()
                .any(|row| row.parent_id.as_deref() == Some(&ticket.id))
        {
            return Err(ControlError::field(
                "parent_id",
                "Only one level of sub-tickets is supported.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
