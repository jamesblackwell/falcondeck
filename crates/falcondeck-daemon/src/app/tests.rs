use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use chrono::{Duration, Utc};
use falcondeck_core::{
    AgentProvider, ContentLifecycle, ConversationItem, DaemonRestorePhase, ExtensionThreadSummary,
    ImageInput, InteractiveRequest, InteractiveRequestKind, InteractiveRequestOutcome,
    InteractiveResponsePayload, PlanApprovalOutcome, ServiceLevel, SnapshotRequest,
    ThreadAgentParams, ThreadAttention, ThreadPlan, ThreadStatus, ThreadSummary, ToolActivityKind,
    ToolArtifactKind, ToolCallDetail, ToolHistoryMode, ToolLifecycle, TurnInputItem, UnifiedEvent,
    UpdateThreadRequest, WorkspaceStatus, WorkspaceSummary,
    crypto::{LocalBoxKeyPair, build_pairing_public_key_bundle, generate_data_key},
};

#[tokio::test]
async fn snapshots_expose_the_local_restore_boundary() {
    let temp = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp.path().join("state.json"),
    );

    assert_eq!(
        app.snapshot().await.restore_phase,
        DaemonRestorePhase::Ready
    );
    app.begin_local_restore();
    assert_eq!(
        app.snapshot().await.restore_phase,
        DaemonRestorePhase::LoadingPersistedState
    );
    app.mark_persisted_state_loaded();
    assert_eq!(
        app.snapshot().await.restore_phase,
        DaemonRestorePhase::HydratingWorkspaces
    );
    app.finish_local_restore();
    assert_eq!(
        app.snapshot().await.restore_phase,
        DaemonRestorePhase::Ready
    );
}
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::sync::mpsc;
use tokio::time::{Duration as TokioDuration, sleep};

#[cfg(unix)]
#[tokio::test]
async fn claude_harness_upgrade_refreshes_connected_workspace_models() {
    let temp = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp.path().join("state.json"),
    );
    let workspace_id = "workspace-claude-upgrade".to_string();
    let runtime = crate::claude::ClaudeRuntime::for_test(
        temp.path().to_string_lossy().to_string(),
        "/usr/bin/false".to_string(),
    );
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                id: workspace_id.clone(),
                path: temp.path().to_string_lossy().to_string(),
                kind: falcondeck_core::WorkspaceKind::Project,
                status: WorkspaceStatus::Ready,
                agents: vec![falcondeck_core::WorkspaceAgentSummary {
                    provider: AgentProvider::CLAUDE,
                    label: "Claude".to_string(),
                    account: falcondeck_core::AccountSummary::default(),
                    models: Vec::new(),
                    collaboration_modes: Vec::new(),
                    skills: Vec::new(),
                    capabilities: falcondeck_core::AgentCapabilitySummary::claude(),
                }],
                skills: Vec::new(),
                default_provider: AgentProvider::CLAUDE,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: None,
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: Some(runtime),
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: HashMap::new(),
        },
    );
    let mut events = app.subscribe();

    super::workspace_ops::refresh_metadata_after_harness_upgrade(&app, "claude").await;

    let snapshot = app.snapshot().await;
    let claude = snapshot.workspaces[0]
        .agents
        .iter()
        .find(|agent| agent.provider == AgentProvider::CLAUDE)
        .unwrap();
    assert!(!claude.models.is_empty());
    let event = tokio::time::timeout(TokioDuration::from_secs(1), events.recv())
        .await
        .expect("metadata refresh should publish an event")
        .expect("event channel should remain open");
    assert!(matches!(event.event, UnifiedEvent::Snapshot { .. }));
}

use super::{
    AppState, MAX_EXTENSION_THREAD_SUMMARIES, MAX_EXTENSION_THREAD_SUMMARY_BYTES,
    PersistedAppState, PersistedRemoteSecrets, PersistedRemoteState,
    bound_extension_thread_summaries, claude_prompt_from_inputs, codex_inputs,
    conversation_helpers::{
        ToolSettlement, codex_artifact_conversation_item, is_known_tool_item,
        synthesize_tool_title, tool_display_metadata, unsupported_conversation_item,
    },
    encode_base64, notification_timestamp,
    notifications::{
        codex_guardian_review_conversation_item, codex_thread_status, ingest_notification,
        parse_realtime_audio_chunk, parse_thread_token_usage, realtime_conversation_item,
    },
    should_surface_tool_item, workspace_status_after_account_update,
};

#[cfg(unix)]
#[tokio::test]
async fn create_chat_returns_placeholder_while_provider_bootstraps() {
    let temp = tempdir().unwrap();
    let hanging_provider = temp.path().join("slow-codex");
    std::fs::write(&hanging_provider, "#!/bin/sh\nsleep 5\n").unwrap();
    let mut permissions = std::fs::metadata(&hanging_provider).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&hanging_provider, permissions).unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::from([(
            AgentProvider::CODEX,
            hanging_provider.to_string_lossy().to_string(),
        )]),
        temp.path().join("state.json"),
    );
    let chat_path = temp
        .path()
        .join("Documents/FalconDeck/2026-08-25/chat-120000-test");

    let summary = tokio::time::timeout(
        TokioDuration::from_millis(500),
        super::workspace_ops::create_chat_at(&app, chat_path),
    )
    .await
    .expect("chat creation should not wait for provider bootstrap")
    .unwrap();

    assert_eq!(summary.status, WorkspaceStatus::Connecting);
}

#[cfg(unix)]
#[tokio::test]
async fn connect_workspace_returns_placeholder_while_provider_bootstraps() {
    let temp = tempdir().unwrap();
    let hanging_provider = temp.path().join("slow-codex");
    let launch_log = temp.path().join("launches.log");
    std::fs::write(
        &hanging_provider,
        format!(
            "#!/bin/sh\nprintf 'launch\\n' >> \"{}\"\nsleep 5\n",
            launch_log.display()
        ),
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&hanging_provider).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&hanging_provider, permissions).unwrap();
    let workspace_path = temp.path().join("project");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::from([(
            AgentProvider::CODEX,
            hanging_provider.to_string_lossy().to_string(),
        )]),
        temp.path().join("state.json"),
    );

    let connect = || {
        tokio::time::timeout(
            TokioDuration::from_millis(500),
            app.connect_workspace(falcondeck_core::ConnectWorkspaceRequest {
                path: workspace_path.to_string_lossy().to_string(),
                kind: falcondeck_core::WorkspaceKind::Project,
            }),
        )
    };
    let (first, second) = tokio::join!(connect(), connect());
    let first = first
        .expect("workspace connect should not wait for provider bootstrap")
        .unwrap();
    let second = second
        .expect("concurrent connect should reuse the placeholder")
        .unwrap();

    assert_eq!(first.status, WorkspaceStatus::Connecting);
    assert_eq!(second.id, first.id);
    tokio::time::timeout(TokioDuration::from_secs(5), async {
        while !tokio::fs::try_exists(&launch_log).await.unwrap_or(false) {
            sleep(TokioDuration::from_millis(25)).await;
        }
    })
    .await
    .expect("provider bootstrap should start");
    // If the path gate is missing, both spawned connect tasks reach the
    // provider at nearly the same time. Give that duplicate time to append.
    sleep(TokioDuration::from_millis(250)).await;
    let launches = tokio::fs::read_to_string(&launch_log).await.unwrap();
    assert_eq!(launches.lines().count(), 1);
}

#[test]
fn extension_thread_summaries_enforce_count_title_and_byte_limits() {
    let summary = |index: usize, id: String| ExtensionThreadSummary {
        id,
        workspace_id: "workspace-1".to_string(),
        title: "t".repeat(300),
        provider: AgentProvider::CODEX,
        status: ThreadStatus::Idle,
        updated_at: Utc::now() + Duration::seconds(index as i64),
        pending_approval_count: 0,
        pending_question_count: 0,
    };
    let bounded = bound_extension_thread_summaries(
        (0..MAX_EXTENSION_THREAD_SUMMARIES + 5)
            .map(|index| summary(index, format!("thread-{index}")))
            .collect(),
    );
    assert_eq!(bounded.len(), MAX_EXTENSION_THREAD_SUMMARIES);
    assert!(bounded.iter().all(|item| item.title.chars().count() == 256));
    assert_eq!(bounded[0].id, "thread-1004");

    let byte_bounded = bound_extension_thread_summaries(
        (0..MAX_EXTENSION_THREAD_SUMMARIES)
            .map(|index| summary(index, format!("thread-{index}-{}", "x".repeat(3_000))))
            .collect(),
    );
    assert!(byte_bounded.len() < MAX_EXTENSION_THREAD_SUMMARIES);
    assert!(serde_json::to_vec(&byte_bounded).unwrap().len() <= MAX_EXTENSION_THREAD_SUMMARY_BYTES);
}

#[test]
fn maps_codex_thread_status_and_waiting_flags() {
    assert_eq!(
        codex_thread_status(&json!({ "status": { "type": "idle" } })),
        ThreadStatus::Idle,
    );
    assert_eq!(
        codex_thread_status(&json!({ "status": { "type": "active", "activeFlags": [] } })),
        ThreadStatus::Running,
    );
    assert_eq!(
        codex_thread_status(&json!({
            "status": { "type": "active", "activeFlags": ["waitingOnApproval"] }
        })),
        ThreadStatus::WaitingForInput,
    );
    assert_eq!(
        codex_thread_status(&json!({ "status": { "type": "systemError" } })),
        ThreadStatus::Error,
    );
}

#[tokio::test]
async fn retains_keyed_operational_conditions_in_snapshots() {
    let app = AppState::new("test".to_string(), HashMap::new());
    app.upsert_operational_condition(
        "workspace-1".to_string(),
        "provider_deprecation",
        falcondeck_core::ServiceLevel::Warning,
        "Configuration will change".to_string(),
        Some("deprecationNotice".to_string()),
    )
    .expect("upsert condition");

    let snapshot = app.snapshot().await;
    assert!(matches!(
        snapshot.operational_conditions.as_slice(),
        [condition]
            if condition.workspace_id == "workspace-1"
                && condition.key == "provider_deprecation"
                && condition.message == "Configuration will change"
                && condition.source.as_deref() == Some("deprecationNotice")
    ));
}

#[tokio::test]
async fn replaces_repeated_operational_conditions_instead_of_appending() {
    let app = AppState::new("test".to_string(), HashMap::new());
    for message in ["First failure", "Second failure"] {
        app.upsert_operational_condition(
            "workspace-1".to_string(),
            "codex_connection",
            falcondeck_core::ServiceLevel::Error,
            message.to_string(),
            Some("stream-error".to_string()),
        )
        .expect("upsert condition");
    }

    let snapshot = app.snapshot().await;
    assert!(matches!(
        snapshot.operational_conditions.as_slice(),
        [condition] if condition.message == "Second failure"
    ));
}

#[tokio::test]
async fn keeps_mcp_startup_failures_out_of_every_transcript() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;

    for server in ["cloudflare-api", "clarity", "cloudflare-api"] {
        ingest_notification(
            &app,
            "workspace-1",
            "error",
            json!({
                "threadId": "thread-1",
                "message": format!(
                    "{server} failed to start: The {server} MCP server is not logged in."
                ),
            }),
        )
        .await
        .unwrap();
    }

    {
        let workspaces = app.inner.workspaces.lock().await;
        let items = &workspaces["workspace-1"].threads["thread-1"].items;
        assert!(
            !items
                .iter()
                .any(|item| matches!(item, ConversationItem::Service { .. })),
            "connector startup failures must not become transcript items"
        );
    }

    let snapshot = app.snapshot().await;
    let mut keys = snapshot
        .operational_conditions
        .iter()
        .map(|condition| condition.key.as_str())
        .collect::<Vec<_>>();
    keys.sort_unstable();
    assert_eq!(keys, ["mcp_startup:clarity", "mcp_startup:cloudflare-api"]);
    assert!(
        snapshot
            .operational_conditions
            .iter()
            .all(|condition| condition.level == falcondeck_core::ServiceLevel::Warning)
    );
}

#[tokio::test]
async fn removes_operational_condition_after_recovery() {
    let app = AppState::new("test".to_string(), HashMap::new());
    app.upsert_operational_condition(
        "workspace-1".to_string(),
        "codex_connection",
        falcondeck_core::ServiceLevel::Error,
        "Disconnected".to_string(),
        Some("disconnect".to_string()),
    )
    .expect("upsert condition");

    app.clear_operational_condition("workspace-1", "codex_connection");

    assert!(app.snapshot().await.operational_conditions.is_empty());
}

#[test]
fn parses_codex_thread_token_usage_without_losing_cached_or_reasoning_counts() {
    let usage = parse_thread_token_usage(&json!({
        "threadId": "thread-1",
        "turnId": "turn-1",
        "tokenUsage": {
            "total": {
                "totalTokens": 92_000,
                "inputTokens": 80_000,
                "cachedInputTokens": 50_000,
                "outputTokens": 10_000,
                "reasoningOutputTokens": 2_000
            },
            "last": {
                "totalTokens": 5_000,
                "inputTokens": 4_000,
                "cachedInputTokens": 2_500,
                "outputTokens": 800,
                "reasoningOutputTokens": 200
            },
            "modelContextWindow": 128_000
        }
    }))
    .expect("token usage");

    assert_eq!(usage.total.total_tokens, 92_000);
    assert_eq!(usage.total.cached_input_tokens, 50_000);
    assert_eq!(usage.total.reasoning_output_tokens, 2_000);
    assert_eq!(usage.last.expect("last usage").output_tokens, 800);
    assert_eq!(usage.model_context_window, Some(128_000));
}

#[tokio::test]
async fn retains_nested_codex_turn_id_for_steering() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;

    ingest_notification(
        &app,
        "workspace-1",
        "turn/started",
        json!({
            "threadId": "thread-1",
            "turn": { "id": "019ff062-2a41-78c1-a21c-5ac71ff08574" }
        }),
    )
    .await
    .unwrap();

    let summary = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_eq!(
        summary.latest_turn_id.as_deref(),
        Some("019ff062-2a41-78c1-a21c-5ac71ff08574")
    );
}

#[tokio::test]
async fn retains_streamed_realtime_assistant_and_final_user_transcripts() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;

    for delta in ["Hello ", "from voice"] {
        ingest_notification(
            &app,
            "workspace-1",
            "thread/realtime/transcript/delta",
            json!({ "threadId": "thread-1", "role": "assistant", "delta": delta }),
        )
        .await
        .unwrap();
    }
    ingest_notification(
        &app,
        "workspace-1",
        "thread/realtime/transcript/done",
        json!({
            "threadId": "thread-1",
            "role": "assistant",
            "text": "Hello from voice"
        }),
    )
    .await
    .unwrap();
    ingest_notification(
        &app,
        "workspace-1",
        "thread/realtime/transcript/delta",
        json!({ "threadId": "thread-1", "role": "user", "delta": "Ship it" }),
    )
    .await
    .unwrap();
    ingest_notification(
        &app,
        "workspace-1",
        "thread/realtime/transcript/done",
        json!({ "threadId": "thread-1", "role": "user", "text": "Ship it" }),
    )
    .await
    .unwrap();

    let workspaces = app.inner.workspaces.lock().await;
    let items = &workspaces["workspace-1"].threads["thread-1"].items;
    assert!(matches!(
        &items[0],
        ConversationItem::AssistantMessage { text, lifecycle, .. }
            if text == "Hello from voice" && *lifecycle == ContentLifecycle::Complete
    ));
    assert!(matches!(
        &items[1],
        ConversationItem::UserMessage { text, attachments, .. }
            if text == "Ship it" && attachments.is_empty()
    ));
}

#[tokio::test]
async fn preserves_context_compaction_lifecycle_without_tool_events() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;
    let mut events = app.subscribe();

    ingest_notification(
        &app,
        "workspace-1",
        "item/started",
        json!({
            "threadId": "thread-1",
            "timestamp": "2026-08-09T10:00:00Z",
            "item": { "id": "compact-1", "type": "contextCompaction" }
        }),
    )
    .await
    .unwrap();
    ingest_notification(
        &app,
        "workspace-1",
        "item/completed",
        json!({
            "threadId": "thread-1",
            "timestamp": "2026-08-09T10:00:02Z",
            "item": { "id": "compact-1", "type": "contextCompaction" }
        }),
    )
    .await
    .unwrap();

    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert!(emitted.iter().any(|envelope| matches!(
        &envelope.event,
        falcondeck_core::UnifiedEvent::ConversationItemAdded {
            item: ConversationItem::ContextCompaction {
                lifecycle: falcondeck_core::ToolLifecycle::Running,
                ..
            }
        }
    )));
    assert!(emitted.iter().any(|envelope| matches!(
        &envelope.event,
        falcondeck_core::UnifiedEvent::ConversationItemUpdated {
            item: ConversationItem::ContextCompaction {
                lifecycle: falcondeck_core::ToolLifecycle::Succeeded,
                ..
            }
        }
    )));
    assert!(!emitted.iter().any(|envelope| matches!(
        envelope.event,
        falcondeck_core::UnifiedEvent::ToolCallStart { .. }
            | falcondeck_core::UnifiedEvent::ToolCallEnd { .. }
    )));

    let workspaces = app.inner.workspaces.lock().await;
    assert!(matches!(
        workspaces["workspace-1"].threads["thread-1"].items.as_slice(),
        [ConversationItem::ContextCompaction {
            lifecycle: falcondeck_core::ToolLifecycle::Succeeded,
            created_at,
            completed_at: Some(completed_at),
            ..
        }] if created_at.to_rfc3339() == "2026-08-09T10:00:00+00:00"
            && completed_at.to_rfc3339() == "2026-08-09T10:00:02+00:00"
    ));
}

#[tokio::test]
async fn preserves_live_reasoning_content_and_derives_duration() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;

    ingest_notification(
        &app,
        "workspace-1",
        "item/started",
        json!({
            "threadId": "thread-1",
            "timestamp": "2026-08-09T10:00:00Z",
            "item": {
                "id": "reasoning-1",
                "type": "reasoning",
                "status": "inProgress",
                "summary": ["Inspecting the renderer"],
                "content": ["Reading the current implementation"]
            }
        }),
    )
    .await
    .unwrap();
    ingest_notification(
        &app,
        "workspace-1",
        "item/completed",
        json!({
            "threadId": "thread-1",
            "timestamp": "2026-08-09T10:00:02.500Z",
            "item": {
                "id": "reasoning-1",
                "type": "reasoning",
                "status": "completed"
            }
        }),
    )
    .await
    .unwrap();

    let workspaces = app.inner.workspaces.lock().await;
    assert!(matches!(
        workspaces["workspace-1"].threads["thread-1"].items.as_slice(),
        [ConversationItem::Reasoning {
            summary: Some(summary),
            content,
            lifecycle: ContentLifecycle::Complete,
            duration_ms: Some(2500),
            created_at,
            ..
        }] if summary == "Inspecting the renderer"
            && content == "Reading the current implementation"
            && created_at.to_rfc3339() == "2026-08-09T10:00:00+00:00"
    ));
}

#[tokio::test]
async fn preserves_artifact_lifecycle_without_tool_events() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;
    let mut events = app.subscribe();

    ingest_notification(
        &app,
        "workspace-1",
        "item/started",
        json!({
            "threadId": "thread-1",
            "timestamp": "2026-08-09T10:00:00Z",
            "item": { "id": "future-1", "type": "artifactPreview", "status": "inProgress" }
        }),
    )
    .await
    .unwrap();
    ingest_notification(
        &app,
        "workspace-1",
        "item/completed",
        json!({
            "threadId": "thread-1",
            "timestamp": "2026-08-09T10:00:02Z",
            "item": {
                "id": "future-1",
                "type": "artifactPreview",
                "status": "completed",
                "artifact": { "title": "Prototype" }
            }
        }),
    )
    .await
    .unwrap();

    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert!(!emitted.iter().any(|envelope| matches!(
        envelope.event,
        falcondeck_core::UnifiedEvent::ToolCallStart { .. }
            | falcondeck_core::UnifiedEvent::ToolCallEnd { .. }
    )));

    let workspaces = app.inner.workspaces.lock().await;
    assert!(matches!(
        workspaces["workspace-1"].threads["thread-1"].items.as_slice(),
        [ConversationItem::Artifact {
            artifact,
            lifecycle: ContentLifecycle::Complete,
            created_at,
            ..
        }] if created_at.to_rfc3339() == "2026-08-09T10:00:00+00:00"
            && artifact.title == "Prototype"
            && artifact.payload.pointer("/title") == Some(&json!("Prototype"))
    ));
}

#[tokio::test]
async fn preserves_code_review_subject_and_findings_across_live_replacement() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;
    let mut events = app.subscribe();

    for (method, timestamp, item) in [
        (
            "item/started",
            "2026-08-09T10:00:00Z",
            json!({ "id": "review-1", "type": "enteredReviewMode", "review": "current changes" }),
        ),
        (
            "item/started",
            "2026-08-09T10:00:02Z",
            json!({ "id": "review-1", "type": "exitedReviewMode", "review": "## Findings\n\n- Fix the race." }),
        ),
        (
            "item/completed",
            "2026-08-09T10:00:03Z",
            json!({ "id": "review-1", "type": "exitedReviewMode", "review": "## Findings\n\n- Fix the race." }),
        ),
    ] {
        ingest_notification(
            &app,
            "workspace-1",
            method,
            json!({ "threadId": "thread-1", "timestamp": timestamp, "item": item }),
        )
        .await
        .unwrap();
    }

    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert!(!emitted.iter().any(|envelope| matches!(
        envelope.event,
        falcondeck_core::UnifiedEvent::ToolCallStart { .. }
            | falcondeck_core::UnifiedEvent::ToolCallEnd { .. }
    )));
    let workspaces = app.inner.workspaces.lock().await;
    assert!(matches!(
        workspaces["workspace-1"].threads["thread-1"].items.as_slice(),
        [ConversationItem::CodeReview {
            subject: Some(subject),
            content,
            lifecycle: ContentLifecycle::Complete,
            created_at,
            ..
        }] if subject == "current changes"
            && content == "## Findings\n\n- Fix the race."
            && created_at.to_rfc3339() == "2026-08-09T10:00:00+00:00"
    ));
}

#[tokio::test]
async fn emits_bounded_realtime_audio_lifecycle_without_retaining_pcm() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;
    let mut events = app.subscribe();

    ingest_notification(
        &app,
        "workspace-1",
        "thread/realtime/started",
        json!({
            "threadId": "thread-1",
            "realtimeSessionId": "voice-1",
            "version": "v2"
        }),
    )
    .await
    .unwrap();
    ingest_notification(
        &app,
        "workspace-1",
        "thread/realtime/outputAudio/delta",
        json!({
            "threadId": "thread-1",
            "audio": {
                "itemId": "item-1",
                "data": "AAA=",
                "sampleRate": 24_000,
                "numChannels": 1,
                "samplesPerChannel": 1
            }
        }),
    )
    .await
    .unwrap();
    ingest_notification(
        &app,
        "workspace-1",
        "thread/realtime/closed",
        json!({ "threadId": "thread-1", "reason": null }),
    )
    .await
    .unwrap();

    assert!(matches!(
        events.recv().await.unwrap().event.clone(),
        falcondeck_core::UnifiedEvent::RealtimeAudioStarted { session_id }
            if session_id.as_deref() == Some("voice-1")
    ));
    assert!(matches!(
        events.recv().await.unwrap().event.clone(),
        falcondeck_core::UnifiedEvent::RealtimeAudioDelta { audio }
            if audio.item_id.as_deref() == Some("item-1")
                && audio.sample_rate == 24_000
                && audio.num_channels == 1
                && audio.samples_per_channel == Some(1)
    ));
    assert!(matches!(
        events.recv().await.unwrap().event.clone(),
        falcondeck_core::UnifiedEvent::RealtimeAudioEnded {
            reason: None,
            interrupted: false
        }
    ));

    let snapshot = app.snapshot().await;
    assert!(snapshot.service_notices.iter().all(|notice| {
        notice.raw_method.as_deref() != Some("thread/realtime/outputAudio/delta")
    }));
}

#[test]
fn rejects_invalid_realtime_audio_metadata() {
    assert!(
        parse_realtime_audio_chunk(&json!({
            "audio": { "data": "AAA=", "sampleRate": 0, "numChannels": 1 }
        }))
        .is_none()
    );
    assert!(
        parse_realtime_audio_chunk(&json!({
            "audio": { "data": "AAA=", "sampleRate": 24_000, "numChannels": 0 }
        }))
        .is_none()
    );
}

#[test]
fn projects_and_bounds_unstable_realtime_items() {
    let handoff = realtime_conversation_item(&json!({
        "id": "handoff-1",
        "type": "handoff_request",
        "message": "Please continue this request in Codex."
    }));
    assert_eq!(handoff.id, "handoff-1");
    assert_eq!(handoff.title, "Voice handoff requested");
    assert_eq!(
        handoff.summary.as_deref(),
        Some("Please continue this request in Codex.")
    );

    let oversized = realtime_conversation_item(&json!({
        "type": "future_event",
        "data": "x".repeat(70 * 1024)
    }));
    assert_eq!(oversized.payload.get("truncated"), Some(&json!(true)));
}

#[test]
fn bounds_unsupported_provider_item_payloads() {
    let item = unsupported_conversation_item(
        &json!({
            "id": "future-oversized",
            "type": "futureEvent",
            "data": "x".repeat(70 * 1024)
        }),
        Utc::now(),
        ContentLifecycle::Complete,
    )
    .unwrap();

    assert!(matches!(
        item,
        ConversationItem::Unsupported { payload, .. }
            if payload.get("truncated") == Some(&json!(true))
    ));
}

