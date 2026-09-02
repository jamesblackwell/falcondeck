use std::{
    ffi::{CStr, CString},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        LazyLock, OnceLock, RwLock,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition};

use crate::dictation_history;

const DICTATION_WINDOW_LABEL: &str = "dictation";
const MAIN_WINDOW_LABEL: &str = "main";
const DICTATION_EVENT: &str = "falcondeck://dictation-state";
const DICTATION_LEVEL_EVENT: &str = "falcondeck://dictation-level";
const DICTATION_INSERT_EVENT: &str = "falcondeck://dictation-insert";
const MAX_RECORDING_BYTES: u64 = 8 * 1024 * 1024;
// Overlay geometry in logical points. The pill is a compact status strip; the
// failure card needs the wider, taller box so its message and buttons lay out
// on one line each. A paste failure also has to show the transcript itself —
// the shorter box was sized before that preview existed and clipped the
// actions behind overflow:hidden.
const OVERLAY_PILL_WIDTH: f64 = 504.0;
const OVERLAY_PILL_HEIGHT: f64 = 84.0;
const OVERLAY_FAILED_WIDTH: f64 = 720.0;
const OVERLAY_FAILED_HEIGHT: f64 = 156.0;
const OVERLAY_FAILED_WITH_TRANSCRIPT_HEIGHT: f64 = 252.0;
// Client-side ceiling for a short dictation. Long recordings scale this up so
// the daemon's own (longer) budget is what decides the outcome; see
// `transcription_timeout`.
const BASE_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(1500);
// 32 kbps mono AAC: a second of speech is about 4 kB.
const RECORDING_BYTES_PER_SECOND: f64 = 4_000.0;
// How long the cancelled pill stays up offering Undo. Mirrored by
// UNDO_WINDOW_SECONDS in DictationOverlay.tsx, which counts it down.
const CANCEL_UNDO_WINDOW: Duration = Duration::from_secs(10);
// External apps cannot acknowledge a synthetic paste reliably. Keep the
// completed transcript reachable long enough for the writer to notice a miss
// and explicitly copy it to the clipboard.
const COMPLETED_FALLBACK_WINDOW: Duration = Duration::from_secs(8);

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static CONFIG: LazyLock<RwLock<DictationConfiguration>> =
    LazyLock::new(|| RwLock::new(DictationConfiguration::default()));
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(0);
static NEXT_TRANSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_OPENROUTER_TRANSCRIPTION: AtomicU64 = AtomicU64::new(0);
// The most recent transcript, kept so the writer can re-insert it (Cmd+Shift+V
// in the app) or copy it after a failed paste. Session-scoped on purpose.
static LAST_TRANSCRIPT: RwLock<Option<String>> = RwLock::new(None);
static REWRITE_SELECTION: RwLock<Option<String>> = RwLock::new(None);
static REWRITE_ACTIVE: AtomicBool = AtomicBool::new(false);

// Timeouts are per request rather than per client: a 30-second dictation and
// a 30-minute one deserve very different ceilings.
static OPENROUTER_CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().build().unwrap_or_default());

#[derive(Clone, Debug)]
struct RecordedAudio {
    path: PathBuf,
    duration_seconds: Option<f64>,
}

/// The recording the native side is currently working on, so a transcript or
/// a failure arriving from Apple Speech can be filed against its audio.
static CURRENT_RECORDING: RwLock<Option<RecordedAudio>> = RwLock::new(None);

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
    pub const AUDIO_RECORDED: i32 = 10;
    pub const REWRITE_SELECTION: i32 = 12;
    pub const REWRITE_INSTRUCTION: i32 = 13;
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
    /// Modifier-only ids (`right_command`) or chords (`Mod+Shift+D`).
    #[serde(default = "default_dictation_shortcut")]
    pub shortcut: String,
    pub activation: DictationActivation,
    pub provider: DictationProvider,
    pub input_device_id: Option<String>,
    pub daemon_url: Option<String>,
    pub model: String,
    /// Tried straight after `model`, ideally from a different vendor.
    #[serde(default)]
    pub fallback_model: Option<String>,
    /// Hours a recording is kept on this computer so a bad transcript can be
    /// retried. Zero deletes audio as soon as the transcript is pasted.
    #[serde(default)]
    pub history_retention_hours: u32,
    /// Hold a second shortcut over selected text and speak how to edit it.
    #[serde(default)]
    pub rewrite_enabled: bool,
    #[serde(default = "default_rewrite_shortcut")]
    pub rewrite_shortcut: String,
    #[serde(default = "default_rewrite_model")]
    pub rewrite_model: String,
    #[serde(default)]
    pub rewrite_prompt: Option<String>,
}

