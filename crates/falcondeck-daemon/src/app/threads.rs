use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, atomic::Ordering},
};

use chrono::Utc;
use falcondeck_core::{
    AgentProvider, ApprovalDecision, ContentLifecycle, ConversationItem, InteractiveRequestKind,
    InteractiveRequestOutcome, InteractiveRequestResolution, SendTurnRequest, ServiceLevel,
    TextDeltaTarget, ThreadAgentParams, ThreadAttention, ThreadAttentionLevel, ThreadStatus,
    ThreadSummary, ToolLifecycle, TurnInputItem, UnifiedEvent, merge_conversation_citations,
};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt},
    time::{Duration, timeout},
};
use uuid::Uuid;

use super::{
    AppState, ManagedThread, ManagedWorkspace, PendingServerRequest,
    SHUTDOWN_INTERRUPTED_TURN_ERROR,
    agent_helpers::{
        SUBAGENT_ACTIVITY_KEPT_STEPS, append_claude_text_delta, claude_parent_tool_use_id,
        claude_stream_message_id, claude_tool_result_image_items, extract_claude_error,
        extract_claude_service_message, extract_claude_text_chunk, extract_claude_thinking_chunk,
        extract_claude_tool_event, format_subagent_activity, is_claude_message_start,
        is_claude_text_block_start, merge_claude_assistant_text,
    },
    conversation_helpers::{
        TRANSIENT_PROVIDER_ERROR_MESSAGE, TURN_RECEIPT_ID_PREFIX, ToolSettlement,
        assistant_is_transient_provider_error, build_ai_thread_title_prompt,
        build_refresh_ai_thread_title_prompt, is_placeholder_thread_title,
        is_provisional_thread_title, is_transient_provider_error, normalize_generated_thread_title,
        sanitize_conversation_item, settle_content_items, settle_items_as_shutdown_interrupted,
        settle_tool_call_items, should_generate_ai_thread_title,
        terminal_assistant_receipt_with_error, tool_display_metadata,
        with_renderable_attachment_previews,
    },
    harness_user_text::transient_retry_user_text,
    is_shutdown_interrupted,
};
use crate::{
    agy::{self, AgyRuntime, AgyStreamEvent},
    claude::{
        self, ClaudeRuntime, ClaudeStreamLine, encode_control_response_error,
        is_resume_startup_failure, live_context_usage, parse_claude_stream_lines,
        result_is_cancelled, result_model_context_window, synthetic_permission_requests,
    },
    codex::CodexSessionLease,
    error::DaemonError,
};

/// How many extra Codex turns FalconDeck will start after a retryable
/// backend outage. Codex already retried internally; these wait longer.
const MAX_TRANSIENT_TURN_RETRIES: u8 = 3;
const TRANSIENT_RETRY_DELAYS_MS: [u64; 3] = [2_000, 8_000, 20_000];
const TRANSIENT_RETRY_RECEIPT: &str = "Codex was temporarily unavailable. Retrying…";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TransientTurnPlan {
    Retry,
    GiveUp { message: String },
    Ignored,
}

/// How long a running Claude turn may stay silent — no stream traffic at all,
/// not even thinking heartbeats — before the thread gets a visible warning.
/// Long tool runs (builds, test suites) are legitimately silent, so this warns
/// rather than intervenes, and names the tool when one is mid-flight.
const CLAUDE_STALL_WARN_AFTER: Duration = Duration::from_secs(300);
const CLAUDE_STALL_CHECK_INTERVAL: Duration = Duration::from_secs(60);
/// Stderr lines kept for the failure message when the CLI dies without a
/// `result` event. `bounded_turn_error` clamps the final string anyway.
const CLAUDE_STDERR_TAIL_LINES: usize = 6;

/// Titler runs allowed per thread per daemon run. A failing utility chain
/// (missing CLI, expired auth) returns fast, so without a cap every item a
/// long turn produces would spawn another doomed process.
const MAX_AI_TITLE_ATTEMPTS: u8 = 3;

struct AiThreadTitleInput {
    workspace_path: String,
    prompt: String,
}

