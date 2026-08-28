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

mod desktop_notifications;
mod dictation;
mod dictation_history;

/// Kept in sync with ACTIVITY_WINDOW_LABEL in src/activity-window-bridge.ts.
const ACTIVITY_WINDOW_LABEL: &str = "activity";

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

    // Fingerprint path + mtime + length only. Full-content hashing was multi-MB
    // of IO on every ensure_dev_daemon() call; mtimes catch normal edit/rebuild
    // loops and are enough for the reusable-dev-daemon restart decision.
    let mut hasher = DefaultHasher::new();
    for path in files {
        path.strip_prefix(&root).unwrap_or(&path).hash(&mut hasher);
        let meta = fs::metadata(&path)
            .map_err(|error| format!("failed to fingerprint {path:?}: {error}"))?;
        meta.len().hash(&mut hasher);
        if let Ok(modified) = meta.modified() {
            modified.hash(&mut hasher);
        }
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
                .args(["-ti", &format!("tcp:{DEFAULT_DAEMON_PORT}"), "-sTCP:LISTEN"])
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
            let binary = repo_root.join("target/debug/falcondeck-daemon");
            // Warm restart: stamp still matches and the debug binary exists →
            // skip cargo entirely. Cold / after source changes: build then exec
            // so the recorded pid becomes the daemon (not a cargo wrapper).
            let binary_is_current =
                binary.is_file() && expected_stamp.is_some() && expected_stamp == running_stamp;
            let child = {
                #[cfg(windows)]
                {
                    let _ = (binary_is_current, &binary);
                    Command::new("cargo")
                        .args([
                            "run",
                            "-p",
                            "falcondeck-daemon",
                            "--",
                            &format!("--port={DEFAULT_DAEMON_PORT}"),
                        ])
                        .env("FALCONDECK_STATE_PATH", &state_path)
                        .current_dir(&repo_root)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| format!("failed to spawn dev daemon: {error}"))?
                }
                #[cfg(not(windows))]
                {
                    if binary_is_current {
                        Command::new(&binary)
                            .args([&format!("--port={DEFAULT_DAEMON_PORT}")])
                            .env("FALCONDECK_STATE_PATH", &state_path)
                            .current_dir(&repo_root)
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                            .map_err(|error| format!("failed to spawn dev daemon: {error}"))?
                    } else {
                        Command::new("sh")
                            .args([
                                "-c",
                                &format!(
                                    "cargo build -q -p falcondeck-daemon && exec \"$1\" --port={DEFAULT_DAEMON_PORT}"
                                ),
                                "falcondeck-dev-daemon",
                                binary.to_str().ok_or_else(|| {
                                    "dev daemon binary path is not valid UTF-8".to_string()
                                })?,
                            ])
                            .env("FALCONDECK_STATE_PATH", &state_path)
                            .current_dir(&repo_root)
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                            .map_err(|error| format!("failed to spawn dev daemon: {error}"))?
                    }
                }
            };
            if let Some(parent) = dev_pid_path().parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(dev_pid_path(), child.id().to_string())
                .map_err(|error| error.to_string())?;
            if let Some(stamp) = expected_stamp.as_deref() {
                write_dev_stamp(stamp)?;
            }
        }

        // First-time builds may recompile the daemon after a source change
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

fn bundled_deno_bin() -> Result<String, String> {
    let executable_name = if cfg!(windows) { "deno.exe" } else { "deno" };
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let candidate = executable
        .parent()
        .ok_or_else(|| "FalconDeck executable has no parent directory".to_string())?
        .join(executable_name);
    normalize_existing_path(&candidate).ok_or_else(|| {
        format!(
            "bundled extension runtime is missing at {}",
            candidate.display()
        )
    })
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
    let agy_bin = resolve_agent_bin("agy", "FALCONDECK_AGY_BIN");
    let deno_bin = bundled_deno_bin()?;
    let handle = spawn_embedded(DaemonConfig {
        bind_addr: "127.0.0.1:0"
            .parse::<SocketAddr>()
            .map_err(|error| error.to_string())?,
        provider_bins: std::collections::HashMap::from([("agy".to_string(), agy_bin)]),
        codex_bin,
        claude_bin,
        deno_bin,
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

fn is_safe_external_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:")
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !is_safe_external_url(&url) {
        return Err("FalconDeck can only open http, https, mailto, or tel links.".to_string());
    }

    open::that_detached(url).map_err(|error| error.to_string())
}

fn missing_local_path_error() -> String {
    #[cfg(target_os = "macos")]
    {
        "This path is not on this Mac.".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "This path is not on this computer.".to_string()
    }
}

fn from_hex_digit(digit: u8) -> Result<u8, String> {
    match digit {
        b'0'..=b'9' => Ok(digit - b'0'),
        b'a'..=b'f' => Ok(digit - b'a' + 10),
        b'A'..=b'F' => Ok(digit - b'A' + 10),
        _ => Err("Invalid percent-encoding in path.".to_string()),
    }
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Invalid percent-encoding in path.".to_string());
            }
            let value =
                (from_hex_digit(bytes[index + 1])? << 4) | from_hex_digit(bytes[index + 2])?;
            out.push(value);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).map_err(|_| "Path is not valid UTF-8.".to_string())
}

