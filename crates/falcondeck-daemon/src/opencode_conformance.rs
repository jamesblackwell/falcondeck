//! Reusable conformance probe for OpenCode's native HTTP transport.
//!
//! Run the cost-free checks with:
//! `cargo run -p falcondeck-daemon --example opencode_conformance`
//! Add `--live` to also run one real turn against the configured default
//! model, which is the only check that spends tokens.
//!
//! The checks here deliberately concentrate on assumptions that fail *quietly*
//! if OpenCode changes them. A renamed field or a dropped route announces
//! itself the first time anyone uses it; what cost FalconDeck a working native
//! transport was reading an absent signal as a verdict, so those readings are
//! what this probe pins down.

use std::{collections::HashMap, time::Duration};

use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    acp_conformance::CheckStatus,
    error::DaemonError,
    opencode::{Delivery, OpenCodeRuntime},
};

/// A model reference that cannot resolve for anyone. Used to prove the waiter
/// terminates and explains itself; never reaches a provider, so it is free.
const UNRESOLVABLE_MODEL: &str = "falcondeck-conformance/no-such-model";
const LIVE_TURN_TIMEOUT: Duration = Duration::from_secs(90);
const SILENT_TURN_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct Report {
    /// OpenCode command that was probed.
    pub command: Vec<String>,
    /// Whether the token-spending live turn ran.
    pub live: bool,
    pub checks: Vec<Check>,
}

impl Report {
    pub(crate) fn new(command: Vec<String>, live: bool) -> Self {
        Self {
            command,
            live,
            checks: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, name: &str, status: CheckStatus, detail: impl Into<String>) {
        self.checks.push(Check {
            name: name.to_string(),
            status,
            detail: detail.into(),
        });
    }

    /// Records a fallible check, mapping its error into the failure detail.
    fn record<T>(
        &mut self,
        name: &str,
        outcome: Result<T, DaemonError>,
        describe: impl FnOnce(T) -> String,
    ) {
        match outcome {
            Ok(value) => self.push(name, CheckStatus::Pass, describe(value)),
            Err(error) => self.push(name, CheckStatus::Fail, error.to_string()),
        }
    }

    pub fn has_failures(&self) -> bool {
        self.checks
            .iter()
            .any(|check| check.status == CheckStatus::Fail)
    }

    pub fn render(&self) -> String {
        let mut out = format!("OpenCode native conformance: {}\n", self.command.join(" "));
        if !self.live {
            out.push_str("(cost-free mode; pass --live to also run one real turn)\n");
        }
        for check in &self.checks {
            out.push_str(&format!(
                "{} {}: {}\n",
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
    pub command: Vec<String>,
    /// Directory the probe's sessions run in. Must be a real project: agents
    /// are project-scoped, so an empty scratch directory reports none and the
    /// agent check would fail for a reason that has nothing to do with drift.
    pub cwd: Option<String>,
    pub live: bool,
    pub json: bool,
    /// Treat a missing OpenCode binary as skipped rather than failed.
    pub skip_missing: bool,
}

impl ProbeOptions {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Self {
        let mut options = Self {
            command: Vec::new(),
            cwd: None,
            live: false,
            json: false,
            skip_missing: false,
        };
        let mut rest = false;
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--live" if !rest => options.live = true,
                "--json" if !rest => options.json = true,
                "--skip-missing" if !rest => options.skip_missing = true,
                "--cwd" if !rest => options.cwd = args.next(),
                "--" if !rest => rest = true,
                _ => options.command.push(arg),
            }
        }
        if options.command.is_empty() {
            options.command.push("opencode".to_string());
        }
        options
    }

    fn resolved_cwd(&self) -> Option<String> {
        self.cwd.clone().or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|cwd| cwd.to_string_lossy().to_string())
        })
    }
}

