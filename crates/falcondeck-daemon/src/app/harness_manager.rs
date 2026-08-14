//! Harness management: detect, version-check, and upgrade coding agent CLIs.
//!
//! FalconDeck orchestrates harnesses (Codex, Claude, OpenCode, …) but does
//! not ship them. This module is the machine-facing half of the Settings →
//! Harnesses panel: it inventories every harness the daemon knows about
//! (built-in backends, `providers.json` ACP entries, and a curated detection
//! list), probes install location and version, and can run install/upgrade
//! commands — locally or on an SSH host, reusing the BatchMode ssh pattern
//! from host provisioning.
//!
//! Design rules:
//! - Version probes are cached; latest-version lookups hit the network only
//!   when a client explicitly asks (`POST /api/harnesses/refresh`).
//! - Upgrade commands come exclusively from the curated registry below.
//!   Custom ACP entries are surfaced with status but are never auto-upgraded.
//! - Per-host results are keyed by `"local"` or the SSH target, so a stale
//!   answer for one machine never leaks into another's overview.

use std::{
    collections::HashMap,
    env,
    path::Path,
    time::{Duration, Instant},
};

use falcondeck_core::{
    HarnessesOverview, HarnessKind, HarnessRefreshRequest, HarnessSummary, HarnessUpgradeJob,
    HarnessUpgradeRequest, HarnessUpgradeStatus,
};
use futures_util::future::join_all;
use tokio::{process::Command as TokioCommand, time::timeout};
use uuid::Uuid;

use super::{AppState, host_provisioning};
use crate::error::DaemonError;

/// Ceiling on one `<bin> --version` / auth probe.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Ceiling on an install/upgrade command (npm installs can be slow).
const UPGRADE_TIMEOUT: Duration = Duration::from_secs(600);
/// Ceiling on one npm-registry lookup.
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(15);
/// How long an unrefreshed overview may be served from cache.
const CACHE_TTL: Duration = Duration::from_secs(60);
/// Finished upgrade jobs retained for status polling before pruning.
const MAX_JOBS: usize = 32;
/// Upper bound on log lines kept per upgrade job.
const MAX_LOG_ENTRIES: usize = 100;
/// Upper bound on characters kept per log line.
const MAX_LOG_ENTRY_CHARS: usize = 4000;

/// A harness FalconDeck knows how to detect and (optionally) manage. Entries
/// without `npm_package` get no latest-version check; entries without
/// `upgrade_command` are detection-only.
struct KnownHarness {
    id: &'static str,
    label: &'static str,
    bin: &'static str,
    /// npm package whose registry `latest` documents the newest release.
    npm_package: Option<&'static str>,
    /// Install/upgrade command. Run verbatim through a login shell (local)
    /// or a single BatchMode ssh invocation (remote).
    upgrade_command: Option<&'static str>,
    /// Extra argv (after the bin) probing auth/subscription state.
    auth_probe: Option<&'static [&'static str]>,
    /// Built-in daemon backends get first-class framing in the panel.
    builtin: bool,
}

/// Curated detection list. Anything configured in `providers.json` is merged
/// on top of this, so a custom `grok` entry shows up even though it is not
/// listed here.
const KNOWN_HARNESSES: &[KnownHarness] = &[
    KnownHarness {
        id: "codex",
        label: "Codex",
        bin: "codex",
        npm_package: Some("@openai/codex"),
        upgrade_command: Some("npm install -g @openai/codex"),
        auth_probe: Some(&["login", "status"]),
        builtin: true,
    },
    KnownHarness {
        id: "claude",
        label: "Claude Code",
        bin: "claude",
        npm_package: Some("@anthropic-ai/claude-code"),
        upgrade_command: Some("npm install -g @anthropic-ai/claude-code"),
        auth_probe: Some(&["auth", "status"]),
        builtin: true,
    },
    KnownHarness {
        id: "opencode",
        label: "OpenCode",
        bin: "opencode",
        npm_package: Some("opencode-ai"),
        upgrade_command: Some("curl -fsSL https://opencode.ai/install | bash"),
        auth_probe: None,
        builtin: false,
    },
    KnownHarness {
        id: "gemini",
        label: "Gemini CLI",
        bin: "gemini",
        npm_package: Some("@google/gemini-cli"),
        upgrade_command: Some("npm install -g @google/gemini-cli"),
        auth_probe: None,
        builtin: false,
    },
    KnownHarness {
        id: "pi",
        label: "Pi",
        bin: "pi-acp",
        npm_package: Some("@earendil-works/pi-coding-agent"),
        upgrade_command: Some(
            "npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp",
        ),
        auth_probe: None,
        builtin: false,
    },
    KnownHarness {
        // Z.ai's GLM coding harness. Detection-only until a canonical
        // package/channel is confirmed; status and version still surface.
        id: "zcode",
        label: "Zcode (GLM)",
        bin: "zcode",
        npm_package: None,
        upgrade_command: None,
        auth_probe: None,
        builtin: false,
    },
];