impl AppState {
    /// Closes transient content, tools, and response requests once an agent
    /// reports that its turn ended, even if an item-level terminal event was lost.
    pub(super) async fn settle_turn_items_with_error(
        &self,
        workspace_id: &str,
        thread_id: &str,
        settled_at: chrono::DateTime<Utc>,
        settlement: ToolSettlement,
        error: Option<&str>,
    ) {
        let cancelled_request_ids = {
            let mut requests = self.inner.interactive_requests.lock().await;
            let mut ids = Vec::new();
            requests.retain(|(request_workspace_id, request_id), pending| {
                let belongs_to_turn = request_workspace_id == workspace_id
                    && pending.request.thread_id.as_deref() == Some(thread_id);
                if belongs_to_turn {
                    ids.push(request_id.clone());
                }
                !belongs_to_turn
            });
            ids
        };
        if !cancelled_request_ids.is_empty() {
            let senders = {
                let mut approvals = self.inner.claude_approvals.lock().await;
                cancelled_request_ids
                    .iter()
                    .filter_map(|request_id| {
                        approvals.remove(&(workspace_id.to_string(), request_id.clone()))
                    })
                    .collect::<Vec<_>>()
            };
            for sender in senders {
                let _ = sender.send(crate::claude::ClaudeHookReply::Approval(
                    ApprovalDecision::Deny,
                ));
            }
        }
        let (updated, terminal_receipt) = {
            let mut workspaces = self.inner.workspaces.lock().await;
            if let Some(thread) = workspaces
                .get_mut(workspace_id)
                .and_then(|workspace| workspace.threads.get_mut(thread_id))
            {
                let mut updated = settle_tool_call_items(&mut thread.items, settled_at, settlement);
                let content_terminal = match settlement {
                    ToolSettlement::Completed => ContentLifecycle::Complete,
                    ToolSettlement::Failed => ContentLifecycle::Error,
                    ToolSettlement::Interrupted => ContentLifecycle::Interrupted,
                };
                updated.extend(settle_content_items(
                    &mut thread.items,
                    content_terminal,
                    settled_at,
                    error,
                ));
                let terminal_receipt = terminal_assistant_receipt_with_error(
                    &thread.items,
                    content_terminal,
                    settled_at,
                    thread.summary.latest_turn_id.as_deref(),
                    error,
                );
                for item in &mut thread.items {
                    if let ConversationItem::InteractiveRequest {
                        id,
                        resolved,
                        resolution,
                        ..
                    } = item
                        && !*resolved
                        && cancelled_request_ids.contains(id)
                    {
                        *resolved = true;
                        *resolution = Some(InteractiveRequestResolution {
                            outcome: InteractiveRequestOutcome::Cancelled,
                            resolved_at: settled_at,
                        });
                        updated.push(item.clone());
                    }
                }
                (updated, terminal_receipt)
            } else {
                (Vec::new(), None)
            }
        };
        if updated.is_empty() && terminal_receipt.is_none() && cancelled_request_ids.is_empty() {
            return;
        }
        for item in updated {
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ConversationItemUpdated { item },
            );
        }
        if let Some(item) = terminal_receipt {
            // Use the normal insertion path so identity indexes, unread
            // attention, relay emission, and reconnect snapshots all agree.
            let _ = self
                .push_conversation_item(workspace_id, thread_id, item, true)
                .await;
        }
        if !cancelled_request_ids.is_empty() {
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::Snapshot {
                    snapshot: self.snapshot().await,
                },
            );
        }
        let _ = self.persist_local_state().await;
    }

    pub(super) async fn session_for(
        &self,
        workspace_id: &str,
    ) -> Result<CodexSessionLease, DaemonError> {
        for _ in 0..2 {
            let candidate = {
                let workspaces = self.inner.workspaces.lock().await;
                let workspace = workspaces.get(workspace_id).ok_or_else(|| {
                    DaemonError::NotFound(format!("workspace {workspace_id} was not found"))
                })?;
                workspace.codex_session.as_ref().map(Arc::clone)
            };

            if let Some(candidate) = candidate
                && let Some(lease) = candidate.lease().await
            {
                // Retirement removes the map entry while holding the lease's
                // exclusive counterpart. Rechecking identity after acquiring
                // our shared lease closes the lookup-versus-retire race.
                let still_attached = self
                    .inner
                    .workspaces
                    .lock()
                    .await
                    .get(workspace_id)
                    .and_then(|workspace| workspace.codex_session.as_ref())
                    .is_some_and(|attached| lease.belongs_to(attached));
                if still_attached {
                    return Ok(lease);
                }
            }

            self.wake_codex_runtime(workspace_id).await?;
        }

        Err(DaemonError::Process(format!(
            "Codex could not stay connected for workspace {workspace_id}"
        )))
    }

    /// Materialize a restored Codex thread before using thread-scoped RPCs.
    /// Goal reads and writes have the same requirement as starting a turn.
    pub(super) async fn resume_codex_thread_if_needed(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<CodexSessionLease, DaemonError> {
        let session = self.session_for(workspace_id).await?;
        let (requires_resume, cwd, summary) = {
            let workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let thread = workspace
                .threads
                .get(thread_id)
                .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
            let cwd = thread.summary.variant.as_ref().map_or_else(
                || workspace.summary.path.clone(),
                |variant| variant.path.clone(),
            );
            (thread.requires_resume, cwd, thread.summary.clone())
        };
        if requires_resume {
            let response = session.resume_thread(thread_id, &cwd).await?;
            let hydration_cwd = cwd.clone();
            let hydrated = tokio::task::spawn_blocking(move || {
                crate::codex::hydrate_thread_response(summary, &response, &hydration_cwd)
            })
            .await
            .map_err(|error| {
                DaemonError::Process(format!(
                    "failed to hydrate resumed Codex thread {thread_id}: {error}"
                ))
            })?;
            let mut workspaces = self.inner.workspaces.lock().await;
            let hydrated = if let Some(workspace) = workspaces.get_mut(workspace_id)
                && let Some(thread) = workspace.threads.get_mut(thread_id)
            {
                apply_resumed_codex_thread_hydration(thread, hydrated);
                true
            } else {
                false
            };
            drop(workspaces);
            if hydrated {
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::Snapshot {
                        snapshot: self.snapshot().await,
                    },
                );
                self.schedule_persist();
                self.maybe_schedule_ai_thread_title(
                    workspace_id.to_string(),
                    thread_id.to_string(),
                )
                .await;
            }
        }
        Ok(session)
    }

    /// Kick off a background Codex goal refresh for a thread, deduplicated
    /// per (workspace, thread). `thread.detail` used to await this inline:
    /// `thread/goal/get` has no deadline of its own and the app-server often
    /// defers it while a turn is streaming, so every open of a goal-less
    /// Codex thread could stall the response for many seconds. Clients see
    /// the goal arrive via `ThreadUpdated` when (and if) it changes.
    pub(super) fn schedule_codex_goal_refresh(&self, workspace_id: &str, thread_id: &str) {
        let key = (workspace_id.to_string(), thread_id.to_string());
        if !self
            .inner
            .codex_goal_refreshes_in_flight
            .lock()
            .expect("codex goal refresh set poisoned")
            .insert(key.clone())
        {
            return;
        }
        let app = self.clone();
        tokio::spawn(async move {
            if let Err(error) = app.refresh_codex_thread_goal(&key.0, &key.1).await {
                tracing::debug!(
                    workspace_id = %key.0,
                    thread_id = %key.1,
                    %error,
                    "could not refresh Codex thread goal"
                );
            }
            app.inner
                .codex_goal_refreshes_in_flight
                .lock()
                .expect("codex goal refresh set poisoned")
                .remove(&key);
        });
    }

    async fn refresh_codex_thread_goal(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<(), DaemonError> {
        let session = self
            .resume_codex_thread_if_needed(workspace_id, thread_id)
            .await?;
        // Bounded control request: a wedged app-server must not hold the
        // dedup slot hostage forever.
        let result = session
            .send_control_request(
                "thread/goal/get",
                serde_json::json!({ "threadId": thread_id }),
            )
            .await?;
        let mut goal = crate::codex::parse_thread_goal(&result);
        let mut changed = false;
        self.with_thread_mut(workspace_id, thread_id, |thread| {
            // The provider refresh carries no start time; the daemon's stamp
            // (persisted across restarts) must survive it, or every client's
            // elapsed clock resets on the first `thread.detail`.
            if let Some(goal) = goal.as_mut()
                && goal.started_at.is_none()
            {
                goal.started_at = thread
                    .goal
                    .as_ref()
                    .and_then(|existing| existing.started_at)
                    .or_else(|| Some(Utc::now()));
            }
            if thread.goal != goal {
                thread.goal = goal;
                changed = true;
            }
        })
        .await?;
        if changed {
            let thread = self.thread_summary(workspace_id, thread_id).await?;
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        Ok(())
    }

    pub(super) async fn claude_runtime_for(
        &self,
        workspace_id: &str,
    ) -> Result<Arc<ClaudeRuntime>, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.claude_runtime.as_ref())
            .map(Arc::clone)
            .ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "workspace {workspace_id} is not currently connected to Claude"
                ))
            })
    }

    pub(super) async fn agy_runtime_for(
        &self,
        workspace_id: &str,
    ) -> Result<Arc<AgyRuntime>, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.agy_runtime.as_ref())
            .map(Arc::clone)
            .ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "workspace {workspace_id} is not currently connected to Antigravity"
                ))
            })
    }

    pub(super) async fn thread_provider(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<AgentProvider, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        workspace
            .threads
            .get(thread_id)
            .map(|thread| thread.summary.provider.clone())
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))
    }

    pub(super) async fn upsert_thread<F>(
        &self,
        workspace_id: &str,
        thread_id: &str,
        updater: F,
    ) -> Result<ThreadSummary, DaemonError>
    where
        F: FnOnce(&mut ThreadSummary),
    {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let now = Utc::now();
        let thread = workspace
            .threads
            .entry(thread_id.to_string())
            .or_insert_with(|| {
                ManagedThread::new(ThreadSummary {
                    id: thread_id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    title: "Untitled thread".to_string(),
                    provider: AgentProvider::CODEX,
                    native_session_id: None,
                    provider_transport: None,
                    handoff_from: None,
                    origin: None,
                    status: ThreadStatus::Idle,
                    updated_at: now,
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
            });
        let before = thread.summary.updated_at;
        let previous_status = thread.summary.status.clone();
        updater(&mut thread.summary);
        if thread.summary.updated_at == before {
            thread.summary.updated_at = now;
        }
        // Deliberately not touching current_thread_id: this runs for
        // background activity (turn ends, notifications, title updates) on any
        // thread, and "current" is the restore hint for where the user last
        // acted — send_turn and start_thread set it themselves.
        if thread.summary.updated_at > workspace.summary.updated_at {
            workspace.summary.updated_at = thread.summary.updated_at;
        }
        let status_changed = previous_status != thread.summary.status;
        let summary = thread.summary.clone();
        drop(workspaces);
        if status_changed && let Err(error) = self.persist_local_state().await {
            tracing::warn!(%error, "failed to persist thread status change");
        }
        Ok(summary)
    }

    pub(crate) async fn with_thread_mut<F>(
        &self,
        workspace_id: &str,
        thread_id: &str,
        updater: F,
    ) -> Result<(), DaemonError>
    where
        F: FnOnce(&mut ThreadSummary),
    {
        self.upsert_thread(workspace_id, thread_id, updater).await?;
        Ok(())
    }

    /// Cheap status peek for paths that only need to know whether the thread
    /// is blocked on the user (no summary rebuild, no attention counts).
    pub(super) async fn thread_waiting_for_input(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> bool {
        let workspaces = self.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.threads.get(thread_id))
            .is_some_and(|thread| matches!(thread.summary.status, ThreadStatus::WaitingForInput))
    }

    pub(super) async fn with_managed_thread_mut<F>(
        &self,
        workspace_id: &str,
        thread_id: &str,
        updater: F,
    ) -> Result<(), DaemonError>
    where
        F: FnOnce(&mut ManagedThread),
    {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        updater(thread);
        let updated_at = thread.summary.updated_at;
        // Same as upsert_thread: background mutations must not move the
        // workspace's current-thread restore hint.
        if updated_at > workspace.summary.updated_at {
            workspace.summary.updated_at = updated_at;
        }
        Ok(())
    }

    pub(crate) async fn thread_summary(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let summary = thread.summary.clone();
        drop(workspaces);
        Ok(self.build_thread_summary_from_clone(summary).await)
    }

    pub(super) async fn build_thread_summary_from_clone(
        &self,
        mut summary: ThreadSummary,
    ) -> ThreadSummary {
        let interactive_requests = self.inner.interactive_requests.lock().await;
        let (pending_approval_count, pending_question_count) =
            interactive_request_counts(&interactive_requests, &summary.id);
        refresh_thread_attention(&mut summary, pending_approval_count, pending_question_count);
        summary
    }

    /// Names the most recent threads a provider only gave a prompt preview to.
    ///
    /// Claude sessions almost never carry a title of their own, so without this
    /// a thread keeps its opening prompt as a name until it happens to run
    /// another turn. Bounded to the newest few threads: each title costs a
    /// utility-model call, and a busy workspace hydrates hundreds of sessions.
    pub(super) async fn backfill_provider_preview_titles(&self, workspace_id: &str, limit: usize) {
        let candidates = {
            let workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get(workspace_id) else {
                return;
            };
            let mut threads = workspace
                .threads
                .values()
                .filter(|thread| {
                    thread.title_is_provider_preview
                        && !thread.summary.is_archived
                        && should_generate_ai_thread_title(thread)
                })
                .map(|thread| (thread.summary.updated_at, thread.summary.id.clone()))
                .collect::<Vec<_>>();
            threads.sort_by_key(|(updated_at, _)| std::cmp::Reverse(*updated_at));
            threads
                .into_iter()
                .take(limit)
                .map(|(_, thread_id)| thread_id)
                .collect::<Vec<_>>()
        };

        for thread_id in candidates {
            self.maybe_schedule_ai_thread_title(workspace_id.to_string(), thread_id)
                .await;
        }
    }

    pub(super) async fn maybe_schedule_ai_thread_title(
        &self,
        workspace_id: String,
        thread_id: String,
    ) {
        let title_input = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get_mut(&workspace_id) else {
                return;
            };
            let Some(thread) = workspace.threads.get_mut(&thread_id) else {
                return;
            };
            if thread.manual_title || thread.ai_title_generated || thread.ai_title_in_flight {
                return;
            }
            if thread.ai_title_attempts >= MAX_AI_TITLE_ATTEMPTS {
                return;
            }
            if !should_generate_ai_thread_title(thread) {
                return;
            }
            thread.ai_title_in_flight = true;
            thread.ai_title_attempts += 1;
            AiThreadTitleInput {
                workspace_path: thread
                    .summary
                    .working_directory(&workspace.summary.path)
                    .to_string(),
                prompt: build_ai_thread_title_prompt(&thread.items),
            }
        };

        let app = self.clone();
        tokio::spawn(async move {
            let generated = app
                .generate_ai_thread_title(&workspace_id, &title_input)
                .await;
            match generated {
                Some(title) => {
                    let _ = app
                        .with_managed_thread_mut(&workspace_id, &thread_id, |thread| {
                            if thread.manual_title
                                || thread.ai_title_generated
                                || (!thread.title_is_provider_preview
                                    && !is_placeholder_thread_title(&thread.summary.title)
                                    && !is_provisional_thread_title(&thread.summary.title))
                            {
                                thread.ai_title_in_flight = false;
                                return;
                            }
                            thread.summary.title = title.clone();
                            thread.ai_title_generated = true;
                            thread.ai_title_in_flight = false;
                            thread.title_is_provider_preview = false;
                        })
                        .await;
                    if let Ok(thread) = app.thread_summary(&workspace_id, &thread_id).await {
                        app.emit(
                            Some(workspace_id.clone()),
                            Some(thread_id.clone()),
                            UnifiedEvent::ThreadUpdated { thread },
                        );
                        let _ = app.persist_local_state().await;
                    }
                }
                None => {
                    let _ = app
                        .with_managed_thread_mut(&workspace_id, &thread_id, |thread| {
                            thread.ai_title_in_flight = false;
                        })
                        .await;
                }
            }
        });
    }

    /// After a Codex turn fails with a retryable backend outage, keep the
    /// thread running and start a continuation turn once the backoff elapses.
    pub(super) async fn plan_transient_turn_retry(
        &self,
        workspace_id: &str,
        thread_id: &str,
        error: Option<&str>,
    ) -> TransientTurnPlan {
        let scheduled = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get_mut(workspace_id) else {
                return TransientTurnPlan::Ignored;
            };
            let Some(thread) = workspace.threads.get_mut(thread_id) else {
                return TransientTurnPlan::Ignored;
            };
            if thread.summary.provider != AgentProvider::CODEX {
                thread.transient_retry_in_flight = false;
                return TransientTurnPlan::Ignored;
            }
            let last_attempt_was_transient =
                thread.items.iter().rev().find_map(|item| match item {
                    ConversationItem::Service { message, .. }
                        if message == TRANSIENT_RETRY_RECEIPT =>
                    {
                        Some(false)
                    }
                    ConversationItem::UserMessage { .. } => Some(false),
                    ConversationItem::AssistantMessage {
                        phase: Some(falcondeck_core::AssistantMessagePhase::Commentary),
                        ..
                    } => None,
                    ConversationItem::AssistantMessage { .. } => {
                        Some(assistant_is_transient_provider_error(item))
                    }
                    _ => None,
                });
            let transient = error.is_some_and(is_transient_provider_error)
                || last_attempt_was_transient.unwrap_or(false);
            if !transient {
                thread.transient_retry_in_flight = false;
                return TransientTurnPlan::Ignored;
            }
            if thread.transient_retry_attempts >= MAX_TRANSIENT_TURN_RETRIES {
                thread.transient_retry_in_flight = false;
                return TransientTurnPlan::GiveUp {
                    message: TRANSIENT_PROVIDER_ERROR_MESSAGE.to_string(),
                };
            }
            thread.transient_retry_attempts += 1;
            thread.transient_retry_in_flight = true;
            Some((
                thread.transient_retry_attempts,
                thread.transient_retry_generation,
            ))
        };

        let Some((attempt, generation)) = scheduled else {
            return TransientTurnPlan::GiveUp {
                message: TRANSIENT_PROVIDER_ERROR_MESSAGE.to_string(),
            };
        };

        self.push_conversation_diagnostic(
            workspace_id,
            thread_id,
            ServiceLevel::Info,
            TRANSIENT_RETRY_RECEIPT.to_string(),
            Some("transient-retry".to_string()),
        )
        .await;

        if !cfg!(test) {
            let app = self.clone();
            let workspace_id = workspace_id.to_string();
            let thread_id = thread_id.to_string();
            tokio::spawn(async move {
                let delay_ms = TRANSIENT_RETRY_DELAYS_MS[(attempt as usize)
                    .saturating_sub(1)
                    .min(TRANSIENT_RETRY_DELAYS_MS.len() - 1)];
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                app.run_transient_turn_retry(&workspace_id, &thread_id, generation)
                    .await;
            });
        }

        TransientTurnPlan::Retry
    }

    async fn run_transient_turn_retry(&self, workspace_id: &str, thread_id: &str, generation: u64) {
        {
            let workspaces = self.inner.workspaces.lock().await;
            let Some(thread) = workspaces
                .get(workspace_id)
                .and_then(|workspace| workspace.threads.get(thread_id))
            else {
                return;
            };
            if thread.transient_retry_generation != generation || !thread.transient_retry_in_flight
            {
                return;
            }
        }
        let result = self
            .send_turn(SendTurnRequest {
                workspace_id: workspace_id.to_string(),
                thread_id: thread_id.to_string(),
                inputs: vec![TurnInputItem::Text {
                    id: None,
                    text: transient_retry_user_text(),
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
            })
            .await;
        if let Err(error) = result {
            tracing::warn!(
                %error,
                thread = %thread_id,
                "failed to start a transient Codex retry"
            );
            let failed_at = Utc::now();
            let _ = self
                .with_managed_thread_mut(workspace_id, thread_id, |thread| {
                    if thread.transient_retry_generation != generation {
                        return;
                    }
                    thread.transient_retry_in_flight = false;
                    thread.summary.status = ThreadStatus::Error;
                    thread.summary.last_error = Some(TRANSIENT_PROVIDER_ERROR_MESSAGE.to_string());
                    thread.summary.updated_at = failed_at;
                })
                .await;
            if let Ok(thread) = self.thread_summary(workspace_id, thread_id).await {
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
            self.dispatch_next_queued_turn(workspace_id, thread_id);
        }
    }

    /// Cancels a pending Codex retry. Returns whether one was in flight so
    /// the interrupt path can succeed even when no provider turn is live.
    pub(super) async fn cancel_transient_turn_retry(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> bool {
        let cancelled = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(thread) = workspaces
                .get_mut(workspace_id)
                .and_then(|workspace| workspace.threads.get_mut(thread_id))
            else {
                return false;
            };
            let cancelled = thread.transient_retry_in_flight;
            thread.transient_retry_generation = thread.transient_retry_generation.saturating_add(1);
            thread.transient_retry_in_flight = false;
            thread.transient_retry_attempts = 0;
            cancelled
        };
        if cancelled {
            let settled_at = Utc::now();
            let _ = self
                .with_thread_mut(workspace_id, thread_id, |thread| {
                    if thread.status == ThreadStatus::Running {
                        thread.status = ThreadStatus::Idle;
                        thread.last_error = None;
                        thread.updated_at = settled_at;
                    }
                })
                .await;
            if let Ok(thread) = self.thread_summary(workspace_id, thread_id).await {
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
        }
        cancelled
    }

    /// Titles run on the cheap utility chain, so a user with only Codex,
    /// `OpenCode`, or Grok installed still gets one.
    async fn generate_ai_thread_title(
        &self,
        workspace_id: &str,
        input: &AiThreadTitleInput,
    ) -> Option<String> {
        let candidates = self.utility_model_candidates(workspace_id).await;
        let text = self
            .run_utility_prompt(
                &candidates,
                &input.workspace_path,
                &input.prompt,
                Duration::from_secs(25),
            )
            .await?;
        normalize_generated_thread_title(&text)
    }

    /// On-demand title for the rename dialog. Ignores the one-shot auto-title
    /// flags so a thread whose work has moved on can be renamed from recent
    /// messages. Does not apply the result; the caller still confirms.
    pub async fn suggest_thread_title(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<falcondeck_core::SuggestThreadTitleResponse, DaemonError> {
        let title_input = {
            let workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let thread = workspace
                .threads
                .get(thread_id)
                .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
            let has_user_message = thread
                .items
                .iter()
                .any(|item| matches!(item, ConversationItem::UserMessage { .. }));
            if !has_user_message {
                return Err(DaemonError::BadRequest(
                    "this thread doesn't have enough conversation to suggest a title".to_string(),
                ));
            }
            AiThreadTitleInput {
                workspace_path: thread
                    .summary
                    .working_directory(&workspace.summary.path)
                    .to_string(),
                prompt: build_refresh_ai_thread_title_prompt(&thread.items, &thread.summary.title),
            }
        };

        let candidates = self.utility_model_candidates(workspace_id).await;
        if candidates.is_empty() {
            return Err(DaemonError::BadRequest(
                "no signed-in harness available to suggest a title".to_string(),
            ));
        }
        let text = self
            .run_utility_prompt(
                &candidates,
                &title_input.workspace_path,
                &title_input.prompt,
                Duration::from_secs(25),
            )
            .await
            .ok_or_else(|| {
                DaemonError::BadRequest(
                    "couldn't generate a title from this conversation".to_string(),
                )
            })?;
        let title = normalize_generated_thread_title(&text).ok_or_else(|| {
            DaemonError::BadRequest("couldn't generate a title from this conversation".to_string())
        })?;
        Ok(falcondeck_core::SuggestThreadTitleResponse { title })
    }

    /// Republishes the count of background tasks still running on a parked
    /// thread. The turn is over, so nothing else will bump this thread until
    /// one of those tasks reports and wakes the agent again.
    async fn publish_background_task_count(&self, workspace_id: &str, thread_id: &str, count: u32) {
        let mut changed = false;
        let updated = self
            .with_thread_mut(workspace_id, thread_id, |thread| {
                changed = thread.attention.background_task_count != count;
                thread.attention.background_task_count = count;
            })
            .await;
        // A no-op update would re-broadcast the whole summary to every client
        // on each task event; only say something when the count moved.
        if updated.is_err() || !changed {
            return;
        }
        if let Ok(thread) = self.thread_summary(workspace_id, thread_id).await {
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
    }

    async fn finalize_claude_turn_at_result(
        &self,
        workspace_id: &str,
        thread_id: &str,
        turn_generation: u64,
        mut turn_error: Option<String>,
        saw_agent_output: bool,
        result_reported_success: bool,
        background_task_count: u32,
    ) -> bool {
        if result_reported_success && !saw_agent_output && turn_error.is_none() {
            turn_error =
                Some("Claude turn completed without emitting any assistant output".to_string());
        }
        if turn_error.is_some() {
            return false;
        }
        let Ok(runtime) = self.claude_runtime_for(workspace_id).await else {
            return false;
        };
        if !runtime.park_turn(thread_id, turn_generation).await {
            return false;
        }
        let settled_at = Utc::now();
        self.settle_turn_items_with_error(
            workspace_id,
            thread_id,
            settled_at,
            ToolSettlement::Completed,
            None,
        )
        .await;
        let _ = self
            .with_thread_mut(workspace_id, thread_id, |thread| {
                thread.status = ThreadStatus::Idle;
                thread.last_error = None;
                thread.attention.background_task_count = background_task_count;
                thread.updated_at = settled_at;
            })
            .await;
        if let Ok(thread) = self.thread_summary(workspace_id, thread_id).await {
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        self.dispatch_next_queued_turn(workspace_id, thread_id);
        self.notify_remote_attention("turn-complete", workspace_id, Some(thread_id.to_string()))
            .await;
        if saw_agent_output {
            self.maybe_schedule_ai_thread_title(workspace_id.to_string(), thread_id.to_string())
                .await;
        }
        true
    }

    async fn reply_to_claude_control_request(
        &self,
        workspace_id: &str,
        thread_id: &str,
        request_id: &str,
        subtype: &str,
    ) {
        // An ignored control_request stalls the CLI. Unknown subtypes — and
        // `can_use_tool`, which we handle via PreToolUse hooks instead — get
        // an error envelope rather than silence.
        let error = format!("Unsupported control request subtype: {subtype}");
        let line = encode_control_response_error(request_id, &error);
        if let Ok(runtime) = self.claude_runtime_for(workspace_id).await
            && let Err(error) = runtime.write_protocol_line(thread_id, &line).await
        {
            tracing::warn!(
                %workspace_id,
                %thread_id,
                subtype,
                "failed to reply to Claude control_request: {error}"
            );
        }
    }

    fn record_claude_live_usage(
        &self,
        workspace_id: &str,
        thread_id: &str,
        usage: claude::ClaudeLiveContextUsage,
        model_context_window: Option<u64>,
    ) {
        let usage = usage.to_thread_usage(model_context_window);
        self.inner
            .thread_token_usage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(thread_id.to_string(), usage.clone());
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ThreadTokenUsageUpdated { usage },
        );
    }

    async fn drop_claude_native_session(&self, workspace_id: &str, thread_id: &str) {
        let _ = self
            .with_thread_mut(workspace_id, thread_id, |thread| {
                thread.native_session_id = None;
            })
            .await;
    }

    /// Records the provider's session identity without ever replacing an
    /// established join key. A changed id means the CLI started a different
    /// conversation; accepting it would silently detach FalconDeck from the
    /// history the thread promised to continue.
    async fn confirm_provider_native_session(
        &self,
        workspace_id: &str,
        thread_id: &str,
        provider_label: &str,
        reported_session_id: &str,
    ) -> Result<(), DaemonError> {
        let mut expected = None;
        let mut newly_recorded = false;
        self.with_thread_mut(workspace_id, thread_id, |thread| {
            match thread.native_session_id.as_deref() {
                Some(existing) if existing != reported_session_id => {
                    expected = Some(existing.to_string());
                }
                Some(_) => {}
                None => {
                    thread.native_session_id = Some(reported_session_id.to_string());
                    newly_recorded = true;
                }
            }
        })
        .await?;
        if let Some(expected) = expected {
            return Err(DaemonError::BadRequest(format!(
                "{provider_label} reported session {reported_session_id}, but this thread is bound to {expected}; FalconDeck kept the original session link"
            )));
        }
        if newly_recorded {
            self.persist_local_state().await?;
        }
        Ok(())
    }

    pub(super) async fn monitor_claude_turn(
        &self,
        workspace_id: String,
        thread_id: String,
        turn_id: String,
        turn_generation: u64,
        stdout: Option<tokio::process::ChildStdout>,
        stderr: Option<tokio::process::ChildStderr>,
        resume_interrupted: bool,
    ) {
        // Assistant prose and thinking accumulate per API message, so text
        // that follows a tool call starts a fresh conversation item below the
        // tool card instead of merging into the pre-tool prose. Items are
        // keyed by the stream's message id when present (matching hydration,
        // which keys by `message.id`), with a fresh id per boundary otherwise.
        let mut assistant_id = format!("claude-assistant-{}", Uuid::new_v4().simple());
        let mut assistant_message_key: Option<String> = None;
        let mut assistant_text = String::new();
        let mut assistant_citations = Vec::new();
        let mut reasoning_text = String::new();
        // Set when a new text content block opens mid-turn; the next delta
        // starts a fresh paragraph rather than continuing the previous one.
        let mut assistant_block_break_pending = false;
        let mut tool_identity = HashMap::<String, (String, String)>::new();
        // Sub-agent step log per spawning tool call: (kept steps, dropped count).
        let mut subagent_steps = HashMap::<String, (Vec<String>, usize)>::new();
        let mut background_tasks = HashSet::<String>::new();
        // Every task the CLI still lists, blocking or not. A backgrounded
        // shell command does not hold the turn open, but it does mean the
        // agent is not finished with the thread: its notification wakes the
        // parent for another turn. The thread reports the count so the UI can
        // say "idle, but work is still in flight" instead of "done".
        let mut outstanding_tasks = HashSet::<String>::new();
        let mut background_task_tools = HashMap::<String, String>::new();
        let mut running_tool_titles = HashMap::<String, String>::new();
        let mut last_line_at = tokio::time::Instant::now();
        let mut stall_warned = false;
        let mut turn_error: Option<String> = None;
        let mut resume_session_confirmed = !resume_interrupted;
        let mut saw_agent_output = false;
        let stderr_task = stderr.map(|stderr| {
            let workspace_id = workspace_id.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move {
                // A CLI that dies without a `result` event usually says why
                // only on stderr; keep a short tail so the failure the user
                // sees can carry that reason instead of just an exit code.
                let mut tail = std::collections::VecDeque::with_capacity(CLAUDE_STDERR_TAIL_LINES);
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                loop {
                    // A read error (e.g. invalid UTF-8) must not end the loop:
                    // an undrained pipe eventually wedges the CLI mid-turn.
                    let line = match lines.next_line().await {
                        Ok(Some(line)) => line,
                        Ok(None) => break,
                        Err(error) => {
                            tracing::warn!("failed to read claude stderr line: {error}");
                            continue;
                        }
                    };
                    let message = line.trim();
                    if message.is_empty() {
                        continue;
                    }
                    tracing::debug!(%workspace_id, %thread_id, "claude stderr: {message}");
                    if tail.len() == CLAUDE_STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(message.to_string());
                }
                tail.into_iter().collect::<Vec<_>>()
            })
        });

        // The CLI's stdin stays open for the whole turn (that is what makes
        // steering possible), so it no longer exits at turn end and stdout
        // never reaches EOF on the happy path. The stream's terminal `result`
        // event is the turn boundary; stdout EOF remains the backstop for a
        // CLI that died without emitting one.
        //
        // The pipe is drained by its own task, decoupled from event handling:
        // the CLI stalls mid-turn if nothing empties the 64KB pipe buffer, so
        // slow handling (state writes, a wedged downstream) must never be what
        // reads stdout. The reader also keeps draining after the monitor stops
        // listening, which doubles as the post-`result` drain.
        let mut saw_result = false;
        let mut result_reported_success = false;
        let mut parked_between_turns = false;
        let mut saw_cancelled_result = false;
        let mut last_live_usage: Option<claude::ClaudeLiveContextUsage> = None;
        let mut model_context_window: Option<u64> = None;
        if let Some(stdout) = stdout {
            let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            tokio::spawn(async move {
                let mut stdout = stdout;
                let mut framer = claude::ClaudeNdjsonFramer::new();
                let mut buf = vec![0u8; 8192];
                loop {
                    match stdout.read(&mut buf).await {
                        // A dropped receiver means the monitor is done with
                        // events; keep reading so a late write cannot fill the
                        // buffer or SIGPIPE the CLI mid-shutdown.
                        Ok(0) => {
                            if let Some(line) = framer.flush() {
                                let _ = line_tx.send(line);
                            }
                            break;
                        }
                        Ok(n) => {
                            for line in framer.push(&buf[..n]) {
                                let _ = line_tx.send(line);
                            }
                        }
                        Err(error) => {
                            tracing::warn!("failed to read claude stdout: {error}");
                            if let Some(line) = framer.flush() {
                                let _ = line_tx.send(line);
                            }
                            break;
                        }
                    }
                }
            });
            'stdout: loop {
                let line = match timeout(CLAUDE_STALL_CHECK_INTERVAL, line_rx.recv()).await {
                    Ok(Some(line)) => line,
                    Ok(None) if parked_between_turns => {
                        if let Ok(runtime) = self.claude_runtime_for(&workspace_id).await {
                            let _ = runtime.finish_turn(&thread_id, turn_generation).await;
                        }
                        return;
                    }
                    Ok(None) => break,
                    Err(_) => {
                        // Total stream silence — not even thinking heartbeats.
                        // Either a tool is legitimately long-running or the CLI
                        // wedged; a thread that just sits there is what reads
                        // as "stopped working", so say which it is, once per
                        // silent stretch. An approval wait is expected silence
                        // and already renders its own pinned notice.
                        if !parked_between_turns
                            && !stall_warned
                            && last_line_at.elapsed() >= CLAUDE_STALL_WARN_AFTER
                            && !self
                                .thread_waiting_for_input(&workspace_id, &thread_id)
                                .await
                        {
                            stall_warned = true;
                            let minutes = last_line_at.elapsed().as_secs() / 60;
                            let message = match running_tool_titles.values().next() {
                                Some(title) => format!(
                                    "Still running {title} — no output for {minutes}m. Stop the turn if this looks stuck."
                                ),
                                // Past the turn's own `result`, silence means
                                // the parent already yielded and only async
                                // agents are outstanding — "no output from
                                // Claude" would read as a wedge when nothing
                                // is actually wrong.
                                None if saw_result && !background_tasks.is_empty() => {
                                    let count = background_tasks.len();
                                    let plural = if count == 1 { "" } else { "s" };
                                    format!(
                                        "Waiting on {count} background agent{plural} — no output for {minutes}m. Stop the turn if this looks stuck."
                                    )
                                }
                                None => format!(
                                    "No output from Claude for {minutes}m. Stop the turn if this looks stuck."
                                ),
                            };
                            // The banner is one sentence; the log carries the
                            // state that explains it, so a stuck turn can be
                            // diagnosed after the fact rather than re-run.
                            tracing::warn!(
                                %workspace_id,
                                %thread_id,
                                silent_secs = last_line_at.elapsed().as_secs(),
                                saw_result,
                                running_tools = ?running_tool_titles.values().collect::<Vec<_>>(),
                                background_tasks = ?background_tasks,
                                "claude turn stalled"
                            );
                            self.push_conversation_diagnostic(
                                &workspace_id,
                                &thread_id,
                                ServiceLevel::Warning,
                                message,
                                Some("claude-watchdog".to_string()),
                            )
                            .await;
                        }
                        continue;
                    }
                };
                last_line_at = tokio::time::Instant::now();
                stall_warned = false;
                if line.trim().is_empty() {
                    continue;
                }
                let mut records = parse_claude_stream_lines(&line);
                let extras: Vec<_> = records
                    .iter()
                    .flat_map(|record| match record {
                        ClaudeStreamLine::ControlResponse {
                            pending_permission_requests,
                            ..
                        } => synthetic_permission_requests(pending_permission_requests),
                        _ => Vec::new(),
                    })
                    .collect();
                records.extend(extras);
                for record in records {
                    match record {
                        ClaudeStreamLine::KeepAlive => continue,
                        ClaudeStreamLine::ControlCancelRequest { .. } => continue,
                        ClaudeStreamLine::ControlResponse { .. } => continue,
                        ClaudeStreamLine::ControlRequest {
                            request_id,
                            subtype,
                            ..
                        } => {
                            self.reply_to_claude_control_request(
                                &workspace_id,
                                &thread_id,
                                &request_id,
                                &subtype,
                            )
                            .await;
                            continue;
                        }
                        ClaudeStreamLine::Payload(value) => {
                            if let Some(usage) = live_context_usage(&value) {
                                last_live_usage = Some(usage);
                                self.record_claude_live_usage(
                                    &workspace_id,
                                    &thread_id,
                                    usage,
                                    model_context_window,
                                );
                            }
                            if let Some(window) = result_model_context_window(&value) {
                                model_context_window = Some(window);
                                if let Some(usage) = last_live_usage {
                                    self.record_claude_live_usage(
                                        &workspace_id,
                                        &thread_id,
                                        usage,
                                        model_context_window,
                                    );
                                }
                            }
                            if let Some(tasks) = claude_background_tasks(&value) {
                                background_tasks = tasks.blocking;
                                outstanding_tasks = tasks.all;
                                if parked_between_turns {
                                    self.publish_background_task_count(
                                        &workspace_id,
                                        &thread_id,
                                        outstanding_tasks.len() as u32,
                                    )
                                    .await;
                                }
                            }
                            if let Some(task) = claude_task_started(&value) {
                                if task.holds_turn_open {
                                    background_tasks.insert(task.task_id.clone());
                                }
                                outstanding_tasks.insert(task.task_id.clone());
                                // Recorded for every task, blocking or not: a
                                // backgrounded command still needs its spawning
                                // tool card settled when it eventually reports.
                                background_task_tools.insert(task.task_id, task.tool_use_id);
                            }
                            if let Some(task) = claude_task_finished(&value) {
                                background_tasks.remove(&task.task_id);
                                if outstanding_tasks.remove(&task.task_id) && parked_between_turns {
                                    self.publish_background_task_count(
                                        &workspace_id,
                                        &thread_id,
                                        outstanding_tasks.len() as u32,
                                    )
                                    .await;
                                }
                                let tool_id = task
                                    .tool_use_id
                                    .or_else(|| background_task_tools.remove(&task.task_id));
                                if let Some(tool_id) = tool_id {
                                    running_tool_titles.remove(&tool_id);
                                    let (title, tool_kind) =
                                        tool_identity.get(&tool_id).cloned().unwrap_or_else(|| {
                                            ("Sub-agent".to_string(), "Agent".to_string())
                                        });
                                    let item = ConversationItem::ToolCall {
                                        id: tool_id,
                                        title: title.clone(),
                                        tool_kind: tool_kind.clone(),
                                        status: task.status.clone(),
                                        output: task.summary.clone(),
                                        exit_code: None,
                                        display: Box::new(tool_display_metadata(
                                            &title,
                                            &tool_kind,
                                            &task.status,
                                            None,
                                            task.summary.as_deref(),
                                        )),
                                        detail: None,
                                        created_at: Utc::now(),
                                        completed_at: Some(Utc::now()),
                                    };
                                    let _ = self
                                        .push_conversation_item(
                                            &workspace_id,
                                            &thread_id,
                                            item,
                                            true,
                                        )
                                        .await;
                                }
                                // The task_notification has its own handler; nothing
                                // downstream applies. Without this continue, the bare
                                // `status` ("stopped", "killed", "interrupted") would
                                // slip through `extract_claude_service_message` and
                                // re-surface as an "stopped" diagnostic notice on every
                                // interrupted background task.
                                continue;
                            }
                            // Sub-agent traffic is tagged with the id of the tool
                            // call that spawned it. It must stay out of the main
                            // transcript paths — its prose would merge into the
                            // assistant's reply and its tool calls would render as
                            // main-loop work. Instead, fold each tool start into a
                            // step log on the spawning tool call's card; the
                            // parent's own tool_result later replaces the log with
                            // the sub-agent's report.
                            if let Some(parent_id) = claude_parent_tool_use_id(&value) {
                                let parent_id = parent_id.to_string();
                                let step = extract_claude_tool_event(&value)
                                    .filter(|event| event.status == "running")
                                    .and_then(|event| event.title);
                                if let Some(step) = step {
                                    let entry =
                                        subagent_steps.entry(parent_id.clone()).or_default();
                                    entry.0.push(step);
                                    if entry.0.len() > SUBAGENT_ACTIVITY_KEPT_STEPS {
                                        entry.0.remove(0);
                                        entry.1 += 1;
                                    }
                                    let output = format_subagent_activity(&entry.0, entry.1);
                                    saw_agent_output = true;
                                    let (title, tool_kind) =
                                        tool_identity.get(&parent_id).cloned().unwrap_or_else(
                                            || ("Sub-agent".to_string(), "Task".to_string()),
                                        );
                                    let item = ConversationItem::ToolCall {
                                        id: parent_id,
                                        title: title.clone(),
                                        tool_kind: tool_kind.clone(),
                                        status: "running".to_string(),
                                        output: Some(output.clone()),
                                        exit_code: None,
                                        display: Box::new(tool_display_metadata(
                                            &title,
                                            &tool_kind,
                                            "running",
                                            None,
                                            Some(&output),
                                        )),
                                        detail: None,
                                        created_at: Utc::now(),
                                        completed_at: None,
                                    };
                                    let _ = self
                                        .push_conversation_item(
                                            &workspace_id,
                                            &thread_id,
                                            item,
                                            true,
                                        )
                                        .await;
                                }
                                continue;
                            }
                            // The CLI must confirm the session FalconDeck
                            // requested. A different id is a different
                            // conversation, not permission to replace the
                            // durable join key for this thread.
                            if let Some(init_session_id) = claude_init_session_id(&value) {
                                match self
                                    .confirm_provider_native_session(
                                        &workspace_id,
                                        &thread_id,
                                        "Claude",
                                        &init_session_id,
                                    )
                                    .await
                                {
                                    Ok(()) => resume_session_confirmed = true,
                                    Err(error) => {
                                        turn_error = Some(error.to_string());
                                        break 'stdout;
                                    }
                                }
                            }
                            // Message boundary: start a fresh assistant item (and
                            // thinking item) for each API message.
                            if let Some(message_id) = claude_stream_message_id(&value) {
                                if assistant_message_key.as_deref() != Some(message_id.as_str()) {
                                    assistant_message_key = Some(message_id.clone());
                                    assistant_id = message_id;
                                    assistant_text.clear();
                                    assistant_citations.clear();
                                    reasoning_text.clear();
                                    assistant_block_break_pending = false;
                                }
                            } else if is_claude_message_start(&value) {
                                assistant_message_key = None;
                                assistant_id =
                                    format!("claude-assistant-{}", Uuid::new_v4().simple());
                                assistant_text.clear();
                                assistant_citations.clear();
                                reasoning_text.clear();
                                assistant_block_break_pending = false;
                            }
                            // Not part of the text else-if chain: a complete
                            // assistant echo can carry thinking and text blocks in
                            // one line, and thinking-only lines match nothing below.
                            if let Some(chunk) = extract_claude_thinking_chunk(&value)
                                && !chunk.text.is_empty()
                            {
                                reasoning_text = if chunk.is_delta {
                                    append_claude_text_delta(&reasoning_text, &chunk.text)
                                } else {
                                    merge_claude_assistant_text(&reasoning_text, &chunk.text)
                                };
                                saw_agent_output = true;
                                let item = ConversationItem::Reasoning {
                                    id: format!("{assistant_id}-reasoning"),
                                    summary: None,
                                    content: reasoning_text.clone(),
                                    lifecycle: ContentLifecycle::Streaming,
                                    duration_ms: None,
                                    created_at: Utc::now(),
                                };
                                let _ = self
                                    .push_conversation_item(&workspace_id, &thread_id, item, true)
                                    .await;
                            }
                            let compaction_item = claude_context_compaction_item(&value);
                            if let Some(item) = compaction_item.clone() {
                                // A manual `/compact` result intentionally has
                                // no assistant prose. Treat its structured
                                // boundary as the turn output so the generic
                                // empty-response guard does not turn a
                                // successful compaction into an error.
                                saw_agent_output = true;
                                let _ = self
                                    .push_conversation_item(&workspace_id, &thread_id, item, true)
                                    .await;
                            }
                            if is_claude_text_block_start(&value) {
                                assistant_block_break_pending = !assistant_text.is_empty();
                            }
                            if let Some(chunk) = extract_claude_text_chunk(&value) {
                                assistant_text = if chunk.text.is_empty() {
                                    assistant_text
                                } else if chunk.is_delta {
                                    if std::mem::take(&mut assistant_block_break_pending) {
                                        format!(
                                            "{}\n\n{}",
                                            assistant_text.trim_end(),
                                            chunk.text.trim_start()
                                        )
                                    } else {
                                        append_claude_text_delta(&assistant_text, &chunk.text)
                                    }
                                } else {
                                    assistant_block_break_pending = false;
                                    merge_claude_assistant_text(&assistant_text, &chunk.text)
                                };
                                merge_conversation_citations(
                                    &mut assistant_citations,
                                    chunk.citations,
                                    &assistant_id,
                                );
                                saw_agent_output = true;
                                let item = ConversationItem::AssistantMessage {
                                    id: assistant_id.clone(),
                                    text: assistant_text.clone(),
                                    phase: None,
                                    memory_citation: None,
                                    citations: assistant_citations.clone(),
                                    lifecycle: ContentLifecycle::Streaming,
                                    error: None,
                                    created_at: Utc::now(),
                                };
                                let _ = self
                                    .push_conversation_item(&workspace_id, &thread_id, item, true)
                                    .await;
                            } else if let Some(tool_event) = extract_claude_tool_event(&value) {
                                saw_agent_output = true;
                                let known_identity = tool_identity.get(&tool_event.id).cloned();
                                let title = tool_event
                                    .title
                                    .or_else(|| {
                                        known_identity.as_ref().map(|(title, _)| title.clone())
                                    })
                                    .unwrap_or_else(|| "Claude tool".to_string());
                                let tool_kind = tool_event
                                    .tool_kind
                                    .or_else(|| {
                                        known_identity
                                            .as_ref()
                                            .map(|(_, tool_kind)| tool_kind.clone())
                                    })
                                    .unwrap_or_else(|| title.clone());
                                if tool_event.status == "running" {
                                    tool_identity.insert(
                                        tool_event.id.clone(),
                                        (title.clone(), tool_kind.clone()),
                                    );
                                    running_tool_titles
                                        .insert(tool_event.id.clone(), title.clone());
                                } else {
                                    running_tool_titles.remove(&tool_event.id);
                                }
                                let completed_at = if tool_event.status == "running" {
                                    None
                                } else {
                                    Some(Utc::now())
                                };
                                let tool_id = tool_event.id.clone();
                                let item = ConversationItem::ToolCall {
                                    id: tool_event.id,
                                    title: title.clone(),
                                    tool_kind: tool_kind.clone(),
                                    status: tool_event.status.clone(),
                                    output: tool_event.output.clone(),
                                    exit_code: None,
                                    display: Box::new(tool_display_metadata(
                                        &title,
                                        &tool_kind,
                                        &tool_event.status,
                                        None,
                                        tool_event.output.as_deref(),
                                    )),
                                    detail: None,
                                    created_at: Utc::now(),
                                    completed_at,
                                };
                                let _ = self
                                    .push_conversation_item(&workspace_id, &thread_id, item, true)
                                    .await;
                                for item in claude_tool_result_image_items(
                                    &tool_id,
                                    &title,
                                    &tool_event.images,
                                ) {
                                    let _ = self
                                        .push_conversation_item(
                                            &workspace_id,
                                            &thread_id,
                                            item,
                                            true,
                                        )
                                        .await;
                                }
                            } else if compaction_item.is_none()
                                && let Some(message) = extract_claude_service_message(&value)
                            {
                                // Awaited, not spawned: a service message on the
                                // last line of a turn would otherwise race the
                                // turn's own terminal thread update.
                                self.push_conversation_diagnostic(
                                    &workspace_id,
                                    &thread_id,
                                    ServiceLevel::Info,
                                    message,
                                    Some("claude".to_string()),
                                )
                                .await;
                            }
                            if result_is_cancelled(&value) {
                                saw_cancelled_result = true;
                            } else if let Some(error) = extract_claude_error(&value) {
                                turn_error = Some(error);
                            }
                            if let Some(is_error) = claude_result_is_error(&value) {
                                saw_result = true;
                                result_reported_success = !is_error && !saw_cancelled_result;
                                // Claude emits an interim result when the parent
                                // yields while async agents keep working. Closing
                                // stdin at that point kills those agents. Their
                                // terminal notification triggers another parent
                                // response/result, which is the real boundary.
                                // A cancelled result must not park: the CLI is
                                // done, even if `is_error` was omitted.
                                if is_error || saw_cancelled_result || background_tasks.is_empty() {
                                    tracing::info!(
                                        %workspace_id,
                                        %thread_id,
                                        is_error,
                                        cancelled = saw_cancelled_result,
                                        "claude turn finished at result"
                                    );
                                    if !is_error
                                        && !saw_cancelled_result
                                        && self
                                            .finalize_claude_turn_at_result(
                                                &workspace_id,
                                                &thread_id,
                                                turn_generation,
                                                turn_error.clone(),
                                                saw_agent_output,
                                                result_reported_success,
                                                outstanding_tasks.len() as u32,
                                            )
                                            .await
                                    {
                                        parked_between_turns = true;
                                        assistant_id =
                                            format!("claude-assistant-{}", Uuid::new_v4().simple());
                                        assistant_message_key = None;
                                        assistant_text.clear();
                                        assistant_citations.clear();
                                        reasoning_text.clear();
                                        assistant_block_break_pending = false;
                                        tool_identity.clear();
                                        subagent_steps.clear();
                                        background_tasks.clear();
                                        background_task_tools.clear();
                                        // `outstanding_tasks` deliberately
                                        // survives the park: those tasks
                                        // outlive the turn, and their
                                        // notifications are what start the
                                        // next one.
                                        running_tool_titles.clear();
                                        last_line_at = tokio::time::Instant::now();
                                        stall_warned = false;
                                        turn_error = None;
                                        saw_agent_output = false;
                                        saw_result = false;
                                        result_reported_success = false;
                                        saw_cancelled_result = false;
                                        last_live_usage = None;
                                        continue 'stdout;
                                    }
                                    break 'stdout;
                                }
                                // The single most confusing state this monitor can
                                // be in: the turn is over but the thread still
                                // reads as running. Say so, with the tasks that
                                // are keeping it open.
                                tracing::info!(
                                    %workspace_id,
                                    %thread_id,
                                    held_by = background_tasks.len(),
                                    tasks = ?background_tasks,
                                    "claude result received but holding turn open for background agents"
                                );
                            }
                        }
                    }
                }
            }
        }

        // Only the backstop path can await stderr: it ends at process exit,
        // which on the result path happens after the turn is already finished.
        let mut stderr_tail = Vec::new();
        if let Some(stderr_task) = stderr_task
            && !saw_result
        {
            stderr_tail = stderr_task.await.unwrap_or_default();
        }

        let mut was_interrupted = false;
        if let Ok(runtime) = self.claude_runtime_for(&workspace_id).await {
            let finished = if saw_result {
                Ok(runtime.complete_turn(&thread_id, turn_generation).await)
            } else {
                runtime.finish_turn(&thread_id, turn_generation).await
            };
            match finished {
                Ok(finish) if finish.stale => {
                    // A newer turn owns this thread now; leave its state alone.
                    return;
                }
                Ok(finish) if finish.interrupted || saw_cancelled_result => {
                    // A user-requested stop is a clean outcome, not an error —
                    // the CLI exits non-zero after SIGTERM/SIGKILL. A post-interrupt
                    // `error_during_execution` result is the same: cancelled, not failed.
                    was_interrupted = true;
                    turn_error = None;
                }
                Ok(finish) => match finish.status {
                    Some(status) if !status.success() && turn_error.is_none() => {
                        let headline = match status.code() {
                            Some(code) => format!("Claude turn failed with exit code {code}"),
                            None => "Claude turn failed".to_string(),
                        };
                        turn_error = Some(if stderr_tail.is_empty() {
                            headline
                        } else {
                            format!("{headline}: {}", stderr_tail.join("\n"))
                        });
                    }
                    Some(status)
                        if status.success() && !saw_agent_output && turn_error.is_none() =>
                    {
                        turn_error = Some(
                            "Claude turn completed without emitting any assistant output"
                                .to_string(),
                        );
                    }
                    _ => {}
                },
                Err(_) => {}
            }
        }
        // The result path finalizes before the process exits, so there is no
        // exit status to judge; the stream's own success flag stands in.
        if saw_result
            && result_reported_success
            && !saw_agent_output
            && turn_error.is_none()
            && !was_interrupted
            && !saw_cancelled_result
        {
            turn_error =
                Some("Claude turn completed without emitting any assistant output".to_string());
        }
        if saw_cancelled_result {
            was_interrupted = true;
            turn_error = None;
        }
        if resume_interrupted
            && !was_interrupted
            && !resume_session_confirmed
            && turn_error.is_none()
        {
            turn_error =
                Some("Claude ended without confirming the saved session identity".to_string());
        }
        let resume_failed = turn_error.as_deref().is_some_and(is_resume_startup_failure)
            || stderr_tail
                .iter()
                .any(|line| is_resume_startup_failure(line));
        if resume_interrupted && !was_interrupted && (resume_failed || !resume_session_confirmed) {
            let detail = turn_error
                .clone()
                .or_else(|| stderr_tail.last().cloned())
                .unwrap_or_else(|| "the provider did not confirm the session".to_string());
            self.push_conversation_diagnostic(
                &workspace_id,
                &thread_id,
                ServiceLevel::Warning,
                format!(
                    "Could not verify the saved Claude session. FalconDeck kept the original session link so Continue can be retried. {detail}"
                ),
                Some("claude-interrupted-resume".to_string()),
            )
            .await;
            turn_error = Some(super::SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string());
        } else if resume_failed {
            self.drop_claude_native_session(&workspace_id, &thread_id)
                .await;
            self.push_conversation_diagnostic(
                &workspace_id,
                &thread_id,
                ServiceLevel::Warning,
                "Could not resume the previous Claude session. The next message will start a new one."
                    .to_string(),
                Some("claude-resume".to_string()),
            )
            .await;
        }
        if was_interrupted {
            // Awaited so its thread update cannot land after the Idle one
            // emitted below; a stop that leaves the thread spinning forever is
            // exactly what the user sees when this races.
            self.push_conversation_diagnostic(
                &workspace_id,
                &thread_id,
                ServiceLevel::Info,
                "Turn interrupted".to_string(),
                Some("claude-interrupt".to_string()),
            )
            .await;
        }
        let final_error = turn_error.clone();
        let settled_at = Utc::now();
        let tool_settlement = if was_interrupted {
            ToolSettlement::Interrupted
        } else if final_error.is_some() {
            ToolSettlement::Failed
        } else {
            ToolSettlement::Completed
        };
        self.settle_turn_items_with_error(
            &workspace_id,
            &thread_id,
            settled_at,
            tool_settlement,
            final_error.as_deref(),
        )
        .await;
        let _ = self
            .with_thread_mut(&workspace_id, &thread_id, |thread| {
                thread.status = if final_error.is_some() {
                    ThreadStatus::Error
                } else {
                    ThreadStatus::Idle
                };
                thread.last_error = final_error.clone();
                // The CLI process is gone, so no background task can wake this
                // thread again; a leftover count would advertise work that
                // died with it.
                thread.attention.background_task_count = 0;
                thread.updated_at = settled_at;
            })
            .await;
        if let Ok(thread) = self.thread_summary(&workspace_id, &thread_id).await {
            self.emit(
                Some(workspace_id.clone()),
                Some(thread_id.clone()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        self.emit(
            Some(workspace_id.clone()),
            Some(thread_id.clone()),
            UnifiedEvent::TurnEnd {
                turn_id,
                status: if was_interrupted {
                    "interrupted"
                } else if final_error.is_some() {
                    "failed"
                } else {
                    "completed"
                }
                .to_string(),
                error: final_error.clone(),
            },
        );
        self.dispatch_next_queued_turn(&workspace_id, &thread_id);
        // A user-requested interrupt is not attention-worthy; a finished or
        // failed turn is. The relay only pushes to disconnected devices.
        if !was_interrupted {
            self.notify_remote_attention(
                if turn_error.is_some() {
                    "turn-error"
                } else {
                    "turn-complete"
                },
                &workspace_id,
                Some(thread_id.clone()),
            )
            .await;
        }
        if turn_error.is_none() && saw_agent_output {
            self.maybe_schedule_ai_thread_title(workspace_id, thread_id)
                .await;
        }
    }

    pub(super) async fn monitor_agy_turn(
        &self,
        workspace_id: String,
        thread_id: String,
        turn_generation: u64,
        stdout: Option<tokio::process::ChildStdout>,
        stderr: Option<tokio::process::ChildStderr>,
        resume_interrupted: bool,
    ) {
        let mut last_line_at = tokio::time::Instant::now();
        let mut stall_warned = false;
        let mut turn_error: Option<String> = None;
        let mut resume_session_confirmed = !resume_interrupted;
        let mut saw_agent_output = false;
        let mut assistant_text = HashMap::<String, String>::new();
        let mut running_tool_titles = HashMap::<String, String>::new();
        let stderr_task = stderr.map(|stderr| {
            let workspace_id = workspace_id.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move {
                let mut tail = std::collections::VecDeque::with_capacity(CLAUDE_STDERR_TAIL_LINES);
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                loop {
                    let line = match lines.next_line().await {
                        Ok(Some(line)) => line,
                        Ok(None) => break,
                        Err(error) => {
                            tracing::warn!("failed to read antigravity stderr line: {error}");
                            continue;
                        }
                    };
                    let message = line.trim();
                    if message.is_empty() {
                        continue;
                    }
                    tracing::debug!(%workspace_id, %thread_id, "agy stderr: {message}");
                    if tail.len() == CLAUDE_STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(message.to_string());
                }
                tail.into_iter().collect::<Vec<_>>()
            })
        });

        let mut saw_result = false;
        let mut result_reported_success = false;
        if let Some(stdout) = stdout {
            let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            let _ = line_tx.send(line);
                        }
                        Ok(None) => break,
                        Err(error) => {
                            tracing::warn!("failed to read antigravity stdout line: {error}");
                        }
                    }
                }
            });
            'stdout: loop {
                let line = match timeout(CLAUDE_STALL_CHECK_INTERVAL, line_rx.recv()).await {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(_) => {
                        if !stall_warned
                            && last_line_at.elapsed() >= CLAUDE_STALL_WARN_AFTER
                            && !self
                                .thread_waiting_for_input(&workspace_id, &thread_id)
                                .await
                        {
                            stall_warned = true;
                            let minutes = last_line_at.elapsed().as_secs() / 60;
                            let message = match running_tool_titles.values().next() {
                                Some(title) => format!(
                                    "Still running {title} — no output for {minutes}m. Stop the turn if this looks stuck."
                                ),
                                None => format!(
                                    "No output from Antigravity for {minutes}m. Stop the turn if this looks stuck."
                                ),
                            };
                            self.push_conversation_diagnostic(
                                &workspace_id,
                                &thread_id,
                                ServiceLevel::Warning,
                                message,
                                Some("agy-watchdog".to_string()),
                            )
                            .await;
                        }
                        continue;
                    }
                };
                last_line_at = tokio::time::Instant::now();
                stall_warned = false;
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Some(event) = agy::parse_stream_line(trimmed) else {
                    continue;
                };
                match event {
                    AgyStreamEvent::Init { conversation_id } => {
                        if !conversation_id.is_empty() {
                            match self
                                .confirm_provider_native_session(
                                    &workspace_id,
                                    &thread_id,
                                    "Antigravity",
                                    &conversation_id,
                                )
                                .await
                            {
                                Ok(()) => resume_session_confirmed = true,
                                Err(error) => {
                                    turn_error = Some(error.to_string());
                                    break 'stdout;
                                }
                            }
                        }
                    }
                    AgyStreamEvent::Step {
                        step_index,
                        state,
                        step_type,
                        tool_name,
                        text_delta,
                        tool_output,
                        tool_error,
                        subagent_label,
                        ..
                    } => {
                        let done = state.eq_ignore_ascii_case("done");
                        if step_type == "user_input" || step_type == "checkpoint" {
                            continue;
                        }
                        if step_type == "agent_response" || text_delta.is_some() {
                            if let Some(delta) = text_delta.as_deref() {
                                saw_agent_output = true;
                                let item_id = format!("agy-assistant-{thread_id}-{step_index}");
                                let text = append_claude_text_delta(
                                    assistant_text
                                        .get(&item_id)
                                        .map(String::as_str)
                                        .unwrap_or(""),
                                    delta,
                                );
                                assistant_text.insert(item_id.clone(), text.clone());
                                let item = ConversationItem::AssistantMessage {
                                    id: item_id,
                                    text,
                                    phase: None,
                                    memory_citation: None,
                                    citations: Vec::new(),
                                    lifecycle: if done {
                                        ContentLifecycle::Complete
                                    } else {
                                        ContentLifecycle::Streaming
                                    },
                                    error: None,
                                    created_at: Utc::now(),
                                };
                                let _ = self
                                    .push_conversation_item(&workspace_id, &thread_id, item, true)
                                    .await;
                            }
                            continue;
                        }
                        if step_type == "tool" || tool_name.is_some() || subagent_label.is_some() {
                            let tool_id = format!("agy-tool-{thread_id}-{step_index}");
                            let title = agy::tool_step_title(
                                &step_type,
                                tool_name.as_deref(),
                                subagent_label.as_deref(),
                            );
                            let status = if let Some(error) = tool_error.as_deref() {
                                if !error.is_empty() {
                                    "failed"
                                } else if done {
                                    "completed"
                                } else {
                                    "running"
                                }
                            } else if done {
                                "completed"
                            } else {
                                "running"
                            };
                            let output = tool_error.clone().or(tool_output);
                            if status == "running" {
                                running_tool_titles.insert(tool_id.clone(), title.clone());
                            } else {
                                running_tool_titles.remove(&tool_id);
                            }
                            let item = ConversationItem::ToolCall {
                                id: tool_id,
                                title: title.clone(),
                                tool_kind: tool_name.clone().unwrap_or_else(|| step_type.clone()),
                                status: status.to_string(),
                                output: output.clone(),
                                exit_code: None,
                                display: Box::new(tool_display_metadata(
                                    &title,
                                    tool_name.as_deref().unwrap_or(&step_type),
                                    status,
                                    None,
                                    output.as_deref(),
                                )),
                                detail: None,
                                created_at: Utc::now(),
                                completed_at: done.then(Utc::now),
                            };
                            let _ = self
                                .push_conversation_item(&workspace_id, &thread_id, item, true)
                                .await;
                        }
                    }
                    AgyStreamEvent::Result {
                        conversation_id,
                        success,
                        response,
                        error,
                    } => {
                        if !conversation_id.is_empty() {
                            match self
                                .confirm_provider_native_session(
                                    &workspace_id,
                                    &thread_id,
                                    "Antigravity",
                                    &conversation_id,
                                )
                                .await
                            {
                                Ok(()) => resume_session_confirmed = true,
                                Err(error) => {
                                    turn_error = Some(error.to_string());
                                    break 'stdout;
                                }
                            }
                        }
                        if let Some(response) = response.filter(|text| !text.trim().is_empty())
                            && !saw_agent_output
                        {
                            saw_agent_output = true;
                            let item = ConversationItem::AssistantMessage {
                                id: format!("agy-assistant-{thread_id}-result"),
                                text: response,
                                phase: None,
                                memory_citation: None,
                                citations: Vec::new(),
                                lifecycle: ContentLifecycle::Complete,
                                error: None,
                                created_at: Utc::now(),
                            };
                            let _ = self
                                .push_conversation_item(&workspace_id, &thread_id, item, true)
                                .await;
                        }
                        if let Some(error) = error.filter(|text| !text.trim().is_empty()) {
                            turn_error = Some(error);
                        } else if !success {
                            turn_error = Some("Antigravity turn failed".to_string());
                        }
                        saw_result = true;
                        result_reported_success = success && turn_error.is_none();
                        break;
                    }
                }
            }
        }

        let mut stderr_tail = Vec::new();
        if let Some(stderr_task) = stderr_task
            && !saw_result
        {
            stderr_tail = stderr_task.await.unwrap_or_default();
        }

        let mut was_interrupted = false;
        if let Ok(runtime) = self.agy_runtime_for(&workspace_id).await {
            let finished = if saw_result {
                Ok(runtime.complete_turn(&thread_id, turn_generation).await)
            } else {
                runtime.finish_turn(&thread_id, turn_generation).await
            };
            match finished {
                Ok(finish) if finish.stale => return,
                Ok(finish) if finish.interrupted => {
                    was_interrupted = true;
                    turn_error = None;
                }
                Ok(finish) => match finish.status {
                    Some(status) if !status.success() && turn_error.is_none() => {
                        let headline = match status.code() {
                            Some(code) => {
                                format!("Antigravity turn failed with exit code {code}")
                            }
                            None => "Antigravity turn failed".to_string(),
                        };
                        turn_error = Some(if stderr_tail.is_empty() {
                            headline
                        } else {
                            format!("{headline}: {}", stderr_tail.join("\n"))
                        });
                    }
                    Some(status)
                        if status.success() && !saw_agent_output && turn_error.is_none() =>
                    {
                        turn_error = Some(
                            "Antigravity turn completed without emitting any assistant output"
                                .to_string(),
                        );
                    }
                    _ => {}
                },
                Err(_) => {}
            }
        }
        if saw_result
            && result_reported_success
            && !saw_agent_output
            && turn_error.is_none()
            && !was_interrupted
        {
            turn_error = Some(
                "Antigravity turn completed without emitting any assistant output".to_string(),
            );
        }
        if was_interrupted {
            self.push_conversation_diagnostic(
                &workspace_id,
                &thread_id,
                ServiceLevel::Info,
                "Turn interrupted".to_string(),
                Some("agy-interrupt".to_string()),
            )
            .await;
        }
        if resume_interrupted && !was_interrupted && !resume_session_confirmed {
            let detail = turn_error.clone().unwrap_or_else(|| {
                "Antigravity ended without confirming the saved session identity".to_string()
            });
            self.push_conversation_diagnostic(
                &workspace_id,
                &thread_id,
                ServiceLevel::Warning,
                format!(
                    "Could not verify the saved Antigravity session. FalconDeck kept the original session link so Continue can be retried. {detail}"
                ),
                Some("agy-interrupted-resume".to_string()),
            )
            .await;
            turn_error = Some(super::SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string());
        }
        let final_error = turn_error.clone();
        let settled_at = Utc::now();
        let tool_settlement = if was_interrupted {
            ToolSettlement::Interrupted
        } else if final_error.is_some() {
            ToolSettlement::Failed
        } else {
            ToolSettlement::Completed
        };
        self.settle_turn_items_with_error(
            &workspace_id,
            &thread_id,
            settled_at,
            tool_settlement,
            final_error.as_deref(),
        )
        .await;
        let _ = self
            .with_thread_mut(&workspace_id, &thread_id, |thread| {
                thread.status = if final_error.is_some() {
                    ThreadStatus::Error
                } else {
                    ThreadStatus::Idle
                };
                thread.last_error = final_error.clone();
                thread.updated_at = settled_at;
            })
            .await;
        if let Ok(thread) = self.thread_summary(&workspace_id, &thread_id).await {
            self.emit(
                Some(workspace_id.clone()),
                Some(thread_id.clone()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        self.dispatch_next_queued_turn(&workspace_id, &thread_id);
        if !was_interrupted {
            self.notify_remote_attention(
                if turn_error.is_some() {
                    "turn-error"
                } else {
                    "turn-complete"
                },
                &workspace_id,
                Some(thread_id.clone()),
            )
            .await;
        }
        if turn_error.is_none() && saw_agent_output {
            self.maybe_schedule_ai_thread_title(workspace_id, thread_id)
                .await;
        }
    }

    pub(super) async fn push_conversation_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        item: ConversationItem,
        update_existing: bool,
    ) -> Result<(), DaemonError> {
        self.upsert_conversation_item(workspace_id, thread_id, item, update_existing, true)
            .await
    }

    /// Replays a stored transcript item into a thread. Replay is history
    /// recovery, not new agent output: it must not advance
    /// `last_agent_activity_seq`, or every hydrated thread would read as
    /// unread — and keep re-reading as unread, since the global sequence the
    /// stamp uses keeps climbing past anything a client could mark read.
    pub(super) async fn replay_conversation_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        item: ConversationItem,
        update_existing: bool,
    ) -> Result<(), DaemonError> {
        self.upsert_conversation_item(workspace_id, thread_id, item, update_existing, false)
            .await
    }

    async fn upsert_conversation_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        mut item: ConversationItem,
        update_existing: bool,
        track_attention: bool,
    ) -> Result<(), DaemonError> {
        sanitize_conversation_item(&mut item);
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;

        let id = conversation_item_identity(&item);
        let existing_index = match &item {
            ConversationItem::AssistantMessage { .. } => thread.assistant_items.get(id).copied(),
            ConversationItem::Reasoning { .. } => thread.reasoning_items.get(id).copied(),
            ConversationItem::Plan { .. } => thread.plan_items.get(id).copied(),
            ConversationItem::ToolCall { .. } | ConversationItem::FileChange { .. } => {
                thread.tool_items.get(id).copied()
            }
            _ => thread.other_items.get(id).copied(),
        };

        if update_existing && let Some(index) = existing_index {
            let previous = thread.items[index].clone();
            thread.items[index] = item.clone();
            let track_attention = track_attention && marks_agent_activity(&item);
            if track_attention {
                thread.summary.attention.last_agent_activity_seq = thread
                    .summary
                    .attention
                    .last_agent_activity_seq
                    .max(self.inner.sequence.load(Ordering::Relaxed));
            }
            let skip_summary = is_in_flight_text_item(&item);
            let append_delta = in_flight_append_delta(&previous, &item);
            drop(workspaces);
            if let Some(delta) = append_delta {
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::Text {
                        item_id: conversation_item_identity(&item).to_string(),
                        delta: delta.text,
                        target: delta.target,
                        start_offset: Some(delta.start_offset),
                        end_offset: Some(delta.end_offset),
                    },
                );
            } else {
                let emitted_item = with_renderable_attachment_previews(item).await;
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::ConversationItemUpdated { item: emitted_item },
                );
            }
            // Streaming chunks already replace the previous item. A ThreadUpdated
            // on each one exists only to bump the attention seq, which the
            // terminal summary will carry — and it doubles the remote event rate.
            if track_attention && !skip_summary {
                let thread = self.thread_summary(workspace_id, thread_id).await?;
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
            // Deferred: this path runs per streamed chunk, and a full
            // persist per chunk backs the agent's stdout pipe up until the
            // CLI wedges mid-turn. Replayed history still schedules one —
            // the recovered transcript should survive a restart.
            self.schedule_persist();
            return Ok(());
        }

        let index = thread.items.len();
        match &item {
            ConversationItem::AssistantMessage { .. } => {
                thread.assistant_items.insert(id.to_string(), index);
            }
            ConversationItem::Reasoning { .. } => {
                thread.reasoning_items.insert(id.to_string(), index);
            }
            ConversationItem::Plan { .. } => {
                thread.plan_items.insert(id.to_string(), index);
            }
            ConversationItem::ToolCall { .. } | ConversationItem::FileChange { .. } => {
                thread.tool_items.insert(id.to_string(), index);
            }
            _ => {
                // First-wins to mirror the previous position()-based scan.
                thread.other_items.entry(id.to_string()).or_insert(index);
            }
        }
        thread.items.push(item.clone());
        let track_attention = track_attention && marks_agent_activity(&item);
        if track_attention {
            thread.summary.attention.last_agent_activity_seq = thread
                .summary
                .attention
                .last_agent_activity_seq
                .max(self.inner.sequence.load(Ordering::Relaxed));
        }
        // A new item is the only thing that can make a thread newly titleable,
        // so this is the earliest moment worth asking. Turn end also asks, as a
        // backstop for threads whose first agent item never arrives.
        let wants_title = !thread.ai_title_in_flight && should_generate_ai_thread_title(thread);
        let skip_summary = is_in_flight_text_item(&item);
        drop(workspaces);
        let emitted_item = with_renderable_attachment_previews(item).await;
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ConversationItemAdded { item: emitted_item },
        );
        if track_attention && !skip_summary {
            let thread = self.thread_summary(workspace_id, thread_id).await?;
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        // Deferred for the same reason as the update path above; replayed
        // history persists too, just without an attention-level bump.
        self.schedule_persist();
        if wants_title {
            self.maybe_schedule_ai_thread_title(workspace_id.to_string(), thread_id.to_string())
                .await;
        }
        Ok(())
    }

    pub(super) async fn resolve_interactive_request_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        request_id: &str,
        resolution: Option<InteractiveRequestResolution>,
    ) -> Result<(), DaemonError> {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let Some(index) = thread
            .other_items
            .get(request_id)
            .copied()
            .filter(|index| {
                matches!(
                    thread.items.get(*index),
                    Some(ConversationItem::InteractiveRequest { id, .. }) if id == request_id
                )
            })
            .or_else(|| {
                thread.items.iter().position(|item| match item {
                    ConversationItem::InteractiveRequest { id, .. } => id == request_id,
                    _ => false,
                })
            })
        else {
            return Ok(());
        };
        if let ConversationItem::InteractiveRequest {
            resolved,
            resolution: stored_resolution,
            ..
        } = &mut thread.items[index]
        {
            *resolved = true;
            if resolution.is_some() {
                *stored_resolution = resolution;
            }
        }
        let item = thread.items[index].clone();
        drop(workspaces);
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ConversationItemUpdated { item },
        );
        Ok(())
    }
}

