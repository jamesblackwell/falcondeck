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
use std::path::{Path, PathBuf};

use serde::Deserialize;
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

#[derive(Debug, Deserialize)]
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
            for_codex.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
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
