//! Conformance probes for the first-party harnesses, plus a suite runner.
//!
//! Run the full cost-free suite with:
//! `cargo run -p falcondeck-daemon --example harness_conformance`
//! Missing binaries are skipped. Add `--live` to spend tokens on current cheap-tier models,
//! `--all-models` to also verify every curated Claude id, and `--json` for
//! machine-readable output.
//!
//! Claude, Codex, and Antigravity are not ACP, so neither the ACP probe nor
//! the OpenCode one applies. What carries over is the selection rule: check
//! the assumptions that fail *quietly*. For Codex that is the model catalog
//! and the service tiers behind fast mode. For Claude and AGY it is the
//! command-line surface and the stream-json event shapes the transcript is
//! assembled from.
//!
//! Probes drive FalconDeck's own code (`CodexSession::provider_metadata`,
//! `claude::REQUIRED_CLI_FLAGS`, `agy::parse_stream_line`) rather than a
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
    acp_conformance::{self, CheckStatus, pick_cheap_model},
    agent_binary::resolve_agent_binary,
    agy,
    app::AppState,
    claude,
    codex::{self, CodexSession},
    opencode_conformance,
};
use falcondeck_core::ConversationItem;

const LIVE_TURN_TIMEOUT: Duration = Duration::from_secs(120);
const AGY_LIVE_TIMEOUT: Duration = Duration::from_secs(45);
/// Current Claude cheap alias (Haiku 4.5), not the retired `claude-3-haiku` id.
const CHEAP_CLAUDE_MODEL: &str = "haiku";
/// Stream-json fields the Claude transcript builder reads. A turn that stops
/// carrying these still completes; the transcript just loses structure.
const REQUIRED_CLAUDE_STREAM_FIELDS: &[&str] = &["type", "session_id"];

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

#[derive(Debug, Serialize)]
struct SuiteReport {
    live: bool,
    skip_missing: bool,
    first_party: Vec<Report>,
    opencode: opencode_conformance::Report,
    acp: Vec<acp_conformance::Report>,
}

impl SuiteReport {
    fn has_failures(&self) -> bool {
        self.first_party.iter().any(Report::has_failures)
            || self.opencode.has_failures()
            || self.acp.iter().any(acp_conformance::Report::has_failures)
    }

    fn render(&self) -> String {
        let mut out = String::new();
        for report in &self.first_party {
            out.push_str(&report.render());
            out.push('\n');
        }
        out.push_str(&self.opencode.render());
        out.push('\n');
        if self.acp.is_empty() {
            out.push_str("ACP (no providers.json entries)\n– skipped                    configure an ACP provider to probe it\n");
        } else {
            for report in &self.acp {
                out.push_str(&report.render());
                out.push('\n');
            }
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
    /// Verify every curated Claude model id, not just the cheap default.
    /// Implies `--live`.
    pub all_models: bool,
    pub skip_missing: bool,
    pub restart: bool,
    pub claude_bin: String,
    pub codex_bin: String,
    pub agy_bin: String,
    pub opencode_bin: String,
    pub acp_timeout: Duration,
}

impl ProbeOptions {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Self {
        let mut options = Self {
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            live: false,
            json: false,
            all_models: false,
            skip_missing: true,
            restart: false,
            claude_bin: "claude".to_string(),
            codex_bin: "codex".to_string(),
            agy_bin: "agy".to_string(),
            opencode_bin: "opencode".to_string(),
            acp_timeout: Duration::from_secs(45),
        };
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--live" => options.live = true,
                "--json" => options.json = true,
                "--all-models" => {
                    options.all_models = true;
                    options.live = true;
                }
                "--skip-missing" => options.skip_missing = true,
                "--require-installed" => options.skip_missing = false,
                "--restart" => options.restart = true,
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
                "--agy-bin" => {
                    if let Some(bin) = args.next() {
                        options.agy_bin = bin;
                    }
                }
                "--opencode-bin" => {
                    if let Some(bin) = args.next() {
                        options.opencode_bin = bin;
                    }
                }
                "--timeout-seconds" => {
                    if let Some(value) = args.next()
                        && let Ok(seconds) = value.parse::<u64>()
                        && seconds > 0
                    {
                        options.acp_timeout = Duration::from_secs(seconds);
                    }
                }
                _ => {}
            }
        }
        options
    }
}

