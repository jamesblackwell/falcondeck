use falcondeck_core::{ToolActivityKind, ToolMcpAppContext};
use serde_json::{Value, json};

use super::*;
use crate::app::conversation_helpers::{sanitize_conversation_item, tool_display_metadata};
use falcondeck_core::ConversationItem;

const CREATE: &str = "mcp__falcondeck-extensions__falcondeck_create_thread";
const CREATED: &str =
    "# Created thread\n\n- Id: claude-thread-861795\n- Parent: claude-thread-b492\n";

/// What a row ends up as after the daemon's write gate.
fn present(
    kind: &str,
    status: &str,
    arguments: Option<Value>,
    output: Option<&str>,
) -> (String, Option<ToolThreadLink>) {
    let mut item = ConversationItem::ToolCall {
        id: "tool".to_string(),
        title: "raw".to_string(),
        tool_kind: kind.to_string(),
        status: status.to_string(),
        output: output.map(str::to_string),
        exit_code: None,
        display: Box::new(tool_display_metadata("raw", kind, status, None, output)),
        detail: claude_tool_detail(kind, arguments.as_ref()).map(Box::new),
        created_at: chrono::Utc::now(),
        completed_at: None,
    };
    sanitize_conversation_item(&mut item);
    let ConversationItem::ToolCall { title, display, .. } = item else {
        unreachable!()
    };
    (title, display.thread_link)
}

fn title(kind: &str, status: &str, arguments: Value) -> String {
    present(kind, status, Some(arguments), None).0
}

#[test]
fn every_falcondeck_tool_has_a_running_and_a_done_label() {
    let cases = [
        ("list_threads", "Listing tasks", "Listed tasks"),
        ("view_thread", "Viewing task", "Viewed task"),
        ("create_thread", "Creating task", "Created task"),
        ("message_thread", "Messaging task", "Messaged task"),
        (
            "thread_summary",
            "Reading task summary",
            "Read task summary",
        ),
        (
            "thread_changes",
            "Checking task changes",
            "Checked task changes",
        ),
        ("rename_thread", "Renaming task", "Renamed task"),
        ("organize_thread", "Organizing task", "Organized task"),
        ("interrupt_thread", "Interrupting task", "Interrupted task"),
        ("wait_thread", "Waiting for task", "Waited for task"),
        ("answer_question", "Answering question", "Answered question"),
        ("notify", "Sending notification", "Sent notification"),
        (
            "suggest_follow_ups",
            "Suggesting follow-ups",
            "Suggested follow-ups",
        ),
    ];
    for (tool, running, done) in cases {
        let kind = format!("mcp__falcondeck-extensions__falcondeck_{tool}");
        assert_eq!(title(&kind, "running", json!({})), running, "{tool}");
        assert_eq!(title(&kind, "completed", json!({})), done, "{tool}");
    }
    for (tool, running, done) in [
        ("search", "Searching FalconDeck", "Searched FalconDeck"),
        ("get", "Reading FalconDeck", "Read FalconDeck"),
        (
            "execute",
            "Running FalconDeck action",
            "Ran FalconDeck action",
        ),
    ] {
        let kind = format!("mcp__falcondeck__falcondeck_{tool}");
        assert_eq!(title(&kind, "running", json!({})), running, "{tool}");
        assert_eq!(title(&kind, "completed", json!({})), done, "{tool}");
    }
}

#[test]
fn control_tools_name_what_they_acted_on() {
    let search = "mcp__falcondeck__falcondeck_search";
    let get = "mcp__falcondeck__falcondeck_get";
    let execute = "mcp__falcondeck__falcondeck_execute";
    assert_eq!(
        title(search, "running", json!({"query": "automation"})),
        "Searching FalconDeck: automation"
    );
    assert_eq!(
        title(get, "completed", json!({"resource": "automations"})),
        "Read FalconDeck automations"
    );
    assert_eq!(
        title(
            execute,
            "completed",
            json!({"operation": "automation.update"})
        ),
        "Ran FalconDeck action: automation.update"
    );
}

