//! App-side integration for generic ACP providers: metadata hydration and
//! fallback runtime spawn, the event pump translating [`AcpEvent`]s into
//! conversation items, and the turn lifecycle for ACP-backed threads.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::Utc;
use falcondeck_core::{
    AgentProvider, ApprovalDecision, AssistantMessagePhase, ContentLifecycle,
    ConversationFileChange, ConversationItem, InteractiveRequest, InteractiveRequestKind,
    ModelSummary, PlanApprovalOutcome, ServiceLevel, ThreadStatus, ThreadTokenUsage,
    TokenUsageBreakdown, TurnInputItem, UnifiedEvent, WorkspaceStatus,
};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::acp::{AcpDiffContent, AcpEvent, AcpRuntime, AcpToolMemory};
use crate::error::DaemonError;

use super::agent_helpers::ResolvedSelectedSkill;
use super::conversation_helpers::{ToolSettlement, tool_display_metadata};
use super::harness_user_text::{
    conversation_item_from_projected_user, falcondeck_skill_name_preamble,
    falcondeck_skill_path_preamble,
};
use super::provider_runtime::ProviderRuntime;
use super::{AppState, PendingServerRequest};

struct AcpToolItem<'a> {
    call_id: &'a str,
    title: &'a str,
    kind: &'a str,
    status: &'a str,
    output: Option<&'a str>,
}

fn acp_metadata_updated_at(
    current: chrono::DateTime<Utc>,
    replay: bool,
    changed: bool,
    now: chrono::DateTime<Utc>,
) -> chrono::DateTime<Utc> {
    if replay || !changed { current } else { now }
}

impl AppState {
    /// Re-reads `providers.json` so provider edits apply without a daemon
    /// restart; the list cached at startup is only a fallback shape.
    pub(super) fn fresh_acp_provider_configs(&self) -> Vec<crate::acp::AcpProviderConfig> {
        self.inner
            .state_path
            .parent()
            .map(crate::acp::load_acp_provider_configs)
            .unwrap_or_default()
    }

    /// Hydrates one provider's model/config catalog in the background because
    /// the user explicitly selected that provider in a composer.
    ///
    /// Optional providers stay lazy at workspace attach (starting every
    /// configured provider for every restored workspace multiplies idle
    /// process trees and can exhaust memory), but a harness the user just
    /// picked must fill its model picker without needing a first prompt.
    /// Selection is the bounded trigger: one provider, one workspace, gated
    /// by the same startup permit as any other optional runtime.
    pub(crate) fn schedule_provider_metadata_hydration(
        &self,
        workspace_id: &str,
        provider: &AgentProvider,
    ) {
        let provider = provider.clone();
        // Codex and Claude publish their catalogs through their own connect
        // paths; only ACP/native providers hydrate lazily.
        let is_acp = self
            .fresh_acp_provider_configs()
            .iter()
            .any(|config| config.id.eq_ignore_ascii_case(provider.as_str()));
        if !is_acp {
            return;
        }
        let app = self.clone();
        let workspace_id = workspace_id.to_string();
        tokio::spawn(async move {
            if provider.as_str().eq_ignore_ascii_case("grok") {
                app.seed_grok_placeholder_catalog(&workspace_id).await;
            }
            if provider.as_str().eq_ignore_ascii_case("opencode")
                && let Some(config) = app.opencode_config()
                && super::opencode_threads::requested_native_transport(&config)
            {
                // Spawning the native server publishes its catalog as a side
                // effect; nothing else to do on success.
                match app.opencode_runtime_for(&workspace_id).await {
                    Ok(_) => return,
                    Err(error) => {
                        tracing::info!(
                            %error,
                            "native OpenCode metadata hydration failed"
                        );
                        app.set_opencode_native_available(&workspace_id, false)
                            .await;
                        if matches!(config.transport, crate::acp::ProviderTransport::Native) {
                            return;
                        }
                        // Auto mode falls through to the ACP handshake below.
                    }
                }
            }
            if let Err(error) = app.acp_runtime_for(&workspace_id, &provider).await {
                tracing::info!(
                    provider = %provider,
                    %error,
                    "ACP provider metadata hydration skipped"
                );
            }
        });
    }

