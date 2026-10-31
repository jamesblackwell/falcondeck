//! The optional agent-desktop CLI. Commands inherit FalconDeck's TCC identity.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use falcondeck_core::{ComputerUseHealth, ComputerUseHealthCheck};
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::timeout,
};

use super::{CapturedThumbnail, ENV_ALLOWLIST, thumbnail_data_url};

pub(super) const INSTALL_HINT: &str = "agent-desktop is not installed. Run npm install -g agent-desktop, then refresh Computer use settings.";
const MAX_OUTPUT_BYTES: u64 = 1_048_576;

pub(super) fn resolve_binary() -> Option<PathBuf> {
    let override_path = std::env::var_os("FALCONDECK_AGENT_DESKTOP_BIN");
    let path = std::env::var_os("PATH").unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    resolve_binary_from(override_path.as_deref(), &path, home.as_deref())
}

fn resolve_binary_from(
    override_path: Option<&OsStr>,
    path: &OsStr,
    home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(path) = override_path.filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        return executable(&path).then_some(path);
    }
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .collect();
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(home) = home.filter(|home| home.is_absolute()) {
        dirs.push(home.join(".local/bin"));
    }
    dirs.into_iter()
        .map(|dir| dir.join("agent-desktop"))
        .find(|path| executable(path))
}

fn executable(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

pub(super) async fn probe_health(binary: &Path) -> Result<ComputerUseHealth, String> {
    let data = run(binary, &[OsStr::new("status")], Duration::from_secs(5)).await?;
    parse_health(&data)
}

fn parse_health(data: &Value) -> Result<ComputerUseHealth, String> {
    let permissions = data
        .get("permissions")
        .and_then(Value::as_object)
        .ok_or("agent-desktop status did not include permissions")?;
    let checks: Vec<_> = [
        ("accessibility", "tcc_accessibility", "Accessibility"),
        (
            "screen_recording",
            "tcc_screen_recording",
            "Screen Recording",
        ),
    ]
    .into_iter()
    .map(|(key, name, label)| {
        let granted = permissions
            .get(key)
            .and_then(|permission| permission.get("state"))
            .and_then(Value::as_str)
            == Some("granted");
        ComputerUseHealthCheck {
            name: name.to_string(),
            status: if granted { "pass" } else { "fail" }.to_string(),
            message: format!(
                "{label}: {}",
                if granted { "granted" } else { "not granted" }
            ),
            hint: (!granted).then(|| format!("Grant {label} to FalconDeck in System Settings.")),
        }
    })
    .collect();
    Ok(ComputerUseHealth {
        overall: if checks.iter().all(|check| check.status == "pass") {
            "ok"
        } else {
            "failed"
        }
        .to_string(),
        driver_version: data
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        checks,
    })
}

async fn read_output(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("agent-desktop returned too much output".to_string());
    }
    Ok(bytes)
}

