//! Saved prompts are user-invoked composer text.
//!
//! They live outside every skill scan root. A harness that discovers
//! `.agents/skills` or `.claude/commands` must not see these files, and the
//! daemon must not attach them to a workspace skill catalog. The slash menu
//! lists them and the composer inserts the body only when the user picks one.

use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
};

use falcondeck_core::{SavedPrompt, SavedPromptSourceKind};

use crate::skills::{canonical_skill_alias, parse_markdown_metadata};

const MAX_PROMPT_BYTES: u64 = 64 * 1024;
const PICKER_DESCRIPTION_CHARS: usize = 200;

struct PromptRoot {
    dir: PathBuf,
    source_kind: SavedPromptSourceKind,
    /// Higher rank wins when two files share an alias.
    rank: u8,
    /// Copilot prompt files are `name.prompt.md`. Other folders accept `.md`.
    copilot_only: bool,
}

pub fn discover_saved_prompts(workspace_path: &str) -> Vec<SavedPrompt> {
    discover_saved_prompts_from(workspace_path, home_dir().as_deref())
}

fn discover_saved_prompts_from(workspace_path: &str, home: Option<&Path>) -> Vec<SavedPrompt> {
    let workspace = Path::new(workspace_path);
    let mut roots = Vec::new();
    if let Some(home) = home {
        roots.push(PromptRoot {
            dir: home.join(".codex/prompts"),
            source_kind: SavedPromptSourceKind::HomeFile,
            rank: 10,
            copilot_only: false,
        });
        roots.push(PromptRoot {
            dir: home.join(".falcondeck/prompts"),
            source_kind: SavedPromptSourceKind::HomeFile,
            rank: 20,
            copilot_only: false,
        });
    }
    roots.push(PromptRoot {
        dir: workspace.join(".codex/prompts"),
        source_kind: SavedPromptSourceKind::ProjectFile,
        rank: 30,
        copilot_only: false,
    });
    roots.push(PromptRoot {
        dir: workspace.join(".github/prompts"),
        source_kind: SavedPromptSourceKind::ProjectFile,
        rank: 35,
        copilot_only: true,
    });
    roots.push(PromptRoot {
        dir: workspace.join(".falcondeck/prompts"),
        source_kind: SavedPromptSourceKind::ProjectFile,
        rank: 40,
        copilot_only: false,
    });
    roots.sort_by_key(|root| root.rank);

    let mut by_alias: HashMap<String, SavedPrompt> = HashMap::new();
    for root in roots {
        for prompt in scan_prompt_dir(&root) {
            by_alias.insert(prompt.alias.clone(), prompt);
        }
    }
    let mut prompts: Vec<_> = by_alias.into_values().collect();
    prompts.sort_by(|left, right| left.alias.cmp(&right.alias));
    prompts
}

fn scan_prompt_dir(root: &PromptRoot) -> Vec<SavedPrompt> {
    let mut paths = match fs::read_dir(&root.dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .collect::<Vec<_>>(),
        Err(_) => return Vec::new(),
    };
    paths.sort();

    paths
        .into_iter()
        .filter_map(|path| read_prompt(&path, root))
        .collect()
}