#[test]
fn bounds_provider_artifact_payloads() {
    let item = codex_artifact_conversation_item(
        &json!({
            "id": "artifact-oversized",
            "type": "artifactPreview",
            "artifact": { "title": "Prototype", "content": "x".repeat(70 * 1024) }
        }),
        Utc::now(),
        ContentLifecycle::Complete,
    )
    .unwrap();

    assert!(matches!(
        item,
        ConversationItem::Artifact { artifact, .. }
            if artifact.content.is_none()
                && artifact.payload.get("truncated") == Some(&json!(true))
    ));
}

#[test]
fn maps_guardian_review_lifecycle_and_structured_rationale() {
    let item = codex_guardian_review_conversation_item(&json!({
        "threadId": "thread-1",
        "turnId": "turn-1",
        "startedAtMs": 1_781_000_000_000_i64,
        "completedAtMs": 1_781_000_000_125_i64,
        "reviewId": "review-7",
        "targetItemId": "command-4",
        "decisionSource": "agent",
        "review": {
            "status": "denied",
            "riskLevel": "high",
            "userAuthorization": "low",
            "rationale": "The command would overwrite production data."
        },
        "action": {
            "type": "command",
            "source": "shell",
            "command": "deploy --force",
            "cwd": "/workspace"
        }
    }))
    .expect("guardian review");

    let ConversationItem::ToolCall {
        id, status, detail, ..
    } = item
    else {
        panic!("expected guardian review tool call");
    };
    assert!(id == "guardian-review-review-7" && status == "denied");
    assert!(matches!(
        detail.as_deref(),
        Some(ToolCallDetail::GuardianReview {
                action,
                action_kind,
                target_item_id: Some(target_item_id),
                status: review_status,
                risk_level: Some(risk),
                user_authorization: Some(user_authorization),
                rationale: Some(rationale),
                decision_source: Some(decision_source),
                duration_ms: Some(125),
                ..
            }) if action == "deploy --force"
            && action_kind == "command"
            && target_item_id == "command-4"
            && review_status == "denied"
            && risk == "high"
            && user_authorization == "low"
            && rationale.contains("overwrite production")
            && decision_source == "agent"
    ));
}

#[test]
fn maps_every_guardian_review_terminal_state_without_losing_identity() {
    for (review_status, tool_status) in [
        ("inProgress", "running"),
        ("approved", "completed"),
        ("denied", "denied"),
        ("timedOut", "interrupted"),
        ("aborted", "interrupted"),
    ] {
        let item = codex_guardian_review_conversation_item(&json!({
            "reviewId": "stable-review",
            "review": { "status": review_status },
            "action": { "type": "networkAccess", "url": "https://example.com" }
        }))
        .expect("guardian review state");

        assert!(matches!(
            item,
            ConversationItem::ToolCall {
                id,
                status,
                detail: Some(detail),
                ..
            } if id == "guardian-review-stable-review"
                && status == tool_status
                && matches!(
                    detail.as_ref(),
                    ToolCallDetail::GuardianReview {
                        review_id,
                        status,
                        ..
                    } if review_id == "stable-review" && status == review_status
                )
        ));
    }
}

#[test]
fn parses_thread_goal_notifications() {
    let goal = crate::codex::parse_thread_goal(&json!({
        "threadId": "thread-1",
        "goal": {
            "objective": "Ship the release",
            "status": "active",
            "tokenBudget": 500000,
            "tokensUsed": 12000,
            "timeUsedSeconds": 90,
            "createdAt": 1,
            "updatedAt": 2
        }
    }))
    .expect("goal");
    assert_eq!(goal.objective, "Ship the release");
    assert_eq!(goal.status, "active");
    assert_eq!(goal.token_budget, Some(500000));
    assert_eq!(goal.tokens_used, Some(12000));
    // The provider never reports a start time; the daemon stamps it.
    assert_eq!(goal.started_at, None);
    assert!(crate::codex::parse_thread_goal(&json!({ "threadId": "t" })).is_none());
}

#[test]
fn maps_sandbox_modes_to_codex_policy_payloads() {
    use super::workspace_ops::sandbox_policy_payload;
    assert_eq!(
        sandbox_policy_payload(Some("read-only"), None),
        json!({ "type": "readOnly" })
    );
    assert_eq!(
        sandbox_policy_payload(Some("workspace-write"), None),
        json!({ "type": "workspaceWrite" })
    );
    assert_eq!(
        sandbox_policy_payload(
            Some("workspace-write"),
            Some("/Users/test/Documents/FalconDeck")
        ),
        json!({
            "type": "workspaceWrite",
            "writableRoots": ["/Users/test/Documents/FalconDeck"]
        })
    );
    assert_eq!(
        sandbox_policy_payload(Some("danger-full-access"), None),
        json!({ "type": "dangerFullAccess" })
    );
    assert_eq!(sandbox_policy_payload(None, None), serde_json::Value::Null);
    assert_eq!(
        sandbox_policy_payload(Some("bogus"), None),
        serde_json::Value::Null
    );
}

#[test]
fn recognizes_only_managed_casual_chat_paths() {
    assert_eq!(
        super::workspace_kind_for_path(
            "/Users/test/Documents/FalconDeck/2026-08-24/chat-120000-abcdef"
        ),
        falcondeck_core::WorkspaceKind::Casual
    );
    assert_eq!(
        super::workspace_kind_for_path("/Users/test/Documents/FalconDeck/my-project"),
        falcondeck_core::WorkspaceKind::Project
    );
    assert_eq!(
        super::workspace_kind_for_path("/tmp/2026-08-24/chat-120000-abcdef"),
        falcondeck_core::WorkspaceKind::Project
    );
}

#[test]
fn codex_approval_responses_match_app_server_protocol() {
    use falcondeck_core::ApprovalDecision;

    use super::workspace_ops::codex_approval_response;

    // Command/file-change approvals use the decision enum — Codex rejects
    // anything else as a decline.
    let no_params = serde_json::Value::Null;
    assert_eq!(
        codex_approval_response(
            "item/commandExecution/requestApproval",
            &no_params,
            &ApprovalDecision::Allow
        ),
        json!({ "decision": "accept" })
    );
    assert_eq!(
        codex_approval_response(
            "item/fileChange/requestApproval",
            &no_params,
            &ApprovalDecision::AlwaysAllow
        ),
        json!({ "decision": "acceptForSession" })
    );
    assert_eq!(
        codex_approval_response(
            "item/commandExecution/requestApproval",
            &no_params,
            &ApprovalDecision::Deny
        ),
        json!({ "decision": "decline" })
    );
    assert_eq!(
        codex_approval_response(
            "item/commandExecution/requestApproval",
            &json!({ "availableDecisions": ["cancel"] }),
            &ApprovalDecision::Deny
        ),
        json!({ "decision": "cancel" })
    );

    // Permission approvals echo the requested profile back as the grant.
    let params = json!({
        "permissions": { "network": { "enabled": true } },
        "reason": "push to GitHub"
    });
    assert_eq!(
        codex_approval_response(
            "permissions/requestApproval",
            &params,
            &ApprovalDecision::Allow
        ),
        json!({
            "permissions": { "network": { "enabled": true } },
            "scope": "turn"
        })
    );
    assert_eq!(
        codex_approval_response(
            "permissions/requestApproval",
            &params,
            &ApprovalDecision::AlwaysAllow
        ),
        json!({
            "permissions": { "network": { "enabled": true } },
            "scope": "session"
        })
    );
    assert_eq!(
        codex_approval_response(
            "permissions/requestApproval",
            &params,
            &ApprovalDecision::Deny
        ),
        json!({ "permissions": {} })
    );
}

#[test]
fn review_targets_serialize_to_tagged_protocol_objects() {
    use falcondeck_core::ReviewTarget;
    assert_eq!(
        serde_json::to_value(ReviewTarget::UncommittedChanges).unwrap(),
        json!({ "type": "uncommittedChanges" })
    );
    assert_eq!(
        serde_json::to_value(ReviewTarget::BaseBranch {
            branch: "main".to_string()
        })
        .unwrap(),
        json!({ "type": "baseBranch", "branch": "main" })
    );
    assert_eq!(
        serde_json::to_value(ReviewTarget::Commit {
            sha: "abc123".to_string()
        })
        .unwrap(),
        json!({ "type": "commit", "sha": "abc123" })
    );
}

#[test]
fn filters_internal_codex_item_kinds_from_tool_timeline() {
    assert!(!should_surface_tool_item("userMessage"));
    assert!(!should_surface_tool_item("agentMessage"));
    assert!(!should_surface_tool_item("reasoning"));
    assert!(should_surface_tool_item("commandExecution"));
    assert!(is_known_tool_item("commandExecution"));
    assert!(!is_known_tool_item("artifactPreview"));
}

#[test]
fn encodes_local_images_for_codex() {
    let payload = codex_inputs(
        &[TurnInputItem::Image(ImageInput {
            id: "img-1".to_string(),
            name: Some("diagram.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: "ignored".to_string(),
            local_path: Some("/tmp/diagram.png".to_string()),
        })],
        &[],
    );
    assert_eq!(
        payload,
        vec![json!({
            "type": "localImage",
            "path": "/tmp/diagram.png"
        })]
    );
}

#[test]
fn claude_prompt_excludes_image_inputs() {
    // Images are embedded via the stream-json stdin payload, not the prompt.
    let prompt = claude_prompt_from_inputs(
        &[
            TurnInputItem::Text {
                id: None,
                text: "describe this".to_string(),
            },
            TurnInputItem::Image(ImageInput {
                id: "img-1".to_string(),
                name: Some("diagram.png".to_string()),
                mime_type: Some("image/png".to_string()),
                url: "data:image/png;base64,aGVsbG8=".to_string(),
                local_path: None,
            }),
        ],
        &[],
    );

    assert_eq!(prompt, "describe this");
}

#[test]
fn account_updates_do_not_clobber_runtime_status() {
    assert_eq!(
        workspace_status_after_account_update(
            &WorkspaceStatus::Busy,
            &falcondeck_core::AccountStatus::Ready,
        ),
        WorkspaceStatus::Busy
    );
    assert_eq!(
        workspace_status_after_account_update(
            &WorkspaceStatus::NeedsAuth,
            &falcondeck_core::AccountStatus::Ready,
        ),
        WorkspaceStatus::Ready
    );
    assert_eq!(
        workspace_status_after_account_update(
            &WorkspaceStatus::Error,
            &falcondeck_core::AccountStatus::NeedsAuth,
        ),
        WorkspaceStatus::NeedsAuth
    );
    assert_eq!(
        workspace_status_after_account_update(
            &WorkspaceStatus::Disconnected,
            &falcondeck_core::AccountStatus::Ready,
        ),
        WorkspaceStatus::Ready
    );
    assert_eq!(
        workspace_status_after_account_update(
            &WorkspaceStatus::Connecting,
            &falcondeck_core::AccountStatus::Ready,
        ),
        WorkspaceStatus::Ready
    );
}

#[test]
fn uses_notification_timestamps_when_available() {
    let timestamp = notification_timestamp(
        "turn/completed",
        &json!({
            "timestamp": "2026-03-18T10:15:30Z",
            "completedAt": "2026-03-18T10:15:29Z"
        }),
    )
    .expect("notification timestamp");
    assert_eq!(timestamp.to_rfc3339(), "2026-03-18T10:15:30+00:00");

    let fallback = notification_timestamp(
        "turn/completed",
        &json!({
            "completedAt": "2026-03-18T10:15:29Z"
        }),
    )
    .expect("fallback timestamp");
    assert_eq!(fallback.to_rfc3339(), "2026-03-18T10:15:29+00:00");
}

#[tokio::test]
async fn retries_codex_unavailable_error_dumps() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "codex-thread-1",
        temp_dir.path(),
    )
    .await;
    {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces.get_mut("workspace-1").unwrap();
        workspace.summary.default_provider = AgentProvider::CODEX;
        let thread = workspace.threads.get_mut("thread-1").unwrap();
        thread.summary.provider = AgentProvider::CODEX;
        thread.summary.status = ThreadStatus::Running;
    }

    ingest_notification(
        &app,
        "workspace-1",
        "item/completed",
        json!({
            "threadId": "thread-1",
            "item": {
                "id": "assistant-unavailable",
                "type": "agentMessage",
                "text": "Error: RetriableError: [unavailable] Error"
            }
        }),
    )
    .await
    .unwrap();
    ingest_notification(
        &app,
        "workspace-1",
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "status": "completed"
        }),
    )
    .await
    .unwrap();

    let workspaces = app.inner.workspaces.lock().await;
    let thread = &workspaces["workspace-1"].threads["thread-1"];
    assert_eq!(thread.summary.status, ThreadStatus::Running);
    assert_eq!(thread.summary.last_error, None);
    assert_eq!(thread.transient_retry_attempts, 1);
    assert!(thread.transient_retry_in_flight);
    assert!(matches!(
        thread.items.iter().find(|item| matches!(
            item,
            ConversationItem::AssistantMessage { id, .. } if id == "assistant-unavailable"
        )),
        Some(ConversationItem::AssistantMessage {
            lifecycle: ContentLifecycle::Error,
            text,
            error,
            ..
        }) if text.is_empty()
            && error.as_deref()
                == Some(super::conversation_helpers::TRANSIENT_PROVIDER_ERROR_MESSAGE)
    ));
    assert!(thread.items.iter().any(|item| matches!(
        item,
        ConversationItem::Service { message, .. }
            if message == "Codex was temporarily unavailable. Retrying…"
    )));
    drop(workspaces);

    for attempt in 2..=4 {
        ingest_notification(
            &app,
            "workspace-1",
            "item/completed",
            json!({
                "threadId": "thread-1",
                "item": {
                    "id": format!("assistant-unavailable-{attempt}"),
                    "type": "agentMessage",
                    "text": "Error: RetriableError: [unavailable] Error"
                }
            }),
        )
        .await
        .unwrap();
        ingest_notification(
            &app,
            "workspace-1",
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turnId": format!("turn-{attempt}"),
                "status": "failed",
                "error": { "message": "RetriableError: [unavailable] Error" }
            }),
        )
        .await
        .unwrap();
    }

    let workspaces = app.inner.workspaces.lock().await;
    let thread = &workspaces["workspace-1"].threads["thread-1"];
    assert_eq!(thread.summary.status, ThreadStatus::Error);
    assert_eq!(
        thread.summary.last_error.as_deref(),
        Some(super::conversation_helpers::TRANSIENT_PROVIDER_ERROR_MESSAGE)
    );
    assert!(!thread.transient_retry_in_flight);
    assert_eq!(thread.transient_retry_attempts, 3);
}

#[tokio::test]
async fn terminal_turn_cancels_orphaned_interactive_requests() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;
    let created_at = Utc::now();
    let request = InteractiveRequest {
        request_id: "orphaned-request".to_string(),
        workspace_id: "workspace-1".to_string(),
        thread_id: Some("thread-1".to_string()),
        method: "item/commandExecution/requestApproval".to_string(),
        kind: InteractiveRequestKind::Approval,
        approval_decisions: None,
        title: "Allow deployment?".to_string(),
        detail: None,
        command: Some("deploy".to_string()),
        path: None,
        turn_id: Some("turn-1".to_string()),
        item_id: Some("tool-1".to_string()),
        questions: Vec::new(),
        created_at,
    };
    app.inner.interactive_requests.lock().await.insert(
        ("workspace-1".to_string(), request.request_id.clone()),
        super::PendingServerRequest {
            raw_id: json!("raw-request"),
            request: request.clone(),
            params: Value::Null,
        },
    );
    app.push_conversation_item(
        "workspace-1",
        "thread-1",
        ConversationItem::InteractiveRequest {
            id: request.request_id.clone(),
            request: Box::new(request),
            created_at,
            resolved: false,
            resolution: None,
        },
        false,
    )
    .await
    .unwrap();

    let mut events = app.subscribe();
    let settled_at = created_at + Duration::seconds(3);
    app.settle_turn_items_with_error(
        "workspace-1",
        "thread-1",
        settled_at,
        ToolSettlement::Failed,
        None,
    )
    .await;

    assert!(app.snapshot().await.interactive_requests.is_empty());
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert!(emitted.iter().any(|envelope| matches!(
        &envelope.event,
        falcondeck_core::UnifiedEvent::ConversationItemUpdated {
            item: ConversationItem::InteractiveRequest {
                resolved: true,
                resolution: Some(resolution),
                ..
            },
        } if resolution.outcome == InteractiveRequestOutcome::Cancelled
    )));
    assert!(emitted.iter().any(|envelope| matches!(
        &envelope.event,
        falcondeck_core::UnifiedEvent::Snapshot { snapshot }
            if snapshot.interactive_requests.is_empty()
    )));
    let workspaces = app.inner.workspaces.lock().await;
    assert!(matches!(
        workspaces["workspace-1"].threads["thread-1"].items.as_slice(),
        [ConversationItem::InteractiveRequest {
            resolved: true,
            resolution: Some(resolution),
            ..
        }] if resolution.outcome == InteractiveRequestOutcome::Cancelled
            && resolution.resolved_at == settled_at
    ));
}

#[tokio::test]
async fn terminal_turn_emits_and_retains_an_empty_interrupted_receipt() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;
    let created_at = Utc::now();
    app.push_conversation_item(
        "workspace-1",
        "thread-1",
        ConversationItem::UserMessage {
            id: "user-before-stop".to_string(),
            text: "Start, then stop".to_string(),
            attachments: Vec::new(),
            turn_id: None,
            previous_turn_id: None,
            created_at,
        },
        false,
    )
    .await
    .unwrap();

    let mut events = app.subscribe();
    let settled_at = created_at + Duration::seconds(1);
    app.settle_turn_items_with_error(
        "workspace-1",
        "thread-1",
        settled_at,
        ToolSettlement::Interrupted,
        None,
    )
    .await;

    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert!(emitted.iter().any(|envelope| matches!(
        &envelope.event,
        falcondeck_core::UnifiedEvent::ConversationItemAdded {
            item: ConversationItem::AssistantMessage {
                id,
                text,
                lifecycle: ContentLifecycle::Interrupted,
                ..
            },
        } if id == "falcondeck-turn-receipt-user-before-stop" && text.is_empty()
    )));

    let workspaces = app.inner.workspaces.lock().await;
    assert!(matches!(
        workspaces["workspace-1"].threads["thread-1"].items.as_slice(),
        [
            ConversationItem::UserMessage { .. },
            ConversationItem::AssistantMessage {
                id,
                lifecycle: ContentLifecycle::Interrupted,
                ..
            },
        ] if id == "falcondeck-turn-receipt-user-before-stop"
    ));
}

#[test]
fn extracts_nested_claude_stream_text_and_result_payloads() {
    assert_eq!(
        super::extract_claude_text_chunk(&json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": {
                    "type": "text_delta",
                    "text": "hi"
                }
            }
        }))
        .map(|chunk| chunk.text),
        Some("hi".to_string())
    );

    assert_eq!(
        super::extract_claude_text_chunk(&json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "text", "text": "hello" }
                ]
            }
        }))
        .map(|chunk| chunk.text),
        Some("hello".to_string())
    );

    assert_eq!(
        super::extract_claude_text_chunk(&json!({
            "type": "result",
            "subtype": "success",
            "result": "done"
        }))
        .map(|chunk| chunk.text),
        Some("done".to_string())
    );
}

#[test]
fn error_results_are_not_treated_as_assistant_text() {
    assert_eq!(
        super::extract_claude_text_chunk(&json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "Something broke"
        }))
        .map(|chunk| chunk.text),
        None
    );
}

#[test]
fn merging_claude_text_ignores_repeated_final_result_echo() {
    // Deltas accumulate two messages; the final `result` event repeats the
    // last message and must not be appended a second time.
    let merged = super::merge_claude_assistant_text("First part.Second part.", "Second part.");
    assert_eq!(merged, "First part.Second part.");
    // Genuinely new text still appends.
    let appended = super::merge_claude_assistant_text("First part.", "Second part.");
    assert_eq!(appended, "First part.\n\nSecond part.");
}

#[test]
fn streamed_token_deltas_concatenate_verbatim() {
    // Token deltas carry their own whitespace. Trimming them and re-joining
    // with a separator produced "I 'll survey" / "Refacto ring done".
    let deltas = ["I", "'ll", " survey", " the", " codebase", "."];
    let mut text = String::new();
    for delta in deltas {
        let chunk = super::extract_claude_text_chunk(&json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": delta }
            }
        }))
        .expect("delta chunk");
        assert!(
            chunk.is_delta,
            "content_block_delta must be treated as a delta"
        );
        text = super::append_claude_text_delta(&text, &chunk.text);
    }
    assert_eq!(text, "I'll survey the codebase.");

    // The full-message echo that follows the deltas must dedupe, not duplicate.
    let echo = super::extract_claude_text_chunk(&json!({
        "type": "assistant",
        "message": { "content": [{ "type": "text", "text": "I'll survey the codebase." }] }
    }))
    .expect("full chunk");
    assert!(!echo.is_delta, "complete assistant messages are not deltas");
    assert_eq!(
        super::merge_claude_assistant_text(&text, &echo.text),
        "I'll survey the codebase."
    );
}

#[test]
fn new_text_block_start_flags_a_paragraph_break() {
    // A fresh text block after tool use opens a new paragraph; its deltas
    // must not weld onto the previous block ("…at the bottom.Also updating…").
    assert!(super::is_claude_text_block_start(&json!({
        "type": "stream_event",
        "event": {
            "type": "content_block_start",
            "index": 2,
            "content_block": { "type": "text", "text": "" }
        }
    })));
    // Tool-use blocks and token deltas are not text-paragraph boundaries.
    assert!(!super::is_claude_text_block_start(&json!({
        "type": "stream_event",
        "event": {
            "type": "content_block_start",
            "content_block": { "type": "tool_use", "id": "toolu_1", "name": "Read" }
        }
    })));
    assert!(!super::is_claude_text_block_start(&json!({
        "type": "stream_event",
        "event": {
            "type": "content_block_delta",
            "delta": { "type": "text_delta", "text": "Also" }
        }
    })));
}

#[test]
fn multi_block_assistant_messages_join_as_paragraphs() {
    // A complete assistant message with several text blocks reads as separate
    // paragraphs, and it dedupes against delta-accumulated text that used the
    // same separator at the block boundary.
    let echo = super::extract_claude_text_chunk(&json!({
        "type": "assistant",
        "message": { "content": [
            { "type": "text", "text": "Let me check the list." },
            { "type": "text", "text": "Also updating the comment:" }
        ]}
    }))
    .expect("full chunk");
    assert_eq!(
        echo.text,
        "Let me check the list.\n\nAlso updating the comment:"
    );
    assert_eq!(
        super::merge_claude_assistant_text(&echo.text, &echo.text),
        "Let me check the list.\n\nAlso updating the comment:"
    );
}

#[test]
fn claude_provider_citations_are_preserved_without_inference() {
    let chunk = super::extract_claude_text_chunk(&json!({
        "type": "assistant",
        "message": { "content": [{
            "type": "text",
            "text": "React 19 shipped in December 2024.",
            "citations": [{
                "type": "web_search_result_location",
                "url": "https://react.dev/blog/2024/12/05/react-19",
                "title": "React v19",
                "cited_text": "React 19 is now stable!",
                "encrypted_index": "opaque-provider-token"
            }]
        }]}
    }))
    .expect("assistant chunk");

    assert_eq!(chunk.citations.len(), 1);
    assert_eq!(
        chunk.citations[0].url.as_deref(),
        Some("https://react.dev/blog/2024/12/05/react-19")
    );
    assert_eq!(chunk.citations[0].title.as_deref(), Some("React v19"));
    assert_eq!(
        chunk.citations[0].cited_text.as_deref(),
        Some("React 19 is now stable!")
    );
    assert!(matches!(
        chunk.citations[0].locator,
        Some(falcondeck_core::ConversationCitationLocator::WebSearch {
            ref encrypted_index
        }) if encrypted_index == "opaque-provider-token"
    ));

    // A search invocation is activity, not evidence. It must not manufacture
    // an assistant citation before the provider attaches one to text.
    assert!(
        super::extract_claude_text_chunk(&json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use",
                "name": "WebSearch",
                "input": { "query": "React 19 release date" }
            }]}
        }))
        .is_none()
    );
}

#[test]
fn claude_streamed_citation_delta_is_not_lost() {
    let chunk = super::extract_claude_text_chunk(&json!({
        "type": "stream_event",
        "event": {
            "type": "content_block_delta",
            "delta": {
                "type": "citations_delta",
                "citation": {
                    "type": "search_result_location",
                    "source": "kb://release-notes",
                    "title": "Release notes",
                    "cited_text": "The release is generally available.",
                    "search_result_index": 2,
                    "start_block_index": 4,
                    "end_block_index": 5
                }
            }
        }
    }))
    .expect("citation-only chunk");

    assert!(chunk.text.is_empty());
    assert_eq!(chunk.citations.len(), 1);
    assert_eq!(
        chunk.citations[0].source.as_deref(),
        Some("kb://release-notes")
    );
    assert!(matches!(
        chunk.citations[0].locator,
        Some(falcondeck_core::ConversationCitationLocator::SearchResult {
            search_result_index: 2,
            start_block_index: 4,
            end_block_index: 5,
        })
    ));
}

