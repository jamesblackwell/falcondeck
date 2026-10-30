//! Bounded, immutable Git working-copy exports and explicit cloud-delta imports.
//!
//! Git is used only for discovery. Capturing and importing never stage, stash,
//! commit, or otherwise write the repository's index.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFile {
    pub path: String,
    #[serde(alias = "content_base64")]
    pub content_base64: String,
    pub executable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCapture {
    pub files: Vec<SourceFile>,
    #[serde(alias = "base_head")]
    pub base_head: Option<String>,
    #[serde(alias = "tree_hash")]
    pub tree_hash: String,
    #[serde(alias = "excluded_paths")]
    pub excluded_paths: Vec<String>,
    #[serde(alias = "total_bytes")]
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDelta {
    pub files: Vec<SourceFile>,
    #[serde(alias = "deleted_paths")]
    pub deleted_paths: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct CaptureLimits {
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
}

impl Default for CaptureLimits {
    fn default() -> Self {
        Self {
            max_files: 10_000,
            max_total_bytes: 32 * 1024 * 1024,
            max_file_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("invalid cloud source: {0}")]
    Invalid(String),
    #[error("cloud source exceeds its {0} limit")]
    Limit(&'static str),
    #[error("source changed while being captured; retry when file writes have finished")]
    ChangingSource,
    #[error("local file changed since cloud capture: {0}")]
    Conflict(String),
    #[error("cloud import failed: {0}")]
    Import(String),
    #[error("cloud source I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("cloud source background task failed: {0}")]
    Task(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub applied_paths: Vec<String>,
    pub deleted_paths: Vec<String>,
}

pub async fn capture_source(
    root: &Path,
    limits: CaptureLimits,
) -> Result<SourceCapture, SourceError> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || capture_source_sync(&root, limits))
        .await
        .map_err(|error| SourceError::Task(error.to_string()))?
}

fn capture_source_sync(root: &Path, limits: CaptureLimits) -> Result<SourceCapture, SourceError> {
    let root = repository_root(root)?;
    let before = repository_identity(&root)?;
    let first = capture_pass(&root, limits)?;
    let second = capture_pass(&root, limits)?;
    if first != second || before != repository_identity(&root)? {
        return Err(SourceError::ChangingSource);
    }
    Ok(first)
}

fn capture_pass(root: &Path, limits: CaptureLimits) -> Result<SourceCapture, SourceError> {
    let entries = git(root, &["ls-files", "--stage", "-z"], None)?;
    let mut unsupported = BTreeSet::new();
    for entry in entries
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let tab = entry
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| invalid("invalid Git index entry"))?;
        let path = std::str::from_utf8(&entry[tab + 1..])
            .map_err(|_| invalid("non-UTF-8 paths are unsupported"))?;
        if entry.starts_with(b"160000 ") || entry.starts_with(b"120000 ") {
            unsupported.insert(path.to_owned());
        }
        let header =
            std::str::from_utf8(&entry[..tab]).map_err(|_| invalid("invalid Git index entry"))?;
        if !header.ends_with(" 0") {
            return Err(invalid(
                "resolve Git index conflicts before capturing cloud source",
            ));
        }
    }
    let paths = git(
        root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        None,
    )?;
    let mut candidates = BTreeSet::new();
    let mut excluded_paths = BTreeSet::new();
    for path in paths
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let path =
            std::str::from_utf8(path).map_err(|_| invalid("non-UTF-8 paths are unsupported"))?;
        validate_path(path)?;
        if excluded_path(path) {
            excluded_paths.insert(path.to_owned());
            if excluded_paths.len() > limits.max_files {
                return Err(SourceError::Limit("excluded path count"));
            }
            continue;
        }
        if unsupported.contains(path) {
            return Err(invalid(format!(
                "symlink or submodule is unsupported: {path}"
            )));
        }
        candidates.insert(path.to_owned());
        if candidates.len() > limits.max_files {
            return Err(SourceError::Limit("file count"));
        }
    }
    validate_path_set(candidates.iter().map(String::as_str))?;
    reject_lfs(root, &candidates)?;
    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    for path in candidates {
        let Some((bytes, executable)) = read_source_file(root, &path, limits.max_file_bytes)?
        else {
            // A tracked deletion is part of the captured working state.
            continue;
        };
        if private_key_content(&bytes) {
            excluded_paths.insert(path);
            continue;
        }
        if lfs_pointer(&bytes) {
            return Err(invalid(format!("Git LFS is unsupported: {path}")));
        }
        total_bytes = checked_total(total_bytes, bytes.len(), limits)?;
        files.push(SourceFile {
            path,
            content_base64: STANDARD.encode(bytes),
            executable,
        });
    }
    let tree_hash = hash_files(&files, limits)?;
    Ok(SourceCapture {
        files,
        base_head: head(root)?,
        tree_hash,
        excluded_paths: excluded_paths.into_iter().collect(),
        total_bytes,
    })
}

