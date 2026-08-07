use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, Write as _},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use falcondeck_core::{
    AccountStatus, AccountSummary, AgentCapabilitySummary, AgentProvider, CollaborationModeSummary,
    ConversationItem, ImageInput, ModelSummary, ReasoningEffortSummary, ThreadAgentParams,
    ThreadAttention, ThreadStatus, ThreadSummary,
};
use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::Mutex,
};
use uuid::Uuid;

use crate::agent_binary::preferred_command_path;
use crate::agent_binary::{missing_binary_message, resolve_agent_binary};
use crate::app::agent_helpers::claude_image_reference;
use crate::app::agent_helpers::{
    append_claude_text_delta, extract_claude_assistant_message_id, extract_claude_text_chunk,
    extract_claude_tool_event, extract_claude_user_message_text, merge_claude_assistant_text,
};
use crate::app::conversation_helpers::tool_display_metadata;
use crate::error::DaemonError;

pub struct ClaudeBootstrap {
    pub runtime: Arc<ClaudeRuntime>,
    pub account: AccountSummary,
    pub models: Vec<ModelSummary>,
    pub collaboration_modes: Vec<CollaborationModeSummary>,
    pub capabilities: AgentCapabilitySummary,
    pub threads: Vec<HydratedClaudeThread>,
}

pub struct ClaudeProviderMetadata {
    pub account: AccountSummary,
    pub models: Vec<ModelSummary>,
    pub collaboration_modes: Vec<CollaborationModeSummary>,
    pub capabilities: AgentCapabilitySummary,
}

pub struct HydratedClaudeThread {
    pub summary: ThreadSummary,
    pub items: Vec<ConversationItem>,
}

pub struct ClaudeTurnSpawn {
    pub session_id: String,
    /// Identifies this specific turn process; `finish_turn` uses it so a
    /// stale monitor task can never reap a newer turn on the same thread.
    pub generation: u64,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

pub struct ClaudeTurnFinish {
    pub status: Option<std::process::ExitStatus>,
    pub interrupted: bool,
    /// True when this turn was already superseded or reaped elsewhere; the
    /// caller must not finalize thread state based on it.
    pub stale: bool,
}

/// The live stdin of a turn's CLI process. `--input-format stream-json` keeps
/// reading for the whole life of the turn, so the handle stays open and every
/// steering message is appended as another line. Closing it delivers EOF,
/// which is what makes the CLI exit — see [`ClaudeRuntime::complete_turn`].
struct TurnInput {
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
}

impl TurnInput {
    fn new(stdin: Option<tokio::process::ChildStdin>) -> Self {
        Self {
            stdin: Mutex::new(stdin),
        }
    }

    async fn write_line(&self, line: &str) -> Result<(), DaemonError> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or_else(|| {
            DaemonError::BadRequest("claude turn is no longer accepting input".to_string())
        })?;
        let write = async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        };
        // A CLI that stopped reading stdin would otherwise block this write
        // forever once the pipe buffer fills, wedging the caller's request.
        match tokio::time::timeout(WRITE_TIMEOUT, write).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(DaemonError::Process(format!(
                "failed to write to claude turn: {error}"
            ))),
            Err(_) => Err(DaemonError::Process(
                "timed out writing to claude turn".to_string(),
            )),
        }
    }

    /// Drops the handle so the CLI reads EOF and exits. Idempotent.
    async fn close(&self) {
        self.stdin.lock().await.take();
    }
}

struct ActiveTurn {
    generation: u64,
    child: Child,
    input: Arc<TurnInput>,
}

/// How long to wait for the CLI to exit cleanly after SIGTERM before
/// escalating to SIGKILL. Claude Code runs SessionEnd hooks and flushes
/// session state on SIGTERM; SIGKILL risks losing that state.
const INTERRUPT_GRACE: tokio::time::Duration = tokio::time::Duration::from_secs(5);

/// How long to wait for the CLI to exit on its own after its stdin is closed
/// at turn end, before falling back to SIGTERM and then SIGKILL.
const EXIT_GRACE: tokio::time::Duration = tokio::time::Duration::from_secs(10);

/// Upper bound on a single stdin write (the initial prompt or a steering
/// message) before the turn is treated as unable to accept input.
const WRITE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(10);

pub struct ClaudeRuntime {
    workspace_path: String,
    claude_bin: String,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    interrupted_turns: Mutex<HashSet<String>>,
    /// Per-thread locks serializing the whole remove-kill-spawn-insert
    /// sequence in `spawn_turn`, so two concurrent spawns can never run two
    /// CLI processes against one session.
    turn_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    next_turn_generation: std::sync::atomic::AtomicU64,
}

