//! Connector (MCP server) configuration shared across agent providers.
//!
//! Connectors are configured by data, not code: `connectors.json` in the
//! FalconDeck state dir applies to every workspace, and a workspace-local
//! `.falcondeck/connectors.json` adds to or overrides it (by server name).
//! The file uses the de-facto standard `mcpServers` map shape so users can
//! paste entries straight from any MCP server's README:
//!
//! ```json
//! {
//!   "mcpServers": {
//!     "linear": { "command": "npx", "args": ["-y", "mcp-linear"], "env": { "LINEAR_API_KEY": "…" } },
//!     "docs":   { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer …" } }
//!   }
//! }
//! ```
//!
//! Optional per-server fields: `"enabled": false` parks an entry without
//! deleting it, and `"providers": ["claude", "codex"]` restricts a server to
//! specific agent providers (default: all).
//!
//! Configs are re-read at every spawn/session boundary rather than cached in
//! `AppState`, so edits apply on the next turn with no daemon restart.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// One configured MCP server after merging global + workspace files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpTransport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpTransport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
    },
}

#[derive(Debug, Default, Deserialize)]
struct ConnectorsFile {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, ConnectorEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConnectorEntry {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default = "default_enabled")]
    enabled: bool,
    /// Provider ids this server is offered to; empty = all providers.
    #[serde(default)]
    providers: Vec<String>,
    /// Fields we do not model (hand-edits, future keys). Carried so the
    /// settings UI's read-modify-write cycle cannot strip them from the file.
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

fn default_enabled() -> bool {
    true
}

fn global_connectors_path() -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join(".falcondeck").join("connectors.json")
}

fn workspace_connectors_path(workspace_path: &str) -> PathBuf {
    Path::new(workspace_path)
        .join(".falcondeck")
        .join("connectors.json")
}

fn read_connectors_file(path: &Path) -> BTreeMap<String, ConnectorEntry> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return BTreeMap::new(),
    };
    match serde_json::from_str::<ConnectorsFile>(&raw) {
        Ok(file) => file.mcp_servers,
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "failed to parse connectors.json");
            BTreeMap::new()
        }
    }
}

/// Loads the merged MCP server list for one workspace and provider.
pub fn load_mcp_servers(workspace_path: &str, provider: &str) -> Vec<McpServerConfig> {
    load_mcp_servers_from(
        &global_connectors_path(),
        &workspace_connectors_path(workspace_path),
        provider,
    )
}

fn load_mcp_servers_from(
    global_path: &Path,
    workspace_path: &Path,
    provider: &str,
) -> Vec<McpServerConfig> {
    let mut merged = read_connectors_file(global_path);
    // Workspace entries win on name conflicts.
    merged.extend(read_connectors_file(workspace_path));

    merged
        .into_iter()
        .filter_map(|(name, entry)| {
            if !entry.enabled {
                return None;
            }
            if !entry.providers.is_empty()
                && !entry.providers.iter().any(|p| p.eq_ignore_ascii_case(provider))
            {
                return None;
            }
            let transport = match (entry.command, entry.url) {
                (Some(command), _) if !command.trim().is_empty() => McpTransport::Stdio {
                    command,
                    args: entry.args,
                    env: entry.env,
                },
                (_, Some(url)) if !url.trim().is_empty() => McpTransport::Http {
                    url,
                    headers: entry.headers,
                },
                _ => {
                    tracing::warn!(server = %name, "connectors.json entry has neither command nor url");
                    return None;
                }
            };
            Some(McpServerConfig { name, transport })
        })
        .collect()
}

/// JSON body for a Claude `--mcp-config` file; `None` when no servers apply.
pub fn claude_mcp_config_json(servers: &[McpServerConfig]) -> Option<String> {
    if servers.is_empty() {
        return None;
    }
    let mut map = serde_json::Map::new();
    for server in servers {
        let value = match &server.transport {
            McpTransport::Stdio { command, args, env } => json!({
                "command": command,
                "args": args,
                "env": env,
            }),
            McpTransport::Http { url, headers } => json!({
                "type": "http",
                "url": url,
                "headers": headers,
            }),
        };
        map.insert(server.name.clone(), value);
    }
    serde_json::to_string_pretty(&json!({ "mcpServers": Value::Object(map) })).ok()
}

