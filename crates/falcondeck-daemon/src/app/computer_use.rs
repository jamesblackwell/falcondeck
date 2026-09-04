//! Embedded cua-driver supervisor.
//!
//! The packaged desktop app runs this daemon in-process, so a child spawned
//! here is a direct child of FalconDeck.app and inherits its Accessibility
//! and Screen Recording grants. Headless `falcondeck-daemon` leaves
//! `computer_use_bin` unset and never starts the driver.

use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use falcondeck_core::{
    ComputerUseHealth, ComputerUseHealthCheck, ComputerUsePermissions, ComputerUsePreferences,
    ComputerUseSettingsUpdate, ComputerUseStatus, ComputerUseTestResult,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStdin, Command},
    time::timeout,
};

use super::AppState;
use crate::error::DaemonError;

/// Bundle id FalconDeck.app presents to TCC and to `health_report`.
pub const HOST_BUNDLE_ID: &str = "com.falcondeck.desktop";
/// Release pin. Binary and skill pack must stay on this tag.
pub const PINNED_DRIVER_VERSION: &str = "0.23.2";
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const HEALTH_INCLUDE: &[&str] = &[
    "bundle_identity",
    "tcc_accessibility",
    "tcc_screen_recording",
    "ax_capability",
    "screen_capture_capability",
];
const ENV_ALLOWLIST: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG",
];
const MAX_THUMBNAIL_BYTES: u64 = 80_000;

/// Long-lived `cua-driver serve --embedded` child, if this daemon is allowed
/// to run one.
pub struct ComputerUseHost {
    binary: Option<PathBuf>,
    state_dir: PathBuf,
    inner: tokio::sync::Mutex<HostInner>,
}

#[derive(Default)]
struct HostInner {
    generation: u64,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    socket_path: Option<PathBuf>,
    last_health: Option<ComputerUseHealth>,
    last_error: Option<String>,
    telemetry: bool,
    overlay: bool,
}

impl ComputerUseHost {
    pub fn new(binary: Option<String>, state_path: &Path) -> Self {
        let binary = binary
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let state_dir = state_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        Self {
            binary,
            state_dir,
            inner: tokio::sync::Mutex::new(HostInner::default()),
        }
    }

    pub fn available(&self) -> bool {
        macos_ok() && self.binary_present()
    }

    pub fn binary_present(&self) -> bool {
        self.binary.as_ref().is_some_and(|path| path.is_file())
    }

    pub async fn stop(&self) {
        let mut inner = self.inner.lock().await;
        stop_locked(&mut inner).await;
    }

    pub async fn restart(
        &self,
        prefs: &ComputerUsePreferences,
    ) -> Result<Option<ComputerUseConnector>, String> {
        {
            let mut inner = self.inner.lock().await;
            stop_locked(&mut inner).await;
        }
        if !prefs.enabled {
            return Ok(None);
        }
        self.start_if_needed(prefs).await
    }

    /// Starts the driver when computer use is enabled, available, and the
    /// child reports both TCC grants. Coalesces concurrent callers onto one
    /// generation. Reaps a dead child instead of handing out a stale socket.
    pub async fn ensure_ready(
        &self,
        prefs: &ComputerUsePreferences,
    ) -> Result<Option<ComputerUseConnector>, String> {
        if !prefs.enabled {
            return Ok(None);
        }
        self.start_if_needed(prefs).await
    }