/// Response body for `POST /api/harnesses/upgrade`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StartHarnessUpgradeResponse {
    /// Identifier used to poll upgrade progress.
    pub job_id: String,
}

/// Cache key for the local machine.
const LOCAL_HOST: &str = "local";

impl AppState {
    /// Serves the local overview from cache when fresh; otherwise probes.
    /// Never touches the network: a probe without `include_latest` is
    /// shell-outs only, and any latest-version knowledge from a previous
    /// explicit refresh is carried over so badges don't flicker off.
    pub async fn harnesses_overview(&self) -> HarnessesOverview {
        if let Some((probed_at, overview)) = self.inner.harness_cache.lock().unwrap().get(LOCAL_HOST)
            && probed_at.elapsed() < CACHE_TTL
        {
            return overview.clone();
        }
        match self.probe_harnesses(LOCAL_HOST, None, false).await {
            Ok(overview) => overview,
            Err(error) => {
                tracing::warn!("local harness probe failed: {error}");
                HarnessesOverview {
                    host: LOCAL_HOST.to_string(),
                    harnesses: Vec::new(),
                }
            }
        }
    }

    /// Re-probes harnesses for the requested host, bypassing the cache, and
    /// optionally checks published latest versions.
    pub async fn refresh_harnesses(
        &self,
        request: HarnessRefreshRequest,
    ) -> Result<HarnessesOverview, DaemonError> {
        let host = match request.ssh_target.as_deref() {
            Some(target) => host_provisioning::validate_ssh_target(target)?,
            None => LOCAL_HOST.to_string(),
        };
        let overview = self
            .probe_harnesses(&host, request.port, request.include_latest)
            .await?;
        Ok(overview)
    }

