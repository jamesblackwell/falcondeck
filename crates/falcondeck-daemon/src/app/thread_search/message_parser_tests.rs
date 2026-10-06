use super::*;
use serde_json::Value;

/// The old Value-based extraction is kept only as a differential test oracle.
/// Both paths use the production text cleaner, including harness filtering.
fn legacy_message(value: &Value) -> Option<String> {
    match value.get("type").and_then(Value::as_str)? {
        "user" => {
            if value.get("isSidechain").and_then(Value::as_bool) == Some(true)
                || value.get("isMeta").and_then(Value::as_bool) == Some(true)
            {
                return None;
            }
            let content = value
                .get("message")
                .and_then(|message| message.get("content"))
                .or_else(|| value.get("content"))?;
            if let Some(text) = content.as_str() {
                return super::super::clean_message(text);
            }
            let mut parts = Vec::new();
            for block in content.as_array()? {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    return None;
                }
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text);
                }
            }
            super::super::clean_message(&parts.join("\n"))
        }
        "event_msg" => {
            let payload = value.get("payload")?;
            if payload.get("type").and_then(Value::as_str) != Some("user_message") {
                return None;
            }
            super::super::clean_message(payload.get("message").and_then(Value::as_str)?)
        }
        "response_item" => {
            let payload = value.get("payload")?;
            if payload.get("type").and_then(Value::as_str) != Some("message")
                || payload.get("role").and_then(Value::as_str) != Some("user")
            {
                return None;
            }
            let mut parts = Vec::new();
            for block in payload.get("content")?.as_array()? {
                if block.get("type").and_then(Value::as_str) != Some("input_text") {
                    continue;
                }
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text);
                }
            }
            super::super::clean_message(&parts.join("\n"))
        }
        _ => None,
    }
}

fn assert_parity(line: &str) {
    let legacy = serde_json::from_str::<Value>(line);
    let projected = serde_json::from_str::<MessageValue>(line);
    assert_eq!(legacy.is_ok(), projected.is_ok(), "validation: {line}");
    let legacy_text = legacy.ok().as_ref().and_then(legacy_message);
    let projected_text = projected
        .ok()
        .as_ref()
        .and_then(super::super::user_message_text);
    assert_eq!(legacy_text, projected_text, "extraction: {line}");
}

#[test]
fn matches_claude_grok_and_codex_envelopes() {
    for line in [
        r#"{"type":"user","content":"Grok"}"#,
        r#"{"content":"Grok","type":"user"}"#,
        r#"{"message":{"content":"Claude"},"type":"user"}"#,
        r#"{"type":"user","content":[{"text":"untyped"},{"type":"image","text":"accepted before"}]}"#,
        r#"{"type":"user","content":[null,42,false,"skip",{"text":false},{"text":"yes"}]}"#,
        r#"{"type":"user","content":[]}"#,
        r#"{"type":"user","content":{}}"#,
        r#"{"type":"event_msg","payload":{"type":"user_message","message":"Codex"}}"#,
        r#"{"payload":{"message":"Codex","type":"user_message"},"type":"event_msg"}"#,
        r#"{"type":"event_msg","payload":{"type":"agent_message","message":"hidden"}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"one"},{"type":"input_image","text":"skip"},{"text":"skip"},{"text":"two","type":"input_text"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hidden"}]}}"#,
        r#"{"type":"user","content":"hidden","isSidechain":true}"#,
        r#"{"type":"user","content":"hidden","isMeta":true}"#,
        r#"{"type":"user","content":"visible","isMeta":"true"}"#,
        r#"{"type":"user","content":"visible","isSidechain":null}"#,
    ] {
        assert_parity(line);
    }
}