impl ManagedThread {
    pub(super) fn new(summary: ThreadSummary) -> Self {
        let ai_title_generated = !is_placeholder_thread_title(&summary.title)
            && !is_provisional_thread_title(&summary.title);
        Self {
            summary,
            items: Vec::new(),
            assistant_items: HashMap::new(),
            reasoning_items: HashMap::new(),
            plan_items: HashMap::new(),
            tool_items: HashMap::new(),
            other_items: HashMap::new(),
            manual_title: false,
            ai_title_generated,
            ai_title_in_flight: false,
            ai_title_attempts: 0,
            title_is_provider_preview: false,
            requires_resume: false,
            native_transcript_synced: false,
            opencode_turn_in_flight: false,
            opencode_interrupt_requested: false,
            queued_requests: Vec::new(),
            dispatching_request: None,
            pending_opencode_steer: None,
            claude_post_plan_permission_mode: None,
            transient_retry_attempts: 0,
            transient_retry_generation: 0,
            transient_retry_in_flight: false,
        }
    }

    pub(super) fn with_items(summary: ThreadSummary, items: Vec<ConversationItem>) -> Self {
        let mut thread = Self::new(summary);
        thread.replace_items(items);
        thread.requires_resume = true;
        thread
    }

    fn replace_items(&mut self, items: Vec<ConversationItem>) {
        self.items.clear();
        self.assistant_items.clear();
        self.reasoning_items.clear();
        self.plan_items.clear();
        self.tool_items.clear();
        self.other_items.clear();
        for (index, item) in items.into_iter().enumerate() {
            let id = conversation_item_identity(&item).to_string();
            match &item {
                ConversationItem::AssistantMessage { .. } => {
                    self.assistant_items.insert(id, index);
                }
                ConversationItem::Reasoning { .. } => {
                    self.reasoning_items.insert(id, index);
                }
                ConversationItem::Plan { .. } => {
                    self.plan_items.insert(id, index);
                }
                ConversationItem::ToolCall { .. } | ConversationItem::FileChange { .. } => {
                    self.tool_items.insert(id, index);
                }
                _ => {
                    // First-wins to mirror the position()-based scan this
                    // map replaces.
                    self.other_items.entry(id).or_insert(index);
                }
            }
            self.items.push(item);
        }
    }
}

