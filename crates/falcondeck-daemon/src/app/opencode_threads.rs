//! App integration for OpenCode's native HTTP session API.

use std::sync::Arc;

use chrono::Utc;
use falcondeck_core::{
    AccountStatus, AgentCapabilitySummary, ApprovalDecision, CollaborationModeSummary,
    ContentLifecycle, ConversationItem, ImageInput, InteractiveQuestion, InteractiveQuestionOption,
    InteractiveRequest, InteractiveRequestKind, ModelSummary, ReasoningEffortSummary, ServiceLevel,
    ThreadStatus, TurnInputItem, UnifiedEvent,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    acp::{AcpProviderConfig, ProviderTransport},
    error::DaemonError,
    opencode::{Delivery, OpenCodeRuntime},
};

use super::{
    AppState, PendingServerRequest,
    agent_helpers::{
        AttachmentKind, ResolvedSelectedSkill, attachment_kind, replace_selected_skill_aliases,
    },
    conversation_helpers::{ToolSettlement, synthesize_tool_title, tool_display_metadata},
};

impl AppState {
    pub(super) fn opencode_config(&self) -> Option<AcpProviderConfig> {
        self.fresh_acp_provider_configs()
            .into_iter()
            .find(|config| config.id.eq_ignore_ascii_case("opencode"))
    }

    pub(super) async fn opencode_runtime_for(
        &self,
        workspace_id: &str,
    ) -> Result<Arc<OpenCodeRuntime>, DaemonError> {
        let existing = self
            .inner
            .workspaces
            .lock()
            .await
            .get(workspace_id)
            .and_then(|workspace| workspace.opencode_runtime.clone());
        if let Some(runtime) = existing {
            if runtime.health().await.is_ok() {
                return Ok(runtime);
            }
            let removed = self
                .inner
                .workspaces
                .lock()
                .await
                .get_mut(workspace_id)
                .and_then(|workspace| workspace.opencode_runtime.take());
            if let Some(runtime) = removed {
                runtime.shutdown().await;
            }
        }

        let provider = falcondeck_core::AgentProvider::new("opencode".to_string());
        let gate = {
            let mut gates = self.inner.acp_runtime_gates.lock().await;
            Arc::clone(
                gates
                    .entry((
                        workspace_id.to_string(),
                        super::acp_threads::AcpRuntimeKey::new(&provider, None),
                    ))
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _gate = gate.lock().await;
        if let Some(runtime) = self
            .inner
            .workspaces
            .lock()
            .await
            .get(workspace_id)
            .and_then(|workspace| workspace.opencode_runtime.clone())
        {
            if runtime.health().await.is_ok() {
                return Ok(runtime);
            }
            let removed = self
                .inner
                .workspaces
                .lock()
                .await
                .get_mut(workspace_id)
                .and_then(|workspace| workspace.opencode_runtime.take());
            if let Some(runtime) = removed {
                runtime.shutdown().await;
            }
        }

        // Keep optional provider startup bounded across workspaces. Cached
        // runtimes were returned above without consuming a startup slot.
        let _startup_permit = self.inner.runtime_lifecycle.optional_start_permit().await?;

        let config = self.opencode_config().ok_or_else(|| {
            DaemonError::BadRequest("OpenCode is not configured in providers.json".to_string())
        })?;
        let workspace_path = self
            .inner
            .workspaces
            .lock()
            .await
            .get(workspace_id)
            .map(|workspace| workspace.summary.path.clone())
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let mut env = config.env.clone();
        let servers = crate::connectors::with_builtin_servers(
            crate::connectors::materialize_mcp_servers(&workspace_path, "opencode").await,
            &self
                .builtin_connectors(
                    &falcondeck_core::AgentProvider::OPENCODE,
                    &workspace_path,
                    None,
                )
                .await,
        );
        if !servers.is_empty() {
            env.insert(
                "OPENCODE_CONFIG_CONTENT".to_string(),
                crate::connectors::opencode_config_content(&servers),
            );
        }
        let runtime = OpenCodeRuntime::spawn(&config.command, &workspace_path, &env).await?;
        {
            let mut workspaces = self.inner.workspaces.lock().await;
            if let Some(workspace) = workspaces.get_mut(workspace_id) {
                workspace.opencode_runtime = Some(Arc::clone(&runtime));
            } else {
                drop(workspaces);
                runtime.shutdown().await;
                return Err(DaemonError::NotFound("workspace not found".to_string()));
            }
        }
        self.schedule_opencode_idle_retirement(workspace_id, Arc::clone(&runtime));
        if let (Some(state_dir), Some(server_pid)) = (self.state_dir(), runtime.server_pid()) {
            crate::opencode::register_server_process(&state_dir, server_pid);
        }
        if let Err(error) = self
            .publish_opencode_native_metadata(workspace_id, &runtime)
            .await
        {
            // A real turn performs its own compatibility checks and can fall
            // back to ACP. Catalog refinement is useful but must not make the
            // selected provider unavailable.
            tracing::info!(%error, "native OpenCode metadata unavailable after startup");
        }
        Ok(runtime)
    }

    pub(super) async fn set_opencode_native_available(&self, workspace_id: &str, available: bool) {
        let mut workspaces = self.inner.workspaces.lock().await;
        let Some(agent) = workspaces.get_mut(workspace_id).and_then(|workspace| {
            workspace
                .summary
                .agents
                .iter_mut()
                .find(|agent| agent.provider.as_str().eq_ignore_ascii_case("opencode"))
        }) else {
            return;
        };
        // Steering survives the ACP fallback: without native `delivery:
        // "steer"` the daemon cancels the in-flight ACP prompt and re-prompts
        // on the same session.
        agent.capabilities.supports_steering = true;
        agent.capabilities.supports_images = available || agent.capabilities.supports_images;
        if available {
            agent.capabilities.permission_modes = native_permission_modes();
        }
        agent.account.label = if available {
            "OpenCode native connected".to_string()
        } else {
            "OpenCode using ACP fallback".to_string()
        };
    }

    /// Publishes normalized metadata after the user first starts OpenCode.
    /// Raw provider responses can contain credentials and stay in this module.
    async fn publish_opencode_native_metadata(
        &self,
        workspace_id: &str,
        runtime: &Arc<OpenCodeRuntime>,
    ) -> Result<(), DaemonError> {
        runtime.validate_contract().await?;
        let (catalog, agents) = tokio::try_join!(runtime.provider_catalog(), runtime.agents())?;
        let models = parse_native_models(&catalog)?;
        let collaboration_modes = parse_native_agents(&agents);
        let workspace = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get_mut(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let agent = workspace
                .summary
                .agents
                .iter_mut()
                .find(|agent| agent.provider.as_str().eq_ignore_ascii_case("opencode"))
                .ok_or_else(|| {
                    DaemonError::NotFound("OpenCode workspace agent not found".to_string())
                })?;
            agent.account.status = AccountStatus::Ready;
            agent.account.label = "OpenCode native connected".to_string();
            agent.capabilities = native_capabilities();
            agent.models = models;
            agent.collaboration_modes = collaboration_modes;
            agent.models_loading = false;
            workspace.summary.clone()
        };
        self.emit(
            Some(workspace_id.to_string()),
            None,
            UnifiedEvent::WorkspaceUpdated { workspace },
        );
        Ok(())
    }

    pub(super) async fn respond_opencode_permission(
        &self,
        workspace_id: &str,
        thread_id: &str,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), DaemonError> {
        let session_id = self
            .thread_summary(workspace_id, thread_id)
            .await?
            .native_session_id
            .ok_or_else(|| {
                DaemonError::BadRequest("native OpenCode thread has no session id".to_string())
            })?;
        let reply = match decision {
            ApprovalDecision::Allow => "once",
            ApprovalDecision::AlwaysAllow => "always",
            ApprovalDecision::Deny => "reject",
        };
        self.opencode_runtime_for(workspace_id)
            .await?
            .reply_permission(&session_id, request_id, reply)
            .await
    }

    pub(super) async fn respond_opencode_question(
        &self,
        workspace_id: &str,
        thread_id: &str,
        request_id: &str,
        answers: Vec<Vec<String>>,
    ) -> Result<(), DaemonError> {
        let session_id = self
            .thread_summary(workspace_id, thread_id)
            .await?
            .native_session_id
            .ok_or_else(|| {
                DaemonError::BadRequest("native OpenCode thread has no session id".to_string())
            })?;
        self.opencode_runtime_for(workspace_id)
            .await?
            .reply_question(&session_id, request_id, answers)
            .await
    }

    pub(super) fn schedule_opencode_thread_hydration(&self, workspace_id: &str, thread_id: &str) {
        let app = self.clone();
        let workspace_id = workspace_id.to_string();
        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            let result: Result<(), DaemonError> = async {
                let session_id = app
                    .thread_summary(&workspace_id, &thread_id)
                    .await?
                    .native_session_id
                    .ok_or_else(|| {
                        DaemonError::BadRequest(
                            "native OpenCode thread has no session id".to_string(),
                        )
                    })?;
                let messages = app
                    .opencode_runtime_for(&workspace_id)
                    .await?
                    .messages(&session_id)
                    .await?;
                project_messages(&app, &workspace_id, &thread_id, &messages, true).await
            }
            .await;
            match result {
                Ok(()) => {
                    // Mark the transcript synced and bump `updated_at` so
                    // clients holding a cached partial detail refetch instead
                    // of treating their prefix as complete.
                    let marked = app
                        .with_managed_thread_mut(&workspace_id, &thread_id, |thread| {
                            thread.native_transcript_synced = true;
                            thread.summary.updated_at = Utc::now();
                        })
                        .await;
                    if marked.is_ok()
                        && let Ok(thread) = app.thread_summary(&workspace_id, &thread_id).await
                    {
                        if super::is_shutdown_interrupted(
                            &thread.status,
                            thread.last_error.as_deref(),
                        ) {
                            app.settle_turn_items_with_error(
                                &workspace_id,
                                &thread_id,
                                Utc::now(),
                                ToolSettlement::Interrupted,
                                Some(super::SHUTDOWN_INTERRUPTED_TURN_ERROR),
                            )
                            .await;
                        }
                        app.emit(
                            Some(workspace_id.clone()),
                            Some(thread_id.clone()),
                            UnifiedEvent::ThreadUpdated { thread },
                        );
                    }
                }
                Err(error) => {
                    tracing::info!(%error, %thread_id, "native OpenCode hydration failed");
                }
            }
        });
    }
}