#[test]
fn preserves_last_duplicate_and_nested_content_precedence() {
    for line in [
        r#"{"type":"user","message":{"content":"nested"},"content":"fallback"}"#,
        r#"{"type":"user","message":null,"content":"fallback"}"#,
        r#"{"type":"user","message":{"content":null},"content":"masked"}"#,
        r#"{"type":"user","message":{"content":false},"content":"masked"}"#,
        r#"{"type":"user","content":"first","content":"last"}"#,
        r#"{"type":"user","content":"first","content":null}"#,
        r#"{"type":"assistant","type":"user","content":"last"}"#,
        r#"{"type":"user","type":"assistant","content":"hidden"}"#,
        r#"{"type":"user","message":{"content":"first","content":"last"}}"#,
        r#"{"type":"user","isMeta":true,"isMeta":false,"content":"visible"}"#,
        r#"{"type":"user","content":[{"type":"tool_result","type":"text","text":"visible"}]}"#,
    ] {
        assert_parity(line);
    }
}

#[test]
fn rejects_tool_results_even_when_text_comes_first() {
    for line in [
        r#"{"type":"user","content":[{"text":"visible"},{"type":"tool_result"}]}"#,
        r#"{"type":"user","content":[{"type":"tool_result"},{"text":"visible"}]}"#,
        r#"{"message":{"content":[{"text":"visible","type":"tool_result"}]},"type":"user"}"#,
    ] {
        assert_parity(line);
        let value: MessageValue = serde_json::from_str(line).unwrap();
        assert_eq!(super::super::user_message_text(&value), None);
    }
}

#[test]
fn preserves_escaped_keys_unicode_and_harness_cleaning() {
    let prompts = [
        "fix\n\t login 😀 café 東京",
        "<system-reminder>ignore me</system-reminder>",
        "<system-reminder>ignore me</system-reminder>Fix login",
        "<system-reminder>FalconDeck resume: Continue the work.</system-reminder>",
        "<system-reminder>FalconDeck retry: Continue the work.</system-reminder>",
        "<system-reminder>Background task \"fixture\" completed (exit code: 1). Command: cargo test | Duration: 0.4s</system-reminder>",
        "# AGENTS.md instructions for /fixture/project",
        "<environment_context>injected</environment_context><user_query>Real request</user_query>",
        "<falcondeck-handoff-context>quoted transcript</falcondeck-handoff-context>new request",
        "Use the FalconDeck skill defined at /fixture/SKILL.md. Follow it as the governing skill for this request. Fix login",
        "# Files mentioned by the user:\n\n## clip.png: /fixture/clip.png\n\n## My request for Codex:\nfix the image preview",
        "# Files pasted by the user:\n\n## file.txt: /fixture/file.txt\n\n## My request:\n",
        "don&#39;t &amp; won&#x27;t [banner](https://fixture.test) &#x20;",
        "<system-reminder>partial",
        "",
        "   \n\t  ",
    ];
    for prompt in prompts {
        let escaped = serde_json::to_string(prompt).unwrap();
        assert_parity(&format!(
            r#"{{"ty\u0070e":"user","con\u0074ent":{escaped}}}"#
        ));
    }
    assert_parity(
        &serde_json::json!({
            "type": "user",
            "content": falcondeck_core::control::automation_user_text("Check the build"),
        })
        .to_string(),
    );
    assert_parity(
        r#"{"type":"user","content":"escaped\ntext \uD83D\uDE00","unknown":{"\u0074ext":"not indexed"}}"#,
    );
    assert_parity(&serde_json::json!({"type":"user", "content":"😀".repeat(500)}).to_string());
}

