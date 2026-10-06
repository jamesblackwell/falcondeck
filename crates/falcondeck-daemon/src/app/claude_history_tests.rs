use super::*;

use std::fs;

use falcondeck_core::WorkspaceKind;
use tempfile::TempDir;

const WORKSPACE_ID: &str = "workspace-lazy-claude";
const THREAD_ID: &str = "falcondeck-restored-thread";
const NATIVE_ID: &str = "11111111-1111-4111-8111-111111111111";
const FOREIGN_ID: &str = "22222222-2222-4222-8222-222222222222";

struct Fixture {
    _temp: TempDir,
    app: AppState,
    cwd: String,
    source: PathBuf,
    state: Arc<ClaudeHistoryState>,
}

fn native_records(cwd: &str, session_id: &str, title: &str, with_items: bool) -> Vec<Value> {
    let mut records = vec![json!({
        "type": "custom-title", "sessionId": session_id, "cwd": cwd,
        "customTitle": title, "timestamp": "2026-10-05T10:00:00Z",
    })];
    if with_items {
        records.extend([
            json!({
                "type": "user", "sessionId": session_id, "cwd": cwd,
                "uuid": "original-user", "timestamp": "2026-10-05T10:00:01Z",
                "message": {"role": "user", "content": [
                    {"type": "text", "text": "Original prompt"},
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": "aGVsbG8=",
                    }},
                ]},
            }),
            json!({
                "type": "assistant", "sessionId": session_id, "cwd": cwd,
                "uuid": "original-assistant-record", "timestamp": "2026-10-05T10:00:02Z",
                "message": {"id": "original-assistant", "role": "assistant", "content": [
                    {"type": "thinking", "thinking": "Original reasoning"},
                    {"type": "text", "text": "Original answer"},
                ]},
            }),
            json!({
                "type": "assistant", "sessionId": session_id, "cwd": cwd,
                "uuid": "original-tool-record", "timestamp": "2026-10-05T10:00:03Z",
                "message": {"id": "tool-message", "role": "assistant", "content": [
                    {"type": "tool_use", "id": "original-tool", "name": "Read",
                        "input": {"file_path": "/fixture/notes.md"}},
                ]},
            }),
            json!({
                "type": "user", "sessionId": session_id, "cwd": cwd,
                "uuid": "original-tool-result", "timestamp": "2026-10-05T10:00:04Z",
                "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "original-tool", "content": "fixture result"},
                ]},
            }),
        ]);
    }
    records
}

