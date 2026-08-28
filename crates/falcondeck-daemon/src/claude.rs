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
    AccountStatus, AccountSummary, AgentCapabilitySummary, AgentProvider, ApprovalDecision,
    CollaborationModeSummary, ContentLifecycle, ConversationItem, ImageInput, InteractiveQuestion,
    InteractiveQuestionOption, ModelSummary, PlanApprovalOutcome, ReasoningEffortSummary,
    ThreadAgentParams, ThreadAttention, ThreadStatus, ThreadSummary, merge_conversation_citations,
};
use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::Mutex,
};
use uuid::Uuid;

use crate::agent_binary::preferred_command_path;
use crate::agent_binary::{
    missing_binary_message, resolve_agent_binary, strip_terminal_advertising_env,
};
use crate::app::agent_helpers::claude_image_reference;
use crate::app::agent_helpers::{
    append_claude_text_delta, claude_tool_result_image_items, extract_claude_assistant_message_id,
    extract_claude_text_chunk, extract_claude_thinking_chunk, extract_claude_tool_event,
    extract_claude_user_message_images, extract_claude_user_message_text,
    merge_claude_assistant_text,
};
use crate::app::conversation_helpers::tool_display_metadata;
use crate::error::DaemonError;

mod stream;
pub(crate) use stream::{
    ClaudeLiveContextUsage, ClaudeNdjsonFramer, ClaudeStreamLine, encode_control_response_error,
    is_resume_startup_failure, live_context_usage, parse_claude_stream_lines, result_is_cancelled,
    result_model_context_window, synthetic_permission_requests,
};

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

#[derive(Clone)]
pub struct HydratedClaudeThread {
    pub summary: ThreadSummary,
    pub items: Vec<ConversationItem>,
    /// True when the title is only a preview of the opening prompt, because
    /// the session file carries no `custom-title` or `ai-title` of its own.
    /// FalconDeck may replace such a title with a generated one.
    pub title_is_provider_preview: bool,
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct TurnConstruction {
    session_id: String,
    cwd: String,
    model_id: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    hooks_enabled: bool,
    control_mcp: bool,
    extensions_mcp: bool,
}

struct ActiveTurn {
    generation: u64,
    child: Child,
    input: Arc<TurnInput>,
    construction: TurnConstruction,
    /// True after a successful `result` while stdin is still open, so the
    /// next turn can write another user line instead of spawning `--resume`.
    awaiting_next_turn: bool,
    /// Per-launch `--mcp-config`; unlinked when this turn is dropped.
    _mcp_config: Option<crate::connectors::LeasedMcpConfig>,
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

/// Maximum time a daemon shutdown gives active Claude turns to finish their
/// SessionEnd hooks after SIGTERM. This is a ceiling, not a required delay.
const SHUTDOWN_GRACE: tokio::time::Duration = tokio::time::Duration::from_millis(500);
const SHUTDOWN_POLL_INTERVAL: tokio::time::Duration = tokio::time::Duration::from_millis(50);

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

        let (account, models) = tokio::join!(read_auth_status(&resolved.executable), list_models());
        let collaboration_modes = Vec::new();
        let capabilities = default_capabilities();
        // Hydration reads and parses every session file for the workspace —
        // potentially hundreds of megabytes of JSONL — so it must not run
        // inline on a runtime worker where it would stall the event pump for
        // every other streaming thread.
        let threads = tokio::task::spawn_blocking(move || hydrate_threads(&workspace_path))
            .await
            .unwrap_or_default();

        Ok(ClaudeBootstrap {
            runtime,
            account,
            models,
            collaboration_modes,
            capabilities,
            threads,
        })
    }

