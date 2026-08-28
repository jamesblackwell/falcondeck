#[cfg(test)]
use std::sync::OnceLock;
#[cfg(not(test))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex as StdMutex};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    task::spawn_blocking,
    time::{Duration, Instant, timeout},
};

use super::AppState;
use crate::error::DaemonError;

#[cfg(not(test))]
const SPEECH_SECRET_KEY: &str = "speech.openrouter-api-key";
#[cfg(not(test))]
const KEYRING_SERVICE: &str = "com.falcondeck.daemon.speech";
#[cfg(not(test))]
const KEYRING_ACCOUNT: &str = "openrouter-api-key";
const OPENROUTER_TRANSCRIPTIONS_URL: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const OPENROUTER_SPEECH_URL: &str = "https://openrouter.ai/api/v1/audio/speech";
const OPENROUTER_MODELS_URL: &str =
    "https://openrouter.ai/api/v1/models?output_modalities=transcription";
// Base64 audio is encrypted and base64-encoded again by the relay protocol.
// Eight MiB keeps the outer WebSocket message below the relay's 16 MiB cap.
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
const SPEECH_STORAGE: &str = "daemon_secret_store";
// Stay under the phone's 8-second speech.status deadline so a parked
// one-shot Keychain migration surfaces the daemon error, not a relay timeout.
const SPEECH_SECRET_TIMEOUT: Duration = Duration::from_secs(5);
// Ceiling for a single transcription attempt on a short dictation. Long
// recordings scale this up; see `transcription_timeout`.
const BASE_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(70);
// Even a 30-minute dictation should not hold a request open longer than this.
const MAX_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(480);
// Remote clients have a roughly 30-second relay RPC budget. Keep this below
// it so cancellation reaches OpenRouter before the client gives up.
const SYNTHESIS_TIMEOUT: Duration = Duration::from_secs(25);
const READ_ALOUD_MODEL: &str = "x-ai/grok-voice-tts-1.0";
const READ_ALOUD_VOICE: &str = "Eve";
// Grok Voice accepts up to 15,000 characters. Keeping the relay payload below
// its encrypted WebSocket limit also makes cancellation feel immediate.
const MAX_READ_ALOUD_CHARS: usize = 8_000;
// Wall-clock budget for the whole fallback chain on a short dictation.
// Without it, several slow models can each consume the full request timeout
// and hold the client for minutes before the error surfaces. Long recordings
// scale this up; see `fallback_budget`.
const BASE_FALLBACK_BUDGET: Duration = Duration::from_secs(30);
const MAX_FALLBACK_BUDGET: Duration = Duration::from_secs(900);
// An attempt that cannot get at least this much of the budget is not worth
// starting; return the last real error instead.
const MIN_ATTEMPT_TIME: Duration = Duration::from_secs(5);
// How long a connection attempt to OpenRouter may take before the fallback
// chain moves on. Distinct from the per-request timeout: a stalled network
// should fail in seconds, while a legitimately long transcription may not.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(20);
// Ordered by measured accuracy-per-second on real dictation audio
// (Aug 2026 benchmark: gpt-4o-mini and nova-3 tied for accuracy at ~1s and
// ~0.8s; whisper-turbo and parakeet are the fast safety nets).
const FALLBACK_MODELS: [&str; 4] = [
    "openai/gpt-4o-mini-transcribe",
    "deepgram/nova-3",
    "openai/whisper-large-v3-turbo",
    "nvidia/parakeet-tdt-0.6b-v3",
];

// OpenAI's transcription family rejects audio longer than 1500 s outright, so
// a long dictation has to reach a long-form model before the chain runs out.
// Everything else here streams arbitrary lengths.
const MODEL_AUDIO_LIMIT: Duration = Duration::from_secs(1500);
const DURATION_CAPPED_MODELS: [&str; 4] = [
    "openai/gpt-4o-mini-transcribe",
    "openai/gpt-4o-transcribe",
    "openai/gpt-transcribe",
    "openai/whisper-1",
];
// Recording length is what actually drives transcription time, but not every
// client knows it. These are deliberately generous bytes-per-second floors so
// a missing duration over-estimates (a longer ceiling) rather than cutting a
// legitimate transcription short.
const COMPRESSED_BYTES_PER_SECOND: f64 = 4_000.0;
const UNCOMPRESSED_BYTES_PER_SECOND: f64 = 32_000.0;

