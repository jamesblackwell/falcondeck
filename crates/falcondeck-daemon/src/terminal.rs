//! Daemon-owned terminal sessions.
//!
//! Each session wraps a PTY spawned with `portable-pty`. The daemon keeps a
//! bounded scrollback of output chunks with monotonically increasing sequence
//! numbers so any WebSocket client can attach (optionally replaying from a
//! sequence it has already seen), stream live output, and detect gaps after a
//! disconnect. Sessions live entirely in daemon memory: closing the desktop
//! never kills a shell, and there is nothing to persist.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use falcondeck_core::terminal::{
    TerminalChunk, TerminalClientFrame, TerminalServerFrame, TerminalSessionInfo,
};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

/// Retained replay bytes per session. Old chunks are pruned from the front
/// once the total exceeds this; the sequence numbers stay monotonic so
/// clients can always detect the loss.
const SCROLLBACK_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Largest single output chunk before it is split into multiple sequences.
const MAX_CHUNK_BYTES: usize = 64 * 1024;
/// How long a close waits after SIGHUP before SIGKILL.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
/// Upper bound on DA1 replies per output batch so a hostile program cannot
/// loop the daemon into an unbounded write queue (mirrors the PTY-boundary
/// answerback approach: shells query device attributes before any emulator
/// has attached, and replayed output must not trigger duplicate replies).
const MAX_DA1_REPLIES_PER_BATCH: usize = 8;
/// Primary device-attributes reply sent at the PTY boundary.
const DA1_REPLY: &[u8] = b"\x1b[?1;2c";

const DA1_QUERY_PATTERNS: [&[u8]; 2] = [b"\x1b[0c", b"\x1b[c"];

/// Strips primary device-attributes queries from PTY output and counts them
/// so the daemon can answer once, itself, regardless of emulator attachment.
#[derive(Default)]
struct Da1Filter {
    pending: Vec<u8>,
}

impl Da1Filter {
    fn is_partial_pattern_suffix(suffix: &[u8]) -> bool {
        DA1_QUERY_PATTERNS
            .iter()
            .any(|pattern| pattern.starts_with(suffix))
    }

    /// Filters one output batch. Returns the bytes to forward (queries
    /// removed, carried partial suffix withheld) and how many complete
    /// queries were found.
    fn filter(&mut self, batch: &[u8]) -> (Vec<u8>, usize) {
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(batch);

        let mut output = Vec::with_capacity(input.len());
        let mut replies = 0;
        let mut index = 0;
        'scan: while index < input.len() {
            for pattern in DA1_QUERY_PATTERNS {
                if input[index..].starts_with(pattern) {
                    replies += 1;
                    index += pattern.len();
                    continue 'scan;
                }
            }
            output.push(input[index]);
            index += 1;
        }

        // Withhold a trailing partial query so it can complete in the next
        // batch instead of leaking escape bytes into the stream.
        for suffix_len in (1..=3usize).rev() {
            if input.len() >= suffix_len
                && Self::is_partial_pattern_suffix(&input[input.len() - suffix_len..])
            {
                self.pending = input.split_off(input.len() - suffix_len);
                output.truncate(output.len() - suffix_len);
                break;
            }
        }

        (output, replies)
    }
}

struct Scrollback {
    chunks: VecDeque<(u64, Vec<u8>)>,
    bytes: usize,
    next_seq: u64,
}

impl Scrollback {
    fn new() -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            next_seq: 0,
        }
    }

    fn append(&mut self, data: &[u8], max_bytes: usize) -> Vec<(u64, Vec<u8>)> {
        let mut committed = Vec::new();
        for piece in data.chunks(MAX_CHUNK_BYTES) {
            let seq = self.next_seq;
            self.next_seq += 1;
            self.chunks.push_back((seq, piece.to_vec()));
            self.bytes += piece.len();
            committed.push((seq, piece.to_vec()));
        }
        while self.bytes > max_bytes && self.chunks.len() > 1 {
            let (_, removed) = self.chunks.pop_front().expect("chunks is non-empty");
            self.bytes -= removed.len();
        }
        committed
    }
}

