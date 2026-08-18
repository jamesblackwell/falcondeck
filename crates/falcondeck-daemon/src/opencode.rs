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

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, mpsc},
    time::{Duration, timeout},
};
use uuid::Uuid;

use crate::error::DaemonError;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const INACTIVE_TERMINAL_GRACE: Duration = Duration::from_secs(5);
const POLL_ERROR_GRACE: Duration = Duration::from_secs(5);
/// How many recent server error lines to retain for diagnosing a turn that
/// dies without emitting anything on its session event stream.
const MAX_RETAINED_SERVER_ERRORS: usize = 16;
/// How long an observed-active turn may go without events or message
/// progress before FalconDeck declares it stalled. Generous on purpose:
/// model calls and tool executions routinely run quiet for tens of seconds.
const ACTIVITY_STALL: Duration = Duration::from_secs(120);
const LISTENING_PREFIX: &str = "opencode server listening on http://127.0.0.1:";
const MAX_MESSAGE_PAGE_SIZE: usize = 200;
/// The v2 runner's registry loads asynchronously after the server reports its
/// port: `/api/model` returns an empty list for roughly the first second even
/// when providers are connected. Retried long enough to outlast a slow
/// registry load without stalling thread creation when the list is genuinely
/// empty.
const RUNNER_REGISTRY_ATTEMPTS: u32 = 10;
const RUNNER_REGISTRY_RETRY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Queue,
    Steer,
}

/// Signals extracted from a session's durable event stream.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionEvent {
    /// The drain loop is executing: a model step or message part moved.
    Activity,
    /// A durable lifecycle event useful for diagnosing a runner that never
    /// advances beyond prompt promotion, but not proof of model execution.
    Observed(String),
    /// A step failure carrying a provider-facing message.
    Failed(String),
}

