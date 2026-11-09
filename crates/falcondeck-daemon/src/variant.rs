//! Isolated checkouts ("variants") backing individual threads.
//!
//! A variant is a private checkout of a workspace on its own branch, created
//! under `~/.falcondeck/variants/<project>/<slug>/` on the machine that owns
//! the workspace — so remote hosts get isolation without any extra plumbing.
//!
//! Variants use Git worktrees with optional per-project sparse checkout and
//! copy-on-write dependency provisioning. Other ignored build state is omitted;
//! only a small environment-file allowlist is copied by default.

use std::path::{Path, PathBuf};

use falcondeck_core::{ThreadVariant, ThreadVariantKind};
use tokio::{fs, process::Command};
use uuid::Uuid;

use crate::error::DaemonError;

mod reclaim;
pub(crate) mod quarantine;
pub(crate) mod cache;
pub(crate) mod snapshot;
mod setup;
#[cfg(test)]
pub(crate) use reclaim::test_no_docker_mounts;
pub use reclaim::{Reclaim, reclaim_if_safe, restore};
pub(crate) use reclaim::{assess_for_snapshot,finish_snapshot_reclaim,assess, finish_reclaim, process_clear, hidden_or_in_progress};
pub(crate) use setup::hint as sparse_hint;

/// Untracked files carried into a worktree-backed variant.
const UNTRACKED_ALLOWLIST: &[&str] = &[".env*", ".envrc", "*.local.*"];

/// Branch prefix for variant checkouts. Slugs are unique per project, so
/// prefixed names never collide and no branch-exclusivity bookkeeping is
/// needed.
const BRANCH_PREFIX: &str = "falcondeck/";

/// Generates the slug identifying a new variant. Short and unique within the
/// project; also the branch suffix and the directory name.
pub fn new_slug() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// Resolve Git pointer paths without requiring their old target to still exist.
pub(crate) fn git_pointer_path(base: &Path, value: &str) -> PathBuf {
    let value=Path::new(value);let absolute=if value.is_absolute(){value.to_owned()}else{base.join(value)};
    let mut result=PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir=>{},
            std::path::Component::ParentDir=>{result.pop();},
            component=>result.push(component.as_os_str()),
        }
    }
    result
}
/// Bounded Git pointer reads for cheap per-filesystem capacity reporting.
pub(crate) async fn git_storage_paths(project: &Path) -> std::io::Result<Vec<PathBuf>> {
    let dot=project.join(".git");let metadata=fs::metadata(&dot).await?;
    if metadata.is_dir() { return Ok(vec![dot]); }
    async fn pointer(path: &Path) -> std::io::Result<String> {
        let m=fs::metadata(path).await?;
        if !m.is_file() || m.len()>8192 { return Err(std::io::Error::other("Invalid Git pointer")); }
        fs::read_to_string(path).await
    }
    let text=pointer(&dot).await?;
    let value=text.trim().strip_prefix("gitdir:").map(str::trim).filter(|s|!s.is_empty()).ok_or_else(||std::io::Error::other("Invalid gitdir pointer"))?;
    let admin=git_pointer_path(project,value);let mut result=vec![admin.clone()];
    match pointer(&admin.join("commondir")).await {
        Ok(common) if !common.trim().is_empty()=>result.push(git_pointer_path(&admin,common.trim())),
        Ok(_)=>return Err(std::io::Error::other("Empty Git common directory pointer")),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},
        Err(e)=>return Err(e),
    }
    Ok(result)
}

/// Root directory holding every variant of every project.
fn variants_root() -> Result<PathBuf, DaemonError> {
    let home = std::env::var("HOME").map_err(|_| {
        DaemonError::Rpc("cannot create an isolated copy: HOME is not set".to_string())
    })?;
    Ok(PathBuf::from(home).join(".falcondeck").join("variants"))
}

/// Directory name used to group a project's variants. Purely cosmetic — the
/// slug is what makes the path unique.
fn project_dir_name(project_path: &str) -> String {
    let name = Path::new(project_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "project".to_string()
    } else {
        sanitized
    }
}

/// Creates an isolated checkout of `project_path` and switches it to its own
/// branch.
///
/// Refuses non-git project folders outright rather than producing a copy with
/// no branch and no diff — a half-working variant is worse than none, because
/// every downstream affordance (diff panel, merge-back) assumes a repository.
pub async fn create(project_path: &str, slug: &str) -> Result<ThreadVariant, DaemonError> {
    let root = variants_root()?;
    create_in_root(project_path, slug, &root).await
}

