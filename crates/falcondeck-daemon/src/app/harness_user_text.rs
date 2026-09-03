//! Interprets harness-injected user-role text for the transcript.

use chrono::{DateTime, Utc};
use falcondeck_core::{ConversationItem, ServiceLevel};

const HARNESS_BLOCK_TAGS: [&str; 13] = [
    "environment_context",
    "recommended_plugins",
    "user_instructions",
    "system-reminder",
    "command-name",
    "command-message",
    "local-command-stdout",
    "INSTRUCTIONS",
    "task-notification",
    "user_info",
    "local-command-caveat",
    "interrupted_user_messages",
    "steering_messages",
];

const QUERY_TAG: &str = "user_query";

const HIDDEN_PREFIXES: [&str; 5] = [
    "Caveat: The messages below were generated",
    "# AGENTS.md instructions for",
    "The following is the Codex agent history",
    "[Request interrupted",
    "The active ACP prompt was cancelled",
];

/// Agent-facing wrapper FalconDeck prepends when a selected skill has no
/// native provider command. The path must reach the model; the transcript
/// must not show it.
const SKILL_PATH_PREFIX: &str = "Use the FalconDeck skill defined at ";
const SKILL_PATH_SUFFIX: &str = ". Follow it as the governing skill for this request.";
const SKILL_NAME_PREFIX: &str = "Apply the FalconDeck skill named '";
const SKILL_NAME_SUFFIX: &str = "' to this request.";

const MAX_COMMAND_CHARS: usize = 160;

const SHUTDOWN_RESUME_REMINDER_PREFIX: &str = "FalconDeck resume:";
const SHUTDOWN_RESUME_RECEIPT: &str = "Resumed after FalconDeck closed";
const TRANSIENT_RETRY_REMINDER_PREFIX: &str = "FalconDeck retry:";
const TRANSIENT_RETRY_RECEIPT: &str = "Retrying after a temporary Codex outage";

pub(crate) fn is_shutdown_resume_user_text(text: &str) -> bool {
    text.contains(SHUTDOWN_RESUME_REMINDER_PREFIX)
}

pub(crate) fn shutdown_resume_user_text() -> String {
    format!(
        "<system-reminder>\n{SHUTDOWN_RESUME_REMINDER_PREFIX} The previous turn was interrupted because FalconDeck closed. Continue the work from where you left off.\n</system-reminder>"
    )
}

pub(crate) fn is_transient_retry_user_text(text: &str) -> bool {
    text.contains(TRANSIENT_RETRY_REMINDER_PREFIX)
}

pub(crate) fn transient_retry_user_text() -> String {
    format!(
        "<system-reminder>\n{TRANSIENT_RETRY_REMINDER_PREFIX} The previous attempt failed because the Codex backend was temporarily unavailable. Continue the work from where you left off. Do not mention this reminder.\n</system-reminder>"
    )
}

fn falcondeck_resume_receipt(inner: &str) -> Option<ProjectedUserText> {
    inner
        .trim()
        .starts_with(SHUTDOWN_RESUME_REMINDER_PREFIX)
        .then_some(ProjectedUserText::Service {
            level: ServiceLevel::Info,
            message: SHUTDOWN_RESUME_RECEIPT.to_string(),
        })
}

fn falcondeck_retry_receipt(inner: &str) -> Option<ProjectedUserText> {
    inner
        .trim()
        .starts_with(TRANSIENT_RETRY_REMINDER_PREFIX)
        .then_some(ProjectedUserText::Service {
            level: ServiceLevel::Info,
            message: TRANSIENT_RETRY_RECEIPT.to_string(),
        })
}

pub(crate) fn falcondeck_skill_path_preamble(path: &str) -> String {
    format!("{SKILL_PATH_PREFIX}{path}{SKILL_PATH_SUFFIX}")
}

