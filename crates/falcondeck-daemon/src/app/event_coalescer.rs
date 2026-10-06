use std::sync::Arc;

use falcondeck_core::{EventEnvelope, TextDeltaTarget, ThreadStatus, UnifiedEvent};

use super::{CachedEnvelope, conversation_item_id, is_streaming_item};

/// What a pending event supersedes, when it supersedes anything.
#[derive(PartialEq, Eq)]
enum CoalesceKey {
    ThreadSummary(Option<String>),
    ConversationItem(Option<String>, String),
    TextDelta(Option<String>, Option<String>, String, TextDeltaTarget),
}

impl CoalesceKey {
    fn matches_text_delta(
        &self,
        event: &EventEnvelope,
        item_id: &str,
        target: TextDeltaTarget,
    ) -> bool {
        matches!(self, Self::TextDelta(workspace, thread, item, pending_target)
            if workspace == &event.workspace_id
                && thread == &event.thread_id
                && item == item_id
                && *pending_target == target)
    }
}

enum PendingEvent {
    // An untouched update keeps the broadcast's already-cached JSON.
    Shared(Arc<CachedEnvelope>),
    // A merged stream owns its growing text. It has no serialized cache until
    // drained, and never mutates an envelope held by another consumer.
    Merged(Box<EventEnvelope>),
}

impl PendingEvent {
    fn envelope(&self) -> &EventEnvelope {
        match self {
            Self::Shared(event) => &event.envelope,
            Self::Merged(event) => event,
        }
    }

    fn merge_contiguous_text_delta(&mut self, next: &CachedEnvelope) -> bool {
        let UnifiedEvent::Text {
            delta: next_delta,
            start_offset: Some(next_start),
            end_offset: Some(next_end),
            ..
        } = &next.envelope.event
        else {
            return false;
        };
        let UnifiedEvent::Text {
            start_offset: Some(_),
            end_offset: Some(previous_end),
            ..
        } = &self.envelope().event
        else {
            return false;
        };
        if previous_end != next_start {
            return false;
        }

        if let Self::Shared(previous) = self {
            // Clone the first chunk once; continuations append into this
            // private String with amortized growth instead of copying every
            // previous prefix into a new envelope on every token.
            *self = Self::Merged(Box::new(previous.envelope.clone()));
        }
        let Self::Merged(envelope) = self else {
            unreachable!("a contiguous delta has an owned envelope")
        };
        let UnifiedEvent::Text {
            delta, end_offset, ..
        } = &mut envelope.event
        else {
            unreachable!("a contiguous delta has a text envelope")
        };
        delta.push_str(next_delta);
        *end_offset = Some(*next_end);
        envelope.seq = next.seq;
        envelope.emitted_at = next.emitted_at;
        true
    }

    fn into_cached(self) -> Arc<CachedEnvelope> {
        match self {
            Self::Shared(event) => event,
            Self::Merged(event) => Arc::new(CachedEnvelope::new(*event)),
        }
    }
}

/// Collapses replaceable updates from a running turn before a client transport
/// writes them. Terminal updates and unrelated events are never delayed.
#[derive(Default)]
pub(crate) struct EventCoalescer {
    pending: Vec<(CoalesceKey, PendingEvent)>,
}

impl EventCoalescer {
    fn supersedes(event: &EventEnvelope) -> Option<CoalesceKey> {
        match &event.event {
            UnifiedEvent::ThreadUpdated { .. } => {
                Some(CoalesceKey::ThreadSummary(event.thread_id.clone()))
            }
            UnifiedEvent::ConversationItemUpdated { item } => Some(CoalesceKey::ConversationItem(
                event.thread_id.clone(),
                conversation_item_id(item).to_string(),
            )),
            _ => None,
        }
    }

    fn may_be_held(event: &EventEnvelope) -> bool {
        match &event.event {
            UnifiedEvent::ThreadUpdated { thread } => {
                matches!(thread.status, ThreadStatus::Running)
            }
            UnifiedEvent::ConversationItemUpdated { item } => is_streaming_item(item),
            _ => false,
        }
    }

    /// Accept an event and return every event that must be written now.
    pub(crate) fn push(&mut self, event: Arc<CachedEnvelope>) -> Vec<Arc<CachedEnvelope>> {
        if let UnifiedEvent::Text {
            item_id, target, ..
        } = &event.event
        {
            if let Some(index) = self.pending.iter().rposition(|(pending_key, _)| {
                pending_key.matches_text_delta(&event, item_id, *target)
            }) {
                if self.pending[index].1.merge_contiguous_text_delta(&event) {
                    return Vec::new();
                }
            }
            self.pending.push((
                CoalesceKey::TextDelta(
                    event.workspace_id.clone(),
                    event.thread_id.clone(),
                    item_id.clone(),
                    *target,
                ),
                PendingEvent::Shared(event),
            ));
            return Vec::new();
        }

        let key = Self::supersedes(&event);
        if let Some(key) = &key {
            // A newer complete replacement makes every held predecessor
            // redundant, including when this update is terminal.
            self.pending.retain(|(pending_key, _)| pending_key != key);
        }

        if Self::may_be_held(&event) {
            self.pending.push((
                key.expect("holdable events have a coalesce key"),
                PendingEvent::Shared(event),
            ));
            return Vec::new();
        }

        let mut outgoing = self.drain();
        outgoing.push(event);
        outgoing
    }

    pub(crate) fn drain(&mut self) -> Vec<Arc<CachedEnvelope>> {
        self.pending
            .drain(..)
            .map(|(_, event)| event.into_cached())
            .collect()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[cfg(test)]
#[path = "event_coalescer_tests.rs"]
mod tests;
