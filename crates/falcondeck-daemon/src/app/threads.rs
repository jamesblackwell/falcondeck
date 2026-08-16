use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, atomic::Ordering},
};

use chrono::Utc;
use falcondeck_core::{
    AgentProvider, ApprovalDecision, ContentLifecycle, ConversationItem, InteractiveRequestKind,
    InteractiveRequestOutcome, InteractiveRequestResolution, ServiceLevel, ThreadAgentParams,
    ThreadAttention, ThreadAttentionLevel, ThreadStatus, ThreadSummary, UnifiedEvent,
    merge_conversation_citations,
};
use serde_json::Value;
use tokio::{
    io::AsyncBufReadExt,
    time::{Duration, timeout},
};
use uuid::Uuid;

use super::{
    AppState, ManagedThread, ManagedWorkspace, PendingServerRequest,
    agent_helpers::{
        SUBAGENT_ACTIVITY_KEPT_STEPS, append_claude_text_delta, claude_parent_tool_use_id,
        claude_stream_message_id, claude_tool_result_image_items, extract_claude_error,
        extract_claude_service_message, extract_claude_text_chunk, extract_claude_thinking_chunk,
        extract_claude_tool_event, format_subagent_activity, is_claude_message_start,
        is_claude_text_block_start, merge_claude_assistant_text,
    },
    conversation_helpers::{
        ToolSettlement, build_ai_thread_title_prompt, is_placeholder_thread_title,
        is_provisional_thread_title, normalize_generated_thread_title, sanitize_conversation_item,
        settle_content_items, settle_tool_call_items, should_generate_ai_thread_title,
        terminal_assistant_receipt_with_error, tool_display_metadata,
        with_renderable_attachment_previews,
    },
};
use crate::{claude::ClaudeRuntime, codex::CodexSession, error::DaemonError};

