//! Project sidebar icons: local favicons, domain hints, and the Plugins logo cache.

use std::path::{Path, PathBuf};

use falcondeck_core::{
    WorkspaceIconMode, WorkspaceIconPreference, WorkspaceIconSource, WorkspaceResolvedIcon,
    WorkspaceResolvedIconKind, sanitize_logo_domain,
};
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::connector_logos;

const MAX_BYTES: usize = 512 * 1024;
const MAX_HINT_FILE_BYTES: u64 = 1_000_000;

const LOCAL_ICON_CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.png",
    "apple-touch-icon.png",
    "apple-touch-icon-precomposed.png",
    "favicon.ico",
    "public/favicon.svg",
    "public/favicon.png",
    "public/apple-touch-icon.png",
    "public/favicon.ico",
    "src/favicon.svg",
    "src/favicon.png",
    "src/favicon.ico",
    "src/app/favicon.ico",
    "src/app/favicon.png",
    "src/app/icon.png",
    "app/favicon.ico",
    "app/icon.png",
    "assets/favicon.svg",
    "assets/favicon.png",
    "assets/icon.png",
    "assets/favicon.ico",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveredIcon {
    Folder,
    File { path: PathBuf, content_type: String },
    Domain { domain: String },
}

#[derive(Debug, Clone)]
pub struct CachedWorkspaceIcon {
    pub meta: WorkspaceResolvedIcon,
    pub bytes: Option<Vec<u8>>,
    pub content_type: Option<String>,
}

impl CachedWorkspaceIcon {
    pub fn folder() -> Self {
        Self {
            meta: WorkspaceResolvedIcon::folder(),
            bytes: None,
            content_type: None,
        }
    }

    pub fn image(
        bytes: Vec<u8>,
        content_type: String,
        source: WorkspaceIconSource,
        domain: Option<String>,
    ) -> Self {
        let etag = etag_for(&bytes);
        Self {
            meta: WorkspaceResolvedIcon {
                kind: WorkspaceResolvedIconKind::Image,
                etag: Some(etag),
                source: Some(source),
                domain,
            },
            bytes: Some(bytes),
            content_type: Some(content_type),
        }
    }
}

fn etag_for(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_hosting_domain(domain: &str) -> bool {
    domain == "github.com"
        || domain.ends_with(".github.com")
        || domain == "gitlab.com"
        || domain.ends_with(".gitlab.com")
        || domain == "bitbucket.org"
        || domain.ends_with(".bitbucket.org")
}

pub fn domain_from_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let rest = if let Some(rest) = trimmed.strip_prefix("git@") {
        rest
    } else {
        let without_git_plus = trimmed.strip_prefix("git+").unwrap_or(trimmed);
        without_git_plus
            .strip_prefix("ssh://git@")
            .or_else(|| without_git_plus.strip_prefix("ssh://"))
            .or_else(|| without_git_plus.strip_prefix("git://"))
            .or_else(|| without_git_plus.strip_prefix("https://"))
            .or_else(|| without_git_plus.strip_prefix("http://"))
            .unwrap_or(without_git_plus)
    };
    let host = rest.split(['/', ':', '?']).next()?.trim();
    let domain = sanitize_logo_domain(host).ok()?;
    if is_hosting_domain(&domain) {
        return None;
    }
    Some(domain)
}

fn content_type_for_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("svg") => Some("image/svg+xml"),
        Some("png") => Some("image/png"),
        Some("ico") => Some("image/x-icon"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn read_local_icon(path: &Path) -> Option<(Vec<u8>, String)> {
    let content_type = content_type_for_path(path)?.to_string();
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    Some((bytes, content_type))
}

fn first_local_icon(root: &Path) -> Option<DiscoveredIcon> {
    for relative in LOCAL_ICON_CANDIDATES {
        let path = root.join(relative);
        if !path.is_file() {
            continue;
        }
        let Some(content_type) = content_type_for_path(&path) else {
            continue;
        };
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        if metadata.len() == 0 || metadata.len() > MAX_BYTES as u64 {
            continue;
        }
        return Some(DiscoveredIcon::File {
            path,
            content_type: content_type.to_string(),
        });
    }
    None
}

fn domain_from_package_json(root: &Path) -> Option<String> {
    let path = root.join("package.json");
    let raw = read_hint_file(&path)?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if let Some(homepage) = value.get("homepage").and_then(serde_json::Value::as_str) {
        if let Some(domain) = domain_from_url(homepage) {
            return Some(domain);
        }
    }
    match value.get("repository") {
        Some(serde_json::Value::String(url)) => domain_from_url(url),
        Some(serde_json::Value::Object(object)) => object
            .get("url")
            .and_then(serde_json::Value::as_str)
            .and_then(domain_from_url),
        _ => None,
    }
}

fn domain_from_cargo_toml(root: &Path) -> Option<String> {
    let path = root.join("Cargo.toml");
    let raw = read_hint_file(&path)?;
    let mut in_package = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
            continue;
        }
        if !in_package {
            continue;
        }
        for key in ["homepage", "repository"] {
            let prefix = format!("{key}");
            let Some(rest) = trimmed.strip_prefix(&prefix) else {
                continue;
            };
            let Some(rest) = rest.trim_start().strip_prefix('=') else {
                continue;
            };
            if let Some(domain) = quoted_toml_string(rest).and_then(domain_from_url) {
                return Some(domain);
            }
        }
    }
    None
}

fn quoted_toml_string(value: &str) -> Option<&str> {
    let value = value.trim();
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    Some(inner)
}

