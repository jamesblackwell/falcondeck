//! Recovery is staged for the next startup, before schedulers or providers run.
//! No database copies: native JSONL sessions are restored and indexed by the harness.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use falcondeck_core::{RecoveryArchive, RecoveryFile};
use std::fs;
use std::io::{Read, Write};

const MAX_BYTES: usize = 256 << 20;
const MAX_FILES: usize = 20_000;
const PENDING: &str = "pending-recovery.json";
const DIRECTORIES: &[&str] = &[
    "bots",
    "context",
    "attachments",
    "artifacts",
    "skills",
    "tickets",
    "extensions",
];
const CONFIGS: &[&str] = &[
    "daemon-state.json",
    "falcondeck.json",
    "agent-control.json",
    "scheduled-tasks.json",
    "connectors.json",
    "providers.json",
    "acp-agents.json",
    "rewrite-models.json",
    "extensions-state.json",
];

fn bad(message: &str) -> DaemonError {
    DaemonError::BadRequest(message.into())
}
fn home() -> Result<PathBuf, DaemonError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| bad("HOME is unavailable"))
}
fn native_root(scope: &str) -> Result<PathBuf, DaemonError> {
    let (variable, fallback) = match scope {
        "claude" => ("CLAUDE_CONFIG_DIR", ".claude"),
        "codex" => ("CODEX_HOME", ".codex"),
        _ => return Err(bad("Unknown recovery scope")),
    };
    Ok(std::env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or(home()?.join(fallback)))
}
fn regular_read(path: &Path, budget: usize) -> Result<Vec<u8>, DaemonError> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(bad("Recovery requires regular files"));
    }
    let before = file.metadata()?;
    let mut bytes = Vec::new();
    (&file).take(budget as u64 + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(bad(
            "A recovery source changed while reading; retry the backup",
        ));
    }
    if bytes.len() > budget {
        return Err(bad("Recovery exceeds the 256 MB limit"));
    }
    Ok(bytes)
}
fn collect(
    root: &Path,
    path: &Path,
    scope: &str,
    files: &mut Vec<RecoveryFile>,
    total: &mut usize,
) -> Result<(), DaemonError> {
    check_parents(path)?;
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(bad(
            "Recovery cannot include symbolic links; replace them with regular files",
        ));
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path)? {
            collect(root, &entry?.path(), scope, files, total)?;
        }
    } else if meta.is_file() {
        if files.len() >= MAX_FILES {
            return Err(bad("Recovery exceeds 20000 files"));
        }
        let data = regular_read(path, MAX_BYTES.saturating_sub(*total))?;
        *total += data.len();
        files.push(RecoveryFile {
            scope: scope.into(),
            path: path
                .strip_prefix(root)
                .map_err(|_| bad("Invalid source path"))?
                .to_string_lossy()
                .into(),
            data: STANDARD.encode(data),
        });
    } else {
        return Err(bad("Recovery encountered a non-regular file"));
    }
    Ok(())
}
fn session_files(
    base: &Path,
    root: &Path,
    ids: &HashSet<String>,
    scope: &str,
    files: &mut Vec<RecoveryFile>,
    total: &mut usize,
) -> Result<(), DaemonError> {
    if !root.exists() {
        return Ok(());
    }
    let mut dirs = vec![root.to_owned()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = entry.file_type()?;
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                dirs.push(path);
            } else if meta.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let selected = ids.iter().any(|id| {
                    name == format!("{id}.jsonl")
                        || name.ends_with(&format!("-{id}.jsonl"))
                        || path.components().any(|c| c.as_os_str() == id.as_str())
                });
                if selected {
                    collect(base, &path, scope, files, total)?;
                }
            }
        }
    }
    Ok(())
}
impl AppState {
    pub async fn export_recovery(&self) -> Result<RecoveryArchive, DaemonError> {
        // Persist current native IDs before reading the metadata snapshot.
        self.persist_local_state().await?;
        let root = self
            .state_dir()
            .ok_or_else(|| bad("State directory unavailable"))?;
        let state_path = self.inner.state_path.clone();
        tokio::task::spawn_blocking(move || build(&root, &state_path))
            .await
            .map_err(|e| bad(&e.to_string()))?
    }
    pub async fn stage_recovery(&self, archive: RecoveryArchive) -> Result<(), DaemonError> {
        if !self.preferences().await.bots.is_empty()
            || !self.inner.workspaces.lock().await.is_empty()
            || !self.inner.saved_workspaces.lock().await.is_empty()
        {
            return Err(bad(
                "Restore requires a fresh FalconDeck installation with no projects or bots",
            ));
        }
        let root = self
            .state_dir()
            .ok_or_else(|| bad("State directory unavailable"))?;
        let path = root.join(PENDING);
        tokio::task::spawn_blocking(move || {
            prepare(&archive, &root, false)?;
            if path.exists() {
                return Err(bad(
                    "A recovery is already staged; restart FalconDeck first",
                ));
            }
            let temp = root.join(format!(".recovery-{}", Uuid::new_v4()));
            private_create(&temp, &serde_json::to_vec(&archive)?)?;
            let result = fs::rename(&temp, &path).map_err(DaemonError::from);
            let _ = fs::remove_file(temp);
            result
        })
        .await
        .map_err(|e| bad(&e.to_string()))?
    }
}
fn build(root: &Path, state_path: &Path) -> Result<RecoveryArchive, DaemonError> {
    build_at(
        root,
        state_path,
        &native_root("claude")?,
        &native_root("codex")?,
        &home()?,
    )
}
fn build_at(
    root: &Path,
    state_path: &Path,
    claude: &Path,
    codex: &Path,
    source_home: &Path,
) -> Result<RecoveryArchive, DaemonError> {
    let preferences: falcondeck_core::FalconDeckPreferences =
        serde_json::from_slice(&regular_read(&root.join("falcondeck.json"), MAX_BYTES)?)?;
    let mut state: Value = serde_json::from_slice(&regular_read(state_path, MAX_BYTES)?)?;
    for workspace in state["workspaces"].as_array().into_iter().flatten() {
        for thread in workspace["thread_states"].as_array().into_iter().flatten() {
            if preferences
                .bots
                .iter()
                .any(|b| thread["thread_id"].as_str() == Some(&b.thread_id))
                && thread["status"].as_str() == Some("running")
            {
                return Err(bad(
                    "A bot is running. Retry recovery backup once its turn finishes",
                ));
            }
        }
    }
    state["remote"] = Value::Null;
    let mut files = vec![RecoveryFile {
        scope: "state".into(),
        path: "daemon-state.json".into(),
        data: STANDARD.encode(serde_json::to_vec(&state)?),
    }];
    let mut total = 0;
    for name in CONFIGS
        .iter()
        .filter(|n| **n != "daemon-state.json")
        .chain(DIRECTORIES.iter())
    {
        let path = root.join(name);
        if path.exists() {
            collect(root, &path, "state", &mut files, &mut total)?;
        }
    }
    // External context files and promoted bot document spaces become managed copies.
    for bot in &preferences.bots {
        if !Path::new(&bot.space_path).starts_with(root) {
            let start = files.len();
            let source = Path::new(&bot.space_path);
            collect(source, source, "state", &mut files, &mut total)?;
            for file in &mut files[start..] {
                file.path = format!("bots/{}/space/{}", bot.id, file.path);
            }
        }
        for (index, path) in bot.context_files.iter().enumerate() {
            if !Path::new(path).starts_with(root) {
                let bytes = regular_read(Path::new(path), MAX_BYTES.saturating_sub(total))?;
                total += bytes.len();
                files.push(RecoveryFile {
                    scope: "state".into(),
                    path: format!("bots/{}/recovered-context/{index}.txt", bot.id),
                    data: STANDARD.encode(bytes),
                });
            }
        }
    }
    for scope in ["claude", "codex"] {
        let ids: HashSet<String> = state["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|ws| ws["thread_states"].as_array().into_iter().flatten())
            .filter(|t| {
                preferences
                    .bots
                    .iter()
                    .any(|b| t["thread_id"].as_str() == Some(&b.thread_id))
            })
            .filter(|t| t["provider"].as_str() == Some(scope))
            .filter_map(|t| {
                t["native_session_id"]
                    .as_str()
                    .or_else(|| t["thread_id"].as_str())
                    .map(str::to_owned)
            })
            .collect();
        let base = if scope == "claude" { claude } else { codex };
        session_files(
            base,
            &base.join(if scope == "claude" {
                "projects"
            } else {
                "sessions"
            }),
            &ids,
            scope,
            &mut files,
            &mut total,
        )?;
        if scope == "codex" {
            session_files(
                base,
                &base.join("archived_sessions"),
                &ids,
                scope,
                &mut files,
                &mut total,
            )?;
        }
        if scope == "claude" {
            let projects: HashSet<PathBuf> = files
                .iter()
                .filter(|f| f.scope == "claude" && Path::new(&f.path).components().count() == 3)
                .filter_map(|f| Path::new(&f.path).parent().map(Path::to_owned))
                .collect();
            for project in projects {
                let memory = base.join(project).join("memory");
                if memory.exists() {
                    collect(base, &memory, scope, &mut files, &mut total)?;
                }
            }
        }
        for id in ids {
            if !files
                .iter()
                .any(|f| f.scope == scope && (f.path.ends_with(&format!("{id}.jsonl"))))
            {
                return Err(bad(&format!(
                    "Native session {id} is missing; backup was not saved"
                )));
            }
        }
    }
    // Refuse unsupported providers instead of advertising an incomplete recovery.
    for bot in &preferences.bots {
        let thread = state["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|ws| ws["thread_states"].as_array().into_iter().flatten())
            .find(|t| t["thread_id"].as_str() == Some(&bot.thread_id));
        if !thread.is_some_and(|t| matches!(t["provider"].as_str(), Some("claude" | "codex"))) {
            return Err(bad(&format!(
                "Bot {} has an unsupported or missing native session",
                bot.name
            )));
        }
    }
    if files.len() > MAX_FILES {
        return Err(bad("Recovery exceeds 20000 files"));
    }
    for file in &files {
        if !allowed(file) {
            return Err(bad("A recovery source cannot be represented safely"));
        }
        if file.scope != "state"
            && Path::new(&file.path)
                .extension()
                .is_some_and(|e| e == "jsonl")
        {
            let bytes = STANDARD
                .decode(&file.data)
                .map_err(|_| bad("Invalid session encoding"))?;
            let text = std::str::from_utf8(&bytes).map_err(|_| bad("Invalid session text"))?;
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                let _: Value = serde_json::from_str(line)?;
            }
        }
    }
    Ok(RecoveryArchive {
        version: 1,
        created_at: Utc::now(),
        source_home: source_home.to_string_lossy().into(),
        source_state: root.to_string_lossy().into(),
        bot_count: preferences.bots.len(),
        files,
        client: None,
    })
}
fn allowed(file: &RecoveryFile) -> bool {
    let path = Path::new(&file.path);
    if file.path.is_empty()
        || file
            .path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        || file.path.contains('\\')
        || !path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return false;
    }
    let first = path
        .components()
        .next()
        .unwrap()
        .as_os_str()
        .to_string_lossy();
    match file.scope.as_str() {
        "state" => CONFIGS.contains(&file.path.as_str()) || DIRECTORIES.contains(&first.as_ref()),
        "claude" => {
            first == "projects"
                && (path.extension().is_some_and(|e| e == "jsonl")
                    || path.components().count() >= 4)
        }
        "codex" => {
            matches!(first.as_ref(), "sessions" | "archived_sessions")
                && path.extension().is_some_and(|e| e == "jsonl")
        }
        _ => false,
    }
}
fn remap(value: &mut Value, old: &str, new: &str, old_home: &str, new_home: &str) {
    match value {
        Value::String(s) => {
            for (from, to) in [(old, new), (old_home, new_home)] {
                if s == from || s.starts_with(&format!("{from}/")) {
                    *s = format!("{to}{}", &s[from.len()..]);
                    break;
                }
            }
        }
        Value::Array(values) => {
            for v in values {
                remap(v, old, new, old_home, new_home);
            }
        }
        Value::Object(values) => {
            for (key, v) in values.iter_mut() {
                if !matches!(
                    key.as_str(),
                    "message" | "content" | "text" | "input" | "output" | "instructions"
                ) {
                    remap(v, old, new, old_home, new_home);
                }
            }
        }
        _ => {}
    }
}
fn prepare(
    archive: &RecoveryArchive,
    root: &Path,
    resuming: bool,
) -> Result<Vec<(PathBuf, Vec<u8>)>, DaemonError> {
    prepare_at(
        archive,
        root,
        resuming,
        &native_root("claude")?,
        &native_root("codex")?,
        &home()?,
    )
}
fn prepare_at(
    archive: &RecoveryArchive,
    root: &Path,
    resuming: bool,
    claude: &Path,
    codex: &Path,
    current_home: &Path,
) -> Result<Vec<(PathBuf, Vec<u8>)>, DaemonError> {
    if archive.version != 1
        || archive.files.len() > MAX_FILES
        || !Path::new(&archive.source_home).is_absolute()
        || !Path::new(&archive.source_state).is_absolute()
    {
        return Err(bad("Unsupported recovery archive"));
    }
    let encoded_total: usize = archive.files.iter().map(|f| f.data.len()).sum();
    if encoded_total > (MAX_BYTES * 4 / 3 + MAX_FILES * 4) {
        return Err(bad("Recovery exceeds 256 MB"));
    }
    let state_file = archive
        .files
        .iter()
        .find(|f| f.scope == "state" && f.path == "daemon-state.json")
        .ok_or_else(|| bad("Missing daemon state"))?;
    let preferences_file = archive
        .files
        .iter()
        .find(|f| f.scope == "state" && f.path == "falcondeck.json")
        .ok_or_else(|| bad("Missing bot preferences"))?;
    let state: Value = serde_json::from_slice(
        &STANDARD
            .decode(&state_file.data)
            .map_err(|_| bad("Invalid state data"))?,
    )?;
    let preferences: Value = serde_json::from_slice(
        &STANDARD
            .decode(&preferences_file.data)
            .map_err(|_| bad("Invalid preference data"))?,
    )?;
    let _: falcondeck_core::FalconDeckPreferences = serde_json::from_value(preferences.clone())?;
    let _: PersistedAppState = serde_json::from_value(state.clone())?;
    if preferences["bots"].as_array().map_or(0, Vec::len) != archive.bot_count {
        return Err(bad("Recovery bot count does not match its manifest"));
    }
    let mut workspace_mappings = Vec::new();
    for bot in preferences["bots"].as_array().into_iter().flatten() {
        if let Some(ws) = state["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|w| w["id"] == bot["workspace_id"])
        {
            let old = ws["path"]
                .as_str()
                .ok_or_else(|| bad("Missing bot workspace path"))?;
            if !Path::new(old).starts_with(&archive.source_state) {
                let id = bot["id"]
                    .as_str()
                    .ok_or_else(|| bad("Invalid bot identity"))?;
                if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                    return Err(bad("Invalid bot identity"));
                }
                workspace_mappings.push((
                    old.to_owned(),
                    root.join("bots")
                        .join(id)
                        .join("workspace")
                        .to_string_lossy()
                        .into_owned(),
                ));
            }
        } else {
            return Err(bad("Bot workspace metadata is missing"));
        }
    }
    let mut project_mappings = Vec::new();
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    let mut total = 0;
    for file in &archive.files {
        if !allowed(file) {
            return Err(bad("Archive contains an unsafe recovery path"));
        }
        let target_root = match file.scope.as_str() {
            "state" => root.to_owned(),
            "claude" => claude.to_owned(),
            "codex" => codex.to_owned(),
            _ => return Err(bad("Unknown recovery scope")),
        };
        let mut target = target_root.join(&file.path);
        if file.data.len() > (MAX_BYTES - total) * 4 / 3 + 4 {
            return Err(bad("Recovery exceeds 256 MB"));
        }
        let mut bytes = STANDARD
            .decode(&file.data)
            .map_err(|_| bad("Invalid recovery data"))?;
        total += bytes.len();
        if total > MAX_BYTES {
            return Err(bad("Recovery exceeds 256 MB"));
        }
        if (file.scope != "state"
            && Path::new(&file.path)
                .extension()
                .is_some_and(|e| e == "jsonl"))
            || [
                "daemon-state.json",
                "falcondeck.json",
                "agent-control.json",
                "scheduled-tasks.json",
            ]
            .contains(&file.path.as_str())
        {
            let text = String::from_utf8(bytes).map_err(|_| bad("Invalid native session data"))?;
            let mut values = Vec::new();
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                let mut value: Value =
                    serde_json::from_str(line).or_else(|_| serde_json::from_str(&text))?;
                for (old, new) in &workspace_mappings {
                    remap(&mut value, old, new, old, new);
                }
                remap(
                    &mut value,
                    &archive.source_state,
                    &root.to_string_lossy(),
                    &archive.source_home,
                    &current_home.to_string_lossy(),
                );
                if file.path == "daemon-state.json" {
                    value["remote"] = Value::Null;
                }
                if file.path == "falcondeck.json" {
                    value["computer_use"] = serde_json::to_value(
                        falcondeck_core::FalconDeckPreferences::default().computer_use,
                    )?;
                    if let Some(bots) = value["bots"].as_array_mut() {
                        for bot in bots {
                            let id = bot["id"]
                                .as_str()
                                .ok_or_else(|| bad("Invalid bot identity"))?
                                .to_owned();
                            if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                                return Err(bad("Invalid bot identity"));
                            }
                            bot["space_path"] = json!(root.join("bots").join(&id).join("space"));
                            if let Some(context) = bot["context_files"].as_array_mut() {
                                for (i, path) in context.iter_mut().enumerate() {
                                    let recovered = format!("bots/{id}/recovered-context/{i}.txt");
                                    if archive
                                        .files
                                        .iter()
                                        .any(|f| f.scope == "state" && f.path == recovered)
                                    {
                                        *path = json!(root.join(recovered));
                                    }
                                }
                            }
                        }
                    }
                }
                if file.path == "agent-control.json" {
                    value["settings"]["enabled"] = json!(false);
                    if let Some(items) = value["automations"].as_array_mut() {
                        for item in items {
                            item["state"] = json!("paused");
                        }
                    }
                }
                if file.path == "scheduled-tasks.json" {
                    pause(&mut value);
                }
                if file.scope == "claude"
                    && target.parent().and_then(|p| p.parent())
                        == Some(target_root.join("projects").as_path())
                {
                    if let Some(cwd) = value["cwd"].as_str() {
                        let encoded: String = cwd
                            .chars()
                            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                            .collect();
                        if encoded.len() > 200 {
                            return Err(bad("Claude project path is too long for recovery"));
                        }
                        let project = target_root.join("projects").join(encoded);
                        let mapping = (
                            target_root.join(Path::new(&file.path).parent().unwrap()),
                            project.clone(),
                        );
                        if !project_mappings.contains(&mapping) {
                            project_mappings.push(mapping);
                        }
                        target = project.join(target.file_name().unwrap());
                    }
                }
                values.push(serde_json::to_string(&value)?);
                if file.scope == "state" {
                    break;
                }
            }
            bytes = (values.join("\n") + "\n").into_bytes();
        }
        if !seen.insert(target.clone()) {
            return Err(bad("Duplicate recovery path"));
        }
        check_parents(&target)?;
        if target.exists()
            && !resuming
            && !(file.scope == "state" && CONFIGS.contains(&file.path.as_str()))
        {
            return Err(bad(
                "Recovery would overwrite existing files; use a fresh installation",
            ));
        }
        output.push((target, bytes));
    }
    for required in ["falcondeck.json", "daemon-state.json"] {
        if !archive
            .files
            .iter()
            .any(|f| f.scope == "state" && f.path == required)
        {
            return Err(bad("Recovery archive is missing core configuration"));
        }
    }
    for (path, _) in &mut output {
        for (from, to) in &project_mappings {
            if let Ok(relative) = path.strip_prefix(from) {
                *path = to.join(relative);
                break;
            }
        }
    }
    let mut final_paths = HashSet::new();
    for (path, bytes) in &output {
        check_parents(path)?;
        if !final_paths.insert(path) {
            return Err(bad("Duplicate relocated recovery destination"));
        }
        if path.exists() && !resuming && !CONFIGS.iter().any(|name| path == &root.join(name)) {
            return Err(bad("Recovery destination already exists"));
        }
        if bytes.len() > MAX_BYTES {
            return Err(bad("Recovery file exceeds limit"));
        }
    }
    Ok(output)
}
fn pause(value: &mut Value) {
    match value {
        Value::Object(o) => {
            if o.contains_key("enabled") {
                o.insert("enabled".into(), json!(false));
            }
            if o.get("status").and_then(Value::as_str) == Some("active") {
                o.insert("status".into(), json!("paused"));
            }
            for v in o.values_mut() {
                pause(v);
            }
        }
        Value::Array(a) => {
            for v in a {
                pause(v);
            }
        }
        _ => {}
    }
}
fn check_parents(path: &Path) -> Result<(), DaemonError> {
    for parent in path.ancestors() {
        if fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(bad("Recovery destination contains a symbolic link"));
        }
    }
    Ok(())
}
fn private_directories(path: &Path) -> Result<(), DaemonError> {
    if path.exists() {
        check_parents(path)?;
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        private_directories(parent)?;
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
fn private_create(path: &Path, bytes: &[u8]) -> Result<(), DaemonError> {
    if let Some(parent) = path.parent() {
        private_directories(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
/// Called with the daemon's exclusive state lock, before any state is loaded.
pub(crate) fn apply_pending(state_path: &Path) -> Result<(), DaemonError> {
    let root = state_path
        .parent()
        .ok_or_else(|| bad("State directory unavailable"))?;
    let pending = root.join(PENDING);
    if !pending.exists() {
        let _ = fs::remove_file(root.join("recovery-in-progress"));
        return Ok(());
    }
    let archive: RecoveryArchive = serde_json::from_slice(&regular_read(&pending, 384 << 20)?)?;
    let marker = root.join("recovery-in-progress");
    if !marker.exists() {
        if let Ok(bytes) = fs::read(state_path) {
            let value: Value = serde_json::from_slice(&bytes)?;
            if value["workspaces"]
                .as_array()
                .is_some_and(|w| !w.is_empty())
            {
                return Err(bad(
                    "Recovery requires a fresh installation with no projects",
                ));
            }
        }
        if let Ok(bytes) = fs::read(root.join("falcondeck.json")) {
            let value: Value = serde_json::from_slice(&bytes)?;
            if value["bots"].as_array().is_some_and(|b| !b.is_empty()) {
                return Err(bad("Recovery requires a fresh installation"));
            }
        }
    }
    let output = prepare(&archive, root, marker.exists())?;
    if !marker.exists() {
        private_create(&marker, b"1")?;
    }
    // The marker records that preflight succeeded on this fresh instance.
    // Replaying atomic file replacements makes a power loss resumable on startup.
    for (mut path, bytes) in output {
        if path == root.join("daemon-state.json") {
            path = state_path.to_owned();
        }
        check_parents(&path)?;
        let parent = path
            .parent()
            .ok_or_else(|| bad("Missing recovery parent"))?;
        private_directories(parent)?;
        let temp = parent.join(format!(".recovery-{}", Uuid::new_v4()));
        private_create(&temp, &bytes)?;
        if let Err(error) = fs::rename(&temp, &path) {
            let _ = fs::remove_file(temp);
            return Err(error.into());
        }
    }
    let restored: Value =
        serde_json::from_slice(&regular_read(&root.join("falcondeck.json"), MAX_BYTES)?)?;
    for bot in restored["bots"].as_array().into_iter().flatten() {
        if let Some(id) = bot["id"].as_str() {
            private_directories(&root.join("bots").join(id).join("workspace"))?;
            private_directories(&root.join("bots").join(id).join("space"))?;
        }
    }
    fs::remove_file(pending)?;
    fs::remove_file(marker)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(scope: &str, path: &str, value: Value) -> RecoveryFile {
        RecoveryFile {
            scope: scope.into(),
            path: path.into(),
            data: STANDARD.encode(serde_json::to_vec(&value).unwrap()),
        }
    }
    fn fixture() -> RecoveryArchive {
        RecoveryArchive {
            version: 1,
            created_at: Utc::now(),
            source_home: "/Users/old".into(),
            source_state: "/Users/old/.falcondeck".into(),
            bot_count: 1,
            client: None,
            files: vec![
                entry(
                    "state",
                    "falcondeck.json",
                    json!({"bots": [{"id":"bot-one", "name":"CTO", "dedicated_workspace":true, "workspace_id":"w", "thread_id":"session-one", "space_path":"/Users/old/.falcondeck/bots/bot-one/space", "context_files":[]}]}),
                ),
                entry(
                    "state",
                    "daemon-state.json",
                    json!({"remote":{"secret":"must disappear"}, "workspaces":[{"id":"w", "path":"/Users/old/.falcondeck/bots/bot-one", "thread_states":[{"thread_id":"session-one", "provider":"claude", "native_session_id":"session-one"}]}]}),
                ),
                entry(
                    "state",
                    "agent-control.json",
                    json!({"settings":{"enabled":true},"automations":[{"state":"enabled"}]}),
                ),
                entry(
                    "state",
                    "scheduled-tasks.json",
                    json!({"tasks":{"t":{"detail":{"summary":{"status":"active"}}}}}),
                ),
                RecoveryFile {
                    scope: "state".into(),
                    path: "bots/bot-one/space/memory/decisions.md".into(),
                    data: STANDARD.encode(b"valuable decisions"),
                },
            ],
        }
    }
    #[test]
    fn fresh_restore_relocates_pauses_and_preserves_nested_memory() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("state");
        let archive = fixture();
        let output = prepare_at(
            &archive,
            &root,
            false,
            &temp.path().join("claude"),
            &temp.path().join("codex"),
            temp.path(),
        )
        .unwrap();
        let state: Value = serde_json::from_slice(
            &output
                .iter()
                .find(|(p, _)| p.ends_with("daemon-state.json"))
                .unwrap()
                .1,
        )
        .unwrap();
        assert!(state["remote"].is_null());
        assert_eq!(
            state["workspaces"][0]["path"],
            root.join("bots/bot-one").to_str().unwrap()
        );
        let control: Value = serde_json::from_slice(
            &output
                .iter()
                .find(|(p, _)| p.ends_with("agent-control.json"))
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!(control["settings"]["enabled"], false);
        assert_eq!(control["automations"][0]["state"], "paused");
        let schedule: Value = serde_json::from_slice(
            &output
                .iter()
                .find(|(p, _)| p.ends_with("scheduled-tasks.json"))
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!(
            schedule["tasks"]["t"]["detail"]["summary"]["status"],
            "paused"
        );
        assert_eq!(
            output
                .iter()
                .find(|(p, _)| p.ends_with("decisions.md"))
                .unwrap()
                .1,
            b"valuable decisions"
        );
    }
    #[test]
    fn rejects_unsafe_paths_unknown_versions_duplicates_and_existing_documents() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path();
        for path in [
            "../escape",
            "/absolute",
            "bots/../../escape",
            "bots/./file",
            "remote-secrets.json",
        ] {
            let mut archive = fixture();
            archive.files.push(RecoveryFile {
                scope: "state".into(),
                path: path.into(),
                data: String::new(),
            });
            assert!(prepare(&archive, root, false).is_err(), "{path}");
        }
        let mut archive = fixture();
        archive.version = 42;
        assert!(prepare(&archive, root, false).is_err());
        let mut archive = fixture();
        archive.files.push(archive.files[0].clone());
        assert!(prepare(&archive, root, false).is_err());
        fs::create_dir_all(root.join("bots/bot-one/space/memory")).unwrap();
        fs::write(
            root.join("bots/bot-one/space/memory/decisions.md"),
            "existing",
        )
        .unwrap();
        assert!(prepare(&fixture(), root, false).is_err());
    }
    #[test]
    fn restores_native_claude_and_codex_under_new_roots() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("state");
        let claude = temp.path().join("claude");
        let codex = temp.path().join("codex");
        let mut archive = fixture();
        archive.files.push(entry("claude", "projects/-Users-old--falcondeck-bots-bot-one/session-one.jsonl", json!({"type":"user", "cwd":"/Users/old/.falcondeck/bots/bot-one", "message":{"content":"original transcript"}})));
        archive.files.push(entry(
            "codex",
            "sessions/2026/10/rollout-session-two.jsonl",
            json!({"type":"session_meta", "payload":{"cwd":"/Users/old/.falcondeck/bots/bot-one"}}),
        ));
        let output = prepare_at(&archive, &root, false, &claude, &codex, temp.path()).unwrap();
        let (path, bytes) = output
            .iter()
            .find(|(p, _)| p.ends_with("session-one.jsonl"))
            .unwrap();
        assert!(path.starts_with(&claude));
        assert!(!path.to_string_lossy().contains("Users-old"));
        let line: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(line["cwd"], root.join("bots/bot-one").to_str().unwrap());
        assert_eq!(line["message"]["content"], "original transcript");
        assert!(output.iter().any(|(p, _)| p.starts_with(&codex)));
    }
    #[test]
    fn startup_applies_pending_and_resumes_an_interrupted_install() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path();
        let state = root.join("daemon-state.json");
        private_create(
            &root.join(PENDING),
            &serde_json::to_vec(&fixture()).unwrap(),
        )
        .unwrap();
        // Simulate a power failure after a partial document write.
        private_create(&root.join("recovery-in-progress"), b"1").unwrap();
        private_create(
            &root.join("bots/bot-one/space/memory/decisions.md"),
            b"partial",
        )
        .unwrap();
        apply_pending(&state).unwrap();
        assert_eq!(
            fs::read(root.join("bots/bot-one/space/memory/decisions.md")).unwrap(),
            b"valuable decisions"
        );
        assert!(!root.join(PENDING).exists());
        assert!(!root.join("recovery-in-progress").exists());
        assert!(state.exists());
    }
    #[test]
    fn captures_only_selected_native_sessions_and_fails_on_symlinks() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let base = temp.path();
        let projects = base.join("projects/project");
        fs::create_dir_all(&projects).unwrap();
        fs::write(projects.join("selected.jsonl"), "{}\n").unwrap();
        fs::write(projects.join("ordinary.jsonl"), "{}\n").unwrap();
        let mut files = Vec::new();
        let mut total = 0;
        session_files(
            base,
            &base.join("projects"),
            &HashSet::from(["selected".into()]),
            "claude",
            &mut files,
            &mut total,
        )
        .unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].path.ends_with("selected.jsonl"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(projects.join("ordinary.jsonl"), base.join("link")).unwrap();
            assert!(collect(base, &base.join("link"), "state", &mut files, &mut total).is_err());
        }
    }
    #[test]
    fn capture_and_restore_a_bot_on_a_clean_replacement_home() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let old_home = temp.path().join("old");
        let root = old_home.join(".falcondeck");
        let claude = old_home.join(".claude");
        let codex = old_home.join(".codex");
        let mut source = fixture();
        for file in &mut source.files {
            if file.path.ends_with(".json") {
                let mut value: Value =
                    serde_json::from_slice(&STANDARD.decode(&file.data).unwrap()).unwrap();
                remap(
                    &mut value,
                    "/Users/old/.falcondeck",
                    root.to_str().unwrap(),
                    "/Users/old",
                    old_home.to_str().unwrap(),
                );
                if file.path == "falcondeck.json" {
                    value["bots"][0]["context_files"] = json!([old_home.join("company.txt")]);
                }
                file.data = STANDARD.encode(serde_json::to_vec(&value).unwrap());
            }
            private_create(
                &root.join(&file.path),
                &STANDARD.decode(&file.data).unwrap(),
            )
            .unwrap();
        }
        private_create(&old_home.join("company.txt"), b"company goals").unwrap();
        let project = claude.join("projects/original-project");
        private_create(&project.join("session-one.jsonl"), (json!({"type":"user", "cwd":root.join("bots/bot-one"), "sessionId":"session-one", "message":{"content":"valuable conversation"}}).to_string()+"\n").as_bytes()).unwrap();
        private_create(&project.join("ordinary-session.jsonl"), b"{}\n").unwrap();
        private_create(
            &project.join("session-one/tool-results/result.txt"),
            b"long tool result",
        )
        .unwrap();
        private_create(&project.join("memory/MEMORY.md"), b"native auto memory").unwrap();
        let captured = build_at(
            &root,
            &root.join("daemon-state.json"),
            &claude,
            &codex,
            &old_home,
        )
        .unwrap();
        assert_eq!(captured.bot_count, 1);
        assert!(
            !captured
                .files
                .iter()
                .any(|f| f.path.contains("ordinary-session"))
        );
        assert!(
            captured
                .files
                .iter()
                .any(|f| f.path.ends_with("tool-results/result.txt"))
        );
        let new_home = temp.path().join("replacement");
        let target = new_home.join(".falcondeck");
        let output = prepare_at(
            &captured,
            &target,
            false,
            &new_home.join(".claude"),
            &new_home.join(".codex"),
            &new_home,
        )
        .unwrap();
        for (path, bytes) in &output {
            assert!(path.starts_with(&new_home));
            private_create(path, bytes).unwrap();
        }
        assert_eq!(
            fs::read(target.join("bots/bot-one/space/memory/decisions.md")).unwrap(),
            b"valuable decisions"
        );
        assert_eq!(
            fs::read(target.join("bots/bot-one/recovered-context/0.txt")).unwrap(),
            b"company goals"
        );
        let session = output
            .iter()
            .find(|(p, _)| p.ends_with("session-one.jsonl"))
            .unwrap();
        let value: Value = serde_json::from_slice(&session.1).unwrap();
        assert_eq!(value["cwd"], target.join("bots/bot-one").to_str().unwrap());
        let memory = output
            .iter()
            .find(|(p, _)| p.ends_with("memory/MEMORY.md"))
            .unwrap();
        assert_eq!(memory.1, b"native auto memory");
        assert_eq!(memory.0.parent().unwrap().parent(), session.0.parent());
    }
}
