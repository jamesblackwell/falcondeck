//! Native OpenCode HTTP transport.
//!
//! This deliberately lives beside, rather than inside, the generic ACP
//! adapter.  OpenCode's server owns durable sessions and exposes delivery
//! (`queue`/`steer`) semantics which ACP cannot represent.  Callers must keep
//! an ACP fallback: an HTTP request is only safe to retry after its admission
//! status has been established.

use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::Arc,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::{Duration, timeout},
};
use uuid::Uuid;

use crate::agent_binary::strip_terminal_advertising_env;
use crate::error::DaemonError;

mod forms;
use forms::form_answers;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const LISTENING_PREFIX: &str = "server listening on http://127.0.0.1:";
const MAX_MESSAGE_PAGE_SIZE: usize = 200;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Queue,
    Steer,
}

struct MessagePage {
    messages: Vec<Value>,
    /// Continuation cursor toward older items for a newest-first listing.
    /// OpenCode's `cursor.previous` points toward newer items and is empty at
    /// the head of a `order=desc` walk, so `next` is the only valid
    /// continuation toward the admitted message.
    next: Option<String>,
}

/// Accumulates newest-first message pages and stops at an admitted message.
#[derive(Default)]
struct DescCollector {
    newest_first: Vec<Value>,
}

impl DescCollector {
    /// Records one newest-first page. Returns `true` when the admitted
    /// message was found on it, retaining only the records after it.
    fn push_page(&mut self, messages: Vec<Value>, message_id: &str) -> bool {
        let admitted = messages
            .iter()
            .position(|message| message.get("id").and_then(Value::as_str) == Some(message_id));
        match admitted {
            Some(admitted) => {
                self.newest_first
                    .extend(messages.into_iter().take(admitted));
                true
            }
            None => {
                self.newest_first.extend(messages);
                false
            }
        }
    }

    fn push_all(&mut self, messages: Vec<Value>) {
        self.newest_first.extend(messages);
    }
}

impl Delivery {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queue => "queue",
            Self::Steer => "steer",
        }
    }
}

/// A private, password-protected `opencode serve` child for one workspace.
pub struct OpenCodeRuntime {
    base_url: String,
    password: String,
    client: reqwest::Client,
    child: Mutex<Child>,
    /// OS pid of the `opencode serve` child, for the crash-orphan registry.
    server_pid: Option<u32>,
    /// When the daemon last called this server. Read by the idle-retirement
    /// timer in `app::runtime_health`.
    activity: crate::activity::ActivityClock,
    /// Whether this server has ever served a turn, as opposed to only
    /// answering the composer's model-catalog hydration.
    served_prompt: std::sync::atomic::AtomicBool,
}

