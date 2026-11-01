//! Read-only previews of local files for paired phones.
//!
//! Agents hand their reviewer links to files on this computer: reports,
//! dashboards, PDFs, screenshots. This module answers `file.stat` and
//! `file.read_range` for any absolute path inside a small set of allowed roots
//! and never writes, lists or executes anything.
//!
//! Policy, in the order it is enforced:
//! 1. The requested path is resolved (`~`, `file://`, relative to a base
//!    directory), then canonicalised so symlinks and `..` cannot hide where it
//!    really points.
//! 2. The canonical path must sit under an allowed root; anything else is
//!    "denied", including paths that do not exist (no existence oracle).
//! 3. Secret-looking names are denied even inside an allowed root, judged on
//!    both the requested and the canonical path so a symlink cannot rename one.
//! 4. Only regular files at most [`MAX_FILE_BYTES`] are served, in ranges of at
//!    most [`MAX_RANGE_BYTES`] so each reply fits the relay's 30 s deadline.
//!
//! Error messages start with a stable code (`file_denied:`, `file_not_found:`,
//! `file_too_large:`, `file_changed:`, `file_unsupported:`) that clients map to
//! friendly states; the text after the code is safe to show.

use std::{
    collections::HashSet,
    io::{Read as _, Seek as _, SeekFrom, Write as _},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use falcondeck_core::{FilePreviewKind, FilePreviewMeta, FileRangeResponse};
use tokio::task;

use crate::error::DaemonError;

/// Largest file a phone may open. Files above this fail with a clear message.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// Largest range per call. The relay moves ~70 KB/s and drops RPCs at 30 s, and
/// payloads grow ~2.4x on the wire (base64, then chunk framing), so 256 KiB of
/// incompressible bytes is the most that reliably returns in time.
pub const MAX_RANGE_BYTES: u64 = 256 * 1024;
const SNIFF_BYTES: usize = 4096;

/// The directories a phone may read from, already canonical.
#[derive(Debug, Clone, Default)]
pub struct FileAccessPolicy {
    roots: Vec<PathBuf>,
}

impl FileAccessPolicy {
    /// Canonicalises `candidates` and keeps the usable ones. A root that cannot
    /// be resolved is skipped, and so is one so broad that it would expose far
    /// more than a project: the filesystem root, the home directory itself, or
    /// any ancestor of it.
    pub async fn build(candidates: impl IntoIterator<Item = PathBuf>, home: Option<&Path>) -> Self {
        let home = match home {
            Some(home) => tokio::fs::canonicalize(home).await.ok(),
            None => None,
        };
        let mut seen = HashSet::new();
        let mut roots = Vec::new();
        for candidate in candidates {
            if !candidate.is_absolute() || !seen.insert(candidate.clone()) {
                continue;
            }
            let Ok(root) = tokio::fs::canonicalize(&candidate).await else {
                continue;
            };
            let too_broad = root.parent().is_none()
                || home.as_ref().is_some_and(|home| home.starts_with(&root));
            if !too_broad && !roots.contains(&root) {
                roots.push(root);
            }
        }
        Self { roots }
    }

    #[cfg(test)]
    fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    fn allows(&self, canonical: &Path) -> bool {
        self.roots.iter().any(|root| canonical.starts_with(root))
    }
}

/// How the caller named the file.
#[derive(Debug, Clone, Copy, Default)]
pub struct FileTarget<'a> {
    pub path: &'a str,
    /// Directory a relative `path` resolves against (a document's own folder).
    pub base_dir: Option<&'a Path>,
    /// Working directory of the thread/workspace; the fallback base.
    pub workspace_dir: Option<&'a Path>,
    pub home: Option<&'a Path>,
}

fn denied() -> DaemonError {
    DaemonError::BadRequest("file_denied: This file isn't shareable from your Mac.".to_string())
}

fn not_found() -> DaemonError {
    DaemonError::NotFound("file_not_found: This file no longer exists on your Mac.".to_string())
}

pub async fn stat(
    policy: &FileAccessPolicy,
    target: FileTarget<'_>,
) -> Result<FilePreviewMeta, DaemonError> {
    let path = resolve(policy, target).await?;
    let metadata = regular_file_metadata(&path).await?;
    let sniff_path = path.clone();
    task::spawn_blocking(move || describe(&sniff_path, &metadata, true))
        .await
        .map_err(|error| DaemonError::Rpc(format!("file preview failed: {error}")))?
}

