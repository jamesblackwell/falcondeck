//! Native Antigravity CLI (`agy`) adapter.
//!
//! Antigravity has no ACP server. The supported embedding path is print mode
//! with `--input-format stream-json` / `--output-format stream-json`: one child
//! process per turn, resume via `--conversation`, extra user lines on stdin
//! for steering. Headless runs cannot show interactive permission prompts —
//! tools that would ask are soft-denied unless `--dangerously-skip-permissions`
//! or a settings allow-rule grants them.

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use crate::agent_binary::{
    missing_binary_message, preferred_command_path, resolve_agent_binary,
    strip_terminal_advertising_env,
};
use crate::app::agent_helpers::claude_image_reference;
use crate::error::DaemonError;
use chrono::{DateTime, Utc};
use falcondeck_core::{
    AccountStatus, AccountSummary, AgentCapabilitySummary, AgentProvider, ImageInput, ModelSummary,
    ReasoningEffortSummary, SkillAvailability, SkillSourceKind, SkillSummary, ThreadAgentParams,
    ThreadAttention, ThreadStatus, ThreadSummary,
};
use serde_json::{Value, json};
use tokio::{
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::Mutex,
};

const INTERRUPT_GRACE: tokio::time::Duration = tokio::time::Duration::from_secs(5);
const EXIT_GRACE: tokio::time::Duration = tokio::time::Duration::from_secs(10);
const WRITE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(10);
const PROBE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(15);
/// Maximum time a daemon shutdown gives an active Antigravity turn to finish
/// after SIGTERM. This is a ceiling, not a required delay.
const SHUTDOWN_GRACE: tokio::time::Duration = tokio::time::Duration::from_millis(500);
const SHUTDOWN_POLL_INTERVAL: tokio::time::Duration = tokio::time::Duration::from_millis(50);
/// Headless default is five minutes, which is too short for a coding turn.
const PRINT_TIMEOUT: &str = "24h";

/// Flags FalconDeck relies on. The regression test keeps the declared surface
/// aligned with turn spawning until the live conformance probe covers AGY.
#[cfg(test)]
const REQUIRED_CLI_FLAGS: &[&str] = &[
    "--print",
    "--input-format",
    "--output-format",
    "--conversation",
    "--model",
    "--effort",
    "--mode",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--print-timeout",
];

pub struct AgyBootstrap {
    pub runtime: Arc<AgyRuntime>,
    pub account: AccountSummary,
    pub models: Vec<ModelSummary>,
    pub skills: Vec<SkillSummary>,
    pub capabilities: AgentCapabilitySummary,
    pub threads: Vec<HydratedAgyThread>,
}

pub struct AgyProviderMetadata {
    pub account: AccountSummary,
    pub models: Vec<ModelSummary>,
    pub skills: Vec<SkillSummary>,
    pub capabilities: AgentCapabilitySummary,
}

#[derive(Clone)]
pub struct HydratedAgyThread {
    pub summary: ThreadSummary,
    pub items: Vec<falcondeck_core::ConversationItem>,
    pub title_is_provider_preview: bool,
}

pub struct AgyTurnSpawn {
    pub session_id: String,
    pub generation: u64,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

pub struct AgyTurnFinish {
    pub status: Option<std::process::ExitStatus>,
    pub interrupted: bool,
    pub stale: bool,
}

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
            DaemonError::BadRequest("antigravity turn is no longer accepting input".to_string())
        })?;
        let write = async {
            use tokio::io::AsyncWriteExt;
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        };
        match tokio::time::timeout(WRITE_TIMEOUT, write).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(DaemonError::Process(format!(
                "failed to write to antigravity turn: {error}"
            ))),
            Err(_) => Err(DaemonError::Process(
                "timed out writing to antigravity turn".to_string(),
            )),
        }
    }

    async fn close(&self) {
        self.stdin.lock().await.take();
    }
}

struct ActiveTurn {
    generation: u64,
    child: Child,
    input: Arc<TurnInput>,
}

pub struct AgyRuntime {
    workspace_path: String,
    agy_bin: String,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    interrupted_turns: Mutex<HashSet<String>>,
    turn_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    next_turn_generation: std::sync::atomic::AtomicU64,
}

