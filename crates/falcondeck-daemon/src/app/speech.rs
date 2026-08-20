use std::sync::{LazyLock, Mutex as StdMutex};
#[cfg(test)]
use std::sync::OnceLock;
#[cfg(not(test))]
use std::sync::atomic::{AtomicBool, Ordering};

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
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(70);
// Remote clients have a roughly 30-second relay RPC budget. Keep this below
// it so cancellation reaches OpenRouter before the client gives up.
const SYNTHESIS_TIMEOUT: Duration = Duration::from_secs(25);
const READ_ALOUD_MODEL: &str = "x-ai/grok-voice-tts-1.0";
const READ_ALOUD_VOICE: &str = "Eve";
// Grok Voice accepts up to 15,000 characters. Keeping the relay payload below
// its encrypted WebSocket limit also makes cancellation feel immediate.
const MAX_READ_ALOUD_CHARS: usize = 8_000;
// Wall-clock budget for the whole fallback chain. Without it, several slow
// models can each consume the full request timeout and hold the client for
// minutes before the error surfaces.
const FALLBACK_TIME_BUDGET: Duration = Duration::from_secs(20);
// How long a connection attempt to OpenRouter may take before the fallback
// chain moves on. Distinct from the per-request timeout: a stalled network
// should fail in seconds, while a legitimately long transcription may not.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(20);
const FALLBACK_MODELS: [&str; 4] = [
    "openai/whisper-large-v3-turbo",
    "deepgram/nova-3",
    "openai/gpt-transcribe",
    "openai/gpt-4o-mini-transcribe",
];

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
        let decoded_len = decoded_base64_len(&request.audio_base64)?;
        if decoded_len == 0 || decoded_len > MAX_AUDIO_BYTES {
            return Err(DaemonError::BadRequest(format!(
                "audio recording must be between 1 byte and {MAX_AUDIO_BYTES} bytes"
            )));
        }
        let api_key = self.openrouter_key_cached().await?.ok_or_else(|| {
            DaemonError::BadRequest(
                "OpenRouter is not configured on the connected desktop".to_string(),
            )
        })?;
        let models = fallback_models(&request.model);
        // Built once: the payload embeds the (potentially multi-megabyte)
        // base64 audio, so only the model id is swapped between attempts.
        let mut payload = json!({
            "model": "",
            "input_audio": { "data": "", "format": request.format },
            "temperature": 0
        });
        // Moved rather than passed through json!, which would copy the
        // multi-megabyte base64 string into the payload.
        payload["input_audio"]["data"] = Value::String(request.audio_base64);
        if let Some(language) = request
            .language
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            payload["language"] = Value::String(language.to_string());
        }
        let mut last_error = "Transcription failed".to_string();
        let fallback_deadline = Instant::now() + FALLBACK_TIME_BUDGET;

        for model in models {
            if Instant::now() > fallback_deadline {
                break;
            }
            payload["model"] = Value::String(model.clone());
            let response = match OPENROUTER_CLIENT
                .post(OPENROUTER_TRANSCRIPTIONS_URL)
                .bearer_auth(&api_key)
                .header("X-Title", "FalconDeck")
                .timeout(TRANSCRIPTION_TIMEOUT)
                .json(&payload)
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

fn decoded_base64_len(value: &str) -> Result<usize, DaemonError> {
    let estimate = value.len().saturating_mul(3) / 4;
    if estimate > MAX_AUDIO_BYTES + 2 {
        return Ok(estimate);
    }
    STANDARD
        .decode(value)
        .map(|bytes| bytes.len())
        .map_err(|_| DaemonError::BadRequest("audio is not valid base64".to_string()))
}

fn fallback_models(preferred: &str) -> Vec<String> {
    let preferred = preferred.trim();
    // ":nitro" is OpenRouter's throughput-first routing variant: the same
    // model served by its fastest provider. Try it before the plain id; a
    // rejected variant fails fast with a 4xx and the plain model runs next.
    let nitro = (!preferred.is_empty() && !preferred.contains(':'))
        .then(|| format!("{preferred}:nitro"));
    nitro
        .into_iter()
        .chain(std::iter::once(preferred.to_string()))
        .chain(FALLBACK_MODELS.iter().map(|model| (*model).to_string()))
        .filter(|model| !model.is_empty())
        .fold(Vec::new(), |mut models, model| {
            if !models.contains(&model) {
                models.push(model);
            }
            models
        })
        .into_iter()
        .take(5)
        .collect()
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
        let models = fallback_models("openai/whisper-large-v3-turbo");
        assert_eq!(
            models[..2],
            [
                "openai/whisper-large-v3-turbo:nitro".to_string(),
                "openai/whisper-large-v3-turbo".to_string(),
            ]
        );
        assert_eq!(models.len(), 5);
    }

    #[test]
    fn fallback_models_never_stack_variant_suffixes() {
        let models = fallback_models("openai/whisper-large-v3-turbo:free");
        assert_eq!(models[0], "openai/whisper-large-v3-turbo:free");
        assert!(models.iter().all(|model| !model.contains(":free:")));
    }

    #[test]
    fn decoded_base64_len_rejects_malformed_audio() {
        assert!(decoded_base64_len("not base64").is_err());
    }

    #[test]
    fn bad_request_tries_another_transcription_model() {
        assert!(should_try_fallback(400));
    }

    #[test]
    fn fallback_budget_stays_shorter_than_one_request_timeout() {
        assert!(FALLBACK_TIME_BUDGET < TRANSCRIPTION_TIMEOUT);
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