/// One client for every OpenRouter call. Reusing the pool skips the DNS +
/// TCP + TLS handshake on each dictation after the first; timeouts are set
/// per request because transcription and synthesis have different budgets.
static OPENROUTER_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .unwrap_or_default()
});

#[derive(Debug, Deserialize)]
pub struct SaveSpeechCredentialRequest {
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct SpeechCredentialStatus {
    pub configured: bool,
    pub storage: &'static str,
}

#[derive(Debug, Deserialize)]
pub struct SpeechTranscriptionRequest {
    pub audio_base64: String,
    pub format: String,
    pub model: String,
    #[serde(default)]
    pub language: Option<String>,
    /// Tried right after the preferred model. Clients set this to a different
    /// vendor so one provider outage cannot take out both attempts.
    #[serde(default)]
    pub fallback_model: Option<String>,
    /// Recording length, when the client measured it. Drives the request
    /// timeout and the ordering of duration-capped models.
    #[serde(default)]
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct SpeechTranscriptionResponse {
    pub text: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
pub struct SpeechSynthesisRequest {
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct SpeechSynthesisResponse {
    pub audio_base64: String,
    pub mime_type: String,
}

#[derive(Debug, Serialize)]
pub struct SpeechModel {
    pub id: String,
    pub name: String,
}

/// In-process cache for the OpenRouter credential so status and transcribe
/// do not re-read the host secret store on every call.
#[derive(Default)]
pub(super) struct SpeechCredentialCache {
    key: StdMutex<Option<String>>,
}

impl AppState {
    pub async fn speech_models(&self) -> Result<Vec<SpeechModel>, DaemonError> {
        let response = OPENROUTER_CLIENT
            .get(OPENROUTER_MODELS_URL)
            .timeout(MODEL_LIST_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                DaemonError::Process(format!("failed to load transcription models: {error}"))
            })?;
        if !response.status().is_success() {
            return Err(DaemonError::Process(format!(
                "OpenRouter model request failed ({})",
                response.status().as_u16()
            )));
        }
        let body = response.json::<Value>().await.map_err(|error| {
            DaemonError::Process(format!("invalid OpenRouter model response: {error}"))
        })?;
        let mut models = body
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model.get("id")?.as_str()?.to_string();
                let name = model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string();
                Some(SpeechModel { id, name })
            })
            .collect::<Vec<_>>();
        models.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(models)
    }

    pub async fn speech_credential_status(&self) -> Result<SpeechCredentialStatus, DaemonError> {
        let configured = self.openrouter_key_cached().await?.is_some();
        Ok(SpeechCredentialStatus {
            configured,
            storage: SPEECH_STORAGE,
        })
    }

    pub async fn save_speech_credential(
        &self,
        api_key: String,
    ) -> Result<SpeechCredentialStatus, DaemonError> {
        let api_key = api_key.trim().to_string();
        if api_key.is_empty() || api_key.len() > 512 {
            return Err(DaemonError::BadRequest(
                "invalid OpenRouter API key".to_string(),
            ));
        }
        let cached = api_key.clone();
        run_secret_store_op(move || save_openrouter_key(&api_key)).await?;
        *self.inner.speech_credentials.key.lock().unwrap() = Some(cached);
        Ok(SpeechCredentialStatus {
            configured: true,
            storage: SPEECH_STORAGE,
        })
    }

    pub async fn delete_speech_credential(&self) -> Result<SpeechCredentialStatus, DaemonError> {
        // Drop the cache first so a failed delete can only under-report, never
        // serve a key the user asked to remove.
        *self.inner.speech_credentials.key.lock().unwrap() = None;
        run_secret_store_op(delete_openrouter_key).await?;
        Ok(SpeechCredentialStatus {
            configured: false,
            storage: SPEECH_STORAGE,
        })
    }

    /// The OpenRouter key, from cache when possible, from the host secret
    /// store otherwise.
    async fn openrouter_key_cached(&self) -> Result<Option<String>, DaemonError> {
        if let Some(key) = self.inner.speech_credentials.key.lock().unwrap().clone() {
            return Ok(Some(key));
        }
        let key = run_secret_store_op(load_openrouter_key).await?;
        if let Some(key) = &key {
            *self.inner.speech_credentials.key.lock().unwrap() = Some(key.clone());
        }
        Ok(key)
    }

