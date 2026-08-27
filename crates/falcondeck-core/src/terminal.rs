//! Terminal session contract shared by the daemon and its clients.
//!
//! A terminal session is daemon-owned runtime state: the daemon spawns the
//! PTY, buffers bounded scrollback, and streams base64 output chunks with
//! monotonically increasing sequence numbers so a client can attach, replay
//! what it missed, and detect gaps. Sessions are never persisted.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A live daemon-side terminal session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalSessionInfo {
    /// Opaque daemon-assigned session id.
    pub id: String,
    /// Workspace the session was opened in; the shell starts in its path.
    pub workspace_id: String,
    /// Shell binary the PTY was spawned with (`/bin/zsh`).
    pub shell: String,
    /// Default tab title (shell binary name) until the client observes an
    /// OSC title from the running program.
    pub title: String,
    /// Absolute directory the shell started in.
    pub cwd: String,
    /// Requested initial column count.
    pub cols: u16,
    /// Requested initial row count.
    pub rows: u16,
    /// When the daemon spawned the PTY.
    pub created_at: DateTime<Utc>,
}

/// Body for `POST /api/workspaces/{workspace_id}/terminals`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenTerminalRequest {
    /// Initial column count for the PTY.
    pub cols: u16,
    /// Initial row count for the PTY.
    pub rows: u16,
}

/// Response for terminal list endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalListResponse {
    /// Live sessions, oldest first.
    pub sessions: Vec<TerminalSessionInfo>,
}

/// Response for `POST .../terminals`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalOpenedResponse {
    /// The session the daemon just spawned.
    pub session: TerminalSessionInfo,
}

/// Client-to-daemon frames carried on the per-terminal WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalClientFrame {
    /// Raw bytes for the PTY master, base64-encoded.
    TerminalInput {
        /// Base64 of the keystroke bytes.
        data_base64: String,
    },
    /// Resize the PTY to the client's current viewport.
    TerminalResize {
        /// New column count.
        cols: u16,
        /// New row count.
        rows: u16,
    },
    /// Liveness probe; the daemon replies with `TerminalPong`.
    TerminalPing,
}

/// One scrollback chunk: output bytes plus the position they occupy in the
/// session's monotonic chunk sequence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalChunk {
    /// Monotonic per-session sequence number starting at 0.
    pub seq: u64,
    /// Base64 of the output bytes.
    pub data_base64: String,
}

/// Daemon-to-client frames carried on the per-terminal WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalServerFrame {
    /// Attachment accepted. `next_seq` is the sequence the next live chunk
    /// will carry; chunks below it up to the replay start were pruned.
    TerminalAttached {
        /// The attached session.
        session: TerminalSessionInfo,
        /// Sequence number the next live chunk will carry.
        next_seq: u64,
    },
    /// A replayed chunk (seq below `next_seq` at attach time).
    TerminalReplay {
        /// The historical chunk.
        chunk: TerminalChunk,
    },
    /// A live output chunk.
    TerminalOutput {
        /// The output chunk.
        chunk: TerminalChunk,
    },
    /// The shell process exited; the session is gone.
    TerminalExited {
        /// Exit code when known, or `null` when the daemon killed it.
        exit_code: Option<i32>,
    },
    /// The request failed; the session may be gone.
    TerminalError {
        /// Human-readable failure description.
        message: String,
    },
    /// Reply to `TerminalPing`.
    TerminalPong,
}