/// `mcpServers` array for an ACP `session/new` request. HTTP servers are
/// skipped: the ACP baseline transports stdio servers only.
pub fn acp_mcp_servers(servers: &[McpServerConfig]) -> Value {
    let entries = servers
        .iter()
        .filter_map(|server| match &server.transport {
            McpTransport::Stdio { command, args, env } => Some(json!({
                "name": server.name,
                "command": command,
                "args": args,
                "env": env
                    .iter()
                    .map(|(name, value)| json!({ "name": name, "value": value }))
                    .collect::<Vec<_>>(),
            })),
            McpTransport::Http { .. } => {
                tracing::info!(server = %server.name, "skipping http MCP server for ACP provider");
                None
            }
        })
        .collect::<Vec<_>>();
    Value::Array(entries)
}

/// `-c key=value` config overrides for a Codex spawn. HTTP servers are
/// skipped: Codex configures stdio MCP servers via `mcp_servers.*` tables.
pub fn codex_config_overrides(servers: &[McpServerConfig]) -> Vec<String> {
    let mut overrides = Vec::new();
    for server in servers {
        let McpTransport::Stdio { command, args, env } = &server.transport else {
            tracing::info!(server = %server.name, "skipping http MCP server for Codex");
            continue;
        };
        // Codex consumes these as `-c key=value`, split at the first '='.
        // A '=' inside the (user-controlled) server or env-var name would
        // corrupt the split and can fail the whole app-server spawn.
        if server.name.contains('=') || env.keys().any(|name| name.contains('=')) {
            tracing::warn!(
                server = %server.name,
                "skipping MCP server for Codex: '=' in server or env name breaks -c overrides"
            );
            continue;
        }
        let key = toml_quoted_key(&server.name);
        overrides.push(format!(
            "mcp_servers.{key}.command={}",
            toml_string(command)
        ));
        if !args.is_empty() {
            let list = args.iter().map(|a| toml_string(a)).collect::<Vec<_>>();
            overrides.push(format!("mcp_servers.{key}.args=[{}]", list.join(",")));
        }
        if !env.is_empty() {
            let table = env
                .iter()
                .map(|(name, value)| format!("{}={}", toml_quoted_key(name), toml_string(value)))
                .collect::<Vec<_>>();
            overrides.push(format!("mcp_servers.{key}.env={{{}}}", table.join(",")));
        }
    }
    overrides
}

/// Which connectors file an edit targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorScope {
    Global,
    Workspace,
}

/// Full config view for the settings UI: both raw files plus the merged,
/// per-server resolution (disabled entries included so they stay editable).
pub fn connectors_overview(workspace_path: Option<&str>) -> Value {
    connectors_overview_at(
        &global_connectors_path(),
        workspace_path.map(workspace_connectors_path).as_deref(),
    )
}

