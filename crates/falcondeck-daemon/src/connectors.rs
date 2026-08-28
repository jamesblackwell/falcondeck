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
    /// `"oauth"` means FalconDeck holds the token and injects a Bearer header
    /// at materialize time. The token is not stored in this file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth: Option<String>,
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

/// Reserved connector name for the built-in FalconDeck control server. A
/// user-authored connector with this name is ignored with a warning rather
/// than overriding the built-in server.
pub const BUILTIN_CONNECTOR_NAME: &str = "falcondeck";

/// Everything the built-in FalconDeck control connector needs to point an
/// agent at this daemon. Computed at each provider spawn boundary from
/// current agent-control settings; never persisted to `connectors.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltinControlSpec {
    /// Base HTTP URL of the daemon's control API.
    pub daemon_url: String,
    /// Provider the agent subprocess speaks for.
    pub provider: String,
    /// Workspace the agent is running in.
    pub workspace_path: String,
    /// Thread the agent turn runs in, when known.
    pub thread_id: Option<String>,
}

/// Builds the in-memory FalconDeck control MCP server for one provider
/// spawn. The command is the daemon's own executable; the subprocess talks
/// to the running daemon and owns no state itself.
pub fn builtin_control_server(
    daemon_executable: &std::path::Path,
    spec: &BuiltinControlSpec,
) -> McpServerConfig {
    let mut env = BTreeMap::from([
        ("FALCONDECK_DAEMON_URL".to_string(), spec.daemon_url.clone()),
        (
            "FALCONDECK_CONTROL_PROVIDER".to_string(),
            spec.provider.clone(),
        ),
        (
            "FALCONDECK_CONTROL_WORKSPACE".to_string(),
            spec.workspace_path.clone(),
        ),
    ]);
    if let Some(thread_id) = &spec.thread_id {
        env.insert("FALCONDECK_CONTROL_THREAD".to_string(), thread_id.clone());
    }
    McpServerConfig {
        name: BUILTIN_CONNECTOR_NAME.to_string(),
        transport: McpTransport::Stdio {
            command: daemon_executable.display().to_string(),
            args: vec!["mcp".to_string()],
            env,
        },
    }
}

/// Appends the built-in FalconDeck control connector to a merged user
/// connector list. User entries using the reserved name are dropped with a
/// warning instead of overriding the built-in server; other entries keep
/// their order and contents untouched.
pub fn with_builtin_control(
    servers: Vec<McpServerConfig>,
    spec: Option<&BuiltinControlSpec>,
) -> Vec<McpServerConfig> {
    let Some(spec) = spec else {
        return servers;
    };
    let mut servers: Vec<McpServerConfig> = servers
        .into_iter()
        .filter(|server| {
            if server.name == BUILTIN_CONNECTOR_NAME {
                tracing::warn!(
                    "ignoring user connector named {BUILTIN_CONNECTOR_NAME:?}: the name is reserved for the built-in FalconDeck control server"
                );
                false
            } else {
                true
            }
        })
        .collect();
    servers.push(builtin_control_server(&daemon_executable(), spec));
    servers
}

/// Reserved connector name for the built-in FalconDeck extensions bridge.
pub const BUILTIN_EXTENSIONS_CONNECTOR_NAME: &str = "falcondeck-extensions";

/// Everything the extensions MCP bridge needs to reach this daemon and know
/// which conversation its tool calls belong to. Computed at each provider
/// spawn boundary; never persisted to `connectors.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltinExtensionsSpec {
    /// Base HTTP URL of the daemon.
    pub daemon_url: String,
    /// Workspace the agent is running in.
    pub workspace_path: String,
    /// Thread the agent turn runs in, when known.
    pub thread_id: Option<String>,
}

