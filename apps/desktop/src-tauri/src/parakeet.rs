//! A serialized, disposable native ASR worker. Model downloads are explicit;
//! startup and dictation only load the local cache.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        LazyLock, Mutex as StdMutex, RwLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

pub const MODEL: &str = "nvidia/parakeet-tdt-0.6b-v3";
static WORKER: Mutex<Option<Worker>> = Mutex::const_new(None);
static ENABLED: AtomicBool = AtomicBool::new(false);
static IDLE_MINUTES: AtomicU32 = AtomicU32::new(15);
static PID: StdMutex<Option<u32>> = StdMutex::new(None);
static STATUS: LazyLock<RwLock<ParakeetStatus>> =
    LazyLock::new(|| RwLock::new(ParakeetStatus::default()));

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParakeetStatus {
    supported: bool,
    installed: bool,
    loaded: bool,
    busy: bool,
    progress: Option<f64>,
    phase: String,
    error: Option<String>,
}

fn update(f: impl FnOnce(&mut ParakeetStatus)) {
    if let Ok(mut status) = STATUS.write() {
        f(&mut status);
    }
}

fn detect_support() -> bool {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return false;
    }
    std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|version| version.trim().split('.').next()?.parse::<u32>().ok())
        .is_some_and(|major| major >= 14)
}

fn supported() -> bool {
    static SUPPORTED: LazyLock<bool> = LazyLock::new(detect_support);
    *SUPPORTED
}

fn cache(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("parakeet-v3-int8-v2"))
}

// These names mirror the pinned SDK's v3/int8V2 component set. Checking the
// compiled graph avoids advertising an empty/interrupted cache as installed.
const MODEL_DIRECTORY: &str = "parakeet-tdt-0.6b-v3";
const COMPONENTS: [&str; 4] = [
    "Encoder_v2.mlmodelc",
    "Decoder.mlmodelc",
    "Preprocessor.mlmodelc",
    "JointDecisionv3.mlmodelc",
];
fn installed(directory: &Path) -> bool {
    let models = directory.join(MODEL_DIRECTORY);
    directory.join("ready").is_file()
        && models.join("parakeet_vocab.json").is_file()
        && COMPONENTS
            .iter()
            .all(|name| models.join(name).join("model.mil").is_file())
}

fn discard_exited(worker: &mut Option<Worker>) {
    // Hold PID ownership across synchronous reaping: shutdown must never
    // signal a PID that the OS could already have reassigned.
    let Ok(mut pid) = PID.lock() else {
        return;
    };
    let exited = worker
        .as_mut()
        .is_some_and(|worker| !matches!(worker.child.try_wait(), Ok(None)));
    if exited {
        *pid = None;
        *worker = None;
        update(|status| status.loaded = false);
    }
}

#[tauri::command]
pub fn parakeet_status(app: AppHandle) -> Result<ParakeetStatus, String> {
    if let Ok(mut worker) = WORKER.try_lock() {
        discard_exited(&mut worker);
    }
    let mut status = STATUS
        .read()
        .map_err(|_| "Parakeet status is unavailable.")?
        .clone();
    status.supported = supported();
    status.installed = installed(&cache(&app)?);
    Ok(status)
}

pub fn configure(enabled: bool, minutes: u32) {
    ENABLED.store(enabled, Ordering::Release);
    IDLE_MINUTES.store(minutes.min(60), Ordering::Release);
    tauri::async_runtime::spawn(async move {
        let mut worker = WORKER.lock().await;
        if !ENABLED.load(Ordering::Acquire) {
            stop(&mut worker).await;
        }
    });
}

struct Worker {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    last_used: Instant,
}

fn binary() -> Result<PathBuf, String> {
    let bundled = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Missing application directory.")?
        .join("falcondeck-parakeet");
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let arch = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x86_64"
        };
        let local = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("falcondeck-parakeet-{arch}-apple-darwin"));
        if local.is_file() {
            return Ok(local);
        }
    }
    Err("The Parakeet runtime is missing from this build.".into())
}

async fn start(app: &AppHandle) -> Result<Worker, String> {
    let directory = cache(app)?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|e| e.to_string())?;
    let mut child = Command::new(binary()?)
        .arg(directory)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start Parakeet: {e}"))?;
    let input = child.stdin.take().ok_or("Missing Parakeet input.")?;
    let output = BufReader::new(child.stdout.take().ok_or("Missing Parakeet output.")?).lines();
    if let Ok(mut pid) = PID.lock() {
        *pid = child.id();
    }
    let timer_pid = child.id();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let Ok(mut worker) = WORKER.try_lock() else {
                continue;
            };
            let Some(current) = worker.as_ref() else {
                break;
            };
            if current.child.id() != timer_pid {
                break;
            }
            if !ENABLED.load(Ordering::Acquire)
                || idle_expired(
                    current.last_used.elapsed(),
                    IDLE_MINUTES.load(Ordering::Acquire),
                )
            {
                stop(&mut worker).await;
                break;
            }
        }
    });
    Ok(Worker {
        child,
        input,
        output,
        last_used: Instant::now(),
    })
}

fn idle_expired(elapsed: Duration, minutes: u32) -> bool {
    elapsed >= Duration::from_secs(u64::from(minutes) * 60)
}

async fn stop(worker: &mut Option<Worker>) {
    if let Ok(mut pid) = PID.lock() {
        *pid = None;
    }
    if let Some(mut current) = worker.take() {
        let _ = current.child.kill().await;
        let _ = current.child.wait().await;
    }
    update(|status| status.loaded = false);
}