#[test]
fn matches_value_validation_for_discarded_fields() {
    for line in [
        r#"{"type":"user","content":"valid","unknown":1e999}"#,
        r#"{"type":"user","content":"valid","unknown":"\uD800"}"#,
        r#"{"type":"user","content":"valid","unknown":{"a":"\uD800"}}"#,
        r#"{"type":"user","content":"valid","unknown":{"\uD800":"bad key"}}"#,
        r#"{"type":"user","content":"valid","unknown":[false,null,1.5,"fine"]}"#,
        r#"{"type":"user","content":"valid","unknown":18446744073709551616}"#,
        r#"{"type":"user","content":"valid","unknown":-9223372036854775809}"#,
        r#"{"type":"user","content":"valid","unknown":1e308}"#,
        r#"{"type":"user","content":"valid","unknown":-0.0}"#,
        r#"{"type":"user","content":"valid","unknown":NaN}"#,
        r#"{"type":"user","content":"valid","unknown":01}"#,
        r#"{"type":"user","content":"valid","unknown":[1,]}"#,
        r#"{"type":"user","content":"valid"} garbage"#,
        r#"{"type":"user","content":"unterminated"#,
        "[]",
        "false",
        "42",
        "null",
    ] {
        assert_parity(line);
    }
    for depth in [1, 125, 126, 127, 128, 150] {
        let nested = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        assert_parity(&format!(
            r#"{{"type":"user","content":"yes","unknown":{nested}}}"#
        ));
        assert_parity(&format!(r#"{{"type":"user","content":{nested}}}"#));
    }
}

#[test]
fn line_extraction_preserves_whitespace_and_duplicate_suppression() {
    let line = " \t{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"fix login\"}}\n";
    let text = "fix login".to_owned();
    assert_eq!(
        super::super::user_message_text_from_line(line, None),
        Some(text.clone())
    );
    assert_eq!(
        super::super::user_message_text_from_line(line, Some(&text)),
        None
    );
    for invalid in ["", " ", "prefix {}", "{\"type\":\"user\",\"content\":"] {
        assert_eq!(
            super::super::user_message_text_from_line(invalid, None),
            None
        );
    }
}

fn owned_text_bytes(value: &MessageValue<'_>) -> usize {
    match value {
        MessageValue::String(Cow::Owned(text)) => text.len(),
        MessageValue::Array(values) => values.iter().map(owned_text_bytes).sum(),
        MessageValue::Object(fields) => fields
            .iter()
            .map(|(_, value)| owned_text_bytes(value))
            .sum(),
        _ => 0,
    }
}

#[test]
fn borrows_unescaped_strings_and_owns_decoded_escapes() {
    let line = r#"{"type":"user","message":{"content":"fix login"},"text":"escaped\ntext"}"#;
    let value: MessageValue = serde_json::from_str(line).unwrap();
    let content = value.get("message").unwrap().get("content").unwrap();
    assert!(matches!(
        content,
        MessageValue::String(Cow::Borrowed("fix login"))
    ));
    let text = value.get("text").unwrap();
    assert!(matches!(text, MessageValue::String(Cow::Owned(text)) if text == "escaped\ntext"));
    assert_eq!(owned_text_bytes(&value), "escaped\ntext".len());
}

#[test]
fn does_not_retain_large_unknown_image_or_tool_payloads() {
    let payload = "A".repeat(1024 * 1024);
    let lines = [
        format!(r#"{{"type":"assistant","message":{{"content":"{payload}"}}}}"#),
        format!(
            r#"{{"message":{{"content":[{{"content":"{payload}","type":"tool_result"}}]}},"type":"user"}}"#
        ),
        format!(
            r#"{{"type":"user","content":[{{"source":{{"data":"{payload}"}},"type":"image"}},{{"text":"fix login","type":"text"}}]}}"#
        ),
        format!(r#"{{"type":"user","content":"fix login","unknown":{{"text":"{payload}"}}}}"#),
    ];
    for line in lines {
        let value: MessageValue = serde_json::from_str(&line).unwrap();
        assert_eq!(owned_text_bytes(&value), 0);
        assert!(value.get("unknown").is_none());
        assert_parity(&line);
    }
    let escaped_payload = "line\\n".repeat(128 * 1024);
    let line = format!(r#"{{"type":"user","content":"fix login","unknown":"{escaped_payload}"}}"#);
    let value: MessageValue = serde_json::from_str(&line).unwrap();
    assert_eq!(owned_text_bytes(&value), 0);
    assert_eq!(
        super::super::user_message_text(&value),
        Some("fix login".to_owned())
    );
}
