//! Synced, virtual folders for organizing tasks within a project.

use serde::{Deserialize, Serialize};

/// A navigation folder; it never changes a task's working directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectFolder {
    /// Stable folder identifier.
    pub id: String,
    /// Project that owns the folder.
    pub workspace_id: String,
    /// User-visible folder name.
    pub name: String,
    /// Whether the contents are folded away on connected clients.
    #[serde(default)]
    pub collapsed: bool,
    /// Task ids assigned to this folder, including archived tasks.
    #[serde(default)]
    pub thread_ids: Vec<String>,
}

/// One atomic folder edit, applied to the daemon's latest preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectFolderMutation {
    /// Project being edited.
    pub workspace_id: String,
    /// Requested edit.
    #[serde(flatten)]
    pub action: ProjectFolderAction,
}

/// Supported project folder edits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ProjectFolderAction {
    /// Create an empty folder.
    Create {
        /// Folder name, trimmed by the daemon.
        name: String,
    },
    /// Change a folder's display name.
    Rename {
        /// Folder to rename.
        folder_id: String,
        /// New display name.
        name: String,
    },
    /// Synchronize the disclosure state.
    SetCollapsed {
        /// Folder to fold or unfold.
        folder_id: String,
        /// New disclosure state.
        collapsed: bool,
    },
    /// Remove a folder, returning its tasks to the project root.
    Delete {
        /// Folder to remove.
        folder_id: String,
    },
    /// Move a task between folders or back to the project root.
    MoveThread {
        /// Task to move.
        thread_id: String,
        /// Destination; null means the project root.
        folder_id: Option<String>,
    },
}
