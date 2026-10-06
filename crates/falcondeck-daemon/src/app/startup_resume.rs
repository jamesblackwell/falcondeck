use falcondeck_core::SendTurnRequest;

use super::{
    AppState, PersistedWorkspaceState, is_shutdown_interrupted, persisted_turn_was_cut_off,
};

impl AppState {
    /// Queue recovery only for sessions interrupted in the state this boot restored.
    pub(super) async fn spawn_interrupted_thread_resume(
        &self,
        workspace: &PersistedWorkspaceState,
    ) {
        if !self
            .inner
            .preferences
            .lock()
            .await
            .auto_resume_interrupted_sessions
        {
            return;
        }
        let thread_ids: Vec<_> = workspace
            .thread_states
            .iter()
            .filter(|thread| {
                persisted_turn_was_cut_off(thread.status.as_ref(), thread.last_error.as_deref())
            })
            .map(|thread| thread.thread_id.clone())
            .collect();
        if thread_ids.is_empty() {
            return;
        }
        let app = self.clone();
        let path = workspace.path.clone();
        tokio::spawn(async move {
            app.resume_interrupted_threads_after_restore(&path, &thread_ids)
                .await;
        });
    }

    async fn resume_interrupted_threads_after_restore(&self, path: &str, thread_ids: &[String]) {
        // Recovery is independent of UI windows and workspace discovery. Avoid a
        // burst of cold CLI starts, including projects restored after a timeout.
        let _gate = self.inner.interrupted_resume_gate.lock().await;
        for thread_id in thread_ids {
            if self.is_shutting_down()
                || !self
                    .inner
                    .preferences
                    .lock()
                    .await
                    .auto_resume_interrupted_sessions
            {
                return;
            }
            let request = {
                let workspaces = self.inner.workspaces.lock().await;
                let Some(workspace) = workspaces
                    .values()
                    .find(|workspace| workspace.summary.path == path)
                else {
                    return;
                };
                let Some(thread) = workspace
                    .threads
                    .get(thread_id)
                    .map(|thread| &thread.summary)
                else {
                    continue;
                };
                // The user may already have continued, stopped, or archived a
                // session while its project was reconnecting.
                if thread.is_archived
                    || !is_shutdown_interrupted(&thread.status, thread.last_error.as_deref())
                {
                    continue;
                }
                SendTurnRequest {
                    workspace_id: workspace.summary.id.clone(),
                    thread_id: thread.id.clone(),
                    inputs: Vec::new(),
                    selected_skills: Vec::new(),
                    provider: Some(thread.provider.clone()),
                    model_id: thread.agent.model_id.clone(),
                    reasoning_effort: thread.agent.reasoning_effort.clone(),
                    approval_policy: thread.agent.approval_policy.clone(),
                    service_tier: thread.agent.service_tier.clone(),
                    permission_mode: thread.agent.permission_mode.clone(),
                    sandbox_mode: thread.agent.sandbox_mode.clone(),
                    steer: false,
                    user_item_id: None,
                    resume_interrupted: true,
                }
            };
            // The normal resume path verifies the native session and refuses
            // blank replacements. Failed sessions keep their recovery notice.
            if let Err(error) = self.send_turn(request).await {
                tracing::warn!(%thread_id, "automatic session resume failed: {error}");
            }
        }
    }
}
