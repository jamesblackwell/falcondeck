//! How MCP tool calls read in a transcript. The daemon owns this so every
//! client, including the Swift apps and older builds that show `title` as-is,
//! gets the same words. `title` stays a plain string; the task a row points at
//! travels beside it in `display.thread_link`.
//!
//! Only presentation lives here. Classification keeps working from the tool
//! kind, and text that reaches agents keeps the wire name (see
//! [`agent_tool_title`]).

use std::{borrow::Cow, sync::LazyLock};

use falcondeck_core::{ToolCallDetail, ToolCallDisplay, ToolLifecycle, ToolThreadLink};
use regex::Regex;
use serde_json::{Map, Value};

/// A long subject would push the rest of the row off a phone screen.
const SUBJECT_MAX_CHARS: usize = 80;
/// Tool arguments are kept for debugging, not replay. `falcondeck_notify` bodies
/// run to 64 KB and thread pages are capped for slow relays, so one string may
/// not outweigh the page it sits in. The session file keeps the full text.
const ARGUMENT_STRING_MAX_CHARS: usize = 4_000;
/// How many names a `select:` tool search spells out before summarising.
const TOOL_SEARCH_MAX_NAMES: usize = 3;

/// The created or resolved thread, as `falcondeck_create_thread` and
/// `falcondeck_message_thread` report it in their Markdown result.
static RESULT_THREAD_ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*-\s*Id:\s*`?([A-Za-z0-9._:-]+)`?\s*$").expect("valid thread id regex")
});

static THREAD_ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]+-thread-[0-9a-f]{16,})$",
    )
    .expect("valid thread id shape regex")
});

/// Where the call has got to, as far as its wording is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpPhase {
    Running,
    Done,
    Failed,
    /// Denied, interrupted, or not known: nothing happened that a past tense
    /// could claim, so the row reads as the plain action.
    Neutral,
}

/// Which argument names the row's subject.
#[derive(Clone, Copy)]
enum Subject {
    None,
    Argument(&'static str),
    /// `thread_id` may be a bot's name, which is the subject until the result
    /// resolves it to a task.
    ThreadOrBotName,
}

/// Where the task a row points at comes from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Target {
    None,
    /// `thread_id`, or a single-entry `thread_ids`.
    Argument,
    /// The result's `Id:` line, then `thread_id`.
    Result,
}

