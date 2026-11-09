//! Recoverable filesystem removal. Rename first; retain for a full day; verify
//! bytes, index, processes and ownership again before touching quarantined files.
use super::{
    Reclaim,
    snapshot::{self, Snapshot},
};
use crate::error::DaemonError;
use falcondeck_core::ThreadVariant;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};
use tokio::fs;

async fn run_git(path: &str, args: &[&str]) -> Result<String, DaemonError> {
    super::reclaim::git(path, args, &[], std::time::Duration::from_secs(600))
        .await
        .map_err(DaemonError::Rpc)
}
async fn filesystem_job<T: Send + 'static>(
    job: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T, DaemonError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        unsafe {
            unsafe extern "C" {
                fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32;
            }
            pthread_set_qos_class_self_np(0x09, 0);
        }
        let _ = tx.send(job());
    });
    rx.await
        .map_err(|e| DaemonError::Rpc(e.to_string()))?
        .map_err(DaemonError::Io)
}

pub(crate) const GRACE_SECONDS: i64 = 86400;
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Record {
    pub project: String,
    pub variant: ThreadVariant,
    pub original: PathBuf,
    pub path: PathBuf,
    pub created_at: i64,
    pub fingerprint: String,
    pub device: u64,
    pub inode: u64,
    pub snapshot: Option<Snapshot>,
    pub phase: String,
    pub metadata: PathBuf,
    #[serde(default)]
    pub residue: Option<PathBuf>,
}
async fn directory(project: &str) -> Result<PathBuf, DaemonError> {
    Ok(PathBuf::from(
        run_git(
            project,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?
        .trim(),
    )
    .join("falcondeck-variants"))
}
// Discovery stays beside the managed checkouts, independent of workspace lifetime.
fn registry_name(project: &str) -> String {
    format!(
        ".storage-quarantine-project-{:x}.json",
        Sha256::digest(project.as_bytes())
    )
}
// Commit transaction metadata before the filesystem operation it authorizes.
pub(crate) async fn durable_write(path: &Path, bytes: Vec<u8>) -> Result<(), DaemonError> {
    let owned = path.to_owned();
    filesystem_job(move || {
        use std::io::Write;
        let parent = owned
            .parent()
            .ok_or_else(|| std::io::Error::other("Missing metadata parent"))?;
        std::fs::create_dir_all(parent)?;
        let temp = owned.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&temp, &owned)?;
            std::fs::File::open(parent)?.sync_all()?;
            if let Some(grandparent) = parent.parent() {
                std::fs::File::open(grandparent)?.sync_all()?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    })
    .await
}
#[cfg(test)]
fn sync_faults() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, usize>> {
    static FAULTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, usize>>,
    > = std::sync::OnceLock::new();
    FAULTS.get_or_init(Default::default)
}
async fn sync_move(source: &Path, destination: &Path) -> Result<(), DaemonError> {
    #[cfg(test)]
    {
        let mut faults = sync_faults().lock().unwrap();
        if let Some((_, remaining)) = faults
            .iter_mut()
            .find(|(p, count)| **count > 0 && (p.as_path() == source || p.as_path() == destination))
        {
            *remaining -= 1;
            return Err(std::io::Error::other("fixture: directory sync failed").into());
        }
    }
    let mut parents = vec![
        source.parent().unwrap().to_owned(),
        destination.parent().unwrap().to_owned(),
    ];
    parents.sort();
    parents.dedup();
    filesystem_job(move || {
        for parent in parents {
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })
    .await
}
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum ProjectRegistry {
    Legacy(String),
    Current {
        project: String,
        #[serde(default)]
        git_paths: Vec<PathBuf>,
    },
}
async fn register_project(project: &str, parent: &Path) -> Result<(), DaemonError> {
    let mut git_paths = super::git_storage_paths(Path::new(project))
        .await
        .unwrap_or_default();
    git_paths.push(directory(project).await?.parent().unwrap().to_owned());
    git_paths.sort();
    git_paths.dedup();
    let registry = ProjectRegistry::Current {
        project: project.into(),
        git_paths,
    };
    durable_write(
        &parent.join(registry_name(project)),
        serde_json::to_vec(&registry)?,
    )
    .await
}
async fn registered_locations(
    root: &Path,
) -> Result<Vec<(String, PathBuf, Vec<PathBuf>)>, DaemonError> {
    let mut result = Vec::new();
    let mut groups = match fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(e) => return Err(e.into()),
    };
    while let Some(group) = groups.next_entry().await? {
        if !group.file_type().await?.is_dir() {
            continue;
        }
        let mut entries = fs::read_dir(group.path()).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(".storage-quarantine-project-") || !name.ends_with(".json") {
                continue;
            }
            if !entry.file_type().await?.is_file() {
                return Err(DaemonError::Rpc(
                    "Invalid quarantine project registry".into(),
                ));
            }
            let registry: ProjectRegistry = serde_json::from_slice(&fs::read(entry.path()).await?)?;
            let (project, git_paths) = match registry {
                ProjectRegistry::Legacy(project) => (project, Vec::new()),
                ProjectRegistry::Current { project, git_paths } => (project, git_paths),
            };
            if registry_name(&project) != name {
                return Err(DaemonError::Rpc(
                    "Quarantine project registry identity mismatch".into(),
                ));
            }
            result.push((project, group.path(), git_paths));
        }
    }
    Ok(result)
}
pub(crate) async fn registered_projects(root: &Path) -> Result<Vec<String>, DaemonError> {
    Ok(registered_locations(root)
        .await?
        .into_iter()
        .map(|(project, _, _)| project)
        .collect())
}
/// Only bounded registry metadata and stat calls: no Git or checkout-content scan.
pub(crate) async fn retained_volume_paths(root: &Path) -> Result<Vec<PathBuf>, DaemonError> {
    let mut paths = Vec::new();
    for (project, parent, stored_git_paths) in registered_locations(root).await? {
        let project = PathBuf::from(project);
        paths.push(project.join(".git"));
        paths.extend(stored_git_paths);
        if let Ok(actual) = super::git_storage_paths(&project).await {
            paths.extend(actual);
        }
        paths.push(project);
        // Quarantine and residue are atomic siblings on this exact filesystem.
        paths.push(parent);
    }
    Ok(paths)
}
async fn save(r: &Record) -> Result<(), DaemonError> {
    durable_write(&r.metadata, serde_json::to_vec(r)?).await
}
pub(crate) async fn records(project: &str) -> Result<Vec<Record>, DaemonError> {
    let mut result = Vec::new();
    let directory = directory(project).await?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(e) => return Err(e.into()),
    };
    while let Some(e) = entries.next_entry().await? {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.contains(".quarantine.") || !name.ends_with(".json") {
            continue;
        }
        if !e.file_type().await?.is_file() {
            return Err(DaemonError::Rpc(
                "Quarantine metadata is not a regular file".into(),
            ));
        }
        let r: Record = serde_json::from_slice(&fs::read(e.path()).await?)?;
        if r.metadata != e.path() || directory != directory_for_record(&r) || r.project != project {
            return Err(DaemonError::Rpc(
                "Quarantine registry identity mismatch".into(),
            ));
        }
        validate(&r)?;
        result.push(r);
    }
    Ok(result)
}
fn directory_for_record(r: &Record) -> PathBuf {
    r.metadata.parent().unwrap_or(Path::new("")).to_owned()
}
fn validate(r: &Record) -> Result<(), DaemonError> {
    let checkout = Path::new(&r.variant.path);
    let parent = checkout
        .parent()
        .ok_or_else(|| DaemonError::Rpc("Invalid quarantine parent".into()))?;
    let prefix = format!(".storage-quarantine-{}-", r.variant.slug);
    let name = r.path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if r.path.parent() != Some(parent)
        || !name.starts_with(&prefix)
        || uuid::Uuid::parse_str(name.strip_prefix(&prefix).unwrap_or("")).is_err()
        || (r.snapshot.is_some() && r.original != checkout)
        || (r.snapshot.is_none()
            && !r
                .original
                .strip_prefix(checkout)
                .ok()
                .and_then(|p| p.to_str())
                .is_some_and(super::cache::known_location))
        || parent
            .ancestors()
            .any(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
    {
        return Err(DaemonError::Rpc(
            "Quarantine containment check failed; retained".into(),
        ));
    }
    Ok(())
}
fn fingerprint_sync(root: &Path) -> std::io::Result<String> {
    fn walk(root: &Path, p: &Path, h: &mut Sha256) -> std::io::Result<()> {
        use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
        let m = std::fs::symlink_metadata(p)?;
        h.update(p.strip_prefix(root).unwrap().as_os_str().as_bytes());
        h.update([0]);
        h.update(m.mode().to_le_bytes());
        if !m.is_dir() {
            h.update(m.len().to_le_bytes());
        }
        if m.file_type().is_symlink() {
            h.update(std::fs::read_link(p)?.as_os_str().as_bytes());
        } else if m.is_dir() {
            let mut entries = std::fs::read_dir(p)?.collect::<Result<Vec<_>, _>>()?;
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                walk(root, &e.path(), h)?;
            }
            let after = std::fs::symlink_metadata(p)?;
            if after.modified()? != m.modified()? || after.ino() != m.ino() {
                return Err(std::io::Error::other(
                    "Directory changed during quarantine hashing",
                ));
            }
        } else if m.is_file() {
            let mut f = std::fs::File::open(p)?;
            let mut bytes = [0; 65536];
            loop {
                let n = f.read(&mut bytes)?;
                if n == 0 {
                    break;
                }
                h.update(&bytes[..n]);
            }
            let after = f.metadata()?;
            if after.len() != m.len()
                || after.modified()? != m.modified()?
                || after.ino() != m.ino()
            {
                return Err(std::io::Error::other(
                    "File changed during quarantine hashing",
                ));
            }
        } else {
            return Err(std::io::Error::other("Special file retained"));
        }
        h.update([0xff]);
        Ok(())
    }
    let mut h = Sha256::new();
    walk(root, root, &mut h)?;
    Ok(format!("{:x}", h.finalize()))
}
pub(crate) async fn fingerprint(path: &Path) -> Result<String, DaemonError> {
    let owned = path.to_owned();
    filesystem_job(move || fingerprint_sync(&owned)).await
}
async fn unchanged(r: &Record) -> Result<(), DaemonError> {
    use std::os::unix::fs::MetadataExt;
    validate(r)?;
    let m = fs::symlink_metadata(&r.path).await?;
    if !m.is_dir() || m.file_type().is_symlink() || m.dev() != r.device || m.ino() != r.inode {
        return Err(DaemonError::Rpc(
            "Quarantine directory identity changed".into(),
        ));
    }
    super::process_clear(&r.path)
        .await
        .map_err(DaemonError::Rpc)?;
    if fingerprint(&r.path).await? != r.fingerprint {
        return Err(DaemonError::Rpc(
            "Quarantined files changed; retained for recovery".into(),
        ));
    }
    if let Some(s) = &r.snapshot {
        let mut moved = r.variant.clone();
        moved.path = r.path.to_string_lossy().into_owned();
        let identity = super::reclaim::checkout_identity(&r.project, &moved).await;
        if !identity.is_empty() {
            return Err(DaemonError::Rpc(identity.join("; ")));
        }
        snapshot::verify_recoverable(&r.path.to_string_lossy(), s).await?;
    } else {
        let relative = r
            .original
            .strip_prefix(&r.variant.path)
            .map_err(|e| DaemonError::Rpc(e.to_string()))?;
        super::cache::quarantine_contents_safe(
            &r.path,
            relative.to_string_lossy().ends_with("target"),
        )
        .map_err(DaemonError::Rpc)?;
    }
    // The potentially long verification must not be the last process check.
    super::process_clear(&r.path)
        .await
        .map_err(DaemonError::Rpc)
}
// Git's `worktree repair <path>` also visits every other registration. Update
// only this verified worktree's backlink, leaving all other checkouts untouched.
async fn owned_admin(project: &str, path: &Path) -> Result<PathBuf, DaemonError> {
    let link = path.join(".git");
    let m = fs::symlink_metadata(&link).await?;
    if !m.is_file() || m.file_type().is_symlink() || m.len() > 8192 {
        return Err(DaemonError::Rpc("Invalid retained Git link".into()));
    }
    let text = fs::read_to_string(&link).await?;
    let pointer = text
        .trim()
        .strip_prefix("gitdir: ")
        .ok_or_else(|| DaemonError::Rpc("Invalid retained Git pointer".into()))?;
    let admin = super::git_pointer_path(path, pointer);
    let common = directory(project).await?.parent().unwrap().to_owned();
    if admin.parent() != Some(common.join("worktrees").as_path()) {
        return Err(DaemonError::Rpc(
            "Retained Git pointer is outside owned registrations".into(),
        ));
    }
    Ok(admin)
}
async fn repair(project: &str, path: &Path) -> Result<(), DaemonError> {
    let admin = owned_admin(project, path).await?;
    let m = fs::symlink_metadata(&admin).await?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err(DaemonError::Rpc(
            "Invalid retained Git administration".into(),
        ));
    }
    let common = directory(project).await?.parent().unwrap().to_owned();
    let pointer = fs::read_to_string(admin.join("commondir")).await?;
    if fs::canonicalize(super::git_pointer_path(&admin, pointer.trim())).await?
        != fs::canonicalize(&common).await?
    {
        return Err(DaemonError::Rpc(
            "Retained index belongs to another repository".into(),
        ));
    }
    let backlink = fs::read_to_string(admin.join("gitdir")).await?;
    let previous = super::git_pointer_path(&admin, backlink.trim());
    if previous.file_name() != Some(std::ffi::OsStr::new(".git"))
        || previous.parent().and_then(Path::parent) != path.parent()
    {
        return Err(DaemonError::Rpc(
            "Retained registration belongs to another checkout".into(),
        ));
    }
    durable_write(
        &admin.join("gitdir"),
        format!("{}\n", path.join(".git").display()).into_bytes(),
    )
    .await?;
    filesystem_job(move || {
        for name in ["commondir", "HEAD", "index"] {
            let file = admin.join(name);
            if file.exists() {
                std::fs::File::open(file)?.sync_all()?;
            }
        }
        std::fs::File::open(&admin)?.sync_all()?;
        std::fs::File::open(admin.parent().unwrap())?.sync_all()
    })
    .await
}

