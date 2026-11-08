//! Bounded inline output with daemon-owned recovery of the complete MCP result.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

pub(crate) const MAX_OUTPUT_BYTES: usize = 24_000;
const MAX_ENTRIES: usize = 32;
const MAX_STORE_BYTES: usize = 32 << 20;
const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const RANGE_BYTES: usize = (MAX_OUTPUT_BYTES - 1024) / 6;
pub(crate) const READ_TOOL: &str = "falcondeck_read_tool_output";

struct Entry {
    handle: String,
    at: Instant,
    text: String,
}
#[derive(Default)]
pub(crate) struct OutputStore {
    entries: VecDeque<Entry>,
    bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReadRequest {
    pub handle: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
}
fn default_limit() -> usize {
    RANGE_BYTES
}
#[derive(Debug, Serialize)]
pub(crate) struct OutputRange {
    handle: String,
    offset: usize,
    next_offset: usize,
    total_bytes: usize,
    eof: bool,
    text: String,
}
impl OutputStore {
    fn prune(&mut self, now: Instant) {
        self.entries
            .retain(|entry| now.saturating_duration_since(entry.at) < RETENTION);
        self.bytes = self.entries.iter().map(|entry| entry.text.len()).sum();
    }
    pub(crate) fn insert(&mut self, result: Value) -> Result<String, String> {
        self.insert_at(result, Instant::now())
    }
    fn insert_at(&mut self, result: Value, now: Instant) -> Result<String, String> {
        self.prune(now);
        let text = result.to_string();
        if text.len() > MAX_STORE_BYTES {
            return Err("Tool output exceeds the 32 MiB recovery-store limit".into());
        }
        while self.entries.len() >= MAX_ENTRIES || self.bytes + text.len() > MAX_STORE_BYTES {
            if let Some(entry) = self.entries.pop_front() {
                self.bytes -= entry.text.len();
            }
        }
        self.bytes += text.len();
        let handle = uuid::Uuid::new_v4().to_string();
        self.entries.push_back(Entry {
            handle: handle.clone(),
            at: now,
            text,
        });
        Ok(handle)
    }
    pub(crate) fn read(&mut self, request: ReadRequest) -> Result<OutputRange, String> {
        self.read_at(request, Instant::now())
    }
    fn read_at(&mut self, request: ReadRequest, now: Instant) -> Result<OutputRange, String> {
        self.prune(now);
        let entry = self.entries.iter().find(|entry| entry.handle == request.handle)
            .ok_or("Unknown or expired tool-output handle; results expire after 24 hours or 32 newer outputs")?;
        let offset = request.offset;
        if offset > entry.text.len() || !entry.text.is_char_boundary(offset) {
            return Err("offset must be a UTF-8 byte boundary within the stored output".into());
        }
        let mut end = offset
            .saturating_add(request.limit.clamp(4, RANGE_BYTES))
            .min(entry.text.len());
        while !entry.text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(OutputRange {
            handle: request.handle,
            offset,
            next_offset: end,
            total_bytes: entry.text.len(),
            eof: end == entry.text.len(),
            text: entry.text[offset..end].to_owned(),
        })
    }
}

pub(crate) fn read_tool_definition() -> Value {
    json!({"name": READ_TOOL, "description": "Recover a retained full MCP result without repeating its original call. Offsets are UTF-8 bytes; follow next_offset until eof. Handles expire after 24h or 32 newer outputs.",
        "inputSchema": {"type":"object", "additionalProperties":false, "required":["handle"], "properties":{
            "handle":{"type":"string"}, "offset":{"type":"integer","minimum":0,"default":0},
            "limit":{"type":"integer","minimum":4,"maximum":RANGE_BYTES,"default":RANGE_BYTES}}},
        "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})
}

fn head_tail(text: &str, budget: usize, marker: &str) -> String {
    if text.len() <= budget {
        return text.to_owned();
    }
    let remaining = budget - marker.len();
    let mut head = remaining / 2;
    let mut tail = text.len() - (remaining - head);
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}{marker}{}", &text[..head], &text[tail..])
}

fn oversized(result: &Value) -> bool {
    result
        .get("structuredContent")
        .is_some_and(|v| v.to_string().len() > MAX_OUTPUT_BYTES)
        || result
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .filter_map(|v| v.get("text").and_then(Value::as_str))
                    .map(str::len)
                    .sum::<usize>()
                    > MAX_OUTPUT_BYTES
            })
}
fn inline_preview(result: &Value, handle: &str, tool: &str) -> Value {
    let original = result
        .get("structuredContent")
        .unwrap_or(result)
        .to_string();
    let marker = format!(
        "\n\n[FalconDeck: output from {tool} truncated; middle omitted. Full result handle: {handle}. Recover with {READ_TOOL}(handle=\"{handle}\", offset=0); follow next_offset. Do not repeat the original call.]\n\n"
    );
    let mut budget = MAX_OUTPUT_BYTES - 512;
    loop {
        let envelope = json!({"truncated":true,"handle":handle,"read_tool":READ_TOOL,
            "tool":tool,"original_bytes":result.to_string().len(),"preview":head_tail(&original,budget,&marker)});
        let text = envelope.to_string();
        if text.len() <= MAX_OUTPUT_BYTES {
            let mut limited =
                json!({"content":[{"type":"text","text":text}],"isError":result["isError"]});
            if let Some(meta) = result.get("_meta") {
                limited["_meta"] = meta.clone();
            }
            return limited;
        }
        budget /= 2;
    }
}
fn tool_error(message: &str) -> Value {
    json!({"content":[{"type":"text","text":message}],"isError":true})
}

