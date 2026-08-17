//! Isolated checkouts ("variants") backing individual threads.
//!
//! A variant is a private checkout of a workspace on its own branch, created
//! under `~/.falcondeck/variants/<project>/<slug>/` on the machine that owns
//! the workspace — so remote hosts get isolation without any extra plumbing.
//!
//! Variants use `git worktree` so ignored build outputs never get replicated.
//! Copy-on-write clones avoid copying file contents but still duplicate every
//! filesystem entry; large Cargo, Xcode, and dependency trees made creation,
//! deletion, and disk accounting prohibitively expensive. A small allowlist of
//! environment files is copied into the otherwise tracked-only worktree.

use std::path::{Path, PathBuf};

use falcondeck_core::{ThreadVariant, ThreadVariantKind};
use tokio::{fs, process::Command};
use uuid::Uuid;

use crate::error::DaemonError;

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
    // A leftover from a crashed creation would poison worktree creation.
    let _ = fs::remove_dir_all(&destination).await;

    let branch = format!("{BRANCH_PREFIX}{slug}");
    let destination_str = destination.to_string_lossy().to_string();
    let base_branch = current_branch(project_path).await;

    add_worktree(project_path, &destination, &branch).await?;
    copy_untracked_allowlist(project_path, &destination).await;

    Ok(ThreadVariant {
        slug: slug.to_string(),
        path: destination_str,
        branch,
        kind: ThreadVariantKind::Worktree,
        base_branch,
    })
}

/// Deletes a variant's checkout. Best-effort by design: the thread it backed
/// is going away either way, and a failure here must not block that.
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
        &["worktree", "add", "-b", branch, &destination, "HEAD"],
    )
    .await
    .map(|_| ())
    .map_err(|error| DaemonError::Rpc(format!("failed to create an isolated worktree: {error}")))
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

        assert!(!clone.exists(), "checkout must be deleted");
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
}
