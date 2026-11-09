//! Scheduled disk hygiene. All destructive paths revalidate under admission gates.
use super::*;
use falcondeck_core::{ThreadVariant, storage::*};
use std::{
    collections::BTreeMap,
    path::{Component, Path},
    time::SystemTime,
};

const DAY: i64 = 86400;
const GIB: u64 = 1024 * 1024 * 1024;
const CACHE_NAMES: &[&str] = &[
    "node_modules",
    "DerivedData",
    ".next",
    ".nuxt",
    ".turbo",
    ".pytest_cache",
    "__pycache__",
    ".phpunit.cache",
    ".react-router",
];
const CACHE_PATHS: &[&str] = &[
    "target",
    "dist",
    "build",
    "vendor",
    ".venv",
    "frontend/dist",
    "frontend/build",
    "ios/build",
    "android/build",
    "android/app/build",
];

#[derive(Default)]
struct Facts {
    bytes: u64,
    newest: i64,
    caches: Vec<(PathBuf, u64)>,
    contains_git: bool,
}
fn seconds(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(i64::MAX)
}
fn relative_path(s: &str) -> bool {
    !s.is_empty()
        && Path::new(s)
            .components()
            .all(|c| matches!(c, Component::Normal(n) if n != ".git"))
}
fn scan(path: &Path, custom: &[String]) -> std::io::Result<Facts> {
    fn walk(
        root: &Path,
        p: &Path,
        custom: &[String],
        in_cache: bool,
        seen: &mut HashSet<(u64, u64)>,
    ) -> std::io::Result<Facts> {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::symlink_metadata(p)?;
        let mut f = Facts {
            newest: seconds(m.modified()?),
            contains_git: p.file_name().is_some_and(|n| n == ".git"),
            ..Facts::default()
        };
        if seen.insert((m.dev(), m.ino())) {
            f.bytes = m.blocks().saturating_mul(512);
        }
        if m.is_dir() && !m.file_type().is_symlink() {
            let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy();
            let cache = !in_cache
                && (p
                    .file_name()
                    .is_some_and(|n| CACHE_NAMES.iter().any(|s| n == *s))
                    || CACHE_PATHS.contains(&rel.as_ref())
                    || custom.iter().any(|s| s == &rel));
            for e in std::fs::read_dir(p)? {
                let child = match walk(root, &e?.path(), custom, in_cache || cache, seen) {
                    Ok(f) => f,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e),
                };
                f.bytes = f.bytes.saturating_add(child.bytes);
                f.newest = f.newest.max(child.newest);
                f.contains_git |= child.contains_git;
                f.caches.extend(child.caches);
            }
            if cache {
                f.caches.push((p.to_path_buf(), f.bytes));
            }
        }
        Ok(f)
    }
    walk(path, path, custom, false, &mut HashSet::new())
}
async fn facts(path: PathBuf, custom: Vec<String>) -> Result<Facts, DaemonError> {
    // A dedicated background-QoS thread keeps large inode walks off Tokio's
    // runtime and does not lower the priority of unrelated daemon work.
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        unsafe {
            unsafe extern "C" {
                fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32;
            }
            pthread_set_qos_class_self_np(0x09, 0);
        }
        let _ = tx.send(scan(&path, &custom));
    });
    rx.await
        .map_err(|e| DaemonError::Rpc(e.to_string()))?
        .map_err(|e| DaemonError::Rpc(e.to_string()))
}
async fn remove_background(path: PathBuf) -> Result<(), DaemonError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        unsafe {
            unsafe extern "C" {
                fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32;
            }
            pthread_set_qos_class_self_np(0x09, 0);
        }
        let result = std::fs::symlink_metadata(&path).and_then(|m| {
            if m.file_type().is_symlink() {
                return Err(std::io::Error::other("Symlink retained"));
            }
            if m.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            }
        });
        let _ = tx.send(result);
    });
    rx.await
        .map_err(|e| DaemonError::Rpc(e.to_string()))?
        .map_err(DaemonError::Io)
}
async fn git(path: &str, args: &[&str]) -> Result<String, DaemonError> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new("nice")
            .args(["-n", "10", "git", "--no-optional-locks", "-C", path])
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| DaemonError::Rpc("Storage Git check timed out".into()))?
    .map_err(|e| DaemonError::Rpc(e.to_string()))?;
    if !output.status.success() {
        return Err(DaemonError::Rpc(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
fn quiet(t: &ManagedThread) -> bool {
    t.summary.status == ThreadStatus::Idle
        && t.summary.queued_turns.is_empty()
        && t.queued_requests.is_empty()
        && t.dispatching_request.is_none()
}
fn due(idle_age: i64, archived: bool, newest: i64, now: i64, action: StorageAction) -> bool {
    now.saturating_sub(newest) > DAY
        && match action {
            StorageAction::ClearCaches => idle_age > 3 * DAY,
            StorageAction::Reclaim => archived || idle_age > 14 * DAY,
        }
}
pub(super) fn disk_level(bytes: u64) -> &'static str {
    if bytes < 15 * GIB {
        "critical"
    } else if bytes < 30 * GIB {
        "low"
    } else {
        "normal"
    }
}
impl AppState {
    pub(super) fn storage_root(&self) -> PathBuf {
        self.inner
            .state_path
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf()
    }
    async fn storage_json<T: serde::de::DeserializeOwned + Default>(
        &self,
        name: &str,
    ) -> Result<T, DaemonError> {
        match tokio::fs::read(self.storage_root().join(name)).await {
            Ok(b) => serde_json::from_slice(&b)
                .map_err(|e| DaemonError::Rpc(format!("Invalid {name}: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
            Err(e) => Err(DaemonError::Rpc(e.to_string())),
        }
    }
    async fn write_storage_json<T: serde::Serialize>(
        &self,
        name: &str,
        value: &T,
    ) -> Result<(), DaemonError> {
        let root = self.storage_root();
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(|e| DaemonError::Rpc(e.to_string()))?;
        let temp = root.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
        let bytes = serde_json::to_vec(value).map_err(|e| DaemonError::Rpc(e.to_string()))?;
        tokio::fs::write(&temp, bytes)
            .await
            .map_err(|e| DaemonError::Rpc(e.to_string()))?;
        let result = tokio::fs::rename(&temp, root.join(name)).await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(temp).await;
        }
        result.map_err(|e| DaemonError::Rpc(e.to_string()))
    }
    pub async fn storage_preferences(&self) -> Result<StoragePreferences, DaemonError> {
        self.storage_json("storage-preferences.json").await
    }
    pub async fn update_storage_preferences(
        &self,
        p: StoragePreferences,
    ) -> Result<StoragePreferences, DaemonError> {
        let _guard = self.inner.storage_gate.lock().await;
        self.write_storage_json("storage-preferences.json", &p)
            .await?;
        Ok(p)
    }
    async fn cache_hook(project: &str) -> Result<Vec<String>, DaemonError> {
        let raw = git(
            project,
            &["config", "--local", "--get", "falcondeck.storageCaches"],
        )
        .await;
        // Exit 1 means absent; any malformed supplied recipe fails closed.
        let Ok(raw) = raw else {
            return Ok(Vec::new());
        };
        let paths: Vec<String> = serde_json::from_str(raw.trim())
            .map_err(|e| DaemonError::Rpc(format!("Invalid falcondeck.storageCaches: {e}")))?;
        if paths.iter().any(|p| !relative_path(p)) {
            return Err(DaemonError::Rpc("Storage cache paths must be relative directories without .git or parent components".into()));
        }
        Ok(paths)
    }
    async fn storage_identity(&self, project: &str, v: &ThreadVariant) -> Result<(), DaemonError> {
        if tokio::fs::symlink_metadata(self.storage_root().join("variants"))
            .await?
            .file_type()
            .is_symlink()
        {
            return Err(DaemonError::Rpc(
                "Symlink variant roots are retained".into(),
            ));
        }
        let root = tokio::fs::canonicalize(self.storage_root().join("variants"))
            .await
            .map_err(|e| DaemonError::Rpc(e.to_string()))?;
        let p = Path::new(&v.path);
        let canonical = tokio::fs::canonicalize(p)
            .await
            .map_err(|e| DaemonError::Rpc(e.to_string()))?;
        let relative = p
            .strip_prefix(self.storage_root().join("variants"))
            .map_err(|_| DaemonError::Rpc("Not a managed variant path".into()))?;
        let mut cursor = self.storage_root().join("variants");
        for c in relative.components() {
            if !matches!(c, Component::Normal(_)) {
                return Err(DaemonError::Rpc("Invalid variant path".into()));
            }
            cursor.push(c);
            if tokio::fs::symlink_metadata(&cursor)
                .await
                .map_err(|e| DaemonError::Rpc(e.to_string()))?
                .file_type()
                .is_symlink()
            {
                return Err(DaemonError::Rpc(
                    "Symlink variant paths are retained".into(),
                ));
            }
        }
        if !canonical.starts_with(&root)
            || canonical == root
            || v.kind != falcondeck_core::ThreadVariantKind::Worktree
            || !p.join(".git").is_file()
        {
            return Err(DaemonError::Rpc("Not a managed Git worktree".into()));
        }
        if git(&v.path, &["symbolic-ref", "--short", "HEAD"])
            .await?
            .trim()
            != v.branch
        {
            return Err(DaemonError::Rpc(
                "Variant branch changed; retained for review".into(),
            ));
        }
        let top = git(&v.path, &["rev-parse", "--show-toplevel"]).await?;
        if tokio::fs::canonicalize(top.trim()).await.ok().as_ref() != Some(&canonical)
            || tokio::fs::canonicalize(project).await.ok().as_ref() == Some(&canonical)
        {
            return Err(DaemonError::Rpc("Main checkouts are protected".into()));
        }
        let ws = self.inner.workspaces.lock().await;
        if ws
            .values()
            .any(|w| std::fs::canonicalize(&w.summary.path).ok().as_ref() == Some(&canonical))
            || ws
                .values()
                .flat_map(|w| w.threads.values())
                .filter(|t| t.summary.variant.as_ref().is_some_and(|a| a.path == v.path))
                .count()
                != 1
        {
            return Err(DaemonError::Rpc(
                "Shared or main checkouts are protected".into(),
            ));
        }
        Ok(())
    }
    async fn cache_paths(&self, project: &str, v: &ThreadVariant) -> Result<Facts, DaemonError> {
        facts(PathBuf::from(&v.path), Self::cache_hook(project).await?).await
    }
    pub async fn storage_report(&self) -> Result<StorageReport, DaemonError> {
        let _guard = self.inner.storage_gate.lock().await;
        self.storage_inventory().await
    }
    async fn storage_inventory(&self) -> Result<StorageReport, DaemonError> {
        let root = self.storage_root();
        let now = Utc::now().timestamp();
        let mut categories = BTreeMap::new();
        let mut candidates = Vec::new();
        let mut total = 0;
        if root.exists() {
            for e in std::fs::read_dir(&root).map_err(|e| DaemonError::Rpc(e.to_string()))? {
                let e = e.map_err(|e| DaemonError::Rpc(e.to_string()))?;
                let name = e.file_name().to_string_lossy().into_owned();
                // The category roots are fixed; arbitrary state files only contribute to Other.
                let cat = match name.as_str() {
                    "variants" => "variants",
                    "artifacts" => "artifacts",
                    "experiments" => "experiments",
                    "codex-sqlite" => "codex_databases",
                    "logs" => "logs",
                    _ => "other",
                };
                let f = facts(e.path(), Vec::new()).await?;
                total += f.bytes;
                *categories.entry(cat.to_string()).or_insert(0) += f.bytes;
                if matches!(cat, "artifacts" | "experiments") && e.path().is_dir() {
                    for child in
                        std::fs::read_dir(e.path()).map_err(|e| DaemonError::Rpc(e.to_string()))?
                    {
                        let p = child.map_err(|e| DaemonError::Rpc(e.to_string()))?.path();
                        let f = facts(p.clone(), Vec::new()).await?;
                        if now.saturating_sub(f.newest) > 30 * DAY {
                            candidates.push(StorageCandidate {
                                category: cat.into(),
                                path: p.to_string_lossy().into_owned(),
                                bytes: f.bytes,
                                blocked: f
                                    .contains_git
                                    .then(|| "Contains Git state; retain for manual review".into()),
                            });
                        }
                    }
                }
            }
        }
        categories.insert("total".into(), total);
        let targets = {
            let ws = self.inner.workspaces.lock().await;
            ws.iter()
                .flat_map(|(wid, w)| {
                    w.threads.iter().filter_map(move |(tid, t)| {
                        t.summary.variant.clone().map(|v| {
                            (
                                wid.clone(),
                                tid.clone(),
                                w.summary.path.clone(),
                                t.summary.title.clone(),
                                t.summary.updated_at,
                                t.summary.is_archived,
                                quiet(t),
                                v,
                            )
                        })
                    })
                })
                .collect::<Vec<_>>()
        };
        let mut variants = Vec::new();
        let mut projects = BTreeMap::new();
        let mut caches = 0;
        for (wid, tid, project, title, updated, archived, quiet, v) in targets {
            if !Path::new(&v.path).exists() {
                continue;
            }
            let f = self.cache_paths(&project, &v).await?;
            let clean = git(&v.path, &["status", "--porcelain", "--untracked-files=all"])
                .await
                .is_ok_and(|s| s.is_empty());
            let mut cache_bytes = 0;
            for (p, b) in &f.caches {
                let rel = p.strip_prefix(&v.path).unwrap().to_string_lossy();
                if git(&v.path, &["check-ignore", "-q", "--", &rel])
                    .await
                    .is_ok()
                    && git(&v.path, &["ls-files", "--", &rel])
                        .await
                        .is_ok_and(|s| s.is_empty())
                {
                    cache_bytes += b;
                }
            }
            let blocked = if !quiet {
                Some("Running or queued task".into())
            } else if !clean {
                Some("Uncommitted or untracked changes".into())
            } else if now.saturating_sub(f.newest) <= DAY
                || now.saturating_sub(updated.timestamp()) <= DAY
            {
                Some("Modified within 24 hours".into())
            } else {
                self.storage_identity(&project, &v)
                    .await
                    .err()
                    .map(|e| e.to_string())
            };
            *projects.entry(project.clone()).or_insert(0) += f.bytes;
            caches += cache_bytes;
            variants.push(StorageVariant {
                workspace_id: wid,
                thread_id: tid,
                title,
                project,
                path: v.path,
                bytes: f.bytes,
                cache_bytes,
                idle_days: (now - updated.timestamp()) / DAY,
                archived,
                status: if !quiet {
                    "running"
                } else if clean {
                    "clean"
                } else {
                    "dirty"
                }
                .into(),
                blocked,
            });
        }
        variants.sort_by_key(|v| std::cmp::Reverse(v.bytes));
        categories.insert("variant_caches".into(), caches);
        categories.insert(
            "variant_checkout_contents".into(),
            categories
                .get("variants")
                .copied()
                .unwrap_or(0)
                .saturating_sub(caches),
        );
        Ok(StorageReport {
            generated_at: now,
            free_bytes: crate::variant::available_disk(&root).await,
            categories,
            projects,
            variants,
            candidates,
            preferences: self.storage_preferences().await?,
            runs: self.storage_json("storage-runs.json").await?,
        })
    }
    pub async fn storage_variant_action(
        &self,
        r: StorageActionRequest,
    ) -> Result<StorageRun, DaemonError> {
        if !r.confirmed {
            return Err(DaemonError::BadRequest(
                "Confirm this destructive storage action".into(),
            ));
        }
        let _guard = self.inner.storage_gate.lock().await;
        let mut run = StorageRun {
            id: Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp(),
            ..StorageRun::default()
        };
        self.save_storage_run(&run).await?;
        let result = self
            .storage_action(&r.workspace_id, &r.thread_id, r.action, false)
            .await;
        run.entries.push(format!(
            "{} / {}: {}",
            r.workspace_id,
            r.thread_id,
            result.unwrap_or_else(|e| e.to_string())
        ));
        run.finished_at = Some(Utc::now().timestamp());
        self.save_storage_run(&run).await?;
        Ok(run)
    }
    async fn storage_action(
        &self,
        wid: &str,
        tid: &str,
        action: StorageAction,
        enforce_age: bool,
    ) -> Result<String, DaemonError> {
        let (project, v, activity) = {
            let ws = self.inner.workspaces.lock().await;
            let w = ws
                .get(wid)
                .ok_or_else(|| DaemonError::Rpc("Unknown workspace".into()))?;
            let t = w
                .threads
                .get(tid)
                .ok_or_else(|| DaemonError::Rpc("Unknown task".into()))?;
            if !quiet(t) {
                return Err(DaemonError::Rpc(
                    "Running or queued task is protected".into(),
                ));
            }
            (
                w.summary.path.clone(),
                t.summary
                    .variant
                    .clone()
                    .ok_or_else(|| DaemonError::Rpc("No variant".into()))?,
                t.summary.updated_at,
            )
        };
        self.storage_identity(&project, &v).await?;
        // Network checks stay outside the admission gate; final reclamation
        // repeats the existing local/process/branch/recipe safety checks.
        let assessment = if action == StorageAction::Reclaim {
            Some(
                crate::variant::assess(&project, &v)
                    .await
                    .map_err(|r| DaemonError::Rpc(format!("{r:?}")))?,
            )
        } else {
            None
        };
        let gate = self.variant_gate(wid, tid).await;
        let _guard = gate.lock().await;
        let now = Utc::now().timestamp();
        let f = self.cache_paths(&project, &v).await?;
        self.storage_identity(&project, &v).await?;
        {
            let ws = self.inner.workspaces.lock().await;
            let t = ws
                .get(wid)
                .and_then(|w| w.threads.get(tid))
                .ok_or_else(|| DaemonError::Rpc("Task disappeared".into()))?;
            if !quiet(t)
                || t.summary.updated_at != activity
                || t.summary.variant.as_ref() != Some(&v)
                || now.saturating_sub(f.newest) <= DAY
                || now.saturating_sub(activity.timestamp()) <= DAY
                || (enforce_age
                    && !due(
                        now - activity.timestamp(),
                        t.summary.is_archived,
                        f.newest,
                        now,
                        action,
                    ))
            {
                return Err(DaemonError::Rpc(
                    "Active, recent or ineligible variant retained".into(),
                ));
            }
        }
        if !crate::variant::hidden_or_in_progress(&v.path)
            .await
            .map_err(DaemonError::Rpc)?
            .is_empty()
        {
            return Err(DaemonError::Rpc(
                "Hidden index flags or Git operation retained".into(),
            ));
        }
        if !git(&v.path, &["status", "--porcelain", "--untracked-files=all"])
            .await?
            .is_empty()
        {
            return Err(DaemonError::Rpc("Dirty variant retained".into()));
        }
        crate::variant::process_clear(Path::new(&v.path))
            .await
            .map_err(DaemonError::Rpc)?;
        if let Some(ticket) = assessment {
            return Ok(format!(
                "{:?}",
                crate::variant::finish_reclaim(&project, &v, ticket).await
            ));
        }
        let mut cleared = 0;
        for (p, _) in f.caches {
            let rel = p
                .strip_prefix(&v.path)
                .map_err(|e| DaemonError::Rpc(e.to_string()))?
                .to_string_lossy();
            if !relative_path(&rel)
                || p.ancestors()
                    .take_while(|a| *a != Path::new(&v.path))
                    .any(|a| std::fs::symlink_metadata(a).is_ok_and(|m| m.file_type().is_symlink()))
            {
                continue;
            }
            if git(&v.path, &["check-ignore", "-q", "--", &rel])
                .await
                .is_err()
                || !git(&v.path, &["ls-files", "--", &rel]).await?.is_empty()
            {
                continue;
            }
            // Recheck contents immediately before each removal, including ignored files.
            if now.saturating_sub(facts(p.clone(), Vec::new()).await?.newest) <= DAY {
                continue;
            }
            if !git(&v.path, &["status", "--porcelain", "--untracked-files=all"])
                .await?
                .is_empty()
                || !crate::variant::hidden_or_in_progress(&v.path)
                    .await
                    .map_err(DaemonError::Rpc)?
                    .is_empty()
            {
                return Err(DaemonError::Rpc(
                    "Variant changed during cache cleanup; retained remaining caches".into(),
                ));
            }
            crate::variant::process_clear(Path::new(&v.path))
                .await
                .map_err(DaemonError::Rpc)?;
            remove_background(p).await?;
            cleared += 1;
        }
        Ok(format!("Cleared {cleared} cache directories"))
    }
    async fn save_storage_run(&self, run: &StorageRun) -> Result<(), DaemonError> {
        let mut runs: Vec<StorageRun> = self.storage_json("storage-runs.json").await?;
        if runs
            .last()
            .is_some_and(|r| !run.id.is_empty() && r.id == run.id)
        {
            runs.pop();
        }
        let mut bounded = run.clone();
        bounded.entries.truncate(100);
        for entry in &mut bounded.entries {
            if entry.len() > 512 {
                let end = entry
                    .char_indices()
                    .map(|(i, _)| i)
                    .take_while(|i| *i <= 500)
                    .last()
                    .unwrap_or(0);
                entry.truncate(end);
                entry.push_str("…");
            }
        }
        runs.push(bounded);
        if runs.len() > 30 {
            runs.drain(..runs.len() - 30);
        }
        self.write_storage_json("storage-runs.json", &runs).await
    }
    pub async fn storage_cleanup(&self, confirmed: bool) -> Result<StorageRun, DaemonError> {
        if !confirmed {
            return Err(DaemonError::BadRequest(
                "Confirm cleanup before deleting files".into(),
            ));
        }
        let _guard = self.inner.storage_gate.lock().await;
        self.storage_cleanup_locked().await
    }
    async fn storage_cleanup_locked(&self) -> Result<StorageRun, DaemonError> {
        let p = self.storage_preferences().await?;
        let mut run = StorageRun {
            id: Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp(),
            ..StorageRun::default()
        };
        self.save_storage_run(&run).await?;
        let report = match self.storage_inventory().await {
            Ok(r) => r,
            Err(e) => {
                run.entries.push(e.to_string());
                run.finished_at = Some(Utc::now().timestamp());
                self.save_storage_run(&run).await?;
                return Err(e);
            }
        };
        for v in report.variants {
            if self.is_shutting_down() {
                break;
            }
            if v.blocked.is_some() {
                continue;
            }
            let action = if p.reclaim_checkouts && (v.archived || v.idle_days >= 14) {
                Some(StorageAction::Reclaim)
            } else if p.clear_caches && v.idle_days >= 3 {
                Some(StorageAction::ClearCaches)
            } else {
                None
            };
            if let Some(action) = action {
                let result = self
                    .storage_action(&v.workspace_id, &v.thread_id, action, true)
                    .await;
                if run.entries.len() < 200 {
                    run.entries.push(format!(
                        "{}: {}",
                        v.path,
                        result.unwrap_or_else(|e| e.to_string())
                    ));
                }
                self.save_storage_run(&run).await?;
                tokio::task::yield_now().await;
            }
        }
        for c in report.candidates {
            if c.blocked.is_some()
                || !match c.category.as_str() {
                    "artifacts" => p.delete_old_artifacts,
                    "experiments" => p.delete_old_experiments,
                    _ => false,
                }
            {
                continue;
            }
            let path = PathBuf::from(&c.path);
            let parent = self.storage_root().join(&c.category);
            let safe = path.parent() == Some(parent.as_path())
                && (path.is_dir() || path.is_file())
                && !std::fs::symlink_metadata(&path)
                    .map_err(|e| DaemonError::Rpc(e.to_string()))?
                    .file_type()
                    .is_symlink();
            if !safe
                || std::fs::symlink_metadata(&parent)?.file_type().is_symlink()
                || std::fs::canonicalize(&parent)?
                    != std::fs::canonicalize(self.storage_root())?.join(&c.category)
            {
                continue;
            }
            let f = facts(path.clone(), Vec::new()).await?;
            let ws = self.inner.workspaces.lock().await;
            let protected = ws.values().any(|w| {
                Path::new(&w.summary.path).starts_with(&path)
                    || (Path::new(&w.summary.path).join(".git").exists()
                        && path.starts_with(&w.summary.path))
                    || w.threads.values().any(|t| {
                        t.summary.variant.as_ref().is_some_and(|v| {
                            Path::new(&v.path).starts_with(&path) || path.starts_with(&v.path)
                        })
                    })
            });
            drop(ws);
            if protected {
                continue;
            }
            if f.contains_git
                || Utc::now().timestamp().saturating_sub(f.newest) <= 30 * DAY
                || crate::variant::process_clear(&path).await.is_err()
            {
                continue;
            }
            // Process inventory may take time; repeat age immediately before removal.
            if Utc::now()
                .timestamp()
                .saturating_sub(facts(path.clone(), Vec::new()).await?.newest)
                <= 30 * DAY
            {
                continue;
            }
            let result = remove_background(path.clone()).await;
            if run.entries.len() < 200 {
                run.entries.push(format!("{}: {result:?}", path.display()));
            }
            self.save_storage_run(&run).await?;
        }
        run.finished_at = Some(Utc::now().timestamp());
        self.save_storage_run(&run).await?;
        Ok(run)
    }
    pub(super) async fn storage_archive_allowed(&self, project: &str, v: &ThreadVariant) -> bool {
        if !self
            .storage_preferences()
            .await
            .is_ok_and(|p| p.reclaim_checkouts)
            || self.storage_identity(project, v).await.is_err()
        {
            return false;
        }
        self.cache_paths(project, v)
            .await
            .is_ok_and(|f| Utc::now().timestamp().saturating_sub(f.newest) > DAY)
    }
    pub(super) async fn storage_daily_tick(&self) {
        let Ok(_guard) = self.inner.storage_gate.try_lock() else {
            return;
        };
        let Ok(p) = self.storage_preferences().await else {
            return;
        };
        if !p.scheduled {
            return;
        }
        let Ok(runs) = self
            .storage_json::<Vec<StorageRun>>("storage-runs.json")
            .await
        else {
            return;
        };
        if runs
            .last()
            .is_some_and(|r| Utc::now().timestamp().saturating_sub(r.started_at) < DAY)
        {
            return;
        }
        if let Err(e) = self.storage_cleanup_locked().await {
            tracing::warn!(%e,"daily storage cleanup failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_age_and_disk_threshold_boundaries() {
        let now = 100 * DAY;
        assert!(!due(
            3 * DAY,
            false,
            now - 2 * DAY,
            now,
            StorageAction::ClearCaches
        ));
        assert!(due(
            3 * DAY + 1,
            false,
            now - 2 * DAY,
            now,
            StorageAction::ClearCaches
        ));
        assert!(!due(
            14 * DAY,
            false,
            now - 2 * DAY,
            now,
            StorageAction::Reclaim
        ));
        assert!(due(
            14 * DAY + 1,
            false,
            now - 2 * DAY,
            now,
            StorageAction::Reclaim
        ));
        assert!(due(
            2 * DAY,
            true,
            now - 2 * DAY,
            now,
            StorageAction::Reclaim
        ));
        for action in [StorageAction::ClearCaches, StorageAction::Reclaim] {
            assert!(!due(40 * DAY, true, now - DAY, now, action));
            assert!(!due(40 * DAY, true, now + 1, now, action));
        }
        assert_eq!(disk_level(30 * GIB), "normal");
        assert_eq!(disk_level(30 * GIB - 1), "low");
        assert_eq!(disk_level(15 * GIB), "low");
        assert_eq!(disk_level(15 * GIB - 1), "critical");
    }
    #[test]
    fn custom_cache_paths_cannot_escape_or_target_git() {
        for s in [
            "",
            ".",
            "../target",
            "/target",
            "a/../b",
            ".git",
            "a/.git/index",
        ] {
            assert!(!relative_path(s), "{s}");
        }
        assert!(relative_path("frontend/.cache"));
    }
    #[tokio::test]
    async fn malformed_preferences_fail_closed_and_log_is_bounded() {
        let root = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            root.path().join("state.json"),
        );
        tokio::fs::write(root.path().join("storage-preferences.json"), b"invalid")
            .await
            .unwrap();
        assert!(app.storage_cleanup(true).await.is_err());
        for i in 0..40 {
            app.save_storage_run(&StorageRun {
                id: i.to_string(),
                started_at: i,
                ..StorageRun::default()
            })
            .await
            .unwrap();
        }
        assert_eq!(
            app.storage_json::<Vec<StorageRun>>("storage-runs.json")
                .await
                .unwrap()
                .len(),
            30
        );
        assert!(app.storage_cleanup(false).await.is_err());
    }
}