    /// Starts an install/upgrade in the background and returns the job id.
    pub async fn start_harness_upgrade(
        &self,
        request: HarnessUpgradeRequest,
    ) -> Result<StartHarnessUpgradeResponse, DaemonError> {
        let host = match request.ssh_target.as_deref() {
            Some(target) => host_provisioning::validate_ssh_target(target)?,
            None => LOCAL_HOST.to_string(),
        };

        let harness = KNOWN_HARNESSES
            .iter()
            .find(|harness| harness.id == request.harness_id)
            .ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "unknown or unmanaged harness: {}",
                    request.harness_id
                ))
            })?;
        let upgrade_command = harness.upgrade_command.ok_or_else(|| {
            DaemonError::BadRequest(format!(
                "'{}' has no managed upgrade path; upgrade it manually",
                harness.label
            ))
        })?;

        let job_id = Uuid::new_v4().to_string();
        let job = HarnessUpgradeJob {
            job_id: job_id.clone(),
            harness_id: harness.id.to_string(),
            label: harness.label.to_string(),
            host: host.clone(),
            status: HarnessUpgradeStatus::Running,
            log: vec![format!("Running: {upgrade_command}")],
            error: None,
        };
        {
            let mut jobs = self.inner.harness_jobs.lock().await;
            prune_finished_jobs(&mut jobs);
            jobs.insert(job_id.clone(), job);
        }

        let app = self.clone();
        let background_job_id = job_id.clone();
        let port = request.port;
        tokio::spawn(async move {
            let result = if host == LOCAL_HOST {
                run_local_upgrade(upgrade_command).await
            } else {
                match host_provisioning::ssh_exec_with_timeout(
                    &host,
                    port,
                    upgrade_command,
                    UPGRADE_TIMEOUT,
                )
                .await
                {
                    Ok(output) if output.success => Ok(output.combined_output()),
                    Ok(output) => Err(output.failure_detail()),
                    Err(error) => Err(error.to_string()),
                }
            };
            match result {
                Ok(output) => {
                    app.push_harness_job_log(&background_job_id, &output).await;
                    app.finish_harness_job(&background_job_id, None).await;
                    tracing::info!("harness upgrade on {host} finished: {}", harness.id);
                }
                Err(error) => {
                    tracing::warn!("harness upgrade on {host} failed: {error}");
                    app.finish_harness_job(&background_job_id, Some(error)).await;
                }
            }
            // The install may have changed binaries or versions; never serve
            // the pre-upgrade probe result again.
            app.inner.harness_cache.lock().unwrap().remove(&host);
        });

        Ok(StartHarnessUpgradeResponse { job_id })
    }

    /// Returns the current state of an upgrade job.
    pub async fn harness_upgrade_job(&self, job_id: &str) -> Result<HarnessUpgradeJob, DaemonError> {
        self.inner
            .harness_jobs
            .lock()
            .await
            .get(job_id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound(format!("unknown harness job: {job_id}")))
    }

    async fn finish_harness_job(&self, job_id: &str, error: Option<String>) {
        let mut jobs = self.inner.harness_jobs.lock().await;
        if let Some(job) = jobs.get_mut(job_id) {
            if let Some(error) = error {
                let short = truncate(&error, MAX_LOG_ENTRY_CHARS);
                job.log.push(short.clone());
                job.error = Some(short);
                job.status = HarnessUpgradeStatus::Failed;
            } else {
                job.status = HarnessUpgradeStatus::Completed;
            }
        }
    }

    async fn push_harness_job_log(&self, job_id: &str, line: &str) {
        let line = truncate(line.trim(), MAX_LOG_ENTRY_CHARS);
        if line.is_empty() {
            return;
        }
        let mut jobs = self.inner.harness_jobs.lock().await;
        if let Some(job) = jobs.get_mut(job_id)
            && job.log.len() < MAX_LOG_ENTRIES
        {
            job.log.push(line);
        }
    }

    /// Probes one host and caches the result. Local probes resolve binaries
    /// through the daemon's resolver; remote probes batch every check into a
    /// single ssh invocation so a large panel costs one connection.
    async fn probe_harnesses(
        &self,
        host: &str,
        port: Option<u16>,
        include_latest: bool,
    ) -> Result<HarnessesOverview, DaemonError> {
        // providers.json entries overlay the curated list: a configured
        // harness is reported through its configured command even when the
        // curated bin differs.
        let acp_entries = self.harness_acp_entries();

        let mut summaries: Vec<HarnessSummary> = if host == LOCAL_HOST {
            join_all(KNOWN_HARNESSES.iter().map(|harness| {
                async move { probe_local_harness(harness).await }
            }))
            .await
        } else {
            probe_remote_harnesses(host, port).await?
        };

        for (id, label, bin) in acp_entries {
            if let Some(existing) = summaries.iter_mut().find(|summary| summary.id == id) {
                // Curated entry configured through providers.json: keep the
                // managed metadata but probe the configured binary.
                if existing.bin != bin {
                    existing.bin = bin.clone();
                    if host == LOCAL_HOST {
                        let resolution =
                            crate::agent_binary::resolve_agent_binary(&bin, &bin);
                        apply_resolution(existing, &resolution.executable);
                        existing.version = probe_binary_version(&resolution.executable).await;
                    }
                }
                existing.kind = HarnessKind::Acp;
                existing.label = label;
            } else {
                let mut summary = HarnessSummary {
                    id: id.clone(),
                    label,
                    kind: HarnessKind::Acp,
                    bin: bin.clone(),
                    resolved_path: None,
                    installed: false,
                    version: None,
                    latest_version: None,
                    update_available: None,
                    install_source: None,
                    upgrade_command: None,
                    account_status: None,
                };
                if host == LOCAL_HOST {
                    let resolution = crate::agent_binary::resolve_agent_binary(&bin, &bin);
                    apply_resolution(&mut summary, &resolution.executable);
                    summary.version = probe_binary_version(&resolution.executable).await;
                }
                summaries.push(summary);
            }
        }

        if include_latest {
            self.apply_latest_versions(&mut summaries).await;
        } else {
            // Keep the latest-version knowledge from a previous explicit
            // refresh: without this, a cheap TTL re-probe would clear the
            // "Update available" badge until the user checks again.
            let previous = self
                .inner
                .harness_cache
                .lock()
                .unwrap()
                .get(host)
                .map(|(_, overview)| {
                    overview
                        .harnesses
                        .iter()
                        .map(|summary| {
                            (
                                summary.id.clone(),
                                (
                                    summary.latest_version.clone(),
                                    summary.update_available,
                                ),
                            )
                        })
                        .collect::<HashMap<_, _>>()
                });
            if let Some(previous) = previous {
                for summary in &mut summaries {
                    if let Some((latest, update)) = previous.get(&summary.id) {
                        summary.latest_version = latest.clone();
                        summary.update_available = *update;
                    }
                }
            }
        }

        summaries.sort_by(|left, right| left.label.cmp(&right.label));
        let overview = HarnessesOverview {
            host: host.to_string(),
            harnesses: summaries,
        };
        if host == LOCAL_HOST {
            // Remote results are write-only in a local-keyed cache: GET
            // serves the local machine only and remote refreshes always
            // re-probe, so caching them would leak entries that nothing
            // ever reads or evicts.
            self.inner
                .harness_cache
                .lock()
                .unwrap()
                .insert(host.to_string(), (Instant::now(), overview.clone()));
        }
        Ok(overview)
    }

    /// (id, label, bin) for every providers.json entry, including ones whose
    /// binary is missing — the harness panel exists to explain those too.
    fn harness_acp_entries(&self) -> Vec<(String, String, String)> {
        let Some(state_dir) = self.state_dir() else {
            return Vec::new();
        };
        let overview = crate::acp::providers_overview(&state_dir);
        overview
            .get("resolved")
            .and_then(|value| value.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let id = entry.get("id")?.as_str()?.to_string();
                        if id == "codex" || id == "claude" {
                            return None;
                        }
                        let label = entry
                            .get("label")
                            .and_then(|value| value.as_str())
                            .unwrap_or(&id)
                            .to_string();
                        let bin = entry
                            .get("command")
                            .and_then(|value| value.as_array())
                            .and_then(|command| command.first())
                            .and_then(|value| value.as_str())?
                            .to_string();
                        Some((id, label, bin))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Fetches published latest versions for managed harnesses. Purely
    /// on-demand: nothing here runs during regular snapshots.
    async fn apply_latest_versions(&self, summaries: &mut [HarnessSummary]) {
        let client = reqwest::Client::builder()
            .timeout(REGISTRY_TIMEOUT)
            .build();
        let Ok(client) = client else {
            return;
        };
        let fetches: Vec<(usize, &KnownHarness)> = summaries
            .iter()
            .enumerate()
            .filter_map(|(index, summary)| {
                KNOWN_HARNESSES
                    .iter()
                    .find(|harness| harness.id == summary.id)
                    .and_then(|harness| harness.npm_package.map(|_| (index, harness)))
            })
            .collect();
        let results = join_all(fetches.iter().map(|(_, harness)| {
            let client = &client;
            let package = harness.npm_package.unwrap_or_default();
            async move {
                fetch_latest_version(client, package).await
            }
        }))
        .await;
        for ((index, _), latest) in fetches.iter().zip(results) {
            if let Some(latest) = latest
                && let Some(summary) = summaries.get_mut(*index)
            {
                summary.latest_version = Some(latest.clone());
                summary.update_available = summary
                    .version
                    .as_deref()
                    .map(|version| is_update_available(version, &latest));
            }
        }
    }
}

/// Runs the curated upgrade command through a login shell so the same PATH
/// the user's terminal sees resolves `npm`/`curl`.
async fn run_local_upgrade(upgrade_command: &str) -> Result<String, String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut command = TokioCommand::new(shell);
    command
        .arg("-l")
        .arg("-c")
        .arg(upgrade_command)
        .kill_on_drop(true);
    let output = timeout(UPGRADE_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("upgrade timed out after {} seconds", UPGRADE_TIMEOUT.as_secs()))?
        .map_err(|error| format!("failed to run upgrade: {error}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !combined.trim().is_empty() {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    if output.status.success() {
        Ok(combined)
    } else {
        Err(format!(
            "exit code {}: {}",
            output.status.code().unwrap_or(-1),
            truncate(combined.trim(), 1000)
        ))
    }
}

async fn probe_local_harness(harness: &KnownHarness) -> HarnessSummary {
    let resolution = crate::agent_binary::resolve_agent_binary(harness.bin, harness.bin);
    let mut summary = HarnessSummary {
        id: harness.id.to_string(),
        label: harness.label.to_string(),
        kind: if harness.builtin {
            HarnessKind::Builtin
        } else {
            HarnessKind::Detected
        },
        bin: harness.bin.to_string(),
        resolved_path: None,
        installed: false,
        version: None,
        latest_version: None,
        update_available: None,
        install_source: None,
        upgrade_command: harness.upgrade_command.map(str::to_string),
        account_status: None,
    };
    apply_resolution(&mut summary, &resolution.executable);
    if !summary.installed {
        // Auth probes read harness config; keep them lazy so a missing
        // binary never spawns a shell.
        return summary;
    }
    let auth_argv: Option<Vec<String>> = harness.auth_probe.map(|args| {
        let mut argv = vec![resolution.executable.clone()];
        argv.extend(args.iter().map(|arg| arg.to_string()));
        argv
    });
    // Version and auth probes are independent; run them concurrently.
    let version_future = probe_binary_version(&resolution.executable);
    let auth_future = async {
        match auth_argv.as_deref() {
            Some(argv) => probe_binary_argv(argv).await,
            None => None,
        }
    };
    let (version, account) = tokio::join!(version_future, auth_future);
    summary.version = version;
    summary.account_status = account;
    summary
}

/// Applies a resolved executable path to a summary, classifying the install
/// source from the canonicalized location (npm symlinks point into
/// node_modules, Homebrew into /opt/homebrew, …).
fn apply_resolution(summary: &mut HarnessSummary, executable: &str) {
    let installed = Path::new(executable).is_file();
    summary.installed = installed;
    summary.resolved_path = installed.then(|| executable.to_string());
    if installed {
        summary.install_source = Some(classify_install_source(executable).to_string());
    }
}

fn classify_install_source(path: &str) -> &'static str {
    if path.contains("node_modules") {
        "npm"
    } else if path.starts_with("/opt/homebrew") || path.contains("/Cellar/") {
        "homebrew"
    } else if path.contains(".cargo/bin") {
        "cargo"
    } else if path.contains(".local/bin") || path.contains(".opencode/bin") {
        "local"
    } else {
        "unknown"
    }
}

