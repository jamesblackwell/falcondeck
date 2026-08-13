use super::*;
use crate::codex::extract_datetime_or_timestamp;
use falcondeck_core::RealtimeConversationItem;
use falcondeck_core::{
    RealtimeAudioChunk, ThreadTokenUsage, TokenUsageBreakdown, ToolCallDetail, ToolLifecycle,
};

fn emit_scoped_diagnostic(
    app: &AppState,
    workspace_id: &str,
    thread_id: Option<String>,
    condition_key: &str,
    level: ServiceLevel,
    message: String,
    source: Option<String>,
) -> Result<(), DaemonError> {
    if let Some(thread_id) = thread_id {
        app.emit_conversation_diagnostic(
            workspace_id.to_string(),
            thread_id,
            level,
            message,
            source,
        )
    } else {
        app.upsert_operational_condition(
            workspace_id.to_string(),
            condition_key,
            level,
            message,
            source,
        )
    }
}

pub(super) async fn ingest_notification(
    app: &AppState,
    workspace_id: &str,
    method: &str,
    params: Value,
) -> Result<(), DaemonError> {
    match method {
        "thread/started" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let title =
                    extract_thread_title(&params).unwrap_or_else(|| "Untitled thread".to_string());
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.title = title.clone();
                        thread.status = ThreadStatus::Idle;
                        thread.updated_at = updated_at;
                        if let Some(model_id) =
                            extract_string(&params, &["model", "modelId", "model_id"])
                        {
                            thread.agent.model_id = Some(model_id);
                        }
                        if let Some(reasoning_effort) = extract_string(
                            &params,
                            &["effort", "reasoningEffort", "reasoning_effort"],
                        ) {
                            thread.agent.reasoning_effort = Some(reasoning_effort);
                        }
                        if let Some(approval_policy) =
                            extract_string(&params, &["approvalPolicy", "approval_policy"])
                        {
                            thread.agent.approval_policy = Some(approval_policy);
                        }
                    })
                    .await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadStarted { thread },
                );
            }
        }
        "thread/name/updated" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let title =
                    extract_thread_title(&params).unwrap_or_else(|| "Untitled thread".to_string());
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                app.with_managed_thread_mut(workspace_id, &thread_id, |thread| {
                    thread.summary.title = title.clone();
                    thread.summary.updated_at = updated_at;
                    if !is_placeholder_thread_title(&title) && !is_provisional_thread_title(&title)
                    {
                        thread.ai_title_generated = true;
                        thread.ai_title_in_flight = false;
                    }
                })
                .await?;
                let thread = app.thread_summary(workspace_id, &thread_id).await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
        }
        "thread/status/changed" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let status = codex_thread_status(&params);
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.status = status.clone();
                        if status != ThreadStatus::Error {
                            thread.last_error = None;
                        } else if thread.last_error.is_none() {
                            thread.last_error = Some("Provider thread error".to_string());
                        }
                        thread.updated_at = updated_at;
                    })
                    .await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
        }
        "thread/archived" | "thread/unarchived" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let is_archived = method == "thread/archived";
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.is_archived = is_archived;
                        thread.updated_at = updated_at;
                    })
                    .await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
        }
        "thread/settings/updated" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let settings = params
                    .get("threadSettings")
                    .or_else(|| params.get("thread_settings"))
                    .unwrap_or(&Value::Null);
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        if let Some(model) = extract_string(settings, &["model"]) {
                            thread.agent.model_id = Some(model);
                        }
                        thread.agent.reasoning_effort = extract_string(settings, &["effort"]);
                        thread.agent.service_tier =
                            extract_string(settings, &["serviceTier", "service_tier"]);
                        thread.agent.collaboration_mode_id = settings
                            .get("collaborationMode")
                            .or_else(|| settings.get("collaboration_mode"))
                            .and_then(|mode| extract_string(mode, &["mode"]));
                        thread.agent.approval_policy = settings
                            .get("approvalPolicy")
                            .or_else(|| settings.get("approval_policy"))
                            .and_then(|policy| {
                                policy.as_str().map(str::to_string).or_else(|| {
                                    policy.get("granular").map(|_| "granular".to_string())
                                })
                            });
                        thread.agent.sandbox_mode = settings
                            .get("sandboxPolicy")
                            .or_else(|| settings.get("sandbox_policy"))
                            .and_then(|policy| extract_string(policy, &["type"]))
                            .map(|mode| match mode.as_str() {
                                "dangerFullAccess" => "danger-full-access".to_string(),
                                "workspaceWrite" => "workspace-write".to_string(),
                                "readOnly" => "read-only".to_string(),
                                _ => mode,
                            });
                        thread.updated_at = updated_at;
                    })
                    .await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
        }
        "thread/tokenUsage/updated" => {
            if let (Some(thread_id), Some(usage)) = (
                extract_thread_id(&params),
                parse_thread_token_usage(&params),
            ) {
                app.inner
                    .thread_token_usage
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(thread_id.clone(), usage.clone());
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadTokenUsageUpdated { usage },
                );
            }
        }
        "thread/realtime/started" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                app.inner
                    .realtime_transcripts
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .retain(|(active_thread_id, _), _| active_thread_id != &thread_id);
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::RealtimeAudioStarted {
                        session_id: extract_string(
                            &params,
                            &["realtimeSessionId", "realtime_session_id"],
                        ),
                    },
                );
            }
        }
        "thread/realtime/transcript/delta" => {
            if let (Some(thread_id), Some(role), Some(delta)) = (
                extract_thread_id(&params),
                extract_string(&params, &["role"]),
                extract_string(&params, &["delta"]),
            ) {
                ingest_realtime_transcript_delta(app, workspace_id, &thread_id, &role, &delta)
                    .await?;
            }
        }
        "thread/realtime/itemAdded" => {
            if let (Some(thread_id), Some(item)) = (extract_thread_id(&params), params.get("item"))
            {
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::RealtimeItemAdded {
                        item: realtime_conversation_item(item),
                    },
                );
            }
        }
        "thread/realtime/transcript/done" => {
            if let (Some(thread_id), Some(role), Some(text)) = (
                extract_thread_id(&params),
                extract_string(&params, &["role"]),
                extract_string(&params, &["text"]),
            ) {
                finish_realtime_transcript(
                    app,
                    workspace_id,
                    &thread_id,
                    &role,
                    text,
                    ContentLifecycle::Complete,
                )
                .await?;
            }
        }
        "thread/realtime/outputAudio/delta" => {
            if let (Some(thread_id), Some(audio)) = (
                extract_thread_id(&params),
                parse_realtime_audio_chunk(&params),
            ) {
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::RealtimeAudioDelta { audio },
                );
            }
        }
        "thread/realtime/error" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                settle_realtime_assistant(app, workspace_id, &thread_id, ContentLifecycle::Error)
                    .await?;
                let message = extract_string(&params, &["message"])
                    .unwrap_or_else(|| "Realtime session failed".to_string());
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::RealtimeAudioEnded {
                        reason: Some(message.clone()),
                        interrupted: true,
                    },
                );
                app.emit_conversation_diagnostic(
                    workspace_id.to_string(),
                    thread_id,
                    ServiceLevel::Error,
                    message,
                    Some(method.to_string()),
                )?;
            }
        }
        "thread/realtime/closed" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let lifecycle = if params.get("reason").is_some_and(|reason| !reason.is_null()) {
                    ContentLifecycle::Interrupted
                } else {
                    ContentLifecycle::Complete
                };
                settle_realtime_assistant(app, workspace_id, &thread_id, lifecycle).await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::RealtimeAudioEnded {
                        reason: extract_string(&params, &["reason"]),
                        interrupted: lifecycle == ContentLifecycle::Interrupted,
                    },
                );
            }
        }
        "turn/started" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let turn_id = extract_turn_id(&params).unwrap_or_else(|| "turn".to_string());
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let associated_user_message = {
                    let mut workspaces = app.inner.workspaces.lock().await;
                    workspaces
                        .get_mut(workspace_id)
                        .and_then(|workspace| workspace.threads.get_mut(&thread_id))
                        .and_then(|thread| {
                            thread.items.iter_mut().rev().find_map(|item| match item {
                                ConversationItem::UserMessage {
                                    turn_id: message_turn_id,
                                    ..
                                } if message_turn_id.is_none() => {
                                    *message_turn_id = Some(turn_id.clone());
                                    Some(item.clone())
                                }
                                _ => None,
                            })
                        })
                };
                if let Some(item) = associated_user_message {
                    let item = with_renderable_attachment_previews(item).await;
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ConversationItemUpdated { item },
                    );
                }
                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.status = ThreadStatus::Running;
                        thread.latest_turn_id = Some(turn_id.clone());
                        thread.last_error = None;
                        thread.updated_at = updated_at;
                        if let Some(model_id) =
                            extract_string(&params, &["model", "modelId", "model_id"])
                        {
                            thread.agent.model_id = Some(model_id);
                        }
                        if let Some(reasoning_effort) = extract_string(
                            &params,
                            &["effort", "reasoningEffort", "reasoning_effort"],
                        ) {
                            thread.agent.reasoning_effort = Some(reasoning_effort);
                        }
                        if let Some(approval_policy) =
                            extract_string(&params, &["approvalPolicy", "approval_policy"])
                        {
                            thread.agent.approval_policy = Some(approval_policy);
                        }
                        if let Some(service_tier) =
                            extract_string(&params, &["serviceTier", "service_tier"])
                        {
                            thread.agent.service_tier = Some(service_tier);
                        }
                    })
                    .await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::TurnStart { turn_id },
                );
            }
        }
        "hook/started" | "hook/completed" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let run = params.get("run").unwrap_or(&params);
                let now = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let item_id = extract_string(run, &["id"]).unwrap_or_else(|| "hook".to_string());
                let created_at = if method == "hook/completed" {
                    existing_tool_call_created_at(app, workspace_id, &thread_id, &item_id)
                        .await
                        .unwrap_or(now)
                } else {
                    now
                };
                if let Some(item) = codex_hook_run_conversation_item(
                    run,
                    created_at,
                    (method == "hook/completed").then_some(now),
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, item, true)
                        .await?;
                }
            }
        }
        "item/autoApprovalReview/started" | "item/autoApprovalReview/completed" => {
            if let Some(thread_id) = extract_thread_id(&params)
                && let Some(item) = codex_guardian_review_conversation_item(&params)
            {
                app.push_conversation_item(workspace_id, &thread_id, item, true)
                    .await?;
            }
        }
        "turn/completed" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let turn_id = extract_string(&params, &["turnId", "turn_id"])
                    .unwrap_or_else(|| "turn".to_string());
                let status =
                    extract_string(&params, &["status"]).unwrap_or_else(|| "completed".to_string());
                let turn_was_interrupted = is_interrupt_turn_status(&status);
                let mut error = extract_string(&params, &["error"]).or_else(|| {
                    extract_string(params.get("error").unwrap_or(&Value::Null), &["message"])
                });
                if error.is_none() && is_failed_turn_status(&status) {
                    error = Some("Turn failed".to_string());
                }
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.status = if error.is_some() {
                            ThreadStatus::Error
                        } else {
                            ThreadStatus::Idle
                        };
                        thread.last_error = error.clone();
                        thread.updated_at = updated_at;
                    })
                    .await?;
                let tool_settlement = if turn_was_interrupted {
                    ToolSettlement::Interrupted
                } else if error.is_some() {
                    ToolSettlement::Failed
                } else {
                    ToolSettlement::Completed
                };
                app.settle_turn_items(workspace_id, &thread_id, updated_at, tool_settlement)
                    .await;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::TurnEnd {
                        turn_id,
                        status,
                        error: error.clone(),
                    },
                );
                app.dispatch_next_queued_turn(workspace_id, &thread_id);
                // A finished turn means the agent is waiting on the user;
                // let disconnected devices know. The relay only pushes to
                // devices without a live connection and dedupes per thread.
                // A user-requested interrupt is not attention-worthy, though:
                // the user just acted on this thread themselves.
                if !turn_was_interrupted {
                    app.notify_remote_attention(
                        if error.is_some() {
                            "turn-error"
                        } else {
                            "turn-complete"
                        },
                        workspace_id,
                        Some(thread_id.clone()),
                    )
                    .await;
                }
                app.maybe_schedule_ai_thread_title(workspace_id.to_string(), thread_id)
                    .await;
            }
        }
        "thread/goal/updated" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let goal = parse_thread_goal(&params);
                app.with_thread_mut(workspace_id, &thread_id, |thread| {
                    thread.goal = goal.clone();
                })
                .await?;
                let thread = app.thread_summary(workspace_id, &thread_id).await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                let _ = app.persist_local_state().await;
            }
        }
        "thread/goal/cleared" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                app.with_thread_mut(workspace_id, &thread_id, |thread| {
                    thread.goal = None;
                })
                .await?;
                let thread = app.thread_summary(workspace_id, &thread_id).await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                let _ = app.persist_local_state().await;
            }
        }
        "turn/plan/updated" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let plan = parse_thread_plan(&params);
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.latest_plan = plan.clone();
                        thread.updated_at = updated_at;
                    })
                    .await?;
                if let Some(plan) = plan {
                    app.push_conversation_item(
                        workspace_id,
                        &thread_id,
                        ConversationItem::Plan {
                            id: format!(
                                "plan-{}",
                                extract_string(&params, &["turnId", "turn_id"])
                                    .unwrap_or_else(|| thread_id.clone())
                            ),
                            plan,
                            created_at: updated_at,
                        },
                        true,
                    )
                    .await?;
                }
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
        }
        "turn/diff/updated" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let diff = extract_string(&params, &["diff", "patch"]);
                if let Some(diff) = diff {
                    let updated_at =
                        notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                    let thread = app
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.latest_diff = Some(diff.clone());
                            thread.updated_at = updated_at;
                        })
                        .await?;
                    app.push_conversation_item(
                        workspace_id,
                        &thread_id,
                        ConversationItem::Diff {
                            id: format!(
                                "diff-{}",
                                extract_string(&params, &["turnId", "turn_id"])
                                    .unwrap_or_else(|| thread_id.clone())
                            ),
                            diff,
                            created_at: updated_at,
                        },
                        true,
                    )
                    .await?;
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                }
            }
        }
        "item/commandExecution/outputDelta"
        | "item/command_execution/output_delta"
        | "item/mcpToolCall/progress"
        | "item/mcp_tool_call/progress" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let is_mcp_progress =
                    method.contains("mcpToolCall") || method.contains("mcp_tool_call");
                let item_id =
                    extract_string(&params, &["itemId", "item_id"]).unwrap_or_else(|| {
                        if is_mcp_progress {
                            "mcp-tool"
                        } else {
                            "command"
                        }
                        .to_string()
                    });
                let raw_delta = extract_string(
                    &params,
                    if is_mcp_progress {
                        &["message"]
                    } else {
                        &["delta"]
                    },
                )
                .unwrap_or_default();
                let (next, existed, delta, start_offset, end_offset) = {
                    let mut workspaces = app.inner.workspaces.lock().await;
                    let workspace = workspaces
                        .get_mut(workspace_id)
                        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
                    let thread = workspace
                        .threads
                        .get_mut(&thread_id)
                        .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
                    let existing_index = thread.tool_items.get(&item_id).copied();
                    let start_offset = existing_index
                        .and_then(|index| thread.items.get(index))
                        .and_then(|item| match item {
                            ConversationItem::ToolCall { output, .. } => {
                                Some(output.as_deref().unwrap_or_default().encode_utf16().count()
                                    as u64)
                            }
                            _ => None,
                        })
                        .unwrap_or(0);
                    let existing_output = existing_index
                        .and_then(|index| thread.items.get(index))
                        .and_then(|item| match item {
                            ConversationItem::ToolCall { output, .. } => output.as_deref(),
                            _ => None,
                        })
                        .unwrap_or_default();
                    let delta = if is_mcp_progress && !existing_output.is_empty() {
                        format!("\n{raw_delta}")
                    } else {
                        raw_delta
                    };
                    let next = match existing_index.and_then(|index| thread.items.get(index)) {
                        Some(ConversationItem::ToolCall {
                            id,
                            title,
                            tool_kind,
                            output,
                            exit_code,
                            detail,
                            created_at,
                            ..
                        }) => {
                            let next_output =
                                format!("{}{delta}", output.as_deref().unwrap_or_default());
                            ConversationItem::ToolCall {
                                id: id.clone(),
                                title: title.clone(),
                                tool_kind: tool_kind.clone(),
                                status: "running".to_string(),
                                output: Some(next_output.clone()),
                                exit_code: *exit_code,
                                display: Box::new(tool_display_metadata(
                                    title,
                                    tool_kind,
                                    "running",
                                    *exit_code,
                                    Some(&next_output),
                                )),
                                detail: detail.clone(),
                                created_at: *created_at,
                                completed_at: None,
                            }
                        }
                        _ => ConversationItem::ToolCall {
                            id: item_id.clone(),
                            title: if is_mcp_progress {
                                "MCP tool call"
                            } else {
                                "Command execution"
                            }
                            .to_string(),
                            tool_kind: if is_mcp_progress {
                                "mcpToolCall"
                            } else {
                                "commandExecution"
                            }
                            .to_string(),
                            status: "running".to_string(),
                            output: Some(delta.clone()),
                            exit_code: None,
                            display: Box::new(tool_display_metadata(
                                if is_mcp_progress {
                                    "MCP tool call"
                                } else {
                                    "Command execution"
                                },
                                if is_mcp_progress {
                                    "mcpToolCall"
                                } else {
                                    "commandExecution"
                                },
                                "running",
                                None,
                                Some(&delta),
                            )),
                            detail: None,
                            created_at: Utc::now(),
                            completed_at: None,
                        },
                    };
                    if let Some(index) = existing_index {
                        thread.items[index] = next.clone();
                    } else {
                        let index = thread.items.len();
                        thread.items.push(next.clone());
                        thread.tool_items.insert(item_id.clone(), index);
                    }
                    let end_offset = start_offset + delta.encode_utf16().count() as u64;
                    (
                        next,
                        existing_index.is_some(),
                        delta,
                        start_offset,
                        end_offset,
                    )
                };

                if existed {
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::Text {
                            item_id,
                            delta,
                            target: TextDeltaTarget::ToolOutput,
                            start_offset: Some(start_offset),
                            end_offset: Some(end_offset),
                        },
                    );
                } else {
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ConversationItemAdded { item: next },
                    );
                }
            }
        }
        "item/fileChange/patchUpdated" | "item/file_change/patch_updated" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let item_id = extract_string(&params, &["itemId", "item_id"])
                    .unwrap_or_else(|| "file-change".to_string());
                let created_at =
                    existing_file_change_created_at(app, workspace_id, &thread_id, &item_id)
                        .await
                        .unwrap_or_else(Utc::now);
                let synthetic = serde_json::json!({
                    "id": item_id,
                    "type": "fileChange",
                    "status": "inProgress",
                    "changes": params.get("changes").cloned().unwrap_or_else(|| serde_json::json!([])),
                });
                if let Some(change) =
                    codex_file_change_conversation_item(&synthetic, created_at, "inProgress", None)
                {
                    app.push_conversation_item(workspace_id, &thread_id, change, true)
                        .await?;
                }
            }
        }
        "item/agentMessage/delta" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let item_id = extract_string(&params, &["itemId", "item_id"])
                    .unwrap_or_else(|| "message".to_string());
                let delta = extract_string(&params, &["delta"]).unwrap_or_default();

                let (next, existed, start_offset, end_offset) = {
                    let mut workspaces = app.inner.workspaces.lock().await;
                    let workspace = workspaces
                        .get_mut(workspace_id)
                        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
                    let thread = workspace
                        .threads
                        .get_mut(&thread_id)
                        .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;

                    thread.summary.last_message_preview = Some(truncate_preview(
                        &format!(
                            "{}{}",
                            thread
                                .summary
                                .last_message_preview
                                .clone()
                                .unwrap_or_default(),
                            delta
                        ),
                        160,
                    ));
                    thread.summary.updated_at = Utc::now();
                    workspace.summary.current_thread_id = Some(thread_id.clone());
                    workspace.summary.updated_at = Utc::now();

                    let existing_index = thread.assistant_items.get(&item_id).copied();
                    let start_offset = existing_index
                        .and_then(|i| thread.items.get(i))
                        .and_then(|item| match item {
                            ConversationItem::AssistantMessage { text, .. } => {
                                Some(text.encode_utf16().count() as u64)
                            }
                            _ => None,
                        })
                        .unwrap_or(0);
                    let next = match existing_index.and_then(|i| thread.items.get(i)) {
                        Some(ConversationItem::AssistantMessage {
                            id,
                            text,
                            phase,
                            memory_citation,
                            citations,
                            lifecycle,
                            created_at,
                        }) => ConversationItem::AssistantMessage {
                            id: id.clone(),
                            text: format!("{text}{delta}"),
                            phase: *phase,
                            memory_citation: memory_citation.clone(),
                            citations: citations.clone(),
                            lifecycle: *lifecycle,
                            created_at: *created_at,
                        },
                        _ => ConversationItem::AssistantMessage {
                            id: item_id.clone(),
                            text: delta.clone(),
                            phase: None,
                            memory_citation: None,
                            citations: Vec::new(),
                            lifecycle: ContentLifecycle::Streaming,
                            created_at: Utc::now(),
                        },
                    };

                    if let Some(index) = existing_index {
                        thread.items[index] = next.clone();
                    } else {
                        thread.items.push(next.clone());
                        thread
                            .assistant_items
                            .insert(item_id.clone(), thread.items.len() - 1);
                    }
                    let end_offset = start_offset + delta.encode_utf16().count() as u64;
                    (next, existing_index.is_some(), start_offset, end_offset)
                };

                if existed {
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::Text {
                            item_id,
                            delta,
                            target: TextDeltaTarget::AssistantText,
                            start_offset: Some(start_offset),
                            end_offset: Some(end_offset),
                        },
                    );
                } else {
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ConversationItemAdded { item: next },
                    );
                }
            }
        }
        "item/plan/delta" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let item_id = extract_string(&params, &["itemId", "item_id"])
                    .unwrap_or_else(|| "plan".to_string());
                let delta = extract_string(&params, &["delta"]).unwrap_or_default();
                let (next, existed, start_offset, end_offset) = {
                    let mut workspaces = app.inner.workspaces.lock().await;
                    let workspace = workspaces
                        .get_mut(workspace_id)
                        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
                    let thread = workspace
                        .threads
                        .get_mut(&thread_id)
                        .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
                    thread.summary.updated_at = Utc::now();
                    workspace.summary.current_thread_id = Some(thread_id.clone());
                    workspace.summary.updated_at = Utc::now();

                    let existing_index = thread.plan_items.get(&item_id).copied();
                    let start_offset = existing_index
                        .and_then(|index| thread.items.get(index))
                        .and_then(|item| match item {
                            ConversationItem::Plan { plan, .. } => Some(
                                plan.explanation
                                    .as_deref()
                                    .unwrap_or_default()
                                    .encode_utf16()
                                    .count() as u64,
                            ),
                            _ => None,
                        })
                        .unwrap_or(0);
                    let next = match existing_index.and_then(|index| thread.items.get(index)) {
                        Some(ConversationItem::Plan {
                            id,
                            plan,
                            created_at,
                        }) => ConversationItem::Plan {
                            id: id.clone(),
                            plan: ThreadPlan {
                                explanation: Some(format!(
                                    "{}{}",
                                    plan.explanation.as_deref().unwrap_or_default(),
                                    delta
                                )),
                                steps: plan.steps.clone(),
                            },
                            created_at: *created_at,
                        },
                        _ => ConversationItem::Plan {
                            id: item_id.clone(),
                            plan: ThreadPlan {
                                explanation: Some(delta.clone()),
                                steps: Vec::new(),
                            },
                            created_at: Utc::now(),
                        },
                    };
                    if let Some(index) = existing_index {
                        thread.items[index] = next.clone();
                    } else {
                        let index = thread.items.len();
                        thread.items.push(next.clone());
                        thread.plan_items.insert(item_id.clone(), index);
                    }
                    let end_offset = start_offset + delta.encode_utf16().count() as u64;
                    (next, existing_index.is_some(), start_offset, end_offset)
                };
                if existed {
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::Text {
                            item_id,
                            delta,
                            target: TextDeltaTarget::PlanExplanation,
                            start_offset: Some(start_offset),
                            end_offset: Some(end_offset),
                        },
                    );
                } else {
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ConversationItemAdded { item: next },
                    );
                }
            }
        }
        "item/reasoning/textDelta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/summaryPartAdded" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let item_id = extract_string(&params, &["itemId", "item_id"])
                    .unwrap_or_else(|| "reasoning".to_string());
                let is_part_added = method.ends_with("summaryPartAdded");
                if is_part_added
                    && params
                        .get("summaryIndex")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        == 0
                {
                    return Ok(());
                }
                let delta = if is_part_added {
                    "\n".to_string()
                } else {
                    extract_string(&params, &["delta"]).unwrap_or_default()
                };

                let (next, existed, target, start_offset, end_offset) = {
                    let mut workspaces = app.inner.workspaces.lock().await;
                    let workspace = workspaces
                        .get_mut(workspace_id)
                        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
                    let thread = workspace
                        .threads
                        .get_mut(&thread_id)
                        .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;

                    thread.summary.updated_at = Utc::now();
                    workspace.summary.current_thread_id = Some(thread_id.clone());
                    workspace.summary.updated_at = Utc::now();

                    let existing_index = thread.reasoning_items.get(&item_id).copied();
                    let is_summary = method.ends_with("summaryTextDelta") || is_part_added;
                    let target = if is_summary {
                        TextDeltaTarget::ReasoningSummary
                    } else {
                        TextDeltaTarget::ReasoningContent
                    };
                    let start_offset = existing_index
                        .and_then(|i| thread.items.get(i))
                        .and_then(|item| match item {
                            ConversationItem::Reasoning {
                                summary, content, ..
                            } => Some(if is_summary {
                                summary
                                    .as_deref()
                                    .unwrap_or_default()
                                    .encode_utf16()
                                    .count() as u64
                            } else {
                                content.encode_utf16().count() as u64
                            }),
                            _ => None,
                        })
                        .unwrap_or(0);
                    let next = match existing_index.and_then(|i| thread.items.get(i)) {
                        Some(ConversationItem::Reasoning {
                            id,
                            summary,
                            content,
                            lifecycle,
                            duration_ms,
                            created_at,
                        }) => {
                            if is_summary {
                                ConversationItem::Reasoning {
                                    id: id.clone(),
                                    summary: Some(format!(
                                        "{}{}",
                                        summary.as_deref().unwrap_or_default(),
                                        delta
                                    )),
                                    content: content.clone(),
                                    lifecycle: *lifecycle,
                                    duration_ms: *duration_ms,
                                    created_at: *created_at,
                                }
                            } else {
                                ConversationItem::Reasoning {
                                    id: id.clone(),
                                    summary: summary.clone(),
                                    content: format!("{content}{delta}"),
                                    lifecycle: *lifecycle,
                                    duration_ms: *duration_ms,
                                    created_at: *created_at,
                                }
                            }
                        }
                        _ => ConversationItem::Reasoning {
                            id: item_id.clone(),
                            summary: if is_summary {
                                Some(delta.clone())
                            } else {
                                None
                            },
                            content: if is_summary {
                                String::new()
                            } else {
                                delta.clone()
                            },
                            lifecycle: ContentLifecycle::Streaming,
                            duration_ms: None,
                            created_at: Utc::now(),
                        },
                    };

                    if let Some(index) = existing_index {
                        thread.items[index] = next.clone();
                    } else {
                        thread.items.push(next.clone());
                        thread
                            .reasoning_items
                            .insert(item_id.clone(), thread.items.len() - 1);
                    }
                    let end_offset = start_offset + delta.encode_utf16().count() as u64;
                    (
                        next,
                        existing_index.is_some(),
                        target,
                        start_offset,
                        end_offset,
                    )
                };

                if existed {
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::Text {
                            item_id,
                            delta,
                            target,
                            start_offset: Some(start_offset),
                            end_offset: Some(end_offset),
                        },
                    );
                } else {
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ConversationItemAdded { item: next },
                    );
                }
            }
        }
        "item/started" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let item = params.get("item").unwrap_or(&params);
                let item_id = extract_string(item, &["id"]).unwrap_or_else(|| "item".to_string());
                let kind =
                    extract_string(item, &["kind", "type"]).unwrap_or_else(|| "tool".to_string());
                if let Some(message) = codex_assistant_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Streaming,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, message, true)
                        .await?;
                    return Ok(());
                }
                if let Some(reasoning) = codex_reasoning_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Streaming,
                    None,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, reasoning, true)
                        .await?;
                    return Ok(());
                }
                if let Some(plan) = codex_plan_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, plan, true)
                        .await?;
                    return Ok(());
                }
                if let Some(prompt) = codex_hook_prompt_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, prompt, true)
                        .await?;
                    return Ok(());
                }
                if let Some(mut review) = codex_review_mode_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Streaming,
                ) {
                    if let Some(existing) =
                        existing_code_review_item(app, workspace_id, &thread_id, &item_id).await
                    {
                        merge_code_review_item(&existing, &mut review);
                    }
                    app.push_conversation_item(workspace_id, &thread_id, review, true)
                        .await?;
                    return Ok(());
                }
                if let Some(search) = codex_web_search_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Streaming,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, search, true)
                        .await?;
                    return Ok(());
                }
                if let Some(image) = codex_image_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Streaming,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, image, true)
                        .await?;
                    return Ok(());
                }
                if let Some(artifact) = codex_artifact_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Streaming,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, artifact, true)
                        .await?;
                    return Ok(());
                }
                if let Some(compaction) = codex_context_compaction_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ToolLifecycle::Running,
                    None,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, compaction, true)
                        .await?;
                    return Ok(());
                }
                if let Some(change) = codex_file_change_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    "inProgress",
                    None,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, change, true)
                        .await?;
                    return Ok(());
                }
                if !should_surface_tool_item(&kind) {
                    return Ok(());
                }
                if !is_known_tool_item(&kind) {
                    if let Some(unsupported) = unsupported_conversation_item(
                        item,
                        notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                        ContentLifecycle::Streaming,
                    ) {
                        app.push_conversation_item(workspace_id, &thread_id, unsupported, true)
                            .await?;
                    }
                    return Ok(());
                }
                let title = codex_tool_call_title(item)
                    .or_else(|| extract_string(item, &["title", "label", "command"]))
                    .or_else(|| {
                        extract_string(item.get("command").unwrap_or(&Value::Null), &["command"])
                    })
                    .unwrap_or_else(|| kind.clone());
                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.status = ThreadStatus::Running;
                        thread.last_tool = Some(title.clone());
                    })
                    .await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::ToolCallStart {
                        item_id: item_id.clone(),
                        title: title.clone(),
                        kind: kind.clone(),
                    },
                );
                app.push_conversation_item(
                    workspace_id,
                    &thread_id,
                    {
                        let display = tool_display_metadata(&title, &kind, "running", None, None);
                        ConversationItem::ToolCall {
                            id: item_id,
                            title,
                            tool_kind: kind,
                            status: "running".to_string(),
                            output: None,
                            exit_code: None,
                            display: Box::new(display),
                            detail: codex_tool_call_detail(item).map(Box::new),
                            created_at: Utc::now(),
                            completed_at: None,
                        }
                    },
                    true,
                )
                .await?;
            }
        }
        "item/completed" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let item = params.get("item").unwrap_or(&params);
                let item_id = extract_string(item, &["id"]).unwrap_or_else(|| "item".to_string());
                let kind =
                    extract_string(item, &["kind", "type"]).unwrap_or_else(|| "tool".to_string());
                if let Some(message) = codex_assistant_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Complete,
                ) {
                    let completed_at =
                        notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                    let preview = match &message {
                        ConversationItem::AssistantMessage { text, .. } => {
                            truncate_preview(text, 160)
                        }
                        _ => String::new(),
                    };
                    app.with_thread_mut(workspace_id, &thread_id, |thread| {
                        thread.last_message_preview = Some(preview);
                        thread.updated_at = completed_at;
                    })
                    .await?;
                    app.push_conversation_item(workspace_id, &thread_id, message, true)
                        .await?;
                    return Ok(());
                }
                let reasoning_completed_at =
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let existing_reasoning =
                    existing_reasoning_item(app, workspace_id, &thread_id, &item_id).await;
                let reasoning_created_at = existing_reasoning
                    .as_ref()
                    .and_then(|item| match item {
                        ConversationItem::Reasoning { created_at, .. } => Some(*created_at),
                        _ => None,
                    })
                    .unwrap_or(reasoning_completed_at);
                if let Some(mut reasoning) = codex_reasoning_conversation_item(
                    item,
                    reasoning_created_at,
                    ContentLifecycle::Complete,
                    Some(reasoning_completed_at),
                ) {
                    if let Some(existing) = existing_reasoning.as_ref() {
                        merge_reasoning_item(existing, &mut reasoning);
                    }
                    app.push_conversation_item(workspace_id, &thread_id, reasoning, true)
                        .await?;
                    return Ok(());
                }
                if let Some(plan) = codex_plan_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, plan, true)
                        .await?;
                    return Ok(());
                }
                if let Some(prompt) = codex_hook_prompt_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, prompt, true)
                        .await?;
                    return Ok(());
                }
                if let Some(mut review) = codex_review_mode_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Complete,
                ) {
                    if let Some(existing) =
                        existing_code_review_item(app, workspace_id, &thread_id, &item_id).await
                    {
                        merge_code_review_item(&existing, &mut review);
                    }
                    app.push_conversation_item(workspace_id, &thread_id, review, true)
                        .await?;
                    return Ok(());
                }
                if let Some(search) = codex_web_search_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Complete,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, search, true)
                        .await?;
                    return Ok(());
                }
                if let Some(image) = codex_image_conversation_item(
                    item,
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now),
                    ContentLifecycle::Complete,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, image, true)
                        .await?;
                    return Ok(());
                }
                let artifact_completed_at =
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let artifact_created_at =
                    existing_artifact_created_at(app, workspace_id, &thread_id, &item_id)
                        .await
                        .unwrap_or(artifact_completed_at);
                if let Some(artifact) = codex_artifact_conversation_item(
                    item,
                    artifact_created_at,
                    ContentLifecycle::Complete,
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, artifact, true)
                        .await?;
                    return Ok(());
                }
                let compaction_completed_at =
                    notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                if let Some(mut compaction) = codex_context_compaction_conversation_item(
                    item,
                    compaction_completed_at,
                    ToolLifecycle::Succeeded,
                    Some(compaction_completed_at),
                ) {
                    if let ConversationItem::ContextCompaction { created_at, .. } = &mut compaction
                    {
                        *created_at = existing_context_compaction_created_at(
                            app,
                            workspace_id,
                            &thread_id,
                            &item_id,
                        )
                        .await
                        .unwrap_or(compaction_completed_at);
                    }
                    app.push_conversation_item(workspace_id, &thread_id, compaction, true)
                        .await?;
                    return Ok(());
                }
                let completed_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
                let created_at =
                    existing_file_change_created_at(app, workspace_id, &thread_id, &item_id)
                        .await
                        .unwrap_or(completed_at);
                if let Some(change) = codex_file_change_conversation_item(
                    item,
                    created_at,
                    "completed",
                    Some(completed_at),
                ) {
                    app.push_conversation_item(workspace_id, &thread_id, change, true)
                        .await?;
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::File {
                            item_id: Some(item_id),
                            path: item
                                .get("changes")
                                .and_then(Value::as_array)
                                .and_then(|changes| changes.first())
                                .and_then(|change| extract_string(change, &["path"])),
                            summary: "File change".to_string(),
                        },
                    );
                    return Ok(());
                }
                if !should_surface_tool_item(&kind) {
                    return Ok(());
                }
                if !is_known_tool_item(&kind) {
                    let created_at =
                        existing_unsupported_created_at(app, workspace_id, &thread_id, &item_id)
                            .await
                            .unwrap_or(completed_at);
                    if let Some(unsupported) =
                        unsupported_conversation_item(item, created_at, ContentLifecycle::Complete)
                    {
                        app.push_conversation_item(workspace_id, &thread_id, unsupported, true)
                            .await?;
                    }
                    return Ok(());
                }
                let title = codex_tool_call_title(item)
                    .or_else(|| extract_string(item, &["title", "label", "command"]))
                    .or_else(|| {
                        extract_string(item.get("command").unwrap_or(&Value::Null), &["command"])
                    })
                    .unwrap_or_else(|| kind.clone());
                let status =
                    extract_string(item, &["status"]).unwrap_or_else(|| "completed".to_string());
                let exit_code = item
                    .get("exitCode")
                    .or_else(|| item.get("exit_code"))
                    .and_then(Value::as_i64)
                    .map(|value| value as i32);
                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.last_tool = Some(title.clone());
                    })
                    .await?;
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::ToolCallEnd {
                        item_id: item_id.clone(),
                        title: title.clone(),
                        kind: kind.clone(),
                        status: status.clone(),
                        exit_code,
                    },
                );
                let existing_output = codex_tool_call_output(item).or_else(|| {
                    item.get("aggregatedOutput")
                        .or_else(|| item.get("aggregated_output"))
                        .or_else(|| item.get("output"))
                        .or_else(|| item.get("result"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
                let created_at =
                    existing_tool_call_created_at(app, workspace_id, &thread_id, &item_id)
                        .await
                        .unwrap_or(completed_at);
                app.push_conversation_item(
                    workspace_id,
                    &thread_id,
                    {
                        let display = tool_display_metadata(
                            &title,
                            &kind,
                            &status,
                            exit_code,
                            existing_output.as_deref(),
                        );
                        ConversationItem::ToolCall {
                            id: item_id.clone(),
                            title: title.clone(),
                            tool_kind: kind.clone(),
                            status: status.clone(),
                            output: existing_output,
                            exit_code,
                            display: Box::new(display),
                            detail: codex_tool_call_detail(item).map(Box::new),
                            created_at,
                            completed_at: Some(completed_at),
                        }
                    },
                    true,
                )
                .await?;
                if kind.eq_ignore_ascii_case("fileChange")
                    || kind.eq_ignore_ascii_case("file_change")
                {
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::File {
                            item_id: Some(item_id),
                            path: extract_string(item, &["path"]),
                            summary: title,
                        },
                    );
                }
            }
        }
        "error" => {
            let thread_id = extract_thread_id(&params);
            let message =
                extract_string(&params, &["message"]).unwrap_or_else(|| params.to_string());
            emit_scoped_diagnostic(
                app,
                workspace_id,
                thread_id,
                "provider_error",
                ServiceLevel::Error,
                message,
                Some(method.to_string()),
            )?;
        }
        "warning" | "guardianWarning" => {
            let thread_id = extract_thread_id(&params);
            let message = extract_string(&params, &["message"])
                .unwrap_or_else(|| "Provider warning".to_string());
            emit_scoped_diagnostic(
                app,
                workspace_id,
                thread_id,
                "provider_warning",
                ServiceLevel::Warning,
                message,
                Some(method.to_string()),
            )?;
        }
        "deprecationNotice" => {
            let summary = extract_string(&params, &["summary"])
                .unwrap_or_else(|| "Deprecated provider behavior".to_string());
            let details = extract_string(&params, &["details"]);
            app.upsert_operational_condition(
                workspace_id.to_string(),
                "provider_deprecation",
                ServiceLevel::Warning,
                match details {
                    Some(details) if !details.is_empty() => format!("{summary}\n{details}"),
                    _ => summary,
                },
                Some(method.to_string()),
            )?;
        }
        "configWarning" => {
            let summary = extract_string(&params, &["summary"])
                .unwrap_or_else(|| "Configuration warning".to_string());
            let details = extract_string(&params, &["details"]);
            let path = extract_string(&params, &["path"]);
            let message = [
                Some(summary),
                details,
                path.map(|path| format!("Config: {path}")),
            ]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
            app.upsert_operational_condition(
                workspace_id.to_string(),
                "provider_configuration",
                ServiceLevel::Warning,
                message,
                Some(method.to_string()),
            )?;
        }
        "model/verification" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let verifications = params
                    .get("verifications")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                if !verifications.is_empty() {
                    app.emit_conversation_diagnostic(
                        workspace_id.to_string(),
                        thread_id,
                        ServiceLevel::Info,
                        format!("Model verification: {}", verifications.join(", ")),
                        Some(method.to_string()),
                    )?;
                }
            }
        }
        "model/safetyBuffering/updated" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let model =
                    extract_string(&params, &["model"]).unwrap_or_else(|| "model".to_string());
                let enabled = params
                    .get("showBufferingUi")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let reasons = params
                    .get("reasons")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" · ");
                let faster = extract_string(&params, &["fasterModel"]);
                let mut message = if enabled {
                    format!("Safety buffering enabled for {model}")
                } else {
                    format!("Safety buffering ended for {model}")
                };
                if !reasons.is_empty() {
                    message.push_str(&format!(": {reasons}"));
                }
                if let Some(faster) = faster {
                    message.push_str(&format!(". Faster model available: {faster}"));
                }
                app.emit_conversation_diagnostic(
                    workspace_id.to_string(),
                    thread_id,
                    if enabled {
                        ServiceLevel::Warning
                    } else {
                        ServiceLevel::Info
                    },
                    message,
                    Some(method.to_string()),
                )?;
            }
        }
        "serverRequest/resolved" => {
            if let Some(raw_request_id) =
                params.get("requestId").or_else(|| params.get("request_id"))
            {
                let request_id = normalize_request_id(raw_request_id);
                let pending = app
                    .inner
                    .interactive_requests
                    .lock()
                    .await
                    .remove(&(workspace_id.to_string(), request_id.clone()));
                let thread_id = extract_thread_id(&params)
                    .or_else(|| pending.and_then(|pending| pending.request.thread_id));
                if let Some(thread_id) = thread_id {
                    app.resolve_interactive_request_item(
                        workspace_id,
                        &thread_id,
                        &request_id,
                        None,
                    )
                    .await?;
                    let thread = app
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            if thread.status == ThreadStatus::WaitingForInput {
                                thread.status = ThreadStatus::Running;
                            }
                        })
                        .await?;
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                }
                app.emit(
                    Some(workspace_id.to_string()),
                    None,
                    UnifiedEvent::Snapshot {
                        snapshot: app.snapshot().await,
                    },
                );
            }
        }
        "mcpServer/startupStatus/updated" => {
            let status = extract_string(&params, &["status"]);
            let name =
                extract_string(&params, &["name"]).unwrap_or_else(|| "MCP server".to_string());
            let condition_key = format!("mcp_startup:{name}");
            if status.as_deref() == Some("failed") {
                let error = extract_string(&params, &["error"])
                    .unwrap_or_else(|| "Startup failed".to_string());
                let reason = extract_string(&params, &["failureReason", "failure_reason"]);
                let message = match reason {
                    Some(reason) => format!(
                        "{name} failed to start: {error} ({})",
                        humanize_camel_case(&reason)
                    ),
                    None => format!("{name} failed to start: {error}"),
                };
                app.upsert_operational_condition(
                    workspace_id.to_string(),
                    condition_key,
                    ServiceLevel::Error,
                    message,
                    Some(method.to_string()),
                )?;
            } else {
                app.clear_operational_condition(workspace_id, &condition_key);
            }
        }
        "mcpServer/oauthLogin/completed" => {
            let name =
                extract_string(&params, &["name"]).unwrap_or_else(|| "MCP server".to_string());
            let condition_key = format!("mcp_auth:{name}");
            if !params
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                let error = extract_string(&params, &["error"])
                    .unwrap_or_else(|| "Authentication failed".to_string());
                app.upsert_operational_condition(
                    workspace_id.to_string(),
                    condition_key,
                    ServiceLevel::Error,
                    format!("{name} sign-in failed: {error}"),
                    Some(method.to_string()),
                )?;
            } else {
                app.clear_operational_condition(workspace_id, &condition_key);
            }
        }
        "account/updated" => {
            let mut workspaces = app.inner.workspaces.lock().await;
            if let Some(workspace) = workspaces.get_mut(workspace_id) {
                workspace.summary.account = parse_account(&params);
                if let Some(agent) = workspace
                    .summary
                    .agents
                    .iter_mut()
                    .find(|agent| agent.provider == AgentProvider::CODEX)
                {
                    agent.account = workspace.summary.account.clone();
                }
                workspace.summary.status = workspace_status_after_account_update(
                    &workspace.summary.status,
                    &workspace.summary.account.status,
                );
                workspace.summary.updated_at = Utc::now();
            }
        }
        "model/rerouted" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let rerouted_model = extract_string(
                    &params,
                    &[
                        "toModel",
                        "to_model",
                        "model",
                        "modelId",
                        "model_id",
                        "reroutedModel",
                        "rerouted_model",
                    ],
                );
                if let Some(model_id) = rerouted_model {
                    let thread = app
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.agent.model_id = Some(model_id.clone());
                        })
                        .await?;
                    app.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    app.emit_conversation_diagnostic(
                        workspace_id.to_string(),
                        thread_id,
                        ServiceLevel::Warning,
                        format!("Model rerouted to {model_id}"),
                        Some(method.to_string()),
                    )?;
                }
            }
        }
        _ => {
            debug!("ignoring unsupported codex notification: {method}");
        }
    }

    Ok(())
}

