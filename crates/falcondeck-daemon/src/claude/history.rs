//! Lightweight sidebar discovery over bounded native transcript windows.
//! Exact conversation restoration stays in the native session parser.
//! Titles/previews buried between those windows are enriched on first open;
//! sampled metadata never establishes ownership for exact history hydration.

use std::io::{Read, Seek, SeekFrom};

use serde::de::{Deserialize, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

use super::*;

const SUMMARY_HEAD_BYTES: u64 = 1024 * 1024;
const SUMMARY_TAIL_BYTES: u64 = 256 * 1024;

#[derive(Clone)]
pub struct DiscoveredClaudeThread {
    pub summary: ThreadSummary,
    pub title_is_provider_preview: bool,
    pub history_source: PathBuf,
    pub history_version: (u64, Option<std::time::SystemTime>),
}

pub fn discover_threads(workspace_path: &str) -> Vec<DiscoveredClaudeThread> {
    let root = claude_projects_root();
    if let Some(cache) = SESSION_FILE_CACHE.get()
        && let Ok(mut cache) = cache.lock()
    {
        cache.prune_missing_files();
    }
    discover_threads_in(&root, workspace_path)
}

/// An explicit native root keeps tests and alternate hosts independent of
/// process-global environment variables.
pub fn discover_threads_in(root: &Path, workspace_path: &str) -> Vec<DiscoveredClaudeThread> {
    let mut files = Vec::new();
    let workspace_root = root.join(claude_project_dir_name(workspace_path));
    if workspace_root.is_dir() {
        collect_workspace_session_files(&workspace_root, &mut files);
    } else {
        collect_session_files(root, &mut files);
    }
    let mut threads = HashMap::<String, DiscoveredClaudeThread>::new();
    for path in files {
        let Some(thread) = discover_thread_from_file(&path, workspace_path) else {
            continue;
        };
        let id = thread.summary.id.clone();
        if threads
            .get(&id)
            .is_none_or(|existing| thread.summary.updated_at > existing.summary.updated_at)
        {
            threads.insert(id, thread);
        }
    }
    let mut threads = threads.into_values().collect::<Vec<_>>();
    threads.sort_by_key(|thread| std::cmp::Reverse(thread.summary.updated_at));
    threads
}

pub fn hydrate_native_thread(
    path: &Path,
    workspace_path: &str,
    expected_session_id: &str,
) -> Option<HydratedClaudeThread> {
    let thread = hydrate_thread_from_file(path, workspace_path)?;
    (thread.summary.native_session_id.as_deref() == Some(expected_session_id)).then_some(thread)
}

pub fn native_session_source(workspace_path: &str, session_id: &str) -> PathBuf {
    let root = claude_projects_root();
    let workspace_root = root.join(claude_project_dir_name(workspace_path));
    if Uuid::parse_str(session_id).is_err() {
        return workspace_root.join("invalid-native-session.jsonl");
    }
    let expected = workspace_root.join(format!("{session_id}.jsonl"));
    if expected.is_file() {
        return expected;
    }
    let json = workspace_root.join(format!("{session_id}.json"));
    if json.is_file() {
        return json;
    }
    expected
}

fn discover_thread_from_file(path: &Path, workspace_path: &str) -> Option<DiscoveredClaudeThread> {
    let mut file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    let modified = metadata.modified().ok();
    let file_updated_at = modified.map(DateTime::<Utc>::from);
    let windows = summary_windows(&mut file, metadata.len()).ok()?;
    let mut summary = SummaryMetadata::default();
    for window in &windows {
        summary.visit_window(&window.bytes, window.skip_first_line, window.complete_end);
    }
    summary.finish_messages();
    // Never infer cwd from Claude's sanitized project directory: '-' and '/'
    // collide in that encoding, and a fallback scan visits other workspaces.
    if summary.cwd.as_deref() != Some(workspace_path) {
        return None;
    }
    let session_id = summary.session_id.or_else(|| {
        path.file_stem()
            .and_then(|id| id.to_str())
            .map(str::to_owned)
    })?;
    Uuid::parse_str(&session_id).ok()?;
    let provider_title = summary
        .custom_title
        .or(summary.ai_title)
        .or(summary.legacy_title);
    let title_is_provider_preview = provider_title.is_none();
    let title = provider_title
        .or(summary.first_prompt_title)
        .unwrap_or_else(|| "Claude thread".to_string());
    Some(DiscoveredClaudeThread {
        summary: claude_thread_summary(
            session_id,
            title,
            summary
                .updated_at
                .or(file_updated_at)
                .unwrap_or_else(Utc::now),
            summary.last_message_preview,
        ),
        title_is_provider_preview,
        history_source: path.to_path_buf(),
        history_version: (metadata.len(), modified),
    })
}

struct SummaryWindow {
    bytes: Vec<u8>,
    skip_first_line: bool,
    complete_end: bool,
}

fn summary_windows(
    reader: &mut (impl Read + Seek),
    size: u64,
) -> std::io::Result<Vec<SummaryWindow>> {
    if size <= SUMMARY_HEAD_BYTES + SUMMARY_TAIL_BYTES {
        reader.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        reader.take(size).read_to_end(&mut bytes)?;
        return Ok(vec![SummaryWindow {
            bytes,
            skip_first_line: false,
            complete_end: true,
        }]);
    }
    reader.seek(SeekFrom::Start(0))?;
    let mut head = Vec::new();
    reader.take(SUMMARY_HEAD_BYTES).read_to_end(&mut head)?;
    let tail_start = size - SUMMARY_TAIL_BYTES;
    // The preceding byte distinguishes an exact line boundary from a partial
    // record without searching backward through an unbounded tool/image line.
    reader.seek(SeekFrom::Start(tail_start - 1))?;
    let mut tail = Vec::new();
    reader.take(SUMMARY_TAIL_BYTES + 1).read_to_end(&mut tail)?;
    let skip_first_line = tail.first() != Some(&b'\n');
    if !tail.is_empty() {
        tail.remove(0);
    }
    Ok(vec![
        SummaryWindow {
            bytes: head,
            skip_first_line: false,
            complete_end: false,
        },
        SummaryWindow {
            bytes: tail,
            skip_first_line,
            complete_end: true,
        },
    ])
}

#[derive(Default)]
struct SummaryMetadata<'a> {
    session_id: Option<String>,
    cwd: Option<String>,
    legacy_title: Option<String>,
    custom_title: Option<String>,
    ai_title: Option<String>,
    first_prompt_title: Option<String>,
    last_message_preview: Option<String>,
    updated_at: Option<DateTime<Utc>>,
    first_users: Vec<&'a [u8]>,
    messages: Vec<PreviewMessage<'a>>,
    assistant_by_id: HashMap<String, usize>,
}

