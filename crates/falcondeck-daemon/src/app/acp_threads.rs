//! App-side integration for generic ACP providers: lazy runtime spawn, the
//! event pump translating [`AcpEvent`]s into conversation items, and the turn
//! lifecycle for ACP-backed threads.

use std::sync::Arc;

use chrono::Utc;
use falcondeck_core::{
    AgentProvider, ApprovalDecision, ConversationItem, InteractiveRequest, InteractiveRequestKind,
    ThreadStatus, TurnInputItem, UnifiedEvent,
};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::acp::{AcpEvent, AcpRuntime};
use crate::error::DaemonError;

use super::conversation_helpers::tool_display_metadata;
use super::{AppState, PendingServerRequest};

impl AppState {
    /// Re-reads `providers.json` so provider edits apply without a daemon
    /// restart; the list cached at startup is only a fallback shape.
    pub(super) fn fresh_acp_provider_configs(&self) -> Vec<crate::acp::AcpProviderConfig> {
        self.inner
            .state_path
            .parent()
            .map(crate::acp::load_acp_provider_configs)
            .unwrap_or_default()
    }

    /// Returns the live ACP runtime for a provider in a workspace, spawning
    /// and initializing the agent process on first use.
    pub(super) async fn acp_runtime_for(
        &self,
        workspace_id: &str,
        provider: &AgentProvider,
    ) -> Result<Arc<AcpRuntime>, DaemonError> {
        {
            let workspaces = self.inner.workspaces.lock().await;
            if let Some(runtime) = workspaces
                .get(workspace_id)
                .and_then(|workspace| workspace.acp_runtimes.get(provider))
                && !runtime.is_closed()
            {
                return Ok(Arc::clone(runtime));
            }
        }

        let config = self
            .fresh_acp_provider_configs()
            .into_iter()
            .find(|config| config.id == provider.as_str())
            .ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "provider '{}' is not configured; add it to providers.json",
                    provider.as_str()
                ))
            })?;

        let workspace_path = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .get(workspace_id)
                .map(|workspace| workspace.summary.path.clone())
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?
        };

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let runtime = AcpRuntime::connect(config, &workspace_path, events_tx).await?;

        {
            let mut workspaces = self.inner.workspaces.lock().await;
            if let Some(workspace) = workspaces.get_mut(workspace_id) {
                workspace
                    .acp_runtimes
                    .insert(provider.clone(), Arc::clone(&runtime));
                // First successful handshake proves the binary works; reflect
                // that on the workspace agent entry, along with the
                // capabilities and any model catalog the agent negotiated —
                // replacing the pre-connection acp_minimal() placeholder.
                // Providers hot-added after the workspace connected have no
                // stored entry yet (the snapshot's placeholder lives in a
                // clone), so seed one here or the refinement has nothing to
                // land on and the picker reports "not started" forever.
                let agent = match workspace
                    .summary
                    .agents
                    .iter_mut()
                    .position(|agent| &agent.provider == provider)
                {
                    Some(index) => &mut workspace.summary.agents[index],
                    None => {
                        workspace
                            .summary
                            .agents
                            .push(falcondeck_core::WorkspaceAgentSummary {
                                provider: provider.clone(),
                                label: runtime.config.label.clone(),
                                account: falcondeck_core::AccountSummary {
                                    status: falcondeck_core::AccountStatus::Unknown,
                                    label: format!("{} not started", runtime.config.label),
                                },
                                models: Vec::new(),
                                collaboration_modes: Vec::new(),
                                skills: Vec::new(),
                                capabilities: falcondeck_core::AgentCapabilitySummary::acp_minimal(
                                ),
                            });
                        workspace.summary.agents.last_mut().expect("just pushed")
                    }
                };
                agent.account = falcondeck_core::AccountSummary {
                    status: falcondeck_core::AccountStatus::Ready,
                    label: format!("{} connected", runtime.config.label),
                };
                agent.capabilities = runtime.capability_summary().await;
                let models = runtime.advertised_models().await;
                if !models.is_empty() {
                    agent.models = models;
                }
            }
        }
        // Clients only refresh workspace agent entries on a full snapshot
        // event; without one they keep showing the pre-connect placeholder
        // (Unknown account, no models) until something unrelated emits.
        self.emit(
            Some(workspace_id.to_string()),
            None,
            falcondeck_core::UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );

        let app = self.clone();
        let workspace = workspace_id.to_string();
        let pump_runtime = Arc::clone(&runtime);
        tokio::spawn(async move {
            app.pump_acp_events(workspace, pump_runtime, events_rx)
                .await;
        });

        Ok(runtime)
    }

    /// Consumes runtime events and applies them to daemon state.
    async fn pump_acp_events(
        &self,
        workspace_id: String,
        runtime: Arc<AcpRuntime>,
        mut events: mpsc::UnboundedReceiver<AcpEvent>,
    ) {
        while let Some(event) = events.recv().await {
            if let Err(error) = self.apply_acp_event(&workspace_id, &runtime, event).await {
                tracing::warn!(%error, workspace = %workspace_id, "failed to apply ACP event");
            }
        }
    }

    async fn apply_acp_event(
        &self,
        workspace_id: &str,
        runtime: &Arc<AcpRuntime>,
        event: AcpEvent,
    ) -> Result<(), DaemonError> {
        match event {
            AcpEvent::MessageDelta { session_id, text } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                let (item_id, full_text) = runtime.append_assistant_text(&session_id, &text).await;
                self.push_conversation_item(
                    workspace_id,
                    &thread_id,
                    ConversationItem::AssistantMessage {
                        id: item_id,
                        text: full_text,
                        created_at: Utc::now(),
                    },
                    true,
                )
                .await?;
            }
            AcpEvent::ToolCall {
                session_id,
                call_id,
                title,
                kind,
                status,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                runtime.remember_tool(&call_id, &title, &kind).await;
                let status = normalize_acp_tool_status(&status);
                self.push_acp_tool_item(
                    workspace_id,
                    &thread_id,
                    &call_id,
                    &title,
                    &kind,
                    &status,
                    None,
                )
                .await?;
            }
            AcpEvent::ToolCallUpdate {
                session_id,
                call_id,
                title,
                status,
                output,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                let (known_title, kind) = runtime
                    .tool_identity(&call_id)
                    .await
                    .unwrap_or_else(|| ("Tool call".to_string(), "other".to_string()));
                let title = title
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(known_title);
                runtime.remember_tool(&call_id, &title, &kind).await;
                let status = normalize_acp_tool_status(status.as_deref().unwrap_or("in_progress"));
                self.push_acp_tool_item(
                    workspace_id,
                    &thread_id,
                    &call_id,
                    &title,
                    &kind,
                    &status,
                    output.as_deref(),
                )
                .await?;
            }
            AcpEvent::Plan { session_id, plan } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                let thread = self
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.latest_plan = Some(plan.clone());
                        thread.updated_at = Utc::now();
                    })
                    .await?;
                self.push_conversation_item(
                    workspace_id,
                    &thread_id,
                    ConversationItem::Plan {
                        id: format!("plan-{thread_id}"),
                        plan,
                        created_at: Utc::now(),
                    },
                    true,
                )
                .await?;
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
            AcpEvent::PermissionRequest {
                session_id,
                request_id,
                title,
                detail,
                options: _,
            } => {
                let thread_id = runtime.thread_for_session(&session_id).await;
                let request = InteractiveRequest {
                    request_id: request_id.clone(),
                    workspace_id: workspace_id.to_string(),
                    thread_id: thread_id.clone(),
                    method: "session/request_permission".to_string(),
                    kind: InteractiveRequestKind::Approval,
                    title,
                    detail,
                    command: None,
                    path: None,
                    turn_id: None,
                    item_id: None,
                    questions: Vec::new(),
                    created_at: Utc::now(),
                };
                self.inner.interactive_requests.lock().await.insert(
                    (workspace_id.to_string(), request_id),
                    PendingServerRequest {
                        raw_id: Value::Null,
                        request,
                        params: Value::Null,
                    },
                );
                if let Some(thread_id) = thread_id {
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.status = ThreadStatus::WaitingForInput;
                            thread.updated_at = Utc::now();
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                }
                self.emit(
                    Some(workspace_id.to_string()),
                    None,
                    UnifiedEvent::Snapshot {
                        snapshot: self.snapshot().await,
                    },
                );
            }
            AcpEvent::TurnEnded { session_id } => {
                if let Some(thread_id) = runtime.thread_for_session(&session_id).await {
                    self.settle_running_tool_calls(workspace_id, &thread_id).await;
                }
                runtime.end_turn(&session_id).await;
            }
            AcpEvent::Fatal { message } => {
                for thread_id in runtime.active_thread_ids().await {
                    let _ = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            if matches!(
                                thread.status,
                                ThreadStatus::Running | ThreadStatus::WaitingForInput
                            ) {
                                thread.status = ThreadStatus::Error;
                                thread.last_error = Some(message.clone());
                                thread.updated_at = Utc::now();
                            }
                        })
                        .await;
                }
                self.emit(
                    Some(workspace_id.to_string()),
                    None,
                    UnifiedEvent::Snapshot {
                        snapshot: self.snapshot().await,
                    },
                );
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    /// Marks tool calls still flagged running as completed once the turn is
    /// over. Nothing can still be executing at that point, and an agent that
    /// never sends a terminal `tool_call_update` (Grok CLI omits it for some
    /// tools) would otherwise leave spinners turning forever.
    async fn settle_running_tool_calls(&self, workspace_id: &str, thread_id: &str) {
        let updated = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(thread) = workspaces
                .get_mut(workspace_id)
                .and_then(|workspace| workspace.threads.get_mut(thread_id))
            else {
                return;
            };
            let mut updated = Vec::new();
            for item in &mut thread.items {
                if let ConversationItem::ToolCall {
                    status,
                    completed_at,
                    title,
                    tool_kind,
                    output,
                    display,
                    ..
                } = item
                    && matches!(status.as_str(), "running" | "in_progress" | "pending")
                {
                    *status = "completed".to_string();
                    *completed_at = Some(Utc::now());
                    *display = tool_display_metadata(
                        title,
                        tool_kind,
                        status,
                        None,
                        output.as_deref(),
                    );
                    updated.push(item.clone());
                }
            }
            updated
        };
        for item in updated {
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ConversationItemUpdated { item },
            );
        }
    }

    async fn push_acp_tool_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        call_id: &str,
        title: &str,
        kind: &str,
        status: &str,
        output: Option<&str>,
    ) -> Result<(), DaemonError> {
        let display = tool_display_metadata(title, kind, status, None, output);
        self.push_conversation_item(
            workspace_id,
            thread_id,
            ConversationItem::ToolCall {
                id: call_id.to_string(),
                title: title.to_string(),
                tool_kind: kind.to_string(),
                status: status.to_string(),
                output: output.map(ToOwned::to_owned),
                exit_code: None,
                display,
                created_at: Utc::now(),
                completed_at: (status == "completed" || status == "failed").then(Utc::now),
            },
            true,
        )
        .await
    }

    /// Answers a pending ACP permission request with a user decision.
    pub(super) async fn respond_acp_permission(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), DaemonError> {
        let Some(thread_id) = thread_id else {
            return Err(DaemonError::BadRequest(
                "ACP permission request has no thread".to_string(),
            ));
        };
        let provider = self.thread_provider(workspace_id, thread_id).await?;
        let runtime = self.acp_runtime_for(workspace_id, &provider).await?;
        runtime.respond_permission(request_id, decision).await
    }
}