/// One tool's wording. `verbs` are running, done and plain. A row with a
/// subject reads `<verb> <object><joiner> <subject>`; without one,
/// `<verb> <object>`. `replace_object` drops the object when there is a
/// subject: `Messaging task`, but `Messaging Juno`.
struct ToolWording {
    verbs: [&'static str; 3],
    object: &'static str,
    joiner: &'static str,
    replace_object: bool,
    subject: Subject,
    target: Target,
}

const fn wording(
    verbs: [&'static str; 3],
    object: &'static str,
    joiner: &'static str,
    subject: Subject,
    target: Target,
) -> ToolWording {
    ToolWording {
        verbs,
        object,
        joiner,
        replace_object: false,
        subject,
        target,
    }
}

/// Every tool on the `falcondeck` and `falcondeck-extensions` servers. App copy
/// calls threads tasks, so these do too, whatever the wire name says.
fn falcondeck_wording(tool: &str) -> Option<ToolWording> {
    use Subject::{Argument, None as NoSubject};
    let tool = tool.strip_prefix("falcondeck_").unwrap_or(tool);
    Some(match tool {
        "list_threads" => wording(
            ["Listing", "Listed", "List"],
            "tasks",
            "",
            NoSubject,
            Target::None,
        ),
        "view_thread" => wording(
            ["Viewing", "Viewed", "View"],
            "task",
            "",
            NoSubject,
            Target::Argument,
        ),
        "create_thread" => wording(
            ["Creating", "Created", "Create"],
            "task",
            ":",
            Argument("title"),
            Target::Result,
        ),
        "message_thread" => ToolWording {
            replace_object: true,
            ..wording(
                ["Messaging", "Messaged", "Message"],
                "task",
                "",
                Subject::ThreadOrBotName,
                Target::Result,
            )
        },
        "thread_summary" => wording(
            ["Reading", "Read", "Read"],
            "task summary",
            ":",
            NoSubject,
            Target::Argument,
        ),
        "thread_changes" => wording(
            ["Checking", "Checked", "Check"],
            "task changes",
            "",
            NoSubject,
            Target::None,
        ),
        "rename_thread" => wording(
            ["Renaming", "Renamed", "Rename"],
            "task",
            " to",
            Argument("title"),
            Target::None,
        ),
        "organize_thread" => wording(
            ["Organizing", "Organized", "Organize"],
            "task",
            "",
            NoSubject,
            Target::Argument,
        ),
        "interrupt_thread" => wording(
            ["Interrupting", "Interrupted", "Interrupt"],
            "task",
            "",
            NoSubject,
            Target::Argument,
        ),
        "wait_thread" => wording(
            ["Waiting for", "Waited for", "Wait for"],
            "task",
            "",
            NoSubject,
            Target::Argument,
        ),
        "answer_question" => wording(
            ["Answering", "Answered", "Answer"],
            "question",
            " in",
            NoSubject,
            Target::Argument,
        ),
        "notify" => wording(
            ["Sending", "Sent", "Send"],
            "notification",
            ":",
            Argument("title"),
            Target::None,
        ),
        "suggest_follow_ups" => wording(
            ["Suggesting", "Suggested", "Suggest"],
            "follow-ups",
            "",
            NoSubject,
            Target::None,
        ),
        "search" => wording(
            ["Searching", "Searched", "Search"],
            "FalconDeck",
            ":",
            Argument("query"),
            Target::None,
        ),
        "get" => wording(
            ["Reading", "Read", "Read"],
            "FalconDeck",
            "",
            Argument("resource"),
            Target::None,
        ),
        "execute" => wording(
            ["Running", "Ran", "Run"],
            "FalconDeck action",
            ":",
            Argument("operation"),
            Target::None,
        ),
        _ => return None,
    })
}

fn is_falcondeck_server(server: &str) -> bool {
    matches!(
        server.to_ascii_lowercase().replace('_', "-").as_str(),
        "falcondeck" | "falcondeck-extensions"
    )
}

/// `mcp__server__tool` as the server and tool it names.
pub(crate) fn parse_mcp_tool_name(name: &str) -> Option<(&str, &str)> {
    let (server, tool) = name.strip_prefix("mcp__")?.rsplit_once("__")?;
    (!server.is_empty() || !tool.is_empty()).then_some((server, tool))
}

/// Tool kinds whose titles are written here, so their words are presentation
/// and free text rather than a description of what ran.
pub(crate) fn is_mcp_tool_kind(kind: &str) -> bool {
    let kind = kind.trim().to_ascii_lowercase();
    kind.starts_with("mcp__") || matches!(kind.as_str(), "mcp" | "mcptoolcall" | "mcp_tool_call")
}

fn is_tool_search_kind(kind: &str) -> bool {
    matches!(
        kind.trim().to_ascii_lowercase().as_str(),
        "toolsearch" | "search_tool"
    )
}

/// `SEARCH_threads` / `searchThreads` → `Search threads`.
fn humanize_identifier(value: &str) -> String {
    let mut words = String::with_capacity(value.len() + 4);
    let mut previous_lower = false;
    for character in value.chars() {
        if matches!(character, '_' | '-') {
            words.push(' ');
            previous_lower = false;
            continue;
        }
        if character.is_uppercase() && previous_lower {
            words.push(' ');
        }
        previous_lower = character.is_lowercase() || character.is_ascii_digit();
        words.extend(character.to_lowercase());
    }
    capitalize(words.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn capitalize(value: String) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().chain(characters).collect(),
        None => value,
    }
}

/// Server names are written for configs. Connector servers carry a
/// `claude_ai_` namespace that names the host, and many end in `MCP`, which
/// says nothing to someone reading a transcript. An already-branded name keeps
/// its capitals.
fn tidy_server_name(server: &str) -> String {
    if is_falcondeck_server(server) {
        return "FalconDeck".to_string();
    }
    let server = server.strip_prefix("claude_ai_").unwrap_or(server);
    let stem = ["-mcp", "_mcp", "MCP", "Mcp"]
        .iter()
        .find_map(|suffix| server.strip_suffix(suffix))
        .filter(|stem| !stem.is_empty())
        .unwrap_or(server);
    if stem.chars().any(char::is_uppercase) && !stem.contains(['-', '_']) {
        return stem.to_string();
    }
    humanize_identifier(stem)
}

fn generic_title(server: &str, tool: &str) -> String {
    let tool = if is_falcondeck_server(server) {
        tool.strip_prefix("falcondeck_").unwrap_or(tool)
    } else {
        tool
    };
    match (tidy_server_name(server), humanize_identifier(tool)) {
        (server, tool) if server.is_empty() => tool,
        (server, tool) if tool.is_empty() => server,
        (server, tool) => format!("{server} · {tool}"),
    }
}

/// A title for a tool known only by its wire name, for callers with no
/// lifecycle to choose a tense from.
pub(crate) fn mcp_name_title(name: &str, input: Option<&Value>) -> Option<String> {
    let (server, tool) = parse_mcp_tool_name(name)?;
    Some(present_call(server, tool, input, None, McpPhase::Neutral).0)
}

fn argument<'a>(arguments: Option<&'a Value>, key: &str) -> Option<&'a str> {
    arguments?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// First line only: a title has to fit in a row.
fn subject_text(value: &str) -> Option<String> {
    let first = value.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(if first.chars().count() > SUBJECT_MAX_CHARS {
        let mut cut: String = first.chars().take(SUBJECT_MAX_CHARS - 1).collect();
        cut.push('…');
        cut
    } else {
        first.to_string()
    })
}

/// A task id rather than a bot's name. `falcondeck_message_thread` takes
/// either, and a bot name must not become a link that finds nothing, so this
/// accepts only the two shapes daemons mint: a UUID, or `<harness>-thread-<hex>`.
/// Anything else stays plain text, which is the safe way to be wrong.
fn is_thread_id(value: &str) -> bool {
    THREAD_ID_RE.is_match(value)
}

fn argument_thread_id(arguments: Option<&Value>) -> Option<&str> {
    argument(arguments, "thread_id")
        .filter(|id| is_thread_id(id))
        .or_else(
            || match arguments?.get("thread_ids")?.as_array()?.as_slice() {
                [only] => only.as_str().map(str::trim).filter(|id| is_thread_id(id)),
                _ => None,
            },
        )
}

/// What the tool said, with the JSON wrappers peeled off: harnesses hand the
/// result back as `[{"type":"text",…}]`, `{"content":[…]}`, or the bridge's own
/// `{"ok":true,"result":…}`, sometimes stringified.
struct ToolResult {
    text: String,
    ok: bool,
}

fn read_result(value: &Value) -> ToolResult {
    match value {
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(parsed @ (Value::Object(_) | Value::Array(_))) => read_result(&parsed),
            _ => ToolResult {
                text: text.clone(),
                ok: true,
            },
        },
        Value::Array(blocks) => {
            let results = blocks
                .iter()
                .filter_map(|block| block.get("text").or(Some(block)).filter(|v| v.is_string()))
                .map(read_result)
                .collect::<Vec<_>>();
            ToolResult {
                ok: results.iter().all(|result| result.ok),
                text: results
                    .into_iter()
                    .map(|result| result.text)
                    .collect::<Vec<_>>()
                    .join("\n"),
            }
        }
        Value::Object(object) => read_result_object(object),
        _ => ToolResult {
            text: String::new(),
            ok: true,
        },
    }
}

