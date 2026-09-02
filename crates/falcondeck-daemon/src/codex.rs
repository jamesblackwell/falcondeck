use std::{
    collections::{HashMap, HashSet},
    fs::File,
    future::Future,
    io::{BufRead, BufReader as StdBufReader, Read},
    ops::Deref,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};

use chrono::Utc;
use falcondeck_core::{
    AccountStatus, AccountSummary, AgentProvider, CollaborationModeSummary, ContentLifecycle,
    ConversationItem, ImageInput, ModelSummary, ReasoningEffortSummary, ServiceTierSummary,
    ThreadAgentParams, ThreadAttention, ThreadPlan, ThreadStatus, ThreadSummary,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock, oneshot},
    time::{Duration, timeout},
};
use tracing::warn;

use crate::agent_binary::{
    missing_binary_message, preferred_command_path, resolve_agent_binary,
    strip_terminal_advertising_env,
};
use crate::skills::canonical_skill_alias;
use crate::{
    app::{
        AppState,
        conversation_helpers::{
            codex_artifact_conversation_item, codex_assistant_conversation_item,
            codex_assistant_message_metadata, codex_context_compaction_conversation_item,
            codex_file_change_conversation_item, codex_hook_prompt_conversation_item,
            codex_image_conversation_item, codex_plan_conversation_item,
            codex_reasoning_conversation_item, codex_review_mode_conversation_item,
            codex_tool_call_detail, codex_tool_call_output, codex_tool_call_title,
            codex_web_search_conversation_item, content_lifecycle_for_status,
            merge_code_review_item, sanitize_conversation_item, terminal_assistant_receipt,
            tool_display_metadata, unsupported_conversation_item,
        },
    },
    error::DaemonError,
};

mod session_file;
mod thread_list;

use session_file::{
    hydrate_thread_items_from_session_file, supplement_thread_items_with_session_tool_calls,
};
use thread_list::{parse_collaboration_modes, parse_models, parse_threads};

pub struct CodexBootstrap {
    pub session: PendingCodexSession,
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

pub struct HydratedThread {
    pub summary: ThreadSummary,
    pub items: Vec<ConversationItem>,
    pub title_is_provider_preview: bool,
}

const CODEX_TURN_PAGE_SIZE: u32 = 100;

/// Rebuild a thread from a `thread/read` or `thread/resume` response.
///
/// App-server's structured turns are intentionally lossy for tool activity,
/// so supplement them from the rollout file when its path is available. The
/// caller supplies the effective thread cwd because isolated FalconDeck
/// threads belong to their variant rather than the parent workspace folder.
pub(crate) fn hydrate_thread_response(
    summary: ThreadSummary,
    value: &Value,
    workspace_path: &str,
) -> HydratedThread {
    let mut items = hydrate_thread_items(value);
    if let Some(path) = extract_thread_session_path(value) {
        if items.is_empty() {
            items = hydrate_thread_items_from_session_file(&path, workspace_path);
        } else {
            supplement_thread_items_with_session_tool_calls(&mut items, &path, workspace_path);
        }
    }
    let summary = hydrate_thread_summary(summary, value, &items);
    HydratedThread {
        summary,
        items,
        title_is_provider_preview: false,
    }
}

/// Conversation items from a `thread/read` payload, including rollout-file
/// history when app-server returns an empty `turns` array (legacy history
/// mode on current Codex).
pub(crate) fn conversation_items_from_read(
    value: &Value,
    workspace_path: &str,
) -> Vec<ConversationItem> {
    let mut items = hydrate_thread_items(value);
    if let Some(path) = extract_thread_session_path(value) {
        if items.is_empty() {
            items = hydrate_thread_items_from_session_file(&path, workspace_path);
        } else {
            supplement_thread_items_with_session_tool_calls(&mut items, &path, workspace_path);
        }
    }
    items
}

/// Build `thread/start` params for current Codex app-server (0.150.x).
///
/// `effort` is not a `ThreadStartParams` field — turn-level effort is the
/// authority. `baseInstructions` is the large system prompt; FalconDeck uses
/// the small `developerInstructions` append instead. Thread-level `sandbox`
/// and `approvalPolicy` use config-style spellings (`on-request`,
/// `workspace-write`), not the camelCase dialect older app-servers accepted.
pub(crate) fn thread_start_params(
    cwd: &str,
    model: Option<&str>,
    sandbox_mode: Option<&str>,
    approval_policy: &str,
    developer_instructions: Option<&str>,
) -> Value {
    let mut params = json!({
        "cwd": cwd,
        "approvalPolicy": app_server_approval_policy(approval_policy),
    });
    insert_optional_str(&mut params, "model", model);
    if let Some(sandbox) = sandbox_mode
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params["sandbox"] = json!(app_server_sandbox_mode(sandbox));
    }
    insert_optional_str(&mut params, "developerInstructions", developer_instructions);
    params
}

/// Build `thread/resume` params.
///
/// `baseInstructions` is omitted: the app-server preserves the original
/// instructions across resume (upstream test
/// `resume_switches_models_preserves_base_instructions`). Resending them
/// wastes thousands of tokens on every reconnect. `effort` is not a resume
/// field. `developerInstructions` is a short FalconDeck append, re-sent so an
/// agent-control setting change applies on the next resume.
pub(crate) fn thread_resume_params(
    thread_id: &str,
    cwd: &str,
    developer_instructions: Option<&str>,
) -> Value {
    let mut params = json!({
        "threadId": thread_id,
        "cwd": cwd,
        // Codex Desktop stores paginated histories. Asking app-server to put
        // their full history in `thread.turns` is deprecated and returns no
        // usable transcript; bootstrap the newest full page alongside resume
        // and collect the remaining pages below.
        "excludeTurns": true,
        "initialTurnsPage": {
            "limit": CODEX_TURN_PAGE_SIZE,
            "sortDirection": "desc",
            "itemsView": "full"
        }
    });
    insert_optional_str(&mut params, "developerInstructions", developer_instructions);
    params
}

fn turns_page(value: &Value) -> Option<&Value> {
    value
        .get("initialTurnsPage")
        .filter(|page| !page.is_null())
        .or_else(|| value.get("data").and_then(Value::as_array).map(|_| value))
}

fn turns_page_data(value: &Value) -> Vec<Value> {
    turns_page(value)
        .and_then(|page| page.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn turns_page_next_cursor(value: &Value) -> Option<String> {
    turns_page(value)
        .and_then(|page| page.get("nextCursor"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn install_paginated_turns(response: &mut Value, mut newest_first: Vec<Value>) {
    newest_first.reverse();
    if let Some(thread) = response.get_mut("thread")
        && let Some(thread) = thread.as_object_mut()
    {
        thread.insert("turns".to_string(), Value::Array(newest_first));
    }
}

/// Build `turn/start` params. Effort belongs here, not on thread start/resume.
/// App-server v2 `turn/start` does not accept a `config` override bag —
/// thread-level config changes take effect on `thread/start` or
/// `thread/resume`. Null optional overrides are omitted so they do not clear
/// the thread's current model, effort, or sandbox.
#[allow(clippy::too_many_arguments)]
pub(crate) fn turn_start_params(
    thread_id: &str,
    input: Vec<Value>,
    cwd: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    collaboration_mode: Value,
    sandbox_policy: Value,
    approval_policy: Option<&str>,
    service_tier: Option<&str>,
) -> Value {
    let mut params = json!({
        "threadId": thread_id,
        "input": input,
    });
    insert_optional_str(&mut params, "cwd", cwd);
    insert_optional_str(&mut params, "model", model);
    insert_optional_str(&mut params, "effort", effort);
    insert_optional_value(&mut params, "collaborationMode", collaboration_mode);
    insert_optional_value(&mut params, "sandboxPolicy", sandbox_policy);
    if let Some(policy) = approval_policy
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params["approvalPolicy"] = json!(app_server_approval_policy(policy));
    }
    insert_optional_str(&mut params, "serviceTier", service_tier);
    params
}

/// Server→client methods FalconDeck answers with a result. Unimplemented
/// methods, including `item/tool/call`, must still get a JSON-RPC error or
/// the app-server stalls the turn.
pub(crate) fn server_request_expects_result(method: &str) -> bool {
    method.ends_with("requestApproval")
        || method == "item/tool/requestUserInput"
        || method == "mcpServer/elicitation/request"
}

/// Config-style `AskForApproval` spelling for current app-server. camelCase
/// aliases are accepted from stored thread state; `unlessTrusted` maps to
/// `"untrusted"`, not `"unlessTrusted"`.
pub(crate) fn app_server_approval_policy(value: &str) -> &str {
    match value.trim() {
        "onRequest" | "on-request" | "onFailure" | "on-failure" => "on-request",
        "unlessTrusted" | "unless-trusted" | "untrusted" => "untrusted",
        "never" => "never",
        other => other,
    }
}

/// Config-style `SandboxMode` spelling for `thread/start` / `thread/resume`.
/// Turn-level `sandboxPolicy` is a separate camelCase tagged object.
pub(crate) fn app_server_sandbox_mode(value: &str) -> &str {
    match value.trim() {
        "readOnly" | "read-only" => "read-only",
        "workspaceWrite" | "workspace-write" => "workspace-write",
        "dangerFullAccess" | "danger-full-access" => "danger-full-access",
        other => other,
    }
}

fn insert_optional_str(params: &mut Value, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        params[key] = json!(value);
    }
}

fn insert_optional_value(params: &mut Value, key: &str, value: Value) {
    if !value.is_null() {
        params[key] = value;
    }
}

/// Upper bound for control-plane requests (initialize, account/model/thread
/// listing, resume). These are bounded operations; a missing response means the
/// app-server is wedged and callers must not hang forever. Turn-scoped
/// requests (`turn/start`, `turn/interrupt`, ...) are not timed out here —
/// they are protected by the disconnect drain in `read_stdout` instead.
const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const CODEX_SQLITE_HOME_ENV: &str = "CODEX_SQLITE_HOME";
const MAX_WORKSPACE_ID_BYTES: usize = 128;

fn codex_sqlite_home(state: &AppState, workspace_id: &str) -> Result<PathBuf, DaemonError> {
    let safe_workspace_id = !workspace_id.is_empty()
        && workspace_id.len() <= MAX_WORKSPACE_ID_BYTES
        && workspace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !safe_workspace_id {
        return Err(DaemonError::Process(
            "cannot isolate Codex runtime state for an invalid workspace id".to_string(),
        ));
    }

    let state_dir = state.state_dir().ok_or_else(|| {
        DaemonError::Process("FalconDeck's daemon state path has no parent directory".to_string())
    })?;
    Ok(state_dir.join("codex-sqlite").join(workspace_id))
}

async fn configure_codex_sqlite_home(
    command: &mut Command,
    state: &AppState,
    workspace_id: &str,
) -> Result<(), DaemonError> {
    let sqlite_home = codex_sqlite_home(state, workspace_id)?;
    tokio::fs::create_dir_all(&sqlite_home)
        .await
        .map_err(|error| {
            DaemonError::Process(format!(
                "failed to prepare isolated Codex runtime at {}: {error}",
                sqlite_home.display()
            ))
        })?;
    command.env(CODEX_SQLITE_HOME_ENV, sqlite_home);
    Ok(())
}

/// Remove terminal control sequences before provider stderr enters daemon
/// diagnostic logs. Codex uses ANSI styling even when stderr is piped.
fn strip_terminal_control_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars();

    while let Some(character) = chars.next() {
        if character != '\u{1b}' {
            if !character.is_control() || matches!(character, '\n' | '\r' | '\t') {
                output.push(character);
            }
            continue;
        }

        match chars.next() {
            // CSI sequences, including Codex's colour/style sequences such as
            // ESC[31m and ESC[0m, end at the first byte in the final range.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            // OSC sequences can end with BEL or the two-byte ST sequence.
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && chars.next() == Some('\\') {
                        break;
                    }
                }
            }
            // DCS, SOS, PM, and APC sequences also use ST as their terminator.
            Some('P' | 'X' | '^' | '_') => {
                while let Some(next) = chars.next() {
                    if next == '\u{1b}' && chars.next() == Some('\\') {
                        break;
                    }
                }
            }
            // Character-set designators consume one additional byte.
            Some('(' | ')') => {
                let _ = chars.next();
            }
            Some(_) | None => {}
        }
    }

    output
}