impl ClaudeRuntime {
    pub async fn connect(
        workspace_path: String,
        claude_bin: String,
    ) -> Result<ClaudeBootstrap, DaemonError> {
        let resolved = resolve_agent_binary("claude", &claude_bin);
        let runtime = Arc::new(Self {
            workspace_path: workspace_path.clone(),
            claude_bin: resolved.executable.clone(),
            active_turns: Mutex::new(HashMap::new()),
            interrupted_turns: Mutex::new(HashSet::new()),
            turn_locks: Mutex::new(HashMap::new()),
            next_turn_generation: std::sync::atomic::AtomicU64::new(1),
        });

        let account = read_auth_status(&resolved.executable).await;
        let models = curated_models();
        let collaboration_modes = Vec::new();
        let capabilities = default_capabilities();
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

    async fn turn_lock(&self, thread_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.turn_locks
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_default()
            .clone()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_turn(
        &self,
        thread_id: &str,
        session_id: Option<&str>,
        prompt: &str,
        images: &[ImageInput],
        model_id: Option<&str>,
        effort: Option<&str>,
        permission_mode: Option<&str>,
        daemon_base_url: Option<&str>,
        settings_dir: &Path,
    ) -> Result<ClaudeTurnSpawn, DaemonError> {
        // Serialize the whole remove-kill-spawn-insert sequence per thread so
        // concurrent spawns cannot run two CLI processes on one session.
        let turn_lock = self.turn_lock(thread_id).await;
        let _turn_guard = turn_lock.lock().await;

        let next_session_id = session_id
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        // Clear any interrupt aimed at earlier turns; interrupts arriving from
        // here on target this spawn and are re-checked after insertion below.
        self.interrupted_turns.lock().await.remove(thread_id);
        // A thread maps to one Claude session; two concurrent CLI processes
        // resuming the same session corrupt its transcript. Stop any previous
        // turn for this thread before spawning a replacement.
        let previous = self.active_turns.lock().await.remove(thread_id);
        if let Some(mut turn) = previous {
            turn.input.close().await;
            let _ = request_graceful_stop(&mut turn.child);
            if tokio::time::timeout(INTERRUPT_GRACE, turn.child.wait())
                .await
                .is_err()
            {
                let _ = turn.child.start_kill();
                let _ = turn.child.wait().await;
            }
        }

        let input_line = build_claude_stream_json_input(prompt, images).await;
        let resolved = resolve_agent_binary("claude", &self.claude_bin);
        let mut command = Command::new(&resolved.executable);
        command
            .arg("-p")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--include-hook-events")
            .arg("--verbose")
            .current_dir(PathBuf::from(&self.workspace_path))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(path) = preferred_command_path(&resolved.executable) {
            command.env("PATH", path);
        }

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
        if let Some(permission_mode) = permission_mode
            .map(str::trim)
            .filter(|mode| !mode.is_empty() && !mode.eq_ignore_ascii_case("default"))
        {
            command.arg("--permission-mode").arg(permission_mode);
        }
        // Claude runs PreToolUse hooks regardless of permission mode, so the
        // approval-broker hook must not be installed when the user chose
        // bypassPermissions — otherwise "bypass" still prompts for every tool
        // call, just from FalconDeck instead of Claude.
        let bypassing_permissions = permission_mode
            .is_some_and(|mode| mode.trim().eq_ignore_ascii_case("bypasspermissions"));
        if let Some(settings_path) = daemon_base_url
            .filter(|_| claude_approvals_enabled() && !bypassing_permissions)
            .and_then(|base_url| self.write_hook_settings_file(base_url, settings_dir))
        {
            command.arg("--settings").arg(settings_path);
        }
        if let Some(mcp_config_path) = self.write_mcp_config_file(settings_dir) {
            command.arg("--mcp-config").arg(mcp_config_path);
        }

        let mut child = command
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    let message = missing_binary_message(
                        "Claude Code",
                        "claude",
                        &resolved.diagnostics,
                        "Install Claude Code in a standard location or relaunch FalconDeck after your shell PATH is set up.",
                    );
                    return DaemonError::Process(message);
                }
                DaemonError::Process(format!("failed to start claude: {error}"))
            })?;
        // The handle stays open for the whole turn so steering messages can be
        // appended; it is closed at the terminal `result` event (or when the
        // turn is torn down), which is what lets the CLI exit.
        let input = Arc::new(TurnInput::new(child.stdin.take()));
        {
            // Write off-task so a CLI that never reads stdin cannot wedge
            // spawn_turn.
            let input = Arc::clone(&input);
            tokio::spawn(async move {
                let _ = input.write_line(&input_line).await;
            });
        }
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let generation = self
            .next_turn_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.active_turns.lock().await.insert(
            thread_id.to_string(),
            ActiveTurn {
                generation,
                child,
                input,
            },
        );

        // An interrupt that raced this spawn found no active entry and left
        // its flag behind; the user's stop wins, so signal the fresh child
        // right away (the flag stays set so `finish_turn` reports a clean
        // interrupt instead of an error exit).
        if self.interrupted_turns.lock().await.contains(thread_id) {
            let mut active = self.active_turns.lock().await;
            if let Some(turn) = active.get_mut(thread_id) {
                let _ = request_graceful_stop(&mut turn.child);
            }
        }