    /// Fills an empty Grok catalog before ACP connect so the composer is
    /// usable while `grok agent stdio` starts. Live handshake replaces it.
    async fn seed_grok_placeholder_catalog(&self, workspace_id: &str) {
        let changed = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get_mut(workspace_id) else {
                return;
            };
            let Some(agent) = workspace
                .summary
                .agents
                .iter_mut()
                .find(|agent| agent.provider.as_str().eq_ignore_ascii_case("grok"))
            else {
                return;
            };
            let mut changed = false;
            if agent.models.is_empty() {
                agent.models = crate::acp::grok_placeholder_models();
                changed = true;
            }
            if agent.capabilities.permission_modes.is_empty() {
                agent.capabilities.permission_modes =
                    crate::acp::grok_placeholder_permission_modes();
                agent.capabilities.supports_images = true;
                changed = true;
            }
            changed
        };
        if !changed {
            return;
        }
        self.emit(
            Some(workspace_id.to_string()),
            None,
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );
    }

    /// Rehydrates a restored ACP thread's transcript in the background.
    ///
    /// ACP threads survive a daemon restart only as persisted summaries —
    /// their items live in the agent's own session store. Codex/Claude
    /// transcripts are re-read from provider session files at connect; the
    /// ACP equivalent is `session/load`, whose replay flows through the
    /// event pump and repopulates the thread. Called from the thread-detail
    /// read path so a restored thread fills in when opened instead of
    /// sitting empty until its next prompt.
    pub(super) fn schedule_acp_thread_hydration(&self, workspace_id: &str, thread_id: &str) {
        {
            let mut started = self
                .inner
                .acp_hydrations_started
                .lock()
                .expect("acp hydration set poisoned");
            if !started.insert((workspace_id.to_string(), thread_id.to_string())) {
                return;
            }
        }
        let app = self.clone();
        let workspace_id = workspace_id.to_string();
        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            let gate = app.acp_hydration_gate(&workspace_id, &thread_id).await;
            let _guard = gate.lock_owned().await;
            if let Err(error) = app
                .hydrate_acp_thread(&workspace_id, &thread_id, false)
                .await
            {
                tracing::info!(
                    thread = %thread_id,
                    %error,
                    "ACP thread hydration failed; transcript stays empty until next attempt"
                );
            }

            // This set tracks in-flight hydration, not permanent attempts.
            // Failed startup/load operations must be retryable on a later
            // detail read, while successful replays are naturally skipped by
            // the non-empty item/session checks above.
            app.inner
                .acp_hydrations_started
                .lock()
                .expect("acp hydration set poisoned")
                .remove(&(workspace_id, thread_id));
        });
    }

    /// Loads the exact provider session backing an interrupted ACP thread
    /// before FalconDeck sends a continuation prompt. Unlike ordinary ACP
    /// startup this path is fail-closed: it never substitutes `session/new`.
    pub(super) async fn hydrate_acp_thread_for_resume(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, DaemonError> {
        let gate = self.acp_hydration_gate(workspace_id, thread_id).await;
        let guard = gate.lock_owned().await;
        self.hydrate_acp_thread(workspace_id, thread_id, true)
            .await
            .map(|_| guard)
    }

    async fn acp_hydration_gate(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .acp_hydration_gates
            .lock()
            .await
            .entry((workspace_id.to_string(), thread_id.to_string()))
            .or_default()
            .clone()
    }

    async fn hydrate_acp_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
        exact_resume: bool,
    ) -> Result<usize, DaemonError> {
        let (provider, native_session, cwd, prior_error, item_count, running) = {
            let workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let thread = workspace
                .threads
                .get(thread_id)
                .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
            (
                thread.summary.provider.clone(),
                thread.summary.native_session_id.clone().ok_or_else(|| {
                    DaemonError::BadRequest(format!(
                        "cannot safely continue {} because FalconDeck has no durable native session id",
                        thread.summary.title
                    ))
                })?,
                thread
                    .summary
                    .working_directory(&workspace.summary.path)
                    .to_string(),
                (thread.summary.status == ThreadStatus::Error)
                    .then(|| thread.summary.last_error.clone())
                    .flatten(),
                thread.items.len(),
                matches!(thread.summary.status, ThreadStatus::Running),
            )
        };
        if running {
            return if exact_resume {
                Err(DaemonError::BadRequest(
                    "that session is already running a turn".to_string(),
                ))
            } else {
                Ok(item_count)
            };
        }

        let runtime = self.acp_runtime_for(workspace_id, &provider).await?;
        let mapped_session = runtime.session_for_thread(thread_id).await;
        if item_count > 0 {
            if !exact_resume {
                return Ok(item_count);
            }
            match mapped_session {
                Some(existing) if existing == native_session => {
                    // Acquire the runtime's per-thread gate even when the
                    // mapping already exists. A background session/load can
                    // publish that mapping before its replay notifications
                    // have all reached the event pump.
                    let builtin = self
                        .builtin_connectors(&provider, &cwd, Some(thread_id))
                        .await;
                    runtime
                        .ensure_loaded_session(thread_id, &native_session, &cwd, &builtin)
                        .await?;
                    return Ok(item_count);
                }
                Some(existing) => {
                    return Err(DaemonError::BadRequest(format!(
                        "cannot safely continue: the live ACP session is {existing}, not the persisted session {native_session}"
                    )));
                }
                None => {
                    return Err(DaemonError::BadRequest(
                        "cannot safely continue because the ACP transcript is present but its live session mapping is missing"
                            .to_string(),
                    ));
                }
            }
        }

        // A live session is only authoritative when the transcript is also in
        // memory. A workspace rebuild can retain the runtime mapping while
        // replacing the replayed items with its empty persisted placeholder.
        // Background hydration drops that mapping and replays again. Explicit
        // resume instead validates the exact mapping under the runtime's
        // session gate, so it cannot race an in-flight load.
        if mapped_session.is_some() && !exact_resume {
            let already_reloaded = !self
                .inner
                .acp_hydration_reloads
                .lock()
                .expect("acp hydration reload set poisoned")
                .insert((workspace_id.to_string(), thread_id.to_string()));
            if already_reloaded {
                return Ok(0);
            }
            runtime.forget_session(thread_id).await;
        }
        let builtin = self
            .builtin_connectors(&provider, &cwd, Some(thread_id))
            .await;
        if exact_resume {
            runtime
                .ensure_loaded_session(thread_id, &native_session, &cwd, &builtin)
                .await?;
        } else {
            runtime
                .load_session(thread_id, &native_session, &cwd, &builtin)
                .await?;
        }

        // session/load returns after the read loop has queued every replay
        // notification. Give the ordered event pump a chance to apply the
        // first item before settling the restored turn.
        let item_count = self
            .wait_for_acp_replay_items(workspace_id, thread_id)
            .await;
        if item_count == 0 {
            tracing::info!(
                provider = %provider,
                thread = %thread_id,
                session = %native_session,
                "ACP thread hydration finished with no replayed items"
            );
        }
        runtime.end_turn(&native_session).await;
        let settlement = if prior_error.as_deref() == Some(super::SHUTDOWN_INTERRUPTED_TURN_ERROR) {
            ToolSettlement::Interrupted
        } else if prior_error.is_some() {
            ToolSettlement::Failed
        } else {
            ToolSettlement::Completed
        };
        self.settle_turn_items_with_error(
            workspace_id,
            thread_id,
            Utc::now(),
            settlement,
            prior_error.as_deref(),
        )
        .await;
        Ok(item_count)
    }

    async fn wait_for_acp_replay_items(&self, workspace_id: &str, thread_id: &str) -> usize {
        for _ in 0..50 {
            let count = {
                let workspaces = self.inner.workspaces.lock().await;
                workspaces
                    .get(workspace_id)
                    .and_then(|workspace| workspace.threads.get(thread_id))
                    .map(|thread| thread.items.len())
                    .unwrap_or(0)
            };
            if count > 0 {
                return count;
            }
            tokio::task::yield_now().await;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        0
    }

    /// Returns the live ACP runtime for a provider in a workspace, spawning
    /// and initializing the agent process on first use.
    pub(super) async fn acp_runtime_for(
        &self,
        workspace_id: &str,
        provider: &AgentProvider,
    ) -> Result<Arc<AcpRuntime>, DaemonError> {
        let cached = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .get(workspace_id)
                .and_then(|workspace| workspace.acp_runtimes.get(provider))
                .filter(|runtime| !runtime.is_closed())
                .map(Arc::clone)
        };
        if let Some(runtime) = cached {
            if !runtime.metadata_discovered() {
                self.retry_acp_metadata_discovery(workspace_id, provider, &runtime)
                    .await;
            }
            return Ok(runtime);
        }

        let gate = {
            let mut gates = self.inner.acp_runtime_gates.lock().await;
            Arc::clone(
                gates
                    .entry((workspace_id.to_string(), provider.clone()))
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _gate = gate.lock().await;

        // Metadata hydration and first-turn startup can arrive together. The
        // second caller must reuse the process created by the first one after
        // waiting on the keyed gate.
        let cached = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .get(workspace_id)
                .and_then(|workspace| workspace.acp_runtimes.get(provider))
                .filter(|runtime| !runtime.is_closed())
                .map(Arc::clone)
        };
        if let Some(runtime) = cached {
            if !runtime.metadata_discovered() {
                self.retry_acp_metadata_discovery(workspace_id, provider, &runtime)
                    .await;
            }
            return Ok(runtime);
        }

        // A burst of restored thread opens can otherwise launch several heavy
        // optional agents at once. Only a new process waits behind this
        // bounded gate; cached runtimes returned above do not.
        let _startup_permit = self.inner.runtime_lifecycle.optional_start_permit().await?;

        let mut config = self
            .fresh_acp_provider_configs()
            .into_iter()
            .find(|config| config.id == provider.as_str())
            .ok_or_else(|| {
                DaemonError::BadRequest(format!(
                    "provider '{}' is not configured; add it to providers.json",
                    provider.as_str()
                ))
            })?;

        let workspace_path = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .get(workspace_id)
                .map(|workspace| workspace.summary.path.clone())
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?
        };

        let builtin = self
            .builtin_connectors(provider, &workspace_path, None)
            .await;
        let servers = crate::connectors::with_builtin_servers(
            crate::connectors::materialize_mcp_servers(&workspace_path, provider.as_str()).await,
            &builtin,
        );

        if let Some(base_url) = self.local_base_url() {
            config
                .env
                .insert("FALCONDECK_DAEMON_URL".to_string(), base_url);
        }
        config.env.insert(
            "FALCONDECK_DAEMON_EXECUTABLE".to_string(),
            crate::connectors::daemon_executable().display().to_string(),
        );
        config.env.insert(
            "FALCONDECK_CONTROL_PROVIDER".to_string(),
            provider.to_string(),
        );
        config.env.insert(
            "FALCONDECK_CONTROL_WORKSPACE".to_string(),
            workspace_path.clone(),
        );
        config.env.insert(
            "FALCONDECK_MCP_SERVERS".to_string(),
            crate::connectors::mcp_servers_env_json(&servers),
        );
        if let Some(extensions_spec) = &builtin.extensions {
            config.env.insert(
                crate::extension_mcp::ENV_EXTENSION_CAPABILITY.to_string(),
                extensions_spec.bridge_capability.clone(),
            );
        }

        if provider.as_str() == "pi"
            || config
                .command
                .iter()
                .any(|arg| arg.contains("pi-acp") || arg == "pi")
        {
            let _ = crate::agent_context::stage_pi_extension();
        }

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let runtime = AcpRuntime::connect(config, &workspace_path, events_tx).await?;
        // Grok (and similar) already advertise a catalog on initialize.
        // Publish it before the discovery session so a new-thread composer
        // can pick a model while plugins/MCP are still loading.
        if !runtime.advertised_models().await.is_empty() {
            self.publish_acp_agent_metadata(workspace_id, provider, &runtime)
                .await;
        }
        if let Err(error) = runtime
            .ensure_workspace_metadata(&workspace_path, &builtin)
            .await
        {
            // Some ACP agents require auth or do not implement session/new
            // configuration. Keep the provider selectable and let its first
            // real turn retry discovery instead of failing workspace attach.
            tracing::info!(
                provider = %runtime.config.id,
                %error,
                "ACP metadata discovery unavailable"
            );
        }

        {
            let mut workspaces = self.inner.workspaces.lock().await;
            if let Some(workspace) = workspaces.get_mut(workspace_id) {
                workspace
                    .acp_runtimes
                    .insert(provider.clone(), Arc::clone(&runtime));
            }
        }
        self.publish_acp_agent_metadata(workspace_id, provider, &runtime)
            .await;

        let app = self.clone();
        let workspace = workspace_id.to_string();
        let pump_runtime = Arc::clone(&runtime);
        tokio::spawn(async move {
            app.pump_acp_events(workspace, pump_runtime, events_rx)
                .await;
        });

        Ok(runtime)
    }

    /// Retries `session/new` discovery against a runtime that is already
    /// running. The first attempt can fail while the CLI is still
    /// authenticating, or time out when several workspaces start their agents
    /// at once; without this the cached-runtime fast path above returns before
    /// discovery is ever tried again and the composer keeps its placeholder
    /// catalog for the life of the process.
    async fn retry_acp_metadata_discovery(
        &self,
        workspace_id: &str,
        provider: &AgentProvider,
        runtime: &Arc<AcpRuntime>,
    ) {
        let workspace_path = {
            let workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get(workspace_id) else {
                return;
            };
            workspace.summary.path.clone()
        };
        let builtin = self
            .builtin_connectors(&runtime.provider, &workspace_path, None)
            .await;
        if let Err(error) = runtime
            .ensure_workspace_metadata(&workspace_path, &builtin)
            .await
        {
            tracing::info!(
                provider = %runtime.config.id,
                %error,
                "ACP metadata discovery retry unavailable"
            );
            return;
        }
        self.publish_acp_agent_metadata(workspace_id, provider, runtime)
            .await;
    }

    /// Lands a connected runtime's negotiated catalog on the workspace agent
    /// entry and republishes the snapshot.
    async fn publish_acp_agent_metadata(
        &self,
        workspace_id: &str,
        provider: &AgentProvider,
        runtime: &Arc<AcpRuntime>,
    ) {
        let capabilities = runtime.capability_summary().await;
        let models = runtime.advertised_models().await;
        let collaboration_modes = runtime.advertised_collaboration_modes().await;
        {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(workspace) = workspaces.get_mut(workspace_id) else {
                return;
            };
            // A successful handshake proves the binary works; reflect that on
            // the workspace agent entry, along with the capabilities and any
            // model catalog the agent negotiated — replacing the pre-connection
            // acp_minimal() placeholder. Providers hot-added after the
            // workspace connected have no stored entry yet (the snapshot's
            // placeholder lives in a clone), so seed one here or the refinement
            // has nothing to land on and the picker reports "not started"
            // forever.
            let account_status = {
                let agent = match workspace
                    .summary
                    .agents
                    .iter_mut()
                    .position(|agent| &agent.provider == provider)
                {
                    Some(index) => &mut workspace.summary.agents[index],
                    None => {
                        let grok = provider.as_str().eq_ignore_ascii_case("grok");
                        let cursor = provider.as_str().eq_ignore_ascii_case("cursor");
                        let mut placeholder = if grok {
                            crate::acp::grok_placeholder_capabilities()
                        } else if cursor {
                            crate::acp::cursor_placeholder_capabilities()
                        } else {
                            falcondeck_core::AgentCapabilitySummary::acp_minimal()
                        };
                        placeholder.supports_images = crate::acp::acp_supports_images(
                            provider.as_str(),
                            placeholder.supports_images,
                        );
                        workspace
                            .summary
                            .agents
                            .push(falcondeck_core::WorkspaceAgentSummary {
                                provider: provider.clone(),
                                label: runtime.config.label.clone(),
                                account: falcondeck_core::AccountSummary {
                                    status: falcondeck_core::AccountStatus::Unknown,
                                    label: format!("{} not started", runtime.config.label),
                                },
                                models: if grok {
                                    crate::acp::grok_placeholder_models()
                                } else {
                                    Vec::new()
                                },
                                collaboration_modes: if cursor {
                                    crate::acp::cursor_placeholder_collaboration_modes()
                                } else {
                                    Vec::new()
                                },
                                skills: Vec::new(),
                                capabilities: placeholder,
                            });
                        workspace.summary.agents.last_mut().expect("just pushed")
                    }
                };
                agent.account = falcondeck_core::AccountSummary {
                    status: falcondeck_core::AccountStatus::Ready,
                    label: format!("{} connected", runtime.config.label),
                };
                agent.capabilities = capabilities;
                if !models.is_empty() {
                    agent.models = merged_models(provider, &agent.models, models);
                }
                if !collaboration_modes.is_empty() {
                    agent.collaboration_modes = collaboration_modes;
                }
                agent.account.status.clone()
            };
            workspace.summary.status = super::workspace_status_after_account_update(
                &workspace.summary.status,
                &account_status,
            );
            if workspace.summary.status == WorkspaceStatus::Ready {
                workspace.summary.last_error = None;
            }
        }
        // Clients only refresh workspace agent entries on a full snapshot
        // event; without one they keep showing the pre-connect placeholder
        // (Unknown account, no models) until something unrelated emits.
        self.emit(
            Some(workspace_id.to_string()),
            None,
            falcondeck_core::UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );
    }

    /// Replaces an unresponsive ACP process before retrying turn startup.
    /// A runtime is shared by every thread for this provider/workspace, so do
    /// not recycle it while that would interrupt a different live turn.
    async fn restart_acp_runtime_for_turn_start(
        &self,
        workspace_id: &str,
        thread_id: &str,
        provider: &AgentProvider,
        stalled_runtime: &Arc<AcpRuntime>,
    ) -> Result<Option<Arc<AcpRuntime>>, DaemonError> {
        let runtime_to_shutdown = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get_mut(workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let other_turn_is_active = workspace.threads.values().any(|thread| {
                thread.summary.id != thread_id
                    && thread.summary.provider == *provider
                    && matches!(
                        thread.summary.status,
                        ThreadStatus::Running | ThreadStatus::WaitingForInput
                    )
            });
            if other_turn_is_active {
                return Ok(None);
            }
            let is_current = workspace
                .acp_runtimes
                .get(provider)
                .is_some_and(|runtime| Arc::ptr_eq(runtime, stalled_runtime));
            is_current
                .then(|| workspace.acp_runtimes.remove(provider))
                .flatten()
        };

        if let Some(runtime) = runtime_to_shutdown {
            runtime.shutdown().await;
        }
        self.acp_runtime_for(workspace_id, provider).await.map(Some)
    }

    /// Consumes runtime events and applies them to daemon state.
    async fn pump_acp_events(
        &self,
        workspace_id: String,
        runtime: Arc<AcpRuntime>,
        mut events: mpsc::UnboundedReceiver<AcpEvent>,
    ) {
        // Sessions whose `session/load` replay is streaming through the
        // channel right now, bracketed by ReplayStarted/ReplayFinished. The
        // pump is the channel's only consumer, so plain local state is enough.
        let mut replaying_sessions: HashSet<String> = HashSet::new();
        while let Some(event) = events.recv().await {
            if let Err(error) = self
                .apply_acp_event(&workspace_id, &runtime, event, &mut replaying_sessions)
                .await
            {
                tracing::warn!(%error, workspace = %workspace_id, "failed to apply ACP event");
            }
        }
    }

    async fn apply_acp_event(
        &self,
        workspace_id: &str,
        runtime: &Arc<AcpRuntime>,
        event: AcpEvent,
        replaying_sessions: &mut HashSet<String>,
    ) -> Result<(), DaemonError> {
        match event {
            AcpEvent::ReplayStarted { session_id } => {
                replaying_sessions.insert(session_id);
            }
            AcpEvent::ReplayFinished { session_id } => {
                replaying_sessions.remove(&session_id);
            }
            AcpEvent::MessageDelta {
                session_id,
                message_id,
                text,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                let (item_id, full_text) = runtime
                    .append_assistant_text(&session_id, message_id.as_deref(), &text)
                    .await;
                self.insert_acp_conversation_item(
                    workspace_id,
                    &thread_id,
                    ConversationItem::AssistantMessage {
                        id: item_id,
                        text: full_text,
                        phase: None,
                        memory_citation: None,
                        citations: Vec::new(),
                        lifecycle: ContentLifecycle::Streaming,
                        error: None,
                        created_at: Utc::now(),
                    },
                    true,
                    replaying_sessions.contains(&session_id),
                )
                .await?;
            }
            AcpEvent::UserMessageDelta {
                session_id,
                message_id,
                text,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                let (item_id, full_text) = runtime
                    .append_user_text(&session_id, message_id.as_deref(), &text)
                    .await;
                let Some(item) =
                    conversation_item_from_projected_user(item_id, &full_text, Utc::now())
                else {
                    return Ok(());
                };
                if let ConversationItem::UserMessage { text: prompt, .. } = &item {
                    // Cancel+re-prompt steering re-bundles the interrupted
                    // user text. If the adapter echoes that wrapper, drop it
                    // — the client already appended the steering bubble.
                    if prompt.contains("<interrupted_user_messages>")
                        || prompt.contains("<steering_messages>")
                    {
                        return Ok(());
                    }
                    let is_submitted_message_echo = {
                        let workspaces = self.inner.workspaces.lock().await;
                        workspaces
                            .get(workspace_id)
                            .and_then(|workspace| workspace.threads.get(&thread_id))
                            .is_some_and(|thread| {
                                latest_user_message_contains_echo(&thread.items, prompt)
                            })
                    };
                    if is_submitted_message_echo {
                        return Ok(());
                    }
                }
                self.insert_acp_conversation_item(
                    workspace_id,
                    &thread_id,
                    item,
                    true,
                    replaying_sessions.contains(&session_id),
                )
                .await?;
            }
            AcpEvent::ThoughtDelta {
                session_id,
                message_id,
                text,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                let (item_id, content) = runtime
                    .append_thought_text(&session_id, message_id.as_deref(), &text)
                    .await;
                self.insert_acp_conversation_item(
                    workspace_id,
                    &thread_id,
                    ConversationItem::Reasoning {
                        id: item_id,
                        summary: None,
                        content,
                        lifecycle: ContentLifecycle::Streaming,
                        duration_ms: None,
                        created_at: Utc::now(),
                    },
                    true,
                    replaying_sessions.contains(&session_id),
                )
                .await?;
            }
            AcpEvent::SessionInfo { session_id, title } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                let Some(title) = title.filter(|title| !title.trim().is_empty()) else {
                    return Ok(());
                };
                let replay = replaying_sessions.contains(&session_id);
                let thread = {
                    let mut workspaces = self.inner.workspaces.lock().await;
                    let Some(thread) = workspaces
                        .get_mut(workspace_id)
                        .and_then(|workspace| workspace.threads.get_mut(&thread_id))
                    else {
                        return Ok(());
                    };
                    if thread.manual_title {
                        return Ok(());
                    }
                    let title_changed = thread.summary.title != title;
                    thread.summary.title = title;
                    // `session/load` replays the provider's title on every app
                    // launch. It is metadata recovery, not fresh activity.
                    thread.summary.updated_at = acp_metadata_updated_at(
                        thread.summary.updated_at,
                        replay,
                        title_changed,
                        Utc::now(),
                    );
                    thread.ai_title_generated = true;
                    thread.summary.clone()
                };
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
            AcpEvent::Usage {
                session_id,
                used,
                size,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                // ACP reports context fill, not an input/output split; claiming
                // it all as input tokens would misreport any breakdown UI.
                let usage = ThreadTokenUsage {
                    total: TokenUsageBreakdown {
                        total_tokens: used,
                        input_tokens: 0,
                        cached_input_tokens: 0,
                        output_tokens: 0,
                        reasoning_output_tokens: 0,
                    },
                    last: None,
                    model_context_window: Some(size),
                    updated_at: Some(Utc::now()),
                };
                self.inner
                    .thread_token_usage
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(thread_id.clone(), usage.clone());
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadTokenUsageUpdated { usage },
                );
            }
            AcpEvent::ToolCall {
                session_id,
                call_id,
                title,
                kind,
                status,
                output,
                diffs,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                // A tool call is a message boundary: agents without message
                // ids (Grok) would otherwise merge post-tool text into the
                // pre-tool bubble, stranding the final answer above the tools.
                runtime.break_stream_items(&session_id).await;
                runtime
                    .remember_tool(
                        &call_id,
                        AcpToolMemory {
                            session_id: session_id.clone(),
                            title: title.clone(),
                            kind: kind.clone(),
                            output: output.clone(),
                        },
                    )
                    .await;
                let status = normalize_acp_tool_status(&status);
                let replay = replaying_sessions.contains(&session_id);
                self.push_acp_tool_item(
                    workspace_id,
                    &thread_id,
                    AcpToolItem {
                        call_id: &call_id,
                        title: &title,
                        kind: &kind,
                        status: &status,
                        output: output.as_deref(),
                    },
                    replay,
                )
                .await?;
                self.push_acp_diff_items(
                    workspace_id,
                    &thread_id,
                    &call_id,
                    &status,
                    &diffs,
                    replay,
                )
                .await?;
            }
            AcpEvent::ToolCallUpdate {
                session_id,
                call_id,
                title,
                status,
                output,
                diffs,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                let remembered = runtime.tool_memory(&call_id).await;
                let (known_title, kind, known_output) = remembered.map_or_else(
                    || ("Tool call".to_string(), "other".to_string(), None),
                    |memory| (memory.title, memory.kind, memory.output),
                );
                let title = title
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(known_title);
                // tool_call_update is a partial update: an absent content
                // field means "unchanged", so a status-only completion must
                // not erase output streamed by earlier updates.
                let output = output.or(known_output);
                runtime
                    .remember_tool(
                        &call_id,
                        AcpToolMemory {
                            session_id: session_id.clone(),
                            title: title.clone(),
                            kind: kind.clone(),
                            output: output.clone(),
                        },
                    )
                    .await;
                let status = normalize_acp_tool_status(status.as_deref().unwrap_or("in_progress"));
                let replay = replaying_sessions.contains(&session_id);
                self.push_acp_tool_item(
                    workspace_id,
                    &thread_id,
                    AcpToolItem {
                        call_id: &call_id,
                        title: &title,
                        kind: &kind,
                        status: &status,
                        output: output.as_deref(),
                    },
                    replay,
                )
                .await?;
                self.push_acp_diff_items(
                    workspace_id,
                    &thread_id,
                    &call_id,
                    &status,
                    &diffs,
                    replay,
                )
                .await?;
            }
            AcpEvent::Plan { session_id, plan } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    return Ok(());
                };
                let plan_item_id = runtime.current_plan_item_id(&session_id).await;
                let replay = replaying_sessions.contains(&session_id);
                let thread = self
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.latest_plan = Some(plan.clone());
                        thread.updated_at =
                            acp_metadata_updated_at(thread.updated_at, replay, true, Utc::now());
                    })
                    .await?;
                self.insert_acp_conversation_item(
                    workspace_id,
                    &thread_id,
                    ConversationItem::Plan {
                        id: plan_item_id,
                        plan,
                        created_at: Utc::now(),
                    },
                    true,
                    replay,
                )
                .await?;
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
            AcpEvent::PermissionRequest {
                session_id,
                request_id,
                title,
                detail,
                options,
            } => {
                let thread_id = runtime.thread_for_session(&session_id).await;
                // A thread whose permission mode is blanket approval must
                // never stall on a banner. Harness-side toggles (for example
                // Grok's session/new `yoloMode` meta) are advisory at best —
                // agents still ask, and resumed sessions lose the toggle
                // entirely — so the daemon answers on the user's behalf here,
                // where every request funnels through regardless of harness.
                if let Some(thread_id) = thread_id.as_deref() {
                    let permission_mode = {
                        let workspaces = self.inner.workspaces.lock().await;
                        workspaces
                            .get(workspace_id)
                            .and_then(|workspace| workspace.threads.get(thread_id))
                            .and_then(|thread| thread.summary.agent.permission_mode.clone())
                    };
                    if permission_mode
                        .as_deref()
                        .is_some_and(crate::acp::is_blanket_approval_mode)
                    {
                        // Prefer the standing grant so the agent stops asking
                        // for this tool; fall back to a one-shot allow.
                        let decision = if options.iter().any(|o| o.kind == "allow_always") {
                            Some(ApprovalDecision::AlwaysAllow)
                        } else if options.iter().any(|o| o.kind == "allow_once") {
                            Some(ApprovalDecision::Allow)
                        } else {
                            // Reject-only option lists cannot express consent;
                            // surface those to the user rather than denying.
                            None
                        };
                        if let Some(decision) = decision {
                            match runtime.respond_permission(&request_id, decision).await {
                                Ok(()) => {
                                    tracing::info!(
                                        thread = %thread_id,
                                        "auto-approved ACP permission request per thread permission mode"
                                    );
                                    return Ok(());
                                }
                                Err(error) => tracing::warn!(
                                    thread = %thread_id,
                                    %error,
                                    "failed to auto-approve ACP permission request; surfacing it"
                                ),
                            }
                        }
                    }
                }
                let mut approval_decisions = Vec::new();
                for option in &options {
                    let decision = match option.kind.as_str() {
                        "allow_once" => Some(ApprovalDecision::Allow),
                        "allow_always" => Some(ApprovalDecision::AlwaysAllow),
                        kind if kind.starts_with("reject") => Some(ApprovalDecision::Deny),
                        _ => None,
                    };
                    if let Some(decision) = decision
                        && !approval_decisions.contains(&decision)
                    {
                        approval_decisions.push(decision);
                    }
                }
                let request = InteractiveRequest {
                    request_id: request_id.clone(),
                    workspace_id: workspace_id.to_string(),
                    thread_id: thread_id.clone(),
                    method: "session/request_permission".to_string(),
                    kind: InteractiveRequestKind::Approval,
                    approval_decisions: Some(approval_decisions),
                    title,
                    detail,
                    command: None,
                    path: None,
                    turn_id: None,
                    item_id: None,
                    questions: Vec::new(),
                    created_at: Utc::now(),
                };
                self.inner.interactive_requests.lock().await.insert(
                    (workspace_id.to_string(), request_id.clone()),
                    PendingServerRequest {
                        raw_id: Value::Null,
                        request: request.clone(),
                        params: Value::Null,
                    },
                );
                if let Some(thread_id) = thread_id {
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.status = ThreadStatus::WaitingForInput;
                            thread.updated_at = Utc::now();
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    // Mirror the Claude/Codex approval surfacing: without the
                    // event, attention ping, and transcript item, an ACP
                    // approval never reaches phones and leaves no receipt in
                    // history after it is answered.
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::InteractiveRequest {
                            request: request.clone(),
                        },
                    );
                    self.notify_remote_attention("approval", workspace_id, Some(thread_id.clone()))
                        .await;
                    self.push_conversation_item(
                        workspace_id,
                        &thread_id,
                        ConversationItem::InteractiveRequest {
                            id: request_id.clone(),
                            request: Box::new(request),
                            created_at: Utc::now(),
                            resolved: false,
                            resolution: None,
                        },
                        false,
                    )
                    .await?;
                }
                self.emit(
                    Some(workspace_id.to_string()),
                    None,
                    UnifiedEvent::Snapshot {
                        snapshot: self.snapshot().await,
                    },
                );
            }
            AcpEvent::PlanApprovalRequest {
                session_id,
                request_id,
                method,
                tool_call_id,
                plan_content,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    runtime
                        .respond_plan_approval(&request_id, PlanApprovalOutcome::Abandoned, None)
                        .await?;
                    return Ok(());
                };
                let request = InteractiveRequest {
                    request_id: request_id.clone(),
                    workspace_id: workspace_id.to_string(),
                    thread_id: Some(thread_id.clone()),
                    method,
                    kind: InteractiveRequestKind::PlanApproval,
                    approval_decisions: None,
                    title: "Review implementation plan".to_string(),
                    detail: Some(plan_content),
                    command: None,
                    path: None,
                    turn_id: None,
                    item_id: tool_call_id,
                    questions: Vec::new(),
                    created_at: Utc::now(),
                };
                self.inner.interactive_requests.lock().await.insert(
                    (workspace_id.to_string(), request_id.clone()),
                    PendingServerRequest {
                        raw_id: Value::Null,
                        request: request.clone(),
                        params: Value::Null,
                    },
                );
                let thread = self
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.status = ThreadStatus::WaitingForInput;
                        thread.updated_at = Utc::now();
                    })
                    .await?;
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::InteractiveRequest {
                        request: request.clone(),
                    },
                );
                self.notify_remote_attention("approval", workspace_id, Some(thread_id.clone()))
                    .await;
                self.push_conversation_item(
                    workspace_id,
                    &thread_id,
                    ConversationItem::InteractiveRequest {
                        id: request_id,
                        request: Box::new(request),
                        created_at: Utc::now(),
                        resolved: false,
                        resolution: None,
                    },
                    false,
                )
                .await?;
                self.emit(
                    Some(workspace_id.to_string()),
                    None,
                    UnifiedEvent::Snapshot {
                        snapshot: self.snapshot().await,
                    },
                );
            }
            AcpEvent::QuestionRequest {
                session_id,
                request_id,
                title,
                questions,
            } => {
                let Some(thread_id) = runtime.thread_for_session(&session_id).await else {
                    runtime.cancel_question(&request_id).await?;
                    return Ok(());
                };
                let request = InteractiveRequest {
                    request_id: request_id.clone(),
                    workspace_id: workspace_id.to_string(),
                    thread_id: Some(thread_id.clone()),
                    method: "cursor/ask_question".to_string(),
                    kind: InteractiveRequestKind::Question,
                    approval_decisions: None,
                    title,
                    detail: None,
                    command: None,
                    path: None,
                    turn_id: None,
                    item_id: None,
                    questions,
                    created_at: Utc::now(),
                };
                self.inner.interactive_requests.lock().await.insert(
                    (workspace_id.to_string(), request_id.clone()),
                    PendingServerRequest {
                        raw_id: Value::Null,
                        request: request.clone(),
                        params: Value::Null,
                    },
                );
                let thread = self
                    .upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.status = ThreadStatus::WaitingForInput;
                        thread.updated_at = Utc::now();
                    })
                    .await?;
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.clone()),
                    UnifiedEvent::InteractiveRequest {
                        request: request.clone(),
                    },
                );
                self.notify_remote_attention("question", workspace_id, Some(thread_id.clone()))
                    .await;
                self.push_conversation_item(
                    workspace_id,
                    &thread_id,
                    ConversationItem::InteractiveRequest {
                        id: request_id,
                        request: Box::new(request),
                        created_at: Utc::now(),
                        resolved: false,
                        resolution: None,
                    },
                    false,
                )
                .await?;
                self.emit(
                    Some(workspace_id.to_string()),
                    None,
                    UnifiedEvent::Snapshot {
                        snapshot: self.snapshot().await,
                    },
                );
            }
            AcpEvent::TurnEnded {
                session_id,
                stop_reason,
                error,
                had_output,
            } => {
                if let Some(thread_id) = runtime.thread_for_session(&session_id).await {
                    let settlement = match stop_reason.as_deref() {
                        None => ToolSettlement::Failed,
                        Some("cancelled") => ToolSettlement::Interrupted,
                        Some(_) => ToolSettlement::Completed,
                    };
                    self.settle_turn_items_with_error(
                        workspace_id,
                        &thread_id,
                        Utc::now(),
                        settlement,
                        error.as_deref(),
                    )
                    .await;
                    // A turn the agent cut short would otherwise be
                    // indistinguishable from a normal completion — the user
                    // just sees the agent "stop mid-answer".
                    if let Some(notice) = acp_stop_reason_notice(stop_reason.as_deref()) {
                        self.push_conversation_item(
                            workspace_id,
                            &thread_id,
                            ConversationItem::Service {
                                id: format!("acp-stop-{}", uuid::Uuid::new_v4().simple()),
                                level: ServiceLevel::Warning,
                                message: notice,
                                created_at: Utc::now(),
                            },
                            true,
                        )
                        .await?;
                    }
                    // pi-acp maps a failed Pi RPC turn (401, missing model)
                    // onto ACP `end_turn` with no assistant text. OpenCode can
                    // do the same with a successful stopReason while the
                    // cause lives only on stderr (`TurnEnded.error`).
                    if !had_output && acp_empty_turn_stop_reason(stop_reason.as_deref()) {
                        let message = match error.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
                            Some(detail) => format!("The agent finished without a reply. {detail}"),
                            None => "The agent finished without a reply. Check that this harness is authenticated and the selected model can run.".to_string(),
                        };
                        self.push_conversation_item(
                            workspace_id,
                            &thread_id,
                            ConversationItem::Service {
                                id: format!("acp-empty-turn-{}", uuid::Uuid::new_v4().simple()),
                                level: ServiceLevel::Warning,
                                message,
                                created_at: Utc::now(),
                            },
                            true,
                        )
                        .await?;
                    }
                }
                runtime.end_turn(&session_id).await;
            }
            AcpEvent::Fatal { message } => {
                for thread_id in runtime.active_thread_ids().await {
                    let _ = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            if matches!(
                                thread.status,
                                ThreadStatus::Running | ThreadStatus::WaitingForInput
                            ) {
                                thread.status = ThreadStatus::Error;
                                thread.last_error = Some(message.clone());
                                thread.updated_at = Utc::now();
                            }
                        })
                        .await;
                    self.settle_turn_items_with_error(
                        workspace_id,
                        &thread_id,
                        Utc::now(),
                        ToolSettlement::Failed,
                        Some(&message),
                    )
                    .await;
                }
                self.emit(
                    Some(workspace_id.to_string()),
                    None,
                    UnifiedEvent::Snapshot {
                        snapshot: self.snapshot().await,
                    },
                );
            }
        }
        Ok(())
    }

    /// Projects `diff` content blocks from an ACP tool call into real
    /// file-change items, matching what Codex/Claude edits produce, instead
    /// of dropping them. Item ids are deterministic per call+path so later
    /// updates of the same tool call replace rather than duplicate.
    async fn push_acp_diff_items(
        &self,
        workspace_id: &str,
        thread_id: &str,
        call_id: &str,
        status: &str,
        diffs: &[AcpDiffContent],
        replay: bool,
    ) -> Result<(), DaemonError> {
        for (index, diff) in diffs.iter().enumerate() {
            let change_kind = if diff.old_text.is_none() {
                "add"
            } else {
                "update"
            };
            let lifecycle =
                tool_display_metadata("File change", "edit", status, None, None).lifecycle;
            self.insert_acp_conversation_item(
                workspace_id,
                thread_id,
                ConversationItem::FileChange {
                    id: format!("acp-diff-{call_id}-{index}"),
                    changes: vec![ConversationFileChange {
                        path: diff.path.clone(),
                        change_kind: change_kind.to_string(),
                        diff: simple_unified_diff(diff.old_text.as_deref(), &diff.new_text),
                        move_path: None,
                    }],
                    status: status.to_string(),
                    lifecycle,
                    created_at: Utc::now(),
                    completed_at: (status == "completed" || status == "failed").then(Utc::now),
                },
                true,
                replay,
            )
            .await?;
        }
        Ok(())
    }

    async fn push_acp_tool_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        item: AcpToolItem<'_>,
        replay: bool,
    ) -> Result<(), DaemonError> {
        let display = tool_display_metadata(item.title, item.kind, item.status, None, item.output);
        self.insert_acp_conversation_item(
            workspace_id,
            thread_id,
            ConversationItem::ToolCall {
                id: item.call_id.to_string(),
                title: item.title.to_string(),
                tool_kind: item.kind.to_string(),
                status: item.status.to_string(),
                output: item.output.map(ToOwned::to_owned),
                exit_code: None,
                display: Box::new(display),
                detail: None,
                created_at: Utc::now(),
                completed_at: (item.status == "completed" || item.status == "failed")
                    .then(Utc::now),
            },
            true,
            replay,
        )
        .await
    }

    /// Inserts an ACP conversation item, routing `session/load` replay through
    /// the attention-neutral path: replayed history is recovery, not new agent
    /// output, and must not advance the unread stamp (`replay_conversation_item`).
    async fn insert_acp_conversation_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        item: ConversationItem,
        update_existing: bool,
        replay: bool,
    ) -> Result<(), DaemonError> {
        if replay {
            self.replay_conversation_item(workspace_id, thread_id, item, update_existing)
                .await
        } else {
            self.push_conversation_item(workspace_id, thread_id, item, update_existing)
                .await
        }
    }

    /// Answers a pending ACP permission request with a user decision.
    pub(super) async fn respond_acp_permission(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), DaemonError> {
        let Some(thread_id) = thread_id else {
            return Err(DaemonError::BadRequest(
                "ACP permission request has no thread".to_string(),
            ));
        };
        let provider = self.thread_provider(workspace_id, thread_id).await?;
        // Only the process that asked can answer. `acp_runtime_for` would
        // happily spawn a replacement agent here, which then reports the
        // request as missing — so a dead or replaced harness is reported as a
        // stale request straight away, and the caller retires the prompt.
        let runtime = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .get(workspace_id)
                .and_then(|workspace| workspace.acp_runtimes.get(&provider))
                .filter(|runtime| !runtime.is_closed())
                .map(Arc::clone)
        };
        let runtime = runtime
            .ok_or_else(|| DaemonError::NotFound("ACP permission request not found".to_string()))?;
        runtime.respond_permission(request_id, decision).await
    }

    /// Answers a pending Grok plan review on the exact runtime that raised it.
    pub(super) async fn respond_acp_plan_approval(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
        request_id: &str,
        outcome: PlanApprovalOutcome,
        feedback: Option<String>,
    ) -> Result<(), DaemonError> {
        let Some(thread_id) = thread_id else {
            return Err(DaemonError::BadRequest(
                "ACP plan approval has no thread".to_string(),
            ));
        };
        let provider = self.thread_provider(workspace_id, thread_id).await?;
        let runtime = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .get(workspace_id)
                .and_then(|workspace| workspace.acp_runtimes.get(&provider))
                .filter(|runtime| !runtime.is_closed())
                .map(Arc::clone)
        };
        let runtime = runtime
            .ok_or_else(|| DaemonError::NotFound("ACP plan approval not found".to_string()))?;
        runtime
            .respond_plan_approval(request_id, outcome, feedback)
            .await
    }

    /// Answers a pending Cursor clarifying question on the runtime that raised it.
    pub(super) async fn respond_acp_question(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
        request_id: &str,
        answers: &std::collections::HashMap<String, Vec<String>>,
    ) -> Result<(), DaemonError> {
        let Some(thread_id) = thread_id else {
            return Err(DaemonError::BadRequest(
                "ACP question has no thread".to_string(),
            ));
        };
        let provider = self.thread_provider(workspace_id, thread_id).await?;
        let runtime = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces
                .get(workspace_id)
                .and_then(|workspace| workspace.acp_runtimes.get(&provider))
                .filter(|runtime| !runtime.is_closed())
                .map(Arc::clone)
        };
        let runtime = runtime
            .ok_or_else(|| DaemonError::NotFound("ACP question request not found".to_string()))?;
        runtime.respond_question(request_id, answers).await
    }
}