#[cfg(test)]
fn rename_faults() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
    static FAULTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    FAULTS.get_or_init(Default::default)
}
async fn rename_source(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if rename_faults().lock().unwrap().remove(source) {
        return Err(std::io::Error::other("fixture: quarantine rename failed"));
    }
    fs::rename(source, destination).await
}
pub(crate) async fn stage(
    project: &str,
    variant: &ThreadVariant,
    source: &Path,
    snapshot: Option<Snapshot>,
) -> Result<Record, DaemonError> {
    use std::os::unix::fs::MetadataExt;
    let id = uuid::Uuid::new_v4();
    let parent = Path::new(&variant.path)
        .parent()
        .ok_or_else(|| DaemonError::Rpc("No quarantine parent".into()))?;
    let path = parent.join(format!(".storage-quarantine-{}-{id}", variant.slug));
    let m = fs::symlink_metadata(source).await?;
    let mut r = Record {
        project: project.into(),
        variant: variant.clone(),
        original: source.to_owned(),
        path,
        created_at: chrono::Utc::now().timestamp(),
        fingerprint: fingerprint(source).await?,
        device: m.dev(),
        inode: m.ino(),
        snapshot,
        phase: "prepared".into(),
        metadata: directory(project)
            .await?
            .join(format!("{}.quarantine.{id}.json", variant.slug)),
        residue: None,
    };
    validate(&r)?;
    if r.snapshot.is_none() {
        let rel = source
            .strip_prefix(&variant.path)
            .map_err(|e| DaemonError::Rpc(e.to_string()))?;
        super::cache::validate(Path::new(&variant.path), &rel.to_string_lossy())
            .map_err(DaemonError::Rpc)?;
    }
    // Receipt first: failed staging must not leave an authoritative pending snapshot.
    register_project(project, parent).await?;
    save(&r).await?;
    if let Some(s) = &r.snapshot {
        if let Err(e) = snapshot::save_pending(project, &variant.slug, s).await {
            snapshot::clear_pending(project, &variant.slug).await?;
            fs::remove_file(&r.metadata).await?;
            return Err(e);
        }
    }
    // Rename is atomic and stays on the same filesystem. EXDEV safely refuses
    // rather than falling back to copying and deleting the source.
    let renamed = rename_source(source, &r.path).await;
    if let Err(e) = renamed {
        if r.snapshot.is_some() {
            snapshot::clear_pending(project, &variant.slug).await?;
        }
        fs::remove_file(&r.metadata).await?;
        return Err(e.into());
    }
    let checked = async {
        sync_move(source, &r.path).await?;
        if r.snapshot.is_some() {
            repair(project, &r.path).await?;
        }
        unchanged(&r).await?;
        if r.snapshot.is_none() {
            let rel = source
                .strip_prefix(&variant.path)
                .map_err(|e| DaemonError::Rpc(e.to_string()))?;
            super::cache::validate_at(Path::new(&variant.path), &rel.to_string_lossy(), &r.path)
                .map_err(DaemonError::Rpc)?;
        }
        Ok::<_, DaemonError>(())
    }
    .await;
    if let Err(e) = checked {
        // Preserve all late writes. Roll back the rename only when no external
        // writer has recreated the original pathname in the meantime.
        let rolled_back = async {
            if source.exists() {
                return Err(DaemonError::Rpc("Original path was recreated".into()));
            }
            fs::rename(&r.path, source).await?;
            sync_move(&r.path, source).await?;
            if r.snapshot.is_some() {
                repair(project, source).await?;
                snapshot::clear_pending(project, &variant.slug).await?;
            }
            fs::remove_file(&r.metadata).await?;
            Ok::<_, DaemonError>(())
        }
        .await;
        if rolled_back.is_err() {
            r.phase = "recovery_required".into();
            let _ = save(&r).await;
        }
        return Err(DaemonError::Rpc(format!(
            "Quarantine retained after verification failure: {e}"
        )));
    }
    r.phase = "quarantined".into();
    r.created_at = chrono::Utc::now().timestamp();
    save(&r).await?;
    Ok(r)
}

