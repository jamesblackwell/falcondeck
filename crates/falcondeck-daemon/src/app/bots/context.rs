//! Text files the user attaches to bots, read fresh into every bot turn.
use super::*;
use falcondeck_core::{
    BOT_DEFAULT_INSTRUCTIONS, BotContextReport, BotContextSection, ContextFile, ContextFileContent,
    ContextFileList, ContextFileWrite,
};

const MAX_CONTEXT_FILES: usize = 20;
/// Per-file cap on injected text; longer files are cut with a note.
const MAX_INJECTED_BYTES: usize = 64 * 1024;
const CONTEXT_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];
/// Project-root files suggested as bot context.
const PROJECT_CONTEXT_STEMS: [&str; 8] = [
    "COMPANY", "VISION", "MISSION", "GOALS", "STRATEGY", "METRICS", "BRAND", "ROADMAP",
];

/// Upkeep limits for a bot's own files and shared team indexes; a note appears from 80%.
const STATUS_LIMIT: u64 = 4 * 1024;
const MEMORY_LIMIT: u64 = 8 * 1024;
const SHARED_LIMIT: u64 = 6 * 1024;
const SHARED_FILE: &str = "SHARED.md";
/// STATUS.md older than this gets a refresh reminder.
const STATUS_STALE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// One-line size reminder, or nothing while comfortably under the limit.
fn size_note(name: &str, bytes: u64, limit: u64, fix: &str) -> Option<String> {
    let kb = |n: u64| format!("{:.1} KB", n as f64 / 1024.0);
    if bytes > limit {
        Some(format!(
            "{name} is {} (limit {}): {fix} now.",
            kb(bytes),
            kb(limit)
        ))
    } else if bytes * 5 >= limit * 4 {
        Some(format!(
            "{name} is {} (limit {}): {fix} before adding more.",
            kb(bytes),
            kb(limit)
        ))
    } else {
        None
    }
}

/// Reminders about the bot's own STATUS.md and MEMORY.md, read from disk each turn.
fn upkeep_notes(space: &Path, now: std::time::SystemTime) -> Vec<String> {
    let mut notes = Vec::new();
    match std::fs::metadata(space.join("STATUS.md")) {
        Ok(meta) => {
            notes.extend(size_note(
                "STATUS.md",
                meta.len(),
                STATUS_LIMIT,
                "rewrite it shorter, one line per item with links",
            ));
            let age = meta
                .modified()
                .ok()
                .and_then(|at| now.duration_since(at).ok());
            if let Some(age) = age.filter(|age| *age > STATUS_STALE) {
                notes.push(format!(
                    "STATUS.md was last updated {} days ago: refresh it if anything has changed.",
                    age.as_secs().div_ceil(24 * 60 * 60).max(1)
                ));
            }
        }
        Err(_) => notes.push("STATUS.md is missing: create it.".into()),
    }
    if let Ok(meta) = std::fs::metadata(space.join("MEMORY.md")) {
        notes.extend(size_note(
            "MEMORY.md",
            meta.len(),
            MEMORY_LIMIT,
            "move detail into linked notes and drop stale entries",
        ));
    }
    notes
}

/// Rough token estimate: about four characters per token.
fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4)
}

fn has_context_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| CONTEXT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

/// Normalises a requested list: absolute, plain text, existing, unique, bounded.
pub(super) async fn validate_context_files(paths: Vec<String>) -> Result<Vec<String>, DaemonError> {
    tokio::task::spawn_blocking(move || {
        let mut seen = HashSet::new();
        let mut valid = Vec::new();
        for raw in paths {
            let path = PathBuf::from(raw.trim());
            let shown = path.display();
            if !path.is_absolute()
                || path
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
            {
                return Err(DaemonError::BadRequest(format!(
                    "Context files need a full path: {shown}"
                )));
            }
            if !has_context_extension(&path) {
                return Err(DaemonError::BadRequest(format!(
                    "Context files must be .md, .markdown or .txt: {shown}"
                )));
            }
            if !is_regular_file(&path) {
                return Err(DaemonError::BadRequest(format!(
                    "Context file not found: {shown}"
                )));
            }
            let path = path.to_string_lossy().to_string();
            if seen.insert(path.clone()) {
                valid.push(path);
            }
        }
        if valid.len() > MAX_CONTEXT_FILES {
            return Err(DaemonError::BadRequest(format!(
                "A bot can include at most {MAX_CONTEXT_FILES} context files"
            )));
        }
        Ok(valid)
    })
    .await
    .map_err(|e| DaemonError::Process(e.to_string()))?
}