        Ok(ClaudeTurnSpawn {
            session_id: next_session_id,
            generation,
            stdout,
            stderr,
        })
    }

    /// Injects another user message into the turn already running on this
    /// thread. Fails when no turn is active so the caller can fall back to
    /// queueing rather than silently dropping the message.
    pub async fn steer_turn(
        &self,
        thread_id: &str,
        prompt: &str,
        images: &[ImageInput],
    ) -> Result<(), DaemonError> {
        // Clone the handle out from under the map lock: the write must not
        // hold `active_turns`, or a wedged pipe would also block interrupts
        // and spawns on every other thread.
        let input = {
            let active = self.active_turns.lock().await;
            active
                .get(thread_id)
                .map(|turn| Arc::clone(&turn.input))
                .ok_or_else(|| {
                    DaemonError::BadRequest("no active claude turn to steer".to_string())
                })?
        };
        let line = build_claude_stream_json_input(prompt, images).await;
        input.write_line(&line).await
    }

    /// Ends a turn that reported its terminal `result` event. Closes stdin so
    /// the CLI exits, and reaps the process off-task so a slow shutdown cannot
    /// stall the thread's return to idle.
    pub async fn complete_turn(&self, thread_id: &str, generation: u64) -> ClaudeTurnFinish {
        let turn = {
            let mut active = self.active_turns.lock().await;
            match active.get(thread_id) {
                Some(turn) if turn.generation == generation => active.remove(thread_id),
                // Missing or newer entry: this turn was superseded (or the
                // runtime shut down); the caller must not touch thread state.
                _ => {
                    return ClaudeTurnFinish {
                        status: None,
                        interrupted: false,
                        stale: true,
                    };
                }
            }
        };
        let interrupted = self.interrupted_turns.lock().await.remove(thread_id);
        if let Some(mut turn) = turn {
            // Closed before the reaper is spawned so a steer racing this
            // completion fails fast instead of writing into a dying process.
            turn.input.close().await;
            tokio::spawn(async move {
                if tokio::time::timeout(EXIT_GRACE, turn.child.wait())
                    .await
                    .is_ok()
                {
                    return;
                }
                tracing::warn!("claude turn did not exit after stdin close; terminating");
                let _ = request_graceful_stop(&mut turn.child);
                if tokio::time::timeout(INTERRUPT_GRACE, turn.child.wait())
                    .await
                    .is_err()
                {
                    let _ = turn.child.start_kill();
                    let _ = turn.child.wait().await;
                }
            });
        }
        ClaudeTurnFinish {
            status: None,
            interrupted,
            stale: false,
        }
    }

    pub async fn interrupt_turn(&self, thread_id: &str) -> Result<(), DaemonError> {
        let signalled = {
            let mut active = self.active_turns.lock().await;
            match active.get_mut(thread_id) {
                Some(turn) => {
                    // Flag before signalling, while still holding the
                    // active-turns lock: `finish_turn` must never observe the
                    // SIGTERM exit ahead of the interrupted flag.
                    self.interrupted_turns
                        .lock()
                        .await
                        .insert(thread_id.to_string());
                    match request_graceful_stop(&mut turn.child) {
                        Ok(signalled) => signalled,
                        Err(error) => {
                            // Nothing was signalled; do not misreport the
                            // turn's eventual natural exit as an interrupt.
                            self.interrupted_turns.lock().await.remove(thread_id);
                            return Err(DaemonError::Process(format!(
                                "failed to interrupt claude turn: {error}"
                            )));
                        }
                    }
                }
                None => {
                    // No active entry can also mean a spawn is mid-replace
                    // (the entry is removed for the duration). Record the stop
                    // anyway: the spawn re-checks this flag after inserting
                    // the new child and stops it immediately.
                    self.interrupted_turns
                        .lock()
                        .await
                        .insert(thread_id.to_string());
                    return Ok(());
                }
            }
        };

        if signalled {
            // SIGTERM lets the CLI abort the turn, run SessionEnd hooks, and
            // flush session state. Escalate only if it does not exit in time.
            let deadline = tokio::time::Instant::now() + INTERRUPT_GRACE;
            loop {
                {
                    let mut active = self.active_turns.lock().await;
                    match active.get_mut(thread_id) {
                        Some(turn) => {
                            if turn.child.try_wait().ok().flatten().is_some() {
                                return Ok(());
                            }
                        }
                        None => return Ok(()),
                    }
                }
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
        }

        let mut active = self.active_turns.lock().await;
        if let Some(turn) = active.get_mut(thread_id) {
            turn.child.start_kill().map_err(|error| {
                DaemonError::Process(format!("failed to interrupt claude turn: {error}"))
            })?;
        }
        Ok(())
    }

    pub async fn finish_turn(
        &self,
        thread_id: &str,
        generation: u64,
    ) -> Result<ClaudeTurnFinish, DaemonError> {
        let turn = {
            let mut active = self.active_turns.lock().await;
            match active.get(thread_id) {
                Some(turn) if turn.generation == generation => active.remove(thread_id),
                // Missing or newer entry: this turn was superseded (or the
                // runtime shut down); the caller must not touch thread state.
                _ => {
                    return Ok(ClaudeTurnFinish {
                        status: None,
                        interrupted: false,
                        stale: true,
                    });
                }
            }
        };
        let interrupted = self.interrupted_turns.lock().await.remove(thread_id);
        if let Some(mut turn) = turn {
            // Reached when the stream ended without a terminal `result` event
            // (a crashed or signalled CLI). Stdin is still open, so close it
            // before waiting or a process that merely closed stdout would hang
            // this wait forever and strand the thread as Running.
            turn.input.close().await;
            let status = match tokio::time::timeout(EXIT_GRACE, turn.child.wait()).await {
                Ok(status) => status.map_err(|error| {
                    DaemonError::Process(format!("failed to wait for claude turn: {error}"))
                })?,
                Err(_) => {
                    let _ = turn.child.start_kill();
                    turn.child.wait().await.map_err(|error| {
                        DaemonError::Process(format!("failed to wait for claude turn: {error}"))
                    })?
                }
            };
            return Ok(ClaudeTurnFinish {
                status: Some(status),
                interrupted,
                stale: false,
            });
        }
        Ok(ClaudeTurnFinish {
            status: None,
            interrupted,
            stale: false,
        })
    }

    pub async fn shutdown(&self) -> Result<(), DaemonError> {
        let mut active = self.active_turns.lock().await;
        for turn in active.values_mut() {
            // EOF and SIGTERM together: the CLI now outlives its stdout, so
            // the signal alone is what stops a turn mid-flight, and the close
            // stops it waiting on stdin if it is between turns.
            turn.input.close().await;
            let _ = request_graceful_stop(&mut turn.child);
        }
        // Give the CLI a moment to flush session state before hard-killing.
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        for turn in active.values_mut() {
            if turn.child.try_wait().ok().flatten().is_none() {
                let _ = turn.child.start_kill();
            }
        }
        active.clear();
        Ok(())
    }

    pub async fn provider_metadata(&self) -> ClaudeProviderMetadata {
        ClaudeProviderMetadata {
            account: read_auth_status(&self.claude_bin).await,
            models: curated_models(),
            collaboration_modes: Vec::new(),
            capabilities: default_capabilities(),
        }
    }

    /// Materialize a `--settings` file wiring the PreToolUse hook to the
    /// daemon's approval endpoint. The file lives in the daemon's private
    /// state directory (mode 0700, file 0600) under a stable per-workspace
    /// name, so repeated turns rewrite the same file — it persists across
    /// turns and daemon restarts, and no other local user can pre-create or
    /// tamper with it the way a shared temp dir would allow.
    fn write_hook_settings_file(&self, base_url: &str, settings_dir: &Path) -> Option<PathBuf> {
        if !curl_available() {
            // Without curl the hook command could never reach the daemon.
            // Skip the settings file entirely (documented fail-open for this
            // case: a deny-all hook would break every tool call), and let the
            // caller surface the one-time service warning.
            static CURL_MISSING_LOGGED: OnceLock<()> = OnceLock::new();
            if CURL_MISSING_LOGGED.set(()).is_ok() {
                tracing::warn!("Claude approvals disabled: curl not found");
            }
            return None;
        }
        if let Err(error) = fs::create_dir_all(settings_dir) {
            tracing::warn!("failed to create claude hook settings dir: {error}");
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(error) = fs::set_permissions(settings_dir, fs::Permissions::from_mode(0o700))
            {
                tracing::warn!("failed to restrict claude hook settings dir: {error}");
                return None;
            }
        }
        let path = settings_dir.join(format!(
            "claude-hooks-{:016x}.json",
            stable_workspace_hash(&self.workspace_path)
        ));
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let written = options
            .open(&path)
            .and_then(|mut file| file.write_all(build_claude_hook_settings(base_url).as_bytes()));
        match written {
            Ok(()) => Some(path),
            Err(error) => {
                tracing::warn!("failed to write claude hook settings file: {error}");
                None
            }
        }
    }

    /// Materialize a `--mcp-config` file from the merged connector config.
    /// Same private-dir/0600 handling as the hook settings file — connector
    /// env blocks routinely hold API keys.
    fn write_mcp_config_file(&self, settings_dir: &Path) -> Option<PathBuf> {
        let servers = crate::connectors::load_mcp_servers(&self.workspace_path, "claude");
        let body = crate::connectors::claude_mcp_config_json(&servers)?;
        if let Err(error) = fs::create_dir_all(settings_dir) {
            tracing::warn!("failed to create claude mcp config dir: {error}");
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(error) = fs::set_permissions(settings_dir, fs::Permissions::from_mode(0o700))
            {
                tracing::warn!("failed to restrict claude mcp config dir: {error}");
                return None;
            }
        }
        let path = settings_dir.join(format!(
            "claude-mcp-{:016x}.json",
            stable_workspace_hash(&self.workspace_path)
        ));
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let written = options
            .open(&path)
            .and_then(|mut file| file.write_all(body.as_bytes()));
        match written {
            Ok(()) => Some(path),
            Err(error) => {
                tracing::warn!("failed to write claude mcp config file: {error}");
                None
            }
        }
    }
}

