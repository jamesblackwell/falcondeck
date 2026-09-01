//! The built-in FalconDeck extensions MCP server (`falcondeck-daemon mcp-extensions`).
//!
//! A stateless stdio JSON-RPC process that publishes the tools declared by
//! enabled FalconDeck extensions as ordinary, namespaced MCP tools. It owns no
//! state and knows no tool names ahead of time: `tools/list` asks the running
//! daemon what is enabled and granted right now, and `tools/call` routes the
//! arguments straight back to the daemon, which re-checks both before running
//! extension code.
//!
//! Thread and workspace context comes from the daemon at spawn time, never
//! from the agent, so a tool call cannot be aimed at another conversation.
//!
//! Only MCP protocol messages go to stdout; diagnostics go to stderr.

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// MCP protocol version this server speaks for modern clients.
const PROTOCOL_VERSION: &str = "2026-07-28";
/// Protocol version echoed to initialization-based clients that send none.
const LEGACY_PROTOCOL_VERSION: &str = "2025-06-18";
const PARSE_ERROR: i64 = -32700;
const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;

/// Daemon base URL for the bridge subprocess.
pub const ENV_DAEMON_URL: &str = "FALCONDECK_DAEMON_URL";
/// Workspace path context supplied by the daemon at spawn.
pub const ENV_EXTENSION_WORKSPACE: &str = "FALCONDECK_EXTENSION_WORKSPACE";
/// Thread context supplied by the daemon at spawn, when known.
pub const ENV_EXTENSION_THREAD: &str = "FALCONDECK_EXTENSION_THREAD";
/// Opaque task-bound authority supplied by the daemon at connector spawn.
pub const ENV_EXTENSION_CAPABILITY: &str = "FALCONDECK_EXTENSION_CAPABILITY";

/// Spawn-time context for one agent session.
#[derive(Debug, Clone)]
struct BridgeContext {
    daemon_url: String,
    workspace_path: Option<String>,
    thread_id: Option<String>,
    bridge_capability: Option<String>,
}

// Keep the bridge coupled to the daemon's small HTTP wire shape, not its
// internal extension model. That lets the stdio helper remain a stateless
// boundary process and ignore fields it does not publish to MCP clients.
#[derive(Debug, Deserialize)]
struct PublishedToolList {
    #[serde(default)]
    tools: Vec<PublishedTool>,
}

#[derive(Debug, Deserialize)]
struct PublishedTool {
    name: String,
    title: String,
    description: String,
    input_schema: Value,
}

impl BridgeContext {
    fn from_env() -> Self {
        Self {
            daemon_url: std::env::var(ENV_DAEMON_URL)
                .ok()
                .filter(|url| !url.trim().is_empty())
                .unwrap_or_else(|| "http://127.0.0.1:4123".to_string()),
            workspace_path: non_empty(ENV_EXTENSION_WORKSPACE),
            thread_id: non_empty(ENV_EXTENSION_THREAD),
            bridge_capability: non_empty(ENV_EXTENSION_CAPABILITY),
        }
    }
}

fn non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// Runs the bridge until stdin closes. Returns a process exit code: `0` for a
/// clean end of input, `1` when the daemon cannot be reached at startup.
pub async fn run_extension_mcp_server() -> i32 {
    // Binaries that compile multiple rustls crypto backends panic on the
    // first TLS use without a process-level provider.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let context = BridgeContext::from_env();
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("falcondeck mcp-extensions: failed to build HTTP client: {error}");
            return 1;
        }
    };
    match client
        .get(format!("{}/api/health", context.daemon_url))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => {
            eprintln!(
                "falcondeck mcp-extensions: daemon at {} is not healthy (HTTP {})",
                context.daemon_url,
                response.status()
            );
            return 1;
        }
        Err(error) => {
            eprintln!(
                "falcondeck mcp-extensions: cannot reach the daemon at {}: {error}",
                context.daemon_url
            );
            return 1;
        }
    }

    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_line(&line, &client, &context).await {
            let mut payload = serde_json::to_string(&response)
                .unwrap_or_else(|_| "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"encoding failure\"}}".to_string());
            payload.push('\n');
            if let Err(error) = stdout.write_all(payload.as_bytes()).await {
                eprintln!("falcondeck mcp-extensions: failed to write to stdout: {error}");
                return 1;
            }
            let _ = stdout.flush().await;
        }
    }
    0
}

