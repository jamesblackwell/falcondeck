use super::*;

pub(super) fn hydrate_thread_items_from_session_file(
    session_path: &str,
    workspace_path: &str,
) -> Vec<ConversationItem> {
    let file = match File::open(session_path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };
    let mut items = Vec::new();
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

        if matches!(entry_type, "session_meta" | "turn_context") {
            if let Some(cwd) = extract_cwd(&value) {
                matches_workspace = cwd == workspace_path;
                if !matches_workspace {
                    return Vec::new();
                }
            }
        }

        if !matches_workspace {
            continue;
        }

        if let Some(item) = build_session_hydrated_item_from_entry(&value) {
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

#[derive(Clone)]
enum SessionHydratedItemKind {
    UserMessage,
    AssistantMessageFromEvent,
    AssistantMessageFromResponse,
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
                        item: ConversationItem::AssistantMessage {
                            id: extract_string(payload, &["id"]).unwrap_or_else(|| {
                                format!("response-assistant-{}", created_at.timestamp_millis())
                            }),
                            text,
                            created_at,
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
                    created_at,
                },
            }),
            _ => None,
        },
        _ => None,
    }
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