pub async fn run_probe(options: &ProbeOptions) -> Report {
    let mut report = Report::new(options.command.clone(), options.live);
    if options.skip_missing {
        let exe = options
            .command
            .first()
            .map(String::as_str)
            .unwrap_or("opencode");
        if !crate::agent_binary::agent_binary_available_cached(exe, exe) {
            report.push(
                "server starts and reports its port",
                CheckStatus::Skipped,
                format!("`{exe}` is not installed"),
            );
            return report;
        }
    }
    let Some(cwd) = options.resolved_cwd() else {
        report.push(
            "probe directory",
            CheckStatus::Fail,
            "could not resolve a working directory; pass --cwd",
        );
        return report;
    };
    report.push("probe directory", CheckStatus::Pass, cwd.clone());

    let runtime = match OpenCodeRuntime::spawn(&options.command, &cwd, &HashMap::new()).await {
        Ok(runtime) => {
            report.push(
                "server starts and reports its port",
                CheckStatus::Pass,
                "stdout banner parsed",
            );
            runtime
        }
        Err(error) => {
            // Everything downstream needs the server, so stop here rather than
            // reporting a cascade of failures with one real cause.
            report.push(
                "server starts and reports its port",
                CheckStatus::Fail,
                error.to_string(),
            );
            return report;
        }
    };

    let health = runtime.health().await;
    report.record("health responds", health, |_| "ok".to_string());

    // The schema drift check. This is the cheap, deterministic layer: it turns
    // a removed route or renamed field into a loud failure at attach instead of
    // a 400 on someone's turn.
    let contract = runtime.validate_contract().await;
    report.record("contract matches /doc", contract, |()| {
        "routes, request bodies, schemas and enum values all present".to_string()
    });

    match runtime.provider_catalog().await {
        Ok(catalog) => {
            let providers = catalog
                .get("providers")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or_default();
            let models: usize = catalog
                .get("providers")
                .and_then(Value::as_array)
                .map(|providers| {
                    providers
                        .iter()
                        .filter_map(|provider| provider.get("models").and_then(Value::as_object))
                        .map(|models| models.len())
                        .sum()
                })
                .unwrap_or_default();
            // An empty catalog parses fine and renders as an empty picker, so
            // shape drift here is invisible without a count assertion.
            let status = if models > 0 {
                CheckStatus::Pass
            } else {
                CheckStatus::Fail
            };
            report.push(
                "provider catalog parses",
                status,
                format!("{providers} providers, {models} models"),
            );
        }
        Err(error) => report.push(
            "provider catalog parses",
            CheckStatus::Fail,
            error.to_string(),
        ),
    }

    match runtime.agents().await {
        Ok(agents) => {
            // Agents carry `id`, not `name`. Reading the wrong key yields an
            // empty mode list rather than an error.
            let identified = agents
                .iter()
                .filter(|agent| agent.get("id").and_then(Value::as_str).is_some())
                .count();
            let status = if identified > 0 {
                CheckStatus::Pass
            } else {
                CheckStatus::Fail
            };
            report.push(
                "agents expose id",
                status,
                format!(
                    "{identified}/{} agents carry an id (agents are project-scoped)",
                    agents.len()
                ),
            );
        }
        Err(error) => report.push("agents expose id", CheckStatus::Fail, error.to_string()),
    }

    probe_session_routes(&runtime, &cwd, &mut report).await;
    probe_silent_model_failure(&runtime, &cwd, &mut report).await;
    if options.live {
        let live_model = match runtime.runner_models().await {
            Ok(models) if !models.is_empty() => {
                let runnable = models
                    .keys()
                    .map(String::as_str)
                    .filter(|id| {
                        crate::opencode::native_model_block_reason(Some(id), &models).is_none()
                    })
                    .collect::<Vec<_>>();
                crate::acp_conformance::pick_preferred_live_model(runnable).map(str::to_string)
            }
            _ => None,
        };
        match live_model.as_deref() {
            Some(model) => probe_live_turn(&runtime, &cwd, Some(model), &mut report).await,
            None => report.push(
                "live turn reaches an assistant reply",
                CheckStatus::Skipped,
                "no current-tier model is natively executable on this runner",
            ),
        }
    } else {
        report.push(
            "live turn reaches an assistant reply",
            CheckStatus::Skipped,
            "pass --live to spend tokens on one real turn",
        );
    }

    runtime.shutdown().await;
    report
}