pub(crate) fn claude_approvals_enabled() -> bool {
    env::var("FALCONDECK_DISABLE_CLAUDE_APPROVALS").as_deref() != Ok("1")
}

/// Whether `curl` (the transport for the PreToolUse hook command) is on PATH.
/// Probed once per process; the result cannot change without a restart in any
/// scenario worth optimizing for.
pub(crate) fn curl_available() -> bool {
    static CURL_AVAILABLE: OnceLock<bool> = OnceLock::new();
    *CURL_AVAILABLE.get_or_init(|| {
        std::process::Command::new("curl")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    })
}

fn build_claude_hook_settings(base_url: &str) -> String {
    // Fail closed: if curl cannot reach the daemon (crash, timeout, refused
    // connection) the `||` fallback prints an explicit deny decision instead
    // of letting Claude Code treat the silent failure as "no opinion".
    // curl's 570s ceiling sits between the daemon's 540s approval timeout and
    // Claude's 600s hook timeout, so the daemon always answers first.
    let deny_decision = json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "FalconDeck approval unavailable"
        }
    })
    .to_string();
    json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": "*",
                "hooks": [{
                    "type": "command",
                    "command": format!(
                        "curl -sS --max-time 570 -X POST -H 'Content-Type: application/json' --data-binary @- {base_url}/api/claude/hooks/pre-tool-use || printf '%s' '{deny_decision}'"
                    ),
                    "timeout": 600
                }]
            }]
        }
    })
    .to_string()
}

fn stable_workspace_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Largest raw image file embedded inline as base64 (3.5 MiB); anything
/// bigger degrades to a text reference so a single stream-json line stays a
/// sane size even after the ~4/3 base64 expansion.
const MAX_EMBEDDED_IMAGE_BYTES: u64 = 3 * 1024 * 1024 + 512 * 1024;

/// Aggregate base64-encoded budget across all images in one turn; images past
/// the budget degrade to text references instead of ballooning the input line.
const MAX_TOTAL_ENCODED_IMAGE_BYTES: usize = 10 * 1024 * 1024;

pub async fn build_claude_stream_json_input(prompt: &str, images: &[ImageInput]) -> String {
    build_claude_stream_json_input_with_budget(prompt, images, MAX_TOTAL_ENCODED_IMAGE_BYTES).await
}

async fn build_claude_stream_json_input_with_budget(
    prompt: &str,
    images: &[ImageInput],
    max_total_encoded_bytes: usize,
) -> String {
    let mut content = Vec::new();
    if !prompt.trim().is_empty() {
        content.push(json!({ "type": "text", "text": prompt }));
    }
    let mut encoded_budget = max_total_encoded_bytes;
    for image in images {
        content.push(claude_image_content_block(image, &mut encoded_budget).await);
    }
    if content.is_empty() {
        // The API rejects empty text blocks, so an empty or whitespace-only
        // prompt with no embeddable images gets an explicit placeholder.
        content.push(json!({ "type": "text", "text": "[empty prompt]" }));
    }
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": content
        }
    })
    .to_string()
}

