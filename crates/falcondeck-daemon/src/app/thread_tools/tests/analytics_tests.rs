use super::*;
use falcondeck_core::{
    AnalyticsClearTarget, AnalyticsSettings, ConversationItem, ThreadStatus, UnifiedEvent,
};

/// Moves thread-1 to `status`, with `approvals` pending, as the daemon reports it.
async fn set_status(app: &AppState, status: ThreadStatus, approvals: u32) {
    // Keep the stored status in step, as later item pushes re-broadcast it.
    let stored = status.clone();
    app.with_thread_mut("workspace-1", "thread-1", move |thread| {
        thread.status = stored;
    })
    .await
    .unwrap();
    let mut thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    thread.status = status;
    thread.attention.pending_approval_count = approvals;
    app.emit(
        Some("workspace-1".into()),
        Some("thread-1".into()),
        UnifiedEvent::ThreadUpdated { thread },
    );
}

fn shell(id: &str, command: &str, status: &str) -> ConversationItem {
    ConversationItem::ToolCall {
        id: id.into(),
        title: command.into(),
        tool_kind: "Bash".into(),
        status: status.into(),
        output: None,
        exit_code: None,
        display: Box::new(crate::app::conversation_helpers::tool_display_metadata(
            command, "Bash", status, None, None,
        )),
        detail: None,
        created_at: Utc::now(),
        completed_at: None,
    }
}

fn user(id: &str, text: &str) -> ConversationItem {
    ConversationItem::UserMessage {
        id: id.into(),
        text: text.into(),
        attachments: Vec::new(),
        turn_id: None,
        previous_turn_id: None,
        created_at: Utc::now(),
    }
}

fn write_tool(id: &str, path: &str) -> ConversationItem {
    edit_tool(id, path, "completed")
}

fn edit_tool(id: &str, path: &str, status: &str) -> ConversationItem {
    let title = format!("Edit {path}");
    ConversationItem::ToolCall {
        id: id.into(),
        title: title.clone(),
        tool_kind: "Edit".into(),
        status: status.into(),
        output: None,
        exit_code: None,
        display: Box::new(crate::app::conversation_helpers::tool_display_metadata(
            &title, "Edit", status, None, None,
        )),
        detail: None,
        created_at: Utc::now(),
        completed_at: None,
    }
}

