//! Daemon-owned, workspace-scoped tools for in-session collaboration.
use super::*;
use falcondeck_core::ThreadDetailMode;
use falcondeck_core::{ExtensionAgentTool, ExtensionToolResponse, ThreadOrigin};
use serde::Deserialize;

mod actions;
mod digest;
mod glance;
mod list;
mod read;

pub(super) use actions::ChildWatch;

const LIST: &str = "falcondeck_list_threads";
const VIEW: &str = "falcondeck_view_thread";
const CREATE: &str = "falcondeck_create_thread";
const MESSAGE: &str = "falcondeck_message_thread";
const SUMMARY: &str = "falcondeck_thread_summary";
const CHANGES: &str = "falcondeck_thread_changes";
const MAX_CHARS: usize = 24_000;
const MAX_ITEMS: usize = 100;

pub(super) fn is_builtin(name: &str) -> bool {
    actions::is_action(name) || matches!(name, LIST | VIEW | CREATE | MESSAGE | SUMMARY | CHANGES)
}

pub(super) fn catalog() -> Vec<ExtensionAgentTool> {
    [
        (LIST, "List threads", "Start here to see what is being worked on. One compact row per thread, newest activity first (default 20): status, age, provider, flags, and what it was last asked and last said. The header counts running, blocked, and recently active threads. Excludes you. Filter by status, time, query, parent, provider, folder, or pin; page with offset. Never loads transcripts.", list::schema(), vec![]),
        (CHANGES, "Thread changes", "Threads active since a time, same rows as list plus what changed (messages, files, commits, checks) when the transcript is loaded. Blocked threads first. Pass the returned Now as since next time to poll without repeats.", json!({
            "since": {"type":"string", "minLength":1, "description":"RFC 3339, YYYY-MM-DD, or an age like 15m, 2h, 1d."},
            "limit": {"type":"integer", "minimum":1, "maximum":100, "default":30},
            "include_archived": {"type":"boolean", "default":false},
            "max_chars": {"type":"integer", "minimum":512, "maximum":24000, "default":6000}
        }), vec!["since"]),
        (SUMMARY, "Summarize threads", "Outcome digest for 1–20 threads: attention, last request and reply, files changed, commits, and test/typecheck/autoreview results. Uses loaded items; hydrate=true loads a bounded tail for up to 5 unloaded threads.", json!({
            "thread_id": {"type":"string", "minLength":1},
            "thread_ids": {"type":"array", "items":{"type":"string", "minLength":1}, "maxItems":20},
            "hydrate": {"type":"boolean", "default":false},
            "max_chars": {"type":"integer", "minimum":512, "maximum":24000, "default":8000}
        }), vec![]),
        (VIEW, "View thread", "Read a thread's user/assistant messages, newest last (default 20 messages, 6000 characters). before pages older history; query searches literally; item_id with offset expands a truncated item. Tools and reasoning are opt-in.", json!({
            "thread_id": {"type":"string", "minLength":1},
            "before": {"type":"string", "minLength":1},
            "limit": {"type":"integer", "minimum":1, "maximum":100, "default":20},
            "max_chars": {"type":"integer", "minimum":512, "maximum":24000, "default":6000},
            "role": {"type":"string", "enum":["user","assistant"], "description":"Only this role. role=assistant, limit=1 returns the final reply."},
            "query": {"type":"string", "minLength":1, "maxLength":256, "description":"Literal, case-insensitive. Keep it and the filters unchanged when paging."},
            "item_id": {"type":"string", "minLength":1, "description":"Expand one item; not combined with before or query."},
            "offset": {"type":"integer", "minimum":0, "description":"Character offset in the expanded item; follow the returned offset."},
            "include_tools": {"type":"boolean", "default":false, "description":"Include tool output, file edits, plans, and reviews."},
            "include_reasoning": {"type":"boolean", "default":false},
            "preview_chars": {"type":"integer", "minimum":200, "maximum":24000, "default":1200, "description":"Body characters per item."}
        }), vec!["thread_id"]),
        (MESSAGE, "Message thread", "Send a message to another thread or a bot, labelled with your id and title. Default steer reaches its active turn (falling back to the queue); queue waits for the turn to finish; an idle thread starts a turn. Returns on admission, not on reply.", json!({
            "thread_id": {"type":"string", "minLength":1, "description":"Thread id, or a bot's name (bots are listed in falcondeck_list_threads)."},
            "message": {"type":"string", "minLength":1, "maxLength":24000, "description":"Readable prose with normal spaces between words."},
            "delivery": {"type":"string", "enum":["steer","queue"], "default":"steer"}
        }), vec!["thread_id", "message"]),
        (CREATE, "Create thread", "Start a new thread and optionally send its first prompt; returns without waiting. At most three active children per parent. Context defaults to none; briefing passes your summary, transcript_tail your recent transcript.", json!({
            "prompt": {"type":"string", "minLength":1, "maxLength":24000, "description":"A self-contained brief: goal, relevant files, constraints, and what done looks like."},
            "title": {"type":"string", "minLength":1, "maxLength":200},
            "provider": {"type":"string", "minLength":1},
            "model": {"type":"string", "minLength":1},
            "reasoning_effort": {"type":"string", "minLength":1, "description":"Harness setting, e.g. low, medium, high, xhigh; asking in the prompt does not set it."},
            "isolation": {"type":"string", "enum":["project_folder","isolated"], "default":"project_folder"},
            "context": {"type":"string", "enum":["none","briefing","transcript_tail"], "default":"none"},
            "folder": {"type":"string", "minLength":1, "description":"Project folder id or exact name."},
            "create_folder": {"type":"boolean", "default":false},
            "notify_parent": {"type":"boolean", "default":false, "description":"Message you whenever it stops or needs input (lost on daemon restart). Leave false unless critical or requested; bot tasks always report errors and input requests."}
        }), vec![]),
    ].into_iter().chain(actions::catalog()).map(|(name,title,description,properties,required)| ExtensionAgentTool {
        name: name.into(), extension_id: "falcondeck".into(), tool_id: name.trim_start_matches("falcondeck_").into(), title: title.into(), description: description.into(),
        input_schema: {
            let mut properties = properties;
            properties["workspace_id"] = json!({"type":"string", "description":"Bots only: project id, name, or path. Bots list and see changes across all projects by default."});
            json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
        },
    }).collect()
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
    reasoning_effort: Option<String>,
    prompt: Option<String>,
    #[serde(default)]
    context: Context,
    title: Option<String>,
    folder: Option<String>,
    #[serde(default)]
    create_folder: bool,
    #[serde(default)]
    notify_parent: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "snake_case")]
