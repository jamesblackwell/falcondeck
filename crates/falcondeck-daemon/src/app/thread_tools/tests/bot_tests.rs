use super::*;
use falcondeck_core::{BotDocumentMutation, BotMutation, BotProfile};

async fn promote(app: &AppState) -> BotProfile {
    let result = app
        .mutate_bot(BotMutation::Create {
            name: "Assistant".into(),
            instructions: "Coordinate Quizgecko work".into(),
            provider: None,
            model_id: None,
            thread_id: Some("thread-1".into()),
        })
        .await
        .unwrap();
    serde_json::from_value(result["bot"].clone()).unwrap()
}

#[tokio::test]
async fn bot_promotion_persists_identity_and_preserves_native_history() {
    let (app, _temp) = fixture().await;
    let bot = promote(&app).await;
    assert_eq!(bot.thread_id, "thread-1");
    assert!(!bot.dedicated_workspace);
    let home = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_eq!(home.native_session_id.as_deref(), Some("session-parent"));
    assert_eq!(home.title, "Assistant");
    let preferences = crate::app::storage::load_preferences(&app.inner.preferences_path)
        .await
        .unwrap();
    assert_eq!(preferences.bots, [bot.clone()]);
    assert!(
        app.bot_context("thread-1")
            .await
            .unwrap()
            .contains("[Task name](falcondeck://thread/THREAD_ID)")
    );
    assert!(
        app.bot_context("thread-1")
            .await
            .unwrap()
            .contains("Coordinate Quizgecko work")
    );
    app.archive_all_threads("workspace-1").await.unwrap();
    assert!(
        !app.thread_summary("workspace-1", "thread-1")
            .await
            .unwrap()
            .is_archived
    );
    assert!(app.archive_thread("workspace-1", "thread-1").await.is_err());
    assert!(app.delete_thread("workspace-1", "thread-1").await.is_err());
    app.mutate_bot(BotMutation::Delete { id: bot.id.clone() })
        .await
        .unwrap();
    assert!(app.preferences().await.bots.is_empty());
    assert!(
        app.thread_summary("workspace-1", "thread-1")
            .await
            .unwrap()
            .is_archived
    );
    assert!(std::path::Path::new(&bot.space_path).is_dir());
}

