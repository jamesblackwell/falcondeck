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
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition};

const DICTATION_WINDOW_LABEL: &str = "dictation";
const MAIN_WINDOW_LABEL: &str = "main";
const DICTATION_EVENT: &str = "falcondeck://dictation-state";
const DICTATION_LEVEL_EVENT: &str = "falcondeck://dictation-level";
const DICTATION_INSERT_EVENT: &str = "falcondeck://dictation-insert";
const MAX_RECORDING_BYTES: u64 = 8 * 1024 * 1024;
// Overlay geometry in logical points. The pill is a compact status strip; the
// failure card needs the wider, taller box so its message and buttons lay out
// on one line each.
const OVERLAY_PILL_WIDTH: f64 = 504.0;
const OVERLAY_PILL_HEIGHT: f64 = 84.0;
const OVERLAY_FAILED_WIDTH: f64 = 720.0;
const OVERLAY_FAILED_HEIGHT: f64 = 156.0;
const OPENROUTER_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(75);
// How long the cancelled pill stays up offering Undo. Mirrored by
// UNDO_WINDOW_SECONDS in DictationOverlay.tsx, which counts it down.
const CANCEL_UNDO_WINDOW: Duration = Duration::from_secs(10);

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static CONFIG: LazyLock<RwLock<DictationConfiguration>> =
    LazyLock::new(|| RwLock::new(DictationConfiguration::default()));
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(0);
static NEXT_TRANSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_OPENROUTER_TRANSCRIPTION: AtomicU64 = AtomicU64::new(0);
// The most recent transcript, kept so the writer can re-insert it (Cmd+Shift+V
// in the app) or copy it after a failed paste. Session-scoped on purpose.
static LAST_TRANSCRIPT: RwLock<Option<String>> = RwLock::new(None);

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
    pub const SELF_INSERT: i32 = 8;
    pub const PASTE_FAILED: i32 = 9;
    pub const CANCELLED_RETAINED: i32 = 11;
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
            model: "openai/gpt-4o-mini-transcribe".to_string(),
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
    fn fd_dictation_drop_cancelled();
    fn fd_dictation_stop();
    fn fd_dictation_cancel();
    fn fd_dictation_retry();
    fn fd_dictation_discard();
    fn fd_dictation_paste_text(text: *const std::ffi::c_char) -> bool;
    fn fd_dictation_copy_text(text: *const std::ffi::c_char) -> bool;
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
    .inner_size(OVERLAY_PILL_WIDTH, OVERLAY_PILL_HEIGHT)
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
    .map(|window| {
        // Armed only for the failure card, which is the one state with buttons.
        let _ = window.set_ignore_cursor_events(true);
    })
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
        .map_err(|_| "OpenRouter dictation needs FalconDeck to be connected.".to_string())?;
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
        return Err("OpenRouter dictation needs FalconDeck to be connected.".to_string());
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