struct TerminalSession {
    info: TerminalSessionInfo,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Unix process id of the shell; the process group shares it because
    /// `portable-pty` makes the child a session leader.
    pid: Mutex<Option<u32>>,
    scrollback: Mutex<Scrollback>,
    clients: Mutex<Vec<(u64, tokio::sync::mpsc::UnboundedSender<TerminalServerFrame>)>>,
    scrollback_max_bytes: usize,
}

impl TerminalSession {
    fn write_input(&self, data: &[u8]) {
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writer.write_all(data);
            let _ = writer.flush();
        }
    }

    fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.lock().expect("master lock").resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    fn broadcast(&self, frame: TerminalServerFrame) {
        let mut clients = self.clients.lock().expect("clients lock");
        clients.retain(|(_, client)| client.send(frame.clone()).is_ok());
    }

    /// Appends filtered output to the scrollback and fans it out to clients.
    fn commit_output(&self, data: &[u8]) {
        let committed = {
            let mut scrollback = self.scrollback.lock().expect("scrollback lock");
            scrollback.append(data, self.scrollback_max_bytes)
        };
        for (seq, bytes) in committed {
            self.broadcast(live_frame(seq, &bytes));
        }
    }

    fn clear_clients(&self) {
        self.clients.lock().expect("clients lock").clear();
    }
}

// portable-pty models rows/cols directly as `u16`, so the struct above stores
// the session size without conversion.

fn live_frame(seq: u64, bytes: &[u8]) -> TerminalServerFrame {
    TerminalServerFrame::TerminalOutput {
        chunk: TerminalChunk {
            seq,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        },
    }
}

/// Owns every live terminal session.
#[derive(Default)]
pub struct TerminalManager {
    // Arc so the per-session exit watcher thread can remove its own session
    // from the same map the manager hands out.
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    next_client_id: std::sync::atomic::AtomicU64,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sessions for one workspace, oldest first.
    pub fn list(&self, workspace_id: &str) -> Vec<TerminalSessionInfo> {
        let mut sessions: Vec<TerminalSessionInfo> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .values()
            .filter(|session| session.info.workspace_id == workspace_id)
            .map(|session| session.info.clone())
            .collect();
        sessions.sort_by_key(|session| session.created_at);
        sessions
    }

    fn get(&self, id: &str) -> Option<Arc<TerminalSession>> {
        self.sessions
            .lock()
            .expect("sessions lock")
            .get(id)
            .cloned()
    }

    /// Spawns a login shell in `cwd` and starts its output pump.
    pub fn open(
        &self,
        workspace_id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionInfo, String> {
        if !Path::new(cwd).is_dir() {
            return Err(format!("workspace path is not a directory: {cwd}"));
        }
        let shell = resolve_shell();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("failed to open PTY: {error}"))?;

        let mut command = CommandBuilder::new(&shell);
        command.arg("-l");
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        // Keep the shell from emitting terminal-control escapes the client
        // tab title pipeline did not ask for, and silence zsh's partial-line
        // `%` marker which replays badly.
        command.env("DISABLE_AUTO_TITLE", "true");
        command.env("PROMPT_EOL_MARK", "");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("failed to spawn shell: {error}"))?;
        // The parent's copy of the slave must go away or the master reader
        // never sees EOF when the shell exits.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("failed to attach PTY reader: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("failed to attach PTY writer: {error}"))?;