fn read_result_object(object: &Map<String, Value>) -> ToolResult {
    let failed = object.get("ok").and_then(Value::as_bool) == Some(false)
        || object.get("isError").and_then(Value::as_bool) == Some(true)
        || object.get("is_error").and_then(Value::as_bool) == Some(true);
    let inner = object
        .get("content")
        .or_else(|| object.get("result"))
        .map(read_result);
    ToolResult {
        ok: !failed && inner.as_ref().is_none_or(|inner| inner.ok),
        text: inner.map(|inner| inner.text).unwrap_or_default(),
    }
}

fn tool_result(output: Option<&str>, detail: Option<&ToolCallDetail>) -> Option<ToolResult> {
    if let Some(ToolCallDetail::Mcp {
        result: Some(result),
        ..
    }) = detail
    {
        return Some(read_result(result));
    }
    output.map(|output| read_result(&Value::String(output.to_string())))
}

fn lower_first(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_lowercase().chain(characters).collect(),
        None => String::new(),
    }
}

fn word_call(
    wording: &ToolWording,
    arguments: Option<&Value>,
    result: Option<&ToolResult>,
    phase: McpPhase,
) -> (String, Option<ToolThreadLink>) {
    let verb = match phase {
        McpPhase::Running => wording.verbs[0].to_string(),
        McpPhase::Done => wording.verbs[1].to_string(),
        McpPhase::Neutral => wording.verbs[2].to_string(),
        McpPhase::Failed => format!("Couldn't {}", lower_first(wording.verbs[2])),
    };
    let subject = match wording.subject {
        Subject::None => None,
        Subject::Argument(key) => argument(arguments, key),
        Subject::ThreadOrBotName => {
            argument(arguments, "thread_id").filter(|name| !is_thread_id(name))
        }
    }
    .and_then(subject_text);

    let lead = if wording.replace_object {
        verb.clone()
    } else {
        format!("{verb} {}{}", wording.object, wording.joiner)
    };
    let title = match &subject {
        Some(subject) => format!("{lead} {subject}"),
        None => format!("{verb} {}", wording.object),
    };

    // A failed call pointed at nothing, and one that never ran is not worth
    // following. Those rows stay plain text.
    let linkable = matches!(phase, McpPhase::Running | McpPhase::Done);
    let thread_id = match wording.target {
        _ if !linkable => None,
        Target::None => None,
        Target::Argument => argument_thread_id(arguments).map(str::to_string),
        Target::Result => result
            .and_then(|result| RESULT_THREAD_ID_RE.captures(&result.text))
            .map(|captures| captures[1].to_string())
            .or_else(|| argument_thread_id(arguments).map(str::to_string)),
    };
    let thread_link = thread_id.map(|thread_id| ToolThreadLink {
        thread_id,
        lead,
        subject,
    });
    (title, thread_link)
}