impl OpenCodeRuntime {
    pub async fn spawn(
        configured_command: &[String],
        cwd: &str,
        env: &HashMap<String, String>,
    ) -> Result<Arc<Self>, DaemonError> {
        let (binary, configured_args) = configured_command.split_first().ok_or_else(|| {
            DaemonError::BadRequest("OpenCode needs a non-empty command".to_string())
        })?;
        let configured_args = if configured_args.last().is_some_and(|arg| arg == "acp") {
            &configured_args[..configured_args.len() - 1]
        } else {
            configured_args
        };
        let password = Uuid::new_v4().simple().to_string();
        let mut command = Command::new(binary);
        command
            .args(configured_args)
            .args(["serve", "--port", "0", "--hostname", "127.0.0.1"])
            .args(["--print-logs", "--log-level", "error"])
            .current_dir(cwd)
            .envs(env)
            // These must follow the user-supplied environment: allowing a
            // provider config to replace either value would expose an
            // unauthenticated or unexpectedly credentialed local server.
            .env("OPENCODE_PASSWORD", &password)
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .env("OPENCODE_SERVER_USERNAME", "opencode");
        for (key, value) in crate::connectors::MCP_CLI_TIMEOUT_ENV {
            command.env(*key, *value);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);
        // In-process cleanup only. A daemon that dies without dropping the
        // runtime still orphans the server, which is what the pid registry
        // (`register_server_process`/`reap_orphaned_servers`) is for.
        command.kill_on_drop(true);
        strip_terminal_advertising_env(&mut command);
        let mut child = command.spawn().map_err(|error| {
            DaemonError::Process(format!(
                "failed to start OpenCode server '{}': {error}",
                configured_command.join(" ")
            ))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            DaemonError::Process("OpenCode server did not expose stdout".to_string())
        })?;
        // Drain both pipes while startup is pending: diagnostics can fill
        // stderr before OpenCode writes its listening banner to stdout.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(%line, "OpenCode server stderr");
                }
            });
        }
        let (port_tx, port_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(monitor_stdout(stdout, port_tx));
        let port = match timeout(STARTUP_TIMEOUT, port_rx).await {
            Ok(Ok(port)) => port,
            Ok(Err(_)) => {
                kill_owned_process_group(&child);
                let _ = child.kill().await;
                return Err(DaemonError::Process(
                    "OpenCode server exited before reporting its port".to_string(),
                ));
            }
            Err(_) => {
                kill_owned_process_group(&child);
                let _ = child.kill().await;
                return Err(DaemonError::Process(
                    "OpenCode server did not report a localhost port in time".to_string(),
                ));
            }
        };
        let server_pid = child.id();
        let runtime = Arc::new(Self {
            base_url: format!("http://127.0.0.1:{port}"),
            password,
            client: reqwest::Client::builder()
                .connect_timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(|error| {
                    DaemonError::Process(format!("could not build OpenCode HTTP client: {error}"))
                })?,
            child: Mutex::new(child),
            server_pid,
            activity: crate::activity::ActivityClock::new(),
            served_prompt: std::sync::atomic::AtomicBool::new(false),
        });
        if let Err(error) = runtime.health().await {
            runtime.shutdown().await;
            return Err(error);
        }
        Ok(runtime)
    }

    pub async fn health(&self) -> Result<Value, DaemonError> {
        self.request(reqwest::Method::GET, "/api/info", None).await
    }

    /// Verifies the endpoints and request fields the native transport relies
    /// on against the server's own OpenAPI document, so an incompatible
    /// OpenCode build falls back to ACP before a turn is ever admitted.
    pub async fn validate_contract(&self) -> Result<(), DaemonError> {
        let doc = self
            .request(reqwest::Method::GET, "/openapi.json", None)
            .await?;
        contract_supported(&doc)
    }

    /// A new session is idle, so this must return promptly before selecting
    /// native transport. A documented but unimplemented wait is not compatible.
    pub async fn validate_idle_wait(&self, session_id: &str) -> Result<(), DaemonError> {
        self.request(
            reqwest::Method::POST,
            &format!("/api/experimental/session/{session_id}/wait"),
            None,
        )
        .await
        .map(|_| ())
    }

    pub async fn create_session(
        &self,
        cwd: &str,
        model: Option<&str>,
        agent: Option<&str>,
    ) -> Result<String, DaemonError> {
        let body = session_create_body(cwd, model, agent);
        let value = self
            .request(reqwest::Method::POST, "/api/session", Some(body))
            .await?;
        let session_id = value
            .pointer("/data/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                DaemonError::Rpc("OpenCode session creation returned no session id".to_string())
            })?;
        // New sessions can have no explicit model even though the location
        // has a default. Resolve it through OpenCode, preserving agent defaults.
        let initialized = async {
            if self.session_model_ref(&session_id).await?.is_none() {
                self.set_model(&session_id, "default", None).await?;
            }
            Ok::<_, DaemonError>(())
        }
        .await;
        if let Err(error) = initialized {
            self.delete_session(&session_id).await;
            return Err(error);
        }
        Ok(session_id)
    }

    /// Native model catalog. This response is intentionally kept inside the
    /// daemon: provider records may contain credentials that must never be
    /// projected into a FalconDeck snapshot.
    pub async fn provider_catalog(&self) -> Result<Value, DaemonError> {
        self.request(reqwest::Method::GET, "/api/model", None).await
    }

    /// Read the live registry so hot-reloaded providers and variants are
    /// checked against the same catalog the runner will use for this turn.
    pub async fn runner_models(&self) -> Result<HashMap<String, RunnerModel>, DaemonError> {
        runner_models(&self.provider_catalog().await?)
    }

    /// The session's selected model as `provider/model`. New sessions resolve
    /// OpenCode's configured default before admission when no model is set.
    pub async fn session_model_ref(&self, session_id: &str) -> Result<Option<String>, DaemonError> {
        let session = self
            .request(
                reqwest::Method::GET,
                &format!("/api/session/{session_id}"),
                None,
            )
            .await?;
        let provider_id = session
            .pointer("/data/model/providerID")
            .and_then(Value::as_str);
        let model_id = session.pointer("/data/model/id").and_then(Value::as_str);
        Ok(provider_id
            .zip(model_id)
            .map(|(provider_id, model_id)| format!("{provider_id}/{model_id}")))
    }

    pub async fn agents(&self) -> Result<Vec<Value>, DaemonError> {
        let value = self
            .request(reqwest::Method::GET, "/api/agent", None)
            .await?;
        response_data_array(value, "agents")
    }

    /// Points the session at a model, optionally at one of that model's
    /// reasoning variants (OpenCode's name for an effort level).
    pub async fn set_model(
        &self,
        session_id: &str,
        model: &str,
        variant: Option<&str>,
    ) -> Result<(), DaemonError> {
        let mut model = if model == "default" {
            let response = self
                .request(reqwest::Method::GET, "/api/model/default", None)
                .await?;
            let model = response
                .get("data")
                .filter(|model| {
                    model
                        .get("providerID")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                        && model
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.is_empty())
                })
                .ok_or_else(|| {
                    DaemonError::BadRequest("OpenCode has no configured default model".into())
                })?;
            model.clone()
        } else {
            model_ref(model).ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "OpenCode model must be provider-qualified: {model}"
                ))
            })?
        };
        if let Some(variant) = variant
            && let Some(object) = model.as_object_mut()
        {
            object.insert("variant".to_string(), json!(variant));
        }
        self.request(
            reqwest::Method::POST,
            &format!("/api/session/{session_id}/model"),
            Some(json!({ "model": model })),
        )
        .await
        .map(|_| ())
    }

    pub async fn set_agent(&self, session_id: &str, agent: &str) -> Result<(), DaemonError> {
        self.request(
            reqwest::Method::POST,
            &format!("/api/session/{session_id}/agent"),
            Some(json!({ "agent": agent })),
        )
        .await
        .map(|_| ())
    }

    pub async fn delete_session(&self, session_id: &str) {
        let _ = self
            .request(
                reqwest::Method::DELETE,
                &format!("/api/session/{session_id}"),
                None,
            )
            .await;
    }

    /// Admit an input durably. The returned message id is an idempotency key;
    /// callers must retain it before retrying after an ambiguous failure.
    pub async fn prompt(
        &self,
        session_id: &str,
        message_id: &str,
        text: &str,
        files: &[Value],
        delivery: Delivery,
    ) -> Result<Value, DaemonError> {
        self.served_prompt
            .store(true, std::sync::atomic::Ordering::Release);
        let mut prompt = json!({ "text": text });
        if !files.is_empty() {
            prompt["files"] = Value::Array(files.to_vec());
        }
        self.request(
            reqwest::Method::POST,
            &format!("/api/session/{session_id}/prompt"),
            Some(prompt_request_body(message_id, prompt, delivery)),
        )
        .await
        .and_then(|admission| {
            if admission.pointer("/data/id").and_then(Value::as_str) != Some(message_id)
                || admission.pointer("/data/sessionID").and_then(Value::as_str) != Some(session_id)
            {
                return Err(DaemonError::Rpc(
                    "OpenCode prompt admission could not be confirmed; do not resend with a new message id".to_string(),
                ));
            }
            Ok(admission)
        })
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<(), DaemonError> {
        self.request(
            reqwest::Method::POST,
            &format!("/api/session/{session_id}/interrupt"),
            Some(json!({})),
        )
        .await
        .map(|_| ())
    }

    /// OpenCode 2 waits for the whole foreground drain, including successors
    /// started by steering. This read never resends an ambiguously admitted input.
    pub async fn wait_until_idle(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Vec<Value>, DaemonError> {
        self.wait_for_settlement(session_id).await?;
        let messages = self.messages_since(session_id, message_id).await?;
        terminal_outcome(&messages)?;
        Ok(messages)
    }

    /// Wait without interpreting the terminal verdict, so callers can project
    /// the final transcript before surfacing a failed or interrupted outcome.
    pub(crate) async fn wait_for_settlement(&self, session_id: &str) -> Result<(), DaemonError> {
        self.request_inner(
            reqwest::Method::POST,
            &format!("/api/experimental/session/{session_id}/wait"),
            None,
            None,
        )
        .await
        .map(|_| ())
    }

    pub async fn session_is_active(&self, session_id: &str) -> Result<bool, DaemonError> {
        let value = self
            .request(reqwest::Method::GET, "/api/session/active", None)
            .await?;
        session_is_active(&value, session_id)
    }

    pub async fn messages(&self, session_id: &str) -> Result<Vec<Value>, DaemonError> {
        // Walk every page toward older items; OpenCode caps responses, so a
        // single newest-first page silently truncates long sessions.
        let mut collector = DescCollector::default();
        let mut cursor = None;
        let mut seen_cursors = HashSet::new();
        loop {
            let page = self.message_page(session_id, cursor.as_deref()).await?;
            collector.push_all(page.messages);
            let Some(next) = page.next else {
                let mut messages = collector.newest_first;
                messages.reverse();
                return Ok(messages);
            };
            if !seen_cursors.insert(next.clone()) {
                return Err(DaemonError::Rpc(
                    "OpenCode repeated a message pagination cursor".to_string(),
                ));
            }
            cursor = Some(next);
        }
    }

    /// Messages from the admitted user message onward. Public so the turn
    /// monitor can stream the partial transcript while the runner works.
    pub async fn messages_since(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Vec<Value>, DaemonError> {
        let mut collector = DescCollector::default();
        let mut cursor = None;
        let mut seen_cursors = HashSet::new();
        loop {
            let page = self.message_page(session_id, cursor.as_deref()).await?;
            if collector.push_page(page.messages, message_id) {
                let mut messages = collector.newest_first;
                messages.reverse();
                return Ok(messages);
            }
            let Some(next) = page.next else {
                return Err(DaemonError::Rpc(
                    "OpenCode admitted the prompt but did not project its user message".to_string(),
                ));
            };
            if !seen_cursors.insert(next.clone()) {
                return Err(DaemonError::Rpc(
                    "OpenCode repeated a message pagination cursor".to_string(),
                ));
            }
            cursor = Some(next);
        }
    }

    async fn message_page(
        &self,
        session_id: &str,
        cursor: Option<&str>,
    ) -> Result<MessagePage, DaemonError> {
        let value = self
            .request(
                reqwest::Method::GET,
                &messages_path(session_id, cursor),
                None,
            )
            .await?;
        response_message_page(value)
    }

    pub async fn pending_permissions(&self, session_id: &str) -> Result<Vec<Value>, DaemonError> {
        let value = self
            .request(
                reqwest::Method::GET,
                &format!("/api/session/{session_id}/permission"),
                None,
            )
            .await?;
        response_data_array(value, "permissions")
    }

    pub async fn reply_permission(
        &self,
        session_id: &str,
        request_id: &str,
        reply: &str,
    ) -> Result<(), DaemonError> {
        self.request(
            reqwest::Method::POST,
            &format!("/api/session/{session_id}/permission/{request_id}/reply"),
            Some(json!({ "decision": reply })),
        )
        .await
        .map(|_| ())
    }

    pub async fn pending_questions(&self, session_id: &str) -> Result<Vec<Value>, DaemonError> {
        let value = self
            .request(
                reqwest::Method::GET,
                &format!("/api/session/{session_id}/form"),
                None,
            )
            .await?;
        response_data_array(value, "forms")
    }

    pub async fn reply_question(
        &self,
        session_id: &str,
        request_id: &str,
        answers: Vec<Vec<String>>,
    ) -> Result<(), DaemonError> {
        let form = self
            .request(
                reqwest::Method::GET,
                &format!("/api/session/{session_id}/form/{request_id}"),
                None,
            )
            .await?;
        let answer = form_answers(&form["data"], &answers)?;
        self.request(
            reqwest::Method::POST,
            &format!("/api/session/{session_id}/form/{request_id}/reply"),
            Some(json!({ "answer": answer })),
        )
        .await
        .map(|_| ())
    }

    /// OS pid of the `opencode serve` child, for the crash-orphan registry.
    pub fn server_pid(&self) -> Option<u32> {
        self.server_pid
    }

    pub async fn shutdown(&self) {
        tracing::debug!(pid = ?self.server_pid, "Stopping private OpenCode server");
        let mut child = self.child.lock().await;
        kill_owned_process_group(&child);
        let _ = child.kill().await;
        tracing::debug!(pid = ?self.server_pid, "Private OpenCode server stopped");
    }

    /// How long since the daemon last called this server.
    pub fn idle_for(&self) -> Duration {
        self.activity.idle_for()
    }

    /// Whether this server has ever served a turn.
    pub fn served_prompt(&self) -> bool {
        self.served_prompt
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub async fn requires_authentication(&self) -> Result<bool, DaemonError> {
        let response = self
            .client
            .get(format!("{}/api/session", self.base_url))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| DaemonError::Process(error.to_string()))?;
        Ok(response.status() == reqwest::StatusCode::UNAUTHORIZED)
    }

    pub(crate) async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, DaemonError> {
        self.request_inner(method, path, body, Some(REQUEST_TIMEOUT))
            .await
    }

    async fn request_inner(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        request_timeout: Option<Duration>,
    ) -> Result<Value, DaemonError> {
        tracing::debug!(%method, path, "OpenCode native request started");
        let mut request = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .basic_auth("opencode", Some(&self.password));
        if let Some(request_timeout) = request_timeout {
            request = request.timeout(request_timeout);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        self.activity.touch();
        let response = request.send().await.map_err(|error| {
            DaemonError::Process(format!("OpenCode native request failed: {error}"))
        })?;
        let status = response.status();
        tracing::debug!(%status, path, "OpenCode native request responded");
        let text = response.text().await.map_err(|error| {
            DaemonError::Process(format!("could not read OpenCode response: {error}"))
        })?;
        if !status.is_success() {
            return Err(DaemonError::Rpc(format!(
                "OpenCode native API returned {status}: {text}"
            )));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(DaemonError::from)
    }
}

impl Drop for OpenCodeRuntime {
    fn drop(&mut self) {
        kill_owned_process_group(self.child.get_mut());
    }
}

fn kill_owned_process_group(child: &Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|id| libc::pid_t::try_from(id).ok()) {
        // SAFETY: this child was spawned in a new process group with its PID
        // as the group ID. Include its MCP helpers, which can hold daemon
        // requests open after the server process itself exits.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = child;
}

async fn monitor_stdout(
    stdout: tokio::process::ChildStdout,
    port_tx: tokio::sync::oneshot::Sender<u16>,
) {
    let mut lines = BufReader::new(stdout).lines();
    let mut port_tx = Some(port_tx);
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(port) = parse_listening_port(&line)
            && let Some(port_tx) = port_tx.take()
        {
            let _ = port_tx.send(port);
        }
        tracing::debug!(%line, "OpenCode server startup output");
    }
}

fn parse_listening_port(line: &str) -> Option<u16> {
    line.trim().strip_prefix(LISTENING_PREFIX)?.parse().ok()
}

fn response_data_array(value: Value, endpoint: &str) -> Result<Vec<Value>, DaemonError> {
    value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            DaemonError::Rpc(format!(
                "OpenCode native {endpoint} response did not contain a data array"
            ))
        })
}

fn session_is_active(value: &Value, session_id: &str) -> Result<bool, DaemonError> {
    value
        .get("data")
        .and_then(Value::as_object)
        .map(|active| active.contains_key(session_id))
        .ok_or_else(|| {
            DaemonError::Rpc(
                "OpenCode native active sessions response did not contain a data object"
                    .to_string(),
            )
        })
}

pub(crate) fn terminal_outcome(messages: &[Value]) -> Result<(), DaemonError> {
    if let Some(idle) = messages
        .iter()
        .rev()
        .find(|message| message["type"] == "idle")
    {
        match idle["outcome"].as_str() {
            Some("failed") | Some("interrupted") => {
                let message = idle
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or(if idle["outcome"] == "interrupted" {
                        "OpenCode turn interrupted"
                    } else {
                        "OpenCode turn failed"
                    });
                return Err(DaemonError::Rpc(format!("OpenCode reported: {message}")));
            }
            Some("succeeded") => return Ok(()),
            _ => {}
        }
    }
    Err(DaemonError::Rpc(
        "OpenCode became idle without a terminal outcome for the admitted input".to_string(),
    ))
}

fn messages_path(session_id: &str, cursor: Option<&str>) -> String {
    let mut url = reqwest::Url::parse("http://localhost").expect("static URL is valid");
    url.set_path(&format!("/api/session/{session_id}/message"));
    let mut query = url.query_pairs_mut();
    query.append_pair("limit", &MAX_MESSAGE_PAGE_SIZE.to_string());
    if let Some(cursor) = cursor {
        query.append_pair("cursor", cursor);
    } else {
        query.append_pair("order", "desc");
    }
    drop(query);
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

fn prompt_request_body(message_id: &str, prompt: Value, delivery: Delivery) -> Value {
    let mut body = prompt;
    body["id"] = json!(message_id);
    body["delivery"] = json!(delivery.as_str());
    body["resume"] = json!(true);
    body
}

fn response_message_page(value: Value) -> Result<MessagePage, DaemonError> {
    let next = value
        .pointer("/cursor/next")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let messages = response_data_array(value, "messages")?;
    Ok(MessagePage { messages, next })
}

fn model_ref(model: &str) -> Option<Value> {
    let (provider_id, id) = model.split_once('/')?;
    (!provider_id.is_empty() && !id.is_empty())
        .then(|| json!({ "providerID": provider_id, "id": id }))
}

/// One entry of the v2 runner's model registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerModel {
    /// Reasoning variant ids the runner accepts alongside this model.
    pub variants: Vec<String>,
}

/// `provider/model` → what the runner will accept for it.
///
/// Only enabled catalog entries may be selected. Reasoning variants come
/// from this same live registry, rather than a separate preview catalog.
fn runner_models(value: &Value) -> Result<HashMap<String, RunnerModel>, DaemonError> {
    let models = value.get("data").and_then(Value::as_array).ok_or_else(|| {
        DaemonError::Rpc(
            "OpenCode native model registry response did not contain a data array".to_string(),
        )
    })?;
    Ok(models
        .iter()
        .filter_map(|model| {
            let id = model.get("id").and_then(Value::as_str)?;
            let provider_id = model.get("providerID").and_then(Value::as_str)?;
            let variants = model
                .get("variants")
                .and_then(Value::as_array)
                .map(|variants| {
                    variants
                        .iter()
                        .filter_map(|variant| {
                            variant
                                .as_str()
                                .or_else(|| variant.get("id").and_then(Value::as_str))
                                .map(str::to_owned)
                        })
                        .collect()
                })
                .unwrap_or_default();
            if model.get("enabled").and_then(Value::as_bool) == Some(false) {
                return None;
            }
            Some((format!("{provider_id}/{id}"), RunnerModel { variants }))
        })
        .collect())
}

/// The variant to send with a model, given what the runner accepts: the
/// requested effort, or `None` when the runner would reject it.
pub fn runner_variant<'a>(effort: Option<&'a str>, model: Option<&RunnerModel>) -> Option<&'a str> {
    let effort = effort?;
    // V2's base settings apply when no preset is selected. This is valid even
    // when the catalog does not enumerate a variant called "default".
    if effort == "default" {
        return None;
    }
    // Unavailable models are blocked separately. The synthetic default model
    // has no preset picker; retaining an old model's effort here could override
    // its configured default with a variant that the new model cannot run.
    let model = model?;
    model
        .variants
        .iter()
        .any(|variant| variant == effort)
        .then_some(effort)
}

