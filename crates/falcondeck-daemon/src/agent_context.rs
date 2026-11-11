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
const AGENT_DESKTOP_SKILL_BODY: &str = include_str!("agent_context/agent-desktop/SKILL.md");

/// Directory (under the daemon state dir) holding staged bundled skills.
pub const SKILLS_DIR_NAME: &str = "skills";

/// Name of the bundled FalconDeck control skill.
pub const SKILL_NAME: &str = "falcondeck-control";

/// Name of the bundled FalconDeck MCP usage skill.
pub const MCP_SKILL_NAME: &str = "falcondeck-mcp";

/// Name of the bundled cua-driver computer-use skill.
pub const COMPUTER_USE_SKILL_NAME: &str = "cua-driver";
/// Name of the optional agent-desktop CLI skill.
pub const AGENT_DESKTOP_SKILL_NAME: &str = "agent-desktop";

/// Computer-use backend that is ready for this provider spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComputerUseContext {
    CuaDriver,
    AgentDesktop { binary: PathBuf },
}

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
    computer_use: Option<&ComputerUseContext>,
) -> io::Result<BundledSkillPaths> {
    let _ = stage_pi_extension();
    Ok(BundledSkillPaths {
        control: stage_skill_file(state_path, SKILL_NAME, CONTROL_SKILL_BODY)?,
        mcp: stage_skill_file(state_path, MCP_SKILL_NAME, MCP_SKILL_BODY)?,
        computer_use: stage_computer_use_skill(state_path, computer_use)?,
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

fn remove_staged_skill(state_path: &Path, name: &str) -> io::Result<()> {
    match std::fs::remove_dir_all(skills_root(state_path).join(name)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn stage_computer_use_skill(
    state_path: &Path,
    computer_use: Option<&ComputerUseContext>,
) -> io::Result<Option<PathBuf>> {
    match computer_use {
        Some(ComputerUseContext::CuaDriver) => {
            remove_staged_skill(state_path, AGENT_DESKTOP_SKILL_NAME)?;
            stage_cua_skill(state_path).map(Some)
        }
        Some(ComputerUseContext::AgentDesktop { binary }) => {
            remove_staged_skill(state_path, COMPUTER_USE_SKILL_NAME)?;
            if !binary.is_absolute() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "agent-desktop needs an absolute executable path",
                ));
            }
            let binary = binary.to_str().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "agent-desktop path is not UTF-8",
                )
            })?;
            let body =
                AGENT_DESKTOP_SKILL_BODY.replace("{{AGENT_DESKTOP_COMMAND}}", &shell_quote(binary));
            stage_skill_file(state_path, AGENT_DESKTOP_SKILL_NAME, &body).map(Some)
        }
        None => {
            remove_staged_skill(state_path, COMPUTER_USE_SKILL_NAME)?;
            remove_staged_skill(state_path, AGENT_DESKTOP_SKILL_NAME)?;
            Ok(None)
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn stage_cua_skill(state_path: &Path) -> io::Result<PathBuf> {
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
    computer_use_skill: Option<(&ComputerUseContext, &Path)>,
    suggest_follow_ups: bool,
) -> String {
    let mut text = String::from(
        "FalconDeck manages this session, turns and approvals. Use the available FalconDeck MCP tools when useful; do not wait for the user to name them.\n\n\
         - Delegate bounded work you expect back this turn (a search, a review, a scoped fix) to your harness's native sub-agents when it has them. Create FalconDeck threads for long-running or multi-turn work, work the user may watch or steer, another harness, model or cloud, or work that must survive restarts.\n\
         - Inspect other threads only for task context or coordination. Tools describe filtering, paging, messaging and child limits; approvals stay in the UI.\n\
         - Delegation tracking survives restarts. Use result_delivery=\"wake\" when you must act on the result, otherwise batch. Failures, needs-input, interruption and overdue tasks wake regardless. In bot homes, read reports then call falcondeck_acknowledge_results with their report_ids; never acknowledge by messaging their source.\n\
         - Pending jobs: falcondeck_watch_job with pid and/or result_file and a future RFC3339 deadline persists a wake and declares waiting. For timed waits use a timed background wake or current-thread automation plus falcondeck_task_state waiting; finished when done. Receipt leaves work open; use falcondeck_close_delegation to close or abandon it. After restart verify external jobs before retrying; they are not automatically retried.\n\
         - Notify rarely, only for critical attention or requested results. Normal replies already alert the user, except in bot scheduled-run threads. Decisions belong in reviews. Keep secrets out of push title/summary; report body is encrypted.\n\
         - Link tasks as [Task name](falcondeck://thread/THREAD_ID), using the returned id, never a title or guessed ID.\n\
         - For settings, reviews and automations: falcondeck_search (detail: \"full\" before executing), falcondeck_get, falcondeck_execute. Read schemas and worked examples first. Conversation follow-ups use thread kind current; managed threads are for unrelated standing schedules.\n",
    );
    text.push_str("- Before finishing, remove temporary worktrees, target dirs and /tmp outputs you created; keep only artifacts linked in your report.\n");
    if suggest_follow_ups {
        text.push_str("- If useful next steps remain, call falcondeck_suggest_follow_ups once (1–5 imperative labels, max 30 characters); never mention, list, or restate them in your reply.\n");
    }
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
    if let Some((backend, path)) = computer_use_skill {
        match backend {
            ComputerUseContext::CuaDriver => text.push_str(&format!(
            "\n- The `cua-driver` MCP server can operate apps on this Mac in the background. Read {} and the sibling WORKFLOW.md and MACOS.md first. Use its MCP tools, not the cua-driver CLI. For browser tasks, read BROWSER.md and FALCONDECK.md. Use the shared agent browser by default: browser_prepare with allow_launch true, the pid of the user's own Chrome (pick it as FALCONDECK.md says, not from list_apps), and profile {{mode: \"isolated_named\", name: \"falcondeck-agent\"}}. It keeps the user's agent logins and never triggers Chrome's remote-debugging prompt. Do not attach to the user's personal Chrome profile (existing_profile) unless they explicitly ask you to work in their own browser window or tab. If a site needs a login the agent browser lacks, end your browser session, then ask the user to sign in via Settings → Computer use → Open agent browser and quit that Chrome when done; never type passwords yourself, copy cookies, or fall back to the personal profile. Reuse one window, MCP connection, and session label for the task, and end the session when finished.",
            path.display()
            )),
            ComputerUseContext::AgentDesktop { binary } => text.push_str(&format!(
                "\n- Computer use is configured for agent-desktop. Read {} first, then use the selected CLI directly: {}. Read its version-matched guides with `skills get desktop` and `skills get platform` before acting. Use background semantic actions by default and verify each result from fresh UI state; use visible foreground input only when the user's task authorizes it. Do not use cua-driver MCP for computer use while this backend is selected. agent-browser is a separate tool for web pages; this setting does not configure a browser connection or authorize access to personal browser profiles or cookies.",
                path.display(),
                shell_quote(&binary.to_string_lossy()),
            )),
        }
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
            Some((
                &ComputerUseContext::CuaDriver,
                Path::new("/tmp/skills/cua-driver/SKILL.md"),
            )),
            true,
        );
        assert!(with.contains("falcondeck_suggest_follow_ups"));
        assert!(with.contains("never mention, list, or restate them in your reply"));
        assert!(with.contains("/tmp/skills/falcondeck-mcp/SKILL.md"));
        assert!(with.contains("/tmp/skills/falcondeck-control/SKILL.md"));
        assert!(with.contains("/tmp/skills/cua-driver/SKILL.md"));
        assert!(with.contains("`cua-driver` MCP server"));
        assert!(with.len() < 4_000, "always-on context grew: {} bytes", with.len());
        assert!(with.contains("name: \"falcondeck-agent\""));
        assert!(with.contains("Open agent browser"));
        assert!(!with.contains("Only mention or use FalconDeck when the user asks"));
    }

    #[test]
    fn compact_append_preserves_coordinator_correctness_rules() {
        let text = append_instructions(None, None, None, false);
        for rule in ["falcondeck_acknowledge_results", "report_ids", "future RFC3339 deadline",
            "timed background wake", "current-thread automation", "falcondeck_watch_job", "falcondeck_close_delegation", "verify external jobs",
            "not automatically retried", "Keep secrets out of push title/summary", "approvals stay in the UI"] {
            assert!(text.contains(rule), "missing coordinator rule: {rule}");
        }
    }

    #[test]
    fn agent_desktop_context_uses_the_selected_cli_without_cua_browser_guidance() {
        let backend = ComputerUseContext::AgentDesktop {
            binary: PathBuf::from("/opt/homebrew/bin/agent-desktop"),
        };
        let instructions = append_instructions(
            None,
            None,
            Some((&backend, Path::new("/tmp/skills/agent-desktop/SKILL.md"))),
            false,
        );
        assert!(instructions.contains("Computer use is configured for agent-desktop"));
        assert!(instructions.contains("'/opt/homebrew/bin/agent-desktop'"));
        assert!(instructions.contains("skills get platform"));
        assert!(instructions.contains("Do not use cua-driver MCP"));
        assert!(!instructions.contains("`cua-driver` MCP server"));
        assert!(!instructions.contains("browser_prepare"));
        assert!(!instructions.contains("Open agent browser"));
    }

    #[test]
    fn switching_computer_use_backends_replaces_the_staged_skill() {
        let dir = tempfile::tempdir().expect("temporary state");
        let state_path = dir.path().join("state.json");
        let desktop = ComputerUseContext::AgentDesktop {
            binary: PathBuf::from("/Applications/Agent Tools/agent-desktop"),
        };
        let cua_path = stage_computer_use_skill(&state_path, Some(&ComputerUseContext::CuaDriver))
            .expect("stage cua")
            .expect("cua path");
        let desktop_path = stage_computer_use_skill(&state_path, Some(&desktop))
            .expect("stage agent-desktop")
            .expect("agent-desktop path");
        assert!(!cua_path.exists());
        let body = std::fs::read_to_string(&desktop_path).expect("read agent-desktop skill");
        assert!(body.contains("'/Applications/Agent Tools/agent-desktop' skills get desktop"));
        assert!(body.contains("'/Applications/Agent Tools/agent-desktop' skills get platform"));
        assert!(!body.contains("{{AGENT_DESKTOP_COMMAND}}"));

        let moved = ComputerUseContext::AgentDesktop {
            binary: PathBuf::from("/opt/homebrew/bin/agent-desktop"),
        };
        stage_computer_use_skill(&state_path, Some(&moved)).expect("refresh executable");
        let body = std::fs::read_to_string(&desktop_path).expect("read refreshed skill");
        assert!(body.contains("'/opt/homebrew/bin/agent-desktop' status"));
        assert!(!body.contains("/Applications/Agent Tools"));

        stage_computer_use_skill(&state_path, Some(&ComputerUseContext::CuaDriver))
            .expect("switch back to cua");
        assert!(cua_path.is_file());
        assert!(!desktop_path.exists());

        stage_computer_use_skill(&state_path, Some(&desktop)).expect("select desktop again");
        stage_computer_use_skill(&state_path, None).expect("disable computer use");
        assert!(!cua_path.exists());
        assert!(!desktop_path.exists());
    }

    #[test]
    fn agent_desktop_skill_rejects_relative_executable_paths() {
        let dir = tempfile::tempdir().expect("temporary state");
        let backend = ComputerUseContext::AgentDesktop {
            binary: PathBuf::from("agent-desktop"),
        };
        let error = stage_computer_use_skill(&dir.path().join("state.json"), Some(&backend))
            .expect_err("relative executable must not depend on the agent working directory");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[cfg(unix)]
    #[test]
    fn selected_executable_shell_quoting_preserves_special_characters() {
        let binary = "/tmp/agent's $(printf injected) `printf injected`/agent-desktop";
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("printf '%s' {}", shell_quote(binary))])
            .output()
            .expect("run quoted shell argument");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).expect("UTF-8 output"),
            binary
        );
    }

    #[test]
    fn staging_writes_both_skills_and_is_upgrade_aware() {
        let dir = std::env::temp_dir().join(format!("fd-skill-test-{}", std::process::id()));
        let state_path = dir.join("state.json");
        let staged = stage_bundled_skills(&state_path, None).expect("stage");
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
        let again = stage_bundled_skills(&state_path, None).expect("stage again");
        assert_eq!(staged.control, again.control);
        let second = std::fs::metadata(&staged.control)
            .and_then(|meta| meta.modified())
            .ok();
        assert_eq!(first, second, "identical content is not rewritten");
        std::fs::write(&staged.mcp, "stale").expect("simulate old version");
        stage_bundled_skills(&state_path, None).expect("restage");
        assert_eq!(
            std::fs::read_to_string(&staged.mcp).expect("read").as_str(),
            MCP_SKILL_BODY,
            "differing content is refreshed"
        );
        let cua = stage_bundled_skills(&state_path, Some(&ComputerUseContext::CuaDriver))
            .expect("stage cua");
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
        stage_bundled_skills(&state_path, None).expect("disable cua");
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
