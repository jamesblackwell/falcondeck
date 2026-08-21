//! FalconDeck-managed skill library: install, list, and remove skills under
//! the shared `~/.agents/skills` root, plus a proxy for browsing the skills.sh
//! registry.
//!
//! `~/.agents/skills` is already a scan root for every provider
//! ([`crate::skills::skill_scan_roots`]), so an installed skill reaches Codex,
//! Claude, OpenCode, and Agy with no extra plumbing. FalconDeck only ever
//! deletes directories it installed itself, which it recognises by the
//! `.falcondeck-skill.json` provenance file written at install time — a
//! hand-placed skill in the same root is listed but never touched.

use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::skills::parse_markdown_metadata;

/// Provenance marker linking an installed directory back to its registry
/// entry. Its presence is what makes a skill "managed" (deletable).
const PROVENANCE_FILE: &str = ".falcondeck-skill.json";

const REGISTRY_BASE_URL: &str = "https://skills.sh";
const GITHUB_API_BASE_URL: &str = "https://api.github.com";
const GITHUB_RAW_BASE_URL: &str = "https://raw.githubusercontent.com";
const USER_AGENT: &str = "falcondeck-daemon";

/// Bounds on one installed skill tree. A registry skill is a prompt package,
/// not a software distribution; anything larger than this is suspect.
const MAX_SKILL_FILES: usize = 64;
const MAX_SKILL_BYTES: u64 = 5 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("failed to build http client: {error}"))
}

pub fn library_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".agents").join("skills"))
}

/// Lists every skill directory under the library root, managed or not.
pub fn library_overview(root: &Path) -> Value {
    let mut skills = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            let Ok(content) = std::fs::read_to_string(&skill_md) else {
                continue;
            };
            let metadata = parse_markdown_metadata(&content);
            let name = entry.file_name().to_string_lossy().to_string();
            let provenance = read_provenance(&path);
            skills.push(json!({
                "name": name,
                "description": metadata.description,
                "path": path.to_string_lossy(),
                "managed": provenance.is_some(),
                "source": provenance.as_ref().and_then(|p| p.source.clone()),
                "registryId": provenance.as_ref().and_then(|p| p.registry_id.clone()),
                "installedAt": provenance.as_ref().and_then(|p| p.installed_at.clone()),
            }));
        }
    }
    skills.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or_default())
    });
    json!({
        "root": root.to_string_lossy(),
        "skills": skills,
    })
}

#[derive(Deserialize)]
struct Provenance {
    source: Option<String>,
    #[serde(rename = "registryId")]
    registry_id: Option<String>,
    #[serde(rename = "installedAt")]
    installed_at: Option<String>,
}