    async fn start_if_needed(
        &self,
        prefs: &ComputerUsePreferences,
    ) -> Result<Option<ComputerUseConnector>, String> {
        if !self.available() {
            return Ok(None);
        }
        let mut inner = self.inner.lock().await;
        let binary = self.binary.as_ref().ok_or("cua-driver binary missing")?;
        reap_dead_child(&mut inner);
        let settings_match = inner.telemetry == prefs.telemetry && inner.overlay == prefs.overlay;
        if inner.child.is_some() && settings_match {
            if let Some(socket) = inner.socket_path.clone() {
                if socket_is_live(&socket) {
                    if inner.last_health.as_ref().is_some_and(tcc_grants_ok) {
                        return Ok(connector_from(&inner, binary));
                    }
                    match probe_health(binary, &socket).await {
                        Ok(health) => {
                            let ok = tcc_grants_ok(&health);
                            inner.last_health = Some(health);
                            inner.last_error = None;
                            if ok {
                                return Ok(connector_from(&inner, binary));
                            }
                            return Ok(None);
                        }
                        Err(_) => stop_locked(&mut inner).await,
                    }
                } else {
                    stop_locked(&mut inner).await;
                }
            }
        } else if inner.child.is_some() {
            stop_locked(&mut inner).await;
        }
        start_locked(&mut inner, binary, &self.state_dir, prefs).await?;
        if inner.last_health.as_ref().is_some_and(tcc_grants_ok) {
            Ok(connector_from(&inner, binary))
        } else {
            let error = inner
                .last_error
                .clone()
                .unwrap_or_else(|| "computer-use driver is not healthy".to_string());
            stop_locked(&mut inner).await;
            inner.last_error = Some(error.clone());
            Err(error)
        }
    }

    pub async fn snapshot(
        &self,
        prefs: &ComputerUsePreferences,
        available: bool,
    ) -> ComputerUseStatus {
        let mut inner = self.inner.lock().await;
        reap_dead_child(&mut inner);
        let health = inner.last_health.clone();
        ComputerUseStatus {
            available,
            enabled: prefs.enabled,
            macos_ok: macos_ok(),
            binary_present: self.binary_present(),
            permissions: current_permissions(),
            driver_version: health
                .as_ref()
                .and_then(|health| health.driver_version.clone())
                .or_else(|| {
                    self.binary_present()
                        .then(|| PINNED_DRIVER_VERSION.to_string())
                }),
            generation: (inner.generation > 0).then_some(inner.generation),
            health,
            telemetry: prefs.telemetry,
            overlay: prefs.overlay,
            running: inner.child.is_some(),
            last_error: inner.last_error.clone(),
        }
    }

    pub async fn test(
        &self,
        prefs: &ComputerUsePreferences,
    ) -> Result<ComputerUseTestResult, String> {
        if !prefs.enabled {
            return Err("Turn on computer use before testing it.".to_string());
        }
        let connector = self
            .start_if_needed(prefs)
            .await?
            .ok_or_else(|| missing_test_reason())?;
        let binary = self.binary.as_ref().ok_or("cua-driver binary missing")?;
        let health = probe_health(binary, &connector.socket_path).await?;
        {
            let mut inner = self.inner.lock().await;
            inner.last_health = Some(health.clone());
            inner.last_error = None;
        }
        let capture_dir = self.state_dir.join("computer-use");
        let capture = capture_test_thumbnail(binary, &connector.socket_path, &capture_dir).await;
        let (thumbnail_data_url, black_frame, capture_error) = match capture {
            Ok(shot) => (shot.thumbnail_data_url, shot.black_frame, None),
            Err(error) => (None, false, Some(error)),
        };
        let tcc_ok = tcc_grants_ok(&health);
        Ok(ComputerUseTestResult {
            ok: tcc_ok && thumbnail_data_url.is_some(),
            health: Some(health),
            thumbnail_data_url,
            error: capture_error,
            black_frame,
        })
    }
}

/// MCP proxy invocation the host hands to every harness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseConnector {
    pub binary: PathBuf,
    pub socket_path: PathBuf,
}

#[cfg(test)]
pub fn mcp_args(socket_path: &Path) -> Vec<String> {
    vec![
        "mcp".to_string(),
        "--embedded".to_string(),
        "--socket".to_string(),
        socket_path.display().to_string(),
        "--host-bundle-id".to_string(),
        HOST_BUNDLE_ID.to_string(),
    ]
}

