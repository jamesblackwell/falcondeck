//! Keyword search across the user messages harnesses leave on disk.
//!
//! Thread transcripts are not persisted by the daemon — they are hydrated from
//! provider session files on demand — so searching message content means going
//! back to those files. Reading them per query is hopeless (~9 GB of JSONL
//! here), and a full-text index is a project of its own. What actually answers
//! "which thread was the one about X" is much smaller: the first few user
//! messages (what the thread was started to do) and the last few (what it is
//! doing now). Both live at the two ends of the file, so each session costs one
//! head read and one tail read, and the resulting index is a couple of hundred
//! bytes per thread.
//!
//! The index is keyed by provider session id, which is what `ThreadSummary`
//! carries, so nothing here needs to know how the daemon models threads.

use std::{
    collections::HashMap,
    env,
    fs::File,
    io::{BufRead, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use falcondeck_core::{ThreadMessageMatch, ThreadMessagePosition};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Ceiling on bytes read forward while looking for the opening messages.
const HEAD_BUDGET_BYTES: u64 = 4 * 1024 * 1024;
/// First tail window; doubled up to `TAIL_BUDGET_BYTES` while it comes back empty.
const TAIL_BYTES: u64 = 384 * 1024;
/// Ceiling on bytes read backward while looking for the recent messages.
const TAIL_BUDGET_BYTES: u64 = 6 * 1024 * 1024;
/// Files past this size are skipped rather than seeked around in.
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// User messages kept from each end of a thread.
const MESSAGES_PER_END: usize = 3;
/// Characters kept per indexed message.
const MAX_MESSAGE_CHARS: usize = 400;
/// Characters returned around a keyword hit.
const SNIPPET_CHARS: usize = 180;
/// Hard cap on matches returned regardless of the caller's limit.
pub(crate) const MAX_MATCHES: usize = 40;

/// Indexed message excerpts for one provider session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SessionExcerpt {
    /// Absolute path the excerpt came from, for incremental rescans.
    pub path: PathBuf,
    /// Modification time in milliseconds since the epoch.
    pub modified_ms: u64,
    /// File size in bytes; paired with `modified_ms` to detect edits.
    pub size: u64,
    /// First user messages in the session, oldest first.
    pub opening: Vec<String>,
    /// Last user messages in the session, oldest first.
    pub recent: Vec<String>,
}

impl SessionExcerpt {
    fn is_current(&self, modified_ms: u64, size: u64) -> bool {
        self.modified_ms == modified_ms && self.size == size
    }
}

/// Session excerpts keyed by provider session id.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ThreadSearchIndex {
    /// Excerpts by native session id, which is the join key to threads.
    pub sessions: HashMap<String, SessionExcerpt>,
}

/// A thread the caller wants searched, reduced to what matching needs.
#[derive(Debug, Clone)]
pub(crate) struct SearchableThread {
    pub thread_id: String,
    pub workspace_id: String,
    pub session_id: String,
}

/// Session roots scanned for transcripts, newest-writing providers first.
fn session_roots() -> Vec<PathBuf> {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    vec![
        home.join(".claude").join("projects"),
        home.join(".codex").join("sessions"),
        // Codex moves finished sessions here; the threads still exist.
        home.join(".codex").join("archived_sessions"),
        home.join(".grok").join("sessions"),
    ]
}

pub(crate) fn index_path(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("thread-search-index.json")
}

/// Walks the session roots and returns every `.jsonl` transcript, bounded in
/// depth so a stray symlink cannot turn this into a filesystem crawl.
fn collect_session_files(root: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_session_files(&path, depth + 1, files);
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|ext| ext == "jsonl")
            // Grok keeps several JSONL files per session; only the transcript
            // carries messages, and the others would collide on session id.
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| !GROK_IGNORED_FILES.contains(&name))
        {
            files.push(path);
        }
    }
}

fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Rebuilds the index, reusing entries whose file is unchanged. Blocking: call
/// it from a blocking task, never from the async runtime's threads.
pub(crate) fn rescan(previous: &ThreadSearchIndex) -> ThreadSearchIndex {
    rescan_roots(&session_roots(), previous)
}