enum MessageDelivery {
    #[default]
    Steer,
    Queue,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageArgs {
    thread_id: String,
    message: String,
    #[serde(default)]
    delivery: MessageDelivery,
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
/// One line: whitespace runs collapse so paragraphs do not cost blank space.
fn line(text: &str, cap: usize) -> String {
    line_cut(text, cap).0
}
/// `line`, plus whether the text was cut short.
fn line_cut(text: &str, cap: usize) -> (String, bool) {
    let mut out = String::with_capacity(text.len().min(cap * 4));
    let mut chars = 0;
    for word in text.split_whitespace() {
        if chars > cap {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
            chars += 1;
        }
        out.push_str(word);
        chars += word.chars().count();
    }
    (capped(&out, cap).replace('|', "\\|"), chars > cap)
}
/// Code-mode harnesses (Codex `exec`) sometimes emit tool strings in minified
/// style, gluing prose words together. Normal prose averages 4–8 letters per
/// whitespace-separated token; glued text runs 14+. Code, paths and hashes are
/// ignored so technical messages are not mistaken for glued prose.
fn lost_word_spaces(text: &str) -> bool {
    let prose: String = text
        .split("```")
        .step_by(2)
        .flat_map(|chunk| chunk.split('`').step_by(2))
        .collect::<Vec<_>>()
        .join(" ");
    let (mut letters, mut tokens) = (0usize, 0usize);
    for token in prose.split_whitespace() {
        let hash_like = token.len() >= 7
            && token.chars().any(|c| c.is_ascii_digit())
            && token
                .chars()
                .all(|c| c.is_ascii_hexdigit() || "-.,;:()".contains(c));
        if hash_like || token.contains(['/', '\\']) {
            continue;
        }
        letters += token.chars().filter(|c| c.is_alphabetic()).count();
        tokens += 1;
    }
    letters >= 60 && letters as f64 / tokens as f64 >= 12.0
}
fn require_word_spaces(field: &str, text: &str) -> Result<(), DaemonError> {
    if lost_word_spaces(text) {
        return Err(DaemonError::BadRequest(format!(
            "{field} appears to be missing the spaces between words. Resend it as normal prose with spaces between words."
        )));
    }
    Ok(())
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
        let caller_workspace = self
            .extension_call_workspace_id(Some(parent), workspace_path)
            .await
            .ok_or_else(|| DaemonError::NotFound("calling thread not found".into()))?;
        // A fallback workspace path must not authorize a missing calling thread.
        let parent_summary = self.thread_summary(&caller_workspace, parent).await?;
        let bot = self.bot_for_thread(parent).await;
        let mut arguments = arguments.clone();
        // Agents know bots by name ("send it to Juno"); ids are stable.
        if let Some(named) = arguments.get("thread_id").and_then(Value::as_str)
            && let Some(bot) = self.bot_named(named).await
        {
            arguments["thread_id"] = json!(bot.thread_id);
        }
        let requested_workspace = arguments
            .as_object_mut()
            .and_then(|a| a.remove("workspace_id"))
            .map(|v| {
                v.as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| DaemonError::BadRequest("workspace_id must be nonempty".into()))
            })
            .transpose()?;
        let target = arguments
            .get("thread_id")
            .and_then(Value::as_str)
            .or_else(|| {
                arguments
                    .get("thread_ids")
                    .and_then(Value::as_array)
                    .and_then(|ids| ids.first())
                    .and_then(Value::as_str)
            });
        let explicit_workspace = requested_workspace.is_some();
        let asked_for_all = requested_workspace.as_deref() == Some("all");
        let requested_workspace = match requested_workspace {
            Some(ws) if ws == "all" => None,
            // Names and paths are a bot convenience; tasks pass their own id.
            Some(ws) if bot.is_some() => Some(self.resolve_workspace(&ws).await?),
            other => other,
        };
        if asked_for_all && (bot.is_none() || !matches!(name, LIST | CHANGES)) {
            return Err(DaemonError::BadRequest(
                "workspace_id \"all\" is for bot list and changes calls".into(),
            ));
        }
        // A bot's own workspace is rarely where its work happens, so its
        // overviews default to every project.
        let all_projects = asked_for_all
            || (bot.is_some()
                && requested_workspace.is_none()
                && target.is_none()
                && matches!(name, LIST | CHANGES));
        let workspace = if bot.is_some() {
            if let Some(workspace) = requested_workspace {
                workspace
            } else if let Some(target) = target {
                self.thread_workspace(target).await?
            } else {
                caller_workspace.clone()
            }
        } else {
            // Only bots message across projects, so a project thread can always
            // answer its sender by messaging that bot (or its spawning parent).
            let reply_workspace = match target {
                Some(target)
                    if name == MESSAGE
                        && (self.bot_for_thread(target).await.is_some()
                            || matches!(&parent_summary.origin,
                                Some(ThreadOrigin::AgentSpawn { parent_thread_id }) if parent_thread_id == target)) =>
                {
                    Some(self.thread_workspace(target).await?)
                }
                _ => None,
            };
            if requested_workspace
                .as_ref()
                .is_some_and(|ws| ws != &caller_workspace && Some(ws) != reply_workspace.as_ref())
            {
                return Err(DaemonError::BadRequest(
                    "Only bots can coordinate across projects".into(),
                ));
            }
            // Bots live outside projects; say how to reach one instead of
            // reporting its thread as missing.
            if reply_workspace.is_none()
                && let Some(target) = target
                && let Some(bot) = self.bot_for_thread(target).await
                && self
                    .thread_summary(&caller_workspace, target)
                    .await
                    .is_err()
            {
                return Err(DaemonError::BadRequest(format!(
                    "{} is the bot {}, outside this project. Send it a message with falcondeck_message_thread (thread_id \"{}\"); its conversation is not readable from here.",
                    line(target, 128),
                    line(&bot.name, 100),
                    line(&bot.name, 100)
                )));
            }
            reply_workspace.unwrap_or_else(|| caller_workspace.clone())
        };
        let arguments = &arguments;
        if name == CREATE && bot.as_ref().is_some_and(|bot| !bot.can_start_threads) {
            return Err(DaemonError::BadRequest(
                "Task creation is disabled for this bot".into(),
            ));
        }
        if actions::is_action(name) {
            return self
                .invoke_thread_action(name, arguments, &workspace, parent)
                .await;
        }
        let scope = if all_projects {
            self.project_workspace_ids().await
        } else {
            vec![workspace.clone()]
        };
        match name {
            LIST => Ok(response(
                list::list(self, &scope, parent, args(arguments)?).await?,
            )),
            VIEW => {
                let a: read::ViewArgs = args(arguments)?;
                let target = a
                    .thread_id
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| DaemonError::BadRequest("thread_id is required".into()))?;
                Ok(response(read::view(self, &workspace, target, &a).await?))
            }
            SUMMARY => Ok(response(
                digest::summary(
                    self,
                    &workspace,
                    parent,
                    bot.is_some() && !explicit_workspace,
                    &args(arguments)?,
                )
                .await?,
            )),
            CHANGES => Ok(response(
                digest::changes(self, &scope, parent, &args(arguments)?).await?,
            )),
            MESSAGE => {
                let a: MessageArgs = args(arguments)?;
                if a.thread_id.trim().is_empty()
                    || a.message.trim().is_empty()
                    || a.message.chars().count() > MAX_CHARS
                {
                    return Err(DaemonError::BadRequest(
                        "thread_id must be nonempty and message must be 1–24000 characters".into(),
                    ));
                }
                require_word_spaces("message", &a.message)?;
                if a.thread_id == parent {
                    return Err(DaemonError::BadRequest(
                        "cannot message the calling thread".into(),
                    ));
                }
                // Resolve within the target workspace before any send-side mutations.
                self.thread_summary(&workspace, &a.thread_id).await?;
                let text = format!(
                    "Message from FalconDeck thread {} ({}):\n\n{}",
                    line(parent, 256),
                    line(&parent_summary.title, 256),
                    a.message
                );
                let request: SendTurnRequest = serde_json::from_value(json!({
                    "workspace_id": workspace,
                    "thread_id": a.thread_id,
                    "inputs": [{"type":"text","text":text}],
                    "steer": matches!(a.delivery, MessageDelivery::Steer)
                }))?;
                let result = self.send_turn(request).await?;
                self.analytics_agent_message(
                    parent,
                    &a.thread_id,
                    &a.message,
                    if matches!(a.delivery, MessageDelivery::Steer) {
                        "steer"
                    } else {
                        "queue"
                    },
                );
                Ok(response(format!(
                    "# Message accepted\n\n- Id: {}\n- Delivery: {}\n- Check replies with falcondeck_view_thread.\n",
                    line(&a.thread_id, 256),
                    line(result.message.as_deref().unwrap_or("accepted"), 256)
                )))
            }
            CREATE => {
                let a: CreateArgs = args(arguments)?;
                if a.prompt
                    .as_ref()
                    .is_some_and(|p| p.trim().is_empty() || p.chars().count() > MAX_CHARS)
                    || a.model.as_ref().is_some_and(|m| m.trim().is_empty())
                    || a.reasoning_effort
                        .as_ref()
                        .is_some_and(|e| e.trim().is_empty())
                    || a.title
                        .as_ref()
                        .is_some_and(|t| t.trim().is_empty() || t.chars().count() > 200)
                {
                    return Err(DaemonError::BadRequest(
                        "prompt must be 1–24000 characters, model and reasoning_effort nonempty, and title 1–200 characters".into(),
                    ));
                }
                if let Some(prompt) = &a.prompt {
                    require_word_spaces("prompt", prompt)?;
                }
                // Serializes admission through dispatch; a simultaneous fourth call cannot race the count.
                let _gate = self.inner.agent_spawn_gate.lock().await;
                {
                    let workspaces = self.inner.workspaces.lock().await;
                    if !workspaces.contains_key(&workspace) {
                        return Err(DaemonError::NotFound("workspace not found".into()));
                    }
                    if workspaces
                        .values()
                        .flat_map(|ws| ws.threads.values())
                        .filter(|t| child_is_active(&t.summary, parent))
                        .count()
                        >= 3
                    {
                        return Err(DaemonError::BadRequest("parent already has 3 concurrent children; finish a child or archive an unused idle child first".into()));
                    }
                }
                // Resolved after admission so a rejected call never creates a folder.
                let folder_id = match &a.folder {
                    Some(folder) => Some(
                        self.resolve_project_folder(&workspace, folder, a.create_folder)
                            .await?,
                    ),
                    None => None,
                };
                let context = match a.context {
                    Context::None => None,
                    Context::Briefing => {
                        Some(self.thread_briefing(&caller_workspace, parent).await?)
                    }
                    Context::TranscriptTail => Some(
                        self.thread_handoff(
                            &caller_workspace,
                            parent,
                            None,
                            Some(40),
                            Some(12_000),
                        )
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
                        handoff_from: context
                            .as_ref()
                            .filter(|_| workspace == caller_workspace)
                            .map(|_| falcondeck_core::ThreadHandoffSource {
                                thread_id: parent.into(),
                                provider: parent_summary.provider,
                                context_pending: true,
                            }),
                        handoff_context: if workspace == caller_workspace {
                            context.clone()
                        } else {
                            None
                        },
                    })
                    .await?;
                let id = handle.thread.id;
                if workspace != caller_workspace {
                    // A worker in another project carries a brief without
                    // pretending to be a native handoff inside that project.
                    if let Some(thread) = self
                        .inner
                        .workspaces
                        .lock()
                        .await
                        .get_mut(&workspace)
                        .and_then(|ws| ws.threads.get_mut(&id))
                    {
                        thread.pending_handoff_context = context;
                    }
                }
                self.with_thread_mut(&workspace, &id, |thread| {
                    thread.origin = Some(ThreadOrigin::AgentSpawn {
                        parent_thread_id: parent.into(),
                    });
                    thread.agent.reasoning_effort = a.reasoning_effort;
                })
                .await?;
                if let Some(title) = &a.title {
                    self.update_thread(serde_json::from_value(
                        json!({"workspace_id": workspace, "thread_id": id, "title": title.trim()}),
                    )?)
                    .await?;
                }
                if folder_id.is_some() {
                    self.update_preferences(falcondeck_core::UpdatePreferencesRequest {
                        project_folder: Some(falcondeck_core::ProjectFolderMutation {
                            workspace_id: workspace.clone(),
                            action: falcondeck_core::ProjectFolderAction::MoveThread {
                                thread_id: id.clone(),
                                folder_id,
                            },
                        }),
                        ..Default::default()
                    })
                    .await?;
                }
                if a.notify_parent || bot.is_some() {
                    self.watch_child(&workspace, &id, parent, a.notify_parent);
                }
                self.persist_local_state().await?;
                self.analytics_delegation(parent, &id, a.prompt.as_deref());
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
                if a.notify_parent {
                    markdown.push_str("- This thread will be notified when the child stops running or needs input.\n");
                } else if bot.is_some() {
                    markdown.push_str("- This thread will be notified only if the child fails or needs input; successful stops stay silent.\n");
                }
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

    /// A bot whose name matches, ignoring case, unless `name` is a thread id.
    async fn bot_named(&self, name: &str) -> Option<falcondeck_core::BotProfile> {
        let name = name.trim();
        let bot = self
            .inner
            .preferences
            .lock()
            .await
            .bots
            .iter()
            .find(|bot| bot.name.trim().eq_ignore_ascii_case(name))
            .cloned()?;
        self.thread_workspace(name).await.is_err().then_some(bot)
    }

    /// Project workspaces, most recently active first.
    async fn project_workspace_ids(&self) -> Vec<String> {
        let workspaces = self.inner.workspaces.lock().await;
        let mut projects: Vec<_> = workspaces
            .values()
            .filter(|ws| ws.summary.kind == falcondeck_core::WorkspaceKind::Project)
            .map(|ws| {
                let last = ws.threads.values().map(|t| t.summary.updated_at).max();
                (last, ws.summary.id.clone())
            })
            .collect();
        projects.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        projects.into_iter().map(|(_, id)| id).collect()
    }

    /// A workspace id, an exact project path, or a unique project folder name.
    async fn resolve_workspace(&self, wanted: &str) -> Result<String, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        if workspaces.contains_key(wanted) {
            return Ok(wanted.into());
        }
        let wanted = wanted.trim().trim_end_matches('/');
        let named: Vec<_> = workspaces
            .values()
            .filter(|ws| {
                ws.summary.path == wanted
                    || glance::project_name(&ws.summary.path).eq_ignore_ascii_case(wanted)
            })
            .collect();
        match named.as_slice() {
            [ws] => Ok(ws.summary.id.clone()),
            [] => Err(DaemonError::NotFound(format!(
                "no project matches {}",
                line(wanted, 120)
            ))),
            many => Err(DaemonError::BadRequest(format!(
                "{} is ambiguous; pass one of these paths: {}",
                line(wanted, 120),
                many.iter()
                    .map(|ws| line(&ws.summary.path, 160))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    /// The parent's title, last request and reply, and cached user excerpts.
    async fn thread_briefing(&self, workspace: &str, thread: &str) -> Result<String, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let managed = workspaces
            .get(workspace)
            .and_then(|ws| ws.threads.get(thread))
            .ok_or_else(|| DaemonError::NotFound("thread not found".into()))?;
        let index = self
            .inner
            .thread_search
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let excerpt = managed
            .summary
            .native_session_id
            .as_ref()
            .and_then(|id| index.sessions.get(id));
        let glance = glance::Glance::of(managed, excerpt);
        let mut text = format!(
            "## {}\n\n- Id: {}\n- Provider: {}\n",
            line(&managed.summary.title, 256),
            line(&managed.summary.id, 256),
            managed.summary.provider,
        );
        if let Some(excerpt) = excerpt {
            for message in excerpt.opening.iter().take(3) {
                text.push_str(&format!("- Opening user: {}\n", line(message, 400)));
            }
        }
        if let Some(asked) = &glance.asked {
            text.push_str(&format!("- Latest request: {}\n", line(asked, 400)));
        }
        if let Some(latest) = &glance.latest {
            text.push_str(&format!("- Latest reply: {}\n", line(latest, 400)));
        }
        text.push('\n');
        Ok(text)
    }

    async fn thread_handoff(
        &self,
        workspace: &str,
        thread: &str,
        before: Option<String>,
        limit: Option<usize>,
        cap: Option<usize>,
    ) -> Result<String, DaemonError> {
        read::view(
            self,
            workspace,
            thread,
            &read::ViewArgs {
                before,
                limit,
                max_chars: cap,
                ..Default::default()
            },
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use falcondeck_core::{ThreadAgentParams, ThreadAttention};
    use tempfile::tempdir;
    mod analytics_tests;
    mod bot_tests;
    mod digest_tests;
    mod model_settings_tests;

    #[test]
    fn detects_prose_with_dropped_word_spaces() {
        assert!(lost_word_spaces(
            "Reviewcleanonauth/errorfixes. ChatreviewfoundP2: jumpbuttonabsolute bottom-24relativetowholesectionoverlaps4+linedraft(composercangrow128+padding). Alsoobserveronlyinnercontentmaymissviewportshrinkfromcomposerresize. HoldingcommitwhileIverifyinbrowserwithmockednewmessage(nodatawrites). No sourceeditsyet."
        ));
        for ok in [
            "Please check the sync contract.",
            "Metadata rollout completed at 12:15:05 BST. Both read 2fbcb971bac7d718ec650b3322ebc4446f1e1b93, built on 2057025196 with only two changes.",
            "See /Users/James/.local/share/codex-artifacts/study-groups-2026-10-22/screenshots/final for the captures, then run `cargo test --package falcondeck-daemon thread_tools::tests::detects_prose_with_dropped_word_spaces` again.",
            "```\nconst veryLongIdentifierNameForTesting = anotherVeryLongIdentifierName();\n```\nThat is all.",
        ] {
            assert!(!lost_word_spaces(ok), "{ok}");
        }
    }
    pub(super) async fn fixture() -> (AppState, tempfile::TempDir) {
        let temp_dir = tempdir().unwrap();
        let workspace_path = temp_dir.path().join("project-a");
        std::fs::create_dir_all(&workspace_path).unwrap();
        let workspace_path = workspace_path.canonicalize().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::from([(
                AgentProvider::CLAUDE,
                temp_dir
                    .path()
                    .join("missing-claude-for-thread-tools-test")
                    .to_string_lossy()
                    .to_string(),
            )]),
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
        // Tools refresh a stale excerpt index; tests seed theirs directly.
        *app.inner.thread_search_scanned_at.lock().unwrap() = Some(std::time::Instant::now());

        (app, temp_dir)
    }
    pub(super) fn call(
        name: &str,
        arguments: Value,
    ) -> falcondeck_core::InvokeExtensionToolRequest {
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
    pub(super) fn created_id(result: &ExtensionToolResponse) -> String {
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
        for name in [LIST, VIEW, CREATE, MESSAGE, BUILTIN_RENAME_THREAD_TOOL] {
            assert!(
                app.extension_agent_tools()
                    .await
                    .tools
                    .iter()
                    .any(|t| t.name == name)
            );
        }
        {
            let mut workspaces = app.inner.workspaces.lock().await;
            let ws = workspaces.get_mut("workspace-1").unwrap();
            let mut summary = ws.threads["thread-1"].summary.clone();
            summary.id = "sibling".into();
            summary.native_session_id = Some("session-sibling".into());
            let mut sibling = ManagedThread::new(summary);
            sibling.items = vec![
                user("old", "older request stays out"),
                user("ask", "ship the fix"),
                assistant("latest", "latest loaded reply"),
            ];
            ws.threads.insert("sibling".into(), sibling);
        }
        app.inner.thread_search.lock().unwrap().sessions.insert(
            "session-sibling".into(),
            thread_search::SessionExcerpt {
                path: "/missing/transcript".into(),
                opening: vec!["opening goal".into()],
                recent: vec!["recent change".into()],
                latest_reply: Some("stale indexed reply".into()),
                ..Default::default()
            },
        );
        let result = app
            .invoke_extension_tool(call(LIST, json!({})))
            .await
            .unwrap();
        let text = result.result.as_str().unwrap();
        // Loaded items outrank the index; the caller never lists itself.
        assert!(
            text.contains("- **Auth setup** `sibling` — idle · 0s ago · claude\n  Asked: ship the fix\n  Latest: latest loaded reply\n"),
            "{text}"
        );
        for absent in [
            "`thread-1`",
            "older request",
            "stale indexed",
            "recent change",
        ] {
            assert!(!text.contains(absent), "{absent} in {text}");
        }
        let found = app
            .invoke_extension_tool(call(LIST, json!({"query":"opening GOAL"})))
            .await
            .unwrap();
        assert!(found.result.as_str().unwrap().contains("`sibling`"));
        let bounded = app
            .invoke_extension_tool(call(LIST, json!({"max_chars":512})))
            .await
            .unwrap();
        assert!(bounded.result.as_str().unwrap().chars().count() <= 512);
    }
    #[tokio::test]
    async fn message_queues_with_provenance_and_preserves_target_settings() {
        let (app, _temp) = fixture().await;
        let result = app
            .invoke_extension_tool(call(CREATE, json!({"model":"target-model"})))
            .await
            .unwrap();
        let id = created_id(&result);
        app.with_thread_mut("workspace-1", &id, |t| {
            t.status = ThreadStatus::Running;
        })
        .await
        .unwrap();
        for delivery in [None, Some("queue")] {
            let mut arguments = json!({"thread_id":id,"message":"Please check the sync contract."});
            if let Some(delivery) = delivery {
                arguments["delivery"] = json!(delivery);
            }
            let result = app
                .invoke_extension_tool(call(MESSAGE, arguments))
                .await
                .unwrap();
            assert!(result.result.as_str().unwrap().contains("Delivery: queued"));
        }
        let workspaces = app.inner.workspaces.lock().await;
        let target = &workspaces["workspace-1"].threads[&id];
        assert_eq!(target.queued_requests.len(), 2);
        for (queued, steer) in target.queued_requests.iter().zip([true, false]) {
            assert_eq!(queued.request.steer, steer);
            assert_eq!(
                queued.summary.text,
                "Message from FalconDeck thread thread-1 (Auth setup):\n\nPlease check the sync contract."
            );
            assert!(queued.request.provider.is_none());
            assert!(queued.request.model_id.is_none());
            assert!(queued.request.approval_policy.is_none());
            assert!(queued.request.permission_mode.is_none());
            assert!(queued.request.sandbox_mode.is_none());
        }
        assert_eq!(
            target.summary.agent.model_id.as_deref(),
            Some("target-model")
        );
    }

    #[tokio::test]
    async fn message_rejects_invalid_self_and_cross_workspace_targets() {
        let (app, _temp) = fixture().await;
        let (other, _other_temp) = fixture().await;
        let mut foreign = other
            .inner
            .workspaces
            .lock()
            .await
            .remove("workspace-1")
            .unwrap();
        foreign.summary.id = "workspace-2".into();
        let mut target = foreign.threads.remove("thread-1").unwrap();
        target.summary.id = "foreign-thread".into();
        target.summary.workspace_id = "workspace-2".into();
        foreign.threads.insert("foreign-thread".into(), target);
        app.inner
            .workspaces
            .lock()
            .await
            .insert("workspace-2".into(), foreign);
        for arguments in [
            json!({"thread_id":"thread-1","message":"self"}),
            json!({"thread_id":"foreign-thread","message":"cross workspace"}),
            json!({"thread_id":"missing","message":"missing target"}),
            json!({"thread_id":" ","message":"hello"}),
            json!({"thread_id":"foreign-thread","message":" "}),
            json!({"thread_id":"foreign-thread","message":"x".repeat(MAX_CHARS+1)}),
            json!({"thread_id":"foreign-thread","message":"hello","delivery":"interrupt"}),
            json!({"thread_id":"foreign-thread","message":"hello","approval_policy":"never"}),
        ] {
            assert!(
                app.invoke_extension_tool(call(MESSAGE, arguments))
                    .await
                    .is_err()
            );
        }
        let mut detached = call(
            MESSAGE,
            json!({"thread_id":"foreign-thread","message":"hello"}),
        );
        detached.thread_id = None;
        assert!(app.invoke_extension_tool(detached).await.is_err());
        let workspaces = app.inner.workspaces.lock().await;
        assert!(
            workspaces["workspace-2"].threads["foreign-thread"]
                .items
                .is_empty()
        );
        assert!(
            workspaces["workspace-2"].threads["foreign-thread"]
                .queued_requests
                .is_empty()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn message_dispatches_idle_then_steers_live_provider_input() {
        use std::os::unix::fs::PermissionsExt;
        let (app, temp) = fixture().await;
        let script = temp.path().join("fake-claude-message");
        let capture = temp.path().join("captured-messages");
        std::fs::write(&script, format!("#!/bin/sh\nwhile IFS= read -r input; do\nprintf '%s\\n' \"$input\" >> '{}'\ndone\n", capture.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = crate::claude::ClaudeRuntime::for_test(
            temp.path().to_string_lossy().into(),
            script.to_string_lossy().into(),
        );
        {
            let mut workspaces = app.inner.workspaces.lock().await;
            let ws = workspaces.get_mut("workspace-1").unwrap();
            ws.claude_runtime = Some(runtime.clone());
            ws.summary
                .agents
                .push(falcondeck_core::WorkspaceAgentSummary {
                    models_loading: false,
                    provider: AgentProvider::CLAUDE,
                    label: "Claude".into(),
                    account: Default::default(),
                    models: vec![],
                    collaboration_modes: vec![],
                    skills: vec![],
                    capabilities: falcondeck_core::AgentCapabilitySummary::claude(),
                });
        }
        let result = app
            .invoke_extension_tool(call(CREATE, json!({})))
            .await
            .unwrap();
        let id = created_id(&result);
        let result = app
            .invoke_extension_tool(call(
                MESSAGE,
                json!({"thread_id":id,"message":"First message"}),
            ))
            .await
            .unwrap();
        assert!(
            result
                .result
                .as_str()
                .unwrap()
                .contains("Delivery: turn started")
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !std::fs::read_to_string(&capture)
                .unwrap_or_default()
                .contains("First message")
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let result = app
            .invoke_extension_tool(call(
                MESSAGE,
                json!({"thread_id":id,"message":"Second message"}),
            ))
            .await
            .unwrap();
        assert!(
            result
                .result
                .as_str()
                .unwrap()
                .contains("Delivery: steered")
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !std::fs::read_to_string(&capture)
                .unwrap_or_default()
                .contains("Second message")
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let input = std::fs::read_to_string(&capture).unwrap();
        assert_eq!(input.lines().count(), 2);
        assert!(
            input
                .lines()
                .all(|line| line.contains("Message from FalconDeck thread thread-1 (Auth setup)"))
        );
        let workspaces = app.inner.workspaces.lock().await;
        let target = &workspaces["workspace-1"].threads[&id];
        assert!(target.queued_requests.is_empty());
        assert_eq!(
            target
                .items
                .iter()
                .filter(|item| matches!(item, ConversationItem::UserMessage { .. }))
                .count(),
            2
        );
        drop(workspaces);
        runtime.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn message_to_idle_thread_uses_normal_dispatch_and_propagates_failure() {
        let (app, _temp) = fixture().await;
        let result = app
            .invoke_extension_tool(call(CREATE, json!({})))
            .await
            .unwrap();
        let id = created_id(&result);
        // The missing executable proves this reached normal provider startup, rather than queueing.
        let error = app
            .invoke_extension_tool(call(
                MESSAGE,
                json!({"thread_id":id,"message":"Check this."}),
            ))
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("could not find the `claude` executable"),
            "{error}"
        );
        let workspaces = app.inner.workspaces.lock().await;
        let target = &workspaces["workspace-1"].threads[&id];
        assert!(target.queued_requests.is_empty());
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
        assert!(text.contains("## User") && text.contains("second") && text.contains("answer one"));
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
    async fn character_budget_pagination_keeps_every_unshown_message() {
        let (app, _temp) = fixture().await;
        let bodies: Vec<_> = (0..15)
            .map(|i| format!("message-{i}: {}", "x".repeat(500)))
            .collect();
        set_items(
            &app,
            bodies
                .iter()
                .enumerate()
                .map(|(i, body)| assistant(&format!("a{i}"), body))
                .collect(),
        )
        .await;
        let mut before = None;
        let mut seen = Vec::new();
        loop {
            let mut arguments = json!({"thread_id":"thread-1", "max_chars":1500});
            if let Some(cursor) = &before {
                arguments["before"] = json!(cursor);
            }
            let page = app
                .invoke_extension_tool(call(VIEW, arguments))
                .await
                .unwrap();
            let text = page.result.as_str().unwrap();
            assert!(text.chars().count() <= 1500);
            for (at, _) in text.match_indices("message-") {
                let id = text[at..].split(':').next().unwrap().to_string();
                assert!(!seen.contains(&id), "duplicate {id}");
                seen.push(id);
            }
            let next = text
                .split("Older: before=")
                .nth(1)
                .map(|rest| rest.split_whitespace().next().unwrap().to_string());
            let Some(next) = next else {
                break;
            };
            assert_ne!(before.as_ref(), Some(&next));
            before = Some(next);
        }
        assert_eq!(seen.len(), bodies.len());
        let page = app
            .invoke_extension_tool(call(VIEW, json!({"thread_id":"thread-1"})))
            .await
            .unwrap();
        assert!(page.result.as_str().unwrap().chars().count() <= 6000);
    }

    fn tool(id: &str, output: &str) -> ConversationItem {
        serde_json::from_value(json!({
            "kind":"tool_call", "id":id, "title":"exec", "tool_kind":"command", "output":output,
            "status":"completed", "created_at":Utc::now()
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn compact_view_skips_activity_and_preserves_message_pagination() {
        let (app, _temp) = fixture().await;
        let mut items = vec![
            user("u1", "original question"),
            assistant("a1", "first answer"),
        ];
        for i in 0..150 {
            items.push(tool(&format!("tool-{i}"), "NOISY TOOL OUTPUT"));
        }
        items.push(
            serde_json::from_value(json!({"kind":"reasoning", "id":"r1",
            "content":"PRIVATE REASONING", "created_at":Utc::now()}))
            .unwrap(),
        );
        items.push(assistant("a2", "final answer"));
        set_items(&app, items).await;
        let page = app
            .invoke_extension_tool(call(VIEW, json!({"thread_id":"thread-1","limit":2})))
            .await
            .unwrap();
        let text = page.result.as_str().unwrap();
        assert!(
            text.contains("first answer") && text.contains("final answer"),
            "{text}"
        );
        assert!(
            !text.contains("NOISY") && !text.contains("PRIVATE REASONING"),
            "{text}"
        );
        assert!(text.contains("before=a1"), "{text}");
        let older = app
            .invoke_extension_tool(call(VIEW, json!({"thread_id":"thread-1","before":"a1"})))
            .await
            .unwrap();
        assert!(older.result.as_str().unwrap().contains("original question"));
        let expanded = app
            .invoke_extension_tool(call(
                VIEW,
                json!({"thread_id":"thread-1", "include_tools":true,"include_reasoning":true}),
            ))
            .await
            .unwrap();
        assert!(
            expanded
                .result
                .as_str()
                .unwrap()
                .contains("NOISY TOOL OUTPUT")
        );
        assert!(
            expanded
                .result
                .as_str()
                .unwrap()
                .contains("PRIVATE REASONING")
        );
    }

    #[tokio::test]
    async fn search_finds_literal_matches_beyond_previews_and_reports_incomplete_scans() {
        let (app, _temp) = fixture().await;
        let body = format!("{} Needle.* 終", "🦅".repeat(15_000));
        let mut items = vec![user("u1", &body), tool("t1", &body)];
        for i in 0..1000 {
            items.push(assistant(&format!("a{i}"), "unrelated"));
        }
        set_items(&app, items).await;
        let page = app
            .invoke_extension_tool(call(
                VIEW,
                json!({"thread_id":"thread-1","query":"needle.*"}),
            ))
            .await
            .unwrap();
        let text = page.result.as_str().unwrap();
        assert!(
            text.contains("scanned 1000 items") && text.contains("before=a0"),
            "{text}"
        );
        assert!(
            text.contains("No matching messages in scanned history"),
            "{text}"
        );
        let page = app.invoke_extension_tool(call(VIEW, json!({"thread_id":"thread-1","before":"a0","query":"needle.*","include_tools":true}))).await.unwrap();
        let text = page.result.as_str().unwrap();
        assert!(
            text.contains("item_id=u1") && text.contains("item_id=t1"),
            "{text}"
        );
        assert_eq!(text.matches("Needle.* 終").count(), 2, "{text}");
        assert!(text.contains("No older items"), "{text}");
        assert!(text.chars().count() < 2000, "{}", text.chars().count());
    }

    #[tokio::test]
    async fn search_finds_commands_diffs_and_reasoning_summaries() {
        let (app, _temp) = fixture().await;
        let long_title = format!("{} unique_long_title_token", "x".repeat(120));
        set_items(
            &app,
            vec![
                serde_json::from_value(json!({
                    "kind": "diff",
                    "id": "d1",
                    "diff": "+++ unique_diff_token",
                    "created_at": Utc::now()
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "kind": "file_change",
                    "id": "f1",
                    "status": "completed",
                    "changes": [{
                        "path": "src/a.rs",
                        "change_kind": "update",
                        "diff": "fn unique_patch_token() {}"
                    }],
                    "created_at": Utc::now()
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "kind": "tool_call",
                    "id": "shell",
                    "title": "Shell",
                    "tool_kind": "command",
                    "status": "completed",
                    "output": "finished",
                    "detail": {
                        "kind": "command_execution",
                        "command": "cargo test unique_shell_command",
                        "cwd": "/tmp"
                    },
                    "created_at": Utc::now()
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "kind": "tool_call",
                    "id": "titled",
                    "title": "run unique-title-token please",
                    "tool_kind": "command",
                    "status": "completed",
                    "output": "ok",
                    "created_at": Utc::now()
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "kind": "tool_call",
                    "id": "long",
                    "title": long_title,
                    "tool_kind": "command",
                    "status": "completed",
                    "output": "done",
                    "created_at": Utc::now()
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "kind": "reasoning",
                    "id": "r1",
                    "content": "",
                    "summary": "secret_summary_token",
                    "created_at": Utc::now()
                }))
                .unwrap(),
                assistant("a-tail", "unrelated"),
            ],
        )
        .await;

        let find = async |query: &str, include_tools: bool, include_reasoning: bool| {
            app.invoke_extension_tool(call(
                VIEW,
                json!({
                    "thread_id": "thread-1",
                    "query": query,
                    "include_tools": include_tools,
                    "include_reasoning": include_reasoning,
                }),
            ))
            .await
            .unwrap()
            .result
            .as_str()
            .unwrap()
            .to_string()
        };
        let shell = find("unique_shell_command", true, false).await;
        assert!(
            shell.contains("item_id=shell") && shell.contains("cargo test unique_shell_command"),
            "{shell}"
        );
        let titled = find("unique-title-token", true, false).await;
        assert!(
            titled.contains("item_id=titled") && titled.contains("unique-title-token"),
            "{titled}"
        );
        let long = find("unique_long_title_token", true, false).await;
        assert!(
            long.contains("item_id=long") && long.contains("unique_long_title_token"),
            "{long}"
        );
        let diff = find("unique_diff_token", true, false).await;
        assert!(
            diff.contains("item_id=d1") && diff.contains("unique_diff_token"),
            "{diff}"
        );
        let patch = find("unique_patch_token", true, false).await;
        assert!(
            patch.contains("item_id=f1") && patch.contains("unique_patch_token"),
            "{patch}"
        );

        let summary = find("secret_summary_token", false, true).await;
        assert!(
            summary.contains("item_id=r1") && summary.contains("secret_summary_token"),
            "{summary}"
        );

        let expanded = app
            .invoke_extension_tool(call(VIEW, json!({"thread_id":"thread-1","item_id":"d1"})))
            .await
            .unwrap();
        let expanded = expanded.result.as_str().unwrap();
        assert!(expanded.contains("unique_diff_token"), "{expanded}");
        assert!(!expanded.contains("Diff omitted"), "{expanded}");
    }

    #[tokio::test]
    async fn view_lists_every_file_and_keeps_long_titles_visible() {
        let (app, _temp) = fixture().await;
        let hidden_diff = format!("unique_hidden_patch_token\n{}", "a".repeat(2500));
        let image_title = format!("{} unique_image_title", "y".repeat(120));
        let artifact_title = format!("{} unique_artifact_title", "z".repeat(120));
        set_items(
            &app,
            vec![
                serde_json::from_value(json!({
                    "kind": "file_change",
                    "id": "patch",
                    "status": "failed",
                    "changes": [
                        {
                            "path": "src/first.rs",
                            "change_kind": "update",
                            "diff": hidden_diff,
                        },
                        {
                            "path": "src/kept.rs",
                            "change_kind": "delete",
                            "diff": "",
                        },
                        {
                            "path": "src/old.rs",
                            "change_kind": "update",
                            "move_path": "src/renamed.rs",
                            "diff": "",
                        }
                    ],
                    "created_at": Utc::now()
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "kind": "image",
                    "id": "img1",
                    "title": image_title,
                    "image": {
                        "id": "asset1",
                        "name": "unique_image_file.png",
                        "url": "https://example.test/img.png",
                        "alt_text": "a screenshot"
                    },
                    "created_at": Utc::now()
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "kind": "artifact",
                    "id": "art1",
                    "artifact": {
                        "title": artifact_title,
                        "artifact_kind": "document",
                        "content": "plain body",
                        "payload": null
                    },
                    "created_at": Utc::now()
                }))
                .unwrap(),
            ],
        )
        .await;

        let listed = app
            .invoke_extension_tool(call(
                VIEW,
                json!({"thread_id":"thread-1","include_tools":true}),
            ))
            .await
            .unwrap();
        let listed = listed.result.as_str().unwrap();
        assert!(
            listed.contains("Files edited (failed)")
                && listed.contains("src/kept.rs")
                && listed.contains("delete")
                && listed.contains("src/old.rs -> src/renamed.rs")
                && listed.contains("unique_image_title")
                && listed.contains("unique_image_file.png")
                && listed.contains("unique_artifact_title"),
            "{listed}"
        );
        assert!(!listed.contains("unique_hidden_patch_token"), "{listed}");

        let found = app
            .invoke_extension_tool(call(
                VIEW,
                json!({
                    "thread_id": "thread-1",
                    "include_tools": true,
                    "query": "unique_hidden_patch_token"
                }),
            ))
            .await
            .unwrap();
        let found = found.result.as_str().unwrap();
        assert!(
            found.contains("item_id=patch") && found.contains("unique_hidden_patch_token"),
            "{found}"
        );

        let expanded = app
            .invoke_extension_tool(call(
                VIEW,
                json!({"thread_id":"thread-1","item_id":"patch"}),
            ))
            .await
            .unwrap();
        let expanded = expanded.result.as_str().unwrap();
        assert!(
            expanded.contains("unique_hidden_patch_token")
                && expanded.contains("src/kept.rs")
                && expanded.contains("src/renamed.rs"),
            "{expanded}"
        );
    }

    #[tokio::test]
    async fn item_expansion_pages_unicode_body_without_loss() {
        let (app, _temp) = fixture().await;
        let body = "🦅終abc".repeat(5000);
        set_items(&app, vec![tool("t1", &body)]).await;
        let mut offset = 0;
        let mut rebuilt = String::new();
        loop {
            let page = app.invoke_extension_tool(call(VIEW, json!({"thread_id":"thread-1", "item_id":"t1", "offset":offset,"max_chars":1000}))).await.unwrap();
            let text = page.result.as_str().unwrap();
            assert!(text.chars().count() <= 1000);
            let (_, section) = text.split_once("\n\n").unwrap();
            let (_, content) = section.split_once('\n').unwrap();
            let content = content
                .rsplit_once("\n[item_id=")
                .map_or(content, |(content, _)| content);
            rebuilt.push_str(content.trim_matches('…'));
            let next = text
                .split("offset=")
                .nth(1)
                .and_then(|value| value.split_whitespace().next())
                .and_then(|value| value.parse::<usize>().ok());
            let Some(next) = next else {
                break;
            };
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(rebuilt, body);
        for extra in [
            json!({"offset":1}),
            json!({"item_id":"t1","query":"abc"}),
            json!({"item_id":"t1","before":"t1"}),
            json!({"item_id":"t1","offset":30000}),
            json!({"query":" "}),
            json!({"query":"x".repeat(257)}),
        ] {
            let mut arguments = extra;
            arguments["thread_id"] = json!("thread-1");
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
        assert!(context.contains("## User") && context.contains("parent tail text"));
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
        ); // The fixture's configured Claude executable does not exist.
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
        let captured_args = temp.path().join("captured-args");
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/sh
printf '%s\n' "$@" > '{}'
IFS= read -r input
printf '%s' "$input" > '{}'
printf '%s\n' '{{"type":"result","subtype":"success","result":"done","session_id":"test-session"}}'
"#,
                captured_args.display(),
                capture.display()
            ),
        )
        .unwrap();
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
                json!({"provider":"claude", "reasoning_effort":"xhigh", "prompt":"do bounded work"}),
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
        let argv = std::fs::read_to_string(captured_args).unwrap();
        assert!(
            argv.lines()
                .collect::<Vec<_>>()
                .windows(2)
                .any(|args| args == ["--effort", "xhigh"])
        );
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
