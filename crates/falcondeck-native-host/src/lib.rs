//! Small C ABI embedding the existing daemon in a native desktop process.
//!
//! Returned strings belong to Rust and must be released with
//! [`fd_native_string_free`]. No Rust object or panic crosses the ABI. Normal
//! product operations continue through the daemon's loopback HTTP/WebSocket API.

use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char},
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use falcondeck_daemon::{DaemonConfig, EmbeddedDaemonHandle};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct HostConfig {
    state_path: Option<PathBuf>,
    deno_bin: Option<String>,
    computer_use_bin: Option<String>,
    computer_use_host_bundle_id: Option<String>,
    background_restore: Option<bool>,
}

struct Host {
    runtime: tokio::runtime::Runtime,
    daemon: EmbeddedDaemonHandle,
}

fn host() -> &'static Mutex<Option<Host>> {
    static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
    HOST.get_or_init(|| Mutex::new(None))
}

fn initialize_tls() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("falcondeck-native")
        .build()
        .map_err(|error| format!("Unable to start the daemon runtime: {error}"))
}

fn configured_binary(name: &str, environment: &str) -> String {
    std::env::var(environment)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| name.to_string())
}

fn start(config: HostConfig) -> Result<Value, String> {
    initialize_tls();
    let mut slot = host()
        .lock()
        .map_err(|_| "The native runtime lock failed.")?;
    if let Some(host) = slot.as_ref() {
        return Ok(json!({ "ok": true, "owned": true, "base_url": host.daemon.base_url() }));
    }
    let runtime = runtime()?;
    let daemon = runtime
        .block_on(falcondeck_daemon::spawn_embedded(DaemonConfig {
            bind_addr: ([127, 0, 0, 1], 0).into(),
            provider_bins: HashMap::from([(
                "agy".to_string(),
                configured_binary("agy", "FALCONDECK_AGY_BIN"),
            )]),
            codex_bin: configured_binary("codex", "FALCONDECK_CODEX_BIN"),
            claude_bin: configured_binary("claude", "FALCONDECK_CLAUDE_BIN"),
            deno_bin: config.deno_bin.unwrap_or_else(|| "deno".to_string()),
            computer_use_bin: config.computer_use_bin,
            computer_use_host_bundle_id: config.computer_use_host_bundle_id,
            state_path: config.state_path,
            background_restore: config.background_restore.unwrap_or(true),
        }))
        .map_err(|error| error.to_string())?;
    let result = json!({ "ok": true, "owned": true, "base_url": daemon.base_url() });
    *slot = Some(Host { runtime, daemon });
    Ok(result)
}

fn status() -> Result<Value, String> {
    let slot = host()
        .lock()
        .map_err(|_| "The native runtime lock failed.")?;
    let Some(host) = slot.as_ref() else {
        return Ok(json!({ "ok": true, "owned": false, "active_threads": 0 }));
    };
    let active = host.runtime.block_on(host.daemon.active_thread_count());
    Ok(json!({
        "ok": true, "owned": true,
        "base_url": host.daemon.base_url(), "active_threads": active,
    }))
}

fn shutdown() -> Result<Value, String> {
    let owned = host()
        .lock()
        .map_err(|_| "The native runtime lock failed.")?
        .take();
    if let Some(Host { runtime, daemon }) = owned {
        let result = runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(20), daemon.shutdown()).await
        });
        runtime.shutdown_timeout(Duration::from_secs(3));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) => return Err("The daemon shutdown deadline was exceeded.".to_string()),
        }
    }
    Ok(json!({ "ok": true, "owned": false }))
}

fn reply(action: impl FnOnce() -> Result<Value, String>) -> *mut c_char {
    let result = match catch_unwind(AssertUnwindSafe(action)) {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => json!({ "ok": false, "error": error }),
        Err(_) => json!({ "ok": false, "error": "The native runtime failed unexpectedly." }),
    };
    // JSON escapes embedded NULs, so CString cannot fail for a serialized value.
    match CString::new(result.to_string()) {
        Ok(string) => string.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Starts the daemon once and returns readiness/endpoint JSON.
///
/// # Safety
/// `config_json` must point to a valid NUL-terminated UTF-8 string for the
/// duration of this call, or be null to use the default configuration.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fd_native_start(config_json: *const c_char) -> *mut c_char {
    reply(|| {
        let config = if config_json.is_null() {
            HostConfig::default()
        } else {
            // SAFETY: required by the caller contract; no borrowed data escapes.
            let text = unsafe { CStr::from_ptr(config_json) }
                .to_str()
                .map_err(|error| format!("Invalid native runtime configuration: {error}"))?;
            serde_json::from_str(text).map_err(|error| error.to_string())?
        };
        start(config)
    })
}

/// Returns readiness, owned endpoint and active-turn count as JSON.
#[unsafe(no_mangle)]
pub extern "C" fn fd_native_status() -> *mut c_char {
    reply(status)
}

/// Gracefully stops only the runtime started through this library.
#[unsafe(no_mangle)]
pub extern "C" fn fd_native_shutdown() -> *mut c_char {
    reply(shutdown)
}

/// Runs a reserved stdio helper before GUI startup; -1 means ordinary launch.
#[unsafe(no_mangle)]
pub extern "C" fn fd_native_dispatch_helper() -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        initialize_tls();
        let first = std::env::args_os().nth(1);
        let Some(helper) = falcondeck_daemon::stdio_helper::from_first_arg(first.as_deref()) else {
            return -1;
        };
        match runtime() {
            Ok(runtime) => runtime.block_on(falcondeck_daemon::stdio_helper::run(helper)),
            Err(error) => {
                eprintln!("falcondeck: {error}");
                1
            }
        }
    }))
    .unwrap_or(1)
}

/// Releases one string returned by this library; null is accepted.
///
/// # Safety
/// `value` must be null or a live pointer returned by one of this library's
/// string-returning functions, and must not have previously been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fd_native_string_free(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: ownership is transferred back once under the caller contract.
        drop(unsafe { CString::from_raw(value) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_configuration_returns_owned_error_without_starting() {
        let config = CString::new("{broken").unwrap();
        // SAFETY: config is a valid C string and the reply is freed once below.
        let result = unsafe { fd_native_start(config.as_ptr()) };
        assert!(!result.is_null());
        let value: Value =
            unsafe { serde_json::from_slice(CStr::from_ptr(result).to_bytes()) }.unwrap();
        assert_eq!(value["ok"], false);
        unsafe { fd_native_string_free(result) };
    }

    #[test]
    fn ffi_boundary_converts_panics_to_error_json() {
        let result = reply(|| panic!("fixture"));
        let value: Value =
            unsafe { serde_json::from_slice(CStr::from_ptr(result).to_bytes()) }.unwrap();
        assert_eq!(value["ok"], false);
        unsafe { fd_native_string_free(result) };
    }

    #[test]
    fn embedded_runtime_serves_health_and_releases_ownership() {
        use std::io::{Read, Write};

        let directory = tempfile::tempdir().unwrap();
        let started = start(HostConfig {
            state_path: Some(directory.path().join("state.json")),
            background_restore: Some(false),
            ..HostConfig::default()
        })
        .unwrap();
        let url = started["base_url"].as_str().unwrap();
        let address = url.strip_prefix("http://").unwrap();
        let mut connection = std::net::TcpStream::connect(address).unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(
            connection,
            "GET /api/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        connection.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("\"ok\":true"));
        assert_eq!(status().unwrap()["active_threads"], 0);
        assert_eq!(shutdown().unwrap()["owned"], false);
        assert!(std::net::TcpStream::connect(address).is_err());
    }
}