#[test]
fn a_created_task_links_to_the_id_in_its_result() {
    let args = json!({"title": "Fix login", "prompt": "..."});
    let (running, link) = present(CREATE, "running", Some(args.clone()), None);
    assert_eq!(running, "Creating task: Fix login");
    assert_eq!(link, None, "no id exists until the task does");

    let wrapped = json!({"ok": true, "result": CREATED}).to_string();
    let (done, link) = present(CREATE, "completed", Some(args), Some(&wrapped));
    assert_eq!(done, "Created task: Fix login");
    assert_eq!(
        link,
        Some(ToolThreadLink {
            thread_id: "claude-thread-861795".to_string(),
            lead: "Created task:".to_string(),
            subject: Some("Fix login".to_string()),
        })
    );
}

#[test]
fn reads_the_id_from_every_result_wrapper() {
    let block =
        json!([{"type": "text", "text": json!({"ok": true, "result": CREATED}).to_string()}]);
    for output in [CREATED.to_string(), block.to_string()] {
        let (_, link) = present(CREATE, "completed", Some(json!({})), Some(&output));
        assert_eq!(link.unwrap().thread_id, "claude-thread-861795");
    }
}

#[test]
fn codex_detail_results_link_and_keep_the_wire_tool() {
    let mut title = "falcondeck-extensions · falcondeck_create_thread".to_string();
    let mut display = tool_display_metadata(&title, "mcpToolCall", "completed", None, None);
    let detail = ToolCallDetail::Mcp {
        server: "falcondeck-extensions".to_string(),
        tool: "falcondeck_create_thread".to_string(),
        arguments: json!({"title": "Fix login"}),
        result: Some(json!({"content": [{"type": "text", "text": CREATED}]})),
        error: None,
        duration_ms: None,
        app_context: None,
    };
    present_tool_call(&mut title, "mcpToolCall", None, &mut display, Some(&detail));
    assert_eq!(title, "Created task: Fix login");
    assert_eq!(
        display.thread_link.unwrap().thread_id,
        "claude-thread-861795"
    );
    assert_eq!(
        agent_tool_title(&title, "mcpToolCall", Some(&detail)),
        "falcondeck-extensions · falcondeck_create_thread"
    );
}

#[test]
fn an_id_argument_links_before_the_call_finishes() {
    let args = json!({"thread_id": "01a1a173-f7d2-7c72-89ac-37a4c501446b"});
    let view = "mcp__falcondeck-extensions__falcondeck_view_thread";
    let (running, link) = present(view, "running", Some(args), None);
    assert_eq!(running, "Viewing task");
    let link = link.unwrap();
    assert_eq!(link.lead, "Viewing task");
    assert_eq!(link.thread_id, "01a1a173-f7d2-7c72-89ac-37a4c501446b");
    assert_eq!(link.subject, None);
}

#[test]
fn a_bot_name_is_the_subject_until_the_result_resolves_it() {
    let message = "mcp__falcondeck-extensions__falcondeck_message_thread";
    let args = json!({"thread_id": "Juno", "message": "hello"});
    let (running, link) = present(message, "running", Some(args.clone()), None);
    assert_eq!(running, "Messaging Juno");
    assert_eq!(link, None, "a name is not a link target");

    let result = "# Message accepted\n\n- Id: claude-thread-dd689c\n- Delivery: turn started\n";
    let (done, link) = present(message, "completed", Some(args), Some(result));
    assert_eq!(done, "Messaged Juno");
    assert_eq!(link.unwrap().thread_id, "claude-thread-dd689c");
}

#[test]
fn only_a_single_summary_target_links() {
    let summary = "mcp__falcondeck-extensions__falcondeck_thread_summary";
    let one = json!({"thread_ids": ["claude-thread-1"]});
    let many = json!({"thread_ids": ["claude-thread-1", "claude-thread-2"]});
    assert!(present(summary, "completed", Some(one), None).1.is_some());
    assert!(present(summary, "completed", Some(many), None).1.is_none());
}

