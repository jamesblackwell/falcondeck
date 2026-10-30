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

use super::{copy_untracked_allowlist, matches_allowlist, run_git};

/// Directories a build or install recreates; ignored files inside them never
/// block reclaiming.
const REBUILDABLE: &[&str] = &["node_modules", "vendor", "target", ".next", "dist"];

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
    if variant.kind != ThreadVariantKind::Worktree {
        return Reclaim::Kept(vec!["not a worktree variant".to_string()]);
    }
    if !Path::new(&variant.path).exists() {
        let _ = run_git(project_path, &["worktree", "prune"]).await;
        return Reclaim::Removed;
    }
    let blockers = blockers(project_path, variant).await;
    if !blockers.is_empty() {
        return Reclaim::Kept(blockers);
    }
    if let Err(error) = run_git(project_path, &["worktree", "remove", &variant.path]).await {
        return Reclaim::Kept(vec![format!("git worktree remove refused: {error}")]);
    }
    let _ = run_git(project_path, &["worktree", "prune"]).await;
    Reclaim::Removed
}

/// Recreates a reclaimed worktree at its original path from the kept branch,
/// so an unarchived thread finds its working directory again. No-op when the
/// checkout exists. Returns whether a checkout was recreated.
pub async fn restore(project_path: &str, variant: &ThreadVariant) -> Result<bool, String> {
    if variant.kind != ThreadVariantKind::Worktree || Path::new(&variant.path).exists() {
        return Ok(false);
    }
    // A leftover administrative entry for the missing path would block `add`.
    let _ = run_git(project_path, &["worktree", "prune"]).await;
    run_git(
        project_path,
        &["worktree", "add", &variant.path, &variant.branch],
    )
    .await
    .map_err(|error| format!("could not recreate {}: {error}", variant.path))?;
    copy_untracked_allowlist(project_path, Path::new(&variant.path)).await;
    Ok(true)
}

/// Reasons the checkout must be kept; empty means safe to remove.
async fn blockers(project_path: &str, variant: &ThreadVariant) -> Vec<String> {
    let mut reasons = Vec::new();
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

async fn status_blockers(project_path: &str, path: &str) -> Result<Vec<String>, String> {
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
    let mut reasons = Vec::new();
    let (mut tracked, mut untracked) = (0usize, 0usize);
    let mut other_ignored = Vec::new();
    for (code, entry) in parse_status(&out) {
        match code.as_str() {
            "!!" => {
                if !ignored_is_benign(&entry) {
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
fn ignored_is_benign(entry: &str) -> bool {
    let name = entry.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    matches_allowlist(name) || is_rebuildable(entry)
}

fn is_rebuildable(entry: &str) -> bool {
    entry
        .split('/')
        .any(|segment| REBUILDABLE.contains(&segment))
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
    let mut command = Command::new("git");
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
        assert!(ignored_is_benign(".env"));
        assert!(ignored_is_benign("frontend/.env.local"));
        assert!(ignored_is_benign("apps/web/node_modules/"));
        assert!(ignored_is_benign("target/"));
        assert!(!ignored_is_benign(".idea/"));
        assert!(!ignored_is_benign("storage/app/uploads/"));
        assert!(!ignored_is_benign("node_modules_backup/"));
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
        assert_eq!(reclaim_if_safe(f.project_str(), &v).await, Reclaim::Removed);
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
}