pub fn validate_capture(capture: &SourceCapture, limits: CaptureLimits) -> Result<(), SourceError> {
    let (files, total) = decode_files(&capture.files, limits)?;
    if capture.excluded_paths.len() > limits.max_files {
        return Err(SourceError::Limit("excluded path count"));
    }
    validate_path_set(capture.excluded_paths.iter().map(String::as_str))?;
    let included: BTreeSet<_> = files.keys().map(|path| path.to_lowercase()).collect();
    if capture
        .excluded_paths
        .iter()
        .any(|path| included.contains(&path.to_lowercase()))
    {
        return Err(invalid("source path is both included and excluded"));
    }
    if total != capture.total_bytes || hash_decoded(&files) != capture.tree_hash {
        return Err(invalid(
            "source manifest hash or size does not match its files",
        ));
    }
    Ok(())
}

/// Compare against the captured working tree, so existing local dirt is never
/// mistaken for a cloud-authored change.
pub fn delta_between(
    baseline: &SourceCapture,
    output: &SourceCapture,
) -> Result<SourceDelta, SourceError> {
    let limits = CaptureLimits::default();
    validate_capture(baseline, limits)?;
    validate_capture(output, limits)?;
    let before: BTreeMap<_, _> = baseline
        .files
        .iter()
        .map(|file| (&file.path, file))
        .collect();
    let after: BTreeMap<_, _> = output.files.iter().map(|file| (&file.path, file)).collect();
    Ok(SourceDelta {
        files: after
            .iter()
            .filter(|(path, file)| before.get(*path).copied() != Some(**file))
            .map(|(_, file)| (*file).clone())
            .collect(),
        deleted_paths: before
            .keys()
            .filter(|path| !after.contains_key(*path))
            .map(|path| (*path).clone())
            .collect(),
    })
}

pub async fn import_delta(
    root: &Path,
    baseline: &SourceCapture,
    delta: &SourceDelta,
    limits: CaptureLimits,
) -> Result<ImportResult, SourceError> {
    let (root, baseline, delta) = (root.to_path_buf(), baseline.clone(), delta.clone());
    tokio::task::spawn_blocking(move || import_delta_sync(&root, &baseline, &delta, limits))
        .await
        .map_err(|error| SourceError::Task(error.to_string()))?
}

type DecodedFiles = BTreeMap<String, (Vec<u8>, bool)>;

fn import_delta_sync(
    root: &Path,
    baseline: &SourceCapture,
    delta: &SourceDelta,
    limits: CaptureLimits,
) -> Result<ImportResult, SourceError> {
    let root = repository_root(root)?;
    validate_capture(baseline, limits)?;
    let (base, _) = decode_files(&baseline.files, limits)?;
    let (incoming, _) = decode_files(&delta.files, limits)?;
    let mut affected: BTreeSet<String> = incoming.keys().cloned().collect();
    for path in &delta.deleted_paths {
        validate_included_path(path)?;
        if !affected.insert(path.clone()) {
            return Err(invalid(format!("duplicate cloud result path: {path}")));
        }
        if !base.contains_key(path) {
            return Err(invalid(format!(
                "cloud deletion is absent from the captured baseline: {path}"
            )));
        }
    }
    if affected.len() > limits.max_files {
        return Err(SourceError::Limit("file count"));
    }
    validate_path_set(affected.iter().map(String::as_str))?;
    for path in &affected {
        ensure_matches(&root, path, base.get(path), limits)?;
    }
    if affected.is_empty() {
        return Ok(ImportResult::default());
    }

    let git_dir = PathBuf::from(
        String::from_utf8(git(&root, &["rev-parse", "--absolute-git-dir"], None)?)
            .map_err(|_| invalid("invalid Git directory"))?
            .trim_end(),
    );
    let temporary = git_dir.join(format!("falcondeck-cloud-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&temporary)?;
    let mut created_directories = Vec::new();
    let mut applied: Vec<String> = Vec::new();
    let result = (|| {
        for (index, path) in affected.iter().enumerate() {
            if let Some((bytes, executable)) = incoming.get(path) {
                write_new_file(&temporary.join(index.to_string()), bytes, *executable)?;
            }
        }
        // Preparing all files must succeed before the first source mutation.
        for path in &affected {
            ensure_matches(&root, path, base.get(path), limits)?;
        }
        for path in &affected {
            ensure_parent_directories(&root, path, &mut created_directories)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let directory = open_anchored_parent(&root, path)?
                    .ok_or_else(|| invalid(format!("missing destination parent: {path}")))?;
                if directory.metadata()?.dev() != fs::metadata(&temporary)?.dev() {
                    return Err(invalid("cloud import cannot span filesystems"));
                }
            }
        }
        for (index, path) in affected.iter().enumerate() {
            ensure_matches(&root, path, base.get(path), limits)?;
            if incoming.contains_key(path) {
                replace_from_temporary(
                    &root,
                    path,
                    &temporary.join(index.to_string()),
                    !base.contains_key(path),
                )?;
            } else {
                remove_destination(&root, path)?;
            }
            applied.push(path.clone());
        }
        Ok(ImportResult {
            applied_paths: incoming.keys().cloned().collect(),
            deleted_paths: delta.deleted_paths.clone(),
        })
    })();
    if result.is_err() {
        let mut failures = Vec::new();
        for path in applied.iter().rev() {
            // An editor may have saved since import. Never roll back over it.
            if ensure_matches(&root, path, incoming.get(path), limits).is_err() {
                failures.push(path.clone());
                continue;
            }
            let restored = if let Some((bytes, executable)) = base.get(path) {
                let rollback_file = temporary.join("rollback");
                write_new_file(&rollback_file, bytes, *executable).and_then(|_| {
                    replace_from_temporary(
                        &root,
                        path,
                        &rollback_file,
                        !incoming.contains_key(path),
                    )
                })
            } else {
                remove_destination(&root, path)
            };
            if restored.is_err() {
                failures.push(path.clone());
            }
        }
        for directory in created_directories.iter().rev() {
            let _ = remove_created_directory(&root, directory);
        }
        if !failures.is_empty() {
            let _ = fs::remove_dir_all(&temporary);
            return Err(SourceError::Import(format!(
                "could not restore concurrently changed paths: {}",
                failures.join(", ")
            )));
        }
    }
    let _ = fs::remove_dir_all(&temporary);
    result
}

fn ensure_matches(
    root: &Path,
    path: &str,
    expected: Option<&(Vec<u8>, bool)>,
    limits: CaptureLimits,
) -> Result<(), SourceError> {
    let actual = read_source_file(root, path, limits.max_file_bytes)?;
    if actual.as_ref() != expected {
        return Err(SourceError::Conflict(path.to_owned()));
    }
    Ok(())
}

fn ensure_parent_directories(
    root: &Path,
    path: &str,
    created: &mut Vec<PathBuf>,
) -> Result<(), SourceError> {
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::{ffi::OsStrExt, fs::OpenOptionsExt},
            },
        };
        let mut directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(root)?;
        let mut current = root.to_path_buf();
        for component in Path::new(path)
            .parent()
            .unwrap_or(Path::new(""))
            .components()
        {
            current.push(component);
            let name = CString::new(component.as_os_str().as_bytes())
                .map_err(|_| invalid("invalid path"))?;
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            let mut descriptor =
                unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if descriptor < 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
            {
                if unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o755) } != 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                created.push(current.clone());
                descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            }
            if descriptor < 0 {
                return Err(invalid(format!("unsafe destination parent: {path}")));
            }
            directory = unsafe { File::from_raw_fd(descriptor) };
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let mut current = root.to_path_buf();
        let parent = Path::new(path).parent().unwrap_or(Path::new(""));
        for component in parent.components() {
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => return Err(invalid(format!("unsafe destination parent: {path}"))),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&current)?;
                    created.push(current.clone());
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

