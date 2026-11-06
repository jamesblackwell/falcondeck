//! Bot metadata and user-owned files. Native providers remain the history store.
use super::*;
use falcondeck_core::{
    BotDocument, BotDocumentMutation, BotIcon, BotMutation, BotProfile, BotStatus,
};

use sha2::{Digest, Sha256};
use std::io::{Read, Seek, Write};

mod context;
mod handoff;
mod switch;

const MAX_DOCUMENT_BYTES: usize = 1_048_576;

fn validate_text(name: &str, instructions: &str) -> Result<(), DaemonError> {
    if name.trim().is_empty() || name.chars().count() > 100 || name.contains(['\n', '\r']) {
        return Err(DaemonError::BadRequest(
            "Bot name must be 1–100 characters on one line".into(),
        ));
    }
    if instructions.len() > 32_000 {
        return Err(DaemonError::BadRequest(
            "Bot instructions must be at most 32000 bytes".into(),
        ));
    }
    Ok(())
}

fn document_path(root: &Path, name: &str) -> Result<PathBuf, DaemonError> {
    if name.is_empty()
        || name.len() > 180
        || name.starts_with('.')
        || name.contains(['/', '\\', '\0'])
        || name.chars().any(char::is_control)
    {
        return Err(DaemonError::BadRequest(
            "Use a plain document filename, without folders or a leading dot".into(),
        ));
    }
    let path = root.join(name);
    if let Ok(metadata) = std::fs::symlink_metadata(&path)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err(DaemonError::BadRequest(
            "Bot documents must be regular files".into(),
        ));
    }
    Ok(path)
}

fn open_document(path: &Path, write: bool, create: bool) -> Result<std::fs::File, DaemonError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(write).create_new(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .mode(0o600);
    }
    let file = options.open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            DaemonError::Conflict(
                "A document with that name already exists; open it before editing".into(),
            )
        } else {
            e.into()
        }
    })?;
    if !file.metadata()?.is_file() {
        return Err(DaemonError::BadRequest(
            "Document must be a regular file".into(),
        ));
    }
    Ok(file)
}

fn read_document(file: &mut std::fs::File) -> Result<String, DaemonError> {
    let mut content = String::new();
    file.take(MAX_DOCUMENT_BYTES as u64 + 1)
        .read_to_string(&mut content)?;
    if content.len() > MAX_DOCUMENT_BYTES {
        return Err(DaemonError::BadRequest(
            "Document is too large to edit here; open it on disk".into(),
        ));
    }
    Ok(content)
}

/// Gives each bot without a mark the next unused shape and color, in order.
fn assign_missing_icons(bots: &mut [BotProfile]) {
    for index in 0..bots.len() {
        if bots[index].icon.as_ref().is_some_and(BotIcon::is_valid) {
            continue;
        }
        let taken: Vec<BotIcon> = bots.iter().filter_map(|bot| bot.icon.clone()).collect();
        bots[index].icon = Some(BotIcon::next_unused(&taken));
    }
}

