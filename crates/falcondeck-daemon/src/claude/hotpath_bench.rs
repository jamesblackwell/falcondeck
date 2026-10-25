//! Repeatable timings for Claude session discovery, transcript hydrate, and
//! stdout framing. Ignored so normal test runs stay small.
//!
//! ```text
//! CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
//!   cargo test -p falcondeck-daemon --release --lib \
//!   claude::hotpath_bench::measure_startup_and_stream_hotpaths -- \
//!   --ignored --nocapture --test-threads=1
//! ```

use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    time::Instant,
};

use serde_json::json;

use super::{
    ClaudeNdjsonFramer, clear_session_file_cache_for_test, discover_threads_in,
    history::clear_summary_cache_for_test, hydrate_native_thread, parse_claude_stream_lines,
};

const DISCOVERY_SESSIONS: usize = 400;
const DISCOVERY_MESSAGES: usize = 40;
const DISCOVERY_TEXT_BYTES: usize = 768;
const HYDRATE_MESSAGES: usize = 2_000;
const HYDRATE_TEXT_BYTES: usize = 1_500;
const STREAM_LINES: usize = 20_000;
const MEASURED_RUNS: usize = 5;

struct DiscoveryFixture {
    root: tempfile::TempDir,
    workspace: String,
    newest_id: String,
}

fn session_id(index: usize) -> String {
    format!("00000000-0000-4000-8000-{index:012x}")
}

fn project_dir_name(workspace: &str) -> String {
    workspace.replace(['/', '\\'], "-")
}

fn write_session(
    path: &std::path::Path,
    session: &str,
    workspace: &str,
    messages: usize,
    text_bytes: usize,
    stamp: &str,
) {
    let text = "x".repeat(text_bytes);
    let mut file = BufWriter::new(File::create(path).unwrap());
    serde_json::to_writer(
        &mut file,
        &json!({
            "type": "custom-title",
            "sessionId": session,
            "customTitle": format!("Session {session}"),
            "cwd": workspace,
            "timestamp": stamp,
        }),
    )
    .unwrap();
    file.write_all(b"\n").unwrap();
    for message in 0..messages {
        let content = if message % 2 == 0 {
            json!({"role": "user", "content": text})
        } else {
            json!({
                "id": format!("assistant-{message}"),
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
            })
        };
        serde_json::to_writer(
            &mut file,
            &json!({
                "sessionId": session,
                "cwd": workspace,
                "uuid": format!("item-{message}"),
                "timestamp": stamp,
                "type": if message % 2 == 0 { "user" } else { "assistant" },
                "message": content,
            }),
        )
        .unwrap();
        file.write_all(b"\n").unwrap();
    }
    file.flush().unwrap();
}

fn discovery_fixture(sessions: usize, messages: usize, text_bytes: usize) -> DiscoveryFixture {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let workspace = workspace.to_string_lossy().to_string();
    let project = root.path().join(project_dir_name(&workspace));
    fs::create_dir_all(&project).unwrap();
    for session in 0..sessions {
        let id = session_id(session);
        let stamp = format!("2026-10-05T10:{:02}:{:02}Z", session / 60, session % 60);
        write_session(
            &project.join(format!("{id}.jsonl")),
            &id,
            &workspace,
            messages,
            text_bytes,
            &stamp,
        );
    }
    DiscoveryFixture {
        newest_id: session_id(sessions - 1),
        root,
        workspace,
    }
}

fn assert_discovery_shape(fixture: &DiscoveryFixture, sessions: usize) {
    let threads = discover_threads_in(fixture.root.path(), &fixture.workspace);
    assert_eq!(threads.len(), sessions);
    assert_eq!(
        threads[0].summary.native_session_id.as_deref(),
        Some(fixture.newest_id.as_str())
    );
    assert!(threads[0].summary.title.contains(&fixture.newest_id));
    assert_eq!(
        threads[0]
            .summary
            .last_message_preview
            .as_deref()
            .map(str::len),
        Some(80 + 3)
    );
    for pair in threads.windows(2) {
        assert!(pair[0].summary.updated_at >= pair[1].summary.updated_at);
    }
}

