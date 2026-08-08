use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{Duration, Utc};
use falcondeck_core::{
    AgentProvider, ConversationItem, ImageInput, InteractiveRequest, InteractiveRequestKind,
    SnapshotRequest, ThreadAgentParams, ThreadAttention, ThreadStatus, ThreadSummary,
    ToolActivityKind, ToolHistoryMode, TurnInputItem, UpdateThreadRequest, WorkspaceStatus,
    WorkspaceSummary,
    crypto::{LocalBoxKeyPair, build_pairing_public_key_bundle, generate_data_key},
};
use serde_json::json;
use tempfile::tempdir;
use tokio::sync::mpsc;
use tokio::time::{Duration as TokioDuration, sleep};

use super::{
    AppState, PersistedAppState, PersistedRemoteSecrets, PersistedRemoteState,
    claude_prompt_from_inputs, codex_inputs, conversation_helpers::tool_display_metadata,
    encode_base64, notification_timestamp, should_surface_tool_item,
    workspace_status_after_account_update,
};

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
    assert!(crate::codex::parse_thread_goal(&json!({ "threadId": "t" })).is_none());
}

#[test]
fn maps_sandbox_modes_to_codex_policy_payloads() {
    use super::workspace_ops::sandbox_policy_payload;
    assert_eq!(
        sandbox_policy_payload(Some("read-only")),
        json!({ "type": "readOnly" })
    );
    assert_eq!(
        sandbox_policy_payload(Some("workspace-write")),
        json!({ "type": "workspaceWrite" })
    );
    assert_eq!(
        sandbox_policy_payload(Some("danger-full-access")),
        json!({ "type": "dangerFullAccess" })
    );
    assert_eq!(sandbox_policy_payload(None), serde_json::Value::Null);
    assert_eq!(
        sandbox_policy_payload(Some("bogus")),
        serde_json::Value::Null
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

#[test]
fn extracts_nested_claude_stream_text_and_result_payloads() {
    assert_eq!(
        super::extract_claude_text_delta(&json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": {
                    "type": "text_delta",
                    "text": "hi"
                }
            }
        })),
        Some("hi".to_string())
    );

    assert_eq!(
        super::extract_claude_text_delta(&json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "text", "text": "hello" }
                ]
            }
        })),
        Some("hello".to_string())
    );

    assert_eq!(
        super::extract_claude_text_delta(&json!({
            "type": "result",
            "subtype": "success",
            "result": "done"
        })),
        Some("done".to_string())
    );
}

