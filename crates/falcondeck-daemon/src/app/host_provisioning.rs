//! One-click provisioning of a remote `falcondeck-daemon` over SSH.
//!
//! The desktop picks an SSH host, and this module installs the prebuilt Linux
//! binary, writes a `systemd --user` unit, starts it, and mints a relay
//! pairing code so the new daemon can be adopted like any other machine.
//!
//! Every remote step runs as a single non-interactive `ssh` invocation with
//! `BatchMode=yes`: provisioning must never block waiting for a password or a
//! host-key prompt, so an unconfigured host fails fast with a clear message
//! instead of hanging the job.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use falcondeck_core::DEFAULT_DAEMON_PORT;
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::time::{Duration, sleep};
use uuid::Uuid;

use super::AppState;
use super::remote_bridge::normalize_relay_url;
use crate::error::DaemonError;

/// Port the provisioned daemon listens on, matching the local default.
const REMOTE_DAEMON_PORT: u16 = DEFAULT_DAEMON_PORT;
/// Name of the `systemd --user` unit written on the remote host.
const UNIT_NAME: &str = "falcondeck-daemon";
/// Seconds `ssh` waits for the TCP connection before giving up.
const SSH_CONNECT_TIMEOUT_SECS: u32 = 10;
/// Attempts made while waiting for the freshly started daemon to answer.
const HEALTH_ATTEMPTS: usize = 6;
/// Delay between health-check attempts (6 x 2s covers the ~10s budget).
const HEALTH_RETRY_DELAY: Duration = Duration::from_secs(2);
/// Finished jobs retained for status polling before the oldest are dropped.
const MAX_JOBS: usize = 32;
/// Upper bound on log lines kept per job.
const MAX_LOG_ENTRIES: usize = 200;
/// Upper bound on characters kept per log line.
const MAX_LOG_ENTRY_CHARS: usize = 4000;

/// Request body for `POST /api/hosts/provision`.
#[derive(Debug, Clone, Deserialize)]
pub struct ProvisionHostRequest {
    /// SSH alias or `user@host` to provision.
    pub ssh_target: String,
    /// Display name for the host; defaults to the SSH target.
    #[serde(default)]
    pub name: Option<String>,
    /// Relay the provisioned daemon should pair against.
    pub relay_url: String,
    /// Optional SSH port override.
    #[serde(default)]
    pub port: Option<u16>,
}

/// Response body for `POST /api/hosts/provision`.
#[derive(Debug, Clone, Serialize)]
pub struct StartProvisionResponse {
    /// Identifier used to poll provisioning progress.
    pub job_id: String,
}

/// Lifecycle state of a provisioning job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvisionStatus {
    /// Work is still in flight.
    Running,
    /// The daemon is installed, running, and has a pairing code.
    Completed,
    /// A step failed; `error` explains what.
    Failed,
}

/// Coarse progress marker shown in the UI while a job runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvisionStage {
    /// Verifying that SSH works without prompting.
    Connecting,
    /// Downloading and installing the daemon binary.
    Installing,
    /// Writing the systemd unit and waiting for the daemon to answer.
    Starting,
    /// Requesting a relay pairing code from the remote daemon.
    Pairing,
    /// All steps finished.
    Done,
}

/// Provisioning job state, also used verbatim as the status response body.
#[derive(Debug, Clone, Serialize)]
pub struct ProvisionJob {
    /// Job identifier.
    pub job_id: String,
    /// Display name supplied by the caller.
    pub name: String,
    /// SSH target being provisioned.
    pub ssh_target: String,
    /// Current lifecycle state.
    pub status: ProvisionStatus,
    /// Current progress marker.
    pub stage: ProvisionStage,
    /// Human-readable progress lines, including remote command output.
    pub log: Vec<String>,
    /// Pairing code minted by the remote daemon once provisioning completes.
    pub pairing_code: Option<String>,
    /// Relay the remote daemon was pointed at.
    pub relay_url: String,
    /// Failure reason when `status` is `failed`.
    pub error: Option<String>,
    /// Creation time, used to evict the oldest finished jobs.
    #[serde(skip)]
    created_at: DateTime<Utc>,
}