fn median_ms(samples: &[f64]) -> f64 {
    let mut samples = samples.to_vec();
    samples.sort_by(|left, right| left.partial_cmp(right).unwrap());
    let mid = samples.len() / 2;
    if samples.len() % 2 == 0 {
        (samples[mid - 1] + samples[mid]) / 2.0
    } else {
        samples[mid]
    }
}

fn time_ms(runs: usize, mut body: impl FnMut()) -> (f64, Vec<f64>) {
    let mut samples = Vec::with_capacity(runs);
    for _ in 0..runs {
        let started = Instant::now();
        body();
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    (median_ms(&samples), samples)
}

fn stream_payload() -> Vec<u8> {
    let mut payload = Vec::with_capacity(STREAM_LINES * 180);
    for index in 0..STREAM_LINES {
        if index % 32 == 0 {
            payload.extend_from_slice(b"{\"type\":\"keep_alive\"}\n");
            continue;
        }
        let _ = write!(
            payload,
            "{{\"type\":\"stream_event\",\"index\":{index},\"event\":{{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"token-{index}-more\"}}}}}}\n"
        );
    }
    // A raw newline inside a string must stay one record.
    payload.extend_from_slice(
        b"{\"type\":\"assistant\",\"message\":\"hello\nworld\"}\n{\"type\":\"keep_alive\"}\n",
    );
    payload
}

fn frame_stream(payload: &[u8]) -> Vec<String> {
    let mut framer = ClaudeNdjsonFramer::new();
    let mut lines = Vec::new();
    for chunk in payload.chunks(8 * 1024) {
        lines.extend(framer.push(chunk));
    }
    if let Some(tail) = framer.flush() {
        lines.push(tail);
    }
    lines
}

#[test]
fn discovery_orders_sessions_and_keeps_preview() {
    let fixture = discovery_fixture(8, 4, 96);
    assert_discovery_shape(&fixture, 8);
    // A warm cache must return the same sidebar, in the same order.
    let again = discover_threads_in(fixture.root.path(), &fixture.workspace);
    assert_eq!(again.len(), 8);
    assert_eq!(
        again[0].summary.native_session_id.as_deref(),
        Some(fixture.newest_id.as_str())
    );
}

#[test]
fn stream_framer_preserves_record_order_across_chunks() {
    let lines = frame_stream(&stream_payload());
    assert!(lines.len() > STREAM_LINES);
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.contains("keep_alive"))
            .count(),
        STREAM_LINES / 32 + 1
    );
    let embedded = lines
        .iter()
        .find(|line| line.contains("hello\nworld"))
        .expect("embedded newline stays inside one record");
    assert!(!embedded.contains('\n') || embedded.matches('\n').count() == 1);
    let parsed = parse_claude_stream_lines(embedded);
    assert_eq!(parsed.len(), 1);
    let keep_alive = lines
        .last()
        .map(|line| parse_claude_stream_lines(line))
        .unwrap();
    assert_eq!(keep_alive.len(), 1);
}

