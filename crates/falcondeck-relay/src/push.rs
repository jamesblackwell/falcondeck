//! Optional APNs transport. It never participates in encrypted RPC or Expo delivery.
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, Utc};
use falcondeck_core::{ApnsApplication, ApnsEnvironment, PushRegistration};
use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair},
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub(crate) struct RegisteredPush {
    pub registration: PushRegistration,
    pub registered_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    applications: Vec<ApplicationConfiguration>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplicationConfiguration {
    topic: String,
    environment: ApnsEnvironment,
    team_id: String,
    key_id: String,
    private_key_file: PathBuf,
}

struct SigningIdentity {
    team_id: String,
    key_id: String,
    key: EcdsaKeyPair,
    // APNs binds connections to a developer account. Never pool across identities.
    client: reqwest::Client,
    cached: Mutex<Option<(i64, String)>>,
}

impl SigningIdentity {
    async fn bearer(&self) -> Result<String, &'static str> {
        let now = Utc::now().timestamp();
        let mut cached = self.cached.lock().await;
        // Apple requires tokens newer than one hour and discourages updates
        // more frequently than every 20 minutes. Reuse across all matching topics.
        if let Some((issued, token)) = cached.as_ref()
            && now >= *issued
            && now - issued < 1_800
        {
            return Ok(token.clone());
        }
        let header = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({"alg":"ES256", "kid": self.key_id}))
                .map_err(|_| "APNs JWT header failed")?,
        );
        let claims = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({"iss":self.team_id, "iat":now}))
                .map_err(|_| "APNs JWT claims failed")?,
        );
        let input = format!("{header}.{claims}");
        let signature = self
            .key
            .sign(&SystemRandom::new(), input.as_bytes())
            .map_err(|_| "APNs signing failed")?;
        let token = format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()));
        *cached = Some((now, token.clone()));
        Ok(token)
    }
}