fn remove_created_directory(root: &Path, directory: &Path) -> Result<(), SourceError> {
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
        };
        let path = directory
            .strip_prefix(root)
            .map_err(|_| invalid("invalid created directory"))?;
        let parent = open_anchored_parent(
            root,
            path.to_str()
                .ok_or_else(|| invalid("invalid created directory"))?,
        )?
        .ok_or_else(|| invalid("missing created directory parent"))?;
        let name = CString::new(path.file_name().unwrap().as_bytes())
            .map_err(|_| invalid("invalid path"))?;
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::remove_dir(directory).map_err(SourceError::from)
    }
}

fn write_new_file(path: &Path, bytes: &[u8], executable: bool) -> Result<(), SourceError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(if executable { 0o755 } else { 0o644 })
            .custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn decode_files(
    files: &[SourceFile],
    limits: CaptureLimits,
) -> Result<(DecodedFiles, u64), SourceError> {
    if files.len() > limits.max_files {
        return Err(SourceError::Limit("file count"));
    }
    validate_path_set(files.iter().map(|file| file.path.as_str()))?;
    let mut decoded = BTreeMap::new();
    let mut total = 0_u64;
    for file in files {
        validate_included_path(&file.path)?;
        if file.content_base64.len() as u64
            > limits
                .max_file_bytes
                .saturating_add(2)
                .saturating_div(3)
                .saturating_mul(4)
        {
            return Err(SourceError::Limit("file bytes"));
        }
        let bytes = STANDARD
            .decode(&file.content_base64)
            .map_err(|_| invalid(format!("invalid base64 file: {}", file.path)))?;
        if bytes.len() as u64 > limits.max_file_bytes {
            return Err(SourceError::Limit("file bytes"));
        }
        if private_key_content(&bytes) {
            return Err(invalid(format!(
                "private key content is excluded: {}",
                file.path
            )));
        }
        if lfs_pointer(&bytes) {
            return Err(invalid(format!("Git LFS is unsupported: {}", file.path)));
        }
        total = checked_total(total, bytes.len(), limits)?;
        decoded.insert(file.path.clone(), (bytes, file.executable));
    }
    Ok((decoded, total))
}

fn hash_files(files: &[SourceFile], limits: CaptureLimits) -> Result<String, SourceError> {
    let (files, _) = decode_files(files, limits)?;
    Ok(hash_decoded(&files))
}

fn hash_decoded(files: &DecodedFiles) -> String {
    let mut digest = Sha256::new();
    for (path, (bytes, executable)) in files {
        digest.update(path.as_bytes());
        digest.update(b"\0");
        digest.update(if *executable { b"1" } else { b"0" });
        digest.update(b"\0");
        digest.update(format!("{:x}", Sha256::digest(bytes)).as_bytes());
        digest.update(b"\n");
    }
    format!("{:x}", digest.finalize())
}

