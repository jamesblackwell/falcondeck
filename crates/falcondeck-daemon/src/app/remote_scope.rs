//! Scoped-event support for the relay bridge (see
//! `docs/mobile-sync-responsiveness-plan.md`, "Scoped events (optional)").
//!
//! Stream-class events (live text and tool traffic) are tagged with an opaque
//! `scope_hint` so the relay can withhold them from peers that are not looking
//! at that thread. Everything else stays untagged and is always delivered.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use falcondeck_core::{EventEnvelope, UnifiedEvent};
use sha2::{Digest, Sha256};

const SCOPE_TAG_DOMAIN: &[u8] = b"falcondeck-scope-v1\0";
const SCOPE_TAG_BYTES: usize = 12;
const SHA256_BLOCK: usize = 64;

/// RFC 2104 HMAC-SHA256 (hand-rolled to avoid a new dependency; `sha2` is
/// already linked). Keys longer than the block size are hashed first.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; SHA256_BLOCK];
    if key.len() > SHA256_BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

/// Opaque per-thread routing tag carried in `EncryptedEnvelope.scope_hint`.
///
/// Algorithm (the Swift client must compute the identical string):
///
/// ```text
/// mac = HMAC-SHA256(key = 32-byte session data key,
///                   message = b"falcondeck-scope-v1\0" || utf8(thread_id))
/// tag = base64url_no_padding(mac[0..12])        // 16 characters
/// ```
///
/// Known answer: key = bytes `0x00..=0x1f`, thread id `thread-1` gives
/// `aoXdKz1fn4Xc6qk6`. The relay learns only this tag, never the thread id,
/// and cannot link it to a thread without the data key.
pub(super) fn scope_tag(data_key: &[u8; 32], thread_id: &str) -> String {
    let mut message = Vec::with_capacity(SCOPE_TAG_DOMAIN.len() + thread_id.len());
    message.extend_from_slice(SCOPE_TAG_DOMAIN);
    message.extend_from_slice(thread_id.as_bytes());
    URL_SAFE_NO_PAD.encode(&hmac_sha256(data_key, &message)[..SCOPE_TAG_BYTES])
}

/// Whether an event belongs to a thread's live stream (tagged, deliverable
/// only to peers subscribed to that thread) or must always reach every peer.
///
/// Deliberately exhaustive with no wildcard: adding a `UnifiedEvent` variant
/// must force a decision here. Lifecycle, summary, attention, and global
/// events stay unscoped so a closed thread never goes stale.
pub(super) fn is_stream_class(event: &UnifiedEvent) -> bool {
    match event {
        UnifiedEvent::Text { .. }
        | UnifiedEvent::ConversationItemAdded { .. }
        | UnifiedEvent::ConversationItemUpdated { .. }
        | UnifiedEvent::ToolCallStart { .. }
        | UnifiedEvent::ToolCallEnd { .. }
        | UnifiedEvent::File { .. }
        | UnifiedEvent::ThreadTokenUsageUpdated { .. } => true,
        UnifiedEvent::Snapshot { .. }
        | UnifiedEvent::Start { .. }
        | UnifiedEvent::Stop { .. }
        | UnifiedEvent::TurnStart { .. }
        | UnifiedEvent::TurnEnd { .. }
        | UnifiedEvent::Service { .. }
        | UnifiedEvent::OperationalConditionUpserted { .. }
        | UnifiedEvent::OperationalConditionCleared { .. }
        | UnifiedEvent::RealtimeAudioStarted { .. }
        | UnifiedEvent::RealtimeAudioDelta { .. }
        | UnifiedEvent::RealtimeAudioEnded { .. }
        | UnifiedEvent::RealtimeItemAdded { .. }
        | UnifiedEvent::InteractiveRequest { .. }
        | UnifiedEvent::ThreadStarted { .. }
        | UnifiedEvent::ThreadUpdated { .. }
        | UnifiedEvent::WorkspaceUpdated { .. }
        | UnifiedEvent::PreferencesUpdated { .. }
        | UnifiedEvent::ExtensionCatalogUpdated { .. }
        | UnifiedEvent::ExtensionViewUpdated { .. }
        | UnifiedEvent::ScheduledTaskCreated { .. }
        | UnifiedEvent::ScheduledTaskUpdated { .. }
        | UnifiedEvent::ScheduledTaskDeleted { .. }
        | UnifiedEvent::ScheduledTaskRunStarted { .. }
        | UnifiedEvent::ScheduledTaskRunUpdated { .. }
        | UnifiedEvent::ControlStateChanged { .. } => false,
    }
}