fn default_rewrite_model() -> String {
    "openai/gpt-5.6-luna".to_string()
}

fn default_rewrite_shortcut() -> String {
    "right_option".to_string()
}

fn default_dictation_shortcut() -> String {
    "right_command".to_string()
}

impl Default for DictationConfiguration {
    fn default() -> Self {
        Self {
            enabled: false,
            shortcut: default_dictation_shortcut(),
            activation: DictationActivation::Hold,
            provider: DictationProvider::System,
            input_device_id: None,
            daemon_url: None,
            model: "openai/gpt-4o-mini-transcribe".to_string(),
            fallback_model: Some("mistralai/voxtral-mini-transcribe".to_string()),
            history_retention_hours: 6,
            rewrite_enabled: false,
            rewrite_shortcut: default_rewrite_shortcut(),
            rewrite_model: default_rewrite_model(),
            rewrite_prompt: None,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<&'static str>,
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
#[serde(rename_all = "snake_case")]
struct TranscriptionRequest {
    audio_base64: String,
    format: &'static str,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_model: Option<String>,
    duration_seconds: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct RewriteRequest {
    selection: String,
    instruction: String,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn fd_dictation_configure(
        enabled: bool,
        shortcut: *const std::ffi::c_char,
        activation_mode: i32,
        provider: i32,
        input_device_id: *const std::ffi::c_char,
        retain_recordings: bool,
        rewrite_enabled: bool,
        rewrite_shortcut: *const std::ffi::c_char,
    );
    fn fd_dictation_retained_recording_path() -> *mut std::ffi::c_char;
    fn fd_dictation_retained_recording_duration_seconds() -> f64;
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
    fn fd_dictation_make_overlay_nonactivating(window: *mut std::ffi::c_void) -> bool;
    fn fd_dictation_paste_text(text: *const std::ffi::c_char) -> bool;
    #[cfg(test)]
    fn fd_dictation_test_overlay_panel_contract() -> bool;
    #[cfg(test)]
    fn fd_dictation_test_transient_pasteboard_round_trip() -> bool;
    #[cfg(test)]
    fn fd_dictation_test_recording_duration_is_usable(duration_seconds: f64) -> bool;
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
    let window = tauri::WebviewWindowBuilder::new(
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
    .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let native_window = window.ns_window().map_err(|error| error.to_string())?;
        // A non-focusable NSWindow still activates its owning application on a
        // mouse-down. The overlay has real controls in its terminal states, so
        // make it a native non-activating panel before any state enables clicks.
        if !unsafe { fd_dictation_make_overlay_nonactivating(native_window) } {
            return Err("could not make the dictation overlay non-activating".to_string());
        }
    }

    // Start click-through; event state changes arm the pill only when it has a
    // Copy, Retry, Discard, or Undo control.
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())
}

fn rewrite_mode() -> Option<&'static str> {
    REWRITE_ACTIVE.load(Ordering::Acquire).then_some("rewrite")
}

fn clear_rewrite_session() {
    REWRITE_ACTIVE.store(false, Ordering::Release);
    if let Ok(mut selection) = REWRITE_SELECTION.write() {
        *selection = None;
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
    if config.rewrite_model.trim().is_empty() || config.rewrite_model.len() > 200 {
        return Err("The rewrite model is invalid.".to_string());
    }
    if config
        .rewrite_prompt
        .as_deref()
        .is_some_and(|prompt| prompt.chars().count() > 8_000)
    {
        return Err("The rewrite prompt is too long.".to_string());
    }
    if config.rewrite_enabled {
        let daemon_url = config.daemon_url.as_deref().unwrap_or_default();
        validate_local_daemon_url(daemon_url)?;
    }
    if config
        .fallback_model
        .as_deref()
        .is_some_and(|model| model.trim().is_empty() || model.len() > 200)
    {
        return Err("The fallback transcription model is invalid.".to_string());
    }
    if config.shortcut.trim().is_empty() || config.shortcut.len() > 64 {
        return Err("The dictation shortcut is invalid.".to_string());
    }
    if config.rewrite_shortcut.trim().is_empty() || config.rewrite_shortcut.len() > 64 {
        return Err("The rewrite shortcut is invalid.".to_string());
    }
    // A shortened retention window has to take effect immediately, not at the
    // next dictation: the writer just asked for that audio to be gone. The
    // deletions happen off this thread — configure is called from the UI.
    let retention_hours = config.history_retention_hours;
    tauri::async_runtime::spawn_blocking(move || {
        dictation_history::prune(&dictation_temp_dir(), retention_hours);
    });

    #[cfg(target_os = "macos")]
    unsafe {
        let input_device_id = config
            .input_device_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(CString::new)
            .transpose()
            .map_err(|_| "The selected microphone identifier is invalid.".to_string())?;
        let shortcut = CString::new(config.shortcut.trim())
            .map_err(|_| "The dictation shortcut is invalid.".to_string())?;
        let rewrite_shortcut = CString::new(config.rewrite_shortcut.trim())
            .map_err(|_| "The rewrite shortcut is invalid.".to_string())?;
        fd_dictation_configure(
            config.enabled,
            shortcut.as_ptr(),
            activation_code(config.activation),
            provider_code(config.provider),
            input_device_id
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            config.history_retention_hours > 0,
            config.rewrite_enabled,
            rewrite_shortcut.as_ptr(),
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
pub fn dismiss_dictation_overlay() {
    if let Some(app) = APP_HANDLE.get() {
        if let Some(window) = app.get_webview_window(DICTATION_WINDOW_LABEL) {
            let _ = window.hide();
        }
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

fn current_dictation_config() -> Result<DictationConfiguration, String> {
    CONFIG
        .read()
        .map_err(|_| "Dictation settings are unavailable.".to_string())
        .map(|config| config.clone())
}

/// Stops the overlay from offering to retry a recording that history has just
/// transcribed. Only clears the native pointer when it still refers to this
/// recording, so a different pending one is left alone.
#[cfg(target_os = "macos")]
fn forget_native_retained_recording(path: &Path) {
    unsafe {
        let value = fd_dictation_retained_recording_path();
        if value.is_null() {
            return;
        }
        let retained = CStr::from_ptr(value).to_string_lossy().into_owned();
        fd_dictation_free_string(value);
        if Path::new(&retained) == path {
            fd_dictation_mark_completed();
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn forget_native_retained_recording(_path: &Path) {}

/// Runs a history operation off the webview's command thread. History does
/// file IO — and a prune can delete a stack of recordings — so none of it
/// belongs anywhere near the UI thread.
async fn run_history_op<T: Send + 'static>(
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("dictation history task failed: {error}"))
}

#[tauri::command]
pub async fn dictation_history() -> Result<Vec<dictation_history::DictationHistoryEntry>, String> {
    let config = current_dictation_config()?;
    run_history_op(move || {
        dictation_history::entries(&dictation_temp_dir(), config.history_retention_hours)
    })
    .await
}

#[tauri::command]
pub async fn dictation_history_delete(id: String) -> Result<bool, String> {
    let config = current_dictation_config()?;
    run_history_op(move || {
        dictation_history::delete(&dictation_temp_dir(), config.history_retention_hours, &id)
    })
    .await
}

#[tauri::command]
pub async fn dictation_history_clear() -> Result<usize, String> {
    run_history_op(|| dictation_history::clear(&dictation_temp_dir())).await
}

/// Transcribes a kept recording again, optionally with a different model.
/// This is the whole reason recordings are kept: a transcript that came back
/// wrong is worth another attempt, and re-recording is not.
#[tauri::command]
pub async fn dictation_history_retry(
    id: String,
    model: Option<String>,
) -> Result<dictation_history::DictationHistoryEntry, String> {
    let config = current_dictation_config()?;
    let retention_hours = config.history_retention_hours;
    let temp_dir = dictation_temp_dir();
    let entry = dictation_history::find(&temp_dir, retention_hours, &id)
        .ok_or_else(|| "That recording is no longer available.".to_string())?;
    let path = PathBuf::from(&entry.path);
    validate_recording_path(&path)?;
    let daemon_url = config
        .daemon_url
        .clone()
        .ok_or_else(|| "FalconDeck is not connected.".to_string())?;
    let model = model
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| config.model.clone());
    if model.len() > 200 {
        return Err("The transcription model is invalid.".to_string());
    }
    let audio = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("Could not read the kept recording: {error}"))?;
    match request_transcription(
        &daemon_url,
        audio,
        model.clone(),
        config.fallback_model.clone(),
        measured_recording_duration(entry.duration_seconds),
    )
    .await
    {
        Ok(transcription) => {
            remember_transcript(&transcription.text);
            forget_native_retained_recording(&path);
            let Transcription { text, model } = transcription;
            // The entry can expire out of the index while the request is in
            // flight. The transcription still succeeded — hand it back on a
            // synthesized row rather than claiming it failed.
            Ok(dictation_history::record_retry(
                &temp_dir,
                &id,
                Some(model.clone()),
                Some(text.clone()),
                None,
                retention_hours,
            )
            .unwrap_or_else(|| dictation_history::DictationHistoryEntry {
                model: Some(model),
                text: Some(text),
                error: None,
                audio_available: path.is_file(),
                ..entry
            }))
        }
        Err(error) => {
            dictation_history::record_retry(
                &temp_dir,
                &id,
                Some(model),
                entry.text,
                Some(error.clone()),
                retention_hours,
            );
            Err(error)
        }
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

fn overlay_size(state: &str, has_transcript: bool) -> (f64, f64) {
    if state == "failed" {
        let height = if has_transcript {
            OVERLAY_FAILED_WITH_TRANSCRIPT_HEIGHT
        } else {
            OVERLAY_FAILED_HEIGHT
        };
        (OVERLAY_FAILED_WIDTH, height)
    } else {
        (OVERLAY_PILL_WIDTH, OVERLAY_PILL_HEIGHT)
    }
}

/// Only states that carry buttons take clicks: failure, a completed transcript
/// with a manual-copy fallback, and a cancelled take that can still be undone.
fn overlay_takes_clicks(event: &DictationEvent) -> bool {
    event.state == "failed"
        || (event.state == "completed" && event.text.is_some())
        || (event.state == "cancelled" && event.retained_audio)
}

/// Sizes and (dis)arms the overlay for a state. Most pill states have no
/// controls, so the window ignores the cursor entirely — otherwise clicks in the
/// transparent padding around the pill land on a FalconDeck window and activate
/// the app. Every switch into the failure card also re-shows the overlay, so
/// this never leaves the wider box sitting off-centre.
fn set_overlay_mode(app: &AppHandle, state: &str, takes_clicks: bool, has_transcript: bool) {
    let Some(window) = app.get_webview_window(DICTATION_WINDOW_LABEL) else {
        return;
    };
    let (width, height) = overlay_size(state, has_transcript);
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

fn show_overlay(app: &AppHandle, state: &str, has_transcript: bool) {
    set_overlay_mode(app, state, state == "failed", has_transcript);
    position_overlay(app, overlay_size(state, has_transcript).0);
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
    set_overlay_mode(
        app,
        event.state,
        overlay_takes_clicks(&event),
        event.text.is_some(),
    );
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
    show_overlay(app, "failed", transcript.is_some());
    let mode = rewrite_mode();
    emit_event(
        app,
        DictationEvent {
            state: "failed",
            text: transcript,
            error: Some(message),
            retained_audio,
            mode,
        },
    );
    if !retained_audio {
        clear_rewrite_session();
    }
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

fn measured_recording_duration(seconds: f64) -> Option<f64> {
    (seconds.is_finite() && seconds > 0.0).then_some(seconds)
}

#[cfg(target_os = "macos")]
fn native_recorded_audio(path: PathBuf) -> RecordedAudio {
    // SAFETY: The native getter synchronizes access to the controller's
    // retained-recording state and returns a scalar value.
    let duration_seconds =
        measured_recording_duration(unsafe { fd_dictation_retained_recording_duration_seconds() });
    RecordedAudio {
        path,
        duration_seconds,
    }
}

/// What the daemon actually managed to transcribe, including which model
/// produced it — the daemon may have fallen through to another one.
struct Transcription {
    text: String,
    model: String,
}

/// Client-side ceiling for one transcription. It sits above the daemon's own
/// per-model budget on purpose: the daemon's error message is far more useful
/// than a bare client timeout, so it should be the one to give up first.
fn transcription_timeout(audio_bytes: usize) -> Duration {
    let audio_seconds = audio_bytes as f64 / RECORDING_BYTES_PER_SECOND;
    (BASE_TRANSCRIPTION_TIMEOUT + Duration::from_secs_f64(audio_seconds * 1.5))
        .min(MAX_TRANSCRIPTION_TIMEOUT)
}

async fn request_transcription(
    daemon_url: &str,
    audio: Vec<u8>,
    model: String,
    fallback_model: Option<String>,
    measured_duration_seconds: Option<f64>,
) -> Result<Transcription, String> {
    let duration_seconds = measured_duration_seconds
        .unwrap_or_else(|| audio.len() as f64 / RECORDING_BYTES_PER_SECOND);
    let response = OPENROUTER_CLIENT
        .post(format!("{daemon_url}/api/speech/transcribe"))
        .timeout(transcription_timeout(audio.len()))
        .json(&TranscriptionRequest {
            audio_base64: STANDARD.encode(audio),
            format: "m4a",
            model: model.clone(),
            fallback_model,
            duration_seconds,
        })
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Transcription timed out. Your recording is retained, so you can retry.".to_string()
            } else {
                format!("OpenRouter transcription failed: {error}")
            }
        })?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .or_else(|| body.get("message").and_then(|value| value.as_str()))
            .map(str::to_string)
            .unwrap_or_else(|| format!("Transcription failed ({})", status.as_u16())));
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
    let model = body
        .get("model")
        .and_then(|value| value.as_str())
        .unwrap_or(&model)
        .to_string();
    Ok(Transcription { text, model })
}

async fn request_rewrite(
    daemon_url: &str,
    selection: String,
    instruction: String,
    model: String,
    prompt: Option<String>,
) -> Result<String, String> {
    let response = OPENROUTER_CLIENT
        .post(format!("{daemon_url}/api/speech/rewrite"))
        .timeout(Duration::from_secs(45))
        .json(&RewriteRequest {
            selection,
            instruction,
            model,
            prompt,
        })
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "The rewrite timed out. Your recording is retained, so you can retry.".to_string()
            } else {
                format!("Rewrite failed: {error}")
            }
        })?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .or_else(|| body.get("message").and_then(|value| value.as_str()))
            .map(str::to_string)
            .unwrap_or_else(|| format!("Rewrite failed ({})", status.as_u16())));
    }
    let text = body
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("The rewrite model returned empty text.".to_string());
    }
    Ok(text)
}

fn emit_rewriting(app: &AppHandle) {
    show_overlay(app, "rewriting", false);
    emit_event(
        app,
        DictationEvent {
            state: "rewriting",
            text: None,
            error: None,
            retained_audio: true,
            mode: Some("rewrite"),
        },
    );
}

/// Keeps the recording for the retention window, or deletes it when history
/// is switched off. Either way the audio stops being the recorder's problem.
fn file_recording(
    path: &Path,
    duration_seconds: Option<f64>,
    provider: &str,
    model: Option<String>,
    text: Option<String>,
    error: Option<String>,
    retention_hours: u32,
) {
    let kept = dictation_history::record(
        &dictation_temp_dir(),
        path,
        dictation_history::RecordingOutcome {
            duration_seconds,
            provider,
            model,
            text,
            error,
        },
        retention_hours,
    );
    if !kept {
        let _ = std::fs::remove_file(path);
    }
}

/// Files a recording without ever deleting it, detached from the caller's
/// thread. For paths where the audio must survive a declined filing — the
/// native side still retains it for the overlay's Retry.
fn record_recording_detached(
    path: PathBuf,
    duration_seconds: Option<f64>,
    provider: &'static str,
    model: Option<String>,
    text: Option<String>,
    error: Option<String>,
    retention_hours: u32,
) {
    tauri::async_runtime::spawn_blocking(move || {
        dictation_history::record(
            &dictation_temp_dir(),
            &path,
            dictation_history::RecordingOutcome {
                duration_seconds,
                provider,
                model,
                text,
                error,
            },
            retention_hours,
        );
    });
}

/// `file_recording`, but detached: the success and paste-failed paths run on
/// the main thread, which must not wait on index IO and expiry deletions.
fn file_recording_detached(
    path: PathBuf,
    duration_seconds: Option<f64>,
    provider: &'static str,
    model: Option<String>,
    text: Option<String>,
    error: Option<String>,
    retention_hours: u32,
) {
    tauri::async_runtime::spawn_blocking(move || {
        file_recording(
            &path,
            duration_seconds,
            provider,
            model,
            text,
            error,
            retention_hours,
        );
    });
}

async fn transcribe_openrouter(
    app: AppHandle,
    recording: RecordedAudio,
    transcription_id: u64,
) -> Result<(), String> {
    let RecordedAudio {
        path,
        duration_seconds,
    } = recording;
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
    let retention_hours = config.history_retention_hours;
    let transcription = match request_transcription(
        daemon_url,
        audio,
        config.model.clone(),
        config.fallback_model.clone(),
        duration_seconds,
    )
    .await
    {
        Ok(transcription) => transcription,
        Err(error) => {
            // The audio stays put either way — the native side retains it for
            // the overlay's Retry — but filing it here is what lets the writer
            // come back later and retry with a different model.
            dictation_history::record(
                &dictation_temp_dir(),
                &path,
                dictation_history::RecordingOutcome {
                    duration_seconds,
                    provider: "open_router",
                    model: Some(config.model.clone()),
                    text: None,
                    error: Some(error.clone()),
                },
                retention_hours,
            );
            return Err(error);
        }
    };
    let Transcription { text, model } = transcription;
    let text = if REWRITE_ACTIVE.load(Ordering::Acquire) {
        let selection = REWRITE_SELECTION
            .read()
            .ok()
            .and_then(|guard| guard.clone())
            .filter(|value| !value.trim().is_empty());
        let Some(selection) = selection else {
            return Err(
                "Select text first, then hold the rewrite shortcut and say how to edit it."
                    .to_string(),
            );
        };
        emit_rewriting(&app);
        request_rewrite(
            daemon_url,
            selection,
            text,
            config.rewrite_model.clone(),
            config.rewrite_prompt.clone(),
        )
        .await?
    } else {
        text
    };
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
            record_recording_detached(
                path.clone(),
                duration_seconds,
                "open_router",
                Some(model),
                Some(text.clone()),
                None,
                retention_hours,
            );
            emit_failure_with_transcript(
                &finish_app,
                if rewrite_mode().is_some() {
                    "The rewrite is ready, but FalconDeck could not paste it. Copy it below or retry."
                        .to_string()
                } else {
                    "The transcript is ready, but FalconDeck could not paste it. Copy it below or retry."
                        .to_string()
                },
                true,
                Some(text.clone()),
            );
            return;
        }
        file_recording_detached(
            path.clone(),
            duration_seconds,
            "open_router",
            Some(model),
            Some(text.clone()),
            None,
            retention_hours,
        );
        #[cfg(target_os = "macos")]
        unsafe {
            fd_dictation_mark_completed();
        }
        let generation = SESSION_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
        let mode = rewrite_mode();
        if mode.is_some() {
            clear_rewrite_session();
        }
        emit_event(
            &finish_app,
            DictationEvent {
                state: "completed",
                text: Some(text),
                error: None,
                retained_audio: false,
                mode,
            },
        );
        hide_overlay_after(finish_app, generation, COMPLETED_FALLBACK_WINDOW);
    })
    .map_err(|error| error.to_string())
}