    pub async fn transcribe_speech(
        &self,
        request: SpeechTranscriptionRequest,
    ) -> Result<SpeechTranscriptionResponse, DaemonError> {
        validate_audio_format(&request.format)?;
        // Decoded once up front: OpenRouter's transcription endpoint accepts
        // multipart uploads (verified live against every provider family), so
        // sending raw bytes shaves the 33% base64 inflation off every upload.
        let audio = decode_base64_audio(&request.audio_base64)?;
        let api_key = self.openrouter_key_cached().await?.ok_or_else(|| {
            DaemonError::BadRequest(
                "OpenRouter is not configured on the connected desktop".to_string(),
            )
        })?;
        let audio_duration =
            estimated_audio_duration(request.duration_seconds, audio.len(), &request.format);
        let models = fallback_models(
            &request.model,
            request.fallback_model.as_deref(),
            audio_duration,
        );
        let request_timeout = transcription_timeout(audio_duration);
        // The extension tells OpenRouter the container format.
        let file_name = format!("audio.{}", request.format);
        let language = request
            .language
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let mut last_error = "Transcription failed".to_string();
        let fallback_deadline = Instant::now() + fallback_budget(audio_duration);

        for model in models {
            // Cap each attempt to what is left of the budget: a hung provider
            // must not eat the whole window and starve the fallback models.
            // The typical transcription finishes in one or two seconds, so a
            // capped attempt still has an order of magnitude of headroom.
            let remaining = fallback_deadline.saturating_duration_since(Instant::now());
            if remaining < MIN_ATTEMPT_TIME {
                break;
            }
            let attempt_timeout = request_timeout.min(remaining);
            let mut form = reqwest::multipart::Form::new()
                .part(
                    "file",
                    reqwest::multipart::Part::bytes(audio.clone()).file_name(file_name.clone()),
                )
                .text("model", model.clone())
                .text("temperature", "0");
            if let Some(language) = &language {
                form = form.text("language", language.clone());
            }
            let response = match OPENROUTER_CLIENT
                .post(OPENROUTER_TRANSCRIPTIONS_URL)
                .bearer_auth(&api_key)
                .header("X-Title", "FalconDeck")
                .timeout(attempt_timeout)
                .multipart(form)
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    last_error = format!("OpenRouter transcription request failed: {error}");
                    continue;
                }
            };
            let status = response.status();
            let body = response.json::<Value>().await.unwrap_or(Value::Null);
            if status.is_success() {
                let text = body
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if !text.is_empty() {
                    return Ok(SpeechTranscriptionResponse {
                        text: text.to_string(),
                        model,
                    });
                }
                last_error = "OpenRouter returned an empty transcription".to_string();
            } else {
                last_error = transcription_error(status.as_u16(), &body);
                if !should_try_fallback(status.as_u16()) {
                    return Err(DaemonError::BadRequest(last_error));
                }
            }
        }

        Err(DaemonError::Process(last_error))
    }

    pub async fn synthesize_speech(
        &self,
        request: SpeechSynthesisRequest,
    ) -> Result<SpeechSynthesisResponse, DaemonError> {
        let text = request.text.trim();
        if text.is_empty() || text.chars().count() > MAX_READ_ALOUD_CHARS {
            return Err(DaemonError::BadRequest(format!(
                "read aloud text must be between 1 and {MAX_READ_ALOUD_CHARS} characters"
            )));
        }
        let api_key = self.openrouter_key_cached().await?.ok_or_else(|| {
            DaemonError::BadRequest(
                "OpenRouter is not configured on the connected desktop".to_string(),
            )
        })?;
        let response = OPENROUTER_CLIENT
            .post(OPENROUTER_SPEECH_URL)
            .bearer_auth(api_key)
            .header("X-Title", "FalconDeck")
            .timeout(SYNTHESIS_TIMEOUT)
            .json(&json!({
                "model": READ_ALOUD_MODEL,
                "input": text,
                "voice": READ_ALOUD_VOICE,
                "response_format": "mp3"
            }))
            .send()
            .await
            .map_err(|error| {
                DaemonError::Process(format!("OpenRouter speech request failed: {error}"))
            })?;
        let status = response.status();
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .filter(|value| value.starts_with("audio/"))
            .unwrap_or("audio/mpeg")
            .to_string();
        if !status.is_success() {
            let body = response.bytes().await.map_err(|error| {
                DaemonError::Process(format!(
                    "failed to read OpenRouter speech error response: {error}"
                ))
            })?;
            let error = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
            return Err(DaemonError::Process(speech_synthesis_error(
                status.as_u16(),
                &error,
            )));
        }
        // TTS uses a chunked raw-audio response. Some providers close the
        // transfer immediately after the final frame, which Reqwest reports
        // as a body-decoding error despite usable audio already arriving.
        // Preserve those bytes so playback can proceed; only fail when no
        // audio reached us at all.
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => body.extend_from_slice(&chunk),
                Err(error) if body.is_empty() => {
                    return Err(DaemonError::Process(format!(
                        "OpenRouter speech stream ended before audio arrived: {error}"
                    )));
                }
                Err(error) => {
                    tracing::warn!(%error, bytes = body.len(), "OpenRouter speech stream ended after audio");
                    break;
                }
            }
        }
        if body.is_empty() {
            return Err(DaemonError::Process(
                "OpenRouter returned empty speech audio".to_string(),
            ));
        }
        Ok(SpeechSynthesisResponse {
            audio_base64: STANDARD.encode(body),
            mime_type,
        })
    }
}