        let info = TerminalSessionInfo {
            id: format!("term-{}", uuid::Uuid::new_v4().simple()),
            workspace_id: workspace_id.to_string(),
            title: Path::new(&shell)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| shell.clone()),
            shell: shell.clone(),
            cwd: cwd.to_string(),
            cols,
            rows,
            created_at: chrono::Utc::now(),
        };
        let session = Arc::new(TerminalSession {
            info: info.clone(),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            pid: Mutex::new(child.process_id()),
            scrollback: Mutex::new(Scrollback::new()),
            clients: Mutex::new(Vec::new()),
            scrollback_max_bytes: SCROLLBACK_MAX_BYTES,
        });
        self.sessions
            .lock()
            .expect("sessions lock")
            .insert(info.id.clone(), session.clone());

        self.spawn_output_pump(session.clone(), reader);
        self.spawn_exit_watch(session, child);
        Ok(info)
    }

    fn spawn_output_pump(&self, session: Arc<TerminalSession>, mut reader: Box<dyn Read + Send>) {
        let (raw_tx, mut raw_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        // Blocking PTY reads need an OS thread; the unbounded channel hands
        // batches to a tokio task that coalesces bursts before fan-out.
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if raw_tx.send(buffer[..read].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        tokio::spawn(async move {
            let mut filter = Da1Filter::default();
            while let Some(first) = raw_rx.recv().await {
                let mut batch = first;
                while let Ok(more) = raw_rx.try_recv() {
                    batch.extend_from_slice(&more);
                }
                let (output, queries) = filter.filter(&batch);
                if queries > 0 {
                    let reply_count = queries.min(MAX_DA1_REPLIES_PER_BATCH);
                    let reply = DA1_REPLY.repeat(reply_count);
                    session.write_input(&reply);
                }
                if !output.is_empty() {
                    session.commit_output(&output);
                }
            }
        });
    }

    fn spawn_exit_watch(
        &self,
        session: Arc<TerminalSession>,
        mut child: Box<dyn portable_pty::Child + Send + Sync>,
    ) {
        let manager_sessions = self.sessions.clone();
        std::thread::spawn(move || {
            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            manager_sessions
                .lock()
                .expect("sessions lock")
                .remove(&session.info.id);
            session.broadcast(TerminalServerFrame::TerminalExited { exit_code });
            session.clear_clients();
        });
    }

    /// Attaches a client: registers a frame channel, then sends the current
    /// session snapshot and any retained replay at or after `since_seq`.
    /// Returns the client id the WebSocket loop must pass to `detach`.
    pub fn attach(
        &self,
        id: &str,
        since_seq: u64,
    ) -> Option<(
        TerminalSessionInfo,
        tokio::sync::mpsc::UnboundedReceiver<TerminalServerFrame>,
        u64,
    )> {
        let session = self.get(id)?;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (info, next_seq, replay) = {
            let scrollback = session.scrollback.lock().expect("scrollback lock");
            let replay: Vec<(u64, Vec<u8>)> = scrollback
                .chunks
                .iter()
                .filter(|(seq, _)| *seq >= since_seq)
                .map(|(seq, bytes)| (*seq, bytes.clone()))
                .collect();
            (session.info.clone(), scrollback.next_seq, replay)
        };
        let _ = tx.send(TerminalServerFrame::TerminalAttached {
            session: info.clone(),
            next_seq,
        });
        for (seq, bytes) in replay {
            let _ = tx.send(TerminalServerFrame::TerminalReplay {
                chunk: TerminalChunk {
                    seq,
                    data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                },
            });
        }
        let client_id = self
            .next_client_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        session
            .clients
            .lock()
            .expect("clients lock")
            .push((client_id, tx));
        Some((info, rx, client_id))
    }

    /// Drops one attached client channel once its WebSocket loop ends.
    pub fn detach(&self, id: &str, client_id: u64) {
        if let Some(session) = self.get(id) {
            session
                .clients
                .lock()
                .expect("clients lock")
                .retain(|(registered, _)| *registered != client_id);
        }
    }

    /// Handles one decoded client frame (input, resize, or ping).
    pub fn handle_client_frame(&self, id: &str, frame: &TerminalClientFrame) {
        let Some(session) = self.get(id) else {
            return;
        };
        match frame {
            TerminalClientFrame::TerminalInput { data_base64 } => {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_base64) {
                    session.write_input(&bytes);
                }
            }
            TerminalClientFrame::TerminalResize { cols, rows } => session.resize(*cols, *rows),
            TerminalClientFrame::TerminalPing => {}
        }
    }

    /// Closes a session: SIGHUP to the shell's process group (what closing a
    /// terminal emulator sends), SIGKILL after the grace period if it
    /// survives. The exit watcher broadcasts the exit and removes the session.
    pub fn close(&self, id: &str) -> bool {
        let Some(session) = self.get(id) else {
            return false;
        };
        terminate_session(&session);
        let force_session = session.clone();
        tokio::spawn(async move {
            tokio::time::sleep(CLOSE_GRACE).await;
            force_kill_session(&force_session);
        });
        true
    }

    /// Terminates every session; used on daemon shutdown. SIGHUP with a
    /// SIGKILL sweep after the grace period.
    pub async fn shutdown_all(&self) {
        let sessions: Vec<Arc<TerminalSession>> = {
            let sessions = self.sessions.lock().expect("sessions lock");
            sessions.values().cloned().collect()
        };
        for session in &sessions {
            terminate_session(session);
        }
        if !sessions.is_empty() {
            tokio::time::sleep(CLOSE_GRACE).await;
            for session in &sessions {
                force_kill_session(session);
            }
        }
    }
}