#[test]
fn extracts_nested_claude_tool_use_and_result_events() {
    assert_eq!(
        super::extract_claude_tool_event(&json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_123",
                    "name": "Glob"
                }
            }
        })),
        Some(super::ClaudeToolEvent {
            id: "toolu_123".to_string(),
            title: Some("Find files".to_string()),
            tool_kind: Some("Glob".to_string()),
            status: "running".to_string(),
            output: None,
            images: Vec::new()
        })
    );

    assert_eq!(
        super::extract_claude_tool_event(&json!({
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_123",
                        "content": "match"
                    }
                ]
            }
        })),
        Some(super::ClaudeToolEvent {
            id: "toolu_123".to_string(),
            title: None,
            tool_kind: None,
            status: "completed".to_string(),
            output: Some("match".to_string()),
            images: Vec::new()
        })
    );
}

#[test]
fn every_harness_titles_the_same_tool_the_same_way() {
    // Claude spells the key `file_path`, OpenCode `filePath` — one title.
    assert_eq!(
        synthesize_tool_title("Edit", Some(&json!({ "file_path": "/repo/a.php" })), None)
            .as_deref(),
        Some("Edit /repo/a.php")
    );
    assert_eq!(
        synthesize_tool_title("edit", Some(&json!({ "filePath": "/repo/a.php" })), None).as_deref(),
        Some("Edit /repo/a.php")
    );
    // An edit streams its title before its input, so the result is a second
    // place to find the file.
    assert_eq!(
        synthesize_tool_title("Edit", None, Some(&json!({ "filePath": "/repo/a.php" }))).as_deref(),
        Some("Edit /repo/a.php")
    );
    // A command already reads as a sentence, so it keeps its own words.
    assert_eq!(
        synthesize_tool_title("bash", Some(&json!({ "command": "git status" })), None).as_deref(),
        Some("git status")
    );
    // A blank argument falls through to the next key, then to the bare verb.
    assert_eq!(
        synthesize_tool_title(
            "grep",
            Some(&json!({ "pattern": "", "query": "todo" })),
            None
        )
        .as_deref(),
        Some("Search todo")
    );
    assert_eq!(
        synthesize_tool_title("read", Some(&json!({})), None).as_deref(),
        Some("Read")
    );
    // A long command is cut to one line's worth.
    let long = synthesize_tool_title("bash", Some(&json!({ "command": "x".repeat(400) })), None)
        .expect("title");
    assert_eq!(long.chars().count(), 120);
    assert!(long.ends_with('…'));
    // An unknown tool keeps its own name, whatever the harness calls it.
    assert_eq!(
        synthesize_tool_title("question", Some(&json!({})), None),
        None
    );
}

#[test]
fn tools_that_are_not_file_work_still_say_what_they_did() {
    let title = |name: &str, input: Value| synthesize_tool_title(name, Some(&input), None);

    // A sub-agent's errand, not the word "Agent".
    assert_eq!(
        title(
            "Agent",
            json!({ "description": "Reuse review", "subagent_type": "Explore" })
        )
        .as_deref(),
        Some("Agent: Reuse review")
    );
    // A script is pasted in whole; only its first line can fit a header.
    assert_eq!(
        title(
            "Bash",
            json!({ "command": "python3 - <<'PY'\nprint(1)\nPY" })
        )
        .as_deref(),
        Some("python3 - <<'PY' …")
    );
    assert_eq!(
        title("Bash", json!({ "command": "git status --short" })).as_deref(),
        Some("git status --short")
    );
    // Bookkeeping tools say what they are rather than spelling their wire name.
    assert_eq!(
        title("TodoWrite", json!({})).as_deref(),
        Some("Update plan")
    );
    assert_eq!(
        title("WebSearch", json!({ "query": "react streaming" })).as_deref(),
        Some("Search web: react streaming")
    );

    // MCP tools arrive as one mangled identifier; read it back as the app and
    // action it is.
    assert_eq!(
        title("mcp__claude_ai_Gmail__search_threads", json!({})).as_deref(),
        Some("Gmail · search threads")
    );
    assert_eq!(
        title("mcp__notion__search", json!({})).as_deref(),
        Some("notion · search")
    );

    // A todo update is plan bookkeeping, so it must not earn the bordered card
    // that says a file changed.
    let display = tool_display_metadata("Update plan", "TodoWrite", "completed", None, None);
    assert_eq!(
        display.activity_kind,
        falcondeck_core::ToolActivityKind::Context
    );
    assert!(display.is_read_only);
}

#[test]
fn file_editing_tools_name_the_file_they_touch() {
    let title = |name: &str, input: serde_json::Value| {
        super::extract_claude_tool_event(&json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_edit",
                    "name": name,
                    "input": input
                }
            }
        }))
        .and_then(|event| event.title)
    };

    assert_eq!(
        title(
            "Edit",
            json!({ "file_path": "/repo/app/Console/Kernel.php" })
        ),
        Some("Edit /repo/app/Console/Kernel.php".to_string())
    );
    assert_eq!(
        title("Write", json!({ "file_path": "/repo/src/new.ts" })),
        Some("Write /repo/src/new.ts".to_string())
    );
    assert_eq!(
        title("MultiEdit", json!({ "file_path": "/repo/src/app.tsx" })),
        Some("Edit /repo/src/app.tsx".to_string())
    );
    assert_eq!(
        title(
            "NotebookEdit",
            json!({ "notebook_path": "/repo/analysis.ipynb" })
        ),
        Some("Edit notebook /repo/analysis.ipynb".to_string())
    );
    // An edit whose input has not streamed yet still labels the action.
    assert_eq!(title("Edit", json!({})), Some("Edit".to_string()));
}

#[test]
fn tool_result_base64_images_become_renderable_items() {
    let event = super::extract_claude_tool_event(&json!({
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_shot",
                    "content": [
                        { "type": "text", "text": "screenshot taken" },
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": "aGVsbG8="
                            }
                        }
                    ]
                }
            ]
        }
    }))
    .expect("tool event");

    assert_eq!(event.images.len(), 1);
    assert_eq!(event.images[0].media_type, "image/png");

    let items = super::claude_tool_result_image_items("toolu_shot", "Screenshot", &event.images);
    assert_eq!(items.len(), 1);
    let falcondeck_core::ConversationItem::Image { id, image, .. } = &items[0] else {
        panic!("expected an image item");
    };
    assert_eq!(id, "toolu_shot-image-0");
    assert_eq!(image.url, "data:image/png;base64,aGVsbG8=");
}

#[test]
fn claude_skill_command_result_hides_the_skill_body() {
    let event = super::extract_claude_tool_event(&json!({
        "type": "user",
        "message": {
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_skill",
                "content": "# Review\n\nPrivate instructions"
            }]
        },
        "toolUseResult": {
            "commandName": "review",
            "file": { "content": "# Review\n\nPrivate instructions" }
        }
    }))
    .expect("skill tool result");

    assert_eq!(event.title.as_deref(), Some("Load skill: review"));
    assert!(event.output.is_none());
}

#[test]
fn claude_skill_file_read_result_hides_the_skill_body() {
    let event = super::extract_claude_tool_event(&json!({
        "type": "tool_result",
        "tool_use_id": "toolu_skill_read",
        "tool_name": "Read",
        "input": { "file_path": "/project/.agents/skills/review/SKILL.md" },
        "result": "# Review\n\nPrivate instructions"
    }))
    .expect("skill file read result");

    assert_eq!(
        event.title.as_deref(),
        Some("Read /project/.agents/skills/review/SKILL.md")
    );
    assert!(event.output.is_none());
}

#[test]
fn derives_summary_mode_for_low_signal_explore_tools() {
    let display = tool_display_metadata(
        "rg -n tool_call src",
        "commandExecution",
        "completed",
        Some(0),
        Some("match"),
    );
    assert_eq!(display.activity_kind, ToolActivityKind::Search);
    assert_eq!(display.history_mode, ToolHistoryMode::Summary);
}

#[test]
fn reads_mentioning_permissions_are_not_approval_artifacts() {
    // A source file that talks about permission_mode is still just a read;
    // classifying it as approval-related auto-expands the card and splits the
    // transcript's work-session fold.
    let display = tool_display_metadata(
        "Read /project/src/index.tsx",
        "fileRead",
        "completed",
        Some(0),
        Some("const selectedPermissionMode = resolvePermissionMode(preferred.permissionMode)"),
    );
    assert_eq!(display.activity_kind, ToolActivityKind::Read);
    assert_eq!(display.artifact_kind, ToolArtifactKind::CommandOutput);

    let git_log = tool_display_metadata(
        "git log --oneline -5",
        "commandExecution",
        "completed",
        Some(0),
        Some("c5b3c3c fix: persist permission modes across clients"),
    );
    assert_ne!(git_log.activity_kind, ToolActivityKind::Approval);

    // A successful grep quoting the CLI's denial phrase is still a search.
    let quoting_grep = tool_display_metadata(
        "grep -rn \"requested permissions\" src",
        "commandExecution",
        "completed",
        Some(0),
        Some("threads.rs:12: // requested permissions marker"),
    );
    assert_ne!(quoting_grep.activity_kind, ToolActivityKind::Approval);
}

#[test]
fn requested_permissions_output_still_marks_approval() {
    let display = tool_display_metadata(
        "Bash npm install",
        "commandExecution",
        "failed",
        Some(1),
        Some("This command requested permissions to run."),
    );
    assert_eq!(display.activity_kind, ToolActivityKind::Approval);
    assert_eq!(display.artifact_kind, ToolArtifactKind::ApprovalRelated);
}

#[test]
fn normalizes_the_complete_tool_lifecycle_ladder() {
    let cases = [
        ("pending", Some(0), ToolLifecycle::Queued),
        (
            "awaiting-confirmation",
            Some(0),
            ToolLifecycle::AwaitingApproval,
        ),
        ("inProgress", Some(0), ToolLifecycle::Running),
        ("completed", Some(0), ToolLifecycle::Succeeded),
        ("failed", None, ToolLifecycle::Failed),
        ("denied", None, ToolLifecycle::Denied),
        ("cancelled", None, ToolLifecycle::Interrupted),
        ("provider_magic", None, ToolLifecycle::Unknown),
        // Exit state is authoritative even when a provider reports success.
        ("completed", Some(9), ToolLifecycle::Failed),
    ];

    for (status, exit_code, expected) in cases {
        let display =
            tool_display_metadata("Run checks", "commandExecution", status, exit_code, None);
        assert_eq!(display.lifecycle, expected, "status {status}");
    }
}

#[test]
fn explicit_approval_status_has_an_explicit_lifecycle() {
    let display = tool_display_metadata(
        "Bash npm install",
        "commandExecution",
        "awaiting_approval",
        None,
        Some("This command requested permissions to run."),
    );

    assert_eq!(display.lifecycle, ToolLifecycle::AwaitingApproval);
}

#[test]
fn persisted_state_reads_legacy_workspace_paths() {
    let payload = json!({
        "workspaces": ["/tmp/project-a", "/tmp/project-b"],
        "remote": null
    });
    let persisted: PersistedAppState = serde_json::from_value(payload).unwrap();
    assert_eq!(
        persisted.workspaces,
        vec![
            super::PersistedWorkspaceState {
                path: "/tmp/project-a".to_string(),
                id: None,
                current_thread_id: None,
                updated_at: None,
                default_provider: Some(AgentProvider::CODEX),
                last_error: None,
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
                project_pinned_thread_ids: Vec::new(),
                in_sidebar: true,
                thread_states: Vec::new(),
            },
            super::PersistedWorkspaceState {
                path: "/tmp/project-b".to_string(),
                id: None,
                current_thread_id: None,
                updated_at: None,
                default_provider: Some(AgentProvider::CODEX),
                last_error: None,
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
                project_pinned_thread_ids: Vec::new(),
                in_sidebar: true,
                thread_states: Vec::new(),
            },
        ]
    );
}

#[test]
fn persisted_state_reads_workspace_thread_selection() {
    let payload = json!({
        "workspaces": [
            {
                "path": "/tmp/project-a",
                "current_thread_id": "thread-123"
            }
        ],
        "remote": null
    });
    let persisted: PersistedAppState = serde_json::from_value(payload).unwrap();
    assert_eq!(
        persisted.workspaces,
        vec![super::PersistedWorkspaceState {
            path: "/tmp/project-a".to_string(),
            id: None,
            current_thread_id: Some("thread-123".to_string()),
            updated_at: None,
            default_provider: Some(AgentProvider::CODEX),
            last_error: None,
            archived_thread_ids: Vec::new(),
            pinned_thread_ids: Vec::new(),
            project_pinned_thread_ids: Vec::new(),
            in_sidebar: true,
            thread_states: Vec::new(),
        }]
    );
}

#[test]
fn restored_threads_require_resume_but_new_threads_do_not() {
    let summary = ThreadSummary {
        id: "thread-1".to_string(),
        workspace_id: "workspace-1".to_string(),
        title: "Thread".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Idle,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };

    let new_thread = super::ManagedThread::new(summary.clone());
    assert!(!new_thread.requires_resume);

    let restored_thread = super::ManagedThread::with_items(
        summary,
        vec![ConversationItem::AssistantMessage {
            id: "assistant-1".to_string(),
            text: "hello".to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: ContentLifecycle::Complete,
            error: None,
            created_at: Utc::now(),
        }],
    );
    assert!(restored_thread.requires_resume);
}

#[test]
fn provisional_thread_title_uses_first_four_words() {
    assert_eq!(
        super::provisional_thread_title_from_text(
            "Implement session renaming with fast fallback model now"
        ),
        Some("Implement session renaming with...".to_string())
    );
}

#[test]
fn generated_thread_title_uses_last_meaningful_line() {
    assert_eq!(
        super::normalize_generated_thread_title(
            "OpenAI Codex v0.115.0\nuser\nName this thread\ncodex\nSession renaming flow\n"
        ),
        Some("Session renaming flow".to_string())
    );
}

#[test]
fn generated_thread_title_skips_cli_noise_lines() {
    assert_eq!(
        super::normalize_generated_thread_title(
            "OpenAI Codex v0.115.0\ncodex\nImplement session rename\n\
tokens used\n5,767\n"
        ),
        Some("Implement session rename".to_string())
    );
}

#[test]
fn refresh_title_prompt_keeps_the_current_name_and_later_messages() {
    let items = vec![
        ConversationItem::UserMessage {
            id: "user-1".to_string(),
            text: "Help me set up auth".to_string(),
            attachments: Vec::new(),
            turn_id: None,
            previous_turn_id: None,
            created_at: Utc::now(),
        },
        ConversationItem::AssistantMessage {
            id: "assistant-1".to_string(),
            text: "I'll add a login form".to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: ContentLifecycle::Complete,
            error: None,
            created_at: Utc::now(),
        },
        ConversationItem::UserMessage {
            id: "user-2".to_string(),
            text: "actually let's do the billing webhook instead".to_string(),
            attachments: Vec::new(),
            turn_id: None,
            previous_turn_id: None,
            created_at: Utc::now(),
        },
    ];
    let prompt =
        super::conversation_helpers::build_refresh_ai_thread_title_prompt(&items, "Auth setup");
    assert!(prompt.contains("Current title: Auth setup"));
    assert!(prompt.contains("moved on from that name"));
    assert!(prompt.contains("billing webhook"));
}

#[tokio::test]
async fn suggest_thread_title_rejects_an_empty_conversation() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    let workspace_id = "workspace-1".to_string();
    let thread_id = "thread-1".to_string();
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                kind: falcondeck_core::WorkspaceKind::Project,
                id: workspace_id.clone(),
                path: workspace_path.to_string_lossy().to_string(),
                status: WorkspaceStatus::Ready,
                agents: Vec::new(),
                skills: Vec::new(),
                default_provider: AgentProvider::CODEX,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: Some(thread_id.clone()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [(
                thread_id.clone(),
                super::ManagedThread::new(ThreadSummary {
                    id: thread_id.clone(),
                    workspace_id: workspace_id.clone(),
                    title: "Untitled thread".to_string(),
                    provider: AgentProvider::CODEX,
                    native_session_id: None,
                    provider_transport: None,
                    handoff_from: None,
                    origin: None,
                    status: ThreadStatus::Idle,
                    updated_at: Utc::now(),
                    last_message_preview: None,
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
                }),
            )]
            .into_iter()
            .collect(),
        },
    );

    let error = app
        .suggest_thread_title(&workspace_id, &thread_id)
        .await
        .expect_err("empty threads cannot be titled");
    assert!(error.to_string().contains("enough conversation"));
}

#[tokio::test]
async fn builtin_rename_thread_tool_applies_the_agent_supplied_title() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let workspace_path = workspace_path.canonicalize().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    let workspace_id = "workspace-1".to_string();
    let thread_id = "thread-1".to_string();
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                kind: falcondeck_core::WorkspaceKind::Project,
                id: workspace_id.clone(),
                path: workspace_path.to_string_lossy().to_string(),
                status: WorkspaceStatus::Ready,
                agents: Vec::new(),
                skills: Vec::new(),
                default_provider: AgentProvider::CODEX,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: Some(thread_id.clone()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [(
                thread_id.clone(),
                super::ManagedThread::new(ThreadSummary {
                    id: thread_id.clone(),
                    workspace_id: workspace_id.clone(),
                    title: "Auth setup".to_string(),
                    provider: AgentProvider::CODEX,
                    native_session_id: None,
                    provider_transport: None,
                    handoff_from: None,
                    origin: None,
                    status: ThreadStatus::Idle,
                    updated_at: Utc::now(),
                    last_message_preview: None,
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
                }),
            )]
            .into_iter()
            .collect(),
        },
    );

    let tools = app.extension_agent_tools().await;
    assert!(
        tools
            .tools
            .iter()
            .any(|tool| tool.name == super::BUILTIN_RENAME_THREAD_TOOL)
    );

    let response = app
        .invoke_extension_tool(falcondeck_core::InvokeExtensionToolRequest {
            name: super::BUILTIN_RENAME_THREAD_TOOL.to_string(),
            arguments: json!({ "title": "Billing webhook" }),
            thread_id: Some(thread_id.clone()),
            workspace_path: Some(workspace_path.to_string_lossy().to_string()),
            bridge_capability: None,
        })
        .await
        .expect("builtin rename should apply");
    assert_eq!(response.result["renamed"], true);
    assert_eq!(response.result["title"], "Billing webhook");

    let handle = app.thread_summary(&workspace_id, &thread_id).await.unwrap();
    assert_eq!(handle.title, "Billing webhook");

    app.inner
        .workspaces
        .lock()
        .await
        .get_mut(&workspace_id)
        .unwrap()
        .threads
        .get_mut(&thread_id)
        .unwrap()
        .summary
        .status = ThreadStatus::Running;
    app.inner.extension_bridge_capabilities.lock().await.insert(
        "workspace-capability".to_string(),
        super::ExtensionBridgeCapability {
            provider: AgentProvider::CODEX,
            workspace_path: workspace_path.to_string_lossy().to_string(),
            thread_id: None,
            expires_at: Utc::now() + Duration::minutes(5),
        },
    );
    let response = app
        .invoke_extension_tool(falcondeck_core::InvokeExtensionToolRequest {
            name: super::BUILTIN_RENAME_THREAD_TOOL.to_string(),
            arguments: json!({ "title": "Workspace bridge rename" }),
            thread_id: None,
            workspace_path: Some(workspace_path.to_string_lossy().to_string()),
            bridge_capability: Some("workspace-capability".to_string()),
        })
        .await
        .expect("workspace-wide Codex bridge should bind to its running thread");
    assert_eq!(response.result["renamed"], true);
    assert_eq!(response.result["title"], "Workspace bridge rename");

    app.inner
        .workspaces
        .lock()
        .await
        .get_mut(&workspace_id)
        .unwrap()
        .threads
        .get_mut(&thread_id)
        .unwrap()
        .summary
        .provider = AgentProvider::OPENCODE;
    app.inner.extension_bridge_capabilities.lock().await.insert(
        "opencode-workspace-capability".to_string(),
        super::ExtensionBridgeCapability {
            provider: AgentProvider::OPENCODE,
            workspace_path: workspace_path.to_string_lossy().to_string(),
            thread_id: None,
            expires_at: Utc::now() + Duration::minutes(5),
        },
    );

    let response = app
        .invoke_extension_tool(falcondeck_core::InvokeExtensionToolRequest {
            name: super::BUILTIN_RENAME_THREAD_TOOL.to_string(),
            arguments: json!({ "title": "OpenCode bridge rename" }),
            thread_id: None,
            workspace_path: Some(workspace_path.to_string_lossy().to_string()),
            bridge_capability: Some("opencode-workspace-capability".to_string()),
        })
        .await
        .expect("workspace-wide OpenCode bridge should bind to its running thread");
    assert_eq!(response.result["renamed"], true);
    assert_eq!(response.result["title"], "OpenCode bridge rename");
}

#[tokio::test]
async fn extension_bridge_capability_is_opaque_task_bound_and_expires() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("state.json"),
    );
    app.inner.extension_bridge_capabilities.lock().await.insert(
        "valid-capability".to_string(),
        super::ExtensionBridgeCapability {
            provider: AgentProvider::CLAUDE,
            workspace_path: "/tmp/project".to_string(),
            thread_id: Some("thread-1".to_string()),
            expires_at: Utc::now() + Duration::minutes(5),
        },
    );
    app.inner.extension_bridge_capabilities.lock().await.insert(
        "expired-capability".to_string(),
        super::ExtensionBridgeCapability {
            provider: AgentProvider::CLAUDE,
            workspace_path: "/tmp/other".to_string(),
            thread_id: Some("thread-2".to_string()),
            expires_at: Utc::now() - Duration::minutes(1),
        },
    );

    assert!(app.extension_bridge_context(None).await.is_none());
    assert!(
        app.extension_bridge_context(Some("invented-capability"))
            .await
            .is_none()
    );
    assert!(
        app.extension_bridge_context(Some("expired-capability"))
            .await
            .is_none()
    );
    let context = app
        .extension_bridge_context(Some("valid-capability"))
        .await
        .expect("daemon-issued capability should resolve");
    assert_eq!(context.workspace_path, "/tmp/project");
    assert_eq!(context.thread_id.as_deref(), Some("thread-1"));
}

#[test]
fn workspace_bridge_binds_only_one_running_task_for_the_same_provider() {
    let make_thread = |id: &str, provider: AgentProvider, status: ThreadStatus| ThreadSummary {
        id: id.to_string(),
        workspace_id: "workspace-1".to_string(),
        title: id.to_string(),
        provider,
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };
    let idle = make_thread("idle", AgentProvider::CODEX, ThreadStatus::Idle);
    let running = make_thread("running", AgentProvider::CODEX, ThreadStatus::Running);
    let claude = make_thread("claude", AgentProvider::CLAUDE, ThreadStatus::Running);
    let threads = [&idle, &running, &claude];

    assert_eq!(
        super::unambiguous_running_thread_id(threads.into_iter(), &AgentProvider::CODEX).as_deref(),
        Some("running")
    );

    let second = make_thread("second", AgentProvider::CODEX, ThreadStatus::Running);
    let ambiguous = [&running, &second];
    assert!(
        super::unambiguous_running_thread_id(ambiguous.into_iter(), &AgentProvider::CODEX)
            .is_none()
    );
}

#[test]
fn workspace_bridge_binds_the_thread_executing_the_matching_mcp_call() {
    let make_thread = |id: &str, status: ThreadStatus| ThreadSummary {
        id: id.to_string(),
        workspace_id: "workspace-1".to_string(),
        title: id.to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };
    let bridge_call =
        |tool: &str, arguments: serde_json::Value, status: &str| ConversationItem::ToolCall {
            id: format!("{tool}-{status}"),
            title: format!("falcondeck-extensions · {tool}"),
            tool_kind: "mcpToolCall".to_string(),
            status: status.to_string(),
            output: None,
            exit_code: None,
            display: Box::new(super::conversation_helpers::tool_display_metadata(
                "MCP tool call",
                "mcpToolCall",
                "running",
                None,
                None,
            )),
            detail: Some(Box::new(falcondeck_core::ToolCallDetail::Mcp {
                server: "falcondeck-extensions".to_string(),
                tool: tool.to_string(),
                arguments,
                result: None,
                error: None,
                duration_ms: None,
                app_context: None,
            })),
            created_at: Utc::now(),
            completed_at: None,
        };
    let first = make_thread("first", ThreadStatus::Running);
    let second = make_thread("second", ThreadStatus::Running);
    let idle = make_thread("idle", ThreadStatus::Idle);
    let title_a = json!({ "title": "A" });
    let title_b = json!({ "title": "B" });

    // The thread executing the exact call wins even though two Codex threads
    // run concurrently in the workspace.
    let first_items = vec![bridge_call(
        "falcondeck_rename_thread",
        title_a.clone(),
        "running",
    )];
    let second_items = vec![bridge_call(
        "falcondeck_rename_thread",
        title_b.clone(),
        "running",
    )];
    let idle_items = vec![bridge_call(
        "falcondeck_rename_thread",
        title_a.clone(),
        "running",
    )];
    let threads = [
        (&first, first_items.as_slice()),
        (&second, second_items.as_slice()),
        (&idle, idle_items.as_slice()),
    ];
    assert_eq!(
        super::thread_with_in_flight_bridge_call(
            threads.into_iter(),
            &AgentProvider::CODEX,
            "falcondeck_rename_thread",
            &title_b,
        )
        .as_deref(),
        Some("second")
    );

    // Completed calls no longer identify a thread; a unique tool-name match
    // still binds when the harness reports arguments differently.
    let first_items = vec![bridge_call(
        "falcondeck_rename_thread",
        title_a.clone(),
        "completed",
    )];
    let second_items = vec![bridge_call(
        "falcondeck_rename_thread",
        json!({ "title": "B", "extra": true }),
        "running",
    )];
    let threads = [
        (&first, first_items.as_slice()),
        (&second, second_items.as_slice()),
    ];
    assert_eq!(
        super::thread_with_in_flight_bridge_call(
            threads.into_iter(),
            &AgentProvider::CODEX,
            "falcondeck_rename_thread",
            &title_b,
        )
        .as_deref(),
        Some("second")
    );

    // Two threads mid-way through the same call stay ambiguous.
    let first_items = vec![bridge_call(
        "falcondeck_rename_thread",
        title_a.clone(),
        "running",
    )];
    let second_items = vec![bridge_call(
        "falcondeck_rename_thread",
        title_a.clone(),
        "running",
    )];
    let threads = [
        (&first, first_items.as_slice()),
        (&second, second_items.as_slice()),
    ];
    assert!(
        super::thread_with_in_flight_bridge_call(
            threads.into_iter(),
            &AgentProvider::CODEX,
            "falcondeck_rename_thread",
            &title_a,
        )
        .is_none()
    );

    // Other bridge tools and other MCP servers never match.
    let first_items = vec![bridge_call(
        "falcondeck_suggest_follow_ups",
        title_a.clone(),
        "running",
    )];
    let threads = [(&first, first_items.as_slice())];
    assert!(
        super::thread_with_in_flight_bridge_call(
            threads.into_iter(),
            &AgentProvider::CODEX,
            "falcondeck_rename_thread",
            &title_a,
        )
        .is_none()
    );
}