/// How long a running Claude turn may stay silent — no stream traffic at all,
/// not even thinking heartbeats — before the thread gets a visible warning.
/// Long tool runs (builds, test suites) are legitimately silent, so this warns
/// rather than intervenes, and names the tool when one is mid-flight.
const CLAUDE_STALL_WARN_AFTER: Duration = Duration::from_secs(300);
const CLAUDE_STALL_CHECK_INTERVAL: Duration = Duration::from_secs(60);
/// Stderr lines kept for the failure message when the CLI dies without a
/// `result` event. `bounded_turn_error` clamps the final string anyway.
const CLAUDE_STDERR_TAIL_LINES: usize = 6;

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
                let _ = sender.send(ApprovalDecision::Deny);
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
    ) -> Result<Arc<CodexSession>, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.codex_session.as_ref())
            .map(Arc::clone)
            .ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "workspace {workspace_id} is not currently connected to Codex"
                ))
            })
    }

    /// Materialize a restored Codex thread before using thread-scoped RPCs.
    /// Goal reads and writes have the same requirement as starting a turn.
    pub(super) async fn resume_codex_thread_if_needed(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Arc<CodexSession>, DaemonError> {
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
            }
        }
        Ok(session)
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
                    goal: None,
                    queued_turns: Vec::new(),
                    variant: None,
                })
            });
        let before = thread.summary.updated_at;
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
        Ok(thread.summary.clone())
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
            if !should_generate_ai_thread_title(thread) {
                return;
            }
            thread.ai_title_in_flight = true;
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
                            thread.summary.updated_at = Utc::now();
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

    /// Titles run on the same cheap utility chain as handoff briefs, so a
    /// user with only Codex, `OpenCode`, or Grok installed still gets one.
    async fn generate_ai_thread_title(
        &self,
        workspace_id: &str,
        input: &AiThreadTitleInput,
    ) -> Option<String> {
        let candidates = self.utility_model_candidates(workspace_id).await;
        let run = self
            .run_utility_prompt(
                &candidates,
                &input.workspace_path,
                &input.prompt,
                Duration::from_secs(25),
            )
            .await?;
        normalize_generated_thread_title(&run.text)
    }

    pub(super) async fn monitor_claude_turn(
        &self,
        workspace_id: String,
        thread_id: String,
        turn_generation: u64,
        stdout: Option<tokio::process::ChildStdout>,
        stderr: Option<tokio::process::ChildStderr>,
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
        let mut background_task_tools = HashMap::<String, String>::new();
        let mut running_tool_titles = HashMap::<String, String>::new();
        let mut last_line_at = tokio::time::Instant::now();
        let mut stall_warned = false;
        let mut turn_error: Option<String> = None;
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
        if let Some(stdout) = stdout {
            let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        // A dropped receiver means the monitor is done with
                        // events; keep reading so a late write cannot fill the
                        // buffer or SIGPIPE the CLI mid-shutdown.
                        Ok(Some(line)) => {
                            let _ = line_tx.send(line);
                        }
                        Ok(None) => break,
                        // A read error (e.g. invalid UTF-8) must not stop the
                        // drain: the pipe still needs emptying or the CLI
                        // wedges, and later lines may parse fine.
                        Err(error) => {
                            tracing::warn!("failed to read claude stdout line: {error}");
                        }
                    }
                }
            });
            loop {
                let line = match timeout(CLAUDE_STALL_CHECK_INTERVAL, line_rx.recv()).await {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(_) => {
                        // Total stream silence — not even thinking heartbeats.
                        // Either a tool is legitimately long-running or the CLI
                        // wedged; a thread that just sits there is what reads
                        // as "stopped working", so say which it is, once per
                        // silent stretch. An approval wait is expected silence
                        // and already renders its own pinned notice.
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
                                    "No output from Claude for {minutes}m. Stop the turn if this looks stuck."
                                ),
                            };
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
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(value) => {
                        if let Some(tasks) = claude_background_tasks(&value) {
                            background_tasks = tasks;
                        }
                        if let Some((task_id, tool_use_id)) = claude_task_started(&value) {
                            background_tasks.insert(task_id.clone());
                            background_task_tools.insert(task_id, tool_use_id);
                        }
                        if let Some(task) = claude_task_finished(&value) {
                            background_tasks.remove(&task.task_id);
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
                                    .push_conversation_item(&workspace_id, &thread_id, item, true)
                                    .await;
                            }
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
                                let entry = subagent_steps.entry(parent_id.clone()).or_default();
                                entry.0.push(step);
                                if entry.0.len() > SUBAGENT_ACTIVITY_KEPT_STEPS {
                                    entry.0.remove(0);
                                    entry.1 += 1;
                                }
                                let output = format_subagent_activity(&entry.0, entry.1);
                                saw_agent_output = true;
                                let (title, tool_kind) =
                                    tool_identity.get(&parent_id).cloned().unwrap_or_else(|| {
                                        ("Sub-agent".to_string(), "Task".to_string())
                                    });
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
                                    .push_conversation_item(&workspace_id, &thread_id, item, true)
                                    .await;
                            }
                            continue;
                        }
                        // The CLI is authoritative about which session it is
                        // writing to. A mismatch with the daemon's assumed id
                        // would make PreToolUse hook lookups (keyed by session
                        // id) silently miss this thread.
                        if let Some(init_session_id) = claude_init_session_id(&value) {
                            let mut assumed: Option<Option<String>> = None;
                            let _ = self
                                .with_thread_mut(&workspace_id, &thread_id, |thread| {
                                    if thread.native_session_id.as_deref()
                                        != Some(init_session_id.as_str())
                                    {
                                        assumed = Some(thread.native_session_id.clone());
                                        thread.native_session_id = Some(init_session_id.clone());
                                    }
                                })
                                .await;
                            if let Some(assumed) = assumed {
                                tracing::warn!(
                                    "claude session id mismatch: daemon assumed {assumed:?}, CLI reported {init_session_id}"
                                );
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
                            assistant_id = format!("claude-assistant-{}", Uuid::new_v4().simple());
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
                                .or_else(|| known_identity.as_ref().map(|(title, _)| title.clone()))
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
                                running_tool_titles.insert(tool_event.id.clone(), title.clone());
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
                            for item in
                                claude_tool_result_image_items(&tool_id, &title, &tool_event.images)
                            {
                                let _ = self
                                    .push_conversation_item(&workspace_id, &thread_id, item, true)
                                    .await;
                            }
                        } else if let Some(message) = extract_claude_service_message(&value) {
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
                        if let Some(error) = extract_claude_error(&value) {
                            turn_error = Some(error);
                        }
                        if let Some(is_error) = claude_result_is_error(&value) {
                            saw_result = true;
                            result_reported_success = !is_error;
                            // Claude emits an interim result when the parent
                            // yields while async agents keep working. Closing
                            // stdin at that point kills those agents. Their
                            // terminal notification triggers another parent
                            // response/result, which is the real boundary.
                            if is_error || background_tasks.is_empty() {
                                break;
                            }
                        }
                    }
                    Err(error) => tracing::debug!(
                        %workspace_id,
                        %thread_id,
                        %error,
                        "ignored unparseable Claude stream line"
                    ),
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
                Ok(finish) if finish.interrupted => {
                    // A user-requested stop is a clean outcome, not an error —
                    // the CLI exits non-zero after SIGTERM/SIGKILL.
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
        {
            turn_error =
                Some("Claude turn completed without emitting any assistant output".to_string());
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

    pub(super) async fn push_conversation_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        mut item: ConversationItem,
        update_existing: bool,
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
            _ => thread
                .items
                .iter()
                .position(|entry| conversation_item_identity(entry) == id),
        };

        if update_existing && let Some(index) = existing_index {
            thread.items[index] = item.clone();
            let track_attention = marks_agent_activity(&item);
            if track_attention {
                thread.summary.attention.last_agent_activity_seq = thread
                    .summary
                    .attention
                    .last_agent_activity_seq
                    .max(self.inner.sequence.load(Ordering::Relaxed));
            }
            drop(workspaces);
            let emitted_item = with_renderable_attachment_previews(item).await;
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ConversationItemUpdated { item: emitted_item },
            );
            if track_attention {
                let thread = self.thread_summary(workspace_id, thread_id).await?;
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                // Deferred: this path runs per streamed chunk, and a full
                // persist per chunk backs the agent's stdout pipe up until the
                // CLI wedges mid-turn.
                self.schedule_persist();
            }
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
            _ => {}
        }
        thread.items.push(item.clone());
        let track_attention = marks_agent_activity(&item);
        if track_attention {
            thread.summary.attention.last_agent_activity_seq = thread
                .summary
                .attention
                .last_agent_activity_seq
                .max(self.inner.sequence.load(Ordering::Relaxed));
        }
        drop(workspaces);
        let emitted_item = with_renderable_attachment_previews(item).await;
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ConversationItemAdded { item: emitted_item },
        );
        if track_attention {
            let thread = self.thread_summary(workspace_id, thread_id).await?;
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ThreadUpdated { thread },
            );
            // Deferred for the same reason as the update path above.
            self.schedule_persist();
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
        let Some(index) = thread.items.iter().position(|item| match item {
            ConversationItem::InteractiveRequest { id, .. } => id == request_id,
            _ => false,
        }) else {
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
            manual_title: false,
            ai_title_generated,
            ai_title_in_flight: false,
            title_is_provider_preview: false,
            requires_resume: false,
            queued_requests: Vec::new(),
            dispatching_request: None,
            pending_opencode_steer: None,
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
                _ => {}
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
    let merged_items = merge_resumed_codex_items(&thread.items, hydrated.items);
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
    Some((turn_id.clone(), text.clone()))
}