async fn run(binary: &Path, args: &[&OsStr], limit: Duration) -> Result<Value, String> {
    timeout(limit, async {
        let mut command = Command::new(binary);
        command
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in ENV_ALLOWLIST {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start agent-desktop: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or("agent-desktop stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("agent-desktop stderr unavailable")?;
        let (stdout, _stderr, status) =
            tokio::try_join!(read_output(stdout), read_output(stderr), async {
                child.wait().await.map_err(|error| error.to_string())
            })?;
        let envelope: Value = serde_json::from_slice(&stdout)
            .map_err(|_| "agent-desktop returned unreadable output".to_string())?;
        if !status.success() || envelope.get("ok").and_then(Value::as_bool) != Some(true) {
            let message = envelope
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("the command did not succeed");
            return Err(format!("agent-desktop: {message}"));
        }
        envelope
            .get("data")
            .cloned()
            .ok_or_else(|| "agent-desktop returned no command data".to_string())
    })
    .await
    .map_err(|_| "agent-desktop command timed out".to_string())?
}

fn own_window(data: &Value, pid: u32) -> Option<&str> {
    data.as_array()?
        .iter()
        .filter(|window| {
            window.get("pid").and_then(Value::as_u64) == Some(u64::from(pid))
                && window.get("accessible").and_then(Value::as_bool) == Some(true)
                && window.get("visible").and_then(Value::as_bool) == Some(true)
        })
        .max_by_key(|window| {
            window
                .get("is_focused")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .and_then(|window| window.get("id"))
        .and_then(Value::as_str)
        .filter(|id| {
            id.strip_prefix("w-")
                .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
        })
}

pub(super) async fn capture_test_thumbnail(
    binary: &Path,
    capture_dir: &Path,
) -> Result<CapturedThumbnail, String> {
    let windows = run(
        binary,
        &[OsStr::new("list-windows")],
        Duration::from_secs(8),
    )
    .await?;
    let window = own_window(&windows, std::process::id())
        .ok_or("FalconDeck has no accessible on-screen window. Unlock this Mac and open FalconDeck, then try again.")?;
    tokio::fs::create_dir_all(capture_dir)
        .await
        .map_err(|error| error.to_string())?;
    let path = capture_dir.join(format!("agent-desktop-test-{}.png", uuid::Uuid::new_v4()));
    let capture = async {
        run(
            binary,
            &[
                OsStr::new("screenshot"),
                OsStr::new("--window-id"),
                OsStr::new(window),
                path.as_os_str(),
            ],
            Duration::from_secs(12),
        )
        .await?;
        if tokio::fs::metadata(&path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or_default()
            == 0
        {
            return Err("agent-desktop did not write a test screenshot".to_string());
        }
        let thumbnail_data_url = thumbnail_data_url(&path)
            .await
            .ok_or("Could not prepare the agent-desktop screenshot preview")?;
        let black_frame = thumbnail_data_url.len() < 800;
        Ok(CapturedThumbnail {
            thumbnail_data_url: Some(thumbnail_data_url),
            black_frame,
        })
    }
    .await;
    let _ = tokio::fs::remove_file(&path).await;
    let _ = tokio::fs::remove_file(path.with_extension("jpg")).await;
    capture
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn health_uses_the_application_version_and_requires_explicit_grants() {
        let health = parse_health(&json!({"version":"1.0.2", "permissions": {
            "accessibility":{"state":"granted"}, "screen_recording":{"state":"unknown"}
        }}))
        .unwrap();
        assert_eq!(health.driver_version.as_deref(), Some("1.0.2"));
        assert!(!super::super::tcc_grants_ok(&health));
        assert!(parse_health(&json!({"version":"1.0.2"})).is_err());
    }

    #[test]
    fn screenshot_requires_a_visible_accessible_window_owned_by_the_host() {
        let windows = json!([
            {"id":"w-2","pid":2,"app_name":"FalconDeck","visible":true,"accessible":true,"is_focused":true},
            {"id":"w-3","pid":1,"visible":false,"accessible":true},
            {"id":"w-4","pid":1,"visible":true,"accessible":false},
            {"id":"w-5","pid":1,"visible":true,"accessible":true}
        ]);
        assert_eq!(own_window(&windows, 1), Some("w-5"));
        assert_eq!(own_window(&windows, 3), None);
    }

    #[cfg(unix)]
    fn fake_binary(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("agent-desktop");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn binary_discovery_rejects_relative_overrides_and_non_executable_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = fake_binary(temp.path(), "exit 0");
        assert_eq!(
            resolve_binary_from(Some(path.as_os_str()), OsStr::new(""), None),
            Some(path.clone())
        );
        assert_eq!(
            resolve_binary_from(
                Some(OsStr::new("./agent-desktop")),
                temp.path().as_os_str(),
                None
            ),
            None
        );
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            resolve_binary_from(Some(path.as_os_str()), OsStr::new(""), None),
            None
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_rejects_error_envelopes_even_with_successful_exit() {
        let temp = tempfile::tempdir().unwrap();
        let path = fake_binary(
            temp.path(),
            r#"printf '%s' '{"ok":false,"error":{"message":"denied"}}'"#,
        );
        assert_eq!(
            probe_health(&path).await.unwrap_err(),
            "agent-desktop: denied"
        );
        fake_binary(
            temp.path(),
            r#"printf '%s' '{"ok":true,"data":{"permissions":{}}}'; exit 1"#,
        );
        assert!(probe_health(&path).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_reads_the_nested_version_instead_of_protocol_version() {
        let temp = tempfile::tempdir().unwrap();
        let path = fake_binary(
            temp.path(),
            r#"printf '%s' '{"ok":true,"version":"2.5","data":{"version":"1.0.2","permissions":{"accessibility":{"state":"granted"},"screen_recording":{"state":"granted"}}}}'"#,
        );
        let health = probe_health(&path).await.unwrap();
        assert_eq!(health.driver_version.as_deref(), Some("1.0.2"));
        assert!(super::super::tcc_grants_ok(&health));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_reaps_the_cli_process() {
        let temp = tempfile::tempdir().unwrap();
        let pid_path = temp.path().join("pid");
        let path = fake_binary(
            temp.path(),
            "printf '%s' \"$$\" > \"$1\"\nexec /bin/sleep 30",
        );
        let error = run(&path, &[pid_path.as_os_str()], Duration::from_secs(2))
            .await
            .unwrap_err();
        assert!(error.contains("timed out"));
        let pid = std::fs::read_to_string(pid_path)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed-out CLI was left alive"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn cli_output_is_bounded() {
        let bytes = vec![b'x'; MAX_OUTPUT_BYTES as usize + 1];
        assert!(
            read_output(bytes.as_slice())
                .await
                .unwrap_err()
                .contains("too much output")
        );
    }
}
