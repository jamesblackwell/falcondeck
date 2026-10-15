//! MCP protocol tests: spawn the real `falcondeck-daemon mcp` binary as a
//! child process against an embedded daemon and drive it over stdio.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use falcondeck_daemon::{DaemonConfig, spawn_embedded};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct McpChild {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl McpChild {
    fn spawn(daemon_url: &str, extra_env: BTreeMap<String, String>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_falcondeck-daemon"));
        command.arg("mcp");
        command.env("FALCONDECK_DAEMON_URL", daemon_url);
        for (key, value) in extra_env {
            command.env(key, value);
        }
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command.spawn().expect("spawn falcondeck-daemon mcp");
        let stdin = child.stdin.take().expect("mcp stdin");
        let stdout = child.stdout.take().expect("mcp stdout");
        Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        }
    }

    async fn send(&mut self, message: &Value) {
        let mut line = serde_json::to_string(message).unwrap();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    /// Sends a raw line without JSON validation.
    async fn send_raw(&mut self, line: &str) {
        let mut line = line.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    async fn read_line(&mut self) -> Option<String> {
        let mut line = String::new();
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            self.stdout.read_line(&mut line),
        )
        .await
        .ok()?;
        match read {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim().to_string()),
        }
    }

    /// Sends a request and returns its response by id.
    async fn request(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await;
        loop {
            let line = self
                .read_line()
                .await
                .expect("a response line for the request");
            let response: Value = serde_json::from_str(&line).expect("stdout is valid JSON");
            if response.get("id").and_then(Value::as_i64) == Some(id) {
                return response;
            }
        }
    }

    async fn call_tool(&mut self, id: i64, name: &str, arguments: Value) -> Value {
        self.request(
            id,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }

    async fn stop(mut self) {
        let _ = self.child.kill().await;
    }
}

fn config_with_state_path(path: std::path::PathBuf) -> DaemonConfig {
    DaemonConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        state_path: Some(path),
        // These tests only use the control API. Session restore would scan
        // the real transcript trees and hold the test runtime open.
        background_restore: false,
        ..DaemonConfig::default()
    }
}

async fn spawn_daemon(dir: &tempfile::TempDir) -> falcondeck_daemon::EmbeddedDaemonHandle {
    spawn_embedded(config_with_state_path(dir.path().join("daemon-state.json")))
        .await
        .unwrap()
}

fn assert_jsonrpc_success(response: &Value, id: i64) {
    assert_eq!(response["jsonrpc"], json!("2.0"), "{response}");
    assert_eq!(response["id"], json!(id), "{response}");
    assert!(response.get("error").is_none(), "{response}");
}

/// Text content is the compatibility copy of `structuredContent`. A summary
/// that merely mentions the same words still fails.
fn assert_text_matches_structured(response: &Value) {
    let structured = &response["result"]["structuredContent"];
    let content = response["result"]["content"]
        .as_array()
        .expect("tool result content");
    assert_eq!(content.len(), 1, "{response}");
    assert_eq!(content[0]["type"], json!("text"));
    let text = content[0]["text"].as_str().expect("text content");
    let parsed: Value = serde_json::from_str(text).expect("text content is JSON");
    assert_eq!(&parsed, structured, "{response}");
}

fn assert_tool_success(response: &Value, id: i64) {
    assert_jsonrpc_success(response, id);
    assert_eq!(response["result"]["isError"], json!(false), "{response}");
    assert_text_matches_structured(response);
}

fn assert_tool_error(response: &Value, id: i64, code: &str) {
    assert_jsonrpc_success(response, id);
    assert_eq!(response["result"]["isError"], json!(true), "{response}");
    assert_text_matches_structured(response);
    assert_eq!(
        response["result"]["structuredContent"]["error"]["code"],
        json!(code),
        "{response}"
    );
}