fn decode_file_url(raw: &str) -> Result<String, String> {
    if !raw
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        return Err("Not a file URL.".to_string());
    }
    let rest = &raw[7..];
    let path_part = if rest.starts_with('/') {
        rest
    } else {
        let slash = rest
            .find('/')
            .ok_or_else(|| "Invalid file URL.".to_string())?;
        let host = &rest[..slash];
        if !host.is_empty() && host != "localhost" && host != "127.0.0.1" {
            return Err("FalconDeck can only open local file URLs.".to_string());
        }
        &rest[slash..]
    };
    let decoded = percent_decode(path_part)?;
    if decoded.len() >= 3
        && decoded.starts_with('/')
        && decoded.as_bytes()[1].is_ascii_alphabetic()
        && decoded.as_bytes()[2] == b':'
    {
        return Ok(decoded[1..].to_string());
    }
    Ok(decoded)
}

fn home_dir() -> Option<String> {
    env::var("HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env::var("USERPROFILE")
                .ok()
                .filter(|value| !value.is_empty())
        })
}

fn expand_tilde(raw: &str) -> Result<String, String> {
    if raw == "~" {
        return home_dir().ok_or_else(|| "Home directory is unknown.".to_string());
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        let home = home_dir().ok_or_else(|| "Home directory is unknown.".to_string())?;
        return Ok(format!("{}/{}", home.trim_end_matches(['/', '\\']), rest));
    }
    Ok(raw.to_string())
}

fn parse_local_path_input(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Path is empty.".to_string());
    }
    if trimmed.chars().any(|character| character.is_control()) {
        return Err("Path contains invalid characters.".to_string());
    }

    let without_file = if trimmed
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        decode_file_url(trimmed)?
    } else {
        trimmed.to_string()
    };
    let expanded = expand_tilde(&without_file)?;
    let path = PathBuf::from(expanded);
    if !path.is_absolute() {
        return Err("FalconDeck can only open absolute local paths.".to_string());
    }
    Ok(path)
}

fn resolve_existing_local_path(raw: &str) -> Result<PathBuf, String> {
    let path = parse_local_path_input(raw)?;
    let metadata = fs::metadata(&path).map_err(|_| missing_local_path_error())?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("FalconDeck can only open files and folders.".to_string());
    }
    Ok(path.canonicalize().unwrap_or(path))
}

#[tauri::command]
fn open_local_path(path: String) -> Result<(), String> {
    let resolved = resolve_existing_local_path(&path)?;
    open::that_detached(&resolved).map_err(|error| error.to_string())
}

fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg("-R")
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Finder could not reveal that path.".to_string())
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Explorer could not reveal that path.".to_string())
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = path.parent().unwrap_or(path);
        open::that_detached(parent).map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn reveal_local_path(path: String) -> Result<(), String> {
    let resolved = resolve_existing_local_path(&path)?;
    reveal_in_file_manager(&resolved)
}

/// Editors the transcript's path menu can hand a path to, most common first.
/// `id` crosses the bridge; the platform opener resolves it per OS.
const EDITOR_CANDIDATES: &[(&str, &str)] = &[
    ("zed", "Zed"),
    ("vscode", "VS Code"),
    ("cursor", "Cursor"),
    ("windsurf", "Windsurf"),
    ("sublime", "Sublime Text"),
];