impl ManagedWorkspace {
    pub(super) fn has_runtime(&self) -> bool {
        // A workspace is live if at least one provider runtime is attached;
        // requiring both would treat a Claude-only workspace as a placeholder.
        self.codex_session.is_some() || self.claude_runtime.is_some()
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

fn marks_agent_activity(item: &ConversationItem) -> bool {
    !matches!(item, ConversationItem::UserMessage { .. })
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

fn claude_background_tasks(value: &Value) -> Option<HashSet<String>> {
    if value.get("type").and_then(Value::as_str) != Some("system")
        || value.get("subtype").and_then(Value::as_str) != Some("background_tasks_changed")
    {
        return None;
    }
    Some(
        value
            .get("tasks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|task| task.get("task_id").and_then(Value::as_str))
            .map(str::to_string)
            .collect(),
    )
}

fn claude_task_started(value: &Value) -> Option<(String, String)> {
    if value.get("type").and_then(Value::as_str) != Some("system")
        || value.get("subtype").and_then(Value::as_str) != Some("task_started")
    {
        return None;
    }
    let task_id = value.get("task_id")?.as_str()?.to_string();
    let tool_use_id = value.get("tool_use_id")?.as_str()?.to_string();
    Some((task_id, tool_use_id))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
            goal: None,
            queued_turns: Vec::new(),
            variant: Some(falcondeck_core::ThreadVariant {
                slug: "copy-1".to_string(),
                path: "/tmp/project-copy".to_string(),
                branch: "falcondeck/copy-1".to_string(),
                kind: falcondeck_core::ThreadVariantKind::Clone,
            }),
        })
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
        if let ConversationItem::UserMessage { id, .. } = &mut current[0] {
            *id = "local-user".to_string();
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
            tasks,
            HashSet::from(["agent-1".to_string(), "agent-2".to_string()])
        );
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
}
