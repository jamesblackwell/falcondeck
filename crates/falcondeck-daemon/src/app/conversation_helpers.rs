use chrono::Utc;
use falcondeck_core::{
    ApprovalDecision, ConversationItem, InteractiveQuestion, InteractiveQuestionOption,
    InteractiveResponsePayload, ToolActivityKind, ToolArtifactKind, ToolCallDisplay,
    ToolHistoryMode, TurnInputItem,
};
use serde_json::Value;
use uuid::Uuid;

use super::ManagedThread;
use crate::codex::{extract_datetime_or_timestamp, extract_string};

pub(super) fn build_user_message_item(inputs: &[TurnInputItem]) -> ConversationItem {
    let mut text = String::new();
    let mut attachments = Vec::new();

    for input in inputs {
        match input {
            TurnInputItem::Text { text: next, .. } => {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(next);
            }
            TurnInputItem::Image(image) => attachments.push(image.clone()),
        }
    }

    ConversationItem::UserMessage {
        id: format!("user-{}", Uuid::new_v4().simple()),
        text,
        attachments,
        created_at: Utc::now(),
    }
}

pub(super) fn provisional_thread_title_from_inputs(inputs: &[TurnInputItem]) -> Option<String> {
    let text = inputs.iter().find_map(|input| match input {
        TurnInputItem::Text { text, .. } => Some(text.as_str()),
        TurnInputItem::Image(_) => None,
    })?;
    provisional_thread_title_from_text(text)
}

pub(super) fn provisional_thread_title_from_text(text: &str) -> Option<String> {
    let words = text.split_whitespace().take(4).collect::<Vec<_>>();
    if words.is_empty() {
        return None;
    }
    Some(format!("{}...", words.join(" ")))
}

pub(super) fn should_generate_ai_thread_title(thread: &ManagedThread) -> bool {
    let has_user_message = thread
        .items
        .iter()
        .any(|item| matches!(item, ConversationItem::UserMessage { .. }));
    let has_agent_output = thread.items.iter().any(|item| {
        matches!(
            item,
            ConversationItem::AssistantMessage { .. } | ConversationItem::ToolCall { .. }
        )
    });

    has_user_message
        && has_agent_output
        && !thread.manual_title
        && !thread.ai_title_generated
        && (is_placeholder_thread_title(&thread.summary.title)
            || is_provisional_thread_title(&thread.summary.title))
}

pub(super) fn is_placeholder_thread_title(title: &str) -> bool {
    matches!(
        title.trim().to_ascii_lowercase().as_str(),
        "" | "untitled thread"
            | "new thread"
            | "new claude thread"
            | "claude thread"
            | "restored thread"
    )
}

pub(super) fn is_provisional_thread_title(title: &str) -> bool {
    title.trim().ends_with("...")
}

pub(super) fn build_ai_thread_title_prompt(items: &[ConversationItem]) -> String {
    let mut excerpts = Vec::new();
    let user_messages = items
        .iter()
        .filter_map(|item| match item {
            ConversationItem::UserMessage { text, .. } => Some(text.trim()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    if let Some(first) = user_messages.first() {
        excerpts.push(format!(
            "First user message:\n{}",
            truncate_preview(first, 600)
        ));
    }

    let recent = items
        .iter()
        .rev()
        .filter_map(|item| match item {
            ConversationItem::UserMessage { text, .. } => Some(format!("User: {}", text.trim())),
            ConversationItem::AssistantMessage { text, .. } => {
                Some(format!("Assistant: {}", text.trim()))
            }
            ConversationItem::ToolCall { title, output, .. } => Some(format!(
                "Tool: {}{}",
                title.trim(),
                output
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!(" -> {}", truncate_preview(value, 180)))
                    .unwrap_or_default()
            )),
            _ => None,
        })
        .filter(|text| !text.trim().is_empty())
        .take(4)
        .collect::<Vec<_>>();
    if !recent.is_empty() {
        let ordered_recent = recent.into_iter().rev().collect::<Vec<_>>().join("\n");
        excerpts.push(format!("Recent messages:\n{ordered_recent}"));
    }

    format!(
        "You are a session renaming tool.\n\
Write a short, specific thread title for this coding conversation.\n\
\n\
Rules:\n\
- 3 to 7 words\n\
- no quotes\n\
- no trailing punctuation\n\
- prefer concrete task nouns\n\
- avoid generic titles like Debugging or Code Help\n\
- return only the title\n\
\n\
{}\n",
        excerpts.join("\n\n")
    )
}

pub(super) fn normalize_generated_thread_title(output: &str) -> Option<String> {
    let candidate = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| is_valid_generated_title_line(line))?;
    let candidate = candidate
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '`')
        .trim()
        .trim_end_matches(['.', '!', '?', ':', ';', ','])
        .trim();
    if candidate.is_empty()
        || is_placeholder_thread_title(candidate)
        || is_provisional_thread_title(candidate)
    {
        return None;
    }
    Some(truncate_preview(candidate, 80))
}

