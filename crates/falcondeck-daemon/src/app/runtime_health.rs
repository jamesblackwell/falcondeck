//! Warm-runtime lifecycle for agent processes.
//!
//! Codex keeps MCP subprocesses beneath its workspace app-server. Those are
//! useful during follow-up turns but become pure overhead once the workspace
//! has been quiet for a while. Each activated session owns one retirement
//! timer; the timer waits through a short warm grace period and then retires
//! the complete process group only when no Codex work is live or queued.

use std::sync::Arc;

use falcondeck_core::{AgentProvider, ThreadStatus};
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::{codex::CodexSession, error::DaemonError};

use super::{AppState, ManagedThread};

const CODEX_WARM_IDLE_GRACE: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const BUSY_RECHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_CONCURRENT_OPTIONAL_STARTS: usize = 2;
/// Codex resolves plugin MCP servers to versioned paths when the app-server
/// starts. The provider prunes that cache when it updates, so a warm runtime
/// can keep launching a deleted script on every new thread. Give a just-started
/// turn a moment to surface before deciding the runtime is quiet enough to
/// refresh.
const PLUGIN_REFRESH_SETTLE: std::time::Duration = std::time::Duration::from_secs(3);
/// One refresh attempt per workspace per cooldown; the provider re-reports an
/// MCP startup failure on every thread start, which would otherwise spawn a
/// retirement task per report.
const PLUGIN_REFRESH_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(60);

pub(super) struct RuntimeLifecycle {
    optional_start_slots: Semaphore,
}

impl Default for RuntimeLifecycle {
    fn default() -> Self {
        Self {
            optional_start_slots: Semaphore::new(MAX_CONCURRENT_OPTIONAL_STARTS),
        }
    }
}