/// Maps ACP tool statuses onto the daemon's running/completed/failed set.
fn normalize_acp_tool_status(status: &str) -> String {
    match status {
        "pending" | "in_progress" => "running".to_string(),
        "completed" => "completed".to_string(),
        "failed" => "failed".to_string(),
        other => other.to_string(),
    }
}

/// Runs one ACP turn: ensures the session, prompts, and settles thread status
/// when the agent reports a stop reason.
pub(super) async fn start_acp_turn(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    provider: &AgentProvider,
    inputs: &[TurnInputItem],
) -> Result<(), DaemonError> {
    let runtime = app.acp_runtime_for(workspace_id, provider).await?;
    // A native session id persisted from a previous daemon run lets the agent
    // resume via session/load instead of starting from a blank session. Only
    // offered when the in-memory history is EMPTY: session/load replays the
    // whole conversation through the event pump, so resuming into a thread
    // that still holds its items (agent process died, daemon alive) would
    // append the entire history a second time. That case takes session/new —
    // the agent loses its context, which is the pre-resume status quo.
    let (known_native_session, requested_permission_mode, cwd) = {
        let workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces.get(workspace_id);
        let thread = workspace.and_then(|workspace| workspace.threads.get(thread_id));
        (
            thread
                .filter(|thread| thread.items.is_empty())
                .and_then(|thread| thread.summary.native_session_id.clone()),
            thread.and_then(|thread| thread.summary.agent.permission_mode.clone()),
            match (workspace, thread) {
                (Some(workspace), Some(thread)) => thread
                    .summary
                    .working_directory(&workspace.summary.path)
                    .to_string(),
                _ => runtime.workspace_path().to_string(),
            },
        )
    };
    let session_id = runtime
        .ensure_session(thread_id, known_native_session.as_deref(), &cwd)
        .await?;
    app.with_thread_mut(workspace_id, thread_id, |thread| {
        thread.native_session_id = Some(session_id.clone());
    })
    .await?;

    // Sessions advertise permission modes (ACP session modes). Surface them
    // on the workspace agent entry so the composer shows the picker, and
    // apply the user's selection via session/set_mode before prompting.
    if let Some(mode_state) = runtime.session_mode_state(&session_id).await {
        if !mode_state.available.is_empty() {
            let modes_changed = {
                let mut workspaces = app.inner.workspaces.lock().await;
                workspaces
                    .get_mut(workspace_id)
                    .and_then(|workspace| {
                        workspace
                            .summary
                            .agents
                            .iter_mut()
                            .find(|agent| &agent.provider == provider)
                    })
                    .is_some_and(|agent| {
                        if agent.capabilities.permission_modes == mode_state.available {
                            false
                        } else {
                            agent.capabilities.permission_modes = mode_state.available.clone();
                            true
                        }
                    })
            };
            if modes_changed {
                app.emit(
                    Some(workspace_id.to_string()),
                    None,
                    UnifiedEvent::Snapshot {
                        snapshot: app.snapshot().await,
                    },
                );
            }
        }
        if let Some(desired) = requested_permission_mode
            .as_deref()
            .filter(|mode| mode_state.available.iter().any(|id| id == mode))
            .filter(|mode| mode_state.current.as_deref() != Some(mode))
            && let Err(error) = runtime.set_session_mode(&session_id, desired).await
        {
            tracing::warn!(
                provider = %runtime.config.id,
                %error,
                "failed to apply ACP session mode; continuing with agent default"
            );
        }
    }

    let text = inputs
        .iter()
        .filter_map(|input| match input {
            TurnInputItem::Text { text, .. } => Some(text.as_str()),
            TurnInputItem::Image(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut content = Vec::new();
    if !text.trim().is_empty() {
        content.push(serde_json::json!({ "type": "text", "text": text }));
    }
    let supports_images = runtime.capability_summary().await.supports_images;
    let mut encoded_budget = crate::acp::MAX_ACP_TOTAL_ENCODED_IMAGE_BYTES;
    for input in inputs {
        let TurnInputItem::Image(image) = input else {
            continue;
        };
        if supports_images {
            // Falls back to a text reference on oversize/unreadable files, so
            // the attachment is never silently dropped.
            content.push(crate::acp::acp_image_content_block(image, &mut encoded_budget).await);
        } else {
            let reference = image
                .local_path
                .as_deref()
                .or(image.name.as_deref())
                .unwrap_or("attachment");
            content.push(serde_json::json!({
                "type": "text",
                "text": format!("[attached image: {reference}]"),
            }));
        }
    }

    let app = app.clone();
    let workspace_id = workspace_id.to_string();
    let thread_id = thread_id.to_string();
    tokio::spawn(async move {
        let outcome = runtime.prompt(&session_id, content).await;
        let (status, error) = match &outcome {
            Ok(stop_reason) if stop_reason == "cancelled" => (ThreadStatus::Idle, None),
            Ok(_) => (ThreadStatus::Idle, None),
            Err(error) => (ThreadStatus::Error, Some(error.to_string())),
        };
        let updated = app
            .upsert_thread(&workspace_id, &thread_id, |thread| {
                thread.status = status.clone();
                thread.last_error = error.clone();
                thread.updated_at = Utc::now();
            })
            .await;
        if let Ok(thread) = updated {
            app.emit(
                Some(workspace_id.clone()),
                Some(thread_id.clone()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        app.dispatch_next_queued_turn(&workspace_id, &thread_id);
        app.maybe_schedule_ai_thread_title(workspace_id, thread_id)
            .await;
    });
    Ok(())
}