fn is_valid_generated_title_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    let normalized = trimmed.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "user" | "assistant" | "codex" | "claude" | "tokens used"
    ) {
        return false;
    }

    if normalized.starts_with("openai codex v") || normalized.starts_with("workdir:") {
        return false;
    }

    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_digit() || ch == ',' || ch == '.' || ch.is_whitespace())
    {
        return false;
    }

    true
}

pub(super) fn approval_title(method: &str) -> String {
    match method {
        "item/commandExecution/requestApproval" => "Approve command".to_string(),
        "item/fileChange/requestApproval" => "Approve file change".to_string(),
        "skill/requestApproval" => "Approve skill".to_string(),
        other => format!("Approve {}", other.rsplit('/').next().unwrap_or("request")),
    }
}

pub(super) fn notification_timestamp(
    method: &str,
    params: &Value,
) -> Option<chrono::DateTime<Utc>> {
    let preferred_keys: &[&str] = match method {
        "thread/started" => &[
            "timestamp",
            "startedAt",
            "started_at",
            "createdAt",
            "created_at",
        ],
        "thread/name/updated" | "turn/plan/updated" | "turn/diff/updated" => &[
            "timestamp",
            "updatedAt",
            "updated_at",
            "createdAt",
            "created_at",
        ],
        "turn/started" | "turn/step/started" => &[
            "timestamp",
            "startedAt",
            "started_at",
            "createdAt",
            "created_at",
        ],
        "turn/completed" | "turn/step/completed" => &[
            "timestamp",
            "completedAt",
            "completed_at",
            "updatedAt",
            "updated_at",
        ],
        _ => &[
            "timestamp",
            "updatedAt",
            "updated_at",
            "createdAt",
            "created_at",
        ],
    };
    extract_datetime_or_timestamp(params, preferred_keys)
}

pub(super) fn plan_step_status(method: &str, params: &Value) -> Option<String> {
    extract_string(params, &["status"]).or_else(|| match method {
        "turn/step/started" => Some("in_progress".to_string()),
        "turn/step/completed" => Some("completed".to_string()),
        _ => None,
    })
}

