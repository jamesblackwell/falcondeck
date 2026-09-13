//! Daemon-owned, workspace-scoped tools for in-session collaboration.
use super::*;
use falcondeck_core::ThreadDetailMode;
use falcondeck_core::{ExtensionAgentTool, ExtensionToolResponse, ThreadOrigin};
use serde::Deserialize;

const LIST: &str = "falcondeck_list_threads";
const VIEW: &str = "falcondeck_view_thread";
const CREATE: &str = "falcondeck_create_thread";
const MAX_CHARS: usize = 24_000;
const MAX_ITEMS: usize = 100;

pub(super) fn is_builtin(name: &str) -> bool {
    matches!(name, LIST | VIEW | CREATE)
}

pub(super) fn catalog() -> Vec<ExtensionAgentTool> {
    [
        (LIST, "List threads", "List this workspace's threads as bounded markdown with cached opening/recent user excerpts. Does not hydrate transcripts.", json!({
            "limit": {"type":"integer", "minimum":1, "maximum":100},
            "max_chars": {"type":"integer", "minimum":512, "maximum":24000}
        }), vec![]),
        (VIEW, "View thread", "Read a bounded transcript tail as handoff markdown. Use the returned before cursor for older items. Only this workspace is accessible.", json!({
            "thread_id": {"type":"string", "minLength":1},
            "before": {"type":"string", "minLength":1},
            "limit": {"type":"integer", "minimum":1, "maximum":100},
            "max_chars": {"type":"integer", "minimum":512, "maximum":24000}
        }), vec!["thread_id"]),
        (CREATE, "Create thread", "Create a sibling in this workspace and optionally send its first prompt. Returns after dispatch without waiting for completion. At most three concurrent children per parent; approvals remain in FalconDeck UI. Context defaults to none; briefing uses cached excerpts, transcript_tail uses bounded markdown.", json!({
            "provider": {"type":"string", "minLength":1},
            "isolation": {"type":"string", "enum":["project_folder","isolated"], "default":"project_folder"},
            "model": {"type":"string", "minLength":1},
            "prompt": {"type":"string", "minLength":1, "maxLength":24000},
            "context": {"type":"string", "enum":["none","briefing","transcript_tail"], "default":"none"}
        }), vec![]),
    ].into_iter().map(|(name,title,description,properties,required)| ExtensionAgentTool {
        name: name.into(), extension_id: "falcondeck".into(), tool_id: name.trim_start_matches("falcondeck_").into(), title: title.into(), description: description.into(),
        input_schema: json!({"type":"object","additionalProperties":false,"properties":properties,"required":required}),
    }).collect()
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    thread_id: Option<String>,
    before: Option<String>,
    limit: Option<usize>,
    max_chars: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "snake_case")]
