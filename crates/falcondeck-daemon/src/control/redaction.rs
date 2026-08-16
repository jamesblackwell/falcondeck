//! Structured redaction of secret-bearing values from model-facing output.
//!
//! Every response the control service returns to an agent passes through
//! [`redact_value`], which recursively replaces values under keys matching
//! known secret categories. Free-text automation instructions cannot be
//! reliably scanned, so the control surface additionally omits them from list
//! results and audit summaries rather than claiming they are clean.

use serde_json::Value;

/// Key fragments whose values are treated as secrets. Matched
/// case-insensitively against the final `_`-separated segment of each key so
/// `GMAIL_TOKEN`, `api_key` and `clientSecret` all match.
const SENSITIVE_KEY_SEGMENTS: [&str; 12] = [
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "access_key",
    "authorization",
    "cookie",
    "private_key",
    "client_secret",
    "credential",
    "session_key",
];

/// The placeholder substituted for redacted values.
pub const REDACTED: &str = "[REDACTED]";

/// Whether an object key marks its value as secret-bearing.
pub fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .rsplit(['_', '-', '/'])
        .next()
        .unwrap_or(key)
        .to_ascii_lowercase();
    SENSITIVE_KEY_SEGMENTS
        .iter()
        .any(|segment| normalized.contains(segment) || key.to_ascii_lowercase().contains(segment))
}

/// Recursively redacts secret-bearing values in place.
pub fn redact_value(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if is_sensitive_key(key) && !value.is_null() {
                    // Over-redaction is safe; under-redaction is not.
                    *value = Value::String(REDACTED.to_string());
                } else {
                    redact_value(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                redact_value(value);
            }
        }
        _ => {}
    }
}

/// Returns a redacted copy of a value.
pub fn redacted(mut value: Value) -> Value {
    redact_value(&mut value);
    value
}

/// Bounded preview for run records and audit summaries: trims to
/// `max_chars` UTF-8 characters on a char boundary.
pub fn bounded_preview(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.trim().to_string()
    } else {
        let truncated: String = text.chars().take(max_chars).collect();
        // Drop a trailing partial word so previews read cleanly.
        let trimmed = truncated.trim_end();
        format!("{}…", trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_known_secret_keys_recursively() {
        let mut value = json!({
            "name": "gmail",
            "enabled": true,
            "password": "hunter2",
            "GMAIL_TOKEN": "abc",
            "nested": {
                "clientSecret": "s",
                "api_key": ["k1", "k2"],
                "plain": "fine",
            },
            "items": [
                { "authorization": "Bearer x", "ok": 1 },
                { "type": "http", "url": "https://x" },
            ],
        });
        redact_value(&mut value);
        assert_eq!(value["password"], json!(REDACTED));
        assert_eq!(value["GMAIL_TOKEN"], json!(REDACTED));
        assert_eq!(value["nested"]["clientSecret"], json!(REDACTED));
        assert_eq!(value["nested"]["api_key"], json!(REDACTED));
        assert_eq!(value["items"][0]["authorization"], json!(REDACTED));
        // Ordinary values are retained.
        assert_eq!(value["name"], json!("gmail"));
        assert_eq!(value["nested"]["plain"], json!("fine"));
        assert_eq!(value["items"][1]["url"], json!("https://x"));
    }

    #[test]
    fn null_secret_keys_are_left_alone() {
        // A null under a sensitive key carries no secret; everything else is
        // redacted wholesale — over-redaction is safe, under-redaction is not.
        let mut value = json!({
            "token_url": "https://oauth.example/token",
            "secrets": { "a": 1 },
            "key": null,
        });
        redact_value(&mut value);
        assert_eq!(value["token_url"], json!(REDACTED));
        assert_eq!(value["secrets"], json!(REDACTED));
        assert_eq!(value["key"], json!(null));
    }

    #[test]
    fn bounded_preview_truncates_on_char_boundaries() {
        assert_eq!(bounded_preview("  hello  ", 20), "hello");
        let long = "word ".repeat(300);
        let preview = bounded_preview(&long, 40);
        assert!(preview.chars().count() <= 41);
        assert!(preview.ends_with('…'));
        let emoji = "🎉".repeat(50);
        let preview = bounded_preview(&emoji, 5);
        assert_eq!(preview.chars().count(), 6);
    }
}