async fn claude_image_content_block(image: &ImageInput, encoded_budget: &mut usize) -> Value {
    let fallback = || json!({ "type": "text", "text": claude_image_reference(image) });
    let Some(local_path) = image
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return fallback();
    };
    let Some(media_type) = image_media_type_from_extension(local_path) else {
        return fallback();
    };
    // File IO and base64 encoding are blocking work; keep them off the async
    // runtime threads.
    let path = local_path.to_string();
    let encoded = tokio::task::spawn_blocking(move || -> Option<String> {
        // Metadata check is a fast path; the read result is what gets
        // enforced, so a file growing between the two cannot bypass the cap.
        let metadata_within_limit = fs::metadata(&path)
            .map(|metadata| metadata.len() <= MAX_EMBEDDED_IMAGE_BYTES)
            .unwrap_or(false);
        if !metadata_within_limit {
            return None;
        }
        let bytes = fs::read(&path).ok()?;
        if bytes.len() as u64 > MAX_EMBEDDED_IMAGE_BYTES {
            return None;
        }
        Some(BASE64.encode(bytes))
    })
    .await
    .ok()
    .flatten();
    let Some(encoded) = encoded else {
        return fallback();
    };
    if encoded.len() > *encoded_budget {
        return fallback();
    }
    *encoded_budget -= encoded.len();
    json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": encoded
        }
    })
}

fn image_media_type_from_extension(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Ask a running `claude` process to stop gracefully. Returns `Ok(true)` when
/// a termination signal was delivered (unix), `Ok(false)` when the caller
/// should fall back to a hard kill immediately (non-unix or no pid).
fn request_graceful_stop(child: &mut Child) -> std::io::Result<bool> {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            if result == 0 {
                return Ok(true);
            }
            // The process may already have exited; treat ESRCH as success.
            let errno = std::io::Error::last_os_error();
            if errno.raw_os_error() == Some(libc::ESRCH) {
                return Ok(true);
            }
            return Err(errno);
        }
        Ok(true)
    }
    #[cfg(not(unix))]
    {
        child.start_kill()?;
        Ok(false)
    }
}

fn default_capabilities() -> AgentCapabilitySummary {
    AgentCapabilitySummary::claude()
}

pub fn curated_models() -> Vec<ModelSummary> {
    vec![
        ModelSummary {
            id: "haiku".to_string(),
            label: "Haiku 4.5".to_string(),
            is_default: false,
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
                ReasoningEffortSummary {
                    reasoning_effort: "xhigh".to_string(),
                    description: "Extended reasoning".to_string(),
                },
            ],
        },
        ModelSummary {
            id: "sonnet".to_string(),
            label: "Sonnet 5".to_string(),
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
                ReasoningEffortSummary {
                    reasoning_effort: "xhigh".to_string(),
                    description: "Extended reasoning".to_string(),
                },
            ],
        },
        ModelSummary {
            id: "opus".to_string(),
            label: "Opus 5".to_string(),
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
                    reasoning_effort: "xhigh".to_string(),
                    description: "Extended reasoning".to_string(),
                },
                ReasoningEffortSummary {
                    reasoning_effort: "max".to_string(),
                    description: "Maximum effort".to_string(),
                },
            ],
        },
        ModelSummary {
            id: "fable".to_string(),
            label: "Fable 5".to_string(),
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
                    reasoning_effort: "xhigh".to_string(),
                    description: "Extended reasoning".to_string(),
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
    // `claude auth status` can hang on network checks; never let it block
    // workspace connect or the periodic metadata refresh.
    let mut command = Command::new(claude_bin);
    command
        .arg("auth")
        .arg("status")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(path) = preferred_command_path(claude_bin) {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(tokio::time::Duration::from_secs(10), command.output()).await;
    let output = match output {
        Ok(output) => output,
        Err(_) => {
            return AccountSummary {
                status: AccountStatus::Unknown,
                label: "Claude auth status check timed out".to_string(),
            };
        }
    };
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
    let workspace_root = root.join(claude_project_dir_name(workspace_path));
    if workspace_root.is_dir() {
        collect_workspace_session_files(&workspace_root, &mut files);
    } else {
        collect_session_files(&root, &mut files);
    }

    let mut threads_by_session = HashMap::new();
    for thread in files
        .into_iter()
        .filter_map(|path| hydrate_thread_from_file(&path, workspace_path))
    {
        threads_by_session
            .entry(thread.summary.id.clone())
            .and_modify(|existing: &mut HydratedClaudeThread| {
                if thread.summary.updated_at > existing.summary.updated_at {
                    *existing = HydratedClaudeThread {
                        summary: thread.summary.clone(),
                        items: thread.items.clone(),
                    };
                }
            })
            .or_insert(thread);
    }

    let mut threads = threads_by_session.into_values().collect::<Vec<_>>();
    threads.sort_by_key(|thread| std::cmp::Reverse(thread.summary.updated_at));
    threads
}

fn claude_project_dir_name(workspace_path: &str) -> String {
    workspace_path.replace(['/', '\\'], "-")
}

fn collect_workspace_session_files(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
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

fn collect_session_files(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
                continue;
            };
            if matches!(ext, "jsonl" | "json") {
                files.push(path);
            }
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| matches!(name, "subagents" | "tool-results"))
        {
            continue;
        }
        collect_workspace_session_files(&path, files);
    }
}

