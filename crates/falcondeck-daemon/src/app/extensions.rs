use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::LazyLock,
};

use chrono::Utc;
use falcondeck_core::{
    ComposerSuggestionSet, ExtensionActionContribution, ExtensionAgentTool,
    ExtensionAgentToolContribution, ExtensionContributions, ExtensionSnapshot, ExtensionStatus,
    ExtensionSummary, ExtensionUiDocument, ExtensionUiNode, ExtensionView,
    ExtensionViewContribution, ExtensionViewScope,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::storage::write_atomically;
use crate::error::DaemonError;

const MAX_ACTION_INPUT_BYTES: usize = 64 * 1024;
const MAX_EXTENSION_STORAGE_BYTES: usize = 512 * 1024;
const MAX_VIEW_BYTES: usize = 16 * 1024;
const MAX_PUBLISHED_VIEWS_PER_ACTION: usize = 256;
const MAX_EXTENSION_VIEW_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SCOPE_KIND_CHARS: usize = 64;
const MAX_SCOPE_ID_CHARS: usize = 512;
const LEGACY_SCRATCH_PAD_ID: &str = "falcondeck.scratch-pad";
const NOTES_ID: &str = "falcondeck.notes";
const MISSIONS_ID: &str = "falcondeck.missions";
const MISSIONS_CREATE_TOOL_ID: &str = "create-mission";
const MAX_CATALOG_PACKAGES: usize = 128;
const MAX_CATALOG_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_MANIFEST_CONTRIBUTIONS: usize = 256;
const MAX_UI_DEPTH: usize = 32;
const MAX_UI_NODES: usize = 256;
const MAX_UI_OPTIONS: usize = 256;
const MAX_UI_TEXT_CHARS: usize = 4_096;
const MAX_UI_PATH_SEGMENTS: usize = 16;
const MAX_UI_PATH_SEGMENT_CHARS: usize = 128;
const MAX_MANIFEST_PERMISSIONS: usize = 16;
const MAX_AGENT_TOOLS_PER_EXTENSION: usize = 8;
const MAX_AGENT_TOOL_TITLE_CHARS: usize = 60;
const MAX_AGENT_TOOL_DESCRIPTION_CHARS: usize = 1_024;
const MAX_AGENT_TOOL_SCHEMA_BYTES: usize = 8 * 1024;
pub(super) const MAX_TOOL_ARGUMENT_BYTES: usize = 64 * 1024;
pub(super) const THREADS_READ_PERMISSION: &str = "threads:read";
/// Lets an extension publish manifest-declared tools to agent harnesses.
pub(super) const AGENT_TOOLS_PERMISSION: &str = "agent-tools:register";
/// Lets an extension create and manage only Automations carrying its owner id.
pub(super) const AUTOMATIONS_PERMISSION: &str = "automations:manage-owned";
const SUPPORTED_PERMISSIONS: &[&str] = &[
    THREADS_READ_PERMISSION,
    AGENT_TOOLS_PERMISSION,
    AUTOMATIONS_PERMISSION,
];
/// Clients qualify MCP tools as `{server}__{name}`. A `__` inside `name`
/// makes that qualifier ambiguous, and Grok skips the tool. After sanitizing
/// `.`/`-` to `_`, neither half contains `-`, so a hyphen is unambiguous.
const TOOL_NAME_SEPARATOR: &str = "-";
/// Grok rejects qualified names longer than 64 characters
/// (`^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$` on `falcondeck-extensions__{name}`).
/// `falcondeck-extensions__` is 23 characters, leaving 41 for the tool name.
const MAX_PUBLISHED_AGENT_TOOL_NAME_CHARS: usize = 41;
const EXTENSION_PANEL_ICONS: &[&str] = &[
    "activity",
    "blocks",
    "clock",
    "file-text",
    "kanban",
    "notebook",
    "notebook-pen",
    "sticky-note",
];

static EXTENSION_ID_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z0-9]+(?:[.-][a-z0-9]+)+$").expect("extension id regex is valid")
});
static CONTRIBUTION_ID_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$").expect("contribution id regex is valid")
});
static VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
        .expect("extension version regex is valid")
});
static ENGINE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\^?0\.1(?:\.[0-9]+)?$").expect("extension engine regex is valid")
});

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtensionCatalogFile {
    packages: Vec<ExtensionCatalogEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtensionCatalogEntry {
    path: String,
    #[serde(default)]
    default_enabled: bool,
    /// Permissions granted on first discovery for bundled official packages.
    /// Distribution policy, not something a manifest can claim for itself.
    #[serde(default)]
    default_granted_permissions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionManifest {
    #[serde(rename = "$schema")]
    _schema: Option<String>,
    id: String,
    name: String,
    version: String,
    engines: ExtensionEngines,
    entrypoint: String,
    #[serde(default)]
    frontend: Option<String>,
    contributes: ExtensionContributions,
    permissions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionEngines {
    falcondeck: String,
}

#[derive(Debug, Clone)]
pub(super) struct ExtensionPackage {
    pub(super) id: String,
    pub(super) entrypoint: PathBuf,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PersistedExtensionState {
    #[serde(default)]
    enabled: HashMap<String, bool>,
    #[serde(default)]
    grants: HashMap<String, BTreeSet<String>>,
    #[serde(default)]
    storage: HashMap<String, BTreeMap<String, Value>>,
    #[serde(default)]
    views: BTreeMap<String, ExtensionView>,
}

pub(super) struct ExtensionRegistry {
    state_path: PathBuf,
    root: PathBuf,
    summaries: HashMap<String, ExtensionSummary>,
    packages: HashMap<String, ExtensionPackage>,
    persisted: PersistedExtensionState,
    manages_bundled_root: bool,
}

impl ExtensionRegistry {
    pub(super) fn new(daemon_state_path: &Path) -> Self {
        let state_dir = daemon_state_path.parent().unwrap_or_else(|| Path::new("."));
        let (root, manages_bundled_root) = extension_root(state_dir);
        Self {
            state_path: state_dir.join("extensions-state.json"),
            root,
            summaries: HashMap::new(),
            packages: HashMap::new(),
            persisted: PersistedExtensionState::default(),
            manages_bundled_root,
        }
    }

    pub(super) async fn restore(&mut self) -> Result<(), DaemonError> {
        self.ensure_bundled_assets().await?;
        self.persisted = match tokio::fs::read_to_string(&self.state_path).await {
            Ok(contents) => serde_json::from_str(&contents)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                PersistedExtensionState::default()
            }
            Err(error) => return Err(error.into()),
        };
        migrate_scratch_pad_to_notes(&mut self.persisted);
        self.discover().await?;
        self.persist().await
    }

    async fn ensure_bundled_assets(&self) -> Result<(), DaemonError> {
        let state_dir = self.state_path.parent().unwrap_or_else(|| Path::new("."));
        tokio::fs::create_dir_all(state_dir).await?;
        let canonical_state_dir = tokio::fs::canonicalize(state_dir).await?;
        let mut assets = vec![
            (
                state_dir.join("packages/extension-sdk/src/index.ts"),
                include_str!("../../../../packages/extension-sdk/src/index.ts"),
            ),
            (
                state_dir.join("extension-host/main.ts"),
                include_str!("../../../../apps/extension-host/main.ts"),
            ),
            (
                state_dir.join("extension-host/import-map.json"),
                include_str!("../../../../apps/extension-host/import-map.json"),
            ),
        ];
        if self.manages_bundled_root {
            assets.extend([
                (
                    self.root.join("catalog.json"),
                    include_str!("../../../../extensions/catalog.json"),
                ),
                (
                    self.root
                        .join("official/thread-tags/falcondeck.extension.json"),
                    include_str!(
                        "../../../../extensions/official/thread-tags/falcondeck.extension.json"
                    ),
                ),
                (
                    self.root.join("official/thread-tags/server.ts"),
                    include_str!("../../../../extensions/official/thread-tags/server.ts"),
                ),
                (
                    self.root.join("official/thread-tags/app.tsx"),
                    include_str!("../../../../extensions/official/thread-tags/app.tsx"),
                ),
                (
                    self.root
                        .join("official/notes/falcondeck.extension.json"),
                    include_str!(
                        "../../../../extensions/official/notes/falcondeck.extension.json"
                    ),
                ),
                (
                    self.root.join("official/notes/server.ts"),
                    include_str!("../../../../extensions/official/notes/server.ts"),
                ),
                (
                    self.root.join("official/notes/app.tsx"),
                    include_str!("../../../../extensions/official/notes/app.tsx"),
                ),
                (
                    self.root
                        .join("official/follow-up-suggestions/falcondeck.extension.json"),
                    include_str!(
                        "../../../../extensions/official/follow-up-suggestions/falcondeck.extension.json"
                    ),
                ),
                (
                    self.root.join("official/follow-up-suggestions/server.ts"),
                    include_str!(
                        "../../../../extensions/official/follow-up-suggestions/server.ts"
                    ),
                ),
                (
                    self.root
                        .join("official/mini-zen/falcondeck.extension.json"),
                    include_str!(
                        "../../../../extensions/official/mini-zen/falcondeck.extension.json"
                    ),
                ),
                (
                    self.root.join("official/mini-zen/server.ts"),
                    include_str!("../../../../extensions/official/mini-zen/server.ts"),
                ),
                (
                    self.root
                        .join("official/missions/falcondeck.extension.json"),
                    include_str!(
                        "../../../../extensions/official/missions/falcondeck.extension.json"
                    ),
                ),
                (
                    self.root.join("official/missions/server.ts"),
                    include_str!("../../../../extensions/official/missions/server.ts"),
                ),
            ]);
            // Scratch pad shipped as its own package directory; nothing reads
            // it once the catalog points at Notes, so clear it out.
            let _ = tokio::fs::remove_dir_all(self.root.join("official/scratch-pad")).await;
        }
        for (path, contents) in assets {
            write_bundled_asset(&canonical_state_dir, &path, contents).await?;
        }
        Ok(())
    }

    async fn discover(&mut self) -> Result<(), DaemonError> {
        let canonical_root = tokio::fs::canonicalize(&self.root).await.map_err(|error| {
            DaemonError::Process(format!(
                "failed to resolve extension root {}: {error}",
                self.root.display()
            ))
        })?;
        let catalog_path =
            resolve_existing_package_path(&canonical_root, "catalog.json", "extension catalog")
                .await?;
        if !catalog_path.is_file() {
            return Err(DaemonError::BadRequest(format!(
                "extension catalog is not a file: {}",
                catalog_path.display()
            )));
        }
        let contents =
            read_bounded_text(&catalog_path, MAX_CATALOG_BYTES, "extension catalog").await?;
        let catalog: ExtensionCatalogFile = serde_json::from_str(&contents)?;
        if catalog.packages.len() > MAX_CATALOG_PACKAGES {
            return Err(DaemonError::BadRequest(format!(
                "extension catalog exceeds {MAX_CATALOG_PACKAGES} packages"
            )));
        }
        let mut summaries = HashMap::new();
        let mut packages = HashMap::new();
        for entry in catalog.packages {
            let package_root =
                resolve_existing_package_path(&canonical_root, &entry.path, "extension package")
                    .await?;
            if !package_root.is_dir() {
                return Err(DaemonError::BadRequest(format!(
                    "extension package is not a directory: {}",
                    package_root.display()
                )));
            }
            let manifest_path = resolve_existing_package_path(
                &package_root,
                "falcondeck.extension.json",
                "extension manifest",
            )
            .await?;
            if !manifest_path.is_file() {
                return Err(DaemonError::BadRequest(format!(
                    "extension manifest is not a file: {}",
                    manifest_path.display()
                )));
            }
            let contents =
                read_bounded_text(&manifest_path, MAX_MANIFEST_BYTES, "extension manifest").await?;
            let manifest_value: Value = serde_json::from_str(&contents)?;
            validate_manifest_contribution_shape(&manifest_value)?;
            let manifest: ExtensionManifest = serde_json::from_value(manifest_value)?;
            validate_manifest(&manifest)?;
            if summaries.contains_key(&manifest.id) {
                return Err(DaemonError::BadRequest(format!(
                    "duplicate extension id in catalog: {}",
                    manifest.id
                )));
            }
            let entrypoint = resolve_existing_package_path(
                &package_root,
                &manifest.entrypoint,
                "extension entrypoint",
            )
            .await?;
            if !entrypoint.is_file() {
                return Err(DaemonError::BadRequest(format!(
                    "extension entrypoint is not a file: {}",
                    entrypoint.display()
                )));
            }
            if let Some(frontend) = manifest.frontend.as_deref() {
                let frontend =
                    resolve_existing_package_path(&package_root, frontend, "extension frontend")
                        .await?;
                if !frontend.is_file() {
                    return Err(DaemonError::BadRequest(format!(
                        "extension frontend is not a file: {}",
                        frontend.display()
                    )));
                }
            }
            let enabled = self
                .persisted
                .enabled
                .get(&manifest.id)
                .copied()
                .unwrap_or(entry.default_enabled);
            self.persisted.enabled.insert(manifest.id.clone(), enabled);
            let declared_permissions = manifest
                .permissions
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>();
            // A package the user has never seen starts from catalog policy;
            // afterwards the daemon-owned grant set is the only authority, so
            // a revoked permission is never silently re-granted.
            let first_discovery = !self.persisted.grants.contains_key(&manifest.id);
            let granted_permissions = self
                .persisted
                .grants
                .entry(manifest.id.clone())
                .or_default();
            if first_discovery {
                granted_permissions.extend(entry.default_granted_permissions.iter().cloned());
            }
            granted_permissions.retain(|permission| declared_permissions.contains(permission));
            let granted_permissions = granted_permissions.iter().cloned().collect::<Vec<_>>();
            let status = if enabled {
                ExtensionStatus::Active
            } else {
                ExtensionStatus::Disabled
            };
            let summary = ExtensionSummary {
                id: manifest.id.clone(),
                name: manifest.name,
                version: manifest.version,
                source: "bundled".to_string(),
                bundled: true,
                enabled,
                status,
                last_error: None,
                contributes: manifest.contributes,
                permissions: manifest.permissions,
                granted_permissions,
            };
            packages.insert(
                manifest.id.clone(),
                ExtensionPackage {
                    id: manifest.id.clone(),
                    entrypoint,
                },
            );
            summaries.insert(manifest.id, summary);
        }
        self.summaries = summaries;
        self.packages = packages;
        Ok(())
    }

    pub(super) fn snapshot(&self) -> ExtensionSnapshot {
        let mut catalog = self.summaries.values().cloned().collect::<Vec<_>>();
        catalog.sort_by(|left, right| left.name.cmp(&right.name));
        ExtensionSnapshot {
            catalog,
            views: self
                .persisted
                .views
                .values()
                .filter(|view| {
                    self.summaries
                        .get(&view.extension_id)
                        .is_some_and(|extension| extension.enabled)
                })
                .cloned()
                .collect(),
        }
    }

    pub(super) fn package(
        &self,
        extension_id: &str,
        action_id: &str,
    ) -> Result<ExtensionPackage, DaemonError> {
        let summary = self
            .summaries
            .get(extension_id)
            .ok_or_else(|| DaemonError::NotFound("extension not found".to_string()))?;
        if !summary.enabled {
            return Err(DaemonError::BadRequest("extension is disabled".to_string()));
        }
        if !summary
            .contributes
            .thread_menu_actions
            .iter()
            .chain(summary.contributes.panel_actions.iter())
            .any(|action| action.id == action_id)
        {
            return Err(DaemonError::NotFound(
                "extension action is not declared by the manifest".to_string(),
            ));
        }
        self.packages
            .get(extension_id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("extension package not found".to_string()))
    }

    /// The agent tools currently publishable to harnesses: declared by an
    /// enabled extension that also holds the `agent-tools:register` grant.
    /// Both conditions are re-checked at every list and every invocation, so
    /// disabling or revoking takes effect without restarting anything.
    pub(super) fn agent_tools(&self) -> Vec<ExtensionAgentTool> {
        let mut tools = self
            .summaries
            .values()
            .filter(|summary| {
                summary.enabled
                    && summary
                        .granted_permissions
                        .iter()
                        .any(|granted| granted == AGENT_TOOLS_PERMISSION)
            })
            .flat_map(|summary| {
                summary
                    .contributes
                    .agent_tools
                    .iter()
                    .map(|tool| ExtensionAgentTool {
                        name: agent_tool_name(&summary.id, &tool.id),
                        extension_id: summary.id.clone(),
                        tool_id: tool.id.clone(),
                        title: tool.title.clone(),
                        description: tool.description.clone(),
                        input_schema: tool.input_schema.clone(),
                    })
            })
            .collect::<Vec<_>>();
        tools.sort_by(|left, right| left.name.cmp(&right.name));
        tools
    }

    /// Mission instructions should enter an agent's context only when the
    /// extension can actually create and update its durable project. This prevents a stale
    /// prompt from advertising a feature whose tool or required projections
    /// the user has disabled.
    pub(super) fn missions_agent_context_available(&self) -> bool {
        self.has_grant(MISSIONS_ID, THREADS_READ_PERMISSION)
            && self.has_grant(MISSIONS_ID, AGENT_TOOLS_PERMISSION)
            && self.agent_tools().iter().any(|tool| {
                tool.extension_id == MISSIONS_ID && tool.tool_id == MISSIONS_CREATE_TOOL_ID
            })
    }

    /// Resolves one MCP tool name to its package, failing closed when the
    /// extension is unknown, disabled, ungranted, or never declared the tool.
    pub(super) fn tool_package(
        &self,
        tool_name: &str,
    ) -> Result<(ExtensionPackage, String), DaemonError> {
        let tool = self
            .agent_tools()
            .into_iter()
            .find(|tool| tool.name == tool_name)
            .ok_or_else(|| {
                DaemonError::NotFound(format!("unknown FalconDeck extension tool: {tool_name}"))
            })?;
        let package = self
            .packages
            .get(&tool.extension_id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("extension package not found".to_string()))?;
        Ok((package, tool.tool_id))
    }

    pub(super) fn contains_extension(&self, extension_id: &str) -> bool {
        self.summaries.contains_key(extension_id)
    }

    pub(super) fn enabled_packages(&self) -> Vec<ExtensionPackage> {
        self.packages
            .iter()
            .filter(|(extension_id, _)| {
                self.summaries
                    .get(*extension_id)
                    .is_some_and(|summary| summary.enabled)
            })
            .map(|(_, package)| package.clone())
            .collect()
    }

    pub(super) fn is_enabled(&self, extension_id: &str) -> bool {
        self.summaries
            .get(extension_id)
            .is_some_and(|summary| summary.enabled)
    }

    pub(super) fn has_grant(&self, extension_id: &str, permission: &str) -> bool {
        self.summaries.get(extension_id).is_some_and(|summary| {
            summary.enabled
                && summary
                    .granted_permissions
                    .iter()
                    .any(|granted| granted == permission)
        })
    }

    pub(super) fn permission_granted(&self, extension_id: &str, permission: &str) -> bool {
        self.summaries.get(extension_id).is_some_and(|summary| {
            summary
                .granted_permissions
                .iter()
                .any(|granted| granted == permission)
        })
    }

    pub(super) fn storage(&self, extension_id: &str) -> BTreeMap<String, Value> {
        self.persisted
            .storage
            .get(extension_id)
            .cloned()
            .unwrap_or_default()
    }

    pub(super) fn retained_views(&self, extension_id: &str) -> Vec<ExtensionView> {
        self.persisted
            .views
            .values()
            .filter(|view| view.extension_id == extension_id)
            .cloned()
            .collect()
    }

    pub(super) fn backup_data(&self) -> falcondeck_core::ExtensionsBackupData {
        falcondeck_core::ExtensionsBackupData {
            enabled: self.persisted.enabled.clone(),
            grants: self.persisted.grants.clone(),
            storage: self.persisted.storage.clone(),
        }
    }

    pub(super) async fn restore_backup_data(
        &mut self,
        data: falcondeck_core::ExtensionsBackupData,
    ) -> Result<usize, DaemonError> {
        let mut count = 0;
        for (id, enabled) in data.enabled {
            self.persisted.enabled.insert(id, enabled);
            count += 1;
        }
        for (id, grants) in data.grants {
            self.persisted.grants.insert(id, grants);
        }
        for (id, storage) in data.storage {
            self.persisted.storage.insert(id, storage);
        }
        let _ = self.discover().await;
        self.persist().await?;
        Ok(count)
    }

    pub(super) fn validate_action_input(input: &Value) -> Result<(), DaemonError> {
        if serde_json::to_vec(input)?.len() > MAX_ACTION_INPUT_BYTES {
            return Err(DaemonError::BadRequest(format!(
                "extension action input exceeds {MAX_ACTION_INPUT_BYTES} bytes"
            )));
        }
        Ok(())
    }

    pub(super) fn validate_action_target(
        target: Option<&ExtensionViewScope>,
    ) -> Result<(), DaemonError> {
        if let Some(scope) = target {
            validate_scope(scope)?;
        }
        Ok(())
    }

    pub(super) async fn update_enabled(
        &mut self,
        extension_id: &str,
        enabled: bool,
    ) -> Result<ExtensionSummary, DaemonError> {
        let summary = self
            .summaries
            .get(extension_id)
            .ok_or_else(|| DaemonError::NotFound("extension not found".to_string()))?;
        if summary.enabled == enabled && summary.last_error.is_none() {
            return Ok(summary.clone());
        }
        let mut persisted = self.persisted.clone();
        persisted.enabled.insert(extension_id.to_string(), enabled);
        self.persist_state(&persisted).await?;
        self.persisted = persisted;
        let summary = self
            .summaries
            .get_mut(extension_id)
            .expect("extension existence was checked before persistence");
        summary.enabled = enabled;
        summary.status = if enabled {
            ExtensionStatus::Active
        } else {
            ExtensionStatus::Disabled
        };
        summary.last_error = None;
        let updated = summary.clone();
        Ok(updated)
    }

    pub(super) async fn update_permission(
        &mut self,
        extension_id: &str,
        permission: &str,
        granted: bool,
    ) -> Result<ExtensionSummary, DaemonError> {
        let summary = self
            .summaries
            .get(extension_id)
            .ok_or_else(|| DaemonError::NotFound("extension not found".to_string()))?;
        if !summary
            .permissions
            .iter()
            .any(|declared| declared == permission)
        {
            return Err(DaemonError::BadRequest(
                "extension permission is not declared by the manifest".to_string(),
            ));
        }
        let currently_granted = summary
            .granted_permissions
            .iter()
            .any(|current| current == permission);
        if currently_granted == granted {
            return Ok(summary.clone());
        }

        let mut persisted = self.persisted.clone();
        let grants = persisted
            .grants
            .entry(extension_id.to_string())
            .or_default();
        if granted {
            grants.insert(permission.to_string());
        } else {
            grants.remove(permission);
            // View data can have been derived from the revoked capability.
            // The daemon cannot safely distinguish those projections, so it
            // retracts all synchronized views while retaining private state.
            persisted
                .views
                .retain(|_, view| view.extension_id != extension_id);
        }
        self.persist_state(&persisted).await?;
        self.persisted = persisted;

        let summary = self
            .summaries
            .get_mut(extension_id)
            .expect("extension existence was checked before persistence");
        summary.granted_permissions = self
            .persisted
            .grants
            .get(extension_id)
            .into_iter()
            .flatten()
            .cloned()
            .collect();
        let resolved_error = format!("{permission} permission is not granted");
        if granted
            && summary.enabled
            && summary.last_error.as_deref() == Some(resolved_error.as_str())
        {
            summary.status = ExtensionStatus::Active;
            summary.last_error = None;
        }
        Ok(summary.clone())
    }

    pub(super) async fn mark_error(
        &mut self,
        extension_id: &str,
        error: &str,
    ) -> Result<(), DaemonError> {
        if let Some(summary) = self
            .summaries
            .get_mut(extension_id)
            .filter(|summary| summary.enabled)
        {
            summary.status = ExtensionStatus::Error;
            summary.last_error = Some(error.chars().take(1_024).collect());
        }
        Ok(())
    }

    pub(super) async fn commit_action(
        &mut self,
        extension_id: &str,
        storage: BTreeMap<String, Value>,
        published_views: Vec<PublishedExtensionView>,
    ) -> Result<Vec<ExtensionView>, DaemonError> {
        if serde_json::to_vec(&storage)?.len() > MAX_EXTENSION_STORAGE_BYTES {
            return Err(DaemonError::BadRequest(format!(
                "extension storage exceeds {MAX_EXTENSION_STORAGE_BYTES} bytes"
            )));
        }
        if published_views.len() > MAX_PUBLISHED_VIEWS_PER_ACTION {
            return Err(DaemonError::BadRequest(format!(
                "extension action published more than {MAX_PUBLISHED_VIEWS_PER_ACTION} views"
            )));
        }
        let declared_views = self
            .summaries
            .get(extension_id)
            .map(|summary| {
                summary
                    .contributes
                    .thread_decorations
                    .iter()
                    .chain(summary.contributes.sidebar_filters.iter())
                    .chain(summary.contributes.panels.iter())
                    .chain(summary.contributes.composer_suggestions.iter())
                    .map(|contribution| contribution.view.as_str())
                    .collect::<std::collections::HashSet<_>>()
            })
            .ok_or_else(|| DaemonError::NotFound("extension not found".to_string()))?;
        let suggestion_views = self
            .summaries
            .get(extension_id)
            .map(|summary| {
                summary
                    .contributes
                    .composer_suggestions
                    .iter()
                    .map(|contribution| contribution.view.as_str())
                    .collect::<std::collections::HashSet<_>>()
            })
            .unwrap_or_default();
        for published in &published_views {
            if !declared_views.contains(published.view_id.as_str()) {
                return Err(DaemonError::BadRequest(format!(
                    "extension published undeclared view: {}",
                    published.view_id
                )));
            }
            if suggestion_views.contains(published.view_id.as_str()) {
                validate_composer_suggestion_view(published)?;
            }
            if let Some(scope) = published.scope.as_ref() {
                validate_scope(scope)?;
            }
            if serde_json::to_vec(&published.value)?.len() > MAX_VIEW_BYTES {
                return Err(DaemonError::BadRequest(format!(
                    "extension view exceeds {MAX_VIEW_BYTES} bytes"
                )));
            }
        }
        let mut persisted = self.persisted.clone();
        let storage_changed = persisted
            .storage
            .get(extension_id)
            .is_none_or(|current| current != &storage);
        let mut updated_views = Vec::with_capacity(published_views.len());
        for published in published_views {
            let view = ExtensionView {
                extension_id: extension_id.to_string(),
                view_id: published.view_id,
                scope: published.scope,
                value: published.value,
                updated_at: Utc::now(),
            };
            let key = extension_view_key(&view.extension_id, &view.view_id, view.scope.as_ref());
            if persisted
                .views
                .get(&key)
                .is_some_and(|current| current.value == view.value)
            {
                continue;
            }
            persisted.views.insert(key, view.clone());
            updated_views.push(view);
        }
        if storage_changed {
            persisted.storage.insert(extension_id.to_string(), storage);
        }
        let extension_view_bytes = persisted
            .views
            .values()
            .filter(|view| view.extension_id == extension_id)
            .try_fold(0usize, |total, view| {
                serde_json::to_vec(view).map(|encoded| total.saturating_add(encoded.len()))
            })?;
        if extension_view_bytes > MAX_EXTENSION_VIEW_STATE_BYTES {
            return Err(DaemonError::BadRequest(format!(
                "extension view state exceeds {MAX_EXTENSION_VIEW_STATE_BYTES} bytes"
            )));
        }
        let status_changed = self.summaries.get(extension_id).is_some_and(|summary| {
            summary.status != ExtensionStatus::Active || summary.last_error.is_some()
        });
        if storage_changed || !updated_views.is_empty() {
            self.persist_state(&persisted).await?;
            self.persisted = persisted;
        }
        if status_changed && let Some(summary) = self.summaries.get_mut(extension_id) {
            summary.status = ExtensionStatus::Active;
            summary.last_error = None;
        }
        Ok(updated_views)
    }

    /// Drops every thread-scoped composer-suggestion projection for one
    /// thread, returning the views that were retired.
    ///
    /// Offers describe what to do *next* after a turn ended; once a new turn
    /// is under way they are stale, whatever produced them. Enforcing that
    /// here rather than in each extension keeps the rule provider-independent
    /// — only Codex reports a `turn/started` notification.
    pub(super) async fn retire_composer_suggestions(
        &mut self,
        thread_id: &str,
    ) -> Result<Vec<ExtensionView>, DaemonError> {
        let suggestion_views = self
            .summaries
            .values()
            .flat_map(|summary| {
                summary
                    .contributes
                    .composer_suggestions
                    .iter()
                    .map(move |contribution| (summary.id.as_str(), contribution.view.as_str()))
            })
            .collect::<HashSet<_>>();
        if suggestion_views.is_empty() {
            return Ok(Vec::new());
        }
        let stale = self
            .persisted
            .views
            .iter()
            .filter(|(_, view)| {
                view.scope
                    .as_ref()
                    .is_some_and(|scope| scope.kind == "thread" && scope.id == thread_id)
                    && suggestion_views
                        .contains(&(view.extension_id.as_str(), view.view_id.as_str()))
            })
            .map(|(key, view)| (key.clone(), view.clone()))
            .collect::<Vec<_>>();
        if stale.is_empty() {
            return Ok(Vec::new());
        }
        let mut persisted = self.persisted.clone();
        for (key, _) in &stale {
            persisted.views.remove(key);
        }
        self.persist_state(&persisted).await?;
        self.persisted = persisted;
        Ok(stale.into_iter().map(|(_, view)| view).collect())
    }

    async fn persist(&self) -> Result<(), DaemonError> {
        self.persist_state(&self.persisted).await
    }

    async fn persist_state(&self, state: &PersistedExtensionState) -> Result<(), DaemonError> {
        write_atomically(&self.state_path, serde_json::to_vec_pretty(state)?).await
    }
}

impl super::AppState {
    /// Adds extension-owned instructions to the ordinary FalconDeck agent
    /// context. Provider spawn paths use this wrapper so Codex, Claude, and
    /// ACP harnesses receive the same Mission trigger semantics.
    pub(crate) async fn agent_context_instructions_with_extensions(
        &self,
        provider: &falcondeck_core::AgentProvider,
    ) -> Option<String> {
        let mut instructions = self.agent_context_instructions(provider).await?;
        if !self
            .inner
            .extensions
            .lock()
            .await
            .missions_agent_context_available()
        {
            return Some(instructions);
        }

        let skill = crate::mission_context::stage_skill(&self.inner.state_path);
        if let Err(error) = &skill {
            tracing::warn!(%error, "failed to stage FalconDeck Missions skill");
        }
        crate::mission_context::append_instructions(&mut instructions, skill.as_deref().ok());
        Some(instructions)
    }
}

async fn write_bundled_asset(
    canonical_state_dir: &Path,
    path: &Path,
    contents: &str,
) -> Result<(), DaemonError> {
    let parent = path.parent().ok_or_else(|| {
        DaemonError::Process(format!(
            "bundled extension asset has no parent: {}",
            path.display()
        ))
    })?;
    let mut existing_ancestor = parent;
    loop {
        match tokio::fs::symlink_metadata(existing_ancestor).await {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing_ancestor = existing_ancestor.parent().ok_or_else(|| {
                    DaemonError::BadRequest(format!(
                        "bundled extension asset path escapes daemon state: {}",
                        path.display()
                    ))
                })?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let canonical_ancestor = tokio::fs::canonicalize(existing_ancestor).await?;
    if !canonical_ancestor.starts_with(canonical_state_dir) {
        return Err(DaemonError::BadRequest(format!(
            "bundled extension asset path escapes daemon state: {}",
            path.display()
        )));
    }
    tokio::fs::create_dir_all(parent).await?;
    let canonical_parent = tokio::fs::canonicalize(parent).await?;
    if !canonical_parent.starts_with(canonical_state_dir) {
        return Err(DaemonError::BadRequest(format!(
            "bundled extension asset path escapes daemon state: {}",
            path.display()
        )));
    }
    write_atomically(&path.to_path_buf(), contents.as_bytes().to_vec()).await
}

async fn read_bounded_text(path: &Path, limit: u64, label: &str) -> Result<String, DaemonError> {
    let metadata = tokio::fs::metadata(path).await?;
    if metadata.len() > limit {
        return Err(DaemonError::BadRequest(format!(
            "{label} exceeds {limit} bytes: {}",
            path.display()
        )));
    }
    let contents = tokio::fs::read_to_string(path).await.map_err(|error| {
        DaemonError::Process(format!(
            "failed to read {label} {}: {error}",
            path.display()
        ))
    })?;
    if contents.len() as u64 > limit {
        return Err(DaemonError::BadRequest(format!(
            "{label} exceeds {limit} bytes: {}",
            path.display()
        )));
    }
    Ok(contents)
}

/// Scratch pad became Notes in 0.3.0. Its persisted enablement, permission
/// grants, and stored documents carry over to the new id so an upgrade keeps
/// the user's writing; stale views are dropped and republished on first use.
fn migrate_scratch_pad_to_notes(state: &mut PersistedExtensionState) {
    if let Some(enabled) = state.enabled.remove(LEGACY_SCRATCH_PAD_ID) {
        state.enabled.entry(NOTES_ID.to_string()).or_insert(enabled);
    }
    if let Some(grants) = state.grants.remove(LEGACY_SCRATCH_PAD_ID) {
        state.grants.entry(NOTES_ID.to_string()).or_insert(grants);
    }
    if let Some(storage) = state.storage.remove(LEGACY_SCRATCH_PAD_ID) {
        state.storage.entry(NOTES_ID.to_string()).or_insert(storage);
    }
    state
        .views
        .retain(|_, view| view.extension_id != LEGACY_SCRATCH_PAD_ID);
}

fn extension_view_key(
    extension_id: &str,
    view_id: &str,
    scope: Option<&ExtensionViewScope>,
) -> String {
    serde_json::to_string(&(
        extension_id,
        view_id,
        scope.map(|value| value.kind.as_str()),
        scope.map(|value| value.id.as_str()),
    ))
    .expect("extension view key tuple is always serializable")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublishedExtensionView {
    pub(super) view_id: String,
    #[serde(default)]
    pub(super) scope: Option<ExtensionViewScope>,
    pub(super) value: Value,
}

fn extension_root(state_dir: &Path) -> (PathBuf, bool) {
    if let Some(root) = std::env::var_os("FALCONDECK_EXTENSION_ROOT") {
        return (PathBuf::from(root), false);
    }
    let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if repository_root.join("extensions/catalog.json").is_file() {
        return (repository_root.join("extensions"), false);
    }
    (state_dir.join("extensions"), true)
}

async fn resolve_existing_package_path(
    root: &Path,
    relative: &str,
    label: &str,
) -> Result<PathBuf, DaemonError> {
    let unresolved = resolve_package_path(root, relative)?;
    let resolved = tokio::fs::canonicalize(&unresolved)
        .await
        .map_err(|error| {
            DaemonError::BadRequest(format!(
                "failed to resolve {label} {}: {error}",
                unresolved.display()
            ))
        })?;
    if !resolved.starts_with(root) {
        return Err(DaemonError::BadRequest(format!(
            "{label} must remain inside its package"
        )));
    }
    Ok(resolved)
}

fn resolve_package_path(root: &Path, relative: &str) -> Result<PathBuf, DaemonError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(DaemonError::BadRequest(
            "extension path must remain inside its package".to_string(),
        ));
    }
    Ok(root.join(path))
}

fn validate_manifest(manifest: &ExtensionManifest) -> Result<(), DaemonError> {
    if manifest.id.trim().is_empty()
        || manifest.name.trim().is_empty()
        || manifest.version.trim().is_empty()
        || manifest.entrypoint.trim().is_empty()
    {
        return Err(DaemonError::BadRequest(
            "extension manifest contains an empty required field".to_string(),
        ));
    }
    if !EXTENSION_ID_PATTERN.is_match(&manifest.id)
        || !VERSION_PATTERN.is_match(&manifest.version)
        || manifest.name.chars().count() > 80
    {
        return Err(DaemonError::BadRequest(
            "extension manifest identity fields are invalid".to_string(),
        ));
    }
    if !ENGINE_PATTERN.is_match(manifest.engines.falcondeck.trim()) {
        return Err(DaemonError::BadRequest(
            "unsupported FalconDeck extension engine range".to_string(),
        ));
    }
    if manifest.permissions.len() > MAX_MANIFEST_PERMISSIONS
        || manifest
            .permissions
            .iter()
            .any(|permission| !SUPPORTED_PERMISSIONS.contains(&permission.as_str()))
        || manifest.permissions.iter().collect::<HashSet<_>>().len() != manifest.permissions.len()
    {
        return Err(DaemonError::BadRequest(
            "extension permissions are unsupported, duplicated, or exceed their limit".to_string(),
        ));
    }
    let contribution_count = manifest.contributes.thread_menu_actions.len()
        + manifest.contributes.panel_actions.len()
        + manifest.contributes.thread_decorations.len()
        + manifest.contributes.sidebar_filters.len()
        + manifest.contributes.panels.len()
        + manifest.contributes.agent_tools.len()
        + manifest.contributes.composer_suggestions.len();
    if contribution_count > MAX_MANIFEST_CONTRIBUTIONS {
        return Err(DaemonError::BadRequest(format!(
            "extension manifest exceeds {MAX_MANIFEST_CONTRIBUTIONS} contributions"
        )));
    }
    let mut ids = HashSet::new();
    validate_unique_actions(&manifest.contributes.thread_menu_actions, &mut ids)?;
    validate_unique_actions(&manifest.contributes.panel_actions, &mut ids)?;
    validate_unique_views(&manifest.contributes.thread_decorations, &mut ids)?;
    validate_unique_views(&manifest.contributes.sidebar_filters, &mut ids)?;
    validate_unique_views(&manifest.contributes.panels, &mut ids)?;
    validate_unique_views(&manifest.contributes.composer_suggestions, &mut ids)?;
    validate_agent_tools(&manifest.contributes.agent_tools, &mut ids)?;
    if !manifest.contributes.agent_tools.is_empty()
        && !manifest
            .permissions
            .iter()
            .any(|permission| permission == AGENT_TOOLS_PERMISSION)
    {
        return Err(DaemonError::BadRequest(format!(
            "extensions contributing agentTools must declare the {AGENT_TOOLS_PERMISSION} permission"
        )));
    }
    if manifest
        .contributes
        .sidebar_filters
        .iter()
        .any(|filter| filter.title.is_none())
    {
        return Err(DaemonError::BadRequest(
            "extension sidebar filters require a title".to_string(),
        ));
    }
    if manifest
        .contributes
        .panels
        .iter()
        .any(|panel| panel.title.is_none())
    {
        return Err(DaemonError::BadRequest(
            "extension panels require a title".to_string(),
        ));
    }
    if let Some(icon) = manifest.contributes.panels.iter().find_map(|panel| {
        panel
            .icon
            .as_deref()
            .filter(|icon| !EXTENSION_PANEL_ICONS.contains(icon))
    }) {
        return Err(DaemonError::BadRequest(format!(
            "unknown extension panel icon: {icon}"
        )));
    }
    let declared_actions = manifest
        .contributes
        .thread_menu_actions
        .iter()
        .chain(manifest.contributes.panel_actions.iter())
        .map(|action| action.id.as_str())
        .collect::<HashSet<_>>();
    let declared_views = manifest
        .contributes
        .thread_decorations
        .iter()
        .chain(manifest.contributes.sidebar_filters.iter())
        .chain(manifest.contributes.panels.iter())
        .chain(manifest.contributes.composer_suggestions.iter())
        .map(|contribution| contribution.view.as_str())
        .collect::<HashSet<_>>();
    for contribution in manifest
        .contributes
        .thread_decorations
        .iter()
        .chain(manifest.contributes.sidebar_filters.iter())
        .chain(manifest.contributes.panels.iter())
    {
        if let Some(document) = contribution.ui.as_ref() {
            validate_ui_document(document, &declared_actions, &declared_views)?;
        }
    }
    if manifest
        .contributes
        .composer_suggestions
        .iter()
        .any(|contribution| contribution.ui.is_some() || contribution.icon.is_some())
    {
        return Err(DaemonError::BadRequest(
            "composer suggestions are rendered by the host and accept no ui or icon".to_string(),
        ));
    }
    for filter in &manifest.contributes.sidebar_filters {
        if filter
            .ui
            .as_ref()
            .is_some_and(|document| !matches!(&document.root, ExtensionUiNode::Select { .. }))
        {
            return Err(DaemonError::BadRequest(
                "extension sidebar filter UI must use a select root".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_manifest_contribution_shape(manifest: &Value) -> Result<(), DaemonError> {
    let Some(contributes) = manifest.get("contributes") else {
        return Ok(());
    };
    let contributes = contributes.as_object().ok_or_else(|| {
        DaemonError::BadRequest("extension contributes must be an object".to_string())
    })?;
    for (surface, values) in contributes {
        let allowed = match surface.as_str() {
            "threadMenuActions" | "panelActions" => &["id", "title"][..],
            "threadDecorations" => &["id", "view", "ui"][..],
            "sidebarFilters" => &["id", "title", "view", "ui"][..],
            "panels" => &["id", "title", "view", "ui", "icon"][..],
            "composerSuggestions" => &["id", "view"][..],
            "agentTools" => &["id", "title", "description", "inputSchema"][..],
            _ => {
                return Err(DaemonError::BadRequest(format!(
                    "unknown extension contribution point: {surface}"
                )));
            }
        };
        let values = values.as_array().ok_or_else(|| {
            DaemonError::BadRequest(format!(
                "extension contribution point {surface} must be an array"
            ))
        })?;
        for contribution in values {
            let contribution = contribution.as_object().ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "extension contribution in {surface} must be an object"
                ))
            })?;
            if let Some(unknown) = contribution
                .keys()
                .find(|key| !allowed.contains(&key.as_str()))
            {
                return Err(DaemonError::BadRequest(format!(
                    "unknown property in extension contribution {surface}: {unknown}"
                )));
            }
        }
    }
    Ok(())
}

/// Enforces the composer-suggestion contract on a published projection.
/// Clients render these offers directly, so a malformed set is rejected at
/// the daemon boundary rather than degrading in three separate renderers.
fn validate_composer_suggestion_view(
    published: &PublishedExtensionView,
) -> Result<(), DaemonError> {
    match published.scope.as_ref() {
        Some(scope) if scope.kind == "thread" => {}
        _ => {
            return Err(DaemonError::BadRequest(
                "composer suggestions must be published with a thread scope".to_string(),
            ));
        }
    }
    // An empty set is the documented way to clear a thread's offers.
    if published
        .value
        .get("actions")
        .and_then(Value::as_array)
        .is_some_and(|actions| actions.is_empty())
    {
        return Ok(());
    }
    let set: ComposerSuggestionSet =
        serde_json::from_value(published.value.clone()).map_err(|error| {
            DaemonError::BadRequest(format!("malformed composer suggestions: {error}"))
        })?;
    set.validate().map_err(DaemonError::BadRequest)
}

fn validate_agent_tools<'a>(
    tools: &'a [ExtensionAgentToolContribution],
    ids: &mut HashSet<&'a str>,
) -> Result<(), DaemonError> {
    if tools.len() > MAX_AGENT_TOOLS_PER_EXTENSION {
        return Err(DaemonError::BadRequest(format!(
            "extension declares more than {MAX_AGENT_TOOLS_PER_EXTENSION} agent tools"
        )));
    }
    for tool in tools {
        if !CONTRIBUTION_ID_PATTERN.is_match(&tool.id) || !ids.insert(tool.id.as_str()) {
            return Err(DaemonError::BadRequest(format!(
                "extension contribution id is invalid or duplicated: {}",
                tool.id
            )));
        }
        if tool.title.trim().is_empty() || tool.title.chars().count() > MAX_AGENT_TOOL_TITLE_CHARS {
            return Err(DaemonError::BadRequest(format!(
                "agent tool title must be 1-{MAX_AGENT_TOOL_TITLE_CHARS} characters"
            )));
        }
        // The description is the only thing steering the model toward or away
        // from the tool, so require a real one rather than a placeholder.
        if tool.description.trim().len() < 16
            || tool.description.chars().count() > MAX_AGENT_TOOL_DESCRIPTION_CHARS
        {
            return Err(DaemonError::BadRequest(format!(
                "agent tool description must be 16-{MAX_AGENT_TOOL_DESCRIPTION_CHARS} characters"
            )));
        }
        if tool.input_schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(DaemonError::BadRequest(
                "agent tool inputSchema must describe a JSON object".to_string(),
            ));
        }
        if serde_json::to_vec(&tool.input_schema)?.len() > MAX_AGENT_TOOL_SCHEMA_BYTES {
            return Err(DaemonError::BadRequest(format!(
                "agent tool inputSchema exceeds {MAX_AGENT_TOOL_SCHEMA_BYTES} bytes"
            )));
        }
    }
    Ok(())
}

/// Builds the MCP tool name for one declared tool.
///
/// Prefer `{sanitized_extension}-{sanitized_tool}` so two ids that flatten to
/// the same underscore string stay distinct. If that form would exceed
/// [`MAX_PUBLISHED_AGENT_TOOL_NAME_CHARS`] — as the follow-up suggestions
/// tool does — compact to `{publisher}_{tool}` so Grok can still qualify it
/// as `falcondeck-extensions__{name}` in 64 characters. That is why
/// `falcondeck.follow-up-suggestions` / `suggest-follow-ups` publishes as
/// `falcondeck_suggest_follow_ups` rather than the 52-character hyphenated
/// form, which Grok skips.
pub(super) fn agent_tool_name(extension_id: &str, tool_id: &str) -> String {
    let ext = sanitize_agent_tool_name_part(extension_id);
    let tool = sanitize_agent_tool_name_part(tool_id);
    let specific = format!("{ext}{TOOL_NAME_SEPARATOR}{tool}");
    if specific.len() <= MAX_PUBLISHED_AGENT_TOOL_NAME_CHARS {
        return specific;
    }
    let publisher = extension_id
        .split('.')
        .next()
        .unwrap_or(extension_id)
        .replace('-', "_");
    let compact = format!("{publisher}_{tool}");
    if compact.len() <= MAX_PUBLISHED_AGENT_TOOL_NAME_CHARS {
        return compact;
    }
    let mut clipped: String = compact
        .chars()
        .take(MAX_PUBLISHED_AGENT_TOOL_NAME_CHARS)
        .collect();
    while clipped.ends_with('_') || clipped.ends_with('-') {
        clipped.pop();
    }
    clipped
}

fn sanitize_agent_tool_name_part(value: &str) -> String {
    value.replace(['.', '-'], "_")
}

fn validate_unique_actions<'a>(
    actions: &'a [ExtensionActionContribution],
    ids: &mut HashSet<&'a str>,
) -> Result<(), DaemonError> {
    if actions.iter().any(|action| {
        !CONTRIBUTION_ID_PATTERN.is_match(&action.id)
            || action.title.trim().is_empty()
            || action.title.chars().count() > 80
            || !ids.insert(action.id.as_str())
    }) {
        return Err(DaemonError::BadRequest(
            "extension action ids must be non-empty and unique".to_string(),
        ));
    }
    Ok(())
}

fn validate_unique_views<'a>(
    views: &'a [ExtensionViewContribution],
    ids: &mut HashSet<&'a str>,
) -> Result<(), DaemonError> {
    if views.iter().any(|view| {
        !CONTRIBUTION_ID_PATTERN.is_match(&view.id)
            || !CONTRIBUTION_ID_PATTERN.is_match(&view.view)
            || view
                .title
                .as_ref()
                .is_some_and(|title| title.trim().is_empty() || title.chars().count() > 80)
            || !ids.insert(view.id.as_str())
    }) {
        return Err(DaemonError::BadRequest(
            "extension contribution ids and views must be non-empty and unique".to_string(),
        ));
    }
    Ok(())
}

fn validate_ui_document(
    document: &ExtensionUiDocument,
    declared_actions: &HashSet<&str>,
    declared_views: &HashSet<&str>,
) -> Result<(), DaemonError> {
    if document.version != 1 {
        return Err(DaemonError::BadRequest(
            "unsupported extension declarative UI version".to_string(),
        ));
    }
    let mut node_count = 0;
    validate_ui_node(
        &document.root,
        1,
        &mut node_count,
        declared_actions,
        declared_views,
    )
}

fn validate_ui_node(
    node: &ExtensionUiNode,
    depth: usize,
    node_count: &mut usize,
    declared_actions: &HashSet<&str>,
    declared_views: &HashSet<&str>,
) -> Result<(), DaemonError> {
    *node_count = node_count.saturating_add(1);
    if depth > MAX_UI_DEPTH || *node_count > MAX_UI_NODES {
        return Err(DaemonError::BadRequest(
            "extension declarative UI exceeds its depth or node limit".to_string(),
        ));
    }
    match node {
        ExtensionUiNode::Stack { children, .. } | ExtensionUiNode::Row { children, .. } => {
            for child in children {
                validate_ui_node(
                    child,
                    depth + 1,
                    node_count,
                    declared_actions,
                    declared_views,
                )?;
            }
        }
        ExtensionUiNode::Text { text, .. } | ExtensionUiNode::Badge { text, .. } => {
            validate_ui_text(text, false)?;
        }
        ExtensionUiNode::Divider {} => {}
        ExtensionUiNode::Button {
            label,
            action,
            disabled: _,
            variant: _,
        } => {
            validate_ui_text(label, true)?;
            if !declared_actions.contains(action.action_id.as_str()) {
                return Err(DaemonError::BadRequest(format!(
                    "extension UI references undeclared action: {}",
                    action.action_id
                )));
            }
            ExtensionRegistry::validate_action_input(&action.input)?;
            ExtensionRegistry::validate_action_target(action.target.as_ref())?;
        }
        ExtensionUiNode::List { items } => {
            for item in items {
                validate_ui_node(
                    item,
                    depth + 1,
                    node_count,
                    declared_actions,
                    declared_views,
                )?;
            }
        }
        ExtensionUiNode::Select {
            id,
            label,
            options,
            binding,
            ..
        } => {
            if !CONTRIBUTION_ID_PATTERN.is_match(id) {
                return Err(DaemonError::BadRequest(
                    "extension UI select id must be kebab-case".to_string(),
                ));
            }
            validate_ui_text(label, true)?;
            if options.len() > MAX_UI_OPTIONS {
                return Err(DaemonError::BadRequest(format!(
                    "extension UI select exceeds {MAX_UI_OPTIONS} options"
                )));
            }
            let mut option_values = HashSet::new();
            for option in options {
                validate_ui_text(&option.label, true)?;
                if option.value.is_empty()
                    || option.value.chars().count() > 256
                    || !option_values.insert(option.value.as_str())
                {
                    return Err(DaemonError::BadRequest(
                        "extension UI select values must be non-empty and unique".to_string(),
                    ));
                }
            }
            if !declared_views.contains(binding.view.as_str()) {
                return Err(DaemonError::BadRequest(format!(
                    "extension UI filter references undeclared view: {}",
                    binding.view
                )));
            }
            if binding.path.is_empty()
                || binding.path.len() > MAX_UI_PATH_SEGMENTS
                || binding.path.iter().any(|segment| {
                    segment.is_empty()
                        || segment.chars().count() > MAX_UI_PATH_SEGMENT_CHARS
                        || matches!(segment.as_str(), "__proto__" | "constructor" | "prototype")
                })
            {
                return Err(DaemonError::BadRequest(
                    "extension UI filter path is invalid or exceeds its limit".to_string(),
                ));
            }
        }
        ExtensionUiNode::State {
            title, description, ..
        } => {
            validate_ui_text(title, true)?;
            if let Some(description) = description {
                validate_ui_text(description, false)?;
            }
        }
    }
    Ok(())
}

fn validate_ui_text(value: &str, require_non_empty: bool) -> Result<(), DaemonError> {
    if value.chars().count() > MAX_UI_TEXT_CHARS || (require_non_empty && value.trim().is_empty()) {
        return Err(DaemonError::BadRequest(format!(
            "extension UI text is empty or exceeds {MAX_UI_TEXT_CHARS} characters"
        )));
    }
    Ok(())
}

fn validate_scope(scope: &ExtensionViewScope) -> Result<(), DaemonError> {
    let kind_len = scope.kind.chars().count();
    let id_len = scope.id.chars().count();
    if kind_len == 0
        || kind_len > MAX_SCOPE_KIND_CHARS
        || id_len == 0
        || id_len > MAX_SCOPE_ID_CHARS
    {
        return Err(DaemonError::BadRequest(
            "extension scope is empty or exceeds its size limit".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use falcondeck_core::{
        ExtensionUiFilterBinding, ExtensionUiFilterOperator, ExtensionUiSelectOption,
        ExtensionUiTone,
    };

    fn manifest() -> ExtensionManifest {
        ExtensionManifest {
            _schema: None,
            id: "example.extension".to_string(),
            name: "Example".to_string(),
            version: "1.0.0".to_string(),
            engines: ExtensionEngines {
                falcondeck: "^0.1".to_string(),
            },
            entrypoint: "server.ts".to_string(),
            frontend: None,
            contributes: ExtensionContributions::default(),
            permissions: Vec::new(),
        }
    }

    fn manifest_with_sidebar_filter() -> ExtensionManifest {
        let mut manifest = manifest();
        manifest.contributes.thread_decorations = vec![ExtensionViewContribution {
            id: "thread-colors".to_string(),
            title: None,
            view: "thread-colors".to_string(),
            icon: None,
            ui: None,
        }];
        manifest.contributes.sidebar_filters = vec![ExtensionViewContribution {
            id: "colors".to_string(),
            title: Some("Colours".to_string()),
            view: "color-index".to_string(),
            icon: None,
            ui: Some(ExtensionUiDocument {
                version: 1,
                root: ExtensionUiNode::Select {
                    id: "colors".to_string(),
                    label: "Filter by colour".to_string(),
                    multiple: true,
                    options: vec![ExtensionUiSelectOption {
                        value: "red".to_string(),
                        label: "Red".to_string(),
                        tone: Some(ExtensionUiTone::Red),
                    }],
                    binding: ExtensionUiFilterBinding {
                        view: "thread-colors".to_string(),
                        path: vec!["tagIds".to_string()],
                        operator: ExtensionUiFilterOperator::IncludesAny,
                    },
                },
            }),
        }];
        manifest
    }

    #[test]
    fn resolve_package_path_rejects_parent_traversal() {
        let error = resolve_package_path(Path::new("/tmp/extensions"), "../secret")
            .expect_err("parent traversal must fail");
        assert_eq!(
            error.to_string(),
            "extension path must remain inside its package"
        );
    }

    #[test]
    fn action_input_rejects_oversized_values() {
        let value = Value::String("x".repeat(MAX_ACTION_INPUT_BYTES + 1));
        assert!(ExtensionRegistry::validate_action_input(&value).is_err());
    }

    #[test]
    fn action_target_rejects_empty_or_oversized_scopes() {
        for scope in [
            ExtensionViewScope {
                kind: String::new(),
                id: "thread-1".to_string(),
            },
            ExtensionViewScope {
                kind: "thread".to_string(),
                id: "x".repeat(MAX_SCOPE_ID_CHARS + 1),
            },
        ] {
            assert!(ExtensionRegistry::validate_action_target(Some(&scope)).is_err());
        }
    }

    #[test]
    fn manifest_rejects_cross_surface_duplicate_ids_and_permissions() {
        let mut duplicate = manifest();
        duplicate.contributes.thread_menu_actions = vec![ExtensionActionContribution {
            id: "shared".to_string(),
            title: "Run".to_string(),
        }];
        duplicate.contributes.thread_decorations = vec![ExtensionViewContribution {
            id: "shared".to_string(),
            title: None,
            view: "result".to_string(),
            icon: None,
            ui: None,
        }];
        assert!(validate_manifest(&duplicate).is_err());

        let mut permissioned = manifest();
        permissioned.permissions.push("filesystem".to_string());
        assert!(validate_manifest(&permissioned).is_err());

        let mut supported = manifest();
        supported
            .permissions
            .push(THREADS_READ_PERMISSION.to_string());
        assert!(validate_manifest(&supported).is_ok());
        supported
            .permissions
            .push(THREADS_READ_PERMISSION.to_string());
        assert!(validate_manifest(&supported).is_err());
    }

    #[test]
    fn manifest_rejects_unknown_contribution_properties() {
        let manifest = serde_json::json!({
            "contributes": {
                "threadMenuActions": [{ "id": "run", "title": "Run", "typo": true }]
            }
        });
        assert!(validate_manifest_contribution_shape(&manifest).is_err());
    }

    #[test]
    fn manifest_accepts_bounded_sidebar_filter_ui() {
        let manifest = manifest_with_sidebar_filter();

        assert!(
            validate_manifest(&manifest).is_ok(),
            "valid declarative filter should be accepted"
        );
    }

    #[test]
    fn manifest_accepts_a_titled_declarative_panel() {
        let mut manifest = manifest();
        manifest.contributes.panels = vec![ExtensionViewContribution {
            id: "attention".to_string(),
            title: Some("Mini Zen".to_string()),
            view: "attention-panel".to_string(),
            icon: None,
            ui: Some(ExtensionUiDocument {
                version: 1,
                root: ExtensionUiNode::State {
                    state: falcondeck_core::ExtensionUiStateKind::Empty,
                    title: "Nothing needs attention".to_string(),
                    description: None,
                },
            }),
        }];

        assert!(validate_manifest(&manifest).is_ok());

        manifest.contributes.panels[0].title = None;
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn manifest_accepts_known_panel_icons_and_rejects_unknown_ones() {
        let mut manifest = manifest();
        manifest.contributes.panels = vec![ExtensionViewContribution {
            id: "notes".to_string(),
            title: Some("Notes".to_string()),
            view: "notes".to_string(),
            icon: Some("notebook-pen".to_string()),
            ui: None,
        }];
        assert!(validate_manifest(&manifest).is_ok());

        manifest.contributes.panels[0].icon = Some("spaceship".to_string());
        let error = validate_manifest(&manifest).expect_err("unknown panel icons must fail");
        assert!(error.to_string().contains("unknown extension panel icon"));
    }

    fn agent_tool(id: &str) -> ExtensionAgentToolContribution {
        ExtensionAgentToolContribution {
            id: id.to_string(),
            title: "Suggest follow-ups".to_string(),
            description: "Offer the user a few short next actions for this thread.".to_string(),
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
        }
    }

    fn manifest_with_agent_tool() -> ExtensionManifest {
        let mut manifest = manifest();
        manifest.contributes.agent_tools = vec![agent_tool("suggest-follow-ups")];
        manifest.permissions = vec![AGENT_TOOLS_PERMISSION.to_string()];
        manifest
    }

    #[test]
    fn manifest_accepts_agent_tools_only_with_their_permission() {
        let manifest = manifest_with_agent_tool();
        assert!(validate_manifest(&manifest).is_ok());

        let mut ungranted = manifest_with_agent_tool();
        ungranted.permissions = Vec::new();
        let error = validate_manifest(&ungranted)
            .expect_err("agent tools without their permission must fail");
        assert!(error.to_string().contains(AGENT_TOOLS_PERMISSION));
    }

    #[test]
    fn manifest_rejects_unusable_agent_tool_declarations() {
        let mut thin_description = manifest_with_agent_tool();
        thin_description.contributes.agent_tools[0].description = "do it".to_string();
        assert!(validate_manifest(&thin_description).is_err());

        let mut non_object_schema = manifest_with_agent_tool();
        non_object_schema.contributes.agent_tools[0].input_schema =
            serde_json::json!({ "type": "string" });
        let error =
            validate_manifest(&non_object_schema).expect_err("a non-object tool schema must fail");
        assert!(error.to_string().contains("JSON object"));

        let mut too_many = manifest_with_agent_tool();
        too_many.contributes.agent_tools = (0..=MAX_AGENT_TOOLS_PER_EXTENSION)
            .map(|index| agent_tool(&format!("tool-{index}")))
            .collect();
        assert!(validate_manifest(&too_many).is_err());
    }

    #[test]
    fn agent_tool_names_stay_unambiguous_across_extensions() {
        // Neither id may contain the separator, so these two cannot collide
        // even though their halves concatenate to the same characters.
        assert_ne!(agent_tool_name("a.b", "c-d"), agent_tool_name("a.b-c", "d"),);
        assert_eq!(agent_tool_name("a.b", "c-d"), "a_b-c_d");
        assert_eq!(agent_tool_name("a.b-c", "d"), "a_b_c-d");
    }

    #[test]
    fn agent_tool_names_stay_safe_for_server_tool_qualifiers() {
        // Grok qualifies tools as `{server}__{name}` and skips anything whose
        // qualified form is longer than 64 characters or contains more than
        // one `__`. The long hyphenated form for follow-ups is 52 characters
        // and would become a 75-character qualifier, so it must compact.
        let name = agent_tool_name("falcondeck.follow-up-suggestions", "suggest-follow-ups");
        assert_eq!(name, "falcondeck_suggest_follow_ups");
        assert!(!name.contains("__"), "{name} must not contain '__'");
        assert!(
            name.len() <= MAX_PUBLISHED_AGENT_TOOL_NAME_CHARS,
            "{name} is {} characters",
            name.len()
        );
        let qualified = format!(
            "{}__{name}",
            crate::connectors::BUILTIN_EXTENSIONS_CONNECTOR_NAME
        );
        assert!(
            qualified.len() <= 64,
            "{qualified} is {} characters",
            qualified.len()
        );
        assert_eq!(
            qualified.split("__").count(),
            2,
            "{qualified} must split into server and tool"
        );
    }

    #[test]
    fn manifest_rejects_composer_suggestions_with_host_owned_rendering() {
        let mut manifest = manifest();
        manifest.contributes.composer_suggestions = vec![ExtensionViewContribution {
            id: "follow-ups".to_string(),
            title: None,
            view: "follow-ups".to_string(),
            icon: None,
            ui: None,
        }];
        assert!(validate_manifest(&manifest).is_ok());

        manifest.contributes.composer_suggestions[0].icon = Some("kanban".to_string());
        let error = validate_manifest(&manifest)
            .expect_err("composer suggestions must not carry host-owned rendering");
        assert!(error.to_string().contains("rendered by the host"));
    }

    #[test]
    fn composer_suggestion_views_are_bounded_before_they_reach_clients() {
        let published = |value: Value, scope: Option<ExtensionViewScope>| PublishedExtensionView {
            view_id: "follow-ups".to_string(),
            scope,
            value,
        };
        let thread = || {
            Some(ExtensionViewScope {
                kind: "thread".to_string(),
                id: "thread-1".to_string(),
            })
        };
        let valid = serde_json::json!({
            "actions": [{ "id": "ship", "label": "Ship it", "prompt": "Open a PR." }],
            "preferredActionId": "ship"
        });

        assert!(validate_composer_suggestion_view(&published(valid.clone(), thread())).is_ok());
        // Clearing a thread's offers is a normal publication, not a violation.
        assert!(
            validate_composer_suggestion_view(&published(
                serde_json::json!({ "actions": [] }),
                thread()
            ))
            .is_ok()
        );
        // Without a thread scope the offers have no composer to attach to.
        assert!(validate_composer_suggestion_view(&published(valid, None)).is_err());

        let over_limit = serde_json::json!({
            "actions": (0..6)
                .map(|index| serde_json::json!({
                    "id": format!("a{index}"),
                    "label": "Ship it",
                    "prompt": "Open a PR."
                }))
                .collect::<Vec<_>>()
        });
        assert!(validate_composer_suggestion_view(&published(over_limit, thread())).is_err());

        let long_label = serde_json::json!({
            "actions": [{ "id": "a", "label": "x".repeat(31), "prompt": "Open a PR." }]
        });
        let error = validate_composer_suggestion_view(&published(long_label, thread()))
            .expect_err("an over-long label must fail");
        assert!(error.to_string().contains("1-30 characters"));
    }

    #[test]
    fn manifest_rejects_ui_filter_bound_to_undeclared_view() {
        let mut manifest = manifest_with_sidebar_filter();
        let Some(ExtensionUiNode::Select { binding, .. }) = manifest
            .contributes
            .sidebar_filters
            .first_mut()
            .and_then(|filter| filter.ui.as_mut())
            .map(|document| &mut document.root)
        else {
            panic!("filter fixture must use a select root");
        };
        binding.view = "private-view".to_string();

        let error = validate_manifest(&manifest).expect_err("undeclared view must fail");

        assert!(error.to_string().contains("undeclared view"));
    }

    #[test]
    fn manifest_rejects_ui_over_global_node_limit() {
        let mut manifest = manifest_with_sidebar_filter();
        manifest.contributes.sidebar_filters[0].ui = Some(ExtensionUiDocument {
            version: 1,
            root: ExtensionUiNode::Stack {
                gap: None,
                children: (0..MAX_UI_NODES)
                    .map(|_| ExtensionUiNode::Divider {})
                    .collect(),
            },
        });

        let error = validate_manifest(&manifest).expect_err("oversized UI must fail");

        assert!(error.to_string().contains("node limit"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn canonical_package_resolution_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("extension root");
        let outside = tempfile::tempdir().expect("outside directory");
        std::fs::write(outside.path().join("server.ts"), "export default {}")
            .expect("outside fixture should write");
        symlink(outside.path(), root.path().join("escape")).expect("symlink fixture should create");
        let canonical_root = tokio::fs::canonicalize(root.path())
            .await
            .expect("root should canonicalize");

        let error = resolve_existing_package_path(
            &canonical_root,
            "escape/server.ts",
            "extension entrypoint",
        )
        .await
        .expect_err("symlink must not escape the package root");
        assert!(error.to_string().contains("must remain inside"));
    }

    #[tokio::test]
    async fn external_extension_root_is_not_overwritten_by_bundled_assets() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let external_root = state_dir.path().join("external-extensions");
        tokio::fs::create_dir_all(&external_root)
            .await
            .expect("external root should create");
        let catalog_path = external_root.join("catalog.json");
        tokio::fs::write(&catalog_path, r#"{"packages":[]}"#)
            .await
            .expect("external catalog should write");
        let mut registry = ExtensionRegistry::new(&state_dir.path().join("state.json"));
        registry.root = external_root;
        registry.manages_bundled_root = false;

        registry
            .ensure_bundled_assets()
            .await
            .expect("runtime assets should extract");
        assert_eq!(
            tokio::fs::read_to_string(catalog_path)
                .await
                .expect("external catalog should remain"),
            r#"{"packages":[]}"#
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bundled_runtime_assets_reject_symlinked_parent_escape() {
        use std::os::unix::fs::symlink;

        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let outside = tempfile::tempdir().expect("outside directory");
        symlink(outside.path(), state_dir.path().join("packages"))
            .expect("symlink fixture should create");
        let mut registry = ExtensionRegistry::new(&state_dir.path().join("state.json"));
        let error = registry
            .restore()
            .await
            .expect_err("bundled assets must not follow a parent symlink");

        assert!(error.to_string().contains("escapes daemon state"));
        assert!(!outside.path().join("extension-sdk").exists());
    }

    #[tokio::test]
    async fn bundled_catalog_and_manifest_are_discoverable() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let mut registry = ExtensionRegistry::new(&state_dir.path().join("state.json"));
        registry
            .restore()
            .await
            .expect("bundled catalog should load");

        let snapshot = registry.snapshot();
        let kanban = snapshot
            .catalog
            .iter()
            .find(|extension| extension.id == "falcondeck.thread-tags")
            .expect("Kanban should be bundled");
        assert!(kanban.enabled);
        assert_eq!(kanban.name, "Kanban");
        assert_eq!(kanban.status, ExtensionStatus::Active);
        assert_eq!(kanban.contributes.panels.len(), 1);
        assert_eq!(kanban.permissions, [THREADS_READ_PERMISSION]);

        let notes = snapshot
            .catalog
            .iter()
            .find(|extension| extension.id == "falcondeck.notes")
            .expect("Notes should be bundled");
        assert!(notes.enabled);
        assert_eq!(notes.name, "Notes");
        assert_eq!(notes.status, ExtensionStatus::Active);
        assert_eq!(notes.contributes.panels.len(), 1);
        assert!(notes.permissions.is_empty());

        let mini_zen = snapshot
            .catalog
            .iter()
            .find(|extension| extension.id == "falcondeck.mini-zen")
            .expect("Mini Zen should be bundled");
        assert!(!mini_zen.enabled);
        assert_eq!(mini_zen.status, ExtensionStatus::Disabled);
        assert_eq!(mini_zen.contributes.panels.len(), 1);
        assert_eq!(mini_zen.permissions, [THREADS_READ_PERMISSION]);
        assert!(mini_zen.granted_permissions.is_empty());

        let host_path = state_dir.path().join("extension-host/main.ts");
        tokio::fs::write(&host_path, "// stale bundled host")
            .await
            .expect("stale host fixture should write");
        let mut restored = ExtensionRegistry::new(&state_dir.path().join("state.json"));
        restored
            .restore()
            .await
            .expect("bundled assets should refresh on restore");
        assert_eq!(
            tokio::fs::read_to_string(host_path)
                .await
                .expect("refreshed host should read"),
            include_str!("../../../../apps/extension-host/main.ts")
        );
    }

    #[tokio::test]
    async fn permission_grants_are_declared_denied_by_default_and_persisted() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let state_path = state_dir.path().join("state.json");
        let mut registry = ExtensionRegistry::new(&state_path);
        registry.restore().await.expect("registry should restore");

        assert!(!registry.has_grant("falcondeck.mini-zen", THREADS_READ_PERMISSION));
        let granted = registry
            .update_permission("falcondeck.mini-zen", THREADS_READ_PERMISSION, true)
            .await
            .expect("declared permission should grant");
        assert_eq!(granted.granted_permissions, [THREADS_READ_PERMISSION]);
        assert!(!registry.has_grant("falcondeck.mini-zen", THREADS_READ_PERMISSION));
        registry
            .update_enabled("falcondeck.mini-zen", true)
            .await
            .expect("Mini Zen should enable");
        assert!(registry.has_grant("falcondeck.mini-zen", THREADS_READ_PERMISSION));
        assert!(
            registry
                .update_permission("falcondeck.thread-tags", "workspace:read", true,)
                .await
                .is_err()
        );

        let mut restored = ExtensionRegistry::new(&state_path);
        restored.restore().await.expect("grant should restore");
        let mini_zen = restored
            .snapshot()
            .catalog
            .into_iter()
            .find(|extension| extension.id == "falcondeck.mini-zen")
            .expect("Mini Zen should restore");
        assert_eq!(mini_zen.granted_permissions, [THREADS_READ_PERMISSION]);

        restored.persisted.views.insert(
            "permission-derived".to_string(),
            ExtensionView {
                extension_id: "falcondeck.mini-zen".to_string(),
                view_id: "attention-panel".to_string(),
                scope: None,
                value: serde_json::json!({ "title": "private thread title" }),
                updated_at: Utc::now(),
            },
        );

        restored
            .update_permission("falcondeck.mini-zen", THREADS_READ_PERMISSION, false)
            .await
            .expect("grant should revoke");
        let mut revoked = ExtensionRegistry::new(&state_path);
        revoked.restore().await.expect("revocation should restore");
        assert!(!revoked.has_grant("falcondeck.mini-zen", THREADS_READ_PERMISSION));
        assert!(revoked.persisted.views.is_empty());
        assert!(
            revoked
                .snapshot()
                .catalog
                .into_iter()
                .find(|extension| extension.id == "falcondeck.mini-zen")
                .expect("Mini Zen should restore after revocation")
                .granted_permissions
                .is_empty()
        );
    }

    #[tokio::test]
    async fn granting_a_permission_clears_only_its_matching_denial_error() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let mut registry = ExtensionRegistry::new(&state_dir.path().join("state.json"));
        registry.restore().await.expect("registry should restore");
        registry
            .update_enabled("falcondeck.mini-zen", true)
            .await
            .expect("Mini Zen should enable");

        registry
            .mark_error(
                "falcondeck.mini-zen",
                "threads:read permission is not granted",
            )
            .await
            .expect("permission denial should be recorded");
        let recovered = registry
            .update_permission("falcondeck.mini-zen", THREADS_READ_PERMISSION, true)
            .await
            .expect("matching permission should grant");
        assert_eq!(recovered.status, ExtensionStatus::Active);
        assert_eq!(recovered.last_error, None);

        registry
            .update_permission("falcondeck.mini-zen", THREADS_READ_PERMISSION, false)
            .await
            .expect("permission should revoke");
        registry
            .mark_error("falcondeck.mini-zen", "extension host crashed")
            .await
            .expect("unrelated failure should be recorded");
        let still_failed = registry
            .update_permission("falcondeck.mini-zen", THREADS_READ_PERMISSION, true)
            .await
            .expect("permission should grant without hiding another failure");
        assert_eq!(still_failed.status, ExtensionStatus::Error);
        assert_eq!(
            still_failed.last_error.as_deref(),
            Some("extension host crashed")
        );
    }

    #[test]
    fn scratch_pad_state_carries_over_to_notes() {
        let mut state = PersistedExtensionState::default();
        state
            .enabled
            .insert(LEGACY_SCRATCH_PAD_ID.to_string(), false);
        state.storage.insert(
            LEGACY_SCRATCH_PAD_ID.to_string(),
            BTreeMap::from([("pad".to_string(), serde_json::json!("# Keep me"))]),
        );
        state.views.insert(
            "stale".to_string(),
            ExtensionView {
                extension_id: LEGACY_SCRATCH_PAD_ID.to_string(),
                view_id: "scratch-pad".to_string(),
                scope: None,
                value: serde_json::json!({}),
                updated_at: Utc::now(),
            },
        );

        migrate_scratch_pad_to_notes(&mut state);

        assert!(!state.enabled.contains_key(LEGACY_SCRATCH_PAD_ID));
        assert_eq!(state.enabled.get(NOTES_ID), Some(&false));
        assert_eq!(
            state.storage.get(NOTES_ID).and_then(|pad| pad.get("pad")),
            Some(&serde_json::json!("# Keep me"))
        );
        assert!(state.views.is_empty());
    }

    #[test]
    fn migration_keeps_notes_state_when_both_ids_are_present() {
        let mut state = PersistedExtensionState::default();
        state
            .enabled
            .insert(LEGACY_SCRATCH_PAD_ID.to_string(), false);
        state.enabled.insert(NOTES_ID.to_string(), true);
        state.storage.insert(
            LEGACY_SCRATCH_PAD_ID.to_string(),
            BTreeMap::from([("pad".to_string(), serde_json::json!("old"))]),
        );
        state.storage.insert(
            NOTES_ID.to_string(),
            BTreeMap::from([("library".to_string(), serde_json::json!([]))]),
        );

        migrate_scratch_pad_to_notes(&mut state);

        assert_eq!(state.enabled.get(NOTES_ID), Some(&true));
        assert!(state.storage[NOTES_ID].contains_key("library"));
        assert!(!state.storage.contains_key(LEGACY_SCRATCH_PAD_ID));
    }

    const FOLLOW_UPS: &str = "falcondeck.follow-up-suggestions";
    const FOLLOW_UPS_TOOL: &str = "falcondeck_suggest_follow_ups";

    #[tokio::test]
    async fn bundled_follow_ups_is_enabled_and_granted_on_a_fresh_install() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let state_path = state_dir.path().join("state.json");
        let mut registry = ExtensionRegistry::new(&state_path);
        registry.restore().await.expect("registry should restore");

        assert!(registry.is_enabled(FOLLOW_UPS));
        assert!(registry.has_grant(FOLLOW_UPS, AGENT_TOOLS_PERMISSION));
        let tools = registry.agent_tools();
        assert_eq!(tools.len(), 1, "only follow-ups publishes a tool today");
        assert_eq!(tools[0].name, FOLLOW_UPS_TOOL);
        assert!(registry.tool_package(FOLLOW_UPS_TOOL).is_ok());
    }

    #[tokio::test]
    async fn mission_agent_context_requires_the_complete_ready_toolset() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let mut registry = ExtensionRegistry::new(&state_dir.path().join("state.json"));
        registry.restore().await.expect("registry should restore");
        assert!(!registry.missions_agent_context_available());

        registry
            .update_enabled(MISSIONS_ID, true)
            .await
            .expect("Missions should enable");
        for permission in [THREADS_READ_PERMISSION, AGENT_TOOLS_PERMISSION] {
            registry
                .update_permission(MISSIONS_ID, permission, true)
                .await
                .expect("Missions permission should grant");
        }
        assert!(registry.missions_agent_context_available());

        registry
            .update_permission(MISSIONS_ID, THREADS_READ_PERMISSION, false)
            .await
            .expect("thread permission should revoke");
        assert!(!registry.missions_agent_context_available());
    }

    #[tokio::test]
    async fn revoking_the_agent_tools_grant_survives_restart_and_hides_the_tool() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let state_path = state_dir.path().join("state.json");
        let mut registry = ExtensionRegistry::new(&state_path);
        registry.restore().await.expect("registry should restore");
        registry
            .update_permission(FOLLOW_UPS, AGENT_TOOLS_PERMISSION, false)
            .await
            .expect("granted permission should revoke");

        assert!(registry.agent_tools().is_empty());
        assert!(registry.tool_package(FOLLOW_UPS_TOOL).is_err());

        // Catalog policy applies once, on first discovery. A later restart
        // must not quietly hand back a permission the user took away.
        let mut restored = ExtensionRegistry::new(&state_path);
        restored.restore().await.expect("revocation should restore");
        assert!(!restored.has_grant(FOLLOW_UPS, AGENT_TOOLS_PERMISSION));
        assert!(restored.agent_tools().is_empty());
    }

    #[tokio::test]
    async fn disabling_the_extension_withdraws_its_tools_immediately() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let mut registry = ExtensionRegistry::new(&state_dir.path().join("state.json"));
        registry.restore().await.expect("registry should restore");
        registry
            .update_enabled(FOLLOW_UPS, false)
            .await
            .expect("bundled extension should disable");

        assert!(registry.agent_tools().is_empty());
        let error = registry
            .tool_package(FOLLOW_UPS_TOOL)
            .expect_err("a disabled extension must not resolve a tool");
        assert!(
            error
                .to_string()
                .contains("unknown FalconDeck extension tool")
        );

        registry
            .update_enabled(FOLLOW_UPS, true)
            .await
            .expect("bundled extension should re-enable");
        assert_eq!(registry.agent_tools().len(), 1);
    }

    #[tokio::test]
    async fn a_new_turn_retires_only_that_thread_s_composer_suggestions() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let state_path = state_dir.path().join("state.json");
        let mut registry = ExtensionRegistry::new(&state_path);
        registry.restore().await.expect("registry should restore");

        let offer = |thread_id: &str| ExtensionView {
            extension_id: FOLLOW_UPS.to_string(),
            view_id: "follow-ups".to_string(),
            scope: Some(ExtensionViewScope {
                kind: "thread".to_string(),
                id: thread_id.to_string(),
            }),
            value: serde_json::json!({
                "actions": [{ "id": "ship", "label": "Ship it", "prompt": "Open a PR." }]
            }),
            updated_at: Utc::now(),
        };
        registry
            .persisted
            .views
            .insert("offer-1".to_string(), offer("thread-1"));
        registry
            .persisted
            .views
            .insert("offer-2".to_string(), offer("thread-2"));
        // A projection from another contribution kind on the same thread must
        // survive: only composer suggestions are turn-scoped.
        registry.persisted.views.insert(
            "stage".to_string(),
            ExtensionView {
                extension_id: "falcondeck.thread-tags".to_string(),
                view_id: "thread-tags".to_string(),
                scope: Some(ExtensionViewScope {
                    kind: "thread".to_string(),
                    id: "thread-1".to_string(),
                }),
                value: serde_json::json!({ "tagIds": ["in_progress"] }),
                updated_at: Utc::now(),
            },
        );

        let retired = registry
            .retire_composer_suggestions("thread-1")
            .await
            .expect("a new turn should retire that thread's offers");
        assert_eq!(retired.len(), 1);
        assert_eq!(retired[0].view_id, "follow-ups");

        let remaining = registry
            .persisted
            .views
            .values()
            .map(|view| {
                (
                    view.view_id.as_str(),
                    view.scope.as_ref().unwrap().id.as_str(),
                )
            })
            .collect::<HashSet<_>>();
        assert!(remaining.contains(&("follow-ups", "thread-2")));
        assert!(remaining.contains(&("thread-tags", "thread-1")));
        assert!(!remaining.contains(&("follow-ups", "thread-1")));

        // Retiring again is a no-op rather than a redundant persist and event.
        assert!(
            registry
                .retire_composer_suggestions("thread-1")
                .await
                .expect("retiring twice should succeed")
                .is_empty()
        );

        let mut restored = ExtensionRegistry::new(&state_path);
        restored.restore().await.expect("retirement should persist");
        assert!(
            !restored
                .persisted
                .views
                .values()
                .any(|view| view.view_id == "follow-ups"
                    && view.scope.as_ref().unwrap().id == "thread-1")
        );
    }

    #[tokio::test]
    async fn disabled_extensions_retain_but_do_not_snapshot_views() {
        let state_dir = tempfile::tempdir().expect("temporary state directory");
        let mut registry = ExtensionRegistry::new(&state_dir.path().join("state.json"));
        registry.restore().await.expect("registry should restore");
        registry.persisted.views.insert(
            "fixture".to_string(),
            ExtensionView {
                extension_id: "falcondeck.thread-tags".to_string(),
                view_id: "thread-tags".to_string(),
                scope: Some(ExtensionViewScope {
                    kind: "thread".to_string(),
                    id: "thread-1".to_string(),
                }),
                value: serde_json::json!({ "tagIds": ["red"] }),
                updated_at: Utc::now(),
            },
        );
        registry
            .update_enabled("falcondeck.thread-tags", false)
            .await
            .expect("extension should disable");

        assert!(registry.snapshot().views.is_empty());
        assert_eq!(registry.persisted.views.len(), 1);
        assert_eq!(registry.retained_views("falcondeck.thread-tags").len(), 1);
    }
}