/// Refuse unavailable or disabled models before admitting a prompt. Unlike
/// the 1.x preview, OpenCode 2's model registry is the execution catalog.
pub fn native_model_block_reason(
    session_model: Option<&str>,
    runner_models: &HashMap<String, RunnerModel>,
) -> Option<String> {
    let Some(model_id) = session_model else {
        return Some(
            "OpenCode has no model selected; choose a model or configure a default".to_string(),
        );
    };
    (!runner_models.contains_key(model_id)).then(|| format!(
        "OpenCode does not list '{model_id}' as an enabled model; check its provider credentials and model configuration"
    ))
}

/// Requests and consumed schemas validated against the running server before
/// choosing native transport. OpenCode 1.x and incompatible builds use ACP.
const CONTRACT_ENDPOINTS: &[(&str, &str)] = &[
    ("/api/info", "get"),
    ("/api/model", "get"),
    ("/api/agent", "get"),
    ("/api/model/default", "get"),
    ("/api/session", "post"),
    ("/api/session/active", "get"),
    ("/api/session/{sessionID}", "get"),
    ("/api/session/{sessionID}", "delete"),
    ("/api/session/{sessionID}/prompt", "post"),
    ("/api/session/{sessionID}/message", "get"),
    ("/api/session/{sessionID}/model", "post"),
    ("/api/session/{sessionID}/agent", "post"),
    ("/api/session/{sessionID}/interrupt", "post"),
    ("/api/session/{sessionID}/permission", "get"),
    (
        "/api/session/{sessionID}/permission/{requestID}/reply",
        "post",
    ),
    ("/api/session/{sessionID}/form", "get"),
    ("/api/session/{sessionID}/form/{formID}", "get"),
    ("/api/session/{sessionID}/form/{formID}/reply", "post"),
    ("/api/experimental/session/{sessionID}/wait", "post"),
];

