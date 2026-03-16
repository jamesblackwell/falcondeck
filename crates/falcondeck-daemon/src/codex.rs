use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use chrono::Utc;
use falcondeck_core::{
    AccountStatus, AccountSummary, CollaborationModeSummary, ModelSummary, ReasoningEffortSummary,
    ThreadCodexParams, ThreadPlan, ThreadStatus, ThreadSummary,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, oneshot},
};
use tracing::warn;

use crate::{app::AppState, error::DaemonError};

pub struct CodexBootstrap {
    pub session: Arc<CodexSession>,
    pub account: AccountSummary,
    pub models: Vec<ModelSummary>,
    pub collaboration_modes: Vec<CollaborationModeSummary>,
    pub threads: Vec<ThreadSummary>,
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
        let mut child = Command::new(codex_bin)
            .arg("app-server")
            .current_dir(PathBuf::from(&workspace_path))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
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
                    "limit": 50,
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
        let threads = parse_threads(&workspace_id, &threads_value);

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

fn parse_models(value: &Value) -> Vec<ModelSummary> {
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());

    models
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry
                .get("id")
                .or_else(|| entry.get("slug"))
                .and_then(Value::as_str)?;
            let label = entry
                .get("title")
                .or_else(|| entry.get("label"))
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(id);
            Some(ModelSummary {
                id: id.to_string(),
                label: label.to_string(),
                is_default: entry
                    .get("isDefault")
                    .or_else(|| entry.get("is_default"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_reasoning_effort: extract_string(
                    entry,
                    &["defaultReasoningEffort", "default_reasoning_effort"],
                ),
                supported_reasoning_efforts: parse_reasoning_efforts(entry),
            })
        })
        .collect()
}

fn parse_reasoning_efforts(value: &Value) -> Vec<ReasoningEffortSummary> {
    value
        .get("supportedReasoningEfforts")
        .or_else(|| value.get("supported_reasoning_efforts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let reasoning_effort = extract_string(entry, &["reasoningEffort", "reasoning_effort"])?;
            Some(ReasoningEffortSummary {
                reasoning_effort,
                description: extract_string(entry, &["description"]).unwrap_or_default(),
            })
        })
        .collect()
}

fn parse_collaboration_modes(value: &Value) -> Vec<CollaborationModeSummary> {
    value
        .get("modes")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = extract_string(entry, &["id"])?;
            Some(CollaborationModeSummary {
                id: id.clone(),
                label: extract_string(entry, &["label", "name"]).unwrap_or(id),
                model_id: extract_string(entry, &["model", "modelId", "model_id"]),
                reasoning_effort: extract_string(entry, &["reasoningEffort", "reasoning_effort"]),
            })
        })
        .collect()
}

fn parse_threads(workspace_id: &str, value: &Value) -> Vec<ThreadSummary> {
    let entries = value
        .get("threads")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());
    let now = Utc::now();

    entries
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = extract_thread_id(entry)?;
            Some(ThreadSummary {
                id,
                workspace_id: workspace_id.to_string(),
                title: extract_thread_title(entry).unwrap_or_else(|| "Untitled thread".to_string()),
                status: ThreadStatus::Idle,
                updated_at: now,
                last_message_preview: None,
                latest_turn_id: None,
                latest_plan: None,
                latest_diff: None,
                last_tool: None,
                last_error: None,
                codex: ThreadCodexParams {
                    model_id: extract_string(entry, &["model", "modelId", "model_id"]),
                    reasoning_effort: extract_string(
                        entry,
                        &["effort", "reasoningEffort", "reasoning_effort"],
                    ),
                    collaboration_mode_id: extract_string(
                        entry,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                    approval_policy: extract_string(entry, &["approvalPolicy", "approval_policy"]),
                    service_tier: extract_string(entry, &["serviceTier", "service_tier"]),
                },
            })
        })
        .collect()
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
            &json!([{
                "id": "thread-1",
                "title": "Hello",
                "model": "gpt-5.4",
                "effort": "high",
                "collaborationModeId": "plan",
                "approvalPolicy": "on-request",
                "serviceTier": "fast"
            }]),
        );

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].codex.model_id.as_deref(), Some("gpt-5.4"));
        assert_eq!(threads[0].codex.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            threads[0].codex.collaboration_mode_id.as_deref(),
            Some("plan")
        );
        assert_eq!(
            threads[0].codex.approval_policy.as_deref(),
            Some("on-request")
        );
        assert_eq!(threads[0].codex.service_tier.as_deref(), Some("fast"));
    }

    #[test]
    fn marks_account_unknown_when_identity_is_missing() {
        let account = parse_account(&json!({}));
        assert_eq!(account.status, AccountStatus::Unknown);
        assert_eq!(account.label, "Account status unknown");
    }
}