async fn probe_binary_version(executable: &str) -> Option<String> {
    let output = run_with_timeout(&[executable, "--version"]).await?;
    parse_version(&output)
}

async fn probe_binary_argv(argv: &[String]) -> Option<String> {
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    let output = run_with_timeout(&refs).await?;
    let flat = output.lines().map(str::trim).collect::<Vec<_>>().join(" ");
    let flat = truncate(&flat, 300);
    Some(flat)
}

async fn run_with_timeout(argv: &[&str]) -> Option<String> {
    let mut command = TokioCommand::new(argv.first()?);
    command.args(&argv[1..]).kill_on_drop(true);
    let output = timeout(PROBE_TIMEOUT, command.output()).await.ok()?.ok()?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if combined.trim().is_empty() && !stderr.trim().is_empty() {
        combined = stderr.into_owned();
    }
    Some(combined)
}

/// Extracts the first `x.y[…]` version-looking token from CLI output
/// (`codex-cli 0.12.0`, `1.0.42 (Claude Code)`, …).
fn parse_version(output: &str) -> Option<String> {
    let first_line = output.lines().next()?.trim();
    let token = first_line.split_whitespace().find(|token| {
        let digits = token.trim_start_matches('v');
        let mut parts = digits.split('.');
        let first = parts.next().unwrap_or_default();
        !first.is_empty()
            && first.chars().all(|c| c.is_ascii_digit())
            && parts.next().is_some_and(|second| {
                !second.is_empty() && second.chars().all(|c| c.is_ascii_digit())
            })
    })?;
    Some(token.trim_start_matches('v').to_string())
}

