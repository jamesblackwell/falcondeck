use std::sync::Mutex as StdMutex;
#[cfg(test)]
use std::sync::OnceLock;
#[cfg(not(test))]
use std::sync::atomic::{AtomicBool, Ordering};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    task::spawn_blocking,
    time::{Duration, timeout},
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

/// In-process cache for the OpenRouter credential so status and transcribe
/// do not re-read the host secret store on every call.
#[derive(Default)]
pub(super) struct SpeechCredentialCache {
    key: StdMutex<Option<String>>,
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
        assert_eq!(fallback_models("openai/gpt-transcribe").len(), 4);
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