/// Same scan against explicit roots, so tests never depend on a real home.
pub(crate) fn rescan_roots(roots: &[PathBuf], previous: &ThreadSearchIndex) -> ThreadSearchIndex {
    let mut files = Vec::new();
    for root in roots {
        collect_session_files(root, 0, &mut files);
    }

    let mut sessions = HashMap::with_capacity(files.len());
    for path in files {
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        let size = metadata.len();
        if size == 0 || size > MAX_FILE_BYTES {
            continue;
        }
        let modified = modified_ms(&metadata);

        let Some(session_id) = session_id_for(&path) else {
            continue;
        };
        if let Some(existing) = previous.sessions.get(&session_id)
            && existing.path == path
            && existing.is_current(modified, size)
        {
            sessions.insert(session_id, existing.clone());
            continue;
        }

        if let Some(excerpt) = excerpt_from_file(&path, size, modified) {
            sessions.insert(session_id, excerpt);
        }
    }
    ThreadSearchIndex { sessions }
}

/// Claude names its files after the session id; Codex embeds it in a
/// `rollout-<timestamp>-<uuid>.jsonl` name. Both are cheaper than opening the
/// file, and both are confirmed against the transcript when it is read.
fn session_id_for(path: &Path) -> Option<String> {
    let stem = path.file_stem().and_then(|value| value.to_str())?;
    // Grok stores one directory per session: <workspace>/<session id>/chat_history.jsonl.
    if stem == "chat_history" {
        return path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .map(str::to_string);
    }
    if let Some(rest) = stem.strip_prefix("rollout-") {
        // rollout-2026-08-18T10-55-59-<uuid>: the uuid is the last 5 segments.
        let parts = rest.split('-').collect::<Vec<_>>();
        if parts.len() >= 5 {
            return Some(parts[parts.len() - 5..].join("-"));
        }
        return None;
    }
    Some(stem.to_string())
}

fn excerpt_from_file(path: &Path, size: u64, modified_ms: u64) -> Option<SessionExcerpt> {
    let mut file = File::open(path).ok()?;
    let opening = read_opening(&mut file, size);
    let recent = read_recent(&mut file, size);
    let recent = if recent.is_empty() {
        last_messages(&opening)
    } else {
        recent
    };

    if opening.is_empty() && recent.is_empty() {
        return None;
    }

    Some(SessionExcerpt {
        path: path.to_path_buf(),
        modified_ms,
        size,
        opening: opening.into_iter().take(MESSAGES_PER_END).collect(),
        recent,
    })
}

/// Reads forward until enough opening messages are found. Line-oriented rather
/// than a fixed byte window: transcripts routinely carry single lines larger
/// than any sane window (pasted context, inlined images), and a window that
/// lands mid-line yields nothing at all.
fn read_opening(file: &mut File, size: u64) -> Vec<String> {
    if file.seek(SeekFrom::Start(0)).is_err() {
        return Vec::new();
    }
    let budget = HEAD_BUDGET_BYTES.min(size);
    let reader = std::io::BufReader::new(file.take(budget));
    let mut messages = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if let Some(text) = user_message_text_from_line(&line, messages.last()) {
            messages.push(text);
            if messages.len() >= MESSAGES_PER_END {
                break;
            }
        }
    }
    messages
}

/// Reads backward from EOF, doubling the window until user messages appear. A
/// single agentic turn can bury the last prompt under megabytes of tool output,
/// so a fixed tail is empty exactly on the busiest threads.
fn read_recent(file: &mut File, size: u64) -> Vec<String> {
    let mut window = TAIL_BYTES;
    loop {
        let start = size.saturating_sub(window);
        if file.seek(SeekFrom::Start(start)).is_err() {
            return Vec::new();
        }
        let mut buffer = Vec::new();
        if file.take(window).read_to_end(&mut buffer).is_err() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&buffer);
        // Seeking into the file almost always lands mid-line; drop that piece.
        let messages = user_messages(&text, true, start > 0);
        if !messages.is_empty() || start == 0 || window >= TAIL_BUDGET_BYTES {
            return last_messages(&messages);
        }
        window = window.saturating_mul(2);
    }
}