/// The whole file (at most [`MAX_FILE_BYTES`]) for a client on this computer,
/// such as the desktop app, where the relay's range limits do not apply. The
/// access policy is the same one phones use.
pub async fn read_all(
    policy: &FileAccessPolicy,
    target: FileTarget<'_>,
) -> Result<(FilePreviewMeta, Vec<u8>), DaemonError> {
    let path = resolve(policy, target).await?;
    let metadata = regular_file_metadata(&path).await?;
    let sniff_path = path.clone();
    let meta = task::spawn_blocking(move || describe(&sniff_path, &metadata, true))
        .await
        .map_err(|error| DaemonError::Rpc(format!("file preview failed: {error}")))??;
    let bytes = tokio::fs::read(&path).await.map_err(|_| not_found())?;
    Ok((meta, bytes))
}

pub async fn read_range(
    policy: &FileAccessPolicy,
    target: FileTarget<'_>,
    offset: u64,
    length: u64,
    expected_version: Option<&str>,
    compress: bool,
) -> Result<FileRangeResponse, DaemonError> {
    let path = resolve(policy, target).await?;
    let metadata = regular_file_metadata(&path).await?;
    let expected_version = expected_version.map(str::to_owned);
    task::spawn_blocking(move || {
        read_range_blocking(
            &path,
            &metadata,
            offset,
            length,
            expected_version.as_deref(),
            compress,
        )
    })
    .await
    .map_err(|error| DaemonError::Rpc(format!("file preview failed: {error}")))?
}

fn read_range_blocking(
    path: &Path,
    metadata: &std::fs::Metadata,
    offset: u64,
    length: u64,
    expected_version: Option<&str>,
    compress: bool,
) -> Result<FileRangeResponse, DaemonError> {
    let meta = describe(path, metadata, offset == 0)?;
    if expected_version.is_some_and(|expected| expected != meta.version) {
        return Err(DaemonError::Conflict(
            "file_changed: This file changed on your Mac while it was loading.".to_string(),
        ));
    }
    let size = meta.size_bytes;
    let start = offset.min(size);
    let wanted = length.min(MAX_RANGE_BYTES).min(size - start);
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity(wanted as usize);
    file.take(wanted).read_to_end(&mut bytes)?;
    // The file can shrink between stat and read; report what was really read.
    let length = bytes.len() as u64;
    let (encoding, payload) = if compress && length > 0 && compressible(&meta) {
        match deflate(&bytes) {
            Some(packed) if packed.len() < bytes.len() - bytes.len() / 10 => ("deflate", packed),
            _ => ("identity", bytes),
        }
    } else {
        ("identity", bytes)
    };
    Ok(FileRangeResponse {
        meta,
        offset: start,
        length,
        eof: start + length >= size,
        encoding: encoding.to_string(),
        data_base64: BASE64.encode(payload),
    })
}

fn compressible(meta: &FilePreviewMeta) -> bool {
    matches!(
        meta.kind,
        FilePreviewKind::Markdown
            | FilePreviewKind::Html
            | FilePreviewKind::Code
            | FilePreviewKind::Text
    ) || meta.content_type == "image/svg+xml"
}

fn deflate(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes).ok()?;
    encoder.finish().ok()
}

async fn regular_file_metadata(path: &Path) -> Result<std::fs::Metadata, DaemonError> {
    let metadata = tokio::fs::metadata(path).await.map_err(|_| not_found())?;
    if !metadata.is_file() {
        return Err(DaemonError::BadRequest(
            "file_unsupported: Only files can be opened, not folders.".to_string(),
        ));
    }
    if metadata.len() > MAX_FILE_BYTES {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("This file");
        return Err(DaemonError::BadRequest(format!(
            "file_too_large: {name} is {:.1} MB; previews on your phone are limited to {} MB.",
            metadata.len() as f64 / 1_000_000.0,
            MAX_FILE_BYTES / (1024 * 1024),
        )));
    }
    Ok(metadata)
}

