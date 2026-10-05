use super::*;

const MAX_SESSION_LINE_BYTES: usize = 512_000;

/// Visits newline-delimited records without ever allocating more than the
/// accepted line limit. `BufRead::lines` only reports a line's size after it
/// has built the complete `String`; real Codex rollouts contain individual
/// image/tool records tens of megabytes long.
fn visit_bounded_lines<R: BufRead>(
    reader: &mut R,
    mut visit: impl FnMut(&[u8]) -> bool,
) -> std::io::Result<()> {
    let mut line = Vec::with_capacity(8 * 1024);
    let mut over_limit = false;

    loop {
        let (consumed, line_complete, reached_eof) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                (0, false, true)
            } else {
                let newline = available.iter().position(|byte| *byte == b'\n');
                let segment_end = newline.unwrap_or(available.len());
                if !over_limit {
                    if line.len().saturating_add(segment_end) <= MAX_SESSION_LINE_BYTES {
                        line.extend_from_slice(&available[..segment_end]);
                    } else {
                        line.clear();
                        over_limit = true;
                    }
                }
                (
                    newline.map_or(available.len(), |index| index + 1),
                    newline.is_some(),
                    false,
                )
            }
        };

        if reached_eof {
            if !over_limit && !line.is_empty() {
                let _ = visit(&line);
            }
            return Ok(());
        }

        reader.consume(consumed);
        if line_complete {
            if !over_limit && !visit(&line) {
                return Ok(());
            }
            line.clear();
            over_limit = false;
        }
    }
}

pub(super) fn hydrate_thread_items_from_session_file(
    session_path: &str,
    workspace_path: &str,
) -> Vec<ConversationItem> {
    hydrate_thread_history_from_session_file(session_path, workspace_path, None).0
}

/// Refresh reads transcript and terminal metadata from the same file snapshot.
/// An expected ID requires native session metadata, rather than inferring
/// ownership or completion from conversation text.
pub(super) fn hydrate_thread_history_from_session_file(
    session_path: &str,
    workspace_path: &str,
    expected_thread_id: Option<&str>,
) -> (Vec<ConversationItem>, Option<Value>) {
    let file = match File::open(session_path) {
        Ok(file) => file,
        Err(_) => return (Vec::new(), None),
    };
    // Read a stable snapshot. Without `take`, a rollout that is still being
    // appended can keep a restore scan chasing a moving EOF indefinitely.
    let snapshot_len = file
        .metadata()
        .map(|metadata| metadata.len())
        .unwrap_or(u64::MAX);
    if snapshot_len == 0 {
        return (Vec::new(), None);
    }
    let mut reader = StdBufReader::new(file.take(snapshot_len));
    let mut items: Vec<SessionHydratedItem> = Vec::new();
    let mut tool_calls_by_call_id: HashMap<String, usize> = HashMap::new();
    let mut matches_workspace = false;
    let mut rejected_workspace = false;
    let mut verified_session = false;
    let mut latest_turn = None;

    let scan_result = visit_bounded_lines(&mut reader, |line| {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return true;
        };
        let entry_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if entry_type == "session_meta"
            && let Some(expected_id) = expected_thread_id
        {
            verified_session = value
                .get("payload")
                .and_then(|payload| payload.get("id"))
                .and_then(Value::as_str)
                == Some(expected_id)
                && extract_cwd(&value).as_deref() == Some(workspace_path);
            if !verified_session {
                rejected_workspace = true;
                return false;
            }
        }

        if matches!(entry_type, "session_meta" | "turn_context")
            && let Some(cwd) = extract_cwd(&value)
        {
            matches_workspace = cwd == workspace_path;
            if !matches_workspace {
                rejected_workspace = true;
                return false;
            }
        }

        if !matches_workspace || (expected_thread_id.is_some() && !verified_session) {
            return true;
        }

        update_session_latest_turn(&mut latest_turn, &value);

        if let Some((call_id, output, completed_at)) = session_tool_call_output(&value) {
            if let Some(index) = tool_calls_by_call_id.get(&call_id).copied() {
                apply_session_tool_call_output(&mut items[index].item, output, completed_at);
            }
            return true;
        }

        if let Some(item) = build_session_hydrated_item_from_entry(&value) {
            if let SessionHydratedItemKind::ToolCall { call_id } = &item.kind {
                tool_calls_by_call_id.insert(call_id.clone(), items.len());
            }
            items.push(item);
        }
        true
    });

    if rejected_workspace
        || (expected_thread_id.is_some()
            && (!verified_session
                || scan_result.is_err()
                || reader
                    .get_ref()
                    .get_ref()
                    .metadata()
                    .map(|metadata| metadata.len() != snapshot_len)
                    .unwrap_or(true)))
    {
        return (Vec::new(), None);
    }

    let response_timestamps = session_response_timestamps(&items);
    let mut conversation_items = items
        .into_iter()
        .filter(|item| should_keep_session_hydrated_item(item, &response_timestamps))
        .map(|item| item.item)
        .collect::<Vec<_>>();
    conversation_items.sort_by_key(conversation_item_created_at);
    (conversation_items, latest_turn)
}