fn last_messages(messages: &[String]) -> Vec<String> {
    let start = messages.len().saturating_sub(MESSAGES_PER_END);
    messages[start..].to_vec()
}

/// Extracts user-authored message text from a slice of JSONL.
///
/// `complete_tail` marks whether the slice ends on a line boundary, and
/// `skip_first_line` drops a leading fragment produced by seeking into a file.
fn user_message_text_from_line(line: &str, previous: Option<&String>) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || !line.starts_with('{') {
        return None;
    }
    let value = serde_json::from_str::<Value>(line).ok()?;
    let text = user_message_text(&value)?;
    // One turn can be recorded twice (event plus response item); the copies
    // land next to each other, so comparing neighbours is enough.
    if previous.is_some_and(|last| {
        last == &text || last.starts_with(&text) || text.starts_with(last.as_str())
    }) {
        return None;
    }
    Some(text)
}

fn user_messages(text: &str, complete_tail: bool, skip_first_line: bool) -> Vec<String> {
    let mut lines = text.lines().collect::<Vec<_>>();
    if !complete_tail {
        lines.pop();
    }
    if skip_first_line && !lines.is_empty() {
        lines.remove(0);
    }

    let mut messages: Vec<String> = Vec::new();
    for line in lines {
        if let Some(text) = user_message_text_from_line(line, messages.last()) {
            messages.push(text);
        }
    }
    messages
}

/// Pulls the operator's own words out of one transcript line, or `None` when
/// the line is anything else: assistant output, tool results, or the context
/// blocks harnesses inject as if the user had typed them.
fn user_message_text(value: &Value) -> Option<String> {
    let kind = value.get("type").and_then(Value::as_str)?;
    match kind {
        // Claude Code and Grok transcripts share this envelope.
        "user" => {
            if value.get("isSidechain").and_then(Value::as_bool) == Some(true)
                || value.get("isMeta").and_then(Value::as_bool) == Some(true)
            {
                return None;
            }
            // Claude nests the message; Grok puts content at the top level.
            let content = value
                .get("message")
                .and_then(|message| message.get("content"))
                .or_else(|| value.get("content"))?;
            if let Some(text) = content.as_str() {
                return clean_message(text);
            }
            let mut parts = Vec::new();
            for block in content.as_array()? {
                // Tool results ride the same "user" envelope; only real typed
                // text blocks belong in a search index.
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    return None;
                }
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text);
                }
            }
            clean_message(&parts.join("\n"))
        }
        // Codex rollouts record the operator's turn as an event; sessions
        // started elsewhere (resumes, remote clients) sometimes only carry the
        // response item, so both are read and duplicates dropped later.
        "event_msg" => {
            let payload = value.get("payload")?;
            if payload.get("type").and_then(Value::as_str) != Some("user_message") {
                return None;
            }
            clean_message(payload.get("message").and_then(Value::as_str)?)
        }
        "response_item" => {
            let payload = value.get("payload")?;
            if payload.get("type").and_then(Value::as_str) != Some("message")
                || payload.get("role").and_then(Value::as_str) != Some("user")
            {
                return None;
            }
            let mut parts = Vec::new();
            for block in payload.get("content")?.as_array()? {
                if block.get("type").and_then(Value::as_str) != Some("input_text") {
                    continue;
                }
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text);
                }
            }
            clean_message(&parts.join("\n"))
        }
        _ => None,
    }
}

/// Grok session directories hold sibling logs that are not transcripts.
const GROK_IGNORED_FILES: [&str; 3] = ["events.jsonl", "updates.jsonl", "rewind_points.jsonl"];

fn clean_message(text: &str) -> Option<String> {
    let text = super::harness_user_text::visible_user_prompt(text)?;
    let text = crate::codex::sanitize_codex_preview(&text)?;
    let mut cleaned = String::with_capacity(text.len().min(MAX_MESSAGE_CHARS * 2));
    let mut last_was_space = false;
    for character in text.chars() {
        if character.is_whitespace() {
            if !last_was_space && !cleaned.is_empty() {
                cleaned.push(' ');
            }
            last_was_space = true;
        } else {
            cleaned.push(character);
            last_was_space = false;
        }
    }
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return None;
    }
    Some(truncate_chars(cleaned, MAX_MESSAGE_CHARS))
}

fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out = text.chars().take(limit).collect::<String>();
    out.push('…');
    out
}

/// Splits a raw query into lowercase keywords. Every keyword must appear for a
/// message to match, which is what makes a two-word query useful at this scale.
pub(crate) fn query_tokens(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|token| token.trim().to_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

/// Ranks indexed threads against a query. Matches inside opening messages rank
/// above trailing ones: "the thread where I asked for X" is the common case.
pub(crate) fn search(
    index: &ThreadSearchIndex,
    threads: &[SearchableThread],
    query: &str,
    limit: usize,
) -> Vec<ThreadMessageMatch> {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        return Vec::new();
    }

    let mut matches = Vec::new();
    for thread in threads {
        let Some(excerpt) = index.sessions.get(&thread.session_id) else {
            continue;
        };
        let hit = best_message(&excerpt.opening, &tokens)
            .map(|(text, at)| (ThreadMessagePosition::Opening, text, at))
            .or_else(|| {
                best_message(&excerpt.recent, &tokens)
                    .map(|(text, at)| (ThreadMessagePosition::Recent, text, at))
            });
        let Some((position, text, at)) = hit else {
            continue;
        };
        matches.push((
            position,
            ThreadMessageMatch {
                thread_id: thread.thread_id.clone(),
                workspace_id: thread.workspace_id.clone(),
                snippet: snippet_around(text, at),
                position,
            },
        ));
    }

    // Opening hits first; the caller re-orders the rest by thread recency,
    // which it knows and this index deliberately does not.
    matches.sort_by_key(|(position, _)| match position {
        ThreadMessagePosition::Opening => 0,
        ThreadMessagePosition::Recent => 1,
    });
    matches
        .into_iter()
        .map(|(_, entry)| entry)
        .take(limit.min(MAX_MATCHES))
        .collect()
}

/// Finds the first message containing every token, with the offset of the
/// earliest token hit so the snippet can be centred on it.
fn best_message<'a>(messages: &'a [String], tokens: &[String]) -> Option<(&'a str, usize)> {
    for message in messages {
        let haystack = message.to_lowercase();
        let mut earliest = usize::MAX;
        let mut all_present = true;
        for token in tokens {
            match haystack.find(token.as_str()) {
                Some(at) => earliest = earliest.min(at),
                None => {
                    all_present = false;
                    break;
                }
            }
        }
        if all_present {
            return Some((
                message.as_str(),
                if earliest == usize::MAX { 0 } else { earliest },
            ));
        }
    }
    None
}