pub fn serve_args(socket_path: &Path, overlay: bool) -> Vec<String> {
    let mut args = vec![
        "serve".to_string(),
        "--embedded".to_string(),
        "--parent-liveness-stdio".to_string(),
        "--no-permissions-gate".to_string(),
        "--socket".to_string(),
        socket_path.display().to_string(),
        "--host-bundle-id".to_string(),
        HOST_BUNDLE_ID.to_string(),
        "--permission-mode".to_string(),
        "standard".to_string(),
    ];
    if !overlay {
        args.push("--no-overlay".to_string());
    }
    args
}

pub fn serve_env(telemetry: bool) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for key in ENV_ALLOWLIST {
        if let Ok(value) = std::env::var(key) {
            env.insert((*key).to_string(), value);
        }
    }
    for (key, value) in std::env::vars() {
        if key.starts_with("LC_") {
            env.insert(key, value);
        }
    }
    env.insert("CUA_DRIVER_EMBEDDED".to_string(), "1".to_string());
    env.insert(
        "CUA_DRIVER_HOST_BUNDLE_ID".to_string(),
        HOST_BUNDLE_ID.to_string(),
    );
    env.insert(
        "CUA_DRIVER_EMBEDDED_HOST_PID".to_string(),
        std::process::id().to_string(),
    );
    env.insert(
        "CUA_DRIVER_RS_UPDATE_CHECK".to_string(),
        "false".to_string(),
    );
    env.insert(
        "CUA_DRIVER_RS_TELEMETRY_ENABLED".to_string(),
        if telemetry { "true" } else { "false" }.to_string(),
    );
    env
}

pub fn parse_health_report(stdout: &str) -> Option<ComputerUseHealth> {
    let value = find_json_object(stdout)?;
    let report = value
        .get("structuredContent")
        .cloned()
        .filter(|candidate| candidate.get("overall").is_some() || candidate.get("checks").is_some())
        .unwrap_or(value);
    let overall = report
        .get("overall")
        .and_then(|value| value.as_str())
        .unwrap_or("failed")
        .to_string();
    let driver_version = report
        .get("driver_version")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let checks = report
        .get("checks")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|check| {
            Some(ComputerUseHealthCheck {
                name: check.get("name")?.as_str()?.to_string(),
                status: check
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("fail")
                    .to_string(),
                message: check
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                hint: check
                    .get("hint")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            })
        })
        .collect();
    Some(ComputerUseHealth {
        overall,
        driver_version,
        checks,
    })
}

pub fn tcc_grants_ok(health: &ComputerUseHealth) -> bool {
    check_passed(health, "tcc_accessibility") && check_passed(health, "tcc_screen_recording")
}

pub fn current_permissions() -> ComputerUsePermissions {
    ComputerUsePermissions {
        accessibility: accessibility_granted(),
        screen_recording: screen_recording_granted(),
    }
}

pub fn macos_ok() -> bool {
    macos_major().is_some_and(|major| major >= 14)
}

fn check_passed(health: &ComputerUseHealth, name: &str) -> bool {
    health
        .checks
        .iter()
        .find(|check| check.name == name)
        .is_some_and(|check| check.status == "pass")
}

fn connector_from(inner: &HostInner, binary: &Path) -> Option<ComputerUseConnector> {
    Some(ComputerUseConnector {
        binary: binary.to_path_buf(),
        socket_path: inner.socket_path.clone()?,
    })
}