fn is_non_fatal_codex_cache_diagnostic(line: &str) -> bool {
    // Codex falls back to its models endpoint when an older cache snapshot
    // cannot be decoded. Depending on when it discovers the stale schema, it
    // reports either a load failure or a TTL-renewal failure. Neither indicates
    // a failed app-server startup, so do not surface this exact compatibility
    // diagnostic as an application error.
    //
    // Match the models-manager target loosely: older Codex builds log under
    // `codex_models_manager::cache`, newer ones under `::manager`.
    let from_models_manager = line.contains("codex_models_manager");
    from_models_manager
        && line.contains("missing field `base_instructions`")
        && (line.contains("failed to load models cache")
            || line.contains("failed to renew cache TTL"))
}

pub struct CodexSession {
    workspace_id: String,
    workspace_path: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, DaemonError>>>>,
    closed: AtomicBool,
    /// Set before an intentional shutdown so the stdout reader does not treat
    /// the exit as a crash and schedule a reconnect.
    expected_exit: AtomicBool,
    /// Reconnects are armed only after this session is installed in AppState.
    /// Bootstrap candidates are owned by their caller and must never start
    /// competing supervisors when they fail or are cancelled.
    reconnect_on_exit: AtomicBool,
    /// A session is one-shot, so at most one reconnect task may be requested
    /// for its terminal exit. This closes the race between activation and an
    /// already-observed EOF without adding a workspace-level state machine.
    reconnect_scheduled: AtomicBool,
    /// Leases serialize proactive retirement against user operations. A
    /// workspace may go cold only after every caller that acquired its live
    /// session has finished, so a turn cannot lose the app-server between
    /// lookup and request dispatch.
    lifecycle_gate: Arc<RwLock<()>>,
    /// Updated by both client requests and server events. Incoming turn-end
    /// notifications therefore start the warm grace period when work really
    /// finishes rather than when the turn originally started.
    last_activity: StdMutex<Instant>,
    /// The wrapper CLI and every process it launches live in this group. The
    /// Homebrew `codex` entry point is a Node script which spawns the native
    /// app-server, so killing only `Child` leaves the real server orphaned.
    process_group_id: Option<u32>,
    state: AppState,
}

/// Keeps a Codex app-server live for the duration of one daemon operation.
///
/// The guard is intentionally owned: callers pass this handle across await
/// points while a retirement task waits for exclusive access.
pub struct CodexSessionLease {
    session: Arc<CodexSession>,
    _guard: OwnedRwLockReadGuard<()>,
}

impl Deref for CodexSessionLease {
    type Target = CodexSession;

    fn deref(&self) -> &Self::Target {
        &self.session
    }
}

impl CodexSessionLease {
    pub(crate) fn belongs_to(&self, session: &Arc<CodexSession>) -> bool {
        Arc::ptr_eq(&self.session, session)
    }
}

/// Owns a bootstrapped app-server until the caller installs it in AppState.
/// This spans both app-server bootstrap and the rest of workspace restore, so
/// cancelling either phase cannot leave an unattached process tree behind.
pub struct PendingCodexSession {
    session: Option<Arc<CodexSession>>,
}

impl PendingCodexSession {
    fn new(session: Arc<CodexSession>) -> Self {
        Self {
            session: Some(session),
        }
    }

    pub fn activate(mut self) -> Arc<CodexSession> {
        let session = self
            .session
            .take()
            .expect("pending Codex session already activated");
        session.enable_reconnect_on_exit();
        session
            .state
            .schedule_codex_idle_retirement(Arc::clone(&session));
        session
    }
}

impl std::ops::Deref for PendingCodexSession {
    type Target = CodexSession;

    fn deref(&self) -> &Self::Target {
        self.session
            .as_deref()
            .expect("pending Codex session already activated")
    }
}

impl Drop for PendingCodexSession {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            session.expected_exit.store(true, Ordering::Release);
            session.closed.store(true, Ordering::Release);
            session.terminate_process_tree();
        }
    }
}

