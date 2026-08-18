//! Always-on agent context: the short instruction append injected at every
//! provider spawn boundary, plus the bundled `falcondeck-control` skill
//! staged on disk for progressive disclosure.
//!
//! Mirrors the shape used by comparable agent hosts: a minimal always-on
//! prompt footprint that points at a fuller on-demand skill, so the heavy
//! reference material costs context only when an agent reads it.

use std::io;
use std::path::{Path, PathBuf};

/// Bundled skill body, staged to `<state dir>/skills/falcondeck-control/`.
const SKILL_BODY: &str = include_str!("agent_context/SKILL.md");

/// Directory (under the daemon state dir) holding staged bundled skills.
pub const SKILLS_DIR_NAME: &str = "skills";

/// Name of the bundled FalconDeck control skill.
pub const SKILL_NAME: &str = "falcondeck-control";

/// Root directory holding staged bundled skills for a daemon state path.
pub fn skills_root(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(SKILLS_DIR_NAME)
}

/// Stages the bundled skill so providers and agents can read it, returning
/// the absolute `SKILL.md` path. Idempotent: an identical file is left in
/// place (never rewritten mid-session), a differing file is refreshed
/// atomically so daemon upgrades pick up new content.
pub fn stage_skill(state_path: &Path) -> io::Result<PathBuf> {
    let skill_dir = skills_root(state_path).join(SKILL_NAME);
    let skill_path = skill_dir.join("SKILL.md");
    let existing = std::fs::read_to_string(&skill_path).ok();
    if existing.as_deref() == Some(SKILL_BODY) {
        return Ok(skill_path);
    }
    std::fs::create_dir_all(&skill_dir)?;
    let tmp = skill_dir.join(".SKILL.md.tmp");
    std::fs::write(&tmp, SKILL_BODY)?;
    std::fs::rename(&tmp, &skill_path)?;
    Ok(skill_path)
}

/// Builds the short always-on instruction append. `skill_path` is included
/// as an on-demand reference when the bundled skill could be staged.
pub fn append_instructions(skill_path: Option<&Path>) -> String {
    let mut text = String::from(
        "You are running inside FalconDeck, a local-first control plane that orchestrates coding agents (Codex, Claude, ACP CLIs) from the FalconDeck desktop and mobile apps. Your threads, turns and tool approvals are managed by FalconDeck.\n\n\
         - Control FalconDeck itself with the `falcondeck` MCP tools: `falcondeck_search` to discover operations, `falcondeck_get` to read state, `falcondeck_execute` to run one (for example scheduled automations).\n\
         - Before `falcondeck_execute`, call `falcondeck_search` with `detail: \"full\"` to get the operation's schema and worked examples.",
    );
    if let Some(path) = skill_path {
        text.push_str(&format!(
            "\n- Full FalconDeck control guide (read on demand): {}",
            path.display()
        ));
    }
    text.push_str("\n- Only mention or use FalconDeck when the user asks about it or a task needs its capabilities.");
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_mentions_tools_and_hides_skill_when_unstaged() {
        let without = append_instructions(None);
        assert!(without.contains("falcondeck_search"));
        assert!(!without.contains("read on demand"));

        let with = append_instructions(Some(Path::new("/tmp/skills/falcondeck-control/SKILL.md")));
        assert!(with.contains("/tmp/skills/falcondeck-control/SKILL.md"));
    }

    #[test]
    fn staging_is_idempotent_and_upgrade_aware() {
        let dir = std::env::temp_dir().join(format!("fd-skill-test-{}", std::process::id()));
        let state_path = dir.join("state.json");
        let skill = stage_skill(&state_path).expect("stage");
        assert!(skill.is_file());
        let first = std::fs::metadata(&skill)
            .and_then(|meta| meta.modified())
            .ok();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let again = stage_skill(&state_path).expect("stage again");
        assert_eq!(skill, again);
        let second = std::fs::metadata(&skill)
            .and_then(|meta| meta.modified())
            .ok();
        assert_eq!(first, second, "identical content is not rewritten");
        std::fs::write(&skill, "stale").expect("simulate old version");
        stage_skill(&state_path).expect("restage");
        assert_eq!(
            std::fs::read_to_string(&skill).expect("read").as_str(),
            SKILL_BODY,
            "differing content is refreshed"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
