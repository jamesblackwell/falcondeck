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
/// Bundled Pi MCP bridge extension body.
pub const PI_EXTENSION_BODY: &str = include_str!("agent_context/falcondeck-pi-extension.js");
const CUA_SKILL_BODY: &str = include_str!("agent_context/cua-driver/SKILL.md");
const CUA_SKILL_WORKFLOW: &str = include_str!("agent_context/cua-driver/WORKFLOW.md");
const CUA_SKILL_RUNTIME: &str = include_str!("agent_context/cua-driver/RUNTIME.md");
const CUA_SKILL_VISUAL: &str = include_str!("agent_context/cua-driver/VISUAL.md");
const CUA_SKILL_MACOS: &str = include_str!("agent_context/cua-driver/MACOS.md");
const CUA_SKILL_WINDOWS: &str = include_str!("agent_context/cua-driver/WINDOWS.md");
const CUA_SKILL_LINUX: &str = include_str!("agent_context/cua-driver/LINUX.md");
const CUA_SKILL_BROWSER: &str = include_str!("agent_context/cua-driver/BROWSER.md");
const CUA_SKILL_RECORDING: &str = include_str!("agent_context/cua-driver/RECORDING.md");
const CUA_SKILL_EMBEDDING: &str = include_str!("agent_context/cua-driver/EMBEDDING.md");
const CUA_SKILL_README: &str = include_str!("agent_context/cua-driver/README.md");
const CUA_SKILL_VERSION: &str = include_str!("agent_context/cua-driver/VERSION");
/// FalconDeck-authored host notes staged alongside the vendored cua-driver skill.
const CUA_SKILL_FALCONDECK: &str =
    include_str!("agent_context/cua-driver-falcondeck/FALCONDECK.md");

/// Directory (under the daemon state dir) holding staged bundled skills.
pub const SKILLS_DIR_NAME: &str = "skills";

/// Name of the bundled FalconDeck control skill.
pub const SKILL_NAME: &str = "falcondeck-control";

/// Name of the bundled FalconDeck MCP usage skill.
pub const MCP_SKILL_NAME: &str = "falcondeck-mcp";

/// Name of the bundled cua-driver computer-use skill.
pub const COMPUTER_USE_SKILL_NAME: &str = "cua-driver";

/// Published follow-up tool on the `falcondeck-extensions` MCP bridge.
pub const SUGGEST_FOLLOW_UPS_TOOL: &str = "falcondeck_suggest_follow_ups";

/// Paths of staged bundled skills.
#[derive(Debug, Clone)]
pub struct BundledSkillPaths {
    pub control: PathBuf,
    pub mcp: PathBuf,
    pub computer_use: Option<PathBuf>,
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
pub fn stage_bundled_skills(
    state_path: &Path,
    computer_use: bool,
) -> io::Result<BundledSkillPaths> {
    let _ = stage_pi_extension();
    Ok(BundledSkillPaths {
        control: stage_skill_file(state_path, SKILL_NAME, CONTROL_SKILL_BODY)?,
        mcp: stage_skill_file(state_path, MCP_SKILL_NAME, MCP_SKILL_BODY)?,
        computer_use: if computer_use {
            Some(stage_computer_use_skill(state_path)?)
        } else {
            let stale = skills_root(state_path).join(COMPUTER_USE_SKILL_NAME);
            let _ = std::fs::remove_dir_all(stale);
            None
        },
    })
}

/// Stages the FalconDeck Pi extension into the global Pi extensions directory
/// (`~/.pi/agent/extensions/falcondeck.js` or `$PI_CODING_AGENT_DIR/extensions/falcondeck.js`).
///
/// Idempotent per file: identical content is left in place, differing content
/// is refreshed atomically.
pub fn stage_pi_extension() -> io::Result<PathBuf> {
    let pi_agent_dir = match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir.trim()),
        _ => match std::env::var("HOME") {
            Ok(home) => PathBuf::from(home).join(".pi").join("agent"),
            Err(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "neither HOME nor PI_CODING_AGENT_DIR is set",
                ));
            }
        },
    };
    stage_pi_extension_in(&pi_agent_dir)
}