async fn handle_line(
    line: &str,
    client: &reqwest::Client,
    context: &BridgeContext,
) -> Option<Value> {
    let message: Value = match serde_json::from_str(line) {
        Ok(message) => message,
        Err(error) => {
            return Some(error_response(
                Value::Null,
                PARSE_ERROR,
                &format!("malformed JSON-RPC message: {error}"),
            ));
        }
    };
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str)?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    let Some(id) = id else {
        match method {
            "notifications/initialized" | "notifications/cancelled" => {}
            other => {
                eprintln!("falcondeck mcp-extensions: ignoring unknown notification {other:?}")
            }
        }
        return None;
    };

    match method {
        "server/discover" => Some(handshake_response(id, PROTOCOL_VERSION)),
        "initialize" => Some(handshake_response(
            id,
            params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(LEGACY_PROTOCOL_VERSION),
        )),
        "ping" => Some(success_response(id, json!({}))),
        "tools/list" => Some(tools_list_response(id, client, context).await),
        "tools/call" => Some(handle_tool_call(id, &params, client, context).await),
        other => Some(error_response(
            id,
            METHOD_NOT_FOUND,
            &format!("unknown MCP method {other:?}"),
        )),
    }
}

fn handshake_response(id: Value, protocol_version: &str) -> Value {
    success_response(
        id,
        json!({
            "protocolVersion": protocol_version,
            // The catalogue changes when the user enables or disables an
            // extension, so it is never safe to treat as immutable.
            "capabilities": { "tools": { "listChanged": true } },
            "serverInfo": {
                "name": "falcondeck-extensions",
                "version": env!("CARGO_PKG_VERSION"),
            },
        }),
    )
}

/// Asks the daemon which tools are enabled and granted right now. A daemon
/// that cannot answer publishes nothing rather than a stale guess.
async fn tools_list_response(
    id: Value,
    client: &reqwest::Client,
    context: &BridgeContext,
) -> Value {
    let url = format!("{}/api/extensions/tools", context.daemon_url);
    let tools = match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => response
            .json::<PublishedToolList>()
            .await
            .map(|list| list.tools)
            .unwrap_or_default(),
        Ok(response) => {
            eprintln!(
                "falcondeck mcp-extensions: daemon returned HTTP {} for the tool list",
                response.status()
            );
            Vec::new()
        }
        Err(error) => {
            eprintln!("falcondeck mcp-extensions: failed to list extension tools: {error}");
            Vec::new()
        }
    };
    let tools = tools
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "title": tool.title,
                "description": tool.description,
                "inputSchema": tool.input_schema,
                "annotations": {
                    // Extension tools mutate only FalconDeck's own bounded
                    // projections; nothing outside the daemon is touched.
                    "readOnlyHint": false,
                    "destructiveHint": false,
                    "idempotentHint": true,
                    "openWorldHint": false
                }
            })
        })
        .collect::<Vec<_>>();
    success_response(id, json!({ "tools": tools }))
}

async fn handle_tool_call(
    id: Value,
    params: &Value,
    client: &reqwest::Client,
    context: &BridgeContext,
) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return error_response(id, INVALID_PARAMS, "tools/call requires a tool name");
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !arguments.is_object() {
        return error_response(
            id,
            INVALID_PARAMS,
            "tools/call arguments must be a JSON object",
        );
    }
    let body = json!({
        "name": name,
        "arguments": arguments,
        // Context is daemon-supplied, never agent-supplied.
        "thread_id": context.thread_id,
        "workspace_path": context.workspace_path,
        "bridge_capability": context.bridge_capability,
    });
    let url = format!("{}/api/extensions/tools/invoke", context.daemon_url);
    let response = match client.post(&url).json(&body).send().await {
        Ok(response) => response,
        Err(error) => {
            return tool_result(
                id,
                json!({ "ok": false, "error": format!("FalconDeck daemon is unreachable: {error}") }),
                true,
                None,
            );
        }
    };
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("daemon returned HTTP {status}"));
        return tool_result(id, json!({ "ok": false, "error": message }), true, None);
    }
    let result = payload.get("result").cloned().unwrap_or(Value::Null);
    let metadata = match (
        payload.get("extension_id").and_then(Value::as_str),
        payload.get("tool_id").and_then(Value::as_str),
    ) {
        (Some(extension_id), Some(tool_id)) => Some(json!({
            "falcondeck/extensionTool": {
                "extensionId": extension_id,
                "toolId": tool_id,
            }
        })),
        _ => None,
    };
    tool_result(id, json!({ "ok": true, "result": result }), false, metadata)
}