fn assert_protocol_error(response: &Value, id: Option<i64>, code: i64) {
    assert_eq!(response["jsonrpc"], json!("2.0"), "{response}");
    match id {
        Some(id) => assert_eq!(response["id"], json!(id), "{response}"),
        None => assert!(response["id"].is_null(), "{response}"),
    }
    assert!(response.get("result").is_none(), "{response}");
    assert_eq!(response["error"]["code"], json!(code), "{response}");
    assert!(
        response["error"]["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty()),
        "{response}"
    );
}

async fn control_http(base_url: &str, route: &str, body: Value) -> Value {
    let response = reqwest::Client::new()
        .post(format!("{base_url}{route}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let payload: Value = response.json().await.unwrap();
    assert!(status.is_success(), "{status} {payload}");
    payload
}

async fn spawn_mcp(daemon_url: &str) -> McpChild {
    spawn_mcp_with(daemon_url, "codex", "/tmp", None).await
}

async fn spawn_mcp_with(
    daemon_url: &str,
    provider: &str,
    workspace: &str,
    thread_id: Option<&str>,
) -> McpChild {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(200))
        .build()
        .unwrap();
    for _ in 0..50 {
        if client
            .get(format!("{daemon_url}/api/health"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let mut env = BTreeMap::from([
        (
            "FALCONDECK_CONTROL_PROVIDER".to_string(),
            provider.to_string(),
        ),
        (
            "FALCONDECK_CONTROL_WORKSPACE".to_string(),
            workspace.to_string(),
        ),
    ]);
    if let Some(thread_id) = thread_id {
        env.insert(
            "FALCONDECK_CONTROL_THREAD".to_string(),
            thread_id.to_string(),
        );
    }
    McpChild::spawn(daemon_url, env)
}

async fn assert_startup_refusal(url: &str, stderr_needle: &str) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_falcondeck-daemon"));
    command
        .arg("mcp")
        .env("FALCONDECK_DAEMON_URL", url)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = command.spawn().expect("spawn falcondeck-daemon mcp");
    let output = tokio::time::timeout(std::time::Duration::from_secs(6), child.wait_with_output())
        .await
        .unwrap_or_else(|_| panic!("mcp stayed up against {url}"))
        .expect("mcp output");
    assert_eq!(output.status.code(), Some(1), "startup failure exits 1");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(stderr_needle),
        "stderr missing {stderr_needle:?}: {stderr}"
    );
    assert!(
        stderr.contains(url),
        "stderr should name the daemon url {url}: {stderr}"
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).trim().is_empty(),
        "stdout stays protocol-only: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

/// Accepts one HTTP request and answers 503. Used to prove a live but
/// unhealthy daemon is refused, which connection-refused does not cover.
async fn serve_unhealthy() -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut chunk = [0u8; 2048];
                let _ = socket.read(&mut chunk).await;
                let response = b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(response).await;
            });
        }
    });
    addr
}

