use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
};

use falcondeck_core::{
    AgentProvider, ClaudeSkillTranslation, CodexSkillTranslation, OpenCodeSkillTranslation,
    SkillProviderTranslations, SkillSourceKind, SkillSummary, skill_availability_from_providers,
};
use serde_json::Value;

pub fn canonical_skill_alias(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches('/').trim_start_matches('$');
    let mut normalized = String::new();
    let mut last_was_dash = false;

    for ch in trimmed.chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else if matches!(ch, ' ' | '_' | '-') {
            '-'
        } else {
            continue;
        };

        if mapped == '-' {
            if normalized.is_empty() || last_was_dash {
                continue;
            }
            last_was_dash = true;
        } else {
            last_was_dash = false;
        }
        normalized.push(mapped);
    }

    let normalized = normalized.trim_matches('-');
    if normalized.is_empty() {
        "/skill".to_string()
    } else {
        format!("/{normalized}")
    }
}

/// File-backed skill locations, per provider. `.agents/skills` is the shared
/// convention every provider reads (OpenCode scans it natively too); the
/// others are provider-native dirs. Extending a provider's skill surface
/// means adding a row here, not code.
fn skill_scan_roots(root: &Path, source_kind: SkillSourceKind) -> Vec<SkillScanRoot> {
    vec![
        SkillScanRoot {
            dir: root.join(".agents/skills"),
            source_kind: source_kind.clone(),
            providers: vec![
                AgentProvider::CODEX,
                AgentProvider::CLAUDE,
                AgentProvider::AGY,
                AgentProvider::OPENCODE,
                AgentProvider::GROK,
            ],
            layout: SkillDirLayout::AgentsSkills,
        },
        SkillScanRoot {
            dir: root.join(".codex/skills"),
            source_kind: source_kind.clone(),
            providers: vec![AgentProvider::CODEX],
            layout: SkillDirLayout::AgentsSkills,
        },
        SkillScanRoot {
            dir: root.join(".opencode/skills"),
            source_kind: source_kind.clone(),
            providers: vec![AgentProvider::OPENCODE],
            layout: SkillDirLayout::AgentsSkills,
        },
        SkillScanRoot {
            dir: root.join(".grok/skills"),
            source_kind: source_kind.clone(),
            providers: vec![AgentProvider::GROK],
            layout: SkillDirLayout::AgentsSkills,
        },
        SkillScanRoot {
            dir: root.join(".claude/commands"),
            source_kind,
            providers: vec![AgentProvider::CLAUDE],
            layout: SkillDirLayout::ClaudeCommands,
        },
    ]
}

struct SkillScanRoot {
    dir: PathBuf,
    source_kind: SkillSourceKind,
    providers: Vec<AgentProvider>,
    layout: SkillDirLayout,
}

enum SkillDirLayout {
    /// `<dir>/<name>/SKILL.md` or `<dir>/<name>.md`.
    AgentsSkills,
    /// Flat `<dir>/<name>.md` slash commands.
    ClaudeCommands,
}

pub fn discover_file_backed_skills(workspace_path: &str) -> Vec<SkillSummary> {
    let mut entries = Vec::new();

    let mut roots = skill_scan_roots(Path::new(workspace_path), SkillSourceKind::ProjectFile);
    if let Some(home) = home_dir() {
        roots.extend(skill_scan_roots(&home, SkillSourceKind::HomeFile));
        roots.push(SkillScanRoot {
            dir: home.join(".config/opencode/skills"),
            source_kind: SkillSourceKind::HomeFile,
            providers: vec![AgentProvider::OPENCODE],
            layout: SkillDirLayout::AgentsSkills,
        });
    }
    for root in roots {
        match root.layout {
            SkillDirLayout::AgentsSkills => entries.extend(scan_agents_skill_dir(
                &root.dir,
                root.source_kind,
                &root.providers,
            )),
            SkillDirLayout::ClaudeCommands => {
                entries.extend(scan_claude_command_dir(&root.dir, root.source_kind));
            }
        }
    }

    entries
}