#[derive(Serialize)]
struct InstalledEditor {
    id: String,
    name: String,
}

#[cfg(target_os = "macos")]
fn editor_app_name(editor: &str) -> Option<&'static str> {
    match editor {
        "zed" => Some("Zed"),
        "vscode" => Some("Visual Studio Code"),
        "cursor" => Some("Cursor"),
        "windsurf" => Some("Windsurf"),
        "sublime" => Some("Sublime Text"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn editor_installed(editor: &str) -> bool {
    let Some(app) = editor_app_name(editor) else {
        return false;
    };
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home_dir() {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots
        .iter()
        .any(|root| root.join(format!("{app}.app")).exists())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn editor_binary(editor: &str) -> Option<&'static str> {
    match editor {
        "zed" => Some("zed"),
        "vscode" => Some("code"),
        "cursor" => Some("cursor"),
        "windsurf" => Some("windsurf"),
        "sublime" => Some("subl"),
        _ => None,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn editor_installed(editor: &str) -> bool {
    let Some(binary) = editor_binary(editor) else {
        return false;
    };
    env::var("PATH")
        .ok()
        .map(|search| env::split_paths(&search).any(|dir| dir.join(binary).exists()))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn editor_executable(editor: &str) -> Option<PathBuf> {
    let local = env::var("LOCALAPPDATA").ok()?;
    let programs = PathBuf::from(local).join("Programs");
    let executable = match editor {
        "zed" => programs.join(r"Zed\Zed.exe"),
        "vscode" => programs.join(r"Microsoft VS Code\Code.exe"),
        "cursor" => programs.join(r"cursor\Cursor.exe"),
        "windsurf" => programs.join(r"windsurf\Windsurf.exe"),
        _ => return None,
    };
    Some(executable)
}

#[cfg(target_os = "windows")]
fn editor_installed(editor: &str) -> bool {
    editor_executable(editor).is_some_and(|path| path.exists())
}

#[tauri::command]
fn list_installed_editors() -> Vec<InstalledEditor> {
    EDITOR_CANDIDATES
        .iter()
        .filter(|(id, _)| editor_installed(id))
        .map(|(id, name)| InstalledEditor {
            id: (*id).to_string(),
            name: (*name).to_string(),
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn open_path_in_editor(resolved: &Path, editor: &str) -> Result<(), String> {
    let app = editor_app_name(editor).ok_or_else(|| "Unknown editor.".to_string())?;
    let status = Command::new("open")
        .arg("-a")
        .arg(app)
        .arg(resolved)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{app} could not open that path."))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_path_in_editor(resolved: &Path, editor: &str) -> Result<(), String> {
    let binary = editor_binary(editor).ok_or_else(|| "Unknown editor.".to_string())?;
    Command::new(binary)
        .arg(resolved)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn open_path_in_editor(resolved: &Path, editor: &str) -> Result<(), String> {
    let executable = editor_executable(editor).ok_or_else(|| "Unknown editor.".to_string())?;
    Command::new(executable)
        .arg(resolved)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_path_with_editor(path: String, editor: String) -> Result<(), String> {
    let resolved = resolve_existing_local_path(&path)?;
    open_path_in_editor(&resolved, &editor)
}

/// "file" or "directory" for existing paths, None otherwise. The transcript
/// menu uses this to decide which file-only actions to offer.
#[tauri::command]
fn local_path_kind(path: String) -> Result<Option<&'static str>, String> {
    let parsed = parse_local_path_input(&path)?;
    let Ok(metadata) = fs::metadata(&parsed) else {
        return Ok(None);
    };
    if metadata.is_file() {
        Ok(Some("file"))
    } else if metadata.is_dir() {
        Ok(Some("directory"))
    } else {
        Ok(None)
    }
}

/// Clipboard copy only carries text, so cap the size and refuse anything that
/// is not UTF-8 before it reaches the webview.
const COPY_CONTENTS_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn read_text_file_contents(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|_| missing_local_path_error())?;
    if !metadata.is_file() {
        return Err("Only file contents can be copied, not folders.".to_string());
    }
    if metadata.len() > COPY_CONTENTS_MAX_BYTES {
        return Err("File is too large to copy (limit is 2 MB).".to_string());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.contains(&0) {
        return Err("Binary file contents cannot be copied as text.".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text.".to_string())
}

#[tauri::command]
fn read_local_text_file(path: String) -> Result<String, String> {
    let resolved = resolve_existing_local_path(&path)?;
    read_text_file_contents(&resolved)
}

#[tauri::command]
fn copy_local_file(source: String, dest: String) -> Result<(), String> {
    let resolved_source = resolve_existing_local_path(&source)?;
    if !resolved_source.is_file() {
        return Err("Only files can be saved to a new location.".to_string());
    }
    let resolved_dest = parse_local_path_input(&dest)?;
    if resolved_dest == resolved_source {
        return Err("Choose a different save location.".to_string());
    }
    if resolved_dest.is_dir() {
        return Err("That location is a folder. Pick a file name.".to_string());
    }
    fs::copy(&resolved_source, &resolved_dest)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Open (or re-focus) the detached Activity window.
///
/// Built here rather than from JS so the label, chrome, and size stay in one
/// place with the main window's, and so the capability list — which is keyed
/// by label — is the only thing gating it.
#[tauri::command]
fn open_activity_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) {
        // Already popped out, on whichever display the user left it.
        window.unminimize().ok();
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        ACTIVITY_WINDOW_LABEL,
        tauri::WebviewUrl::App("activity-window.html".into()),
    )
    .title("FalconDeck Activity")
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true)
    .background_color(tauri::window::Color(9, 9, 11, 255))
    .inner_size(1080.0, 900.0)
    .min_inner_size(560.0, 420.0)
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// Raise the main window. The Activity window hands threads off to it, so the
/// handoff has to bring the window forward too — otherwise the thread opens
/// behind whatever the user is looking at.
#[tauri::command]
fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("FalconDeck's main window is not open.".to_string());
    };
    window.unminimize().ok();
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub fn run() {
    // The updater enables rustls' Ring provider while the daemon enables
    // AWS-LC. With both compiled, rustls deliberately refuses to guess and
    // otherwise panics on the first TLS use — including the MCP server's
    // HTTP client, so this must precede the early-exit branch below.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    // The embedded daemon injects built-in connectors with this executable as
    // their command. Dispatch every reserved helper before constructing Tauri
    // so an omitted helper branch can never recursively launch desktop apps.
    let first_arg = std::env::args_os().nth(1);
    if let Some(helper) = falcondeck_daemon::stdio_helper::from_first_arg(first_arg.as_deref()) {
        let exit_code =
            tauri::async_runtime::block_on(falcondeck_daemon::stdio_helper::run(helper));
        std::process::exit(exit_code);
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(DesktopState::default())
        .on_page_load(|webview, payload| {
            eprintln!(
                "FalconDeck webview '{}' page {:?}: {}",
                webview.label(),
                payload.event(),
                payload.url()
            );
        })
        .on_web_content_process_terminate(|webview| {
            eprintln!(
                "FalconDeck webview '{}' content process terminated",
                webview.label()
            );
        })
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .map_err(|error| error.to_string())?;

            dictation::initialize(app.handle());
            dictation::create_overlay_window(app.handle())?;

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
            open_external_url,
            open_local_path,
            reveal_local_path,
            list_installed_editors,
            open_path_with_editor,
            local_path_kind,
            read_local_text_file,
            copy_local_file,
            open_activity_window,
            focus_main_window,
            desktop_notifications::macos_notification_permission_state,
            desktop_notifications::request_macos_notification_permission,
            desktop_notifications::send_macos_notification,
            dictation::configure_dictation,
            dictation::dictation_audio_devices,
            dictation::dictation_permission_status,
            dictation::request_dictation_permission,
            dictation::start_dictation,
            dictation::stop_dictation,
            dictation::cancel_dictation,
            dictation::retry_dictation,
            dictation::discard_dictation,
            dictation::last_dictation_transcript,
            dictation::copy_dictation_transcript,
            dictation::dictation_history,
            dictation::dictation_history_retry,
            dictation::dictation_history_delete,
            dictation::dictation_history_clear,
            dictation::open_dictation_accessibility_settings
        ])
        .build(tauri::generate_context!())
        .expect("failed to build FalconDeck desktop");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if cfg!(debug_assertions) || code.is_some() {
                return;
            }

            let state = app_handle.state::<DesktopState>();
            let active_thread_count = tauri::async_runtime::block_on(active_thread_count(&state));
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
        RunEvent::Exit if !cfg!(debug_assertions) => {
            dictation::shutdown();
            let state = app_handle.state::<DesktopState>();
            tauri::async_runtime::block_on(async move { shutdown_embedded_daemon(state).await });
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{
        decode_file_url, expand_tilde, parse_local_path_input, quit_warning_message,
        resolve_existing_local_path,
    };
    use std::{env, fs};

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

    #[test]
    fn file_url_decodes_percent_encoding() {
        assert_eq!(
            decode_file_url("file:///Users/James/My%20File.mp4").unwrap(),
            "/Users/James/My File.mp4"
        );
        assert_eq!(
            decode_file_url("file://localhost/Users/James/clip.mp4").unwrap(),
            "/Users/James/clip.mp4"
        );
    }

    #[test]
    fn file_url_rejects_remote_hosts() {
        assert!(decode_file_url("file://evil.example/Users/foo").is_err());
    }

    #[test]
    fn tilde_expands_to_home() {
        let previous = env::var("HOME").ok();
        env::set_var("HOME", "/Users/qa");
        let expanded = expand_tilde("~/Desktop/clip.mp4").unwrap();
        match previous {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        assert_eq!(expanded, "/Users/qa/Desktop/clip.mp4");
    }

    #[test]
    fn relative_paths_are_rejected() {
        assert!(parse_local_path_input("src/App.tsx").is_err());
        assert!(parse_local_path_input("kitchen.mp4").is_err());
    }

    #[test]
    fn missing_paths_are_rejected() {
        assert!(
            resolve_existing_local_path("/tmp/falcondeck-missing-local-path-test")
                .unwrap_err()
                .contains("not on this")
        );
    }

    #[test]
    fn existing_temp_file_resolves() {
        let path = env::temp_dir().join("falcondeck-local-path-open-test.txt");
        fs::write(&path, "ok").unwrap();
        let resolved = resolve_existing_local_path(&path.display().to_string()).unwrap();
        let _ = fs::remove_file(&path);
        assert!(resolved.ends_with("falcondeck-local-path-open-test.txt"));
    }

    #[test]
    fn text_file_contents_round_trip() {
        let path = env::temp_dir().join("falcondeck-copy-contents-test.txt");
        fs::write(&path, "hello falcondeck\n").unwrap();
        let contents = super::read_text_file_contents(&path).unwrap();
        let _ = fs::remove_file(&path);
        assert_eq!(contents, "hello falcondeck\n");
    }

    #[test]
    fn binary_file_contents_are_rejected() {
        let path = env::temp_dir().join("falcondeck-copy-contents-test.bin");
        fs::write(&path, [0x89, b'P', 0x4e, 0x00, 0x47]).unwrap();
        let error = super::read_text_file_contents(&path).unwrap_err();
        let _ = fs::remove_file(&path);
        assert!(error.contains("Binary"));
    }

    #[test]
    fn oversized_file_contents_are_rejected() {
        let path = env::temp_dir().join("falcondeck-copy-contents-test-big.txt");
        fs::write(
            &path,
            vec![b'a'; super::COPY_CONTENTS_MAX_BYTES as usize + 1],
        )
        .unwrap();
        let error = super::read_text_file_contents(&path).unwrap_err();
        let _ = fs::remove_file(&path);
        assert!(error.contains("too large"));
    }

    #[test]
    fn local_path_kind_reports_files_and_directories() {
        let file = env::temp_dir().join("falcondeck-path-kind-test.txt");
        fs::write(&file, "x").unwrap();
        let dir = env::temp_dir().join("falcondeck-path-kind-test-dir");
        fs::create_dir_all(&dir).unwrap();
        let file_kind = super::local_path_kind(file.display().to_string()).unwrap();
        let dir_kind = super::local_path_kind(dir.display().to_string()).unwrap();
        let missing_kind =
            super::local_path_kind("/tmp/falcondeck-path-kind-missing".to_string()).unwrap();
        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(file_kind.as_deref(), Some("file"));
        assert_eq!(dir_kind.as_deref(), Some("directory"));
        assert_eq!(missing_kind, None);
    }
}