/// Reconciles an ACP session's model catalog with what the workspace already
/// advertises.
///
/// An ACP session publishes one effort list, which belongs to whichever model
/// the session is on, and FalconDeck attaches it to every model in the same
/// response. OpenCode instead describes effort levels per model (its
/// *variants*), published straight from the provider catalog, so its richer
/// list must survive a later session-derived refresh.
fn merged_models(
    provider: &AgentProvider,
    existing: &[ModelSummary],
    discovered: Vec<ModelSummary>,
) -> Vec<ModelSummary> {
    if !provider.as_str().eq_ignore_ascii_case("opencode") {
        return discovered;
    }
    discovered
        .into_iter()
        .map(|mut model| {
            if let Some(catalog) = existing.iter().find(|candidate| {
                candidate.id == model.id && !candidate.supported_reasoning_efforts.is_empty()
            }) {
                model
                    .supported_reasoning_efforts
                    .clone_from(&catalog.supported_reasoning_efforts);
                model
                    .default_reasoning_effort
                    .clone_from(&catalog.default_reasoning_effort);
            }
            model
        })
        .collect()
}

fn latest_user_message_contains_echo(items: &[ConversationItem], echoed_text: &str) -> bool {
    if echoed_text.is_empty() {
        return false;
    }
    let Some(user_index) = items
        .iter()
        .rposition(|item| matches!(item, ConversationItem::UserMessage { .. }))
    else {
        return false;
    };
    let ConversationItem::UserMessage { text, .. } = &items[user_index] else {
        return false;
    };
    if !(text.starts_with(echoed_text)
        || echoed_text
            .strip_prefix(text.as_str())
            .is_some_and(is_attachment_placeholder_remainder))
    {
        return false;
    }
    let later = &items[user_index + 1..];
    // Grok (and other ACP agents) echo the submitted prompt as
    // `user_message_chunk`. That can arrive after thoughts, tools, or a
    // `session/cancel` receipt — `items.last()` is then no longer the user
    // message, so a last-item-only check would record a duplicate bubble.
    // An interrupt receipt still belongs to this turn; suppress the echo.
    // A completed terminal answer without an interrupt means session/load
    // replay has moved on to a later historical prompt.
    if later.iter().any(is_interrupt_receipt) {
        return true;
    }
    !later.iter().any(is_completed_terminal_answer)
}