/// Request fields the durable prompt admission body must accept. Older
/// OpenCode builds reject `resume` (the body is `additionalProperties:
/// false`), which would otherwise surface only after a thread is pinned to
/// the native transport.
const CONTRACT_PROMPT_FIELDS: &[&str] = &["id", "text", "files", "delivery", "resume"];

/// Request-body properties the native transport sends, per `(path, method)`.
///
/// Every entry is an assumption OpenCode could drop without breaking any of
/// its own clients, and whose loss would otherwise show up as a 400 on a real
/// user's turn rather than at attach.
const CONTRACT_BODY_FIELDS: &[(&str, &[&str])] = &[
    ("/api/session", &["agent", "model", "location"]),
    ("/api/session/{sessionID}/model", &["model"]),
    ("/api/session/{sessionID}/agent", &["agent"]),
    (
        "/api/session/{sessionID}/permission/{requestID}/reply",
        &["decision"],
    ),
    ("/api/session/{sessionID}/form/{formID}/reply", &["answer"]),
];

/// Named schemas whose properties FalconDeck populates by hand.
const CONTRACT_SCHEMA_FIELDS: &[(&str, &[&str])] = &[
    ("Model.Ref", &["id", "providerID"]),
    ("Model.Info", &["id", "providerID", "enabled", "variants"]),
    (
        "Session.Inbox.User",
        &["id", "sessionID", "payload", "delivery"],
    ),
    (
        "Session.Message.Assistant",
        &["id", "type", "content", "time"],
    ),
    ("Session.Message.Idle", &["id", "type", "outcome"]),
    ("Form.Info", &["id", "fields"]),
    ("Form.Reply", &["answer"]),
];