/// Lenient numeric comparison over dot-separated version strings. Returns
/// an upgrade only when the published latest is strictly newer — a local
/// build newer than the registry tag (nightly channel, re-tag) must not be
/// "updated" into a downgrade. Unparseable sides never claim an update.
fn is_update_available(current: &str, latest: &str) -> bool {
    let parse = |value: &str| -> Option<Vec<u64>> {
        value
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()
    };
    match (parse(current), parse(latest)) {
        (Some(current), Some(latest)) => latest > current,
        _ => false,
    }
}

async fn fetch_latest_version(client: &reqwest::Client, package: &str) -> Option<String> {
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let value: serde_json::Value = client
        .get(url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// Markers used by the batched remote probe script. Parsed from stdout with
/// `splitn(3, ':')` so paths containing colons survive.
const REMOTE_MISSING: &str = "FD_MISSING:";
const REMOTE_BIN: &str = "FD_BIN:";
const REMOTE_VERSION: &str = "FD_VER:";
const REMOTE_AUTH: &str = "FD_AUTH:";

/// Probes every known harness on a remote host through one ssh invocation.
/// A missing `ssh` binary or unreachable host fails the whole overview with
/// the ssh error rather than silently reporting every harness as missing.
async fn probe_remote_harnesses(
    target: &str,
    port: Option<u16>,
) -> Result<Vec<HarnessSummary>, DaemonError> {
    let script = remote_probe_script();
    let output = host_provisioning::ssh_exec_with_timeout(target, port, &script, PROBE_TIMEOUT)
        .await
        .map_err(|error| DaemonError::Process(format!("harness probe on {target} failed: {error}")))?;
    if !output.success {
        return Err(DaemonError::Process(format!(
            "harness probe on {target} failed: {}",
            output.failure_detail()
        )));
    }

    let mut paths: HashMap<String, String> = HashMap::new();
    let mut versions: HashMap<String, String> = HashMap::new();
    let mut auths: HashMap<String, String> = HashMap::new();
    for line in output.stdout.lines() {
        if let Some(rest) = line.strip_prefix(REMOTE_MISSING) {
            // Presence is implied by absence of FD_BIN below; nothing to do.
            let _ = rest;
        } else if let Some(rest) = line.strip_prefix(REMOTE_BIN) {
            if let Some((bin, path)) = rest.split_once(':') {
                paths.insert(bin.to_string(), path.to_string());
            }
        } else if let Some(rest) = line.strip_prefix(REMOTE_VERSION) {
            if let Some((bin, version)) = rest.split_once(':') {
                if let Some(version) = parse_version(version) {
                    versions.insert(bin.to_string(), version);
                }
            }
        } else if let Some(rest) = line.strip_prefix(REMOTE_AUTH) {
            if let Some((bin, status)) = rest.split_once(':') {
                let status = truncate(status.trim(), 300);
                if !status.is_empty() {
                    auths.insert(bin.to_string(), status);
                }
            }
        }
    }

    Ok(KNOWN_HARNESSES
        .iter()
        .map(|harness| {
            let path = paths.get(harness.bin);
            HarnessSummary {
                id: harness.id.to_string(),
                label: harness.label.to_string(),
                kind: if harness.builtin {
                    HarnessKind::Builtin
                } else {
                    HarnessKind::Detected
                },
                bin: harness.bin.to_string(),
                resolved_path: path.cloned(),
                installed: path.is_some(),
                version: versions.get(harness.bin).cloned(),
                latest_version: None,
                update_available: None,
                install_source: path.map(|path| classify_install_source(path).to_string()),
                upgrade_command: harness.upgrade_command.map(str::to_string),
                account_status: auths.get(harness.bin).cloned(),
            }
        })
        .collect())
}

/// Builds the single remote script probing every known harness. Bin names
/// come from the curated registry (shell-safe by construction); ACP entries
/// are not probed remotely because their commands are arbitrary argv.
/// Auth probes run once per harness outside the bin loop — node-based CLIs
/// can take seconds to start, and repeating them per loop iteration would
/// blow the PROBE_TIMEOUT budget on hosts with several harnesses installed.
fn remote_probe_script() -> String {
    let mut script = String::from("set -- ");
    for harness in KNOWN_HARNESSES {
        script.push_str(harness.bin);
        script.push(' ');
    }
    script.push_str("\nfor bin do\n  p=$(command -v \"$bin\" 2>/dev/null) || { echo \"FD_MISSING:$bin\"; continue; }\n  echo \"FD_BIN:$bin:$p\"\n  v=$(\"$bin\" --version 2>&1 | head -n 1)\n  echo \"FD_VER:$bin:$v\"\ndone\n");
    for harness in KNOWN_HARNESSES.iter().filter(|h| h.auth_probe.is_some()) {
        let args = harness.auth_probe.unwrap_or_default().join(" ");
        script.push_str(&format!(
            "if command -v {bin} >/dev/null 2>&1; then\n  a=$(\"{bin}\" {args} 2>&1 | head -n 2 | tr '\\n' ' ')\n  echo \"FD_AUTH:{bin}:$a\"\nfi\n",
            bin = harness.bin
        ));
    }
    script
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let kept: String = value.chars().take(max_chars).collect();
    format!("{kept}… (truncated)")
}

fn prune_finished_jobs(jobs: &mut HashMap<String, HarnessUpgradeJob>) {
    if jobs.len() <= MAX_JOBS {
        return;
    }
    let mut finished: Vec<String> = jobs
        .iter()
        .filter(|(_, job)| job.status != HarnessUpgradeStatus::Running)
        .map(|(job_id, _)| job_id.clone())
        .collect();
    finished.sort();
    let excess = jobs.len().saturating_sub(MAX_JOBS);
    for job_id in finished.into_iter().take(excess) {
        jobs.remove(&job_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions_from_common_cli_output() {
        assert_eq!(
            parse_version("codex-cli 0.12.0"),
            Some("0.12.0".to_string())
        );
        assert_eq!(
            parse_version("1.0.42 (Claude Code)"),
            Some("1.0.42".to_string())
        );
        assert_eq!(parse_version("opencode v0.6.9"), Some("0.6.9".to_string()));
        assert_eq!(parse_version("no version here"), None);
    }

    #[test]
    fn update_comparison_is_conservative() {
        assert!(is_update_available("0.12.0", "0.13.0"));
        assert!(!is_update_available("0.13.0", "0.13.0"));
        // A local build newer than the registry tag is not an update.
        assert!(!is_update_available("0.14.0", "0.13.0"));
        // Unparseable sides must never claim an update.
        assert!(!is_update_available("unknown", "0.13.0"));
    }

    #[test]
    fn install_source_classification() {
        assert_eq!(
            classify_install_source(
                "/usr/local/lib/node_modules/@openai/codex/bin/codex.js"
            ),
            "npm"
        );
        assert_eq!(classify_install_source("/opt/homebrew/bin/codex"), "homebrew");
        assert_eq!(
            classify_install_source("/Users/x/.cargo/bin/codex"),
            "cargo"
        );
        assert_eq!(
            classify_install_source("/Users/x/.opencode/bin/opencode"),
            "local"
        );
        assert_eq!(classify_install_source("/usr/bin/tool"), "unknown");
    }

    #[test]
    fn remote_probe_script_marks_every_known_harness() {
        let script = remote_probe_script();
        for harness in KNOWN_HARNESSES {
            assert!(script.contains(harness.bin), "missing {}", harness.bin);
        }
        // Auth probes only for harnesses that define them.
        assert!(script.contains("FD_AUTH:codex:"));
        assert!(script.contains("FD_AUTH:claude:"));
        assert!(!script.contains("FD_AUTH:zcode:"));
    }

    #[test]
    fn remote_markers_parse_with_colons_in_paths() {
        let mut paths = HashMap::new();
        let line = "FD_BIN:codex:/opt/homebrew/bin/codex";
        if let Some(rest) = line.strip_prefix(REMOTE_BIN)
            && let Some((bin, path)) = rest.split_once(':')
        {
            paths.insert(bin.to_string(), path.to_string());
        }
        assert_eq!(paths.get("codex").map(String::as_str), Some("/opt/homebrew/bin/codex"));
    }
}