fn is_interrupt_receipt(item: &ConversationItem) -> bool {
    matches!(
        item,
        ConversationItem::AssistantMessage {
            lifecycle: ContentLifecycle::Interrupted,
            ..
        }
    )
}

fn is_completed_terminal_answer(item: &ConversationItem) -> bool {
    match item {
        ConversationItem::AssistantMessage {
            phase, lifecycle, ..
        } => {
            !matches!(phase, Some(AssistantMessagePhase::Commentary))
                && *lifecycle == ContentLifecycle::Complete
        }
        ConversationItem::CodeReview { lifecycle, .. } => *lifecycle == ContentLifecycle::Complete,
        _ => false,
    }
}

/// Whether `remainder` is only the placeholder labels that
/// `acp_content_block_text` substitutes for non-text prompt blocks
/// ("[image: image/png]", "[audio]", "[resource: file://…]") plus whitespace.
/// Providers that echo the submitted prompt (Grok) include its attachment
/// blocks, so the echo can be longer than the locally recorded message, which
/// never carries these placeholders.
fn is_attachment_placeholder_remainder(remainder: &str) -> bool {
    let mut rest = remainder.trim_start();
    while let Some(after_open) = rest.strip_prefix('[') {
        let Some((label, after_close)) = after_open.split_once(']') else {
            return false;
        };
        if !(label == "image"
            || label == "audio"
            || label.starts_with("image:")
            || label.starts_with("resource:"))
        {
            return false;
        }
        rest = after_close.trim_start();
    }
    rest.is_empty()
}

