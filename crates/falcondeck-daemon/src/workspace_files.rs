use std::{
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use falcondeck_core::{WorkspaceFileResponse, WorkspaceFilesResponse, WriteWorkspaceFileRequest};
use tokio::{fs, process::Command, task};

use crate::error::DaemonError;

const MAX_FILES: usize = 20_000;
/// A search walks the whole tree instead of the first `MAX_FILES` entries, so
/// its results get their own, much smaller budget.
const MAX_SEARCH_RESULTS: usize = 500;
const MAX_FILE_BYTES: u64 = 1_000_000;
/// Previewable media can be larger than the text editor budget. 16 MB stays
/// under the relay websocket cap once base64-encoded.
const MAX_MEDIA_BYTES: u64 = 16_000_000;
const FALLBACK_IGNORED_DIRECTORIES: &[&str] =
    &[".git", "node_modules", "target", ".next", "dist", "build"];

/// Lists workspace files, or — when `query` is set — the paths matching it.
///
/// The unfiltered listing stops at `MAX_FILES`, which on a large repository
/// silently drops everything sorting after the cut. Searching therefore has to
/// happen here rather than over the response, or a query can never reach the
/// paths the cap removed.
pub async fn list_files(
    workspace_path: &str,
    query: Option<&str>,
) -> Result<WorkspaceFilesResponse, DaemonError> {
    let needle = query
        .map(|query| query.trim().to_lowercase())
        .filter(|query| !query.is_empty());
    let limit = if needle.is_some() {
        MAX_SEARCH_RESULTS
    } else {
        MAX_FILES
    };
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
            .filter(|path| matches_needle(path, needle.as_deref()))
            .collect::<Vec<_>>();
        files.sort_unstable();
        let truncated = files.len() > limit;
        files.truncate(limit);
        return Ok(WorkspaceFilesResponse { files, truncated });
    }

    let root = fs::canonicalize(workspace_path).await?;
    task::spawn_blocking(move || list_files_from_disk(&root, needle.as_deref(), limit))
        .await
        .map_err(|error| DaemonError::Rpc(format!("workspace file listing failed: {error}")))?
}

fn matches_needle(path: &str, needle: Option<&str>) -> bool {
    needle.is_none_or(|needle| path.to_lowercase().contains(needle))
}

pub async fn read_file(
    workspace_path: &str,
    relative_path: &str,
) -> Result<WorkspaceFileResponse, DaemonError> {
    let full_path = resolve_existing_file(workspace_path, relative_path).await?;
    let metadata = fs::metadata(&full_path).await?;
    let version = file_version(&metadata);
    let mime_type = preview_mime_type(relative_path);
    let max_bytes = if mime_type.is_some() {
        MAX_MEDIA_BYTES
    } else {
        MAX_FILE_BYTES
    };
    let size_bytes = Some(metadata.len());
    if metadata.len() > max_bytes {
        return Ok(WorkspaceFileResponse {
            path: relative_path.to_string(),
            content: None,
            is_binary: false,
            truncated: true,
            version,
            content_base64: None,
            mime_type: mime_type.map(str::to_string),
            size_bytes,
        });
    }

    let bytes = fs::read(full_path).await?;
    match String::from_utf8(bytes) {
        Ok(content) => Ok(WorkspaceFileResponse {
            path: relative_path.to_string(),
            content: Some(content),
            is_binary: false,
            truncated: false,
            version,
            content_base64: None,
            mime_type: mime_type.map(str::to_string),
            size_bytes,
        }),
        Err(error) => {
            let bytes = error.into_bytes();
            let content_base64 = mime_type.map(|_| BASE64.encode(&bytes));
            Ok(WorkspaceFileResponse {
                path: relative_path.to_string(),
                content: None,
                is_binary: true,
                truncated: false,
                version,
                content_base64,
                mime_type: mime_type.map(str::to_string),
                size_bytes,
            })
        }
    }
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
    let requested = Path::new(relative_path);
    if requested.as_os_str().is_empty() {
        return Err(DaemonError::BadRequest(
            "invalid workspace file path".to_string(),
        ));
    }

    let root = fs::canonicalize(workspace_path).await?;
    // Tool calls often hand us an absolute path. Accept those that resolve
    // inside the workspace; relative paths still cannot contain `.` / `..`.
    let full_path = if requested.is_absolute() {
        fs::canonicalize(requested)
            .await
            .map_err(|_| DaemonError::NotFound("workspace file not found".to_string()))?
    } else {
        if requested
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(DaemonError::BadRequest(
                "invalid workspace file path".to_string(),
            ));
        }
        fs::canonicalize(root.join(requested))
            .await
            .map_err(|_| DaemonError::NotFound("workspace file not found".to_string()))?
    };
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

fn preview_mime_type(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "tif" | "tiff" => "image/tiff",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "opus" => "audio/ogg",
        _ => return None,
    })
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

