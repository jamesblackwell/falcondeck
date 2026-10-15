//! Shortlist of OpenRouter chat models for voice rewrite.
//!
//! The public catalog is sorted by OpenRouter: intelligence for the frontier
//! group, and recent latency for the fast group. `/models/user` then drops
//! anything the saved key's privacy settings and provider preferences hide.
//! The shortlist is cached on disk so Settings does not refetch on every open.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::spawn_blocking;

use super::AppState;
use super::speech::OPENROUTER_CLIENT;
use crate::error::DaemonError;

const FRONTIER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models?output_modalities=text&sort=intelligence-high-to-low&limit=40";
const FAST_MODELS_URL: &str = "https://openrouter.ai/api/v1/models?output_modalities=text&sort=latency-low-to-high&max_price=1.5&max_output_price=5&min_intelligence_index=32&limit=40";
const USER_MODELS_URL: &str =
    "https://openrouter.ai/api/v1/models/user?output_modalities=text&limit=1000";

const CATALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const USER_CATALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// A fresh file is served as-is. Older files are shown if a refresh fails,
/// until they are too old to trust.
const FRESH_MS: u64 = 6 * 60 * 60 * 1000;
const STALE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

const FRONTIER_LIMIT: usize = 6;
const FAST_LIMIT: usize = 6;
const FAST_MIN_INTELLIGENCE: f64 = 32.0;
/// Prompt and completion caps, in dollars per million tokens. The fast query
/// uses the same ceilings so a slow expensive model cannot fill the group.
const FAST_MAX_PROMPT_PER_MILLION: f64 = 1.5;
const FAST_MAX_COMPLETION_PER_MILLION: f64 = 5.0;