/// Applies a permission-mode update to an already-open ACP session.
///
/// The thread summary is FalconDeck's durable record, but ACP agents keep the
/// active mode inside their session. Updating only the summary makes a picker
/// appear to work while the harness continues prompting with its old mode.
pub(super) async fn set_acp_thread_permission_mode(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    requested_mode: &Option<String>,
) -> Result<(), DaemonError> {
    let provider = app.thread_provider(workspace_id, thread_id).await?;
    let ProviderRuntime::Acp(provider) = ProviderRuntime::for_provider(&provider) else {
        return Ok(());
    };

    let is_native_opencode = {
        let workspaces = app.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.threads.get(thread_id))
            .is_some_and(|thread| thread.summary.provider_transport.as_deref() == Some("native"))
    };
    if is_native_opencode {
        // Native OpenCode permission behavior is enforced by the polling
        // loop from the stored thread mode; there is no ACP session to update.
        return Ok(());
    }

    let session_id = {
        let workspaces = app.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.threads.get(thread_id))
            .and_then(|thread| thread.summary.native_session_id.clone())
    };
    let Some(session_id) = session_id else {
        // The first turn will apply the stored mode after ACP creates a
        // session, so changing a brand-new thread still works.
        return Ok(());
    };

    let runtime = app.acp_runtime_for(workspace_id, &provider).await?;
    let available_modes = runtime.capability_summary().await.permission_modes;
    let Some(desired_mode) = requested_mode
        .as_deref()
        .map(str::trim)
        .filter(|mode| !mode.is_empty())
    else {
        // Clearing the picker restores the provider's own default. Do not
        // fall through to the most permissive advertised mode — that would
        // YOLO a thread the user just set to "Ask to approve".
        return Ok(());
    };
    if !available_modes.iter().any(|mode| mode == desired_mode) {
        return Err(DaemonError::BadRequest(format!(
            "permission mode '{desired_mode}' is not advertised by provider '{provider}'"
        )));
    }
    if runtime
        .supports_session_permission_updates(&session_id)
        .await
    {
        return runtime
            .apply_session_preferences(&session_id, None, None, None, Some(desired_mode))
            .await;
    }
    if let Some(mode_state) = runtime.session_mode_state(&session_id).await
        && mode_state.available.iter().any(|mode| mode == desired_mode)
    {
        if mode_state.current.as_deref() == Some(desired_mode) {
            return Ok(());
        }
        return runtime.set_session_mode(&session_id, desired_mode).await;
    }
    // No session-level lever for this harness. Daemon-enforced modes
    // (blanket approval, or the provider's "ask" default) only need to live
    // on the thread: the next permission request reads that stored value.
    if crate::acp::is_blanket_approval_mode(desired_mode)
        || desired_mode.eq_ignore_ascii_case("default")
    {
        return Ok(());
    }
    Err(DaemonError::BadRequest(format!(
        "provider '{provider}' only supports choosing permissions before the first turn"
    )))
}