    /// Folder this runtime's workspace lives in. Threads running in an
    /// isolated variant override it per turn.
    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
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
        self: &Arc<Self>,
        thread_id: &str,
        session_id: Option<&str>,
        new_session_id: Option<&str>,
        prompt: &str,
        images: &[ImageInput],
        model_id: Option<&str>,
        effort: Option<&str>,
        permission_mode: Option<&str>,
        daemon_base_url: Option<&str>,
        settings_dir: &Path,
        cwd: &str,
        builtin: &crate::connectors::BuiltinConnectors,
        agent_context: Option<&str>,
    ) -> Result<ClaudeTurnSpawn, DaemonError> {
        // Serialize the whole remove-kill-spawn-insert sequence per thread so
        // concurrent spawns cannot run two CLI processes on one session.
        let turn_lock = self.turn_lock(thread_id).await;
        let _turn_guard = turn_lock.lock().await;

        debug_assert!(session_id.is_none() || new_session_id.is_none());
        let next_session_id = session_id
            .or(new_session_id)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let bypassing_permissions = permission_mode
            .is_some_and(|mode| mode.trim().eq_ignore_ascii_case("bypasspermissions"));
        let hooks_enabled =
            daemon_base_url.is_some() && claude_approvals_enabled() && !bypassing_permissions;
        let construction = TurnConstruction {
            session_id: next_session_id.clone(),
            cwd: cwd.to_string(),
            model_id: model_id.map(str::to_string),
            effort: effort.map(str::to_string),
            permission_mode: permission_mode
                .map(str::trim)
                .filter(|mode| !mode.is_empty() && !mode.eq_ignore_ascii_case("default"))
                .map(str::to_string),
            hooks_enabled,
            control_mcp: builtin.control.is_some(),
            extensions_mcp: builtin.extensions.is_some(),
        };
        // Clear any interrupt aimed at earlier turns; interrupts arriving from
        // here on target this spawn and are re-checked after insertion below.
        self.interrupted_turns.lock().await.remove(thread_id);
        let previous = self.active_turns.lock().await.remove(thread_id);
        if let Some(mut turn) = previous {
            let still_alive = turn.child.try_wait().ok().flatten().is_none();
            if still_alive && turn.awaiting_next_turn && turn.construction == construction {
                turn.awaiting_next_turn = false;
                let generation = turn.generation;
                let input = Arc::clone(&turn.input);
                let session_id = turn.construction.session_id.clone();
                self.active_turns
                    .lock()
                    .await
                    .insert(thread_id.to_string(), turn);
                let input_line = build_claude_stream_json_input(prompt, images).await;
                match input.write_line(&input_line).await {
                    Ok(()) => {
                        return Ok(ClaudeTurnSpawn {
                            session_id,
                            generation,
                            stdout: None,
                            stderr: None,
                        });
                    }
                    Err(error) => {
                        tracing::warn!(
                            "failed to write next prompt to parked claude turn: {error}; respawning"
                        );
                        if let Some(mut parked) = self.active_turns.lock().await.remove(thread_id) {
                            parked.input.close().await;
                            let _ = request_graceful_stop(&mut parked.child);
                            if tokio::time::timeout(INTERRUPT_GRACE, parked.child.wait())
                                .await
                                .is_err()
                            {
                                let _ = parked.child.start_kill();
                                let _ = parked.child.wait().await;
                            }
                        }
                    }
                }
            } else {
                // A thread maps to one Claude session; two concurrent CLI processes
                // resuming the same session corrupt its transcript. Stop any previous
                // turn for this thread before spawning a replacement.
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
            .current_dir(PathBuf::from(cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(path) = preferred_command_path(&resolved.executable) {
            command.env("PATH", path);
        }
        strip_terminal_advertising_env(&mut command);

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
        if let Some(permission_mode) = construction.permission_mode.as_deref() {
            command.arg("--permission-mode").arg(permission_mode);
        }
        // Claude runs PreToolUse hooks regardless of permission mode, so the
        // approval-broker hook must not be installed when the user chose
        // bypassPermissions — otherwise "bypass" still prompts for every tool
        // call, just from FalconDeck instead of Claude.
        if let Some(settings_path) = daemon_base_url
            .filter(|_| claude_approvals_enabled() && !bypassing_permissions)
            .and_then(|base_url| self.write_hook_settings_file(base_url, settings_dir))
        {
            command.arg("--settings").arg(settings_path);
        }
        let mcp_config = self.write_mcp_config_file(settings_dir, builtin);
        if let Some(lease) = &mcp_config {
            command.arg("--mcp-config").arg(lease.path());
            command.arg("--strict-mcp-config");
        }
        for (key, value) in crate::connectors::MCP_CLI_TIMEOUT_ENV {
            command.env(*key, *value);
        }
        if let Some(instructions) = agent_context.map(str::trim).filter(|text| !text.is_empty()) {
            command.arg("--append-system-prompt").arg(instructions);
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
        let writer_input = Arc::clone(&input);
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
                construction,
                awaiting_next_turn: false,
                _mcp_config: mcp_config,
            },
        );
        {
            // Write off-task so a CLI that never reads stdin cannot wedge
            // spawn_turn. If the write fails the CLI never got its prompt and
            // will just sit there; stop it (generation-checked, so a
            // replacement turn is never touched) so the monitor observes an
            // exit and reports the failure instead of hanging until the
            // watchdog.
            let runtime = Arc::clone(self);
            let thread_id = thread_id.to_string();
            tokio::spawn(async move {
                if let Err(error) = writer_input.write_line(&input_line).await {
                    tracing::warn!("failed to send initial prompt to claude turn: {error}");
                    let mut active = runtime.active_turns.lock().await;
                    if let Some(turn) = active.get_mut(&thread_id)
                        && turn.generation == generation
                    {
                        let _ = request_graceful_stop(&mut turn.child);
                    }
                }
            });
        }

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
            let turn = active.get(thread_id).ok_or_else(|| {
                DaemonError::BadRequest("no active claude turn to steer".to_string())
            })?;
            if turn.awaiting_next_turn {
                return Err(DaemonError::BadRequest(
                    "no active claude turn to steer".to_string(),
                ));
            }
            Arc::clone(&turn.input)
        };
        let line = build_claude_stream_json_input(prompt, images).await;
        input.write_line(&line).await
    }

    /// Writes a protocol line to the live CLI stdin, including while the
    /// process is parked between turns. Control replies must not wait for a
    /// new user turn — an ignored `control_request` stalls the CLI.
    pub async fn write_protocol_line(
        &self,
        thread_id: &str,
        line: &str,
    ) -> Result<(), DaemonError> {
        let input = {
            let active = self.active_turns.lock().await;
            let turn = active.get(thread_id).ok_or_else(|| {
                DaemonError::BadRequest("no active claude turn to write to".to_string())
            })?;
            Arc::clone(&turn.input)
        };
        input.write_line(line).await
    }

    /// Keeps the CLI process after a successful `result` so the next turn can
    /// write another stdin line. Returns false when this generation is gone.
    pub async fn park_turn(&self, thread_id: &str, generation: u64) -> bool {
        let mut active = self.active_turns.lock().await;
        match active.get_mut(thread_id) {
            Some(turn) if turn.generation == generation => {
                turn.awaiting_next_turn = true;
                true
            }
            _ => false,
        }
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
        if active.is_empty() {
            return Ok(());
        }

        for turn in active.values_mut() {
            // EOF and SIGTERM together: the CLI now outlives its stdout, so
            // the signal alone is what stops a turn mid-flight, and the close
            // stops it waiting on stdin if it is between turns.
            turn.input.close().await;
            let _ = request_graceful_stop(&mut turn.child);
        }

        // SIGTERM lets Claude run SessionEnd hooks and persist its session.
        // Poll so a turn that exits promptly does not make the app wait out
        // the whole grace period; still hard-kill anything alive at its end.
        let deadline = tokio::time::Instant::now() + SHUTDOWN_GRACE;
        loop {
            let any_turn_still_running = active
                .values_mut()
                .any(|turn| turn.child.try_wait().ok().flatten().is_none());
            if !any_turn_still_running {
                break;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            tokio::time::sleep(SHUTDOWN_POLL_INTERVAL.min(remaining)).await;
        }

        for turn in active.values_mut() {
            if turn.child.try_wait().ok().flatten().is_none() {
                let _ = turn.child.start_kill();
            }
        }
        active.clear();
        Ok(())
    }

    pub async fn provider_metadata(&self) -> ClaudeProviderMetadata {
        let (account, models) = tokio::join!(read_auth_status(&self.claude_bin), list_models());
        ClaudeProviderMetadata {
            account,
            models,
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

    /// Per-launch `--mcp-config`, including an empty `mcpServers` map so
    /// `--strict-mcp-config` cannot fall through to the user's global Claude
    /// MCP list. The file is 0400 in the daemon's 0700 state dir and is
    /// unlinked when the turn is dropped.
    fn write_mcp_config_file(
        &self,
        settings_dir: &Path,
        builtin: &crate::connectors::BuiltinConnectors,
    ) -> Option<crate::connectors::LeasedMcpConfig> {
        let servers = crate::connectors::with_builtin_servers(
            crate::connectors::load_mcp_servers(&self.workspace_path, "claude"),
            builtin,
        );
        let body = crate::connectors::claude_mcp_config_json(&servers);
        match crate::connectors::write_leased_claude_mcp_config(settings_dir, &body) {
            Ok(lease) => Some(lease),
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

pub(crate) const ASK_USER_QUESTION_TOOL: &str = "AskUserQuestion";
pub(crate) const EXIT_PLAN_MODE_TOOL: &str = "ExitPlanMode";
pub(crate) const CLAUDE_POST_PLAN_PERMISSION_MODE: &str = "acceptEdits";

/// Reply the PreToolUse hook waiter accepts from the interactive-request path.
#[derive(Debug, Clone)]
pub(crate) enum ClaudeHookReply {
    Approval(ApprovalDecision),
    QuestionAnswers(std::collections::HashMap<String, Vec<String>>),
    Plan {
        outcome: PlanApprovalOutcome,
        feedback: Option<String>,
    },
}

pub(crate) fn is_claude_plan_mode(mode: Option<&str>) -> bool {
    mode.is_some_and(|mode| mode.trim().eq_ignore_ascii_case("plan"))
}

pub(crate) struct ParsedAskUserQuestion {
    pub questions: Vec<InteractiveQuestion>,
    pub original_questions: Value,
}

pub(crate) fn parse_ask_user_question(input: &Value) -> Option<ParsedAskUserQuestion> {
    let original_questions = input.get("questions")?.as_array()?.clone();
    if original_questions.is_empty() {
        return None;
    }
    let mut questions = Vec::new();
    let mut prompts = HashSet::new();
    for (index, entry) in original_questions.iter().enumerate() {
        let prompt = entry
            .get("question")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())?;
        if !prompts.insert(prompt.to_string()) {
            return None;
        }
        let header = entry
            .get("header")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|header| !header.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| prompt.chars().take(12).collect());
        let options = entry
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let label = option
                            .get("label")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|label| !label.is_empty())?;
                        let description = option
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .unwrap_or("");
                        Some(InteractiveQuestionOption {
                            label: label.to_string(),
                            description: description.to_string(),
                        })
                    })
                    .collect::<Vec<_>>()
            });
        questions.push(InteractiveQuestion {
            id: format!("q{index}"),
            header,
            question: prompt.to_string(),
            is_other: false,
            is_secret: false,
            options,
        });
    }
    (!questions.is_empty()).then_some(ParsedAskUserQuestion {
        questions,
        original_questions: Value::Array(original_questions),
    })
}