/// Codex app-server v2 nests the active turn under `turn`, while older
/// builds exposed its id directly on the notification params. Steering must
/// retain the provider's real id because app-server validates it through
/// `expectedTurnId`.
fn extract_turn_id(params: &Value) -> Option<String> {
    params
        .get("turn")
        .and_then(|turn| extract_string(turn, &["id", "turnId", "turn_id"]))
        .or_else(|| extract_string(params, &["turnId", "turn_id"]))
}

pub(super) fn parse_realtime_audio_chunk(params: &Value) -> Option<RealtimeAudioChunk> {
    let audio = params.get("audio")?;
    let data = extract_string(audio, &["data"])?;
    let sample_rate = audio
        .get("sampleRate")
        .or_else(|| audio.get("sample_rate"))?
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())?;
    let num_channels = audio
        .get("numChannels")
        .or_else(|| audio.get("num_channels"))?
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())?;
    if data.is_empty()
        || !(8_000..=192_000).contains(&sample_rate)
        || !(1..=8).contains(&num_channels)
    {
        return None;
    }
    Some(RealtimeAudioChunk {
        item_id: extract_string(audio, &["itemId", "item_id"]),
        data,
        sample_rate,
        num_channels,
        samples_per_channel: audio
            .get("samplesPerChannel")
            .or_else(|| audio.get("samples_per_channel"))
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
    })
}

