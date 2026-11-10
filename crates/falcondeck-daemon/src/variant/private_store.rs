//! Private ignored data is never stored in Git objects or shared Git metadata.
//! Its payload and path manifest live under a mode-0700 sibling vault. Verified
//! copies preserve permissions/ACLs; restoration copies them without running
//! package/project code, checks every byte/mode and never follows symlinks.
#[cfg(test)]
use super::storage_metadata::set_attribute;
use super::storage_metadata::{attributes, copy_attributes};
use crate::error::DaemonError;
use serde::{Deserialize, Serialize};
use std::{
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Component, Path, PathBuf},
};
use tokio::fs;

#[derive(Serialize, Deserialize)]
struct Entry {
    path: PathBuf,
    fingerprint: String,
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    entries: Vec<Entry>,
    #[serde(default)]
    complete: bool,
    #[serde(default)]
    publication: Option<Publication>,
}
#[derive(Serialize, Deserialize)]
struct Publication {
    device: u64,
    inode: u64,
    fingerprint: String,
}
async fn fingerprint(path: &Path) -> Result<String, DaemonError> {
    let content = super::quarantine::fingerprint(path).await?;
    let root = path.to_owned();
    super::quarantine::filesystem_job(move || {
        use sha2::{Digest, Sha256};
        fn walk(p: &Path, h: &mut Sha256) -> std::io::Result<()> {
            let m = std::fs::symlink_metadata(p)?;
            h.update(m.uid().to_le_bytes());
            h.update(m.gid().to_le_bytes());
            #[cfg(target_os = "macos")]
            {
                let acl = super::storage_metadata::native_acl(p)?;
                h.update(b"native-macos-acl-v1\0");
                h.update((acl.len() as u64).to_le_bytes());
                h.update(acl);
            }
            let attrs = attributes(p)?;
            h.update((attrs.len() as u64).to_le_bytes());
            for (name, value) in attrs {
                h.update((name.len() as u64).to_le_bytes());
                h.update(name);
                h.update((value.len() as u64).to_le_bytes());
                h.update(value);
            }
            if m.is_dir() && !m.file_type().is_symlink() {
                let mut entries = std::fs::read_dir(p)?.collect::<Result<Vec<_>, _>>()?;
                entries.sort_by_key(|e| e.file_name());
                for e in entries {
                    walk(&e.path(), h)?
                }
            }
            Ok(())
        }
        let mut h = Sha256::new();
        h.update(content.as_bytes());
        walk(&root, &mut h)?;
        Ok(format!("{:x}", h.finalize()))
    })
    .await
}
pub(super) fn relative(p: &Path) -> bool {
    !p.as_os_str().is_empty()
        && p.components().all(|c| matches!(c, Component::Normal(_)))
        && p.components().next() != Some(Component::Normal(std::ffi::OsStr::new(".git")))
}
async fn parents(root: &Path, relative: &Path, create: bool) -> Result<(), DaemonError> {
    let base = fs::symlink_metadata(root).await?;
    if !base.is_dir() || base.file_type().is_symlink() {
        return Err(DaemonError::Rpc(
            "Private recovery root is not a real directory".into(),
        ));
    }

    if !relative
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(DaemonError::Rpc("Invalid private recovery path".into()));
    }
    let mut p = root.to_owned();
    for c in relative.parent().unwrap_or(Path::new("")).components() {
        p.push(c);
        match fs::symlink_metadata(&p).await {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(DaemonError::Rpc(
                    "Private recovery parent is not a real directory".into(),
                ));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir(&p).await?;
                fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).await?
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
async fn directory_metadata(source: &Path, dest: &Path) -> Result<(), DaemonError> {
    let a = source.to_owned();
    let b = dest.to_owned();
    super::quarantine::filesystem_job(move || {
        let original = std::fs::symlink_metadata(&a)?;
        let target = std::fs::symlink_metadata(&b)?;
        if !original.is_dir()
            || !target.is_dir()
            || original.file_type().is_symlink()
            || target.file_type().is_symlink()
        {
            return Err(std::io::Error::other("Private recovery directory changed"));
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::ffi::OsStrExt;
            unsafe extern "C" {
                fn copyfile(
                    from: *const libc::c_char,
                    to: *const libc::c_char,
                    state: *mut libc::c_void,
                    flags: u32,
                ) -> libc::c_int;
            }
            let from = std::ffi::CString::new(a.as_os_str().as_bytes())?;
            let to = std::ffi::CString::new(b.as_os_str().as_bytes())?;
            // copyfile.h: ACL|STAT|XATTR, NOFOLLOW on both paths; no file data.
            if unsafe {
                copyfile(
                    from.as_ptr(),
                    to.as_ptr(),
                    std::ptr::null_mut(),
                    7 | (1 << 18) | (1 << 19),
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            #[cfg(target_os = "linux")]
            {
                use std::os::unix::ffi::OsStrExt;
                let path = std::ffi::CString::new(b.as_os_str().as_bytes())?;
                if unsafe { libc::lchown(path.as_ptr(), original.uid(), original.gid()) } != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            std::fs::set_permissions(&b, original.permissions())?;
        }
        copy_attributes(&a, &b)?;
        #[cfg(target_os = "macos")]
        if super::storage_metadata::native_acl(&a)? != super::storage_metadata::native_acl(&b)? {
            return Err(std::io::Error::other(
                "Private directory ACL could not be preserved",
            ));
        }
        let copied = std::fs::symlink_metadata(&b)?;
        if copied.mode() != original.mode()
            || copied.uid() != original.uid()
            || copied.gid() != original.gid()
        {
            return Err(std::io::Error::other(
                "Private directory permissions could not be preserved",
            ));
        }
        Ok(())
    })
    .await
}
async fn secure_directory(path: &Path) -> Result<(), DaemonError> {
    let m = fs::symlink_metadata(path).await?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err(DaemonError::Rpc("Private directory changed".into()));
    }
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    #[cfg(target_os = "macos")]
    {
        let status = tokio::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await?;
        if !status.success() {
            return Err(DaemonError::Rpc(
                "Could not secure private directory".into(),
            ));
        }
    }
    Ok(())
}
async fn writable_parents(source: &Path, dest: &Path, path: &Path) -> Result<(), DaemonError> {
    parents(source, path, false).await?;
    secure_directory(dest).await?;
    let mut rel = PathBuf::new();
    for c in path.parent().unwrap_or(Path::new("")).components() {
        rel.push(c);
        let directory = dest.join(&rel);
        match fs::symlink_metadata(&directory).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&directory).await?
            }
            Err(e) => return Err(e.into()),
        }
        secure_directory(&directory).await?;
    }
    Ok(())
}
async fn finish_directory_metadata(
    source: &Path,
    dest: &Path,
    paths: &[PathBuf],
) -> Result<(), DaemonError> {
    let mut dirs = std::collections::BTreeSet::from([PathBuf::new()]);
    for p in paths {
        for parent in p.ancestors().skip(1) {
            dirs.insert(parent.to_owned());
        }
    }
    let mut dirs = dirs.into_iter().collect::<Vec<_>>();
    dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    // Set restrictive/read-only ancestor permissions only after every payload
    // has been copied. The enclosing vault remains private throughout.
    for rel in dirs {
        directory_metadata(&source.join(&rel), &dest.join(&rel)).await?;
    }
    Ok(())
}
async fn sync(path: &Path) -> Result<(), DaemonError> {
    let owned = path.to_owned();
    super::quarantine::filesystem_job(move || super::cache_index::open_nofollow(&owned)?.sync_all())
        .await
}
async fn sync_tree(path: &Path) -> Result<(), DaemonError> {
    let owned = path.to_owned();
    super::quarantine::filesystem_job(move || {
        fn walk(p: &Path) -> std::io::Result<()> {
            let m = std::fs::symlink_metadata(p)?;
            if m.file_type().is_symlink() {
                return Ok(());
            }
            if m.is_dir() {
                for e in std::fs::read_dir(p)? {
                    walk(&e?.path())?
                }
            }
            super::cache_index::open_nofollow(p)?.sync_all()
        }
        walk(&owned)
    })
    .await
}
async fn create_private_directory(path: &Path) -> Result<(), DaemonError> {
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    builder.create(path).await?;
    Ok(())
}
async fn root(path: &Path) -> Result<(), DaemonError> {
    match fs::symlink_metadata(path).await {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() && m.mode() & 0o777 == 0o700 => {
            // Creation may have stopped before inherited ACLs were removed.
            // Harden on every reopen, before reading or writing private metadata.
            secure_directory(path).await
        }
        Ok(_) => Err(DaemonError::Rpc(
            "Private vault permissions or identity changed".into(),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            create_private_directory(path).await?;
            secure_directory(path).await?;
            sync(path.parent().unwrap()).await
        }
        Err(e) => Err(e.into()),
    }
}
/// Whole ignored roots, except positively verified cache contents. Git's
/// collapsed directory form preserves empty directories and arbitrary layouts.
pub(crate) async fn plan(checkout: &Path, logical: &Path) -> Result<Vec<PathBuf>, DaemonError> {
    let listed = super::reclaim::git(
        checkout
            .to_str()
            .ok_or_else(|| DaemonError::Rpc("Non-UTF8 checkout".into()))?,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
        &[],
        std::time::Duration::from_secs(120),
    )
    .await
    .map_err(DaemonError::Rpc)?;
    let mut pending = listed
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| PathBuf::from(s.trim_end_matches('/')))
        .collect::<Vec<_>>();
    let mut keep = Vec::new();
    while let Some(rel) = pending.pop() {
        if !relative(&rel) {
            return Err(DaemonError::Rpc("Invalid ignored recovery path".into()));
        }
        let kind = fs::symlink_metadata(checkout.join(&rel)).await?;
        if super::cache::known_location(&rel.to_string_lossy())
            && kind.is_dir()
            && !kind.file_type().is_symlink()
        {
            let physical = checkout.join(&rel);
            let owned = checkout.to_owned();
            let text = rel.to_string_lossy().into_owned();
            let part = super::quarantine::filesystem_job(move || {
                super::cache::partition(&owned, &text, &physical).map_err(std::io::Error::other)
            })
            .await?;
            for (p, _) in part.retained {
                keep.push(rel.join(p));
            }
        } else if super::cache::ancestor_of_cache(&rel.to_string_lossy())
            && fs::symlink_metadata(checkout.join(&rel)).await?.is_dir()
        {
            let mut entries = fs::read_dir(checkout.join(&rel)).await?;
            let mut any = false;
            while let Some(e) = entries.next_entry().await? {
                any = true;
                pending.push(rel.join(e.file_name()));
            }
            if !any {
                keep.push(rel)
            }
        } else {
            keep.push(rel)
        }
    }
    keep.sort();
    keep.dedup();
    // Git can emit an ignored directory together with its ignored children
    // when the rule lives inside it. Store each subtree exactly once.
    let roots = keep
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    keep.retain(|p| !p.ancestors().skip(1).any(|parent| roots.contains(parent)));
    let _ = logical;
    Ok(keep)
}
pub(crate) async fn prepare(
    source: &Path,
    vault: &Path,
    paths: &[PathBuf],
) -> Result<(), DaemonError> {
    root(vault).await?;
    let payload = vault.join("files");
    match fs::symlink_metadata(&payload).await {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
        Ok(_) => return Err(DaemonError::Rpc("Private payload root changed".into())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&payload).await?;
        }
        Err(e) => return Err(e.into()),
    }

    let manifest = vault.join("manifest.json");
    if !manifest.exists() {
        let mut entries = Vec::new();
        for path in paths {
            if !relative(path) {
                return Err(DaemonError::Rpc("Invalid private recovery path".into()));
            }
            entries.push(Entry {
                path: path.clone(),
                fingerprint: fingerprint(&source.join(path)).await?,
            })
        }
        let bytes = serde_json::to_vec(&Manifest {
            entries,
            complete: false,
            publication: None,
        })?;
        // The temporary file is never world-readable, even before rename.
        let temp = vault.join(format!("manifest-{}.tmp", uuid::Uuid::new_v4()));
        use tokio::io::AsyncWriteExt;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        let mut f = options.open(&temp).await?;
        f.write_all(&bytes).await?;
        f.sync_all().await?;
        fs::rename(temp, &manifest).await?;
        sync(vault).await?;
    }
    let mut m = load(vault).await?;
    let was_complete = m.complete;
    for path in paths {
        if !relative(path) {
            return Err(DaemonError::Rpc("Invalid private recovery path".into()));
        }
        if m.entries.iter().any(|e| path.starts_with(&e.path)) {
            continue;
        }
        if m.entries.iter().any(|e| e.path.starts_with(path)) {
            return Err(DaemonError::Rpc(
                "Private preservation plan changed shape; all copies retained".into(),
            ));
        }
        m.entries.push(Entry {
            path: path.clone(),
            fingerprint: fingerprint(&source.join(path)).await?,
        });
    }
    m.complete = false;
    write_manifest(vault, &m).await?;
    secure_directory(&payload).await?;
    let all_paths = m.entries.iter().map(|e| e.path.clone()).collect::<Vec<_>>();
    for entry in m.entries {
        parents(source, &entry.path, false).await?;
        let from = source.join(&entry.path);
        let to = vault.join("files").join(&entry.path);
        if fingerprint(&from).await? != entry.fingerprint {
            return Err(DaemonError::Rpc(
                "Private content changed; all copies retained".into(),
            ));
        }
        let mut needs_copy = true;
        if fs::symlink_metadata(&to).await.is_ok() {
            if fingerprint(&to).await.ok().as_deref() == Some(entry.fingerprint.as_str()) {
                needs_copy = false;
            } else if !was_complete {
                // A stop during an older/non-atomic copy can leave partial
                // payload. Retain it separately, then retry the verified source.
                writable_parents(source, &payload, &entry.path).await?;
                let residue = vault.join(format!("copy-residue-{}", uuid::Uuid::new_v4()));
                create_private_directory(&residue).await?;
                secure_directory(&residue).await?;
                writable_parents(source, &residue, &entry.path).await?;
                rename_exclusive(&to, &residue.join(&entry.path)).await?;
                sync_tree(&residue).await?;
                sync(to.parent().unwrap()).await?;
                sync(vault).await?;
            } else {
                return Err(DaemonError::Rpc(
                    "Private recovery conflict; all copies retained".into(),
                ));
            }
        }
        if needs_copy {
            copy_entry(
                source,
                &payload,
                &entry.path,
                &entry.fingerprint,
                false,
                vault,
            )
            .await?;
        }
        if fingerprint(&to).await? != entry.fingerprint {
            return Err(DaemonError::Rpc(
                "Private preservation verification failed".into(),
            ));
        }
    }
    finish_directory_metadata(source, &payload, &all_paths).await?;
    sync_tree(&vault.join("files")).await?;
    let mut complete = load(vault).await?;
    complete.complete = true;
    write_manifest(vault, &complete).await?;
    Ok(())
}
async fn write_manifest(vault: &Path, m: &Manifest) -> Result<(), DaemonError> {
    use tokio::io::AsyncWriteExt;
    let temp = vault.join(format!("manifest-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let mut f = options.open(&temp).await?;
    f.write_all(&serde_json::to_vec(m)?).await?;
    f.sync_all().await?;
    fs::rename(temp, vault.join("manifest.json")).await?;
    sync(vault).await
}
async fn load(vault: &Path) -> Result<Manifest, DaemonError> {
    root(vault).await?;
    let p = vault.join("manifest.json");
    let meta = fs::symlink_metadata(&p).await?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.mode() & 0o077 != 0
        || meta.len() > 32 * 1024 * 1024
    {
        return Err(DaemonError::Rpc("Invalid private recovery manifest".into()));
    }
    let f = fs::symlink_metadata(vault.join("files")).await?;
    if !f.is_dir() || f.file_type().is_symlink() {
        return Err(DaemonError::Rpc("Invalid private payload root".into()));
    }
    let bytes = super::quarantine::filesystem_job(move || {
        super::cache_index::bounded_read(&p, 32 * 1024 * 1024)
    })
    .await?;
    let m: Manifest = serde_json::from_slice(&bytes)?;
    let unique = m
        .entries
        .iter()
        .map(|e| e.path.clone())
        .collect::<std::collections::HashSet<_>>();
    if unique.len() != m.entries.len()
        || m.entries
            .iter()
            .any(|e| e.path.ancestors().skip(1).any(|p| unique.contains(p)))
    {
        return Err(DaemonError::Rpc(
            "Overlapping private recovery paths".into(),
        ));
    }
    if m.entries.iter().any(|e| !relative(&e.path)) {
        return Err(DaemonError::Rpc("Invalid private recovery path".into()));
    }
    Ok(m)
}
/// Copies into a fresh staging checkout only. Backups remain privately retained
/// after publication; failures never consume the only remaining private bytes.
async fn restore_ignore_ancestors(
    stage: &Path,
    paths: &[PathBuf],
    snapshot: &super::snapshot::Snapshot,
) -> Result<(), DaemonError> {
    let tracked = super::reclaim::git(
        stage.to_str().unwrap(),
        &["ls-files", "-v", "-z"],
        &[],
        std::time::Duration::from_secs(60),
    )
    .await
    .map_err(DaemonError::Rpc)?;
    for name in tracked.split('\0').filter_map(|s| s.strip_prefix("S ")) {
        let path = Path::new(name);
        if path.file_name() != Some(std::ffi::OsStr::new(".gitignore"))
            || !snapshot.materialized.iter().any(|s| s == name)
            || !paths.iter().any(|p| p.starts_with(path.parent().unwrap()))
            || fs::symlink_metadata(stage.join(path)).await.is_ok()
        {
            continue;
        }
        // A legacy full checkout can adopt a sparse recipe that omits an
        // ancestor ignore file. Keep that original tracked file materialized
        // so private overlays stay ignored without changing its Git contents.
        parents(stage, path, true).await?;
        super::reclaim::git(
            stage.to_str().unwrap(),
            &[
                "--literal-pathspecs",
                "checkout-index",
                "--ignore-skip-worktree-bits",
                "--",
                name,
            ],
            &[],
            std::time::Duration::from_secs(60),
        )
        .await
        .map_err(DaemonError::Rpc)?;
        super::reclaim::git(
            stage.to_str().unwrap(),
            &[
                "--literal-pathspecs",
                "update-index",
                "--no-skip-worktree",
                "--",
                name,
            ],
            &[],
            std::time::Duration::from_secs(60),
        )
        .await
        .map_err(DaemonError::Rpc)?;
    }
    Ok(())
}
pub(crate) async fn restore(project: &str, slug: &str, stage: &Path) -> Result<(), DaemonError> {
    let active = super::snapshot::load(project, slug).await?;
    for r in super::quarantine::records(project).await? {
        if r.variant.slug != slug
            || !r
                .snapshot
                .as_ref()
                .is_some_and(|s| active.as_ref().is_some_and(|a| a.oid == s.oid))
        {
            continue;
        }
        let Some(vault) = r.private_path.as_ref().filter(|p| p.exists()) else {
            continue;
        };
        let m = load(vault).await?;
        if !m.complete {
            return Err(DaemonError::Rpc(
                "Private recovery backup is incomplete; retained for review".into(),
            ));
        }
        let all_paths = m.entries.iter().map(|e| e.path.clone()).collect::<Vec<_>>();
        restore_ignore_ancestors(stage, &all_paths, r.snapshot.as_ref().unwrap()).await?;
        // Validate tracked conflicts in bounded literal-path batches before
        // copying any private data. Git never receives file contents here.
        for paths in all_paths.chunks(16) {
            let mut args = vec!["--literal-pathspecs", "ls-files", "-z", "--"];
            args.extend(paths.iter().map(|p| p.to_str().unwrap()));
            if !super::reclaim::git(
                stage.to_str().unwrap(),
                &args,
                &[],
                std::time::Duration::from_secs(60),
            )
            .await
            .map_err(DaemonError::Rpc)?
            .is_empty()
            {
                return Err(DaemonError::Rpc(
                    "Private restoration conflicts with tracked files".into(),
                ));
            }
        }
        secure_directory(stage).await?;
        for e in m.entries {
            let existing = stage.join(&e.path);
            if existing.exists()
                && fingerprint(&existing).await? != e.fingerprint
                && !super::reclaim::identical_to_project(
                    project,
                    stage.to_str().unwrap(),
                    e.path.to_str().unwrap(),
                )
                .await
            {
                return Err(DaemonError::Rpc(
                    "Private recovery destination conflict".into(),
                ));
            }
            copy_entry(
                &vault.join("files"),
                stage,
                &e.path,
                &e.fingerprint,
                true,
                vault,
            )
            .await?;
        }
        // Ignore configuration can itself be ignored (for example a private
        // .gitignore containing '*'). Validate after the verified overlay so
        // Git sees those rules. The staging checkout is still unpublished and
        // no Git add/snapshot command has run since copying private bytes.
        for paths in all_paths.chunks(16) {
            let mut args = vec![
                "--literal-pathspecs",
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
            ];
            args.extend(paths.iter().map(|p| p.to_str().unwrap()));
            if !super::reclaim::git(
                stage.to_str().unwrap(),
                &args,
                &[],
                std::time::Duration::from_secs(120),
            )
            .await
            .map_err(DaemonError::Rpc)?
            .is_empty()
            {
                return Err(DaemonError::Rpc(
                    "Private files are no longer ignored by the restored branch; backup retained"
                        .into(),
                ));
            }
        }
        finish_directory_metadata(&vault.join("files"), stage, &all_paths).await?;
    }
    Ok(())
}
/// Copy privately, sync and persist identity before one exclusive publication.
/// An interrupted copy never leaves a partially rebuilt visible cache. If the
/// rename completed before the caller saved its ready flag, the durable inode
/// proves publication; subsequent visible edits are left exactly as they are.
pub(crate) async fn publish_cache(
    source: &Path,
    destination: &Path,
    vault: &Path,
    paths: &[PathBuf],
) -> Result<(), DaemonError> {
    prepare(source, vault, paths).await?;
    let mut manifest = load(vault).await?;
    let stage = vault.join("publish");
    if let Some(publication) = &manifest.publication {
        if let Ok(m) = fs::symlink_metadata(destination).await {
            if m.is_dir()
                && !m.file_type().is_symlink()
                && m.dev() == publication.device
                && m.ino() == publication.inode
            {
                return Ok(());
            }
            return Err(DaemonError::Rpc(
                "Private cache destination conflict; copies retained".into(),
            ));
        }
        let m = fs::symlink_metadata(&stage).await?;
        if !m.is_dir()
            || m.file_type().is_symlink()
            || m.dev() != publication.device
            || m.ino() != publication.inode
            || fingerprint(&stage).await? != publication.fingerprint
        {
            return Err(DaemonError::Rpc(
                "Private cache publication changed; copies retained".into(),
            ));
        }
    } else {
        if fs::symlink_metadata(destination).await.is_ok() {
            return Err(DaemonError::Rpc(
                "Private cache destination conflict; copies retained".into(),
            ));
        }
        if fs::symlink_metadata(&stage).await.is_ok() {
            // This private staging path was never published. Preserve any
            // interrupted residue instead of accepting a partial file as proof.
            fs::rename(
                &stage,
                vault.join(format!("publish-residue-{}", uuid::Uuid::new_v4())),
            )
            .await?;
            sync(vault).await?;
        }
        copy_retained(&vault.join("files"), &stage, paths).await?;
        sync_tree(&stage).await?;
        let m = fs::symlink_metadata(&stage).await?;
        manifest.publication = Some(Publication {
            device: m.dev(),
            inode: m.ino(),
            fingerprint: fingerprint(&stage).await?,
        });
        write_manifest(vault, &manifest).await?;
    }
    rename_exclusive(&stage, destination).await?;
    sync(vault).await?;
    sync(destination.parent().unwrap()).await
}
async fn rename_exclusive(source: &Path, destination: &Path) -> Result<(), DaemonError> {
    let source = source.to_owned();
    let destination = destination.to_owned();
    super::quarantine::filesystem_job(move || {
        use std::os::unix::ffi::OsStrExt;
        let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
        let destination = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
        #[cfg(target_os = "macos")]
        let result = unsafe {
            unsafe extern "C" {
                fn renamex_np(
                    a: *const libc::c_char,
                    b: *const libc::c_char,
                    flags: u32,
                ) -> libc::c_int;
            }
            // stdio.h: RENAME_EXCL; never replace a writer-created directory.
            renamex_np(source.as_ptr(), destination.as_ptr(), 0x4)
        };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            ) as libc::c_int
        };
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let result = -1;
        if result != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    })
    .await
}
pub(crate) async fn copy_retained(
    source: &Path,
    destination: &Path,
    paths: &[PathBuf],
) -> Result<(), DaemonError> {
    // The cache root was atomically renamed away. Never merge into a directory
    // recreated by an external writer, even if its current files look harmless.
    fs::create_dir(destination).await?;
    secure_directory(destination).await?;
    for p in paths {
        let digest = fingerprint(&source.join(p)).await?;
        copy_entry(source, destination, p, &digest, false, destination).await?;
    }
    finish_directory_metadata(source, destination, paths).await
}

