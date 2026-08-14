//! Native OpenCode HTTP transport.
//!
//! This deliberately lives beside, rather than inside, the generic ACP
//! adapter.  OpenCode's server owns durable sessions and exposes delivery
//! (`queue`/`steer`) semantics which ACP cannot represent.  Callers must keep
//! an ACP fallback: an HTTP request is only safe to retry after its admission
//! status has been established.

use std::{collections::HashMap, process::Stdio, sync::Arc};

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
const LISTENING_PREFIX: &str = "opencode server listening on http://127.0.0.1:";
const MAX_MESSAGE_PAGE_SIZE: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Queue,
    Steer,
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

    pub async fn wait_until_idle(&self, session_id: &str) -> Result<(), DaemonError> {
        // The server deliberately holds this request until the session is
        // idle, so it must not use the ordinary control-plane timeout.
        self.request_inner(
            reqwest::Method::POST,
            &format!("/api/session/{session_id}/wait"),
            None,
            None,
        )
        .await
        .map(|_| ())
    }

    pub async fn messages(&self, session_id: &str) -> Result<Vec<Value>, DaemonError> {
        let value = self
            .request(reqwest::Method::GET, &messages_path(session_id), None)
            .await?;
        response_data_array(value, "messages")
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

fn messages_path(session_id: &str) -> String {
    format!("/api/session/{session_id}/message?order=asc&limit={MAX_MESSAGE_PAGE_SIZE}")
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
    fn message_query_respects_opencode_page_limit() {
        assert_eq!(
            messages_path("ses_test"),
            "/api/session/ses_test/message?order=asc&limit=200"
        );
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