const REWRITE_EFFORTS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewriteModelGroup {
    Fast,
    Frontier,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RewriteModelChoice {
    pub id: String,
    pub name: String,
    pub group: RewriteModelGroup,
    pub intelligence: Option<f64>,
    pub prompt_per_million: f64,
    pub completion_per_million: f64,
    pub reasoning_efforts: Vec<String>,
    pub reasoning_mandatory: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RewriteModelCatalog {
    pub fetched_at_ms: u64,
    pub stale: bool,
    pub models: Vec<RewriteModelChoice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct StoredRewriteCatalog {
    fetched_at_ms: u64,
    models: Vec<RewriteModelChoice>,
}

#[derive(Debug, Clone)]
struct Candidate {
    id: String,
    name: String,
    intelligence: Option<f64>,
    prompt_per_million: f64,
    completion_per_million: f64,
    reasoning_efforts: Vec<String>,
    reasoning_mandatory: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Freshness {
    Fresh,
    Stale,
    Expired,
}

impl AppState {
    pub async fn rewrite_model_catalog(&self) -> Result<RewriteModelCatalog, DaemonError> {
        if let Some(catalog) = self.fresh_memory_catalog() {
            return Ok(catalog);
        }
        let _refresh = self.inner.rewrite_catalog_refresh.lock().await;
        if let Some(catalog) = self.fresh_memory_catalog() {
            return Ok(catalog);
        }
        self.load_disk_catalog_if_empty().await;
        if let Some(catalog) = self.fresh_memory_catalog() {
            return Ok(catalog);
        }
        let fallback = self.usable_memory_catalog();
        match self.fetch_and_store().await {
            Ok(catalog) => Ok(catalog),
            Err(error) => fallback.ok_or(error),
        }
    }

    /// Catalog row for a model. A paste reads the disk cache once and does not
    /// call OpenRouter; a cold cache keeps the model-name heuristic.
    pub(super) async fn cached_rewrite_choice(&self, model_id: &str) -> Option<RewriteModelChoice> {
        self.load_disk_catalog_if_empty().await;
        let stored = self.inner.rewrite_catalog.lock().unwrap().clone()?;
        if freshness(stored.fetched_at_ms, now_ms()) == Freshness::Expired {
            return None;
        }
        stored.models.into_iter().find(|model| model.id == model_id)
    }

    fn fresh_memory_catalog(&self) -> Option<RewriteModelCatalog> {
        self.memory_catalog_with(|freshness| freshness == Freshness::Fresh)
    }

    fn usable_memory_catalog(&self) -> Option<RewriteModelCatalog> {
        self.memory_catalog_with(|freshness| freshness != Freshness::Expired)
    }

    fn memory_catalog_with(
        &self,
        accept: impl Fn(Freshness) -> bool,
    ) -> Option<RewriteModelCatalog> {
        let stored = self.inner.rewrite_catalog.lock().unwrap().clone()?;
        let freshness = freshness(stored.fetched_at_ms, now_ms());
        if !accept(freshness) {
            return None;
        }
        Some(RewriteModelCatalog {
            fetched_at_ms: stored.fetched_at_ms,
            stale: freshness != Freshness::Fresh,
            models: stored.models,
        })
    }

    async fn load_disk_catalog_if_empty(&self) {
        if self.inner.rewrite_catalog.lock().unwrap().is_some()
            || self
                .inner
                .rewrite_catalog_disk_checked
                .load(Ordering::Acquire)
        {
            return;
        }
        let path = catalog_path(&self.inner.state_path);
        let loaded = spawn_blocking(move || read_catalog_file(&path))
            .await
            .ok()
            .flatten();
        let mut guard = self.inner.rewrite_catalog.lock().unwrap();
        // A refresh may have stored a newer list while this file was read.
        if guard.is_some() {
            return;
        }
        self.inner
            .rewrite_catalog_disk_checked
            .store(true, Ordering::Release);
        if let Some(stored) = loaded {
            if freshness(stored.fetched_at_ms, now_ms()) != Freshness::Expired {
                *guard = Some(stored);
            }
        }
    }

    async fn fetch_and_store(&self) -> Result<RewriteModelCatalog, DaemonError> {
        let (frontier, fast, api_key) = tokio::join!(
            fetch_model_page(FRONTIER_MODELS_URL),
            fetch_model_page(FAST_MODELS_URL),
            self.openrouter_key_cached(),
        );
        let models = curate_fetched(frontier, fast, api_key.ok().flatten()).await?;
        let stored = StoredRewriteCatalog {
            fetched_at_ms: now_ms(),
            models: models.clone(),
        };
        *self.inner.rewrite_catalog.lock().unwrap() = Some(stored.clone());
        let path = catalog_path(&self.inner.state_path);
        let to_write = stored.clone();
        match spawn_blocking(move || write_catalog_file(&path, &to_write)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, "could not store the OpenRouter rewrite model list");
            }
            Err(error) => {
                tracing::warn!(%error, "could not store the OpenRouter rewrite model list");
            }
        }
        Ok(RewriteModelCatalog {
            fetched_at_ms: stored.fetched_at_ms,
            stale: false,
            models,
        })
    }
}

fn catalog_path(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("rewrite-models.json")
}

async fn curate_fetched(
    frontier: Result<Vec<Candidate>, DaemonError>,
    fast: Result<Vec<Candidate>, DaemonError>,
    api_key: Option<String>,
) -> Result<Vec<RewriteModelChoice>, DaemonError> {
    let (frontier, fast) = match (frontier, fast) {
        (Ok(frontier), Ok(fast)) => (frontier, fast),
        (Ok(frontier), Err(error)) => {
            tracing::warn!(%error, "OpenRouter fast model list failed");
            (frontier, Vec::new())
        }
        (Err(error), Ok(fast)) => {
            tracing::warn!(%error, "OpenRouter frontier model list failed");
            (Vec::new(), fast)
        }
        (Err(error), Err(_)) => return Err(error),
    };
    let mut models = curate_rewrite_models(&frontier, &fast);
    if models.is_empty() {
        return Err(DaemonError::Process(
            "OpenRouter returned no rewrite models.".to_string(),
        ));
    }
    if let Some(api_key) = api_key.as_deref() {
        if let Some(allowed) = fetch_user_model_ids(api_key).await {
            models = apply_user_filter(models, &allowed);
        }
    }
    Ok(models)
}

async fn fetch_model_page(url: &str) -> Result<Vec<Candidate>, DaemonError> {
    let response = OPENROUTER_CLIENT
        .get(url)
        .timeout(CATALOG_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            DaemonError::Process(format!("failed to load OpenRouter models: {error}"))
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
    Ok(candidates_from_value(&body))
}

/// Models the key is allowed to call. `None` means "do not filter": the
/// account list failed, was incomplete, or was empty.
async fn fetch_user_model_ids(api_key: &str) -> Option<HashSet<String>> {
    let response = OPENROUTER_CLIENT
        .get(USER_MODELS_URL)
        .bearer_auth(api_key)
        .timeout(USER_CATALOG_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(%error, "OpenRouter account model list failed");
            error
        })
        .ok()?;
    if !response.status().is_success() {
        tracing::warn!(
            status = response.status().as_u16(),
            "OpenRouter account model list was rejected"
        );
        return None;
    }
    let body = response.json::<Value>().await.ok()?;
    user_allowlist(&body)
}

/// Ids the account can call. Missing or incomplete pages return `None` so the
/// public shortlist stays intact.
fn user_allowlist(body: &Value) -> Option<HashSet<String>> {
    let data = body.get("data")?.as_array()?;
    let total = body.get("total_count").and_then(Value::as_u64)?;
    if data.is_empty() || total > data.len() as u64 {
        return None;
    }
    Some(
        data.iter()
            .filter_map(|model| model.get("id")?.as_str().map(str::to_string))
            .collect(),
    )
}

fn apply_user_filter(
    models: Vec<RewriteModelChoice>,
    allowed: &HashSet<String>,
) -> Vec<RewriteModelChoice> {
    let filtered: Vec<_> = models
        .iter()
        .filter(|model| allowed.contains(&model.id))
        .cloned()
        .collect();
    if filtered.is_empty() {
        tracing::warn!(
            "OpenRouter account filter matched no shortlisted model; keeping the public list"
        );
        models
    } else {
        filtered
    }
}

fn curate_rewrite_models(frontier: &[Candidate], fast: &[Candidate]) -> Vec<RewriteModelChoice> {
    let frontier_picks = pick(
        frontier,
        FRONTIER_LIMIT,
        RewriteModelGroup::Frontier,
        &[],
        &HashSet::new(),
        true,
    );
    let mut exclude: Vec<String> = frontier_picks
        .iter()
        .map(|model| model.id.clone())
        .collect();
    let mut fast_picks = pick(
        fast,
        FAST_LIMIT,
        RewriteModelGroup::Fast,
        &exclude,
        &HashSet::new(),
        false,
    );
    if fast_picks.len() < FAST_LIMIT {
        let taken_authors = fast_picks
            .iter()
            .map(|model| author_of(&model.id).to_string())
            .collect();
        exclude.extend(fast_picks.iter().map(|model| model.id.clone()));
        fast_picks.extend(pick(
            frontier,
            FAST_LIMIT - fast_picks.len(),
            RewriteModelGroup::Fast,
            &exclude,
            &taken_authors,
            false,
        ));
    }
    fast_picks.extend(frontier_picks);
    fast_picks
}

fn pick(
    rows: &[Candidate],
    limit: usize,
    group: RewriteModelGroup,
    exclude: &[String],
    blocked_authors: &HashSet<String>,
    ignore_price_caps: bool,
) -> Vec<RewriteModelChoice> {
    let mut chosen: Vec<&Candidate> = rows
        .iter()
        .filter(|row| row_fits(row, exclude, ignore_price_caps))
        .collect();
    chosen.sort_by(|left, right| {
        right
            .intelligence
            .unwrap_or(f64::NEG_INFINITY)
            .total_cmp(&left.intelligence.unwrap_or(f64::NEG_INFINITY))
    });
    let mut seen_authors = HashSet::new();
    let mut picked = Vec::new();
    for row in chosen {
        let author = author_of(&row.id);
        if blocked_authors.contains(author) || !seen_authors.insert(author.to_string()) {
            continue;
        }
        picked.push(RewriteModelChoice {
            id: row.id.clone(),
            name: row.name.clone(),
            group,
            intelligence: row.intelligence,
            prompt_per_million: row.prompt_per_million,
            completion_per_million: row.completion_per_million,
            reasoning_efforts: row.reasoning_efforts.clone(),
            reasoning_mandatory: row.reasoning_mandatory,
        });
        if picked.len() == limit {
            break;
        }
    }
    picked
}

fn row_fits(row: &Candidate, exclude: &[String], ignore_price_caps: bool) -> bool {
    if !eligible_id(&row.id)
        || exclude.iter().any(|id| id == &row.id)
        || row.prompt_per_million <= 0.0
    {
        return false;
    }
    let Some(score) = row.intelligence else {
        return false;
    };
    ignore_price_caps
        || (score >= FAST_MIN_INTELLIGENCE
            && row.prompt_per_million <= FAST_MAX_PROMPT_PER_MILLION
            && row.completion_per_million <= FAST_MAX_COMPLETION_PER_MILLION)
}

fn eligible_id(id: &str) -> bool {
    if id.is_empty() || id.starts_with('~') || id.contains(':') {
        return false;
    }
    let lower = id.to_ascii_lowercase();
    ![
        "embed",
        "moderation",
        "safeguard",
        "whisper",
        "transcribe",
        "rerank",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn author_of(id: &str) -> &str {
    id.split('/').next().unwrap_or(id)
}

fn candidates_from_value(body: &Value) -> Vec<Candidate> {
    body.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(candidate_from_model)
        .collect()
}

fn candidate_from_model(model: &Value) -> Option<Candidate> {
    let id = model.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let owned_name = model
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| id.clone());
    let raw_name = owned_name.as_str();
    let (reasoning_efforts, reasoning_mandatory) = reasoning_from(model.get("reasoning"));
    Some(Candidate {
        id,
        name: short_model_name(raw_name),
        intelligence: model
            .pointer("/benchmarks/artificial_analysis/intelligence_index")
            .and_then(Value::as_f64)
            .filter(|score| score.is_finite()),
        prompt_per_million: per_million(model.pointer("/pricing/prompt")),
        completion_per_million: per_million(model.pointer("/pricing/completion")),
        reasoning_efforts,
        reasoning_mandatory,
    })
}

fn short_model_name(name: &str) -> String {
    let shortened = name
        .split_once(':')
        .map(|(_, rest)| rest.trim())
        .filter(|rest| !rest.is_empty())
        .unwrap_or(name.trim());
    if shortened.is_empty() {
        name.trim().to_string()
    } else {
        shortened.to_string()
    }
}

fn per_million(value: Option<&Value>) -> f64 {
    let raw = match value {
        Some(Value::String(text)) => text.parse::<f64>().ok(),
        Some(Value::Number(number)) => number.as_f64(),
        _ => None,
    };
    let dollars = raw.unwrap_or(0.0) * 1_000_000.0;
    if dollars.is_finite() && dollars > 0.0 {
        dollars
    } else {
        0.0
    }
}

fn reasoning_from(reasoning: Option<&Value>) -> (Vec<String>, bool) {
    let Some(reasoning) = reasoning.filter(|value| !value.is_null()) else {
        return (Vec::new(), false);
    };
    let mandatory = reasoning
        .get("mandatory")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut efforts = match reasoning.get("supported_efforts") {
        Some(Value::Array(items)) => ordered_efforts(items.iter().filter_map(Value::as_str)),
        Some(Value::Null) | None => ordered_efforts(REWRITE_EFFORTS.iter().copied()),
        _ => Vec::new(),
    };
    // A mandatory model rejects "none". Drop it so the picker cannot offer Off.
    if mandatory {
        efforts.retain(|effort| effort != "none");
    }
    (efforts, mandatory)
}

fn ordered_efforts<'a>(efforts: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let present: HashSet<&str> = efforts.into_iter().collect();
    REWRITE_EFFORTS
        .iter()
        .copied()
        .filter(|effort| present.contains(effort))
        .map(str::to_string)
        .collect()
}

/// Effort sent as `reasoning.effort`. Automatic sends the cheapest effort the
/// model allows. `none` wins when the model can turn reasoning off, so a paste
/// does not wait on a long chain of thought.
pub(super) fn resolve_rewrite_reasoning(
    model: &str,
    requested: Option<&str>,
    known: Option<&RewriteModelChoice>,
) -> Option<String> {
    let requested = requested
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"));
    if let Some(effort) = requested.and_then(canonical_effort) {
        return match known {
            // An empty list means the model does not take a reasoning parameter.
            Some(choice) if choice.reasoning_efforts.is_empty() && !choice.reasoning_mandatory => {
                None
            }
            // Listed or not, "none" on a mandatory model is rejected by the provider.
            Some(choice) if effort == "none" && choice.reasoning_mandatory => {
                automatic_effort(model, Some(choice))
            }
            Some(choice)
                if choice
                    .reasoning_efforts
                    .iter()
                    .any(|supported| supported == effort) =>
            {
                Some(effort.to_string())
            }
            Some(choice) if effort == "none" && !choice.reasoning_mandatory => {
                Some("none".to_string())
            }
            Some(choice) => automatic_effort(model, Some(choice)),
            None => Some(effort.to_string()),
        };
    }
    automatic_effort(model, known)
}

fn automatic_effort(model: &str, known: Option<&RewriteModelChoice>) -> Option<String> {
    if let Some(choice) = known {
        if choice.reasoning_mandatory {
            // A mandatory model with no advertised effort still needs one, or
            // the provider rejects the paste.
            return lowest_effort(&choice.reasoning_efforts).or_else(|| Some("low".to_string()));
        }
        if choice
            .reasoning_efforts
            .iter()
            .any(|effort| effort == "none")
        {
            return Some("none".to_string());
        }
        return lowest_effort(&choice.reasoning_efforts);
    }
    if model.contains("gpt-oss") {
        Some("low".to_string())
    } else if model.contains("gpt-5") {
        Some("none".to_string())
    } else {
        None
    }
}

fn lowest_effort(efforts: &[String]) -> Option<String> {
    REWRITE_EFFORTS
        .iter()
        .copied()
        .find(|effort| *effort != "none" && efforts.iter().any(|supported| supported == effort))
        .map(str::to_string)
}

fn canonical_effort(value: &str) -> Option<&'static str> {
    REWRITE_EFFORTS
        .iter()
        .copied()
        .find(|effort| effort.eq_ignore_ascii_case(value))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn freshness(fetched_at_ms: u64, now_ms: u64) -> Freshness {
    let age = now_ms.saturating_sub(fetched_at_ms);
    if age <= FRESH_MS {
        Freshness::Fresh
    } else if age <= STALE_MS {
        Freshness::Stale
    } else {
        Freshness::Expired
    }
}

fn read_catalog_file(path: &Path) -> Option<StoredRewriteCatalog> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_catalog_file(path: &Path, catalog: &StoredRewriteCatalog) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec(catalog).map_err(std::io::Error::other)?;
    fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn page(models: Vec<Value>) -> Vec<Candidate> {
        candidates_from_value(&json!({ "data": models }))
    }

    fn model(
        id: &str,
        name: &str,
        intelligence: Option<f64>,
        prompt_per_token: &str,
        completion_per_token: &str,
        efforts: &[&str],
        mandatory: bool,
    ) -> Value {
        json!({
            "id": id,
            "name": name,
            "pricing": { "prompt": prompt_per_token, "completion": completion_per_token },
            "benchmarks": { "artificial_analysis": { "intelligence_index": intelligence } },
            "reasoning": { "mandatory": mandatory, "supported_efforts": efforts }
        })
    }

    #[test]
    fn curate_rewrite_models_mixes_frontier_leaders_with_fast_models() {
        let frontier = page(vec![
            model(
                "anthropic/claude-opus-5.5:batch",
                "Anthropic: Claude Opus 5.5 (batch)",
                Some(57.6),
                "0.000002",
                "0.00001",
                &["high", "low"],
                true,
            ),
            model(
                "anthropic/claude-sonnet-5.5",
                "Anthropic: Claude Sonnet 5.5",
                Some(56.0),
                "0.000002",
                "0.00001",
                &["high", "low"],
                true,
            ),
            model(
                "anthropic/claude-opus-5.5",
                "Anthropic: Claude Opus 5.5",
                Some(57.6),
                "0.000004",
                "0.00002",
                &["max", "high", "low"],
                true,
            ),
            model(
                "openai/gpt-6-astra",
                "OpenAI: GPT-6 Astra",
                Some(52.7),
                "0.00001",
                "0.00005",
                &["high", "medium", "low"],
                true,
            ),
            model(
                "meta/muse-spark-1.3",
                "Meta: Muse Spark 1.3",
                Some(48.1),
                "0.00000125",
                "0.00000425",
                &["none", "low"],
                false,
            ),
            model(
                "x-ai/grok-4.7",
                "xAI: Grok 4.7",
                Some(46.4),
                "0.000002",
                "0.000006",
                &["high"],
                true,
            ),
            model(
                "xiaomi/mimo-v2.6-pro",
                "Xiaomi: MiMo V2.6 Pro",
                Some(46.3),
                "0.00000043",
                "0.00000087",
                &["low"],
                false,
            ),
            model(
                "qwen/qwen3.8-max",
                "Qwen: Qwen3.8 Max",
                Some(45.4),
                "0.000002",
                "0.000006",
                &["high", "low"],
                false,
            ),
            model(
                "~openai/gpt-latest",
                "OpenAI: GPT Latest",
                Some(60.0),
                "0.00001",
                "0.00005",
                &["low"],
                false,
            ),
            model(
                "openai/gpt-oss-safeguard-20b",
                "OpenAI: GPT-OSS Safeguard",
                Some(40.0),
                "0.0000001",
                "0.0000003",
                &["low"],
                true,
            ),
        ]);
        let fast = page(vec![
            model(
                "inclusionai/ling-3.1-flash",
                "InclusionAI: Ling Flash",
                Some(41.1),
                "0",
                "0",
                &["none"],
                false,
            ),
            model(
                "openai/gpt-oss-120b",
                "OpenAI: GPT-OSS 120B",
                Some(11.6),
                "0.00000015",
                "0.0000006",
                &["high", "medium", "low"],
                true,
            ),
            model(
                "anthropic/claude-haiku-5.5",
                "Anthropic: Claude Haiku 5.5",
                Some(43.4),
                "0.0000001",
                "0.0000005",
                &["high", "low", "none"],
                false,
            ),
            model(
                "z-ai/glm-5.3-flash",
                "Z.ai: GLM 5.3 Flash",
                Some(41.8),
                "0.00000003",
                "0.0000009",
                &["high", "low"],
                false,
            ),
            model(
                "google/gemini-3.8-flash",
                "Google: Gemini 3.8 Flash",
                Some(40.9),
                "0.00000075",
                "0.00000375",
                &["high", "medium", "low"],
                true,
            ),
            model(
                "google/gemini-3.7-flash",
                "Google: Gemini 3.7 Flash",
                Some(39.6),
                "0.00000075",
                "0.00000375",
                &["low"],
                true,
            ),
            model(
                "deepseek/deepseek-v4.1-flash",
                "DeepSeek: DeepSeek V4.1 Flash",
                Some(39.5),
                "0.00000004",
                "0.00000089",
                &["low"],
                false,
            ),
            model(
                "openai/gpt-6-luna",
                "OpenAI: GPT-6 Luna",
                Some(38.1),
                "0.0000001",
                "0.0000005",
                &["max", "high", "medium", "low", "none"],
                false,
            ),
            model(
                "xiaomi/mimo-v2.6-flash",
                "Xiaomi: MiMo V2.6 Flash",
                Some(37.9),
                "0.00000014",
                "0.00000028",
                &["none"],
                false,
            ),
        ]);

        let curated = curate_rewrite_models(&frontier, &fast);
        let listed: Vec<_> = curated
            .iter()
            .map(|model| (model.group, model.id.as_str()))
            .collect();
        assert_eq!(
            listed,
            vec![
                (RewriteModelGroup::Fast, "anthropic/claude-haiku-5.5"),
                (RewriteModelGroup::Fast, "z-ai/glm-5.3-flash"),
                (RewriteModelGroup::Fast, "google/gemini-3.8-flash"),
                (RewriteModelGroup::Fast, "deepseek/deepseek-v4.1-flash"),
                (RewriteModelGroup::Fast, "openai/gpt-6-luna"),
                (RewriteModelGroup::Fast, "xiaomi/mimo-v2.6-flash"),
                (RewriteModelGroup::Frontier, "anthropic/claude-opus-5.5"),
                (RewriteModelGroup::Frontier, "openai/gpt-6-astra"),
                (RewriteModelGroup::Frontier, "meta/muse-spark-1.3"),
                (RewriteModelGroup::Frontier, "x-ai/grok-4.7"),
                (RewriteModelGroup::Frontier, "xiaomi/mimo-v2.6-pro"),
                (RewriteModelGroup::Frontier, "qwen/qwen3.8-max"),
            ]
        );
        let opus = curated
            .iter()
            .find(|model| model.id == "anthropic/claude-opus-5.5")
            .unwrap();
        assert_eq!(opus.name, "Claude Opus 5.5");
        assert_eq!(
            opus.reasoning_efforts,
            vec!["low".to_string(), "high".to_string(), "max".to_string()]
        );
        assert!(opus.reasoning_mandatory);
        let luna = curated
            .iter()
            .find(|model| model.id == "openai/gpt-6-luna")
            .unwrap();
        assert_eq!(
            luna.reasoning_efforts,
            vec![
                "none".to_string(),
                "low".to_string(),
                "medium".to_string(),
                "high".to_string(),
                "max".to_string()
            ]
        );
    }

    #[test]
    fn fast_group_fills_from_the_frontier_page_when_the_latency_list_is_empty() {
        // Six more expensive leaders take the frontier seats. Luna is cheap
        // enough for the fast group and is not one of those leaders.
        let frontier = page(vec![
            model(
                "anthropic/claude-opus-5.5",
                "Anthropic: Claude Opus 5.5",
                Some(57.6),
                "0.000004",
                "0.00002",
                &["low"],
                true,
            ),
            model(
                "openai/gpt-6-astra",
                "OpenAI: GPT-6 Astra",
                Some(52.7),
                "0.00001",
                "0.00005",
                &["low"],
                true,
            ),
            model(
                "meta/muse-spark-1.3",
                "Meta: Muse Spark 1.3",
                Some(48.1),
                "0.00001",
                "0.00002",
                &["low"],
                false,
            ),
            model(
                "x-ai/grok-4.7",
                "xAI: Grok 4.7",
                Some(46.4),
                "0.000002",
                "0.000006",
                &["high"],
                true,
            ),
            model(
                "qwen/qwen3.8-max",
                "Qwen: Qwen3.8 Max",
                Some(45.4),
                "0.000002",
                "0.000006",
                &["low"],
                false,
            ),
            model(
                "z-ai/glm-5.3",
                "Z.ai: GLM 5.3",
                Some(44.8),
                "0.000008",
                "0.00002",
                &["low"],
                true,
            ),
            model(
                "openai/gpt-6-luna",
                "OpenAI: GPT-6 Luna",
                Some(38.1),
                "0.0000001",
                "0.0000005",
                &["none", "low"],
                false,
            ),
        ]);
        let curated = curate_rewrite_models(&frontier, &[]);
        assert_eq!(curated[0].id, "openai/gpt-6-luna");
        assert_eq!(curated[0].group, RewriteModelGroup::Fast);
        assert_eq!(curated[1].group, RewriteModelGroup::Frontier);
        assert!(
            curated
                .iter()
                .any(|model| model.id == "anthropic/claude-opus-5.5")
        );
    }

    #[test]
    fn fast_fill_keeps_one_model_per_author() {
        let frontier = page(vec![
            model(
                "anthropic/claude-opus-5.5",
                "Anthropic: Claude Opus 5.5",
                Some(57.6),
                "0.000004",
                "0.00002",
                &["low"],
                true,
            ),
            model(
                "openai/gpt-6-astra",
                "OpenAI: GPT-6 Astra",
                Some(52.7),
                "0.00001",
                "0.00005",
                &["low"],
                true,
            ),
            model(
                "google/gemini-3.8-flash",
                "Google: Gemini 3.8 Flash",
                Some(40.0),
                "0.00000075",
                "0.00000375",
                &["low"],
                false,
            ),
            model(
                "anthropic/claude-haiku-5.5",
                "Anthropic: Claude Haiku 5.5",
                Some(35.0),
                "0.0000001",
                "0.0000005",
                &["low"],
                false,
            ),
            model(
                "openai/gpt-6-mini",
                "OpenAI: GPT-6 Mini",
                Some(33.0),
                "0.0000001",
                "0.0000005",
                &["low"],
                false,
            ),
        ]);
        let fast = page(vec![model(
            "openai/gpt-6-luna",
            "OpenAI: GPT-6 Luna",
            Some(38.1),
            "0.0000001",
            "0.0000005",
            &["none", "low"],
            false,
        )]);
        let curated = curate_rewrite_models(&frontier, &fast);
        let fast_ids: Vec<_> = curated
            .iter()
            .filter(|model| model.group == RewriteModelGroup::Fast)
            .map(|model| model.id.as_str())
            .collect();
        assert_eq!(
            fast_ids,
            vec!["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"]
        );
        assert!(!curated.iter().any(|model| model.id == "openai/gpt-6-mini"));
    }

    #[test]
    fn resolve_rewrite_reasoning_keeps_rewrites_fast_unless_asked() {
        assert_eq!(
            resolve_rewrite_reasoning("openai/gpt-oss-120b", None, None).as_deref(),
            Some("low")
        );
        assert_eq!(
            resolve_rewrite_reasoning("openai/gpt-5.6-luna", None, None).as_deref(),
            Some("none")
        );
        assert_eq!(
            resolve_rewrite_reasoning("google/gemma-4-31b-it", None, None),
            None
        );

        let luna = RewriteModelChoice {
            id: "openai/gpt-6-luna".to_string(),
            name: "GPT-6 Luna".to_string(),
            group: RewriteModelGroup::Fast,
            intelligence: Some(38.1),
            prompt_per_million: 0.1,
            completion_per_million: 0.5,
            reasoning_efforts: vec!["none".to_string(), "low".to_string(), "high".to_string()],
            reasoning_mandatory: false,
        };
        assert_eq!(
            resolve_rewrite_reasoning(&luna.id, None, Some(&luna)).as_deref(),
            Some("none")
        );
        assert_eq!(
            resolve_rewrite_reasoning(&luna.id, Some("high"), Some(&luna)).as_deref(),
            Some("high")
        );
        assert_eq!(
            resolve_rewrite_reasoning(&luna.id, Some("auto"), Some(&luna)).as_deref(),
            Some("none")
        );

        let opus = RewriteModelChoice {
            id: "anthropic/claude-opus-5.5".to_string(),
            name: "Claude Opus 5.5".to_string(),
            group: RewriteModelGroup::Frontier,
            intelligence: Some(57.6),
            prompt_per_million: 4.0,
            completion_per_million: 20.0,
            reasoning_efforts: vec!["low".to_string(), "medium".to_string(), "high".to_string()],
            reasoning_mandatory: true,
        };
        assert_eq!(
            resolve_rewrite_reasoning(&opus.id, None, Some(&opus)).as_deref(),
            Some("low")
        );
        assert_eq!(
            resolve_rewrite_reasoning(&opus.id, Some("none"), Some(&opus)).as_deref(),
            Some("low")
        );
        assert_eq!(
            resolve_rewrite_reasoning(&opus.id, Some("HIGH"), Some(&opus)).as_deref(),
            Some("high")
        );
        let opus_listing_none = RewriteModelChoice {
            reasoning_efforts: vec!["none".to_string(), "low".to_string(), "high".to_string()],
            ..opus.clone()
        };
        assert_eq!(
            resolve_rewrite_reasoning(&opus.id, Some("none"), Some(&opus_listing_none)).as_deref(),
            Some("low")
        );

        let gemma = RewriteModelChoice {
            reasoning_efforts: Vec::new(),
            reasoning_mandatory: false,
            ..luna.clone()
        };
        assert_eq!(
            resolve_rewrite_reasoning("google/gemma-4-31b-it", Some("low"), Some(&gemma)),
            None
        );

        let listed = RewriteModelChoice {
            reasoning_efforts: vec!["low".to_string(), "high".to_string()],
            reasoning_mandatory: false,
            ..luna.clone()
        };
        assert_eq!(
            resolve_rewrite_reasoning(&listed.id, None, Some(&listed)).as_deref(),
            Some("low")
        );
        let mandatory_blank = RewriteModelChoice {
            reasoning_efforts: Vec::new(),
            reasoning_mandatory: true,
            ..opus
        };
        assert_eq!(
            resolve_rewrite_reasoning(&mandatory_blank.id, None, Some(&mandatory_blank)).as_deref(),
            Some("low")
        );
    }

    #[test]
    fn user_allowlist_ignores_an_incomplete_account_page() {
        assert!(user_allowlist(&json!({ "data": [{ "id": "openai/gpt-6-luna" }] })).is_none());
        assert!(
            user_allowlist(&json!({
                "total_count": 2,
                "data": [{ "id": "openai/gpt-6-luna" }]
            }))
            .is_none()
        );
        let allowed = user_allowlist(&json!({
            "total_count": 1,
            "data": [{ "id": "openai/gpt-6-luna" }]
        }))
        .unwrap();
        assert!(allowed.contains("openai/gpt-6-luna"));
    }

    #[test]
    fn user_filter_drops_models_the_account_cannot_see() {
        let models = vec![
            RewriteModelChoice {
                id: "openai/gpt-6-luna".to_string(),
                name: "GPT-6 Luna".to_string(),
                group: RewriteModelGroup::Fast,
                intelligence: Some(38.1),
                prompt_per_million: 0.1,
                completion_per_million: 0.5,
                reasoning_efforts: Vec::new(),
                reasoning_mandatory: false,
            },
            RewriteModelChoice {
                id: "anthropic/claude-opus-5.5".to_string(),
                name: "Claude Opus 5.5".to_string(),
                group: RewriteModelGroup::Frontier,
                intelligence: Some(57.6),
                prompt_per_million: 4.0,
                completion_per_million: 20.0,
                reasoning_efforts: Vec::new(),
                reasoning_mandatory: true,
            },
        ];
        let allowed = HashSet::from(["openai/gpt-6-luna".to_string()]);
        let filtered = apply_user_filter(models.clone(), &allowed);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "openai/gpt-6-luna");
        let missed = apply_user_filter(models.clone(), &HashSet::new());
        assert_eq!(missed.len(), 2);
    }

    #[test]
    fn freshness_keeps_a_recent_catalog_and_expires_a_week_old_one() {
        let now = 1_000_000_000_u64;
        assert_eq!(freshness(now - 60_000, now), Freshness::Fresh);
        assert_eq!(freshness(now - FRESH_MS - 1, now), Freshness::Stale);
        assert_eq!(freshness(now - STALE_MS - 1, now), Freshness::Expired);
        assert_eq!(freshness(now + 5_000, now), Freshness::Fresh);
    }

    #[test]
    fn mandatory_models_drop_the_off_effort() {
        let rows = page(vec![model(
            "anthropic/claude-opus-5.5",
            "Anthropic: Claude Opus 5.5",
            Some(57.6),
            "0.000004",
            "0.00002",
            &["none", "high", "low"],
            true,
        )]);
        assert_eq!(
            rows[0].reasoning_efforts,
            vec!["low".to_string(), "high".to_string()]
        );
    }

    #[test]
    fn catalog_file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rewrite-models.json");
        let stored = StoredRewriteCatalog {
            fetched_at_ms: 42,
            models: vec![RewriteModelChoice {
                id: "openai/gpt-6-luna".to_string(),
                name: "GPT-6 Luna".to_string(),
                group: RewriteModelGroup::Fast,
                intelligence: Some(38.1),
                prompt_per_million: 0.1,
                completion_per_million: 0.5,
                reasoning_efforts: vec!["none".to_string(), "low".to_string()],
                reasoning_mandatory: false,
            }],
        };
        write_catalog_file(&path, &stored).unwrap();
        let loaded = read_catalog_file(&path).unwrap();
        assert_eq!(loaded, stored);
    }
}