fn checked_total(total: u64, length: usize, limits: CaptureLimits) -> Result<u64, SourceError> {
    let total = total
        .checked_add(length as u64)
        .ok_or(SourceError::Limit("total bytes"))?;
    if total > limits.max_total_bytes {
        return Err(SourceError::Limit("total bytes"));
    }
    Ok(total)
}

fn validate_path(path: &str) -> Result<(), SourceError> {
    if path.is_empty()
        || path.len() > 1024
        || path.contains(['\\', ':'])
        || path.chars().any(char::is_control)
        || path.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.ends_with([' ', '.'])
        })
        || Path::new(path)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid(format!("unsafe relative path: {path}")));
    }
    Ok(())
}

fn validate_included_path(path: &str) -> Result<(), SourceError> {
    validate_path(path)?;
    if excluded_path(path) {
        return Err(invalid(format!("excluded cloud source path: {path}")));
    }
    Ok(())
}

fn validate_path_set<'a>(paths: impl Iterator<Item = &'a str>) -> Result<(), SourceError> {
    let mut seen = BTreeSet::new();
    for path in paths {
        validate_path(path)?;
        let key = path.to_lowercase();
        if !seen.insert(key) {
            return Err(invalid(format!(
                "duplicate or case-aliased cloud path: {path}"
            )));
        }
    }
    for path in &seen {
        let mut parent = Path::new(path).parent();
        while let Some(candidate) = parent {
            if seen.contains(candidate.to_string_lossy().as_ref()) {
                return Err(invalid(format!("file/parent collision: {path}")));
            }
            parent = candidate.parent();
        }
    }
    Ok(())
}

fn excluded_path(path: &str) -> bool {
    path.split('/').any(|part| {
        let name = part.to_ascii_lowercase();
        matches!(
            name.as_str(),
            ".git"
                | ".hg"
                | ".svn"
                | ".codex"
                | ".claude"
                | ".falcondeck"
                | ".config"
                | ".npm"
                | ".pnpm-store"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | "out"
                | "vendor"
                | "coverage"
                | ".next"
                | ".nuxt"
                | ".turbo"
                | ".cache"
                | ".expo"
                | ".vercel"
                | ".venv"
                | "venv"
                | "__pycache__"
                | "pods"
                | "deriveddata"
                | ".ssh"
                | ".aws"
                | ".azure"
                | ".gnupg"
                | ".kube"
                | ".docker"
                | ".npmrc"
                | ".yarnrc"
                | ".yarnrc.yml"
                | ".pypirc"
                | ".netrc"
                | ".pgpass"
                | ".git-credentials"
                | "auth.json"
                | "id_rsa"
                | "id_dsa"
                | "id_ecdsa"
                | "id_ed25519"
                | "id_rsa.pub"
                | "id_dsa.pub"
                | "id_ecdsa.pub"
                | "id_ed25519.pub"
        ) || name.starts_with(".env")
            || name.starts_with(".secrets")
            || name.starts_with("credentials")
            || name.starts_with("secret")
            || name.starts_with("service-account")
            || name.ends_with(".pem")
            || name.ends_with(".key")
            || name.ends_with(".p12")
            || name.ends_with(".pfx")
            || name.ends_with(".jks")
            || name.ends_with(".keystore")
            || name.ends_with(".mobileprovision")
            || name.ends_with(".tfstate")
            || name.ends_with(".tfstate.backup")
    })
}

fn private_key_content(bytes: &[u8]) -> bool {
    [
        b"-----BEGIN PRIVATE KEY-----".as_slice(),
        b"-----BEGIN RSA PRIVATE KEY-----",
        b"-----BEGIN EC PRIVATE KEY-----",
        b"-----BEGIN OPENSSH PRIVATE KEY-----",
        b"-----BEGIN DSA PRIVATE KEY-----",
        b"-----BEGIN ENCRYPTED PRIVATE KEY-----",
    ]
    .iter()
    .any(|marker| {
        bytes.split(|byte| *byte == b'\n').any(|line| {
            let trimmed = line
                .iter()
                .position(|byte| !byte.is_ascii_whitespace())
                .map(|start| &line[start..])
                .unwrap_or_default();
            trimmed.starts_with(marker)
        })
    })
}

fn lfs_pointer(bytes: &[u8]) -> bool {
    bytes.starts_with(b"version https://git-lfs.github.com/spec/v1\n")
        || bytes.starts_with(b"version https://git-lfs.github.com/spec/v1\r\n")
}

fn read_source_file(
    root: &Path,
    path: &str,
    max_bytes: u64,
) -> Result<Option<(Vec<u8>, bool)>, SourceError> {
    validate_included_path(path)?;
    let mut current = root.to_path_buf();
    let parts: Vec<_> = Path::new(path).components().collect();
    for (index, component) in parts.iter().enumerate() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(invalid(format!("symlinks are unsupported: {path}")));
            }
            Ok(metadata) if index + 1 < parts.len() && !metadata.is_dir() => {
                return Err(invalid(format!("non-directory path parent: {path}")));
            }
            Ok(metadata) if index + 1 == parts.len() && !metadata.is_file() => {
                return Err(invalid(format!(
                    "non-regular files are unsupported: {path}"
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
    }
    #[cfg(unix)]
    let file = match open_anchored_file(root, path)? {
        Some(file) => file,
        None => return Ok(None),
    };
    #[cfg(not(unix))]
    let file = OpenOptions::new().read(true).open(current)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(invalid(format!(
            "non-regular files are unsupported: {path}"
        )));
    }
    if metadata.len() > max_bytes {
        return Err(SourceError::Limit("file bytes"));
    }
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(SourceError::Limit("file bytes"));
    }
    Ok(Some((bytes, executable)))
}