pub fn parse_codex_provider_skills(value: &Value) -> Vec<SkillSummary> {
    value
        .get("result")
        .and_then(Value::as_object)
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
        .or_else(|| value.get("data").and_then(Value::as_array))
        .or_else(|| value.get("skills").and_then(Value::as_array))
        .or_else(|| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let name = extract_string(entry, &["name", "id", "slug"])?;
            let alias = canonical_skill_alias(&name);
            let canonical_name = alias.trim_start_matches('/').to_string();
            Some(SkillSummary {
                id: alias_to_skill_id(&alias),
                label: extract_string(entry, &["title", "label", "displayName", "name"])
                    .unwrap_or_else(|| alias.trim_start_matches('/').to_string()),
                alias,
                availability: skill_availability_from_providers(&[AgentProvider::CODEX]),
                providers: vec![AgentProvider::CODEX],
                source_kind: SkillSourceKind::ProviderNative,
                source_path: None,
                description: extract_string(entry, &["description", "summary"]),
                provider_translations: SkillProviderTranslations {
                    codex: Some(CodexSkillTranslation {
                        native_id: extract_string(entry, &["id", "slug"]),
                        native_name: Some(canonical_name),
                    }),
                    claude: None,
                    opencode: None,
                },
            })
        })
        .collect()
}

pub fn merge_skills(skills: Vec<SkillSummary>) -> Vec<SkillSummary> {
    let mut merged: HashMap<String, SkillSummary> = HashMap::new();

    for skill in skills {
        let key = canonical_skill_alias(&skill.alias);
        let Some(existing) = merged.get_mut(&key) else {
            merged.insert(key, normalize_skill_summary(skill));
            continue;
        };

        let incoming = normalize_skill_summary(skill);
        if source_priority(&incoming.source_kind) < source_priority(&existing.source_kind) {
            existing.label = incoming.label.clone();
            existing.source_kind = incoming.source_kind.clone();
            existing.source_path = incoming.source_path.clone();
            if incoming.description.is_some() {
                existing.description = incoming.description.clone();
            }
        } else if existing.description.is_none() && incoming.description.is_some() {
            existing.description = incoming.description.clone();
        }

        for provider in &incoming.providers {
            if !existing.providers.contains(provider) {
                existing.providers.push(provider.clone());
            }
        }
        existing.providers.sort();
        existing.availability = skill_availability_from_providers(&existing.providers);
        if existing.provider_translations.codex.is_none() {
            existing.provider_translations.codex = incoming.provider_translations.codex.clone();
        }
        if existing.provider_translations.claude.is_none() {
            existing.provider_translations.claude = incoming.provider_translations.claude.clone();
        }
        if existing.provider_translations.opencode.is_none() {
            existing.provider_translations.opencode =
                incoming.provider_translations.opencode.clone();
        }
    }

    let mut values = merged.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| left.alias.cmp(&right.alias));
    values
}

pub fn skills_for_provider(skills: &[SkillSummary], provider: AgentProvider) -> Vec<SkillSummary> {
    skills
        .iter()
        .filter(|skill| skill.supports_provider(&provider))
        .cloned()
        .collect()
}

/// Fresh file-backed scan plus cached provider-native entries. Used by the
/// slash-menu list and by turn start so a skill added on disk is visible
/// without reconnecting. Does not call Codex `skills/list`.
pub fn live_workspace_skills(
    workspace_path: &str,
    cached_skills: &[SkillSummary],
) -> Vec<SkillSummary> {
    let file_backed = discover_file_backed_skills(workspace_path);
    let native = cached_skills
        .iter()
        .filter(|skill| skill.source_kind == SkillSourceKind::ProviderNative)
        .cloned();
    merge_skills(file_backed.into_iter().chain(native).collect())
}