fn apply_resumed_codex_thread_hydration(
    thread: &mut ManagedThread,
    hydrated: crate::codex::HydratedThread,
) {
    if thread.summary.native_session_id.is_none() {
        thread.summary.native_session_id = hydrated.summary.native_session_id;
    }
    if thread.summary.last_message_preview.is_none() {
        thread.summary.last_message_preview = hydrated.summary.last_message_preview;
    }
    if thread.summary.latest_turn_id.is_none() {
        thread.summary.latest_turn_id = hydrated.summary.latest_turn_id;
    }
    if thread.summary.last_tool.is_none() {
        thread.summary.last_tool = hydrated.summary.last_tool;
    }
    thread.summary.updated_at = thread.summary.updated_at.max(hydrated.summary.updated_at);
    let mut merged_items = merge_resumed_codex_items(&thread.items, hydrated.items);
    if is_shutdown_interrupted(&thread.summary.status, thread.summary.last_error.as_deref()) {
        settle_items_as_shutdown_interrupted(
            &mut merged_items,
            thread
                .summary
                .latest_turn_id
                .as_deref()
                .or(Some(thread.summary.id.as_str())),
            Utc::now(),
            SHUTDOWN_INTERRUPTED_TURN_ERROR,
        );
    }
    thread.replace_items(merged_items);
    thread.requires_resume = false;
}

