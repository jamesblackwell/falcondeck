use std::{
    collections::HashMap,
    process::Stdio,
    sync::{atomic::Ordering, Arc},
};

use chrono::Utc;
use falcondeck_core::{
    AgentProvider, ConversationItem, InteractiveRequestKind, ServiceLevel, ThreadAgentParams,
    ThreadAttention, ThreadAttentionLevel, ThreadStatus, ThreadSummary, UnifiedEvent,
};
use serde_json::Value;
use tokio::{
    fs,
    io::AsyncBufReadExt,
    process::Command,
    time::{timeout, Duration},
};
use uuid::Uuid;

use super::{
    agent_helpers::{
        extract_claude_error, extract_claude_service_message, extract_claude_text_delta,
        extract_claude_tool_event, merge_claude_assistant_text,
    },
    conversation_helpers::{
        build_ai_thread_title_prompt, is_placeholder_thread_title, is_provisional_thread_title,
        normalize_generated_thread_title, should_generate_ai_thread_title, tool_display_metadata,
    },
    AppState, ManagedThread, ManagedWorkspace, PendingServerRequest,
};
use crate::{
    agent_binary::resolve_agent_binary, claude::ClaudeRuntime, codex::CodexSession,
    error::DaemonError,
};

struct AiThreadTitleInput {
    workspace_path: String,
    prompt: String,
    prefer_claude: bool,
}

