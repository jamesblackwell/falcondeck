//! Lifecycle cleanup for worktree variants.
//!
//! A variant is plumbing for a thread. Once the thread is archived, its
//! checkout only costs disk (a Quizgecko worktree is ~2 GB with dependencies),
//! so archiving tries to reclaim it, but only when nothing would be lost:
//! the tree is clean, every commit is on `origin` (by patch-id, so
//! rebased/cherry-picked copies count), and the only ignored files are
//! rebuildable. Anything else is kept and reported; the branch is always kept.
//!
//! These rules mirror `scripts/worktree-gc.mjs` (keep them in step; the
//! rationale is in `docs/WORKTREE-LIFECYCLE.md`). Checking the remote never
//! writes to the project repository: `ls-remote` supplies the real tips and
//! the objects behind them are fetched into a scratch object directory.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use falcondeck_core::{ThreadVariant, ThreadVariantKind};
use tokio::{fs, process::Command, time::timeout};

use super::{matches_allowlist, run_git};

/// Directories a build or install recreates; ignored files inside them never
/// block reclaiming.
const REBUILDABLE: &[&str] = &[
    "node_modules",
    "/vendor",
    "/target",
    ".next",
    "/dist",
    "/frontend/dist",
    ".phpunit.cache",
    ".react-router",
    "__pycache__",
    ".pytest_cache",
    "/bootstrap/cache",
    "/storage/framework/cache",
    "/storage/framework/views",
];

const REMOTE_TIMEOUT: Duration = Duration::from_secs(120);
const FETCH_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reclaim {
    /// The checkout is gone (removed now, or already missing).
    Removed,
    /// The checkout stays on disk; each entry is a human-readable reason.
    Kept(Vec<String>),
}

/// Removes the variant's worktree if it is provably safe to do so.
///
/// Uses `git worktree remove` without `--force`, so git itself refuses if the
/// tree turned dirty after the assessment. The branch is never deleted.
pub async fn reclaim_if_safe(project_path: &str, variant: &ThreadVariant) -> Reclaim {
    match assess(project_path, variant).await {
        Ok(assessment) => finish_reclaim(project_path, variant, assessment).await,
        Err(result) => result,
    }
}

pub(crate) struct Assessment {
    head: String,
}

/// Network work runs before taking the app's admission gate. A ticket never
/// authorizes removal by itself: finish_reclaim repeats all local checks.
pub(crate) async fn assess(
    project_path: &str,
    variant: &ThreadVariant,
) -> Result<Assessment, Reclaim> {
    if variant.kind != ThreadVariantKind::Worktree {
        return Err(Reclaim::Kept(vec!["not a worktree variant".into()]));
    }
    if !Path::new(&variant.path).exists() {
        return Err(Reclaim::Removed);
    }
    let head = run_git(&variant.path, &["rev-parse", "HEAD"])
        .await
        .map_err(|e| Reclaim::Kept(vec![e.to_string()]))?;
    let blockers = blockers(project_path, variant).await;
    if !blockers.is_empty() {
        return Err(Reclaim::Kept(blockers));
    }
    Ok(Assessment { head })
}

pub(crate) async fn finish_reclaim(
    project_path: &str,
    variant: &ThreadVariant,
    assessment: Assessment,
) -> Reclaim {
    if !Path::new(&variant.path).exists() {
        return Reclaim::Removed;
    }
    // Remote verification can be slow; recheck local state and processes at
    // the destructive boundary as well as before the network call.
    let mut fresh = checkout_identity(variant).await;
    fresh.extend(
        status_blockers(project_path, &variant.path)
            .await
            .unwrap_or_else(|e| vec![e]),
    );
    if let Err(reason) = process_clear(Path::new(&variant.path)).await {
        fresh.push(reason);
    }
    if run_git(&variant.path, &["rev-parse", "HEAD"])
        .await
        .ok()
        .as_deref()
        != Some(assessment.head.as_str())
    {
        fresh.push("HEAD changed during assessment".into());
    }
    if !fresh.is_empty() {
        return Reclaim::Kept(fresh);
    }
    let setup = match super::setup::restore_setup(project_path, &variant.slug).await {
        Ok(setup) => setup,
        Err(e) => return Reclaim::Kept(vec![format!("could not preserve checkout setup: {e}")]),
    };
    if let Err(e) =
        super::setup::save_setup(project_path, &variant.slug, Path::new(&variant.path), setup).await
    {
        return Reclaim::Kept(vec![format!("could not preserve checkout setup: {e}")]);
    }
    if let Err(error) = git(
        project_path,
        &["worktree", "remove", &variant.path],
        &[],
        FETCH_TIMEOUT,
    )
    .await
    {
        return Reclaim::Kept(vec![format!("git worktree remove refused: {error}")]);
    }
    let _ = run_git(project_path, &["worktree", "prune"]).await;
    Reclaim::Removed
}