#[cfg(unix)]
fn open_anchored_parent(root: &Path, path: &str) -> Result<Option<File>, SourceError> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
    };
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(root)?;
    for part in Path::new(path)
        .parent()
        .unwrap_or(Path::new(""))
        .components()
    {
        let part =
            CString::new(part.as_os_str().as_bytes()).map_err(|_| invalid("invalid path"))?;
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                part.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(invalid(format!("unsafe or unreadable path parent: {path}")));
        }
        directory = unsafe { File::from_raw_fd(descriptor) };
    }
    Ok(Some(directory))
}

#[cfg(unix)]
fn open_anchored_file(root: &Path, path: &str) -> Result<Option<File>, SourceError> {
    use std::{
        ffi::CString,
        os::fd::{AsRawFd, FromRawFd},
    };
    let Some(directory) = open_anchored_parent(root, path)? else {
        return Ok(None);
    };
    let name = CString::new(
        Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .as_bytes(),
    )
    .map_err(|_| invalid("invalid path"))?;
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(invalid(format!("unsafe or unreadable file: {path}")));
    }
    Ok(Some(unsafe { File::from_raw_fd(descriptor) }))
}

fn replace_from_temporary(
    root: &Path,
    path: &str,
    temporary: &Path,
    create_new: bool,
) -> Result<(), SourceError> {
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
        };
        let directory = open_anchored_parent(root, path)?
            .ok_or_else(|| invalid(format!("missing destination parent: {path}")))?;
        let name = CString::new(Path::new(path).file_name().unwrap().as_bytes())
            .map_err(|_| invalid("invalid path"))?;
        let temporary_name = CString::new(temporary.as_os_str().as_bytes())
            .map_err(|_| invalid("invalid temporary path"))?;
        let outcome = unsafe {
            if create_new {
                libc::linkat(
                    libc::AT_FDCWD,
                    temporary_name.as_ptr(),
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    0,
                )
            } else {
                libc::renameat(
                    libc::AT_FDCWD,
                    temporary_name.as_ptr(),
                    directory.as_raw_fd(),
                    name.as_ptr(),
                )
            }
        };
        if outcome != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                return Err(SourceError::Conflict(path.to_owned()));
            }
            return Err(error.into());
        }
        if create_new {
            let _ = fs::remove_file(temporary);
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        if create_new {
            fs::hard_link(temporary, root.join(path))?;
            fs::remove_file(temporary)?;
        } else {
            fs::rename(temporary, root.join(path))?;
        }
        Ok(())
    }
}

fn remove_destination(root: &Path, path: &str) -> Result<(), SourceError> {
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
        };
        let directory = open_anchored_parent(root, path)?
            .ok_or_else(|| invalid(format!("missing destination parent: {path}")))?;
        let name = CString::new(Path::new(path).file_name().unwrap().as_bytes())
            .map_err(|_| invalid("invalid path"))?;
        if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::remove_file(root.join(path)).map_err(SourceError::from)
    }
}

fn reject_lfs(root: &Path, paths: &BTreeSet<String>) -> Result<(), SourceError> {
    if paths.is_empty() {
        return Ok(());
    }
    let input: Vec<u8> = paths
        .iter()
        .flat_map(|path| path.as_bytes().iter().copied().chain(std::iter::once(0)))
        .collect();
    let attrs = git(
        root,
        &["check-attr", "-z", "--stdin", "filter"],
        Some(&input),
    )?;
    let fields: Vec<_> = attrs
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    for record in fields.chunks_exact(3) {
        if record[2] == b"lfs" {
            return Err(invalid(format!(
                "Git LFS is unsupported: {}",
                String::from_utf8_lossy(record[0])
            )));
        }
    }
    Ok(())
}

fn repository_root(path: &Path) -> Result<PathBuf, SourceError> {
    let root = fs::canonicalize(path)?;
    let discovered = git(&root, &["rev-parse", "--show-toplevel"], None)?;
    let discovered = std::str::from_utf8(&discovered)
        .map_err(|_| invalid("non-UTF-8 repository root is unsupported"))?
        .trim_end();
    if fs::canonicalize(discovered)? != root {
        return Err(invalid("capture/import requires the Git working-copy root"));
    }
    Ok(root)
}

fn head(root: &Path) -> Result<Option<String>, SourceError> {
    let output = git_command(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8(output.stdout)
            .map_err(|_| invalid("invalid Git HEAD"))?
            .trim()
            .to_owned(),
    ))
}