fn describe(
    path: &Path,
    metadata: &std::fs::Metadata,
    sniff: bool,
) -> Result<FilePreviewMeta, DaemonError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
        .to_string();
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let (content_type, kind) = match classify_extension(&extension) {
        Some(known) => known,
        None if sniff && looks_like_text(path) => ("text/plain", FilePreviewKind::Text),
        None if sniff => ("application/octet-stream", FilePreviewKind::Binary),
        // Later ranges of an unknown type are never re-sniffed; the first
        // range's answer decides the client's presentation.
        None => ("application/octet-stream", FilePreviewKind::Binary),
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok());
    Ok(FilePreviewMeta {
        path: path.to_string_lossy().into_owned(),
        name,
        size_bytes: metadata.len(),
        modified_ms: modified.map_or(0, |d| d.as_millis() as i64),
        version: format!(
            "{}:{}",
            modified.map_or(0, |d| d.as_nanos()),
            metadata.len()
        ),
        content_type: content_type.to_string(),
        kind,
        max_range_bytes: MAX_RANGE_BYTES,
    })
}

fn looks_like_text(path: &Path) -> bool {
    let mut buffer = [0u8; SNIFF_BYTES];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(read) = file.read(&mut buffer) else {
        return false;
    };
    let head = &buffer[..read];
    if head.contains(&0) {
        return false;
    }
    // A multi-byte character may straddle the sniff boundary.
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none() && read == SNIFF_BYTES,
    }
}

fn classify_extension(extension: &str) -> Option<(&'static str, FilePreviewKind)> {
    use FilePreviewKind::*;
    Some(match extension {
        "md" | "markdown" | "mdown" | "mdx" => ("text/markdown", Markdown),
        "html" | "htm" | "xhtml" => ("text/html", Html),
        "pdf" => ("application/pdf", Pdf),
        "png" => ("image/png", Image),
        "jpg" | "jpeg" | "jfif" => ("image/jpeg", Image),
        "gif" => ("image/gif", Image),
        "webp" => ("image/webp", Image),
        "svg" => ("image/svg+xml", Image),
        "heic" | "heif" => ("image/heic", Image),
        "bmp" => ("image/bmp", Image),
        "avif" => ("image/avif", Image),
        "tif" | "tiff" => ("image/tiff", Image),
        "ico" => ("image/x-icon", Image),
        "mp4" | "m4v" => ("video/mp4", Video),
        "mov" => ("video/quicktime", Video),
        "webm" => ("video/webm", Video),
        "mp3" => ("audio/mpeg", Audio),
        "wav" => ("audio/wav", Audio),
        "m4a" => ("audio/mp4", Audio),
        "aac" => ("audio/aac", Audio),
        "flac" => ("audio/flac", Audio),
        "ogg" | "oga" | "opus" => ("audio/ogg", Audio),
        "css" => ("text/css", Code),
        "js" | "mjs" | "cjs" | "jsx" => ("text/javascript", Code),
        "ts" | "tsx" | "mts" | "cts" => ("text/typescript", Code),
        "json" | "jsonc" | "geojson" => ("application/json", Code),
        "yaml" | "yml" | "toml" | "ini" | "xml" | "plist" => ("text/plain", Code),
        "rs" | "swift" | "py" | "rb" | "go" | "java" | "kt" | "c" | "h" | "cc" | "cpp" | "hpp"
        | "cs" | "php" | "sh" | "bash" | "zsh" | "sql" | "lua" | "r" | "scala" | "vue"
        | "svelte" | "astro" | "diff" | "patch" | "graphql" | "proto" | "tf" | "mk" => {
            ("text/plain", Code)
        }
        "csv" => ("text/csv", Text),
        "tsv" => ("text/tab-separated-values", Text),
        "txt" | "text" | "log" | "rtf" => ("text/plain", Text),
        // Office and archive formats open in the system previewer; the bytes
        // are opaque to us.
        "docx" => (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Binary,
        ),
        "xlsx" => (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            Binary,
        ),
        "pptx" => (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            Binary,
        ),
        "zip" => ("application/zip", Binary),
        _ => return None,
    })
}

// --- path resolution ---------------------------------------------------

async fn resolve(
    policy: &FileAccessPolicy,
    target: FileTarget<'_>,
) -> Result<PathBuf, DaemonError> {
    let requested = requested_path(target)?;
    // Judge the name the caller used before touching the disk, so a denied
    // name never reveals whether it exists.
    if is_secret_path(&requested) {
        return Err(denied());
    }
    let canonical = match tokio::fs::canonicalize(&requested).await {
        Ok(canonical) => canonical,
        // A missing file is only "missing" inside the roots; elsewhere it is
        // denied so the answer is not an oracle for the rest of the disk.
        Err(_) if policy.allows(&lexical_normalize(&requested)) => return Err(not_found()),
        Err(_) => return Err(denied()),
    };
    if !policy.allows(&canonical) || is_secret_path(&canonical) {
        return Err(denied());
    }
    Ok(canonical)
}