fn merge_resumed_codex_items(
    current: &[ConversationItem],
    hydrated: Vec<ConversationItem>,
) -> Vec<ConversationItem> {
    let current_has_native_history = current.iter().any(|item| match item {
        ConversationItem::UserMessage { turn_id, .. } => turn_id.is_some(),
        ConversationItem::Service { .. } | ConversationItem::InteractiveRequest { .. } => false,
        _ => true,
    });
    let (mut primary, secondary) = if current_has_native_history {
        (current.to_vec(), hydrated)
    } else {
        (hydrated, current.to_vec())
    };
    let primary_ids = primary
        .iter()
        .map(|item| conversation_item_identity(item).to_string())
        .collect::<HashSet<_>>();
    let primary_user_turns = primary
        .iter()
        .filter_map(user_message_turn_key)
        .collect::<HashSet<_>>();
    primary.extend(secondary.into_iter().filter(|item| {
        !primary_ids.contains(conversation_item_identity(item))
            && user_message_turn_key(item).is_none_or(|key| !primary_user_turns.contains(&key))
    }));
    primary.sort_by_key(crate::codex::conversation_item_created_at);
    primary
}

fn user_message_turn_key(item: &ConversationItem) -> Option<(String, String)> {
    let ConversationItem::UserMessage {
        text,
        turn_id: Some(turn_id),
        ..
    } = item
    else {
        return None;
    };
    Some((turn_id.clone(), text.trim().to_string()))
}

