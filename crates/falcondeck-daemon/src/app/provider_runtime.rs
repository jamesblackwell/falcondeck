//! Dispatch seam between provider ids and the backends that serve them.
//!
//! Codex and Claude are native backends with their own process lifecycles;
//! every other provider id is served by the generic ACP adapter. Resolving an
//! id to a [`ProviderRuntime`] is the one place those two names are recognised
//! by name, so the per-thread operations dispatch on the backend instead of
//! comparing provider ids at every call site.
//!
//! Backend handles are deliberately not stored on the enum: the three attach at
//! different times (Codex and Claude when the workspace connects, ACP during
//! metadata hydration or on the first turn), so each operation resolves the
//! handle it needs when it needs it.

use std::{path::Path, sync::OnceLock};

use falcondeck_core::{
    AgentCapabilitySummary, AgentProvider, SendTurnRequest, SetThreadGoalRequest,
    StartReviewRequest, ThreadSummary, TurnInputItem,
};
use serde_json::json;
use uuid::Uuid;

use super::{
    AppState,
    acp_threads::{AcpTurnStartOptions, start_acp_turn, steer_acp_turn},
    agent_helpers::{
        ResolvedSelectedSkill, agy_prompt_from_inputs, claude_prompt_from_inputs, codex_inputs,
    },
    opencode_threads::{requested_native_transport, start_opencode_turn, steer_opencode_turn},
    workspace_ops::{sandbox_policy_payload, send_turn},
};
use crate::{
    codex::{extract_thread_id, extract_thread_title, thread_start_params, turn_start_params},
    error::DaemonError,
};

/// The backend serving a provider id.
pub(super) enum ProviderRuntime {
    Codex,
    Claude,
    Agy,
    /// Any other provider id, served by the generic ACP adapter. Carries the id
    /// because the adapter is configured per provider.
    Acp(AgentProvider),
}

/// Thread identity produced by starting a thread on a backend.
pub(super) struct StartedThread {
    pub(super) thread_id: String,
    pub(super) title: String,
    pub(super) native_session_id: Option<String>,
    pub(super) provider_transport: Option<String>,
}

/// Everything a backend needs to open a new thread.
pub(super) struct StartThreadSpec<'a> {
    pub(super) workspace_id: &'a str,
    pub(super) model_id: Option<&'a str>,
    pub(super) sandbox_mode: Option<&'a str>,
    pub(super) approval_policy: &'a str,
    pub(super) collaboration_mode_id: Option<&'a str>,
    /// Directory the thread will run in — its isolated checkout when the
    /// request asked for one, otherwise the workspace folder. Resolved by the
    /// caller because the variant is created before the backend thread exists.
    pub(super) cwd: &'a str,
}

/// Everything a backend needs to run one turn. The thread summary is the state
/// after the request was folded into it, so its agent params are what the turn
/// actually runs with.
pub(super) struct TurnSpec<'a> {
    pub(super) workspace_id: &'a str,
    pub(super) thread_id: &'a str,
    pub(super) thread: &'a ThreadSummary,
    /// Turn inputs after image attachments were materialized to local files.
    pub(super) inputs: &'a [TurnInputItem],
    pub(super) selected_skills: &'a [ResolvedSelectedSkill],
    pub(super) approval_policy: &'a str,
    /// Model and effort exactly as the request carried them. Codex takes these
    /// raw — unset means "keep whatever the session already has" — while Claude
    /// takes the thread's resolved params.
    pub(super) requested_model_id: Option<&'a str>,
    pub(super) requested_reasoning_effort: Option<&'a str>,
    pub(super) service_tier: Option<&'a str>,
    /// Queue dispatch keeps its request pending until the provider really
    /// accepts the turn, so a startup failure can restore the authored entry.
    pub(super) wait_for_startup: bool,
    /// App-shutdown recovery must attach the exact persisted provider session
    /// and may never use a fresh-session fallback.
    pub(super) resume_interrupted: bool,
}

impl ProviderRuntime {
    /// Resolves a provider id to the backend that serves it.
    pub(super) fn for_provider(provider: &AgentProvider) -> Self {
        if *provider == AgentProvider::CODEX {
            Self::Codex
        } else if *provider == AgentProvider::CLAUDE {
            Self::Claude
        } else if *provider == AgentProvider::AGY {
            Self::Agy
        } else {
            Self::Acp(provider.clone())
        }
    }