#[test]
#[ignore = "release-mode hot path timings; run with --test-threads=1"]
fn measure_startup_and_stream_hotpaths() {
    let fixture = discovery_fixture(DISCOVERY_SESSIONS, DISCOVERY_MESSAGES, DISCOVERY_TEXT_BYTES);
    assert_discovery_shape(&fixture, DISCOVERY_SESSIONS);

    let _ = time_ms(1, || {
        clear_summary_cache_for_test();
        let threads = discover_threads_in(fixture.root.path(), &fixture.workspace);
        assert_eq!(threads.len(), DISCOVERY_SESSIONS);
    });
    let (discovery_cold_ms, discovery_cold_samples) = time_ms(MEASURED_RUNS, || {
        clear_summary_cache_for_test();
        let threads = discover_threads_in(fixture.root.path(), &fixture.workspace);
        assert_eq!(threads.len(), DISCOVERY_SESSIONS);
    });
    let (discovery_warm_ms, discovery_warm_samples) = time_ms(MEASURED_RUNS, || {
        let threads = discover_threads_in(fixture.root.path(), &fixture.workspace);
        assert_eq!(threads.len(), DISCOVERY_SESSIONS);
    });

    let hydrate_root = tempfile::tempdir().unwrap();
    let hydrate_workspace = hydrate_root.path().join("workspace");
    fs::create_dir(&hydrate_workspace).unwrap();
    let hydrate_workspace = hydrate_workspace.to_string_lossy().to_string();
    let hydrate_project = hydrate_root
        .path()
        .join(project_dir_name(&hydrate_workspace));
    fs::create_dir_all(&hydrate_project).unwrap();
    let hydrate_id = session_id(1);
    let hydrate_path = hydrate_project.join(format!("{hydrate_id}.jsonl"));
    write_session(
        &hydrate_path,
        &hydrate_id,
        &hydrate_workspace,
        HYDRATE_MESSAGES,
        HYDRATE_TEXT_BYTES,
        "2026-10-05T12:00:00Z",
    );
    let _ = time_ms(1, || {
        clear_session_file_cache_for_test();
        let thread = hydrate_native_thread(&hydrate_path, &hydrate_workspace, &hydrate_id).unwrap();
        assert_eq!(thread.items.len(), HYDRATE_MESSAGES);
    });
    let (hydrate_ms, hydrate_samples) = time_ms(MEASURED_RUNS, || {
        clear_session_file_cache_for_test();
        let thread = hydrate_native_thread(&hydrate_path, &hydrate_workspace, &hydrate_id).unwrap();
        assert_eq!(thread.items.len(), HYDRATE_MESSAGES);
    });

    let payload = stream_payload();
    let _ = time_ms(1, || {
        let lines = frame_stream(&payload);
        assert!(lines.len() > STREAM_LINES);
    });
    let (frame_ms, frame_samples) = time_ms(MEASURED_RUNS, || {
        let lines = frame_stream(&payload);
        assert!(lines.len() > STREAM_LINES);
    });
    let framed = frame_stream(&payload);
    let (parse_ms, parse_samples) = time_ms(MEASURED_RUNS, || {
        let mut records = 0;
        for line in &framed {
            records += parse_claude_stream_lines(line).len();
        }
        assert!(records > STREAM_LINES);
    });

    let codex_line = json!({
        "jsonrpc": "2.0",
        "method": "item/agentMessage/delta",
        "params": {"threadId": "t-1", "text": "y".repeat(200_000)},
    })
    .to_string();
    let codex_value = serde_json::from_str::<serde_json::Value>(&codex_line).unwrap();
    let (codex_clone_ms, codex_clone_samples) = time_ms(MEASURED_RUNS, || {
        for _ in 0..40 {
            let message = codex_value.clone();
            let params = message
                .get("params")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            assert_eq!(params["threadId"], "t-1");
        }
    });
    let (codex_take_ms, codex_take_samples) = time_ms(MEASURED_RUNS, || {
        for _ in 0..40 {
            let message = codex_value.clone();
            let crate::codex::CodexStdoutMessage::Notification { params, .. } =
                crate::codex::take_codex_stdout_message(message).unwrap()
            else {
                panic!("expected a notification");
            };
            assert_eq!(params["threadId"], "t-1");
        }
    });

    println!(
        "HOTPATH_BENCH {}",
        json!({
            "runs": MEASURED_RUNS,
            "warmup_runs_discarded": 1,
            "discovery": {
                "sessions": DISCOVERY_SESSIONS,
                "messages_per_session": DISCOVERY_MESSAGES,
                "text_bytes": DISCOVERY_TEXT_BYTES,
                "cold_median_ms": discovery_cold_ms,
                "cold_samples_ms": discovery_cold_samples,
                "warm_median_ms": discovery_warm_ms,
                "warm_samples_ms": discovery_warm_samples,
            },
            "hydrate": {
                "messages": HYDRATE_MESSAGES,
                "text_bytes": HYDRATE_TEXT_BYTES,
                "median_ms": hydrate_ms,
                "samples_ms": hydrate_samples,
            },
            "stdout": {
                "lines": STREAM_LINES,
                "frame_median_ms": frame_ms,
                "frame_samples_ms": frame_samples,
                "parse_median_ms": parse_ms,
                "parse_samples_ms": parse_samples,
            },
            "codex_large_params": {
                "copies_per_run": 40,
                "text_bytes": 200_000,
                "clone_median_ms": codex_clone_ms,
                "clone_samples_ms": codex_clone_samples,
                "take_median_ms": codex_take_ms,
                "take_samples_ms": codex_take_samples,
            },
        })
    );
}