impl ManagedWorkspace {
    pub(super) fn has_runtime(&self) -> bool {
        // A workspace is live if at least one provider runtime is attached;
        // requiring both would treat a Claude-only workspace as a placeholder.
        self.codex_session.is_some() || self.claude_runtime.is_some() || self.agy_runtime.is_some()
    }
}

fn conversation_item_identity(item: &ConversationItem) -> &str {
    match item {
        ConversationItem::UserMessage { id, .. }
        | ConversationItem::AssistantMessage { id, .. }
        | ConversationItem::Reasoning { id, .. }
        | ConversationItem::CodeReview { id, .. }
        | ConversationItem::ContextCompaction { id, .. }
        | ConversationItem::Artifact { id, .. }
        | ConversationItem::Unsupported { id, .. }
        | ConversationItem::Image { id, .. }
        | ConversationItem::WebSearch { id, .. }
        | ConversationItem::FileChange { id, .. }
        | ConversationItem::ToolCall { id, .. }
        | ConversationItem::Plan { id, .. }
        | ConversationItem::Diff { id, .. }
        | ConversationItem::Service { id, .. }
        | ConversationItem::InteractiveRequest { id, .. } => id,
    }
}

pub(super) fn interactive_request_counts(
    requests: &HashMap<(String, String), PendingServerRequest>,
    thread_id: &str,
) -> (u32, u32) {
    requests
        .values()
        .filter(|request| request.request.thread_id.as_deref() == Some(thread_id))
        .fold(
            (0_u32, 0_u32),
            |(approvals, questions), request| match request.request.kind {
                InteractiveRequestKind::Approval => (approvals + 1, questions),
                InteractiveRequestKind::Question => (approvals, questions + 1),
                InteractiveRequestKind::PlanApproval => (approvals + 1, questions),
            },
        )
}

