use super::*;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::super::claude_history::ClaudeHistoryState;

const THREAD_ID: &str = "falcondeck-thread";
const NATIVE_ID: &str = "11111111-1111-4111-8111-111111111111";
const SOURCE: &str = "/native/projects/project/session.jsonl";
const CWD: &str = "/project";

fn version(length: u64, modified: u64) -> (u64, Option<SystemTime>) {
    (length, Some(UNIX_EPOCH + Duration::from_secs(modified)))
}

fn history(source: &str, version: (u64, Option<SystemTime>)) -> Arc<ClaudeHistoryState> {
    ClaudeHistoryState::new_discovered(
        PathBuf::from(source),
        NATIVE_ID.to_string(),
        CWD.to_string(),
        "Native title".to_string(),
        version,
    )
}

fn thread(title: &str, history: Arc<ClaudeHistoryState>) -> ManagedThread {
    let mut thread = ManagedThread::new(ThreadSummary {
        id: THREAD_ID.to_string(),
        workspace_id: "workspace-1".to_string(),
        title: title.to_string(),
        provider: AgentProvider::CLAUDE,
        native_session_id: Some(NATIVE_ID.to_string()),
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Idle,
        updated_at: "2026-10-05T10:00:00Z".parse().unwrap(),
        last_message_preview: Some(title.to_string()),
        latest_turn_id: None,
        latest_plan: None,
        latest_diff: None,
        last_tool: None,
        last_error: None,
        agent: ThreadAgentParams::default(),
        attention: ThreadAttention::default(),
        is_archived: false,
        is_pinned: false,
        is_pinned_in_project: false,
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    });
    thread.claude_history = Some(history);
    thread.requires_resume = true;
    thread
}

fn loaded_thread(title: &str, history: Arc<ClaudeHistoryState>) -> ManagedThread {
    history.loaded.store(true, Ordering::Release);
    let mut thread = thread(title, history);
    thread.replace_items(vec![ConversationItem::AssistantMessage {
        id: "old-answer".to_string(),
        text: "Previous answer".to_string(),
        phase: None,
        memory_citation: None,
        citations: Vec::new(),
        lifecycle: ContentLifecycle::Complete,
        error: None,
        created_at: "2026-10-05T10:00:00Z".parse().unwrap(),
    }]);
    thread
}

fn reconnect(previous: ManagedThread, rebuilt: ManagedThread) -> ManagedThread {
    let mut hydrated = HashMap::from([(THREAD_ID.to_string(), rebuilt)]);
    carry_over_live_threads(
        &mut hydrated,
        HashMap::from([(THREAD_ID.to_string(), previous)]),
    );
    hydrated.remove(THREAD_ID).unwrap()
}

fn retained_history(thread: &ManagedThread, expected: &Arc<ClaudeHistoryState>) {
    assert!(Arc::ptr_eq(
        thread.claude_history.as_ref().unwrap(),
        expected
    ));
}

#[test]
fn reconnect_preserves_pending_gate_identity_for_unchanged_native_source() {
    let original = history(SOURCE, version(100, 10));
    let rebuilt = history(SOURCE, version(100, 10));

    let result = reconnect(
        thread("Previous summary", original.clone()),
        thread("Fresh summary", rebuilt),
    );

    retained_history(&result, &original);
    assert!(!original.is_loaded());
    assert!(result.items.is_empty());
    assert_eq!(result.summary.title, "Fresh summary");
    assert_eq!(
        result.summary.last_message_preview.as_deref(),
        Some("Fresh summary")
    );
}

#[test]
fn reconnect_retains_a_pending_read_gate_before_a_placeholder_has_a_version() {
    let original = ClaudeHistoryState::new(
        PathBuf::from(SOURCE),
        NATIVE_ID.to_string(),
        CWD.to_string(),
        String::new(),
    );
    let guard = original.gate.try_lock().unwrap();

    let result = reconnect(
        thread("Admission summary", original.clone()),
        thread("Fresh summary", history(SOURCE, version(100, 10))),
    );

    retained_history(&result, &original);
    assert_eq!(result.summary.title, "Admission summary");
    assert!(result.items.is_empty());
    assert!(!original.is_loaded());
    assert!(
        result
            .claude_history
            .as_ref()
            .unwrap()
            .gate
            .try_lock()
            .is_err()
    );
    drop(guard);
    assert!(
        result
            .claude_history
            .as_ref()
            .unwrap()
            .gate
            .try_lock()
            .is_ok()
    );
}

