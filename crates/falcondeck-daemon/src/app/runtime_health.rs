//! Warm-runtime lifecycle for agent processes.
//!
//! Every provider that keeps a process alive between turns retires it the
//! same way: the runtime owns one timer, the timer waits out a warm grace
//! period, and it stops the process only when nothing that provider owns is
//! live or queued. Codex keeps MCP subprocesses beneath its workspace
//! app-server; ACP agents (Grok, Cursor, Gemini) keep one process per
//! workspace shared by every thread; native OpenCode keeps an
//! `opencode serve`. Claude and agy spawn a CLI per turn and need no timer.
//!
//! Grace periods differ because restart costs differ, not because the
//! providers differ in kind. A runtime that has only answered the composer's
//! model-catalog hydration has no conversation to lose and retires quickly.

use std::sync::Arc;

use falcondeck_core::{AgentProvider, ThreadStatus};
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::{acp::AcpRuntime, codex::CodexSession, error::DaemonError, opencode::OpenCodeRuntime};

use super::{AppState, ManagedThread};

const CODEX_WARM_IDLE_GRACE: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// Restarting an ACP agent costs more than reconnecting Codex: process spawn,
/// the `initialize` handshake, model-catalog discovery, and a `session/load`
/// replay of the thread's history streamed back through the event pump. The
/// longer window keeps that off the path of anyone still working.
const ACP_WARM_IDLE_GRACE: std::time::Duration = std::time::Duration::from_secs(20 * 60);
/// Native OpenCode restarts more cheaply than an ACP agent — sessions live in
/// the server's own store rather than in process memory — but still pays a
/// server boot and a catalog refetch.
const OPENCODE_WARM_IDLE_GRACE: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// Opening the composer's model menu starts a provider purely to read its
/// catalog. Such a runtime holds no conversation, so it goes almost at once.
const HYDRATION_ONLY_IDLE_GRACE: std::time::Duration = std::time::Duration::from_secs(2 * 60);
const BUSY_RECHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
/// Retirement must never queue behind a long request. Failing to take the
/// exclusive lease quickly means the runtime is working, which is a recheck
/// rather than a retirement.
const RETIREMENT_LEASE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
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

fn work_keeps_runtime_live(
    runtime_provider: &AgentProvider,
    thread_provider: &AgentProvider,
    status: &ThreadStatus,
    has_queued_request: bool,
    is_dispatching_request: bool,
) -> bool {
    thread_provider == runtime_provider
        && (matches!(
            status,
            ThreadStatus::Running | ThreadStatus::WaitingForInput
        ) || has_queued_request
            || is_dispatching_request)
}

/// Whether one thread's state pins the warm runtime serving its provider.
/// A runtime is shared by every thread for its provider in the workspace, so
/// a single live thread vetoes retirement for all of them.
pub(super) fn thread_keeps_runtime_live(thread: &ManagedThread, provider: &AgentProvider) -> bool {
    work_keeps_runtime_live(
        provider,
        &thread.summary.provider,
        &thread.summary.status,
        !thread.queued_requests.is_empty(),
        thread.dispatching_request.is_some(),
    )
}

pub(super) fn codex_thread_keeps_runtime_live(thread: &ManagedThread) -> bool {
    // A started-but-unpersisted Codex turn has no status to read yet; losing
    // the runtime beneath it would strand the turn.
    thread.has_unpersisted_codex_start() || thread_keeps_runtime_live(thread, &AgentProvider::CODEX)
}

fn should_retire(
    idle_for: std::time::Duration,
    grace: std::time::Duration,
    has_live_work: bool,
) -> bool {
    idle_for >= grace && !has_live_work
}