/// String values FalconDeck sends verbatim. A renamed variant would be
/// accepted by the schema check above and rejected at runtime.
const CONTRACT_ENUM_VALUES: &[(&str, &[&str])] =
    &[("Permission.Reply", &["once", "always", "reject"])];

/// Resolves a possibly-`$ref`'d schema against the document's components.
fn resolve_schema<'a>(doc: &'a Value, schema: &'a Value) -> Option<&'a Value> {
    let Some(reference) = schema.get("$ref").and_then(Value::as_str) else {
        return Some(schema);
    };
    let name = reference.strip_prefix("#/components/schemas/")?;
    doc.pointer(&format!("/components/schemas/{name}"))
}

fn request_body_schema<'a>(doc: &'a Value, paths: &'a Value, path: &str) -> Option<&'a Value> {
    let schema = paths
        .get(path)?
        .get("post")?
        .get("requestBody")?
        .get("content")?
        .get("application/json")?
        .get("schema")?;
    resolve_schema(doc, schema)
}

fn contract_supported(doc: &Value) -> Result<(), DaemonError> {
    let paths = doc
        .get("paths")
        .filter(|paths| paths.is_object())
        .ok_or_else(|| {
            DaemonError::Rpc("OpenCode /openapi.json had no paths object".to_string())
        })?;
    for (path, method) in CONTRACT_ENDPOINTS {
        if !paths
            .get(*path)
            .and_then(|endpoint| endpoint.get(*method))
            .is_some_and(Value::is_object)
        {
            return Err(DaemonError::Rpc(format!(
                "OpenCode /openapi.json is missing {method} {path}"
            )));
        }
    }
    // Path keys carry a leading slash, so JSON Pointer notation cannot
    // address them; navigate explicitly instead.
    let prompt_properties = paths
        .get("/api/session/{sessionID}/prompt")
        .and_then(|operation| operation.get("post"))
        .and_then(|post| post.get("requestBody"))
        .and_then(|body| body.get("content"))
        .and_then(|content| content.get("application/json"))
        .and_then(|media| media.get("schema"))
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            DaemonError::Rpc(
                "OpenCode /openapi.json did not describe the prompt request body".to_string(),
            )
        })?;
    for field in CONTRACT_PROMPT_FIELDS {
        if !prompt_properties.contains_key(*field) {
            return Err(DaemonError::Rpc(format!(
                "OpenCode prompt admission does not accept the {field} field"
            )));
        }
    }
    let message_parameters = paths
        .get("/api/session/{sessionID}/message")
        .and_then(|operation| operation.get("get"))
        .and_then(|get| get.get("parameters"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DaemonError::Rpc(
                "OpenCode /openapi.json did not describe the message list query".to_string(),
            )
        })?;
    for parameter in ["cursor", "limit", "order"] {
        if !message_parameters
            .iter()
            .any(|entry| entry.get("name").and_then(Value::as_str) == Some(parameter))
        {
            return Err(DaemonError::Rpc(format!(
                "OpenCode message listing does not support the {parameter} query parameter"
            )));
        }
    }
    for (path, fields) in CONTRACT_BODY_FIELDS {
        let properties = request_body_schema(doc, paths, path)
            .and_then(|schema| schema.get("properties"))
            .and_then(Value::as_object)
            .ok_or_else(|| {
                DaemonError::Rpc(format!(
                    "OpenCode /openapi.json did not describe the {path} body"
                ))
            })?;
        for field in *fields {
            if !properties.contains_key(*field) {
                return Err(DaemonError::Rpc(format!(
                    "OpenCode {path} does not accept the {field} field"
                )));
            }
        }
    }
    for (name, fields) in CONTRACT_SCHEMA_FIELDS {
        let properties = doc
            .pointer(&format!("/components/schemas/{name}/properties"))
            .and_then(Value::as_object)
            .ok_or_else(|| {
                DaemonError::Rpc(format!(
                    "OpenCode /openapi.json no longer defines the {name} schema"
                ))
            })?;
        for field in *fields {
            if !properties.contains_key(*field) {
                return Err(DaemonError::Rpc(format!(
                    "OpenCode {name} no longer carries the {field} field"
                )));
            }
        }
    }
    for (name, values) in CONTRACT_ENUM_VALUES {
        let declared = doc
            .pointer(&format!("/components/schemas/{name}/enum"))
            .and_then(Value::as_array)
            .ok_or_else(|| {
                DaemonError::Rpc(format!(
                    "OpenCode /openapi.json no longer defines the {name} enum"
                ))
            })?;
        for value in *values {
            if !declared.iter().any(|entry| entry.as_str() == Some(value)) {
                return Err(DaemonError::Rpc(format!(
                    "OpenCode {name} no longer accepts the '{value}' value"
                )));
            }
        }
    }
    let delivery = doc
        .pointer("/components/schemas/Session.Inbox.Delivery/enum")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DaemonError::Rpc("OpenCode schema did not declare prompt delivery values".to_string())
        })?;
    for value in [Delivery::Queue.as_str(), Delivery::Steer.as_str()] {
        if !delivery.iter().any(|entry| entry.as_str() == Some(value)) {
            return Err(DaemonError::Rpc(format!(
                "OpenCode prompt delivery no longer accepts '{value}'"
            )));
        }
    }
    Ok(())
}