/// Action requested by `POST /api/hosts/command`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostAction {
    /// Restart the remote unit.
    Restart,
    /// Stop the remote unit.
    Stop,
    /// Remove the unit and binary, keeping `~/.falcondeck` state.
    Uninstall,
    /// Mint a fresh pairing code from the remote daemon.
    Pair,
}

/// Request body for `POST /api/hosts/command`.
#[derive(Debug, Clone, Deserialize)]
pub struct HostCommandRequest {
    /// SSH alias or `user@host` to act on.
    pub ssh_target: String,
    /// Optional SSH port override.
    #[serde(default)]
    pub port: Option<u16>,
    /// Action to perform.
    pub action: HostAction,
    /// Relay used by the `pair` action; required for that action only.
    #[serde(default)]
    pub relay_url: Option<String>,
}

/// Response body for `POST /api/hosts/command`.
#[derive(Debug, Clone, Serialize)]
pub struct HostCommandResponse {
    /// Always true; failures are returned as an error status instead.
    pub ok: bool,
    /// Pairing code, for the `pair` action.
    pub pairing_code: Option<String>,
    /// Combined remote output, useful for surfacing systemd messages.
    pub output: String,
}

impl AppState {
    /// Starts provisioning in the background and returns the job id to poll.
    pub async fn start_host_provision(
        &self,
        request: ProvisionHostRequest,
    ) -> Result<StartProvisionResponse, DaemonError> {
        let target = validate_ssh_target(&request.ssh_target)?;
        let relay_url = normalize_relay_url(&request.relay_url)?;
        validate_shell_safe_url(&relay_url)?;
        let name = request
            .name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| target.clone());

        let job_id = Uuid::new_v4().to_string();
        let job = ProvisionJob {
            job_id: job_id.clone(),
            name,
            ssh_target: target.clone(),
            status: ProvisionStatus::Running,
            stage: ProvisionStage::Connecting,
            log: Vec::new(),
            pairing_code: None,
            relay_url: relay_url.clone(),
            error: None,
            created_at: Utc::now(),
        };
        {
            let mut jobs = self.inner.provision_jobs.lock().await;
            prune_finished_jobs(&mut jobs);
            jobs.insert(job_id.clone(), job);
        }

        let app = self.clone();
        let background_job_id = job_id.clone();
        tokio::spawn(async move {
            let port = request.port;
            match provision_host(&app, &background_job_id, &target, port, &relay_url).await {
                Ok(pairing_code) => {
                    app.finish_provision_job(&background_job_id, Some(pairing_code), None)
                        .await;
                }
                Err(error) => {
                    let message = error.to_string();
                    tracing::warn!("provisioning {target} failed: {message}");
                    app.finish_provision_job(&background_job_id, None, Some(message))
                        .await;
                }
            }
        });

