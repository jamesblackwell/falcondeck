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
const TOKEN_EXPIRY_SKEW: u64 = 60;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
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

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn token_is_current(token: &StoredToken, now: u64) -> bool {
    token
        .expires_at
        .is_none_or(|expires_at| expires_at > now.saturating_add(TOKEN_EXPIRY_SKEW))
}

/// Current access token for an OAuth-brokered connector. Expired tokens are
/// deliberately hidden so they cannot be injected into a harness as if the
/// connector were still authenticated.
pub fn access_token(name: &str) -> Option<String> {
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    read_store()
        .get(name)
        .filter(|token| token_is_current(token, now_epoch_seconds()))
        .map(|token| token.access_token.clone())
}

pub(crate) fn save_token(name: &str, token: StoredToken) -> Result<(), String> {
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut tokens = read_store();
    tokens.insert(name.to_string(), token);
    write_store(&tokens)
}

fn save_refreshed_token(
    name: &str,
    previous: &StoredToken,
    refreshed: StoredToken,
) -> Result<Option<String>, String> {
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut tokens = read_store();
    if let Some(current) = tokens.get(name)
        && current != previous
    {
        return Ok(
            token_is_current(current, now_epoch_seconds()).then(|| current.access_token.clone())
        );
    }
    let access_token = refreshed.access_token.clone();
    tokens.insert(name.to_string(), refreshed);
    write_store(&tokens)?;
    Ok(Some(access_token))
}