#[tokio::test]
async fn modern_flow_discover_list_and_call() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = spawn_daemon(&dir).await;
    let mut mcp = spawn_mcp(&daemon.base_url()).await;

    let discover = mcp.request(1, "server/discover", json!({})).await;
    assert_jsonrpc_success(&discover, 1);
    assert_eq!(discover["result"]["protocolVersion"], json!("2026-07-28"));
    assert_eq!(
        discover["result"]["serverInfo"]["name"],
        json!("falcondeck")
    );
    assert!(
        discover["result"]["serverInfo"]["version"]
            .as_str()
            .is_some_and(|version| !version.is_empty())
    );

    // Modern tools/list: fixed order, three tools, cacheable, with the
    // annotations and required fields an agent uses to call them.
    let list = mcp.request(2, "tools/list", json!({})).await;
    assert_jsonrpc_success(&list, 2);
    let tools = list["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        vec!["falcondeck_search", "falcondeck_get", "falcondeck_execute"]
    );
    assert_eq!(list["result"]["ttlMs"], json!(3_600_000));
    assert_eq!(list["result"]["cacheScope"], json!("private"));
    assert_eq!(
        tools[0]["inputSchema"]["additionalProperties"],
        json!(false)
    );
    assert!(tools[0]["inputSchema"].get("required").is_none());
    assert_eq!(tools[0]["annotations"]["readOnlyHint"], json!(true));
    assert_eq!(tools[1]["inputSchema"]["required"], json!(["resource"]));
    assert_eq!(tools[2]["annotations"]["destructiveHint"], json!(true));
    assert_eq!(tools[2]["annotations"]["readOnlyHint"], json!(false));
    let execute_required = tools[2]["inputSchema"]["required"].as_array().unwrap();
    assert!(execute_required.contains(&json!("operation")));
    assert!(execute_required.contains(&json!("arguments")));

    // Summary search ranks the capability and withholds schemas.
    let search = mcp
        .call_tool(
            3,
            "falcondeck_search",
            json!({ "query": "create a recurring scheduled task" }),
        )
        .await;
    assert_tool_success(&search, 3);
    let results = search["result"]["structuredContent"]["results"]
        .as_array()
        .unwrap();
    assert_eq!(results[0]["operation"], json!("automation.create"));
    assert_eq!(results[0]["available"], json!(true));
    assert!(results.iter().all(|result| {
        result.get("input_schema").is_none()
            && result.get("output_schema").is_none()
            && result.get("examples").is_none()
    }));

    // Omitted arguments are an empty search, not a protocol failure.
    let bare = mcp
        .request(4, "tools/call", json!({ "name": "falcondeck_search" }))
        .await;
    assert_tool_success(&bare, 4);
    assert!(
        !bare["result"]["structuredContent"]["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let get = mcp
        .call_tool(
            5,
            "falcondeck_get",
            json!({ "resource": "agent_control.settings" }),
        )
        .await;
    assert_tool_success(&get, 5);
    assert_eq!(
        get["result"]["structuredContent"]["data"]["enabled"],
        json!(true)
    );

    let execute = mcp
        .call_tool(
            6,
            "falcondeck_execute",
            json!({
                "operation": "agent_control.settings.update",
                "arguments": { "default_timezone": "Europe/Berlin" },
            }),
        )
        .await;
    assert_tool_success(&execute, 6);
    assert_eq!(
        execute["result"]["structuredContent"]["data"]["default_timezone"],
        json!("Europe/Berlin")
    );

    // The execute response is not enough: a later read must show the write.
    let reread = mcp
        .call_tool(
            7,
            "falcondeck_get",
            json!({ "resource": "agent_control.settings" }),
        )
        .await;
    assert_tool_success(&reread, 7);
    assert_eq!(
        reread["result"]["structuredContent"]["data"]["default_timezone"],
        json!("Europe/Berlin")
    );

    let ping = mcp.request(8, "ping", json!({})).await;
    assert_jsonrpc_success(&ping, 8);
    assert_eq!(ping["result"], json!({}));

    // String ids are first-class JSON-RPC ids, not just numbers.
    mcp.send(&json!({ "jsonrpc": "2.0", "id": "ping-string", "method": "ping" }))
        .await;
    let line = mcp.read_line().await.expect("string-id ping response");
    let string_ping: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(string_ping["id"], json!("ping-string"));
    assert_eq!(string_ping["result"], json!({}));

    mcp.stop().await;
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn legacy_initialize_flow_works() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = spawn_daemon(&dir).await;
    let mut mcp = spawn_mcp(&daemon.base_url()).await;

    let initialize = mcp
        .request(
            1,
            "initialize",
            json!({ "protocolVersion": "2025-06-18", "capabilities": {} }),
        )
        .await;
    assert_jsonrpc_success(&initialize, 1);
    assert_eq!(initialize["result"]["protocolVersion"], json!("2025-06-18"));

    let unknown = mcp
        .request(2, "initialize", json!({ "protocolVersion": "1999-01-01" }))
        .await;
    assert_jsonrpc_success(&unknown, 2);
    assert_eq!(
        unknown["result"]["protocolVersion"],
        json!("2025-06-18"),
        "an unsupported version is not echoed"
    );

    // Blank lines, client responses, and notifications must not produce a
    // stdout line. The next read is the tools/list response itself.
    mcp.send_raw("").await;
    mcp.send(&json!({ "jsonrpc": "2.0", "id": 99, "result": { "ignored": true } }))
        .await;
    mcp.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .await;
    mcp.send(&json!({ "jsonrpc": "2.0", "method": "notifications/cancelled" }))
        .await;
    mcp.send(&json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/list",
        "params": {}
    }))
    .await;
    let line = mcp
        .read_line()
        .await
        .expect("tools/list is the first stdout line");
    let list: Value = serde_json::from_str(&line).unwrap();
    assert_jsonrpc_success(&list, 3);
    let tools = list["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        vec!["falcondeck_search", "falcondeck_get", "falcondeck_execute"]
    );
    assert!(list["result"].get("ttlMs").is_none());
    assert!(list["result"].get("cacheScope").is_none());

    // Naming the modern version through initialize still leaves the session
    // on the legacy catalogue.
    let modern = mcp
        .request(4, "initialize", json!({ "protocolVersion": "2026-07-28" }))
        .await;
    assert_eq!(modern["result"]["protocolVersion"], json!("2026-07-28"));
    let listed_again = mcp.request(5, "tools/list", json!({})).await;
    assert!(listed_again["result"].get("ttlMs").is_none());

    let get = mcp
        .call_tool(6, "falcondeck_get", json!({ "resource": "automations" }))
        .await;
    assert_tool_success(&get, 6);
    assert_eq!(get["result"]["structuredContent"]["data"], json!([]));

    mcp.stop().await;
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn protocol_errors_are_transport_level_and_deterministic() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = spawn_daemon(&dir).await;
    let mut mcp = spawn_mcp(&daemon.base_url()).await;

    mcp.send_raw("{not json").await;
    let response: Value =
        serde_json::from_str(&mcp.read_line().await.expect("parse error response")).unwrap();
    assert_protocol_error(&response, None, -32700);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("malformed")
    );

    let response = mcp.request(2, "resources/list", json!({})).await;
    assert_protocol_error(&response, Some(2), -32601);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("resources/list")
    );

    let response = mcp.call_tool(3, "falcondeck_destroy", json!({})).await;
    assert_protocol_error(&response, Some(3), -32602);

    let response = mcp
        .request(4, "tools/call", json!({ "arguments": {} }))
        .await;
    assert_protocol_error(&response, Some(4), -32602);

    let response = mcp
        .call_tool(5, "falcondeck_execute", json!("not-an-object"))
        .await;
    assert_protocol_error(&response, Some(5), -32602);

    let response = mcp.call_tool(6, "falcondeck_execute", json!(null)).await;
    assert_protocol_error(&response, Some(6), -32602);

    // Operation failures stay tool-level errors the agent can read.
    let response = mcp
        .call_tool(
            7,
            "falcondeck_execute",
            json!({
                "operation": "/api/internal/delete-everything",
                "arguments": {},
            }),
        )
        .await;
    assert_tool_error(&response, 7, "unknown_operation");

    mcp.stop().await;
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn disabled_interface_surfaces_as_a_tool_error() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = spawn_daemon(&dir).await;
    let base_url = daemon.base_url();
    let disable = control_http(
        &base_url,
        "/api/control/execute",
        json!({
            "operation": "agent_control.settings.update",
            "arguments": { "enabled": false },
        }),
    )
    .await;
    assert_eq!(disable["ok"], json!(true));

    let mut mcp = spawn_mcp(&base_url).await;
    let search = mcp
        .call_tool(1, "falcondeck_search", json!({ "query": "automation" }))
        .await;
    assert_tool_error(&search, 1, "interface_disabled");
    let get = mcp
        .call_tool(2, "falcondeck_get", json!({ "resource": "automations" }))
        .await;
    assert_tool_error(&get, 2, "interface_disabled");
    // Model-supplied origin fields cannot turn this into a desktop call.
    let execute = mcp
        .call_tool(
            3,
            "falcondeck_execute",
            json!({
                "operation": "agent_control.settings.update",
                "arguments": { "enabled": true, "default_timezone": "Europe/Paris" },
                "origin": "desktop_ui",
                "provider": "claude",
            }),
        )
        .await;
    assert_tool_error(&execute, 3, "interface_disabled");

    let desktop = control_http(
        &base_url,
        "/api/control/get",
        json!({ "resource": "agent_control.settings" }),
    )
    .await;
    assert_eq!(desktop["data"]["enabled"], json!(false));
    assert_ne!(desktop["data"]["default_timezone"], json!("Europe/Paris"));

    let reenabled = control_http(
        &base_url,
        "/api/control/execute",
        json!({
            "operation": "agent_control.settings.update",
            "arguments": {
                "enabled": true,
                "default_timezone": "Europe/Berlin",
                "providers": { "codex": { "enabled": false } }
            },
        }),
    )
    .await;
    assert_eq!(reenabled["ok"], json!(true));

    let blocked = mcp
        .call_tool(
            4,
            "falcondeck_get",
            json!({ "resource": "agent_control.settings" }),
        )
        .await;
    assert_tool_error(&blocked, 4, "provider_disabled");
    let spoofed = mcp
        .call_tool(
            5,
            "falcondeck_execute",
            json!({
                "operation": "agent_control.settings.update",
                "arguments": { "default_timezone": "Europe/Paris" },
                "origin": "desktop_ui",
                "provider": "claude",
            }),
        )
        .await;
    assert_tool_error(&spoofed, 5, "provider_disabled");

    let mut claude = spawn_mcp_with(&base_url, "claude", "/tmp", None).await;
    let allowed = claude
        .call_tool(
            1,
            "falcondeck_get",
            json!({ "resource": "agent_control.settings" }),
        )
        .await;
    assert_tool_success(&allowed, 1);
    assert_eq!(
        allowed["result"]["structuredContent"]["data"]["default_timezone"],
        json!("Europe/Berlin")
    );
    assert_eq!(
        allowed["result"]["structuredContent"]["data"]["enabled"],
        json!(true)
    );

    claude.stop().await;

    mcp.stop().await;
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn daemon_unreachable_at_startup_exits_with_a_message() {
    // Reserve then drop a port so nothing listens on it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);

    assert_startup_refusal(&format!("http://{addr}"), "cannot reach the daemon").await;
}