#[test]
fn errored_calls_read_as_failed_and_do_not_link() {
    let args = json!({"title": "Fix login", "thread_id": "claude-thread-1"});
    let (flagged, link) = present(CREATE, "failed", Some(args.clone()), Some("boom"));
    assert_eq!(flagged, "Couldn't create task: Fix login");
    assert_eq!(link, None);

    // The bridge reports some failures as ordinary results.
    let refused = r#"{"error":"parent already has 3 concurrent children","ok":false}"#;
    let (quiet, link) = present(CREATE, "completed", Some(args), Some(refused));
    assert_eq!(quiet, "Couldn't create task: Fix login");
    assert_eq!(link, None);
}

#[test]
fn calls_that_never_ran_take_no_tense_and_no_link() {
    let args = json!({"thread_id": "claude-thread-1"});
    let interrupt = "mcp__falcondeck-extensions__falcondeck_view_thread";
    for status in ["denied", "interrupted"] {
        let (title, link) = present(interrupt, status, Some(args.clone()), None);
        assert_eq!(title, "View task", "{status}");
        assert_eq!(link, None, "{status}");
    }
}

#[test]
fn a_row_without_its_arguments_still_reads_and_stays_plain() {
    // Older transcripts and the first streamed event have only the wire name.
    let (title, link) = present(CREATE, "completed", None, None);
    assert_eq!(title, "Created task");
    assert_eq!(link, None);
}

#[test]
fn other_servers_get_a_tidied_generic_label() {
    for (kind, expected) in [
        (
            "mcp__claude_ai_Gmail__search_threads",
            "Gmail · Search threads",
        ),
        (
            "mcp__sentry__get_issue_details",
            "Sentry · Get issue details",
        ),
        (
            "mcp__AbletonMCP__add_notes_to_clip",
            "Ableton · Add notes to clip",
        ),
        (
            "mcp__agent-browser__takeSnapshot",
            "Agent browser · Take snapshot",
        ),
        (
            "mcp__falcondeck-extensions__weather_lookup",
            "FalconDeck · Weather lookup",
        ),
    ] {
        assert_eq!(title(kind, "completed", json!({})), expected);
        assert_eq!(title(kind, "running", json!({})), expected);
    }
}

#[test]
fn codex_connector_labels_are_left_alone() {
    let mut title = "Gmail · Search".to_string();
    let mut display = tool_display_metadata(&title, "mcpToolCall", "completed", None, None);
    let detail = ToolCallDetail::Mcp {
        server: "codex_apps".to_string(),
        tool: "gmail_search".to_string(),
        arguments: Value::Null,
        result: None,
        error: None,
        duration_ms: None,
        app_context: Some(ToolMcpAppContext {
            connector_id: "gmail".to_string(),
            app_name: Some("Gmail".to_string()),
            action_name: Some("Search".to_string()),
            link_id: None,
            resource_uri: None,
            template_id: None,
        }),
    };
    present_tool_call(&mut title, "mcpToolCall", None, &mut display, Some(&detail));
    assert_eq!(title, "Gmail · Search");
}

#[test]
fn tool_search_reads_as_loading_the_tool() {
    assert_eq!(
        tool_search_title(&format!("select:{CREATE}")),
        "Loading tool: Create task"
    );
    assert_eq!(
        tool_search_title("select:mcp__sentry__whoami,Read"),
        "Loading tools: Sentry · Whoami, Read"
    );
    assert_eq!(
        tool_search_title("select:A,B,C,D,E"),
        "Loading tools: A, B, C, +2 more"
    );
    assert_eq!(
        tool_search_title("notebook jupyter"),
        "Search tools: notebook jupyter"
    );
}

