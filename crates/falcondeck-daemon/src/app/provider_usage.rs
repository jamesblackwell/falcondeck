//! Live subscription usage snapshots for supported harnesses.
//!
//! Reads the same read-only dashboards the harness CLIs expose: Codex queries
//! the ChatGPT usage endpoint with the token from `~/.codex/auth.json`, and
//! Claude Code queries the Anthropic OAuth usage endpoint with the token from
//! the CLI's keychain entry (macOS) or `~/.claude/.credentials.json`. Tokens
//! are used as-is — the daemon never refreshes another tool's credentials,
//! because rotating a refresh token out from under the owning CLI breaks its
//! next run.
//!
//! Tests swap the live transport for fixtures, which leaves the real HTTP and
//! credential helpers unreachable in that build.
#![cfg_attr(test, allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use falcondeck_core::{AgentProvider, ProviderUsage, ProviderUsageOverview, ProviderUsageWindow};
use serde_json::Value;
#[cfg(not(test))]
use tokio::fs;

use super::AppState;

const USAGE_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(10);

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_AUTH_CLAIM_PATH: &str = "https://api.openai.com/auth";
const CHATGPT_PROFILE_CLAIM_PATH: &str = "https://api.openai.com/profile";
const WEEKLY_WINDOW_SECONDS: i64 = 604_800;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const CLAUDE_KEYCHAIN_ACCOUNT: &str = "Claude Code";
/// `security` needs its subcommand first — without it the tool exits 2 with a
/// usage error and every credential lookup silently reads as signed out.
const KEYCHAIN_FIND_COMMAND: &str = "find-generic-password";
const CLAUDE_OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
const CLAUDE_USER_AGENT: &str = "claude-code/2.1.0";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn clamp_percent(value: f64) -> u32 {
    if !value.is_finite() {
        return 0;
    }
    value.clamp(0.0, 100.0).round() as u32
}