pub(crate) fn parse_exit_plan_mode(input: &Value) -> Option<String> {
    input
        .get("plan")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn ask_user_question_updated_input(
    original_questions: &Value,
    questions: &[InteractiveQuestion],
    answers: &std::collections::HashMap<String, Vec<String>>,
) -> Value {
    let mut mapped = serde_json::Map::new();
    for question in questions {
        let text = answers
            .get(&question.id)
            .map(|values| values.join(", "))
            .unwrap_or_default();
        mapped.insert(question.question.clone(), json!(text));
    }
    json!({
        "questions": original_questions,
        "answers": mapped
    })
}

pub(crate) fn exit_plan_mode_rejection_message(feedback: Option<&str>) -> String {
    let base = "The user rejected this plan. Do not call ExitPlanMode again with the same plan. Use AskUserQuestion to find out what they want changed, revise the plan, and only then propose it again.";
    match feedback
        .map(str::trim)
        .filter(|feedback| !feedback.is_empty())
    {
        Some(feedback) => format!("{base} Requested changes: {feedback}"),
        None => base.to_string(),
    }
}

pub(crate) fn exit_plan_mode_abandon_message() -> String {
    "The user abandoned this plan. Do not continue implementing it.".to_string()
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

/// Largest raw image file embedded inline as base64. 7.5 MB expands to the
/// direct Claude API's 10 MB encoded-image ceiling.
const MAX_EMBEDDED_IMAGE_BYTES: u64 = 7_500_000;

/// Aggregate base64-encoded budget across all images in one turn; images past
/// the budget degrade to text references instead of ballooning the input line.
/// 15 MB decoded expands to 20 MB encoded.
const MAX_TOTAL_ENCODED_IMAGE_BYTES: usize = 20_000_000;

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

/// Command-line flags a turn depends on, mirroring the `Command` built in
/// `start_turn`.
///
/// Keep this in step with that spawn. A CLI that drops or renames one of these
/// does not necessarily fail: an ignored `--effort` simply stops applying the
/// user's reasoning choice, and an ignored `--include-partial-messages` stops
/// streaming without erroring. `harness_conformance` checks the installed
/// binary still advertises every one.
pub const REQUIRED_CLI_FLAGS: &[&str] = &[
    "--input-format",
    "--output-format",
    "--include-partial-messages",
    "--include-hook-events",
    "--verbose",
    "--resume",
    "--session-id",
    "--model",
    "--effort",
    "--permission-mode",
    "--settings",
    "--mcp-config",
    "--strict-mcp-config",
];

fn claude_effort(reasoning_effort: &str, description: &str) -> ReasoningEffortSummary {
    ReasoningEffortSummary {
        reasoning_effort: reasoning_effort.to_string(),
        description: description.to_string(),
    }
}

fn claude_base_efforts() -> Vec<ReasoningEffortSummary> {
    vec![
        claude_effort("low", "Fastest responses"),
        claude_effort("medium", "Balanced reasoning"),
        claude_effort("high", "Deeper reasoning"),
        claude_effort("xhigh", "Extended reasoning"),
    ]
}

fn claude_max_efforts() -> Vec<ReasoningEffortSummary> {
    let mut efforts = claude_base_efforts();
    efforts.push(claude_effort("max", "Maximum effort"));
    efforts
}

fn claude_haiku_efforts() -> Vec<ReasoningEffortSummary> {
    vec![claude_effort("low", "Fastest responses")]
}

fn claude_model(
    id: &str,
    label: &str,
    is_default: bool,
    default_reasoning_effort: &str,
    efforts: Vec<ReasoningEffortSummary>,
) -> ModelSummary {
    ModelSummary {
        id: id.to_string(),
        label: label.to_string(),
        is_default,
        default_reasoning_effort: Some(default_reasoning_effort.to_string()),
        supported_reasoning_efforts: efforts,
        // The Claude CLI has no headless fast-mode control yet, so no
        // curated model advertises a service tier.
        service_tiers: Vec::new(),
        default_service_tier: None,
    }
}

pub fn curated_models() -> Vec<ModelSummary> {
    vec![
        claude_model("haiku", "Haiku 4.5", false, "medium", claude_base_efforts()),
        claude_model("sonnet", "Sonnet 5", true, "medium", claude_base_efforts()),
        claude_model("opus", "Opus 5", false, "high", claude_max_efforts()),
        claude_model("fable", "Fable 5", false, "high", claude_max_efforts()),
    ]
}

/// Extra Claude model id the CLI or the user's config advertised outside the
/// curated alias list. Labels come from the source when it has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredClaudeModel {
    pub id: String,
    pub label: String,
}

/// CLI flags that are not required to spawn a turn, but that later Claude
/// control-plane work (native fork) depends on still being advertised.
pub const CONTROL_PLANE_CLI_FLAGS: &[&str] = &["--fork-session"];

fn claude_account_config_path() -> Option<PathBuf> {
    Some(PathBuf::from(env::var_os("HOME")?).join(".claude.json"))
}

/// Quoted tokens from the `--model` help paragraph. The CLI has no model-list
/// command; this is the documented alias set (`fable`, `opus`, `sonnet`, …).
pub fn parse_help_model_ids(help: &str) -> Vec<String> {
    let Some(after_flag) = help.split_once("--model").map(|(_, rest)| rest) else {
        return Vec::new();
    };
    let section = after_flag.split("\n  --").next().unwrap_or(after_flag);
    let mut ids = Vec::new();
    let chars: Vec<char> = section.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if character != '\'' && character != '"' {
            index += 1;
            continue;
        }
        // `model's` uses an apostrophe; only treat a quote as a delimiter
        // when it does not sit inside a word.
        if index > 0 && chars[index - 1].is_ascii_alphabetic() {
            index += 1;
            continue;
        }
        let quote = character;
        index += 1;
        let mut token = String::new();
        while index < chars.len() && chars[index] != quote {
            token.push(chars[index]);
            index += 1;
        }
        if index < chars.len() {
            index += 1;
        }
        let token = token.trim();
        if !is_claude_model_id(token) {
            continue;
        }
        if !ids.iter().any(|existing| existing == token) {
            ids.push(token.to_string());
        }
    }
    ids
}