impl RuntimeLifecycle {
    pub(super) async fn optional_start_permit(&self) -> Result<SemaphorePermit<'_>, DaemonError> {
        self.optional_start_slots
            .acquire()
            .await
            .map_err(|_| DaemonError::Process("optional runtime start gate closed".to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdleRetirement {
    Retired,
    Busy,
    Stale,
}

fn codex_work_keeps_runtime_live(
    provider: &AgentProvider,
    status: &ThreadStatus,
    has_queued_request: bool,
    is_dispatching_request: bool,
) -> bool {
    provider == &AgentProvider::CODEX
        && (matches!(
            status,
            ThreadStatus::Running | ThreadStatus::WaitingForInput
        ) || has_queued_request
            || is_dispatching_request)
}

fn codex_thread_keeps_runtime_live(thread: &ManagedThread) -> bool {
    codex_work_keeps_runtime_live(
        &thread.summary.provider,
        &thread.summary.status,
        !thread.queued_requests.is_empty(),
        thread.dispatching_request.is_some(),
    )
}

fn should_retire(idle_for: std::time::Duration, has_live_work: bool) -> bool {
    idle_for >= CODEX_WARM_IDLE_GRACE && !has_live_work
}

impl AppState {
    /// Starts the single retirement timer owned by an attached Codex session.
    /// Activity moves the deadline forward; a busy workspace is rechecked
    /// without creating another timer or another process monitor.
    pub(crate) fn schedule_codex_idle_retirement(&self, session: Arc<CodexSession>) {
        let app = self.clone();
        tokio::spawn(async move {
            loop {
                if app.is_shutting_down() || session.is_closed() {
                    return;
                }

                let idle_for = session.idle_for();
                if let Some(remaining) = CODEX_WARM_IDLE_GRACE.checked_sub(idle_for) {
                    tokio::time::sleep(remaining).await;
                }

                match app.retire_codex_session_if_idle(&session).await {
                    IdleRetirement::Retired | IdleRetirement::Stale => return,
                    IdleRetirement::Busy => {
                        tokio::time::sleep(BUSY_RECHECK_INTERVAL).await;
                    }
                }
            }
        });
    }

    /// Retires the session when its warm idle grace has elapsed and no work is
    /// live. See [`Self::retire_codex_session_if_quiet`].
    async fn retire_codex_session_if_idle(&self, session: &Arc<CodexSession>) -> IdleRetirement {
        self.retire_codex_session_if_quiet(session, true).await
    }

    /// Detaches the workspace's Codex app-server once no thread work is live.
    /// With `require_idle` the runtime must also have been quiet for the warm
    /// grace period; plugin refreshes drop that requirement because the runtime
    /// is already failing new threads and a fresh spawn resolves current
    /// provider-side plugin paths.
    async fn retire_codex_session_if_quiet(
        &self,
        session: &Arc<CodexSession>,
        require_idle: bool,
    ) -> IdleRetirement {
        // Existing operations hold shared leases. Exclusive acquisition means
        // every request that already resolved this session has completed, and
        // new callers will either observe the retained session or wake a new
        // one after the map entry is removed.
        let _retirement = session.retirement_guard().await;
        if session.is_closed() || self.is_shutting_down() {
            return IdleRetirement::Stale;
        }

        let removed = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get_mut(session.workspace_id()) else {
                return IdleRetirement::Stale;
            };
            let Some(attached) = workspace.codex_session.as_ref() else {
                return IdleRetirement::Stale;
            };
            if !Arc::ptr_eq(attached, session) {
                return IdleRetirement::Stale;
            }

            let has_live_work = workspace
                .threads
                .values()
                .any(codex_thread_keeps_runtime_live);
            if has_live_work {
                return IdleRetirement::Busy;
            }
            if require_idle && !should_retire(session.idle_for(), has_live_work) {
                return IdleRetirement::Busy;
            }
            workspace.codex_session.take()
        };

        let Some(session) = removed else {
            return IdleRetirement::Stale;
        };
        tracing::info!(
            workspace_id = %session.workspace_id(),
            idle_seconds = session.idle_for().as_secs(),
            forced = !require_idle,
            "stopping warm Codex runtime so the next use reconnects fresh"
        );
        let _ = session.shutdown().await;
        IdleRetirement::Retired
    }

    /// Retires a warm Codex runtime whose plugin MCP servers keep failing to
    /// start. The provider (Codex) resolves plugin servers such as
    /// `cua_repl` to versioned paths under its plugin cache when the
    /// app-server starts; when the provider updates and prunes that cache, the
    /// warm runtime keeps launching a deleted script and every new thread
    /// reports an MCP startup failure. Retiring the quiet runtime makes the
    /// next thread start reconnect with freshly resolved paths. A busy runtime
    /// is left alone; the next failure report retries after the cooldown.
    pub(crate) fn schedule_codex_plugin_refresh(&self, workspace_id: &str) {
        let now = std::time::Instant::now();
        {
            let mut attempts = self
                .inner
                .plugin_refresh_attempts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if attempts
                .get(workspace_id)
                .is_some_and(|last| now.duration_since(*last) < PLUGIN_REFRESH_COOLDOWN)
            {
                return;
            }
            attempts.insert(workspace_id.to_string(), now);
        }
        let app = self.clone();
        let workspace_id = workspace_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(PLUGIN_REFRESH_SETTLE).await;
            let session = {
                let workspaces = app.inner.workspaces.lock().await;
                let Some(workspace) = workspaces.get(&workspace_id) else {
                    return;
                };
                match workspace.codex_session.as_ref() {
                    Some(session) if !session.is_closed() => Arc::clone(session),
                    _ => return,
                }
            };
            match app.retire_codex_session_if_quiet(&session, false).await {
                IdleRetirement::Retired => {
                    // A healed refresh must not leave the startup warnings on
                    // screen; a still-broken server re-reports them.
                    app.clear_mcp_startup_conditions(&workspace_id);
                }
                // Busy: a live turn keeps the runtime; the next failure report
                // retries. Stale: the session was already replaced or closed.
                IdleRetirement::Busy | IdleRetirement::Stale => {}
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_runtime_stays_warm_during_grace_period() {
        assert!(!should_retire(
            CODEX_WARM_IDLE_GRACE - std::time::Duration::from_millis(1),
            false,
        ));
    }

    #[test]
    fn codex_runtime_retires_after_grace_without_live_work() {
        assert!(should_retire(CODEX_WARM_IDLE_GRACE, false));
    }

    #[test]
    fn live_work_prevents_codex_runtime_retirement() {
        assert!(!should_retire(
            CODEX_WARM_IDLE_GRACE + std::time::Duration::from_secs(60),
            true,
        ));
    }

    #[test]
    fn every_active_codex_state_keeps_the_runtime_live() {
        for (status, queued, dispatching) in [
            (ThreadStatus::Running, false, false),
            (ThreadStatus::WaitingForInput, false, false),
            (ThreadStatus::Idle, true, false),
            (ThreadStatus::Idle, false, true),
        ] {
            assert!(codex_work_keeps_runtime_live(
                &AgentProvider::CODEX,
                &status,
                queued,
                dispatching,
            ));
        }
    }

    #[test]
    fn an_idle_codex_thread_does_not_keep_the_runtime_live() {
        assert!(!codex_work_keeps_runtime_live(
            &AgentProvider::CODEX,
            &ThreadStatus::Idle,
            false,
            false,
        ));
    }

    #[test]
    fn another_provider_cannot_keep_the_codex_runtime_live() {
        assert!(!codex_work_keeps_runtime_live(
            &AgentProvider::CLAUDE,
            &ThreadStatus::Running,
            true,
            true,
        ));
    }
}
