//! Persistent coordinator identities; conversation history stays with the harness.
use serde::{Deserialize, Serialize};

use crate::AgentProvider;

/// Default behaviour shown in the bot editor and supplied on every turn.
pub const BOT_DEFAULT_INSTRUCTIONS: &str = concat!(
    "You are a persistent FalconDeck coordinator. Keep the home conversation available for direction. ",
    "Delegate substantial execution to FalconDeck tasks in the appropriate project using falcondeck_create_thread; reuse existing tasks when appropriate. ",
    "Give workers a concrete brief and relevant document paths. Track delegated work, follow up, and bring back results or decisions. ",
    "Do not wait or poll repeatedly for workers: return to the user while they work.\n\n",
    "When referring to another task, link its name as [Task name](falcondeck://thread/THREAD_ID), using the exact thread_id from FalconDeck tools. Links use the stable ID and keep working after renames.\n\n",
    "## Memory and notes\n",
    "Use your document space as persistent memory. When you learn something worth reusing, create or update concise notes there. ",
    "Keep a short MEMORY.md at the root for important facts, user preferences, decisions, ongoing work and your own working instructions, with links to supporting notes. ",
    "Reuse an existing memory index if there is one. Organise supporting notes however useful, including memory/ or docs/ folders inside your document space. ",
    "Consult your memory index when present and read supporting notes when relevant, especially after resuming or compaction, rather than relying on old conversation context. ",
    "Keep useful knowledge current; avoid boilerplate and per-turn logs. Your notes supplement the user's current and standing instructions. ",
    "Respect the user's edits and deletions; do not recreate deleted documents unless asked. ",
    "Use the existing approval flow for actions needing approval."
);

/// A named coordinator backed by one native conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BotProfile {
    /// Stable bot identifier.
    pub id: String,
    /// User-visible name.
    pub name: String,
    /// Workspace owning the native home conversation.
    pub workspace_id: String,
    /// Whether the workspace was created exclusively for this bot.
    pub dedicated_workspace: bool,
    /// Canonical native home conversation.
    pub thread_id: String,
    /// Absolute path to the bot's user-controlled document space.
    pub space_path: String,
    /// Editable role and standing instructions.
    #[serde(default)]
    pub instructions: String,
    /// Whether FalconDeck's coordinator tools may create tasks.
    #[serde(default = "enabled")]
    pub can_start_threads: bool,
}

fn enabled() -> bool {
    true
}

/// Atomic bot edits, separate from replacement preference writes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BotMutation {
    /// Create a bot or promote an existing native conversation.
    Create {
        /// Display name.
        name: String,
        /// Editable standing instructions.
        #[serde(default)]
        instructions: String,
        /// Provider for a new conversation; promoted conversations retain theirs.
        provider: Option<AgentProvider>,
        /// Model for a new conversation.
        model_id: Option<String>,
        /// Existing conversation to promote.
        thread_id: Option<String>,
    },
    /// Update a bot's name, instructions, and delegation capability.
    Update {
        /// Bot identifier.
        id: String,
        /// Display name.
        name: String,
        /// Standing instructions applied on the next turn.
        instructions: String,
        /// Allow creation through FalconDeck coordination tools.
        can_start_threads: bool,
    },
    /// Stop the bot and its active delegated tasks.
    Stop {
        /// Bot identifier.
        id: String,
    },
    /// Remove the bot identity and archive its conversation, preserving files.
    Delete {
        /// Bot identifier.
        id: String,
    },
}

/// A plain-text document in a bot's space.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotDocument {
    /// Filename relative to the bot's space.
    pub name: String,
    /// UTF-8 text content.
    pub content: String,
    /// Content hash used to detect edits made in Finder or by the bot.
    pub version: String,
}

/// Explicit user operation on a document. Names are confined to the bot space.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BotDocumentMutation {
    /// Create or replace a document.
    Write {
        /// Filename.
        name: String,
        /// UTF-8 contents.
        content: String,
        /// Version being edited; absent creates a new document only.
        expected_version: Option<String>,
    },
    /// Delete a document.
    Delete {
        /// Filename.
        name: String,
        /// Version being deleted; a changed file must be reloaded first.
        expected_version: String,
    },
}
