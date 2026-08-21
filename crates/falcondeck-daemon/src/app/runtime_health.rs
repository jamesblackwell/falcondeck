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

    async fn retire_codex_session_if_idle(&self, session: &Arc<CodexSession>) -> IdleRetirement {
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
            if !should_retire(session.idle_for(), has_live_work) {
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
            "stopping warm Codex runtime after its idle grace period"
        );
        let _ = session.shutdown().await;
        IdleRetirement::Retired
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