pub(crate) async fn create_in_root(
    project_path: &str,
    slug: &str,
    root: &Path,
) -> Result<ThreadVariant, DaemonError> {
    if !is_git_repository(project_path).await {
        return Err(DaemonError::BadRequest(format!(
            "cannot run this thread in an isolated copy: {project_path} is not a git repository"
        )));
    }

    let destination = root.join(project_dir_name(project_path)).join(slug);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).await.map_err(|error| {
            DaemonError::Rpc(format!("failed to create the variants directory: {error}"))
        })?;
    }
    if destination.exists() {
        return Err(DaemonError::BadRequest(format!(
            "isolated copy already exists: {}",
            destination.display()
        )));
    }
    let setup = setup::load(project_path).await?;

    let branch = format!("{BRANCH_PREFIX}{slug}");
    let destination_str = destination.to_string_lossy().to_string();
    let base_branch = current_branch(project_path).await;

    populate_worktree(project_path, &destination, &branch, slug, true, setup).await?;

    Ok(ThreadVariant {
        slug: slug.to_string(),
        path: destination_str,
        branch,
        kind: ThreadVariantKind::Worktree,
        base_branch,
    })
}

/// Populate a private worktree before publishing its path. Only this function's
/// fresh staging tree may be rolled back with force; reclamation never uses it.
async fn populate_worktree(
    project: &str,
    destination: &Path,
    branch: &str,
    slug: &str,
    new_branch: bool,
    setup: setup::Setup,
) -> Result<(), DaemonError> {
    populate_worktree_mode(project,destination,branch,slug,new_branch,setup,false).await
}

async fn populate_worktree_mode(
    project: &str,
    destination: &Path,
    branch: &str,
    slug: &str,
    new_branch: bool,
    setup: setup::Setup,
    allow_duplicate: bool,
) -> Result<(), DaemonError> {
    let parent = destination
        .parent()
        .ok_or_else(|| DaemonError::Rpc("variant path has no parent".into()))?;
    fs::create_dir_all(parent)
        .await
        .map_err(|e| DaemonError::Rpc(e.to_string()))?;
    // A crash can leave the branch checked out in its unpublished staging
    // directory. Reuse that checkout, preserving its branch even on failure.
    let recovered = recover_staging(project, parent, slug, branch).await?;
    let staging = recovered
        .clone()
        .unwrap_or_else(|| parent.join(format!(".{slug}-provision-{}", Uuid::new_v4())));
    let stage = staging.to_string_lossy();
    let new_branch = new_branch && recovered.is_none();
    if new_branch
        && run_git(
            project,
            &["show-ref", "--verify", &format!("refs/heads/{branch}")],
        )
        .await
        .is_ok()
    {
        return Err(DaemonError::BadRequest(format!(
            "isolated branch already exists: {branch}"
        )));
    }
    let starting_head = run_git(project, &["rev-parse", "HEAD"]).await?;
    let added = if recovered.is_some() {
        Ok(())
    } else if new_branch {
        add_worktree(project, &staging, branch).await
    } else {
        let mut args=vec!["worktree", "add", "--no-checkout"];
        if allow_duplicate {args.push("--force");}
        args.extend([&stage,branch]);
        run_git(project,&args)
        .await
        .map(|_| ())
    };
    if let Err(error) = added {
        if recovered.is_none() {
            let _ = run_git(project, &["worktree", "remove", "--force", &stage]).await;
        }
        if new_branch {
            discard_new_branch(project, branch, starting_head.trim()).await;
        }
        return Err(error);
    }
    let result = async {
        if recovered.is_none() {
            // Leave an explicit HEAD index before provisioning. A recovery
            // never assumes that an absent working tree means no staged work.
            run_git(&stage, &["read-tree", "HEAD"]).await?;
        }
        setup::provision(project, &staging, &setup).await?;
        populated(&stage).await.map_err(DaemonError::Rpc)?;
        let restored_snapshot=snapshot::apply_pending(project,slug,&stage).await?;
        if restored_snapshot {copy_allowlist_filtered(project,&staging,true).await;} else {copy_untracked_allowlist(project, &staging).await;}
        setup::save_setup(project, slug, &staging, setup.clone()).await?;
        let destination_text=destination.to_string_lossy();
        let mut args=vec!["worktree","move"];
        if allow_duplicate {
            if !matches!(fs::symlink_metadata(destination).await,Err(e) if e.kind()==std::io::ErrorKind::NotFound) {
                return Err(DaemonError::Rpc("Restore destination was recreated; retaining it".into()));
            }
            // Git's targeted missing-registration override, never global prune.
            // Existing/locked destinations retain Git's normal protections.
            args.push("--force");
        }
        args.extend([stage.as_ref(),destination_text.as_ref()]);
        run_git(project,&args).await?;
        snapshot::finish_restore(project,slug,&destination.to_string_lossy()).await?;
        Ok::<_, DaemonError>(())
    }
    .await;
    if let Err(error) = result {
        if recovered.is_some() {
            return Err(DaemonError::Rpc(format!(
                "Provisioning recovered staging failed at {stage}: {error}. Pre-existing staging was retained for review."
            )));
        }
        // Only staging created in this call may be force-removed.
        // This path was never handed to a thread or user. It may have an
        // incomplete index after a failed checkout, so plain remove can refuse.
        let _ = run_git(project, &["worktree", "remove", "--force", &stage]).await;
        if new_branch {
            discard_new_branch(project, branch, starting_head.trim()).await;
        }
        return Err(error);
    }
    start_dependencies(project, destination, setup).await;
    Ok(())
}

