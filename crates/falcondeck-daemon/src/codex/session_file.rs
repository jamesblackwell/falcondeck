use super::*;

pub(super) fn hydrate_thread_items_from_session_file(
    session_path: &str,
    workspace_path: &str,
) -> Vec<ConversationItem> {
    let file = match File::open(session_path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };
    let mut items: Vec<SessionHydratedItem> = Vec::new();
    let mut tool_calls_by_call_id: HashMap<String, usize> = HashMap::new();
    let mut matches_workspace = false;

    for line in StdBufReader::new(file).lines().map_while(Result::ok) {
        if line.len() > 512_000 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let entry_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if matches!(entry_type, "session_meta" | "turn_context")
            && let Some(cwd) = extract_cwd(&value)
        {
            matches_workspace = cwd == workspace_path;
            if !matches_workspace {
                return Vec::new();
            }
        }

        if !matches_workspace {
            continue;
        }

        if let Some((call_id, output, completed_at)) = session_tool_call_output(&value) {
            if let Some(index) = tool_calls_by_call_id.get(&call_id).copied() {
                apply_session_tool_call_output(&mut items[index].item, output, completed_at);
            }
            continue;
        }

        if let Some(item) = build_session_hydrated_item_from_entry(&value) {
            if let SessionHydratedItemKind::ToolCall { call_id } = &item.kind {
                tool_calls_by_call_id.insert(call_id.clone(), items.len());
            }
            items.push(item);
        }
    }

    let mut conversation_items = items
        .iter()
        .filter(|item| should_keep_session_hydrated_item(item, &items))
        .cloned()
        .map(|item| item.item)
        .collect::<Vec<_>>();
    conversation_items.sort_by_key(conversation_item_created_at);
    conversation_items
}

pub(super) fn supplement_thread_items_with_session_tool_calls(
    items: &mut Vec<ConversationItem>,
    session_path: &str,
    workspace_path: &str,
) {
    let session_items = hydrate_thread_items_from_session_file(session_path, workspace_path);
    for session_item in session_items {
        let ConversationItem::ToolCall { id, .. } = &session_item else {
            continue;
        };
        let already_present = items.iter().any(
            |item| matches!(item, ConversationItem::ToolCall { id: existing_id, .. } if existing_id == id),
        );
        if !already_present {
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
            "agent_message" => Some(SessionHydratedItem {
                kind: SessionHydratedItemKind::AssistantMessageFromEvent,
                item: ConversationItem::AssistantMessage {
                    id: extract_string(payload, &["id"]).unwrap_or_else(|| {
                        format!("session-agent-{}", created_at.timestamp_millis())
                    }),
                    text: extract_string(payload, &["message"]).unwrap_or_default(),
                    phase: None,
                    memory_citation: None,
                    citations: Vec::new(),
                    lifecycle: ContentLifecycle::Complete,
                    created_at,
                },
            }),
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
                            ConversationItem::AssistantMessage {
                                id: extract_string(payload, &["id"]).unwrap_or_else(|| {
                                    format!("response-assistant-{}", created_at.timestamp_millis())
                                }),
                                text,
                                phase,
                                memory_citation,
                                citations: Vec::new(),
                                lifecycle: ContentLifecycle::Complete,
                                created_at,
                            }
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
                    summary: payload
                        .get("summary")
                        .and_then(Value::as_array)
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::trim)
                                .filter(|part| !part.is_empty())
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .filter(|summary| !summary.is_empty()),
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

fn should_keep_session_hydrated_item(
    candidate: &SessionHydratedItem,
    all_items: &[SessionHydratedItem],
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

            !all_items.iter().any(|existing| {
                matches!(
                    existing.kind,
                    SessionHydratedItemKind::AssistantMessageFromResponse
                ) && matches!(&existing.item, ConversationItem::AssistantMessage {
                    text,
                    created_at,
                    ..
                } if normalized_session_message(text) == normalized_session_message(candidate_text)
                    && created_at
                        .signed_duration_since(*candidate_created_at)
                        .num_seconds()
                        .abs()
                        <= 5)
            })
        }
        _ => true,
    }
}

fn normalized_session_message(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