fn terminate_session(session: &TerminalSession) {
    let pid = { *session.pid.lock().expect("pid lock") };
    #[cfg(unix)]
    if let Some(pid) = pid {
        // Negative pid targets the whole process group; the shell is a
        // session leader so login shells and their children get the signal.
        // SIGHUP is what closing a terminal emulator sends: interactive bash
        // ignores SIGTERM, so a graceful close would hang on it.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGHUP);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

fn force_kill_session(session: &TerminalSession) {
    // Take: the force kill is the last step, and consuming the pid makes a
    // repeated force kill a no-op.
    let pid = session.pid.lock().expect("pid lock").take();
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

fn resolve_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        let trimmed = shell.trim();
        if !trimmed.is_empty() && Path::new(trimmed).exists() {
            return trimmed.to_string();
        }
    }
    ["/bin/zsh", "/bin/bash", "/bin/sh"]
        .into_iter()
        .find(|candidate| Path::new(candidate).exists())
        .unwrap_or("/bin/sh")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_filtered(input: &[u8], expected_output: &[u8], expected_replies: usize) {
        let mut filter = Da1Filter::default();
        let (output, replies) = filter.filter(input);
        assert_eq!(output, expected_output, "output for {input:?}");
        assert_eq!(replies, expected_replies, "replies for {input:?}");
    }

    #[test]
    fn da1_filter_strips_complete_queries() {
        assert_filtered(b"hello", b"hello", 0);
        assert_filtered(b"\x1b[0c", b"", 1);
        assert_filtered(b"a\x1b[cb", b"ab", 1);
        assert_filtered(b"\x1b[0c\x1b[c\x1b[0c", b"", 3);
    }

    #[test]
    fn da1_filter_carries_partial_queries_across_batches() {
        let mut filter = Da1Filter::default();
        let (output, replies) = filter.filter(b"ok\x1b");
        assert_eq!(output, b"ok");
        assert_eq!(replies, 0);

        let (output, replies) = filter.filter(b"[0cmore");
        assert_eq!(output, b"more");
        assert_eq!(replies, 1);
    }

    #[test]
    fn da1_filter_keeps_partial_suffix_visible_in_output() {
        // A trailing ESC that never completes must still reach the client.
        let mut filter = Da1Filter::default();
        let (output, replies) = filter.filter(b"text\x1b[");
        assert_eq!(output, b"text");
        assert_eq!(replies, 0);
        let (output, replies) = filter.filter(b"zz");
        assert_eq!(output, b"\x1b[zz");
        assert_eq!(replies, 0);
    }

    #[test]
    fn scrollback_prunes_from_the_front_and_keeps_sequences_monotonic() {
        let mut scrollback = Scrollback::new();
        let committed = scrollback.append(b"first", 8);
        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].0, 0);

        let committed = scrollback.append(b"second", 8);
        assert_eq!(committed[0].0, 1);
        assert_eq!(scrollback.chunks.len(), 1, "oldest chunk pruned");
        assert_eq!(scrollback.chunks[0].1, b"second");
        assert_eq!(scrollback.next_seq, 2);
    }

    #[test]
    fn scrollback_splits_oversized_batches_into_multiple_chunks() {
        let mut scrollback = Scrollback::new();
        let payload = vec![b'x'; MAX_CHUNK_BYTES + 1];
        let committed = scrollback.append(&payload, usize::MAX);
        assert_eq!(committed.len(), 2);
        assert_eq!(committed[0].1.len(), MAX_CHUNK_BYTES);
        assert_eq!(committed[1].1.len(), 1);
    }

    // Live PTY coverage: spawns real shells, so these stay on /bin/sh and
    // tolerate interleaved prompt output by substring-matching markers.

    fn test_manager() -> TerminalManager {
        // Keep the spawned login shell deterministic across machines.
        // SAFETY: test-only; no other thread reads SHELL concurrently.
        unsafe { std::env::set_var("SHELL", "/bin/sh") };
        TerminalManager::new()
    }

    fn workspace_dir() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_str().expect("utf8 path").to_string();
        (dir, path)
    }

    async fn collect_until(
        receiver: &mut tokio::sync::mpsc::UnboundedReceiver<TerminalServerFrame>,
        timeout: Duration,
        mut predicate: impl FnMut(&TerminalServerFrame) -> bool,
    ) -> TerminalServerFrame {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline
                .checked_duration_since(tokio::time::Instant::now())
                .unwrap_or_default();
            let frame = tokio::time::timeout(remaining, receiver.recv())
                .await
                .expect("timed out waiting for terminal frame")
                .expect("terminal session dropped the client channel");
            if predicate(&frame) {
                return frame;
            }
        }
    }

    /// Blocks until the login shell printed its first prompt. Commands sent
    /// earlier get discarded: bash flushes type-ahead input when it finally
    /// prompts, so every PTY test must wait this out before writing.
    async fn wait_for_shell_prompt(
        receiver: &mut tokio::sync::mpsc::UnboundedReceiver<TerminalServerFrame>,
    ) {
        collect_until(receiver, Duration::from_secs(30), |frame| {
            frame_text(frame).contains('$')
        })
        .await;
    }

    fn frame_text(frame: &TerminalServerFrame) -> String {
        match frame {
            TerminalServerFrame::TerminalOutput { chunk }
            | TerminalServerFrame::TerminalReplay { chunk } => String::from_utf8_lossy(
                &base64::engine::general_purpose::STANDARD
                    .decode(&chunk.data_base64)
                    .expect("valid base64"),
            )
            .to_string(),
            _ => String::new(),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn session_echoes_input_and_replays_scrollback() {
        let manager = test_manager();
        let (_dir, cwd) = workspace_dir();
        let info = manager.open("ws-test", &cwd, 80, 24).expect("open");
        let (_info, mut receiver, client_id) = manager.attach(&info.id, 0).expect("attach");
        wait_for_shell_prompt(&mut receiver).await;

        let marker = "falcondeck-terminal-marker";
        manager.handle_client_frame(
            &info.id,
            &TerminalClientFrame::TerminalInput {
                data_base64: base64::engine::general_purpose::STANDARD
                    .encode(format!("echo {marker}\n")),
            },
        );
        let frame = collect_until(&mut receiver, Duration::from_secs(30), |frame| {
            frame_text(frame).contains(marker)
        })
        .await;
        assert!(matches!(frame, TerminalServerFrame::TerminalOutput { .. }));

        // A fresh client replaying from zero must still see the marker even
        // though the producing client already consumed the live chunk.
        manager.detach(&info.id, client_id);
        let (_info, mut replay_receiver, _replay_client) =
            manager.attach(&info.id, 0).expect("replay attach");
        let frame = collect_until(&mut replay_receiver, Duration::from_secs(5), |frame| {
            matches!(frame, TerminalServerFrame::TerminalReplay { .. })
                && frame_text(frame).contains(marker)
        })
        .await;
        assert!(matches!(frame, TerminalServerFrame::TerminalReplay { .. }));
        manager.close(&info.id);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resize_reaches_the_pty() {
        let manager = test_manager();
        let (_dir, cwd) = workspace_dir();
        let info = manager.open("ws-test", &cwd, 80, 24).expect("open");
        let (_info, mut receiver, _client) = manager.attach(&info.id, 0).expect("attach");
        wait_for_shell_prompt(&mut receiver).await;

        manager.handle_client_frame(
            &info.id,
            &TerminalClientFrame::TerminalResize {
                cols: 100,
                rows: 30,
            },
        );
        manager.handle_client_frame(
            &info.id,
            &TerminalClientFrame::TerminalInput {
                data_base64: base64::engine::general_purpose::STANDARD.encode("stty size\n"),
            },
        );
        let frame = collect_until(&mut receiver, Duration::from_secs(30), |frame| {
            frame_text(frame).contains("30 100")
        })
        .await;
        assert!(frame_text(&frame).contains("30 100"));
        manager.close(&info.id);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn da1_query_is_answered_at_the_pty_boundary() {
        let manager = test_manager();
        let (_dir, cwd) = workspace_dir();
        let info = manager.open("ws-test", &cwd, 80, 24).expect("open");
        let (_info, mut receiver, _client) = manager.attach(&info.id, 0).expect("attach");
        wait_for_shell_prompt(&mut receiver).await;

        // Emit a real DA1 query on the shell's stdout, then read the reply as
        // raw bytes while the command still owns the terminal. Checking the
        // bytes avoids depending on how a particular shell or line editor
        // renders an unsolicited escape sequence at its prompt.
        manager.handle_client_frame(
            &info.id,
            &TerminalClientFrame::TerminalInput {
                data_base64: base64::engine::general_purpose::STANDARD
                    .encode(concat!(
                        "stty -echo -icanon min 1 time 0; ",
                        "printf '\\033[0c'; ",
                        "dd bs=1 count=7 2>/dev/null | od -An -tx1; ",
                        "stty sane; echo DA1-DONE\n"
                    )),
            },
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut seen = String::new();
        let has_da1_reply = |output: &str| {
            output
                .split_whitespace()
                .collect::<Vec<_>>()
                .windows(7)
                .any(|bytes| bytes == ["1b", "5b", "3f", "31", "3b", "32", "63"])
        };
        loop {
            let remaining = deadline
                .checked_duration_since(tokio::time::Instant::now())
                .unwrap_or_default();
            match tokio::time::timeout(remaining, receiver.recv()).await {
                Ok(Some(frame)) => {
                    seen.push_str(&frame_text(&frame));
                    if seen.contains("DA1-DONE") && has_da1_reply(&seen) {
                        break;
                    }
                }
                Ok(None) => panic!("channel closed; seen={seen:?}"),
                Err(_) => panic!("timed out waiting for DA1 reply; seen={seen:?}"),
            }
        }
        assert!(
            !seen.contains("\x1b[0c"),
            "raw DA1 query must be stripped from client output: {seen:?}"
        );
        manager.close(&info.id);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn close_notifies_clients_and_removes_the_session() {
        let manager = test_manager();
        let (_dir, cwd) = workspace_dir();
        let info = manager.open("ws-test", &cwd, 80, 24).expect("open");
        let (_info, mut receiver, _client) = manager.attach(&info.id, 0).expect("attach");
        wait_for_shell_prompt(&mut receiver).await;

        assert!(manager.close(&info.id));
        let frame = collect_until(&mut receiver, Duration::from_secs(30), |frame| {
            matches!(frame, TerminalServerFrame::TerminalExited { .. })
        })
        .await;
        assert!(matches!(frame, TerminalServerFrame::TerminalExited { .. }));

        let mut attempts = 0;
        while manager.get(&info.id).is_some() && attempts < 100 {
            attempts += 1;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(manager.get(&info.id).is_none(), "session was removed");
        assert!(!manager.close(&info.id), "second close reports missing");
    }
}