/// The event-stream listener runs on its own thread; wait for it to catch up.
async fn summary_with_turn(app: &AppState) -> falcondeck_core::AnalyticsSummary {
    for _ in 0..100 {
        let summary = app.analytics_summary(7).await.unwrap();
        if summary.totals.turns > 0 {
            return summary;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("turn never recorded");
}

#[tokio::test]
async fn records_live_activity_and_keeps_replays_and_agent_text_out_of_the_user_log() {
    let (app, _temp) = fixture().await;
    let push = |item| app.push_conversation_item("workspace-1", "thread-1", item, true);
    push(user("u1", "Plan the release notes")).await.unwrap();
    push(user(
        "u2",
        "Message from FalconDeck thread q1 (Grade quizzes):\n\nPlease check the sync contract.",
    ))
    .await
    .unwrap();
    push(user(
        "u3",
        &falcondeck_core::control::automation_user_text("Review the inbox"),
    ))
    .await
    .unwrap();
    push(write_tool("w1", "/tmp/project-a/src/lib.rs"))
        .await
        .unwrap();
    // History recovery is not new activity.
    app.replay_conversation_item("workspace-1", "thread-1", user("old", "Old prompt"), true)
        .await
        .unwrap();
    app.analytics_agent_message("thread-1", "q1", "Thanks, got it.", "steer");
    app.analytics_agent_message(
        "thread-1",
        "q1",
        "Blocked: the relay deploy needs approval before I continue.",
        "queue",
    );
    app.analytics_delegation("thread-1", "q2", Some("Grade the remaining quizzes"));
    set_status(&app, ThreadStatus::Running, 0).await;
    set_status(&app, ThreadStatus::Idle, 0).await;

    let summary = summary_with_turn(&app).await;
    let totals = &summary.totals;
    assert_eq!(totals.user_messages, 1, "{totals:?}");
    assert_eq!(totals.scheduled_messages, 1);
    assert_eq!(totals.agent_messages, 2);
    assert_eq!(totals.ack_like_messages, 1);
    assert_eq!(totals.delegations, 1);
    assert_eq!(totals.file_writes, 1);
    assert_eq!(totals.turns, 1);
    assert_eq!(summary.daily.len(), 7);
    assert_eq!(summary.daily.last().unwrap().user_messages, 1);
    assert_eq!(summary.files[0].path, "/tmp/project-a/src/lib.rs");
    let pair = &summary.agent_pairs[0];
    assert_eq!((pair.from_title.as_str(), pair.messages), ("Auth setup", 2));
    assert_eq!(summary.projects[0].project, "project-a");
    assert_eq!(summary.providers[0].provider, "claude");

    // Only the user's own words are kept in full.
    let prompts = app.analytics_prompts(None, 50).await.unwrap();
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].text, "Plan the release notes");
    assert_eq!(
        (prompts[0].project.as_str(), prompts[0].title.as_str()),
        ("project-a", "Auth setup")
    );
    assert!(
        app.analytics_prompts(Some("release".into()), 50)
            .await
            .unwrap()
            .len()
            == 1
    );
    assert!(
        app.analytics_prompts(Some("nothing".into()), 50)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn settings_stop_recording_and_clearing_removes_files() {
    let (app, _temp) = fixture().await;
    let push = |item| app.push_conversation_item("workspace-1", "thread-1", item, true);
    push(user("u1", "First")).await.unwrap();
    let status = app
        .update_analytics_settings(AnalyticsSettings {
            enabled: true,
            record_prompts: false,
            retention_months: 6,
        })
        .await
        .unwrap();
    assert!(status.prompts_bytes > 0 && status.events_bytes > 0);
    push(user("u2", "Second, counted but not kept"))
        .await
        .unwrap();
    assert_eq!(
        app.analytics_summary(1).await.unwrap().totals.user_messages,
        2
    );
    assert_eq!(app.analytics_prompts(None, 10).await.unwrap().len(), 1);

    app.update_analytics_settings(AnalyticsSettings {
        enabled: false,
        record_prompts: false,
        retention_months: 6,
    })
    .await
    .unwrap();
    push(user("u3", "Not recorded")).await.unwrap();
    assert_eq!(
        app.analytics_summary(1).await.unwrap().totals.user_messages,
        2
    );
    assert!(
        app.update_analytics_settings(AnalyticsSettings {
            retention_months: 0,
            ..AnalyticsSettings::default()
        })
        .await
        .is_err()
    );

    let cleared = app
        .clear_analytics(AnalyticsClearTarget::Prompts)
        .await
        .unwrap();
    assert_eq!(cleared.prompts_bytes, 0);
    assert!(cleared.events_bytes > 0);
    assert!(!cleared.settings.enabled);
    let cleared = app
        .clear_analytics(AnalyticsClearTarget::All)
        .await
        .unwrap();
    assert_eq!(cleared.events_bytes, 0);
}

#[tokio::test]
async fn file_writes_count_once_when_an_edit_completes() {
    let (app, _temp) = fixture().await;
    let push = |item| app.push_conversation_item("workspace-1", "thread-1", item, true);
    push(edit_tool("e1", "/repo/a.rs", "running"))
        .await
        .unwrap();
    push(edit_tool("e1", "/repo/a.rs", "completed"))
        .await
        .unwrap();
    push(edit_tool("e1", "/repo/a.rs", "completed"))
        .await
        .unwrap();
    push(edit_tool("e2", "/repo/b.rs", "running"))
        .await
        .unwrap();
    push(edit_tool("e2", "/repo/b.rs", "failed")).await.unwrap();
    let summary = app.analytics_summary(1).await.unwrap();
    assert_eq!(summary.totals.file_writes, 1);
    assert_eq!(summary.files[0].path, "/repo/a.rs");
}

#[tokio::test]
async fn a_turn_counts_only_its_own_tokens_without_an_earlier_baseline() {
    let (app, _temp) = fixture().await;
    let breakdown = |tokens: u64| falcondeck_core::TokenUsageBreakdown {
        total_tokens: tokens,
        input_tokens: tokens,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
    };
    let usage = |total: u64, last: u64| falcondeck_core::ThreadTokenUsage {
        total: breakdown(total),
        last: Some(breakdown(last)),
        model_context_window: None,
        updated_at: None,
    };
    let emit = |event| app.emit(Some("workspace-1".into()), Some("thread-1".into()), event);
    // A thread with 100k tokens of history: the first turn seen adds 10k.
    set_status(&app, ThreadStatus::Running, 0).await;
    emit(UnifiedEvent::ThreadTokenUsageUpdated {
        usage: usage(105_000, 5_000),
    });
    emit(UnifiedEvent::ThreadTokenUsageUpdated {
        usage: usage(110_000, 5_000),
    });
    set_status(&app, ThreadStatus::Idle, 0).await;
    let summary = summary_with_turn(&app).await;
    assert_eq!(summary.providers[0].input_tokens, 10_000);
    assert_eq!(summary.providers[0].avg_peak_context_tokens, 5_000);

    // Claude-style reports carry only context fill: no usage, just the peak.
    set_status(&app, ThreadStatus::Running, 0).await;
    for fill in [40_000, 62_000, 51_000] {
        emit(UnifiedEvent::ThreadTokenUsageUpdated {
            usage: falcondeck_core::ThreadTokenUsage {
                total: breakdown(fill),
                last: None,
                model_context_window: None,
                updated_at: None,
            },
        });
    }
    set_status(&app, ThreadStatus::Idle, 0).await;
    for _ in 0..100 {
        let providers = app.analytics_summary(1).await.unwrap().providers;
        if providers[0].turns == 2 {
            assert_eq!(providers[0].input_tokens, 10_000);
            assert_eq!(providers[0].avg_peak_context_tokens, (5_000 + 62_000) / 2);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    // A turn with no usage report does not dilute the average.
    set_status(&app, ThreadStatus::Running, 0).await;
    set_status(&app, ThreadStatus::Idle, 0).await;
    for _ in 0..100 {
        let providers = app.analytics_summary(1).await.unwrap().providers;
        if providers[0].turns == 3 {
            assert_eq!(providers[0].avg_peak_context_tokens, (5_000 + 62_000) / 2);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("turns never recorded");
}

#[tokio::test]
async fn commits_triggers_and_waiting_on_the_user_are_measured() {
    let (app, _temp) = fixture().await;
    let push = |item| app.push_conversation_item("workspace-1", "thread-1", item, true);
    // The user starts a turn, which commits once (plumbing and failures don't count).
    push(user("u1", "Ship the fix")).await.unwrap();
    set_status(&app, ThreadStatus::Running, 0).await;
    push(shell("c1", "cd /repo && git commit -q -m Fix", "running"))
        .await
        .unwrap();
    push(shell("c1", "cd /repo && git commit -q -m Fix", "completed"))
        .await
        .unwrap();
    push(shell("c2", "git commit-tree abc -p def -m x", "completed"))
        .await
        .unwrap();
    push(shell("c3", "git commit -m nope", "failed"))
        .await
        .unwrap();
    // An approval waits on the user mid-turn.
    set_status(&app, ThreadStatus::Running, 1).await;
    set_status(&app, ThreadStatus::Running, 0).await;
    set_status(&app, ThreadStatus::Idle, 0).await;
    // Another agent's message starts the next turn; then one continues on its own.
    app.analytics_agent_message("q1", "thread-1", "Please also update the docs.", "queue");
    set_status(&app, ThreadStatus::Running, 0).await;
    set_status(&app, ThreadStatus::Idle, 0).await;
    set_status(&app, ThreadStatus::Running, 0).await;
    set_status(&app, ThreadStatus::Idle, 0).await;
    // The user replies after the agent finished.
    push(user("u2", "Looks good")).await.unwrap();

    let mut summary = app.analytics_summary(1).await.unwrap();
    for _ in 0..100 {
        if summary.totals.turns == 3 && summary.waiting.requests == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        summary = app.analytics_summary(1).await.unwrap();
    }
    assert_eq!(summary.totals.turns, 3, "{:?}", summary.totals);
    assert_eq!(summary.totals.commits, 1);
    assert_eq!(summary.daily.last().unwrap().commits, 1);
    assert_eq!(summary.projects[0].commits, 1);
    let triggers = &summary.triggers;
    assert_eq!(
        (triggers.user, triggers.agent, triggers.other),
        (1, 1, 1),
        "{triggers:?}"
    );
    assert_eq!(summary.waiting.requests, 1);
    assert_eq!(summary.waiting.replies, 1);
}