/// Exercises the per-session routes that a turn depends on but which a turn
/// failure would not distinguish from each other.
async fn probe_session_routes(runtime: &OpenCodeRuntime, cwd: &str, report: &mut Report) {
    let session_id = match runtime.create_session(cwd, None, Some("build")).await {
        Ok(session_id) => {
            report.push(
                "session create accepts our body",
                CheckStatus::Pass,
                session_id.clone(),
            );
            session_id
        }
        Err(error) => {
            report.push(
                "session create accepts our body",
                CheckStatus::Fail,
                error.to_string(),
            );
            return;
        }
    };

    let active = runtime.session_is_active(&session_id).await;
    report.record("active session listing parses", active, |active| {
        format!("active={active}")
    });

    let messages = runtime.messages(&session_id).await;
    report.record("message pagination walks", messages, |messages| {
        format!("{} messages", messages.len())
    });

    let permissions = runtime.pending_permissions(&session_id).await;
    report.record("pending permissions parse", permissions, |pending| {
        format!("{} pending", pending.len())
    });

    let questions = runtime.pending_questions(&session_id).await;
    report.record("pending questions parse", questions, |pending| {
        format!("{} pending", pending.len())
    });

    let agent = runtime.set_agent(&session_id, "build").await;
    report.record("session agent is settable", agent, |()| "build".to_string());

    // Interrupting an idle session is a no-op for OpenCode but still exercises
    // the route and its body expectations.
    let interrupt = runtime.interrupt(&session_id).await;
    report.record("interrupt is accepted", interrupt, |()| "204".to_string());

    runtime.delete_session(&session_id).await;
}

/// The regression guard for the bug this suite exists because of.
///
/// A session pinned to an unresolvable model fails inside OpenCode's runner
/// before any step event: the session stream stays empty and no assistant
/// record appears. FalconDeck must terminate that wait and report OpenCode's
/// own stated cause rather than inferring anything about the transport.
async fn probe_silent_model_failure(runtime: &OpenCodeRuntime, cwd: &str, report: &mut Report) {
    let session_id = match runtime
        .create_session(cwd, Some(UNRESOLVABLE_MODEL), Some("build"))
        .await
    {
        Ok(session_id) => session_id,
        Err(error) => {
            report.push(
                "unresolvable model is explained",
                CheckStatus::Fail,
                format!("could not create probe session: {error}"),
            );
            return;
        }
    };
    let message_id = format!("msg_{}", Uuid::new_v4().simple());
    let admission = match runtime
        .prompt(
            &session_id,
            &message_id,
            "FalconDeck conformance probe",
            &[],
            Delivery::Steer,
        )
        .await
    {
        Ok(admission) => admission,
        Err(error) => {
            report.push(
                "unresolvable model is explained",
                CheckStatus::Fail,
                format!("prompt admission failed: {error}"),
            );
            runtime.delete_session(&session_id).await;
            return;
        }
    };
    let after_seq = admission
        .pointer("/data/admittedSeq")
        .and_then(Value::as_u64);
    let waited = tokio::time::timeout(
        SILENT_TURN_TIMEOUT,
        runtime.wait_until_idle(&session_id, &message_id, after_seq),
    )
    .await;
    runtime.delete_session(&session_id).await;

    match waited {
        Err(_) => report.push(
            "unresolvable model is explained",
            CheckStatus::Fail,
            "the waiter never terminated".to_string(),
        ),
        Ok(Ok(_)) => report.push(
            "unresolvable model is explained",
            CheckStatus::Fail,
            "the turn reported success for a model that cannot resolve".to_string(),
        ),
        Ok(Err(error)) => {
            let error = error.to_string();
            // Without the server's own cause the user sees only "no response",
            // which is what sent us hunting the wrong bug.
            let status = if error.contains("OpenCode reported:") {
                CheckStatus::Pass
            } else {
                CheckStatus::Fail
            };
            report.push("unresolvable model is explained", status, error);
        }
    }
}