fn binary_installed(bin_name: &str, configured: &str) -> bool {
    crate::agent_binary::agent_binary_available_cached(bin_name, configured)
}

fn skip_or_fail_missing(report: &mut Report, skip_missing: bool, bin: &str) {
    if skip_missing {
        report.push(
            "binary responds",
            CheckStatus::Skipped,
            format!("`{bin}` is not installed"),
        );
    } else {
        report.push(
            "binary responds",
            CheckStatus::Fail,
            format!("could not run `{bin} --version`"),
        );
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

async fn help_text(bin_name: &str, configured: &str) -> Option<String> {
    let resolved = resolve_agent_binary(bin_name, configured);
    let output = Command::new(&resolved.executable)
        .arg("--help")
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{stdout}{stderr}");
    (!combined.trim().is_empty()).then_some(combined)
}

fn record_required_flags(report: &mut Report, name: &str, help: Option<String>, flags: &[&str]) {
    match help {
        Some(help) => {
            let missing = flags
                .iter()
                .filter(|flag| !help.contains(**flag))
                .copied()
                .collect::<Vec<_>>();
            if missing.is_empty() {
                report.push(
                    name,
                    CheckStatus::Pass,
                    format!("all {} flags present", flags.len()),
                );
            } else {
                report.push(
                    name,
                    CheckStatus::Fail,
                    format!("missing from --help: {}", missing.join(", ")),
                );
            }
        }
        None => report.push(name, CheckStatus::Fail, "could not read --help"),
    }
}

/// Codex publishes its catalog over the app-server control plane, so the probe
/// bootstraps a real session and asks the same questions the daemon asks at
/// workspace attach.
pub async fn probe_codex(options: &ProbeOptions) -> Report {
    let mut report = Report::new("Codex");
    if !binary_installed("codex", &options.codex_bin) {
        skip_or_fail_missing(&mut report, options.skip_missing, &options.codex_bin);
        return report;
    }
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

    let models = match bootstrap.session.provider_metadata().await {
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
            metadata.models
        }
        Err(error) => {
            report.push("model catalog", CheckStatus::Fail, error.to_string());
            Vec::new()
        }
    };

    if options.live {
        probe_codex_live(&bootstrap.session, &models, &mut report).await;
    } else {
        report.push(
            "cheap live turn",
            CheckStatus::Skipped,
            "pass --live to spend tokens on one cheap turn",
        );
    }

    let _ = bootstrap.session.shutdown().await;
    report
}

fn json_has_nonempty_text(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Object(map) => {
            map.get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
                || map.values().any(json_has_nonempty_text)
        }
        Value::Array(items) => items.iter().any(json_has_nonempty_text),
        _ => false,
    }
}

