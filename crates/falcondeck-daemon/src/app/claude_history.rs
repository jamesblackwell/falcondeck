use super::*;

/// Kept on the thread rather than in a growing global gate map. Replacing a
/// workspace creates a new identity, so an old disk read cannot install into it.
pub(super) struct ClaudeHistoryState {
    pub(super) source: PathBuf,
    native_session_id: String,
    working_directory: String,
    discovered_title: String,
    source_version: Option<(u64, Option<std::time::SystemTime>)>,
    pub(super) gate: Arc<Mutex<()>>,
    pub(super) loaded: AtomicBool,
}

impl ClaudeHistoryState {
    pub(super) fn is_loaded(&self) -> bool {
        self.loaded.load(Ordering::Acquire)
    }

    pub(super) fn same_source(&self, other: &Self) -> bool {
        self.source == other.source
            && self.native_session_id == other.native_session_id
            && self.working_directory == other.working_directory
    }

    pub(super) fn same_version(&self, other: &Self) -> bool {
        self.same_source(other) && self.source_version == other.source_version
    }

    pub(super) fn has_observed_source(&self) -> bool {
        self.source_version.is_some()
    }

    pub(super) fn is_in_use(&self) -> bool {
        self.gate.try_lock().is_err()
    }

    pub(super) fn new(
        source: PathBuf,
        native_session_id: String,
        working_directory: String,
        discovered_title: String,
    ) -> Arc<Self> {
        Self::create(
            source,
            native_session_id,
            working_directory,
            discovered_title,
            None,
        )
    }

    pub(super) fn new_discovered(
        source: PathBuf,
        native_session_id: String,
        working_directory: String,
        discovered_title: String,
        source_version: (u64, Option<std::time::SystemTime>),
    ) -> Arc<Self> {
        Self::create(
            source,
            native_session_id,
            working_directory,
            discovered_title,
            Some(source_version),
        )
    }

    fn create(
        source: PathBuf,
        native_session_id: String,
        working_directory: String,
        discovered_title: String,
        source_version: Option<(u64, Option<std::time::SystemTime>)>,
    ) -> Arc<Self> {
        Arc::new(Self {
            source,
            native_session_id,
            working_directory,
            discovered_title,
            source_version,
            gate: Arc::new(Mutex::new(())),
            loaded: AtomicBool::new(false),
        })
    }

    fn matches(&self, thread: &ManagedThread, workspace_path: &str) -> bool {
        thread.summary.provider == AgentProvider::CLAUDE
            && thread.summary.native_session_id.as_deref() == Some(&self.native_session_id)
            && thread.summary.working_directory(workspace_path) == self.working_directory
            && thread
                .claude_history
                .as_ref()
                .is_some_and(|current| std::ptr::eq(self, Arc::as_ptr(current)))
    }
}

#[cfg(test)]
#[path = "claude_history_tests.rs"]
mod tests;