fn read_prompt(path: &Path, root: &PromptRoot) -> Option<SavedPrompt> {
    let stem = prompt_stem(path, root.copilot_only)?;
    let alias = canonical_skill_alias(&stem);
    if alias == "/skill" && stem != "skill" {
        return None;
    }
    let len = fs::metadata(path).ok()?.len();
    if len == 0 || len > MAX_PROMPT_BYTES {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let body = prompt_body(&content);
    if body.is_empty() {
        return None;
    }
    let metadata = parse_markdown_metadata(&content);
    let alias_name = alias.trim_start_matches('/').to_string();
    let source = match root.source_kind {
        SavedPromptSourceKind::HomeFile => "home",
        SavedPromptSourceKind::ProjectFile => "project",
    };
    Some(SavedPrompt {
        id: format!("prompt:{source}:{alias_name}"),
        label: prompt_label(&alias_name),
        alias,
        description: picker_description(metadata.description),
        argument_hint: argument_hint(&content),
        body,
        source_kind: root.source_kind.clone(),
        source_path: Some(path.display().to_string()),
    })
}

fn prompt_stem(path: &Path, copilot_only: bool) -> Option<String> {
    let file_name = path.file_name()?.to_str()?;
    if file_name.starts_with('.') {
        return None;
    }
    let lower = file_name.to_ascii_lowercase();
    if lower == "readme.md" {
        return None;
    }
    let stem = if let Some(stem) = lower.strip_suffix(".prompt.md") {
        stem
    } else if copilot_only {
        return None;
    } else {
        lower.strip_suffix(".md")?
    };
    if stem.is_empty() {
        None
    } else {
        Some(stem.to_string())
    }
}

fn prompt_body(content: &str) -> String {
    let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    else {
        return content.trim().to_string();
    };
    let Some(end) = rest.find("\n---") else {
        return content.trim().to_string();
    };
    let after = &rest[end + "\n---".len()..];
    after
        .strip_prefix("\r\n")
        .or_else(|| after.strip_prefix("\n"))
        .unwrap_or(after)
        .trim()
        .to_string()
}

fn argument_hint(content: &str) -> Option<String> {
    let frontmatter = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    let end = frontmatter.find("\n---")?;
    for line in frontmatter[..end].lines() {
        let trimmed = line.trim();
        let value = trimmed
            .strip_prefix("argument-hint:")
            .or_else(|| trimmed.strip_prefix("argument_hint:"));
        let Some(value) = value else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn picker_description(description: Option<String>) -> Option<String> {
    let description = description?.trim().to_string();
    if description.is_empty() {
        return None;
    }
    if description.chars().count() <= PICKER_DESCRIPTION_CHARS {
        return Some(description);
    }
    let truncated: String = description.chars().take(PICKER_DESCRIPTION_CHARS).collect();
    Some(format!("{truncated}…"))
}

fn prompt_label(alias_name: &str) -> String {
    let mut label = String::new();
    let mut capitalize = true;
    for ch in alias_name.chars() {
        if ch == '-' || ch == '_' {
            if !label.ends_with(' ') {
                label.push(' ');
            }
            capitalize = true;
            continue;
        }
        if capitalize {
            label.extend(ch.to_uppercase());
            capitalize = false;
        } else {
            label.push(ch);
        }
    }
    if label.is_empty() {
        alias_name.to_string()
    } else {
        label
    }
}

fn home_dir() -> Option<PathBuf> {
    env::var("HOME").ok().map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, contents: &str) {
        fs::create_dir_all(dir).expect("create prompt dir");
        fs::write(dir.join(name), contents).expect("write prompt");
    }

    #[test]
    fn project_prompt_overrides_home_and_imports_and_ignores_skills() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("home");
        let workspace = tmp.path().join("repo");
        write(
            &home.join(".falcondeck/prompts"),
            "save-prompt.md",
            "---\ndescription: Home copy\nargument-hint: [path]\n---\n\nHome body\n",
        );
        write(
            &home.join(".codex/prompts"),
            "codex-review.md",
            "Review the diff.\n\n$ARGUMENTS\n",
        );
        write(
            &workspace.join(".falcondeck/prompts"),
            "save-prompt.md",
            "---\ndescription: Project copy\n---\n\nProject body $ARGUMENTS\n",
        );
        write(
            &workspace.join(".github/prompts"),
            "ship.prompt.md",
            "---\ndescription: Ship it\n---\n\nPrepare the release.\n",
        );
        write(
            &workspace.join(".github/prompts"),
            "notes.md",
            "This is not a Copilot prompt file.\n",
        );
        write(
            &workspace.join(".falcondeck/prompts"),
            "README.md",
            "Folder notes, not a prompt.\n",
        );
        write(
            &workspace.join(".agents/skills/autoreview"),
            "SKILL.md",
            "---\nname: autoreview\ndescription: Review skill\n---\nSkill body\n",
        );
        write(
            &workspace.join(".claude/commands"),
            "compact.md",
            "Compact the conversation.\n",
        );

        let prompts = discover_saved_prompts_from(&workspace.to_string_lossy(), Some(&home));
        let aliases: Vec<_> = prompts.iter().map(|prompt| prompt.alias.as_str()).collect();
        assert_eq!(aliases, vec!["/codex-review", "/save-prompt", "/ship"]);

        let save = prompts
            .iter()
            .find(|prompt| prompt.alias == "/save-prompt")
            .expect("project prompt");
        assert_eq!(save.description.as_deref(), Some("Project copy"));
        assert_eq!(save.body, "Project body $ARGUMENTS");
        assert_eq!(save.source_kind, SavedPromptSourceKind::ProjectFile);
        assert_eq!(save.label, "Save Prompt");
        assert!(save.id.starts_with("prompt:project:"));

        let codex = prompts
            .iter()
            .find(|prompt| prompt.alias == "/codex-review")
            .expect("imported codex prompt");
        assert_eq!(codex.body, "Review the diff.\n\n$ARGUMENTS");
        assert_eq!(codex.source_kind, SavedPromptSourceKind::HomeFile);
        assert_eq!(
            prompts
                .iter()
                .find(|prompt| prompt.alias == "/save-prompt")
                .and_then(|prompt| prompt.argument_hint.as_deref()),
            None
        );
        let home_only = discover_saved_prompts_from(tmp.path().to_str().unwrap(), Some(&home));
        let home_save = home_only
            .iter()
            .find(|prompt| prompt.alias == "/save-prompt")
            .expect("home prompt");
        assert_eq!(home_save.argument_hint.as_deref(), Some("[path]"));
        assert_eq!(home_save.body, "Home body");
    }

    #[test]
    fn skips_empty_and_oversized_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let workspace = tmp.path().join("repo");
        write(
            &workspace.join(".falcondeck/prompts"),
            "empty.md",
            "---\ndescription: Nothing to insert\n---\n\n",
        );
        let huge = "x".repeat((MAX_PROMPT_BYTES as usize) + 8);
        write(&workspace.join(".falcondeck/prompts"), "huge.md", &huge);
        write(
            &workspace.join(".falcondeck/prompts"),
            "ok.md",
            "Ship the fix.\n",
        );

        let prompts = discover_saved_prompts_from(&workspace.to_string_lossy(), None);
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].alias, "/ok");
        assert_eq!(prompts[0].body, "Ship the fix.");
    }
}