/// Also drives the overlay's Undo button. Bumping the generation retires the
/// pending undo-window task, so the audio this is about to transcribe is not
/// deleted out from under it.
#[tauri::command]
pub fn retry_dictation() {
    SESSION_GENERATION.fetch_add(1, Ordering::AcqRel);
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
pub fn last_dictation_transcript() -> Option<String> {
    LAST_TRANSCRIPT.read().ok().and_then(|last| last.clone())
}

#[tauri::command]
pub fn copy_dictation_transcript() -> Result<(), String> {
    let text = last_dictation_transcript()
        .ok_or_else(|| "There is no transcript to copy yet.".to_string())?;
    #[cfg(target_os = "macos")]
    {
        let c_text = CString::new(text)
            .map_err(|_| "The transcript contained unsupported text.".to_string())?;
        if unsafe { fd_dictation_copy_text(c_text.as_ptr()) } {
            Ok(())
        } else {
            Err("FalconDeck could not write to the clipboard.".to_string())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("Dictation clipboard copy is currently available on macOS only.".to_string())
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

fn overlay_size(failed: bool) -> (f64, f64) {
    if failed {
        (OVERLAY_FAILED_WIDTH, OVERLAY_FAILED_HEIGHT)
    } else {
        (OVERLAY_PILL_WIDTH, OVERLAY_PILL_HEIGHT)
    }
}

/// Only the states that carry buttons take clicks: the failure card, and a
/// cancelled pill that still has audio to undo.
fn overlay_takes_clicks(event: &DictationEvent) -> bool {
    event.state == "failed" || (event.state == "cancelled" && event.retained_audio)
}

/// Sizes and (dis)arms the overlay for a state. Most pill states have no
/// controls, so the window ignores the cursor entirely — otherwise clicks in the
/// transparent padding around the pill land on a FalconDeck window and activate
/// the app. Every switch into the failure card also re-shows the overlay, so
/// this never leaves the wider box sitting off-centre.
fn set_overlay_mode(app: &AppHandle, state: &str, takes_clicks: bool) {
    let Some(window) = app.get_webview_window(DICTATION_WINDOW_LABEL) else {
        return;
    };
    let (width, height) = overlay_size(state == "failed");
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.set_ignore_cursor_events(!takes_clicks);
}

/// `width` is the logical width just requested; reading `outer_size()` back
/// immediately after a resize can still report the previous size and would
/// centre the overlay off by the difference.
fn position_overlay(app: &AppHandle, width: f64) {
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
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let window_width = (width * scale).round() as u32;
    let work_area = monitor.work_area();
    let x = work_area.position.x + ((work_area.size.width.saturating_sub(window_width)) / 2) as i32;
    let top_gap = (12.0 * scale).round() as i32;
    let y = work_area.position.y + top_gap;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn show_overlay(app: &AppHandle, state: &str) {
    set_overlay_mode(app, state, state == "failed");
    position_overlay(app, overlay_size(state == "failed").0);
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

/// The cancelled take stays on disk only while the overlay still offers Undo;
/// when the window closes, the audio goes with it.
fn close_undo_window_after(app: AppHandle, generation: u64, delay: Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if SESSION_GENERATION.load(Ordering::Acquire) != generation {
            return;
        }
        if let Some(window) = app.get_webview_window(DICTATION_WINDOW_LABEL) {
            let _ = window.hide();
        }
        #[cfg(target_os = "macos")]
        unsafe {
            fd_dictation_drop_cancelled();
        }
    });
}

fn emit_event(app: &AppHandle, event: DictationEvent) {
    set_overlay_mode(app, event.state, overlay_takes_clicks(&event));
    let _ = app.emit(DICTATION_EVENT, &event);
}

fn emit_failure(app: &AppHandle, message: String, retained_audio: bool) {
    emit_failure_with_transcript(app, message, retained_audio, None);
}

/// A failure that still produced a transcript surfaces it so the overlay can
/// offer a clipboard copy instead of losing the words.
fn emit_failure_with_transcript(
    app: &AppHandle,
    message: String,
    retained_audio: bool,
    transcript: Option<String>,
) {
    SESSION_GENERATION.fetch_add(1, Ordering::AcqRel);
    show_overlay(app, "failed");
    emit_event(
        app,
        DictationEvent {
            state: "failed",
            text: transcript,
            error: Some(message),
            retained_audio,
        },
    );
}

fn remember_transcript(text: &str) {
    if text.is_empty() {
        return;
    }
    if let Ok(mut last) = LAST_TRANSCRIPT.write() {
        *last = Some(text.to_string());
    }
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
        .ok_or_else(|| "FalconDeck is not connected.".to_string())?;
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
        return Err(
            "No speech was detected. Your recording is safe, so you can retry.".to_string(),
        );
    }
    remember_transcript(&text);

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
            emit_failure_with_transcript(
                &finish_app,
                "The transcript is ready, but FalconDeck could not paste it. Copy it below or retry."
                    .to_string(),
                true,
                Some(text.clone()),
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
            show_overlay(&app, "recording");
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
            remember_transcript(&payload);
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
        // Esc during a take: the audio survives for the undo window, so the
        // pill stays up long enough to offer it back.
        event_kind::CANCELLED_RETAINED => {
            let generation = SESSION_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
            emit_event(
                &app,
                DictationEvent {
                    state: "cancelled",
                    text: None,
                    error: None,
                    retained_audio: true,
                },
            );
            close_undo_window_after(app, generation, CANCEL_UNDO_WINDOW);
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
        // The paste target is FalconDeck itself: native paste is unreliable
        // against the webview, so the transcript goes straight to the frontend
        // for a deterministic composer insertion.
        event_kind::SELF_INSERT => {
            remember_transcript(&payload);
            let _ = app.emit_to(MAIN_WINDOW_LABEL, DICTATION_INSERT_EVENT, payload);
        }
        event_kind::PASTE_FAILED => {
            remember_transcript(&payload);
            emit_failure_with_transcript(
                &app,
                "The transcript is ready, but FalconDeck could not paste it. Copy it below or retry."
                    .to_string(),
                true,
                Some(payload),
            );
        }
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
            ("SelfInsert", super::event_kind::SELF_INSERT),
            ("PasteFailed", super::event_kind::PASTE_FAILED),
            ("CancelledRetained", super::event_kind::CANCELLED_RETAINED),
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