fn newest_modified(path: &Path) -> std::io::Result<i64> {
    let m = std::fs::symlink_metadata(path)?;
    let mut newest = m
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(i64::MAX);
    if m.is_dir() && !m.file_type().is_symlink() {
        for e in std::fs::read_dir(path)? {
            newest = newest.max(newest_modified(&e?.path())?);
        }
    }
    Ok(newest)
}
async fn checkout_is_old(path: &Path, now: i64) -> Result<bool, DaemonError> {
    let owned = path.to_owned();
    let mut newest = filesystem_job(move || newest_modified(&owned)).await?;
    let git_dir = run_git(
        &path.to_string_lossy(),
        &["rev-parse", "--absolute-git-dir"],
    )
    .await?;
    for name in ["HEAD", "index", "logs/HEAD"] {
        let file = Path::new(git_dir.trim()).join(name);
        if file.exists() {
            newest = newest.max(newest_modified(&file)?);
        }
    }
    Ok(now.saturating_sub(newest) > GRACE_SECONDS)
}

pub(crate) async fn purge(r: &Record, now: i64) -> Result<Option<Reclaim>, DaemonError> {
    if r.phase == "purged" {
        return Ok(None);
    }
    if r.phase == "prepared" && r.path.exists() {
        if r.snapshot.is_some() {
            repair(&r.project, &r.path).await?;
        }
        sync_move(&r.original, &r.path).await?;
        unchanged(r).await?;
        let mut ready = r.clone();
        ready.phase = "quarantined".into();
        ready.created_at = now;
        save(&ready).await?;
        return Ok(None);
    }
    if now.saturating_sub(r.created_at) <= GRACE_SECONDS {
        return Ok(None);
    }
    if r.phase != "quarantined" && r.phase != "prepared" {
        return Ok(Some(Reclaim::RecoveryRequired(vec![format!(
            "Recovery required at {}",
            r.path.display()
        )])));
    }
    unchanged(r).await?;
    if r.snapshot.is_some() && !checkout_is_old(&r.path, now).await? {
        return Err(DaemonError::Rpc(
            "Quarantined checkout has activity within 24 hours".into(),
        ));
    }
    if let Some(s) = &r.snapshot {
        if !super::reclaim::status_blockers_mode_at(
            &r.project,
            &r.path.to_string_lossy(),
            &r.variant.path,
            true,
        )
        .await
        .map_err(DaemonError::Rpc)?
        .is_empty()
        {
            return Err(DaemonError::Rpc(
                "Quarantined checkout contains non-cache ignored data".into(),
            ));
        }
        snapshot::verify_recoverable(&r.path.to_string_lossy(), s).await?;
    }
    // This durable state makes interruption/partial failure distinguishable
    // from a wholly retained checkout. Restore keeps any residue before replay.
    let mut next = r.clone();
    next.phase = "purging".into();
    save(&next).await?;
    let result = remove_quarantined(r).await;
    if let Err(e) = result {
        next.phase = "recovery_required".into();
        save(&next).await?;
        return Ok(Some(Reclaim::RecoveryRequired(vec![format!(
            "Removal was interrupted or partial at {}; restore from checkpoint: {e}",
            r.path.display()
        )])));
    }
    next.phase = "purged".into();
    save(&next).await?;
    if r.snapshot.is_none() {
        fs::remove_file(&r.metadata).await?;
    }
    Ok(Some(Reclaim::Removed))
}

