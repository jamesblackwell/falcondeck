//! Stream-json protocol helpers for the Claude CLI runner.
//!
//! The CLI emits NDJSON on stdout. Several of these behaviours are not in
//! public docs; they were confirmed against Claude Code 2.1.238 and against
//! RepoPrompt CE's battle-tested decoder.

use falcondeck_core::{ThreadTokenUsage, TokenUsageBreakdown};
use serde_json::{Value, json};

/// One decoded stdout record from `claude --output-format stream-json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaudeStreamLine {
    KeepAlive,
    ControlRequest {
        request_id: String,
        subtype: String,
        request: Value,
    },
    ControlResponse {
        request_id: String,
        subtype: String,
        error: Option<String>,
        pending_permission_requests: Vec<Value>,
    },
    ControlCancelRequest {
        request_id: String,
    },
    Payload(Value),
}

/// JSON-string-aware NDJSON splitter.
///
/// A raw newline inside a JSON string value must not end the record. Quote
/// tracking is only armed when the line starts with `{` or `[`, so a
/// non-JSON dump that happens to contain quotes still splits on `\n`.
pub(crate) struct ClaudeNdjsonFramer {
    carry: Vec<u8>,
    in_string: bool,
    escaping: bool,
    json_candidate: bool,
    seen_start: bool,
}

impl ClaudeNdjsonFramer {
    const MAX_CARRY: usize = 16 * 1024 * 1024;
    const TAIL_RETAIN: usize = 128 * 1024;

    pub(crate) fn new() -> Self {
        Self {
            carry: Vec::new(),
            in_string: false,
            escaping: false,
            json_candidate: false,
            seen_start: false,
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        for &byte in chunk {
            if !self.seen_start && !is_ascii_whitespace(byte) {
                self.seen_start = true;
                self.json_candidate = byte == b'{' || byte == b'[';
                if !self.json_candidate {
                    self.in_string = false;
                    self.escaping = false;
                }
            }

            let split = if self.json_candidate {
                match byte {
                    b'"' => {
                        if self.in_string {
                            if self.escaping {
                                self.escaping = false;
                            } else {
                                self.in_string = false;
                            }
                        } else {
                            self.in_string = true;
                        }
                        false
                    }
                    b'\\' if self.in_string => {
                        self.escaping = !self.escaping;
                        false
                    }
                    b'\n' if self.in_string => {
                        self.escaping = false;
                        false
                    }
                    b'\n' => true,
                    _ => {
                        if self.in_string && self.escaping {
                            self.escaping = false;
                        }
                        false
                    }
                }
            } else {
                byte == b'\n'
            };

            if split {
                lines.push(take_line(&mut self.carry));
                self.reset_line_state();
            } else {
                self.carry.push(byte);
            }
        }
        self.enforce_limits();
        lines
    }

    pub(crate) fn flush(&mut self) -> Option<String> {
        if self.carry.is_empty() {
            self.reset_line_state();
            return None;
        }
        let line = take_line(&mut self.carry);
        self.reset_line_state();
        (!line.is_empty()).then_some(line)
    }

    fn reset_line_state(&mut self) {
        self.in_string = false;
        self.escaping = false;
        self.json_candidate = false;
        self.seen_start = false;
    }

    fn enforce_limits(&mut self) {
        if self.carry.len() <= Self::MAX_CARRY {
            return;
        }
        let retain = Self::TAIL_RETAIN.min(self.carry.len());
        let dropped = self.carry.len() - retain;
        tracing::warn!(
            dropped,
            retained = retain,
            "claude NDJSON framer overflow; dropping prefix"
        );
        self.carry.drain(..dropped);
        self.reset_line_state();
    }
}

fn take_line(carry: &mut Vec<u8>) -> String {
    if carry.last() == Some(&b'\r') {
        carry.pop();
    }
    let line = String::from_utf8_lossy(carry).into_owned();
    carry.clear();
    line
}

fn is_ascii_whitespace(byte: u8) -> bool {
    matches!(byte, b'\t' | b'\n' | 0x0B | 0x0C | b'\r' | b' ')
}

/// Decode one framed line into zero or more protocol records.
///
/// Undecodable input yields an empty vec — a bad line must never kill the
/// run. Recovery tries, in order: control-character sanitization inside
/// strings; brace-depth splitting of concatenated objects; scanning the tail
/// for an embedded `{"type":`.
pub(crate) fn parse_claude_stream_lines(line: &str) -> Vec<ClaudeStreamLine> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if let Some(value) = decode_json_object(trimmed) {
        return vec![classify_stream_value(value)];
    }
    let concatenated = split_concatenated_json_objects(trimmed);
    if concatenated.len() > 1 {
        let recovered: Vec<_> = concatenated
            .into_iter()
            .filter_map(|segment| decode_json_object(&segment).map(classify_stream_value))
            .collect();
        if !recovered.is_empty() {
            tracing::debug!(
                recovered = recovered.len(),
                "recovered concatenated Claude stream objects"
            );
            return recovered;
        }
    }
    if let Some(tail) = embedded_json_tail(trimmed)
        && let Some(value) = decode_json_object(tail)
    {
        tracing::debug!("recovered Claude stream object after garbage prefix");
        return vec![classify_stream_value(value)];
    }
    tracing::debug!("ignored unparseable Claude stream line");
    Vec::new()
}