fn epoch_seconds_to_iso(seconds: Option<i64>) -> Option<String> {
    DateTime::<Utc>::from_timestamp(seconds?, 0)
        .map(|datetime| datetime.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn normalize_iso_timestamp(value: Option<&str>) -> Option<String> {
    DateTime::parse_from_rfc3339(value?).ok().map(|datetime| {
        datetime
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// JSON response shape shared by both usage endpoints.
#[derive(Clone, Debug, PartialEq)]
struct UsageHttpResponse {
    status: u16,
    body: Option<Value>,
    /// Cloudflare answered the request with a bot-management challenge.
    cloudflare_challenge: bool,
    /// Cloudflare service cookies (`name=value`) seen on the response. Only
    /// ever CF bot-management cookies — never account, session, or auth
    /// cookies — so the in-memory store cannot grow a credential.
    cf_cookies: Vec<String>,
}

/// Process-global by design: only Cloudflare service cookies are retained
/// here. Do not add account, session, auth, or user cookies.
static CLOUDFLARE_COOKIES: OnceLock<StdMutex<HashMap<String, String>>> = OnceLock::new();

const ALLOWED_CLOUDFLARE_COOKIES: &[&str] = &[
    "__cf_bm",
    "__cflb",
    "__cfruid",
    "__cfseq",
    "__cfwaitingroom",
    "_cfuvid",
    "cf_clearance",
    "cf_ob_info",
    "cf_use_ob",
];

fn allowed_cloudflare_cookie(name: &str) -> bool {
    ALLOWED_CLOUDFLARE_COOKIES.contains(&name) || name.starts_with("cf_chl_")
}

fn cloudflare_cookies_from_headers(headers: &reqwest::header::HeaderMap) -> Vec<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|raw| raw.split_once(';').map(|(name_value, _)| name_value.trim()))
        .filter(|name_value| {
            name_value
                .split_once('=')
                .is_some_and(|(name, _)| allowed_cloudflare_cookie(name.trim()))
        })
        .map(str::to_string)
        .collect()
}

fn store_cloudflare_cookies(cookies: &[String]) {
    if cookies.is_empty() {
        return;
    }
    let store = CLOUDFLARE_COOKIES.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut guard = store.lock().unwrap();
    for cookie in cookies {
        if let Some((name, _)) = cookie.split_once('=') {
            guard.insert(name.trim().to_string(), cookie.clone());
        }
    }
}

fn cloudflare_cookie_header() -> Option<String> {
    let store = CLOUDFLARE_COOKIES.get()?;
    let guard = store.lock().unwrap();
    (!guard.is_empty()).then(|| guard.values().cloned().collect::<Vec<_>>().join("; "))
}

/// Fetches JSON and retries once when Cloudflare hands back a fresh clearance
/// cookie with its challenge response.
#[cfg(not(test))]
async fn fetch_usage_json(
    url: &str,
    headers: &[(&'static str, String)],
) -> Result<UsageHttpResponse, String> {
    async fn send(
        client: &reqwest::Client,
        url: &str,
        headers: &[(&'static str, String)],
        cookie: Option<&str>,
    ) -> Result<UsageHttpResponse, String> {
        let mut request = client.get(url);
        for (name, value) in headers {
            request = request.header(*name, value.clone());
        }
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("usage request failed: {error}"))?;
        let status = response.status().as_u16();
        let cloudflare_challenge = response
            .headers()
            .get("cf-mitigated")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("challenge"));
        let cf_cookies = cloudflare_cookies_from_headers(response.headers());
        let body = if response.status().is_success() {
            Some(
                response
                    .json::<Value>()
                    .await
                    .map_err(|error| format!("invalid usage response: {error}"))?,
            )
        } else {
            None
        };
        Ok(UsageHttpResponse {
            status,
            body,
            cloudflare_challenge,
            cf_cookies,
        })
    }

    let client = reqwest::Client::builder()
        .timeout(USAGE_FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to create usage client: {error}"))?;
    let mut response = send(&client, url, headers, cloudflare_cookie_header().as_deref()).await?;
    if response.status == 403 && response.cloudflare_challenge {
        // Cloudflare may have handed us a fresh clearance cookie; retry once
        // with it.
        store_cloudflare_cookies(&response.cf_cookies);
        response = send(&client, url, headers, cloudflare_cookie_header().as_deref()).await?;
    }
    Ok(response)
}

#[cfg(test)]
async fn fetch_usage_json(
    url: &str,
    _headers: &[(&'static str, String)],
) -> Result<UsageHttpResponse, String> {
    let fixtures = test_http_fixtures().lock().unwrap();
    match fixtures.get(url) {
        Some(Ok(response)) => Ok(response.clone()),
        Some(Err(message)) => Err(message.clone()),
        None => Err(format!("no usage fixture registered for {url}")),
    }
}

// ---------------------------------------------------------------------------
// Codex (ChatGPT subscription) usage
// ---------------------------------------------------------------------------

/// Credential state extracted from `~/.codex/auth.json`.
#[derive(Debug)]
enum CodexAuthRead {
    /// Signed in with a ChatGPT account.
    ChatGpt(CodexChatGptCredentials),
    /// Signed in with an OpenAI API key instead of a subscription.
    ApiKey,
    /// No login (or unusable tokens) on this host.
    Missing,
}

#[derive(Debug)]
struct CodexChatGptCredentials {
    access_token: String,
    account_id: String,
    account_email: Option<String>,
    is_fedramp_account: bool,
}

fn codex_auth_path() -> Option<PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))?;
    Some(home.join("auth.json"))
}

fn decode_jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn codex_account_id_from_claim(auth: &Value) -> Option<String> {
    non_empty_string(auth.get("chatgpt_account_id"))
}

/// Account id from a JWT access token, or from an id token that is either a
/// JWT or an already-decoded object.
fn codex_account_id_from_token(token: &Value) -> Option<String> {
    if let Some(raw) = token.as_str() {
        let payload = decode_jwt_payload(raw)?;
        return codex_account_id_from_claim(payload.get(CHATGPT_AUTH_CLAIM_PATH)?);
    }
    if token.is_object() {
        return codex_account_id_from_claim(token);
    }
    None
}

fn codex_is_fedramp_from_token(token: &Value) -> bool {
    let claim = if let Some(raw) = token.as_str() {
        decode_jwt_payload(raw).and_then(|payload| payload.get(CHATGPT_AUTH_CLAIM_PATH).cloned())
    } else {
        token.get(CHATGPT_AUTH_CLAIM_PATH).cloned()
    };
    claim
        .and_then(|auth| {
            auth.get("chatgpt_account_is_fedramp")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
}

fn parse_codex_auth(raw: &str) -> CodexAuthRead {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return CodexAuthRead::Missing;
    };
    let auth_mode = value.get("authMode").and_then(Value::as_str);
    let api_key = non_empty_string(value.get("OPENAI_API_KEY"));
    let uses_api_key = match auth_mode {
        Some(mode) => mode.eq_ignore_ascii_case("apikey"),
        None => api_key.is_some(),
    };
    if uses_api_key {
        return CodexAuthRead::ApiKey;
    }

    let Some(tokens) = value.get("tokens").filter(|tokens| tokens.is_object()) else {
        return CodexAuthRead::Missing;
    };
    let Some(access_token) = non_empty_string(tokens.get("access_token")) else {
        return CodexAuthRead::Missing;
    };
    let account_id = non_empty_string(tokens.get("account_id"))
        .or_else(|| codex_account_id_from_token(&Value::String(access_token.clone())))
        .or_else(|| tokens.get("id_token").and_then(codex_account_id_from_token));
    let Some(account_id) = account_id else {
        return CodexAuthRead::Missing;
    };
    let account_email = decode_jwt_payload(&access_token).and_then(|payload| {
        non_empty_string(payload.get("email")).or_else(|| {
            non_empty_string(
                payload
                    .get(CHATGPT_PROFILE_CLAIM_PATH)
                    .and_then(|profile| profile.get("email")),
            )
        })
    });
    let is_fedramp_account = codex_is_fedramp_from_token(&Value::String(access_token.clone()))
        || tokens
            .get("id_token")
            .is_some_and(codex_is_fedramp_from_token);

    CodexAuthRead::ChatGpt(CodexChatGptCredentials {
        access_token,
        account_id,
        account_email,
        is_fedramp_account,
    })
}

fn codex_plan_label(plan_type: Option<&str>) -> Option<String> {
    let plan = plan_type?;
    let known = match plan {
        "free" => "Free",
        "go" => "Go",
        "plus" => "Plus",
        "pro" => "Pro",
        "team" => "Team",
        "business" => "Business",
        "education" | "edu" => "Education",
        "enterprise" => "Enterprise",
        _ => return Some(capitalize(plan)),
    };
    Some(known.to_string())
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Parses one Codex rate-limit window. `Err` marks a malformed window, which
/// invalidates the whole response; `Ok(None)` marks an absent one.
fn codex_window(window: &Value, fallback_label: &str) -> Result<Option<ProviderUsageWindow>, ()> {
    if window.is_null() {
        return Ok(None);
    }
    let used_percent = window
        .get("used_percent")
        .and_then(Value::as_f64)
        .ok_or(())?;
    if !used_percent.is_finite() {
        return Err(());
    }
    let reset_at = match window.get("reset_at") {
        Some(value) if !value.is_null() => value.as_i64(),
        _ => None,
    };
    let limit_window_seconds = match window.get("limit_window_seconds") {
        Some(value) if !value.is_null() => value.as_i64(),
        _ => None,
    };
    let label = if limit_window_seconds == Some(WEEKLY_WINDOW_SECONDS) {
        "Weekly limit"
    } else {
        fallback_label
    };
    Ok(Some(ProviderUsageWindow {
        label: label.to_string(),
        used_percent: clamp_percent(used_percent),
        resets_at: epoch_seconds_to_iso(reset_at),
        cost: None,
    }))
}

fn normalize_codex_usage(raw: &Value, account_email: Option<String>) -> ProviderUsage {
    let malformed = || ProviderUsage::Error {
        message: "Codex usage response was malformed.".to_string(),
        plan_label: None,
        account_email: None,
    };
    let plan_type = match raw.get("plan_type") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_str() {
            Some(plan) => Some(plan),
            None => return malformed(),
        },
    };
    let mut windows = Vec::new();
    match raw.get("rate_limit") {
        None | Some(Value::Null) => {}
        Some(rate_limit) => {
            let Some(entries) = rate_limit.as_object() else {
                return malformed();
            };
            for (key, fallback_label) in [
                ("primary_window", "Current session"),
                ("secondary_window", "Weekly limit"),
            ] {
                match entries.get(key) {
                    None | Some(Value::Null) => {}
                    Some(window) => match codex_window(window, fallback_label) {
                        Ok(Some(window)) => windows.push(window),
                        Ok(None) => {}
                        Err(()) => return malformed(),
                    },
                }
            }
        }
    }
    ProviderUsage::Ok {
        account_email,
        plan_label: codex_plan_label(plan_type),
        windows,
    }
}

async fn fetch_codex_usage() -> ProviderUsage {
    let Some(raw) = read_codex_auth_raw().await else {
        return ProviderUsage::Unauthenticated;
    };
    let credentials = match parse_codex_auth(&raw) {
        CodexAuthRead::ChatGpt(credentials) => credentials,
        CodexAuthRead::ApiKey => {
            return ProviderUsage::Error {
                message:
                    "Codex is authenticated with an API key, which has no subscription usage limits."
                        .to_string(),
                plan_label: None,
                account_email: None,
            };
        }
        CodexAuthRead::Missing => return ProviderUsage::Unauthenticated,
    };

    let mut headers: Vec<(&'static str, String)> = vec![
        (
            "authorization",
            format!("Bearer {}", credentials.access_token),
        ),
        ("chatgpt-account-id", credentials.account_id.clone()),
        ("originator", "falcondeck-daemon".to_string()),
        ("user-agent", "falcondeck-daemon".to_string()),
        ("accept", "application/json".to_string()),
    ];
    if credentials.is_fedramp_account {
        headers.push(("x-openai-fedramp", "true".to_string()));
    }

    let Ok(response) = fetch_usage_json(CODEX_USAGE_URL, &headers).await else {
        return ProviderUsage::Error {
            message: "Codex usage request failed.".to_string(),
            plan_label: None,
            account_email: None,
        };
    };
    match response.status {
        401 => ProviderUsage::Expired,
        status if !(200..300).contains(&status) => ProviderUsage::Error {
            message: format!("Codex usage request failed (HTTP {status})."),
            plan_label: None,
            account_email: None,
        },
        _ => match response.body {
            Some(body) => normalize_codex_usage(&body, credentials.account_email),
            None => ProviderUsage::Error {
                message: "Codex usage response was malformed.".to_string(),
                plan_label: None,
                account_email: None,
            },
        },
    }
}

#[cfg(not(test))]
async fn read_codex_auth_raw() -> Option<String> {
    let raw = fs::read_to_string(codex_auth_path()?).await.ok()?;
    let trimmed = raw.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

// ---------------------------------------------------------------------------
// Claude Code (Anthropic OAuth) usage
// ---------------------------------------------------------------------------

struct ClaudeCredentials {
    access_token: String,
    /// Token expiry as epoch milliseconds, when known.
    expires_at: Option<i64>,
    subscription_type: Option<String>,
    rate_limit_tier: Option<String>,
}

fn parse_claude_credentials(raw: &str) -> Option<ClaudeCredentials> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let oauth = value.get("claudeAiOauth")?;
    Some(ClaudeCredentials {
        access_token: non_empty_string(oauth.get("accessToken"))?,
        expires_at: oauth.get("expiresAt").and_then(Value::as_i64),
        subscription_type: non_empty_string(oauth.get("subscriptionType")),
        rate_limit_tier: non_empty_string(oauth.get("rateLimitTier")),
    })
}

fn claude_credentials_path() -> Option<PathBuf> {
    Some(
        PathBuf::from(std::env::var_os("HOME")?)
            .join(".claude")
            .join(".credentials.json"),
    )
}

fn claude_account_path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("HOME")?).join(".claude.json"))
}

#[cfg(any(target_os = "macos", test))]
/// Lookups tried in order, most specific first. The CLI keys the item to the
/// account it was signed in as, which is `$USER` on current versions and the
/// literal `Claude Code` on older ones; the unqualified lookup is the last
/// resort.
fn claude_keychain_lookups(user: Option<&str>) -> Vec<Vec<String>> {
    let accounts = user
        .into_iter()
        .chain(std::iter::once(CLAUDE_KEYCHAIN_ACCOUNT))
        .map(Some)
        .chain(std::iter::once(None));
    accounts
        .map(|account| {
            let mut args = vec![
                KEYCHAIN_FIND_COMMAND.to_string(),
                "-s".to_string(),
                CLAUDE_KEYCHAIN_SERVICE.to_string(),
            ];
            if let Some(account) = account {
                args.push("-a".to_string());
                args.push(account.to_string());
            }
            args.push("-w".to_string());
            args
        })
        .collect()
}

#[cfg(target_os = "macos")]
async fn read_claude_keychain_credentials() -> Option<String> {
    // Several items can share this service name — the CLI stores its MCP
    // OAuth tokens under the same service, and stale sign-ins linger under
    // old accounts. Every candidate is parsed before it is accepted so a
    // non-subscription blob cannot masquerade as the credential.
    let user = std::env::var("USER").ok();
    for args in claude_keychain_lookups(user.as_deref()) {
        let Ok(output) = tokio::time::timeout(
            KEYCHAIN_TIMEOUT,
            tokio::process::Command::new("security")
                .args(&args)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        else {
            continue;
        };
        let Ok(output) = output else {
            continue;
        };
        let trimmed = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if parse_claude_credentials(&trimmed).is_some() {
            return Some(trimmed);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
async fn read_claude_keychain_credentials() -> Option<String> {
    None
}

#[cfg(not(test))]
async fn read_claude_credentials_raw() -> Option<String> {
    if let Some(raw) = read_claude_keychain_credentials().await {
        return Some(raw);
    }
    let raw = fs::read_to_string(claude_credentials_path()?).await.ok()?;
    let trimmed = raw.trim().to_string();
    parse_claude_credentials(&trimmed)
        .is_some()
        .then_some(trimmed)
}

#[cfg(test)]
async fn read_claude_credentials_raw() -> Option<String> {
    test_claude_credentials_file().lock().unwrap().clone()
}

#[cfg(not(test))]
async fn read_claude_account_email_raw() -> Option<String> {
    let raw = fs::read_to_string(claude_account_path()?).await.ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value
        .get("oauthAccount")
        .and_then(|account| account.get("emailAddress"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
async fn read_claude_account_email_raw() -> Option<String> {
    let raw = test_claude_account_file().lock().unwrap().clone()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value
        .get("oauthAccount")?
        .get("emailAddress")?
        .as_str()
        .map(str::to_string)
}

/// `max_5x`-style tiers map to their marketing label; otherwise the raw
/// subscription type, capitalized.
fn claude_plan_label(credentials: &ClaudeCredentials) -> Option<String> {
    let tier = credentials.rate_limit_tier.as_deref().unwrap_or("");
    if let Some(multiple) = max_tier_multiple(tier) {
        return Some(format!("Max ({multiple}x)"));
    }
    credentials
        .subscription_type
        .as_deref()
        .map(capitalize)
        .filter(|label| !label.is_empty())
}

fn max_tier_multiple(tier: &str) -> Option<&str> {
    // Unanchored on purpose: tiers arrive as e.g. `default_claude_max_20x`.
    let start = tier.find("max_")? + "max_".len();
    let multiple = tier[start..].strip_suffix('x')?;
    (!multiple.is_empty() && multiple.bytes().all(|byte| byte.is_ascii_digit())).then_some(multiple)
}

fn claude_window(window: &Value, label: &str) -> Result<Option<ProviderUsageWindow>, ()> {
    if window.is_null() {
        return Ok(None);
    }
    let Some(utilization) = window.get("utilization") else {
        return Ok(None);
    };
    if utilization.is_null() {
        return Ok(None);
    }
    let utilization = utilization.as_f64().ok_or(())?;
    if !utilization.is_finite() {
        return Err(());
    }
    let resets_at = match window.get("resets_at") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => normalize_iso_timestamp(Some(raw)),
        Some(_) => return Err(()),
    };
    Ok(Some(ProviderUsageWindow {
        label: label.to_string(),
        used_percent: clamp_percent(utilization),
        resets_at,
        cost: None,
    }))
}

/// Model-scoped weekly rows add per-model windows. Surface-scoped rows and
/// rows without an aggregate model bucket are skipped, as are malformed rows —
/// one bad optional row must not blank the aggregate windows.
fn claude_scoped_windows(limits: Option<&Value>) -> Vec<ProviderUsageWindow> {
    let Some(entries) = limits.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut windows = Vec::new();
    let mut seen_labels = HashSet::new();
    for limit in entries {
        if limit.is_null() || limit.get("kind").and_then(Value::as_str) != Some("weekly_scoped") {
            continue;
        }
        let Some(scope) = limit.get("scope").filter(|scope| scope.is_object()) else {
            continue;
        };
        // Surface-specific buckets need a distinct display identity the
        // provider has not documented; only aggregate model rows are shown.
        if scope
            .get("surface")
            .is_some_and(|surface| !surface.is_null())
        {
            continue;
        }
        let Some(label) = scope
            .get("model")
            .and_then(|model| model.get("display_name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
        else {
            continue;
        };
        let Some(percent) = limit.get("percent").and_then(Value::as_f64) else {
            continue;
        };
        if !percent.is_finite() || !seen_labels.insert(label.to_lowercase()) {
            continue;
        }
        let resets_at = match limit.get("resets_at") {
            None | Some(Value::Null) => None,
            Some(Value::String(raw)) => normalize_iso_timestamp(Some(raw)),
            Some(_) => continue,
        };
        windows.push(ProviderUsageWindow {
            label: label.to_string(),
            used_percent: clamp_percent(percent),
            resets_at,
            cost: None,
        });
    }
    windows
}

fn normalize_claude_usage(
    raw: &Value,
    credentials: &ClaudeCredentials,
    account_email: Option<String>,
) -> ProviderUsage {
    let malformed = || ProviderUsage::Error {
        message: "Claude usage response was malformed.".to_string(),
        plan_label: None,
        account_email: None,
    };
    let mut windows = Vec::new();
    for (key, label) in [
        ("five_hour", "Current session"),
        ("seven_day", "Weekly limit"),
    ] {
        match raw.get(key) {
            None | Some(Value::Null) => {}
            Some(window) => match claude_window(window, label) {
                Ok(Some(window)) => windows.push(window),
                Ok(None) => {}
                Err(()) => return malformed(),
            },
        }
    }
    windows.extend(claude_scoped_windows(raw.get("limits")));
    ProviderUsage::Ok {
        account_email,
        plan_label: claude_plan_label(credentials),
        windows,
    }
}

async fn fetch_claude_usage() -> ProviderUsage {
    let (raw, account_email) = tokio::join!(
        read_claude_credentials_raw(),
        read_claude_account_email_raw()
    );
    let Some(raw) = raw else {
        return ProviderUsage::Unauthenticated;
    };
    let Some(credentials) = parse_claude_credentials(&raw) else {
        return ProviderUsage::Unauthenticated;
    };
    // Plan and account came from the local credential file, so a rate limit
    // or outage should not blank them — FalconDeck still knows which plan
    // pays for this.
    let known = (claude_plan_label(&credentials), account_email.clone());
    // The Claude CLI owns these tokens and refreshes them on its next run;
    // refreshing here risks rotating its refresh token out from under it.
    if credentials
        .expires_at
        .is_some_and(|expires_at| Utc::now().timestamp_millis() >= expires_at)
    {
        return ProviderUsage::Expired;
    }

    let headers: Vec<(&'static str, String)> = vec![
        (
            "authorization",
            format!("Bearer {}", credentials.access_token),
        ),
        ("accept", "application/json".to_string()),
        ("content-type", "application/json".to_string()),
        ("anthropic-beta", CLAUDE_OAUTH_BETA_HEADER.to_string()),
        ("user-agent", CLAUDE_USER_AGENT.to_string()),
    ];

    let Ok(response) = fetch_usage_json(CLAUDE_USAGE_URL, &headers).await else {
        return ProviderUsage::Error {
            message: "Claude usage request failed.".to_string(),
            plan_label: known.0,
            account_email: known.1,
        };
    };
    match response.status {
        401 => ProviderUsage::Expired,
        429 => ProviderUsage::Error {
            message: "Claude usage is rate limited right now. Try again shortly.".to_string(),
            plan_label: known.0,
            account_email: known.1,
        },
        status if !(200..300).contains(&status) => ProviderUsage::Error {
            message: format!("Claude usage request failed (HTTP {status})."),
            plan_label: known.0,
            account_email: known.1,
        },
        _ => match response.body {
            Some(body) => normalize_claude_usage(&body, &credentials, account_email),
            None => ProviderUsage::Error {
                message: "Claude usage response was malformed.".to_string(),
                plan_label: known.0,
                account_email: known.1,
            },
        },
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

impl AppState {
    /// Reads live usage snapshots for the local Codex and Claude Code
    /// subscriptions. Each provider resolves independently so one failing
    /// never blanks the other.
    pub async fn provider_usage_overview(&self) -> ProviderUsageOverview {
        let (codex, claude_code) = tokio::join!(self.codex_usage(), self.claude_code_usage());
        ProviderUsageOverview { codex, claude_code }
    }

    async fn codex_usage(&self) -> ProviderUsage {
        if !crate::agent_binary::agent_binary_available_cached(
            "codex",
            &self.provider_bin(&AgentProvider::CODEX),
        ) {
            return ProviderUsage::NotInstalled;
        }
        fetch_codex_usage().await
    }

    async fn claude_code_usage(&self) -> ProviderUsage {
        if !crate::agent_binary::agent_binary_available_cached(
            "claude",
            &self.provider_bin(&AgentProvider::CLAUDE),
        ) {
            return ProviderUsage::NotInstalled;
        }
        fetch_claude_usage().await
    }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

#[cfg(test)]
fn test_http_fixtures() -> &'static StdMutex<HashMap<String, Result<UsageHttpResponse, String>>> {
    static FIXTURES: OnceLock<StdMutex<HashMap<String, Result<UsageHttpResponse, String>>>> =
        OnceLock::new();
    FIXTURES.get_or_init(|| StdMutex::new(HashMap::new()))
}

#[cfg(test)]
fn test_codex_auth_file() -> &'static StdMutex<Option<String>> {
    static FILE: OnceLock<StdMutex<Option<String>>> = OnceLock::new();
    FILE.get_or_init(|| StdMutex::new(None))
}

#[cfg(test)]
fn test_claude_credentials_file() -> &'static StdMutex<Option<String>> {
    static FILE: OnceLock<StdMutex<Option<String>>> = OnceLock::new();
    FILE.get_or_init(|| StdMutex::new(None))
}

#[cfg(test)]
fn test_claude_account_file() -> &'static StdMutex<Option<String>> {
    static FILE: OnceLock<StdMutex<Option<String>>> = OnceLock::new();
    FILE.get_or_init(|| StdMutex::new(None))
}

/// Serializes tests that mutate the process-global fixtures.
#[cfg(test)]
async fn usage_test_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static GUARD: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GUARD
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

#[cfg(test)]
async fn read_codex_auth_raw() -> Option<String> {
    test_codex_auth_file().lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok_response(body: Value) -> Result<UsageHttpResponse, String> {
        Ok(UsageHttpResponse {
            status: 200,
            body: Some(body),
            cloudflare_challenge: false,
            cf_cookies: Vec::new(),
        })
    }

    fn error_response(status: u16) -> Result<UsageHttpResponse, String> {
        Ok(UsageHttpResponse {
            status,
            body: None,
            cloudflare_challenge: false,
            cf_cookies: Vec::new(),
        })
    }

    fn clear_fixtures() {
        test_http_fixtures().lock().unwrap().clear();
        *test_codex_auth_file().lock().unwrap() = None;
        *test_claude_credentials_file().lock().unwrap() = None;
        *test_claude_account_file().lock().unwrap() = None;
    }

    fn fake_codex_jwt(account_id: &str, email: Option<&str>, fedramp: bool) -> String {
        fn base64_url(bytes: &[u8]) -> String {
            URL_SAFE_NO_PAD.encode(bytes)
        }
        let header = base64_url(br#"{"alg":"RS256"}"#);
        let mut claims = json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": account_id,
                "chatgpt_account_is_fedramp": fedramp,
            }
        });
        if let Some(email) = email {
            claims["email"] = json!(email);
        }
        let payload = base64_url(serde_json::to_string(&claims).unwrap().as_bytes());
        format!("{header}.{payload}.signature")
    }

    fn codex_auth_json(access_token: &str) -> String {
        json!({ "tokens": { "access_token": access_token, "account_id": "acct_local" } })
            .to_string()
    }

    fn claude_credentials_json(expires_at: Option<i64>, tier: Option<&str>) -> String {
        json!({
            "claudeAiOauth": {
                "accessToken": "claude-token",
                "expiresAt": expires_at,
                "subscriptionType": "max",
                "rateLimitTier": tier,
            }
        })
        .to_string()
    }

    #[test]
    fn codex_plan_labels_map_known_and_unknown_plans() {
        assert_eq!(codex_plan_label(Some("plus")), Some("Plus".to_string()));
        assert_eq!(codex_plan_label(Some("edu")), Some("Education".to_string()));
        assert_eq!(
            codex_plan_label(Some("internal")),
            Some("Internal".to_string())
        );
        assert_eq!(codex_plan_label(None), None);
    }

    #[test]
    fn claude_keychain_lookups_lead_with_the_security_subcommand() {
        let lookups = claude_keychain_lookups(Some("james"));
        // `security` exits 2 on a missing subcommand, which read as "signed
        // out" rather than as an error — every lookup must name it.
        assert!(
            lookups
                .iter()
                .all(|args| args.first().map(String::as_str) == Some("find-generic-password")),
            "{lookups:?}"
        );
        assert_eq!(
            lookups,
            vec![
                vec![
                    "find-generic-password",
                    "-s",
                    CLAUDE_KEYCHAIN_SERVICE,
                    "-a",
                    "james",
                    "-w"
                ],
                vec![
                    "find-generic-password",
                    "-s",
                    CLAUDE_KEYCHAIN_SERVICE,
                    "-a",
                    CLAUDE_KEYCHAIN_ACCOUNT,
                    "-w"
                ],
                vec!["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
            ]
        );
        assert_eq!(claude_keychain_lookups(None).len(), 2);
    }

    #[test]
    fn parse_claude_credentials_rejects_mcp_only_blobs() {
        // The CLI keeps MCP OAuth tokens under the same keychain service.
        assert!(
            parse_claude_credentials(r#"{"mcpOAuth":{"linear":{"accessToken":"x"}}}"#).is_none()
        );
    }

    #[test]
    fn claude_plan_label_derives_max_tier_and_subscription() {
        let credentials = |tier: Option<&str>, subscription: Option<&str>| ClaudeCredentials {
            access_token: "token".to_string(),
            expires_at: None,
            subscription_type: subscription.map(str::to_string),
            rate_limit_tier: tier.map(str::to_string),
        };
        assert_eq!(
            claude_plan_label(&credentials(Some("default_claude_max_20x"), Some("max"))),
            Some("Max (20x)".to_string())
        );
        assert_eq!(
            claude_plan_label(&credentials(None, Some("pro"))),
            Some("Pro".to_string())
        );
        assert_eq!(claude_plan_label(&credentials(None, None)), None);
    }

    #[test]
    fn normalize_codex_usage_maps_windows_and_plan() {
        let primary_reset = 1_780_000_000_i64;
        let secondary_reset = 1_780_500_000_i64;
        let raw = json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 12,
                    "reset_at": primary_reset,
                    "limit_window_seconds": 18_000,
                },
                "secondary_window": {
                    "used_percent": 18,
                    "reset_at": secondary_reset,
                    "limit_window_seconds": 604_800,
                },
            },
            "credits": { "has_credits": false },
        });

        assert_eq!(
            normalize_codex_usage(&raw, Some("codex@example.com".to_string())),
            ProviderUsage::Ok {
                account_email: Some("codex@example.com".to_string()),
                plan_label: Some("Pro".to_string()),
                windows: vec![
                    ProviderUsageWindow {
                        label: "Current session".to_string(),
                        used_percent: 12,
                        resets_at: epoch_seconds_to_iso(Some(primary_reset)),
                        cost: None,
                    },
                    ProviderUsageWindow {
                        label: "Weekly limit".to_string(),
                        used_percent: 18,
                        resets_at: epoch_seconds_to_iso(Some(secondary_reset)),
                        cost: None,
                    },
                ],
            }
        );
    }

    #[test]
    fn normalize_codex_usage_clamps_and_labels_weekly_primary() {
        let reset_at = 1_786_380_099_i64;
        let raw = json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 150.6,
                    "reset_at": reset_at,
                    "limit_window_seconds": 604_800,
                },
                "secondary_window": { "used_percent": -5 },
            },
        });

        assert_eq!(
            normalize_codex_usage(&raw, None),
            ProviderUsage::Ok {
                account_email: None,
                plan_label: Some("Pro".to_string()),
                windows: vec![
                    ProviderUsageWindow {
                        label: "Weekly limit".to_string(),
                        used_percent: 100,
                        resets_at: epoch_seconds_to_iso(Some(reset_at)),
                        cost: None,
                    },
                    ProviderUsageWindow {
                        label: "Weekly limit".to_string(),
                        used_percent: 0,
                        resets_at: None,
                        cost: None,
                    },
                ],
            }
        );
    }

    #[test]
    fn normalize_codex_usage_allows_absent_rate_limits() {
        assert_eq!(
            normalize_codex_usage(&json!({ "plan_type": "plus" }), None),
            ProviderUsage::Ok {
                account_email: None,
                plan_label: Some("Plus".to_string()),
                windows: Vec::new(),
            }
        );
    }

    #[test]
    fn normalize_codex_usage_flags_malformed_payloads() {
        let raw = json!({ "rate_limit": { "primary_window": { "used_percent": "lots" } } });
        match normalize_codex_usage(&raw, None) {
            ProviderUsage::Error { message, .. } => {
                assert!(message.contains("malformed"));
            }
            other => panic!("expected error variant, got {other:?}"),
        }
    }

    #[test]
    fn normalize_claude_usage_maps_session_weekly_and_scoped_windows() {
        let credentials = ClaudeCredentials {
            access_token: "token".to_string(),
            expires_at: None,
            subscription_type: Some("max".to_string()),
            rate_limit_tier: Some("default_claude_max_20x".to_string()),
        };
        let raw = json!({
            "five_hour": { "utilization": 0, "resets_at": "2026-06-19T22:00:00.000Z" },
            "seven_day": { "utilization": 18.4, "resets_at": "2026-06-24T14:23:00.000Z" },
            "seven_day_sonnet": { "utilization": 0, "resets_at": null },
            "limits": [
                {
                    "kind": "session",
                    "scope": null,
                    "percent": 0,
                    "resets_at": "2026-06-19T22:00:00.000Z",
                },
                {
                    "kind": "weekly_scoped",
                    "scope": {
                        "model": { "id": null, "display_name": "Fable" },
                        "surface": null,
                    },
                    "percent": 48.2,
                    "resets_at": "2026-06-24T14:22:59.000Z",
                },
            ],
        });

        assert_eq!(
            normalize_claude_usage(&raw, &credentials, Some("claude@example.com".to_string())),
            ProviderUsage::Ok {
                account_email: Some("claude@example.com".to_string()),
                plan_label: Some("Max (20x)".to_string()),
                windows: vec![
                    ProviderUsageWindow {
                        label: "Current session".to_string(),
                        used_percent: 0,
                        resets_at: Some("2026-06-19T22:00:00.000Z".to_string()),
                        cost: None,
                    },
                    ProviderUsageWindow {
                        label: "Weekly limit".to_string(),
                        used_percent: 18,
                        resets_at: Some("2026-06-24T14:23:00.000Z".to_string()),
                        cost: None,
                    },
                    ProviderUsageWindow {
                        label: "Fable".to_string(),
                        used_percent: 48,
                        resets_at: Some("2026-06-24T14:22:59.000Z".to_string()),
                        cost: None,
                    },
                ],
            }
        );
    }

    #[test]
    fn normalize_claude_usage_drops_surface_scoped_and_duplicate_rows() {
        let credentials = ClaudeCredentials {
            access_token: "token".to_string(),
            expires_at: None,
            subscription_type: None,
            rate_limit_tier: None,
        };
        let raw = json!({
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "scope": {
                        "model": { "display_name": "Fable" },
                        "surface": { "display_name": "Claude Code" },
                    },
                    "percent": 20,
                    "resets_at": null,
                },
                {
                    "kind": "weekly_scoped",
                    "scope": { "model": { "display_name": "Fable" }, "surface": null },
                    "percent": 48,
                    "resets_at": null,
                },
                {
                    "kind": "weekly_scoped",
                    "scope": { "model": { "display_name": "fable" }, "surface": null },
                    "percent": 52,
                    "resets_at": null,
                },
                {
                    "kind": "weekly_scoped",
                    "scope": { "model": { "display_name": 42 } },
                    "percent": "lots",
                    "resets_at": null,
                },
            ],
        });

        assert_eq!(
            normalize_claude_usage(&raw, &credentials, None),
            ProviderUsage::Ok {
                account_email: None,
                plan_label: None,
                windows: vec![ProviderUsageWindow {
                    label: "Fable".to_string(),
                    used_percent: 48,
                    resets_at: None,
                    cost: None,
                }],
            }
        );
    }

    #[test]
    fn normalize_claude_usage_drops_windows_without_utilization() {
        let credentials = ClaudeCredentials {
            access_token: "token".to_string(),
            expires_at: None,
            subscription_type: None,
            rate_limit_tier: None,
        };
        let raw = json!({
            "five_hour": { "utilization": 7, "resets_at": null },
            "seven_day": { "resets_at": "2026-06-24T14:23:00.000Z" },
        });

        assert_eq!(
            normalize_claude_usage(&raw, &credentials, None),
            ProviderUsage::Ok {
                account_email: None,
                plan_label: None,
                windows: vec![ProviderUsageWindow {
                    label: "Current session".to_string(),
                    used_percent: 7,
                    resets_at: None,
                    cost: None,
                }],
            }
        );
    }

    #[test]
    fn parse_codex_auth_extracts_api_key_and_chatgpt_modes() {
        assert!(matches!(
            parse_codex_auth(
                &json!({ "authMode": "apiKey", "OPENAI_API_KEY": "sk-test" }).to_string()
            ),
            CodexAuthRead::ApiKey
        ));
        assert!(matches!(
            parse_codex_auth(&json!({ "OPENAI_API_KEY": "sk-test" }).to_string()),
            CodexAuthRead::ApiKey
        ));
        assert!(matches!(
            parse_codex_auth(&json!({ "tokens": null }).to_string()),
            CodexAuthRead::Missing
        ));
        match parse_codex_auth(&codex_auth_json("token")) {
            CodexAuthRead::ChatGpt(credentials) => {
                assert_eq!(credentials.account_id, "acct_local");
                assert!(!credentials.is_fedramp_account);
            }
            other => panic!("expected chatgpt credentials, got {other:?}"),
        }
    }

    #[test]
    fn parse_codex_auth_derives_account_from_jwt_claims() {
        let token = fake_codex_jwt("acct_jwt", Some("dev@example.com"), true);
        match parse_codex_auth(&json!({ "tokens": { "access_token": token } }).to_string()) {
            CodexAuthRead::ChatGpt(credentials) => {
                assert_eq!(credentials.account_id, "acct_jwt");
                assert_eq!(
                    credentials.account_email.as_deref(),
                    Some("dev@example.com")
                );
                assert!(credentials.is_fedramp_account);
            }
            other => panic!("expected chatgpt credentials, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn codex_usage_reports_unauthenticated_without_credentials() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        assert_eq!(fetch_codex_usage().await, ProviderUsage::Unauthenticated);
    }

    #[tokio::test]
    async fn codex_usage_reports_expired_on_401() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_codex_auth_file().lock().unwrap() = Some(codex_auth_json("token"));
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(CODEX_USAGE_URL.to_string(), error_response(401));
        assert_eq!(fetch_codex_usage().await, ProviderUsage::Expired);
    }

    #[tokio::test]
    async fn claude_usage_keeps_known_plan_on_http_errors() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_claude_credentials_file().lock().unwrap() = Some(claude_credentials_json(
            Some(Utc::now().timestamp_millis() + 3_600_000),
            Some("default_claude_max_5x"),
        ));
        *test_claude_account_file().lock().unwrap() =
            Some(json!({ "oauthAccount": { "emailAddress": "dev@example.com" } }).to_string());
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(CLAUDE_USAGE_URL.to_string(), error_response(429));
        match fetch_claude_usage().await {
            ProviderUsage::Error {
                message,
                plan_label,
                account_email,
            } => {
                assert!(message.contains("rate limited"));
                assert_eq!(plan_label.as_deref(), Some("Max (5x)"));
                assert_eq!(account_email.as_deref(), Some("dev@example.com"));
            }
            other => panic!("expected error variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn claude_usage_reports_expired_for_stale_tokens() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_claude_credentials_file().lock().unwrap() = Some(claude_credentials_json(
            Some(Utc::now().timestamp_millis() - 1_000),
            None,
        ));
        assert_eq!(fetch_claude_usage().await, ProviderUsage::Expired);
    }

    #[tokio::test]
    async fn claude_usage_normalizes_a_successful_response() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_claude_credentials_file().lock().unwrap() = Some(claude_credentials_json(None, None));
        test_http_fixtures().lock().unwrap().insert(
            CLAUDE_USAGE_URL.to_string(),
            ok_response(json!({
                "five_hour": { "utilization": 7, "resets_at": "2026-06-19T22:00:00Z" },
            })),
        );
        assert_eq!(
            fetch_claude_usage().await,
            ProviderUsage::Ok {
                account_email: None,
                plan_label: Some("Max".to_string()),
                windows: vec![ProviderUsageWindow {
                    label: "Current session".to_string(),
                    used_percent: 7,
                    resets_at: Some("2026-06-19T22:00:00.000Z".to_string()),
                    cost: None,
                }],
            }
        );
    }

    #[tokio::test]
    async fn codex_usage_normalizes_a_successful_response() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_codex_auth_file().lock().unwrap() = Some(codex_auth_json("token"));
        test_http_fixtures().lock().unwrap().insert(
            CODEX_USAGE_URL.to_string(),
            ok_response(json!({
                "plan_type": "pro",
                "rate_limit": {
                    "primary_window": { "used_percent": 12, "reset_at": 1_780_000_000 },
                },
            })),
        );
        match fetch_codex_usage().await {
            ProviderUsage::Ok {
                plan_label,
                windows,
                ..
            } => {
                assert_eq!(plan_label.as_deref(), Some("Pro"));
                assert_eq!(windows.len(), 1);
                assert_eq!(windows[0].label, "Current session");
            }
            other => panic!("expected ok variant, got {other:?}"),
        }
    }
}
