//! App integration for OpenCode's native HTTP session API.

use std::sync::Arc;

use chrono::Utc;
use falcondeck_core::{
    AccountStatus, AgentCapabilitySummary, ApprovalDecision, CollaborationModeSummary,
    ContentLifecycle, ConversationItem, InteractiveQuestion, InteractiveQuestionOption,
    InteractiveRequest, InteractiveRequestKind, ModelSummary, ServiceLevel, ThreadStatus,
    TurnInputItem, UnifiedEvent,
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
    agent_helpers::ResolvedSelectedSkill,
    conversation_helpers::{ToolSettlement, tool_display_metadata},
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
                    .entry((workspace_id.to_string(), provider))
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
        let runtime = OpenCodeRuntime::spawn(&config.command, &workspace_path, &config.env).await?;
        let mut workspaces = self.inner.workspaces.lock().await;
        if let Some(workspace) = workspaces.get_mut(workspace_id) {
            workspace.opencode_runtime = Some(Arc::clone(&runtime));
        } else {
            drop(workspaces);
            runtime.shutdown().await;
            return Err(DaemonError::NotFound("workspace not found".to_string()));
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
        agent.capabilities.supports_steering = available;
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

    /// Starts the native server early enough to populate a fresh composer's
    /// model and agent controls. Only normalized catalog fields leave this
    /// module; the raw provider response can contain credentials.
    pub(super) async fn refresh_opencode_native_metadata(
        &self,
        workspace_id: &str,
    ) -> Result<(), DaemonError> {
        let runtime = self.opencode_runtime_for(workspace_id).await?;
        runtime.validate_contract().await?;
        let (catalog, agents) = tokio::try_join!(runtime.provider_catalog(), runtime.agents())?;
        let models = parse_native_models(&catalog)?;
        let collaboration_modes = parse_native_agents(&agents);
        // The catalog describes OpenCode's own configuration, which backs the
        // ACP adapter just as much as the native API, so publish it before
        // proving the native runner. A build that admits prompts without ever
        // starting its v2 runner still falls back to ACP for turns, but its
        // composer gets a real model list instead of the synthetic default
        // entry seeded at attach.
        let execution = runtime.validate_execution().await;
        let native = execution.is_ok();
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
            agent.account.label = if native {
                "OpenCode native connected".to_string()
            } else {
                "OpenCode using ACP fallback".to_string()
            };
            if native {
                agent.capabilities = native_capabilities();
            }
            agent.models = models;
            agent.collaboration_modes = collaboration_modes;
            workspace.summary.clone()
        };
        self.emit(
            Some(workspace_id.to_string()),
            None,
            UnifiedEvent::WorkspaceUpdated { workspace },
        );
        execution
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
            let result = async {
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
                project_messages(&app, &workspace_id, &thread_id, &messages).await
            }
            .await;
            if let Err(error) = result {
                tracing::info!(%error, %thread_id, "native OpenCode hydration failed");
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
    let (session_id, model_id, agent_id, prompt, files) = {
        let workspaces = app.inner.workspaces.lock().await;
        let thread = workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.threads.get(thread_id))
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let session_id = thread.summary.native_session_id.clone().ok_or_else(|| {
            DaemonError::BadRequest("native OpenCode thread has no session id".to_string())
        })?;
        let (prompt, files) = opencode_prompt_from_inputs(inputs, selected_skills);
        (
            session_id,
            thread.summary.agent.model_id.clone(),
            thread.summary.agent.collaboration_mode_id.clone(),
            prompt,
            files,
        )
    };
    let runtime = app.opencode_runtime_for(workspace_id).await?;
    if let Some(agent_id) = agent_id.as_deref() {
        runtime.set_agent(&session_id, agent_id).await?;
    }
    if let Some(model_id) = model_id.as_deref() {
        // An agent can carry its own model. Apply the thread's explicit model
        // last so changing Build/Plan does not silently replace that choice.
        runtime.set_model(&session_id, model_id).await?;
    }
    let message_id = format!("msg_{}", Uuid::new_v4().simple());
    // A successful response is durable admission. No ACP retry is permitted
    // beyond this point because that could execute the same request twice.
    let admission = runtime
        .prompt(&session_id, &message_id, &prompt, &files, Delivery::Queue)
        .await?;
    // The admission's sequence number scopes the event stream to this turn;
    // without it the stream replays prior turns' failures.
    let after_seq = admission
        .pointer("/data/admittedSeq")
        .and_then(Value::as_u64);

    let app = app.clone();
    let workspace_id = workspace_id.to_string();
    let thread_id = thread_id.to_string();
    tokio::spawn(async move {
        let outcome = async {
            let wait = runtime.wait_until_idle(&session_id, &message_id, after_seq);
            tokio::pin!(wait);
            let mut permissions = tokio::time::interval(std::time::Duration::from_millis(400));
            let current_messages = loop {
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
                }
            };
            project_messages(&app, &workspace_id, &thread_id, &current_messages).await
        }
        .await;
        let (status, error, settlement) = match outcome {
            Ok(()) => (ThreadStatus::Idle, None, ToolSettlement::Completed),
            Err(error) => (
                ThreadStatus::Error,
                Some(error.to_string()),
                ToolSettlement::Failed,
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

fn parse_native_models(catalog: &Value) -> Result<Vec<ModelSummary>, DaemonError> {
    let providers = catalog
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DaemonError::Rpc(
                "OpenCode native provider catalog did not contain a providers array".to_string(),
            )
        })?;
    let mut models = vec![native_default_model()];
    for provider in providers {
        let Some(provider_id) = provider.get("id").and_then(Value::as_str) else {
            continue;
        };
        let provider_label = provider
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(provider_id);
        let Some(provider_models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for model in provider_models.values() {
            let Some(model_id) = model.get("id").and_then(Value::as_str) else {
                continue;
            };
            let model_label = model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(model_id);
            models.push(ModelSummary {
                id: format!("{provider_id}/{model_id}"),
                label: format!("{model_label} · {provider_label}"),
                is_default: false,
                // OpenCode variants are prompt-time options rather than the
                // session model setting currently used by FalconDeck.
                default_reasoning_effort: None,
                supported_reasoning_efforts: Vec::new(),
                service_tiers: Vec::new(),
                default_service_tier: None,
            });
        }
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
            .get("questions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, question)| InteractiveQuestion {
                id: index.to_string(),
                header: question
                    .get("header")
                    .and_then(Value::as_str)
                    .unwrap_or("Question")
                    .to_string(),
                question: question
                    .get("question")
                    .and_then(Value::as_str)
                    .unwrap_or("OpenCode needs more information")
                    .to_string(),
                is_other: question
                    .get("custom")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                is_secret: false,
                options: question
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(|option| {
                                Some(InteractiveQuestionOption {
                                    label: option.get("label")?.as_str()?.to_string(),
                                    description: option
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string(),
                                })
                            })
                            .collect()
                    }),
            })
            .collect::<Vec<_>>();
        let request = InteractiveRequest {
            request_id: request_id.to_string(),
            workspace_id: workspace_id.to_string(),
            thread_id: Some(thread_id.to_string()),
            method: "opencode/question".to_string(),
            kind: InteractiveRequestKind::Question,
            approval_decisions: None,
            title: "OpenCode question".to_string(),
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
/// reusable only for an identical prompt, because OpenCode resolves a reused
/// message id to its stored admission and rejects a differing payload with a
/// conflict. Any other input mints a fresh id.
fn take_steer_message_id(retained: &mut Option<(String, Value)>, prompt: &Value) -> String {
    match retained.take() {
        Some((id, retained_prompt)) if retained_prompt == *prompt => id,
        _ => format!("msg_{}", Uuid::new_v4().simple()),
    }
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
    // OpenCode owns its own skill expansion. Preserve authored aliases and
    // only synthesize them when the selection arrived without prompt text.
    if text.trim().is_empty() && !selected_skills.is_empty() {
        text = selected_skills
            .iter()
            .map(|skill| format!("${}", skill.alias))
            .collect::<Vec<_>>()
            .join("\n");
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
                    file["description"] = Value::String(format!("Image attachment ({mime_type})"));
                }
                Some(file)
            }
            TurnInputItem::Text { .. } => None,
        })
        .collect();
    (text, files)
}

/// Names what an OpenCode tool call acted on. OpenCode reports only the tool's
/// name, so a turn of file work renders as a stack of identical `edit` rows
/// until the target is read out of the call's own input.
fn opencode_tool_title(name: &str, state: &Value) -> String {
    const MAX_TITLE_CHARS: usize = 120;
    let input = state.get("input");
    let argument = |keys: &[&str]| {
        input.and_then(|input| {
            keys.iter()
                .find_map(|key| input.get(*key).and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
    };
    let labelled = |label: &str, value: Option<String>| {
        value.map(|value| format!("{label} {value}"))
    };

    let title = match name.to_ascii_lowercase().as_str() {
        "bash" => argument(&["command", "description"]),
        "edit" | "patch" | "multiedit" => {
            labelled("Edit", argument(&["filePath", "file_path", "path"]))
        }
        "write" => labelled("Write", argument(&["filePath", "file_path", "path"])),
        "read" => labelled("Read", argument(&["filePath", "file_path", "path"])),
        "list" => labelled("List", argument(&["path", "directory"])),
        "glob" => labelled("Find", argument(&["pattern", "path"])),
        "grep" => labelled("Search", argument(&["pattern", "query"])),
        "webfetch" => labelled("Web fetch", argument(&["url"])),
        _ => None,
    };

    let title = title.unwrap_or_else(|| name.to_string());
    if title.chars().count() <= MAX_TITLE_CHARS {
        return title;
    }
    let mut truncated = title
        .chars()
        .take(MAX_TITLE_CHARS.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
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

async fn project_messages(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    messages: &[Value],
) -> Result<(), DaemonError> {
    let mut provider_error = None;
    for message in messages {
        let message_id = message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("assistant");
        if message.get("type").and_then(Value::as_str) == Some("user") {
            let text = message.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                app.push_conversation_item(
                    workspace_id,
                    thread_id,
                    ConversationItem::UserMessage {
                        id: format!("opencode-{message_id}"),
                        text: text.to_string(),
                        attachments: Vec::new(),
                        turn_id: None,
                        previous_turn_id: None,
                        created_at: Utc::now(),
                    },
                    true,
                )
                .await?;
            }
            continue;
        }
        if message.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        for content in message
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let content_id = content
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(message_id);
            match content.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = content.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.is_empty() {
                        app.push_conversation_item(
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
                                created_at: Utc::now(),
                            },
                            true,
                        )
                        .await?;
                    }
                }
                Some("reasoning") => {
                    let text = content.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.is_empty() {
                        app.push_conversation_item(
                            workspace_id,
                            thread_id,
                            ConversationItem::Reasoning {
                                id: format!("opencode-{content_id}"),
                                summary: None,
                                content: text.to_string(),
                                lifecycle: ContentLifecycle::Complete,
                                duration_ms: None,
                                created_at: Utc::now(),
                            },
                            true,
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
                        "pending" | "running" => "in_progress",
                        _ => "completed",
                    };
                    let output = tool_state_output(state);
                    let title = opencode_tool_title(name, state);
                    let display =
                        tool_display_metadata(&title, name, status, None, output.as_deref());
                    app.push_conversation_item(
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
                            created_at: Utc::now(),
                            completed_at: (status != "in_progress").then(Utc::now),
                        },
                        true,
                    )
                    .await?;
                }
                _ => {}
            }
        }
        if let Some(error) = message.get("error") {
            let message_text = error
                .pointer("/data/message")
                .or_else(|| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string());
            app.push_conversation_item(
                workspace_id,
                thread_id,
                ConversationItem::Service {
                    id: format!("opencode-error-{message_id}"),
                    level: ServiceLevel::Error,
                    message: message_text.clone(),
                    created_at: Utc::now(),
                },
                true,
            )
            .await?;
            provider_error = Some(message_text);
        }
    }
    if let Some(error) = provider_error {
        Err(DaemonError::Rpc(error))
    } else {
        Ok(())
    }
}

pub(super) fn requested_native_transport(config: &AcpProviderConfig) -> bool {
    matches!(
        config.transport,
        ProviderTransport::Auto | ProviderTransport::Native
    )
}

#[cfg(test)]
mod tests {
    use falcondeck_core::ImageInput;

    use super::*;

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
            "providers": [{
                "id": "openrouter",
                "name": "OpenRouter",
                "models": {
                    "grok": { "id": "x-ai/grok-4.6", "name": "Grok 4.6" },
                    "claude": { "id": "anthropic/claude-sonnet", "name": "Claude Sonnet" }
                }
            }],
            "default": { "openrouter": "x-ai/grok-4.6" }
        }))
        .expect("catalog parses");

        assert_eq!(models[0].id, "default");
        assert!(models[0].is_default);
        assert!(models.iter().any(|model| {
            model.id == "openrouter/x-ai/grok-4.6" && model.label == "Grok 4.6 · OpenRouter"
        }));
        assert!(
            models
                .iter()
                .skip(1)
                .all(|model| model.supported_reasoning_efforts.is_empty())
        );
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
    fn tool_titles_name_the_file_or_command_behind_the_tool() {
        let state = |input: serde_json::Value| serde_json::json!({ "input": input });
        assert_eq!(
            opencode_tool_title("edit", &state(serde_json::json!({ "filePath": "/repo/a.php" }))),
            "Edit /repo/a.php"
        );
        assert_eq!(
            opencode_tool_title("read", &state(serde_json::json!({ "filePath": "/repo/a.php" }))),
            "Read /repo/a.php"
        );
        assert_eq!(
            opencode_tool_title("bash", &state(serde_json::json!({ "command": "git status" }))),
            "git status"
        );
        // A tool with no recognised input keeps its own name rather than
        // inventing a target.
        assert_eq!(
            opencode_tool_title("todowrite", &state(serde_json::json!({ "todos": [] }))),
            "todowrite"
        );
        assert_eq!(opencode_tool_title("edit", &serde_json::Value::Null), "edit");
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
        // id to its stored admission and conflicts on a differing payload.
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
