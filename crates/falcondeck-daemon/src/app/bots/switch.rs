use super::*;

impl AppState {
    // Caller holds bot_mutations. Bot-thread sends hold a read guard on
    // bot_turn_admission; the write guard below keeps any turn from slipping
    // between the final idle check and publishing the replacement home.
    pub(super) async fn switch_bot_conversation(
        &self,
        id: &str,
        provider: AgentProvider,
        model_id: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Result<Value, DaemonError> {
        if model_id.as_ref().is_some_and(|id| id.trim().is_empty())
            || reasoning_effort
                .as_ref()
                .is_some_and(|effort| effort.trim().is_empty())
        {
            return Err(DaemonError::BadRequest(
                "Model and reasoning effort must be nonempty when supplied".into(),
            ));
        }
        let mut bot = self.bot(id).await?;
        let busy = |thread: &falcondeck_core::ThreadSummary| {
            matches!(
                thread.status,
                ThreadStatus::Running | ThreadStatus::WaitingForInput
            ) || !thread.queued_turns.is_empty()
                || thread.attention.background_task_count > 0
        };
        let refuse = || {
            DaemonError::Conflict(
                "Stop or let the turn finish first before switching this bot".into(),
            )
        };
        let first = self
            .thread_summary(&bot.workspace_id, &bot.thread_id)
            .await?;
        if busy(&first) {
            return Err(refuse());
        }
        // The briefing can page through a long history, so build it before
        // excluding sends; rebuild under the guard only if a turn ran meanwhile.
        let mut briefing = self
            .continuity_briefing(&bot.workspace_id, &bot.thread_id)
            .await?;
        let _admission = self.inner.bot_turn_admission.write().await;
        let old = self
            .thread_summary(&bot.workspace_id, &bot.thread_id)
            .await?;
        if busy(&old) {
            return Err(refuse());
        }
        if old.latest_turn_id != first.latest_turn_id {
            briefing = self
                .continuity_briefing(&bot.workspace_id, &bot.thread_id)
                .await?;
        }
        let same_provider = provider == old.provider;
        let permissions = switched_permissions(&old.agent, &provider, same_provider);
        let handle = self.start_thread(serde_json::from_value(json!({
            "workspace_id": bot.workspace_id, "provider": provider, "model_id": model_id,
            "collaboration_mode_id": permissions.collaboration_mode_id,
            "approval_policy": permissions.approval_policy,
            "sandbox_mode": permissions.sandbox_mode,
            "permission_mode": permissions.permission_mode,
            "handoff_from": {"thread_id": old.id, "provider": old.provider, "context_pending": true},
            "handoff_context": briefing
        }))?).await?;
        let new_id = handle.thread.id;
        self.update_thread(serde_json::from_value(json!({
            "workspace_id": bot.workspace_id, "thread_id": new_id,
            "title": bot.name, "reasoning_effort": reasoning_effort.or_else(|| if same_provider { old.agent.reasoning_effort.clone() } else { None }),
            "pinned": old.is_pinned, "pinned_in_project": old.is_pinned_in_project
        }))?).await?;
        // Preserve unread state without copying pending approval counts or native history.
        {
            let mut workspaces = self.inner.workspaces.lock().await;
            if let Some(thread) = workspaces
                .get_mut(&bot.workspace_id)
                .and_then(|ws| ws.threads.get_mut(&new_id))
            {
                thread.summary.attention = old.attention.clone();
            }
        }
        bot.previous_thread_ids.push(old.id.clone());
        bot.thread_id = new_id.clone();
        let mut preferences = self.inner.preferences.lock().await;
        let mut next = preferences.clone();
        *next.bots.iter_mut().find(|saved| saved.id == id).unwrap() = bot.clone();
        for folder in &mut next.project_folders {
            for thread in &mut folder.thread_ids {
                if thread == &old.id {
                    *thread = new_id.clone();
                }
            }
        }
        self.ensure_saved_state_writable()?;
        persist_preferences(&self.inner.preferences_path, &next).await?;
        *preferences = next.clone();
        drop(preferences);
        self.emit(
            None,
            None,
            UnifiedEvent::PreferencesUpdated { preferences: next },
        );
        // Aliases are durable before either secondary store is updated. Admission
        // resolves aliases too, so a crash here cannot deliver to the retired home.
        let home = self.thread_summary(&bot.workspace_id, &new_id).await?;
        self.control()
            .repoint_bot_automations(
                &old.id,
                &new_id,
                &provider,
                &home.agent,
                home.origin.as_ref(),
            )
            .await
            .map_err(|error| DaemonError::Process(error.0.message))?;
        self.emit_control_state_change(falcondeck_core::control::ControlStateChanged {
            store_revision: self.control().store_revision().await,
            domains: vec![falcondeck_core::control::ControlDomain::Automations],
        });
        workspace_ops::archive_thread(self, &bot.workspace_id, &old.id).await?;
        Ok(json!({"bot": bot}))
    }
}

// Never let permissive destination defaults elevate a restricted source.
fn switched_permissions(
    source: &ThreadAgentParams,
    provider: &AgentProvider,
    same: bool,
) -> ThreadAgentParams {
    if same {
        return source.clone();
    }
    let full = source.sandbox_mode.as_deref() == Some("danger-full-access")
        || matches!(
            source.permission_mode.as_deref(),
            Some("bypassPermissions" | "always-approve")
        );
    let read_only = source.sandbox_mode.as_deref() == Some("read-only")
        || source.permission_mode.as_deref() == Some("plan");
    let mut next = ThreadAgentParams::default();
    if provider == &AgentProvider::CODEX {
        next.approval_policy = Some(if full { "never" } else { "on-request" }.into());
        next.sandbox_mode = Some(
            if full {
                "danger-full-access"
            } else if read_only {
                "read-only"
            } else {
                "workspace-write"
            }
            .into(),
        );
    } else if provider == &AgentProvider::CLAUDE {
        next.permission_mode = Some(
            if full {
                "bypassPermissions"
            } else if read_only {
                "plan"
            } else {
                "default"
            }
            .into(),
        );
    } else {
        next.permission_mode = Some(if full { "always-approve" } else { "default" }.into());
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switch_permissions_keep_full_access_and_restricted_sources() {
        let mut source = ThreadAgentParams::default();
        source.sandbox_mode = Some("read-only".into());
        assert_eq!(
            switched_permissions(&source, &AgentProvider::CLAUDE, false)
                .permission_mode
                .as_deref(),
            Some("plan")
        );
        source.sandbox_mode = Some("workspace-write".into());
        assert_eq!(
            switched_permissions(&source, &AgentProvider::CLAUDE, false)
                .permission_mode
                .as_deref(),
            Some("default")
        );
        source.permission_mode = Some("bypassPermissions".into());
        assert_eq!(
            switched_permissions(&source, &AgentProvider::CODEX, false)
                .sandbox_mode
                .as_deref(),
            Some("danger-full-access")
        );
        assert_eq!(
            switched_permissions(&source, &AgentProvider::from("grok"), false)
                .permission_mode
                .as_deref(),
            Some("always-approve")
        );
        assert_eq!(
            switched_permissions(&source, &AgentProvider::CLAUDE, true),
            source
        );
    }
}