fn repository_identity(root: &Path) -> Result<(Option<String>, Vec<u8>), SourceError> {
    let index = git(root, &["rev-parse", "--git-path", "index"], None)?;
    let index = PathBuf::from(
        std::str::from_utf8(&index)
            .map_err(|_| invalid("invalid Git index path"))?
            .trim_end(),
    );
    let index = if index.is_absolute() {
        index
    } else {
        root.join(index)
    };
    let bytes = match fs::read(index) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    Ok((head(root)?, Sha256::digest(bytes).to_vec()))
}

fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["-c", "core.fsmonitor=false"]);
    // Do not allow inherited Git plumbing overrides to point outside this root.
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] {
        command.env_remove(name);
    }
    command
}

fn git(root: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, SourceError> {
    let mut command = git_command(root);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if input.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command.spawn()?;
    std::thread::scope(|scope| {
        let writer = if let Some(input) = input {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| invalid("missing Git input"))?;
            Some(scope.spawn(move || stdin.write_all(input)))
        } else {
            None
        };
        let mut stdout = Vec::new();
        child
            .stdout
            .take()
            .ok_or_else(|| invalid("missing Git output"))?
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut stdout)?;
        let oversized = stdout.len() > 64 * 1024 * 1024;
        if oversized {
            let _ = child.kill();
        }
        let status = child.wait()?;
        if let Some(writer) = writer {
            writer
                .join()
                .map_err(|_| invalid("Git input task failed"))??;
        }
        if oversized {
            return Err(SourceError::Limit("Git discovery bytes"));
        }
        if !status.success() {
            return Err(invalid(format!(
                "Git {} failed",
                args.first().unwrap_or(&"command")
            )));
        }
        Ok(stdout)
    })
}