pub(super) fn parse_interactive_questions(params: &Value) -> Vec<InteractiveQuestion> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .map(|question| InteractiveQuestion {
                    id: extract_string(question, &["id"])
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    header: extract_string(question, &["header"])
                        .unwrap_or_else(|| "Question".to_string()),
                    question: extract_string(question, &["question"])
                        .unwrap_or_else(|| "Provide additional input.".to_string()),
                    is_other: question
                        .get("isOther")
                        .or_else(|| question.get("is_other"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    is_secret: question
                        .get("isSecret")
                        .or_else(|| question.get("is_secret"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    options: question
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .map(|option| InteractiveQuestionOption {
                                    label: extract_string(option, &["label"])
                                        .unwrap_or_else(|| "Option".to_string()),
                                    description: extract_string(option, &["description"])
                                        .unwrap_or_default(),
                                })
                                .collect()
                        }),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_interactive_response_params(
    params: &Value,
) -> Result<InteractiveResponsePayload, String> {
    if let Some(response) = params.get("response") {
        if let Some(kind) = extract_string(response, &["kind"]) {
            return match kind.as_str() {
                "approval" => match extract_string(response, &["decision"]).as_deref() {
                    Some("allow") => Ok(InteractiveResponsePayload::Approval {
                        decision: ApprovalDecision::Allow,
                    }),
                    Some("deny") => Ok(InteractiveResponsePayload::Approval {
                        decision: ApprovalDecision::Deny,
                    }),
                    Some("always_allow") => Ok(InteractiveResponsePayload::Approval {
                        decision: ApprovalDecision::AlwaysAllow,
                    }),
                    _ => Err("unsupported approval decision".to_string()),
                },
                "question" => Ok(InteractiveResponsePayload::Question {
                    answers: response
                        .get("answers")
                        .and_then(Value::as_object)
                        .map(|answers| {
                            answers
                                .iter()
                                .map(|(question_id, value)| {
                                    let answer_values = value
                                        .as_array()
                                        .map(|items| {
                                            items
                                                .iter()
                                                .filter_map(Value::as_str)
                                                .map(str::to_string)
                                                .collect::<Vec<_>>()
                                        })
                                        .or_else(|| {
                                            value.get("answers").and_then(Value::as_array).map(
                                                |items| {
                                                    items
                                                        .iter()
                                                        .filter_map(Value::as_str)
                                                        .map(str::to_string)
                                                        .collect::<Vec<_>>()
                                                },
                                            )
                                        })
                                        .unwrap_or_default();
                                    (question_id.clone(), answer_values)
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                }),
                _ => Err("unsupported interactive response kind".to_string()),
            };
        }
    }

    match extract_string(params, &["decision"]).as_deref() {
        Some("allow") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::Allow,
        }),
        Some("deny") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::Deny,
        }),
        Some("always_allow") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::AlwaysAllow,
        }),
        _ => Err("interactive response payload is missing a supported response".to_string()),
    }
}

pub(super) fn truncate_preview(input: &str, limit: usize) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut result = trimmed
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

pub(super) fn should_surface_tool_item(kind: &str) -> bool {
    !matches!(
        kind,
        "userMessage"
            | "user_message"
            | "agentMessage"
            | "agent_message"
            | "reasoning"
            | "reasoningSummary"
            | "reasoning_summary"
    )
}

pub(crate) fn tool_display_metadata(
    title: &str,
    kind: &str,
    status: &str,
    exit_code: Option<i32>,
    output: Option<&str>,
) -> ToolCallDisplay {
    let normalized_title = title.to_ascii_lowercase();
    let normalized_kind = kind.to_ascii_lowercase();
    let normalized_output = output.unwrap_or_default().to_ascii_lowercase();
    let activity_kind =
        classify_tool_activity_kind(&normalized_title, &normalized_kind, &normalized_output);

    let is_read_only = matches!(
        activity_kind,
        ToolActivityKind::Read
            | ToolActivityKind::Search
            | ToolActivityKind::List
            | ToolActivityKind::WebSearch
            | ToolActivityKind::ImageView
            | ToolActivityKind::Context
    ) || normalized_title.starts_with("git status")
        || normalized_title.starts_with("pwd")
        || normalized_title.starts_with("ls ")
        || normalized_title.starts_with("find ")
        || normalized_title.starts_with("rg ");

    let artifact_kind = if matches!(activity_kind, ToolActivityKind::Diff) {
        ToolArtifactKind::Diff
    } else if matches!(activity_kind, ToolActivityKind::Test) {
        ToolArtifactKind::Test
    } else if matches!(activity_kind, ToolActivityKind::Approval) {
        ToolArtifactKind::ApprovalRelated
    } else if output.map(|value| !value.trim().is_empty()).unwrap_or(false) {
        ToolArtifactKind::CommandOutput
    } else {
        ToolArtifactKind::None
    };

    let is_error = status.eq_ignore_ascii_case("failed")
        || status.eq_ignore_ascii_case("error")
        || exit_code.unwrap_or_default() != 0;
    let has_side_effect = !is_read_only
        || normalized_kind.contains("write")
        || normalized_kind.contains("edit")
        || normalized_kind.contains("patch")
        || normalized_title.contains("apply_patch")
        || normalized_title.contains("npm install")
        || normalized_title.contains("cargo add")
        || normalized_title.contains("curl ")
        || normalized_title.contains("wget ")
        || is_error;
    let history_mode = if is_error
        || has_side_effect
        || !matches!(
            activity_kind,
            ToolActivityKind::Read
                | ToolActivityKind::Search
                | ToolActivityKind::List
                | ToolActivityKind::Command
                | ToolActivityKind::WebSearch
                | ToolActivityKind::ImageView
                | ToolActivityKind::Context
        )
    {
        ToolHistoryMode::Full
    } else {
        ToolHistoryMode::Summary
    };
    let summary_hint = summarize_tool_title(title, activity_kind.clone());

    ToolCallDisplay {
        is_read_only,
        has_side_effect,
        is_error,
        artifact_kind,
        activity_kind,
        history_mode,
        summary_hint,
    }
}

fn classify_tool_activity_kind(
    normalized_title: &str,
    normalized_kind: &str,
    normalized_output: &str,
) -> ToolActivityKind {
    if normalized_kind.contains("approval")
        || normalized_title.contains("approval")
        || normalized_title.contains("permission")
    {
        ToolActivityKind::Approval
    } else if normalized_kind.contains("filechange")
        || normalized_kind.contains("file_change")
        || normalized_kind.contains("diff")
        || normalized_title.contains("apply_patch")
        || normalized_title.starts_with("git diff")
    {
        ToolActivityKind::Diff
    } else if normalized_title.contains("test")
        || normalized_kind.contains("test")
        || normalized_output.contains("test failed")
        || normalized_output.contains("failing")
    {
        ToolActivityKind::Test
    } else if normalized_kind.contains("websearch")
        || normalized_kind.contains("web_search")
        || normalized_title.starts_with("web search")
    {
        ToolActivityKind::WebSearch
    } else if normalized_kind.contains("imageview")
        || normalized_kind.contains("image_view")
        || normalized_title.starts_with("image view")
    {
        ToolActivityKind::ImageView
    } else if normalized_kind.contains("contextcompact")
        || normalized_kind.contains("context_compaction")
        || normalized_kind.contains("compaction")
        || normalized_title.contains("context compaction")
    {
        ToolActivityKind::Context
    } else if normalized_kind.contains("edit")
        || normalized_kind.contains("write")
        || normalized_kind.contains("patch")
        || normalized_title.starts_with("edit ")
    {
        ToolActivityKind::Edit
    } else if normalized_kind.contains("read")
        || normalized_kind.contains("inspect")
        || normalized_title.starts_with("cat ")
        || normalized_title.starts_with("sed -n ")
        || normalized_title.starts_with("read ")
    {
        ToolActivityKind::Read
    } else if normalized_kind.contains("list")
        || normalized_title.starts_with("ls ")
        || normalized_title.starts_with("find ")
    {
        ToolActivityKind::List
    } else if normalized_kind.contains("search")
        || normalized_kind.contains("grep")
        || normalized_title.starts_with("rg ")
    {
        ToolActivityKind::Search
    } else if normalized_kind.contains("command")
        || normalized_title.starts_with("bash:")
        || normalized_title.starts_with("/bin/")
        || normalized_title.starts_with("git ")
        || normalized_title.starts_with("pwd")
    {
        ToolActivityKind::Command
    } else {
        ToolActivityKind::Other
    }
}

fn summarize_tool_title(title: &str, activity_kind: ToolActivityKind) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(path) = trimmed.strip_prefix("cat ") {
        return Some(format!("Read {}", path.trim()));
    }
    if let Some(path) = trimmed.strip_prefix("sed -n ") {
        return Some(format!("Inspect {}", path.trim()));
    }
    if trimmed.starts_with("rg ") {
        return Some("Search workspace".to_string());
    }
    if trimmed.starts_with("ls ") {
        return Some("List files".to_string());
    }
    if trimmed.starts_with("find ") {
        return Some("List files".to_string());
    }
    if trimmed.starts_with("git status") {
        return Some("Check git status".to_string());
    }
    if trimmed.starts_with("pwd") {
        return Some("Show working directory".to_string());
    }

    match activity_kind {
        ToolActivityKind::Read => Some("Read file".to_string()),
        ToolActivityKind::Search => Some("Search workspace".to_string()),
        ToolActivityKind::List => Some("List files".to_string()),
        ToolActivityKind::WebSearch => Some("Search web".to_string()),
        ToolActivityKind::ImageView => Some("View image".to_string()),
        ToolActivityKind::Context => Some("Compact context".to_string()),
        ToolActivityKind::Diff => Some("Update files".to_string()),
        ToolActivityKind::Edit => Some("Edit files".to_string()),
        ToolActivityKind::Test => Some("Run tests".to_string()),
        ToolActivityKind::Approval => Some("Request approval".to_string()),
        ToolActivityKind::Command | ToolActivityKind::Other => None,
    }
}