fn list_files_from_disk(
    root: &Path,
    needle: Option<&str>,
    limit: usize,
) -> Result<WorkspaceFilesResponse, DaemonError> {
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
            let relative = relative.replace(std::path::MAIN_SEPARATOR, "/");
            if !matches_needle(&relative, needle) {
                continue;
            }
            files.push(relative);
            if files.len() == limit {
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
    async fn list_files_should_match_the_query_case_insensitively() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/qa")).await.unwrap();
        fs::create_dir_all(root.path().join("src")).await.unwrap();
        fs::write(root.path().join("docs/qa/2026-09-mobile-web-audit.md"), "")
            .await
            .unwrap();
        fs::write(root.path().join("src/main.rs"), "").await.unwrap();

        let response = list_files(root.path().to_str().unwrap(), Some("MOBILE-WEB"))
            .await
            .unwrap();

        assert_eq!(response.files, vec!["docs/qa/2026-09-mobile-web-audit.md"]);
        assert!(!response.truncated);
    }

    #[tokio::test]
    async fn list_files_should_search_untracked_files_in_a_git_repository() {
        let root = tempdir().unwrap();
        let initialised = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root.path())
            .status()
            .is_ok_and(|status| status.success());
        if !initialised {
            return;
        }
        fs::create_dir_all(root.path().join("docs/qa")).await.unwrap();
        fs::write(root.path().join("docs/qa/2026-09-mobile-web-audit.md"), "")
            .await
            .unwrap();
        fs::write(root.path().join("README.md"), "").await.unwrap();

        let response = list_files(root.path().to_str().unwrap(), Some("mobile-web-audit"))
            .await
            .unwrap();

        assert_eq!(response.files, vec!["docs/qa/2026-09-mobile-web-audit.md"]);
    }

    #[tokio::test]
    async fn list_files_should_treat_a_blank_query_as_no_filter() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("notes.md"), "").await.unwrap();

        let response = list_files(root.path().to_str().unwrap(), Some("   "))
            .await
            .unwrap();

        assert_eq!(response.files, vec!["notes.md"]);
    }

    #[test]
    fn list_files_from_disk_should_search_past_the_result_limit() {
        let root = tempdir().unwrap();
        // Names chosen so the matches sort after the non-matches: a search that
        // capped the listing first would never reach them.
        for index in 0..8 {
            std::fs::write(root.path().join(format!("aaa-{index}.txt")), "").unwrap();
        }
        std::fs::write(root.path().join("zzz-wanted.md"), "").unwrap();

        let response = list_files_from_disk(root.path(), Some("wanted"), 2).unwrap();

        assert_eq!(response.files, vec!["zzz-wanted.md"]);
        assert!(!response.truncated);
    }

    #[test]
    fn list_files_from_disk_should_flag_truncated_matches() {
        let root = tempdir().unwrap();
        for index in 0..4 {
            std::fs::write(root.path().join(format!("wanted-{index}.txt")), "").unwrap();
        }

        let response = list_files_from_disk(root.path(), Some("wanted"), 2).unwrap();

        assert_eq!(response.files.len(), 2);
        assert!(response.truncated);
    }

    #[tokio::test]
    async fn read_file_should_reject_parent_path() {
        let root = tempdir().unwrap();
        let error = read_file(root.path().to_str().unwrap(), "../outside.txt")
            .await
            .unwrap_err();
        assert!(matches!(error, DaemonError::BadRequest(_)));
    }

    #[tokio::test]
    async fn read_file_should_accept_absolute_path_inside_workspace() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("notes.md"), "hello")
            .await
            .unwrap();
        let absolute = root.path().join("notes.md");
        let file = read_file(root.path().to_str().unwrap(), absolute.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(file.content.as_deref(), Some("hello"));
    }

    #[tokio::test]
    async fn read_file_should_reject_absolute_path_outside_workspace() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secrets.txt"), "nope")
            .await
            .unwrap();
        let error = read_file(
            root.path().to_str().unwrap(),
            outside.path().join("secrets.txt").to_str().unwrap(),
        )
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

    #[test]
    fn preview_mime_type_should_map_media_extensions() {
        assert_eq!(preview_mime_type("qa/shot.PNG"), Some("image/png"));
        assert_eq!(preview_mime_type("clip.webm"), Some("video/webm"));
        assert_eq!(preview_mime_type("voice.m4a"), Some("audio/mp4"));
        assert_eq!(preview_mime_type("logo.svg"), Some("image/svg+xml"));
        assert_eq!(preview_mime_type("src/main.rs"), None);
    }

    #[tokio::test]
    async fn read_file_should_return_base64_for_images() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("shot.png"), MINIMAL_PNG)
            .await
            .unwrap();
        let file = read_file(root.path().to_str().unwrap(), "shot.png")
            .await
            .unwrap();
        assert!(file.is_binary);
        assert_eq!(file.mime_type.as_deref(), Some("image/png"));
        assert_eq!(file.size_bytes, Some(MINIMAL_PNG.len() as u64));
        assert_eq!(file.content, None);
        let encoded = BASE64.encode(MINIMAL_PNG);
        assert_eq!(file.content_base64.as_deref(), Some(encoded.as_str()));
    }

    #[tokio::test]
    async fn read_file_should_keep_unknown_binaries_opaque() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("blob.bin"), [0x00, 0xff, 0x89])
            .await
            .unwrap();
        let file = read_file(root.path().to_str().unwrap(), "blob.bin")
            .await
            .unwrap();
        assert!(file.is_binary);
        assert_eq!(file.content, None);
        assert_eq!(file.content_base64, None);
        assert_eq!(file.mime_type, None);
    }

    #[tokio::test]
    async fn read_file_should_tag_svg_as_previewable_text() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("logo.svg"),
            "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        )
        .await
        .unwrap();
        let file = read_file(root.path().to_str().unwrap(), "logo.svg")
            .await
            .unwrap();
        assert!(!file.is_binary);
        assert_eq!(file.mime_type.as_deref(), Some("image/svg+xml"));
        assert!(file.content.is_some());
        assert_eq!(file.content_base64, None);
    }

    const MINIMAL_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
}