pub(super) async fn start_opencode_turn(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
) -> Result<(), DaemonError> {
    let (session_id, model_id, variant, agent_id, prompt, files, message_id) = {
        let workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let session_id = thread.summary.native_session_id.clone().ok_or_else(|| {
            DaemonError::BadRequest("native OpenCode thread has no session id".to_string())
        })?;
        let model_id = thread.summary.agent.model_id.clone();
        // Validate against the live registry below; workspace metadata can be
        // older than a provider hot reload.
        let variant = thread.summary.agent.reasoning_effort.clone();
        let (prompt, files) = opencode_prompt_from_inputs(inputs, selected_skills);
        (
            session_id,
            model_id,
            variant,
            thread.summary.agent.collaboration_mode_id.clone(),
            prompt,
            files,
            native_message_id(
                thread
                    .dispatching_request
                    .as_ref()
                    .map(|request| request.id.as_str()),
            ),
        )
    };
    let runtime = app.opencode_runtime_for(workspace_id).await?;
    runtime.validate_contract().await?;
    let runner_models = runtime.runner_models().await?;
    let variant = crate::opencode::runner_variant(
        variant.as_deref(),
        model_id
            .as_deref()
            .and_then(|model_id| runner_models.get(model_id)),
    );
    if let Some(agent_id) = agent_id.as_deref() {
        runtime.set_agent(&session_id, agent_id).await?;
    }
    if let Some(model_id) = model_id.as_deref() {
        // An agent can carry its own model. Apply the thread's explicit model
        // last so changing Build/Plan does not silently replace that choice.
        runtime.set_model(&session_id, model_id, variant).await?;
    }
    // Changing a model must be checked before admitting any new input.
    let session_model = runtime.session_model_ref(&session_id).await?;
    if let Some(reason) =
        crate::opencode::native_model_block_reason(session_model.as_deref(), &runner_models)
    {
        return Err(DaemonError::BadRequest(format!(
            "{reason}; switch this thread to a natively available model, or start a new \
             thread to use this model over ACP"
        )));
    }
    // A successful response is durable admission. No ACP retry is permitted
    // beyond this point because that could execute the same request twice.
    runtime
        .prompt(&session_id, &message_id, &prompt, &files, Delivery::Queue)
        .await?;
    let _ = app
        .with_managed_thread_mut(workspace_id, thread_id, |thread| {
            thread.opencode_turn_in_flight = true;
            // A stale request from a previous turn must not cancel this one.
            thread.opencode_interrupt_requested = false;
        })
        .await;
    let app = app.clone();
    let workspace_id = workspace_id.to_string();
    let thread_id = thread_id.to_string();
    tokio::spawn(async move {
        let outcome = async {
            let wait = runtime.wait_for_settlement(&session_id);
            tokio::pin!(wait);
            let mut permissions = tokio::time::interval(std::time::Duration::from_millis(400));
            let mut projection = tokio::time::interval(std::time::Duration::from_millis(1500));
            let mut projected = std::collections::HashMap::<String, Value>::new();
            loop {
                tokio::select! {
                    result = &mut wait => {
                        break result?;
                    }
                    _ = permissions.tick() => {
                        let pending = runtime.pending_permissions(&session_id).await?;
                        let permission_mode = app
                            .thread_summary(&workspace_id, &thread_id)
                            .await?
                            .agent
                            .permission_mode;
                        if uses_blanket_approval(permission_mode.as_deref()) {
                            approve_permissions_once(
                                &app,
                                &runtime,
                                &workspace_id,
                                &session_id,
                                &pending,
                            )
                            .await?;
                        } else {
                            surface_permissions(&app, &workspace_id, &thread_id, &pending).await?;
                        }
                        let pending = runtime.pending_questions(&session_id).await?;
                        surface_questions(&app, &workspace_id, &thread_id, &pending).await?;
                    }
                    _ = projection.tick() => {
                        // Stream the partial transcript while the runner
                        // works: without this a long turn shows "Thinking…"
                        // until it ends and reads as hung. Only messages that
                        // changed since the last tick are re-projected, so
                        // clients see one update per new item, not a replay
                        // of the whole turn every interval. Best effort: a
                        // fetch or projection failure here settles with the
                        // turn, never fails it.
                        let Ok(messages) =
                            runtime.messages_since(&session_id, &message_id).await
                        else {
                            continue;
                        };
                        let mut changed = Vec::new();
                        for message in &messages {
                            let Some(id) = message.get("id").and_then(Value::as_str) else {
                                continue;
                            };
                            if projected.get(id) == Some(message) {
                                continue;
                            }
                            projected.insert(id.to_string(), message.clone());
                            // Message-level errors settle with the turn. A
                            // user-requested interrupt lands here as a
                            // "Provider turn interrupted" error the instant
                            // OpenCode acknowledges it, and projecting that
                            // would put a red failure card on a clean stop.
                            let mut message = message.clone();
                            if let Some(message) = message.as_object_mut() {
                                message.remove("error");
                            }
                            changed.push(message);
                        }
                        if changed.is_empty() {
                            continue;
                        }
                        if let Err(error) =
                            project_messages(&app, &workspace_id, &thread_id, &changed, false)
                                .await
                        {
                            tracing::debug!(
                                %error,
                                "mid-turn OpenCode projection deferred to turn end"
                            );
                        }
                    }
                }
            }
            let current_messages = runtime.messages_since(&session_id, &message_id).await?;
            project_settled_messages(&app, &workspace_id, &thread_id, &current_messages).await
        }
        .await;
        let mut interrupted = false;
        let _ = app
            .with_managed_thread_mut(&workspace_id, &thread_id, |thread| {
                interrupted = std::mem::take(&mut thread.opencode_interrupt_requested);
            })
            .await;
        let (status, error, settlement, transcript_synced) = match outcome {
            Ok(()) => (ThreadStatus::Idle, None, ToolSettlement::Completed, true),
            Err(_) if interrupted => {
                // The user stopped the turn; OpenCode acknowledges with a
                // durable interrupted idle record. Keep the
                // partial transcript and settle quietly instead of reporting
                // a failed turn.
                let mut projected = false;
                if let Ok(mut messages) = runtime.messages_since(&session_id, &message_id).await {
                    // The stored assistant message carries the cancellation
                    // as a message-level error; projecting it would render
                    // the stop the user asked for as a red failure.
                    for message in &mut messages {
                        if let Some(message) = message.as_object_mut() {
                            message.remove("error");
                        }
                    }
                    match project_messages(&app, &workspace_id, &thread_id, &messages, false).await
                    {
                        Ok(()) => projected = true,
                        Err(error) => {
                            tracing::debug!(
                                %error,
                                "post-interrupt OpenCode projection incomplete"
                            );
                        }
                    }
                }
                app.push_conversation_diagnostic(
                    &workspace_id,
                    &thread_id,
                    ServiceLevel::Info,
                    "Turn interrupted".to_string(),
                    Some(format!("opencode-interrupt-{message_id}")),
                )
                .await;
                // A successfully projected interruption is a synced
                // transcript: leaving it unsynced would make the next detail
                // read rehydrate from OpenCode storage and resurface the
                // cancellation as a red provider error.
                (
                    ThreadStatus::Idle,
                    None,
                    ToolSettlement::Interrupted,
                    projected,
                )
            }
            Err(error) => (
                ThreadStatus::Error,
                Some(error.to_string()),
                ToolSettlement::Failed,
                false,
            ),
        };
        let settled_at = Utc::now();
        app.settle_turn_items_with_error(
            &workspace_id,
            &thread_id,
            settled_at,
            settlement,
            error.as_deref(),
        )
        .await;
        if let Ok(thread) = app
            .upsert_thread(&workspace_id, &thread_id, |thread| {
                thread.status = status;
                thread.last_error = error;
                thread.updated_at = settled_at;
            })
            .await
        {
            let _ = app
                .with_managed_thread_mut(&workspace_id, &thread_id, |thread| {
                    // A failed end-of-turn projection leaves a partial
                    // transcript that must stay eligible for rehydration on
                    // the next open.
                    thread.native_transcript_synced = transcript_synced;
                    thread.opencode_turn_in_flight = false;
                })
                .await;
            app.emit(
                Some(workspace_id.clone()),
                Some(thread_id.clone()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        app.dispatch_next_queued_turn(&workspace_id, &thread_id);
        app.maybe_schedule_ai_thread_title(workspace_id, thread_id)
            .await;
    });
    Ok(())
}

pub(super) fn native_permission_modes() -> Vec<String> {
    vec!["default".to_string(), "always-approve".to_string()]
}

pub(super) fn native_capabilities() -> AgentCapabilitySummary {
    AgentCapabilitySummary {
        supports_images: true,
        supports_interrupt: true,
        supports_steering: true,
        permission_modes: native_permission_modes(),
        // OpenCode permissions are agent rules, not a FalconDeck-style
        // per-session filesystem sandbox. An empty list hides that picker.
        sandbox_modes: Vec::new(),
        ..AgentCapabilitySummary::default()
    }
}

pub(super) fn native_default_model() -> ModelSummary {
    ModelSummary {
        id: "default".to_string(),
        label: "OpenCode default".to_string(),
        is_default: true,
        default_reasoning_effort: None,
        supported_reasoning_efforts: Vec::new(),
        service_tiers: Vec::new(),
        default_service_tier: None,
    }
}

/// Order the effort ids weakest-first. OpenCode's own catalog order is lost
/// when the JSON object is parsed into a sorted map, and an alphabetical
/// picker ("high, low, max") reads as noise.
fn effort_rank(effort: &str) -> usize {
    const ORDER: [&str; 9] = [
        "default", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max",
    ];
    ORDER
        .iter()
        .position(|known| known.eq_ignore_ascii_case(effort))
        .unwrap_or(ORDER.len())
}

/// Reasoning efforts a catalog model advertises. OpenCode calls these
/// *variants*: named request presets whose ids are the effort levels
/// ("low"/"high"/"max" on GLM, "none".."xhigh" on GPT). Its own ACP adapter
/// publishes exactly these as the `thought_level` config option, so the
/// catalog is an equivalent source that does not need a session first.
pub(super) fn variant_efforts(model: &Value) -> Vec<ReasoningEffortSummary> {
    let variants = model.get("variants");
    let ids = match variants {
        Some(Value::Object(variants)) => variants.keys().cloned().collect::<Vec<_>>(),
        Some(Value::Array(variants)) => variants
            .iter()
            .filter_map(|variant| variant.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    let mut ids = ids;
    if !ids.is_empty() && !ids.iter().any(|id| id == "default") {
        ids.push("default".to_string());
    }
    let mut efforts = ids
        .into_iter()
        .map(|id| ReasoningEffortSummary {
            reasoning_effort: id,
            description: String::new(),
        })
        .collect::<Vec<_>>();
    efforts.sort_by(|left, right| {
        effort_rank(&left.reasoning_effort)
            .cmp(&effort_rank(&right.reasoning_effort))
            .then_with(|| left.reasoning_effort.cmp(&right.reasoning_effort))
    });
    efforts
}

fn parse_native_models(catalog: &Value) -> Result<Vec<ModelSummary>, DaemonError> {
    let entries = catalog
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DaemonError::Rpc(
                "OpenCode native model catalog did not contain a data array".to_string(),
            )
        })?;
    let mut models = vec![native_default_model()];
    for model in entries {
        if model.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let (Some(provider_id), Some(model_id)) = (
            model.get("providerID").and_then(Value::as_str),
            model.get("id").and_then(Value::as_str),
        ) else {
            continue;
        };
        let model_label = model
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(model_id);
        let supported_reasoning_efforts = variant_efforts(model);
        models.push(ModelSummary {
            id: format!("{provider_id}/{model_id}"),
            label: format!("{model_label} · {provider_id}"),
            is_default: false,
            default_reasoning_effort: (!supported_reasoning_efforts.is_empty())
                .then(|| "default".to_string()),
            supported_reasoning_efforts,
            service_tiers: Vec::new(),
            default_service_tier: None,
        });
    }
    models[1..].sort_by(|left, right| {
        left.label
            .to_lowercase()
            .cmp(&right.label.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(models)
}

fn parse_native_agents(agents: &[Value]) -> Vec<CollaborationModeSummary> {
    let mut modes = agents
        .iter()
        .filter(|agent| {
            !agent
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter(|agent| !matches!(agent.get("mode").and_then(Value::as_str), Some("subagent")))
        .filter_map(|agent| {
            let id = agent.get("id").and_then(Value::as_str)?;
            let label = humanize_id(id);
            // `ModelRef` uses `id`; `modelID` is tolerated for older 1.18.x
            // patch releases that spelled it differently.
            let model_id = agent.get("model").and_then(|model| {
                let model_id = model
                    .get("id")
                    .or_else(|| model.get("modelID"))
                    .and_then(Value::as_str)?;
                let provider_id = model.get("providerID").and_then(Value::as_str)?;
                Some(format!("{provider_id}/{model_id}"))
            });
            Some(CollaborationModeSummary {
                id: id.to_string(),
                label,
                mode: Some(id.to_string()),
                model_id,
                reasoning_effort: None,
                is_native: true,
            })
        })
        .collect::<Vec<_>>();
    modes.sort_by_key(|mode| (mode.id != "build", mode.label.to_lowercase()));
    modes
}

fn humanize_id(id: &str) -> String {
    let value = id.replace(['-', '_'], " ");
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

fn uses_blanket_approval(mode: Option<&str>) -> bool {
    mode.is_some_and(|mode| {
        mode.replace(['-', '_', ' '], "")
            .eq_ignore_ascii_case("alwaysapprove")
    })
}

async fn approve_permissions_once(
    app: &AppState,
    runtime: &OpenCodeRuntime,
    workspace_id: &str,
    session_id: &str,
    permissions: &[Value],
) -> Result<(), DaemonError> {
    for request_id in permissions
        .iter()
        .filter_map(|permission| permission.get("id").and_then(Value::as_str))
    {
        let key = (workspace_id.to_string(), request_id.to_string());
        if app
            .inner
            .interactive_requests
            .lock()
            .await
            .contains_key(&key)
        {
            // A mode change must not silently dismiss an approval already
            // shown to the user; apply blanket approval to later requests.
            continue;
        }
        // `always` persists OpenCode rules beyond this thread. FalconDeck's
        // permission choice is thread-scoped, so approve each request once.
        runtime
            .reply_permission(session_id, request_id, "once")
            .await?;
    }
    Ok(())
}

async fn surface_permissions(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    permissions: &[Value],
) -> Result<(), DaemonError> {
    for permission in permissions {
        let Some(request_id) = permission.get("id").and_then(Value::as_str) else {
            continue;
        };
        let key = (workspace_id.to_string(), request_id.to_string());
        if app
            .inner
            .interactive_requests
            .lock()
            .await
            .contains_key(&key)
        {
            continue;
        }
        let action = permission
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("OpenCode action");
        let resources = permission
            .get("resources")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        let request = InteractiveRequest {
            request_id: request_id.to_string(),
            workspace_id: workspace_id.to_string(),
            thread_id: Some(thread_id.to_string()),
            method: "opencode/permission".to_string(),
            kind: InteractiveRequestKind::Approval,
            approval_options: None,
            approval_decisions: Some(vec![
                ApprovalDecision::Allow,
                ApprovalDecision::AlwaysAllow,
                ApprovalDecision::Deny,
            ]),
            title: action.to_string(),
            detail: (!resources.is_empty()).then_some(resources),
            command: None,
            path: None,
            turn_id: None,
            item_id: None,
            questions: Vec::new(),
            created_at: Utc::now(),
        };
        app.inner.interactive_requests.lock().await.insert(
            key,
            PendingServerRequest {
                raw_id: Value::Null,
                request: request.clone(),
                params: Value::Null,
            },
        );
        let thread = app
            .upsert_thread(workspace_id, thread_id, |thread| {
                thread.status = ThreadStatus::WaitingForInput;
                thread.updated_at = Utc::now();
            })
            .await?;
        app.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ThreadUpdated { thread },
        );
        app.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::InteractiveRequest {
                request: request.clone(),
            },
        );
        app.push_conversation_item(
            workspace_id,
            thread_id,
            ConversationItem::InteractiveRequest {
                id: request_id.to_string(),
                request: Box::new(request),
                created_at: Utc::now(),
                resolved: false,
                resolution: None,
            },
            false,
        )
        .await?;
        app.notify_remote_attention("approval", workspace_id, Some(thread_id.to_string()))
            .await;
    }
    Ok(())
}

fn form_question(field: &Value) -> InteractiveQuestion {
    let key = field["key"].as_str().unwrap_or("field");
    let title = field["title"].as_str().unwrap_or(key);
    let mut question = field["description"].as_str().unwrap_or(title).to_string();
    let options = match field["type"].as_str() {
        Some("multiselect") => {
            let choices = field["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|option| option["label"].as_str())
                .collect::<Vec<_>>()
                .join(", ");
            question = format!(
                "{question}\nChoices: {choices}\nEnter one or more choices separated by commas or new lines."
            );
            None
        }
        Some("boolean") => Some(
            vec!["True", "False"]
                .into_iter()
                .map(|label| InteractiveQuestionOption {
                    label: label.to_string(),
                    description: String::new(),
                })
                .collect(),
        ),
        Some("external") => {
            question = format!(
                "{question}\nOpen {} and select Continue when finished.",
                field["url"].as_str().unwrap_or("the OpenCode form URL")
            );
            Some(vec![InteractiveQuestionOption {
                label: "Continue".to_string(),
                description: String::new(),
            }])
        }
        _ => field
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        Some(InteractiveQuestionOption {
                            label: option["label"].as_str()?.to_string(),
                            description: option["description"].as_str().unwrap_or("").to_string(),
                        })
                    })
                    .collect()
            }),
    };
    InteractiveQuestion {
        id: key.to_string(),
        header: title.to_string(),
        question,
        is_other: match field["type"].as_str() {
            Some("boolean" | "external") => false,
            Some("multiselect") => true,
            _ => field["custom"].as_bool().unwrap_or(options.is_none()),
        },
        is_secret: ["password", "secret", "token", "api_key"]
            .iter()
            .any(|word| {
                key.to_ascii_lowercase().contains(word) || title.to_ascii_lowercase().contains(word)
            }),
        options,
    }
}

async fn surface_questions(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    pending_questions: &[Value],
) -> Result<(), DaemonError> {
    for pending in pending_questions {
        let Some(request_id) = pending.get("id").and_then(Value::as_str) else {
            continue;
        };
        let key = (workspace_id.to_string(), request_id.to_string());
        if app
            .inner
            .interactive_requests
            .lock()
            .await
            .contains_key(&key)
        {
            continue;
        }
        let questions = pending
            .get("fields")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|field| !field["hidden"].as_bool().unwrap_or(false))
            .map(form_question)
            .collect::<Vec<_>>();
        let request = InteractiveRequest {
            request_id: request_id.to_string(),
            workspace_id: workspace_id.to_string(),
            thread_id: Some(thread_id.to_string()),
            method: "opencode/question".to_string(),
            kind: InteractiveRequestKind::Question,
            approval_options: None,
            approval_decisions: None,
            title: pending["title"]
                .as_str()
                .unwrap_or("OpenCode question")
                .to_string(),
            detail: None,
            command: None,
            path: None,
            turn_id: None,
            item_id: None,
            questions,
            created_at: Utc::now(),
        };
        app.inner.interactive_requests.lock().await.insert(
            key,
            PendingServerRequest {
                raw_id: Value::Null,
                request: request.clone(),
                params: Value::Null,
            },
        );
        let thread = app
            .upsert_thread(workspace_id, thread_id, |thread| {
                thread.status = ThreadStatus::WaitingForInput;
                thread.updated_at = Utc::now();
            })
            .await?;
        app.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ThreadUpdated { thread },
        );
        app.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::InteractiveRequest {
                request: request.clone(),
            },
        );
        app.push_conversation_item(
            workspace_id,
            thread_id,
            ConversationItem::InteractiveRequest {
                id: request_id.to_string(),
                request: Box::new(request),
                created_at: Utc::now(),
                resolved: false,
                resolution: None,
            },
            false,
        )
        .await?;
        app.notify_remote_attention("question", workspace_id, Some(thread_id.to_string()))
            .await;
    }
    Ok(())
}

/// Takes the steer idempotency key to send: a retained unresolved key is
/// reusable only for an identical prompt: OpenCode 2 returns the first stored
/// admission without comparing payloads. Other input needs a fresh id.
fn take_steer_message_id(retained: &mut Option<(String, Value)>, prompt: &Value) -> String {
    match retained.take() {
        Some((id, retained_prompt)) if retained_prompt == *prompt => id,
        _ => format!("msg_{}", Uuid::new_v4().simple()),
    }
}

fn native_message_id(queued_id: Option<&str>) -> String {
    // A persisted queue dispatch can be replayed after losing the HTTP reply
    // or restarting the daemon. Reuse its durable identity across that boundary.
    queued_id
        .map(|id| format!("msg_falcondeck_queue_{id}"))
        .unwrap_or_else(|| format!("msg_{}", Uuid::new_v4().simple()))
}

pub(super) async fn steer_opencode_turn(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
) -> Result<(), DaemonError> {
    let session_id = app
        .thread_summary(workspace_id, thread_id)
        .await?
        .native_session_id
        .ok_or_else(|| {
            DaemonError::BadRequest("native OpenCode thread has no session id".to_string())
        })?;
    let (text, files) = opencode_prompt_from_inputs(inputs, selected_skills);
    let prompt = json!({ "text": text, "files": files });
    // Acquire the runtime before taking the retained key: a spawn or lookup
    // failure must not consume an unresolved idempotency key.
    let runtime = app.opencode_runtime_for(workspace_id).await?;
    // Reuse the retained key while the previous steer's admission outcome is
    // unknown and the input is identical: OpenCode then re-admits the same
    // input instead of adding a second one. A confirmed admission clears the
    // key for the next steer.
    let message_id = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let thread = workspaces
            .get_mut(workspace_id)
            .and_then(|workspace| workspace.threads.get_mut(thread_id))
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        take_steer_message_id(&mut thread.pending_opencode_steer, &prompt)
    };
    let result = runtime
        .prompt(
            &session_id,
            &message_id,
            prompt.get("text").and_then(Value::as_str).unwrap_or(""),
            prompt
                .get("files")
                .and_then(Value::as_array)
                .map(|files| files.as_slice())
                .unwrap_or(&[]),
            Delivery::Steer,
        )
        .await;
    if result.is_err() {
        let mut workspaces = app.inner.workspaces.lock().await;
        if let Some(thread) = workspaces
            .get_mut(workspace_id)
            .and_then(|workspace| workspace.threads.get_mut(thread_id))
        {
            thread.pending_opencode_steer = Some((message_id, prompt));
        }
    }
    result.map(|_| ())
}

