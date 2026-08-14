//! Reusable conformance probe for ACP agent commands.
//!
//! Run a handshake-only probe with:
//! `cargo run -p falcondeck-daemon --example acp_conformance -- -- pi-acp`
//! Add `--live` to exercise prompts, tools, cancellation, and session loading.

use std::{
    collections::BTreeSet,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, mpsc},
    time::{Instant, timeout_at},
};
use uuid::Uuid;

use crate::acp_protocol::{AcpSessionUpdateKind, AcpUpdateDisposition};

const PROTOCOL_VERSION: u64 = 1;
const DEFAULT_TIMEOUT_SECONDS: u64 = 45;
const TEXT_MARKER: &str = "FALCONDECK_ACP_TEXT_OK";
const TOOL_MARKER: &str = "FALCONDECK_ACP_TOOL_OK";

#[derive(Debug, thiserror::Error)]
enum ProbeError {
    #[error("usage: {0}")]
    Usage(String),
    #[error("failed to start adapter: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("adapter stdin failed: {0}")]
    Write(#[source] std::io::Error),
    #[error("adapter stdout closed before request {0} completed")]
    Closed(i64),
    #[error("adapter emitted invalid JSON: {0}")]
    InvalidJson(String),
    #[error("adapter returned an error for {method}: {message}")]
    Request { method: String, message: String },
    #[error("timed out waiting for {0}")]
    Timeout(String),
    #[error("invalid ACP response: {0}")]
    InvalidResponse(String),
    #[error("probe fixture failed: {0}")]
    Fixture(#[source] std::io::Error),
}

/// Configuration for probing one ACP adapter command.
#[derive(Debug, Clone)]
pub struct ProbeOptions {
    /// Executable followed by its arguments.
    pub command: Vec<String>,
    /// Working directory presented to the adapter.
    pub cwd: PathBuf,
    json: bool,
    /// Whether to make live model calls for streaming and tool checks.
    pub live: bool,
    /// Whether to restart the adapter and reload the live session.
    pub restart: bool,
    /// Maximum time allowed for each ACP request.
    pub timeout: Duration,
}

impl ProbeOptions {
    /// Creates a handshake-only probe with the default per-request timeout.
    pub fn new(command: Vec<String>, cwd: PathBuf) -> Self {
        Self {
            command,
            cwd,
            json: false,
            live: false,
            restart: false,
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECONDS),
        }
    }

    /// Enables or disables live model-backed checks.
    pub fn with_live_checks(mut self, live: bool) -> Self {
        self.live = live;
        self
    }

    /// Enables or disables the destructive adapter restart check.
    pub fn with_restart_check(mut self, restart: bool) -> Self {
        self.restart = restart;
        self
    }

    /// Overrides the per-request timeout.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, ProbeError> {
        let mut args = args.into_iter().peekable();
        let mut cwd = env::current_dir().map_err(ProbeError::Fixture)?;
        let mut json = false;
        let mut live = false;
        let mut restart = false;
        let mut timeout_seconds = DEFAULT_TIMEOUT_SECONDS;

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--" => break,
                "--json" => json = true,
                "--live" => live = true,
                "--restart" => restart = true,
                "--cwd" => {
                    let value = args.next().ok_or_else(|| {
                        ProbeError::Usage("--cwd requires a directory".to_string())
                    })?;
                    cwd = PathBuf::from(value);
                }
                "--timeout-seconds" => {
                    let value = args.next().ok_or_else(|| {
                        ProbeError::Usage("--timeout-seconds requires a number".to_string())
                    })?;
                    timeout_seconds = value.parse().map_err(|_| {
                        ProbeError::Usage(
                            "--timeout-seconds must be a positive integer".to_string(),
                        )
                    })?;
                    if timeout_seconds == 0 {
                        return Err(ProbeError::Usage(
                            "--timeout-seconds must be greater than zero".to_string(),
                        ));
                    }
                }
                _ if arg.starts_with('-') => {
                    return Err(ProbeError::Usage(format!("unknown option: {arg}")));
                }
                _ => {
                    let mut command = vec![arg];
                    command.extend(args);
                    return Ok(Self {
                        command,
                        cwd,
                        json,
                        live,
                        restart,
                        timeout: Duration::from_secs(timeout_seconds),
                    });
                }
            }
        }

        let command = args.collect::<Vec<_>>();
        if command.is_empty() {
            return Err(ProbeError::Usage(
                "acp_conformance [--json] [--live] [--restart] [--cwd PATH] [--timeout-seconds N] -- COMMAND [ARGS...]"
                    .to_string(),
            ));
        }
        Ok(Self {
            command,
            cwd,
            json,
            live,
            restart,
            timeout: Duration::from_secs(timeout_seconds),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    /// Required behavior matched FalconDeck's contract.
    Pass,
    /// Compatible, but with a limitation or unverified optional behavior.
    Warning,
    /// Required behavior failed or the adapter was unusable.
    Fail,
    /// The selected probe mode deliberately did not exercise the behavior.
    Skipped,
}

impl CheckStatus {
    fn glyph(self) -> &'static str {
        match self {
            Self::Pass => "✓",
            Self::Warning => "△",
            Self::Fail => "✗",
            Self::Skipped => "–",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Check {
    /// Stable human-readable check name.
    pub name: String,
    /// Conformance outcome.
    pub status: CheckStatus,
    /// Adapter-specific observation or failure detail.
    pub detail: String,
}

impl Check {
    fn new(name: impl Into<String>, status: CheckStatus, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Report {
    /// Adapter command that was probed.
    pub command: Vec<String>,
    /// Agent title or name returned by `initialize`.
    pub agent_name: Option<String>,
    /// Agent version returned by `initialize`.
    pub agent_version: Option<String>,
    /// Negotiated protocol version.
    pub protocol_version: Option<u64>,
    /// Ordered conformance outcomes.
    pub checks: Vec<Check>,
    /// All `session/update` kinds seen during the probe.
    pub observed_update_kinds: BTreeSet<String>,
    /// Recognized kinds not projected by FalconDeck's ACP runtime.
    pub unhandled_update_kinds: BTreeSet<String>,
    /// Wire discriminants unknown to this FalconDeck build.
    pub unknown_update_kinds: BTreeSet<String>,
    /// Bounded tail of adapter stderr.
    pub stderr_tail: String,
}

impl Report {
    fn new(command: Vec<String>) -> Self {
        Self {
            command,
            agent_name: None,
            agent_version: None,
            protocol_version: None,
            checks: Vec::new(),
            observed_update_kinds: BTreeSet::new(),
            unhandled_update_kinds: BTreeSet::new(),
            unknown_update_kinds: BTreeSet::new(),
            stderr_tail: String::new(),
        }
    }

    fn push(&mut self, name: &str, status: CheckStatus, detail: impl Into<String>) {
        self.checks.push(Check::new(name, status, detail));
    }

    /// Returns whether any required check failed.
    pub fn has_failures(&self) -> bool {
        self.checks
            .iter()
            .any(|check| check.status == CheckStatus::Fail)
    }

    /// Renders the compact human-readable compatibility report.
    pub fn render(&self) -> String {
        let identity = match (&self.agent_name, &self.agent_version) {
            (Some(name), Some(version)) => format!("{name} {version}"),
            (Some(name), None) => name.clone(),
            _ => self.command.join(" "),
        };
        let mut output = format!("{identity}\n\n");
        for check in &self.checks {
            output.push_str(&format!(
                "{} {:<22} {}\n",
                check.status.glyph(),
                check.name,
                check.detail
            ));
        }
        if !self.unhandled_update_kinds.is_empty() {
            output.push_str("\nKnown unprojected session updates: ");
            output.push_str(
                &self
                    .unhandled_update_kinds
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            output.push('\n');
        }
        if !self.unknown_update_kinds.is_empty() {
            output.push_str("\nUnknown session updates: ");
            output.push_str(
                &self
                    .unknown_update_kinds
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            output.push('\n');
        }
        if !self.stderr_tail.trim().is_empty() {
            output.push_str("\nAdapter stderr tail:\n");
            output.push_str(self.stderr_tail.trim());
            output.push('\n');
        }
        output
    }
}

struct AdapterProcess {
    child: Child,
    stdin: ChildStdin,
    messages: mpsc::UnboundedReceiver<Result<Value, ProbeError>>,
    stderr: Arc<Mutex<String>>,
    next_id: i64,
    timeout: Duration,
    updates: Vec<Value>,
}

impl AdapterProcess {
    async fn spawn(options: &ProbeOptions) -> Result<Self, ProbeError> {
        let executable = options
            .command
            .first()
            .ok_or_else(|| ProbeError::Usage("adapter command is empty".to_string()))?;
        let mut child = Command::new(executable)
            .args(&options.command[1..])
            .current_dir(&options.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(ProbeError::Spawn)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            ProbeError::InvalidResponse("adapter process has no stdin".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ProbeError::InvalidResponse("adapter process has no stdout".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProbeError::InvalidResponse("adapter process has no stderr".to_string())
        })?;
        let (sender, messages) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) if line.trim().is_empty() => continue,
                    Ok(Some(line)) => {
                        let candidate =
                            crate::acp::AcpRuntime::strip_terminal_control_prefix(line.trim());
                        if candidate.is_empty() {
                            continue;
                        }
                        let parsed = serde_json::from_str(candidate).map_err(|error| {
                            let sample = candidate.chars().take(500).collect::<String>();
                            ProbeError::InvalidJson(format!("{error}; stdout line: {sample:?}"))
                        });
                        if sender.send(parsed).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = sender.send(Err(ProbeError::InvalidJson(error.to_string())));
                        break;
                    }
                }
            }
        });
        let stderr_buffer = Arc::new(Mutex::new(String::new()));
        let stderr_writer = Arc::clone(&stderr_buffer);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut buffer = stderr_writer.lock().await;
                if buffer.len() > 8_000 {
                    let drain_to = buffer.len().saturating_sub(4_000);
                    buffer.drain(..drain_to);
                }
                buffer.push_str(&line);
                buffer.push('\n');
            }
        });
        Ok(Self {
            child,
            stdin,
            messages,
            stderr: stderr_buffer,
            next_id: 1,
            timeout: options.timeout,
            updates: Vec::new(),
        })
    }

    async fn write(&mut self, message: &Value) -> Result<(), ProbeError> {
        let mut encoded = serde_json::to_vec(message)
            .map_err(|error| ProbeError::InvalidJson(error.to_string()))?;
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(ProbeError::Write)?;
        self.stdin.flush().await.map_err(ProbeError::Write)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, ProbeError> {
        self.request_inner(method, params, None).await
    }

    async fn request_and_cancel_on_tool(
        &mut self,
        method: &str,
        params: Value,
        session_id: &str,
    ) -> Result<(Value, bool), ProbeError> {
        let mut cancelled = false;
        let result = self
            .request_inner(method, params, Some((session_id, &mut cancelled)))
            .await?;
        Ok((result, cancelled))
    }

    async fn request_inner(
        &mut self,
        method: &str,
        params: Value,
        mut cancel: Option<(&str, &mut bool)>,
    ) -> Result<Value, ProbeError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;
        let deadline = Instant::now() + self.timeout;
        loop {
            let message = timeout_at(deadline, self.messages.recv())
                .await
                .map_err(|_| ProbeError::Timeout(method.to_string()))?
                .ok_or(ProbeError::Closed(id))??;
            if message.get("id").and_then(Value::as_i64) == Some(id)
                && message.get("method").is_none()
            {
                if let Some(error) = message.get("error") {
                    return Err(ProbeError::Request {
                        method: method.to_string(),
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown ACP error")
                            .to_string(),
                    });
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            if message.get("method").and_then(Value::as_str) == Some("session/update") {
                let update = message
                    .pointer("/params/update")
                    .cloned()
                    .unwrap_or(Value::Null);
                let should_cancel =
                    update.get("sessionUpdate").and_then(Value::as_str) == Some("tool_call");
                self.updates.push(update);
                if should_cancel
                    && let Some((session_id, sent)) = cancel.as_mut()
                    && !**sent
                {
                    self.write(&json!({
                        "jsonrpc": "2.0",
                        "method": "session/cancel",
                        "params": { "sessionId": session_id }
                    }))
                    .await?;
                    **sent = true;
                }
                continue;
            }
            if message.get("method").and_then(Value::as_str) == Some("session/request_permission")
                && let Some(raw_id) = message.get("id").cloned()
            {
                self.answer_permission(raw_id, message.get("params").unwrap_or(&Value::Null))
                    .await?;
                continue;
            }
            if let Some(raw_id) = message.get("id").cloned()
                && message.get("method").is_some()
            {
                self.write(&json!({
                    "jsonrpc": "2.0",
                    "id": raw_id,
                    "error": { "code": -32601, "message": "method not supported by conformance probe" }
                }))
                .await?;
            }
        }
    }

    async fn answer_permission(&mut self, id: Value, params: &Value) -> Result<(), ProbeError> {
        let option_id = params
            .get("options")
            .and_then(Value::as_array)
            .and_then(|options| {
                options
                    .iter()
                    .find(|option| option.get("kind").and_then(Value::as_str) == Some("allow_once"))
            })
            .and_then(|option| option.get("optionId"))
            .cloned();
        let result = option_id.map_or_else(
            || json!({ "outcome": { "outcome": "cancelled" } }),
            |option_id| json!({ "outcome": { "outcome": "selected", "optionId": option_id } }),
        );
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    fn updates_since(&self, start: usize) -> &[Value] {
        &self.updates[start..]
    }

    async fn stderr_tail(&self) -> String {
        self.stderr.lock().await.clone()
    }
}

impl Drop for AdapterProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

struct ProbeFixture {
    path: PathBuf,
}

impl ProbeFixture {
    fn create(cwd: &Path) -> Result<Self, ProbeError> {
        let path = cwd.join(format!(
            ".falcondeck-acp-probe-{}.txt",
            Uuid::new_v4().simple()
        ));
        std::fs::write(&path, "FalconDeck ACP conformance fixture\n")
            .map_err(ProbeError::Fixture)?;
        Ok(Self { path })
    }

    fn filename(&self) -> &str {
        self.path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("FalconDeck ACP conformance fixture")
    }
}

impl Drop for ProbeFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Runs the configured probe and always returns a structured report.
///
/// Process, protocol, and timeout failures are represented as failed checks so
/// callers can persist and compare the same report shape for healthy and
/// unhealthy adapters.
pub async fn run_probe(options: &ProbeOptions) -> Report {
    let mut report = Report::new(options.command.clone());
    let mut adapter = match AdapterProcess::spawn(options).await {
        Ok(adapter) => adapter,
        Err(error) => {
            report.push("Process launch", CheckStatus::Fail, error.to_string());
            return report;
        }
    };
    let initialized = match adapter
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                },
                "clientInfo": {
                    "name": "falcondeck-conformance",
                    "title": "FalconDeck ACP Conformance Probe",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
        .await
    {
        Ok(result) => result,
        Err(error) => {
            report.push("Initialize", CheckStatus::Fail, error.to_string());
            report.stderr_tail = adapter.stderr_tail().await;
            return report;
        }
    };
    report.agent_name = initialized
        .pointer("/agentInfo/title")
        .or_else(|| initialized.pointer("/agentInfo/name"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    report.agent_version = initialized
        .pointer("/agentInfo/version")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    report.protocol_version = initialized.get("protocolVersion").and_then(Value::as_u64);
    let protocol_matches = report.protocol_version == Some(PROTOCOL_VERSION);
    report.push(
        "Initialize",
        if protocol_matches {
            CheckStatus::Pass
        } else {
            CheckStatus::Fail
        },
        format!(
            "protocol {}",
            report
                .protocol_version
                .map_or_else(|| "missing".to_string(), |version| version.to_string())
        ),
    );

    let images = initialized
        .pointer("/agentCapabilities/promptCapabilities/image")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    report.push(
        "Images",
        if images {
            CheckStatus::Pass
        } else {
            CheckStatus::Warning
        },
        if images {
            "advertised"
        } else {
            "not advertised"
        },
    );
    let mcp_http = initialized
        .pointer("/agentCapabilities/mcpCapabilities/http")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mcp_sse = initialized
        .pointer("/agentCapabilities/mcpCapabilities/sse")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    report.push(
        "MCP transport",
        CheckStatus::Warning,
        format!("not exercised; http={mcp_http}, sse={mcp_sse}"),
    );
    let load_session = initialized
        .pointer("/agentCapabilities/loadSession")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let auth_methods = initialized
        .get("authMethods")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    report.push(
        "Authentication",
        CheckStatus::Warning,
        if auth_methods == 0 {
            "no ACP auth methods advertised".to_string()
        } else {
            format!("{auth_methods} method(s) advertised; login flow not exercised")
        },
    );

    if !options.live {
        for name in [
            "Session creation",
            "Text streaming",
            "Tool lifecycle",
            "Cancellation",
            "Session resume",
        ] {
            report.push(name, CheckStatus::Skipped, "run with --live");
        }
        report.push(
            "Process restart",
            CheckStatus::Skipped,
            "not exercised by pilot",
        );
        report.stderr_tail = adapter.stderr_tail().await;
        return report;
    }

    let session = match adapter
        .request(
            "session/new",
            json!({ "cwd": options.cwd, "mcpServers": [] }),
        )
        .await
    {
        Ok(session) => session,
        Err(error) => {
            report.push("Session creation", CheckStatus::Fail, error.to_string());
            report.stderr_tail = adapter.stderr_tail().await;
            return report;
        }
    };
    let Some(session_id) = session
        .get("sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        report.push(
            "Session creation",
            CheckStatus::Fail,
            "session/new returned no sessionId",
        );
        report.stderr_tail = adapter.stderr_tail().await;
        return report;
    };
    let mode_count = session
        .pointer("/modes/availableModes")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    report.push(
        "Session creation",
        CheckStatus::Pass,
        format!("session opened; {mode_count} mode(s)"),
    );

    let text_start = adapter.updates.len();
    let text_result = adapter
        .request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{
                    "type": "text",
                    "text": format!("Reply exactly {TEXT_MARKER}. Do not use tools.")
                }]
            }),
        )
        .await;
    let text_updates = adapter.updates_since(text_start);
    let streamed_text = assistant_text(text_updates);
    match text_result {
        Ok(_) if streamed_text.contains(TEXT_MARKER) => report.push(
            "Text streaming",
            CheckStatus::Pass,
            "agent_message_chunk contained marker",
        ),
        Ok(_) => report.push(
            "Text streaming",
            CheckStatus::Fail,
            "prompt completed without the expected streamed marker",
        ),
        Err(error) => report.push("Text streaming", CheckStatus::Fail, error.to_string()),
    }

    let fixture = match ProbeFixture::create(&options.cwd) {
        Ok(fixture) => fixture,
        Err(error) => {
            report.push("Tool lifecycle", CheckStatus::Fail, error.to_string());
            report.stderr_tail = adapter.stderr_tail().await;
            return report;
        }
    };
    let tool_start = adapter.updates.len();
    let tool_result = adapter
        .request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{
                    "type": "text",
                    "text": format!(
                        "Use your file-reading tool to read {} and then reply exactly {TOOL_MARKER}.",
                        fixture.filename()
                    )
                }]
            }),
        )
        .await;
    let tool_updates = adapter.updates_since(tool_start);
    let saw_tool_start = has_update(tool_updates, "tool_call");
    let saw_tool_update = has_update(tool_updates, "tool_call_update");
    let saw_tool_marker = assistant_text(tool_updates).contains(TOOL_MARKER);
    match tool_result {
        Ok(_) if saw_tool_start && saw_tool_update && saw_tool_marker => report.push(
            "Tool lifecycle",
            CheckStatus::Pass,
            "start, update, and assistant completion observed",
        ),
        Ok(_) => report.push(
            "Tool lifecycle",
            CheckStatus::Fail,
            format!(
                "tool_call={saw_tool_start}, tool_call_update={saw_tool_update}, marker={saw_tool_marker}"
            ),
        ),
        Err(error) => report.push("Tool lifecycle", CheckStatus::Fail, error.to_string()),
    }

    let cancel_result = adapter
        .request_and_cancel_on_tool(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{
                    "type": "text",
                    "text": "Use your terminal tool to run `sleep 20`, wait for it, then reply DONE."
                }]
            }),
            &session_id,
        )
        .await;
    match cancel_result {
        Ok((result, true))
            if result.get("stopReason").and_then(Value::as_str) == Some("cancelled") =>
        {
            report.push(
                "Cancellation",
                CheckStatus::Pass,
                "session/cancel produced cancelled stop reason",
            );
        }
        Ok((result, sent)) => report.push(
            "Cancellation",
            CheckStatus::Fail,
            format!(
                "cancel_sent={sent}, stopReason={}",
                result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("missing")
            ),
        ),
        Err(error) => report.push("Cancellation", CheckStatus::Fail, error.to_string()),
    }

    if load_session {
        let replay_start = adapter.updates.len();
        match adapter
            .request(
                "session/load",
                json!({ "sessionId": session_id, "cwd": options.cwd, "mcpServers": [] }),
            )
            .await
        {
            Ok(_) => {
                let replay_count = adapter.updates_since(replay_start).len();
                report.push(
                    "Session resume",
                    CheckStatus::Pass,
                    format!("session/load succeeded; replayed {replay_count} update(s)"),
                );
            }
            Err(error) => report.push("Session resume", CheckStatus::Fail, error.to_string()),
        }
    } else {
        report.push(
            "Session resume",
            CheckStatus::Warning,
            "loadSession not advertised",
        );
    }
    let mut observed_updates = std::mem::take(&mut adapter.updates);
    let mut stderr_tail = adapter.stderr_tail().await;
    if options.restart {
        drop(adapter);
        let (check, mut restart_updates, restart_stderr) =
            restart_and_load(options, &session_id).await;
        report.checks.push(check);
        observed_updates.append(&mut restart_updates);
        if !restart_stderr.trim().is_empty() {
            if !stderr_tail.ends_with('\n') && !stderr_tail.is_empty() {
                stderr_tail.push('\n');
            }
            stderr_tail.push_str(&restart_stderr);
        }
    } else {
        report.push(
            "Process restart",
            CheckStatus::Skipped,
            "run with --live --restart",
        );
    }

    report.observed_update_kinds = update_kinds(&observed_updates);
    for kind in &report.observed_update_kinds {
        match AcpSessionUpdateKind::classify(kind).disposition() {
            AcpUpdateDisposition::KnownUnhandled => {
                report.unhandled_update_kinds.insert(kind.clone());
            }
            AcpUpdateDisposition::Unknown => {
                report.unknown_update_kinds.insert(kind.clone());
            }
            AcpUpdateDisposition::Projected | AcpUpdateDisposition::Consumed => {}
        }
    }
    report.push(
        "Unprojected events",
        if report.unhandled_update_kinds.is_empty() {
            CheckStatus::Pass
        } else {
            CheckStatus::Warning
        },
        if report.unhandled_update_kinds.is_empty() {
            "all observed update kinds handled by FalconDeck".to_string()
        } else {
            format!("{} unhandled kind(s)", report.unhandled_update_kinds.len())
        },
    );
    report.push(
        "Protocol drift",
        if report.unknown_update_kinds.is_empty() {
            CheckStatus::Pass
        } else {
            CheckStatus::Warning
        },
        if report.unknown_update_kinds.is_empty() {
            "no unknown session-update kinds".to_string()
        } else {
            format!("{} unknown kind(s)", report.unknown_update_kinds.len())
        },
    );
    report.push(
        "Adapter stderr",
        if stderr_tail.trim().is_empty() {
            CheckStatus::Pass
        } else {
            CheckStatus::Warning
        },
        if stderr_tail.trim().is_empty() {
            "no diagnostics emitted"
        } else {
            "diagnostics captured below"
        },
    );
    report.stderr_tail = stderr_tail;
    report
}

