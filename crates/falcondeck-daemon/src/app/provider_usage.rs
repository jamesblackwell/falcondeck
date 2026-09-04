//! Live subscription usage snapshots for supported harnesses.
//!
//! Reads the same read-only dashboards the harness CLIs expose: Codex queries
//! the ChatGPT usage endpoint with the token from `~/.codex/auth.json` and,
//! when signed in with ChatGPT, the sibling rate-limit-reset-credits
//! endpoint for banked "Full reset" credits, Claude
//! Code queries the Anthropic OAuth usage endpoint with the token from the
//! CLI's keychain entry (macOS) or `~/.claude/.credentials.json`, Grok Build
//! queries the CLI-proxy billing endpoint with the token from
//! `~/.grok/auth.json`, Cursor Agent queries the dashboard Connect-RPC usage
//! endpoints with the token from the CLI's keychain entry (macOS) or
//! `~/.cursor/auth.json`, Antigravity queries Cloud Code quota endpoints
//! with the token from `~/.gemini/oauth_creds.json`, and Z.AI coding-plan
//! usage is read from `GET /api/monitor/usage/quota/limit` with the API key
//! OpenCode stores under `zai-coding-plan` (or `ZAI_CODING_PLAN_API_KEY`).
//! Tokens are used as-is — the daemon never refreshes another tool's
//! credentials, because rotating a refresh token out from under the owning
//! CLI breaks its next run.
//!
//! Live dashboard calls are cached on the daemon for five minutes (45 seconds
//! if any provider returned `error`). Concurrent callers share one in-flight
//! fetch. Pass `refresh=true` to bypass the cache.
//!
//! Tests swap the live transport for fixtures, which leaves the real HTTP and
//! credential helpers unreachable in that build.
#![cfg_attr(test, allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use falcondeck_core::{
    AgentProvider, ConsumeProviderResetCreditOutcome, ConsumeProviderResetCreditRequest,
    ConsumeProviderResetCreditResponse, ProviderUsage, ProviderUsageCost, ProviderUsageOverview,
    ProviderUsageResetCredit, ProviderUsageResetCredits, ProviderUsageWindow,
};
use serde_json::Value;
#[cfg(not(test))]
use tokio::fs;

use super::AppState;
use crate::error::DaemonError;

const USAGE_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(10);
/// Fresh snapshots skip the provider dashboards for this long.
const USAGE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
/// Rate-limits and network errors recover faster than plan windows change.
const USAGE_ERROR_CACHE_TTL: Duration = Duration::from_secs(45);

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_RESET_CREDITS_CONSUME_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const CHATGPT_AUTH_CLAIM_PATH: &str = "https://api.openai.com/auth";
const CHATGPT_PROFILE_CLAIM_PATH: &str = "https://api.openai.com/profile";
const FIVE_HOUR_WINDOW_SECONDS: i64 = 18_000;
const WEEKLY_WINDOW_SECONDS: i64 = 604_800;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const CLAUDE_KEYCHAIN_ACCOUNT: &str = "Claude Code";
/// `security` needs its subcommand first — without it the tool exits 2 with a
/// usage error and every credential lookup silently reads as signed out.
const KEYCHAIN_FIND_COMMAND: &str = "find-generic-password";
const CLAUDE_OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
const CLAUDE_USER_AGENT: &str = "claude-code/2.1.0";

const GROK_BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_SETTINGS_URL: &str = "https://cli-chat-proxy.grok.com/v1/settings";
const GROK_TOKEN_AUTH_HEADER: &str = "xai-grok-cli";

const CURSOR_USAGE_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_PLAN_URL: &str = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const CURSOR_ME_URL: &str = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe";
const CURSOR_KEYCHAIN_SERVICE: &str = "cursor-access-token";
const CURSOR_KEYCHAIN_ACCOUNT: &str = "cursor-user";
const CURSOR_CONNECT_PROTOCOL_VERSION: &str = "1";

const AGY_LOAD_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const AGY_SUMMARY_URL: &str =
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
/// Cloud Code 403s consumer quota calls unless the UA contains `Antigravity/`.
const AGY_USER_AGENT: &str = "Antigravity/0.0.0";
/// `ideType` must be a protocol enum. `ANTIGRAVITY` is not one.
const AGY_LOAD_BODY: &str = r#"{"metadata":{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}"#;

const ZAI_USAGE_PATH: &str = "/api/monitor/usage/quota/limit";
const ZAI_HOST: &str = "https://api.z.ai";
const ZHIPU_HOST: &str = "https://open.bigmodel.cn";

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

fn timestamp_value_to_iso(value: Option<&Value>) -> Option<String> {
    let value = value.filter(|value| !value.is_null())?;
    if let Some(seconds) = value.as_i64() {
        return epoch_seconds_to_iso(Some(normalize_epoch_seconds(seconds)));
    }
    if let Some(seconds) = value.as_u64() {
        return epoch_seconds_to_iso(Some(normalize_epoch_seconds(seconds as i64)));
    }
    if let Some(seconds) = value.as_f64() {
        if !seconds.is_finite() {
            return None;
        }
        return epoch_seconds_to_iso(Some(normalize_epoch_seconds(seconds.round() as i64)));
    }
    value
        .as_str()
        .and_then(|raw| normalize_iso_timestamp(Some(raw)))
}

fn normalize_epoch_seconds(seconds: i64) -> i64 {
    // ChatGPT sometimes returns milliseconds.
    if seconds.abs() > 10_000_000_000 {
        seconds / 1_000
    } else {
        seconds
    }
}

fn usage_ok(
    account_email: Option<String>,
    plan_label: Option<String>,
    windows: Vec<ProviderUsageWindow>,
) -> ProviderUsage {
    usage_ok_with_reset_credits(account_email, plan_label, windows, None)
}

fn usage_ok_with_reset_credits(
    account_email: Option<String>,
    plan_label: Option<String>,
    windows: Vec<ProviderUsageWindow>,
    reset_credits: Option<ProviderUsageResetCredits>,
) -> ProviderUsage {
    ProviderUsage::Ok {
        account_email,
        plan_label,
        windows,
        reset_credits,
    }
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

fn json_field<'a>(value: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    value.get(camel).or_else(|| value.get(snake))
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
    fetch_usage_request(url, headers, None).await
}