fn requested_path(target: FileTarget<'_>) -> Result<PathBuf, DaemonError> {
    let raw = target.path.trim();
    if raw.is_empty() || raw.contains('\0') {
        return Err(DaemonError::BadRequest(
            "file_not_found: That isn't a file path.".to_string(),
        ));
    }
    let decoded;
    let raw = if raw.len() >= 7 && raw[..7].eq_ignore_ascii_case("file://") {
        decoded = file_url_path(raw)?;
        decoded.as_str()
    } else {
        raw
    };
    let path = if raw == "~" || raw.starts_with("~/") {
        let home = target.home.ok_or_else(denied)?;
        home.join(raw.trim_start_matches('~').trim_start_matches('/'))
    } else {
        let path = Path::new(raw);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            let base = target.base_dir.or(target.workspace_dir).ok_or_else(|| {
                DaemonError::BadRequest(
                    "file_not_found: A relative link needs the folder it is relative to."
                        .to_string(),
                )
            })?;
            base.join(path)
        }
    };
    if !path.is_absolute() {
        return Err(not_found());
    }
    Ok(path)
}

/// `file:///a/b%20c.md` or `file://localhost/a/b` → `/a/b c.md`. Query and
/// fragment are URL syntax here, not part of the name.
fn file_url_path(url: &str) -> Result<String, DaemonError> {
    let mut rest = &url[7..];
    if let Some(stripped) = rest.strip_prefix("localhost") {
        rest = stripped;
    }
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    if !rest.starts_with('/') {
        return Err(DaemonError::BadRequest(
            "file_denied: Only files on this Mac can be opened.".to_string(),
        ));
    }
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(value) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).map_err(|_| {
        DaemonError::BadRequest("file_not_found: That isn't a valid file path.".to_string())
    })
}

/// Resolves `.` and `..` without touching the disk.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// --- secret deny list ----------------------------------------------------

/// Directories that hold credentials, wherever they appear in a path.
const SECRET_DIRECTORIES: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".doppler",
    ".password-store",
    ".git",
    "keychains",
];
/// Exact file names that are credentials.
const SECRET_FILES: &[&str] = &[
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".htpasswd",
    ".git-credentials",
    ".dev.vars",
    ".doppler.yaml",
    "doppler.yaml",
    "secrets",
    "secret",
    "token",
    "tokens",
    "auth.json",
];
/// File-name prefixes that are credentials.
const SECRET_FILE_PREFIXES: &[&str] = &[
    ".env",
    ".secrets",
    "credentials",
    "secrets.",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "remote-secrets",
    "daemon-state",
    "service-account",
];
const SECRET_EXTENSIONS: &[&str] = &[
    "pem",
    "key",
    "p12",
    "pfx",
    "p8",
    "jks",
    "keystore",
    "keychain",
    "keychain-db",
    "ppk",
    "kdbx",
    "tfstate",
    "token",
];