    /// Provider id this backend was resolved from.
    pub(super) fn provider(&self) -> AgentProvider {
        match self {
            Self::Codex => AgentProvider::CODEX,
            Self::Claude => AgentProvider::CLAUDE,
            Self::Agy => AgentProvider::AGY,
            Self::Acp(provider) => provider.clone(),
        }
    }

    /// Display label for the backend. ACP providers carry a configured label on
    /// their workspace agent entry, so the bare id is only the fallback.
    pub(super) fn label(&self) -> String {
        match self {
            Self::Codex => "Codex".to_string(),
            Self::Claude => "Claude".to_string(),
            Self::Agy => "Antigravity".to_string(),
            Self::Acp(provider) => provider.as_str().to_string(),
        }
    }

    /// Compiled-in capability declaration, used before a workspace has
    /// published an agent entry for the provider.
    pub(super) fn default_capabilities(&self) -> AgentCapabilitySummary {
        match self {
            Self::Codex => AgentCapabilitySummary::codex(),
            Self::Claude => AgentCapabilitySummary::claude(),
            Self::Agy => AgentCapabilitySummary::agy(),
            Self::Acp(provider) => {
                if provider.as_str().eq_ignore_ascii_case("grok") {
                    return crate::acp::grok_placeholder_capabilities();
                }
                if provider.as_str().eq_ignore_ascii_case("cursor") {
                    return crate::acp::cursor_placeholder_capabilities();
                }
                let mut capabilities = AgentCapabilitySummary::acp_minimal();
                capabilities.supports_images = crate::acp::acp_supports_images(
                    provider.as_str(),
                    capabilities.supports_images,
                );
                capabilities
            }
        }
    }

