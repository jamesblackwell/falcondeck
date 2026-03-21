use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader as StdBufReader},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use chrono::Utc;
use falcondeck_core::{
    AccountStatus, AccountSummary, AgentProvider, CollaborationModeSummary, ConversationItem,
    ImageInput, ModelSummary, ReasoningEffortSummary, ThreadAgentParams, ThreadAttention,
    ThreadPlan, ThreadStatus, ThreadSummary, ToolCallDisplay,
};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::{timeout, Duration},
};
use tracing::warn;

use crate::agent_binary::{missing_binary_message, resolve_agent_binary};
use crate::skills::canonical_skill_alias;
use crate::{app::AppState, error::DaemonError};

mod session_file;
mod thread_list;

use session_file::hydrate_thread_items_from_session_file;
use thread_list::{parse_collaboration_modes, parse_models, parse_threads};

pub struct CodexBootstrap {
    pub session: Arc<CodexSession>,
    pub account: AccountSummary,
    pub models: Vec<ModelSummary>,
    pub collaboration_modes: Vec<CollaborationModeSummary>,
    pub threads: Vec<HydratedThread>,
}

pub struct CodexProviderMetadata {
    pub account: AccountSummary,
    pub models: Vec<ModelSummary>,
    pub collaboration_modes: Vec<CollaborationModeSummary>,
}

struct ParsedThreadRecord {
    summary: ThreadSummary,
    session_path: Option<String>,
}

pub struct HydratedThread {
    pub summary: ThreadSummary,
    pub items: Vec<ConversationItem>,
}

pub struct CodexSession {
    workspace_id: String,
    workspace_path: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, DaemonError>>>>,
    state: AppState,
}