fn update_session_latest_turn(latest_turn: &mut Option<Value>, value: &Value) {
    let Some(payload) = value.get("payload") else {
        return;
    };
    let Some(turn_id) = extract_string(payload, &["turn_id"]) else {
        return;
    };
    let entry_type = value.get("type").and_then(Value::as_str);
    let event_type = payload.get("type").and_then(Value::as_str);
    let starts_turn = entry_type == Some("turn_context")
        || (entry_type == Some("event_msg") && event_type == Some("task_started"));
    if starts_turn {
        if event_type == Some("task_started")
            || latest_turn
                .as_ref()
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                != Some(turn_id.as_str())
        {
            let mut turn = json!({"id": turn_id, "status": "inProgress"});
            if let Some(started_at) = extract_datetime_or_timestamp(payload, &["started_at"])
                .or_else(|| extract_datetime_or_timestamp(value, &["timestamp"]))
            {
                turn["startedAt"] = json!(started_at.to_rfc3339());
            }
            *latest_turn = Some(turn);
        }
        return;
    }

    if entry_type != Some("event_msg") {
        return;
    }
    let status = match event_type {
        Some("task_complete") => "completed",
        Some("turn_aborted") => "interrupted",
        _ => return,
    };
    let Some(turn) = latest_turn
        .as_mut()
        .filter(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id.as_str()))
    else {
        return;
    };
    turn["status"] = json!(status);
    if let Some(completed_at) = extract_datetime_or_timestamp(payload, &["completed_at"])
        .or_else(|| extract_datetime_or_timestamp(value, &["timestamp"]))
    {
        turn["completedAt"] = json!(completed_at.to_rfc3339());
    }
}

