//! Terminal session contract shared by the daemon and its clients.
//!
//! A terminal session is daemon-owned runtime state: the daemon spawns the
//! PTY, buffers bounded scrollback, and streams output chunks with
//! monotonically increasing sequence numbers so a client can attach, replay
//! what it missed, and detect gaps. Live PTY bytes travel as binary WebSocket
//! frames; attach, resize, ping, and exit stay JSON. Sessions are never
//! persisted.

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

/// Kind byte for a replayed PTY output chunk on the binary WebSocket.
pub const TERMINAL_WIRE_REPLAY: u8 = 1;
/// Kind byte for a live PTY output chunk on the binary WebSocket.
pub const TERMINAL_WIRE_OUTPUT: u8 = 2;
/// Kind byte for client-to-daemon PTY input on the binary WebSocket.
pub const TERMINAL_WIRE_INPUT: u8 = 0x10;

/// Encodes a PTY output or replay chunk as a binary WebSocket payload:
/// `[kind u8][seq u64 le][bytes]`. Control frames stay JSON text.
pub fn encode_output_wire(replay: bool, seq: u64, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + bytes.len());
    out.push(if replay {
        TERMINAL_WIRE_REPLAY
    } else {
        TERMINAL_WIRE_OUTPUT
    });
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

/// Decodes a binary PTY output payload. Returns `(replay, seq, bytes)`.
pub fn decode_output_wire(data: &[u8]) -> Option<(bool, u64, &[u8])> {
    if data.len() < 9 {
        return None;
    }
    let replay = match data[0] {
        TERMINAL_WIRE_REPLAY => true,
        TERMINAL_WIRE_OUTPUT => false,
        _ => return None,
    };
    let seq_bytes: [u8; 8] = data[1..9].try_into().ok()?;
    Some((replay, u64::from_le_bytes(seq_bytes), &data[9..]))
}

/// Encodes client PTY input as `[kind u8][bytes]`.
pub fn encode_input_wire(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + bytes.len());
    out.push(TERMINAL_WIRE_INPUT);
    out.extend_from_slice(bytes);
    out
}

/// Decodes a binary client-to-daemon PTY input payload.
pub fn decode_input_wire(data: &[u8]) -> Option<&[u8]> {
    if data.first().copied() != Some(TERMINAL_WIRE_INPUT) {
        return None;
    }
    Some(&data[1..])
}

#[cfg(test)]
mod wire_tests {
    use super::{
        TERMINAL_WIRE_INPUT, TERMINAL_WIRE_OUTPUT, TERMINAL_WIRE_REPLAY, decode_input_wire,
        decode_output_wire, encode_input_wire, encode_output_wire,
    };

    #[test]
    fn output_wire_round_trips_live_and_replay() {
        let live = encode_output_wire(false, 42, b"abc");
        assert_eq!(live[0], TERMINAL_WIRE_OUTPUT);
        assert_eq!(
            decode_output_wire(&live),
            Some((false, 42, b"abc".as_slice()))
        );

        let replay = encode_output_wire(true, 0, b"");
        assert_eq!(replay[0], TERMINAL_WIRE_REPLAY);
        assert_eq!(decode_output_wire(&replay), Some((true, 0, b"".as_slice())));
    }

    #[test]
    fn output_wire_rejects_truncated_or_unknown_kind() {
        assert_eq!(decode_output_wire(&[TERMINAL_WIRE_OUTPUT, 1, 2, 3]), None);
        let mut payload = encode_output_wire(false, 1, b"x");
        payload[0] = 0x99;
        assert_eq!(decode_output_wire(&payload), None);
    }

    #[test]
    fn input_wire_round_trips() {
        let encoded = encode_input_wire(b"ls\n");
        assert_eq!(encoded[0], TERMINAL_WIRE_INPUT);
        assert_eq!(decode_input_wire(&encoded), Some(b"ls\n".as_slice()));
        assert_eq!(decode_input_wire(b""), None);
        assert_eq!(decode_input_wire(&[TERMINAL_WIRE_OUTPUT, b'x']), None);
    }
}