pub(crate) struct ApnsProvider {
    applications: HashMap<ApnsApplication, Arc<SigningIdentity>>,
    capacity: Arc<Semaphore>,
    connections: Semaphore,
    #[cfg(test)]
    endpoint: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DeliveryOutcome {
    Accepted,
    /// APNs invalidated this token at the given UNIX millisecond timestamp.
    Unregistered(i64),
    Failed,
}

impl ApnsProvider {
    #[cfg(test)]
    pub(crate) fn mock(endpoint: String) -> Self {
        let random = SystemRandom::new();
        let der = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &random).unwrap();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, der.as_ref(), &random)
            .unwrap();
        let identity = Arc::new(SigningIdentity {
            team_id: "TESTTEAM00".to_owned(),
            key_id: "TESTKEY000".to_owned(),
            key,
            client: reqwest::Client::new(),
            cached: Mutex::new(None),
        });
        Self {
            applications: HashMap::from([(
                ApnsApplication {
                    topic: "org.example.native".to_owned(),
                    environment: ApnsEnvironment::Sandbox,
                },
                identity,
            )]),
            capacity: Arc::new(Semaphore::new(256)),
            connections: Semaphore::new(16),
            endpoint: Some(endpoint),
        }
    }
    pub fn from_env() -> Option<Arc<Self>> {
        let path = std::env::var_os("FALCONDECK_RELAY_APNS_CONFIG")?;
        if path.is_empty() {
            return None;
        }
        match Self::load(PathBuf::from(path)) {
            Ok(provider) => Some(Arc::new(provider)),
            // Config failure disables only this optional provider. Never print
            // configuration contents, signing keys or token-bearing URLs.
            Err(reason) => {
                tracing::warn!(reason, "APNs disabled: invalid configuration");
                None
            }
        }
    }

    fn load(path: PathBuf) -> Result<Self, &'static str> {
        if std::fs::metadata(&path)
            .map_err(|_| "cannot read APNs configuration")?
            .len()
            > 128 * 1024
        {
            return Err("APNs configuration is too large");
        }
        let configuration: Configuration = serde_json::from_slice(
            &std::fs::read(path).map_err(|_| "cannot read APNs configuration")?,
        )
        .map_err(|_| "invalid APNs configuration JSON")?;
        if configuration.applications.len() > 128 {
            return Err("too many APNs applications");
        }
        let mut applications = HashMap::new();
        let mut identities: HashMap<(String, String, PathBuf), Arc<SigningIdentity>> =
            HashMap::new();
        for config in configuration.applications {
            if !valid_topic(&config.topic)
                || !valid_apple_id(&config.team_id)
                || !valid_apple_id(&config.key_id)
            {
                return Err("invalid APNs application identifiers");
            }
            let identity_key = (
                config.team_id.clone(),
                config.key_id.clone(),
                config.private_key_file.clone(),
            );
            let identity = if let Some(identity) = identities.get(&identity_key) {
                identity.clone()
            } else {
                if std::fs::metadata(&config.private_key_file)
                    .map_err(|_| "cannot read APNs private key")?
                    .len()
                    > 16 * 1024
                {
                    return Err("APNs private key is too large");
                }
                let pem = std::fs::read_to_string(&config.private_key_file)
                    .map_err(|_| "cannot read APNs private key")?;
                let base64 = pem
                    .trim()
                    .strip_prefix("-----BEGIN PRIVATE KEY-----")
                    .and_then(|value| value.strip_suffix("-----END PRIVATE KEY-----"))
                    .ok_or("APNs key must be PKCS8 PEM")?;
                let der = STANDARD
                    .decode(base64.split_whitespace().collect::<String>())
                    .map_err(|_| "invalid APNs private key encoding")?;
                let key = EcdsaKeyPair::from_pkcs8(
                    &ECDSA_P256_SHA256_FIXED_SIGNING,
                    &der,
                    &SystemRandom::new(),
                )
                .map_err(|_| "APNs key must be P256")?;
                let client = reqwest::Client::builder()
                    .http2_prior_knowledge()
                    .https_only(true)
                    .timeout(Duration::from_secs(15))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|_| "cannot build APNs HTTP2 client")?;
                let identity = Arc::new(SigningIdentity {
                    team_id: config.team_id,
                    key_id: config.key_id,
                    key,
                    client,
                    cached: Mutex::new(None),
                });
                identities.insert(identity_key, identity.clone());
                identity
            };
            let application = ApnsApplication {
                topic: config.topic,
                environment: config.environment,
            };
            if applications.insert(application, identity).is_some() {
                return Err("duplicate APNs application");
            }
        }
        Ok(Self {
            applications,
            capacity: Arc::new(Semaphore::new(256)),
            connections: Semaphore::new(16),
            #[cfg(test)]
            endpoint: None,
        })
    }

    pub fn applications(&self) -> Vec<ApnsApplication> {
        let mut applications = self.applications.keys().cloned().collect::<Vec<_>>();
        applications.sort_by_key(|app| {
            (
                app.topic.clone(),
                matches!(app.environment, ApnsEnvironment::Production),
            )
        });
        applications
    }

    pub fn supports(&self, topic: &str, environment: ApnsEnvironment) -> bool {
        self.applications.contains_key(&ApnsApplication {
            topic: topic.to_owned(),
            environment,
        })
    }

    pub fn reserve(&self) -> Option<OwnedSemaphorePermit> {
        self.capacity.clone().try_acquire_owned().ok()
    }

    pub async fn deliver(
        &self,
        registration: &PushRegistration,
        payload: &serde_json::Value,
        collapse_id: &str,
    ) -> DeliveryOutcome {
        let PushRegistration::Apns {
            token,
            topic,
            environment,
        } = registration
        else {
            return DeliveryOutcome::Failed;
        };
        let Some(identity) = self.applications.get(&ApnsApplication {
            topic: topic.clone(),
            environment: *environment,
        }) else {
            return DeliveryOutcome::Failed;
        };
        let Ok(_connection) = self.connections.acquire().await else {
            return DeliveryOutcome::Failed;
        };
        let Ok(bearer) = identity.bearer().await else {
            return DeliveryOutcome::Failed;
        };
        let endpoint = match environment {
            ApnsEnvironment::Sandbox => "https://api.sandbox.push.apple.com",
            ApnsEnvironment::Production => "https://api.push.apple.com",
        };
        #[cfg(test)]
        let endpoint = self.endpoint.as_deref().unwrap_or(endpoint);
        for attempt in 0..3 {
            let response = identity
                .client
                .post(format!("{endpoint}/3/device/{token}"))
                .bearer_auth(&bearer)
                .header("apns-topic", topic)
                .header("apns-push-type", "alert")
                .header("apns-priority", "10")
                .header(
                    "apns-expiration",
                    (Utc::now().timestamp() + 86_400).to_string(),
                )
                .header("apns-collapse-id", collapse_id)
                .json(payload)
                .send()
                .await;
            match response {
                Ok(response) if response.status().as_u16() == 200 => {
                    return DeliveryOutcome::Accepted;
                }
                Ok(mut response) if response.status().as_u16() == 410 => {
                    let mut body = Vec::new();
                    while let Ok(Some(chunk)) = response.chunk().await {
                        if body.len() + chunk.len() > 8_192 {
                            return DeliveryOutcome::Failed;
                        }
                        body.extend_from_slice(&chunk);
                    }
                    if let Ok(failure) = serde_json::from_slice::<ApnsFailure>(&body)
                        && failure.reason == "Unregistered"
                        && let Some(timestamp) = failure.timestamp
                    {
                        return DeliveryOutcome::Unregistered(timestamp);
                    }
                    return DeliveryOutcome::Failed;
                }
                Ok(response)
                    if response.status().as_u16() == 429 || response.status().is_server_error() =>
                {
                    if attempt == 2 {
                        tracing::warn!(status = %response.status(), "APNs delivery failed after retries");
                        return DeliveryOutcome::Failed;
                    }
                }
                Ok(response) => {
                    tracing::warn!(status = %response.status(), "APNs delivery rejected");
                    return DeliveryOutcome::Failed;
                }
                Err(_) if attempt == 2 => {
                    tracing::warn!("APNs network request failed after retries");
                    return DeliveryOutcome::Failed;
                }
                Err(_) => {}
            }
            tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
        }
        DeliveryOutcome::Failed
    }
}