    pub(super) async fn start_thread(
        &self,
        app: &AppState,
        spec: StartThreadSpec<'_>,
    ) -> Result<StartedThread, DaemonError> {
        match self {
            Self::Codex => {
                let session = app.session_for(spec.workspace_id).await?;
                let instructions = app.agent_context_instructions(&AgentProvider::CODEX).await;
                let result = session
                    .send_request(
                        "thread/start",
                        thread_start_params(
                            spec.cwd,
                            spec.model_id,
                            spec.sandbox_mode,
                            spec.approval_policy,
                            instructions.as_deref(),
                        ),
                    )
                    .await?;
                Ok(StartedThread {
                    thread_id: extract_thread_id(&result).ok_or_else(|| {
                        DaemonError::Rpc("thread/start did not return a thread id".to_string())
                    })?,
                    title: extract_thread_title(&result)
                        .unwrap_or_else(|| "New thread".to_string()),
                    native_session_id: extract_thread_id(&result),
                    provider_transport: None,
                })
            }
            Self::Claude => Ok(StartedThread {
                thread_id: format!("claude-thread-{}", Uuid::new_v4().simple()),
                title: "New Claude thread".to_string(),
                native_session_id: None,
                provider_transport: None,
            }),
            Self::Agy => Ok(StartedThread {
                thread_id: format!("agy-thread-{}", Uuid::new_v4().simple()),
                title: "New Antigravity thread".to_string(),
                native_session_id: None,
                provider_transport: None,
            }),
            // ACP providers open their conversation session on the first turn;
            // metadata discovery uses a separate short-lived session.
            Self::Acp(provider) => {
                if provider.as_str().eq_ignore_ascii_case("opencode")
                    && let Some(config) = app.opencode_config()
                    && requested_native_transport(&config)
                {
                    match app.opencode_runtime_for(spec.workspace_id).await {
                        Ok(runtime) => {
                            match runtime
                                .create_session(spec.cwd, spec.model_id, spec.collaboration_mode_id)
                                .await
                            {
                                Ok(session_id) => {
                                    let compatible = async {
                                        // Schema check first: it is the only
                                        // probe that catches request-shape
                                        // drift (for example an OpenCode
                                        // without `resume`) before a thread
                                        // is pinned to this transport.
                                        runtime.validate_contract().await?;
                                        // The v2 runner resolves models only
                                        // against its own registry, a strict
                                        // subset of the configured catalog:
                                        // OAuth and coding-plan credentials
                                        // are v1-only, and even among the
                                        // registered models the runner
                                        // implements only some model APIs. A
                                        // model it cannot resolve would be
                                        // admitted and then die without a
                                        // session event or assistant record,
                                        // so the thread must not pin to the
                                        // native transport at all.
                                        let runner_models = runtime.runner_models().await?;
                                        let session_model =
                                            runtime.session_model_ref(&session_id).await?;
                                        if let Some(reason) =
                                            crate::opencode::native_model_block_reason(
                                                session_model.as_deref(),
                                                &runner_models,
                                            )
                                        {
                                            return Err(DaemonError::BadRequest(reason));
                                        }
                                        runtime.session_is_active(&session_id).await?;
                                        runtime.messages(&session_id).await?;
                                        runtime.pending_permissions(&session_id).await?;
                                        runtime.pending_questions(&session_id).await?;
                                        Ok::<_, DaemonError>(())
                                    }
                                    .await;
                                    match compatible {
                                        Ok(()) => {
                                            app.set_opencode_native_available(
                                                spec.workspace_id,
                                                true,
                                            )
                                            .await;
                                            return Ok(StartedThread {
                                                thread_id: format!(
                                                    "opencode-thread-{}",
                                                    Uuid::new_v4().simple()
                                                ),
                                                title: "New thread".to_string(),
                                                native_session_id: Some(session_id),
                                                provider_transport: Some("native".to_string()),
                                            });
                                        }
                                        Err(error) => {
                                            runtime.delete_session(&session_id).await;
                                            if matches!(
                                                config.transport,
                                                crate::acp::ProviderTransport::Native
                                            ) {
                                                return Err(error);
                                            }
                                            tracing::warn!(
                                                %error,
                                                "native OpenCode compatibility probe failed; using ACP"
                                            );
                                        }
                                    }
                                }
                                Err(error)
                                    if matches!(
                                        config.transport,
                                        crate::acp::ProviderTransport::Native
                                    ) =>
                                {
                                    return Err(error);
                                }
                                Err(error) => tracing::warn!(
                                    %error,
                                    "native OpenCode session creation failed; using ACP"
                                ),
                            }
                        }
                        Err(error)
                            if matches!(
                                config.transport,
                                crate::acp::ProviderTransport::Native
                            ) =>
                        {
                            return Err(error);
                        }
                        Err(error) => tracing::warn!(
                            %error,
                            "native OpenCode startup failed; using ACP"
                        ),
                    }
                    app.set_opencode_native_available(spec.workspace_id, false)
                        .await;
                }
                Ok(StartedThread {
                    thread_id: format!("{}-thread-{}", provider.as_str(), Uuid::new_v4().simple()),
                    title: "New thread".to_string(),
                    native_session_id: None,
                    provider_transport: Some("acp".to_string()),
                })
            }
        }
    }