fn default_acp_mode(available_modes: &[String]) -> Option<&str> {
    const PERMISSIVE_MODES: &[&str] = &[
        "bypasspermissions",
        "bypasspermission",
        "dontask",
        "never",
        "alwaysapprove",
        "alwaysallow",
        "allowall",
        "yolo",
        "auto",
    ];
    for preferred in PERMISSIVE_MODES {
        if let Some(mode) = available_modes.iter().find(|mode| {
            mode.replace(['-', '_', ' '], "")
                .eq_ignore_ascii_case(preferred)
        }) {
            return Some(mode.as_str());
        }
    }
    available_modes
        .iter()
        .find(|mode| {
            matches!(
                mode.replace(['-', '_', ' '], "")
                    .to_ascii_lowercase()
                    .as_str(),
                "default" | "normal" | "standard"
            )
        })
        .map(String::as_str)
        .or_else(|| available_modes.first().map(String::as_str))
}

fn acp_empty_turn_stop_reason(stop_reason: Option<&str>) -> bool {
    matches!(
        stop_reason
            .map(|reason| reason.trim().to_ascii_lowercase())
            .as_deref(),
        Some("end_turn") | Some("stop") | Some("completed") | Some("complete")
    )
}

/// A user-facing notice for stop reasons that cut the turn short. `end_turn`
/// and `cancelled` are unremarkable (normal completion / user interrupt).
fn acp_stop_reason_notice(stop_reason: Option<&str>) -> Option<String> {
    match stop_reason {
        None | Some("end_turn") | Some("cancelled") | Some("stop") | Some("completed")
        | Some("complete") => None,
        Some("refusal") => Some("The agent declined to continue this turn.".to_string()),
        Some("max_tokens") => {
            Some("The turn stopped early: the model hit its output token limit.".to_string())
        }
        Some("max_turn_requests") => {
            Some("The turn stopped early: it reached the provider's request limit.".to_string())
        }
        Some(other) => Some(format!("The turn ended with stop reason '{other}'.")),
    }
}