pub(crate) fn falcondeck_skill_name_preamble(label: &str) -> String {
    format!("{SKILL_NAME_PREFIX}{label}{SKILL_NAME_SUFFIX}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillPreambleStrip<'a> {
    Unchanged,
    Incomplete,
    Stripped(&'a str),
}

fn strip_falcondeck_skill_preambles(text: &str) -> SkillPreambleStrip<'_> {
    let mut rest = text.trim_start();
    let mut stripped_any = false;
    loop {
        if rest.starts_with(SKILL_PATH_PREFIX) {
            let after_prefix = &rest[SKILL_PATH_PREFIX.len()..];
            let Some(suffix_at) = after_prefix.find(SKILL_PATH_SUFFIX) else {
                return SkillPreambleStrip::Incomplete;
            };
            rest = after_prefix[suffix_at + SKILL_PATH_SUFFIX.len()..].trim_start();
            stripped_any = true;
            continue;
        }
        if rest.starts_with(SKILL_NAME_PREFIX) {
            let after_prefix = &rest[SKILL_NAME_PREFIX.len()..];
            let Some(suffix_at) = after_prefix.find(SKILL_NAME_SUFFIX) else {
                return SkillPreambleStrip::Incomplete;
            };
            rest = after_prefix[suffix_at + SKILL_NAME_SUFFIX.len()..].trim_start();
            stripped_any = true;
            continue;
        }
        break;
    }
    if stripped_any {
        SkillPreambleStrip::Stripped(rest.trim_end())
    } else {
        SkillPreambleStrip::Unchanged
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProjectedUserText {
    Prompt(String),
    Service {
        level: ServiceLevel,
        message: String,
    },
    Hidden,
    Incomplete,
}

fn has_incomplete_tag(text: &str, tag: &str) -> bool {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(start) = text[cursor..].find(&open) else {
            break;
        };
        let start = cursor + start;
        let inner_start = start + open.len();
        let Some(end) = text[inner_start..].find(&close) else {
            return true;
        };
        cursor = inner_start + end + close.len();
    }
    let dangling = format!("<{tag}");
    text.rfind(&dangling)
        .is_some_and(|index| !text[index..].contains('>'))
}

fn extract_tagged_inner<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)?;
    let inner_start = start + open.len();
    let end = text[inner_start..].find(&close)?;
    Some(text[inner_start..inner_start + end].trim())
}

fn tagged_inners<'a>(text: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut inners = Vec::new();
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(relative) = text[cursor..].find(&open) else {
            break;
        };
        let start = cursor + relative;
        let inner_start = start + open.len();
        let Some(end) = text[inner_start..].find(&close) else {
            break;
        };
        let inner = text[inner_start..inner_start + end].trim();
        if !inner.is_empty() {
            inners.push(inner);
        }
        cursor = inner_start + end + close.len();
    }
    inners
}

fn strip_tagged_blocks(text: &str, tags: &[&str]) -> String {
    let mut output = text.to_string();
    for tag in tags {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let mut next = String::with_capacity(output.len());
        let mut cursor = 0;
        while cursor < output.len() {
            let Some(relative) = output[cursor..].find(&open) else {
                next.push_str(&output[cursor..]);
                break;
            };
            let start = cursor + relative;
            next.push_str(&output[cursor..start]);
            let inner_start = start + open.len();
            let Some(end) = output[inner_start..].find(&close) else {
                next.push_str(&output[start..]);
                break;
            };
            cursor = inner_start + end + close.len();
        }
        output = next;
    }
    output
}

fn starts_with_hidden_prefix(text: &str) -> bool {
    HIDDEN_PREFIXES
        .iter()
        .any(|prefix| text.starts_with(prefix))
}

fn truncate_command(command: &str) -> String {
    if command.chars().count() <= MAX_COMMAND_CHARS {
        return command.to_string();
    }
    let mut truncated: String = command.chars().take(MAX_COMMAND_CHARS - 1).collect();
    truncated.push('…');
    truncated
}

fn background_task_receipt(body: &str) -> Option<ProjectedUserText> {
    let exit_marker = " completed (exit code: ";
    let task_marker = "Background task \"";
    let task_start = body.find(task_marker)?;
    let after_quote = task_start + task_marker.len();
    let _id_end = body[after_quote..].find('"')?;
    let exit_at = body[after_quote..].find(exit_marker)?;
    let exit_digits = &body[after_quote + exit_at + exit_marker.len()..];
    let exit_end = exit_digits.find(')')?;
    let exit: i32 = exit_digits[..exit_end].parse().ok()?;
    let failed = exit != 0;

    let mut command = body
        .split_once("Command:")
        .map(|(_, rest)| rest.trim_start())
        .map(|rest| rest.lines().next().unwrap_or(rest).trim())
        .unwrap_or("")
        .to_string();
    let mut duration = String::new();
    if let Some((cmd, dur)) = command.split_once(" | Duration:") {
        duration = dur.trim().to_string();
        command = cmd.trim().to_string();
    }
    if !command.is_empty() {
        command = truncate_command(&command);
    }

    let mut parts = Vec::new();
    if failed {
        parts.push(format!("Background command failed (exit {exit})"));
    } else {
        parts.push("Background command finished".to_string());
    }
    if !command.is_empty() {
        parts.push(command);
    }
    if !duration.is_empty() {
        parts.push(duration);
    }
    Some(ProjectedUserText::Service {
        level: if failed {
            ServiceLevel::Warning
        } else {
            ServiceLevel::Info
        },
        message: parts.join(" · "),
    })
}

