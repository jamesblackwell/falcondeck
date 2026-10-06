//! Opt-in startup measurement with isolated, generated Claude histories.
//!
//! Run the ignored test in release mode with `--nocapture`. The controller
//! generates the fixture outside the measured process, then launches one fresh
//! child. Set `FALCONDECK_STARTUP_FIXTURE_DIR` to reuse an identical fixture
//! between builds. No user histories or process-global environment are changed.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufWriter, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};

use falcondeck_core::{AgentProvider, ConnectWorkspaceRequest, ConversationItem, WorkspaceKind};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::AppState;

const TEST_NAME: &str = "app::claude_startup_measurement::measure_synthetic_claude_startup";
const CHILD_ENV: &str = "FALCONDECK_STARTUP_MEASUREMENT_CHILD";
const FIXTURE_ENV: &str = "FALCONDECK_STARTUP_FIXTURE_DIR";

#[derive(Deserialize, Serialize)]
struct Fixture {
    workspace: PathBuf,
    claude_config: PathBuf,
    fake_cli: PathBuf,
    sessions: usize,
    messages_per_session: usize,
    message_text_bytes: usize,
    source_bytes: u64,
}

#[derive(Serialize)]
struct Resources {
    user_cpu_ms: f64,
    system_cpu_ms: f64,
    peak_rss_bytes: u64,
}

impl Resources {
    fn current() -> Self {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        // SAFETY: getrusage initializes the pointed-to structure on success.
        let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
        assert_eq!(result, 0, "getrusage failed");
        // SAFETY: the successful call above initialized every field.
        let usage = unsafe { usage.assume_init() };
        let peak_rss = u64::try_from(usage.ru_maxrss).unwrap();
        Self {
            user_cpu_ms: usage.ru_utime.tv_sec as f64 * 1_000.0
                + usage.ru_utime.tv_usec as f64 / 1_000.0,
            system_cpu_ms: usage.ru_stime.tv_sec as f64 * 1_000.0
                + usage.ru_stime.tv_usec as f64 / 1_000.0,
            // Darwin reports bytes; other supported Unix hosts report KiB.
            peak_rss_bytes: if cfg!(target_os = "macos") {
                peak_rss
            } else {
                peak_rss * 1_024
            },
        }
    }

    fn since(&self, earlier: &Self) -> Self {
        Self {
            user_cpu_ms: self.user_cpu_ms - earlier.user_cpu_ms,
            system_cpu_ms: self.system_cpu_ms - earlier.system_cpu_ms,
            peak_rss_bytes: self.peak_rss_bytes,
        }
    }
}

#[derive(Serialize)]
struct RetainedHistory {
    threads: usize,
    items: usize,
    message_text_bytes: usize,
}

async fn retained_history(app: &AppState) -> RetainedHistory {
    let workspaces = app.inner.workspaces.lock().await;
    let threads = workspaces
        .values()
        .flat_map(|workspace| workspace.threads.values())
        .filter(|thread| thread.summary.provider == AgentProvider::CLAUDE);
    let mut retained = RetainedHistory {
        threads: 0,
        items: 0,
        message_text_bytes: 0,
    };
    for thread in threads {
        retained.threads += 1;
        retained.items += thread.items.len();
        for item in &thread.items {
            if let ConversationItem::UserMessage { text, .. }
            | ConversationItem::AssistantMessage { text, .. } = item
            {
                retained.message_text_bytes += text.len();
            }
        }
    }
    retained
}

fn fixture_count(name: &str, default: usize) -> usize {
    std::env::var(name)
        .map(|value| value.parse::<usize>().expect("invalid fixture count"))
        .unwrap_or(default)
        .max(1)
}