/// Called at the shared tools/call transport boundary, before any data is lost.
pub(crate) async fn retain_response(
    client: &reqwest::Client,
    base: &str,
    mut response: Value,
    tool: &str,
) -> Value {
    let Some(result) = response.get("result") else {
        return response;
    };
    if !oversized(result) {
        return response;
    }
    let handle = client
        .post(format!("{base}/api/tool-outputs"))
        .json(result)
        .send()
        .await;
    let handle = match handle {
        Ok(reply) if reply.status().is_success() => {
            reply.json::<Value>().await.ok().and_then(|value| {
                value
                    .get("handle")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        }
        _ => None,
    };
    let limited = match handle {
        Some(handle) => inline_preview(result, &handle, tool),
        None => tool_error(
            "Original tool call completed, but full-output retention failed. Do not repeat a mutating call; inspect daemon state instead.",
        ),
    };
    response["result"] = limited;
    response
}
pub(crate) async fn read_response(
    client: &reqwest::Client,
    base: &str,
    id: Value,
    arguments: Value,
) -> Value {
    let reply = client
        .post(format!("{base}/api/tool-outputs/read"))
        .json(&arguments)
        .send()
        .await;
    let result = match reply {
        Ok(reply) => {
            let ok = reply.status().is_success();
            match reply.json::<Value>().await {
                Ok(value) if ok => {
                    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})
                }
                Ok(value) => tool_error(
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown or expired tool-output handle"),
                ),
                Err(_) => tool_error("Could not read retained tool output"),
            }
        }
        Err(_) => tool_error("Daemon unavailable while reading retained output"),
    };
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) struct Server {
        pub base: String,
        pub calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
        _temp: tempfile::TempDir,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    pub(crate) async fn server(owner_route: &str, payload: Value) -> Server {
        use axum::{
            Json, Router,
            routing::{get, post},
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let temp = tempfile::tempdir().unwrap();
        let app = crate::app::AppState::new_with_state_path(
            "test".into(),
            Default::default(),
            temp.path().join("state.json"),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let router = Router::new()
            .route(
                owner_route,
                post(move || {
                    let payload = payload.clone();
                    let counter = counter.clone();
                    async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        Json(payload)
                    }
                }),
            )
            .route(
                "/api/extensions/tools",
                get(|| async { Json(json!({"tools":[]})) }),
            )
            .route("/api/tool-outputs", post(crate::api::retain_tool_output))
            .route("/api/tool-outputs/read", post(crate::api::read_tool_output))
            .with_state(app);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Server {
            base,
            calls,
            task,
            _temp: temp,
        }
    }

    fn recover(store: &mut OutputStore, handle: &str) -> Value {
        let mut offset = 0;
        let mut complete = String::new();
        loop {
            let part = store
                .read(ReadRequest {
                    handle: handle.into(),
                    offset,
                    limit: usize::MAX,
                })
                .unwrap();
            assert!(serde_json::to_string(&part).unwrap().len() < MAX_OUTPUT_BYTES);
            complete.push_str(&part.text);
            if part.eof {
                break;
            }
            assert!(part.next_offset > offset);
            offset = part.next_offset;
        }
        serde_json::from_str(&complete).unwrap()
    }

    #[test]
    fn review_get_64k_body_and_structured_content_are_recoverable() {
        let body = format!(
            "HEAD{}IMPORTANT_MIDDLE{}TAIL",
            "a".repeat(32_000),
            "b".repeat(32_000)
        );
        let value = json!({"ok":true,"data":{"body":body}});
        let original = json!({"content":[{"type":"text","text":value.to_string()}], "structuredContent":value,"isError":false});
        let mut store = OutputStore::default();
        let handle = store.insert(original.clone()).unwrap();
        let preview = inline_preview(&original, &handle, "fixture_tool");
        let text = preview["content"][0]["text"].as_str().unwrap();
        assert!(text.len() <= MAX_OUTPUT_BYTES);
        assert!(text.contains("HEAD") && text.contains("TAIL"));
        assert!(text.contains(&handle) && text.contains(READ_TOOL));
        assert!(text.contains("fixture_tool"));
        assert!(!text.contains("IMPORTANT_MIDDLE"));
        assert!(preview.get("structuredContent").is_none());
        assert_eq!(recover(&mut store, &handle), original);
    }

    #[test]
    fn extension_without_paging_recovers_original_content_metadata_and_unicode() {
        let text = format!(
            "HEAD{}MIDDLE{}TAIL",
            "😀".repeat(8_000),
            "界\\\"".repeat(8_000)
        );
        let original = json!({"content":[{"type":"text","text":text}],
            "structuredContent":{"ok":true,"result":text},"isError":false,
            "_meta":{"falcondeck/extensionTool":{"extensionId":"test","toolId":"no_paging"}}});
        let mut store = OutputStore::default();
        let handle = store.insert(original.clone()).unwrap();
        let preview = inline_preview(&original, &handle, "fixture_tool");
        assert_eq!(preview["_meta"], original["_meta"]);
        assert!(preview["content"][0]["text"].as_str().unwrap().len() <= MAX_OUTPUT_BYTES);
        assert_eq!(recover(&mut store, &handle), original);
    }

    #[test]
    fn expired_unknown_and_evicted_handles_are_explicit_errors() {
        let mut store = OutputStore::default();
        let now = Instant::now();
        let expired = store.insert_at(json!({"secret":"old"}), now).unwrap();
        let request = |handle: String| ReadRequest {
            handle,
            offset: 0,
            limit: 400,
        };
        assert!(
            store
                .read_at(request(expired), now + RETENTION)
                .unwrap_err()
                .contains("expired")
        );
        assert!(
            store
                .read(request("unknown".into()))
                .unwrap_err()
                .contains("Unknown")
        );
        let first = store.insert(json!({"n":0})).unwrap();
        for n in 1..=MAX_ENTRIES {
            store.insert(json!({"n":n})).unwrap();
        }
        assert_eq!(store.entries.len(), MAX_ENTRIES);
        assert!(store.read(request(first)).is_err());
        assert!(store.bytes <= MAX_STORE_BYTES);
    }
}