/// Turns harness-injected user-role text into transcript content.
pub(crate) fn project_user_text(text: &str) -> ProjectedUserText {
    let source = text.trim();
    if source.is_empty() {
        return ProjectedUserText::Hidden;
    }

    let source = match strip_falcondeck_skill_preambles(source) {
        SkillPreambleStrip::Unchanged => source,
        SkillPreambleStrip::Incomplete => return ProjectedUserText::Incomplete,
        SkillPreambleStrip::Stripped("") => return ProjectedUserText::Hidden,
        SkillPreambleStrip::Stripped(rest) => rest,
    };

    if HARNESS_BLOCK_TAGS
        .iter()
        .copied()
        .chain(std::iter::once(QUERY_TAG))
        .any(|tag| has_incomplete_tag(source, tag))
    {
        return ProjectedUserText::Incomplete;
    }

    if let Some(query) = extract_tagged_inner(source, QUERY_TAG) {
        return if query.is_empty() || starts_with_hidden_prefix(query) {
            ProjectedUserText::Hidden
        } else {
            ProjectedUserText::Prompt(query.to_string())
        };
    }

    if !source.contains('<') && !starts_with_hidden_prefix(source) {
        return ProjectedUserText::Prompt(source.to_string());
    }

    let remainder = strip_tagged_blocks(source, &HARNESS_BLOCK_TAGS);
    let remainder = remainder.trim();
    if !remainder.is_empty() {
        return if starts_with_hidden_prefix(remainder) {
            ProjectedUserText::Hidden
        } else {
            ProjectedUserText::Prompt(remainder.to_string())
        };
    }

    for inner in tagged_inners(source, "system-reminder") {
        if let Some(receipt) = falcondeck_resume_receipt(inner) {
            return receipt;
        }
        if let Some(receipt) = falcondeck_retry_receipt(inner) {
            return receipt;
        }
        if let Some(receipt) = background_task_receipt(inner) {
            return receipt;
        }
    }
    background_task_receipt(source).unwrap_or(ProjectedUserText::Hidden)
}

/// Search/title text for a user-role payload, if it should be visible at all.
pub(crate) fn visible_user_prompt(text: &str) -> Option<String> {
    match project_user_text(text) {
        ProjectedUserText::Prompt(text) => Some(text),
        ProjectedUserText::Service { message, .. } => Some(message),
        ProjectedUserText::Hidden | ProjectedUserText::Incomplete => None,
    }
}