struct PreviewMessage<'a> {
    user: bool,
    lines: Vec<&'a [u8]>,
}

impl<'a> SummaryMetadata<'a> {
    fn visit_window(&mut self, bytes: &'a [u8], skip_first: bool, complete_end: bool) {
        let mut lines = bytes.split(|byte| *byte == b'\n').peekable();
        if skip_first {
            if let Some(line) = lines.next()
                && let Some(header) = metadata_suffix(line)
            {
                self.visit(&header.value);
            }
        }
        while let Some(line) = lines.next() {
            if lines.peek().is_none() && !complete_end {
                if let Some(header) = metadata_prefix(line) {
                    self.visit(&header.value);
                }
                break;
            }
            let Ok(header) = serde_json::from_slice::<RecordHeader>(line) else {
                continue;
            };
            self.visit(&header.value);
            if header.value.get("isMeta").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let user = header.value.get("type").and_then(Value::as_str) == Some("user");
            if user {
                if (!header.message.has_text && !header.has_top_text)
                    || header.message.has_tool_result
                {
                    continue;
                }
                self.first_users.push(line);
            } else if !header.message.has_text && !header.has_top_text && !header.is_delta {
                continue;
            }
            let id = header
                .message
                .id
                .or_else(|| extract_string(&header.value, &["uuid", "id"]));
            if !user
                && let Some(index) = id
                    .as_ref()
                    .and_then(|id| self.assistant_by_id.get(id))
                    .copied()
            {
                self.messages[index].lines.push(line);
            } else {
                if !user && let Some(id) = id {
                    self.assistant_by_id.insert(id, self.messages.len());
                }
                self.messages.push(PreviewMessage {
                    user,
                    lines: vec![line],
                });
            }
        }
    }

