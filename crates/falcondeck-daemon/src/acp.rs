//! Generic Agent Client Protocol (ACP) adapter.
//!
//! ACP is JSON-RPC 2.0 over stdio, spoken by Grok Build (`grok agent stdio`),
//! OpenCode (`opencode acp`), Gemini CLI, and others. FalconDeck acts as the
//! ACP *client*: it spawns the configured agent command once per workspace,
//! negotiates capabilities via `initialize`, opens one ACP session per thread,
//! and streams `session/update` notifications into the daemon's unified
//! conversation model.
//!
//! Providers are configured by data, not code: a `providers.json` next to the
//! daemon state file declares `{ id: { command: [...], label: "..." } }` and
//! each entry becomes a selectable provider with no Rust changes.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use falcondeck_core::{AgentProvider, ApprovalDecision, ImageInput, PlanStep, ThreadPlan};

use crate::agent_binary::resolve_agent_binary;
use crate::error::DaemonError;

/// Largest raw image file embedded inline for an ACP prompt, mirroring the
/// Claude path's per-image cap.
const MAX_ACP_IMAGE_BYTES: u64 = 3_500_000;

/// Total encoded-image budget per turn, mirroring the Claude path: without it
/// many individually-legal images could produce a single stdin line in the
/// hundreds of megabytes.
pub const MAX_ACP_TOTAL_ENCODED_IMAGE_BYTES: usize = 10_000_000;

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
}

#[derive(Debug, Default, Deserialize)]
struct ProvidersFile {
    #[serde(default)]
    providers: HashMap<String, AcpProviderConfig>,
}

/// Raw + resolved view of `providers.json` for the settings UI. Entries whose
/// binary is missing are included with `binary_found: false` so the panel can
/// explain why a configured provider is hidden from pickers.
pub fn providers_overview(state_dir: &Path) -> Value {
    let path = state_dir.join("providers.json");
    let raw: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_else(|| json!({ "providers": {} }));
    let entries = raw
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
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
                "reserved": id == "codex" || id == "claude",
                "malformed": malformed,
            })
        })
        .collect::<Vec<_>>();
    json!({ "providers": entries, "resolved": resolved })
}