/// One real turn against a cheap runner-resolvable model when the registry
/// publishes one, otherwise the user's configured default.
async fn probe_live_turn(
    runtime: &OpenCodeRuntime,
    cwd: &str,
    model: Option<&str>,
    report: &mut Report,
) {
    let session_id = match runtime.create_session(cwd, model, Some("build")).await {
        Ok(session_id) => session_id,
        Err(error) => {
            report.push(
                "live turn reaches an assistant reply",
                CheckStatus::Fail,
                error.to_string(),
            );
            return;
        }
    };
    let message_id = format!("msg_{}", Uuid::new_v4().simple());
    let admission = runtime
        .prompt(
            &session_id,
            &message_id,
            "Reply with exactly: ok",
            &[],
            Delivery::Steer,
        )
        .await;
    let admission = match admission {
        Ok(admission) => admission,
        Err(error) => {
            report.push(
                "live turn reaches an assistant reply",
                CheckStatus::Fail,
                error.to_string(),
            );
            runtime.delete_session(&session_id).await;
            return;
        }
    };
    let after_seq = admission
        .pointer("/data/admittedSeq")
        .and_then(Value::as_u64);
    let waited = tokio::time::timeout(
        LIVE_TURN_TIMEOUT,
        runtime.wait_until_idle(&session_id, &message_id, after_seq),
    )
    .await;
    runtime.delete_session(&session_id).await;

    match waited {
        Err(_) => report.push(
            "live turn reaches an assistant reply",
            CheckStatus::Fail,
            format!("no terminal response within {LIVE_TURN_TIMEOUT:?}"),
        ),
        Ok(Err(error)) => report.push(
            "live turn reaches an assistant reply",
            CheckStatus::Fail,
            error.to_string(),
        ),
        Ok(Ok(messages)) => {
            let assistant = messages
                .iter()
                .filter(|message| message.get("type").and_then(Value::as_str) == Some("assistant"))
                .count();
            let status = if assistant > 0 {
                CheckStatus::Pass
            } else {
                CheckStatus::Fail
            };
            report.push(
                "live turn reaches an assistant reply",
                status,
                match model {
                    Some(model) => format!("{assistant} assistant record(s) via {model}"),
                    None => format!("{assistant} assistant record(s) via configured default"),
                },
            );
        }
    }
}

pub async fn run_cli(args: impl IntoIterator<Item = String>) -> i32 {
    let options = ProbeOptions::parse(args);
    let report = run_probe(&options).await;
    if options.json {
        match serde_json::to_string_pretty(&report) {
            Ok(encoded) => println!("{encoded}"),
            Err(error) => {
                eprintln!("failed to encode report: {error}");
                return 2;
            }
        }
    } else {
        print!("{}", report.render());
    }
    i32::from(report.has_failures())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_default_to_the_opencode_binary() {
        let options = ProbeOptions::parse(Vec::new());
        assert_eq!(options.command, ["opencode"]);
        assert!(!options.live);
        assert!(!options.skip_missing);
    }

    #[test]
    fn options_parse_live_json_and_a_custom_command() {
        let options = ProbeOptions::parse([
            "--live".to_string(),
            "--json".to_string(),
            "--".to_string(),
            "opencode".to_string(),
            "--pure".to_string(),
        ]);
        assert!(options.live);
        assert!(options.json);
        assert_eq!(options.command, ["opencode", "--pure"]);
    }

    #[test]
    fn report_fails_only_when_a_check_fails() {
        let mut report = Report::new(vec!["opencode".to_string()], false);
        report.push("skipped", CheckStatus::Skipped, "detail");
        report.push("warning", CheckStatus::Warning, "detail");
        assert!(!report.has_failures());
        report.push("failure", CheckStatus::Fail, "detail");
        assert!(report.has_failures());
    }
}