fn value_has_assistant_text(value: &Value, cwd: &str) -> bool {
    if crate::codex::conversation_items_from_read(value, cwd)
        .iter()
        .any(|item| {
            matches!(
                item,
                ConversationItem::AssistantMessage { text, .. } if !text.trim().is_empty()
            )
        })
    {
        return true;
    }
    match value {
        Value::Object(map) => {
            let ty = map
                .get("type")
                .or_else(|| map.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if matches!(ty, "agentMessage" | "agent_message" | "assistant") {
                return json_has_nonempty_text(value);
            }
            map.values()
                .any(|value| value_has_assistant_text(value, cwd))
        }
        Value::Array(items) => items
            .iter()
            .any(|value| value_has_assistant_text(value, cwd)),
        _ => false,
    }
}

fn json_keys(value: &Value) -> String {
    match value {
        Value::Object(map) => map.keys().cloned().collect::<Vec<_>>().join(","),
        _ => value.to_string().chars().take(120).collect(),
    }
}

fn codex_thread_summary(value: &Value, cwd: &str) -> String {
    let items = crate::codex::conversation_items_from_read(value, cwd);
    let kinds = items
        .iter()
        .map(|item| match item {
            ConversationItem::AssistantMessage { text, .. } => {
                format!("assistant:{}chars", text.trim().chars().count())
            }
            ConversationItem::UserMessage { .. } => "user".to_string(),
            ConversationItem::Reasoning { .. } => "reasoning".to_string(),
            ConversationItem::ToolCall { .. } => "tool".to_string(),
            _ => "other".to_string(),
        })
        .collect::<Vec<_>>();
    let turns = value
        .pointer("/thread/turns")
        .or_else(|| value.pointer("/turns"))
        .and_then(Value::as_array)
        .map(|turns| turns.len())
        .unwrap_or(0);
    format!(
        "keys={} turns={} hydrated={} [{}]",
        json_keys(value),
        turns,
        items.len(),
        kinds.join(",")
    )
}

async fn probe_codex_live(
    session: &CodexSession,
    models: &[falcondeck_core::ModelSummary],
    report: &mut Report,
) {
    let ids = models
        .iter()
        .map(|model| model.id.as_str())
        .collect::<Vec<_>>();
    let Some(model) = pick_cheap_model(ids).map(str::to_string) else {
        report.push(
            "cheap live turn",
            CheckStatus::Skipped,
            "no model catalog to pick a cheap id from",
        );
        return;
    };
    // Isolate from the user's real projects. Codex keys recents by cwd, so a
    // turn in the FalconDeck repo shows up as another "ok" thread there.
    let scratch = match conformance_scratch_dir() {
        Ok(dir) => dir,
        Err(error) => {
            report.push("cheap live turn", CheckStatus::Fail, error);
            return;
        }
    };
    let cwd = scratch.to_string_lossy().to_string();
    let mut start_params = crate::codex::thread_start_params(
        &cwd,
        Some(&model),
        Some("danger-full-access"),
        "never",
        None,
    );
    start_params["ephemeral"] = json!(true);
    let started = session.send_request("thread/start", start_params).await;
    let thread_id = match started {
        Ok(value) => match codex::extract_thread_id(&value) {
            Some(thread_id) => thread_id,
            None => {
                report.push(
                    "cheap live turn",
                    CheckStatus::Fail,
                    "thread/start returned no thread id",
                );
                return;
            }
        },
        Err(error) => {
            report.push("cheap live turn", CheckStatus::Fail, error.to_string());
            return;
        }
    };

    let turn = tokio::time::timeout(
        LIVE_TURN_TIMEOUT,
        session.send_request(
            "turn/start",
            crate::codex::turn_start_params(
                &thread_id,
                vec![
                    json!({ "type": "text", "text": "Reply with exactly: ok. Do not use tools." }),
                ],
                Some(&cwd),
                Some(&model),
                Some("low"),
                Value::Null,
                json!({ "type": "dangerFullAccess" }),
                Some("never"),
                None,
            ),
        ),
    )
    .await;

    let (mut saw_text, mut last_shape) = match turn {
        Err(_) => {
            let _ = session
                .send_request("thread/archive", json!({ "threadId": thread_id }))
                .await;
            report.push(
                "cheap live turn",
                CheckStatus::Fail,
                format!("turn/start did not finish within {LIVE_TURN_TIMEOUT:?} using {model}"),
            );
            return;
        }
        Ok(Err(error)) => {
            let _ = session
                .send_request("thread/archive", json!({ "threadId": thread_id }))
                .await;
            report.push("cheap live turn", CheckStatus::Fail, error.to_string());
            return;
        }
        Ok(Ok(value)) => (
            value_has_assistant_text(&value, &cwd),
            codex_thread_summary(&value, &cwd),
        ),
    };

    let mut last_read = None;
    if !saw_text {
        let deadline = tokio::time::Instant::now() + LIVE_TURN_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            match session
                .send_request("thread/read", json!({ "threadId": thread_id }))
                .await
            {
                Ok(value) => {
                    last_shape = codex_thread_summary(&value, &cwd);
                    last_read = Some(value.clone());
                    if value_has_assistant_text(&value, &cwd) {
                        saw_text = true;
                        break;
                    }
                }
                Err(error) => last_shape = error.to_string(),
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    if !saw_text && let Some(value) = last_read {
        let path = std::env::temp_dir().join("falcondeck-codex-live.json");
        let _ = std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap_or_default());
        last_shape = format!("{last_shape}; dumped {}", path.display());
    }

    report.push(
        "cheap live turn",
        if saw_text {
            CheckStatus::Pass
        } else {
            CheckStatus::Fail
        },
        if saw_text {
            format!("assistant text via {model}")
        } else {
            format!("no assistant text within {LIVE_TURN_TIMEOUT:?} using {model}; {last_shape}")
        },
    );

    let _ = session
        .send_request(
            "thread/name/set",
            json!({ "threadId": thread_id, "name": "FalconDeck conformance" }),
        )
        .await;
    let _ = session
        .send_request("thread/archive", json!({ "threadId": thread_id }))
        .await;
}

fn conformance_scratch_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("falcondeck-conformance-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    std::fs::write(
        dir.join("README.txt"),
        "FalconDeck harness-conformance scratch. Safe to delete.\n",
    )
    .map_err(|error| error.to_string())?;
    Ok(dir)
}

/// Claude is driven as a CLI, so its contract is the command-line surface plus
/// the stream-json shapes the transcript is assembled from.
pub async fn probe_claude(options: &ProbeOptions) -> Report {
    let mut report = Report::new("Claude");
    if !binary_installed("claude", &options.claude_bin) {
        skip_or_fail_missing(&mut report, options.skip_missing, &options.claude_bin);
        return report;
    }
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

    let help = help_text("claude", &options.claude_bin).await;
    record_required_flags(
        &mut report,
        "turn flags advertised",
        help.clone(),
        claude::REQUIRED_CLI_FLAGS,
    );
    match help.as_deref() {
        Some(help_text) => {
            let missing = claude::CONTROL_PLANE_CLI_FLAGS
                .iter()
                .filter(|flag| !help_text.contains(**flag))
                .copied()
                .collect::<Vec<_>>();
            if missing.is_empty() {
                report.push(
                    "control-plane flags",
                    CheckStatus::Pass,
                    claude::CONTROL_PLANE_CLI_FLAGS.join(", "),
                );
            } else {
                report.push(
                    "control-plane flags",
                    CheckStatus::Warning,
                    format!("missing from --help: {}", missing.join(", ")),
                );
            }
        }
        None => report.push(
            "control-plane flags",
            CheckStatus::Fail,
            "could not read --help",
        ),
    }
    if let Some(help) = help.as_deref() {
        let aliases = claude::parse_help_model_ids(help);
        let status =
            if aliases.iter().any(|id| id == "sonnet") && aliases.iter().any(|id| id == "opus") {
                CheckStatus::Pass
            } else {
                CheckStatus::Warning
            };
        report.push(
            "help model aliases",
            status,
            if aliases.is_empty() {
                "--model help paragraph had no quoted ids".to_string()
            } else {
                aliases.join(", ")
            },
        );
    }

    // The picker is curated aliases plus extras from ~/.claude.json. An empty
    // curated list is the quiet failure; extras must never blank it.
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
    let picker = claude::list_models().await;
    report.push(
        "picker catalog",
        if picker.is_empty() {
            CheckStatus::Fail
        } else {
            CheckStatus::Pass
        },
        format!("{} picker model(s), {} curated", picker.len(), models.len()),
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
///
/// `--live` checks the cheap default (`haiku`). `--all-models` spends a turn
/// per curated id.
async fn probe_curated_models_resolve(
    options: &ProbeOptions,
    models: &[falcondeck_core::ModelSummary],
    report: &mut Report,
) {
    let models = if options.all_models {
        models.to_vec()
    } else {
        models
            .iter()
            .filter(|model| model.id == CHEAP_CLAUDE_MODEL)
            .cloned()
            .collect::<Vec<_>>()
    };
    if models.is_empty() {
        report.push(
            "curated models resolve",
            CheckStatus::Fail,
            format!("cheap default `{CHEAP_CLAUDE_MODEL}` is missing from the curated list"),
        );
        return;
    }
    let mut rejected = Vec::new();
    let mut failed = Vec::new();
    for model in &models {
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
    command
        .arg("--model")
        .arg(model.unwrap_or(CHEAP_CLAUDE_MODEL));
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
            for field in REQUIRED_CLAUDE_STREAM_FIELDS {
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
    match claude_stream_turn(options, Some(CHEAP_CLAUDE_MODEL)).await {
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
                format!(
                    "event kinds via {CHEAP_CLAUDE_MODEL}: {}",
                    outcome.kinds.join(", ")
                ),
            );
        }
    }
}

/// Antigravity is the same stream-json subprocess shape as Claude, with its
/// own event names (`init` / `step_update` / `result`) and a live catalog.
pub async fn probe_agy(options: &ProbeOptions) -> Report {
    let mut report = Report::new("Antigravity");
    if !binary_installed("agy", &options.agy_bin) {
        skip_or_fail_missing(&mut report, options.skip_missing, &options.agy_bin);
        return report;
    }
    report.version = binary_version(&options.agy_bin, "--version").await;
    if report.version.is_none() {
        report.push(
            "binary responds",
            CheckStatus::Fail,
            format!("could not run `{} --version`", options.agy_bin),
        );
        return report;
    }
    report.push("binary responds", CheckStatus::Pass, "--version answered");

    record_required_flags(
        &mut report,
        "turn flags advertised",
        help_text("agy", &options.agy_bin).await,
        agy::REQUIRED_CLI_FLAGS,
    );

    let resolved = resolve_agent_binary("agy", &options.agy_bin);
    let models_output = Command::new(&resolved.executable)
        .arg("models")
        .stdin(Stdio::null())
        .output()
        .await
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string());
    let discovered = models_output
        .as_deref()
        .map(agy::parse_models_table)
        .unwrap_or_default();
    // `list_models` falls back to the curated table when `agy models` is empty,
    // which is the quiet failure: the picker still looks populated. Assert on
    // the parser's reading of the live table, not the fallback.
    if discovered.is_empty() {
        report.push(
            "model catalog",
            CheckStatus::Fail,
            "`agy models` produced no rows; the daemon would fall back to the curated list",
        );
    } else {
        report.push(
            "model catalog",
            CheckStatus::Pass,
            format!("{} model(s)", discovered.len()),
        );
    }

    let account = agy::read_auth_status(&options.agy_bin).await;
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
        let candidates = agy_live_candidates(&discovered);
        probe_agy_stream(options, &candidates, &mut report).await;
    } else {
        report.push(
            "stream-json turn",
            CheckStatus::Skipped,
            "pass --live to spend tokens on a cheap flash turn",
        );
        report.push(
            "conversation resume",
            CheckStatus::Skipped,
            "pass --live to spend tokens on a second cheap turn",
        );
    }
    report
}

struct AgyTurnOutcome {
    conversation_id: String,
    events: Vec<&'static str>,
    assistant_text: String,
    success: bool,
    error: Option<String>,
    unparsed: Vec<String>,
    step_types: Vec<String>,
}

async fn agy_stream_turn(
    options: &ProbeOptions,
    model: Option<&str>,
    conversation_id: Option<&str>,
    prompt: &str,
) -> Result<AgyTurnOutcome, String> {
    let resolved = resolve_agent_binary("agy", &options.agy_bin);
    let mut command = Command::new(&resolved.executable);
    command
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--print-timeout")
        .arg("24h")
        .arg("--dangerously-skip-permissions");
    if let Some(model) = model {
        command.arg("--model").arg(model);
    }
    if let Some(conversation_id) = conversation_id {
        command.arg("--conversation").arg(conversation_id);
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
    let line = agy::build_stream_json_input(prompt, &[]);
    stdin
        .write_all(line.as_bytes())
        .await
        .and(stdin.write_all(b"\n").await)
        .and(stdin.flush().await)
        .map_err(|error| error.to_string())?;

    let collected = tokio::time::timeout(AGY_LIVE_TIMEOUT, async {
        let mut lines = BufReader::new(stdout).lines();
        let mut outcome = AgyTurnOutcome {
            conversation_id: String::new(),
            events: Vec::new(),
            assistant_text: String::new(),
            success: false,
            error: None,
            unparsed: Vec::new(),
            step_types: Vec::new(),
        };
        while let Ok(Some(line)) = lines.next_line().await {
            let Some(event) = agy::parse_stream_line(&line) else {
                if outcome.unparsed.len() < 3 {
                    outcome.unparsed.push(line.chars().take(240).collect());
                }
                continue;
            };
            match event {
                agy::AgyStreamEvent::Init { conversation_id } => {
                    if !outcome.events.contains(&"init") {
                        outcome.events.push("init");
                    }
                    if outcome.conversation_id.is_empty() {
                        outcome.conversation_id = conversation_id;
                    }
                }
                agy::AgyStreamEvent::Step {
                    conversation_id,
                    step_type,
                    text_delta,
                    tool_error,
                    ..
                } => {
                    if !outcome.events.contains(&"step_update") {
                        outcome.events.push("step_update");
                    }
                    if outcome.conversation_id.is_empty() {
                        outcome.conversation_id = conversation_id;
                    }
                    if !step_type.is_empty()
                        && !outcome.step_types.iter().any(|seen| seen == &step_type)
                    {
                        outcome.step_types.push(step_type);
                    }
                    if let Some(text) = text_delta {
                        outcome.assistant_text.push_str(&text);
                    }
                    if let Some(error) = tool_error {
                        outcome.assistant_text.push_str(&error);
                    }
                }
                agy::AgyStreamEvent::Result {
                    conversation_id,
                    success,
                    response,
                    error,
                    ..
                } => {
                    if !outcome.events.contains(&"result") {
                        outcome.events.push("result");
                    }
                    if outcome.conversation_id.is_empty() {
                        outcome.conversation_id = conversation_id;
                    }
                    if let Some(response) = response {
                        outcome.assistant_text.push_str(&response);
                    }
                    if let Some(error) = error {
                        outcome.error = Some(error);
                    }
                    outcome.success = success;
                }
            }
        }
        outcome
    })
    .await;
    drop(stdin);
    let _ = child.start_kill();
    collected.map_err(|_| format!("no terminal event within {AGY_LIVE_TIMEOUT:?}"))
}

fn agy_live_candidates(discovered: &[falcondeck_core::ModelSummary]) -> Vec<String> {
    let mut candidates = Vec::new();
    // Prefer medium over low: this account's flash-low quota is exhausted while
    // medium still runs. Both are current Gemini 3.7 cheap-tier ids.
    for needle in [
        "gemini-3.7-flash-medium",
        "gemini-3.7-flash-low",
        "claude-sonnet",
        "claude-haiku",
        "gemini-3.7-flash",
    ] {
        for model in discovered {
            if model.id.contains(needle) && !candidates.iter().any(|id| id == &model.id) {
                candidates.push(model.id.clone());
            }
        }
    }
    for model in discovered {
        if candidates.len() >= 3 {
            break;
        }
        if !candidates.iter().any(|id| id == &model.id) {
            candidates.push(model.id.clone());
        }
    }
    candidates
}

fn agy_turn_is_quota_or_error(outcome: &AgyTurnOutcome) -> bool {
    outcome
        .step_types
        .iter()
        .any(|step| step == "error_message")
        || outcome.error.as_deref().is_some_and(|error| {
            let error = error.to_ascii_lowercase();
            error.contains("quota") || error.contains("rate") || error.contains("limit")
        })
}

async fn probe_agy_stream(options: &ProbeOptions, models: &[String], report: &mut Report) {
    if models.is_empty() {
        report.push(
            "stream-json turn",
            CheckStatus::Fail,
            "no AGY model id to probe",
        );
        report.push("conversation resume", CheckStatus::Skipped, "no model");
        return;
    }
    let mut last_error = None;
    for model in models {
        match agy_stream_turn(
            options,
            Some(model),
            None,
            "Reply with exactly: ok. Do not use tools.",
        )
        .await
        {
            Ok(outcome) if agy_turn_is_quota_or_error(&outcome) => {
                let detail = format!(
                    "{model}: {}",
                    outcome
                        .error
                        .unwrap_or_else(|| outcome.step_types.join(","))
                );
                last_error = Some(match last_error {
                    Some(previous) => format!("{previous}; {detail}"),
                    None => detail,
                });
                continue;
            }
            Err(error) => {
                last_error = Some(match last_error {
                    Some(previous) => format!("{previous}; {model}: {error}"),
                    None => format!("{model}: {error}"),
                });
                continue;
            }
            other => {
                probe_agy_stream_outcome(options, model, other, report).await;
                return;
            }
        }
    }
    let detail = last_error.unwrap_or_else(|| models.join(", "));
    let lowered = detail.to_ascii_lowercase();
    let env_limited = lowered.contains("quota")
        || lowered.contains("no terminal event")
        || lowered.contains("rate");
    report.push(
        "stream-json turn",
        if env_limited {
            CheckStatus::Warning
        } else {
            CheckStatus::Fail
        },
        format!("all candidate models failed: {detail}"),
    );
    report.push(
        "conversation resume",
        CheckStatus::Skipped,
        "no successful first turn",
    );
}

async fn probe_agy_stream_outcome(
    options: &ProbeOptions,
    model_label: &str,
    outcome: Result<AgyTurnOutcome, String>,
    report: &mut Report,
) {
    match outcome {
        Err(error) => {
            report.push("stream-json turn", CheckStatus::Fail, error);
            report.push(
                "conversation resume",
                CheckStatus::Skipped,
                "first turn did not produce a conversation id",
            );
        }
        Ok(outcome)
            if outcome
                .step_types
                .iter()
                .any(|step| step == "error_message") =>
        {
            report.push(
                "stream-json turn",
                CheckStatus::Fail,
                format!(
                    "error_message via {model_label}: {}",
                    if outcome.assistant_text.trim().is_empty() {
                        outcome.step_types.join(",")
                    } else {
                        outcome.assistant_text.trim().to_string()
                    }
                ),
            );
            report.push(
                "conversation resume",
                CheckStatus::Skipped,
                "first turn ended with error_message",
            );
        }
        Ok(outcome)
            if !outcome.events.contains(&"init")
                || !outcome.events.contains(&"result")
                || outcome.assistant_text.trim().is_empty() =>
        {
            report.push(
                "stream-json turn",
                CheckStatus::Fail,
                format!(
                    "events via {model_label}: {}; assistant empty={}; steps={}; unparsed={}",
                    outcome.events.join(", "),
                    outcome.assistant_text.trim().is_empty(),
                    outcome.step_types.join(","),
                    if outcome.unparsed.is_empty() {
                        "none".to_string()
                    } else {
                        outcome.unparsed.join(" | ")
                    }
                ),
            );
            report.push(
                "conversation resume",
                CheckStatus::Skipped,
                "first turn did not carry init+result+text",
            );
        }
        Ok(outcome) if outcome.conversation_id.is_empty() => {
            report.push(
                "stream-json turn",
                CheckStatus::Fail,
                format!(
                    "events via {model_label}: {}; conversation_id missing",
                    outcome.events.join(", ")
                ),
            );
            report.push(
                "conversation resume",
                CheckStatus::Fail,
                "init/result carried no conversation_id; --conversation resume would be a guess",
            );
        }
        Ok(first) => {
            report.push(
                "stream-json turn",
                if first.success {
                    CheckStatus::Pass
                } else {
                    CheckStatus::Warning
                },
                format!(
                    "events via {model_label}: {}; conversation {}",
                    first.events.join(", "),
                    first.conversation_id
                ),
            );
            match agy_stream_turn(
                options,
                Some(model_label),
                Some(&first.conversation_id),
                "Reply with exactly: ok2. Do not use tools.",
            )
            .await
            {
                Err(error) => report.push("conversation resume", CheckStatus::Fail, error),
                Ok(second) if second.events.contains(&"result") => {
                    report.push(
                        "conversation resume",
                        CheckStatus::Pass,
                        format!("resumed {}", first.conversation_id),
                    );
                }
                Ok(second) => report.push(
                    "conversation resume",
                    CheckStatus::Fail,
                    format!("events: {}", second.events.join(", ")),
                ),
            }
        }
    }
}

pub async fn run_cli(args: impl IntoIterator<Item = String>) -> i32 {
    let options = ProbeOptions::parse(args);
    if !options.live {
        eprintln!("cost-free mode; pass --live to spend tokens on current cheap-tier models");
    }
    let first_party = vec![
        probe_claude(&options).await,
        probe_codex(&options).await,
        probe_agy(&options).await,
    ];
    let opencode = opencode_conformance::run_probe(&opencode_conformance::ProbeOptions {
        command: vec![options.opencode_bin.clone()],
        cwd: Some(options.cwd.to_string_lossy().to_string()),
        live: options.live,
        json: false,
        skip_missing: options.skip_missing,
    })
    .await;
    let acp = acp_conformance::run_matrix(&acp_conformance::ProbeOptions::for_suite(
        options.cwd.clone(),
        options.live,
        options.restart,
        options.skip_missing,
        options.acp_timeout,
    ))
    .await;
    let suite = SuiteReport {
        live: options.live,
        skip_missing: options.skip_missing,
        first_party,
        opencode,
        acp,
    };
    if options.json {
        match serde_json::to_string_pretty(&suite) {
            Ok(encoded) => println!("{encoded}"),
            Err(error) => {
                eprintln!("failed to encode report: {error}");
                return 2;
            }
        }
    } else {
        print!("{}", suite.render());
    }
    i32::from(suite.has_failures())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_default_to_the_standard_binaries_and_skip_missing() {
        let options = ProbeOptions::parse(Vec::new());
        assert_eq!(options.claude_bin, "claude");
        assert_eq!(options.codex_bin, "codex");
        assert_eq!(options.agy_bin, "agy");
        assert!(options.skip_missing);
        assert!(!options.live);
        assert!(!options.all_models);
    }

    #[test]
    fn options_parse_overrides() {
        let options = ProbeOptions::parse([
            "--live".to_string(),
            "--all-models".to_string(),
            "--require-installed".to_string(),
            "--agy-bin".to_string(),
            "/opt/agy".to_string(),
            "--claude-bin".to_string(),
            "/opt/claude".to_string(),
            "--codex-bin".to_string(),
            "/opt/codex".to_string(),
        ]);
        assert!(options.live);
        assert!(options.all_models);
        assert!(!options.skip_missing);
        assert_eq!(options.agy_bin, "/opt/agy");
        assert_eq!(options.claude_bin, "/opt/claude");
        assert_eq!(options.codex_bin, "/opt/codex");
    }

    #[test]
    fn all_models_implies_live() {
        let options = ProbeOptions::parse(["--all-models".to_string()]);
        assert!(options.live);
        assert!(options.all_models);
    }

    /// The flag list is the probe's whole contract with the Claude CLI, so an
    /// empty or truncated one would silently check nothing.
    #[test]
    fn required_cli_flags_cover_the_turn_spawn() {
        for flag in [
            "--input-format",
            "--output-format",
            "--model",
            "--effort",
            "--mcp-config",
            "--strict-mcp-config",
        ] {
            assert!(
                claude::REQUIRED_CLI_FLAGS.contains(&flag),
                "{flag} must be checked"
            );
        }
    }

    #[test]
    fn agy_required_flags_cover_the_embedding_surface() {
        for flag in [
            "--input-format",
            "--output-format",
            "--conversation",
            "--model",
            "--dangerously-skip-permissions",
        ] {
            assert!(
                agy::REQUIRED_CLI_FLAGS.contains(&flag),
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

    #[test]
    fn suite_does_not_fail_on_skipped_harnesses() {
        let mut claude = Report::new("Claude");
        claude.push("binary responds", CheckStatus::Skipped, "not installed");
        let mut opencode = opencode_conformance::Report::new(vec!["opencode".to_string()], false);
        opencode.push(
            "server starts and reports its port",
            CheckStatus::Skipped,
            "not installed",
        );
        let suite = SuiteReport {
            live: false,
            skip_missing: true,
            first_party: vec![claude],
            opencode,
            acp: Vec::new(),
        };
        assert!(!suite.has_failures());
    }
}