/// Builds the in-memory FalconDeck extensions MCP server for one spawn.
pub fn builtin_extensions_server(
    daemon_executable: &std::path::Path,
    spec: &BuiltinExtensionsSpec,
) -> McpServerConfig {
    let mut env = BTreeMap::from([
        (
            crate::extension_mcp::ENV_DAEMON_URL.to_string(),
            spec.daemon_url.clone(),
        ),
        (
            crate::extension_mcp::ENV_EXTENSION_WORKSPACE.to_string(),
            spec.workspace_path.clone(),
        ),
    ]);
    if let Some(thread_id) = &spec.thread_id {
        env.insert(
            crate::extension_mcp::ENV_EXTENSION_THREAD.to_string(),
            thread_id.clone(),
        );
    }
    McpServerConfig {
        name: BUILTIN_EXTENSIONS_CONNECTOR_NAME.to_string(),
        transport: McpTransport::Stdio {
            command: daemon_executable.display().to_string(),
            args: vec!["mcp-extensions".to_string()],
            env,
        },
    }
}

/// Appends the built-in extensions bridge to a merged connector list. As with
/// the control connector, user entries using the reserved name are dropped
/// rather than allowed to shadow the built-in server.
pub fn with_builtin_extensions(
    servers: Vec<McpServerConfig>,
    spec: Option<&BuiltinExtensionsSpec>,
) -> Vec<McpServerConfig> {
    let Some(spec) = spec else {
        return servers;
    };
    let mut servers: Vec<McpServerConfig> = servers
        .into_iter()
        .filter(|server| {
            if server.name == BUILTIN_EXTENSIONS_CONNECTOR_NAME {
                tracing::warn!(
                    "ignoring user connector named {BUILTIN_EXTENSIONS_CONNECTOR_NAME:?}: the name is reserved for the built-in FalconDeck extensions bridge"
                );
                false
            } else {
                true
            }
        })
        .collect();
    servers.push(builtin_extensions_server(&daemon_executable(), spec));
    servers
}

/// The built-in connectors that apply to one provider spawn. Each is
/// independently optional: agent control and extension tools are separate
/// user-facing switches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuiltinConnectors {
    /// FalconDeck control server, when agent control is enabled.
    pub control: Option<BuiltinControlSpec>,
    /// FalconDeck extensions bridge, when any extension publishes a tool.
    pub extensions: Option<BuiltinExtensionsSpec>,
}

/// Appends every applicable built-in connector to a merged user list.
pub fn with_builtin_servers(
    servers: Vec<McpServerConfig>,
    builtin: &BuiltinConnectors,
) -> Vec<McpServerConfig> {
    let servers = with_builtin_control(servers, builtin.control.as_ref());
    with_builtin_extensions(servers, builtin.extensions.as_ref())
}

/// Resolves this daemon's own executable for built-in connector spawns.
fn daemon_executable() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_else(|error| {
        tracing::warn!(%error, "failed to resolve the daemon executable for a builtin connector");
        std::path::PathBuf::from("falcondeck-daemon")
    })
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
                (_, Some(url)) if !url.trim().is_empty() => {
                    let mut headers = entry.headers;
                    if entry.auth.as_deref() == Some("oauth") {
                        if let Some(token) = crate::connector_oauth::access_token(&name) {
                            headers
                                .entry("Authorization".to_string())
                                .or_insert_with(|| format!("Bearer {token}"));
                        } else {
                            tracing::warn!(
                                server = %name,
                                "oauth connector has no stored access token"
                            );
                        }
                    }
                    McpTransport::Http { url, headers }
                }
                _ => {
                    tracing::warn!(server = %name, "connectors.json entry has neither command nor url");
                    return None;
                }
            };
            Some(McpServerConfig { name, transport })
        })
        .collect()
}

/// JSON body for a Claude `--mcp-config` file. Always a document, including
/// `{"mcpServers":{}}` when nothing is configured, so `--strict-mcp-config`
/// can keep the user's global Claude MCP servers from leaking into a spawn.
pub fn claude_mcp_config_json(servers: &[McpServerConfig]) -> String {
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
    serde_json::to_string_pretty(&json!({ "mcpServers": Value::Object(map) }))
        .unwrap_or_else(|_| "{\"mcpServers\":{}}".to_string())
}

