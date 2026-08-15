//! Conformance probes for the two first-party harnesses.
//!
//! Run with:
//! `cargo run -p falcondeck-daemon --example harness_conformance`
//! Add `--live` to also run one real Claude turn, the only check that spends
//! tokens.
//!
//! Claude and Codex are not ACP, so neither the ACP probe nor the OpenCode one
//! applies. What carries over is the selection rule: check the assumptions that
//! fail *quietly*. For Codex that is the model catalog and the service tiers
//! behind fast mode, both of which degrade to an empty list rather than an
//! error. For Claude it is the command-line surface — an ignored `--effort`
//! silently stops applying the user's reasoning choice — and the stream-json
//! event shapes the transcript is assembled from.
//!
//! Both probes drive FalconDeck's own code (`CodexSession::provider_metadata`,
//! `claude::read_auth_status`, `claude::REQUIRED_CLI_FLAGS`) rather than a
//! second implementation of it. A probe that reimplements the thing it checks
//! can only confirm itself.

use std::{collections::HashMap, path::PathBuf, process::Stdio, time::Duration};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

use crate::{
    acp_conformance::CheckStatus, agent_binary::resolve_agent_binary, app::AppState, claude,
    codex::CodexSession,
};

const LIVE_TURN_TIMEOUT: Duration = Duration::from_secs(120);
/// Stream-json fields the transcript builder reads. A turn that stops carrying
/// these still completes; the transcript just loses structure.
const REQUIRED_STREAM_FIELDS: &[&str] = &["type", "session_id"];

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub harness: String,
    pub version: Option<String>,
    pub checks: Vec<Check>,
}

impl Report {
    fn new(harness: &str) -> Self {
        Self {
            harness: harness.to_string(),
            version: None,
            checks: Vec::new(),
        }
    }

    fn push(&mut self, name: &str, status: CheckStatus, detail: impl Into<String>) {
        self.checks.push(Check {
            name: name.to_string(),
            status,
            detail: detail.into(),
        });
    }

    pub fn has_failures(&self) -> bool {
        self.checks
            .iter()
            .any(|check| check.status == CheckStatus::Fail)
    }

    pub fn render(&self) -> String {
        let mut out = format!(
            "{}{}\n",
            self.harness,
            self.version
                .as_deref()
                .map(|version| format!(" {version}"))
                .unwrap_or_default()
        );
        for check in &self.checks {
            out.push_str(&format!(
                "{} {:<26} {}\n",
                glyph(check.status),
                check.name,
                check.detail
            ));
        }
        out
    }
}

fn glyph(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pass => "✓",
        CheckStatus::Warning => "△",
        CheckStatus::Fail => "✗",
        CheckStatus::Skipped => "–",
    }
}

pub struct ProbeOptions {
    pub cwd: PathBuf,
    pub live: bool,
    pub json: bool,
    pub claude_bin: String,
    pub codex_bin: String,
}

impl ProbeOptions {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Self {
        let mut options = Self {
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            live: false,
            json: false,
            claude_bin: "claude".to_string(),
            codex_bin: "codex".to_string(),
        };
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--live" => options.live = true,
                "--json" => options.json = true,
                "--cwd" => {
                    if let Some(cwd) = args.next() {
                        options.cwd = PathBuf::from(cwd);
                    }
                }
                "--claude-bin" => {
                    if let Some(bin) = args.next() {
                        options.claude_bin = bin;
                    }
                }
                "--codex-bin" => {
                    if let Some(bin) = args.next() {
                        options.codex_bin = bin;
                    }
                }
                _ => {}
            }
        }
        options
    }
}