async fn run_secret_store_op<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, DaemonError> + Send + 'static,
) -> Result<T, DaemonError> {
    timeout(SPEECH_SECRET_TIMEOUT, spawn_blocking(operation))
        .await
        .map_err(|_| {
            DaemonError::Process(
                "Timed out reading the speech credential. If a keychain prompt is open, \
                 choose Always Allow, or re-save the OpenRouter key in Settings."
                    .to_string(),
            )
        })?
        .map_err(|error| {
            DaemonError::Process(format!("speech credential store task failed: {error}"))
        })?
}

fn validate_audio_format(format: &str) -> Result<(), DaemonError> {
    if matches!(
        format,
        "wav" | "mp3" | "flac" | "m4a" | "ogg" | "webm" | "aac"
    ) {
        Ok(())
    } else {
        Err(DaemonError::BadRequest(
            "unsupported audio format".to_string(),
        ))
    }
}

fn decode_base64_audio(value: &str) -> Result<Vec<u8>, DaemonError> {
    let size_error = || {
        DaemonError::BadRequest(format!(
            "audio recording must be between 1 byte and {MAX_AUDIO_BYTES} bytes"
        ))
    };
    // Reject oversized payloads from the length estimate before decoding.
    let estimate = value.len().saturating_mul(3) / 4;
    if estimate > MAX_AUDIO_BYTES + 2 {
        return Err(size_error());
    }
    let audio = STANDARD
        .decode(value)
        .map_err(|_| DaemonError::BadRequest("audio is not valid base64".to_string()))?;
    if audio.is_empty() || audio.len() > MAX_AUDIO_BYTES {
        return Err(size_error());
    }
    Ok(audio)
}

/// ":nitro" is OpenRouter's throughput-first routing variant: the same model
/// served by its fastest provider. Models already carrying a variant suffix
/// (":free", ":floor", …) are left alone.
fn with_nitro(model: &str) -> Option<String> {
    (!model.is_empty() && !model.contains(':')).then(|| format!("{model}:nitro"))
}

/// The base model id without OpenRouter's variant suffix.
fn base_model(model: &str) -> &str {
    model.split(':').next().unwrap_or(model)
}

/// Whether the model refuses audio longer than [`MODEL_AUDIO_LIMIT`].
fn rejects_long_audio(model: &str) -> bool {
    DURATION_CAPPED_MODELS.contains(&base_model(model))
}