/// CLI-side MCP timeouts and output budgets applied to spawned agent
/// processes. Without these, long connector results get truncated or the
/// handshake dies while a slow remote MCP starts.
pub const MCP_CLI_TIMEOUT_ENV: &[(&str, &str)] = &[
    ("MCP_TIMEOUT", "30000"),
    ("MCP_TOOL_TIMEOUT", "10800000"),
    ("MAX_MCP_OUTPUT_TOKENS", "25000"),
];

/// Codex `-c` override so MCP tool payloads are not clipped at the default.
pub const CODEX_TOOL_OUTPUT_TOKEN_LIMIT_OVERRIDE: &str = "tool_output_token_limit=25000";

/// One-launch Claude `--mcp-config` file. Dropping the lease unlinks the file
/// only when the path still names the inode we created.
pub struct LeasedMcpConfig {
    path: PathBuf,
    #[cfg(unix)]
    identity: Option<UnixFileIdentity>,
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct UnixFileIdentity {
    device: u64,
    inode: u64,
    owner: u32,
}

impl LeasedMcpConfig {
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn release(&mut self) {
        #[cfg(unix)]
        {
            let Some(expected) = self.identity else {
                return;
            };
            if unix_file_identity(&self.path) != Some(expected) {
                return;
            }
        }
        let _ = std::fs::remove_file(&self.path);
        #[cfg(unix)]
        {
            self.identity = None;
        }
    }
}

impl Drop for LeasedMcpConfig {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(unix)]
fn unix_file_identity(path: &Path) -> Option<UnixFileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path).ok()?;
    Some(UnixFileIdentity {
        device: meta.dev(),
        inode: meta.ino(),
        owner: meta.uid(),
    })
}

/// Writes a unique 0400 `--mcp-config` file in `dir` (0700).
pub fn write_leased_claude_mcp_config(
    dir: &Path,
    body: &str,
) -> Result<LeasedMcpConfig, std::io::Error> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = dir.join(format!("claude-mcp-{}.json", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o400);
    }
    let mut file = options.open(&path)?;
    if let Err(error) = file.write_all(body.as_bytes()) {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400))
        {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        let identity = unix_file_identity(&path).ok_or_else(|| {
            let _ = std::fs::remove_file(&path);
            std::io::Error::other("failed to stat leased mcp config")
        })?;
        Ok(LeasedMcpConfig {
            path,
            identity: Some(identity),
        })
    }
    #[cfg(not(unix))]
    Ok(LeasedMcpConfig { path })
}

/// OpenCode `OPENCODE_CONFIG_CONTENT` overlay. Merges on top of the user's
/// `opencode.json`; it does not replace that file. Remote entries that already
/// carry an Authorization header disable OpenCode's own OAuth attempt.
pub fn opencode_config_content(servers: &[McpServerConfig]) -> String {
    let mut mcp = serde_json::Map::new();
    for server in servers {
        mcp.insert(server.name.clone(), opencode_mcp_entry(server));
    }
    json!({ "mcp": mcp }).to_string()
}

fn opencode_mcp_entry(server: &McpServerConfig) -> Value {
    match &server.transport {
        McpTransport::Stdio { command, args, env } => {
            let mut command_argv = vec![command.clone()];
            command_argv.extend(args.iter().cloned());
            json!({
                "type": "local",
                "command": command_argv,
                "environment": env,
                "enabled": true,
                "timeout": 10_800_000,
            })
        }
        McpTransport::Http { url, headers } => {
            let has_authorization = headers
                .keys()
                .any(|name| name.eq_ignore_ascii_case("Authorization"));
            json!({
                "type": "remote",
                "url": url,
                "headers": headers,
                "enabled": true,
                "oauth": !has_authorization,
                "timeout": 10_800_000,
            })
        }
    }
}

