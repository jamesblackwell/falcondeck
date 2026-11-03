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
    "Create tasks with model \"auto\" so FalconDeck picks the harness, model and effort from the user's routing rules; name a specific model only when the user asked for one or the work needs it. ",
    "Report results as short summaries with task links, not transcripts.\n\n",
    "Message other bots or tasks only for decisions, blockers, review requests, results or surprises. ",
    "Do not message a paused or archived bot. ",
    "Never send acknowledgements, thanks, progress narration or replies that need no action.\n\n",
    "## Scheduling\n",
    "Choose the home/current thread only when a run needs conversation context (such as a launch discussed at length). Otherwise use new_each_run with target.run_as_bot set to the bot id; write explicit criteria for sending one message home, otherwise update STATUS.md and finish silently. No-action scheduled runs must not message anyone.\n\n",
    "## Reviews\n",
    "When you need James to decide on work you can show (mock-ups, screenshots, reports), publish a review with your recommendation instead of sending links.\n\n",
    "## Status\n",
    "Keep a short STATUS.md (under 4 KB) at the root of your document space: an Updated date line, then four sections: priorities, in flight (linked tasks), waiting on the user, and recently done. One line per item, linking to detail. ",
    "Rewrite it in place before ending any turn that changed your work; never append a log. The user and other bots read it instead of asking you for updates, and you can read theirs. ",
    "When a task finishes, read its summary: record the outcome in STATUS.md, move lasting decisions or lessons into memory, and drop the task from in flight.\n\n",
    "## Memory and notes\n",
    "Harness-native memory does not move with you: keep durable memory in your document space (MEMORY.md). ",
    "Use your document space as persistent memory. When you learn something worth reusing, create or update concise notes there. ",
    "Keep a short MEMORY.md (under 8 KB) at the root for important facts, user preferences, decisions and your own working instructions, with links to supporting notes. Tidy your own files as you go rather than in sweeps; FalconDeck adds an Upkeep note to your turn when a file grows too large or STATUS.md goes stale. ",
    "Current and recent work belongs in STATUS.md, not memory. ",
    "Reuse an existing memory index if there is one. Organise supporting notes however useful, including memory/ or docs/ folders inside your document space. ",
    "Consult your memory index when present and read supporting notes when relevant, especially after resuming or compaction, rather than relying on old conversation context. ",
    "Keep useful knowledge current; avoid boilerplate and per-turn logs. Your notes supplement the user's current and standing instructions. ",
    "Respect the user's edits and deletions; do not recreate deleted documents unless asked. ",
    "If a context file says bots may edit it (a shared team index such as SHARED.md), follow its rules: one terse line per fact pointing to where the detail lives, only what another bot must know, your own lines only, and remove lines once stale. Prefer a shared line to an FYI message. ",
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
    /// Former homes, retained for messages, task origins and analytics.
    #[serde(default)]
    pub previous_thread_ids: Vec<String>,
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
    /// Sidebar mark; older profiles get one assigned on the next bot change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<BotIcon>,
    /// `active` when absent. Pause and archive keep the profile.
    #[serde(default, skip_serializing_if = "BotStatus::is_active")]
    pub status: BotStatus,
}

/// Whether a bot is working, resting in the sidebar, or hidden.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum BotStatus {
    /// Runs schedules and can be messaged.
    #[default]
    Active,
    /// Stays in the sidebar. Schedules wait and other bots cannot message it.
    Paused,
    /// Hidden from the working list, with the same freeze as paused.
    Archived,
}

impl BotStatus {
    fn is_active(status: &Self) -> bool {
        matches!(status, Self::Active)
    }

    /// Pause and archive both stop autonomous work.
    pub fn is_resting(&self) -> bool {
        !Self::is_active(self)
    }

    /// Wire and sentence form: `active`, `paused`, or `archived`.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Archived => "archived",
        }
    }
}

/// Shapes a bot mark can take, in assignment order.
pub const BOT_ICON_SHAPES: [&str; 8] = [
    "circle", "diamond", "square", "triangle", "hexagon", "star", "pentagon", "cross",
];

/// Categorical color tokens (`cat-1`…`cat-12`), in assignment order.
pub const BOT_ICON_COLORS: [&str; 12] = [
    "cat-1", "cat-2", "cat-3", "cat-4", "cat-5", "cat-6", "cat-7", "cat-8", "cat-9", "cat-10",
    "cat-11", "cat-12",
];

/// A small colored shape identifying a bot. Colors are theme tokens, not hex.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BotIcon {
    /// One of [`BOT_ICON_SHAPES`].
    pub shape: String,
    /// One of [`BOT_ICON_COLORS`].
    pub color: String,
}

impl BotIcon {
    /// Whether both parts are known values.
    pub fn is_valid(&self) -> bool {
        BOT_ICON_SHAPES.contains(&self.shape.as_str())
            && BOT_ICON_COLORS.contains(&self.color.as_str())
    }

    /// First shape and first color not already used by `taken`.
    pub fn next_unused<'a>(taken: impl IntoIterator<Item = &'a BotIcon> + Clone) -> BotIcon {
        let unused = |options: &[&str], part: fn(&BotIcon) -> &str| {
            options
                .iter()
                .copied()
                .find(|option| !taken.clone().into_iter().any(|icon| part(icon) == *option))
                .unwrap_or(options[taken.clone().into_iter().count() % options.len()])
                .to_string()
        };
        BotIcon {
            shape: unused(&BOT_ICON_SHAPES, |icon| icon.shape.as_str()),
            color: unused(&BOT_ICON_COLORS, |icon| icon.color.as_str()),
        }
    }
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
        /// Replacement sidebar mark; absent keeps the current one.
        #[serde(default)]
        icon: Option<BotIcon>,
    },
    /// Move the existing identity to a fresh native conversation (also on the same provider).
    SwitchConversation {
        /// Stable bot identifier.
        id: String,
        /// Destination harness.
        provider: AgentProvider,
        /// Destination model; absent uses the harness default.
        model_id: Option<String>,
        /// Destination reasoning effort.
        reasoning_effort: Option<String>,
    },
    /// Put bots in this order; bots not listed keep their relative order after them.
    Reorder {
        /// Bot identifiers, first to last.
        ids: Vec<String>,
    },
    /// Stop the bot and its active delegated tasks.
    Stop {
        /// Bot identifier.
        id: String,
    },
    /// Pause, archive, or resume a bot without removing it.
    SetStatus {
        /// Bot identifier.
        id: String,
        /// `active`, `paused`, or `archived`.
        status: BotStatus,
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
    /// File modification time, absent when the filesystem cannot report it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<chrono::DateTime<chrono::Utc>>,
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

impl BotProfile {
    /// Resolve both the active home and its historical aliases.
    pub fn owns_thread(&self, thread: &str) -> bool {
        self.thread_id == thread || self.previous_thread_ids.iter().any(|id| id == thread)
    }
}
