#[cfg(test)]
use std::sync::OnceLock;
use std::sync::{
    Mutex as StdMutex,
    atomic::{AtomicBool, Ordering},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    sync::Mutex,
    task::spawn_blocking,
    time::{Duration, timeout},
};

use super::AppState;
use crate::error::DaemonError;

#[cfg(not(test))]
const KEYRING_SERVICE: &str = "com.falcondeck.daemon.speech";
#[cfg(not(test))]
const KEYRING_ACCOUNT: &str = "openrouter-api-key";
const OPENROUTER_TRANSCRIPTIONS_URL: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const OPENROUTER_MODELS_URL: &str =
    "https://openrouter.ai/api/v1/models?output_modalities=transcription";
// Base64 audio is encrypted and base64-encoded again by the relay protocol.
// Eight MiB keeps the outer WebSocket message below the relay's 16 MiB cap.
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
// Keychain calls normally return in milliseconds; the only slow path is
// securityd holding the call for a user-authorization decision. Stay under
// the phone's 8-second speech.status deadline so the caller sees the
// actionable wedge error instead of a generic relay timeout.
const KEYCHAIN_OP_TIMEOUT: Duration = Duration::from_secs(5);
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(70);
const FALLBACK_MODELS: [&str; 4] = [
    "openai/gpt-transcribe",
    "openai/gpt-4o-transcribe",
    "deepgram/nova-3",
    "openai/whisper-large-v3",
];

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

#[derive(Debug, Serialize)]
pub struct SpeechModel {
    pub id: String,
    pub name: String,
}

/// In-process cache and wedge tracking for the OpenRouter credential.
///
/// macOS parks a keychain read inside securityd while it waits for the user
/// to approve access — which it wants whenever the running binary no longer
/// matches the item's ACL (every ad-hoc rebuild changes the code hash). That
/// parked call never returns on its own, and every later keychain call in
/// this process queues behind it on an item mutex, so each retry would wedge
/// another blocking-pool thread forever. Cache the key after any successful
/// read or save, run at most one keychain operation at a time, and fail fast
/// with an actionable message while an abandoned operation is still parked.
#[derive(Default)]
pub(super) struct SpeechCredentialCache {
    key: StdMutex<Option<String>>,
    /// Serializes keychain operations so concurrent callers wait for the
    /// in-flight result (normally milliseconds) instead of stacking threads.
    flight: Mutex<()>,
    /// True while an operation abandoned by its timeout is still parked in
    /// securityd; cleared by the watcher task when it finally resolves.
    wedged: AtomicBool,
}

fn keychain_authorization_pending() -> DaemonError {
    DaemonError::Process(
        "The Mac is waiting for keychain permission before it can read the OpenRouter key. \
         Approve the keychain prompt on the desktop (choose \"Always Allow\"), or restart \
         FalconDeck and re-save the key in Settings, then retry."
            .to_string(),
    )
}

