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
    path::PathBuf,
    process::Stdio,
    sync::Arc,
};

use crate::agent_binary::{
    missing_binary_message, preferred_command_path, resolve_agent_binary,
    strip_terminal_advertising_env,
};
use crate::app::agent_helpers::attachment_reference_text;
use crate::error::DaemonError;
use chrono::{DateTime, Utc};
use falcondeck_core::{
    AccountStatus, AccountSummary, AgentCapabilitySummary, AgentProvider, ImageInput, ModelSummary,
    ReasoningEffortSummary, SkillSummary, ThreadAgentParams, ThreadAttention, ThreadStatus,
    ThreadSummary,
};
use serde_json::{Value, json};
use tokio::{
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::Mutex,
};

const INTERRUPT_GRACE: tokio::time::Duration = tokio::time::Duration::from_secs(5);
const EXIT_GRACE: tokio::time::Duration = tokio::time::Duration::from_secs(10);
const WRITE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(10);
/// Maximum time a daemon shutdown gives an active Antigravity turn to finish
/// after SIGTERM. This is a ceiling, not a required delay.
const SHUTDOWN_GRACE: tokio::time::Duration = tokio::time::Duration::from_millis(500);
const SHUTDOWN_POLL_INTERVAL: tokio::time::Duration = tokio::time::Duration::from_millis(50);
/// Headless default is five minutes, which is too short for a coding turn.
const PRINT_TIMEOUT: &str = "24h";

/// Command-line flags a native turn depends on.
///
/// Keep this in step with `spawn_turn`. A CLI that drops `--effort` or `--conversation` does not
/// necessarily fail: the flag is ignored and resume or reasoning silently
/// stops applying. `harness_conformance` checks the installed binary still
/// advertises every one.
pub const REQUIRED_CLI_FLAGS: &[&str] = &[
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
    #[cfg(test)]
    test_auth_inputs: std::sync::Mutex<Option<(PathBuf, PathBuf, HashMap<String, String>)>>,
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
            #[cfg(test)]
            test_auth_inputs: std::sync::Mutex::new(None),
        });

        let executable = resolved.executable.clone();
        let hydrate_path = workspace_path.clone();
        let ((account, models, skills), threads) =
            tokio::join!(provider_probes(&executable), async {
                tokio::task::spawn_blocking(move || hydrate_threads(&hydrate_path))
                    .await
                    .unwrap_or_default()
            });
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

    #[cfg(test)]
    pub(crate) fn set_auth_inputs_for_test(
        &self,
        token: PathBuf,
        settings: PathBuf,
        environment: HashMap<String, String>,
    ) {
        *self.test_auth_inputs.lock().unwrap() = Some((token, settings, environment));
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
        let permitted = read_auth_status(&self.agy_bin).await.status == AccountStatus::Ready;
        #[cfg(test)]
        let permitted = self
            .test_auth_inputs
            .lock()
            .unwrap()
            .as_ref()
            .map(|(token, settings, environment)| {
                auth_status_from_inputs(token, settings, |key| environment.get(key).cloned()).status
                    == AccountStatus::Ready
            })
            .unwrap_or(permitted);
        if !permitted {
            return Err(DaemonError::BadRequest(AUTH_SETUP_MESSAGE.into()));
        }
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
        configure_headless(&mut command);
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
        // Read credentials afresh so sign-in and sign-out are visible immediately.
        let (account, models, skills) = provider_probes(&self.agy_bin).await;
        AgyProviderMetadata {
            account,
            models,
            skills,
            capabilities: default_capabilities(),
        }
    }
}