/// Crash-orphan registry for `opencode serve` children.
///
/// `opencode serve` does not exit when its parent dies, so a daemon that goes
/// down ungracefully (crash, force-quit of the desktop app, SIGKILL) strands
/// every server it spawned — observed live as ~55 orphans holding ~5GB, which
/// is exactly the memory pressure that forced optional providers lazy. Each
/// spawn records `{server_pid, daemon_pid}` here; the next daemon startup
/// kills entries whose owning daemon is gone. Graceful shutdown paths and
/// `kill_on_drop` still handle the in-process cases.
/// Substrings that must appear in a live command line before a registered
/// pid is treated as this daemon's `opencode serve`.
fn server_markers() -> Vec<String> {
    vec!["opencode".to_string(), " serve".to_string()]
}

/// Records a freshly spawned server against this daemon process.
pub fn register_server_process(state_dir: &std::path::Path, server_pid: u32) {
    crate::agent_orphans::register(
        state_dir,
        crate::agent_orphans::OPENCODE_REGISTRY_FILE,
        server_pid,
        server_markers(),
    );
}

/// Drops a server this daemon stopped on purpose.
pub fn forget_server_process(state_dir: &std::path::Path, server_pid: u32) {
    crate::agent_orphans::forget(
        state_dir,
        crate::agent_orphans::OPENCODE_REGISTRY_FILE,
        server_pid,
    );
}

/// Kills servers whose owning daemon is gone. Run once at daemon startup,
/// off the readiness path (it shells out to `ps`/`kill`).
pub async fn reap_orphaned_servers(state_dir: &std::path::Path) {
    crate::agent_orphans::reap(
        state_dir,
        crate::agent_orphans::OPENCODE_REGISTRY_FILE,
        "opencode serve",
    )
    .await;
}