/// Slash-command tokens in user text (`/lint` after whitespace or start).
/// Mirrors the client mention regex so send-time resolution sees the same
/// aliases the composer highlighted.
pub fn slash_command_aliases_in_text(text: &str) -> Vec<String> {
    let mut aliases = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'/' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric()
                    || bytes[index] == b'_'
                    || bytes[index] == b'-')
            {
                index += 1;
            }
            if index > start + 1 {
                let next = bytes.get(index).copied();
                let attached = next.is_some_and(|byte| {
                    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' || byte == b'/'
                });
                if !attached && let Ok(raw) = std::str::from_utf8(&bytes[start..index]) {
                    aliases.push(canonical_skill_alias(raw));
                    continue;
                }
            }
            continue;
        }
        index += 1;
    }
    aliases
}

fn scan_agents_skill_dir(
    dir: &Path,
    source_kind: SkillSourceKind,
    providers: &[AgentProvider],
) -> Vec<SkillSummary> {
    let mut results = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return results;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let skill_path = path.join("SKILL.md");
            if !skill_path.exists() {
                continue;
            }
            if let Some(skill) = parse_markdown_skill(
                &skill_path,
                source_kind.clone(),
                providers,
                path.file_name().and_then(|name| name.to_str()),
            ) {
                results.push(skill);
            }
            continue;
        }

        if !is_markdown_file(&path) {
            continue;
        }
        if let Some(skill) = parse_markdown_skill(&path, source_kind.clone(), providers, None) {
            results.push(skill);
        }
    }

    results
}

fn scan_claude_command_dir(dir: &Path, source_kind: SkillSourceKind) -> Vec<SkillSummary> {
    let mut results = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return results;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() || !is_markdown_file(&path) {
            continue;
        }
        let Some(skill) =
            parse_markdown_skill(&path, source_kind.clone(), &[AgentProvider::CLAUDE], None)
        else {
            continue;
        };
        results.push(SkillSummary {
            provider_translations: SkillProviderTranslations {
                codex: None,
                claude: Some(ClaudeSkillTranslation {
                    command_name: Some(skill.alias.trim_start_matches('/').to_string()),
                    prompt_reference_path: skill.source_path.clone(),
                }),
                opencode: None,
            },
            ..skill
        });
    }

    results
}