fn prepare_fixture(root: &Path) -> Fixture {
    let manifest = root.join("fixture.json");
    if manifest.is_file() {
        return serde_json::from_reader(File::open(manifest).unwrap()).unwrap();
    }
    fs::create_dir_all(root).unwrap();
    let root = root.canonicalize().unwrap();
    let workspace = root.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let claude_config = root.join("claude-config");
    let project_dir = claude_config
        .join("projects")
        .join(workspace.to_str().unwrap().replace(['/', '\\'], "-"));
    fs::create_dir_all(&project_dir).unwrap();
    let fake_cli = root.join("fake-cli");
    fs::write(
        &fake_cli,
        "#!/bin/sh\nif [ \"$1\" = auth ]; then printf '%s\\n' '{\"authenticated\":true}'; exit 0; fi\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&fake_cli, fs::Permissions::from_mode(0o700)).unwrap();

    let sessions = fixture_count("FALCONDECK_STARTUP_SESSIONS", 2_000);
    let messages_per_session = fixture_count("FALCONDECK_STARTUP_MESSAGES", 40);
    let message_text_bytes = fixture_count("FALCONDECK_STARTUP_TEXT_BYTES", 2_048);
    let text = "x".repeat(message_text_bytes);
    let mut source_bytes = 0;
    for session in 0..sessions {
        let id = format!("00000000-0000-4000-8000-{session:012x}");
        let path = project_dir.join(format!("{id}.jsonl"));
        let mut file = BufWriter::new(File::create(&path).unwrap());
        serde_json::to_writer(
            &mut file,
            &json!({
                "type": "custom-title", "sessionId": id,
                "customTitle": format!("Fixture session {session}"),
            }),
        )
        .unwrap();
        file.write_all(b"\n").unwrap();
        for message in 0..messages_per_session {
            let timestamp = format!("2026-10-05T10:00:{:02}Z", message % 60);
            let content = if message % 2 == 0 {
                json!({"role": "user", "content": text})
            } else {
                json!({
                    "id": format!("assistant-{message}"), "role": "assistant",
                    "content": [{"type": "text", "text": text}],
                })
            };
            serde_json::to_writer(
                &mut file,
                &json!({
                    "sessionId": id, "cwd": workspace,
                    "uuid": format!("item-{message}"), "timestamp": timestamp,
                    "type": if message % 2 == 0 { "user" } else { "assistant" },
                    "message": content,
                }),
            )
            .unwrap();
            file.write_all(b"\n").unwrap();
        }
        file.flush().unwrap();
        source_bytes += fs::metadata(path).unwrap().len();
    }
    let fixture = Fixture {
        workspace,
        claude_config,
        fake_cli,
        sessions,
        messages_per_session,
        message_text_bytes,
        source_bytes,
    };
    serde_json::to_writer(File::create(manifest).unwrap(), &fixture).unwrap();
    fixture
}

#[test]
#[ignore = "large synthetic startup profile; run explicitly in release mode"]
fn measure_synthetic_claude_startup() {
    if std::env::var_os(CHILD_ENV).is_none() {
        let temporary = tempfile::tempdir().unwrap();
        let root = std::env::var_os(FIXTURE_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| temporary.path().to_path_buf());
        let fixture = prepare_fixture(&root);
        let root = root.canonicalize().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                TEST_NAME,
                "--nocapture",
                "--test-threads=1",
            ])
            .env_clear()
            .current_dir(&root)
            .env(CHILD_ENV, "1")
            .env(FIXTURE_ENV, &root)
            .env("CLAUDE_CONFIG_DIR", &fixture.claude_config)
            .output()
            .unwrap();
        print!("{}", String::from_utf8_lossy(&output.stdout));
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        assert!(output.status.success(), "startup measurement child failed");
        return;
    }

    let root = PathBuf::from(std::env::var_os(FIXTURE_ENV).unwrap());
    let fixture: Fixture =
        serde_json::from_reader(File::open(root.join("fixture.json")).unwrap()).unwrap();
    assert_eq!(
        PathBuf::from(std::env::var_os("CLAUDE_CONFIG_DIR").unwrap()),
        fixture.claude_config,
        "measurement must use the isolated Claude config",
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let before = Resources::current();
        let started = Instant::now();
        let bins = [AgentProvider::CODEX, AgentProvider::CLAUDE, AgentProvider::AGY]
            .into_iter()
            .map(|provider| (provider, fixture.fake_cli.to_str().unwrap().to_string()))
            .collect::<HashMap<_, _>>();
        let app = AppState::new_with_state_path_and_runtimes(
            "startup-measurement".into(), bins, root.join("state.json"),
            fixture.fake_cli.to_str().unwrap().to_string(), None,
        );
        let workspace = app.connect_workspace_internal(ConnectWorkspaceRequest {
            path: fixture.workspace.to_str().unwrap().to_string(),
            kind: WorkspaceKind::Project,
        }, None).await.unwrap();
        let startup_elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let after_startup = Resources::current();
        let startup_retained = retained_history(&app).await;
        assert_eq!(startup_retained.threads, fixture.sessions,
            "the measured process did not discover all isolated fixture sessions");

        let selected = workspace.current_thread_id.as_deref().unwrap();
        let before_detail = Resources::current();
        let detail_started = Instant::now();
        let detail = app.thread_detail(&workspace.id, selected).await.unwrap();
        let detail_elapsed_ms = detail_started.elapsed().as_secs_f64() * 1_000.0;
        let after_detail = Resources::current();
        assert_eq!(detail.items.len(), fixture.messages_per_session);
        let detail_retained = retained_history(&app).await;
        println!("STARTUP_MEASUREMENT {}", json!({
            "fixture": fixture,
            "startup": {
                "elapsed_ms": startup_elapsed_ms,
                "resources": after_startup.since(&before),
                "retained_history": startup_retained,
            },
            "selected_detail": {
                "elapsed_ms": detail_elapsed_ms,
                "resources": after_detail.since(&before_detail),
                "returned_items": detail.items.len(),
                "retained_history": detail_retained,
            },
            "cpu_scope": "daemon process including all threads; fake CLI children excluded",
            "rss_scope": "process lifetime high-water mark measured before reporting allocations",
        }));
        drop(detail);
        app.shutdown().await.unwrap();
    });
}
