use std::{
    ffi::{CStr, CString},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, OnceLock, RwLock,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

const DICTATION_WINDOW_LABEL: &str = "dictation";
const DICTATION_EVENT: &str = "falcondeck://dictation-state";
const DICTATION_LEVEL_EVENT: &str = "falcondeck://dictation-level";
const MAX_RECORDING_BYTES: u64 = 8 * 1024 * 1024;
const OPENROUTER_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(75);

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static CONFIG: LazyLock<RwLock<DictationConfiguration>> =
    LazyLock::new(|| RwLock::new(DictationConfiguration::default()));
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(0);
static NEXT_TRANSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_OPENROUTER_TRANSCRIPTION: AtomicU64 = AtomicU64::new(0);

static OPENROUTER_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(OPENROUTER_TRANSCRIPTION_TIMEOUT)
        .build()
        .unwrap_or_default()
});

/// Mirrors `FDEventKind` in `dictation_events.h`; a unit test asserts the two
/// definitions stay in sync.
mod event_kind {
    pub const RECORDING: i32 = 0;
    pub const PROCESSING: i32 = 1;
    pub const COMPLETED: i32 = 2;
    pub const FAILED: i32 = 3;
    pub const CANCELLED: i32 = 4;
    pub const AUDIO_READY: i32 = 5;
    pub const FAILED_RETAINED: i32 = 6;
    pub const AUDIO_LEVEL: i32 = 7;
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationShortcut {
    #[default]
    RightCommand,
    LeftFunction,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationActivation {
    #[default]
    Hold,
    Toggle,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationProvider {
    #[default]
    System,
    OpenRouter,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationPermission {
    Microphone,
    SpeechRecognition,
    Accessibility,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationConfiguration {
    pub enabled: bool,
    pub shortcut: DictationShortcut,
    pub activation: DictationActivation,
    pub provider: DictationProvider,
    pub input_device_id: Option<String>,
    pub daemon_url: Option<String>,
    pub model: String,
}

impl Default for DictationConfiguration {
    fn default() -> Self {
        Self {
            enabled: false,
            shortcut: DictationShortcut::RightCommand,
            activation: DictationActivation::Hold,
            provider: DictationProvider::System,
            input_device_id: None,
            daemon_url: None,
            model: "openai/whisper-large-v3-turbo".to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationEvent {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    retained_audio: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationPermissionStatus {
    microphone: &'static str,
    speech_recognition: &'static str,
    accessibility: bool,
    supported: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationAudioDevice {
    id: String,
    name: String,
    is_default: bool,
}

#[derive(Serialize)]
struct TranscriptionRequest {
    audio_base64: String,
    format: &'static str,
    model: String,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn fd_dictation_configure(
        enabled: bool,
        shortcut: i32,
        activation_mode: i32,
        provider: i32,
        input_device_id: *const std::ffi::c_char,
    );
    fn fd_dictation_audio_devices_json() -> *mut std::ffi::c_char;
    fn fd_dictation_temp_directory() -> *mut std::ffi::c_char;
    fn fd_dictation_free_string(value: *mut std::ffi::c_char);
    fn fd_dictation_request_microphone_permission();
    fn fd_dictation_request_speech_permission();
    fn fd_dictation_request_accessibility_permission();
    fn fd_dictation_microphone_permission() -> i32;
    fn fd_dictation_speech_permission() -> i32;
    fn fd_dictation_accessibility_permission() -> bool;
    fn fd_dictation_start();
    fn fd_dictation_stop();
    fn fd_dictation_cancel();
    fn fd_dictation_retry();
    fn fd_dictation_discard();
    fn fd_dictation_paste_text(text: *const std::ffi::c_char) -> bool;
    fn fd_dictation_mark_completed();
    fn fd_dictation_open_accessibility_settings();
    fn fd_dictation_shutdown();
}

pub fn initialize(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

pub fn create_overlay_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(DICTATION_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        DICTATION_WINDOW_LABEL,
        tauri::WebviewUrl::App("dictation-window.html".into()),
    )
    .title("FalconDeck Dictation")
    .inner_size(720.0, 156.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .focusable(false)
    .visible(false)
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn shortcut_code(shortcut: DictationShortcut) -> i32 {
    match shortcut {
        DictationShortcut::RightCommand => 0,
        DictationShortcut::LeftFunction => 1,
    }
}

fn activation_code(activation: DictationActivation) -> i32 {
    match activation {
        DictationActivation::Hold => 0,
        DictationActivation::Toggle => 1,
    }
}

fn provider_code(provider: DictationProvider) -> i32 {
    match provider {
        DictationProvider::System => 0,
        DictationProvider::OpenRouter => 1,
    }
}

fn validate_local_daemon_url(daemon_url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(daemon_url)
        .map_err(|_| "OpenRouter dictation requires the local FalconDeck daemon.".to_string())?;
    let is_loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if url.scheme() != "http"
        || !is_loopback
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("OpenRouter dictation requires the local FalconDeck daemon.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn configure_dictation(config: DictationConfiguration) -> Result<(), String> {
    if config.enabled && matches!(config.provider, DictationProvider::OpenRouter) {
        let daemon_url = config.daemon_url.as_deref().unwrap_or_default();
        validate_local_daemon_url(daemon_url)?;
    }
    if config.model.trim().is_empty() || config.model.len() > 200 {
        return Err("The transcription model is invalid.".to_string());
    }

    #[cfg(target_os = "macos")]
    unsafe {
        let input_device_id = config
            .input_device_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(CString::new)
            .transpose()
            .map_err(|_| "The selected microphone identifier is invalid.".to_string())?;
        fd_dictation_configure(
            config.enabled,
            shortcut_code(config.shortcut),
            activation_code(config.activation),
            provider_code(config.provider),
            input_device_id
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
        );
    }
    *CONFIG
        .write()
        .map_err(|_| "Dictation settings are unavailable.".to_string())? = config;
    Ok(())
}

#[tauri::command]
pub fn dictation_audio_devices() -> Result<Vec<DictationAudioDevice>, String> {
    #[cfg(target_os = "macos")]
    unsafe {
        let value = fd_dictation_audio_devices_json();
        if value.is_null() {
            return Err("FalconDeck could not list microphones.".to_string());
        }
        let json = CStr::from_ptr(value).to_string_lossy().into_owned();
        fd_dictation_free_string(value);
        serde_json::from_str(&json)
            .map_err(|error| format!("FalconDeck could not read microphones: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    Ok(Vec::new())
}

fn permission_label(value: i32) -> &'static str {
    match value {
        2 => "granted",
        1 => "denied",
        3 => "unsupported",
        _ => "not_requested",
    }
}

fn parse_audio_level(payload: &str) -> Option<f32> {
    payload
        .parse::<f32>()
        .ok()
        .filter(|level| level.is_finite())
        .map(|level| level.clamp(0.0, 1.0))
}

#[tauri::command]
pub fn dictation_permission_status() -> DictationPermissionStatus {
    #[cfg(target_os = "macos")]
    unsafe {
        let microphone = permission_label(fd_dictation_microphone_permission());
        DictationPermissionStatus {
            microphone,
            speech_recognition: permission_label(fd_dictation_speech_permission()),
            accessibility: fd_dictation_accessibility_permission(),
            supported: microphone != "unsupported",
        }
    }
    #[cfg(not(target_os = "macos"))]
    DictationPermissionStatus {
        microphone: "unsupported",
        speech_recognition: "unsupported",
        accessibility: false,
        supported: false,
    }
}

#[tauri::command]
pub fn request_dictation_permission(permission: DictationPermission) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        match permission {
            DictationPermission::Microphone => fd_dictation_request_microphone_permission(),
            DictationPermission::SpeechRecognition => fd_dictation_request_speech_permission(),
            DictationPermission::Accessibility => fd_dictation_request_accessibility_permission(),
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        Err("System-wide dictation is currently available on macOS only.".to_string())
    }
}

#[tauri::command]
pub fn start_dictation() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        fd_dictation_start();
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Err("System-wide dictation is currently available on macOS only.".to_string())
}

#[tauri::command]
pub fn stop_dictation() {
    #[cfg(target_os = "macos")]
    unsafe {
        fd_dictation_stop();
    }
}

#[tauri::command]
pub fn cancel_dictation() {
    ACTIVE_OPENROUTER_TRANSCRIPTION.store(0, Ordering::Release);
    #[cfg(target_os = "macos")]
    unsafe {
        fd_dictation_cancel();
    }
}

#[tauri::command]
pub fn retry_dictation() {
    #[cfg(target_os = "macos")]
    unsafe {
        fd_dictation_retry();
    }
}

#[tauri::command]
pub fn discard_dictation() {
    ACTIVE_OPENROUTER_TRANSCRIPTION.store(0, Ordering::Release);
    #[cfg(target_os = "macos")]
    unsafe {
        fd_dictation_discard();
    }
}

#[tauri::command]
pub fn open_dictation_accessibility_settings() {
    #[cfg(target_os = "macos")]
    unsafe {
        fd_dictation_open_accessibility_settings();
    }
}

pub fn shutdown() {
    ACTIVE_OPENROUTER_TRANSCRIPTION.store(0, Ordering::Release);
    #[cfg(target_os = "macos")]
    unsafe {
        fd_dictation_shutdown();
    }
}

fn position_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window(DICTATION_WINDOW_LABEL) else {
        return;
    };
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|position| {
            app.monitor_from_point(position.x, position.y)
                .ok()
                .flatten()
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let (Ok(window_size), Some(monitor)) = (window.outer_size(), monitor) else {
        return;
    };
    let work_area = monitor.work_area();
    let x = work_area.position.x
        + ((work_area.size.width.saturating_sub(window_size.width)) / 2) as i32;
    let top_gap = (12.0 * monitor.scale_factor()).round() as i32;
    let y = work_area.position.y + top_gap;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn show_overlay(app: &AppHandle) {
    position_overlay(app);
    if let Some(window) = app.get_webview_window(DICTATION_WINDOW_LABEL) {
        let _ = window.show();
    }
}

fn hide_overlay_after(app: AppHandle, generation: u64, delay: Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if SESSION_GENERATION.load(Ordering::Acquire) != generation {
            return;
        }
        if let Some(window) = app.get_webview_window(DICTATION_WINDOW_LABEL) {
            let _ = window.hide();
        }
    });
}

fn emit_event(app: &AppHandle, event: DictationEvent) {
    let _ = app.emit(DICTATION_EVENT, &event);
}

fn emit_failure(app: &AppHandle, message: String, retained_audio: bool) {
    SESSION_GENERATION.fetch_add(1, Ordering::AcqRel);
    show_overlay(app);
    emit_event(
        app,
        DictationEvent {
            state: "failed",
            text: None,
            error: Some(message),
            retained_audio,
        },
    );
}

/// The directory the native side records into. `NSTemporaryDirectory()` can
/// differ from `$TMPDIR`/`std::env::temp_dir()` (for example under sandboxed
/// launches), so ask the source of truth instead of guessing.
#[cfg(target_os = "macos")]
fn dictation_temp_dir() -> PathBuf {
    unsafe {
        let value = fd_dictation_temp_directory();
        if !value.is_null() {
            let raw = CStr::from_ptr(value).to_string_lossy().into_owned();
            fd_dictation_free_string(value);
            let trimmed = raw.trim_end_matches('/');
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
    }
    std::env::temp_dir()
}

#[cfg(not(target_os = "macos"))]
fn dictation_temp_dir() -> PathBuf {
    std::env::temp_dir()
}

fn validate_recording_path(path: &Path) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if path.parent() != Some(dictation_temp_dir().as_path())
        || !file_name.starts_with("falcondeck-dictation-")
        || path.extension().and_then(|value| value.to_str()) != Some("m4a")
    {
        return Err("FalconDeck rejected an invalid temporary recording path.".to_string());
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("The retained recording is unavailable: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err("The retained recording is invalid.".to_string());
    }
    if metadata.len() > MAX_RECORDING_BYTES {
        return Err("The recording is too long to transcribe with OpenRouter.".to_string());
    }
    Ok(())
}

async fn transcribe_openrouter(
    app: AppHandle,
    path: PathBuf,
    transcription_id: u64,
) -> Result<(), String> {
    validate_recording_path(&path)?;
    let config = CONFIG
        .read()
        .map_err(|_| "Dictation settings are unavailable.".to_string())?
        .clone();
    let daemon_url = config
        .daemon_url
        .as_deref()
        .ok_or_else(|| "The local FalconDeck daemon is unavailable.".to_string())?;
    let audio = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("Could not read the retained recording: {error}"))?;
    let response = OPENROUTER_CLIENT
        .post(format!("{daemon_url}/api/speech/transcribe"))
        .json(&TranscriptionRequest {
            audio_base64: STANDARD.encode(audio),
            format: "m4a",
            model: config.model,
        })
        .send()
        .await
        .map_err(|error| format!("OpenRouter transcription failed: {error}"))?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(|value| value.as_str())
            .or_else(|| body.get("message").and_then(|value| value.as_str()))
            .map(str::to_string)
            .unwrap_or_else(|| format!("Transcription failed ({})", status.as_u16()));
        return Err(message);
    }
    let text = body
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.chars().count() < 3 {
        return Err("No speech was detected. Your recording has been retained.".to_string());
    }

    let finish_app = app.clone();
    app.run_on_main_thread(move || {
        if ACTIVE_OPENROUTER_TRANSCRIPTION
            .compare_exchange(
                transcription_id,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return;
        }
        let Ok(c_text) = CString::new(text.as_str()) else {
            emit_failure(
                &finish_app,
                "The transcript contained unsupported text.".to_string(),
                true,
            );
            return;
        };
        #[cfg(target_os = "macos")]
        let pasted = unsafe { fd_dictation_paste_text(c_text.as_ptr()) };
        #[cfg(not(target_os = "macos"))]
        let pasted = false;
        if !pasted {
            emit_failure(
                &finish_app,
                "The transcript is ready, but FalconDeck could not paste it. Your recording has been retained."
                    .to_string(),
                true,
            );
            return;
        }
        let _ = std::fs::remove_file(&path);
        #[cfg(target_os = "macos")]
        unsafe {
            fd_dictation_mark_completed();
        }
        let generation = SESSION_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
        emit_event(
            &finish_app,
            DictationEvent {
                state: "completed",
                text: Some(text),
                error: None,
                retained_audio: false,
            },
        );
        hide_overlay_after(finish_app, generation, Duration::from_millis(900));
    })
    .map_err(|error| error.to_string())
}

/// Receives lifecycle callbacks from the Objective-C bridge. Payload pointers
/// are valid only for this synchronous call, so copy them before any async work.
#[cfg(target_os = "macos")]
#[no_mangle]
pub extern "C" fn fd_dictation_emit(kind: i32, payload: *const std::ffi::c_char) {
    let Some(app) = APP_HANDLE.get().cloned() else {
        return;
    };
    let payload = if payload.is_null() {
        String::new()
    } else {
        // SAFETY: macos_dictation.m always supplies a live, null-terminated
        // UTF-8 string for the duration of this callback.
        unsafe { CStr::from_ptr(payload) }
            .to_string_lossy()
            .into_owned()
    };
    match kind {
        event_kind::RECORDING => {
            SESSION_GENERATION.fetch_add(1, Ordering::AcqRel);
            show_overlay(&app);
            emit_event(
                &app,
                DictationEvent {
                    state: "recording",
                    text: None,
                    error: None,
                    retained_audio: false,
                },
            );
        }
        event_kind::PROCESSING => emit_event(
            &app,
            DictationEvent {
                state: "transcribing",
                text: None,
                error: None,
                retained_audio: true,
            },
        ),
        event_kind::COMPLETED => {
            let generation = SESSION_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
            emit_event(
                &app,
                DictationEvent {
                    state: "completed",
                    text: Some(payload),
                    error: None,
                    retained_audio: false,
                },
            );
            hide_overlay_after(app, generation, Duration::from_millis(900));
        }
        event_kind::FAILED => emit_failure(&app, payload, false),
        event_kind::CANCELLED => {
            let generation = SESSION_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
            emit_event(
                &app,
                DictationEvent {
                    state: "cancelled",
                    text: None,
                    error: None,
                    retained_audio: false,
                },
            );
            hide_overlay_after(app, generation, Duration::from_millis(650));
        }
        event_kind::AUDIO_READY => {
            let path = PathBuf::from(payload);
            let transcription_id = NEXT_TRANSCRIPTION_ID.fetch_add(1, Ordering::Relaxed);
            if ACTIVE_OPENROUTER_TRANSCRIPTION
                .compare_exchange(0, transcription_id, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                emit_failure(
                    &app,
                    "This recording is already being transcribed.".to_string(),
                    true,
                );
                return;
            }
            tauri::async_runtime::spawn(async move {
                if let Err(error) = transcribe_openrouter(app.clone(), path, transcription_id).await
                {
                    if ACTIVE_OPENROUTER_TRANSCRIPTION
                        .compare_exchange(transcription_id, 0, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                    {
                        emit_failure(&app, error, true);
                    }
                }
            });
        }
        event_kind::FAILED_RETAINED => emit_failure(&app, payload, true),
        event_kind::AUDIO_LEVEL => {
            if let Some(level) = parse_audio_level(&payload) {
                let _ = app.emit_to(DICTATION_WINDOW_LABEL, DICTATION_LEVEL_EVENT, level);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{
        dictation_audio_devices, parse_audio_level, permission_label, validate_local_daemon_url,
        validate_recording_path,
    };

    #[test]
    fn event_kinds_match_shared_native_header() {
        let header = include_str!("dictation_events.h");
        let expected = [
            ("Recording", super::event_kind::RECORDING),
            ("Processing", super::event_kind::PROCESSING),
            ("Completed", super::event_kind::COMPLETED),
            ("Failed", super::event_kind::FAILED),
            ("Cancelled", super::event_kind::CANCELLED),
            ("AudioReady", super::event_kind::AUDIO_READY),
            ("FailedRetained", super::event_kind::FAILED_RETAINED),
            ("AudioLevel", super::event_kind::AUDIO_LEVEL),
        ];
        for (name, value) in expected {
            assert!(
                header.contains(&format!("FDEvent{name} = {value}")),
                "FDEvent{name} = {value} is missing or mismatched in dictation_events.h"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn audio_device_bridge_returns_valid_devices() {
        let devices = dictation_audio_devices().expect("audio devices should serialize");
        assert!(devices
            .iter()
            .all(|device| { !device.id.is_empty() && !device.name.is_empty() }));
    }

    #[test]
    fn permission_label_preserves_unsupported_platform_state() {
        assert_eq!(permission_label(3), "unsupported");
    }

    #[test]
    fn audio_level_payload_is_validated_and_clamped() {
        assert_eq!(parse_audio_level("0.42"), Some(0.42));
        assert_eq!(parse_audio_level("2"), Some(1.0));
        assert_eq!(parse_audio_level("-1"), Some(0.0));
        assert_eq!(parse_audio_level("not-a-level"), None);
    }

    #[test]
    fn local_daemon_url_rejects_remote_and_userinfo_hosts() {
        assert!(validate_local_daemon_url("http://127.0.0.1:51787").is_ok());
        assert!(validate_local_daemon_url("http://localhost:51787").is_ok());
        assert!(validate_local_daemon_url("https://127.0.0.1:51787").is_err());
        assert!(validate_local_daemon_url("http://example.com:51787").is_err());
        assert!(validate_local_daemon_url("http://localhost:51787@evil.example").is_err());
        assert!(validate_local_daemon_url("http://localhost:51787/api").is_err());
    }

    #[test]
    fn validate_recording_path_rejects_non_dictation_file() {
        let error = validate_recording_path(std::path::Path::new("/tmp/example.m4a"))
            .expect_err("an arbitrary file should be rejected");
        assert_eq!(
            error,
            "FalconDeck rejected an invalid temporary recording path."
        );
    }
}
