use std::{
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use falcondeck_core::{WorkspaceFileResponse, WorkspaceFilesResponse, WriteWorkspaceFileRequest};
use tokio::{fs, process::Command, task};

use crate::error::DaemonError;

const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 1_000_000;
const FALLBACK_IGNORED_DIRECTORIES: &[&str] =
    &[".git", "node_modules", "target", ".next", "dist", "build"];

pub async fn list_files(workspace_path: &str) -> Result<WorkspaceFilesResponse, DaemonError> {
    let output = Command::new("git")
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(workspace_path)
        .output()
        .await;

    if let Ok(output) = output
        && output.status.success()
    {
        let mut files = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .filter_map(|path| std::str::from_utf8(path).ok().map(str::to_owned))
            .collect::<Vec<_>>();
        files.sort_unstable();
        let truncated = files.len() > MAX_FILES;
        files.truncate(MAX_FILES);
        return Ok(WorkspaceFilesResponse { files, truncated });
    }

    let root = fs::canonicalize(workspace_path).await?;
    task::spawn_blocking(move || list_files_from_disk(&root))
        .await
        .map_err(|error| DaemonError::Rpc(format!("workspace file listing failed: {error}")))?
}

pub async fn read_file(
    workspace_path: &str,
    relative_path: &str,
) -> Result<WorkspaceFileResponse, DaemonError> {
    let full_path = resolve_existing_file(workspace_path, relative_path).await?;
    let metadata = fs::metadata(&full_path).await?;
    let version = file_version(&metadata);
    if metadata.len() > MAX_FILE_BYTES {
        return Ok(WorkspaceFileResponse {
            path: relative_path.to_string(),
            content: None,
            is_binary: false,
            truncated: true,
            version,
        });
    }

    let bytes = fs::read(full_path).await?;
    let (content, is_binary) = match String::from_utf8(bytes) {
        Ok(content) => (Some(content), false),
        Err(_) => (None, true),
    };
    Ok(WorkspaceFileResponse {
        path: relative_path.to_string(),
        content,
        is_binary,
        truncated: false,
        version,
    })
}

pub async fn write_file(
    workspace_path: &str,
    relative_path: &str,
    request: &WriteWorkspaceFileRequest,
) -> Result<WorkspaceFileResponse, DaemonError> {
    if request.content.len() as u64 > MAX_FILE_BYTES {
        return Err(DaemonError::BadRequest(
            "file is too large for the built-in editor".to_string(),
        ));
    }
    let full_path = resolve_existing_file(workspace_path, relative_path).await?;
    let metadata = fs::metadata(&full_path).await?;
    if request.expected_version.is_some() && request.expected_version != file_version(&metadata) {
        return Err(DaemonError::BadRequest(
            "file changed on disk; reload it before saving".to_string(),
        ));
    }

    fs::write(&full_path, request.content.as_bytes()).await?;
    read_file(workspace_path, relative_path).await
}

async fn resolve_existing_file(
    workspace_path: &str,
    relative_path: &str,
) -> Result<PathBuf, DaemonError> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(DaemonError::BadRequest(
            "invalid workspace file path".to_string(),
        ));
    }

    let root = fs::canonicalize(workspace_path).await?;
    let full_path = fs::canonicalize(root.join(relative))
        .await
        .map_err(|_| DaemonError::NotFound("workspace file not found".to_string()))?;
    if !full_path.starts_with(&root) {
        return Err(DaemonError::BadRequest(
            "workspace file path escapes the project".to_string(),
        ));
    }
    if !fs::metadata(&full_path).await?.is_file() {
        return Err(DaemonError::BadRequest(
            "workspace path is not a file".to_string(),
        ));
    }
    Ok(full_path)
}

fn file_version(metadata: &std::fs::Metadata) -> Option<String> {
    let modified_nanos = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!("{modified_nanos}:{}", metadata.len()))
}

fn list_files_from_disk(root: &Path) -> Result<WorkspaceFilesResponse, DaemonError> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut truncated = false;

    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| FALLBACK_IGNORED_DIRECTORIES.contains(&name))
                {
                    continue;
                }
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Ok(relative) = entry.path().strip_prefix(root).map(Path::to_path_buf) else {
                continue;
            };
            let Some(relative) = relative.to_str() else {
                continue;
            };
            files.push(relative.replace(std::path::MAIN_SEPARATOR, "/"));
            if files.len() == MAX_FILES {
                truncated = true;
                break;
            }
        }
        if truncated {
            break;
        }
    }

    files.sort_unstable();
    Ok(WorkspaceFilesResponse { files, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn read_file_should_reject_parent_path() {
        let root = tempdir().unwrap();
        let error = read_file(root.path().to_str().unwrap(), "../outside.txt")
            .await
            .unwrap_err();
        assert!(matches!(error, DaemonError::BadRequest(_)));
    }

    #[tokio::test]
    async fn write_file_should_detect_external_change() {
        let root = tempdir().unwrap();
        let path = root.path().join("main.rs");
        fs::write(&path, "one").await.unwrap();
        let original = read_file(root.path().to_str().unwrap(), "main.rs")
            .await
            .unwrap();
        fs::write(&path, "two with a different size").await.unwrap();
        let error = write_file(
            root.path().to_str().unwrap(),
            "main.rs",
            &WriteWorkspaceFileRequest {
                content: "three".to_string(),
                expected_version: original.version,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, DaemonError::BadRequest(_)));
    }
}