/// Files the recording the native recorder is working on. Deletion stays with
/// the native side for this path — a failed transcript keeps its audio for the
/// overlay's Retry — so this only ever adds to history.
fn file_native_recording(text: Option<String>, error: Option<String>) {
    let Some(recording) = CURRENT_RECORDING
        .write()
        .ok()
        .and_then(|mut current| current.take())
    else {
        return;
    };
    let RecordedAudio {
        path,
        duration_seconds,
    } = recording;
    let Ok(config) = current_dictation_config() else {
        return;
    };
    record_recording_detached(
        path,
        duration_seconds,
        "system",
        None,
        text,
        error,
        config.history_retention_hours,
    );
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
            let rewrite = payload == "rewrite";
            REWRITE_ACTIVE.store(rewrite, Ordering::Release);
            if !rewrite {
                if let Ok(mut selection) = REWRITE_SELECTION.write() {
                    *selection = None;
                }
            }
            SESSION_GENERATION.fetch_add(1, Ordering::AcqRel);
            show_overlay(&app, "recording", false);
            emit_event(
                &app,
                DictationEvent {
                    state: "recording",
                    text: None,
                    error: None,
                    retained_audio: false,
                    mode: rewrite.then_some("rewrite"),
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
                mode: rewrite_mode(),
            },
        ),
        event_kind::COMPLETED => {
            remember_transcript(&payload);
            file_native_recording(Some(payload.clone()), None);
            let mode = rewrite_mode();
            if mode.is_some() {
                clear_rewrite_session();
            }
            let generation = SESSION_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
            emit_event(
                &app,
                DictationEvent {
                    state: "completed",
                    text: Some(payload),
                    error: None,
                    retained_audio: false,
                    mode,
                },
            );
            hide_overlay_after(app, generation, COMPLETED_FALLBACK_WINDOW);
        }
        event_kind::FAILED => emit_failure(&app, payload, false),
        event_kind::CANCELLED => {
            // The native side deletes cancelled audio, so there is nothing to
            // keep — just stop tracking it.
            let _ = CURRENT_RECORDING.write().map(|mut current| current.take());
            let mode = rewrite_mode();
            clear_rewrite_session();
            let generation = SESSION_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
            emit_event(
                &app,
                DictationEvent {
                    state: "cancelled",
                    text: None,
                    error: None,
                    retained_audio: false,
                    mode,
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
                    mode: rewrite_mode(),
                },
            );
            close_undo_window_after(app, generation, CANCEL_UNDO_WINDOW);
        }
        event_kind::REWRITE_SELECTION => {
            if let Ok(mut selection) = REWRITE_SELECTION.write() {
                *selection = Some(payload);
            }
            REWRITE_ACTIVE.store(true, Ordering::Release);
        }
        event_kind::REWRITE_INSTRUCTION => {
            let instruction = payload;
            let selection = REWRITE_SELECTION
                .read()
                .ok()
                .and_then(|guard| guard.clone())
                .filter(|value| !value.trim().is_empty());
            let Some(selection) = selection else {
                emit_failure(
                    &app,
                    "Select text first, then hold the rewrite shortcut and say how to edit it."
                        .to_string(),
                    true,
                );
                return;
            };
            emit_rewriting(&app);
            tauri::async_runtime::spawn(async move {
                let config = match current_dictation_config() {
                    Ok(config) => config,
                    Err(error) => {
                        emit_failure(&app, error, true);
                        return;
                    }
                };
                let Some(daemon_url) = config.daemon_url.clone() else {
                    emit_failure(&app, "FalconDeck is not connected.".to_string(), true);
                    return;
                };
                match request_rewrite(
                    &daemon_url,
                    selection,
                    instruction,
                    config.rewrite_model,
                    config.rewrite_prompt,
                )
                .await
                {
                    Ok(text) => {
                        remember_transcript(&text);
                        let finish_app = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            let Ok(c_text) = CString::new(text.as_str()) else {
                                emit_failure(
                                    &finish_app,
                                    "The rewrite contained unsupported text.".to_string(),
                                    true,
                                );
                                return;
                            };
                            let pasted = unsafe { fd_dictation_paste_text(c_text.as_ptr()) };
                            if !pasted {
                                file_native_recording(Some(text.clone()), None);
                                emit_failure_with_transcript(
                                    &finish_app,
                                    "The rewrite is ready, but FalconDeck could not paste it. Copy it below or retry."
                                        .to_string(),
                                    true,
                                    Some(text.clone()),
                                );
                                return;
                            }
                            file_native_recording(Some(text.clone()), None);
                            unsafe {
                                fd_dictation_mark_completed();
                            }
                            let mode = rewrite_mode();
                            clear_rewrite_session();
                            let generation =
                                SESSION_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
                            emit_event(
                                &finish_app,
                                DictationEvent {
                                    state: "completed",
                                    text: Some(text),
                                    error: None,
                                    retained_audio: false,
                                    mode,
                                },
                            );
                            hide_overlay_after(
                                finish_app,
                                generation,
                                COMPLETED_FALLBACK_WINDOW,
                            );
                        });
                    }
                    Err(error) => emit_failure(&app, error, true),
                }
            });
        }
        event_kind::AUDIO_READY => {
            let recording = native_recorded_audio(PathBuf::from(payload));
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
                if let Err(error) =
                    transcribe_openrouter(app.clone(), recording, transcription_id).await
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
        event_kind::FAILED_RETAINED => {
            file_native_recording(None, Some(payload.clone()));
            emit_failure(&app, payload, true);
        }
        // Apple Speech transcribes in-process, so this is the only chance to
        // learn which file the transcript (or failure) will belong to.
        event_kind::AUDIO_RECORDED => {
            if let Ok(mut current) = CURRENT_RECORDING.write() {
                *current = Some(native_recorded_audio(PathBuf::from(payload)));
            }
        }
        // The paste target is FalconDeck itself: native paste is unreliable
        // against the webview, so the transcript goes straight to the frontend
        // for a deterministic composer insertion.
        event_kind::SELF_INSERT => {
            remember_transcript(&payload);
            let _ = app.emit_to(MAIN_WINDOW_LABEL, DICTATION_INSERT_EVENT, payload);
        }
        event_kind::PASTE_FAILED => {
            remember_transcript(&payload);
            file_native_recording(Some(payload.clone()), None);
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
        dictation_audio_devices, measured_recording_duration, parse_audio_level, permission_label,
        validate_local_daemon_url, validate_recording_path,
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
            ("AudioRecorded", super::event_kind::AUDIO_RECORDED),
            ("RewriteSelection", super::event_kind::REWRITE_SELECTION),
            ("RewriteInstruction", super::event_kind::REWRITE_INSTRUCTION),
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

    #[cfg(target_os = "macos")]
    #[test]
    fn overlay_panel_does_not_activate_falcondeck() {
        assert!(unsafe { super::fd_dictation_test_overlay_panel_contract() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn transient_pasteboard_round_trip_preserves_items_and_detects_new_owner() {
        assert!(unsafe { super::fd_dictation_test_transient_pasteboard_round_trip() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_recorder_rejects_startup_artifacts_but_accepts_speech() {
        assert!(!unsafe { super::fd_dictation_test_recording_duration_is_usable(0.020) });
        assert!(unsafe { super::fd_dictation_test_recording_duration_is_usable(0.250) });
    }

    #[test]
    fn permission_label_preserves_unsupported_platform_state() {
        assert_eq!(permission_label(3), "unsupported");
    }

    #[test]
    fn overlay_grows_when_a_failed_paste_still_has_a_transcript() {
        assert_eq!(
            super::overlay_size("failed", false),
            (super::OVERLAY_FAILED_WIDTH, super::OVERLAY_FAILED_HEIGHT)
        );
        assert_eq!(
            super::overlay_size("failed", true),
            (
                super::OVERLAY_FAILED_WIDTH,
                super::OVERLAY_FAILED_WITH_TRANSCRIPT_HEIGHT
            )
        );
        assert_eq!(
            super::overlay_size("recording", true),
            (super::OVERLAY_PILL_WIDTH, super::OVERLAY_PILL_HEIGHT)
        );
        assert!(super::OVERLAY_FAILED_WITH_TRANSCRIPT_HEIGHT > super::OVERLAY_FAILED_HEIGHT);
    }

    #[test]
    fn audio_level_payload_is_validated_and_clamped() {
        assert_eq!(parse_audio_level("0.42"), Some(0.42));
        assert_eq!(parse_audio_level("2"), Some(1.0));
        assert_eq!(parse_audio_level("-1"), Some(0.0));
        assert_eq!(parse_audio_level("not-a-level"), None);
    }

    #[test]
    fn measured_recording_duration_rejects_invalid_values() {
        assert_eq!(measured_recording_duration(7.68), Some(7.68));
        assert_eq!(measured_recording_duration(0.0), None);
        assert_eq!(measured_recording_duration(f64::NAN), None);
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
