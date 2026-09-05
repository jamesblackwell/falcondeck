//! Additive remote index contract. `snapshot.current` retains its full meaning.
use crate::{DaemonSnapshot, ModelSummary, ThreadSummary, WorkspaceAgentSummary};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Counts cover the complete frozen index, including rows not loaded yet.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WorkspaceIndexCount {
    /// Non-archived rows in this workspace.
    pub total: usize,
    /// Running rows.
    pub running: usize,
    /// Unread rows.
    pub unread: usize,
    /// Rows needing an approval or answer.
    pub awaiting: usize,
}

/// Initial compact view. Repeated catalogs are reconstructed by shared clients.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncIndex {
    /// Opaque identity of this immutable view; never a relay replay cursor.
    pub token: String,
    /// Ordinary snapshot shape with a partial thread list and catalog references.
    pub snapshot: DaemonSnapshot,
    /// Distinct provider catalogs, with skills omitted.
    pub agent_catalogs: Vec<WorkspaceAgentSummary>,
    /// Provider catalog indexes per workspace, in the original order.
    pub workspace_agents: BTreeMap<String, Vec<usize>>,
    /// Distinct workspace model lists.
    pub model_catalogs: Vec<Vec<ModelSummary>>,
    /// Model catalog index for each workspace.
    pub workspace_models: BTreeMap<String, usize>,
    /// Complete counts, not counts of the initial page.
    pub counts: BTreeMap<String, WorkspaceIndexCount>,
}

/// An independently consumable, byte-bounded page from an immutable index.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncThreadPage {
    /// Same opaque view token as the request.
    pub token: String,
    /// Scope of this page.
    pub workspace_id: String,
    /// Complete summary rows; absence is not a deletion.
    pub threads: Vec<ThreadSummary>,
    /// Offset for the next page, or none at the end of the frozen view.
    pub next_cursor: Option<usize>,
}