/// Returns a current token, refreshing an expired access token when the
/// authorization server supplied a refresh token. Refreshes are serialized so
/// concurrent provider starts cannot rotate the same credential twice.
pub async fn refresh_access_token(name: &str) -> Result<Option<String>, String> {
    if let Some(token) = access_token(name) {
        return Ok(Some(token));
    }

    let _refresh_guard = refresh_lock().lock().await;
    if let Some(token) = access_token(name) {
        return Ok(Some(token));
    }

    let stored = {
        let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
        read_store().get(name).cloned()
    };
    let Some(stored) = stored else {
        return Ok(None);
    };
    let Some(refresh_token) = stored.refresh_token.as_deref() else {
        return Ok(None);
    };

    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("client_id", stored.client_id.clone()),
    ];
    if let Some(resource) = connector_catalog::get(name).and_then(|server| server.resource) {
        form.push(("resource", resource.to_string()));
    }
    let form = form
        .into_iter()
        .map(|(key, value)| format!("{}={}", encode_query(key), encode_query(&value)))
        .collect::<Vec<_>>()
        .join("&");
    let response = reqwest::Client::new()
        .post(&stored.token_endpoint)
        .timeout(Duration::from_secs(20))
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(form)
        .send()
        .await
        .map_err(|error| format!("token refresh failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("token refresh returned {status}: {body}"));
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|error| format!("invalid token refresh response: {error}"))?;
    let refreshed = StoredToken {
        access_token: token.access_token,
        refresh_token: token.refresh_token.or_else(|| stored.refresh_token.clone()),
        expires_at: token
            .expires_in
            .map(|seconds| now_epoch_seconds().saturating_add(seconds)),
        token_endpoint: stored.token_endpoint.clone(),
        client_id: stored.client_id.clone(),
    };
    save_refreshed_token(name, &stored, refreshed)
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

fn authorization_server_metadata_url(issuer: &str) -> Result<String, String> {
    let parsed = issuer
        .parse::<reqwest::Url>()
        .map_err(|error| format!("invalid OAuth issuer URL: {error}"))?;
    let origin = origin_of(issuer)?;
    let issuer_path = parsed.path().trim_end_matches('/');
    Ok(format!(
        "{origin}/.well-known/oauth-authorization-server{issuer_path}"
    ))
}

/// RFC 9728: insert `/.well-known/oauth-protected-resource` between host and
/// path, then fall back to the origin-level well-known URI.
fn protected_resource_metadata_urls(mcp_url: &str) -> Result<Vec<String>, String> {
    let parsed = mcp_url
        .parse::<reqwest::Url>()
        .map_err(|error| format!("invalid MCP URL: {error}"))?;
    let origin = origin_of(mcp_url)?;
    let path = parsed.path().trim_end_matches('/');
    let mut urls = Vec::with_capacity(2);
    if !path.is_empty() {
        urls.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
    }
    urls.push(format!("{origin}/.well-known/oauth-protected-resource"));
    Ok(urls)
}

async fn discover(mcp_url: &str) -> Result<AuthorizationServerMetadata, String> {
    let origin = origin_of(mcp_url)?;
    let mut issuer = origin.clone();
    for url in protected_resource_metadata_urls(mcp_url)? {
        if let Ok(meta) = fetch_json::<ProtectedResourceMetadata>(&url).await {
            if let Some(server) = meta.authorization_servers.into_iter().next() {
                issuer = server;
            }
            break;
        }
    }
    fetch_json::<AuthorizationServerMetadata>(&authorization_server_metadata_url(&issuer)?).await
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

const CALLBACK_HTML: &str = include_str!("connector_oauth_callback.html");
const FALCON_MARK: &str = include_str!("../../../assets/brand/logomark-mark-dark.svg");

const CHECK_ICON: &str = r#"<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>"#;
const CLOSE_ICON: &str = r#"<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>"#;

#[derive(Clone, Copy)]
enum PageKind {
    Success,
    Error,
}

struct CallbackPage<'a> {
    kind: PageKind,
    title: &'a str,
    body: &'a str,
    connector_id: Option<&'a str>,
    detail: Option<&'a str>,
}

fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn truncate_detail(value: &str) -> String {
    const MAX: usize = 280;
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(MAX).collect();
    format!("{cut}…")
}

fn letter_mark(name: &str) -> char {
    name.chars()
        .find(|ch| ch.is_alphabetic())
        .map(|ch| ch.to_ascii_uppercase())
        .unwrap_or('?')
}

fn connector_identity(id: &str) -> (&str, Option<&str>) {
    connector_catalog::get(id)
        .map(|server| (server.name, Some(server.domain)))
        .unwrap_or((id, None))
}

fn oauth_provider_error(error: &str) -> String {
    match error {
        "access_denied" => "Sign-in was cancelled.".to_string(),
        "temporarily_unavailable" => {
            "The authorization server is temporarily unavailable.".to_string()
        }
        "server_error" => "The authorization server had an error.".to_string(),
        other => format!("The authorization server returned {other}."),
    }
}

fn pair_html(kind: PageKind, connector_id: Option<&str>) -> String {
    let status_icon = match kind {
        PageKind::Success => CHECK_ICON,
        PageKind::Error => CLOSE_ICON,
    };
    let Some(connector_id) = connector_id else {
        return format!(r#"<div class="badge" aria-hidden="true">{status_icon}</div>"#);
    };
    let (name, domain) = connector_identity(connector_id);
    let letter = escape_html(&letter_mark(name).to_string());
    let logo = domain
        .filter(|value| connector_catalog::is_catalog_domain(value))
        .map(|value| {
            format!(
                r#"<img src="/api/plugin-logos?domain={}" alt="" onerror="this.remove()">"#,
                encode_query(value)
            )
        })
        .unwrap_or_default();
    format!(
        r#"<div class="pair" aria-hidden="true"><div class="tile">{logo}<span class="letter">{letter}</span></div><div class="status">{status_icon}</div><div class="tile falcon">{FALCON_MARK}</div></div>"#
    )
}

fn detail_html(detail: Option<&str>) -> String {
    let Some(detail) = detail.map(str::trim).filter(|value| !value.is_empty()) else {
        return String::new();
    };
    format!(
        "<details><summary>Details</summary><pre>{}</pre></details>",
        escape_html(&truncate_detail(detail))
    )
}

fn pending_connector_id(state: Option<&str>) -> Option<String> {
    let state = state.filter(|value| !value.is_empty())?;
    let pending_map = pending().lock().unwrap_or_else(|p| p.into_inner());
    pending_map.get(state).map(|item| item.name.clone())
}

fn html_page(page: CallbackPage<'_>) -> String {
    let document_title = format!("{} · FalconDeck", page.title);
    let meta = match page.kind {
        PageKind::Success => "You can close this window and return to FalconDeck.",
        PageKind::Error => "You can close this window and try again from FalconDeck.",
    };
    let kind_class = match page.kind {
        PageKind::Success => "ok",
        PageKind::Error => "error",
    };
    let document_title = escape_html(&document_title);
    let title = escape_html(page.title);
    let body = escape_html(page.body);
    let pair = pair_html(page.kind, page.connector_id);
    let detail = detail_html(page.detail);
    render_template(&[
        ("__KIND__", kind_class),
        ("__DOCUMENT_TITLE__", &document_title),
        ("__TITLE__", &title),
        ("__BODY__", &body),
        ("__META__", meta),
        ("__PAIR__", &pair),
        ("__DETAIL__", &detail),
    ])
}

fn render_template(replacements: &[(&str, &str)]) -> String {
    let mut rendered = String::with_capacity(CALLBACK_HTML.len() + 256);
    let mut rest = CALLBACK_HTML;
    while let Some((offset, token, value)) = replacements
        .iter()
        .filter_map(|(token, value)| rest.find(token).map(|offset| (offset, *token, *value)))
        .min_by_key(|(offset, _, _)| *offset)
    {
        rendered.push_str(&rest[..offset]);
        rendered.push_str(value);
        rest = &rest[offset + token.len()..];
    }
    rendered.push_str(rest);
    rendered
}

fn success_page(connector_id: &str) -> String {
    let (name, _) = connector_identity(connector_id);
    html_page(CallbackPage {
        kind: PageKind::Success,
        title: "Connected",
        body: &format!("{name} is available to every agent on the next turn."),
        connector_id: Some(connector_id),
        detail: None,
    })
}

fn error_page(body: &str, connector_id: Option<&str>, detail: Option<&str>) -> String {
    html_page(CallbackPage {
        kind: PageKind::Error,
        title: "Could not connect",
        body,
        connector_id,
        detail,
    })
}

/// Completes a pending login from the browser redirect.
pub async fn complete_authorization(
    code: Option<&str>,
    state: Option<&str>,
    error: Option<&str>,
) -> (u16, String) {
    if let Some(error) = error.filter(|value| !value.is_empty()) {
        let connector_id = pending_connector_id(state);
        return (
            400,
            error_page(&oauth_provider_error(error), connector_id.as_deref(), None),
        );
    }
    let Some(state) = state.filter(|value| !value.is_empty()) else {
        return (
            400,
            error_page("This sign-in link is incomplete.", None, None),
        );
    };
    let Some(code) = code.filter(|value| !value.is_empty()) else {
        return (
            400,
            error_page("This sign-in link is incomplete.", None, None),
        );
    };
    let pending_item = {
        let mut pending_map = pending().lock().unwrap_or_else(|p| p.into_inner());
        pending_map.remove(state)
    };
    let Some(pending_item) = pending_item else {
        return (
            400,
            error_page("This sign-in link is invalid or has expired.", None, None),
        );
    };
    if pending_item.created.elapsed() > PENDING_TTL {
        return (
            400,
            error_page(
                "This sign-in link has expired.",
                Some(pending_item.name.as_str()),
                None,
            ),
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
            tracing::warn!(error = %error, connector = %pending_item.name, "connector oauth token exchange failed");
            return (
                502,
                error_page(
                    "FalconDeck could not finish connecting.",
                    Some(pending_item.name.as_str()),
                    Some(&error.to_string()),
                ),
            );
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        tracing::warn!(
            status,
            connector = %pending_item.name,
            "connector oauth token exchange rejected"
        );
        return (
            502,
            error_page(
                "The authorization server rejected the token exchange.",
                Some(pending_item.name.as_str()),
                Some(&format!("HTTP {status}: {body}")),
            ),
        );
    }
    let token: TokenResponse = match response.json().await {
        Ok(token) => token,
        Err(error) => {
            tracing::warn!(error = %error, connector = %pending_item.name, "connector oauth token response invalid");
            return (
                502,
                error_page(
                    "The authorization server returned an invalid token.",
                    Some(pending_item.name.as_str()),
                    Some(&error.to_string()),
                ),
            );
        }
    };
    let now = now_epoch_seconds();
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
        return (
            500,
            error_page(
                "FalconDeck could not save the connection.",
                Some(pending_item.name.as_str()),
                Some(&error),
            ),
        );
    }
    if let Err(error) = crate::connectors::upsert_global_http_connector(
        &pending_item.name,
        &pending_item.url,
        Some("oauth"),
        std::collections::BTreeMap::new(),
    ) {
        return (
            500,
            error_page(
                "FalconDeck could not save the connection.",
                Some(pending_item.name.as_str()),
                Some(&error),
            ),
        );
    }
    (200, success_page(&pending_item.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn refresh_token_handler(
        axum::extract::State(requests): axum::extract::State<std::sync::Arc<Mutex<Vec<String>>>>,
        body: String,
    ) -> axum::Json<Value> {
        requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(body);
        axum::Json(json!({
            "access_token": "fresh-access",
            "refresh_token": "fresh-refresh",
            "expires_in": 3600,
        }))
    }

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
    fn authorization_server_metadata_url_uses_rfc_8414_path_insertion() {
        assert_eq!(
            authorization_server_metadata_url("https://access.stripe.com/mcp").unwrap(),
            "https://access.stripe.com/.well-known/oauth-authorization-server/mcp"
        );
        assert_eq!(
            authorization_server_metadata_url("https://example.com").unwrap(),
            "https://example.com/.well-known/oauth-authorization-server"
        );
    }

    #[test]
    fn protected_resource_metadata_urls_use_rfc_9728_path_insertion() {
        assert_eq!(
            protected_resource_metadata_urls("https://api.mobbin.com/mcp").unwrap(),
            vec![
                "https://api.mobbin.com/.well-known/oauth-protected-resource/mcp".to_string(),
                "https://api.mobbin.com/.well-known/oauth-protected-resource".to_string(),
            ]
        );
        assert_eq!(
            protected_resource_metadata_urls("https://mcp.vercel.com").unwrap(),
            vec!["https://mcp.vercel.com/.well-known/oauth-protected-resource".to_string()]
        );
        assert_eq!(
            protected_resource_metadata_urls("https://api.githubcopilot.com/mcp/").unwrap(),
            vec![
                "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp"
                    .to_string(),
                "https://api.githubcopilot.com/.well-known/oauth-protected-resource".to_string(),
            ]
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

    #[test]
    fn access_token_hides_expired_credentials() {
        let _lock = lock_store_for_test();
        let dir = tempfile::tempdir().unwrap();
        set_store_path_for_test(dir.path().join("oauth.json"));
        save_token(
            "sentry",
            StoredToken {
                access_token: "stale".into(),
                refresh_token: Some("refresh".into()),
                expires_at: Some(now_epoch_seconds().saturating_sub(1)),
                token_endpoint: "https://example/token".into(),
                client_id: "cid".into(),
            },
        )
        .unwrap();
        assert!(access_token("sentry").is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn expired_access_token_is_refreshed_and_persisted() {
        let _lock = lock_store_for_test();
        let dir = tempfile::tempdir().unwrap();
        set_store_path_for_test(dir.path().join("oauth.json"));
        let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .route("/token", axum::routing::post(refresh_token_handler))
            .with_state(std::sync::Arc::clone(&requests));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        save_token(
            "sentry",
            StoredToken {
                access_token: "stale-access".into(),
                refresh_token: Some("stale-refresh".into()),
                expires_at: Some(now_epoch_seconds().saturating_sub(1)),
                token_endpoint: format!("http://{address}/token"),
                client_id: "client-id".into(),
            },
        )
        .unwrap();

        assert_eq!(
            refresh_access_token("sentry").await.unwrap().as_deref(),
            Some("fresh-access")
        );
        assert_eq!(access_token("sentry").as_deref(), Some("fresh-access"));
        let stored = read_store().remove("sentry").unwrap();
        assert_eq!(stored.refresh_token.as_deref(), Some("fresh-refresh"));
        assert!(stored.expires_at.unwrap() > now_epoch_seconds());
        let request = requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .first()
            .cloned()
            .unwrap();
        assert!(request.contains("grant_type=refresh_token"));
        assert!(request.contains("refresh_token=stale-refresh"));
        assert!(request.contains("client_id=client-id"));
        assert!(request.contains("resource=https%3A%2F%2Fmcp.sentry.dev%2Fmcp"));
        server.abort();
    }

    #[test]
    fn success_page_uses_catalog_display_name() {
        let html = success_page("mobbin");
        assert!(html.contains("Connected · FalconDeck"));
        assert!(html.contains("<h1>Connected</h1>"));
        assert!(html.contains("Mobbin is available to every agent on the next turn."));
        assert!(!html.contains("mobbin is available"));
        assert!(html.contains("class=\"ok\""));
        assert!(html.contains("/api/plugin-logos?domain=mobbin.com"));
        assert!(html.contains("You can close this window and return to FalconDeck."));
        assert!(html.contains("name=\"viewport\""));
        assert!(html.contains("color-scheme"));
    }

    #[test]
    fn error_page_escapes_user_controlled_copy() {
        let html = error_page(
            "Could not connect <script>alert(1)</script>",
            None,
            Some("<img src=x onerror=alert(1)>"),
        );
        assert!(html.contains("class=\"error\""));
        assert!(html.contains("Could not connect &lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
        assert!(!html.contains("<script>alert(1)</script>"));
        assert!(html.contains("You can close this window and try again from FalconDeck."));
    }

    #[test]
    fn callback_copy_cannot_trigger_a_second_template_substitution() {
        let html = error_page("Provider returned __META__", None, Some("__PAIR__"));
        assert!(html.contains("Provider returned __META__"));
        assert!(html.contains("<pre>__PAIR__</pre>"));
    }

    #[test]
    fn access_denied_is_humanized() {
        assert_eq!(
            oauth_provider_error("access_denied"),
            "Sign-in was cancelled."
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn incomplete_callback_renders_error_page() {
        let (status, html) = complete_authorization(None, None, None).await;
        assert_eq!(status, 400);
        assert!(html.contains("Could not connect"));
        assert!(html.contains("This sign-in link is incomplete."));
        assert!(html.contains("class=\"error\""));
        assert!(!html.contains("<details>"));
    }
}