impl AgyRuntime {
    pub async fn connect(
        workspace_path: String,
        agy_bin: String,
    ) -> Result<AgyBootstrap, DaemonError> {
        let resolved = resolve_agent_binary("agy", &agy_bin);
        let runtime = Arc::new(Self {
            workspace_path: workspace_path.clone(),
            agy_bin: resolved.executable.clone(),
            active_turns: Mutex::new(HashMap::new()),
            interrupted_turns: Mutex::new(HashSet::new()),
            turn_locks: Mutex::new(HashMap::new()),
            next_turn_generation: std::sync::atomic::AtomicU64::new(1),
        });

        let executable = resolved.executable.clone();
        let hydrate_path = workspace_path.clone();
        let (account, models, skills, threads) = tokio::join!(
            read_auth_status(&executable),
            list_models(&executable),
            list_skills(&executable),
            async {
                tokio::task::spawn_blocking(move || hydrate_threads(&hydrate_path))
                    .await
                    .unwrap_or_default()
            }
        );
        let capabilities = default_capabilities();

        Ok(AgyBootstrap {
            runtime,
            account,
            models,
            skills,
            capabilities,
            threads,
        })
    }

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
        prompt: &str,
        images: &[ImageInput],
        model_id: Option<&str>,
        effort: Option<&str>,
        permission_mode: Option<&str>,
        sandbox_mode: Option<&str>,
        cwd: &str,
    ) -> Result<AgyTurnSpawn, DaemonError> {
        let turn_lock = self.turn_lock(thread_id).await;
        let _turn_guard = turn_lock.lock().await;

        self.interrupted_turns.lock().await.remove(thread_id);
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

        let input_line = build_stream_json_input(prompt, images);
        let resolved = resolve_agent_binary("agy", &self.agy_bin);
        let mut command = Command::new(&resolved.executable);
        command
            .arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--print-timeout")
            .arg(PRINT_TIMEOUT)
            .current_dir(PathBuf::from(cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(path) = preferred_command_path(&resolved.executable) {
            command.env("PATH", path);
        }
        strip_terminal_advertising_env(&mut command);

        if let Some(existing) = session_id.map(str::trim).filter(|id| !id.is_empty()) {
            command.arg("--conversation").arg(existing);
        }
        if let Some(model_id) = model_id.map(str::trim).filter(|id| !id.is_empty()) {
            command.arg("--model").arg(model_id);
        }
        if let Some(effort) = effort_flag(model_id, effort) {
            command.arg("--effort").arg(effort);
        }
        match permission_flags(permission_mode) {
            PermissionFlags::DangerouslySkip => {
                command.arg("--dangerously-skip-permissions");
            }
            PermissionFlags::Mode(mode) => {
                command.arg("--mode").arg(mode);
            }
            PermissionFlags::Default => {}
        }
        if sandbox_enabled(sandbox_mode) {
            command.arg("--sandbox");
        }

        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                let message = missing_binary_message(
                    "Antigravity CLI",
                    "agy",
                    &resolved.diagnostics,
                    "Install with `curl -fsSL https://antigravity.google/cli/install.sh | bash` or relaunch FalconDeck after your shell PATH is set up.",
                );
                return DaemonError::Process(message);
            }
            DaemonError::Process(format!("failed to start agy: {error}"))
        })?;

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
            },
        );
        {
            let runtime = Arc::clone(self);
            let thread_id = thread_id.to_string();
            tokio::spawn(async move {
                if let Err(error) = writer_input.write_line(&input_line).await {
                    tracing::warn!("failed to send initial prompt to antigravity turn: {error}");
                    let mut active = runtime.active_turns.lock().await;
                    if let Some(turn) = active.get_mut(&thread_id)
                        && turn.generation == generation
                    {
                        let _ = request_graceful_stop(&mut turn.child);
                    }
                }
            });
        }

        if self.interrupted_turns.lock().await.contains(thread_id) {
            let mut active = self.active_turns.lock().await;
            if let Some(turn) = active.get_mut(thread_id) {
                let _ = request_graceful_stop(&mut turn.child);
            }
        }

        Ok(AgyTurnSpawn {
            session_id: session_id
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .unwrap_or_default()
                .to_string(),
            generation,
            stdout,
            stderr,
        })
    }

    pub async fn steer_turn(
        &self,
        thread_id: &str,
        prompt: &str,
        images: &[ImageInput],
    ) -> Result<(), DaemonError> {
        let input = {
            let active = self.active_turns.lock().await;
            active
                .get(thread_id)
                .map(|turn| Arc::clone(&turn.input))
                .ok_or_else(|| {
                    DaemonError::BadRequest("no active antigravity turn to steer".to_string())
                })?
        };
        input
            .write_line(&build_stream_json_input(prompt, images))
            .await
    }

    pub async fn complete_turn(&self, thread_id: &str, generation: u64) -> AgyTurnFinish {
        let turn = {
            let mut active = self.active_turns.lock().await;
            match active.get(thread_id) {
                Some(turn) if turn.generation == generation => active.remove(thread_id),
                _ => {
                    return AgyTurnFinish {
                        status: None,
                        interrupted: false,
                        stale: true,
                    };
                }
            }
        };
        let interrupted = self.interrupted_turns.lock().await.remove(thread_id);
        if let Some(mut turn) = turn {
            turn.input.close().await;
            tokio::spawn(async move {
                if tokio::time::timeout(EXIT_GRACE, turn.child.wait())
                    .await
                    .is_ok()
                {
                    return;
                }
                tracing::warn!("antigravity turn did not exit after stdin close; terminating");
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
        AgyTurnFinish {
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
                    self.interrupted_turns
                        .lock()
                        .await
                        .insert(thread_id.to_string());
                    match request_graceful_stop(&mut turn.child) {
                        Ok(signalled) => signalled,
                        Err(error) => {
                            self.interrupted_turns.lock().await.remove(thread_id);
                            return Err(DaemonError::Process(format!(
                                "failed to interrupt antigravity turn: {error}"
                            )));
                        }
                    }
                }
                None => {
                    self.interrupted_turns
                        .lock()
                        .await
                        .insert(thread_id.to_string());
                    return Ok(());
                }
            }
        };

        if signalled {
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
                DaemonError::Process(format!("failed to interrupt antigravity turn: {error}"))
            })?;
        }
        Ok(())
    }

    pub async fn finish_turn(
        &self,
        thread_id: &str,
        generation: u64,
    ) -> Result<AgyTurnFinish, DaemonError> {
        let turn = {
            let mut active = self.active_turns.lock().await;
            match active.get(thread_id) {
                Some(turn) if turn.generation == generation => active.remove(thread_id),
                _ => {
                    return Ok(AgyTurnFinish {
                        status: None,
                        interrupted: false,
                        stale: true,
                    });
                }
            }
        };
        let interrupted = self.interrupted_turns.lock().await.remove(thread_id);
        if let Some(mut turn) = turn {
            turn.input.close().await;
            let status = match tokio::time::timeout(EXIT_GRACE, turn.child.wait()).await {
                Ok(status) => status.map_err(|error| {
                    DaemonError::Process(format!("failed to wait for antigravity turn: {error}"))
                })?,
                Err(_) => {
                    let _ = turn.child.start_kill();
                    turn.child.wait().await.map_err(|error| {
                        DaemonError::Process(format!(
                            "failed to wait for antigravity turn: {error}"
                        ))
                    })?
                }
            };
            return Ok(AgyTurnFinish {
                status: Some(status),
                interrupted,
                stale: false,
            });
        }
        Ok(AgyTurnFinish {
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
            turn.input.close().await;
            let _ = request_graceful_stop(&mut turn.child);
        }

        // Let a SIGTERM finish naturally, but do not make the desktop wait a
        // fixed half second once every active process has already exited.
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

    pub async fn provider_metadata(&self) -> AgyProviderMetadata {
        AgyProviderMetadata {
            account: read_auth_status(&self.agy_bin).await,
            models: list_models(&self.agy_bin).await,
            skills: list_skills(&self.agy_bin).await,
            capabilities: default_capabilities(),
        }
    }
}

fn default_capabilities() -> AgentCapabilitySummary {
    AgentCapabilitySummary::agy()
}

enum PermissionFlags {
    Default,
    Mode(&'static str),
    DangerouslySkip,
}

fn permission_flags(permission_mode: Option<&str>) -> PermissionFlags {
    let mode = permission_mode.unwrap_or("").trim();
    if mode.is_empty() || mode.eq_ignore_ascii_case("default") {
        return PermissionFlags::Default;
    }
    if matches!(
        mode.to_ascii_lowercase().as_str(),
        "bypasspermissions" | "bypass" | "always-proceed" | "dontask" | "never"
    ) {
        return PermissionFlags::DangerouslySkip;
    }
    if mode.eq_ignore_ascii_case("accept-edits") || mode.eq_ignore_ascii_case("acceptedits") {
        return PermissionFlags::Mode("accept-edits");
    }
    if mode.eq_ignore_ascii_case("plan") {
        return PermissionFlags::Mode("plan");
    }
    PermissionFlags::Default
}

fn sandbox_enabled(sandbox_mode: Option<&str>) -> bool {
    matches!(
        sandbox_mode
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "sandbox" | "on" | "true" | "1"
    )
}

fn effort_flag<'a>(model_id: Option<&str>, effort: Option<&'a str>) -> Option<&'a str> {
    let effort = effort.map(str::trim).filter(|value| !value.is_empty())?;
    let model = model_id.unwrap_or("").to_ascii_lowercase();
    let suffix = format!("-{effort}");
    if model.ends_with(&suffix) {
        return None;
    }
    Some(effort)
}