#[cfg(unix)]
fn kill_process_group(process_group_id: u32) -> std::io::Result<()> {
    let process_group_id = libc::pid_t::try_from(process_group_id)
        .map_err(|_| std::io::Error::other("process group id is out of range"))?;
    let result = unsafe { libc::kill(-process_group_id, libc::SIGKILL) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

impl CodexSession {
    pub async fn connect(
        workspace_id: String,
        workspace_path: String,
        codex_bin: String,
        state: AppState,
    ) -> Result<CodexBootstrap, DaemonError> {
        Self::connect_inner(workspace_id, workspace_path, codex_bin, state, true).await
    }

    /// Reconnects the live control plane without re-listing history that the
    /// daemon already holds. Reconnect used to rebuild and then discard up to
    /// 100 transcripts on every attempt. The explicit boxed future breaks the
    /// recursive `Send` proof formed by stdout handling -> lazy wake -> stdout
    /// handling; changing this back to an `async fn` makes that task graph fail
    /// to compile even though the runtime flow is finite.
    pub fn reconnect(
        workspace_id: String,
        workspace_path: String,
        codex_bin: String,
        state: AppState,
    ) -> Pin<Box<dyn Future<Output = Result<CodexBootstrap, DaemonError>> + Send>> {
        Box::pin(Self::connect_inner(
            workspace_id,
            workspace_path,
            codex_bin,
            state,
            false,
        ))
    }

    async fn connect_inner(
        workspace_id: String,
        workspace_path: String,
        codex_bin: String,
        state: AppState,
        list_threads: bool,
    ) -> Result<CodexBootstrap, DaemonError> {
        let resolved = resolve_agent_binary("codex", &codex_bin);
        let mut command = Command::new(&resolved.executable);
        command.arg("app-server");
        let mcp_servers = crate::connectors::with_builtin_servers(
            crate::connectors::materialize_mcp_servers(&workspace_path, "codex").await,
            &state
                .builtin_connectors(&AgentProvider::CODEX, &workspace_path, None)
                .await,
        );
        let mcp = crate::connectors::codex_mcp_config(&mcp_servers);
        for override_arg in mcp.overrides {
            command.arg("-c").arg(override_arg);
        }
        command
            .arg("-c")
            .arg(crate::connectors::CODEX_TOOL_OUTPUT_TOKEN_LIMIT_OVERRIDE);
        for (key, value) in mcp.env {
            command.env(key, value);
        }
        for (key, value) in crate::connectors::MCP_CLI_TIMEOUT_ENV {
            command.env(*key, *value);
        }
        // Codex's SQLite runtime permits one writer process per database.
        // FalconDeck keeps one app-server per workspace, so sharing the
        // default database makes every process after the first exit during
        // initialization (and also conflicts with the Codex desktop app).
        // The session/rollout home remains unchanged; only runtime indexes are
        // isolated and retained per stable FalconDeck workspace id.
        configure_codex_sqlite_home(&mut command, &state, &workspace_id).await?;
        command
            .current_dir(PathBuf::from(&workspace_path))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Give the wrapper and its native child their own process group. This
        // lets shutdown and cancellation terminate the complete tree without
        // signalling the desktop process that spawned it.
        #[cfg(unix)]
        command.process_group(0);
        if let Some(path) = preferred_command_path(&resolved.executable) {
            command.env("PATH", path);
        }
        strip_terminal_advertising_env(&mut command);
        let mut child = command
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

        #[cfg(unix)]
        let process_group_id = child.id();
        #[cfg(not(unix))]
        let process_group_id = None;

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
            closed: AtomicBool::new(false),
            expected_exit: AtomicBool::new(false),
            reconnect_on_exit: AtomicBool::new(false),
            reconnect_scheduled: AtomicBool::new(false),
            lifecycle_gate: Arc::new(RwLock::new(())),
            last_activity: StdMutex::new(Instant::now()),
            process_group_id,
            state: state.clone(),
        });
        let pending_session = PendingCodexSession::new(Arc::clone(&session));

        {
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                session.read_stdout(stdout).await;
            });
        }

        {
            let workspace_id = workspace_id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let message = strip_terminal_control_sequences(line.trim());
                    if message.is_empty() {
                        continue;
                    }
                    if is_non_fatal_codex_cache_diagnostic(&message) {
                        continue;
                    }
                    tracing::debug!(%workspace_id, "codex app-server stderr: {message}");
                }
            });
        }

        // Any bootstrap failure or cancellation tears the freshly spawned
        // process group down through `pending_session`.
        let bootstrap_result = async {
            session
                .send_control_request(
                    "initialize",
                    json!({
                        "clientInfo": {
                            "name": "falcondeck",
                            "title": "FalconDeck",
                            "version": env!("CARGO_PKG_VERSION")
                        },
                        "capabilities": {
                            "experimentalApi": true
                        }
                    }),
                )
                .await?;
            session.send_notification("initialized", json!({})).await?;

            // Register staged bundled skills (the falcondeck-control skill)
            // as a Codex extra skill root. Experimental and absent from some
            // older app-server releases, so failure must not make the
            // otherwise-stable bootstrap fail.
            if let Some(skill_root) = state.agent_skill_root(&AgentProvider::CODEX).await
                && let Err(error) = session
                    .send_control_request(
                        "skills/extraRoots/set",
                        json!({ "extraRoots": [skill_root] }),
                    )
                    .await
            {
                warn!("Codex skill roots unavailable: {error}");
            }

            let account_value = session
                .send_control_request("account/read", json!({}))
                .await?;
            let account = parse_account(&account_value);
            let models_value = session
                .send_control_request("model/list", json!({}))
                .await?;
            let models = parse_models(&models_value);
            // Experimental and absent from some older app-server releases, so
            // mode discovery must not make the otherwise-stable bootstrap fail.
            let collaboration_modes = match session
                .send_control_request("collaborationMode/list", json!({}))
                .await
            {
                Ok(value) => parse_collaboration_modes(&value),
                Err(error) => {
                    warn!("Codex collaboration modes unavailable: {error}");
                    Vec::new()
                }
            };
            // The list already contains everything the sidebar and snapshots
            // need. Transcripts are resumed lazily when a thread is opened;
            // eagerly issuing 100 sequential thread/read calls made daemon
            // readiness proportional to the user's entire Codex history.
            let threads = if list_threads {
                let threads_value = session
                    .send_control_request(
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
                parse_threads(&workspace_id, &workspace_path, &threads_value)
            } else {
                Vec::new()
            };

            Ok::<_, DaemonError>((account, models, collaboration_modes, threads))
        }
        .await;

        let (account, models, collaboration_modes, threads) = match bootstrap_result {
            Ok(bootstrap) => bootstrap,
            Err(error) => return Err(error),
        };

        Ok(CodexBootstrap {
            session: pending_session,
            account,
            models,
            collaboration_modes,
            threads,
        })
    }

    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    pub(crate) fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub async fn provider_metadata(&self) -> Result<CodexProviderMetadata, DaemonError> {
        let account_value = self.send_control_request("account/read", json!({})).await?;
        let models_value = self.send_control_request("model/list", json!({})).await?;
        let collaboration_modes = self
            .send_control_request("collaborationMode/list", json!({}))
            .await
            .map(|value| parse_collaboration_modes(&value))
            .unwrap_or_default();
        Ok(CodexProviderMetadata {
            account: parse_account(&account_value),
            models: parse_models(&models_value),
            collaboration_modes,
        })
    }

    pub async fn shutdown(&self) -> Result<(), DaemonError> {
        self.expected_exit.store(true, Ordering::Release);
        let was_closed = self.closed.swap(true, Ordering::AcqRel);
        {
            let pending = std::mem::take(&mut *self.pending.lock().await);
            for (_, tx) in pending {
                let _ = tx.send(Err(DaemonError::Rpc(
                    "codex app-server is shutting down".to_string(),
                )));
            }
        }
        // Signal before awaiting the child lock: the stdout task may already
        // hold that lock while waiting for the wrapper to exit.
        if !was_closed {
            self.terminate_process_tree();
        }
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
        Ok(())
    }

    fn terminate_process_tree(&self) {
        #[cfg(unix)]
        if let Some(process_group_id) = self.process_group_id {
            let _ = kill_process_group(process_group_id);
        }

        #[cfg(not(unix))]
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn touch(&self) {
        *self
            .last_activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();
    }

    pub(crate) fn idle_for(&self) -> Duration {
        self.last_activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .elapsed()
    }

    pub(crate) async fn lease(self: &Arc<Self>) -> Option<CodexSessionLease> {
        let guard = Arc::clone(&self.lifecycle_gate).read_owned().await;
        if self.is_closed() {
            return None;
        }
        self.touch();
        Some(CodexSessionLease {
            session: Arc::clone(self),
            _guard: guard,
        })
    }

    pub(crate) async fn retirement_guard(self: &Arc<Self>) -> OwnedRwLockWriteGuard<()> {
        Arc::clone(&self.lifecycle_gate).write_owned().await
    }

    fn enable_reconnect_on_exit(&self) {
        // Sequential consistency with the EOF-side `closed` store makes it
        // impossible for activation and exit to each miss the other's flag.
        self.reconnect_on_exit.store(true, Ordering::SeqCst);
        if self.closed.load(Ordering::SeqCst) {
            self.schedule_reconnect_once();
        }
    }

    fn schedule_reconnect_once(&self) {
        if !self.reconnect_on_exit.load(Ordering::SeqCst)
            || self.expected_exit.load(Ordering::Acquire)
            || self.state.is_shutting_down()
            || self
                .reconnect_scheduled
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }
        self.state
            .schedule_codex_reconnect(self.workspace_id.clone());
    }

    fn disconnected_error(&self) -> DaemonError {
        DaemonError::Rpc("codex app-server is no longer running for this workspace".to_string())
    }

    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, DaemonError> {
        self.send_request_with_timeout(method, params, None).await
    }

    /// Bounded variant of `send_request` for control-plane calls that must not
    /// wait forever on a wedged app-server.
    pub async fn send_control_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, DaemonError> {
        self.send_request_with_timeout(method, params, Some(CONTROL_REQUEST_TIMEOUT))
            .await
    }

    /// The single place a request awaits its response: the timeout branch must
    /// remove the pending entry itself, otherwise an elapsed control request
    /// would leak its response slot in `pending` forever.
    async fn send_request_with_timeout(
        &self,
        method: &str,
        params: Value,
        response_timeout: Option<Duration>,
    ) -> Result<Value, DaemonError> {
        self.touch();
        if self.is_closed() {
            return Err(self.disconnected_error());
        }
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

        let write_result = {
            let mut stdin = self.stdin.lock().await;
            async {
                stdin.write_all(&line).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            }
            .await
        };
        if let Err(error) = write_result {
            self.pending.lock().await.remove(&id);
            return Err(DaemonError::Rpc(format!(
                "failed to send codex request {method}: {error}"
            )));
        }

        let received = match response_timeout {
            Some(duration) => match timeout(duration, rx).await {
                Ok(received) => received,
                Err(_) => {
                    self.pending.lock().await.remove(&id);
                    return Err(DaemonError::Rpc(format!(
                        "codex app-server did not respond to {method} within {}s",
                        duration.as_secs()
                    )));
                }
            },
            None => rx.await,
        };
        let result = match received {
            Ok(result) => result,
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(DaemonError::Rpc(format!(
                    "codex app-server disconnected before responding to {method}"
                )))
            }
        };
        self.touch();
        result
    }

    pub async fn send_notification(&self, method: &str, params: Value) -> Result<(), DaemonError> {
        self.touch();
        if self.is_closed() {
            return Err(self.disconnected_error());
        }
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

    pub async fn resume_thread(&self, thread_id: &str, cwd: &str) -> Result<Value, DaemonError> {
        let instructions = self
            .state
            .agent_context_instructions_with_extensions(&AgentProvider::CODEX)
            .await;
        let mut response = self
            .send_control_request(
                "thread/resume",
                thread_resume_params(thread_id, cwd, instructions.as_deref()),
            )
            .await?;

        // Legacy histories still arrive in `thread.turns`. Paginated Codex
        // Desktop histories instead return a descending first page beside the
        // thread record and require `thread/turns/list` for the rest.
        if turns_page(&response).is_none() {
            return Ok(response);
        }

        let mut newest_first = turns_page_data(&response);
        let mut next_cursor = turns_page_next_cursor(&response);
        let mut seen_cursors = HashSet::new();
        while let Some(cursor) = next_cursor {
            if !seen_cursors.insert(cursor.clone()) {
                warn!(%thread_id, %cursor, "Codex turn pagination repeated a cursor");
                break;
            }
            let page = match self
                .send_control_request(
                    "thread/turns/list",
                    json!({
                        "threadId": thread_id,
                        "cursor": cursor,
                        "limit": CODEX_TURN_PAGE_SIZE,
                        "sortDirection": "desc",
                        "itemsView": "full"
                    }),
                )
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    warn!(%thread_id, %error, "could not load an older Codex turn page");
                    break;
                }
            };
            newest_first.extend(turns_page_data(&page));
            next_cursor = turns_page_next_cursor(&page);
        }
        install_paginated_turns(&mut response, newest_first);
        Ok(response)
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
        self.write_raw_message(payload).await
    }

    /// Reply to a server-initiated request with a JSON-RPC error. Leaving a
    /// server request unanswered stalls the app-server turn indefinitely, so
    /// unsupported methods must still get an error response.
    pub async fn respond_to_request_with_error(
        &self,
        raw_id: Value,
        message: &str,
    ) -> Result<(), DaemonError> {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": raw_id,
            "error": {
                "code": -32601,
                "message": message
            }
        });
        self.write_raw_message(payload).await
    }

    async fn write_raw_message(&self, payload: Value) -> Result<(), DaemonError> {
        self.touch();
        if self.is_closed() {
            return Err(self.disconnected_error());
        }
        let line = serde_json::to_vec(&payload)?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn read_stdout(self: Arc<Self>, stdout: tokio::process::ChildStdout) {
        enum StdoutEvent {
            Line(String),
            Disconnected(Option<String>),
        }

        // The pipe is drained by its own task, decoupled from event handling:
        // the app-server stalls mid-turn if nothing empties the 64KB pipe
        // buffer, so slow handling (snapshot broadcasts, state writes) must
        // never be what reads stdout. Same pattern as the Claude CLI runtime.
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<StdoutEvent>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if event_tx.send(StdoutEvent::Line(line)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = event_tx.send(StdoutEvent::Disconnected(Some(error.to_string())));
                        return;
                    }
                }
            }
            let _ = event_tx.send(StdoutEvent::Disconnected(None));
        });

        while let Some(event) = event_rx.recv().await {
            let line = match event {
                StdoutEvent::Disconnected(error) => {
                    let degraded = !self.expected_exit.load(Ordering::Acquire)
                        && !self.state.is_shutting_down();
                    match error {
                        Some(error) => {
                            warn!("codex stdout read error: {error}");
                            if degraded {
                                let _ = self.state.upsert_operational_condition(
                                    self.workspace_id.clone(),
                                    "codex_connection",
                                    falcondeck_core::ServiceLevel::Error,
                                    format!("Codex stream error: {error}"),
                                    Some("stream-error".to_string()),
                                );
                            }
                        }
                        None => {
                            if degraded {
                                let _ = self.state.upsert_operational_condition(
                                    self.workspace_id.clone(),
                                    "codex_connection",
                                    falcondeck_core::ServiceLevel::Warning,
                                    "Codex app-server disconnected".to_string(),
                                    Some("disconnect".to_string()),
                                );
                            }
                        }
                    }
                    break;
                }
                StdoutEvent::Line(line) => line,
            };
            if line.trim().is_empty() {
                continue;
            }
            self.touch();

            match serde_json::from_str::<Value>(&line) {
                Ok(message) => {
                    if let Some(id) = message.get("id").and_then(Value::as_u64)
                        && message.get("method").is_none()
                    {
                        if let Some(tx) = self.pending.lock().await.remove(&id) {
                            if let Some(error) = message.get("error") {
                                let _ = tx.send(Err(DaemonError::Rpc(error.to_string())));
                            } else {
                                let _ = tx.send(Ok(message
                                    .get("result")
                                    .cloned()
                                    .unwrap_or(Value::Null)));
                            }
                        }
                        continue;
                    }

                    if let Some(method) = message.get("method").and_then(Value::as_str) {
                        let params = message.get("params").cloned().unwrap_or(Value::Null);
                        if message.get("id").is_some() {
                            if let Some(raw_id) = message.get("id").cloned()
                                && let Err(error) = self
                                    .state
                                    .ingest_server_request(
                                        &self.workspace_id,
                                        raw_id,
                                        method,
                                        params,
                                    )
                                    .await
                            {
                                warn!("failed to ingest server request {method}: {error}");
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
                }
            }
        }

        // The app-server is gone. Mark the session closed so new requests fail
        // fast, then fail every in-flight request — otherwise their callers
        // would wait on the response channel forever.
        // Pairs with activation's SeqCst store/load so an exit concurrent with
        // attachment always schedules on one side of the race.
        self.closed.store(true, Ordering::SeqCst);
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, tx) in pending {
            let _ = tx.send(Err(DaemonError::Rpc(
                "codex app-server disconnected before responding".to_string(),
            )));
        }

        if !self.expected_exit.load(Ordering::Acquire) && !self.state.is_shutting_down() {
            self.state
                .fail_active_provider_threads(
                    &self.workspace_id,
                    &falcondeck_core::AgentProvider::CODEX,
                    "Codex app-server disconnected while this turn was running",
                )
                .await;
        }

        let _ = self.child.lock().await.wait().await;

        self.schedule_reconnect_once();
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

        if let Some(thread) = value.get("thread")
            && let Some(found) = walk(thread)
        {
            return Some(found);
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

pub(crate) fn hydrate_thread_items(value: &Value) -> Vec<ConversationItem> {
    let Some(thread) = extract_thread_record(value) else {
        return Vec::new();
    };
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut items = Vec::new();
    let mut previous_turn_id = None;
    for turn in turns {
        let turn_start_index = items.len();
        let turn_id = extract_string(&turn, &["id"]);
        let turn_lifecycle = content_lifecycle_for_status(
            extract_string(&turn, &["status"]).as_deref(),
            ContentLifecycle::Complete,
        );
        let turn_items = turn
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let turn_time = extract_datetime_or_timestamp(
            &turn,
            &["startedAt", "started_at", "completedAt", "completed_at"],
        );
        let mut saw_user_message = false;
        for item in turn_items {
            let is_user_message = extract_string(&item, &["type"])
                .is_some_and(|item_type| item_type == "userMessage");
            let editable_turn_id = (!saw_user_message).then_some(turn_id.as_deref()).flatten();
            if let Some(mut converted) = build_conversation_item_from_thread_item(
                &item,
                editable_turn_id,
                previous_turn_id.as_deref(),
                turn_lifecycle,
                turn_time,
            ) {
                let existing_review_index = match &converted {
                    ConversationItem::CodeReview { id, .. } => items[turn_start_index..]
                        .iter()
                        .position(|entry| {
                            matches!(entry, ConversationItem::CodeReview { id: existing, .. } if existing == id)
                        })
                        .map(|index| turn_start_index + index),
                    _ => None,
                };
                if let Some(index) = existing_review_index {
                    let existing = items[index].clone();
                    merge_code_review_item(&existing, &mut converted);
                    items[index] = converted;
                } else {
                    items.push(converted);
                }
            }
            saw_user_message |= is_user_message;
        }
        let terminal_at = extract_datetime_or_timestamp(
            &turn,
            &["completedAt", "completed_at", "startedAt", "started_at"],
        )
        .or_else(|| {
            items[turn_start_index..]
                .iter()
                .filter_map(conversation_item_created_at)
                .max()
        })
        .unwrap_or_else(Utc::now);
        if let Some(receipt) = terminal_assistant_receipt(
            &items[turn_start_index..],
            turn_lifecycle,
            terminal_at,
            turn_id.as_deref(),
        ) {
            items.push(receipt);
        }
        previous_turn_id = turn_id;
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

fn build_conversation_item_from_thread_item(
    item: &Value,
    turn_id: Option<&str>,
    previous_turn_id: Option<&str>,
    turn_lifecycle: ContentLifecycle,
    fallback_created_at: Option<chrono::DateTime<Utc>>,
) -> Option<ConversationItem> {
    let id = extract_string(item, &["id"])?;
    let item_type = extract_string(item, &["type"])?;
    let created_at = extract_datetime_or_timestamp(item, &["createdAt", "created_at", "timestamp"])
        .or(fallback_created_at)
        .unwrap_or_else(Utc::now);

    match item_type.as_str() {
        "userMessage" | "user_message" => {
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
                turn_id: turn_id.map(str::to_string),
                previous_turn_id: previous_turn_id.map(str::to_string),
                created_at,
            })
        }
        "agentMessage" | "agent_message" => codex_assistant_conversation_item(
            item,
            created_at,
            content_lifecycle_for_status(
                extract_string(item, &["status"]).as_deref(),
                turn_lifecycle,
            ),
        ),
        "reasoning" | "reasoningSummary" | "reasoning_summary" => {
            codex_reasoning_conversation_item(item, created_at, turn_lifecycle, None)
        }
        "hookPrompt" | "hook_prompt" => codex_hook_prompt_conversation_item(item, created_at),
        "plan" => codex_plan_conversation_item(item, created_at),
        "imageGeneration" | "image_generation" | "imageView" | "image_view" => {
            codex_image_conversation_item(
                item,
                created_at,
                content_lifecycle_for_status(
                    extract_string(item, &["status"]).as_deref(),
                    turn_lifecycle,
                ),
            )
        }
        "webSearch" | "web_search" => codex_web_search_conversation_item(
            item,
            created_at,
            content_lifecycle_for_status(
                extract_string(item, &["status"]).as_deref(),
                turn_lifecycle,
            ),
        ),
        "fileChange" | "file_change" => codex_file_change_conversation_item(
            item,
            created_at,
            "completed",
            extract_datetime_or_timestamp(item, &["completedAt", "completed_at"]),
        ),
        "contextCompaction" | "context_compaction" => codex_context_compaction_conversation_item(
            item,
            created_at,
            crate::app::conversation_helpers::tool_lifecycle(
                extract_string(item, &["status"])
                    .as_deref()
                    .unwrap_or("completed"),
                None,
                falcondeck_core::ToolActivityKind::Context,
            ),
            extract_datetime_or_timestamp(item, &["completedAt", "completed_at"]),
        ),
        "commandExecution"
        | "command_execution"
        | "mcpToolCall"
        | "mcp_tool_call"
        | "dynamicToolCall"
        | "dynamic_tool_call"
        | "collabAgentToolCall"
        | "collab_agent_tool_call"
        | "subAgentActivity"
        | "sub_agent_activity"
        | "sleep" => {
            let output = codex_tool_call_output(item).or_else(|| {
                extract_string(
                    item,
                    &[
                        "aggregatedOutput",
                        "aggregated_output",
                        "output",
                        "stdout",
                        "result",
                        "detail",
                        "query",
                    ],
                )
            });
            let status =
                extract_string(item, &["status"]).unwrap_or_else(|| "completed".to_string());
            let exit_code = item
                .get("exitCode")
                .or_else(|| item.get("exit_code"))
                .and_then(Value::as_i64)
                .map(|value| value as i32);
            let title = restored_tool_title(item, &item_type);
            let mut conversation_item = ConversationItem::ToolCall {
                id,
                title: title.clone(),
                tool_kind: item_type.clone(),
                status: status.clone(),
                output: output.clone(),
                exit_code,
                display: Box::new(tool_display_metadata(
                    &title,
                    &item_type,
                    &status,
                    exit_code,
                    output.as_deref(),
                )),
                detail: codex_tool_call_detail(item).map(Box::new),
                created_at,
                completed_at: extract_datetime_or_timestamp(item, &["completedAt", "completed_at"]),
            };
            sanitize_conversation_item(&mut conversation_item);
            Some(conversation_item)
        }
        "enteredReviewMode" | "entered_review_mode" | "exitedReviewMode" | "exited_review_mode" => {
            codex_review_mode_conversation_item(item, created_at, turn_lifecycle)
        }
        "artifactPreview" | "artifact_preview" | "artifact" => {
            codex_artifact_conversation_item(item, created_at, turn_lifecycle)
        }
        _ if crate::app::conversation_helpers::should_surface_tool_item(&item_type) => {
            unsupported_conversation_item(
                item,
                created_at,
                content_lifecycle_for_status(
                    extract_string(item, &["status"]).as_deref(),
                    turn_lifecycle,
                ),
            )
        }
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

fn is_codex_image_wrapper_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.eq_ignore_ascii_case("</image>")
        || trimmed.starts_with("<image ")
        || trimmed.starts_with("<image>")
}

fn parse_user_message_content(item_id: &str, content: &[Value]) -> (String, Vec<ImageInput>) {
    let mut text_parts = Vec::new();
    let mut attachments = Vec::new();

    for (index, entry) in content.iter().enumerate() {
        let Some(item_type) = extract_string(entry, &["type"]) else {
            continue;
        };
        match item_type.as_str() {
            "text" | "input_text" | "inputText" => {
                if let Some(text) = extract_string(entry, &["text"])
                    && !is_codex_image_wrapper_text(&text)
                {
                    text_parts.push(text);
                }
            }
            "image" | "localImage" | "input_image" | "inputImage" => {
                let local_path = extract_string(entry, &["path"]).filter(|value| !value.is_empty());
                let url = extract_string(
                    entry,
                    &["url", "imageUrl", "image_url", "value", "data", "source"],
                )
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
        let text = text.trim();
        return (!text.is_empty()).then(|| text.to_string());
    }
    let joined = value
        .as_array()?
        .iter()
        .filter_map(|part| {
            part.as_str()
                .map(str::to_string)
                .or_else(|| extract_string(part, &["text"]))
        })
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.is_empty()).then_some(joined)
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

fn restored_tool_title(item: &Value, item_type: &str) -> String {
    if let Some(title) = codex_tool_call_title(item) {
        return title;
    }
    if let Some(title) = extract_string(item, &["title", "label", "command"]) {
        return title;
    }

    if let Some(command) = item
        .get("command")
        .and_then(|command| extract_string(command, &["command", "title", "label"]))
    {
        return command;
    }

    match item_type {
        "webSearch" => extract_string(item, &["query"])
            .or_else(|| {
                item.get("payload")
                    .and_then(|payload| extract_string(payload, &["query"]))
            })
            .map(|query| format!("Web search: {}", truncate_preview(&query)))
            .unwrap_or_else(|| thread_tool_title(item_type)),
        "imageView" => extract_string(item, &["path", "url", "source"])
            .or_else(|| {
                item.get("payload")
                    .and_then(|payload| extract_string(payload, &["path", "url", "source"]))
            })
            .map(|source| format!("Image view: {}", truncate_preview(&source)))
            .unwrap_or_else(|| thread_tool_title(item_type)),
        _ => thread_tool_title(item_type),
    }
}

/// Machine-readable action markers like `::git-push{cwd="…"}` that Codex
/// appends to message text. The chat UI renders them as chips; previews
/// drop them entirely.
fn is_directive_line(line: &str) -> bool {
    let line = line.trim();
    let Some(rest) = line.strip_prefix("::") else {
        return false;
    };
    let Some(brace) = rest.find('{') else {
        return false;
    };
    let name = &rest[..brace];
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && rest.ends_with('}')
}

fn truncate_preview(text: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 96;
    let without_directives = text
        .lines()
        .filter(|line| !is_directive_line(line))
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = without_directives.trim();
    if trimmed.chars().count() <= MAX_PREVIEW_CHARS {
        return trimmed.to_string();
    }
    let preview = trimmed.chars().take(MAX_PREVIEW_CHARS).collect::<String>();
    format!("{preview}...")
}

pub(crate) fn conversation_item_created_at(
    item: &ConversationItem,
) -> Option<chrono::DateTime<Utc>> {
    Some(match item {
        ConversationItem::UserMessage { created_at, .. }
        | ConversationItem::AssistantMessage { created_at, .. }
        | ConversationItem::Reasoning { created_at, .. }
        | ConversationItem::CodeReview { created_at, .. }
        | ConversationItem::ContextCompaction { created_at, .. }
        | ConversationItem::Artifact { created_at, .. }
        | ConversationItem::Unsupported { created_at, .. }
        | ConversationItem::Image { created_at, .. }
        | ConversationItem::WebSearch { created_at, .. }
        | ConversationItem::FileChange { created_at, .. }
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
    // App-server's user-facing title is `name`. `title` is a legacy alias.
    let raw = value
        .get("name")
        .or_else(|| value.get("threadName"))
        .or_else(|| value.get("thread_name"))
        .or_else(|| value.get("title"))
        .or_else(|| value.get("thread").and_then(|thread| thread.get("name")))
        .or_else(|| value.get("thread").and_then(|thread| thread.get("title")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    sanitize_codex_preview(raw)
}

pub(crate) fn is_codex_attachment_manifest(text: &str) -> bool {
    let heading = text
        .trim_start()
        .trim_start_matches('#')
        .trim_start()
        .to_ascii_lowercase();
    heading.starts_with("files mentioned by the user")
        || heading.starts_with("files pasted by the user")
}

/// Codex Desktop / ChatGPT wrap pasted files in a markdown manifest and put
/// the typed prompt after `## My request…`. App-server's `preview` is that
/// whole blob, which is why the sidebar otherwise shows the heading.
pub(crate) fn sanitize_codex_preview(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !is_codex_attachment_manifest(trimmed) {
        return Some(trimmed.to_string());
    }
    let heading = trimmed.find("## My request")?;
    let colon = trimmed[heading..].find(':')? + heading;
    let body = trimmed[colon + 1..].trim();
    if body.is_empty() || is_codex_attachment_manifest(body) {
        return None;
    }
    Some(collapse_whitespace(body))
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
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
            let id = extract_string(entry, &["id", "stepId", "step_id"])
                .filter(|value| !value.trim().is_empty());
            Some(falcondeck_core::PlanStep { id, step, status })
        })
        .collect::<Vec<_>>();

    Some(ThreadPlan { explanation, steps })
}

/// Parses a `thread/goal/updated` notification payload into a `ThreadGoal`.
pub fn parse_thread_goal(value: &Value) -> Option<falcondeck_core::ThreadGoal> {
    let goal = value.get("goal")?;
    let objective = extract_string(goal, &["objective"])?;
    Some(falcondeck_core::ThreadGoal {
        objective,
        status: extract_string(goal, &["status"]).unwrap_or_else(|| "active".to_string()),
        token_budget: goal.get("tokenBudget").and_then(Value::as_i64),
        tokens_used: goal.get("tokensUsed").and_then(Value::as_i64),
        time_used_seconds: goal.get("timeUsedSeconds").and_then(Value::as_i64),
        started_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use falcondeck_core::ToolHistoryMode;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn thread_start_params_omit_base_instructions_and_effort() {
        let params = thread_start_params(
            "/tmp/project",
            Some("gpt-5.4"),
            Some("workspace-write"),
            "on-request",
            Some("keep FalconDeck control short"),
        );
        assert!(params.get("baseInstructions").is_none());
        assert!(params.get("effort").is_none());
        assert!(params.get("config").is_none());
        assert_eq!(
            params["developerInstructions"],
            "keep FalconDeck control short"
        );
        assert_eq!(params["sandbox"], "workspace-write");
        assert_eq!(params["approvalPolicy"], "on-request");
    }

    #[test]
    fn thread_resume_params_omit_base_instructions_and_effort() {
        let params = thread_resume_params(
            "thread-1",
            "/tmp/project",
            Some("keep FalconDeck control short"),
        );
        assert!(params.get("baseInstructions").is_none());
        assert!(params.get("effort").is_none());
        assert!(params.get("config").is_none());
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(
            params["developerInstructions"],
            "keep FalconDeck control short"
        );
        assert_eq!(params["excludeTurns"], true);
        assert_eq!(params["initialTurnsPage"]["limit"], CODEX_TURN_PAGE_SIZE);
        assert_eq!(params["initialTurnsPage"]["sortDirection"], "desc");
        assert_eq!(params["initialTurnsPage"]["itemsView"], "full");
    }

    #[test]
    fn installs_paginated_codex_turns_in_chronological_order() {
        let mut response = json!({
            "thread": {
                "id": "thread-1",
                "turns": []
            }
        });
        install_paginated_turns(
            &mut response,
            vec![
                json!({
                    "id": "turn-new",
                    "status": "completed",
                    "startedAt": 1_800_000_000,
                    "items": [{
                        "id": "user-new",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "Second request"}]
                    }]
                }),
                json!({
                    "id": "turn-old",
                    "status": "completed",
                    "startedAt": 1_700_000_000,
                    "items": [{
                        "id": "user-old",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "First request"}]
                    }]
                }),
            ],
        );

        let items = hydrate_thread_items(&response);
        let messages = items
            .iter()
            .filter_map(|item| match item {
                ConversationItem::UserMessage { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(messages, vec!["First request", "Second request"]);
    }

    #[test]
    fn turn_start_params_include_effort_and_omit_config_bag() {
        let params = turn_start_params(
            "thread-1",
            vec![json!({ "type": "text", "text": "hi" })],
            Some("/tmp/project"),
            Some("gpt-5.4"),
            Some("high"),
            json!({ "mode": "default", "settings": { "model": "gpt-5.4" } }),
            json!({ "type": "workspaceWrite" }),
            Some("never"),
            Some("priority"),
        );
        assert_eq!(params["effort"], "high");
        assert!(params.get("config").is_none());
        assert_eq!(params["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(params["serviceTier"], "priority");
    }

    #[test]
    fn turn_start_params_omit_null_overrides() {
        let params = turn_start_params(
            "thread-1",
            vec![json!({ "type": "text", "text": "hi" })],
            None,
            None,
            None,
            Value::Null,
            Value::Null,
            None,
            None,
        );
        assert!(params.get("model").is_none());
        assert!(params.get("effort").is_none());
        assert!(params.get("collaborationMode").is_none());
        assert!(params.get("sandboxPolicy").is_none());
        assert!(params.get("approvalPolicy").is_none());
        assert!(params.get("serviceTier").is_none());
        assert!(params.get("cwd").is_none());
    }

    #[test]
    fn app_server_approval_policy_maps_unless_trusted_to_untrusted() {
        assert_eq!(app_server_approval_policy("unlessTrusted"), "untrusted");
        assert_eq!(app_server_approval_policy("onRequest"), "on-request");
        assert_eq!(app_server_approval_policy("never"), "never");
    }

    #[test]
    fn app_server_sandbox_mode_uses_config_style_on_thread_requests() {
        assert_eq!(app_server_sandbox_mode("workspaceWrite"), "workspace-write");
        assert_eq!(app_server_sandbox_mode("readOnly"), "read-only");
        assert_eq!(
            app_server_sandbox_mode("dangerFullAccess"),
            "danger-full-access"
        );
    }

    #[test]
    fn server_request_expects_result_for_approvals_and_questions() {
        assert!(server_request_expects_result(
            "item/commandExecution/requestApproval"
        ));
        assert!(server_request_expects_result("item/tool/requestUserInput"));
        assert!(server_request_expects_result(
            "mcpServer/elicitation/request"
        ));
        assert!(!server_request_expects_result("item/tool/call"));
        assert!(!server_request_expects_result(
            "account/chatgptAuthTokens/refresh"
        ));
    }

    #[cfg(unix)]
    fn sleeping_test_session() -> (tempfile::TempDir, Arc<CodexSession>) {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            directory.path().join("state.json"),
        );
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let process_group_id = child.id().unwrap();
        let stdin = child.stdin.take().unwrap();
        let session = Arc::new(CodexSession {
            workspace_id: "workspace-1".to_string(),
            workspace_path: directory.path().to_string_lossy().to_string(),
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            expected_exit: AtomicBool::new(false),
            reconnect_on_exit: AtomicBool::new(false),
            reconnect_scheduled: AtomicBool::new(false),
            lifecycle_gate: Arc::new(RwLock::new(())),
            last_activity: StdMutex::new(Instant::now()),
            process_group_id: Some(process_group_id),
            state,
        });
        (directory, session)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn isolated_process_group_can_be_terminated_as_one_unit() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let process_group_id = child.id().unwrap();

        kill_process_group(process_group_id).unwrap();
        let status = timeout(Duration::from_secs(2), child.wait())
            .await
            .expect("isolated process group should stop promptly")
            .unwrap();

        assert!(!status.success());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_unattached_session_terminates_its_process_group() {
        let (_directory, session) = sleeping_test_session();

        drop(PendingCodexSession::new(Arc::clone(&session)));
        let status = timeout(Duration::from_secs(2), session.child.lock().await.wait())
            .await
            .expect("dropping the unattached lease should stop the process")
            .unwrap();

        assert!(!status.success());
        assert!(session.is_closed());
        assert!(session.expected_exit.load(Ordering::Acquire));
        assert!(!session.reconnect_scheduled.load(Ordering::Acquire));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retirement_waits_for_an_active_operation_lease() {
        let (_directory, session) = sleeping_test_session();
        let lease = session.lease().await.expect("session should be live");
        let (acquired_tx, mut acquired_rx) = oneshot::channel();
        let retire_session = Arc::clone(&session);
        let waiter = tokio::spawn(async move {
            let _guard = retire_session.retirement_guard().await;
            let _ = acquired_tx.send(());
        });

        assert!(
            timeout(Duration::from_millis(50), &mut acquired_rx)
                .await
                .is_err(),
            "retirement must wait while an operation owns a live session"
        );
        drop(lease);
        timeout(Duration::from_secs(2), &mut acquired_rx)
            .await
            .expect("retirement should proceed when the operation completes")
            .expect("retirement waiter should stay alive");
        waiter.await.unwrap();

        session.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn codex_runtime_database_is_isolated_per_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            directory.path().join("state.json"),
        );
        let mut command = Command::new("codex");

        configure_codex_sqlite_home(&mut command, &state, "workspace-1")
            .await
            .unwrap();

        let expected = directory.path().join("codex-sqlite/workspace-1");
        let configured = command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new(CODEX_SQLITE_HOME_ENV))
            .and_then(|(_, value)| value)
            .map(PathBuf::from);
        assert_eq!(configured.as_deref(), Some(expected.as_path()));
        assert!(expected.is_dir());
    }

    #[test]
    fn codex_runtime_database_rejects_unsafe_workspace_ids() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            directory.path().join("state.json"),
        );

        let error = codex_sqlite_home(&state, "../shared").unwrap_err();

        assert!(error.to_string().contains("invalid workspace id"));
    }

    #[test]
    fn prefers_account_identity_over_requires_auth_flag() {
        let account = parse_account(&json!({
            "account": {
                "type": "chatgpt",
                "email": "dev@example.com"
            },
            "requiresOpenaiAuth": true
        }));
        assert_eq!(account.status, AccountStatus::Ready);
        assert_eq!(account.label, "dev@example.com");
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
    fn parses_current_collaboration_mode_masks() {
        let modes = parse_collaboration_modes(&json!({
            "data": [
                {"name": "Plan", "mode": "plan", "model": null, "reasoning_effort": "medium"},
                {"name": "Default", "mode": "default", "model": null, "reasoning_effort": null}
            ]
        }));
        assert_eq!(modes.len(), 2);
        assert_eq!(modes[0].id, "plan");
        assert_eq!(modes[0].label, "Plan");
        assert_eq!(modes[0].reasoning_effort.as_deref(), Some("medium"));
        assert!(modes[0].is_native);
    }

    #[test]
    fn strips_ansi_sequences_from_codex_stderr() {
        let raw = "\u{1b}[2m2026-08-09T10:52:51.408419Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m codex_models_manager::cache: failed to load models cache";
        assert_eq!(
            strip_terminal_control_sequences(raw),
            "2026-08-09T10:52:51.408419Z ERROR codex_models_manager::cache: failed to load models cache"
        );
    }

    #[test]
    fn suppresses_non_fatal_models_cache_schema_diagnostics() {
        assert!(is_non_fatal_codex_cache_diagnostic(
            "2026-08-10T09:17:33.337763Z ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 94 column 5"
        ));
        assert!(is_non_fatal_codex_cache_diagnostic(
            "2026-08-10T09:17:33.337763Z ERROR codex_models_manager::cache: failed to renew cache TTL: missing field `base_instructions` at line 94 column 5"
        ));
        // Newer Codex builds log under `::manager` instead of `::cache`.
        assert!(is_non_fatal_codex_cache_diagnostic(
            "2026-08-10T15:12:07.789333Z ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `base_instructions` at line 94 column 5"
        ));
        assert!(is_non_fatal_codex_cache_diagnostic(
            r#"{"timestamp":"2026-08-10T09:17:33Z","level":"ERROR","fields":{"message":"failed to renew cache TTL: missing field `base_instructions` at line 94 column 5"},"target":"codex_models_manager::cache"}"#
        ));
        assert!(is_non_fatal_codex_cache_diagnostic(
            r#"{"timestamp":"2026-08-10T15:12:07Z","level":"ERROR","fields":{"message":"failed to renew cache TTL: missing field `base_instructions` at line 94 column 5"},"target":"codex_models_manager::manager"}"#
        ));
    }

    #[test]
    fn keeps_other_codex_cache_failures_visible() {
        assert!(!is_non_fatal_codex_cache_diagnostic(
            "2026-08-10T09:17:33.337763Z ERROR codex_models_manager::cache: failed to refresh available models: network unavailable"
        ));
        assert!(!is_non_fatal_codex_cache_diagnostic(
            "2026-08-10T09:17:33.337763Z ERROR codex_models_manager::cache: failed to renew cache TTL: permission denied"
        ));
        assert!(!is_non_fatal_codex_cache_diagnostic(
            "2026-08-10T15:12:07.789333Z ERROR codex_models_manager::manager: failed to renew cache TTL: permission denied"
        ));
        // Message alone (without models-manager target) is not suppressed —
        // only Codex's known cache-schema compatibility noise is filtered.
        assert!(!is_non_fatal_codex_cache_diagnostic(
            "failed to renew cache TTL: missing field `base_instructions` at line 94 column 5"
        ));
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
        assert!(models[0].service_tiers.is_empty());
        assert_eq!(models[0].default_service_tier, None);
    }

    #[test]
    fn parses_model_service_tiers() {
        let models = parse_models(&json!([{
            "id": "gpt-5.6-sol",
            "displayName": "GPT-5.6-Sol",
            "supportedReasoningEfforts": [],
            "additionalSpeedTiers": ["fast"],
            "serviceTiers": [
                {"id": "priority", "name": "Fast", "description": "1.5x speed, increased usage"}
            ],
            "defaultServiceTier": "priority"
        }]));
        assert_eq!(models.len(), 1);
        let tiers = &models[0].service_tiers;
        assert_eq!(tiers.len(), 1);
        assert_eq!(tiers[0].id, "priority");
        assert_eq!(tiers[0].name, "Fast");
        assert_eq!(tiers[0].description, "1.5x speed, increased usage");
        assert_eq!(models[0].default_service_tier.as_deref(), Some("priority"));
    }

    #[test]
    fn parses_plan_steps() {
        let plan = parse_thread_plan(&json!({
            "explanation": "Work in slices",
            "plan": [{"id": "step-1", "step": "Build daemon", "status": "in_progress"}]
        }))
        .unwrap();
        assert_eq!(plan.steps[0].id.as_deref(), Some("step-1"));
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
        assert!(threads[0].items.is_empty());
        assert_eq!(
            threads[0].summary.native_session_id.as_deref(),
            Some("thread-1")
        );
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
        assert!(threads[0].title_is_provider_preview);
        assert_eq!(
            threads[0].summary.updated_at.to_rfc3339(),
            "2026-03-16T13:26:59+00:00"
        );
    }

    #[test]
    fn prefers_codex_thread_name_over_preview() {
        let threads = parse_threads(
            "workspace-1",
            "/Users/james/project-a",
            &json!([{
                "id": "thread-1",
                "name": "Lucid Mobile app",
                "preview": "# Files mentioned by the user:\n\n## codex-clipboard-5c77f1c0.png: /tmp/clip.png\n\n## My request for Codex:\nwhat is causing this prompt to be restricted?",
                "cwd": "/Users/james/project-a"
            }]),
        );

        assert_eq!(threads[0].summary.title, "Lucid Mobile app");
        assert!(!threads[0].title_is_provider_preview);
    }

    #[test]
    fn titles_codex_attachment_previews_from_the_typed_request() {
        let threads = parse_threads(
            "workspace-1",
            "/Users/james/project-a",
            &json!([{
                "id": "thread-1",
                "preview": "# Files mentioned by the user:\n\n## codex-clipboard-5c77f1c0-fabc.png: /var/folders/nv/T/codex-clipboard-5c77f1c0-fabc.png\n\n## My request for Codex:\nwhat is causing this prompt to be restricted?",
                "cwd": "/Users/james/project-a"
            }]),
        );

        assert_eq!(
            threads[0].summary.title,
            "what is causing this prompt to be restricted?"
        );
        assert!(threads[0].title_is_provider_preview);
        assert_eq!(
            threads[0].summary.last_message_preview.as_deref(),
            Some("what is causing this prompt to be restricted?")
        );
    }

    #[test]
    fn drops_codex_attachment_previews_with_no_typed_request() {
        let threads = parse_threads(
            "workspace-1",
            "/Users/james/project-a",
            &json!([{
                "id": "thread-1",
                "preview": "# Files mentioned by the user:\n\n## codex-clipboard-86050d43.png: /tmp/clip.png\n\n## My request for Codex:\n",
                "cwd": "/Users/james/project-a"
            }]),
        );

        assert_eq!(threads[0].summary.title, "Untitled thread");
        assert!(!threads[0].title_is_provider_preview);
        assert_eq!(threads[0].summary.last_message_preview, None);
    }

    #[test]
    fn sanitize_codex_preview_peels_attachment_manifests() {
        assert_eq!(
            sanitize_codex_preview("  Fix the waveform  ").as_deref(),
            Some("Fix the waveform")
        );
        assert_eq!(sanitize_codex_preview("   "), None);
        assert_eq!(
            sanitize_codex_preview(
                "# Files mentioned by the user:\n\n## clip.png: /tmp/clip.png\n\n## My request for Codex:\nwhat is causing this prompt to be restricted?"
            )
            .as_deref(),
            Some("what is causing this prompt to be restricted?")
        );
        assert_eq!(
            sanitize_codex_preview(
                "# Files mentioned by the user:\n\n## clip.png: /tmp/clip.png\n\n## My request:\nship it"
            )
            .as_deref(),
            Some("ship it")
        );
        assert_eq!(
            sanitize_codex_preview(
                "# Files mentioned by the user:\n\n## clip.png: /tmp/clip.png\n\n## My request for Codex:\n"
            ),
            None
        );
        assert_eq!(
            sanitize_codex_preview(
                "# Files pasted by the user:\n\n## \"# Handoff ## Goal Prepare a campaign\": /tmp/pasted-text.txt\n\nPasted text contains the user's request.\n\n## My request:\n"
            ),
            None
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
    fn session_file_hydration_pairs_custom_tool_calls_with_saved_outputs() {
        let mut file = NamedTempFile::new().unwrap();
        for entry in [
            json!({
                "timestamp": "2026-08-11T10:43:29.220Z",
                "type": "session_meta",
                "payload": { "cwd": "/Users/james/project-a" }
            }),
            json!({
                "timestamp": "2026-08-11T10:43:30.000Z",
                "type": "response_item",
                "payload": {
                    "type": "reasoning",
                    "id": "reasoning-1",
                    "summary": [],
                    "content": []
                }
            }),
            json!({
                "timestamp": "2026-08-11T10:43:31.836Z",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "id": "tool-1",
                    "status": "completed",
                    "call_id": "call-1",
                    "name": "exec",
                    "input": "const result = await tools.exec_command({ cmd: 'git status' });"
                }
            }),
            json!({
                "timestamp": "2026-08-11T10:43:31.939Z",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call-1",
                    "output": [
                        { "type": "input_text", "text": "Script completed" },
                        { "type": "input_text", "text": "M src/main.rs" }
                    ]
                }
            }),
        ] {
            writeln!(file, "{}", serde_json::to_string(&entry).unwrap()).unwrap();
        }

        let items = hydrate_thread_items_from_session_file(
            file.path().to_str().unwrap(),
            "/Users/james/project-a",
        );

        assert!(matches!(
            items.as_slice(),
            [
                ConversationItem::Reasoning { id: reasoning_id, .. },
                ConversationItem::ToolCall {
                    id: tool_id,
                    title,
                    status,
                    output: Some(output),
                    completed_at: Some(completed_at),
                    ..
                }
            ] if reasoning_id == "reasoning-1"
                && tool_id == "tool-1"
                && title == "exec"
                && status == "completed"
                && output == "Script completed\nM src/main.rs"
                && completed_at.to_rfc3339() == "2026-08-11T10:43:31.939+00:00"
        ));
    }

    #[test]
    fn session_file_hydration_reads_structured_reasoning_parts() {
        let mut file = NamedTempFile::new().unwrap();
        for entry in [
            json!({
                "timestamp": "2026-08-11T10:43:29.220Z",
                "type": "session_meta",
                "payload": { "cwd": "/Users/james/project-a" }
            }),
            json!({
                "timestamp": "2026-08-11T10:43:30.000Z",
                "type": "response_item",
                "payload": {
                    "type": "reasoning",
                    "id": "reasoning-1",
                    "summary": [
                        { "type": "summary_text", "text": "Checking the scheduler" },
                        { "type": "summary_text", "text": "Verifying restore behavior" }
                    ],
                    "content": [
                        { "type": "reasoning_text", "text": "The retained provider detail." }
                    ]
                }
            }),
        ] {
            writeln!(file, "{}", serde_json::to_string(&entry).unwrap()).unwrap();
        }

        let items = hydrate_thread_items_from_session_file(
            file.path().to_str().unwrap(),
            "/Users/james/project-a",
        );

        assert!(matches!(
            items.as_slice(),
            [ConversationItem::Reasoning {
                summary: Some(summary),
                content,
                ..
            }] if summary == "Checking the scheduler\nVerifying restore behavior"
                && content == "The retained provider detail."
        ));
    }

    #[test]
    fn session_file_supplements_partial_thread_read_with_missing_tool_calls() {
        let mut file = NamedTempFile::new().unwrap();
        for entry in [
            json!({
                "timestamp": "2026-08-11T10:43:29.000Z",
                "type": "session_meta",
                "payload": { "cwd": "/Users/james/project-a" }
            }),
            json!({
                "timestamp": "2026-08-11T10:43:31.000Z",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "id": "tool-from-session",
                    "call_id": "call-1",
                    "name": "exec",
                    "status": "completed"
                }
            }),
            json!({
                "timestamp": "2026-08-11T10:43:32.000Z",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call-1",
                    "output": "done"
                }
            }),
        ] {
            writeln!(file, "{}", serde_json::to_string(&entry).unwrap()).unwrap();
        }
        let mut items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [{
                    "status": "completed",
                    "items": [{
                        "id": "reasoning-from-read",
                        "type": "reasoning",
                        "createdAt": "2026-08-11T10:43:30.000Z"
                    }]
                }]
            }
        }));

        supplement_thread_items_with_session_tool_calls(
            &mut items,
            file.path().to_str().unwrap(),
            "/Users/james/project-a",
        );

        assert!(matches!(
            items.as_slice(),
            [
                ConversationItem::Reasoning { id: reasoning_id, .. },
                ConversationItem::ToolCall { id: tool_id, output: Some(output), .. }
            ] if reasoning_id == "reasoning-from-read"
                && tool_id == "tool-from-session"
                && output == "done"
        ));
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
    fn hydrates_codex_input_image_user_messages_without_wrapper_text() {
        let items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [{
                    "id": "turn-1",
                    "startedAt": "2026-08-27T12:28:51Z",
                    "items": [{
                        "id": "item-40",
                        "type": "userMessage",
                        "content": [
                            {"type": "input_text", "text": "Condense the top bar. "},
                            {"type": "input_text", "text": "<image name=[Image #1] path=\"/tmp/shot.png\">"},
                            {"type": "input_image", "imageUrl": "data:image/png;base64,aGVsbG8="},
                            {"type": "input_text", "text": "</image>"}
                        ]
                    }]
                }]
            }
        }));

        match &items[0] {
            ConversationItem::UserMessage {
                text,
                attachments,
                created_at,
                ..
            } => {
                assert_eq!(text, "Condense the top bar.");
                assert_eq!(attachments.len(), 1);
                assert_eq!(attachments[0].url, "data:image/png;base64,aGVsbG8=");
                assert_eq!(created_at.to_rfc3339(), "2026-08-27T12:28:51+00:00");
            }
            other => panic!("expected user message, got {other:?}"),
        }
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
                                    "durationMs": 1250,
                                    "createdAt": "2026-03-16T10:00:01Z"
                                },
                                {
                                    "id": "tool-1",
                                    "type": "commandExecution",
                                    "command": "git status --short",
                                    "status": "completed",
                                    "aggregatedOutput": "ok",
                                    "cwd": "/workspace/falcondeck",
                                    "commandActions": [{
                                        "type": "listFiles",
                                        "command": "git status --short",
                                        "path": "."
                                    }],
                                    "processId": "4242",
                                    "durationMs": 19,
                                    "source": "agent",
                                    "createdAt": "2026-03-16T10:00:02Z",
                                    "completedAt": "2026-03-16T10:00:03Z"
                                },
                                {
                                    "id": "assistant-1",
                                    "type": "agentMessage",
                                    "text": "Here are the recent commits.",
                                    "phase": "final_answer",
                                    "memoryCitation": {
                                        "entries": [{
                                            "path": "docs/PLATFORM.md",
                                            "lineStart": 170,
                                            "lineEnd": 178,
                                            "note": "Defines replay identity."
                                        }],
                                        "threadIds": ["thread-earlier"]
                                    },
                                    "createdAt": "2026-03-16T10:00:04Z"
                                },
                                {
                                    "id": "search-1",
                                    "type": "webSearch",
                                    "query": "React AI chat streaming",
                                    "action": {
                                        "type": "openPage",
                                        "url": "https://example.com/chat"
                                    },
                                    "createdAt": "2026-03-16T10:00:04.500Z"
                                },
                                {
                                    "id": "image-1",
                                    "type": "imageGeneration",
                                    "status": "completed",
                                    "result": "aGVsbG8=",
                                    "revisedPrompt": "A visual summary of the recent commits",
                                    "createdAt": "2026-03-16T10:00:05Z"
                                },
                                {
                                    "id": "patch-1",
                                    "type": "fileChange",
                                    "status": "completed",
                                    "changes": [{
                                        "path": "src/old.rs",
                                        "kind": { "type": "update", "move_path": "src/new.rs" },
                                        "diff": "@@ -1 +1 @@\n-old\n+new"
                                    }],
                                    "createdAt": "2026-03-16T10:00:06Z",
                                    "completedAt": "2026-03-16T10:00:07Z"
                                },
                                {
                                    "id": "mcp-1",
                                    "type": "mcpToolCall",
                                    "server": "notion",
                                    "tool": "search",
                                    "arguments": {"query": "streaming"},
                                    "result": {
                                        "content": [{"type": "text", "text": "Found 3 pages"}],
                                        "structuredContent": {"count": 3}
                                    },
                                    "status": "completed",
                                    "durationMs": 42,
                                    "appContext": {
                                        "connectorId": "notion",
                                        "appName": "Notion",
                                        "actionName": "Search"
                                    },
                                    "createdAt": "2026-03-16T10:00:08Z",
                                    "completedAt": "2026-03-16T10:00:09Z"
                                },
                                {
                                    "id": "dynamic-1",
                                    "type": "dynamicToolCall",
                                    "namespace": "visualize",
                                    "tool": "render",
                                    "arguments": {"prompt": "radar"},
                                    "contentItems": [
                                        {"type": "inputText", "text": "Rendered"},
                                        {"type": "inputImage", "imageUrl": "data:image/png;base64,aGVsbG8="}
                                    ],
                                    "success": true,
                                    "status": "completed",
                                    "durationMs": 84,
                                    "createdAt": "2026-03-16T10:00:10Z",
                                    "completedAt": "2026-03-16T10:00:11Z"
                                },
                                {
                                    "id": "collab-1",
                                    "type": "collabAgentToolCall",
                                    "tool": "spawnAgent",
                                    "status": "completed",
                                    "senderThreadId": "thread-parent",
                                    "receiverThreadIds": ["thread-child"],
                                    "prompt": "Audit accessibility",
                                    "model": "gpt-5.6-terra",
                                    "reasoningEffort": "high",
                                    "agentsStates": {
                                        "thread-child": {"status": "completed", "message": "Audit complete"}
                                    },
                                    "createdAt": "2026-03-16T10:00:12Z",
                                    "completedAt": "2026-03-16T10:00:13Z"
                                },
                                {
                                    "id": "subagent-1",
                                    "type": "subAgentActivity",
                                    "kind": "interacted",
                                    "agentThreadId": "thread-child",
                                    "agentPath": "qa/mobile",
                                    "createdAt": "2026-03-16T10:00:14Z"
                                },
                                {
                                    "id": "plan-1",
                                    "type": "plan",
                                    "text": "Audit the remaining output schema.",
                                    "createdAt": "2026-03-16T10:00:15Z"
                                },
                                {
                                    "id": "hook-1",
                                    "type": "hookPrompt",
                                    "fragments": [
                                        {"text": "Run the accessibility checks.", "hookRunId": "run-1"},
                                        {"text": "Preserve exact failures.", "hookRunId": "run-2"}
                                    ],
                                    "createdAt": "2026-03-16T10:00:16Z"
                                },
                                {
                                    "id": "sleep-1",
                                    "type": "sleep",
                                    "durationMs": 2500,
                                    "createdAt": "2026-03-16T10:00:17Z"
                                }
                            ]
                        }]
                    }
                }]
            }
        }));

        assert_eq!(items.len(), 14);
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
                summary,
                content,
                lifecycle,
                duration_ms,
                ..
            } => {
                assert_eq!(summary.as_deref(), Some("Looking at git state"));
                assert_eq!(content, "Collecting commit history");
                assert_eq!(*lifecycle, ContentLifecycle::Complete);
                assert_eq!(*duration_ms, Some(1250));
            }
            other => panic!("expected reasoning item, got {other:?}"),
        }
        match &items[2] {
            ConversationItem::ToolCall {
                title,
                output,
                display,
                detail,
                ..
            } => {
                assert_eq!(title, "git status --short");
                assert_eq!(output.as_deref(), Some("ok"));
                assert_eq!(display.history_mode, ToolHistoryMode::Summary);
                assert!(matches!(
                    detail.as_deref(),
                    Some(falcondeck_core::ToolCallDetail::CommandExecution {
                        command,
                        cwd,
                        actions,
                        process_id: Some(process_id),
                        duration_ms: Some(19),
                        source: Some(source),
                    }) if command == "git status --short"
                        && cwd == "/workspace/falcondeck"
                        && actions[0].action_kind == "listFiles"
                        && actions[0].path.as_deref() == Some(".")
                        && process_id == "4242"
                        && source == "agent"
                ));
            }
            other => panic!("expected tool item, got {other:?}"),
        }
        assert!(matches!(
            &items[3],
            ConversationItem::AssistantMessage {
                text,
                phase: Some(falcondeck_core::AssistantMessagePhase::FinalAnswer),
                memory_citation: Some(citation),
                lifecycle: ContentLifecycle::Complete,
                ..
            } if text == "Here are the recent commits."
                && citation.entries[0].path == "docs/PLATFORM.md"
                && citation.thread_ids == vec!["thread-earlier"]
        ));
        assert!(matches!(
            &items[4],
            ConversationItem::WebSearch {
                search,
                lifecycle: ContentLifecycle::Complete,
                ..
            } if search.query == "React AI chat streaming"
                && search.url.as_deref() == Some("https://example.com/chat")
        ));
        assert!(matches!(
            &items[5],
            ConversationItem::Image {
                image,
                lifecycle: ContentLifecycle::Complete,
                ..
            } if image.url == "data:image/png;base64,aGVsbG8="
                && image.alt_text.as_deref() == Some("A visual summary of the recent commits")
        ));
        assert!(matches!(
            &items[6],
            ConversationItem::FileChange {
                changes,
                lifecycle: falcondeck_core::ToolLifecycle::Succeeded,
                ..
            } if changes[0].path == "src/old.rs"
                && changes[0].move_path.as_deref() == Some("src/new.rs")
                && changes[0].diff.contains("+new")
        ));
        assert!(matches!(
            &items[7],
            ConversationItem::ToolCall {
                title,
                output: Some(output),
                detail,
                ..
            } if title == "Notion · Search"
                && output == "Found 3 pages"
                && matches!(detail.as_deref(), Some(falcondeck_core::ToolCallDetail::Mcp {
                    server,
                    tool,
                    duration_ms: Some(42),
                    app_context: Some(context),
                    ..
                }) if server == "notion" && tool == "search" && context.connector_id == "notion")
        ));
        assert!(matches!(
            &items[8],
            ConversationItem::ToolCall {
                title,
                output: Some(output),
                detail,
                ..
            } if title == "visualize · render"
                && output == "Rendered"
                && matches!(detail.as_deref(), Some(falcondeck_core::ToolCallDetail::Dynamic {
                    tool,
                    namespace: Some(namespace),
                    content_items,
                    success: Some(true),
                    duration_ms: Some(84),
                    ..
                }) if tool == "render" && namespace == "visualize" && content_items.len() == 2)
        ));
        assert!(matches!(
            &items[9],
            ConversationItem::ToolCall {
                title,
                detail,
                ..
            } if title == "Spawn sub-agent"
                && matches!(detail.as_deref(), Some(falcondeck_core::ToolCallDetail::CollabAgent {
                    tool,
                    receiver_thread_ids,
                    agent_states,
                    ..
                }) if tool == "spawnAgent"
                    && receiver_thread_ids == &vec!["thread-child"]
                    && agent_states["thread-child"].message.as_deref() == Some("Audit complete"))
        ));
        assert!(matches!(
            &items[10],
            ConversationItem::ToolCall {
                title,
                detail,
                ..
            } if title == "Sub-agent interacted"
                && matches!(detail.as_deref(), Some(falcondeck_core::ToolCallDetail::SubagentActivity {
                    activity,
                    agent_thread_id,
                    agent_path,
                }) if activity == "interacted"
                    && agent_thread_id == "thread-child"
                    && agent_path == "qa/mobile")
        ));
        assert!(matches!(
            &items[11],
            ConversationItem::Plan { plan, .. }
                if plan.explanation.as_deref() == Some("Audit the remaining output schema.")
                    && plan.steps.is_empty()
        ));
        assert!(matches!(
            &items[12],
            ConversationItem::Service { message, .. }
                if message == "Run the accessibility checks.\nPreserve exact failures."
        ));
        assert!(matches!(
            &items[13],
            ConversationItem::ToolCall { title, tool_kind, .. }
                if title == "Wait 2.5s" && tool_kind == "sleep"
        ));
    }

    #[test]
    fn hydrates_empty_failed_turn_as_a_visible_terminal_receipt() {
        let items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [{
                    "id": "turn-failed",
                    "status": "failed",
                    "completedAt": "2026-08-09T12:00:02Z",
                    "items": [{
                        "id": "user-failed",
                        "type": "userMessage",
                        "createdAt": "2026-08-09T12:00:00Z",
                        "content": [{"type": "text", "text": "Try this"}]
                    }]
                }]
            }
        }));

        assert_eq!(items.len(), 2);
        assert!(matches!(
            &items[1],
            ConversationItem::AssistantMessage {
                id,
                text,
                lifecycle: ContentLifecycle::Error,
                ..
            } if id == "falcondeck-turn-receipt-turn-failed" && text.is_empty()
        ));
    }

    #[test]
    fn hydrates_context_compaction_as_a_first_class_receipt() {
        let items = hydrate_thread_items(&json!({
            "result": {
                "thread": {
                    "turns": [{
                        "status": "completed",
                        "items": [{
                            "id": "compact-1",
                            "type": "contextCompaction",
                            "status": "completed",
                            "createdAt": "2026-08-09T10:00:00Z",
                            "completedAt": "2026-08-09T10:00:02Z"
                        }]
                    }]
                }
            }
        }));

        assert!(matches!(
            items.as_slice(),
            [ConversationItem::ContextCompaction {
                id,
                lifecycle: falcondeck_core::ToolLifecycle::Succeeded,
                completed_at: Some(_),
                ..
            }] if id == "compact-1"
        ));
    }

    #[test]
    fn hydrates_provider_artifacts_as_typed_receipts() {
        let items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [{
                    "status": "completed",
                    "items": [{
                        "id": "future-1",
                        "type": "artifactPreview",
                        "status": "completed",
                        "createdAt": "2026-08-09T10:00:00Z",
                        "artifact": { "title": "Prototype", "url": "asset://prototype" }
                    }]
                }]
            }
        }));

        assert!(matches!(
            items.as_slice(),
            [ConversationItem::Artifact {
                id,
                artifact,
                lifecycle: ContentLifecycle::Complete,
                ..
            }] if id == "future-1"
                && artifact.title == "Prototype"
                && artifact.url.as_deref() == Some("asset://prototype")
                && artifact.payload.pointer("/title") == Some(&json!("Prototype"))
        ));
    }

    #[test]
    fn preserves_review_mode_output_during_hydration() {
        let items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [{
                    "status": "completed",
                    "items": [
                        {
                            "id": "review-1",
                            "type": "enteredReviewMode",
                            "review": "current changes",
                            "createdAt": "2026-08-09T10:00:00Z"
                        },
                        {
                            "id": "review-1",
                            "type": "exitedReviewMode",
                            "review": "## Findings\n\n- One high-priority finding.",
                            "createdAt": "2026-08-09T10:00:03Z"
                        }
                    ]
                }]
            }
        }));

        assert!(matches!(
            items.as_slice(),
            [ConversationItem::CodeReview {
                subject: Some(subject),
                content,
                lifecycle: ContentLifecycle::Complete,
                created_at,
                ..
            }] if subject == "current changes"
                && content == "## Findings\n\n- One high-priority finding."
                && created_at.to_rfc3339() == "2026-08-09T10:00:00+00:00"
        ));
    }

    #[test]
    fn restores_partial_content_lifecycle_from_the_provider_turn() {
        let items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [{
                    "id": "turn-stopped",
                    "status": "canceled",
                    "completedAt": "2026-08-09T12:00:02Z",
                    "items": [
                        {
                            "id": "user-stopped",
                            "type": "userMessage",
                            "createdAt": "2026-08-09T12:00:00Z",
                            "content": [{"type": "text", "text": "Start this"}]
                        },
                        {
                            "id": "assistant-stopped",
                            "type": "agentMessage",
                            "createdAt": "2026-08-09T12:00:01Z",
                            "text": "Partial answer"
                        }
                    ]
                }]
            }
        }));

        assert!(matches!(
            items.as_slice(),
            [
                ConversationItem::UserMessage { .. },
                ConversationItem::AssistantMessage {
                    text,
                    lifecycle: ContentLifecycle::Complete,
                    ..
                },
                ConversationItem::AssistantMessage {
                    text: receipt,
                    lifecycle: ContentLifecycle::Interrupted,
                    ..
                }
            ] if text == "Partial answer" && receipt.is_empty()
        ));
    }

    #[test]
    fn interrupted_turn_hydrates_commentary_as_complete_and_one_terminal_receipt() {
        let items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [{
                    "id": "turn-stopped",
                    "status": "canceled",
                    "completedAt": "2026-08-09T12:00:02Z",
                    "items": [
                        {
                            "id": "user-stopped",
                            "type": "userMessage",
                            "createdAt": "2026-08-09T12:00:00Z",
                            "content": [{"type": "text", "text": "Start this"}]
                        },
                        {
                            "id": "commentary-stopped",
                            "type": "agentMessage",
                            "phase": "commentary",
                            "createdAt": "2026-08-09T12:00:01Z",
                            "text": "Still working"
                        }
                    ]
                }]
            }
        }));

        assert!(matches!(
            items.as_slice(),
            [
                ConversationItem::UserMessage { .. },
                ConversationItem::AssistantMessage {
                    phase: Some(falcondeck_core::AssistantMessagePhase::Commentary),
                    lifecycle: ContentLifecycle::Complete,
                    ..
                },
                ConversationItem::AssistantMessage {
                    phase: None,
                    lifecycle: ContentLifecycle::Interrupted,
                    ..
                }
            ]
        ));
    }

    #[test]
    fn interrupted_turn_hydrates_many_thoughts_with_one_interrupt_marker() {
        let items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [{
                    "id": "turn-stopped",
                    "status": "canceled",
                    "completedAt": "2026-08-09T12:00:04Z",
                    "items": [
                        {
                            "id": "user-stopped",
                            "type": "userMessage",
                            "createdAt": "2026-08-09T12:00:00Z",
                            "content": [{"type": "text", "text": "Start this"}]
                        },
                        {
                            "id": "reasoning-1",
                            "type": "reasoning",
                            "createdAt": "2026-08-09T12:00:01Z",
                            "summary": ["First thought"]
                        },
                        {
                            "id": "progress-without-phase",
                            "type": "agentMessage",
                            "createdAt": "2026-08-09T12:00:02Z",
                            "text": "Now checking the next step"
                        },
                        {
                            "id": "reasoning-2",
                            "type": "reasoning",
                            "createdAt": "2026-08-09T12:00:03Z",
                            "summary": ["Second thought"]
                        }
                    ]
                }]
            }
        }));

        assert_eq!(
            items
                .iter()
                .filter(|item| matches!(
                    item,
                    ConversationItem::AssistantMessage {
                        lifecycle: ContentLifecycle::Interrupted,
                        ..
                    }
                ))
                .count(),
            1
        );
        assert!(
            items
                .iter()
                .filter(|item| match item {
                    ConversationItem::Reasoning { .. } => true,
                    ConversationItem::AssistantMessage { text, .. } => !text.is_empty(),
                    _ => false,
                })
                .all(|item| matches!(
                    item,
                    ConversationItem::Reasoning {
                        lifecycle: ContentLifecycle::Complete,
                        ..
                    } | ConversationItem::AssistantMessage {
                        lifecycle: ContentLifecycle::Complete,
                        ..
                    }
                ))
        );
    }

    #[test]
    fn does_not_invent_a_receipt_for_an_empty_successful_turn() {
        let items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [{
                    "id": "turn-complete",
                    "status": "completed",
                    "items": [{
                        "id": "user-complete",
                        "type": "userMessage",
                        "createdAt": "2026-08-09T12:00:00Z",
                        "content": [{"type": "text", "text": "Do nothing"}]
                    }]
                }]
            }
        }));

        assert_eq!(items.len(), 1);
        assert!(matches!(items[0], ConversationItem::UserMessage { .. }));
    }

    #[test]
    fn hydrates_user_messages_with_safe_edit_fork_boundaries() {
        let items = hydrate_thread_items(&json!({
            "thread": {
                "turns": [
                    {
                        "id": "turn-1",
                        "items": [{
                            "id": "user-1",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "First"}]
                        }, {
                            "id": "user-steer",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "Steer"}]
                        }]
                    },
                    {
                        "id": "turn-2",
                        "items": [{
                            "id": "user-2",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "Second"}]
                        }]
                    }
                ]
            }
        }));

        assert!(matches!(
            &items[0],
            ConversationItem::UserMessage {
                turn_id: Some(turn_id),
                previous_turn_id: None,
                ..
            } if turn_id == "turn-1"
        ));
        assert!(matches!(
            &items[1],
            ConversationItem::UserMessage { turn_id: None, .. }
        ));
        assert!(matches!(
            &items[2],
            ConversationItem::UserMessage {
                turn_id: Some(turn_id),
                previous_turn_id: Some(previous_turn_id),
                ..
            } if turn_id == "turn-2" && previous_turn_id == "turn-1"
        ));
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
                provider: AgentProvider::CODEX,
                native_session_id: None,
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
            },
            &thread_read,
            &[
                ConversationItem::Reasoning {
                    id: "reasoning-1".to_string(),
                    summary: Some("Thinking".to_string()),
                    content: "Working".to_string(),
                    lifecycle: ContentLifecycle::Complete,
                    duration_ms: None,
                    created_at: Utc::now(),
                },
                ConversationItem::ToolCall {
                    id: "tool-1".to_string(),
                    title: "git status --short".to_string(),
                    tool_kind: "commandExecution".to_string(),
                    status: "completed".to_string(),
                    output: Some("done".to_string()),
                    exit_code: Some(0),
                    display: Box::new(tool_display_metadata(
                        "git status --short",
                        "commandExecution",
                        "completed",
                        Some(0),
                        Some("done"),
                    )),
                    detail: None,
                    created_at: Utc::now(),
                    completed_at: Some(Utc::now()),
                },
                ConversationItem::AssistantMessage {
                    id: "assistant-1".to_string(),
                    text: "Here are the recent changes in this project.".to_string(),
                    phase: None,
                    memory_citation: None,
                    citations: Vec::new(),
                    lifecycle: ContentLifecycle::Complete,
                    error: None,
                    created_at: Utc::now(),
                },
            ],
        );

        assert_eq!(summary.status, ThreadStatus::Idle);
        assert_eq!(summary.latest_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(summary.last_tool.as_deref(), Some("git status --short"));
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
                provider: AgentProvider::CODEX,
                native_session_id: None,
                provider_transport: None,
                handoff_from: None,
                origin: None,
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
                is_pinned: false,
                is_pinned_in_project: false,
                goal: None,
                queued_turns: Vec::new(),
                variant: None,
            },
            &json!({ "thread": { "turns": [{ "id": "turn-1", "status": "completed" }] } }),
            &[ConversationItem::AssistantMessage {
                id: "assistant-1".to_string(),
                text: "Fresh message".to_string(),
                phase: None,
                memory_citation: None,
                citations: Vec::new(),
                lifecycle: ContentLifecycle::Complete,
                error: None,
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
                provider: AgentProvider::CODEX,
                native_session_id: None,
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
