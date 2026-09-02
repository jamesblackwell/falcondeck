//! Always-on agent context: the short instruction append injected at every
//! provider spawn boundary, plus bundled skills staged on disk for
//! progressive disclosure.
//!
//! Mirrors the shape used by comparable agent hosts: a minimal always-on
//! prompt footprint that points at fuller on-demand skills, so the heavy
//! reference material costs context only when an agent reads it.

use std::io;
use std::path::{Path, PathBuf};

/// Bundled control-plane skill body.
const CONTROL_SKILL_BODY: &str = include_str!("agent_context/SKILL.md");
/// Bundled in-session MCP usage skill body.
const MCP_SKILL_BODY: &str = include_str!("agent_context/falcondeck-mcp/SKILL.md");

/// Directory (under the daemon state dir) holding staged bundled skills.
pub const SKILLS_DIR_NAME: &str = "skills";

/// Name of the bundled FalconDeck control skill.
pub const SKILL_NAME: &str = "falcondeck-control";

/// Name of the bundled FalconDeck MCP usage skill.
pub const MCP_SKILL_NAME: &str = "falcondeck-mcp";

/// Published follow-up tool on the `falcondeck-extensions` MCP bridge.
pub const SUGGEST_FOLLOW_UPS_TOOL: &str = "falcondeck_suggest_follow_ups";

/// Paths of staged bundled skills.
#[derive(Debug, Clone)]
pub struct BundledSkillPaths {
    pub control: PathBuf,
    pub mcp: PathBuf,
}

/// Root directory holding staged bundled skills for a daemon state path.
pub fn skills_root(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(SKILLS_DIR_NAME)
}

/// Stages bundled skills so providers and agents can read them.
/// Idempotent per file: identical content is left in place, a differing file
/// is refreshed atomically so daemon upgrades pick up new content.
pub fn stage_bundled_skills(state_path: &Path) -> io::Result<BundledSkillPaths> {
    Ok(BundledSkillPaths {
        control: stage_skill_file(state_path, SKILL_NAME, CONTROL_SKILL_BODY)?,
        mcp: stage_skill_file(state_path, MCP_SKILL_NAME, MCP_SKILL_BODY)?,
    })
}

fn stage_skill_file(state_path: &Path, name: &str, body: &str) -> io::Result<PathBuf> {
    let skill_dir = skills_root(state_path).join(name);
    let skill_path = skill_dir.join("SKILL.md");
    let existing = std::fs::read_to_string(&skill_path).ok();
    if existing.as_deref() == Some(body) {
        return Ok(skill_path);
    }
    std::fs::create_dir_all(&skill_dir)?;
    let tmp = skill_dir.join(".SKILL.md.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &skill_path)?;
    Ok(skill_path)
}

/// Builds the short always-on instruction append. Skill paths are included
/// as on-demand references when those files could be staged.
pub fn append_instructions(
    control_skill: Option<&Path>,
    mcp_skill: Option<&Path>,
    suggest_follow_ups: bool,
) -> String {
    let mut text = String::from(
        "You are running inside FalconDeck, a local-first control plane that orchestrates coding agents (Codex, Claude, ACP CLIs) from the FalconDeck desktop and mobile apps. Your threads, turns and tool approvals are managed by FalconDeck.\n\n\
         - Use the FalconDeck MCP tools available in this session. They are part of the product; do not wait for the user to name them.\n",
    );
    if suggest_follow_ups {
        text.push_str(
            "- Near the end of a turn, if useful next steps remain, call `falcondeck_suggest_follow_ups` once with 1–5 short actions (imperative labels, at most 30 characters). It does not block the turn. Skip it only when nothing useful is left to offer.\n",
        );
    }
    text.push_str(
        "- Control FalconDeck itself with the `falcondeck` MCP tools: `falcondeck_search` to discover operations, `falcondeck_get` to read state, `falcondeck_execute` to run one (for example scheduled automations). Use those when the user asks about automations, schedules, or FalconDeck settings.\n\
         - Before `falcondeck_execute`, call `falcondeck_search` with `detail: \"full\"` to get the operation's schema and worked examples.",
    );
    if let Some(path) = mcp_skill {
        text.push_str(&format!(
            "\n- FalconDeck MCP usage (read on demand): {}",
            path.display()
        ));
    }
    if let Some(path) = control_skill {
        text.push_str(&format!(
            "\n- Full FalconDeck control guide (read on demand): {}",
            path.display()
        ));
    }
    text.push_str("\n- Do not narrate FalconDeck internals unless the user asks.");
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_nudges_mcp_use_and_hides_unstaged_skills() {
        let without = append_instructions(None, None, false);
        assert!(without.contains("FalconDeck MCP tools"));
        assert!(without.contains("do not wait for the user to name them"));
        assert!(!without.contains("falcondeck_suggest_follow_ups"));
        assert!(!without.contains("read on demand"));
        assert!(without.contains("falcondeck_search"));

        let with = append_instructions(
            Some(Path::new("/tmp/skills/falcondeck-control/SKILL.md")),
            Some(Path::new("/tmp/skills/falcondeck-mcp/SKILL.md")),
            true,
        );
        assert!(with.contains("falcondeck_suggest_follow_ups"));
        assert!(with.contains("/tmp/skills/falcondeck-mcp/SKILL.md"));
        assert!(with.contains("/tmp/skills/falcondeck-control/SKILL.md"));
        assert!(!with.contains("Only mention or use FalconDeck when the user asks"));
    }

    #[test]
    fn staging_writes_both_skills_and_is_upgrade_aware() {
        let dir = std::env::temp_dir().join(format!("fd-skill-test-{}", std::process::id()));
        let state_path = dir.join("state.json");
        let staged = stage_bundled_skills(&state_path).expect("stage");
        assert!(staged.control.is_file());
        assert!(staged.mcp.is_file());
        assert_eq!(
            std::fs::read_to_string(&staged.mcp).expect("read mcp"),
            MCP_SKILL_BODY
        );
        let first = std::fs::metadata(&staged.control)
            .and_then(|meta| meta.modified())
            .ok();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let again = stage_bundled_skills(&state_path).expect("stage again");
        assert_eq!(staged.control, again.control);
        let second = std::fs::metadata(&staged.control)
            .and_then(|meta| meta.modified())
            .ok();
        assert_eq!(first, second, "identical content is not rewritten");
        std::fs::write(&staged.mcp, "stale").expect("simulate old version");
        stage_bundled_skills(&state_path).expect("restage");
        assert_eq!(
            std::fs::read_to_string(&staged.mcp).expect("read").as_str(),
            MCP_SKILL_BODY,
            "differing content is refreshed"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