fn present_call(
    server: &str,
    tool: &str,
    arguments: Option<&Value>,
    result: Option<&ToolResult>,
    phase: McpPhase,
) -> (String, Option<ToolThreadLink>) {
    if is_falcondeck_server(server)
        && let Some(wording) = falcondeck_wording(tool)
    {
        return word_call(&wording, arguments, result, phase);
    }
    (generic_title(server, tool), None)
}

fn lifecycle_phase(lifecycle: ToolLifecycle) -> McpPhase {
    match lifecycle {
        ToolLifecycle::Queued | ToolLifecycle::AwaitingApproval | ToolLifecycle::Running => {
            McpPhase::Running
        }
        ToolLifecycle::Succeeded => McpPhase::Done,
        ToolLifecycle::Failed => McpPhase::Failed,
        ToolLifecycle::Denied | ToolLifecycle::Interrupted | ToolLifecycle::Unknown => {
            McpPhase::Neutral
        }
    }
}

/// Rewrites a stored tool call's title (and link) from what is known about it.
/// Works from the detail, kind, lifecycle and output, never the previous title,
/// so it is safe to run again whenever the call's status moves on.
pub(crate) fn present_tool_call(
    title: &mut String,
    tool_kind: &str,
    output: Option<&str>,
    display: &mut ToolCallDisplay,
    detail: Option<&ToolCallDetail>,
) {
    let phase = lifecycle_phase(display.lifecycle);
    if is_tool_search_kind(tool_kind) {
        retense_tool_search(title, display, phase);
        return;
    }

    let (server, tool, arguments, has_app_label) = match detail {
        Some(ToolCallDetail::Mcp {
            server,
            tool,
            arguments,
            app_context,
            ..
        }) => (
            server.as_str(),
            tool.as_str(),
            Some(arguments),
            app_context
                .as_ref()
                .is_some_and(|context| context.action_name.is_some()),
        ),
        _ => match parse_mcp_tool_name(tool_kind) {
            Some((server, tool)) => (server, tool, None, false),
            None => return,
        },
    };
    // Codex names connector apps and actions itself, better than a wire name.
    if has_app_label {
        return;
    }

    let result = tool_result(output, detail);
    let phase = match (&result, phase) {
        (Some(result), McpPhase::Done) if !result.ok => McpPhase::Failed,
        _ => phase,
    };
    let (presented, thread_link) = present_call(server, tool, arguments, result.as_ref(), phase);
    *title = presented;
    display.thread_link = thread_link;
}

/// `select:` queries name the tools being loaded. Keyword queries stay
/// searches: they read fine, and any MCP name in them is tidied.
pub(crate) fn tool_search_title(query: &str) -> String {
    let query = query.trim();
    let Some(selection) = query.strip_prefix("select:") else {
        let words = query
            .split_whitespace()
            .map(friendly_tool_name)
            .collect::<Vec<_>>()
            .join(" ");
        return format!("Search tools: {words}");
    };
    let names = selection
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(friendly_tool_name)
        .collect::<Vec<_>>();
    match names.as_slice() {
        [] => "Loading tools".to_string(),
        [only] => format!("Loading tool: {only}"),
        names if names.len() <= TOOL_SEARCH_MAX_NAMES => {
            format!("Loading tools: {}", names.join(", "))
        }
        names => format!(
            "Loading tools: {}, +{} more",
            names[..TOOL_SEARCH_MAX_NAMES].join(", "),
            names.len() - TOOL_SEARCH_MAX_NAMES
        ),
    }
}