#[tokio::test]
async fn unhealthy_daemon_at_startup_exits_with_a_message() {
    let addr = serve_unhealthy().await;
    assert_startup_refusal(&format!("http://{addr}"), "is not healthy").await;
}

#[tokio::test]
async fn daemon_unreachable_during_a_call_is_a_tool_error() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = spawn_daemon(&dir).await;
    let base_url = daemon.base_url();
    let mut mcp = spawn_mcp(&base_url).await;

    // A successful call first, then the daemon goes away mid-session.
    let ok = mcp
        .call_tool(1, "falcondeck_get", json!({ "resource": "automations" }))
        .await;
    assert_tool_success(&ok, 1);
    assert_eq!(ok["result"]["structuredContent"]["data"], json!([]));

    daemon.shutdown().await.unwrap();
    let response = mcp
        .call_tool(2, "falcondeck_get", json!({ "resource": "automations" }))
        .await;
    assert_tool_error(&response, 2, "execution_failed");
    assert_eq!(
        response["result"]["structuredContent"]["error"]["retryable"],
        json!(true)
    );
    assert!(
        response["result"]["structuredContent"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unreachable")
    );

    // The MCP process stays up and still answers protocol methods that do
    // not need the daemon.
    let ping = mcp.request(3, "ping", json!({})).await;
    assert_jsonrpc_success(&ping, 3);
    assert_eq!(ping["result"], json!({}));

    mcp.stop().await;
}

