//! Bounds model-facing FalconDeck MCP output, including structured content.
use serde_json::{Value, json};

/// About 10k tokens using the review's measured 2.43 characters/token. Bytes
/// make this more conservative for non-ASCII output; this is not a tokenizer.
pub(crate) const MAX_OUTPUT_BYTES: usize = 24_000;
const MARKER: &str = "\n\n[FalconDeck: tool output truncated; middle omitted. Request a narrower range or filter for the missing detail.]\n\n";

fn head_tail(text: &str, budget: usize) -> String {
    if text.len() <= budget {
        return text.to_owned();
    }
    let remaining = budget - MARKER.len();
    let mut head = remaining / 2;
    let mut tail = text.len() - (remaining - head);
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}{MARKER}{}", &text[..head], &text[tail..])
}

/// Keep small structured responses intact. For oversized ones, return a
/// bounded preview instead of also leaking the full value in structuredContent.
/// The explicit marker prevents a partial JSON excerpt being mistaken for data.
pub(crate) fn bounded_tool_value(value: Value) -> Value {
    let serialized = value.to_string();
    if serialized.len() <= MAX_OUTPUT_BYTES {
        return value;
    }
    let mut budget = MAX_OUTPUT_BYTES - 256;
    loop {
        let preview = head_tail(&serialized, budget);
        let result = json!({ "ok": value.get("ok").and_then(Value::as_bool).unwrap_or(true),
            "truncated": true, "original_bytes": serialized.len(), "preview": preview });
        if result.to_string().len() <= MAX_OUTPUT_BYTES {
            return result;
        }
        // Escaping the excerpt can expand it (quotes, control characters).
        budget /= 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_small_structured_results_and_errors() {
        for value in [
            json!({"ok": true, "result": [1,2,3]}),
            json!({"ok": false, "error": "denied"}),
        ] {
            assert_eq!(bounded_tool_value(value.clone()), value);
        }
    }
    #[test]
    fn large_results_keep_both_ends_and_cannot_bypass_via_structured_content() {
        for middle in ["x".repeat(40_000), "😀\n\"".repeat(20_000)] {
            let value = json!({"ok": false, "result": format!("HEAD{middle}TAIL")});
            let bounded = bounded_tool_value(value);
            assert_eq!(bounded["ok"], false);
            assert_eq!(bounded["truncated"], true);
            let preview = bounded["preview"].as_str().unwrap();
            assert!(preview.contains("HEAD"));
            assert!(preview.contains("TAIL"));
            assert!(preview.contains("middle omitted"));
            assert!(bounded.to_string().len() <= MAX_OUTPUT_BYTES);
        }
    }
    #[test]
    fn utf8_excerpt_respects_budget() {
        let text = "界".repeat(20_000);
        let result = head_tail(&text, MAX_OUTPUT_BYTES);
        assert!(result.len() <= MAX_OUTPUT_BYTES);
        assert!(result.starts_with('界') && result.ends_with('界'));
    }
}