/// Same as [`fetch_usage_json`], but POST with an empty JSON object. Cursor's
/// dashboard Connect-RPC methods reject GET.
#[cfg(not(test))]
async fn post_usage_json(
    url: &str,
    headers: &[(&'static str, String)],
) -> Result<UsageHttpResponse, String> {
    post_usage_json_body(url, headers, "{}").await
}

#[cfg(not(test))]
async fn post_usage_json_body(
    url: &str,
    headers: &[(&'static str, String)],
    body: &str,
) -> Result<UsageHttpResponse, String> {
    fetch_usage_request(url, headers, Some(body)).await
}

#[cfg(not(test))]
async fn fetch_usage_request(
    url: &str,
    headers: &[(&'static str, String)],
    body: Option<&str>,
) -> Result<UsageHttpResponse, String> {
    async fn send(
        client: &reqwest::Client,
        url: &str,
        headers: &[(&'static str, String)],
        cookie: Option<&str>,
        body: Option<&str>,
    ) -> Result<UsageHttpResponse, String> {
        let mut request = match body {
            Some(body) => client.post(url).body(body.to_string()),
            None => client.get(url),
        };
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

    let client = usage_http_client()?;
    let mut response = send(
        client,
        url,
        headers,
        cloudflare_cookie_header().as_deref(),
        body,
    )
    .await?;
    if response.status == 403 && response.cloudflare_challenge {
        // Cloudflare may have handed us a fresh clearance cookie; retry once
        // with it.
        store_cloudflare_cookies(&response.cf_cookies);
        response = send(
            client,
            url,
            headers,
            cloudflare_cookie_header().as_deref(),
            body,
        )
        .await?;
    }
    Ok(response)
}

#[cfg(not(test))]
fn usage_http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .timeout(USAGE_FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to create usage client: {error}"))?;
    Ok(CLIENT.get_or_init(|| client))
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

#[cfg(test)]
async fn post_usage_json(
    url: &str,
    headers: &[(&'static str, String)],
) -> Result<UsageHttpResponse, String> {
    fetch_usage_json(url, headers).await
}

#[cfg(test)]
async fn post_usage_json_body(
    url: &str,
    headers: &[(&'static str, String)],
    _body: &str,
) -> Result<UsageHttpResponse, String> {
    fetch_usage_json(url, headers).await
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
    let label = match limit_window_seconds {
        Some(FIVE_HOUR_WINDOW_SECONDS) => "5-hour limit",
        Some(WEEKLY_WINDOW_SECONDS) => "Weekly limit",
        _ => fallback_label,
    };
    Ok(Some(ProviderUsageWindow {
        label: label.to_string(),
        used_percent: clamp_percent(used_percent),
        resets_at: epoch_seconds_to_iso(reset_at),
        cost: None,
    }))
}

fn push_codex_rate_limit_windows(
    rate_limit: &Value,
    windows: &mut Vec<ProviderUsageWindow>,
) -> Result<(), ()> {
    let Some(entries) = rate_limit.as_object() else {
        return Err(());
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
                Err(()) => return Err(()),
            },
        }
    }
    Ok(())
}

fn codex_has_label(windows: &[ProviderUsageWindow], label: &str) -> bool {
    windows.iter().any(|window| window.label == label)
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    u32::try_from(json_u64(value)?).ok()
}

fn credit_status_is_available(status: Option<&str>) -> bool {
    match status {
        None => true,
        Some(status) => status.eq_ignore_ascii_case("available"),
    }
}

fn normalize_codex_reset_credit(credit: &Value) -> Option<ProviderUsageResetCredit> {
    if !credit.is_object() {
        return None;
    }
    if !credit_status_is_available(credit.get("status").and_then(Value::as_str)) {
        return None;
    }
    let id = non_empty_string(credit.get("id"))?;
    let title = non_empty_string(credit.get("title")).unwrap_or_else(|| "Full reset".to_string());
    Some(ProviderUsageResetCredit {
        id,
        title,
        expires_at: timestamp_value_to_iso(json_field(credit, "expiresAt", "expires_at")),
        description: non_empty_string(credit.get("description")),
    })
}

fn normalize_codex_reset_credits(
    usage: &Value,
    details: Option<&Value>,
) -> Option<ProviderUsageResetCredits> {
    let mut credits = Vec::new();
    let mut detail_count = None;
    if let Some(details) = details {
        if let Some(count) = json_u32(json_field(details, "availableCount", "available_count")) {
            detail_count = Some(count);
        }
        if let Some(Value::Array(rows)) = details.get("credits") {
            credits.extend(rows.iter().filter_map(normalize_codex_reset_credit));
        }
    }
    let usage_count = json_field(usage, "rateLimitResetCredits", "rate_limit_reset_credits")
        .and_then(|summary| json_u32(json_field(summary, "availableCount", "available_count")));
    let available_count = detail_count.or(usage_count).unwrap_or(credits.len() as u32);
    if available_count == 0 && credits.is_empty() {
        return None;
    }
    Some(ProviderUsageResetCredits {
        available_count: available_count.max(credits.len() as u32),
        credits,
    })
}

fn normalize_codex_usage(
    raw: &Value,
    account_email: Option<String>,
    reset_credit_details: Option<&Value>,
) -> ProviderUsage {
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
            if push_codex_rate_limit_windows(rate_limit, &mut windows).is_err() {
                return malformed();
            }
        }
    }
    // Codex Pro currently reports the rolling 5-hour window on named extra
    // meters (e.g. Spark) while the top-level rate_limit is weekly-only.
    match raw.get("additional_rate_limits") {
        None | Some(Value::Null) => {}
        Some(Value::Array(extras)) => {
            for extra in extras {
                let Some(rate_limit) = extra.get("rate_limit").filter(|value| !value.is_null())
                else {
                    continue;
                };
                let mut extra_windows = Vec::new();
                if push_codex_rate_limit_windows(rate_limit, &mut extra_windows).is_err() {
                    return malformed();
                }
                for window in extra_windows {
                    let is_five_hour =
                        window.label == "5-hour limit" || window.label == "Current session";
                    if is_five_hour
                        && (codex_has_label(&windows, "5-hour limit")
                            || codex_has_label(&windows, "Current session"))
                    {
                        continue;
                    }
                    if window.label == "Weekly limit" && codex_has_label(&windows, "Weekly limit") {
                        continue;
                    }
                    windows.push(window);
                }
            }
        }
        Some(_) => return malformed(),
    }
    usage_ok_with_reset_credits(
        account_email,
        codex_plan_label(plan_type),
        windows,
        normalize_codex_reset_credits(raw, reset_credit_details),
    )
}

fn codex_chatgpt_headers(credentials: &CodexChatGptCredentials) -> Vec<(&'static str, String)> {
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
    headers
}

fn codex_api_key_usage() -> ProviderUsage {
    ProviderUsage::Error {
        message: "Codex is authenticated with an API key, which has no subscription usage limits."
            .to_string(),
        plan_label: None,
        account_email: None,
    }
}

async fn load_codex_chatgpt_credentials() -> Result<CodexChatGptCredentials, ProviderUsage> {
    let Some(raw) = read_codex_auth_raw().await else {
        return Err(ProviderUsage::Unauthenticated);
    };
    match parse_codex_auth(&raw) {
        CodexAuthRead::ChatGpt(credentials) => Ok(credentials),
        CodexAuthRead::ApiKey => Err(codex_api_key_usage()),
        CodexAuthRead::Missing => Err(ProviderUsage::Unauthenticated),
    }
}

async fn fetch_codex_usage() -> ProviderUsage {
    let credentials = match load_codex_chatgpt_credentials().await {
        Ok(credentials) => credentials,
        Err(status) => return status,
    };
    let headers = codex_chatgpt_headers(&credentials);
    let (usage_response, credits_response) = tokio::join!(
        fetch_usage_json(CODEX_USAGE_URL, &headers),
        fetch_usage_json(CODEX_RESET_CREDITS_URL, &headers),
    );
    let Ok(response) = usage_response else {
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
            Some(body) => {
                let credit_details = credits_response.ok().and_then(|credits| {
                    (200..300)
                        .contains(&credits.status)
                        .then_some(credits.body)
                        .flatten()
                });
                normalize_codex_usage(&body, credentials.account_email, credit_details.as_ref())
            }
            None => ProviderUsage::Error {
                message: "Codex usage response was malformed.".to_string(),
                plan_label: None,
                account_email: None,
            },
        },
    }
}

fn parse_codex_reset_consume_outcome(body: &Value) -> Option<ConsumeProviderResetCreditOutcome> {
    let raw = json_field(body, "outcome", "outcome")
        .and_then(Value::as_str)
        .or_else(|| json_field(body, "code", "code").and_then(Value::as_str))?;
    match raw {
        "reset" => Some(ConsumeProviderResetCreditOutcome::Reset),
        "nothingToReset" | "nothing_to_reset" => {
            Some(ConsumeProviderResetCreditOutcome::NothingToReset)
        }
        "noCredit" | "no_credit" => Some(ConsumeProviderResetCreditOutcome::NoCredit),
        "alreadyRedeemed" | "already_redeemed" => {
            Some(ConsumeProviderResetCreditOutcome::AlreadyRedeemed)
        }
        _ => None,
    }
}

async fn consume_codex_reset_credit_http(
    request: &ConsumeProviderResetCreditRequest,
) -> Result<ConsumeProviderResetCreditOutcome, DaemonError> {
    let credentials = match load_codex_chatgpt_credentials().await {
        Ok(credentials) => credentials,
        Err(ProviderUsage::Unauthenticated) => {
            return Err(DaemonError::BadRequest(
                "Codex is not signed in. Run `codex login`, then try again.".to_string(),
            ));
        }
        Err(ProviderUsage::Error { message, .. }) => {
            return Err(DaemonError::BadRequest(message));
        }
        Err(_) => {
            return Err(DaemonError::BadRequest(
                "Codex is not signed in. Run `codex login`, then try again.".to_string(),
            ));
        }
    };

    let mut headers = codex_chatgpt_headers(&credentials);
    headers.push(("content-type", "application/json".to_string()));
    let redeem_request_id = request
        .redeem_request_id
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut body = serde_json::json!({ "redeem_request_id": redeem_request_id });
    if let Some(credit_id) = request
        .credit_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["credit_id"] = serde_json::Value::String(credit_id.to_string());
    }
    let response =
        post_usage_json_body(CODEX_RESET_CREDITS_CONSUME_URL, &headers, &body.to_string())
            .await
            .map_err(|_| DaemonError::Rpc("Codex reset request failed.".to_string()))?;
    match response.status {
        401 => Err(DaemonError::BadRequest(
            "Your Codex session expired. Run `codex`, then try again.".to_string(),
        )),
        status if !(200..300).contains(&status) => Err(DaemonError::Rpc(format!(
            "Codex reset request failed (HTTP {status})."
        ))),
        _ => {
            let Some(body) = response.body else {
                return Err(DaemonError::Rpc(
                    "Codex reset response was malformed.".to_string(),
                ));
            };
            parse_codex_reset_consume_outcome(&body)
                .ok_or_else(|| DaemonError::Rpc("Codex reset response was malformed.".to_string()))
        }
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
    usage_ok(account_email, claude_plan_label(credentials), windows)
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
// Grok Build (xAI SuperGrok) usage
// ---------------------------------------------------------------------------

struct GrokCredentials {
    access_token: String,
    account_email: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    auth_mode: Option<String>,
}

fn grok_auth_path() -> Option<PathBuf> {
    let home = std::env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".grok")))?;
    Some(home.join("auth.json"))
}

fn grok_entry(value: &Value) -> Option<GrokCredentials> {
    let access_token = non_empty_string(value.get("key"))?;
    let expires_at = non_empty_string(value.get("expires_at")).and_then(|raw| {
        DateTime::parse_from_rfc3339(&raw)
            .ok()
            .map(|datetime| datetime.with_timezone(&Utc))
    });
    Some(GrokCredentials {
        access_token,
        account_email: non_empty_string(value.get("email")),
        expires_at,
        auth_mode: non_empty_string(value.get("auth_mode")),
    })
}

/// SuperGrok OIDC entries are keyed `https://auth.x.ai::<client-id>`. Legacy
/// session files use `https://accounts.x.ai/sign-in`.
fn parse_grok_auth(raw: &str) -> Option<GrokCredentials> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let mut preferred = None;
    let mut fallback = None;
    for (key, entry) in object {
        let Some(credentials) = grok_entry(entry) else {
            continue;
        };
        if key.starts_with("https://auth.x.ai") {
            preferred.get_or_insert(credentials);
        } else {
            fallback.get_or_insert(credentials);
        }
    }
    preferred.or(fallback)
}

fn grok_fallback_plan(auth_mode: Option<&str>) -> Option<String> {
    match auth_mode {
        Some(mode) if mode.eq_ignore_ascii_case("oidc") => Some("SuperGrok".to_string()),
        _ => None,
    }
}

fn grok_plan_from_settings(raw: &Value) -> Option<String> {
    non_empty_string(json_field(
        raw,
        "subscription_tier_display",
        "subscription_tier",
    ))
}

fn grok_window_label(period_type: Option<&str>) -> &'static str {
    match period_type {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => "Weekly limit",
        Some("USAGE_PERIOD_TYPE_MONTHLY") => "Monthly limit",
        Some("USAGE_PERIOD_TYPE_DAILY") => "Daily limit",
        _ => "Credits",
    }
}

fn grok_object_val(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.get("val").and_then(Value::as_f64))
}

fn grok_credit_percent(config: &Value) -> Option<f64> {
    if let Some(percent) =
        json_field(config, "creditUsagePercent", "credit_usage_percent").and_then(Value::as_f64)
    {
        return percent.is_finite().then_some(percent);
    }
    let used = grok_object_val(json_field(config, "onDemandUsed", "on_demand_used"));
    let cap = grok_object_val(json_field(config, "onDemandCap", "on_demand_cap"));
    match (used, cap) {
        (Some(used), Some(cap)) if cap > 0.0 && used.is_finite() && cap.is_finite() => {
            Some(used / cap * 100.0)
        }
        _ => None,
    }
}

fn grok_resets_at(config: &Value) -> Option<String> {
    let period_end = json_field(config, "currentPeriod", "current_period")
        .and_then(|period| json_field(period, "end", "end"))
        .and_then(Value::as_str);
    let billing_end =
        json_field(config, "billingPeriodEnd", "billing_period_end").and_then(Value::as_str);
    normalize_iso_timestamp(period_end).or_else(|| normalize_iso_timestamp(billing_end))
}

fn grok_headers(access_token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("authorization", format!("Bearer {access_token}")),
        ("x-xai-token-auth", GROK_TOKEN_AUTH_HEADER.to_string()),
        ("accept", "application/json".to_string()),
        ("user-agent", "falcondeck-daemon".to_string()),
    ]
}

fn normalize_grok_usage(
    raw: &Value,
    account_email: Option<String>,
    plan_label: Option<String>,
) -> ProviderUsage {
    let malformed = || ProviderUsage::Error {
        message: "Grok usage response was malformed.".to_string(),
        plan_label: plan_label.clone(),
        account_email: account_email.clone(),
    };
    let Some(config) = raw.get("config").filter(|config| config.is_object()) else {
        return malformed();
    };
    let mut windows = Vec::new();
    if let Some(percent) = grok_credit_percent(config) {
        let period_type = json_field(config, "currentPeriod", "current_period")
            .and_then(|period| json_field(period, "type", "type"))
            .and_then(Value::as_str);
        windows.push(ProviderUsageWindow {
            label: grok_window_label(period_type).to_string(),
            used_percent: clamp_percent(percent),
            resets_at: grok_resets_at(config),
            cost: None,
        });
    }
    usage_ok(account_email, plan_label, windows)
}

async fn fetch_grok_usage() -> ProviderUsage {
    let Some(raw) = read_grok_auth_raw().await else {
        return ProviderUsage::Unauthenticated;
    };
    let Some(credentials) = parse_grok_auth(&raw) else {
        return ProviderUsage::Unauthenticated;
    };
    if credentials
        .expires_at
        .is_some_and(|expires_at| Utc::now() >= expires_at)
    {
        return ProviderUsage::Expired;
    }

    let headers = grok_headers(&credentials.access_token);
    let known_plan = grok_fallback_plan(credentials.auth_mode.as_deref());
    let known_email = credentials.account_email.clone();
    let (billing, settings) = tokio::join!(
        fetch_usage_json(GROK_BILLING_URL, &headers),
        fetch_usage_json(GROK_SETTINGS_URL, &headers),
    );
    let plan_label = settings
        .ok()
        .and_then(|response| response.body)
        .as_ref()
        .and_then(grok_plan_from_settings)
        .or(known_plan.clone());

    let Ok(response) = billing else {
        return ProviderUsage::Error {
            message: "Grok usage request failed.".to_string(),
            plan_label,
            account_email: known_email,
        };
    };
    match response.status {
        401 => ProviderUsage::Expired,
        429 => ProviderUsage::Error {
            message: "Grok usage is rate limited right now. Try again shortly.".to_string(),
            plan_label,
            account_email: known_email,
        },
        status if !(200..300).contains(&status) => ProviderUsage::Error {
            message: format!("Grok usage request failed (HTTP {status})."),
            plan_label,
            account_email: known_email,
        },
        _ => match response.body {
            Some(body) => normalize_grok_usage(&body, known_email, plan_label),
            None => ProviderUsage::Error {
                message: "Grok usage response was malformed.".to_string(),
                plan_label,
                account_email: known_email,
            },
        },
    }
}

#[cfg(not(test))]
async fn read_grok_auth_raw() -> Option<String> {
    let raw = fs::read_to_string(grok_auth_path()?).await.ok()?;
    let trimmed = raw.trim().to_string();
    parse_grok_auth(&trimmed).is_some().then_some(trimmed)
}

#[cfg(test)]
async fn read_grok_auth_raw() -> Option<String> {
    test_grok_auth_file().lock().unwrap().clone()
}

// ---------------------------------------------------------------------------
// Cursor Agent CLI usage
// ---------------------------------------------------------------------------

fn cursor_auth_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.push(home.join(".cursor").join("auth.json"));
        paths.push(home.join(".config").join("cursor").join("auth.json"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(PathBuf::from(xdg).join("cursor").join("auth.json"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let appdata = PathBuf::from(appdata);
        paths.push(appdata.join("Cursor").join("auth.json"));
        paths.push(appdata.join("cursor").join("auth.json"));
    }
    paths
}

/// Accepts either a raw access token (keychain) or the CLI's `auth.json`.
fn parse_cursor_access_token(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('{') {
        let value: Value = serde_json::from_str(trimmed).ok()?;
        return non_empty_string(json_field(&value, "accessToken", "access_token"));
    }
    (!trimmed.chars().any(char::is_whitespace)).then(|| trimmed.to_string())
}

fn cursor_token_expired(token: &str) -> bool {
    decode_jwt_payload(token)
        .and_then(|payload| payload.get("exp").and_then(Value::as_i64))
        .is_some_and(|expires_at| Utc::now().timestamp() >= expires_at)
}

#[cfg(any(target_os = "macos", test))]
fn cursor_keychain_lookups() -> Vec<Vec<String>> {
    vec![
        vec![
            KEYCHAIN_FIND_COMMAND.to_string(),
            "-s".to_string(),
            CURSOR_KEYCHAIN_SERVICE.to_string(),
            "-a".to_string(),
            CURSOR_KEYCHAIN_ACCOUNT.to_string(),
            "-w".to_string(),
        ],
        vec![
            KEYCHAIN_FIND_COMMAND.to_string(),
            "-s".to_string(),
            CURSOR_KEYCHAIN_SERVICE.to_string(),
            "-w".to_string(),
        ],
    ]
}

#[cfg(target_os = "macos")]
async fn read_cursor_keychain_token() -> Option<String> {
    for args in cursor_keychain_lookups() {
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
        if parse_cursor_access_token(&trimmed).is_some() {
            return Some(trimmed);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
async fn read_cursor_keychain_token() -> Option<String> {
    None
}

#[cfg(not(test))]
async fn read_cursor_access_token() -> Option<String> {
    if let Some(raw) = read_cursor_keychain_token().await {
        return parse_cursor_access_token(&raw);
    }
    for path in cursor_auth_paths() {
        let Ok(raw) = fs::read_to_string(&path).await else {
            continue;
        };
        if let Some(token) = parse_cursor_access_token(&raw) {
            return Some(token);
        }
    }
    None
}

#[cfg(test)]
async fn read_cursor_access_token() -> Option<String> {
    let raw = test_cursor_auth_file().lock().unwrap().clone()?;
    parse_cursor_access_token(&raw)
}

fn cursor_headers(access_token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("authorization", format!("Bearer {access_token}")),
        ("accept", "application/json".to_string()),
        ("content-type", "application/json".to_string()),
        (
            "connect-protocol-version",
            CURSOR_CONNECT_PROTOCOL_VERSION.to_string(),
        ),
        ("user-agent", "falcondeck-daemon".to_string()),
    ]
}

fn cursor_plan_from_info(raw: &Value) -> Option<String> {
    json_field(raw, "planInfo", "plan_info")
        .and_then(|plan| non_empty_string(json_field(plan, "planName", "plan_name")))
}

fn cursor_email_from_me(raw: &Value) -> Option<String> {
    non_empty_string(raw.get("email"))
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    if let Some(number) = value.as_i64() {
        return u64::try_from(number).ok();
    }
    if let Some(number) = value.as_f64() {
        if number.is_finite() && number >= 0.0 {
            return Some(number.round() as u64);
        }
        return None;
    }
    value.as_str()?.parse().ok()
}

fn epoch_millis_to_iso(value: Option<&Value>) -> Option<String> {
    let millis = match value? {
        Value::String(text) => text.parse::<i64>().ok()?,
        Value::Number(number) => number.as_i64()?,
        _ => return None,
    };
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|datetime| datetime.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn normalize_cursor_usage(
    raw: &Value,
    account_email: Option<String>,
    plan_label: Option<String>,
) -> ProviderUsage {
    if !raw.is_object() {
        return ProviderUsage::Error {
            message: "Cursor usage response was malformed.".to_string(),
            plan_label,
            account_email,
        };
    }
    let mut windows = Vec::new();
    if let Some(plan_usage) = json_field(raw, "planUsage", "plan_usage") {
        let used_cents = json_u64(json_field(plan_usage, "totalSpend", "total_spend"));
        let limit_cents = json_u64(json_field(plan_usage, "limit", "limit"));
        let used_percent = match (used_cents, limit_cents) {
            (Some(used), Some(limit)) if limit > 0 => Some((used as f64) / (limit as f64) * 100.0),
            _ => json_field(plan_usage, "totalPercentUsed", "total_percent_used")
                .and_then(Value::as_f64),
        };
        if let Some(percent) = used_percent {
            let cost = match (used_cents, limit_cents) {
                (Some(used_usd_cents), Some(limit_usd_cents)) if limit_usd_cents > 0 => {
                    Some(ProviderUsageCost {
                        used_usd_cents,
                        limit_usd_cents,
                    })
                }
                _ => None,
            };
            windows.push(ProviderUsageWindow {
                label: "Monthly limit".to_string(),
                used_percent: clamp_percent(percent),
                resets_at: epoch_millis_to_iso(json_field(
                    raw,
                    "billingCycleEnd",
                    "billing_cycle_end",
                )),
                cost,
            });
        }
    }
    usage_ok(account_email, plan_label, windows)
}

async fn fetch_cursor_usage() -> ProviderUsage {
    let Some(access_token) = read_cursor_access_token().await else {
        return ProviderUsage::Unauthenticated;
    };
    if cursor_token_expired(&access_token) {
        return ProviderUsage::Expired;
    }

    let headers = cursor_headers(&access_token);
    let (usage, plan, me) = tokio::join!(
        post_usage_json(CURSOR_USAGE_URL, &headers),
        post_usage_json(CURSOR_PLAN_URL, &headers),
        post_usage_json(CURSOR_ME_URL, &headers),
    );
    let plan_label = plan
        .ok()
        .and_then(|response| response.body)
        .as_ref()
        .and_then(cursor_plan_from_info);
    let account_email = me
        .ok()
        .and_then(|response| response.body)
        .as_ref()
        .and_then(cursor_email_from_me);

    let Ok(response) = usage else {
        return ProviderUsage::Error {
            message: "Cursor usage request failed.".to_string(),
            plan_label,
            account_email,
        };
    };
    match response.status {
        401 => ProviderUsage::Expired,
        429 => ProviderUsage::Error {
            message: "Cursor usage is rate limited right now. Try again shortly.".to_string(),
            plan_label,
            account_email,
        },
        status if !(200..300).contains(&status) => ProviderUsage::Error {
            message: format!("Cursor usage request failed (HTTP {status})."),
            plan_label,
            account_email,
        },
        _ => match response.body {
            Some(body) => normalize_cursor_usage(&body, account_email, plan_label),
            None => ProviderUsage::Error {
                message: "Cursor usage response was malformed.".to_string(),
                plan_label,
                account_email,
            },
        },
    }
}

// ---------------------------------------------------------------------------
// Antigravity (`agy`) usage
// ---------------------------------------------------------------------------

struct AgyCredentials {
    access_token: String,
    account_email: Option<String>,
    expires_at: Option<DateTime<Utc>>,
}

fn agy_oauth_path() -> Option<PathBuf> {
    Some(
        PathBuf::from(std::env::var_os("HOME")?)
            .join(".gemini")
            .join("oauth_creds.json"),
    )
}

fn agy_accounts_path() -> Option<PathBuf> {
    Some(
        PathBuf::from(std::env::var_os("HOME")?)
            .join(".gemini")
            .join("google_accounts.json"),
    )
}

fn parse_agy_oauth(raw: &str) -> Option<AgyCredentials> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let access_token = non_empty_string(json_field(&value, "access_token", "accessToken"))?;
    let expires_at = json_u64(json_field(&value, "expiry_date", "expiryDate")).and_then(|millis| {
        i64::try_from(millis)
            .ok()
            .and_then(DateTime::<Utc>::from_timestamp_millis)
    });
    Some(AgyCredentials {
        access_token,
        account_email: None,
        expires_at,
    })
}

fn parse_agy_account_email(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    non_empty_string(value.get("active"))
}

fn agy_headers(access_token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("authorization", format!("Bearer {access_token}")),
        ("accept", "application/json".to_string()),
        ("content-type", "application/json".to_string()),
        ("user-agent", AGY_USER_AGENT.to_string()),
    ]
}

fn agy_plan_label(raw: &Value) -> Option<String> {
    json_field(raw, "currentTier", "current_tier")
        .and_then(|tier| non_empty_string(json_field(tier, "name", "name")))
        .or_else(|| {
            json_field(raw, "planInfo", "plan_info")
                .and_then(|plan| non_empty_string(json_field(plan, "planType", "plan_type")))
                .map(|plan| capitalize(&plan.to_ascii_lowercase()))
        })
}

fn agy_bucket_label(window: Option<&str>) -> Option<&'static str> {
    match window? {
        "5h" | "5H" | "FIVE_HOUR" | "five_hour" | "FIVE_HOUR_WINDOW" => Some("5-hour limit"),
        "weekly" | "WEEK" | "WEEKLY" | "seven_day" | "SEVEN_DAY" => Some("Weekly limit"),
        "monthly" | "MONTH" | "MONTHLY" => Some("Monthly limit"),
        _ => None,
    }
}

fn agy_remaining_fraction(quota: &Value) -> Option<f64> {
    let remaining = json_field(quota, "remainingFraction", "remaining_fraction")?;
    remaining
        .as_f64()
        .or_else(|| remaining.as_str().and_then(|text| text.parse().ok()))
        .filter(|value| value.is_finite())
}

fn normalize_agy_summary(raw: &Value) -> Vec<ProviderUsageWindow> {
    let Some(groups) = json_field(raw, "groups", "groups").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut best: HashMap<&'static str, ProviderUsageWindow> = HashMap::new();
    for group in groups {
        let Some(buckets) = json_field(group, "buckets", "buckets").and_then(Value::as_array)
        else {
            continue;
        };
        for bucket in buckets {
            if bucket
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let Some(label) =
                agy_bucket_label(json_field(bucket, "window", "window").and_then(Value::as_str))
            else {
                continue;
            };
            let Some(remaining) = agy_remaining_fraction(bucket) else {
                continue;
            };
            let used_percent = clamp_percent((1.0 - remaining) * 100.0);
            let candidate = ProviderUsageWindow {
                label: label.to_string(),
                used_percent,
                resets_at: json_field(bucket, "resetTime", "reset_time")
                    .and_then(Value::as_str)
                    .and_then(|raw| normalize_iso_timestamp(Some(raw))),
                cost: None,
            };
            match best.get(label) {
                Some(existing) if existing.used_percent >= used_percent => {}
                _ => {
                    best.insert(label, candidate);
                }
            }
        }
    }
    let mut windows: Vec<_> = best.into_values().collect();
    windows.sort_by_key(|window| match window.label.as_str() {
        "5-hour limit" => 0,
        "Weekly limit" => 1,
        _ => 2,
    });
    windows
}

fn normalize_agy_usage(
    summary: &Value,
    account_email: Option<String>,
    plan_label: Option<String>,
) -> ProviderUsage {
    usage_ok(account_email, plan_label, normalize_agy_summary(summary))
}

#[cfg(not(test))]
async fn read_agy_oauth_raw() -> Option<String> {
    let raw = fs::read_to_string(agy_oauth_path()?).await.ok()?;
    let trimmed = raw.trim().to_string();
    parse_agy_oauth(&trimmed).is_some().then_some(trimmed)
}

#[cfg(test)]
async fn read_agy_oauth_raw() -> Option<String> {
    test_agy_oauth_file().lock().unwrap().clone()
}

#[cfg(not(test))]
async fn read_agy_account_email() -> Option<String> {
    let raw = fs::read_to_string(agy_accounts_path()?).await.ok()?;
    parse_agy_account_email(raw.trim())
}

#[cfg(test)]
async fn read_agy_account_email() -> Option<String> {
    test_agy_account_email().lock().unwrap().clone()
}

async fn fetch_agy_usage() -> ProviderUsage {
    let Some(raw) = read_agy_oauth_raw().await else {
        return ProviderUsage::Unauthenticated;
    };
    let Some(mut credentials) = parse_agy_oauth(&raw) else {
        return ProviderUsage::Unauthenticated;
    };
    credentials.account_email = read_agy_account_email().await;
    if credentials
        .expires_at
        .is_some_and(|expires_at| Utc::now() >= expires_at)
    {
        return ProviderUsage::Expired;
    }

    let headers = agy_headers(&credentials.access_token);
    let known_email = credentials.account_email.clone();
    let (load, summary) = tokio::join!(
        post_usage_json_body(AGY_LOAD_URL, &headers, AGY_LOAD_BODY),
        post_usage_json_body(AGY_SUMMARY_URL, &headers, "{}"),
    );
    let plan_label = load
        .ok()
        .and_then(|response| response.body)
        .as_ref()
        .and_then(agy_plan_label);

    let Ok(summary_response) = summary else {
        return ProviderUsage::Error {
            message: "Antigravity usage request failed.".to_string(),
            plan_label,
            account_email: known_email,
        };
    };
    match summary_response.status {
        401 => ProviderUsage::Expired,
        429 => ProviderUsage::Error {
            message: "Antigravity usage is rate limited right now. Try again shortly.".to_string(),
            plan_label,
            account_email: known_email,
        },
        status if !(200..300).contains(&status) => ProviderUsage::Error {
            message: format!("Antigravity usage request failed (HTTP {status})."),
            plan_label,
            account_email: known_email,
        },
        _ => match summary_response.body {
            Some(body) => normalize_agy_usage(&body, known_email, plan_label),
            None => ProviderUsage::Error {
                message: "Antigravity usage response was malformed.".to_string(),
                plan_label,
                account_email: known_email,
            },
        },
    }
}

// ---------------------------------------------------------------------------
// Z.AI GLM coding-plan usage
// ---------------------------------------------------------------------------

/// Provider ids OpenCode stores in `auth.json`, preferred coding-plan first.
const ZAI_AUTH_PROVIDER_IDS: &[&str] =
    &["zai-coding-plan", "zhipuai-coding-plan", "zai", "zhipuai"];

const ZAI_ENV_KEYS: &[(&str, &'static str)] = &[
    ("ZAI_CODING_PLAN_API_KEY", ZAI_HOST),
    ("ZHIPUAI_CODING_PLAN_API_KEY", ZHIPU_HOST),
    ("ZAI_API_KEY", ZAI_HOST),
    ("ZHIPU_API_KEY", ZHIPU_HOST),
];

struct ZaiCredentials {
    api_key: String,
    host: &'static str,
}

fn zai_host_for(provider_id: &str) -> &'static str {
    match provider_id {
        "zhipuai-coding-plan" | "zhipuai" => ZHIPU_HOST,
        _ => ZAI_HOST,
    }
}

fn zai_quota_url(host: &str) -> String {
    format!("{host}{ZAI_USAGE_PATH}")
}

fn zai_auth_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        // OpenCode uses the XDG data dir even on macOS (`~/.local/share`).
        paths.push(
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("auth.json"),
        );
        paths.push(
            home.join("Library")
                .join("Application Support")
                .join("opencode")
                .join("auth.json"),
        );
    }
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        paths.push(PathBuf::from(xdg).join("opencode").join("auth.json"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(appdata).join("opencode").join("auth.json"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        paths.push(PathBuf::from(local).join("opencode").join("auth.json"));
    }
    paths
}

fn zai_entry(provider_id: &str, value: &Value) -> Option<ZaiCredentials> {
    match value.get("type").and_then(Value::as_str) {
        Some(kind) if !kind.eq_ignore_ascii_case("api") => return None,
        _ => {}
    }
    Some(ZaiCredentials {
        api_key: non_empty_string(value.get("key"))?,
        host: zai_host_for(provider_id),
    })
}

fn parse_zai_auth(raw: &str) -> Option<ZaiCredentials> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    for id in ZAI_AUTH_PROVIDER_IDS {
        if let Some(entry) = object.get(*id)
            && let Some(credentials) = zai_entry(id, entry)
        {
            return Some(credentials);
        }
    }
    None
}

fn zai_credentials_from_env_map(get: impl Fn(&str) -> Option<String>) -> Option<ZaiCredentials> {
    for (name, host) in ZAI_ENV_KEYS {
        if let Some(api_key) = get(name).filter(|value| !value.is_empty()) {
            return Some(ZaiCredentials { api_key, host });
        }
    }
    None
}

fn zai_credentials_from_env() -> Option<ZaiCredentials> {
    zai_credentials_from_env_map(|name| std::env::var(name).ok())
}

fn zai_headers(api_key: &str) -> Vec<(&'static str, String)> {
    vec![
        ("authorization", format!("Bearer {api_key}")),
        ("accept", "application/json".to_string()),
    ]
}

fn zai_plan_label(level: Option<&str>) -> Option<String> {
    let level = level?.trim();
    if level.is_empty() {
        return None;
    }
    let known = match level.to_ascii_lowercase().as_str() {
        "lite" => "Lite",
        "pro" => "Pro",
        "max" => "Max",
        _ => return Some(capitalize(level)),
    };
    Some(known.to_string())
}

fn zai_limit_label(limit: &Value) -> Option<&'static str> {
    let kind = json_field(limit, "type", "type")?.as_str()?;
    let unit = json_u64(json_field(limit, "unit", "unit"));
    let number = json_u64(json_field(limit, "number", "number"));
    match kind {
        "TOKENS_LIMIT" | "CREDIT_LIMIT" => match (unit, number) {
            (Some(3), Some(5)) | (None, None) => Some("5-hour limit"),
            (Some(6), Some(1)) | (Some(7), _) => Some("Weekly limit"),
            _ => None,
        },
        "TIME_LIMIT" => Some("Monthly MCP limit"),
        _ => None,
    }
}

fn zai_used_percent(limit: &Value) -> Option<u32> {
    if let Some(percent) = json_field(limit, "percentage", "percentage")
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .filter(|value| value.is_finite())
    {
        return Some(clamp_percent(percent));
    }
    let usage = json_u64(json_field(limit, "usage", "usage")).filter(|value| *value > 0)?;
    let current = json_u64(json_field(limit, "currentValue", "current_value"))?;
    Some(clamp_percent((current as f64 / usage as f64) * 100.0))
}

fn zai_payload(raw: &Value) -> &Value {
    raw.get("data")
        .filter(|value| value.is_object())
        .unwrap_or(raw)
}

fn zai_legacy_window(
    payload: &Value,
    camel: &str,
    snake: &str,
    label: &'static str,
    reset_camel: &str,
    reset_snake: &str,
) -> Option<ProviderUsageWindow> {
    let percent = json_field(payload, camel, snake).and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
    })?;
    if !percent.is_finite() {
        return None;
    }
    Some(ProviderUsageWindow {
        label: label.to_string(),
        used_percent: clamp_percent(percent),
        resets_at: epoch_millis_to_iso(json_field(payload, reset_camel, reset_snake)),
        cost: None,
    })
}

fn normalize_zai_limits(payload: &Value) -> Vec<ProviderUsageWindow> {
    if let Some(limits) = json_field(payload, "limits", "limits").and_then(Value::as_array) {
        let mut best: HashMap<&'static str, ProviderUsageWindow> = HashMap::new();
        for limit in limits {
            let Some(label) = zai_limit_label(limit) else {
                continue;
            };
            let Some(used_percent) = zai_used_percent(limit) else {
                continue;
            };
            let candidate = ProviderUsageWindow {
                label: label.to_string(),
                used_percent,
                resets_at: epoch_millis_to_iso(json_field(
                    limit,
                    "nextResetTime",
                    "next_reset_time",
                )),
                cost: None,
            };
            match best.get(label) {
                Some(existing) if existing.used_percent >= used_percent => {}
                _ => {
                    best.insert(label, candidate);
                }
            }
        }
        let mut windows: Vec<_> = best.into_values().collect();
        windows.sort_by_key(|window| match window.label.as_str() {
            "5-hour limit" => 0,
            "Weekly limit" => 1,
            _ => 2,
        });
        return windows;
    }

    [
        zai_legacy_window(
            payload,
            "fiveHourPercent",
            "five_hour_percent",
            "5-hour limit",
            "fiveHourResetTime",
            "five_hour_reset_time",
        ),
        zai_legacy_window(
            payload,
            "weeklyPercent",
            "weekly_percent",
            "Weekly limit",
            "weeklyResetTime",
            "weekly_reset_time",
        ),
        zai_legacy_window(
            payload,
            "monthlyMCPUsage",
            "monthly_mcp_usage",
            "Monthly MCP limit",
            "monthlyMcpResetTime",
            "monthly_mcp_reset_time",
        ),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn normalize_zai_usage(raw: &Value) -> ProviderUsage {
    if let Some(code) = json_u64(raw.get("code"))
        && code != 200
    {
        return ProviderUsage::Error {
            message: non_empty_string(raw.get("msg"))
                .unwrap_or_else(|| format!("Z.AI usage request failed (code {code}).")),
            plan_label: None,
            account_email: None,
        };
    }
    let payload = zai_payload(raw);
    let plan_label = zai_plan_label(
        non_empty_string(payload.get("level"))
            .or_else(|| non_empty_string(raw.get("level")))
            .as_deref(),
    );
    usage_ok(None, plan_label, normalize_zai_limits(payload))
}

#[cfg(not(test))]
async fn read_zai_auth_raw() -> Option<String> {
    for path in zai_auth_paths() {
        let Ok(raw) = fs::read_to_string(&path).await else {
            continue;
        };
        let trimmed = raw.trim().to_string();
        if parse_zai_auth(&trimmed).is_some() {
            return Some(trimmed);
        }
    }
    None
}

#[cfg(test)]
async fn read_zai_auth_raw() -> Option<String> {
    test_zai_auth_file().lock().unwrap().clone()
}

#[cfg(not(test))]
async fn read_zai_credentials() -> Option<ZaiCredentials> {
    if let Some(raw) = read_zai_auth_raw().await
        && let Some(credentials) = parse_zai_auth(&raw)
    {
        return Some(credentials);
    }
    zai_credentials_from_env()
}

#[cfg(test)]
async fn read_zai_credentials() -> Option<ZaiCredentials> {
    parse_zai_auth(&read_zai_auth_raw().await?)
}

async fn fetch_zai_usage() -> ProviderUsage {
    let Some(credentials) = read_zai_credentials().await else {
        return ProviderUsage::Unauthenticated;
    };
    let url = zai_quota_url(credentials.host);
    let Ok(response) = fetch_usage_json(&url, &zai_headers(&credentials.api_key)).await else {
        return ProviderUsage::Error {
            message: "Z.AI usage request failed.".to_string(),
            plan_label: None,
            account_email: None,
        };
    };
    match response.status {
        // API keys do not expire the way OAuth tokens do; a 401 is a bad key.
        401 => ProviderUsage::Error {
            message: "Z.AI coding-plan API key was rejected. Check the key in OpenCode, then reload usage.".to_string(),
            plan_label: None,
            account_email: None,
        },
        429 => ProviderUsage::Error {
            message: "Z.AI usage is rate limited right now. Try again shortly.".to_string(),
            plan_label: None,
            account_email: None,
        },
        status if !(200..300).contains(&status) => ProviderUsage::Error {
            message: format!("Z.AI usage request failed (HTTP {status})."),
            plan_label: None,
            account_email: None,
        },
        _ => match response.body {
            Some(body) => normalize_zai_usage(&body),
            None => ProviderUsage::Error {
                message: "Z.AI usage response was malformed.".to_string(),
                plan_label: None,
                account_email: None,
            },
        },
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

pub(super) fn harness_provider_usage_supported(id: &str) -> bool {
    matches!(id, "codex" | "claude" | "grok" | "cursor" | "agy")
}

fn usage_cache_ttl(overview: &ProviderUsageOverview) -> Duration {
    let any_error = [
        &overview.codex,
        &overview.claude_code,
        &overview.grok,
        &overview.cursor,
        &overview.agy,
        &overview.zai,
    ]
    .iter()
    .any(|usage| matches!(usage, ProviderUsage::Error { .. }));
    if any_error {
        USAGE_ERROR_CACHE_TTL
    } else {
        USAGE_CACHE_TTL
    }
}

fn cached_usage_snapshot(
    cache: &Option<(Instant, ProviderUsageOverview)>,
    now: Instant,
) -> Option<ProviderUsageOverview> {
    let (fetched_at, overview) = cache.as_ref()?;
    (now.saturating_duration_since(*fetched_at) < usage_cache_ttl(overview))
        .then(|| overview.clone())
}

impl AppState {
    /// Reads usage snapshots for the local Codex, Claude Code, Grok, Cursor,
    /// Antigravity, and Z.AI coding-plan subscriptions. Serves the daemon
    /// cache when it is still fresh unless `refresh` is set. Each provider
    /// resolves independently so one failing never blanks the others.
    pub async fn provider_usage_overview(&self, refresh: bool) -> ProviderUsageOverview {
        let now = Instant::now();
        if !refresh {
            let cache = self.inner.usage_cache.lock().unwrap();
            if let Some(overview) = cached_usage_snapshot(&cache, now) {
                return overview;
            }
        }

        let _fetch = self.inner.usage_fetch.lock().await;
        let now = Instant::now();
        if !refresh {
            let cache = self.inner.usage_cache.lock().unwrap();
            if let Some(overview) = cached_usage_snapshot(&cache, now) {
                return overview;
            }
        }

        let overview = self.fetch_provider_usage_overview().await;
        *self.inner.usage_cache.lock().unwrap() = Some((Instant::now(), overview.clone()));
        overview
    }

    /// Redeems one Codex banked rate-limit reset, then returns a fresh usage
    /// snapshot. The credit is only consumed when Codex reports `reset`.
    pub async fn consume_codex_reset_credit(
        &self,
        request: ConsumeProviderResetCreditRequest,
    ) -> Result<ConsumeProviderResetCreditResponse, DaemonError> {
        if !crate::agent_binary::agent_binary_available_cached(
            "codex",
            &self.provider_bin(&AgentProvider::CODEX),
        ) {
            return Err(DaemonError::BadRequest(
                "Codex is not installed on this Mac.".to_string(),
            ));
        }
        let outcome = consume_codex_reset_credit_http(&request).await?;
        let usage = self.provider_usage_overview(true).await;
        Ok(ConsumeProviderResetCreditResponse { outcome, usage })
    }

    async fn fetch_provider_usage_overview(&self) -> ProviderUsageOverview {
        let (codex, claude_code, grok, cursor, agy, zai) = tokio::join!(
            self.codex_usage(),
            self.claude_code_usage(),
            self.grok_usage(),
            self.cursor_usage(),
            self.agy_usage(),
            self.zai_usage()
        );
        ProviderUsageOverview {
            codex,
            claude_code,
            grok,
            cursor,
            agy,
            zai,
            refreshed_at: Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
        }
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

    async fn grok_usage(&self) -> ProviderUsage {
        if !crate::agent_binary::agent_binary_available_cached(
            "grok",
            &self.provider_bin(&AgentProvider::GROK),
        ) {
            return ProviderUsage::NotInstalled;
        }
        fetch_grok_usage().await
    }

    async fn cursor_usage(&self) -> ProviderUsage {
        // Cursor's CLI is `cursor-agent`, not `cursor` (that's the IDE).
        if !crate::agent_binary::agent_binary_available_cached("cursor-agent", "cursor-agent") {
            return ProviderUsage::NotInstalled;
        }
        fetch_cursor_usage().await
    }

    async fn agy_usage(&self) -> ProviderUsage {
        if !crate::agent_binary::agent_binary_available_cached(
            "agy",
            &self.provider_bin(&AgentProvider::AGY),
        ) {
            return ProviderUsage::NotInstalled;
        }
        fetch_agy_usage().await
    }

    async fn zai_usage(&self) -> ProviderUsage {
        // A coding-plan key is enough even when OpenCode is missing. Hide the
        // card only when there is no key *and* OpenCode is not installed.
        if read_zai_credentials().await.is_none()
            && !crate::agent_binary::agent_binary_available_cached(
                "opencode",
                &self.provider_bin(&AgentProvider::OPENCODE),
            )
        {
            return ProviderUsage::NotInstalled;
        }
        fetch_zai_usage().await
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

#[cfg(test)]
fn test_grok_auth_file() -> &'static StdMutex<Option<String>> {
    static FILE: OnceLock<StdMutex<Option<String>>> = OnceLock::new();
    FILE.get_or_init(|| StdMutex::new(None))
}

#[cfg(test)]
fn test_cursor_auth_file() -> &'static StdMutex<Option<String>> {
    static FILE: OnceLock<StdMutex<Option<String>>> = OnceLock::new();
    FILE.get_or_init(|| StdMutex::new(None))
}

#[cfg(test)]
fn test_agy_oauth_file() -> &'static StdMutex<Option<String>> {
    static FILE: OnceLock<StdMutex<Option<String>>> = OnceLock::new();
    FILE.get_or_init(|| StdMutex::new(None))
}

#[cfg(test)]
fn test_agy_account_email() -> &'static StdMutex<Option<String>> {
    static FILE: OnceLock<StdMutex<Option<String>>> = OnceLock::new();
    FILE.get_or_init(|| StdMutex::new(None))
}

#[cfg(test)]
fn test_zai_auth_file() -> &'static StdMutex<Option<String>> {
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
        *test_grok_auth_file().lock().unwrap() = None;
        *test_cursor_auth_file().lock().unwrap() = None;
        *test_agy_oauth_file().lock().unwrap() = None;
        *test_agy_account_email().lock().unwrap() = None;
        *test_zai_auth_file().lock().unwrap() = None;
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
            normalize_codex_usage(&raw, Some("codex@example.com".to_string()), None),
            ProviderUsage::Ok {
                account_email: Some("codex@example.com".to_string()),
                plan_label: Some("Pro".to_string()),
                windows: vec![
                    ProviderUsageWindow {
                        label: "5-hour limit".to_string(),
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
                reset_credits: None,
            }
        );
    }

    #[test]
    fn normalize_codex_usage_reads_additional_five_hour_windows() {
        let weekly_reset = 1_788_646_179_i64;
        let five_hour_reset = 1_788_090_266_i64;
        let raw = json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 12,
                    "reset_at": weekly_reset,
                    "limit_window_seconds": 604_800,
                },
                "secondary_window": null,
            },
            "additional_rate_limits": [
                {
                    "limit_name": "GPT-5.3-Codex-Spark",
                    "rate_limit": {
                        "primary_window": {
                            "used_percent": 4,
                            "reset_at": five_hour_reset,
                            "limit_window_seconds": 18_000,
                        },
                        "secondary_window": {
                            "used_percent": 0,
                            "limit_window_seconds": 604_800,
                        },
                    }
                }
            ],
        });

        assert_eq!(
            normalize_codex_usage(&raw, None, None),
            ProviderUsage::Ok {
                account_email: None,
                plan_label: Some("Pro".to_string()),
                windows: vec![
                    ProviderUsageWindow {
                        label: "Weekly limit".to_string(),
                        used_percent: 12,
                        resets_at: epoch_seconds_to_iso(Some(weekly_reset)),
                        cost: None,
                    },
                    ProviderUsageWindow {
                        label: "5-hour limit".to_string(),
                        used_percent: 4,
                        resets_at: epoch_seconds_to_iso(Some(five_hour_reset)),
                        cost: None,
                    },
                ],
                reset_credits: None,
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
            normalize_codex_usage(&raw, None, None),
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
                reset_credits: None,
            }
        );
    }

    #[test]
    fn normalize_codex_usage_allows_absent_rate_limits() {
        assert_eq!(
            normalize_codex_usage(&json!({ "plan_type": "plus" }), None, None),
            ProviderUsage::Ok {
                account_email: None,
                plan_label: Some("Plus".to_string()),
                windows: Vec::new(),
                reset_credits: None,
            }
        );
    }

    #[test]
    fn normalize_codex_usage_flags_malformed_payloads() {
        let raw = json!({ "rate_limit": { "primary_window": { "used_percent": "lots" } } });
        match normalize_codex_usage(&raw, None, None) {
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
                reset_credits: None,
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
                reset_credits: None,
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
                reset_credits: None,
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
                reset_credits: None,
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

    #[test]
    fn normalize_codex_usage_maps_reset_credit_details() {
        let raw = json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": { "used_percent": 12, "limit_window_seconds": 18_000 },
            },
            "rate_limit_reset_credits": { "available_count": 2 },
        });
        let details = json!({
            "available_count": 2,
            "credits": [
                {
                    "id": "RateLimitResetCredit_1",
                    "status": "available",
                    "title": "Full reset",
                    "expires_at": "2026-09-21T00:02:00Z",
                },
                {
                    "id": "RateLimitResetCredit_used",
                    "status": "redeemed",
                    "title": "Full reset",
                    "expires_at": "2026-10-04T02:11:00Z",
                },
                {
                    "id": "RateLimitResetCredit_2",
                    "reset_type": "codex_rate_limits",
                    "status": "available",
                    "expires_at": 1_759_546_260_i64,
                },
            ],
        });
        match normalize_codex_usage(&raw, None, Some(&details)) {
            ProviderUsage::Ok {
                reset_credits: Some(credits),
                ..
            } => {
                assert_eq!(credits.available_count, 2);
                assert_eq!(credits.credits.len(), 2);
                assert_eq!(credits.credits[0].id, "RateLimitResetCredit_1");
                assert_eq!(credits.credits[0].title, "Full reset");
                assert_eq!(
                    credits.credits[0].expires_at.as_deref(),
                    Some("2026-09-21T00:02:00.000Z")
                );
                assert_eq!(credits.credits[1].id, "RateLimitResetCredit_2");
                assert_eq!(credits.credits[1].title, "Full reset");
            }
            other => panic!("expected ok with reset credits, got {other:?}"),
        }
    }

    #[test]
    fn normalize_codex_usage_keeps_count_when_details_are_missing() {
        let raw = json!({
            "plan_type": "plus",
            "rate_limit_reset_credits": { "available_count": 1 },
        });
        match normalize_codex_usage(&raw, None, None) {
            ProviderUsage::Ok {
                reset_credits: Some(credits),
                ..
            } => {
                assert_eq!(credits.available_count, 1);
                assert!(credits.credits.is_empty());
            }
            other => panic!("expected count-only reset credits, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn fetch_codex_usage_attaches_reset_credits_and_survives_detail_errors() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_codex_auth_file().lock().unwrap() = Some(codex_auth_json("token"));
        test_http_fixtures().lock().unwrap().insert(
            CODEX_USAGE_URL.to_string(),
            ok_response(json!({
                "plan_type": "pro",
                "rate_limit": {
                    "primary_window": { "used_percent": 40, "limit_window_seconds": 18_000 },
                },
                "rate_limit_reset_credits": { "available_count": 2 },
            })),
        );
        test_http_fixtures().lock().unwrap().insert(
            CODEX_RESET_CREDITS_URL.to_string(),
            ok_response(json!({
                "available_count": 2,
                "credits": [{
                    "id": "RateLimitResetCredit_1",
                    "status": "available",
                    "title": "Full reset",
                    "expires_at": "2026-09-21T00:02:00Z",
                }],
            })),
        );
        match fetch_codex_usage().await {
            ProviderUsage::Ok {
                reset_credits: Some(credits),
                ..
            } => {
                assert_eq!(credits.available_count, 2);
                assert_eq!(credits.credits[0].id, "RateLimitResetCredit_1");
            }
            other => panic!("expected reset credits, got {other:?}"),
        }

        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(CODEX_RESET_CREDITS_URL.to_string(), error_response(503));
        match fetch_codex_usage().await {
            ProviderUsage::Ok {
                windows,
                reset_credits: Some(credits),
                ..
            } => {
                assert_eq!(windows.len(), 1);
                assert_eq!(credits.available_count, 2);
                assert!(credits.credits.is_empty());
            }
            other => panic!("expected usage without credit details, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn consume_codex_reset_credit_maps_backend_outcomes() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_codex_auth_file().lock().unwrap() = Some(codex_auth_json("token"));
        test_http_fixtures().lock().unwrap().insert(
            CODEX_RESET_CREDITS_CONSUME_URL.to_string(),
            ok_response(json!({ "code": "nothingToReset", "windows_reset": 0 })),
        );
        assert_eq!(
            consume_codex_reset_credit_http(&ConsumeProviderResetCreditRequest {
                credit_id: Some("RateLimitResetCredit_1".to_string()),
                redeem_request_id: Some("req-1".to_string()),
            })
            .await
            .expect("consume"),
            ConsumeProviderResetCreditOutcome::NothingToReset
        );

        test_http_fixtures().lock().unwrap().insert(
            CODEX_RESET_CREDITS_CONSUME_URL.to_string(),
            ok_response(json!({ "outcome": "reset" })),
        );
        assert_eq!(
            consume_codex_reset_credit_http(&ConsumeProviderResetCreditRequest::default())
                .await
                .expect("consume"),
            ConsumeProviderResetCreditOutcome::Reset
        );
    }

    #[tokio::test]
    async fn consume_codex_reset_credit_requires_chatgpt_login() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        let error = consume_codex_reset_credit_http(&ConsumeProviderResetCreditRequest::default())
            .await
            .expect_err("signed out");
        assert!(error.to_string().contains("not signed in"));
    }

    fn grok_auth_json(token: &str, email: &str, expires_at: &str) -> String {
        json!({
            "https://auth.x.ai::client": {
                "key": token,
                "auth_mode": "oidc",
                "email": email,
                "expires_at": expires_at,
            }
        })
        .to_string()
    }

    fn future_expiry() -> String {
        (Utc::now() + chrono::Duration::hours(6)).to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    fn past_expiry() -> String {
        (Utc::now() - chrono::Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    #[test]
    fn parse_grok_auth_prefers_auth_xai_entries() {
        let raw = json!({
            "https://accounts.x.ai/sign-in": {
                "key": "legacy-token",
                "auth_mode": "session",
                "email": "legacy@example.com",
                "expires_at": future_expiry(),
            },
            "https://auth.x.ai::client": {
                "key": "oidc-token",
                "auth_mode": "oidc",
                "email": "james@example.com",
                "expires_at": future_expiry(),
            }
        })
        .to_string();
        let credentials = parse_grok_auth(&raw).expect("credentials");
        assert_eq!(credentials.access_token, "oidc-token");
        assert_eq!(
            credentials.account_email.as_deref(),
            Some("james@example.com")
        );
        assert_eq!(credentials.auth_mode.as_deref(), Some("oidc"));
    }

    #[test]
    fn grok_window_labels_follow_period_type() {
        assert_eq!(
            grok_window_label(Some("USAGE_PERIOD_TYPE_WEEKLY")),
            "Weekly limit"
        );
        assert_eq!(
            grok_window_label(Some("USAGE_PERIOD_TYPE_MONTHLY")),
            "Monthly limit"
        );
        assert_eq!(grok_window_label(None), "Credits");
    }

    #[test]
    fn normalize_grok_usage_maps_weekly_percent_and_reset() {
        let raw = json!({
            "config": {
                "creditUsagePercent": 49.4,
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "end": "2026-08-23T11:52:18.016069+00:00"
                }
            }
        });
        assert_eq!(
            normalize_grok_usage(
                &raw,
                Some("james@example.com".to_string()),
                Some("SuperGrok Heavy".to_string()),
            ),
            ProviderUsage::Ok {
                account_email: Some("james@example.com".to_string()),
                plan_label: Some("SuperGrok Heavy".to_string()),
                windows: vec![ProviderUsageWindow {
                    label: "Weekly limit".to_string(),
                    used_percent: 49,
                    resets_at: Some("2026-08-23T11:52:18.016Z".to_string()),
                    cost: None,
                }],
                reset_credits: None,
            }
        );
    }

    #[test]
    fn normalize_grok_usage_falls_back_to_on_demand_ratio() {
        let raw = json!({
            "config": {
                "onDemandUsed": { "val": 25 },
                "onDemandCap": { "val": 100 },
                "billingPeriodEnd": "2026-09-01T00:00:00Z"
            }
        });
        match normalize_grok_usage(&raw, None, None) {
            ProviderUsage::Ok { windows, .. } => {
                assert_eq!(windows[0].used_percent, 25);
                assert_eq!(windows[0].label, "Credits");
                assert_eq!(
                    windows[0].resets_at.as_deref(),
                    Some("2026-09-01T00:00:00.000Z")
                );
            }
            other => panic!("expected ok variant, got {other:?}"),
        }
    }

    #[test]
    fn normalize_grok_usage_allows_missing_percent() {
        assert_eq!(
            normalize_grok_usage(
                &json!({ "config": {} }),
                None,
                Some("SuperGrok".to_string())
            ),
            ProviderUsage::Ok {
                account_email: None,
                plan_label: Some("SuperGrok".to_string()),
                windows: Vec::new(),
                reset_credits: None,
            }
        );
    }

    #[tokio::test]
    async fn grok_usage_reports_unauthenticated_without_credentials() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        assert_eq!(fetch_grok_usage().await, ProviderUsage::Unauthenticated);
    }

    #[tokio::test]
    async fn grok_usage_reports_expired_for_stale_tokens() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_grok_auth_file().lock().unwrap() =
            Some(grok_auth_json("token", "james@example.com", &past_expiry()));
        assert_eq!(fetch_grok_usage().await, ProviderUsage::Expired);
    }

    #[tokio::test]
    async fn grok_usage_reports_expired_on_401() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_grok_auth_file().lock().unwrap() = Some(grok_auth_json(
            "token",
            "james@example.com",
            &future_expiry(),
        ));
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(GROK_BILLING_URL.to_string(), error_response(401));
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(GROK_SETTINGS_URL.to_string(), error_response(401));
        assert_eq!(fetch_grok_usage().await, ProviderUsage::Expired);
    }

    #[tokio::test]
    async fn grok_usage_keeps_known_plan_on_http_errors() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_grok_auth_file().lock().unwrap() = Some(grok_auth_json(
            "token",
            "james@example.com",
            &future_expiry(),
        ));
        test_http_fixtures().lock().unwrap().insert(
            GROK_SETTINGS_URL.to_string(),
            ok_response(json!({ "subscription_tier_display": "SuperGrok Heavy" })),
        );
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(GROK_BILLING_URL.to_string(), error_response(503));
        match fetch_grok_usage().await {
            ProviderUsage::Error {
                message,
                plan_label,
                account_email,
            } => {
                assert!(message.contains("HTTP 503"));
                assert_eq!(plan_label.as_deref(), Some("SuperGrok Heavy"));
                assert_eq!(account_email.as_deref(), Some("james@example.com"));
            }
            other => panic!("expected error variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn grok_usage_normalizes_a_successful_response() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_grok_auth_file().lock().unwrap() = Some(grok_auth_json(
            "token",
            "james@example.com",
            &future_expiry(),
        ));
        test_http_fixtures().lock().unwrap().insert(
            GROK_BILLING_URL.to_string(),
            ok_response(json!({
                "config": {
                    "creditUsagePercent": 12.0,
                    "currentPeriod": {
                        "type": "USAGE_PERIOD_TYPE_WEEKLY",
                        "end": "2026-08-23T11:52:18Z"
                    }
                }
            })),
        );
        test_http_fixtures().lock().unwrap().insert(
            GROK_SETTINGS_URL.to_string(),
            ok_response(json!({ "subscription_tier_display": "SuperGrok Heavy" })),
        );
        assert_eq!(
            fetch_grok_usage().await,
            ProviderUsage::Ok {
                account_email: Some("james@example.com".to_string()),
                plan_label: Some("SuperGrok Heavy".to_string()),
                windows: vec![ProviderUsageWindow {
                    label: "Weekly limit".to_string(),
                    used_percent: 12,
                    resets_at: Some("2026-08-23T11:52:18.000Z".to_string()),
                    cost: None,
                }],
                reset_credits: None,
            }
        );
    }

    #[test]
    fn cursor_keychain_lookups_lead_with_the_security_subcommand() {
        let lookups = cursor_keychain_lookups();
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
                    CURSOR_KEYCHAIN_SERVICE,
                    "-a",
                    CURSOR_KEYCHAIN_ACCOUNT,
                    "-w"
                ],
                vec!["find-generic-password", "-s", CURSOR_KEYCHAIN_SERVICE, "-w"],
            ]
        );
    }

    #[test]
    fn parse_cursor_access_token_accepts_raw_and_auth_json() {
        assert_eq!(
            parse_cursor_access_token("  eyJraw.token  ").as_deref(),
            Some("eyJraw.token")
        );
        assert_eq!(
            parse_cursor_access_token(r#"{"accessToken":"eyJfromjson","refreshToken":"x"}"#)
                .as_deref(),
            Some("eyJfromjson")
        );
        assert_eq!(
            parse_cursor_access_token(r#"{"access_token":"snake"}"#).as_deref(),
            Some("snake")
        );
        assert!(parse_cursor_access_token(r#"{"apiKey":"crsr_only"}"#).is_none());
        assert!(parse_cursor_access_token("two words").is_none());
        assert!(parse_cursor_access_token("").is_none());
    }

    #[test]
    fn cursor_token_expired_reads_jwt_exp() {
        let future = fake_codex_jwt("acct", None, false);
        assert!(!cursor_token_expired(&future));
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"exp":1}"#);
        assert!(cursor_token_expired(&format!("{header}.{payload}.sig")));
        assert!(!cursor_token_expired("not-a-jwt"));
    }

    #[test]
    fn normalize_cursor_usage_maps_spend_ratio_cost_and_reset() {
        let raw = json!({
            "billingCycleEnd": "1789802081000",
            "planUsage": {
                "totalSpend": 38168,
                "limit": 40000,
                "totalPercentUsed": 10.9,
            }
        });
        assert_eq!(
            normalize_cursor_usage(
                &raw,
                Some("james@example.com".to_string()),
                Some("Ultra".to_string()),
            ),
            ProviderUsage::Ok {
                account_email: Some("james@example.com".to_string()),
                plan_label: Some("Ultra".to_string()),
                windows: vec![ProviderUsageWindow {
                    label: "Monthly limit".to_string(),
                    used_percent: 95,
                    resets_at: epoch_millis_to_iso(Some(&json!("1789802081000"))),
                    cost: Some(ProviderUsageCost {
                        used_usd_cents: 38168,
                        limit_usd_cents: 40000,
                    }),
                }],
                reset_credits: None,
            }
        );
    }

    #[test]
    fn normalize_cursor_usage_falls_back_to_reported_percent() {
        let raw = json!({
            "billing_cycle_end": 1_789_802_081_000_i64,
            "plan_usage": {
                "total_percent_used": 12.4
            }
        });
        match normalize_cursor_usage(&raw, None, None) {
            ProviderUsage::Ok { windows, .. } => {
                assert_eq!(windows[0].used_percent, 12);
                assert_eq!(windows[0].cost, None);
                assert_eq!(
                    windows[0].resets_at,
                    epoch_millis_to_iso(Some(&json!(1_789_802_081_000_i64)))
                );
            }
            other => panic!("expected ok variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cursor_usage_reports_unauthenticated_without_credentials() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        assert_eq!(fetch_cursor_usage().await, ProviderUsage::Unauthenticated);
    }

    #[tokio::test]
    async fn cursor_usage_reports_expired_for_stale_jwt() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"exp":1}"#);
        *test_cursor_auth_file().lock().unwrap() = Some(format!("{header}.{payload}.sig"));
        assert_eq!(fetch_cursor_usage().await, ProviderUsage::Expired);
    }

    #[tokio::test]
    async fn cursor_usage_reports_expired_on_401() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_cursor_auth_file().lock().unwrap() = Some("cursor-token".to_string());
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(CURSOR_USAGE_URL.to_string(), error_response(401));
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(CURSOR_PLAN_URL.to_string(), error_response(401));
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(CURSOR_ME_URL.to_string(), error_response(401));
        assert_eq!(fetch_cursor_usage().await, ProviderUsage::Expired);
    }

    #[tokio::test]
    async fn cursor_usage_keeps_known_plan_on_http_errors() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_cursor_auth_file().lock().unwrap() = Some("cursor-token".to_string());
        test_http_fixtures().lock().unwrap().insert(
            CURSOR_PLAN_URL.to_string(),
            ok_response(json!({ "planInfo": { "planName": "Ultra" } })),
        );
        test_http_fixtures().lock().unwrap().insert(
            CURSOR_ME_URL.to_string(),
            ok_response(json!({ "email": "james@example.com" })),
        );
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(CURSOR_USAGE_URL.to_string(), error_response(503));
        match fetch_cursor_usage().await {
            ProviderUsage::Error {
                message,
                plan_label,
                account_email,
            } => {
                assert!(message.contains("HTTP 503"));
                assert_eq!(plan_label.as_deref(), Some("Ultra"));
                assert_eq!(account_email.as_deref(), Some("james@example.com"));
            }
            other => panic!("expected error variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cursor_usage_normalizes_a_successful_response() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_cursor_auth_file().lock().unwrap() = Some("cursor-token".to_string());
        test_http_fixtures().lock().unwrap().insert(
            CURSOR_USAGE_URL.to_string(),
            ok_response(json!({
                "billingCycleEnd": "1789802081000",
                "planUsage": {
                    "totalSpend": 1520,
                    "limit": 40000,
                    "totalPercentUsed": 3.8
                }
            })),
        );
        test_http_fixtures().lock().unwrap().insert(
            CURSOR_PLAN_URL.to_string(),
            ok_response(json!({ "planInfo": { "planName": "Ultra" } })),
        );
        test_http_fixtures().lock().unwrap().insert(
            CURSOR_ME_URL.to_string(),
            ok_response(json!({ "email": "james@example.com" })),
        );
        assert_eq!(
            fetch_cursor_usage().await,
            ProviderUsage::Ok {
                account_email: Some("james@example.com".to_string()),
                plan_label: Some("Ultra".to_string()),
                windows: vec![ProviderUsageWindow {
                    label: "Monthly limit".to_string(),
                    used_percent: 4,
                    resets_at: epoch_millis_to_iso(Some(&json!("1789802081000"))),
                    cost: Some(ProviderUsageCost {
                        used_usd_cents: 1520,
                        limit_usd_cents: 40000,
                    }),
                }],
                reset_credits: None,
            }
        );
    }

    fn future_agy_oauth() -> String {
        json!({
            "access_token": "agy-token",
            "expiry_date": (Utc::now() + chrono::Duration::hours(1)).timestamp_millis(),
        })
        .to_string()
    }

    fn past_agy_oauth() -> String {
        json!({
            "access_token": "agy-token",
            "expiry_date": (Utc::now() - chrono::Duration::hours(1)).timestamp_millis(),
        })
        .to_string()
    }

    #[test]
    fn normalize_agy_summary_keeps_the_most_used_five_hour_and_weekly() {
        let raw = json!({
            "groups": [
                {
                    "displayName": "Gemini Models",
                    "buckets": [
                        {
                            "window": "5h",
                            "remainingFraction": 0.2,
                            "resetTime": "2026-08-30T12:00:00Z"
                        },
                        {
                            "window": "5h",
                            "remainingFraction": 0.9,
                            "resetTime": "2026-08-30T12:00:00Z"
                        },
                        {
                            "window": "weekly",
                            "remainingFraction": 0.4,
                            "resetTime": "2026-09-05T12:00:00Z"
                        }
                    ]
                }
            ]
        });
        let windows = normalize_agy_summary(&raw);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "5-hour limit");
        assert_eq!(windows[0].used_percent, 80);
        assert_eq!(windows[1].label, "Weekly limit");
        assert_eq!(windows[1].used_percent, 60);
    }

    #[test]
    fn normalize_codex_usage_skips_null_additional_rate_limits() {
        let raw = json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 12,
                    "limit_window_seconds": 604_800,
                }
            },
            "additional_rate_limits": [
                { "limit_name": "unused", "rate_limit": null },
                {}
            ]
        });
        match normalize_codex_usage(&raw, None, None) {
            ProviderUsage::Ok { windows, .. } => {
                assert_eq!(windows.len(), 1);
                assert_eq!(windows[0].label, "Weekly limit");
            }
            other => panic!("expected ok variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn agy_usage_reports_unauthenticated_without_credentials() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        assert_eq!(fetch_agy_usage().await, ProviderUsage::Unauthenticated);
    }

    #[tokio::test]
    async fn agy_usage_reports_expired_for_stale_tokens() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_agy_oauth_file().lock().unwrap() = Some(past_agy_oauth());
        assert_eq!(fetch_agy_usage().await, ProviderUsage::Expired);
    }

    #[tokio::test]
    async fn agy_usage_normalizes_a_successful_response() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_agy_oauth_file().lock().unwrap() = Some(future_agy_oauth());
        *test_agy_account_email().lock().unwrap() = Some("james@example.com".to_string());
        test_http_fixtures().lock().unwrap().insert(
            AGY_LOAD_URL.to_string(),
            ok_response(json!({
                "currentTier": { "name": "Google AI Pro" },
                "cloudaicompanionProject": "projects/demo"
            })),
        );
        test_http_fixtures().lock().unwrap().insert(
            AGY_SUMMARY_URL.to_string(),
            ok_response(json!({
                "groups": [
                    {
                        "buckets": [
                            {
                                "window": "5h",
                                "remainingFraction": 0.5,
                                "resetTime": "2026-08-30T12:00:00Z"
                            }
                        ]
                    }
                ]
            })),
        );
        match fetch_agy_usage().await {
            ProviderUsage::Ok {
                account_email,
                plan_label,
                windows,
                ..
            } => {
                assert_eq!(account_email.as_deref(), Some("james@example.com"));
                assert_eq!(plan_label.as_deref(), Some("Google AI Pro"));
                assert_eq!(windows.len(), 1);
                assert_eq!(windows[0].label, "5-hour limit");
                assert_eq!(windows[0].used_percent, 50);
            }
            other => panic!("expected ok variant, got {other:?}"),
        }
    }

    fn zai_auth_json(provider_id: &str, key: &str) -> String {
        json!({ provider_id: { "type": "api", "key": key } }).to_string()
    }

    #[test]
    fn parse_zai_auth_prefers_coding_plan_over_generic() {
        let raw = json!({
            "zai": { "type": "api", "key": "generic-key" },
            "zai-coding-plan": { "type": "api", "key": "plan-key" },
        })
        .to_string();
        let credentials = parse_zai_auth(&raw).expect("coding-plan key");
        assert_eq!(credentials.api_key, "plan-key");
        assert_eq!(credentials.host, ZAI_HOST);
    }

    #[test]
    fn parse_zai_auth_routes_zhipu_to_bigmodel() {
        let credentials =
            parse_zai_auth(&zai_auth_json("zhipuai-coding-plan", "zhipu-key")).expect("zhipu key");
        assert_eq!(credentials.host, ZHIPU_HOST);
        assert_eq!(credentials.api_key, "zhipu-key");
    }

    #[test]
    fn parse_zai_auth_ignores_oauth_entries() {
        let raw = json!({
            "zai-coding-plan": { "type": "oauth", "refresh": "x", "access": "y" }
        })
        .to_string();
        assert!(parse_zai_auth(&raw).is_none());
    }

    #[test]
    fn zai_env_prefers_coding_plan_key() {
        let credentials = zai_credentials_from_env_map(|name| match name {
            "ZAI_API_KEY" => Some("generic".to_string()),
            "ZAI_CODING_PLAN_API_KEY" => Some("plan".to_string()),
            _ => None,
        })
        .expect("env key");
        assert_eq!(credentials.api_key, "plan");
        assert_eq!(credentials.host, ZAI_HOST);
    }

    #[test]
    fn zai_plan_labels_map_known_tiers() {
        assert_eq!(zai_plan_label(Some("max")), Some("Max".to_string()));
        assert_eq!(zai_plan_label(Some("PRO")), Some("Pro".to_string()));
        assert_eq!(zai_plan_label(Some("lite")), Some("Lite".to_string()));
        assert_eq!(zai_plan_label(Some("team")), Some("Team".to_string()));
        assert_eq!(zai_plan_label(None), None);
    }

    #[test]
    fn normalize_zai_usage_maps_live_max_payload() {
        let raw = json!({
            "code": 200,
            "msg": "Operation successful",
            "success": true,
            "data": {
                "level": "max",
                "limits": [
                    {
                        "type": "TIME_LIMIT",
                        "unit": 5,
                        "number": 1,
                        "usage": 4000,
                        "currentValue": 6,
                        "remaining": 3994,
                        "percentage": 1,
                        "nextResetTime": 1_790_009_362_997_i64
                    },
                    {
                        "type": "TOKENS_LIMIT",
                        "unit": 3,
                        "number": 5,
                        "percentage": 1,
                        "nextResetTime": 1_788_078_815_019_i64
                    }
                ]
            }
        });
        assert_eq!(
            normalize_zai_usage(&raw),
            ProviderUsage::Ok {
                account_email: None,
                plan_label: Some("Max".to_string()),
                windows: vec![
                    ProviderUsageWindow {
                        label: "5-hour limit".to_string(),
                        used_percent: 1,
                        resets_at: epoch_millis_to_iso(Some(&json!(1_788_078_815_019_i64))),
                        cost: None,
                    },
                    ProviderUsageWindow {
                        label: "Monthly MCP limit".to_string(),
                        used_percent: 1,
                        resets_at: epoch_millis_to_iso(Some(&json!(1_790_009_362_997_i64))),
                        cost: None,
                    },
                ],
                reset_credits: None,
            }
        );
    }

    #[test]
    fn normalize_zai_usage_maps_weekly_and_skips_unknown_token_units() {
        let raw = json!({
            "limits": [
                {
                    "type": "TOKENS_LIMIT",
                    "unit": 3,
                    "number": 5,
                    "percentage": 12
                },
                {
                    "type": "CREDIT_LIMIT",
                    "unit": 6,
                    "number": 1,
                    "percentage": 40
                },
                {
                    "type": "TOKENS_LIMIT",
                    "unit": 1,
                    "number": 1,
                    "percentage": 99
                },
                {
                    "type": "TIME_LIMIT",
                    "percentage": 8
                }
            ],
            "level": "pro"
        });
        match normalize_zai_usage(&raw) {
            ProviderUsage::Ok {
                plan_label,
                windows,
                ..
            } => {
                assert_eq!(plan_label.as_deref(), Some("Pro"));
                assert_eq!(windows.len(), 3);
                assert_eq!(windows[0].label, "5-hour limit");
                assert_eq!(windows[0].used_percent, 12);
                assert_eq!(windows[1].label, "Weekly limit");
                assert_eq!(windows[1].used_percent, 40);
                assert_eq!(windows[2].label, "Monthly MCP limit");
                assert_eq!(windows[2].used_percent, 8);
            }
            other => panic!("expected ok variant, got {other:?}"),
        }
    }

    #[test]
    fn normalize_zai_usage_falls_back_to_legacy_percents() {
        let raw = json!({
            "fiveHourPercent": 22.4,
            "weeklyPercent": 10,
            "monthlyMCPUsage": 3,
            "level": "lite"
        });
        match normalize_zai_usage(&raw) {
            ProviderUsage::Ok {
                plan_label,
                windows,
                ..
            } => {
                assert_eq!(plan_label.as_deref(), Some("Lite"));
                assert_eq!(
                    windows
                        .iter()
                        .map(|window| (window.label.as_str(), window.used_percent))
                        .collect::<Vec<_>>(),
                    vec![
                        ("5-hour limit", 22),
                        ("Weekly limit", 10),
                        ("Monthly MCP limit", 3),
                    ]
                );
            }
            other => panic!("expected ok variant, got {other:?}"),
        }
    }

    #[test]
    fn normalize_zai_usage_reports_api_error_code() {
        match normalize_zai_usage(&json!({ "code": 401, "msg": "Invalid API key" })) {
            ProviderUsage::Error { message, .. } => {
                assert_eq!(message, "Invalid API key");
            }
            other => panic!("expected error variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn zai_usage_reports_unauthenticated_without_credentials() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        assert_eq!(fetch_zai_usage().await, ProviderUsage::Unauthenticated);
    }

    #[tokio::test]
    async fn zai_usage_reports_error_not_expired_on_401() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_zai_auth_file().lock().unwrap() = Some(zai_auth_json("zai-coding-plan", "zai-key"));
        test_http_fixtures()
            .lock()
            .unwrap()
            .insert(zai_quota_url(ZAI_HOST), error_response(401));
        match fetch_zai_usage().await {
            ProviderUsage::Error { message, .. } => {
                assert!(message.contains("rejected"), "{message}");
            }
            other => panic!("expected error variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn zai_usage_normalizes_a_successful_response() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_zai_auth_file().lock().unwrap() = Some(zai_auth_json("zai-coding-plan", "zai-key"));
        test_http_fixtures().lock().unwrap().insert(
            zai_quota_url(ZAI_HOST),
            ok_response(json!({
                "code": 200,
                "data": {
                    "level": "max",
                    "limits": [
                        {
                            "type": "TOKENS_LIMIT",
                            "unit": 3,
                            "number": 5,
                            "percentage": 4,
                            "nextResetTime": 1_788_078_815_019_i64
                        }
                    ]
                }
            })),
        );
        assert_eq!(
            fetch_zai_usage().await,
            ProviderUsage::Ok {
                account_email: None,
                plan_label: Some("Max".to_string()),
                windows: vec![ProviderUsageWindow {
                    label: "5-hour limit".to_string(),
                    used_percent: 4,
                    resets_at: epoch_millis_to_iso(Some(&json!(1_788_078_815_019_i64))),
                    cost: None,
                }],
                reset_credits: None,
            }
        );
    }

    #[tokio::test]
    async fn zai_usage_hits_zhipu_host_for_zhipu_keys() {
        let _guard = usage_test_guard().await;
        clear_fixtures();
        *test_zai_auth_file().lock().unwrap() =
            Some(zai_auth_json("zhipuai-coding-plan", "zhipu-key"));
        test_http_fixtures().lock().unwrap().insert(
            zai_quota_url(ZHIPU_HOST),
            ok_response(json!({
                "data": {
                    "level": "pro",
                    "limits": [{
                        "type": "TOKENS_LIMIT",
                        "unit": 3,
                        "number": 5,
                        "percentage": 9
                    }]
                }
            })),
        );
        match fetch_zai_usage().await {
            ProviderUsage::Ok {
                plan_label,
                windows,
                ..
            } => {
                assert_eq!(plan_label.as_deref(), Some("Pro"));
                assert_eq!(windows[0].used_percent, 9);
            }
            other => panic!("expected ok variant, got {other:?}"),
        }
    }

    fn sample_overview(codex: ProviderUsage) -> ProviderUsageOverview {
        ProviderUsageOverview {
            codex,
            claude_code: ProviderUsage::NotInstalled,
            grok: ProviderUsage::NotInstalled,
            cursor: ProviderUsage::NotInstalled,
            agy: ProviderUsage::NotInstalled,
            zai: ProviderUsage::NotInstalled,
            refreshed_at: Some("2026-08-30T12:00:00.000Z".to_string()),
        }
    }

    #[test]
    fn usage_cache_ttl_is_shorter_when_any_provider_errored() {
        assert_eq!(
            usage_cache_ttl(&sample_overview(ProviderUsage::Unauthenticated)),
            USAGE_CACHE_TTL
        );
        assert_eq!(
            usage_cache_ttl(&sample_overview(ProviderUsage::Error {
                message: "rate limited".to_string(),
                plan_label: None,
                account_email: None,
            })),
            USAGE_ERROR_CACHE_TTL
        );
    }

    #[test]
    fn cached_usage_snapshot_hits_within_ttl_and_misses_after() {
        let fetched = Instant::now();
        let overview = sample_overview(ProviderUsage::Unauthenticated);
        let cache = Some((fetched, overview.clone()));

        assert_eq!(
            cached_usage_snapshot(&cache, fetched + Duration::from_secs(60)),
            Some(overview)
        );
        assert_eq!(
            cached_usage_snapshot(&cache, fetched + USAGE_CACHE_TTL + Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn cached_usage_snapshot_expires_errors_sooner() {
        let fetched = Instant::now();
        let overview = sample_overview(ProviderUsage::Error {
            message: "rate limited".to_string(),
            plan_label: None,
            account_email: None,
        });
        let cache = Some((fetched, overview.clone()));

        assert_eq!(
            cached_usage_snapshot(&cache, fetched + Duration::from_secs(10)),
            Some(overview)
        );
        assert_eq!(
            cached_usage_snapshot(
                &cache,
                fetched + USAGE_ERROR_CACHE_TTL + Duration::from_secs(1)
            ),
            None
        );
    }
}