/// Cuts a readable window around a byte offset, snapped to char boundaries.
fn snippet_around(text: &str, at: usize) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() <= SNIPPET_CHARS {
        return text.to_string();
    }
    // `at` indexes bytes of the lowercased copy, which has the same char
    // boundaries for every case mapping we care about here.
    let hit_char = text
        .char_indices()
        .position(|(byte, _)| byte >= at)
        .unwrap_or(0);
    let start = hit_char.saturating_sub(SNIPPET_CHARS / 3);
    let end = (start + SNIPPET_CHARS).min(chars.len());
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.extend(&chars[start..end]);
    if end < chars.len() {
        snippet.push('…');
    }
    snippet
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_line(text: &str) -> String {
        serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        })
        .to_string()
    }

    #[test]
    fn extracts_typed_text_and_skips_tool_results() {
        let transcript = [
            claude_line("Fix the dictation paste path"),
            serde_json::json!({
                "type": "user",
                "message": { "content": [{ "type": "tool_result", "content": "ok" }] },
            })
            .to_string(),
            serde_json::json!({ "type": "assistant", "message": { "content": "sure" } })
                .to_string(),
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "user_message", "message": "and then ship it" },
            })
            .to_string(),
            claude_line("<system-reminder>ignore me</system-reminder>"),
            serde_json::json!({
                "type": "user",
                "isSidechain": true,
                "message": { "content": [{ "type": "text", "text": "subagent prompt" }] },
            })
            .to_string(),
        ]
        .join("\n");

        let messages = user_messages(&transcript, true, false);
        assert_eq!(
            messages,
            vec![
                "Fix the dictation paste path".to_string(),
                "and then ship it".to_string()
            ]
        );
    }

    #[test]
    fn drops_partial_lines_at_each_boundary() {
        let transcript = format!(
            "{}\n{}\n{{\"type\":\"user\",\"message\"",
            claude_line("first prompt"),
            claude_line("second prompt"),
        );
        // Head read: the trailing fragment is not a complete line.
        assert_eq!(
            user_messages(&transcript, false, false),
            vec!["first prompt".to_string(), "second prompt".to_string()]
        );
        // Tail read: the leading fragment is dropped instead.
        assert_eq!(
            user_messages(&transcript, true, true),
            vec!["second prompt".to_string()]
        );
    }

    #[test]
    fn reads_both_ends_of_a_session_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session-1.jsonl");
        let mut lines = vec![claude_line("index the first prompt")];
        // Enough filler to push the ends apart without tripping the size caps.
        for index in 0..200 {
            lines.push(
                serde_json::json!({
                    "type": "assistant",
                    "message": { "content": format!("filler {index} {}", "x".repeat(400)) },
                })
                .to_string(),
            );
        }
        lines.push(claude_line("and the last prompt"));
        std::fs::write(&path, lines.join("\n")).expect("write");

        let metadata = std::fs::metadata(&path).expect("metadata");
        let excerpt =
            excerpt_from_file(&path, metadata.len(), modified_ms(&metadata)).expect("excerpt");
        assert_eq!(
            excerpt.opening.first().map(String::as_str),
            Some("index the first prompt")
        );
        assert_eq!(
            excerpt.recent.last().map(String::as_str),
            Some("and the last prompt")
        );
    }

    #[test]
    fn matches_every_token_and_prefers_opening_messages() {
        let mut sessions = HashMap::new();
        sessions.insert(
            "session-a".to_string(),
            SessionExcerpt {
                path: PathBuf::from("/tmp/a.jsonl"),
                modified_ms: 1,
                size: 1,
                opening: vec!["make the waveform render full width".to_string()],
                recent: vec!["ship it".to_string()],
            },
        );
        sessions.insert(
            "session-b".to_string(),
            SessionExcerpt {
                path: PathBuf::from("/tmp/b.jsonl"),
                modified_ms: 1,
                size: 1,
                opening: vec!["unrelated opening".to_string()],
                recent: vec!["the waveform is still clipped".to_string()],
            },
        );
        let index = ThreadSearchIndex { sessions };
        let threads = vec![
            SearchableThread {
                thread_id: "thread-b".to_string(),
                workspace_id: "workspace-1".to_string(),
                session_id: "session-b".to_string(),
            },
            SearchableThread {
                thread_id: "thread-a".to_string(),
                workspace_id: "workspace-1".to_string(),
                session_id: "session-a".to_string(),
            },
        ];

        let matches = search(&index, &threads, "waveform", 10);
        assert_eq!(
            matches
                .iter()
                .map(|entry| entry.thread_id.as_str())
                .collect::<Vec<_>>(),
            vec!["thread-a", "thread-b"]
        );
        assert_eq!(matches[0].position, ThreadMessagePosition::Opening);
        assert_eq!(matches[1].position, ThreadMessagePosition::Recent);

        // Every token must be present, so a second word narrows the result.
        let narrowed = search(&index, &threads, "waveform clipped", 10);
        assert_eq!(narrowed.len(), 1);
        assert_eq!(narrowed[0].thread_id, "thread-b");

        assert!(search(&index, &threads, "   ", 10).is_empty());
    }

    #[test]
    fn indexes_the_typed_request_from_a_codex_attachment_turn() {
        let line = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": "# Files mentioned by the user:\n\n## codex-clipboard-5c77f1c0.png: /tmp/clip.png\n\n## My request for Codex:\nwhat is causing this prompt to be restricted?"
            }
        })
        .to_string();
        let value = serde_json::from_str::<Value>(&line).expect("json");
        assert_eq!(
            user_message_text(&value).as_deref(),
            Some("what is causing this prompt to be restricted?")
        );
    }

    #[test]
    fn takes_grok_prompts_out_of_their_context_wrapper() {
        let line = serde_json::json!({
            "type": "user",
            "content": [{
                "type": "text",
                "text": "<user_info>OS: macos</user_info>\n<user_query>\nwhy does steering fail?\n</user_query>\n<system-reminder>be nice</system-reminder>",
            }],
        })
        .to_string();
        let value = serde_json::from_str::<Value>(&line).expect("json");
        assert_eq!(
            user_message_text(&value).as_deref(),
            Some("why does steering fail?")
        );
    }

    #[test]
    fn scans_a_session_tree_and_reuses_unchanged_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let claude = dir.path().join("projects").join("-Users-james-app");
        std::fs::create_dir_all(&claude).expect("mkdir");
        std::fs::write(
            claude.join("session-a.jsonl"),
            claude_line("index this prompt"),
        )
        .expect("write");
        // A Grok session: id comes from the directory, and its sibling logs
        // must not be mistaken for transcripts.
        let grok = dir.path().join("sessions").join("%2Fapp").join("session-b");
        std::fs::create_dir_all(&grok).expect("mkdir");
        std::fs::write(
            grok.join("chat_history.jsonl"),
            serde_json::json!({
                "type": "user",
                "content": [{ "type": "text", "text": "<user_query>grok prompt</user_query>" }],
            })
            .to_string(),
        )
        .expect("write");
        std::fs::write(grok.join("events.jsonl"), claude_line("not a transcript")).expect("write");

        let roots = vec![dir.path().to_path_buf()];
        let index = rescan_roots(&roots, &ThreadSearchIndex::default());
        assert_eq!(index.sessions.len(), 2);
        assert_eq!(
            index.sessions["session-a"].opening,
            vec!["index this prompt".to_string()]
        );
        assert_eq!(
            index.sessions["session-b"].opening,
            vec!["grok prompt".to_string()]
        );

        // A rescan reuses entries whose file has not changed, and picks up new
        // content when it has.
        std::fs::write(
            claude.join("session-a.jsonl"),
            format!(
                "{}\n{}",
                claude_line("index this prompt"),
                claude_line("second prompt")
            ),
        )
        .expect("rewrite");
        let rescanned = rescan_roots(&roots, &index);
        assert_eq!(rescanned.sessions["session-b"], index.sessions["session-b"]);
        assert_eq!(
            rescanned.sessions["session-a"].opening,
            vec!["index this prompt".to_string(), "second prompt".to_string()]
        );

        let threads = vec![SearchableThread {
            thread_id: "thread-a".to_string(),
            workspace_id: "workspace-1".to_string(),
            session_id: "session-a".to_string(),
        }];
        let matches = search(&rescanned, &threads, "second prompt", 5);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].snippet, "second prompt");
    }

    #[test]
    fn recovers_session_ids_from_both_naming_schemes() {
        assert_eq!(
            session_id_for(Path::new("/x/42b2ede6-cd16-4fc7-95ae-155d320ae3ef.jsonl")),
            Some("42b2ede6-cd16-4fc7-95ae-155d320ae3ef".to_string())
        );
        assert_eq!(
            session_id_for(Path::new(
                "/x/rollout-2026-08-18T10-55-59-01a0144c-9a4a-73e0-b239-9e1c83b91564.jsonl"
            )),
            Some("01a0144c-9a4a-73e0-b239-9e1c83b91564".to_string())
        );
    }

    #[test]
    fn snippet_centres_on_the_hit() {
        let text = format!("{} needle {}", "a".repeat(400), "b".repeat(400));
        let at = text.to_lowercase().find("needle").expect("hit");
        let snippet = snippet_around(&text, at);
        assert!(snippet.contains("needle"));
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert!(snippet.chars().count() <= SNIPPET_CHARS + 2);
    }
}