/// Preserve the authored native mention alongside the explicit V2 skill
/// preamble. Native names are path-derived rather than FalconDeck aliases.
fn opencode_skill_mention(skill: &ResolvedSelectedSkill) -> String {
    let native_name = skill
        .summary
        .provider_translations
        .opencode
        .as_ref()
        .and_then(|translation| translation.native_name.clone())
        .unwrap_or_else(|| {
            crate::skills::canonical_skill_alias(&skill.alias)
                .trim_start_matches('/')
                .to_string()
        });
    format!("${native_name}")
}

fn opencode_prompt_from_inputs(
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
) -> (String, Vec<Value>) {
    let mut text = inputs
        .iter()
        .filter_map(|input| match input {
            TurnInputItem::Text { text, .. } => Some(text.as_str()),
            TurnInputItem::Image(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    // Translate authored `/alias` tokens to OpenCode's `$name` mention;
    // text the user already wrote with `$name` is preserved as-is.
    text = replace_selected_skill_aliases(&text, selected_skills, |skill| {
        Some(opencode_skill_mention(skill))
    });
    if text.trim().is_empty() && !selected_skills.is_empty() {
        text = selected_skills
            .iter()
            .map(opencode_skill_mention)
            .collect::<Vec<_>>()
            .join("\n");
    }
    let preambles = selected_skills
        .iter()
        .map(|skill| {
            skill
                .summary
                .source_path
                .as_deref()
                .map(super::harness_user_text::falcondeck_skill_path_preamble)
                .unwrap_or_else(|| {
                    super::harness_user_text::falcondeck_skill_name_preamble(&skill.summary.label)
                })
        })
        .collect::<Vec<_>>();
    if !preambles.is_empty() {
        text = format!("{}\n\n{text}", preambles.join("\n"));
    }
    let files = inputs
        .iter()
        .filter_map(|input| match input {
            TurnInputItem::Image(image) => {
                let uri = image
                    .local_path
                    .as_deref()
                    .and_then(|path| reqwest::Url::from_file_path(path).ok())
                    .map(|url| url.to_string())
                    .unwrap_or_else(|| image.url.clone());
                let mut file = serde_json::json!({ "uri": uri });
                if let Some(name) = image.name.as_deref() {
                    file["name"] = Value::String(name.to_string());
                }
                if let Some(mime_type) = image.mime_type.as_deref() {
                    let label = match attachment_kind(image) {
                        AttachmentKind::Image => "Image attachment",
                        AttachmentKind::Document => "File attachment",
                    };
                    file["description"] = Value::String(format!("{label} ({mime_type})"));
                }
                Some(file)
            }
            TurnInputItem::Text { .. } => None,
        })
        .collect();
    (text, files)
}

/// Extracts human-readable output from an OpenCode tool state. Completed
/// states carry `content[]` parts (and an opaque `result`); error states
/// carry an `error` object — none expose a plain `output` string.
fn tool_state_output(state: &Value) -> Option<String> {
    if let Some(error) = state.get("error").filter(|error| !error.is_null()) {
        return Some(
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string()),
        );
    }
    let text = state
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty());
    text.or_else(|| {
        state
            .get("result")
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

/// Projects one stored message item into a thread. Live end-of-turn
/// projection is new agent output and must advance the attention sequence;
/// hydration replay is history recovery and must not, or every restored
/// thread reads as unread forever — the stamp uses the daemon's global event
/// counter, which always climbs past anything a client has marked read.
async fn push_projected_item(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    item: ConversationItem,
    update_existing: bool,
    replay: bool,
) -> Result<(), DaemonError> {
    if replay {
        app.replay_conversation_item(workspace_id, thread_id, item, update_existing)
            .await
    } else {
        app.push_conversation_item(workspace_id, thread_id, item, update_existing)
            .await
    }
}

fn native_created_at(value: &Value, fallback: chrono::DateTime<Utc>) -> chrono::DateTime<Utc> {
    value
        .pointer("/time/created")
        .and_then(Value::as_i64)
        .and_then(chrono::DateTime::from_timestamp_millis)
        .unwrap_or(fallback)
}

async fn project_settled_messages(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    messages: &[Value],
) -> Result<(), DaemonError> {
    project_messages(app, workspace_id, thread_id, messages, false).await?;
    crate::opencode::terminal_outcome(messages)
}

fn native_user_attachments(message: &Value, message_id: &str) -> Vec<ImageInput> {
    message["files"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, file)| {
            // Use OpenCode's stored bytes: a local file may have moved or changed
            // since admission, and inline attachments have no source URI.
            let data = file["data"].as_str()?;
            let mime = file["mime"].as_str()?;
            Some(ImageInput {
                id: format!("opencode-{message_id}-file-{index}"),
                name: file["name"].as_str().map(str::to_owned),
                mime_type: Some(mime.to_string()),
                url: format!("data:{mime};base64,{data}"),
                local_path: None,
            })
        })
        .collect()
}

async fn project_messages(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    messages: &[Value],
    replay: bool,
) -> Result<(), DaemonError> {
    // A durable idle verdict supersedes intermediate assistant failures from
    // retries and clean interruptions. Older preview records without an idle
    // verdict still retain their message-level error in history.
    let last_idle = messages
        .iter()
        .rposition(|message| message["type"] == "idle");
    for (index, message) in messages.iter().enumerate() {
        let message_created_at = native_created_at(message, Utc::now());
        let message_id = message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("assistant");
        if message.get("type").and_then(Value::as_str) == Some("user") {
            let text = message
                .get("text")
                .and_then(Value::as_str)
                .and_then(super::harness_user_text::visible_user_prompt)
                .unwrap_or_default();
            let attachments = native_user_attachments(message, message_id);
            if !text.is_empty() || !attachments.is_empty() {
                push_projected_item(
                    app,
                    workspace_id,
                    thread_id,
                    ConversationItem::UserMessage {
                        id: format!("opencode-{message_id}"),
                        text: text.to_string(),
                        attachments,
                        turn_id: None,
                        previous_turn_id: None,
                        created_at: message_created_at,
                    },
                    true,
                    replay,
                )
                .await?;
            }
            continue;
        }
        if !matches!(message["type"].as_str(), Some("assistant" | "idle")) {
            continue;
        }
        for (index, content) in message
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let content_created_at = native_created_at(content, message_created_at);
            let fallback_id = format!(
                "{message_id}-{}-{index}",
                content["type"].as_str().unwrap_or("content")
            );
            let content_id = content
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(&fallback_id);
            match content.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = content.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.is_empty() {
                        push_projected_item(
                            app,
                            workspace_id,
                            thread_id,
                            ConversationItem::AssistantMessage {
                                id: format!("opencode-{content_id}"),
                                text: text.to_string(),
                                phase: None,
                                memory_citation: None,
                                citations: Vec::new(),
                                lifecycle: ContentLifecycle::Complete,
                                error: None,
                                created_at: content_created_at,
                            },
                            true,
                            replay,
                        )
                        .await?;
                    }
                }
                Some("reasoning") => {
                    let text = content.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.is_empty() {
                        push_projected_item(
                            app,
                            workspace_id,
                            thread_id,
                            ConversationItem::Reasoning {
                                id: format!("opencode-{content_id}"),
                                summary: None,
                                content: text.to_string(),
                                lifecycle: ContentLifecycle::Complete,
                                duration_ms: None,
                                created_at: content_created_at,
                            },
                            true,
                            replay,
                        )
                        .await?;
                    }
                }
                Some("tool") => {
                    let name = content
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("Tool");
                    let state = content.get("state").unwrap_or(&Value::Null);
                    let raw_status = state
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed");
                    let status = match raw_status {
                        "error" | "failed" => "failed",
                        "pending" | "running" | "streaming" => "in_progress",
                        _ => "completed",
                    };
                    let output = tool_state_output(state);
                    // Titles come from the same table as every other harness,
                    // so an OpenCode edit reads like a Claude one.
                    let title = synthesize_tool_title(name, state.get("input"), None)
                        .unwrap_or_else(|| name.to_string());
                    let display =
                        tool_display_metadata(&title, name, status, None, output.as_deref());
                    push_projected_item(
                        app,
                        workspace_id,
                        thread_id,
                        ConversationItem::ToolCall {
                            id: format!("opencode-{content_id}"),
                            title,
                            // OpenCode's own tool name is the truthful kind, and
                            // it is what groups reads and edits in the transcript.
                            tool_kind: name.to_string(),
                            status: status.to_string(),
                            output,
                            exit_code: None,
                            display: Box::new(display),
                            detail: None,
                            created_at: content_created_at,
                            completed_at: (status != "in_progress").then(|| {
                                content
                                    .pointer("/time/completed")
                                    .and_then(Value::as_i64)
                                    .and_then(chrono::DateTime::from_timestamp_millis)
                                    .unwrap_or(content_created_at)
                            }),
                        },
                        true,
                        replay,
                    )
                    .await?;
                }
                _ => {}
            }
        }
        let has_error = match message["type"].as_str() {
            Some("idle") => message["outcome"] == "failed",
            Some("assistant") => {
                last_idle.is_none_or(|idle| index > idle)
                    && message.get("error").is_some_and(|error| !error.is_null())
            }
            _ => false,
        };
        if has_error {
            let message_text = message
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .or_else(|| error.pointer("/data/message"))
                })
                .and_then(Value::as_str)
                .unwrap_or("OpenCode turn failed");
            push_projected_item(
                app,
                workspace_id,
                thread_id,
                ConversationItem::Service {
                    id: format!("opencode-error-{message_id}"),
                    level: ServiceLevel::Error,
                    message: message_text.to_string(),
                    created_at: message_created_at,
                },
                true,
                replay,
            )
            .await?;
        }
    }
    Ok(())
}