async fn exchange(worker: &mut Worker, request: Value) -> Result<Value, String> {
    let mut line = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    worker
        .input
        .write_all(&line)
        .await
        .map_err(|e| e.to_string())?;
    worker.input.flush().await.map_err(|e| e.to_string())?;
    loop {
        let line = worker
            .output
            .next_line()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Parakeet stopped unexpectedly. Please try again.")?;
        let response: Value =
            serde_json::from_str(&line).map_err(|e| format!("Invalid Parakeet response: {e}"))?;
        if let Some(error) = response.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(response);
        }
        update(|status| {
            status.progress = response.get("progress").and_then(Value::as_f64);
            status.phase = response
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or("Preparing model")
                .to_string();
        });
    }
}

async fn request(
    app: &AppHandle,
    operation: &str,
    path: Option<&Path>,
    force: bool,
) -> Result<Value, String> {
    if !supported() {
        return Err("Parakeet requires an Apple Silicon Mac running macOS 14 or later.".into());
    }
    let mut worker = WORKER.lock().await;
    // Setup owns this lock until the marker is written; a dictation arriving
    // during download should wait for it rather than report a missing model.
    if operation != "prepare" && !installed(&cache(app)?) {
        return Err("Download Parakeet in Dictation settings first.".into());
    }
    discard_exited(&mut worker);
    if operation == "warm" {
        if !ENABLED.load(Ordering::Acquire) || IDLE_MINUTES.load(Ordering::Acquire) == 0 {
            return Ok(json!({"ok": true}));
        }
        if let Some(current) = worker.as_mut() {
            current.last_used = Instant::now();
            return Ok(json!({"ok": true}));
        }
    }
    update(|status| {
        status.busy = true;
        status.error = None;
        status.progress = None;
        status.phase = "Preparing model".into();
    });
    let result = async {
        if worker.is_none() {
            *worker = Some(start(app).await?);
        }
        let current = worker.as_mut().ok_or("Parakeet is unavailable.")?;
        let request = if let Some(path) = path {
            json!({"operation":operation, "path":path})
        } else {
            json!({"operation":operation, "force": if force { "true" } else { "false" }})
        };
        let timeout = if operation == "prepare" {
            Duration::from_secs(1800)
        } else if operation == "warm" {
            Duration::from_secs(60)
        } else {
            Duration::from_secs(1500)
        };
        let response = tokio::time::timeout(timeout, exchange(current, request))
            .await
            .map_err(|_| "Parakeet timed out. Please try again.")??;
        if operation == "prepare" {
            tokio::fs::write(cache(app)?.join("ready"), MODEL)
                .await
                .map_err(|e| e.to_string())?;
        }
        current.last_used = Instant::now();
        Ok(response)
    }
    .await;
    update(|status| {
        status.busy = false;
        status.loaded = result.is_ok();
        status.progress = None;
        status.phase.clear();
        status.error = result.as_ref().err().cloned();
    });
    if result.is_err()
        || !ENABLED.load(Ordering::Acquire)
        || IDLE_MINUTES.load(Ordering::Acquire) == 0
    {
        stop(&mut worker).await;
    }
    result
}

#[tauri::command]
pub async fn prepare_parakeet(
    app: AppHandle,
    force: Option<bool>,
) -> Result<ParakeetStatus, String> {
    request(&app, "prepare", None, force.unwrap_or(false)).await?;
    parakeet_status(app)
}

pub fn prewarm(app: AppHandle) {
    if ENABLED.load(Ordering::Acquire) && IDLE_MINUTES.load(Ordering::Acquire) > 0 {
        tauri::async_runtime::spawn(async move {
            let _ = request(&app, "warm", None, false).await;
        });
    }
}

pub async fn transcribe(app: &AppHandle, path: &Path) -> Result<String, String> {
    let result = request(app, "transcribe", Some(path), false).await?;
    result
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Parakeet did not detect any speech.".into())
}

pub fn shutdown() {
    // Shutdown is synchronous. Target only the child we still own, even if it
    // is inside an inference/download await and the worker lock is occupied.
    let Ok(pid) = PID.lock() else {
        return;
    };
    if let Some(pid) = *pid {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_requires_complete_compiled_components() {
        let root =
            std::env::temp_dir().join(format!("fd-parakeet-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ready"), MODEL).unwrap();
        assert!(!installed(&root));
        let models = root.join(MODEL_DIRECTORY);
        for name in COMPONENTS {
            std::fs::create_dir_all(models.join(name)).unwrap();
            std::fs::write(models.join(name).join("model.mil"), "compiled graph").unwrap();
        }
        std::fs::write(models.join("parakeet_vocab.json"), "{}").unwrap();
        assert!(installed(&root));
        std::fs::remove_file(models.join("Encoder_v2.mlmodelc/model.mil")).unwrap();
        assert!(!installed(&root));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn protocol_progress_and_exited_worker_are_handled() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", r#"read -r request; printf '%s\n' '{"progress":0.5,"phase":"Loading model"}' '{"ok":true,"text":"hello"}'"#])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
            .kill_on_drop(true).spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut worker = Some(Worker {
            child,
            input,
            output,
            last_used: Instant::now(),
        });
        let response = exchange(worker.as_mut().unwrap(), json!({"operation":"transcribe"}))
            .await
            .unwrap();
        assert_eq!(response["text"], "hello");
        worker.as_mut().unwrap().child.wait().await.unwrap();
        discard_exited(&mut worker);
        assert!(worker.is_none());
        assert!(!STATUS.read().unwrap().loaded);
    }

    #[test]
    fn idle_deadline_includes_immediate_unload() {
        assert!(idle_expired(Duration::ZERO, 0));
        assert!(!idle_expired(Duration::from_secs(899), 15));
        assert!(idle_expired(Duration::from_secs(900), 15));
    }
}