fn read_provenance(skill_dir: &Path) -> Option<Provenance> {
    let raw = std::fs::read_to_string(skill_dir.join(PROVENANCE_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn installed_names(root: &Path) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.path().join("SKILL.md").is_file() {
                names.insert(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    names
}

/// Searches the skills.sh registry (or lists the trending page when the query
/// is empty) and marks entries already present in the local library.
pub async fn search_registry(root: &Path, query: &str, limit: usize) -> Result<Value, String> {
    let query = query.trim();
    let limit = limit.clamp(1, 100);
    let entries = if query.len() >= 2 {
        search_registry_api(query, limit).await?
    } else {
        fetch_trending(limit).await?
    };

    let installed = installed_names(root);
    let skills = entries
        .into_iter()
        .map(|entry| {
            let is_installed = installed.contains(&entry.skill_id);
            json!({
                "id": format!("{}/{}", entry.source, entry.skill_id),
                "skillId": entry.skill_id,
                "name": entry.name,
                "source": entry.source,
                "installs": entry.installs,
                "installed": is_installed,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "query": query,
        "ranking": if query.len() >= 2 { "all-time" } else { "trending" },
        "skills": skills,
    }))
}

struct RegistryEntry {
    source: String,
    skill_id: String,
    name: String,
    installs: u64,
}

async fn search_registry_api(query: &str, limit: usize) -> Result<Vec<RegistryEntry>, String> {
    let url = format!(
        "{REGISTRY_BASE_URL}/api/search?q={}&limit={limit}",
        urlencoding_encode(query)
    );
    let response = http_client()?
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("skills.sh search failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "skills.sh search failed: HTTP {}",
            response.status()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("skills.sh search returned invalid JSON: {error}"))?;
    let skills = body
        .get("skills")
        .and_then(Value::as_array)
        .ok_or("skills.sh search response missing skills array")?;
    Ok(skills
        .iter()
        .filter_map(|entry| {
            Some(RegistryEntry {
                source: entry.get("source")?.as_str()?.to_string(),
                skill_id: entry.get("skillId")?.as_str()?.to_string(),
                name: entry.get("name")?.as_str()?.to_string(),
                installs: entry.get("installs").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect())
}

/// The registry has no public trending JSON endpoint, so this parses the
/// skill records embedded in the homepage's flight data. If the markup
/// changes this returns an empty list and browse degrades to search-only.
async fn fetch_trending(limit: usize) -> Result<Vec<RegistryEntry>, String> {
    let response = http_client()?
        .get(REGISTRY_BASE_URL)
        .send()
        .await
        .map_err(|error| format!("skills.sh trending fetch failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "skills.sh trending fetch failed: HTTP {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("skills.sh trending fetch failed: {error}"))?;
    Ok(parse_trending_page(&body, limit))
}

fn parse_trending_page(body: &str, limit: usize) -> Vec<RegistryEntry> {
    let pattern = regex::Regex::new(
        r#"\\"source\\":\\"([^"\\]+)\\",\\"skillId\\":\\"([^"\\]+)\\",\\"name\\":\\"([^"\\]+)\\",\\"installs\\":(\d+)"#,
    )
    .expect("trending pattern compiles");
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    for captures in pattern.captures_iter(body) {
        let source = captures[1].to_string();
        let skill_id = captures[2].to_string();
        if !seen.insert(format!("{source}/{skill_id}")) {
            continue;
        }
        entries.push(RegistryEntry {
            source,
            skill_id,
            name: captures[3].to_string(),
            installs: captures[4].parse().unwrap_or(0),
        });
        if entries.len() >= limit {
            break;
        }
    }
    entries
}

fn urlencoding_encode(raw: &str) -> String {
    let mut encoded = String::new();
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// One `owner/repo` GitHub source, validated so it can never smuggle extra
/// path segments into a request URL.
fn validate_source(source: &str) -> Result<(), String> {
    let parts = source.split('/').collect::<Vec<_>>();
    if parts.len() != 2 {
        return Err("source must be a GitHub owner/repo".to_string());
    }
    for part in parts {
        if part.is_empty()
            || part == "."
            || part == ".."
            || !part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err("source contains invalid characters".to_string());
        }
    }
    Ok(())
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.starts_with('.')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("invalid skill name".to_string());
    }
    Ok(())
}

/// True when every segment of a repo-relative path is a plain name — no
/// leading slash, no `.`/`..`, nothing that could escape the staging dir.
fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// Downloads one skill from a GitHub repo into the library root. The tree is
/// resolved through the GitHub API, bounded, staged into a temp dir, and
/// atomically renamed into place with a provenance marker.
pub async fn install_skill(root: &Path, source: &str, skill: &str) -> Result<Value, String> {
    validate_source(source)?;
    validate_skill_name(skill)?;

    let destination = root.join(skill);
    if destination.exists() {
        return Err(format!("skill '{skill}' is already installed"));
    }

    let client = http_client()?;
    let tree_url = format!("{GITHUB_API_BASE_URL}/repos/{source}/git/trees/HEAD?recursive=1");
    let response = client
        .get(&tree_url)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("failed to list {source}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "failed to list {source}: HTTP {}",
            response.status()
        ));
    }
    let tree: Value = response
        .json()
        .await
        .map_err(|error| format!("invalid GitHub tree response: {error}"))?;
    let entries = tree
        .get("tree")
        .and_then(Value::as_array)
        .ok_or("GitHub tree response missing entries")?;

    // The skill directory is any tree path ending in `<skill>/SKILL.md`;
    // prefer the shallowest match (repo conventions put skills near the root).
    let marker = format!("{skill}/SKILL.md");
    let skill_prefix = entries
        .iter()
        .filter_map(|entry| entry.get("path").and_then(Value::as_str))
        .filter(|path| *path == marker || path.ends_with(&format!("/{marker}")))
        .min_by_key(|path| path.len())
        .map(|path| path[..path.len() - "SKILL.md".len()].to_string())
        .ok_or_else(|| format!("no {marker} found in {source}"))?;

    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    for entry in entries {
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            continue;
        };
        if !path.starts_with(&skill_prefix)
            || entry.get("type").and_then(Value::as_str) != Some("blob")
        {
            continue;
        }
        if entry.get("mode").and_then(Value::as_str) == Some("120000") {
            return Err("skill contains a symlink, refusing to install".to_string());
        }
        let relative = &path[skill_prefix.len()..];
        if !is_safe_relative_path(relative) {
            return Err(format!("skill contains an unsafe path: {path}"));
        }
        let size = entry.get("size").and_then(Value::as_u64).unwrap_or(0);
        if size > MAX_FILE_BYTES {
            return Err(format!(
                "skill file {relative} exceeds {MAX_FILE_BYTES} bytes"
            ));
        }
        total_bytes += size;
        files.push((path.to_string(), relative.to_string()));
    }
    if files.len() > MAX_SKILL_FILES {
        return Err(format!("skill has more than {MAX_SKILL_FILES} files"));
    }
    if total_bytes > MAX_SKILL_BYTES {
        return Err(format!("skill exceeds {MAX_SKILL_BYTES} bytes"));
    }

    let mut downloads = Vec::new();
    for (repo_path, relative) in &files {
        let encoded = repo_path
            .split('/')
            .map(urlencoding_encode)
            .collect::<Vec<_>>()
            .join("/");
        let raw_url = format!("{GITHUB_RAW_BASE_URL}/{source}/HEAD/{encoded}");
        let response = client
            .get(&raw_url)
            .send()
            .await
            .map_err(|error| format!("failed to download {repo_path}: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "failed to download {repo_path}: HTTP {}",
                response.status()
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("failed to download {repo_path}: {error}"))?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(format!(
                "skill file {relative} exceeds {MAX_FILE_BYTES} bytes"
            ));
        }
        downloads.push((relative.clone(), bytes.to_vec()));
    }

    let skill_md = downloads
        .iter()
        .find(|(relative, _)| relative == "SKILL.md")
        .ok_or("downloaded skill is missing SKILL.md")?;
    let metadata = parse_markdown_metadata(&String::from_utf8_lossy(&skill_md.1));
    if metadata
        .description
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
    {
        return Err("skill's SKILL.md has no description frontmatter".to_string());
    }

    std::fs::create_dir_all(root)
        .map_err(|error| format!("failed to create {}: {error}", root.display()))?;
    // Stage inside the root so the final rename stays on one filesystem.
    let staging = root.join(format!(".install-{}", uuid::Uuid::new_v4().simple()));
    let stage_result = stage_skill_files(&staging, &downloads, source, skill);
    if let Err(error) = stage_result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&staging, &destination) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("failed to adopt skill directory: {error}"));
    }

    tracing::info!(skill, source, "installed skill from registry");
    Ok(json!({
        "name": skill,
        "source": source,
        "description": metadata.description,
        "path": destination.to_string_lossy(),
    }))
}

fn stage_skill_files(
    staging: &Path,
    downloads: &[(String, Vec<u8>)],
    source: &str,
    skill: &str,
) -> Result<(), String> {
    for (relative, bytes) in downloads {
        let target = staging.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        std::fs::File::create(&target)
            .and_then(|mut file| file.write_all(bytes))
            .map_err(|error| format!("failed to write {}: {error}", target.display()))?;
    }
    let provenance = serde_json::to_string_pretty(&json!({
        "version": 1,
        "registryId": format!("{source}/{skill}"),
        "source": source,
        "installedAt": chrono::Utc::now().to_rfc3339(),
    }))
    .map_err(|error| format!("failed to encode provenance: {error}"))?;
    std::fs::write(staging.join(PROVENANCE_FILE), provenance)
        .map_err(|error| format!("failed to write provenance: {error}"))?;
    Ok(())
}

/// Deletes one skill directory, but only when FalconDeck installed it — the
/// provenance file is the ownership proof. Hand-authored skills in the same
/// root are never deleted through this path.
pub fn uninstall_skill(root: &Path, name: &str) -> Result<(), String> {
    validate_skill_name(name)?;
    let skill_dir = root.join(name);
    if !skill_dir.is_dir() {
        return Err(format!("skill '{name}' is not installed"));
    }
    if !skill_dir.join(PROVENANCE_FILE).is_file() {
        return Err(format!(
            "skill '{name}' was not installed by FalconDeck; remove it manually"
        ));
    }
    std::fs::remove_dir_all(&skill_dir)
        .map_err(|error| format!("failed to remove skill '{name}': {error}"))?;
    tracing::info!(skill = name, "uninstalled managed skill");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, name: &str, description: &str, managed: bool) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\nBody\n"),
        )
        .unwrap();
        if managed {
            std::fs::write(
                dir.join(PROVENANCE_FILE),
                format!("{{\"version\":1,\"registryId\":\"acme/skills/{name}\",\"source\":\"acme/skills\",\"installedAt\":\"2026-08-21T00:00:00Z\"}}"),
            )
            .unwrap();
        }
    }

    #[test]
    fn overview_lists_skills_and_marks_managed_entries() {
        let temp = tempfile::tempdir().unwrap();
        write_skill(temp.path(), "zeta", "Managed skill", true);
        write_skill(temp.path(), "alpha", "Hand-placed skill", false);

        let overview = library_overview(temp.path());
        let skills = overview.get("skills").and_then(Value::as_array).unwrap();
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].get("name").unwrap(), "alpha");
        assert_eq!(skills[0].get("managed").unwrap(), false);
        assert_eq!(skills[1].get("name").unwrap(), "zeta");
        assert_eq!(skills[1].get("managed").unwrap(), true);
        assert_eq!(skills[1].get("source").unwrap(), "acme/skills");
    }

    #[test]
    fn uninstall_refuses_unmanaged_skills() {
        let temp = tempfile::tempdir().unwrap();
        write_skill(temp.path(), "handmade", "Precious", false);

        let error = uninstall_skill(temp.path(), "handmade").unwrap_err();
        assert!(error.contains("not installed by FalconDeck"));
        assert!(temp.path().join("handmade/SKILL.md").is_file());
    }

    #[test]
    fn uninstall_removes_managed_skills() {
        let temp = tempfile::tempdir().unwrap();
        write_skill(temp.path(), "managed", "Disposable", true);

        uninstall_skill(temp.path(), "managed").unwrap();
        assert!(!temp.path().join("managed").exists());
    }

    #[test]
    fn uninstall_rejects_path_traversal() {
        let temp = tempfile::tempdir().unwrap();
        assert!(uninstall_skill(temp.path(), "../elsewhere").is_err());
        assert!(uninstall_skill(temp.path(), "..").is_err());
        assert!(uninstall_skill(temp.path(), ".hidden").is_err());
    }

    #[test]
    fn source_validation_rejects_traversal_and_extra_segments() {
        assert!(validate_source("vercel-labs/agent-skills").is_ok());
        assert!(validate_source("owner").is_err());
        assert!(validate_source("owner/repo/extra").is_err());
        assert!(validate_source("../etc/passwd").is_err());
        assert!(validate_source("owner/..").is_err());
        assert!(validate_source("owner/re po").is_err());
    }

    #[test]
    fn safe_relative_path_rejects_escapes() {
        assert!(is_safe_relative_path("SKILL.md"));
        assert!(is_safe_relative_path("references/palette.md"));
        assert!(!is_safe_relative_path("../outside.md"));
        assert!(!is_safe_relative_path("a/../../outside.md"));
        assert!(!is_safe_relative_path("/absolute.md"));
        assert!(!is_safe_relative_path(""));
    }

    #[test]
    fn trending_page_parser_extracts_flight_records() {
        let body = r#"self.__next_f.push([1,"{\"source\":\"vercel-labs/skills\",\"skillId\":\"find-skills\",\"name\":\"find-skills\",\"installs\":3012345}...{\"source\":\"mattpocock/skills\",\"skillId\":\"grill-me\",\"name\":\"grill-me\",\"installs\":924400}...{\"source\":\"vercel-labs/skills\",\"skillId\":\"find-skills\",\"name\":\"find-skills\",\"installs\":3012345}"])"#;
        let entries = parse_trending_page(body, 10);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].skill_id, "find-skills");
        assert_eq!(entries[0].installs, 3012345);
        assert_eq!(entries[1].source, "mattpocock/skills");
    }
}