impl AppState {
    pub async fn speech_models(&self) -> Result<Vec<SpeechModel>, DaemonError> {
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| {
                DaemonError::Process(format!("failed to create model client: {error}"))
            })?
            .get(OPENROUTER_MODELS_URL)
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
        // Reading the key (not just its attributes) deliberately surfaces the
        // keychain authorization prompt at status time — before a recording
        // exists that would otherwise be transcribed into a wedged daemon.
        let configured = self.openrouter_key_cached().await?.is_some();
        Ok(SpeechCredentialStatus {
            configured,
            storage: "os_credential_store",
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
        let written = api_key.clone();
        self.run_keychain_op(
            move || save_openrouter_key(&api_key),
            // A save that outlives its timeout still wrote the key once the
            // parked call resolves, so it may seed the cache late.
            move |state, ()| {
                *state.inner.speech_credentials.key.lock().unwrap() = Some(written);
            },
        )
        .await?;
        *self.inner.speech_credentials.key.lock().unwrap() = Some(cached);
        Ok(SpeechCredentialStatus {
            configured: true,
            storage: "os_credential_store",
        })
    }

    pub async fn delete_speech_credential(&self) -> Result<SpeechCredentialStatus, DaemonError> {
        // Drop the cache first so a failed delete can only under-report, never
        // serve a key the user asked to remove.
        *self.inner.speech_credentials.key.lock().unwrap() = None;
        self.run_keychain_op(delete_openrouter_key, |_, ()| {}).await?;
        Ok(SpeechCredentialStatus {
            configured: false,
            storage: "os_credential_store",
        })
    }

    /// The OpenRouter key, from cache when possible, from the OS credential
    /// store otherwise. See [`SpeechCredentialCache`] for why the keychain is
    /// treated as hostile.
    async fn openrouter_key_cached(&self) -> Result<Option<String>, DaemonError> {
        if let Some(key) = self.inner.speech_credentials.key.lock().unwrap().clone() {
            return Ok(Some(key));
        }
        let key = self
            .run_keychain_op(load_openrouter_key, |state, key| {
                // The user approved the prompt after the caller had already
                // given up: seed the cache so their retry succeeds instantly.
                if let Some(key) = key {
                    *state.inner.speech_credentials.key.lock().unwrap() = Some(key);
                }
            })
            .await?;
        if let Some(key) = &key {
            *self.inner.speech_credentials.key.lock().unwrap() = Some(key.clone());
        }
        Ok(key)
    }

    /// Runs one keychain operation on the blocking pool, failing fast while a
    /// previously abandoned operation is still parked in securityd. On
    /// timeout the task is not lost: a watcher awaits its eventual result,
    /// clears the wedge, and hands a late success to `on_late_completion`.
    async fn run_keychain_op<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T, DaemonError> + Send + 'static,
        on_late_completion: impl FnOnce(&AppState, T) + Send + 'static,
    ) -> Result<T, DaemonError> {
        let _flight = self.inner.speech_credentials.flight.lock().await;
        if self.inner.speech_credentials.wedged.load(Ordering::Acquire) {
            return Err(keychain_authorization_pending());
        }
        let mut task = spawn_blocking(operation);
        match timeout(KEYCHAIN_OP_TIMEOUT, &mut task).await {
            Ok(joined) => joined.map_err(|error| {
                DaemonError::Process(format!("credential store task failed: {error}"))
            })?,
            Err(_) => {
                tracing::warn!(
                    "keychain access is blocked, likely awaiting user authorization on the desktop"
                );
                self.inner
                    .speech_credentials
                    .wedged
                    .store(true, Ordering::Release);
                let state = self.clone();
                tokio::spawn(async move {
                    let outcome = task.await;
                    state
                        .inner
                        .speech_credentials
                        .wedged
                        .store(false, Ordering::Release);
                    if let Ok(Ok(value)) = outcome {
                        on_late_completion(&state, value);
                    }
                });
                Err(keychain_authorization_pending())
            }
        }
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
        let client = reqwest::Client::builder()
            .timeout(TRANSCRIPTION_TIMEOUT)
            .build()
            .map_err(|error| {
                DaemonError::Process(format!("failed to create transcription client: {error}"))
            })?;
        let mut last_error = "Transcription failed".to_string();

        for model in models {
            let mut payload = json!({
                "model": model,
                "input_audio": { "data": request.audio_base64, "format": request.format },
                "temperature": 0
            });
            if let Some(language) = request
                .language
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                payload["language"] = Value::String(language.to_string());
            }
            let response = match client
                .post(OPENROUTER_TRANSCRIPTIONS_URL)
                .bearer_auth(&api_key)
                .header("X-Title", "FalconDeck")
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
    std::iter::once(preferred.trim())
        .chain(FALLBACK_MODELS)
        .filter(|model| !model.is_empty())
        .fold(Vec::new(), |mut models, model| {
            if !models.iter().any(|existing| existing == model) {
                models.push(model.to_string());
            }
            models
        })
        .into_iter()
        .take(4)
        .collect()
}

fn should_try_fallback(status: u16) -> bool {
    matches!(status, 404 | 408 | 409 | 429) || status >= 500
}

fn transcription_error(status: u16, body: &Value) -> String {
    match status {
        401 => "The OpenRouter API key was rejected".to_string(),
        402 => "The OpenRouter account needs credit before it can transcribe audio".to_string(),
        429 => "OpenRouter is rate limited; the recording is still safe on the phone".to_string(),
        _ => body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("OpenRouter transcription failed ({status})")),
    }
}

#[cfg(not(test))]
fn credential_entry() -> Result<keyring::Entry, DaemonError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| {
        DaemonError::Process(format!("failed to open OS credential store: {error}"))
    })
}

#[cfg(not(test))]
fn load_openrouter_key() -> Result<Option<String>, DaemonError> {
    match credential_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(DaemonError::Process(format!(
            "failed to read OS credential store: {error}"
        ))),
    }
}

#[cfg(not(test))]
fn save_openrouter_key(api_key: &str) -> Result<(), DaemonError> {
    credential_entry()?.set_password(api_key).map_err(|error| {
        DaemonError::Process(format!("failed to write OS credential store: {error}"))
    })
}

#[cfg(not(test))]
fn delete_openrouter_key() -> Result<(), DaemonError> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(DaemonError::Process(format!(
            "failed to delete OS credential: {error}"
        ))),
    }
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
        static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
        GUARD.get_or_init(|| Mutex::new(())).lock().await
    }

    #[test]
    fn fallback_models_deduplicates_the_preferred_model() {
        assert_eq!(fallback_models("openai/gpt-transcribe").len(), 4);
    }

    #[test]
    fn decoded_base64_len_rejects_malformed_audio() {
        assert!(decoded_base64_len("not base64").is_err());
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
        let serialized =
            serde_json::to_string(&app.speech_credential_status().await.unwrap()).unwrap();
        assert!(!serialized.contains("secret-value"));
        app.delete_speech_credential().await.unwrap();
    }
}