fn is_claude_model_id(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.len() > 80 {
        return false;
    }
    value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '[' | ']')
    })
}

/// Entries from `additionalModelOptionsCache` in `~/.claude.json`.
pub fn parse_additional_model_options(value: &Value) -> Vec<DiscoveredClaudeModel> {
    let Some(entries) = value
        .get("additionalModelOptionsCache")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut models = Vec::new();
    for entry in entries {
        let id = entry
            .get("value")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| is_claude_model_id(id));
        let Some(id) = id else {
            continue;
        };
        if models
            .iter()
            .any(|existing: &DiscoveredClaudeModel| existing.id == id)
        {
            continue;
        }
        let label = entry
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .unwrap_or(id);
        models.push(DiscoveredClaudeModel {
            id: id.to_string(),
            label: label.to_string(),
        });
    }
    models
}

/// Curated aliases first (labels and efforts stay ours). Discovered ids that
/// are not already in that list are appended so extras such as a 1M variant
/// appear in the picker. An empty discovery result never blanks the catalog.
pub fn merge_claude_models(
    curated: Vec<ModelSummary>,
    discovered: &[DiscoveredClaudeModel],
) -> Vec<ModelSummary> {
    let mut models = curated;
    for extra in discovered {
        if models
            .iter()
            .any(|model| model.id.eq_ignore_ascii_case(&extra.id))
        {
            continue;
        }
        models.push(model_summary_for_discovered(extra));
    }
    models
}

