//! Local disk inventory and daemon-owned cleanup; native agent stores are read-only.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct StoragePreferences {
    pub scheduled: bool,
    pub clear_caches: bool,
    pub reclaim_checkouts: bool,
    pub delete_old_artifacts: bool,
    pub delete_old_experiments: bool,
    pub warnings: bool,
}
impl Default for StoragePreferences {
    fn default() -> Self {
        Self {
            scheduled: true,
            clear_caches: true,
            reclaim_checkouts: true,
            delete_old_artifacts: false,
            delete_old_experiments: false,
            warnings: true,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageVariant {
    pub workspace_id: String,
    pub thread_id: String,
    pub title: String,
    pub project: String,
    pub path: String,
    pub bytes: u64,
    pub cache_bytes: u64,
    pub idle_days: i64,
    pub archived: bool,
    pub status: String,
    pub blocked: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageCandidate {
    pub category: String,
    pub path: String,
    pub bytes: u64,
    pub blocked: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct StorageRun {
    #[serde(default)]
    pub id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub entries: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageReport {
    pub generated_at: i64,
    pub free_bytes: Option<u64>,
    pub categories: BTreeMap<String, u64>,
    pub projects: BTreeMap<String, u64>,
    pub variants: Vec<StorageVariant>,
    pub candidates: Vec<StorageCandidate>,
    pub preferences: StoragePreferences,
    pub runs: Vec<StorageRun>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageActionRequest {
    pub workspace_id: String,
    pub thread_id: String,
    pub action: StorageAction,
    pub confirmed: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StorageAction {
    ClearCaches,
    Reclaim,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageCleanupRequest {
    pub confirmed: bool,
}
