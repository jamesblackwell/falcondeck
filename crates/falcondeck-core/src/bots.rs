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
    "## Coordinating work\n",
    "To see what is happening, call falcondeck_list_threads: it covers every project, newest activity first, with each thread's status, last request and latest reply. Narrow it with workspace_id, status, updated_since or parent: \"self\" (your own tasks). ",
    "Use falcondeck_thread_summary for outcomes, files, commits and checks, and falcondeck_thread_changes with the Now value from your last check to see only what changed. ",
    "Before creating a task, look for one already doing the work and message it instead. ",
    "Brief new tasks so they stand alone: the goal, relevant files or documents, constraints, and what done looks like (tests, a commit, or a report). ",
    "Ask tasks to record lasting facts about code in that project's own docs as part of their work. ",
    "Report results as short summaries with task links, not transcripts.\n\n",
    "Message other bots or tasks only for decisions, blockers, review requests, results or surprises. ",
    "Never send acknowledgements, thanks, progress narration or replies that need no action.\n\n",
    "## Status\n",
    "Keep a short STATUS.md at the root of your document space with four sections: priorities, in flight (linked tasks), waiting on the user, and recently done. ",
    "Rewrite it in place at checkpoints; never append a log. The user and other bots read it instead of asking you for updates, and you can read theirs. ",
    "When a task finishes, read its summary: record the outcome in STATUS.md, move lasting decisions or lessons into memory, and drop the task from in flight.\n\n",
    "## Memory and notes\n",
    "Use your document space as persistent memory. When you learn something worth reusing, create or update concise notes there. ",
    "Keep a short MEMORY.md at the root for important facts, user preferences, decisions and your own working instructions, with links to supporting notes. ",
    "Current and recent work belongs in STATUS.md, not memory. ",
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
    /// Absolute paths of text files read into every turn, in order.
    #[serde(default)]
    pub context_files: Vec<String>,
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
        /// Replacement context file list; absent keeps the current list.
        #[serde(default)]
        context_files: Option<Vec<String>>,
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

/// One labelled part of the context FalconDeck adds to a bot's turns.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BotContextSection {
    /// Short user-facing label.
    pub label: String,
    /// Source file for context files.
    #[serde(default)]
    pub path: Option<String>,
    /// Rough token estimate (about four characters per token).
    pub tokens: u64,
    /// Why a context file could not be read.
    #[serde(default)]
    pub error: Option<String>,
}

/// Exactly what a bot's next turn receives, with a size breakdown.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BotContextReport {
    /// Sections in injection order.
    pub sections: Vec<BotContextSection>,
    /// Sum of section estimates.
    pub total_tokens: u64,
    /// Full injected text.
    pub text: String,
}

/// A text file that can be attached to bots as context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextFile {
    /// Absolute path.
    pub path: String,
    /// File name.
    pub name: String,
    /// FalconDeck's context folder, or the project folder containing it.
    pub location: String,
    /// Rough token estimate.
    pub tokens: u64,
}

/// Context files found in FalconDeck's folder and at project roots.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextFileList {
    /// FalconDeck's own context folder.
    pub folder: String,
    /// Suggested files, FalconDeck's folder first.
    pub files: Vec<ContextFile>,
}

/// Contents of a context file, versioned like bot documents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextFileContent {
    /// Absolute path.
    pub path: String,
    /// UTF-8 text content.
    pub content: String,
    /// Content hash used to detect edits made elsewhere.
    pub version: String,
}

/// Save a known context file, or create one in FalconDeck's folder by name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextFileWrite {
    /// Existing file to replace; requires `expected_version`.
    #[serde(default)]
    pub path: Option<String>,
    /// New file name inside FalconDeck's context folder.
    #[serde(default)]
    pub name: Option<String>,
    /// UTF-8 contents.
    pub content: String,
    /// Version being edited.
    #[serde(default)]
    pub expected_version: Option<String>,
}
