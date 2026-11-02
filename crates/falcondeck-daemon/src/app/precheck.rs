//! Standalone provider command execution: no thread/start or turn/start.
use super::{AppState, workspace_ops::sandbox_policy_payload};
use crate::control::precheck::{OUTPUT_LIMIT, bounded, checked_cwd, validate};
use chrono::Utc;
use falcondeck_core::control::{AutomationPrecheck, AutomationPrecheckResult, AutomationTarget};
use serde_json::json;
use tokio::time::{Duration, timeout};

impl AppState {
    pub(crate) async fn automation_precheck(
        &self,
        workspace_id: &str,
        check: &AutomationPrecheck,
        target: &AutomationTarget,
    ) -> AutomationPrecheckResult {
        let mut result = AutomationPrecheckResult {
            checked_at: Utc::now(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: None,
            output_truncated: false,
            failure_dispatched: false,
        };
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(u64::from(check.timeout_seconds));
        let execution = async {
            validate(Some(check), target).map_err(|e| e.0.message)?;
            let cwd = checked_cwd(check, target).map_err(|e| e.0.message)?;
            // A reused thread can retain a checkout or cloud target that is
            // not represented by the automation's project-folder setting.
            let existing = match &target.thread {
                falcondeck_core::control::AutomationThreadTarget::Existing { thread_id }
                | falcondeck_core::control::AutomationThreadTarget::Managed {
                    thread_id: Some(thread_id),
                } => Some(thread_id),
                _ => None,
            };
            if let Some(id) = existing
                && let Ok(thread) = self.thread_summary(workspace_id, id).await
            {
                if thread.variant.is_some()
                    || thread.execution_target != falcondeck_core::ThreadExecutionTarget::Local
                {
                    return Err(
                        "precheck cannot run for a reused isolated or cloud thread".to_string()
                    );
                }
                if target.approval_policy.is_none() {
                    let mut effective = target.clone();
                    effective.approval_policy = thread.agent.approval_policy;
                    validate(Some(check), &effective).map_err(|e| e.0.message)?;
                }
            }
            let session = tokio::time::timeout_at(deadline, self.session_for(workspace_id))
                .await
                .map_err(|_| "precheck provider startup timed out".to_string())?
                .map_err(|e| e.to_string())?;
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let process_id = format!("precheck-{}", uuid::Uuid::new_v4());
            let policy = sandbox_policy_payload(
                target.sandbox_mode.as_deref(),
                &[target.workspace_path.clone()],
            );
            // command/exec uses the same provider sandbox and computed environment
            // as a turn. No env overrides, connector secrets, shell or escalation.
            let request = session.send_request(
                "command/exec",
                json!({
                    "command": check.argv, "cwd": cwd, "sandboxPolicy": policy,
                    "timeoutMs": remaining.as_millis().max(1) as u64,
                    "outputBytesCap": OUTPUT_LIMIT / 2,
                    "processId": process_id,
                }),
            );
            let value = match tokio::time::timeout_at(deadline, request).await {
                Ok(value) => value.map_err(|e| e.to_string())?,
                Err(_) => {
                    // Terminate only this command, never the shared app-server.
                    let _ = timeout(
                        Duration::from_secs(2),
                        session.send_request(
                            "command/exec/terminate",
                            json!({"processId": process_id}),
                        ),
                    )
                    .await;
                    return Err("precheck timed out".to_string());
                }
            };
            let code = value
                .get("exitCode")
                .and_then(|v| v.as_i64())
                .and_then(|v| i32::try_from(v).ok())
                .ok_or_else(|| "precheck provider returned no exitCode".to_string())?;
            Ok((
                code,
                bounded(
                    value["stdout"].as_str().unwrap_or_default(),
                    OUTPUT_LIMIT / 2,
                ),
                bounded(
                    value["stderr"].as_str().unwrap_or_default(),
                    OUTPUT_LIMIT / 2,
                ),
            ))
        };
        // Includes provider startup. Unsupported/older command APIs fail closed.
        match execution.await {
            Ok((code, stdout, stderr)) => {
                result.exit_code = Some(code);
                result.output_truncated =
                    stdout.len() >= OUTPUT_LIMIT / 2 || stderr.len() >= OUTPUT_LIMIT / 2;
                result.stdout = stdout;
                result.stderr = stderr;
                if code == 124 {
                    result.error = Some("precheck timed out (exit 124)".into());
                } else if code != 0 && !check.fire_codes.contains(&code) {
                    result.error = Some(format!("precheck failed with exit {code}"));
                }
            }
            Err(error) => result.error = Some(bounded(&error, OUTPUT_LIMIT)),
        }
        result.checked_at = Utc::now();
        result
    }
}
