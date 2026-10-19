//! Coordinator actions over existing daemon operations: organize, interrupt,
//! answer a child's question, a short bounded wait, and parent notifications.
use super::*;
use falcondeck_core::{
    InteractiveRequest, InteractiveRequestKind, InteractiveResponsePayload, ProjectFolderAction,
    ProjectFolderMutation, UpdatePreferencesRequest,
};

pub(super) const ORGANIZE: &str = "falcondeck_organize_thread";
pub(super) const INTERRUPT: &str = "falcondeck_interrupt_thread";
pub(super) const ANSWER: &str = "falcondeck_answer_question";
pub(super) const WAIT: &str = "falcondeck_wait_thread";
/// Stays under the bridge's 30-second HTTP timeout.
const MAX_WAIT_SECS: u64 = 25;
const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(250);
/// Fixed from the first completion so a busy event stream cannot postpone delivery.
const CHILD_NOTICE_WINDOW: std::time::Duration = std::time::Duration::from_millis(500);

pub(super) fn is_action(name: &str) -> bool {
    matches!(name, ORGANIZE | INTERRUPT | ANSWER | WAIT)
}

type Entry = (
    &'static str,
    &'static str,
    &'static str,
    Value,
    Vec<&'static str>,
);

pub(super) fn catalog() -> Vec<Entry> {
    vec![
        (
            WAIT,
            "Wait for thread",
            "Wait up to wait_seconds (default 20, max 25) for a thread in this workspace to stop running, then report its status, last preview/error, and pending requests with the request and question ids falcondeck_answer_question needs. For longer work, create children with notify_parent instead of polling.",
            json!({
                "thread_id": {"type":"string", "minLength":1},
                "wait_seconds": {"type":"integer", "minimum":0, "maximum":MAX_WAIT_SECS, "default":20}
            }),
            vec!["thread_id"],
        ),
        (
            ORGANIZE,
            "Organize thread",
            "Archive/unarchive, pin (global or within the project) or unpin, and move a thread in this workspace to a project folder by id or exact name (null returns it to the project root). Archiving does not stop a running turn.",
            json!({
                "thread_id": {"type":"string", "minLength":1},
                "archived": {"type":"boolean"},
                "pin": {"type":"string", "enum":["none","global","project"]},
                "folder": {"type":["string","null"], "minLength":1, "description":"Folder id or exact name; null moves the thread to the project root."},
                "create_folder": {"type":"boolean", "default":false, "description":"Create the named folder when no folder matches."}
            }),
            vec!["thread_id"],
        ),
        (
            INTERRUPT,
            "Interrupt thread",
            "Stop the running turn of another thread in this workspace, as the Stop button does. Queued messages stay queued and may start next.",
            json!({
                "thread_id": {"type":"string", "minLength":1}
            }),
            vec!["thread_id"],
        ),
        (
            ANSWER,
            "Answer question",
            "Answer a pending question from a thread this thread created. Approvals, plan approvals, credential prompts, and secret questions stay in FalconDeck UI. Read request and question ids with falcondeck_wait_thread.",
            json!({
                "thread_id": {"type":"string", "minLength":1},
                "request_id": {"type":"string", "minLength":1, "description":"Optional when exactly one question request is pending."},
                "answers": {"type":"object", "minProperties":1, "description":"Question id -> answer text or list of selected option labels.",
                    "additionalProperties": {"anyOf":[{"type":"string","minLength":1},{"type":"array","minItems":1,"items":{"type":"string","minLength":1}}]}}
            }),
            vec!["thread_id", "answers"],
        ),
    ]
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Pin {
    None,
    Global,
    Project,
}

fn explicit<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OrganizeArgs {
    thread_id: String,
    archived: Option<bool>,
    pin: Option<Pin>,
    #[serde(default, deserialize_with = "explicit")]
    folder: Option<Option<String>>,
    #[serde(default)]
    create_folder: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArgs {
    thread_id: String,
    wait_seconds: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InterruptArgs {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Answer {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnswerArgs {
    thread_id: String,
    request_id: Option<String>,
    answers: HashMap<String, Answer>,
}

/// One child whose settles are reported to its parent; in memory only.
pub(crate) struct ChildWatch {
    workspace_id: String,
    parent_thread_id: String,
    busy: bool,
    waiting_notified: bool,
}

#[derive(Clone, Copy)]
enum Settle {
    Waiting,
    Finished,
}

struct ChildNoticeBatch {
    deadline: tokio::time::Instant,
    children: Vec<(String, Settle)>,
}

type ChildNoticeBatches = HashMap<(String, String), ChildNoticeBatch>;

fn status_name(status: &ThreadStatus) -> &'static str {
    match status {
        ThreadStatus::Idle => "idle",
        ThreadStatus::Running => "running",
        ThreadStatus::WaitingForInput => "waiting_for_input",
        ThreadStatus::Error => "error",
    }
}

/// A question blocks the queue, so waiting for input outranks queued messages.
fn is_busy(thread: &ThreadSummary) -> bool {
    match thread.status {
        ThreadStatus::Running => true,
        ThreadStatus::WaitingForInput => false,
        _ => !thread.queued_turns.is_empty(),
    }
}

fn is_child_of(thread: &ThreadSummary, parent: &str) -> bool {
    matches!(&thread.origin, Some(ThreadOrigin::AgentSpawn { parent_thread_id, .. }) if parent_thread_id == parent)
}

/// Approvals stay in FalconDeck UI; so do MCP elicitations and secret answers.
fn answerable(request: &InteractiveRequest) -> Result<(), &'static str> {
    if request.kind != InteractiveRequestKind::Question {
        return Err("approvals and plan approvals stay in FalconDeck UI");
    }
    if conversation_helpers::is_mcp_elicitation_method(&request.method) {
        return Err("MCP server prompts stay in FalconDeck UI");
    }
    if request.questions.iter().any(|q| q.is_secret) {
        return Err("secret questions must be answered by the user in FalconDeck UI");
    }
    Ok(())
}

fn pending_markdown(requests: &[InteractiveRequest]) -> String {
    if requests.is_empty() {
        return String::new();
    }
    let mut text = String::from("\n## Pending requests\n\n");
    for request in requests.iter().take(10) {
        let kind = match request.kind {
            InteractiveRequestKind::Approval => "approval",
            InteractiveRequestKind::Question => "question",
            InteractiveRequestKind::PlanApproval => "plan approval",
        };
        let handling = match answerable(request) {
            Ok(()) => "answerable by the creating thread with falcondeck_answer_question",
            Err(reason) => reason,
        };
        text.push_str(&format!(
            "- Request {} | {kind} | {} ({handling})\n",
            line(&request.request_id, 256),
            line(&request.title, 200)
        ));
        if let Some(command) = &request.command {
            text.push_str(&format!("  - Command: {}\n", line(command, 300)));
        }
        for question in request.questions.iter().take(10) {
            text.push_str(&format!(
                "  - Question {}: {} — {}\n",
                line(&question.id, 128),
                line(&question.header, 80),
                line(&question.question, 400)
            ));
            if let Some(options) = &question.options {
                let labels: Vec<_> = options
                    .iter()
                    .take(12)
                    .map(|o| line(&o.label, 80))
                    .collect();
                text.push_str(&format!("    - Options: {}\n", labels.join("; ")));
            }
        }
    }
    text
}

impl AppState {
    pub(super) async fn invoke_thread_action(
        &self,
        name: &str,
        arguments: &Value,
        workspace: &str,
        parent: &str,
    ) -> Result<ExtensionToolResponse, DaemonError> {
        match name {
            WAIT => {
                let a: WaitArgs = args(arguments)?;
                let wait = a.wait_seconds.unwrap_or(20).min(MAX_WAIT_SECS);
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait);
                let (thread, waited) = loop {
                    let thread = self.thread_summary(workspace, &a.thread_id).await?;
                    if !is_busy(&thread) || tokio::time::Instant::now() >= deadline {
                        break (thread, wait > 0);
                    }
                    tokio::time::sleep(WAIT_POLL).await;
                };
                let mut text = format!(
                    "# Thread status\n\n- Id: {}\n- Title: {}\n- Status: {}\n- Queued messages: {}\n- Archived: {}\n- Last preview: {}\n",
                    line(&thread.id, 256),
                    line(&thread.title, 256),
                    status_name(&thread.status),
                    thread.queued_turns.len(),
                    thread.is_archived,
                    line(thread.last_message_preview.as_deref().unwrap_or(""), 600)
                );
                if let Some(error) = &thread.last_error {
                    text.push_str(&format!("- Last error: {}\n", line(error, 600)));
                }
                if is_child_of(&thread, parent) {
                    text.push_str("- Created by this thread\n");
                }
                if waited && is_busy(&thread) {
                    text.push_str(
                        "- Still running after the wait; check again or rely on notify_parent.\n",
                    );
                }
                text.push_str(&pending_markdown(
                    &self.pending_thread_requests(workspace, &thread.id).await,
                ));
                Ok(response(text))
            }
            ORGANIZE => {
                let a: OrganizeArgs = args(arguments)?;
                if a.archived.is_none() && a.pin.is_none() && a.folder.is_none() {
                    return Err(DaemonError::BadRequest(
                        "supply at least one of archived, pin, or folder".into(),
                    ));
                }
                self.thread_summary(workspace, &a.thread_id).await?;
                if let Some(folder) = &a.folder {
                    let folder_id = match folder {
                        None => None,
                        Some(name) => Some(
                            self.resolve_project_folder(workspace, name, a.create_folder)
                                .await?,
                        ),
                    };
                    self.update_preferences(UpdatePreferencesRequest {
                        project_folder: Some(ProjectFolderMutation {
                            workspace_id: workspace.into(),
                            action: ProjectFolderAction::MoveThread {
                                thread_id: a.thread_id.clone(),
                                folder_id,
                            },
                        }),
                        ..Default::default()
                    })
                    .await?;
                }
                if let Some(pin) = a.pin {
                    let (pinned, pinned_in_project) = match pin {
                        Pin::None => (false, false),
                        Pin::Global => (true, false),
                        Pin::Project => (false, true),
                    };
                    self.update_thread(serde_json::from_value(json!({
                        "workspace_id": workspace, "thread_id": a.thread_id,
                        "pinned": pinned, "pinned_in_project": pinned_in_project
                    }))?)
                    .await?;
                }
                match a.archived {
                    Some(true) => drop(self.archive_thread(workspace, &a.thread_id).await?),
                    Some(false) => drop(self.unarchive_thread(workspace, &a.thread_id).await?),
                    None => {}
                }
                let thread = self.thread_summary(workspace, &a.thread_id).await?;
                let folder = self
                    .inner
                    .preferences
                    .lock()
                    .await
                    .project_folders
                    .iter()
                    .find(|f| f.workspace_id == workspace && f.thread_ids.contains(&thread.id))
                    .map(|f| line(&f.name, 128))
                    .unwrap_or_else(|| "project root".into());
                let pin = match (thread.is_pinned, thread.is_pinned_in_project) {
                    (true, _) => "global",
                    (false, true) => "project",
                    _ => "none",
                };
                Ok(response(format!(
                    "# Thread organized\n\n- Id: {}\n- Archived: {}\n- Pin: {pin}\n- Folder: {folder}\n",
                    line(&thread.id, 256),
                    thread.is_archived
                )))
            }
            INTERRUPT => {
                let a: InterruptArgs = args(arguments)?;
                if a.thread_id == parent {
                    return Err(DaemonError::BadRequest(
                        "cannot interrupt the calling thread".into(),
                    ));
                }
                let thread = self.thread_summary(workspace, &a.thread_id).await?;
                if !matches!(
                    thread.status,
                    ThreadStatus::Running | ThreadStatus::WaitingForInput
                ) {
                    return Err(DaemonError::BadRequest(format!(
                        "thread is {}, not running",
                        status_name(&thread.status)
                    )));
                }
                self.interrupt_turn(workspace.into(), a.thread_id.clone())
                    .await?;
                Ok(response(format!(
                    "# Interrupt requested\n\n- Id: {}\n- Queued messages: {}\n- Confirm with falcondeck_wait_thread.\n",
                    line(&a.thread_id, 256),
                    thread.queued_turns.len()
                )))
            }
            ANSWER => {
                let a: AnswerArgs = args(arguments)?;
                let thread = self.thread_summary(workspace, &a.thread_id).await?;
                if !is_child_of(&thread, parent) {
                    return Err(DaemonError::BadRequest(
                        "only threads created by this thread can be answered; other questions stay with the user in FalconDeck UI".into(),
                    ));
                }
                let pending = self.pending_thread_requests(workspace, &a.thread_id).await;
                let request = match &a.request_id {
                    Some(id) => pending.iter().find(|r| &r.request_id == id),
                    None => {
                        let mut questions = pending
                            .iter()
                            .filter(|r| r.kind == InteractiveRequestKind::Question);
                        match (questions.next(), questions.next()) {
                            (Some(only), None) => Some(only),
                            (Some(_), Some(_)) => {
                                return Err(DaemonError::BadRequest(
                                    "several questions are pending; pass request_id".into(),
                                ));
                            }
                            _ => None,
                        }
                    }
                }
                .ok_or_else(|| DaemonError::NotFound("no matching pending question".into()))?;
                answerable(request).map_err(|reason| DaemonError::BadRequest(reason.into()))?;
                let answers = a
                    .answers
                    .into_iter()
                    .map(|(id, answer)| {
                        let values = match answer {
                            Answer::One(value) => vec![value],
                            Answer::Many(values) => values,
                        };
                        (id, values)
                    })
                    .collect();
                // Validation of ids and non-empty answers is the shared UI path's.
                self.respond_to_interactive_request(
                    workspace.into(),
                    request.request_id.clone(),
                    InteractiveResponsePayload::Question { answers },
                )
                .await?;
                Ok(response(format!(
                    "# Question answered\n\n- Id: {}\n- Request: {}\n",
                    line(&a.thread_id, 256),
                    line(&request.request_id, 256)
                )))
            }
            _ => unreachable!(),
        }
    }

    async fn pending_thread_requests(
        &self,
        workspace: &str,
        thread: &str,
    ) -> Vec<InteractiveRequest> {
        let mut requests: Vec<_> = self
            .inner
            .interactive_requests
            .lock()
            .await
            .iter()
            .filter(|((ws, _), p)| {
                ws == workspace && p.request.thread_id.as_deref() == Some(thread)
            })
            .map(|(_, p)| p.request.clone())
            .collect();
        requests.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        requests
    }

    pub(super) async fn resolve_project_folder(
        &self,
        workspace: &str,
        name: &str,
        create: bool,
    ) -> Result<String, DaemonError> {
        let name = name.trim();
        let find = |folders: &[falcondeck_core::ProjectFolder]| {
            let mut ids = folders
                .iter()
                .filter(|f| f.workspace_id == workspace)
                .filter(|f| f.id == name || f.name.trim().eq_ignore_ascii_case(name));
            match (ids.next(), ids.next()) {
                (Some(folder), None) => Ok(Some(folder.id.clone())),
                (Some(_), Some(_)) => Err(DaemonError::BadRequest(
                    "folder name is ambiguous; pass the folder id".into(),
                )),
                _ => Ok(None),
            }
        };
        if let Some(id) = find(&self.inner.preferences.lock().await.project_folders)? {
            return Ok(id);
        }
        if !create {
            let names: Vec<_> = self
                .inner
                .preferences
                .lock()
                .await
                .project_folders
                .iter()
                .filter(|f| f.workspace_id == workspace)
                .take(30)
                .map(|f| format!("{} ({})", line(&f.name, 80), f.id))
                .collect();
            return Err(DaemonError::NotFound(format!(
                "folder not found; pass create_folder: true to create it. Folders: {}",
                if names.is_empty() {
                    "none".into()
                } else {
                    names.join(", ")
                }
            )));
        }
        let updated = self
            .update_preferences(UpdatePreferencesRequest {
                project_folder: Some(ProjectFolderMutation {
                    workspace_id: workspace.into(),
                    action: ProjectFolderAction::Create { name: name.into() },
                }),
                ..Default::default()
            })
            .await?;
        find(&updated.project_folders)?
            .ok_or_else(|| DaemonError::NotFound("created folder was not found".into()))
    }

    /// Registers a child before its first dispatch; the watcher subscribes
    /// synchronously so the child's first status change cannot be missed.
    pub(super) fn watch_child(&self, workspace: &str, child: &str, parent: &str) {
        let mut watches = self
            .inner
            .agent_spawn_watches
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if watches.is_none() {
            self.spawn_child_watcher();
        }
        watches.get_or_insert_with(HashMap::new).insert(
            child.into(),
            ChildWatch {
                workspace_id: workspace.into(),
                parent_thread_id: parent.into(),
                busy: false,
                waiting_notified: false,
            },
        );
    }

    fn spawn_child_watcher(&self) {
        let mut events = self.subscribe();
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            let mut batches = ChildNoticeBatches::new();
            loop {
                let deadline = batches.values().map(|batch| batch.deadline).min();
                let event = tokio::select! {
                    biased;
                    _ = async {
                        match deadline {
                            Some(deadline) => tokio::time::sleep_until(deadline).await,
                            None => std::future::pending::<()>().await,
                        }
                    } => None,
                    event = events.recv() => Some(event),
                };
                let Some(inner) = inner.upgrade() else { return };
                let app = AppState { inner };
                match event {
                    None => {
                        let now = tokio::time::Instant::now();
                        let ready: Vec<_> = batches
                            .iter()
                            .filter(|(_, batch)| batch.deadline <= now)
                            .map(|(key, _)| key.clone())
                            .collect();
                        for (workspace, parent) in ready {
                            if let Some(batch) =
                                batches.remove(&(workspace.clone(), parent.clone()))
                            {
                                let app = app.clone();
                                tokio::spawn(async move {
                                    app.notify_parent(&workspace, &parent, &batch.children)
                                        .await;
                                });
                            }
                        }
                    }
                    Some(Ok(envelope)) => {
                        if let UnifiedEvent::ThreadUpdated { thread } = &envelope.event {
                            app.observe_child(thread, &mut batches);
                        }
                    }
                    Some(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                        let watched: Vec<_> = app
                            .inner
                            .agent_spawn_watches
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .iter()
                            .flatten()
                            .map(|(id, w)| (w.workspace_id.clone(), id.clone()))
                            .collect();
                        for (workspace, id) in watched {
                            if let Ok(thread) = app.thread_summary(&workspace, &id).await {
                                app.observe_child(&thread, &mut batches);
                            }
                        }
                    }
                    Some(Err(tokio::sync::broadcast::error::RecvError::Closed)) => return,
                }
            }
        });
    }

    fn observe_child(&self, thread: &ThreadSummary, batches: &mut ChildNoticeBatches) {
        let settle = {
            let mut watches = self
                .inner
                .agent_spawn_watches
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let Some(watch) = watches.as_mut().and_then(|w| w.get_mut(&thread.id)) else {
                return;
            };
            if watch.workspace_id != thread.workspace_id {
                return;
            }
            let settle = if is_busy(thread) {
                watch.busy = true;
                watch.waiting_notified = false;
                None
            } else if thread.status == ThreadStatus::WaitingForInput {
                watch.busy = true;
                (!std::mem::replace(&mut watch.waiting_notified, true)).then_some(Settle::Waiting)
            } else {
                watch.waiting_notified = false;
                std::mem::replace(&mut watch.busy, false).then_some(Settle::Finished)
            };
            settle.map(|s| (s, watch.parent_thread_id.clone()))
        };
        if let Some((settle, parent)) = settle {
            let batch = batches
                .entry((thread.workspace_id.clone(), parent))
                .or_insert_with(|| ChildNoticeBatch {
                    deadline: tokio::time::Instant::now() + CHILD_NOTICE_WINDOW,
                    children: Vec::new(),
                });
            if let Some((_, previous)) = batch.children.iter_mut().find(|(id, _)| id == &thread.id)
            {
                *previous = settle;
            } else {
                batch.children.push((thread.id.clone(), settle));
            }
            // Questions and approvals must not wait behind completion batching.
            if matches!(settle, Settle::Waiting) {
                batch.deadline = tokio::time::Instant::now();
            }
        }
    }

    async fn notify_parent(&self, workspace: &str, parent: &str, children: &[(String, Settle)]) {
        if self.is_shutting_down() {
            return;
        }
        if self
            .thread_summary(workspace, parent)
            .await
            .map_or(true, |p| p.is_archived)
        {
            return;
        }
        let mut text = String::new();
        for (id, settle) in children {
            let Ok(child) = self.thread_summary(workspace, id).await else {
                continue;
            };
            // A child can resume while its completion is being batched. Read the
            // latest summary for both status and preview instead of sending stale data.
            if is_busy(&child)
                || (child.status == ThreadStatus::WaitingForInput)
                    != matches!(settle, Settle::Waiting)
            {
                continue;
            }
            let event = match child.status {
                ThreadStatus::WaitingForInput => "needs input",
                ThreadStatus::Error => "failed (error)",
                _ => "stopped (idle)",
            };
            text.push_str(&format!(
                "- {}: {event} [{}]\n",
                line(&child.title, 160),
                line(&child.id, 256),
            ));
            if let Some(preview) = child
                .last_message_preview
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                text.push_str(&format!("  Preview: {}\n", line(preview, 400)));
            }
            if let Some(error) = child
                .last_error
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                text.push_str(&format!("  Error: {}\n", line(error, 600)));
            }
            text.push_str(&pending_markdown(
                &self.pending_thread_requests(workspace, &child.id).await,
            ));
        }
        if text.is_empty() {
            return;
        }
        let text = format!(
            "FalconDeck child updates (daemon):\n\n{text}\nDetails: falcondeck_view_thread.\n"
        );
        let request = serde_json::from_value::<SendTurnRequest>(json!({
            "workspace_id": workspace, "thread_id": parent,
            "inputs": [{"type":"text","text":text}], "steer": false
        }));
        let result = match request {
            Ok(request) => self.send_turn(request).await,
            Err(error) => Err(error.into()),
        };
        if let Err(error) = result {
            tracing::warn!(%error, %workspace, %parent, "failed to notify parent thread");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{call, created_id, fixture};
    use super::*;
    use falcondeck_core::{InteractiveQuestion, InteractiveQuestionOption};

    fn text(result: ExtensionToolResponse) -> String {
        result.result.as_str().unwrap().to_string()
    }

    async fn child(app: &AppState, extra: Value) -> String {
        let mut arguments = json!({});
        arguments
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        created_id(
            &app.invoke_extension_tool(call(super::super::CREATE, arguments))
                .await
                .unwrap(),
        )
    }

    async fn set_status(app: &AppState, id: &str, status: ThreadStatus) {
        app.with_thread_mut("workspace-1", id, |t| t.status = status)
            .await
            .unwrap();
        let thread = app.thread_summary("workspace-1", id).await.unwrap();
        app.emit(
            Some("workspace-1".into()),
            Some(id.into()),
            UnifiedEvent::ThreadUpdated { thread },
        );
    }

    async fn queued_notices(app: &AppState, parent: &str) -> Vec<String> {
        app.inner.workspaces.lock().await["workspace-1"].threads[parent]
            .queued_requests
            .iter()
            .map(|q| q.summary.text.clone())
            .collect()
    }

    async fn wait_for_notices(app: &AppState, parent: &str, count: usize) -> Vec<String> {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let notices = queued_notices(app, parent).await;
                if notices.len() >= count {
                    break notices;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("parent should receive child notices")
    }

    async fn add_request(
        app: &AppState,
        thread: &str,
        id: &str,
        kind: InteractiveRequestKind,
        secret: bool,
    ) {
        let request = InteractiveRequest {
            request_id: id.into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some(thread.into()),
            method: "item/tool/requestUserInput".into(),
            kind,
            approval_decisions: None,
            approval_options: None,
            title: format!("Request {id}"),
            detail: None,
            command: None,
            path: None,
            turn_id: None,
            item_id: None,
            questions: vec![InteractiveQuestion {
                id: "q1".into(),
                header: "Database".into(),
                question: "Which database?".into(),
                is_other: false,
                is_secret: secret,
                options: Some(vec![InteractiveQuestionOption {
                    label: "Postgres".into(),
                    description: String::new(),
                }]),
            }],
            created_at: Utc::now(),
        };
        app.inner.interactive_requests.lock().await.insert(
            ("workspace-1".into(), id.into()),
            PendingServerRequest {
                raw_id: json!(id),
                request,
                params: json!({}),
            },
        );
    }

    #[tokio::test]
    async fn catalog_publishes_actions_with_qualifiable_names() {
        let (app, _temp) = fixture().await;
        let tools = app.extension_agent_tools().await.tools;
        for name in [ORGANIZE, INTERRUPT, ANSWER, WAIT] {
            assert!(name.len() <= 41 && !name.contains("__"));
            assert!(tools.iter().any(|t| t.name == name), "{name}");
        }
    }

    #[tokio::test]
    async fn organize_moves_pins_and_archives_through_existing_operations() {
        let (app, _temp) = fixture().await;
        let id = child(&app, json!({})).await;
        let missing = app
            .invoke_extension_tool(call(ORGANIZE, json!({"thread_id":id,"folder":"Release"})))
            .await
            .unwrap_err();
        assert!(missing.to_string().contains("create_folder"), "{missing}");
        assert!(
            app.invoke_extension_tool(call(ORGANIZE, json!({"thread_id":id})))
                .await
                .is_err()
        );
        let result = text(
            app.invoke_extension_tool(call(
                ORGANIZE,
                json!({"thread_id":id,"folder":"Release","create_folder":true,"pin":"project","archived":true}),
            ))
            .await
            .unwrap(),
        );
        assert!(
            result.contains("Archived: true")
                && result.contains("Pin: project")
                && result.contains("Folder: Release"),
            "{result}"
        );
        let summary = app.thread_summary("workspace-1", &id).await.unwrap();
        assert!(summary.is_archived && summary.is_pinned_in_project && !summary.is_pinned);
        // Exact-name matching is case-insensitive and does not duplicate the folder.
        app.invoke_extension_tool(call(
            ORGANIZE,
            json!({"thread_id":"thread-1","folder":"release","create_folder":true}),
        ))
        .await
        .unwrap();
        assert_eq!(app.inner.preferences.lock().await.project_folders.len(), 1);
        let result = text(
            app.invoke_extension_tool(call(
                ORGANIZE,
                json!({"thread_id":id,"folder":null,"pin":"global","archived":false}),
            ))
            .await
            .unwrap(),
        );
        assert!(
            result.contains("Archived: false")
                && result.contains("Pin: global")
                && result.contains("Folder: project root"),
            "{result}"
        );
    }

    #[tokio::test]
    async fn create_applies_title_and_folder() {
        let (app, _temp) = fixture().await;
        assert!(
            app.invoke_extension_tool(call(super::super::CREATE, json!({"folder":"Missing"})))
                .await
                .is_err()
        );
        assert!(
            app.inner.workspaces.lock().await["workspace-1"]
                .threads
                .len()
                == 1
        );
        let id = child(
            &app,
            json!({"title":"  Sync audit ","folder":"Audits","create_folder":true}),
        )
        .await;
        assert_eq!(
            app.thread_summary("workspace-1", &id).await.unwrap().title,
            "Sync audit"
        );
        let preferences = app.inner.preferences.lock().await;
        assert_eq!(preferences.project_folders[0].name, "Audits");
        assert_eq!(preferences.project_folders[0].thread_ids, vec![id]);
    }

    #[tokio::test]
    async fn interrupt_rejects_self_and_threads_that_are_not_running() {
        let (app, _temp) = fixture().await;
        let id = child(&app, json!({})).await;
        for target in ["thread-1", id.as_str(), "missing"] {
            assert!(
                app.invoke_extension_tool(call(INTERRUPT, json!({"thread_id":target})))
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn answer_is_limited_to_children_and_plain_questions() {
        let (app, _temp) = fixture().await;
        let id = child(&app, json!({})).await;
        // Questions in threads the caller did not create stay with the user.
        add_request(
            &app,
            "thread-1",
            "parent-q",
            InteractiveRequestKind::Question,
            false,
        )
        .await;
        let mut other = call(
            ANSWER,
            json!({"thread_id":"thread-1","answers":{"q1":"Postgres"}}),
        );
        other.thread_id = Some(id.clone());
        assert!(
            app.invoke_extension_tool(other)
                .await
                .unwrap_err()
                .to_string()
                .contains("only threads created")
        );
        add_request(
            &app,
            &id,
            "approval",
            InteractiveRequestKind::Approval,
            false,
        )
        .await;
        add_request(&app, &id, "secret", InteractiveRequestKind::Question, true).await;
        for (request, needle) in [("approval", "FalconDeck UI"), ("secret", "secret")] {
            let error = app
                .invoke_extension_tool(call(
                    ANSWER,
                    json!({"thread_id":id,"request_id":request,"answers":{"q1":"x"}}),
                ))
                .await
                .unwrap_err();
            assert!(error.to_string().contains(needle), "{error}");
        }
        add_request(&app, &id, "plain", InteractiveRequestKind::Question, false).await;
        let wait = text(
            app.invoke_extension_tool(call(WAIT, json!({"thread_id":id,"wait_seconds":0})))
                .await
                .unwrap(),
        );
        assert!(
            wait.contains("Request plain | question") && wait.contains("Question q1: Database") && wait.contains("Options: Postgres")
                && wait.contains("Request approval | approval | Request approval (approvals and plan approvals stay in FalconDeck UI)"),
            "{wait}"
        );
        // Two plain-question requests would be ambiguous; with one, request_id is optional.
        app.inner
            .interactive_requests
            .lock()
            .await
            .remove(&("workspace-1".to_string(), "secret".to_string()));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.inner
            .claude_approvals
            .lock()
            .await
            .insert(("workspace-1".into(), "plain".into()), sender);
        let result = text(
            app.invoke_extension_tool(call(
                ANSWER,
                json!({"thread_id":id,"answers":{"q1":["Postgres"]}}),
            ))
            .await
            .unwrap(),
        );
        assert!(result.contains("Request: plain"), "{result}");
        match receiver.await.unwrap() {
            crate::claude::ClaudeHookReply::QuestionAnswers(answers) => {
                assert_eq!(answers["q1"], vec!["Postgres".to_string()])
            }
            _ => panic!("expected question answers"),
        }
    }

    #[tokio::test]
    async fn wait_returns_once_the_thread_stops_running() {
        let (app, _temp) = fixture().await;
        let id = child(&app, json!({})).await;
        set_status(&app, &id, ThreadStatus::Running).await;
        let running = text(
            app.invoke_extension_tool(call(WAIT, json!({"thread_id":id,"wait_seconds":0})))
                .await
                .unwrap(),
        );
        assert!(
            running.contains("Status: running") && running.contains("Created by this thread"),
            "{running}"
        );
        let settle = {
            let app = app.clone();
            let id = id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                set_status(&app, &id, ThreadStatus::Idle).await;
            })
        };
        let started = std::time::Instant::now();
        let idle = text(
            app.invoke_extension_tool(call(WAIT, json!({"thread_id":id,"wait_seconds":5})))
                .await
                .unwrap(),
        );
        settle.await.unwrap();
        assert!(
            idle.contains("Status: idle") && !idle.contains("Still running"),
            "{idle}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
    }

    #[tokio::test]
    async fn waiting_for_input_outranks_queued_messages() {
        let (app, _temp) = fixture().await;
        let mut thread = app.thread_summary("workspace-1", "thread-1").await.unwrap();
        thread.queued_turns.push(
            serde_json::from_value(json!({"id":"q","preview":"later","queued_at":Utc::now()}))
                .unwrap(),
        );
        thread.status = ThreadStatus::WaitingForInput;
        assert!(!is_busy(&thread));
        thread.status = ThreadStatus::Idle;
        assert!(is_busy(&thread));
    }

    #[tokio::test]
    async fn notify_parent_batches_nearby_completions_with_compact_previews() {
        let (app, _temp) = fixture().await;
        let first = child(&app, json!({"notify_parent":true,"title":"Layouts"})).await;
        let second = child(&app, json!({"notify_parent":true,"title":"Copy"})).await;
        app.with_thread_mut("workspace-1", "thread-1", |t| {
            t.status = ThreadStatus::Running
        })
        .await
        .unwrap();
        app.with_thread_mut("workspace-1", &second, |t| {
            t.last_message_preview = Some(" \n ".into());
        })
        .await
        .unwrap();
        for id in [&first, &second] {
            set_status(&app, id, ThreadStatus::Running).await;
            set_status(&app, id, ThreadStatus::Idle).await;
            set_status(&app, id, ThreadStatus::Idle).await;
        }
        // The final preview can arrive after the status event that started the batch.
        app.with_thread_mut("workspace-1", &first, |t| {
            t.last_message_preview = Some("Created six layouts.".into());
        })
        .await
        .unwrap();
        let notices = wait_for_notices(&app, "thread-1", 1).await;
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert_eq!(
            notices[0],
            format!(
                "FalconDeck child updates (daemon):\n\n- Layouts: stopped (idle) [{first}]\n  Preview: Created six layouts.\n- Copy: stopped (idle) [{second}]\n\nDetails: falcondeck_view_thread."
            )
        );
        let workspaces = app.inner.workspaces.lock().await;
        let queued = &workspaces["workspace-1"].threads["thread-1"].queued_requests;
        assert!(!queued[0].request.steer);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn notify_parent_wakes_idle_parent_with_one_batched_turn() {
        use std::os::unix::fs::PermissionsExt;
        let (app, temp) = fixture().await;
        let script = temp.path().join("fake-claude-notice");
        let capture = temp.path().join("captured-notice");
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
        // A coordinating parent already has a loaded transcript. The generic
        // fixture's placeholder native id has no corresponding history file.
        app.push_conversation_item(
            "workspace-1",
            "thread-1",
            ConversationItem::UserMessage {
                id: "request-1".into(),
                text: "Delegate layouts and copy.".into(),
                attachments: Vec::new(),
                turn_id: None,
                previous_turn_id: None,
                created_at: Utc::now(),
            },
            false,
        )
        .await
        .unwrap();
        let first = child(&app, json!({"notify_parent":true})).await;
        let second = child(&app, json!({"notify_parent":true})).await;
        for id in [&first, &second] {
            set_status(&app, id, ThreadStatus::Running).await;
            set_status(&app, id, ThreadStatus::Idle).await;
        }
        let input = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(input) = std::fs::read_to_string(&capture)
                    && serde_json::from_str::<Value>(&input).is_ok()
                {
                    break input;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("child completion should dispatch a parent turn");
        assert!(input.contains(&first) && input.contains(&second), "{input}");
        assert_eq!(
            input.matches("FalconDeck child updates (daemon):").count(),
            1
        );
        assert!(queued_notices(&app, "thread-1").await.is_empty());
        runtime.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn notify_parent_queues_one_notice_per_settle() {
        let (app, _temp) = fixture().await;
        let watched = child(&app, json!({"notify_parent":true})).await;
        let silent = child(&app, json!({})).await;
        // A running parent queues notices instead of dispatching to the missing CLI.
        app.with_thread_mut("workspace-1", "thread-1", |t| {
            t.status = ThreadStatus::Running
        })
        .await
        .unwrap();
        // An idle update before any run is not a completion.
        set_status(&app, &watched, ThreadStatus::Idle).await;
        add_request(
            &app,
            &watched,
            "question-1",
            InteractiveRequestKind::Question,
            false,
        )
        .await;
        for status in [
            ThreadStatus::Running,
            ThreadStatus::WaitingForInput,
            ThreadStatus::WaitingForInput,
        ] {
            set_status(&app, &watched, status.clone()).await;
            set_status(&app, &silent, status).await;
        }
        let waiting = wait_for_notices(&app, "thread-1", 1).await;
        assert!(waiting[0].contains("needs input"), "{waiting:?}");
        assert!(
            waiting[0].contains("question-1") && waiting[0].contains("Question q1:"),
            "{waiting:?}"
        );
        assert!(
            waiting[0].contains("falcondeck_answer_question"),
            "{waiting:?}"
        );
        app.inner
            .interactive_requests
            .lock()
            .await
            .remove(&("workspace-1".into(), "question-1".into()));
        for status in [
            ThreadStatus::Running,
            ThreadStatus::Idle,
            ThreadStatus::Idle,
        ] {
            set_status(&app, &watched, status.clone()).await;
            set_status(&app, &silent, status).await;
        }
        let queued = wait_for_notices(&app, "thread-1", 2).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let all = app.inner.workspaces.lock().await["workspace-1"].threads["thread-1"]
            .queued_requests
            .len();
        assert_eq!(all, 2, "{queued:?}");
        assert!(
            queued.iter().any(|t| t.contains("needs input")),
            "{queued:?}"
        );
        assert!(
            queued.iter().any(|t| t.contains("stopped (idle)")),
            "{queued:?}"
        );
        assert!(
            queued
                .iter()
                .all(|t| t.contains(&watched) && !t.contains(&silent))
        );
        assert!(
            queued
                .iter()
                .all(|t| t.starts_with("FalconDeck child updates (daemon):"))
        );
        set_status(&app, &watched, ThreadStatus::Running).await;
        set_status(&app, &watched, ThreadStatus::Idle).await;
        assert_eq!(wait_for_notices(&app, "thread-1", 3).await.len(), 3);
    }

    #[tokio::test]
    async fn notify_parent_skips_resumed_children_and_reports_later_errors() {
        let (app, _temp) = fixture().await;
        let watched = child(&app, json!({"notify_parent":true})).await;
        app.with_thread_mut("workspace-1", "thread-1", |t| {
            t.status = ThreadStatus::Running
        })
        .await
        .unwrap();
        set_status(&app, &watched, ThreadStatus::Running).await;
        set_status(&app, &watched, ThreadStatus::Idle).await;
        set_status(&app, &watched, ThreadStatus::Running).await;
        tokio::time::sleep(CHILD_NOTICE_WINDOW * 2).await;
        assert!(queued_notices(&app, "thread-1").await.is_empty());

        app.with_thread_mut("workspace-1", &watched, |t| {
            t.last_error = Some("Build failed.".into());
        })
        .await
        .unwrap();
        set_status(&app, &watched, ThreadStatus::Error).await;
        let notices = wait_for_notices(&app, "thread-1", 1).await;
        assert!(notices[0].contains("failed (error)"), "{notices:?}");
        assert!(notices[0].contains("Error: Build failed."), "{notices:?}");
        assert!(!notices[0].contains("Preview:"), "{notices:?}");
    }

    #[tokio::test]
    async fn notify_parent_keeps_batches_separate_for_each_parent() {
        let (app, _temp) = fixture().await;
        let first = child(&app, json!({"notify_parent":true})).await;
        let second = child(&app, json!({"notify_parent":true})).await;
        app.with_thread_mut("workspace-1", "thread-1", |t| {
            t.status = ThreadStatus::Running
        })
        .await
        .unwrap();
        let mut other_parent = app.thread_summary("workspace-1", "thread-1").await.unwrap();
        other_parent.id = "other-parent".into();
        app.inner
            .workspaces
            .lock()
            .await
            .get_mut("workspace-1")
            .unwrap()
            .threads
            .insert(
                "other-parent".into(),
                super::super::super::ManagedThread::new(other_parent),
            );
        app.watch_child("workspace-1", &second, "other-parent");
        for id in [&first, &second] {
            set_status(&app, id, ThreadStatus::Running).await;
            set_status(&app, id, ThreadStatus::Idle).await;
        }
        let first_notices = wait_for_notices(&app, "thread-1", 1).await;
        let second_notices = wait_for_notices(&app, "other-parent", 1).await;
        assert!(first_notices[0].contains(&first) && !first_notices[0].contains(&second));
        assert!(second_notices[0].contains(&second) && !second_notices[0].contains(&first));
    }

    #[tokio::test]
    async fn child_batches_keep_the_first_deadline_and_flush_for_input() {
        let (app, _temp) = fixture().await;
        let first = child(&app, json!({"notify_parent":true})).await;
        let second = child(&app, json!({"notify_parent":true})).await;
        let mut thread = app.thread_summary("workspace-1", &first).await.unwrap();
        let mut batches = ChildNoticeBatches::new();
        let key = ("workspace-1".into(), "thread-1".into());
        thread.status = ThreadStatus::Running;
        app.observe_child(&thread, &mut batches);
        thread.status = ThreadStatus::Idle;
        app.observe_child(&thread, &mut batches);
        let first_deadline = batches[&key].deadline;
        // Multiple runs of one child within the window still produce one row.
        thread.status = ThreadStatus::Running;
        app.observe_child(&thread, &mut batches);
        thread.status = ThreadStatus::Idle;
        app.observe_child(&thread, &mut batches);
        assert_eq!(batches[&key].children.len(), 1);
        assert_eq!(batches[&key].deadline, first_deadline);

        thread.id = second;
        thread.status = ThreadStatus::WaitingForInput;
        app.observe_child(&thread, &mut batches);
        assert_eq!(batches[&key].children.len(), 2);
        assert!(batches[&key].deadline < first_deadline);
        assert!(batches[&key].deadline <= tokio::time::Instant::now());
    }

    #[tokio::test]
    async fn notify_parent_suppresses_resolved_input_and_archived_or_shutdown_parents() {
        let (app, _temp) = fixture().await;
        let watched = child(&app, json!({"notify_parent":true})).await;
        app.with_thread_mut("workspace-1", "thread-1", |t| {
            t.status = ThreadStatus::Running
        })
        .await
        .unwrap();
        // An input notification overtaken by completion must not become a second stop notice.
        app.notify_parent(
            "workspace-1",
            "thread-1",
            &[(watched.clone(), Settle::Waiting)],
        )
        .await;
        assert!(queued_notices(&app, "thread-1").await.is_empty());

        app.with_thread_mut("workspace-1", "thread-1", |t| t.is_archived = true)
            .await
            .unwrap();
        app.notify_parent(
            "workspace-1",
            "thread-1",
            &[(watched.clone(), Settle::Finished)],
        )
        .await;
        assert!(queued_notices(&app, "thread-1").await.is_empty());

        app.with_thread_mut("workspace-1", "thread-1", |t| t.is_archived = false)
            .await
            .unwrap();
        app.inner
            .shutting_down
            .store(true, std::sync::atomic::Ordering::Release);
        app.notify_parent("workspace-1", "thread-1", &[(watched, Settle::Finished)])
            .await;
        assert!(queued_notices(&app, "thread-1").await.is_empty());
    }
}