async fn restart_and_load(options: &ProbeOptions, session_id: &str) -> (Check, Vec<Value>, String) {
    let mut adapter = match AdapterProcess::spawn(options).await {
        Ok(adapter) => adapter,
        Err(error) => {
            return (
                Check::new("Process restart", CheckStatus::Fail, error.to_string()),
                Vec::new(),
                String::new(),
            );
        }
    };
    let initialized = adapter
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                }
            }),
        )
        .await;
    let outcome = match initialized {
        Ok(_) => adapter
            .request(
                "session/load",
                json!({ "sessionId": session_id, "cwd": options.cwd, "mcpServers": [] }),
            )
            .await
            .map(|_| {
                Check::new(
                    "Process restart",
                    CheckStatus::Pass,
                    format!(
                        "new process loaded session; replayed {} update(s)",
                        adapter.updates.len()
                    ),
                )
            }),
        Err(error) => Err(error),
    };
    let check = outcome.unwrap_or_else(|error| {
        Check::new("Process restart", CheckStatus::Fail, error.to_string())
    });
    let stderr = adapter.stderr_tail().await;
    let updates = std::mem::take(&mut adapter.updates);
    (check, updates, stderr)
}

fn has_update(updates: &[Value], wanted: &str) -> bool {
    updates
        .iter()
        .any(|update| update.get("sessionUpdate").and_then(Value::as_str) == Some(wanted))
}