/// Recreates a reclaimed worktree at its original path from the kept branch,
/// so an unarchived thread finds its working directory again. No-op when the
/// checkout exists. Returns whether a checkout was recreated.
pub async fn restore(project_path: &str, variant: &ThreadVariant) -> Result<bool, String> {
    if variant.kind != ThreadVariantKind::Worktree {
        return Ok(false);
    }
    if Path::new(&variant.path).exists() {
        super::populated(&variant.path).await?;
        return Ok(false);
    }
    let reference = format!("refs/heads/{}", variant.branch);
    if run_git(project_path, &["show-ref", "--verify", &reference])
        .await
        .is_err()
    {
        return Err(format!(
            "Cannot restore isolated checkout: branch '{}' no longer exists. Recover the branch from a surviving ref before resuming this thread.",
            variant.branch
        ));
    }
    let setup = super::setup::restore_setup(project_path, &variant.slug)
        .await
        .map_err(|e| e.to_string())?;
    let _ = run_git(project_path, &["worktree", "prune"]).await;
    super::populate_worktree(
        project_path,
        Path::new(&variant.path),
        &variant.branch,
        &variant.slug,
        false,
        setup,
    )
    .await
    .map_err(|e| format!("could not recreate {}: {e}", variant.path))?;
    Ok(true)
}

/// Reasons the checkout must be kept; empty means safe to remove.
async fn blockers(project_path: &str, variant: &ThreadVariant) -> Vec<String> {
    let mut reasons = checkout_identity(variant).await;
    if !reasons.is_empty() {
        return reasons;
    }
    if let Err(reason) = process_clear(Path::new(&variant.path)).await {
        return vec![reason];
    }
    match status_blockers(project_path, &variant.path).await {
        Ok(found) => reasons.extend(found),
        Err(error) => return vec![format!("could not read git status: {error}")],
    }
    match unpushed_commits(project_path, &variant.path).await {
        Ok(0) => {}
        Ok(count) => reasons.push(format!("{count} commit(s) not on a remote")),
        Err(error) => reasons.push(format!("remote state unverified: {error}")),
    }
    reasons
}

pub(super) async fn status_blockers(project_path: &str, path: &str) -> Result<Vec<String>, String> {
    let out = git(
        path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignored=traditional",
        ],
        &[],
        REMOTE_TIMEOUT,
    )
    .await?;
    let mut reasons = hidden_or_in_progress(path).await?;
    let (mut tracked, mut untracked) = (0usize, 0usize);
    let mut other_ignored = Vec::new();
    for (code, entry) in parse_status(&out) {
        match code.as_str() {
            "!!" => {
                if !ignored_safe(project_path, path, &entry).await {
                    other_ignored.push(entry);
                }
            }
            "??" => {
                if !identical_to_project(project_path, path, &entry).await {
                    untracked += 1;
                }
            }
            _ => tracked += 1,
        }
    }
    if tracked > 0 {
        reasons.push(format!("{tracked} uncommitted change(s)"));
    }
    if untracked > 0 {
        reasons.push(format!("{untracked} untracked file(s)"));
    }
    if let Some(first) = other_ignored.first() {
        reasons.push(format!(
            "non-rebuildable ignored files: {first}{}",
            if other_ignored.len() > 1 {
                format!(" +{}", other_ignored.len() - 1)
            } else {
                String::new()
            }
        ));
    }
    Ok(reasons)
}

async fn checkout_identity(variant: &ThreadVariant) -> Vec<String> {
    if super::dependencies_pending(&variant.path) {
        return vec!["dependency provisioning is still running".into()];
    }
    match run_git(&variant.path, &["symbolic-ref", "-q", "HEAD"]).await {
        Ok(reference) if reference.trim() == format!("refs/heads/{}", variant.branch) => Vec::new(),
        _ => vec![format!(
            "HEAD is detached or is not the recorded branch {}; keep this checkout",
            variant.branch
        )],
    }
}

pub(crate) async fn hidden_or_in_progress(path: &str) -> Result<Vec<String>, String> {
    let mut reasons = Vec::new();
    let files = git(path, &["ls-files", "-v", "-z"], &[], REMOTE_TIMEOUT).await?;
    for entry in files.split('\0').filter(|e| e.len() > 2) {
        let tag = entry.as_bytes()[0];
        if tag.is_ascii_lowercase()
            || (tag == b'S'
                && fs::symlink_metadata(Path::new(path).join(&entry[2..]))
                    .await
                    .is_ok())
        {
            reasons.push(format!(
                "hidden index flags on present file: {}",
                &entry[2..]
            ));
            break;
        }
    }
    let dir = git(
        path,
        &["rev-parse", "--absolute-git-dir"],
        &[],
        REMOTE_TIMEOUT,
    )
    .await?;
    for marker in [
        "rebase-merge",
        "rebase-apply",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
        "sequencer",
        "index.lock",
    ] {
        if fs::symlink_metadata(Path::new(dir.trim()).join(marker))
            .await
            .is_ok()
        {
            reasons.push(format!("Git operation in progress: {marker}"));
        }
    }
    Ok(reasons)
}

async fn ignored_safe(project: &str, path: &str, entry: &str) -> bool {
    let mut pending = vec![entry.to_string()];
    while let Some(relative) = pending.pop() {
        if is_rebuildable(&relative) || identical_to_project(project, path, &relative).await {
            continue;
        }
        // Git can collapse storage/framework to one ignored entry. Inspect
        // only ancestors of allowlisted caches; sessions and logs still block.
        let prefix = format!("{}/", relative.trim_end_matches('/'));
        if !REBUILDABLE
            .iter()
            .any(|p| p.trim_start_matches('/').starts_with(&prefix))
        {
            return false;
        }
        let Ok(mut dir) = fs::read_dir(Path::new(path).join(&relative)).await else {
            return false;
        };
        loop {
            match dir.next_entry().await {
                Ok(Some(child)) => {
                    let Ok(kind) = child.file_type().await else {
                        return false;
                    };
                    if kind.is_symlink() {
                        return false;
                    }
                    pending.push(format!("{prefix}{}", child.file_name().to_string_lossy()));
                }
                Ok(None) => break,
                Err(_) => return false,
            }
        }
    }
    true
}