fn connectors_overview_at(global_path: &Path, workspace_file: Option<&Path>) -> Value {
    let global = read_connectors_file(global_path);
    let workspace = workspace_file.map(read_connectors_file);

    let mut merged: BTreeMap<String, (&'static str, &ConnectorEntry)> = BTreeMap::new();
    for (name, entry) in &global {
        merged.insert(name.clone(), ("global", entry));
    }
    if let Some(workspace) = &workspace {
        for (name, entry) in workspace {
            merged.insert(name.clone(), ("workspace", entry));
        }
    }
    let merged = merged
        .into_iter()
        .map(|(name, (scope, entry))| {
            let mut value = serde_json::to_value(entry).unwrap_or_else(|_| json!({}));
            if let Some(map) = value.as_object_mut() {
                map.insert("name".to_string(), json!(name));
                map.insert("scope".to_string(), json!(scope));
            }
            value
        })
        .collect::<Vec<_>>();

    json!({
        "global": to_servers_map(&global),
        "workspace": workspace.as_ref().map(to_servers_map),
        "merged": merged,
    })
}

fn to_servers_map(entries: &BTreeMap<String, ConnectorEntry>) -> Value {
    let mut map = serde_json::Map::new();
    for (name, entry) in entries {
        if let Ok(value) = serde_json::to_value(entry) {
            map.insert(name.clone(), value);
        }
    }
    Value::Object(map)
}

/// Validates and atomically writes one connectors file (`{"mcpServers": …}`).
/// Env blocks routinely hold API keys, so files are written 0600.
pub fn write_mcp_servers(
    scope: ConnectorScope,
    workspace_path: Option<&str>,
    mcp_servers: &Value,
) -> Result<(), String> {
    // Reject bodies that the loaders would not understand instead of
    // persisting them and failing at the next spawn.
    serde_json::from_value::<BTreeMap<String, ConnectorEntry>>(mcp_servers.clone())
        .map_err(|error| format!("invalid mcpServers payload: {error}"))?;

    let path = match scope {
        ConnectorScope::Global => global_connectors_path(),
        ConnectorScope::Workspace => {
            let workspace_path = workspace_path.ok_or("workspace scope requires a workspace_id")?;
            workspace_connectors_path(workspace_path)
        }
    };
    write_mcp_servers_at(&path, mcp_servers)
}

fn write_mcp_servers_at(path: &Path, mcp_servers: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("connectors path has no parent")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;

    let body = serde_json::to_string_pretty(&json!({ "mcpServers": mcp_servers }))
        .map_err(|error| format!("failed to encode connectors file: {error}"))?;
    // Unique temp name: concurrent writers (panel + remote RPC) sharing one
    // .tmp path would interleave bytes and publish a corrupted file.
    let tmp = path.with_extension(format!("json.tmp.{}", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&tmp)
        .and_then(|mut file| file.write_all(body.as_bytes()))
        .map_err(|error| format!("failed to write {}: {error}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))
}

/// Quotes a TOML key segment unless it is already a bare key.
fn toml_quoted_key(key: &str) -> String {
    let bare = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if bare {
        key.to_string()
    } else {
        toml_string(key)
    }
}

/// Renders a TOML basic string with escaping.
fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("connectors.json");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn workspace_entries_override_global_by_name() {
        let global_dir = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let global = write(
            global_dir.path(),
            r#"{"mcpServers":{"shared":{"command":"global-bin"},"only-global":{"command":"g"}}}"#,
        );
        let workspace = write(
            workspace_dir.path(),
            r#"{"mcpServers":{"shared":{"command":"workspace-bin"}}}"#,
        );
        let servers = load_mcp_servers_from(&global, &workspace, "claude");
        assert_eq!(servers.len(), 2);
        let shared = servers.iter().find(|s| s.name == "shared").unwrap();
        assert!(
            matches!(&shared.transport, McpTransport::Stdio { command, .. } if command == "workspace-bin")
        );
    }

    #[test]
    fn disabled_and_provider_scoped_entries_are_filtered() {
        let dir = tempfile::tempdir().unwrap();
        let global = write(
            dir.path(),
            r#"{"mcpServers":{
                "off":{"command":"x","enabled":false},
                "claude-only":{"command":"y","providers":["claude"]},
                "everywhere":{"command":"z"}
            }}"#,
        );
        let missing = dir.path().join("absent.json");
        let for_codex = load_mcp_servers_from(&global, &missing, "codex");
        assert_eq!(
            for_codex
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["everywhere"]
        );
        let for_claude = load_mcp_servers_from(&global, &missing, "claude");
        assert_eq!(for_claude.len(), 2);
    }

    #[test]
    fn missing_and_malformed_files_yield_no_servers() {
        let dir = tempfile::tempdir().unwrap();
        let malformed = write(dir.path(), "{not json");
        let missing = dir.path().join("absent.json");
        assert!(load_mcp_servers_from(&malformed, &missing, "claude").is_empty());
        assert!(load_mcp_servers_from(&missing, &missing, "claude").is_empty());
    }

    #[test]
    fn claude_config_carries_both_transports() {
        let servers = vec![
            McpServerConfig {
                name: "local".into(),
                transport: McpTransport::Stdio {
                    command: "npx".into(),
                    args: vec!["-y".into(), "server".into()],
                    env: BTreeMap::from([("KEY".to_string(), "v".to_string())]),
                },
            },
            McpServerConfig {
                name: "remote".into(),
                transport: McpTransport::Http {
                    url: "https://mcp.example.com/mcp".into(),
                    headers: BTreeMap::new(),
                },
            },
        ];
        let parsed: Value =
            serde_json::from_str(&claude_mcp_config_json(&servers).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"]["local"]["command"], "npx");
        assert_eq!(parsed["mcpServers"]["remote"]["type"], "http");
        assert!(claude_mcp_config_json(&[]).is_none());
    }

    #[test]
    fn acp_servers_are_stdio_only_with_env_pairs() {
        let servers = vec![
            McpServerConfig {
                name: "local".into(),
                transport: McpTransport::Stdio {
                    command: "bin".into(),
                    args: vec![],
                    env: BTreeMap::from([("A".to_string(), "1".to_string())]),
                },
            },
            McpServerConfig {
                name: "remote".into(),
                transport: McpTransport::Http {
                    url: "https://x".into(),
                    headers: BTreeMap::new(),
                },
            },
        ];
        let value = acp_mcp_servers(&servers);
        let list = value.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], "local");
        assert_eq!(list[0]["env"][0]["name"], "A");
        assert_eq!(list[0]["env"][0]["value"], "1");
    }

    #[test]
    fn overview_merges_scopes_and_keeps_disabled_entries() {
        let global_dir = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let global = write(
            global_dir.path(),
            r#"{"mcpServers":{"shared":{"command":"g"},"parked":{"command":"p","enabled":false}}}"#,
        );
        let workspace = write(
            workspace_dir.path(),
            r#"{"mcpServers":{"shared":{"command":"w"}}}"#,
        );
        let overview = connectors_overview_at(&global, Some(workspace.as_path()));
        let merged = overview["merged"].as_array().unwrap();
        assert_eq!(merged.len(), 2);
        let shared = merged.iter().find(|s| s["name"] == "shared").unwrap();
        assert_eq!(shared["scope"], "workspace");
        assert_eq!(shared["command"], "w");
        let parked = merged.iter().find(|s| s["name"] == "parked").unwrap();
        assert_eq!(parked["enabled"], false);
        assert!(overview["global"]["parked"].is_object());
    }

    #[test]
    fn write_validates_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connectors.json");
        let servers = json!({"linear": {"command": "npx", "args": ["-y", "s"]}});
        write_mcp_servers_at(&path, &servers).unwrap();
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["mcpServers"]["linear"]["command"], "npx");

        let invalid = json!({"bad": {"args": "not-a-list"}});
        assert!(
            serde_json::from_value::<BTreeMap<String, ConnectorEntry>>(invalid.clone()).is_err()
        );
        assert!(
            write_mcp_servers(ConnectorScope::Workspace, None, &servers)
                .unwrap_err()
                .contains("workspace")
        );
    }

    #[test]
    fn codex_overrides_are_valid_toml_assignments() {
        let servers = vec![McpServerConfig {
            name: "my server".into(),
            transport: McpTransport::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "a\"b".into()],
                env: BTreeMap::from([("K".to_string(), "v".to_string())]),
            },
        }];
        let overrides = codex_config_overrides(&servers);
        assert_eq!(
            overrides,
            vec![
                "mcp_servers.\"my server\".command=\"npx\"".to_string(),
                "mcp_servers.\"my server\".args=[\"-y\",\"a\\\"b\"]".to_string(),
                "mcp_servers.\"my server\".env={K=\"v\"}".to_string(),
            ]
        );
    }
}