pub(super) fn supplement_thread_items_with_session_tool_calls(
    items: &mut Vec<ConversationItem>,
    session_path: &str,
    workspace_path: &str,
) {
    let session_items = hydrate_thread_items_from_session_file(session_path, workspace_path);
    let mut tool_ids = items
        .iter()
        .filter_map(|item| match item {
            ConversationItem::ToolCall { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect::<HashSet<_>>();
    for session_item in session_items {
        let ConversationItem::ToolCall { id, .. } = &session_item else {
            continue;
        };
        if tool_ids.insert(id.clone()) {
            items.push(session_item);
        }
    }
    items.sort_by_key(conversation_item_created_at);
}

#[derive(Clone)]
enum SessionHydratedItemKind {
    UserMessage,
    AssistantMessageFromEvent,
    AssistantMessageFromResponse,
    ToolCall { call_id: String },
    Other,
}

#[derive(Clone)]
struct SessionHydratedItem {
    kind: SessionHydratedItemKind,
    item: ConversationItem,
}

fn build_session_hydrated_item_from_entry(value: &Value) -> Option<SessionHydratedItem> {
    let created_at =
        extract_datetime_or_timestamp(value, &["timestamp", "createdAt", "created_at"])
            .unwrap_or_else(Utc::now);
    let entry_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = value.get("payload")?;

    match entry_type {
        "event_msg" => match payload.get("type").and_then(Value::as_str)? {
            "user_message" => Some(SessionHydratedItem {
                kind: SessionHydratedItemKind::UserMessage,
                item: ConversationItem::UserMessage {
                    id: extract_string(payload, &["id"]).unwrap_or_else(|| {
                        format!("session-user-{}", created_at.timestamp_millis())
                    }),
                    text: extract_string(payload, &["message"]).unwrap_or_default(),
                    attachments: session_entry_attachments(payload),
                    turn_id: None,
                    previous_turn_id: None,
                    created_at,
                },
            }),
            "agent_message" => {
                let mut item = ConversationItem::AssistantMessage {
                    id: extract_string(payload, &["id"]).unwrap_or_else(|| {
                        format!("session-agent-{}", created_at.timestamp_millis())
                    }),
                    text: extract_string(payload, &["message"]).unwrap_or_default(),
                    phase: None,
                    memory_citation: None,
                    citations: Vec::new(),
                    lifecycle: ContentLifecycle::Complete,
                    error: None,
                    created_at,
                };
                crate::app::conversation_helpers::rewrite_transient_assistant_error(&mut item);
                Some(SessionHydratedItem {
                    kind: SessionHydratedItemKind::AssistantMessageFromEvent,
                    item,
                })
            }
            _ => None,
        },
        "response_item" => match payload.get("type").and_then(Value::as_str)? {
            "message" => {
                let role = extract_string(payload, &["role"]).unwrap_or_default();
                let text = response_item_message_text(payload);
                if text.is_empty() {
                    return None;
                }
                match role.as_str() {
                    "assistant" => Some(SessionHydratedItem {
                        kind: SessionHydratedItemKind::AssistantMessageFromResponse,
                        item: {
                            let (phase, memory_citation) =
                                codex_assistant_message_metadata(payload);
                            let mut item = ConversationItem::AssistantMessage {
                                id: extract_string(payload, &["id"]).unwrap_or_else(|| {
                                    format!("response-assistant-{}", created_at.timestamp_millis())
                                }),
                                text,
                                phase,
                                memory_citation,
                                citations: Vec::new(),
                                lifecycle: ContentLifecycle::Complete,
                                error: None,
                                created_at,
                            };
                            crate::app::conversation_helpers::rewrite_transient_assistant_error(
                                &mut item,
                            );
                            item
                        },
                    }),
                    "user" => None,
                    _ => None,
                }
            }
            "reasoning" => Some(SessionHydratedItem {
                kind: SessionHydratedItemKind::Other,
                item: ConversationItem::Reasoning {
                    id: extract_string(payload, &["id"]).unwrap_or_else(|| {
                        format!("response-reasoning-{}", created_at.timestamp_millis())
                    }),
                    summary: thread_item_text(payload.get("summary")),
                    content: payload
                        .get("content")
                        .and_then(|content| thread_item_text(Some(content)))
                        .unwrap_or_default(),
                    lifecycle: ContentLifecycle::Complete,
                    duration_ms: None,
                    created_at,
                },
            }),
            "custom_tool_call" => {
                let call_id = extract_string(payload, &["call_id", "callId"])?;
                let id = extract_string(payload, &["id"]).unwrap_or_else(|| call_id.clone());
                let name = extract_string(payload, &["name"]).unwrap_or_else(|| "Tool".to_string());
                let status =
                    extract_string(payload, &["status"]).unwrap_or_else(|| "completed".to_string());
                let display = tool_display_metadata(&name, "customToolCall", &status, None, None);
                Some(SessionHydratedItem {
                    kind: SessionHydratedItemKind::ToolCall { call_id },
                    item: ConversationItem::ToolCall {
                        id,
                        title: name,
                        tool_kind: "customToolCall".to_string(),
                        status,
                        output: None,
                        exit_code: None,
                        display: Box::new(display),
                        detail: None,
                        created_at,
                        completed_at: None,
                    },
                })
            }
            _ => None,
        },
        _ => None,
    }
}

fn session_tool_call_output(
    value: &Value,
) -> Option<(String, Option<String>, chrono::DateTime<Utc>)> {
    let payload = value.get("payload")?;
    if value.get("type").and_then(Value::as_str) != Some("response_item")
        || payload.get("type").and_then(Value::as_str) != Some("custom_tool_call_output")
    {
        return None;
    }

    let call_id = extract_string(payload, &["call_id", "callId"])?;
    let output = payload.get("output").and_then(session_tool_output_text);
    let completed_at =
        extract_datetime_or_timestamp(value, &["timestamp", "createdAt", "created_at"])
            .unwrap_or_else(Utc::now);
    Some((call_id, output, completed_at))
}

fn session_tool_output_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        let text = text.trim();
        return (!text.is_empty()).then(|| text.to_string());
    }

    let text = value
        .as_array()?
        .iter()
        .filter_map(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("text").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn apply_session_tool_call_output(
    item: &mut ConversationItem,
    output: Option<String>,
    completed_at: chrono::DateTime<Utc>,
) {
    let ConversationItem::ToolCall {
        title,
        tool_kind,
        status,
        output: existing_output,
        exit_code,
        display,
        completed_at: existing_completed_at,
        ..
    } = item
    else {
        return;
    };

    *status = "completed".to_string();
    *existing_output = output;
    *existing_completed_at = Some(completed_at);
    **display = tool_display_metadata(
        title,
        tool_kind,
        status,
        *exit_code,
        existing_output.as_deref(),
    );
    sanitize_conversation_item(item);
}

fn session_response_timestamps(
    items: &[SessionHydratedItem],
) -> HashMap<String, Vec<chrono::DateTime<Utc>>> {
    let mut timestamps = HashMap::<String, Vec<chrono::DateTime<Utc>>>::new();
    for item in items {
        if matches!(
            item.kind,
            SessionHydratedItemKind::AssistantMessageFromResponse
        ) && let ConversationItem::AssistantMessage {
            text, created_at, ..
        } = &item.item
        {
            timestamps
                .entry(normalized_session_message(text))
                .or_default()
                .push(*created_at);
        }
    }
    for times in timestamps.values_mut() {
        times.sort_unstable();
    }
    timestamps
}

fn should_keep_session_hydrated_item(
    candidate: &SessionHydratedItem,
    response_timestamps: &HashMap<String, Vec<chrono::DateTime<Utc>>>,
) -> bool {
    match candidate.kind {
        SessionHydratedItemKind::AssistantMessageFromEvent => {
            let ConversationItem::AssistantMessage {
                text: candidate_text,
                created_at: candidate_created_at,
                ..
            } = &candidate.item
            else {
                return true;
            };

            let Some(times) = response_timestamps.get(&normalized_session_message(candidate_text))
            else {
                return true;
            };
            // Only the nearest response on either side can match. Indexing
            // timestamps also avoids scanning every repeated "Done" message
            // in long rollouts, while preserving the original second rounding.
            let next = times.partition_point(|created_at| created_at < candidate_created_at);
            !times
                .get(next)
                .into_iter()
                .chain(next.checked_sub(1).and_then(|index| times.get(index)))
                .any(|created_at| {
                    created_at
                        .signed_duration_since(*candidate_created_at)
                        .num_seconds()
                        .abs()
                        <= 5
                })
        }
        _ => true,
    }
}

fn normalized_session_message(text: &str) -> String {
    #[cfg(test)]
    SESSION_MESSAGE_NORMALIZATIONS.with(|count| count.set(count.get() + 1));
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
thread_local! {
    static SESSION_MESSAGE_NORMALIZATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use tempfile::NamedTempFile;

    fn refresh_fixture(
        native_id: &str,
        cwd: &str,
        entries: &[Value],
    ) -> (HydratedThread, Option<Value>) {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "session_meta", "payload": {"id": native_id, "cwd": cwd}
            })
        )
        .unwrap();
        for entry in entries {
            writeln!(file, "{entry}").unwrap();
        }
        let summary = parse_threads(
            "workspace",
            "/project",
            &json!({
                "data": [{"id": "thread", "cwd": "/project"}]
            }),
        )
        .remove(0)
        .summary;
        hydrate_thread_response_for_refresh(
            summary,
            &json!({"thread": {
                "id": "thread", "path": file.path(), "historyMode": "paginated", "turns": []
            }}),
            "/project",
        )
    }

    fn task_event(kind: &str, turn_id: &str) -> Value {
        json!({
            "timestamp": "2026-10-02T15:38:48.722Z",
            "type": "event_msg", "payload": {"type": kind, "turn_id": turn_id}
        })
    }

    #[test]
    fn large_rollout_normalizes_each_assistant_message_once() {
        const MESSAGES: usize = 512;
        let mut entries = Vec::new();
        for index in 0..MESSAGES {
            entries.push(json!({
                "timestamp": "2026-10-02T15:38:48.722Z", "type": "event_msg",
                "payload": {"id": format!("event-{index}"), "type": "agent_message",
                    "message": format!("Message\n  {index}")}
            }));
        }
        // Response records can be reordered; matching must not depend on the
        // relative position of the event and response in the rollout.
        for index in (0..MESSAGES).rev() {
            entries.push(json!({
                "timestamp": "2026-10-02T15:38:49.722Z", "type": "response_item",
                "payload": {"id": format!("response-{index}"), "type": "message",
                    "role": "assistant", "content": [{"type": "output_text",
                        "text": format!("Message {index}")}]}
            }));
        }

        SESSION_MESSAGE_NORMALIZATIONS.with(|count| count.set(0));
        let (hydrated, _) = refresh_fixture("thread", "/project", &entries);
        assert_eq!(hydrated.items.len(), MESSAGES);
        assert!(hydrated.items.iter().all(|item| matches!(item,
            ConversationItem::AssistantMessage { id, .. } if id.starts_with("response-"))));
        let normalizations = SESSION_MESSAGE_NORMALIZATIONS.with(std::cell::Cell::get);
        assert!(
            normalizations <= MESSAGES * 2,
            "normalized {normalizations} messages for {} records",
            MESSAGES * 2
        );
    }

    #[test]
    fn rollout_deduplication_preserves_repeated_text_and_timestamp_boundaries() {
        let timestamp = |offset_ms: i64| {
            chrono::DateTime::<Utc>::from_timestamp_millis(1_790_955_520_000 + offset_ms)
                .unwrap()
                .to_rfc3339()
        };
        let mut entries = vec![
            json!({"timestamp": timestamp(60_000), "type": "response_item",
                "payload": {"id": "later-response", "type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": "Done now"}]}}),
            json!({"timestamp": timestamp(0), "type": "response_item",
                "payload": {"id": "earlier-response", "type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": "Done now"}]}}),
        ];
        for offset_ms in [-6_000, -5_999, 0, 5_999, 6_000, 65_999] {
            entries.push(
                json!({"timestamp": timestamp(offset_ms), "type": "event_msg",
                "payload": {"id": format!("event-{offset_ms}"), "type": "agent_message",
                    "message": "\t Done \n now "}}),
            );
        }
        entries.push(json!({"timestamp": timestamp(0), "type": "event_msg",
            "payload": {"id": "different-text", "type": "agent_message", "message": "Done later"}}));

        let (hydrated, _) = refresh_fixture("thread", "/project", &entries);
        let ids = hydrated
            .items
            .iter()
            .filter_map(|item| match item {
                ConversationItem::AssistantMessage { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect::<HashSet<_>>();
        assert_eq!(
            ids,
            HashSet::from([
                "event--6000",
                "event-6000",
                "different-text",
                "earlier-response",
                "later-response",
            ])
        );
    }

    #[test]
    fn supplement_adds_each_missing_tool_once_and_preserves_native_tools() {
        let tool = |id: &str, call_id: &str, name: &str| {
            json!({
                "timestamp": "2026-10-02T15:38:48.722Z", "type": "response_item",
                "payload": {"id": id, "type": "custom_tool_call", "call_id": call_id, "name": name}
            })
        };
        let mut file = NamedTempFile::new().unwrap();
        writeln!(
            file,
            "{}",
            json!({"type": "session_meta", "payload": {"cwd": "/project"}})
        )
        .unwrap();
        for entry in [
            tool("shared", "shared-call", "Rollout copy"),
            tool("missing", "missing-call-1", "First missing"),
            tool("missing", "missing-call-2", "Duplicate missing"),
        ] {
            writeln!(file, "{entry}").unwrap();
        }
        let mut items = vec![
            build_session_hydrated_item_from_entry(&tool("shared", "shared-call", "Native original")).unwrap().item,
            build_session_hydrated_item_from_entry(&json!({
                "timestamp": "2026-10-02T15:38:48.722Z", "type": "event_msg",
                "payload": {"id": "missing", "type": "agent_message", "message": "Same id, another kind"}
            })).unwrap().item,
        ];
        supplement_thread_items_with_session_tool_calls(
            &mut items,
            file.path().to_str().unwrap(),
            "/project",
        );
        assert_eq!(items.len(), 3);
        assert!(items.iter().any(|item| matches!(item,
            ConversationItem::ToolCall { id, title, .. } if id == "shared" && title == "Native original")));
        assert!(items.iter().any(|item| matches!(item,
            ConversationItem::ToolCall { id, title, .. } if id == "missing" && title == "First missing")));
    }

    #[test]
    fn native_refresh_restores_complete_rollout_and_final_answer_together() {
        let mut completed = task_event("task_complete", "turn-1");
        completed["payload"]["completed_at"] = json!(1790955528);
        let (hydrated, turn) = refresh_fixture(
            "thread",
            "/project",
            &[
                task_event("task_started", "turn-1"),
                json!({
                    "timestamp": "2026-10-02T15:38:48.625Z", "type": "response_item",
                    "payload": {"id": "final-1", "type": "message", "role": "assistant",
                        "phase": "final_answer", "content": [{"type": "output_text",
                            "text": "Committed bd3bafc080."}]}
                }),
                completed,
            ],
        );
        let turn = turn.unwrap();
        assert_eq!(turn["id"], "turn-1");
        assert_eq!(turn["status"], "completed");
        assert_eq!(hydrated.summary.status, ThreadStatus::Idle);
        assert_eq!(hydrated.summary.latest_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(hydrated.summary.updated_at.timestamp(), 1790955528);
        assert_eq!(
            hydrated.summary.last_message_preview.as_deref(),
            Some("Committed bd3bafc080.")
        );
        assert!(
            matches!(&hydrated.items[..], [ConversationItem::AssistantMessage {id, text, ..}]
            if id == "final-1" && text == "Committed bd3bafc080.")
        );
    }

    #[test]
    fn native_refresh_does_not_apply_previous_completion_to_a_new_turn() {
        for start in [
            task_event("task_started", "turn-2"),
            json!({"type": "turn_context", "payload": {"turn_id": "turn-2", "cwd": "/project"}}),
        ] {
            let (hydrated, turn) = refresh_fixture(
                "thread",
                "/project",
                &[
                    task_event("task_started", "turn-1"),
                    task_event("task_complete", "turn-1"),
                    start,
                    task_event("task_complete", "turn-1"),
                ],
            );
            let turn = turn.unwrap();
            assert_eq!(turn["id"], "turn-2");
            assert_eq!(turn["status"], "inProgress");
            assert!(turn.get("completedAt").is_none());
            assert_eq!(hydrated.summary.status, ThreadStatus::Running);
        }
    }

    #[test]
    fn native_refresh_requires_matching_start_and_completion_ids() {
        let (_, unmatched) = refresh_fixture(
            "thread",
            "/project",
            &[
                task_event("task_started", "turn-1"),
                task_event("task_complete", "other-turn"),
            ],
        );
        assert_eq!(unmatched.unwrap()["status"], "inProgress");
        let (_, without_start) = refresh_fixture(
            "thread",
            "/project",
            &[task_event("task_complete", "turn-1")],
        );
        assert!(without_start.is_none());
    }

    #[test]
    fn native_refresh_rejects_wrong_rollout_thread_or_workspace() {
        for (native_id, cwd) in [("other-thread", "/project"), ("thread", "/other-project")] {
            let (hydrated, turn) = refresh_fixture(
                native_id,
                cwd,
                &[
                    task_event("task_started", "turn-1"),
                    task_event("task_complete", "turn-1"),
                ],
            );
            assert!(hydrated.items.is_empty());
            assert!(turn.is_none());
            assert!(hydrated.summary.latest_turn_id.is_none());
        }
    }

    #[test]
    fn native_refresh_uses_outer_timestamp_for_matching_abort() {
        let (_, turn) = refresh_fixture(
            "thread",
            "/project",
            &[
                task_event("task_started", "turn-1"),
                task_event("turn_aborted", "turn-1"),
            ],
        );
        let turn = turn.unwrap();
        assert_eq!(turn["status"], "interrupted");
        assert_eq!(turn["completedAt"], "2026-10-02T15:38:48.722+00:00");
    }

    #[test]
    fn bounded_line_reader_discards_oversized_records_and_continues() {
        let mut input = vec![b'x'; MAX_SESSION_LINE_BYTES + 1];
        input.extend_from_slice(b"\nkept\nlast");
        let mut reader = Cursor::new(input);
        let mut visited = Vec::new();

        visit_bounded_lines(&mut reader, |line| {
            visited.push(String::from_utf8(line.to_vec()).unwrap());
            true
        })
        .unwrap();

        assert_eq!(visited, ["kept", "last"]);
    }

    #[test]
    fn bounded_line_reader_honors_early_stop() {
        let mut reader = Cursor::new(b"first\nsecond\nthird\n".to_vec());
        let mut visited = Vec::new();

        visit_bounded_lines(&mut reader, |line| {
            visited.push(String::from_utf8(line.to_vec()).unwrap());
            false
        })
        .unwrap();

        assert_eq!(visited, ["first"]);
    }
}
