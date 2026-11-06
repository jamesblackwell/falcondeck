//! Human input attribution across a non-transactional provider boundary.
use super::*;

/// Transport failures do not prove rejection: the provider may already have
/// consumed a human input. Preserve eligibility in that uncertain case.
pub(super) fn definite_input_rejection(error: &DaemonError) -> bool {
    match error {
        DaemonError::BadRequest(_) | DaemonError::NotFound(_) | DaemonError::Conflict(_) => true,
        DaemonError::Rpc(message) => ![
            "failed to send",
            "disconnected",
            "no longer running",
            "did not respond",
            "shutting down",
        ]
        .iter()
        .any(|transport| message.contains(transport)),
        _ => false,
    }
}

impl AppState {
    /// Publish and persist before releasing the provider: it can complete the
    /// turn before acknowledging a steer or interactive response.
    pub(super) async fn begin_user_reply(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Uuid, DaemonError> {
        let claim = Uuid::new_v4();
        {
            let mut workspaces = self.inner.workspaces.lock().await;
            let thread = workspaces
                .get_mut(workspace_id)
                .and_then(|workspace| workspace.threads.get_mut(thread_id))
                .ok_or_else(|| DaemonError::NotFound("thread not found".into()))?;
            if thread.reply_source_pending.is_empty() {
                thread.reply_source_base = thread.summary.attention.reply_to_user;
            }
            thread.reply_source_pending.insert(claim);
            thread.summary.attention.reply_to_user = true;
        }
        if let Err(error) = self.persist_local_state().await {
            let _ = self
                .finish_user_reply(workspace_id, thread_id, claim, false)
                .await;
            return Err(error);
        }
        self.publish_reply_source(workspace_id, thread_id).await;
        Ok(claim)
    }

    /// A rejection removes only its own provisional claim. Another accepted
    /// human input, or a newer logical turn, must not be overwritten.
    pub(super) async fn finish_user_reply(
        &self,
        workspace_id: &str,
        thread_id: &str,
        claim: Uuid,
        accepted: bool,
    ) -> Result<(), DaemonError> {
        {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(thread) = workspaces
                .get_mut(workspace_id)
                .and_then(|workspace| workspace.threads.get_mut(thread_id))
            else {
                return Ok(());
            };
            if !thread.reply_source_pending.remove(&claim) {
                return Ok(());
            }
            thread.reply_source_base |= accepted;
            thread.summary.attention.reply_to_user =
                thread.reply_source_base || !thread.reply_source_pending.is_empty();
        }
        self.persist_local_state().await?;
        self.publish_reply_source(workspace_id, thread_id).await;
        Ok(())
    }

    async fn publish_reply_source(&self, workspace_id: &str, thread_id: &str) {
        if let Ok(thread) = self.thread_summary(workspace_id, thread_id).await {
            self.emit(
                Some(workspace_id.into()),
                Some(thread_id.into()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::thread_tools::tests::fixture;

    #[test]
    fn ambiguous_delivery_does_not_erase_human_attribution() {
        assert!(definite_input_rejection(&DaemonError::Rpc(
            "expectedTurnId does not match".into()
        )));
        assert!(!definite_input_rejection(&DaemonError::Rpc(
            "codex app-server disconnected before responding to turn/steer".into()
        )));
        assert!(!definite_input_rejection(&DaemonError::Process(
            "timed out writing to claude turn".into()
        )));
    }

    #[tokio::test]
    async fn rejected_human_input_does_not_erase_another_accepted_response() {
        let (app, _temp) = fixture().await;
        let first = app
            .begin_user_reply("workspace-1", "thread-1")
            .await
            .unwrap();
        let second = app
            .begin_user_reply("workspace-1", "thread-1")
            .await
            .unwrap();
        app.finish_user_reply("workspace-1", "thread-1", second, true)
            .await
            .unwrap();
        app.finish_user_reply("workspace-1", "thread-1", first, false)
            .await
            .unwrap();
        assert!(
            app.thread_summary("workspace-1", "thread-1")
                .await
                .unwrap()
                .attention
                .reply_to_user
        );
    }

    #[tokio::test]
    async fn rejected_human_input_restores_automatic_source() {
        let (app, _temp) = fixture().await;
        let claim = app
            .begin_user_reply("workspace-1", "thread-1")
            .await
            .unwrap();
        assert!(
            app.thread_summary("workspace-1", "thread-1")
                .await
                .unwrap()
                .attention
                .reply_to_user
        );
        app.finish_user_reply("workspace-1", "thread-1", claim, false)
            .await
            .unwrap();
        assert!(
            !app.thread_summary("workspace-1", "thread-1")
                .await
                .unwrap()
                .attention
                .reply_to_user
        );
    }
}