pub(super) fn realtime_conversation_item(item: &Value) -> RealtimeConversationItem {
    const MAX_REALTIME_ITEM_BYTES: usize = 64 * 1024;
    let item_type =
        extract_string(item, &["type", "kind"]).unwrap_or_else(|| "unknown".to_string());
    let title = if item_type == "handoff_request" {
        "Voice handoff requested".to_string()
    } else {
        format!("Realtime {}", item_type.replace(['_', '-'], " "))
    };
    let summary = extract_string(
        item,
        &[
            "message",
            "text",
            "prompt",
            "request",
            "instructions",
            "reason",
        ],
    )
    .map(|text| truncate_preview(&text, 500));
    let payload = serde_json::to_vec(item)
        .ok()
        .filter(|encoded| encoded.len() <= MAX_REALTIME_ITEM_BYTES)
        .map(|_| item.clone())
        .unwrap_or_else(|| {
            json!({
                "type": item_type,
                "truncated": true,
                "message": "Realtime item exceeded the 64 KiB display limit"
            })
        });
    RealtimeConversationItem {
        id: extract_string(item, &["id", "itemId", "item_id"])
            .unwrap_or_else(|| format!("realtime-item-{}", Uuid::new_v4())),
        item_type,
        title,
        summary,
        payload,
        created_at: Utc::now(),
    }
}