        Ok(StartProvisionResponse { job_id })
    }

    /// Returns the current state of a provisioning job.
    pub async fn host_provision_job(&self, job_id: &str) -> Result<ProvisionJob, DaemonError> {
        self.inner
            .provision_jobs
            .lock()
            .await
            .get(job_id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound(format!("unknown provisioning job: {job_id}")))
    }

    /// Runs a lifecycle action against an already-provisioned host.
    pub async fn run_host_command(
        &self,
        request: HostCommandRequest,
    ) -> Result<HostCommandResponse, DaemonError> {
        let target = validate_ssh_target(&request.ssh_target)?;
        let port = request.port;

        if request.action == HostAction::Pair {
            let relay_url = request.relay_url.as_deref().ok_or_else(|| {
                DaemonError::BadRequest("relay_url is required for the pair action".to_string())
            })?;
            let relay_url = normalize_relay_url(relay_url)?;
            validate_shell_safe_url(&relay_url)?;
            let (pairing_code, output) = request_pairing_code(&target, port, &relay_url).await?;
            return Ok(HostCommandResponse {
                ok: true,
                pairing_code: Some(pairing_code),
                output,
            });
        }

        let script = match request.action {
            HostAction::Restart => systemd_script(&format!("systemctl --user restart {UNIT_NAME}")),
            HostAction::Stop => systemd_script(&format!("systemctl --user stop {UNIT_NAME}")),
            HostAction::Uninstall => uninstall_script(),
            HostAction::Pair => unreachable!("handled above"),
        };

        let result = ssh_exec(&target, port, &script).await?;
        if !result.success {
            return Err(DaemonError::Process(format!(
                "remote command failed on {target}: {}",
                result.failure_detail()
            )));
        }

        Ok(HostCommandResponse {
            ok: true,
            pairing_code: None,
            output: result.combined_output(),
        })
    }

    async fn append_provision_log(&self, job_id: &str, line: impl Into<String>) {
        let line = truncate(&line.into(), MAX_LOG_ENTRY_CHARS);
        tracing::debug!("provision {job_id}: {line}");
        let mut jobs = self.inner.provision_jobs.lock().await;
        if let Some(job) = jobs.get_mut(job_id) {
            if job.log.len() >= MAX_LOG_ENTRIES {
                job.log.remove(0);
            }
            job.log.push(line);
        }
    }

    async fn set_provision_stage(&self, job_id: &str, stage: ProvisionStage) {
        let mut jobs = self.inner.provision_jobs.lock().await;
        if let Some(job) = jobs.get_mut(job_id) {
            job.stage = stage;
        }
    }

    async fn finish_provision_job(
        &self,
        job_id: &str,
        pairing_code: Option<String>,
        error: Option<String>,
    ) {
        let mut jobs = self.inner.provision_jobs.lock().await;
        let Some(job) = jobs.get_mut(job_id) else {
            return;
        };
        match error {
            Some(error) => {
                job.status = ProvisionStatus::Failed;
                if job.log.len() < MAX_LOG_ENTRIES {
                    job.log.push(truncate(&error, MAX_LOG_ENTRY_CHARS));
                }
                job.error = Some(error);
            }
            None => {
                job.status = ProvisionStatus::Completed;
                job.stage = ProvisionStage::Done;
                job.pairing_code = pairing_code;
                job.log.push("provisioning complete".to_string());
            }
        }
    }
}

/// Drops the oldest finished jobs once the retention cap is reached.
fn prune_finished_jobs(jobs: &mut HashMap<String, ProvisionJob>) {
    while jobs.len() >= MAX_JOBS {
        let oldest = jobs
            .values()
            .filter(|job| job.status != ProvisionStatus::Running)
            .min_by_key(|job| job.created_at)
            .map(|job| job.job_id.clone());
        match oldest {
            Some(job_id) => {
                jobs.remove(&job_id);
            }
            // Everything still running: keep them and let the map grow rather
            // than dropping a job someone is polling.
            None => break,
        }
    }
}

/// Runs the four provisioning stages, returning the pairing code on success.
async fn provision_host(
    app: &AppState,
    job_id: &str,
    target: &str,
    port: Option<u16>,
    relay_url: &str,
) -> Result<String, DaemonError> {
    app.set_provision_stage(job_id, ProvisionStage::Connecting)
        .await;
    app.append_provision_log(job_id, format!("connecting to {target} over ssh"))
        .await;
    let probe = ssh_exec(target, port, "echo falcondeck-ok").await?;
    if !probe.success || !probe.stdout.contains("falcondeck-ok") {
        return Err(DaemonError::Process(format!(
            "could not reach {target} over ssh: {}. \
             Provisioning uses BatchMode=yes, so the host must accept key-based login \
             without a password or host-key prompt (try `ssh {target}` once by hand first).",
            probe.failure_detail()
        )));
    }
    app.append_provision_log(job_id, "ssh connection ok").await;

    app.set_provision_stage(job_id, ProvisionStage::Installing)
        .await;
    install_daemon_binary(app, job_id, target, port, relay_url).await?;

    app.set_provision_stage(job_id, ProvisionStage::Starting)
        .await;
    start_daemon_service(app, job_id, target, port).await?;

    app.set_provision_stage(job_id, ProvisionStage::Pairing)
        .await;
    app.append_provision_log(job_id, "requesting pairing code from the remote daemon")
        .await;
    let (pairing_code, _) = request_pairing_code(target, port, relay_url).await?;
    app.append_provision_log(job_id, "pairing code issued")
        .await;
    Ok(pairing_code)
}