async fn copy_entry(
    source: &Path,
    dest: &Path,
    path: &Path,
    digest: &str,
    fresh_stage: bool,
    vault: &Path,
) -> Result<(), DaemonError> {
    if !relative(path) {
        return Err(DaemonError::Rpc("Invalid private recovery path".into()));
    }
    root(vault).await?;
    writable_parents(source, dest, path).await?;
    let from = source.join(path);
    let to = dest.join(path);
    if fingerprint(&from).await? != digest {
        return Err(DaemonError::Rpc(
            "Private backup changed; retained for review".into(),
        ));
    }
    let replace = if fs::symlink_metadata(&to).await.is_ok() {
        let existing = fingerprint(&to).await?;
        if existing == digest {
            return Ok(());
        }
        if !fresh_stage || !fs::symlink_metadata(&to).await?.is_file() {
            return Err(DaemonError::Rpc(
                "Private recovery destination conflict".into(),
            ));
        }
        Some(existing)
    } else {
        None
    };
    // Copy temporaries must never live in a Git checkout: a later snapshot
    // must not accidentally capture private bytes after an interrupted restore.
    let container = vault.join(format!("copy-{}", uuid::Uuid::new_v4()));
    create_private_directory(&container).await?;
    secure_directory(&container).await?;
    use tokio::io::AsyncWriteExt;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let mut metadata = options.open(container.join("entry.json")).await?;
    metadata
        .write_all(&serde_json::to_vec(&Entry {
            path: path.to_owned(),
            fingerprint: digest.into(),
        })?)
        .await?;
    metadata.sync_all().await?;
    sync(&container).await?;
    let temporary = container.join("payload");
    let result = tokio::process::Command::new("nice")
        .args(["-n", "10", "/bin/cp"])
        .args(if cfg!(target_os = "macos") {
            vec!["-c", "-pRP"]
        } else {
            vec!["--preserve=all", "-RP"]
        })
        .arg(&from)
        .arg(&temporary)
        .kill_on_drop(true)
        .output()
        .await?;
    if !result.status.success()
        || fingerprint(&temporary).await? != digest
        || fingerprint(&from).await? != digest
    {
        return Err(DaemonError::Rpc(
            "Private recovery copy could not be verified; copies retained".into(),
        ));
    }
    sync_tree(&temporary).await?;
    if let Some(previous) = replace {
        if fingerprint(&to).await? != previous {
            return Err(DaemonError::Rpc(
                "Private recovery destination changed; copies retained".into(),
            ));
        }
        // Only an unpublished staging checkout may replace a provisioned file.
        fs::rename(&temporary, &to).await?;
    } else {
        rename_exclusive(&temporary, &to).await?;
    }
    sync(to.parent().unwrap()).await?;
    fs::remove_file(container.join("entry.json")).await?;
    fs::remove_dir(&container).await?;
    sync(vault).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn macos_acl_only_change_refuses_completed_backup_retry_and_keeps_original() {
        use super::super::storage_metadata::native_acl;
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let vault = t.path().join("vault");
        std::fs::create_dir(&source).unwrap();
        let file = source.join("secret");
        std::fs::write(&file, "PRIVATE_FIXTURE").unwrap();
        prepare(&source, &vault, &["secret".into()]).await.unwrap();
        assert!(load(&vault).await.unwrap().complete);
        let meta = std::fs::symlink_metadata(&file).unwrap();
        let fields = (meta.mode(), meta.uid(), meta.gid());
        let attrs = attributes(&file).unwrap();
        let original_acl = native_acl(&file).unwrap();
        let before = fingerprint(&file).await.unwrap();
        assert!(
            std::process::Command::new("/bin/chmod")
                .args(["+a", "user:nobody deny read"])
                .arg(&file)
                .status()
                .unwrap()
                .success()
        );
        let meta = std::fs::symlink_metadata(&file).unwrap();
        assert_eq!((meta.mode(), meta.uid(), meta.gid()), fields);
        assert_eq!(attributes(&file).unwrap(), attrs);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "PRIVATE_FIXTURE");
        let restricted = native_acl(&file).unwrap();
        assert_ne!(restricted, original_acl);
        assert_ne!(fingerprint(&file).await.unwrap(), before);
        // Model restart after a completed backup but before original removal.
        assert!(prepare(&source, &vault, &["secret".into()]).await.is_err());
        assert!(file.exists());
        assert_eq!(native_acl(&file).unwrap(), restricted);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "PRIVATE_FIXTURE");
        assert_eq!(
            native_acl(&vault.join("files/secret")).unwrap(),
            original_acl
        );
        assert!(!load(&vault).await.unwrap().complete);
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn macos_backup_acl_only_change_is_not_reused() {
        use super::super::storage_metadata::native_acl;
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let vault = t.path().join("vault");
        std::fs::create_dir(&source).unwrap();
        let file = source.join("secret");
        std::fs::write(&file, "PRIVATE_FIXTURE").unwrap();
        let paths = ["secret".into()];
        prepare(&source, &vault, &paths).await.unwrap();
        let original_acl = native_acl(&file).unwrap();
        let backup = vault.join("files/secret");
        assert!(
            std::process::Command::new("/bin/chmod")
                .args(["+a", "user:nobody deny read"])
                .arg(&backup)
                .status()
                .unwrap()
                .success()
        );
        let changed_acl = native_acl(&backup).unwrap();
        assert_ne!(changed_acl, original_acl);
        assert!(prepare(&source, &vault, &paths).await.is_err());
        assert!(file.exists());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "PRIVATE_FIXTURE");
        assert_eq!(native_acl(&file).unwrap(), original_acl);
        assert_eq!(native_acl(&backup).unwrap(), changed_acl);
        assert!(!load(&vault).await.unwrap().complete);
    }
    #[tokio::test]
    async fn private_attributes_survive_backups_and_reconstructed_cache_ancestors() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let vault = t.path().join("vault");
        let dest = t.path().join("destination");
        std::fs::create_dir_all(source.join("package")).unwrap();
        std::fs::write(source.join("package/notes.txt"), "private notes").unwrap();
        for rel in ["", "package", "package/notes.txt"] {
            set_attribute(
                &source.join(rel),
                b"user.falcondeck.fixture",
                Some(rel.as_bytes()),
            )
            .unwrap();
        }
        let paths = ["package/notes.txt".into()];
        prepare(&source, &vault, &paths).await.unwrap();
        copy_retained(&vault.join("files"), &dest, &paths)
            .await
            .unwrap();
        for rel in ["", "package", "package/notes.txt"] {
            let expected = attributes(&source.join(rel)).unwrap();
            assert_eq!(
                attributes(&vault.join("files").join(rel)).unwrap(),
                expected
            );
            assert_eq!(attributes(&dest.join(rel)).unwrap(), expected);
        }
        // Equal contents/modes are insufficient when the private metadata changed.
        set_attribute(
            &source.join("package/notes.txt"),
            b"user.falcondeck.fixture",
            Some(b"late metadata"),
        )
        .unwrap();
        assert!(prepare(&source, &vault, &paths).await.is_err());
        assert_eq!(
            attributes(&vault.join("files/package/notes.txt")).unwrap()
                [b"user.falcondeck.fixture".as_slice()],
            b"package/notes.txt"
        );
    }
    #[test]
    fn metadata_copy_removes_extra_attributes_without_copying_directory_contents() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let dest = t.path().join("dest");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(
            source.join("not-retained"),
            "do not copy by metadata operation",
        )
        .unwrap();
        set_attribute(&source, b"user.falcondeck.source", Some(b"source metadata")).unwrap();
        set_attribute(
            &dest,
            b"user.falcondeck.extra",
            Some(b"remove inherited metadata"),
        )
        .unwrap();
        copy_attributes(&source, &dest).unwrap();
        assert_eq!(attributes(&source).unwrap(), attributes(&dest).unwrap());
        assert!(!dest.join("not-retained").exists());
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_private_ancestor_access_and_default_acls_survive_restore() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let vault = t.path().join("vault");
        let dest = t.path().join("dest");
        std::fs::create_dir_all(source.join("package")).unwrap();
        std::fs::write(source.join("package/notes"), "private notes").unwrap();
        // Linux POSIX ACL xattr v2: named uid 100000 has no access, even
        // though group/mask permit reading. Preserve both access and inheritance.
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, perm, id) in [
            (1u16, 7u16, u32::MAX),
            (2, 0, 100000),
            (4, 5, u32::MAX),
            (16, 5, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            acl.extend(tag.to_le_bytes());
            acl.extend(perm.to_le_bytes());
            acl.extend(id.to_le_bytes());
        }
        for name in [
            b"system.posix_acl_access".as_slice(),
            b"system.posix_acl_default",
        ] {
            set_attribute(&source.join("package"), name, Some(&acl)).unwrap();
        }
        let paths = ["package/notes".into()];
        prepare(&source, &vault, &paths).await.unwrap();
        copy_retained(&vault.join("files"), &dest, &paths)
            .await
            .unwrap();
        assert_eq!(
            attributes(&source.join("package")).unwrap(),
            attributes(&dest.join("package")).unwrap()
        );
    }
    #[tokio::test]
    async fn private_payload_retry_preserves_partial_copies_and_rebuilds_verified_data() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("secret"), "verified source").unwrap();
        let vault = t.path().join("vault");
        prepare(&source, &vault, &["secret".into()]).await.unwrap();
        let mut manifest = load(&vault).await.unwrap();
        manifest.complete = false;
        write_manifest(&vault, &manifest).await.unwrap();
        std::fs::write(vault.join("files/secret"), "interrupted partial copy").unwrap();
        // Also model a new atomic-copy temporary left by a stop. It is private,
        // outside Git, and never accepted as the final entry on a later retry.
        let old = vault.join("copy-interrupted");
        create_private_directory(&old).await.unwrap();
        std::fs::write(old.join("payload"), "partial temporary").unwrap();
        prepare(&source, &vault, &["secret".into()]).await.unwrap();
        assert!(load(&vault).await.unwrap().complete);
        assert_eq!(
            std::fs::read_to_string(vault.join("files/secret")).unwrap(),
            "verified source"
        );
        let residue = std::fs::read_dir(&vault)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("copy-residue-")
            })
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(residue.join("secret")).unwrap(),
            "interrupted partial copy"
        );
        assert_eq!(
            std::fs::read_to_string(old.join("payload")).unwrap(),
            "partial temporary"
        );
        assert!(std::fs::read_dir(vault.join("files")).unwrap().all(|e| {
            !e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("copy-")
        }));
    }
    #[tokio::test]
    async fn private_vault_creation_can_resume_before_acl_hardening_under_normal_umask() {
        let t = tempfile::tempdir().unwrap();
        let vault = t.path().join("vault");
        // Exactly the boundary between mkdir and hardening in root(). Its
        // permissions must already be safe and accepted by the reopening path.
        create_private_directory(&vault).await.unwrap();
        assert_eq!(std::fs::metadata(&vault).unwrap().mode() & 0o777, 0o700);
        let source = t.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("secret"), "source").unwrap();
        prepare(&source, &vault, &["secret".into()]).await.unwrap();
        assert!(load(&vault).await.unwrap().complete);
    }
    #[tokio::test]
    async fn retry_expands_private_plan_with_readonly_parents_and_preserves_modes() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let package = source.join("package");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("first"), "first private bytes").unwrap();
        std::fs::write(package.join("second"), "second private bytes").unwrap();
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&package, std::fs::Permissions::from_mode(0o500)).unwrap();
        let vault = t.path().join("vault");
        prepare(&source, &vault, &["package/first".into()])
            .await
            .unwrap();
        prepare(
            &source,
            &vault,
            &["package/first".into(), "package/second".into()],
        )
        .await
        .unwrap();
        let m = load(&vault).await.unwrap();
        assert!(m.complete);
        assert_eq!(m.entries.len(), 2);
        assert_eq!(
            std::fs::metadata(vault.join("files/package"))
                .unwrap()
                .mode()
                & 0o777,
            0o500
        );
        let dest = t.path().join("restored");
        copy_retained(
            &vault.join("files"),
            &dest,
            &["package/first".into(), "package/second".into()],
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("package/first")).unwrap(),
            "first private bytes"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("package/second")).unwrap(),
            "second private bytes"
        );
        assert_eq!(std::fs::metadata(&dest).unwrap().mode() & 0o777, 0o700);
        assert_eq!(
            std::fs::metadata(dest.join("package")).unwrap().mode() & 0o777,
            0o500
        );
        for root in [&source, &dest, &vault.join("files")] {
            std::fs::set_permissions(root.join("package"), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
    }
    #[tokio::test]
    async fn interrupted_private_cache_staging_resumes_and_published_edits_are_not_replayed() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let dest = t.path().join("cache");
        let vault = t.path().join("vault");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("edit"), "authored edit").unwrap();
        std::fs::write(source.join("notes"), "authored notes").unwrap();
        let paths = vec!["edit".into(), "notes".into()];
        prepare(&source, &vault, &paths).await.unwrap();
        // Simulate a stop while the private staging copy is incomplete.
        std::fs::create_dir(vault.join("publish")).unwrap();
        std::fs::write(vault.join("publish/edit"), "partial").unwrap();
        publish_cache(&source, &dest, &vault, &paths).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("edit")).unwrap(),
            "authored edit"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("notes")).unwrap(),
            "authored notes"
        );
        assert!(std::fs::read_dir(&vault).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("publish-residue-")
        }));
        // Stop after publication but before the caller's ready flag was saved.
        std::fs::write(dest.join("edit"), "new visible edit").unwrap();
        std::fs::remove_file(dest.join("notes")).unwrap();
        publish_cache(&source, &dest, &vault, &paths).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("edit")).unwrap(),
            "new visible edit"
        );
        assert!(!dest.join("notes").exists());
    }
    #[tokio::test]
    async fn private_cache_publication_resumes_before_rename_and_never_replaces_a_writer() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let dest = t.path().join("cache");
        let vault = t.path().join("vault");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("edit"), "original").unwrap();
        let paths = vec!["edit".into()];
        prepare(&source, &vault, &paths).await.unwrap();
        copy_retained(&vault.join("files"), &vault.join("publish"), &paths)
            .await
            .unwrap();
        let stage = vault.join("publish");
        let m = std::fs::metadata(&stage).unwrap();
        let mut manifest = load(&vault).await.unwrap();
        manifest.publication = Some(Publication {
            device: m.dev(),
            inode: m.ino(),
            fingerprint: fingerprint(&stage).await.unwrap(),
        });
        write_manifest(&vault, &manifest).await.unwrap();
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("writer"), "external").unwrap();
        assert!(publish_cache(&source, &dest, &vault, &paths).await.is_err());
        assert!(rename_exclusive(&stage, &dest).await.is_err());
        assert_eq!(
            std::fs::read_to_string(dest.join("writer")).unwrap(),
            "external"
        );
        std::fs::remove_file(dest.join("writer")).unwrap();
        std::fs::remove_dir(&dest).unwrap();
        publish_cache(&source, &dest, &vault, &paths).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("edit")).unwrap(),
            "original"
        );
    }
    #[tokio::test]
    async fn private_cache_copy_refuses_recreated_destination_without_modifying_it() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let dest = t.path().join("destination");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(source.join("notes"), "preserved").unwrap();
        std::fs::write(dest.join("notes"), "external writer").unwrap();
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o750)).unwrap();
        assert!(
            copy_retained(&source, &dest, &["notes".into()])
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("notes")).unwrap(),
            "external writer"
        );
        assert_eq!(std::fs::metadata(&dest).unwrap().mode() & 0o777, 0o750);
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn private_vault_reopen_removes_inherited_acl_before_writing_a_manifest() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("secret"), "fixture private value").unwrap();
        let vault = t.path().join("vault");
        root(&vault).await.unwrap();
        let status = std::process::Command::new("/bin/chmod")
            .args([
                "+a",
                "everyone allow read,execute,file_inherit,directory_inherit",
            ])
            .arg(&vault)
            .status()
            .unwrap();
        assert!(status.success());
        let acl = std::process::Command::new("/bin/ls")
            .arg("-lde")
            .arg(&vault)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&acl.stdout).contains("everyone"));
        prepare(&source, &vault, &["secret".into()]).await.unwrap();
        let acl = std::process::Command::new("/bin/ls")
            .arg("-lde")
            .arg(&vault)
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&acl.stdout).contains("everyone"));
        let acl = std::process::Command::new("/bin/ls")
            .arg("-le")
            .arg(vault.join("manifest.json"))
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&acl.stdout).contains("everyone"));
        assert_eq!(
            std::fs::metadata(vault.join("manifest.json"))
                .unwrap()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[tokio::test]
    async fn private_backup_conflict_keeps_both_versions_and_source() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("private"), "original").unwrap();
        let vault = t.path().join("vault");
        prepare(&source, &vault, &["private".into()]).await.unwrap();
        std::fs::write(source.join("private"), "later edit").unwrap();
        assert!(prepare(&source, &vault, &["private".into()]).await.is_err());
        assert_eq!(
            std::fs::read_to_string(source.join("private")).unwrap(),
            "later edit"
        );
        assert_eq!(
            std::fs::read_to_string(vault.join("files/private")).unwrap(),
            "original"
        );
        assert!(!load(&vault).await.unwrap().complete);
    }
}