fn parse_markdown_skill(
    path: &Path,
    source_kind: SkillSourceKind,
    providers: &[AgentProvider],
    explicit_name: Option<&str>,
) -> Option<SkillSummary> {
    let content = fs::read_to_string(path).ok()?;
    let parsed = parse_markdown_metadata(&content);
    let raw_name = parsed
        .name
        .or_else(|| explicit_name.map(str::to_string))
        .or_else(|| {
            path.file_stem()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })?;
    let alias = canonical_skill_alias(&raw_name);
    let source_path = Some(path.to_string_lossy().to_string());
    // OpenCode resolves skills by their path-derived id (directory name for
    // `<dir>/SKILL.md`, file stem for root-level `.md`), not the frontmatter
    // name, so the `$name` mention must come from the path.
    let path_name = explicit_name
        .map(str::to_string)
        .or_else(|| {
            path.file_stem()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .map(|name| {
            canonical_skill_alias(&name)
                .trim_start_matches('/')
                .to_string()
        });
    let provider_translations = SkillProviderTranslations {
        codex: providers
            .contains(&AgentProvider::CODEX)
            .then(|| CodexSkillTranslation {
                native_id: None,
                native_name: Some(alias.trim_start_matches('/').to_string()),
            }),
        claude: providers
            .contains(&AgentProvider::CLAUDE)
            .then(|| ClaudeSkillTranslation {
                command_name: None,
                prompt_reference_path: source_path.clone(),
            }),
        opencode: providers.contains(&AgentProvider::OPENCODE).then_some(
            OpenCodeSkillTranslation {
                native_name: path_name,
            },
        ),
    };

    Some(SkillSummary {
        id: alias_to_skill_id(&alias),
        label: raw_name.replace(['-', '_'], " "),
        alias,
        availability: skill_availability_from_providers(providers),
        providers: providers.to_vec(),
        source_kind,
        source_path,
        description: parsed.description,
        provider_translations,
    })
}

fn normalize_skill_summary(mut skill: SkillSummary) -> SkillSummary {
    skill.alias = canonical_skill_alias(&skill.alias);
    skill.id = alias_to_skill_id(&skill.alias);
    if skill.label.trim().is_empty() {
        skill.label = skill.alias.trim_start_matches('/').to_string();
    }
    if skill.providers.is_empty() {
        // Legacy input predating the open list: expand the lattice.
        skill.providers = match skill.availability {
            falcondeck_core::SkillAvailability::Codex => vec![AgentProvider::CODEX],
            falcondeck_core::SkillAvailability::Claude => vec![AgentProvider::CLAUDE],
            falcondeck_core::SkillAvailability::Both => {
                vec![AgentProvider::CODEX, AgentProvider::CLAUDE]
            }
        };
    } else {
        skill.providers.sort();
        skill.providers.dedup();
        skill.availability = skill_availability_from_providers(&skill.providers);
    }
    skill
}

fn source_priority(source_kind: &SkillSourceKind) -> usize {
    match source_kind {
        SkillSourceKind::ProviderNative => 0,
        SkillSourceKind::ProjectFile => 1,
        SkillSourceKind::HomeFile => 2,
    }
}

fn alias_to_skill_id(alias: &str) -> String {
    format!("skill:{}", alias.trim_start_matches('/'))
}

fn home_dir() -> Option<PathBuf> {
    env::var("HOME").ok().map(PathBuf::from)
}

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn extract_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) struct MarkdownMetadata {
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
}

pub(crate) fn parse_markdown_metadata(content: &str) -> MarkdownMetadata {
    let lines = content.lines().collect::<Vec<_>>();
    let mut name = None;
    let mut description = None;
    let mut body_start = 0usize;

    if lines.first().map(|line| line.trim()) == Some("---") {
        let mut index = 1usize;
        while index < lines.len() {
            let line = lines[index];
            let trimmed = line.trim();
            if trimmed == "---" {
                body_start = index + 1;
                break;
            }
            if let Some(value) = trimmed.strip_prefix("name:") {
                name = Some(value.trim().trim_matches('"').to_string());
                index += 1;
            } else if let Some(value) = trimmed.strip_prefix("description:") {
                let value = value.trim();
                // Any YAML block-scalar marker (`>`/`|`, optional chomping
                // `-`/`+`) means the text lives on the following lines.
                if matches!(value, "" | ">" | "|" | ">-" | "|-" | ">+" | "|+") {
                    let mut parts = Vec::new();
                    index += 1;
                    while index < lines.len() {
                        let next_line = lines[index];
                        let next_trimmed = next_line.trim();
                        if next_trimmed == "---" {
                            body_start = index + 1;
                            break;
                        }
                        if !next_trimmed.is_empty()
                            && !next_line.starts_with(' ')
                            && !next_line.starts_with('\t')
                        {
                            break;
                        }
                        if !next_trimmed.is_empty() {
                            parts.push(next_trimmed.to_string());
                        }
                        index += 1;
                    }
                    if !parts.is_empty() {
                        description = Some(parts.join(" "));
                    }
                } else {
                    description = Some(value.trim_matches('"').to_string());
                    index += 1;
                }
            } else {
                index += 1;
            }
        }
    }

    if description.is_none() {
        for line in &lines[body_start..] {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed == "---" || trimmed.starts_with('#') {
                continue;
            }
            if trimmed.contains(':') && !trimmed.contains(' ') {
                continue;
            }
            description = Some(trimmed.to_string());
            break;
        }
    }

    MarkdownMetadata { name, description }
}

#[cfg(test)]
mod tests {
    use super::*;
    use falcondeck_core::SkillAvailability;

    #[test]
    fn canonical_alias_collapses_separators() {
        assert_eq!(canonical_skill_alias(" Search_Web "), "/search-web");
        assert_eq!(canonical_skill_alias("$search web"), "/search-web");
    }

    #[test]
    fn merge_prefers_provider_native_source() {
        let merged = merge_skills(vec![
            SkillSummary {
                id: "skill:search-web".to_string(),
                label: "Search Web".to_string(),
                alias: "/search-web".to_string(),
                availability: SkillAvailability::Both,
                providers: vec![AgentProvider::CODEX, AgentProvider::CLAUDE],
                source_kind: SkillSourceKind::ProjectFile,
                source_path: Some("/tmp/project/SKILL.md".to_string()),
                description: Some("Project file".to_string()),
                provider_translations: SkillProviderTranslations::default(),
            },
            SkillSummary {
                id: "skill:search-web".to_string(),
                label: "Search Web Native".to_string(),
                alias: "/search-web".to_string(),
                availability: SkillAvailability::Codex,
                providers: vec![AgentProvider::CODEX],
                source_kind: SkillSourceKind::ProviderNative,
                source_path: None,
                description: Some("Native".to_string()),
                provider_translations: SkillProviderTranslations {
                    codex: Some(CodexSkillTranslation {
                        native_id: Some("search-web".to_string()),
                        native_name: Some("search-web".to_string()),
                    }),
                    claude: None,
                    opencode: None,
                },
            },
        ]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source_kind, SkillSourceKind::ProviderNative);
        assert_eq!(merged[0].availability, SkillAvailability::Both);
        assert_eq!(
            merged[0]
                .provider_translations
                .codex
                .as_ref()
                .and_then(|translation| translation.native_id.as_deref()),
            Some("search-web")
        );
    }

    #[test]
    fn parses_provider_skills_from_nested_result_payload() {
        let skills = parse_codex_provider_skills(&serde_json::json!({
            "result": {
                "data": [{
                    "id": "search-web",
                    "displayName": "Search Web",
                    "description": "Search the web"
                }]
            }
        }));

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].alias, "/search-web");
        assert_eq!(skills[0].label, "Search Web");
        assert_eq!(skills[0].availability, SkillAvailability::Codex);
        assert_eq!(skills[0].source_kind, SkillSourceKind::ProviderNative);
    }

    #[test]
    fn markdown_metadata_uses_first_body_line_when_frontmatter_description_is_missing() {
        let metadata = parse_markdown_metadata(
            r#"---
name: "Rust Docs"
---

# Header

Clear description line
key:value
"#,
        );

        assert_eq!(metadata.name.as_deref(), Some("Rust Docs"));
        assert_eq!(
            metadata.description.as_deref(),
            Some("Clear description line")
        );
    }

    #[test]
    fn markdown_metadata_reads_folded_frontmatter_descriptions() {
        let metadata = parse_markdown_metadata(
            r#"---
name: "Rust Docs"
description: >
  Guide for writing idiomatic Rust code
  based on established best practices.
---
"#,
        );

        assert_eq!(metadata.name.as_deref(), Some("Rust Docs"));
        assert_eq!(
            metadata.description.as_deref(),
            Some("Guide for writing idiomatic Rust code based on established best practices.")
        );
    }

    #[test]
    fn markdown_metadata_reads_chomping_block_scalar_descriptions() {
        let metadata = parse_markdown_metadata(
            "---\nname: doppler\ndescription: >-\n  Manage secrets with Doppler:\n  CLI operations and integrations.\n---\n",
        );

        assert_eq!(
            metadata.description.as_deref(),
            Some("Manage secrets with Doppler: CLI operations and integrations.")
        );
    }

    fn write_skill(dir: &Path, name: &str, frontmatter_name: Option<&str>) -> PathBuf {
        let skill_dir = dir.join(name);
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        let frontmatter_name = frontmatter_name.unwrap_or(name);
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {frontmatter_name}\ndescription: Test skill\n---\nBody\n"),
        )
        .expect("write SKILL.md");
        skill_dir
    }

    /// Skills discovered under `root`, ignoring anything picked up from the
    /// user's real home directory.
    fn skills_under(root: &Path, workspace: &Path) -> Vec<SkillSummary> {
        discover_file_backed_skills(&workspace.to_string_lossy())
            .into_iter()
            .filter(|skill| {
                skill
                    .source_path
                    .as_deref()
                    .map(|path| Path::new(path).starts_with(root))
                    .unwrap_or(false)
            })
            .collect()
    }

    #[test]
    fn agents_skills_root_supports_opencode_with_path_derived_mention() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        write_skill(
            &root.join(".agents/skills"),
            "autoreview",
            Some("Autore View"),
        );

        let skills = skills_under(root, root);
        let skill = skills
            .iter()
            .find(|skill| skill.alias == "/autore-view")
            .expect("skill discovered");

        assert!(skill.supports_provider(&AgentProvider::CODEX));
        assert!(skill.supports_provider(&AgentProvider::CLAUDE));
        assert!(skill.supports_provider(&AgentProvider::AGY));
        assert!(skill.supports_provider(&AgentProvider::OPENCODE));
        assert!(skill.supports_provider(&AgentProvider::GROK));
        // The `$name` mention OpenCode expands is path-derived, not the
        // frontmatter name.
        assert_eq!(
            skill
                .provider_translations
                .opencode
                .as_ref()
                .and_then(|translation| translation.native_name.as_deref()),
            Some("autoreview")
        );
    }

    #[test]
    fn opencode_native_skill_root_is_scanned() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        write_skill(&root.join(".opencode/skills"), "release-notes", None);

        let skills = skills_under(root, root);
        let skill = skills
            .iter()
            .find(|skill| skill.alias == "/release-notes")
            .expect("skill discovered");

        assert!(skill.supports_provider(&AgentProvider::OPENCODE));
        assert!(!skill.supports_provider(&AgentProvider::CODEX));
        assert!(!skill.supports_provider(&AgentProvider::CLAUDE));
    }

    #[test]
    fn grok_native_skill_root_is_scanned() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        write_skill(&root.join(".grok/skills"), "grok-review", None);

        let skills = skills_under(root, root);
        let skill = skills
            .iter()
            .find(|skill| skill.alias == "/grok-review")
            .expect("skill discovered");

        assert!(skill.supports_provider(&AgentProvider::GROK));
        assert!(!skill.supports_provider(&AgentProvider::CODEX));
        assert!(!skill.supports_provider(&AgentProvider::CLAUDE));
    }

    #[test]
    fn live_catalog_drops_deleted_file_backed_skills_and_keeps_native() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        write_skill(&root.join(".agents/skills"), "keep-me", None);
        write_skill(&root.join(".agents/skills"), "drop-me", None);

        let discovered = skills_under(root, root);
        let drop_me = discovered
            .iter()
            .find(|skill| skill.alias == "/drop-me")
            .cloned()
            .expect("drop-me discovered");
        fs::remove_dir_all(root.join(".agents/skills/drop-me")).expect("remove skill");

        let native = SkillSummary {
            id: "skill:native-web".to_string(),
            label: "Native Web".to_string(),
            alias: "/native-web".to_string(),
            availability: SkillAvailability::Codex,
            providers: vec![AgentProvider::CODEX],
            source_kind: SkillSourceKind::ProviderNative,
            source_path: None,
            description: Some("Codex native".to_string()),
            provider_translations: SkillProviderTranslations::default(),
        };
        let mut cached = discovered;
        cached.push(native.clone());
        cached.push(drop_me);

        let live = live_workspace_skills(&root.to_string_lossy(), &cached)
            .into_iter()
            .filter(|skill| {
                skill.source_kind == SkillSourceKind::ProviderNative
                    || skill
                        .source_path
                        .as_deref()
                        .is_some_and(|path| Path::new(path).starts_with(root))
            })
            .collect::<Vec<_>>();

        assert!(live.iter().any(|skill| skill.alias == "/keep-me"));
        assert!(!live.iter().any(|skill| skill.alias == "/drop-me"));
        assert!(live.iter().any(|skill| skill.alias == "/native-web"
            && skill.source_kind == SkillSourceKind::ProviderNative));
    }

    #[test]
    fn slash_command_aliases_match_composer_mentions() {
        assert_eq!(
            slash_command_aliases_in_text("please run /deslop now"),
            vec!["/deslop".to_string()]
        );
        assert_eq!(
            slash_command_aliases_in_text("/code-review"),
            vec!["/code-review".to_string()]
        );
        assert!(slash_command_aliases_in_text("check /api/provider").is_empty());
        assert!(slash_command_aliases_in_text("see https://falcondeck.com/docs").is_empty());
    }
}