fn read_hint_file(path: &Path) -> Option<String> {
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_HINT_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

pub fn discover_auto(workspace_path: &Path) -> DiscoveredIcon {
    if let Some(file) = first_local_icon(workspace_path) {
        return file;
    }
    if let Some(domain) = domain_from_package_json(workspace_path) {
        return DiscoveredIcon::Domain { domain };
    }
    if let Some(domain) = domain_from_cargo_toml(workspace_path) {
        return DiscoveredIcon::Domain { domain };
    }
    DiscoveredIcon::Folder
}

pub async fn discover_git_origin(workspace_path: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(workspace_path)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    domain_from_url(std::str::from_utf8(&output.stdout).ok()?)
}

pub async fn resolve(
    workspace_path: &Path,
    preference: Option<&WorkspaceIconPreference>,
) -> CachedWorkspaceIcon {
    match preference.map(|pref| pref.mode) {
        Some(WorkspaceIconMode::Folder) => CachedWorkspaceIcon::folder(),
        Some(WorkspaceIconMode::Domain) => {
            let Some(domain) = preference.and_then(|pref| pref.domain.as_deref()) else {
                return CachedWorkspaceIcon::folder();
            };
            fetch_domain(domain).await
        }
        None | Some(WorkspaceIconMode::Auto) => resolve_auto(workspace_path).await,
    }
}

async fn resolve_auto(workspace_path: &Path) -> CachedWorkspaceIcon {
    match discover_auto(workspace_path) {
        DiscoveredIcon::File { path, .. } => match read_local_icon(&path) {
            Some((bytes, content_type)) => {
                CachedWorkspaceIcon::image(bytes, content_type, WorkspaceIconSource::File, None)
            }
            None => CachedWorkspaceIcon::folder(),
        },
        DiscoveredIcon::Domain { domain } => fetch_domain(&domain).await,
        DiscoveredIcon::Folder => {
            if let Some(domain) = discover_git_origin(workspace_path).await {
                return fetch_domain(&domain).await;
            }
            CachedWorkspaceIcon::folder()
        }
    }
}

async fn fetch_domain(domain: &str) -> CachedWorkspaceIcon {
    match connector_logos::load(domain).await {
        Ok((bytes, content_type)) => CachedWorkspaceIcon::image(
            bytes,
            content_type,
            WorkspaceIconSource::Domain,
            Some(domain.to_string()),
        ),
        Err(_) => CachedWorkspaceIcon::folder(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = fs::File::create(path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn domain_from_url_skips_hosting_and_extracts_sites() {
        assert_eq!(
            domain_from_url("https://lucidpic.com/app"),
            Some("lucidpic.com".to_string())
        );
        assert_eq!(domain_from_url("git@github.com:acme/app.git"), None);
        assert_eq!(domain_from_url("https://github.com/acme/app.git"), None);
        assert_eq!(domain_from_url("git+https://gitlab.com/acme/app.git"), None);
        assert_eq!(
            domain_from_url("https://www.example.co.uk/path"),
            Some("www.example.co.uk".to_string())
        );
        assert_eq!(domain_from_url("not a url"), None);
    }

    #[test]
    fn discover_prefers_a_root_favicon() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("favicon.svg"), "<svg></svg>");
        write(
            &dir.path().join("package.json"),
            r#"{"homepage":"https://example.com"}"#,
        );
        assert!(matches!(
            discover_auto(dir.path()),
            DiscoveredIcon::File { content_type, .. } if content_type == "image/svg+xml"
        ));
    }

    #[test]
    fn discover_uses_package_homepage_when_no_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("package.json"),
            r#"{"homepage":"https://FalconDeck.app/docs"}"#,
        );
        assert_eq!(
            discover_auto(dir.path()),
            DiscoveredIcon::Domain {
                domain: "falcondeck.app".to_string()
            }
        );
    }

    #[test]
    fn discover_skips_github_repository_urls() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("package.json"),
            r#"{"repository":{"url":"git@github.com:acme/app.git"}}"#,
        );
        assert_eq!(discover_auto(dir.path()), DiscoveredIcon::Folder);
    }

    #[test]
    fn discover_reads_cargo_homepage() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("Cargo.toml"),
            "[package]\nname = \"demo\"\nhomepage = \"https://demo.dev\"\n",
        );
        assert_eq!(
            discover_auto(dir.path()),
            DiscoveredIcon::Domain {
                domain: "demo.dev".to_string()
            }
        );
    }

    #[test]
    fn folder_preference_skips_discovery() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("favicon.png"), "png-bytes");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let resolved = runtime.block_on(resolve(
            dir.path(),
            Some(&WorkspaceIconPreference {
                mode: WorkspaceIconMode::Folder,
                domain: None,
            }),
        ));
        assert_eq!(resolved.meta.kind, WorkspaceResolvedIconKind::Folder);
        assert!(resolved.bytes.is_none());
    }

    #[test]
    fn auto_preference_loads_local_file_bytes() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("public/favicon.svg"), "<svg></svg>");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let resolved = runtime.block_on(resolve(dir.path(), None));
        assert_eq!(resolved.meta.kind, WorkspaceResolvedIconKind::Image);
        assert_eq!(resolved.meta.source, Some(WorkspaceIconSource::File));
        assert_eq!(resolved.content_type.as_deref(), Some("image/svg+xml"));
        assert_eq!(resolved.bytes.as_deref(), Some(b"<svg></svg>".as_slice()));
        assert!(resolved.meta.etag.is_some());
    }

    #[test]
    fn domain_preference_rejects_unsanitized_hosts_via_loader() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let resolved = runtime.block_on(resolve(
            dir.path(),
            Some(&WorkspaceIconPreference {
                mode: WorkspaceIconMode::Domain,
                domain: Some("../etc/passwd".to_string()),
            }),
        ));
        assert_eq!(resolved.meta.kind, WorkspaceResolvedIconKind::Folder);
    }
}