impl AppState {
    pub(super) async fn ensure_claude_thread_history(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<(), DaemonError> {
        self.claude_history_for_admission(workspace_id, thread_id)
            .await?;
        Ok(())
    }

    /// The caller retains this guard through provider startup. Readers use the
    /// same gate, preventing history from crossing a new prompt's admission.
    pub(super) async fn claude_history_for_admission(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>, DaemonError> {
        let state = {
            let mut workspaces = self.inner.workspaces.lock().await;
            if let Some(workspace) = workspaces.get_mut(workspace_id)
                && let Some(thread) = workspace.threads.get_mut(thread_id)
            {
                // Restored placeholders can be opened or resumed before the
                // provider's workspace bootstrap finishes. They need the same
                // fail-closed load as a discovered session.
                if thread.summary.provider == AgentProvider::CLAUDE
                    && thread.claude_history.is_none()
                    && let Some(native_id) = thread.summary.native_session_id.clone()
                {
                    let cwd = thread
                        .summary
                        .working_directory(&workspace.summary.path)
                        .to_string();
                    thread.claude_history = Some(ClaudeHistoryState::new(
                        crate::claude::native_session_source(&cwd, &native_id),
                        native_id,
                        cwd,
                        String::new(),
                    ));
                }
                thread.claude_history.clone()
            } else {
                None
            }
        };
        let Some(state) = state else { return Ok(None) };
        let guard = state.gate.clone().lock_owned().await;
        self.load_claude_history(workspace_id, thread_id, &state)
            .await?;
        Ok(Some(guard))
    }

    async fn load_claude_history(
        &self,
        workspace_id: &str,
        thread_id: &str,
        state: &Arc<ClaudeHistoryState>,
    ) -> Result<(), DaemonError> {
        let (status, latest_turn_id, requires_resume) = {
            let workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
            let thread = workspace
                .threads
                .get(thread_id)
                .ok_or_else(|| DaemonError::NotFound("thread not found".into()))?;
            if !state.matches(thread, &workspace.summary.path) {
                return Err(DaemonError::Conflict(
                    "Claude session changed while loading history".into(),
                ));
            }
            if state.loaded.load(Ordering::Acquire) {
                return Ok(());
            }
            // A live event that bypassed admission is still authoritative.
            if !thread.items.is_empty()
                || matches!(
                    thread.summary.status,
                    ThreadStatus::Running | ThreadStatus::WaitingForInput
                )
            {
                state.loaded.store(true, Ordering::Release);
                return Ok(());
            }
            (
                thread.summary.status.clone(),
                thread.summary.latest_turn_id.clone(),
                thread.requires_resume,
            )
        };
        let source = state.source.clone();
        let cwd = state.working_directory.clone();
        let native_id = state.native_session_id.clone();
        let history =
            spawn_blocking(move || crate::claude::hydrate_native_thread(&source, &cwd, &native_id))
                .await
                .map_err(|error| {
                    DaemonError::Process(format!("Claude history reader failed: {error}"))
                })?
                .ok_or_else(|| {
                    DaemonError::NotFound(
                        "Claude session history is missing or no longer matches this thread".into(),
                    )
                })?;
        let mut history = crate::codex::HydratedThread {
            summary: history.summary,
            items: history.items,
            title_is_provider_preview: history.title_is_provider_preview,
        };
        history.summary.id = thread_id.to_string();
        super::workspace_ops::materialize_hydrated_image_attachments(
            self,
            workspace_id,
            std::slice::from_mut(&mut history),
        )
        .await;
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".into()))?;
        install_history(
            thread,
            &workspace.summary.path,
            state,
            status,
            latest_turn_id,
            requires_resume,
            history,
        )
    }
}

fn install_history(
    thread: &mut ManagedThread,
    workspace_path: &str,
    state: &Arc<ClaudeHistoryState>,
    status: ThreadStatus,
    latest_turn_id: Option<String>,
    requires_resume: bool,
    mut history: crate::codex::HydratedThread,
) -> Result<(), DaemonError> {
    if !state.matches(thread, workspace_path) {
        return Err(DaemonError::Conflict(
            "Claude session changed while loading history".into(),
        ));
    }
    if thread.items.is_empty()
        && thread.summary.status == status
        && thread.summary.latest_turn_id == latest_turn_id
        && thread.requires_resume == requires_resume
        && !state.loaded.load(Ordering::Acquire)
    {
        if !thread.manual_title && thread.summary.title == state.discovered_title {
            thread.summary.title = history.summary.title;
            thread.title_is_provider_preview = history.title_is_provider_preview;
            thread.ai_title_generated = !history.title_is_provider_preview;
        }
        thread.summary.last_message_preview = history.summary.last_message_preview;
        if is_shutdown_interrupted(&thread.summary.status, thread.summary.last_error.as_deref()) {
            settle_items_as_shutdown_interrupted(
                &mut history.items,
                thread
                    .summary
                    .latest_turn_id
                    .as_deref()
                    .or(Some(&thread.summary.id)),
                Utc::now(),
                SHUTDOWN_INTERRUPTED_TURN_ERROR,
            );
        }
        thread.replace_items(history.items);
    }
    // Even an empty, valid transcript has completed hydration. If live state
    // moved while reading, keep it and never retry the stale replacement.
    state.loaded.store(true, Ordering::Release);
    Ok(())
}
