//! Cheap, tool-free provider runs used for FalconDeck's own background work.
//!
//! Thread titles are short, frequent, and invisible until they land, so they
//! never spend a user-facing session: they shell out to whichever agent CLI
//! the user already has installed, on the cheapest model that provider
//! offers, and fall back down a preference-ordered chain when a provider is
//! missing, unauthenticated, or fails.

use std::process::Stdio;

use falcondeck_core::{AccountStatus, AgentProvider};
use tokio::{
    fs,
    process::Command,
    time::{Duration, timeout},
};
use uuid::Uuid;

use super::AppState;
use crate::agent_binary::{preferred_command_path, strip_terminal_advertising_env};

/// A provider that is configured, authenticated, and worth trying.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UtilityCandidate {
    /// Provider to shell out to.
    pub provider: AgentProvider,
    /// Model id to request, or `None` for the provider's own default.
    pub model_id: Option<String>,
}

impl AppState {
    /// Providers to try, in preference order, that this workspace can actually
    /// run. Ordering comes from preferences; readiness comes from the
    /// workspace's own agent list, so an uninstalled CLI is skipped rather
    /// than spawned and timed out.
    pub(super) async fn utility_model_candidates(
        &self,
        workspace_id: &str,
    ) -> Vec<UtilityCandidate> {
        let preferences = self.inner.preferences.lock().await.utility_models.clone();
        let ready = {
            let workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get(workspace_id) else {
                return Vec::new();
            };
            workspace
                .summary
                .agents
                .iter()
                .filter(|agent| matches!(agent.account.status, AccountStatus::Ready))
                .map(|agent| agent.provider.clone())
                .collect::<Vec<_>>()
        };

        preferences
            .provider_order
            .iter()
            .filter(|provider| ready.contains(provider))
            .map(|provider| UtilityCandidate {
                provider: provider.clone(),
                model_id: preferences.model_for(provider).map(str::to_string),
            })
            .collect()
    }

    /// Runs one prompt against the first candidate that answers. Every failure
    /// mode — missing binary, auth expiry, timeout, empty output — falls
    /// through to the next provider instead of failing the caller.
    pub(super) async fn run_utility_prompt(
        &self,
        candidates: &[UtilityCandidate],
        workspace_path: &str,
        prompt: &str,
        run_timeout: Duration,
    ) -> Option<String> {
        for candidate in candidates {
            let text = self
                .run_utility_prompt_with(candidate, workspace_path, prompt, run_timeout)
                .await;
            if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
                return Some(text);
            }
        }
        None
    }

    async fn run_utility_prompt_with(
        &self,
        candidate: &UtilityCandidate,
        workspace_path: &str,
        prompt: &str,
        run_timeout: Duration,
    ) -> Option<String> {
        match candidate.provider.as_str() {
            "claude" => {
                self.run_claude_utility_prompt(candidate, workspace_path, prompt, run_timeout)
                    .await
            }
            "codex" => {
                self.run_codex_utility_prompt(candidate, workspace_path, prompt, run_timeout)
                    .await
            }
            "opencode" => {
                self.run_opencode_utility_prompt(candidate, workspace_path, prompt, run_timeout)
                    .await
            }
            "grok" => {
                self.run_grok_utility_prompt(candidate, workspace_path, prompt, run_timeout)
                    .await
            }
            _ => None,
        }
    }

    async fn run_claude_utility_prompt(
        &self,
        candidate: &UtilityCandidate,
        workspace_path: &str,
        prompt: &str,
        run_timeout: Duration,
    ) -> Option<String> {
        let resolved = self.resolve_provider_binary(&candidate.provider);
        let mut command = Command::new(&resolved.executable);
        command
            .arg("-p")
            .arg(prompt)
            .arg("--output-format")
            .arg("text")
            .arg("--tools")
            .arg("")
            .arg("--no-session-persistence");
        if let Some(model_id) = candidate.model_id.as_deref() {
            command.arg("--model").arg(model_id);
        }
        command
            .current_dir(workspace_path)
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        if let Some(path) = preferred_command_path(&resolved.executable) {
            command.env("PATH", path);
        }
        strip_terminal_advertising_env(&mut command);
        let output = timeout(run_timeout, command.output()).await.ok()?.ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    async fn run_codex_utility_prompt(
        &self,
        candidate: &UtilityCandidate,
        workspace_path: &str,
        prompt: &str,
        run_timeout: Duration,
    ) -> Option<String> {
        let resolved = self.resolve_provider_binary(&candidate.provider);
        // `codex exec` prints its transcript to stdout; `-o` is the only way to
        // read back the final message alone.
        let output_path = std::env::temp_dir().join(format!(
            "falcondeck-utility-{}.txt",
            Uuid::new_v4().simple()
        ));
        let mut command = Command::new(&resolved.executable);
        command
            .arg("exec")
            .arg("--skip-git-repo-check")
            .arg("--ephemeral")
            .arg("--color")
            .arg("never")
            .arg("-s")
            .arg("read-only");
        if let Some(model_id) = candidate.model_id.as_deref() {
            command.arg("-m").arg(model_id);
        }
        command
            .arg("-o")
            .arg(&output_path)
            .arg(prompt)
            .current_dir(workspace_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(path) = preferred_command_path(&resolved.executable) {
            command.env("PATH", path);
        }
        strip_terminal_advertising_env(&mut command);
        let output = timeout(run_timeout, command.output()).await.ok()?.ok()?;
        if !output.status.success() {
            let _ = fs::remove_file(&output_path).await;
            return None;
        }
        let generated = fs::read_to_string(&output_path).await.ok();
        let _ = fs::remove_file(&output_path).await;
        generated
    }

    async fn run_opencode_utility_prompt(
        &self,
        candidate: &UtilityCandidate,
        workspace_path: &str,
        prompt: &str,
        run_timeout: Duration,
    ) -> Option<String> {
        let resolved = self.resolve_provider_binary(&candidate.provider);
        let mut command = Command::new(&resolved.executable);
        command.arg("run").arg("--format").arg("default");
        if let Some(model_id) = candidate.model_id.as_deref() {
            command.arg("-m").arg(model_id);
        }
        command
            .arg(prompt)
            .current_dir(workspace_path)
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        if let Some(path) = preferred_command_path(&resolved.executable) {
            command.env("PATH", path);
        }
        strip_terminal_advertising_env(&mut command);
        let output = timeout(run_timeout, command.output()).await.ok()?.ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    async fn run_grok_utility_prompt(
        &self,
        candidate: &UtilityCandidate,
        workspace_path: &str,
        prompt: &str,
        run_timeout: Duration,
    ) -> Option<String> {
        let resolved = self.resolve_provider_binary(&candidate.provider);
        let mut command = Command::new(&resolved.executable);
        command
            .arg("-p")
            .arg(prompt)
            .arg("--output-format")
            .arg("plain")
            .arg("--max-turns")
            .arg("1")
            .arg("--disable-web-search");
        if let Some(model_id) = candidate.model_id.as_deref() {
            command.arg("-m").arg(model_id);
        }
        command
            .arg("--cwd")
            .arg(workspace_path)
            .current_dir(workspace_path)
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        if let Some(path) = preferred_command_path(&resolved.executable) {
            command.env("PATH", path);
        }
        strip_terminal_advertising_env(&mut command);
        let output = timeout(run_timeout, command.output()).await.ok()?.ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}