pub(super) fn parse_thread_token_usage(params: &Value) -> Option<ThreadTokenUsage> {
    let usage = params
        .get("tokenUsage")
        .or_else(|| params.get("token_usage"))?;
    Some(ThreadTokenUsage {
        total: parse_token_usage_breakdown(usage.get("total")?)?,
        last: usage.get("last").and_then(parse_token_usage_breakdown),
        model_context_window: usage
            .get("modelContextWindow")
            .or_else(|| usage.get("model_context_window"))
            .and_then(Value::as_u64),
        updated_at: notification_timestamp("thread/tokenUsage/updated", params),
    })
}

async fn ingest_realtime_transcript_delta(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    role: &str,
    delta: &str,
) -> Result<(), DaemonError> {
    let role = role.to_ascii_lowercase();
    let (state, start_offset, end_offset) = {
        let mut transcripts = app
            .inner
            .realtime_transcripts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = transcripts
            .entry((thread_id.to_string(), role.clone()))
            .or_insert_with(|| RealtimeTranscriptState {
                id: format!("realtime-{}", Uuid::new_v4()),
                text: String::new(),
                created_at: Utc::now(),
            });
        let start_offset = state.text.encode_utf16().count() as u64;
        state.text.push_str(delta);
        let end_offset = state.text.encode_utf16().count() as u64;
        (state.clone(), start_offset, end_offset)
    };

    // User speech is only committed when the provider emits its authoritative
    // final transcript. Assistant speech streams through the normal replay-safe
    // text path so every existing client can render it immediately.
    if role != "assistant" {
        return Ok(());
    }

    let item = ConversationItem::AssistantMessage {
        id: state.id.clone(),
        text: state.text.clone(),
        phase: None,
        memory_citation: None,
        citations: Vec::new(),
        lifecycle: ContentLifecycle::Streaming,
        created_at: state.created_at,
    };
    let existed = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let existing_index = thread.assistant_items.get(&state.id).copied();
        if let Some(index) = existing_index {
            thread.items[index] = item.clone();
        } else {
            let index = thread.items.len();
            thread.items.push(item.clone());
            thread.assistant_items.insert(state.id.clone(), index);
        }
        thread.summary.last_message_preview = Some(truncate_preview(&state.text, 160));
        thread.summary.updated_at = Utc::now();
        workspace.summary.current_thread_id = Some(thread_id.to_string());
        workspace.summary.updated_at = Utc::now();
        existing_index.is_some()
    };
    if existed {
        app.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::Text {
                item_id: state.id,
                delta: delta.to_string(),
                target: TextDeltaTarget::AssistantText,
                start_offset: Some(start_offset),
                end_offset: Some(end_offset),
            },
        );
    } else {
        app.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ConversationItemAdded { item },
        );
    }
    Ok(())
}