#[tokio::test]
async fn workspace_bridge_rename_binds_the_calling_thread_among_concurrent_codex_threads() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let workspace_path = workspace_path.canonicalize().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    let workspace_id = "workspace-1".to_string();
    let make_thread = |id: &str| {
        super::ManagedThread::new(ThreadSummary {
            id: id.to_string(),
            workspace_id: workspace_id.clone(),
            title: id.to_string(),
            provider: AgentProvider::CODEX,
            native_session_id: None,
            provider_transport: None,
            handoff_from: None,
            origin: None,
            status: ThreadStatus::Running,
            updated_at: Utc::now(),
            last_message_preview: None,
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
        })
    };
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                kind: falcondeck_core::WorkspaceKind::Project,
                id: workspace_id.clone(),
                path: workspace_path.to_string_lossy().to_string(),
                status: WorkspaceStatus::Ready,
                agents: Vec::new(),
                skills: Vec::new(),
                default_provider: AgentProvider::CODEX,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: Some("thread-a".to_string()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [
                ("thread-a".to_string(), make_thread("thread-a")),
                ("thread-b".to_string(), make_thread("thread-b")),
            ]
            .into_iter()
            .collect(),
        },
    );
    app.inner.extension_bridge_capabilities.lock().await.insert(
        "workspace-capability".to_string(),
        super::ExtensionBridgeCapability {
            provider: AgentProvider::CODEX,
            workspace_path: workspace_path.to_string_lossy().to_string(),
            thread_id: None,
            expires_at: Utc::now() + Duration::minutes(5),
        },
    );
    let rename = |title: &str| falcondeck_core::InvokeExtensionToolRequest {
        name: super::BUILTIN_RENAME_THREAD_TOOL.to_string(),
        arguments: json!({ "title": title }),
        thread_id: None,
        workspace_path: Some(workspace_path.to_string_lossy().to_string()),
        bridge_capability: Some("workspace-capability".to_string()),
    };

    // Two running Codex threads and no in-flight call: ambiguous, fails closed.
    let error = app
        .invoke_extension_tool(rename("Nobody"))
        .await
        .expect_err("ambiguous workspace bridge must not guess a thread");
    assert!(error.to_string().contains("not attached to a thread"));

    // Thread B's transcript shows the rename call in flight, exactly as Codex
    // reports `item/started` before the bridge forwards the request.
    app.push_conversation_item(
        &workspace_id,
        "thread-b",
        ConversationItem::ToolCall {
            id: "mcp-1".to_string(),
            title: "falcondeck-extensions · falcondeck_rename_thread".to_string(),
            tool_kind: "mcpToolCall".to_string(),
            status: "running".to_string(),
            output: None,
            exit_code: None,
            display: Box::new(super::conversation_helpers::tool_display_metadata(
                "MCP tool call",
                "mcpToolCall",
                "running",
                None,
                None,
            )),
            detail: Some(Box::new(falcondeck_core::ToolCallDetail::Mcp {
                server: "falcondeck-extensions".to_string(),
                tool: super::BUILTIN_RENAME_THREAD_TOOL.to_string(),
                arguments: json!({ "title": "Second lane" }),
                result: None,
                error: None,
                duration_ms: None,
                app_context: None,
            })),
            created_at: Utc::now(),
            completed_at: None,
        },
        true,
    )
    .await
    .unwrap();
    let response = app
        .invoke_extension_tool(rename("Second lane"))
        .await
        .expect("in-flight call identifies the calling thread");
    assert_eq!(response.result["renamed"], true);
    assert_eq!(
        app.thread_summary(&workspace_id, "thread-b")
            .await
            .unwrap()
            .title,
        "Second lane"
    );
    assert_eq!(
        app.thread_summary(&workspace_id, "thread-a")
            .await
            .unwrap()
            .title,
        "thread-a"
    );
}

#[tokio::test]
async fn extension_bridge_capability_renews_on_every_accepted_call() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("state.json"),
    );
    app.inner.extension_bridge_capabilities.lock().await.insert(
        "long-lived".to_string(),
        super::ExtensionBridgeCapability {
            provider: AgentProvider::CODEX,
            workspace_path: "/tmp/project".to_string(),
            thread_id: None,
            expires_at: Utc::now() + Duration::minutes(1),
        },
    );
    app.extension_bridge_context(Some("long-lived"))
        .await
        .expect("capability should resolve");
    let renewed = app
        .inner
        .extension_bridge_capabilities
        .lock()
        .await
        .get("long-lived")
        .unwrap()
        .expires_at;
    assert!(
        renewed > Utc::now() + Duration::days(6),
        "a Codex app-server outlives any fixed TTL, so use must renew the capability"
    );
}

#[test]
fn a_running_turn_is_titleable_before_the_agent_produces_anything() {
    // Native OpenCode projects its whole transcript once the turn goes idle,
    // so the opening-prompt preview would otherwise stand for the entire turn.
    let mut thread = super::ManagedThread::new(ThreadSummary {
        id: "thread-1".to_string(),
        workspace_id: "workspace-1".to_string(),
        title: "Can we tidy up...".to_string(),
        provider: AgentProvider::new("opencode"),
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Running,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    thread.items.push(ConversationItem::UserMessage {
        id: "user-1".to_string(),
        text: "Can we tidy up the local branches".to_string(),
        attachments: Vec::new(),
        turn_id: None,
        previous_turn_id: None,
        created_at: Utc::now(),
    });

    assert!(super::conversation_helpers::should_generate_ai_thread_title(&thread));

    // An idle thread that never ran still needs agent output: a prompt the
    // provider rejected is not worth a utility-model call.
    thread.summary.status = ThreadStatus::Idle;
    assert!(!super::conversation_helpers::should_generate_ai_thread_title(&thread));
}

#[tokio::test]
async fn update_thread_title_marks_thread_as_manual() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    let workspace_id = "workspace-1".to_string();
    let thread_id = "thread-1".to_string();
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                kind: falcondeck_core::WorkspaceKind::Project,
                id: workspace_id.clone(),
                path: workspace_path.to_string_lossy().to_string(),
                status: WorkspaceStatus::Ready,
                agents: Vec::new(),
                skills: Vec::new(),
                default_provider: AgentProvider::CODEX,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: Some(thread_id.clone()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [(
                thread_id.clone(),
                super::ManagedThread::new(ThreadSummary {
                    id: thread_id.clone(),
                    workspace_id: workspace_id.clone(),
                    title: "Untitled thread".to_string(),
                    provider: AgentProvider::CODEX,
                    native_session_id: None,
                    provider_transport: None,
                    handoff_from: None,
                    origin: None,
                    status: ThreadStatus::Idle,
                    updated_at: Utc::now(),
                    last_message_preview: None,
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
                }),
            )]
            .into_iter()
            .collect(),
        },
    );

    let handle = app
        .update_thread(UpdateThreadRequest {
            workspace_id: workspace_id.clone(),
            thread_id: thread_id.clone(),
            title: Some("Session renaming flow".to_string()),
            provider: None,
            model_id: None,
            reasoning_effort: None,
            collaboration_mode_id: None,
            service_tier: None,
            pinned: None,
            pinned_in_project: None,
            acknowledge_interruption: None,
            permission_mode: None,
            approval_policy: None,
            sandbox_mode: None,
        })
        .await
        .unwrap();

    assert_eq!(handle.thread.title, "Session renaming flow");
    let workspaces = app.inner.workspaces.lock().await;
    let thread = workspaces
        .get(&workspace_id)
        .and_then(|workspace| workspace.threads.get(&thread_id))
        .unwrap();
    assert!(thread.manual_title);
    assert!(thread.ai_title_generated);
    assert_eq!(thread.summary.title, "Session renaming flow");
    drop(workspaces);

    // A title-only update must not clear previously selected agent settings.
    app.with_thread_mut(&workspace_id, &thread_id, |thread| {
        thread.agent.model_id = Some("gpt-5.4".to_string());
        thread.agent.reasoning_effort = Some("high".to_string());
    })
    .await
    .unwrap();
    app.update_thread(UpdateThreadRequest {
        workspace_id: workspace_id.clone(),
        thread_id: thread_id.clone(),
        title: Some("Renamed again".to_string()),
        provider: None,
        model_id: None,
        reasoning_effort: None,
        collaboration_mode_id: None,
        service_tier: None,
        pinned: None,
        pinned_in_project: None,
        acknowledge_interruption: None,
        permission_mode: None,
        approval_policy: None,
        sandbox_mode: None,
    })
    .await
    .unwrap();
    let handle = app
        .update_thread(UpdateThreadRequest {
            workspace_id: workspace_id.clone(),
            thread_id: thread_id.clone(),
            title: None,
            provider: None,
            model_id: None,
            reasoning_effort: None,
            collaboration_mode_id: None,
            service_tier: None,
            pinned: Some(true),
            pinned_in_project: None,
            acknowledge_interruption: None,
            permission_mode: None,
            approval_policy: None,
            sandbox_mode: None,
        })
        .await
        .unwrap();
    assert!(handle.thread.is_pinned);
    assert_eq!(handle.thread.agent.model_id.as_deref(), Some("gpt-5.4"));
    assert_eq!(
        handle.thread.agent.reasoning_effort.as_deref(),
        Some("high")
    );

    // An explicit null clears the setting; an absent field leaves it alone.
    let request: UpdateThreadRequest = serde_json::from_value(json!({
        "workspace_id": workspace_id,
        "thread_id": thread_id,
        "model_id": null,
    }))
    .unwrap();
    assert_eq!(request.model_id, Some(None));
    assert_eq!(request.reasoning_effort, None);
    let handle = app.update_thread(request).await.unwrap();
    assert_eq!(handle.thread.agent.model_id, None);
    assert_eq!(
        handle.thread.agent.reasoning_effort.as_deref(),
        Some("high")
    );
    assert!(handle.thread.is_pinned);
}

#[test]
fn reconnect_attempt_uses_current_trusted_pairing_state() {
    let initial_pairing = super::RemotePairingState {
        pairing_id: "pairing-1".to_string(),
        pairing_code: "ABCDEFGHJKLM".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: None,
        trusted_at: None,
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: None,
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let updated_pairing = super::RemotePairingState {
        device_id: Some("device-1".to_string()),
        trusted_at: Some(Utc::now()),
        client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
        ..initial_pairing
    };
    let remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::Connected,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: Some(updated_pairing.clone()),
        pending_pairing: None,
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: None,
        pairing_watch_task: None,
        command_tx: None,
        trusted_client_bundles: Vec::new(),
        trusted_client_devices: HashMap::new(),
        unresumed_remote: None,
    };

    let pairing = super::current_pairing_for_remote_attempt(
        &remote,
        "https://connect.falcondeck.com",
        "daemon-token",
    )
    .expect("current pairing for reconnect");

    assert_eq!(pairing.session_id, updated_pairing.session_id);
    assert_eq!(pairing.device_id, updated_pairing.device_id);
    assert_eq!(
        pairing
            .client_bundle
            .as_ref()
            .map(|bundle| bundle.public_key.as_str()),
        updated_pairing
            .client_bundle
            .as_ref()
            .map(|bundle| bundle.public_key.as_str())
    );
}

#[test]
fn revoking_primary_device_rotates_key_and_rebuilds_bootstrap_allowlist() {
    let revoked_bundle = build_pairing_public_key_bundle(&LocalBoxKeyPair::generate());
    let remaining_bundle = build_pairing_public_key_bundle(&LocalBoxKeyPair::generate());
    let old_data_key = generate_data_key();
    let pairing = super::RemotePairingState {
        pairing_id: "pairing-1".to_string(),
        pairing_code: "ABCDEFGHJKLM.authority".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: Some("revoked-device".to_string()),
        trusted_at: Some(Utc::now()),
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: Some(revoked_bundle.clone()),
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: old_data_key,
    };
    let mut trusted_client_devices = HashMap::new();
    trusted_client_devices.insert("revoked-device".to_string(), revoked_bundle.clone());
    trusted_client_devices.insert("remaining-device".to_string(), remaining_bundle.clone());
    let mut remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::Connected,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: Some(pairing),
        pending_pairing: None,
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: None,
        pairing_watch_task: None,
        command_tx: None,
        // Include a legacy unindexed entry to prove rotation drops it too.
        trusted_client_bundles: vec![
            revoked_bundle.clone(),
            remaining_bundle.clone(),
            build_pairing_public_key_bundle(&LocalBoxKeyPair::generate()),
        ],
        trusted_client_devices,
        unresumed_remote: None,
    };

    let (rotated_pairing, bootstrap_bundles) =
        super::rotate_remote_session_key(&mut remote, "revoked-device").unwrap();

    assert_ne!(rotated_pairing.data_key, old_data_key);
    assert_eq!(
        rotated_pairing.device_id.as_deref(),
        Some("remaining-device")
    );
    assert_eq!(
        rotated_pairing.client_bundle,
        Some(remaining_bundle.clone())
    );
    assert_eq!(bootstrap_bundles, vec![remaining_bundle.clone()]);
    assert_eq!(remote.trusted_client_bundles, vec![remaining_bundle]);
    assert!(!remote.trusted_client_devices.contains_key("revoked-device"));
}

#[test]
fn revoking_last_device_never_reuses_its_bootstrap_bundle() {
    let revoked_bundle = build_pairing_public_key_bundle(&LocalBoxKeyPair::generate());
    let old_data_key = generate_data_key();
    let pairing = super::RemotePairingState {
        pairing_id: "pairing-1".to_string(),
        pairing_code: "ABCDEFGHJKLM.authority".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: Some("revoked-device".to_string()),
        trusted_at: Some(Utc::now()),
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: Some(revoked_bundle.clone()),
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: old_data_key,
    };
    let mut trusted_client_devices = HashMap::new();
    trusted_client_devices.insert("revoked-device".to_string(), revoked_bundle.clone());
    let mut remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::Connected,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: Some(pairing),
        pending_pairing: None,
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: None,
        pairing_watch_task: None,
        command_tx: None,
        trusted_client_bundles: vec![revoked_bundle],
        trusted_client_devices,
        unresumed_remote: None,
    };

    let (rotated_pairing, bootstrap_bundles) =
        super::rotate_remote_session_key(&mut remote, "revoked-device").unwrap();

    assert_ne!(rotated_pairing.data_key, old_data_key);
    assert!(rotated_pairing.client_bundle.is_none());
    assert!(bootstrap_bundles.is_empty());
    assert!(remote.trusted_client_bundles.is_empty());
    assert!(remote.trusted_client_devices.is_empty());
}

#[tokio::test]
async fn remote_status_stops_offering_a_claimed_pairing_code() {
    let claimed_pairing = super::RemotePairingState {
        pairing_id: "pairing-1".to_string(),
        pairing_code: "ABCDEFGHJKLM".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: Some("device-1".to_string()),
        trusted_at: Some(Utc::now()),
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::Connected,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: Some(claimed_pairing),
        pending_pairing: None,
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: Some(tokio::spawn(std::future::pending::<()>())),
        pairing_watch_task: None,
        command_tx: None,
        trusted_client_bundles: Vec::new(),
        trusted_client_devices: HashMap::new(),
        unresumed_remote: None,
    };

    let status = super::build_remote_status_response(&remote);

    // The code is spent: the relay only lets the identity key that claimed it
    // re-claim it, so showing it to a second device is a guaranteed dead end.
    assert!(status.pairing.is_none());
    // Retiring the code must not disturb the device that claimed it.
    assert_eq!(status.trusted_devices.len(), 1);
    assert_eq!(status.trusted_devices[0].device_id, "device-1");
    assert!(matches!(
        status.trusted_devices[0].status,
        falcondeck_core::TrustedDeviceStatus::Active
    ));
    assert!(status.presence.is_some());
}

#[tokio::test]
async fn remote_status_still_offers_an_unclaimed_pairing_code() {
    let unclaimed_pairing = super::RemotePairingState {
        pairing_id: "pairing-1".to_string(),
        pairing_code: "ABCDEFGHJKLM".to_string(),
        session_id: None,
        device_id: None,
        trusted_at: None,
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: None,
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::PairingPending,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: Some(unclaimed_pairing),
        pending_pairing: None,
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: Some(tokio::spawn(std::future::pending::<()>())),
        pairing_watch_task: None,
        command_tx: None,
        trusted_client_bundles: Vec::new(),
        trusted_client_devices: HashMap::new(),
        unresumed_remote: None,
    };

    let status = super::build_remote_status_response(&remote);

    let pairing = status.pairing.expect("unclaimed pairing stays offerable");
    assert_eq!(pairing.pairing_code, "ABCDEFGHJKLM");
}

#[test]
fn reconnect_attempt_ignores_pending_additional_pairing_state() {
    let active_pairing = super::RemotePairingState {
        pairing_id: "pairing-active".to_string(),
        pairing_code: "ACTIVECODE12".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: Some("device-1".to_string()),
        trusted_at: Some(Utc::now()),
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let pending_pairing = super::RemotePairingState {
        pairing_id: "pairing-pending".to_string(),
        pairing_code: "PENDINGCODE1".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: None,
        trusted_at: None,
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: None,
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::Connected,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: Some(active_pairing.clone()),
        pending_pairing: Some(pending_pairing),
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: None,
        pairing_watch_task: None,
        command_tx: None,
        trusted_client_bundles: Vec::new(),
        trusted_client_devices: HashMap::new(),
        unresumed_remote: None,
    };

    let pairing = super::current_pairing_for_remote_attempt(
        &remote,
        "https://connect.falcondeck.com",
        "daemon-token",
    )
    .expect("current pairing for reconnect");

    assert_eq!(pairing.pairing_id, active_pairing.pairing_id);
    assert_eq!(pairing.device_id, active_pairing.device_id);
    assert!(pairing.client_bundle.is_some());
}

#[tokio::test]
async fn finished_remote_tasks_are_pruned_before_pairing_logic() {
    let finished_task = tokio::spawn(async {});
    let finished_watch_task = tokio::spawn(async {});
    tokio::task::yield_now().await;

    assert!(finished_task.is_finished());
    assert!(finished_watch_task.is_finished());

    let (command_tx, _command_rx) = mpsc::unbounded_channel();
    let mut remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::Inactive,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: None,
        pending_pairing: None,
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: Some(finished_task),
        pairing_watch_task: Some(finished_watch_task),
        command_tx: Some(command_tx),
        trusted_client_bundles: Vec::new(),
        trusted_client_devices: HashMap::new(),
        unresumed_remote: None,
    };

    super::prune_finished_remote_tasks(&mut remote);

    assert!(remote.task.is_none());
    assert!(remote.pairing_watch_task.is_none());
    assert!(remote.command_tx.is_none());
    assert!(!super::has_live_remote_task(&remote));
}

#[tokio::test]
async fn reconcile_remote_runtime_state_clears_orphaned_additional_pairing() {
    let finished_task = tokio::spawn(async {});
    let running_watch_task = tokio::spawn(async {
        sleep(TokioDuration::from_secs(30)).await;
    });
    tokio::task::yield_now().await;

    assert!(finished_task.is_finished());
    assert!(!running_watch_task.is_finished());

    let active_pairing = super::RemotePairingState {
        pairing_id: "pairing-active".to_string(),
        pairing_code: "ACTIVECODE12".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: Some("device-1".to_string()),
        trusted_at: Some(Utc::now()),
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let pending_pairing = super::RemotePairingState {
        pairing_id: "pairing-pending".to_string(),
        pairing_code: "PENDINGCODE1".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: None,
        trusted_at: None,
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: None,
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let (command_tx, _command_rx) = mpsc::unbounded_channel();
    let mut remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::Connected,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: Some(active_pairing),
        pending_pairing: Some(pending_pairing),
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: Some(finished_task),
        pairing_watch_task: Some(running_watch_task),
        command_tx: Some(command_tx),
        trusted_client_bundles: Vec::new(),
        trusted_client_devices: HashMap::new(),
        unresumed_remote: None,
    };

    super::reconcile_remote_runtime_state(&mut remote);

    assert!(matches!(
        remote.status,
        falcondeck_core::RemoteConnectionStatus::Offline
    ));
    assert!(remote.task.is_none());
    assert!(remote.pairing_watch_task.is_none());
    assert!(remote.pending_pairing.is_none());
    assert!(remote.command_tx.is_none());
    assert_eq!(
        remote.last_error.as_deref(),
        Some(
            "Additional remote pairing was cancelled because the desktop relay bridge stopped. Generate a fresh pairing code."
        )
    );
}

#[test]
fn remote_status_response_hides_stale_unclaimed_pairing_without_a_live_bridge() {
    let pairing = super::RemotePairingState {
        pairing_id: "pairing-1".to_string(),
        pairing_code: "ABCDEFGHJKLM".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: None,
        trusted_at: None,
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: None,
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::PairingPending,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: Some(pairing),
        pending_pairing: None,
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: None,
        pairing_watch_task: None,
        command_tx: None,
        trusted_client_bundles: Vec::new(),
        trusted_client_devices: HashMap::new(),
        unresumed_remote: None,
    };

    let response = super::build_remote_status_response(&remote);

    assert_eq!(
        response.status,
        falcondeck_core::RemoteConnectionStatus::Inactive
    );
    assert!(response.pairing.is_none());
    assert!(response.presence.is_some());
    assert_eq!(
        response
            .presence
            .as_ref()
            .map(|presence| presence.daemon_connected),
        Some(false)
    );
}

#[test]
fn remote_status_response_hides_stale_trusted_pairing_without_a_live_bridge() {
    let pairing = super::RemotePairingState {
        pairing_id: "pairing-1".to_string(),
        pairing_code: "ABCDEFGHJKLM".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: Some("device-1".to_string()),
        trusted_at: Some(Utc::now()),
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let remote = super::RemoteBridgeState {
        status: falcondeck_core::RemoteConnectionStatus::Connected,
        relay_url: Some("https://connect.falcondeck.com".to_string()),
        pairing: Some(pairing),
        pending_pairing: None,
        daemon_token: Some("daemon-token".to_string()),
        last_error: None,
        task: None,
        pairing_watch_task: None,
        command_tx: None,
        trusted_client_bundles: Vec::new(),
        trusted_client_devices: HashMap::new(),
        unresumed_remote: None,
    };

    let response = super::build_remote_status_response(&remote);

    assert_eq!(
        response.status,
        falcondeck_core::RemoteConnectionStatus::Offline
    );
    assert!(response.pairing.is_none());
    assert_eq!(
        response
            .presence
            .as_ref()
            .map(|presence| presence.daemon_connected),
        Some(false)
    );
}

#[tokio::test]
async fn restore_skips_expired_unclaimed_remote_pairing() {
    let temp_dir = tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let persisted = PersistedAppState {
        workspaces: vec![],
        remote: Some(PersistedRemoteState {
            relay_url: "https://connect.falcondeck.com".to_string(),
            daemon_token: "daemon-token".to_string(),
            pairing_id: "pairing-1".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: None,
            device_id: None,
            trusted_at: None,
            expires_at: Utc::now() - Duration::seconds(5),
            client_bundle: None,
            client_public_key: None,
            secure_storage_key: None,
            local_secret_key_base64: Some(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            ),
            data_key_base64: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string()),
            trusted_client_bundles: Vec::new(),
            trusted_client_devices: HashMap::new(),
        }),
    };

    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );
    app.restore_local_state().await.unwrap();

    let remote = app.inner.remote.lock().await;
    assert_eq!(
        remote.status,
        falcondeck_core::RemoteConnectionStatus::Inactive
    );
    assert!(remote.relay_url.is_none());
    assert!(remote.daemon_token.is_none());
    assert!(remote.pairing.is_none());
    drop(remote);

    let persisted_after: PersistedAppState =
        serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
    assert!(persisted_after.remote.is_none());
}