/// Conversation item for a replayed or echoed ACP user payload.
pub(crate) fn conversation_item_from_projected_user(
    id: String,
    text: &str,
    created_at: DateTime<Utc>,
) -> Option<ConversationItem> {
    match project_user_text(text) {
        ProjectedUserText::Prompt(text) => Some(ConversationItem::UserMessage {
            id,
            text,
            attachments: Vec::new(),
            turn_id: None,
            previous_turn_id: None,
            created_at,
        }),
        ProjectedUserText::Service { level, message } => Some(ConversationItem::Service {
            id,
            level,
            message,
            created_at,
        }),
        ProjectedUserText::Hidden | ProjectedUserText::Incomplete => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_grok_query_wrappers() {
        assert_eq!(
            project_user_text(
                "<user_info>OS: macos</user_info>\n<user_query>\nwhy does steering fail?\n</user_query>\n<system-reminder>be nice</system-reminder>"
            ),
            ProjectedUserText::Prompt("why does steering fail?".to_string())
        );
    }

    #[test]
    fn hides_skill_and_mcp_reminders() {
        assert_eq!(
            project_user_text(
                "<system-reminder>\nThe following skills are available for use:\n- ntfy\n</system-reminder>"
            ),
            ProjectedUserText::Hidden
        );
    }

    #[test]
    fn formats_failed_background_tasks() {
        assert_eq!(
            project_user_text(
                "<system-reminder>\nBackground task \"01a03c98-db41-7653-8dc8-6e7766d06c2b\" completed (exit code: 1).\nCommand: python3 -m http.server 8765 --bind 127.0.0.1 | Duration: 0.4s\nUse get_command_or_subagent_output(\"01a03c98-db41-7653-8dc8-6e7766d06c2b\") to see the full output.\n</system-reminder>"
            ),
            ProjectedUserText::Service {
                level: ServiceLevel::Warning,
                message: "Background command failed (exit 1) · python3 -m http.server 8765 --bind 127.0.0.1 · 0.4s".to_string(),
            }
        );
    }

    #[test]
    fn detects_shutdown_resume_envelopes() {
        assert!(is_shutdown_resume_user_text(&shutdown_resume_user_text()));
        assert!(!is_shutdown_resume_user_text(
            "please continue the refactor"
        ));
    }

    #[test]
    fn projects_a_shutdown_resume_as_a_quiet_receipt() {
        assert_eq!(
            project_user_text(&shutdown_resume_user_text()),
            ProjectedUserText::Service {
                level: ServiceLevel::Info,
                message: SHUTDOWN_RESUME_RECEIPT.to_string(),
            }
        );
    }

    #[test]
    fn projects_a_transient_retry_as_a_quiet_receipt() {
        assert!(is_transient_retry_user_text(&transient_retry_user_text()));
        assert!(!is_transient_retry_user_text("please continue"));
        assert_eq!(
            project_user_text(&transient_retry_user_text()),
            ProjectedUserText::Service {
                level: ServiceLevel::Info,
                message: TRANSIENT_RETRY_RECEIPT.to_string(),
            }
        );
    }

    #[test]
    fn waits_for_a_complete_injected_tag() {
        assert_eq!(
            project_user_text("<system-reminder>Background task still arriving"),
            ProjectedUserText::Incomplete
        );
    }

    #[test]
    fn drops_claude_slash_command_bookkeeping() {
        assert_eq!(
            project_user_text(
                "<command-name>/clear</command-name>\n<command-message>clear</command-message>"
            ),
            ProjectedUserText::Hidden
        );
        assert_eq!(
            project_user_text("[Request interrupted by user]"),
            ProjectedUserText::Hidden
        );
    }

    #[test]
    fn hides_acp_steering_re_bundle_echoes() {
        let echoed = "\
<interrupted_user_messages>
<message index=\"1\">
count to 80
</message>
</interrupted_user_messages>

<steering_messages>
<message index=\"1\">
stop counting
</message>
</steering_messages>

The active ACP prompt was cancelled so this steering could be delivered. Treat the interrupted user messages, if any, followed by the steering messages above as the latest user messages in chronological order.";
        assert_eq!(project_user_text(echoed), ProjectedUserText::Hidden);
    }

    #[test]
    fn unwraps_falcondeck_skill_file_references() {
        let preamble = falcondeck_skill_path_preamble(
            "/Users/James/www/sites/falcondeck/.agents/skills/tldr/SKILL.md",
        );
        assert_eq!(
            project_user_text(&format!("{preamble}\n\n/tldr")),
            ProjectedUserText::Prompt("/tldr".to_string())
        );
        assert_eq!(
            project_user_text(&format!("{preamble}\n\n/tldr summarise the last turn")),
            ProjectedUserText::Prompt("/tldr summarise the last turn".to_string())
        );
        assert_eq!(project_user_text(&preamble), ProjectedUserText::Hidden);
    }

    #[test]
    fn unwraps_named_and_stacked_skill_preambles() {
        let named = falcondeck_skill_name_preamble("Review");
        let path = falcondeck_skill_path_preamble("/tmp/review/SKILL.md");
        assert_eq!(
            project_user_text(&format!("{named}\n\nplease review")),
            ProjectedUserText::Prompt("please review".to_string())
        );
        assert_eq!(
            project_user_text(&format!("{path}\n{named}\n\n/review")),
            ProjectedUserText::Prompt("/review".to_string())
        );
    }

    #[test]
    fn waits_for_a_complete_skill_preamble() {
        assert_eq!(
            project_user_text(
                "Use the FalconDeck skill defined at /tmp/tldr/SKILL.md. Follow it as the governing skill"
            ),
            ProjectedUserText::Incomplete
        );
        assert_eq!(
            project_user_text("Apply the FalconDeck skill named 'Review' to this"),
            ProjectedUserText::Incomplete
        );
    }
}