async fn binary_version(bin: &str, arg: &str) -> Option<String> {
    let resolved = resolve_agent_binary(bin, bin);
    let output = Command::new(&resolved.executable)
        .arg(arg)
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Codex publishes its catalog over the app-server control plane, so the probe
/// bootstraps a real session and asks the same questions the daemon asks at
/// workspace attach.
pub async fn probe_codex(options: &ProbeOptions) -> Report {
    let mut report = Report::new("Codex");
    report.version = binary_version(&options.codex_bin, "--version").await;
    if report.version.is_none() {
        report.push(
            "binary responds",
            CheckStatus::Fail,
            format!("could not run `{} --version`", options.codex_bin),
        );
        return report;
    }
    report.push("binary responds", CheckStatus::Pass, "--version answered");

    // A throwaway AppState: `connect` needs one for event routing, and using
    // the real entry point is the point — a probe with its own handshake would
    // drift from the daemon's.
    let state = AppState::new("conformance".to_string(), HashMap::new());
    let bootstrap = CodexSession::connect(
        "conformance-workspace".to_string(),
        options.cwd.to_string_lossy().to_string(),
        options.codex_bin.clone(),
        state,
    )
    .await;
    let bootstrap = match bootstrap {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            report.push("app-server bootstrap", CheckStatus::Fail, error.to_string());
            return report;
        }
    };
    report.push(
        "app-server bootstrap",
        CheckStatus::Pass,
        format!("{} thread(s) hydrated", bootstrap.threads.len()),
    );

    match bootstrap.session.provider_metadata().await {
        Ok(metadata) => {
            // An empty catalog is not an error anywhere in the stack; it just
            // renders as a picker with nothing in it.
            let status = if metadata.models.is_empty() {
                CheckStatus::Fail
            } else {
                CheckStatus::Pass
            };
            report.push(
                "model catalog",
                status,
                format!("{} model(s)", metadata.models.len()),
            );

            // Fast mode is expressed as a per-model service tier. If Codex
            // stops publishing tiers the toggle silently stops doing anything,
            // which no turn would report.
            let tiered = metadata
                .models
                .iter()
                .filter(|model| !model.service_tiers.is_empty())
                .count();
            report.push(
                "service tiers (fast mode)",
                if tiered > 0 {
                    CheckStatus::Pass
                } else {
                    CheckStatus::Warning
                },
                format!("{tiered} model(s) advertise service tiers"),
            );

            // `collaborationMode/list` is experimental and the daemon swallows
            // its failure, so an empty list here is the only visible signal.
            report.push(
                "collaboration modes",
                if metadata.collaboration_modes.is_empty() {
                    CheckStatus::Warning
                } else {
                    CheckStatus::Pass
                },
                format!("{} mode(s)", metadata.collaboration_modes.len()),
            );

            report.push(
                "account",
                match metadata.account.status {
                    falcondeck_core::AccountStatus::Ready => CheckStatus::Pass,
                    _ => CheckStatus::Warning,
                },
                metadata.account.label.clone(),
            );
        }
        Err(error) => report.push("model catalog", CheckStatus::Fail, error.to_string()),
    }

    let _ = bootstrap.session.shutdown().await;
    report
}

