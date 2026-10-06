use chrono::{TimeZone, Utc};
use falcondeck_core::{ContentLifecycle, ConversationItem};

use super::*;

fn event(seq: u64, event: UnifiedEvent) -> Arc<CachedEnvelope> {
    Arc::new(CachedEnvelope::new(EventEnvelope {
        seq,
        emitted_at: Utc.timestamp_opt(seq as i64, 0).unwrap(),
        workspace_id: Some("workspace".to_string()),
        thread_id: Some("thread".to_string()),
        event,
    }))
}

fn text(seq: u64, delta: &str, start: u64, end: u64) -> Arc<CachedEnvelope> {
    event(
        seq,
        UnifiedEvent::Text {
            item_id: "item".to_string(),
            delta: delta.to_string(),
            target: TextDeltaTarget::AssistantText,
            start_offset: Some(start),
            end_offset: Some(end),
        },
    )
}

fn delta(event: &CachedEnvelope) -> &str {
    let UnifiedEvent::Text { delta, .. } = &event.event else {
        panic!("expected text delta")
    };
    delta
}

#[test]
fn pending_broadcast_entries_remain_small() {
    assert!(std::mem::size_of::<PendingEvent>() <= 2 * std::mem::size_of::<usize>());
}

#[test]
fn contiguous_burst_grows_text_buffer_amortized() {
    let mut coalescer = EventCoalescer::default();
    let chunk = "x".repeat(64);
    let chunks = 10_000;
    let mut prior_capacity = 0;
    let mut capacity_growths = 0;
    let mut copied_prefix_bytes = 0;
    for index in 0..chunks {
        let start = index * chunk.len();
        assert!(
            coalescer
                .push(text(
                    index as u64,
                    &chunk,
                    start as u64,
                    (start + chunk.len()) as u64
                ))
                .is_empty()
        );
        let UnifiedEvent::Text { delta, .. } = &coalescer.pending[0].1.envelope().event else {
            panic!("expected text delta")
        };
        if delta.capacity() != prior_capacity {
            capacity_growths += 1;
            // Every growth can copy the already accumulated prefix once.
            copied_prefix_bytes += start;
            prior_capacity = delta.capacity();
        }
    }
    let outgoing = coalescer.drain();
    assert_eq!(outgoing.len(), 1);
    assert_eq!(delta(&outgoing[0]), chunk.repeat(chunks));
    assert!(
        capacity_growths < 32,
        "reallocated {capacity_growths} times"
    );
    assert!(
        copied_prefix_bytes < 2 * chunks * chunk.len(),
        "growth copied {copied_prefix_bytes} prefix bytes"
    );
    assert_eq!(outgoing[0].seq, (chunks - 1) as u64);
    assert!(coalescer.is_empty());
}

#[test]
fn merge_does_not_mutate_broadcast_envelopes_or_their_json_caches() {
    let first = text(1, "a", 0, 1);
    let second = text(2, "b", 1, 2);
    let third = text(3, "c", 2, 3);
    let originals = [&first, &second, &third];
    let cached = originals.map(|event| event.serialized().to_string());
    let mut coalescer = EventCoalescer::default();
    for original in originals {
        assert!(coalescer.push(original.clone()).is_empty());
    }

    let outgoing = coalescer.drain();
    assert_eq!(outgoing.len(), 1);
    assert_eq!(delta(&outgoing[0]), "abc");
    assert_eq!(outgoing[0].seq, 3);
    assert_eq!(outgoing[0].emitted_at, third.emitted_at);
    let serialized: EventEnvelope = serde_json::from_str(outgoing[0].serialized()).unwrap();
    assert_eq!(serialized, outgoing[0].envelope);
    for (original, expected) in originals.into_iter().zip(cached) {
        assert_eq!(original.serialized(), expected);
    }
    assert_eq!(delta(&first), "a");
    assert_eq!(delta(&second), "b");
    assert_eq!(delta(&third), "c");
}

#[test]
fn different_consumers_keep_separate_accumulators() {
    let first = text(1, "a", 0, 1);
    let second = text(2, "b", 1, 2);
    let mut fast = EventCoalescer::default();
    let mut slow = EventCoalescer::default();
    for shared in [&first, &second] {
        assert!(fast.push(shared.clone()).is_empty());
        assert!(slow.push(shared.clone()).is_empty());
    }
    assert!(fast.push(text(3, "c", 2, 3)).is_empty());
    let slow_output = slow.drain();
    let slow_json = slow_output[0].serialized().to_string();
    assert!(fast.push(text(4, "d", 3, 4)).is_empty());
    assert_eq!(delta(&fast.drain()[0]), "abcd");
    assert_eq!(delta(&slow_output[0]), "ab");
    assert_eq!(slow_output[0].serialized(), slow_json);
}

#[test]
fn untouched_update_reuses_shared_cached_envelope() {
    let original = text(1, "unchanged", 0, 9);
    let cached_pointer = original.serialized().as_ptr();
    let mut coalescer = EventCoalescer::default();
    assert!(coalescer.push(original.clone()).is_empty());
    let outgoing = coalescer.drain();
    assert!(Arc::ptr_eq(&outgoing[0], &original));
    assert_eq!(outgoing[0].serialized().as_ptr(), cached_pointer);
}

#[test]
fn unicode_preserves_utf16_offsets_and_latest_envelope_metadata() {
    let mut coalescer = EventCoalescer::default();
    for (seq, chunk, start, end) in [(1, "a💡", 0, 3), (2, "é", 3, 4), (3, "日🚀", 4, 7)] {
        assert!(coalescer.push(text(seq, chunk, start, end)).is_empty());
    }
    let outgoing = coalescer.drain();
    assert_eq!(outgoing.len(), 1);
    assert_eq!(outgoing[0].seq, 3);
    assert_eq!(outgoing[0].emitted_at, Utc.timestamp_opt(3, 0).unwrap());
    assert!(matches!(&outgoing[0].event,
        UnifiedEvent::Text {delta, start_offset: Some(0), end_offset: Some(7), ..}
        if delta == "a💡é日🚀"));
}

