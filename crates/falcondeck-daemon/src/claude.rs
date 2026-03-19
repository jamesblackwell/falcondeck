use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use chrono::{DateTime, Utc};
use falcondeck_core::{
    AccountStatus, AccountSummary, AgentCapabilitySummary, AgentProvider, CollaborationModeSummary,
    ConversationItem, ModelSummary, ReasoningEffortSummary, ThreadAgentParams, ThreadAttention,
    ThreadStatus, ThreadSummary,
};
use serde_json::Value;
use tokio::{
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::Mutex,
};
use uuid::Uuid;

use crate::error::DaemonError;

pub struct ClaudeBootstrap {
    pub runtime: Arc<ClaudeRuntime>,
    pub account: AccountSummary,
    pub models: Vec<ModelSummary>,
    pub collaboration_modes: Vec<CollaborationModeSummary>,
    pub capabilities: AgentCapabilitySummary,
    pub threads: Vec<HydratedClaudeThread>,
}

pub struct HydratedClaudeThread {
    pub summary: ThreadSummary,
    pub items: Vec<ConversationItem>,
}

pub struct ClaudeTurnSpawn {
    pub session_id: String,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

pub struct ClaudeRuntime {
    workspace_path: String,
    claude_bin: String,
    active_turns: Mutex<HashMap<String, Child>>,
}

impl ClaudeRuntime {
    pub async fn connect(
        workspace_path: String,
        claude_bin: String,
    ) -> Result<ClaudeBootstrap, DaemonError> {
        let runtime = Arc::new(Self {
            workspace_path: workspace_path.clone(),
            claude_bin: claude_bin.clone(),
            active_turns: Mutex::new(HashMap::new()),
        });

        let account = read_auth_status(&claude_bin).await;
        let models = curated_models();
        let collaboration_modes = vec![CollaborationModeSummary {
            id: "plan".to_string(),
            label: "Plan".to_string(),
            mode: Some("plan".to_string()),
            model_id: None,
            reasoning_effort: Some("medium".to_string()),
            is_native: true,
        }];
        let capabilities = AgentCapabilitySummary {
            supports_review: false,
        };
        let threads = hydrate_threads(&workspace_path);

        Ok(ClaudeBootstrap {
            runtime,
            account,
            models,
            collaboration_modes,
            capabilities,
            threads,
        })
    }
    pub async fn spawn_turn(
        &self,
        thread_id: &str,
        session_id: Option<&str>,
        prompt: &str,
        model_id: Option<&str>,
        effort: Option<&str>,
        plan_mode: bool,
    ) -> Result<ClaudeTurnSpawn, DaemonError> {
        let next_session_id = session_id
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut command = Command::new(&self.claude_bin);
        command
            .arg("-p")
            .arg(prompt)
            .arg("--output-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--verbose")
            .current_dir(PathBuf::from(&self.workspace_path))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(existing_session_id) = session_id {
            command.arg("--resume").arg(existing_session_id);
        } else {
            command.arg("--session-id").arg(&next_session_id);
        }

        if let Some(model_id) = model_id {
            command.arg("--model").arg(model_id);
        }
        if let Some(effort) = effort {
            command.arg("--effort").arg(effort);
        }
        if plan_mode {
            command.arg("--permission-mode").arg("plan");
        }

        let mut child = command
            .spawn()
            .map_err(|error| DaemonError::Process(format!("failed to start claude: {error}")))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        self.active_turns
            .lock()
            .await
            .insert(thread_id.to_string(), child);

        Ok(ClaudeTurnSpawn {
            session_id: next_session_id,
            stdout,
            stderr,
        })
    }

    pub async fn interrupt_turn(&self, thread_id: &str) -> Result<(), DaemonError> {
        let mut active = self.active_turns.lock().await;
        if let Some(child) = active.get_mut(thread_id) {
            child.start_kill().map_err(|error| {
                DaemonError::Process(format!("failed to interrupt claude turn: {error}"))
            })?;
        }
        Ok(())
    }