    pub(super) async fn send_turn(
        &self,
        app: &AppState,
        spec: TurnSpec<'_>,
    ) -> Result<(), DaemonError> {
        match self {
            Self::Codex => {
                let session = app
                    .resume_codex_thread_if_needed(spec.workspace_id, spec.thread_id)
                    .await?;
                let cwd = spec
                    .thread
                    .working_directory(session.workspace_path())
                    .to_string();
                let collaboration_mode = codex_collaboration_mode_payload(
                    app,
                    spec.workspace_id,
                    spec.thread.agent.collaboration_mode_id.as_deref(),
                    spec.thread.agent.model_id.as_deref(),
                    spec.thread.agent.reasoning_effort.as_deref(),
                )
                .await?;
                let casual_chat_root = app.casual_chat_documents_root(spec.workspace_id).await;

                session
                    .send_request(
                        "turn/start",
                        turn_start_params(
                            spec.thread_id,
                            codex_inputs(spec.inputs, spec.selected_skills),
                            Some(&cwd),
                            spec.requested_model_id,
                            spec.requested_reasoning_effort,
                            collaboration_mode,
                            sandbox_policy_payload(
                                spec.thread.agent.sandbox_mode.as_deref(),
                                casual_chat_root.as_deref(),
                            ),
                            Some(spec.approval_policy),
                            spec.service_tier,
                        ),
                    )
                    .await?;
                Ok(())
            }
            Self::Claude => {
                let runtime = app.claude_runtime_for(spec.workspace_id).await?;
                let session_id = spec.thread.native_session_id.clone();
                let new_session_id = session_id.is_none().then(|| Uuid::new_v4().to_string());
                if let Some(new_session_id) = new_session_id.as_deref() {
                    app.with_thread_mut(spec.workspace_id, spec.thread_id, |thread| {
                        thread.native_session_id = Some(new_session_id.to_string());
                    })
                    .await?;
                    if let Err(error) = app.persist_local_state().await {
                        let _ = app
                            .with_thread_mut(spec.workspace_id, spec.thread_id, |thread| {
                                if thread.native_session_id.as_deref() == Some(new_session_id) {
                                    thread.native_session_id = None;
                                }
                            })
                            .await;
                        return Err(error);
                    }
                }
                let images = spec
                    .inputs
                    .iter()
                    .filter_map(|input| match input {
                        TurnInputItem::Image(image) => Some(image.clone()),
                        TurnInputItem::Text { .. } => None,
                    })
                    .collect::<Vec<_>>();
                warn_once_if_claude_approvals_unavailable(app, spec.workspace_id).await;
                let settings_dir = app
                    .inner
                    .state_path
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join("claude-hooks");
                // The built-in FalconDeck connector is re-evaluated at each
                // Claude turn spawn, so agent-control setting changes apply
                // on the next turn.
                let builtin = app
                    .builtin_connectors(
                        &AgentProvider::CLAUDE,
                        runtime.workspace_path(),
                        Some(spec.thread_id),
                    )
                    .await;
                let agent_context = app.agent_context_instructions(&AgentProvider::CLAUDE).await;
                let spawn = runtime
                    .spawn_turn(
                        spec.thread_id,
                        session_id.as_deref(),
                        new_session_id.as_deref(),
                        &claude_prompt_from_inputs(spec.inputs, spec.selected_skills),
                        &images,
                        spec.thread.agent.model_id.as_deref(),
                        spec.thread.agent.reasoning_effort.as_deref(),
                        spec.thread.agent.permission_mode.as_deref(),
                        app.local_base_url().as_deref(),
                        &settings_dir,
                        spec.thread.working_directory(runtime.workspace_path()),
                        &builtin,
                        agent_context.as_deref(),
                    )
                    .await;
                let spawn = match spawn {
                    Ok(spawn) => spawn,
                    Err(error) => {
                        if let Some(new_session_id) = new_session_id.as_deref() {
                            let _ = app
                                .with_thread_mut(spec.workspace_id, spec.thread_id, |thread| {
                                    if thread.native_session_id.as_deref() == Some(new_session_id) {
                                        thread.native_session_id = None;
                                    }
                                })
                                .await;
                            let _ = app.persist_local_state().await;
                        }
                        return Err(error);
                    }
                };
                if spec.resume_interrupted
                    && session_id.as_deref() != Some(spawn.session_id.as_str())
                {
                    return Err(DaemonError::BadRequest(
                        "Claude resumed a different native session than FalconDeck requested"
                            .to_string(),
                    ));
                }
                app.with_thread_mut(spec.workspace_id, spec.thread_id, |thread| {
                    thread.native_session_id = Some(spawn.session_id.clone());
                })
                .await?;
                if spawn.stdout.is_some() || spawn.stderr.is_some() {
                    let app = app.clone();
                    let workspace_id = spec.workspace_id.to_string();
                    let thread_id = spec.thread_id.to_string();
                    tokio::spawn(async move {
                        app.monitor_claude_turn(
                            workspace_id,
                            thread_id,
                            spawn.generation,
                            spawn.stdout,
                            spawn.stderr,
                            spec.resume_interrupted,
                        )
                        .await;
                    });
                }
                Ok(())
            }
            Self::Agy => {
                let runtime = app.agy_runtime_for(spec.workspace_id).await?;
                let session_id = spec.thread.native_session_id.clone();
                let images = spec
                    .inputs
                    .iter()
                    .filter_map(|input| match input {
                        TurnInputItem::Image(image) => Some(image.clone()),
                        TurnInputItem::Text { .. } => None,
                    })
                    .collect::<Vec<_>>();
                let spawn = runtime
                    .spawn_turn(
                        spec.thread_id,
                        session_id.as_deref(),
                        &agy_prompt_from_inputs(spec.inputs, spec.selected_skills),
                        &images,
                        spec.thread.agent.model_id.as_deref(),
                        spec.thread.agent.reasoning_effort.as_deref(),
                        spec.thread.agent.permission_mode.as_deref(),
                        spec.thread.agent.sandbox_mode.as_deref(),
                        spec.thread.working_directory(runtime.workspace_path()),
                    )
                    .await?;
                if !spawn.session_id.is_empty() {
                    app.with_thread_mut(spec.workspace_id, spec.thread_id, |thread| {
                        thread.native_session_id = Some(spawn.session_id.clone());
                    })
                    .await?;
                    app.persist_local_state().await?;
                }
                let app = app.clone();
                let workspace_id = spec.workspace_id.to_string();
                let thread_id = spec.thread_id.to_string();
                tokio::spawn(async move {
                    app.monitor_agy_turn(
                        workspace_id,
                        thread_id,
                        spawn.generation,
                        spawn.stdout,
                        spawn.stderr,
                        spec.resume_interrupted,
                    )
                    .await;
                });
                Ok(())
            }
            Self::Acp(provider) => {
                if spec.thread.provider_transport.as_deref() == Some("native") {
                    return start_opencode_turn(
                        app,
                        spec.workspace_id,
                        spec.thread_id,
                        spec.inputs,
                        spec.selected_skills,
                    )
                    .await;
                }
                start_acp_turn(
                    app,
                    spec.workspace_id,
                    spec.thread_id,
                    provider,
                    spec.inputs,
                    spec.selected_skills,
                    AcpTurnStartOptions {
                        wait_for_startup: spec.wait_for_startup,
                        resume_interrupted: spec.resume_interrupted,
                    },
                )
                .await
            }
        }
    }

