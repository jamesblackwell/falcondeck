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

const ICON_FILE_NAMES: &[&str] = &[
    "favicon.svg",
    "favicon.png",
    "favicon-32x32.png",
    "apple-touch-icon.png",
    "apple-touch-icon-precomposed.png",
    "icon.png",
    "logo.svg",
    "logo.png",
    "logomark-mark-dark.svg",
    "logomark-mark-light.svg",
    "logomark-mark.svg",
    "google-app-icon.png",
    "favicon.ico",
];

const ICON_DIRECTORIES: &[&str] = &[
    "",
    "public",
    "public/images",
    "assets",
    "assets/brand",
    "frontend/public",
    "frontend/public/images",
    "web/public",
    "client/public",
    "src",
    "src/app",
    "app",
    "static",
];

const SKIP_APP_DIR_NAMES: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "target",
    "trees",
    "vendor",
    ".git",
    ".next",
    "coverage",
    "storybook-static",
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

fn is_unusable_site_domain(domain: &str) -> bool {
    is_hosting_domain(domain)
        || domain == "localhost"
        || domain.ends_with(".localhost")
        || domain.parse::<std::net::Ipv4Addr>().is_ok()
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
    if is_unusable_site_domain(&domain) {
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

fn icon_directories(root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ICON_DIRECTORIES
        .iter()
        .map(|prefix| {
            if prefix.is_empty() {
                root.to_path_buf()
            } else {
                root.join(prefix)
            }
        })
        .collect();
    let apps = root.join("apps");
    if apps.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&apps) {
            for entry in entries.flatten().take(24) {
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                if name.starts_with('.') || SKIP_APP_DIR_NAMES.contains(&name) {
                    continue;
                }
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                dirs.push(path.join("public"));
                dirs.push(path.join("assets"));
            }
        }
    }
    dirs
}

fn usable_icon_file(path: &Path) -> Option<DiscoveredIcon> {
    if !path.is_file() {
        return None;
    }
    let content_type = content_type_for_path(path)?.to_string();
    let metadata = path.metadata().ok()?;
    if metadata.len() == 0 || metadata.len() > MAX_BYTES as u64 {
        return None;
    }
    Some(DiscoveredIcon::File {
        path: path.to_path_buf(),
        content_type,
    })
}

fn first_local_icon(root: &Path) -> Option<DiscoveredIcon> {
    let dirs = icon_directories(root);
    for name in ICON_FILE_NAMES {
        for dir in &dirs {
            if let Some(found) = usable_icon_file(&dir.join(name)) {
                return Some(found);
            }
        }
    }
    None
}

fn domain_from_composer_json(root: &Path) -> Option<String> {
    let raw = read_hint_file(&root.join("composer.json"))?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("homepage")
        .and_then(serde_json::Value::as_str)
        .and_then(domain_from_url)
}

fn domain_from_app_url_file(root: &Path) -> Option<String> {
    for name in [".env.example", ".env"] {
        let Some(raw) = read_hint_file(&root.join(name)) else {
            continue;
        };
        for line in raw.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            for key in ["APP_URL=", "NEXT_PUBLIC_SITE_URL=", "VITE_APP_URL="] {
                if let Some(value) = line.strip_prefix(key) {
                    let value = value.trim().trim_matches(['"', '\'']);
                    if let Some(domain) = domain_from_url(value) {
                        if domain != "localhost" && !domain.ends_with(".localhost") {
                            return Some(domain);
                        }
                    }
                }
            }
        }
    }
    None
}

fn domain_from_readme(root: &Path) -> Option<String> {
    let slug = root
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            name.trim()
                .to_ascii_lowercase()
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .collect::<String>()
        })
        .filter(|slug| slug.len() >= 3)?;
    for name in ["README.md", "README", "readme.md"] {
        let Some(raw) = read_hint_file(&root.join(name)) else {
            continue;
        };
        let text = if raw.len() > 32_000 {
            &raw[..32_000]
        } else {
            &raw
        };
        for candidate in readme_urls(text) {
            let Some(domain) = domain_from_url(candidate) else {
                continue;
            };
            let host = domain.strip_prefix("www.").unwrap_or(&domain);
            let label = host.split('.').next().unwrap_or(host);
            if label == slug || host.starts_with(&format!("{slug}.")) {
                return Some(domain);
            }
        }
    }
    None
}

fn next_url_start(text: &str) -> Option<usize> {
    let http = text.find("http://");
    let https = text.find("https://");
    match (http, https) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(index), None) | (None, Some(index)) => Some(index),
        _ => None,
    }
}

fn readme_urls(text: &str) -> Vec<&str> {
    let mut urls = Vec::new();
    let mut index = 0;
    while index + 8 < text.len() {
        let Some(rel) = next_url_start(&text[index..]) else {
            break;
        };
        let start = index + rel;
        let mut end = start;
        while end < text.len() {
            let ch = text.as_bytes()[end];
            if ch.is_ascii_whitespace() || matches!(ch, b')' | b']' | b'>' | b'"' | b'\'' | b'`') {
                break;
            }
            end += 1;
        }
        let url = text[start..end].trim_end_matches(['.', ',', ';']);
        if url.len() > 10 {
            urls.push(url);
        }
        index = end.max(start + 1);
    }
    urls
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
    if let Some(domain) = domain_from_composer_json(workspace_path) {
        return DiscoveredIcon::Domain { domain };
    }
    if let Some(domain) = domain_from_cargo_toml(workspace_path) {
        return DiscoveredIcon::Domain { domain };
    }
    if let Some(domain) = domain_from_app_url_file(workspace_path) {
        return DiscoveredIcon::Domain { domain };
    }
    if let Some(domain) = domain_from_readme(workspace_path) {
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
    fn discover_reads_nested_app_favicons() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("apps/desktop/public/favicon.svg"),
            "<svg></svg>",
        );
        assert!(matches!(
            discover_auto(dir.path()),
            DiscoveredIcon::File { content_type, .. } if content_type == "image/svg+xml"
        ));
    }

    #[test]
    fn discover_reads_brand_logomark() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("assets/brand/logomark-mark-dark.svg"),
            "<svg></svg>",
        );
        assert!(matches!(
            discover_auto(dir.path()),
            DiscoveredIcon::File { path, .. } if path.ends_with("logomark-mark-dark.svg")
        ));
    }

    #[test]
    fn discover_reads_frontend_public_favicon() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("frontend/public/apple-touch-icon.png"),
            "png",
        );
        assert!(matches!(
            discover_auto(dir.path()),
            DiscoveredIcon::File { content_type, .. } if content_type == "image/png"
        ));
    }

    #[test]
    fn discover_uses_readme_url_matching_the_folder_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("falcondeck");
        write(
            &root.join("README.md"),
            "# FalconDeck\n\nInstall from https://github.com/acme/falcondeck then open https://falcondeck.com.\n",
        );
        assert_eq!(
            discover_auto(&root),
            DiscoveredIcon::Domain {
                domain: "falcondeck.com".to_string()
            }
        );
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
