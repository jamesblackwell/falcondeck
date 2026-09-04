//! Protocol types for creating, inspecting, and importing FalconDeck backups.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AgentProvider, FalconDeckPreferences, control};

/// Current backup file format schema version.
pub const BACKUP_SCHEMA_VERSION: u32 = 1;

/// Full backup document produced by FalconDeck.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FalconDeckBackup {
    /// Backup file format version.
    pub version: u32,
    /// ISO 8601 timestamp when the backup was created.
    pub created_at: DateTime<Utc>,
    /// FalconDeck app version that produced this backup.
    #[serde(default)]
    pub app_version: Option<String>,
    /// Core daemon state (workspaces, preferences, extensions, automations, connectors).
    pub daemon: DaemonBackupData,
    /// Optional client-side UI preferences (appearance, sounds, shortcuts, dictation).
    #[serde(default)]
    pub client: Option<ClientBackupData>,
}

impl FalconDeckBackup {
    /// Generates a preview summary of the backup, checking local path existence.
    pub fn summarize(&self) -> BackupSummary {
        let workspaces = self
            .daemon
            .workspaces
            .iter()
            .map(|ws| BackupWorkspaceStatus {
                path: ws.path.clone(),
                exists_on_disk: Path::new(&ws.path).is_dir(),
            })
            .collect::<Vec<_>>();

        let mut extension_keys = self
            .daemon
            .extensions
            .enabled
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for ext_id in self.daemon.extensions.storage.keys() {
            if !extension_keys.contains(ext_id) {
                extension_keys.push(ext_id.clone());
            }
        }
        extension_keys.sort();

        BackupSummary {
            version: self.version,
            created_at: self.created_at,
            app_version: self.app_version.clone(),
            workspace_count: workspaces.len(),
            workspaces,
            extension_count: extension_keys.len(),
            extensions: extension_keys,
            automation_count: self
                .daemon
                .control
                .as_ref()
                .map(|c| c.automations.len())
                .unwrap_or(0),
            connector_count: self.daemon.connectors.len(),
            provider_count: self.daemon.providers.len(),
            has_client_preferences: self.client.is_some(),
        }
    }
}

/// Daemon-owned backup data.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DaemonBackupData {
    /// Workspace preferences (colors, order, conversation defaults, notifications).
    pub preferences: FalconDeckPreferences,
    /// Registered workspaces with path, pins, archived status, etc.
    pub workspaces: Vec<WorkspaceBackupEntry>,
    /// Extensions state: enabled status, granted permissions, internal key-value storage.
    pub extensions: ExtensionsBackupData,
    /// Agent control: automations and settings.
    #[serde(default)]
    pub control: Option<ControlBackupData>,
    /// Custom MCP servers (from connectors.json).
    #[serde(default)]
    pub connectors: Vec<McpServerBackupEntry>,
    /// Custom ACP harness configurations (from providers.json).
    #[serde(default)]
    pub providers: Vec<AcpProviderBackupEntry>,
}

/// Backup record for a single workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceBackupEntry {
    /// Absolute path to project folder on disk.
    pub path: String,
    /// Stable workspace ID if known.
    #[serde(default)]
    pub id: Option<String>,
    /// Whether project is pinned or shown in sidebar.
    #[serde(default = "default_true")]
    pub in_sidebar: bool,
    /// Default agent provider for this workspace.
    #[serde(default)]
    pub default_provider: Option<AgentProvider>,
    /// Pinned thread IDs.
    #[serde(default)]
    pub pinned_thread_ids: Vec<String>,
    /// Project pinned thread IDs.
    #[serde(default)]
    pub project_pinned_thread_ids: Vec<String>,
    /// Archived thread IDs.
    #[serde(default)]
    pub archived_thread_ids: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// Backup record for installed extensions and their durable data.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ExtensionsBackupData {
    /// Enabled extension IDs.
    #[serde(default)]
    pub enabled: HashMap<String, bool>,
    /// Granted permissions per extension ID.
    #[serde(default)]
    pub grants: HashMap<String, BTreeSet<String>>,
    /// Extension key-value storage (Notes content, Missions, tags, etc.).
    #[serde(default)]
    pub storage: HashMap<String, BTreeMap<String, Value>>,
}