/// Downloads the prebuilt Linux binary for the host's architecture.
///
/// An install that fails while a working binary is already present is not
/// fatal: the host keeps running the version it has and provisioning
/// continues, since a failed *update* should not take a working server down.
async fn install_daemon_binary(
    app: &AppState,
    job_id: &str,
    target: &str,
    port: Option<u16>,
    relay_url: &str,
) -> Result<(), DaemonError> {
    let arch_result = ssh_exec(target, port, "uname -m").await?;
    if !arch_result.success {
        return Err(DaemonError::Process(format!(
            "could not determine remote architecture: {}",
            arch_result.failure_detail()
        )));
    }
    let arch = arch_result.stdout.trim().to_string();
    if arch.is_empty() || !arch.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(DaemonError::Process(format!(
            "unexpected remote architecture from `uname -m`: {arch:?}"
        )));
    }
    app.append_provision_log(job_id, format!("remote architecture: {arch}"))
        .await;

    let has_existing_binary = ssh_exec(
        target,
        port,
        "test -x \"$HOME/.local/bin/falcondeck-daemon\"",
    )
    .await?
    .success;

    let download_url = daemon_binary_url(relay_url, &arch);
    app.append_provision_log(job_id, format!("downloading {download_url}"))
        .await;
    let install = ssh_exec(target, port, &install_script(&download_url)).await?;
    if install.success {
        app.append_provision_log(
            job_id,
            "daemon binary installed at ~/.local/bin/falcondeck-daemon",
        )
        .await;
        return Ok(());
    }

    if has_existing_binary {
        app.append_provision_log(
            job_id,
            format!(
                "download failed ({}); continuing with the binary already installed on the host",
                install.failure_detail()
            ),
        )
        .await;
        return Ok(());
    }

    if install.mentions_http_not_found() {
        return Err(DaemonError::Process(format!(
            "no prebuilt daemon binary for {arch}; build one on the server or update the relay dist"
        )));
    }
    Err(DaemonError::Process(format!(
        "failed to install the daemon binary: {}",
        install.failure_detail()
    )))
}

/// Writes the systemd unit, starts it, and waits for the daemon to answer.
async fn start_daemon_service(
    app: &AppState,
    job_id: &str,
    target: &str,
    port: Option<u16>,
) -> Result<(), DaemonError> {
    app.append_provision_log(job_id, "installing systemd --user unit")
        .await;
    let mut start = ssh_exec(target, port, &start_service_script()).await?;

    if !start.success && start.mentions_missing_bus() {
        // No lingering session for this user, so the user systemd instance is
        // not running outside a login. Enabling linger fixes it permanently.
        app.append_provision_log(
            job_id,
            "systemd user bus unavailable; enabling linger for the SSH user",
        )
        .await;
        let linger = ssh_exec(target, port, LINGER_SCRIPT).await?;
        if !linger.success {
            return Err(DaemonError::Process(format!(
                "the remote user has no systemd session and enabling linger failed: {}. \
                 Run `sudo loginctl enable-linger <user>` on {target} and retry.",
                linger.failure_detail()
            )));
        }
        start = ssh_exec(target, port, &start_service_script()).await?;
    }

    if !start.success {
        return Err(DaemonError::Process(format!(
            "failed to start {UNIT_NAME}.service on {target}: {}",
            start.failure_detail()
        )));
    }
    app.append_provision_log(job_id, format!("{UNIT_NAME}.service enabled and started"))
        .await;

    for attempt in 1..=HEALTH_ATTEMPTS {
        let health = ssh_exec(target, port, &health_check_script()).await?;
        if health.stdout.trim_start().starts_with('{') {
            app.append_provision_log(job_id, "remote daemon is answering on 127.0.0.1:4123")
                .await;
            return Ok(());
        }
        if attempt < HEALTH_ATTEMPTS {
            app.append_provision_log(
                job_id,
                format!("waiting for the daemon to answer (attempt {attempt}/{HEALTH_ATTEMPTS})"),
            )
            .await;
            sleep(HEALTH_RETRY_DELAY).await;
        }
    }

    // The unit started but never served a request: the journal is the only
    // place that says why, so pull it into the job log before failing.
    if let Ok(journal) = ssh_exec(target, port, &journal_script()).await {
        app.append_provision_log(job_id, format!("journal: {}", journal.combined_output()))
            .await;
    }
    Err(DaemonError::Process(format!(
        "{UNIT_NAME}.service started on {target} but the daemon never answered on \
         127.0.0.1:{REMOTE_DAEMON_PORT}; check `journalctl --user -u {UNIT_NAME}` on the host"
    )))
}