impl CodexSession {
    pub async fn connect(
        workspace_id: String,
        workspace_path: String,
        codex_bin: String,
        state: AppState,
    ) -> Result<CodexBootstrap, DaemonError> {
        let resolved = resolve_agent_binary("codex", &codex_bin);
        let mut child = Command::new(&resolved.executable)
            .arg("app-server")
            .current_dir(PathBuf::from(&workspace_path))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    let message = missing_binary_message(
                        "Codex",
                        "codex",
                        &resolved.diagnostics,
                        "Install Codex in a standard location or relaunch FalconDeck after your shell PATH is set up.",
                    );
                    return DaemonError::Process(message);
                }
                DaemonError::Process(format!("failed to start codex app-server: {error}"))
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| DaemonError::Process("failed to acquire codex stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| DaemonError::Process("failed to acquire codex stdout".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| DaemonError::Process("failed to acquire codex stderr".to_string()))?;

        let session = Arc::new(Self {
            workspace_id: workspace_id.clone(),
            workspace_path: workspace_path.clone(),
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            state: state.clone(),
        });

        {
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                session.read_stdout(stdout).await;
            });
        }

        {
            let state = state.clone();
            let workspace_id = workspace_id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let message = line.trim().to_string();
                    if message.is_empty() {
                        continue;
                    }
                    let _ = state.emit_service(
                        Some(workspace_id.clone()),
                        None,
                        falcondeck_core::ServiceLevel::Info,
                        message,
                        Some("stderr".to_string()),
                    );
                }
            });
        }

        session
            .send_request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "falcondeck",
                        "title": "FalconDeck",
                        "version": "0.1.0"
                    },
                    "capabilities": {
                        "experimentalApi": true
                    }
                }),
            )
            .await?;
        session.send_notification("initialized", json!({})).await?;

        let account_value = session.send_request("account/read", json!({})).await?;
        let account = parse_account(&account_value);
        let models_value = session.send_request("model/list", json!({})).await?;
        let models = parse_models(&models_value);
        let collaboration_modes_value = session
            .send_request("collaborationMode/list", json!({}))
            .await
            .unwrap_or(Value::Null);
        let collaboration_modes = parse_collaboration_modes(&collaboration_modes_value);
        let threads_value = session
            .send_request(
                "thread/list",
                json!({
                    "limit": 100,
                    "sourceKinds": [
                        "cli",
                        "vscode",
                        "appServer",
                        "subAgentReview",
                        "subAgentCompact",
                        "subAgentThreadSpawn",
                        "unknown"
                    ]
                }),
            )
            .await?;
        let thread_records = parse_threads(&workspace_id, &workspace_path, &threads_value);
        let mut threads = Vec::with_capacity(thread_records.len());
        for record in thread_records {
            let ParsedThreadRecord {
                summary,
                session_path,
            } = record;
            let (summary, items) = match session.read_thread(&summary.id).await {
                Ok(value) => {
                    let mut items = hydrate_thread_items(&value);
                    if items.is_empty() {
                        if let Some(path) =
                            extract_thread_session_path(&value).or(session_path.clone())
                        {
                            items = hydrate_thread_items_from_session_file(&path, &workspace_path);
                        }
                    }
                    (hydrate_thread_summary(summary, &value, &items), items)
                }
                Err(error) => {
                    warn!("failed to read codex thread {}: {error}", summary.id);
                    let items = session_path
                        .as_deref()
                        .map(|path| hydrate_thread_items_from_session_file(path, &workspace_path))
                        .unwrap_or_default();
                    let summary = hydrate_thread_summary(summary, &Value::Null, &items);
                    (summary, items)
                }
            };
            threads.push(HydratedThread { summary, items });
        }

        Ok(CodexBootstrap {
            session,
            account,
            models,
            collaboration_modes,
            threads,
        })
    }

    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    pub async fn provider_metadata(&self) -> Result<CodexProviderMetadata, DaemonError> {
        let account_value = self.send_request("account/read", json!({})).await?;
        let models_value = self.send_request("model/list", json!({})).await?;
        let collaboration_modes_value = self
            .send_request("collaborationMode/list", json!({}))
            .await
            .unwrap_or(Value::Null);

        Ok(CodexProviderMetadata {
            account: parse_account(&account_value),
            models: parse_models(&models_value),
            collaboration_modes: parse_collaboration_modes(&collaboration_modes_value),
        })
    }

    pub async fn shutdown(&self) -> Result<(), DaemonError> {
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
        Ok(())
    }

    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, DaemonError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        let line = serde_json::to_vec(&payload)?;

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(&line).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
        }

        rx.await
            .map_err(|_| DaemonError::Rpc(format!("rpc channel closed for method {method}")))?
    }

    pub async fn send_notification(&self, method: &str, params: Value) -> Result<(), DaemonError> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        let line = serde_json::to_vec(&payload)?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn read_thread(&self, thread_id: &str) -> Result<Value, DaemonError> {
        self.send_request("thread/read", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn resume_thread(&self, thread_id: &str) -> Result<Value, DaemonError> {
        self.send_request("thread/resume", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn respond_to_request(
        &self,
        raw_id: Value,
        result: Value,
    ) -> Result<(), DaemonError> {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": raw_id,
            "result": result
        });
        let line = serde_json::to_vec(&payload)?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn read_stdout(self: Arc<Self>, stdout: tokio::process::ChildStdout) {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }

                    match serde_json::from_str::<Value>(&line) {
                        Ok(message) => {
                            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                                if message.get("method").is_none() {
                                    if let Some(tx) = self.pending.lock().await.remove(&id) {
                                        if let Some(error) = message.get("error") {
                                            let _ =
                                                tx.send(Err(DaemonError::Rpc(error.to_string())));
                                        } else {
                                            let _ = tx.send(Ok(message
                                                .get("result")
                                                .cloned()
                                                .unwrap_or(Value::Null)));
                                        }
                                    }
                                    continue;
                                }
                            }

                            if let Some(method) = message.get("method").and_then(Value::as_str) {
                                let params = message.get("params").cloned().unwrap_or(Value::Null);
                                if message.get("id").is_some() {
                                    if let Some(raw_id) = message.get("id").cloned() {
                                        if let Err(error) = self
                                            .state
                                            .ingest_server_request(
                                                &self.workspace_id,
                                                raw_id,
                                                method,
                                                params,
                                            )
                                            .await
                                        {
                                            warn!(
                                                "failed to ingest server request {method}: {error}"
                                            );
                                        }
                                    }
                                } else if let Err(error) = self
                                    .state
                                    .ingest_notification(&self.workspace_id, method, params)
                                    .await
                                {
                                    warn!("failed to ingest notification {method}: {error}");
                                }
                            }
                        }
                        Err(error) => {
                            warn!("failed to parse codex message: {error}");
                            let _ = self.state.emit_service(
                                Some(self.workspace_id.clone()),
                                None,
                                falcondeck_core::ServiceLevel::Warning,
                                format!("Unparseable Codex message: {line}"),
                                Some("parse-error".to_string()),
                            );
                        }
                    }
                }
                Ok(None) => {
                    let _ = self.state.emit_service(
                        Some(self.workspace_id.clone()),
                        None,
                        falcondeck_core::ServiceLevel::Warning,
                        "Codex app-server disconnected".to_string(),
                        Some("disconnect".to_string()),
                    );
                    break;
                }
                Err(error) => {
                    warn!("codex stdout read error: {error}");
                    let _ = self.state.emit_service(
                        Some(self.workspace_id.clone()),
                        None,
                        falcondeck_core::ServiceLevel::Error,
                        format!("Codex stream error: {error}"),
                        Some("stream-error".to_string()),
                    );
                    break;
                }
            }
        }

        let _ = self.child.lock().await.wait().await;
    }
}