fn invalid(message: impl Into<String>) -> SourceError {
    SourceError::Invalid(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn run_git(root: &Path, args: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn repo() -> TempDir {
        let temporary = TempDir::new().unwrap();
        run_git(temporary.path(), &["init", "-q"]);
        run_git(
            temporary.path(),
            &["config", "user.email", "test@falcondeck.invalid"],
        );
        run_git(
            temporary.path(),
            &["config", "user.name", "Cloud source test"],
        );
        fs::write(temporary.path().join("tracked.txt"), b"original\n").unwrap();
        run_git(temporary.path(), &["add", "tracked.txt"]);
        run_git(temporary.path(), &["commit", "-qm", "initial"]);
        temporary
    }

    fn source_file(path: &str, bytes: &[u8]) -> SourceFile {
        SourceFile {
            path: path.to_owned(),
            content_base64: STANDARD.encode(bytes),
            executable: false,
        }
    }

    fn manifest(files: Vec<SourceFile>) -> SourceCapture {
        let limits = CaptureLimits::default();
        let (_, total_bytes) = decode_files(&files, limits).unwrap();
        let tree_hash = hash_files(&files, limits).unwrap();
        SourceCapture {
            files,
            base_head: None,
            tree_hash,
            total_bytes,
            excluded_paths: Vec::new(),
        }
    }

    #[tokio::test]
    async fn captures_current_dirty_and_untracked_without_touching_index_or_secrets() {
        let temporary = repo();
        let root = temporary.path();
        for name in [".env", ".npmrc", "credentials.json", "private.pem"] {
            fs::write(root.join(name), b"do not upload\n").unwrap();
            run_git(root, &["add", "-f", "--", name]);
        }
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/built.txt"), b"output").unwrap();
        run_git(root, &["add", "-f", "target/built.txt"]);
        fs::write(root.join("tracked.txt"), b"staged\n").unwrap();
        run_git(root, &["add", "tracked.txt"]);
        fs::write(root.join("tracked.txt"), b"unstaged\n").unwrap();
        fs::write(root.join("new.ts"), b"export const x = 1;\n").unwrap();
        fs::write(root.join(".gitignore"), b"ignored.txt\n").unwrap();
        fs::write(root.join("ignored.txt"), b"ignored").unwrap();
        fs::write(
            root.join("innocent.txt"),
            b"-----BEGIN PRIVATE KEY-----\nhidden\n",
        )
        .unwrap();
        let index_before = fs::read(root.join(".git/index")).unwrap();

        let capture = capture_source(root, CaptureLimits::default())
            .await
            .unwrap();
        let files: BTreeMap<_, _> = capture
            .files
            .iter()
            .map(|file| {
                (
                    file.path.as_str(),
                    STANDARD.decode(&file.content_base64).unwrap(),
                )
            })
            .collect();
        assert_eq!(files.get("tracked.txt").unwrap(), b"unstaged\n");
        assert!(files.contains_key("new.ts"));
        assert!(!files.contains_key("ignored.txt"));
        for excluded in [
            ".env",
            ".npmrc",
            "credentials.json",
            "private.pem",
            "target/built.txt",
            "innocent.txt",
        ] {
            assert!(capture.excluded_paths.iter().any(|path| path == excluded));
            assert!(!files.contains_key(excluded));
        }
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index_before);
        assert_eq!(run_git(root, &["show", ":tracked.txt"]), b"staged\n");
        validate_capture(&capture, CaptureLimits::default()).unwrap();
    }

    #[tokio::test]
    async fn imports_only_cloud_delta_and_preserves_staged_and_unrelated_dirty_work() {
        let temporary = repo();
        let root = temporary.path();
        fs::write(root.join("tracked.txt"), b"staged\n").unwrap();
        run_git(root, &["add", "tracked.txt"]);
        fs::write(root.join("tracked.txt"), b"local dirty baseline\n").unwrap();
        fs::write(root.join("remove.bin"), [0, 255, 1, 2]).unwrap();
        fs::write(root.join("unrelated.txt"), b"original dirt\n").unwrap();
        let baseline = capture_source(root, CaptureLimits::default())
            .await
            .unwrap();
        let mut output_files = baseline.files.clone();
        output_files.retain(|file| file.path != "remove.bin");
        let changed = output_files
            .iter_mut()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        changed.content_base64 = STANDARD.encode(b"cloud edit on dirty baseline\n");
        changed.executable = true;
        output_files.push(source_file("new/binary.bin", &[0, 127, 255]));
        let delta = delta_between(&baseline, &manifest(output_files)).unwrap();
        fs::write(root.join("unrelated.txt"), b"later unrelated dirt\n").unwrap();
        let index_before = fs::read(root.join(".git/index")).unwrap();
        let imported = import_delta(root, &baseline, &delta, CaptureLimits::default())
            .await
            .unwrap();
        assert_eq!(
            imported.applied_paths,
            vec!["new/binary.bin", "tracked.txt"]
        );
        assert_eq!(imported.deleted_paths, vec!["remove.bin"]);
        assert_eq!(
            fs::read(root.join("tracked.txt")).unwrap(),
            b"cloud edit on dirty baseline\n"
        );
        assert_eq!(
            fs::read(root.join("new/binary.bin")).unwrap(),
            [0, 127, 255]
        );
        assert!(!root.join("remove.bin").exists());
        assert_eq!(
            fs::read(root.join("unrelated.txt")).unwrap(),
            b"later unrelated dirt\n"
        );
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index_before);
        assert_eq!(run_git(root, &["show", ":tracked.txt"]), b"staged\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(
                fs::metadata(root.join("tracked.txt"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0
            );
        }
        assert!(!fs::read_dir(root.join(".git")).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("falcondeck-cloud-import-")
        }));
    }

    #[tokio::test]
    async fn conflicts_preflight_entire_delta_before_changing_any_file() {
        let temporary = repo();
        let root = temporary.path();
        let baseline = capture_source(root, CaptureLimits::default())
            .await
            .unwrap();
        let delta = SourceDelta {
            files: vec![
                source_file("a-new.txt", b"new"),
                source_file("tracked.txt", b"cloud"),
            ],
            deleted_paths: Vec::new(),
        };
        fs::write(root.join("tracked.txt"), b"saved since capture").unwrap();
        let index_before = fs::read(root.join(".git/index")).unwrap();
        let error = import_delta(root, &baseline, &delta, CaptureLimits::default())
            .await
            .unwrap_err();
        assert!(matches!(error, SourceError::Conflict(path) if path == "tracked.txt"));
        assert_eq!(
            fs::read(root.join("tracked.txt")).unwrap(),
            b"saved since capture"
        );
        assert!(!root.join("a-new.txt").exists());
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index_before);
    }

    #[tokio::test]
    async fn newly_occupied_and_mode_changed_destinations_conflict() {
        let temporary = repo();
        let root = temporary.path();
        let baseline = capture_source(root, CaptureLimits::default())
            .await
            .unwrap();
        let delta = SourceDelta {
            files: vec![source_file("new.txt", b"cloud")],
            deleted_paths: Vec::new(),
        };
        fs::write(root.join("new.txt"), b"user created").unwrap();
        assert!(matches!(
            import_delta(root, &baseline, &delta, CaptureLimits::default()).await,
            Err(SourceError::Conflict(_))
        ));
        assert_eq!(fs::read(root.join("new.txt")).unwrap(), b"user created");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join("tracked.txt"), fs::Permissions::from_mode(0o755))
                .unwrap();
            let delta = SourceDelta {
                files: vec![source_file("tracked.txt", b"cloud")],
                deleted_paths: Vec::new(),
            };
            assert!(matches!(
                import_delta(root, &baseline, &delta, CaptureLimits::default()).await,
                Err(SourceError::Conflict(_))
            ));
        }
    }

    #[test]
    fn validates_hostile_manifests_and_bounds_before_decoding() {
        let limits = CaptureLimits::default();
        for path in [
            "../escape",
            "/absolute",
            "a/../b",
            "a//b",
            "a\\b",
            "C:/bad",
            ".git/config",
            ".env.local",
            "x/id_ed25519",
            "x/auth.json",
            "node_modules/a.js",
        ] {
            assert!(
                decode_files(&[source_file(path, b"x")], limits).is_err(),
                "accepted {path}"
            );
        }
        for files in [
            vec![source_file("a", b"a"), source_file("a", b"b")],
            vec![source_file("A", b"a"), source_file("a", b"b")],
            vec![source_file("a", b"a"), source_file("a/b", b"b")],
        ] {
            assert!(decode_files(&files, limits).is_err());
        }
        let mut capture = manifest(vec![source_file("a.txt", b"x")]);
        capture.tree_hash = "forged".to_owned();
        assert!(validate_capture(&capture, limits).is_err());
        let mut file = source_file("a.txt", b"x");
        file.content_base64 = "A".repeat(128);
        assert!(matches!(
            decode_files(
                &[file],
                CaptureLimits {
                    max_file_bytes: 8,
                    ..limits
                }
            ),
            Err(SourceError::Limit(_))
        ));
        assert!(decode_files(&[source_file("a", b"-----BEGIN PRIVATE KEY-----")], limits).is_err());
        assert!(
            decode_files(
                &[source_file(
                    "code.rs",
                    b"const HEADER: &str = \"-----BEGIN PRIVATE KEY-----\";"
                )],
                limits
            )
            .is_ok()
        );
    }

    #[tokio::test]
    async fn malformed_result_is_rejected_without_mutation() {
        let temporary = repo();
        let root = temporary.path();
        let baseline = capture_source(root, CaptureLimits::default())
            .await
            .unwrap();
        for delta in [
            SourceDelta {
                files: vec![],
                deleted_paths: vec!["unknown.txt".into()],
            },
            SourceDelta {
                files: vec![source_file("tracked.txt", b"cloud")],
                deleted_paths: vec!["tracked.txt".into()],
            },
            SourceDelta {
                files: vec![],
                deleted_paths: vec![".env".into()],
            },
        ] {
            assert!(
                import_delta(root, &baseline, &delta, CaptureLimits::default())
                    .await
                    .is_err()
            );
            assert_eq!(fs::read(root.join("tracked.txt")).unwrap(), b"original\n");
        }
    }

    #[tokio::test]
    async fn detects_limits_and_smudged_lfs_without_running_filters() {
        let temporary = repo();
        let root = temporary.path();
        assert!(matches!(
            capture_source(
                root,
                CaptureLimits {
                    max_file_bytes: 2,
                    ..CaptureLimits::default()
                }
            )
            .await,
            Err(SourceError::Limit(_))
        ));
        assert!(matches!(
            capture_source(
                root,
                CaptureLimits {
                    max_files: 0,
                    ..CaptureLimits::default()
                }
            )
            .await,
            Err(SourceError::Limit(_))
        ));
        fs::write(root.join(".gitattributes"), b"*.bin filter=lfs\n").unwrap();
        fs::write(root.join("large.bin"), b"smudged ordinary bytes").unwrap();
        assert!(
            matches!(capture_source(root, CaptureLimits::default()).await, Err(SourceError::Invalid(message)) if message.contains("Git LFS"))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_files_and_destination_ancestors() {
        use std::os::unix::fs::symlink;
        let temporary = repo();
        let outside = TempDir::new().unwrap();
        let root = temporary.path();
        let baseline = capture_source(root, CaptureLimits::default())
            .await
            .unwrap();
        symlink(outside.path(), root.join("escape")).unwrap();
        assert!(
            capture_source(root, CaptureLimits::default())
                .await
                .is_err()
        );
        let delta = SourceDelta {
            files: vec![source_file("escape/unsafe.txt", b"cloud")],
            deleted_paths: Vec::new(),
        };
        assert!(
            import_delta(root, &baseline, &delta, CaptureLimits::default())
                .await
                .is_err()
        );
        assert!(!outside.path().join("unsafe.txt").exists());
    }

    #[tokio::test]
    async fn rejects_git_submodules_and_unmerged_index_entries() {
        let temporary = repo();
        let root = temporary.path();
        let head = String::from_utf8(run_git(root, &["rev-parse", "HEAD"])).unwrap();
        run_git(
            root,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{},nested", head.trim()),
            ],
        );
        assert!(
            matches!(capture_source(root, CaptureLimits::default()).await, Err(SourceError::Invalid(message)) if message.contains("submodule"))
        );
    }

    #[test]
    fn capture_hash_is_order_independent_and_includes_mode_and_binary_bytes() {
        let first = source_file("a", &[0, 255]);
        let second = source_file("b", b"text");
        let normal = manifest(vec![first.clone(), second.clone()]);
        assert_eq!(
            normal.tree_hash,
            manifest(vec![second, first.clone()]).tree_hash
        );
        let mut executable = first;
        executable.executable = true;
        assert_ne!(normal.tree_hash, manifest(vec![executable]).tree_hash);
    }

    #[test]
    fn runtime_wire_formats_and_hash_match_the_node_adapter() {
        let snake: SourceFile = serde_json::from_value(serde_json::json!({
            "path": "a", "content_base64": "AP8=", "executable": false
        }))
        .unwrap();
        let camel: SourceFile = serde_json::from_value(serde_json::json!({
            "path": "a", "contentBase64": "AP8=", "executable": false
        }))
        .unwrap();
        assert_eq!(snake, camel);
        let mut second = source_file("b", b"text");
        second.executable = true;
        let capture = manifest(vec![snake, second]);
        // Golden generated by packages/cloud-runtime/src/source.mjs.
        assert_eq!(
            capture.tree_hash,
            "3da7b68aa83d7d06d1cdec28e5719dc22e9cc83da9162bac7e9122be4f4e9e87"
        );
        let output = serde_json::to_value(&capture).unwrap();
        assert_eq!(output["files"][0]["contentBase64"], "AP8=");
        assert_eq!(output["treeHash"], capture.tree_hash);
        assert_eq!(output["files"][1]["executable"], true);
    }
}