#[test]
fn reconnect_preserves_a_completed_empty_history_for_the_same_native_version() {
    let original = history(SOURCE, version(100, 10));
    original.loaded.store(true, Ordering::Release);

    let result = reconnect(
        thread("Loaded empty summary", original.clone()),
        thread("Fresh summary", history(SOURCE, version(100, 10))),
    );

    retained_history(&result, &original);
    assert!(original.is_loaded());
    assert!(result.items.is_empty());
    assert_eq!(result.summary.title, "Loaded empty summary");
}

#[test]
fn reconnect_invalidates_idle_history_when_native_length_or_modified_time_changes() {
    for new_version in [version(101, 10), version(100, 11)] {
        let original = history(SOURCE, version(100, 10));
        let rebuilt = history(SOURCE, new_version);

        let result = reconnect(
            loaded_thread("Stale summary", original.clone()),
            thread("External update summary", rebuilt.clone()),
        );

        retained_history(&result, &rebuilt);
        assert!(!Arc::ptr_eq(
            result.claude_history.as_ref().unwrap(),
            &original
        ));
        assert!(!rebuilt.is_loaded());
        assert!(result.items.is_empty());
        assert!(result.assistant_items.is_empty());
        assert_eq!(result.summary.title, "External update summary");
        assert_eq!(
            result.summary.last_message_preview.as_deref(),
            Some("External update summary")
        );
    }
}

#[test]
fn reconnect_keeps_live_running_and_waiting_turns_when_native_history_changes() {
    for status in [ThreadStatus::Running, ThreadStatus::WaitingForInput] {
        let original = history(SOURCE, version(100, 10));
        let mut live = loaded_thread("Live summary", original.clone());
        live.summary.status = status.clone();
        live.summary.latest_turn_id = Some("live-turn".to_string());

        let result = reconnect(
            live,
            thread("External update summary", history(SOURCE, version(200, 20))),
        );

        retained_history(&result, &original);
        assert_eq!(result.summary.status, status);
        assert_eq!(result.summary.title, "Live summary");
        assert_eq!(result.summary.latest_turn_id.as_deref(), Some("live-turn"));
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.assistant_items.get("old-answer"), Some(&0));
    }
}

#[test]
fn reconnect_keeps_idle_live_history_while_turn_admission_holds_the_gate() {
    let original = history(SOURCE, version(100, 10));
    let previous = loaded_thread("Admission summary", original.clone());
    let guard = original.gate.try_lock().unwrap();

    let result = reconnect(
        previous,
        thread("External update summary", history(SOURCE, version(200, 20))),
    );

    retained_history(&result, &original);
    assert_eq!(result.summary.status, ThreadStatus::Idle);
    assert_eq!(result.summary.title, "Admission summary");
    assert_eq!(result.items.len(), 1);
    assert!(
        result
            .claude_history
            .as_ref()
            .unwrap()
            .gate
            .try_lock()
            .is_err()
    );
    drop(guard);
}

#[test]
fn reconnect_replaces_idle_history_when_the_native_source_path_changes() {
    let original = history(SOURCE, version(100, 10));
    let rebuilt = history("/native/other-project/session.jsonl", version(100, 10));

    let result = reconnect(
        loaded_thread("Old source summary", original.clone()),
        thread("New source summary", rebuilt.clone()),
    );

    retained_history(&result, &rebuilt);
    assert!(!original.same_source(&rebuilt));
    assert!(result.items.is_empty());
    assert!(!rebuilt.is_loaded());
    assert_eq!(result.summary.title, "New source summary");
}

#[test]
fn reconnect_does_not_transfer_a_pending_gate_to_a_different_native_source_path() {
    let original = history(SOURCE, version(100, 10));
    let rebuilt = history("/native/other-project/session.jsonl", version(100, 10));
    let _old_read = original.gate.try_lock().unwrap();

    let result = reconnect(
        thread("Old read summary", original.clone()),
        thread("New source summary", rebuilt.clone()),
    );

    retained_history(&result, &rebuilt);
    assert!(result.items.is_empty());
    assert!(!rebuilt.is_loaded());
    assert!(
        result
            .claude_history
            .as_ref()
            .unwrap()
            .gate
            .try_lock()
            .is_ok()
    );
    assert_eq!(result.summary.title, "New source summary");
}