fn fallback_models(
    preferred: &str,
    user_fallback: Option<&str>,
    audio_duration: Duration,
) -> Vec<String> {
    let preferred = preferred.trim();
    let user_fallback = user_fallback
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut models: Vec<String> = Vec::new();
    {
        let mut add = |model: String| {
            if !model.is_empty() && !models.contains(&model) {
                models.push(model);
            }
        };
        if let Some(nitro) = with_nitro(preferred) {
            add(nitro);
        }
        // The plain preferred model is the safety net for a rejected variant;
        // the fallbacks run nitro-only to keep the chain short.
        add(preferred.to_string());
        // The user's own second choice outranks our built-in chain, and gets
        // the same nitro-then-plain treatment as the preferred model: it was
        // chosen deliberately, so a rejected routing variant should not skip
        // it entirely.
        if let Some(fallback) = user_fallback {
            if let Some(nitro) = with_nitro(fallback) {
                add(nitro);
            }
            add(fallback.to_string());
        }
        for fallback in FALLBACK_MODELS {
            add(with_nitro(fallback).unwrap_or_else(|| fallback.to_string()));
        }
    }
    // A recording past the OpenAI duration cap would burn the front of the
    // chain on guaranteed rejections, so those models move to the back
    // instead of being dropped: the estimate can be wrong, and a rejected
    // request is not billed.
    if audio_duration > MODEL_AUDIO_LIMIT {
        let mut long_form: Vec<String> = Vec::new();
        let mut capped: Vec<String> = Vec::new();
        for model in models {
            if rejects_long_audio(&model) {
                capped.push(model);
            } else {
                long_form.push(model);
            }
        }
        long_form.extend(capped);
        models = long_form;
    }
    models.truncate(8);
    models
}

/// How long the recording runs for, from the client's measurement when it has
/// one and from a conservative bitrate floor otherwise.
fn estimated_audio_duration(
    duration_seconds: Option<f64>,
    audio_bytes: usize,
    format: &str,
) -> Duration {
    if let Some(seconds) = duration_seconds.filter(|value| value.is_finite() && *value > 0.0) {
        return Duration::from_secs_f64(seconds.min(24.0 * 60.0 * 60.0));
    }
    let bytes_per_second = match format {
        "wav" | "flac" => UNCOMPRESSED_BYTES_PER_SECOND,
        _ => COMPRESSED_BYTES_PER_SECOND,
    };
    Duration::from_secs_f64(audio_bytes as f64 / bytes_per_second)
}

/// Ceiling for one transcription attempt. Providers batch-transcribe well
/// above real time, but a 30-minute dictation legitimately takes minutes, so
/// the ceiling grows with the recording instead of failing it at a flat 70 s.
fn transcription_timeout(audio_duration: Duration) -> Duration {
    (BASE_TRANSCRIPTION_TIMEOUT + audio_duration / 2).min(MAX_TRANSCRIPTION_TIMEOUT)
}

/// Wall clock for the whole fallback chain. A short dictation fails fast so
/// the writer can simply say it again; a long one is expensive to re-record,
/// so the chain gets room for another model to run.
fn fallback_budget(audio_duration: Duration) -> Duration {
    (BASE_FALLBACK_BUDGET + audio_duration).min(MAX_FALLBACK_BUDGET)
}

fn should_try_fallback(status: u16) -> bool {
    // A transcription provider can reject a model/format pairing with 400.
    // Trying the remaining STT models is safe because rejected requests are
    // not billed and often support a different set of audio containers.
    matches!(status, 400 | 404 | 408 | 409 | 429) || status >= 500
}

fn transcription_error(status: u16, body: &Value) -> String {
    match status {
        401 => "The OpenRouter API key was rejected".to_string(),
        402 => "The OpenRouter account needs credit before it can transcribe audio".to_string(),
        429 => "OpenRouter is rate limited; the recording is still safe on the phone".to_string(),
        _ => openrouter_error_message(body)
            .unwrap_or_else(|| format!("OpenRouter transcription failed ({status})")),
    }
}

fn speech_synthesis_error(status: u16, body: &Value) -> String {
    match status {
        401 => "The OpenRouter API key was rejected".to_string(),
        402 => "The OpenRouter account needs credit to read responses aloud".to_string(),
        429 => "OpenRouter is rate limited; try Read Aloud again shortly".to_string(),
        _ => openrouter_error_message(body)
            .unwrap_or_else(|| format!("OpenRouter speech synthesis failed ({status})")),
    }
}

fn openrouter_error_message(body: &Value) -> Option<String> {
    if let Some(message) = body.pointer("/error/message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    let raw = body
        .pointer("/error/metadata/raw")
        .and_then(Value::as_str)?;
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| Some(raw.to_string()))
}

#[cfg(not(test))]
static KEYCHAIN_MIGRATION_ATTEMPTED: AtomicBool = AtomicBool::new(false);

