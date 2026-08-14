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

use crate::error::DaemonError;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const INACTIVE_TERMINAL_GRACE: Duration = Duration::from_secs(5);
const POLL_ERROR_GRACE: Duration = Duration::from_secs(5);
const LISTENING_PREFIX: &str = "opencode server listening on http://127.0.0.1:";
const MAX_MESSAGE_PAGE_SIZE: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Queue,
    Steer,
}

enum SessionPoll {
    Active,
    Inactive(Vec<Value>),
}

struct MessagePage {
    messages: Vec<Value>,
    previous: Option<String>,
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
            .current_dir(cwd)
            .envs(env)
            // These must follow the user-supplied environment: allowing a
            // provider config to replace either value would expose an
            // unauthenticated or unexpectedly credentialed local server.
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .env("OPENCODE_SERVER_USERNAME", "opencode")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            DaemonError::Process(format!(
                "failed to start OpenCode server '{}': {error}",
                configured_command.join(" ")
            ))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            DaemonError::Process("OpenCode server did not expose stdout".to_string())
        })?;
        let (port_tx, port_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(monitor_stdout(stdout, port_tx));
        let port = match timeout(STARTUP_TIMEOUT, port_rx).await {
            Ok(Ok(port)) => port,
            Ok(Err(_)) => {
                let _ = child.kill().await;
                return Err(DaemonError::Process(
                    "OpenCode server exited before reporting its port".to_string(),
                ));
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err(DaemonError::Process(
                    "OpenCode server did not report a localhost port in time".to_string(),
                ));
            }
        };
        // Keep draining stderr so a noisy server cannot block.  Diagnostics
        // remain in the daemon log rather than being silently discarded.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(%line, "OpenCode server stderr");
                }
            });
        }
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
        });
        if let Err(error) = runtime.health().await {
            runtime.shutdown().await;
            return Err(error);
        }
        Ok(runtime)
    }

    pub async fn health(&self) -> Result<Value, DaemonError> {
        self.request(reqwest::Method::GET, "/global/health", None)
            .await
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
        value
            .pointer("/data/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                DaemonError::Rpc("OpenCode session creation returned no session id".to_string())
            })
    }

    /// Native model catalog. This response is intentionally kept inside the
    /// daemon: provider records may contain credentials that must never be
    /// projected into a FalconDeck snapshot.
    pub async fn provider_catalog(&self) -> Result<Value, DaemonError> {
        self.request(reqwest::Method::GET, "/config/providers", None)
            .await
    }

    pub async fn agents(&self) -> Result<Vec<Value>, DaemonError> {
        let value = self
            .request(reqwest::Method::GET, "/api/agent", None)
            .await?;
        response_data_array(value, "agents")
    }

    pub async fn set_model(&self, session_id: &str, model: &str) -> Result<(), DaemonError> {
        let Some(model) = model_ref(model) else {
            // The synthetic `default` catalog entry deliberately preserves
            // OpenCode's own configured model.
            return Ok(());
        };
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
        let mut prompt = json!({ "text": text });
        if !files.is_empty() {
            prompt["files"] = Value::Array(files.to_vec());
        }
        self.request(
            reqwest::Method::POST,
            &format!("/api/session/{session_id}/prompt"),
            Some(json!({
                "id": message_id,
                "prompt": prompt,
                "delivery": delivery.as_str(),
            })),
        )
        .await
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

    pub async fn wait_until_idle(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Vec<Value>, DaemonError> {
        // OpenCode 1.18 advertises `session.wait`, but the route returns 503
        // (`Session wait is not available yet`). Poll the implemented active
        // drain instead. Checking the admitted message as well prevents an
        // accepted queued prompt from looking idle before its drain starts.
        let mut inactive_since = None;
        let mut inactive_messages = None;
        let mut poll_error_since = None;
        loop {
            let poll = match self.poll_session(session_id, message_id).await {
                Ok(poll) => {
                    poll_error_since = None;
                    poll
                }
                Err(error) => {
                    let since = poll_error_since.get_or_insert_with(tokio::time::Instant::now);
                    if since.elapsed() >= POLL_ERROR_GRACE {
                        return Err(error);
                    }
                    tokio::time::sleep(IDLE_POLL_INTERVAL).await;
                    continue;
                }
            };
            let SessionPoll::Inactive(messages) = poll else {
                inactive_since = None;
                inactive_messages = None;
                tokio::time::sleep(IDLE_POLL_INTERVAL).await;
                continue;
            };
            if messages_are_settled(&messages) {
                return Ok(messages);
            }
            if inactive_messages.as_ref() != Some(&messages) {
                inactive_since = Some(tokio::time::Instant::now());
                inactive_messages = Some(messages);
            } else if inactive_since.is_some_and(|since| since.elapsed() >= INACTIVE_TERMINAL_GRACE)
            {
                return Err(DaemonError::Rpc(
                    "OpenCode session became idle without a terminal assistant response"
                        .to_string(),
                ));
            }
            tokio::time::sleep(IDLE_POLL_INTERVAL).await;
        }
    }

    async fn poll_session(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<SessionPoll, DaemonError> {
        if self.session_is_active(session_id).await? {
            Ok(SessionPoll::Active)
        } else {
            self.messages_since(session_id, message_id)
                .await
                .map(SessionPoll::Inactive)
        }
    }

    pub async fn session_is_active(&self, session_id: &str) -> Result<bool, DaemonError> {
        let value = self
            .request(reqwest::Method::GET, "/api/session/active", None)
            .await?;
        session_is_active(&value, session_id)
    }

    pub async fn messages(&self, session_id: &str) -> Result<Vec<Value>, DaemonError> {
        let mut messages = self.message_page(session_id, None).await?.messages;
        messages.reverse();
        Ok(messages)
    }

    async fn messages_since(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Vec<Value>, DaemonError> {
        let mut cursor = None;
        let mut seen_cursors = HashSet::new();
        let mut newest_first = Vec::new();
        loop {
            let page = self.message_page(session_id, cursor.as_deref()).await?;
            let admitted_index = page
                .messages
                .iter()
                .position(|message| message.get("id").and_then(Value::as_str) == Some(message_id));
            if let Some(admitted_index) = admitted_index {
                newest_first.extend(page.messages.into_iter().take(admitted_index));
                newest_first.reverse();
                return Ok(newest_first);
            }
            newest_first.extend(page.messages);
            let Some(previous) = page.previous else {
                return Err(DaemonError::Rpc(
                    "OpenCode admitted the prompt but did not project its user message".to_string(),
                ));
            };
            if !seen_cursors.insert(previous.clone()) {
                return Err(DaemonError::Rpc(
                    "OpenCode repeated a message pagination cursor".to_string(),
                ));
            }
            cursor = Some(previous);
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
            Some(json!({ "reply": reply })),
        )
        .await
        .map(|_| ())
    }

    pub async fn pending_questions(&self, session_id: &str) -> Result<Vec<Value>, DaemonError> {
        let value = self
            .request(
                reqwest::Method::GET,
                &format!("/api/session/{session_id}/question"),
                None,
            )
            .await?;
        response_data_array(value, "questions")
    }

    pub async fn reply_question(
        &self,
        session_id: &str,
        request_id: &str,
        answers: Vec<Vec<String>>,
    ) -> Result<(), DaemonError> {
        self.request(
            reqwest::Method::POST,
            &format!("/api/session/{session_id}/question/{request_id}/reply"),
            Some(json!({ "answers": answers })),
        )
        .await
        .map(|_| ())
    }

    pub async fn shutdown(&self) {
        let _ = self.child.lock().await.kill().await;
    }

    async fn request(
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
        let response = request.send().await.map_err(|error| {
            DaemonError::Process(format!("OpenCode native request failed: {error}"))
        })?;
        let status = response.status();
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

fn messages_are_settled(messages: &[Value]) -> bool {
    let Some(message) = messages
        .iter()
        .rev()
        .find(|message| message.get("type").and_then(Value::as_str) == Some("assistant"))
    else {
        return false;
    };
    message
        .pointer("/time/completed")
        .is_some_and(|completed| !completed.is_null())
        || message.get("error").is_some_and(|error| !error.is_null())
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

fn response_message_page(value: Value) -> Result<MessagePage, DaemonError> {
    let previous = value
        .pointer("/cursor/previous")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let messages = response_data_array(value, "messages")?;
    Ok(MessagePage { messages, previous })
}

fn model_ref(model: &str) -> Option<Value> {
    let (provider_id, id) = model.split_once('/')?;
    (!provider_id.is_empty() && !id.is_empty())
        .then(|| json!({ "providerID": provider_id, "id": id }))
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

    #[test]
    fn parses_the_ephemeral_server_port() {
        assert_eq!(
            parse_listening_port("opencode server listening on http://127.0.0.1:54499"),
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
    fn admitted_message_settles_only_after_a_terminal_assistant_message() {
        let messages =
            vec![json!({ "id": "msg_assistant", "type": "assistant", "time": { "created": 1 } })];
        assert!(!messages_are_settled(&messages));

        let mut completed = messages.clone();
        completed[0]["time"]["completed"] = json!(2);
        assert!(messages_are_settled(&completed));

        completed.push(
            json!({ "id": "msg_still_running", "type": "assistant", "time": { "created": 3 } }),
        );
        assert!(!messages_are_settled(&completed));

        let failed = vec![
            json!({ "id": "msg_assistant", "type": "assistant", "error": { "name": "APIError" } }),
        ];
        assert!(messages_are_settled(&failed));
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
    fn message_page_preserves_descending_data_and_previous_cursor() {
        let page = response_message_page(json!({
            "data": [
                { "id": "msg_newest" },
                { "id": "msg_older" }
            ],
            "cursor": { "previous": "cursor_older", "next": null }
        }))
        .unwrap();
        assert_eq!(page.messages[0]["id"], "msg_newest");
        assert_eq!(page.messages[1]["id"], "msg_older");
        assert_eq!(page.previous.as_deref(), Some("cursor_older"));
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