pub(super) fn refresh_thread_attention(
    thread: &mut ThreadSummary,
    pending_approval_count: u32,
    pending_question_count: u32,
) {
    let unread = thread.attention.last_agent_activity_seq > thread.attention.last_read_seq;
    let level = if matches!(thread.status, ThreadStatus::Error) {
        ThreadAttentionLevel::Error
    } else if pending_approval_count + pending_question_count > 0 {
        ThreadAttentionLevel::AwaitingResponse
    } else if matches!(thread.status, ThreadStatus::Running) {
        ThreadAttentionLevel::Running
    } else if unread {
        ThreadAttentionLevel::Unread
    } else {
        ThreadAttentionLevel::None
    };

    thread.attention.level = level;
    thread.attention.badge_label = if pending_approval_count + pending_question_count > 0 {
        Some("Awaiting response".to_string())
    } else {
        None
    };
    thread.attention.unread = unread;
    thread.attention.pending_approval_count = pending_approval_count;
    thread.attention.pending_question_count = pending_question_count;
}

/// Streaming text already replaces the previous item; a ThreadUpdated on each
/// chunk exists only to bump the attention seq, which the terminal summary
/// carries. Emitting it per fragment doubles the remote event rate.
fn is_in_flight_text_item(item: &ConversationItem) -> bool {
    let lifecycle = match item {
        ConversationItem::AssistantMessage { lifecycle, .. }
        | ConversationItem::Reasoning { lifecycle, .. } => *lifecycle,
        _ => return false,
    };
    matches!(
        lifecycle,
        ContentLifecycle::Pending | ContentLifecycle::Streaming
    )
}

struct InFlightAppendDelta {
    text: String,
    target: TextDeltaTarget,
    start_offset: u64,
    end_offset: u64,
}

