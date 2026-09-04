use falcondeck_core::{
    GitBranchesResponse, GitDiffResponse, GitFileStatus, GitStatusEntry, GitStatusResponse,
};
use tokio::process::Command;

use crate::error::DaemonError;

pub async fn git_status(workspace_path: &str) -> Result<GitStatusResponse, DaemonError> {
    // Get branch name
    let branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(workspace_path)
        .output()
        .await
        .map_err(|e| DaemonError::Rpc(format!("failed to run git: {e}")))?;

    let branch = if branch_output.status.success() {
        let b = String::from_utf8_lossy(&branch_output.stdout)
            .trim()
            .to_string();
        if b.is_empty() || b == "HEAD" {
            None
        } else {
            Some(b)
        }
    } else {
        None
    };

    // Get file status
    let status_output = Command::new("git")
        .args(["status", "--porcelain=v1", "--untracked-files=all"])
        .current_dir(workspace_path)
        .output()
        .await
        .map_err(|e| DaemonError::Rpc(format!("failed to run git status: {e}")))?;

    if !status_output.status.success() {
        return Err(DaemonError::Rpc(
            "git status failed — not a git repository?".to_string(),
        ));
    }

    let status_text = String::from_utf8_lossy(&status_output.stdout);
    let mut entries: Vec<GitStatusEntry> = status_text
        .lines()
        .filter(|line| line.len() >= 4)
        .map(|line| {
            let xy = &line[..2];
            let raw_path = &line[3..];

            let (status, path) = match xy.trim() {
                "A" | "AM" => (GitFileStatus::Added, raw_path.to_string()),
                "M" | "MM" | "MT" => (GitFileStatus::Modified, raw_path.to_string()),
                "D" => (GitFileStatus::Deleted, raw_path.to_string()),
                "R" | "RM" => {
                    if let Some((_old, new)) = raw_path.split_once(" -> ") {
                        (GitFileStatus::Renamed, new.to_string())
                    } else {
                        (GitFileStatus::Renamed, raw_path.to_string())
                    }
                }
                "C" => (GitFileStatus::Copied, raw_path.to_string()),
                "??" => (GitFileStatus::Untracked, raw_path.to_string()),
                s if s.starts_with('A') => (GitFileStatus::Added, raw_path.to_string()),
                s if s.starts_with('M') => (GitFileStatus::Modified, raw_path.to_string()),
                s if s.starts_with('D') => (GitFileStatus::Deleted, raw_path.to_string()),
                s if s.starts_with('R') => {
                    if let Some((_old, new)) = raw_path.split_once(" -> ") {
                        (GitFileStatus::Renamed, new.to_string())
                    } else {
                        (GitFileStatus::Renamed, raw_path.to_string())
                    }
                }
                _ => (GitFileStatus::Modified, raw_path.to_string()),
            };

            GitStatusEntry {
                path,
                status,
                insertions: None,
                deletions: None,
            }
        })
        .collect();

    // Get numstat for insertion/deletion counts
    let numstat_output = Command::new("git")
        .args(["diff", "--numstat"])
        .current_dir(workspace_path)
        .output()
        .await;

    if let Ok(output) = numstat_output
        && output.status.success()
    {
        let numstat_text = String::from_utf8_lossy(&output.stdout);
        for line in numstat_text.lines() {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() == 3 {
                let insertions = parts[0].parse::<u32>().ok();
                let deletions = parts[1].parse::<u32>().ok();
                let path = parts[2];
                if let Some(entry) = entries.iter_mut().find(|e| e.path == path) {
                    entry.insertions = insertions;
                    entry.deletions = deletions;
                }
            }
        }
    }

    // Also check staged numstat
    let staged_numstat = Command::new("git")
        .args(["diff", "--numstat", "--cached"])
        .current_dir(workspace_path)
        .output()
        .await;

    if let Ok(output) = staged_numstat
        && output.status.success()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() == 3 {
                let insertions = parts[0].parse::<u32>().ok();
                let deletions = parts[1].parse::<u32>().ok();
                let path = parts[2];
                if let Some(entry) = entries.iter_mut().find(|e| e.path == path) {
                    if entry.insertions.is_none() {
                        entry.insertions = insertions;
                    }
                    if entry.deletions.is_none() {
                        entry.deletions = deletions;
                    }
                }
            }
        }
    }

    Ok(GitStatusResponse { branch, entries })
}

