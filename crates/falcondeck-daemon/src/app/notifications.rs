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
                        error,
                    },
                );
                app.maybe_schedule_ai_thread_title(workspace_id.to_string(), thread_id)
                    .await;
            }
        }
        "turn/step/started" | "turn/step/completed" => {
            if let Some(thread_id) = extract_thread_id(&params) {
                let step = extract_string(&params, &["step"]);
                let status = plan_step_status(method, &params);
                let turn_id = extract_string(&params, &["turnId", "turn_id"]);
                let updated_at = notification_timestamp(method, &params).unwrap_or_else(Utc::now);

                let thread = app
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.updated_at = updated_at;
                        if let Some(plan) = &mut thread.latest_plan {
                            if let Some(s) = step.clone() {
                                if let Some(step_obj) =
                                    plan.steps.iter_mut().find(|st| st.step == s)
                                {
                                    if let Some(st) = status.clone() {
                                        step_obj.status = st;
                                    }
                                }
                            }
                        }
                    })
                    .await?;

                if let (Some(turn_id), Some(plan)) = (turn_id, thread.latest_plan.clone()) {
                    app.push_conversation_item(
                        workspace_id,
                        &thread_id,
                        ConversationItem::Plan {
                            id: format!("plan-{turn_id}"),
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
                    .find(|agent| agent.provider == AgentProvider::Codex)
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

    Ok(())
}