/// Reads up to the injection cap, reporting truncation or a readable error.
fn read_injected(path: &Path) -> Result<String, String> {
    if !is_regular_file(path) {
        return Err("file not found".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| {
            file.take(MAX_INJECTED_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|e| e.to_string())?;
    let truncated = bytes.len() > MAX_INJECTED_BYTES;
    bytes.truncate(MAX_INJECTED_BYTES);
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        // A cut can split a multi-byte character; anything else is not text.
        Err(e) if truncated && e.utf8_error().error_len().is_none() => {
            let valid = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).map_err(|e| e.to_string())?
        }
        Err(_) => return Err("not UTF-8 text".into()),
    };
    Ok(if truncated {
        format!("{text}\n\n[Truncated at 64 KB; read the file for the rest.]")
    } else {
        text
    })
}

struct ContextPart {
    label: String,
    path: Option<String>,
    text: String,
    error: Option<String>,
}

fn part(label: &str, text: String) -> ContextPart {
    ContextPart {
        label: label.into(),
        path: None,
        text,
        error: None,
    }
}

impl AppState {
    fn context_folder(&self) -> PathBuf {
        self.inner
            .state_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("context")
    }

    /// The injected context, split into labelled parts in injection order.
    async fn bot_context_parts(&self, bot: &BotProfile) -> Vec<ContextPart> {
        /// Repeated on every turn, so only the most recently active projects.
        const LISTED_PROJECTS: usize = 12;
        let mut parts = vec![
            part(
                "Built-in guidance",
                format!(
                    "# FalconDeck bot: {}\n\n{}",
                    bot.name, BOT_DEFAULT_INSTRUCTIONS
                ),
            ),
            part(
                "Your instructions",
                format!("\n\n## Your instructions\n{}", bot.instructions),
            ),
        ];
        let files = bot.context_files.clone();
        let reads = tokio::task::spawn_blocking(move || {
            files
                .into_iter()
                .map(|path| {
                    let read = read_injected(Path::new(&path));
                    (path, read)
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        for (index, (path, read)) in reads.into_iter().enumerate() {
            let name = Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let header = if index == 0 {
                "\n\n## Context files\nThe user attached these files for every turn; they are read fresh from disk. Treat them as standing context. Suggest changes rather than editing them unless your instructions say otherwise."
            } else {
                ""
            };
            let (body, error) = match read {
                Ok(text) if name.eq_ignore_ascii_case(SHARED_FILE) => {
                    let note = size_note(
                        &name,
                        text.len() as u64,
                        SHARED_LIMIT,
                        "prune stale or long lines",
                    )
                    .map(|note| format!("\n\n[FalconDeck: {note}]"))
                    .unwrap_or_default();
                    (format!("{text}{note}"), None)
                }
                Ok(text) => (text, None),
                Err(error) => (format!("(Unavailable: {error})"), Some(error)),
            };
            parts.push(ContextPart {
                label: name.clone(),
                text: format!("{header}\n\n### {name}\nPath: {path}\n\n{body}"),
                path: Some(path),
                error,
            });
        }
        let peers: String = self
            .inner
            .preferences
            .lock()
            .await
            .bots
            .iter()
            .filter(|peer| peer.id != bot.id)
            .map(|peer| {
                let status = Path::new(&peer.space_path).join("STATUS.md");
                format!("\n- {}: {}", peer.name, status.display())
            })
            .collect();
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
        let space = PathBuf::from(&bot.space_path);
        let upkeep =
            tokio::task::spawn_blocking(move || upkeep_notes(&space, std::time::SystemTime::now()))
                .await
                .unwrap_or_default();
        if !upkeep.is_empty() {
            let lines: String = upkeep.iter().map(|note| format!("\n- {note}")).collect();
            parts.push(part(
                "Upkeep",
                format!("\n\n## Upkeep (from FalconDeck, checked each turn)\nFix these during this turn:{lines}"),
            ));
        }
        let documents = self.bot_documents(&bot.id).await.unwrap_or_default();
        let peers = if peers.is_empty() {
            String::new()
        } else {
            format!("\nOther bots (message by name; read their status before asking):{peers}")
        };
        parts.push(part(
            "Documents, bots and projects",
            format!(
                "\n\nDocument space: {}\nDocuments: {}\nRead relevant documents directly from this space.\nMay start tasks: {}. This restricts FalconDeck task creation; it is not an operating-system sandbox.{}\nProjects, most recently active first:{}",
                bot.space_path,
                json!(documents),
                bot.can_start_threads,
                peers,
                listed
            ),
        ));
        parts
    }

    pub(in crate::app) async fn bot_context(&self, thread: &str) -> Option<String> {
        let bot = self.bot_for_thread(thread).await?;
        Some(
            self.bot_context_parts(&bot)
                .await
                .into_iter()
                .map(|part| part.text)
                .collect(),
        )
    }

    /// What the bot's next turn receives, with a per-part size estimate.
    pub async fn bot_context_report(&self, id: &str) -> Result<BotContextReport, DaemonError> {
        let bot = self.bot(id).await?;
        let parts = self.bot_context_parts(&bot).await;
        let text: String = parts.iter().map(|part| part.text.as_str()).collect();
        let sections: Vec<_> = parts
            .into_iter()
            .map(|part| BotContextSection {
                tokens: estimate_tokens(&part.text),
                label: part.label,
                path: part.path,
                error: part.error,
            })
            .collect();
        Ok(BotContextReport {
            total_tokens: sections.iter().map(|section| section.tokens).sum(),
            sections,
            text,
        })
    }

    /// FalconDeck's context folder plus well-known files at project roots.
    pub async fn context_files(&self) -> Result<ContextFileList, DaemonError> {
        let folder = self.context_folder();
        let projects: Vec<PathBuf> = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .filter(|ws| ws.summary.kind == falcondeck_core::WorkspaceKind::Project)
            .map(|ws| PathBuf::from(&ws.summary.path))
            .collect();
        let root = folder.clone();
        let files = tokio::task::spawn_blocking(move || -> Result<_, DaemonError> {
            std::fs::create_dir_all(&root)?;
            let mut files = text_files_in(&root, "FalconDeck", |_| true);
            let mut found: Vec<_> = projects
                .iter()
                .flat_map(|project| {
                    let location = project
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_default();
                    text_files_in(project, &location, |stem| {
                        PROJECT_CONTEXT_STEMS.contains(&stem.to_ascii_uppercase().as_str())
                    })
                })
                .collect();
            found.sort_by(|a, b| a.location.cmp(&b.location).then(a.name.cmp(&b.name)));
            files.extend(found);
            Ok(files)
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))??;
        Ok(ContextFileList {
            folder: folder.to_string_lossy().into(),
            files,
        })
    }

    /// Paths the context-file editor may open: suggestions plus attached files.
    async fn editable_context_path(&self, path: &str) -> Result<PathBuf, DaemonError> {
        let attached = self
            .inner
            .preferences
            .lock()
            .await
            .bots
            .iter()
            .any(|bot| bot.context_files.iter().any(|file| file == path));
        if attached
            || self
                .context_files()
                .await?
                .files
                .iter()
                .any(|file| file.path == path)
        {
            Ok(PathBuf::from(path))
        } else {
            Err(DaemonError::BadRequest(
                "Only FalconDeck context files, project context files and files attached to a bot can be edited here".into(),
            ))
        }
    }

    pub async fn read_context_file(&self, path: &str) -> Result<ContextFileContent, DaemonError> {
        let file_path = self.editable_context_path(path).await?;
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            let mut file = open_document(&file_path, false, false)?;
            let content = read_document(&mut file)?;
            Ok(ContextFileContent {
                version: document_version(&content),
                content,
                path,
            })
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))?
    }

    pub async fn write_context_file(
        &self,
        write: ContextFileWrite,
    ) -> Result<ContextFileContent, DaemonError> {
        let _gate = self.inner.bot_mutations.lock().await;
        if write.content.len() > MAX_DOCUMENT_BYTES {
            return Err(DaemonError::BadRequest(
                "Context file must be at most 1 MB".into(),
            ));
        }
        let (path, expected) = match (write.path, write.name) {
            (Some(path), None) => {
                let Some(expected) = write.expected_version else {
                    return Err(DaemonError::BadRequest(
                        "Open the file before saving it".into(),
                    ));
                };
                (self.editable_context_path(&path).await?, Some(expected))
            }
            (None, Some(name)) => {
                let folder = self.context_folder();
                tokio::fs::create_dir_all(&folder).await?;
                let path = document_path(&folder, name.trim())?;
                if !has_context_extension(&path) {
                    return Err(DaemonError::BadRequest(
                        "Context files must be .md, .markdown or .txt".into(),
                    ));
                }
                (path, None)
            }
            _ => {
                return Err(DaemonError::BadRequest(
                    "Give either an existing path or a new file name".into(),
                ));
            }
        };
        let content = write.content;
        tokio::task::spawn_blocking(move || {
            let mut file = open_document(&path, true, expected.is_none())?;
            if let Some(expected) = expected
                && document_version(&read_document(&mut file)?) != expected
            {
                return Err(DaemonError::Conflict(
                    "File changed on disk; reload before saving".into(),
                ));
            }
            file.rewind()?;
            file.set_len(0)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            Ok(ContextFileContent {
                path: path.to_string_lossy().into(),
                version: document_version(&content),
                content,
            })
        })
        .await
        .map_err(|e| DaemonError::Process(e.to_string()))?
    }
}

/// Regular, non-hidden text files directly inside `dir` whose stem passes `keep`.
fn text_files_in(dir: &Path, location: &str, keep: impl Fn(&str) -> bool) -> Vec<ContextFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .take(1000)
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let stem = path.file_stem()?.to_string_lossy().to_string();
            let meta = std::fs::symlink_metadata(&path).ok()?;
            (!name.starts_with('.')
                && meta.is_file()
                && has_context_extension(&path)
                && keep(&stem))
            .then(|| ContextFile {
                path: path.to_string_lossy().into(),
                name,
                location: location.into(),
                tokens: meta.len().div_ceil(4),
            })
        })
        .collect();
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    #[test]
    fn size_note_starts_at_eighty_percent() {
        assert_eq!(size_note("X", 799, 1000, "trim"), None);
        assert!(
            size_note("X", 800, 1000, "trim")
                .unwrap()
                .contains("before adding more")
        );
        assert!(
            size_note("X", 1001, 1000, "trim")
                .unwrap()
                .ends_with("trim now.")
        );
    }

    #[test]
    fn upkeep_flags_missing_large_and_stale_files() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        assert_eq!(
            upkeep_notes(dir.path(), now),
            ["STATUS.md is missing: create it."]
        );

        std::fs::write(dir.path().join("STATUS.md"), "ok").unwrap();
        std::fs::write(dir.path().join("MEMORY.md"), "x".repeat(9 * 1024)).unwrap();
        let notes = upkeep_notes(dir.path(), now);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].starts_with("MEMORY.md is 9.0 KB (limit 8.0 KB)"));

        let later = now + Duration::from_secs(50 * 60 * 60);
        assert!(
            upkeep_notes(dir.path(), later)
                .iter()
                .any(|note| note.contains("last updated 3 days ago"))
        );
    }
}