#[test]
fn noncontiguous_deltas_keep_their_order_and_merge_only_the_latest_segment() {
    let mut coalescer = EventCoalescer::default();
    for (seq, chunk, start, end) in [(1, "a", 0, 1), (2, "c", 2, 3), (3, "d", 3, 4)] {
        assert!(coalescer.push(text(seq, chunk, start, end)).is_empty());
    }
    let outgoing = coalescer.drain();
    assert_eq!(outgoing.len(), 2);
    assert_eq!(delta(&outgoing[0]), "a");
    assert_eq!(delta(&outgoing[1]), "cd");
    assert_eq!(outgoing[0].seq, 1);
    assert_eq!(outgoing[1].seq, 3);
    assert!(matches!(
        outgoing[1].event,
        UnifiedEvent::Text {
            start_offset: Some(2),
            end_offset: Some(4),
            ..
        }
    ));
}

#[test]
fn missing_offsets_and_overlapping_replays_are_not_merged() {
    for missing in 0..4 {
        let mut first = text(1, "a", 0, 1);
        let mut next = text(2, "b", 1, 2);
        let selected = if missing < 2 { &mut first } else { &mut next };
        let UnifiedEvent::Text {
            start_offset,
            end_offset,
            ..
        } = &mut Arc::get_mut(selected).unwrap().envelope.event
        else {
            panic!("expected text delta")
        };
        if missing % 2 == 0 {
            *start_offset = None;
        } else {
            *end_offset = None;
        }
        let mut coalescer = EventCoalescer::default();
        assert!(coalescer.push(first).is_empty());
        assert!(coalescer.push(next).is_empty());
        assert_eq!(coalescer.drain().len(), 2, "missing offset {missing}");
    }
    let mut coalescer = EventCoalescer::default();
    assert!(coalescer.push(text(1, "abc", 0, 3)).is_empty());
    assert!(coalescer.push(text(2, "bc", 1, 3)).is_empty());
    let outgoing = coalescer.drain();
    assert_eq!(outgoing.len(), 2);
    assert_eq!(delta(&outgoing[0]), "abc");
    assert_eq!(delta(&outgoing[1]), "bc");
}

#[test]
fn deltas_from_different_workspaces_threads_items_and_targets_are_separate() {
    for boundary in 0..4 {
        let mut next = text(2, "b", 1, 2);
        let envelope = &mut Arc::get_mut(&mut next).unwrap().envelope;
        match boundary {
            0 => envelope.workspace_id = Some("other-workspace".to_string()),
            1 => envelope.thread_id = Some("other-thread".to_string()),
            2 => {
                let UnifiedEvent::Text { item_id, .. } = &mut envelope.event else {
                    panic!("expected text delta")
                };
                *item_id = "other-item".to_string();
            }
            _ => {
                let UnifiedEvent::Text { target, .. } = &mut envelope.event else {
                    panic!("expected text delta")
                };
                *target = TextDeltaTarget::ReasoningContent;
            }
        }
        let mut coalescer = EventCoalescer::default();
        assert!(coalescer.push(text(1, "a", 0, 1)).is_empty());
        assert!(coalescer.push(next.clone()).is_empty());
        let outgoing = coalescer.drain();
        assert_eq!(outgoing.len(), 2, "boundary {boundary}");
        assert_eq!(delta(&outgoing[0]), "a");
        assert!(Arc::ptr_eq(&outgoing[1], &next));
    }
}

#[test]
fn terminal_turn_flushes_merged_text_before_the_terminal_event() {
    let mut coalescer = EventCoalescer::default();
    assert!(coalescer.push(text(1, "a", 0, 1)).is_empty());
    assert!(coalescer.push(text(2, "b", 1, 2)).is_empty());
    let terminal = event(
        3,
        UnifiedEvent::TurnEnd {
            turn_id: "turn".to_string(),
            status: "completed".to_string(),
            error: None,
        },
    );
    let outgoing = coalescer.push(terminal.clone());
    assert_eq!(outgoing.len(), 2);
    assert_eq!(delta(&outgoing[0]), "ab");
    assert_eq!(outgoing[0].seq, 2);
    assert!(Arc::ptr_eq(&outgoing[1], &terminal));
    assert!(coalescer.is_empty());
}

#[test]
fn terminal_item_replacement_supersedes_held_snapshots() {
    let mut coalescer = EventCoalescer::default();
    let item = |text: &str, lifecycle| ConversationItem::AssistantMessage {
        id: "item".to_string(),
        text: text.to_string(),
        phase: None,
        memory_citation: None,
        citations: Vec::new(),
        lifecycle,
        error: None,
        created_at: Utc.timestamp_opt(1, 0).unwrap(),
    };
    for (seq, value) in [(1, "a"), (2, "ab")] {
        assert!(
            coalescer
                .push(event(
                    seq,
                    UnifiedEvent::ConversationItemUpdated {
                        item: item(value, ContentLifecycle::Streaming),
                    }
                ))
                .is_empty()
        );
    }
    let final_event = event(
        3,
        UnifiedEvent::ConversationItemUpdated {
            item: item("abc", ContentLifecycle::Complete),
        },
    );
    let outgoing = coalescer.push(final_event.clone());
    assert_eq!(outgoing.len(), 1);
    assert!(Arc::ptr_eq(&outgoing[0], &final_event));
    assert!(coalescer.is_empty());
}
