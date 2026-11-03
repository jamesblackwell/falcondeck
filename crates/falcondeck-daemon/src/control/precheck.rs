//! Bounded local checks that can avoid starting an agent entirely.
use std::process::Stdio;

use falcondeck_core::control::AutomationPrecheck;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::{Duration, timeout};

/// Identity of what a person reviewed. Paths are canonicalized both when
/// presenting approval and immediately before execution.
pub(super) fn approval_hash(check: &AutomationPrecheck, workspace: &str) -> String {
    use sha2::{Digest, Sha256};
    let payload = serde_json::to_vec(&(&check.command, check.timeout_seconds, workspace)).expect("precheck identity serializes");
    format!("{:x}", Sha256::digest(payload))
}

pub(super) fn definition_identity(automation: &falcondeck_core::control::Automation) -> Option<(String, String)> {
    let check = automation.task.precheck()?;
    if automation.target.run_as_bot.is_some() { return None; }
    let workspace = std::fs::canonicalize(&automation.target.workspace_path).ok()?.to_str()?.to_owned();
    Some((approval_hash(check, &workspace), workspace))
}

pub(super) fn is_approved(automation: &falcondeck_core::control::Automation) -> bool {
    if automation.task.precheck().is_none() { return true; }
    automation.precheck_approved && definition_identity(automation).is_some_and(|(hash, _)| automation.precheck_approved_hash.as_ref() == Some(&hash))
}

pub(super) fn approved_in_workspace(automation: &falcondeck_core::control::Automation, workspace: &str) -> bool {
    let Some(check) = automation.task.precheck() else { return true; };
    automation.target.run_as_bot.is_none() && automation.precheck_approved
        && automation.precheck_approved_hash.as_deref() == Some(approval_hash(check, workspace).as_str())
}

const OUTPUT_LIMIT: usize = 12_000;

pub(super) enum PrecheckOutcome {
    Skip,
    Continue(String),
}

// Drain even after the cap: verbose commands must not deadlock on a full pipe.
async fn drain(mut reader: impl AsyncRead + Unpin, captured: &mut Vec<u8>) -> std::io::Result<()> {
    let mut chunk = [0; 4096];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(());
        }
        let keep = count.min((OUTPUT_LIMIT + 1).saturating_sub(captured.len()));
        captured.extend_from_slice(&chunk[..keep]);
    }
}

fn output_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(OUTPUT_LIMIT)]);
    if bytes.len() > OUTPUT_LIMIT {
        format!("{text}\n[truncated]")
    } else {
        text.into_owned()
    }
}

#[cfg(unix)]
struct ProcessGroup(u32);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if let Ok(pid) = libc::pid_t::try_from(self.0) {
            // SAFETY: this is the dedicated process group created below. Kill
            // descendants too, including those holding inherited output pipes.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

/// Runs with no per-call approval: only an approved elevated definition may
/// reach here. Errors/timeouts proceed to the agent with diagnostic evidence.
pub(super) async fn run(check: &AutomationPrecheck, workspace: &str) -> PrecheckOutcome {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(&check.command)
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return PrecheckOutcome::Continue(format!("Pre-check could not start: {error}"));
        }
    };
    #[cfg(unix)]
    let group = ProcessGroup(child.id().expect("spawned child has a pid"));
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let mut out = Vec::new();
    let mut err = Vec::new();
    let execution = async {
        let (status, (), ()) = tokio::try_join!(
            child.wait(),
            drain(stdout, &mut out),
            drain(stderr, &mut err)
        )?;
        Ok::<_, std::io::Error>(status)
    };
    let result = timeout(Duration::from_secs(check.timeout_seconds), execution).await;
    #[cfg(unix)]
    drop(group);
    if result.is_err() {
        let _ = child.kill().await;
    }
    match result {
        Ok(Ok(status)) if status.success() && out.is_empty() => PrecheckOutcome::Skip,
        Ok(Ok(status)) => PrecheckOutcome::Continue(format!(
            "Pre-check exit code: {}\nstdout:\n{}\nstderr:\n{}",
            status
                .code()
                .map_or_else(|| "terminated by signal".into(), |code| code.to_string()),
            output_text(&out),
            output_text(&err)
        )),
        Ok(Err(error)) => PrecheckOutcome::Continue(format!("Pre-check failed: {error}")),
        Err(_) => PrecheckOutcome::Continue(format!(
            "Pre-check timed out after {} seconds (exit code unavailable).\nstdout:\n{}\nstderr:\n{}",
            check.timeout_seconds,
            output_text(&out),
            output_text(&err)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(command: &str) -> AutomationPrecheck {
        AutomationPrecheck {
            command: command.into(),
            timeout_seconds: 1,
        }
    }

    #[tokio::test]
    async fn zero_empty_skips_but_output_failure_and_whitespace_continue() {
        assert!(matches!(
            run(&check("exit 0"), "/tmp").await,
            PrecheckOutcome::Skip
        ));
        assert!(matches!(
            run(&check("echo diagnostic >&2"), "/tmp").await,
            PrecheckOutcome::Skip
        ));
        for (command, expected) in [
            ("printf finding", "finding"),
            ("exit 7", "exit code: 7"),
            ("printf ' '", "exit code: 0"),
        ] {
            let PrecheckOutcome::Continue(text) = run(&check(command), "/tmp").await else {
                panic!("must run agent");
            };
            assert!(text.contains(expected), "{text}");
        }
    }

    #[tokio::test]
    async fn workspace_timeout_spawn_errors_and_output_bounds() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("sentinel"), "").unwrap();
        assert!(matches!(
            run(&check("test -f sentinel"), dir.path().to_str().unwrap()).await,
            PrecheckOutcome::Skip
        ));
        let PrecheckOutcome::Continue(text) = run(&check("sleep 30 & wait"), "/tmp").await else {
            panic!();
        };
        assert!(text.contains("timed out"));
        assert!(matches!(
            run(&check("true"), "/nonexistent/falcondeck-test").await,
            PrecheckOutcome::Continue(_)
        ));
        let PrecheckOutcome::Continue(text) = run(&check("yes x | head -c 100000"), "/tmp").await
        else {
            panic!();
        };
        assert!(text.contains("[truncated]"));
        assert!(text.len() < 25_000);
    }
}