#[tokio::test]
async fn full_conversation_creates_an_automation_through_the_tools() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("quizgecko");
    std::fs::create_dir_all(&workspace).unwrap();
    let daemon = spawn_daemon(&dir).await;
    let registration = reqwest::Client::new()
        .post(format!("{}/api/workspaces/connect", daemon.base_url()))
        .json(&json!({ "path": workspace.display().to_string() }))
        .send()
        .await
        .unwrap();
    assert!(
        registration.status().is_success(),
        "workspace registration failed: {}",
        registration.text().await.unwrap_or_default()
    );
    let mut mcp = spawn_mcp_with(
        &daemon.base_url(),
        "codex",
        "/tmp",
        Some("thread-mcp-audit"),
    )
    .await;

    let workspace_path = workspace.display().to_string();
    // Distinct from the automation target so an audit row that copied the
    // model-authored workspace would fail.
    let sentinel = "INBOX_SENTINEL_do_not_list";
    let instruction = format!(
        "Review my inbox. If nothing requires attention, reply exactly FALCONDECK_NO_ACTION. {sentinel}"
    );
    let create_arguments = json!({
        "name": "Weekday inbox review",
        "trigger": {
            "kind": "cron",
            "expression": "0 8 * * 1-5",
            "timezone": "Europe/London"
        },
        "task": {
            "kind": "conditional_prompt",
            "instruction": instruction.as_str(),
            "no_action_marker": "FALCONDECK_NO_ACTION"
        },
        "target": {
            "workspace_path": workspace_path.as_str(),
            "provider": "codex",
            "thread": { "kind": "managed", "thread_id": null },
            "sandbox_mode": "workspace-write",
            "selected_skills": []
        },
        "required_connectors": [],
        "concurrency_policy": "skip",
        "misfire_policy": "skip"
    });

    let search = mcp
        .call_tool(
            1,
            "falcondeck_search",
            json!({ "operation": "automation.create", "detail": "full" }),
        )
        .await;
    assert_tool_success(&search, 1);
    let results = search["result"]["structuredContent"]["results"]
        .as_array()
        .unwrap();
    assert_eq!(
        results.len(),
        1,
        "an operation filter returns that operation"
    );
    assert_eq!(results[0]["operation"], json!("automation.create"));
    assert_eq!(results[0]["available"], json!(true));
    assert_eq!(results[0]["behavior"]["read_only"], json!(false));
    assert!(results[0]["input_schema"].is_object());
    assert!(results[0]["output_schema"].is_object());
    assert!(!results[0]["examples"].as_array().unwrap().is_empty());

    let create_payload = json!({
        "operation": "automation.create",
        "idempotency_key": "mcp-weekday-inbox-2026-08-16",
        "origin": "desktop_ui",
        "provider": "claude",
        "arguments": create_arguments,
    });
    let execute = mcp
        .call_tool(2, "falcondeck_execute", create_payload.clone())
        .await;
    assert_tool_success(&execute, 2);
    let data = &execute["result"]["structuredContent"]["data"];
    let id = data["id"].as_str().unwrap().to_string();
    assert_eq!(data["state"], json!("enabled"));
    assert_eq!(data["name"], json!("Weekday inbox review"));
    assert_eq!(data["revision"], json!(1));
    assert_eq!(data["task"]["instruction"], json!(instruction));
    assert_eq!(data["trigger"]["expression"], json!("0 8 * * 1-5"));
    assert_eq!(data["trigger"]["timezone"], json!("Europe/London"));
    assert_eq!(data["target"]["workspace_path"], json!(workspace_path));
    let next_run_at = data["next_run_at"].as_str().unwrap();
    let next_run = DateTime::parse_from_rfc3339(next_run_at).expect("next_run_at is a timestamp");
    assert!(next_run.with_timezone(&Utc) > Utc::now());

    let replay = mcp.call_tool(3, "falcondeck_execute", create_payload).await;
    assert_tool_success(&replay, 3);
    assert_eq!(
        replay["result"]["structuredContent"]["data"]["id"],
        json!(id),
        "the same idempotency key replays the original automation"
    );

    let conflict = mcp
        .call_tool(
            4,
            "falcondeck_execute",
            json!({
                "operation": "automation.create",
                "idempotency_key": "mcp-weekday-inbox-2026-08-16",
                "arguments": {
                    "name": "A different automation",
                    "trigger": {
                        "kind": "cron",
                        "expression": "0 9 * * 1-5",
                        "timezone": "Europe/London"
                    },
                    "task": {
                        "kind": "prompt",
                        "instruction": "This retry must not be stored."
                    },
                    "target": {
                        "workspace_path": workspace_path.as_str(),
                        "provider": "codex",
                        "thread": { "kind": "managed", "thread_id": null }
                    }
                }
            }),
        )
        .await;
    assert_tool_error(&conflict, 4, "idempotency_conflict");

    let detail = mcp
        .call_tool(
            5,
            "falcondeck_get",
            json!({ "resource": "automation", "id": id }),
        )
        .await;
    assert_tool_success(&detail, 5);
    assert_eq!(
        detail["result"]["structuredContent"]["data"]["task"]["instruction"],
        json!(instruction)
    );
    assert_eq!(
        detail["result"]["structuredContent"]["data"]["name"],
        json!("Weekday inbox review")
    );
    assert_eq!(
        detail["result"]["structuredContent"]["data"]["revision"],
        json!(1)
    );

    let list = mcp
        .call_tool(
            6,
            "falcondeck_get",
            json!({
                "resource": "automations",
                "fields": ["id", "name", "task", "task.instruction"]
            }),
        )
        .await;
    assert_tool_success(&list, 6);
    let rows = list["result"]["structuredContent"]["data"]
        .as_array()
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!(id));
    assert_eq!(rows[0]["name"], json!("Weekday inbox review"));
    let listed = serde_json::to_string(rows).unwrap();
    assert!(!listed.contains(sentinel));
    assert!(rows.iter().all(|row| row.get("task").is_none()));

    let audit = mcp
        .call_tool(7, "falcondeck_get", json!({ "resource": "control.audit" }))
        .await;
    assert_tool_success(&audit, 7);
    let entries = audit["result"]["structuredContent"]["data"]
        .as_array()
        .unwrap();
    let encoded_audit = serde_json::to_string(entries).unwrap();
    assert!(!encoded_audit.contains(sentinel));
    let created = entries
        .iter()
        .find(|entry| {
            entry["operation"] == json!("automation.create") && entry["result"] == json!("success")
        })
        .expect("create audit entry");
    assert_eq!(created["context"]["origin"], json!("mcp"));
    assert_eq!(created["context"]["provider"], json!("codex"));
    assert_eq!(created["context"]["workspace_path"], json!("/tmp"));
    assert_eq!(created["context"]["thread_id"], json!("thread-mcp-audit"));
    assert_eq!(created["resource_id"], json!(id));

    let missing_revision = mcp
        .call_tool(
            8,
            "falcondeck_execute",
            json!({
                "operation": "automation.update",
                "arguments": { "automation_id": id, "name": "Renamed without a revision" }
            }),
        )
        .await;
    assert_tool_error(&missing_revision, 8, "revision_required");

    let stale_revision = mcp
        .call_tool(
            9,
            "falcondeck_execute",
            json!({
                "operation": "automation.update",
                "expected_revision": 99,
                "arguments": { "automation_id": id, "name": "Renamed from a stale revision" }
            }),
        )
        .await;
    assert_tool_error(&stale_revision, 9, "revision_conflict");
    assert_eq!(
        stale_revision["result"]["structuredContent"]["error"]["current_revision"],
        json!(1)
    );

    let renamed = mcp
        .call_tool(
            10,
            "falcondeck_execute",
            json!({
                "operation": "automation.update",
                "expected_revision": 1,
                "arguments": { "automation_id": id, "name": "Renamed inbox review" }
            }),
        )
        .await;
    assert_tool_success(&renamed, 10);
    assert_eq!(
        renamed["result"]["structuredContent"]["data"]["revision"],
        json!(2)
    );
    assert_eq!(
        renamed["result"]["structuredContent"]["data"]["name"],
        json!("Renamed inbox review")
    );
    assert_eq!(
        renamed["result"]["structuredContent"]["data"]["task"]["instruction"],
        json!(instruction)
    );

    let listed_again = mcp
        .call_tool(
            11,
            "falcondeck_get",
            json!({ "resource": "automations", "fields": ["task"] }),
        )
        .await;
    assert_tool_success(&listed_again, 11);
    let rows = listed_again["result"]["structuredContent"]["data"]
        .as_array()
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], json!("Renamed inbox review"));
    assert!(!serde_json::to_string(rows).unwrap().contains(sentinel));

    mcp.stop().await;
    daemon.shutdown().await.unwrap();
}