#[tokio::test]
async fn bot_documents_detect_external_changes_and_honour_deletion() {
    let (app, _temp) = fixture().await;
    let bot = promote(&app).await;
    let write = |content: &str, version| BotDocumentMutation::Write {
        name: "Priorities.md".into(),
        content: content.into(),
        expected_version: version,
    };
    app.mutate_bot_document(&bot.id, write("First", None))
        .await
        .unwrap();
    let first = app
        .read_bot_document(&bot.id, "Priorities.md")
        .await
        .unwrap();
    assert_eq!(first.content, "First");
    assert!(
        app.mutate_bot_document(&bot.id, write("Duplicate", None))
            .await
            .is_err()
    );
    std::fs::write(
        std::path::Path::new(&bot.space_path).join("Priorities.md"),
        "Edited in Finder",
    )
    .unwrap();
    assert!(
        app.mutate_bot_document(&bot.id, write("Stale edit", Some(first.version.clone())))
            .await
            .is_err()
    );
    assert!(
        app.mutate_bot_document(
            &bot.id,
            BotDocumentMutation::Delete {
                name: "Priorities.md".into(),
                expected_version: first.version,
            }
        )
        .await
        .is_err()
    );
    let latest = app
        .read_bot_document(&bot.id, "Priorities.md")
        .await
        .unwrap();
    assert_eq!(latest.content, "Edited in Finder");
    app.mutate_bot_document(&bot.id, write("Current", Some(latest.version)))
        .await
        .unwrap();
    assert!(
        app.bot_context("thread-1")
            .await
            .unwrap()
            .contains("Priorities.md")
    );
    let latest = app
        .read_bot_document(&bot.id, "Priorities.md")
        .await
        .unwrap();
    app.mutate_bot_document(
        &bot.id,
        BotDocumentMutation::Delete {
            name: "Priorities.md".into(),
            expected_version: latest.version,
        },
    )
    .await
    .unwrap();
    assert!(app.bot_documents(&bot.id).await.unwrap().is_empty());
    assert!(
        !app.bot_context("thread-1")
            .await
            .unwrap()
            .contains("Priorities.md")
    );
    assert!(
        app.read_bot_document(&bot.id, "../daemon-state.json")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn only_bots_can_coordinate_other_projects_and_creation_can_be_disabled() {
    let (app, _temp) = fixture().await;
    assert!(
        app.invoke_thread_tool(
            LIST,
            &json!({"workspace_id":"other"}),
            Some("thread-1"),
            None
        )
        .await
        .is_err()
    );
    let bot = promote(&app).await;
    app.mutate_bot(BotMutation::Update {
        id: bot.id,
        name: bot.name,
        instructions: "New instructions".into(),
        can_start_threads: false,
    })
    .await
    .unwrap();
    let error = app
        .invoke_thread_tool(CREATE, &json!({}), Some("thread-1"), None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("disabled"));
    assert!(
        app.bot_context("thread-1")
            .await
            .unwrap()
            .contains("New instructions")
    );
    assert_eq!(
        app.inner.workspaces.lock().await["workspace-1"]
            .threads
            .len(),
        1
    );
}

#[tokio::test]
async fn bot_cross_project_delegation_retains_parent_and_counts_children_globally() {
    let (app, _temp) = fixture().await;
    promote(&app).await;
    {
        let mut workspaces = app.inner.workspaces.lock().await;
        let mut summary = workspaces["workspace-1"].summary.clone();
        summary.id = "workspace-2".into();
        summary.current_thread_id = None;
        workspaces.insert(
            summary.id.clone(),
            super::super::ManagedWorkspace {
                summary,
                codex_session: None,
                claude_runtime: None,
                agy_runtime: None,
                opencode_runtime: None,
                acp_runtimes: HashMap::new(),
                threads: HashMap::new(),
            },
        );
    }
    let created = app
        .invoke_thread_tool(
            CREATE,
            &json!({"workspace_id":"workspace-2", "title":"A delegated task", "context":"briefing"}),
            Some("thread-1"),
            None,
        )
        .await
        .unwrap();
    assert!(created.result.as_str().unwrap().contains("Created thread"));
    let child = app.inner.workspaces.lock().await["workspace-2"]
        .threads
        .values()
        .next()
        .unwrap()
        .summary
        .clone();
    assert!(
        matches!(child.origin, Some(ThreadOrigin::AgentSpawn { ref parent_thread_id }) if parent_thread_id == "thread-1")
    );
    assert!(
        app.inner.workspaces.lock().await["workspace-2"].threads[&child.id]
            .pending_handoff_context
            .as_ref()
            .is_some_and(|context| context.contains("Assistant"))
    );
    app.restore_bot_watches().await;
    let read = app
        .invoke_thread_tool(
            VIEW,
            &json!({"thread_id": child.id}),
            Some("thread-1"),
            None,
        )
        .await;
    assert!(read.is_ok());
    for _ in 0..2 {
        app.invoke_thread_tool(CREATE, &json!({}), Some("thread-1"), None)
            .await
            .unwrap();
    }
    let fourth = app
        .invoke_thread_tool(
            CREATE,
            &json!({"workspace_id":"workspace-2"}),
            Some("thread-1"),
            None,
        )
        .await
        .unwrap_err();
    assert!(fourth.to_string().contains("3 concurrent children"));

    app.with_thread_mut("workspace-1", "thread-1", |thread| {
        thread.status = ThreadStatus::Running
    })
    .await
    .unwrap();
    for status in [ThreadStatus::Running, ThreadStatus::Idle] {
        app.with_thread_mut("workspace-2", &child.id, |thread| thread.status = status)
            .await
            .unwrap();
        let thread = app.thread_summary("workspace-2", &child.id).await.unwrap();
        app.emit(
            Some("workspace-2".into()),
            Some(child.id.clone()),
            UnifiedEvent::ThreadUpdated { thread },
        );
    }
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    assert!(
        app.inner.workspaces.lock().await["workspace-1"].threads["thread-1"]
            .queued_requests
            .is_empty(),
        "Restored bot watches must not report successful turn endings"
    );
    app.with_thread_mut("workspace-2", &child.id, |thread| {
        thread.status = ThreadStatus::WaitingForInput
    })
    .await
    .unwrap();
    let waiting = app.thread_summary("workspace-2", &child.id).await.unwrap();
    app.emit(
        Some("workspace-2".into()),
        Some(child.id.clone()),
        UnifiedEvent::ThreadUpdated { thread: waiting },
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let has_receipt = app.inner.workspaces.lock().await["workspace-1"].threads["thread-1"].queued_requests.iter()
                .flat_map(|queued| &queued.request.inputs)
                .any(|input| matches!(input, falcondeck_core::TurnInputItem::Text { text, .. } if text.contains(&child.id)));
            if has_receipt { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.expect("Cross-project workers needing input must notify the bot's home workspace");
}

#[tokio::test]
async fn new_bot_has_a_dedicated_space_and_native_home() {
    let temp = tempfile::tempdir().unwrap();
    let missing = temp
        .path()
        .join("missing-harness")
        .to_string_lossy()
        .to_string();
    let app = AppState::new_with_state_path(
        "test".into(),
        HashMap::from([
            (AgentProvider::CODEX, missing.clone()),
            (AgentProvider::CLAUDE, missing.clone()),
            (AgentProvider::AGY, missing),
        ]),
        temp.path().join("daemon-state.json"),
    );
    let result = app
        .mutate_bot(BotMutation::Create {
            name: "Developer".into(),
            instructions: "Coordinate development".into(),
            provider: Some(AgentProvider::CLAUDE),
            model_id: Some("sonnet".into()),
            thread_id: None,
        })
        .await
        .unwrap();
    let bot: BotProfile = serde_json::from_value(result["bot"].clone()).unwrap();
    assert!(bot.dedicated_workspace);
    assert_eq!(
        app.snapshot()
            .await
            .workspaces
            .iter()
            .find(|ws| ws.id == bot.workspace_id)
            .unwrap()
            .kind,
        falcondeck_core::WorkspaceKind::Casual
    );
    assert!(std::path::Path::new(&bot.space_path).is_dir());
    assert!(std::path::Path::new(&bot.space_path).starts_with(temp.path()));
    let thread = app
        .thread_summary(&bot.workspace_id, &bot.thread_id)
        .await
        .unwrap();
    assert_eq!(thread.provider, AgentProvider::CLAUDE);
    assert_eq!(thread.agent.model_id.as_deref(), Some("sonnet"));
    assert_eq!(thread.title, "Developer");
    assert!(
        app.casual_chat_documents_root(&bot.workspace_id)
            .await
            .is_none()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn project_thread_can_reply_to_a_bot_in_another_workspace() {
    let (app, _temp) = fixture().await;
    promote(&app).await;
    let worker = created_id(
        &app.invoke_thread_tool(CREATE, &json!({}), Some("thread-1"), None)
            .await
            .unwrap(),
    );
    let (other, _other_temp) = fixture().await;
    let mut project = other
        .inner
        .workspaces
        .lock()
        .await
        .remove("workspace-1")
        .unwrap();
    project.summary.id = "workspace-2".into();
    let mut thread = project.threads.remove("thread-1").unwrap();
    thread.summary.id = "project-thread".into();
    thread.summary.workspace_id = "workspace-2".into();
    project.threads.insert("project-thread".into(), thread);
    app.inner
        .workspaces
        .lock()
        .await
        .insert("workspace-2".into(), project);
    app.with_thread_mut("workspace-1", "thread-1", |t| {
        t.status = ThreadStatus::Running
    })
    .await
    .unwrap();
    // Project threads see bots in their overview and can address them by name.
    let listed = app
        .invoke_thread_tool(LIST, &json!({}), Some("project-thread"), None)
        .await
        .unwrap();
    assert!(
        listed.result.as_str().unwrap().contains(
            "Bots (message by name or id with falcondeck_message_thread): Assistant `thread-1`"
        ),
        "{:?}",
        listed.result
    );
    for arguments in [
        json!({"thread_id":"thread-1", "message":"Done with the review.", "delivery":"queue"}),
        json!({"workspace_id":"workspace-1", "thread_id":"thread-1", "message":"Also fixed the tests.", "delivery":"queue"}),
        json!({"thread_id":"assistant", "message":"Sent by name.", "delivery":"queue"}),
    ] {
        app.invoke_thread_tool(MESSAGE, &arguments, Some("project-thread"), None)
            .await
            .unwrap();
    }
    let queued = app.inner.workspaces.lock().await["workspace-1"].threads["thread-1"]
        .queued_requests
        .iter()
        .map(|queued| queued.summary.text.clone())
        .collect::<Vec<_>>();
    assert_eq!(queued.len(), 3);
    assert!(queued[2].ends_with("Sent by name."));
    // Reading a bot from a project explains how to reach it instead.
    for name in [SUMMARY, VIEW] {
        let error = app
            .invoke_thread_tool(
                name,
                &json!({"thread_id":"thread-1"}),
                Some("project-thread"),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("is the bot Assistant"),
            "{error}"
        );
    }
    assert!(queued[0].starts_with("Message from FalconDeck thread project-thread"));
    // Only the bot is reachable; its project-local workers and listings stay scoped.
    for (name, arguments) in [
        (
            MESSAGE,
            json!({"thread_id": worker, "message":"Hello there."}),
        ),
        (LIST, json!({"workspace_id":"workspace-1"})),
        (VIEW, json!({"thread_id":"thread-1"})),
    ] {
        assert!(
            app.invoke_thread_tool(name, &arguments, Some("project-thread"), None)
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn bot_overviews_span_projects_and_accept_project_names() {
    let (app, _temp) = fixture().await;
    promote(&app).await;
    {
        let mut workspaces = app.inner.workspaces.lock().await;
        let mut summary = workspaces["workspace-1"].summary.clone();
        summary.id = "workspace-2".into();
        summary.path = "/tmp/projects/Quizgecko".into();
        summary.current_thread_id = None;
        let mut thread = workspaces["workspace-1"].threads["thread-1"]
            .summary
            .clone();
        thread.id = "q1".into();
        thread.workspace_id = "workspace-2".into();
        thread.title = "Grade quizzes".into();
        thread.status = ThreadStatus::Running;
        thread.native_session_id = None;
        workspaces.insert(
            summary.id.clone(),
            super::super::ManagedWorkspace {
                summary,
                codex_session: None,
                claude_runtime: None,
                agy_runtime: None,
                opencode_runtime: None,
                acp_runtimes: HashMap::new(),
                threads: [("q1".to_string(), ManagedThread::new(thread))]
                    .into_iter()
                    .collect(),
            },
        );
    }
    let bot = async |name: &str, arguments: Value| {
        app.invoke_thread_tool(name, &arguments, Some("thread-1"), None)
            .await
            .map(|r| r.result.as_str().unwrap().to_string())
    };
    let all = bot(LIST, json!({})).await.unwrap();
    assert!(
        all.starts_with("# Threads across 2 projects\n")
            && all.contains("`q1` — running · 0s ago · claude · project Quizgecko"),
        "{all}"
    );
    let named = bot(LIST, json!({"workspace_id":"quizgecko"}))
        .await
        .unwrap();
    assert!(
        named.starts_with("# Threads in Quizgecko (/tmp/projects/Quizgecko)")
            && named.contains("`q1`"),
        "{named}"
    );
    let running = bot(LIST, json!({"workspace_id":"all", "status":"running"}))
        .await
        .unwrap();
    assert!(running.contains("Showing 1–1 of 1"), "{running}");
    let changes = bot(CHANGES, json!({"since":"1h"})).await.unwrap();
    assert!(
        changes.contains("across 2 projects") && changes.contains("project Quizgecko"),
        "{changes}"
    );
    // Ids from an all-project list summarize together.
    let summary = bot(SUMMARY, json!({"thread_ids":["q1", "thread-1"]}))
        .await
        .unwrap();
    assert!(
        summary.contains("## Grade quizzes `q1`") && summary.contains("`thread-1`"),
        "{summary}"
    );
    assert!(
        bot(VIEW, json!({"workspace_id":"all", "thread_id":"q1"}))
            .await
            .is_err()
    );
    assert!(bot(LIST, json!({"workspace_id":"missing"})).await.is_err());
    // Ordinary tasks cannot widen their scope.
    let task = app
        .invoke_thread_tool(LIST, &json!({"workspace_id":"all"}), Some("q1"), None)
        .await;
    assert!(task.is_err());
    let context = app.bot_context("thread-1").await.unwrap();
    assert!(
        context.contains("Projects, most recently active first:\n- ")
            && context.contains("\n- /tmp/projects/Quizgecko (`workspace-2`)"),
        "{context}"
    );
    assert!(context.contains("## Coordinating work"), "{context}");
}

#[tokio::test]
async fn bot_context_lists_peer_status_files_but_not_its_own() {
    let (app, _temp) = fixture().await;
    let bot = promote(&app).await;
    let lone = app.bot_context("thread-1").await.unwrap();
    assert!(!lone.contains("Other bots"), "{lone}");
    assert!(lone.contains("## Status"), "{lone}");
    app.inner.preferences.lock().await.bots.push(BotProfile {
        id: "bot-peer".into(),
        name: "CMO".into(),
        workspace_id: "workspace-peer".into(),
        dedicated_workspace: true,
        thread_id: "thread-peer".into(),
        space_path: "/tmp/bots/bot-peer/space".into(),
        instructions: String::new(),
        can_start_threads: true,
    });
    let context = app.bot_context("thread-1").await.unwrap();
    assert!(
        context.contains("\n- CMO: /tmp/bots/bot-peer/space/STATUS.md"),
        "{context}"
    );
    assert!(
        !context.contains(&format!("{}/STATUS.md", bot.space_path)),
        "{context}"
    );
}