fn classify_stream_value(value: Value) -> ClaudeStreamLine {
    match value.get("type").and_then(Value::as_str) {
        Some("keep_alive") => ClaudeStreamLine::KeepAlive,
        Some("control_request") => {
            let request_id = json_string(&value, "request_id").unwrap_or_default();
            let request = value.get("request").cloned().unwrap_or(Value::Null);
            let subtype = request
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            ClaudeStreamLine::ControlRequest {
                request_id,
                subtype,
                request,
            }
        }
        Some("control_response") => {
            let envelope = value.get("response").cloned().unwrap_or(Value::Null);
            ClaudeStreamLine::ControlResponse {
                request_id: json_string(&envelope, "request_id").unwrap_or_default(),
                subtype: json_string(&envelope, "subtype").unwrap_or_default(),
                error: json_string(&envelope, "error"),
                pending_permission_requests: envelope
                    .get("pending_permission_requests")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned()
                    .collect(),
            }
        }
        Some("control_cancel_request") => ClaudeStreamLine::ControlCancelRequest {
            request_id: json_string(&value, "request_id").unwrap_or_default(),
        },
        _ => ClaudeStreamLine::Payload(value),
    }
}

fn decode_json_object(text: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(text) {
        Ok(value) if value.is_object() => Some(value),
        Ok(_) => None,
        Err(_) => {
            let sanitized = sanitize_json_control_characters(text)?;
            match serde_json::from_str::<Value>(&sanitized) {
                Ok(value) if value.is_object() => Some(value),
                _ => None,
            }
        }
    }
}

/// Re-escape raw control characters that appear inside JSON string values.
fn sanitize_json_control_characters(raw: &str) -> Option<String> {
    let mut output = String::with_capacity(raw.len() + 8);
    let mut in_string = false;
    let mut escaping = false;
    let mut did_sanitize = false;
    for ch in raw.chars() {
        if in_string {
            if escaping {
                output.push(ch);
                escaping = false;
                continue;
            }
            match ch {
                '\\' => {
                    output.push(ch);
                    escaping = true;
                }
                '"' => {
                    output.push(ch);
                    in_string = false;
                }
                c if (c as u32) < 0x20 => {
                    output.push_str(&format!("\\u{:04x}", c as u32));
                    did_sanitize = true;
                }
                c => output.push(c),
            }
        } else {
            output.push(ch);
            if ch == '"' {
                in_string = true;
            }
        }
    }
    did_sanitize.then_some(output)
}

fn split_concatenated_json_objects(text: &str) -> Vec<String> {
    let mut results = Vec::new();
    let mut start: Option<usize> = None;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaping = false;
    for (index, ch) in text.char_indices() {
        if start.is_none() {
            if ch == '{' {
                start = Some(index);
                depth = 1;
                in_string = false;
                escaping = false;
            }
            continue;
        }
        if in_string {
            if escaping {
                escaping = false;
            } else if ch == '\\' {
                escaping = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0
                    && let Some(from) = start
                {
                    let to = index + ch.len_utf8();
                    results.push(text[from..to].to_string());
                    start = None;
                }
            }
            _ => {}
        }
    }
    results
}