async fn start_locked(
    inner: &mut HostInner,
    binary: &Path,
    state_dir: &Path,
    prefs: &ComputerUsePreferences,
) -> Result<(), String> {
    inner.generation = inner.generation.saturating_add(1);
    let socket_dir = state_dir.join("computer-use");
    tokio::fs::create_dir_all(&socket_dir)
        .await
        .map_err(|error| format!("failed to create computer-use directory: {error}"))?;
    let socket_path = socket_dir.join(format!(
        "cua-{}-{}.sock",
        std::process::id(),
        inner.generation
    ));
    prepare_endpoint(&socket_path).map_err(|error| error.to_string())?;

    let mut command = Command::new(binary);
    command
        .args(serve_args(&socket_path, prefs.overlay))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_clear();
    for (key, value) in serve_env(prefs.telemetry) {
        command.env(key, value);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start cua-driver: {error}"))?;
    let stdin = child.stdin.take();
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(target: "cua-driver", "{line}");
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(target: "cua-driver", "{line}");
            }
        });
    }

    inner.child = Some(child);
    inner.stdin = stdin;
    inner.socket_path = Some(socket_path.clone());
    inner.telemetry = prefs.telemetry;
    inner.overlay = prefs.overlay;

    match wait_until_ready(binary, &socket_path).await {
        Ok(health) => {
            if !check_passed(&health, "bundle_identity") {
                tracing::warn!(
                    "cua-driver bundle_identity did not pass; TCC still follows FalconDeck.app if it is the responsible process"
                );
            }
            inner.last_health = Some(health);
            inner.last_error = None;
            Ok(())
        }
        Err(error) => {
            stop_locked(inner).await;
            inner.last_error = Some(error.clone());
            Err(error)
        }
    }
}

async fn stop_locked(inner: &mut HostInner) {
    inner.stdin.take();
    if let Some(mut child) = inner.child.take() {
        let _ = child.start_kill();
        let _ = timeout(STOP_TIMEOUT, child.wait()).await;
    }
    if let Some(socket) = inner.socket_path.take() {
        let _ = tokio::fs::remove_file(socket).await;
    }
}