pub fn parse_account(value: &Value) -> AccountSummary {
    let account = value.get("account").and_then(Value::as_object);
    let requires_auth = value
        .get("requiresOpenaiAuth")
        .or_else(|| value.get("requires_openai_auth"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let email = value
        .get("email")
        .or_else(|| account.and_then(|account| account.get("email")))
        .and_then(Value::as_str)
        .map(str::to_string);

    if let Some(email) = email {
        return AccountSummary {
            status: AccountStatus::Ready,
            label: email,
        };
    }

    let auth_type = account
        .and_then(|account| account.get("type"))
        .and_then(Value::as_str)
        .map(str::to_string);

    if let Some(auth_type) = auth_type {
        return AccountSummary {
            status: AccountStatus::Ready,
            label: format!("Signed in ({auth_type})"),
        };
    }

    if requires_auth {
        return AccountSummary {
            status: AccountStatus::NeedsAuth,
            label: "OpenAI login required".to_string(),
        };
    }

    AccountSummary {
        status: AccountStatus::Unknown,
        label: "Account status unknown".to_string(),
    }
}

fn extract_thread_record(value: &Value) -> Option<&Value> {
    fn walk(value: &Value) -> Option<&Value> {
        if value
            .as_object()
            .is_some_and(|record| record.contains_key("turns"))
        {
            return Some(value);
        }

        if let Some(thread) = value.get("thread") {
            if let Some(found) = walk(thread) {
                return Some(found);
            }
        }

        if let Some(object) = value.as_object() {
            for key in ["result", "data", "items", "results"] {
                if let Some(nested) = object.get(key) {
                    if let Some(array) = nested.as_array() {
                        for entry in array {
                            if let Some(found) = walk(entry) {
                                return Some(found);
                            }
                        }
                    } else if let Some(found) = walk(nested) {
                        return Some(found);
                    }
                }
            }
        }

        None
    }

    walk(value)
}

fn hydrate_thread_items(value: &Value) -> Vec<ConversationItem> {
    let Some(thread) = extract_thread_record(value) else {
        return Vec::new();
    };
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut items = Vec::new();
    for turn in turns {
        let turn_items = turn
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for item in turn_items {
            if let Some(converted) = build_conversation_item_from_thread_item(&item) {
                items.push(converted);
            }
        }
    }

    items
}

fn extract_thread_session_path(value: &Value) -> Option<String> {
    extract_thread_record(value).and_then(|thread| extract_string(thread, &["path"]))
}

fn hydrate_thread_summary(
    mut summary: ThreadSummary,
    value: &Value,
    items: &[ConversationItem],
) -> ThreadSummary {
    if summary.native_session_id.is_none() {
        summary.native_session_id = Some(summary.id.clone());
    }

    if let Some(last_message) = items.iter().rev().find_map(|item| match item {
        ConversationItem::AssistantMessage { text, .. }
        | ConversationItem::UserMessage { text, .. } => Some(text.clone()),
        _ => None,
    }) {
        summary.last_message_preview = Some(truncate_preview(&last_message));
    }

    if let Some(last_tool) = items.iter().rev().find_map(|item| match item {
        ConversationItem::ToolCall { title, .. } => Some(title.clone()),
        _ => None,
    }) {
        summary.last_tool = Some(last_tool);
    }

    if let Some(last_error) = items.iter().rev().find_map(|item| match item {
        ConversationItem::ToolCall { status, output, .. }
            if status.eq_ignore_ascii_case("error") =>
        {
            Some(output.clone().unwrap_or_else(|| "Tool failed".to_string()))
        }
        ConversationItem::Service {
            level: falcondeck_core::ServiceLevel::Error,
            message,
            ..
        } => Some(message.clone()),
        _ => None,
    }) {
        summary.last_error = Some(last_error);
    }

    if let Some(thread) = extract_thread_record(value) {
        let turns = thread
            .get("turns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(last_turn) = turns.last() {
            summary.latest_turn_id = extract_string(last_turn, &["id"]);
            if let Some(status) = extract_string(last_turn, &["status"]) {
                summary.status = thread_status_from_turn_status(&status);
            }
            if let Some(updated_at) = extract_datetime_or_timestamp(
                last_turn,
                &["completedAt", "completed_at", "startedAt", "started_at"],
            ) {
                summary.updated_at = updated_at;
            } else if let Some(updated_at) =
                items.iter().filter_map(conversation_item_created_at).max()
            {
                summary.updated_at = updated_at;
            }
        } else if let Some(updated_at) = items.iter().filter_map(conversation_item_created_at).max()
        {
            summary.updated_at = updated_at;
        }
    }

    summary
}

fn thread_status_from_turn_status(status: &str) -> ThreadStatus {
    match status.trim().to_ascii_lowercase().as_str() {
        "inprogress" | "in_progress" | "running" => ThreadStatus::Running,
        "error" | "failed" => ThreadStatus::Error,
        _ => ThreadStatus::Idle,
    }
}

fn build_conversation_item_from_thread_item(item: &Value) -> Option<ConversationItem> {
    let id = extract_string(item, &["id"])?;
    let item_type = extract_string(item, &["type"])?;
    let created_at =
        extract_datetime(item, &["createdAt", "created_at", "timestamp"]).unwrap_or_else(Utc::now);

    match item_type.as_str() {
        "userMessage" => {
            let content = item
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let (text, attachments) = parse_user_message_content(&id, &content);
            Some(ConversationItem::UserMessage {
                id,
                text,
                attachments,
                created_at,
            })
        }
        "agentMessage" => Some(ConversationItem::AssistantMessage {
            id,
            text: extract_string(item, &["text"]).unwrap_or_default(),
            created_at,
        }),
        "reasoning" => Some(ConversationItem::Reasoning {
            id,
            summary: thread_item_text(item.get("summary")),
            content: thread_item_text(item.get("content")).unwrap_or_default(),
            created_at,
        }),
        "commandExecution" | "fileChange" | "webSearch" | "imageView" | "contextCompaction" => {
            let output = extract_string(item, &["output", "stdout", "result", "detail", "query"]);
            Some(ConversationItem::ToolCall {
                id,
                title: thread_tool_title(&item_type),
                tool_kind: item_type.clone(),
                status: extract_string(item, &["status"])
                    .unwrap_or_else(|| "completed".to_string()),
                output,
                exit_code: item
                    .get("exitCode")
                    .or_else(|| item.get("exit_code"))
                    .and_then(Value::as_i64)
                    .map(|value| value as i32),
                display: ToolCallDisplay::default(),
                created_at,
                completed_at: extract_datetime_or_timestamp(item, &["completedAt", "completed_at"]),
            })
        }
        "enteredReviewMode" | "exitedReviewMode" => Some(ConversationItem::Service {
            id,
            level: falcondeck_core::ServiceLevel::Info,
            message: if item_type == "enteredReviewMode" {
                "Review mode enabled".to_string()
            } else {
                "Review mode completed".to_string()
            },
            created_at,
        }),
        _ => None,
    }
}

fn response_item_message_text(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter_map(|entry| {
                    let entry_type = extract_string(entry, &["type"])?;
                    match entry_type.as_str() {
                        "output_text" | "input_text" | "text" => extract_string(entry, &["text"]),
                        _ => None,
                    }
                })
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn session_entry_attachments(payload: &Value) -> Vec<ImageInput> {
    let mut attachments = Vec::new();

    if let Some(images) = payload.get("images").and_then(Value::as_array) {
        for (index, image) in images.iter().enumerate() {
            if let Some(url) = image.as_str().filter(|value| !value.is_empty()) {
                attachments.push(ImageInput {
                    id: format!("session-image-{index}"),
                    name: None,
                    mime_type: None,
                    url: url.to_string(),
                    local_path: None,
                });
            }
        }
    }

    if let Some(images) = payload.get("local_images").and_then(Value::as_array) {
        for (index, image) in images.iter().enumerate() {
            if let Some(path) = image.as_str().filter(|value| !value.is_empty()) {
                attachments.push(ImageInput {
                    id: format!("session-local-image-{index}"),
                    name: None,
                    mime_type: None,
                    url: path.to_string(),
                    local_path: Some(path.to_string()),
                });
            }
        }
    }

    attachments
}

fn extract_cwd(value: &Value) -> Option<String> {
    value
        .get("payload")
        .and_then(|payload| payload.get("cwd"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn parse_user_message_content(item_id: &str, content: &[Value]) -> (String, Vec<ImageInput>) {
    let mut text_parts = Vec::new();
    let mut attachments = Vec::new();

    for (index, entry) in content.iter().enumerate() {
        let Some(item_type) = extract_string(entry, &["type"]) else {
            continue;
        };
        match item_type.as_str() {
            "text" => {
                if let Some(text) = extract_string(entry, &["text"]) {
                    text_parts.push(text);
                }
            }
            "image" | "localImage" => {
                let local_path = extract_string(entry, &["path"]).filter(|value| !value.is_empty());
                let url = extract_string(entry, &["url", "value", "data", "source"])
                    .or_else(|| local_path.clone())
                    .unwrap_or_default();
                if !url.is_empty() {
                    attachments.push(ImageInput {
                        id: format!("{item_id}-image-{index}"),
                        name: extract_string(entry, &["name"]),
                        mime_type: extract_string(entry, &["mimeType", "mime_type"]),
                        url,
                        local_path,
                    });
                }
            }
            "skill" => {
                if let Some(name) = extract_string(entry, &["name"]) {
                    text_parts.push(canonical_skill_alias(&name));
                }
            }
            _ => {}
        }
    }

    (text_parts.join(" ").trim().to_string(), attachments)
}

fn extract_datetime(value: &Value, keys: &[&str]) -> Option<chrono::DateTime<Utc>> {
    let raw = extract_string(value, keys)?;
    chrono::DateTime::parse_from_rfc3339(&raw)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()
}

pub(crate) fn extract_datetime_or_timestamp(
    value: &Value,
    keys: &[&str],
) -> Option<chrono::DateTime<Utc>> {
    extract_datetime(value, keys).or_else(|| extract_unix_timestamp(value, keys))
}

fn extract_unix_timestamp(value: &Value, keys: &[&str]) -> Option<chrono::DateTime<Utc>> {
    let raw = keys.iter().find_map(|key| value.get(*key))?;
    let value = raw.as_i64()?;
    let (seconds, nanos) = if value >= 1_000_000_000_000 {
        (value / 1000, ((value % 1000) * 1_000_000) as u32)
    } else {
        (value, 0)
    };
    chrono::DateTime::<Utc>::from_timestamp(seconds, nanos)
}

fn thread_item_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        let trimmed = text.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    if let Some(parts) = value.as_array() {
        let joined = parts
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return (!joined.is_empty()).then_some(joined);
    }
    None
}

fn thread_tool_title(item_type: &str) -> String {
    match item_type {
        "commandExecution" => "Command execution",
        "fileChange" => "File change",
        "webSearch" => "Web search",
        "imageView" => "Image view",
        "contextCompaction" => "Context compaction",
        _ => "Tool",
    }
    .to_string()
}

fn truncate_preview(text: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 96;
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX_PREVIEW_CHARS {
        return trimmed.to_string();
    }
    let preview = trimmed.chars().take(MAX_PREVIEW_CHARS).collect::<String>();
    format!("{preview}...")
}

fn conversation_item_created_at(item: &ConversationItem) -> Option<chrono::DateTime<Utc>> {
    Some(match item {
        ConversationItem::UserMessage { created_at, .. }
        | ConversationItem::AssistantMessage { created_at, .. }
        | ConversationItem::Reasoning { created_at, .. }
        | ConversationItem::ToolCall { created_at, .. }
        | ConversationItem::Plan { created_at, .. }
        | ConversationItem::Diff { created_at, .. }
        | ConversationItem::Service { created_at, .. }
        | ConversationItem::InteractiveRequest { created_at, .. } => *created_at,
    })
}

pub fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .get("threadId")
        .or_else(|| value.get("thread_id"))
        .or_else(|| value.get("id"))
        .or_else(|| value.get("thread").and_then(|thread| thread.get("id")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn extract_thread_title(value: &Value) -> Option<String> {
    value
        .get("title")
        .or_else(|| value.get("name"))
        .or_else(|| value.get("threadName"))
        .or_else(|| value.get("thread_name"))
        .or_else(|| value.get("thread").and_then(|thread| thread.get("title")))
        .or_else(|| value.get("thread").and_then(|thread| thread.get("name")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn extract_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn parse_thread_plan(value: &Value) -> Option<ThreadPlan> {
    let explanation = extract_string(value, &["explanation"]);
    let plan = value.get("plan").and_then(Value::as_array)?;
    let steps = plan
        .iter()
        .filter_map(|entry| {
            let step = extract_string(entry, &["step"])?;
            let status =
                extract_string(entry, &["status"]).unwrap_or_else(|| "pending".to_string());
            Some(falcondeck_core::PlanStep { step, status })
        })
        .collect::<Vec<_>>();

    Some(ThreadPlan { explanation, steps })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn prefers_account_identity_over_requires_auth_flag() {
        let account = parse_account(&json!({
            "account": {
                "type": "chatgpt",
                "email": "ai@blackwell.page"
            },
            "requiresOpenaiAuth": true
        }));
        assert_eq!(account.status, AccountStatus::Ready);
        assert_eq!(account.label, "ai@blackwell.page");
    }

    #[test]
    fn parses_models_from_array() {
        let models = parse_models(&json!([
            {"id": "o3", "title": "o3", "isDefault": true}
        ]));
        assert_eq!(models.len(), 1);
        assert!(models[0].is_default);
    }

    #[test]
    fn parses_models_from_result_data_shape() {
        let models = parse_models(&json!({
            "result": {
                "data": [{
                    "id": "gpt-5.4",
                    "model": "gpt-5.4",
                    "displayName": "GPT-5.4",
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        {"reasoningEffort": "low", "description": "Low"},
                        {"reasoningEffort": "medium", "description": "Medium"}
                    ]
                }]
            }
        }));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.4");
        assert_eq!(models[0].label, "GPT-5.4");
        assert_eq!(
            models[0].default_reasoning_effort.as_deref(),
            Some("medium")
        );
        assert_eq!(models[0].supported_reasoning_efforts.len(), 2);
    }

    #[test]
    fn parses_collaboration_modes_from_result_data_shape() {
        let modes = parse_collaboration_modes(&json!({
            "result": {
                "data": [{
                    "mode": "plan",
                    "name": "Plan",
                    "settings": {
                        "model": "gpt-5.4",
                        "reasoning_effort": "high"
                    }
                }]
            }
        }));
        assert_eq!(modes.len(), 1);
        assert_eq!(modes[0].id, "plan");
        assert_eq!(modes[0].label, "Plan");
        assert_eq!(modes[0].mode.as_deref(), Some("plan"));
        assert_eq!(modes[0].model_id.as_deref(), Some("gpt-5.4"));
        assert_eq!(modes[0].reasoning_effort.as_deref(), Some("high"));
        assert!(modes[0].is_native);
    }

    #[test]
    fn parses_plan_steps() {
        let plan = parse_thread_plan(&json!({
            "explanation": "Work in slices",
            "plan": [{"step": "Build daemon", "status": "in_progress"}]
        }))
        .unwrap();
        assert_eq!(plan.steps[0].step, "Build daemon");
    }

    #[test]
    fn parses_thread_codex_params_from_thread_list_entries() {
        let threads = parse_threads(
            "workspace-1",
            "/Users/james/workspace-1",
            &json!([{
                "id": "thread-1",
                "title": "Hello",
                "updatedAt": "2026-03-16T11:00:00Z",
                "model": "gpt-5.4",
                "effort": "high",
                "collaborationModeId": "plan",
                "approvalPolicy": "on-request",
                "serviceTier": "fast"
            }]),
        );

        assert_eq!(threads.len(), 1);
        assert_eq!(
            threads[0].summary.agent.model_id.as_deref(),
            Some("gpt-5.4")
        );
        assert_eq!(
            threads[0].summary.agent.reasoning_effort.as_deref(),
            Some("high")
        );
        assert_eq!(
            threads[0].summary.agent.collaboration_mode_id.as_deref(),
            Some("plan")
        );
        assert_eq!(
            threads[0].summary.agent.approval_policy.as_deref(),
            Some("on-request")
        );
        assert_eq!(
            threads[0].summary.agent.service_tier.as_deref(),
            Some("fast")
        );
        assert_eq!(
            threads[0].summary.updated_at.to_rfc3339(),
            "2026-03-16T11:00:00+00:00"
        );
    }

    #[test]
    fn parses_nested_thread_list_and_filters_by_workspace_path() {
        let threads = parse_threads(
            "workspace-1",
            "/Users/james/project-a",
            &json!({
                "data": [
                    {
                        "id": "thread-a",
                        "preview": "latest project a thread",
                        "cwd": "/Users/james/project-a",
                        "updatedAt": 1773667619
                    },
                    {
                        "id": "thread-b",
                        "preview": "other workspace thread",
                        "cwd": "/Users/james/project-b",
                        "updatedAt": 1773667600
                    }
                ]
            }),
        );

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].summary.id, "thread-a");
        assert_eq!(threads[0].summary.title, "latest project a thread");
        assert_eq!(
            threads[0].summary.updated_at.to_rfc3339(),
            "2026-03-16T13:26:59+00:00"
        );
    }

    #[test]
    fn hydrates_session_file_when_thread_is_not_loaded() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(
            file,
            "{}",
            serde_json::to_string(&json!({
                "timestamp": "2026-03-16T13:21:50.840Z",
                "type": "session_meta",
                "payload": {
                    "cwd": "/Users/james/project-a"
                }
            }))
            .unwrap()
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::to_string(&json!({
                "timestamp": "2026-03-16T13:21:51.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "How does this work?",
                    "images": [],
                    "local_images": []
                }
            }))
            .unwrap()
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::to_string(&json!({
                "timestamp": "2026-03-16T13:21:52.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "It works from native storage."
                        }
                    ]
                }
            }))
            .unwrap()
        )
        .unwrap();

        let items = hydrate_thread_items_from_session_file(
            file.path().to_str().unwrap(),
            "/Users/james/project-a",
        );

        assert_eq!(items.len(), 2);
        match &items[0] {
            ConversationItem::UserMessage { text, .. } => {
                assert_eq!(text, "How does this work?");
            }
            other => panic!("expected user message, got {other:?}"),
        }
        match &items[1] {
            ConversationItem::AssistantMessage { text, .. } => {
                assert_eq!(text, "It works from native storage.");
            }
            other => panic!("expected assistant message, got {other:?}"),
        }
    }

    #[test]
    fn filters_internal_response_user_items_and_duplicate_assistant_session_messages() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(
            file,
            "{}",
            serde_json::to_string(&json!({
                "timestamp": "2026-03-16T13:21:50.000Z",
                "type": "session_meta",
                "payload": {
                    "cwd": "/Users/james/project-a"
                }
            }))
            .unwrap()
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::to_string(&json!({
                "timestamp": "2026-03-16T13:21:51.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "hello"
                }
            }))
            .unwrap()
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::to_string(&json!({
                "timestamp": "2026-03-16T13:21:51.100Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "<environment_context><shell>zsh</shell></environment_context>"
                        }
                    ]
                }
            }))
            .unwrap()
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::to_string(&json!({
                "timestamp": "2026-03-16T13:21:52.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "message": "Ok"
                }
            }))
            .unwrap()
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::to_string(&json!({
                "timestamp": "2026-03-16T13:21:52.200Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Ok"
                        }
                    ]
                }
            }))
            .unwrap()
        )
        .unwrap();

        let items = hydrate_thread_items_from_session_file(
            file.path().to_str().unwrap(),
            "/Users/james/project-a",
        );

        assert_eq!(items.len(), 2);
        match &items[0] {
            ConversationItem::UserMessage { text, .. } => assert_eq!(text, "hello"),
            other => panic!("expected user message, got {other:?}"),
        }
        match &items[1] {
            ConversationItem::AssistantMessage { text, .. } => assert_eq!(text, "Ok"),
            other => panic!("expected assistant message, got {other:?}"),
        }
    }

    #[test]
    fn marks_account_unknown_when_identity_is_missing() {
        let account = parse_account(&json!({}));
        assert_eq!(account.status, AccountStatus::Unknown);
        assert_eq!(account.label, "Account status unknown");
    }

    #[test]
    fn hydrates_thread_items_from_thread_read() {
        let items = hydrate_thread_items(&json!({
            "result": {
                "data": [{
                    "thread": {
                        "turns": [{
                            "items": [
                                {
                                    "id": "user-1",
                                    "type": "userMessage",
                                    "createdAt": "2026-03-16T10:00:00Z",
                                    "content": [
                                        {"type": "text", "text": "Summarise recent commits"},
                                        {"type": "localImage", "path": "/tmp/screenshot.png"}
                                    ]
                                },
                                {
                                    "id": "reasoning-1",
                                    "type": "reasoning",
                                    "summary": ["Looking at git state"],
                                    "content": ["Collecting commit history"],
                                    "createdAt": "2026-03-16T10:00:01Z"
                                },
                                {
                                    "id": "tool-1",
                                    "type": "commandExecution",
                                    "status": "completed",
                                    "output": "ok",
                                    "createdAt": "2026-03-16T10:00:02Z",
                                    "completedAt": "2026-03-16T10:00:03Z"
                                },
                                {
                                    "id": "assistant-1",
                                    "type": "agentMessage",
                                    "text": "Here are the recent commits.",
                                    "createdAt": "2026-03-16T10:00:04Z"
                                }
                            ]
                        }]
                    }
                }]
            }
        }));

        assert_eq!(items.len(), 4);
        match &items[0] {
            ConversationItem::UserMessage {
                text, attachments, ..
            } => {
                assert_eq!(text, "Summarise recent commits");
                assert_eq!(
                    attachments[0].local_path.as_deref(),
                    Some("/tmp/screenshot.png")
                );
            }
            other => panic!("expected user message, got {other:?}"),
        }
        match &items[1] {
            ConversationItem::Reasoning {
                summary, content, ..
            } => {
                assert_eq!(summary.as_deref(), Some("Looking at git state"));
                assert_eq!(content, "Collecting commit history");
            }
            other => panic!("expected reasoning item, got {other:?}"),
        }
        match &items[2] {
            ConversationItem::ToolCall { title, output, .. } => {
                assert_eq!(title, "Command execution");
                assert_eq!(output.as_deref(), Some("ok"));
            }
            other => panic!("expected tool item, got {other:?}"),
        }
    }

    #[test]
    fn hydrates_thread_summary_from_restored_items() {
        let thread_read = json!({
            "thread": {
                "turns": [{
                    "id": "turn-1",
                    "status": "completed",
                    "completedAt": "2026-03-16T10:00:05Z"
                }]
            }
        });
        let summary = hydrate_thread_summary(
            ThreadSummary {
                id: "thread-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                title: "Restored".to_string(),
                provider: AgentProvider::Codex,
                native_session_id: None,
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
            },
            &thread_read,
            &[
                ConversationItem::Reasoning {
                    id: "reasoning-1".to_string(),
                    summary: Some("Thinking".to_string()),
                    content: "Working".to_string(),
                    created_at: Utc::now(),
                },
                ConversationItem::ToolCall {
                    id: "tool-1".to_string(),
                    title: "Command execution".to_string(),
                    tool_kind: "commandExecution".to_string(),
                    status: "completed".to_string(),
                    output: Some("done".to_string()),
                    exit_code: Some(0),
                    display: ToolCallDisplay::default(),
                    created_at: Utc::now(),
                    completed_at: Some(Utc::now()),
                },
                ConversationItem::AssistantMessage {
                    id: "assistant-1".to_string(),
                    text: "Here are the recent changes in this project.".to_string(),
                    created_at: Utc::now(),
                },
            ],
        );

        assert_eq!(summary.status, ThreadStatus::Idle);
        assert_eq!(summary.latest_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(summary.last_tool.as_deref(), Some("Command execution"));
        assert_eq!(
            summary.last_message_preview.as_deref(),
            Some("Here are the recent changes in this project.")
        );
    }

    #[test]
    fn falls_back_to_latest_item_timestamp_when_turn_timestamp_is_missing() {
        let summary = hydrate_thread_summary(
            ThreadSummary {
                id: "thread-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                title: "Restored".to_string(),
                provider: AgentProvider::Codex,
                native_session_id: None,
                status: ThreadStatus::Idle,
                updated_at: chrono::DateTime::parse_from_rfc3339("2026-03-16T09:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
                last_message_preview: None,
                latest_turn_id: None,
                latest_plan: None,
                latest_diff: None,
                last_tool: None,
                last_error: None,
                agent: ThreadAgentParams::default(),
                attention: ThreadAttention::default(),
                is_archived: false,
            },
            &json!({ "thread": { "turns": [{ "id": "turn-1", "status": "completed" }] } }),
            &[ConversationItem::AssistantMessage {
                id: "assistant-1".to_string(),
                text: "Fresh message".to_string(),
                created_at: chrono::DateTime::parse_from_rfc3339("2026-03-16T10:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            }],
        );

        assert_eq!(summary.updated_at.to_rfc3339(), "2026-03-16T10:00:00+00:00");
    }

    #[test]
    fn ignores_non_error_service_items_when_deriving_last_error() {
        let summary = hydrate_thread_summary(
            ThreadSummary {
                id: "thread-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                title: "Restored".to_string(),
                provider: AgentProvider::Codex,
                native_session_id: None,
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
            },
            &json!({ "thread": { "turns": [] } }),
            &[ConversationItem::Service {
                id: "svc-1".to_string(),
                level: falcondeck_core::ServiceLevel::Info,
                message: "Review mode completed".to_string(),
                created_at: Utc::now(),
            }],
        );

        assert!(summary.last_error.is_none());
    }

    #[test]
    fn maps_canceled_turn_statuses_back_to_idle() {
        assert_eq!(
            thread_status_from_turn_status("canceled"),
            ThreadStatus::Idle
        );
        assert_eq!(
            thread_status_from_turn_status("cancelled"),
            ThreadStatus::Idle
        );
    }
}