fn write_records(path: &Path, records: &[Value]) {
    fs::write(
        path,
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
}

async fn fixture(with_items: bool) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let cwd = project.to_string_lossy().to_string();
    let native_root = temp.path().join("native-projects");
    let project_root = native_root.join(cwd.replace(['/', '\\'], "-"));
    fs::create_dir_all(&project_root).unwrap();
    let source = project_root.join(format!("{NATIVE_ID}.jsonl"));
    write_records(
        &source,
        &native_records(&cwd, NATIVE_ID, "Discovered title", with_items),
    );
    let mut discovered = crate::claude::discover_threads_in(&native_root, &cwd);
    assert_eq!(discovered.len(), 1);
    let discovered = discovered.remove(0);
    assert_eq!(discovered.history_source, source);
    let mut summary = discovered.summary;
    summary.id = THREAD_ID.to_string();
    summary.workspace_id = WORKSPACE_ID.to_string();
    summary.attention.last_agent_activity_seq = 50;
    summary.attention.last_read_seq = 50;
    let state = ClaudeHistoryState::new(
        source.clone(),
        NATIVE_ID.into(),
        cwd.clone(),
        summary.title.clone(),
    );
    let mut thread = ManagedThread::new(summary);
    thread.requires_resume = true;
    thread.claude_history = Some(state.clone());
    thread.title_is_provider_preview = discovered.title_is_provider_preview;
    let app = AppState::new_with_state_path(
        "test".into(),
        [
            AgentProvider::CODEX,
            AgentProvider::CLAUDE,
            AgentProvider::AGY,
        ]
        .into_iter()
        .map(|provider| (provider, "/usr/bin/false".into()))
        .collect(),
        temp.path().join("state.json"),
    );
    app.inner.workspaces.lock().await.insert(
        WORKSPACE_ID.into(),
        ManagedWorkspace {
            summary: WorkspaceSummary {
                id: WORKSPACE_ID.into(),
                path: cwd.clone(),
                kind: WorkspaceKind::Project,
                status: WorkspaceStatus::Ready,
                agents: vec![WorkspaceAgentSummary {
                    provider: AgentProvider::CLAUDE,
                    label: "Claude".into(),
                    account: Default::default(),
                    models: vec![],
                    models_loading: false,
                    collaboration_modes: vec![],
                    skills: vec![],
                    capabilities: AgentCapabilitySummary::claude(),
                }],
                skills: vec![],
                default_provider: AgentProvider::CLAUDE,
                models: vec![],
                collaboration_modes: vec![],
                account: Default::default(),
                current_thread_id: Some(THREAD_ID.into()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
                icon: None,
            },
            codex_session: None,
            claude_runtime: Some(crate::claude::ClaudeRuntime::for_test(
                cwd.clone(),
                "/usr/bin/false".into(),
            )),
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: HashMap::from([(THREAD_ID.into(), thread)]),
        },
    );
    Fixture {
        _temp: temp,
        app,
        cwd,
        source,
        state,
    }
}

fn fresh_message(text: &str) -> ConversationItem {
    ConversationItem::UserMessage {
        id: "live-user".into(),
        text: text.into(),
        attachments: vec![],
        turn_id: None,
        previous_turn_id: None,
        created_at: Utc::now(),
    }
}

fn parsed_history(fixture: &Fixture) -> crate::codex::HydratedThread {
    let native =
        crate::claude::hydrate_native_thread(&fixture.source, &fixture.cwd, NATIVE_ID).unwrap();
    crate::codex::HydratedThread {
        summary: native.summary,
        items: native.items,
        title_is_provider_preview: native.title_is_provider_preview,
    }
}

#[tokio::test]
async fn summaries_retain_no_items_and_first_detail_hydrates_images_and_indexes() {
    let fixture = fixture(true).await;
    let before = fixture.app.snapshot().await;
    let attention = before.threads[0].attention.clone();
    {
        let workspaces = fixture.app.inner.workspaces.lock().await;
        let thread = &workspaces[WORKSPACE_ID].threads[THREAD_ID];
        assert!(thread.items.is_empty());
        assert!(thread.assistant_items.is_empty());
        assert!(thread.reasoning_items.is_empty());
        assert!(thread.tool_items.is_empty());
        assert!(thread.other_items.is_empty());
        assert!(!fixture.state.loaded.load(Ordering::Acquire));
    }
    write_records(
        &fixture.source,
        &native_records(&fixture.cwd, NATIVE_ID, "Native title now", true),
    );
    let detail = fixture
        .app
        .thread_detail(WORKSPACE_ID, THREAD_ID)
        .await
        .unwrap();
    assert_eq!(detail.thread.id, THREAD_ID);
    assert_eq!(detail.thread.native_session_id.as_deref(), Some(NATIVE_ID));
    assert_eq!(detail.thread.title, "Native title now");
    assert_eq!(
        detail.thread.attention, attention,
        "disk replay must not create unread activity"
    );
    let image = detail
        .items
        .iter()
        .find_map(|item| match item {
            ConversationItem::UserMessage { attachments, .. } => attachments.first(),
            _ => None,
        })
        .unwrap();
    let path = image
        .local_path
        .as_ref()
        .expect("native image should be materialized");
    assert_eq!(image.url, "data:image/png;base64,aGVsbG8=");
    assert_eq!(fs::read(path).unwrap(), b"hello");
    assert!(Path::new(path).starts_with(fixture._temp.path()));
    let workspaces = fixture.app.inner.workspaces.lock().await;
    let thread = &workspaces[WORKSPACE_ID].threads[THREAD_ID];
    let stored_image = thread
        .items
        .iter()
        .find_map(|item| match item {
            ConversationItem::UserMessage { attachments, .. } => attachments.first(),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        &stored_image.url, path,
        "retained history should keep a file reference"
    );
    assert!(thread.ai_title_generated);
    assert!(!thread.title_is_provider_preview);
    assert_eq!(thread.assistant_items.len(), 1);
    assert_eq!(thread.reasoning_items.len(), 1);
    assert_eq!(thread.tool_items.len(), 1);
    assert_eq!(thread.other_items.len(), 1);
    for (id, index) in thread
        .assistant_items
        .iter()
        .chain(thread.reasoning_items.iter())
        .chain(thread.tool_items.iter())
        .chain(thread.other_items.iter())
    {
        assert_eq!(
            serde_json::to_value(&thread.items[*index]).unwrap()["id"].as_str(),
            Some(id.as_str())
        );
    }
    assert!(thread.requires_resume);
    assert!(fixture.state.loaded.load(Ordering::Acquire));
}

#[tokio::test]
async fn concurrent_detail_reads_install_once_and_do_not_reread_changed_native_history() {
    let fixture = fixture(true).await;
    let (first, second) = tokio::join!(
        fixture.app.thread_detail(WORKSPACE_ID, THREAD_ID),
        fixture.app.thread_detail(WORKSPACE_ID, THREAD_ID),
    );
    let first = first.unwrap();
    assert_eq!(first.items, second.unwrap().items);
    write_records(
        &fixture.source,
        &native_records(&fixture.cwd, NATIVE_ID, "Changed on disk", false),
    );
    let again = fixture
        .app
        .thread_detail(WORKSPACE_ID, THREAD_ID)
        .await
        .unwrap();
    assert_eq!(first.items, again.items);
    assert_eq!(first.thread.title, again.thread.title);
}

#[tokio::test]
async fn empty_native_history_is_explicitly_loaded_and_not_retried() {
    let fixture = fixture(false).await;
    assert!(
        fixture
            .app
            .thread_detail(WORKSPACE_ID, THREAD_ID)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert!(fixture.state.loaded.load(Ordering::Acquire));
    write_records(
        &fixture.source,
        &native_records(&fixture.cwd, NATIVE_ID, "Later messages", true),
    );
    assert!(
        fixture
            .app
            .thread_detail(WORKSPACE_ID, THREAD_ID)
            .await
            .unwrap()
            .items
            .is_empty()
    );
}

#[tokio::test]
async fn missing_or_foreign_native_history_fails_closed_and_can_be_retried() {
    for invalid in ["missing", "foreign-session", "foreign-cwd"] {
        let fixture = fixture(true).await;
        match invalid {
            "missing" => fs::remove_file(&fixture.source).unwrap(),
            "foreign-session" => write_records(
                &fixture.source,
                &native_records(&fixture.cwd, FOREIGN_ID, "Foreign title", true),
            ),
            "foreign-cwd" => write_records(
                &fixture.source,
                &native_records("/unrelated/workspace", NATIVE_ID, "Foreign title", true),
            ),
            _ => unreachable!(),
        }
        let error = fixture
            .app
            .thread_detail(WORKSPACE_ID, THREAD_ID)
            .await
            .unwrap_err();
        assert!(
            matches!(error, DaemonError::NotFound(_)),
            "{invalid}: {error}"
        );
        assert!(
            !fixture.state.loaded.load(Ordering::Acquire),
            "{invalid} must remain retryable"
        );
        assert!(
            fixture.app.inner.workspaces.lock().await[WORKSPACE_ID].threads[THREAD_ID]
                .items
                .is_empty()
        );
        write_records(
            &fixture.source,
            &native_records(&fixture.cwd, NATIVE_ID, "Recovered title", true),
        );
        assert!(
            !fixture
                .app
                .thread_detail(WORKSPACE_ID, THREAD_ID)
                .await
                .unwrap()
                .items
                .is_empty()
        );
        assert!(fixture.state.loaded.load(Ordering::Acquire));
    }
}

#[tokio::test]
async fn hydration_preserves_manual_title_and_saved_attention() {
    let fixture = fixture(true).await;
    let attention = {
        let mut workspaces = fixture.app.inner.workspaces.lock().await;
        let thread = workspaces
            .get_mut(WORKSPACE_ID)
            .unwrap()
            .threads
            .get_mut(THREAD_ID)
            .unwrap();
        thread.manual_title = true;
        thread.summary.title = "Manually renamed task".into();
        thread.summary.attention.last_agent_activity_seq = 77;
        thread.summary.attention.last_read_seq = 76;
        thread.summary.attention.unread = true;
        thread.summary.attention.clone()
    };
    let detail = fixture
        .app
        .thread_detail(WORKSPACE_ID, THREAD_ID)
        .await
        .unwrap();
    assert_eq!(detail.thread.title, "Manually renamed task");
    assert_eq!(
        detail.thread.attention.last_agent_activity_seq,
        attention.last_agent_activity_seq
    );
    assert_eq!(
        detail.thread.attention.last_read_seq,
        attention.last_read_seq
    );
    assert!(detail.thread.attention.unread);
    assert_eq!(
        fixture.app.inner.workspaces.lock().await[WORKSPACE_ID].threads[THREAD_ID]
            .summary
            .attention,
        attention
    );
}

#[tokio::test]
async fn send_waits_for_history_gate_and_admits_new_prompt_after_old_items() {
    let _oauth_store_lock = crate::connector_oauth::lock_store_for_test();
    let fixture = fixture(true).await;
    crate::connector_oauth::set_store_path_for_test(fixture._temp.path().join("oauth.json"));
    let gate = fixture.state.gate.clone().lock_owned().await;
    let request: SendTurnRequest = serde_json::from_value(json!({
        "workspace_id": WORKSPACE_ID, "thread_id": THREAD_ID,
        "inputs": [{"type": "text", "text": "New prompt"}],
        "model_id": null, "reasoning_effort": null, "approval_policy": null,
        "service_tier": null,
    }))
    .unwrap();
    let app = fixture.app.clone();
    let mut send = tokio::spawn(async move { app.send_turn(request).await });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut send)
            .await
            .is_err()
    );
    assert!(
        fixture.app.inner.workspaces.lock().await[WORKSPACE_ID].threads[THREAD_ID]
            .items
            .is_empty()
    );
    drop(gate);
    let fake_provider_result = tokio::time::timeout(Duration::from_secs(5), send)
        .await
        .expect("send should proceed after history gate release")
        .unwrap();
    assert!(
        fake_provider_result.is_ok()
            || matches!(fake_provider_result, Err(DaemonError::Process(_)))
    );
    let workspaces = fixture.app.inner.workspaces.lock().await;
    let items = &workspaces[WORKSPACE_ID].threads[THREAD_ID].items;
    let text = items
        .iter()
        .filter_map(|item| match item {
            ConversationItem::UserMessage { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(text, ["Original prompt", "New prompt"]);
    assert!(fixture.state.loaded.load(Ordering::Acquire));
    drop(workspaces);
    fixture.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn compact_waits_for_history_gate_before_mutating_thread() {
    let _oauth_store_lock = crate::connector_oauth::lock_store_for_test();
    let fixture = fixture(true).await;
    crate::connector_oauth::set_store_path_for_test(fixture._temp.path().join("oauth.json"));
    let gate = fixture.state.gate.clone().lock_owned().await;
    let app = fixture.app.clone();
    let mut compact = tokio::spawn(async move {
        app.compact_thread(CompactThreadRequest {
            workspace_id: WORKSPACE_ID.into(),
            thread_id: THREAD_ID.into(),
            instructions: None,
        })
        .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut compact)
            .await
            .is_err()
    );
    let before = fixture
        .app
        .thread_summary(WORKSPACE_ID, THREAD_ID)
        .await
        .unwrap();
    assert_eq!(before.status, ThreadStatus::Idle);
    assert!(!fixture.state.loaded.load(Ordering::Acquire));
    drop(gate);
    let fake_provider_result = tokio::time::timeout(Duration::from_secs(5), compact)
        .await
        .expect("compaction should proceed after history gate release")
        .unwrap();
    match fake_provider_result {
        Ok(response) => {
            assert!(response.ok);
            assert_eq!(response.message.as_deref(), Some("compaction started"));
        }
        Err(DaemonError::Process(_)) => {}
        Err(error) => panic!("compaction failed before provider admission: {error}"),
    }
    assert!(matches!(
        fixture
            .app
            .thread_summary(WORKSPACE_ID, THREAD_ID)
            .await
            .unwrap()
            .status,
        ThreadStatus::Running | ThreadStatus::Error
    ));
    assert!(fixture.state.loaded.load(Ordering::Acquire));
    assert!(
        !fixture.app.inner.workspaces.lock().await[WORKSPACE_ID].threads[THREAD_ID]
            .items
            .is_empty()
    );
    fixture.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn stale_hydration_does_not_overwrite_live_items_or_changed_turn_state() {
    for changed in ["live-items", "status", "latest-turn", "resume"] {
        let fixture = fixture(true).await;
        let history = parsed_history(&fixture);
        let mut workspaces = fixture.app.inner.workspaces.lock().await;
        let thread = workspaces
            .get_mut(WORKSPACE_ID)
            .unwrap()
            .threads
            .get_mut(THREAD_ID)
            .unwrap();
        let old_status = thread.summary.status.clone();
        let old_turn = thread.summary.latest_turn_id.clone();
        let old_resume = thread.requires_resume;
        match changed {
            "live-items" => thread.replace_items(vec![fresh_message("Live authoritative prompt")]),
            "status" => thread.summary.status = ThreadStatus::Running,
            "latest-turn" => thread.summary.latest_turn_id = Some("new-turn".into()),
            "resume" => thread.requires_resume = false,
            _ => unreachable!(),
        }
        let expected_items = thread.items.clone();
        let expected_summary = thread.summary.clone();
        install_history(
            thread,
            &fixture.cwd,
            &fixture.state,
            old_status,
            old_turn,
            old_resume,
            history,
        )
        .unwrap();
        assert_eq!(thread.items, expected_items, "{changed}");
        assert_eq!(thread.summary, expected_summary, "{changed}");
        assert!(fixture.state.loaded.load(Ordering::Acquire));
    }
}

#[tokio::test]
async fn stale_hydration_cannot_cross_session_remap_or_replaced_workspace() {
    for changed in ["native-session", "working-directory", "replacement-state"] {
        let fixture = fixture(true).await;
        let history = parsed_history(&fixture);
        let mut workspaces = fixture.app.inner.workspaces.lock().await;
        let thread = workspaces
            .get_mut(WORKSPACE_ID)
            .unwrap()
            .threads
            .get_mut(THREAD_ID)
            .unwrap();
        let status = thread.summary.status.clone();
        let turn = thread.summary.latest_turn_id.clone();
        let resume = thread.requires_resume;
        let workspace_path = match changed {
            "native-session" => {
                thread.summary.native_session_id = Some(FOREIGN_ID.into());
                fixture.cwd.as_str()
            }
            "working-directory" => "/replaced/workspace",
            "replacement-state" => {
                thread.claude_history = Some(ClaudeHistoryState::new(
                    fixture.source.clone(),
                    NATIVE_ID.into(),
                    fixture.cwd.clone(),
                    "New state".into(),
                ));
                fixture.cwd.as_str()
            }
            _ => unreachable!(),
        };
        let expected_summary = thread.summary.clone();
        let error = install_history(
            thread,
            workspace_path,
            &fixture.state,
            status,
            turn,
            resume,
            history,
        )
        .unwrap_err();
        assert!(
            matches!(error, DaemonError::Conflict(_)),
            "{changed}: {error}"
        );
        assert!(thread.items.is_empty());
        assert_eq!(thread.summary, expected_summary);
        assert!(!fixture.state.loaded.load(Ordering::Acquire));
    }
}

#[tokio::test]
async fn fresh_threads_have_no_disk_history_gate() {
    let fixture = fixture(true).await;
    let fresh_item = fresh_message("Fresh in-memory prompt");
    {
        let mut workspaces = fixture.app.inner.workspaces.lock().await;
        let thread = workspaces
            .get_mut(WORKSPACE_ID)
            .unwrap()
            .threads
            .get_mut(THREAD_ID)
            .unwrap();
        thread.claude_history = None;
        thread.summary.native_session_id = None;
        thread.requires_resume = false;
        thread.replace_items(vec![fresh_item.clone()]);
    }
    fs::remove_file(&fixture.source).unwrap();
    assert!(
        fixture
            .app
            .claude_history_for_admission(WORKSPACE_ID, THREAD_ID)
            .await
            .unwrap()
            .is_none()
    );
    let detail = fixture
        .app
        .thread_detail(WORKSPACE_ID, THREAD_ID)
        .await
        .unwrap();
    assert_eq!(detail.items, [fresh_item]);
}

#[tokio::test]
async fn native_placeholders_without_pending_state_fail_closed_before_send_or_compaction() {
    for action in ["send", "compact"] {
        let fixture = fixture(true).await;
        let before = {
            let mut workspaces = fixture.app.inner.workspaces.lock().await;
            let thread = workspaces
                .get_mut(WORKSPACE_ID)
                .unwrap()
                .threads
                .get_mut(THREAD_ID)
                .unwrap();
            // A random native id cannot address an existing real session. This
            // exercises fallback source selection without changing global config.
            thread.summary.native_session_id = Some(Uuid::new_v4().to_string());
            thread.claude_history = None;
            thread.summary.clone()
        };
        let error = if action == "send" {
            let request: SendTurnRequest = serde_json::from_value(json!({
                "workspace_id": WORKSPACE_ID, "thread_id": THREAD_ID,
                "inputs": [{"type": "text", "text": "Never admit this prompt"}],
                "model_id": null, "reasoning_effort": null, "approval_policy": null,
                "service_tier": null,
            }))
            .unwrap();
            fixture.app.send_turn(request).await.unwrap_err()
        } else {
            fixture
                .app
                .compact_thread(CompactThreadRequest {
                    workspace_id: WORKSPACE_ID.into(),
                    thread_id: THREAD_ID.into(),
                    instructions: None,
                })
                .await
                .unwrap_err()
        };
        assert!(
            matches!(error, DaemonError::NotFound(_)),
            "{action}: {error}"
        );
        let workspaces = fixture.app.inner.workspaces.lock().await;
        let thread = &workspaces[WORKSPACE_ID].threads[THREAD_ID];
        assert_eq!(
            thread.summary, before,
            "{action} must not mutate admission state"
        );
        assert!(thread.items.is_empty());
        assert!(
            !thread
                .claude_history
                .as_ref()
                .unwrap()
                .loaded
                .load(Ordering::Acquire)
        );
    }
}

#[tokio::test]
async fn admission_retains_the_history_gate_after_hydration_until_startup_finishes() {
    let fixture = fixture(true).await;
    let guard = fixture
        .app
        .claude_history_for_admission(WORKSPACE_ID, THREAD_ID)
        .await
        .unwrap()
        .unwrap();
    assert!(fixture.state.loaded.load(Ordering::Acquire));
    let app = fixture.app.clone();
    let mut detail = tokio::spawn(async move { app.thread_detail(WORKSPACE_ID, THREAD_ID).await });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut detail)
            .await
            .is_err(),
        "loaded fast-path must still wait for admission gate"
    );
    drop(guard);
    assert!(
        !tokio::time::timeout(Duration::from_secs(2), detail)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .items
            .is_empty()
    );
}

#[tokio::test]
async fn live_state_before_loading_never_requires_or_overwrites_disk_history() {
    for live in ["items", "running", "waiting"] {
        let fixture = fixture(true).await;
        let expected = {
            let mut workspaces = fixture.app.inner.workspaces.lock().await;
            let thread = workspaces
                .get_mut(WORKSPACE_ID)
                .unwrap()
                .threads
                .get_mut(THREAD_ID)
                .unwrap();
            match live {
                "items" => thread.replace_items(vec![fresh_message("Live authoritative prompt")]),
                "running" => thread.summary.status = ThreadStatus::Running,
                "waiting" => thread.summary.status = ThreadStatus::WaitingForInput,
                _ => unreachable!(),
            }
            thread.items.clone()
        };
        fs::remove_file(&fixture.source).unwrap();
        let detail = fixture
            .app
            .thread_detail(WORKSPACE_ID, THREAD_ID)
            .await
            .unwrap();
        assert_eq!(detail.items, expected, "{live}");
        assert!(fixture.state.loaded.load(Ordering::Acquire));
    }
}

#[tokio::test]
async fn interrupted_restored_history_loads_before_settling_and_building_indexes() {
    let fixture = fixture(true).await;
    {
        let mut workspaces = fixture.app.inner.workspaces.lock().await;
        let thread = workspaces
            .get_mut(WORKSPACE_ID)
            .unwrap()
            .threads
            .get_mut(THREAD_ID)
            .unwrap();
        thread.summary.status = ThreadStatus::Error;
        thread.summary.last_error = Some(SHUTDOWN_INTERRUPTED_TURN_ERROR.into());
        thread.summary.latest_turn_id = Some("interrupted-turn".into());
    }
    let mut records = native_records(&fixture.cwd, NATIVE_ID, "Discovered title", true);
    records.pop(); // Native tool was still running when FalconDeck closed.
    write_records(&fixture.source, &records);
    let detail = fixture
        .app
        .thread_detail(WORKSPACE_ID, THREAD_ID)
        .await
        .unwrap();
    assert!(detail.items.iter().any(|item| matches!(item, ConversationItem::UserMessage { text, .. } if text == "Original prompt")));
    assert!(detail.items.iter().any(
        |item| matches!(item, ConversationItem::ToolCall { status, .. } if status == "interrupted")
    ));
    let workspaces = fixture.app.inner.workspaces.lock().await;
    let thread = &workspaces[WORKSPACE_ID].threads[THREAD_ID];
    assert!(!thread.other_items.is_empty());
    assert_eq!(thread.tool_items.len(), 1);
    assert!(fixture.state.loaded.load(Ordering::Acquire));
}

#[tokio::test]
async fn dropping_a_rejected_native_session_also_discards_its_history_state() {
    let fixture = fixture(true).await;
    fixture
        .app
        .drop_claude_native_session(WORKSPACE_ID, THREAD_ID)
        .await;
    fs::remove_file(&fixture.source).unwrap();
    {
        let workspaces = fixture.app.inner.workspaces.lock().await;
        let thread = &workspaces[WORKSPACE_ID].threads[THREAD_ID];
        assert!(thread.summary.native_session_id.is_none());
        assert!(thread.claude_history.is_none());
    }
    assert!(
        fixture
            .app
            .claude_history_for_admission(WORKSPACE_ID, THREAD_ID)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .app
            .thread_detail(WORKSPACE_ID, THREAD_ID)
            .await
            .unwrap()
            .items
            .is_empty()
    );
}