#[tokio::test]
async fn mark_thread_unread_walks_read_seq_back_behind_agent_activity() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-unread");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let persisted = PersistedAppState {
        workspaces: vec![super::PersistedWorkspaceState {
            path: workspace_path.to_string_lossy().to_string(),
            id: Some("workspace-unread".to_string()),
            current_thread_id: Some("thread-1".to_string()),
            updated_at: Some(Utc::now()),
            default_provider: Some(AgentProvider::CLAUDE),
            last_error: None,
            archived_thread_ids: Vec::new(),
            pinned_thread_ids: Vec::new(),
            project_pinned_thread_ids: Vec::new(),
            in_sidebar: true,
            thread_states: vec![super::PersistedThreadState {
                thread_id: "thread-1".to_string(),
                updated_at: Some(Utc::now()),
                provider: Some(AgentProvider::CLAUDE),
                native_session_id: None,
                provider_transport: None,
                handoff_from: None,
                origin: None,
                title: Some("Read thread".to_string()),
                manual_title: false,
                ai_title_generated: false,
                status: Some(ThreadStatus::Idle),
                last_error: None,
                // Fully caught up: read seq level with agent activity.
                last_read_seq: 7,
                last_agent_activity_seq: 7,
                variant: None,
                agent: ThreadAgentParams::default(),
                goal: None,
                queued_requests: Vec::new(),
            }],
        }],
        remote: None,
    };

    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::from([
            (AgentProvider::CODEX, "missing-codex".to_string()),
            (AgentProvider::CLAUDE, "missing-claude".to_string()),
        ]),
        PathBuf::from(&state_path),
    );
    app.restore_local_state().await.unwrap();

    let before = app
        .thread_summary("workspace-unread", "thread-1")
        .await
        .unwrap();
    assert!(!before.attention.unread);

    let after = app
        .mark_thread_unread("workspace-unread", "thread-1")
        .await
        .unwrap();
    assert!(after.attention.unread);
    assert_eq!(after.attention.last_read_seq, 6);
    assert!(
        after.updated_at > before.updated_at,
        "mark-unread must stamp a newer updated_at so remote replay of the pre-read summary cannot win",
    );
    assert_eq!(
        after.attention.level,
        falcondeck_core::ThreadAttentionLevel::Unread
    );

    // Idempotent: a second call cannot walk the thread further back.
    let again = app
        .mark_thread_unread("workspace-unread", "thread-1")
        .await
        .unwrap();
    assert_eq!(again.attention.last_read_seq, 6);

    // And mark_read still wins afterwards, so the pair round-trips.
    let read_again = app
        .mark_thread_read("workspace-unread", "thread-1", 7)
        .await
        .unwrap();
    assert!(!read_again.attention.unread);
    assert_eq!(read_again.attention.last_read_seq, 7);
}

/// Restores an app whose one thread is fully caught up (read seq level with
/// agent activity), for tests that assert which item inserts flip it unread.
async fn restored_caught_up_thread_app(
    state_path: &std::path::Path,
    workspace_path: &std::path::Path,
) -> AppState {
    std::fs::create_dir_all(workspace_path).unwrap();
    let persisted = PersistedAppState {
        workspaces: vec![super::PersistedWorkspaceState {
            path: workspace_path.to_string_lossy().to_string(),
            id: Some("workspace-unread".to_string()),
            current_thread_id: Some("thread-1".to_string()),
            updated_at: Some(Utc::now()),
            default_provider: Some(AgentProvider::CLAUDE),
            last_error: None,
            archived_thread_ids: Vec::new(),
            pinned_thread_ids: Vec::new(),
            project_pinned_thread_ids: Vec::new(),
            in_sidebar: true,
            thread_states: vec![super::PersistedThreadState {
                thread_id: "thread-1".to_string(),
                updated_at: Some(Utc::now()),
                provider: Some(AgentProvider::CLAUDE),
                native_session_id: None,
                provider_transport: None,
                handoff_from: None,
                origin: None,
                title: Some("Read thread".to_string()),
                manual_title: false,
                ai_title_generated: false,
                status: Some(ThreadStatus::Idle),
                last_error: None,
                last_read_seq: 7,
                last_agent_activity_seq: 7,
                variant: None,
                agent: ThreadAgentParams::default(),
                goal: None,
                queued_requests: Vec::new(),
            }],
        }],
        remote: None,
    };
    tokio::fs::write(state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::from([
            (AgentProvider::CODEX, "missing-codex".to_string()),
            (AgentProvider::CLAUDE, "missing-claude".to_string()),
        ]),
        PathBuf::from(state_path),
    );
    app.restore_local_state().await.unwrap();
    app
}

#[tokio::test]
async fn daemon_authored_items_do_not_mark_threads_unread() {
    let temp_dir = tempdir().unwrap();
    let app = restored_caught_up_thread_app(
        &temp_dir.path().join("daemon-state.json"),
        &temp_dir.path().join("project-receipts"),
    )
    .await;

    app.push_conversation_item(
        "workspace-unread",
        "thread-1",
        ConversationItem::Service {
            id: "service-1".to_string(),
            level: ServiceLevel::Warning,
            message: "Turn interrupted".to_string(),
            created_at: Utc::now(),
        },
        false,
    )
    .await
    .unwrap();
    let after_service = app
        .thread_summary("workspace-unread", "thread-1")
        .await
        .unwrap();
    assert!(
        !after_service.attention.unread,
        "a service diagnostic is daemon commentary, not fresh agent output",
    );

    app.push_conversation_item(
        "workspace-unread",
        "thread-1",
        ConversationItem::AssistantMessage {
            id: "falcondeck-turn-receipt-turn-1".to_string(),
            text: String::new(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: ContentLifecycle::Interrupted,
            error: Some("FalconDeck was closed while this turn was running".to_string()),
            created_at: Utc::now(),
        },
        true,
    )
    .await
    .unwrap();
    let after_receipt = app
        .thread_summary("workspace-unread", "thread-1")
        .await
        .unwrap();
    assert!(
        !after_receipt.attention.unread,
        "a shutdown receipt must not flip a read thread unread on relaunch",
    );

    app.push_conversation_item(
        "workspace-unread",
        "thread-1",
        ConversationItem::AssistantMessage {
            id: "assistant-1".to_string(),
            text: "a real answer".to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: ContentLifecycle::Complete,
            error: None,
            created_at: Utc::now(),
        },
        true,
    )
    .await
    .unwrap();
    let after_answer = app
        .thread_summary("workspace-unread", "thread-1")
        .await
        .unwrap();
    assert!(
        after_answer.attention.unread,
        "genuine agent output must still mark the thread unread",
    );
}

#[tokio::test]
async fn settling_an_interrupted_turn_keeps_a_read_thread_read() {
    let temp_dir = tempdir().unwrap();
    let app = restored_caught_up_thread_app(
        &temp_dir.path().join("daemon-state.json"),
        &temp_dir.path().join("project-settle"),
    )
    .await;

    // A turn was dispatched (user message only, no answer yet) when the
    // daemon goes down: settling must leave the receipt without waking the
    // unread dot, since the user has seen everything the agent produced.
    app.push_conversation_item(
        "workspace-unread",
        "thread-1",
        ConversationItem::UserMessage {
            id: "user-1".to_string(),
            text: "do the thing".to_string(),
            attachments: Vec::new(),
            turn_id: Some("turn-1".to_string()),
            previous_turn_id: None,
            created_at: Utc::now(),
        },
        false,
    )
    .await
    .unwrap();
    app.settle_turn_items_with_error(
        "workspace-unread",
        "thread-1",
        Utc::now(),
        ToolSettlement::Interrupted,
        Some("FalconDeck was closed while this turn was running"),
    )
    .await;

    let receipt_lifecycle = {
        let workspaces = app.inner.workspaces.lock().await;
        workspaces["workspace-unread"].threads["thread-1"]
            .items
            .iter()
            .find_map(|item| match item {
                ConversationItem::AssistantMessage { id, lifecycle, .. }
                    if id == "falcondeck-turn-receipt-turn-1" =>
                {
                    Some(*lifecycle)
                }
                _ => None,
            })
    };
    assert_eq!(
        receipt_lifecycle,
        Some(ContentLifecycle::Interrupted),
        "settling must still record the interruption receipt",
    );
    let after = app
        .thread_summary("workspace-unread", "thread-1")
        .await
        .unwrap();
    assert!(
        !after.attention.unread,
        "the daemon interrupting its own turn is not new agent activity",
    );
}

#[tokio::test]
async fn restore_seeds_sequence_counter_past_persisted_attention_seqs() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-seed");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    // A thread carried over from a long-lived previous boot whose counter
    // reached 200_000. If this boot's counter restarted at 1, new activity
    // here would stamp max(200_000, tiny) and never move, and a mark-read
    // stamped with a tiny this-boot seq could never catch 200_000 — the
    // thread read as unread forever (or never read as unread again).
    let persisted = PersistedAppState {
        workspaces: vec![super::PersistedWorkspaceState {
            path: workspace_path.to_string_lossy().to_string(),
            id: Some("workspace-seed".to_string()),
            current_thread_id: Some("thread-1".to_string()),
            updated_at: Some(Utc::now()),
            default_provider: Some(AgentProvider::CLAUDE),
            last_error: None,
            archived_thread_ids: Vec::new(),
            pinned_thread_ids: Vec::new(),
            project_pinned_thread_ids: Vec::new(),
            in_sidebar: true,
            thread_states: vec![super::PersistedThreadState {
                thread_id: "thread-1".to_string(),
                updated_at: Some(Utc::now()),
                provider: Some(AgentProvider::CLAUDE),
                native_session_id: None,
                provider_transport: None,
                handoff_from: None,
                origin: None,
                title: Some("Old boot thread".to_string()),
                manual_title: false,
                ai_title_generated: false,
                status: Some(ThreadStatus::Idle),
                last_error: None,
                last_read_seq: 150_000,
                last_agent_activity_seq: 200_000,
                variant: None,
                agent: ThreadAgentParams::default(),
                goal: None,
                queued_requests: Vec::new(),
            }],
        }],
        remote: None,
    };

    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::from([(AgentProvider::CLAUDE, "missing-claude".to_string())]),
        PathBuf::from(&state_path),
    );
    app.restore_local_state().await.unwrap();

    let next_seq = app
        .inner
        .sequence
        .load(std::sync::atomic::Ordering::Relaxed);
    assert!(
        next_seq > 200_000,
        "sequence counter must be seeded past every persisted attention seq, got {next_seq}"
    );
}

#[tokio::test]
async fn transcript_replay_does_not_flip_a_read_thread_unread() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-replay");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    // A native OpenCode thread restored fully read: read seq level with the
    // last agent activity. The global sequence counter restarts at 1 on boot
    // and climbs with every event anywhere in the daemon; simulate a busy
    // daemon whose counter sits far above the thread's own seqs.
    let persisted = PersistedAppState {
        workspaces: vec![super::PersistedWorkspaceState {
            path: workspace_path.to_string_lossy().to_string(),
            id: Some("workspace-replay".to_string()),
            current_thread_id: Some("thread-1".to_string()),
            updated_at: Some(Utc::now()),
            default_provider: Some(AgentProvider::OPENCODE),
            last_error: None,
            archived_thread_ids: Vec::new(),
            pinned_thread_ids: Vec::new(),
            project_pinned_thread_ids: Vec::new(),
            in_sidebar: true,
            thread_states: vec![super::PersistedThreadState {
                thread_id: "thread-1".to_string(),
                updated_at: Some(Utc::now()),
                provider: Some(AgentProvider::OPENCODE),
                native_session_id: Some("ses_native".to_string()),
                provider_transport: Some("native".to_string()),
                handoff_from: None,
                origin: None,
                title: Some("Read thread".to_string()),
                manual_title: false,
                ai_title_generated: false,
                status: Some(ThreadStatus::Idle),
                last_error: None,
                last_read_seq: 7,
                last_agent_activity_seq: 7,
                variant: None,
                agent: ThreadAgentParams::default(),
                goal: None,
                queued_requests: Vec::new(),
            }],
        }],
        remote: None,
    };

    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );
    app.restore_local_state().await.unwrap();
    app.inner
        .sequence
        .store(40_000, std::sync::atomic::Ordering::Relaxed);

    // Hydration replays the stored transcript: history recovery, not new
    // agent output. It must not stamp the global sequence into the thread.
    app.replay_conversation_item(
        "workspace-replay",
        "thread-1",
        ConversationItem::AssistantMessage {
            id: "opencode-msg_1".to_string(),
            text: "Recovered reply".to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: ContentLifecycle::Complete,
            error: None,
            created_at: Utc::now(),
        },
        true,
    )
    .await
    .unwrap();
    app.replay_conversation_item(
        "workspace-replay",
        "thread-1",
        ConversationItem::Reasoning {
            id: "opencode-msg_2".to_string(),
            summary: None,
            content: "Recovered thinking".to_string(),
            lifecycle: ContentLifecycle::Complete,
            duration_ms: None,
            created_at: Utc::now(),
        },
        true,
    )
    .await
    .unwrap();

    let replayed = app
        .thread_summary("workspace-replay", "thread-1")
        .await
        .unwrap();
    assert!(!replayed.attention.unread);
    assert_eq!(replayed.attention.last_agent_activity_seq, 7);
    assert_eq!(replayed.attention.last_read_seq, 7);

    // Live output is still attention: a streamed assistant item must flip
    // the thread unread with a seq the client can then mark read.
    app.push_conversation_item(
        "workspace-replay",
        "thread-1",
        ConversationItem::AssistantMessage {
            id: "opencode-msg_live".to_string(),
            text: "Fresh reply".to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: ContentLifecycle::Complete,
            error: None,
            created_at: Utc::now(),
        },
        true,
    )
    .await
    .unwrap();

    let live = app
        .thread_summary("workspace-replay", "thread-1")
        .await
        .unwrap();
    assert!(live.attention.unread);
    assert!(live.attention.last_agent_activity_seq > 7);
}

#[tokio::test]
async fn restore_keeps_workspace_visible_when_reconnect_fails() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let thread_updated_at = Utc::now() - Duration::minutes(6);
    let persisted = PersistedAppState {
        workspaces: vec![super::PersistedWorkspaceState {
            path: workspace_path.to_string_lossy().to_string(),
            id: Some("workspace-persisted-a".to_string()),
            current_thread_id: Some("thread-1".to_string()),
            updated_at: Some(Utc::now() - Duration::minutes(5)),
            default_provider: Some(AgentProvider::CLAUDE),
            last_error: Some("Previous reconnect failed".to_string()),
            archived_thread_ids: vec!["thread-1".to_string()],
            pinned_thread_ids: Vec::new(),
            project_pinned_thread_ids: Vec::new(),
            in_sidebar: true,
            thread_states: vec![super::PersistedThreadState {
                thread_id: "thread-1".to_string(),
                updated_at: Some(thread_updated_at),
                provider: Some(AgentProvider::CLAUDE),
                native_session_id: Some("native-session-1".to_string()),
                provider_transport: None,
                handoff_from: None,
                origin: None,
                title: Some("Recovered thread".to_string()),
                manual_title: false,
                ai_title_generated: false,
                status: Some(ThreadStatus::Running),
                last_error: None,
                last_read_seq: 2,
                last_agent_activity_seq: 7,
                variant: None,
                agent: ThreadAgentParams::default(),
                goal: None,
                queued_requests: Vec::new(),
            }],
        }],
        remote: None,
    };

    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::from([
            (AgentProvider::CODEX, "missing-codex".to_string()),
            (AgentProvider::CLAUDE, "missing-claude".to_string()),
        ]),
        PathBuf::from(&state_path),
    );
    app.restore_local_state().await.unwrap();

    let initial_snapshot = app.snapshot().await;
    assert_eq!(initial_snapshot.workspaces.len(), 1);
    assert_eq!(initial_snapshot.workspaces[0].id, "workspace-persisted-a");
    assert_eq!(initial_snapshot.threads.len(), 1);
    assert_eq!(
        initial_snapshot.workspaces[0].status,
        WorkspaceStatus::Connecting
    );
    assert_eq!(
        initial_snapshot.workspaces[0].last_error.as_deref(),
        Some("Previous reconnect failed")
    );

    let final_snapshot = {
        let mut snapshot = initial_snapshot;
        for _ in 0..20 {
            if matches!(snapshot.workspaces[0].status, WorkspaceStatus::Disconnected) {
                break;
            }
            sleep(TokioDuration::from_millis(50)).await;
            snapshot = app.snapshot().await;
        }
        snapshot
    };

    let workspace = &final_snapshot.workspaces[0];
    assert_eq!(workspace.status, WorkspaceStatus::Disconnected);
    assert!(workspace.last_error.is_some());
    assert_eq!(workspace.default_provider, AgentProvider::CLAUDE);
    assert_eq!(workspace.current_thread_id.as_deref(), Some("thread-1"));

    let thread = &final_snapshot.threads[0];
    assert_eq!(thread.title, "Recovered thread");
    assert_eq!(thread.provider, AgentProvider::CLAUDE);
    assert_eq!(
        thread.native_session_id.as_deref(),
        Some("native-session-1")
    );
    assert_eq!(thread.status, ThreadStatus::Error);
    assert_eq!(thread.updated_at, thread_updated_at);
    assert!(thread.is_archived);
    assert!(thread.last_error.is_some());

    let persisted_after = {
        let mut persisted: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        for _ in 0..20 {
            if persisted.workspaces[0].thread_states[0].status == Some(ThreadStatus::Error) {
                break;
            }
            sleep(TokioDuration::from_millis(25)).await;
            persisted =
                serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        }
        persisted
    };
    assert_eq!(persisted_after.workspaces.len(), 1);
    assert_eq!(
        persisted_after.workspaces[0].id.as_deref(),
        Some("workspace-persisted-a")
    );
    assert!(persisted_after.workspaces[0].last_error.is_some());
    assert_eq!(
        persisted_after.workspaces[0].thread_states[0].status,
        Some(ThreadStatus::Error)
    );
}

#[tokio::test]
async fn workspace_id_survives_daemon_restarts() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    // Pre-migration state file: no id yet. The first restore mints one and
    // persists it; every later restore must reuse it, because paired devices
    // cache snapshots across daemon restarts and address workspaces by id.
    let persisted = PersistedAppState {
        workspaces: vec![super::PersistedWorkspaceState {
            path: workspace_path.to_string_lossy().to_string(),
            id: None,
            current_thread_id: None,
            updated_at: Some(Utc::now()),
            default_provider: Some(AgentProvider::CODEX),
            last_error: None,
            archived_thread_ids: Vec::new(),
            pinned_thread_ids: Vec::new(),
            project_pinned_thread_ids: Vec::new(),
            in_sidebar: true,
            thread_states: Vec::new(),
        }],
        remote: None,
    };
    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let mut minted_id = None;
    for _ in 0..2 {
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::from([
                (AgentProvider::CODEX, "missing-codex".to_string()),
                (AgentProvider::CLAUDE, "missing-claude".to_string()),
            ]),
            PathBuf::from(&state_path),
        );
        app.restore_local_state().await.unwrap();

        // Wait for the failed reconnect to settle so persist_local_state has
        // written the restored workspace (with its id) back to disk.
        for _ in 0..20 {
            let snapshot = app.snapshot().await;
            if matches!(snapshot.workspaces[0].status, WorkspaceStatus::Disconnected) {
                break;
            }
            sleep(TokioDuration::from_millis(50)).await;
        }

        let snapshot = app.snapshot().await;
        assert_eq!(snapshot.workspaces.len(), 1);
        match &minted_id {
            None => minted_id = Some(snapshot.workspaces[0].id.clone()),
            Some(id) => assert_eq!(&snapshot.workspaces[0].id, id),
        }

        // The disconnect shows in the snapshot before the follow-up persist
        // lands on disk, so poll the state file rather than read it once.
        let mut persisted_id = None;
        for _ in 0..20 {
            let persisted_after: PersistedAppState =
                serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
            persisted_id = persisted_after.workspaces[0].id.clone();
            if persisted_id.as_deref() == minted_id.as_deref() {
                break;
            }
            sleep(TokioDuration::from_millis(50)).await;
        }
        assert_eq!(persisted_id.as_deref(), minted_id.as_deref());
    }
}

#[tokio::test]
async fn persist_local_state_merges_saved_workspaces_with_live_workspaces() {
    let temp_dir = tempdir().unwrap();
    let workspace_a = temp_dir.path().join("project-a");
    let workspace_b = temp_dir.path().join("project-b");
    std::fs::create_dir_all(&workspace_a).unwrap();
    std::fs::create_dir_all(&workspace_b).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    {
        let mut saved = app.inner.saved_workspaces.lock().await;
        saved.insert(
            workspace_a.to_string_lossy().to_string(),
            super::PersistedWorkspaceState {
                path: workspace_a.to_string_lossy().to_string(),
                id: Some("workspace-a".to_string()),
                current_thread_id: Some("thread-a".to_string()),
                updated_at: Some(Utc::now() - Duration::minutes(2)),
                default_provider: Some(AgentProvider::CODEX),
                last_error: None,
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
                project_pinned_thread_ids: Vec::new(),
                in_sidebar: true,
                thread_states: vec![super::PersistedThreadState {
                    thread_id: "thread-a".to_string(),
                    updated_at: None,
                    provider: Some(AgentProvider::CODEX),
                    native_session_id: Some("native-a".to_string()),
                    provider_transport: None,
                    handoff_from: None,
                    origin: None,
                    title: Some("Thread A".to_string()),
                    manual_title: false,
                    ai_title_generated: false,
                    status: Some(ThreadStatus::Idle),
                    last_error: None,
                    last_read_seq: 0,
                    last_agent_activity_seq: 0,
                    variant: None,
                    agent: ThreadAgentParams::default(),
                    goal: None,
                    queued_requests: Vec::new(),
                }],
            },
        );
        saved.insert(
            workspace_b.to_string_lossy().to_string(),
            super::PersistedWorkspaceState {
                path: workspace_b.to_string_lossy().to_string(),
                id: Some("workspace-b".to_string()),
                current_thread_id: Some("thread-b".to_string()),
                updated_at: Some(Utc::now() - Duration::minutes(1)),
                default_provider: Some(AgentProvider::CLAUDE),
                last_error: Some("Still disconnected".to_string()),
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
                project_pinned_thread_ids: Vec::new(),
                in_sidebar: true,
                thread_states: vec![super::PersistedThreadState {
                    thread_id: "thread-b".to_string(),
                    updated_at: None,
                    provider: Some(AgentProvider::CLAUDE),
                    native_session_id: Some("native-b".to_string()),
                    provider_transport: None,
                    handoff_from: None,
                    origin: None,
                    title: Some("Thread B".to_string()),
                    manual_title: false,
                    ai_title_generated: false,
                    status: Some(ThreadStatus::Error),
                    last_error: Some("Still disconnected".to_string()),
                    last_read_seq: 1,
                    last_agent_activity_seq: 3,
                    variant: None,
                    agent: ThreadAgentParams::default(),
                    goal: None,
                    queued_requests: Vec::new(),
                }],
            },
        );
    }

    let live_workspace_id = "workspace-a".to_string();
    let live_thread = ThreadSummary {
        id: "thread-a".to_string(),
        workspace_id: live_workspace_id.clone(),
        title: "Thread A renamed".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: Some("native-a-2".to_string()),
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Idle,
        updated_at: Utc::now(),
        last_message_preview: None,
        latest_turn_id: None,
        latest_plan: None,
        latest_diff: None,
        last_tool: None,
        last_error: None,
        agent: ThreadAgentParams::default(),
        attention: ThreadAttention {
            last_read_seq: 4,
            last_agent_activity_seq: 8,
            ..ThreadAttention::default()
        },
        is_archived: false,
        is_pinned: false,
        is_pinned_in_project: false,
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };
    let live_workspace = WorkspaceSummary {
        kind: falcondeck_core::WorkspaceKind::Project,
        id: live_workspace_id.clone(),
        path: workspace_a.to_string_lossy().to_string(),
        status: WorkspaceStatus::Ready,
        agents: Vec::new(),
        skills: Vec::new(),
        default_provider: AgentProvider::CODEX,
        models: Vec::new(),
        collaboration_modes: Vec::new(),
        account: falcondeck_core::AccountSummary::default(),
        current_thread_id: Some("thread-a".to_string()),
        connected_at: Utc::now(),
        updated_at: Utc::now(),
        last_error: None,
    };
    app.inner.workspaces.lock().await.insert(
        live_workspace_id,
        super::ManagedWorkspace {
            summary: live_workspace,
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [(
                "thread-a".to_string(),
                super::ManagedThread::new(live_thread),
            )]
            .into_iter()
            .collect(),
        },
    );

    app.persist_local_state().await.unwrap();

    let persisted_after: PersistedAppState =
        serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
    assert_eq!(persisted_after.workspaces.len(), 2);

    let restored_a = persisted_after
        .workspaces
        .iter()
        .find(|workspace| {
            workspace.path == super::normalize_workspace_path(&workspace_a.to_string_lossy())
        })
        .unwrap();
    assert_eq!(
        restored_a.thread_states[0].title.as_deref(),
        Some("Thread A renamed")
    );
    assert_eq!(
        restored_a.thread_states[0].native_session_id.as_deref(),
        Some("native-a-2")
    );
    assert_eq!(restored_a.thread_states[0].last_read_seq, 4);

    let restored_b = persisted_after
        .workspaces
        .iter()
        .find(|workspace| {
            workspace.path == super::normalize_workspace_path(&workspace_b.to_string_lossy())
        })
        .unwrap();
    assert_eq!(restored_b.current_thread_id.as_deref(), Some("thread-b"));
    assert_eq!(restored_b.last_error.as_deref(), Some("Still disconnected"));
    assert_eq!(
        restored_b.thread_states[0].status,
        Some(ThreadStatus::Error)
    );
}