/// Stages the FalconDeck Pi extension into a specific Pi agent directory.
pub fn stage_pi_extension_in(pi_agent_dir: &Path) -> io::Result<PathBuf> {
    let extensions_dir = pi_agent_dir.join("extensions");
    std::fs::create_dir_all(&extensions_dir)?;
    let extension_path = extensions_dir.join("falcondeck.js");
    let existing = std::fs::read_to_string(&extension_path).ok();
    if existing.as_deref() == Some(PI_EXTENSION_BODY) {
        return Ok(extension_path);
    }
    let tmp = extensions_dir.join(".falcondeck.js.tmp");
    std::fs::write(&tmp, PI_EXTENSION_BODY)?;
    std::fs::rename(&tmp, &extension_path)?;
    Ok(extension_path)
}

fn stage_skill_file(state_path: &Path, name: &str, body: &str) -> io::Result<PathBuf> {
    let skill_dir = skills_root(state_path).join(name);
    stage_named_file(&skill_dir, "SKILL.md", body)
}

fn stage_computer_use_skill(state_path: &Path) -> io::Result<PathBuf> {
    let skill_dir = skills_root(state_path).join(COMPUTER_USE_SKILL_NAME);
    stage_named_file(&skill_dir, "SKILL.md", CUA_SKILL_BODY)?;
    stage_named_file(&skill_dir, "WORKFLOW.md", CUA_SKILL_WORKFLOW)?;
    stage_named_file(&skill_dir, "RUNTIME.md", CUA_SKILL_RUNTIME)?;
    stage_named_file(&skill_dir, "VISUAL.md", CUA_SKILL_VISUAL)?;
    stage_named_file(&skill_dir, "MACOS.md", CUA_SKILL_MACOS)?;
    stage_named_file(&skill_dir, "WINDOWS.md", CUA_SKILL_WINDOWS)?;
    stage_named_file(&skill_dir, "LINUX.md", CUA_SKILL_LINUX)?;
    stage_named_file(&skill_dir, "BROWSER.md", CUA_SKILL_BROWSER)?;
    stage_named_file(&skill_dir, "RECORDING.md", CUA_SKILL_RECORDING)?;
    stage_named_file(&skill_dir, "EMBEDDING.md", CUA_SKILL_EMBEDDING)?;
    stage_named_file(&skill_dir, "README.md", CUA_SKILL_README)?;
    stage_named_file(&skill_dir, "VERSION", CUA_SKILL_VERSION)?;
    stage_named_file(&skill_dir, "FALCONDECK.md", CUA_SKILL_FALCONDECK)?;
    Ok(skill_dir.join("SKILL.md"))
}