/// Asks the remote daemon for a relay pairing code.
///
/// This always mints a fresh pairing, including for a host that is already
/// paired, which is what adopting the machine on an additional device needs.
async fn request_pairing_code(
    target: &str,
    port: Option<u16>,
    relay_url: &str,
) -> Result<(String, String), DaemonError> {
    let result = ssh_exec(target, port, &pairing_script(relay_url)).await?;
    if !result.success {
        return Err(DaemonError::Process(format!(
            "failed to start pairing on {target}: {}",
            result.failure_detail()
        )));
    }
    let code = extract_pairing_code(&result.stdout)?;
    Ok((code, result.stdout))
}

/// Pulls `pairing.pairing_code` out of a `/api/remote/pairing` response.
fn extract_pairing_code(body: &str) -> Result<String, DaemonError> {
    let parsed: serde_json::Value = serde_json::from_str(body.trim()).map_err(|error| {
        DaemonError::Process(format!(
            "remote daemon returned a non-JSON pairing response ({error}): {}",
            truncate(body, 400)
        ))
    })?;
    parsed
        .get("pairing")
        .and_then(|pairing| pairing.get("pairing_code"))
        .or_else(|| parsed.get("pairing_code"))
        .and_then(serde_json::Value::as_str)
        .filter(|code| !code.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            DaemonError::Process(format!(
                "remote daemon did not return a pairing code: {}",
                truncate(body, 400)
            ))
        })
}

/// URL of the prebuilt Linux daemon binary hosted by the relay.
fn daemon_binary_url(relay_url: &str, arch: &str) -> String {
    format!("{relay_url}/dist/falcondeck-daemon-{arch}-linux")
}

fn install_script(download_url: &str) -> String {
    let url = shell_quote(download_url);
    format!(
        r#"set -eu
mkdir -p "$HOME/.local/bin"
tmp="$HOME/.local/bin/falcondeck-daemon.tmp"
if ! curl -fL --max-time 300 -o "$tmp" {url}; then
  rm -f "$tmp"
  exit 1
fi
chmod +x "$tmp"
mv -f "$tmp" "$HOME/.local/bin/falcondeck-daemon"
"#
    )
}

/// Prefix that makes `systemctl --user` work over a non-login SSH session,
/// where `XDG_RUNTIME_DIR` and the DBus address are often unset.
const SYSTEMD_USER_ENV: &str = r#"export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
"#;

const LINGER_SCRIPT: &str = r#"set -eu
user="$(id -un)"
loginctl enable-linger "$user" || sudo -n loginctl enable-linger "$user"
"#;

fn systemd_script(command: &str) -> String {
    format!("set -eu\n{SYSTEMD_USER_ENV}{command}\n")
}