pub async fn git_branches(workspace_path: &str) -> Result<GitBranchesResponse, DaemonError> {
    let current_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(workspace_path)
        .output()
        .await
        .map_err(|e| DaemonError::Rpc(format!("failed to run git: {e}")))?;

    let current = if current_output.status.success() {
        let b = String::from_utf8_lossy(&current_output.stdout)
            .trim()
            .to_string();
        if b.is_empty() || b == "HEAD" {
            None
        } else {
            Some(b)
        }
    } else {
        None
    };

    let list_output = Command::new("git")
        .args([
            "for-each-ref",
            "refs/heads/",
            "--sort=-committerdate",
            "--format=%(refname:short)",
        ])
        .current_dir(workspace_path)
        .output()
        .await
        .map_err(|e| DaemonError::Rpc(format!("failed to run git for-each-ref: {e}")))?;

    if !list_output.status.success() {
        return Err(DaemonError::Rpc(
            "git for-each-ref failed — not a git repository?".to_string(),
        ));
    }

    let branches = String::from_utf8_lossy(&list_output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();

    Ok(GitBranchesResponse { current, branches })
}

pub async fn git_checkout(
    workspace_path: &str,
    branch: &str,
    create: bool,
) -> Result<GitBranchesResponse, DaemonError> {
    // Refuse names that read as flags or revision expressions; branch pickers
    // only ever hand us plain ref names.
    if branch.is_empty() || branch.starts_with('-') || branch.contains("..") {
        return Err(DaemonError::Rpc(format!("invalid branch name: {branch}")));
    }

    let mut args = vec!["checkout"];
    if create {
        args.push("-b");
    }
    args.push(branch);
    // `--` guards against a branch name shadowing a path.
    if !create {
        args.push("--");
    }

    let output = Command::new("git")
        .args(&args)
        .current_dir(workspace_path)
        .output()
        .await
        .map_err(|e| DaemonError::Rpc(format!("failed to run git checkout: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(DaemonError::Rpc(
            stderr
                .trim()
                .lines()
                .last()
                .unwrap_or("git checkout failed")
                .to_string(),
        ));
    }

    git_branches(workspace_path).await
}

pub async fn git_diff(
    workspace_path: &str,
    path: Option<&str>,
    status: Option<&GitFileStatus>,
) -> Result<GitDiffResponse, DaemonError> {
    let mut args = vec!["diff"];
    if let Some(p) = path {
        args.push("--");
        args.push(p);
    }

    let output = Command::new("git")
        .args(&args)
        .current_dir(workspace_path)
        .output()
        .await
        .map_err(|e| DaemonError::Rpc(format!("failed to run git diff: {e}")))?;

    if !output.status.success() {
        return Err(DaemonError::Rpc("git diff failed".to_string()));
    }

    let diff = String::from_utf8_lossy(&output.stdout).to_string();
    // Untracked, gitignored, and otherwise undiffable files still have
    // contents the sidebar can show. Skip deleted paths: the file is gone.
    let content = if diff.is_empty() && !matches!(status, Some(GitFileStatus::Deleted)) {
        load_file_content(workspace_path, path).await
    } else {
        None
    };
    Ok(GitDiffResponse { diff, content })
}

async fn load_file_content(workspace_path: &str, path: Option<&str>) -> Option<String> {
    let path = path?;
    match crate::workspace_files::read_file(workspace_path, path).await {
        Ok(file) if !file.is_binary => file.content,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::tempdir;
    use tokio::fs;

    async fn run_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn git_status_lists_untracked_files_individually() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();

        run_git(repo, &["init"]).await;
        fs::create_dir_all(repo.join("content/posts"))
            .await
            .unwrap();
        fs::write(repo.join("content/posts/new.md"), "# Hello\n")
            .await
            .unwrap();

        let status = git_status(repo.to_str().unwrap()).await.unwrap();
        assert!(status.entries.iter().any(|entry| {
            entry.path == "content/posts/new.md" && entry.status == GitFileStatus::Untracked
        }));
        assert!(
            !status
                .entries
                .iter()
                .any(|entry| entry.path == "content/posts/")
        );
    }

    #[tokio::test]
    async fn git_branches_lists_and_checkout_switches_and_creates() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();

        run_git(repo, &["init", "--initial-branch=main"]).await;
        run_git(repo, &["config", "user.email", "test@example.com"]).await;
        run_git(repo, &["config", "user.name", "Test"]).await;
        fs::write(repo.join("README.md"), "hello\n").await.unwrap();
        run_git(repo, &["add", "."]).await;
        run_git(repo, &["commit", "-m", "init"]).await;
        run_git(repo, &["branch", "feature/one"]).await;

        let path = repo.to_str().unwrap();
        let listed = git_branches(path).await.unwrap();
        assert_eq!(listed.current.as_deref(), Some("main"));
        assert!(listed.branches.contains(&"main".to_string()));
        assert!(listed.branches.contains(&"feature/one".to_string()));

        let switched = git_checkout(path, "feature/one", false).await.unwrap();
        assert_eq!(switched.current.as_deref(), Some("feature/one"));

        let created = git_checkout(path, "feature/two", true).await.unwrap();
        assert_eq!(created.current.as_deref(), Some("feature/two"));
        assert!(created.branches.contains(&"feature/two".to_string()));

        let missing = git_checkout(path, "does-not-exist", false).await;
        assert!(missing.is_err());
        let flagged = git_checkout(path, "--force", false).await;
        assert!(flagged.is_err());
    }

    #[tokio::test]
    async fn git_diff_returns_content_for_untracked_file() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();

        run_git(repo, &["init"]).await;
        fs::write(repo.join("draft.md"), "line one\nline two\n")
            .await
            .unwrap();

        let diff = git_diff(
            repo.to_str().unwrap(),
            Some("draft.md"),
            Some(&GitFileStatus::Untracked),
        )
        .await
        .unwrap();

        assert_eq!(diff.diff, "");
        assert_eq!(diff.content.as_deref(), Some("line one\nline two\n"));
    }

    #[tokio::test]
    async fn git_diff_returns_content_when_empty_regardless_of_status() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();

        run_git(repo, &["init"]).await;
        fs::write(repo.join("draft.md"), "line one\n")
            .await
            .unwrap();

        let diff = git_diff(
            repo.to_str().unwrap(),
            Some("draft.md"),
            Some(&GitFileStatus::Modified),
        )
        .await
        .unwrap();

        assert_eq!(diff.diff, "");
        assert_eq!(diff.content.as_deref(), Some("line one\n"));
    }

    #[tokio::test]
    async fn git_diff_returns_content_for_gitignored_file() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();

        run_git(repo, &["init"]).await;
        fs::write(repo.join(".gitignore"), "secret.md\n")
            .await
            .unwrap();
        fs::write(repo.join("secret.md"), "hidden\n").await.unwrap();

        let diff = git_diff(repo.to_str().unwrap(), Some("secret.md"), None)
            .await
            .unwrap();

        assert_eq!(diff.diff, "");
        assert_eq!(diff.content.as_deref(), Some("hidden\n"));
    }

    #[tokio::test]
    async fn git_diff_skips_content_for_deleted_status() {
        let temp_dir = tempdir().unwrap();
        let repo = temp_dir.path();

        run_git(repo, &["init"]).await;
        fs::write(repo.join("gone.md"), "still on disk\n")
            .await
            .unwrap();

        let diff = git_diff(
            repo.to_str().unwrap(),
            Some("gone.md"),
            Some(&GitFileStatus::Deleted),
        )
        .await
        .unwrap();

        assert_eq!(diff.content, None);
    }
}