#[tokio::test]
async fn close_workspace_keeps_persist_and_lists_it_in_the_library() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    let workspace_id = "workspace-1".to_string();
    let path_string = workspace_path.to_string_lossy().to_string();
    let thread = ThreadSummary {
        id: "thread-1".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Idle thread".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Idle,
        updated_at: Utc::now(),
        last_message_preview: None,
        latest_turn_id: None,
        latest_plan: None,
        latest_diff: None,
        last_tool: None,
        last_error: None,
        agent: ThreadAgentParams::default(),
        attention: ThreadAttention::default(),
        is_archived: false,
        is_pinned: true,
        is_pinned_in_project: false,
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                kind: falcondeck_core::WorkspaceKind::Project,
                id: workspace_id.clone(),
                path: path_string.clone(),
                status: WorkspaceStatus::Ready,
                agents: Vec::new(),
                skills: Vec::new(),
                default_provider: AgentProvider::CODEX,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: Some("thread-1".to_string()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [("thread-1".to_string(), super::ManagedThread::new(thread))]
                .into_iter()
                .collect(),
        },
    );
    {
        let mut preferences = app.inner.preferences.lock().await;
        preferences.workspace_order = vec![workspace_id.clone()];
    }

    app.close_workspace(&workspace_id).await.unwrap();

    let snapshot = app.snapshot().await;
    assert!(snapshot.workspaces.is_empty());
    assert!(snapshot.threads.is_empty());
    assert_eq!(snapshot.library_workspaces.len(), 1);
    assert_eq!(snapshot.library_workspaces[0].id, workspace_id);
    assert!(
        snapshot.library_workspaces[0].path.ends_with("project-a"),
        "{}",
        snapshot.library_workspaces[0].path
    );
    assert!(snapshot.preferences.workspace_order.is_empty());
    assert!(app.inner.workspaces.lock().await.is_empty());

    let saved = app.inner.saved_workspaces.lock().await;
    let persisted = saved
        .values()
        .find(|workspace| workspace.id.as_deref() == Some(workspace_id.as_str()))
        .unwrap();
    assert!(!persisted.in_sidebar);
    assert!(
        persisted
            .pinned_thread_ids
            .contains(&"thread-1".to_string())
    );
}

#[tokio::test]
async fn shutdown_marks_running_threads_as_error_and_persists_them() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    let workspace_id = "workspace-1".to_string();
    let thread = ThreadSummary {
        id: "thread-1".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Running thread".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: Some("native-session-1".to_string()),
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Running,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };
    let workspace = WorkspaceSummary {
        kind: falcondeck_core::WorkspaceKind::Project,
        id: workspace_id.clone(),
        path: workspace_path.to_string_lossy().to_string(),
        status: WorkspaceStatus::Busy,
        agents: Vec::new(),
        skills: Vec::new(),
        default_provider: AgentProvider::CODEX,
        models: Vec::new(),
        collaboration_modes: Vec::new(),
        account: falcondeck_core::AccountSummary::default(),
        current_thread_id: Some("thread-1".to_string()),
        connected_at: Utc::now(),
        updated_at: Utc::now(),
        last_error: None,
    };
    app.inner.workspaces.lock().await.insert(
        workspace_id,
        super::ManagedWorkspace {
            summary: workspace,
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [("thread-1".to_string(), super::ManagedThread::new(thread))]
                .into_iter()
                .collect(),
        },
    );

    app.shutdown().await.unwrap();

    let snapshot = app.snapshot().await;
    assert_eq!(snapshot.threads.len(), 1);
    assert_eq!(snapshot.threads[0].status, ThreadStatus::Error);
    assert_eq!(
        snapshot.threads[0].last_error.as_deref(),
        Some("FalconDeck was closed while this turn was running")
    );

    let persisted_after: PersistedAppState =
        serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
    assert_eq!(
        persisted_after.workspaces[0].thread_states[0].status,
        Some(ThreadStatus::Error)
    );
    assert_eq!(
        persisted_after.workspaces[0].thread_states[0]
            .last_error
            .as_deref(),
        Some("FalconDeck was closed while this turn was running")
    );
}

#[tokio::test]
async fn shutdown_marks_waiting_threads_as_error_and_persists_them() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-waiting");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    let workspace_id = "workspace-1".to_string();
    let mut thread = ThreadSummary {
        id: "thread-1".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Waiting thread".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: Some("native-session-1".to_string()),
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::WaitingForInput,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };
    thread.status = ThreadStatus::WaitingForInput;
    let workspace = WorkspaceSummary {
        kind: falcondeck_core::WorkspaceKind::Project,
        id: workspace_id.clone(),
        path: workspace_path.to_string_lossy().to_string(),
        status: WorkspaceStatus::Busy,
        agents: Vec::new(),
        skills: Vec::new(),
        default_provider: AgentProvider::CODEX,
        models: Vec::new(),
        collaboration_modes: Vec::new(),
        account: falcondeck_core::AccountSummary::default(),
        current_thread_id: Some("thread-1".to_string()),
        connected_at: Utc::now(),
        updated_at: Utc::now(),
        last_error: None,
    };
    app.inner.workspaces.lock().await.insert(
        workspace_id,
        super::ManagedWorkspace {
            summary: workspace,
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [("thread-1".to_string(), super::ManagedThread::new(thread))]
                .into_iter()
                .collect(),
        },
    );

    app.shutdown().await.unwrap();

    let snapshot = app.snapshot().await;
    assert_eq!(snapshot.threads[0].status, ThreadStatus::Error);
    assert_eq!(
        snapshot.threads[0].last_error.as_deref(),
        Some("FalconDeck was closed while this turn was running")
    );
}

#[tokio::test]
async fn provider_disconnect_fails_only_that_providers_active_threads() {
    let temp_dir = tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );
    let workspace_id = "workspace-1".to_string();
    let make_thread = |id: &str, provider: AgentProvider| ThreadSummary {
        id: id.to_string(),
        workspace_id: workspace_id.clone(),
        title: id.to_string(),
        provider,
        native_session_id: Some(format!("native-{id}")),
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Running,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };
    let codex = make_thread("codex-thread", AgentProvider::CODEX);
    let claude = make_thread("claude-thread", AgentProvider::CLAUDE);
    let workspace = WorkspaceSummary {
        kind: falcondeck_core::WorkspaceKind::Project,
        id: workspace_id.clone(),
        path: temp_dir.path().to_string_lossy().to_string(),
        status: WorkspaceStatus::Busy,
        agents: Vec::new(),
        skills: Vec::new(),
        default_provider: AgentProvider::CODEX,
        models: Vec::new(),
        collaboration_modes: Vec::new(),
        account: falcondeck_core::AccountSummary::default(),
        current_thread_id: Some("codex-thread".to_string()),
        connected_at: Utc::now(),
        updated_at: Utc::now(),
        last_error: None,
    };
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: workspace,
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [codex, claude]
                .into_iter()
                .map(|thread| (thread.id.clone(), super::ManagedThread::new(thread)))
                .collect(),
        },
    );
    let mut events = app.subscribe();

    app.fail_active_provider_threads(&workspace_id, &AgentProvider::CODEX, "Codex disconnected")
        .await;

    let snapshot = app.snapshot().await;
    let codex = snapshot
        .threads
        .iter()
        .find(|thread| thread.id == "codex-thread")
        .unwrap();
    let claude = snapshot
        .threads
        .iter()
        .find(|thread| thread.id == "claude-thread")
        .unwrap();
    assert_eq!(codex.status, ThreadStatus::Error);
    assert_eq!(codex.last_error.as_deref(), Some("Codex disconnected"));
    assert_eq!(claude.status, ThreadStatus::Running);
    assert!(matches!(
        events.recv().await.unwrap().event.clone(),
        falcondeck_core::UnifiedEvent::ThreadUpdated { thread }
            if thread.id == "codex-thread" && thread.status == ThreadStatus::Error
    ));

    let persisted: PersistedAppState =
        serde_json::from_slice(&tokio::fs::read(state_path).await.unwrap()).unwrap();
    let persisted_codex = persisted.workspaces[0]
        .thread_states
        .iter()
        .find(|thread| thread.thread_id == "codex-thread")
        .unwrap();
    assert_eq!(persisted_codex.status, Some(ThreadStatus::Error));
}

#[tokio::test]
async fn restore_skips_legacy_loopback_remote_pairing() {
    let temp_dir = tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let persisted = PersistedAppState {
        workspaces: vec![],
        remote: Some(PersistedRemoteState {
            relay_url: "http://127.0.0.1:54871".to_string(),
            daemon_token: "daemon-token".to_string(),
            pairing_id: "pairing-legacy".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: None,
            device_id: None,
            trusted_at: None,
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: None,
            client_public_key: None,
            secure_storage_key: None,
            local_secret_key_base64: Some(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            ),
            data_key_base64: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string()),
            trusted_client_bundles: Vec::new(),
            trusted_client_devices: HashMap::new(),
        }),
    };

    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );
    app.restore_local_state().await.unwrap();

    let remote = app.inner.remote.lock().await;
    assert_eq!(
        remote.status,
        falcondeck_core::RemoteConnectionStatus::Inactive
    );
    assert!(remote.relay_url.is_none());
    assert!(remote.daemon_token.is_none());
    assert!(remote.pairing.is_none());
    drop(remote);

    let persisted_after: PersistedAppState =
        serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
    assert!(persisted_after.remote.is_none());
}

#[tokio::test]
async fn restore_skips_trusted_remote_with_legacy_unsigned_client_key() {
    let temp_dir = tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let persisted = PersistedAppState {
        workspaces: vec![],
        remote: Some(PersistedRemoteState {
            relay_url: "https://connect.falcondeck.com".to_string(),
            daemon_token: "daemon-token".to_string(),
            pairing_id: "pairing-legacy-client".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: Some("device-1".to_string()),
            trusted_at: Some(Utc::now()),
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: None,
            client_public_key: Some("legacy-public-key".to_string()),
            secure_storage_key: None,
            local_secret_key_base64: Some(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            ),
            data_key_base64: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string()),
            trusted_client_bundles: Vec::new(),
            trusted_client_devices: HashMap::new(),
        }),
    };

    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );
    app.restore_local_state().await.unwrap();

    let remote = app.inner.remote.lock().await;
    assert_eq!(
        remote.status,
        falcondeck_core::RemoteConnectionStatus::Inactive
    );
    assert!(remote.relay_url.is_none());
    assert!(remote.daemon_token.is_none());
    assert!(remote.pairing.is_none());
    drop(remote);

    let persisted_after: PersistedAppState =
        serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
    assert!(persisted_after.remote.is_none());
}

#[tokio::test]
async fn persisted_remote_state_moves_secrets_out_of_the_state_file() {
    let temp_dir = tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let relay_url = "https://connect.falcondeck.com/persist".to_string();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );
    let pairing = super::RemotePairingState {
        pairing_id: "pairing-1".to_string(),
        pairing_code: "ABCDEFGHJKLM".to_string(),
        session_id: Some("session-1".to_string()),
        device_id: Some("device-1".to_string()),
        trusted_at: Some(Utc::now()),
        expires_at: Utc::now() + Duration::minutes(10),
        client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
        local_key_pair: LocalBoxKeyPair::generate(),
        data_key: generate_data_key(),
    };
    let expected_secret = pairing.local_key_pair.secret_key_base64();
    let expected_data_key = encode_base64(&pairing.data_key);

    {
        let mut remote = app.inner.remote.lock().await;
        remote.status = falcondeck_core::RemoteConnectionStatus::DeviceTrusted;
        remote.relay_url = Some(relay_url.clone());
        remote.daemon_token = Some("daemon-token".to_string());
        remote.pairing = Some(pairing);
        remote.pending_pairing = None;
    }

    app.persist_local_state().await.unwrap();

    let persisted_after: PersistedAppState =
        serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
    let persisted_remote = persisted_after.remote.expect("persisted remote state");
    assert!(persisted_remote.secure_storage_key.is_some());
    assert!(persisted_remote.local_secret_key_base64.is_none());
    assert!(persisted_remote.data_key_base64.is_none());

    let stored = super::load_remote_secrets_from_secure_storage(
        persisted_remote
            .secure_storage_key
            .as_deref()
            .expect("secure storage key"),
    )
    .unwrap();
    assert_eq!(stored.local_secret_key_base64, expected_secret);
    assert_eq!(stored.data_key_base64, expected_data_key);
}

#[tokio::test]
async fn restore_reads_remote_secrets_from_secure_storage() {
    let temp_dir = tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let relay_url = "https://connect.falcondeck.com/restore".to_string();
    let secure_storage_key = format!("{relay_url}|session-1");
    super::save_remote_secrets_to_secure_storage(
        &secure_storage_key,
        &PersistedRemoteSecrets {
            local_secret_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            data_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
        },
    )
    .unwrap();
    let persisted = PersistedAppState {
        workspaces: vec![],
        remote: Some(PersistedRemoteState {
            relay_url,
            daemon_token: "daemon-token".to_string(),
            pairing_id: "pairing-1".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: Some("device-1".to_string()),
            trusted_at: Some(Utc::now()),
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: Some(build_pairing_public_key_bundle(&LocalBoxKeyPair::generate())),
            client_public_key: None,
            secure_storage_key: Some(secure_storage_key),
            local_secret_key_base64: None,
            data_key_base64: None,
            trusted_client_bundles: Vec::new(),
            trusted_client_devices: HashMap::new(),
        }),
    };

    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );
    app.restore_local_state().await.unwrap();

    let remote = app.inner.remote.lock().await;
    assert!(matches!(
        remote.status,
        falcondeck_core::RemoteConnectionStatus::DeviceTrusted
            | falcondeck_core::RemoteConnectionStatus::Connecting
    ));
    assert_eq!(
        remote.relay_url.as_deref(),
        Some("https://connect.falcondeck.com/restore")
    );
    assert!(remote.pairing.is_some());
}

#[tokio::test]
async fn restore_keeps_trusted_remote_without_client_bundle() {
    let temp_dir = tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let relay_url = "https://connect.falcondeck.com/restore-legacy".to_string();
    let secure_storage_key = format!("{relay_url}|session-1");
    super::save_remote_secrets_to_secure_storage(
        &secure_storage_key,
        &PersistedRemoteSecrets {
            local_secret_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            data_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
        },
    )
    .unwrap();
    let persisted = PersistedAppState {
        workspaces: vec![],
        remote: Some(PersistedRemoteState {
            relay_url,
            daemon_token: "daemon-token".to_string(),
            pairing_id: "pairing-1".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: Some("device-1".to_string()),
            trusted_at: Some(Utc::now()),
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: None,
            client_public_key: None,
            secure_storage_key: Some(secure_storage_key),
            local_secret_key_base64: None,
            data_key_base64: None,
            trusted_client_bundles: Vec::new(),
            trusted_client_devices: HashMap::new(),
        }),
    };

    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .await
        .unwrap();

    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );
    app.restore_local_state().await.unwrap();

    let remote = app.inner.remote.lock().await;
    assert!(matches!(
        remote.status,
        falcondeck_core::RemoteConnectionStatus::DeviceTrusted
            | falcondeck_core::RemoteConnectionStatus::Connecting
    ));
    assert_eq!(
        remote.relay_url.as_deref(),
        Some("https://connect.falcondeck.com/restore-legacy")
    );
    assert_eq!(
        remote
            .pairing
            .as_ref()
            .and_then(|pairing| pairing.client_bundle.as_ref()),
        None
    );
}

#[test]
fn invalid_session_token_does_not_force_pairing_reset() {
    assert!(!super::should_clear_persisted_remote_for_bridge_error(
        "relay websocket ticket request failed with status 401 Unauthorized: invalid session token",
        false,
    ));
    assert!(super::is_remote_bridge_auth_error("invalid session token"));
}

#[test]
fn session_not_found_forces_reset_for_untrusted_pairings() {
    assert!(super::should_clear_persisted_remote_for_bridge_error(
        "relay websocket ticket request failed with status 404 Not Found: session not found",
        false,
    ));
    assert!(!super::is_remote_bridge_auth_error("session not found"));
}

#[test]
fn session_not_found_does_not_force_reset_for_trusted_pairings() {
    assert!(!super::should_clear_persisted_remote_for_bridge_error(
        "relay websocket ticket request failed with status 404 Not Found: session not found",
        true,
    ));
}

#[tokio::test]
async fn streaming_item_updates_do_not_emit_thread_updated() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        temp_dir.path(),
    )
    .await;

    let mut events = app.subscribe();
    let item = |text: &str, lifecycle: ContentLifecycle| ConversationItem::AssistantMessage {
        id: "asst-1".to_string(),
        text: text.to_string(),
        phase: None,
        memory_citation: None,
        citations: Vec::new(),
        lifecycle,
        error: None,
        created_at: Utc::now(),
    };

    app.push_conversation_item(
        "workspace-1",
        "thread-1",
        item("Hel", ContentLifecycle::Streaming),
        true,
    )
    .await
    .unwrap();
    app.push_conversation_item(
        "workspace-1",
        "thread-1",
        item("Hello", ContentLifecycle::Streaming),
        true,
    )
    .await
    .unwrap();
    app.push_conversation_item(
        "workspace-1",
        "thread-1",
        item("Hello!", ContentLifecycle::Complete),
        true,
    )
    .await
    .unwrap();

    let emitted: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
    let added = emitted
        .iter()
        .filter(|envelope| matches!(envelope.event, UnifiedEvent::ConversationItemAdded { .. }))
        .count();
    let updated = emitted
        .iter()
        .filter(|envelope| matches!(envelope.event, UnifiedEvent::ConversationItemUpdated { .. }))
        .count();
    let text_deltas: Vec<&str> = emitted
        .iter()
        .filter_map(|envelope| match &envelope.event {
            UnifiedEvent::Text { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    let thread_updated = emitted
        .iter()
        .filter(|envelope| matches!(envelope.event, UnifiedEvent::ThreadUpdated { .. }))
        .count();

    assert_eq!(added, 1);
    assert_eq!(text_deltas, ["lo"]);
    assert_eq!(
        updated, 1,
        "only the completed item should replace the whole body"
    );
    assert_eq!(
        thread_updated, 1,
        "only the completed item should emit a summary; streaming chunks must not"
    );
}

#[tokio::test]
async fn streaming_rewrites_still_emit_conversation_item_updated() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        temp_dir.path(),
    )
    .await;

    let mut events = app.subscribe();
    let item = |text: &str| ConversationItem::AssistantMessage {
        id: "asst-1".to_string(),
        text: text.to_string(),
        phase: None,
        memory_citation: None,
        citations: Vec::new(),
        lifecycle: ContentLifecycle::Streaming,
        error: None,
        created_at: Utc::now(),
    };

    app.push_conversation_item("workspace-1", "thread-1", item("Hello"), true)
        .await
        .unwrap();
    app.push_conversation_item("workspace-1", "thread-1", item("Goodbye"), true)
        .await
        .unwrap();

    let emitted: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
    assert!(emitted.iter().any(|envelope| matches!(
        &envelope.event,
        UnifiedEvent::ConversationItemUpdated {
            item: ConversationItem::AssistantMessage { text, .. }
        } if text == "Goodbye"
    )));
    assert!(
        !emitted
            .iter()
            .any(|envelope| matches!(envelope.event, UnifiedEvent::Text { .. }))
    );
}

async fn insert_claude_workspace_with_session(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    native_session_id: &str,
    workspace_path: &std::path::Path,
) {
    app.inner.workspaces.lock().await.insert(
        workspace_id.to_string(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                kind: falcondeck_core::WorkspaceKind::Project,
                id: workspace_id.to_string(),
                path: workspace_path.to_string_lossy().to_string(),
                status: WorkspaceStatus::Ready,
                agents: Vec::new(),
                skills: Vec::new(),
                default_provider: AgentProvider::CLAUDE,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: Some(thread_id.to_string()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [(
                thread_id.to_string(),
                super::ManagedThread::new(ThreadSummary {
                    id: thread_id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    title: "Claude thread".to_string(),
                    provider: AgentProvider::CLAUDE,
                    native_session_id: Some(native_session_id.to_string()),
                    provider_transport: None,
                    handoff_from: None,
                    origin: None,
                    status: ThreadStatus::Running,
                    updated_at: Utc::now(),
                    last_message_preview: None,
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
                }),
            )]
            .into_iter()
            .collect(),
        },
    );
}

async fn wait_for_pending_claude_request(app: &AppState, workspace_id: &str) -> String {
    for _ in 0..200 {
        {
            let requests = app.inner.interactive_requests.lock().await;
            if let Some((_, request_id)) = requests
                .keys()
                .find(|(request_workspace_id, _)| request_workspace_id == workspace_id)
            {
                return request_id.clone();
            }
        }
        sleep(TokioDuration::from_millis(10)).await;
    }
    panic!("interactive request never appeared for {workspace_id}");
}

fn claude_pre_tool_use_payload(session_id: &str, tool_name: &str) -> serde_json::Value {
    json!({
        "session_id": session_id,
        "tool_name": tool_name,
        "tool_input": { "command": "ls -la" },
        "cwd": "/tmp/project"
    })
}

#[tokio::test]
async fn claude_pre_tool_use_approval_round_trips_through_interactive_requests() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "11111111-1111-4111-8111-111111111111",
        temp_dir.path(),
    )
    .await;

    let hook_task = tokio::spawn({
        let app = app.clone();
        async move {
            app.handle_claude_pre_tool_use(claude_pre_tool_use_payload(
                "11111111-1111-4111-8111-111111111111",
                "Bash",
            ))
            .await
        }
    });

    let request_id = wait_for_pending_claude_request(&app, "workspace-1").await;
    {
        let requests = app.inner.interactive_requests.lock().await;
        let pending = requests
            .get(&("workspace-1".to_string(), request_id.clone()))
            .unwrap();
        assert_eq!(pending.request.kind, InteractiveRequestKind::Approval);
        assert_eq!(pending.request.title, "Allow Bash?");
        assert_eq!(pending.request.command.as_deref(), Some("ls -la"));
    }
    let thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_eq!(thread.status, ThreadStatus::WaitingForInput);

    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        request_id,
        falcondeck_core::InteractiveResponsePayload::Approval {
            decision: falcondeck_core::ApprovalDecision::Allow,
        },
    )
    .await
    .unwrap();

    let response = hook_task.await.unwrap();
    assert_eq!(
        response["hookSpecificOutput"]["permissionDecision"],
        "allow"
    );
    assert_eq!(
        response["hookSpecificOutput"]["hookEventName"],
        "PreToolUse"
    );
    let thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_eq!(thread.status, ThreadStatus::Running);
    assert!(app.inner.interactive_requests.lock().await.is_empty());
    assert!(app.inner.claude_approvals.lock().await.is_empty());
}

#[tokio::test]
async fn answering_one_of_two_concurrent_approvals_keeps_the_thread_waiting() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "77777777-7777-4777-8777-777777777777",
        temp_dir.path(),
    )
    .await;

    let first_hook = tokio::spawn({
        let app = app.clone();
        async move {
            app.handle_claude_pre_tool_use(claude_pre_tool_use_payload(
                "77777777-7777-4777-8777-777777777777",
                "Bash",
            ))
            .await
        }
    });
    let first_id = wait_for_pending_claude_request(&app, "workspace-1").await;
    let second_hook = tokio::spawn({
        let app = app.clone();
        async move {
            app.handle_claude_pre_tool_use(claude_pre_tool_use_payload(
                "77777777-7777-4777-8777-777777777777",
                "Write",
            ))
            .await
        }
    });
    let second_id = loop {
        let requests = app.inner.interactive_requests.lock().await;
        let other = requests
            .keys()
            .find(|(workspace, request)| workspace == "workspace-1" && request != &first_id)
            .map(|(_, request)| request.clone());
        drop(requests);
        if let Some(id) = other {
            break id;
        }
        sleep(TokioDuration::from_millis(10)).await;
    };

    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        first_id,
        falcondeck_core::InteractiveResponsePayload::Approval {
            decision: falcondeck_core::ApprovalDecision::Allow,
        },
    )
    .await
    .unwrap();
    first_hook.await.unwrap();

    // The second approval is still pending; flipping the thread back to
    // Running now would hide the remaining prompt.
    let thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_eq!(thread.status, ThreadStatus::WaitingForInput);

    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        second_id,
        falcondeck_core::InteractiveResponsePayload::Approval {
            decision: falcondeck_core::ApprovalDecision::Allow,
        },
    )
    .await
    .unwrap();
    second_hook.await.unwrap();

    let thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_eq!(thread.status, ThreadStatus::Running);
    assert!(app.inner.interactive_requests.lock().await.is_empty());
}

#[tokio::test]
async fn claude_pre_tool_use_ignores_unknown_sessions() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );

    let response = app
        .handle_claude_pre_tool_use(claude_pre_tool_use_payload("unknown-session", "Bash"))
        .await;

    assert_eq!(response, json!({}));
    assert!(app.inner.interactive_requests.lock().await.is_empty());
}

#[tokio::test]
async fn claude_pre_tool_use_auto_allows_subagent_spawns() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "55555555-5555-4555-8555-555555555555",
        temp_dir.path(),
    )
    .await;

    // Both the current tool name and its former one: the spawn itself is
    // side-effect-free, and the sub-agent's tools are gated individually.
    for tool_name in ["Agent", "Task"] {
        let response = app
            .handle_claude_pre_tool_use(claude_pre_tool_use_payload(
                "55555555-5555-4555-8555-555555555555",
                tool_name,
            ))
            .await;
        assert_eq!(
            response["hookSpecificOutput"]["permissionDecision"], "allow",
            "{tool_name} spawns must not raise approval cards"
        );
    }
    assert!(app.inner.interactive_requests.lock().await.is_empty());
    let thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_ne!(thread.status, ThreadStatus::WaitingForInput);
}