#[test]
fn error_results_are_not_treated_as_assistant_text() {
    assert_eq!(
        super::extract_claude_text_delta(&json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "Something broke"
        })),
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
            output: None
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
            output: Some("match".to_string())
        })
    );
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
                current_thread_id: None,
                updated_at: None,
                default_provider: Some(AgentProvider::CODEX),
                last_error: None,
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
                thread_states: Vec::new(),
            },
            super::PersistedWorkspaceState {
                path: "/tmp/project-b".to_string(),
                current_thread_id: None,
                updated_at: None,
                default_provider: Some(AgentProvider::CODEX),
                last_error: None,
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
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
            current_thread_id: Some("thread-123".to_string()),
            updated_at: None,
            default_provider: Some(AgentProvider::CODEX),
            last_error: None,
            archived_thread_ids: Vec::new(),
            pinned_thread_ids: Vec::new(),
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
            acp_runtimes: HashMap::new(),
            threads: [(
                thread_id.clone(),
                super::ManagedThread::new(ThreadSummary {
                    id: thread_id.clone(),
                    workspace_id: workspace_id.clone(),
                    title: "Untitled thread".to_string(),
                    provider: AgentProvider::CODEX,
                    native_session_id: None,
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
            pinned: None,
            permission_mode: None,
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
        pinned: None,
        permission_mode: None,
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
            pinned: Some(true),
            permission_mode: None,
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
async fn restore_keeps_workspace_visible_when_reconnect_fails() {
    let temp_dir = tempdir().unwrap();
    let workspace_path = temp_dir.path().join("project-a");
    std::fs::create_dir_all(&workspace_path).unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let thread_updated_at = Utc::now() - Duration::minutes(6);
    let persisted = PersistedAppState {
        workspaces: vec![super::PersistedWorkspaceState {
            path: workspace_path.to_string_lossy().to_string(),
            current_thread_id: Some("thread-1".to_string()),
            updated_at: Some(Utc::now() - Duration::minutes(5)),
            default_provider: Some(AgentProvider::CLAUDE),
            last_error: Some("Previous reconnect failed".to_string()),
            archived_thread_ids: vec!["thread-1".to_string()],
            pinned_thread_ids: Vec::new(),
            thread_states: vec![super::PersistedThreadState {
                thread_id: "thread-1".to_string(),
                updated_at: Some(thread_updated_at),
                provider: Some(AgentProvider::CLAUDE),
                native_session_id: Some("native-session-1".to_string()),
                title: Some("Recovered thread".to_string()),
                manual_title: false,
                ai_title_generated: false,
                status: Some(ThreadStatus::Running),
                last_error: None,
                last_read_seq: 2,
                last_agent_activity_seq: 7,
                variant: None,
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

    let persisted_after: PersistedAppState =
        serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
    assert_eq!(persisted_after.workspaces.len(), 1);
    assert!(persisted_after.workspaces[0].last_error.is_some());
    assert_eq!(
        persisted_after.workspaces[0].thread_states[0].status,
        Some(ThreadStatus::Error)
    );
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
                current_thread_id: Some("thread-a".to_string()),
                updated_at: Some(Utc::now() - Duration::minutes(2)),
                default_provider: Some(AgentProvider::CODEX),
                last_error: None,
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
                thread_states: vec![super::PersistedThreadState {
                    thread_id: "thread-a".to_string(),
                    updated_at: None,
                    provider: Some(AgentProvider::CODEX),
                    native_session_id: Some("native-a".to_string()),
                    title: Some("Thread A".to_string()),
                    manual_title: false,
                    ai_title_generated: false,
                    status: Some(ThreadStatus::Idle),
                    last_error: None,
                    last_read_seq: 0,
                    last_agent_activity_seq: 0,
                    variant: None,
                }],
            },
        );
        saved.insert(
            workspace_b.to_string_lossy().to_string(),
            super::PersistedWorkspaceState {
                path: workspace_b.to_string_lossy().to_string(),
                current_thread_id: Some("thread-b".to_string()),
                updated_at: Some(Utc::now() - Duration::minutes(1)),
                default_provider: Some(AgentProvider::CLAUDE),
                last_error: Some("Still disconnected".to_string()),
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
                thread_states: vec![super::PersistedThreadState {
                    thread_id: "thread-b".to_string(),
                    updated_at: None,
                    provider: Some(AgentProvider::CLAUDE),
                    native_session_id: Some("native-b".to_string()),
                    title: Some("Thread B".to_string()),
                    manual_title: false,
                    ai_title_generated: false,
                    status: Some(ThreadStatus::Error),
                    last_error: Some("Still disconnected".to_string()),
                    last_read_seq: 1,
                    last_agent_activity_seq: 3,
                    variant: None,
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
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };
    let live_workspace = WorkspaceSummary {
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
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };
    let workspace = WorkspaceSummary {
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
        falcondeck_core::RemoteConnectionStatus::DeviceTrusted
    );
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
        falcondeck_core::RemoteConnectionStatus::DeviceTrusted
    );
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
            acp_runtimes: HashMap::new(),
            threads: [(
                thread_id.to_string(),
                super::ManagedThread::new(ThreadSummary {
                    id: thread_id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    title: "Claude thread".to_string(),
                    provider: AgentProvider::CLAUDE,
                    native_session_id: Some(native_session_id.to_string()),
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
        request_id,
        falcondeck_core::InteractiveResponsePayload::Approval {
            decision: falcondeck_core::ApprovalDecision::Deny,
        },
    )
    .await
    .unwrap();
    let response = hook_task.await.unwrap();
    assert_eq!(response["hookSpecificOutput"]["permissionDecision"], "deny");
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
    wait_for_pending_claude_request(&app, "workspace-1").await;
    hook_task.await.unwrap();

    // Cleanup runs on a spawned task; allow it a moment to land.
    for _ in 0..200 {
        if app.inner.interactive_requests.lock().await.is_empty()
            && app.inner.claude_approvals.lock().await.is_empty()
        {
            break;
        }
        sleep(TokioDuration::from_millis(10)).await;
    }
    assert!(app.inner.interactive_requests.lock().await.is_empty());
    assert!(app.inner.claude_approvals.lock().await.is_empty());
    let thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
    assert_eq!(thread.status, ThreadStatus::Running);
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
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };

    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        super::ManagedWorkspace {
            summary: WorkspaceSummary {
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
async fn sends_against_a_running_thread_queue_and_are_removable() {
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
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };
    let workspace = WorkspaceSummary {
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

    // Queued turns are removable before dispatch.
    let queued_id = summary.queued_turns[0].id.clone();
    app.remove_queued_turn(&workspace_id, "thread-q", &queued_id)
        .await
        .unwrap();
    let snapshot = app.snapshot().await;
    assert!(snapshot.threads[0].queued_turns.is_empty());
    assert!(
        app.remove_queued_turn(&workspace_id, "thread-q", &queued_id)
            .await
            .is_err(),
        "removing twice reports not found"
    );
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
    let app = AppState::new_with_state_path(
        "test".to_string(),
        HashMap::new(),
        temp_dir.path().join("daemon-state.json"),
    );
    let workspace_id = "workspace-steer".to_string();
    let thread = ThreadSummary {
        id: "thread-steer".to_string(),
        workspace_id: workspace_id.clone(),
        title: "Running thread".to_string(),
        provider: provider.clone(),
        native_session_id: None,
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
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };
    let workspace = WorkspaceSummary {
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
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CODEX,
        falcondeck_core::AgentCapabilitySummary::codex(),
    )
    .await;

    // Codex has no steer path; the message must be parked, not rejected and
    // not silently dropped.
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
        AgentProvider::CODEX,
        falcondeck_core::AgentCapabilitySummary::codex(),
    )
    .await;
    let queued_ids = queue_messages(&app, &workspace_id, 1).await;

    let error = app
        .steer_queued_turn(&workspace_id, "thread-steer", &queued_ids[0])
        .await
        .expect_err("codex cannot steer");
    assert!(
        error.to_string().contains("cannot steer"),
        "unexpected error: {error}"
    );
    assert_eq!(app.snapshot().await.threads[0].queued_turns.len(), 1);
}

#[tokio::test]
async fn steering_an_unknown_queued_id_reports_not_found() {
    let temp_dir = tempdir().unwrap();
    let (app, workspace_id) = busy_thread_app(
        &temp_dir,
        AgentProvider::CLAUDE,
        falcondeck_core::AgentCapabilitySummary::claude(),
    )
    .await;
    queue_messages(&app, &workspace_id, 1).await;

    let error = app
        .steer_queued_turn(&workspace_id, "thread-steer", "queued-nope")
        .await
        .expect_err("unknown queued id");
    assert!(
        error.to_string().contains("queued turn not found"),
        "unexpected error: {error}"
    );
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
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };
    thread.agent.permission_mode = Some("bypassPermissions".to_string());
    let workspace = WorkspaceSummary {
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
