//! Isolated checkouts ("variants") backing individual threads.
//!
//! A variant is a private checkout of a workspace on its own branch, created
//! under `~/.falcondeck/variants/<project>/<slug>/` on the machine that owns
//! the workspace — so remote hosts get isolation without any extra plumbing.
//!
//! Two mechanisms serve it. A copy-on-write clone is preferred: on APFS (and
//! reflink-capable Linux filesystems) it is instant, costs nothing until files
//! diverge, and carries the *entire* working state — `.env` files, installed
//! dependencies, build caches — so no setup script is needed. Where the
//! filesystem cannot reflink, a `git worktree` plus a small allowlist of
//! untracked files is the fallback: correct, but it only carries tracked
//! content and the allowlist.
//!
//! Which one applies is decided by attempting the clone and falling back when
//! it fails, never by inspecting filesystem types — `cp -c` / `--reflink=always`
//! already answer the question authoritatively, and a filesystem probe would
//! disagree with them at exactly the boundaries that matter (network mounts,
//! cross-device project paths, unusual `cp` builds).

use std::path::{Path, PathBuf};

use falcondeck_core::{ThreadVariant, ThreadVariantKind};
use tokio::{fs, process::Command};
use uuid::Uuid;

use crate::error::DaemonError;

/// Untracked files carried into a worktree-backed variant. Copy-on-write
/// clones carry everything and never consult this.
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
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
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
    if !is_git_repository(project_path).await {
        return Err(DaemonError::BadRequest(format!(
            "cannot run this thread in an isolated copy: {project_path} is not a git repository"
        )));
    }

    let destination = variants_root()?.join(project_dir_name(project_path)).join(slug);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).await.map_err(|error| {
            DaemonError::Rpc(format!("failed to create the variants directory: {error}"))
        })?;
    }
    // A leftover from a crashed creation would poison both mechanisms.
    let _ = fs::remove_dir_all(&destination).await;

    let branch = format!("{BRANCH_PREFIX}{slug}");
    let destination_str = destination.to_string_lossy().to_string();

    let kind = match clone_working_tree(project_path, &destination).await {
        Ok(()) => ThreadVariantKind::Clone,
        Err(clone_error) => {
            tracing::info!(
                project = %project_path,
                reason = %clone_error,
                "copy-on-write clone unavailable; falling back to a git worktree"
            );
            let _ = fs::remove_dir_all(&destination).await;
            add_worktree(project_path, &destination, &branch).await?;
            copy_untracked_allowlist(project_path, &destination).await;
            ThreadVariantKind::Worktree
        }
    };

    // `git worktree add -b` already created and checked out the branch; a
    // clone is still sitting on whatever the project folder had checked out.
    if kind == ThreadVariantKind::Clone
        && let Err(error) = switch_to_new_branch(&destination_str, &branch).await
    {
        let _ = fs::remove_dir_all(&destination).await;
        return Err(error);
    }

    Ok(ThreadVariant {
        slug: slug.to_string(),
        path: destination_str,
        branch,
        kind,
    })
}

/// Deletes a variant's checkout. Best-effort by design: the thread it backed
/// is going away either way, and a failure here must not block that.
///
/// The branch is deliberately left behind — it holds the work, and merge-back
/// has not shipped yet, so deleting it would be the only way to lose an
/// isolated thread's changes irrecoverably.
pub async fn remove(project_path: &str, variant: &ThreadVariant) {
    if variant.kind == ThreadVariantKind::Worktree {
        let removed = run_git(
            project_path,
            &["worktree", "remove", "--force", &variant.path],
        )
        .await;
        if let Err(error) = removed {
            tracing::warn!(
                path = %variant.path,
                %error,
                "git worktree remove failed; deleting the directory and pruning instead"
            );
            let _ = fs::remove_dir_all(&variant.path).await;
        }
        // Prunes the administrative entry whether or not `remove` succeeded,
        // so the project repo never keeps a record of a checkout that is gone.
        let _ = run_git(project_path, &["worktree", "prune"]).await;
        return;
    }

    if let Err(error) = fs::remove_dir_all(&variant.path).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(path = %variant.path, %error, "failed to delete variant checkout");
    }
}

