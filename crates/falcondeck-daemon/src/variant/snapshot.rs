//! Manual dirty-checkout snapshots. Branch refs and the real index are never written.
use super::run_git;
use crate::error::DaemonError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::{fs, process::Command};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Snapshot {
    pub oid: String,
    pub tree: String,
    pub head: String,
    pub reference: String,
    pub materialized: Vec<String>,
    pub pending: bool,
}
async fn common(path: &str) -> Result<PathBuf, DaemonError> {
    Ok(PathBuf::from(
        run_git(
            path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?
        .trim(),
    ))
}
async fn metadata_path(project: &str, slug: &str) -> Result<PathBuf, DaemonError> {
    if slug.is_empty()
        || !slug
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(DaemonError::BadRequest("Invalid snapshot slug".into()));
    }
    Ok(common(project)
        .await?
        .join("falcondeck-variants")
        .join(format!("{slug}.snapshot.json")))
}
async fn command(path: &str, args: &[&str], index: Option<&Path>) -> Result<String, DaemonError> {
    let mut cmd = Command::new("nice");
    cmd.args([
        "-n",
        "10",
        "git",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-C",
        path,
    ])
    .args(args)
    .env("GIT_OPTIONAL_LOCKS", "0")
    .kill_on_drop(true);
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(600), cmd.output())
        .await
        .map_err(|_| DaemonError::Rpc("Snapshot Git operation timed out".into()))??;
    if !out.status.success() {
        return Err(DaemonError::Rpc(
            String::from_utf8_lossy(&out.stderr).trim().into(),
        ));
    }
    String::from_utf8(out.stdout)
        .map_err(|_| DaemonError::Rpc("Snapshot requires UTF-8 paths; checkout retained".into()))
}
async fn capture_tree(path: &str) -> Result<(String, Vec<String>), DaemonError> {
    let tracked = command(path, &["ls-files", "--stage", "-z"], None).await?;
    if tracked.split('\0').any(|s| s.starts_with("160000 ")) {
        return Err(DaemonError::Rpc(
            "Submodule checkouts require manual preservation before reclamation".into(),
        ));
    }
    let index_path = run_git(
        path,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )
    .await?;
    let dir = common(path)
        .await?
        .join("falcondeck-variants")
        .join(format!(".snapshot-index-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).await?;
    let index = dir.join("index");
    let result = async {
        fs::copy(index_path.trim(), &index).await?;
        // Add explicit paths only: absent sparse entries remain in the copied
        // index, while ordinary tracked deletions and outside-recipe additions
        // are captured. NUL pathspecs preserve names containing whitespace.
        let entries = command(path, &["ls-files", "-v", "-z"], None).await?;
        let mut paths = std::collections::BTreeSet::new();
        for entry in entries.split('\0').filter(|s| !s.is_empty()) {
            let name = &entry[2..];
            if !entry.starts_with("S ")
                || fs::symlink_metadata(Path::new(path).join(name))
                    .await
                    .is_ok()
            {
                paths.insert(name.to_owned());
            }
        }
        let others = command(
            path,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            None,
        )
        .await?;
        paths.extend(
            others
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        );
        if !paths.is_empty() {
            let pathspec = dir.join("paths");
            let mut bytes = Vec::new();
            let mut present = Vec::new();
            for name in paths {
                bytes.extend(name.as_bytes());
                bytes.push(0);
                if fs::symlink_metadata(Path::new(path).join(&name))
                    .await
                    .is_ok()
                {
                    present.extend(name.as_bytes());
                    present.push(0);
                }
            }
            fs::write(&pathspec, bytes).await?;
            let argument = format!("--pathspec-from-file={}", pathspec.display());
            command(
                path,
                &["add", "-A", "--sparse", &argument, "--pathspec-file-nul"],
                Some(&index),
            )
            .await?;
            if !present.is_empty() {
                fs::write(&pathspec, present).await?;
                command(
                    path,
                    &[
                        "add",
                        "--renormalize",
                        "--sparse",
                        &argument,
                        "--pathspec-file-nul",
                    ],
                    Some(&index),
                )
                .await?;
            }
        }
        let tree = command(path, &["write-tree"], Some(&index))
            .await?
            .trim()
            .to_string();
        let files = command(path, &["ls-files", "-z"], Some(&index)).await?;
        let mut materialized = Vec::new();
        for name in files.split('\0').filter(|s| !s.is_empty()) {
            if fs::symlink_metadata(Path::new(path).join(name))
                .await
                .is_ok()
            {
                materialized.push(name.to_string());
            }
        }
        // Git clean filters and line-ending conversion can be lossy. Refuse
        // reclamation unless regular-file blobs contain the exact disk bytes.
        let stages = command(path, &["ls-files", "--stage", "-z"], Some(&index)).await?;
        let blobs = stages
            .split('\0')
            .filter_map(|entry| {
                let (meta, name) = entry.split_once('\t')?;
                let mut fields = meta.split_whitespace();
                let mode = fields.next()?;
                let oid = fields.next()?;
                (mode.starts_with("100") && materialized.iter().any(|p| p == name))
                    .then_some((name, oid))
            })
            .collect::<Vec<_>>();
        for chunk in blobs.chunks(100) {
            let mut args = vec!["hash-object", "--no-filters", "--"];
            args.extend(chunk.iter().map(|(name, _)| *name));
            let hashes = command(path, &args, None).await?;
            if hashes.lines().collect::<Vec<_>>()
                != chunk.iter().map(|(_, oid)| *oid).collect::<Vec<_>>()
            {
                return Err(DaemonError::Rpc(
                    "Git filters or line endings transform working bytes; checkout retained".into(),
                ));
            }
        }
        materialized.sort();
        Ok::<_, DaemonError>((tree, materialized))
    }
    .await;
    let _ = fs::remove_dir_all(dir).await;
    result
}
pub(crate) async fn blockers(project: &str, path: &str) -> Result<Vec<String>, DaemonError> {
    super::reclaim::status_blockers_mode(project, path, true)
        .await
        .map_err(DaemonError::Rpc)
}
pub(crate) async fn create(path: &str, slug: &str) -> Result<Snapshot, DaemonError> {
    let _ = metadata_path(path, slug).await?;
    let blockers = super::reclaim::hidden_or_in_progress(path)
        .await
        .map_err(DaemonError::Rpc)?;
    if !blockers.is_empty() {
        return Err(DaemonError::Rpc(blockers.join("; ")));
    }
    let head = command(path, &["rev-parse", "HEAD"], None)
        .await?
        .trim()
        .to_string();
    let (tree, materialized) = capture_tree(path).await?;
    let reference = format!("refs/falcondeck/snapshots/{slug}");
    let old = command(path, &["rev-parse", "--verify", &reference], None)
        .await
        .ok()
        .map(|s| s.trim().to_string());
    let mut args = vec![
        "-c",
        "user.name=FalconDeck",
        "-c",
        "user.email=snapshots@falcondeck.local",
        "commit-tree",
        &tree,
        "-p",
        &head,
    ];
    if let Some(old) = old.as_ref().filter(|s| *s != &head) {
        args.extend(["-p", old]);
    }
    args.extend(["-m", "FalconDeck manual workspace snapshot"]);
    let oid = command(path, &args, None).await?.trim().to_string();
    let zero = "0".repeat(head.len());
    command(
        path,
        &[
            "update-ref",
            &reference,
            &oid,
            old.as_deref().unwrap_or(&zero),
        ],
        None,
    )
    .await?;
    let snapshot = Snapshot {
        oid,
        tree,
        head,
        reference,
        materialized,
        pending: true,
    };
    verify(path, &snapshot).await?;
    Ok(snapshot)
}
pub(crate) async fn verify(path: &str, snapshot: &Snapshot) -> Result<(), DaemonError> {
    if command(path, &["rev-parse", "HEAD"], None).await?.trim() != snapshot.head
        || command(path, &["rev-parse", "--verify", &snapshot.reference], None)
            .await?
            .trim()
            != snapshot.oid
    {
        return Err(DaemonError::Rpc(
            "Snapshot identity changed; checkout retained".into(),
        ));
    }
    let (tree, files) = capture_tree(path).await?;
    if tree != snapshot.tree || files != snapshot.materialized {
        return Err(DaemonError::Rpc(
            "Snapshot verification failed: working tree changed; nothing removed".into(),
        ));
    }
    Ok(())
}
async fn write(project: &str, slug: &str, snapshot: &Snapshot) -> Result<(), DaemonError> {
    let path = metadata_path(project, slug).await?;
    fs::create_dir_all(path.parent().unwrap()).await?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, serde_json::to_vec(snapshot)?).await?;
    fs::rename(temp, path).await?;
    Ok(())
}
pub(crate) async fn load(project: &str, slug: &str) -> Result<Option<Snapshot>, DaemonError> {
    match fs::read(metadata_path(project, slug).await?).await {
        Ok(b) => Ok(Some(serde_json::from_slice(&b)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub(crate) async fn save_pending(
    project: &str,
    slug: &str,
    snapshot: &Snapshot,
) -> Result<(), DaemonError> {
    write(project, slug, snapshot).await
}
pub(crate) async fn clear_pending(project: &str, slug: &str) -> Result<(), DaemonError> {
    if let Some(mut snapshot) = load(project, slug).await? {
        snapshot.pending = false;
        write(project, slug, &snapshot).await?;
    }
    Ok(())
}
async fn marker(path: &str) -> Result<PathBuf, DaemonError> {
    Ok(PathBuf::from(
        run_git(path, &["rev-parse", "--absolute-git-dir"])
            .await?
            .trim(),
    )
    .join("falcondeck-snapshot-restored"))
}
pub(crate) async fn apply_pending(
    project: &str,
    slug: &str,
    path: &str,
) -> Result<bool, DaemonError> {
    let Some(snapshot) = load(project, slug).await?.filter(|s| s.pending) else {
        return Ok(false);
    };
    if command(path, &["rev-parse", "HEAD"], None).await?.trim() != snapshot.head {
        return Err(DaemonError::Rpc(
            "Snapshot branch tip changed; restore retained for review".into(),
        ));
    }
    if command(
        path,
        &["rev-parse", &format!("{}^{{tree}}", snapshot.oid)],
        None,
    )
    .await?
    .trim()
        != snapshot.tree
    {
        return Err(DaemonError::Rpc(
            "Snapshot tree is unavailable; restore aborted".into(),
        ));
    }
    let baseline_index = command(
        path,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        None,
    )
    .await?;
    let baseline = fs::read(baseline_index.trim()).await?;
    command(path, &["read-tree", "--reset", "-u", &snapshot.oid], None).await?;
    // Explicit materialization retains non-ignored additions outside a sparse
    // recipe without materializing the recipe's unchanged excluded data.
    for chunk in snapshot.materialized.chunks(100) {
        let mut args = vec![
            "checkout-index",
            "--force",
            "--ignore-skip-worktree-bits",
            "--",
        ];
        args.extend(chunk.iter().map(String::as_str));
        command(path, &args, None).await?;
    }
    // Reuse the provisioned branch index byte-for-byte, including sparse
    // skip-worktree bits. Saved changes return as working-tree changes.
    let temp = PathBuf::from(baseline_index.trim())
        .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, baseline).await?;
    fs::rename(temp, baseline_index.trim()).await?;
    verify(path, &snapshot).await?;
    fs::write(marker(path).await?, serde_json::to_vec(&snapshot)?).await?;
    Ok(true)
}
pub(crate) async fn restored_marker(path: &str) -> Result<Option<Snapshot>, DaemonError> {
    match fs::read(marker(path).await?).await {
        Ok(b) => Ok(Some(serde_json::from_slice(&b)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub(crate) async fn finish_restore(
    project: &str,
    slug: &str,
    path: &str,
) -> Result<(), DaemonError> {
    if let Some(saved) = load(project, slug).await?.filter(|s| s.pending) {
        let restored = restored_marker(path)
            .await?
            .ok_or_else(|| DaemonError::Rpc("Snapshot restore is incomplete".into()))?;
        if restored.oid != saved.oid {
            return Err(DaemonError::Rpc("Snapshot restore marker mismatch".into()));
        }
        clear_pending(project, slug).await?;
    }
    Ok(())
}
pub(crate) async fn known_staging(path: &str) -> bool {
    let Ok(Some(snapshot)) = restored_marker(path).await else {
        return false;
    };
    verify(path, &snapshot).await.is_ok()
}
pub(crate) async fn approved_empty_checkout(path: &str) -> bool {
    let Ok(Some(snapshot)) = restored_marker(path).await else {
        return false;
    };
    if command(path, &["rev-parse", "HEAD"], None)
        .await
        .is_ok_and(|s| s.trim() == snapshot.head)
    {
        // Only a snapshot which intentionally had no materialized HEAD files
        // may excuse an empty checkout. A marker from an ordinary restore must
        // not mask a later incomplete checkout or accidental mass deletion.
        let Ok(head_files) =
            command(path, &["ls-tree", "-r", "--name-only", "-z", "HEAD"], None).await
        else {
            return false;
        };
        if head_files
            .split('\0')
            .filter(|name| !name.is_empty())
            .any(|name| snapshot.materialized.iter().any(|saved| saved == name))
        {
            return false;
        }
        let Ok(index) = command(
            path,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            None,
        )
        .await
        else {
            return false;
        };
        return fs::metadata(index.trim())
            .await
            .is_ok_and(|m| m.len() >= 12)
            && command(path, &["ls-files", "--stage"], None).await.is_ok();
    }
    false
}