#[tokio::test]
async fn claude_ask_user_question_is_never_auto_allowed() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        temp_dir.path(),
    )
    .await;
    app.with_thread_mut("workspace-1", "thread-1", |thread| {
        thread.agent.permission_mode = Some("bypassPermissions".to_string());
    })
    .await
    .unwrap();

    let hook_task = tokio::spawn({
        let app = app.clone();
        async move {
            app.handle_claude_pre_tool_use(json!({
                "session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "tool_name": "AskUserQuestion",
                "tool_input": {
                    "questions": [{
                        "question": "Which flavor?",
                        "header": "Flavor",
                        "options": [
                            { "label": "Vanilla", "description": "classic" },
                            { "label": "Chocolate", "description": "rich" }
                        ]
                    }]
                }
            }))
            .await
        }
    });

    let request_id = wait_for_pending_claude_request(&app, "workspace-1").await;
    {
        let requests = app.inner.interactive_requests.lock().await;
        let pending = requests
            .get(&("workspace-1".to_string(), request_id.clone()))
            .unwrap();
        assert_eq!(pending.request.kind, InteractiveRequestKind::Question);
        assert_eq!(pending.request.questions[0].question, "Which flavor?");
    }

    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        request_id,
        InteractiveResponsePayload::Question {
            answers: HashMap::from([("q0".to_string(), vec!["Vanilla".to_string()])]),
        },
    )
    .await
    .unwrap();

    let response = hook_task.await.unwrap();
    assert_eq!(
        response["hookSpecificOutput"]["permissionDecision"],
        "allow"
    );
    assert_eq!(
        response["hookSpecificOutput"]["updatedInput"]["answers"]["Which flavor?"],
        "Vanilla"
    );
}

#[tokio::test]
async fn claude_exit_plan_mode_prompts_even_in_bypass_and_restores_permission_mode() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        temp_dir.path(),
    )
    .await;
    app.with_managed_thread_mut("workspace-1", "thread-1", |thread| {
        thread.summary.agent.permission_mode = Some("plan".to_string());
        thread.claude_post_plan_permission_mode = Some("acceptEdits".to_string());
    })
    .await
    .unwrap();

    let hook_task = tokio::spawn({
        let app = app.clone();
        async move {
            app.handle_claude_pre_tool_use(json!({
                "session_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "tool_name": "ExitPlanMode",
                "tool_input": { "plan": "Ship the patch." }
            }))
            .await
        }
    });

    let request_id = wait_for_pending_claude_request(&app, "workspace-1").await;
    {
        let requests = app.inner.interactive_requests.lock().await;
        let pending = requests
            .get(&("workspace-1".to_string(), request_id.clone()))
            .unwrap();
        assert_eq!(pending.request.kind, InteractiveRequestKind::PlanApproval);
        assert_eq!(pending.request.detail.as_deref(), Some("Ship the patch."));
    }

    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        request_id,
        InteractiveResponsePayload::PlanApproval {
            outcome: PlanApprovalOutcome::Approved,
            feedback: None,
        },
    )
    .await
    .unwrap();

    let response = hook_task.await.unwrap();
    assert_eq!(
        response["hookSpecificOutput"]["permissionDecision"],
        "allow"
    );
    let thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_eq!(thread.agent.permission_mode.as_deref(), Some("acceptEdits"));
}

#[tokio::test]
async fn claude_exit_plan_mode_rejection_denies_with_feedback() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        temp_dir.path(),
    )
    .await;

    let hook_task = tokio::spawn({
        let app = app.clone();
        async move {
            app.handle_claude_pre_tool_use(json!({
                "session_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "tool_name": "ExitPlanMode",
                "tool_input": { "plan": "Ship the patch." }
            }))
            .await
        }
    });

    let request_id = wait_for_pending_claude_request(&app, "workspace-1").await;
    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        request_id,
        InteractiveResponsePayload::PlanApproval {
            outcome: PlanApprovalOutcome::Cancelled,
            feedback: Some("Add a rollback test".to_string()),
        },
    )
    .await
    .unwrap();

    let response = hook_task.await.unwrap();
    assert_eq!(response["hookSpecificOutput"]["permissionDecision"], "deny");
    let reason = response["hookSpecificOutput"]["permissionDecisionReason"]
        .as_str()
        .unwrap();
    assert!(reason.contains("Add a rollback test"));
}

#[tokio::test]
async fn claude_invalid_ask_user_question_denies_without_a_card() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        temp_dir.path(),
    )
    .await;

    let response = app
        .handle_claude_pre_tool_use(json!({
            "session_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "tool_name": "AskUserQuestion",
            "tool_input": { "questions": [] }
        }))
        .await;
    assert_eq!(response["hookSpecificOutput"]["permissionDecision"], "deny");
    assert!(app.inner.interactive_requests.lock().await.is_empty());
}

#[tokio::test]
async fn claude_pre_tool_use_labels_subagent_tool_calls() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "66666666-6666-4666-8666-666666666666",
        temp_dir.path(),
    )
    .await;

    // A tool call made inside a sub-agent carries agent_type/agent_id in the
    // hook payload; its work is invisible in the transcript, so the card must
    // say where the request comes from.
    let mut payload = claude_pre_tool_use_payload("66666666-6666-4666-8666-666666666666", "Bash");
    payload["agent_type"] = json!("general-purpose");
    payload["agent_id"] = json!("agent-123");
    let hook_task = tokio::spawn({
        let app = app.clone();
        async move { app.handle_claude_pre_tool_use(payload).await }
    });

    let request_id = wait_for_pending_claude_request(&app, "workspace-1").await;
    {
        let requests = app.inner.interactive_requests.lock().await;
        let pending = requests
            .get(&("workspace-1".to_string(), request_id.clone()))
            .unwrap();
        assert_eq!(
            pending.request.title,
            "Allow Bash? (sub-agent: general-purpose)"
        );
    }
    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        request_id.clone(),
        falcondeck_core::InteractiveResponsePayload::Approval {
            decision: falcondeck_core::ApprovalDecision::Deny,
        },
    )
    .await
    .unwrap();
    let response = hook_task.await.unwrap();
    assert_eq!(response["hookSpecificOutput"]["permissionDecision"], "deny");
    let workspaces = app.inner.workspaces.lock().await;
    let receipt = workspaces["workspace-1"].threads["thread-1"]
        .items
        .iter()
        .find(|item| matches!(item, ConversationItem::InteractiveRequest { id, .. } if id == &request_id))
        .expect("resolved approval receipt");
    assert!(matches!(
        receipt,
        ConversationItem::InteractiveRequest {
            resolved: true,
            resolution: Some(resolution),
            ..
        } if resolution.outcome == InteractiveRequestOutcome::Denied
    ));
}

#[tokio::test]
async fn claude_pre_tool_use_always_allow_short_circuits_later_calls() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "22222222-2222-4222-8222-222222222222",
        temp_dir.path(),
    )
    .await;

    let hook_task = tokio::spawn({
        let app = app.clone();
        async move {
            app.handle_claude_pre_tool_use(claude_pre_tool_use_payload(
                "22222222-2222-4222-8222-222222222222",
                "Bash",
            ))
            .await
        }
    });
    let request_id = wait_for_pending_claude_request(&app, "workspace-1").await;
    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        request_id,
        falcondeck_core::InteractiveResponsePayload::Approval {
            decision: falcondeck_core::ApprovalDecision::AlwaysAllow,
        },
    )
    .await
    .unwrap();
    let response = hook_task.await.unwrap();
    assert_eq!(
        response["hookSpecificOutput"]["permissionDecision"],
        "allow"
    );

    // The second call for the same tool must resolve without a new request.
    let response = app
        .handle_claude_pre_tool_use(claude_pre_tool_use_payload(
            "22222222-2222-4222-8222-222222222222",
            "Bash",
        ))
        .await;
    assert_eq!(
        response["hookSpecificOutput"]["permissionDecision"],
        "allow"
    );
    assert!(app.inner.interactive_requests.lock().await.is_empty());
    assert!(app.inner.claude_approvals.lock().await.is_empty());
}

#[tokio::test]
async fn claude_pre_tool_use_cleans_up_when_the_hook_client_disconnects() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "33333333-3333-4333-8333-333333333333",
        temp_dir.path(),
    )
    .await;

    // Simulate the hook's curl dying: axum drops the handler future while it
    // awaits the user's decision.
    let hook_task = tokio::spawn({
        let app = app.clone();
        async move {
            let _ = tokio::time::timeout(
                TokioDuration::from_millis(100),
                app.handle_claude_pre_tool_use(claude_pre_tool_use_payload(
                    "33333333-3333-4333-8333-333333333333",
                    "Bash",
                )),
            )
            .await;
        }
    });
    let request_id = wait_for_pending_claude_request(&app, "workspace-1").await;
    hook_task.await.unwrap();

    // Cleanup runs on a spawned task; allow it a moment to land.
    for _ in 0..200 {
        let maps_are_empty = app.inner.interactive_requests.lock().await.is_empty()
            && app.inner.claude_approvals.lock().await.is_empty();
        let item_is_cancelled = {
            let workspaces = app.inner.workspaces.lock().await;
            matches!(
                workspaces["workspace-1"].threads["thread-1"]
                    .items
                    .iter()
                    .find(|item| matches!(item, ConversationItem::InteractiveRequest { id, .. } if id == &request_id)),
                Some(ConversationItem::InteractiveRequest {
                    resolved: true,
                    resolution: Some(resolution),
                    ..
                }) if resolution.outcome == InteractiveRequestOutcome::Cancelled
            )
        };
        if maps_are_empty && item_is_cancelled {
            break;
        }
        sleep(TokioDuration::from_millis(10)).await;
    }
    assert!(app.inner.interactive_requests.lock().await.is_empty());
    assert!(app.inner.claude_approvals.lock().await.is_empty());
    let thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_eq!(thread.status, ThreadStatus::Running);
    let workspaces = app.inner.workspaces.lock().await;
    assert!(matches!(
        workspaces["workspace-1"].threads["thread-1"]
            .items
            .iter()
            .find(|item| matches!(item, ConversationItem::InteractiveRequest { id, .. } if id == &request_id)),
        Some(ConversationItem::InteractiveRequest {
            resolved: true,
            resolution: Some(resolution),
            ..
        }) if resolution.outcome == InteractiveRequestOutcome::Cancelled
    ));
}

#[tokio::test]
async fn claude_pre_tool_use_handles_concurrent_hook_calls_for_one_session() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    insert_claude_workspace_with_session(
        &app,
        "workspace-1",
        "thread-1",
        "44444444-4444-4444-8444-444444444444",
        temp_dir.path(),
    )
    .await;
    let spawn_hook = |app: &AppState| {
        tokio::spawn({
            let app = app.clone();
            async move {
                app.handle_claude_pre_tool_use(claude_pre_tool_use_payload(
                    "44444444-4444-4444-8444-444444444444",
                    "Bash",
                ))
                .await
            }
        })
    };

    let first_hook = spawn_hook(&app);
    let first_request_id = wait_for_pending_claude_request(&app, "workspace-1").await;
    let second_hook = spawn_hook(&app);
    let second_request_id = 'wait: {
        for _ in 0..200 {
            {
                let requests = app.inner.interactive_requests.lock().await;
                if let Some((_, request_id)) = requests
                    .keys()
                    .find(|(_, request_id)| request_id != &first_request_id)
                {
                    break 'wait request_id.clone();
                }
            }
            sleep(TokioDuration::from_millis(10)).await;
        }
        panic!("second concurrent hook call never registered its own request");
    };
    assert_ne!(first_request_id, second_request_id);

    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        first_request_id,
        falcondeck_core::InteractiveResponsePayload::Approval {
            decision: falcondeck_core::ApprovalDecision::AlwaysAllow,
        },
    )
    .await
    .unwrap();
    let response = first_hook.await.unwrap();
    assert_eq!(
        response["hookSpecificOutput"]["permissionDecision"],
        "allow"
    );

    // The second call was registered before the always-allow landed, so it
    // still resolves through its own pending request.
    app.respond_to_interactive_request(
        "workspace-1".to_string(),
        second_request_id,
        falcondeck_core::InteractiveResponsePayload::Approval {
            decision: falcondeck_core::ApprovalDecision::Allow,
        },
    )
    .await
    .unwrap();
    let response = second_hook.await.unwrap();
    assert_eq!(
        response["hookSpecificOutput"]["permissionDecision"],
        "allow"
    );

    // A third call short-circuits on the always-allow without a new request.
    let response = app
        .handle_claude_pre_tool_use(claude_pre_tool_use_payload(
            "44444444-4444-4444-8444-444444444444",
            "Bash",
        ))
        .await;
    assert_eq!(
        response["hookSpecificOutput"]["permissionDecision"],
        "allow"
    );
    assert!(app.inner.interactive_requests.lock().await.is_empty());
    assert!(app.inner.claude_approvals.lock().await.is_empty());
}

#[test]
fn interrupt_turn_statuses_do_not_notify_remote_attention() {
    for status in ["canceled", "Cancelled", "INTERRUPTED", " aborted "] {
        assert!(super::notifications::is_interrupt_turn_status(status));
    }
    for status in ["completed", "failed", ""] {
        assert!(!super::notifications::is_interrupt_turn_status(status));
    }
}

#[test]
fn failed_turn_statuses_are_errors_even_without_an_error_payload() {
    for status in ["failed", "Failure", "ERROR", " errored "] {
        assert!(super::notifications::is_failed_turn_status(status));
    }
    for status in ["completed", "cancelled", ""] {
        assert!(!super::notifications::is_failed_turn_status(status));
    }
}

#[test]
fn trusted_client_bundles_dedupe_by_public_key_and_stay_capped() {
    let mut trusted = Vec::new();
    let bundle = build_pairing_public_key_bundle(&LocalBoxKeyPair::generate());
    super::remember_trusted_client_bundle(&mut trusted, &bundle);
    super::remember_trusted_client_bundle(&mut trusted, &bundle);
    assert_eq!(trusted.len(), 1);

    for _ in 0..(super::MAX_TRUSTED_CLIENT_BUNDLES + 5) {
        super::remember_trusted_client_bundle(
            &mut trusted,
            &build_pairing_public_key_bundle(&LocalBoxKeyPair::generate()),
        );
    }
    assert_eq!(trusted.len(), super::MAX_TRUSTED_CLIENT_BUNDLES);
    // The original entry was the oldest and must have been evicted.
    assert!(
        !super::remote_bridge::is_trusted_client_bundle(&trusted, &bundle),
        "capped list should evict the oldest bundle"
    );
}

#[test]
fn bootstrap_requests_only_match_exact_trusted_bundles() {
    let trusted_key_pair = LocalBoxKeyPair::generate();
    let trusted_bundle = build_pairing_public_key_bundle(&trusted_key_pair);
    let trusted = vec![trusted_bundle.clone()];

    assert!(super::remote_bridge::is_trusted_client_bundle(
        &trusted,
        &trusted_bundle
    ));

    let attacker_bundle = build_pairing_public_key_bundle(&LocalBoxKeyPair::generate());
    assert!(!super::remote_bridge::is_trusted_client_bundle(
        &trusted,
        &attacker_bundle
    ));

    // Matching the encryption key alone is not enough: the identity key must
    // match too.
    let mut mixed_bundle = trusted_bundle.clone();
    mixed_bundle.identity_public_key = attacker_bundle.identity_public_key.clone();
    assert!(!super::remote_bridge::is_trusted_client_bundle(
        &trusted,
        &mixed_bundle
    ));
}

#[tokio::test]
async fn snapshot_with_request_excludes_archived_threads_for_mobile_clients() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    let workspace_id = "workspace-1".to_string();
    let active_thread = ThreadSummary {
        id: "thread-active".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Active thread".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Idle,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };
    let archived_thread = ThreadSummary {
        id: "thread-archived".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Archived thread".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Idle,
        updated_at: Utc::now(),
        last_message_preview: None,
        latest_turn_id: None,
        latest_plan: None,
        latest_diff: None,
        last_tool: None,
        last_error: None,
        agent: ThreadAgentParams::default(),
        attention: ThreadAttention::default(),
        is_archived: true,
        is_pinned: false,
        is_pinned_in_project: false,
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };

    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                kind: falcondeck_core::WorkspaceKind::Project,
                id: workspace_id.clone(),
                path: workspace_path.to_string_lossy().to_string(),
                status: WorkspaceStatus::Ready,
                agents: Vec::new(),
                skills: Vec::new(),
                default_provider: AgentProvider::CODEX,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: Some("thread-archived".to_string()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [
                (
                    active_thread.id.clone(),
                    super::ManagedThread::new(active_thread.clone()),
                ),
                (
                    archived_thread.id.clone(),
                    super::ManagedThread::new(archived_thread),
                ),
            ]
            .into_iter()
            .collect(),
        },
    );

    let active_request = InteractiveRequest {
        request_id: "request-active".to_string(),
        workspace_id: workspace_id.clone(),
        thread_id: Some(active_thread.id.clone()),
        method: "approval.respond".to_string(),
        kind: InteractiveRequestKind::Approval,
        approval_decisions: None,
        title: "Allow active".to_string(),
        detail: None,
        command: None,
        path: None,
        turn_id: None,
        item_id: None,
        questions: Vec::new(),
        created_at: Utc::now(),
    };
    let archived_request = InteractiveRequest {
        request_id: "request-archived".to_string(),
        workspace_id: workspace_id.clone(),
        thread_id: Some("thread-archived".to_string()),
        method: "approval.respond".to_string(),
        kind: InteractiveRequestKind::Approval,
        approval_decisions: None,
        title: "Allow archived".to_string(),
        detail: None,
        command: None,
        path: None,
        turn_id: None,
        item_id: None,
        questions: Vec::new(),
        created_at: Utc::now(),
    };
    app.inner.interactive_requests.lock().await.insert(
        (workspace_id.clone(), active_request.request_id.clone()),
        super::PendingServerRequest {
            raw_id: json!("raw-active"),
            request: active_request,
            params: serde_json::Value::Null,
        },
    );
    app.inner.interactive_requests.lock().await.insert(
        (workspace_id.clone(), archived_request.request_id.clone()),
        super::PendingServerRequest {
            raw_id: json!("raw-archived"),
            request: archived_request,
            params: serde_json::Value::Null,
        },
    );

    let snapshot = app
        .snapshot_with_request(&SnapshotRequest {
            include_archived_threads: false,
            ..SnapshotRequest::default()
        })
        .await;

    assert_eq!(
        snapshot
            .threads
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>(),
        vec!["thread-active"]
    );
    assert_eq!(snapshot.workspaces[0].current_thread_id, None);
    assert_eq!(
        snapshot
            .interactive_requests
            .iter()
            .map(|request| request.request_id.as_str())
            .collect::<Vec<_>>(),
        vec!["request-active"]
    );
}

#[tokio::test]
async fn snapshot_with_request_strips_duplicated_agent_skill_catalogs() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    let skill: falcondeck_core::SkillSummary = serde_json::from_value(serde_json::json!({
        "id": "skill-1",
        "label": "Deploy",
        "alias": "/deploy",
        "availability": "codex",
        "providers": ["codex"],
        "source_kind": "provider_native",
    }))
    .expect("skill fixture");
    let agent: falcondeck_core::WorkspaceAgentSummary = serde_json::from_value(serde_json::json!({
        "provider": "codex",
        "label": "Codex",
        "account": { "status": "ready", "label": "ready" },
        "skills": [skill],
    }))
    .expect("agent fixture");

    let workspace_id = "workspace-1".to_string();
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                kind: falcondeck_core::WorkspaceKind::Project,
                id: workspace_id.clone(),
                path: workspace_path.to_string_lossy().to_string(),
                status: WorkspaceStatus::Ready,
                agents: vec![agent],
                skills: Vec::new(),
                default_provider: AgentProvider::CODEX,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: None,
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: HashMap::new(),
        },
    );

    let full = app.snapshot_with_request(&SnapshotRequest::default()).await;
    assert_eq!(full.workspaces[0].agents[0].skills.len(), 1);

    // The catalog is repeated per agent per workspace and no client reads it,
    // so remote clients drop it from the encrypted payload.
    let slim = app
        .snapshot_with_request(&SnapshotRequest {
            include_agent_skills: false,
            ..SnapshotRequest::default()
        })
        .await;
    assert!(slim.workspaces[0].agents[0].skills.is_empty());
    // The workspace-level list the composer actually reads is untouched.
    assert_eq!(
        slim.workspaces[0].skills.len(),
        full.workspaces[0].skills.len()
    );
}

#[tokio::test]
async fn snapshot_with_request_strips_thread_plans_and_diffs_for_remote_clients() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        PathBuf::from(&state_path),
    );

    let workspace_id = "workspace-1".to_string();
    let thread = ThreadSummary {
        id: "thread-active".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Active thread".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Idle,
        updated_at: Utc::now(),
        last_message_preview: Some("hello".to_string()),
        latest_turn_id: None,
        latest_plan: Some(ThreadPlan {
            explanation: Some("implement the change".to_string()),
            steps: Vec::new(),
        }),
        latest_diff: Some("diff --git a/src/lib.rs b/src/lib.rs\n".to_string()),
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
    };

    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
                kind: falcondeck_core::WorkspaceKind::Project,
                id: workspace_id.clone(),
                path: workspace_path.to_string_lossy().to_string(),
                status: WorkspaceStatus::Ready,
                agents: Vec::new(),
                skills: Vec::new(),
                default_provider: AgentProvider::CODEX,
                models: Vec::new(),
                collaboration_modes: Vec::new(),
                account: falcondeck_core::AccountSummary::default(),
                current_thread_id: Some(thread.id.clone()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [(thread.id.clone(), super::ManagedThread::new(thread))]
                .into_iter()
                .collect(),
        },
    );

    let full = app.snapshot_with_request(&SnapshotRequest::default()).await;
    assert!(full.threads[0].latest_plan.is_some());
    assert!(full.threads[0].latest_diff.is_some());

    let slim = app
        .snapshot_with_request(&SnapshotRequest {
            include_thread_plans: false,
            include_thread_diffs: false,
            ..SnapshotRequest::default()
        })
        .await;
    assert_eq!(slim.threads[0].latest_plan, None);
    assert_eq!(slim.threads[0].latest_diff, None);
    assert_eq!(
        slim.threads[0].last_message_preview.as_deref(),
        Some("hello")
    );
}

#[test]
fn parses_and_verifies_bootstrap_request_ephemerals() {
    let key_pair = LocalBoxKeyPair::generate();
    let bundle = build_pairing_public_key_bundle(&key_pair);
    let body = json!({
        "kind": "request-bootstrap",
        "device_id": "device-1",
        "client_bundle": bundle.clone(),
    });

    let parsed = super::remote_bridge::parse_bootstrap_request(&body)
        .expect("valid bootstrap request should parse");
    assert_eq!(parsed.public_key, bundle.public_key);
    assert_eq!(parsed.identity_public_key, bundle.identity_public_key);
}

#[test]
fn ignores_non_bootstrap_or_malformed_ephemerals() {
    let key_pair = LocalBoxKeyPair::generate();
    let bundle = build_pairing_public_key_bundle(&key_pair);

    // Wrong kind.
    assert!(
        super::remote_bridge::parse_bootstrap_request(&json!({
            "kind": "something-else",
            "client_bundle": bundle.clone(),
        }))
        .is_none()
    );
    // Missing bundle.
    assert!(
        super::remote_bridge::parse_bootstrap_request(&json!({
            "kind": "request-bootstrap",
            "device_id": "device-1",
        }))
        .is_none()
    );
    // Bundle that does not deserialize.
    assert!(
        super::remote_bridge::parse_bootstrap_request(&json!({
            "kind": "request-bootstrap",
            "client_bundle": { "not": "a bundle" },
        }))
        .is_none()
    );
    // Not an object at all.
    assert!(super::remote_bridge::parse_bootstrap_request(&json!("request-bootstrap")).is_none());
}

#[test]
fn rejects_bootstrap_request_with_tampered_bundle_signature() {
    let key_pair = LocalBoxKeyPair::generate();
    let mut bundle = build_pairing_public_key_bundle(&key_pair);
    bundle.public_key = LocalBoxKeyPair::generate().public_key_base64().to_string();

    assert!(
        super::remote_bridge::parse_bootstrap_request(&json!({
            "kind": "request-bootstrap",
            "client_bundle": bundle,
        }))
        .is_none()
    );
}