enum SessionPoll {
    Active,
    Inactive(Vec<Value>),
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
    /// Recent `level=ERROR` lines from the server's own log.
    ///
    /// OpenCode reports a turn that dies before its first step — an
    /// unresolvable or unsupported model, most commonly — only here: nothing
    /// reaches the session event stream and no assistant record is written.
    /// Retained purely to explain such a turn to the user; never used to make
    /// a control-flow decision, so a change to OpenCode's log format costs a
    /// diagnostic detail rather than correctness.
    server_errors: Mutex<Vec<String>>,
    /// Settled `/api/model` registry, keyed by `provider/model`. This is the
    /// list the v2 runner resolves a turn against, and it disagrees with the
    /// v1 `/config/providers` catalog on both which models can run and which
    /// reasoning variants they accept. Cached because it only changes with a
    /// credential change, which restarts this runtime.
    runner_models: Mutex<Option<HashMap<String, RunnerModel>>>,
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
            // A turn that cannot resolve its model fails inside the runner
            // without emitting a session event or an assistant record. The
            // server's own error log is the only channel that carries the
            // cause, and it is silent unless logs are printed. ERROR keeps the
            // stream quiet enough to retain in memory; the port banner stays on
            // stdout, so startup detection is unaffected.
            .args(["--print-logs", "--log-level", "ERROR"])
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
        let stderr = child.stderr.take();
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
            server_errors: Mutex::new(Vec::new()),
            runner_models: Mutex::new(None),
        });
        // Keep draining stderr so a noisy server cannot block.  Diagnostics
        // remain in the daemon log rather than being silently discarded, and
        // error lines are retained for `recent_server_errors`.
        if let Some(stderr) = stderr {
            let errors = Arc::downgrade(&runtime);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(%line, "OpenCode server stderr");
                    if !line.contains("level=ERROR") {
                        continue;
                    }
                    let Some(runtime) = errors.upgrade() else {
                        return;
                    };
                    let mut retained = runtime.server_errors.lock().await;
                    if retained.len() == MAX_RETAINED_SERVER_ERRORS {
                        retained.remove(0);
                    }
                    retained.push(summarize_server_error(&line));
                }
            });
        }
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

    /// Verifies the endpoints and request fields the native transport relies
    /// on against the server's own OpenAPI document, so an incompatible
    /// OpenCode build falls back to ACP before a turn is ever admitted.
    pub async fn validate_contract(&self) -> Result<(), DaemonError> {
        let doc = self.request(reqwest::Method::GET, "/doc", None).await?;
        contract_supported(&doc)
    }

    /// Recent `level=ERROR` lines from the server's own log, newest last.
    ///
    /// A turn whose model cannot be resolved fails inside the runner and
    /// reports nothing over HTTP; these lines are the only account of why.
    pub async fn recent_server_errors(&self) -> Vec<String> {
        self.server_errors.lock().await.clone()
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

    /// The models the v2 runner can resolve, keyed by `provider/model`.
    ///
    /// `/config/providers` (v1) and `/api/model` (the runner's registry)
    /// disagree in two ways that both end a turn after admission, with no
    /// assistant record and nothing on the session event stream:
    ///
    /// * variants — v1 claims `openrouter/google/gemini-3.7-flash` takes
    ///   low/medium/high; the runner lists none and fails the turn with
    ///   `SessionRunnerModel.VariantUnavailableError`.
    /// * APIs — v1 lists every model of every API-key provider; the runner
    ///   implements only some model APIs and fails the rest with
    ///   `SessionRunnerModel.UnsupportedApiError`.
    ///
    /// The v1 catalog still drives the model picker, because the ACP transport
    /// runs everything it lists, variants included.
    ///
    /// An empty read shortly after startup means "not loaded yet", so it is
    /// retried; the settled answer is cached for the runtime's life, since a
    /// credential change restarts the runtime.
    pub async fn runner_models(&self) -> Result<HashMap<String, RunnerModel>, DaemonError> {
        if let Some(cached) = self.runner_models.lock().await.as_ref() {
            return Ok(cached.clone());
        }
        let mut models = HashMap::new();
        for attempt in 0..RUNNER_REGISTRY_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(RUNNER_REGISTRY_RETRY).await;
            }
            let value = self
                .request(reqwest::Method::GET, "/api/model", None)
                .await?;
            models = runner_models(&value)?;
            if !models.is_empty() {
                break;
            }
        }
        *self.runner_models.lock().await = Some(models.clone());
        Ok(models)
    }

    /// The session's effective model as `provider/model`, or `None` when the
    /// session defers to OpenCode's own default — which the v2 runner resolves
    /// inside its own registry, so an absent model never needs gating.
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
        let Some(mut model) = model_ref(model) else {
            // The synthetic `default` catalog entry deliberately preserves
            // OpenCode's own configured model.
            return Ok(());
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
        // The v2 API has no session delete; the implemented route is the v1
        // `DELETE /session/{id}` (the v2 path is a catch-all that serves the
        // web app's HTML with a 200 status).
        let _ = self
            .request(
                reqwest::Method::DELETE,
                &format!("/session/{session_id}"),
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
            Some(prompt_request_body(message_id, prompt, delivery)),
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
        after_seq: Option<u64>,
    ) -> Result<Vec<Value>, DaemonError> {
        // OpenCode 1.18 advertises `session.wait`, but the route returns 503
        // (`Session wait is not available yet`). Wait on the session's durable
        // event stream instead: `session.next.step.*` events prove the drain
        // is executing even when the session is absent from the active map
        // and the model call has not produced its first token yet, and
        // `session.next.step.failed` carries the provider's own error text.
        // Completion itself stays with the message projection and active-map
        // polling below, which is the only implemented terminal signal.
        //
        // The stream replays the session's entire durable history when
        // connected without a cursor, so the admission's sequence number is
        // required: without it a prior turn's `step.failed` would instantly
        // fail every later turn in the session. Without a baseline the
        // waiter falls back to pure polling.
        let (event_tx, mut event_rx) = mpsc::channel::<SessionEvent>(64);
        let event_task = after_seq.map(|after| {
            tokio::spawn(session_event_task(
                self.client.clone(),
                self.base_url.clone(),
                self.password.clone(),
                session_id.to_string(),
                after,
                event_tx,
            ))
        });
        let outcome = self
            .wait_until_idle_inner(session_id, message_id, &mut event_rx)
            .await;
        if let Some(task) = event_task {
            task.abort();
        }
        match outcome {
            Ok(messages) => Ok(messages),
            Err(error) => Err(self
                .enrich_turn_error(session_id, message_id, after_seq, error)
                .await),
        }
    }

    async fn wait_until_idle_inner(
        &self,
        session_id: &str,
        message_id: &str,
        event_rx: &mut mpsc::Receiver<SessionEvent>,
    ) -> Result<Vec<Value>, DaemonError> {
        let mut inactive_since = None;
        let mut inactive_messages = None;
        let mut poll_error_since = None;
        let mut activity_seen = false;
        let mut observed_events = HashSet::new();
        // Once the event channel closes it stays closed; selecting on it
        // again would busy-loop, so polling takes over entirely.
        let mut events_open = true;
        loop {
            let poll_result = if events_open {
                tokio::select! {
                    event = event_rx.recv() => {
                        match event {
                            Some(SessionEvent::Activity) => {
                                activity_seen = true;
                                observed_events.insert("runner_activity".to_string());
                                inactive_since = None;
                                inactive_messages = None;
                            }
                            Some(SessionEvent::Observed(event_type)) => {
                                observed_events.insert(event_type);
                            }
                            Some(SessionEvent::Failed(message)) => {
                                return Err(DaemonError::Rpc(format!(
                                    "OpenCode turn failed: {message}"
                                )));
                            }
                            // The stream ended; polling below takes over.
                            None => events_open = false,
                        }
                        // Drain any further queued events before polling.
                        continue;
                    }
                    result = self.poll_session(session_id, message_id) => result,
                }
            } else {
                self.poll_session(session_id, message_id).await
            };
            let poll = match poll_result {
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
            if self.has_pending_input(session_id).await {
                // A pending permission or question means the turn is blocked
                // on FalconDeck's user even when the session is absent from
                // the active map. Waiting on the user must never trip the
                // idle-without-response timer below.
                inactive_since = None;
                inactive_messages = None;
                tokio::time::sleep(IDLE_POLL_INTERVAL).await;
                continue;
            }
            // Before the first observed activity a short grace catches turns
            // that fail before their first model call; once activity was seen
            // the turn is real and only a long stall gives up.
            let stall_grace = if activity_seen {
                ACTIVITY_STALL
            } else {
                INACTIVE_TERMINAL_GRACE
            };
            if inactive_messages.as_ref() != Some(&messages) {
                inactive_since = Some(tokio::time::Instant::now());
                inactive_messages = Some(messages);
            } else if inactive_since.is_some_and(|since| since.elapsed() >= stall_grace) {
                let mut observed_events = observed_events.into_iter().collect::<Vec<_>>();
                observed_events.sort();
                let observed_events = if observed_events.is_empty() {
                    "none".to_string()
                } else {
                    observed_events.join(", ")
                };
                return Err(DaemonError::Rpc(if activity_seen {
                    format!(
                        "OpenCode session stalled mid-turn without a terminal assistant response; \
                         observed native events: {observed_events}"
                    )
                } else {
                    format!(
                        "OpenCode session became idle without a terminal assistant response; the \
                         turn produced no assistant output and never reached observable runner \
                         activity; observed native events: {observed_events}"
                    )
                }));
            }
            tokio::time::sleep(IDLE_POLL_INTERVAL).await;
        }
    }

    async fn enrich_turn_error(
        &self,
        session_id: &str,
        message_id: &str,
        admitted_seq: Option<u64>,
        error: DaemonError,
    ) -> DaemonError {
        let session = self
            .request(
                reqwest::Method::GET,
                &format!("/api/session/{session_id}"),
                None,
            )
            .await
            .ok();
        let active = self.session_is_active(session_id).await.ok();
        let agent = session
            .as_ref()
            .and_then(|session| session.pointer("/data/agent"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let provider = session
            .as_ref()
            .and_then(|session| session.pointer("/data/model/providerID"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let model = session
            .as_ref()
            .and_then(|session| session.pointer("/data/model/id"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        // A turn that cannot resolve its model reports nothing over HTTP, so
        // without this the user sees only "no assistant response" for what is
        // really "this model is not usable on this OpenCode install".
        let reported = self
            .recent_server_errors()
            .await
            .last()
            .map(|cause| format!("; OpenCode reported: {cause}"))
            .unwrap_or_default();
        DaemonError::Rpc(format!(
            "{error}{reported}; diagnostics: session={session_id}, message={message_id}, \
             admitted_seq={}, active={}, agent={agent}, model={provider}/{model}",
            admitted_seq
                .map(|sequence| sequence.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            active
                .map(|active| active.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
        ))
    }

    /// Whether the session is waiting on a permission or question reply.
    /// Read failures deliberately report no pending input so they cannot mask
    /// the caller's own failure handling.
    async fn has_pending_input(&self, session_id: &str) -> bool {
        let pending = async {
            Ok::<_, DaemonError>(
                !self.pending_permissions(session_id).await?.is_empty()
                    || !self.pending_questions(session_id).await?.is_empty(),
            )
        };
        pending.await.unwrap_or_else(|error| {
            tracing::debug!(%error, "OpenCode pending-input check failed");
            false
        })
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

    async fn messages_since(
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

/// Streams one session's durable event feed and forwards the signals the turn
/// waiter cares about. `after` must be the admitted prompt's sequence number:
/// the feed replays the session's entire durable history when connected
/// without a cursor, which would resurrect prior turns' failures. The task
/// ends when the stream closes or the receiver is dropped; the waiter's
/// polling covers both cases.
async fn session_event_task(
    client: reqwest::Client,
    base_url: String,
    password: String,
    session_id: String,
    after: u64,
    events: mpsc::Sender<SessionEvent>,
) {
    let request = client
        .get(format!(
            "{base_url}/api/session/{session_id}/event?after={after}"
        ))
        .header("accept", "text/event-stream")
        .basic_auth("opencode", Some(&password));
    // The feed is long-lived by design: the client configures only a
    // connect timeout, so the request itself has no total timeout.
    let response = match request.send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            tracing::debug!(
                status = %response.status(),
                "OpenCode session event stream unavailable; falling back to polling"
            );
            return;
        }
        Err(error) => {
            tracing::debug!(%error, "OpenCode session event stream failed; falling back to polling");
            return;
        }
    };
    let mut stream = response.bytes_stream();
    // Buffer raw bytes and decode only complete lines: TCP chunk boundaries
    // can split a multi-byte UTF-8 sequence, and a lossy per-chunk decode
    // would corrupt that line's JSON.
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                tracing::debug!(%error, "OpenCode session event stream ended");
                return;
            }
        };
        buffer.extend_from_slice(&chunk);
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line_bytes = buffer.drain(..=newline).collect::<Vec<_>>();
            let Ok(line) = std::str::from_utf8(&line_bytes) else {
                continue;
            };
            let line = line.trim_end_matches('\r');
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            if let Ok(event) = serde_json::from_str::<Value>(payload.trim())
                && let Some(signal) = classify_session_event(&event)
                && events.send(signal).await.is_err()
            {
                return;
            }
        }
    }
}

/// Maps a durable session event onto the waiter's signals. Only the
/// `session.next.*` durable manifest can appear on this stream; admission
/// echoes and configuration switches are deliberately ignored because they do
/// not prove the drain is executing.
fn classify_session_event(event: &Value) -> Option<SessionEvent> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    match event_type {
        "session.next.step.failed" => {
            let message = event
                .pointer("/data/error/message")
                .or_else(|| event.pointer("/properties/error/message"))
                .and_then(Value::as_str)
                .unwrap_or("the OpenCode session reported an error without details");
            Some(SessionEvent::Failed(message.to_string()))
        }
        "session.next.step.started"
        | "session.next.step.ended"
        | "session.next.text.started"
        | "session.next.text.delta"
        | "session.next.text.ended"
        | "session.next.reasoning.started"
        | "session.next.reasoning.delta"
        | "session.next.reasoning.ended"
        | "session.next.tool.called"
        | "session.next.tool.success"
        | "session.next.tool.failed"
        | "session.next.tool.progress"
        | "session.next.shell.started"
        | "session.next.shell.ended" => Some(SessionEvent::Activity),
        event_type if event_type.starts_with("session.next.") => {
            Some(SessionEvent::Observed(event_type.to_string()))
        }
        _ => None,
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

fn prompt_request_body(message_id: &str, prompt: Value, delivery: Delivery) -> Value {
    json!({
        "id": message_id,
        "prompt": prompt,
        "delivery": delivery.as_str(),
        // OpenCode admits the message but does not wake the agent loop when
        // this flag is omitted or false.
        "resume": true,
    })
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
    /// The model's API as the runner names it in its own error message:
    /// `aisdk:<package>` or `native`.
    pub api: String,
}

/// Model APIs the v2 runner implements, verified live on OpenCode 1.18.18 by
/// prompting one model of each and reading the server error log.
///
/// Every other API — `@openrouter/ai-sdk-provider` and `@ai-sdk/deepinfra`
/// among them — is admitted by the v2 route and then dies in
/// `SessionRunnerModel.resolve` with `UnsupportedApiError`. An allowlist is
/// unavoidable here: nothing OpenCode serves enumerates the runner's supported
/// APIs. It fails in the safe direction — an API added by a later release is
/// treated as native-incapable, and the thread runs over ACP, which executes
/// every model the v1 catalog lists.
const RUNNER_MODEL_APIS: &[&str] = &["aisdk:@ai-sdk/openai-compatible", "aisdk:@ai-sdk/anthropic"];

/// `provider/model` → what the runner will accept for it.
///
/// Variants are published as an array; entries are tolerated as bare ids or as
/// objects carrying one, since only the empty case is observable on OpenCode
/// 1.18.18 and a future release naming them differently should degrade to
/// "no variant" rather than to a failed turn.
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
            let api_type = model
                .pointer("/api/type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let api = match model.pointer("/api/package").and_then(Value::as_str) {
                Some(package) => format!("{api_type}:{package}"),
                None => api_type.to_string(),
            };
            Some((format!("{provider_id}/{id}"), RunnerModel { variants, api }))
        })
        .collect())
}

/// The variant to send with a model, given what the runner accepts: the
/// requested effort, or `None` when the runner would reject it.
pub fn runner_variant<'a>(effort: Option<&'a str>, model: Option<&RunnerModel>) -> Option<&'a str> {
    let effort = effort?;
    // A model the registry does not describe is blocked separately; leaving
    // its effort alone keeps this function from silently changing a request
    // the caller is about to refuse anyway.
    let Some(model) = model else {
        return Some(effort);
    };
    model
        .variants
        .iter()
        .any(|variant| variant == effort)
        .then_some(effort)
}

/// Why the v2 runner cannot execute the session's model, or `None` when it
/// can. A session without an explicit model passes: the runner resolves its
/// default from its own registry.
///
/// Both halves are dynamic where OpenCode lets them be: membership comes from
/// the runner's own registry, so a release that teaches the v2 runner to
/// execute OAuth or coding-plan credentials needs no FalconDeck change.
pub fn native_model_block_reason(
    session_model: Option<&str>,
    runner_models: &HashMap<String, RunnerModel>,
) -> Option<String> {
    if runner_models.is_empty() {
        return Some(
            "OpenCode's native runner has no models registered, so no model can execute \
             natively"
                .to_string(),
        );
    }
    let model_id = session_model?;
    let Some(model) = runner_models.get(model_id) else {
        return Some(format!(
            "OpenCode's native runner does not list the model '{model_id}' \
             (OAuth and coding-plan providers only run over ACP)"
        ));
    };
    if RUNNER_MODEL_APIS.iter().any(|api| *api == model.api) {
        return None;
    }
    Some(format!(
        "OpenCode's native runner cannot execute '{model_id}': its API ({}) is not one the \
         runner implements",
        model.api
    ))
}

/// Paths the native transport calls. `DELETE /session/{sessionID}` is the v1
/// route: the v2 API has no session delete.
///
/// The `CONTRACT_*` tables below are the transport's complete list of
/// assumptions about OpenCode's experimental v2 API, checked against the
/// server's own `/doc` at attach so upstream drift demotes new threads to ACP
/// instead of failing user turns. Anything the transport starts sending must
/// be added here in the same change; see "Keeping up with OpenCode releases"
/// in docs/ADAPTERS.md for the per-release checklist.
const CONTRACT_PATHS: &[&str] = &[
    "/api/model",
    "/api/session",
    "/api/session/active",
    "/api/session/{sessionID}",
    "/api/session/{sessionID}/prompt",
    "/api/session/{sessionID}/message",
    "/api/session/{sessionID}/model",
    "/api/session/{sessionID}/agent",
    "/api/session/{sessionID}/interrupt",
    "/api/session/{sessionID}/permission",
    "/api/session/{sessionID}/permission/{requestID}/reply",
    "/api/session/{sessionID}/question",
    "/api/session/{sessionID}/question/{requestID}/reply",
    "/session/{sessionID}",
];

/// Request fields the durable prompt admission body must accept. Older
/// OpenCode builds reject `resume` (the body is `additionalProperties:
/// false`), which would otherwise surface only after a thread is pinned to
/// the native transport.
const CONTRACT_PROMPT_FIELDS: &[&str] = &["id", "prompt", "delivery", "resume"];

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
        &["reply"],
    ),
    (
        "/api/session/{sessionID}/question/{requestID}/reply",
        &["answers"],
    ),
];