    /// Injects a message into the thread's running turn. Only providers whose
    /// capabilities advertise `supports_steering` reach this; the rest queue
    /// the message instead.
    pub(super) async fn steer(
        &self,
        app: &AppState,
        spec: TurnSpec<'_>,
    ) -> Result<(), DaemonError> {
        tracing::info!(
            thread = %spec.thread_id,
            transport = spec.thread.provider_transport.as_deref().unwrap_or("-"),
            "steering the running turn"
        );
        match self {
            Self::Codex => {
                let turn_id = spec.thread.latest_turn_id.as_deref().ok_or_else(|| {
                    DaemonError::BadRequest("no active Codex turn to steer".to_string())
                })?;
                let session = app.session_for(spec.workspace_id).await?;
                session
                    .send_request(
                        "turn/steer",
                        json!({
                            "threadId": spec.thread_id,
                            "input": codex_inputs(spec.inputs, spec.selected_skills),
                            "expectedTurnId": turn_id,
                        }),
                    )
                    .await?;
                Ok(())
            }
            Self::Claude => {
                let runtime = app.claude_runtime_for(spec.workspace_id).await?;
                let images = spec
                    .inputs
                    .iter()
                    .filter_map(|input| match input {
                        TurnInputItem::Image(image) => Some(image.clone()),
                        TurnInputItem::Text { .. } => None,
                    })
                    .collect::<Vec<_>>();
                runtime
                    .steer_turn(
                        spec.thread_id,
                        &claude_prompt_from_inputs(spec.inputs, spec.selected_skills),
                        &images,
                    )
                    .await
            }
            Self::Agy => {
                let runtime = app.agy_runtime_for(spec.workspace_id).await?;
                let images = spec
                    .inputs
                    .iter()
                    .filter_map(|input| match input {
                        TurnInputItem::Image(image) => Some(image.clone()),
                        TurnInputItem::Text { .. } => None,
                    })
                    .collect::<Vec<_>>();
                runtime
                    .steer_turn(
                        spec.thread_id,
                        &agy_prompt_from_inputs(spec.inputs, spec.selected_skills),
                        &images,
                    )
                    .await
            }
            Self::Acp(provider) => {
                if spec.thread.provider_transport.as_deref() == Some("native") {
                    return steer_opencode_turn(
                        app,
                        spec.workspace_id,
                        spec.thread_id,
                        spec.inputs,
                        spec.selected_skills,
                    )
                    .await;
                }
                steer_acp_turn(
                    app,
                    spec.workspace_id,
                    spec.thread_id,
                    provider,
                    spec.inputs,
                    spec.selected_skills,
                )
                .await
            }
        }
    }