fn embedded_json_tail(text: &str) -> Option<&str> {
    let marker = "{\"type\":";
    let mut last = None;
    let mut from = 0;
    while let Some(offset) = text[from..].find(marker) {
        let abs = from + offset;
        last = Some(abs);
        from = abs + marker.len();
    }
    let start = last.filter(|&offset| offset > 0)?;
    Some(&text[start..])
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Error reply for an inbound `control_request`. Ignoring one stalls the CLI.
pub(crate) fn encode_control_response_error(request_id: &str, error: &str) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": request_id,
            "error": error
        }
    })
    .to_string()
}

/// Allow payload for `--permission-prompt-tool stdio`. Approvals stay on the
/// PreToolUse hook path; this documents the stdio wire shape (camelCase
/// `toolUseID` / `updatedInput` / `updatedPermissions`) so we do not invent a
/// snake_case reply if that protocol is ever re-enabled.
#[allow(dead_code)]
pub(crate) fn allow_permission_response_payload(
    pending_request: &Value,
    include_updated_permissions: bool,
) -> Value {
    let mut payload = json!({
        "behavior": "allow",
        "updatedInput": pending_request.get("input").cloned().unwrap_or_else(|| json!({}))
    });
    if include_updated_permissions
        && let Some(suggestions) = pending_request
            .get("permission_suggestions")
            .and_then(Value::as_array)
        && !suggestions.is_empty()
    {
        payload["updatedPermissions"] = Value::Array(suggestions.clone());
    }
    if let Some(tool_use_id) = pending_request
        .get("tool_use_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        payload["toolUseID"] = json!(tool_use_id);
    }
    payload
}

/// Unwrap `pending_permission_requests` that ride on a `control_response`
/// error envelope into synthetic `control_request` values.
pub(crate) fn synthetic_permission_requests(pending: &[Value]) -> Vec<ClaudeStreamLine> {
    pending
        .iter()
        .filter_map(|entry| {
            let request_id = json_string(entry, "request_id")?;
            let request = entry.get("request")?.clone();
            let subtype = request
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Some(ClaudeStreamLine::ControlRequest {
                request_id,
                subtype,
                request,
            })
        })
        .collect()
}

/// Live context snapshot from `message_start` / `message_delta` (and assistant
/// echoes). `result.usage` is a billed-turn aggregate and is rejected.
pub(crate) fn live_context_usage(value: &Value) -> Option<ClaudeLiveContextUsage> {
    if value.get("type").and_then(Value::as_str) == Some("result") {
        return None;
    }
    let event = value.get("event").unwrap_or(value);
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let usage = if event_type == "message_start" {
        event
            .get("message")
            .and_then(|message| message.get("usage"))
    } else if event_type == "message_delta" {
        event.get("usage")
    } else {
        value
            .get("message")
            .and_then(|message| message.get("usage"))
            .or_else(|| event.get("usage"))
    }?;
    parse_usage_object(usage)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClaudeLiveContextUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

impl ClaudeLiveContextUsage {
    pub(crate) fn context_used_tokens(self) -> u64 {
        self.input_tokens
            .saturating_add(self.cache_read_input_tokens)
            .saturating_add(self.cache_creation_input_tokens)
    }

    pub(crate) fn to_thread_usage(self, model_context_window: Option<u64>) -> ThreadTokenUsage {
        let cached = self
            .cache_read_input_tokens
            .saturating_add(self.cache_creation_input_tokens);
        ThreadTokenUsage {
            total: TokenUsageBreakdown {
                total_tokens: self.context_used_tokens(),
                input_tokens: self.input_tokens,
                cached_input_tokens: cached,
                output_tokens: self.output_tokens,
                reasoning_output_tokens: 0,
            },
            last: None,
            model_context_window,
            updated_at: Some(chrono::Utc::now()),
        }
    }
}

fn json_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        let number = value.as_f64()?;
        (number.is_finite() && number >= 0.0).then_some(number as u64)
    })
}

fn parse_usage_object(value: &Value) -> Option<ClaudeLiveContextUsage> {
    let count = |snake: &str, camel: &str| {
        value
            .get(snake)
            .or_else(|| value.get(camel))
            .and_then(json_u64)
    };
    let input = count("input_tokens", "inputTokens");
    let output = count("output_tokens", "outputTokens");
    let cache_read = count("cache_read_input_tokens", "cacheReadInputTokens");
    let cache_creation = count("cache_creation_input_tokens", "cacheCreationInputTokens");
    if input.is_none() && output.is_none() && cache_read.is_none() && cache_creation.is_none() {
        return None;
    }
    Some(ClaudeLiveContextUsage {
        input_tokens: input.unwrap_or(0),
        output_tokens: output.unwrap_or(0),
        cache_read_input_tokens: cache_read.unwrap_or(0),
        cache_creation_input_tokens: cache_creation.unwrap_or(0),
    })
}