async fn wait_until_ready(binary: &Path, socket_path: &Path) -> Result<ComputerUseHealth, String> {
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if socket_path.exists() {
            match probe_health(binary, socket_path).await {
                Ok(health) => return Ok(health),
                Err(error) if tokio::time::Instant::now() >= deadline => return Err(error),
                Err(_) => {}
            }
        } else if tokio::time::Instant::now() >= deadline {
            return Err("cua-driver did not create its socket in time".to_string());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn probe_health(binary: &Path, socket_path: &Path) -> Result<ComputerUseHealth, String> {
    let payload = serde_json::json!({ "include": HEALTH_INCLUDE });
    let (stdout, stderr) = call_tool(
        binary,
        socket_path,
        "health_report",
        payload,
        Duration::from_secs(8),
    )
    .await?;
    parse_health_report(&stdout).ok_or_else(|| {
        format!(
            "cua-driver health_report returned unreadable output: {} {}",
            stdout.trim(),
            stderr.trim()
        )
    })
}

async fn call_tool(
    binary: &Path,
    socket_path: &Path,
    tool: &str,
    payload: serde_json::Value,
    limit: Duration,
) -> Result<(String, String), String> {
    let output = timeout(
        limit,
        Command::new(binary)
            .args([
                "call".to_string(),
                tool.to_string(),
                payload.to_string(),
                "--socket".to_string(),
                socket_path.display().to_string(),
            ])
            .env_clear()
            .env("CUA_DRIVER_EMBEDDED", "1")
            .env("CUA_DRIVER_RS_UPDATE_CHECK", "false")
            .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "false")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| format!("cua-driver {tool} timed out"))?
    .map_err(|error| format!("failed to run {tool}: {error}"))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

struct CapturedThumbnail {
    thumbnail_data_url: Option<String>,
    black_frame: bool,
}

async fn capture_test_thumbnail(
    binary: &Path,
    socket_path: &Path,
    capture_dir: &Path,
) -> Result<CapturedThumbnail, String> {
    tokio::fs::create_dir_all(capture_dir)
        .await
        .map_err(|error| error.to_string())?;
    let capture_path = capture_dir.join("test-capture.png");
    let _ = tokio::fs::remove_file(&capture_path).await;
    let window_error = capture_window_png(binary, socket_path, &capture_path)
        .await
        .err();
    if !capture_path.is_file() {
        let desktop_error = capture_desktop_png(binary, socket_path, &capture_path)
            .await
            .err();
        if !capture_path.is_file() {
            return Err(window_error
                .or(desktop_error)
                .unwrap_or_else(|| "cua-driver did not write a test screenshot".to_string()));
        }
    }
    let thumbnail = thumbnail_data_url(&capture_path).await;
    let black_frame = thumbnail.as_ref().is_some_and(|url| url.len() < 800)
        || tokio::fs::metadata(&capture_path)
            .await
            .map(|meta| meta.len() < 400)
            .unwrap_or(false);
    let _ = tokio::fs::remove_file(&capture_path).await;
    let _ = tokio::fs::remove_file(capture_path.with_extension("jpg")).await;
    Ok(CapturedThumbnail {
        thumbnail_data_url: thumbnail,
        black_frame,
    })
}

async fn capture_window_png(
    binary: &Path,
    socket_path: &Path,
    capture_path: &Path,
) -> Result<(), String> {
    let host_pid = std::process::id();
    let (list_stdout, _list_stderr) = call_tool(
        binary,
        socket_path,
        "list_windows",
        serde_json::json!({ "pid": host_pid }),
        Duration::from_secs(8),
    )
    .await?;
    let mut windows = parse_list_windows(&list_stdout);
    if windows.is_empty() {
        let (all_stdout, all_stderr) = call_tool(
            binary,
            socket_path,
            "list_windows",
            serde_json::json!({}),
            Duration::from_secs(8),
        )
        .await?;
        windows = parse_list_windows(&all_stdout);
        if windows.is_empty() {
            return Err(format!(
                "cua-driver list_windows returned no windows: {} {}",
                all_stdout.trim(),
                all_stderr.trim()
            ));
        }
    }
    let Some(window) = pick_test_window(&windows, host_pid)
        .filter(|window| window.is_on_screen && window.on_current_space)
    else {
        return Err("FalconDeck has no on-screen window on this Space.".to_string());
    };
    let payload = serde_json::json!({
        "pid": window.pid.unwrap_or(host_pid as i64),
        "window_id": window.window_id,
        "screenshot_out_file": capture_path.display().to_string(),
        "max_elements": 1,
    });
    let (stdout, stderr) = call_tool(
        binary,
        socket_path,
        "get_window_state",
        payload,
        Duration::from_secs(12),
    )
    .await?;
    if capture_path.is_file() {
        Ok(())
    } else {
        Err(format!(
            "cua-driver did not write a window screenshot: {} {}",
            stdout.trim(),
            stderr.trim()
        ))
    }
}

async fn capture_desktop_png(
    binary: &Path,
    socket_path: &Path,
    capture_path: &Path,
) -> Result<(), String> {
    let (stdout, stderr) = call_tool(
        binary,
        socket_path,
        "get_desktop_state",
        serde_json::json!({
            "screenshot_out_file": capture_path.display().to_string(),
        }),
        Duration::from_secs(12),
    )
    .await?;
    if capture_path.is_file() {
        Ok(())
    } else {
        Err(format!(
            "cua-driver did not write a desktop screenshot: {} {}",
            stdout.trim(),
            stderr.trim()
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ListedWindow {
    window_id: i64,
    pid: Option<i64>,
    app_name: Option<String>,
    is_on_screen: bool,
    on_current_space: bool,
    z_index: Option<i64>,
}

fn parse_list_windows(stdout: &str) -> Vec<ListedWindow> {
    let value = match find_json_object(stdout) {
        Some(value) => value,
        None => return Vec::new(),
    };
    let report = value.get("structuredContent").cloned().unwrap_or(value);
    let rows = report
        .get("windows")
        .and_then(serde_json::Value::as_array)
        .or_else(|| report.as_array())
        .cloned()
        .unwrap_or_default();
    rows.iter().filter_map(parse_listed_window).collect()
}

fn parse_listed_window(value: &serde_json::Value) -> Option<ListedWindow> {
    Some(ListedWindow {
        window_id: json_i64(value, &["window_id", "windowId"])?,
        pid: json_i64(value, &["pid"]),
        app_name: value
            .get("app_name")
            .or_else(|| value.get("appName"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        is_on_screen: value
            .get("is_on_screen")
            .or_else(|| value.get("isOnScreen"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        on_current_space: value
            .get("on_current_space")
            .or_else(|| value.get("onCurrentSpace"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        z_index: json_i64(value, &["z_index", "zIndex"]),
    })
}

fn json_i64(value: &serde_json::Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|candidate| {
            candidate
                .as_i64()
                .or_else(|| candidate.as_u64().map(|number| number as i64))
        })
    })
}

fn pick_test_window(windows: &[ListedWindow], host_pid: u32) -> Option<&ListedWindow> {
    let host_pid = host_pid as i64;
    let matching: Vec<&ListedWindow> = windows
        .iter()
        .filter(|window| window.pid == Some(host_pid))
        .collect();
    let named: Vec<&ListedWindow> = windows
        .iter()
        .filter(|window| {
            window
                .app_name
                .as_deref()
                .is_some_and(|name| name.to_ascii_lowercase().contains("falcondeck"))
        })
        .collect();
    let pool = if !matching.is_empty() {
        matching
    } else if !named.is_empty() {
        named
    } else {
        return None;
    };
    pool.into_iter().max_by_key(|window| {
        (
            window.is_on_screen,
            window.on_current_space,
            window.z_index.unwrap_or(i64::MIN),
        )
    })
}

async fn thumbnail_data_url(capture_path: &Path) -> Option<String> {
    let thumb_path = capture_path.with_extension("jpg");
    #[cfg(target_os = "macos")]
    {
        let scaled = timeout(
            Duration::from_secs(4),
            Command::new("sips")
                .args([
                    "-Z",
                    "320",
                    "-s",
                    "format",
                    "jpeg",
                    "-s",
                    "formatOptions",
                    "60",
                    capture_path.to_str()?,
                    "--out",
                    thumb_path.to_str()?,
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status(),
        )
        .await
        .ok()?
        .ok()?;
        if !scaled.success() {
            return None;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = tokio::fs::copy(capture_path, &thumb_path).await.ok()?;
    }
    let bytes = tokio::fs::read(&thumb_path).await.ok()?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_THUMBNAIL_BYTES {
        return None;
    }
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
    ))
}

fn reap_dead_child(inner: &mut HostInner) {
    let dead = match inner.child.as_mut() {
        Some(child) => !matches!(child.try_wait(), Ok(None)),
        None => false,
    };
    if dead {
        inner.child = None;
        inner.stdin = None;
    }
}

fn socket_is_live(path: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(path).is_ok()
    }
    #[cfg(not(unix))]
    {
        path.exists()
    }
}

fn prepare_endpoint(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("computer-use socket {} is live", path.display()),
            ));
        }
    }
    std::fs::remove_file(path)
}

fn find_json_object(text: &str) -> Option<serde_json::Value> {
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                return Some(value);
            }
        }
    }
    let start = text.find('{')?;
    serde_json::from_str(&text[start..]).ok()
}

fn missing_test_reason() -> String {
    let grants = current_permissions();
    if !macos_ok() {
        "Computer use needs macOS 14 or later.".to_string()
    } else if !grants.accessibility || !grants.screen_recording {
        "Grant Accessibility and Screen Recording to FalconDeck first.".to_string()
    } else {
        "Computer use is not available on this host.".to_string()
    }
}

#[cfg(target_os = "macos")]
fn macos_major() -> Option<u32> {
    let mut buf = [0u8; 32];
    let mut size = buf.len();
    let rc = unsafe {
        libc::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size == 0 {
        return None;
    }
    let end = buf[..size.min(buf.len())]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(size.min(buf.len()));
    let version = std::str::from_utf8(&buf[..end]).ok()?;
    version.split('.').next()?.parse().ok()
}

#[cfg(not(target_os = "macos"))]
fn macos_major() -> Option<u32> {
    None
}

#[cfg(target_os = "macos")]
fn accessibility_granted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_granted() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn screen_recording_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
fn screen_recording_granted() -> bool {
    false
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

impl AppState {
    pub async fn computer_use_status(&self) -> ComputerUseStatus {
        let prefs = self.inner.preferences.lock().await.computer_use.clone();
        self.inner
            .computer_use
            .snapshot(&prefs, self.inner.daemon.capabilities.computer_use)
            .await
    }

    pub async fn update_computer_use(
        &self,
        update: ComputerUseSettingsUpdate,
    ) -> Result<ComputerUseStatus, DaemonError> {
        let (prefs, restart, updated) = {
            let preferences = self.inner.preferences.lock().await;
            let previous = preferences.computer_use.clone();
            let mut next = preferences.clone();
            if let Some(enabled) = update.enabled {
                next.computer_use.enabled = enabled;
            }
            if let Some(telemetry) = update.telemetry {
                next.computer_use.telemetry = telemetry;
            }
            if let Some(overlay) = update.overlay {
                next.computer_use.overlay = overlay;
            }
            let prefs = next.computer_use.clone();
            let restart = previous.telemetry != prefs.telemetry
                || previous.overlay != prefs.overlay
                || (previous.enabled && !prefs.enabled);
            (prefs, restart, next)
        };
        super::storage::persist_preferences(&self.inner.preferences_path, &updated).await?;
        {
            let mut preferences = self.inner.preferences.lock().await;
            *preferences = updated;
        }
        if restart {
            if prefs.enabled {
                if let Err(error) = self.inner.computer_use.restart(&prefs).await {
                    tracing::warn!(%error, "failed to restart the computer-use driver");
                }
            } else {
                self.inner.computer_use.stop().await;
            }
        }
        let status = self
            .inner
            .computer_use
            .snapshot(&prefs, self.inner.daemon.capabilities.computer_use)
            .await;
        self.emit(
            None,
            None,
            falcondeck_core::UnifiedEvent::PreferencesUpdated {
                preferences: self.inner.preferences.lock().await.clone(),
            },
        );
        Ok(status)
    }

    pub async fn restart_computer_use(&self) -> Result<ComputerUseStatus, DaemonError> {
        let prefs = self.inner.preferences.lock().await.computer_use.clone();
        if let Err(error) = self.inner.computer_use.restart(&prefs).await {
            tracing::warn!(%error, "failed to restart the computer-use driver");
        }
        Ok(self.computer_use_status().await)
    }

    pub async fn test_computer_use(&self) -> Result<ComputerUseTestResult, DaemonError> {
        let prefs = self.inner.preferences.lock().await.computer_use.clone();
        self.inner
            .computer_use
            .test(&prefs)
            .await
            .map_err(DaemonError::Process)
    }

    pub(crate) async fn builtin_computer_use_spec(
        &self,
    ) -> Option<crate::connectors::BuiltinComputerUseSpec> {
        let prefs = self.inner.preferences.lock().await.computer_use.clone();
        if !prefs.enabled || !self.inner.daemon.capabilities.computer_use {
            return None;
        }
        match self.inner.computer_use.ensure_ready(&prefs).await {
            Ok(Some(connector)) => Some(crate::connectors::BuiltinComputerUseSpec {
                binary: connector.binary.display().to_string(),
                socket_path: connector.socket_path.display().to_string(),
            }),
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(%error, "computer-use connector not injected");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_args_point_at_the_embedded_socket() {
        let args = mcp_args(Path::new("/tmp/cua.sock"));
        assert_eq!(
            args,
            vec![
                "mcp",
                "--embedded",
                "--socket",
                "/tmp/cua.sock",
                "--host-bundle-id",
                HOST_BUNDLE_ID,
            ]
        );
    }

    #[test]
    fn serve_args_disable_the_overlay_when_asked() {
        let with_overlay = serve_args(Path::new("/tmp/cua.sock"), true);
        assert!(!with_overlay.iter().any(|arg| arg == "--no-overlay"));
        assert!(
            with_overlay
                .iter()
                .any(|arg| arg == "--parent-liveness-stdio")
        );
        let without = serve_args(Path::new("/tmp/cua.sock"), false);
        assert!(without.iter().any(|arg| arg == "--no-overlay"));
        assert!(without.iter().any(|arg| arg == "--embedded"));
        assert!(without.iter().any(|arg| arg == "standard"));
        assert!(without.iter().any(|arg| arg == "--parent-liveness-stdio"));
    }

    #[test]
    fn serve_env_disables_updates_and_defaults_telemetry_off() {
        let env = serve_env(false);
        assert_eq!(
            env.get("CUA_DRIVER_EMBEDDED").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            env.get("CUA_DRIVER_HOST_BUNDLE_ID").map(String::as_str),
            Some(HOST_BUNDLE_ID)
        );
        assert_eq!(
            env.get("CUA_DRIVER_RS_UPDATE_CHECK").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            env.get("CUA_DRIVER_RS_TELEMETRY_ENABLED")
                .map(String::as_str),
            Some("false")
        );
        assert!(!env.contains_key("CUA_DRIVER_RS_ENABLE_WAYLAND"));
    }

    #[tokio::test]
    async fn test_capture_requires_computer_use_to_be_enabled() {
        let host = ComputerUseHost::new(
            Some("/path/that/must/not/be-started".to_string()),
            Path::new("/tmp/falcondeck-state.json"),
        );
        let error = host
            .test(&ComputerUsePreferences::default())
            .await
            .expect_err("disabled computer use must not start the driver");

        assert_eq!(error, "Turn on computer use before testing it.");
        assert!(host.inner.lock().await.child.is_none());
    }

    #[test]
    fn parse_health_report_reads_structured_or_raw_json() {
        let raw = r#"{"schema_version":"1","overall":"ok","driver_version":"0.23.2","checks":[{"name":"tcc_accessibility","status":"pass","message":"granted"},{"name":"tcc_screen_recording","status":"pass","message":"granted"},{"name":"bundle_identity","status":"fail","message":"no bundle"}]}"#;
        let health = parse_health_report(raw).expect("raw json");
        assert_eq!(health.overall, "ok");
        assert_eq!(health.driver_version.as_deref(), Some("0.23.2"));
        assert!(tcc_grants_ok(&health));
        assert!(!check_passed(&health, "bundle_identity"));

        let wrapped = format!("log line\n{{\"structuredContent\":{raw}}}\n");
        let parsed = parse_health_report(&wrapped).expect("wrapped");
        assert!(tcc_grants_ok(&parsed));
    }

    #[test]
    fn parse_list_windows_reads_window_id() {
        let raw = r#"{"windows":[{"window_id":10725,"pid":844,"app_name":"FalconDeck","is_on_screen":true,"on_current_space":true,"z_index":3},{"window_id":9,"pid":844,"app_name":"FalconDeck","is_on_screen":false,"z_index":1}]}"#;
        let windows = parse_list_windows(raw);
        assert_eq!(windows.len(), 2);
        let picked = pick_test_window(&windows, 844).expect("host window");
        assert_eq!(picked.window_id, 10725);
    }

    #[test]
    fn pick_test_window_falls_back_to_falcondeck_app_name() {
        let windows = parse_list_windows(
            r#"{"windows":[{"window_id":12,"pid":99,"app_name":"Finder","is_on_screen":true,"z_index":8},{"window_id":44,"pid":501,"app_name":"FalconDeck","is_on_screen":true,"on_current_space":true,"z_index":2}]}"#,
        );
        let picked = pick_test_window(&windows, 1).expect("named window");
        assert_eq!(picked.window_id, 44);
        assert!(pick_test_window(&windows[..1], 1).is_none());
    }
}