    pub(super) async fn interrupt(
        &self,
        app: &AppState,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<(), DaemonError> {
        match self {
            Self::Codex => {
                let session = app.session_for(workspace_id).await?;
                let turn_id = {
                    let workspaces = app.inner.workspaces.lock().await;
                    let workspace = workspaces
                        .get(workspace_id)
                        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
                    workspace
                        .threads
                        .get(thread_id)
                        .and_then(|thread| thread.summary.latest_turn_id.clone())
                        .ok_or_else(|| {
                            DaemonError::BadRequest("no active turn to interrupt".to_string())
                        })?
                };

                session
                    .send_request(
                        "turn/interrupt",
                        json!({
                            "threadId": thread_id,
                            "turnId": turn_id,
                        }),
                    )
                    .await?;
                Ok(())
            }
            Self::Claude => {
                let runtime = app.claude_runtime_for(workspace_id).await?;
                runtime.interrupt_turn(thread_id).await
            }
            Self::Agy => {
                let runtime = app.agy_runtime_for(workspace_id).await?;
                runtime.interrupt_turn(thread_id).await
            }
            Self::Acp(provider) => {
                let native_session = {
                    let workspaces = app.inner.workspaces.lock().await;
                    workspaces
                        .get(workspace_id)
                        .and_then(|workspace| workspace.threads.get(thread_id))
                        .filter(|thread| {
                            thread.summary.provider_transport.as_deref() == Some("native")
                        })
                        .and_then(|thread| thread.summary.native_session_id.clone())
                };
                if let Some(session_id) = native_session {
                    // Flag first: OpenCode acknowledges the interrupt as a
                    // `step.failed` on the event stream, and the turn monitor
                    // must already know to settle it as an interruption.
                    let _ = app
                        .with_managed_thread_mut(workspace_id, thread_id, |thread| {
                            if thread.opencode_turn_in_flight {
                                thread.opencode_interrupt_requested = true;
                            }
                        })
                        .await;
                    return app
                        .opencode_runtime_for(workspace_id)
                        .await?
                        .interrupt(&session_id)
                        .await;
                }
                let runtime = app.acp_runtime_for(workspace_id, provider).await?;
                // A thread that never opened a session has nothing to cancel.
                if let Some(session_id) = {
                    let workspaces = app.inner.workspaces.lock().await;
                    workspaces
                        .get(workspace_id)
                        .and_then(|workspace| workspace.threads.get(thread_id))
                        .and_then(|thread| thread.summary.native_session_id.clone())
                } {
                    runtime.cancel(&session_id).await?;
                }
                Ok(())
            }
        }
    }

    pub(super) async fn set_goal(
        &self,
        app: &AppState,
        request: &SetThreadGoalRequest,
        objective: Option<&str>,
    ) -> Result<(), DaemonError> {
        match self {
            Self::Codex => {
                let session = app
                    .resume_codex_thread_if_needed(&request.workspace_id, &request.thread_id)
                    .await?;
                session
                    .send_request(
                        "thread/goal/set",
                        json!({
                            "threadId": request.thread_id,
                            "objective": objective,
                            "status": request.status,
                            "tokenBudget": request.token_budget,
                        }),
                    )
                    .await?;
                Ok(())
            }
            Self::Claude => {
                // Claude's goal support is the `/goal` slash command; drive it
                // through a normal turn so the session-scoped Stop hook engages.
                let Some(objective) = objective else {
                    return Err(DaemonError::BadRequest(
                        "an objective is required to set a goal".to_string(),
                    ));
                };
                send_turn(
                    app,
                    claude_goal_turn(
                        &request.workspace_id,
                        &request.thread_id,
                        &format!("/goal {objective}"),
                    ),
                )
                .await?;
                Ok(())
            }
            Self::Agy => Err(unsupported("thread goals", &AgentProvider::AGY)),
            Self::Acp(provider) => Err(unsupported("thread goals", provider)),
        }
    }

    pub(super) async fn clear_goal(
        &self,
        app: &AppState,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<(), DaemonError> {
        match self {
            Self::Codex => {
                let session = app
                    .resume_codex_thread_if_needed(workspace_id, thread_id)
                    .await?;
                session
                    .send_request("thread/goal/clear", json!({ "threadId": thread_id }))
                    .await?;
                Ok(())
            }
            Self::Claude => {
                send_turn(
                    app,
                    claude_goal_turn(workspace_id, thread_id, "/goal clear"),
                )
                .await?;
                Ok(())
            }
            Self::Agy => Err(unsupported("thread goals", &AgentProvider::AGY)),
            Self::Acp(provider) => Err(unsupported("thread goals", provider)),
        }
    }

    pub(super) async fn start_review(
        &self,
        app: &AppState,
        request: &StartReviewRequest,
    ) -> Result<(), DaemonError> {
        match self {
            Self::Codex => {
                let session = app.session_for(&request.workspace_id).await?;
                session
                    .send_request(
                        "review/start",
                        json!({
                            "threadId": request.thread_id,
                            "target": request.target
                        }),
                    )
                    .await?;
                Ok(())
            }
            other => Err(unsupported("code review", &other.provider())),
        }
    }
}

async fn codex_collaboration_mode_payload(
    app: &AppState,
    workspace_id: &str,
    mode_id: Option<&str>,
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<serde_json::Value, DaemonError> {
    let Some(mode_id) = mode_id.map(str::trim).filter(|mode| !mode.is_empty()) else {
        return Ok(serde_json::Value::Null);
    };
    let modes = app.collaboration_modes(workspace_id).await?;
    let mode = modes
        .iter()
        .find(|candidate| candidate.id == mode_id)
        .ok_or_else(|| {
            DaemonError::BadRequest(format!(
                "Codex collaboration mode '{mode_id}' is not available"
            ))
        })?;
    let model =
        mode.model_id.as_deref().or(model_id).ok_or_else(|| {
            DaemonError::BadRequest("Codex collaboration mode needs a model".into())
        })?;
    Ok(json!({
        "mode": mode.mode.as_deref().unwrap_or(&mode.id),
        "settings": {
            "model": model,
            "reasoning_effort": mode.reasoning_effort.as_deref().or(reasoning_effort),
            "developer_instructions": null
        }
    }))
}

impl AppState {
    /// Binary name or path configured for a provider. Providers with no
    /// explicit mapping fall back to their id as the command name, which is
    /// what every agent CLI we support is installed as.
    pub(crate) fn provider_bin(&self, provider: &AgentProvider) -> String {
        self.inner
            .provider_bins
            .get(provider)
            .cloned()
            .unwrap_or_else(|| provider.as_str().to_string())
    }

    /// Resolves a provider's configured binary against `PATH` and the usual
    /// install locations. The provider id doubles as the command name, so this
    /// needs no per-provider knowledge.
    pub(crate) fn resolve_provider_binary(
        &self,
        provider: &AgentProvider,
    ) -> crate::agent_binary::AgentBinaryResolution {
        crate::agent_binary::resolve_agent_binary(provider.as_str(), &self.provider_bin(provider))
    }

    /// Capability flags a provider advertises in a workspace. Workspaces that
    /// have not published an agent entry yet — placeholders, mid-restore —
    /// still have to answer capability questions, so they fall back to the
    /// backend's compiled-in declaration.
    pub(super) async fn provider_capabilities(
        &self,
        workspace_id: &str,
        provider: &AgentProvider,
    ) -> AgentCapabilitySummary {
        let advertised = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .get(workspace_id)
                .and_then(|workspace| {
                    workspace
                        .summary
                        .agents
                        .iter()
                        .find(|agent| &agent.provider == provider)
                })
                .map(|agent| agent.capabilities.clone())
        };
        advertised.unwrap_or_else(|| ProviderRuntime::for_provider(provider).default_capabilities())
    }
}

/// Refusal for an operation the resolved backend cannot perform. Capability
/// flags gate these at the call site where one exists; the dispatch arms are
/// the backstop for a provider advertising something it cannot serve.
fn unsupported(operation: &str, provider: &AgentProvider) -> DaemonError {
    DaemonError::BadRequest(format!(
        "the {} provider does not support {operation}",
        provider.as_str()
    ))
}

/// A goal command sent as an ordinary Claude turn.
fn claude_goal_turn(workspace_id: &str, thread_id: &str, text: &str) -> SendTurnRequest {
    SendTurnRequest {
        workspace_id: workspace_id.to_string(),
        thread_id: thread_id.to_string(),
        inputs: vec![TurnInputItem::Text {
            id: None,
            text: text.to_string(),
        }],
        selected_skills: Vec::new(),
        provider: Some(AgentProvider::CLAUDE),
        model_id: None,
        reasoning_effort: None,
        approval_policy: None,
        service_tier: None,
        permission_mode: None,
        sandbox_mode: None,
        steer: false,
        user_item_id: None,
        resume_interrupted: false,
    }
}

/// Surfaces a one-time (per daemon process) service warning when Claude
/// approvals would be active but curl is missing, so the hook settings file is
/// skipped and tool calls run without FalconDeck approval prompts.
async fn warn_once_if_claude_approvals_unavailable(app: &AppState, workspace_id: &str) {
    static CURL_WARNING_EMITTED: OnceLock<()> = OnceLock::new();
    if app.local_base_url().is_none()
        || !crate::claude::claude_approvals_enabled()
        || crate::claude::curl_available()
        || CURL_WARNING_EMITTED.set(()).is_err()
    {
        return;
    }
    let _ = app.upsert_operational_condition(
        workspace_id.to_string(),
        "claude_approvals",
        falcondeck_core::ServiceLevel::Warning,
        "Claude approvals disabled: curl not found".to_string(),
        Some("claude-hooks".to_string()),
    );
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn unmapped_providers_fall_back_to_their_id_as_the_command_name() {
        let temp_dir = tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::from([(AgentProvider::CODEX, "/opt/codex".to_string())]),
            temp_dir.path().join("daemon-state.json"),
        );

        assert_eq!(app.provider_bin(&AgentProvider::CODEX), "/opt/codex");
        assert_eq!(app.provider_bin(&AgentProvider::CLAUDE), "claude");
        assert_eq!(
            app.provider_bin(&AgentProvider::new("opencode".to_string())),
            "opencode"
        );
    }

    #[tokio::test]
    async fn capability_lookups_fall_back_to_the_backend_declaration() {
        let temp_dir = tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            temp_dir.path().join("daemon-state.json"),
        );

        // No workspace has been connected, so nothing has published an agent
        // entry; review must still be allowed for Codex and refused elsewhere.
        assert!(
            app.provider_capabilities("workspace-1", &AgentProvider::CODEX)
                .await
                .supports_review
        );
        assert!(
            !app.provider_capabilities("workspace-1", &AgentProvider::CLAUDE)
                .await
                .supports_review
        );
    }