/// The warm window for a runtime, shortened when it has never served a turn.
fn warm_grace(served_prompt: bool, served_grace: std::time::Duration) -> std::time::Duration {
    if served_prompt {
        served_grace
    } else {
        HYDRATION_ONLY_IDLE_GRACE
    }
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
            if require_idle
                && !should_retire(session.idle_for(), CODEX_WARM_IDLE_GRACE, has_live_work)
            {
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

    /// Starts the retirement timer owned by one warm ACP agent process.
    ///
    /// The process is shared by every thread for its provider in this
    /// workspace, so the timer retires it only once none of them is working.
    /// The next use spawns a fresh process and resumes each thread with
    /// `session/load`, which is the same recovery the daemon already performs
    /// after a restart.
    pub(crate) fn schedule_acp_idle_retirement(
        &self,
        workspace_id: &str,
        provider: &AgentProvider,
        runtime: Arc<AcpRuntime>,
    ) {
        let app = self.clone();
        let workspace_id = workspace_id.to_string();
        let provider = provider.clone();
        tokio::spawn(async move {
            loop {
                if app.is_shutting_down() || runtime.is_closed() {
                    return;
                }
                let grace = warm_grace(runtime.served_prompt(), ACP_WARM_IDLE_GRACE);
                if let Some(remaining) = grace.checked_sub(runtime.idle_for()) {
                    tokio::time::sleep(remaining).await;
                    // The window lengthens the moment a hydration-only
                    // runtime serves its first turn, so re-derive it rather
                    // than retiring on the window this sleep was sized for.
                    continue;
                }
                match app
                    .retire_acp_runtime_if_idle(&workspace_id, &provider, &runtime)
                    .await
                {
                    IdleRetirement::Retired | IdleRetirement::Stale => return,
                    IdleRetirement::Busy => {
                        tokio::time::sleep(BUSY_RECHECK_INTERVAL).await;
                    }
                }
            }
        });
    }

    /// Stops a quiet ACP process and drops it from the workspace, so the next
    /// use starts one fresh.
    async fn retire_acp_runtime_if_idle(
        &self,
        workspace_id: &str,
        provider: &AgentProvider,
        runtime: &Arc<AcpRuntime>,
    ) -> IdleRetirement {
        // Exclusive acquisition means every request that already resolved
        // this runtime has settled, and a caller arriving later either sees
        // the retained runtime or wakes a new one once the map entry is gone.
        let Ok(_retirement) =
            tokio::time::timeout(RETIREMENT_LEASE_TIMEOUT, runtime.retirement_guard()).await
        else {
            return IdleRetirement::Busy;
        };
        if runtime.is_closed() || self.is_shutting_down() {
            return IdleRetirement::Stale;
        }

        // An agent that cannot replay a session would come back having
        // forgotten the conversation. Losing a catalog-only process costs
        // nothing, so only a runtime actually holding sessions opts out.
        if runtime.has_sessions().await && !runtime.supports_load_session().await {
            tracing::debug!(
                provider = %provider,
                workspace_id = %workspace_id,
                "keeping warm ACP runtime: the agent cannot resume its sessions"
            );
            return IdleRetirement::Stale;
        }
        // A prompt in flight keeps its thread Running, but background work
        // (metadata discovery, a capability probe) has no thread at all.
        if runtime.has_requests_in_flight().await || runtime.has_open_user_requests().await {
            return IdleRetirement::Busy;
        }

        let removed = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get_mut(workspace_id) else {
                return IdleRetirement::Stale;
            };
            if !workspace
                .acp_runtimes
                .get(provider)
                .is_some_and(|attached| Arc::ptr_eq(attached, runtime))
            {
                return IdleRetirement::Stale;
            }
            let has_live_work = workspace
                .threads
                .values()
                .any(|thread| thread_keeps_runtime_live(thread, provider));
            let grace = warm_grace(runtime.served_prompt(), ACP_WARM_IDLE_GRACE);
            if !should_retire(runtime.idle_for(), grace, has_live_work) {
                return IdleRetirement::Busy;
            }
            workspace.acp_runtimes.remove(provider)
        };

        let Some(runtime) = removed else {
            return IdleRetirement::Stale;
        };
        tracing::info!(
            provider = %provider,
            workspace_id = %workspace_id,
            idle_seconds = runtime.idle_for().as_secs(),
            served_prompt = runtime.served_prompt(),
            "stopping warm ACP runtime so the next use starts fresh"
        );
        if let (Some(state_dir), Some(child_pid)) = (self.state_dir(), runtime.child_pid()) {
            crate::agent_orphans::forget(
                &state_dir,
                crate::agent_orphans::ACP_REGISTRY_FILE,
                child_pid,
            );
        }
        runtime.shutdown().await;
        IdleRetirement::Retired
    }

    /// Starts the retirement timer owned by one warm `opencode serve`.
    /// Sessions live in the server's own store, so a retired server loses no
    /// conversation; the next use spawns one and reattaches.
    pub(crate) fn schedule_opencode_idle_retirement(
        &self,
        workspace_id: &str,
        runtime: Arc<OpenCodeRuntime>,
    ) {
        let app = self.clone();
        let workspace_id = workspace_id.to_string();
        tokio::spawn(async move {
            loop {
                if app.is_shutting_down() {
                    return;
                }
                let grace = warm_grace(runtime.served_prompt(), OPENCODE_WARM_IDLE_GRACE);
                if let Some(remaining) = grace.checked_sub(runtime.idle_for()) {
                    tokio::time::sleep(remaining).await;
                    continue;
                }
                match app
                    .retire_opencode_runtime_if_idle(&workspace_id, &runtime)
                    .await
                {
                    IdleRetirement::Retired | IdleRetirement::Stale => return,
                    IdleRetirement::Busy => {
                        tokio::time::sleep(BUSY_RECHECK_INTERVAL).await;
                    }
                }
            }
        });
    }

    async fn retire_opencode_runtime_if_idle(
        &self,
        workspace_id: &str,
        runtime: &Arc<OpenCodeRuntime>,
    ) -> IdleRetirement {
        let removed = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get_mut(workspace_id) else {
                return IdleRetirement::Stale;
            };
            if !workspace
                .opencode_runtime
                .as_ref()
                .is_some_and(|attached| Arc::ptr_eq(attached, runtime))
            {
                return IdleRetirement::Stale;
            }
            let has_live_work = workspace
                .threads
                .values()
                .any(|thread| thread_keeps_runtime_live(thread, &AgentProvider::OPENCODE));
            let grace = warm_grace(runtime.served_prompt(), OPENCODE_WARM_IDLE_GRACE);
            if !should_retire(runtime.idle_for(), grace, has_live_work) {
                return IdleRetirement::Busy;
            }
            workspace.opencode_runtime.take()
        };

        let Some(runtime) = removed else {
            return IdleRetirement::Stale;
        };
        tracing::info!(
            workspace_id = %workspace_id,
            idle_seconds = runtime.idle_for().as_secs(),
            served_prompt = runtime.served_prompt(),
            "stopping warm OpenCode server so the next use starts fresh"
        );
        if let (Some(state_dir), Some(server_pid)) = (self.state_dir(), runtime.server_pid()) {
            crate::opencode::forget_server_process(&state_dir, server_pid);
        }
        runtime.shutdown().await;
        IdleRetirement::Retired
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GROK: &str = "grok";

    #[test]
    fn codex_runtime_stays_warm_during_grace_period() {
        assert!(!should_retire(
            CODEX_WARM_IDLE_GRACE - std::time::Duration::from_millis(1),
            CODEX_WARM_IDLE_GRACE,
            false,
        ));
    }

    #[test]
    fn codex_runtime_retires_after_grace_without_live_work() {
        assert!(should_retire(
            CODEX_WARM_IDLE_GRACE,
            CODEX_WARM_IDLE_GRACE,
            false
        ));
    }

    #[test]
    fn live_work_prevents_codex_runtime_retirement() {
        assert!(!should_retire(
            CODEX_WARM_IDLE_GRACE + std::time::Duration::from_secs(60),
            CODEX_WARM_IDLE_GRACE,
            true,
        ));
    }

    #[test]
    fn every_active_state_keeps_its_provider_runtime_live() {
        for (status, queued, dispatching) in [
            (ThreadStatus::Running, false, false),
            (ThreadStatus::WaitingForInput, false, false),
            (ThreadStatus::Idle, true, false),
            (ThreadStatus::Idle, false, true),
        ] {
            assert!(work_keeps_runtime_live(
                &AgentProvider::CODEX,
                &AgentProvider::CODEX,
                &status,
                queued,
                dispatching,
            ));
            assert!(work_keeps_runtime_live(
                &AgentProvider::new(GROK.to_string()),
                &AgentProvider::new(GROK.to_string()),
                &status,
                queued,
                dispatching,
            ));
        }
    }

    #[test]
    fn an_idle_thread_does_not_keep_the_runtime_live() {
        assert!(!work_keeps_runtime_live(
            &AgentProvider::CODEX,
            &AgentProvider::CODEX,
            &ThreadStatus::Idle,
            false,
            false,
        ));
    }

    #[test]
    fn another_provider_cannot_keep_a_runtime_live() {
        assert!(!work_keeps_runtime_live(
            &AgentProvider::CODEX,
            &AgentProvider::CLAUDE,
            &ThreadStatus::Running,
            true,
            true,
        ));
        // A busy Grok thread must not pin Cursor's process, and vice versa:
        // one ACP runtime per provider means the check is per provider too.
        assert!(!work_keeps_runtime_live(
            &AgentProvider::new("cursor".to_string()),
            &AgentProvider::new(GROK.to_string()),
            &ThreadStatus::Running,
            true,
            true,
        ));
    }

    #[test]
    fn a_runtime_that_never_served_a_turn_retires_on_the_short_grace() {
        assert_eq!(
            warm_grace(false, ACP_WARM_IDLE_GRACE),
            HYDRATION_ONLY_IDLE_GRACE
        );
        assert!(should_retire(
            HYDRATION_ONLY_IDLE_GRACE,
            warm_grace(false, ACP_WARM_IDLE_GRACE),
            false,
        ));
    }

    #[test]
    fn serving_a_turn_lengthens_the_warm_window() {
        assert_eq!(warm_grace(true, ACP_WARM_IDLE_GRACE), ACP_WARM_IDLE_GRACE);
        assert_eq!(
            warm_grace(true, OPENCODE_WARM_IDLE_GRACE),
            OPENCODE_WARM_IDLE_GRACE
        );
        // The window a hydration-only runtime would have retired on is not
        // enough once the runtime holds a conversation.
        assert!(!should_retire(
            HYDRATION_ONLY_IDLE_GRACE,
            warm_grace(true, ACP_WARM_IDLE_GRACE),
            false,
        ));
    }

    #[test]
    fn every_warm_grace_outlasts_the_hydration_only_window() {
        for grace in [
            CODEX_WARM_IDLE_GRACE,
            ACP_WARM_IDLE_GRACE,
            OPENCODE_WARM_IDLE_GRACE,
        ] {
            assert!(grace > HYDRATION_ONLY_IDLE_GRACE);
        }
    }
}
