//! Bot metadata and user-owned files. Native providers remain the history store.
use super::*;
use falcondeck_core::{
    BOT_DEFAULT_INSTRUCTIONS, BotDocument, BotDocumentMutation, BotMutation, BotProfile,
};

use sha2::{Digest, Sha256};
use std::io::{Read, Seek, Write};

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

fn document_version(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

impl AppState {
    pub(super) async fn restore_bot_watches(&self) {
        let parents: HashSet<_> = self
            .inner
            .preferences
            .lock()
            .await
            .bots
            .iter()
            .map(|b| b.thread_id.clone())
            .collect();
        let children: Vec<_> = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .flat_map(|ws| ws.threads.values())
            .filter_map(|t| match &t.summary.origin {
                Some(falcondeck_core::ThreadOrigin::AgentSpawn { parent_thread_id })
                    if parents.contains(parent_thread_id) && !t.summary.is_archived =>
                {
                    Some((
                        t.summary.workspace_id.clone(),
                        t.summary.id.clone(),
                        parent_thread_id.clone(),
                    ))
                }
                _ => None,
            })
            .collect();
        for (workspace, child, parent) in children {
            self.watch_child(&workspace, &child, &parent, false);
        }
    }

    pub(super) async fn bot_for_thread(&self, thread: &str) -> Option<BotProfile> {
        self.inner
            .preferences
            .lock()
            .await
            .bots
            .iter()
            .find(|bot| bot.thread_id == thread)
            .cloned()
    }

    pub(super) async fn thread_workspace(&self, thread: &str) -> Result<String, DaemonError> {
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

    async fn save_bots(&self, bots: Vec<BotProfile>) -> Result<(), DaemonError> {
        let mut preferences = self.inner.preferences.lock().await;
        let mut next = preferences.clone();
        next.bots = bots;
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
                    space_path: space.to_string_lossy().into(),
                    instructions,
                    can_start_threads: true,
                };
                let mut bots = self.inner.preferences.lock().await.bots.clone();
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
            } => {
                validate_text(&name, &instructions)?;
                let mut bot = self.bot(&id).await?;
                bot.name = name.trim().into();
                bot.instructions = instructions;
                bot.can_start_threads = can_start_threads;
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
            BotMutation::Stop { id } => {
                let bot = self.bot(&id).await?;
                let _spawn_gate = self.inner.agent_spawn_gate.lock().await;
                if let Some(watches) = self
                    .inner
                    .agent_spawn_watches
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_mut()
                {
                    watches.retain(|_, watch| watch.parent_thread_id != bot.thread_id);
                }
                let threads: Vec<_> = self.inner.workspaces.lock().await.values().flat_map(|ws| ws.threads.values())
                    .filter(|t| t.summary.id == bot.thread_id || matches!(&t.summary.origin,
                        Some(falcondeck_core::ThreadOrigin::AgentSpawn {parent_thread_id}) if parent_thread_id == &bot.thread_id))
                    .map(|t| t.summary.clone()).collect();
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
                Ok(json!({"ok": true}))
            }
            BotMutation::Delete { id } => {
                let bot = self.bot(&id).await?;
                let summary = self
                    .thread_summary(&bot.workspace_id, &bot.thread_id)
                    .await?;
                let workers_busy = self.inner.workspaces.lock().await.values().flat_map(|ws| ws.threads.values()).any(|t|
                    matches!(&t.summary.origin, Some(falcondeck_core::ThreadOrigin::AgentSpawn { parent_thread_id }) if parent_thread_id == &bot.thread_id)
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
            Ok(BotDocument {
                name,
                content,
                version,
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

    pub(super) async fn bot_context(&self, thread: &str) -> Option<String> {
        /// Repeated on every turn, so only the most recently active projects.
        const LISTED_PROJECTS: usize = 12;
        let bot = self.bot_for_thread(thread).await?;
        let mut projects: Vec<_> = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .filter(|ws| ws.summary.kind == falcondeck_core::WorkspaceKind::Project)
            .filter(|ws| !(bot.dedicated_workspace && ws.summary.id == bot.workspace_id))
            .map(|ws| {
                let last = ws.threads.values().map(|t| t.summary.updated_at).max();
                (last, ws.summary.id.clone(), ws.summary.path.clone())
            })
            .collect();
        projects.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.2.cmp(&b.2)));
        let total = projects.len();
        let mut listed: String = projects
            .iter()
            .take(LISTED_PROJECTS)
            .map(|(_, id, path)| format!("\n- {path} (`{id}`)"))
            .collect();
        if total > LISTED_PROJECTS {
            listed.push_str(&format!(
                "\n- …{} older projects; workspace_id also accepts a project name or path.",
                total - LISTED_PROJECTS
            ));
        }
        let documents = self.bot_documents(&bot.id).await.unwrap_or_default();
        Some(format!(
            "# FalconDeck bot: {}\n\n{}\n\n## Your instructions\n{}\n\nDocument space: {}\nDocuments: {}\nRead relevant documents directly from this space.\nMay start tasks: {}. This restricts FalconDeck task creation; it is not an operating-system sandbox.\nProjects, most recently active first:{}",
            bot.name,
            BOT_DEFAULT_INSTRUCTIONS,
            bot.instructions,
            bot.space_path,
            json!(documents),
            bot.can_start_threads,
            listed
        ))
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