// No process or credential cache: every status read reflects the current HOME
// and sign-out immediately. Catalogs are local fallback data.
async fn provider_probes(
    executable: &str,
) -> (AccountSummary, Vec<ModelSummary>, Vec<SkillSummary>) {
    (
        read_auth_status(executable).await,
        curated_models(),
        Vec::new(),
    )
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
            "text": attachment_reference_text(image)
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

pub(crate) fn oauth_path() -> Option<PathBuf> {
    Some(
        PathBuf::from(env::var_os("HOME")?).join(".gemini/antigravity-cli/antigravity-oauth-token"),
    )
}

pub(crate) fn credential_account(raw: &str) -> AccountSummary {
    let ready = serde_json::from_str::<Value>(raw)
        .ok()
        .is_some_and(|value| {
            let token = &value["token"];
            token["access_token"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
                && (token["refresh_token"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty())
                    || token["expiry"]
                        .as_str()
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                        .is_some_and(|expiry| expiry > Utc::now()))
        });
    AccountSummary {
        status: if ready {
            AccountStatus::Ready
        } else {
            AccountStatus::Unknown
        },
        label: if ready {
            "Antigravity credentials available"
        } else {
            "Antigravity sign-in may be needed; configure saved credentials or environment authentication."
        }
        .to_string(),
    }
}

pub(crate) const AUTH_SETUP_MESSAGE: &str = "Antigravity cannot start safely without configured authentication. Run `agy` in a terminal to save a token, or set GEMINI_API_KEY and modelProvider=\"gemini\" in ~/.gemini/antigravity-cli/settings.json, or set AGY_ADC_AUTH=true with GOOGLE_APPLICATION_CREDENTIALS. Keyring-only sign-in is unsupported.";

/// The shared admission policy. Paths and environment are explicit so tests
/// exercise the production rules without changing HOME or using real secrets.
pub(crate) fn auth_status_from_inputs(
    token_path: &std::path::Path,
    settings_path: &std::path::Path,
    mut get_env: impl FnMut(&str) -> Option<String>,
) -> AccountSummary {
    let raw = fs::read_to_string(token_path).unwrap_or_default();
    let token = credential_account(&raw);
    if token.status == AccountStatus::Ready {
        return token;
    }
    let adc = get_env("AGY_ADC_AUTH").as_deref() == Some("true")
        && get_env("GOOGLE_APPLICATION_CREDENTIALS").is_some_and(|value| !value.trim().is_empty());
    let gemini = get_env("GEMINI_API_KEY").is_some_and(|value| !value.trim().is_empty())
        && fs::read_to_string(settings_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .is_some_and(|settings| {
                settings.get("modelProvider").and_then(Value::as_str) == Some("gemini")
            });
    if adc || gemini {
        return AccountSummary {
            status: AccountStatus::Ready,
            label: "Antigravity authentication configured".into(),
        };
    }
    AccountSummary {
        status: AccountStatus::Unknown,
        label: format!("Sign-in may be needed. {AUTH_SETUP_MESSAGE}"),
    }
}

pub async fn read_auth_status(_agy_bin: &str) -> AccountSummary {
    // Unit/integration tests must opt in to explicit fixture inputs rather
    // than admitting a process from the developer's HOME or environment.
    if crate::agent_binary::provider_test_mode() {
        return credential_account("");
    }
    let Some(token_path) = oauth_path() else {
        return credential_account("");
    };
    let settings_path = token_path.with_file_name("settings.json");
    auth_status_from_inputs(&token_path, &settings_path, |key| env::var(key).ok())
}

/// Request headless behavior and detach the CLI from the controlling terminal.
/// These settings alone do not prevent browser OAuth; turn admission still
/// requires saved/environment credentials, and metadata never spawns the CLI.
pub(crate) fn configure_headless(command: &mut Command) {
    command.env("AGY_CLI_NONINTERACTIVE_HEADLESS", "1");
    // Piped stdio alone still inherits the daemon's controlling terminal.
    // The documented non-interactive auth behavior requires no terminal.
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
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
        "gemini-3.8-flash-medium",
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
    // https://antigravity.google/docs/models/ (2026-11-06).
    parse_models_table(
        "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\
         gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n\
         gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\
         gemini-4-argon-high\tGemini 4 Argon (High)\n\
         gemini-4-argon-medium\tGemini 4 Argon (Medium)\n\
         gemini-4-argon-low\tGemini 4 Argon (Low)\n\
         claude-sonnet-5-5\tClaude Sonnet 5.5 (Thinking)\n\
         claude-opus-5-5\tClaude Opus 5.5 (Thinking)\n\
         gpt-oss-120b-maas\tGPT-OSS 120B (Medium)\n\
         gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n\
         gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n\
         gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n\
         gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n\
         claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\
         claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n",
    )
}

pub(crate) fn authentication_required(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "authentication required",
        "not authenticated",
        "unauthenticated",
        "please sign in",
        "login required",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

pub(crate) fn login_required_account() -> AccountSummary {
    AccountSummary {
        status: AccountStatus::NeedsAuth,
        label: "Antigravity login required. Run `agy` in a terminal to sign in.".into(),
    }
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
                execution_target: Default::default(),
                cloud: None,
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
                last_message_at: None,
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
                    .or_else(|| step.get("text"))
                    .or_else(|| step.get("delta"))
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
                    .and_then(|value| {
                        value.as_str().map(str::to_string).or_else(|| {
                            value
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                    })
                    .filter(|text| !text.is_empty()),
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

    #[test]
    fn admission_matches_cli_authentication_modes_using_explicit_inputs() {
        let temp = tempfile::tempdir().unwrap();
        let token = temp.path().join("token");
        let settings = temp.path().join("settings.json");
        let status = |values: &[(&str, &str)]| {
            auth_status_from_inputs(&token, &settings, |key| {
                values
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value.to_string())
            })
            .status
        };
        assert_eq!(status(&[]), AccountStatus::Unknown);
        assert_eq!(
            status(&[("GOOGLE_API_KEY", "ignored")]),
            AccountStatus::Unknown
        );
        assert_eq!(
            status(&[("GEMINI_API_KEY", "fixture")]),
            AccountStatus::Unknown
        );
        fs::write(&settings, "malformed").unwrap();
        assert_eq!(
            status(&[("GEMINI_API_KEY", "fixture")]),
            AccountStatus::Unknown
        );
        fs::write(&settings, r#"{"modelProvider":"other"}"#).unwrap();
        assert_eq!(
            status(&[("GEMINI_API_KEY", "fixture")]),
            AccountStatus::Unknown
        );
        fs::write(&settings, r#"{"modelProvider":"gemini"}"#).unwrap();
        assert_eq!(
            status(&[("GOOGLE_API_KEY", "ignored")]),
            AccountStatus::Unknown
        );
        assert_eq!(status(&[("GEMINI_API_KEY", " ")]), AccountStatus::Unknown);
        assert_eq!(
            status(&[("GEMINI_API_KEY", "fixture")]),
            AccountStatus::Ready
        );
        fs::remove_file(&settings).unwrap();
        fs::create_dir(&settings).unwrap(); // A settings read error must fail closed.
        assert_eq!(
            status(&[("GEMINI_API_KEY", "fixture")]),
            AccountStatus::Unknown
        );
        assert_eq!(
            status(&[("GOOGLE_APPLICATION_CREDENTIALS", "/fixture/adc.json")]),
            AccountStatus::Unknown
        );
        assert_eq!(status(&[("AGY_ADC_AUTH", "true")]), AccountStatus::Unknown);
        assert_eq!(
            status(&[
                ("AGY_ADC_AUTH", "1"),
                ("GOOGLE_APPLICATION_CREDENTIALS", "/fixture/adc.json")
            ]),
            AccountStatus::Unknown
        );
        assert_eq!(
            status(&[
                ("AGY_ADC_AUTH", "true"),
                ("GOOGLE_APPLICATION_CREDENTIALS", "/fixture/adc.json")
            ]),
            AccountStatus::Ready
        );
        fs::write(&token, "malformed").unwrap();
        assert_eq!(status(&[]), AccountStatus::Unknown);
        fs::write(
            &token,
            r#"{"token":{"access_token":"fixture","expiry":"2000-01-01T00:00:00Z"}}"#,
        )
        .unwrap();
        assert_eq!(status(&[]), AccountStatus::Unknown);
        fs::write(&token, r#"{"token":{"access_token":"fixture","refresh_token":"fixture","expiry":"2000-01-01T00:00:00Z"}}"#).unwrap();
        assert_eq!(status(&[]), AccountStatus::Ready);
        fs::write(&token, json!({"token":{"access_token":"fixture", "expiry":(Utc::now()+chrono::Duration::hours(1)).to_rfc3339()}}).to_string()).unwrap();
        assert_eq!(status(&[]), AccountStatus::Ready);
    }

    #[test]
    fn curated_catalog_keeps_supported_models_and_an_available_default() {
        let models = curated_models();
        for id in [
            "gemini-3.8-flash-medium",
            "gemini-3.7-flash-medium",
            "gemini-3.1-pro-high",
            "claude-sonnet-4-6",
            "claude-opus-4-6-thinking",
            "claude-sonnet-5-5",
        ] {
            assert!(models.iter().any(|model| model.id == id));
        }
        assert_eq!(models.iter().filter(|model| model.is_default).count(), 1);
        assert!(
            models
                .iter()
                .any(|model| model.id == "gemini-3.8-flash-medium" && model.is_default)
        );
    }

    #[test]
    fn reports_only_cli_confirmed_authentication_failures_as_login_required() {
        assert!(authentication_required("Authentication required"));
        assert!(!authentication_required("model quota exhausted"));
        assert_eq!(login_required_account().status, AccountStatus::NeedsAuth);
        assert!(
            curated_models()
                .iter()
                .any(|m| m.id == "gemini-3.8-flash-medium" && m.is_default)
        );
    }

    #[test]
    fn credential_presence_uses_cli_token_envelope() {
        for raw in [
            "",
            "{}",
            r#"{"access_token":"old-gemini-format"}"#,
            r#"{"token":{"access_token":"fake","expiry":"2000-01-01T00:00:00Z"}}"#,
        ] {
            assert_eq!(credential_account(raw).status, AccountStatus::Unknown);
        }
        let raw = r#"{"token":{"access_token":"fake","refresh_token":"fake"}}"#;
        assert_eq!(credential_account(raw).status, AccountStatus::Ready);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn metadata_and_unconfigured_turn_never_start_cli_or_browser() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("calls");
        let binary = temp.path().join("agy");
        let open = temp.path().join("open");
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nread -r line\n",
            marker.display()
        );
        for path in [&binary, &open] {
            fs::write(path, &script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let boot = AgyRuntime::connect(
            temp.path().to_string_lossy().into_owned(),
            binary.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        for _ in 0..10 {
            let metadata = boot.runtime.provider_metadata().await;
            assert_eq!(metadata.account.status, AccountStatus::Unknown);
            assert!(!metadata.models.is_empty());
        }
        assert!(!marker.exists(), "metadata executed the CLI");
        let refused = boot
            .runtime
            .spawn_turn(
                "refused",
                None,
                "fixture",
                &[],
                None,
                None,
                None,
                None,
                temp.path().to_str().unwrap(),
            )
            .await;
        assert!(
            matches!(refused, Err(DaemonError::BadRequest(message)) if message.contains("GEMINI_API_KEY"))
        );
        assert!(!marker.exists());
        let token = temp.path().join("fixture-token");
        let settings = temp.path().join("settings.json");
        boot.runtime
            .set_auth_inputs_for_test(token.clone(), settings, HashMap::new());
        fs::write(
            &token,
            r#"{"token":{"access_token":"fixture","refresh_token":"fixture"}}"#,
        )
        .unwrap();
        let spawned = boot
            .runtime
            .spawn_turn(
                "test",
                None,
                "hello",
                &[],
                Some("stored-unlisted-model"),
                None,
                None,
                None,
                temp.path().to_str().unwrap(),
            )
            .await;
        // Only an explicitly permitted test stub may bypass turn admission.
        assert!(spawned.is_ok());
        boot.runtime
            .finish_turn("test", spawned.unwrap().generation)
            .await
            .unwrap();
        assert!(
            fs::read_to_string(marker)
                .unwrap()
                .contains("stored-unlisted-model")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn headless_child_receives_auth_guard() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("arguments");
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "if (: </dev/tty) 2>/dev/null; then exit 1; fi; test \"$AGY_CLI_NONINTERACTIVE_HEADLESS\" = 1 && printf '%s' \"$*\" > \"$1\"",
            "stub-agy",
            marker.to_str().unwrap(),
            "--input-format",
            "stream-json",
        ]);
        configure_headless(&mut command);
        assert!(command.status().await.unwrap().success());
        assert!(
            fs::read_to_string(marker)
                .unwrap()
                .contains("--input-format stream-json")
        );
    }

    #[tokio::test]
    async fn shutting_down_an_idle_runtime_skips_the_grace_period() {
        let runtime = AgyRuntime {
            workspace_path: "/tmp/project".to_string(),
            agy_bin: "agy".to_string(),
            active_turns: Mutex::new(HashMap::new()),
            interrupted_turns: Mutex::new(HashSet::new()),
            turn_locks: Mutex::new(HashMap::new()),
            next_turn_generation: std::sync::atomic::AtomicU64::new(1),
            #[cfg(test)]
            test_auth_inputs: std::sync::Mutex::new(None),
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

        let completed = parse_stream_line(
            r#"{"event":"step_update","step_update":{"conversation_id":"abc","step_index":3,"state":"DONE","step_type":"agent_response","text":"done\n"}}"#,
        )
        .unwrap();
        match completed {
            AgyStreamEvent::Step { text_delta, .. } => {
                assert_eq!(text_delta.as_deref(), Some("done\n"));
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
}
