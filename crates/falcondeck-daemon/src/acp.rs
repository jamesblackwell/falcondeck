//! Generic Agent Client Protocol (ACP) adapter.
//!
//! ACP is JSON-RPC 2.0 over stdio, spoken by Grok Build (`grok agent stdio`),
//! OpenCode (`opencode acp`), Pi, Cursor, and others. FalconDeck acts as the
//! ACP *client*: it spawns the configured agent command once per workspace,
//! negotiates capabilities via `initialize`, opens one ACP session per thread,
//! and streams `session/update` notifications into the daemon's unified
//! conversation model.
//!
//! Providers are configured by data, not code: a `providers.json` next to the
//! daemon state file declares `{ id: { command: [...], label: "..." } }` and
//! each entry becomes a selectable provider with no Rust changes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::time::{Duration, Instant, timeout};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use falcondeck_core::{
    AgentProvider, ApprovalDecision, CollaborationModeSummary, ImageInput, InteractiveQuestion,
    InteractiveQuestionOption, ModelSummary, PlanApprovalOutcome, PlanStep, ReasoningEffortSummary,
    ThreadPlan,
};

use crate::acp_protocol::AcpSessionUpdateKind;
use crate::agent_binary::{
    desktop_login_shell_environment, preferred_command_path_with_environment, resolve_agent_binary,
    strip_terminal_advertising_env,
};
use crate::app::conversation_helpers::synthesize_tool_title;
use crate::error::DaemonError;

/// Largest raw image file embedded inline for an ACP prompt, mirroring the
/// Claude path's per-image cap.
const MAX_ACP_IMAGE_BYTES: u64 = 3_500_000;

const ACP_PROTOCOL_VERSION: u64 = 1;
const ACP_SETUP_TIMEOUT: Duration = Duration::from_secs(20);
/// Session creation can legitimately initialize plugins, MCP servers, and a
/// large model catalog. Give the harness room to do that, while still putting
/// a finite bound on the foreground turn-start path.
const ACP_SESSION_START_TIMEOUT: Duration = Duration::from_secs(90);

/// Total encoded-image budget per turn, mirroring the Claude path: without it
/// many individually-legal images could produce a single stdin line in the
/// hundreds of megabytes. 15 MB decoded expands to 20 MB encoded.
pub const MAX_ACP_TOTAL_ENCODED_IMAGE_BYTES: usize = 20_000_000;

/// Whether FalconDeck should treat an ACP provider as image-capable.
///
/// Prefer the agent's advertised `promptCapabilities.image` flag. Grok Build
/// currently advertises `image: false` over ACP while still accepting image
/// content blocks and performing vision (verified against grok 1.0.0). Tiny
/// images may still be dropped at runtime with an `image_dropped` notice.
pub fn acp_supports_images(provider: &str, advertised: bool) -> bool {
    advertised || provider.eq_ignore_ascii_case("grok")
}

/// Grok session permission modes. The adapter does not advertise these on
/// `session/new`; FalconDeck maps them onto `_meta.yoloMode` / `_meta.autoMode`.
pub fn grok_placeholder_permission_modes() -> Vec<String> {
    vec![
        "default".to_string(),
        "auto".to_string(),
        "always-approve".to_string(),
    ]
}

/// Capabilities a new-thread Grok composer can use before `grok agent stdio`
/// has finished starting. Live handshake still replaces this entry.
pub fn grok_placeholder_capabilities() -> falcondeck_core::AgentCapabilitySummary {
    falcondeck_core::AgentCapabilitySummary {
        supports_images: true,
        permission_modes: grok_placeholder_permission_modes(),
        ..falcondeck_core::AgentCapabilitySummary::acp_minimal()
    }
}

/// Cursor ACP does not advertise a permission catalog. FalconDeck still
/// enforces these: `always-approve` auto-answers `session/request_permission`
/// and is the composer default; `default` surfaces those requests instead.
/// Agent/plan/ask stay session modes.
pub fn cursor_placeholder_permission_modes() -> Vec<String> {
    vec!["always-approve".to_string(), "default".to_string()]
}

/// Capabilities a new-thread Cursor composer can use before `cursor-agent acp`
/// has finished starting. Live handshake still replaces models and modes.
pub fn cursor_placeholder_capabilities() -> falcondeck_core::AgentCapabilitySummary {
    falcondeck_core::AgentCapabilitySummary {
        supports_images: true,
        permission_modes: cursor_placeholder_permission_modes(),
        ..falcondeck_core::AgentCapabilitySummary::acp_minimal()
    }
}

/// Cursor's advertised ACP session modes. Seeded so the Mode picker is not
/// empty while the discovery session is still starting.
pub fn cursor_placeholder_collaboration_modes() -> Vec<CollaborationModeSummary> {
    [("agent", "Agent"), ("plan", "Plan"), ("ask", "Ask")]
        .into_iter()
        .map(|(id, label)| CollaborationModeSummary {
            id: id.to_string(),
            label: label.to_string(),
            mode: Some(id.to_string()),
            model_id: None,
            reasoning_effort: None,
            is_native: true,
        })
        .collect()
}

/// Pre-handshake permission list for adapters that do not publish one on
/// `session/new`. Empty means the composer hides the picker.
pub fn placeholder_permission_modes_for(provider: &str) -> Vec<String> {
    if provider.eq_ignore_ascii_case("grok") {
        grok_placeholder_permission_modes()
    } else if provider.eq_ignore_ascii_case("cursor") {
        cursor_placeholder_permission_modes()
    } else {
        Vec::new()
    }
}

/// Built-in Grok catalog so the composer is not empty while ACP hydrates.
/// `initialize` / `session/new` replace this with the live list when they
/// answer; custom models from `~/.grok/config.toml` appear at that point.
pub fn grok_placeholder_models() -> Vec<ModelSummary> {
    fn effort(id: &str, description: &str) -> ReasoningEffortSummary {
        ReasoningEffortSummary {
            reasoning_effort: id.to_string(),
            description: description.to_string(),
        }
    }
    fn model(
        id: &str,
        label: &str,
        is_default: bool,
        default_effort: &str,
        efforts: Vec<ReasoningEffortSummary>,
    ) -> ModelSummary {
        ModelSummary {
            id: id.to_string(),
            label: label.to_string(),
            is_default,
            default_reasoning_effort: Some(default_effort.to_string()),
            supported_reasoning_efforts: efforts,
            service_tiers: Vec::new(),
            default_service_tier: None,
        }
    }
    let high_medium_low = || {
        vec![
            effort(
                "high",
                "Higher implementation quality with extensive reasoning",
            ),
            effort(
                "medium",
                "Balanced effort with standard implementation and testing",
            ),
            effort("low", "Quick, fast implementations"),
        ]
    };
    let mut grok_46_efforts = vec![effort("xhigh", "Highest effort and reasoning level")];
    grok_46_efforts.extend(high_medium_low());
    vec![
        model("grok-4.6", "Grok 4.6", true, "high", grok_46_efforts),
        model("grok-4.5", "Grok 4.5", false, "high", high_medium_low()),
    ]
}

/// Whether a provider is known to have builds with a vendor interjection
/// extension. Actual support is probed because Grok 1.0.0 builds exist both
/// with and without `x.ai/interject`. Providers without the extension are
/// still steerable via cancel-and-re-prompt.
fn acp_may_support_interject(provider: &str) -> bool {
    provider.eq_ignore_ascii_case("grok")
}

fn is_grok_plan_approval_method(method: &str) -> bool {
    matches!(method, "_x.ai/exit_plan_mode" | "x.ai/exit_plan_mode")
}

/// ACP reverse-RPC methods that FalconDeck presents as plan review banners.
pub fn is_acp_plan_approval_method(method: &str) -> bool {
    is_grok_plan_approval_method(method) || method == "cursor/create_plan"
}

/// Auth methods FalconDeck can complete without opening a browser.
/// Cursor advertises `cursor_login`, which reuses credentials from `agent login`.
pub(crate) fn silent_acp_auth_method(init: &Value) -> Option<String> {
    init.get("authMethods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|method| method.get("id").and_then(Value::as_str))
        .find(|id| matches!(*id, "cursor_login"))
        .map(ToOwned::to_owned)
}

fn is_cursor_notification_method(method: &str) -> bool {
    matches!(
        method,
        "cursor/update_todos" | "cursor/task" | "cursor/generate_image"
    )
}

#[derive(Clone, Copy)]
enum PlanApprovalKind {
    Grok,
    Cursor,
}

fn plan_approval_rpc_result(
    kind: PlanApprovalKind,
    outcome: PlanApprovalOutcome,
    feedback: Option<&str>,
) -> Value {
    let feedback = feedback
        .map(str::trim)
        .filter(|feedback| !feedback.is_empty());
    match kind {
        PlanApprovalKind::Grok => match outcome {
            PlanApprovalOutcome::Approved => json!({ "outcome": "approved" }),
            PlanApprovalOutcome::Cancelled => match feedback {
                Some(feedback) => json!({ "outcome": "cancelled", "feedback": feedback }),
                None => json!({ "outcome": "cancelled" }),
            },
            PlanApprovalOutcome::Abandoned => json!({ "outcome": "abandoned" }),
        },
        PlanApprovalKind::Cursor => match outcome {
            PlanApprovalOutcome::Approved => json!({ "outcome": { "outcome": "accepted" } }),
            PlanApprovalOutcome::Cancelled => match feedback {
                Some(reason) => json!({ "outcome": { "outcome": "rejected", "reason": reason } }),
                None => json!({ "outcome": { "outcome": "rejected" } }),
            },
            PlanApprovalOutcome::Abandoned => json!({ "outcome": { "outcome": "cancelled" } }),
        },
    }
}

fn cursor_notification_result(method: &str, params: &Value) -> Value {
    match method {
        "cursor/update_todos" => json!({
            "outcome": {
                "outcome": "accepted",
                "todos": params.get("todos").cloned().unwrap_or(json!([]))
            }
        }),
        "cursor/task" => json!({ "outcome": { "outcome": "completed" } }),
        "cursor/generate_image" => json!({
            "outcome": {
                "outcome": "generated",
                "filePath": params.get("filePath").and_then(Value::as_str).unwrap_or("")
            }
        }),
        _ => json!({}),
    }
}

fn cursor_plan_content(params: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(name) = params
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        parts.push(format!("# {name}"));
    }
    if let Some(overview) = params
        .get("overview")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|overview| !overview.is_empty())
    {
        parts.push(overview.to_string());
    }
    if let Some(plan) = params
        .get("plan")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
    {
        parts.push(plan.to_string());
    }
    if let Some(todos) = params.get("todos").and_then(Value::as_array) {
        let lines = todos
            .iter()
            .filter_map(|todo| {
                let content = todo.get("content").and_then(Value::as_str)?.trim();
                if content.is_empty() {
                    return None;
                }
                let status = todo
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                let mark = if status == "completed" { "x" } else { " " };
                Some(format!("- [{mark}] {content}"))
            })
            .collect::<Vec<_>>();
        if !lines.is_empty() {
            parts.push(lines.join("\n"));
        }
    }
    let text = parts.join("\n\n");
    if text.trim().is_empty() {
        "The provider did not include plan content.".to_string()
    } else {
        text
    }
}

type ParsedCursorQuestions = (
    Vec<InteractiveQuestion>,
    HashMap<String, Vec<(String, String)>>,
);

fn parse_cursor_questions(params: &Value) -> ParsedCursorQuestions {
    let mut questions = Vec::new();
    let mut options_by_question = HashMap::new();
    let Some(entries) = params.get("questions").and_then(Value::as_array) else {
        return (questions, options_by_question);
    };
    for (index, entry) in entries.iter().enumerate() {
        let question_id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("q{index}"));
        let prompt = entry
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
            .unwrap_or("Cursor needs more information");
        let mut option_pairs = Vec::new();
        let ui_options = entry
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let option_id = option.get("id").and_then(Value::as_str)?.trim();
                        if option_id.is_empty() {
                            return None;
                        }
                        let label = option
                            .get("label")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|label| !label.is_empty())
                            .unwrap_or(option_id);
                        option_pairs.push((option_id.to_string(), label.to_string()));
                        Some(InteractiveQuestionOption {
                            label: label.to_string(),
                            description: String::new(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|options| !options.is_empty());
        options_by_question.insert(question_id.clone(), option_pairs);
        questions.push(InteractiveQuestion {
            id: question_id,
            header: params
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or("Question")
                .to_string(),
            question: prompt.to_string(),
            is_other: false,
            is_secret: false,
            options: ui_options,
        });
    }
    (questions, options_by_question)
}

fn acp_interject_probe_supported(outcome: &Result<Value, DaemonError>) -> bool {
    match outcome {
        Ok(_) => true,
        Err(DaemonError::Rpc(message)) => {
            !message.to_ascii_lowercase().contains("method not found")
        }
        Err(_) => false,
    }
}

/// Builds an ACP content block for a local image attachment: an `image` block
/// (`{type, data, mimeType}`) when the file is readable, a recognized image
/// type, and within the per-image and per-turn budgets — otherwise a text
/// block referencing the path, so the attachment never silently vanishes.
/// The mime type comes from the file extension, not the client's claim.
pub async fn acp_image_content_block(image: &ImageInput, encoded_budget: &mut usize) -> Value {
    let fallback = || {
        let reference = image
            .local_path
            .as_deref()
            .or(image.name.as_deref())
            .unwrap_or("attachment");
        json!({ "type": "text", "text": format!("[attached image: {reference}]") })
    };
    let Some(local_path) = image
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return fallback();
    };
    let Some(mime_type) = (match Path::new(local_path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }) else {
        return fallback();
    };
    let path = local_path.to_string();
    // File IO and base64 encoding are blocking work; keep them off the async
    // runtime threads.
    let encoded = tokio::task::spawn_blocking(move || -> Option<String> {
        // Metadata check is the fast path; the read result is what gets
        // enforced, so a file growing between the two cannot bypass the cap —
        // but a huge file is rejected before being loaded into memory.
        let metadata_within_limit = std::fs::metadata(&path)
            .map(|metadata| metadata.len() <= MAX_ACP_IMAGE_BYTES)
            .unwrap_or(false);
        if !metadata_within_limit {
            return None;
        }
        let bytes = std::fs::read(&path).ok()?;
        if bytes.len() as u64 > MAX_ACP_IMAGE_BYTES {
            return None;
        }
        Some(BASE64.encode(bytes))
    })
    .await
    .ok()
    .flatten();
    let Some(encoded) = encoded else {
        return fallback();
    };
    if encoded.len() > *encoded_budget {
        return fallback();
    }
    *encoded_budget -= encoded.len();
    json!({
        "type": "image",
        "data": encoded,
        "mimeType": mime_type
    })
}

/// Folds one `agent_message_chunk` into a session's accumulated text.
///
/// ACP specifies chunks as deltas, but agents in the wild (Grok CLI) re-send
/// the whole message so far on every chunk. Appending those duplicates the
/// prefix and grows quadratically — the transcript shows each block repeating
/// everything before it. A chunk that already contains the accumulated text is
/// a snapshot, so replace rather than append.
fn merge_assistant_chunk(accumulated: &mut String, chunk: &str) {
    if !accumulated.is_empty()
        && chunk.len() >= accumulated.len()
        && chunk.starts_with(&*accumulated)
    {
        *accumulated = chunk.to_string();
    } else {
        accumulated.push_str(chunk);
    }
}

/// One configured ACP provider, loaded from `providers.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcpProviderConfig {
    /// Stable provider id, e.g. "grok".
    #[serde(skip)]
    pub id: String,
    /// Human-readable label for pickers. Optional in the file — the loader
    /// falls back to the id, and requiring it here would make every write
    /// through the settings panel fail on hand-edited label-less entries.
    #[serde(default)]
    pub label: String,
    /// Command line to spawn, e.g. ["grok", "agent", "stdio"].
    pub command: Vec<String>,
    /// Provider-specific environment overrides, matching the configuration
    /// surface used by ACP clients such as Zed. The subprocess still inherits
    /// the daemon environment for keys not listed here.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Transport selection for OpenCode.  Other providers always use ACP;
    /// accepting the field generically keeps `providers.json` forwards
    /// compatible and makes a later native adapter opt-in reversible.
    #[serde(default)]
    pub transport: ProviderTransport,
}

/// The OpenCode transport requested in `providers.json`.
///
/// `auto` is intentionally conservative until the native server has passed
/// its compatibility probe; ACP remains the fallback rather than a legacy
/// path to be removed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderTransport {
    #[default]
    Auto,
    Native,
    Acp,
}

#[derive(Debug, Default, Deserialize)]
struct ProvidersFile {
    #[serde(default)]
    providers: HashMap<String, AcpProviderConfig>,
}

static PROVIDERS_WRITE_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

fn providers_entries(state_dir: &Path) -> serde_json::Map<String, Value> {
    let path = state_dir.join("providers.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .and_then(|raw| raw.get("providers").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

fn providers_revision(entries: &serde_json::Map<String, Value>) -> String {
    let encoded = serde_json::to_vec(entries).unwrap_or_default();
    format!("{:x}", Sha256::digest(encoded))
}

/// Provider ids configured in `providers.json`. Reserved ids are excluded;
/// Codex and Claude are never ACP-file providers.
pub fn known_provider_ids(state_path: &Path) -> Vec<String> {
    let state_dir = state_path.parent().unwrap_or_else(|| Path::new("."));
    let path = state_dir.join("providers.json");
    let raw: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_else(|| json!({ "providers": {} }));
    raw.get("providers")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .keys()
                .filter(|id| !AgentProvider::is_reserved_id(id.as_str()))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Raw + resolved view of `providers.json` for the settings UI. Entries whose
/// binary is missing are included with `binary_found: false` so the panel can
/// explain why a configured provider is hidden from pickers.
pub fn providers_overview(state_dir: &Path) -> Value {
    let entries = providers_entries(state_dir);
    let revision = providers_revision(&entries);
    let resolved = entries
        .iter()
        .map(|(id, entry)| {
            // Entries whose command is missing or not an array are still
            // listed (flagged malformed) — the panel's job is explaining why
            // a configured provider is hidden, and hiding the broken ones
            // would also make them undeletable through the UI.
            let command = entry.get("command").and_then(Value::as_array).map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            });
            let malformed = command.as_ref().is_none_or(Vec::is_empty);
            let command = command.unwrap_or_default();
            let binary_found = command
                .first()
                .is_some_and(|bin| crate::agent_binary::agent_binary_available_cached(bin, bin));
            json!({
                "id": id,
                "label": entry.get("label").and_then(Value::as_str).unwrap_or(id),
                "command": command,
                "binary_found": binary_found,
                "reserved": AgentProvider::is_reserved_id(id),
                "malformed": malformed,
            })
        })
        .collect::<Vec<_>>();
    json!({ "providers": entries, "resolved": resolved, "revision": revision })
}

/// Validates and atomically writes `providers.json` (`{"providers": …}`).
pub fn write_providers_file(state_dir: &Path, providers: &Value) -> Result<(), String> {
    let lock = PROVIDERS_WRITE_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "providers write lock is poisoned".to_string())?;
    write_providers_file_locked(state_dir, providers)
}

/// Optimistic-concurrency variant used by settings clients. The comparison
/// and atomic rename share one owner lock with daemon/RPC writes, so a stale
/// panel can never replace a provider update that landed after its GET.
pub fn write_providers_file_if_revision(
    state_dir: &Path,
    providers: &Value,
    expected_revision: &str,
) -> Result<(), String> {
    let lock = PROVIDERS_WRITE_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "providers write lock is poisoned".to_string())?;
    let current_revision = providers_revision(&providers_entries(state_dir));
    if expected_revision != current_revision {
        return Err("providers changed since they were loaded".to_string());
    }
    write_providers_file_locked(state_dir, providers)
}

