//! The built-in FalconDeck MCP server (`falcondeck-daemon mcp`).
//!
//! A stateless stdio JSON-RPC process that exposes exactly three tools —
//! `falcondeck_search`, `falcondeck_get` and `falcondeck_execute` — on top
//! of the running daemon's control API. It owns no state: the daemon is the
//! sole writer of control state, and this process never opens
//! `agent-control.json` or runs providers itself.
//!
//! Both the modern (`server/discover`, `tools/list`, `tools/call`) and the
//! initialization-based (`initialize`, `notifications/initialized`)
//! protocol flows are supported. Only MCP protocol messages go to stdout;
//! diagnostics go to stderr.

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// MCP protocol version this server speaks for modern clients.
const PROTOCOL_VERSION: &str = "2026-07-28";
/// Protocol version echoed to initialization-based clients that do not send
/// one, matching the era that introduced the initialization handshake.
const LEGACY_PROTOCOL_VERSION: &str = "2025-06-18";
/// JSON-RPC error codes used by this server.
const PARSE_ERROR: i64 = -32700;
const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;

/// Environment variables the connector passes to the MCP subprocess.
pub const ENV_DAEMON_URL: &str = "FALCONDECK_DAEMON_URL";
/// Provider context for MCP-originated requests.
pub const ENV_CONTROL_PROVIDER: &str = "FALCONDECK_CONTROL_PROVIDER";
/// Workspace context for MCP-originated requests.
pub const ENV_CONTROL_WORKSPACE: &str = "FALCONDECK_CONTROL_WORKSPACE";
/// Best-effort thread context for MCP-originated requests.
pub const ENV_CONTROL_THREAD: &str = "FALCONDECK_CONTROL_THREAD";

/// The three public tools, in the fixed catalogue order.
const TOOL_ORDER: [&str; 3] = ["falcondeck_search", "falcondeck_get", "falcondeck_execute"];

/// Internal header names used to carry request context to the daemon.
const HEADER_ORIGIN: &str = "X-FalconDeck-Control-Origin";
const HEADER_PROVIDER: &str = "X-FalconDeck-Control-Provider";
const HEADER_WORKSPACE: &str = "X-FalconDeck-Control-Workspace";
const HEADER_THREAD: &str = "X-FalconDeck-Control-Thread";

/// Where the agent subprocess reached us from.
#[derive(Debug, Clone)]
struct McpContext {
    daemon_url: String,
    provider: Option<String>,
    workspace_path: Option<String>,
    thread_id: Option<String>,
}

impl McpContext {
    fn from_env() -> Self {
        Self {
            daemon_url: std::env::var(ENV_DAEMON_URL)
                .ok()
                .filter(|url| !url.trim().is_empty())
                .unwrap_or_else(|| "http://127.0.0.1:4123".to_string()),
            provider: std::env::var(ENV_CONTROL_PROVIDER).ok(),
            workspace_path: std::env::var(ENV_CONTROL_WORKSPACE).ok(),
            thread_id: std::env::var(ENV_CONTROL_THREAD).ok(),
        }
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        let insert = |headers: &mut reqwest::header::HeaderMap, name: &str, value: Option<&str>| {
            if let Some(value) = value.filter(|value| !value.is_empty())
                && let (Ok(name), Ok(value)) = (
                    reqwest::header::HeaderName::try_from(name),
                    reqwest::header::HeaderValue::from_str(value),
                )
            {
                headers.insert(name, value);
            }
        };
        insert(&mut headers, HEADER_ORIGIN, Some("mcp"));
        insert(&mut headers, HEADER_PROVIDER, self.provider.as_deref());
        insert(
            &mut headers,
            HEADER_WORKSPACE,
            self.workspace_path.as_deref(),
        );
        insert(&mut headers, HEADER_THREAD, self.thread_id.as_deref());
        headers
    }
}

/// Whether the legacy initialization handshake has been observed. Cache
/// hints are only meaningful for modern clients.
#[derive(Debug, Default, Clone, Copy)]
struct CompatibilityState {
    legacy_initialized: bool,
}