fn assistant_text(updates: &[Value]) -> String {
    updates
        .iter()
        .filter(|update| {
            update.get("sessionUpdate").and_then(Value::as_str) == Some("agent_message_chunk")
        })
        .filter_map(|update| update.pointer("/content/text").and_then(Value::as_str))
        .collect()
}

fn update_kinds(updates: &[Value]) -> BTreeSet<String> {
    updates
        .iter()
        .filter_map(|update| update.get("sessionUpdate").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect()
}

/// Parses CLI arguments, runs the probe, prints its report, and returns an exit
/// code (`0` compatible, `1` failed checks, `2` invalid invocation/output).
pub async fn run_cli(args: impl IntoIterator<Item = String>) -> i32 {
    let options = match ProbeOptions::parse(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            return 2;
        }
    };
    let report = run_probe(&options).await;
    if options.json {
        match serde_json::to_string_pretty(&report) {
            Ok(encoded) => println!("{encoded}"),
            Err(error) => {
                eprintln!("failed to encode report: {error}");
                return 2;
            }
        }
    } else {
        print!("{}", report.render());
    }
    i32::from(report.has_failures())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_require_an_adapter_command() {
        let error =
            ProbeOptions::parse(Vec::<String>::new()).expect_err("missing command must fail");
        assert!(matches!(error, ProbeError::Usage(_)));
    }

    #[test]
    fn options_parse_live_json_and_command_arguments() {
        let options = ProbeOptions::parse([
            "--live".to_string(),
            "--restart".to_string(),
            "--json".to_string(),
            "--".to_string(),
            "opencode".to_string(),
            "acp".to_string(),
        ])
        .expect("valid arguments should parse");
        assert!(options.live);
        assert!(options.restart);
        assert!(options.json);
        assert_eq!(options.command, ["opencode", "acp"]);
    }

    #[test]
    fn report_fails_only_when_a_check_fails() {
        let mut report = Report::new(vec!["agent".to_string()]);
        report.push("warning", CheckStatus::Warning, "detail");
        assert!(!report.has_failures());
        report.push("failure", CheckStatus::Fail, "detail");
        assert!(report.has_failures());
    }

    #[test]
    fn update_detection_uses_the_shared_protocol_classifier() {
        let updates = vec![
            json!({ "sessionUpdate": "agent_message_chunk" }),
            json!({ "sessionUpdate": "available_commands_update" }),
            json!({ "sessionUpdate": "provider_extension" }),
        ];
        let observed = update_kinds(&updates);
        let unhandled = observed
            .iter()
            .filter(|kind| {
                AcpSessionUpdateKind::classify(kind).disposition()
                    == AcpUpdateDisposition::KnownUnhandled
            })
            .cloned()
            .collect::<BTreeSet<_>>();
        let unknown = observed
            .iter()
            .filter(|kind| {
                AcpSessionUpdateKind::classify(kind).disposition() == AcpUpdateDisposition::Unknown
            })
            .cloned()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            unhandled,
            BTreeSet::from(["available_commands_update".to_string()])
        );
        assert_eq!(unknown, BTreeSet::from(["provider_extension".to_string()]));
    }

    #[test]
    fn assistant_text_preserves_chunk_order() {
        let updates = vec![
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": "Falcon" } }),
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": "Deck" } }),
        ];
        assert_eq!(assistant_text(&updates), "FalconDeck");
    }
}