    #[test]
    fn resolves_native_backends_by_id_and_everything_else_to_acp() {
        assert!(matches!(
            ProviderRuntime::for_provider(&AgentProvider::CODEX),
            ProviderRuntime::Codex
        ));
        assert!(matches!(
            ProviderRuntime::for_provider(&AgentProvider::CLAUDE),
            ProviderRuntime::Claude
        ));
        let opencode = AgentProvider::new("opencode".to_string());
        let ProviderRuntime::Acp(provider) = ProviderRuntime::for_provider(&opencode) else {
            panic!("expected an ACP backend for an unknown provider id");
        };
        assert_eq!(provider, opencode);
    }

    #[test]
    fn default_capabilities_track_the_resolved_backend() {
        assert!(
            ProviderRuntime::for_provider(&AgentProvider::CODEX)
                .default_capabilities()
                .supports_review
        );
        assert!(
            !ProviderRuntime::for_provider(&AgentProvider::CLAUDE)
                .default_capabilities()
                .supports_review
        );
        let capabilities = ProviderRuntime::for_provider(&AgentProvider::new("grok".to_string()))
            .default_capabilities();
        assert!(!capabilities.supports_goals);
        assert!(capabilities.supports_interrupt);
        // Grok advertises image:false over ACP but still accepts image blocks.
        assert!(capabilities.supports_images);
        // Every ACP agent can be steered: the daemon cancels the in-flight
        // prompt and re-prompts on the same session, no vendor method needed.
        assert!(capabilities.supports_steering);
        let opencode_caps =
            ProviderRuntime::for_provider(&AgentProvider::new("opencode".to_string()))
                .default_capabilities();
        assert!(!opencode_caps.supports_images);
        assert!(opencode_caps.supports_steering);
        let cursor_caps = ProviderRuntime::for_provider(&AgentProvider::new("cursor".to_string()))
            .default_capabilities();
        assert!(cursor_caps.supports_images);
        assert_eq!(
            cursor_caps.permission_modes,
            crate::acp::cursor_placeholder_permission_modes()
        );
    }
}