fn write_providers_file_locked(state_dir: &Path, providers: &Value) -> Result<(), String> {
    let entries = providers
        .as_object()
        .ok_or("invalid providers payload: expected an object of provider entries")?;
    for (id, entry) in entries {
        if AgentProvider::is_reserved_id(id) {
            return Err(format!(
                "'{id}' is a built-in provider and cannot be overridden"
            ));
        }
        // Entries that parse get their command validated. Ones that do not are
        // passed through untouched: the read path already tolerates (and
        // hides) malformed hand-edits, and rejecting them here would wedge
        // every save — including the delete that removes them.
        if let Ok(config) = serde_json::from_value::<AcpProviderConfig>(entry.clone())
            && (config.command.is_empty() || config.command[0].trim().is_empty())
        {
            return Err(format!("provider '{id}' needs a non-empty command"));
        }
    }
    std::fs::create_dir_all(state_dir)
        .map_err(|error| format!("failed to create {}: {error}", state_dir.display()))?;
    let path = state_dir.join("providers.json");
    let body = serde_json::to_string_pretty(&json!({ "providers": providers }))
        .map_err(|error| format!("failed to encode providers file: {error}"))?;
    // Unique temp name: concurrent writers (panel + remote RPC) sharing one
    // .tmp path would interleave bytes and publish a corrupted file.
    let tmp = path.with_extension(format!("json.tmp.{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, body)
        .map_err(|error| format!("failed to write {}: {error}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))
}

/// Exports all ACP providers from providers.json for backup.
pub fn backup_acp_providers(state_dir: &Path) -> Vec<falcondeck_core::AcpProviderBackupEntry> {
    let entries = providers_entries(state_dir);
    let mut list = Vec::new();
    for (id, val) in entries {
        if AgentProvider::is_reserved_id(&id) {
            continue;
        }
        if let Ok(config) = serde_json::from_value::<AcpProviderConfig>(val) {
            list.push(falcondeck_core::AcpProviderBackupEntry {
                id,
                label: config.label,
                command: config.command,
                env: config.env,
                transport: match config.transport {
                    ProviderTransport::Auto => Some("auto".to_string()),
                    ProviderTransport::Native => Some("native".to_string()),
                    ProviderTransport::Acp => Some("acp".to_string()),
                },
            });
        }
    }
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list
}

/// Restores ACP providers from backup into providers.json.
pub fn restore_acp_providers(
    state_dir: &Path,
    providers: &[falcondeck_core::AcpProviderBackupEntry],
) -> usize {
    if providers.is_empty() {
        return 0;
    }
    let mut entries = providers_entries(state_dir);
    let mut count = 0;
    for provider in providers {
        if AgentProvider::is_reserved_id(&provider.id) {
            continue;
        }
        let mut obj = serde_json::Map::new();
        obj.insert("label".to_string(), Value::String(provider.label.clone()));
        obj.insert(
            "command".to_string(),
            serde_json::to_value(&provider.command).unwrap_or_else(|_| Value::Array(Vec::new())),
        );
        obj.insert(
            "env".to_string(),
            serde_json::to_value(&provider.env)
                .unwrap_or_else(|_| Value::Object(serde_json::Map::new())),
        );
        if let Some(transport) = &provider.transport {
            obj.insert("transport".to_string(), Value::String(transport.clone()));
        }
        entries.insert(provider.id.clone(), Value::Object(obj));
        count += 1;
    }
    let _ = write_providers_file(state_dir, &Value::Object(entries));
    count
}

/// Loads ACP provider configs from `<state_dir>/providers.json`.
///
/// A missing file means no extra providers; a malformed file is surfaced in
/// the log rather than taking the daemon down.
pub fn load_acp_provider_configs(state_dir: &Path) -> Vec<AcpProviderConfig> {
    let path = state_dir.join("providers.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<ProvidersFile>(&raw) {
        Ok(file) => {
            let mut configs = file
                .providers
                .into_iter()
                .filter(|(id, config)| {
                    let reserved = AgentProvider::is_reserved_id(id);
                    let valid = !config.command.is_empty();
                    if reserved {
                        tracing::warn!(provider = %id, "providers.json cannot override built-in providers");
                    }
                    if !valid {
                        tracing::warn!(provider = %id, "providers.json entry has an empty command");
                    }
                    !reserved && valid
                })
                .map(|(id, mut config)| {
                    if config.label.trim().is_empty() {
                        config.label = id.clone();
                    }
                    config.id = id;
                    config
                })
                .filter(|config| {
                    // A configured provider whose binary is absent stays
                    // dormant instead of surfacing a dead picker entry; it
                    // appears automatically once the CLI is installed. Cached
                    // probe: this runs on every snapshot and the uncached
                    // resolver can spawn a login shell for missing binaries.
                    let available = crate::agent_binary::agent_binary_available_cached(
                        &config.command[0],
                        &config.command[0],
                    );
                    if !available {
                        tracing::info!(
                            provider = %config.id,
                            binary = %config.command[0],
                            "ACP provider configured but binary not found; hidden until installed"
                        );
                    }
                    available
                })
                .collect::<Vec<_>>();
            configs.sort_by(|left, right| left.id.cmp(&right.id));
            configs
        }
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "failed to parse providers.json");
            Vec::new()
        }
    }
}

/// A permission option offered by the agent in `session/request_permission`.
#[derive(Debug, Clone)]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub kind: String,
}

/// Whether a permission mode means "the user already approved everything".
///
/// Providers spell this differently ("bypassPermissions", "always-approve",
/// "yolo", …). Threads carrying such a mode never surface approval banners:
/// the daemon answers `session/request_permission` itself, which keeps the
/// promise even when a harness ignores its own session-level toggle.
pub fn is_blanket_approval_mode(mode: &str) -> bool {
    matches!(
        mode.replace(['-', '_', ' '], "")
            .to_ascii_lowercase()
            .as_str(),
        "bypasspermissions"
            | "bypasspermission"
            | "alwaysapprove"
            | "alwaysallow"
            | "allowall"
            | "yolo"
            | "never"
            | "dontask"
    )
}

fn permission_option_for_decision<'a>(
    options: &'a [AcpPermissionOption],
    decision: &ApprovalDecision,
) -> Option<&'a AcpPermissionOption> {
    let wanted = match decision {
        ApprovalDecision::Allow => "allow_once",
        ApprovalDecision::AlwaysAllow => "allow_always",
        ApprovalDecision::Deny => "reject_once",
    };
    options
        .iter()
        .find(|option| option.kind == wanted)
        .or_else(|| {
            matches!(decision, ApprovalDecision::Deny)
                .then(|| {
                    options
                        .iter()
                        .find(|option| option.kind.starts_with("reject"))
                })
                .flatten()
        })
}

/// Projects one ACP content block to displayable text. Text passes through;
/// other block kinds degrade to a labeled reference instead of vanishing —
/// a chunk that produces no event at all reads as a hole in the transcript.
fn acp_content_block_text(block: &Value) -> Option<String> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => block
            .get("text")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        Some("image") => Some(
            block
                .get("mimeType")
                .and_then(Value::as_str)
                .map_or_else(|| "[image]".to_string(), |mime| format!("[image: {mime}]")),
        ),
        Some("audio") => Some("[audio]".to_string()),
        Some("resource_link") => block
            .get("uri")
            .and_then(Value::as_str)
            .map(|uri| format!("[resource: {uri}]")),
        Some("resource") => block
            .pointer("/resource/text")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| {
                block
                    .pointer("/resource/uri")
                    .and_then(Value::as_str)
                    .map(|uri| format!("[resource: {uri}]"))
            }),
        // Legacy adapters emit bare `{ "text": ... }` blocks with no type.
        _ => block
            .get("text")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    }
}

/// Displayable text for a JSON-RPC error's `data` field. Providers disagree
/// on its shape (bare string, `{ "details": ... }`, arbitrary object), so this
/// accepts all of them; structured payloads are bounded because they were
/// never meant for display.
pub(crate) fn rpc_error_data_text(data: &Value) -> Option<String> {
    const MAX_LEN: usize = 500;
    let text = match data {
        Value::String(text) => text.clone(),
        Value::Null => return None,
        other => other
            .get("details")
            .or_else(|| other.get("message"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| other.to_string()),
    };
    let text = text.trim();
    if text.is_empty() || text == "{}" {
        return None;
    }
    Some(if text.chars().count() > MAX_LEN {
        format!("{}…", text.chars().take(MAX_LEN).collect::<String>())
    } else {
        text.to_string()
    })
}

/// Stderr markers OpenCode uses for API failures that never become JSON-RPC
/// errors. The prompt RPC still returns a successful `stopReason`.
const OPENCODE_STDERR_ERROR_MARKERS: [&str; 3] = ["level=error", "stream error", "ai_apicallerror"];
const OPENCODE_STDERR_DIAGNOSTIC_LIMIT: usize = 360;
/// JSON-RPC stdout can settle before the stderr task reads the matching
/// error line. A short wait is enough for the pipe; this is not a stall.
const ACP_STDERR_DRAIN: Duration = Duration::from_millis(150);

fn truncate_diagnostic(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let taken: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{taken}…")
    } else {
        taken
    }
}

fn shell_style_key_value(line: &str, key: &str) -> Option<String> {
    let rest = line.split_once(&format!("{key}="))?.1;
    if let Some(rest) = rest.strip_prefix('"') {
        let mut value = String::new();
        let mut escaped = false;
        for character in rest.chars() {
            if escaped {
                value.push(character);
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                return Some(value);
            } else {
                value.push(character);
            }
        }
        return None;
    }
    let value = rest.split_whitespace().next().unwrap_or(rest);
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn opencode_stderr_error_summary(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    if !OPENCODE_STDERR_ERROR_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return None;
    }
    let extracted = shell_style_key_value(line, "error.error")
        .or_else(|| shell_style_key_value(line, "error"))
        .unwrap_or_else(|| line.trim().to_string());
    let cleaned = extracted
        .strip_prefix("AI_APICallError:")
        .or_else(|| extracted.strip_prefix("APICallError:"))
        .unwrap_or(extracted.as_str())
        .trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(truncate_diagnostic(
            cleaned,
            OPENCODE_STDERR_DIAGNOSTIC_LIMIT,
        ))
    }
}

fn json_u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|entry| {
        entry
            .as_u64()
            .or_else(|| entry.as_i64().and_then(|n| u64::try_from(n).ok()))
            .or_else(|| entry.as_str().and_then(|text| text.parse().ok()))
    })
}

fn prompt_usage_indicates_no_model_tokens(response: &Value) -> bool {
    let Some(usage) = response.get("usage") else {
        return false;
    };
    if let Some(total) = json_u64_field(usage, "totalTokens") {
        return total == 0;
    }
    let input = json_u64_field(usage, "inputTokens");
    let output = json_u64_field(usage, "outputTokens");
    if input.is_some() || output.is_some() {
        return input.unwrap_or(0) == 0 && output.unwrap_or(0) == 0;
    }
    false
}

fn is_successful_empty_prompt_stop_reason(stop_reason: &str) -> bool {
    matches!(
        stop_reason.trim().to_ascii_lowercase().as_str(),
        "end_turn" | "stop" | "completed" | "complete" | ""
    )
}

fn acp_text_blocks_to_string(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            block.get("text").and_then(Value::as_str)
        })
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn wrap_xml_messages(tag: &str, texts: &[String]) -> String {
    let inner = texts
        .iter()
        .enumerate()
        .map(|(index, text)| format!("<message index=\"{}\">\n{text}\n</message>", index + 1))
        .collect::<Vec<_>>()
        .join("\n");
    format!("<{tag}>\n{inner}\n</{tag}>")
}

fn non_text_content_blocks(blocks: &[Value]) -> Vec<Value> {
    blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) != Some("text"))
        .cloned()
        .collect()
}

/// Re-sends cancelled user text with the steering prompt. ACP has no steer
/// verb; cancel + re-prompt is the only path, and some providers drop the
/// cancelled prompt from their own conversation history.
fn bundle_cancelled_acp_prompt(interrupted: &[Vec<Value>], steering: Vec<Value>) -> Vec<Value> {
    let steering_text = acp_text_blocks_to_string(&steering);
    let mut seen = HashSet::new();
    let interrupted_texts = interrupted
        .iter()
        .map(|blocks| acp_text_blocks_to_string(blocks))
        .filter(|text| !text.is_empty() && text != &steering_text && seen.insert(text.clone()))
        .collect::<Vec<_>>();
    if interrupted_texts.is_empty() {
        return steering;
    }
    let interrupted_section = wrap_xml_messages("interrupted_user_messages", &interrupted_texts);
    let steering_texts = if steering_text.is_empty() {
        Vec::new()
    } else {
        vec![steering_text]
    };
    let steering_section = wrap_xml_messages("steering_messages", &steering_texts);
    let text = format!(
        "{interrupted_section}\n\n{steering_section}\n\nThe active ACP prompt was cancelled so this steering could be delivered. Treat the interrupted user messages, if any, followed by the steering messages above as the latest user messages in chronological order."
    );
    let mut bundled = vec![json!({ "type": "text", "text": text })];
    for blocks in interrupted {
        bundled.extend(non_text_content_blocks(blocks));
    }
    bundled.extend(non_text_content_blocks(&steering));
    bundled
}

fn empty_acp_prompt_diagnostic(
    stop_reason: &str,
    response: &Value,
    stderr: Option<&str>,
) -> String {
    let usage = response.get("usage");
    let input = usage
        .and_then(|value| json_u64_field(value, "inputTokens"))
        .unwrap_or(0);
    let output = usage
        .and_then(|value| json_u64_field(value, "outputTokens"))
        .unwrap_or(0);
    let total = usage
        .and_then(|value| json_u64_field(value, "totalTokens"))
        .unwrap_or(0);
    let mut message = format!(
        "OpenCode ACP completed with stopReason={stop_reason} but emitted no assistant content. Prompt usage was input={input}, output={output}, total={total}."
    );
    if let Some(stderr) = stderr.map(str::trim).filter(|text| !text.is_empty()) {
        message.push_str(&format!(" OpenCode stderr reported: {stderr}."));
    }
    message.push_str(" The model returned no text to render.");
    message
}

/// An ACP tool call's title, made readable. Agents send their own wire name
/// (`read_file`, `search_replace`, `run_terminal_command`) on the opening
/// update and only replace it with prose once the call resolves — which never
/// happens if the turn is interrupted. A one-word title is that raw name, so
/// it goes through the same table every other harness uses, fed by the call's
/// `rawInput` or, failing that, the file ACP says it touched.
fn acp_tool_title(update: &Value) -> Option<String> {
    let title = update.get("title").and_then(Value::as_str)?.trim();
    if title.is_empty() {
        return None;
    }
    if title.split_whitespace().count() > 1 {
        return Some(title.to_string());
    }

    let located = update
        .pointer("/locations/0/path")
        .and_then(Value::as_str)
        .map(|path| json!({ "path": path }));
    let input = update.get("rawInput").or(located.as_ref());
    Some(synthesize_tool_title(title, input, None).unwrap_or_else(|| title.to_string()))
}

/// Splits an ACP tool-call `content` array into displayable output text and
/// structured `diff` blocks (the standard way ACP agents report file edits).
fn acp_tool_content(update: &Value) -> (Option<String>, Vec<AcpDiffContent>) {
    let mut texts = Vec::new();
    let mut diffs = Vec::new();
    for item in update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("content") => {
                if let Some(text) = item.get("content").and_then(acp_content_block_text) {
                    texts.push(text);
                }
            }
            Some("diff") => {
                if let Some(path) = item
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|path| !path.trim().is_empty())
                {
                    diffs.push(AcpDiffContent {
                        path: path.to_string(),
                        old_text: item
                            .get("oldText")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned),
                        new_text: item
                            .get("newText")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    });
                }
            }
            Some("terminal") => {}
            // Loose shapes seen from early adapters: a nested content block
            // or a bare text field.
            _ => {
                if let Some(text) = item
                    .pointer("/content/text")
                    .or_else(|| item.get("text"))
                    .and_then(Value::as_str)
                {
                    texts.push(text.to_string());
                }
            }
        }
    }
    let output = texts.join("\n");
    ((!output.is_empty()).then_some(output), diffs)
}

/// Normalized events the runtime emits toward the app layer.
#[derive(Debug)]
pub enum AcpEvent {
    /// Streaming assistant text for a session.
    MessageDelta {
        session_id: String,
        message_id: Option<String>,
        text: String,
    },
    /// Streaming agent reasoning/thought text for a session.
    ThoughtDelta {
        session_id: String,
        message_id: Option<String>,
        text: String,
    },
    /// Agent-supplied session metadata, currently used for native titles.
    SessionInfo {
        session_id: String,
        title: Option<String>,
    },
    /// Current context usage reported by the agent.
    Usage {
        session_id: String,
        used: u64,
        size: u64,
    },
    /// User history replayed by `session/load`.
    UserMessageDelta {
        session_id: String,
        message_id: Option<String>,
        text: String,
    },
    /// A `session/load` request is about to stream this session's history.
    /// Sent before the request goes out, so on the ordered event channel it
    /// precedes every replayed notification. The pump must treat items until
    /// the matching `ReplayFinished` as history recovery, not fresh agent
    /// activity — otherwise every restored thread flips unread on first open.
    ReplayStarted { session_id: String },
    /// The `session/load` request settled (either way); replayed history for
    /// this session has been fully enqueued and later events are live again.
    ReplayFinished { session_id: String },
    /// A tool call started or was announced.
    ToolCall {
        session_id: String,
        call_id: String,
        title: String,
        kind: String,
        status: String,
        output: Option<String>,
        diffs: Vec<AcpDiffContent>,
    },
    /// A tool call changed status or produced output.
    ToolCallUpdate {
        session_id: String,
        call_id: String,
        title: Option<String>,
        status: Option<String>,
        output: Option<String>,
        diffs: Vec<AcpDiffContent>,
    },
    /// The agent published or updated its plan.
    Plan {
        session_id: String,
        plan: ThreadPlan,
    },
    /// The agent asks the user to approve a tool call.
    PermissionRequest {
        session_id: String,
        request_id: String,
        title: String,
        detail: Option<String>,
        options: Vec<AcpPermissionOption>,
    },
    /// Grok or Cursor asks the user to approve, revise, or abandon an implementation plan.
    PlanApprovalRequest {
        session_id: String,
        request_id: String,
        method: String,
        tool_call_id: Option<String>,
        plan_content: String,
    },
    /// Cursor asks one or more clarifying questions before continuing.
    QuestionRequest {
        session_id: String,
        request_id: String,
        title: String,
        questions: Vec<InteractiveQuestion>,
    },
    /// The agent finished a prompt turn; ordered after that turn's deltas.
    /// `stop_reason` is the agent-reported reason (`end_turn`, `cancelled`,
    /// `refusal`, ...); `None` means the prompt request itself failed.
    /// `had_output` is true when this prompt segment emitted assistant text,
    /// reasoning, or a tool call — adapters that fail auth often return
    /// `end_turn` with none of those, which must not look like a reply.
    TurnEnded {
        session_id: String,
        stop_reason: Option<String>,
        error: Option<String>,
        had_output: bool,
    },
    /// The agent process died or the stream broke.
    Fatal { message: String },
}

struct PendingPermission {
    raw_id: Value,
    session_id: String,
    options: Vec<AcpPermissionOption>,
}

struct PendingPlanApproval {
    raw_id: Value,
    session_id: String,
    kind: PlanApprovalKind,
}

struct PendingQuestion {
    raw_id: Value,
    session_id: String,
    options_by_question: HashMap<String, Vec<(String, String)>>,
}

/// Remembered identity and last-known output for an announced tool call.
/// ACP `tool_call_update` is a partial update — absent fields mean
/// "unchanged" — so the runtime must carry state between updates or a
/// status-only completion would erase previously streamed output.
#[derive(Debug, Clone)]
pub struct AcpToolMemory {
    pub session_id: String,
    pub title: String,
    pub kind: String,
    pub output: Option<String>,
}

/// A `diff` content block from an ACP tool call: the agent's report of a
/// file mutation, carried separately from textual output so the app layer
/// can project it as a real file-change item instead of dropping it.
#[derive(Debug, Clone)]
pub struct AcpDiffContent {
    pub path: String,
    pub old_text: Option<String>,
    pub new_text: String,
}

/// A live ACP agent process serving one workspace.
pub struct AcpRuntime {
    pub provider: AgentProvider,
    pub config: AcpProviderConfig,
    workspace_path: String,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, DaemonError>>>>,
    /// thread id -> ACP session id
    sessions: Mutex<HashMap<String, String>>,
    /// ACP session id -> thread id
    threads_by_session: Mutex<HashMap<String, String>>,
    /// Per-thread gates serialize restored-session loading with the first
    /// post-restart turn. Without this, background hydration and a prompt can
    /// issue two concurrent `session/load` requests; one may fail and replace
    /// the recoverable session with a fresh one.
    session_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    permission_requests: Mutex<HashMap<String, PendingPermission>>,
    plan_approval_requests: Mutex<HashMap<String, PendingPlanApproval>>,
    question_requests: Mutex<HashMap<String, PendingQuestion>>,
    /// Per-session accumulating assistant item for the current turn.
    current_items: Mutex<HashMap<String, (String, String)>>,
    /// Per-session accumulating reasoning item for the current turn.
    current_thought_items: Mutex<HashMap<String, (String, String)>>,
    current_user_items: Mutex<HashMap<String, (String, String)>>,
    /// Per-session plan item identity for the current turn. Plan updates within
    /// a turn replace one item, while a later turn keeps its own history row.
    current_plan_items: Mutex<HashMap<String, String>>,
    /// Tool identity and last-known output by call id. ACP updates are
    /// partial, so status-only updates must not erase earlier output.
    current_tools: Mutex<HashMap<String, AcpToolMemory>>,
    /// Bounded tail of the agent's stderr, surfaced when the process dies.
    stderr_tail: Mutex<VecDeque<String>>,
    /// Session modes advertised via session/new (or session/load), by
    /// session id. This is the legacy ACP mode surface; configOptions are
    /// preferred when an agent implements the stabilized protocol.
    session_modes: Mutex<HashMap<String, SessionModeState>>,
    /// Config option ids and categories for each live ACP session.
    session_configurations: Mutex<HashMap<String, AcpSessionConfiguration>>,
    /// Effort ids each session currently accepts. OpenCode publishes these
    /// per selected model, so they change with every model switch and a stale
    /// value must not be sent back.
    session_reasoning_efforts: Mutex<HashMap<String, Vec<String>>>,
    /// Model catalog learned from session/new. ACP initialize commonly has no
    /// model list, so this is intentionally separate from initialize_result.
    discovered_models: Mutex<Vec<ModelSummary>>,
    /// Whether the cursor CLI model probe already ran for this process. Older
    /// Cursor builds omit the ACP catalog, so the fallback is
    /// `cursor-agent --list-models`; the flag keeps that to one run.
    cli_models_probed: AtomicBool,
    /// Permission-like modes learned from ACP config options. Grok also has a
    /// documented provider-specific fallback when it does not advertise them.
    discovered_permission_modes: Mutex<Vec<String>>,
    /// Agent behavior modes (for example OpenCode build/plan).
    discovered_collaboration_modes: Mutex<Vec<CollaborationModeSummary>>,
    /// Prevents multiple callers from creating discovery sessions concurrently.
    discovery_gate: Mutex<()>,
    metadata_discovered: AtomicBool,
    /// Session-update kinds already diagnosed for this process. Adapters can
    /// emit thousands of chunks, so protocol drift is logged once per kind.
    reported_update_kinds: Mutex<HashSet<String>>,
    /// Most recent provider-reported turn failure per session, from vendor
    /// notifications (Grok's `_x.ai/session/update`). The JSON-RPC error on
    /// `session/prompt` is often the generic "Internal error"; this holds the
    /// real cause (for example an API 402) to surface instead.
    turn_failure_details: Mutex<HashMap<String, String>>,
    /// OpenCode (and similar) can RPC-succeed `session/prompt` while the real
    /// failure only appears on stderr. Captured while a prompt is in flight.
    prompt_stderr_errors: Mutex<HashMap<String, String>>,
    initialize_result: Mutex<Option<Value>>,
    /// Whether the live process answered the vendor interjection probe
    /// (Grok's `x.ai/interject`). Steering itself needs no extension: every
    /// other agent is steered by cancelling the in-flight prompt and
    /// re-prompting on the same session (see [`AcpRuntime::steer_with_cancel`]).
    supports_interject: AtomicBool,
    /// Per-session steer bookkeeping for the active turn. An entry exists
    /// exactly while [`AcpRuntime::prompt`] runs its segment loop, so a steer
    /// landing without one is stale by definition.
    steer_queues: Mutex<HashMap<String, SteerQueue>>,
    /// Sessions currently inside [`AcpRuntime::prompt`]. Out-of-turn chunks
    /// (pi-acp's session-start banner) must not become the user's reply.
    prompt_sessions: Mutex<HashSet<String>>,
    /// Prompt sessions that emitted turn content during the current segment.
    prompt_output_sessions: Mutex<HashSet<String>>,
    /// Sessions whose `session/load` replay is in flight. Replay history is
    /// not a prompt but must still project as conversation items.
    replay_sessions: Mutex<HashSet<String>>,
    closed: AtomicBool,
    events: mpsc::UnboundedSender<AcpEvent>,
}