/// Only the exact slug's registered private staging is recoverable. Never
/// reset a staging tree containing edits or an active process. Reusing it
/// avoids deleting an unpushed branch left by an interrupted create.
async fn recover_staging(
    project: &str,
    parent: &Path,
    slug: &str,
    branch: &str,
) -> Result<Option<PathBuf>, DaemonError> {
    let listed = run_git(project, &["worktree", "list", "--porcelain"]).await?;
    let prefix = format!(".{slug}-provision-");
    for record in listed.split("\n\n") {
        let Some(path) = record.lines().find_map(|l| l.strip_prefix("worktree ")) else {
            continue;
        };
        let path = PathBuf::from(path);
        let Some(suffix) = path
            .file_name()
            .and_then(|p| p.to_str())
            .and_then(|p| p.strip_prefix(&prefix))
        else {
            continue;
        };
        if path.parent() != fs::canonicalize(parent).await.ok().as_deref()
            || Uuid::parse_str(suffix).is_err()
            || !record
                .lines()
                .any(|l| l == format!("branch refs/heads/{branch}"))
        {
            continue;
        }
        let stage = path.to_string_lossy();
        let reference = format!("refs/heads/{branch}");
        let expected = run_git(project, &["rev-parse", "--verify", &reference]).await?;
        let actual = run_git(&stage, &["rev-parse", "HEAD"]).await?;
        let actual_ref = run_git(&stage, &["symbolic-ref", "-q", "HEAD"]).await?;
        let mut blockers = reclaim::hidden_or_in_progress(&stage)
            .await
            .map_err(DaemonError::Rpc)?;
        if actual_ref.trim() != reference || actual.trim() != expected.trim() {
            blockers.push("HEAD differs from the expected variant branch tip".into());
        }
        if run_git(
            &stage,
            &[
                "diff",
                "--cached",
                "--quiet",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=none",
                expected.trim(),
                "--",
            ],
        )
        .await
        .is_err()
        {
            blockers.push(
                "staged changes or an uninitialized index; index must match the variant branch tip"
                    .into(),
            );
        }
        if !blockers.is_empty() {
            return Err(DaemonError::Rpc(format!(
                "Interrupted staging requires review: {}: {}. Staging was retained.",
                path.display(),
                blockers.join("; ")
            )));
        }
        reclaim::process_clear(&path)
            .await
            .map_err(DaemonError::Rpc)?;
        let mut files = fs::read_dir(&path)
            .await
            .map_err(|e| DaemonError::Rpc(e.to_string()))?;
        let mut empty = true;
        while let Some(file) = files
            .next_entry()
            .await
            .map_err(|e| DaemonError::Rpc(e.to_string()))?
        {
            if file.file_name() != ".git" {
                empty = false;
                break;
            }
        }
        // With a verified HEAD index, an empty --no-checkout tree only has
        // working-tree deletions. Any populated staging must also be clean.
        if !empty {
            let blockers = reclaim::status_blockers(project, &path.to_string_lossy())
                .await
                .map_err(DaemonError::Rpc)?;
            if !blockers.is_empty() && (!snapshot::known_staging(&path.to_string_lossy()).await || !reclaim::status_blockers_mode(project,&path.to_string_lossy(),true).await.map_err(DaemonError::Rpc)?.is_empty()) {
                return Err(DaemonError::Rpc(format!(
                    "Interrupted staging requires review: {}: {}",
                    path.display(),
                    blockers.join("; ")
                )));
            }
        }
        return Ok(Some(path));
    }
    Ok(None)
}

async fn discard_new_branch(project: &str, branch: &str, starting_head: &str) {
    let reference = format!("refs/heads/{branch}");
    let Ok(listed) = run_git(project, &["worktree", "list", "--porcelain"]).await else {
        return;
    };
    if listed
        .lines()
        .any(|line| line == format!("branch {reference}"))
    {
        return;
    }
    // Only discard our unchanged duplicate while the source HEAD still keeps
    // its commits. A concurrently moved ref or unique tip is retained.
    if run_git(
        project,
        &["merge-base", "--is-ancestor", starting_head, "HEAD"],
    )
    .await
    .is_ok()
    {
        let _ = run_git(project, &["update-ref", "-d", &reference, starting_head]).await;
    }
}