#[cfg(not(test))]
fn credential_entry() -> Result<keyring::Entry, DaemonError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| {
        DaemonError::Process(format!("failed to open OS credential store: {error}"))
    })
}

#[cfg(not(test))]
fn load_from_keychain() -> Result<Option<String>, DaemonError> {
    match credential_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(DaemonError::Process(format!(
            "failed to read OS credential store: {error}"
        ))),
    }
}

#[cfg(not(test))]
fn delete_from_keychain() -> Result<(), DaemonError> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(DaemonError::Process(format!(
            "failed to delete OS credential: {error}"
        ))),
    }
}

#[cfg(not(test))]
fn load_openrouter_key() -> Result<Option<String>, DaemonError> {
    let Some(file) = super::storage::read_secret_file_entry(SPEECH_SECRET_KEY) else {
        return load_from_keychain();
    };
    match file? {
        Some(key) if !key.is_empty() => Ok(Some(key)),
        // Empty value is a delete tombstone: do not restore from Keychain.
        Some(_) => Ok(None),
        None => Ok(migrate_legacy_keychain_key()),
    }
}

/// One-shot copy of a pre-migration Keychain item into the file store.
/// A later retry in this process must not call Keychain again: a parked
/// `securityd` prompt would otherwise wedge another blocking-pool thread.
#[cfg(not(test))]
fn migrate_legacy_keychain_key() -> Option<String> {
    if KEYCHAIN_MIGRATION_ATTEMPTED.swap(true, Ordering::AcqRel) {
        return None;
    }
    let Ok(Some(key)) = load_from_keychain() else {
        return None;
    };
    // A Settings save or delete can land in the file store while Keychain is
    // still prompting. Prefer that newer state. Never delete the Keychain
    // copy until the file store holds the replacement.
    match super::storage::read_secret_file_entry(SPEECH_SECRET_KEY) {
        Some(Ok(Some(existing))) if !existing.is_empty() => {
            let _ = delete_from_keychain();
            return Some(existing);
        }
        Some(Ok(Some(_))) => {
            let _ = delete_from_keychain();
            return None;
        }
        Some(Ok(None)) | None => {}
        Some(Err(_)) => return Some(key),
    }
    match super::storage::write_secret_file_entry(SPEECH_SECRET_KEY, &key) {
        Some(Ok(())) => {
            let _ = delete_from_keychain();
            Some(key)
        }
        _ => Some(key),
    }
}

#[cfg(not(test))]
fn save_openrouter_key(api_key: &str) -> Result<(), DaemonError> {
    if let Some(result) = super::storage::write_secret_file_entry(SPEECH_SECRET_KEY, api_key) {
        return result;
    }
    credential_entry()?.set_password(api_key).map_err(|error| {
        DaemonError::Process(format!("failed to write OS credential store: {error}"))
    })
}

#[cfg(not(test))]
fn delete_openrouter_key() -> Result<(), DaemonError> {
    // Persist an empty tombstone so a later process does not migrate a leftover
    // Keychain copy back into the file store.
    if let Some(result) = super::storage::write_secret_file_entry(SPEECH_SECRET_KEY, "") {
        return result;
    }
    delete_from_keychain()
}

#[cfg(test)]
static TEST_CREDENTIAL: OnceLock<StdMutex<Option<String>>> = OnceLock::new();

#[cfg(test)]
fn test_credential() -> &'static StdMutex<Option<String>> {
    TEST_CREDENTIAL.get_or_init(|| StdMutex::new(None))
}

#[cfg(test)]
fn load_openrouter_key() -> Result<Option<String>, DaemonError> {
    Ok(test_credential().lock().unwrap().clone())
}

#[cfg(test)]
fn save_openrouter_key(api_key: &str) -> Result<(), DaemonError> {
    *test_credential().lock().unwrap() = Some(api_key.to_string());
    Ok(())
}

