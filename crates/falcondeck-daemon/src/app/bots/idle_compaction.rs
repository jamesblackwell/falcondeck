//! Warm-cache maintenance for active Claude bot homes only.
use super::*;
use chrono::{DateTime, Utc};
use falcondeck_core::{CompactThreadRequest, ThreadSummary};

const IDLE_MINUTES: i64 = 50;
// Leave startup headroom before the measured one-hour cache expiry. In
// particular, never catch up after sleep or compact stale restored counters.
const LATEST_CACHE_AGE_MINUTES: i64 = 55;
const MIN_CONTEXT: u64 = 150_000;

fn eligible(
    thread: &ThreadSummary,
    context: Option<u64>,
    last_call: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    thread.provider == AgentProvider::CLAUDE
        && thread.status == ThreadStatus::Idle
        && !thread.is_archived
        && thread.native_session_id.is_some()
        && thread.queued_turns.is_empty()
        && now.signed_duration_since(thread.updated_at).num_seconds() >= IDLE_MINUTES * 60
        && context.is_some_and(|tokens| tokens >= MIN_CONTEXT)
        && last_call.is_some_and(|at| {
            let seconds = now.signed_duration_since(at).num_seconds();
            (IDLE_MINUTES * 60..LATEST_CACHE_AGE_MINUTES * 60).contains(&seconds)
        })
}

impl AppState {
    pub(crate) async fn compact_idle_bot_homes(&self) {
        let preferences = self.preferences().await;
        if !preferences.bot_idle_compaction_enabled {
            return;
        }
        for bot in preferences
            .bots
            .into_iter()
            .filter(|b| b.status == BotStatus::Active)
        {
            if !self
                .idle_bot_compaction_due(&bot.workspace_id, &bot.thread_id)
                .await
            {
                continue;
            }
            let app = self.clone();
            self.spawn_background_task(async move {
                let request = CompactThreadRequest {
                    workspace_id: bot.workspace_id,
                    thread_id: bot.thread_id,
                    instructions: None,
                };
                if let Err(error) = workspace_ops::compact_thread_checked(&app, request, true).await
                {
                    tracing::warn!(%error, "idle bot compaction failed");
                }
            });
        }
    }

    /// Re-evaluated inside the same variant/admission gate as a user send.
    pub(in crate::app) async fn idle_bot_compaction_due(
        &self,
        workspace: &str,
        thread: &str,
    ) -> bool {
        let prefs = self.preferences().await;
        if !prefs.bot_idle_compaction_enabled
            || !prefs.bots.iter().any(|b| {
                b.workspace_id == workspace
                    && b.thread_id == thread
                    && b.status == BotStatus::Active
            })
        {
            return false;
        }
        let workspaces = self.inner.workspaces.lock().await;
        let Some(managed) = workspaces
            .get(workspace)
            .and_then(|ws| ws.threads.get(thread))
        else {
            return false;
        };
        if !managed.queued_requests.is_empty() || managed.dispatching_request.is_some() {
            return false;
        }
        let last_call = self
            .inner
            .thread_token_usage
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(thread)
            .and_then(|usage| usage.updated_at);
        eligible(
            &managed.summary,
            self.thread_context_tokens(thread, &managed.summary.provider),
            last_call,
            Utc::now(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn home(now: DateTime<Utc>) -> ThreadSummary {
        serde_json::from_value(serde_json::json!({
            "id": "home", "workspace_id": "workspace", "title": "Home",
            "provider": "claude", "native_session_id": "session", "status": "idle",
            "created_at": now, "updated_at": now - Duration::minutes(50),
            "archived": false, "agent": {}
        }))
        .unwrap()
    }

    #[test]
    fn only_large_warm_idle_homes_qualify() {
        let now = Utc::now();
        let mut thread = home(now);
        let call = Some(now - Duration::minutes(50));
        assert!(eligible(&thread, Some(150_000), call, now));
        assert!(!eligible(&thread, Some(149_999), call, now));
        assert!(!eligible(&thread, None, call, now));
        assert!(!eligible(&thread, Some(150_000), None, now));
        for minutes in [49, 55, 60, 200, -1] {
            assert!(!eligible(
                &thread,
                Some(150_000),
                Some(now - Duration::minutes(minutes)),
                now
            ));
        }
        for status in [
            ThreadStatus::Running,
            ThreadStatus::WaitingForInput,
            ThreadStatus::Error,
        ] {
            thread.status = status;
            assert!(!eligible(&thread, Some(150_000), call, now));
        }
        thread.status = ThreadStatus::Idle;
        thread.is_archived = true;
        assert!(!eligible(&thread, Some(150_000), call, now));
        thread.is_archived = false;
        thread.updated_at = now;
        assert!(!eligible(&thread, Some(150_000), call, now));
        thread.updated_at = now - Duration::minutes(50);
        thread.provider = AgentProvider::CODEX;
        assert!(!eligible(&thread, Some(150_000), call, now));
    }
}