enum Context {
    #[default]
    None,
    Briefing,
    TranscriptTail,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateArgs {
    provider: Option<AgentProvider>,
    #[serde(default)]
    isolation: falcondeck_core::ThreadIsolation,
    model: Option<String>,
    prompt: Option<String>,
    #[serde(default)]
    context: Context,
}

fn args<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, DaemonError> {
    serde_json::from_value(value.clone()).map_err(|e| DaemonError::BadRequest(e.to_string()))
}
fn capped(text: &str, cap: usize) -> String {
    let mut chars = text.chars();
    let value: String = chars.by_ref().take(cap).collect();
    if chars.next().is_some() {
        let mut value: String = value.chars().take(cap.saturating_sub(1)).collect();
        value.push('…');
        value
    } else {
        value
    }
}
fn line(text: &str, cap: usize) -> String {
    capped(text, cap)
        .replace(['\n', '\r'], " ")
        .replace('|', "\\|")
}
fn response(markdown: String) -> ExtensionToolResponse {
    ExtensionToolResponse {
        result: Value::String(markdown),
        extension_id: None,
        tool_id: None,
    }
}
fn child_is_active(thread: &ThreadSummary, parent: &str) -> bool {
    matches!(&thread.origin, Some(ThreadOrigin::AgentSpawn { parent_thread_id }) if parent_thread_id == parent)
        && (matches!(
            thread.status,
            ThreadStatus::Running | ThreadStatus::WaitingForInput
        ) || !thread.queued_turns.is_empty()
            || (!thread.is_archived
                && thread.latest_turn_id.is_none()
                && thread.status == ThreadStatus::Idle))
}

impl AppState {
    pub(super) async fn invoke_thread_tool(
        &self,
        name: &str,
        arguments: &Value,
        caller: Option<&str>,
        workspace_path: Option<&str>,
    ) -> Result<ExtensionToolResponse, DaemonError> {
        let parent = caller.filter(|id| !id.is_empty()).ok_or_else(|| {
            DaemonError::BadRequest("this tool requires an attached calling thread".into())
        })?;
        let workspace = self
            .extension_call_workspace_id(Some(parent), workspace_path)
            .await
            .ok_or_else(|| DaemonError::NotFound("calling thread not found".into()))?;
        // A fallback workspace path must not authorize a missing calling thread.
        let parent_summary = self.thread_summary(&workspace, parent).await?;
        match name {
            LIST => {
                let a: ReadArgs = args(arguments)?;
                if a.thread_id.is_some() || a.before.is_some() {
                    return Err(DaemonError::BadRequest(
                        "list accepts only limit and max_chars".into(),
                    ));
                }
                let cap = a.max_chars.unwrap_or(MAX_CHARS).clamp(512, MAX_CHARS);
                let summaries = {
                    let workspaces = self.inner.workspaces.lock().await;
                    let ws = workspaces
                        .get(&workspace)
                        .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
                    let mut summaries: Vec<_> =
                        ws.threads.values().map(|t| t.summary.clone()).collect();
                    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
                    summaries
                };
                let mut markdown = String::from("# Workspace threads\n\n");
                let total = summaries.len();
                let mut shown = 0;
                for summary in summaries.iter().take(a.limit.unwrap_or(30).clamp(1, 100)) {
                    let entry = self.thread_briefing(summary);
                    if markdown.chars().count() + entry.chars().count() + 100 > cap {
                        break;
                    }
                    markdown.push_str(&entry);
                    shown += 1;
                }
                markdown.push_str(&format!("\nShown {shown} of {total} threads.\n"));
                Ok(response(markdown))
            }
            VIEW => {
                let a: ReadArgs = args(arguments)?;
                let target = a
                    .thread_id
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| DaemonError::BadRequest("thread_id is required".into()))?;
                Ok(response(
                    self.thread_handoff(&workspace, target, a.before, a.limit, a.max_chars)
                        .await?,
                ))
            }
            CREATE => {
                let a: CreateArgs = args(arguments)?;
                if a.prompt
                    .as_ref()
                    .is_some_and(|p| p.trim().is_empty() || p.chars().count() > MAX_CHARS)
                    || a.model.as_ref().is_some_and(|m| m.trim().is_empty())
                {
                    return Err(DaemonError::BadRequest(
                        "prompt must be 1–24000 characters and model must be nonempty".into(),
                    ));
                }
                // Serializes admission through dispatch; a simultaneous fourth call cannot race the count.
                let _gate = self.inner.agent_spawn_gate.lock().await;
                {
                    let workspaces = self.inner.workspaces.lock().await;
                    let ws = workspaces
                        .get(&workspace)
                        .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
                    if ws
                        .threads
                        .values()
                        .filter(|t| child_is_active(&t.summary, parent))
                        .count()
                        >= 3
                    {
                        return Err(DaemonError::BadRequest("parent already has 3 concurrent children; finish a child or archive an unused idle child first".into()));
                    }
                }
                let context = match a.context {
                    Context::None => None,
                    Context::Briefing => Some(self.thread_briefing(&parent_summary)),
                    Context::TranscriptTail => Some(
                        self.thread_handoff(&workspace, parent, None, Some(40), Some(12_000))
                            .await?,
                    ),
                };
                let handle = self
                    .start_thread(StartThreadRequest {
                        workspace_id: workspace.clone(),
                        provider: a.provider,
                        model_id: a.model,
                        isolation: a.isolation,
                        collaboration_mode_id: None,
                        approval_policy: None,
                        sandbox_mode: None,
                        permission_mode: None,
                        handoff_from: context.as_ref().map(|_| {
                            falcondeck_core::ThreadHandoffSource {
                                thread_id: parent.into(),
                                provider: parent_summary.provider,
                                context_pending: true,
                            }
                        }),
                        handoff_context: context,
                    })
                    .await?;
                let id = handle.thread.id;
                self.with_thread_mut(&workspace, &id, |thread| {
                    thread.origin = Some(ThreadOrigin::AgentSpawn {
                        parent_thread_id: parent.into(),
                    })
                })
                .await?;
                self.persist_local_state().await?;
                let thread = self.thread_summary(&workspace, &id).await?;
                self.emit(
                    Some(workspace.clone()),
                    Some(id.clone()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                let mut markdown = format!(
                    "# Created thread\n\n- Id: {}\n- Parent: {}\n",
                    line(&id, 256),
                    line(parent, 256)
                );
                if let Some(prompt) = a.prompt {
                    let request: SendTurnRequest = serde_json::from_value(
                        json!({"workspace_id": workspace, "thread_id": id, "inputs":[{"type":"text","text":prompt}]}),
                    )?;
                    match self.send_turn(request).await {
                        Ok(_) => markdown.push_str("- First prompt dispatched. Check progress with falcondeck_view_thread.\n"),
                        Err(error) => markdown.push_str(&format!("- First prompt failed: {}. The thread was created.\n", line(&error.to_string(), 1000))),
                    }
                } else {
                    markdown.push_str("- No first prompt supplied; thread is idle.\n");
                }
                Ok(response(markdown))
            }
            _ => unreachable!(),
        }
    }

    fn thread_briefing(&self, thread: &ThreadSummary) -> String {
        let mut text = format!(
            "## {}\n\n- Id: {}\n- Provider: {}\n- Status: {}\n- Last preview: {}\n",
            line(&thread.title, 256),
            line(&thread.id, 256),
            thread.provider,
            serde_json::to_value(&thread.status)
                .unwrap_or_default()
                .as_str()
                .unwrap_or("unknown"),
            line(thread.last_message_preview.as_deref().unwrap_or(""), 400)
        );
        let index = self
            .inner
            .thread_search
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(excerpt) = thread
            .native_session_id
            .as_ref()
            .and_then(|id| index.sessions.get(id))
        {
            for (label, messages) in [
                ("Opening user", &excerpt.opening),
                ("Recent user", &excerpt.recent),
            ] {
                for message in messages.iter().take(3) {
                    text.push_str(&format!("- {label}: {}\n", line(message, 400)));
                }
            }
        }
        text.push('\n');
        text
    }

    async fn thread_handoff(
        &self,
        workspace: &str,
        thread: &str,
        before: Option<String>,
        limit: Option<usize>,
        cap: Option<usize>,
    ) -> Result<String, DaemonError> {
        let limit = limit.unwrap_or(40).clamp(1, MAX_ITEMS);
        let cap = cap.unwrap_or(MAX_CHARS).clamp(512, MAX_CHARS);
        let detail = self
            .thread_detail_with_request(&ThreadDetailRequest {
                workspace_id: workspace.into(),
                thread_id: thread.into(),
                mode: if before.is_some() {
                    ThreadDetailMode::Before
                } else {
                    ThreadDetailMode::Tail
                },
                limit: Some(limit),
                before_item_id: before,
                inline_images: Some(false),
                tool_output_bytes: Some(2000),
                strict_limit: Some(true),
                compact_workspace: Some(true),
            })
            .await?;
        Ok(handoff_markdown(&detail, limit, cap))
    }
}

/// Rust handoff projection: readable content only, never provider metadata or ConversationItem JSON.
fn item_markdown(item: &ConversationItem) -> String {
    match item {
        ConversationItem::UserMessage {
            text, attachments, ..
        } => {
            let mut body = format!("## User\n\n{}", capped(text.trim(), 12_000));
            for attachment in attachments.iter().take(20) {
                body.push_str(&format!(
                    "\n- Attachment: {}",
                    line(attachment.name.as_deref().unwrap_or("Image"), 256)
                ));
            }
            body
        }
        ConversationItem::AssistantMessage { text, .. } => {
            format!("## Assistant\n\n{}", capped(text.trim(), 12_000))
        }
        ConversationItem::Reasoning { content, .. } => {
            format!("## Reasoning\n\n{}", capped(content, 2000))
        }
        ConversationItem::CodeReview { content, .. } => {
            format!("## Code review\n\n{}", capped(content, 4000))
        }
        ConversationItem::ToolCall {
            title,
            output,
            exit_code,
            ..
        } => format!(
            "## Tool — {}\n\n{}{}",
            line(title, 256),
            exit_code
                .filter(|c| *c != 0)
                .map(|c| format!("Exit code: {c}\n\n"))
                .unwrap_or_default(),
            capped(output.as_deref().unwrap_or(""), 2000)
        ),
        ConversationItem::FileChange { changes, .. } => format!(
            "## Files edited\n\n{}",
            changes
                .iter()
                .take(100)
                .map(|c| format!("- {}", line(&c.path, 256)))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        ConversationItem::Plan { plan, .. } => format!(
            "## Plan\n\n{}\n{}",
            capped(plan.explanation.as_deref().unwrap_or(""), 1000),
            plan.steps
                .iter()
                .take(50)
                .map(|s| format!("- {}", line(&s.step, 400)))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        ConversationItem::ContextCompaction { .. } => {
            "## Context compaction\n\nEarlier conversation was summarized for continuity.".into()
        }
        ConversationItem::Artifact { artifact, .. } => format!(
            "## Artifact — {}\n\n{}",
            line(&artifact.title, 256),
            capped(artifact.content.as_deref().unwrap_or(""), 4000)
        ),
        ConversationItem::Image { image, .. } => format!(
            "## Image\n\n{}",
            line(image.alt_text.as_deref().unwrap_or("Image"), 400)
        ),
        ConversationItem::WebSearch { search, .. } => {
            format!("## Web search\n\n{}", line(&search.query, 400))
        }
        ConversationItem::Unsupported { reason, .. } => {
            format!("## Unsupported output\n\n{}", line(reason, 400))
        }
        ConversationItem::Diff { .. } => "## Diff\n\nDiff omitted from bounded handoff.".into(),
        ConversationItem::Service { message, .. } => {
            format!("## Service\n\n{}", capped(message, 1000))
        }
        ConversationItem::InteractiveRequest { resolved, .. } => format!(
            "## Interactive request\n\n{}",
            if *resolved {
                "Resolved in FalconDeck."
            } else {
                "Awaiting response in FalconDeck UI."
            }
        ),
    }
}

fn handoff_markdown(detail: &ThreadDetail, limit: usize, cap: usize) -> String {
    // Tail detail may prepend a non-contiguous user prompt; discard it to preserve the item cap and cursor.
    let items = &detail.items[detail.items.len().saturating_sub(limit)..];
    let mut sections = Vec::new();
    let mut used = 0;
    let budget = cap.saturating_sub(400);
    let mut oldest = None;
    for item in items.iter().rev() {
        let section = item_markdown(item);
        let size = section.chars().count() + 2;
        if used + size > budget && !sections.is_empty() {
            break;
        }
        let section = capped(&section, budget.saturating_sub(used + 2));
        used += section.chars().count() + 2;
        sections.push(section);
        oldest = Some(workspace_ops::conversation_item_id(item));
    }
    let has_older = detail.has_older || sections.len() < detail.items.len();
    sections.reverse();
    let header = format!(
        "# Thread {}\n\n{}\n\n",
        line(&detail.thread.id, 128),
        if has_older {
            format!(
                "Older items: before={}",
                line(
                    oldest.or(detail.oldest_item_id.as_deref()).unwrap_or(""),
                    128
                )
            )
        } else {
            "No older items.".into()
        }
    );
    capped(&format!("{header}{}", sections.join("\n\n")), cap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use falcondeck_core::{ThreadAgentParams, ThreadAttention};
    use tempfile::tempdir;
    async fn fixture() -> (AppState, tempfile::TempDir) {
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
                    default_provider: AgentProvider::CLAUDE,
                    models: Vec::new(),
                    collaboration_modes: Vec::new(),
                    account: falcondeck_core::AccountSummary::default(),
                    current_thread_id: Some(thread_id.clone()),
                    connected_at: Utc::now(),
                    updated_at: Utc::now(),
                    last_error: None,
                    icon: None,
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
                        provider: AgentProvider::CLAUDE,
                        native_session_id: Some("session-parent".into()),
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

        (app, temp_dir)
    }
    fn call(name: &str, arguments: Value) -> falcondeck_core::InvokeExtensionToolRequest {
        falcondeck_core::InvokeExtensionToolRequest {
            name: name.into(),
            arguments,
            thread_id: Some("thread-1".into()),
            workspace_path: None,
            bridge_capability: None,
        }
    }
    fn user(id: &str, text: &str) -> ConversationItem {
        ConversationItem::UserMessage {
            id: id.into(),
            text: text.into(),
            attachments: vec![],
            turn_id: None,
            previous_turn_id: None,
            created_at: Utc::now(),
        }
    }
    fn assistant(id: &str, text: &str) -> ConversationItem {
        serde_json::from_value(
            json!({"kind":"assistant_message","id":id,"text":text,"created_at":Utc::now()}),
        )
        .unwrap()
    }
    async fn set_items(app: &AppState, items: Vec<ConversationItem>) {
        app.inner
            .workspaces
            .lock()
            .await
            .get_mut("workspace-1")
            .unwrap()
            .threads
            .get_mut("thread-1")
            .unwrap()
            .items = items;
    }
    fn created_id(result: &ExtensionToolResponse) -> String {
        result
            .result
            .as_str()
            .unwrap()
            .lines()
            .find_map(|s| s.strip_prefix("- Id: "))
            .unwrap()
            .into()
    }
    #[tokio::test]
    async fn catalog_and_list_use_only_summaries_and_cached_index() {
        let (app, _temp) = fixture().await;
        for name in [LIST, VIEW, CREATE, BUILTIN_RENAME_THREAD_TOOL] {
            assert!(
                app.extension_agent_tools()
                    .await
                    .tools
                    .iter()
                    .any(|t| t.name == name)
            );
        }
        set_items(&app, vec![user("secret", "transcript must not leak")]).await;
        app.inner.thread_search.lock().unwrap().sessions.insert(
            "session-parent".into(),
            thread_search::SessionExcerpt {
                path: "/missing/transcript".into(),
                modified_ms: 0,
                size: 0,
                opening: vec!["opening goal".into()],
                recent: vec!["recent change".into()],
            },
        );
        let result = app
            .invoke_extension_tool(call(LIST, json!({})))
            .await
            .unwrap();
        let text = result.result.as_str().unwrap();
        for part in [
            "thread-1",
            "Provider: claude",
            "Status: idle",
            "Last preview:",
            "opening goal",
            "recent change",
        ] {
            assert!(text.contains(part), "{text}");
        }
        assert!(!text.contains("transcript must not leak"));
        let bounded = app
            .invoke_extension_tool(call(LIST, json!({"max_chars":512})))
            .await
            .unwrap();
        assert!(bounded.result.as_str().unwrap().chars().count() <= 512);
    }
    #[tokio::test]
    async fn view_is_markdown_with_contiguous_before_pages_and_caps() {
        let (app, _temp) = fixture().await;
        set_items(
            &app,
            vec![
                user("u1", "first"),
                assistant("a1", "answer one"),
                user("u2", "second"),
                assistant("a2", "answer two"),
                assistant("a3", "answer three"),
            ],
        )
        .await;
        let page = app
            .invoke_extension_tool(call(VIEW, json!({"thread_id":"thread-1","limit":2})))
            .await
            .unwrap();
        let text = page.result.as_str().unwrap();
        assert!(text.contains("before=a2"), "{text}");
        assert_eq!(text.matches("## Assistant").count(), 2);
        assert!(!text.contains("## User")); // Tail's extra prepended prompt is outside the cap.
        assert!(!text.contains("created_at"));
        let page = app
            .invoke_extension_tool(call(
                VIEW,
                json!({"thread_id":"thread-1","before":"a2","limit":2}),
            ))
            .await
            .unwrap();
        let text = page.result.as_str().unwrap();
        assert!(text.contains("## User\n\nsecond") && text.contains("answer one"));
        assert!(text.contains("before=a1"));
        assert!(!text.contains("answer two"));
        set_items(
            &app,
            vec![
                user("u1", &"🦅".repeat(30_000)),
                assistant("a1", &"終".repeat(30_000)),
            ],
        )
        .await;
        let page = app
            .invoke_extension_tool(call(VIEW, json!({"thread_id":"thread-1","max_chars":512})))
            .await
            .unwrap();
        assert!(page.result.as_str().unwrap().chars().count() <= 512);
        assert!(page.result.as_str().unwrap().contains("before=a1"));
        for arguments in [
            json!({"thread_id":"missing"}),
            json!({"thread_id":"thread-1","before":"missing"}),
        ] {
            assert!(
                app.invoke_extension_tool(call(VIEW, arguments))
                    .await
                    .is_err()
            );
        }
    }
    #[tokio::test]
    async fn create_defaults_to_no_parent_context_and_persists_origin() {
        let (app, temp) = fixture().await;
        set_items(&app, vec![user("u1", "PRIVATE PARENT TRANSCRIPT")]).await;
        let result = app
            .invoke_extension_tool(call(
                CREATE,
                json!({"provider":"claude","model":"test-model"}),
            ))
            .await
            .unwrap();
        let id = created_id(&result);
        let workspaces = app.inner.workspaces.lock().await;
        let child = &workspaces["workspace-1"].threads[&id];
        assert!(child.items.is_empty());
        assert!(child.pending_handoff_context.is_none());
        assert!(child.summary.handoff_from.is_none());
        assert_eq!(child.summary.agent.model_id.as_deref(), Some("test-model"));
        assert_eq!(child.summary.workspace_id, "workspace-1");
        assert_eq!(
            child.summary.origin,
            Some(ThreadOrigin::AgentSpawn {
                parent_thread_id: "thread-1".into()
            })
        );
        drop(workspaces);
        let persisted = std::fs::read_to_string(temp.path().join("daemon-state.json")).unwrap();
        assert!(persisted.contains("agent_spawn"));
        assert!(!persisted.contains("PRIVATE PARENT TRANSCRIPT"));
    }
    #[tokio::test]
    async fn create_context_is_opt_in_and_first_send_reports_created_id_on_failure() {
        let (app, _temp) = fixture().await;
        set_items(&app, vec![user("u1", "parent tail text")]).await;
        let result = app
            .invoke_extension_tool(call(CREATE, json!({"context":"transcript_tail"})))
            .await
            .unwrap();
        let id = created_id(&result);
        let workspaces = app.inner.workspaces.lock().await;
        let context = workspaces["workspace-1"].threads[&id]
            .pending_handoff_context
            .as_ref()
            .unwrap();
        assert!(context.contains("## User\n\nparent tail text"));
        drop(workspaces);
        let result = app
            .invoke_extension_tool(call(CREATE, json!({"prompt":"do bounded work"})))
            .await
            .unwrap();
        assert!(
            result
                .result
                .as_str()
                .unwrap()
                .contains("First prompt failed")
        ); // No provider runtime in fixture.
        assert!(
            app.thread_summary("workspace-1", &created_id(&result))
                .await
                .is_ok()
        );
    }
    #[tokio::test]
    async fn concurrent_creation_admits_only_three_children_and_completion_releases_slot() {
        let (app, _temp) = fixture().await;
        let mut calls = tokio::task::JoinSet::new();
        for _ in 0..6 {
            let app = app.clone();
            calls.spawn(async move { app.invoke_extension_tool(call(CREATE, json!({}))).await });
        }
        let mut ids = Vec::new();
        let mut rejected = 0;
        while let Some(result) = calls.join_next().await {
            match result.unwrap() {
                Ok(result) => ids.push(created_id(&result)),
                Err(error) => {
                    assert!(error.to_string().contains("3 concurrent children"));
                    rejected += 1;
                }
            }
        }
        assert_eq!(ids.len(), 3);
        assert_eq!(rejected, 3);
        app.with_thread_mut("workspace-1", &ids[0], |t| {
            t.latest_turn_id = Some("finished".into());
            t.status = ThreadStatus::Idle;
        })
        .await
        .unwrap();
        assert!(
            app.invoke_extension_tool(call(CREATE, json!({})))
                .await
                .is_ok()
        );
    }
    #[tokio::test]
    async fn builtins_require_real_caller_and_reject_cross_workspace_view() {
        let (app, _temp) = fixture().await;
        let mut missing = call(LIST, json!({}));
        missing.thread_id = Some("missing".into());
        missing.workspace_path = Some(
            app.inner.workspaces.lock().await["workspace-1"]
                .summary
                .path
                .clone(),
        );
        assert!(app.invoke_extension_tool(missing).await.is_err());
        assert!(
            app.invoke_extension_tool(call(CREATE, json!({"workspace_id":"elsewhere"})))
                .await
                .is_err()
        );
        let mut ws = app.inner.workspaces.lock().await;
        let mut summary = ws["workspace-1"].threads["thread-1"].summary.clone();
        summary.id = "foreign".into();
        summary.workspace_id = "elsewhere".into();
        let other = ManagedWorkspace {
            summary: ws["workspace-1"].summary.clone(),
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: HashMap::from([("foreign".into(), ManagedThread::new(summary))]),
        };
        ws.insert("elsewhere".into(), other);
        drop(ws);
        assert!(
            app.invoke_extension_tool(call(VIEW, json!({"thread_id":"foreign"})))
                .await
                .is_err()
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn create_dispatches_first_prompt_through_provider_without_parent_dump() {
        use std::os::unix::fs::PermissionsExt;
        let (app, temp) = fixture().await;
        set_items(&app, vec![user("u1", "PRIVATE PARENT TRANSCRIPT")]).await;
        let script = temp.path().join("fake-claude");
        let capture = temp.path().join("captured-input");
        std::fs::write(&script, format!("#!/bin/sh\nIFS= read -r input\nprintf '%s' \"$input\" > '{}'\nprintf '%s\\n' '{{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\",\"session_id\":\"test-session\"}}'\n", capture.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = crate::claude::ClaudeRuntime::for_test(
            temp.path().to_string_lossy().into(),
            script.to_string_lossy().into(),
        );
        app.inner
            .workspaces
            .lock()
            .await
            .get_mut("workspace-1")
            .unwrap()
            .claude_runtime = Some(runtime.clone());
        let result = app
            .invoke_extension_tool(call(
                CREATE,
                json!({"provider":"claude", "prompt":"do bounded work"}),
            ))
            .await
            .unwrap();
        assert!(
            result
                .result
                .as_str()
                .unwrap()
                .contains("First prompt dispatched"),
            "{:?}",
            result.result
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while std::fs::read_to_string(&capture)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .is_none()
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let input = std::fs::read_to_string(capture).unwrap();
        assert!(input.contains("do bounded work"));
        assert!(!input.contains("PRIVATE PARENT TRANSCRIPT"));
        let ws = app.inner.workspaces.lock().await;
        let child = &ws["workspace-1"].threads[&created_id(&result)];
        assert!(child.items.iter().any(
            |i| matches!(i,ConversationItem::UserMessage {text,..} if text == "do bounded work")
        ));
        drop(ws);
        runtime.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn archiving_a_running_child_does_not_release_its_slot() {
        let (app, _temp) = fixture().await;
        for _ in 0..3 {
            let result = app
                .invoke_extension_tool(call(CREATE, json!({})))
                .await
                .unwrap();
            app.with_thread_mut("workspace-1", &created_id(&result), |t| {
                t.status = ThreadStatus::Running;
                t.is_archived = true;
            })
            .await
            .unwrap();
        }
        assert!(
            app.invoke_extension_tool(call(CREATE, json!({})))
                .await
                .unwrap_err()
                .to_string()
                .contains("3 concurrent children")
        );
    }
}