/// `(XY, path)` pairs from `status --porcelain=v1 -z`; a rename or copy
/// entry carries its source path as a following field, which is skipped.
fn parse_status(out: &str) -> Vec<(String, String)> {
    let mut fields = out.split('\0');
    let mut entries = Vec::new();
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        let code = field[..2].to_string();
        entries.push((code.clone(), field[3..].to_string()));
        if code.contains('R') || code.contains('C') {
            fields.next();
        }
    }
    entries
}

/// Ignored entries that never block: env-file copies the daemon made at
/// creation (the project folder holds the original) and rebuildable output.
fn is_rebuildable(entry: &str) -> bool {
    let segments: Vec<_> = entry.split('/').filter(|p| !p.is_empty()).collect();
    REBUILDABLE.iter().any(|pattern| {
        let parts: Vec<_> = pattern.trim_start_matches('/').split('/').collect();
        if pattern.starts_with('/') {
            segments.starts_with(&parts)
        } else {
            segments.windows(parts.len()).any(|window| window == parts)
        }
    })
}

/// Check accessible process cwd and open files from one lsof inventory. An
/// inventory failure blocks removal, but OS permissions can hide other users'
/// descriptors even when lsof succeeds. This cannot prove global inactivity.
pub(crate) async fn process_clear(path: &Path) -> Result<(), String> {
    let path = fs::canonicalize(path)
        .await
        .map_err(|e| format!("process check: {e}"))?;
    let output = timeout(
        Duration::from_secs(30),
        Command::new("lsof")
            .args(["-nP", "-Fpn"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "process inventory timed out".to_string())?
    .map_err(|e| format!("process inventory unavailable: {e}"))?;
    // A nonzero exit is not proof of inactivity. A zero exit still covers
    // only descriptors this daemon user is permitted to inspect.
    if !output.status.success() {
        return Err("process inventory incomplete".into());
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(cwd) = line.strip_prefix("n/") {
            let raw = format!("/{cwd}");
            let raw = raw.strip_suffix(" (deleted)").unwrap_or(&raw);
            let normalized = if cfg!(target_os = "macos")
                && (raw.starts_with("/var/") || raw.starts_with("/tmp/"))
            {
                format!("/private{raw}")
            } else {
                raw.to_string()
            };
            let cwd = std::path::PathBuf::from(normalized);
            if cwd.starts_with(&path) {
                return Err("a process has its cwd or an open file inside the worktree".into());
            }
        }
    }
    #[cfg(test)]
    if test_docker_roots()
        .lock()
        .unwrap()
        .iter()
        .any(|root| path.starts_with(root))
    {
        return Ok(());
    }
    docker_clear(&path).await
}

// Explicit fixture-only dependency injection: safety tests still inspect real
// process descriptors, but do not depend on the user's live Docker daemon.
#[cfg(test)]
fn test_docker_roots() -> &'static std::sync::Mutex<Vec<std::path::PathBuf>> {
    static ROOTS: std::sync::OnceLock<std::sync::Mutex<Vec<std::path::PathBuf>>> =
        std::sync::OnceLock::new();
    ROOTS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

#[cfg(test)]
pub(crate) fn test_no_docker_mounts(root: &Path) {
    test_docker_roots()
        .lock()
        .unwrap()
        .push(std::fs::canonicalize(root).unwrap());
}

async fn docker_clear(path: &Path) -> Result<(), String> {
    // Inspect local bind mounts when a known local Docker socket is available.
    // Remote/custom contexts without this signal are a documented blind spot.
    let configured = std::env::var("DOCKER_HOST").ok();
    let socket = configured
        .as_deref()
        .and_then(|v| v.strip_prefix("unix://"));
    if !socket.map(Path::new).is_some_and(Path::exists)
        && !Path::new("/var/run/docker.sock").exists()
    {
        return Ok(());
    }
    async fn docker(args: &[&str]) -> Result<String, String> {
        let out = timeout(
            Duration::from_secs(3),
            Command::new("docker")
                .envs(crate::agent_binary::desktop_login_shell_environment().await)
                .args(args)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "Docker mount inventory timed out".to_string())?
        .map_err(|e| format!("Docker mount inventory unavailable: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("Docker mount inventory failed: {stderr}"));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
    let ids = docker(&["ps", "-q"]).await?;
    if ids.trim().is_empty() {
        return Ok(());
    }
    let mounts = inspect_docker_mounts(&ids, |id| async move {
        docker(&["inspect", "--format", "{{json .Mounts}}", &id]).await
    })
    .await?;
    docker_mounts_clear(path, mounts).await
}

async fn docker_mounts_clear(path: &Path, mounts: Vec<serde_json::Value>) -> Result<(), String> {
    for mount in mounts {
        if mount.get("Type").and_then(|v| v.as_str()) != Some("bind") {
            continue;
        }
        if let Some(source) = mount.get("Source").and_then(|v| v.as_str()) {
            let source = fs::canonicalize(source)
                .await
                .unwrap_or_else(|_| source.into());
            if path.starts_with(&source) || source.starts_with(path) {
                return Err("a running Docker container bind-mounts this checkout".into());
            }
        }
    }
    Ok(())
}

async fn inspect_docker_mounts<F, Fut>(
    ids: &str,
    mut inspect: F,
) -> Result<Vec<serde_json::Value>, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut mounts = Vec::new();
    for id in ids.split_whitespace() {
        let output = match inspect(id.to_string()).await {
            Ok(output) => output,
            Err(error) if error.to_ascii_lowercase().contains("no such object") => continue,
            Err(error) => return Err(error),
        };
        for line in output.lines() {
            mounts.extend(
                serde_json::from_str::<Vec<serde_json::Value>>(line)
                    .map_err(|_| "invalid Docker mount inventory".to_string())?,
            );
        }
    }
    Ok(mounts)
}

/// An untracked allowlisted file passes only when byte-identical to the
/// project folder's copy; anything else may be work.
async fn identical_to_project(project_path: &str, path: &str, relative: &str) -> bool {
    let name = relative.rsplit('/').next().unwrap_or("");
    if relative.ends_with('/') || !matches_allowlist(name) {
        return false;
    }
    let (Ok(ours), Ok(theirs)) = (
        fs::read(Path::new(path).join(relative)).await,
        fs::read(Path::new(project_path).join(relative)).await,
    ) else {
        return false;
    };
    ours == theirs
}

/// Commits reachable from HEAD but not from the live remote branches, minus
/// those whose patch already exists on the default or same-named branch.
async fn unpushed_commits(project_path: &str, path: &str) -> Result<usize, String> {
    let listed = git(
        project_path,
        &["ls-remote", "--symref", "origin"],
        &[],
        REMOTE_TIMEOUT,
    )
    .await?;
    let remote = parse_ls_remote(&listed);

    let common_dir = git(
        project_path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        &[],
        REMOTE_TIMEOUT,
    )
    .await?;
    let scratch = Scratch::new().map_err(|error| error.to_string())?;
    let objects = scratch.0.to_string_lossy().to_string();
    let alternates = format!("{}/objects", common_dir.trim());
    let env = [
        ("GIT_OBJECT_DIRECTORY", objects.as_str()),
        ("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates.as_str()),
    ];

    let shas: Vec<&str> = remote
        .tips
        .values()
        .map(String::as_str)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    for chunk in shas.chunks(200) {
        // Fetch by SHA: a glob refspec needs a destination ref, which would
        // write to the project repository.
        let mut args = vec![
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--refmap=",
            "origin",
        ];
        args.extend(chunk);
        git(project_path, &args, &env, FETCH_TIMEOUT).await?;
    }

    let mut args = vec!["rev-list", "HEAD", "--not"];
    args.extend(shas.iter());
    let candidates = git(path, &args, &env, REMOTE_TIMEOUT).await?;
    let candidates: Vec<&str> = candidates.lines().filter(|l| !l.is_empty()).collect();
    if candidates.is_empty() {
        return Ok(0);
    }

    let branch = git(
        path,
        &["symbolic-ref", "-q", "--short", "HEAD"],
        &[],
        REMOTE_TIMEOUT,
    )
    .await
    .ok()
    .map(|b| b.trim().to_string());
    let mut compare = HashSet::new();
    if let Some(tip) = remote
        .default_branch
        .as_ref()
        .and_then(|b| remote.tips.get(b))
    {
        compare.insert(tip.clone());
    }
    if let Some(tip) = branch.as_ref().and_then(|b| remote.tips.get(b)) {
        compare.insert(tip.clone());
    }
    let mut matched = HashSet::new();
    for tip in &compare {
        if let Ok(out) = git(path, &["cherry", tip, "HEAD"], &env, REMOTE_TIMEOUT).await {
            matched.extend(
                out.lines()
                    .filter_map(|line| line.strip_prefix("- "))
                    .map(|sha| sha.trim().to_string()),
            );
        }
    }
    Ok(candidates
        .iter()
        .filter(|sha| !matched.contains(**sha))
        .count())
}

/// Scratch object directory for one remote check, removed on drop.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new() -> std::io::Result<Self> {
        let path =
            std::env::temp_dir().join(format!("falcondeck-reclaim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct RemoteSnapshot {
    tips: HashMap<String, String>,
    default_branch: Option<String>,
}

fn parse_ls_remote(out: &str) -> RemoteSnapshot {
    let mut tips = HashMap::new();
    let mut default_branch = None;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("ref: refs/heads/")
            && let Some(name) = rest.strip_suffix("\tHEAD")
        {
            default_branch = Some(name.to_string());
        } else if let Some((sha, name)) = line.split_once('\t')
            && sha.len() == 40
            && let Some(branch) = name.strip_prefix("refs/heads/")
        {
            tips.insert(branch.to_string(), sha.to_string());
        }
    }
    RemoteSnapshot {
        tips,
        default_branch,
    }
}

/// Runs git without taking optional locks (so `status` never refreshes the
/// index of a checkout it is only inspecting) and with a deadline.
async fn git(
    cwd: &str,
    args: &[&str],
    env: &[(&str, &str)],
    deadline: Duration,
) -> Result<String, String> {
    let mut command = Command::new("nice");
    command.args(["-n", "10", "git"]);
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }
    let output = timeout(deadline, command.output())
        .await
        .map_err(|_| format!("git {} timed out", args.first().unwrap_or(&"")))?
        .map_err(|error| format!("failed to run git: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{TempDir, tempdir};

    fn git_sync(cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    struct Fixture {
        _root: TempDir,
        project: std::path::PathBuf,
        variants: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempdir().unwrap();
            test_no_docker_mounts(root.path());
            let origin = root.path().join("origin.git");
            let project = root.path().join("project");
            let variants = root.path().join("variants");
            std::fs::create_dir_all(&project).unwrap();
            std::fs::create_dir_all(&variants).unwrap();
            git_sync(
                root.path(),
                &["init", "--bare", "-b", "main", origin.to_str().unwrap()],
            );
            git_sync(&project, &["init", "-b", "main"]);
            std::fs::write(project.join(".gitignore"), "node_modules/\n.idea/\n.env\n").unwrap();
            std::fs::write(project.join("a.txt"), "one\n").unwrap();
            git_sync(&project, &["add", "."]);
            git_sync(&project, &["commit", "-m", "init"]);
            git_sync(
                &project,
                &["remote", "add", "origin", origin.to_str().unwrap()],
            );
            git_sync(&project, &["push", "origin", "main"]);
            Self {
                _root: root,
                project,
                variants,
            }
        }

        fn project_str(&self) -> &str {
            self.project.to_str().unwrap()
        }

        fn variant(&self, slug: &str) -> ThreadVariant {
            let path = self.variants.join(slug);
            let branch = format!("falcondeck/{slug}");
            git_sync(
                &self.project,
                &[
                    "worktree",
                    "add",
                    "-b",
                    &branch,
                    path.to_str().unwrap(),
                    "main",
                ],
            );
            ThreadVariant {
                slug: slug.to_string(),
                path: path.to_string_lossy().to_string(),
                branch,
                kind: ThreadVariantKind::Worktree,
                base_branch: Some("main".to_string()),
            }
        }
    }

    fn commit_file(variant: &ThreadVariant, name: &str) {
        let dir = Path::new(&variant.path);
        std::fs::write(dir.join(name), "x\n").unwrap();
        git_sync(dir, &["add", "."]);
        git_sync(dir, &["commit", "-m", name]);
    }

    #[test]
    fn status_parsing_skips_rename_sources() {
        let out = "R  new.txt\0old.txt\0 M a.rs\0?? scratch/\0!! node_modules/\0";
        assert_eq!(
            parse_status(out),
            vec![
                ("R ".to_string(), "new.txt".to_string()),
                (" M".to_string(), "a.rs".to_string()),
                ("??".to_string(), "scratch/".to_string()),
                ("!!".to_string(), "node_modules/".to_string()),
            ]
        );
    }

    #[test]
    fn benign_ignored_entries_are_env_copies_and_rebuildable_output() {
        assert!(!is_rebuildable(".env"));
        assert!(!is_rebuildable("frontend/.env.local"));
        assert!(is_rebuildable("apps/web/node_modules/"));
        assert!(is_rebuildable("target/"));
        assert!(!is_rebuildable(".idea/"));
        assert!(!is_rebuildable("storage/app/uploads/"));
        assert!(!is_rebuildable("node_modules_backup/"));
    }

    #[test]
    fn ls_remote_parsing_finds_tips_and_default_branch() {
        let sha = "a".repeat(40);
        let out = format!(
            "ref: refs/heads/main\tHEAD\n{sha}\tHEAD\n{sha}\trefs/heads/main\n{sha}\trefs/pull/1/head\n"
        );
        let parsed = parse_ls_remote(&out);
        assert_eq!(parsed.default_branch.as_deref(), Some("main"));
        assert_eq!(parsed.tips.len(), 1);
    }

    #[tokio::test]
    async fn pushed_clean_worktree_is_removed_and_branch_kept() {
        let f = Fixture::new();
        let v = f.variant("safe");
        commit_file(&v, "b.txt");
        git_sync(Path::new(&v.path), &["push", "origin", &v.branch]);
        std::fs::create_dir(Path::new(&v.path).join("node_modules")).unwrap();
        std::fs::write(Path::new(&v.path).join("node_modules/x.js"), "x").unwrap();

        assert_eq!(reclaim_if_safe(f.project_str(), &v).await, Reclaim::Removed);
        assert!(!Path::new(&v.path).exists());
        assert!(git_sync(&f.project, &["branch", "--list", &v.branch]).contains(&v.branch));
        assert!(!git_sync(&f.project, &["worktree", "list"]).contains("variants/safe"));
    }

    #[tokio::test]
    async fn unpushed_commits_keep_the_worktree() {
        let f = Fixture::new();
        let v = f.variant("unpushed");
        commit_file(&v, "c.txt");
        let Reclaim::Kept(reasons) = reclaim_if_safe(f.project_str(), &v).await else {
            panic!("unpushed work must be kept");
        };
        assert!(
            reasons.iter().any(|r| r.contains("not on a remote")),
            "{reasons:?}"
        );
        assert!(Path::new(&v.path).exists());
    }

    #[tokio::test]
    async fn patch_equivalent_commit_on_main_counts_as_pushed() {
        let f = Fixture::new();
        let v = f.variant("picked");
        commit_file(&v, "d.txt");
        let sha = git_sync(Path::new(&v.path), &["rev-parse", "HEAD"]);
        let output = std::process::Command::new("git")
            .args(["cherry-pick", &sha])
            .current_dir(&f.project)
            .env("GIT_COMMITTER_NAME", "u")
            .env("GIT_COMMITTER_EMAIL", "u@u")
            .env("GIT_COMMITTER_DATE", "2030-01-01T00:00:00Z")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(output.status.success());
        git_sync(&f.project, &["push", "origin", "main"]);
        assert_ne!(git_sync(&f.project, &["rev-parse", "HEAD"]), sha);

        assert_eq!(reclaim_if_safe(f.project_str(), &v).await, Reclaim::Removed);
    }

    #[tokio::test]
    async fn dirty_untracked_and_unknown_ignored_files_keep_the_worktree() {
        let f = Fixture::new();
        let dirty = f.variant("dirty");
        std::fs::write(Path::new(&dirty.path).join("a.txt"), "changed\n").unwrap();
        let untracked = f.variant("untracked");
        std::fs::write(Path::new(&untracked.path).join("new.txt"), "n").unwrap();
        let ignored = f.variant("ignored");
        std::fs::create_dir(Path::new(&ignored.path).join(".idea")).unwrap();
        std::fs::write(Path::new(&ignored.path).join(".idea/w.xml"), "x").unwrap();

        for v in [&dirty, &untracked, &ignored] {
            assert!(
                matches!(reclaim_if_safe(f.project_str(), v).await, Reclaim::Kept(_)),
                "{} should be kept",
                v.slug
            );
            assert!(Path::new(&v.path).exists());
        }
    }

    #[tokio::test]
    async fn copied_env_files_do_not_block() {
        let f = Fixture::new();
        std::fs::write(f.project.join(".env"), "KEY=1\n").unwrap();
        let v = f.variant("env");
        std::fs::write(Path::new(&v.path).join(".env"), "KEY=2\n").unwrap();
        assert!(matches!(
            reclaim_if_safe(f.project_str(), &v).await,
            Reclaim::Kept(_)
        ));
    }

    #[tokio::test]
    async fn unreachable_remote_keeps_the_worktree() {
        let f = Fixture::new();
        let v = f.variant("offline");
        git_sync(
            &f.project,
            &["remote", "set-url", "origin", "/nonexistent/origin.git"],
        );
        let Reclaim::Kept(reasons) = reclaim_if_safe(f.project_str(), &v).await else {
            panic!("an unverifiable remote must keep the worktree");
        };
        assert!(
            reasons.iter().any(|r| r.contains("unverified")),
            "{reasons:?}"
        );
    }

    #[tokio::test]
    async fn clone_variants_and_missing_paths_are_handled() {
        let f = Fixture::new();
        let mut clone = f.variant("clone");
        clone.kind = ThreadVariantKind::Clone;
        assert!(matches!(
            reclaim_if_safe(f.project_str(), &clone).await,
            Reclaim::Kept(_)
        ));
        let gone = ThreadVariant {
            path: f.variants.join("never").to_string_lossy().to_string(),
            ..clone
        };
        let gone = ThreadVariant {
            kind: ThreadVariantKind::Worktree,
            ..gone
        };
        assert_eq!(
            reclaim_if_safe(f.project_str(), &gone).await,
            Reclaim::Removed
        );
    }

    #[tokio::test]
    async fn docker_inventory_skips_only_vanished_containers() {
        let mut seen = Vec::new();
        let mounts = inspect_docker_mounts("gone live", |id| {
            seen.push(id.clone());
            async move {
                if id == "gone" {
                    Err("Error: No such object: gone".to_string())
                } else {
                    Ok(r#"[{"Type":"bind","Source":"/checkout"}]"#.to_string())
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(seen, ["gone", "live"]);
        assert_eq!(mounts[0]["Source"], "/checkout");
        assert!(
            docker_mounts_clear(Path::new("/checkout/thread"), mounts.clone())
                .await
                .is_err()
        );
        assert!(
            docker_mounts_clear(Path::new("/other-checkout"), mounts)
                .await
                .is_ok()
        );
        assert!(
            inspect_docker_mounts("live", |_| async { Err("permission denied".into()) })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn restore_recovers_crashed_staging_but_refuses_edits() {
        let f = Fixture::new();
        let v = f.variant("crashed");
        git_sync(&f.project, &["worktree", "remove", &v.path]);
        let stage = f
            .variants
            .join(format!(".crashed-provision-{}", uuid::Uuid::new_v4()));
        git_sync(
            &f.project,
            &[
                "worktree",
                "add",
                "--no-checkout",
                stage.to_str().unwrap(),
                &v.branch,
            ],
        );
        git_sync(&stage, &["read-tree", "HEAD"]);
        assert_eq!(restore(f.project_str(), &v).await, Ok(true));
        assert!(!stage.exists());
        assert!(Path::new(&v.path).join("a.txt").exists());
        git_sync(
            &f.project,
            &["worktree", "move", &v.path, stage.to_str().unwrap()],
        );
        std::fs::write(stage.join("a.txt"), "uncommitted work").unwrap();
        assert!(
            restore(f.project_str(), &v)
                .await
                .unwrap_err()
                .contains("requires review")
        );
        assert_eq!(
            std::fs::read_to_string(stage.join("a.txt")).unwrap(),
            "uncommitted work"
        );
    }

    #[tokio::test]
    async fn restore_recreates_a_reclaimed_worktree_from_its_branch() {
        let f = Fixture::new();
        std::fs::write(f.project.join(".env"), "KEY=1\n").unwrap();
        let v = f.variant("back");
        commit_file(&v, "kept.txt");
        git_sync(Path::new(&v.path), &["push", "origin", &v.branch]);
        assert_eq!(reclaim_if_safe(f.project_str(), &v).await, Reclaim::Removed);

        assert_eq!(restore(f.project_str(), &v).await, Ok(true));
        assert!(Path::new(&v.path).join("kept.txt").exists());
        assert!(Path::new(&v.path).join(".env").exists());
        // Already present: nothing to do.
        assert_eq!(restore(f.project_str(), &v).await, Ok(false));
    }
    #[tokio::test]
    async fn process_inside_worktree_refuses_reclaim() {
        let f = Fixture::new();
        let v = f.variant("process");
        let mut child = Command::new("sleep")
            .arg("30")
            .current_dir(&v.path)
            .spawn()
            .unwrap();
        let outcome = reclaim_if_safe(f.project_str(), &v).await;
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        assert!(
            matches!(outcome, Reclaim::Kept(ref why) if why.iter().any(|r| r.contains("process"))),
            "{outcome:?}"
        );
        assert!(Path::new(&v.path).exists());
    }

    #[test]
    fn framework_cache_allowlist_does_not_include_sessions_or_logs() {
        for path in [
            ".phpunit.cache/result",
            "frontend/.react-router/types",
            "bootstrap/cache/packages.php",
            "storage/framework/cache/x",
            "storage/framework/views/a.php",
        ] {
            assert!(is_rebuildable(path), "{path}");
        }
        for path in [
            "storage/framework/sessions/session",
            "storage/logs/laravel.log",
            "storage/app/file",
            "bootstrap/cache-backup/x",
        ] {
            assert!(!is_rebuildable(path), "{path}");
        }
    }
    #[tokio::test]
    async fn collapsed_framework_directory_keeps_sessions_but_allows_compiled_cache() {
        let f = Fixture::new();
        let v = f.variant("collapsed");
        let root = Path::new(&v.path).join("storage/framework");
        std::fs::create_dir_all(root.join("cache")).unwrap();
        std::fs::write(root.join("cache/generated"), "cache").unwrap();
        assert!(ignored_safe(f.project_str(), &v.path, "storage/").await);
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        std::fs::write(root.join("sessions/session"), "session").unwrap();
        assert!(!ignored_safe(f.project_str(), &v.path, "storage/").await);
    }
    #[tokio::test]
    async fn restore_failure_and_interrupted_checkout_never_admit_an_empty_tree() {
        let f = Fixture::new();
        let v = f.variant("failed");
        git_sync(&f.project, &["worktree", "remove", &v.path]);
        let config = f._root.path().join("bad.json");
        std::fs::write(&config, "not json").unwrap();
        git_sync(
            &f.project,
            &[
                "config",
                "falcondeck.worktreeSetup",
                config.to_str().unwrap(),
            ],
        );
        assert!(restore(f.project_str(), &v).await.is_err());
        assert!(!Path::new(&v.path).exists());
        git_sync(
            &f.project,
            &["config", "--unset", "falcondeck.worktreeSetup"],
        );
        assert_eq!(restore(f.project_str(), &v).await, Ok(true));
        git_sync(&f.project, &["worktree", "remove", &v.path]);
        // Simulate the old implementation crashing after add --no-checkout.
        git_sync(
            &f.project,
            &["worktree", "add", "--no-checkout", &v.path, &v.branch],
        );
        assert!(
            restore(f.project_str(), &v)
                .await
                .unwrap_err()
                .contains("not populated")
        );
    }

    #[tokio::test]
    async fn failed_provision_rolls_back_checkout_and_new_branch() {
        let f = Fixture::new();
        std::fs::write(f.project.join("local.txt"), "source work stays on main").unwrap();
        git_sync(&f.project, &["add", "."]);
        git_sync(&f.project, &["commit", "-m", "local source work"]);
        let setup = super::super::setup::Setup {
            patterns: Some("\0".into()),
            ..Default::default()
        };
        // An invalid OS argument forces sparse setup to fail after the private
        // worktree and its new branch have already been added.
        let dest = f.variants.join("new");
        assert!(
            super::super::populate_worktree(
                f.project_str(),
                &dest,
                "falcondeck/rollback",
                "rollback",
                true,
                setup
            )
            .await
            .is_err()
        );
        assert!(!dest.exists());
        assert!(git_sync(&f.project, &["branch", "--list", "falcondeck/rollback"]).is_empty());
    }

    #[tokio::test]
    async fn failed_provision_keeps_pre_existing_recovered_staging() {
        let f = Fixture::new();
        let v = f.variant("recoverfail");
        let stage = f
            .variants
            .join(format!(".recoverfail-provision-{}", uuid::Uuid::new_v4()));
        git_sync(
            &f.project,
            &["worktree", "move", &v.path, stage.to_str().unwrap()],
        );
        let head = git_sync(&stage, &["rev-parse", "HEAD"]);
        let index = git_sync(&stage, &["ls-files", "--stage", "-z"]);
        let setup = super::super::setup::Setup {
            patterns: Some("\0".into()),
            ..Default::default()
        };
        let error = super::super::populate_worktree(
            f.project_str(),
            Path::new(&v.path),
            &v.branch,
            &v.slug,
            false,
            setup,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("Pre-existing staging was retained"),
            "{error}"
        );
        assert!(stage.join(".git").exists());
        assert!(!Path::new(&v.path).exists());
        assert_eq!(
            std::fs::read_to_string(stage.join("a.txt")).unwrap(),
            "one\n"
        );
        assert_eq!(git_sync(&stage, &["rev-parse", "HEAD"]), head);
        assert_eq!(git_sync(&stage, &["ls-files", "--stage", "-z"]), index);
        assert!(
            git_sync(&f.project, &["worktree", "list", "--porcelain"])
                .contains(stage.canonicalize().unwrap().to_str().unwrap())
        );
    }

    #[tokio::test]
    async fn detached_and_changed_branches_are_never_reclaimed() {
        let f = Fixture::new();
        let v = f.variant("identity");
        git_sync(Path::new(&v.path), &["switch", "-c", "different"]);
        assert!(
            matches!(reclaim_if_safe(f.project_str(), &v).await, Reclaim::Kept(ref r) if r.iter().any(|s| s.contains("recorded branch")))
        );
        git_sync(Path::new(&v.path), &["switch", "--detach"]);
        assert!(
            matches!(reclaim_if_safe(f.project_str(), &v).await, Reclaim::Kept(ref r) if r.iter().any(|s| s.contains("detached")))
        );
        assert!(Path::new(&v.path).exists());
    }

    #[tokio::test]
    async fn hidden_edits_and_every_in_progress_operation_block_reclamation() {
        let f = Fixture::new();
        let v = f.variant("hidden");
        let path = Path::new(&v.path);
        for flag in ["--assume-unchanged", "--skip-worktree"] {
            git_sync(path, &["update-index", flag, "a.txt"]);
            std::fs::write(path.join("a.txt"), "hidden work").unwrap();
            assert!(
                matches!(reclaim_if_safe(f.project_str(), &v).await, Reclaim::Kept(ref why) if why.iter().any(|s| s.contains("hidden index"))),
                "{flag}"
            );
            git_sync(path, &["update-index", "--no-assume-unchanged", "a.txt"]);
            git_sync(path, &["update-index", "--no-skip-worktree", "a.txt"]);
            git_sync(path, &["restore", "a.txt"]);
        }
        let dir = git_sync(path, &["rev-parse", "--absolute-git-dir"]);
        for marker in [
            "rebase-merge",
            "rebase-apply",
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "BISECT_LOG",
            "sequencer",
            "index.lock",
        ] {
            let file = Path::new(&dir).join(marker);
            std::fs::write(&file, "in progress").unwrap();
            assert!(
                hidden_or_in_progress(&v.path)
                    .await
                    .unwrap()
                    .iter()
                    .any(|s| s.contains(marker)),
                "{marker}"
            );
            assert!(
                matches!(reclaim_if_safe(f.project_str(), &v).await, Reclaim::Kept(_)),
                "{marker}"
            );
            assert!(path.exists());
            std::fs::remove_file(file).unwrap();
        }
    }

    #[tokio::test]
    async fn open_file_from_another_cwd_blocks_reclamation() {
        let f = Fixture::new();
        let v = f.variant("open-file");
        let mut tail = Command::new("tail")
            .args(["-f", &format!("{}/a.txt", v.path)])
            .current_dir("/")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        // Reading the first line proves tail has opened its input.
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut line = String::new();
        BufReader::new(tail.stdout.take().unwrap())
            .read_line(&mut line)
            .await
            .unwrap();
        let result = reclaim_if_safe(f.project_str(), &v).await;
        tail.kill().await.unwrap();
        tail.wait().await.unwrap();
        assert!(
            matches!(result, Reclaim::Kept(ref why) if why.iter().any(|s| s.contains("open file")))
        );
    }

    #[test]
    fn nested_dist_target_and_vendor_may_contain_user_work() {
        for path in [
            "reports/dist/q3-final-analysis.md",
            "reports/target/results",
            "reports/vendor/research",
        ] {
            assert!(!is_rebuildable(path), "{path}");
        }
        for path in [
            "dist/bundle.js",
            "target/debug/binary",
            "vendor/autoload.php",
            "frontend/dist/index.js",
        ] {
            assert!(is_rebuildable(path), "{path}");
        }
    }

    #[tokio::test]
    async fn deleted_branch_has_an_actionable_restore_error() {
        let f = Fixture::new();
        let v = f.variant("missing-branch");
        git_sync(&f.project, &["worktree", "remove", &v.path]);
        git_sync(&f.project, &["branch", "-D", &v.branch]);
        let error = restore(f.project_str(), &v).await.unwrap_err();
        assert!(
            error.contains("no longer exists") && error.contains(&v.branch),
            "{error}"
        );
        assert!(!Path::new(&v.path).exists());
    }
}