fn start_service_script() -> String {
    // The heredoc delimiter is quoted so systemd's own `%h` specifiers reach
    // the unit file untouched by the shell.
    format!(
        r#"set -eu
{SYSTEMD_USER_ENV}mkdir -p "$HOME/.config/systemd/user" "$HOME/.falcondeck"
cat > "$HOME/.config/systemd/user/{UNIT_NAME}.service" <<'FALCONDECK_UNIT'
[Unit]
Description=FalconDeck daemon
After=network-online.target

[Service]
Type=simple
Environment=FALCONDECK_STATE_PATH=%h/.falcondeck/daemon-state.json
Environment=FALCONDECK_SECRET_FILE=%h/.falcondeck/secrets.json
Environment=PATH=%h/.local/bin:%h/.local/npm-global/bin:/usr/local/bin:/usr/bin:/bin
Environment=RUST_LOG=falcondeck_daemon=info
ExecStart=%h/.local/bin/falcondeck-daemon --port={REMOTE_DAEMON_PORT}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
FALCONDECK_UNIT
systemctl --user daemon-reload
systemctl --user enable {UNIT_NAME}
systemctl --user restart {UNIT_NAME}
"#
    )
}

fn uninstall_script() -> String {
    format!(
        r#"set -u
{SYSTEMD_USER_ENV}systemctl --user disable --now {UNIT_NAME} 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/{UNIT_NAME}.service"
systemctl --user daemon-reload 2>/dev/null || true
rm -f "$HOME/.local/bin/falcondeck-daemon"
echo "removed the {UNIT_NAME} unit and binary; ~/.falcondeck state was kept"
"#
    )
}

fn health_check_script() -> String {
    format!("curl -s --max-time 3 http://127.0.0.1:{REMOTE_DAEMON_PORT}/api/snapshot | head -c 400")
}

fn journal_script() -> String {
    format!("journalctl --user -u {UNIT_NAME} -n 30 --no-pager 2>&1 | tail -c 2000 || true")
}

fn pairing_script(relay_url: &str) -> String {
    let body = shell_quote(&serde_json::json!({ "relay_url": relay_url }).to_string());
    format!(
        "curl -sS --max-time 30 -X POST http://127.0.0.1:{REMOTE_DAEMON_PORT}/api/remote/pairing \
         -H 'content-type: application/json' -d {body}"
    )
}