#[cfg(test)]
fn delete_openrouter_key() -> Result<(), DaemonError> {
    *test_credential().lock().unwrap() = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A typical dictation: a few seconds of speech.
    const SHORT_AUDIO: Duration = Duration::from_secs(10);

    /// Serializes the tests that mutate the process-global test credential.
    async fn credential_test_guard() -> tokio::sync::MutexGuard<'static, ()> {
        static GUARD: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        GUARD
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await
    }

    #[test]
    fn fallback_models_deduplicates_the_preferred_model() {
        let models = fallback_models("openai/gpt-4o-mini-transcribe", None, SHORT_AUDIO);
        assert_eq!(
            models,
            [
                "openai/gpt-4o-mini-transcribe:nitro",
                "openai/gpt-4o-mini-transcribe",
                "deepgram/nova-3:nitro",
                "openai/whisper-large-v3-turbo:nitro",
                "nvidia/parakeet-tdt-0.6b-v3:nitro",
            ]
        );
    }

    #[test]
    fn user_fallback_runs_before_the_built_in_chain() {
        let models = fallback_models(
            "openai/gpt-4o-mini-transcribe",
            Some("mistralai/voxtral-mini-transcribe"),
            SHORT_AUDIO,
        );
        assert_eq!(models[2], "mistralai/voxtral-mini-transcribe:nitro");
        // The plain id backs up a rejected :nitro variant, exactly like the
        // preferred model's safety net.
        assert_eq!(models[3], "mistralai/voxtral-mini-transcribe");
        assert_eq!(models[4], "deepgram/nova-3:nitro");
    }

    #[test]
    fn every_model_fits_even_with_a_user_fallback() {
        let models = fallback_models(
            "google/chirp-3",
            Some("qwen/qwen3-asr-flash-2026-02-10"),
            SHORT_AUDIO,
        );
        // 2 preferred + 2 user fallback + 4 built-ins: nothing is truncated.
        assert_eq!(models.len(), 8);
        assert!(models.contains(&"nvidia/parakeet-tdt-0.6b-v3:nitro".to_string()));
    }

    #[test]
    fn a_slow_attempt_cannot_starve_the_fallback_chain() {
        // The whole point of the per-attempt cap: even the first attempt is
        // bounded by the budget, so a hung provider leaves room for another
        // model inside the same request.
        let budget = fallback_budget(SHORT_AUDIO);
        let attempt = transcription_timeout(SHORT_AUDIO).min(budget);
        assert!(attempt <= budget);
        assert!(MIN_ATTEMPT_TIME < budget);
    }

    #[test]
    fn user_fallback_matching_the_preferred_model_is_not_repeated() {
        let models = fallback_models("deepgram/nova-3", Some("deepgram/nova-3"), SHORT_AUDIO);
        assert_eq!(models[0], "deepgram/nova-3:nitro");
        assert_eq!(models[1], "deepgram/nova-3");
        assert_eq!(models[2], "openai/gpt-4o-mini-transcribe:nitro");
    }

    #[test]
    fn long_recordings_try_long_form_models_first() {
        let models = fallback_models(
            "openai/gpt-4o-mini-transcribe",
            Some("mistralai/voxtral-mini-transcribe"),
            Duration::from_secs(30 * 60),
        );
        // Every OpenAI model rejects audio past 1500 s, so they sink to the
        // back of the chain rather than eating the first two attempts.
        assert_eq!(models[0], "mistralai/voxtral-mini-transcribe:nitro");
        assert!(!rejects_long_audio(&models[0]));
        assert!(rejects_long_audio(models.last().unwrap()));
        // Nothing is dropped: the duration estimate can be wrong.
        assert!(models.contains(&"openai/gpt-4o-mini-transcribe:nitro".to_string()));
    }

    #[test]
    fn duration_capped_models_are_matched_through_the_nitro_suffix() {
        assert!(rejects_long_audio("openai/gpt-4o-mini-transcribe:nitro"));
        assert!(!rejects_long_audio("deepgram/nova-3:nitro"));
    }

    #[test]
    fn transcription_timeout_grows_with_the_recording() {
        assert_eq!(transcription_timeout(SHORT_AUDIO), Duration::from_secs(75));
        // A 30-minute dictation gets minutes, not the short-clip ceiling.
        assert_eq!(
            transcription_timeout(Duration::from_secs(30 * 60)),
            MAX_TRANSCRIPTION_TIMEOUT
        );
        assert!(transcription_timeout(Duration::from_secs(5 * 60)) > BASE_TRANSCRIPTION_TIMEOUT);
    }

    #[test]
    fn fallback_budget_lets_a_long_recording_reach_a_second_model() {
        assert_eq!(fallback_budget(SHORT_AUDIO), Duration::from_secs(40));
        let long = Duration::from_secs(30 * 60);
        assert!(fallback_budget(long) > transcription_timeout(long));
        assert_eq!(
            fallback_budget(Duration::from_secs(60 * 60)),
            MAX_FALLBACK_BUDGET
        );
    }

    #[test]
    fn audio_duration_prefers_the_measured_length() {
        assert_eq!(
            estimated_audio_duration(Some(42.5), 1_000, "m4a"),
            Duration::from_secs_f64(42.5)
        );
        // 32 kbps AAC is 4 kB per second of speech.
        assert_eq!(
            estimated_audio_duration(None, 400_000, "m4a"),
            Duration::from_secs(100)
        );
        // Uncompressed audio carries far more bytes per second.
        assert_eq!(
            estimated_audio_duration(None, 320_000, "wav"),
            Duration::from_secs(10)
        );
        // Nonsense measurements fall back to the size estimate.
        assert_eq!(
            estimated_audio_duration(Some(-1.0), 400_000, "m4a"),
            Duration::from_secs(100)
        );
        assert_eq!(
            estimated_audio_duration(Some(f64::NAN), 400_000, "m4a"),
            Duration::from_secs(100)
        );
    }

    #[test]
    fn fallback_models_apply_nitro_to_every_entry() {
        let models = fallback_models("mistralai/voxtral-mini-transcribe", None, SHORT_AUDIO);
        assert_eq!(models[0], "mistralai/voxtral-mini-transcribe:nitro");
        assert_eq!(models[1], "mistralai/voxtral-mini-transcribe");
        // Every fallback rides the throughput-first variant too.
        assert!(models[2..].iter().all(|model| model.ends_with(":nitro")));
        assert_eq!(models.len(), 6);
    }

    #[test]
    fn fallback_models_never_stack_variant_suffixes() {
        let models = fallback_models("openai/whisper-large-v3-turbo:free", None, SHORT_AUDIO);
        assert_eq!(models[0], "openai/whisper-large-v3-turbo:free");
        assert!(models.iter().all(|model| !model.contains(":free:")));
    }

    #[test]
    fn decode_base64_audio_rejects_malformed_and_empty_audio() {
        assert!(decode_base64_audio("not base64").is_err());
        assert!(decode_base64_audio("").is_err());
        assert_eq!(decode_base64_audio("aGk=").unwrap(), b"hi");
    }

    #[test]
    fn bad_request_tries_another_transcription_model() {
        assert!(should_try_fallback(400));
    }

    #[test]
    fn short_dictations_give_up_before_one_request_times_out() {
        assert!(fallback_budget(SHORT_AUDIO) < transcription_timeout(SHORT_AUDIO));
    }

    #[test]
    fn synthesis_timeout_fits_within_the_remote_rpc_budget() {
        assert!(SYNTHESIS_TIMEOUT < Duration::from_secs(30));
    }

    #[test]
    fn transcription_error_reads_nested_provider_message() {
        let body = json!({
            "error": {
                "metadata": {
                    "raw": "{\"error\":{\"message\":\"Unsupported audio format\"}}"
                }
            }
        });
        assert_eq!(transcription_error(400, &body), "Unsupported audio format");
    }

    #[tokio::test]
    async fn credential_reads_come_from_the_cache_after_the_first_load() {
        let _guard = credential_test_guard().await;
        let app = AppState::new("test".to_string(), std::collections::HashMap::new());
        app.save_speech_credential("cached-key".to_string())
            .await
            .unwrap();
        // Wipe the backing store directly: a status probe must now succeed
        // from the cache without touching the credential store again.
        *test_credential().lock().unwrap() = None;
        assert!(app.speech_credential_status().await.unwrap().configured);
        // Deleting drops the cache too, so status stops reporting configured.
        app.delete_speech_credential().await.unwrap();
        assert!(!app.speech_credential_status().await.unwrap().configured);
    }

    #[tokio::test]
    async fn credential_status_never_returns_the_secret() {
        let _guard = credential_test_guard().await;
        let app = AppState::new("test".to_string(), std::collections::HashMap::new());
        app.save_speech_credential("secret-value".to_string())
            .await
            .unwrap();
        let status = app.speech_credential_status().await.unwrap();
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains("secret-value"));
        assert_eq!(status.storage, "daemon_secret_store");
        app.delete_speech_credential().await.unwrap();
    }
}