fn session_create_body(cwd: &str, model: Option<&str>, agent: Option<&str>) -> Value {
    let mut body = json!({ "location": { "directory": cwd } });
    // OpenCode model ids are provider-qualified. Do not guess a provider for
    // the synthetic default entry: omitting it preserves the user's config.
    if let Some(model) = model.and_then(model_ref) {
        body["model"] = model;
    }
    if let Some(agent) = agent.filter(|agent| !agent.is_empty()) {
        body["agent"] = json!(agent);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_drains_stderr_before_the_listening_banner() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let router = axum::Router::new().route(
                "/api/info",
                axum::routing::get(|| async { axum::Json(json!({"ok":true})) }),
            );
            axum::serve(listener, router).await.unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("noisy-server.sh");
        std::fs::write(
            &script,
            format!(
                r#"
            i=0
            while [ "$i" -lt 20000 ]; do
                printf 'startup diagnostic before listening\n'
                i=$((i + 1))
            done >&2
            printf 'server listening on http://127.0.0.1:{port}\n'
            exec sleep 30
        "#
            ),
        )
        .unwrap();
        let started = OpenCodeRuntime::spawn(
            &["/bin/sh".into(), script.to_string_lossy().into_owned()],
            &temp.path().to_string_lossy(),
            &HashMap::new(),
        )
        .await;
        server.abort();
        let runtime = started.expect("startup diagnostics must not block the listening banner");
        runtime.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn private_server_shutdown_and_drop_close_descendant_pipes() {
        for explicit_shutdown in [true, false] {
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", "sleep 30 & echo ready; wait"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .process_group(0);
            let mut child = command.spawn().unwrap();
            let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
            assert_eq!(stdout.next_line().await.unwrap().as_deref(), Some("ready"));
            let runtime = OpenCodeRuntime {
                base_url: "http://127.0.0.1:1".into(),
                password: "test".into(),
                client: reqwest::Client::new(),
                server_pid: child.id(),
                child: Mutex::new(child),
                activity: crate::activity::ActivityClock::new(),
                served_prompt: std::sync::atomic::AtomicBool::new(false),
            };
            if explicit_shutdown {
                runtime.shutdown().await;
            }
            drop(runtime);
            // Killing just the parent leaves sleep holding stdout open.
            assert!(
                timeout(Duration::from_secs(2), stdout.next_line())
                    .await
                    .unwrap()
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn only_a_terminal_outcome_after_admission_settles_a_turn() {
        assert!(terminal_outcome(&[json!({"type":"assistant","time":{"completed":1}})]).is_err());
        assert!(terminal_outcome(&[json!({"type":"idle","outcome":"succeeded"})]).is_ok());
        let error = terminal_outcome(&[
            json!({"type":"idle","outcome":"failed","error":{"message":"provider failure"}}),
        ])
        .unwrap_err();
        assert!(error.to_string().contains("provider failure"));
        assert!(
            terminal_outcome(&[json!({"type":"idle","outcome":"interrupted"})])
                .unwrap_err()
                .to_string()
                .contains("interrupted")
        );
    }

    #[test]
    fn a_native_turn_only_sends_variants_the_runner_accepts() {
        let registry = runner_models(&json!({
            "data": [
                {
                    "id": "google/gemini-3.7-flash",
                    "providerID": "openrouter",
                    "api": { "type": "aisdk", "package": "@openrouter/ai-sdk-provider" },
                    "variants": []
                },
                {
                    "id": "gpt-5.2",
                    "providerID": "opencode",
                    "api": { "type": "aisdk", "package": "@ai-sdk/openai-compatible" },
                    "variants": ["low", { "id": "high" }]
                },
                {
                    "id": "no-variants-field",
                    "providerID": "opencode",
                    "api": { "type": "aisdk", "package": "@ai-sdk/openai-compatible" }
                }
            ]
        }))
        .unwrap();

        let gemini = registry.get("openrouter/google/gemini-3.7-flash");
        let gpt = registry.get("opencode/gpt-5.2");
        // Never send an effort that this model does not advertise.
        assert_eq!(runner_variant(Some("medium"), gemini), None);
        assert_eq!(runner_variant(Some("high"), gpt), Some("high"));
        assert_eq!(runner_variant(Some("max"), gpt), None);
        assert_eq!(runner_variant(None, gpt), None);
        assert_eq!(runner_variant(Some("default"), gpt), None);
        assert_eq!(
            runner_variant(Some("low"), registry.get("opencode/no-variants-field")),
            None
        );
        // A stale effort must not leak through the synthetic default entry.
        assert_eq!(runner_variant(Some("medium"), None), None);
    }

    #[test]
    fn parses_the_ephemeral_server_port() {
        assert_eq!(
            parse_listening_port("server listening on http://127.0.0.1:54499"),
            Some(54499)
        );
        assert_eq!(parse_listening_port("not a server"), None);
        assert_eq!(parse_listening_port("unrelated diagnostic:54499"), None);
    }

    #[test]
    fn delivery_uses_the_native_wire_values() {
        assert_eq!(Delivery::Queue.as_str(), "queue");
        assert_eq!(Delivery::Steer.as_str(), "steer");
    }

    #[test]
    fn prompt_admission_resumes_the_agent_loop() {
        assert_eq!(
            prompt_request_body("msg_test", json!({ "text": "hello" }), Delivery::Queue),
            json!({
                "id": "msg_test",
                "text": "hello",
                "delivery": "queue",
                "resume": true,
            })
        );
    }

    #[test]
    fn compatibility_arrays_reject_changed_response_shapes() {
        let error = response_data_array(json!({ "messages": [] }), "messages").unwrap_err();
        assert!(error.to_string().contains("did not contain a data array"));
    }

    #[test]
    fn active_sessions_require_the_native_data_object() {
        assert!(
            session_is_active(
                &json!({ "data": { "ses_busy": { "type": "running" } } }),
                "ses_busy"
            )
            .unwrap()
        );
        assert!(!session_is_active(&json!({ "data": {} }), "ses_idle").unwrap());
        assert!(session_is_active(&json!({ "sessions": {} }), "ses_busy").is_err());
    }

    #[test]
    fn message_query_respects_opencode_page_limit() {
        assert_eq!(
            messages_path("ses_test", None),
            "/api/session/ses_test/message?limit=200&order=desc"
        );
        assert_eq!(
            messages_path("ses_test", Some("older page/+")),
            "/api/session/ses_test/message?limit=200&cursor=older+page%2F%2B"
        );
    }

    #[test]
    fn message_page_preserves_descending_data_and_next_cursor() {
        let page = response_message_page(json!({
            "data": [
                { "id": "msg_newest" },
                { "id": "msg_older" }
            ],
            "cursor": { "previous": "cursor_newer", "next": "cursor_older" }
        }))
        .unwrap();
        assert_eq!(page.messages[0]["id"], "msg_newest");
        assert_eq!(page.messages[1]["id"], "msg_older");
        // `next` continues a newest-first walk toward older items; the
        // `previous` cursor points back toward newer items and must not be
        // used as the continuation.
        assert_eq!(page.next.as_deref(), Some("cursor_older"));
        assert!(
            response_message_page(json!({
                "data": [],
                "cursor": { "previous": null, "next": null }
            }))
            .unwrap()
            .next
            .is_none()
        );
    }

    #[test]
    fn desc_collector_finds_an_admitted_message_on_a_later_page() {
        let mut collector = DescCollector::default();
        let newer = vec![
            json!({ "id": "msg_assistant_new" }),
            json!({ "id": "msg_admitted" }),
            json!({ "id": "msg_user_older" }),
        ];
        assert!(collector.push_page(newer, "msg_admitted"));
        // Only the records after the admitted message survive, and the
        // collector reverses them once via the caller.
        assert_eq!(
            collector
                .newest_first
                .iter()
                .map(|message| message["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["msg_assistant_new"]
        );

        // A page that does not contain the admitted message accumulates in
        // newest-first order for the next older page.
        let mut collector = DescCollector::default();
        let page = vec![json!({ "id": "msg_c" }), json!({ "id": "msg_b" })];
        assert!(!collector.push_page(page, "msg_admitted"));
        let page = vec![json!({ "id": "msg_a" }), json!({ "id": "msg_admitted" })];
        assert!(collector.push_page(page, "msg_admitted"));
        let mut messages = collector.newest_first;
        messages.reverse();
        assert_eq!(
            messages
                .iter()
                .map(|message| message["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["msg_a", "msg_b", "msg_c"]
        );
    }

    #[test]
    fn contract_validation_requires_prompt_fields_and_wait() {
        let doc = contract_doc_fixture();
        if let Err(error) = contract_supported(&doc) {
            panic!("fixture doc must validate: {error}");
        }

        let mut missing_resume = doc.clone();
        {
            let paths = missing_resume
                .get_mut("paths")
                .expect("fixture keeps paths")
                .as_object_mut()
                .expect("fixture paths is an object");
            let prompt = paths
                .get_mut("/api/session/{sessionID}/prompt")
                .expect("fixture keeps prompt path");
            let properties = prompt
                .get_mut("post")
                .and_then(|post| post.get_mut("requestBody"))
                .and_then(|body| body.get_mut("content"))
                .and_then(|content| content.get_mut("application/json"))
                .and_then(|media| media.get_mut("schema"))
                .and_then(|schema| schema.get_mut("properties"))
                .expect("fixture keeps prompt properties");
            properties
                .as_object_mut()
                .expect("fixture properties is an object")
                .remove("resume");
        }
        let error = contract_supported(&missing_resume).unwrap_err();
        assert!(error.to_string().contains("resume"));

        let mut missing_delete = doc.clone();
        missing_delete
            .pointer_mut("/paths")
            .and_then(Value::as_object_mut)
            .unwrap()
            .remove("/api/experimental/session/{sessionID}/wait");
        let error = contract_supported(&missing_delete).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("/api/experimental/session/{sessionID}/wait")
        );

        assert!(contract_supported(&json!({ "openapi": "3.1.0" })).is_err());
    }

    /// A minimal `/openapi.json` that satisfies every contract rule.
    ///
    /// Built from the same constant tables the validator reads, so it proves
    /// only that `contract_supported` accepts a document of the shape we
    /// believe OpenCode publishes, and rejects one missing a field we send.
    /// Whether OpenCode *actually* publishes that shape is not knowable from a
    /// fixture — `examples/opencode_conformance` answers that against a real
    /// server, and is the check that catches an upstream change.
    fn contract_doc_fixture() -> Value {
        fn body(fields: &[&str], extra: Option<Value>) -> Value {
            let mut properties = fields
                .iter()
                .map(|field| (field.to_string(), json!({ "type": "string" })))
                .collect::<serde_json::Map<_, _>>();
            if let Some(Value::Object(extra)) = extra {
                properties.extend(extra);
            }
            json!({
                "post": {
                    "requestBody": {
                        "content": { "application/json": { "schema": { "properties": properties } } }
                    }
                }
            })
        }

        let mut paths = json!({});
        for (path, method) in CONTRACT_ENDPOINTS {
            if paths.get(*path).is_none() {
                paths[path] = json!({});
            }
            paths[path][method] = json!({"responses":{}});
        }
        for (path, fields) in CONTRACT_BODY_FIELDS {
            paths[path]["post"] = body(fields, None)["post"].clone();
        }
        paths["/api/session/{sessionID}/prompt"] = body(
            CONTRACT_PROMPT_FIELDS,
            Some(json!({
                "delivery": { "enum": [Delivery::Queue.as_str(), Delivery::Steer.as_str()] }
            })),
        );
        paths["/api/session/{sessionID}/message"] = json!({
            "get": {
                "parameters": [
                    { "name": "limit", "in": "query" },
                    { "name": "order", "in": "query" },
                    { "name": "cursor", "in": "query" }
                ]
            }
        });
        let mut schemas = CONTRACT_SCHEMA_FIELDS
            .iter()
            .map(|(name, fields)| {
                let properties = fields
                    .iter()
                    .map(|field| (field.to_string(), json!({ "type": "string" })))
                    .collect::<serde_json::Map<_, _>>();
                (name.to_string(), json!({ "properties": properties }))
            })
            .collect::<serde_json::Map<_, _>>();
        for (name, values) in CONTRACT_ENUM_VALUES {
            schemas.insert(name.to_string(), json!({ "enum": values }));
        }
        schemas.insert(
            "Session.Inbox.Delivery".to_string(),
            json!({"enum":["queue","steer"]}),
        );
        json!({
            "openapi": "3.1.0",
            "paths": paths,
            "components": { "schemas": schemas }
        })
    }

    /// Each contract rule must actually reject a document that breaks it;
    /// a validator that passes everything is the failure mode being guarded.
    #[test]
    fn contract_validation_rejects_each_dropped_assumption() {
        let strip = |mutate: &dyn Fn(&mut Value)| {
            let mut doc = contract_doc_fixture();
            mutate(&mut doc);
            contract_supported(&doc).expect_err("a dropped assumption must fail the contract")
        };

        let error = strip(&|doc| {
            doc["paths"]["/api/session/{sessionID}"]
                .as_object_mut()
                .unwrap()
                .remove("delete");
        });
        assert!(error.to_string().contains("delete"), "{error}");

        let error = strip(&|doc| {
            doc["paths"]["/api/session"]["post"]["requestBody"]["content"]["application/json"]
                ["schema"]["properties"]
                .as_object_mut()
                .expect("fixture body is an object")
                .remove("model");
        });
        assert!(error.to_string().contains("model"), "{error}");

        let error = strip(&|doc| {
            doc["components"]["schemas"]["Model.Ref"]["properties"]
                .as_object_mut()
                .expect("fixture schema is an object")
                .remove("providerID");
        });
        assert!(error.to_string().contains("providerID"), "{error}");

        let error = strip(&|doc| {
            doc["components"]["schemas"]["Permission.Reply"]["enum"] = json!(["once", "always"]);
        });
        assert!(error.to_string().contains("reject"), "{error}");

        let error = strip(&|doc| {
            doc["components"]["schemas"]["Session.Inbox.Delivery"]["enum"] = json!(["queue"]);
        });
        assert!(error.to_string().contains("steer"), "{error}");
    }

    #[test]
    fn session_creation_preserves_native_defaults_unless_overridden() {
        assert_eq!(
            session_create_body("/work", Some("default"), None),
            json!({ "location": { "directory": "/work" } })
        );
        assert_eq!(
            session_create_body("/work", Some("openrouter/x-ai/grok-4.6"), Some("plan")),
            json!({
                "location": { "directory": "/work" },
                "model": { "providerID": "openrouter", "id": "x-ai/grok-4.6" },
                "agent": "plan"
            })
        );
    }
}