/// Minimal unified diff for an ACP `diff` block (old/new full texts).
/// Trims the common prefix and suffix and emits one hunk with no context
/// lines — enough for the clients' diff renderer without a diff dependency.
fn simple_unified_diff(old_text: Option<&str>, new_text: &str) -> String {
    let old_lines = old_text.unwrap_or_default().lines().collect::<Vec<_>>();
    let new_lines = new_text.lines().collect::<Vec<_>>();
    let mut prefix = 0;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old_lines.len() - prefix
        && suffix < new_lines.len() - prefix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let removed = &old_lines[prefix..old_lines.len() - suffix];
    let added = &new_lines[prefix..new_lines.len() - suffix];
    if removed.is_empty() && added.is_empty() {
        return String::new();
    }
    let hunk_start = |count: usize| if count == 0 { prefix } else { prefix + 1 };
    let mut out = format!(
        "@@ -{},{} +{},{} @@\n",
        hunk_start(removed.len()),
        removed.len(),
        hunk_start(added.len()),
        added.len()
    );
    for line in removed {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for line in added {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Maps ACP tool statuses onto the daemon's running/completed/failed set.
fn normalize_acp_tool_status(status: &str) -> String {
    match status {
        "pending" | "in_progress" => "running".to_string(),
        "completed" => "completed".to_string(),
        "failed" => "failed".to_string(),
        other => other.to_string(),
    }
}

/// Runs one ACP turn: ensures the session, prompts, and settles thread status
/// when the agent reports a stop reason.
pub(super) struct AcpTurnStartOptions {
    pub(super) wait_for_startup: bool,
    pub(super) resume_interrupted: bool,
}

pub(super) async fn start_acp_turn(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    provider: &AgentProvider,
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
    options: AcpTurnStartOptions,
) -> Result<(), DaemonError> {
    if options.wait_for_startup {
        return run_acp_turn_startup(
            app,
            workspace_id,
            thread_id,
            provider,
            inputs,
            selected_skills,
            options.resume_interrupted,
        )
        .await;
    }
    let app = app.clone();
    let workspace_id = workspace_id.to_string();
    let thread_id = thread_id.to_string();
    let provider = provider.clone();
    let inputs = inputs.to_vec();
    let selected_skills = selected_skills.to_vec();
    tokio::spawn(async move {
        if let Err(error) = run_acp_turn_startup(
            &app,
            &workspace_id,
            &thread_id,
            &provider,
            &inputs,
            &selected_skills,
            options.resume_interrupted,
        )
        .await
        {
            let provider_label = app
                .fresh_acp_provider_configs()
                .into_iter()
                .find(|config| config.id == provider.as_str())
                .map(|config| config.label)
                .unwrap_or_else(|| provider.to_string());
            let detail = error.to_string();
            let message = if detail.contains("restart FalconDeck")
                || detail.contains("Restart FalconDeck")
            {
                detail
            } else {
                format!(
                    "{provider_label} failed to start: {detail}. Check that the {provider_label} harness is installed, authenticated, and can start in this workspace. If the problem continues, restart FalconDeck and try again."
                )
            };
            let failed_at = Utc::now();
            let _ = app
                .with_thread_mut(&workspace_id, &thread_id, |thread| {
                    thread.status = ThreadStatus::Error;
                    thread.last_error = Some(message.clone());
                    thread.updated_at = failed_at;
                })
                .await;
            app.settle_turn_items_with_error(
                &workspace_id,
                &thread_id,
                failed_at,
                ToolSettlement::Failed,
                Some(&message),
            )
            .await;
            let _ = app
                .push_conversation_item(
                    &workspace_id,
                    &thread_id,
                    ConversationItem::Service {
                        id: format!("acp-start-error-{}", uuid::Uuid::new_v4().simple()),
                        level: ServiceLevel::Error,
                        message: message.clone(),
                        created_at: failed_at,
                    },
                    true,
                )
                .await;
            if let Ok(thread) = app.thread_summary(&workspace_id, &thread_id).await {
                app.emit(
                    Some(workspace_id.clone()),
                    Some(thread_id.clone()),
                    UnifiedEvent::ThreadUpdated { thread },
                );
            }
            app.notify_remote_attention("turn-error", &workspace_id, Some(thread_id))
                .await;
        }
    });
    Ok(())
}

async fn run_acp_turn_startup(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    provider: &AgentProvider,
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
    resume_interrupted: bool,
) -> Result<(), DaemonError> {
    let mut runtime = match app.acp_runtime_for(workspace_id, provider).await {
        Ok(runtime) => runtime,
        Err(DaemonError::AcpRequestTimeout { ref method, .. }) if method == "initialize" => {
            let label = app
                .fresh_acp_provider_configs()
                .into_iter()
                .find(|config| config.id == provider.as_str())
                .map(|config| config.label)
                .unwrap_or_else(|| provider.to_string());
            let _ = app
                .push_conversation_item(
                    workspace_id,
                    thread_id,
                    ConversationItem::Service {
                        id: format!("acp-init-retry-{}", uuid::Uuid::new_v4().simple()),
                        level: ServiceLevel::Warning,
                        message: format!(
                            "{label} did not finish initializing. FalconDeck stopped that harness and is retrying once."
                        ),
                        created_at: Utc::now(),
                    },
                    true,
                )
                .await;
            app.acp_runtime_for(workspace_id, provider).await?
        }
        Err(error) => return Err(error),
    };
    // A native session id persisted from a previous daemon run lets the agent
    // resume via session/load instead of starting from a blank session. Normal
    // sends only offer it when the in-memory history is empty because load
    // replays the whole conversation. Explicit interrupted recovery already
    // performed a strict preflight and must retain the id even after replay
    // populated the thread.
    let (
        known_native_session,
        requested_model_id,
        requested_reasoning_effort,
        requested_collaboration_mode,
        requested_permission_mode,
        cwd,
    ) = {
        let workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces.get(workspace_id);
        let thread = workspace.and_then(|workspace| workspace.threads.get(thread_id));
        (
            thread
                .filter(|thread| resume_interrupted || thread.items.is_empty())
                .and_then(|thread| thread.summary.native_session_id.clone()),
            thread.and_then(|thread| thread.summary.agent.model_id.clone()),
            thread.and_then(|thread| thread.summary.agent.reasoning_effort.clone()),
            thread.and_then(|thread| thread.summary.agent.collaboration_mode_id.clone()),
            thread.and_then(|thread| thread.summary.agent.permission_mode.clone()),
            match (workspace, thread) {
                (Some(workspace), Some(thread)) => thread
                    .summary
                    .working_directory(&workspace.summary.path)
                    .to_string(),
                _ => runtime.workspace_path().to_string(),
            },
        )
    };
    let builtin = app
        .builtin_connectors(provider, &cwd, Some(thread_id))
        .await;
    let agent_context = app
        .agent_context_instructions_with_extensions(provider)
        .await;
    let first_start = if resume_interrupted {
        let native_session = known_native_session.as_deref().ok_or_else(|| {
            DaemonError::BadRequest(
                "cannot safely continue because FalconDeck has no durable native session id"
                    .to_string(),
            )
        })?;
        runtime
            .ensure_loaded_session(thread_id, native_session, &cwd, &builtin)
            .await
    } else {
        runtime
            .ensure_session(
                thread_id,
                known_native_session.as_deref(),
                &cwd,
                requested_permission_mode.as_deref(),
                &builtin,
                agent_context.as_deref(),
                requested_model_id.as_deref(),
            )
            .await
    };
    let session_id = match first_start {
        Ok(session_id) => session_id,
        Err(DaemonError::AcpRequestTimeout { ref method, .. }) if method == "session/new" => {
            let label = runtime.config.label.clone();
            tracing::warn!(
                provider = %runtime.config.id,
                %thread_id,
                "ACP session creation timed out; recycling the harness before one retry"
            );

            let Some(fresh_runtime) = app
                .restart_acp_runtime_for_turn_start(workspace_id, thread_id, provider, &runtime)
                .await?
            else {
                let message = format!(
                    "{label} did not finish starting. FalconDeck could not safely restart its shared harness because another {label} turn is active. Wait for that turn to finish or restart FalconDeck, then check the {label} harness and try again."
                );
                return Err(DaemonError::Process(message));
            };
            runtime = fresh_runtime;
            let retry_notice = format!(
                "{label} took too long to start. FalconDeck restarted its local harness and is retrying once."
            );
            let _ = app
                .push_conversation_item(
                    workspace_id,
                    thread_id,
                    ConversationItem::Service {
                        id: format!("acp-start-retry-{}", uuid::Uuid::new_v4().simple()),
                        level: ServiceLevel::Warning,
                        message: retry_notice,
                        created_at: Utc::now(),
                    },
                    true,
                )
                .await;
            match runtime
                .ensure_session(
                    thread_id,
                    known_native_session.as_deref(),
                    &cwd,
                    requested_permission_mode.as_deref(),
                    &builtin,
                    agent_context.as_deref(),
                    requested_model_id.as_deref(),
                )
                .await
            {
                Ok(session_id) => session_id,
                Err(retry_error) => {
                    let message = format!(
                        "{label} did not finish starting after FalconDeck restarted its harness and retried. Restart FalconDeck, then check that the {label} harness is installed, authenticated, and can start in this workspace. Last error: {retry_error}"
                    );
                    return Err(DaemonError::Process(message));
                }
            }
        }
        Err(error) => return Err(error),
    };
    app.with_thread_mut(workspace_id, thread_id, |thread| {
        thread.native_session_id = Some(session_id.clone());
    })
    .await?;
    // The provider owns the transcript; this id is FalconDeck's only durable
    // join key. Commit it before the prompt can execute tools so killing the
    // daemon mid-turn cannot strand an otherwise intact provider session.
    app.persist_local_state().await?;

    // Discovery may have failed during background hydration (for example
    // while the CLI was still authenticating). A real session response is
    // authoritative, so publish its catalog before the turn starts.
    let discovered_models = runtime.advertised_models().await;
    let discovered_collaboration_modes = runtime.advertised_collaboration_modes().await;
    let discovered_capabilities = runtime.capability_summary().await;
    let effective_permission_mode = requested_permission_mode
        .clone()
        .or_else(|| default_acp_mode(&discovered_capabilities.permission_modes).map(str::to_owned));
    let metadata_changed = {
        let mut workspaces = app.inner.workspaces.lock().await;
        workspaces
            .get_mut(workspace_id)
            .and_then(|workspace| {
                workspace
                    .summary
                    .agents
                    .iter_mut()
                    .find(|agent| &agent.provider == provider)
            })
            .is_some_and(|agent| {
                let discovered_models =
                    merged_models(provider, &agent.models, discovered_models.clone());
                let models_changed =
                    !discovered_models.is_empty() && agent.models != discovered_models;
                let collaboration_modes_changed = !discovered_collaboration_modes.is_empty()
                    && agent.collaboration_modes != discovered_collaboration_modes;
                let changed = models_changed
                    || collaboration_modes_changed
                    || agent.capabilities != discovered_capabilities;
                if changed {
                    if models_changed {
                        agent.models = discovered_models.clone();
                    }
                    if collaboration_modes_changed {
                        agent.collaboration_modes = discovered_collaboration_modes.clone();
                    }
                    agent.capabilities = discovered_capabilities.clone();
                }
                changed
            })
    };
    if metadata_changed {
        app.emit(
            Some(workspace_id.to_string()),
            None,
            UnifiedEvent::Snapshot {
                snapshot: app.snapshot().await,
            },
        );
    }

    if requested_permission_mode.is_none()
        && let Some(permission_mode) = effective_permission_mode.clone()
    {
        app.with_thread_mut(workspace_id, thread_id, |thread| {
            thread.agent.permission_mode = Some(permission_mode);
        })
        .await?;
    }

    // Sessions advertise permission modes (ACP session modes). Surface them
    // on the workspace agent entry so the composer shows the picker, and
    // apply the user's selection via session/set_mode before prompting.
    if let Some(mode_state) = runtime.session_mode_state(&session_id).await
        && !mode_state.available.is_empty()
    {
        let modes_changed = {
            let mut workspaces = app.inner.workspaces.lock().await;
            workspaces
                .get_mut(workspace_id)
                .and_then(|workspace| {
                    workspace
                        .summary
                        .agents
                        .iter_mut()
                        .find(|agent| &agent.provider == provider)
                })
                .is_some_and(|agent| {
                    let modes = mode_state
                        .available
                        .iter()
                        .map(|id| falcondeck_core::CollaborationModeSummary {
                            id: id.clone(),
                            label: id.clone(),
                            mode: Some(id.clone()),
                            model_id: None,
                            reasoning_effort: None,
                            is_native: true,
                        })
                        .collect::<Vec<_>>();
                    if agent.collaboration_modes == modes {
                        false
                    } else {
                        agent.collaboration_modes = modes;
                        true
                    }
                })
        };
        if modes_changed {
            app.emit(
                Some(workspace_id.to_string()),
                None,
                UnifiedEvent::Snapshot {
                    snapshot: app.snapshot().await,
                },
            );
        }
    }

    if let Err(error) = runtime
        .apply_session_preferences(
            &session_id,
            requested_model_id.as_deref(),
            requested_reasoning_effort.as_deref(),
            requested_collaboration_mode.as_deref(),
            effective_permission_mode.as_deref(),
        )
        .await
    {
        tracing::warn!(
            provider = %runtime.config.id,
            %error,
            "failed to apply ACP session configuration; continuing with provider defaults"
        );
    }

    let content = acp_turn_content(&runtime, inputs, selected_skills).await;

    let app = app.clone();
    let workspace_id = workspace_id.to_string();
    let thread_id = thread_id.to_string();
    tokio::spawn(async move {
        let outcome = runtime.prompt(&session_id, content.blocks).await;
        let (status, error) = match &outcome {
            Ok(stop_reason) if stop_reason == "cancelled" => (ThreadStatus::Idle, None),
            Ok(_) => (ThreadStatus::Idle, None),
            Err(error) => (ThreadStatus::Error, Some(error.to_string())),
        };
        let updated = app
            .upsert_thread(&workspace_id, &thread_id, |thread| {
                thread.status = status.clone();
                thread.last_error = error.clone();
                thread.updated_at = Utc::now();
            })
            .await;
        if let Ok(thread) = updated {
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

/// Injects a message into a running ACP turn. Providers with a compatible
/// vendor extension (Grok's probed `x.ai/interject`) get true injection —
/// the running prompt keeps its in-flight work. Everyone else is steered by
/// cancelling the in-flight prompt and re-prompting on the same session,
/// which any ACP agent supports.
pub(super) async fn steer_acp_turn(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    provider: &AgentProvider,
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
) -> Result<(), DaemonError> {
    let runtime = app.acp_runtime_for(workspace_id, provider).await?;
    let session_id = {
        let workspaces = app.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .and_then(|workspace| workspace.threads.get(thread_id))
            .and_then(|thread| thread.summary.native_session_id.clone())
            .ok_or_else(|| DaemonError::BadRequest("no active ACP session to steer".to_string()))?
    };
    let content = acp_turn_content(&runtime, inputs, selected_skills).await;
    if runtime.supports_interject() {
        match runtime
            .interject(&session_id, &content.text, content.blocks.clone())
            .await
        {
            Ok(()) => return Ok(()),
            Err(error) => {
                // The probe treats any non-"method not found" reply as
                // support, including Grok builds that accept the method
                // then reject a live session. Cancel-and-re-prompt still
                // lands the steer on those.
                tracing::info!(
                    %error,
                    session = %session_id,
                    "ACP vendor interject failed; steering via cancel-and-re-prompt"
                );
            }
        }
    }
    runtime.steer_with_cancel(&session_id, content.blocks).await
}

struct AcpTurnContent {
    text: String,
    blocks: Vec<Value>,
}

async fn acp_turn_content(
    runtime: &AcpRuntime,
    inputs: &[TurnInputItem],
    selected_skills: &[ResolvedSelectedSkill],
) -> AcpTurnContent {
    let mut text = inputs
        .iter()
        .filter_map(|input| match input {
            TurnInputItem::Text { text, .. } => Some(text.as_str()),
            TurnInputItem::Image(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    // ACP agents have no native skill surface; fold selected skills into the
    // prompt as file references (as the Claude path does) so a selection is
    // never silently dropped.
    let skill_preambles = selected_skills
        .iter()
        .filter_map(|skill| {
            skill
                .summary
                .provider_translations
                .claude
                .as_ref()
                .and_then(|translation| translation.prompt_reference_path.as_deref())
                .or(skill.summary.source_path.as_deref())
                .map(falcondeck_skill_path_preamble)
                .or_else(|| Some(falcondeck_skill_name_preamble(&skill.summary.label)))
        })
        .collect::<Vec<_>>();
    if !skill_preambles.is_empty() {
        let preamble = skill_preambles.join("\n");
        text = if text.trim().is_empty() {
            preamble
        } else {
            format!("{preamble}\n\n{text}")
        };
    }
    let mut content = Vec::new();
    if !text.trim().is_empty() {
        content.push(serde_json::json!({ "type": "text", "text": &text }));
    }
    let supports_images = runtime.capability_summary().await.supports_images;
    let mut encoded_budget = crate::acp::MAX_ACP_TOTAL_ENCODED_IMAGE_BYTES;
    for input in inputs {
        let TurnInputItem::Image(image) = input else {
            continue;
        };
        if supports_images {
            // Falls back to a text reference on oversize/unreadable files, so
            // the attachment is never silently dropped.
            content.push(crate::acp::acp_image_content_block(image, &mut encoded_budget).await);
        } else {
            let reference = image
                .local_path
                .as_deref()
                .or(image.name.as_deref())
                .unwrap_or("attachment");
            content.push(serde_json::json!({
                "type": "text",
                "text": format!("[attached image: {reference}]"),
            }));
        }
    }

    AcpTurnContent {
        text,
        blocks: content,
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc, time::Duration};

    use chrono::Utc;
    use tempfile::tempdir;

    use super::{
        acp_empty_turn_stop_reason, acp_metadata_updated_at, conversation_item_from_projected_user,
        default_acp_mode, falcondeck_skill_path_preamble, latest_user_message_contains_echo,
    };
    use falcondeck_core::{ContentLifecycle, ConversationItem};

    use crate::app::AppState;

    #[test]
    fn replayed_acp_metadata_preserves_the_activity_timestamp() {
        let activity = Utc::now() - chrono::Duration::days(2);
        let relaunched = Utc::now();

        assert_eq!(
            acp_metadata_updated_at(activity, true, true, relaunched),
            activity
        );
        assert_eq!(
            acp_metadata_updated_at(activity, false, true, relaunched),
            relaunched
        );
        assert_eq!(
            acp_metadata_updated_at(activity, false, false, relaunched),
            activity
        );
    }

    #[tokio::test]
    async fn transcript_hydration_is_serialized_per_thread() {
        let temp_dir = tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            temp_dir.path().join("daemon-state.json"),
        );
        let first = app.acp_hydration_gate("workspace-1", "thread-1").await;
        let second = app.acp_hydration_gate("workspace-1", "thread-1").await;
        assert!(Arc::ptr_eq(&first, &second));

        let guard = first.lock_owned().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), second.clone().lock_owned())
                .await
                .is_err(),
            "a resumed turn must wait for background transcript replay"
        );
        drop(guard);
        tokio::time::timeout(Duration::from_secs(1), second.lock_owned())
            .await
            .expect("the gate must release after replay");
    }

    fn user_message(text: &str) -> ConversationItem {
        ConversationItem::UserMessage {
            id: "submitted-user-message".to_string(),
            text: text.to_string(),
            attachments: Vec::new(),
            turn_id: None,
            previous_turn_id: None,
            created_at: Utc::now(),
        }
    }

    fn assistant(id: &str, text: &str, lifecycle: ContentLifecycle) -> ConversationItem {
        ConversationItem::AssistantMessage {
            id: id.to_string(),
            text: text.to_string(),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle,
            error: None,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn empty_turn_notice_covers_successful_stops_but_not_rpc_failure() {
        assert!(acp_empty_turn_stop_reason(Some("end_turn")));
        assert!(acp_empty_turn_stop_reason(Some("stop")));
        assert!(acp_empty_turn_stop_reason(Some("completed")));
        assert!(!acp_empty_turn_stop_reason(None));
        assert!(!acp_empty_turn_stop_reason(Some("cancelled")));
    }

    #[test]
    fn latest_user_message_contains_echo_matches_partial_provider_echo() {
        let items = vec![user_message("Inspect the attached screenshot")];

        assert!(latest_user_message_contains_echo(&items, "Inspect the"));
    }

    #[test]
    fn latest_user_message_contains_echo_preserves_replayed_user_history() {
        assert!(!latest_user_message_contains_echo(
            &[],
            "A replayed historical prompt"
        ));
    }

    #[test]
    fn latest_user_message_contains_echo_tolerates_attachment_placeholders() {
        let items = vec![user_message("Add a copy prompt option to this menu.")];

        assert!(latest_user_message_contains_echo(
            &items,
            "Add a copy prompt option to this menu. [image: image/png][image: image/png]"
        ));
    }

    #[test]
    fn latest_user_message_contains_echo_matches_attachment_only_prompt_echo() {
        let items = vec![user_message("")];

        assert!(latest_user_message_contains_echo(
            &items,
            "[image: image/png]"
        ));
    }

    #[test]
    fn latest_user_message_contains_echo_rejects_textual_remainder() {
        let items = vec![user_message("Add a copy prompt option")];

        assert!(!latest_user_message_contains_echo(
            &items,
            "Add a copy prompt option but this is a different message"
        ));
    }

    #[test]
    fn latest_user_message_contains_echo_does_not_match_after_agent_activity() {
        let items = vec![
            user_message("Previous prompt"),
            assistant(
                "assistant-message",
                "Previous answer",
                ContentLifecycle::Complete,
            ),
        ];

        assert!(!latest_user_message_contains_echo(
            &items,
            "Previous prompt"
        ));
    }

    #[test]
    fn latest_user_message_contains_echo_matches_after_interrupt_receipt() {
        let items = vec![
            user_message("Map the onboarding flow"),
            assistant(
                "falcondeck-turn-receipt-submitted-user-message",
                "",
                ContentLifecycle::Interrupted,
            ),
        ];

        assert!(latest_user_message_contains_echo(
            &items,
            "Map the onboarding flow"
        ));
    }

    #[test]
    fn latest_user_message_contains_echo_matches_after_thought() {
        let items = vec![
            user_message("Map the onboarding flow"),
            ConversationItem::Reasoning {
                id: "thought-1".to_string(),
                summary: None,
                content: "I'll inspect the wizard steps.".to_string(),
                lifecycle: ContentLifecycle::Streaming,
                duration_ms: None,
                created_at: Utc::now(),
            },
        ];

        assert!(latest_user_message_contains_echo(
            &items,
            "Map the onboarding flow"
        ));
    }

    #[test]
    fn skill_preamble_echo_collapses_to_the_typed_prompt() {
        let items = vec![user_message("/tldr")];
        let echoed = format!(
            "{}\n\n/tldr",
            falcondeck_skill_path_preamble("/tmp/tldr/SKILL.md")
        );
        let item = conversation_item_from_projected_user(
            "echoed-user-message".to_string(),
            &echoed,
            Utc::now(),
        )
        .expect("typed prompt remains");
        let ConversationItem::UserMessage { text, .. } = item else {
            panic!("expected user message");
        };
        assert_eq!(text, "/tldr");
        assert!(latest_user_message_contains_echo(&items, &text));
        assert!(
            conversation_item_from_projected_user(
                "partial-preamble".to_string(),
                "Use the FalconDeck skill defined at /tmp/tldr/SKILL.md",
                Utc::now(),
            )
            .is_none()
        );
    }

    #[test]
    fn latest_user_message_contains_echo_matches_after_interrupt_with_progress() {
        let items = vec![
            user_message("Map the onboarding flow"),
            assistant(
                "progress-1",
                "Looking at the wizard…",
                ContentLifecycle::Complete,
            ),
            assistant(
                "falcondeck-turn-receipt-submitted-user-message",
                "",
                ContentLifecycle::Interrupted,
            ),
        ];

        assert!(latest_user_message_contains_echo(
            &items,
            "Map the onboarding flow"
        ));
    }

    #[test]
    fn default_acp_mode_prefers_a_permissive_mode() {
        let modes = vec![
            "plan".to_string(),
            "default".to_string(),
            "yolo".to_string(),
        ];
        assert_eq!(default_acp_mode(&modes), Some("yolo"));
    }

    #[test]
    fn default_acp_mode_falls_back_to_the_first_advertised_mode() {
        let modes = vec!["safe".to_string(), "fast".to_string()];
        assert_eq!(default_acp_mode(&modes), Some("safe"));
        assert_eq!(default_acp_mode(&[]), None);
    }

    #[test]
    fn cursor_permission_modes_default_to_always_approve() {
        let modes = crate::acp::cursor_placeholder_permission_modes();
        assert_eq!(default_acp_mode(&modes), Some("always-approve"));
    }
}