async fn finish_realtime_transcript(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    role: &str,
    text: String,
    lifecycle: ContentLifecycle,
) -> Result<(), DaemonError> {
    let role = role.to_ascii_lowercase();
    let state = app
        .inner
        .realtime_transcripts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&(thread_id.to_string(), role.clone()))
        .unwrap_or_else(|| RealtimeTranscriptState {
            id: format!("realtime-{}", Uuid::new_v4()),
            text: String::new(),
            created_at: Utc::now(),
        });
    let final_text = if text.is_empty() { state.text } else { text };
    let item = if role == "assistant" {
        ConversationItem::AssistantMessage {
            id: state.id,
            text: final_text,
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle,
            created_at: state.created_at,
        }
    } else {
        ConversationItem::UserMessage {
            id: state.id,
            text: final_text,
            attachments: Vec::new(),
            turn_id: None,
            previous_turn_id: None,
            created_at: state.created_at,
        }
    };
    app.push_conversation_item(workspace_id, thread_id, item, true)
        .await
}

async fn settle_realtime_assistant(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    lifecycle: ContentLifecycle,
) -> Result<(), DaemonError> {
    let state = app
        .inner
        .realtime_transcripts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&(thread_id.to_string(), "assistant".to_string()))
        .cloned();
    if let Some(state) = state {
        finish_realtime_transcript(
            app,
            workspace_id,
            thread_id,
            "assistant",
            state.text.clone(),
            lifecycle,
        )
        .await?;
    }
    Ok(())
}