#[test]
fn tool_search_settles_into_the_past_tense_and_keeps_its_query() {
    let query = json!({"query": format!("select:{CREATE}")});
    let mut title = tool_search_title(query["query"].as_str().unwrap());
    let mut display = tool_display_metadata(&title, "ToolSearch", "completed", None, None);
    assert_eq!(display.activity_kind, ToolActivityKind::Search);
    let detail = claude_tool_detail("ToolSearch", Some(&query)).unwrap();
    present_tool_call(&mut title, "ToolSearch", None, &mut display, Some(&detail));
    assert_eq!(title, "Loaded tool: Create task");
    assert_eq!(display.summary_hint.as_deref(), Some(title.as_str()));
    assert_eq!(
        agent_tool_title(&title, "ToolSearch", Some(&detail)),
        format!("Search tools: select:{CREATE}")
    );
}

#[test]
fn a_task_name_cannot_reclassify_the_call() {
    let args = json!({"title": "run npm test then git diff"});
    let quoted = tool_display_metadata(
        "Creating task: run npm test then git diff",
        CREATE,
        "completed",
        None,
        None,
    );
    let unquoted = tool_display_metadata("Creating task", CREATE, "completed", None, None);
    assert_eq!(quoted, unquoted);
    assert_ne!(quoted.activity_kind, ToolActivityKind::Test);
    assert_eq!(
        title(CREATE, "completed", args),
        "Created task: run npm test then git diff"
    );
}

#[test]
fn a_skill_path_in_a_task_name_does_not_hide_the_output() {
    let args = json!({"title": "Update docs/SKILL.md"});
    let mut item = ConversationItem::ToolCall {
        id: "tool".to_string(),
        title: "Create task: Update docs/SKILL.md".to_string(),
        tool_kind: CREATE.to_string(),
        status: "completed".to_string(),
        output: Some(CREATED.to_string()),
        exit_code: None,
        display: Box::default(),
        detail: claude_tool_detail(CREATE, Some(&args)).map(Box::new),
        created_at: chrono::Utc::now(),
        completed_at: None,
    };
    sanitize_conversation_item(&mut item);
    let ConversationItem::ToolCall { output, .. } = item else {
        unreachable!()
    };
    assert_eq!(output.as_deref(), Some(CREATED));
}

#[test]
fn raw_tool_name_and_arguments_stay_in_the_detail() {
    let Some(ToolCallDetail::Mcp {
        server,
        tool,
        arguments,
        ..
    }) = claude_tool_detail(CREATE, Some(&json!({"title": "Fix login"})))
    else {
        panic!("expected an MCP detail");
    };
    assert_eq!(server, "falcondeck-extensions");
    assert_eq!(tool, "falcondeck_create_thread");
    assert_eq!(arguments, json!({"title": "Fix login"}));
}

#[test]
fn long_argument_strings_are_bounded() {
    let body = "x".repeat(ARGUMENT_STRING_MAX_CHARS + 50);
    let Some(ToolCallDetail::Mcp { arguments, .. }) =
        claude_tool_detail(CREATE, Some(&json!({"prompt": body, "nested": ["short"]})))
    else {
        panic!("expected an MCP detail");
    };
    let prompt = arguments["prompt"].as_str().unwrap();
    assert_eq!(prompt.chars().count(), ARGUMENT_STRING_MAX_CHARS);
    assert!(prompt.ends_with('…'));
    assert_eq!(arguments["nested"], json!(["short"]));
}

#[test]
fn agents_keep_reading_the_wire_name() {
    assert_eq!(
        agent_tool_title("Created task: Fix login", CREATE, None),
        "falcondeck-extensions · falcondeck create thread"
    );
    assert_eq!(
        agent_tool_title(
            "Gmail · Search threads",
            "mcp__claude_ai_Gmail__search_threads",
            None
        ),
        "Gmail · search threads"
    );
    assert_eq!(agent_tool_title("Read /a.ts", "Read", None), "Read /a.ts");
}

#[test]
fn old_payloads_without_a_link_still_deserialize_and_new_ones_stay_additive() {
    let old: ToolCallDisplay = serde_json::from_value(json!({})).unwrap();
    assert_eq!(old.thread_link, None);
    let encoded = serde_json::to_value(ToolCallDisplay::default()).unwrap();
    assert!(encoded.get("thread_link").is_none());
}