/// Named schemas whose properties FalconDeck populates by hand.
const CONTRACT_SCHEMA_FIELDS: &[(&str, &[&str])] = &[
    ("ModelRef", &["id", "providerID"]),
    ("PromptInput", &["text", "files"]),
];

/// String values FalconDeck sends verbatim. A renamed variant would be
/// accepted by the schema check above and rejected at runtime.
const CONTRACT_ENUM_VALUES: &[(&str, &[&str])] =
    &[("PermissionV2Reply", &["once", "always", "reject"])];

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
        .ok_or_else(|| DaemonError::Rpc("OpenCode /doc had no paths object".to_string()))?;
    for path in CONTRACT_PATHS {
        if !paths.get(*path).is_some_and(Value::is_object) {
            return Err(DaemonError::Rpc(format!(
                "OpenCode /doc is missing the {path} endpoint"
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
            DaemonError::Rpc("OpenCode /doc did not describe the prompt request body".to_string())
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
            DaemonError::Rpc("OpenCode /doc did not describe the message list query".to_string())
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
                DaemonError::Rpc(format!("OpenCode /doc did not describe the {path} body"))
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
                DaemonError::Rpc(format!("OpenCode /doc no longer defines the {name} schema"))
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
                DaemonError::Rpc(format!("OpenCode /doc no longer defines the {name} enum"))
            })?;
        for value in *values {
            if !declared.iter().any(|entry| entry.as_str() == Some(value)) {
                return Err(DaemonError::Rpc(format!(
                    "OpenCode {name} no longer accepts the '{value}' value"
                )));
            }
        }
    }
    let delivery = prompt_properties
        .get("delivery")
        .and_then(|delivery| delivery.get("enum"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DaemonError::Rpc("OpenCode /doc did not declare the prompt delivery values".to_string())
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

/// Reduces one `level=ERROR` server log line to its cause, dropping the
/// stack trace that follows the first escaped newline.
fn summarize_server_error(line: &str) -> String {
    let cause = line
        .split_once("cause=\"")
        .map(|(_, rest)| rest)
        .and_then(|rest| rest.split_once("\\n").map(|(head, _)| head))
        .or_else(|| line.split_once("cause=\"").map(|(_, rest)| rest))
        .unwrap_or(line);
    cause.trim_end_matches(['"', ' ']).trim().to_string()
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
        // The v1 catalog advertises low/medium/high for this model and the
        // runner accepts none, which is the disagreement that kills a turn.
        assert_eq!(runner_variant(Some("medium"), gemini), None);
        assert_eq!(runner_variant(Some("high"), gpt), Some("high"));
        assert_eq!(runner_variant(Some("max"), gpt), None);
        assert_eq!(runner_variant(None, gpt), None);
        assert_eq!(
            runner_variant(Some("low"), registry.get("opencode/no-variants-field")),
            None
        );
        // An unregistered model is refused by the gate, not silently retuned.
        assert_eq!(runner_variant(Some("medium"), None), Some("medium"));
    }

    #[test]
    fn session_events_classify_liveness_and_failure() {
        use super::SessionEvent;
        assert_eq!(
            classify_session_event(&json!({
                "type": "session.next.step.started"
            })),
            Some(SessionEvent::Activity)
        );
        assert_eq!(
            classify_session_event(&json!({
                "type": "session.next.text.delta"
            })),
            Some(SessionEvent::Activity)
        );
        assert_eq!(
            classify_session_event(&json!({
                "type": "session.next.tool.called"
            })),
            Some(SessionEvent::Activity)
        );
        assert_eq!(
            classify_session_event(&json!({
                "type": "session.next.step.failed",
                "data": { "error": { "type": "unknown", "message": "provider auth failed" } }
            })),
            Some(SessionEvent::Failed("provider auth failed".to_string()))
        );
        assert_eq!(
            classify_session_event(&json!({ "type": "session.next.step.failed" })),
            Some(SessionEvent::Failed(
                "the OpenCode session reported an error without details".to_string()
            ))
        );
        // Admission echoes are diagnostic only and must not count as drain
        // liveness.
        assert_eq!(
            classify_session_event(&json!({ "type": "session.next.prompt.admitted" })),
            Some(SessionEvent::Observed(
                "session.next.prompt.admitted".to_string()
            ))
        );
        assert_eq!(
            classify_session_event(&json!({ "type": "session.next.prompted" })),
            Some(SessionEvent::Observed("session.next.prompted".to_string()))
        );
        // Status and legacy global-event types never appear on the durable
        // session stream and must stay unclassified.
        assert_eq!(
            classify_session_event(&json!({ "type": "session.idle" })),
            None
        );
        assert_eq!(
            classify_session_event(&json!({ "type": "session.error" })),
            None
        );
        assert_eq!(
            classify_session_event(&json!({ "type": "message.part.updated" })),
            None
        );
    }

    /// Live end-to-end exercise of the native waiter against a real
    /// `opencode serve`: admits a prompt against a session whose model cannot
    /// resolve, so the drain fails locally before any provider call.
    ///
    /// OpenCode reports this failure *only* in its own error log — no session
    /// event, no assistant record — so the waiter must both terminate and
    /// carry the server's stated cause. An earlier revision read the same
    /// silence as proof that the whole native runner was broken, and this
    /// assertion exists to keep that misreading from returning. Costs no model
    /// usage. Run explicitly with `--ignored`.
    #[test]
    #[ignore = "live OpenCode server e2e; requires the opencode binary"]
    fn live_unresolvable_model_reports_the_servers_own_cause() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let scratch = std::env::temp_dir().join("falcondecks-live-opencode-probe");
            std::fs::create_dir_all(&scratch).unwrap();
            let runtime = OpenCodeRuntime::spawn(
                &["opencode".to_string()],
                scratch.to_str().unwrap(),
                &HashMap::new(),
            )
            .await
            .expect("spawn opencode serve");
            let session_id = runtime
                .create_session(
                    scratch.to_str().unwrap(),
                    Some("no-such-provider/no-such-model"),
                    None,
                )
                .await
                .expect("create session");
            let admission = runtime
                .prompt(
                    &session_id,
                    "msg_live_probe",
                    "live waiter probe",
                    &[],
                    Delivery::Queue,
                )
                .await
                .expect("admit prompt");
            let after_seq = admission
                .pointer("/data/admittedSeq")
                .and_then(Value::as_u64);
            let outcome = tokio::time::timeout(
                Duration::from_secs(60),
                runtime.wait_until_idle(&session_id, "msg_live_probe", after_seq),
            )
            .await
            .expect("waiter must terminate");
            runtime.delete_session(&session_id).await;
            runtime.shutdown().await;
            let error = outcome.expect_err("invalid model must fail the turn");
            let error = error.to_string();
            assert!(
                error.contains("OpenCode reported:"),
                "the turn error must carry the server's own cause: {error}"
            );
            assert!(
                error.contains("no-such-model"),
                "the reported cause must name the unresolvable model: {error}"
            );
        });
    }

    /// Live proof that observed drain activity suppresses the short
    /// outputless-turn grace: with `Activity` events arriving, the waiter must
    /// still be waiting well past the 5-second grace that a stalled session
    /// would otherwise trip. See the unresolvable-model test above
    /// for the cost-free failure setup (see `live_unresolvable_model_reports_the_servers_own_cause`).
    #[test]
    #[ignore = "live OpenCode server e2e; requires the opencode binary"]
    fn live_activity_events_suppress_the_short_grace() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let scratch = std::env::temp_dir().join("falcondecks-live-opencode-probe");
            std::fs::create_dir_all(&scratch).unwrap();
            let runtime = OpenCodeRuntime::spawn(
                &["opencode".to_string()],
                scratch.to_str().unwrap(),
                &HashMap::new(),
            )
            .await
            .expect("spawn opencode serve");
            let session_id = runtime
                .create_session(
                    scratch.to_str().unwrap(),
                    Some("no-such-provider/no-such-model"),
                    None,
                )
                .await
                .expect("create session");
            runtime
                .prompt(
                    &session_id,
                    "msg_live_activity",
                    "live activity probe",
                    &[],
                    Delivery::Queue,
                )
                .await
                .expect("admit prompt");
            let (event_tx, mut event_rx) = mpsc::channel::<SessionEvent>(16);
            let feeder = tokio::spawn(async move {
                // Roughly one step/text delta per second, as a streaming turn
                // would produce.
                for _ in 0..12 {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    let _ = event_tx.send(SessionEvent::Activity).await;
                }
            });
            let waiter =
                runtime.wait_until_idle_inner(&session_id, "msg_live_activity", &mut event_rx);
            // 10 seconds is double the short grace; without activity
            // suppression the waiter errors at ~5 seconds.
            let outcome = tokio::time::timeout(Duration::from_secs(10), waiter).await;
            feeder.abort();
            runtime.delete_session(&session_id).await;
            runtime.shutdown().await;
            assert!(
                outcome.is_err(),
                "waiter must still be waiting while activity events arrive"
            );
        });
    }

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
    fn prompt_admission_resumes_the_agent_loop() {
        assert_eq!(
            prompt_request_body("msg_test", json!({ "text": "hello" }), Delivery::Queue),
            json!({
                "id": "msg_test",
                "prompt": { "text": "hello" },
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
    fn contract_validation_requires_prompt_fields_and_v1_delete() {
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
            .remove("/session/{sessionID}");
        let error = contract_supported(&missing_delete).unwrap_err();
        assert!(error.to_string().contains("/session/{sessionID}"));

        assert!(contract_supported(&json!({ "openapi": "3.1.0" })).is_err());
    }

    /// A minimal `/doc` that satisfies every contract rule.
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
        for path in CONTRACT_PATHS {
            paths[path] = json!({ "get": { "responses": {} } });
        }
        for (path, fields) in CONTRACT_BODY_FIELDS {
            paths[path] = body(fields, None);
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
            doc["paths"]["/api/session"]["post"]["requestBody"]["content"]["application/json"]
                ["schema"]["properties"]
                .as_object_mut()
                .expect("fixture body is an object")
                .remove("model");
        });
        assert!(error.to_string().contains("model"), "{error}");

        let error = strip(&|doc| {
            doc["components"]["schemas"]["ModelRef"]["properties"]
                .as_object_mut()
                .expect("fixture schema is an object")
                .remove("providerID");
        });
        assert!(error.to_string().contains("providerID"), "{error}");

        let error = strip(&|doc| {
            doc["components"]["schemas"]["PermissionV2Reply"]["enum"] = json!(["once", "always"]);
        });
        assert!(error.to_string().contains("reject"), "{error}");

        let error = strip(&|doc| {
            doc["paths"]["/api/session/{sessionID}/prompt"]["post"]["requestBody"]["content"]["application/json"]
                ["schema"]["properties"]["delivery"]["enum"] = json!(["queue"]);
        });
        assert!(error.to_string().contains("steer"), "{error}");
    }

    #[test]
    fn server_error_summary_keeps_the_cause_and_drops_the_stack() {
        let line = r#"timestamp=2026-08-15T05:44:47.527Z level=ERROR message="Failed to drain Session" cause="SessionRunnerModel.ModelUnavailableError: Model unavailable: google/gemini-3.5-flash\n    at <anonymous> (/$bunfs/root/chunk.js:6:22145)" sessionID=ses_abc"#;
        assert_eq!(
            summarize_server_error(line),
            "SessionRunnerModel.ModelUnavailableError: Model unavailable: google/gemini-3.5-flash"
        );
        // A line in an unexpected shape must degrade to something readable
        // rather than being dropped: it is the only account of the failure.
        assert_eq!(
            summarize_server_error("level=ERROR boom"),
            "level=ERROR boom"
        );
    }

    #[test]
    fn native_gate_blocks_models_the_runner_cannot_resolve() {
        // Shape observed live on OpenCode 1.18.18: the runner registry lists
        // every API-key provider's models (OAuth and coding-plan providers are
        // absent even when `/config/providers` calls them connected), but
        // implements only some of their APIs.
        let registry = runner_models(&json!({
            "location": { "directory": "/work" },
            "data": [
                {
                    "id": "grok-code",
                    "providerID": "opencode",
                    "api": { "type": "aisdk", "package": "@ai-sdk/openai-compatible" },
                    "variants": []
                },
                {
                    "id": "google/gemini-3.7-flash",
                    "providerID": "openrouter",
                    "api": { "type": "aisdk", "package": "@openrouter/ai-sdk-provider" },
                    "variants": []
                }
            ]
        }))
        .unwrap();

        assert_eq!(
            native_model_block_reason(Some("opencode/grok-code"), &registry),
            None
        );
        // No explicit model: the runner resolves its default from its own
        // registry, so there is nothing to gate.
        assert_eq!(native_model_block_reason(None, &registry), None);
        // A registered model whose API the runner does not implement is
        // admitted and then dies in SessionRunnerModel.resolve; it must be
        // blocked before admission with a reason that names the API.
        let reason =
            native_model_block_reason(Some("openrouter/google/gemini-3.7-flash"), &registry)
                .expect("an unimplemented model API must be blocked");
        assert!(reason.contains("google/gemini-3.7-flash"), "{reason}");
        assert!(reason.contains("@openrouter/ai-sdk-provider"), "{reason}");
        // A v1-only provider never reaches the registry at all.
        let reason = native_model_block_reason(Some("zai-coding-plan/glm-5.3"), &registry)
            .expect("a v1-only provider must be blocked");
        assert!(reason.contains("zai-coding-plan/glm-5.3"), "{reason}");
        // An empty registry means nothing can resolve, explicit model or not.
        assert!(native_model_block_reason(None, &HashMap::new()).is_some());
        assert!(native_model_block_reason(Some("opencode/grok-code"), &HashMap::new()).is_some());
        assert!(runner_models(&json!({ "providers": [] })).is_err());
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