/// The `scope_hint` for an event, if it is stream-class and thread-bound.
pub(super) fn scope_hint(data_key: &[u8; 32], event: &EventEnvelope) -> Option<String> {
    if !is_stream_class(&event.event) {
        return None;
    }
    event
        .thread_id
        .as_deref()
        .map(|thread_id| scope_tag(data_key, thread_id))
}

/// A copy of a thread-summary event without the bulky `latest_diff` and
/// `latest_plan`, or `None` when the event needs no change (so callers keep
/// serializing the shared original without cloning it).
pub(super) fn lean_thread_event(event: &EventEnvelope) -> Option<EventEnvelope> {
    let (UnifiedEvent::ThreadStarted { thread } | UnifiedEvent::ThreadUpdated { thread }) =
        &event.event
    else {
        return None;
    };
    if thread.latest_diff.is_none() && thread.latest_plan.is_none() {
        return None;
    }
    let mut lean = event.clone();
    if let UnifiedEvent::ThreadStarted { thread } | UnifiedEvent::ThreadUpdated { thread } =
        &mut lean.event
    {
        thread.latest_diff = None;
        thread.latest_plan = None;
    }
    Some(lean)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use falcondeck_core::{ConversationItem, ServiceLevel, TextDeltaTarget, ThreadStatus};

    fn summary(diff: Option<&str>) -> falcondeck_core::ThreadSummary {
        falcondeck_core::ThreadSummary {
            execution_target: Default::default(),
            cloud: None,
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "title".to_string(),
            provider: falcondeck_core::AgentProvider::CODEX,
            native_session_id: None,
            provider_transport: None,
            handoff_from: None,
            origin: None,
            status: ThreadStatus::Idle,
            updated_at: Utc::now(),
            last_message_preview: None,
            last_message_at: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: diff.map(str::to_string),
            last_tool: None,
            last_error: None,
            agent: Default::default(),
            attention: Default::default(),
            is_archived: false,
            is_pinned: false,
            is_pinned_in_project: false,
            goal: None,
            queued_turns: Vec::new(),
            variant: None,
        }
    }

    fn envelope(thread_id: Option<&str>, event: UnifiedEvent) -> EventEnvelope {
        EventEnvelope {
            seq: 1,
            emitted_at: Utc::now(),
            workspace_id: Some("workspace-1".to_string()),
            thread_id: thread_id.map(str::to_string),
            event,
        }
    }

    #[test]
    fn hmac_sha256_matches_rfc_4231_vectors() {
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Case 6: a key longer than the block size is hashed first.
        assert_eq!(
            hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn scope_tag_known_answer_vector() {
        let mut key = [0u8; 32];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = index as u8;
        }
        assert_eq!(scope_tag(&key, "thread-1"), "aoXdKz1fn4Xc6qk6");
        assert_ne!(scope_tag(&key, "thread-2"), scope_tag(&key, "thread-1"));
        assert_ne!(scope_tag(&[1; 32], "thread-1"), scope_tag(&key, "thread-1"));
        assert!(!scope_tag(&key, "thread-1").contains("thread"));
    }

    /// `is_stream_class` is an exhaustive match, so a new variant cannot
    /// compile unclassified; this pins the decision for every variant that
    /// can be built without large fixtures.
    #[test]
    fn classifier_pins_stream_versus_always_delivered_events() {
        let stream = [
            UnifiedEvent::Text {
                item_id: "i".into(),
                delta: "d".into(),
                target: TextDeltaTarget::AssistantText,
                start_offset: None,
                end_offset: None,
            },
            UnifiedEvent::ConversationItemAdded { item: item() },
            UnifiedEvent::ConversationItemUpdated { item: item() },
            UnifiedEvent::ToolCallStart {
                item_id: "i".into(),
                title: "t".into(),
                kind: "k".into(),
            },
            UnifiedEvent::ToolCallEnd {
                item_id: "i".into(),
                title: "t".into(),
                kind: "k".into(),
                status: "ok".into(),
                exit_code: None,
            },
            UnifiedEvent::File {
                item_id: None,
                path: None,
                summary: "s".into(),
            },
            UnifiedEvent::ThreadTokenUsageUpdated {
                usage: falcondeck_core::ThreadTokenUsage {
                    total: falcondeck_core::TokenUsageBreakdown {
                        total_tokens: 1,
                        input_tokens: 1,
                        cached_input_tokens: 0,
                        output_tokens: 0,
                        reasoning_output_tokens: 0,
                    },
                    last: None,
                    model_context_window: None,
                    updated_at: None,
                },
            },
        ];
        for event in stream {
            assert!(is_stream_class(&event), "{event:?}");
        }
        let always = [
            UnifiedEvent::Start { title: None },
            UnifiedEvent::Stop { reason: None },
            UnifiedEvent::TurnStart {
                turn_id: "t".into(),
            },
            UnifiedEvent::TurnEnd {
                turn_id: "t".into(),
                status: "completed".into(),
                error: None,
            },
            UnifiedEvent::Service {
                level: ServiceLevel::Info,
                message: "m".into(),
                raw_method: None,
                notice: None,
            },
            UnifiedEvent::OperationalConditionCleared {
                key: "k".into(),
                condition_id: "c".into(),
            },
            UnifiedEvent::RealtimeAudioStarted { session_id: None },
            UnifiedEvent::RealtimeAudioEnded {
                reason: None,
                interrupted: false,
            },
            UnifiedEvent::ThreadStarted {
                thread: summary(None),
            },
            UnifiedEvent::ThreadUpdated {
                thread: summary(None),
            },
            UnifiedEvent::ScheduledTaskDeleted {
                task_id: "t".into(),
            },
        ];
        for event in always {
            assert!(!is_stream_class(&event), "{event:?}");
        }
    }

    fn item() -> ConversationItem {
        ConversationItem::AssistantMessage {
            id: "item-1".to_string(),
            text: "hi".to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: falcondeck_core::ContentLifecycle::Complete,
            error: None,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn hint_needs_both_a_stream_event_and_a_thread() {
        let key = [3u8; 32];
        let stream = UnifiedEvent::ConversationItemAdded { item: item() };
        assert_eq!(
            scope_hint(&key, &envelope(Some("thread-1"), stream.clone())),
            Some(scope_tag(&key, "thread-1"))
        );
        assert_eq!(scope_hint(&key, &envelope(None, stream)), None);
        let thread_event = UnifiedEvent::ThreadUpdated {
            thread: summary(None),
        };
        assert_eq!(
            scope_hint(&key, &envelope(Some("thread-1"), thread_event)),
            None
        );
    }

    #[test]
    fn lean_strips_diff_and_plan_only_from_thread_summaries() {
        let with_diff = envelope(
            Some("thread-1"),
            UnifiedEvent::ThreadUpdated {
                thread: summary(Some("diff --git a b")),
            },
        );
        let lean = lean_thread_event(&with_diff).expect("diff stripped");
        let UnifiedEvent::ThreadUpdated { thread } = &lean.event else {
            panic!("variant preserved");
        };
        assert_eq!(thread.latest_diff, None);
        assert_eq!(thread.title, "title");
        assert_eq!(lean.seq, with_diff.seq);
        // Already lean, and unrelated events, need no copy at all.
        let started = envelope(
            Some("thread-1"),
            UnifiedEvent::ThreadStarted {
                thread: summary(None),
            },
        );
        assert!(lean_thread_event(&started).is_none());
        let other = envelope(
            Some("thread-1"),
            UnifiedEvent::ConversationItemAdded { item: item() },
        );
        assert!(lean_thread_event(&other).is_none());
    }
}
