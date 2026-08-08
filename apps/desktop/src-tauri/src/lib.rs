use std::{
    collections::hash_map::DefaultHasher,
    env, fs,
    hash::{Hash, Hasher},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use falcondeck_core::DEFAULT_DAEMON_PORT;
use falcondeck_daemon::{resolve_agent_binary, spawn_embedded, DaemonConfig, EmbeddedDaemonHandle};
use serde::Serialize;
use tauri::{async_runtime::Mutex, AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

struct DesktopState {
    daemon: Mutex<Option<EmbeddedDaemonHandle>>,
    exit_prompt_open: AtomicBool,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            daemon: Mutex::new(None),
            exit_prompt_open: AtomicBool::new(false),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonConnection {
    base_url: String,
}

fn dev_state_path() -> PathBuf {
    std::env::var("HOME")
        .map(|home| {
            PathBuf::from(home)
                .join(".falcondeck")
                .join("daemon-state.dev.json")
        })
        .unwrap_or_else(|_| PathBuf::from(".falcondeck/daemon-state.dev.json"))
}

fn dev_pid_path() -> PathBuf {
    std::env::var("HOME")
        .map(|home| {
            PathBuf::from(home)
                .join(".falcondeck")
                .join("daemon-state.dev.pid")
        })
        .unwrap_or_else(|_| PathBuf::from(".falcondeck/daemon-state.dev.pid"))
}

fn dev_stamp_path() -> PathBuf {
    std::env::var("HOME")
        .map(|home| {
            PathBuf::from(home)
                .join(".falcondeck")
                .join("daemon-state.dev.stamp")
        })
        .unwrap_or_else(|_| PathBuf::from(".falcondeck/daemon-state.dev.stamp"))
}

fn daemon_reachable(addr: SocketAddr) -> bool {
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn repo_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .map_err(|error| error.to_string())
}

fn collect_dev_daemon_inputs(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            collect_dev_daemon_inputs(&path, files)?;
        } else if path.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn dev_daemon_source_stamp() -> Result<String, String> {
    let root = repo_root()?;
    let mut files = vec![root.join("Cargo.toml"), root.join("Cargo.lock")];
    collect_dev_daemon_inputs(&root.join("crates/falcondeck-core"), &mut files)?;
    collect_dev_daemon_inputs(&root.join("crates/falcondeck-daemon"), &mut files)?;
    files.sort();

    let mut hasher = DefaultHasher::new();
    for path in files {
        path.strip_prefix(&root).unwrap_or(&path).hash(&mut hasher);
        fs::read(&path)
            .map_err(|error| format!("failed to fingerprint {path:?}: {error}"))?
            .hash(&mut hasher);
    }
    Ok(format!("{:016x}", hasher.finish()))
}

fn read_dev_stamp() -> Option<String> {
    fs::read_to_string(dev_stamp_path())
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn write_dev_stamp(stamp: &str) -> Result<(), String> {
    if let Some(parent) = dev_stamp_path().parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(dev_stamp_path(), stamp).map_err(|error| error.to_string())
}

fn stop_dev_daemon_process() -> Result<(), String> {
    let pid_path = dev_pid_path();
    let raw_pid = match fs::read_to_string(&pid_path) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    let pid = raw_pid
        .trim()
        .parse::<u32>()
        .map_err(|error| format!("invalid dev daemon pid file: {error}"))?;

    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("failed to stop dev daemon: {error}"))?;
        if !status.success() {
            return Err("failed to stop dev daemon".to_string());
        }
    }

    #[cfg(not(windows))]
    {
        // The recorded pid may be the `cargo run` wrapper rather than the
        // daemon itself, and it may already be dead while its orphaned child
        // still holds the port. A failed TERM is therefore not an error —
        // the port-based cleanup below is the authoritative fallback.
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let addr = SocketAddr::from(([127, 0, 0, 1], DEFAULT_DAEMON_PORT));
        for _ in 0..30 {
            if !daemon_reachable(addr) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if daemon_reachable(addr) {
            // Kill whichever process actually listens on the daemon port —
            // this catches orphans the pid file doesn't know about.
            let listener = Command::new("lsof")
                .args([
                    "-ti",
                    &format!("tcp:{DEFAULT_DAEMON_PORT}"),
                    "-sTCP:LISTEN",
                ])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .ok()
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .filter(|pids| !pids.is_empty());
            for listener_pid in listener.iter().flat_map(|pids| pids.lines()) {
                let _ = Command::new("kill")
                    .args(["-KILL", listener_pid.trim()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            for _ in 0..20 {
                if !daemon_reachable(addr) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if daemon_reachable(addr) {
            return Err("failed to stop dev daemon: port still in use".to_string());
        }
    }

    let _ = fs::remove_file(pid_path);
    let _ = fs::remove_file(dev_stamp_path());
    Ok(())
}

/// True when the pid from the dev daemon pid file refers to a live process
/// (which may still be `cargo run` compiling the daemon).
fn dev_daemon_process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let _ = pid;
        false
    }
    #[cfg(not(windows))]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn ensure_dev_daemon() -> Result<String, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], DEFAULT_DAEMON_PORT));
    let expected_stamp = dev_daemon_source_stamp().ok();
    let running_stamp = read_dev_stamp();
    let needs_restart =
        daemon_reachable(addr) && expected_stamp.is_some() && expected_stamp != running_stamp;

    if needs_restart {
        stop_dev_daemon_process()?;
    }

    if !daemon_reachable(addr) {
        // A previously spawned dev daemon may still be compiling under cargo.
        // Don't stack another `cargo run` on top of it (they fight over the
        // build lock and the port) — just fall through and wait for it.
        let spawn_in_flight = fs::read_to_string(dev_pid_path())
            .ok()
            .and_then(|raw| raw.trim().parse::<u32>().ok())
            .is_some_and(dev_daemon_process_alive);
        if !spawn_in_flight {
            let _ = std::fs::remove_file(dev_pid_path());
            let repo_root = repo_root()?;
            let state_path = dev_state_path();
            let child = Command::new("cargo")
                .args([
                    "run",
                    "-p",
                    "falcondeck-daemon",
                    "--",
                    &format!("--port={DEFAULT_DAEMON_PORT}"),
                ])
                .env("FALCONDECK_STATE_PATH", state_path)
                .current_dir(repo_root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("failed to spawn dev daemon: {error}"))?;
            if let Some(parent) = dev_pid_path().parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(dev_pid_path(), child.id().to_string())
                .map_err(|error| error.to_string())?;
            if let Some(stamp) = expected_stamp.as_deref() {
                write_dev_stamp(stamp)?;
            }
        }

        // `cargo run` may have to recompile the daemon after a source change
        // (and can be stuck behind the tauri watcher's own build lock), so
        // give it a realistic window, not seconds. The frontend keeps showing
        // its connecting state while this blocks.
        for _ in 0..600 {
            if daemon_reachable(addr) {
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    if !daemon_reachable(addr) {
        return Err(
            "dev daemon did not start in time (is `cargo run -p falcondeck-daemon` failing to compile?)"
                .to_string(),
        );
    }

    if let Some(stamp) = expected_stamp.as_deref() {
        let _ = write_dev_stamp(stamp);
    }

    Ok(format!("http://{}", addr))
}

fn resolve_agent_bin(bin_name: &str, override_var: &str) -> String {
    if let Ok(configured) = env::var(override_var) {
        return resolve_agent_binary(bin_name, &configured).executable;
    }

    if !cfg!(debug_assertions) {
        if let Some(preferred) = preferred_packaged_agent_bin(bin_name) {
            return resolve_agent_binary(bin_name, &preferred).executable;
        }
    }

    resolve_agent_binary(bin_name, bin_name).executable
}

fn preferred_packaged_agent_bin(bin_name: &str) -> Option<String> {
    let mut candidates = Vec::new();

    if let Ok(home) = env::var("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin").join(bin_name));
        candidates.push(home.join(".cargo/bin").join(bin_name));
    }

    #[cfg(target_os = "macos")]
    {
        #[cfg(target_arch = "aarch64")]
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(bin_name));
        candidates.push(PathBuf::from("/usr/local/bin").join(bin_name));
    }

    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr/local/bin").join(bin_name));
        candidates.push(PathBuf::from("/usr/bin").join(bin_name));
    }

    candidates
        .into_iter()
        .find_map(|path| normalize_existing_path(&path))
}

fn normalize_existing_path(path: &Path) -> Option<String> {
    if !path.is_absolute() || !path.is_file() {
        return None;
    }

    path.canonicalize()
        .ok()
        .map(|resolved| resolved.display().to_string())
}

#[tauri::command]
async fn ensure_daemon_running(
    state: tauri::State<'_, DesktopState>,
) -> Result<DaemonConnection, String> {
    if cfg!(debug_assertions) {
        return Ok(DaemonConnection {
            base_url: ensure_dev_daemon()?,
        });
    }

    let mut daemon = state.daemon.lock().await;
    if let Some(handle) = daemon.as_ref() {
        return Ok(DaemonConnection {
            base_url: handle.base_url(),
        });
    }

    let codex_bin = resolve_agent_bin("codex", "FALCONDECK_CODEX_BIN");
    let claude_bin = resolve_agent_bin("claude", "FALCONDECK_CLAUDE_BIN");
    let handle = spawn_embedded(DaemonConfig {
        bind_addr: "127.0.0.1:0"
            .parse::<SocketAddr>()
            .map_err(|error| error.to_string())?,
        codex_bin,
        claude_bin,
        ..DaemonConfig::default()
    })
    .await
    .map_err(|error| error.to_string())?;
    let base_url = handle.base_url();
    *daemon = Some(handle);

    Ok(DaemonConnection { base_url })
}

async fn shutdown_embedded_daemon(state: tauri::State<'_, DesktopState>) {
    let mut daemon = state.daemon.lock().await;
    if let Some(handle) = daemon.take() {
        let _ = handle.shutdown().await;
    }
}

async fn active_thread_count(state: &DesktopState) -> usize {
    let daemon = state.daemon.lock().await;
    match daemon.as_ref() {
        Some(handle) => handle.active_thread_count().await,
        None => 0,
    }
}

fn quit_warning_message(active_thread_count: usize) -> String {
    let (active_turns, pronoun) = if active_thread_count == 1 {
        ("1 thread has an active turn".to_string(), "it")
    } else {
        (
            format!("{active_thread_count} threads have active turns"),
            "them",
        )
    };
    format!(
        "{active_turns}. Quitting FalconDeck will stop {pronoun}. You can resume {pronoun} after reopening the app."
    )
}

#[tauri::command]
async fn restart_app(app: AppHandle, state: tauri::State<'_, DesktopState>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        shutdown_embedded_daemon(state).await;
    }
    app.restart();
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("FalconDeck can only open http or https links.".to_string());
    }

    open::that_detached(url).map_err(|error| error.to_string())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .map_err(|error| error.to_string())?;

            if cfg!(debug_assertions) {
                return Ok(());
            }

            // Start the embedded daemon before the window is served. The
            // packaged app owns the daemon lifecycle, so letting this run as
            // an ignored background task can leave the UI alive with no local
            // API or remote relay bridge when startup fails.
            let state = app.state::<DesktopState>();
            tauri::async_runtime::block_on(ensure_daemon_running(state))
                .map_err(|error| format!("failed to start embedded daemon: {error}"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ensure_daemon_running,
            restart_app,
            open_external_url
        ])
        .build(tauri::generate_context!())
        .expect("failed to build FalconDeck desktop");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if cfg!(debug_assertions) || code.is_some() {
                return;
            }

            let state = app_handle.state::<DesktopState>();
            let active_thread_count =
                tauri::async_runtime::block_on(active_thread_count(&state));
            if active_thread_count == 0 {
                return;
            }

            api.prevent_exit();
            if state.exit_prompt_open.swap(true, Ordering::AcqRel) {
                return;
            }

            let handle = app_handle.clone();
            app_handle
                .dialog()
                .message(quit_warning_message(active_thread_count))
                .title("Stop active threads and quit?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Quit and stop threads".to_string(),
                    "Keep FalconDeck open".to_string(),
                ))
                .show(move |should_quit| {
                    handle
                        .state::<DesktopState>()
                        .exit_prompt_open
                        .store(false, Ordering::Release);
                    if should_quit {
                        handle.exit(0);
                    }
                });
        }
        RunEvent::Exit => {
            if !cfg!(debug_assertions) {
                let state = app_handle.state::<DesktopState>();
                tauri::async_runtime::block_on(async move {
                    shutdown_embedded_daemon(state).await
                });
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::quit_warning_message;

    #[test]
    fn quit_warning_uses_singular_copy_for_one_active_thread() {
        assert_eq!(
            quit_warning_message(1),
            "1 thread has an active turn. Quitting FalconDeck will stop it. You can resume it after reopening the app."
        );
    }

    #[test]
    fn quit_warning_uses_plural_copy_for_multiple_active_threads() {
        assert_eq!(
            quit_warning_message(2),
            "2 threads have active turns. Quitting FalconDeck will stop them. You can resume them after reopening the app."
        );
    }
}