/// Runs the MCP stdio server until stdin closes. Returns a process exit
/// code: `0` for a clean end of input, `1` when the daemon cannot be
/// reached at startup.
pub async fn run_mcp_server() -> i32 {
    // Binaries that compile multiple rustls crypto backends panic on the
    // first TLS use without a process-level provider; install ours before
    // the HTTP client is built, whatever the entry point.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let context = McpContext::from_env();
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("falcondeck mcp: failed to build HTTP client: {error}");
            return 1;
        }
    };
    // Refuse to run against an unreachable daemon: the daemon owns all
    // state, so an MCP process without it can only mislead the agent.
    match client
        .get(format!("{}/api/health", context.daemon_url))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => {
            eprintln!(
                "falcondeck mcp: daemon at {} is not healthy (HTTP {})",
                context.daemon_url,
                response.status()
            );
            return 1;
        }
        Err(error) => {
            eprintln!(
                "falcondeck mcp: cannot reach the daemon at {}: {error}",
                context.daemon_url
            );
            return 1;
        }
    }

    let mut stdout = tokio::io::stdout();
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut compatibility = CompatibilityState::default();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_line(&line, &client, &context, &mut compatibility).await {
            let mut payload = serde_json::to_string(&response)
                .unwrap_or_else(|_| "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"encoding failure\"}}".to_string());
            payload.push('\n');
            if let Err(error) = stdout.write_all(payload.as_bytes()).await {
                eprintln!("falcondeck mcp: failed to write to stdout: {error}");
                return 1;
            }
            let _ = stdout.flush().await;
        }
    }
    0
}

/// Parses one stdin line into a JSON-RPC message and produces the response
/// line, if any. Malformed JSON always answers with a parse error.
async fn handle_line(
    line: &str,
    client: &reqwest::Client,
    context: &McpContext,
    compatibility: &mut CompatibilityState,
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
    let method = message.get("method").and_then(Value::as_str);
    let Some(method) = method else {
        // A response from the client (or junk); nothing to answer.
        return None;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    // Notifications never receive a response.
    let Some(id) = id else {
        match method {
            "notifications/initialized" | "notifications/cancelled" => {}
            other => {
                eprintln!("falcondeck mcp: ignoring unknown notification {other:?}");
            }
        }
        return None;
    };

    match method {
        "server/discover" => Some(discover_response(id)),
        "initialize" => {
            compatibility.legacy_initialized = true;
            Some(initialize_response(id, &params))
        }
        "ping" => Some(success_response(id, json!({}))),
        "tools/list" => Some(tools_list_response(id, compatibility)),
        "tools/call" => Some(handle_tool_call(id, &params, client, context).await),
        other => Some(error_response(
            id,
            METHOD_NOT_FOUND,
            &format!("unknown MCP method {other:?}"),
        )),
    }
}

fn discover_response(id: Value) -> Value {
    success_response(
        id,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {
                "tools": { "listChanged": false }
            },
            "serverInfo": server_info(),
        }),
    )
}

fn initialize_response(id: Value, params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(LEGACY_PROTOCOL_VERSION);
    success_response(
        id,
        json!({
            "protocolVersion": requested,
            "capabilities": {
                "tools": { "listChanged": false }
            },
            "serverInfo": server_info(),
        }),
    )
}

fn server_info() -> Value {
    json!({
        "name": "falcondeck",
        "version": env!("CARGO_PKG_VERSION"),
    })
}

fn tools_list_response(id: Value, compatibility: &CompatibilityState) -> Value {
    let tools: Vec<Value> = TOOL_ORDER
        .iter()
        .map(|name| tool_definition(name, compatibility))
        .collect();
    // The top-level catalogue is stable; cache hints only for clients on the
    // modern stateless flow.
    let mut result = json!({ "tools": tools });
    if !compatibility.legacy_initialized {
        result["ttlMs"] = json!(3_600_000);
        result["cacheScope"] = json!("private");
    }
    success_response(id, result)
}

