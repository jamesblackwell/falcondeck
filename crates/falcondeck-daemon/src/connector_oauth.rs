//! Daemon-brokered OAuth for remote MCP servers.
//!
//! FalconDeck is the OAuth client. After a single browser login, the access
//! token is stored beside the daemon state and injected as
//! `Authorization: Bearer` when connectors are materialized for Claude, Codex,
//! and ACP. Harnesses never run their own `/mcp` login.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::connector_catalog::{self, CatalogAuth};

const PENDING_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
struct PendingAuthorization {
    name: String,
    url: String,
    client_id: String,
    token_endpoint: String,
    redirect_uri: String,
    verifier: String,
    resource: String,
    created: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoredToken {
    pub(crate) access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) expires_at: Option<u64>,
    pub(crate) token_endpoint: String,
    pub(crate) client_id: String,
}

fn pending() -> &'static Mutex<HashMap<String, PendingAuthorization>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingAuthorization>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
fn test_store_path() -> &'static Mutex<Option<PathBuf>> {
    static PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    PATH.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
pub fn set_store_path_for_test(path: PathBuf) {
    *test_store_path().lock().unwrap_or_else(|p| p.into_inner()) = Some(path);
}

#[cfg(test)]
pub fn lock_store_for_test() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

fn store_path() -> PathBuf {
    #[cfg(test)]
    {
        if let Some(path) = test_store_path()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        {
            return path;
        }
    }
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join(".falcondeck").join("connector-oauth.json")
}

fn read_store() -> HashMap<String, StoredToken> {
    let path = store_path();
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_store(tokens: &HashMap<String, StoredToken>) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create oauth store dir: {error}"))?;
    }
    let body = serde_json::to_string_pretty(tokens)
        .map_err(|error| format!("failed to encode oauth store: {error}"))?;
    let tmp = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&tmp)
        .and_then(|mut file| file.write_all(body.as_bytes()))
        .map_err(|error| format!("failed to write oauth store: {error}"))?;
    std::fs::rename(&tmp, &path)
        .map_err(|error| format!("failed to publish oauth store: {error}"))?;
    Ok(())
}

/// Access token for an OAuth-brokered connector, if one is stored.
pub fn access_token(name: &str) -> Option<String> {
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    read_store()
        .get(name)
        .map(|token| token.access_token.clone())
}

pub(crate) fn save_token(name: &str, token: StoredToken) -> Result<(), String> {
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut tokens = read_store();
    tokens.insert(name.to_string(), token);
    write_store(&tokens)
}