pub fn build_stream_json_input(prompt: &str, images: &[ImageInput]) -> String {
    let mut content = Vec::new();
    if !prompt.trim().is_empty() {
        content.push(json!({ "type": "text", "text": prompt }));
    }
    for image in images {
        content.push(json!({
            "type": "text",
            "text": claude_image_reference(image)
        }));
    }
    if content.is_empty() {
        content.push(json!({ "type": "text", "text": "[empty prompt]" }));
    }
    json!({
        "event": "user",
        "message": { "content": content }
    })
    .to_string()
}

fn request_graceful_stop(child: &mut Child) -> std::io::Result<bool> {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            if result == 0 {
                return Ok(true);
            }
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

pub async fn read_auth_status(agy_bin: &str) -> AccountSummary {
    let resolved = resolve_agent_binary("agy", agy_bin);
    if !Path::new(&resolved.executable).is_file() {
        return AccountSummary {
            status: AccountStatus::Unknown,
            label: "Antigravity CLI not installed".to_string(),
        };
    }

    let mut command = Command::new(&resolved.executable);
    command
        .arg("-p")
        .arg("/usage")
        .arg("--output-format")
        .arg("json")
        .arg("--print-timeout")
        .arg("30s")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(path) = preferred_command_path(&resolved.executable) {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output()).await;
    match output {
        Ok(Ok(output)) => {
            parse_usage_account(&output.stdout, &output.stderr, output.status.success())
        }
        Ok(Err(_)) => AccountSummary {
            status: AccountStatus::Unknown,
            label: "Antigravity not available".to_string(),
        },
        Err(_) => AccountSummary {
            status: AccountStatus::Unknown,
            label: "Antigravity auth status check timed out".to_string(),
        },
    }
}

fn parse_usage_account(stdout: &[u8], stderr: &[u8], success: bool) -> AccountSummary {
    let stdout_text = String::from_utf8_lossy(stdout);
    let stderr_text = String::from_utf8_lossy(stderr);
    let combined = format!("{stdout_text}\n{stderr_text}").to_ascii_lowercase();
    if combined.contains("authentication required")
        || combined.contains("please sign in")
        || combined.contains("not authenticated")
    {
        return AccountSummary {
            status: AccountStatus::NeedsAuth,
            label: "Antigravity login required. Run `agy` in a terminal to sign in.".to_string(),
        };
    }
    if let Ok(value) = serde_json::from_slice::<Value>(stdout)
        && value
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("success"))
    {
        return AccountSummary {
            status: AccountStatus::Ready,
            label: "Antigravity ready".to_string(),
        };
    }
    if success {
        return AccountSummary {
            status: AccountStatus::Ready,
            label: "Antigravity ready".to_string(),
        };
    }
    AccountSummary {
        status: AccountStatus::Unknown,
        label: "Antigravity auth status unavailable".to_string(),
    }
}

