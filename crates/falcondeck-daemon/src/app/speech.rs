#[cfg(test)]
use std::sync::{Mutex, OnceLock};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    task::spawn_blocking,
    time::{Duration, timeout},
};

use super::AppState;
use crate::error::DaemonError;

const KEYRING_SERVICE: &str = "com.falcondeck.daemon.speech";
const KEYRING_ACCOUNT: &str = "openrouter-api-key";
const OPENROUTER_TRANSCRIPTIONS_URL: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const OPENROUTER_MODELS_URL: &str =
    "https://openrouter.ai/api/v1/models?output_modalities=transcription";
// Base64 audio is encrypted and base64-encoded again by the relay protocol.
// Eight MiB keeps the outer WebSocket message below the relay's 16 MiB cap.
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
const SECURE_STORAGE_TIMEOUT: Duration = Duration::from_secs(30);
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
        let configured = run_secure_storage(openrouter_key_exists).await?;
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
        run_secure_storage(move || save_openrouter_key(&api_key)).await?;
        Ok(SpeechCredentialStatus {
            configured: true,
            storage: "os_credential_store",
        })
    }

    pub async fn delete_speech_credential(&self) -> Result<SpeechCredentialStatus, DaemonError> {
        run_secure_storage(delete_openrouter_key).await?;
        Ok(SpeechCredentialStatus {
            configured: false,
            storage: "os_credential_store",
        })
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
        let api_key = run_secure_storage(load_openrouter_key)
            .await?
            .ok_or_else(|| {
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

async fn run_secure_storage<T, F>(operation: F) -> Result<T, DaemonError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, DaemonError> + Send + 'static,
{
    timeout(SECURE_STORAGE_TIMEOUT, spawn_blocking(operation))
        .await
        .map_err(|_| {
            DaemonError::Process("timed out accessing the OS credential store".to_string())
        })?
        .map_err(|error| DaemonError::Process(format!("credential store task failed: {error}")))?
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

#[cfg(all(not(test), target_os = "macos"))]
fn openrouter_key_exists() -> Result<bool, DaemonError> {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};

    let mut options = ItemSearchOptions::new();
    options
        .class(ItemClass::generic_password())
        .service(KEYRING_SERVICE)
        .account(KEYRING_ACCOUNT)
        .limit(Limit::Max(1))
        .load_attributes(true);
    match options.search() {
        Ok(items) => Ok(!items.is_empty()),
        Err(error) if error.code() == -25300 => Ok(false),
        Err(error) => Err(DaemonError::Process(format!(
            "failed to inspect OS credential store: {error}"
        ))),
    }
}

#[cfg(all(not(test), not(target_os = "macos")))]
fn openrouter_key_exists() -> Result<bool, DaemonError> {
    Ok(load_openrouter_key()?.is_some())
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
static TEST_CREDENTIAL: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[cfg(test)]
fn test_credential() -> &'static Mutex<Option<String>> {
    TEST_CREDENTIAL.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
fn load_openrouter_key() -> Result<Option<String>, DaemonError> {
    Ok(test_credential().lock().unwrap().clone())
}

#[cfg(test)]
fn openrouter_key_exists() -> Result<bool, DaemonError> {
    Ok(load_openrouter_key()?.is_some())
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

    #[test]
    fn fallback_models_deduplicates_the_preferred_model() {
        assert_eq!(fallback_models("openai/gpt-transcribe").len(), 4);
    }

    #[test]
    fn decoded_base64_len_rejects_malformed_audio() {
        assert!(decoded_base64_len("not base64").is_err());
    }

    #[tokio::test]
    async fn credential_status_never_returns_the_secret() {
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