fn model_summary_for_discovered(extra: &DiscoveredClaudeModel) -> ModelSummary {
    let id_lower = extra.id.to_ascii_lowercase();
    let (default_effort, efforts) = if id_lower.contains("haiku") {
        ("low", claude_haiku_efforts())
    } else if id_lower.contains("opus") || id_lower.contains("fable") {
        ("high", claude_max_efforts())
    } else {
        ("medium", claude_base_efforts())
    };
    claude_model(&extra.id, &extra.label, false, default_effort, efforts)
}

async fn read_additional_model_options() -> Vec<DiscoveredClaudeModel> {
    let Some(path) = claude_account_config_path() else {
        return Vec::new();
    };
    let Ok(raw) = tokio::fs::read_to_string(path).await else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    parse_additional_model_options(&value)
}

/// Picker catalog: curated aliases plus any extra ids the CLI config advertises.
pub async fn list_models() -> Vec<ModelSummary> {
    let extras = read_additional_model_options().await;
    merge_claude_models(curated_models(), &extras)
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
                        title_is_provider_preview: thread.title_is_provider_preview,
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

/// A fully parsed session file, cached keyed by (mtime, len) so re-opening a
/// workspace does not re-parse megabytes of unchanged JSONL. Session files are
/// append-only, so any write changes the length and invalidates the entry.
/// The cwd stays alongside the thread rather than being filtered during
/// parsing so one cached parse can answer lookups from any workspace.
#[derive(Clone)]
struct ParsedSessionFile {
    cwd: String,
    thread: HydratedClaudeThread,
}

struct SessionFileCacheEntry {
    modified: Option<std::time::SystemTime>,
    len: u64,
    session: Option<ParsedSessionFile>,
}

static SESSION_FILE_CACHE: OnceLock<std::sync::Mutex<HashMap<PathBuf, SessionFileCacheEntry>>> =
    OnceLock::new();

fn hydrate_thread_from_file(path: &Path, workspace_path: &str) -> Option<HydratedClaudeThread> {
    let session = match fs::metadata(path) {
        Ok(metadata) => {
            let modified = metadata.modified().ok();
            let len = metadata.len();
            let cache = SESSION_FILE_CACHE.get_or_init(Default::default);
            let cached = cache.lock().ok().and_then(|entries| {
                entries.get(path).and_then(|entry| {
                    (entry.modified == modified && entry.len == len).then(|| entry.session.clone())
                })
            });
            match cached {
                Some(session) => session,
                None => {
                    let session = parse_session_file(path);
                    if let Ok(mut entries) = cache.lock() {
                        entries.insert(
                            path.to_path_buf(),
                            SessionFileCacheEntry {
                                modified,
                                len,
                                session: session.clone(),
                            },
                        );
                    }
                    session
                }
            }
        }
        // Unstat-able files can't be validated against a cache entry; parse
        // fresh (which will almost certainly fail to open too).
        Err(_) => parse_session_file(path),
    };
    let session = session?;
    (session.cwd == workspace_path).then_some(session.thread)
}

fn parse_session_file(path: &Path) -> Option<ParsedSessionFile> {
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
    let mut item_index = HydratedItemIndex::default();
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
        // isMeta marks Claude-internal bookkeeping (caveats, command
        // envelopes, compaction notes) recorded in the session file; it is not
        // transcript content and must not seed items, titles, or previews.
        if value
            .get("isMeta")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(chunk) = extract_claude_thinking_chunk(&value) {
            // Deliberately not `continue`: one assistant record can carry
            // thinking and text blocks together.
            let id = extract_claude_assistant_message_id(&value)
                .unwrap_or_else(|| format!("assistant-{}", created_at.timestamp_millis()));
            upsert_hydrated_reasoning(
                &mut items,
                &mut item_index.reasoning,
                &format!("{id}-reasoning"),
                created_at,
                &chunk.text,
                chunk.is_delta,
            );
        }
        if let Some(chunk) = extract_claude_text_chunk(&value) {
            let id = extract_claude_assistant_message_id(&value)
                .unwrap_or_else(|| format!("assistant-{}", created_at.timestamp_millis()));
            upsert_hydrated_assistant_message(
                &mut items,
                &mut item_index.assistant_messages,
                &id,
                created_at,
                &chunk.text,
                chunk.is_delta,
                &chunk.citations,
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
                &mut item_index.tool_calls,
                &tool_event.id,
                &title,
                &tool_kind,
                &tool_event.status,
                tool_event.output.as_deref(),
                created_at,
            );
            for image_item in
                claude_tool_result_image_items(&tool_event.id, &title, &tool_event.images)
            {
                items.push(image_item);
            }
            continue;
        }
        let user_text = extract_claude_user_message_text(&value);
        let user_images = extract_claude_user_message_images(&value);
        if user_text.is_some() || !user_images.is_empty() {
            items.push(ConversationItem::UserMessage {
                id: extract_string(&value, &["uuid", "id"])
                    .unwrap_or_else(|| format!("user-{}", created_at.timestamp_millis())),
                text: user_text.unwrap_or_default(),
                attachments: user_images,
                turn_id: None,
                previous_turn_id: None,
                created_at,
            });
        }
    }

    let cwd = cwd?;
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
    // Claude only writes a title of its own once the user renames a session or
    // its own auto-titler runs, which never happens for most sessions. Falling
    // back to the opening prompt keeps the sidebar readable, but it must stay
    // marked as a preview so FalconDeck's titler can replace it.
    let provider_title = custom_title.or(ai_title).or(title);
    let title_is_provider_preview = provider_title.is_none();
    let summary = ThreadSummary {
        id: session_id.clone(),
        workspace_id: String::new(),
        title: provider_title
            .or(first_user_message_title)
            .unwrap_or_else(|| "Claude thread".to_string()),
        provider: AgentProvider::CLAUDE,
        native_session_id: Some(session_id),
        provider_transport: None,
        handoff_from: None,
        origin: None,
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
        is_pinned_in_project: false,
        goal: None,
        queued_turns: Vec::new(),
        variant: None,
    };

    Some(ParsedSessionFile {
        cwd,
        thread: HydratedClaudeThread {
            summary,
            items,
            title_is_provider_preview,
        },
    })
}