/// Validates and atomically writes `providers.json` (`{"providers": …}`).
pub fn write_providers_file(state_dir: &Path, providers: &Value) -> Result<(), String> {
    let entries = providers
        .as_object()
        .ok_or("invalid providers payload: expected an object of provider entries")?;
    for (id, entry) in entries {
        if id == "codex" || id == "claude" {
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
                    let reserved = id == "codex" || id == "claude";
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

/// Normalized events the runtime emits toward the app layer.
#[derive(Debug)]
pub enum AcpEvent {
    /// Streaming assistant text for a session.
    MessageDelta { session_id: String, text: String },
    /// A tool call started or was announced.
    ToolCall {
        session_id: String,
        call_id: String,
        title: String,
        kind: String,
        status: String,
    },
    /// A tool call changed status or produced output.
    ToolCallUpdate {
        session_id: String,
        call_id: String,
        title: Option<String>,
        status: Option<String>,
        output: Option<String>,
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
    /// The agent finished a prompt turn; ordered after that turn's deltas.
    TurnEnded { session_id: String },
    /// The agent process died or the stream broke.
    Fatal { message: String },
}

struct PendingPermission {
    raw_id: Value,
    options: Vec<AcpPermissionOption>,
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
    permission_requests: Mutex<HashMap<String, PendingPermission>>,
    /// Per-session accumulating assistant item for the current turn.
    current_items: Mutex<HashMap<String, (String, String)>>,
    /// Tool titles/kinds by call id, for enriching status updates.
    current_tools: Mutex<HashMap<String, (String, String)>>,
    /// Session modes advertised via session/new (or session/load), by
    /// session id. Backs the permission-mode picker for ACP providers.
    session_modes: Mutex<HashMap<String, SessionModeState>>,
    initialize_result: Mutex<Option<Value>>,
    closed: AtomicBool,
    events: mpsc::UnboundedSender<AcpEvent>,
}

/// ACP session mode state: the agent's current mode plus the ids it accepts
/// through `session/set_mode`.
#[derive(Debug, Clone, Default)]
pub struct SessionModeState {
    pub current: Option<String>,
    pub available: Vec<String>,
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
        command
            .args(&config.command[1..])
            .current_dir(workspace_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
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
            permission_requests: Mutex::new(HashMap::new()),
            current_items: Mutex::new(HashMap::new()),
            current_tools: Mutex::new(HashMap::new()),
            session_modes: Mutex::new(HashMap::new()),
            initialize_result: Mutex::new(None),
            closed: AtomicBool::new(false),
            events,
        });

        tokio::spawn(Self::read_loop(Arc::clone(&runtime), stdout));

        let init = runtime
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    }
                }),
            )
            .await?;
        *runtime.initialize_result.lock().await = Some(init);
        Ok(runtime)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
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
        let supports_images = init
            .as_ref()
            .and_then(|init| init.pointer("/agentCapabilities/promptCapabilities/image"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        falcondeck_core::AgentCapabilitySummary {
            supports_interrupt: true,
            supports_images,
            ..falcondeck_core::AgentCapabilitySummary::default()
        }
    }

    /// Models advertised in the `initialize` response, when the agent exposes
    /// a catalog (`models` or `agentCapabilities/models`). Baseline ACP has no
    /// model listing, so an empty result is the common case.
    pub async fn advertised_models(&self) -> Vec<falcondeck_core::ModelSummary> {
        let init = self.initialize_result.lock().await;
        let Some(init) = init.as_ref() else {
            return Vec::new();
        };
        let entries = init.get("models").and_then(Value::as_array).or_else(|| {
            init.pointer("/agentCapabilities/models")
                .and_then(Value::as_array)
        });
        entries
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let id = entry
                    .get("modelId")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)?
                    .to_string();
                Some(falcondeck_core::ModelSummary {
                    label: entry
                        .get("name")
                        .or_else(|| entry.get("label"))
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_string(),
                    id,
                    is_default: entry
                        .get("default")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    default_reasoning_effort: None,
                    supported_reasoning_efforts: Vec::new(),
                })
            })
            .collect()
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
        if self.is_closed() {
            return Err(DaemonError::Process(format!(
                "ACP provider '{}' is not running",
                self.config.id
            )));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;
        receiver.await.map_err(|_| {
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

    /// Returns the ACP session id for a thread, creating a session on demand.
    ///
    /// When the thread carries a native session id from a previous daemon run
    /// and the agent negotiated `loadSession`, the session is resumed with
    /// `session/load` — the agent replays the conversation through
    /// `session/update` notifications, which repopulates the (empty after
    /// restart) in-memory thread history. Any load failure falls back to a
    /// fresh session.
    pub async fn ensure_session(
        &self,
        thread_id: &str,
        known_native_session: Option<&str>,
    ) -> Result<String, DaemonError> {
        if let Some(existing) = self.sessions.lock().await.get(thread_id) {
            return Ok(existing.clone());
        }
        let mcp_servers = crate::connectors::acp_mcp_servers(&crate::connectors::load_mcp_servers(
            &self.workspace_path,
            &self.config.id,
        ));

        if let Some(native_session) = known_native_session
            .map(str::trim)
            .filter(|id| !id.is_empty())
            && self.supports_load_session().await
        {
            // The agent replays the conversation as session/update
            // notifications DURING the session/load request, so the
            // session→thread mapping must exist before the request goes out
            // or the event pump drops the entire replayed history.
            self.register_session(thread_id, native_session).await;
            let loaded = self
                .request(
                    "session/load",
                    json!({
                        "sessionId": native_session,
                        "cwd": self.workspace_path,
                        "mcpServers": mcp_servers.clone()
                    }),
                )
                .await;
            match loaded {
                Ok(result) => {
                    self.capture_session_modes(native_session, result.get("modes"))
                        .await;
                    return Ok(native_session.to_string());
                }
                Err(error) => {
                    self.unregister_session(thread_id, native_session).await;
                    tracing::info!(
                        provider = %self.config.id,
                        %error,
                        "ACP session/load failed; starting a fresh session"
                    );
                }
            }
        }

        let result = self
            .request(
                "session/new",
                json!({
                    "cwd": self.workspace_path,
                    "mcpServers": mcp_servers
                }),
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| DaemonError::Rpc("ACP session/new returned no sessionId".to_string()))?
            .to_string();
        self.register_session(thread_id, &session_id).await;
        self.capture_session_modes(&session_id, result.get("modes"))
            .await;
        Ok(session_id)
    }

    /// Records the modes block from a session/new or session/load response.
    async fn capture_session_modes(&self, session_id: &str, modes: Option<&Value>) {
        let Some(modes) = modes else { return };
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

    /// Switches the session's mode via `session/set_mode`.
    pub async fn set_session_mode(
        &self,
        session_id: &str,
        mode_id: &str,
    ) -> Result<(), DaemonError> {
        self.request(
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": mode_id }),
        )
        .await?;
        if let Some(state) = self.session_modes.lock().await.get_mut(session_id) {
            state.current = Some(mode_id.to_string());
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

    /// Runs one prompt turn; resolves when the agent reports a stop reason.
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
        let content = if content.is_empty() {
            vec![json!({ "type": "text", "text": "[empty prompt]" })]
        } else {
            content
        };
        let result = self
            .request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": content
                }),
            )
            .await;
        let _ = self.events.send(AcpEvent::TurnEnded {
            session_id: session_id.to_string(),
        });
        let result = result?;
        Ok(result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn")
            .to_string())
    }

    /// Appends assistant text for the session's current turn, creating the
    /// turn's item on first delta. Returns the item id and full text so far.
    pub async fn append_assistant_text(&self, session_id: &str, delta: &str) -> (String, String) {
        let mut items = self.current_items.lock().await;
        let entry = items.entry(session_id.to_string()).or_insert_with(|| {
            (
                format!("acp-msg-{}", uuid::Uuid::new_v4().simple()),
                String::new(),
            )
        });
        entry.1.push_str(delta);
        (entry.0.clone(), entry.1.clone())
    }

    /// Ends the current turn for a session so the next one gets a fresh item.
    pub async fn end_turn(&self, session_id: &str) {
        self.current_items.lock().await.remove(session_id);
    }

    /// Records a tool call's identity for later status updates.
    pub async fn remember_tool(&self, call_id: &str, title: &str, kind: &str) {
        self.current_tools
            .lock()
            .await
            .insert(call_id.to_string(), (title.to_string(), kind.to_string()));
    }

    /// Looks up a previously announced tool call's identity.
    pub async fn tool_identity(&self, call_id: &str) -> Option<(String, String)> {
        self.current_tools.lock().await.get(call_id).cloned()
    }

    /// All thread ids with live sessions on this runtime.
    pub async fn active_thread_ids(&self) -> Vec<String> {
        self.sessions.lock().await.keys().cloned().collect()
    }

    /// Cancels the in-flight turn for a session.
    pub async fn cancel(&self, session_id: &str) -> Result<(), DaemonError> {
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await
    }

    /// Answers a pending `session/request_permission` with a user decision.
    pub async fn respond_permission(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), DaemonError> {
        let pending = self
            .permission_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| DaemonError::NotFound("ACP permission request not found".to_string()))?;
        let wanted = match decision {
            ApprovalDecision::Allow => "allow_once",
            ApprovalDecision::AlwaysAllow => "allow_always",
            ApprovalDecision::Deny => "reject_once",
        };
        let fallback_prefix = match decision {
            ApprovalDecision::Deny => "reject",
            _ => "allow",
        };
        let option = pending
            .options
            .iter()
            .find(|option| option.kind == wanted)
            .or_else(|| {
                pending
                    .options
                    .iter()
                    .find(|option| option.kind.starts_with(fallback_prefix))
            })
            .or(pending.options.first());
        let Some(option) = option else {
            return Err(DaemonError::Rpc(
                "ACP permission request offered no options".to_string(),
            ));
        };
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": pending.raw_id,
            "result": {
                "outcome": { "outcome": "selected", "optionId": option.option_id }
            }
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
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                tracing::debug!(provider = %runtime.config.id, "non-JSON ACP output ignored");
                continue;
            };
            runtime.handle_message(message).await;
        }
        runtime.closed.store(true, Ordering::Release);
        let mut pending = runtime.pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(DaemonError::Process(format!(
                "ACP provider '{}' exited",
                runtime.config.id
            ))));
        }
        let _ = runtime.events.send(AcpEvent::Fatal {
            message: format!("{} agent process exited", runtime.config.label),
        });
    }

    async fn handle_message(&self, message: Value) {
        let has_id = message.get("id").is_some();
        let has_method = message.get("method").is_some();
        if has_id && !has_method {
            // Response to one of our requests.
            let Some(id) = message.get("id").and_then(Value::as_i64) else {
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
            "session/request_permission" => {
                let raw_id = message.get("id").cloned().unwrap_or(Value::Null);
                self.handle_permission_request(raw_id, &params).await;
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
        let event =
            match kind {
                "agent_message_chunk" => update
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .map(|text| AcpEvent::MessageDelta {
                        session_id: session_id.to_string(),
                        text: text.to_string(),
                    }),
                // Thought chunks are internal reasoning; fold them away for now.
                "agent_thought_chunk" => None,
                // The agent switched modes on its own (or confirmed ours).
                "current_mode_update" => {
                    if let Some(mode_id) = update.get("currentModeId").and_then(Value::as_str)
                        && let Some(state) = self.session_modes.lock().await.get_mut(session_id)
                    {
                        state.current = Some(mode_id.to_string());
                    }
                    None
                }
                "tool_call" => {
                    let call_id = update
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    Some(AcpEvent::ToolCall {
                        session_id: session_id.to_string(),
                        call_id,
                        title: update
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("Tool call")
                            .to_string(),
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
                    })
                }
                "tool_call_update" => {
                    let call_id = update
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let output = update
                        .get("content")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| {
                                    item.pointer("/content/text")
                                        .or_else(|| item.get("text"))
                                        .and_then(Value::as_str)
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .filter(|text| !text.is_empty());
                    Some(AcpEvent::ToolCallUpdate {
                        session_id: session_id.to_string(),
                        call_id,
                        title: update
                            .get("title")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned),
                        status: update
                            .get("status")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned),
                        output,
                    })
                }
                "plan" => {
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
                                    Some(PlanStep {
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
                _ => None,
            };
        if let Some(event) = event {
            let _ = self.events.send(event);
        }
    }

    async fn handle_permission_request(&self, raw_id: Value, params: &Value) {
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn missing_config_file_yields_no_providers() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_acp_provider_configs(dir.path()).is_empty());
    }
}
