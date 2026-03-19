use std::{
    env, fs,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};

use falcondeck_core::DEFAULT_DAEMON_PORT;
use falcondeck_daemon::{DaemonConfig, EmbeddedDaemonHandle, resolve_agent_binary, spawn_embedded};
use serde::Serialize;
use tauri::{Manager, RunEvent, async_runtime::Mutex};

struct DesktopState {
    daemon: Mutex<Option<EmbeddedDaemonHandle>>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            daemon: Mutex::new(None),
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

fn daemon_build_stamp() -> Result<String, String> {
    let executable = if cfg!(windows) {
        "falcondeck-daemon.exe"
    } else {
        "falcondeck-daemon"
    };
    let path = repo_root()?.join("target").join("debug").join(executable);
    let metadata = fs::metadata(&path).map_err(|error| {
        format!(
            "failed to read daemon build metadata for {:?}: {error}",
            path
        )
    })?;
    let modified = metadata
        .modified()
        .map_err(|error| format!("failed to read daemon build timestamp: {error}"))?;
    let stamp = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("invalid daemon build timestamp: {error}"))?
        .as_millis();
    Ok(stamp.to_string())
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
        let term_status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("failed to stop dev daemon: {error}"))?;
        if !term_status.success() {
            return Err("failed to stop dev daemon".to_string());
        }
        for _ in 0..30 {
            if !daemon_reachable(SocketAddr::from(([127, 0, 0, 1], DEFAULT_DAEMON_PORT))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if daemon_reachable(SocketAddr::from(([127, 0, 0, 1], DEFAULT_DAEMON_PORT))) {
            let kill_status = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|error| format!("failed to force-stop dev daemon: {error}"))?;
            if !kill_status.success() {
                return Err("failed to force-stop dev daemon".to_string());
            }
        }
    }

    let _ = fs::remove_file(pid_path);
    let _ = fs::remove_file(dev_stamp_path());
    Ok(())
}

fn ensure_dev_daemon() -> Result<String, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], DEFAULT_DAEMON_PORT));
    let expected_stamp = daemon_build_stamp().ok();
    let running_stamp = read_dev_stamp();
    let needs_restart =
        daemon_reachable(addr) && expected_stamp.is_some() && expected_stamp != running_stamp;

    if needs_restart {
        stop_dev_daemon_process()?;
    }

    if !daemon_reachable(addr) {
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

        for _ in 0..40 {
            if daemon_reachable(addr) {
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    if !daemon_reachable(addr) {
        return Err("dev daemon did not start in time".to_string());
    }

    if let Some(stamp) = expected_stamp.as_deref() {
        let _ = write_dev_stamp(stamp);
    }

    Ok(format!("http://{}", addr))
}

fn resolve_agent_bin(bin_name: &str, override_var: &str) -> String {
    let configured = env::var(override_var).unwrap_or_else(|_| bin_name.to_string());
    resolve_agent_binary(bin_name, &configured).executable
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

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                return Ok(());
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<DesktopState>();
                let _ = ensure_daemon_running(state).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ensure_daemon_running])
        .build(tauri::generate_context!())
        .expect("failed to build FalconDeck desktop");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if cfg!(debug_assertions) {
                return;
            }
            let state = app_handle.state::<DesktopState>();
            tauri::async_runtime::block_on(async move {
                let mut daemon = state.daemon.lock().await;
                if let Some(handle) = daemon.take() {
                    let _ = handle.shutdown().await;
                }
            });
        }
    });
}