#[cfg(test)]
fn removal_faults() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
    static FAULTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    FAULTS.get_or_init(Default::default)
}
async fn remove_quarantined(r: &Record) -> Result<(), DaemonError> {
    #[cfg(test)]
    if removal_faults().lock().unwrap().remove(&r.path) {
        fs::remove_file(r.path.join("a.txt")).await?;
        return Err(
            std::io::Error::other("fixture: removal interrupted after deleting a file").into(),
        );
    }
    if r.snapshot.is_some() {
        run_git(
            &r.project,
            &["worktree", "remove", "--force", &r.path.to_string_lossy()],
        )
        .await
        .map(|_| ())
    } else {
        let path = r.path.clone();
        filesystem_job(move || std::fs::remove_dir_all(path)).await
    }
}

// Reconnect retained administration before replacement can override a missing
// original registration. A partially removed .git file can be reconstructed
// only from one exact shared-Git registration; its existing index is preserved.
async fn repair_residue(r: &Record, path: &Path) -> Result<(), DaemonError> {
    use std::os::unix::fs::MetadataExt;
    let identity = fs::symlink_metadata(path).await?;
    if !identity.is_dir()
        || identity.file_type().is_symlink()
        || identity.dev() != r.device
        || identity.ino() != r.inode
    {
        return Err(DaemonError::Rpc(
            "Retained residue identity changed; keep for review".into(),
        ));
    }
    let link = path.join(".git");
    let retired = match fs::symlink_metadata(&link).await {
        Ok(m) if m.is_file() && !m.file_type().is_symlink() => {
            let admin = owned_admin(&r.project, path).await?;
            match fs::symlink_metadata(admin).await {
                Ok(_) => false,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                Err(e) => return Err(e.into()),
            }
        }
        Ok(_) => {
            return Err(DaemonError::Rpc(
                "Unexpected Git state in retained residue".into(),
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => return Err(e.into()),
    };
    if retired {
        let common = directory(&r.project).await?.parent().unwrap().to_owned();
        let mut matches = Vec::new();
        let mut entries = match fs::read_dir(common.join("worktrees")).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let expected = [r.original.join(".git"), r.path.join(".git"), link.clone()];
        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let pointer = entry.path().join("gitdir");
            if !fs::symlink_metadata(&pointer).await?.is_file() {
                return Err(DaemonError::Rpc("Invalid retained Git registration".into()));
            }
            let pointer = fs::read_to_string(pointer).await?;
            let resolved = super::git_pointer_path(&entry.path(), pointer.trim());
            if expected.iter().any(|p| *p == resolved) {
                matches.push(entry.path());
            }
        }
        if matches.len() > 1 {
            return Err(DaemonError::Rpc(
                "Ambiguous retained Git indexes; keep all for review".into(),
            ));
        }
        if let Some(admin) = matches.pop() {
            durable_write(&link, format!("gitdir: {}\n", admin.display()).into_bytes()).await?;
        } else {
            // Removal already retired the administration: there is no index
            // at the old pathname for forced restoration to overwrite.
            return Ok(());
        }
    }
    repair(&r.project, path).await?;
    let actual = run_git(
        &path.to_string_lossy(),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await?;
    let common = directory(&r.project).await?.parent().unwrap().to_owned();
    if fs::canonicalize(actual.trim()).await? != fs::canonicalize(common).await? {
        return Err(DaemonError::Rpc(
            "Retained index belongs to another repository".into(),
        ));
    }
    Ok(())
}

/// Cancel a pending removal on restore. Damaged residue is never overwritten:
/// retain it, then let normal snapshot restoration create a fresh checkout.
pub(crate) async fn recover(project: &str, variant: &ThreadVariant) -> Result<bool, DaemonError> {
    let active = snapshot::load(project, &variant.slug).await?;
    if Path::new(&variant.path).exists() && active.as_ref().is_some_and(|s| !s.pending) {
        return Ok(false);
    }
    for r in records(project).await?.into_iter().filter(|r| {
        r.variant.path == variant.path
            && r.snapshot
                .as_ref()
                .is_some_and(|s| active.as_ref().is_some_and(|a| a.oid == s.oid))
    }) {
        if matches!(r.phase.as_str(), "residue_prepared" | "residue_preserved") {
            let retained = r
                .residue
                .as_ref()
                .filter(|p| p.exists())
                .or_else(|| r.path.exists().then_some(&r.path));
            if let Some(path) = retained {
                repair_residue(&r, path).await?;
                if r.phase != "residue_preserved" {
                    let mut next = r.clone();
                    next.phase = "residue_preserved".into();
                    save(&next).await?;
                }
                continue;
            }
        }
        if active.as_ref().is_some_and(|a| !a.pending) && r.path.exists() {
            return Ok(false);
        }
        if !r.path.exists() {
            if Path::new(&variant.path).exists() {
                // The return rename may have completed before registration repair.
                sync_move(&r.path, Path::new(&variant.path)).await?;
                repair(project, Path::new(&variant.path)).await?;
                if r.phase == "prepared" {
                    // Prepared with no quarantine never completed staging; keep
                    // all later work rather than applying its older checkpoint.
                    snapshot::clear_pending(project, &variant.slug).await?;
                    fs::remove_file(&r.metadata).await?;
                }
            }
            continue;
        }
        if Path::new(&variant.path).exists() {
            return Err(DaemonError::Rpc(format!(
                "Both original and quarantine exist; retain both for review: {}",
                r.path.display()
            )));
        }
        if unchanged(&r).await.is_ok()
            && snapshot::verify(&r.path.to_string_lossy(), r.snapshot.as_ref().unwrap())
                .await
                .is_ok()
        {
            if r.snapshot
                .as_ref()
                .is_some_and(|s| s.clean && s.skip_worktree.is_empty())
                && super::setup::restore_setup(project, &variant.slug)
                    .await?
                    .patterns
                    .is_some()
            {
                // Recreate with the newly adopted sparse default. The complete
                // original remains quarantined until its original grace expires.
                return Ok(false);
            }
            fs::rename(&r.path, &r.original).await?;
            sync_move(&r.path, &r.original).await?;
            repair(project, &r.original).await?;
            snapshot::mark_restored(
                project,
                &variant.slug,
                &variant.path,
                r.snapshot.as_ref().unwrap(),
            )
            .await?;
            fs::remove_file(&r.metadata).await?;
            return Ok(true);
        }
        // Keep the partial files and their Git registration at a distinct path;
        // a duplicate-branch restore is permitted only for this recorded recovery.
        let backup = r.residue.clone().unwrap_or_else(|| {
            r.path
                .with_extension(format!("recovery-{}", uuid::Uuid::new_v4()))
        });
        let mut next = r.clone();
        next.residue = Some(backup.clone());
        next.phase = "residue_prepared".into();
        save(&next).await?;
        fs::rename(&r.path, &backup).await?;
        sync_move(&r.path, &backup).await?;
        repair_residue(&next, &backup).await?;

        next.phase = "residue_preserved".into();
        // Original record is retained as evidence; no further purge may remove it.
        save(&next).await?;
        return Ok(false);
    }
    Ok(false)
}

pub(crate) async fn allows_duplicate_restore(
    project: &str,
    variant: &ThreadVariant,
) -> Result<bool, DaemonError> {
    let active = snapshot::load(project, &variant.slug).await?;
    let Some(active) = active else {
        return Ok(false);
    };
    for r in records(project).await? {
        if r.variant != *variant
            || !r.snapshot.as_ref().is_some_and(|s| s.oid == active.oid)
            || !matches!(
                r.phase.as_str(),
                "residue_preserved"
                    | "residue_prepared"
                    | "quarantined"
                    | "prepared"
                    | "purging"
                    | "recovery_required"
                    | "purged"
            )
        {
            continue;
        }
        if active.pending {
            return Ok(true);
        }
        let retained = r
            .residue
            .as_ref()
            .filter(|p| p.exists())
            .or_else(|| r.path.exists().then_some(&r.path));
        if let Some(path) = retained {
            let mut moved = variant.clone();
            moved.path = path.to_string_lossy().into_owned();
            if super::reclaim::checkout_identity(project, &moved)
                .await
                .is_empty()
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
pub(crate) async fn preserve_partial(
    project: &str,
    variant: &ThreadVariant,
    snapshot: Snapshot,
) -> Result<(), DaemonError> {
    use std::os::unix::fs::MetadataExt;
    let source = Path::new(&variant.path);
    let id = uuid::Uuid::new_v4();
    let m = fs::symlink_metadata(source).await?;
    let path = source
        .parent()
        .ok_or_else(|| DaemonError::Rpc("Invalid checkout parent".into()))?
        .join(format!(".storage-quarantine-{}-{id}", variant.slug));
    let mut r = Record {
        project: project.into(),
        variant: variant.clone(),
        original: source.to_owned(),
        path,
        created_at: chrono::Utc::now().timestamp(),
        fingerprint: fingerprint(source).await.unwrap_or_default(),
        device: m.dev(),
        inode: m.ino(),
        snapshot: Some(snapshot),
        phase: "residue_prepared".into(),
        metadata: directory(project)
            .await?
            .join(format!("{}.quarantine.{id}.json", variant.slug)),
        residue: None,
    };
    r.residue = Some(r.path.clone());
    validate(&r)?;
    register_project(project, source.parent().unwrap()).await?;
    save(&r).await?;
    fs::rename(source, &r.path).await?;
    sync_move(source, &r.path).await?;
    repair_residue(&r, &r.path).await?;
    r.phase = "residue_preserved".into();
    save(&r).await
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        _temp: tempfile::TempDir,
        project: PathBuf,
        variant: ThreadVariant,
    }
    fn git(path: &Path, args: &[&str]) -> String {
        let o = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            o.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        String::from_utf8(o.stdout).unwrap().trim().to_owned()
    }
    fn fixture() -> Fixture {
        let t = tempfile::tempdir().unwrap();
        let project = t.path().join("project");
        std::fs::create_dir(&project).unwrap();
        git(&project, &["init", "-b", "main"]);
        git(&project, &["config", "user.name", "Fixture"]);
        git(
            &project,
            &["config", "user.email", "fixture@example.invalid"],
        );
        std::fs::write(project.join("a.txt"), "baseline").unwrap();
        std::fs::write(project.join("b.txt"), "second").unwrap();
        git(&project, &["add", "."]);
        git(&project, &["commit", "-m", "baseline"]);
        let path = t.path().join("variants/checkout");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        git(
            &project,
            &[
                "worktree",
                "add",
                "-b",
                "falcondeck/test",
                path.to_str().unwrap(),
            ],
        );
        super::super::test_no_docker_mounts(t.path());
        Fixture {
            _temp: t,
            project,
            variant: ThreadVariant {
                slug: "test".into(),
                path: path.to_string_lossy().into_owned(),
                branch: "falcondeck/test".into(),
                kind: falcondeck_core::ThreadVariantKind::Worktree,
                base_branch: Some("main".into()),
            },
        }
    }
    #[tokio::test]
    async fn staged_and_working_versions_are_reachable_and_restore_independently() {
        let f = fixture();
        let path = Path::new(&f.variant.path);
        let project = f.project.to_str().unwrap();
        std::fs::write(path.join("a.txt"), "staged-only A").unwrap();
        git(path, &["add", "a.txt"]);
        std::fs::write(path.join("a.txt"), "working B").unwrap();
        let snapshot = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        assert_eq!(
            git(path, &["show", &format!("{}^2:a.txt", snapshot.oid)]),
            "staged-only A"
        );
        let r = stage(project, &f.variant, path, Some(snapshot))
            .await
            .unwrap();
        assert!(!path.exists());
        assert!(r.path.join("a.txt").exists());
        assert!(
            purge(&r, r.created_at + GRACE_SECONDS)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            purge(&r, r.created_at + GRACE_SECONDS + 1).await.unwrap(),
            Some(Reclaim::Removed)
        );
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(git(path, &["show", ":a.txt"]), "staged-only A");
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "working B"
        );
        assert_eq!(
            git(path, &["symbolic-ref", "--short", "HEAD"]),
            f.variant.branch
        );
    }
    #[tokio::test]
    async fn late_quarantine_writes_are_retained_and_never_purged() {
        let f = fixture();
        let path = Path::new(&f.variant.path);
        let project = f.project.to_str().unwrap();
        let s = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let r = stage(project, &f.variant, path, Some(s)).await.unwrap();
        std::fs::write(r.path.join("a.txt"), "late external edit").unwrap();
        assert!(purge(&r, r.created_at + GRACE_SECONDS + 1).await.is_err());
        assert_eq!(
            std::fs::read_to_string(r.path.join("a.txt")).unwrap(),
            "late external edit"
        );
    }
    #[tokio::test]
    async fn partial_removal_is_preserved_before_snapshot_recovery() {
        let f = fixture();
        let path = Path::new(&f.variant.path);
        let project = f.project.to_str().unwrap();
        std::fs::write(path.join("a.txt"), "saved edit").unwrap();
        std::fs::write(path.join("new.bin"), [0, 255, 0, 128]).unwrap();
        let s = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let mut r = stage(project, &f.variant, path, Some(s)).await.unwrap();
        r.phase = "purging".into();
        save(&r).await.unwrap();
        std::fs::remove_file(r.path.join("a.txt")).unwrap();
        std::fs::write(r.path.join("residue.txt"), "keep this too").unwrap();
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "saved edit"
        );
        assert_eq!(
            std::fs::read(path.join("new.bin")).unwrap(),
            [0, 255, 0, 128]
        );
        let residue = records(project)
            .await
            .unwrap()
            .into_iter()
            .find_map(|r| r.residue)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(residue.join("residue.txt")).unwrap(),
            "keep this too"
        );
    }
    #[tokio::test]
    async fn pending_snapshot_on_existing_damaged_checkout_is_not_accepted_as_populated() {
        let f = fixture();
        let path = Path::new(&f.variant.path);
        let project = f.project.to_str().unwrap();
        std::fs::write(path.join("a.txt"), "saved edit").unwrap();
        let s = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        snapshot::save_pending(project, &f.variant.slug, &s)
            .await
            .unwrap();
        std::fs::remove_file(path.join("a.txt")).unwrap();
        assert!(path.join("b.txt").exists());
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "saved edit"
        );
    }
    #[tokio::test]
    async fn restart_after_rename_before_commit_recovers_the_original_checkout() {
        let f = fixture();
        let path = Path::new(&f.variant.path);
        let project = f.project.to_str().unwrap();
        let s = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let mut r = stage(project, &f.variant, path, Some(s)).await.unwrap();
        r.phase = "prepared".into();
        save(&r).await.unwrap();
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "baseline"
        );
    }
    #[tokio::test]
    async fn clean_legacy_sparse_restore_can_be_used_again_while_quarantine_waits() {
        let f = fixture();
        let path = Path::new(&f.variant.path);
        let project = f.project.to_str().unwrap();
        std::fs::create_dir(path.join("data")).unwrap();
        std::fs::write(path.join("data/payload"), "tracked data").unwrap();
        git(path, &["add", "data"]);
        git(path, &["commit", "-m", "tracked data"]);
        let config = f._temp.path().join("setup.json");
        std::fs::write(&config, r#"{"sparse_exclude":["data"]}"#).unwrap();
        git(
            &f.project,
            &[
                "config",
                "falcondeck.worktreeSetup",
                config.to_str().unwrap(),
            ],
        );
        super::super::setup::preserve_for_reclaim(project, &f.variant.slug, path, true)
            .await
            .unwrap();
        let snapshot = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let mut r = stage(project, &f.variant, path, Some(snapshot))
            .await
            .unwrap();
        r.phase = "prepared".into();
        save(&r).await.unwrap();
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert!(!path.join("data").exists());
        assert!(r.path.join("data/payload").exists());
        assert!(!super::super::restore(project, &f.variant).await.unwrap());
        std::fs::write(path.join("a.txt"), "new committed branch state").unwrap();
        git(path, &["add", "a.txt"]);
        git(path, &["commit", "-m", "new branch state"]);
        std::fs::remove_dir_all(path).unwrap();
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "new committed branch state"
        );
        assert!(!path.join("data").exists());
        assert!(r.path.join("data/payload").exists());
        assert!(
            super::super::setup::hint(project, &f.variant.path)
                .await
                .unwrap()
                .contains("sparse-checkout add")
        );
    }
    #[tokio::test]
    async fn failed_mid_removal_reports_recovery_required_and_replays_checkpoint() {
        let f = fixture();
        let path = Path::new(&f.variant.path);
        let project = f.project.to_str().unwrap();
        std::fs::write(path.join("a.txt"), "saved dirty edit").unwrap();
        let snapshot = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let r = stage(project, &f.variant, path, Some(snapshot))
            .await
            .unwrap();
        removal_faults().lock().unwrap().insert(r.path.clone());
        let outcome = purge(&r, r.created_at + GRACE_SECONDS + 2).await.unwrap();
        assert!(matches!(outcome, Some(Reclaim::RecoveryRequired(_))));
        assert_eq!(
            records(project).await.unwrap()[0].phase,
            "recovery_required"
        );
        assert!(!r.path.join("a.txt").exists());
        assert!(r.path.join("b.txt").exists());
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "saved dirty edit"
        );
    }
    #[tokio::test]
    async fn failed_rename_cancels_pending_snapshot_and_keeps_later_work() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        rename_faults().lock().unwrap().insert(path.to_owned());
        assert!(stage(project, &f.variant, path, Some(saved)).await.is_err());
        assert!(
            !snapshot::load(project, &f.variant.slug)
                .await
                .unwrap()
                .unwrap()
                .pending
        );
        assert!(records(project).await.unwrap().is_empty());
        std::fs::write(path.join("a.txt"), "later work").unwrap();
        assert!(!super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "later work"
        );
    }
    #[tokio::test]
    async fn failed_receipt_write_does_not_mark_snapshot_pending() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let registry = directory(project).await.unwrap();
        std::fs::create_dir_all(&registry).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&registry, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = stage(project, &f.variant, path, Some(saved)).await;
        std::fs::set_permissions(&registry, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        // Snapshot creation only pins refs; staging never committed a pending receipt.
        assert!(
            snapshot::load(project, &f.variant.slug)
                .await
                .unwrap()
                .is_none()
        );
        assert!(path.join("a.txt").exists());
    }
    #[tokio::test]
    async fn interrupted_prepared_receipt_does_not_replace_current_checkout() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let mut r = stage(project, &f.variant, path, Some(saved)).await.unwrap();
        std::fs::rename(&r.path, path).unwrap();
        repair(project, path).await.unwrap();
        r.phase = "prepared".into();
        save(&r).await.unwrap();
        std::fs::write(path.join("a.txt"), "newer work").unwrap();
        assert!(!super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "newer work"
        );
        assert!(
            !snapshot::load(project, &f.variant.slug)
                .await
                .unwrap()
                .unwrap()
                .pending
        );
    }
    #[tokio::test]
    async fn interrupted_purge_with_stale_registration_restores_pending_snapshot() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        std::fs::write(path.join("a.txt"), "saved work").unwrap();
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let mut r = stage(project, &f.variant, path, Some(saved)).await.unwrap();
        r.phase = "purging".into();
        save(&r).await.unwrap();
        std::fs::remove_dir_all(&r.path).unwrap();
        assert!(
            git(&f.project, &["worktree", "list", "--porcelain"])
                .contains(r.path.to_str().unwrap())
        );
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "saved work"
        );
    }
    #[tokio::test]
    async fn interrupted_residue_rename_keeps_backup_discoverable() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let mut r = stage(project, &f.variant, path, Some(saved)).await.unwrap();
        std::fs::write(r.path.join("late.txt"), "unique late work").unwrap();
        let backup = r.path.with_extension("recovery-fixture");
        r.phase = "residue_prepared".into();
        r.residue = Some(backup.clone());
        save(&r).await.unwrap();
        std::fs::rename(&r.path, &backup).unwrap();
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(backup.join("late.txt")).unwrap(),
            "unique late work"
        );
        assert_eq!(
            records(project).await.unwrap()[0].residue.as_ref(),
            Some(&backup)
        );
        assert_eq!(
            records(project).await.unwrap()[0].phase,
            "residue_preserved"
        );
    }
    #[tokio::test]
    async fn prepared_purge_repairs_a_move_interrupted_before_git_registration() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let mut r = stage(project, &f.variant, path, Some(saved)).await.unwrap();
        // Reproduce a crash after the filesystem move but before Git repair.
        std::fs::rename(&r.path, path).unwrap();
        repair(project, path).await.unwrap();
        std::fs::rename(path, &r.path).unwrap();
        r.phase = "prepared".into();
        save(&r).await.unwrap();
        assert!(
            git(&f.project, &["worktree", "list", "--porcelain"])
                .contains(&format!("worktree {}", path.display()))
        );
        let now = chrono::Utc::now().timestamp();
        assert!(purge(&r, now).await.unwrap().is_none());
        assert!(
            git(&f.project, &["worktree", "list", "--porcelain"])
                .contains(&format!("worktree {}", r.path.display()))
        );
        let ready = records(project).await.unwrap().remove(0);
        assert_eq!(ready.phase, "quarantined");
        assert_eq!(
            purge(&ready, now + GRACE_SECONDS + 1).await.unwrap(),
            Some(Reclaim::Removed)
        );
    }
    #[tokio::test]
    async fn legacy_partial_recovery_registers_discovery_before_moving_files() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        snapshot::save_pending(project, &f.variant.slug, &saved)
            .await
            .unwrap();
        std::fs::remove_file(path.join("a.txt")).unwrap();
        preserve_partial(project, &f.variant, saved).await.unwrap();
        // This fixture's parent corresponds to a managed project group.
        let roots = registered_projects(path.parent().unwrap().parent().unwrap())
            .await
            .unwrap();
        assert!(roots.iter().any(|p| p == project));
        let paths = retained_volume_paths(path.parent().unwrap().parent().unwrap())
            .await
            .unwrap();
        assert!(paths.contains(&path.parent().unwrap().to_owned()));
        let r = records(project).await.unwrap().remove(0);
        assert!(r.path.join("b.txt").exists());
    }
    #[tokio::test]
    async fn interrupted_return_move_repairs_registration_before_accepting_checkout() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        std::fs::write(path.join("a.txt"), "saved working edit").unwrap();
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let r = stage(project, &f.variant, path, Some(saved)).await.unwrap();
        std::fs::rename(&r.path, path).unwrap();
        sync_move(&r.path, path).await.unwrap();
        assert!(
            git(&f.project, &["worktree", "list", "--porcelain"])
                .contains(&format!("worktree {}", r.path.display()))
        );
        assert!(!super::super::restore(project, &f.variant).await.unwrap());
        assert!(
            git(&f.project, &["worktree", "list", "--porcelain"])
                .contains(&format!("worktree {}", path.display()))
        );
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "saved working edit"
        );
        assert!(
            !snapshot::load(project, &f.variant.slug)
                .await
                .unwrap()
                .unwrap()
                .pending
        );
    }
    #[tokio::test]
    async fn failed_rollback_sync_keeps_pending_recovery_metadata() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        std::fs::write(path.join("a.txt"), "saved work").unwrap();
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        sync_faults().lock().unwrap().insert(path.to_owned(), 2);
        assert!(stage(project, &f.variant, path, Some(saved)).await.is_err());
        assert!(path.join("a.txt").exists());
        assert!(
            snapshot::load(project, &f.variant.slug)
                .await
                .unwrap()
                .unwrap()
                .pending
        );
        assert_eq!(
            records(project).await.unwrap()[0].phase,
            "recovery_required"
        );
        assert!(!super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "saved work"
        );
        assert!(
            !snapshot::load(project, &f.variant.slug)
                .await
                .unwrap()
                .unwrap()
                .pending
        );
    }
    #[tokio::test]
    async fn detached_same_tree_commit_is_never_removed_from_quarantine() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let r = stage(project, &f.variant, path, Some(saved)).await.unwrap();
        git(&r.path, &["switch", "--detach"]);
        git(
            &r.path,
            &["commit", "--allow-empty", "-m", "detached unique history"],
        );
        let head = git(&r.path, &["rev-parse", "HEAD"]);
        assert!(purge(&r, r.created_at + GRACE_SECONDS + 1).await.is_err());
        assert!(r.path.exists());
        assert_eq!(git(&r.path, &["rev-parse", "HEAD"]), head);
    }
    #[tokio::test]
    async fn moved_checkout_retains_logical_paths_for_verified_pnpm_shim_purge() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        std::fs::write(path.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(path.join("package.json"), "{}").unwrap();
        git(path, &["add", ".gitignore", "package.json"]);
        git(path, &["commit", "-m", "dependency inputs"]);
        let modules = path.join("node_modules");
        let package = modules.join("example");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir(modules.join(".bin")).unwrap();
        std::fs::write(
            modules.join(".package-lock.json"),
            r#"{"packages":{"node_modules/example":{}}}"#,
        )
        .unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"example","bin":{"example":"cli.js"}}"#,
        )
        .unwrap();
        std::fs::write(package.join("cli.js"), "#!/usr/bin/env node\n").unwrap();
        let shim = include_str!("pnpm-node-shim.template")
            .replace("@TARGET@", package.join("cli.js").to_str().unwrap())
            .replace("@RELATIVE@", "../example/cli.js")
            .replace("@NODE_PATH@", modules.to_str().unwrap());
        std::fs::write(modules.join(".bin/example"), shim).unwrap();
        assert!(super::super::cache::validate(path, "node_modules").is_ok());
        assert!(matches!(
            super::super::reclaim_if_safe(project, &f.variant).await,
            Reclaim::Quarantined(_)
        ));
        let r = records(project).await.unwrap().remove(0);
        assert_eq!(
            purge(&r, r.created_at + GRACE_SECONDS + 1).await.unwrap(),
            Some(Reclaim::Removed)
        );
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert!(path.join("a.txt").exists());
    }
    #[tokio::test]
    async fn residue_repair_failure_blocks_replacement_and_retry_keeps_newer_staged_work() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        snapshot::save_pending(project, &f.variant.slug, &saved)
            .await
            .unwrap();
        std::fs::write(path.join("a.txt"), "newer staged-only content").unwrap();
        git(path, &["add", "a.txt"]);
        std::fs::write(path.join("a.txt"), "newer working content").unwrap();
        let admin = PathBuf::from(git(path, &["rev-parse", "--absolute-git-dir"]));
        std::fs::set_permissions(admin.join("gitdir"), std::fs::Permissions::from_mode(0o400))
            .unwrap();
        std::fs::set_permissions(&admin, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = preserve_partial(project, &f.variant, saved).await;
        std::fs::set_permissions(&admin, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(admin.join("gitdir"), std::fs::Permissions::from_mode(0o600))
            .unwrap();
        assert!(result.is_err());
        assert!(!path.exists());
        assert!(admin.join("index").exists());
        let retained = records(project).await.unwrap().remove(0);
        assert_eq!(retained.phase, "residue_prepared");
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(
            git(&retained.path, &["show", ":a.txt"]),
            "newer staged-only content"
        );
        assert_eq!(
            std::fs::read_to_string(retained.path.join("a.txt")).unwrap(),
            "newer working content"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "baseline"
        );
    }
    #[tokio::test]
    async fn missing_git_link_in_partial_residue_does_not_lose_its_newer_index() {
        for relative in [false, true] {
            let f = fixture();
            let project = f.project.to_str().unwrap();
            let path = Path::new(&f.variant.path);
            if relative {
                git(&f.project, &["config", "worktree.useRelativePaths", "true"]);
                git(
                    &f.project,
                    &["worktree", "repair", "--relative-paths", &f.variant.path],
                );
                let admin = PathBuf::from(git(path, &["rev-parse", "--absolute-git-dir"]));
                assert!(
                    !Path::new(
                        std::fs::read_to_string(admin.join("gitdir"))
                            .unwrap()
                            .trim()
                    )
                    .is_absolute()
                );
            }
            let saved = snapshot::create(&f.variant.path, &f.variant.slug)
                .await
                .unwrap();
            snapshot::save_pending(project, &f.variant.slug, &saved)
                .await
                .unwrap();
            std::fs::write(path.join("a.txt"), "newer staged-only content").unwrap();
            git(path, &["add", "a.txt"]);
            std::fs::write(path.join("a.txt"), "newer working content").unwrap();
            std::fs::remove_file(path.join(".git")).unwrap();
            preserve_partial(project, &f.variant, saved).await.unwrap();
            let retained = records(project).await.unwrap().remove(0);
            assert!(super::super::restore(project, &f.variant).await.unwrap());
            assert_eq!(
                git(&retained.path, &["show", ":a.txt"]),
                "newer staged-only content"
            );
            assert_eq!(
                std::fs::read_to_string(retained.path.join("a.txt")).unwrap(),
                "newer working content"
            );
            assert_eq!(
                std::fs::read_to_string(path.join("a.txt")).unwrap(),
                "baseline"
            );
        }
    }
    #[tokio::test]
    async fn targeted_repair_does_not_relink_an_unrelated_reused_checkout() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let other = Path::new(&f.variant.path).parent().unwrap().join("other");
        git(
            &f.project,
            &["worktree", "add", "-b", "other", other.to_str().unwrap()],
        );
        std::fs::remove_dir_all(&other).unwrap();
        std::fs::create_dir(&other).unwrap();
        let independent = f._temp.path().join("independent.git");
        git(
            &other,
            &[
                "init",
                "--separate-git-dir",
                independent.to_str().unwrap(),
                "-b",
                "independent",
            ],
        );
        let before = git(&other, &["rev-parse", "--absolute-git-dir"]);
        let path = Path::new(&f.variant.path);
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let r = stage(project, &f.variant, path, Some(saved)).await.unwrap();
        // A .git file can be overwritten by global worktree repair; a
        // directory would hide the regression by making the write fail.
        assert!(other.join(".git").is_file());
        assert_eq!(git(&other, &["rev-parse", "--absolute-git-dir"]), before);
        assert_eq!(
            git(&r.path, &["rev-parse", "--show-toplevel"]),
            r.path.to_str().unwrap()
        );
    }
    #[tokio::test]
    async fn retired_administration_with_surviving_gitfile_restores_snapshot() {
        let f = fixture();
        let project = f.project.to_str().unwrap();
        let path = Path::new(&f.variant.path);
        std::fs::write(path.join("a.txt"), "staged snapshot").unwrap();
        git(path, &["add", "a.txt"]);
        std::fs::write(path.join("a.txt"), "working snapshot").unwrap();
        let saved = snapshot::create(&f.variant.path, &f.variant.slug)
            .await
            .unwrap();
        let r = stage(project, &f.variant, path, Some(saved)).await.unwrap();
        let admin = PathBuf::from(git(&r.path, &["rev-parse", "--absolute-git-dir"]));
        // Real Git removes administration even if unlinking the checkout fails.
        std::fs::remove_file(r.path.join("b.txt")).unwrap();
        std::fs::write(r.path.join("later.txt"), "retained residue").unwrap();
        std::fs::remove_dir_all(admin).unwrap();
        let mut failed = r.clone();
        failed.phase = "recovery_required".into();
        save(&failed).await.unwrap();
        assert!(super::super::restore(project, &f.variant).await.unwrap());
        assert_eq!(git(path, &["show", ":a.txt"]), "staged snapshot");
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "working snapshot"
        );
        assert!(path.join("b.txt").exists());
        let retained = records(project).await.unwrap().remove(0).residue.unwrap();
        assert_eq!(
            std::fs::read_to_string(retained.join("later.txt")).unwrap(),
            "retained residue"
        );
        assert!(retained.join(".git").is_file());
    }
    #[tokio::test]
    async fn registered_separate_git_volume_survives_missing_project_pointer() {
        let t = tempfile::tempdir().unwrap();
        let project = t.path().join("project");
        let common = t.path().join("shared.git");
        git(
            t.path(),
            &[
                "init",
                "--separate-git-dir",
                common.to_str().unwrap(),
                project.to_str().unwrap(),
            ],
        );
        let variants = t.path().join("variants");
        let group = variants.join("project");
        std::fs::create_dir_all(&group).unwrap();
        register_project(project.to_str().unwrap(), &group)
            .await
            .unwrap();
        std::fs::remove_file(project.join(".git")).unwrap();
        assert!(
            retained_volume_paths(&variants)
                .await
                .unwrap()
                .contains(&common)
        );
    }
}