fn document_version(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

impl AppState {
    pub(super) async fn restore_bot_watches(&self) {
        // Finish secondary-store updates if a process stopped after the atomic
        // preference publication. Repeated reconciliation is idempotent.
        for bot in self.preferences().await.bots {
            if let Ok(home) = self.thread_summary(&bot.workspace_id, &bot.thread_id).await {
                for old in &bot.previous_thread_ids {
                    if let Err(error) = self
                        .control()
                        .repoint_bot_automations(old, &bot.thread_id, &home.provider, &home.agent, home.origin.as_ref())
                        .await
                    {
                        tracing::warn!(error = %error.0.message, "failed to reconcile switched bot schedules");
                    }
                    let _ = workspace_ops::archive_thread(self, &bot.workspace_id, old).await;
                }
            }
        }

    }

    pub(crate) async fn bot_for_thread(&self, thread: &str) -> Option<BotProfile> {
        let bot_id = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .find_map(|ws| ws.threads.get(thread))
            .and_then(|t| match &t.summary.origin {
                Some(falcondeck_core::ThreadOrigin::Automation { bot_id, .. }) => bot_id.clone(),
                _ => None,
            });
        self.inner
            .preferences
            .lock()
            .await
            .bots
            .iter()
            .find(|bot| bot.owns_thread(thread) || bot_id.as_deref() == Some(bot.id.as_str()))
            .cloned()
    }

    /// The workspace that really holds `thread`, when `workspace_id` does not.
    pub(super) async fn workspace_holding_thread(
        &self,
        workspace_id: &str,
        thread: &str,
    ) -> Option<String> {
        let workspaces = self.inner.workspaces.lock().await;
        if workspaces
            .get(workspace_id)
            .is_some_and(|workspace| workspace.threads.contains_key(thread))
        {
            return None;
        }
        workspaces
            .iter()
            .find(|(_, workspace)| workspace.threads.contains_key(thread))
            .map(|(id, _)| id.clone())
    }

    /// Where a bot lives now: the workspace holding its home thread, then the
    /// recorded id, then its dedicated folder. Lazy workspaces count, because
    /// their placeholders carry persisted threads, and closed ones count as
    /// saved entries. A thread the placeholder has not hydrated yet is why the
    /// folder is consulted before giving up.
    pub(super) async fn bot_workspace(&self, bot: &BotProfile) -> Option<String> {
        let folder = bot
            .dedicated_workspace
            .then(|| Path::new(&bot.space_path).parent())
            .flatten()
            .map(|path| normalize_workspace_path(&path.to_string_lossy()));
        {
            let workspaces = self.inner.workspaces.lock().await;
            let holds = |id: &String| {
                workspaces
                    .get(id)
                    .is_some_and(|workspace| workspace.threads.contains_key(&bot.thread_id))
            };
            if holds(&bot.workspace_id) {
                return Some(bot.workspace_id.clone());
            }
            if let Some(id) = workspaces.keys().find(|id| holds(id)) {
                return Some(id.clone());
            }
            if workspaces.contains_key(&bot.workspace_id) {
                return Some(bot.workspace_id.clone());
            }
            if let Some((id, _)) = workspaces
                .iter()
                .find(|(_, workspace)| folder.as_deref() == Some(&workspace.summary.path))
            {
                return Some(id.clone());
            }
        }
        self.inner
            .saved_workspaces
            .lock()
            .await
            .values()
            .find(|workspace| {
                folder.as_deref() == Some(&workspace.path)
                    || workspace
                        .thread_states
                        .iter()
                        .any(|thread| thread.thread_id == bot.thread_id)
            })
            .and_then(|workspace| workspace.id.clone())
    }

    /// Corrects bot profiles whose workspace id has been retired. Runs once
    /// the persisted workspaces are registered and before anything can use a
    /// profile, so every reader of `workspace_id` sees the live value.
    pub(super) async fn repair_bot_workspace_ids(&self) {
        let mut repairs = HashMap::new();
        for bot in self.preferences().await.bots {
            match self.bot_workspace(&bot).await {
                Some(id) if id != bot.workspace_id => {
                    tracing::warn!(
                        bot = %bot.name, stale = %bot.workspace_id, repaired = %id,
                        "repaired bot workspace id"
                    );
                    repairs.insert(bot.id, id);
                }
                Some(_) => {}
                None => tracing::warn!(
                    bot = %bot.name, workspace = %bot.workspace_id, thread = %bot.thread_id,
                    "bot workspace not found; profile left unchanged"
                ),
            }
        }
        if repairs.is_empty() {
            return;
        }
        let mut preferences = self.inner.preferences.lock().await;
        let mut next = preferences.clone();
        for bot in &mut next.bots {
            if let Some(id) = repairs.remove(&bot.id) {
                bot.workspace_id = id;
            }
        }
        if let Err(error) = persist_preferences(&self.inner.preferences_path, &next).await {
            tracing::warn!(%error, "failed to persist repaired bot workspace ids");
        }
        // Applied either way: this boot's readers need the live id, and the
        // next start repeats the repair if the write failed.
        *preferences = next.clone();
        drop(preferences);
        self.emit(
            None,
            None,
            UnifiedEvent::PreferencesUpdated { preferences: next },
        );
    }

    pub(super) async fn thread_workspace(&self, thread: &str) -> Result<String, DaemonError> {
        if self.is_cloud_thread(thread) {
            return self
                .cloud_manager()
                .thread_summaries()
                .await?
                .into_iter()
                .find(|summary| summary.id == thread)
                .map(|summary| summary.workspace_id)
                .ok_or_else(|| DaemonError::NotFound("cloud task not found".into()));
        }
        self.inner
            .workspaces
            .lock()
            .await
            .iter()
            .find(|(_, ws)| ws.threads.contains_key(thread))
            .map(|(id, _)| id.clone())
            .ok_or_else(|| DaemonError::NotFound("task not found".into()))
    }

    async fn bot(&self, id: &str) -> Result<BotProfile, DaemonError> {
        self.inner
            .preferences
            .lock()
            .await
            .bots
            .iter()
            .find(|b| b.id == id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("bot not found".into()))
    }

    async fn save_bots(&self, mut bots: Vec<BotProfile>) -> Result<(), DaemonError> {
        assign_missing_icons(&mut bots);
        let mut preferences = self.inner.preferences.lock().await;
        let mut next = preferences.clone();
        next.bots = bots;
        self.ensure_saved_state_writable()?;
        persist_preferences(&self.inner.preferences_path, &next).await?;
        *preferences = next.clone();
        drop(preferences);
        self.emit(
            None,
            None,
            UnifiedEvent::PreferencesUpdated { preferences: next },
        );
        Ok(())
    }

    /// Clear queued work and interrupt the bot's home and its direct workers.
    async fn stop_bot_work(&self, bot: &BotProfile) -> Result<(), DaemonError> {
        let _spawn_gate = self.inner.agent_spawn_gate.lock().await;
        if let Some(watches) = self
            .inner
            .agent_spawn_watches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            watches.retain(|_, watch| !bot.owns_thread(&watch.parent_thread_id));
        }
        let threads: Vec<_> = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .flat_map(|ws| ws.threads.values())
            .filter(|t| {
                t.summary.id == bot.thread_id
                    || matches!(&t.summary.origin, Some(falcondeck_core::ThreadOrigin::Automation { bot_id: Some(id), .. }) if id == &bot.id)
                    || matches!(&t.summary.origin, Some(falcondeck_core::ThreadOrigin::AgentSpawn { parent_thread_id, .. }) if bot.owns_thread(parent_thread_id))
            })
            .map(|t| t.summary.clone())
            .collect();
        for thread in threads {
            for queued in &thread.queued_turns {
                self.remove_queued_turn(&thread.workspace_id, &thread.id, &queued.id)
                    .await?;
            }
            if matches!(
                thread.status,
                ThreadStatus::Running | ThreadStatus::WaitingForInput
            ) {
                self.interrupt_turn(thread.workspace_id, thread.id).await?;
            }
        }
        Ok(())
    }

    /// The bot a schedule must not wake, when that bot is paused or archived.
    /// A fresh run names the bot. A home-thread schedule is matched by thread id.
    pub(crate) async fn resting_bot_for_automation(
        &self,
        automation: &falcondeck_core::control::Automation,
    ) -> Option<BotProfile> {
        let bots = self.preferences().await.bots;
        if let Some(id) = &automation.target.run_as_bot {
            return bots
                .into_iter()
                .find(|bot| &bot.id == id && bot.status.is_resting());
        }
        let thread_id = match &automation.target.thread {
            falcondeck_core::control::AutomationThreadTarget::Existing { thread_id } => {
                Some(thread_id.as_str())
            }
            falcondeck_core::control::AutomationThreadTarget::Managed { thread_id } => {
                thread_id.as_deref()
            }
            _ => None,
        }?;
        bots.into_iter()
            .find(|bot| bot.owns_thread(thread_id) && bot.status.is_resting())
    }

    pub async fn mutate_bot(&self, mutation: BotMutation) -> Result<Value, DaemonError> {
        let _gate = self.inner.bot_mutations.lock().await;
        match mutation {
            BotMutation::Create {
                name,
                instructions,
                provider,
                model_id,
                thread_id,
            } => {
                validate_text(&name, &instructions)?;
                if let Some(thread) = &thread_id
                    && self.bot_for_thread(thread).await.is_some()
                {
                    return Err(DaemonError::Conflict("This task is already a bot".into()));
                }
                // Validate the promoted conversation before creating any files.
                let existing = if let Some(thread) = &thread_id {
                    let workspace = self.thread_workspace(thread).await?;
                    Some(self.thread_summary(&workspace, thread).await?)
                } else {
                    None
                };
                let id = format!("bot-{}", Uuid::new_v4().simple());
                let root = self
                    .inner
                    .state_path
                    .parent()
                    .unwrap_or(Path::new("."))
                    .join("bots")
                    .join(&id);
                let space = root.join("space");
                tokio::fs::create_dir_all(&space).await?;
                let dedicated_workspace = existing.is_none();
                let thread =
                    if let Some(thread) = existing {
                        thread
                    } else {
                        let workspace = workspace_ops::create_chat_at(self, root.clone()).await?;
                        let handle = self.start_thread(serde_json::from_value(json!({
                        "workspace_id": workspace.id, "provider": provider, "model_id": model_id
                    }))?).await?;
                        handle.thread
                    };
                let bot = BotProfile {
                    id,
                    name: name.trim().into(),
                    workspace_id: thread.workspace_id.clone(),
                    dedicated_workspace,
                    thread_id: thread.id.clone(),
                    previous_thread_ids: Vec::new(),
                    space_path: space.to_string_lossy().into(),
                    instructions,
                    can_start_threads: true,
                    context_files: Vec::new(),
                    icon: None,
                    status: BotStatus::Active,
                };
                let mut bots = self.inner.preferences.lock().await.bots.clone();
                // Settle older bots' marks first, as clients already display them.
                assign_missing_icons(&mut bots);
                let mut bot = bot;
                bot.icon = Some(BotIcon::next_unused(
                    &bots
                        .iter()
                        .filter_map(|b| b.icon.clone())
                        .collect::<Vec<_>>(),
                ));
                bots.push(bot.clone());
                self.save_bots(bots).await?;
                self.unarchive_thread(&thread.workspace_id, &thread.id)
                    .await?;
                self.update_thread(serde_json::from_value(
                    json!({"workspace_id": thread.workspace_id,
                    "thread_id": thread.id, "title": bot.name, "pinned": false,
                    "pinned_in_project": false}),
                )?)
                .await?;
                Ok(json!({"bot": bot}))
            }
            BotMutation::Update {
                id,
                name,
                instructions,
                can_start_threads,
                context_files,
                icon,
            } => {
                validate_text(&name, &instructions)?;
                if icon.as_ref().is_some_and(|icon| !icon.is_valid()) {
                    return Err(DaemonError::BadRequest("Unknown bot icon".into()));
                }
                let context_files = match context_files {
                    Some(paths) => Some(context::validate_context_files(paths).await?),
                    None => None,
                };
                let mut bot = self.bot(&id).await?;
                bot.name = name.trim().into();
                bot.instructions = instructions;
                bot.can_start_threads = can_start_threads;
                if let Some(paths) = context_files {
                    bot.context_files = paths;
                }
                if icon.is_some() {
                    bot.icon = icon;
                }
                self.update_thread(serde_json::from_value(
                    json!({"workspace_id": bot.workspace_id,
                    "thread_id": bot.thread_id, "title": bot.name}),
                )?)
                .await?;
                let mut bots = self.inner.preferences.lock().await.bots.clone();
                if let Some(saved) = bots.iter_mut().find(|b| b.id == id) {
                    *saved = bot.clone();
                }
                self.save_bots(bots).await?;
                Ok(json!({"bot": bot}))
            }
            BotMutation::SwitchConversation {
                id,
                provider,
                model_id,
                reasoning_effort,
            } => {
                self.switch_bot_conversation(&id, provider, model_id, reasoning_effort)
                    .await
            }
            BotMutation::Reorder { ids } => {
                let mut bots = self.inner.preferences.lock().await.bots.clone();
                // Stable sort: listed bots by their position, the rest after, as before.
                bots.sort_by_key(|bot| {
                    ids.iter()
                        .position(|id| id == &bot.id)
                        .unwrap_or(usize::MAX)
                });
                self.save_bots(bots).await?;
                Ok(json!({"ok": true}))
            }
            BotMutation::Stop { id } => {
                let bot = self.bot(&id).await?;
                self.stop_bot_work(&bot).await?;
                Ok(json!({"ok": true}))
            }
            BotMutation::SetStatus { id, status } => {
                let mut bot = self.bot(&id).await?;
                if bot.status == status {
                    return Ok(json!({"bot": bot}));
                }
                // Leaving the working list stops anything already in flight.
                // Resume does not replay the occurrences that waited.
                if status.is_resting() {
                    self.stop_bot_work(&bot).await?;
                }
                bot.status = status;
                let mut bots = self.inner.preferences.lock().await.bots.clone();
                if let Some(saved) = bots.iter_mut().find(|b| b.id == id) {
                    *saved = bot.clone();
                }
                self.save_bots(bots).await?;
                Ok(json!({"bot": bot}))
            }
            BotMutation::Delete { id } => {
                let bot = self.bot(&id).await?;
                let summary = self
                    .thread_summary(&bot.workspace_id, &bot.thread_id)
                    .await?;
                let workers_busy = self.inner.workspaces.lock().await.values().flat_map(|ws| ws.threads.values()).any(|t|
                    (matches!(&t.summary.origin, Some(falcondeck_core::ThreadOrigin::AgentSpawn { parent_thread_id, .. }) if bot.owns_thread(parent_thread_id))
                    || matches!(&t.summary.origin, Some(falcondeck_core::ThreadOrigin::Automation { bot_id: Some(id), .. }) if id == &bot.id))
                    && (matches!(t.summary.status, ThreadStatus::Running | ThreadStatus::WaitingForInput) || !t.summary.queued_turns.is_empty()));
                if matches!(
                    summary.status,
                    ThreadStatus::Running | ThreadStatus::WaitingForInput
                ) || !summary.queued_turns.is_empty()
                    || workers_busy
                {
                    return Err(DaemonError::Conflict(
                        "Stop the bot before deleting it".into(),
                    ));
                }
                workspace_ops::archive_thread(self, &bot.workspace_id, &bot.thread_id).await?;
                let mut bots = self.inner.preferences.lock().await.bots.clone();
                bots.retain(|b| b.id != id);
                self.save_bots(bots).await?;
                self.terminals().close_scope(None, Some(id.as_str()));
                Ok(
                    json!({"ok": true, "message": "Bot removed. Conversation archived and documents kept on disk."}),
                )
            }
        }
    }

    pub async fn bot_documents(&self, id: &str) -> Result<Vec<String>, DaemonError> {
        let bot = self.bot(id).await?;
        let mut entries = tokio::fs::read_dir(&bot.space_path).await?;
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if names.len() >= 500 {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with('.') && entry.file_type().await?.is_file() {
                names.push(name);
            }
        }
        names.sort();
        Ok(names)
    }

    pub async fn read_bot_document(
        &self,
        id: &str,
        name: &str,
    ) -> Result<BotDocument, DaemonError> {
        let bot = self.bot(id).await?;
        let path = document_path(Path::new(&bot.space_path), name)?;
        let name = name.to_string();
        tokio::task::spawn_blocking(move || {
            let mut file = open_document(&path, false, false)?;
            let content = read_document(&mut file)?;
            let version = document_version(&content);
            let modified_at = file
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .map(chrono::DateTime::<Utc>::from);
            Ok(BotDocument {
                name,
                content,
                version,
                modified_at,
            })
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))?
    }

    pub async fn mutate_bot_document(
        &self,
        id: &str,
        mutation: BotDocumentMutation,
    ) -> Result<Value, DaemonError> {
        let _gate = self.inner.bot_mutations.lock().await;
        let bot = self.bot(id).await?;
        tokio::task::spawn_blocking(move || -> Result<(), DaemonError> {
            match mutation {
                BotDocumentMutation::Write {
                    name,
                    content,
                    expected_version,
                } => {
                    if content.len() > MAX_DOCUMENT_BYTES {
                        return Err(DaemonError::BadRequest(
                            "Document must be at most 1 MB".into(),
                        ));
                    }
                    let path = document_path(Path::new(&bot.space_path), &name)?;
                    let mut file = open_document(&path, true, expected_version.is_none())?;
                    if let Some(expected) = expected_version {
                        if document_version(&read_document(&mut file)?) != expected {
                            return Err(DaemonError::Conflict(
                                "Document changed on disk; reload before saving".into(),
                            ));
                        }
                    }
                    file.rewind()?;
                    file.set_len(0)?;
                    file.write_all(content.as_bytes())?;
                    file.sync_all()?;
                }
                BotDocumentMutation::Delete {
                    name,
                    expected_version,
                } => {
                    let path = document_path(Path::new(&bot.space_path), &name)?;
                    let mut file = open_document(&path, false, false)?;
                    if document_version(&read_document(&mut file)?) != expected_version {
                        return Err(DaemonError::Conflict(
                            "Document changed on disk; reload before deleting".into(),
                        ));
                    }
                    std::fs::remove_file(path)?;
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))??;
        Ok(json!({"ok": true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn documents_cannot_escape_space() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "",
            ".",
            "..",
            "../secret",
            "/etc/passwd",
            "nested/file",
            ".env",
            "a\\b",
        ] {
            assert!(document_path(dir.path(), name).is_err(), "{name}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", dir.path().join("link.txt")).unwrap();
            assert!(document_path(dir.path(), "link.txt").is_err());
        }
        assert_eq!(
            document_path(dir.path(), "Notes.md").unwrap(),
            dir.path().join("Notes.md")
        );
    }
}