#[derive(Default)]
struct HydratedItemIndex {
    assistant_messages: HashMap<String, usize>,
    reasoning: HashMap<String, usize>,
    tool_calls: HashMap<String, usize>,
}

fn upsert_hydrated_assistant_message(
    items: &mut Vec<ConversationItem>,
    item_index: &mut HashMap<String, usize>,
    id: &str,
    created_at: DateTime<Utc>,
    text: &str,
    is_delta: bool,
    incoming_citations: &[falcondeck_core::ConversationCitation],
) {
    if let Some(ConversationItem::AssistantMessage {
        text: existing,
        citations,
        ..
    }) = item_index.get(id).and_then(|index| items.get_mut(*index))
    {
        if !text.is_empty() {
            *existing = if is_delta {
                append_claude_text_delta(existing, text)
            } else {
                merge_claude_assistant_text(existing, text)
            };
        }
        merge_conversation_citations(citations, incoming_citations.iter().cloned(), id);
        return;
    }

    let mut citations = Vec::new();
    merge_conversation_citations(&mut citations, incoming_citations.iter().cloned(), id);
    item_index.insert(id.to_string(), items.len());
    items.push(ConversationItem::AssistantMessage {
        id: id.to_string(),
        text: text.trim().to_string(),
        phase: None,
        memory_citation: None,
        citations,
        lifecycle: ContentLifecycle::Complete,
        error: None,
        created_at,
    });
}

fn upsert_hydrated_reasoning(
    items: &mut Vec<ConversationItem>,
    item_index: &mut HashMap<String, usize>,
    id: &str,
    created_at: DateTime<Utc>,
    text: &str,
    is_delta: bool,
) {
    if text.is_empty() {
        return;
    }
    if let Some(ConversationItem::Reasoning { content, .. }) =
        item_index.get(id).and_then(|index| items.get_mut(*index))
    {
        *content = if is_delta {
            append_claude_text_delta(content, text)
        } else {
            merge_claude_assistant_text(content, text)
        };
        return;
    }

    item_index.insert(id.to_string(), items.len());
    items.push(ConversationItem::Reasoning {
        id: id.to_string(),
        summary: None,
        content: text.trim().to_string(),
        lifecycle: ContentLifecycle::Complete,
        duration_ms: None,
        created_at,
    });
}