fn utf16_len(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

/// Prefix-extend a streaming assistant/reasoning item into a `Text` delta.
/// Anything else (rewrite, citations, phase, terminal lifecycle) stays a
/// full `ConversationItemUpdated`.
fn in_flight_append_delta(
    previous: &ConversationItem,
    next: &ConversationItem,
) -> Option<InFlightAppendDelta> {
    if !is_in_flight_text_item(previous) || !is_in_flight_text_item(next) {
        return None;
    }
    match (previous, next) {
        (
            ConversationItem::AssistantMessage {
                id: previous_id,
                text: previous_text,
                phase: previous_phase,
                memory_citation: previous_citation,
                citations: previous_citations,
                error: previous_error,
                ..
            },
            ConversationItem::AssistantMessage {
                id: next_id,
                text: next_text,
                phase: next_phase,
                memory_citation: next_citation,
                citations: next_citations,
                error: next_error,
                ..
            },
        ) if previous_id == next_id
            && previous_phase == next_phase
            && previous_citation == next_citation
            && previous_citations == next_citations
            && previous_error == next_error
            && next_text.starts_with(previous_text.as_str())
            && next_text.len() > previous_text.len() =>
        {
            Some(InFlightAppendDelta {
                text: next_text[previous_text.len()..].to_string(),
                target: TextDeltaTarget::AssistantText,
                start_offset: utf16_len(previous_text),
                end_offset: utf16_len(next_text),
            })
        }
        (
            ConversationItem::Reasoning {
                id: previous_id,
                summary: previous_summary,
                content: previous_content,
                duration_ms: previous_duration,
                ..
            },
            ConversationItem::Reasoning {
                id: next_id,
                summary: next_summary,
                content: next_content,
                duration_ms: next_duration,
                ..
            },
        ) if previous_id == next_id && previous_duration == next_duration => {
            let previous_summary_text = previous_summary.as_deref().unwrap_or("");
            let next_summary_text = next_summary.as_deref().unwrap_or("");
            let summary_grew = next_summary_text.starts_with(previous_summary_text)
                && next_summary_text.len() > previous_summary_text.len();
            let content_grew = next_content.starts_with(previous_content.as_str())
                && next_content.len() > previous_content.len();
            if summary_grew && previous_content == next_content {
                return Some(InFlightAppendDelta {
                    text: next_summary_text[previous_summary_text.len()..].to_string(),
                    target: TextDeltaTarget::ReasoningSummary,
                    start_offset: utf16_len(previous_summary_text),
                    end_offset: utf16_len(next_summary_text),
                });
            }
            if content_grew && previous_summary == next_summary {
                return Some(InFlightAppendDelta {
                    text: next_content[previous_content.len()..].to_string(),
                    target: TextDeltaTarget::ReasoningContent,
                    start_offset: utf16_len(previous_content),
                    end_offset: utf16_len(next_content),
                });
            }
            None
        }
        _ => None,
    }
}

/// Whether an item is fresh agent output for unread purposes. User messages
/// are the user's own words; Service items and turn receipts are daemon
/// commentary about the session (diagnostics, shutdown/interruption markers) —
/// stamping attention for those flips read threads back to unread every time
/// the daemon settles a dying turn, e.g. on every app quit while a turn runs.
/// Genuine failures already demand attention through the error status.
fn marks_agent_activity(item: &ConversationItem) -> bool {
    match item {
        ConversationItem::UserMessage { .. } | ConversationItem::Service { .. } => false,
        ConversationItem::AssistantMessage { id, .. } => !id.starts_with(TURN_RECEIPT_ID_PREFIX),
        _ => true,
    }
}

/// Recognizes the stream-json event that closes a Claude turn, reporting
/// whether it failed. A steering message folds into the turn it interrupts, so
/// one turn still ends with exactly one of these.
fn claude_result_is_error(value: &Value) -> Option<bool> {
    if value.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    Some(
        value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

#[derive(Debug, PartialEq, Eq)]
struct ClaudeTaskFinished {
    task_id: String,
    tool_use_id: Option<String>,
    status: String,
    summary: Option<String>,
}

/// Whether an outstanding background task should hold the turn open past the
/// CLI's terminal `result`.
///
/// Only async *agents* should: they keep working after the parent yields, and
/// closing stdin would kill them mid-flight. A backgrounded shell command
/// (`local_bash` — a dev server, a file watcher, `tail -f`) is the opposite
/// case: it is meant to outlive the turn and reports nothing until something
/// stops it, so counting it here pins the thread "running" forever and leaves
/// the composer stuck behind a stop button.
fn claude_task_holds_turn_open(task_type: Option<&str>) -> bool {
    // Match on "agent" rather than excluding known shell types: an unknown
    // task type that never completes is what wedges a turn, so anything not
    // recognisably an agent is treated as fire-and-forget.
    task_type.is_some_and(|task_type| task_type.contains("agent"))
}

/// The CLI's authoritative task list, split by what it means for the turn.
struct ClaudeBackgroundTasks {
    /// Tasks that must keep the turn open — async agents only.
    blocking: HashSet<String>,
    /// Every task still listed, including backgrounded shell commands. They
    /// do not hold the turn, but they do wake it when they report.
    all: HashSet<String>,
}

fn claude_background_tasks(value: &Value) -> Option<ClaudeBackgroundTasks> {
    if value.get("type").and_then(Value::as_str) != Some("system")
        || value.get("subtype").and_then(Value::as_str) != Some("background_tasks_changed")
    {
        return None;
    }
    let mut tasks = ClaudeBackgroundTasks {
        blocking: HashSet::new(),
        all: HashSet::new(),
    };
    for task in value
        .get("tasks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(task_id) = task.get("task_id").and_then(Value::as_str) else {
            continue;
        };
        if claude_task_holds_turn_open(task.get("task_type").and_then(Value::as_str)) {
            tasks.blocking.insert(task_id.to_string());
        }
        tasks.all.insert(task_id.to_string());
    }
    Some(tasks)
}

struct ClaudeTaskStarted {
    task_id: String,
    tool_use_id: String,
    holds_turn_open: bool,
}

fn claude_task_started(value: &Value) -> Option<ClaudeTaskStarted> {
    if value.get("type").and_then(Value::as_str) != Some("system")
        || value.get("subtype").and_then(Value::as_str) != Some("task_started")
    {
        return None;
    }
    let task_id = value.get("task_id")?.as_str()?.to_string();
    let tool_use_id = value.get("tool_use_id")?.as_str()?.to_string();
    let holds_turn_open =
        claude_task_holds_turn_open(value.get("task_type").and_then(Value::as_str));
    Some(ClaudeTaskStarted {
        task_id,
        tool_use_id,
        holds_turn_open,
    })
}

fn claude_task_finished(value: &Value) -> Option<ClaudeTaskFinished> {
    if value.get("type").and_then(Value::as_str) != Some("system")
        || value.get("subtype").and_then(Value::as_str) != Some("task_notification")
    {
        return None;
    }
    let provider_status = value.get("status")?.as_str()?;
    let status = match provider_status {
        "completed" => "completed",
        "failed" => "failed",
        "killed" | "stopped" | "interrupted" => "interrupted",
        _ => provider_status,
    };
    Some(ClaudeTaskFinished {
        task_id: value.get("task_id")?.as_str()?.to_string(),
        tool_use_id: value
            .get("tool_use_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: status.to_string(),
        summary: value
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Session id the CLI reports in its `system:init` event — authoritative over
/// whatever id the daemon passed on the command line.
fn claude_init_session_id(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("system")
        || value.get("subtype").and_then(Value::as_str) != Some("init")
    {
        return None;
    }
    value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn claude_context_compaction_item(value: &Value) -> Option<ConversationItem> {
    if value.get("type").and_then(Value::as_str) != Some("system")
        || value.get("subtype").and_then(Value::as_str) != Some("compact_boundary")
    {
        return None;
    }
    let now = Utc::now();
    Some(ConversationItem::ContextCompaction {
        id: format!("claude-compaction-{}", Uuid::new_v4().simple()),
        lifecycle: ToolLifecycle::Succeeded,
        created_at: now,
        completed_at: Some(now),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn isolated_codex_thread() -> ManagedThread {
        ManagedThread::new(ThreadSummary {
            id: "thread-isolated".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Persisted title".to_string(),
            provider: AgentProvider::CODEX,
            native_session_id: Some("thread-isolated".to_string()),
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
            variant: Some(falcondeck_core::ThreadVariant {
                slug: "copy-1".to_string(),
                path: "/tmp/project-copy".to_string(),
                branch: "falcondeck/copy-1".to_string(),
                kind: falcondeck_core::ThreadVariantKind::Clone,
                base_branch: Some("main".to_string()),
            }),
        })
    }

    #[tokio::test]
    async fn provider_session_confirmation_never_replaces_an_existing_join_key() {
        let temp_dir = tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            temp_dir.path().join("daemon-state.json"),
        );
        let mut thread = isolated_codex_thread();
        thread.summary.id = "thread-1".to_string();
        thread.summary.provider = AgentProvider::CLAUDE;
        thread.summary.native_session_id = Some("session-original".to_string());
        let workspace = falcondeck_core::WorkspaceSummary {
            kind: falcondeck_core::WorkspaceKind::Project,
            id: "workspace-1".to_string(),
            path: temp_dir.path().to_string_lossy().to_string(),
            status: falcondeck_core::WorkspaceStatus::Ready,
            agents: Vec::new(),
            skills: Vec::new(),
            default_provider: AgentProvider::CLAUDE,
            models: Vec::new(),
            collaboration_modes: Vec::new(),
            account: falcondeck_core::AccountSummary::default(),
            current_thread_id: Some("thread-1".to_string()),
            connected_at: Utc::now(),
            updated_at: Utc::now(),
            last_error: None,
        };
        app.inner.workspaces.lock().await.insert(
            "workspace-1".to_string(),
            ManagedWorkspace {
                summary: workspace,
                codex_session: None,
                claude_runtime: None,
                agy_runtime: None,
                opencode_runtime: None,
                acp_runtimes: HashMap::new(),
                threads: HashMap::from([("thread-1".to_string(), thread)]),
            },
        );

        app.confirm_provider_native_session(
            "workspace-1",
            "thread-1",
            "Claude",
            "session-original",
        )
        .await
        .unwrap();
        let error = app
            .confirm_provider_native_session(
                "workspace-1",
                "thread-1",
                "Claude",
                "session-replacement",
            )
            .await
            .expect_err("a provider must not relink an established thread");

        assert!(error.to_string().contains("kept the original session link"));
        assert_eq!(
            app.thread_summary("workspace-1", "thread-1")
                .await
                .unwrap()
                .native_session_id
                .as_deref(),
            Some("session-original")
        );
    }

    #[test]
    fn resumed_isolated_codex_thread_rehydrates_its_conversation() {
        let mut thread = isolated_codex_thread();
        thread.requires_resume = true;
        thread.replace_items(vec![ConversationItem::UserMessage {
            id: "pending-user".to_string(),
            text: "Sent while resuming".to_string(),
            attachments: Vec::new(),
            turn_id: None,
            previous_turn_id: None,
            created_at: Utc::now(),
        }]);
        let hydrated = crate::codex::hydrate_thread_response(
            thread.summary.clone(),
            &json!({
                "thread": {
                    "id": "thread-isolated",
                    "turns": [{
                        "id": "turn-1",
                        "status": "completed",
                        "items": [
                            {
                                "id": "user-1",
                                "type": "userMessage",
                                "createdAt": "2026-08-14T15:00:00Z",
                                "content": [{"type": "text", "text": "Keep my history"}]
                            },
                            {
                                "id": "assistant-1",
                                "type": "agentMessage",
                                "createdAt": "2026-08-14T15:00:01Z",
                                "text": "History restored"
                            }
                        ]
                    }]
                }
            }),
            "/tmp/project-copy",
        );
        thread.summary.title = "Renamed while hydrating".to_string();
        thread.summary.attention.last_read_seq = 42;
        thread.summary.is_pinned = true;
        apply_resumed_codex_thread_hydration(&mut thread, hydrated);

        assert!(!thread.requires_resume);
        assert_eq!(thread.summary.title, "Renamed while hydrating");
        assert_eq!(thread.summary.attention.last_read_seq, 42);
        assert!(thread.summary.is_pinned);
        assert_eq!(
            thread
                .summary
                .variant
                .as_ref()
                .map(|variant| variant.path.as_str()),
            Some("/tmp/project-copy")
        );
        assert_eq!(thread.items.len(), 3);
        assert!(matches!(
            &thread.items[0],
            ConversationItem::UserMessage { text, .. } if text == "Keep my history"
        ));
        assert!(matches!(
            &thread.items[1],
            ConversationItem::AssistantMessage { text, .. } if text == "History restored"
        ));
        assert!(matches!(
            &thread.items[2],
            ConversationItem::UserMessage { text, .. } if text == "Sent while resuming"
        ));
    }

    #[test]
    fn resumed_codex_thread_keeps_daemon_error_when_native_turn_is_still_in_progress() {
        let mut thread = isolated_codex_thread();
        thread.summary.status = ThreadStatus::Error;
        thread.summary.last_error = Some("Codex app-server disconnected".to_string());
        let hydrated = crate::codex::hydrate_thread_response(
            thread.summary.clone(),
            &json!({
                "thread": {
                    "id": "thread-isolated",
                    "turns": [{
                        "id": "turn-1",
                        "status": "inProgress",
                        "items": []
                    }]
                }
            }),
            "/tmp/project-copy",
        );

        apply_resumed_codex_thread_hydration(&mut thread, hydrated);

        assert_eq!(thread.summary.status, ThreadStatus::Error);
        assert_eq!(
            thread.summary.last_error.as_deref(),
            Some("Codex app-server disconnected")
        );
    }

    #[test]
    fn resumed_codex_thread_deduplicates_local_and_provider_user_message_ids() {
        let mut thread = isolated_codex_thread();
        let hydrated = crate::codex::hydrate_thread_response(
            thread.summary.clone(),
            &json!({
                "thread": {
                    "id": "thread-isolated",
                    "turns": [{
                        "id": "turn-1",
                        "status": "completed",
                        "items": [
                            {
                                "id": "provider-user",
                                "type": "userMessage",
                                "createdAt": "2026-08-14T15:00:00Z",
                                "content": [{"type": "text", "text": "Same message"}]
                            },
                            {
                                "id": "provider-assistant",
                                "type": "agentMessage",
                                "createdAt": "2026-08-14T15:00:01Z",
                                "text": "Done"
                            }
                        ]
                    }]
                }
            }),
            "/tmp/project-copy",
        );
        let mut current = hydrated.items.clone();
        if let ConversationItem::UserMessage { id, text, .. } = &mut current[0] {
            *id = "local-user".to_string();
            text.push(' ');
        }
        thread.replace_items(current);

        apply_resumed_codex_thread_hydration(&mut thread, hydrated);

        assert_eq!(thread.items.len(), 2);
        assert!(matches!(
            &thread.items[0],
            ConversationItem::UserMessage { id, .. } if id == "local-user"
        ));
    }

    #[test]
    fn resumed_codex_thread_orders_provider_only_history_by_creation_time() {
        let now = Utc::now();
        let current = vec![ConversationItem::AssistantMessage {
            id: "current".to_string(),
            text: "Current".to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: ContentLifecycle::Complete,
            error: None,
            created_at: now,
        }];
        let hydrated = vec![ConversationItem::AssistantMessage {
            id: "older-provider-item".to_string(),
            text: "Older".to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: ContentLifecycle::Complete,
            error: None,
            created_at: now - chrono::Duration::minutes(1),
        }];

        let merged = merge_resumed_codex_items(&current, hydrated);

        assert!(matches!(
            &merged[0],
            ConversationItem::AssistantMessage { id, .. } if id == "older-provider-item"
        ));
    }

    #[test]
    fn init_event_yields_the_cli_reported_session_id() {
        assert_eq!(
            claude_init_session_id(&json!({
                "type": "system",
                "subtype": "init",
                "session_id": "abc-123"
            }))
            .as_deref(),
            Some("abc-123")
        );
        for value in [
            json!({ "type": "system", "subtype": "init" }),
            json!({ "type": "system", "subtype": "compact", "session_id": "abc" }),
            json!({ "type": "result", "session_id": "abc" }),
        ] {
            assert_eq!(claude_init_session_id(&value), None, "{value}");
        }
    }

    #[test]
    fn compact_boundary_becomes_a_succeeded_compaction_item() {
        let item = claude_context_compaction_item(&json!({
            "type": "system",
            "subtype": "compact_boundary",
            "compact_metadata": {
                "trigger": "manual",
                "pre_tokens": 42_000
            }
        }))
        .expect("compact boundary should project");

        assert!(matches!(
            item,
            ConversationItem::ContextCompaction {
                lifecycle: ToolLifecycle::Succeeded,
                completed_at: Some(_),
                ..
            }
        ));
        assert!(
            claude_context_compaction_item(&json!({
                "type": "system",
                "subtype": "init"
            }))
            .is_none()
        );
    }

    #[test]
    fn recognizes_the_terminal_result_event() {
        assert_eq!(
            claude_result_is_error(&json!({ "type": "result", "subtype": "success" })),
            Some(false)
        );
        assert_eq!(
            claude_result_is_error(&json!({ "type": "result", "is_error": true })),
            Some(true)
        );
    }

    #[test]
    fn other_stream_events_are_not_turn_boundaries() {
        for value in [
            json!({ "type": "assistant", "message": { "content": [] } }),
            json!({ "type": "system", "subtype": "init" }),
            json!({ "type": "user" }),
            // A nested result field must not be mistaken for the event.
            json!({ "type": "system", "result": "success" }),
            // Stream-event message_stop is not a turn boundary; multiple
            // arrive per turn and would desynchronize completion.
            json!({ "type": "stream_event", "event": { "type": "message_stop" } }),
            json!({ "type": "stream_event", "event": { "type": "message_delta", "delta": { "stop_reason": "end_turn" } } }),
        ] {
            assert_eq!(claude_result_is_error(&value), None, "{value}");
        }
    }

    #[test]
    fn background_task_changes_are_authoritative() {
        let tasks = claude_background_tasks(&json!({
            "type": "system",
            "subtype": "background_tasks_changed",
            "tasks": [
                { "task_id": "agent-1", "task_type": "local_agent" },
                { "task_id": "agent-2", "task_type": "local_agent" }
            ]
        }))
        .unwrap();

        assert_eq!(
            tasks.blocking,
            HashSet::from(["agent-1".to_string(), "agent-2".to_string()])
        );
        assert_eq!(
            tasks.all,
            HashSet::from(["agent-1".to_string(), "agent-2".to_string()])
        );
    }

    /// A `run_in_background` shell command (dev server, watcher) reports
    /// nothing until something stops it. Counting it as a reason to keep the
    /// turn open left the thread pinned "running" long after the CLI had
    /// finished, behind a stop button and a bogus "no output" warning.
    #[test]
    fn backgrounded_shell_tasks_do_not_hold_the_turn_open() {
        let tasks = claude_background_tasks(&json!({
            "type": "system",
            "subtype": "background_tasks_changed",
            "tasks": [
                { "task_id": "bash-1", "task_type": "local_bash", "description": "pnpm dev" },
                { "task_id": "agent-1", "task_type": "local_agent" }
            ]
        }))
        .unwrap();

        assert_eq!(tasks.blocking, HashSet::from(["agent-1".to_string()]));
        // It still counts as outstanding work: the thread parks, but the
        // command is live and its notification will start the next turn.
        assert_eq!(
            tasks.all,
            HashSet::from(["bash-1".to_string(), "agent-1".to_string()])
        );
    }

    #[test]
    fn task_started_marks_only_agents_as_blocking() {
        let shell = claude_task_started(&json!({
            "type": "system",
            "subtype": "task_started",
            "task_id": "bash-1",
            "tool_use_id": "toolu_bash",
            "task_type": "local_bash"
        }))
        .unwrap();
        assert_eq!(shell.task_id, "bash-1");
        // Still mapped to its tool call so the card settles on completion.
        assert_eq!(shell.tool_use_id, "toolu_bash");
        assert!(!shell.holds_turn_open);

        let agent = claude_task_started(&json!({
            "type": "system",
            "subtype": "task_started",
            "task_id": "agent-1",
            "tool_use_id": "toolu_agent",
            "task_type": "local_agent"
        }))
        .unwrap();
        assert!(agent.holds_turn_open);

        // An unknown/absent type is treated as fire-and-forget: a task that
        // never reports must not be able to wedge the turn.
        let unknown = claude_task_started(&json!({
            "type": "system",
            "subtype": "task_started",
            "task_id": "mystery-1",
            "tool_use_id": "toolu_mystery"
        }))
        .unwrap();
        assert!(!unknown.holds_turn_open);
    }

    #[test]
    fn task_notification_settles_the_spawning_tool() {
        let task = claude_task_finished(&json!({
            "type": "system",
            "subtype": "task_notification",
            "task_id": "agent-1",
            "tool_use_id": "toolu_agent",
            "status": "completed",
            "summary": "Inspection finished"
        }))
        .unwrap();

        assert_eq!(
            task,
            ClaudeTaskFinished {
                task_id: "agent-1".to_string(),
                tool_use_id: Some("toolu_agent".to_string()),
                status: "completed".to_string(),
                summary: Some("Inspection finished".to_string()),
            }
        );
    }

    /// A task_notification's bare `status` ("stopped", "killed", "interrupted")
    /// must not slip through `extract_claude_service_message` and surface as a
    /// bogus "stopped" diagnostic. The monitor handles the event in
    /// `claude_task_finished` and must `continue` so the rest of the chain
    /// never sees the line.
    #[test]
    fn task_notification_status_is_not_a_service_message() {
        for raw_status in ["stopped", "killed", "interrupted"] {
            let event = json!({
                "type": "system",
                "subtype": "task_notification",
                "task_id": "agent-1",
                "tool_use_id": "toolu_agent",
                "status": raw_status,
                "summary": "The user cancelled this task"
            });
            assert_eq!(
                extract_claude_service_message(&event),
                None,
                "task_notification status '{raw_status}' must not become a service message"
            );
        }
    }
}