/// `mcpServers` array for an ACP session lifecycle request. Stdio is mandatory
/// in ACP; HTTP entries are included only after the agent advertises support.
pub fn acp_mcp_servers(servers: &[McpServerConfig], supports_http: bool) -> Value {
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
            McpTransport::Http { url, headers } if supports_http => Some(json!({
                "type": "http",
                "name": server.name,
                "url": url,
                "headers": headers
                    .iter()
                    .map(|(name, value)| json!({ "name": name, "value": value }))
                    .collect::<Vec<_>>(),
            })),
            McpTransport::Http { .. } => {
                tracing::info!(server = %server.name, "skipping http MCP server: ACP provider did not advertise HTTP transport");
                None
            }
        })
        .collect::<Vec<_>>();
    Value::Array(entries)
}

/// Codex app-server MCP injection: `-c` overrides plus env for Bearer tokens
/// so access tokens never appear on the process command line.
pub struct CodexMcpConfig {
    pub overrides: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// `-c key=value` config overrides for a Codex spawn.
#[cfg(test)]
pub fn codex_config_overrides(servers: &[McpServerConfig]) -> Vec<String> {
    codex_mcp_config(servers).overrides
}

pub fn codex_mcp_config(servers: &[McpServerConfig]) -> CodexMcpConfig {
    let mut overrides = Vec::new();
    let mut inject_env = BTreeMap::new();
    for server in servers {
        // Codex consumes these as `-c key=value`, split at the first '='.
        // A '=' inside the (user-controlled) server or env-var name would
        // corrupt the split and can fail the whole app-server spawn.
        if server.name.contains('=') {
            tracing::warn!(
                server = %server.name,
                "skipping MCP server for Codex: '=' in server name breaks -c overrides"
            );
            continue;
        }
        match &server.transport {
            McpTransport::Stdio { command, args, env } => {
                if env.keys().any(|name| name.contains('=')) {
                    tracing::warn!(
                        server = %server.name,
                        "skipping MCP server for Codex: '=' in env name breaks -c overrides"
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
                        .map(|(name, value)| {
                            format!("{}={}", toml_quoted_key(name), toml_string(value))
                        })
                        .collect::<Vec<_>>();
                    overrides.push(format!("mcp_servers.{key}.env={{{}}}", table.join(",")));
                }
            }
            McpTransport::Http { url, headers } => {
                let key = toml_quoted_key(&server.name);
                overrides.push(format!("mcp_servers.{key}.url={}", toml_string(url)));
                let mut extra_headers = BTreeMap::new();
                for (name, value) in headers {
                    if name.eq_ignore_ascii_case("Authorization")
                        && let Some(token) = value
                            .strip_prefix("Bearer ")
                            .or_else(|| value.strip_prefix("bearer "))
                    {
                        let env_name = codex_bearer_env_name(&server.name);
                        inject_env.insert(env_name.clone(), token.to_string());
                        overrides.push(format!(
                            "mcp_servers.{key}.bearer_token_env_var={}",
                            toml_string(&env_name)
                        ));
                    } else {
                        extra_headers.insert(name.clone(), value.clone());
                    }
                }
                if !extra_headers.is_empty() {
                    let table = extra_headers
                        .iter()
                        .map(|(name, value)| {
                            format!("{}={}", toml_quoted_key(name), toml_string(value))
                        })
                        .collect::<Vec<_>>();
                    overrides.push(format!(
                        "mcp_servers.{key}.http_headers={{{}}}",
                        table.join(",")
                    ));
                }
            }
        }
    }
    CodexMcpConfig {
        overrides,
        env: inject_env,
    }
}

fn codex_bearer_env_name(server: &str) -> String {
    let mut name = String::from("FALCONDECK_MCP_");
    for ch in server.chars() {
        if ch.is_ascii_alphanumeric() {
            name.push(ch.to_ascii_uppercase());
        } else {
            name.push('_');
        }
    }
    name.push_str("_TOKEN");
    name
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

/// Server names currently in the machine-global connectors file.
pub fn global_server_names() -> std::collections::BTreeSet<String> {
    read_connectors_file(&global_connectors_path())
        .into_keys()
        .collect()
}

/// Inserts or updates a global HTTP connector. Used by the catalog installer.
pub fn upsert_global_http_connector(
    name: &str,
    url: &str,
    auth: Option<&str>,
    headers: BTreeMap<String, String>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("connector name is required".to_string());
    }
    let path = global_connectors_path();
    let mut servers = read_connectors_file(&path);
    let mut extra = BTreeMap::new();
    let enabled = if let Some(existing) = servers.remove(name) {
        extra = existing.extra;
        existing.enabled
    } else {
        true
    };
    servers.insert(
        name.to_string(),
        ConnectorEntry {
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            url: Some(url.to_string()),
            headers,
            auth: auth.map(str::to_string),
            enabled,
            providers: Vec::new(),
            extra,
        },
    );
    let value = serde_json::to_value(&servers)
        .map_err(|error| format!("failed to encode connectors: {error}"))?;
    write_mcp_servers_at(&path, &value)
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
        let parsed: Value = serde_json::from_str(&claude_mcp_config_json(&servers)).unwrap();
        assert_eq!(parsed["mcpServers"]["local"]["command"], "npx");
        assert_eq!(parsed["mcpServers"]["remote"]["type"], "http");
        let empty: Value = serde_json::from_str(&claude_mcp_config_json(&[])).unwrap();
        assert_eq!(empty["mcpServers"], json!({}));
    }

    #[test]
    fn acp_servers_follow_negotiated_transports_and_use_name_value_pairs() {
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
                    headers: BTreeMap::from([(
                        "Authorization".to_string(),
                        "Bearer x".to_string(),
                    )]),
                },
            },
        ];
        let value = acp_mcp_servers(&servers, false);
        let list = value.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], "local");
        assert_eq!(list[0]["env"][0]["name"], "A");
        assert_eq!(list[0]["env"][0]["value"], "1");

        let value = acp_mcp_servers(&servers, true);
        let list = value.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1]["type"], "http");
        assert_eq!(list[1]["url"], "https://x");
        assert_eq!(list[1]["headers"][0]["name"], "Authorization");
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

    fn spec(thread_id: Option<&str>) -> BuiltinControlSpec {
        BuiltinControlSpec {
            daemon_url: "http://127.0.0.1:4123".to_string(),
            provider: "codex".to_string(),
            workspace_path: "/Users/james/Code/quizgecko".to_string(),
            thread_id: thread_id.map(str::to_string),
        }
    }

    #[test]
    fn builtin_control_server_is_a_stdio_daemon_invocation() {
        let server = builtin_control_server(
            std::path::Path::new("/opt/falcondeck-daemon"),
            &spec(Some("thread-7")),
        );
        assert_eq!(server.name, BUILTIN_CONNECTOR_NAME);
        let McpTransport::Stdio { command, args, env } = server.transport else {
            panic!("builtin connector is stdio");
        };
        assert_eq!(command, "/opt/falcondeck-daemon");
        assert_eq!(args, vec!["mcp".to_string()]);
        assert_eq!(
            env.get("FALCONDECK_DAEMON_URL").unwrap(),
            "http://127.0.0.1:4123"
        );
        assert_eq!(env.get("FALCONDECK_CONTROL_PROVIDER").unwrap(), "codex");
        assert_eq!(
            env.get("FALCONDECK_CONTROL_WORKSPACE").unwrap(),
            "/Users/james/Code/quizgecko"
        );
        assert_eq!(env.get("FALCONDECK_CONTROL_THREAD").unwrap(), "thread-7");
    }

    fn extensions_spec(thread_id: Option<&str>) -> BuiltinExtensionsSpec {
        BuiltinExtensionsSpec {
            daemon_url: "http://127.0.0.1:4123".to_string(),
            workspace_path: "/Users/james/Code/quizgecko".to_string(),
            thread_id: thread_id.map(str::to_string),
        }
    }

    #[test]
    fn builtin_extensions_bridge_is_a_stdio_daemon_invocation() {
        let server = builtin_extensions_server(
            std::path::Path::new("/opt/falcondeck-daemon"),
            &extensions_spec(Some("thread-7")),
        );
        assert_eq!(server.name, BUILTIN_EXTENSIONS_CONNECTOR_NAME);
        let McpTransport::Stdio { command, args, env } = server.transport else {
            panic!("the extensions bridge is stdio");
        };
        assert_eq!(command, "/opt/falcondeck-daemon");
        assert_eq!(args, vec!["mcp-extensions".to_string()]);
        assert_eq!(
            env.get(crate::extension_mcp::ENV_EXTENSION_WORKSPACE)
                .unwrap(),
            "/Users/james/Code/quizgecko"
        );
        assert_eq!(
            env.get(crate::extension_mcp::ENV_EXTENSION_THREAD).unwrap(),
            "thread-7"
        );
    }

    #[test]
    fn both_builtin_connectors_reach_every_provider_materialisation() {
        let builtin = BuiltinConnectors {
            control: Some(spec(None)),
            extensions: Some(extensions_spec(Some("thread-7"))),
        };
        let servers = with_builtin_servers(Vec::new(), &builtin);
        let names: Vec<&str> = servers.iter().map(|server| server.name.as_str()).collect();
        assert!(names.contains(&BUILTIN_CONNECTOR_NAME));
        assert!(names.contains(&BUILTIN_EXTENSIONS_CONNECTOR_NAME));

        let claude: Value = serde_json::from_str(&claude_mcp_config_json(&servers)).unwrap();
        assert_eq!(
            claude["mcpServers"][BUILTIN_EXTENSIONS_CONNECTOR_NAME]["args"],
            json!(["mcp-extensions"])
        );
        let acp = acp_mcp_servers(&servers, false);
        assert!(
            acp.as_array()
                .unwrap()
                .iter()
                .any(|server| server["name"] == json!(BUILTIN_EXTENSIONS_CONNECTOR_NAME))
        );
        let codex = codex_config_overrides(&servers);
        assert!(
            codex.iter().any(|entry| entry.contains("mcp-extensions")),
            "codex overrides carry the bridge: {codex:?}"
        );
    }

    #[test]
    fn each_builtin_connector_is_independently_optional() {
        // Agent control and extension tools are separate user-facing switches.
        let control_only = with_builtin_servers(
            Vec::new(),
            &BuiltinConnectors {
                control: Some(spec(None)),
                extensions: None,
            },
        );
        assert_eq!(control_only.len(), 1);
        assert_eq!(control_only[0].name, BUILTIN_CONNECTOR_NAME);

        let extensions_only = with_builtin_servers(
            Vec::new(),
            &BuiltinConnectors {
                control: None,
                extensions: Some(extensions_spec(None)),
            },
        );
        assert_eq!(extensions_only.len(), 1);
        assert_eq!(extensions_only[0].name, BUILTIN_EXTENSIONS_CONNECTOR_NAME);

        assert!(with_builtin_servers(Vec::new(), &BuiltinConnectors::default()).is_empty());
    }

    #[test]
    fn a_user_connector_cannot_shadow_the_extensions_bridge() {
        let impostor = vec![McpServerConfig {
            name: BUILTIN_EXTENSIONS_CONNECTOR_NAME.to_string(),
            transport: McpTransport::Stdio {
                command: "/tmp/evil".into(),
                args: Vec::new(),
                env: BTreeMap::new(),
            },
        }];
        let servers = with_builtin_extensions(impostor, Some(&extensions_spec(None)));
        assert_eq!(servers.len(), 1);
        let McpTransport::Stdio { args, .. } = &servers[0].transport else {
            panic!("the extensions bridge is stdio");
        };
        assert_eq!(args, &vec!["mcp-extensions".to_string()]);
    }

    #[test]
    fn builtin_connector_is_injected_for_every_provider_materialisation() {
        let user = vec![McpServerConfig {
            name: "linear".into(),
            transport: McpTransport::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "mcp-linear".into()],
                env: BTreeMap::new(),
            },
        }];
        let servers = with_builtin_control(user.clone(), Some(&spec(None)));

        // Claude --mcp-config JSON carries the falcondeck entry.
        let claude: Value = serde_json::from_str(&claude_mcp_config_json(&servers)).unwrap();
        assert_eq!(
            claude["mcpServers"][BUILTIN_CONNECTOR_NAME]["command"],
            json!(std::env::current_exe().unwrap().display().to_string())
        );
        assert_eq!(
            claude["mcpServers"][BUILTIN_CONNECTOR_NAME]["args"],
            json!(["mcp"])
        );
        assert!(
            claude["mcpServers"][BUILTIN_CONNECTOR_NAME]["env"]
                .get("FALCONDECK_CONTROL_PROVIDER")
                .is_some()
        );
        assert!(
            claude["mcpServers"].get("linear").is_some(),
            "user connectors remain"
        );

        // Codex -c overrides include the equivalent mcp_servers.falcondeck keys.
        let overrides = codex_config_overrides(&servers);
        assert!(
            overrides
                .iter()
                .any(|arg| arg.starts_with("mcp_servers.falcondeck.command="))
        );
        assert!(
            overrides
                .iter()
                .any(|arg| arg.starts_with("mcp_servers.falcondeck.env="))
        );

        // ACP session configuration includes the equivalent stdio entry.
        let acp = acp_mcp_servers(&servers, false);
        let entry = acp
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == json!(BUILTIN_CONNECTOR_NAME))
            .expect("builtin entry in ACP session config");
        assert_eq!(
            entry["command"],
            json!(std::env::current_exe().unwrap().display().to_string())
        );
        assert!(
            entry["env"]
                .as_array()
                .unwrap()
                .iter()
                .any(|pair| pair["name"] == json!("FALCONDECK_DAEMON_URL"))
        );
    }

    #[test]
    fn disabled_setting_omits_the_builtin_connector() {
        // A `None` spec (control disabled) leaves the user list untouched.
        let user = vec![McpServerConfig {
            name: "linear".into(),
            transport: McpTransport::Stdio {
                command: "npx".into(),
                args: vec![],
                env: BTreeMap::new(),
            },
        }];
        let servers = with_builtin_control(user.clone(), None);
        assert_eq!(servers, user);
        assert!(
            !servers
                .iter()
                .any(|server| server.name == BUILTIN_CONNECTOR_NAME)
        );
    }

    #[test]
    fn user_connector_cannot_override_the_reserved_name() {
        let attacker = vec![McpServerConfig {
            name: BUILTIN_CONNECTOR_NAME.into(),
            transport: McpTransport::Stdio {
                command: "evil-server".into(),
                args: vec![],
                env: BTreeMap::new(),
            },
        }];
        let servers = with_builtin_control(attacker, Some(&spec(None)));
        assert_eq!(servers.len(), 1, "the user entry is replaced, not merged");
        let McpTransport::Stdio { command, .. } = &servers[0].transport else {
            panic!("stdio");
        };
        assert_ne!(command, "evil-server");
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

    #[test]
    fn codex_http_servers_use_url_and_bearer_env() {
        let servers = vec![McpServerConfig {
            name: "notion".into(),
            transport: McpTransport::Http {
                url: "https://mcp.notion.com/mcp".into(),
                headers: BTreeMap::from([
                    (
                        "Authorization".to_string(),
                        "Bearer secret-token".to_string(),
                    ),
                    ("X-Region".to_string(), "us".to_string()),
                ]),
            },
        }];
        let config = codex_mcp_config(&servers);
        assert_eq!(
            config.overrides,
            vec![
                "mcp_servers.notion.url=\"https://mcp.notion.com/mcp\"".to_string(),
                "mcp_servers.notion.bearer_token_env_var=\"FALCONDECK_MCP_NOTION_TOKEN\""
                    .to_string(),
                "mcp_servers.notion.http_headers={X-Region=\"us\"}".to_string(),
            ]
        );
        assert_eq!(
            config
                .env
                .get("FALCONDECK_MCP_NOTION_TOKEN")
                .map(String::as_str),
            Some("secret-token")
        );
    }

    #[test]
    fn oauth_connectors_receive_stored_bearer_tokens() {
        let _lock = crate::connector_oauth::lock_store_for_test();
        let dir = tempfile::tempdir().unwrap();
        crate::connector_oauth::set_store_path_for_test(dir.path().join("oauth.json"));
        crate::connector_oauth::save_token(
            "notion",
            crate::connector_oauth::StoredToken {
                access_token: "ntn_live".into(),
                refresh_token: None,
                expires_at: None,
                token_endpoint: "https://mcp.notion.com/token".into(),
                client_id: "cid".into(),
            },
        )
        .unwrap();
        let connectors = write(
            dir.path(),
            r#"{"mcpServers":{"notion":{"url":"https://mcp.notion.com/mcp","auth":"oauth"}}}"#,
        );
        let servers =
            load_mcp_servers_from(&connectors, &dir.path().join("missing.json"), "claude");
        assert_eq!(servers.len(), 1);
        let McpTransport::Http { url, headers } = &servers[0].transport else {
            panic!("http");
        };
        assert_eq!(url, "https://mcp.notion.com/mcp");
        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("Bearer ntn_live")
        );
    }

    #[test]
    fn opencode_overlay_maps_stdio_and_bearer_http() {
        let servers = vec![
            McpServerConfig {
                name: "local".into(),
                transport: McpTransport::Stdio {
                    command: "npx".into(),
                    args: vec!["-y".into(), "s".into()],
                    env: BTreeMap::from([("K".to_string(), "v".to_string())]),
                },
            },
            McpServerConfig {
                name: "remote".into(),
                transport: McpTransport::Http {
                    url: "https://mcp.example.com/mcp".into(),
                    headers: BTreeMap::from([(
                        "Authorization".to_string(),
                        "Bearer tok".to_string(),
                    )]),
                },
            },
        ];
        let parsed: Value = serde_json::from_str(&opencode_config_content(&servers)).unwrap();
        assert_eq!(parsed["mcp"]["local"]["type"], json!("local"));
        assert_eq!(parsed["mcp"]["local"]["command"], json!(["npx", "-y", "s"]));
        assert_eq!(parsed["mcp"]["local"]["environment"]["K"], json!("v"));
        assert_eq!(parsed["mcp"]["remote"]["type"], json!("remote"));
        assert_eq!(parsed["mcp"]["remote"]["oauth"], json!(false));
        assert_eq!(
            parsed["mcp"]["remote"]["headers"]["Authorization"],
            json!("Bearer tok")
        );
    }

    #[test]
    fn leased_claude_config_is_unique_and_unlinked_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let first = write_leased_claude_mcp_config(dir.path(), "{\"mcpServers\":{}}").unwrap();
        let second = write_leased_claude_mcp_config(dir.path(), "{\"mcpServers\":{}}").unwrap();
        assert_ne!(first.path(), second.path());
        let first_path = first.path().to_path_buf();
        drop(first);
        assert!(!first_path.exists());
        assert!(second.path().exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(second.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o400);
        }
    }

    #[test]
    fn leased_claude_config_does_not_unlink_a_replaced_path() {
        let dir = tempfile::tempdir().unwrap();
        let lease = write_leased_claude_mcp_config(dir.path(), "original").unwrap();
        let path = lease.path().to_path_buf();
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, "replacement").unwrap();
        drop(lease);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "replacement");
    }
}