#[allow(clippy::too_many_arguments)]
fn upsert_hydrated_tool_call(
    items: &mut Vec<ConversationItem>,
    item_index: &mut HashMap<String, usize>,
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
    }) = item_index.get(id).and_then(|index| items.get_mut(*index))
    {
        *existing_title = title.to_string();
        *existing_kind = tool_kind.to_string();
        *existing_status = status.to_string();
        *existing_output = output.map(ToOwned::to_owned);
        **existing_display = display;
        *existing_completed_at = completed_at;
        return;
    }

    item_index.insert(id.to_string(), items.len());
    items.push(ConversationItem::ToolCall {
        id: id.to_string(),
        title: title.to_string(),
        tool_kind: tool_kind.to_string(),
        status: status.to_string(),
        output: output.map(ToOwned::to_owned),
        exit_code: None,
        display: Box::new(display),
        detail: None,
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
    fn merge_keeps_curated_when_discovery_is_empty() {
        let merged = merge_claude_models(curated_models(), &[]);
        assert_eq!(merged, curated_models());
    }

    #[test]
    fn merge_appends_unknown_discovered_ids_and_skips_duplicates() {
        let extras = vec![
            DiscoveredClaudeModel {
                id: "sonnet".to_string(),
                label: "Should not replace curated".to_string(),
            },
            DiscoveredClaudeModel {
                id: "claude-fable-5[1m]".to_string(),
                label: "Fable".to_string(),
            },
        ];
        let merged = merge_claude_models(curated_models(), &extras);
        assert_eq!(merged.len(), 5);
        assert_eq!(merged[1].label, "Sonnet 5");
        assert!(merged[1].is_default);
        let extra = merged.last().unwrap();
        assert_eq!(extra.id, "claude-fable-5[1m]");
        assert_eq!(extra.label, "Fable");
        assert!(!extra.is_default);
        assert!(
            extra
                .supported_reasoning_efforts
                .iter()
                .any(|effort| effort.reasoning_effort == "max")
        );
    }

    #[test]
    fn parses_additional_model_options_cache() {
        let extras = parse_additional_model_options(&json!({
            "additionalModelOptionsCache": [
                {
                    "value": "claude-fable-5[1m]",
                    "label": "Fable",
                    "description": "ignored"
                },
                { "value": "" },
                { "label": "orphan" }
            ]
        }));
        assert_eq!(
            extras,
            vec![DiscoveredClaudeModel {
                id: "claude-fable-5[1m]".to_string(),
                label: "Fable".to_string(),
            }]
        );
    }

    #[test]
    fn parses_ask_user_question_input() {
        let parsed = parse_ask_user_question(&json!({
            "questions": [{
                "question": "Which flavor?",
                "header": "Flavor",
                "options": [
                    { "label": "Vanilla", "description": "classic" },
                    { "label": "Chocolate", "description": "rich" }
                ]
            }]
        }))
        .unwrap();
        assert_eq!(parsed.questions[0].id, "q0");
        assert_eq!(parsed.questions[0].question, "Which flavor?");
        assert_eq!(
            parsed.questions[0].options.as_ref().unwrap()[0].label,
            "Vanilla"
        );
        let updated = ask_user_question_updated_input(
            &parsed.original_questions,
            &parsed.questions,
            &std::collections::HashMap::from([("q0".to_string(), vec!["Vanilla".to_string()])]),
        );
        assert_eq!(updated["answers"]["Which flavor?"], "Vanilla");
    }

    #[test]
    fn rejects_ask_user_question_with_duplicate_prompts() {
        assert!(
            parse_ask_user_question(&json!({
                "questions": [
                    { "question": "Same?" },
                    { "question": "Same?" }
                ]
            }))
            .is_none()
        );
    }

    #[test]
    fn parses_exit_plan_mode_plan_text() {
        assert_eq!(
            parse_exit_plan_mode(&json!({ "plan": "  Ship it.  " })).as_deref(),
            Some("Ship it.")
        );
        assert!(parse_exit_plan_mode(&json!({ "plan": "   " })).is_none());
    }

    #[test]
    fn parses_model_aliases_from_help_model_section() {
        let help = "\
  --mcp-config <configs...>             Load MCP servers
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  --name <name>                         Set a display name
";
        assert_eq!(
            parse_help_model_ids(help),
            vec![
                "fable".to_string(),
                "opus".to_string(),
                "sonnet".to_string(),
                "claude-fable-5".to_string()
            ]
        );
    }

    #[test]
    fn hydrated_citation_enrichment_preserves_one_stable_source_part() {
        let citation =
            |title: Option<&str>, cited_text: Option<&str>| falcondeck_core::ConversationCitation {
                id: None,
                kind: "web_search_result_location".to_string(),
                url: Some("https://example.com/source".to_string()),
                source: None,
                title: title.map(str::to_string),
                cited_text: cited_text.map(str::to_string),
                locator: None,
            };
        let created_at = Utc::now();
        let mut items = Vec::new();
        let mut item_index = HashMap::new();

        upsert_hydrated_assistant_message(
            &mut items,
            &mut item_index,
            "answer-1",
            created_at,
            "Grounded answer",
            false,
            &[citation(None, None)],
        );
        upsert_hydrated_assistant_message(
            &mut items,
            &mut item_index,
            "answer-1",
            created_at,
            "Grounded answer",
            false,
            &[citation(Some("Example"), Some("Supporting evidence"))],
        );

        let ConversationItem::AssistantMessage { citations, .. } = &items[0] else {
            panic!("expected assistant message");
        };
        assert_eq!(citations.len(), 1);
        assert_eq!(citations[0].id.as_deref(), Some("answer-1:citation:0"));
        assert_eq!(citations[0].title.as_deref(), Some("Example"));
        assert_eq!(
            citations[0].cited_text.as_deref(),
            Some("Supporting evidence")
        );
    }

    #[test]
    fn session_file_cache_refreshes_on_append_and_filters_per_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("session.jsonl");
        let record = |text: &str| {
            json!({
                "session_id": "33333333-3333-4333-8333-333333333333",
                "cwd": "/tmp/project",
                "type": "user",
                "message": { "role": "user", "content": text },
                "created_at": "2026-03-19T10:00:00Z"
            })
            .to_string()
        };
        fs::write(&session_path, record("first")).unwrap();

        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.items.len(), 1);

        // The cached parse must still be filtered by the requested workspace,
        // not returned wholesale to whoever asks.
        assert!(hydrate_thread_from_file(&session_path, "/tmp/other").is_none());

        // Appending grows the file, which must invalidate the cache entry even
        // when the mtime's coarse granularity makes it look unchanged.
        let mut contents = fs::read_to_string(&session_path).unwrap();
        contents.push('\n');
        contents.push_str(&record("second"));
        fs::write(&session_path, contents).unwrap();

        let rehydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(rehydrated.items.len(), 2, "{:?}", rehydrated.items);
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
                // The array-content form Claude Code actually writes for user
                // prompts; it must hydrate as the user's message, not as
                // assistant prose.
                json!({
                    "session_id": "11111111-1111-4111-8111-111111111111",
                    "cwd": "/tmp/project",
                    "type": "user",
                    "uuid": "user-2",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "and now commit it"
                            }
                        ]
                    },
                    "created_at": "2026-03-19T10:00:04Z"
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
        assert_eq!(hydrated.items.len(), 4);
        assert!(matches!(
            hydrated.items.get(1),
            Some(ConversationItem::AssistantMessage {
                text,
                lifecycle: ContentLifecycle::Complete,
                ..
            }) if text == "world"
        ));
        assert!(matches!(
            hydrated.items.get(2),
            Some(ConversationItem::ToolCall { title, status, output, .. })
                if title == "Read /tmp/notes.md"
                    && status == "completed"
                    && output.as_deref() == Some("line 1")
        ));
        assert!(matches!(
            hydrated.items.get(3),
            Some(ConversationItem::UserMessage { text, .. }) if text == "and now commit it"
        ));
    }

    #[test]
    fn hydrates_pasted_images_as_user_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("session.jsonl");
        fs::write(
            &session_path,
            json!({
                "session_id": "22222222-2222-4222-8222-222222222222",
                "cwd": "/tmp/project",
                "type": "user",
                "uuid": "user-1",
                "message": {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "what is in this screenshot?" },
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": "aGVsbG8="
                            }
                        }
                    ]
                },
                "created_at": "2026-03-19T10:00:00Z"
            })
            .to_string(),
        )
        .unwrap();

        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.items.len(), 1, "{:?}", hydrated.items);
        let Some(ConversationItem::UserMessage {
            text, attachments, ..
        }) = hydrated.items.first()
        else {
            panic!("expected user message, got {:?}", hydrated.items);
        };
        assert_eq!(text, "what is in this screenshot?");
        assert_eq!(attachments.len(), 1);
        let image = &attachments[0];
        assert_eq!(image.mime_type.as_deref(), Some("image/png"));
        assert_eq!(image.url, "data:image/png;base64,aGVsbG8=");
        assert!(image.local_path.is_none());
        // Deterministic content-hash id: restarts must map the same image
        // back to the same materialized attachment file.
        let again = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        let Some(ConversationItem::UserMessage {
            attachments: again_attachments,
            ..
        }) = again.items.first()
        else {
            panic!("expected user message");
        };
        assert_eq!(again_attachments[0].id, image.id);
        assert!(image.id.starts_with("claude-img-"));
    }

    #[test]
    fn hydration_skips_meta_and_internal_records() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir
            .path()
            .join("44444444-4444-4444-8444-444444444444.jsonl");
        let record = |content: Value, extra: Value| {
            let mut line = json!({
                "sessionId": "44444444-4444-4444-8444-444444444444",
                "cwd": "/tmp/project",
                "type": "user",
                "message": { "role": "user", "content": content },
                "created_at": "2026-03-19T10:00:00Z"
            });
            line.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            line.to_string()
        };
        fs::write(
            &session_path,
            [
                record(
                    json!("Caveat: the messages below were generated by the user while running local commands."),
                    json!({ "isMeta": true }),
                ),
                record(
                    json!("<command-name>/clear</command-name>\n<command-message>clear</command-message>"),
                    json!({}),
                ),
                record(json!("<local-command-stdout>(no content)</local-command-stdout>"), json!({})),
                record(json!("[Request interrupted by user]"), json!({})),
                record(json!("fix the login bug"), json!({})),
            ]
            .join("\n"),
        )
        .unwrap();

        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.items.len(), 1, "{:?}", hydrated.items);
        assert!(matches!(
            hydrated.items.first(),
            Some(ConversationItem::UserMessage { text, .. }) if text == "fix the login bug"
        ));
        // Internal records must not seed provisional titles or previews.
        assert_eq!(hydrated.summary.title, "fix the login bug");
        assert_eq!(
            hydrated.summary.last_message_preview.as_deref(),
            Some("fix the login bug")
        );
    }

    #[test]
    fn hydrates_thinking_blocks_as_reasoning_items() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("session.jsonl");
        fs::write(
            &session_path,
            json!({
                "session_id": "55555555-5555-4555-8555-555555555555",
                "cwd": "/tmp/project",
                "type": "assistant",
                "message": {
                    "id": "msg_think",
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "The bug is in the retry loop.", "signature": "sig" },
                        { "type": "text", "text": "Fixing the retry loop." }
                    ]
                },
                "created_at": "2026-03-19T10:00:00Z"
            })
            .to_string(),
        )
        .unwrap();

        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.items.len(), 2, "{:?}", hydrated.items);
        assert!(matches!(
            hydrated.items.first(),
            Some(ConversationItem::Reasoning {
                id,
                content,
                lifecycle: ContentLifecycle::Complete,
                ..
            }) if id == "msg_think-reasoning" && content == "The bug is in the retry loop."
        ));
        assert!(matches!(
            hydrated.items.get(1),
            Some(ConversationItem::AssistantMessage { id, text, .. })
                if id == "msg_think" && text == "Fixing the retry loop."
        ));
    }

    #[test]
    fn hydrates_failed_tool_results_as_failed() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("session.jsonl");
        fs::write(
            &session_path,
            [
                json!({
                    "session_id": "66666666-6666-4666-8666-666666666666",
                    "cwd": "/tmp/project",
                    "type": "assistant",
                    "message": {
                        "id": "msg_1",
                        "role": "assistant",
                        "content": [{
                            "type": "tool_use",
                            "id": "toolu_bash",
                            "name": "Bash",
                            "input": { "command": "cargo test" }
                        }]
                    },
                    "created_at": "2026-03-19T10:00:00Z"
                })
                .to_string(),
                json!({
                    "session_id": "66666666-6666-4666-8666-666666666666",
                    "cwd": "/tmp/project",
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": "toolu_bash",
                            "content": "test failed",
                            "is_error": true
                        }]
                    },
                    "created_at": "2026-03-19T10:00:01Z"
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert!(matches!(
            hydrated.items.first(),
            Some(ConversationItem::ToolCall { status, .. }) if status == "failed"
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
        assert!(!hydrated.title_is_provider_preview);

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

        // With no title lines at all, fall back to the first prompt — but mark
        // it as a preview so FalconDeck's own titler still runs.
        fs::write(&session_path, user_line).unwrap();
        let hydrated = hydrate_thread_from_file(&session_path, "/tmp/project").unwrap();
        assert_eq!(hydrated.summary.title, "please fix the login timeout bug");
        assert!(hydrated.title_is_provider_preview);
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

    #[tokio::test]
    async fn shutting_down_an_idle_runtime_skips_the_grace_period() {
        let runtime = ClaudeRuntime {
            workspace_path: "/tmp/project".to_string(),
            claude_bin: "claude".to_string(),
            active_turns: Mutex::new(HashMap::new()),
            interrupted_turns: Mutex::new(HashSet::new()),
            turn_locks: Mutex::new(HashMap::new()),
            next_turn_generation: std::sync::atomic::AtomicU64::new(1),
        };

        // This checks a real timing contract: idle runtime shutdown must not
        // wait for the 500 ms grace that is reserved for live child processes.
        let result =
            tokio::time::timeout(tokio::time::Duration::from_millis(250), runtime.shutdown()).await;
        assert!(matches!(result, Ok(Ok(()))));
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