pub(crate) async fn populated(path: &str) -> Result<(), String> {
    let root = Path::new(path);
    if !root.join(".git").exists() {
        return Err(format!(
            "isolated checkout at {path} is incomplete (missing .git); restore it before continuing"
        ));
    }
    let top = run_git(path, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|e| e.to_string())?;
    if fs::canonicalize(top.trim()).await.ok() != fs::canonicalize(root).await.ok() {
        return Err(format!(
            "isolated checkout at {path} has incomplete Git registration"
        ));
    }
    let files = run_git(path, &["ls-tree", "-r", "--name-only", "-z", "HEAD"])
        .await
        .map_err(|e| e.to_string())?;
    if !files.is_empty()
        && !files
            .split('\0')
            .filter(|p| !p.is_empty())
            .any(|p| root.join(p).symlink_metadata().is_ok())
    {
        if snapshot::approved_empty_checkout(path).await {return Ok(());}
        return Err(format!(
            "isolated checkout at {path} is not populated; refusing to run with every tracked file missing"
        ));
    }
    Ok(())
}

type DependencyJob = tokio::sync::watch::Receiver<Option<Vec<String>>>;
fn dependency_jobs() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, DependencyJob>>
{
    static JOBS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, DependencyJob>>,
    > = std::sync::OnceLock::new();
    JOBS.get_or_init(Default::default)
}

async fn start_dependencies(project: &str, path: &Path, setup: setup::Setup) {
    if setup.dependency_roots.is_empty() {
        return;
    }
    let (tx, rx) = tokio::sync::watch::channel(None);
    dependency_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_owned(), rx);
    let project = project.to_string();
    let path = path.to_owned();
    tokio::spawn(async move {
        static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
        let slots = SLOTS.get_or_init(|| tokio::sync::Semaphore::new(1));
        let _slot = slots.acquire().await;
        let messages = setup::dependencies(&project, &path, &setup).await;
        let _ = tx.send(Some(messages));
    });
}

#[cfg(test)]
pub(crate) fn dependency_test_job(path: &str) -> tokio::sync::watch::Sender<Option<Vec<String>>> {
    let (tx, rx) = tokio::sync::watch::channel(None);
    dependency_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.into(), rx);
    tx
}

pub(crate) fn has_dependency_job(path: &str) -> bool {
    dependency_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(Path::new(path))
}

/// The durable queue is the restart receipt; jobs themselves are in memory.
pub(crate) fn interrupt_missing_dependency_job(path: &str) {
    let (_, rx) = tokio::sync::watch::channel(Some(vec![
        "Dependency provisioning was interrupted by a daemon restart; node_modules may be incomplete. Run the project's normal install before using dependencies.".to_string()
    ]));
    dependency_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(path.into())
        .or_insert(rx);
}

pub(crate) fn dependencies_pending(path: &str) -> bool {
    dependency_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(Path::new(path))
        .is_some_and(|job| job.borrow().is_none() && job.has_changed().is_ok())
}

pub(crate) async fn wait_dependencies(path: &str) -> Vec<String> {
    let job = dependency_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(Path::new(path))
        .cloned();
    let Some(mut job) = job else {
        return Vec::new();
    };
    loop {
        if let Some(messages) = job.borrow().clone() {
            return messages;
        }
        if job.changed().await.is_err() {
            return vec![
                "Dependency provisioning was interrupted; run the project's normal install.".into(),
            ];
        }
    }
}

/// Tries safe reclamation after thread deletion. Unsafe checkouts are retained;
/// a failure must not block deleting the thread record.
///
/// The branch is deliberately left behind — it holds the work, and merge-back
/// has not shipped yet, so deleting it would be the only way to lose an
/// isolated thread's changes irrecoverably. A worktree variant's branch
/// already lives in the project repository; a clone's branch exists only
/// inside the checkout being deleted, so it is fetched across first.
pub async fn remove(project_path: &str, variant: &ThreadVariant) {
    if variant.kind == ThreadVariantKind::Clone {
        preserve_clone_branch(project_path, variant).await;
    }
    match reclaim_if_safe(project_path, variant).await {
        Reclaim::Removed | Reclaim::Quarantined(_) => {}
        Reclaim::Kept(reasons) | Reclaim::RecoveryRequired(reasons) => {
            tracing::info!(path = %variant.path, reasons = %reasons.join("; "), "kept isolated copy after thread deletion")
        }
    }
}

/// Copies a clone variant's branch into the project repository before the
/// clone is deleted, so committed work survives thread deletion exactly as it
/// does for worktree variants. Skipped when the branch tip is an object the
/// project repository already has — no new commits means fetching would only
/// litter the branch list with an empty `falcondeck/…` entry.
async fn preserve_clone_branch(project_path: &str, variant: &ThreadVariant) {
    let Ok(tip) = run_git(&variant.path, &["rev-parse", &variant.branch]).await else {
        return;
    };
    let tip = tip.trim().to_string();
    if run_git(
        project_path,
        &["cat-file", "-e", &format!("{tip}^{{commit}}")],
    )
    .await
    .is_ok()
    {
        return;
    }
    let refspec = format!("{}:{}", variant.branch, variant.branch);
    if let Err(error) = run_git(
        project_path,
        &["fetch", "--no-tags", &variant.path, &refspec],
    )
    .await
    {
        tracing::warn!(
            branch = %variant.branch,
            %error,
            "failed to preserve isolated copy branch before deletion"
        );
    }
}