/// Claude is driven as a CLI, so its contract is the command-line surface plus
/// the stream-json shapes the transcript is assembled from.
pub async fn probe_claude(options: &ProbeOptions) -> Report {
    let mut report = Report::new("Claude");
    report.version = binary_version(&options.claude_bin, "--version").await;
    if report.version.is_none() {
        report.push(
            "binary responds",
            CheckStatus::Fail,
            format!("could not run `{} --version`", options.claude_bin),
        );
        return report;
    }
    report.push("binary responds", CheckStatus::Pass, "--version answered");

    let resolved = resolve_agent_binary("claude", &options.claude_bin);
    let help = Command::new(&resolved.executable)
        .arg("--help")
        .stdin(Stdio::null())
        .output()
        .await
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string());
    match help {
        Some(help) => {
            let missing = claude::REQUIRED_CLI_FLAGS
                .iter()
                .filter(|flag| !help.contains(**flag))
                .copied()
                .collect::<Vec<_>>();
            if missing.is_empty() {
                report.push(
                    "turn flags advertised",
                    CheckStatus::Pass,
                    format!("all {} flags present", claude::REQUIRED_CLI_FLAGS.len()),
                );
            } else {
                report.push(
                    "turn flags advertised",
                    CheckStatus::Fail,
                    format!("missing from --help: {}", missing.join(", ")),
                );
            }
        }
        None => report.push(
            "turn flags advertised",
            CheckStatus::Fail,
            "could not read --help",
        ),
    }

    // Claude's catalog is curated in FalconDeck rather than discovered, so the
    // risk is the opposite of Codex's: the list cannot go empty, only go stale.
    // Proving an id still resolves means running it, so the real check lives
    // behind --live and this one only reports what will be checked.
    let models = claude::curated_models();
    report.push(
        "curated model list",
        if models.is_empty() {
            CheckStatus::Fail
        } else {
            CheckStatus::Pass
        },
        format!(
            "{} curated model(s): {}",
            models.len(),
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    );

    // `read_auth_status` falls back to a bare "ready" when the output is not
    // JSON, so a changed format would look like a healthy account.
    let account = claude::read_auth_status(&options.claude_bin).await;
    report.push(
        "account",
        match account.status {
            falcondeck_core::AccountStatus::Ready => CheckStatus::Pass,
            falcondeck_core::AccountStatus::NeedsAuth => CheckStatus::Warning,
            _ => CheckStatus::Warning,
        },
        account.label.clone(),
    );

    if options.live {
        probe_claude_stream(options, &mut report).await;
        probe_curated_models_resolve(options, &models, &mut report).await;
    } else {
        for name in ["stream-json turn", "curated models resolve"] {
            report.push(
                name,
                CheckStatus::Skipped,
                "pass --live to spend tokens on real turns",
            );
        }
    }
    report
}

/// Every curated model id must still be one the installed CLI knows.
///
/// FalconDeck advertises these from a hardcoded list, so a model the CLI has
/// dropped stays in the picker and fails only when a user selects it. The CLI
/// reports the rejection as `model_not_found` inside an otherwise successful
/// stream, so nothing upstream treats it as an error.
async fn probe_curated_models_resolve(
    options: &ProbeOptions,
    models: &[falcondeck_core::ModelSummary],
    report: &mut Report,
) {
    let mut rejected = Vec::new();
    let mut failed = Vec::new();
    for model in models {
        match claude_stream_turn(options, Some(&model.id)).await {
            Ok(outcome) if outcome.model_not_found => rejected.push(model.id.clone()),
            Ok(_) => {}
            Err(error) => failed.push(format!("{}: {error}", model.id)),
        }
    }
    if !rejected.is_empty() {
        report.push(
            "curated models resolve",
            CheckStatus::Fail,
            format!("CLI rejected: {}", rejected.join(", ")),
        );
    } else if !failed.is_empty() {
        report.push(
            "curated models resolve",
            CheckStatus::Warning,
            format!("could not verify: {}", failed.join("; ")),
        );
    } else {
        report.push(
            "curated models resolve",
            CheckStatus::Pass,
            format!("{} model(s) accepted by the CLI", models.len()),
        );
    }
}

#[derive(Default)]
struct StreamOutcome {
    kinds: Vec<String>,
    assistant_text: String,
    missing_fields: Vec<String>,
    /// The CLI reported the requested model as unknown. This arrives inside an
    /// otherwise successful stream, so it has to be looked for explicitly.
    model_not_found: bool,
}

