//! Land an isolated thread's branch: commit leftovers, then PR or merge.

use falcondeck_core::{GitCommitResponse, ShipThreadMode, ShipThreadResponse, ThreadVariant};
use tokio::process::Command;

use crate::error::DaemonError;
use crate::git::git_status;

/// Commit leftover isolated-checkout changes when the tree is dirty.
pub async fn commit_checkout(
    checkout: &str,
    message: &str,
) -> Result<GitCommitResponse, DaemonError> {
    let status = git_status(checkout).await?;
    if status.entries.is_empty() {
        return Ok(GitCommitResponse {
            committed: false,
            message: None,
        });
    }
    run_git(checkout, &["add", "-A"]).await?;
    let message = sanitize_message(message);
    run_git(checkout, &["commit", "-m", &message]).await?;
    Ok(GitCommitResponse {
        committed: true,
        message: Some(message),
    })
}

/// GitHub CLI used for the pull-request modes. Tests point this at a stub.
const GH_PROGRAM: &str = "gh";

/// Land a variant branch onto its base: push and open a PR, or merge locally.
pub async fn ship_variant(
    project_path: &str,
    variant: &ThreadVariant,
    title: &str,
    mode: ShipThreadMode,
) -> Result<ShipThreadResponse, DaemonError> {
    ship_variant_with_gh(project_path, variant, title, mode, GH_PROGRAM).await
}

async fn ship_variant_with_gh(
    project_path: &str,
    variant: &ThreadVariant,
    title: &str,
    mode: ShipThreadMode,
    gh: &str,
) -> Result<ShipThreadResponse, DaemonError> {
    let commit = commit_checkout(&variant.path, title).await?;
    let base = resolve_base_branch(project_path, variant).await?;

    match mode {
        ShipThreadMode::Pr | ShipThreadMode::DraftPr => {
            push_branch(&variant.path, &variant.branch).await?;
            let url = create_pull_request(
                &variant.path,
                &base,
                &variant.branch,
                title,
                mode == ShipThreadMode::DraftPr,
                gh,
            )
            .await?;
            Ok(ShipThreadResponse {
                mode,
                branch: variant.branch.clone(),
                base,
                committed: commit.committed,
                pushed: true,
                url: Some(url),
            })
        }
        ShipThreadMode::Merge => {
            merge_into_base(project_path, variant, &base).await?;
            // The merge already landed locally, so a failed push is not a
            // failed ship — but the client must not claim we pushed.
            let pushed = push_branch(project_path, &base).await.is_ok();
            Ok(ShipThreadResponse {
                mode,
                branch: variant.branch.clone(),
                base,
                committed: commit.committed,
                pushed,
                url: None,
            })
        }
    }
}

fn sanitize_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        "Update from isolated thread".to_string()
    } else {
        trimmed.to_string()
    }
}

async fn resolve_base_branch(
    project_path: &str,
    variant: &ThreadVariant,
) -> Result<String, DaemonError> {
    if let Some(base) = variant
        .base_branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty() && *branch != "HEAD")
    {
        return Ok(base.to_string());
    }
    for candidate in ["main", "master"] {
        if run_git(
            project_path,
            &["rev-parse", "--verify", &format!("refs/heads/{candidate}")],
        )
        .await
        .is_ok()
        {
            return Ok(candidate.to_string());
        }
    }
    Err(DaemonError::BadRequest(
        "could not determine a base branch to land this isolated copy".to_string(),
    ))
}

async fn merge_into_base(
    project_path: &str,
    variant: &ThreadVariant,
    base: &str,
) -> Result<(), DaemonError> {
    let project_status = git_status(project_path).await?;
    if !project_status.entries.is_empty() {
        return Err(DaemonError::BadRequest(
            "the project folder has uncommitted changes; open a pull request instead".to_string(),
        ));
    }
    if project_status.branch.as_deref() != Some(base) {
        return Err(DaemonError::BadRequest(format!(
            "the project folder is not on {base}; switch to it first, or open a pull request"
        )));
    }
    run_git(project_path, &["merge", "--no-edit", &variant.branch]).await?;
    Ok(())
}

async fn push_branch(cwd: &str, branch: &str) -> Result<(), DaemonError> {
    run_git(cwd, &["push", "-u", "origin", branch])
        .await
        .map(|_| ())
        .map_err(|error| {
            DaemonError::Rpc(format!(
                "failed to push {branch}: {error}. Check that origin exists and you can push."
            ))
        })
}

