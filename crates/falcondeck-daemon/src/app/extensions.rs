use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::LazyLock,
};

use chrono::Utc;
use falcondeck_core::{
    ExtensionActionContribution, ExtensionContributions, ExtensionSnapshot, ExtensionStatus,
    ExtensionSummary, ExtensionView, ExtensionViewContribution, ExtensionViewScope,
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
const MAX_CATALOG_PACKAGES: usize = 128;
const MAX_CATALOG_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_MANIFEST_CONTRIBUTIONS: usize = 256;

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
            ]);
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
            let enabled = self
                .persisted
                .enabled
                .get(&manifest.id)
                .copied()
                .unwrap_or(entry.default_enabled);
            self.persisted.enabled.insert(manifest.id.clone(), enabled);
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

    pub(super) fn contains_extension(&self, extension_id: &str) -> bool {
        self.summaries.contains_key(extension_id)
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
                    .map(|contribution| contribution.view.as_str())
                    .collect::<std::collections::HashSet<_>>()
            })
            .ok_or_else(|| DaemonError::NotFound("extension not found".to_string()))?;
        for published in &published_views {
            if !declared_views.contains(published.view_id.as_str()) {
                return Err(DaemonError::BadRequest(format!(
                    "extension published undeclared view: {}",
                    published.view_id
                )));
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

    async fn persist(&self) -> Result<(), DaemonError> {
        self.persist_state(&self.persisted).await
    }

    async fn persist_state(&self, state: &PersistedExtensionState) -> Result<(), DaemonError> {
        write_atomically(&self.state_path, serde_json::to_vec_pretty(state)?).await
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
    if !manifest.permissions.is_empty() {
        return Err(DaemonError::BadRequest(
            "extension permissions are not supported by this FalconDeck version".to_string(),
        ));
    }
    let contribution_count = manifest.contributes.thread_menu_actions.len()
        + manifest.contributes.thread_decorations.len()
        + manifest.contributes.sidebar_filters.len();
    if contribution_count > MAX_MANIFEST_CONTRIBUTIONS {
        return Err(DaemonError::BadRequest(format!(
            "extension manifest exceeds {MAX_MANIFEST_CONTRIBUTIONS} contributions"
        )));
    }
    let mut ids = HashSet::new();
    validate_unique_actions(&manifest.contributes.thread_menu_actions, &mut ids)?;
    validate_unique_views(&manifest.contributes.thread_decorations, &mut ids)?;
    validate_unique_views(&manifest.contributes.sidebar_filters, &mut ids)?;
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
            "threadMenuActions" => &["id", "title"][..],
            "threadDecorations" => &["id", "view"][..],
            "sidebarFilters" => &["id", "title", "view"][..],
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
            contributes: ExtensionContributions::default(),
            permissions: Vec::new(),
        }
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
        }];
        assert!(validate_manifest(&duplicate).is_err());

        let mut permissioned = manifest();
        permissioned.permissions.push("filesystem".to_string());
        assert!(validate_manifest(&permissioned).is_err());
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
        let thread_tags = snapshot
            .catalog
            .iter()
            .find(|extension| extension.id == "falcondeck.thread-tags")
            .expect("Thread Tags should be bundled");
        assert!(thread_tags.enabled);
        assert_eq!(thread_tags.status, ExtensionStatus::Active);

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