/// Backup record for agent control and scheduled automations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ControlBackupData {
    /// Global agent control settings.
    #[serde(default)]
    pub settings: Option<control::AgentControlSettings>,
    /// Registered automations.
    #[serde(default)]
    pub automations: Vec<control::Automation>,
}

/// Backup record for an MCP connector server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerBackupEntry {
    /// Server identifier name.
    pub name: String,
    /// Executable command for stdio servers.
    #[serde(default)]
    pub command: Option<String>,
    /// Command line arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// HTTP/SSE endpoint URL for remote servers.
    #[serde(default)]
    pub url: Option<String>,
    /// Headers for remote servers.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Whether this connector is disabled.
    #[serde(default)]
    pub disabled: bool,
}

/// Backup record for an ACP provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcpProviderBackupEntry {
    /// Stable provider identifier.
    pub id: String,
    /// User-facing display label.
    #[serde(default)]
    pub label: String,
    /// Command line to spawn.
    pub command: Vec<String>,
    /// Environment variable overrides.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Optional transport selection (e.g. "native" or "acp").
    #[serde(default)]
    pub transport: Option<String>,
}

/// Backup record for client-side WebKit preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ClientBackupData {
    /// Appearance preferences (theme, palette, typography, sizing).
    #[serde(default)]
    pub appearance: Option<Value>,
    /// Sound preferences (pack, volume, muted).
    #[serde(default)]
    pub sounds: Option<Value>,
    /// Custom keyboard shortcut bindings.
    #[serde(default)]
    pub shortcuts: Option<Value>,
    /// Dictation preferences.
    #[serde(default)]
    pub dictation: Option<Value>,
    /// Additional desktop UI preferences.
    #[serde(default)]
    pub ui_preferences: Option<Value>,
}

/// Preview summary of a backup file, used by the UI before confirming import.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BackupSummary {
    /// Backup file schema version.
    pub version: u32,
    /// When the backup was generated.
    pub created_at: DateTime<Utc>,
    /// App version that created the backup.
    pub app_version: Option<String>,
    /// Total number of workspaces in the backup.
    pub workspace_count: usize,
    /// Individual workspaces and their local on-disk existence status.
    pub workspaces: Vec<BackupWorkspaceStatus>,
    /// Total number of extensions with configured state or storage.
    pub extension_count: usize,
    /// IDs of extensions included in the backup.
    pub extensions: Vec<String>,
    /// Total number of automations.
    pub automation_count: usize,
    /// Total number of MCP connectors.
    pub connector_count: usize,
    /// Total number of ACP providers.
    pub provider_count: usize,
    /// Whether client UI preferences are included.
    pub has_client_preferences: bool,
}

/// Status of a workspace contained in a backup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackupWorkspaceStatus {
    /// Folder path on disk.
    pub path: String,
    /// Whether this folder currently exists on the local machine.
    pub exists_on_disk: bool,
}

/// Request to import a backup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportBackupRequest {
    /// Full backup document to import.
    pub backup: FalconDeckBackup,
    /// Remap project paths from old backup path to new local path (if directory was moved/renamed).
    #[serde(default)]
    pub path_mappings: HashMap<String, String>,
}

/// Result of importing a backup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ImportBackupResponse {
    /// Number of workspaces successfully imported and registered.
    pub workspaces_imported: usize,
    /// Number of workspaces skipped (e.g. already registered or invalid).
    pub workspaces_skipped: usize,
    /// Number of extensions whose state or data was imported.
    pub extensions_imported: usize,
    /// Number of automations imported.
    pub automations_imported: usize,
    /// Number of MCP connectors imported.
    pub connectors_imported: usize,
    /// Number of ACP providers imported.
    pub providers_imported: usize,
    /// Whether preferences were updated from the backup.
    pub preferences_restored: bool,
}
