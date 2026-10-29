use super::*;
use falcondeck_core::{AnalyticsClearTarget, AnalyticsSettings, ConversationItem, UnifiedEvent};

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
    let title = format!("Write {path}");
    ConversationItem::ToolCall {
        id: id.into(),
        title: title.clone(),
        tool_kind: "Write".into(),
        status: "completed".into(),
        output: None,
        exit_code: None,
        display: Box::new(crate::app::conversation_helpers::tool_display_metadata(
            &title,
            "Write",
            "completed",
            None,
            None,
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
    app.emit(
        Some("workspace-1".into()),
        Some("thread-1".into()),
        UnifiedEvent::TurnStart {
            turn_id: "turn-1".into(),
        },
    );
    app.emit(
        Some("workspace-1".into()),
        Some("thread-1".into()),
        UnifiedEvent::TurnEnd {
            turn_id: "turn-1".into(),
            status: "completed".into(),
            error: None,
        },
    );

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