    pub async fn finish_turn(
        &self,
        thread_id: &str,
    ) -> Result<Option<std::process::ExitStatus>, DaemonError> {
        let mut active = self.active_turns.lock().await;
        if let Some(mut child) = active.remove(thread_id) {
            let status = child.wait().await.map_err(|error| {
                DaemonError::Process(format!("failed to wait for claude turn: {error}"))
            })?;
            return Ok(Some(status));
        }
        Ok(None)
    }
}

pub fn curated_models() -> Vec<ModelSummary> {
    vec![
        ModelSummary {
            id: "sonnet".to_string(),
            label: "Claude Sonnet".to_string(),
            is_default: true,
            default_reasoning_effort: Some("medium".to_string()),
            supported_reasoning_efforts: vec![
                ReasoningEffortSummary {
                    reasoning_effort: "low".to_string(),
                    description: "Fastest responses".to_string(),
                },
                ReasoningEffortSummary {
                    reasoning_effort: "medium".to_string(),
                    description: "Balanced reasoning".to_string(),
                },
                ReasoningEffortSummary {
                    reasoning_effort: "high".to_string(),
                    description: "Deeper reasoning".to_string(),
                },
            ],
        },
        ModelSummary {
            id: "opus".to_string(),
            label: "Claude Opus".to_string(),
            is_default: false,
            default_reasoning_effort: Some("high".to_string()),
            supported_reasoning_efforts: vec![
                ReasoningEffortSummary {
                    reasoning_effort: "low".to_string(),
                    description: "Fastest responses".to_string(),
                },
                ReasoningEffortSummary {
                    reasoning_effort: "medium".to_string(),
                    description: "Balanced reasoning".to_string(),
                },
                ReasoningEffortSummary {
                    reasoning_effort: "high".to_string(),
                    description: "Deeper reasoning".to_string(),
                },
                ReasoningEffortSummary {
                    reasoning_effort: "max".to_string(),
                    description: "Maximum effort".to_string(),
                },
            ],
        },
    ]
}

pub async fn read_auth_status(claude_bin: &str) -> AccountSummary {
    let output = Command::new(claude_bin)
        .arg("auth")
        .arg("status")
        .output()
        .await;
    match output {
        Ok(output) if output.status.success() => {
            if let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) {
                return parse_account_status(&value);
            }
            AccountSummary {
                status: AccountStatus::Ready,
                label: "Claude ready".to_string(),
            }
        }
        Ok(output) if output.status.code() == Some(1) => AccountSummary {
            status: AccountStatus::NeedsAuth,
            label: String::from_utf8_lossy(if output.stdout.is_empty() {
                &output.stderr
            } else {
                &output.stdout
            })
            .trim()
            .to_string()
            .if_empty("Claude login required"),
        },
        Ok(output) => AccountSummary {
            status: AccountStatus::Unknown,
            label: format!(
                "Claude auth status unavailable ({})",
                output.status.code().unwrap_or_default()
            ),
        },
        Err(_) => AccountSummary {
            status: AccountStatus::Unknown,
            label: "Claude not available".to_string(),
        },
    }
}

pub fn parse_account_status(value: &Value) -> AccountSummary {
    let authenticated = value
        .get("authenticated")
        .and_then(Value::as_bool)
        .or_else(|| value.get("loggedIn").and_then(Value::as_bool))
        .unwrap_or(false);
    if authenticated {
        let label = value
            .get("email")
            .and_then(Value::as_str)
            .map(|email| format!("Claude ready ({email})"))
            .unwrap_or_else(|| "Claude ready".to_string());
        return AccountSummary {
            status: AccountStatus::Ready,
            label,
        };
    }

    AccountSummary {
        status: AccountStatus::NeedsAuth,
        label: value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Claude login required")
            .to_string(),
    }
}

pub fn hydrate_threads(workspace_path: &str) -> Vec<HydratedClaudeThread> {
    let root = env::var("HOME")
        .map(|home| PathBuf::from(home).join(".claude/projects"))
        .unwrap_or_else(|_| PathBuf::from(".claude/projects"));

    let mut files = Vec::new();
    collect_session_files(&root, &mut files);

    let mut threads = files
        .into_iter()
        .filter_map(|path| hydrate_thread_from_file(&path, workspace_path))
        .collect::<Vec<_>>();
    threads.sort_by(|left, right| right.summary.updated_at.cmp(&left.summary.updated_at));
    threads
}

fn collect_session_files(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_files(&path, files);
            continue;
        }
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if matches!(ext, "jsonl" | "json") {
            files.push(path);
        }
    }
}