/// Result of one remote command.
#[derive(Debug, Clone)]
struct SshOutput {
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl SshOutput {
    /// Exit status plus stderr, for error messages and the job log.
    fn failure_detail(&self) -> String {
        let code = self
            .exit_code
            .map(|code| format!("exit code {code}"))
            .unwrap_or_else(|| "terminated by signal".to_string());
        let stderr = self.stderr.trim();
        if stderr.is_empty() {
            code
        } else {
            format!("{code}: {}", truncate(stderr, 1000))
        }
    }

    fn combined_output(&self) -> String {
        let mut output = self.stdout.trim().to_string();
        let stderr = self.stderr.trim();
        if !stderr.is_empty() {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(stderr);
        }
        truncate(&output, MAX_LOG_ENTRY_CHARS)
    }

    /// True when curl reported an HTTP 404 for the binary download.
    fn mentions_http_not_found(&self) -> bool {
        let stderr = self.stderr.to_ascii_lowercase();
        stderr.contains("404") && stderr.contains("not found")
    }

    fn mentions_missing_bus(&self) -> bool {
        self.stderr.contains("Failed to connect to bus")
    }
}

/// Runs `script` on the remote host through a single `ssh` invocation.
///
/// The target and script are separate argv entries, so nothing here is
/// interpreted by a local shell.
async fn ssh_exec(target: &str, port: Option<u16>, script: &str) -> Result<SshOutput, DaemonError> {
    let mut command = Command::new("ssh");
    command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg(format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECS}"));
    if let Some(port) = port {
        command.arg("-p").arg(port.to_string());
    }
    command.arg(target).arg(script);

    let output = command
        .output()
        .await
        .map_err(|error| DaemonError::Process(format!("failed to run ssh: {error}")))?;

    Ok(SshOutput {
        success: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// Rejects targets that `ssh` could read as flags or that carry characters no
/// legitimate host alias needs.
fn validate_ssh_target(target: &str) -> Result<String, DaemonError> {
    let target = target.trim();
    if target.is_empty() {
        return Err(DaemonError::BadRequest(
            "ssh_target is required".to_string(),
        ));
    }
    if target.starts_with('-') {
        return Err(DaemonError::BadRequest(
            "ssh_target must not start with '-'".to_string(),
        ));
    }
    if target.len() > 255 {
        return Err(DaemonError::BadRequest(
            "ssh_target is too long".to_string(),
        ));
    }
    let allowed =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | ':' | '[' | ']');
    if !target.chars().all(allowed) {
        return Err(DaemonError::BadRequest(format!(
            "ssh_target contains unsupported characters: {target:?}"
        )));
    }
    Ok(target.to_string())
}

/// Guards the relay URL before it is embedded in a remote shell command.
fn validate_shell_safe_url(relay_url: &str) -> Result<(), DaemonError> {
    let unsafe_char = |c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '`' | '$' | '\\');
    if relay_url.chars().any(unsafe_char) {
        return Err(DaemonError::BadRequest(
            "relay_url contains unsupported characters".to_string(),
        ));
    }
    Ok(())
}

/// Wraps a value in single quotes for safe inclusion in a remote shell script.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let kept: String = value.chars().take(max_chars).collect();
    format!("{kept}… (truncated)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_aliases_and_user_at_host_targets() {
        assert_eq!(
            validate_ssh_target(" quizgecko-ops-2 ").unwrap(),
            "quizgecko-ops-2"
        );
        assert_eq!(
            validate_ssh_target("forge@10.0.0.4").unwrap(),
            "forge@10.0.0.4"
        );
        assert_eq!(validate_ssh_target("[fe80::1]").unwrap(), "[fe80::1]");
    }

    #[test]
    fn rejects_targets_that_ssh_could_read_as_flags_or_shell_input() {
        for target in [
            "",
            "   ",
            "-oProxyCommand=touch /tmp/pwned",
            "host; rm -rf /",
            "host $(whoami)",
            "host with space",
            "host`id`",
        ] {
            assert!(
                validate_ssh_target(target).is_err(),
                "expected {target:?} to be rejected"
            );
        }
    }

    #[test]
    fn rejects_relay_urls_that_would_break_out_of_quoting() {
        assert!(validate_shell_safe_url("https://connect.falcondeck.com").is_ok());
        assert!(validate_shell_safe_url("https://relay.test/'; touch /tmp/x; '").is_err());
        assert!(validate_shell_safe_url("https://relay.test/$(id)").is_err());
        assert!(validate_shell_safe_url("https://relay.test/a b").is_err());
    }

    #[test]
    fn quotes_values_for_the_remote_shell() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn builds_the_hosted_binary_url_from_the_relay_and_architecture() {
        assert_eq!(
            daemon_binary_url("https://connect.falcondeck.com", "x86_64"),
            "https://connect.falcondeck.com/dist/falcondeck-daemon-x86_64-linux"
        );
        assert_eq!(
            daemon_binary_url("https://connect.falcondeck.com", "aarch64"),
            "https://connect.falcondeck.com/dist/falcondeck-daemon-aarch64-linux"
        );
    }

    #[test]
    fn unit_file_matches_the_verified_layout() {
        let script = start_service_script();
        assert!(
            script.contains("Environment=FALCONDECK_STATE_PATH=%h/.falcondeck/daemon-state.json")
        );
        assert!(script.contains("Environment=FALCONDECK_SECRET_FILE=%h/.falcondeck/secrets.json"));
        assert!(script.contains(
            "Environment=PATH=%h/.local/bin:%h/.local/npm-global/bin:/usr/local/bin:/usr/bin:/bin"
        ));
        assert!(script.contains("ExecStart=%h/.local/bin/falcondeck-daemon --port=4123"));
        assert!(script.contains("Restart=on-failure"));
        assert!(script.contains("WantedBy=default.target"));
        // A quoted heredoc delimiter keeps `%h` and `$HOME` out of the shell's
        // hands inside the unit body.
        assert!(script.contains("<<'FALCONDECK_UNIT'"));
        assert!(script.contains("systemctl --user daemon-reload"));
        assert!(script.contains("systemctl --user enable falcondeck-daemon"));
    }

    #[test]
    fn pairing_script_sends_the_relay_url_as_json() {
        let script = pairing_script("https://connect.falcondeck.com");
        assert!(script.contains(r#"-d '{"relay_url":"https://connect.falcondeck.com"}'"#));
        assert!(script.contains("http://127.0.0.1:4123/api/remote/pairing"));
    }

    #[test]
    fn reads_the_pairing_code_from_a_remote_status_response() {
        let body = r#"{"status":"pairing_pending","relay_url":"https://connect.falcondeck.com",
            "pairing":{"pairing_id":"p1","pairing_code":"ABCD-1234","session_id":null,
            "expires_at":"2026-08-07T00:00:00Z"},"trusted_devices":[]}"#;
        assert_eq!(extract_pairing_code(body).unwrap(), "ABCD-1234");
    }

    #[test]
    fn pairing_code_extraction_reports_unusable_responses() {
        assert!(extract_pairing_code("").is_err());
        assert!(extract_pairing_code("curl: (7) Failed to connect").is_err());
        assert!(extract_pairing_code(r#"{"status":"connected","pairing":null}"#).is_err());
        assert!(extract_pairing_code(r#"{"pairing":{"pairing_code":""}}"#).is_err());
    }

    #[test]
    fn detects_a_missing_binary_and_a_missing_systemd_bus() {
        let not_found = SshOutput {
            success: false,
            exit_code: Some(22),
            stdout: String::new(),
            stderr: "curl: (22) The requested URL returned error: 404 Not Found".to_string(),
        };
        assert!(not_found.mentions_http_not_found());
        assert!(!not_found.mentions_missing_bus());

        let no_bus = SshOutput {
            success: false,
            exit_code: Some(1),
            stdout: String::new(),
            stderr: "Failed to connect to bus: No medium found".to_string(),
        };
        assert!(no_bus.mentions_missing_bus());
        assert!(!no_bus.mentions_http_not_found());
    }

    #[test]
    fn failure_detail_includes_the_exit_code_and_stderr() {
        let output = SshOutput {
            success: false,
            exit_code: Some(255),
            stdout: String::new(),
            stderr: "Permission denied (publickey).\n".to_string(),
        };
        assert_eq!(
            output.failure_detail(),
            "exit code 255: Permission denied (publickey)."
        );
    }

    #[test]
    fn truncate_keeps_short_values_intact() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdef", 3), "abc… (truncated)");
    }

    #[test]
    fn pruning_drops_the_oldest_finished_job_first() {
        let mut jobs = HashMap::new();
        for index in 0..MAX_JOBS {
            let job_id = format!("job-{index}");
            jobs.insert(
                job_id.clone(),
                ProvisionJob {
                    job_id,
                    name: "host".to_string(),
                    ssh_target: "host".to_string(),
                    // Keep one job running so pruning has to skip it.
                    status: if index == 0 {
                        ProvisionStatus::Running
                    } else {
                        ProvisionStatus::Completed
                    },
                    stage: ProvisionStage::Done,
                    log: Vec::new(),
                    pairing_code: None,
                    relay_url: "https://connect.falcondeck.com".to_string(),
                    error: None,
                    created_at: Utc::now() + chrono::Duration::seconds(index as i64),
                },
            );
        }

        prune_finished_jobs(&mut jobs);

        assert_eq!(jobs.len(), MAX_JOBS - 1);
        assert!(jobs.contains_key("job-0"), "running jobs must be kept");
        assert!(
            !jobs.contains_key("job-1"),
            "oldest finished job is evicted"
        );
    }
}
