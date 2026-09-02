//! Mission-specific agent context, staged only while the bundled Missions
//! extension is ready to publish its durable project tools.

use std::io;
use std::path::{Path, PathBuf};

const SKILL_BODY: &str = include_str!("mission_context/SKILL.md");

pub(crate) const SKILL_NAME: &str = "falcondeck-missions";

pub(crate) fn stage_skill(state_path: &Path) -> io::Result<PathBuf> {
    let skill_dir = crate::agent_context::skills_root(state_path).join(SKILL_NAME);
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

pub(crate) fn append_instructions(text: &mut String, skill_path: Option<&Path>) {
    if !text.is_empty() {
        text.push('\n');
    }
    text.push_str(
        "- When the user explicitly asks to start or create a FalconDeck Mission, call `falcondeck_missions-create_mission` before doing the requested work. Create a durable brief with concrete success criteria, choose the least-frequent useful check-in cadence, and only include a deadline when the user wants one. Do not substitute a harness goal or merely describe a Mission. The tool links this task, starts the Mission, and queues its first agent check-in immediately; never ask the user to activate it again.",
    );
    if let Some(path) = skill_path {
        text.push_str(&format!(
            "\n- FalconDeck Mission workflow (read when Mission intent is present or this task is linked to a Mission): {}",
            path.display()
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_distinguish_missions_from_harness_goals() {
        let mut text = "Base context".to_string();
        append_instructions(
            &mut text,
            Some(Path::new("/tmp/skills/falcondeck-missions/SKILL.md")),
        );

        assert!(text.contains("falcondeck_missions-create_mission"));
        assert!(text.contains("Do not substitute a harness goal"));
        assert!(text.contains("queues its first agent check-in immediately"));
        assert!(text.contains("/tmp/skills/falcondeck-missions/SKILL.md"));
    }

    #[test]
    fn staging_is_idempotent_and_upgrade_aware() {
        let dir = tempfile::tempdir().expect("temporary state directory");
        let state_path = dir.path().join("state.json");
        let skill = stage_skill(&state_path).expect("stage Mission skill");
        assert_eq!(
            std::fs::read_to_string(&skill).expect("read Mission skill"),
            SKILL_BODY
        );

        let first = std::fs::metadata(&skill)
            .and_then(|metadata| metadata.modified())
            .expect("first modification time");
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert_eq!(stage_skill(&state_path).expect("restage"), skill);
        let second = std::fs::metadata(&skill)
            .and_then(|metadata| metadata.modified())
            .expect("second modification time");
        assert_eq!(first, second);

        std::fs::write(&skill, "stale").expect("simulate an old bundled skill");
        stage_skill(&state_path).expect("refresh bundled skill");
        assert_eq!(
            std::fs::read_to_string(&skill).expect("read refreshed skill"),
            SKILL_BODY
        );
    }
}