/// Steer state for one session's active turn. Mirrors the semantics bb's ACP
/// bridge established: a steer queues its input and cancels the in-flight
/// prompt; the prompt loop then delivers the queued input as the next
/// `session/prompt` on the same session, continuing the same logical turn.
#[derive(Default)]
struct SteerQueue {
    /// Prompt content blocks waiting to be delivered after the current
    /// prompt settles.
    queued: VecDeque<Vec<Value>>,
    /// User prompts cancelled during this turn, in order. Some ACP providers
    /// drop the cancelled prompt from their own history, so the next
    /// `session/prompt` re-bundles these with the steering text.
    interrupted: Vec<Vec<Value>>,
    /// The in-flight segment's original content (not a re-bundled wrapper).
    current: Vec<Value>,
    /// True after a steer sent `session/cancel` for the current prompt, so
    /// stacked steers do not fire redundant cancels.
    cancel_requested: bool,
    /// True after a user interrupt: the turn is ending, queued steers are
    /// dropped, and new steers are refused.
    stopping: bool,
}

/// ACP session mode state: the agent's current mode plus the ids it accepts
/// through `session/set_mode`.
#[derive(Debug, Clone, Default)]
pub struct SessionModeState {
    pub current: Option<String>,
    pub available: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct AcpSessionConfiguration {
    model_config_id: Option<String>,
    reasoning_config_id: Option<String>,
    permission_config_id: Option<String>,
    collaboration_config_id: Option<String>,
}

impl AcpSessionConfiguration {
    fn is_empty(&self) -> bool {
        self.model_config_id.is_none()
            && self.reasoning_config_id.is_none()
            && self.permission_config_id.is_none()
            && self.collaboration_config_id.is_none()
    }
}

#[derive(Debug, Default)]
pub(crate) struct ParsedSessionMetadata {
    pub(crate) models: Vec<ModelSummary>,
    pub(crate) reasoning_efforts: Vec<ReasoningEffortSummary>,
    default_reasoning_effort: Option<String>,
    pub(crate) permission_modes: Vec<String>,
    pub(crate) collaboration_modes: Vec<CollaborationModeSummary>,
    configuration: AcpSessionConfiguration,
}

impl ParsedSessionMetadata {
    pub(crate) fn model_config_id(&self) -> Option<&str> {
        self.configuration.model_config_id.as_deref()
    }
}

fn string_field(value: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn option_value(value: &Value) -> Option<String> {
    string_field(value, &["value", "id", "modelId", "model_id"])
}

fn reasoning_option(value: &Value) -> Option<ReasoningEffortSummary> {
    let reasoning_effort = option_value(value)?;
    Some(ReasoningEffortSummary {
        reasoning_effort,
        description: string_field(value, &["description", "label", "name"]).unwrap_or_default(),
    })
}

fn reasoning_options(value: Option<&Value>) -> Vec<ReasoningEffortSummary> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(reasoning_option)
        .collect()
}

fn is_reasoning_id(value: &str) -> bool {
    matches!(
        value
            .replace(['-', '_', ' '], "")
            .to_ascii_lowercase()
            .as_str(),
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

fn looks_like_reasoning(options: &[ReasoningEffortSummary]) -> bool {
    !options.is_empty()
        && options.iter().all(|option| {
            is_reasoning_id(&option.reasoning_effort)
                || option.description.to_ascii_lowercase().contains("thinking")
                || option
                    .description
                    .to_ascii_lowercase()
                    .contains("reasoning")
                || option.description.to_ascii_lowercase().contains("effort")
        })
}

fn model_summary(
    value: &Value,
    current_model_id: Option<&str>,
    global_reasoning_efforts: &[ReasoningEffortSummary],
) -> Option<ModelSummary> {
    let id = string_field(value, &["modelId", "model_id", "id", "model", "value"])?;
    let meta = value.get("_meta");
    let model_reasoning_efforts = reasoning_options(
        value
            .get("reasoningEfforts")
            .or_else(|| meta.and_then(|meta| meta.get("reasoningEfforts"))),
    );
    let default_reasoning_effort = string_field(
        value,
        &["defaultReasoningEffort", "default_reasoning_effort"],
    )
    .or_else(|| {
        meta.and_then(|meta| string_field(meta, &["reasoningEffort", "defaultReasoningEffort"]))
    });
    Some(ModelSummary {
        label: string_field(value, &["name", "label", "displayName", "display_name"])
            .unwrap_or_else(|| id.clone()),
        is_default: value
            .get("default")
            .or_else(|| value.get("isDefault"))
            .and_then(Value::as_bool)
            .unwrap_or(current_model_id == Some(id.as_str())),
        id,
        default_reasoning_effort,
        supported_reasoning_efforts: if model_reasoning_efforts.is_empty() {
            global_reasoning_efforts.to_vec()
        } else {
            model_reasoning_efforts
        },
        service_tiers: Vec::new(),
        default_service_tier: None,
    })
}

fn dedupe_models(models: impl IntoIterator<Item = ModelSummary>) -> Vec<ModelSummary> {
    let mut seen = HashSet::new();
    models
        .into_iter()
        .filter(|model| seen.insert(model.id.clone()))
        .collect()
}

fn parse_initialize_models(init: &Value) -> Vec<ModelSummary> {
    let current = init.get("currentModelId").and_then(Value::as_str);
    if let Some(models) = init.get("models") {
        if let Some(entries) = models.as_array() {
            return dedupe_models(
                entries
                    .iter()
                    .filter_map(|entry| model_summary(entry, current, &[])),
            );
        }
        if models.is_object() {
            return parse_session_metadata(&json!({ "models": models })).models;
        }
    }
    if let Some(entries) = init
        .pointer("/agentCapabilities/models")
        .and_then(Value::as_array)
    {
        return dedupe_models(
            entries
                .iter()
                .filter_map(|entry| model_summary(entry, current, &[])),
        );
    }
    // Grok 1.0+ publishes the same catalog session/new later returns, nested
    // under `_meta.modelState`. Without this, a new-thread composer stays on
    // a placeholder picker until a discovery session finishes — and that
    // session often times out while Grok loads plugins and MCP servers.
    if let Some(state) = init.pointer("/_meta/modelState") {
        return parse_session_metadata(&json!({ "models": state })).models;
    }
    Vec::new()
}

/// Grok-only `session/new` `_meta`. The adapter ignores top-level `modelId`
/// and only honors `_meta.modelId` at session creation; permission modes map
/// onto `_meta.yoloMode` / `_meta.autoMode`.
fn grok_session_new_meta(model_id: Option<&str>, permission_mode: Option<&str>) -> Option<Value> {
    let mut meta = serde_json::Map::new();
    if let Some(model_id) = model_id.map(str::trim).filter(|id| !id.is_empty()) {
        meta.insert("modelId".to_string(), json!(model_id));
    }
    match permission_mode {
        Some(mode) if is_blanket_approval_mode(mode) => {
            meta.insert("yoloMode".to_string(), json!(true));
        }
        Some(mode) if mode.eq_ignore_ascii_case("auto") => {
            meta.insert("autoMode".to_string(), json!(true));
        }
        _ => {}
    }
    if meta.is_empty() {
        None
    } else {
        Some(Value::Object(meta))
    }
}

/// ACP method capabilities use `{}` in the current v1 schema, while older
/// adapters commonly advertised booleans. Accept both representations.
fn capability_enabled(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(enabled)) => *enabled,
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

pub(crate) fn parse_session_metadata(result: &Value) -> ParsedSessionMetadata {
    let mut parsed = ParsedSessionMetadata::default();
    let mut current_model_id = None;

    if let Some(models) = result.get("models") {
        current_model_id = models.get("currentModelId").and_then(Value::as_str);
        if let Some(entries) = models.get("availableModels").and_then(Value::as_array) {
            parsed.models.extend(
                entries
                    .iter()
                    .filter_map(|entry| model_summary(entry, current_model_id, &[])),
            );
        }
    }

    if let Some(entries) = result.get("configOptions").and_then(Value::as_array) {
        for option in entries {
            let Some(category) = option.get("category").and_then(Value::as_str) else {
                continue;
            };
            let option_id = option
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let choices = option
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            match category {
                "model" => {
                    if current_model_id.is_none() {
                        current_model_id = option.get("currentValue").and_then(Value::as_str);
                    }
                    parsed.models.extend(
                        choices
                            .iter()
                            .filter_map(|choice| model_summary(choice, current_model_id, &[])),
                    );
                    parsed.configuration.model_config_id = option_id;
                }
                "thought_level" => {
                    if parsed.default_reasoning_effort.is_none() {
                        parsed.default_reasoning_effort = option
                            .get("currentValue")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned);
                    }
                    parsed
                        .reasoning_efforts
                        .extend(reasoning_options(Some(&Value::Array(choices))));
                    parsed.configuration.reasoning_config_id = option_id;
                }
                "mode" => {
                    let modes = choices.iter().filter_map(option_value).collect::<Vec<_>>();
                    let effort_options = modes
                        .iter()
                        .map(|mode| Value::String(mode.clone()))
                        .collect::<Vec<_>>();
                    let effort_options = effort_options
                        .iter()
                        .map(|value| ReasoningEffortSummary {
                            reasoning_effort: value.as_str().unwrap_or_default().to_string(),
                            description: String::new(),
                        })
                        .collect::<Vec<_>>();
                    if looks_like_reasoning(&effort_options) {
                        if parsed.default_reasoning_effort.is_none() {
                            parsed.default_reasoning_effort = option
                                .get("currentValue")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned);
                        }
                        parsed
                            .reasoning_efforts
                            .extend(reasoning_options(Some(&Value::Array(choices))));
                        parsed.configuration.reasoning_config_id = option_id;
                    } else {
                        parsed
                            .collaboration_modes
                            .extend(choices.iter().filter_map(|choice| {
                                let id = option_value(choice)?;
                                Some(CollaborationModeSummary {
                                    label: string_field(choice, &["label", "name"])
                                        .unwrap_or_else(|| id.clone()),
                                    id: id.clone(),
                                    mode: Some(id),
                                    model_id: None,
                                    reasoning_effort: None,
                                    is_native: true,
                                })
                            }));
                        parsed.configuration.collaboration_config_id = option_id;
                    }
                }
                "permission" | "permissions" => {
                    parsed
                        .permission_modes
                        .extend(choices.iter().filter_map(option_value));
                    parsed.configuration.permission_config_id = option_id;
                }
                _ => {}
            }
        }
    }

    // Grok exposes reasoning choices in a provider metadata extension rather
    // than ACP configOptions. Treat these as reasoning, not permissions.
    if let Some(entries) = result.get("metaOptions").and_then(Value::as_array) {
        let choices = entries
            .iter()
            .filter(|entry| entry.get("category").and_then(Value::as_str) == Some("mode"))
            .filter_map(|entry| {
                Some(json!({
                    "value": option_value(entry)?,
                    "label": string_field(entry, &["label", "name"]).unwrap_or_default(),
                }))
            })
            .collect::<Vec<_>>();
        if parsed.default_reasoning_effort.is_none() {
            parsed.default_reasoning_effort = entries
                .iter()
                .find(|entry| entry.get("selected").and_then(Value::as_bool) == Some(true))
                .and_then(option_value);
        }
        parsed
            .reasoning_efforts
            .extend(reasoning_options(Some(&Value::Array(choices))));
    }

    if let Some(modes) = result.get("modes") {
        let current = modes.get("currentModeId").and_then(Value::as_str);
        let choices = modes
            .get("availableModes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let effort_options = choices
            .iter()
            .filter_map(|entry| {
                Some(ReasoningEffortSummary {
                    reasoning_effort: entry.get("id").and_then(Value::as_str)?.to_string(),
                    description: string_field(entry, &["description", "name", "label"])
                        .unwrap_or_default(),
                })
            })
            .collect::<Vec<_>>();
        if looks_like_reasoning(&effort_options) {
            if parsed.default_reasoning_effort.is_none() {
                parsed.default_reasoning_effort = current.map(ToOwned::to_owned);
            }
            parsed.reasoning_efforts.extend(effort_options);
        } else if let Some(entries) = modes.get("availableModes").and_then(Value::as_array) {
            parsed
                .collaboration_modes
                .extend(entries.iter().filter_map(|entry| {
                    let id = entry.get("id").and_then(Value::as_str)?.to_string();
                    Some(CollaborationModeSummary {
                        label: string_field(entry, &["name", "label"])
                            .unwrap_or_else(|| id.clone()),
                        id: id.clone(),
                        mode: Some(id),
                        model_id: None,
                        reasoning_effort: None,
                        is_native: true,
                    })
                }));
        }
        if current_model_id.is_none() {
            let _ = current;
        }
    }

    parsed.reasoning_efforts = dedupe_reasoning_efforts(parsed.reasoning_efforts);
    parsed.permission_modes.sort();
    parsed.permission_modes.dedup();
    {
        let mut seen = HashSet::new();
        parsed
            .collaboration_modes
            .retain(|mode| seen.insert(mode.id.clone()));
    }
    let reasoning = parsed.reasoning_efforts.clone();
    let default_reasoning_effort = parsed.default_reasoning_effort.clone();
    parsed.models = dedupe_models(parsed.models.into_iter().map(|mut model| {
        if model.supported_reasoning_efforts.is_empty() {
            model.supported_reasoning_efforts = reasoning.clone();
        }
        if model.default_reasoning_effort.is_none() {
            model.default_reasoning_effort = default_reasoning_effort.clone();
        }
        if !model.is_default && current_model_id == Some(model.id.as_str()) {
            model.is_default = true;
        }
        model
    }));
    parsed
}

fn dedupe_reasoning_efforts(
    efforts: impl IntoIterator<Item = ReasoningEffortSummary>,
) -> Vec<ReasoningEffortSummary> {
    let mut seen = HashSet::new();
    efforts
        .into_iter()
        .filter(|effort| seen.insert(effort.reasoning_effort.clone()))
        .collect()
}

fn is_reasoning_mode_block(modes: &Value) -> bool {
    let entries = modes
        .get("availableModes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let options = entries
        .iter()
        .filter_map(|entry| {
            Some(ReasoningEffortSummary {
                reasoning_effort: entry.get("id").and_then(Value::as_str)?.to_string(),
                description: string_field(entry, &["description", "name", "label"])
                    .unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    looks_like_reasoning(&options)
}

/// Runs `cursor-agent --list-models` for the cursor provider. Current Cursor
/// publishes models over ACP; this probe is the fallback when that catalog is
/// empty. The spawn environment matches the agent process so the binary that
/// answers is the one FalconDeck launches. Failures are non-fatal.
async fn probe_cursor_cli_models(config: &AcpProviderConfig) -> Vec<ModelSummary> {
    let executable = resolve_agent_binary(&config.command[0], &config.command[0]).executable;
    let mut command = Command::new(&executable);
    apply_provider_environment(&mut command, &executable, &config.env).await;
    // Colorized ids would fail the model-line parse or, worse, round-trip
    // escape bytes into session model selection. Force plain output and
    // strip defensively anyway.
    command.env("NO_COLOR", "1");
    command.arg("--list-models");
    let output = match timeout(ACP_SETUP_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => output,
        Ok(Ok(output)) => {
            tracing::info!(
                provider = %config.id,
                code = output.status.code(),
                "cursor model list probe failed; leaving the model catalog to ACP"
            );
            return Vec::new();
        }
        Ok(Err(error)) => {
            tracing::info!(provider = %config.id, %error, "cursor model list probe could not run");
            return Vec::new();
        }
        Err(_) => {
            tracing::info!(provider = %config.id, "cursor model list probe timed out");
            return Vec::new();
        }
    };
    parse_cursor_cli_models(&String::from_utf8_lossy(&output.stdout))
}

/// Parses `cursor-agent --list-models` output: one `id - Display Name` line
/// per model, optionally annotated `(default)`, `(current)`, or `(NO ZDR)`.
/// Ids are kept verbatim — they encode effort and service variants
/// (`gpt-5.6-sol-medium`, `composer-2.5-fast`) that must round-trip to the
/// CLI unchanged when a session model is selected.
fn parse_cursor_cli_models(stdout: &str) -> Vec<ModelSummary> {
    let mut models: Vec<ModelSummary> = Vec::new();
    let mut default_index: Option<usize> = None;
    for line in stdout.lines() {
        let trimmed = strip_ansi(line.trim());
        let Some((id, name)) = trimmed.split_once(" - ") else {
            continue;
        };
        let id = id.trim();
        if id.is_empty() || id.split_whitespace().count() > 1 {
            continue;
        }
        // Annotations trail the display name as `(...)` segments — `(default)`,
        // `(current)`, `(NO ZDR)`, or combined `(current, default)`. They are
        // stripped from the label; a segment containing "default" marks the
        // catalog default.
        let (base, annotations) = match name.split_once('(') {
            Some((base, rest)) => (base.trim(), rest),
            None => (name.trim(), ""),
        };
        let is_default = annotations.contains("default");
        // The CLI lists its default model first; an explicit annotation wins.
        if is_default || default_index.is_none() {
            default_index = Some(models.len());
        }
        models.push(ModelSummary {
            id: id.to_string(),
            label: if base.is_empty() {
                id.to_string()
            } else {
                base.to_string()
            },
            is_default: false,
            default_reasoning_effort: None,
            supported_reasoning_efforts: Vec::new(),
            service_tiers: Vec::new(),
            default_service_tier: None,
        });
    }
    if let Some(index) = default_index
        && let Some(model) = models.get_mut(index)
    {
        model.is_default = true;
    }
    dedupe_models(models)
}

/// Removes ANSI escape sequences. cursor-agent honors FORCE_COLOR /
/// CLICOLOR_FORCE even with piped stdout, so `--list-models` can arrive
/// colorized despite `NO_COLOR=1`.
fn strip_ansi(line: &str) -> String {
    let mut cleaned = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            cleaned.push(c);
            continue;
        }
        if chars.next() != Some('[') {
            continue;
        }
        for inner in chars.by_ref() {
            if inner.is_ascii_alphabetic() {
                break;
            }
        }
    }
    cleaned
}

async fn apply_provider_environment(
    command: &mut Command,
    executable: &str,
    provider_env: &HashMap<String, String>,
) {
    let login_environment = desktop_login_shell_environment().await;
    command.envs(login_environment);
    if let Some(path) = preferred_command_path_with_environment(executable, login_environment) {
        command.env("PATH", path);
    }
    // Explicit provider configuration remains authoritative over both the
    // daemon and login-shell environments.
    command.envs(provider_env);
}

impl AcpRuntime {
    /// Spawns the agent command and completes the `initialize` handshake.
    pub async fn connect(
        config: AcpProviderConfig,
        workspace_path: &str,
        events: mpsc::UnboundedSender<AcpEvent>,
    ) -> Result<Arc<Self>, DaemonError> {
        let executable = resolve_agent_binary(&config.command[0], &config.command[0]).executable;
        let mut command = Command::new(&executable);
        apply_provider_environment(&mut command, &executable, &config.env).await;
        strip_terminal_advertising_env(&mut command);
        for (key, value) in crate::connectors::MCP_CLI_TIMEOUT_ENV {
            command.env(*key, *value);
        }
        command
            .args(&config.command[1..])
            .current_dir(workspace_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().map_err(|error| {
            DaemonError::Process(format!(
                "failed to start ACP provider '{}' ({}): {error}",
                config.id, executable
            ))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| DaemonError::Process("ACP child process has no stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| DaemonError::Process("ACP child process has no stdout".to_string()))?;
        let stderr = child.stderr.take();

        let runtime = Arc::new(Self {
            provider: AgentProvider::new(config.id.clone()),
            config,
            workspace_path: workspace_path.to_string(),
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            threads_by_session: Mutex::new(HashMap::new()),
            session_gates: Mutex::new(HashMap::new()),
            permission_requests: Mutex::new(HashMap::new()),
            plan_approval_requests: Mutex::new(HashMap::new()),
            question_requests: Mutex::new(HashMap::new()),
            current_items: Mutex::new(HashMap::new()),
            current_thought_items: Mutex::new(HashMap::new()),
            current_user_items: Mutex::new(HashMap::new()),
            current_plan_items: Mutex::new(HashMap::new()),
            current_tools: Mutex::new(HashMap::new()),
            stderr_tail: Mutex::new(VecDeque::new()),
            session_modes: Mutex::new(HashMap::new()),
            session_configurations: Mutex::new(HashMap::new()),
            session_reasoning_efforts: Mutex::new(HashMap::new()),
            discovered_models: Mutex::new(Vec::new()),
            cli_models_probed: AtomicBool::new(false),
            discovered_permission_modes: Mutex::new(Vec::new()),
            discovered_collaboration_modes: Mutex::new(Vec::new()),
            discovery_gate: Mutex::new(()),
            metadata_discovered: AtomicBool::new(false),
            reported_update_kinds: Mutex::new(HashSet::new()),
            turn_failure_details: Mutex::new(HashMap::new()),
            prompt_stderr_errors: Mutex::new(HashMap::new()),
            initialize_result: Mutex::new(None),
            supports_interject: AtomicBool::new(false),
            steer_queues: Mutex::new(HashMap::new()),
            prompt_sessions: Mutex::new(HashSet::new()),
            prompt_output_sessions: Mutex::new(HashSet::new()),
            replay_sessions: Mutex::new(HashSet::new()),
            closed: AtomicBool::new(false),
            events,
        });

        tokio::spawn(Self::read_loop(Arc::clone(&runtime), stdout));
        if let Some(stderr) = stderr {
            tokio::spawn(Self::stderr_loop(Arc::clone(&runtime), stderr));
        }

        let init = match runtime
            .request_with_timeout(
                "initialize",
                json!({
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": {
                        "name": "falcondeck",
                        "title": "FalconDeck",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
                ACP_SETUP_TIMEOUT,
            )
            .await
        {
            Ok(result) => result,
            Err(error @ DaemonError::AcpRequestTimeout { .. }) => {
                runtime.closed.store(true, Ordering::Release);
                let _ = runtime.child.lock().await.kill().await;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let negotiated_version = init.get("protocolVersion").and_then(Value::as_u64);
        if negotiated_version != Some(ACP_PROTOCOL_VERSION) {
            runtime.closed.store(true, Ordering::Release);
            let _ = runtime.child.lock().await.kill().await;
            return Err(DaemonError::Rpc(format!(
                "ACP provider '{}' negotiated unsupported protocol version {} (FalconDeck supports {})",
                runtime.config.id,
                negotiated_version
                    .map_or_else(|| "missing".to_string(), |version| version.to_string()),
                ACP_PROTOCOL_VERSION
            )));
        }
        let init_models = parse_initialize_models(&init);
        *runtime.initialize_result.lock().await = Some(init.clone());
        if !init_models.is_empty() {
            *runtime.discovered_models.lock().await = init_models;
        }
        if let Some(method_id) = silent_acp_auth_method(&init)
            && let Err(error) = runtime
                .request_with_timeout(
                    "authenticate",
                    json!({ "methodId": method_id }),
                    ACP_SETUP_TIMEOUT,
                )
                .await
        {
            // Cursor's `cursor_login` reuses CLI credentials; a failure here
            // is usually "already signed in" or a stale token. session/new
            // is the real gate — failing connect on this would hide adapters
            // that work without an explicit authenticate call.
            tracing::info!(
                provider = %runtime.config.id,
                method = %method_id,
                %error,
                "ACP authenticate failed; continuing with existing credentials"
            );
        }
        if acp_may_support_interject(runtime.provider.as_str()) {
            let outcome = runtime
                .request_with_timeout(
                    "x.ai/interject",
                    json!({
                        "sessionId": "falcondeck-capability-probe",
                        "text": "probe",
                        "content": [{ "type": "text", "text": "probe" }],
                    }),
                    ACP_SETUP_TIMEOUT,
                )
                .await;
            let supported = acp_interject_probe_supported(&outcome);
            runtime
                .supports_interject
                .store(supported, Ordering::Release);
        }
        Ok(runtime)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Whether `session/new` discovery has already answered for this process.
    /// A live runtime whose first attempt failed keeps its placeholder catalog
    /// until something retries, so callers reusing a cached runtime check this
    /// instead of assuming the catalog was published.
    pub fn metadata_discovered(&self) -> bool {
        self.metadata_discovered.load(Ordering::Acquire)
    }

    /// Whether the agent negotiated `loadSession` support.
    pub async fn supports_load_session(&self) -> bool {
        self.initialize_result
            .lock()
            .await
            .as_ref()
            .and_then(|init| init.pointer("/agentCapabilities/loadSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// Capability summary refined from the `initialize` handshake, replacing
    /// the pre-connection `acp_minimal()` placeholder on the agent entry.
    pub async fn capability_summary(&self) -> falcondeck_core::AgentCapabilitySummary {
        let init = self.initialize_result.lock().await;
        let advertised_images = init
            .as_ref()
            .and_then(|init| init.pointer("/agentCapabilities/promptCapabilities/image"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let supports_images = acp_supports_images(self.provider.as_str(), advertised_images);
        let discovered_permission_modes = self.discovered_permission_modes.lock().await.clone();
        let permission_modes = if discovered_permission_modes.is_empty() {
            placeholder_permission_modes_for(self.provider.as_str())
        } else {
            discovered_permission_modes
        };
        falcondeck_core::AgentCapabilitySummary {
            supports_interrupt: true,
            supports_images,
            // Every ACP agent is steerable: the ACP contract requires
            // `session/cancel` to settle the in-flight prompt, and the prompt
            // loop re-prompts on the same session with the steer input. Grok's
            // probed `x.ai/interject` remains the preferred path because it
            // injects without discarding in-flight work.
            supports_steering: true,
            permission_modes,
            ..falcondeck_core::AgentCapabilitySummary::default()
        }
    }

    /// Models advertised by the provider. ACP model catalogs are commonly
    /// returned from session/new rather than initialize, so the discovered
    /// catalog wins and initialize remains a compatibility fallback.
    pub async fn advertised_models(&self) -> Vec<ModelSummary> {
        let discovered = self.discovered_models.lock().await.clone();
        if !discovered.is_empty() {
            return discovered;
        }
        let init = self.initialize_result.lock().await;
        if let Some(models) = init.as_ref().map(parse_initialize_models)
            && !models.is_empty()
        {
            return models;
        }
        drop(init);
        // Older Cursor builds published no model catalog over ACP. Probe the
        // CLI until a probe succeeds. Current builds advertise parameterized
        // ACP ids on session/new, which win above and never reach this path.
        if self.config.id.eq_ignore_ascii_case("cursor")
            && !self.cli_models_probed.load(Ordering::Acquire)
        {
            let models = probe_cursor_cli_models(&self.config).await;
            if !models.is_empty() {
                // Latch only on success: a probe that ran before login
                // completed stays retriable on later calls. Two concurrent
                // callers may both probe — the invocation is idempotent,
                // read-only, and timeout-bounded.
                self.cli_models_probed.store(true, Ordering::Release);
                *self.discovered_models.lock().await = models.clone();
                return models;
            }
        }
        Vec::new()
    }

    pub async fn advertised_collaboration_modes(&self) -> Vec<CollaborationModeSummary> {
        self.discovered_collaboration_modes.lock().await.clone()
    }

    /// Opens one short-lived ACP session to discover model, reasoning, and
    /// permission configuration. ACP clients cannot populate a model picker
    /// from initialize alone because many agents only publish these options
    /// in the session/new result.
    pub async fn ensure_workspace_metadata(
        &self,
        cwd: &str,
        builtin: &crate::connectors::BuiltinConnectors,
    ) -> Result<(), DaemonError> {
        if self.metadata_discovered.load(Ordering::Acquire) {
            return Ok(());
        }
        let _gate = self.discovery_gate.lock().await;
        if self.metadata_discovered.load(Ordering::Acquire) {
            return Ok(());
        }
        let mcp_servers = crate::connectors::acp_mcp_servers(
            &crate::connectors::with_builtin_servers(
                crate::connectors::materialize_mcp_servers(&self.workspace_path, &self.config.id)
                    .await,
                builtin,
            ),
            self.supports_http_mcp().await,
        );
        let result = self
            .request_with_timeout(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": mcp_servers }),
                ACP_SETUP_TIMEOUT,
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                DaemonError::Rpc("ACP discovery session returned no sessionId".to_string())
            })?
            .to_string();
        self.capture_session_metadata(&session_id, &result).await;
        if self.supports_session_delete().await {
            let _ = self
                .request("session/delete", json!({ "sessionId": session_id }))
                .await;
        }
        self.metadata_discovered.store(true, Ordering::Release);
        Ok(())
    }

    async fn supports_session_delete(&self) -> bool {
        capability_enabled(
            self.initialize_result
                .lock()
                .await
                .as_ref()
                .and_then(|init| init.pointer("/agentCapabilities/sessionCapabilities/delete")),
        )
    }

    async fn supports_http_mcp(&self) -> bool {
        capability_enabled(
            self.initialize_result
                .lock()
                .await
                .as_ref()
                .and_then(|init| init.pointer("/agentCapabilities/mcpCapabilities/http")),
        )
    }

    async fn capture_session_metadata(&self, session_id: &str, result: &Value) {
        let parsed = parse_session_metadata(result);
        let mut models = self.discovered_models.lock().await;
        if !parsed.models.is_empty() {
            *models = dedupe_models(parsed.models.clone());
        }
        drop(models);
        if !parsed.permission_modes.is_empty() {
            *self.discovered_permission_modes.lock().await = parsed.permission_modes.clone();
        }
        if !parsed.collaboration_modes.is_empty() {
            *self.discovered_collaboration_modes.lock().await = parsed.collaboration_modes.clone();
        }
        // `session/load` commonly returns null after replaying updates. Do not
        // let that empty response erase configuration learned from an earlier
        // config_option_update notification during the replay.
        if !parsed.configuration.is_empty() {
            self.session_configurations
                .lock()
                .await
                .insert(session_id.to_string(), parsed.configuration);
        }
        if !parsed.reasoning_efforts.is_empty() {
            self.session_reasoning_efforts.lock().await.insert(
                session_id.to_string(),
                parsed
                    .reasoning_efforts
                    .iter()
                    .map(|effort| effort.reasoning_effort.clone())
                    .collect(),
            );
        }
        if let Some(modes) = result.get("modes")
            && !is_reasoning_mode_block(modes)
        {
            self.capture_session_modes(session_id, Some(modes)).await;
        }
    }

    async fn write_message(&self, message: &Value) -> Result<(), DaemonError> {
        let mut line = serde_json::to_string(message)
            .map_err(|error| DaemonError::Process(format!("ACP encode failed: {error}")))?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|error| DaemonError::Process(format!("ACP write failed: {error}")))?;
        stdin
            .flush()
            .await
            .map_err(|error| DaemonError::Process(format!("ACP flush failed: {error}")))
    }

    /// Sends a JSON-RPC request and awaits its response.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, DaemonError> {
        self.request_inner(method, params, None).await
    }

    /// Sends a JSON-RPC request with a cancellation-safe response deadline.
    ///
    /// Removing the pending sender on timeout matters for long-lived agent
    /// processes: otherwise every missed response remains retained until the
    /// process exits, and a late response can appear to resolve live work.
    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        response_timeout: Duration,
    ) -> Result<Value, DaemonError> {
        self.request_inner(method, params, Some(response_timeout))
            .await
    }

    /// Writes a request and returns the pending-response receiver without
    /// awaiting it, so a caller can interleave other traffic (a steer's
    /// `session/cancel`) between issue and settlement.
    async fn begin_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(i64, oneshot::Receiver<Result<Value, DaemonError>>), DaemonError> {
        if self.is_closed() {
            return Err(DaemonError::Process(format!(
                "ACP provider '{}' is not running",
                self.config.id
            )));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write_message(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params
            }))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        Ok((id, receiver))
    }

    async fn request_inner(
        &self,
        method: &str,
        params: Value,
        response_timeout: Option<Duration>,
    ) -> Result<Value, DaemonError> {
        let (id, receiver) = self.begin_request(method, params).await?;
        let response = if let Some(response_timeout) = response_timeout {
            match timeout(response_timeout, receiver).await {
                Ok(response) => response,
                Err(_) => {
                    self.pending.lock().await.remove(&id);
                    return Err(DaemonError::AcpRequestTimeout {
                        provider: self.config.id.clone(),
                        method: method.to_string(),
                        timeout_seconds: response_timeout.as_secs(),
                    });
                }
            }
        } else {
            receiver.await
        };
        response.map_err(|_| {
            DaemonError::Process(format!(
                "ACP provider '{}' closed mid-request",
                self.config.id
            ))
        })?
    }

    /// Sends a JSON-RPC notification (no response expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), DaemonError> {
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    /// Folder this runtime's workspace lives in. Threads running in an
    /// isolated variant pass their own cwd into `ensure_session` instead.
    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    /// Returns the ACP session id for a thread, creating a session on demand.
    ///
    /// When the thread carries a native session id from a previous daemon run
    /// and the agent negotiated `loadSession`, the session is resumed with
    /// `session/load` — the agent replays the conversation through
    /// `session/update` notifications, which repopulates the (empty after
    /// restart) in-memory thread history. If the persisted session is truly
    /// unavailable, the serialized caller falls back to a fresh session.
    #[allow(clippy::too_many_arguments)]
    pub async fn ensure_session(
        &self,
        thread_id: &str,
        known_native_session: Option<&str>,
        cwd: &str,
        permission_mode: Option<&str>,
        builtin: &crate::connectors::BuiltinConnectors,
        agent_context: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<String, DaemonError> {
        let gate = self.session_gate(thread_id).await;
        let _guard = gate.lock().await;
        if let Some(existing) = self.sessions.lock().await.get(thread_id) {
            return Ok(existing.clone());
        }
        let mcp_servers = crate::connectors::acp_mcp_servers(
            &crate::connectors::with_builtin_servers(
                crate::connectors::materialize_mcp_servers(&self.workspace_path, &self.config.id)
                    .await,
                builtin,
            ),
            self.supports_http_mcp().await,
        );

        if let Some(native_session) = known_native_session
            .map(str::trim)
            .filter(|id| !id.is_empty())
            && self.supports_load_session().await
        {
            match self
                .load_session_locked(thread_id, native_session, cwd, builtin)
                .await
            {
                Ok(()) => return Ok(native_session.to_string()),
                Err(error) => {
                    tracing::info!(
                        provider = %self.config.id,
                        %error,
                        "ACP session/load failed; starting a fresh session"
                    );
                }
            }
        }

        let mut params = json!({ "cwd": cwd, "mcpServers": mcp_servers });
        // Session instructions carry the FalconDeck agent context. Sent only
        // when present so agents that predate the field are unaffected, and
        // only on session/new: a loaded session already carries the
        // instructions from its original creation.
        if let Some(instructions) = agent_context.map(str::trim).filter(|text| !text.is_empty()) {
            params["instructions"] = json!(instructions);
        }
        if self.provider.as_str().eq_ignore_ascii_case("grok")
            && let Some(meta) = grok_session_new_meta(model_id, permission_mode)
        {
            params["_meta"] = meta;
        }
        let result = self
            .request_with_timeout("session/new", params, ACP_SESSION_START_TIMEOUT)
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| DaemonError::Rpc("ACP session/new returned no sessionId".to_string()))?
            .to_string();
        self.register_session(thread_id, &session_id).await;
        self.capture_session_metadata(&session_id, &result).await;
        Ok(session_id)
    }

    /// Resumes a persisted session with `session/load`, replaying its history
    /// through the event pump. Unlike [`Self::ensure_session`] there is no
    /// fresh-session fallback: a failure leaves the runtime untouched so a
    /// later turn can retry (or fall back) itself. Used both by the turn path
    /// and to rehydrate a restored thread's transcript when it is opened.
    pub async fn load_session(
        &self,
        thread_id: &str,
        native_session: &str,
        cwd: &str,
        builtin: &crate::connectors::BuiltinConnectors,
    ) -> Result<(), DaemonError> {
        let gate = self.session_gate(thread_id).await;
        let _guard = gate.lock().await;
        if self.sessions.lock().await.contains_key(thread_id) {
            return Ok(());
        }
        self.load_session_locked(thread_id, native_session, cwd, builtin)
            .await
    }

    /// Ensures that `thread_id` is attached to this exact persisted session.
    ///
    /// Explicit interrupted-turn recovery must never inherit
    /// [`Self::ensure_session`]'s fresh-session fallback: if the provider can
    /// no longer load the saved session, starting a replacement would turn a
    /// visible recovery action into a context-free conversation while also
    /// overwriting the only durable join key FalconDeck has.
    pub async fn ensure_loaded_session(
        &self,
        thread_id: &str,
        native_session: &str,
        cwd: &str,
        builtin: &crate::connectors::BuiltinConnectors,
    ) -> Result<String, DaemonError> {
        let gate = self.session_gate(thread_id).await;
        let _guard = gate.lock().await;
        if let Some(existing) = self.sessions.lock().await.get(thread_id).cloned() {
            return if existing == native_session {
                Ok(existing)
            } else {
                Err(DaemonError::BadRequest(format!(
                    "ACP thread is attached to session {existing}, not its persisted session {native_session}"
                )))
            };
        }
        self.load_session_locked(thread_id, native_session, cwd, builtin)
            .await?;
        Ok(native_session.to_string())
    }

    async fn load_session_locked(
        &self,
        thread_id: &str,
        native_session: &str,
        cwd: &str,
        builtin: &crate::connectors::BuiltinConnectors,
    ) -> Result<(), DaemonError> {
        if !self.supports_load_session().await {
            return Err(DaemonError::Process(format!(
                "ACP provider '{}' does not support session/load",
                self.config.id
            )));
        }
        let mcp_servers = crate::connectors::acp_mcp_servers(
            &crate::connectors::with_builtin_servers(
                crate::connectors::materialize_mcp_servers(&self.workspace_path, &self.config.id)
                    .await,
                builtin,
            ),
            self.supports_http_mcp().await,
        );
        // The agent replays the conversation as session/update
        // notifications DURING the session/load request, so the
        // session→thread mapping must exist before the request goes out
        // or the event pump drops the entire replayed history.
        //
        // RepoPrompt suppresses that replay because it persists its own
        // transcript. FalconDeck has no conversation DB: ingesting replay
        // is how a restored thread gets its items back. The app layer
        // skips load when items already exist so this does not duplicate.
        self.register_session(thread_id, native_session).await;
        // Bracket the replay on the ordered event channel. The read loop
        // handles every replayed notification before it resolves this
        // request's response, so ReplayStarted (enqueued before the request
        // is even written) and ReplayFinished (enqueued after the response)
        // are guaranteed to surround the replayed history at the pump.
        let _ = self.events.send(AcpEvent::ReplayStarted {
            session_id: native_session.to_string(),
        });
        self.replay_sessions
            .lock()
            .await
            .insert(native_session.to_string());
        let loaded = self
            .request_with_timeout(
                "session/load",
                json!({
                    "sessionId": native_session,
                    "cwd": cwd,
                    "mcpServers": mcp_servers
                }),
                ACP_SESSION_START_TIMEOUT,
            )
            .await;
        self.replay_sessions.lock().await.remove(native_session);
        let _ = self.events.send(AcpEvent::ReplayFinished {
            session_id: native_session.to_string(),
        });
        match loaded {
            Ok(result) => {
                self.capture_session_metadata(native_session, &result).await;
                Ok(())
            }
            Err(error) => {
                self.unregister_session(thread_id, native_session).await;
                Err(error)
            }
        }
    }

    async fn session_gate(&self, thread_id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.session_gates.lock().await;
        Arc::clone(
            gates
                .entry(thread_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    /// The ACP session id currently registered for a thread, if any.
    pub async fn session_for_thread(&self, thread_id: &str) -> Option<String> {
        self.sessions.lock().await.get(thread_id).cloned()
    }

    /// Drops a thread's session mapping so `session/load` can replay again.
    ///
    /// Used when a restore registered the session but the in-memory transcript
    /// was lost (a workspace rebuild after replay) or never landed.
    pub async fn forget_session(&self, thread_id: &str) {
        let session_id = self.sessions.lock().await.remove(thread_id);
        if let Some(session_id) = session_id {
            self.threads_by_session.lock().await.remove(&session_id);
        }
    }

    /// Records the modes block from a session/new or session/load response.
    async fn capture_session_modes(&self, session_id: &str, modes: Option<&Value>) {
        let Some(modes) = modes else { return };
        if is_reasoning_mode_block(modes) {
            return;
        }
        let current = modes
            .get("currentModeId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let available = modes
            .get("availableModes")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if current.is_none() && available.is_empty() {
            return;
        }
        self.session_modes.lock().await.insert(
            session_id.to_string(),
            SessionModeState { current, available },
        );
    }

    /// Mode state for a session, when the agent advertised any.
    pub async fn session_mode_state(&self, session_id: &str) -> Option<SessionModeState> {
        self.session_modes.lock().await.get(session_id).cloned()
    }

    /// Whether this existing session exposes a protocol method for changing
    /// its permission mode. Some adapters (notably Grok) only accept this as
    /// `session/new` metadata and cannot change it after the session starts.
    pub async fn supports_session_permission_updates(&self, session_id: &str) -> bool {
        self.session_configurations
            .lock()
            .await
            .get(session_id)
            .is_some_and(|configuration| configuration.permission_config_id.is_some())
    }

    /// Switches the session's mode via `session/set_mode`.
    pub async fn set_session_mode(
        &self,
        session_id: &str,
        mode_id: &str,
    ) -> Result<(), DaemonError> {
        // Bounded: these run inside turn start, where an unresponsive adapter
        // would otherwise leave the thread stuck Running forever.
        self.request_with_timeout(
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": mode_id }),
            ACP_SETUP_TIMEOUT,
        )
        .await?;
        if let Some(state) = self.session_modes.lock().await.get_mut(session_id) {
            state.current = Some(mode_id.to_string());
        }
        Ok(())
    }

    async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<(), DaemonError> {
        let result = self
            .request_with_timeout(
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": value }),
                ACP_SETUP_TIMEOUT,
            )
            .await?;
        // The response is authoritative and may change dependent model or
        // reasoning options, not merely the selected value.
        self.capture_session_metadata(session_id, &result).await;
        Ok(())
    }

    /// Applies the normalized model/reasoning choices to an ACP session. New
    /// ACP agents generally use session/set_config_option; the legacy methods
    /// remain as fallbacks for older adapters.
    pub async fn apply_session_preferences(
        &self,
        session_id: &str,
        model_id: Option<&str>,
        reasoning_effort: Option<&str>,
        collaboration_mode: Option<&str>,
        permission_mode: Option<&str>,
    ) -> Result<(), DaemonError> {
        let configuration = self
            .session_configurations
            .lock()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        if let Some(model_id) = model_id {
            if let Some(config_id) = configuration.model_config_id.as_deref() {
                self.set_config_option(session_id, config_id, model_id)
                    .await?;
            } else {
                self.request_with_timeout(
                    "session/set_model",
                    json!({ "sessionId": session_id, "modelId": model_id }),
                    ACP_SETUP_TIMEOUT,
                )
                .await?;
            }
        }
        // OpenCode only publishes its effort option once a model that has
        // reasoning variants is selected, and the set_config_option response
        // above carries it. Re-read rather than reuse the snapshot taken
        // before the model switch, or the effort is silently dropped.
        let configuration = self
            .session_configurations
            .lock()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or(configuration);
        if let Some(reasoning_effort) = reasoning_effort
            && let Some(config_id) = configuration.reasoning_config_id.as_deref()
        {
            let supported = self
                .session_reasoning_efforts
                .lock()
                .await
                .get(session_id)
                .cloned()
                .unwrap_or_default();
            // Efforts are per model: a thread carrying `medium` onto a model
            // that only offers low/high/max would fail the whole turn.
            if supported.is_empty() || supported.iter().any(|effort| effort == reasoning_effort) {
                self.set_config_option(session_id, config_id, reasoning_effort)
                    .await?;
            } else {
                tracing::info!(
                    provider = %self.config.id,
                    %reasoning_effort,
                    "session does not offer this reasoning effort; keeping its current level"
                );
            }
        }
        if let Some(collaboration_mode) = collaboration_mode {
            if let Some(config_id) = configuration.collaboration_config_id.as_deref() {
                self.set_config_option(session_id, config_id, collaboration_mode)
                    .await?;
            } else if let Some(state) = self.session_mode_state(session_id).await
                && state
                    .available
                    .iter()
                    .any(|mode| mode == collaboration_mode)
                && state.current.as_deref() != Some(collaboration_mode)
            {
                self.set_session_mode(session_id, collaboration_mode)
                    .await?;
            }
        }
        if let Some(permission_mode) = permission_mode {
            if let Some(config_id) = configuration.permission_config_id.as_deref() {
                self.set_config_option(session_id, config_id, permission_mode)
                    .await?;
            } else if let Some(state) = self.session_mode_state(session_id).await
                && state.available.iter().any(|mode| mode == permission_mode)
                && state.current.as_deref() != Some(permission_mode)
            {
                self.set_session_mode(session_id, permission_mode).await?;
            }
        }
        Ok(())
    }

    async fn register_session(&self, thread_id: &str, session_id: &str) {
        self.sessions
            .lock()
            .await
            .insert(thread_id.to_string(), session_id.to_string());
        self.threads_by_session
            .lock()
            .await
            .insert(session_id.to_string(), thread_id.to_string());
    }

    /// Rolls back an eager registration after a failed `session/load`, so a
    /// stale mapping cannot swallow events from an unrelated future session.
    async fn unregister_session(&self, thread_id: &str, session_id: &str) {
        self.sessions.lock().await.remove(thread_id);
        self.threads_by_session.lock().await.remove(session_id);
    }

    /// Resolves the FalconDeck thread owning an ACP session id.
    pub async fn thread_for_session(&self, session_id: &str) -> Option<String> {
        self.threads_by_session
            .lock()
            .await
            .get(session_id)
            .cloned()
    }

    async fn begin_prompt_segment(&self, session_id: &str) {
        self.prompt_sessions
            .lock()
            .await
            .insert(session_id.to_string());
        self.prompt_output_sessions.lock().await.remove(session_id);
        self.prompt_stderr_errors.lock().await.remove(session_id);
    }

    async fn wait_for_prompt_stderr(&self, session_id: &str) {
        // The JSON-RPC response can beat the stderr pipe. Yield and poll so
        // empty-turn diagnostics see the error line when it is already
        // queued.
        tokio::task::yield_now().await;
        let deadline = Instant::now() + ACP_STDERR_DRAIN;
        loop {
            if self
                .prompt_stderr_errors
                .lock()
                .await
                .contains_key(session_id)
            {
                return;
            }
            if Instant::now() >= deadline {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn finish_prompt_segment(
        &self,
        session_id: &str,
        stop_reason: Option<String>,
        error: Option<String>,
    ) {
        let had_output = self.prompt_output_sessions.lock().await.remove(session_id);
        self.prompt_sessions.lock().await.remove(session_id);
        let _ = self.events.send(AcpEvent::TurnEnded {
            session_id: session_id.to_string(),
            stop_reason,
            error,
            had_output,
        });
    }

    async fn session_accepts_turn_content(&self, session_id: &str) -> bool {
        self.prompt_sessions.lock().await.contains(session_id)
            || self.replay_sessions.lock().await.contains(session_id)
    }

    async fn note_prompt_output(&self, session_id: &str) {
        if self.prompt_sessions.lock().await.contains(session_id) {
            self.prompt_output_sessions
                .lock()
                .await
                .insert(session_id.to_string());
        }
    }

    /// Runs one prompt turn; resolves when the agent reports a stop reason.
    ///
    /// A turn is a loop of `session/prompt` requests on the same session: a
    /// steer ([`Self::steer_with_cancel`]) cancels the in-flight prompt and
    /// queues its input, and this loop delivers the queued input as the next
    /// prompt — so the steer lands inside the same logical turn. Each settled
    /// prompt emits its own `TurnEnded` so the app layer settles that
    /// segment's items (a cancelled segment's tools read as interrupted, and
    /// the steer's reply starts fresh stream items); the returned stop reason
    /// is the final segment's.
    ///
    /// The turn-ended marker is delivered through the event channel rather
    /// than handled here: the channel already holds every delta the agent
    /// wrote before its response, so ordering the reset behind them prevents
    /// a late chunk from starting a fresh assistant item.
    /// Sends a turn as ACP content blocks (text and, when the agent supports
    /// them, images).
    pub async fn prompt(
        &self,
        session_id: &str,
        content: Vec<Value>,
    ) -> Result<String, DaemonError> {
        let mut content = if content.is_empty() {
            vec![json!({ "type": "text", "text": "[empty prompt]" })]
        } else {
            content
        };
        self.steer_queues.lock().await.insert(
            session_id.to_string(),
            SteerQueue {
                current: content.clone(),
                ..SteerQueue::default()
            },
        );
        loop {
            // A detail left over from an earlier prompt must not masquerade
            // as this one's cause.
            self.turn_failure_details.lock().await.remove(session_id);
            self.begin_prompt_segment(session_id).await;
            let begun = self
                .begin_request(
                    "session/prompt",
                    json!({
                        "sessionId": session_id,
                        "prompt": content
                    }),
                )
                .await;
            if begun.is_ok() {
                // A steer that stacked behind the previous, already-cancelled
                // prompt still needs its own cancel; otherwise this prompt
                // runs to completion before the queued input lands.
                let stacked = {
                    let mut queues = self.steer_queues.lock().await;
                    queues.get_mut(session_id).is_some_and(|queue| {
                        let stacked = !queue.queued.is_empty();
                        if stacked {
                            queue.cancel_requested = true;
                        }
                        stacked
                    })
                };
                if stacked {
                    let _ = self.send_cancel(session_id).await;
                }
            }
            let result = match begun {
                Ok((_, receiver)) => receiver
                    .await
                    .map_err(|_| {
                        DaemonError::Process(format!(
                            "ACP provider '{}' closed mid-request",
                            self.config.id
                        ))
                    })
                    .and_then(|response| response),
                Err(error) => Err(error),
            };
            // The prompt is over; any reverse request the agent left
            // unanswered can never be acted on, so retire it rather than
            // retaining dead state.
            self.cancel_pending_permissions(session_id).await;
            self.cancel_pending_plan_approvals(session_id).await;
            self.cancel_pending_questions(session_id).await;
            // The read loop delivers messages in order, so a vendor failure
            // notice written before the error response is already recorded.
            let result = match result {
                Err(error) => {
                    let detail = self.turn_failure_details.lock().await.remove(session_id);
                    Err(match detail {
                        Some(detail) if !error.to_string().contains(&detail) => {
                            DaemonError::Rpc(format!("{} ({})", detail, self.config.id))
                        }
                        _ => error,
                    })
                }
                ok => ok,
            };
            let response = match result {
                Err(error) => {
                    // A failed prompt ends the whole turn: queued steers must
                    // not restart the loop against a session in an unknown
                    // state.
                    self.steer_queues.lock().await.remove(session_id);
                    self.finish_prompt_segment(session_id, None, Some(error.to_string()))
                        .await;
                    return Err(error);
                }
                Ok(response) => response,
            };
            let stop_reason = response
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn")
                .to_string();
            let had_output = self
                .prompt_output_sessions
                .lock()
                .await
                .contains(session_id);
            let empty_diagnostic =
                if !had_output && is_successful_empty_prompt_stop_reason(&stop_reason) {
                    self.wait_for_prompt_stderr(session_id).await;
                    let stderr = self.prompt_stderr_errors.lock().await.remove(session_id);
                    let is_opencode = self.config.id.eq_ignore_ascii_case("opencode");
                    if stderr.is_some()
                        || (is_opencode && prompt_usage_indicates_no_model_tokens(&response))
                    {
                        Some(empty_acp_prompt_diagnostic(
                            &stop_reason,
                            &response,
                            stderr.as_deref(),
                        ))
                    } else {
                        None
                    }
                } else {
                    self.prompt_stderr_errors.lock().await.remove(session_id);
                    None
                };
            // Shift the queue regardless of the stop reason: a steer that
            // raced with normal completion is still delivered, as a follow-up
            // prompt in the same turn.
            let next = {
                let mut queues = self.steer_queues.lock().await;
                queues.get_mut(session_id).and_then(|queue| {
                    queue.cancel_requested = false;
                    if queue.stopping {
                        None
                    } else {
                        queue.queued.pop_front()
                    }
                })
            };
            self.finish_prompt_segment(session_id, Some(stop_reason.clone()), empty_diagnostic)
                .await;
            match next {
                Some(next_content) => {
                    let mut queues = self.steer_queues.lock().await;
                    if let Some(queue) = queues.get_mut(session_id) {
                        if stop_reason == "cancelled" {
                            if !queue.current.is_empty() {
                                queue.interrupted.push(std::mem::take(&mut queue.current));
                            }
                            queue.current = next_content.clone();
                            content = bundle_cancelled_acp_prompt(&queue.interrupted, next_content);
                        } else {
                            queue.interrupted.clear();
                            queue.current = next_content.clone();
                            content = next_content;
                        }
                    } else {
                        content = next_content;
                    }
                }
                None => {
                    self.steer_queues.lock().await.remove(session_id);
                    return Ok(stop_reason);
                }
            }
        }
    }

    /// Steers the session's active turn without a vendor extension: queues
    /// the content and cancels the in-flight prompt; the prompt loop then
    /// delivers the queued content as the next `session/prompt` on the same
    /// session, continuing the same logical turn. Works with any ACP agent —
    /// the protocol requires `session/cancel` to settle the active prompt.
    /// Unlike Grok's interject this discards the cancelled prompt's
    /// in-flight work, which is why the vendor path stays preferred. The
    /// prompt loop re-bundles that cancelled user text with the steer: some
    /// providers drop it from their own history after `session/cancel`.
    pub async fn steer_with_cancel(
        &self,
        session_id: &str,
        content: Vec<Value>,
    ) -> Result<(), DaemonError> {
        let content = if content.is_empty() {
            vec![json!({ "type": "text", "text": "[empty prompt]" })]
        } else {
            content
        };
        let should_cancel = {
            let mut queues = self.steer_queues.lock().await;
            let Some(queue) = queues.get_mut(session_id) else {
                return Err(DaemonError::BadRequest(
                    "no active ACP turn to steer".to_string(),
                ));
            };
            if queue.stopping {
                return Err(DaemonError::BadRequest(
                    "the turn is being interrupted".to_string(),
                ));
            }
            queue.queued.push_back(content);
            !std::mem::replace(&mut queue.cancel_requested, true)
        };
        if should_cancel {
            self.send_cancel(session_id).await?;
        }
        Ok(())
    }

    /// Whether the live process answered the vendor interjection probe
    /// (Grok's `x.ai/interject`). When false, steering goes through
    /// [`Self::steer_with_cancel`] instead.
    pub fn supports_interject(&self) -> bool {
        self.supports_interject.load(Ordering::Acquire)
    }

    /// Injects content into Grok's running ACP turn using its vendor
    /// `x.ai/interject` extension.
    pub async fn interject(
        &self,
        session_id: &str,
        text: &str,
        content: Vec<Value>,
    ) -> Result<(), DaemonError> {
        if !self.supports_interject() {
            return Err(DaemonError::BadRequest(format!(
                "ACP provider '{}' does not support vendor interjection",
                self.provider
            )));
        }
        self.request(
            "x.ai/interject",
            json!({
                "sessionId": session_id,
                "text": text,
                "content": content,
            }),
        )
        .await?;
        Ok(())
    }

    /// Appends assistant text for the session's current turn, creating the
    /// turn's item on first delta. Returns the item id and full text so far.
    pub async fn append_assistant_text(
        &self,
        session_id: &str,
        message_id: Option<&str>,
        chunk: &str,
    ) -> (String, String) {
        self.current_user_items.lock().await.remove(session_id);
        self.current_thought_items.lock().await.remove(session_id);
        let mut items = self.current_items.lock().await;
        let requested_id = message_id.map(|id| format!("acp-msg-{id}"));
        if requested_id
            .as_ref()
            .is_some_and(|id| items.get(session_id).is_some_and(|entry| &entry.0 != id))
        {
            items.remove(session_id);
        }
        let entry = items.entry(session_id.to_string()).or_insert_with(|| {
            (
                requested_id
                    .unwrap_or_else(|| format!("acp-msg-{}", uuid::Uuid::new_v4().simple())),
                String::new(),
            )
        });
        merge_assistant_chunk(&mut entry.1, chunk);
        (entry.0.clone(), entry.1.clone())
    }

    /// Accumulates one replayed user message, respecting ACP message IDs when
    /// supplied and using assistant chunks as boundaries when they are not.
    pub async fn append_user_text(
        &self,
        session_id: &str,
        message_id: Option<&str>,
        chunk: &str,
    ) -> (String, String) {
        self.current_items.lock().await.remove(session_id);
        let mut items = self.current_user_items.lock().await;
        let requested_id = message_id.map(|id| format!("acp-user-{id}"));
        if requested_id
            .as_ref()
            .is_some_and(|id| items.get(session_id).is_some_and(|entry| &entry.0 != id))
        {
            items.remove(session_id);
        }
        let entry = items.entry(session_id.to_string()).or_insert_with(|| {
            (
                requested_id
                    .unwrap_or_else(|| format!("acp-user-{}", uuid::Uuid::new_v4().simple())),
                String::new(),
            )
        });
        merge_assistant_chunk(&mut entry.1, chunk);
        (entry.0.clone(), entry.1.clone())
    }

    /// Closes the in-progress assistant text and reasoning stream items so
    /// the next chunk opens a fresh conversation item. Agents that omit
    /// `messageId` (Grok) give ACP clients no message boundaries; without an
    /// explicit break at each tool call, every text chunk of a turn merges
    /// into the turn's first bubble and the final answer lands above the
    /// tool calls instead of at the end of the transcript.
    pub async fn break_stream_items(&self, session_id: &str) {
        self.current_items.lock().await.remove(session_id);
        self.current_thought_items.lock().await.remove(session_id);
    }

    /// Accumulates streamed ACP thought text into one reasoning item.
    pub async fn append_thought_text(
        &self,
        session_id: &str,
        message_id: Option<&str>,
        chunk: &str,
    ) -> (String, String) {
        self.current_items.lock().await.remove(session_id);
        let mut items = self.current_thought_items.lock().await;
        let requested_id = message_id.map(|id| format!("acp-thought-{id}"));
        if requested_id
            .as_ref()
            .is_some_and(|id| items.get(session_id).is_some_and(|entry| &entry.0 != id))
        {
            items.remove(session_id);
        }
        let entry = items.entry(session_id.to_string()).or_insert_with(|| {
            (
                requested_id
                    .unwrap_or_else(|| format!("acp-thought-{}", uuid::Uuid::new_v4().simple())),
                String::new(),
            )
        });
        merge_assistant_chunk(&mut entry.1, chunk);
        (entry.0.clone(), entry.1.clone())
    }

    /// Returns the stable plan item id for this session's current turn.
    pub async fn current_plan_item_id(&self, session_id: &str) -> String {
        let mut items = self.current_plan_items.lock().await;
        items
            .entry(session_id.to_string())
            .or_insert_with(|| format!("acp-plan-{}", uuid::Uuid::new_v4().simple()))
            .clone()
    }

    /// Ends the current turn for a session so the next one gets a fresh item.
    pub async fn end_turn(&self, session_id: &str) {
        self.current_items.lock().await.remove(session_id);
        self.current_thought_items.lock().await.remove(session_id);
        self.current_user_items.lock().await.remove(session_id);
        self.current_plan_items.lock().await.remove(session_id);
        // Tool calls never span turns; dropping their memory here keeps the
        // map bounded over a long-lived agent process.
        self.current_tools
            .lock()
            .await
            .retain(|_, memory| memory.session_id != session_id);
    }

    /// Records a tool call's identity and last-known output for later
    /// partial updates.
    pub async fn remember_tool(&self, call_id: &str, memory: AcpToolMemory) {
        self.current_tools
            .lock()
            .await
            .insert(call_id.to_string(), memory);
    }

    /// Looks up a previously announced tool call's identity and output.
    pub async fn tool_memory(&self, call_id: &str) -> Option<AcpToolMemory> {
        self.current_tools.lock().await.get(call_id).cloned()
    }

    /// All thread ids with live sessions on this runtime.
    pub async fn active_thread_ids(&self) -> Vec<String> {
        self.sessions.lock().await.keys().cloned().collect()
    }

    /// Cancels the in-flight turn for a session: a user interrupt. Queued
    /// steers are dropped and further steers refused — the whole turn is
    /// ending, so the prompt loop must not restart it with queued input.
    pub async fn cancel(&self, session_id: &str) -> Result<(), DaemonError> {
        if let Some(queue) = self.steer_queues.lock().await.get_mut(session_id) {
            queue.queued.clear();
            queue.cancel_requested = true;
            queue.stopping = true;
        }
        self.send_cancel(session_id).await
    }

    /// Sends `session/cancel` and retires reverse requests. The ACP contract
    /// requires the client to resolve any outstanding permission requests as
    /// `cancelled` once it cancels the turn; agents may block their prompt
    /// future on those responses.
    async fn send_cancel(&self, session_id: &str) -> Result<(), DaemonError> {
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await?;
        self.cancel_pending_permissions(session_id).await;
        self.cancel_pending_plan_approvals(session_id).await;
        self.cancel_pending_questions(session_id).await;
        Ok(())
    }

    /// Resolves every pending permission request for a session with the
    /// `cancelled` outcome and forgets it.
    pub async fn cancel_pending_permissions(&self, session_id: &str) {
        let drained = {
            let mut requests = self.permission_requests.lock().await;
            let ids = requests
                .iter()
                .filter(|(_, pending)| pending.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| requests.remove(&id))
                .collect::<Vec<_>>()
        };
        for pending in drained {
            let _ = self
                .write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": pending.raw_id,
                    "result": { "outcome": { "outcome": "cancelled" } }
                }))
                .await;
        }
    }

    /// Abandons every pending Grok plan review for a cancelled or ended turn.
    pub async fn cancel_pending_plan_approvals(&self, session_id: &str) {
        let drained = {
            let mut requests = self.plan_approval_requests.lock().await;
            let ids = requests
                .iter()
                .filter(|(_, pending)| pending.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| requests.remove(&id))
                .collect::<Vec<_>>()
        };
        for pending in drained {
            let _ = self
                .write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": pending.raw_id,
                    "result": plan_approval_rpc_result(
                        pending.kind,
                        PlanApprovalOutcome::Abandoned,
                        None
                    )
                }))
                .await;
        }
    }

    /// Resolves every pending Cursor question for a session as cancelled.
    pub async fn cancel_pending_questions(&self, session_id: &str) {
        let drained = {
            let mut requests = self.question_requests.lock().await;
            let ids = requests
                .iter()
                .filter(|(_, pending)| pending.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| requests.remove(&id))
                .collect::<Vec<_>>()
        };
        for pending in drained {
            let _ = self
                .write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": pending.raw_id,
                    "result": { "outcome": { "outcome": "cancelled" } }
                }))
                .await;
        }
    }

    /// Answers a pending `session/request_permission` with a user decision.
    pub async fn respond_permission(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), DaemonError> {
        // Validate before removing: a decision the agent's options cannot
        // express must leave the request pending (and answerable), not strand
        // the agent waiting on a response that will never come.
        let pending = {
            let mut requests = self.permission_requests.lock().await;
            let pending = requests.get(request_id).ok_or_else(|| {
                DaemonError::NotFound("ACP permission request not found".to_string())
            })?;
            if permission_option_for_decision(&pending.options, &decision).is_none() {
                return Err(DaemonError::Rpc(format!(
                    "ACP permission request did not offer {decision:?}"
                )));
            }
            requests.remove(request_id).expect("entry checked above")
        };
        let option = permission_option_for_decision(&pending.options, &decision)
            .expect("validated while holding the lock");
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": pending.raw_id,
            "result": {
                "outcome": { "outcome": "selected", "optionId": option.option_id }
            }
        }))
        .await
    }

    /// Answers a pending Grok `_x.ai/exit_plan_mode` reverse request.
    pub async fn respond_plan_approval(
        &self,
        request_id: &str,
        outcome: PlanApprovalOutcome,
        feedback: Option<String>,
    ) -> Result<(), DaemonError> {
        let pending = self
            .plan_approval_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| DaemonError::NotFound("ACP plan approval not found".to_string()))?;
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": pending.raw_id,
            "result": plan_approval_rpc_result(pending.kind, outcome, feedback.as_deref())
        }))
        .await
    }

    /// Answers a pending `cursor/ask_question` reverse request.
    pub async fn respond_question(
        &self,
        request_id: &str,
        answers: &HashMap<String, Vec<String>>,
    ) -> Result<(), DaemonError> {
        let pending = self
            .question_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| DaemonError::NotFound("ACP question request not found".to_string()))?;
        let mapped = pending
            .options_by_question
            .iter()
            .map(|(question_id, options)| {
                let selected = answers.get(question_id).into_iter().flatten();
                let selected_option_ids = selected
                    .filter_map(|choice| {
                        options
                            .iter()
                            .find(|(_, label)| label == choice)
                            .or_else(|| options.iter().find(|(id, _)| id == choice))
                            .map(|(id, _)| id.clone())
                    })
                    .collect::<Vec<_>>();
                json!({
                    "questionId": question_id,
                    "selectedOptionIds": selected_option_ids
                })
            })
            .collect::<Vec<_>>();
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": pending.raw_id,
            "result": {
                "outcome": {
                    "outcome": "answered",
                    "answers": mapped
                }
            }
        }))
        .await
    }

    /// Cancels a pending `cursor/ask_question` when its thread is gone.
    pub async fn cancel_question(&self, request_id: &str) -> Result<(), DaemonError> {
        let pending = self
            .question_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| DaemonError::NotFound("ACP question request not found".to_string()))?;
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": pending.raw_id,
            "result": { "outcome": { "outcome": "cancelled" } }
        }))
        .await
    }

    /// Terminates the agent process.
    pub async fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    async fn read_loop(runtime: Arc<Self>, stdout: tokio::process::ChildStdout) {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = Self::strip_terminal_control_prefix(line.trim());
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                let sample = trimmed.chars().take(500).collect::<String>();
                tracing::debug!(
                    provider = %runtime.config.id,
                    stdout = %sample,
                    "non-JSON ACP output ignored"
                );
                continue;
            };
            runtime.handle_message(message).await;
        }
        runtime.closed.store(true, Ordering::Release);
        let stderr_tail = runtime.stderr_summary().await;
        let detail = if stderr_tail.is_empty() {
            String::new()
        } else {
            format!(": {stderr_tail}")
        };
        let mut pending = runtime.pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(DaemonError::Process(format!(
                "ACP provider '{}' exited{detail}",
                runtime.config.id
            ))));
        }
        let _ = runtime.events.send(AcpEvent::Fatal {
            message: format!("{} agent process exited{detail}", runtime.config.label),
        });
    }

    /// Removes terminal-only OSC notifications that some harness integrations
    /// prepend to their otherwise valid JSON-RPC stdout.
    ///
    /// OpenCode's Warp integration can emit one or more `ESC ] ... BEL`
    /// records directly before a JSON object on the same line. ACP owns stdout
    /// as JSONL, but dropping the whole line loses the attached response and
    /// leaves the request pending forever. Only leading OSC records are
    /// removed; control bytes inside JSON or arbitrary non-JSON output remain
    /// untouched.
    pub(crate) fn strip_terminal_control_prefix(mut line: &str) -> &str {
        loop {
            line = line.trim_start();
            let Some(payload) = line.strip_prefix("\u{1b}]") else {
                return line;
            };
            let bell_end = payload.find('\u{7}').map(|index| index + 1);
            let string_end = payload
                .find("\u{1b}\\")
                .map(|index| index + "\u{1b}\\".len());
            let end = match (bell_end, string_end) {
                (Some(left), Some(right)) => left.min(right),
                (Some(end), None) | (None, Some(end)) => end,
                (None, None) => return line,
            };
            line = &payload[end..];
        }
    }

    /// Retains the last few stderr lines so a dying agent's diagnostics
    /// (auth failures, panics) survive into the Fatal message instead of
    /// vanishing with the process.
    async fn stderr_loop(runtime: Arc<Self>, stderr: tokio::process::ChildStderr) {
        const MAX_LINES: usize = 20;
        const MAX_LINE_CHARS: usize = 500;
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }
            tracing::debug!(provider = %runtime.config.id, stderr = %line, "ACP agent stderr");
            let mut tail = runtime.stderr_tail.lock().await;
            let mut stored = line.to_string();
            if stored.chars().count() > MAX_LINE_CHARS {
                stored = stored.chars().take(MAX_LINE_CHARS).collect();
            }
            tail.push_back(stored);
            while tail.len() > MAX_LINES {
                tail.pop_front();
            }
            drop(tail);
            runtime.record_prompt_stderr_line(line).await;
        }
    }

    async fn record_prompt_stderr_line(&self, line: &str) {
        let Some(summary) = opencode_stderr_error_summary(line) else {
            return;
        };
        let sessions = self
            .prompt_sessions
            .lock()
            .await
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        if sessions.is_empty() {
            return;
        }
        let mut errors = self.prompt_stderr_errors.lock().await;
        for session_id in sessions {
            errors.insert(session_id, summary.clone());
        }
    }

    /// The retained stderr tail as one displayable string.
    async fn stderr_summary(&self) -> String {
        let tail = self.stderr_tail.lock().await;
        tail.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    async fn handle_message(&self, message: Value) {
        let has_id = message.get("id").is_some();
        let has_method = message.get("method").is_some();
        if has_id && !has_method {
            // Response to one of our requests. Some adapters echo numeric ids
            // back as strings; accept both rather than stranding the caller.
            let Some(id) = message.get("id").and_then(|id| {
                id.as_i64()
                    .or_else(|| id.as_str().and_then(|value| value.parse::<i64>().ok()))
            }) else {
                return;
            };
            let Some(sender) = self.pending.lock().await.remove(&id) else {
                return;
            };
            if let Some(error) = message.get("error") {
                let text = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("ACP request failed");
                // Adapters that answer with a bare JSON-RPC "Internal error"
                // often put the actual cause in `data`; without it the user
                // sees a message that explains nothing.
                let detail = error.get("data").and_then(rpc_error_data_text);
                let text = match detail {
                    Some(detail) if !text.contains(detail.as_str()) => {
                        format!("{text}: {detail}")
                    }
                    _ => text.to_string(),
                };
                let _ = sender.send(Err(DaemonError::Rpc(format!(
                    "{} ({})",
                    text, self.config.id
                ))));
            } else {
                let result = message.get("result").cloned().unwrap_or(Value::Null);
                let _ = sender.send(Ok(result));
            }
            return;
        }
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match method.as_str() {
            "session/update" => self.handle_session_update(&params).await,
            // Grok's vendor stream duplicates session/update with turn-level
            // metadata; the only part we need is the real failure text, which
            // never appears on the standard surface.
            "_x.ai/session/update" => self.capture_vendor_turn_failure(&params).await,
            "session/request_permission" => {
                let raw_id = message.get("id").cloned().unwrap_or(Value::Null);
                self.handle_permission_request(raw_id, &params).await;
            }
            // Grok 1.0.4 uses the private `_x.ai` namespace. Retain the
            // unprefixed spelling for compatibility with earlier builds.
            method if is_grok_plan_approval_method(method) => {
                let raw_id = message.get("id").cloned().unwrap_or(Value::Null);
                self.handle_plan_approval_request(raw_id, &params, PlanApprovalKind::Grok)
                    .await;
            }
            "cursor/create_plan" => {
                let raw_id = message.get("id").cloned().unwrap_or(Value::Null);
                self.handle_plan_approval_request(raw_id, &params, PlanApprovalKind::Cursor)
                    .await;
            }
            "cursor/ask_question" => {
                let raw_id = message.get("id").cloned().unwrap_or(Value::Null);
                self.handle_cursor_question_request(raw_id, &params).await;
            }
            method if is_cursor_notification_method(method) => {
                if has_id {
                    let raw_id = message.get("id").cloned().unwrap_or(Value::Null);
                    let _ = self
                        .write_message(&json!({
                            "jsonrpc": "2.0",
                            "id": raw_id,
                            "result": cursor_notification_result(method, &params)
                        }))
                        .await;
                }
            }
            // Filesystem and terminal capabilities are declined during
            // initialize; refuse politely if an agent tries anyway.
            _ if has_id => {
                let raw_id = message.get("id").cloned().unwrap_or(Value::Null);
                let _ = self
                    .write_message(&json!({
                        "jsonrpc": "2.0",
                        "id": raw_id,
                        "error": { "code": -32601, "message": "method not supported by this client" }
                    }))
                    .await;
            }
            _ => {}
        }
    }

    async fn handle_session_update(&self, params: &Value) {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let Some(update) = params.get("update") else {
            return;
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let classified = AcpSessionUpdateKind::classify(kind);
        let event = match classified {
            AcpSessionUpdateKind::AgentMessageChunk => update
                .get("content")
                .and_then(acp_content_block_text)
                .map(|text| AcpEvent::MessageDelta {
                    session_id: session_id.to_string(),
                    message_id: update
                        .get("messageId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    text,
                }),
            AcpSessionUpdateKind::AgentThoughtChunk => update
                .get("content")
                .and_then(acp_content_block_text)
                .map(|text| AcpEvent::ThoughtDelta {
                    session_id: session_id.to_string(),
                    message_id: update
                        .get("messageId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    text,
                }),
            AcpSessionUpdateKind::ConfigOptionUpdate => {
                self.capture_session_metadata(session_id, update).await;
                None
            }
            // The agent switched modes on its own (or confirmed ours).
            AcpSessionUpdateKind::CurrentModeUpdate => {
                if let Some(mode_id) = update.get("currentModeId").and_then(Value::as_str)
                    && let Some(state) = self.session_modes.lock().await.get_mut(session_id)
                {
                    state.current = Some(mode_id.to_string());
                }
                None
            }
            AcpSessionUpdateKind::ToolCall => {
                let call_id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let (output, diffs) = acp_tool_content(update);
                Some(AcpEvent::ToolCall {
                    session_id: session_id.to_string(),
                    call_id,
                    title: acp_tool_title(update).unwrap_or_else(|| "Tool call".to_string()),
                    kind: update
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("other")
                        .to_string(),
                    status: update
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("pending")
                        .to_string(),
                    output,
                    diffs,
                })
            }
            AcpSessionUpdateKind::ToolCallUpdate => {
                let call_id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let (output, diffs) = acp_tool_content(update);
                Some(AcpEvent::ToolCallUpdate {
                    session_id: session_id.to_string(),
                    call_id,
                    title: acp_tool_title(update),
                    status: update
                        .get("status")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    output,
                    diffs,
                })
            }
            AcpSessionUpdateKind::Plan => {
                let steps = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|entry| {
                                let content =
                                    entry.get("content").and_then(Value::as_str)?.to_string();
                                let status = entry
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("pending")
                                    .to_string();
                                let id = entry
                                    .get("id")
                                    .or_else(|| entry.get("entryId"))
                                    .and_then(Value::as_str)
                                    .filter(|value| !value.trim().is_empty())
                                    .map(ToOwned::to_owned);
                                Some(PlanStep {
                                    id,
                                    step: content,
                                    status,
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Some(AcpEvent::Plan {
                    session_id: session_id.to_string(),
                    plan: ThreadPlan {
                        explanation: None,
                        steps,
                    },
                })
            }
            AcpSessionUpdateKind::AvailableCommandsUpdate => {
                self.report_unprojected_update(classified, false).await;
                None
            }
            AcpSessionUpdateKind::SessionInfoUpdate => Some(AcpEvent::SessionInfo {
                session_id: session_id.to_string(),
                title: update
                    .get("title")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            }),
            AcpSessionUpdateKind::UsageUpdate => update
                .get("used")
                .and_then(Value::as_u64)
                .zip(update.get("size").and_then(Value::as_u64))
                .map(|(used, size)| AcpEvent::Usage {
                    session_id: session_id.to_string(),
                    used,
                    size,
                }),
            AcpSessionUpdateKind::UserMessageChunk => update
                .get("content")
                .and_then(acp_content_block_text)
                .map(|text| AcpEvent::UserMessageDelta {
                    session_id: session_id.to_string(),
                    message_id: update
                        .get("messageId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    text,
                }),
            AcpSessionUpdateKind::Unknown(_) => {
                self.report_unprojected_update(classified, true).await;
                None
            }
        };
        if let Some(event) = event {
            if Self::event_is_turn_content(&event)
                && !self.session_accepts_turn_content(session_id).await
            {
                // pi-acp (and similar) emit a session-start banner after
                // session/new, before any prompt. Projecting that as the
                // turn's assistant reply hides auth failures as a "successful"
                // message.
                return;
            }
            if Self::event_is_model_output(&event) {
                self.note_prompt_output(session_id).await;
            }
            let _ = self.events.send(event);
        }
    }

    fn event_is_turn_content(event: &AcpEvent) -> bool {
        matches!(
            event,
            AcpEvent::MessageDelta { .. }
                | AcpEvent::ThoughtDelta { .. }
                | AcpEvent::UserMessageDelta { .. }
                | AcpEvent::ToolCall { .. }
                | AcpEvent::ToolCallUpdate { .. }
                | AcpEvent::Plan { .. }
        )
    }

    fn event_is_model_output(event: &AcpEvent) -> bool {
        matches!(
            event,
            AcpEvent::MessageDelta { .. }
                | AcpEvent::ThoughtDelta { .. }
                | AcpEvent::ToolCall { .. }
                | AcpEvent::ToolCallUpdate { .. }
                | AcpEvent::Plan { .. }
        )
    }

    /// Records the failure text Grok reports through `_x.ai/session/update`
    /// (`turn_completed` with `stop_reason: "error"`, or a failed
    /// `retry_state`). The matching JSON-RPC prompt error says only
    /// "Internal error"; `prompt` swaps in this detail when the turn fails.
    async fn capture_vendor_turn_failure(&self, params: &Value) {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let Some(update) = params.get("update") else {
            return;
        };
        let detail = match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("turn_completed")
                if update.get("stop_reason").and_then(Value::as_str) == Some("error") =>
            {
                update.get("agent_result").and_then(Value::as_str)
            }
            Some("retry_state") if update.get("type").and_then(Value::as_str) == Some("failed") => {
                update.get("message").and_then(Value::as_str)
            }
            _ => None,
        };
        if let Some(detail) = detail.map(str::trim).filter(|detail| !detail.is_empty()) {
            self.turn_failure_details
                .lock()
                .await
                .insert(session_id.to_string(), detail.to_string());
        }
    }

    async fn report_unprojected_update(&self, kind: AcpSessionUpdateKind<'_>, is_unknown: bool) {
        let kind = kind.as_str();
        if !self
            .reported_update_kinds
            .lock()
            .await
            .insert(kind.to_string())
        {
            return;
        }
        if is_unknown {
            tracing::warn!(
                provider = %self.config.id,
                update_kind = kind,
                "ACP adapter emitted an unknown session-update kind"
            );
        } else {
            tracing::debug!(
                provider = %self.config.id,
                update_kind = kind,
                "ACP session-update kind has no FalconDeck projection"
            );
        }
    }

    async fn handle_permission_request(&self, raw_id: Value, params: &Value) {
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // A request from a session no thread owns (discovery session, or a
        // rolled-back session/load) could never be answered by a user;
        // surfacing it would create an immortal banner while the agent hangs.
        if self
            .threads_by_session
            .lock()
            .await
            .get(&session_id)
            .is_none()
        {
            let _ = self
                .write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": raw_id,
                    "result": { "outcome": { "outcome": "cancelled" } }
                }))
                .await;
            return;
        }
        let request_id = format!("acp-perm-{}", uuid::Uuid::new_v4().simple());
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        Some(AcpPermissionOption {
                            option_id: option.get("optionId").and_then(Value::as_str)?.to_string(),
                            kind: option
                                .get("kind")
                                .and_then(Value::as_str)
                                .unwrap_or("allow_once")
                                .to_string(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let title = params
            .pointer("/toolCall/title")
            .and_then(Value::as_str)
            .unwrap_or("Tool approval requested")
            .to_string();
        let detail = params
            .pointer("/toolCall/kind")
            .and_then(Value::as_str)
            .map(|kind| format!("{} tool call from {}", kind, self.config.label));
        self.permission_requests.lock().await.insert(
            request_id.clone(),
            PendingPermission {
                raw_id,
                session_id: session_id.clone(),
                options: options.clone(),
            },
        );
        let _ = self.events.send(AcpEvent::PermissionRequest {
            session_id,
            request_id,
            title,
            detail,
            options,
        });
    }

    async fn handle_plan_approval_request(
        &self,
        raw_id: Value,
        params: &Value,
        kind: PlanApprovalKind,
    ) {
        let Some(session_id) = self.owning_session_id(params).await else {
            let _ = self
                .write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": raw_id,
                    "result": plan_approval_rpc_result(
                        kind,
                        PlanApprovalOutcome::Abandoned,
                        None
                    )
                }))
                .await;
            return;
        };

        let request_id = format!("acp-plan-{}", uuid::Uuid::new_v4().simple());
        self.plan_approval_requests.lock().await.insert(
            request_id.clone(),
            PendingPlanApproval {
                raw_id,
                session_id: session_id.clone(),
                kind,
            },
        );
        let plan_content = match kind {
            PlanApprovalKind::Cursor => cursor_plan_content(params),
            PlanApprovalKind::Grok => params
                .get("planContent")
                .and_then(Value::as_str)
                .unwrap_or("The provider did not include plan content.")
                .to_string(),
        };
        let method = match kind {
            PlanApprovalKind::Cursor => "cursor/create_plan",
            PlanApprovalKind::Grok => "x.ai/exit_plan_mode",
        };
        let _ = self.events.send(AcpEvent::PlanApprovalRequest {
            session_id,
            request_id,
            method: method.to_string(),
            tool_call_id: params
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            plan_content,
        });
    }

    async fn handle_cursor_question_request(&self, raw_id: Value, params: &Value) {
        let Some(session_id) = self.owning_session_id(params).await else {
            let _ = self
                .write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": raw_id,
                    "result": { "outcome": { "outcome": "cancelled" } }
                }))
                .await;
            return;
        };
        let (questions, options_by_question) = parse_cursor_questions(params);
        if questions.is_empty() {
            let _ = self
                .write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": raw_id,
                    "result": { "outcome": { "outcome": "skipped", "reason": "no questions" } }
                }))
                .await;
            return;
        }
        let request_id = format!("acp-question-{}", uuid::Uuid::new_v4().simple());
        self.question_requests.lock().await.insert(
            request_id.clone(),
            PendingQuestion {
                raw_id,
                session_id: session_id.clone(),
                options_by_question,
            },
        );
        let title = params
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or("Cursor question")
            .to_string();
        let _ = self.events.send(AcpEvent::QuestionRequest {
            session_id,
            request_id,
            title,
            questions,
        });
    }

    /// Session id on the reverse request, or the unique in-flight prompt
    /// session when Cursor omits `sessionId`.
    async fn owning_session_id(&self, params: &Value) -> Option<String> {
        if let Some(session_id) = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty())
        {
            return self
                .threads_by_session
                .lock()
                .await
                .contains_key(session_id)
                .then(|| session_id.to_string());
        }
        let unique_prompt = {
            let prompt_sessions = self.prompt_sessions.lock().await;
            (prompt_sessions.len() == 1).then(|| prompt_sessions.iter().next().cloned())?
        };
        let session_id = unique_prompt?;
        self.threads_by_session
            .lock()
            .await
            .contains_key(&session_id)
            .then_some(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_cli_model_lines_parse_with_verbatim_variant_ids() {
        let models = parse_cursor_cli_models(
            "Cursor Agent models:\n\
             auto - Auto (default)\n\
             gpt-5.6-sol-medium - GPT-5.6 Sol (NO ZDR)\n\
             composer-2.5-fast - Composer 2.5 Fast (current)\n",
        );
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["auto", "gpt-5.6-sol-medium", "composer-2.5-fast"]);
        assert_eq!(models[0].label, "Auto");
        assert_eq!(models[1].label, "GPT-5.6 Sol");
        assert_eq!(models[2].label, "Composer 2.5 Fast");
        assert!(models[0].is_default);
        assert!(!models.iter().skip(1).any(|model| model.is_default));
    }

    #[test]
    fn cursor_cli_model_list_without_annotation_defaults_to_first() {
        let models = parse_cursor_cli_models("a-model - A Model\nb-model - B Model\n");
        assert!(models[0].is_default);
        assert!(!models[1].is_default);
    }

    #[test]
    fn cursor_cli_combined_annotation_marks_and_strips() {
        let models = parse_cursor_cli_models(
            "auto - Auto\ncomposer-2-fast - Composer 2 Fast (current, default)\n",
        );
        assert_eq!(models[1].label, "Composer 2 Fast");
        assert!(!models[0].is_default);
        assert!(models[1].is_default);
    }

    #[test]
    fn cursor_cli_model_list_strips_ansi_escapes() {
        let models =
            parse_cursor_cli_models("\x1b[36mauto\x1b[0m - \x1b[1mAuto\x1b[0m (default)\n");
        assert_eq!(models[0].id, "auto");
        assert_eq!(models[0].label, "Auto");
        assert!(models[0].is_default);
    }

    #[test]
    fn cursor_cli_model_list_ignores_headers_and_noise() {
        assert!(parse_cursor_cli_models("Welcome to Cursor Agent\n\nno separator\n").is_empty());
        // An id containing spaces is not a model line.
        assert!(parse_cursor_cli_models("not an id - Label\n").is_empty());
    }

    #[test]
    fn error_data_text_accepts_the_shapes_adapters_actually_send() {
        assert_eq!(
            rpc_error_data_text(&json!("balance exhausted")).as_deref(),
            Some("balance exhausted")
        );
        assert_eq!(
            rpc_error_data_text(&json!({ "details": "API error (status 402)" })).as_deref(),
            Some("API error (status 402)")
        );
        assert_eq!(
            rpc_error_data_text(&json!({ "message": "quota hit" })).as_deref(),
            Some("quota hit")
        );
        // Arbitrary objects still surface, as bounded JSON.
        assert_eq!(
            rpc_error_data_text(&json!({ "code": 402 })).as_deref(),
            Some(r#"{"code":402}"#)
        );
        assert_eq!(rpc_error_data_text(&Value::Null), None);
        assert_eq!(rpc_error_data_text(&json!("  ")), None);
        assert_eq!(rpc_error_data_text(&json!({})), None);
        let long = "x".repeat(600);
        let bounded = rpc_error_data_text(&json!(long)).unwrap();
        assert_eq!(bounded.chars().count(), 501);
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn raw_agent_tool_names_are_read_back_as_the_work_they_describe() {
        // Grok opens every call with its own wire name and only sends prose
        // once the call resolves.
        assert_eq!(
            acp_tool_title(&json!({
                "title": "read_file",
                "rawInput": { "target_file": "/repo/AGENTS.md" }
            }))
            .as_deref(),
            Some("Read /repo/AGENTS.md")
        );
        assert_eq!(
            acp_tool_title(&json!({
                "title": "run_terminal_command",
                "rawInput": { "command": "git status --short" }
            }))
            .as_deref(),
            Some("git status --short")
        );
        assert_eq!(
            acp_tool_title(&json!({
                "title": "list_dir",
                "rawInput": { "target_directory": "/repo/frontend" }
            }))
            .as_deref(),
            Some("List /repo/frontend")
        );
        // Input has not streamed yet: ACP's own `locations` still names the file.
        assert_eq!(
            acp_tool_title(&json!({
                "title": "search_replace",
                "locations": [{ "path": "/repo/src/app.tsx" }]
            }))
            .as_deref(),
            Some("Edit /repo/src/app.tsx")
        );
        // Nothing to go on yet — the verb alone still beats the wire name.
        assert_eq!(
            acp_tool_title(&json!({ "title": "todo_write" })).as_deref(),
            Some("Update plan")
        );
        // A title the agent already wrote as prose is left exactly as sent.
        assert_eq!(
            acp_tool_title(&json!({ "title": "Edit `/repo/src/app.tsx`" })).as_deref(),
            Some("Edit `/repo/src/app.tsx`")
        );
        // An unknown tool keeps its own name rather than being guessed at.
        assert_eq!(
            acp_tool_title(&json!({ "title": "summon_kraken" })).as_deref(),
            Some("summon_kraken")
        );
        assert_eq!(acp_tool_title(&json!({})), None);
    }

    #[test]
    fn terminal_osc_prefixes_are_removed_before_acp_json() {
        let json = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let line = format!(
            "\u{1b}]777;notify;warp://cli-agent;session_start\u{7}\
             \u{1b}]0;OpenCode\u{1b}\\{json}"
        );
        assert_eq!(AcpRuntime::strip_terminal_control_prefix(&line), json);
    }

    #[test]
    fn malformed_or_embedded_terminal_controls_are_not_rewritten() {
        let unterminated = "\u{1b}]777;unterminated";
        assert_eq!(
            AcpRuntime::strip_terminal_control_prefix(unterminated),
            unterminated
        );
        let embedded = "not-json\u{1b}]777;notification\u{7}";
        assert_eq!(
            AcpRuntime::strip_terminal_control_prefix(embedded),
            embedded
        );
    }

    async fn timeout_fixture_runtime() -> Arc<AcpRuntime> {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp_conformance_agent.mjs");
        let config = AcpProviderConfig {
            id: "timeout-fixture".to_string(),
            label: "Timeout fixture".to_string(),
            command: vec![
                "node".to_string(),
                fixture.to_string_lossy().into_owned(),
                "session-new-timeout".to_string(),
            ],
            env: HashMap::new(),
            transport: ProviderTransport::default(),
        };
        let (events, _receiver) = mpsc::unbounded_channel();
        AcpRuntime::connect(config, env!("CARGO_MANIFEST_DIR"), events)
            .await
            .expect("fixture should initialize")
    }

    async fn plan_approval_fixture_runtime() -> (Arc<AcpRuntime>, mpsc::UnboundedReceiver<AcpEvent>)
    {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp_conformance_agent.mjs");
        let config = AcpProviderConfig {
            id: "plan-approval-fixture".to_string(),
            label: "Plan approval fixture".to_string(),
            command: vec![
                "node".to_string(),
                fixture.to_string_lossy().into_owned(),
                "plan-approval".to_string(),
            ],
            env: HashMap::new(),
            transport: ProviderTransport::default(),
        };
        let (events, receiver) = mpsc::unbounded_channel();
        let runtime = AcpRuntime::connect(config, env!("CARGO_MANIFEST_DIR"), events)
            .await
            .expect("fixture should initialize");
        (runtime, receiver)
    }

    async fn steer_fixture_runtime() -> (Arc<AcpRuntime>, mpsc::UnboundedReceiver<AcpEvent>) {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp_conformance_agent.mjs");
        let config = AcpProviderConfig {
            id: "steer-fixture".to_string(),
            label: "Steer fixture".to_string(),
            command: vec![
                "node".to_string(),
                fixture.to_string_lossy().into_owned(),
                "steer".to_string(),
            ],
            env: HashMap::new(),
            transport: ProviderTransport::default(),
        };
        let (events, receiver) = mpsc::unbounded_channel();
        let runtime = AcpRuntime::connect(config, env!("CARGO_MANIFEST_DIR"), events)
            .await
            .expect("fixture should initialize");
        (runtime, receiver)
    }

    async fn next_acp_event(events: &mut mpsc::UnboundedReceiver<AcpEvent>) -> AcpEvent {
        timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("an event should arrive")
            .expect("event channel should remain open")
    }

    async fn wait_for_message_delta(events: &mut mpsc::UnboundedReceiver<AcpEvent>, needle: &str) {
        loop {
            if let AcpEvent::MessageDelta { text, .. } = next_acp_event(events).await
                && text.contains(needle)
            {
                return;
            }
        }
    }

    async fn fixture_runtime(
        scenario: &str,
    ) -> (Arc<AcpRuntime>, mpsc::UnboundedReceiver<AcpEvent>) {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp_conformance_agent.mjs");
        let config = AcpProviderConfig {
            id: format!("{scenario}-fixture"),
            label: format!("{scenario} fixture"),
            command: vec![
                "node".to_string(),
                fixture.to_string_lossy().into_owned(),
                scenario.to_string(),
            ],
            env: HashMap::new(),
            transport: ProviderTransport::default(),
        };
        let (events, receiver) = mpsc::unbounded_channel();
        let runtime = AcpRuntime::connect(config, env!("CARGO_MANIFEST_DIR"), events)
            .await
            .expect("fixture should initialize");
        (runtime, receiver)
    }

    #[tokio::test]
    async fn session_start_banner_is_not_projected_as_turn_text() {
        let (runtime, mut events) = fixture_runtime("startup-banner").await;
        let session_id = runtime
            .ensure_session(
                "thread-startup",
                None,
                env!("CARGO_MANIFEST_DIR"),
                None,
                &Default::default(),
                None,
                None,
            )
            .await
            .expect("fixture session should start");

        let saw_banner = timeout(Duration::from_millis(250), async {
            loop {
                if let AcpEvent::MessageDelta { text, .. } = next_acp_event(&mut events).await
                    && text.contains("STARTUP_BANNER")
                {
                    return true;
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(
            !saw_banner,
            "session/new startup text must not become the turn reply"
        );

        let stop = runtime
            .prompt(
                &session_id,
                vec![json!({ "type": "text", "text": "hello" })],
            )
            .await
            .expect("empty prompt should still settle");
        assert_eq!(stop, "end_turn");

        let ended = timeout(Duration::from_secs(5), async {
            loop {
                if let AcpEvent::TurnEnded {
                    had_output,
                    stop_reason,
                    ..
                } = next_acp_event(&mut events).await
                {
                    return (had_output, stop_reason);
                }
            }
        })
        .await
        .expect("turn-ended should arrive");
        assert_eq!(ended, (false, Some("end_turn".to_string())));
        runtime.shutdown().await;
    }

    /// The pump decides replay-vs-live per item from these markers, so their
    /// ordering around the replayed history is what keeps restored threads
    /// from flipping unread on first open.
    #[tokio::test]
    async fn load_session_brackets_replayed_history_with_marker_events() {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp_conformance_agent.mjs");
        let config = AcpProviderConfig {
            id: "load-replay-fixture".to_string(),
            label: "Load replay fixture".to_string(),
            command: vec![
                "node".to_string(),
                fixture.to_string_lossy().into_owned(),
                "normal".to_string(),
            ],
            env: HashMap::new(),
            transport: ProviderTransport::default(),
        };
        let (events, mut events_rx) = mpsc::unbounded_channel();
        let runtime = AcpRuntime::connect(config, env!("CARGO_MANIFEST_DIR"), events)
            .await
            .expect("fixture should initialize");

        runtime
            .load_session(
                "thread-load",
                "fixture-session-1",
                env!("CARGO_MANIFEST_DIR"),
                &Default::default(),
            )
            .await
            .expect("session/load should succeed");

        assert!(matches!(
            next_acp_event(&mut events_rx).await,
            AcpEvent::ReplayStarted { session_id } if session_id == "fixture-session-1"
        ));
        assert!(matches!(
            next_acp_event(&mut events_rx).await,
            AcpEvent::UserMessageDelta { text, .. } if text == "replayed fixture prompt"
        ));
        assert!(matches!(
            next_acp_event(&mut events_rx).await,
            AcpEvent::MessageDelta { text, .. } if text == "replayed fixture answer"
        ));
        assert!(matches!(
            next_acp_event(&mut events_rx).await,
            AcpEvent::ReplayFinished { session_id } if session_id == "fixture-session-1"
        ));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn required_session_resume_never_falls_back_to_session_new() {
        let (runtime, _events) = fixture_runtime("load-failure").await;

        let error = runtime
            .ensure_loaded_session(
                "thread-load",
                "missing-native-session",
                env!("CARGO_MANIFEST_DIR"),
                &Default::default(),
            )
            .await
            .expect_err("an explicit resume must fail when session/load fails");

        assert!(error.to_string().contains("fixture session is unavailable"));
        assert_eq!(runtime.session_for_thread("thread-load").await, None);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn a_steer_cancels_the_prompt_and_continues_the_same_turn() {
        let (runtime, mut events) = steer_fixture_runtime().await;
        let session_id = runtime
            .ensure_session(
                "thread-steer",
                None,
                env!("CARGO_MANIFEST_DIR"),
                None,
                &Default::default(),
                None,
                None,
            )
            .await
            .expect("fixture session should start");
        let prompt_runtime = Arc::clone(&runtime);
        let prompt_session = session_id.clone();
        let prompt = tokio::spawn(async move {
            prompt_runtime
                .prompt(
                    &prompt_session,
                    vec![json!({ "type": "text", "text": "hold this prompt" })],
                )
                .await
        });
        wait_for_message_delta(&mut events, "SEEN:hold this prompt").await;

        runtime
            .steer_with_cancel(
                &session_id,
                vec![json!({ "type": "text", "text": "use the other endpoint" })],
            )
            .await
            .expect("steer should be accepted while the prompt is in flight");

        // The steered turn resolves with the final segment's stop reason:
        // the steer continued the turn instead of ending it.
        assert_eq!(
            prompt.await.expect("prompt task should join").unwrap(),
            "end_turn"
        );
        let mut stop_reasons = Vec::new();
        let mut saw_steer_delivery = false;
        while stop_reasons.len() < 2 {
            match next_acp_event(&mut events).await {
                AcpEvent::TurnEnded { stop_reason, .. } => stop_reasons.push(stop_reason),
                AcpEvent::MessageDelta { text, .. } => {
                    saw_steer_delivery |= text.contains("use the other endpoint");
                }
                _ => {}
            }
        }
        assert_eq!(
            stop_reasons,
            vec![Some("cancelled".to_string()), Some("end_turn".to_string())]
        );
        assert!(
            saw_steer_delivery,
            "the queued steer should re-prompt on the same session"
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn a_steer_re_sends_the_cancelled_prompt_with_the_steering_text() {
        let (runtime, mut events) = steer_fixture_runtime().await;
        let session_id = runtime
            .ensure_session(
                "thread-steer",
                None,
                env!("CARGO_MANIFEST_DIR"),
                None,
                &Default::default(),
                None,
                None,
            )
            .await
            .expect("fixture session should start");
        let prompt_runtime = Arc::clone(&runtime);
        let prompt_session = session_id.clone();
        let prompt = tokio::spawn(async move {
            prompt_runtime
                .prompt(
                    &prompt_session,
                    vec![json!({ "type": "text", "text": "hold this prompt" })],
                )
                .await
        });
        wait_for_message_delta(&mut events, "SEEN:hold this prompt").await;

        runtime
            .steer_with_cancel(
                &session_id,
                vec![json!({ "type": "text", "text": "use the other endpoint" })],
            )
            .await
            .expect("steer should be accepted while the prompt is in flight");

        assert_eq!(
            prompt.await.expect("prompt task should join").unwrap(),
            "end_turn"
        );
        let mut saw_bundled_original = false;
        let mut saw_bundled_steer = false;
        let mut ended = 0usize;
        while ended < 2 {
            match next_acp_event(&mut events).await {
                AcpEvent::TurnEnded { .. } => ended += 1,
                AcpEvent::MessageDelta { text, .. } => {
                    saw_bundled_original |= text.contains("hold this prompt")
                        && text.contains("interrupted_user_messages");
                    saw_bundled_steer |= text.contains("use the other endpoint")
                        && text.contains("steering_messages");
                }
                _ => {}
            }
        }
        assert!(
            saw_bundled_original && saw_bundled_steer,
            "the steered prompt must re-bundle the cancelled user text"
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn empty_successful_prompt_with_stderr_error_is_diagnosed() {
        let (runtime, mut events) = fixture_runtime("empty-stderr-error").await;
        let session_id = runtime
            .ensure_session(
                "thread-empty-stderr",
                None,
                env!("CARGO_MANIFEST_DIR"),
                None,
                &Default::default(),
                None,
                None,
            )
            .await
            .expect("fixture session should start");
        let stop = runtime
            .prompt(
                &session_id,
                vec![json!({ "type": "text", "text": "hello" })],
            )
            .await
            .expect("empty prompt should still settle");
        assert_eq!(stop, "end_turn");
        let ended = timeout(Duration::from_secs(5), async {
            loop {
                if let AcpEvent::TurnEnded {
                    had_output,
                    stop_reason,
                    error,
                    ..
                } = next_acp_event(&mut events).await
                {
                    return (had_output, stop_reason, error);
                }
            }
        })
        .await
        .expect("turn-ended should arrive");
        assert!(!ended.0);
        assert_eq!(ended.1.as_deref(), Some("end_turn"));
        let diagnostic = ended.2.expect("empty stderr failure must be diagnosed");
        assert!(
            diagnostic.contains("Authentication Failed"),
            "diagnostic should carry the stderr cause: {diagnostic}"
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn a_steer_without_an_active_turn_is_stale() {
        let (runtime, _events) = steer_fixture_runtime().await;
        let session_id = runtime
            .ensure_session(
                "thread-steer",
                None,
                env!("CARGO_MANIFEST_DIR"),
                None,
                &Default::default(),
                None,
                None,
            )
            .await
            .expect("fixture session should start");

        let error = runtime
            .steer_with_cancel(&session_id, vec![json!({ "type": "text", "text": "late" })])
            .await
            .expect_err("a steer with no prompt in flight must not land");

        assert!(error.to_string().contains("no active ACP turn"));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn an_interrupt_ends_a_steered_turn_instead_of_continuing_it() {
        let (runtime, mut events) = steer_fixture_runtime().await;
        let session_id = runtime
            .ensure_session(
                "thread-steer",
                None,
                env!("CARGO_MANIFEST_DIR"),
                None,
                &Default::default(),
                None,
                None,
            )
            .await
            .expect("fixture session should start");
        let prompt_runtime = Arc::clone(&runtime);
        let prompt_session = session_id.clone();
        let prompt = tokio::spawn(async move {
            prompt_runtime
                .prompt(
                    &prompt_session,
                    vec![json!({ "type": "text", "text": "hold the first segment" })],
                )
                .await
        });
        wait_for_message_delta(&mut events, "SEEN:hold the first segment").await;
        runtime
            .steer_with_cancel(
                &session_id,
                vec![json!({ "type": "text", "text": "hold the steered segment" })],
            )
            .await
            .expect("steer should be accepted while the prompt is in flight");
        // The steer continued the turn; its own segment is now in flight.
        wait_for_message_delta(&mut events, "hold the steered segment").await;

        runtime
            .cancel(&session_id)
            .await
            .expect("interrupt should reach the fixture");

        assert_eq!(
            prompt.await.expect("prompt task should join").unwrap(),
            "cancelled"
        );
        runtime.shutdown().await;
    }

    fn command_path(command: &Command) -> Option<String> {
        command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
    }

    #[tokio::test]
    async fn provider_environment_adds_executable_directory_to_path() {
        let mut command = Command::new("/opt/homebrew/bin/pi-acp");

        apply_provider_environment(&mut command, "/opt/homebrew/bin/pi-acp", &HashMap::new()).await;

        let path = command_path(&command).expect("PATH should be set");
        let first = std::env::split_paths(&path).next();
        assert_eq!(first.as_deref(), Some(Path::new("/opt/homebrew/bin")));
    }

    #[tokio::test]
    async fn provider_environment_preserves_explicit_path_override() {
        let mut command = Command::new("/opt/homebrew/bin/pi-acp");
        let provider_env = HashMap::from([("PATH".to_string(), "/custom/bin".to_string())]);

        apply_provider_environment(&mut command, "/opt/homebrew/bin/pi-acp", &provider_env).await;

        assert_eq!(command_path(&command).as_deref(), Some("/custom/bin"));
    }

    #[test]
    fn grok_plan_approval_method_accepts_current_and_legacy_spellings() {
        assert!(is_grok_plan_approval_method("_x.ai/exit_plan_mode"));
        assert!(is_grok_plan_approval_method("x.ai/exit_plan_mode"));
        assert!(!is_grok_plan_approval_method("_x.ai/enter_plan_mode"));
        assert!(is_acp_plan_approval_method("cursor/create_plan"));
        assert!(is_acp_plan_approval_method("x.ai/exit_plan_mode"));
        assert!(!is_acp_plan_approval_method("cursor/ask_question"));
    }

    #[test]
    fn silent_auth_method_picks_cursor_login() {
        assert_eq!(
            silent_acp_auth_method(&json!({
                "authMethods": [
                    { "id": "browser" },
                    { "id": "cursor_login", "name": "Cursor Login" }
                ]
            }))
            .as_deref(),
            Some("cursor_login")
        );
        assert_eq!(silent_acp_auth_method(&json!({ "authMethods": [] })), None);
    }

    #[test]
    fn cursor_plan_content_joins_name_overview_plan_and_todos() {
        let text = cursor_plan_content(&json!({
            "name": "Refactor tabs",
            "overview": "Tighten layout.",
            "plan": "1. Inspect.\n2. Update.",
            "todos": [
                { "id": "1", "content": "Inspect current logic", "status": "completed" },
                { "id": "2", "content": "Update calculations", "status": "pending" }
            ]
        }));
        assert!(text.contains("# Refactor tabs"));
        assert!(text.contains("Tighten layout."));
        assert!(text.contains("1. Inspect."));
        assert!(text.contains("- [x] Inspect current logic"));
        assert!(text.contains("- [ ] Update calculations"));
    }

    #[test]
    fn cursor_questions_keep_option_ids_and_labels() {
        let (questions, options) = parse_cursor_questions(&json!({
            "title": "Need input",
            "questions": [{
                "id": "q1",
                "prompt": "Which mode?",
                "options": [
                    { "id": "agent", "label": "Agent" },
                    { "id": "plan", "label": "Plan" }
                ]
            }]
        }));
        assert_eq!(questions[0].id, "q1");
        assert_eq!(questions[0].header, "Need input");
        assert_eq!(questions[0].question, "Which mode?");
        assert_eq!(questions[0].options.as_ref().unwrap()[0].label, "Agent");
        assert_eq!(
            options.get("q1").map(Vec::as_slice),
            Some(
                [
                    ("agent".to_string(), "Agent".to_string()),
                    ("plan".to_string(), "Plan".to_string())
                ]
                .as_slice()
            )
        );
    }

    #[test]
    fn cursor_plan_approval_rpc_result_uses_nested_outcome() {
        assert_eq!(
            plan_approval_rpc_result(
                PlanApprovalKind::Cursor,
                PlanApprovalOutcome::Approved,
                None
            ),
            json!({ "outcome": { "outcome": "accepted" } })
        );
        assert_eq!(
            plan_approval_rpc_result(
                PlanApprovalKind::Cursor,
                PlanApprovalOutcome::Cancelled,
                Some("change the approach")
            ),
            json!({ "outcome": { "outcome": "rejected", "reason": "change the approach" } })
        );
        assert_eq!(
            plan_approval_rpc_result(PlanApprovalKind::Grok, PlanApprovalOutcome::Approved, None),
            json!({ "outcome": "approved" })
        );
    }

    #[tokio::test]
    async fn grok_plan_mode_reverse_request_is_approved_without_cancelling_the_turn() {
        let (runtime, mut events) = plan_approval_fixture_runtime().await;
        let session_id = runtime
            .ensure_session(
                "thread-1",
                None,
                env!("CARGO_MANIFEST_DIR"),
                None,
                &Default::default(),
                None,
                None,
            )
            .await
            .expect("fixture session should start");
        let prompt_runtime = Arc::clone(&runtime);
        let prompt_session_id = session_id.clone();
        let prompt = tokio::spawn(async move {
            prompt_runtime
                .prompt(
                    &prompt_session_id,
                    vec![json!({ "type": "text", "text": "plan first" })],
                )
                .await
        });

        let event = timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("plan request should arrive")
            .expect("event channel should remain open");
        let AcpEvent::PlanApprovalRequest {
            session_id: event_session_id,
            request_id,
            method,
            tool_call_id,
            plan_content,
        } = event
        else {
            panic!("expected a plan approval request");
        };
        assert_eq!(event_session_id, session_id);
        assert_eq!(method, "x.ai/exit_plan_mode");
        assert_eq!(tool_call_id.as_deref(), Some("fixture-plan-1"));
        assert!(plan_content.contains("Add the regression test"));

        runtime
            .respond_plan_approval(&request_id, PlanApprovalOutcome::Approved, None)
            .await
            .expect("plan response should reach fixture");
        assert_eq!(
            prompt.await.expect("prompt task should join").unwrap(),
            "end_turn"
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn bounded_request_returns_typed_timeout_when_adapter_never_responds() {
        let runtime = timeout_fixture_runtime().await;

        let error = runtime
            .request_with_timeout(
                "session/new",
                json!({ "cwd": env!("CARGO_MANIFEST_DIR"), "mcpServers": [] }),
                Duration::from_millis(50),
            )
            .await
            .expect_err("fixture intentionally withholds the response");
        runtime.shutdown().await;

        assert!(matches!(
            error,
            DaemonError::AcpRequestTimeout { ref method, .. } if method == "session/new"
        ));
    }

    #[tokio::test]
    async fn bounded_request_removes_pending_entry_after_timeout() {
        let runtime = timeout_fixture_runtime().await;

        let _ = runtime
            .request_with_timeout(
                "session/new",
                json!({ "cwd": env!("CARGO_MANIFEST_DIR"), "mcpServers": [] }),
                Duration::from_millis(50),
            )
            .await;
        let pending_count = runtime.pending.lock().await.len();
        runtime.shutdown().await;

        assert_eq!(pending_count, 0);
    }

    #[test]
    fn opencode_stderr_summary_extracts_the_api_call_error() {
        let line = r#"timestamp=2026-06-27T15:45:21.351Z level=ERROR message="stream error" providerID=zai-coding-plan error.error="AI_APICallError: Authentication Failed""#;
        assert_eq!(
            opencode_stderr_error_summary(line).as_deref(),
            Some("Authentication Failed")
        );
        assert!(opencode_stderr_error_summary("info: all good").is_none());
        assert!(prompt_usage_indicates_no_model_tokens(&json!({
            "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 }
        })));
        assert!(!prompt_usage_indicates_no_model_tokens(&json!({})));
        assert!(is_successful_empty_prompt_stop_reason("end_turn"));
        assert!(is_successful_empty_prompt_stop_reason("stop"));
        assert!(!is_successful_empty_prompt_stop_reason("cancelled"));
    }

    #[test]
    fn cancelled_steer_prompt_re_bundles_the_interrupted_user_text() {
        let bundled = bundle_cancelled_acp_prompt(
            &[vec![json!({ "type": "text", "text": "count to 80" })]],
            vec![json!({ "type": "text", "text": "stop counting" })],
        );
        let text = bundled[0]["text"].as_str().expect("bundled text block");
        assert!(text.contains("<interrupted_user_messages>"));
        assert!(text.contains("count to 80"));
        assert!(text.contains("<steering_messages>"));
        assert!(text.contains("stop counting"));
        let unchanged = bundle_cancelled_acp_prompt(
            &[],
            vec![json!({ "type": "text", "text": "just the steer" })],
        );
        assert_eq!(unchanged[0]["text"].as_str(), Some("just the steer"));
    }

    #[test]
    fn permission_selection_never_substitutes_a_different_semantic_choice() {
        let options = vec![
            AcpPermissionOption {
                option_id: "once".to_string(),
                kind: "allow_once".to_string(),
            },
            AcpPermissionOption {
                option_id: "deny".to_string(),
                kind: "reject_once".to_string(),
            },
        ];

        assert_eq!(
            permission_option_for_decision(&options, &ApprovalDecision::Allow)
                .map(|option| option.option_id.as_str()),
            Some("once")
        );
        assert_eq!(
            permission_option_for_decision(&options, &ApprovalDecision::Deny)
                .map(|option| option.option_id.as_str()),
            Some("deny")
        );
        assert!(permission_option_for_decision(&options, &ApprovalDecision::AlwaysAllow).is_none());
    }

    #[test]
    fn method_capabilities_accept_current_objects_and_legacy_booleans() {
        assert!(capability_enabled(Some(&json!({}))));
        assert!(capability_enabled(Some(&json!(true))));
        assert!(!capability_enabled(Some(&json!(false))));
        assert!(!capability_enabled(Some(&Value::Null)));
        assert!(!capability_enabled(None));
    }

    #[test]
    fn pi_session_config_normalizes_models_and_thinking_levels() {
        let parsed = parse_session_metadata(&json!({
            "sessionId": "pi-session",
            "configOptions": [
                {
                    "id": "model",
                    "category": "model",
                    "currentValue": "openrouter/kimi",
                    "options": [
                        { "value": "openrouter/kimi", "name": "Kimi" },
                        { "value": "openai/gpt", "name": "GPT" }
                    ]
                },
                {
                    "id": "thought_level",
                    "category": "thought_level",
                    "currentValue": "medium",
                    "options": [
                        { "value": "off", "name": "Thinking: off" },
                        { "value": "medium", "name": "Thinking: medium" }
                    ]
                }
            ]
        }));
        assert_eq!(parsed.models.len(), 2);
        assert_eq!(parsed.models[0].id, "openrouter/kimi");
        assert!(parsed.models[0].is_default);
        assert_eq!(
            parsed.models[0].default_reasoning_effort.as_deref(),
            Some("medium")
        );
        assert_eq!(
            parsed.models[0]
                .supported_reasoning_efforts
                .iter()
                .map(|effort| effort.reasoning_effort.as_str())
                .collect::<Vec<_>>(),
            vec!["off", "medium"]
        );
        assert!(parsed.permission_modes.is_empty());
    }

    #[test]
    fn agent_modes_are_collaboration_modes_not_permissions() {
        let parsed = parse_session_metadata(&json!({
            "sessionId": "opencode-session",
            "configOptions": [{
                "id": "mode",
                "category": "mode",
                "currentValue": "build",
                "options": [
                    { "value": "build", "name": "Build" },
                    { "value": "plan", "name": "Plan" }
                ]
            }]
        }));

        assert!(parsed.permission_modes.is_empty());
        assert_eq!(
            parsed
                .collaboration_modes
                .iter()
                .map(|mode| mode.id.as_str())
                .collect::<Vec<_>>(),
            vec!["build", "plan"]
        );
        assert_eq!(
            parsed.configuration.collaboration_config_id.as_deref(),
            Some("mode")
        );
    }

    #[test]
    fn cursor_modes_from_both_surfaces_are_deduped() {
        let parsed = parse_session_metadata(&json!({
            "modes": {
                "currentModeId": "agent",
                "availableModes": [
                    { "id": "agent", "name": "Agent" },
                    { "id": "plan", "name": "Plan" },
                    { "id": "ask", "name": "Ask" }
                ]
            },
            "configOptions": [{
                "id": "mode",
                "category": "mode",
                "currentValue": "agent",
                "options": [
                    { "value": "agent", "name": "Agent" },
                    { "value": "plan", "name": "Plan" },
                    { "value": "ask", "name": "Ask" }
                ]
            }]
        }));
        assert_eq!(
            parsed
                .collaboration_modes
                .iter()
                .map(|mode| mode.id.as_str())
                .collect::<Vec<_>>(),
            vec!["agent", "plan", "ask"]
        );
    }

    #[test]
    fn cursor_placeholder_catalog_includes_permission_modes() {
        let capabilities = cursor_placeholder_capabilities();
        assert!(capabilities.supports_images);
        assert_eq!(
            capabilities.permission_modes,
            cursor_placeholder_permission_modes()
        );
        assert_eq!(
            placeholder_permission_modes_for("cursor"),
            cursor_placeholder_permission_modes()
        );
        assert_eq!(
            cursor_placeholder_collaboration_modes()
                .iter()
                .map(|mode| mode.id.as_str())
                .collect::<Vec<_>>(),
            vec!["agent", "plan", "ask"]
        );
    }

    #[test]
    fn grok_placeholder_catalog_is_selectable_before_acp_connects() {
        let models = grok_placeholder_models();
        assert_eq!(models[0].id, "grok-4.6");
        assert!(models[0].is_default);
        assert_eq!(models[0].default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            models[0]
                .supported_reasoning_efforts
                .iter()
                .map(|effort| effort.reasoning_effort.as_str())
                .collect::<Vec<_>>(),
            vec!["xhigh", "high", "medium", "low"]
        );
        assert_eq!(models[1].id, "grok-4.5");
        let capabilities = grok_placeholder_capabilities();
        assert!(capabilities.supports_images);
        assert_eq!(
            capabilities.permission_modes,
            grok_placeholder_permission_modes()
        );
    }

    #[test]
    fn grok_initialize_model_state_populates_the_catalog() {
        let models = parse_initialize_models(&json!({
            "protocolVersion": 1,
            "agentCapabilities": { "loadSession": true },
            "_meta": {
                "modelState": {
                    "currentModelId": "grok-4.6",
                    "availableModels": [
                        {
                            "modelId": "grok-4.6",
                            "name": "Grok 4.6",
                            "_meta": {
                                "reasoningEffort": "high",
                                "reasoningEfforts": [
                                    { "id": "xhigh", "label": "Extra High Effort" },
                                    { "id": "high", "label": "High Effort" },
                                    { "id": "medium", "label": "Medium Effort" },
                                    { "id": "low", "label": "Low Effort" }
                                ]
                            }
                        },
                        {
                            "modelId": "grok-4.5",
                            "name": "Grok 4.5",
                            "_meta": {
                                "reasoningEffort": "high",
                                "reasoningEfforts": [
                                    { "id": "high", "label": "High Effort" },
                                    { "id": "medium", "label": "Medium Effort" },
                                    { "id": "low", "label": "Low Effort" }
                                ]
                            }
                        }
                    ]
                }
            }
        }));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "grok-4.6");
        assert!(models[0].is_default);
        assert_eq!(
            models[0]
                .supported_reasoning_efforts
                .iter()
                .map(|effort| effort.reasoning_effort.as_str())
                .collect::<Vec<_>>(),
            vec!["xhigh", "high", "medium", "low"]
        );
        assert_eq!(models[0].default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(models[1].id, "grok-4.5");
        assert!(!models[1].is_default);
    }

    #[test]
    fn grok_session_new_meta_sends_model_id_at_creation() {
        assert_eq!(
            grok_session_new_meta(Some("grok-4.5"), None),
            Some(json!({ "modelId": "grok-4.5" }))
        );
        assert_eq!(
            grok_session_new_meta(Some("grok-4.5"), Some("always-approve")),
            Some(json!({ "modelId": "grok-4.5", "yoloMode": true }))
        );
        assert_eq!(
            grok_session_new_meta(None, Some("auto")),
            Some(json!({ "autoMode": true }))
        );
        assert_eq!(grok_session_new_meta(Some("  "), None), None);
        assert_eq!(grok_session_new_meta(None, None), None);
    }

    #[test]
    fn grok_session_metadata_keeps_effort_out_of_permission_modes() {
        let parsed = parse_session_metadata(&json!({
            "models": {
                "currentModelId": "grok-4.5",
                "availableModels": [{
                    "modelId": "grok-4.5",
                    "name": "Grok 4.5",
                    "_meta": {
                        "reasoningEffort": "high",
                        "reasoningEfforts": [
                            { "id": "low", "label": "Low Effort" },
                            { "id": "high", "label": "High Effort" }
                        ]
                    }
                }]
            },
            "metaOptions": [
                { "id": "high", "category": "mode", "label": "High Effort" },
                { "id": "low", "category": "mode", "label": "Low Effort" }
            ]
        }));
        assert_eq!(parsed.models[0].id, "grok-4.5");
        assert!(parsed.models[0].is_default);
        assert_eq!(parsed.reasoning_efforts.len(), 2);
        assert!(parsed.permission_modes.is_empty());
    }

    #[test]
    fn loads_and_filters_provider_configs() {
        let dir = tempfile::tempdir().unwrap();
        // `echo` and `sh` stand in for installed agent CLIs; the filter
        // requires the binary to actually resolve on this machine.
        std::fs::write(
            dir.path().join("providers.json"),
            serde_json::to_string(&json!({
                "providers": {
                    "mockagent": { "command": ["echo", "agent", "stdio"], "label": "Mock" },
                    "codex": { "command": ["sh"], "label": "Nope" },
                    "agy": { "command": ["sh"], "label": "Nope" },
                    "empty": { "command": [], "label": "Empty" },
                    "unlabeled": { "command": ["sh", "acp"], "label": "  " },
                    "notinstalled": { "command": ["definitely-not-a-real-binary-xyz"], "label": "Ghost" }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let configs = load_acp_provider_configs(dir.path());
        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].id, "mockagent");
        assert_eq!(configs[0].label, "Mock");
        assert_eq!(configs[0].command, vec!["echo", "agent", "stdio"]);
        assert_eq!(configs[1].id, "unlabeled");
        assert_eq!(configs[1].label, "unlabeled");
    }

    #[test]
    fn provider_transport_defaults_to_auto_and_accepts_explicit_acp() {
        let defaulted: AcpProviderConfig = serde_json::from_value(json!({
            "command": ["opencode", "acp"]
        }))
        .unwrap();
        assert_eq!(defaulted.transport, ProviderTransport::Auto);

        let explicit: AcpProviderConfig = serde_json::from_value(json!({
            "command": ["opencode", "acp"],
            "transport": "acp"
        }))
        .unwrap();
        assert_eq!(explicit.transport, ProviderTransport::Acp);
    }

    #[test]
    fn missing_config_file_yields_no_providers() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_acp_provider_configs(dir.path()).is_empty());
    }

    #[test]
    fn provider_revision_rejects_a_stale_read_modify_write() {
        let dir = tempfile::tempdir().unwrap();
        let initial = providers_overview(dir.path());
        let initial_revision = initial["revision"].as_str().unwrap();

        write_providers_file_if_revision(
            dir.path(),
            &json!({ "first": { "label": "First", "command": ["echo"] } }),
            initial_revision,
        )
        .unwrap();

        let stale = write_providers_file_if_revision(
            dir.path(),
            &json!({ "second": { "label": "Second", "command": ["echo"] } }),
            initial_revision,
        )
        .unwrap_err();
        assert_eq!(stale, "providers changed since they were loaded");

        let overview = providers_overview(dir.path());
        assert!(overview["providers"].get("first").is_some());
        assert!(overview["providers"].get("second").is_none());
        assert_ne!(overview["revision"].as_str().unwrap(), initial_revision);
    }

    #[test]
    fn grok_image_capability_overrides_false_advertisement() {
        assert!(super::acp_supports_images("grok", false));
        assert!(super::acp_supports_images("Grok", true));
        assert!(!super::acp_supports_images("opencode", false));
        assert!(super::acp_supports_images("opencode", true));
        assert!(!super::acp_supports_images("gemini", false));
    }

    #[test]
    fn only_grok_acp_is_probed_for_vendor_interjection() {
        assert!(super::acp_may_support_interject("grok"));
        assert!(super::acp_may_support_interject("Grok"));
        assert!(!super::acp_may_support_interject("opencode"));
        assert!(!super::acp_may_support_interject("pi"));
    }

    #[test]
    fn interject_probe_rejects_missing_method_but_accepts_known_method_errors() {
        assert!(!super::acp_interject_probe_supported(&Err(
            DaemonError::Rpc("Method not found (grok)".to_string())
        )));
        assert!(super::acp_interject_probe_supported(&Err(
            DaemonError::Rpc("session not found: probe (grok)".to_string())
        )));
    }
}

#[cfg(test)]
mod assistant_text_tests {
    use super::merge_assistant_chunk;

    #[test]
    fn snapshot_chunks_replace_instead_of_duplicating() {
        // Agents that re-send the whole message so far (Grok CLI).
        let mut text = String::new();
        merge_assistant_chunk(&mut text, "I'll inspect the screenshot.");
        merge_assistant_chunk(
            &mut text,
            "I'll inspect the screenshot. Unread-only threads are promoted.",
        );
        assert_eq!(
            text,
            "I'll inspect the screenshot. Unread-only threads are promoted."
        );
    }

    #[test]
    fn true_deltas_still_append() {
        let mut text = String::new();
        merge_assistant_chunk(&mut text, "Hello");
        merge_assistant_chunk(&mut text, " world");
        assert_eq!(text, "Hello world");
        // A repeated delta is not a snapshot of itself: appending is correct.
        merge_assistant_chunk(&mut text, "!");
        merge_assistant_chunk(&mut text, "!");
        assert_eq!(text, "Hello world!!");
    }
}
