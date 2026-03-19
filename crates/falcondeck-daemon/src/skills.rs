use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
};

use falcondeck_core::{
    AgentProvider, ClaudeSkillTranslation, CodexSkillTranslation, SkillAvailability,
    SkillProviderTranslations, SkillSourceKind, SkillSummary,
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

pub fn discover_file_backed_skills(workspace_path: &str) -> Vec<SkillSummary> {
    let mut entries = Vec::new();
    let workspace_root = Path::new(workspace_path);

    entries.extend(scan_agents_skill_dir(
        &workspace_root.join(".agents/skills"),
        SkillSourceKind::ProjectFile,
        SkillAvailability::Both,
    ));
    entries.extend(scan_agents_skill_dir(
        &workspace_root.join(".codex/skills"),
        SkillSourceKind::ProjectFile,
        SkillAvailability::Codex,
    ));
    entries.extend(scan_claude_command_dir(
        &workspace_root.join(".claude/commands"),
        SkillSourceKind::ProjectFile,
    ));

    if let Some(home) = home_dir() {
        entries.extend(scan_agents_skill_dir(
            &home.join(".agents/skills"),
            SkillSourceKind::HomeFile,
            SkillAvailability::Both,
        ));
        entries.extend(scan_agents_skill_dir(
            &home.join(".codex/skills"),
            SkillSourceKind::HomeFile,
            SkillAvailability::Codex,
        ));
        entries.extend(scan_claude_command_dir(
            &home.join(".claude/commands"),
            SkillSourceKind::HomeFile,
        ));
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
                availability: SkillAvailability::Codex,
                source_kind: SkillSourceKind::ProviderNative,
                source_path: None,
                description: extract_string(entry, &["description", "summary"]),
                provider_translations: SkillProviderTranslations {
                    codex: Some(CodexSkillTranslation {
                        native_id: extract_string(entry, &["id", "slug"]),
                        native_name: Some(canonical_name),
                    }),
                    claude: None,
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

        existing.availability = merge_availability(&existing.availability, &incoming.availability);
        if existing.provider_translations.codex.is_none() {
            existing.provider_translations.codex = incoming.provider_translations.codex.clone();
        }
        if existing.provider_translations.claude.is_none() {
            existing.provider_translations.claude = incoming.provider_translations.claude.clone();
        }
    }

    let mut values = merged.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| left.alias.cmp(&right.alias));
    values
}

pub fn skills_for_provider(skills: &[SkillSummary], provider: AgentProvider) -> Vec<SkillSummary> {
    skills
        .iter()
        .filter(|skill| match provider {
            AgentProvider::Codex => matches!(
                skill.availability,
                SkillAvailability::Codex | SkillAvailability::Both
            ),
            AgentProvider::Claude => matches!(
                skill.availability,
                SkillAvailability::Claude | SkillAvailability::Both
            ),
        })
        .cloned()
        .collect()
}

fn scan_agents_skill_dir(
    dir: &Path,
    source_kind: SkillSourceKind,
    availability: SkillAvailability,
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
                availability.clone(),
                path.file_name().and_then(|name| name.to_str()),
            ) {
                results.push(skill);
            }
            continue;
        }

        if !is_markdown_file(&path) {
            continue;
        }
        if let Some(skill) = parse_markdown_skill(&path, source_kind.clone(), availability.clone(), None) {
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
        let Some(skill) = parse_markdown_skill(&path, source_kind.clone(), SkillAvailability::Claude, None)
        else {
            continue;
        };
        results.push(SkillSummary {
            provider_translations: SkillProviderTranslations {
                codex: None,
                claude: Some(ClaudeSkillTranslation {
                    command_name: Some(
                        skill.alias
                            .trim_start_matches('/')
                            .to_string(),
                    ),
                    prompt_reference_path: skill.source_path.clone(),
                }),
            },
            ..skill
        });
    }

    results
}

fn parse_markdown_skill(
    path: &Path,
    source_kind: SkillSourceKind,
    availability: SkillAvailability,
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
    let provider_translations = match availability {
        SkillAvailability::Codex => SkillProviderTranslations {
            codex: Some(CodexSkillTranslation {
                native_id: None,
                native_name: Some(alias.trim_start_matches('/').to_string()),
            }),
            claude: None,
        },
        SkillAvailability::Claude => SkillProviderTranslations {
            codex: None,
            claude: Some(ClaudeSkillTranslation {
                command_name: None,
                prompt_reference_path: source_path.clone(),
            }),
        },
        SkillAvailability::Both => SkillProviderTranslations {
            codex: Some(CodexSkillTranslation {
                native_id: None,
                native_name: Some(alias.trim_start_matches('/').to_string()),
            }),
            claude: Some(ClaudeSkillTranslation {
                command_name: None,
                prompt_reference_path: source_path.clone(),
            }),
        },
    };

    Some(SkillSummary {
        id: alias_to_skill_id(&alias),
        label: raw_name.replace('-', " ").replace('_', " "),
        alias,
        availability,
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
    skill
}

fn merge_availability(left: &SkillAvailability, right: &SkillAvailability) -> SkillAvailability {
    match (left, right) {
        (SkillAvailability::Both, _) | (_, SkillAvailability::Both) => SkillAvailability::Both,
        (SkillAvailability::Codex, SkillAvailability::Claude)
        | (SkillAvailability::Claude, SkillAvailability::Codex) => SkillAvailability::Both,
        (SkillAvailability::Codex, _) => SkillAvailability::Codex,
        (SkillAvailability::Claude, _) => SkillAvailability::Claude,
    }
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

struct MarkdownMetadata {
    name: Option<String>,
    description: Option<String>,
}

fn parse_markdown_metadata(content: &str) -> MarkdownMetadata {
    let mut lines = content.lines();
    let mut name = None;
    let mut description = None;

    if matches!(lines.next().map(str::trim), Some("---")) {
        for line in lines.by_ref() {
            let trimmed = line.trim();
            if trimmed == "---" {
                break;
            }
            if let Some(value) = trimmed.strip_prefix("name:") {
                name = Some(value.trim().trim_matches('"').to_string());
            } else if let Some(value) = trimmed.strip_prefix("description:") {
                description = Some(value.trim().trim_matches('"').to_string());
            }
        }
    }

    if description.is_none() {
        for line in content.lines() {
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
                source_kind: SkillSourceKind::ProviderNative,
                source_path: None,
                description: Some("Native".to_string()),
                provider_translations: SkillProviderTranslations {
                    codex: Some(CodexSkillTranslation {
                        native_id: Some("search-web".to_string()),
                        native_name: Some("search-web".to_string()),
                    }),
                    claude: None,
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
}