fn hydrate_thread_from_file(path: &Path, workspace_path: &str) -> Option<HydratedClaudeThread> {
    let file_updated_at = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(DateTime::<Utc>::from);
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut session_id = None;
    let mut cwd = None;
    let mut title = None;
    let mut custom_title = None;
    let mut ai_title = None;
    let mut updated_at = None;
    let mut items = Vec::new();
    let mut tool_identity = HashMap::<String, (String, String)>::new();

    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        session_id =
            session_id.or_else(|| extract_string(&value, &["session_id", "sessionId", "id"]));
        cwd = cwd
            .or_else(|| extract_string(&value, &["cwd", "working_directory", "workingDirectory"]));
        // Claude Code appends `custom-title` (user-assigned via /rename) and
        // `ai-title` (auto-generated, refreshed as the session evolves) lines.
        // Later lines supersede earlier ones, so overwrite rather than keep-first.
        match value.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(value) = extract_string(&value, &["customTitle", "custom_title"]) {
                    custom_title = Some(value);
                }
            }
            Some("ai-title") => {
                if let Some(value) = extract_string(&value, &["aiTitle", "ai_title"]) {
                    ai_title = Some(value);
                }
            }
            _ => {}
        }
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
        let created_at = extract_datetime(&value, &["created_at", "createdAt", "timestamp"])
            .unwrap_or_else(Utc::now);
        if let Some(chunk) = extract_claude_text_chunk(&value) {
            let id = extract_claude_assistant_message_id(&value)
                .unwrap_or_else(|| format!("assistant-{}", created_at.timestamp_millis()));
            upsert_hydrated_assistant_message(
                &mut items,
                &id,
                created_at,
                &chunk.text,
                chunk.is_delta,
            );
            continue;
        }
        if let Some(tool_event) = extract_claude_tool_event(&value) {
            let known_identity = tool_identity.get(&tool_event.id).cloned();
            let title = tool_event
                .title
                .or_else(|| known_identity.as_ref().map(|(title, _)| title.clone()))
                .unwrap_or_else(|| "Claude tool".to_string());
            let tool_kind = tool_event
                .tool_kind
                .or_else(|| {
                    known_identity
                        .as_ref()
                        .map(|(_, tool_kind)| tool_kind.clone())
                })
                .unwrap_or_else(|| title.clone());
            if tool_event.status == "running" {
                tool_identity.insert(tool_event.id.clone(), (title.clone(), tool_kind.clone()));
            }
            upsert_hydrated_tool_call(
                &mut items,
                &tool_event.id,
                &title,
                &tool_kind,
                &tool_event.status,
                tool_event.output.as_deref(),
                created_at,
            );
            continue;
        }
        if let Some(text) = extract_claude_user_message_text(&value) {
            items.push(ConversationItem::UserMessage {
                id: extract_string(&value, &["uuid", "id"])
                    .unwrap_or_else(|| format!("user-{}", created_at.timestamp_millis())),
                text,
                attachments: Vec::new(),
                created_at,
            });
        }
    }

    let cwd = cwd?;
    if cwd != workspace_path {
        return None;
    }
    let session_id = session_id
        .or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .map(ToOwned::to_owned)
        })
        .filter(|value| Uuid::parse_str(value).is_ok())?;
    let now = Utc::now();
    let last_message_preview = items.iter().rev().find_map(|item| match item {
        ConversationItem::AssistantMessage { text, .. }
        | ConversationItem::UserMessage { text, .. } => Some(truncate_preview(text)),
        _ => None,
    });
    // Title precedence: the user's own name, then Claude's auto-title, then any
    // legacy top-level field, then the first prompt, then the placeholder.
    let first_user_message_title = items.iter().find_map(|item| match item {
        ConversationItem::UserMessage { text, .. } => provisional_title_from_text(text),
        _ => None,
    });
    let summary = ThreadSummary {
        id: session_id.clone(),
        workspace_id: String::new(),
        title: custom_title
            .or(ai_title)
            .or(title)
            .or(first_user_message_title)
            .unwrap_or_else(|| "Claude thread".to_string()),
        provider: AgentProvider::CLAUDE,
        native_session_id: Some(session_id),
        status: ThreadStatus::Idle,
        updated_at: updated_at.or(file_updated_at).unwrap_or(now),
        last_message_preview,
        latest_turn_id: None,
        latest_plan: None,
        latest_diff: None,
        last_tool: None,
        last_error: None,
        agent: ThreadAgentParams::default(),
        attention: ThreadAttention::default(),
        is_archived: false,
        is_pinned: false,
        goal: None,
        queued_turns: Vec::new(),
    };

    Some(HydratedClaudeThread { summary, items })
}

fn upsert_hydrated_assistant_message(
    items: &mut Vec<ConversationItem>,
    id: &str,
    created_at: DateTime<Utc>,
    text: &str,
    is_delta: bool,
) {
    if let Some(ConversationItem::AssistantMessage { text: existing, .. }) = items
        .iter_mut()
        .find(|item| matches!(item, ConversationItem::AssistantMessage { id: existing_id, .. } if existing_id == id))
    {
        *existing = if is_delta {
            append_claude_text_delta(existing, text)
        } else {
            merge_claude_assistant_text(existing, text)
        };
        return;
    }

    items.push(ConversationItem::AssistantMessage {
        id: id.to_string(),
        text: text.trim().to_string(),
        created_at,
    });
}