async fn current_branch(project_path: &str) -> Option<String> {
    let branch = run_git(project_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()?;
    let branch = branch.trim();
    if branch.is_empty() || branch == "HEAD" {
        None
    } else {
        Some(branch.to_string())
    }
}

async fn is_git_repository(project_path: &str) -> bool {
    run_git(project_path, &["rev-parse", "--git-dir"])
        .await
        .is_ok()
}

async fn add_worktree(
    project_path: &str,
    destination: &Path,
    branch: &str,
) -> Result<(), DaemonError> {
    let destination = destination.to_string_lossy().to_string();
    run_git(
        project_path,
        &[
            "worktree",
            "add",
            "--no-checkout",
            "-b",
            branch,
            &destination,
            "HEAD",
        ],
    )
    .await
    .map(|_| ())
    .map_err(|error| DaemonError::Rpc(format!("failed to create an isolated worktree: {error}")))
}

/// Copies untracked files matching [`UNTRACKED_ALLOWLIST`] into a worktree
/// variant. Best-effort: a missing `.env` is a nuisance, not a reason to fail
/// thread creation.
async fn copy_untracked_allowlist(project_path:&str,destination:&Path) {copy_allowlist_filtered(project_path,destination,false).await;}
async fn copy_allowlist_filtered(project_path: &str, destination: &Path, ignored_only:bool) {
    for relative in untracked_allowlist_matches(project_path).await {
        if ignored_only && run_git(&destination.to_string_lossy(),&["check-ignore","-q","--",&relative]).await.is_err(){continue;}
        let source = Path::new(project_path).join(&relative);
        let target = destination.join(&relative);
        if let Some(parent) = target.parent()
            && let Err(error) = fs::create_dir_all(parent).await
        {
            tracing::warn!(file = %relative, %error, "failed to prepare untracked file directory");
            continue;
        }
        if let Err(error) = fs::copy(&source, &target).await {
            tracing::warn!(file = %relative, %error, "failed to copy untracked file into variant");
        }
    }
}

/// Repo-relative paths of untracked files matching the allowlist.
///
/// Both listings are needed: `.env` is usually gitignored (so only the
/// `--ignored` pass sees it) but not always (so only the plain pass does).
/// `--directory` collapses wholly-ignored directories to one entry, which is
/// what keeps `node_modules` from producing a six-figure listing.
async fn untracked_allowlist_matches(project_path: &str) -> Vec<String> {
    let listings = [
        vec![
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
            "--directory",
        ],
        vec![
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ],
    ];

    let mut matches = Vec::new();
    for args in listings {
        let Ok(stdout) = run_git(project_path, &args).await else {
            continue;
        };
        for entry in stdout.split('\0') {
            // Trailing slash marks a collapsed directory, never a file to copy.
            if entry.is_empty() || entry.ends_with('/') {
                continue;
            }
            let name = Path::new(entry)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            if matches_allowlist(&name) && !matches.contains(&entry.to_string()) {
                matches.push(entry.to_string());
            }
        }
    }
    matches
}

/// Matches a file name against the allowlist's leading/trailing wildcards.
fn matches_allowlist(name: &str) -> bool {
    UNTRACKED_ALLOWLIST
        .iter()
        .any(|pattern| match_glob(pattern, name))
}

/// Minimal glob: `*` matches any run of characters. The allowlist is a fixed,
/// short list of simple patterns, so a dependency-free matcher covers it.
fn match_glob(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let (Some(first), Some(last)) = (parts.first(), parts.last()) else {
        return false;
    };
    if parts.len() == 1 {
        return name == pattern;
    }
    let Some(mut rest) = name.strip_prefix(first) else {
        return false;
    };
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(index) => rest = &rest[index + part.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

async fn run_git(cwd: &str, args: &[&str]) -> Result<String, DaemonError> {
    let output = Command::new("git")
        .kill_on_drop(true)
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| DaemonError::Rpc(format!("failed to run git: {error}")))?;
    if !output.status.success() {
        return Err(DaemonError::Rpc(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Actual filesystem availability, so APFS shared extents are counted once.
pub(crate) async fn available_disk(path: &Path) -> Option<u64> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
            let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
            // SAFETY: path is NUL-terminated and stat points to writable storage.
            if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
                return None;
            }
            // SAFETY: statvfs succeeded and initialized stat.
            let stat = unsafe { stat.assume_init() };
            Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            None
        }
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn init_repo(path: &Path) {
        run_git(path.to_str().unwrap(), &["init"]).await.unwrap();
        run_git(
            path.to_str().unwrap(),
            &["config", "user.email", "t@example.com"],
        )
        .await
        .unwrap();
        run_git(path.to_str().unwrap(), &["config", "user.name", "Test"])
            .await
            .unwrap();
        fs::write(path.join("README.md"), "hello\n").await.unwrap();
        run_git(path.to_str().unwrap(), &["add", "."])
            .await
            .unwrap();
        run_git(path.to_str().unwrap(), &["commit", "-m", "initial"])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn git_capacity_paths_resolve_relative_gitfile_and_shared_commondir() {
        let t=tempfile::tempdir().unwrap();let project=t.path().join("project");let admin=t.path().join("admin");let common=t.path().join("shared.git");
        for path in [&project,&admin,&common] {std::fs::create_dir(path).unwrap();}
        std::fs::write(project.join(".git"),"gitdir: ../admin\n").unwrap();
        std::fs::write(admin.join("commondir"),"../shared.git\n").unwrap();
        assert_eq!(git_storage_paths(&project).await.unwrap(),vec![admin,common]);
    }

    #[tokio::test]
    async fn create_recovers_only_its_own_crashed_staging_and_branch() {
        let root = tempdir().unwrap();
        test_no_docker_mounts(root.path());
        let project = root.path().join("project");
        fs::create_dir(&project).await.unwrap();
        init_repo(&project).await;
        let variants = root.path().join("variants");
        let parent = variants.join("project");
        fs::create_dir_all(&parent).await.unwrap();
        let stage = parent.join(format!(".crashed-provision-{}", Uuid::new_v4()));
        let other = parent.join(format!(".other-provision-{}", Uuid::new_v4()));
        fs::create_dir(&other).await.unwrap();
        fs::write(other.join("untouched"), "other thread")
            .await
            .unwrap();
        run_git(
            project.to_str().unwrap(),
            &[
                "worktree",
                "add",
                "--no-checkout",
                "-b",
                "falcondeck/crashed",
                stage.to_str().unwrap(),
            ],
        )
        .await
        .unwrap();
        run_git(stage.to_str().unwrap(), &["read-tree", "HEAD"])
            .await
            .unwrap();
        let head = run_git(
            project.to_str().unwrap(),
            &["rev-parse", "falcondeck/crashed"],
        )
        .await
        .unwrap();
        let variant = create_in_root(project.to_str().unwrap(), "crashed", &variants)
            .await
            .unwrap();
        assert!(!stage.exists());
        assert!(Path::new(&variant.path).join("README.md").exists());
        assert!(other.join("untouched").exists());
        assert_eq!(
            run_git(&variant.path, &["rev-parse", "HEAD"])
                .await
                .unwrap(),
            head
        );
        assert!(
            run_git(
                project.to_str().unwrap(),
                &["worktree", "list", "--porcelain"]
            )
            .await
            .unwrap()
            .contains(
                fs::canonicalize(&variant.path)
                    .await
                    .unwrap()
                    .to_str()
                    .unwrap()
            )
        );
    }

    async fn assert_empty_staging_is_retained(kind: &str) {
        let root = tempdir().unwrap();
        test_no_docker_mounts(root.path());
        let project = root.path().join("project");
        fs::create_dir(&project).await.unwrap();
        init_repo(&project).await;
        let variants = root.path().join("variants");
        let parent = variants.join("project");
        fs::create_dir_all(&parent).await.unwrap();
        let stage = parent.join(format!(".index-only-provision-{}", Uuid::new_v4()));
        let stage_str = stage.to_str().unwrap();
        run_git(
            project.to_str().unwrap(),
            &[
                "worktree",
                "add",
                "--no-checkout",
                "-b",
                "falcondeck/index-only",
                stage_str,
            ],
        )
        .await
        .unwrap();
        if kind != "uninitialized" {
            run_git(stage_str, &["read-tree", "HEAD"]).await.unwrap();
        }
        let mut pending_index = None;
        match kind {
            "index-lock" => {
                let git_dir = run_git(stage_str, &["rev-parse", "--absolute-git-dir"])
                    .await
                    .unwrap();
                let git_dir = Path::new(git_dir.trim());
                fs::write(stage.join("README.md"), "unique pending index work\n")
                    .await
                    .unwrap();
                run_git(stage_str, &["add", "README.md"]).await.unwrap();
                let pending = fs::read(git_dir.join("index")).await.unwrap();
                run_git(stage_str, &["read-tree", "HEAD"]).await.unwrap();
                fs::remove_file(stage.join("README.md")).await.unwrap();
                let lock = git_dir.join("index.lock");
                fs::write(&lock, &pending).await.unwrap();
                pending_index = Some((lock, pending));
            }
            "edit" | "add" => {
                let file = if kind == "edit" {
                    "README.md"
                } else {
                    "unique-staged.md"
                };
                fs::write(stage.join(file), "unique work exists only in the index\n")
                    .await
                    .unwrap();
                run_git(stage_str, &["add", file]).await.unwrap();
                fs::remove_file(stage.join(file)).await.unwrap();
            }
            "delete" => {
                run_git(stage_str, &["rm", "--cached", "README.md"])
                    .await
                    .unwrap();
            }
            "merge" => {
                let git_dir = run_git(stage_str, &["rev-parse", "--absolute-git-dir"])
                    .await
                    .unwrap();
                let head = run_git(stage_str, &["rev-parse", "HEAD"]).await.unwrap();
                fs::write(Path::new(git_dir.trim()).join("MERGE_HEAD"), head)
                    .await
                    .unwrap();
            }
            "uninitialized" => {}
            _ => panic!("unknown fixture"),
        }
        let contents: Vec<_> = std::fs::read_dir(&stage)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(contents, [std::ffi::OsString::from(".git")]);
        let index_before = run_git(stage_str, &["ls-files", "--stage", "-z"])
            .await
            .unwrap();
        let changes_before = run_git(stage_str, &["diff", "--cached", "--binary", "HEAD"])
            .await
            .unwrap();
        let error = create_in_root(project.to_str().unwrap(), "index-only", &variants)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("Interrupted staging requires review"),
            "{error}"
        );
        assert!(
            error.contains(if kind == "merge" || kind == "index-lock" {
                "operation in progress"
            } else {
                "index must match"
            }),
            "{error}"
        );
        assert!(stage.exists());
        assert!(!parent.join("index-only").exists());
        assert_eq!(
            run_git(stage_str, &["ls-files", "--stage", "-z"])
                .await
                .unwrap(),
            index_before
        );
        assert_eq!(
            run_git(stage_str, &["diff", "--cached", "--binary", "HEAD"])
                .await
                .unwrap(),
            changes_before
        );
        if let Some((lock, pending)) = pending_index {
            assert!(error.contains("index.lock"));
            assert_eq!(fs::read(&lock).await.unwrap(), pending);
            let shown = Command::new("git")
                .current_dir(&stage)
                .env("GIT_INDEX_FILE", &lock)
                .args(["show", ":README.md"])
                .output()
                .await
                .unwrap();
            assert!(shown.status.success());
            assert_eq!(
                String::from_utf8(shown.stdout).unwrap(),
                "unique pending index work\n"
            );
        }
        if kind == "edit" || kind == "add" {
            let file = if kind == "edit" {
                ":README.md"
            } else {
                ":unique-staged.md"
            };
            assert_eq!(
                run_git(stage_str, &["show", file]).await.unwrap(),
                "unique work exists only in the index\n"
            );
        }
    }

    #[tokio::test]
    async fn empty_staging_retains_a_pending_replacement_index() {
        assert_empty_staging_is_retained("index-lock").await;
    }

    #[tokio::test]
    async fn empty_staging_retains_a_staged_edit() {
        assert_empty_staging_is_retained("edit").await;
    }

    #[tokio::test]
    async fn empty_staging_retains_a_staged_new_file() {
        assert_empty_staging_is_retained("add").await;
    }

    #[tokio::test]
    async fn empty_staging_retains_a_staged_delete() {
        assert_empty_staging_is_retained("delete").await;
    }

    #[tokio::test]
    async fn empty_staging_retains_an_in_progress_operation() {
        assert_empty_staging_is_retained("merge").await;
    }

    #[tokio::test]
    async fn empty_staging_retains_an_uninitialized_index() {
        assert_empty_staging_is_retained("uninitialized").await;
    }

    #[test]
    fn allowlist_matches_env_files_and_local_overrides() {
        assert!(matches_allowlist(".env"));
        assert!(matches_allowlist(".env.local"));
        assert!(matches_allowlist(".env.production"));
        assert!(matches_allowlist(".envrc"));
        assert!(matches_allowlist("vite.config.local.ts"));
        assert!(!matches_allowlist("README.md"));
        assert!(!matches_allowlist("environment.ts"));
        assert!(!matches_allowlist("local.ts"));
    }

    #[tokio::test]
    async fn refuses_isolation_for_non_git_project_folders() {
        let temp_dir = tempdir().unwrap();
        let error = create(temp_dir.path().to_str().unwrap(), "abc123")
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("not a git repository"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn creating_variant_uses_worktree_without_ignored_build_outputs() {
        let project_dir = tempdir().unwrap();
        let project = project_dir.path();
        init_repo(project).await;
        fs::write(project.join(".gitignore"), ".env\ntarget/\n")
            .await
            .unwrap();
        run_git(project.to_str().unwrap(), &["add", ".gitignore"])
            .await
            .unwrap();
        run_git(
            project.to_str().unwrap(),
            &["commit", "-m", "ignore build state"],
        )
        .await
        .unwrap();
        fs::write(project.join(".env"), "TOKEN=test\n")
            .await
            .unwrap();
        fs::create_dir(project.join("target")).await.unwrap();
        fs::write(project.join("target/cache.bin"), "regenerable")
            .await
            .unwrap();

        let variants_dir = tempdir().unwrap();
        let variant = create_in_root(project.to_str().unwrap(), "lean1234", variants_dir.path())
            .await
            .unwrap();

        assert_eq!(
            (
                &variant.kind,
                Path::new(&variant.path).join(".env").is_file(),
                Path::new(&variant.path).join("target").exists(),
            ),
            (&ThreadVariantKind::Worktree, true, false),
        );

        remove(project.to_str().unwrap(), &variant).await;
    }

    #[tokio::test]
    async fn removing_a_clone_variant_preserves_its_committed_work() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();
        init_repo(repo).await;
        let repo_path = repo.to_str().unwrap();

        // Simulate a clone variant: an independent full copy on its own branch
        // with a commit the project repository has never seen.
        let clone_dir = tempdir().unwrap();
        let clone = clone_dir.path().join("clone");
        run_git(repo_path, &["clone", repo_path, clone.to_str().unwrap()])
            .await
            .unwrap();
        let clone_path = clone.to_str().unwrap().to_string();
        run_git(&clone_path, &["switch", "-c", "falcondeck/test1234"])
            .await
            .unwrap();
        fs::write(clone.join("WORK.md"), "isolated work\n")
            .await
            .unwrap();
        run_git(&clone_path, &["add", "."]).await.unwrap();
        run_git(&clone_path, &["commit", "-m", "isolated work"])
            .await
            .unwrap();

        let variant = ThreadVariant {
            slug: "test1234".to_string(),
            path: clone_path,
            branch: "falcondeck/test1234".to_string(),
            kind: ThreadVariantKind::Clone,
            base_branch: Some("main".to_string()),
        };
        remove(repo_path, &variant).await;

        assert!(
            clone.exists(),
            "legacy clone must be retained for manual review"
        );

        let subject = run_git(
            repo_path,
            &["log", "-1", "--format=%s", "falcondeck/test1234"],
        )
        .await
        .expect("branch must survive in the project repository");
        assert_eq!(subject.trim(), "isolated work");
    }

    #[tokio::test]
    async fn removing_a_clone_variant_with_no_new_commits_leaves_no_branch() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();
        init_repo(repo).await;
        let repo_path = repo.to_str().unwrap();

        let clone_dir = tempdir().unwrap();
        let clone = clone_dir.path().join("clone");
        run_git(repo_path, &["clone", repo_path, clone.to_str().unwrap()])
            .await
            .unwrap();
        let clone_path = clone.to_str().unwrap().to_string();
        run_git(&clone_path, &["switch", "-c", "falcondeck/empty123"])
            .await
            .unwrap();

        let variant = ThreadVariant {
            slug: "empty123".to_string(),
            path: clone_path,
            branch: "falcondeck/empty123".to_string(),
            kind: ThreadVariantKind::Clone,
            base_branch: Some("main".to_string()),
        };
        remove(repo_path, &variant).await;

        assert!(
            run_git(repo_path, &["rev-parse", "--verify", "falcondeck/empty123"])
                .await
                .is_err(),
            "an untouched variant must not litter the branch list"
        );
    }

    #[tokio::test]
    async fn untracked_allowlist_finds_gitignored_env_files() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();
        init_repo(repo).await;
        fs::write(repo.join(".gitignore"), ".env\nnode_modules/\n")
            .await
            .unwrap();
        fs::write(repo.join(".env"), "SECRET=1\n").await.unwrap();
        fs::create_dir_all(repo.join("node_modules/pkg"))
            .await
            .unwrap();
        fs::write(repo.join("node_modules/pkg/index.js"), "//\n")
            .await
            .unwrap();

        let matches = untracked_allowlist_matches(repo.to_str().unwrap()).await;
        assert!(matches.contains(&".env".to_string()), "got {matches:?}");
        assert!(
            !matches.iter().any(|entry| entry.contains("node_modules")),
            "ignored directories must stay collapsed: {matches:?}"
        );
    }
    #[tokio::test]
    async fn closed_dependency_job_falls_back_without_requeuing_forever() {
        let root = tempdir().unwrap();
        let path = root.path().to_str().unwrap();
        let sender = dependency_test_job(path);
        assert!(dependencies_pending(path));
        drop(sender);
        assert!(!dependencies_pending(path));
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            wait_dependencies(path),
        )
        .await
        .unwrap();
        assert!(result.iter().any(|m| m.contains("interrupted")));
    }
}