fn tool_result(id: Value, structured: Value, is_error: bool, metadata: Option<Value>) -> Value {
    let text = serde_json::to_string(&structured).unwrap_or_else(|_| "{\"ok\":false}".to_string());
    let mut result = json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": is_error,
    });
    if let Some(metadata) = metadata {
        result["_meta"] = metadata;
    }
    success_response(id, result)
}

fn success_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(daemon_url: &str) -> BridgeContext {
        BridgeContext {
            daemon_url: daemon_url.to_string(),
            workspace_path: Some("/repo".to_string()),
            thread_id: Some("thread-1".to_string()),
            bridge_capability: Some("capability-1".to_string()),
        }
    }

    #[test]
    fn the_catalogue_is_advertised_as_changeable() {
        // Enabling or disabling an extension changes the tool list, so a
        // client must never treat this server's catalogue as immutable.
        let response = handshake_response(json!(1), PROTOCOL_VERSION);
        assert_eq!(
            response["result"]["capabilities"]["tools"]["listChanged"],
            json!(true)
        );
        assert_eq!(
            response["result"]["serverInfo"]["name"],
            json!("falcondeck-extensions")
        );
    }

    #[test]
    fn initialize_echoes_the_client_protocol_version() {
        let requested = handshake_response(json!(1), "2025-06-18");
        assert_eq!(requested["result"]["protocolVersion"], json!("2025-06-18"));
    }

    #[test]
    fn extension_tool_metadata_is_attached_without_changing_structured_content() {
        let response = tool_result(
            json!(1),
            json!({ "ok": true, "result": { "draftId": "draft-1" } }),
            false,
            Some(json!({
                "falcondeck/extensionTool": {
                    "extensionId": "falcondeck.missions",
                    "toolId": "draft-mission"
                }
            })),
        );
        assert_eq!(
            response["result"]["_meta"]["falcondeck/extensionTool"]["toolId"],
            json!("draft-mission")
        );
        assert_eq!(
            response["result"]["structuredContent"]["result"]["draftId"],
            json!("draft-1")
        );
    }

    #[tokio::test]
    async fn malformed_json_answers_with_a_parse_error() {
        let client = reqwest::Client::new();
        let response = handle_line("{not json", &client, &context("http://127.0.0.1:1"))
            .await
            .expect("parse errors are answered");
        assert_eq!(response["error"]["code"], json!(PARSE_ERROR));
    }

    #[tokio::test]
    async fn notifications_are_silent_and_unknown_methods_fail() {
        let client = reqwest::Client::new();
        let context = context("http://127.0.0.1:1");
        assert!(
            handle_line(
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                &client,
                &context,
            )
            .await
            .is_none(),
            "notifications are never answered"
        );
        let response = handle_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"resources/list"}"#,
            &client,
            &context,
        )
        .await
        .expect("requests are always answered");
        assert_eq!(response["error"]["code"], json!(METHOD_NOT_FOUND));
    }

    #[tokio::test]
    async fn tool_call_shapes_are_validated_before_the_daemon() {
        let client = reqwest::Client::new();
        let context = context("http://127.0.0.1:1");
        for params in [
            r#"{}"#,
            r#"{"name":"ext__tool","arguments":"not-an-object"}"#,
        ] {
            let response = handle_line(
                &format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{params}}}"#),
                &client,
                &context,
            )
            .await
            .expect("requests are always answered");
            assert_eq!(response["error"]["code"], json!(INVALID_PARAMS));
        }
    }

    #[tokio::test]
    async fn an_unreachable_daemon_publishes_nothing_rather_than_a_stale_guess() {
        let client = reqwest::Client::new();
        let response = tools_list_response(json!(1), &client, &context("http://127.0.0.1:1")).await;
        assert_eq!(response["result"]["tools"], json!([]));
    }

    #[tokio::test]
    async fn an_unreachable_daemon_answers_a_call_as_a_tool_error() {
        let client = reqwest::Client::new();
        let response = handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ext__tool","arguments":{}}}"#,
            &client,
            &context("http://127.0.0.1:1"),
        )
        .await
        .expect("requests are always answered");
        // A tool error, not a protocol error: the agent can read it and move on.
        assert_eq!(response["result"]["isError"], json!(true));
        assert_eq!(response["result"]["structuredContent"]["ok"], json!(false));
    }
}