/// Runs one turn over the same flags a FalconDeck turn uses and reports what
/// the stream carried.
async fn claude_stream_turn(
    options: &ProbeOptions,
    model: Option<&str>,
) -> Result<StreamOutcome, String> {
    let resolved = resolve_agent_binary("claude", &options.claude_bin);
    let mut command = Command::new(&resolved.executable);
    command
        .arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose");
    if let Some(model) = model {
        command.arg("--model").arg(model);
    }
    let mut child = command
        .current_dir(&options.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let line = json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": "Reply with exactly: ok" }] }
    });
    stdin
        .write_all(format!("{line}\n").as_bytes())
        .await
        .and(stdin.flush().await)
        .map_err(|error| error.to_string())?;
    drop(stdin);

    let collected = tokio::time::timeout(LIVE_TURN_TIMEOUT, async {
        let mut lines = BufReader::new(stdout).lines();
        let mut outcome = StreamOutcome::default();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.contains("model_not_found") {
                outcome.model_not_found = true;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            for field in REQUIRED_STREAM_FIELDS {
                if value.get(*field).is_none()
                    && !outcome.missing_fields.contains(&field.to_string())
                {
                    outcome.missing_fields.push(field.to_string());
                }
            }
            if let Some(kind) = value.get("type").and_then(Value::as_str) {
                if !outcome.kinds.iter().any(|seen| seen == kind) {
                    outcome.kinds.push(kind.to_string());
                }
                if kind == "assistant"
                    && let Some(content) =
                        value.pointer("/message/content").and_then(Value::as_array)
                {
                    for block in content {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            outcome.assistant_text.push_str(text);
                        }
                    }
                }
            }
        }
        outcome
    })
    .await;
    let _ = child.start_kill();
    collected.map_err(|_| format!("no terminal event within {LIVE_TURN_TIMEOUT:?}"))
}

/// One real turn, asserting the stream still carries what the transcript
/// builder reads.
async fn probe_claude_stream(options: &ProbeOptions, report: &mut Report) {
    match claude_stream_turn(options, None).await {
        Err(error) => report.push("stream-json turn", CheckStatus::Fail, error),
        Ok(outcome) if !outcome.missing_fields.is_empty() => report.push(
            "stream-json turn",
            CheckStatus::Fail,
            format!(
                "events missing required field(s): {}",
                outcome.missing_fields.join(", ")
            ),
        ),
        Ok(outcome) => {
            let status = if outcome.kinds.iter().any(|kind| kind == "assistant")
                && !outcome.assistant_text.trim().is_empty()
            {
                CheckStatus::Pass
            } else {
                CheckStatus::Fail
            };
            report.push(
                "stream-json turn",
                status,
                format!("event kinds: {}", outcome.kinds.join(", ")),
            );
        }
    }
}

pub async fn run_cli(args: impl IntoIterator<Item = String>) -> i32 {
    let options = ProbeOptions::parse(args);
    let reports = vec![probe_claude(&options).await, probe_codex(&options).await];
    if options.json {
        match serde_json::to_string_pretty(&reports) {
            Ok(encoded) => println!("{encoded}"),
            Err(error) => {
                eprintln!("failed to encode report: {error}");
                return 2;
            }
        }
    } else {
        for report in &reports {
            print!("{}", report.render());
        }
    }
    i32::from(reports.iter().any(Report::has_failures))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_default_to_the_standard_binaries() {
        let options = ProbeOptions::parse(Vec::new());
        assert_eq!(options.claude_bin, "claude");
        assert_eq!(options.codex_bin, "codex");
        assert!(!options.live);
    }

    #[test]
    fn options_parse_overrides() {
        let options = ProbeOptions::parse([
            "--live".to_string(),
            "--claude-bin".to_string(),
            "/opt/claude".to_string(),
            "--codex-bin".to_string(),
            "/opt/codex".to_string(),
        ]);
        assert!(options.live);
        assert_eq!(options.claude_bin, "/opt/claude");
        assert_eq!(options.codex_bin, "/opt/codex");
    }

    /// The flag list is the probe's whole contract with the Claude CLI, so an
    /// empty or truncated one would silently check nothing.
    #[test]
    fn required_cli_flags_cover_the_turn_spawn() {
        for flag in ["--input-format", "--output-format", "--model", "--effort"] {
            assert!(
                claude::REQUIRED_CLI_FLAGS.contains(&flag),
                "{flag} must be checked"
            );
        }
    }

    #[test]
    fn report_fails_only_when_a_check_fails() {
        let mut report = Report::new("Test");
        report.push("warning", CheckStatus::Warning, "detail");
        report.push("skipped", CheckStatus::Skipped, "detail");
        assert!(!report.has_failures());
        report.push("failure", CheckStatus::Fail, "detail");
        assert!(report.has_failures());
    }
}