#[tokio::test]
async fn dispatched_send_echoes_the_client_supplied_user_item_id() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-e");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );

    let workspace_id = "workspace-e".to_string();
    let thread = ThreadSummary {
        id: "thread-e".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Idle thread".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Idle,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };
    let workspace = WorkspaceSummary {
        kind: falcondeck_core::WorkspaceKind::Project,
        id: workspace_id.clone(),
        path: workspace_path.to_string_lossy().to_string(),
        status: WorkspaceStatus::Ready,
        agents: Vec::new(),
        skills: Vec::new(),
        default_provider: AgentProvider::CODEX,
        models: Vec::new(),
        collaboration_modes: Vec::new(),
        account: falcondeck_core::AccountSummary::default(),
        current_thread_id: Some("thread-e".to_string()),
        connected_at: Utc::now(),
        updated_at: Utc::now(),
        last_error: None,
    };
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: workspace,
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [("thread-e".to_string(), super::ManagedThread::new(thread))]
                .into_iter()
                .collect(),
        },
    );

    let request = falcondeck_core::SendTurnRequest {
        workspace_id: workspace_id.clone(),
        thread_id: "thread-e".to_string(),
        inputs: vec![falcondeck_core::TurnInputItem::Text {
            id: None,
            text: "optimistically rendered".to_string(),
        }],
        selected_skills: Vec::new(),
        provider: None,
        model_id: None,
        reasoning_effort: None,
        approval_policy: None,
        service_tier: None,
        permission_mode: None,
        sandbox_mode: None,
        steer: false,
        user_item_id: Some("user-clientchosen42".to_string()),
        resume_interrupted: false,
    };

    // Dispatch fails (no Codex session) after the user item is committed; the
    // echoed transcript entry must carry the client's id either way.
    let _ = app.send_turn(request).await;

    let workspaces = app.inner.workspaces.lock().await;
    let thread = workspaces
        .get(&workspace_id)
        .unwrap()
        .threads
        .get("thread-e")
        .unwrap();
    let user_ids: Vec<&str> = thread
        .items
        .iter()
        .filter_map(|item| match item {
            falcondeck_core::ConversationItem::UserMessage { id, .. } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(user_ids, vec!["user-clientchosen42"]);
}

#[tokio::test]
async fn sends_against_a_running_thread_queue_can_be_reordered_and_removed() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-q");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );

    let workspace_id = "workspace-q".to_string();
    let thread = ThreadSummary {
        id: "thread-q".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Running thread".to_string(),
        provider: AgentProvider::CODEX,
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Running,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };
    let workspace = WorkspaceSummary {
        kind: falcondeck_core::WorkspaceKind::Project,
        id: workspace_id.clone(),
        path: workspace_path.to_string_lossy().to_string(),
        status: WorkspaceStatus::Busy,
        agents: Vec::new(),
        skills: Vec::new(),
        default_provider: AgentProvider::CODEX,
        models: Vec::new(),
        collaboration_modes: Vec::new(),
        account: falcondeck_core::AccountSummary::default(),
        current_thread_id: Some("thread-q".to_string()),
        connected_at: Utc::now(),
        updated_at: Utc::now(),
        last_error: None,
    };
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: workspace,
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [("thread-q".to_string(), super::ManagedThread::new(thread))]
                .into_iter()
                .collect(),
        },
    );

    let request = falcondeck_core::SendTurnRequest {
        workspace_id: workspace_id.clone(),
        thread_id: "thread-q".to_string(),
        inputs: vec![falcondeck_core::TurnInputItem::Text {
            id: None,
            text: "queued follow-up".to_string(),
        }],
        selected_skills: Vec::new(),
        provider: None,
        model_id: None,
        reasoning_effort: None,
        approval_policy: None,
        service_tier: None,
        permission_mode: None,
        sandbox_mode: None,
        steer: false,
        user_item_id: None,
        resume_interrupted: false,
    };

    // Busy thread: the send queues instead of dispatching (dispatching would
    // fail here anyway — no Codex session — and would flip the thread to
    // Error, which the assertions below would catch).
    let response = app.send_turn(request.clone()).await.unwrap();
    assert_eq!(response.message.as_deref(), Some("queued"));
    let snapshot = app.snapshot().await;
    let summary = &snapshot.threads[0];
    assert_eq!(summary.status, ThreadStatus::Running);
    assert_eq!(summary.queued_turns.len(), 1);
    assert_eq!(summary.queued_turns[0].preview, "queued follow-up");

    let mut second_request = request.clone();
    second_request.inputs = vec![falcondeck_core::TurnInputItem::Text {
        id: None,
        text: "second follow-up".to_string(),
    }];
    app.send_turn(second_request).await.unwrap();
    let snapshot = app.snapshot().await;
    let first_id = snapshot.threads[0].queued_turns[0].id.clone();
    let second_id = snapshot.threads[0].queued_turns[1].id.clone();
    app.reorder_queued_turns(
        &workspace_id,
        "thread-q",
        &[second_id.clone(), first_id.clone()],
    )
    .await
    .unwrap();
    let snapshot = app.snapshot().await;
    assert_eq!(
        snapshot.threads[0].queued_turns[0].preview,
        "second follow-up"
    );
    let workspaces = app.inner.workspaces.lock().await;
    let queued_text = match &workspaces
        .get(&workspace_id)
        .unwrap()
        .threads
        .get("thread-q")
        .unwrap()
        .queued_requests[0]
        .request
        .inputs[0]
    {
        falcondeck_core::TurnInputItem::Text { text, .. } => text,
        _ => panic!("expected queued text"),
    };
    assert_eq!(queued_text, "second follow-up");
    drop(workspaces);
    assert!(
        app.reorder_queued_turns(&workspace_id, "thread-q", std::slice::from_ref(&first_id))
            .await
            .is_err(),
        "partial orders are rejected"
    );

    // Queued turns are removable before dispatch.
    app.remove_queued_turn(&workspace_id, "thread-q", &first_id)
        .await
        .unwrap();
    app.remove_queued_turn(&workspace_id, "thread-q", &second_id)
        .await
        .unwrap();
    let snapshot = app.snapshot().await;
    assert!(snapshot.threads[0].queued_turns.is_empty());
    let twice = app
        .remove_queued_turn(&workspace_id, "thread-q", &first_id)
        .await
        .expect("a second remove is a reconcile no-op");
    assert_eq!(twice.message.as_deref(), Some("already gone"));
}

/// Builds a workspace holding one busy thread on `provider`, with that
/// provider's capabilities as given, for the steer-vs-queue cases below.
async fn busy_thread_app(
    temp_dir: &tempfile::TempDir,
    provider: AgentProvider,
    capabilities: falcondeck_core::AgentCapabilitySummary,
) -> (AppState, String) {
    let workspace_path = temp_dir.path().join("project-steer");
    std::fs::create_dir_all(&workspace_path).unwrap();
    // A cold Codex workspace now wakes on demand. Keep these routing tests
    // hermetic rather than accidentally launching the developer's real Codex
    // binary when they intentionally attach no runtime to the fixture.
    let provider_bins = if provider == AgentProvider::CODEX {
        HashMap::from([(
            AgentProvider::CODEX,
            temp_dir
                .path()
                .join("missing-codex-for-steer-test")
                .to_string_lossy()
                .to_string(),
        )])
    } else {
        HashMap::new()
    };
    let app = AppState::new_with_state_path(
        "test".to_string(),
        provider_bins,
        temp_dir.path().join("daemon-state.json"),
    );
    let workspace_id = "workspace-steer".to_string();
    let thread = ThreadSummary {
        id: "thread-steer".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Running thread".to_string(),
        provider: provider.clone(),
        native_session_id: None,
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Running,
        updated_at: Utc::now(),
        last_message_preview: None,
        latest_turn_id: Some("turn-steer-active".to_string()),
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
    };
    let workspace = WorkspaceSummary {
        kind: falcondeck_core::WorkspaceKind::Project,
        id: workspace_id.clone(),
        path: workspace_path.to_string_lossy().to_string(),
        status: WorkspaceStatus::Busy,
        agents: vec![falcondeck_core::WorkspaceAgentSummary {
            provider: provider.clone(),
            label: provider.to_string(),
            account: falcondeck_core::AccountSummary::default(),
            models: Vec::new(),
            collaboration_modes: Vec::new(),
            skills: Vec::new(),
            capabilities,
        }],
        skills: Vec::new(),
        default_provider: provider,
        models: Vec::new(),
        collaboration_modes: Vec::new(),
        account: falcondeck_core::AccountSummary::default(),
        current_thread_id: Some("thread-steer".to_string()),
        connected_at: Utc::now(),
        updated_at: Utc::now(),
        last_error: None,
    };
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: workspace,
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [(
                "thread-steer".to_string(),
                super::ManagedThread::new(thread),
            )]
            .into_iter()
            .collect(),
        },
    );
    (app, workspace_id)
}

#[tokio::test]
async fn queued_turn_is_persisted_before_enqueue_returns() {
    let temp_dir = tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CLAUDE,
        falcondeck_core::AgentCapabilitySummary::claude(),
    )
    .await;

    app.send_turn(steer_request(&workspace_id, false))
        .await
        .unwrap();

    let persisted = super::load_persisted_app_state(&state_path).await.unwrap();
    let queued = &persisted.workspaces[0].thread_states[0].queued_requests[0];
    assert_eq!(queued.summary.text, "actually, use the other endpoint");

    let restored =
        AppState::new_with_state_path("test".to_string(), HashMap::new(), state_path.clone());
    restored.restore_local_state().await.unwrap();
    let snapshot = restored.snapshot().await;
    assert_eq!(snapshot.threads[0].queued_turns.len(), 1);
    assert_eq!(
        snapshot.threads[0].queued_turns[0].text,
        "actually, use the other endpoint"
    );
}

fn steer_request(workspace_id: &str, steer: bool) -> falcondeck_core::SendTurnRequest {
    falcondeck_core::SendTurnRequest {
        workspace_id: workspace_id.to_string(),
        thread_id: "thread-steer".to_string(),
        inputs: vec![falcondeck_core::TurnInputItem::Text {
            id: None,
            text: "actually, use the other endpoint".to_string(),
        }],
        selected_skills: Vec::new(),
        provider: None,
        model_id: None,
        reasoning_effort: None,
        approval_policy: None,
        service_tier: None,
        permission_mode: None,
        sandbox_mode: None,
        steer,
        user_item_id: None,
        resume_interrupted: false,
    }
}

#[tokio::test]
async fn a_send_without_steer_queues_even_where_the_provider_supports_steering() {
    let temp_dir = tempdir().unwrap();
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CLAUDE,
        falcondeck_core::AgentCapabilitySummary::claude(),
    )
    .await;

    let response = app
        .send_turn(steer_request(&workspace_id, false))
        .await
        .unwrap();

    assert_eq!(response.message.as_deref(), Some("queued"));
    assert_eq!(app.snapshot().await.threads[0].queued_turns.len(), 1);
}

#[tokio::test]
async fn a_steer_falls_back_to_the_queue_when_the_provider_cannot_steer() {
    let temp_dir = tempdir().unwrap();
    // ACP providers all steer now (cancel + re-prompt), so a steering-less
    // capability set has to be spelled out to exercise the queue fallback.
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::new("non-steering-acp"),
        falcondeck_core::AgentCapabilitySummary {
            supports_interrupt: true,
            ..Default::default()
        },
    )
    .await;

    // Providers without a steer path park the message rather than rejecting
    // or silently dropping it.
    let response = app
        .send_turn(steer_request(&workspace_id, true))
        .await
        .unwrap();

    assert_eq!(response.message.as_deref(), Some("queued"));
    let summary = &app.snapshot().await.threads[0];
    assert_eq!(summary.queued_turns.len(), 1);
    assert_eq!(summary.status, ThreadStatus::Running);
}

#[tokio::test]
async fn a_codex_steer_reaches_the_runtime_and_never_queues() {
    let temp_dir = tempdir().unwrap();
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CODEX,
        falcondeck_core::AgentCapabilitySummary::codex(),
    )
    .await;

    // No Codex session is attached, so reaching the provider now attempts the
    // cold wake and fails on the fixture's deliberately missing binary.
    let error = app
        .send_turn(steer_request(&workspace_id, true))
        .await
        .expect_err("steer must reach Codex");

    assert!(
        error.to_string().contains("failed to wake Codex"),
        "unexpected error: {error}"
    );
    let summary = &app.snapshot().await.threads[0];
    assert!(
        summary.queued_turns.is_empty(),
        "a Codex steer must not also queue the message"
    );
    assert_eq!(summary.status, ThreadStatus::Running);
}

#[tokio::test]
async fn a_steer_against_a_steering_provider_reaches_the_runtime_and_never_queues() {
    let temp_dir = tempdir().unwrap();
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CLAUDE,
        falcondeck_core::AgentCapabilitySummary::claude(),
    )
    .await;

    // No Claude runtime is attached, so the steer reaches the provider and
    // fails there. That failure is the assertion: the request took the steer
    // path rather than being parked in the queue.
    let error = app
        .send_turn(steer_request(&workspace_id, true))
        .await
        .expect_err("steer must reach the provider");

    assert!(
        error
            .to_string()
            .contains("not currently connected to Claude"),
        "unexpected error: {error}"
    );
    let summary = &app.snapshot().await.threads[0];
    assert!(
        summary.queued_turns.is_empty(),
        "a steer must not also queue the message"
    );
    // A failed steer leaves the running turn alone.
    assert_eq!(summary.status, ThreadStatus::Running);
}

#[test]
fn a_steer_race_where_the_turn_already_ended_downgrades_to_the_queue_path() {
    use super::workspace_ops::steer_error_downgrades_to_queue;
    use crate::error::DaemonError;

    // The turn ending between the busy check and the stdin write, or a dying
    // or wedged pipe, makes the steer unavailable — the send falls through to
    // the queue instead of erroring.
    for error in [
        DaemonError::BadRequest("no active Codex turn to steer".to_string()),
        DaemonError::BadRequest("no active claude turn to steer".to_string()),
        DaemonError::BadRequest("no active ACP turn to steer".to_string()),
        DaemonError::BadRequest("claude turn is no longer accepting input".to_string()),
        DaemonError::Process("timed out writing to claude turn".to_string()),
        DaemonError::Process("failed to write to claude turn: broken pipe".to_string()),
        DaemonError::Rpc(
            "{\"data\":{\"activeTurnNotSteerable\":{\"turnKind\":\"review\"}}}".to_string(),
        ),
        DaemonError::Rpc("expectedTurnId does not match the active turn".to_string()),
        DaemonError::Rpc("no active turn for thread".to_string()),
    ] {
        assert!(
            steer_error_downgrades_to_queue(&error),
            "{error} must fall back to the queue"
        );
    }
    // A workspace that is not connected at all is a real failure and must
    // still error the send (see the test above).
    for error in [
        DaemonError::BadRequest(
            "workspace workspace-steer is not currently connected to Claude".to_string(),
        ),
        DaemonError::NotFound("workspace not found".to_string()),
        DaemonError::Rpc("relay unavailable".to_string()),
    ] {
        assert!(
            !steer_error_downgrades_to_queue(&error),
            "{error} must fail the send"
        );
    }
}

#[tokio::test]
async fn a_steer_against_an_idle_thread_starts_a_normal_turn() {
    let temp_dir = tempdir().unwrap();
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CLAUDE,
        falcondeck_core::AgentCapabilitySummary::claude(),
    )
    .await;
    app.with_thread_mut(&workspace_id, "thread-steer", |thread| {
        thread.status = ThreadStatus::Idle;
    })
    .await
    .unwrap();

    // Nothing to steer into: the send must fall through to a normal dispatch,
    // which here fails on the missing runtime and marks the thread Error.
    let error = app
        .send_turn(steer_request(&workspace_id, true))
        .await
        .expect_err("dispatch must reach the provider");

    assert!(
        error
            .to_string()
            .contains("not currently connected to Claude"),
        "unexpected error: {error}"
    );
    let summary = &app.snapshot().await.threads[0];
    assert!(summary.queued_turns.is_empty());
    assert_eq!(summary.status, ThreadStatus::Error);
}

/// Queues `count` messages on the busy steer thread and returns their ids in
/// queue order.
async fn queue_messages(app: &AppState, workspace_id: &str, count: usize) -> Vec<String> {
    for index in 0..count {
        let mut request = steer_request(workspace_id, false);
        request.inputs = vec![falcondeck_core::TurnInputItem::Text {
            id: None,
            text: format!("queued {index}"),
        }];
        assert_eq!(
            app.send_turn(request).await.unwrap().message.as_deref(),
            Some("queued")
        );
    }
    app.snapshot().await.threads[0]
        .queued_turns
        .iter()
        .map(|queued| queued.id.clone())
        .collect()
}

#[tokio::test]
async fn a_failed_steer_of_a_queued_turn_puts_it_back_in_its_original_slot() {
    let temp_dir = tempdir().unwrap();
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CLAUDE,
        falcondeck_core::AgentCapabilitySummary::claude(),
    )
    .await;
    let queued_ids = queue_messages(&app, &workspace_id, 3).await;

    // No Claude runtime is attached, so the steer reaches the provider and
    // fails there — the failure the restore path exists for.
    let error = app
        .steer_queued_turn(&workspace_id, "thread-steer", &queued_ids[1])
        .await
        .expect_err("steer must reach the provider and fail");
    assert!(
        error
            .to_string()
            .contains("not currently connected to Claude"),
        "unexpected error: {error}"
    );

    let summary = &app.snapshot().await.threads[0];
    assert_eq!(
        summary
            .queued_turns
            .iter()
            .map(|queued| queued.preview.as_str())
            .collect::<Vec<_>>(),
        vec!["queued 0", "queued 1", "queued 2"],
        "a failed steer must restore the message at its original position"
    );
    assert_eq!(summary.status, ThreadStatus::Running);
}

#[tokio::test]
async fn a_queued_turn_cannot_be_steered_into_an_idle_thread() {
    let temp_dir = tempdir().unwrap();
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CLAUDE,
        falcondeck_core::AgentCapabilitySummary::claude(),
    )
    .await;
    let queued_ids = queue_messages(&app, &workspace_id, 1).await;
    app.with_thread_mut(&workspace_id, "thread-steer", |thread| {
        thread.status = ThreadStatus::Idle;
    })
    .await
    .unwrap();

    let error = app
        .steer_queued_turn(&workspace_id, "thread-steer", &queued_ids[0])
        .await
        .expect_err("there is no running turn to steer into");
    assert!(
        error.to_string().contains("no running turn"),
        "unexpected error: {error}"
    );
    assert_eq!(app.snapshot().await.threads[0].queued_turns.len(), 1);
}

#[tokio::test]
async fn a_queued_turn_cannot_be_steered_on_a_provider_without_steering() {
    let temp_dir = tempdir().unwrap();
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::new("non-steering-acp"),
        falcondeck_core::AgentCapabilitySummary {
            supports_interrupt: true,
            ..Default::default()
        },
    )
    .await;
    let queued_ids = queue_messages(&app, &workspace_id, 1).await;

    let error = app
        .steer_queued_turn(&workspace_id, "thread-steer", &queued_ids[0])
        .await
        .expect_err("provider cannot steer");
    assert!(
        error.to_string().contains("cannot steer"),
        "unexpected error: {error}"
    );
    assert_eq!(app.snapshot().await.threads[0].queued_turns.len(), 1);
}

#[tokio::test]
async fn steering_an_unknown_queued_id_is_a_reconcile_noop() {
    let temp_dir = tempdir().unwrap();
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CLAUDE,
        falcondeck_core::AgentCapabilitySummary::claude(),
    )
    .await;
    queue_messages(&app, &workspace_id, 1).await;

    let response = app
        .steer_queued_turn(&workspace_id, "thread-steer", "queued-nope")
        .await
        .expect("a missing queued id must not fail the steer");
    assert_eq!(response.message.as_deref(), Some("already gone"));
    assert_eq!(app.snapshot().await.threads[0].queued_turns.len(), 1);
}

#[tokio::test]
async fn pre_tool_use_honours_live_permission_mode_and_read_only_tools() {
    let temp_dir = tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    let workspace_id = "workspace-hook".to_string();
    let mut thread = ThreadSummary {
        id: "thread-hook".to_string(),
        workspace_id: workspace_id.clone(),
        title: "t".to_string(),
        provider: AgentProvider::CLAUDE,
        native_session_id: Some("sess-hook".to_string()),
        provider_transport: None,
        handoff_from: None,
        origin: None,
        status: ThreadStatus::Running,
        updated_at: Utc::now(),
        last_message_preview: None,
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
    };
    thread.agent.permission_mode = Some("bypassPermissions".to_string());
    let workspace = WorkspaceSummary {
        kind: falcondeck_core::WorkspaceKind::Project,
        id: workspace_id.clone(),
        path: temp_dir.path().to_string_lossy().to_string(),
        status: WorkspaceStatus::Busy,
        agents: Vec::new(),
        skills: Vec::new(),
        default_provider: AgentProvider::CLAUDE,
        models: Vec::new(),
        collaboration_modes: Vec::new(),
        account: falcondeck_core::AccountSummary::default(),
        current_thread_id: Some("thread-hook".to_string()),
        connected_at: Utc::now(),
        updated_at: Utc::now(),
        last_error: None,
    };
    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: workspace,
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: [("thread-hook".to_string(), super::ManagedThread::new(thread))]
                .into_iter()
                .collect(),
        },
    );

    // Bypass mode set on the thread NOW allows immediately — even though the
    // running turn was spawned before the mode changed.
    let decision = app
        .handle_claude_pre_tool_use(claude_pre_tool_use_payload("sess-hook", "Bash"))
        .await;
    assert_eq!(
        decision
            .pointer("/hookSpecificOutput/permissionDecision")
            .and_then(|value| value.as_str()),
        Some("allow"),
        "bypassPermissions must allow without prompting: {decision}"
    );

    // Back to default mode: read-only tools still never prompt.
    {
        let mut workspaces = app.inner.workspaces.lock().await;
        let thread = workspaces
            .get_mut(&workspace_id)
            .unwrap()
            .threads
            .get_mut("thread-hook")
            .unwrap();
        thread.summary.agent.permission_mode = None;
    }
    let decision = app
        .handle_claude_pre_tool_use(claude_pre_tool_use_payload("sess-hook", "Read"))
        .await;
    assert_eq!(
        decision
            .pointer("/hookSpecificOutput/permissionDecision")
            .and_then(|value| value.as_str()),
        Some("allow"),
        "read-only tools must not prompt: {decision}"
    );
}

#[test]
fn claude_error_events_keep_structured_causes() {
    use super::agent_helpers::extract_claude_error;

    // SSE-style API error: the message hides one level down in an object,
    // which the string-only extraction used to drop entirely.
    assert_eq!(
        extract_claude_error(&json!({
            "type": "error",
            "error": { "type": "overloaded_error", "message": "Overloaded" }
        }))
        .as_deref(),
        Some("Overloaded")
    );
    // Unfamiliar structured error: verbatim JSON beats reporting nothing.
    assert_eq!(
        extract_claude_error(&json!({
            "type": "error",
            "error": { "code": 529 }
        }))
        .as_deref(),
        Some(r#"{"code":529}"#)
    );
    // The result event's text still wins.
    assert_eq!(
        extract_claude_error(&json!({
            "type": "result",
            "is_error": true,
            "result": "Credit balance is too low"
        }))
        .as_deref(),
        Some("Credit balance is too low")
    );
    // Ordinary events stay silent.
    assert_eq!(
        extract_claude_error(&json!({ "type": "assistant", "message": { "id": "m1" } })),
        None
    );
    assert_eq!(
        extract_claude_error(&json!({ "type": "error", "error": null })),
        None
    );
}

#[test]
fn codex_turn_failures_keep_provider_detail() {
    use super::notifications::codex_turn_error_text;

    // message + data both survive.
    assert_eq!(
        codex_turn_error_text(&json!({
            "error": { "message": "stream error", "data": "insufficient credits" }
        }))
        .as_deref(),
        Some("stream error: insufficient credits")
    );
    // A structured error without a message is shown verbatim, not replaced
    // with the generic "Turn failed".
    assert_eq!(
        codex_turn_error_text(&json!({
            "error": { "code": -32000 }
        }))
        .as_deref(),
        Some(r#"{"code":-32000}"#)
    );
    assert_eq!(
        codex_turn_error_text(&json!({ "error": "rate limited" })).as_deref(),
        Some("rate limited")
    );
    assert_eq!(codex_turn_error_text(&json!({ "error": null })), None);
    assert_eq!(codex_turn_error_text(&json!({ "status": "failed" })), None);
}

#[tokio::test]
async fn backup_and_restore_cycle_restores_preferences_workspaces_and_extensions() {
    let temp = tempdir().unwrap();
    let state_path = temp.path().join("state.json");
    let app = AppState::new_with_state_path(
        "test-version".to_string(),
        HashMap::new(),
        state_path.clone(),
    );

    // Update preferences
    let updated_prefs = app
        .update_preferences(falcondeck_core::UpdatePreferencesRequest {
            workspace_colors: Some(std::collections::BTreeMap::from([(
                "ws-1".to_string(),
                "cat-3".to_string(),
            )])),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        updated_prefs
            .workspace_colors
            .get("ws-1")
            .map(String::as_str),
        Some("cat-3")
    );

    // Export backup
    let backup = app.export_backup().await.unwrap();
    assert_eq!(backup.version, falcondeck_core::BACKUP_SCHEMA_VERSION);
    assert_eq!(backup.app_version.as_deref(), Some("test-version"));
    assert_eq!(
        backup
            .daemon
            .preferences
            .workspace_colors
            .get("ws-1")
            .map(String::as_str),
        Some("cat-3")
    );

    // Inspect summary
    let summary = backup.summarize();
    assert_eq!(summary.version, falcondeck_core::BACKUP_SCHEMA_VERSION);

    // Create a new fresh daemon in a different state directory
    let temp_fresh = tempdir().unwrap();
    let fresh_state_path = temp_fresh.path().join("state.json");
    let fresh_app = AppState::new_with_state_path(
        "fresh-version".to_string(),
        HashMap::new(),
        fresh_state_path,
    );

    assert_ne!(
        fresh_app
            .preferences()
            .await
            .workspace_colors
            .get("ws-1")
            .map(String::as_str),
        Some("cat-3")
    );

    // Import backup into fresh daemon
    let import_result = fresh_app
        .import_backup(falcondeck_core::ImportBackupRequest {
            backup: backup.clone(),
            path_mappings: HashMap::new(),
        })
        .await
        .unwrap();

    assert!(import_result.preferences_restored);
    assert_eq!(
        fresh_app
            .preferences()
            .await
            .workspace_colors
            .get("ws-1")
            .map(String::as_str),
        Some("cat-3")
    );
}