fn hydrate_thread_from_file(path: &Path, workspace_path: &str) -> Option<HydratedClaudeThread> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut session_id = None;
    let mut cwd = None;
    let mut title = None;
    let mut updated_at = None;
    let mut items = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        session_id =
            session_id.or_else(|| extract_string(&value, &["session_id", "sessionId", "id"]));
        cwd = cwd
            .or_else(|| extract_string(&value, &["cwd", "working_directory", "workingDirectory"]));
        title = title.or_else(|| extract_string(&value, &["title", "name"]));
        updated_at = extract_datetime(
            &value,
            &[
                "updated_at",
                "updatedAt",
                "timestamp",
                "created_at",
                "createdAt",
            ],
        )
        .or(updated_at);
        if let Some(item) = hydrate_conversation_item(&value) {
            items.push(item);
        }
    }

    let cwd = cwd?;
    if cwd != workspace_path {
        return None;
    }
    let session_id = session_id.or_else(|| {
        path.file_stem()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned)
    })?;
    let now = Utc::now();
    let last_message_preview = items.iter().rev().find_map(|item| match item {
        ConversationItem::AssistantMessage { text, .. }
        | ConversationItem::UserMessage { text, .. } => Some(truncate_preview(text)),
        _ => None,
    });
    let summary = ThreadSummary {
        id: session_id.clone(),
        workspace_id: String::new(),
        title: title.unwrap_or_else(|| "Claude thread".to_string()),
        provider: AgentProvider::Claude,
        native_session_id: Some(session_id),
        status: ThreadStatus::Idle,
        updated_at: updated_at.unwrap_or(now),
        last_message_preview,
        latest_turn_id: None,
        latest_plan: None,
        latest_diff: None,
        last_tool: None,
        last_error: None,
        agent: ThreadAgentParams::default(),
        attention: ThreadAttention::default(),
        is_archived: false,
    };

    Some(HydratedClaudeThread { summary, items })
}

fn hydrate_conversation_item(value: &Value) -> Option<ConversationItem> {
    let event_type = extract_string(value, &["type", "event"])?;
    let created_at =
        extract_datetime(value, &["created_at", "createdAt", "timestamp"]).unwrap_or_else(Utc::now);
    match event_type.as_str() {
        "user" | "user_message" => {
            extract_string(value, &["text", "message", "content"]).map(|text| {
                ConversationItem::UserMessage {
                    id: extract_string(value, &["uuid", "id"])
                        .unwrap_or_else(|| format!("user-{}", created_at.timestamp_millis())),
                    text,
                    attachments: Vec::new(),
                    created_at,
                }
            })
        }
        "assistant" | "assistant_message" => extract_string(value, &["text", "message", "content"])
            .map(|text| ConversationItem::AssistantMessage {
                id: extract_string(value, &["uuid", "id"])
                    .unwrap_or_else(|| format!("assistant-{}", created_at.timestamp_millis())),
                text,
                created_at,
            }),
        _ => None,
    }
}

fn extract_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = value.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn extract_datetime(value: &Value, keys: &[&str]) -> Option<DateTime<Utc>> {
    for key in keys {
        if let Some(raw) = value.get(key) {
            if let Some(text) = raw.as_str() {
                if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
                    return Some(parsed.with_timezone(&Utc));
                }
            } else if let Some(timestamp) = raw.as_i64() {
                return DateTime::<Utc>::from_timestamp(timestamp, 0);
            }
        }
    }
    None
}

fn truncate_preview(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= 80 {
        return trimmed.to_string();
    }
    format!("{}...", trimmed.chars().take(80).collect::<String>())
}

trait StringExt {
    fn if_empty(self, fallback: &str) -> String;
}

impl StringExt for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_authenticated_account_status() {
        let account = parse_account_status(&json!({
            "authenticated": true,
            "email": "jamie@example.com"
        }));
        assert_eq!(account.status, AccountStatus::Ready);
        assert_eq!(account.label, "Claude ready (jamie@example.com)");
    }

    #[test]
    fn hydrates_thread_from_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("session.jsonl");
        fs::write(
            &session_path,
            [
                json!({
                    "session_id": "session-1",
                    "cwd": "/tmp/project",
                    "title": "Feature work",
                    "type": "user",
                    "text": "hello",
                    "created_at": "2026-03-19T10:00:00Z"
                })
                .to_string(),
                json!({
                    "session_id": "session-1",
                    "cwd": "/tmp/project",
                    "type": "assistant",
                    "text": "world",
                    "created_at": "2026-03-19T10:00:01Z"
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.summary.provider, AgentProvider::Claude);
        assert_eq!(
            hydrated.summary.native_session_id.as_deref(),
            Some("session-1")
        );
        assert_eq!(hydrated.items.len(), 2);
    }
}