fn stage_named_file(dir: &Path, name: &str, body: &str) -> io::Result<PathBuf> {
    let path = dir.join(name);
    let existing = std::fs::read_to_string(&path).ok();
    if existing.as_deref() == Some(body) {
        return Ok(path);
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Builds the short always-on instruction append. Skill paths are included
/// as on-demand references when those files could be staged.
pub fn append_instructions(
    control_skill: Option<&Path>,
    mcp_skill: Option<&Path>,
    computer_use_skill: Option<&Path>,
    suggest_follow_ups: bool,
) -> String {
    let mut text = String::from(
        "You are running inside FalconDeck, a local-first control plane that orchestrates coding agents (Codex, Claude, ACP CLIs) from the FalconDeck desktop and mobile apps. Your threads, turns and tool approvals are managed by FalconDeck.\n\n\
         - Use the FalconDeck MCP tools available in this session when they help with the user's task; do not wait for the user to name them.\n",
    );
    text.push_str("- Only look at other threads when the task needs their context or coordination, not as a routine startup step. `falcondeck_list_threads` shows what is being worked on (status, last request, latest reply per thread); `falcondeck_thread_summary` digests outcomes, files, commits and checks; `falcondeck_view_thread` reads messages; `falcondeck_thread_changes` returns only what changed since your last check. `falcondeck_message_thread` steers another thread's active turn by default (`delivery: queue` waits for it to finish); it also reaches the user's bots (named coordinators listed at the top of `falcondeck_list_threads`) by name. `falcondeck_create_thread` starts independent work from a self-contained prompt; no context is copied by default and at most three children run at once. Approvals stay in the FalconDeck UI.\n");
    text.push_str("- Keep proactive notifications rare: send them only for critical issues requiring attention or when the user explicitly requests notifications. Leave child-thread `notify_parent` false for routine progress and ordinary completions; read thread summaries at natural checkpoints. Long-running work alone does not justify notifications.\n");
    text.push_str("- Link to other FalconDeck tasks as `[Task name](falcondeck://thread/THREAD_ID)`, using the exact thread_id from FalconDeck tools, never a title or guessed ID. The destination survives renames.\n");
    if suggest_follow_ups {
        text.push_str(
            "- Near the end of a turn, if useful next steps remain, call `falcondeck_suggest_follow_ups` once with 1–5 short actions (imperative labels, at most 30 characters). It does not block the turn. Skip it only when nothing useful is left to offer. The user sees them in the UI, so never mention, list, or restate them in your reply; end the turn with a normal reply.\n",
        );
    }
    text.push_str(
        "- Control FalconDeck itself with the `falcondeck` MCP tools: `falcondeck_search` to discover operations, `falcondeck_get` to read state, `falcondeck_execute` to run one (for example scheduled automations). Use those when the user asks about automations, schedules, tickets, or FalconDeck settings. Tickets track big-picture work taking hours, days or weeks; most changes should just be done. Never create a ticket for anything under a few hours. When the user asks you to check back, follow up, or re-run something later from within a conversation, schedule it with thread kind `current` so it continues in this thread; use a managed thread only for standing schedules unrelated to this conversation.\n\
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
    if let Some(path) = computer_use_skill {
        text.push_str(&format!(
            "\n- The `cua-driver` MCP server can operate apps on this Mac in the background. Read {} and the sibling WORKFLOW.md and MACOS.md first. Use its MCP tools, not the cua-driver CLI. For browser tasks, read BROWSER.md and FALCONDECK.md. Use the shared agent browser by default: browser_prepare with allow_launch true, the pid of the user's own Chrome (pick it as FALCONDECK.md says, not from list_apps), and profile {{mode: \"isolated_named\", name: \"falcondeck-agent\"}}. It keeps the user's agent logins and never triggers Chrome's remote-debugging prompt. Do not attach to the user's personal Chrome profile (existing_profile) unless they explicitly ask you to work in their own browser window or tab. If a site needs a login the agent browser lacks, end your browser session, then ask the user to sign in via Settings → Computer use → Open agent browser and quit that Chrome when done; never type passwords yourself, copy cookies, or fall back to the personal profile. Reuse one window, MCP connection, and session label for the task, and end the session when finished.",
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
        let without = append_instructions(None, None, None, false);
        assert!(without.contains("FalconDeck MCP tools"));
        assert!(without.contains("do not wait for the user to name them"));
        assert!(!without.contains("falcondeck_suggest_follow_ups"));
        assert!(!without.contains("read on demand"));
        assert!(without.contains("falcondeck_search"));
        assert!(without.contains("[Task name](falcondeck://thread/THREAD_ID)"));
        assert!(without.contains("never a title or guessed ID"));

        let with = append_instructions(
            Some(Path::new("/tmp/skills/falcondeck-control/SKILL.md")),
            Some(Path::new("/tmp/skills/falcondeck-mcp/SKILL.md")),
            Some(Path::new("/tmp/skills/cua-driver/SKILL.md")),
            true,
        );
        assert!(with.contains("falcondeck_suggest_follow_ups"));
        assert!(with.contains("never mention, list, or restate them in your reply"));
        assert!(with.contains("/tmp/skills/falcondeck-mcp/SKILL.md"));
        assert!(with.contains("/tmp/skills/falcondeck-control/SKILL.md"));
        assert!(with.contains("/tmp/skills/cua-driver/SKILL.md"));
        assert!(with.contains("`cua-driver` MCP server"));
        assert!(with.contains("name: \"falcondeck-agent\""));
        assert!(with.contains("Open agent browser"));
        assert!(!with.contains("Only mention or use FalconDeck when the user asks"));
    }

    #[test]
    fn staging_writes_both_skills_and_is_upgrade_aware() {
        let dir = std::env::temp_dir().join(format!("fd-skill-test-{}", std::process::id()));
        let state_path = dir.join("state.json");
        let staged = stage_bundled_skills(&state_path, false).expect("stage");
        assert!(staged.control.is_file());
        assert!(staged.mcp.is_file());
        assert!(staged.computer_use.is_none());
        assert_eq!(
            std::fs::read_to_string(&staged.mcp).expect("read mcp"),
            MCP_SKILL_BODY
        );
        let first = std::fs::metadata(&staged.control)
            .and_then(|meta| meta.modified())
            .ok();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let again = stage_bundled_skills(&state_path, false).expect("stage again");
        assert_eq!(staged.control, again.control);
        let second = std::fs::metadata(&staged.control)
            .and_then(|meta| meta.modified())
            .ok();
        assert_eq!(first, second, "identical content is not rewritten");
        std::fs::write(&staged.mcp, "stale").expect("simulate old version");
        stage_bundled_skills(&state_path, false).expect("restage");
        assert_eq!(
            std::fs::read_to_string(&staged.mcp).expect("read").as_str(),
            MCP_SKILL_BODY,
            "differing content is refreshed"
        );
        let cua = stage_bundled_skills(&state_path, true).expect("stage cua");
        let cua_path = cua.computer_use.expect("cua skill");
        assert!(cua_path.is_file());
        assert_eq!(
            std::fs::read_to_string(&cua_path).expect("read cua"),
            CUA_SKILL_BODY
        );
        assert!(cua_path.parent().expect("dir").join("MACOS.md").is_file());
        assert!(
            cua_path
                .parent()
                .expect("dir")
                .join("FALCONDECK.md")
                .is_file()
        );
        let cua_dir = cua_path.parent().expect("dir");
        let local_links =
            regex::Regex::new(r"\]\(([\w-]+\.md)(?:#[^)]*)?\)").expect("local Markdown link regex");
        for entry in std::fs::read_dir(cua_dir).expect("read staged skill") {
            let path = entry.expect("staged entry").path();
            if path.extension().is_some_and(|extension| extension == "md") {
                let body = std::fs::read_to_string(&path).expect("read staged guide");
                for link in local_links.captures_iter(&body) {
                    assert!(
                        cua_dir.join(&link[1]).is_file(),
                        "{} references unstaged {}",
                        path.display(),
                        &link[1]
                    );
                }
            }
        }
        stage_bundled_skills(&state_path, false).expect("disable cua");
        assert!(!cua_path.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn staging_pi_extension_writes_file_and_is_upgrade_aware() {
        let dir = std::env::temp_dir().join(format!("fd-pi-ext-test-{}", std::process::id()));
        let staged = stage_pi_extension_in(&dir).expect("stage pi ext");
        assert!(staged.is_file());
        assert_eq!(
            std::fs::read_to_string(&staged).expect("read pi ext"),
            PI_EXTENSION_BODY
        );
        let first = std::fs::metadata(&staged)
            .and_then(|meta| meta.modified())
            .ok();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let again = stage_pi_extension_in(&dir).expect("stage again");
        assert_eq!(staged, again);
        let second = std::fs::metadata(&staged)
            .and_then(|meta| meta.modified())
            .ok();
        assert_eq!(first, second, "identical content is not rewritten");
        std::fs::write(&staged, "stale").expect("simulate old version");
        stage_pi_extension_in(&dir).expect("restage");
        assert_eq!(
            std::fs::read_to_string(&staged).expect("read").as_str(),
            PI_EXTENSION_BODY,
            "differing content is refreshed"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