    fn visit(&mut self, value: &Value) {
        self.session_id = self
            .session_id
            .take()
            .or_else(|| extract_string(value, &["session_id", "sessionId", "id"]));
        self.cwd = self
            .cwd
            .take()
            .or_else(|| extract_string(value, &["cwd", "working_directory", "workingDirectory"]));
        self.legacy_title = self
            .legacy_title
            .take()
            .or_else(|| extract_string(value, &["title", "name"]));
        match value.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(title) = extract_string(value, &["customTitle", "custom_title"]) {
                    self.custom_title = Some(title);
                }
            }
            Some("ai-title") => {
                if let Some(title) = extract_string(value, &["aiTitle", "ai_title"]) {
                    self.ai_title = Some(title);
                }
            }
            _ => {}
        }
        self.updated_at = extract_datetime(
            value,
            &[
                "updated_at",
                "updatedAt",
                "timestamp",
                "created_at",
                "createdAt",
            ],
        )
        .or(self.updated_at);
    }

    fn finish_messages(&mut self) {
        self.first_prompt_title = self.first_users.iter().find_map(|line| {
            let value = decode_message(line)?;
            provisional_title_from_text(&extract_claude_user_message_text(&value)?)
        });
        for message in self.messages.iter().rev() {
            let mut text = String::new();
            for line in &message.lines {
                let Some(value) = decode_message(line) else {
                    continue;
                };
                if message.user {
                    if let Some(user_text) = extract_claude_user_message_text(&value) {
                        text = user_text;
                    }
                } else if let Some(chunk) = extract_claude_text_chunk(&value) {
                    let incoming = chunk.text.chars().take(81).collect::<String>();
                    text = if chunk.is_delta {
                        append_claude_text_delta(&text, &incoming)
                    } else {
                        merge_claude_assistant_text(&text, &incoming)
                    };
                }
                text = text.chars().take(81).collect();
            }
            if !text.trim().is_empty() {
                self.last_message_preview = Some(truncate_preview(&text));
                break;
            }
        }
    }
}

fn decode_message(line: &[u8]) -> Option<Value> {
    #[cfg(test)]
    MESSAGE_DECODES.with(|count| count.set(count.get() + 1));
    serde_json::from_slice(line).ok()
}

#[cfg(test)]
thread_local! {
    static MESSAGE_DECODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Default)]
struct RecordHeader {
    value: Value,
    message: MessageHint,
    has_top_text: bool,
    is_delta: bool,
}

fn metadata_key(key: &str) -> bool {
    matches!(
        key,
        "type"
            | "session_id"
            | "sessionId"
            | "id"
            | "uuid"
            | "cwd"
            | "working_directory"
            | "workingDirectory"
            | "title"
            | "name"
            | "customTitle"
            | "custom_title"
            | "aiTitle"
            | "ai_title"
            | "updated_at"
            | "updatedAt"
            | "timestamp"
            | "created_at"
            | "createdAt"
            | "isMeta"
            | "is_error"
    )
}

struct HeaderVisitor<'a>(&'a mut RecordHeader);

