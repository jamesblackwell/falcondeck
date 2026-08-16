//! HTTP integration tests for the generic local control API: the three
//! routes, origin headers, enablement enforcement, revision conflicts and
//! pagination. Uses the same embedded-daemon harness as `http_api.rs`.

use falcondeck_core::control::{ControlExecuteResponse, ControlGetResponse, ControlSearchResponse};
use falcondeck_daemon::{DaemonConfig, spawn_embedded};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};

fn config_with_state_path(path: std::path::PathBuf) -> DaemonConfig {
    DaemonConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        state_path: Some(path),
        ..DaemonConfig::default()
    }
}

async fn spawn() -> (falcondeck_daemon::EmbeddedDaemonHandle, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let config = config_with_state_path(dir.path().join("daemon-state.json"));
    let mut daemon = spawn_embedded(config).await.unwrap();
    daemon.wait_until_restored().await.unwrap();
    (daemon, dir)
}

#[tokio::test]
async fn search_route_discovers_capabilities() {
    let (daemon, _dir) = spawn().await;
    let client = Client::new();
    let response: ControlSearchResponse = client
        .post(format!("{}/api/control/search", daemon.base_url()))
        .json(&json!({ "query": "create a scheduled automation" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        response
            .results
            .iter()
            .any(|result| result.operation == "automation.create")
    );
}

#[tokio::test]
async fn get_route_reads_settings_and_automations() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace = dir.path().join("quizgecko");
    std::fs::create_dir_all(&workspace).unwrap();

    let settings: ControlGetResponse = client
        .post(format!("{}/api/control/get", daemon.base_url()))
        .json(&json!({ "resource": "agent_control.settings" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(settings.resource, "agent_control.settings");
    assert_eq!(settings.data["enabled"], json!(true));

    let execute: ControlExecuteResponse = client
        .post(format!("{}/api/control/execute", daemon.base_url()))
        .json(&json!({
            "operation": "automation.create",
            "arguments": {
                "name": "Weekday inbox review",
                "trigger": {
                    "kind": "cron",
                    "expression": "0 8 * * 1-5",
                    "timezone": "Europe/London",
                },
                "task": {
                    "kind": "prompt",
                    "instruction": "Review my inbox."
                },
                "target": {
                    "workspace_path": workspace.display().to_string(),
                    "provider": "codex",
                    "thread": { "kind": "managed" },
                },
            },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(execute.ok, "{:?}", execute.error);
    let id = execute.data.unwrap()["id"].as_str().unwrap().to_string();

    let automations: Value = client
        .post(format!("{}/api/control/get", daemon.base_url()))
        .json(&json!({
            "resource": "automations",
            "fields": ["id", "revision", "name", "state", "target.provider"],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let rows = automations["data"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!(id));
    assert_eq!(rows[0]["target"]["provider"], json!("codex"));
    // Field selection omits the instruction entirely.
    assert!(rows[0].get("task").is_none());

    // A single automation read returns the full definition.
    let detail: Value = client
        .post(format!("{}/api/control/get", daemon.base_url()))
        .json(&json!({ "resource": "automation", "id": id }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        detail["data"]["task"]["instruction"],
        json!("Review my inbox.")
    );
}

#[tokio::test]
async fn execute_route_runs_lifecycle_with_revisions() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace = dir.path().join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let url = format!("{}/api/control/execute", daemon.base_url());

    let create: ControlExecuteResponse = client
        .post(&url)
        .json(&json!({
            "operation": "automation.create",
            "arguments": {
                "name": "Interval check",
                "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                "task": { "kind": "prompt", "instruction": "Check." },
                "target": {
                    "workspace_path": workspace.display().to_string(),
                    "provider": "codex",
                    "thread": { "kind": "managed" },
                },
            },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(create.ok, "{:?}", create.error);
    let data = create.data.unwrap();
    let id = data["id"].as_str().unwrap().to_string();
    let revision = data["revision"].as_u64().unwrap();

    // Stale update conflicts with the current revision surfaced.
    let stale: ControlExecuteResponse = client
        .post(&url)
        .json(&json!({
            "operation": "automation.update",
            "expected_revision": revision + 10,
            "arguments": { "automation_id": id, "name": "Renamed" },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let error = stale.error.unwrap();
    assert_eq!(error.code, "revision_conflict");
    assert_eq!(error.current_revision, Some(revision));

    // Pause with the right revision, run without one, delete with it.
    let paused: ControlExecuteResponse = client
        .post(&url)
        .json(&json!({
            "operation": "automation.pause",
            "expected_revision": revision,
            "arguments": { "automation_id": id },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(paused.ok, "{:?}", paused.error);
    let next_revision = paused.data.unwrap()["revision"].as_u64().unwrap();

    let ran: ControlExecuteResponse = client
        .post(&url)
        .json(&json!({
            "operation": "automation.run_now",
            "arguments": { "automation_id": id },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(ran.ok, "{:?}", ran.error);
    assert_eq!(ran.data.unwrap()["status"], json!("queued"));

    let deleted: ControlExecuteResponse = client
        .post(&url)
        .json(&json!({
            "operation": "automation.delete",
            "expected_revision": next_revision,
            "arguments": { "automation_id": id },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(deleted.ok, "{:?}", deleted.error);
}

#[tokio::test]
async fn control_state_survives_a_daemon_restart() {
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("daemon-state.json");
    let workspace = dir.path().join("repo");
    std::fs::create_dir_all(&workspace).unwrap();

    {
        let mut daemon = spawn_embedded(config_with_state_path(state_path.clone()))
            .await
            .unwrap();
        daemon.wait_until_restored().await.unwrap();
        let client = Client::new();
        let create: ControlExecuteResponse = client
            .post(format!("{}/api/control/execute", daemon.base_url()))
            .json(&json!({
                "operation": "automation.create",
                "arguments": {
                    "name": "Persistent",
                    "trigger": { "kind": "interval", "every_seconds": 7200, "anchor_at": "2026-08-16T00:00:00Z" },
                    "task": { "kind": "prompt", "instruction": "Persist." },
                    "target": {
                        "workspace_path": workspace.display().to_string(),
                        "provider": "codex",
                        "thread": { "kind": "managed" },
                    },
                },
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(create.ok, "{:?}", create.error);
        daemon.shutdown().await.unwrap();
    }

    let mut daemon = spawn_embedded(config_with_state_path(state_path))
        .await
        .unwrap();
    daemon.wait_until_restored().await.unwrap();
    let client = Client::new();
    let automations: Value = client
        .post(format!("{}/api/control/get", daemon.base_url()))
        .json(&json!({ "resource": "automations" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let rows = automations["data"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], json!("Persistent"));
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn mcp_origin_headers_are_enforced_against_settings() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace = dir.path().join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let url = format!("{}/api/control", daemon.base_url());

    let workspace_path = workspace.display().to_string();
    let mcp_headers = [
        ("X-FalconDeck-Control-Origin", "mcp"),
        ("X-FalconDeck-Control-Provider", "codex"),
        ("X-FalconDeck-Control-Workspace", workspace_path.as_str()),
    ];

    // MCP-originated create works while enabled.
    let allowed: ControlExecuteResponse = client
        .post(format!("{url}/execute"))
        .headers(headers_from(&mcp_headers))
        .json(&json!({
            "operation": "automation.create",
            "arguments": {
                "name": "From MCP",
                "trigger": { "kind": "interval", "every_seconds": 3600, "anchor_at": "2026-08-16T00:00:00Z" },
                "task": { "kind": "prompt", "instruction": "Via agent." },
                "target": {
                    "workspace_path": workspace_path,
                    "provider": "codex",
                    "thread": { "kind": "managed" },
                },
            },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(allowed.ok, "{:?}", allowed.error);

    // Disable the provider for MCP callers; the same call is now rejected
    // with a structured interface_disabled-family error.
    let disable: ControlExecuteResponse = client
        .post(format!("{url}/execute"))
        .json(&json!({
            "operation": "agent_control.settings.update",
            "arguments": { "providers": { "codex": { "enabled": false } } },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(disable.ok, "{:?}", disable.error);

    let blocked: ControlExecuteResponse = client
        .post(format!("{url}/execute"))
        .headers(headers_from(&mcp_headers))
        .json(&json!({
            "operation": "automation.run_now",
            "arguments": { "automation_id": allowed.data.as_ref().unwrap()["id"] },
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(blocked.error.unwrap().code, "provider_disabled");

    // Reads are blocked for MCP too, but desktop reads still work.
    let mcp_read = client
        .post(format!("{url}/get"))
        .headers(headers_from(&mcp_headers))
        .json(&json!({ "resource": "agent_control.settings" }))
        .send()
        .await
        .unwrap();
    assert_eq!(mcp_read.status(), StatusCode::FORBIDDEN);
    let desktop_read = client
        .post(format!("{url}/get"))
        .json(&json!({ "resource": "agent_control.settings" }))
        .send()
        .await
        .unwrap();
    assert_eq!(desktop_read.status(), StatusCode::OK);
}

#[tokio::test]
async fn invalid_origin_context_is_rejected() {
    let (daemon, _dir) = spawn().await;
    let client = Client::new();
    let response = client
        .post(format!("{}/api/control/search", daemon.base_url()))
        .header("X-FalconDeck-Control-Origin", "attacker")
        .json(&json!({ "query": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // Valid origin values pass.
    for origin in ["desktop_ui", "mcp", "remote_rpc", "scheduler", "system"] {
        let response = client
            .post(format!("{}/api/control/search", daemon.base_url()))
            .header("X-FalconDeck-Control-Origin", origin)
            .json(&json!({ "query": "x" }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "origin {origin}");
    }
}

#[tokio::test]
async fn unknown_operations_cannot_be_executed_by_guessing_paths() {
    let (daemon, _dir) = spawn().await;
    let client = Client::new();
    let response: ControlExecuteResponse = client
        .post(format!("{}/api/control/execute", daemon.base_url()))
        .json(&json!({
            "operation": "/api/internal/delete-everything",
            "arguments": {},
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!response.ok);
    assert_eq!(response.error.unwrap().code, "unknown_operation");
}

#[tokio::test]
async fn pagination_and_filters_over_the_http_route() {
    let (daemon, dir) = spawn().await;
    let client = Client::new();
    let workspace = dir.path().join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let url = format!("{}/api/control", daemon.base_url());

    for index in 0..3 {
        let create: ControlExecuteResponse = client
            .post(format!("{url}/execute"))
            .json(&json!({
                "operation": "automation.create",
                "arguments": {
                    "name": format!("Automation {index}"),
                    "trigger": { "kind": "interval", "every_seconds": 3600 + index, "anchor_at": "2026-08-16T00:00:00Z" },
                    "task": { "kind": "prompt", "instruction": "i" },
                    "target": {
                        "workspace_path": workspace.display().to_string(),
                        "provider": "codex",
                        "thread": { "kind": "managed" },
                    },
                },
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(create.ok, "{:?}", create.error);
    }

    let first: Value = client
        .post(format!("{url}/get"))
        .json(&json!({ "resource": "automations", "limit": 2 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["data"].as_array().unwrap().len(), 2);
    let cursor = first["next_cursor"]
        .as_str()
        .expect("cursor present")
        .to_string();

    let second: Value = client
        .post(format!("{url}/get"))
        .json(&json!({ "resource": "automations", "limit": 2, "cursor": cursor }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let second_rows = second["data"].as_array().unwrap();
    assert_eq!(second_rows.len(), 1);
    assert!(second["next_cursor"].is_null());
}

#[tokio::test]
async fn loopback_host_protection_covers_control_routes() {
    let (daemon, _dir) = spawn().await;
    let client = Client::new();
    let response = client
        .post(format!("{}/api/control/search", daemon.base_url()))
        .header("Host", "evil.example.com")
        .json(&json!({ "query": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

fn headers_from(pairs: &[(&str, &str)]) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in pairs {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            reqwest::header::HeaderValue::from_str(value).unwrap(),
        );
    }
    headers
}