fn parse_token_usage_breakdown(value: &Value) -> Option<TokenUsageBreakdown> {
    let count = |camel: &str, snake: &str| {
        value
            .get(camel)
            .or_else(|| value.get(snake))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    Some(TokenUsageBreakdown {
        total_tokens: count("totalTokens", "total_tokens"),
        input_tokens: count("inputTokens", "input_tokens"),
        cached_input_tokens: count("cachedInputTokens", "cached_input_tokens"),
        output_tokens: count("outputTokens", "output_tokens"),
        reasoning_output_tokens: count("reasoningOutputTokens", "reasoning_output_tokens"),
    })
}

pub(super) fn codex_guardian_review_conversation_item(params: &Value) -> Option<ConversationItem> {
    let review_id = extract_string(params, &["reviewId", "review_id"])?;
    let review = params.get("review").unwrap_or(&Value::Null);
    let action_value = params.get("action").unwrap_or(&Value::Null);
    let (action_kind, action, cwd) = guardian_review_action(action_value);
    let status = extract_string(review, &["status"]).unwrap_or_else(|| "inProgress".to_string());
    let tool_status = match status.as_str() {
        "inProgress" => "running",
        "approved" => "completed",
        "denied" => "denied",
        "timedOut" | "aborted" => "interrupted",
        _ => "unknown",
    };
    let title = format!("Safety review · {}", humanize_camel_case(&action_kind));
    let started_at = extract_datetime_or_timestamp(params, &["startedAtMs", "started_at_ms"])
        .unwrap_or_else(Utc::now);
    let completed_at = extract_datetime_or_timestamp(params, &["completedAtMs", "completed_at_ms"]);
    let duration_ms =
        completed_at.map(|completed| (completed - started_at).num_milliseconds().max(0) as u64);
    let rationale = extract_string(review, &["rationale"]);
    let display = tool_display_metadata(
        &title,
        "guardianReview",
        tool_status,
        None,
        rationale.as_deref(),
    );

    Some(ConversationItem::ToolCall {
        id: format!("guardian-review-{review_id}"),
        title,
        tool_kind: "guardianReview".to_string(),
        status: tool_status.to_string(),
        output: None,
        exit_code: None,
        display: Box::new(display),
        detail: Some(Box::new(ToolCallDetail::GuardianReview {
            review_id,
            action_kind,
            action,
            cwd,
            target_item_id: extract_string(params, &["targetItemId", "target_item_id"]),
            status,
            risk_level: extract_string(review, &["riskLevel", "risk_level"]),
            user_authorization: extract_string(
                review,
                &["userAuthorization", "user_authorization"],
            ),
            rationale,
            decision_source: extract_string(params, &["decisionSource", "decision_source"]),
            duration_ms,
        })),
        created_at: started_at,
        completed_at,
    })
}

pub(super) fn codex_thread_status(params: &Value) -> ThreadStatus {
    let status = params.get("status").unwrap_or(&Value::Null);
    match extract_string(status, &["type"]).as_deref() {
        Some("active") => {
            let waiting = status
                .get("activeFlags")
                .or_else(|| status.get("active_flags"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|flag| flag == "waitingOnApproval" || flag == "waitingOnUserInput");
            if waiting {
                ThreadStatus::WaitingForInput
            } else {
                ThreadStatus::Running
            }
        }
        Some("systemError") => ThreadStatus::Error,
        Some("idle") | Some("notLoaded") | None => ThreadStatus::Idle,
        Some(_) => ThreadStatus::Idle,
    }
}

fn guardian_review_action(action: &Value) -> (String, String, Option<String>) {
    let action_kind = extract_string(action, &["type"]).unwrap_or_else(|| "action".to_string());
    let cwd = extract_string(action, &["cwd"]);
    let description = match action_kind.as_str() {
        "command" => extract_string(action, &["command"]),
        "execve" => {
            let mut parts = extract_string(action, &["program"])
                .into_iter()
                .collect::<Vec<_>>();
            parts.extend(
                action
                    .get("argv")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string),
            );
            (!parts.is_empty()).then(|| parts.join(" "))
        }
        "applyPatch" => {
            let files = action
                .get("files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            (!files.is_empty()).then(|| files.join(", "))
        }
        "networkAccess" => {
            let target = extract_string(action, &["target"]);
            let host = extract_string(action, &["host"]);
            let protocol = extract_string(action, &["protocol"]);
            let port = action.get("port").and_then(Value::as_u64);
            target.or_else(|| match (protocol, host, port) {
                (Some(protocol), Some(host), Some(port)) => {
                    Some(format!("{protocol}://{host}:{port}"))
                }
                (_, Some(host), Some(port)) => Some(format!("{host}:{port}")),
                (_, Some(host), None) => Some(host),
                _ => None,
            })
        }
        "mcpToolCall" => {
            let server = extract_string(action, &["connectorName", "server"]);
            let tool = extract_string(action, &["toolTitle", "toolName"]);
            match (server, tool) {
                (Some(server), Some(tool)) => Some(format!("{server} · {tool}")),
                (Some(server), None) => Some(server),
                (None, Some(tool)) => Some(tool),
                _ => None,
            }
        }
        "requestPermissions" => extract_string(action, &["reason"]),
        _ => None,
    }
    .unwrap_or_else(|| action.to_string());
    (action_kind, description, cwd)
}

async fn existing_file_change_created_at(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    item_id: &str,
) -> Option<chrono::DateTime<Utc>> {
    let workspaces = app.inner.workspaces.lock().await;
    let thread = workspaces.get(workspace_id)?.threads.get(thread_id)?;
    let index = thread.tool_items.get(item_id).copied()?;
    match thread.items.get(index) {
        Some(ConversationItem::FileChange { created_at, .. }) => Some(*created_at),
        _ => None,
    }
}

async fn existing_tool_call_created_at(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    item_id: &str,
) -> Option<chrono::DateTime<Utc>> {
    let workspaces = app.inner.workspaces.lock().await;
    let thread = workspaces.get(workspace_id)?.threads.get(thread_id)?;
    let index = thread.tool_items.get(item_id).copied()?;
    match thread.items.get(index) {
        Some(ConversationItem::ToolCall { created_at, .. }) => Some(*created_at),
        _ => None,
    }
}

async fn existing_context_compaction_created_at(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    item_id: &str,
) -> Option<chrono::DateTime<Utc>> {
    let workspaces = app.inner.workspaces.lock().await;
    let thread = workspaces.get(workspace_id)?.threads.get(thread_id)?;
    thread.items.iter().find_map(|item| match item {
        ConversationItem::ContextCompaction { id, created_at, .. } if id == item_id => {
            Some(*created_at)
        }
        _ => None,
    })
}

async fn existing_unsupported_created_at(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    item_id: &str,
) -> Option<chrono::DateTime<Utc>> {
    let workspaces = app.inner.workspaces.lock().await;
    let thread = workspaces.get(workspace_id)?.threads.get(thread_id)?;
    thread.items.iter().find_map(|item| match item {
        ConversationItem::Unsupported { id, created_at, .. } if id == item_id => Some(*created_at),
        _ => None,
    })
}

async fn existing_artifact_created_at(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    item_id: &str,
) -> Option<chrono::DateTime<Utc>> {
    let workspaces = app.inner.workspaces.lock().await;
    let thread = workspaces.get(workspace_id)?.threads.get(thread_id)?;
    thread.items.iter().find_map(|item| match item {
        ConversationItem::Artifact { id, created_at, .. } if id == item_id => Some(*created_at),
        _ => None,
    })
}

async fn existing_reasoning_item(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    item_id: &str,
) -> Option<ConversationItem> {
    let workspaces = app.inner.workspaces.lock().await;
    let thread = workspaces.get(workspace_id)?.threads.get(thread_id)?;
    thread.items.iter().find_map(|item| match item {
        ConversationItem::Reasoning { id, .. } if id == item_id => Some(item.clone()),
        _ => None,
    })
}

fn merge_reasoning_item(existing: &ConversationItem, next: &mut ConversationItem) {
    let ConversationItem::Reasoning {
        summary: existing_summary,
        content: existing_content,
        duration_ms: existing_duration_ms,
        ..
    } = existing
    else {
        return;
    };
    let ConversationItem::Reasoning {
        summary,
        content,
        duration_ms,
        ..
    } = next
    else {
        return;
    };
    if summary.as_deref().is_none_or(str::is_empty) {
        *summary = existing_summary.clone();
    }
    if content.is_empty() {
        content.clone_from(existing_content);
    }
    if duration_ms.is_none() {
        *duration_ms = *existing_duration_ms;
    }
}

async fn existing_code_review_item(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    item_id: &str,
) -> Option<ConversationItem> {
    let workspaces = app.inner.workspaces.lock().await;
    let thread = workspaces.get(workspace_id)?.threads.get(thread_id)?;
    thread.items.iter().find_map(|item| match item {
        ConversationItem::CodeReview { id, .. } if id == item_id => Some(item.clone()),
        _ => None,
    })
}

/// How long a Claude PreToolUse hook waits for a user decision before the
/// daemon denies the tool call. Deliberately below curl's 570s `--max-time`
/// and Claude's 600s hook timeout so the daemon always answers first instead
/// of racing the fail-closed fallback in the hook command.
const CLAUDE_APPROVAL_TIMEOUT: Duration = Duration::from_secs(540);

/// Terminal turn statuses that represent a user-requested stop rather than a
/// finished turn; see `thread_status_from_turn_status` for the canonical
/// non-error set Codex reports.
pub(super) fn is_interrupt_turn_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "canceled" | "cancelled" | "interrupted" | "aborted"
    )
}