impl<'de> Visitor<'de> for HeaderVisitor<'_> {
    type Value = ();
    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a native Claude record")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        self.0.value = Value::Object(serde_json::Map::new());
        while let Some(key) = map.next_key::<String>()? {
            if metadata_key(&key) {
                let value = map.next_value::<Value>()?;
                self.0.value.as_object_mut().unwrap().insert(key, value);
            } else if key == "message" {
                self.0.message = map.next_value()?;
            } else {
                if matches!(key.as_str(), "text" | "completion" | "result") {
                    self.0.has_top_text = true;
                }
                if matches!(key.as_str(), "event" | "delta") {
                    self.0.is_delta |= map.next_value::<DeltaHint>()?.has_text();
                } else {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for RecordHeader {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut header = Self::default();
        deserializer.deserialize_map(HeaderVisitor(&mut header))?;
        Ok(header)
    }
}

#[derive(serde::Deserialize)]
struct DeltaHint {
    text: Option<IgnoredAny>,
    completion: Option<IgnoredAny>,
    delta: Option<Box<DeltaHint>>,
}

impl DeltaHint {
    fn has_text(&self) -> bool {
        self.text.is_some()
            || self.completion.is_some()
            || self.delta.as_ref().is_some_and(|delta| delta.has_text())
    }
}

#[derive(Default)]
struct MessageHint {
    id: Option<String>,
    has_text: bool,
    has_tool_result: bool,
}

impl<'de> Deserialize<'de> for MessageHint {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MessageVisitor;
        impl<'de> Visitor<'de> for MessageVisitor {
            type Value = MessageHint;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a Claude message")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut hint = MessageHint::default();
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "id" => hint.id = map.next_value::<Option<String>>()?,
                        "content" => {
                            let content = map.next_value::<ContentHint>()?;
                            hint.has_text = content.has_text;
                            hint.has_tool_result = content.has_tool_result;
                        }
                        "text" => {
                            hint.has_text = true;
                            map.next_value::<IgnoredAny>()?;
                        }
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(hint)
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(MessageHint::default())
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(MessageHint::default())
            }
        }
        deserializer.deserialize_any(MessageVisitor)
    }
}

#[derive(Default)]
struct ContentHint {
    has_text: bool,
    has_tool_result: bool,
}

impl<'de> Deserialize<'de> for ContentHint {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ContentVisitor;
        impl<'de> Visitor<'de> for ContentVisitor {
            type Value = ContentHint;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("Claude message content")
            }
            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Self::Value, E> {
                Ok(ContentHint {
                    has_text: !text.trim().is_empty(),
                    has_tool_result: false,
                })
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(ContentHint::default())
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                #[derive(serde::Deserialize)]
                struct Block {
                    #[serde(rename = "type")]
                    kind: Option<String>,
                }
                let mut hint = ContentHint::default();
                while let Some(block) = seq.next_element::<Block>()? {
                    hint.has_text |= block.kind.as_deref() == Some("text");
                    hint.has_tool_result |= block.kind.as_deref() == Some("tool_result");
                }
                Ok(hint)
            }
        }
        deserializer.deserialize_any(ContentVisitor)
    }
}

fn metadata_prefix(line: &[u8]) -> Option<RecordHeader> {
    let mut header = RecordHeader::default();
    let mut deserializer = serde_json::Deserializer::from_slice(line);
    match serde::de::Deserializer::deserialize_map(&mut deserializer, HeaderVisitor(&mut header)) {
        Ok(()) => Some(header),
        Err(error) if error.is_eof() => Some(header),
        Err(_) => None,
    }
}