fn random_urlsafe(nbytes: usize) -> String {
    let mut raw = Vec::with_capacity(nbytes);
    while raw.len() < nbytes {
        raw.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    raw.truncate(nbytes);
    URL_SAFE_NO_PAD.encode(raw)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn origin_of(mcp_url: &str) -> Result<String, String> {
    let parsed = mcp_url
        .parse::<reqwest::Url>()
        .map_err(|error| format!("invalid MCP URL: {error}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("MCP OAuth URL must be http(s)".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "MCP URL is missing a host".to_string())?;
    match parsed.port() {
        Some(port) => Ok(format!("{}://{host}:{port}", parsed.scheme())),
        None => Ok(format!("{}://{host}", parsed.scheme())),
    }
}

#[derive(Debug, Deserialize)]
struct ProtectedResourceMetadata {
    #[serde(default)]
    authorization_servers: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AuthorizationServerMetadata {
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    registration_endpoint: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClientRegistration {
    client_id: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

async fn fetch_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, String> {
    let response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("failed to fetch {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} returned {}", response.status().as_u16()));
    }
    response
        .json::<T>()
        .await
        .map_err(|error| format!("failed to parse {url}: {error}"))
}

async fn discover(mcp_url: &str) -> Result<AuthorizationServerMetadata, String> {
    let origin = origin_of(mcp_url)?;
    let issuer = match fetch_json::<ProtectedResourceMetadata>(&format!(
        "{origin}/.well-known/oauth-protected-resource"
    ))
    .await
    {
        Ok(meta) => meta
            .authorization_servers
            .into_iter()
            .next()
            .unwrap_or_else(|| origin.clone()),
        Err(_) => origin.clone(),
    };
    fetch_json::<AuthorizationServerMetadata>(&format!(
        "{issuer}/.well-known/oauth-authorization-server"
    ))
    .await
}

/// Starts a browser OAuth login for a catalog server.
pub async fn start_authorization(catalog_id: &str, redirect_base: &str) -> Result<Value, String> {
    let server = connector_catalog::get(catalog_id)
        .ok_or_else(|| format!("unknown catalog server {catalog_id:?}"))?;
    if server.auth != CatalogAuth::Oauth {
        return Err(format!("{catalog_id} does not use OAuth"));
    }
    let redirect_base = redirect_base.trim_end_matches('/');
    if !(redirect_base.starts_with("http://127.0.0.1")
        || redirect_base.starts_with("http://localhost")
        || redirect_base.starts_with("http://[::1]"))
    {
        return Err("OAuth callback must be the daemon's loopback URL".to_string());
    }
    let redirect_uri = format!("{redirect_base}/api/connectors/oauth/callback");
    let resource = server
        .resource
        .map(str::to_string)
        .unwrap_or_else(|| origin_of(server.url).unwrap_or_else(|_| server.url.to_string()));
    let metadata = discover(server.url).await?;
    let registration_endpoint = metadata.registration_endpoint.ok_or_else(|| {
        "this MCP server does not advertise dynamic client registration".to_string()
    })?;
    let registration = reqwest::Client::new()
        .post(&registration_endpoint)
        .timeout(Duration::from_secs(15))
        .json(&json!({
            "client_name": "FalconDeck",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        }))
        .send()
        .await
        .map_err(|error| format!("dynamic client registration failed: {error}"))?;
    if !registration.status().is_success() {
        let status = registration.status().as_u16();
        let body = registration.text().await.unwrap_or_default();
        return Err(format!(
            "dynamic client registration returned {status}: {body}"
        ));
    }
    let registration: ClientRegistration = registration
        .json()
        .await
        .map_err(|error| format!("invalid client registration: {error}"))?;

    let state = random_urlsafe(16);
    let verifier = random_urlsafe(32);
    let challenge = pkce_challenge(&verifier);
    let mut authorization_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256&resource={}",
        metadata.authorization_endpoint,
        encode_query(&registration.client_id),
        encode_query(&redirect_uri),
        encode_query(&state),
        encode_query(&challenge),
        encode_query(&resource),
    );
    if let Some(scopes) = server.scopes.filter(|value| !value.is_empty()) {
        authorization_url.push_str("&scope=");
        authorization_url.push_str(&encode_query(scopes));
    }

    let mut pending_map = pending().lock().unwrap_or_else(|p| p.into_inner());
    pending_map.retain(|_, item| item.created.elapsed() < PENDING_TTL);
    pending_map.insert(
        state.clone(),
        PendingAuthorization {
            name: server.id.to_string(),
            url: server.url.to_string(),
            client_id: registration.client_id,
            token_endpoint: metadata.token_endpoint,
            redirect_uri,
            verifier,
            resource,
            created: Instant::now(),
        },
    );

    Ok(json!({
        "name": server.id,
        "authorization_url": authorization_url,
    }))
}

fn html_page(title: &str, body: &str) -> String {
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font-family:system-ui,sans-serif;padding:2rem;max-width:36rem\">\
         <h1>{title}</h1><p>{body}</p></body></html>"
    )
}

/// Completes a pending login from the browser redirect.
pub async fn complete_authorization(
    code: Option<&str>,
    state: Option<&str>,
    error: Option<&str>,
) -> (u16, String) {
    if let Some(error) = error.filter(|value| !value.is_empty()) {
        return (
            400,
            html_page(
                "Could not connect",
                &format!("The authorization server returned {error}."),
            ),
        );
    }
    let Some(state) = state.filter(|value| !value.is_empty()) else {
        return (400, html_page("Could not connect", "Missing OAuth state."));
    };
    let Some(code) = code.filter(|value| !value.is_empty()) else {
        return (400, html_page("Could not connect", "Missing OAuth code."));
    };
    let pending_item = {
        let mut pending_map = pending().lock().unwrap_or_else(|p| p.into_inner());
        pending_map.remove(state)
    };
    let Some(pending_item) = pending_item else {
        return (
            400,
            html_page(
                "Could not connect",
                "This sign-in link is invalid or has expired. Start again from FalconDeck.",
            ),
        );
    };
    if pending_item.created.elapsed() > PENDING_TTL {
        return (
            400,
            html_page("Could not connect", "This sign-in link has expired."),
        );
    }

    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", pending_item.redirect_uri.as_str()),
        ("client_id", pending_item.client_id.as_str()),
        ("code_verifier", pending_item.verifier.as_str()),
        ("resource", pending_item.resource.as_str()),
    ]
    .into_iter()
    .map(|(key, value)| format!("{}={}", encode_query(key), encode_query(value)))
    .collect::<Vec<_>>()
    .join("&");
    let response = match reqwest::Client::new()
        .post(&pending_item.token_endpoint)
        .timeout(Duration::from_secs(20))
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(form)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return (
                502,
                html_page(
                    "Could not connect",
                    &format!("Token exchange failed: {error}"),
                ),
            );
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return (
            502,
            html_page(
                "Could not connect",
                &format!("Token exchange returned {status}: {body}"),
            ),
        );
    }
    let token: TokenResponse = match response.json().await {
        Ok(token) => token,
        Err(error) => {
            return (
                502,
                html_page(
                    "Could not connect",
                    &format!("Invalid token response: {error}"),
                ),
            );
        }
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if let Err(error) = save_token(
        &pending_item.name,
        StoredToken {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: token.expires_in.map(|seconds| now.saturating_add(seconds)),
            token_endpoint: pending_item.token_endpoint,
            client_id: pending_item.client_id,
        },
    ) {
        return (500, html_page("Could not connect", &error));
    }
    if let Err(error) = crate::connectors::upsert_global_http_connector(
        &pending_item.name,
        &pending_item.url,
        Some("oauth"),
        std::collections::BTreeMap::new(),
    ) {
        return (500, html_page("Could not connect", &error));
    }
    (
        200,
        html_page(
            "Connected to FalconDeck",
            &format!(
                "{} is connected. You can close this window and return to FalconDeck.",
                pending_item.name
            ),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_base64url() {
        // RFC 7636 appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn access_token_round_trips_through_the_store() {
        let _lock = lock_store_for_test();
        let dir = tempfile::tempdir().unwrap();
        set_store_path_for_test(dir.path().join("oauth.json"));
        assert!(access_token("notion").is_none());
        save_token(
            "notion",
            StoredToken {
                access_token: "tok".into(),
                refresh_token: None,
                expires_at: None,
                token_endpoint: "https://example/token".into(),
                client_id: "cid".into(),
            },
        )
        .unwrap();
        assert_eq!(access_token("notion").as_deref(), Some("tok"));
    }
}