pub(super) fn requested_native_transport(config: &AcpProviderConfig) -> bool {
    matches!(
        config.transport,
        ProviderTransport::Auto | ProviderTransport::Native
    )
}

#[cfg(test)]
mod tests {
    use falcondeck_core::{ImageInput, SkillProviderTranslations, SkillSummary};

    use super::*;

    async fn history_fixture() -> (tempfile::TempDir, AppState) {
        use falcondeck_core::{AgentProvider, WorkspaceKind, WorkspaceStatus, WorkspaceSummary};
        use std::collections::HashMap;

        let temp = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            temp.path().join("state.json"),
        );
        app.inner.workspaces.lock().await.insert(
            "workspace".into(),
            super::super::ManagedWorkspace {
                summary: WorkspaceSummary {
                    id: "workspace".into(),
                    path: temp.path().to_string_lossy().into_owned(),
                    kind: WorkspaceKind::Project,
                    status: WorkspaceStatus::Ready,
                    agents: vec![],
                    skills: vec![],
                    default_provider: AgentProvider::OPENCODE,
                    models: vec![],
                    collaboration_modes: vec![],
                    account: Default::default(),
                    current_thread_id: None,
                    connected_at: Utc::now(),
                    updated_at: Utc::now(),
                    last_error: None,
                    icon: None,
                },
                codex_session: None,
                claude_runtime: None,
                agy_runtime: None,
                opencode_runtime: None,
                acp_runtimes: HashMap::new(),
                threads: HashMap::new(),
            },
        );
        app.upsert_thread("workspace", "thread", |thread| {
            thread.provider = AgentProvider::OPENCODE
        })
        .await
        .unwrap();
        (temp, app)
    }

    #[tokio::test]
    async fn native_history_replay_keeps_all_content_blocks_and_original_times() {
        let (_temp, app) = history_fixture().await;
        let preamble = super::super::harness_user_text::falcondeck_skill_path_preamble(
            "/skills/review/SKILL.md",
        );
        let history = [
            json!({"id":"user","type":"user","time":{"created":1000},"text":format!("{preamble}\n\nReview this")}),
            json!({"id":"assistant","type":"assistant","time":{"created":2000},"content":[
                {"type":"text","text":"First"}, {"type":"reasoning","text":"Thinking"},
                {"type":"text","text":"Second"},
                {"id":"tool","type":"tool","name":"shell","time":{"created":3000,"completed":4000},"state":{"status":"completed","content":"done"}}
            ]}),
        ];
        for _ in 0..2 {
            project_messages(&app, "workspace", "thread", &history, true)
                .await
                .unwrap();
        }
        let workspaces = app.inner.workspaces.lock().await;
        let items = &workspaces["workspace"].threads["thread"].items;
        assert_eq!(
            items.len(),
            5,
            "replay must retain all blocks without duplicates"
        );
        assert!(items.iter().any(
            |item| matches!(item, ConversationItem::UserMessage {text, created_at, ..}
            if text == "Review this" && created_at.timestamp_millis() == 1000)
        ));
        let text_blocks = items
            .iter()
            .filter_map(|item| match item {
                ConversationItem::AssistantMessage {
                    id,
                    text,
                    created_at,
                    ..
                } => {
                    assert_eq!(created_at.timestamp_millis(), 2000);
                    Some((id.as_str(), text.as_str()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            text_blocks,
            [
                ("opencode-assistant-text-0", "First"),
                ("opencode-assistant-text-2", "Second")
            ]
        );
        assert!(items.iter().any(
            |item| matches!(item, ConversationItem::ToolCall {id, created_at, completed_at, ..}
            if id == "opencode-tool" && created_at.timestamp_millis() == 3000
                && completed_at.is_some_and(|time| time.timestamp_millis() == 4000))
        ));
    }

    #[tokio::test]
    async fn native_reload_retains_attachment_only_user_messages() {
        let (_temp, app) = history_fixture().await;
        let history = [
            json!({"id":"image-only","type":"user","time":{"created":1000},"text":"","files":[
                {"data":"aGVsbG8=","mime":"image/png","name":"shot.png","source":{"type":"inline"}},
                {"data":"cGRm","mime":"application/pdf","name":"document.pdf","source":{"type":"uri","uri":"file:///gone/document.pdf"}}
            ]}),
        ];
        for _ in 0..2 {
            project_messages(&app, "workspace", "thread", &history, true)
                .await
                .unwrap();
        }
        let workspaces = app.inner.workspaces.lock().await;
        let items = &workspaces["workspace"].threads["thread"].items;
        let [
            ConversationItem::UserMessage {
                text, attachments, ..
            },
        ] = items.as_slice()
        else {
            panic!("attachment-only input must survive replay: {items:?}");
        };
        assert!(text.is_empty());
        assert_eq!(attachments.len(), 2);
        assert_eq!(attachments[0].url, "data:image/png;base64,aGVsbG8=");
        assert_eq!(attachments[1].url, "data:application/pdf;base64,cGRm");
        assert_eq!(attachments[1].name.as_deref(), Some("document.pdf"));
    }

    #[tokio::test]
    async fn native_idle_verdict_owns_provider_errors_during_replay() {
        for outcome in ["succeeded", "interrupted", "failed"] {
            let (_temp, app) = history_fixture().await;
            let history = [
                json!({"id":"assistant","type":"assistant","content":[{"type":"text","text":"Final output"}],"error":{"message":"intermediate error"}}),
                json!({"id":"idle","type":"idle","outcome":outcome,"error":{"message":"terminal failure"}}),
            ];
            project_messages(&app, "workspace", "thread", &history, true)
                .await
                .unwrap();
            let settled = project_settled_messages(&app, "workspace", "thread", &history).await;
            assert_eq!(settled.is_err(), outcome != "succeeded");
            let workspaces = app.inner.workspaces.lock().await;
            let items = &workspaces["workspace"].threads["thread"].items;
            assert!(items.iter().any(|item| matches!(item, ConversationItem::AssistantMessage {text, ..} if text == "Final output")));
            let errors = items
                .iter()
                .filter_map(|item| match item {
                    ConversationItem::Service {
                        level: ServiceLevel::Error,
                        message,
                        ..
                    } => Some(message.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(
                errors,
                if outcome == "failed" {
                    vec!["terminal failure"]
                } else {
                    vec![]
                }
            );
        }
    }

    #[test]
    fn queued_admission_identity_survives_a_dispatch_retry() {
        assert_eq!(
            native_message_id(Some("queued-123")),
            native_message_id(Some("queued-123"))
        );
        assert_ne!(
            native_message_id(Some("queued-123")),
            native_message_id(Some("queued-456"))
        );
        assert_ne!(native_message_id(None), native_message_id(None));
    }

    #[test]
    fn native_forms_keep_keys_and_expose_boolean_and_external_choices() {
        let question = form_question(&json!({"key":"enabled","title":"Enabled?","type":"boolean"}));
        assert_eq!(question.id, "enabled");
        assert_eq!(
            question
                .options
                .unwrap()
                .iter()
                .map(|o| o.label.as_str())
                .collect::<Vec<_>>(),
            ["True", "False"]
        );
        let external = form_question(
            &json!({"key":"connect","type":"external","url":"https://example.test/connect"}),
        );
        assert!(external.question.contains("https://example.test/connect"));
        assert_eq!(external.options.unwrap()[0].label, "Continue");
        assert!(form_question(&json!({"key":"password","type":"string"})).is_secret);
    }

    fn resolved_skill(alias: &str, native_name: Option<&str>) -> ResolvedSelectedSkill {
        ResolvedSelectedSkill {
            alias: alias.to_string(),
            summary: SkillSummary {
                id: format!("skill:{}", alias.trim_start_matches('/')),
                label: alias.trim_start_matches('/').to_string(),
                alias: alias.to_string(),
                availability: falcondeck_core::SkillAvailability::Both,
                providers: vec![
                    falcondeck_core::AgentProvider::CODEX,
                    falcondeck_core::AgentProvider::CLAUDE,
                    falcondeck_core::AgentProvider::OPENCODE,
                ],
                source_kind: falcondeck_core::SkillSourceKind::ProjectFile,
                source_path: None,
                description: None,
                provider_translations: SkillProviderTranslations {
                    opencode: native_name.map(|name| falcondeck_core::OpenCodeSkillTranslation {
                        native_name: Some(name.to_string()),
                    }),
                    ..SkillProviderTranslations::default()
                },
            },
        }
    }

    #[test]
    fn native_prompt_translates_alias_to_dollar_mention() {
        let inputs = vec![TurnInputItem::Text {
            id: None,
            text: "/autore-view please review my changes".to_string(),
        }];
        let mut skills = vec![resolved_skill("/autore-view", Some("autoreview"))];

        skills[0].summary.source_path = Some("/project/skills/autoreview/SKILL.md".to_string());
        let (text, files) = opencode_prompt_from_inputs(&inputs, &skills);
        assert!(text.ends_with("$autoreview please review my changes"));
        assert!(text.contains("SKILL.md"));
        assert!(files.is_empty());
    }

    #[test]
    fn native_prompt_preserves_authored_dollar_mentions() {
        let inputs = vec![TurnInputItem::Text {
            id: None,
            text: "$autoreview review please".to_string(),
        }];
        let skills = vec![resolved_skill("/autore-view", Some("autoreview"))];

        let (text, _) = opencode_prompt_from_inputs(&inputs, &skills);
        assert!(text.ends_with("$autoreview review please"));
    }

    #[test]
    fn native_prompt_synthesizes_mentions_without_text() {
        let inputs = vec![TurnInputItem::Image(ImageInput {
            id: "image-1".to_string(),
            name: None,
            mime_type: None,
            url: "https://example.test/a.png".to_string(),
            local_path: None,
        })];
        let skills = vec![resolved_skill("/autore-view", None)];

        let (text, files) = opencode_prompt_from_inputs(&inputs, &skills);
        // No translation available: fall back to the canonical alias.
        assert!(text.ends_with("$autore-view"));
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn native_prompt_preserves_text_and_forwards_image_uris() {
        let inputs = vec![
            TurnInputItem::Text {
                id: None,
                text: "look at this".to_string(),
            },
            TurnInputItem::Image(ImageInput {
                id: "image-1".to_string(),
                name: Some("screen shot.png".to_string()),
                mime_type: Some("image/png".to_string()),
                url: "https://example.test/screen.png".to_string(),
                local_path: None,
            }),
        ];

        let (text, files) = opencode_prompt_from_inputs(&inputs, &[]);
        assert_eq!(text, "look at this");
        assert_eq!(files[0]["uri"], "https://example.test/screen.png");
        assert_eq!(files[0]["name"], "screen shot.png");
    }

    #[test]
    fn native_catalog_keeps_an_explicit_default_and_qualifies_models() {
        let models = parse_native_models(&serde_json::json!({
            "data": [
                {"providerID":"openrouter","id":"x-ai/grok-4.6","name":"Grok 4.6","enabled":true},
                {"providerID":"openrouter","id":"anthropic/claude-sonnet","name":"Claude Sonnet","enabled":true},
                {"providerID":"openrouter","id":"disabled","enabled":false}
            ]
        }))
        .expect("catalog parses");

        assert_eq!(models[0].id, "default");
        assert!(models[0].is_default);
        assert!(models.iter().any(|model| {
            model.id == "openrouter/x-ai/grok-4.6" && model.label == "Grok 4.6 · openrouter"
        }));
    }

    #[test]
    fn native_catalog_publishes_model_variants_as_reasoning_efforts() {
        let models = parse_native_models(&serde_json::json!({
            "data": [
                {"providerID":"zai-coding-plan","id":"glm-5.3","name":"GLM-5.3","enabled":true,
                 "variants":[{"id":"max"},{"id":"low"},{"id":"high"}]},
                {"providerID":"zai-coding-plan","id":"plain","name":"Plain","enabled":true,"variants":[]}
            ]
        }))
        .expect("catalog parses");

        let glm = models
            .iter()
            .find(|model| model.id == "zai-coding-plan/glm-5.3")
            .expect("glm listed");
        assert_eq!(
            glm.supported_reasoning_efforts
                .iter()
                .map(|effort| effort.reasoning_effort.as_str())
                .collect::<Vec<_>>(),
            vec!["default", "low", "high", "max"]
        );
        // An omitted variant uses base settings, not the lowest published preset.
        assert_eq!(glm.default_reasoning_effort.as_deref(), Some("default"));

        // A model without variants offers no effort picker at all.
        let plain = models
            .iter()
            .find(|model| model.id == "zai-coding-plan/plain")
            .expect("plain listed");
        assert!(plain.supported_reasoning_efforts.is_empty());
        assert!(plain.default_reasoning_effort.is_none());
    }

    #[test]
    fn native_agents_only_expose_visible_primary_modes() {
        let modes = parse_native_agents(&[
            serde_json::json!({ "id": "plan", "mode": "primary", "hidden": false }),
            serde_json::json!({ "id": "explore", "mode": "subagent", "hidden": false }),
            serde_json::json!({ "id": "secret", "mode": "primary", "hidden": true }),
            serde_json::json!({ "id": "build", "mode": "primary", "hidden": false }),
        ]);

        assert_eq!(
            modes
                .iter()
                .map(|mode| mode.id.as_str())
                .collect::<Vec<_>>(),
            vec!["build", "plan"]
        );
        assert!(modes.iter().all(|mode| mode.is_native));
    }

    #[test]
    fn only_the_native_blanket_mode_auto_approves() {
        assert!(uses_blanket_approval(Some("always-approve")));
        assert!(!uses_blanket_approval(Some("default")));
        assert!(!uses_blanket_approval(None));
    }

    #[test]
    fn tool_states_project_output_from_content_parts_and_error_objects() {
        // Completed tool states expose text through `content[]`, not a
        // plain `output` string.
        assert_eq!(
            tool_state_output(&serde_json::json!({
                "status": "completed",
                "content": [
                    { "type": "text", "text": "first" },
                    { "type": "file", "uri": "file:///tmp/x", "mime": "text/plain" },
                    { "type": "text", "text": "second" }
                ]
            }))
            .as_deref(),
            Some("first\nsecond")
        );
        // `result` is a fallback when no text parts are present.
        assert_eq!(
            tool_state_output(&serde_json::json!({
                "status": "completed",
                "content": [],
                "result": "plain result"
            }))
            .as_deref(),
            Some("plain result")
        );
        // Error states carry an `error` object with a message.
        assert_eq!(
            tool_state_output(&serde_json::json!({
                "status": "error",
                "error": { "type": "unknown", "message": "command not found" }
            }))
            .as_deref(),
            Some("command not found")
        );
        assert_eq!(
            tool_state_output(&serde_json::json!({ "status": "pending" })),
            None
        );
    }

    #[test]
    fn native_agents_read_the_model_ref_id_field() {
        let modes = parse_native_agents(&[serde_json::json!({
            "id": "build",
            "mode": "primary",
            "hidden": false,
            "model": { "providerID": "anthropic", "id": "claude-sonnet-4" }
        })]);
        assert_eq!(
            modes[0].model_id.as_deref(),
            Some("anthropic/claude-sonnet-4")
        );

        // Older patch releases spelled the model field `modelID`.
        let legacy = parse_native_agents(&[serde_json::json!({
            "id": "build",
            "mode": "primary",
            "hidden": false,
            "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4" }
        })]);
        assert_eq!(
            legacy[0].model_id.as_deref(),
            Some("anthropic/claude-sonnet-4")
        );
    }

    #[test]
    fn steer_reuses_a_retained_key_only_for_identical_input() {
        let prompt = json!({ "text": "same steer", "files": [] });
        let mut retained = Some(("msg_retry_me".to_string(), prompt.clone()));
        // Identical retry reuses the id.
        assert_eq!(
            take_steer_message_id(&mut retained, &prompt),
            "msg_retry_me"
        );
        assert!(retained.is_none());

        // A different steer must not reuse the id: OpenCode resolves a reused
        // id to its stored admission without comparing a differing payload.
        let mut retained = Some(("msg_retry_me".to_string(), prompt.clone()));
        let other = json!({ "text": "different steer", "files": [] });
        let fresh = take_steer_message_id(&mut retained, &other);
        assert!(fresh.starts_with("msg_"));
        assert_ne!(fresh, "msg_retry_me");

        // No retained key mints a fresh id.
        let mut retained = None;
        let fresh = take_steer_message_id(&mut retained, &other);
        assert!(fresh.starts_with("msg_"));
    }
}