#[derive(Deserialize)]
struct ApnsFailure {
    reason: String,
    timestamp: Option<i64>,
}

pub(crate) fn valid_topic(topic: &str) -> bool {
    !topic.is_empty()
        && topic.len() <= 255
        && topic
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
}
fn valid_apple_id(value: &str) -> bool {
    value.len() == 10 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

pub(crate) fn apns_payload(
    title: &str,
    body: &str,
    session: &str,
    workspace: Option<&str>,
    thread: Option<&str>,
    kind: &str,
    collapse: &str,
) -> Option<serde_json::Value> {
    let mut title = title.to_owned();
    let mut body = body.to_owned();
    loop {
        let payload = serde_json::json!({"aps": {"alert": {"title":title,"body":body},"sound":"default","thread-id":collapse},"sessionId":session,"workspaceId":workspace,"threadId":thread,"kind":kind});
        if serde_json::to_vec(&payload).ok()?.len() <= 4096 {
            return Some(payload);
        }
        if !body.is_empty() {
            body.pop();
        } else if !title.is_empty() {
            title.pop();
        } else {
            return None;
        }
    }
}

pub(crate) fn normalize_registration(
    mut registration: PushRegistration,
) -> Result<PushRegistration, &'static str> {
    match &mut registration {
        PushRegistration::Expo { token } => {
            *token = token.trim().to_owned();
            if token.is_empty() || token.len() > 4_096 || token.chars().any(char::is_control) {
                return Err("invalid Expo token");
            }
        }
        PushRegistration::Apns { token, topic, .. } => {
            // Tokens are variable length; do not assume Apple's current 32-byte format.
            if token.chars().any(char::is_control) {
                return Err("invalid APNs token");
            }
            *token = token.trim().to_ascii_lowercase();
            if token.is_empty()
                || token.len() > 512
                || token.len() % 2 != 0
                || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("APNs token must be bounded hexadecimal bytes");
            }
            if !valid_topic(topic) {
                return Err("invalid APNs topic");
            }
        }
    }
    Ok(registration)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{ECDSA_P256_SHA256_FIXED, KeyPair, UnparsedPublicKey};

    #[tokio::test]
    async fn jwt_is_valid_es256_and_reused() {
        let provider = ApnsProvider::mock("http://127.0.0.1".to_owned());
        let identity = provider.applications.values().next().unwrap();
        let token = identity.bearer().await.unwrap();
        assert_eq!(token, identity.bearer().await.unwrap());
        let parts: Vec<_> = token.split('.').collect();
        let input = format!("{}.{}", parts[0], parts[1]);
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, identity.key.public_key().as_ref())
            .verify(input.as_bytes(), &URL_SAFE_NO_PAD.decode(parts[2]).unwrap())
            .unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "TESTTEAM00");
        assert!((claims["iat"].as_i64().unwrap() - Utc::now().timestamp()).abs() < 2);
    }

    #[test]
    fn native_token_validation_prevents_path_and_header_injection() {
        for token in ["", "abc", "a/bb", "ab\r\n", "https://example.com"] {
            assert!(
                normalize_registration(PushRegistration::Apns {
                    token: token.to_owned(),
                    topic: "org.example.app".to_owned(),
                    environment: ApnsEnvironment::Sandbox
                })
                .is_err()
            );
        }
        let normalized = normalize_registration(PushRegistration::Apns {
            token: "AABB".to_owned(),
            topic: "org.example.app".to_owned(),
            environment: ApnsEnvironment::Sandbox,
        })
        .unwrap();
        assert!(matches!(normalized,PushRegistration::Apns {token,..} if token=="aabb"));
        assert!(
            serde_json::from_value::<PushRegistration>(
                serde_json::json!({"provider":"webhook","url":"http://localhost"})
            )
            .is_err()
        );
    }

    #[test]
    fn payload_keeps_routing_and_unicode_inside_apns_limit() {
        let text = "🦅".repeat(256);
        let payload = apns_payload(
            &text,
            &text,
            "session",
            Some(&text),
            Some(&text),
            &text,
            "collapse",
        )
        .unwrap();
        assert!(serde_json::to_vec(&payload).unwrap().len() <= 4096);
        assert_eq!(payload["threadId"], text);
        assert_eq!(payload["workspaceId"], text);
        assert_eq!(payload["aps"]["thread-id"], "collapse");
    }
}