impl AppState {
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
                    provider: AgentProvider::Codex,
                    native_session_id: None,
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
                })
            });
        let before = thread.summary.updated_at;
        updater(&mut thread.summary);
        if thread.summary.updated_at == before {
            thread.summary.updated_at = now;
        }
        workspace.summary.current_thread_id = Some(thread.summary.id.clone());
        if thread.summary.updated_at > workspace.summary.updated_at {
            workspace.summary.updated_at = thread.summary.updated_at;
        }
        Ok(thread.summary.clone())
    }

    pub(super) async fn with_thread_mut<F>(
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
        workspace.summary.current_thread_id = Some(thread.summary.id.clone());
        if updated_at > workspace.summary.updated_at {
            workspace.summary.updated_at = updated_at;
        }
        Ok(())
    }

    pub(super) async fn thread_summary(
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
                workspace_path: workspace.summary.path.clone(),
                prompt: build_ai_thread_title_prompt(&thread.items),
                prefer_claude: workspace.summary.agents.iter().any(|agent| {
                    agent.provider == AgentProvider::Claude
                        && matches!(agent.account.status, falcondeck_core::AccountStatus::Ready)
                }),
            }
        };

        let app = self.clone();
        tokio::spawn(async move {
            let generated = app.generate_ai_thread_title(&title_input).await;
            match generated {
                Some(title) => {
                    let _ = app
                        .with_managed_thread_mut(&workspace_id, &thread_id, |thread| {
                            if thread.manual_title
                                || thread.ai_title_generated
                                || (!is_placeholder_thread_title(&thread.summary.title)
                                    && !is_provisional_thread_title(&thread.summary.title))
                            {
                                thread.ai_title_in_flight = false;
                                return;
                            }
                            thread.summary.title = title.clone();
                            thread.summary.updated_at = Utc::now();
                            thread.ai_title_generated = true;
                            thread.ai_title_in_flight = false;
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

    async fn generate_ai_thread_title(&self, input: &AiThreadTitleInput) -> Option<String> {
        if input.prefer_claude {
            if let Some(title) = self.generate_ai_thread_title_with_claude(input).await {
                return Some(title);
            }
        }
        self.generate_ai_thread_title_with_codex(input).await
    }

    async fn generate_ai_thread_title_with_claude(
        &self,
        input: &AiThreadTitleInput,
    ) -> Option<String> {
        let resolved = resolve_agent_binary("claude", &self.inner.claude_bin);
        let output = timeout(
            Duration::from_secs(20),
            Command::new(&resolved.executable)
                .arg("-p")
                .arg(&input.prompt)
                .arg("--model")
                .arg("haiku")
                .arg("--output-format")
                .arg("text")
                .arg("--tools")
                .arg("")
                .arg("--no-session-persistence")
                .current_dir(&input.workspace_path)
                .stdin(Stdio::null())
                .output(),
        )
        .await
        .ok()?
        .ok()?;

        if !output.status.success() {
            return None;
        }

        normalize_generated_thread_title(String::from_utf8_lossy(&output.stdout).as_ref())
    }

    async fn generate_ai_thread_title_with_codex(
        &self,
        input: &AiThreadTitleInput,
    ) -> Option<String> {
        let resolved = resolve_agent_binary("codex", &self.inner.codex_bin);
        let output_path = std::env::temp_dir().join(format!(
            "falcondeck-thread-title-{}.txt",
            Uuid::new_v4().simple()
        ));
        let output = timeout(
            Duration::from_secs(25),
            Command::new(&resolved.executable)
                .arg("exec")
                .arg("--skip-git-repo-check")
                .arg("--ephemeral")
                .arg("--color")
                .arg("never")
                .arg("-s")
                .arg("read-only")
                .arg("-o")
                .arg(&output_path)
                .arg(&input.prompt)
                .current_dir(&input.workspace_path)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output(),
        )
        .await
        .ok()?
        .ok()?;

        if !output.status.success() {
            let _ = fs::remove_file(&output_path).await;
            return None;
        }

        let generated = fs::read_to_string(&output_path).await.ok();
        let _ = fs::remove_file(&output_path).await;
        normalize_generated_thread_title(generated.as_deref().unwrap_or_default())
    }

    pub(super) async fn monitor_claude_turn(
        &self,
        workspace_id: String,
        thread_id: String,
        _session_id: String,
        stdout: Option<tokio::process::ChildStdout>,
        stderr: Option<tokio::process::ChildStderr>,
    ) {
        let assistant_id = format!("claude-assistant-{}", Uuid::new_v4().simple());
        let mut assistant_text = String::new();
        let mut turn_error: Option<String> = None;
        let mut saw_agent_output = false;
        let stderr_task = stderr.map(|stderr| {
            let app = self.clone();
            let workspace_id = workspace_id.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let message = line.trim();
                    if message.is_empty() {
                        continue;
                    }
                    let _ = app.emit_service(
                        Some(workspace_id.clone()),
                        Some(thread_id.clone()),
                        ServiceLevel::Info,
                        message.to_string(),
                        Some("claude-stderr".to_string()),
                    );
                }
            })
        });

        if let Some(stdout) = stdout {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(value) => {
                        if let Some(delta) = extract_claude_text_delta(&value) {
                            assistant_text = merge_claude_assistant_text(&assistant_text, &delta);
                            saw_agent_output = true;
                            let item = ConversationItem::AssistantMessage {
                                id: assistant_id.clone(),
                                text: assistant_text.clone(),
                                created_at: Utc::now(),
                            };
                            let _ = self
                                .push_conversation_item(&workspace_id, &thread_id, item, true)
                                .await;
                        } else if let Some((tool_id, title, status, output)) =
                            extract_claude_tool_event(&value)
                        {
                            saw_agent_output = true;
                            let completed_at = if status == "running" {
                                None
                            } else {
                                Some(Utc::now())
                            };
                            let item = ConversationItem::ToolCall {
                                id: tool_id,
                                title: title.clone(),
                                tool_kind: "claude_tool".to_string(),
                                status: status.clone(),
                                output: output.clone(),
                                exit_code: None,
                                display: tool_display_metadata(
                                    &title,
                                    "claude_tool",
                                    &status,
                                    None,
                                    output.as_deref(),
                                ),
                                created_at: Utc::now(),
                                completed_at,
                            };
                            let _ = self
                                .push_conversation_item(&workspace_id, &thread_id, item, true)
                                .await;
                        } else if let Some(message) = extract_claude_service_message(&value) {
                            let _ = self.emit_service(
                                Some(workspace_id.clone()),
                                Some(thread_id.clone()),
                                ServiceLevel::Info,
                                message,
                                Some("claude".to_string()),
                            );
                        }
                        if let Some(error) = extract_claude_error(&value) {
                            turn_error = Some(error);
                        }
                    }
                    Err(_) => {
                        let _ = self.emit_service(
                            Some(workspace_id.clone()),
                            Some(thread_id.clone()),
                            ServiceLevel::Info,
                            trimmed.to_string(),
                            Some("claude".to_string()),
                        );
                    }
                }
            }
        }

        if let Some(stderr_task) = stderr_task {
            let _ = stderr_task.await;
        }

        if let Ok(runtime) = self.claude_runtime_for(&workspace_id).await {
            match runtime.finish_turn(&thread_id).await {
                Ok(Some(status)) if !status.success() && turn_error.is_none() => {
                    turn_error = Some(match status.code() {
                        Some(code) => format!("Claude turn failed with exit code {code}"),
                        None => "Claude turn failed".to_string(),
                    });
                }
                Ok(Some(status))
                    if status.success() && !saw_agent_output && turn_error.is_none() =>
                {
                    turn_error = Some(
                        "Claude turn completed without emitting any assistant output".to_string(),
                    );
                }
                Ok(_) | Err(_) => {}
            }
        }
        let final_error = turn_error.clone();
        let _ = self
            .with_thread_mut(&workspace_id, &thread_id, |thread| {
                thread.status = if final_error.is_some() {
                    ThreadStatus::Error
                } else {
                    ThreadStatus::Idle
                };
                thread.last_error = final_error.clone();
                thread.updated_at = Utc::now();
            })
            .await;
        if let Ok(thread) = self.thread_summary(&workspace_id, &thread_id).await {
            self.emit(
                Some(workspace_id.clone()),
                Some(thread_id.clone()),
                UnifiedEvent::ThreadUpdated { thread },
            );
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
            ConversationItem::ToolCall { .. } => thread.tool_items.get(id).copied(),
            _ => thread
                .items
                .iter()
                .position(|entry| conversation_item_identity(entry) == id),
        };

        if update_existing {
            if let Some(index) = existing_index {
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
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::ConversationItemUpdated { item },
                );
                if track_attention {
                    let thread = self.thread_summary(workspace_id, thread_id).await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.to_string()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    self.persist_local_state().await?;
                }
                return Ok(());
            }
        }

        let index = thread.items.len();
        match &item {
            ConversationItem::AssistantMessage { .. } => {
                thread.assistant_items.insert(id.to_string(), index);
            }
            ConversationItem::Reasoning { .. } => {
                thread.reasoning_items.insert(id.to_string(), index);
            }
            ConversationItem::ToolCall { .. } => {
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
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ConversationItemAdded { item },
        );
        if track_attention {
            let thread = self.thread_summary(workspace_id, thread_id).await?;
            self.emit(
                Some(workspace_id.to_string()),
                Some(thread_id.to_string()),
                UnifiedEvent::ThreadUpdated { thread },
            );
            self.persist_local_state().await?;
        }
        Ok(())
    }

    pub(super) async fn resolve_interactive_request_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        request_id: &str,
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
        if let ConversationItem::InteractiveRequest { resolved, .. } = &mut thread.items[index] {
            *resolved = true;
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
            tool_items: HashMap::new(),
            manual_title: false,
            ai_title_generated,
            ai_title_in_flight: false,
            requires_resume: false,
        }
    }

    pub(super) fn with_items(summary: ThreadSummary, items: Vec<ConversationItem>) -> Self {
        let mut thread = Self::new(summary);
        for (index, item) in items.into_iter().enumerate() {
            let id = conversation_item_identity(&item).to_string();
            match &item {
                ConversationItem::AssistantMessage { .. } => {
                    thread.assistant_items.insert(id, index);
                }
                ConversationItem::Reasoning { .. } => {
                    thread.reasoning_items.insert(id, index);
                }
                ConversationItem::ToolCall { .. } => {
                    thread.tool_items.insert(id, index);
                }
                _ => {}
            }
            thread.items.push(item);
        }
        thread.requires_resume = true;
        thread
    }
}

impl ManagedWorkspace {
    pub(super) fn has_runtime(&self) -> bool {
        self.codex_session.is_some() && self.claude_runtime.is_some()
    }
}

fn conversation_item_identity(item: &ConversationItem) -> &str {
    match item {
        ConversationItem::UserMessage { id, .. }
        | ConversationItem::AssistantMessage { id, .. }
        | ConversationItem::Reasoning { id, .. }
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
