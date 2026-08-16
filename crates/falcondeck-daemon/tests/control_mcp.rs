//! MCP protocol tests: spawn the real `falcondeck-daemon mcp` binary as a
//! child process against an embedded daemon and drive it over stdio.

use std::collections::BTreeMap;

use falcondeck_daemon::{DaemonConfig, spawn_embedded};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
            std::time::Duration::from_secs(20),
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
        ..DaemonConfig::default()
    }
}

async fn spawn_daemon(dir: &tempfile::TempDir) -> falcondeck_daemon::EmbeddedDaemonHandle {
    let mut daemon = spawn_embedded(config_with_state_path(dir.path().join("daemon-state.json")))
        .await
        .unwrap();
    daemon.wait_until_restored().await.unwrap();
    daemon
}

async fn spawn_mcp(daemon_url: &str) -> McpChild {
    // The startup probe needs a beat to connect.
    for _ in 0..50 {
        if reqwest::get(format!("{daemon_url}/api/health"))
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    McpChild::spawn(
        daemon_url,
        BTreeMap::from([
            (
                "FALCONDECK_CONTROL_PROVIDER".to_string(),
                "codex".to_string(),
            ),
            (
                "FALCONDECK_CONTROL_WORKSPACE".to_string(),
                "/tmp".to_string(),
            ),
        ]),
    )
}

#[tokio::test]
async fn modern_flow_discover_list_and_call() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = spawn_daemon(&dir).await;
    let mut mcp = spawn_mcp(&daemon.base_url()).await;

    let discover = mcp.request(1, "server/discover", json!({})).await;
    assert_eq!(discover["result"]["protocolVersion"], json!("2026-07-28"));
    assert_eq!(
        discover["result"]["serverInfo"]["name"],
        json!("falcondeck")
    );

    // Modern tools/list: fixed order, three tools, cacheable.
    let list = mcp.request(2, "tools/list", json!({})).await;
    let tools = list["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        vec!["falcondeck_search", "falcondeck_get", "falcondeck_execute"]
    );
    assert_eq!(list["result"]["ttlMs"], json!(3_600_000));
    assert_eq!(list["result"]["cacheScope"], json!("private"));

    // All three tools answer with structured and text content.
    let search = mcp
        .call_tool(
            3,
            "falcondeck_search",
            json!({ "query": "create a scheduled task" }),
        )
        .await;
    assert_eq!(search["result"]["isError"], json!(false));
    assert!(
        search["result"]["structuredContent"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|result| result["operation"] == json!("automation.create"))
    );
    assert!(
        search["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("automation.create")
    );

    let get = mcp
        .call_tool(
            4,
            "falcondeck_get",
            json!({ "resource": "agent_control.settings" }),
        )
        .await;
    assert_eq!(get["result"]["isError"], json!(false));
    assert_eq!(
        get["result"]["structuredContent"]["data"]["enabled"],
        json!(true)
    );

    let execute = mcp
        .call_tool(
            5,
            "falcondeck_execute",
            json!({
                "operation": "agent_control.settings.update",
                "arguments": { "default_timezone": "Europe/Berlin" },
            }),
        )
        .await;
    assert_eq!(execute["result"]["isError"], json!(false));
    assert_eq!(
        execute["result"]["structuredContent"]["data"]["default_timezone"],
        json!("Europe/Berlin")
    );

    // Ping works on the modern flow too.
    let ping = mcp.request(6, "ping", json!({})).await;
    assert!(ping["result"].is_object());

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
    assert_eq!(initialize["result"]["protocolVersion"], json!("2025-06-18"));

    // notifications/initialized produces no response.
    mcp.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .await;
    let list = mcp.request(2, "tools/list", json!({})).await;
    let tools = list["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 3);
    // Legacy clients do not receive cache hints.
    assert!(list["result"].get("ttlMs").is_none());

    let get = mcp
        .call_tool(3, "falcondeck_get", json!({ "resource": "automations" }))
        .await;
    assert_eq!(get["result"]["isError"], json!(false));

    mcp.stop().await;
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn protocol_errors_are_transport_level_and_deterministic() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = spawn_daemon(&dir).await;
    let mut mcp = spawn_mcp(&daemon.base_url()).await;

    // Malformed JSON-RPC.
    mcp.send_raw("{not json").await;
    let response: Value =
        serde_json::from_str(&mcp.read_line().await.expect("parse error response")).unwrap();
    assert_eq!(response["error"]["code"], json!(-32700));

    // Unknown method.
    let response = mcp.request(2, "resources/list", json!({})).await;
    assert_eq!(response["error"]["code"], json!(-32601));

    // Unknown tool name.
    let response = mcp.call_tool(3, "falcondeck_destroy", json!({})).await;
    assert_eq!(response["error"]["code"], json!(-32602));

    // Malformed tool call: arguments must be an object.
    let response = mcp
        .call_tool(4, "falcondeck_execute", json!("not-an-object"))
        .await;
    assert_eq!(response["error"]["code"], json!(-32602));

    // Operation failures stay tool-level errors the agent can read.
    let response = mcp
        .call_tool(
            5,
            "falcondeck_execute",
            json!({
                "operation": "/api/internal/delete-everything",
                "arguments": {},
            }),
        )
        .await;
    assert!(response.get("error").is_none(), "not a protocol error");
    assert_eq!(response["result"]["isError"], json!(true));
    assert_eq!(
        response["result"]["structuredContent"]["error"]["code"],
        json!("unknown_operation")
    );

    mcp.stop().await;
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn disabled_interface_surfaces_as_a_tool_error() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = spawn_daemon(&dir).await;
    let client = reqwest::Client::new();
    let disable: Value = client
        .post(format!("{}/api/control/execute", daemon.base_url()))
        .json(&json!({
            "operation": "agent_control.settings.update",
            "arguments": { "enabled": false },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(disable["ok"].as_bool().unwrap());

    let mut mcp = spawn_mcp(&daemon.base_url()).await;
    let response = mcp
        .call_tool(1, "falcondeck_search", json!({ "query": "automation" }))
        .await;
    assert_eq!(response["result"]["isError"], json!(true));
    assert_eq!(
        response["result"]["structuredContent"]["error"]["code"],
        json!("interface_disabled")
    );

    mcp.stop().await;
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn daemon_unreachable_at_startup_exits_with_a_message() {
    // Reserve then drop a port so nothing listens on it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);

    let child = Command::new(env!("CARGO_BIN_EXE_falcondeck-daemon"))
        .arg("mcp")
        .env("FALCONDECK_DAEMON_URL", format!("http://{addr}"))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let output = child.wait_with_output().await.unwrap();
    assert_ne!(output.status.code(), Some(0), "startup failure exits");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("cannot reach the daemon"),
        "diagnostics go to stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).trim().is_empty(),
        "stdout stays protocol-only"
    );
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
    assert_eq!(ok["result"]["isError"], json!(false));

    daemon.shutdown().await.unwrap();
    let response = mcp
        .call_tool(2, "falcondeck_get", json!({ "resource": "automations" }))
        .await;
    assert_eq!(response["result"]["isError"], json!(true));
    assert_eq!(
        response["result"]["structuredContent"]["error"]["code"],
        json!("execution_failed")
    );

    mcp.stop().await;
}

#[tokio::test]
async fn full_conversation_creates_an_automation_through_the_tools() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("quizgecko");
    std::fs::create_dir_all(&workspace).unwrap();
    let daemon = spawn_daemon(&dir).await;
    let mut mcp = spawn_mcp(&daemon.base_url()).await;

    // The intended agent flow: search for the capability, read the schema,
    // then execute with a validated payload.
    let search = mcp
        .call_tool(
            1,
            "falcondeck_search",
            json!({ "operation": "automation.create", "detail": "full" }),
        )
        .await;
    let results = search["result"]["structuredContent"]["results"]
        .as_array()
        .unwrap()
        .clone();
    assert!(results[0]["input_schema"].is_object());
    assert!(!results[0]["examples"].as_array().unwrap().is_empty());

    let execute = mcp
        .call_tool(
            2,
            "falcondeck_execute",
            json!({
                "operation": "automation.create",
                "idempotency_key": "mcp-weekday-inbox-2026-08-16",
                "arguments": {
                    "name": "Weekday inbox review",
                    "trigger": {
                        "kind": "cron",
                        "expression": "0 8 * * 1-5",
                        "timezone": "Europe/London"
                    },
                    "task": {
                        "kind": "conditional_prompt",
                        "instruction": "Review my inbox. If nothing requires attention, reply exactly FALCONDECK_NO_ACTION.",
                        "no_action_marker": "FALCONDECK_NO_ACTION"
                    },
                    "target": {
                        "workspace_path": workspace.display().to_string(),
                        "provider": "codex",
                        "thread": { "kind": "managed", "thread_id": null },
                        "sandbox_mode": "workspace-write",
                        "selected_skills": []
                    },
                    "required_connectors": [],
                    "concurrency_policy": "skip",
                    "misfire_policy": "skip"
                }
            }),
        )
        .await;
    assert_eq!(execute["result"]["isError"], json!(false));
    let data = &execute["result"]["structuredContent"]["data"];
    let id = data["id"].as_str().unwrap().to_string();
    assert_eq!(data["state"], json!("enabled"));
    assert!(data["next_run_at"].is_string());

    // The automation is immediately visible through falcondeck_get.
    let list = mcp
        .call_tool(3, "falcondeck_get", json!({ "resource": "automations" }))
        .await;
    let rows = list["result"]["structuredContent"]["data"]
        .as_array()
        .unwrap()
        .clone();
    assert!(rows.iter().any(|row| row["id"] == json!(id)));
    // List rows never include the full instruction.
    for row in &rows {
        assert!(row.get("task").is_none());
    }

    mcp.stop().await;
    daemon.shutdown().await.unwrap();
}
