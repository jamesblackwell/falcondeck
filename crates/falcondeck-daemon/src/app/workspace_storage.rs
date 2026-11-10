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
            .all(|c| matches!(c, Component::Normal(n) if !n.to_string_lossy().eq_ignore_ascii_case(".git")))
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
            contains_git: p
                .file_name()
                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(".git")),
            ..Facts::default()
        };
        if seen.insert((m.dev(), m.ino())) {
            f.bytes = m.blocks().saturating_mul(512);
        }
        if m.is_dir() && !m.file_type().is_symlink() {
            let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy();
            let cache=!in_cache&&crate::variant::cache::known_location(&rel)&&(custom.is_empty()||custom.iter().any(|s|s==&rel));
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
                f.caches.push((p.to_path_buf(),f.bytes));
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
    !matches!(
        t.summary.status,
        ThreadStatus::Running | ThreadStatus::WaitingForInput
    ) && !t
        .summary
        .variant
        .as_ref()
        .is_some_and(|v| crate::variant::dependencies_pending(&v.path))
        && t.summary.queued_turns.is_empty()
        && t.queued_requests.is_empty()
        && t.dispatching_request.is_none()
}
fn vendor_deletions_only(status: &str) -> bool {
    let entries = status
        .split('\0')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    !entries.is_empty()
        && entries.iter().all(|s| {
            s.starts_with(" D public/vendor/") || s.starts_with(" D resources/views/vendor/")
        })
}
fn due(idle_age: i64, archived: bool, newest: i64, now: i64, action: StorageAction) -> bool {
    now.saturating_sub(newest) > DAY
        && match action {
            StorageAction::ClearCaches => idle_age > 3 * DAY,
            StorageAction::Reclaim => archived || idle_age > DAY,
            StorageAction::SnapshotReclaim => idle_age > 7 * DAY,
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
    fn storage_test_boundary(&self) -> Result<(), DaemonError> {
        // Tests deliberately retain the real HOME. A fixture which forgets its
        // state_path must never turn that into permission to sweep live data.
        if std::env::var("FALCONDECK_TEST_NO_PROVIDERS").as_deref() == Ok("1") {
            let root = std::fs::canonicalize(self.storage_root())?;
            let temp = std::fs::canonicalize(std::env::temp_dir())?;
            if !root.starts_with(&temp) || root == temp {
                return Err(DaemonError::Conflict(
                    "Test cleanup requires an isolated data root inside TMPDIR".into(),
                ));
            }
        }
        Ok(())
    }
    pub(super) fn storage_root(&self) -> PathBuf {
        self.inner
            .state_path
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf()
    }
    /// Cheap stat-only health inventory; never walks checkout contents.
    pub(super) async fn storage_volumes(&self) -> Vec<StorageVolume> {
        let root = self.storage_root();
        let mut paths = vec![root.clone()];
        let projects = {
            let ws = self.inner.workspaces.lock().await;
            paths.extend(ws.values().flat_map(|w| {
                w.threads
                    .values()
                    .filter_map(|t| t.summary.variant.as_ref().map(|v| PathBuf::from(&v.path)))
            }));
            ws.values()
                .map(|w| PathBuf::from(&w.summary.path))
                .collect::<Vec<_>>()
        };
        for project in projects {
            paths.push(project.clone());
            match crate::variant::git_storage_paths(&project).await {
                Ok(git) => paths.extend(git),
                Err(_) => paths.push(project.join(".git")),
            }
        }
        // Retained siblings remain managed after their last workspace is deleted.
        // Registry reads are bounded metadata; health never spawns Git or hashes files.
        match crate::variant::quarantine::retained_volume_paths(&root.join("variants")).await {
            Ok(retained) => paths.extend(retained),
            Err(error) => tracing::warn!(%error, "retained storage volumes could not be read"),
        }
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for mut path in paths {
            // Reclaimed paths may be absent; their existing managed parent still
            // identifies the correct volume. Never guess across an absent SSD root.
            if !path.exists() && path.starts_with(&root) && path != root {
                // An existing immediate parent identifies a reclaimed checkout's
                // volume. A missing mount/project parent stays explicitly unknown.
                if let Some(parent) = path.parent().filter(|p| p.exists()) {
                    path = parent.to_owned();
                }
            }
            use std::os::unix::fs::MetadataExt;
            let device = tokio::fs::metadata(&path).await.ok().map(|m| m.dev());
            let id = device
                .map(|d| format!("device-{d:x}"))
                .unwrap_or_else(|| format!("unavailable:{}", path.display()));
            if !seen.insert(id.clone()) {
                continue;
            }
            result.push(StorageVolume {
                id,
                path: path.to_string_lossy().into_owned(),
                free_bytes: if device.is_some() {
                    crate::variant::available_disk(&path).await
                } else {
                    None
                },
            });
        }
        result
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
        let actual_common = git(
            &v.path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
        let project_common = git(
            project,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
        if tokio::fs::canonicalize(actual_common.trim()).await?
            != tokio::fs::canonicalize(project_common.trim()).await?
        {
            return Err(DaemonError::Rpc(
                "Variant belongs to a different project; retained for review".into(),
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
    async fn non_ignored_activity(&self, path: &str) -> Result<i64, DaemonError> {
        let files = git(
            path,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
        )
        .await?;
        let flags = git(path, &["ls-files", "-v", "-z"]).await?;
        let omitted: HashSet<&str> = flags
            .split('\0')
            .filter_map(|entry| {
                entry
                    .strip_prefix("S ")
                    .or_else(|| entry.strip_prefix("s "))
            })
            .collect();
        let mut newest = 0;
        for name in files.split('\0').filter(|p| !p.is_empty()) {
            let file = Path::new(path).join(name);
            let metadata = match tokio::fs::symlink_metadata(&file).await {
                Ok(m) => m,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) && omitted.contains(name) =>
                {
                    // Sparse omissions are not working-tree deletions or activity.
                    continue;
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
                {
                    // A real deletion has no inode. Its nearest surviving
                    // ancestor records removal of a whole source directory.
                    let mut parent = file.parent();
                    loop {
                        let directory =
                            parent.filter(|p| p.starts_with(path)).ok_or_else(|| {
                                DaemonError::Rpc(
                                    "Checkout disappeared during activity check".into(),
                                )
                            })?;
                        match tokio::fs::symlink_metadata(directory).await {
                            Ok(m) => break m,
                            Err(e)
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::NotFound
                                        | std::io::ErrorKind::NotADirectory
                                ) =>
                            {
                                parent = directory.parent()
                            }
                            Err(e) => return Err(e.into()),
                        }
                    }
                }
                Err(e) => return Err(e.into()),
            };
            newest = newest.max(seconds(metadata.modified()?));
        }
        Ok(newest)
    }
    async fn cache_paths(&self, project: &str, v: &ThreadVariant) -> Result<Facts, DaemonError> {
        let mut f = facts(PathBuf::from(&v.path), Self::cache_hook(project).await?).await?;
        let git_dir = PathBuf::from(
            git(&v.path, &["rev-parse", "--absolute-git-dir"])
                .await?
                .trim(),
        );
        for relative in ["HEAD", "index", "logs/HEAD"] {
            match tokio::fs::symlink_metadata(git_dir.join(relative)).await {
                Ok(m) => f.newest = f.newest.max(seconds(m.modified()?)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(f)
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
                if matches!(cat, "artifacts" | "experiments")
                    && std::fs::symlink_metadata(e.path())?.is_dir()
                {
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
            let cache_blocked = if !quiet {
                Some("Running or queued task".into())
            } else if now.saturating_sub(updated.timestamp()) <= 3 * DAY {
                Some("Task has not been idle for more than 3 days".into())
            } else if now.saturating_sub(self.non_ignored_activity(&v.path).await?) <= DAY {
                Some("Non-ignored files modified within 24 hours".into())
            } else {
                self.storage_identity(&project, &v)
                    .await
                    .err()
                    .map(|e| e.to_string())
            };
            let snapshot_blocked = if clean {
                Some("Only dirty variants need a snapshot".into())
            } else if !quiet || now.saturating_sub(updated.timestamp()) <= 7 * DAY {
                Some("Snapshot requires more than 7 idle days and no queued work".into())
            } else if now.saturating_sub(f.newest) <= DAY {
                Some("Checkout modified within 24 hours".into())
            } else {
                match self.storage_identity(&project, &v).await {
                    Err(e) => Some(e.to_string()),
                    Ok(()) => {
                        let blockers =
                            crate::variant::snapshot::blockers(&project, &v.path).await?;
                        (!blockers.is_empty()).then(|| blockers.join("; "))
                    }
                }
            };
            *projects.entry(project.clone()).or_insert(0) += f.bytes;
            caches += cache_bytes;
            let vendor_deletions_only = vendor_deletions_only(
                &git(
                    &v.path,
                    &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                )
                .await
                .unwrap_or_default(),
            );
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
                cache_blocked,
                snapshot_blocked,
                vendor_deletions_only,
            });
        }
        let mut quarantines = Vec::new();
        let mut project_paths = {
            let ws = self.inner.workspaces.lock().await;
            ws.values()
                .map(|w| w.summary.path.clone())
                .collect::<HashSet<_>>()
        };
        project_paths
            .extend(crate::variant::quarantine::registered_projects(&root.join("variants")).await?);
        for project in project_paths {
            let Ok(records) = crate::variant::quarantine::records(&project).await else {
                continue;
            };
            for r in records {
                let mut paths = vec![(
                    r.residue
                        .as_ref()
                        .filter(|p| p.exists())
                        .unwrap_or(&r.path)
                        .clone(),
                    r.phase.clone(),
                )];
                if let Some(vault) = r.private_path.as_ref().filter(|p| p.exists()) {
                    paths.push((vault.clone(), "private_preserved".into()));
                }
                for (path, phase) in paths {
                    if !path.exists() {
                        continue;
                    }
                    let f = facts(path.clone(), Vec::new()).await?;
                    *projects.entry(project.clone()).or_insert(0) += f.bytes;
                    quarantines.push(StorageQuarantine {
                        project: project.clone(),
                        original: r.original.to_string_lossy().into_owned(),
                        path: path.to_string_lossy().into_owned(),
                        bytes: f.bytes,
                        release_after: r.created_at + crate::variant::quarantine::GRACE_SECONDS,
                        phase,
                    });
                }
            }
        }
        categories.insert(
            "quarantined".into(),
            quarantines.iter().map(|q| q.bytes).sum(),
        );
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
            volumes: self.storage_volumes().await,
            categories,
            projects,
            variants,
            candidates,
            quarantines,
            preferences: self.storage_preferences().await?,
            runs: self.storage_json("storage-runs.json").await?,
        })
    }
    pub async fn storage_snapshot_batch(
        &self,
        r: StorageSnapshotRequest,
    ) -> Result<StorageRun, DaemonError> {
        if !r.confirmed || r.targets.is_empty() || r.targets.len() > 100 {
            return Err(DaemonError::BadRequest(
                "Confirm one to one hundred explicitly selected dirty variants".into(),
            ));
        }
        let app = self.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        if !self.spawn_background_task(async move {
            let result = async {
                app.storage_test_boundary()?;
                let _guard = app.inner.storage_gate.lock().await;
                let mut run = StorageRun {
                    id: Uuid::new_v4().to_string(),
                    started_at: Utc::now().timestamp(),
                    ..Default::default()
                };
                app.save_storage_run(&run).await?;
                let mut seen = HashSet::new();
                for target in r.targets {
                    if app.is_shutting_down() {
                        break;
                    }
                    if !seen.insert((target.workspace_id.clone(), target.thread_id.clone())) {
                        continue;
                    }
                    let result = app
                        .storage_action(
                            &target.workspace_id,
                            &target.thread_id,
                            StorageAction::SnapshotReclaim,
                            false,
                        )
                        .await;
                    run.entries.push(format!(
                        "Snapshot {}/{}: {}",
                        target.workspace_id,
                        target.thread_id,
                        result.unwrap_or_else(|e| e.to_string())
                    ));
                    app.save_storage_run(&run).await?;
                }
                run.finished_at = Some(Utc::now().timestamp());
                app.save_storage_run(&run).await?;
                Ok::<_, DaemonError>(run)
            }
            .await;
            let _ = tx.send(result);
        }) {
            return Err(DaemonError::Conflict("Daemon is shutting down".into()));
        }
        rx.await.map_err(|e| DaemonError::Rpc(e.to_string()))?
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
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app = self.clone();
        if !self.spawn_background_task(async move {
            let _ = tx.send(app.storage_variant_action_owned(r).await);
        }) {
            return Err(DaemonError::Conflict("Daemon is shutting down".into()));
        }
        rx.await.map_err(|e| DaemonError::Rpc(e.to_string()))?
    }
    async fn storage_variant_action_owned(
        &self,
        r: StorageActionRequest,
    ) -> Result<StorageRun, DaemonError> {
        self.storage_test_boundary()?;
        // The daemon owns the operation and gates even if the HTTP client
        // disconnects while a blocking filesystem removal is still running.
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
        let assessment = if matches!(
            action,
            StorageAction::Reclaim | StorageAction::SnapshotReclaim
        ) {
            Some(
                if action == StorageAction::SnapshotReclaim {
                    crate::variant::assess_for_snapshot(&project, &v).await
                } else {
                    crate::variant::assess(&project, &v).await
                }
                .map_err(|r| DaemonError::Rpc(format!("{r:?}")))?,
            )
        } else {
            None
        };
        let gate = self.variant_gate(wid, tid).await;
        let _guard = gate.lock().await;
        let now = Utc::now().timestamp();
        let f = self.cache_paths(&project, &v).await?;
        let newest = if action == StorageAction::ClearCaches {
            self.non_ignored_activity(&v.path).await?
        } else {
            f.newest
        };
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
                || now.saturating_sub(newest) <= DAY
                || now.saturating_sub(activity.timestamp()) <= DAY
                || (action == StorageAction::ClearCaches
                    && now.saturating_sub(activity.timestamp()) <= 3 * DAY)
                || (action == StorageAction::SnapshotReclaim
                    && now.saturating_sub(activity.timestamp()) <= 7 * DAY)
                || (enforce_age
                    && !due(
                        now - activity.timestamp(),
                        t.summary.is_archived,
                        newest,
                        now,
                        action,
                    ))
            {
                return Err(DaemonError::Rpc(
                    "Active, recent or ineligible variant retained".into(),
                ));
            }
        }
        if action != StorageAction::ClearCaches
            && !crate::variant::hidden_or_in_progress(&v.path)
                .await
                .map_err(DaemonError::Rpc)?
                .is_empty()
        {
            return Err(DaemonError::Rpc(
                "Hidden index flags or Git operation retained".into(),
            ));
        }
        if action == StorageAction::Reclaim
            && !git(&v.path, &["status", "--porcelain", "--untracked-files=all"])
                .await?
                .is_empty()
        {
            return Err(DaemonError::Rpc("Dirty variant retained".into()));
        }
        crate::variant::process_clear(Path::new(&v.path))
            .await
            .map_err(DaemonError::Rpc)?;
        if action == StorageAction::SnapshotReclaim {
            if git(&v.path, &["status", "--porcelain", "--untracked-files=all"])
                .await?
                .is_empty()
            {
                return Err(DaemonError::BadRequest(
                    "Only dirty variants need a snapshot".into(),
                ));
            }
            let snapshot = crate::variant::snapshot::create(&v.path, &v.slug).await?;
            return Ok(format!(
                "{:?}",
                crate::variant::finish_snapshot_reclaim(
                    &project,
                    &v,
                    assessment.unwrap(),
                    snapshot
                )
                .await
            ));
        }
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
            if Utc::now()
                .timestamp()
                .saturating_sub(self.non_ignored_activity(&v.path).await?)
                <= DAY
            {
                return Err(DaemonError::Rpc(
                    "Non-ignored files changed during cleanup; remaining caches retained".into(),
                ));
            }
            crate::variant::process_clear(Path::new(&v.path))
                .await
                .map_err(DaemonError::Rpc)?;
            let proof = crate::variant::cache::partition(Path::new(&v.path), &rel, &p)
                .map_err(DaemonError::Rpc)?;
            if proof.rebuildable_bytes == 0 {
                continue;
            }
            crate::variant::quarantine::stage(&project, &v, &p, None).await?;
            cleared += 1;
        }
        Ok(format!(
            "Quarantined {cleared} cache directories; removal after the 24-hour recovery period"
        ))
    }
    async fn storage_purge_quarantines(
        &self,
        run: &mut StorageRun,
        preferences: &StoragePreferences,
    ) {
        let mut workspaces = {
            let ws = self.inner.workspaces.lock().await;
            ws.values()
                .map(|w| w.summary.path.clone())
                .collect::<HashSet<_>>()
        };
        match crate::variant::quarantine::registered_projects(&self.storage_root().join("variants"))
            .await
        {
            Ok(projects) => workspaces.extend(projects),
            Err(e) => run
                .entries
                .push(format!("Quarantine project inventory: {e}")),
        }
        for project in workspaces {
            if self.is_shutting_down() {
                break;
            }
            let records = match crate::variant::quarantine::records(&project).await {
                Ok(r) => r,
                Err(e) => {
                    run.entries.push(format!("Quarantine inventory: {e}"));
                    continue;
                }
            };
            for r in records {
                if (r.snapshot.is_some() && !preferences.reclaim_checkouts)
                    || (r.snapshot.is_none() && !preferences.clear_caches)
                {
                    continue;
                }
                // Roots, project identity, and managed admissions remain protected
                // even though the original checkout path is now intentionally absent.
                let root = self.storage_root().join("variants");
                if !Path::new(&r.variant.path).starts_with(&root) {
                    continue;
                }
                let owner = {
                    let ws = self.inner.workspaces.lock().await;
                    ws.iter().find_map(|(wid, w)| {
                        w.threads.iter().find_map(|(tid, t)| {
                            t.summary
                                .variant
                                .as_ref()
                                .filter(|v| v.path == r.variant.path)
                                .map(|_| (wid.clone(), tid.clone(), quiet(t)))
                        })
                    })
                };
                if owner.as_ref().is_some_and(|(_, _, quiet)| !*quiet) {
                    continue;
                }
                let gate = if let Some((wid, tid, _)) = owner {
                    Some(self.variant_gate(&wid, &tid).await)
                } else {
                    None
                };
                let _held = if let Some(g) = gate.as_ref() {
                    Some(g.lock().await)
                } else {
                    None
                };
                let quiet_now = {
                    let ws = self.inner.workspaces.lock().await;
                    let owners = ws
                        .values()
                        .flat_map(|w| w.threads.values())
                        .filter(|t| {
                            t.summary
                                .variant
                                .as_ref()
                                .is_some_and(|v| v.path == r.variant.path)
                        })
                        .collect::<Vec<_>>();
                    owners.len() <= 1
                        && owners.iter().all(|t| {
                            t.summary.variant.as_ref() == Some(&r.variant)
                                && quiet(t)
                                && Utc::now()
                                    .timestamp()
                                    .saturating_sub(t.summary.updated_at.timestamp())
                                    > if r.snapshot.is_some() { DAY } else { 3 * DAY }
                        })
                };
                if !quiet_now {
                    continue;
                }
                let result = crate::variant::quarantine::purge(&r, Utc::now().timestamp()).await;
                match result {
                    Ok(None) => {}
                    other => run
                        .entries
                        .push(format!("Quarantine {}: {other:?}", r.path.display())),
                }
            }
        }
    }
    pub(super) async fn save_storage_run(&self, run: &StorageRun) -> Result<(), DaemonError> {
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
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app = self.clone();
        if !self.spawn_background_task(async move {
            let _guard = app.inner.storage_gate.lock().await;
            let _ = tx.send(app.storage_cleanup_locked().await);
        }) {
            return Err(DaemonError::Conflict("Daemon is shutting down".into()));
        }
        rx.await.map_err(|e| DaemonError::Rpc(e.to_string()))?
    }
    async fn storage_cleanup_locked(&self) -> Result<StorageRun, DaemonError> {
        self.storage_test_boundary()?;
        let p = self.storage_preferences().await?;
        let mut run = StorageRun {
            id: Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp(),
            ..StorageRun::default()
        };
        self.save_storage_run(&run).await?;
        self.storage_purge_quarantines(&mut run, &p).await;
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
            let action = if v.status == "clean"
                && v.blocked.is_none()
                && p.reclaim_checkouts
                && (v.archived || v.idle_days >= 1)
            {
                Some(StorageAction::Reclaim)
            } else if p.clear_caches && v.cache_blocked.is_none() && v.idle_days >= 3 {
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
                // A remote/ignored-file blocker on checkout reclamation must
                // not prevent independently safe cache cleanup in that tree.
                if action == StorageAction::Reclaim
                    && p.clear_caches
                    && v.cache_blocked.is_none()
                    && Path::new(&v.path).exists()
                {
                    let caches = self
                        .storage_action(
                            &v.workspace_id,
                            &v.thread_id,
                            StorageAction::ClearCaches,
                            true,
                        )
                        .await;
                    run.entries.push(format!(
                        "{} caches: {}",
                        v.path,
                        caches.unwrap_or_else(|e| e.to_string())
                    ));
                }
                self.save_storage_run(&run).await?;
                tokio::task::yield_now().await;
            }
        }
        run.finished_at = Some(Utc::now().timestamp());
        self.save_storage_run(&run).await?;
        Ok(run)
    }
    pub(super) async fn storage_archive_allowed(&self, project: &str, v: &ThreadVariant) -> bool {
        if self.storage_test_boundary().is_err() {
            return false;
        }
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
        if self.storage_test_boundary().is_err() {
            return;
        }
        let Ok(_guard) = self.inner.storage_gate.try_lock() else {
            return;
        };
        let Ok(p) = self.storage_preferences().await else {
            return;
        };
        if !p.scheduled {
            return;
        }
        let Ok(last) = self
            .storage_json::<Option<i64>>("storage-last-scheduled.json")
            .await
        else {
            return;
        };
        let now = Utc::now().timestamp();
        if last.is_some_and(|started| now.saturating_sub(started) < DAY) {
            return;
        }
        // A separate marker cannot be evicted or postponed by manual/archive
        // activity in the bounded run log.
        if self
            .write_storage_json("storage-last-scheduled.json", &Some(now))
            .await
            .is_err()
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
        assert!(!due(DAY, false, now - 2 * DAY, now, StorageAction::Reclaim));
        assert!(due(
            DAY + 1,
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
    fn vendor_deletions_remain_dirty_and_have_a_precise_group() {
        assert!(vendor_deletions_only(
            " D public/vendor/a.js\0 D resources/views/vendor/x.blade.php\0"
        ));
        for status in [
            "",
            "D  public/vendor/a.js\0",
            " D public/vendor/a.js\0 M authored.rs\0",
            " D vendor/a.js\0",
        ] {
            assert!(!vendor_deletions_only(status), "{status}");
        }
    }
    #[tokio::test]
    async fn health_volumes_deduplicate_the_data_filesystem_and_keep_unknown_paths_explicit() {
        let root = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            root.path().join("state.json"),
        );
        let volumes = app.storage_volumes().await;
        assert_eq!(volumes.len(), 1);
        assert!(volumes[0].id.starts_with("device-"));
        assert!(volumes[0].free_bytes.is_some());
    }
    #[tokio::test]
    async fn health_keeps_registered_recovery_volume_without_any_workspace() {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            root.path().join("state.json"),
        );
        let group = root.path().join("variants/project");
        std::fs::create_dir_all(&group).unwrap();
        // The dev filesystem supplies a distinct, read-only capacity observation;
        // every metadata write remains inside this fixture.
        let project = "/dev";
        let name = format!(
            ".storage-quarantine-project-{:x}.json",
            Sha256::digest(project.as_bytes())
        );
        std::fs::write(group.join(name), serde_json::to_vec(project).unwrap()).unwrap();
        assert!(app.inner.workspaces.lock().await.is_empty());
        let volumes = app.storage_volumes().await;
        let id = format!("device-{:x}", std::fs::metadata(project).unwrap().dev());
        assert!(volumes.iter().any(|v| v.id == id && v.free_bytes.is_some()));
        assert!(
            volumes
                .iter()
                .any(|v| v.path == "/dev/.git" && v.free_bytes.is_none())
        );
    }
    #[tokio::test]
    async fn health_reports_gitfile_and_cached_shared_git_volume_without_a_workspace() {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            root.path().join("state.json"),
        );
        let group = root.path().join("variants/project");
        std::fs::create_dir_all(&group).unwrap();
        let name = format!(
            ".storage-quarantine-project-{:x}.json",
            Sha256::digest(project.to_string_lossy().as_bytes())
        );
        let registry = group.join(name);
        std::fs::write(&registry, serde_json::to_vec(&project).unwrap()).unwrap();
        std::fs::write(project.join(".git"), "gitdir: /dev\n").unwrap();
        let id = format!("device-{:x}", std::fs::metadata("/dev").unwrap().dev());
        assert!(
            app.storage_volumes()
                .await
                .iter()
                .any(|v| v.id == id && v.free_bytes.is_some())
        );
        std::fs::remove_file(project.join(".git")).unwrap();
        std::fs::write(
            registry,
            serde_json::to_vec(&serde_json::json!({"project":project,"git_paths":["/dev"]}))
                .unwrap(),
        )
        .unwrap();
        assert!(
            app.storage_volumes()
                .await
                .iter()
                .any(|v| v.id == id && v.free_bytes.is_some())
        );
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
            "a/.GIT/index",
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
    #[tokio::test]
    async fn daily_schedule_is_durable_independent_of_manual_runs_and_can_be_disabled() {
        let root = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            root.path().join("state.json"),
        );
        app.storage_daily_tick().await;
        assert_eq!(
            app.storage_json::<Vec<StorageRun>>("storage-runs.json")
                .await
                .unwrap()
                .len(),
            1
        );
        app.storage_cleanup(true).await.unwrap();
        app.storage_daily_tick().await;
        assert_eq!(
            app.storage_json::<Vec<StorageRun>>("storage-runs.json")
                .await
                .unwrap()
                .len(),
            2
        );
        app.update_storage_preferences(StoragePreferences {
            scheduled: false,
            ..Default::default()
        })
        .await
        .unwrap();
        app.write_storage_json("storage-last-scheduled.json", &Some(0_i64))
            .await
            .unwrap();
        app.storage_daily_tick().await;
        assert_eq!(
            app.storage_json::<Vec<StorageRun>>("storage-runs.json")
                .await
                .unwrap()
                .len(),
            2
        );
        app.shutdown().await.unwrap();
    }
}