fn tool_definition(name: &str, _compatibility: &CompatibilityState) -> Value {
    let schema = match name {
        "falcondeck_search" => json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language capability search."
                },
                "domain": {
                    "type": "string",
                    "description": "Optional domain such as automation or agent_control."
                },
                "operation": {
                    "type": "string",
                    "description": "Exact stable operation identifier."
                },
                "detail": {
                    "type": "string",
                    "enum": ["summary", "full"],
                    "default": "summary"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20,
                    "default": 8
                }
            }
        }),
        "falcondeck_get" => json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false,
            "required": ["resource"],
            "properties": {
                "resource": {
                    "type": "string",
                    "enum": [
                        "agent_control.settings",
                        "automations",
                        "automation",
                        "automation.runs",
                        "control.audit"
                    ]
                },
                "id": { "type": "string" },
                "filters": { "type": "object", "default": {} },
                "fields": {
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": 32,
                    "default": []
                },
                "cursor": { "type": "string" },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 20
                }
            }
        }),
        "falcondeck_execute" => json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false,
            "required": ["operation", "arguments"],
            "properties": {
                "operation": {
                    "type": "string",
                    "description": "Stable operation identifier returned by falcondeck_search."
                },
                "arguments": { "type": "object" },
                "expected_revision": {
                    "type": "integer",
                    "minimum": 1
                },
                "idempotency_key": {
                    "type": "string",
                    "minLength": 8,
                    "maxLength": 128
                }
            }
        }),
        other => json!({ "type": "object", "properties": {} , "description": other }),
    };
    json!({
        "name": name,
        "description": tool_description(name),
        "inputSchema": schema,
        // falcondeck_execute can perform operations with different risk
        // profiles, so its top-level annotation stays conservative; the
        // fine-grained behaviour comes back through falcondeck_search.
        "annotations": {
            "readOnlyHint": name != "falcondeck_execute",
            "destructiveHint": name == "falcondeck_execute",
            "idempotentHint": false,
            "openWorldHint": false
        }
    })
}

fn tool_description(name: &str) -> &'static str {
    match name {
        "falcondeck_search" => {
            "Discover FalconDeck control capabilities before acting: returns operation ids, domains, schemas, constraints and related operations. Call this first with a natural-language query such as \"automation create\", then again with operation and detail=full to see the complete schema and worked examples before executing through falcondeck_execute."
        }
        "falcondeck_get" => {
            "Read FalconDeck control state: agent-control settings, automations (list or single by id), automation run history and recent control changes. Read a single automation before mutating it — mutations executed through falcondeck_execute require the revision you read (expected_revision), and stale revisions fail with revision_conflict."
        }
        "falcondeck_execute" => {
            "Execute one registered FalconDeck control operation discovered via falcondeck_search, such as automation.create, automation.update or automation.run_now. Arguments are validated against the operation schema. Definition mutations require expected_revision from a prior falcondeck_get; automation.run_now never does. Pass an idempotency_key (8-128 chars) so identical retries replay the original result instead of duplicating the effect."
        }
        _ => "FalconDeck control tool.",
    }
}

async fn handle_tool_call(
    id: Value,
    params: &Value,
    client: &reqwest::Client,
    context: &McpContext,
) -> Value {
    let name = params.get("name").and_then(Value::as_str);
    let Some(name) = name else {
        return error_response(id, INVALID_PARAMS, "tools/call requires a tool name");
    };
    if !TOOL_ORDER.contains(&name) {
        return error_response(
            id,
            INVALID_PARAMS,
            &format!("unknown tool {name:?}; available tools are {TOOL_ORDER:?}"),
        );
    }
    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
    if !arguments.is_object() {
        return error_response(
            id,
            INVALID_PARAMS,
            "tools/call arguments must be a JSON object",
        );
    }
    let (route, body) = match name {
        "falcondeck_search" => ("/api/control/search", arguments),
        "falcondeck_get" => ("/api/control/get", arguments),
        _ => {
            // Only whitelisted execute fields cross into the request.
            let mut body = serde_json::Map::new();
            for field in [
                "operation",
                "arguments",
                "expected_revision",
                "idempotency_key",
            ] {
                if let Some(value) = arguments.get(field) {
                    body.insert(field.to_string(), value.clone());
                }
            }
            ("/api/control/execute", Value::Object(body))
        }
    };
    let url = format!("{}{route}", context.daemon_url);
    let request = client.post(&url).headers(context.headers()).json(&body);
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            eprintln!("falcondeck mcp: daemon request failed: {error}");
            return tool_result(
                id,
                json!({
                    "ok": false,
                    "error": {
                        "code": "execution_failed",
                        "message": format!("FalconDeck daemon is unreachable: {error}"),
                        "retryable": true,
                        "field_errors": []
                    }
                }),
                true,
            );
        }
    };
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .unwrap_or_else(|_| json!({ "error": { "code": "internal_error", "message": format!("daemon returned HTTP {status}"), "retryable": false, "field_errors": [] } }));
    if !status.is_success() {
        // Validation and interface failures are tool errors, not protocol
        // failures, so the agent can read the structured detail.
        let detail = payload.get("error").cloned().unwrap_or_else(|| {
            json!({
                "code": "internal_error",
                "message": format!("daemon returned HTTP {status}"),
                "retryable": false,
                "field_errors": []
            })
        });
        return tool_result(id, json!({ "ok": false, "error": detail }), true);
    }
    if name == "falcondeck_execute" {
        // The execute envelope carries its own ok flag.
        let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
        return tool_result(id, payload, !ok);
    }
    tool_result(id, payload, false)
}