pub(crate) fn result_model_context_window(value: &Value) -> Option<u64> {
    if value.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    let model_usage = value.get("modelUsage")?.as_object()?;
    model_usage.values().find_map(|entry| {
        entry
            .get("contextWindow")
            .or_else(|| entry.get("context_window"))
            .and_then(json_u64)
            .filter(|window| *window > 0)
    })
}

/// A `result` that is an interrupt/abort side-effect, not a real failure.
pub(crate) fn result_is_cancelled(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("result") {
        return false;
    }
    if cancelled_signal(value.get("subtype").and_then(Value::as_str))
        || cancelled_signal(value.get("stop_reason").and_then(Value::as_str))
        || cancelled_signal(value.get("result").and_then(Value::as_str))
    {
        return true;
    }
    value
        .get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|entry| match entry {
            Value::String(text) => cancelled_signal(Some(text)),
            Value::Object(object) => cancelled_signal(
                object
                    .get("message")
                    .or_else(|| object.get("error"))
                    .and_then(Value::as_str),
            ),
            _ => false,
        })
}

fn cancelled_signal(value: Option<&str>) -> bool {
    let Some(value) = value.map(str::trim).filter(|text| !text.is_empty()) else {
        return false;
    };
    let lowered = value.to_ascii_lowercase();
    lowered.contains("interrupt")
        || lowered.contains("cancel")
        || lowered.contains("aborted")
        || lowered.contains("request was aborted")
}

