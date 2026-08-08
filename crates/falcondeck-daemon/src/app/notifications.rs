use super::*;

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
        "turn/started" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let turn_id = extract_string(&params, &["turnId", "turn_id"])
                    .unwrap_or_else(|| "turn".to_string());
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);
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
        "turn/completed" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let turn_id = extract_string(&params, &["turnId", "turn_id"])
                    .unwrap_or_else(|| "turn".to_string());
                let status =
                    extract_string(&params, &["status"]).unwrap_or_else(|| "completed".to_string());
                let turn_was_interrupted = is_interrupt_turn_status(&status);
                let error = extract_string(&params, &["error"]).or_else(|| {
                    extract_string(params.get("error").unwrap_or(&Value::Null), &["message"])
                });
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
        "item/agentMessage/delta" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let item_id = extract_string(&params, &["itemId", "item_id"])
                    .unwrap_or_else(|| "message".to_string());
                let delta = extract_string(&params, &["delta"]).unwrap_or_default();

                let next = {
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
                    let next = match existing_index.and_then(|i| thread.items.get(i)) {
                        Some(ConversationItem::AssistantMessage {
                            id,
                            text,
                            created_at,
                        }) => ConversationItem::AssistantMessage {
                            id: id.clone(),
                            text: format!("{text}{delta}"),
                            created_at: *created_at,
                        },
                        _ => ConversationItem::AssistantMessage {
                            id: item_id.clone(),
                            text: delta.clone(),
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
                    next
                };

                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::Text { item_id, delta },
                );
                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ConversationItemUpdated { item: next },
                );
            }
        }
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let item_id = extract_string(&params, &["itemId", "item_id"])
                    .unwrap_or_else(|| "reasoning".to_string());
                let delta = extract_string(&params, &["delta"]).unwrap_or_default();

                let next = {
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
                    let next = match existing_index.and_then(|i| thread.items.get(i)) {
                        Some(ConversationItem::Reasoning {
                            id,
                            summary,
                            content,
                            created_at,
                        }) => {
                            if method.ends_with("summaryTextDelta") {
                                ConversationItem::Reasoning {
                                    id: id.clone(),
                                    summary: Some(format!(
                                        "{}{}",
                                        summary.as_deref().unwrap_or_default(),
                                        delta
                                    )),
                                    content: content.clone(),
                                    created_at: *created_at,
                                }
                            } else {
                                ConversationItem::Reasoning {
                                    id: id.clone(),
                                    summary: summary.clone(),
                                    content: format!("{content}{delta}"),
                                    created_at: *created_at,
                                }
                            }
                        }
                        _ => ConversationItem::Reasoning {
                            id: item_id.clone(),
                            summary: if method.ends_with("summaryTextDelta") {
                                Some(delta.clone())
                            } else {
                                None
                            },
                            content: if method.ends_with("summaryTextDelta") {
                                String::new()
                            } else {
                                delta.clone()
                            },
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
                    next
                };

                app.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ConversationItemUpdated { item: next },
                );
            }
        }
        "item/started" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let item = params.get("item").unwrap_or(&params);
                let item_id = extract_string(item, &["id"]).unwrap_or_else(|| "item".to_string());
                let kind =
                    extract_string(item, &["kind", "type"]).unwrap_or_else(|| "tool".to_string());
                if !should_surface_tool_item(&kind) {
                    return Ok(());
                }
                let title = extract_string(item, &["title", "label", "command"])
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
                            display,
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
                if !should_surface_tool_item(&kind) {
                    return Ok(());
                }
                let title = extract_string(item, &["title", "label", "command"])
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
                let existing_output = item
                    .get("output")
                    .or_else(|| item.get("result"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                app.push_conversation_item(
                    workspace_id,
                    &thread_id,
                    {
                        let display = tool_display_metadata(
                            &title,
                            &kind,
                            &status,
                            exit_code,
                            item.get("output")
                                .or_else(|| item.get("result"))
                                .and_then(Value::as_str),
                        );
                        ConversationItem::ToolCall {
                            id: item_id.clone(),
                            title: title.clone(),
                            tool_kind: kind.clone(),
                            status: status.clone(),
                            output: existing_output,
                            exit_code,
                            display,
                            created_at: Utc::now(),
                            completed_at: Some(Utc::now()),
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
            app.emit_service(
                Some(workspace_id.to_string()),
                thread_id,
                ServiceLevel::Error,
                message,
                Some(method.to_string()),
            )?;
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
                        Some(thread_id),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                }
            }
        }
        _ => {
            debug!("ignoring unsupported codex notification: {method}");
        }
    }

    Ok(())
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

fn claude_hook_decision(decision: &str, reason: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason
        }
    })
}

fn claude_tool_input_summary(tool_input: &Value) -> Option<String> {
    let compact = tool_input.to_string();
    if compact == "{}" || compact == "null" {
        return None;
    }
    Some(truncate_preview(&compact, 200))
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
        .resolve_interactive_request_item(workspace_id, thread_id, request_id)
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
            cleanup_abandoned_claude_approval(&app, &workspace_id, &thread_id, &request_id).await;
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
    // acceptEdits means edits proceed without asking; commands still prompt.
    if permission_mode.eq_ignore_ascii_case("acceptedits")
        && matches!(tool_name.as_str(), "Edit" | "Write" | "MultiEdit" | "NotebookEdit")
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
    let request = InteractiveRequest {
        request_id: request_id.clone(),
        workspace_id: workspace_id.clone(),
        thread_id: Some(thread_id.clone()),
        method: "claude/hooks/pre-tool-use".to_string(),
        kind: InteractiveRequestKind::Approval,
        title: format!("Allow {tool_name}?"),
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
                request,
                created_at: Utc::now(),
                resolved: false,
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
        // Timed out or the sender was dropped: clean up the abandoned request
        // so the thread does not stay stuck in WaitingForInput.
        _ => {
            guard.disarm();
            cleanup_abandoned_claude_approval(app, &workspace_id, &thread_id, &request_id).await;
            return claude_hook_decision("deny", "FalconDeck approval timed out");
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
                    request,
                    created_at: Utc::now(),
                    resolved: false,
                },
                false,
            )
            .await?;
        }
        return Ok(());
    }

    app.emit_service(
        Some(workspace_id.to_string()),
        extract_thread_id(&params),
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