fn friendly_tool_name(name: &str) -> String {
    match parse_mcp_tool_name(name) {
        Some((server, tool)) => present_call(server, tool, None, None, McpPhase::Neutral).0,
        None => name.to_string(),
    }
}

fn retense_tool_search(title: &mut String, display: &mut ToolCallDisplay, phase: McpPhase) {
    let Some(rest) = title.strip_prefix("Loading tool") else {
        return;
    };
    let verb = match phase {
        McpPhase::Running => return,
        McpPhase::Done => "Loaded",
        McpPhase::Failed => "Couldn't load",
        McpPhase::Neutral => "Load",
    };
    *title = format!("{verb} tool{rest}");
    // The category hint would otherwise title this "Search workspace".
    display.summary_hint = Some(title.clone());
}

/// Structured detail for the Claude tools that need one to stay debuggable:
/// Claude's stream carries only a wire name, so without this a friendly title
/// would leave no trace of what was called or with what.
pub(crate) fn claude_tool_detail(tool_kind: &str, input: Option<&Value>) -> Option<ToolCallDetail> {
    if let Some((server, tool)) = parse_mcp_tool_name(tool_kind) {
        return Some(ToolCallDetail::Mcp {
            server: server.to_string(),
            tool: tool.to_string(),
            arguments: input.map(bounded_arguments).unwrap_or(Value::Null),
            result: None,
            error: None,
            duration_ms: None,
            app_context: None,
        });
    }
    is_tool_search_kind(tool_kind).then_some(())?;
    Some(ToolCallDetail::Dynamic {
        tool: tool_kind.to_string(),
        namespace: None,
        arguments: bounded_arguments(input?),
        content_items: Vec::new(),
        success: None,
        duration_ms: None,
    })
}

/// Whether a Claude tool's input is worth keeping until its result arrives.
pub(crate) fn keeps_claude_tool_input(tool_kind: &str) -> bool {
    parse_mcp_tool_name(tool_kind).is_some() || is_tool_search_kind(tool_kind)
}

fn bounded_arguments(value: &Value) -> Value {
    match value {
        Value::String(text) if text.chars().count() > ARGUMENT_STRING_MAX_CHARS => {
            let mut cut: String = text.chars().take(ARGUMENT_STRING_MAX_CHARS - 1).collect();
            cut.push('…');
            Value::String(cut)
        }
        Value::Array(values) => Value::Array(values.iter().map(bounded_arguments).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), bounded_arguments(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The title an agent should see when it reads a transcript. Stored titles are
/// written for people, but `falcondeck_view_thread` and friends are model
/// input, and those keep naming the tool that ran.
pub(crate) fn agent_tool_title<'a>(
    title: &'a str,
    tool_kind: &str,
    detail: Option<&ToolCallDetail>,
) -> Cow<'a, str> {
    let wire_title = |server: &str, tool: &str| {
        let server = server.strip_prefix("claude_ai_").unwrap_or(server);
        let (server, tool) = (server.replace('_', " "), tool.replace('_', " "));
        match (server.trim(), tool.trim()) {
            ("", tool) => tool.to_string(),
            (server, "") => server.to_string(),
            (server, tool) => format!("{server} · {tool}"),
        }
    };
    match detail {
        Some(ToolCallDetail::Mcp { app_context, .. })
            if app_context
                .as_ref()
                .is_some_and(|context| context.action_name.is_some()) =>
        {
            Cow::Borrowed(title)
        }
        Some(ToolCallDetail::Mcp { server, tool, .. }) if !tool_kind.starts_with("mcp__") => {
            Cow::Owned(format!("{server} · {tool}"))
        }
        Some(ToolCallDetail::Mcp { server, tool, .. }) => Cow::Owned(wire_title(server, tool)),
        Some(ToolCallDetail::Dynamic { arguments, .. }) if is_tool_search_kind(tool_kind) => {
            argument(Some(arguments), "query").map_or(Cow::Borrowed(title), |query| {
                Cow::Owned(format!("Search tools: {query}"))
            })
        }
        _ => parse_mcp_tool_name(tool_kind).map_or(Cow::Borrowed(title), |(server, tool)| {
            Cow::Owned(wire_title(server, tool))
        }),
    }
}

#[cfg(test)]
#[path = "mcp_presentation_tests.rs"]
mod tests;