pub(super) fn is_failed_turn_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "failed" | "failure" | "error" | "errored"
    )
}

fn claude_hook_decision(decision: &str, reason: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason
        }
    })
}

/// Human-readable approval detail for a Claude tool input. Clients JSON.parse
/// detail strings that start with `{`, so truncating raw JSON broke the parse
/// for any input over the preview limit and rendered the mangled blob
/// verbatim. Surface the human-relevant fields as plain text instead, and
/// only fall back to compact JSON when it fits untruncated.
fn claude_tool_input_summary(tool_input: &Value) -> Option<String> {
    const HUMAN_FIELDS: &[&str] = &[
        "command",
        "file_path",
        "path",
        "notebook_path",
        "url",
        "pattern",
        "query",
        "description",
        "prompt",
    ];
    if let Some(object) = tool_input.as_object() {
        let mut parts = Vec::new();
        for key in HUMAN_FIELDS {
            if let Some(value) = object.get(*key).and_then(Value::as_str) {
                if value.trim().is_empty() {
                    continue;
                }
                parts.push(format!("{key}: {}", truncate_preview(value, 160)));
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("\n"));
        }
    }

    let compact = tool_input.to_string();
    if compact == "{}" || compact == "null" {
        return None;
    }
    if compact.chars().count() <= 200 {
        return Some(compact);
    }
    // No recognizable fields and too large to ship intact: name the fields so
    // the banner says something useful instead of shipping broken JSON.
    tool_input.as_object().map(|object| {
        let keys = object.keys().cloned().collect::<Vec<_>>().join(", ");
        truncate_preview(&format!("input fields: {keys}"), 200)
    })
}

/// Removes every trace of a pending Claude approval: both map entries, the
/// unresolved conversation item, and the thread's `WaitingForInput` status
/// (restored to `Running` only when still waiting — the turn may already have
/// finished by other means, and stomping a terminal status would leave a
/// permanent spinner).
async fn cleanup_abandoned_claude_approval(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    request_id: &str,
    outcome: falcondeck_core::InteractiveRequestOutcome,
) {
    app.inner
        .claude_approvals
        .lock()
        .await
        .remove(&(workspace_id.to_string(), request_id.to_string()));
    app.inner
        .interactive_requests
        .lock()
        .await
        .remove(&(workspace_id.to_string(), request_id.to_string()));
    let _ = app
        .with_thread_mut(workspace_id, thread_id, |thread| {
            if matches!(thread.status, ThreadStatus::WaitingForInput) {
                thread.status = ThreadStatus::Running;
            }
        })
        .await;
    let _ = app
        .resolve_interactive_request_item(
            workspace_id,
            thread_id,
            request_id,
            Some(falcondeck_core::InteractiveRequestResolution {
                outcome,
                resolved_at: Utc::now(),
            }),
        )
        .await;
    app.emit(
        Some(workspace_id.to_string()),
        None,
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );
}

/// Axum drops the hook handler future when the hook's curl process dies.
/// Without cleanup that leaks the approval sender and interactive request
/// entry forever, leaving a stuck attention badge in every snapshot. This
/// guard runs the abandonment cleanup on drop unless the handler completed
/// normally and disarmed it.
struct ClaudeApprovalGuard {
    app: AppState,
    workspace_id: String,
    thread_id: String,
    request_id: String,
    completed: bool,
}

impl ClaudeApprovalGuard {
    fn disarm(&mut self) {
        self.completed = true;
    }
}

impl Drop for ClaudeApprovalGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let app = self.app.clone();
        let workspace_id = std::mem::take(&mut self.workspace_id);
        let thread_id = std::mem::take(&mut self.thread_id);
        let request_id = std::mem::take(&mut self.request_id);
        tokio::spawn(async move {
            cleanup_abandoned_claude_approval(
                &app,
                &workspace_id,
                &thread_id,
                &request_id,
                falcondeck_core::InteractiveRequestOutcome::Cancelled,
            )
            .await;
        });
    }
}

pub(super) async fn handle_claude_pre_tool_use(app: &AppState, payload: Value) -> Value {
    let no_opinion = Value::Object(serde_json::Map::new());
    let Some(session_id) = crate::codex::extract_string(&payload, &["session_id"]) else {
        return no_opinion;
    };
    let tool_name = crate::codex::extract_string(&payload, &["tool_name"])
        .unwrap_or_else(|| "tool".to_string());
    let tool_input = payload.get("tool_input").cloned().unwrap_or(Value::Null);

    let located = {
        let workspaces = app.inner.workspaces.lock().await;
        workspaces.iter().find_map(|(workspace_id, workspace)| {
            workspace
                .threads
                .values()
                .find(|thread| {
                    thread.summary.provider == AgentProvider::CLAUDE
                        && thread.summary.native_session_id.as_deref() == Some(&session_id)
                })
                .map(|thread| (workspace_id.clone(), thread.summary.id.clone()))
        })
    };
    let Some((workspace_id, thread_id)) = located else {
        // Not one of our sessions; leave the decision to Claude Code.
        return no_opinion;
    };

    let allow = claude_hook_decision("allow", "Approved in FalconDeck");

    // The thread's CURRENT permission mode decides, not the mode the turn was
    // spawned with — that's what makes flipping to Bypass on a phone stop the
    // prompts at the very next tool call instead of after a restart.
    let permission_mode = {
        let workspaces = app.inner.workspaces.lock().await;
        workspaces
            .get(&workspace_id)
            .and_then(|workspace| workspace.threads.get(&thread_id))
            .and_then(|thread| thread.summary.agent.permission_mode.clone())
    };
    let permission_mode = permission_mode.as_deref().map(str::trim).unwrap_or("");
    if permission_mode.eq_ignore_ascii_case("bypasspermissions")
        || permission_mode.eq_ignore_ascii_case("dontask")
        || permission_mode.eq_ignore_ascii_case("auto")
    {
        return allow;
    }

    // Read-only tools never prompt: Claude Code's own permission model does
    // not ask for these, and a hook that does turns every exploration step
    // into an approval card.
    if matches!(
        tool_name.as_str(),
        "Read" | "Grep" | "Glob" | "LS" | "NotebookRead" | "TodoWrite" | "TodoRead"
    ) {
        return allow;
    }
    // Spawning a sub-agent has no side effects of its own, and every tool the
    // sub-agent then uses flows back through this same hook to be gated
    // individually. Prompting for the spawn too would charge each sub-agent
    // run a second approval for nothing. ("Task" is the tool's former name;
    // current CLIs call it "Agent".)
    if matches!(tool_name.as_str(), "Task" | "Agent") {
        return allow;
    }
    // acceptEdits means edits proceed without asking; commands still prompt.
    if permission_mode.eq_ignore_ascii_case("acceptedits")
        && matches!(
            tool_name.as_str(),
            "Edit" | "Write" | "MultiEdit" | "NotebookEdit"
        )
    {
        return allow;
    }

    {
        let always_allowed = app.inner.claude_always_allowed_tools.lock().await;
        if always_allowed
            .get(&(workspace_id.clone(), thread_id.clone()))
            .is_some_and(|tools| tools.contains(&tool_name))
        {
            return allow;
        }
    }

    let request_id = format!("claude-{}", Uuid::new_v4());
    // Tool calls made inside a sub-agent hit this hook too (with the parent
    // session id), but their surrounding work is invisible in the transcript —
    // an unlabelled "Allow Bash?" out of nowhere reads as a glitch. Hook
    // payloads mark sub-agent calls with `agent_type`/`agent_id`.
    let subagent_type = crate::codex::extract_string(&payload, &["agent_type"]);
    let title = match &subagent_type {
        Some(kind) => format!("Allow {tool_name}? (sub-agent: {kind})"),
        None => format!("Allow {tool_name}?"),
    };
    let request = InteractiveRequest {
        request_id: request_id.clone(),
        workspace_id: workspace_id.clone(),
        thread_id: Some(thread_id.clone()),
        method: "claude/hooks/pre-tool-use".to_string(),
        kind: InteractiveRequestKind::Approval,
        approval_decisions: Some(vec![
            ApprovalDecision::Allow,
            ApprovalDecision::Deny,
            ApprovalDecision::AlwaysAllow,
        ]),
        title,
        detail: claude_tool_input_summary(&tool_input),
        command: crate::codex::extract_string(&tool_input, &["command"]),
        path: crate::codex::extract_string(&tool_input, &["file_path", "path"]),
        turn_id: None,
        item_id: None,
        questions: Vec::new(),
        created_at: Utc::now(),
    };

    let (decision_tx, decision_rx) = tokio::sync::oneshot::channel();
    app.inner
        .claude_approvals
        .lock()
        .await
        .insert((workspace_id.clone(), request_id.clone()), decision_tx);
    app.inner.interactive_requests.lock().await.insert(
        (workspace_id.clone(), request_id.clone()),
        PendingServerRequest {
            raw_id: Value::Null,
            request: request.clone(),
            params: Value::Null,
        },
    );
    let mut guard = ClaudeApprovalGuard {
        app: app.clone(),
        workspace_id: workspace_id.clone(),
        thread_id: thread_id.clone(),
        request_id: request_id.clone(),
        completed: false,
    };

    let _ = app
        .with_thread_mut(&workspace_id, &thread_id, |thread| {
            thread.status = ThreadStatus::WaitingForInput;
        })
        .await;
    app.emit(
        Some(workspace_id.clone()),
        Some(thread_id.clone()),
        UnifiedEvent::InteractiveRequest {
            request: request.clone(),
        },
    );
    app.notify_remote_attention("approval", &workspace_id, Some(thread_id.clone()))
        .await;
    let _ = app
        .push_conversation_item(
            &workspace_id,
            &thread_id,
            ConversationItem::InteractiveRequest {
                id: request_id.clone(),
                request: Box::new(request),
                created_at: Utc::now(),
                resolved: false,
                resolution: None,
            },
            false,
        )
        .await;

    let decision = match timeout(CLAUDE_APPROVAL_TIMEOUT, decision_rx).await {
        Ok(Ok(decision)) => {
            // The responder in `respond_to_interactive_request` already
            // removed both map entries and resolved the conversation item.
            guard.disarm();
            decision
        }
        Err(_) => {
            guard.disarm();
            cleanup_abandoned_claude_approval(
                app,
                &workspace_id,
                &thread_id,
                &request_id,
                falcondeck_core::InteractiveRequestOutcome::Expired,
            )
            .await;
            return claude_hook_decision("deny", "FalconDeck approval timed out");
        }
        Ok(Err(_)) => {
            guard.disarm();
            cleanup_abandoned_claude_approval(
                app,
                &workspace_id,
                &thread_id,
                &request_id,
                falcondeck_core::InteractiveRequestOutcome::Cancelled,
            )
            .await;
            return claude_hook_decision("deny", "FalconDeck approval was cancelled");
        }
    };

    match decision {
        ApprovalDecision::Allow => allow,
        ApprovalDecision::AlwaysAllow => {
            app.inner
                .claude_always_allowed_tools
                .lock()
                .await
                .entry((workspace_id, thread_id))
                .or_default()
                .insert(tool_name);
            allow
        }
        ApprovalDecision::Deny => claude_hook_decision("deny", "Denied in FalconDeck"),
    }
}