fn upsert_hydrated_tool_call(
    items: &mut Vec<ConversationItem>,
    id: &str,
    title: &str,
    tool_kind: &str,
    status: &str,
    output: Option<&str>,
    created_at: DateTime<Utc>,
) {
    let display = tool_display_metadata(title, tool_kind, status, None, output);
    let completed_at = if status == "running" {
        None
    } else {
        Some(created_at)
    };

    if let Some(ConversationItem::ToolCall {
        title: existing_title,
        tool_kind: existing_kind,
        status: existing_status,
        output: existing_output,
        display: existing_display,
        completed_at: existing_completed_at,
        ..
    }) = items
        .iter_mut()
        .find(|item| matches!(item, ConversationItem::ToolCall { id: existing_id, .. } if existing_id == id))
    {
        *existing_title = title.to_string();
        *existing_kind = tool_kind.to_string();
        *existing_status = status.to_string();
        *existing_output = output.map(ToOwned::to_owned);
        *existing_display = display;
        *existing_completed_at = completed_at;
        return;
    }

    items.push(ConversationItem::ToolCall {
        id: id.to_string(),
        title: title.to_string(),
        tool_kind: tool_kind.to_string(),
        status: status.to_string(),
        output: output.map(ToOwned::to_owned),
        exit_code: None,
        display,
        created_at,
        completed_at,
    });
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

/// Derive a sidebar-worthy title from a prompt: first non-empty line, capped
/// at 60 chars. Used when a session has no ai-title yet.
fn provisional_title_from_text(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    if line.chars().count() <= 60 {
        return Some(line.to_string());
    }
    let truncated: String = line.chars().take(60).collect();
    Some(format!("{}…", truncated.trim_end()))
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
    fn exposes_curated_claude_models_with_versioned_labels() {
        let models = curated_models();
        assert_eq!(models.len(), 4);
        assert_eq!(models[0].id, "haiku");
        assert_eq!(models[0].label, "Haiku 4.5");
        assert_eq!(models[1].id, "sonnet");
        assert_eq!(models[1].label, "Sonnet 5");
        assert!(models[1].is_default);
        assert_eq!(models[2].id, "opus");
        assert_eq!(models[2].label, "Opus 5");
        assert_eq!(models[3].id, "fable");
        assert_eq!(models[3].label, "Fable 5");
    }

    #[test]
    fn hydrates_thread_from_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("session.jsonl");
        fs::write(
            &session_path,
            [
                json!({
                    "session_id": "11111111-1111-4111-8111-111111111111",
                    "cwd": "/tmp/project",
                    "title": "Feature work",
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": "hello"
                    },
                    "created_at": "2026-03-19T10:00:00Z"
                })
                .to_string(),
                json!({
                    "session_id": "11111111-1111-4111-8111-111111111111",
                    "cwd": "/tmp/project",
                    "type": "assistant",
                    "message": {
                        "id": "msg_1",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "text",
                                "text": "world"
                            }
                        ]
                    },
                    "created_at": "2026-03-19T10:00:01Z"
                })
                .to_string(),
                json!({
                    "session_id": "11111111-1111-4111-8111-111111111111",
                    "cwd": "/tmp/project",
                    "type": "assistant",
                    "message": {
                        "id": "msg_1",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_read",
                                "name": "Read",
                                "input": {
                                    "file_path": "/tmp/notes.md"
                                }
                            }
                        ]
                    },
                    "created_at": "2026-03-19T10:00:02Z"
                })
                .to_string(),
                json!({
                    "session_id": "11111111-1111-4111-8111-111111111111",
                    "cwd": "/tmp/project",
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_read",
                                "content": "line 1"
                            }
                        ]
                    },
                    "toolUseResult": {
                        "file": {
                            "filePath": "/tmp/notes.md",
                            "content": "line 1"
                        }
                    },
                    "created_at": "2026-03-19T10:00:03Z"
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.summary.provider, AgentProvider::CLAUDE);
        assert_eq!(
            hydrated.summary.native_session_id.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(hydrated.items.len(), 3);
        assert!(matches!(
            hydrated.items.get(1),
            Some(ConversationItem::AssistantMessage { text, .. }) if text == "world"
        ));
        assert!(matches!(
            hydrated.items.get(2),
            Some(ConversationItem::ToolCall { title, status, output, .. })
                if title == "Read /tmp/notes.md"
                    && status == "completed"
                    && output.as_deref() == Some("line 1")
        ));
    }

    #[test]
    fn hydrates_titles_from_ai_title_and_custom_title_lines() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir
            .path()
            .join("33333333-3333-4333-8333-333333333333.jsonl");
        let user_line = json!({
            "sessionId": "33333333-3333-4333-8333-333333333333",
            "cwd": "/tmp/project",
            "type": "user",
            "message": { "role": "user", "content": "please fix the login timeout bug" },
            "created_at": "2026-03-19T10:00:00Z"
        })
        .to_string();

        // ai-title lines refresh over time: the LAST one wins.
        fs::write(
            &session_path,
            [
                user_line.clone(),
                json!({"type": "ai-title", "aiTitle": "Early title", "sessionId": "33333333-3333-4333-8333-333333333333"}).to_string(),
                json!({"type": "ai-title", "aiTitle": "Fix login timeout bug", "sessionId": "33333333-3333-4333-8333-333333333333"}).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.summary.title, "Fix login timeout bug");

        // custom-title (user-assigned) beats ai-title.
        fs::write(
            &session_path,
            [
                user_line.clone(),
                json!({"type": "ai-title", "aiTitle": "Fix login timeout bug", "sessionId": "33333333-3333-4333-8333-333333333333"}).to_string(),
                json!({"type": "custom-title", "customTitle": "login-fix", "sessionId": "33333333-3333-4333-8333-333333333333"}).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.summary.title, "login-fix");

        // With no title lines at all, fall back to the first prompt.
        fs::write(&session_path, user_line).unwrap();
        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.summary.title, "please fix the login timeout bug");
    }

    #[test]
    fn uses_session_file_mtime_when_claude_records_have_no_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir
            .path()
            .join("22222222-2222-4222-8222-222222222222.jsonl");
        fs::write(
            &session_path,
            json!({
                "sessionId": "22222222-2222-4222-8222-222222222222",
                "cwd": "/tmp/project",
                "type": "user",
                "message": {
                    "role": "user",
                    "content": "hello"
                }
            })
            .to_string(),
        )
        .unwrap();
        let file_updated_at =
            DateTime::<Utc>::from(fs::metadata(&session_path).unwrap().modified().unwrap());

        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();

        assert_eq!(hydrated.summary.updated_at, file_updated_at);
    }

    #[test]
    fn prefers_workspace_specific_project_dir_name() {
        assert_eq!(
            claude_project_dir_name("/Users/James/www/sites/lucidpic"),
            "-Users-James-www-sites-lucidpic"
        );
    }

    #[test]
    fn skips_non_uuid_fallback_session_ids() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("agent-a123.jsonl");
        fs::write(
            &session_path,
            json!({
                "cwd": "/tmp/project",
                "type": "user",
                "text": "hello",
                "created_at": "2026-03-19T10:00:00Z"
            })
            .to_string(),
        )
        .unwrap();

        assert!(hydrate_thread_from_file(&session_path, "/tmp/project").is_none());
    }

    #[tokio::test]
    async fn stream_json_input_wraps_text_only_prompts() {
        let line = build_claude_stream_json_input("hello world", &[]).await;
        let value = serde_json::from_str::<Value>(&line).unwrap();
        assert_eq!(
            value,
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "hello world" }]
                }
            })
        );
    }

    #[tokio::test]
    async fn stream_json_input_replaces_empty_prompts_with_a_placeholder() {
        for prompt in ["", "   \n\t"] {
            let line = build_claude_stream_json_input(prompt, &[]).await;
            let value = serde_json::from_str::<Value>(&line).unwrap();
            assert_eq!(
                value["message"]["content"],
                json!([{ "type": "text", "text": "[empty prompt]" }]),
                "prompt {prompt:?} must not produce an empty text block"
            );
        }
    }

    #[tokio::test]
    async fn stream_json_input_degrades_missing_images_to_text_references() {
        let line = build_claude_stream_json_input(
            "look at this",
            &[ImageInput {
                id: "img-1".to_string(),
                name: Some("diagram.png".to_string()),
                mime_type: Some("image/png".to_string()),
                url: "ignored".to_string(),
                local_path: Some("/nonexistent/diagram.png".to_string()),
            }],
        )
        .await;
        let value = serde_json::from_str::<Value>(&line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[1]["type"], "text");
        assert_eq!(
            content[1]["text"],
            "[image attachment: /nonexistent/diagram.png]"
        );
    }

    #[tokio::test]
    async fn stream_json_input_embeds_readable_images_as_base64() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("shot.png");
        fs::write(&image_path, b"pngdata").unwrap();

        let line = build_claude_stream_json_input(
            "describe",
            &[ImageInput {
                id: "img-1".to_string(),
                name: Some("shot.png".to_string()),
                mime_type: Some("image/png".to_string()),
                url: "ignored".to_string(),
                local_path: Some(image_path.to_string_lossy().to_string()),
            }],
        )
        .await;
        let value = serde_json::from_str::<Value>(&line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();
        assert_eq!(content[0], json!({ "type": "text", "text": "describe" }));
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], BASE64.encode(b"pngdata"));
    }

    #[tokio::test]
    async fn stream_json_input_degrades_images_past_the_aggregate_encoded_budget() {
        let dir = tempfile::tempdir().unwrap();
        let first_path = dir.path().join("first.png");
        let second_path = dir.path().join("second.png");
        fs::write(&first_path, b"pngdata").unwrap();
        fs::write(&second_path, b"pngdata").unwrap();
        let image = |id: &str, path: &Path| ImageInput {
            id: id.to_string(),
            name: Some("shot.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: "ignored".to_string(),
            local_path: Some(path.to_string_lossy().to_string()),
        };

        // Budget covers exactly one encoded copy; the second image must
        // degrade to a text reference.
        let budget = BASE64.encode(b"pngdata").len();
        let line = build_claude_stream_json_input_with_budget(
            "describe",
            &[image("img-1", &first_path), image("img-2", &second_path)],
            budget,
        )
        .await;
        let value = serde_json::from_str::<Value>(&line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[2]["type"], "text");
        assert_eq!(
            content[2]["text"],
            format!("[image attachment: {}]", second_path.to_string_lossy())
        );
    }

    #[test]
    fn hook_settings_route_pre_tool_use_to_the_daemon() {
        let settings =
            serde_json::from_str::<Value>(&build_claude_hook_settings("http://127.0.0.1:4520"))
                .unwrap();
        let hook = &settings["hooks"]["PreToolUse"][0];
        assert_eq!(hook["matcher"], "*");
        let command = hook["hooks"][0]["command"].as_str().unwrap();
        assert!(command.contains("http://127.0.0.1:4520/api/claude/hooks/pre-tool-use"));
        assert!(command.contains("--max-time 570"));
        assert_eq!(hook["hooks"][0]["timeout"], 600);
    }

    #[test]
    fn hook_command_denies_when_curl_cannot_reach_the_daemon() {
        let settings =
            serde_json::from_str::<Value>(&build_claude_hook_settings("http://127.0.0.1:4520"))
                .unwrap();
        let command = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        let (_, fallback) = command.split_once("|| printf '%s' '").unwrap();
        let deny = serde_json::from_str::<Value>(fallback.trim_end_matches('\'')).unwrap();
        assert_eq!(deny["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(
            deny["hookSpecificOutput"]["permissionDecisionReason"],
            "FalconDeck approval unavailable"
        );
    }

    #[tokio::test]
    async fn interrupt_without_an_active_turn_records_the_stop_for_racing_spawns() {
        let runtime = ClaudeRuntime {
            workspace_path: "/tmp/project".to_string(),
            claude_bin: "claude".to_string(),
            active_turns: Mutex::new(HashMap::new()),
            interrupted_turns: Mutex::new(HashSet::new()),
            turn_locks: Mutex::new(HashMap::new()),
            next_turn_generation: std::sync::atomic::AtomicU64::new(1),
        };

        runtime.interrupt_turn("thread-1").await.unwrap();

        assert!(
            runtime.interrupted_turns.lock().await.contains("thread-1"),
            "a spawn in progress must observe the user's stop"
        );
    }

    #[test]
    fn collect_session_files_skips_subagent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let top_level = root.join("session.jsonl");
        let subagents = root.join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        let nested = subagents.join("agent-a123.jsonl");
        fs::write(&top_level, "{}").unwrap();
        fs::write(&nested, "{}").unwrap();

        let mut files = Vec::new();
        collect_session_files(root, &mut files);

        assert_eq!(files, vec![top_level]);
    }
}