/// True when any part of `path` names a credential store or secret file.
pub fn is_secret_path(path: &Path) -> bool {
    let components: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => name.to_str().map(str::to_ascii_lowercase),
            _ => None,
        })
        .collect();
    let Some((file, directories)) = components.split_last() else {
        return false;
    };
    if directories
        .iter()
        .chain(std::iter::once(file))
        .any(|name| SECRET_DIRECTORIES.contains(&name.as_str()))
    {
        return true;
    }
    if SECRET_FILES.contains(&file.as_str())
        || SECRET_FILE_PREFIXES
            .iter()
            .any(|prefix| file.starts_with(prefix))
    {
        return true;
    }
    Path::new(file)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SECRET_EXTENSIONS.contains(&ext))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        outside: PathBuf,
        policy: FileAccessPolicy,
    }

    async fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(temp.path()).unwrap();
        let root = base.join("artifacts");
        let outside = base.join("outside");
        std::fs::create_dir_all(root.join("report")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("report/index.md"), "# Report\n![](shot.png)\n").unwrap();
        std::fs::write(
            root.join("report/shot.png"),
            [0x89, b'P', b'N', b'G', 0, 1, 2],
        )
        .unwrap();
        std::fs::write(outside.join("private.txt"), "nope").unwrap();
        let policy = FileAccessPolicy::build([root.clone()], None).await;
        Fixture {
            _temp: temp,
            root,
            outside,
            policy,
        }
    }

    fn target(path: &str) -> FileTarget<'_> {
        FileTarget {
            path,
            ..FileTarget::default()
        }
    }

    fn code(error: DaemonError) -> String {
        error.to_string().split(':').next().unwrap().to_string()
    }

    #[tokio::test]
    async fn serves_files_inside_allowed_roots_with_metadata() {
        let f = fixture().await;
        let path = f.root.join("report/index.md");
        let meta = stat(&f.policy, target(path.to_str().unwrap()))
            .await
            .unwrap();
        assert_eq!(meta.kind, FilePreviewKind::Markdown);
        assert_eq!(meta.content_type, "text/markdown");
        assert_eq!(meta.name, "index.md");
        assert_eq!(meta.size_bytes, 23);
        assert_eq!(meta.path, path.to_str().unwrap());
        assert!(meta.version.ends_with(":23"));
        assert!(meta.modified_ms > 0);
    }

    #[tokio::test]
    async fn rejects_paths_outside_every_root() {
        let f = fixture().await;
        for path in [
            f.outside.join("private.txt").to_str().unwrap().to_string(),
            "/etc/hosts".to_string(),
            "/".to_string(),
        ] {
            let error = stat(&f.policy, target(&path)).await.unwrap_err();
            assert_eq!(code(error), "file_denied", "{path}");
        }
    }

    #[tokio::test]
    async fn missing_files_outside_roots_do_not_reveal_existence() {
        let f = fixture().await;
        let missing_outside = f.outside.join("nope.txt");
        let error = stat(&f.policy, target(missing_outside.to_str().unwrap()))
            .await
            .unwrap_err();
        assert_eq!(code(error), "file_denied");
        let missing_inside = f.root.join("nope.txt");
        let error = stat(&f.policy, target(missing_inside.to_str().unwrap()))
            .await
            .unwrap_err();
        assert_eq!(code(error), "file_not_found");
    }

    #[tokio::test]
    async fn dotdot_cannot_escape_the_root() {
        let f = fixture().await;
        let sneaky = format!("{}/report/../../outside/private.txt", f.root.display());
        assert_eq!(
            code(stat(&f.policy, target(&sneaky)).await.unwrap_err()),
            "file_denied"
        );
    }

    #[tokio::test]
    async fn symlinks_cannot_escape_the_root() {
        let f = fixture().await;
        symlink(
            f.outside.join("private.txt"),
            f.root.join("report/link.txt"),
        )
        .unwrap();
        symlink(&f.outside, f.root.join("report/dirlink")).unwrap();
        for path in [
            f.root.join("report/link.txt"),
            f.root.join("report/dirlink/private.txt"),
        ] {
            let error = stat(&f.policy, target(path.to_str().unwrap()))
                .await
                .unwrap_err();
            assert_eq!(code(error), "file_denied", "{}", path.display());
        }
        // A symlink that stays inside the root is fine.
        symlink(f.root.join("report/index.md"), f.root.join("alias.md")).unwrap();
        let alias = f.root.join("alias.md");
        let meta = stat(&f.policy, target(alias.to_str().unwrap()))
            .await
            .unwrap();
        assert_eq!(meta.path, f.root.join("report/index.md").to_str().unwrap());
    }

    #[tokio::test]
    async fn a_symlink_cannot_launder_a_secret_name() {
        let f = fixture().await;
        std::fs::write(f.root.join(".env"), "TOKEN=1").unwrap();
        symlink(f.root.join(".env"), f.root.join("notes.md")).unwrap();
        let notes = f.root.join("notes.md");
        assert_eq!(
            code(
                stat(&f.policy, target(notes.to_str().unwrap()))
                    .await
                    .unwrap_err()
            ),
            "file_denied"
        );
    }

    #[tokio::test]
    async fn secrets_are_denied_even_inside_an_allowed_root() {
        let f = fixture().await;
        for name in [
            ".env",
            ".env.local",
            ".envrc",
            ".ssh/id_ed25519",
            ".ssh/config",
            "server.pem",
            "tls/private.KEY",
            "cert.p12",
            "login.keychain-db",
            "Library/Keychains/login.keychain",
            ".git/config",
            "repo/.git/HEAD",
            "credentials.json",
            "aws/credentials",
            ".doppler/doppler.yaml",
            ".doppler.yaml",
            "remote-secrets.json",
            "daemon-state.json",
            "secrets.json",
            "auth.json",
            ".npmrc",
            "id_rsa",
            "id_rsa.pub",
        ] {
            let path = f.root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "secret").unwrap();
            let error = stat(&f.policy, target(path.to_str().unwrap()))
                .await
                .unwrap_err();
            assert_eq!(code(error), "file_denied", "{name}");
        }
    }

    #[test]
    fn ordinary_names_are_not_mistaken_for_secrets() {
        for name in [
            "/r/report.md",
            "/r/.gitignore",
            "/r/.gitattributes",
            "/r/tokens-analysis.md",
            "/r/secrets-management-review.md",
            "/r/environment.md",
            "/r/envelope.html",
            "/r/monkey.png",
            "/r/keyboard.png",
            "/r/credentials-audit-plan.md.bak",
        ] {
            // credentials* is an intentional prefix match, so only the last differs.
            assert_eq!(
                is_secret_path(Path::new(name)),
                name.contains("credentials"),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn directories_and_special_files_are_refused() {
        let f = fixture().await;
        let dir = f.root.join("report");
        let error = stat(&f.policy, target(dir.to_str().unwrap()))
            .await
            .unwrap_err();
        assert_eq!(code(error), "file_unsupported");
    }

    #[tokio::test]
    async fn ranges_walk_the_file_and_report_eof() {
        let f = fixture().await;
        let path = f.root.join("big.txt");
        let content: Vec<u8> = (0..600_000u32).map(|n| b'a' + (n % 26) as u8).collect();
        std::fs::write(&path, &content).unwrap();
        let path = path.to_str().unwrap();
        let mut collected = Vec::new();
        let mut offset = 0;
        let mut version = None;
        loop {
            let range = read_range(
                &f.policy,
                target(path),
                offset,
                1_000_000,
                version.as_deref(),
                false,
            )
            .await
            .unwrap();
            assert!(range.length <= MAX_RANGE_BYTES);
            assert_eq!(range.encoding, "identity");
            assert_eq!(range.offset, offset);
            version = Some(range.meta.version.clone());
            collected.extend(BASE64.decode(&range.data_base64).unwrap());
            offset += range.length;
            if range.eof {
                break;
            }
        }
        assert_eq!(collected, content);
        // Past the end is an empty, final range.
        let tail = read_range(&f.policy, target(path), 9_999_999, 10, None, false)
            .await
            .unwrap();
        assert!(tail.eof && tail.length == 0 && tail.data_base64.is_empty());
        // Zero length is a metadata probe.
        let probe = read_range(&f.policy, target(path), 0, 0, None, false)
            .await
            .unwrap();
        assert_eq!(probe.meta.size_bytes, 600_000);
        assert!(!probe.eof);
    }

    #[tokio::test]
    async fn a_pinned_version_rejects_a_changed_file() {
        let f = fixture().await;
        let path = f.root.join("report/index.md");
        let path = path.to_str().unwrap();
        let first = read_range(&f.policy, target(path), 0, 5, None, false)
            .await
            .unwrap();
        std::fs::write(path, "# Rewritten with a different length\n").unwrap();
        let error = read_range(
            &f.policy,
            target(path),
            5,
            5,
            Some(&first.meta.version),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(code(error), "file_changed");
    }

    #[tokio::test]
    async fn enforces_the_size_cap_with_a_clear_message() {
        let f = fixture().await;
        let path = f.root.join("huge.pdf");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        let path = path.to_str().unwrap();
        let error = stat(&f.policy, target(path)).await.unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("file_too_large: huge.pdf is 26.2 MB"),
            "{error}"
        );
        assert_eq!(
            code(
                read_range(&f.policy, target(path), 0, 10, None, false)
                    .await
                    .unwrap_err()
            ),
            "file_too_large"
        );
        // Exactly at the cap is allowed.
        let exact = f.root.join("exact.pdf");
        std::fs::File::create(&exact)
            .unwrap()
            .set_len(MAX_FILE_BYTES)
            .unwrap();
        assert!(
            stat(&f.policy, target(exact.to_str().unwrap()))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn text_ranges_deflate_when_asked_and_binary_ones_do_not() {
        let f = fixture().await;
        let text = f.root.join("table.html");
        std::fs::write(&text, "<tr><td>row</td></tr>\n".repeat(5000)).unwrap();
        let range = read_range(
            &f.policy,
            target(text.to_str().unwrap()),
            0,
            MAX_RANGE_BYTES,
            None,
            true,
        )
        .await
        .unwrap();
        assert_eq!(range.encoding, "deflate");
        let packed = BASE64.decode(&range.data_base64).unwrap();
        assert!((packed.len() as u64) < range.length / 5);
        let mut unpacked = Vec::new();
        flate2::read::DeflateDecoder::new(&packed[..])
            .read_to_end(&mut unpacked)
            .unwrap();
        assert_eq!(unpacked.len() as u64, range.length);
        assert!(unpacked.starts_with(b"<tr><td>row</td></tr>"));

        let png = f.root.join("report/shot.png");
        let range = read_range(&f.policy, target(png.to_str().unwrap()), 0, 100, None, true)
            .await
            .unwrap();
        assert_eq!(range.encoding, "identity");
    }

    #[tokio::test]
    async fn resolves_file_urls_tilde_and_relative_paths() {
        let f = fixture().await;
        let home = f.root.parent().unwrap().to_path_buf();
        let policy = FileAccessPolicy::build([f.root.clone()], Some(&home.join("elsewhere"))).await;
        let url = format!("file://{}/report/index.md#top", f.root.display());
        assert_eq!(stat(&policy, target(&url)).await.unwrap().name, "index.md");
        let encoded = f.root.join("with space.md");
        std::fs::write(&encoded, "x").unwrap();
        let url = format!("file://localhost{}/with%20space.md", f.root.display());
        assert_eq!(
            stat(&policy, target(&url)).await.unwrap().name,
            "with space.md"
        );
        // `~/artifacts/...` resolves through the supplied home.
        let tilde = FileTarget {
            path: "~/artifacts/report/index.md",
            home: Some(&home),
            ..FileTarget::default()
        };
        assert_eq!(stat(&policy, tilde).await.unwrap().name, "index.md");
        // Relative to a document's folder, including `..`.
        let report = f.root.join("report");
        let relative = FileTarget {
            path: "../report/shot.png",
            base_dir: Some(&report),
            ..FileTarget::default()
        };
        assert_eq!(
            stat(&policy, relative).await.unwrap().kind,
            FilePreviewKind::Image
        );
        // Relative to the working directory when no base is given.
        let workspace = FileTarget {
            path: "report/index.md",
            workspace_dir: Some(&f.root),
            ..FileTarget::default()
        };
        assert_eq!(stat(&policy, workspace).await.unwrap().name, "index.md");
        // A bare relative path with nothing to anchor it is an error, not a guess.
        assert_eq!(
            code(stat(&policy, target("report/index.md")).await.unwrap_err()),
            "file_not_found"
        );
        // Non-local file URLs are refused.
        assert_eq!(
            code(
                stat(&policy, target("file://example.com/etc/hosts"))
                    .await
                    .unwrap_err()
            ),
            "file_denied"
        );
    }

    #[tokio::test]
    async fn broad_roots_are_ignored() {
        let f = fixture().await;
        let home = f.root.parent().unwrap().to_path_buf();
        let policy = FileAccessPolicy::build(
            [
                PathBuf::from("/"),
                home.clone(),
                f.root.clone(),
                PathBuf::from("relative"),
                PathBuf::from("/definitely/missing"),
            ],
            Some(&home),
        )
        .await;
        assert_eq!(policy.roots(), [f.root.clone()]);
        // A root under home stays valid (a project folder).
        assert!(policy.allows(&f.root.join("report/index.md")));
    }

    #[tokio::test]
    async fn sniffs_unknown_extensions() {
        let f = fixture().await;
        std::fs::write(f.root.join("notes.weird"), "plain words\nmore words\n").unwrap();
        std::fs::write(f.root.join("blob.weird"), [0u8, 1, 2, 3, 255]).unwrap();
        let text = stat(
            &f.policy,
            target(f.root.join("notes.weird").to_str().unwrap()),
        )
        .await
        .unwrap();
        let blob = stat(
            &f.policy,
            target(f.root.join("blob.weird").to_str().unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(text.kind, FilePreviewKind::Text);
        assert_eq!(blob.kind, FilePreviewKind::Binary);
    }
}