fn codex_approval_decisions(params: &Value) -> Vec<ApprovalDecision> {
    let Some(available) = params
        .get("availableDecisions")
        .or_else(|| params.get("available_decisions"))
    else {
        return vec![
            ApprovalDecision::Allow,
            ApprovalDecision::AlwaysAllow,
            ApprovalDecision::Deny,
        ];
    };
    let Some(available) = available.as_array() else {
        return Vec::new();
    };

    let mut decisions = Vec::new();
    for value in available {
        let decision = match value.as_str() {
            Some("accept") => Some(ApprovalDecision::Allow),
            Some("acceptForSession") => Some(ApprovalDecision::AlwaysAllow),
            Some("decline" | "cancel") => Some(ApprovalDecision::Deny),
            _ => None,
        };
        if let Some(decision) = decision
            && !decisions.contains(&decision)
        {
            decisions.push(decision);
        }
    }
    decisions
}

pub(super) async fn ingest_server_request(
    app: &AppState,
    workspace_id: &str,
    raw_id: Value,
    method: &str,
    params: Value,
) -> Result<(), DaemonError> {
    if method.ends_with("requestApproval") || method == "item/tool/requestUserInput" {
        let request_id = normalize_request_id(&raw_id);
        let request = if method.ends_with("requestApproval") {
            InteractiveRequest {
                request_id: request_id.clone(),
                workspace_id: workspace_id.to_string(),
                thread_id: extract_thread_id(&params),
                method: method.to_string(),
                kind: InteractiveRequestKind::Approval,
                approval_decisions: Some(codex_approval_decisions(&params)),
                title: extract_string(&params, &["reason", "title"])
                    .unwrap_or_else(|| approval_title(method)),
                detail: extract_string(&params, &["message", "description"]),
                command: extract_string(&params, &["command"]),
                path: extract_string(&params, &["path"]),
                turn_id: extract_string(&params, &["turnId", "turn_id"]),
                item_id: extract_string(&params, &["itemId", "item_id"]),
                questions: Vec::new(),
                created_at: Utc::now(),
            }
        } else {
            let questions = parse_interactive_questions(&params);
            InteractiveRequest {
                request_id: request_id.clone(),
                workspace_id: workspace_id.to_string(),
                thread_id: extract_thread_id(&params),
                method: method.to_string(),
                kind: InteractiveRequestKind::Question,
                approval_decisions: Some(Vec::new()),
                title: extract_string(&params, &["title"])
                    .unwrap_or_else(|| "Answer question".to_string()),
                detail: extract_string(&params, &["message", "description"]).or_else(|| {
                    Some(format!(
                        "{} question{} from the agent.",
                        questions.len(),
                        if questions.len() == 1 { "" } else { "s" }
                    ))
                }),
                command: None,
                path: None,
                turn_id: extract_string(&params, &["turnId", "turn_id"]),
                item_id: extract_string(&params, &["itemId", "item_id"]),
                questions,
                created_at: Utc::now(),
            }
        };

        app.inner.interactive_requests.lock().await.insert(
            (workspace_id.to_string(), request_id.clone()),
            PendingServerRequest {
                raw_id,
                request: request.clone(),
                params: params.clone(),
            },
        );

        if let Some(thread_id) = request.thread_id.clone() {
            app.with_thread_mut(workspace_id, &thread_id, |thread| {
                thread.status = ThreadStatus::WaitingForInput;
            })
            .await?;
        }

        app.emit(
            Some(workspace_id.to_string()),
            request.thread_id.clone(),
            UnifiedEvent::InteractiveRequest {
                request: request.clone(),
            },
        );
        app.notify_remote_attention(
            match request.kind {
                InteractiveRequestKind::Approval => "approval",
                InteractiveRequestKind::Question => "question",
            },
            workspace_id,
            request.thread_id.clone(),
        )
        .await;
        if let Some(thread_id) = request.thread_id.clone() {
            app.push_conversation_item(
                workspace_id,
                &thread_id,
                ConversationItem::InteractiveRequest {
                    id: request_id,
                    request: Box::new(request),
                    created_at: Utc::now(),
                    resolved: false,
                    resolution: None,
                },
                false,
            )
            .await?;
        }
        return Ok(());
    }

    emit_scoped_diagnostic(
        app,
        workspace_id,
        extract_thread_id(&params),
        "unsupported_interactive_request",
        ServiceLevel::Warning,
        format!("FalconDeck has not implemented interactive handling for {method} yet."),
        Some(method.to_string()),
    )?;

    // A server-initiated request that never gets a response stalls the
    // app-server turn indefinitely, so decline unsupported methods explicitly.
    if let Ok(session) = app.session_for(workspace_id).await
        && let Err(error) = session
            .respond_to_request_with_error(
                raw_id,
                &format!("FalconDeck does not support the {method} request"),
            )
            .await
    {
        tracing::warn!("failed to decline unsupported server request {method}: {error}");
    }

    Ok(())
}

#[cfg(test)]
mod approval_capability_tests {
    use super::*;

    #[test]
    fn codex_decisions_follow_the_advertised_capability_set() {
        assert_eq!(
            codex_approval_decisions(&serde_json::json!({
                "availableDecisions": ["decline", "accept", "decline", { "amend": true }]
            })),
            vec![ApprovalDecision::Deny, ApprovalDecision::Allow]
        );
        assert_eq!(
            codex_approval_decisions(&serde_json::json!({ "availableDecisions": [] })),
            Vec::<ApprovalDecision>::new()
        );
        assert_eq!(
            codex_approval_decisions(&serde_json::json!({})),
            vec![
                ApprovalDecision::Allow,
                ApprovalDecision::AlwaysAllow,
                ApprovalDecision::Deny,
            ]
        );
    }

    #[test]
    fn claude_input_summary_prefers_readable_fields_over_raw_json() {
        let summary = claude_tool_input_summary(&serde_json::json!({
            "command": "cargo test -p falcondeck-daemon",
            "description": "Run the daemon test suite",
            "timeout": 600000
        }))
        .expect("summary");
        assert_eq!(
            summary,
            "command: cargo test -p falcondeck-daemon\ndescription: Run the daemon test suite"
        );
        assert!(!summary.starts_with('{'));
    }

    #[test]
    fn claude_input_summary_never_ships_truncated_json() {
        // Large inputs without recognizable fields previously shipped a
        // mid-truncated JSON blob that clients failed to parse and rendered raw.
        let summary = claude_tool_input_summary(&serde_json::json!({
            "cells": "x".repeat(400),
            "metadata": "y".repeat(400)
        }))
        .expect("summary");
        assert_eq!(summary, "input fields: cells, metadata");

        let compact =
            claude_tool_input_summary(&serde_json::json!({ "flag": true })).expect("summary");
        assert_eq!(compact, "{\"flag\":true}");

        assert_eq!(claude_tool_input_summary(&serde_json::json!({})), None);
        assert_eq!(claude_tool_input_summary(&serde_json::Value::Null), None);
    }
}