/// Builds a `tools/call` result with both structured and text content.
fn tool_result(id: Value, structured: Value, is_error: bool) -> Value {
    let text = serde_json::to_string(&structured).unwrap_or_else(|_| "{\"ok\":false}".to_string());
    success_response(
        id,
        json!({
            "content": [
                { "type": "text", "text": text }
            ],
            "structuredContent": structured,
            "isError": is_error,
        }),
    )
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

    fn context(daemon_url: &str) -> McpContext {
        McpContext {
            daemon_url: daemon_url.to_string(),
            provider: Some("codex".to_string()),
            workspace_path: Some("/repo".to_string()),
            thread_id: None,
        }
    }

    #[test]
    fn tool_catalogue_is_fixed_and_conservative() {
        let compatibility = CompatibilityState::default();
        let tools: Vec<Value> = TOOL_ORDER
            .iter()
            .map(|name| tool_definition(name, &compatibility))
            .collect();
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, TOOL_ORDER.to_vec(), "catalogue order is fixed");
        for tool in &tools {
            assert!(tool["inputSchema"]["type"] == "object");
        }
        let execute = tools[2].clone();
        assert_eq!(execute["annotations"]["readOnlyHint"], json!(false));
        assert_eq!(execute["annotations"]["destructiveHint"], json!(true));
        assert_eq!(execute["annotations"]["openWorldHint"], json!(false));
        let get = &tools[1];
        assert_eq!(get["annotations"]["readOnlyHint"], json!(true));
    }

    #[test]
    fn cache_hints_follow_the_protocol_mode() {
        let modern = tools_list_response(json!(1), &CompatibilityState::default());
        assert_eq!(modern["result"]["ttlMs"], json!(3_600_000));
        assert_eq!(modern["result"]["cacheScope"], json!("private"));

        let legacy = tools_list_response(
            json!(2),
            &CompatibilityState {
                legacy_initialized: true,
            },
        );
        assert!(legacy["result"].get("ttlMs").is_none());
    }

    #[tokio::test]
    async fn malformed_json_answers_with_a_parse_error() {
        let client = reqwest::Client::new();
        let context = context("http://127.0.0.1:1");
        let compatibility = &mut CompatibilityState::default();
        let response = handle_line("{not json", &client, &context, compatibility)
            .await
            .expect("parse errors are answered");
        assert_eq!(response["error"]["code"], json!(PARSE_ERROR));
    }

    #[tokio::test]
    async fn notifications_and_unknown_methods() {
        let client = reqwest::Client::new();
        let context = context("http://127.0.0.1:1");
        let compatibility = &mut CompatibilityState::default();
        assert!(
            handle_line(
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                &client,
                &context,
                compatibility
            )
            .await
            .is_none(),
            "notifications are never answered"
        );
        let response = handle_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"resources/list"}"#,
            &client,
            &context,
            compatibility,
        )
        .await
        .unwrap();
        assert_eq!(response["error"]["code"], json!(METHOD_NOT_FOUND));
    }

    #[tokio::test]
    async fn tool_call_shapes_are_validated_before_the_daemon() {
        let client = reqwest::Client::new();
        let context = context("http://127.0.0.1:1");
        let compatibility = &mut CompatibilityState::default();
        let response = handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"falcondeck_missing"}}"#,
            &client,
            &context,
            compatibility,
        )
        .await
        .unwrap();
        assert_eq!(response["error"]["code"], json!(INVALID_PARAMS));

        let response = handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"falcondeck_execute","arguments":"not-an-object"}}"#,
            &client,
            &context,
            compatibility,
        )
        .await
        .unwrap();
        assert_eq!(response["error"]["code"], json!(INVALID_PARAMS));
    }
}