fn metadata_suffix(line: &[u8]) -> Option<RecordHeader> {
    let mut attempts = 0;
    for (index, byte) in line.iter().enumerate() {
        if *byte != b'"' {
            continue;
        }
        let suffix = &line[index..];
        if ![
            b"\"cwd\"".as_slice(),
            b"\"working_directory\"",
            b"\"workingDirectory\"",
            b"\"sessionId\"",
            b"\"session_id\"",
        ]
        .iter()
        .any(|key| suffix.starts_with(key))
        {
            continue;
        }
        let previous = line[..index]
            .iter()
            .rev()
            .find(|byte| !byte.is_ascii_whitespace())
            .copied();
        if !matches!(previous, Some(b',' | b'{')) {
            continue;
        }
        attempts += 1;
        if attempts > 8 {
            return None;
        }
        let reader = std::io::Cursor::new(b"{").chain(std::io::Cursor::new(suffix));
        if let Ok(header) = serde_json::from_reader::<_, RecordHeader>(reader) {
            return Some(header);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    const SESSION: &str = "33333333-3333-4333-8333-333333333333";
    const CWD: &str = "/tmp/project";

    fn user(text: &str) -> Value {
        json!({"sessionId": SESSION, "cwd": CWD, "type": "user", "uuid": "user-1",
            "message": {"role": "user", "content": text}, "timestamp": "2026-10-06T09:00:00Z"})
    }
    fn assistant(id: &str, text: &str) -> Value {
        json!({"type": "assistant", "message": {"id": id, "role": "assistant",
            "content": [{"type": "text", "text": text}]}, "timestamp": "2026-10-06T09:00:01Z"})
    }
    fn fixture(entries: &[Value]) -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join(claude_project_dir_name(CWD));
        fs::create_dir(&workspace).unwrap();
        let path = workspace.join(format!("{SESSION}.jsonl"));
        let mut file = fs::File::create(&path).unwrap();
        for entry in entries {
            writeln!(file, "{entry}").unwrap();
        }
        (dir, path)
    }

    #[test]
    fn discovery_preserves_small_native_metadata_without_items() {
        let (dir, path) = fixture(&[
            user("Opening prompt"),
            json!({"type":"ai-title", "aiTitle":"First AI title"}),
            json!({"type":"custom-title", "customTitle":"First custom title"}),
            assistant("a1", "First answer"),
            json!({"type":"ai-title", "aiTitle":"Latest AI title"}),
            json!({"type":"custom-title", "customTitle":"Latest custom title"}),
            assistant("a2", "Latest answer"),
        ]);
        let discovered = discover_threads_in(dir.path(), CWD).remove(0);
        let hydrated = hydrate_native_thread(&path, CWD, SESSION).unwrap();
        assert_eq!(discovered.summary, hydrated.summary);
        assert_eq!(discovered.history_source, path);
        assert!(!discovered.title_is_provider_preview);
        assert_eq!(hydrated.items.len(), 3);
    }

    #[test]
    fn discovery_decodes_only_opening_and_latest_message_payloads() {
        let mut entries = vec![user("Opening prompt")];
        for index in 0..1024 {
            entries.push(assistant(&format!("a{index}"), &"answer ".repeat(250)));
        }
        let (dir, _) = fixture(&entries);
        MESSAGE_DECODES.with(|count| count.set(0));
        let threads = discover_threads_in(dir.path(), CWD);
        assert_eq!(threads.len(), 1);
        assert!(
            threads[0]
                .summary
                .last_message_preview
                .as_deref()
                .unwrap()
                .starts_with("answer")
        );
        assert!(MESSAGE_DECODES.with(std::cell::Cell::get) <= 2);
    }

    #[test]
    fn discovery_skips_large_middle_tool_payload_and_bounds_file_reads() {
        let (dir, path) = fixture(&[user("Opening prompt")]);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{{\"type\":\"user\",\"message\":{{\"content\":[{{\"type\":\"tool_result\",\"content\":\"").unwrap();
        let block = vec![b'x'; 1024 * 1024];
        for _ in 0..16 {
            file.write_all(&block).unwrap();
        }
        writeln!(file, "\"}}]}}}}").unwrap();
        writeln!(file, "{}", assistant("latest", "Latest useful answer")).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"custom-title", "customTitle":"Saved native title"})
        )
        .unwrap();
        drop(file);
        let mut counted = CountingReader {
            file: fs::File::open(&path).unwrap(),
            bytes_read: 0,
        };
        let size = counted.file.metadata().unwrap().len();
        summary_windows(&mut counted, size).unwrap();
        assert!(counted.bytes_read <= SUMMARY_HEAD_BYTES + SUMMARY_TAIL_BYTES + 1);
        MESSAGE_DECODES.with(|count| count.set(0));
        let discovered = discover_threads_in(dir.path(), CWD).remove(0);
        assert_eq!(discovered.summary.title, "Saved native title");
        assert_eq!(
            discovered.summary.last_message_preview.as_deref(),
            Some("Latest useful answer")
        );
        assert!(MESSAGE_DECODES.with(std::cell::Cell::get) <= 2);
    }

    #[test]
    fn giant_opening_message_recovers_native_ownership_from_top_level_suffix() {
        let (dir, path) = fixture(&[]);
        let mut file = fs::File::create(&path).unwrap();
        write!(
            file,
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\""
        )
        .unwrap();
        let block = vec![b'x'; 1024 * 1024];
        for _ in 0..16 {
            file.write_all(&block).unwrap();
        }
        writeln!(file, "\"}},\"cwd\":\"{CWD}\",\"sessionId\":\"{SESSION}\",\"timestamp\":\"2026-10-06T09:00:00Z\"}}").unwrap();
        writeln!(
            file,
            "{}",
            assistant("latest", "Answer after a giant prompt")
        )
        .unwrap();
        drop(file);
        let discovered = discover_threads_in(dir.path(), CWD).remove(0);
        assert_eq!(
            discovered.summary.native_session_id.as_deref(),
            Some(SESSION)
        );
        assert_eq!(
            discovered.summary.last_message_preview.as_deref(),
            Some("Answer after a giant prompt")
        );
    }

    #[test]
    fn ownership_is_not_inferred_from_directory_or_later_conflicting_cwd() {
        for entries in [
            vec![json!({"sessionId": SESSION, "type":"user", "message":{"content":"missing cwd"}})],
            vec![
                json!({"sessionId": SESSION, "cwd":"/other", "type":"user", "message":{"content":"foreign"}}),
                user("Later changed cwd"),
            ],
            vec![
                json!({"sessionId":"not-a-uuid", "cwd":CWD, "type":"user", "message":{"content":"bad id"}}),
            ],
        ] {
            let (dir, _) = fixture(&entries);
            assert!(discover_threads_in(dir.path(), CWD).is_empty());
        }
        assert!(metadata_suffix(br#"ignored", "payload":{"cwd":"/tmp/project","sessionId":"33333333-3333-4333-8333-333333333333"}}"#).is_none());
        assert!(metadata_prefix(br#"{"cwd":"/tmp/project",broken"#).is_none());
    }

    #[test]
    fn exact_hydration_verifies_expected_source_id_and_workspace() {
        let (dir, path) = fixture(&[user("Opening prompt"), assistant("a1", "Answer")]);
        assert!(hydrate_native_thread(&path, CWD, SESSION).is_some());
        assert!(hydrate_native_thread(&path, "/other", SESSION).is_none());
        assert!(
            hydrate_native_thread(&path, CWD, "44444444-4444-4444-8444-444444444444").is_none()
        );
        fs::remove_file(&path).unwrap();
        assert!(hydrate_native_thread(&path, CWD, SESSION).is_none());
        drop(dir);
    }

    #[test]
    fn previews_merge_deltas_and_skip_internal_and_tool_result_records() {
        let (dir, path) = fixture(&[
            user("Opening prompt"),
            assistant("a1", "Hello"),
            json!({"type":"assistant", "uuid":"a1", "delta":{"text":" world"}, "timestamp":"2026-10-06T09:00:02Z"}),
            json!({"type":"user", "message":{"content":[{"type":"tool_result","content":"Private tool output"}]}}),
            json!({"type":"user", "isMeta":true, "message":{"content":"Internal envelope"}}),
        ]);
        let discovered = discover_threads_in(dir.path(), CWD).remove(0);
        assert_eq!(
            discovered.summary.last_message_preview.as_deref(),
            Some("Hello world")
        );
        assert_eq!(
            discovered.summary.last_message_preview,
            hydrate_native_thread(&path, CWD, SESSION)
                .unwrap()
                .summary
                .last_message_preview
        );
    }

    #[test]
    fn full_snapshot_does_not_replay_overlapping_windows_or_partial_eof() {
        let mut reader = std::io::Cursor::new(b"first\nlast".to_vec());
        let windows = summary_windows(&mut reader, 10).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].bytes, b"first\nlast");
        let (dir, path) = fixture(&[user("Opening prompt"), assistant("a1", "Complete answer")]);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{{\"cwd\":\"/other\",\"sessionId\":\"other\"").unwrap();
        let discovered = discover_threads_in(dir.path(), CWD).remove(0);
        assert_eq!(
            discovered.summary.last_message_preview.as_deref(),
            Some("Complete answer")
        );
    }

    struct CountingReader {
        file: fs::File,
        bytes_read: u64,
    }
    impl Read for CountingReader {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            let read = self.file.read(bytes)?;
            self.bytes_read += read as u64;
            Ok(read)
        }
    }
    impl Seek for CountingReader {
        fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
            self.file.seek(from)
        }
    }
}