async fn list_models(agy_bin: &str) -> Vec<ModelSummary> {
    let resolved = resolve_agent_binary("agy", agy_bin);
    if !Path::new(&resolved.executable).is_file() {
        return curated_models();
    }
    let mut command = Command::new(&resolved.executable);
    command
        .arg("models")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(path) = preferred_command_path(&resolved.executable) {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output()).await;
    match output {
        Ok(Ok(output)) if output.status.success() => {
            let parsed = parse_models_table(&String::from_utf8_lossy(&output.stdout));
            if parsed.is_empty() {
                curated_models()
            } else {
                parsed
            }
        }
        _ => curated_models(),
    }
}

async fn list_skills(agy_bin: &str) -> Vec<SkillSummary> {
    let resolved = resolve_agent_binary("agy", agy_bin);
    if !Path::new(&resolved.executable).is_file() {
        return Vec::new();
    }
    let mut command = Command::new(&resolved.executable);
    command
        .arg("-p")
        .arg("/skills")
        .arg("--output-format")
        .arg("json")
        .arg("--print-timeout")
        .arg("30s")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(path) = preferred_command_path(&resolved.executable) {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output()).await;
    match output {
        Ok(Ok(output)) if output.status.success() => {
            serde_json::from_slice::<Value>(&output.stdout)
                .ok()
                .map(|value| parse_skills_payload(&value))
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

pub fn parse_models_table(stdout: &str) -> Vec<ModelSummary> {
    let mut models = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("Fetching") {
            continue;
        }
        let (id, label) = match line.split_once('\t') {
            Some((id, label)) => (id.trim(), label.trim()),
            None => {
                let Some((id, label)) = line.split_once(' ') else {
                    continue;
                };
                (id.trim(), label.trim())
            }
        };
        if id.is_empty() {
            continue;
        }
        let effort = model_effort_from_slug(id);
        models.push(ModelSummary {
            id: id.to_string(),
            label: if label.is_empty() {
                id.to_string()
            } else {
                label.to_string()
            },
            is_default: false,
            default_reasoning_effort: effort.map(str::to_string),
            supported_reasoning_efforts: if effort.is_some() {
                Vec::new()
            } else {
                default_efforts()
            },
            service_tiers: Vec::new(),
            default_service_tier: None,
        });
    }
    if let Some(model) = pick_default_model(&mut models) {
        model.is_default = true;
    }
    models
}

fn pick_default_model(models: &mut [ModelSummary]) -> Option<&mut ModelSummary> {
    let preferred = [
        "gemini-3.7-flash-medium",
        "gemini-3.6-flash-medium",
        "gemini-3.5-flash-medium",
    ];
    let index = preferred
        .iter()
        .find_map(|id| models.iter().position(|model| model.id == *id))
        .or_else(|| models.iter().position(|model| model.id.contains("medium")))
        .or_else(|| (!models.is_empty()).then_some(0))?;
    models.get_mut(index)
}

fn model_effort_from_slug(id: &str) -> Option<&'static str> {
    if id.ends_with("-low") {
        Some("low")
    } else if id.ends_with("-medium") {
        Some("medium")
    } else if id.ends_with("-high") {
        Some("high")
    } else {
        None
    }
}

fn default_efforts() -> Vec<ReasoningEffortSummary> {
    vec![
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
    ]
}

pub fn curated_models() -> Vec<ModelSummary> {
    parse_models_table(
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n\
         gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n\
         gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n\
         gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n\
         claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\
         claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n",
    )
}

pub fn parse_skills_payload(value: &Value) -> Vec<SkillSummary> {
    let skills = value
        .pointer("/command/data/skills")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    skills
        .iter()
        .filter_map(|skill| {
            let name = skill.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            Some(SkillSummary {
                id: format!("agy-skill-{name}"),
                label: name.to_string(),
                alias: format!("/{name}"),
                availability: skill_availability_agy(),
                providers: vec![AgentProvider::AGY],
                source_kind: SkillSourceKind::ProviderNative,
                source_path: skill
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                description: skill
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                provider_translations: Default::default(),
            })
        })
        .collect()
}

fn skill_availability_agy() -> SkillAvailability {
    falcondeck_core::skill_availability_from_providers(&[AgentProvider::AGY])
}

pub fn hydrate_threads(workspace_path: &str) -> Vec<HydratedAgyThread> {
    let home = match env::var("HOME") {
        Ok(home) => PathBuf::from(home).join(".gemini/antigravity-cli"),
        Err(_) => return Vec::new(),
    };
    let metadata_path = home.join("cache/conversation_metadata.json");
    let last_path = home.join("cache/last_conversations.json");
    let metadata = fs::read_to_string(metadata_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let last = fs::read_to_string(last_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let Some(metadata) = metadata else {
        return Vec::new();
    };
    parse_hydrated_threads(&metadata, last.as_ref(), workspace_path)
}

pub fn parse_hydrated_threads(
    metadata: &Value,
    last_conversations: Option<&Value>,
    workspace_path: &str,
) -> Vec<HydratedAgyThread> {
    let canonical = normalize_workspace_uri(workspace_path);
    let last_id = last_conversations
        .and_then(|value| value.get(workspace_path))
        .and_then(Value::as_str)
        .or_else(|| {
            last_conversations.and_then(|value| {
                value.as_object().and_then(|map| {
                    map.iter().find_map(|(path, id)| {
                        (normalize_workspace_uri(path) == canonical).then(|| id.as_str())
                    })
                })?
            })
        });

    let mut threads = Vec::new();
    let Some(conversations) = metadata.get("conversations").and_then(Value::as_object) else {
        return threads;
    };
    for (id, entry) in conversations {
        if entry
            .get("is_internal")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let summary = entry.get("summary").unwrap_or(entry);
        let uris = summary
            .get("WorkspaceURIs")
            .or_else(|| summary.get("workspace_uris"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let matches_uri = uris.iter().any(|uri| {
            uri.as_str()
                .is_some_and(|value| normalize_workspace_uri(value) == canonical)
        });
        let matches_last = last_id == Some(id.as_str());
        if !matches_uri && !matches_last {
            continue;
        }
        let preview = summary
            .get("Preview")
            .or_else(|| summary.get("preview"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let title = summary
            .get("Title")
            .or_else(|| summary.get("title"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(preview);
        let updated_at = parse_timestamp(
            summary
                .get("UpdatedAt")
                .or_else(|| summary.get("updated_at"))
                .and_then(Value::as_str),
        )
        .or_else(|| parse_timestamp(entry.get("last_modified_time").and_then(Value::as_str)))
        .unwrap_or_else(Utc::now);
        let title_is_provider_preview = summary
            .get("Title")
            .or_else(|| summary.get("title"))
            .and_then(Value::as_str)
            .map(str::trim)
            .is_none_or(|value| value.is_empty());
        threads.push(HydratedAgyThread {
            summary: ThreadSummary {
                id: id.clone(),
                workspace_id: String::new(),
                title: if title.is_empty() {
                    "Antigravity thread".to_string()
                } else {
                    title.to_string()
                },
                provider: AgentProvider::AGY,
                native_session_id: Some(id.clone()),
                provider_transport: None,
                handoff_from: None,
                origin: None,
                status: ThreadStatus::Idle,
                updated_at,
                last_message_preview: (!preview.is_empty()).then(|| preview.to_string()),
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
                variant: None,
            },
            items: Vec::new(),
            title_is_provider_preview,
        });
    }
    threads.sort_by_key(|thread| std::cmp::Reverse(thread.summary.updated_at));
    threads
}

fn normalize_workspace_uri(value: &str) -> String {
    let trimmed = value.trim();
    let without_scheme = trimmed
        .strip_prefix("file://")
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    without_scheme.to_string()
}

fn parse_timestamp(value: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|datetime| datetime.with_timezone(&Utc))
}

/// One NDJSON event from `agy --output-format stream-json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgyStreamEvent {
    Init {
        conversation_id: String,
    },
    Step {
        conversation_id: String,
        step_index: u64,
        state: String,
        step_type: String,
        tool_name: Option<String>,
        text_delta: Option<String>,
        tool_output: Option<String>,
        tool_error: Option<String>,
        subagent_label: Option<String>,
    },
    Result {
        conversation_id: String,
        success: bool,
        response: Option<String>,
        error: Option<String>,
    },
}

pub fn parse_stream_line(line: &str) -> Option<AgyStreamEvent> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    match value.get("event").and_then(Value::as_str)? {
        "init" => Some(AgyStreamEvent::Init {
            conversation_id: value
                .get("conversation_id")
                .and_then(Value::as_str)
                .or_else(|| {
                    value
                        .pointer("/init/conversation_id")
                        .and_then(Value::as_str)
                })
                .unwrap_or_default()
                .to_string(),
        }),
        "step_update" => {
            let step = value.get("step_update")?;
            Some(AgyStreamEvent::Step {
                conversation_id: step
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                step_index: step.get("step_index").and_then(Value::as_u64).unwrap_or(0),
                state: step
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                step_type: step
                    .get("step_type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                tool_name: step
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        step.pointer("/tool_info/name")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    }),
                text_delta: step
                    .get("text_delta")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string),
                tool_output: step
                    .pointer("/tool_info/output")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                tool_error: step
                    .pointer("/tool_info/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        step.pointer("/tool_info/error")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    }),
                subagent_label: step
                    .pointer("/subagent_info/subagents/0/type_name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        }
        "result" => {
            let result = value.get("result")?;
            let status = result.get("status").and_then(Value::as_str).unwrap_or("");
            Some(AgyStreamEvent::Result {
                conversation_id: result
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                success: status.eq_ignore_ascii_case("success"),
                response: result
                    .get("response")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string),
                error: result
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string),
            })
        }
        _ => None,
    }
}

pub fn tool_step_title(step_type: &str, tool_name: Option<&str>, subagent: Option<&str>) -> String {
    if let Some(subagent) = subagent.filter(|value| !value.is_empty()) {
        return format!("Subagent ({subagent})");
    }
    if let Some(name) = tool_name.filter(|value| !value.is_empty()) {
        return name.replace('_', " ");
    }
    if step_type.is_empty() {
        "Tool".to_string()
    } else {
        step_type.replace('_', " ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutting_down_an_idle_runtime_skips_the_grace_period() {
        let runtime = AgyRuntime {
            workspace_path: "/tmp/project".to_string(),
            agy_bin: "agy".to_string(),
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
    fn models_table_splits_on_tabs_and_picks_a_medium_default() {
        let models = parse_models_table(
            "Fetching available models...\n\
             gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n\
             gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n\
             claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n",
        );
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "gemini-3.7-flash-high");
        assert_eq!(models[0].label, "Gemini 3.7 Flash (High)");
        assert!(!models[0].is_default);
        assert_eq!(
            models[1].default_reasoning_effort.as_deref(),
            Some("medium")
        );
        assert!(models[1].is_default);
        assert_eq!(models[2].id, "claude-sonnet-4-6");
        assert_eq!(models[2].supported_reasoning_efforts.len(), 3);
    }

    #[test]
    fn required_cli_flags_cover_the_embedding_surface() {
        assert!(REQUIRED_CLI_FLAGS.contains(&"--input-format"));
        assert!(REQUIRED_CLI_FLAGS.contains(&"--output-format"));
        assert!(REQUIRED_CLI_FLAGS.contains(&"--conversation"));
        assert!(REQUIRED_CLI_FLAGS.contains(&"--dangerously-skip-permissions"));
    }

    #[test]
    fn stream_input_is_a_user_event_with_content_blocks() {
        let line = build_stream_json_input("hello", &[]);
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["event"], "user");
        assert_eq!(value["message"]["content"][0]["type"], "text");
        assert_eq!(value["message"]["content"][0]["text"], "hello");
    }

    #[test]
    fn stream_parser_reads_init_step_and_result() {
        let init =
            parse_stream_line(r#"{"event":"init","conversation_id":"abc","init":{"cwd":"/tmp"}}"#)
                .unwrap();
        assert_eq!(
            init,
            AgyStreamEvent::Init {
                conversation_id: "abc".to_string()
            }
        );

        let step = parse_stream_line(
            r#"{"event":"step_update","step_update":{"conversation_id":"abc","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"pong\n"}}"#,
        )
        .unwrap();
        match step {
            AgyStreamEvent::Step {
                text_delta,
                step_type,
                ..
            } => {
                assert_eq!(step_type, "agent_response");
                assert_eq!(text_delta.as_deref(), Some("pong\n"));
            }
            other => panic!("unexpected {other:?}"),
        }

        let result = parse_stream_line(
            r#"{"event":"result","result":{"conversation_id":"abc","status":"SUCCESS","response":"pong\n"}}"#,
        )
        .unwrap();
        match result {
            AgyStreamEvent::Result {
                success, response, ..
            } => {
                assert!(success);
                assert_eq!(response.as_deref(), Some("pong\n"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn tool_steps_carry_name_and_output() {
        let step = parse_stream_line(
            r#"{"event":"step_update","step_update":{"conversation_id":"edb","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"output":"hi\n"}}}"#,
        )
        .unwrap();
        match step {
            AgyStreamEvent::Step {
                tool_name,
                tool_output,
                ..
            } => {
                assert_eq!(tool_name.as_deref(), Some("run_command"));
                assert_eq!(tool_output.as_deref(), Some("hi\n"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(
            tool_step_title("tool", Some("run_command"), None),
            "run command"
        );
    }

    #[test]
    fn hydration_scopes_conversations_to_the_workspace() {
        let metadata = serde_json::json!({
            "conversations": {
                "keep": {
                    "summary": {
                        "ID": "keep",
                        "Title": "",
                        "Preview": "Reviewing Recent Code Changes",
                        "UpdatedAt": "2026-05-20T21:04:03.935606Z",
                        "WorkspaceURIs": ["file:///Users/James/www/sites/quizgecko"]
                    },
                    "is_internal": false
                },
                "other": {
                    "summary": {
                        "ID": "other",
                        "Preview": "Somewhere else",
                        "WorkspaceURIs": ["file:///tmp/other"]
                    }
                },
                "internal": {
                    "is_internal": true,
                    "summary": {
                        "ID": "internal",
                        "Preview": "hidden",
                        "WorkspaceURIs": ["file:///Users/James/www/sites/quizgecko"]
                    }
                }
            }
        });
        let threads = parse_hydrated_threads(&metadata, None, "/Users/James/www/sites/quizgecko");
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].summary.id, "keep");
        assert_eq!(
            threads[0].summary.native_session_id.as_deref(),
            Some("keep")
        );
        assert_eq!(threads[0].summary.title, "Reviewing Recent Code Changes");
        assert!(threads[0].title_is_provider_preview);
        assert_eq!(threads[0].summary.provider, AgentProvider::AGY);
    }

    #[test]
    fn last_conversations_map_includes_unscoped_cli_threads() {
        let metadata = serde_json::json!({
            "conversations": {
                "cli": {
                    "summary": {
                        "ID": "cli",
                        "Preview": "hello",
                        "WorkspaceURIs": null,
                        "AppDataDir": "antigravity-cli"
                    }
                }
            }
        });
        let last = serde_json::json!({ "/tmp/project": "cli" });
        let threads = parse_hydrated_threads(&metadata, Some(&last), "/tmp/project");
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].summary.id, "cli");
    }

    #[test]
    fn permission_mode_maps_to_cli_flags() {
        assert!(matches!(
            permission_flags(Some("bypassPermissions")),
            PermissionFlags::DangerouslySkip
        ));
        assert!(matches!(
            permission_flags(Some("accept-edits")),
            PermissionFlags::Mode("accept-edits")
        ));
        assert!(matches!(
            permission_flags(Some("plan")),
            PermissionFlags::Mode("plan")
        ));
        assert!(matches!(
            permission_flags(Some("default")),
            PermissionFlags::Default
        ));
        assert!(sandbox_enabled(Some("sandbox")));
        assert!(!sandbox_enabled(Some("default")));
        assert_eq!(
            effort_flag(Some("gemini-3.7-flash-high"), Some("high")),
            None
        );
        assert_eq!(
            effort_flag(Some("claude-sonnet-4-6"), Some("high")),
            Some("high")
        );
    }

    #[test]
    fn skills_payload_uses_the_agy_provider() {
        let value = serde_json::json!({
            "command": {
                "name": "skills",
                "data": {
                    "skills": [{
                        "name": "antigravity-guide",
                        "description": "Guide",
                        "path": "/tmp/SKILL.md",
                        "builtin": true
                    }]
                }
            }
        });
        let skills = parse_skills_payload(&value);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].alias, "/antigravity-guide");
        assert_eq!(skills[0].providers, vec![AgentProvider::AGY]);
        assert!(skills[0].supports_provider(&AgentProvider::AGY));
        assert!(!skills[0].supports_provider(&AgentProvider::CLAUDE));
    }
}