async fn is_git_repository(project_path: &str) -> bool {
    run_git(project_path, &["rev-parse", "--git-dir"]).await.is_ok()
}

/// Attempts a copy-on-write copy of the working tree, trying each platform's
/// reflink form in turn. Every form used here *fails* rather than silently
/// degrading to a byte-for-byte copy: falling back to a worktree is fast and
/// correct, whereas a full recursive copy of a working tree with dependencies
/// installed would take minutes and gigabytes without anyone asking for it.
async fn clone_working_tree(project_path: &str, destination: &Path) -> Result<(), DaemonError> {
    // A `.git` file (rather than directory) means the project folder is itself
    // a worktree or submodule; copying it would produce a checkout sharing the
    // parent's git directory, which corrupts both. Worktree mode handles it.
    if fs::metadata(Path::new(project_path).join(".git"))
        .await
        .map(|metadata| !metadata.is_dir())
        .unwrap_or(false)
    {
        return Err(DaemonError::Rpc(
            "project folder is itself a worktree or submodule".to_string(),
        ));
    }

    let destination = destination.to_string_lossy().to_string();
    let candidates: [&[&str]; 2] = [
        // macOS: clonefile(2).
        &["-c", "-R", project_path, &destination],
        // GNU coreutils: reflink, hard-failing where the filesystem lacks it.
        &["-a", "--reflink=always", project_path, &destination],
    ];

    let mut last_error = "no copy-on-write mechanism available".to_string();
    for args in candidates {
        match Command::new("cp").args(args).output().await {
            Ok(output) if output.status.success() => return Ok(()),
            Ok(output) => {
                last_error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            }
            Err(error) => last_error = error.to_string(),
        }
        // A failed `cp` can still have created part of the tree.
        let _ = fs::remove_dir_all(&destination).await;
    }

    Err(DaemonError::Rpc(last_error))
}

async fn add_worktree(
    project_path: &str,
    destination: &Path,
    branch: &str,
) -> Result<(), DaemonError> {
    let destination = destination.to_string_lossy().to_string();
    run_git(
        project_path,
        &["worktree", "add", "-b", branch, &destination, "HEAD"],
    )
    .await
    .map(|_| ())
    .map_err(|error| {
        DaemonError::Rpc(format!("failed to create an isolated worktree: {error}"))
    })
}

async fn switch_to_new_branch(variant_path: &str, branch: &str) -> Result<(), DaemonError> {
    run_git(variant_path, &["switch", "-c", branch])
        .await
        .map(|_| ())
        .map_err(|error| {
            DaemonError::Rpc(format!("failed to branch the isolated copy: {error}"))
        })
}

/// Copies untracked files matching [`UNTRACKED_ALLOWLIST`] into a worktree
/// variant. Best-effort: a missing `.env` is a nuisance, not a reason to fail
/// thread creation.
async fn copy_untracked_allowlist(project_path: &str, destination: &Path) {
    for relative in untracked_allowlist_matches(project_path).await {
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
        vec!["ls-files", "-z", "--others", "--exclude-standard", "--directory"],
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
    UNTRACKED_ALLOWLIST.iter().any(|pattern| match_glob(pattern, name))
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn init_repo(path: &Path) {
        run_git(path.to_str().unwrap(), &["init"]).await.unwrap();
        run_git(path.to_str().unwrap(), &["config", "user.email", "t@example.com"])
            .await
            .unwrap();
        run_git(path.to_str().unwrap(), &["config", "user.name", "Test"])
            .await
            .unwrap();
        fs::write(path.join("README.md"), "hello\n").await.unwrap();
        run_git(path.to_str().unwrap(), &["add", "."]).await.unwrap();
        run_git(path.to_str().unwrap(), &["commit", "-m", "initial"])
            .await
            .unwrap();
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
    async fn untracked_allowlist_finds_gitignored_env_files() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();
        init_repo(repo).await;
        fs::write(repo.join(".gitignore"), ".env\nnode_modules/\n")
            .await
            .unwrap();
        fs::write(repo.join(".env"), "SECRET=1\n").await.unwrap();
        fs::create_dir_all(repo.join("node_modules/pkg")).await.unwrap();
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
}