async fn create_pull_request(
    cwd: &str,
    base: &str,
    head: &str,
    title: &str,
    draft: bool,
    gh: &str,
) -> Result<String, DaemonError> {
    let mut command = Command::new(gh);
    command
        .args([
            "pr", "create", "--base", base, "--head", head, "--title", title, "--body", "",
        ])
        .current_dir(cwd);
    if draft {
        command.arg("--draft");
    }
    let output = command.output().await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DaemonError::BadRequest(
                "GitHub CLI (gh) is not installed, so FalconDeck cannot open a pull request"
                    .to_string(),
            )
        } else {
            DaemonError::Rpc(format!("failed to run gh: {error}"))
        }
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(DaemonError::BadRequest(format!(
            "could not create a pull request: {}",
            stderr.trim()
        )));
    }
    output
        .stdout
        .split(|byte| *byte == b'\n' || *byte == b'\r')
        .find_map(|line| {
            let line = String::from_utf8_lossy(line);
            let line = line.trim();
            line.starts_with("http").then(|| line.to_string())
        })
        .ok_or_else(|| {
            DaemonError::Rpc("gh created a pull request but did not print a URL".to_string())
        })
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
    use std::path::{Path, PathBuf};
    use tempfile::tempdir;
    use tokio::fs;

    async fn init_repo(path: &Path) -> String {
        let cwd = path.to_str().unwrap();
        run_git(cwd, &["init", "-b", "main"]).await.unwrap();
        run_git(cwd, &["config", "user.email", "t@example.com"])
            .await
            .unwrap();
        run_git(cwd, &["config", "user.name", "Test"])
            .await
            .unwrap();
        fs::write(path.join("README.md"), "hello\n").await.unwrap();
        run_git(cwd, &["add", "."]).await.unwrap();
        run_git(cwd, &["commit", "-m", "initial"]).await.unwrap();
        cwd.to_string()
    }

    async fn create_variant(project: &str, slug: &str, root: &Path) -> ThreadVariant {
        crate::variant::create_in_root(project, slug, root)
            .await
            .unwrap()
    }

    /// Give the project a bare `origin` so pushes succeed. The returned guard
    /// keeps the remote directory alive for the caller's lifetime.
    async fn add_bare_origin(project: &str) -> tempfile::TempDir {
        let remote_dir = tempdir().unwrap();
        let remote = remote_dir.path().to_str().unwrap();
        run_git(remote, &["init", "--bare"]).await.unwrap();
        run_git(project, &["remote", "add", "origin", remote])
            .await
            .unwrap();
        remote_dir
    }

    fn write_executable(path: &Path, script: &str) -> PathBuf {
        std::fs::write(path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }
        path.to_path_buf()
    }

    fn write_gh_stub(bin_dir: &Path) -> PathBuf {
        write_executable(
            &bin_dir.join("gh"),
            "#!/bin/sh\nif [ \"$1\" = pr ] && [ \"$2\" = create ]; then\n  echo https://github.com/example/repo/pull/1\n  exit 0\nfi\nexit 1\n",
        )
    }

    /// `gh` stub that records the arguments it was called with, so tests can
    /// assert on `--draft`, `--base` and `--head` without a real GitHub.
    fn write_gh_arg_recorder(bin_dir: &Path) -> PathBuf {
        let log = bin_dir.join("args.txt");
        write_executable(
            &bin_dir.join("gh"),
            &format!(
                "#!/bin/sh\necho \"$@\" > {}\necho https://github.com/example/repo/pull/2\n",
                log.display()
            ),
        )
    }

    #[tokio::test]
    async fn commit_checkout_skips_a_clean_tree() {
        let dir = tempdir().unwrap();
        let cwd = init_repo(dir.path()).await;
        let result = commit_checkout(&cwd, "unused").await.unwrap();
        assert!(!result.committed);
    }

    #[tokio::test]
    async fn commit_checkout_creates_a_commit_when_dirty() {
        let dir = tempdir().unwrap();
        let cwd = init_repo(dir.path()).await;
        fs::write(dir.path().join("NOTE.md"), "work\n")
            .await
            .unwrap();
        let result = commit_checkout(&cwd, "isolated work").await.unwrap();
        assert!(result.committed);
        let subject = run_git(&cwd, &["log", "-1", "--format=%s"]).await.unwrap();
        assert_eq!(subject.trim(), "isolated work");
    }

    #[tokio::test]
    async fn merge_refuses_a_dirty_project_folder() {
        let project_dir = tempdir().unwrap();
        let project = init_repo(project_dir.path()).await;
        let variants = tempdir().unwrap();
        let variant = create_variant(&project, "ship0001", variants.path()).await;
        fs::write(Path::new(&variant.path).join("WORK.md"), "isolated\n")
            .await
            .unwrap();
        fs::write(project_dir.path().join("DIRTY.md"), "nope\n")
            .await
            .unwrap();

        let error = ship_variant(&project, &variant, "land it", ShipThreadMode::Merge)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("uncommitted changes"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn merge_lands_variant_commits_when_the_project_folder_is_clean() {
        let project_dir = tempdir().unwrap();
        let project = init_repo(project_dir.path()).await;
        let variants = tempdir().unwrap();
        let variant = create_variant(&project, "ship0002", variants.path()).await;
        fs::write(Path::new(&variant.path).join("WORK.md"), "isolated\n")
            .await
            .unwrap();

        let result = ship_variant(&project, &variant, "land it", ShipThreadMode::Merge)
            .await
            .unwrap();
        assert_eq!(result.mode, ShipThreadMode::Merge);
        assert!(result.committed);
        assert!(project_dir.path().join("WORK.md").is_file());
        // No origin here, so the merge landed locally and nothing was pushed.
        assert!(!result.pushed);
    }

    #[tokio::test]
    async fn merge_reports_the_push_when_origin_accepts_it() {
        let project_dir = tempdir().unwrap();
        let project = init_repo(project_dir.path()).await;
        let _remote = add_bare_origin(&project).await;
        let variants = tempdir().unwrap();
        let variant = create_variant(&project, "ship0007", variants.path()).await;
        fs::write(Path::new(&variant.path).join("WORK.md"), "isolated\n")
            .await
            .unwrap();

        let result = ship_variant(&project, &variant, "land it", ShipThreadMode::Merge)
            .await
            .unwrap();
        assert!(result.pushed);
    }

    #[tokio::test]
    async fn pull_request_fails_clearly_when_gh_is_missing() {
        let project_dir = tempdir().unwrap();
        let project = init_repo(project_dir.path()).await;
        let _remote = add_bare_origin(&project).await;
        let variants = tempdir().unwrap();
        let variant = create_variant(&project, "ship0003", variants.path()).await;

        let error = ship_variant_with_gh(
            &project,
            &variant,
            "open pr",
            ShipThreadMode::Pr,
            "/nonexistent/gh",
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("GitHub CLI"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn pull_request_uses_gh_when_available() {
        let project_dir = tempdir().unwrap();
        let project = init_repo(project_dir.path()).await;
        let _remote = add_bare_origin(&project).await;
        let variants = tempdir().unwrap();
        let variant = create_variant(&project, "ship0004", variants.path()).await;
        fs::write(Path::new(&variant.path).join("WORK.md"), "isolated\n")
            .await
            .unwrap();

        let bin_dir = tempdir().unwrap();
        let gh = write_gh_stub(bin_dir.path());

        let result = ship_variant_with_gh(
            &project,
            &variant,
            "open pr",
            ShipThreadMode::Pr,
            gh.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(result.mode, ShipThreadMode::Pr);
        assert!(result.committed);
        assert_eq!(
            result.url.as_deref(),
            Some("https://github.com/example/repo/pull/1")
        );
    }

    #[tokio::test]
    async fn draft_pull_request_passes_the_draft_flag() {
        let project_dir = tempdir().unwrap();
        let project = init_repo(project_dir.path()).await;
        let _remote = add_bare_origin(&project).await;
        let variants = tempdir().unwrap();
        let variant = create_variant(&project, "ship0005", variants.path()).await;

        let bin_dir = tempdir().unwrap();
        let gh = write_gh_arg_recorder(bin_dir.path());

        let result = ship_variant_with_gh(
            &project,
            &variant,
            "open draft",
            ShipThreadMode::DraftPr,
            gh.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(result.mode, ShipThreadMode::DraftPr);
        let recorded = std::fs::read_to_string(bin_dir.path().join("args.txt")).unwrap();
        assert!(recorded.contains("--draft"), "gh args were: {recorded}");
        assert!(
            recorded.contains(&format!("--head {}", variant.branch)),
            "gh args were: {recorded}"
        );
        assert!(recorded.contains("--base main"), "gh args were: {recorded}");
    }

    #[tokio::test]
    async fn ship_falls_back_to_main_when_the_variant_has_no_base_branch() {
        let project_dir = tempdir().unwrap();
        let project = init_repo(project_dir.path()).await;
        let variants = tempdir().unwrap();
        let mut variant = create_variant(&project, "ship0006", variants.path()).await;
        variant.base_branch = None;

        let result = ship_variant(&project, &variant, "land it", ShipThreadMode::Merge)
            .await
            .unwrap();
        assert_eq!(result.base, "main");
    }
}