/// Startup-class `--resume` failures. Matching these lets the monitor drop
/// the dead session id so the next turn is not stuck retrying it.
pub(crate) fn is_resume_startup_failure(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    lowered.contains("no conversation found with session id")
        || lowered.contains("loadconversationforresume failed")
        || lowered.contains("session not found:")
        || lowered.contains("invalid session id")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn framer_does_not_split_on_newlines_inside_json_strings() {
        let mut framer = ClaudeNdjsonFramer::new();
        let chunk =
            b"{\"type\":\"assistant\",\"message\":\"hello\nworld\"}\n{\"type\":\"keep_alive\"}\n";
        let lines = framer.push(chunk);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("hello\nworld"));
        assert_eq!(lines[1], "{\"type\":\"keep_alive\"}");
    }

    #[test]
    fn framer_holds_a_partial_record_across_chunks() {
        let mut framer = ClaudeNdjsonFramer::new();
        assert!(framer.push(b"{\"type\":\"keep_al").is_empty());
        let lines = framer.push(b"ive\"}\n");
        assert_eq!(lines, vec!["{\"type\":\"keep_alive\"}".to_string()]);
    }

    #[test]
    fn keep_alive_is_a_tolerated_record() {
        let lines = parse_claude_stream_lines("{\"type\":\"keep_alive\"}");
        assert_eq!(lines, vec![ClaudeStreamLine::KeepAlive]);
    }

    #[test]
    fn unknown_control_request_is_classified_not_dropped() {
        let lines = parse_claude_stream_lines(
            r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"set_model"}}"#,
        );
        assert_eq!(
            lines,
            vec![ClaudeStreamLine::ControlRequest {
                request_id: "req-1".to_string(),
                subtype: "set_model".to_string(),
                request: json!({"subtype": "set_model"}),
            }]
        );
        let encoded = encode_control_response_error(
            "req-1",
            "Unsupported control request subtype: set_model",
        );
        let parsed: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(parsed["type"], "control_response");
        assert_eq!(parsed["response"]["subtype"], "error");
        assert_eq!(parsed["response"]["request_id"], "req-1");
    }

    #[test]
    fn pending_permission_requests_unwrap_from_control_response_error() {
        let lines = parse_claude_stream_lines(
            r#"{"type":"control_response","response":{"subtype":"error","request_id":"ctl-1","error":"busy","pending_permission_requests":[{"request_id":"perm-1","request":{"subtype":"can_use_tool","tool_use_id":"toolu_1","input":{"path":"a.rs"}}}]}}"#,
        );
        let ClaudeStreamLine::ControlResponse {
            pending_permission_requests,
            ..
        } = &lines[0]
        else {
            panic!("expected control_response, got {lines:?}");
        };
        let synthetic = synthetic_permission_requests(pending_permission_requests);
        assert_eq!(synthetic.len(), 1);
        assert_eq!(
            synthetic[0],
            ClaudeStreamLine::ControlRequest {
                request_id: "perm-1".to_string(),
                subtype: "can_use_tool".to_string(),
                request: json!({
                    "subtype": "can_use_tool",
                    "tool_use_id": "toolu_1",
                    "input": {"path": "a.rs"}
                }),
            }
        );
    }

    #[test]
    fn allow_response_echoes_updated_input_and_camel_case_tool_use_id() {
        let pending = json!({
            "tool_use_id": "toolu_read_1",
            "input": {"path": "Sources/App.swift"},
            "permission_suggestions": [{"type": "addRules", "rules": []}]
        });
        let once = allow_permission_response_payload(&pending, false);
        assert_eq!(once["behavior"], "allow");
        assert_eq!(once["toolUseID"], "toolu_read_1");
        assert_eq!(once["updatedInput"]["path"], "Sources/App.swift");
        assert!(once.get("updatedPermissions").is_none());

        let session = allow_permission_response_payload(&pending, true);
        assert!(session.get("updatedPermissions").is_some());
    }

    #[test]
    fn live_context_uses_message_start_not_result_usage() {
        let start = json!({
            "type": "stream_event",
            "event": {
                "type": "message_start",
                "message": {
                    "usage": {
                        "input_tokens": 4,
                        "output_tokens": 0,
                        "cache_read_input_tokens": 6,
                        "cache_creation_input_tokens": 2
                    }
                }
            }
        });
        let usage = live_context_usage(&start).unwrap();
        assert_eq!(usage.context_used_tokens(), 12);

        let float_start = json!({
            "type": "stream_event",
            "event": {
                "type": "message_start",
                "message": { "usage": { "inputTokens": 4.5, "cacheReadInputTokens": 6.25 } }
            }
        });
        assert_eq!(
            live_context_usage(&float_start).map(|usage| usage.context_used_tokens()),
            Some(10)
        );

        let result = json!({
            "type": "result",
            "usage": {
                "input_tokens": 400,
                "output_tokens": 50,
                "cache_read_input_tokens": 1000
            }
        });
        assert_eq!(live_context_usage(&result), None);
    }

    #[test]
    fn error_during_execution_with_abort_text_is_cancelled() {
        assert!(result_is_cancelled(&json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "errors": ["Request was aborted by user"]
        })));
        assert!(!result_is_cancelled(&json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "Something broke"
        })));
        assert!(result_is_cancelled(&json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "stop_reason": "cancelled"
        })));
    }

    #[test]
    fn resume_startup_failure_matches_cli_strings() {
        assert!(is_resume_startup_failure(
            "No conversation found with session ID: abc"
        ));
        assert!(is_resume_startup_failure("Session not found: abc"));
        assert!(is_resume_startup_failure(
            "loadConversationForResume failed (disk)"
        ));
        assert!(!is_resume_startup_failure(
            "Claude turn failed with exit code 1"
        ));
        assert!(
            !is_resume_startup_failure("session not found on server (code 404)"),
            "unrelated MCP 404s must not drop the native session id"
        );
    }

    #[test]
    fn concatenated_objects_and_garbage_prefix_are_recovered() {
        let lines = parse_claude_stream_lines(
            r#"{"type":"keep_alive"}{"type":"assistant","message":{"content":[]}}"#,
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], ClaudeStreamLine::KeepAlive);

        let lines = parse_claude_stream_lines(r#"garbage leading {"type":"keep_alive"}"#);
        assert_eq!(lines, vec![ClaudeStreamLine::KeepAlive]);
    }

    #[test]
    fn raw_control_characters_inside_strings_are_repaired() {
        let raw = "{\"type\":\"assistant\",\"message\":{\"content\":\"hello\u{0007}world\"}}";
        let lines = parse_claude_stream_lines(raw);
        match &lines[..] {
            [ClaudeStreamLine::Payload(value)] => {
                assert_eq!(value["type"], "assistant");
            }
            other => panic!("expected repaired payload, got {other:?}"),
        }
    }

    #[test]
    fn undecodable_lines_are_skipped() {
        assert!(parse_claude_stream_lines("not json at all").is_empty());
        assert!(parse_claude_stream_lines("{").is_empty());
    }
}
