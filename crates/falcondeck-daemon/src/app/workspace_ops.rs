use std::path::{Path, PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use falcondeck_core::{
    ConversationItem, ForkThreadRequest, ImageInput, InteractiveRequestOutcome,
    InteractiveRequestResolution, SetThreadGoalRequest, ThreadDetail, ThreadDetailMode,
    ThreadDetailRequest, ThreadGoal, ThreadIsolation, TurnInputItem,
};
use uuid::Uuid;

use super::*;

/// How many prompt-preview titles a workspace connect may replace with
/// generated ones. Each costs a utility-model run, so only the threads the user
/// is most likely to look at are worth backfilling.
const PREVIEW_TITLE_BACKFILL_LIMIT: usize = 5;

const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 3_500_000;
const MAX_TOTAL_IMAGE_ATTACHMENT_BYTES: u64 = 10_000_000;

pub(super) async fn connect_workspace(
    app: &AppState,
    request: ConnectWorkspaceRequest,
) -> Result<WorkspaceSummary, DaemonError> {
    connect_workspace_internal(app, request, None).await
}

pub(super) async fn connect_workspace_internal(
    app: &AppState,
    request: ConnectWorkspaceRequest,
    persisted_workspace: Option<&PersistedWorkspaceState>,
) -> Result<WorkspaceSummary, DaemonError> {
    let requested_path = PathBuf::from(request.path.trim());
    if request.path.trim().is_empty() {
        return Err(DaemonError::BadRequest(
            "workspace path is required".to_string(),
        ));
    }

    let path = requested_path
        .canonicalize()
        .map_err(|error| DaemonError::BadRequest(format!("invalid workspace path: {error}")))?;
    let path_string = path.to_string_lossy().to_string();
    let persisted_workspace = match persisted_workspace.cloned() {
        Some(workspace) => Some(workspace),
        None => app
            .inner
            .saved_workspaces
            .lock()
            .await
            .get(&path_string)
            .cloned(),
    };
    let persisted_workspace_ref = persisted_workspace.as_ref();

    let existing_workspace_id = {
        let mut workspaces = app.inner.workspaces.lock().await;
        if let Some(existing_id) = workspaces
            .values()
            .find(|workspace| workspace.summary.path == path_string)
            .map(|workspace| workspace.summary.id.clone())
        {
            let should_upgrade_placeholder = workspaces
                .get(&existing_id)
                .map(|workspace| !workspace.has_runtime())
                .unwrap_or(false);
            if should_upgrade_placeholder {
                Some(existing_id)
            } else if let Some(existing) = workspaces.get(&existing_id) {
                let existing_summary = existing.summary.clone();
                let preferred_thread_id = persisted_workspace_ref
                    .and_then(|workspace| workspace.current_thread_id.as_deref())
                    .and_then(|thread_id| {
                        existing
                            .threads
                            .contains_key(thread_id)
                            .then(|| thread_id.to_string())
                    })
                    .or(existing_summary.current_thread_id.clone());
                if let Some(workspace) = workspaces.get_mut(&existing_id) {
                    workspace.summary.current_thread_id = preferred_thread_id;
                    if let Some(default_provider) = persisted_workspace_ref
                        .and_then(|workspace| workspace.default_provider.clone())
                    {
                        workspace.summary.default_provider = default_provider;
                    }
                    if let Some(updated_at) =
                        persisted_workspace_ref.and_then(|workspace| workspace.updated_at)
                    {
                        workspace.summary.updated_at = updated_at;
                    }
                    let summary = workspace.summary.clone();
                    let should_refresh_metadata = workspace.has_runtime();
                    drop(workspaces);
                    if should_refresh_metadata {
                        let result = refresh_connected_workspace_metadata(app, &existing_id).await;
                        if result.is_ok() {
                            app.schedule_acp_metadata_hydration(&existing_id);
                        }
                        return result;
                    }
                    app.persist_local_state().await?;
                    return Ok(summary);
                }
                return Ok(existing_summary);
            } else {
                None
            }
        } else {
            None
        }
    };
    // No live entry to inherit from: prefer the persisted id so remote
    // clients' cached snapshots keep addressing this workspace across daemon
    // restarts; mint a fresh uuid only for brand-new (or colliding) ids.
    let workspace_id = match existing_workspace_id {
        Some(id) => id,
        None => {
            let persisted_id = persisted_workspace_ref
                .and_then(|workspace| workspace.id.clone())
                .filter(|id| !id.is_empty());
            let reusable_id = match persisted_id {
                Some(id) => (!app.inner.workspaces.lock().await.contains_key(&id)).then_some(id),
                None => None,
            };
            reusable_id.unwrap_or_else(|| format!("workspace-{}", Uuid::new_v4().simple()))
        }
    };
    // A failure to bootstrap one provider must not brick the workspace for the
    // other: keep the workspace usable and report the broken provider through
    // its agent summary instead.
    let (codex_session, codex_account, codex_models, codex_collaboration_modes, codex_threads) =
        match CodexSession::connect(
            workspace_id.clone(),
            path_string.clone(),
            app.provider_bin(&AgentProvider::CODEX),
            app.clone(),
        )
        .await
        {
            Ok(CodexBootstrap {
                session,
                account,
                models,
                collaboration_modes,
                threads,
            }) => {
                app.clear_operational_condition(&workspace_id, "codex_bootstrap");
                app.clear_operational_condition(&workspace_id, "codex_connection");
                (Some(session), account, models, collaboration_modes, threads)
            }
            Err(error) => {
                // Degrading to a Claude-only workspace is only useful when
                // Claude is actually installed; with no working provider at
                // all, surface the connect failure as before.
                let claude_resolved = app.resolve_provider_binary(&AgentProvider::CLAUDE);
                if !Path::new(&claude_resolved.executable).is_file() {
                    return Err(error);
                }
                let message = error.to_string();
                tracing::warn!("codex bootstrap failed for {path_string}: {message}");
                let _ = app.upsert_operational_condition(
                    workspace_id.clone(),
                    "codex_bootstrap",
                    falcondeck_core::ServiceLevel::Warning,
                    message,
                    Some("codex-bootstrap".to_string()),
                );
                (
                    None,
                    falcondeck_core::AccountSummary {
                        status: falcondeck_core::AccountStatus::Unknown,
                        label: "Codex unavailable".to_string(),
                    },
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                )
            }
        };
    let ClaudeBootstrap {
        runtime: claude_runtime,
        account: claude_account,
        models: claude_models,
        collaboration_modes: claude_collaboration_modes,
        capabilities: claude_capabilities,
        threads: claude_threads,
    } = ClaudeRuntime::connect(
        path_string.clone(),
        app.provider_bin(&AgentProvider::CLAUDE),
    )
    .await?;
    let file_backed_skills = discover_file_backed_skills(&path_string);
    let codex_provider_skills = match codex_session.as_ref() {
        Some(session) => load_codex_provider_skills(app, session)
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let merged_skills = merge_skills(
        file_backed_skills
            .into_iter()
            .chain(codex_provider_skills)
            .collect(),
    );
    let codex_skills = skills_for_provider(&merged_skills, AgentProvider::CODEX);
    let claude_skills = skills_for_provider(&merged_skills, AgentProvider::CLAUDE);

    let now = Utc::now();
    let mut threads = codex_threads;
    threads.extend(claude_threads.into_iter().map(|mut thread| {
        thread.summary.workspace_id = workspace_id.clone();
        crate::codex::HydratedThread {
            summary: thread.summary,
            items: thread.items,
            title_is_provider_preview: thread.title_is_provider_preview,
        }
    }));
    threads.sort_by_key(|thread| std::cmp::Reverse(thread.summary.updated_at));
    let persisted_thread_states = persisted_workspace_ref
        .map(|workspace| {
            workspace
                .thread_states
                .iter()
                .map(|state| (state.thread_id.clone(), state.clone()))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let mut threads = merge_hydrated_threads_with_persisted_state(
        threads,
        &persisted_thread_states,
        &workspace_id,
        persisted_workspace_ref.and_then(|workspace| workspace.updated_at),
        now,
    );
    materialize_hydrated_image_attachments(app, &workspace_id, &mut threads).await;
    let current_thread_id = persisted_workspace_ref
        .and_then(|workspace| workspace.current_thread_id.as_deref())
        .and_then(|thread_id| {
            threads
                .iter()
                .find(|thread| thread.summary.id == thread_id)
                .map(|thread| thread.summary.id.clone())
        })
        .or_else(|| threads.first().map(|thread| thread.summary.id.clone()));
    let mut agents = vec![
        WorkspaceAgentSummary {
            provider: AgentProvider::CODEX,
            label: "Codex".to_string(),
            account: codex_account.clone(),
            models: codex_models.clone(),
            collaboration_modes: codex_collaboration_modes.clone(),
            skills: codex_skills.clone(),
            capabilities: AgentCapabilitySummary::codex(),
        },
        WorkspaceAgentSummary {
            provider: AgentProvider::CLAUDE,
            label: "Claude".to_string(),
            account: claude_account.clone(),
            models: claude_models.clone(),
            collaboration_modes: claude_collaboration_modes.clone(),
            skills: claude_skills.clone(),
            capabilities: claude_capabilities,
        },
    ];
    agents.extend(app.acp_agent_summaries());
    let default_provider = persisted_workspace_ref
        .and_then(|workspace| workspace.default_provider.clone())
        .unwrap_or(AgentProvider::CODEX);
    let summary = WorkspaceSummary {
        id: workspace_id.clone(),
        path: path_string.clone(),
        status: if agents.iter().all(|agent| {
            matches!(
                agent.account.status,
                falcondeck_core::AccountStatus::NeedsAuth
            )
        }) {
            WorkspaceStatus::NeedsAuth
        } else {
            WorkspaceStatus::Ready
        },
        agents,
        skills: merged_skills,
        default_provider: default_provider.clone(),
        models: codex_models,
        collaboration_modes: codex_collaboration_modes.clone(),
        account: codex_account,
        current_thread_id,
        connected_at: now,
        updated_at: persisted_workspace_ref
            .and_then(|workspace| workspace.updated_at)
            .unwrap_or(now),
        last_error: None,
    };

    let hydrated_threads: HashMap<String, ManagedThread> = threads
        .into_iter()
        .map(|mut thread| {
            if persisted_workspace_ref
                .map(|pw| pw.archived_thread_ids.contains(&thread.summary.id))
                .unwrap_or(false)
            {
                thread.summary.is_archived = true;
            }
            if persisted_workspace_ref
                .map(|pw| pw.pinned_thread_ids.contains(&thread.summary.id))
                .unwrap_or(false)
            {
                thread.summary.is_pinned = true;
            }
            if let Some(state) = persisted_thread_states.get(&thread.summary.id) {
                if let Some(provider) = state.provider.clone() {
                    thread.summary.provider = provider;
                }
                if state.native_session_id.is_some() {
                    thread.summary.native_session_id = state.native_session_id.clone();
                }
                if state.handoff_from.is_some() {
                    thread.summary.handoff_from = state.handoff_from.clone();
                }
                thread.summary.attention.last_read_seq = state.last_read_seq;
                thread.summary.attention.last_agent_activity_seq = state.last_agent_activity_seq;
                // Provider hydration reports the workspace folder; only
                // our own state knows the thread runs somewhere else.
                thread.summary.variant = state.variant.clone();
                // Params the provider's records didn't carry (Codex
                // omits the standard tier; Claude reports nothing)
                // come back from the last persisted selections.
                thread.summary.agent.merge_missing_from(&state.agent);
            }
            (thread.summary.id.clone(), {
                let hydrated_title = thread.summary.title.clone();
                let title_is_provider_preview = thread.title_is_provider_preview;
                let mut managed = ManagedThread::with_items(thread.summary, thread.items);
                if title_is_provider_preview {
                    managed.ai_title_generated = false;
                    managed.title_is_provider_preview = true;
                }
                if let Some(state) = persisted_thread_states.get(&managed.summary.id) {
                    restore_persisted_title_state(
                        &mut managed,
                        state,
                        &hydrated_title,
                        title_is_provider_preview,
                    );
                    managed.queued_requests = state.queued_requests.clone();
                    managed.summary.queued_turns = state
                        .queued_requests
                        .iter()
                        .map(|queued| queued.summary.clone())
                        .collect();
                }
                managed
            })
        })
        .collect();

    {
        let mut workspaces = app.inner.workspaces.lock().await;
        // Reconnecting a workspace that is already live must not throw away
        // work in flight. The rebuilt entry would drop the ACP agent handles —
        // orphaning the approvals those processes are still waiting on — and
        // roll running threads back to the hydrated/persisted view, which
        // still records the last turn as interrupted by shutdown.
        let previous = workspaces.remove(&workspace_id);
        let (previous_acp_runtimes, previous_opencode_runtime, previous_threads) = previous
            .map(|workspace| {
                (
                    workspace.acp_runtimes,
                    workspace.opencode_runtime,
                    workspace.threads,
                )
            })
            .unwrap_or_default();
        let mut threads = hydrated_threads;
        carry_over_live_threads(&mut threads, previous_threads);
        workspaces.insert(
            workspace_id.clone(),
            ManagedWorkspace {
                summary: summary.clone(),
                codex_session,
                claude_runtime: Some(claude_runtime),
                opencode_runtime: previous_opencode_runtime,
                acp_runtimes: previous_acp_runtimes,
                threads,
            },
        );
    }
    let mut saved_workspace = persisted_workspace_ref
        .cloned()
        .unwrap_or(PersistedWorkspaceState {
            path: summary.path.clone(),
            id: None,
            current_thread_id: summary.current_thread_id.clone(),
            updated_at: Some(summary.updated_at),
            default_provider: Some(summary.default_provider.clone()),
            last_error: None,
            archived_thread_ids: Vec::new(),
            pinned_thread_ids: Vec::new(),
            thread_states: Vec::new(),
        });
    // The saved record must carry the id the workspace actually connected
    // under, not whatever a pre-migration state file had.
    saved_workspace.id = Some(workspace_id.clone());
    app.inner
        .saved_workspaces
        .lock()
        .await
        .insert(path_string, saved_workspace);

    app.emit(
        Some(workspace_id.clone()),
        None,
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );

    app.persist_local_state().await?;
    app.schedule_acp_metadata_hydration(&workspace_id);
    app.backfill_provider_preview_titles(&workspace_id, PREVIEW_TITLE_BACKFILL_LIMIT)
        .await;
    for thread_id in persisted_thread_states
        .values()
        .filter(|state| !state.queued_requests.is_empty())
        .map(|state| state.thread_id.clone())
    {
        app.dispatch_next_queued_turn(&workspace_id, &thread_id);
    }

    {
        let app = app.clone();
        let workspace_id = workspace_id.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            interval.tick().await; // skip immediate tick
            loop {
                interval.tick().await;
                // Stop if workspace was removed
                let exists = app
                    .inner
                    .workspaces
                    .lock()
                    .await
                    .contains_key(&workspace_id);
                if !exists {
                    break;
                }
                if let Ok(summary) = refresh_connected_workspace_metadata(&app, &workspace_id).await
                {
                    app.emit(
                        Some(workspace_id.clone()),
                        None,
                        UnifiedEvent::WorkspaceUpdated { workspace: summary },
                    );
                }
            }
        });
    }

    Ok(summary)
}

/// Keeps threads that are mid-turn when their workspace reconnects.
///
/// The hydrated view is rebuilt from provider session files and the daemon's
/// persisted state, neither of which knows about a turn that started since.
/// Letting it win would replace a live thread with a stale copy — most
/// visibly, one still marked as stopped by the last shutdown.
fn carry_over_live_threads(
    hydrated: &mut HashMap<String, ManagedThread>,
    previous: HashMap<String, ManagedThread>,
) {
    for (thread_id, thread) in previous {
        if matches!(
            thread.summary.status,
            ThreadStatus::Running | ThreadStatus::WaitingForInput
        ) {
            hydrated.insert(thread_id, thread);
        }
    }
}

fn restore_persisted_title_state(
    managed: &mut ManagedThread,
    state: &PersistedThreadState,
    hydrated_title: &str,
    title_is_provider_preview: bool,
) {
    managed.manual_title = state.manual_title;
    // FalconDeck-owned titles outlive provider previews. Older state could
    // incorrectly mark the preview itself as generated, so only preserve a
    // generated title when it differs from the hydrated preview.
    let persisted_generated_title = state.ai_title_generated
        && (!title_is_provider_preview || state.title.as_deref() != Some(hydrated_title));
    if (state.manual_title || persisted_generated_title)
        && let Some(title) = state.title.clone()
    {
        managed.summary.title = title;
    }
    managed.ai_title_generated = state.manual_title
        || persisted_generated_title
        || (!title_is_provider_preview
            && !is_placeholder_thread_title(&managed.summary.title)
            && !is_provisional_thread_title(&managed.summary.title));
    // A restored FalconDeck title is no longer a preview, so the titler must
    // not treat it as replaceable.
    managed.title_is_provider_preview =
        title_is_provider_preview && !state.manual_title && !persisted_generated_title;
}

/// Reconciles provider-hydrated threads with the daemon's own persisted thread
/// states when a workspace (re)connects.
///
/// A FalconDeck-created Claude thread persists under its own id while the
/// provider hydrates the same session under the session id. Left alone, every
/// restart would both duplicate the conversation in the sidebar and restore
/// the owning thread with no transcript. Fold each hydrated transcript into
/// the thread that owns its session and drop the twin; persisted threads with
/// no hydrated transcript are restored bare, with a mid-turn `Running` status
/// downgraded to a visible error.
pub(super) fn merge_hydrated_threads_with_persisted_state(
    threads: Vec<crate::codex::HydratedThread>,
    persisted_thread_states: &HashMap<String, PersistedThreadState>,
    workspace_id: &str,
    workspace_updated_at: Option<chrono::DateTime<Utc>>,
    now: chrono::DateTime<Utc>,
) -> Vec<crate::codex::HydratedThread> {
    let mut session_owners = HashMap::new();
    for state in persisted_thread_states.values() {
        let Some(session_id) = state.native_session_id.as_deref() else {
            continue;
        };
        if session_id == state.thread_id {
            continue;
        }
        // Contested sessions (legacy duplicated state) go to the most recently
        // updated claimant; the rest restore without a transcript.
        let owner = session_owners
            .entry(session_id.to_string())
            .or_insert(state);
        if state.updated_at > owner.updated_at {
            *owner = state;
        }
    }
    let mut adopted_transcripts = HashMap::new();
    let mut threads_out = Vec::with_capacity(threads.len());
    for mut thread in threads {
        // Provider hydration knows the transcript, but it cannot know that
        // FalconDeck disappeared during the last turn. Keep the daemon's
        // persisted interruption authoritative when both records describe
        // the same thread; otherwise the startup placeholder's warning would
        // vanish as soon as hydration completed.
        if persisted_thread_states
            .get(&thread.summary.id)
            .is_some_and(|state| {
                matches!(state.status, Some(ThreadStatus::Running))
                    || (matches!(state.status, Some(ThreadStatus::Error))
                        && state.last_error.as_deref() == Some(SHUTDOWN_INTERRUPTED_TURN_ERROR))
            })
        {
            thread.summary.status = ThreadStatus::Error;
            thread.summary.last_error = Some(SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string());
        }
        match session_owners.get(thread.summary.id.as_str()) {
            Some(owner) => {
                adopted_transcripts.insert(owner.thread_id.clone(), thread);
            }
            None => threads_out.push(thread),
        }
    }
    for state in persisted_thread_states.values() {
        if threads_out
            .iter()
            .any(|thread| thread.summary.id == state.thread_id)
        {
            continue;
        }
        // This state entry is a session-id twin of a thread restored above;
        // recreating it would bring the duplicate back as an empty thread.
        if session_owners
            .get(state.thread_id.as_str())
            .is_some_and(|owner| owner.thread_id != state.thread_id)
        {
            continue;
        }
        let adopted = adopted_transcripts.remove(&state.thread_id);
        let restored_status = match state.status.clone().unwrap_or(ThreadStatus::Idle) {
            ThreadStatus::Running => ThreadStatus::Error,
            other => other,
        };
        let restored_last_error = state.last_error.clone().or_else(|| {
            matches!(state.status, Some(ThreadStatus::Running))
                .then(|| SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string())
        });
        threads_out.push(crate::codex::HydratedThread {
            summary: ThreadSummary {
                id: state.thread_id.clone(),
                workspace_id: workspace_id.to_string(),
                title: state
                    .title
                    .clone()
                    .or_else(|| {
                        adopted
                            .as_ref()
                            .map(|transcript| transcript.summary.title.clone())
                    })
                    .unwrap_or_else(|| "Restored thread".to_string()),
                provider: state.provider.clone().unwrap_or(AgentProvider::CODEX),
                native_session_id: state.native_session_id.clone(),
                provider_transport: state.provider_transport.clone(),
                handoff_from: state.handoff_from.clone(),
                origin: None,
                status: restored_status,
                updated_at: state
                    .updated_at
                    .max(
                        adopted
                            .as_ref()
                            .map(|transcript| transcript.summary.updated_at),
                    )
                    .or(workspace_updated_at)
                    .unwrap_or(now),
                last_message_preview: adopted
                    .as_ref()
                    .and_then(|transcript| transcript.summary.last_message_preview.clone()),
                latest_turn_id: None,
                latest_plan: None,
                latest_diff: None,
                last_tool: None,
                last_error: restored_last_error,
                agent: state.agent.clone(),
                attention: ThreadAttention::default(),
                is_archived: false,
                is_pinned: false,
                goal: None,
                queued_turns: state
                    .queued_requests
                    .iter()
                    .map(|queued| queued.summary.clone())
                    .collect(),
                variant: state.variant.clone(),
            },
            items: adopted
                .map(|transcript| transcript.items)
                .unwrap_or_default(),
            title_is_provider_preview: false,
        });
    }
    threads_out
}

/// Local testing defaults: keep every built-in harness from stopping for a
/// permission prompt when a client omits an explicit mode.
fn default_permission_mode(provider: &AgentProvider) -> Option<&'static str> {
    if provider == &AgentProvider::CODEX {
        Some("never")
    } else if provider == &AgentProvider::CLAUDE {
        Some("bypassPermissions")
    } else if provider.as_str().eq_ignore_ascii_case("grok") {
        Some("always-approve")
    } else if provider.as_str().eq_ignore_ascii_case("opencode") {
        Some("always-approve")
    } else {
        None
    }
}

fn default_sandbox_mode(provider: &AgentProvider) -> Option<&'static str> {
    (provider == &AgentProvider::CODEX).then_some("danger-full-access")
}

fn default_approval_policy(provider: &AgentProvider) -> &'static str {
    if provider == &AgentProvider::CODEX {
        "never"
    } else {
        "on-request"
    }
}

pub(super) async fn start_thread(
    app: &AppState,
    request: StartThreadRequest,
) -> Result<ThreadHandle, DaemonError> {
    let (provider, default_model_id, workspace_path) = {
        let workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let provider = request
            .provider
            .clone()
            .unwrap_or_else(|| workspace.summary.default_provider.clone());
        if let Some(handoff) = request.handoff_from.as_ref() {
            let source = workspace.threads.get(&handoff.thread_id).ok_or_else(|| {
                DaemonError::NotFound("handoff source thread not found".to_string())
            })?;
            if source.summary.provider != handoff.provider {
                return Err(DaemonError::BadRequest(
                    "handoff source provider does not match the source thread".to_string(),
                ));
            }
            if source.summary.provider == provider {
                return Err(DaemonError::BadRequest(
                    "handoffs must continue in a different provider".to_string(),
                ));
            }
            if thread_is_busy(&source.summary.status) {
                return Err(DaemonError::BadRequest(
                    "wait for the active turn to finish before handing off".to_string(),
                ));
            }
            if source.summary.variant.is_some() {
                return Err(DaemonError::BadRequest(
                    "handoffs from isolated threads are not supported yet".to_string(),
                ));
            }
        }
        let agent = workspace
            .summary
            .agents
            .iter()
            .find(|agent| agent.provider == provider)
            .cloned();
        let workspace_path = workspace.summary.path.clone();
        (
            provider,
            agent.and_then(|agent| {
                agent
                    .models
                    .iter()
                    .find(|model| model.is_default)
                    .or_else(|| agent.models.first())
                    .map(|model| model.id.clone())
            }),
            workspace_path,
        )
    };
    let permission_mode = request
        .permission_mode
        .clone()
        .or_else(|| default_permission_mode(&provider).map(str::to_owned));
    let sandbox_mode = request
        .sandbox_mode
        .clone()
        .or_else(|| default_sandbox_mode(&provider).map(str::to_owned));
    let mut approval_policy = request
        .approval_policy
        .clone()
        .unwrap_or_else(|| default_approval_policy(&provider).to_string());
    if provider == AgentProvider::CODEX
        && request.approval_policy.is_none()
        && let Some(permission_mode) = permission_mode
            .as_deref()
            .filter(|mode| !mode.eq_ignore_ascii_case("default"))
    {
        approval_policy = permission_mode.to_string();
    }
    let mut model_id = request.model_id.clone().or(default_model_id);

    // The checkout has to exist before the backend opens its thread, because
    // the cwd is fixed at that point for every provider.
    let variant = match request.isolation {
        ThreadIsolation::ProjectFolder => None,
        ThreadIsolation::Isolated => {
            Some(crate::variant::create(&workspace_path, &crate::variant::new_slug()).await?)
        }
    };
    let cwd = variant
        .as_ref()
        .map_or(workspace_path.as_str(), |variant| variant.path.as_str());

    let started = ProviderRuntime::for_provider(&provider)
        .start_thread(
            app,
            StartThreadSpec {
                workspace_id: &request.workspace_id,
                model_id: model_id.as_deref(),
                sandbox_mode: sandbox_mode.as_deref(),
                approval_policy: &approval_policy,
                collaboration_mode_id: request.collaboration_mode_id.as_deref(),
                cwd,
            },
        )
        .await;
    let StartedThread {
        thread_id,
        title,
        native_session_id,
        provider_transport,
    } = match started {
        Ok(started) => started,
        Err(error) => {
            // Nothing will ever reference this checkout now, so it would be
            // orphaned on disk with no thread to clean it up.
            if let Some(variant) = variant.as_ref() {
                crate::variant::remove(&workspace_path, variant).await;
            }
            return Err(error);
        }
    };
    if provider_transport.as_deref() == Some("acp") && model_id.as_deref() == Some("default") {
        // `default` is the native catalog's synthetic "use OpenCode config"
        // entry, not an ACP model id. Preserve ACP's own default on rollback.
        model_id = None;
    }
    let now = Utc::now();
    let is_handoff = request.handoff_from.is_some();

    let mut workspaces = app.inner.workspaces.lock().await;
    let workspace = workspaces
        .get_mut(&request.workspace_id)
        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
    let thread = ThreadSummary {
        id: thread_id.clone(),
        workspace_id: request.workspace_id.clone(),
        title,
        provider: provider.clone(),
        native_session_id,
        provider_transport,
        handoff_from: request.handoff_from,
        origin: None,
        status: ThreadStatus::Idle,
        updated_at: now,
        last_message_preview: None,
        latest_turn_id: None,
        latest_plan: None,
        latest_diff: None,
        last_tool: None,
        last_error: None,
        agent: ThreadAgentParams {
            model_id,
            reasoning_effort: None,
            collaboration_mode_id: request.collaboration_mode_id,
            approval_policy: Some(approval_policy),
            service_tier: None,
            permission_mode,
            sandbox_mode,
        },
        attention: ThreadAttention::default(),
        is_archived: false,
        is_pinned: false,
        goal: None,
        queued_turns: Vec::new(),
        variant,
    };
    workspace.summary.current_thread_id = Some(thread_id.clone());
    if !is_handoff {
        workspace.summary.default_provider = provider;
    }
    workspace.summary.updated_at = now;
    workspace
        .threads
        .insert(thread_id.clone(), ManagedThread::new(thread.clone()));
    let workspace_summary = workspace.summary.clone();
    drop(workspaces);

    let thread = app
        .thread_summary(&request.workspace_id, &thread.id)
        .await?;
    app.emit(
        Some(request.workspace_id),
        Some(thread.id.clone()),
        UnifiedEvent::ThreadStarted {
            thread: thread.clone(),
        },
    );

    Ok(ThreadHandle {
        workspace: workspace_summary,
        thread,
    })
}

pub(super) async fn fork_thread(
    app: &AppState,
    request: ForkThreadRequest,
) -> Result<ThreadHandle, DaemonError> {
    let last_turn_id = request.last_turn_id.trim();
    if last_turn_id.is_empty() {
        return Err(DaemonError::BadRequest(
            "a completed fork boundary is required".to_string(),
        ));
    }
    let source = {
        let workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let source = workspace
            .threads
            .get(&request.thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        if source.summary.provider != AgentProvider::CODEX {
            return Err(DaemonError::BadRequest(
                "this provider does not support conversation forks".to_string(),
            ));
        }
        if thread_is_busy(&source.summary.status) {
            return Err(DaemonError::BadRequest(
                "wait for the active turn to finish before branching".to_string(),
            ));
        }
        if source.summary.variant.is_some() {
            return Err(DaemonError::BadRequest(
                "branching isolated threads is not supported yet".to_string(),
            ));
        }
        source.summary.clone()
    };

    let session = app.session_for(&request.workspace_id).await?;
    let result = session
        .send_request(
            "thread/fork",
            json!({
                "threadId": request.thread_id,
                "lastTurnId": last_turn_id,
            }),
        )
        .await?;
    let thread_id = extract_thread_id(&result)
        .ok_or_else(|| DaemonError::Rpc("thread/fork did not return a thread id".to_string()))?;
    let items = crate::codex::hydrate_thread_items(&result);
    let retained_preview = items.iter().rev().find_map(|item| match item {
        ConversationItem::UserMessage { text, .. }
        | ConversationItem::AssistantMessage { text, .. } => Some(truncate_preview(text, 160)),
        _ => None,
    });
    let now = Utc::now();
    let mut thread = source;
    thread.id = thread_id.clone();
    thread.native_session_id = Some(thread_id.clone());
    thread.status = ThreadStatus::Idle;
    thread.updated_at = now;
    thread.latest_turn_id = Some(last_turn_id.to_string());
    thread.last_message_preview = retained_preview;
    thread.latest_plan = None;
    thread.latest_diff = None;
    thread.last_tool = None;
    thread.last_error = None;
    thread.attention = ThreadAttention::default();
    thread.is_archived = false;
    thread.is_pinned = false;
    thread.queued_turns.clear();

    let workspace_summary = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        workspace.summary.current_thread_id = Some(thread_id.clone());
        workspace.summary.updated_at = now;
        workspace.threads.insert(
            thread_id.clone(),
            ManagedThread::with_items(thread.clone(), items),
        );
        workspace.summary.clone()
    };

    app.emit(
        Some(request.workspace_id.clone()),
        Some(thread_id),
        UnifiedEvent::ThreadStarted {
            thread: thread.clone(),
        },
    );
    let _ = app.persist_local_state().await;
    Ok(ThreadHandle {
        workspace: workspace_summary,
        thread,
    })
}

pub(super) async fn archive_thread(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
) -> Result<ThreadSummary, DaemonError> {
    let mut workspaces = app.inner.workspaces.lock().await;
    let workspace = workspaces
        .get_mut(workspace_id)
        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
    let thread = workspace
        .threads
        .get_mut(thread_id)
        .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
    thread.summary.is_archived = true;
    drop(workspaces);
    let summary = app.thread_summary(workspace_id, thread_id).await?;
    app.emit(
        Some(workspace_id.to_string()),
        Some(thread_id.to_string()),
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );
    let _ = app.persist_local_state().await;
    Ok(summary)
}

/// Drops a thread and, if it ran in an isolated copy, the checkout behind it.
///
/// Archiving deliberately does not do this: it is reversible, and an
/// unarchived thread whose checkout had been deleted would have nowhere to
/// run. Deletion is the terminal action, so it is where cleanup belongs.
pub(super) async fn delete_thread(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
) -> Result<(), DaemonError> {
    let (variant, workspace_path) = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .remove(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        if workspace.summary.current_thread_id.as_deref() == Some(thread_id) {
            workspace.summary.current_thread_id =
                workspace.threads.keys().next().map(ToString::to_string);
        }
        (thread.summary.variant, workspace.summary.path.clone())
    };

    if let Some(variant) = variant.as_ref() {
        crate::variant::remove(&workspace_path, variant).await;
    }

    app.emit(
        Some(workspace_id.to_string()),
        None,
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );
    let _ = app.persist_local_state().await;
    Ok(())
}

pub(super) async fn unarchive_thread(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
) -> Result<ThreadSummary, DaemonError> {
    let mut workspaces = app.inner.workspaces.lock().await;
    let workspace = workspaces
        .get_mut(workspace_id)
        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
    let thread = workspace
        .threads
        .get_mut(thread_id)
        .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
    thread.summary.is_archived = false;
    drop(workspaces);
    let summary = app.thread_summary(workspace_id, thread_id).await?;
    app.emit(
        Some(workspace_id.to_string()),
        Some(thread_id.to_string()),
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );
    let _ = app.persist_local_state().await;
    Ok(summary)
}

async fn normalize_turn_inputs(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    inputs: &[TurnInputItem],
) -> Result<Vec<TurnInputItem>, DaemonError> {
    let mut normalized = Vec::with_capacity(inputs.len());
    let mut total_image_bytes = 0;

    for input in inputs {
        match input {
            TurnInputItem::Text { .. } => normalized.push(input.clone()),
            TurnInputItem::Image(image) => normalized.push(TurnInputItem::Image(
                normalize_image_input(app, workspace_id, thread_id, image, &mut total_image_bytes)
                    .await?,
            )),
        }
    }

    Ok(normalized)
}

async fn normalize_image_input(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    image: &ImageInput,
    total_image_bytes: &mut u64,
) -> Result<ImageInput, DaemonError> {
    let image_url = image.url.trim();

    if let Some(local_path) = image
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        // Only trust a local_path that exists on this host; remote clients
        // (e.g. the iOS app) send their own device paths alongside an inline
        // payload, and those must fall through to be materialized here.
        if tokio::fs::try_exists(local_path).await.unwrap_or(false) {
            if let Ok(metadata) = tokio::fs::metadata(local_path).await {
                record_image_attachment_size(image, metadata.len(), total_image_bytes)?;
            }
            let mut normalized = image.clone();
            normalized.url = compact_image_reference_url(image, local_path);
            return Ok(normalized);
        }
    }

    if image_url.starts_with("data:") {
        let parsed = parse_image_data_url_with_budget(&image.url, image, total_image_bytes)?;
        let local_path =
            persist_inline_image_attachment(app, workspace_id, thread_id, image, parsed).await?;
        let mut normalized = image.clone();
        normalized.url = local_path.clone();
        normalized.local_path = Some(local_path);
        return Ok(normalized);
    }

    if Path::new(image_url).is_absolute() {
        if let Ok(metadata) = tokio::fs::metadata(image_url).await {
            record_image_attachment_size(image, metadata.len(), total_image_bytes)?;
        }
        let mut normalized = image.clone();
        normalized.local_path = Some(image_url.to_string());
        normalized.url = image_url.to_string();
        return Ok(normalized);
    }

    Ok(image.clone())
}

fn record_image_attachment_size(
    image: &ImageInput,
    bytes: u64,
    total_image_bytes: &mut u64,
) -> Result<(), DaemonError> {
    let label = image
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Image");
    if bytes > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err(DaemonError::BadRequest(format!(
            "{label} is too large. Images must be 3.5 MB or smaller."
        )));
    }
    let next_total = total_image_bytes.saturating_add(bytes);
    if next_total > MAX_TOTAL_IMAGE_ATTACHMENT_BYTES {
        return Err(DaemonError::BadRequest(
            "Those images are too large together. Attach no more than 10 MB at once.".to_string(),
        ));
    }
    *total_image_bytes = next_total;
    Ok(())
}

async fn persist_inline_image_attachment(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    image: &ImageInput,
    parsed: ParsedImageDataUrl,
) -> Result<String, DaemonError> {
    let extension = image_file_extension(
        image.name.as_deref(),
        image.mime_type.as_deref(),
        &parsed.media_type,
    );
    let attachments_root = thread_attachments_root(app, workspace_id, thread_id);
    tokio::fs::create_dir_all(&attachments_root).await?;

    let file_path = attachments_root.join(format!(
        "{}.{}",
        sanitized_attachment_file_stem(&image.id),
        extension
    ));
    tokio::fs::write(&file_path, parsed.bytes).await?;

    Ok(file_path.to_string_lossy().to_string())
}

fn thread_attachments_root(app: &AppState, workspace_id: &str, thread_id: &str) -> PathBuf {
    app.inner
        .state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("attachments")
        .join(sanitized_attachment_path_segment(workspace_id, "workspace"))
        .join(sanitized_attachment_path_segment(thread_id, "thread"))
}

/// Materializes data-URL attachments recovered from provider session logs into
/// the thread's attachment directory, keeping hydrated transcripts as compact
/// in memory as live sends. Hydration mints deterministic content-hash ids, so
/// repeated restarts converge on the same file instead of accumulating copies.
async fn materialize_hydrated_image_attachments(
    app: &AppState,
    workspace_id: &str,
    threads: &mut [crate::codex::HydratedThread],
) {
    for thread in threads.iter_mut() {
        let thread_id = thread.summary.id.clone();
        for item in thread.items.iter_mut() {
            let ConversationItem::UserMessage { attachments, .. } = item else {
                continue;
            };
            for image in attachments.iter_mut() {
                if image.local_path.is_some() || !image.url.trim_start().starts_with("data:") {
                    continue;
                }
                let Ok(parsed) = parse_image_data_url(&image.url) else {
                    continue;
                };
                let extension = image_file_extension(
                    image.name.as_deref(),
                    image.mime_type.as_deref(),
                    &parsed.media_type,
                );
                let root = thread_attachments_root(app, workspace_id, &thread_id);
                let file_path = root.join(format!(
                    "{}.{}",
                    sanitized_attachment_file_stem(&image.id),
                    extension
                ));
                if !tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
                    if tokio::fs::create_dir_all(&root).await.is_err() {
                        continue;
                    }
                    if tokio::fs::write(&file_path, &parsed.bytes).await.is_err() {
                        // Leave the inline data URL in place; the image still
                        // renders, it just isn't file-backed.
                        continue;
                    }
                }
                let path_string = file_path.to_string_lossy().to_string();
                image.url = path_string.clone();
                image.local_path = Some(path_string);
            }
        }
    }
}

struct ParsedImageDataUrl {
    media_type: String,
    bytes: Vec<u8>,
}

fn image_data_url_parts(url: &str) -> Result<(String, &str), DaemonError> {
    let value = url
        .trim()
        .strip_prefix("data:")
        .ok_or_else(|| DaemonError::BadRequest("invalid image attachment data URL".to_string()))?;
    let (metadata, encoded) = value.split_once(',').ok_or_else(|| {
        DaemonError::BadRequest("invalid image attachment data URL payload".to_string())
    })?;

    let mut parts = metadata.split(';');
    let media_type = parts.next().unwrap_or_default().trim().to_string();
    if media_type.is_empty() || !media_type.starts_with("image/") {
        return Err(DaemonError::BadRequest(
            "image attachments must use an image/* data URL".to_string(),
        ));
    }
    if !parts.any(|part| part.eq_ignore_ascii_case("base64")) {
        return Err(DaemonError::BadRequest(
            "image attachments must use base64 data URLs".to_string(),
        ));
    }

    Ok((media_type, encoded))
}

fn parse_image_data_url(url: &str) -> Result<ParsedImageDataUrl, DaemonError> {
    let (media_type, encoded) = image_data_url_parts(url)?;

    let bytes = BASE64.decode(encoded).map_err(|error| {
        DaemonError::BadRequest(format!("invalid image attachment base64 payload: {error}"))
    })?;

    Ok(ParsedImageDataUrl { media_type, bytes })
}

fn parse_image_data_url_with_budget(
    url: &str,
    image: &ImageInput,
    total_image_bytes: &mut u64,
) -> Result<ParsedImageDataUrl, DaemonError> {
    let (_, encoded) = image_data_url_parts(url)?;
    let padding = if encoded.ends_with("==") {
        2
    } else if encoded.ends_with('=') {
        1
    } else {
        0
    };
    let encoded_len = u64::try_from(encoded.len()).unwrap_or(u64::MAX);
    let decoded_upper_bound = (encoded_len.saturating_add(3) / 4)
        .saturating_mul(3)
        .saturating_sub(padding);
    record_image_attachment_size(image, decoded_upper_bound, total_image_bytes)?;
    parse_image_data_url(url)
}

fn image_file_extension(
    name: Option<&str>,
    mime_type: Option<&str>,
    data_url_media_type: &str,
) -> String {
    if let Some(extension) = mime_type_to_image_extension(data_url_media_type) {
        return extension.to_string();
    }

    if let Some(extension) = mime_type.and_then(mime_type_to_image_extension) {
        return extension.to_string();
    }

    if let Some(extension) = name
        .and_then(|value| Path::new(value).extension())
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| {
            matches!(
                value.as_str(),
                "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
                    | "bmp"
                    | "tif"
                    | "tiff"
                    | "svg"
                    | "heic"
                    | "heif"
            )
        })
    {
        return extension;
    }

    "img".to_string()
}

fn sanitized_attachment_file_stem(id: &str) -> String {
    sanitized_attachment_identifier(id, "image")
}

fn compact_image_reference_url(image: &ImageInput, local_path: &str) -> String {
    let image_url = image.url.trim();
    if image_url.starts_with("data:")
        || image_url.starts_with("blob:")
        || image_url.starts_with("file:")
        || image_url.is_empty()
    {
        local_path.to_string()
    } else {
        image_url.to_string()
    }
}

fn sanitized_attachment_path_segment(value: &str, prefix: &str) -> String {
    sanitized_attachment_identifier(value, prefix)
}

fn sanitized_attachment_identifier(value: &str, prefix: &str) -> String {
    let trimmed = value.trim();
    let sanitized = trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(32)
        .collect::<String>();

    if !trimmed.is_empty() && sanitized == trimmed && trimmed.len() <= 32 {
        return sanitized;
    }

    let base = if sanitized.is_empty() {
        prefix.to_string()
    } else {
        sanitized
    };
    format!("{base}-{:016x}", stable_attachment_identifier_hash(trimmed))
}

fn mime_type_to_image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/tif" => Some("tif"),
        "image/tiff" => Some("tiff"),
        "image/svg+xml" => Some("svg"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        _ => None,
    }
}

fn stable_attachment_identifier_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Upper bound on messages parked behind one thread's active turn.
const MAX_QUEUED_TURNS: usize = 20;

/// Whether the thread is mid-turn, and so cannot take a fresh dispatch.
fn thread_is_busy(status: &ThreadStatus) -> bool {
    matches!(
        status,
        ThreadStatus::Running | ThreadStatus::WaitingForInput
    )
}

/// Injects the message into the thread's running turn when the caller asked to
/// steer and the thread's provider advertises `supports_steering`. Returns
/// `Ok(None)` for every other case, leaving the send to the queue or to a
/// normal dispatch — an unsupported steer is downgraded, never rejected.
async fn try_steer_turn(
    app: &AppState,
    request: &SendTurnRequest,
    normalized_inputs: &[TurnInputItem],
) -> Result<Option<CommandResponse>, DaemonError> {
    if !request.steer {
        return Ok(None);
    }
    let Some((thread, provider, selected_skills)) = ({
        let workspaces = app.inner.workspaces.lock().await;
        workspaces.get(&request.workspace_id).and_then(|workspace| {
            let thread = workspace.threads.get(&request.thread_id)?;
            if !thread_is_busy(&thread.summary.status) {
                return None;
            }
            let provider = thread.summary.provider.clone();
            let supports_steering = workspace
                .summary
                .agents
                .iter()
                .find(|agent| agent.provider == provider)
                .is_some_and(|agent| agent.capabilities.supports_steering);
            if !supports_steering {
                return None;
            }
            let selected_skills = resolve_selected_skills(
                &workspace.summary.skills,
                &request.selected_skills,
                &provider,
            );
            Some((thread.summary.clone(), provider, selected_skills))
        })
    }) else {
        return Ok(None);
    };

    if let Err(error) = ProviderRuntime::for_provider(&provider)
        .steer(
            app,
            TurnSpec {
                workspace_id: &request.workspace_id,
                thread_id: &request.thread_id,
                thread: &thread,
                inputs: normalized_inputs,
                selected_skills: &selected_skills,
                approval_policy: request.approval_policy.as_deref().unwrap_or("on-request"),
                requested_model_id: request.model_id.as_deref(),
                requested_reasoning_effort: request.reasoning_effort.as_deref(),
                service_tier: request.service_tier.as_deref(),
                wait_for_startup: false,
            },
        )
        .await
    {
        return if steer_error_downgrades_to_queue(&error) {
            Ok(None)
        } else {
            Err(error)
        };
    }

    // Appended only once the message is actually in the agent's input: a
    // transcript entry for a write that failed would be a lie.
    app.push_conversation_item(
        &request.workspace_id,
        &request.thread_id,
        // Steering shares the already-running provider turn and therefore has
        // no independent fork boundary. Keep the edit action unavailable.
        build_user_message_item(
            normalized_inputs,
            request.user_item_id.as_deref(),
            None,
            None,
        ),
        false,
    )
    .await?;
    let summary = app
        .upsert_thread(&request.workspace_id, &request.thread_id, |thread| {
            thread.updated_at = Utc::now();
        })
        .await?;
    app.emit(
        Some(request.workspace_id.clone()),
        Some(request.thread_id.clone()),
        UnifiedEvent::ThreadUpdated { thread: summary },
    );
    Ok(Some(CommandResponse {
        ok: true,
        message: Some("steered".to_string()),
    }))
}

/// Whether a failed steer attempt means "the steer is unavailable" rather
/// than "the send is invalid". The turn can end between the busy check and
/// the stdin write, or the pipe can be dying or wedged — those races are
/// downgraded, never rejected, so the message falls through to the queue or a
/// fresh dispatch. Matched by message because the provider seams currently
/// expose app-server and Claude failures through shared error variants;
/// anything else (no runtime attached, unknown workspace) still fails the
/// send outright.
pub(super) fn steer_error_downgrades_to_queue(error: &DaemonError) -> bool {
    match error {
        DaemonError::BadRequest(message) => {
            message.contains("no active Codex turn to steer")
                || message.contains("no active claude turn to steer")
                || message.contains("no active ACP session to steer")
                || message.contains("no longer accepting input")
        }
        DaemonError::Process(message) => {
            message.contains("timed out writing to claude turn")
                || message.contains("failed to write to claude turn")
        }
        DaemonError::Rpc(message) => {
            message.contains("activeTurnNotSteerable")
                || message.contains("expectedTurnId")
                || message.contains("no active turn")
        }
        _ => false,
    }
}

/// Queues the request when the thread is busy. Returns `Ok(None)` when the
/// thread is free (caller dispatches normally). Inputs are the normalized
/// form so attachments are already materialized to files when queued.
async fn try_enqueue_turn(
    app: &AppState,
    request: &SendTurnRequest,
    normalized_inputs: &[TurnInputItem],
) -> Result<Option<CommandResponse>, DaemonError> {
    let queued_summary = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let Some(workspace) = workspaces.get_mut(&request.workspace_id) else {
            return Ok(None);
        };
        let Some(thread) = workspace.threads.get_mut(&request.thread_id) else {
            return Ok(None);
        };
        if !thread_is_busy(&thread.summary.status) {
            return Ok(None);
        }
        if thread.queued_requests.len() >= MAX_QUEUED_TURNS {
            return Err(DaemonError::BadRequest(
                "too many queued messages for this thread".to_string(),
            ));
        }
        let id = format!("queued-{}", Uuid::new_v4().simple());
        let text = normalized_inputs
            .iter()
            .find_map(|input| match input {
                TurnInputItem::Text { text, .. } => Some(text.trim()),
                TurnInputItem::Image(_) => None,
            })
            .unwrap_or("")
            .to_string();
        let preview = text.chars().take(140).collect::<String>();
        let attachment_count = normalized_inputs
            .iter()
            .filter(|input| matches!(input, TurnInputItem::Image(_)))
            .count();
        let mut stored = request.clone();
        stored.inputs = normalized_inputs.to_vec();
        let summary = falcondeck_core::QueuedTurnSummary {
            id: id.clone(),
            preview,
            text,
            attachment_count,
            queued_at: Utc::now(),
        };
        thread.queued_requests.push(super::QueuedTurnRequest {
            id,
            request: stored,
            summary: summary.clone(),
        });
        thread.summary.queued_turns.push(summary);
        thread.summary.updated_at = Utc::now();
        thread.summary.clone()
    };
    // The queue is an outbox: disk commit precedes the success response. A
    // client may safely clear its composer once this function returns.
    app.persist_local_state().await?;
    app.emit(
        Some(request.workspace_id.clone()),
        Some(request.thread_id.clone()),
        UnifiedEvent::ThreadUpdated {
            thread: queued_summary,
        },
    );
    Ok(Some(CommandResponse {
        ok: true,
        message: Some("queued".to_string()),
    }))
}

/// Removes a queued turn before it dispatches.
pub(super) async fn remove_queued_turn(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    queued_id: &str,
) -> Result<CommandResponse, DaemonError> {
    let summary = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let before = thread.queued_requests.len();
        thread
            .queued_requests
            .retain(|queued| queued.id != queued_id);
        if thread.queued_requests.len() == before {
            return Err(DaemonError::NotFound("queued turn not found".to_string()));
        }
        thread
            .summary
            .queued_turns
            .retain(|queued| queued.id != queued_id);
        thread.summary.updated_at = Utc::now();
        thread.summary.clone()
    };
    app.persist_local_state().await?;
    app.emit(
        Some(workspace_id.to_string()),
        Some(thread_id.to_string()),
        UnifiedEvent::ThreadUpdated { thread: summary },
    );
    Ok(CommandResponse {
        ok: true,
        message: Some("removed".to_string()),
    })
}

/// Promotes an already-queued message into the running turn ("steer instead").
///
/// The promotion has to happen daemon-side: the stored request carries the real
/// inputs and the attachments materialized at queue time, while a client only
/// ever sees the preview string — so a client-side remove-then-resend would
/// lose attachments and race the queue drain.
pub(super) async fn steer_queued_turn(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    queued_id: &str,
) -> Result<CommandResponse, DaemonError> {
    // Taken out of the queue before the steer rather than after, so a turn
    // ending mid-steer cannot drain the same entry into a second send. The pop
    // is provisional: every failure path below puts it back where it was.
    let (queued, queue_index, summary_entry) = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        if !thread_is_busy(&thread.summary.status) {
            return Err(DaemonError::BadRequest(
                "this thread has no running turn to steer into".to_string(),
            ));
        }
        let provider = thread.summary.provider.clone();
        let supports_steering = workspace
            .summary
            .agents
            .iter()
            .find(|agent| agent.provider == provider)
            .is_some_and(|agent| agent.capabilities.supports_steering);
        if !supports_steering {
            return Err(DaemonError::BadRequest(format!(
                "{provider} cannot steer a running turn"
            )));
        }
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let queue_index = thread
            .queued_requests
            .iter()
            .position(|queued| queued.id == queued_id)
            .ok_or_else(|| DaemonError::NotFound("queued turn not found".to_string()))?;
        let queued = thread.queued_requests.remove(queue_index);
        let summary_entry = thread
            .summary
            .queued_turns
            .iter()
            .position(|entry| entry.id == queued_id)
            .map(|index| (index, thread.summary.queued_turns.remove(index)));
        (queued, queue_index, summary_entry)
    };

    let mut request = queued.request.clone();
    request.steer = true;
    // Already normalized at queue time — re-normalizing would re-materialize
    // attachments that are on disk.
    let inputs = request.inputs.clone();

    let outcome = try_steer_turn(app, &request, &inputs).await;
    let error = match outcome {
        Ok(Some(response)) => {
            app.persist_local_state().await?;
            return Ok(response);
        }
        // `Ok(None)` is the shared steer path declining between the checks
        // above and the injection — the turn ended, say. Restore, don't drop.
        Ok(None) => DaemonError::BadRequest(
            "the running turn ended before the message could be steered".to_string(),
        ),
        Err(error) => error,
    };

    // Restores on any error, including the narrow window where the text did
    // reach the agent but recording it in the transcript failed: leaving the
    // message queued risks it being sent twice, dropping it loses the user's
    // words outright, and only the first is recoverable by hand.
    let restored = {
        let mut workspaces = app.inner.workspaces.lock().await;
        workspaces
            .get_mut(workspace_id)
            .and_then(|workspace| workspace.threads.get_mut(thread_id))
            .map(|thread| {
                let index = queue_index.min(thread.queued_requests.len());
                thread.queued_requests.insert(index, queued);
                if let Some((index, entry)) = summary_entry {
                    let index = index.min(thread.summary.queued_turns.len());
                    thread.summary.queued_turns.insert(index, entry);
                }
                thread.summary.updated_at = Utc::now();
                thread.summary.clone()
            })
    };
    if let Some(summary) = restored {
        app.persist_local_state().await?;
        app.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ThreadUpdated { thread: summary },
        );
    }
    Err(error)
}

/// Rewrites the text of a message waiting in the queue.
///
/// Editing happens daemon-side for the same reason steering does: the stored
/// request carries the real inputs with attachments materialized at queue
/// time, while clients only hold the preview string — a client-side
/// remove-and-resend would drop attachments and race the queue drain.
pub(super) async fn edit_queued_turn(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    queued_id: &str,
    text: &str,
) -> Result<CommandResponse, DaemonError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(DaemonError::BadRequest(
            "queued message text cannot be empty".to_string(),
        ));
    }
    let summary = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let queued = thread
            .queued_requests
            .iter_mut()
            .find(|queued| queued.id == queued_id)
            .ok_or_else(|| DaemonError::NotFound("queued turn not found".to_string()))?;
        let existing_text = queued
            .request
            .inputs
            .iter_mut()
            .find_map(|input| match input {
                TurnInputItem::Text { text, .. } => Some(text),
                TurnInputItem::Image(_) => None,
            });
        match existing_text {
            Some(existing) => *existing = text.to_string(),
            // An attachment-only queued message gains a text item; the front
            // matches where composers put text relative to attachments.
            None => queued.request.inputs.insert(
                0,
                TurnInputItem::Text {
                    id: None,
                    text: text.to_string(),
                },
            ),
        }
        queued.summary.preview = text.chars().take(140).collect::<String>();
        queued.summary.text = text.to_string();
        if let Some(entry) = thread
            .summary
            .queued_turns
            .iter_mut()
            .find(|entry| entry.id == queued_id)
        {
            entry.preview = text.chars().take(140).collect::<String>();
            entry.text = text.to_string();
        }
        thread.summary.updated_at = Utc::now();
        thread.summary.clone()
    };
    app.persist_local_state().await?;
    app.emit(
        Some(workspace_id.to_string()),
        Some(thread_id.to_string()),
        UnifiedEvent::ThreadUpdated { thread: summary },
    );
    Ok(CommandResponse {
        ok: true,
        message: Some("edited".to_string()),
    })
}

/// Reorders the daemon-owned queue without reconstructing any requests, so
/// image attachments and per-turn settings stay attached to their message.
pub(super) async fn reorder_queued_turns(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    queued_ids: &[String],
) -> Result<CommandResponse, DaemonError> {
    let summary = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        if queued_ids.len() != thread.queued_requests.len()
            || queued_ids.iter().enumerate().any(|(index, id)| {
                queued_ids[..index].contains(id)
                    || !thread.queued_requests.iter().any(|queued| queued.id == *id)
            })
        {
            return Err(DaemonError::BadRequest(
                "queued message order must contain every queued id exactly once".to_string(),
            ));
        }

        let mut requests = std::mem::take(&mut thread.queued_requests);
        thread.queued_requests = queued_ids
            .iter()
            .filter_map(|id| {
                requests
                    .iter()
                    .position(|queued| queued.id == *id)
                    .map(|index| requests.remove(index))
            })
            .collect();
        let mut summaries = std::mem::take(&mut thread.summary.queued_turns);
        thread.summary.queued_turns = queued_ids
            .iter()
            .filter_map(|id| {
                summaries
                    .iter()
                    .position(|queued| queued.id == *id)
                    .map(|index| summaries.remove(index))
            })
            .collect();
        thread.summary.updated_at = Utc::now();
        thread.summary.clone()
    };
    app.persist_local_state().await?;
    app.emit(
        Some(workspace_id.to_string()),
        Some(thread_id.to_string()),
        UnifiedEvent::ThreadUpdated { thread: summary },
    );
    Ok(CommandResponse {
        ok: true,
        message: Some("reordered".to_string()),
    })
}

impl AppState {
    /// Removes a queued turn before it dispatches (loopback API + remote RPC).
    pub(crate) async fn remove_queued_turn(
        &self,
        workspace_id: &str,
        thread_id: &str,
        queued_id: &str,
    ) -> Result<CommandResponse, DaemonError> {
        remove_queued_turn(self, workspace_id, thread_id, queued_id).await
    }

    /// Promotes a queued turn into the running turn (loopback API + remote RPC).
    pub(crate) async fn steer_queued_turn(
        &self,
        workspace_id: &str,
        thread_id: &str,
        queued_id: &str,
    ) -> Result<CommandResponse, DaemonError> {
        steer_queued_turn(self, workspace_id, thread_id, queued_id).await
    }

    /// Rewrites a queued turn's text before it dispatches (loopback API +
    /// remote RPC).
    pub(crate) async fn edit_queued_turn(
        &self,
        workspace_id: &str,
        thread_id: &str,
        queued_id: &str,
        text: &str,
    ) -> Result<CommandResponse, DaemonError> {
        edit_queued_turn(self, workspace_id, thread_id, queued_id, text).await
    }

    pub(crate) async fn reorder_queued_turns(
        &self,
        workspace_id: &str,
        thread_id: &str,
        queued_ids: &[String],
    ) -> Result<CommandResponse, DaemonError> {
        reorder_queued_turns(self, workspace_id, thread_id, queued_ids).await
    }

    pub(crate) async fn queued_turn_attachment(
        &self,
        workspace_id: &str,
        thread_id: &str,
        queued_id: &str,
    ) -> Result<ImageInput, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        thread
            .queued_requests
            .iter()
            .find(|queued| queued.id == queued_id)
            .and_then(|queued| {
                queued.request.inputs.iter().find_map(|input| match input {
                    TurnInputItem::Image(image) => Some(image.clone()),
                    TurnInputItem::Text { .. } => None,
                })
            })
            .ok_or_else(|| DaemonError::NotFound("queued image not found".to_string()))
    }

    /// Image bytes for a queued turn's first attachment, ready to render.
    ///
    /// Queue inputs originate at the client, so neither the declared MIME nor
    /// an arbitrary local path is proof that the file is an image. Confirm a
    /// raster signature before exposing daemon-readable bytes to a caller.
    pub(crate) async fn queued_turn_attachment_preview(
        &self,
        workspace_id: &str,
        thread_id: &str,
        queued_id: &str,
    ) -> Result<(&'static str, Vec<u8>), DaemonError> {
        let attachment = self
            .queued_turn_attachment(workspace_id, thread_id, queued_id)
            .await?;
        let unavailable = || DaemonError::NotFound("queued image preview unavailable".to_string());
        let path = attachment
            .local_path
            .as_deref()
            .or_else(|| {
                std::path::Path::new(&attachment.url)
                    .is_absolute()
                    .then_some(attachment.url.as_str())
            })
            .ok_or_else(unavailable)?;
        let bytes = tokio::fs::read(path).await.map_err(|_| unavailable())?;
        let mime = queued_attachment_preview_mime_type(&bytes).ok_or_else(unavailable)?;
        Ok((mime, bytes))
    }

    /// The same preview as a `data:` URL, for clients that reach the daemon
    /// over the relay instead of its loopback HTTP API (mobile, remote web).
    pub(crate) async fn queued_turn_attachment_preview_data_url(
        &self,
        workspace_id: &str,
        thread_id: &str,
        queued_id: &str,
    ) -> Result<String, DaemonError> {
        let (mime, bytes) = self
            .queued_turn_attachment_preview(workspace_id, thread_id, queued_id)
            .await?;
        Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
    }

    /// Dispatches the next queued turn if the thread is no longer busy.
    /// Called at every turn-end transition; safe to call spuriously — it
    /// no-ops while a turn is active or when nothing is queued. Runs as its
    /// own task so turn-end handlers never block on the next dispatch.
    pub(crate) fn dispatch_next_queued_turn(&self, workspace_id: &str, thread_id: &str) {
        let app = self.clone();
        let workspace_id = workspace_id.to_string();
        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            let next = {
                let mut workspaces = app.inner.workspaces.lock().await;
                let Some(workspace) = workspaces.get_mut(&workspace_id) else {
                    return;
                };
                let Some(thread) = workspace.threads.get_mut(&thread_id) else {
                    return;
                };
                if matches!(
                    thread.summary.status,
                    ThreadStatus::Running | ThreadStatus::WaitingForInput
                ) || thread.queued_requests.is_empty()
                    || thread.dispatching_request.is_some()
                {
                    return;
                }
                let next = thread.queued_requests.remove(0);
                thread
                    .summary
                    .queued_turns
                    .retain(|queued| queued.id != next.id);
                thread.summary.updated_at = Utc::now();
                thread.dispatching_request = Some(next.clone());
                (next, thread.summary.clone())
            };
            let (next, summary) = next;
            app.emit(
                Some(workspace_id.clone()),
                Some(thread_id.clone()),
                UnifiedEvent::ThreadUpdated { thread: summary },
            );
            match send_turn_waiting_for_provider_start(&app, next.request.clone()).await {
                Ok(_) => {
                    let mut workspaces = app.inner.workspaces.lock().await;
                    if let Some(thread) = workspaces
                        .get_mut(&workspace_id)
                        .and_then(|workspace| workspace.threads.get_mut(&thread_id))
                    {
                        thread.dispatching_request = None;
                    }
                    drop(workspaces);
                    if let Err(error) = app.persist_local_state().await {
                        tracing::warn!(%error, thread = %thread_id, "failed to commit queued turn dispatch");
                    }
                }
                Err(error) => {
                    // Provider failures are not permission to discard authored
                    // text. Put it back at the head of the durable queue so the
                    // user can retry, edit, or remove it explicitly.
                    let restored_summary = {
                        let mut workspaces = app.inner.workspaces.lock().await;
                        workspaces
                            .get_mut(&workspace_id)
                            .and_then(|workspace| workspace.threads.get_mut(&thread_id))
                            .map(|thread| {
                                thread.dispatching_request = None;
                                thread.queued_requests.insert(0, next.clone());
                                thread.summary.queued_turns.insert(0, next.summary.clone());
                                thread.summary.updated_at = Utc::now();
                                thread.summary.clone()
                            })
                    };
                    if let Err(persist_error) = app.persist_local_state().await {
                        tracing::warn!(%persist_error, thread = %thread_id, "failed to persist restored queued turn");
                    }
                    if let Some(summary) = restored_summary {
                        app.emit(
                            Some(workspace_id.clone()),
                            Some(thread_id.clone()),
                            UnifiedEvent::ThreadUpdated { thread: summary },
                        );
                    }
                    tracing::warn!(%error, thread = %thread_id, "queued turn failed to dispatch and was restored");
                }
            }
        });
    }
}

pub(super) async fn send_turn(
    app: &AppState,
    request: SendTurnRequest,
) -> Result<CommandResponse, DaemonError> {
    send_turn_with_startup_mode(app, request, false).await
}

async fn send_turn_waiting_for_provider_start(
    app: &AppState,
    request: SendTurnRequest,
) -> Result<CommandResponse, DaemonError> {
    send_turn_with_startup_mode(app, request, true).await
}

async fn send_turn_with_startup_mode(
    app: &AppState,
    request: SendTurnRequest,
    wait_for_startup: bool,
) -> Result<CommandResponse, DaemonError> {
    if app.is_shutting_down() {
        return Err(DaemonError::BadRequest(
            "daemon is shutting down".to_string(),
        ));
    }
    let inputs = if request.inputs.is_empty() {
        return Err(DaemonError::BadRequest(
            "at least one input item is required".to_string(),
        ));
    } else {
        request.inputs.clone()
    };
    {
        let workspaces = app.inner.workspaces.lock().await;
        if !workspaces.contains_key(&request.workspace_id) {
            return Err(DaemonError::NotFound("workspace not found".to_string()));
        }
    }
    let inputs =
        normalize_turn_inputs(app, &request.workspace_id, &request.thread_id, &inputs).await?;

    // A caller that asked to steer gets the message injected into the running
    // turn where the harness supports it; everything else falls through to the
    // queue below.
    if let Some(steered) = try_steer_turn(app, &request, &inputs).await? {
        return Ok(steered);
    }

    // A busy thread queues the send instead of dispatching it. Steering is a
    // per-harness capability, but "hold this until the agent finishes, then
    // send" works for every backend — and replaces the old mid-turn behavior
    // (Claude: silently killing the in-flight turn; ACP: an undefined
    // concurrent prompt).
    if let Some(queued) = try_enqueue_turn(app, &request, &inputs).await? {
        return Ok(queued);
    }

    let (thread, provider, selected_skills, previous_turn_id, approval_policy) = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let now = Utc::now();
        let provider = request
            .provider
            .clone()
            .or_else(|| {
                workspace
                    .threads
                    .get(&request.thread_id)
                    .map(|thread| thread.summary.provider.clone())
            })
            .unwrap_or_else(|| workspace.summary.default_provider.clone());
        let managed = workspace
            .threads
            .entry(request.thread_id.clone())
            .or_insert_with(|| {
                ManagedThread::new(ThreadSummary {
                    id: request.thread_id.clone(),
                    workspace_id: request.workspace_id.clone(),
                    title: "Untitled thread".to_string(),
                    provider: provider.clone(),
                    native_session_id: None,
                    provider_transport: None,
                    handoff_from: None,
                    origin: None,
                    status: ThreadStatus::Idle,
                    updated_at: now,
                    last_message_preview: None,
                    latest_turn_id: None,
                    latest_plan: None,
                    latest_diff: None,
                    last_tool: None,
                    last_error: None,
                    agent: ThreadAgentParams::default(),
                    attention: ThreadAttention::default(),
                    is_archived: false,
                    is_pinned: false,
                    goal: None,
                    queued_turns: Vec::new(),
                    variant: None,
                })
            });
        let permission_mode = request
            .permission_mode
            .clone()
            .or_else(|| managed.summary.agent.permission_mode.clone())
            .or_else(|| default_permission_mode(&provider).map(str::to_owned));
        let sandbox_mode = request
            .sandbox_mode
            .clone()
            .or_else(|| managed.summary.agent.sandbox_mode.clone())
            .or_else(|| default_sandbox_mode(&provider).map(str::to_owned));
        let mut approval_policy = request
            .approval_policy
            .clone()
            .or_else(|| managed.summary.agent.approval_policy.clone())
            .unwrap_or_else(|| default_approval_policy(&provider).to_string());
        if provider == AgentProvider::CODEX
            && let Some(requested_mode) = request
                .permission_mode
                .as_deref()
                .filter(|mode| !mode.eq_ignore_ascii_case("default"))
        {
            approval_policy = requested_mode.to_string();
        } else if provider == AgentProvider::CODEX
            && request.approval_policy.is_none()
            && let Some(permission_mode) = permission_mode
                .as_deref()
                .filter(|mode| !mode.eq_ignore_ascii_case("default"))
        {
            approval_policy = permission_mode.to_string();
        }
        managed.summary.provider = provider.clone();
        managed.summary.status = ThreadStatus::Running;
        managed.summary.agent.model_id = request.model_id.clone().or(managed
            .summary
            .agent
            .model_id
            .clone());
        managed.summary.agent.reasoning_effort = request.reasoning_effort.clone().or(managed
            .summary
            .agent
            .reasoning_effort
            .clone());
        managed.summary.agent.approval_policy = Some(approval_policy.clone());
        managed.summary.agent.service_tier = request.service_tier.clone().or(managed
            .summary
            .agent
            .service_tier
            .clone());
        managed.summary.agent.permission_mode = permission_mode;
        managed.summary.agent.sandbox_mode = sandbox_mode;
        let selected_skills = resolve_selected_skills(
            &workspace.summary.skills,
            &request.selected_skills,
            &provider,
        );
        if !managed.manual_title
            && !managed.ai_title_generated
            && is_placeholder_thread_title(&managed.summary.title)
            && let Some(title) = provisional_thread_title_from_inputs(&inputs)
        {
            managed.summary.title = title;
        }
        managed.summary.updated_at = now;
        workspace.summary.current_thread_id = Some(managed.summary.id.clone());
        workspace.summary.default_provider = provider.clone();
        workspace.summary.updated_at = now;
        let previous_turn_id = managed.summary.latest_turn_id.clone();
        (
            managed.summary.clone(),
            provider,
            selected_skills,
            previous_turn_id,
            approval_policy,
        )
    };
    let user_message = build_user_message_item(
        &inputs,
        request.user_item_id.as_deref(),
        None,
        previous_turn_id,
    );
    app.push_conversation_item(
        &request.workspace_id,
        &request.thread_id,
        user_message.clone(),
        true,
    )
    .await?;
    app.emit(
        Some(request.workspace_id.clone()),
        Some(request.thread_id.clone()),
        UnifiedEvent::ThreadUpdated {
            thread: thread.clone(),
        },
    );

    let start_result = ProviderRuntime::for_provider(&provider)
        .send_turn(
            app,
            TurnSpec {
                workspace_id: &request.workspace_id,
                thread_id: &request.thread_id,
                thread: &thread,
                inputs: &inputs,
                selected_skills: &selected_skills,
                approval_policy: &approval_policy,
                requested_model_id: request.model_id.as_deref(),
                requested_reasoning_effort: request.reasoning_effort.as_deref(),
                service_tier: request.service_tier.as_deref(),
                wait_for_startup,
            },
        )
        .await;

    if let Err(error) = start_result {
        let error_message = error.to_string();
        let failed_at = Utc::now();
        let _ = app
            .with_thread_mut(&request.workspace_id, &request.thread_id, |thread| {
                thread.status = ThreadStatus::Error;
                thread.last_error = Some(error_message.clone());
                thread.updated_at = failed_at;
            })
            .await;
        app.settle_turn_items_with_error(
            &request.workspace_id,
            &request.thread_id,
            failed_at,
            ToolSettlement::Failed,
            Some(&error_message),
        )
        .await;
        // Keep queued messages parked after a provider start failure. Advancing
        // would discard the failed head entry in the dispatch path; the queue
        // owner restores it so the user can retry or edit it explicitly.
        if let Ok(thread) = app
            .thread_summary(&request.workspace_id, &request.thread_id)
            .await
        {
            app.emit(
                Some(request.workspace_id.clone()),
                Some(request.thread_id.clone()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        return Err(error);
    }

    Ok(CommandResponse {
        ok: true,
        message: Some("turn started".to_string()),
    })
}

pub(super) async fn update_thread(
    app: &AppState,
    request: UpdateThreadRequest,
) -> Result<ThreadHandle, DaemonError> {
    if let Some(permission_mode) = request.permission_mode.as_ref() {
        super::acp_threads::set_acp_thread_permission_mode(
            app,
            &request.workspace_id,
            &request.thread_id,
            permission_mode,
        )
        .await?;
    }

    let workspace_summary = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(&request.thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let now = Utc::now();

        if let Some(provider) = request.provider.clone()
            && provider != thread.summary.provider
        {
            return Err(DaemonError::BadRequest(
                "threads are permanently bound to their original provider".to_string(),
            ));
        }

        if let Some(title) = request.title.as_deref().map(str::trim) {
            if title.is_empty() {
                return Err(DaemonError::BadRequest(
                    "thread title cannot be empty".to_string(),
                ));
            }
            thread.summary.title = title.to_string();
            thread.manual_title = true;
            thread.ai_title_generated = true;
            thread.ai_title_in_flight = false;
            thread.title_is_provider_preview = false;
        }

        if let Some(model_id) = request.model_id.clone() {
            thread.summary.agent.model_id = model_id;
        }
        if let Some(reasoning_effort) = request.reasoning_effort.clone() {
            thread.summary.agent.reasoning_effort = reasoning_effort;
        }
        if let Some(collaboration_mode_id) = request.collaboration_mode_id.clone() {
            thread.summary.agent.collaboration_mode_id = collaboration_mode_id;
        }
        if let Some(service_tier) = request.service_tier.clone() {
            thread.summary.agent.service_tier = service_tier;
        }
        if let Some(pinned) = request.pinned {
            thread.summary.is_pinned = pinned;
        }
        if request.acknowledge_interruption == Some(true)
            && matches!(thread.summary.status, ThreadStatus::Error)
            && thread.summary.last_error.as_deref() == Some(SHUTDOWN_INTERRUPTED_TURN_ERROR)
        {
            thread.summary.status = ThreadStatus::Idle;
            thread.summary.last_error = None;
        }
        if let Some(permission_mode) = request.permission_mode.clone() {
            thread.summary.agent.permission_mode =
                permission_mode.filter(|mode| !mode.eq_ignore_ascii_case("default"));
        }
        if let Some(approval_policy) = request.approval_policy.clone() {
            thread.summary.agent.approval_policy = approval_policy;
        }
        if let Some(sandbox_mode) = request.sandbox_mode.clone() {
            thread.summary.agent.sandbox_mode = sandbox_mode;
        }
        // Pin toggles must not bump recency: updated_at drives the sidebar
        // sort, and unpinning a stale thread should return it to its place.
        let is_non_recency_update = request.title.is_none()
            && request.model_id.is_none()
            && request.reasoning_effort.is_none()
            && request.collaboration_mode_id.is_none()
            && request.service_tier.is_none()
            && request.permission_mode.is_none()
            && request.approval_policy.is_none()
            && request.sandbox_mode.is_none()
            && (request.pinned.is_some() || request.acknowledge_interruption.is_some());
        if !is_non_recency_update {
            thread.summary.updated_at = now;
            workspace.summary.current_thread_id = Some(request.thread_id.clone());
        }
        workspace.summary.updated_at = now;

        workspace.summary.clone()
    };
    let thread = app
        .thread_summary(&request.workspace_id, &request.thread_id)
        .await?;

    app.emit(
        Some(request.workspace_id.clone()),
        Some(request.thread_id.clone()),
        UnifiedEvent::ThreadUpdated {
            thread: thread.clone(),
        },
    );
    let _ = app.persist_local_state().await;

    Ok(ThreadHandle {
        workspace: workspace_summary,
        thread,
    })
}

/// Builds the JSON-RPC result for a Codex approval request. The shapes must
/// match the app-server protocol exactly — Codex treats an unparseable
/// response as a decline, which surfaces as "approved in FalconDeck but
/// denied in Codex".
pub(super) fn codex_approval_response(
    method: &str,
    params: &Value,
    decision: &ApprovalDecision,
) -> Value {
    if method.contains("permissions/") {
        // permissions/requestApproval wants the granted profile back, not a
        // decision enum. Granting echoes the requested profile; denying
        // grants nothing. "Always allow" widens the scope from the current
        // turn to the whole session.
        return match decision {
            ApprovalDecision::Allow | ApprovalDecision::AlwaysAllow => json!({
                "permissions": params
                    .get("permissions")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                "scope": if matches!(decision, ApprovalDecision::AlwaysAllow) {
                    "session"
                } else {
                    "turn"
                },
            }),
            ApprovalDecision::Deny => json!({ "permissions": {} }),
        };
    }
    // commandExecution / fileChange requestApproval decision enums.
    let available = params
        .get("availableDecisions")
        .or_else(|| params.get("available_decisions"))
        .and_then(Value::as_array);
    let decision = match decision {
        ApprovalDecision::Allow => "accept",
        ApprovalDecision::Deny
            if available.is_some_and(|decisions| {
                !decisions.iter().any(|value| value == "decline")
                    && decisions.iter().any(|value| value == "cancel")
            }) =>
        {
            "cancel"
        }
        ApprovalDecision::Deny => "decline",
        ApprovalDecision::AlwaysAllow => "acceptForSession",
    };
    json!({ "decision": decision })
}

/// Maps the simple sandbox mode strings stored on threads to the tagged
/// `SandboxPolicy` object the Codex `turn/start` request expects. `None`
/// leaves the provider on its config default.
pub(super) fn sandbox_policy_payload(mode: Option<&str>) -> Value {
    match mode.map(str::trim) {
        Some("read-only") => json!({ "type": "readOnly" }),
        Some("workspace-write") => json!({ "type": "workspaceWrite" }),
        Some("danger-full-access") => json!({ "type": "dangerFullAccess" }),
        _ => Value::Null,
    }
}

pub(super) async fn set_thread_goal(
    app: &AppState,
    request: SetThreadGoalRequest,
) -> Result<ThreadSummary, DaemonError> {
    let objective = request
        .objective
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let provider = app
        .thread_provider(&request.workspace_id, &request.thread_id)
        .await?;

    ProviderRuntime::for_provider(&provider)
        .set_goal(app, &request, objective.as_deref())
        .await?;

    // Reflect the goal locally right away; Codex refines it via
    // thread/goal/updated notifications as usage accrues.
    app.with_thread_mut(&request.workspace_id, &request.thread_id, |thread| {
        match (&objective, &mut thread.goal) {
            (Some(objective), _) => {
                thread.goal = Some(ThreadGoal {
                    objective: objective.clone(),
                    status: request
                        .status
                        .clone()
                        .unwrap_or_else(|| "active".to_string()),
                    token_budget: request.token_budget,
                    tokens_used: None,
                    time_used_seconds: None,
                });
            }
            (None, Some(goal)) => {
                // Status-only update (pause/resume) keeps the objective.
                if let Some(status) = request.status.clone() {
                    goal.status = status;
                }
                if request.token_budget.is_some() {
                    goal.token_budget = request.token_budget;
                }
            }
            (None, None) => {}
        }
    })
    .await?;
    let thread = app
        .thread_summary(&request.workspace_id, &request.thread_id)
        .await?;
    app.emit(
        Some(request.workspace_id.clone()),
        Some(request.thread_id.clone()),
        UnifiedEvent::ThreadUpdated {
            thread: thread.clone(),
        },
    );
    let _ = app.persist_local_state().await;
    Ok(thread)
}

pub(super) async fn clear_thread_goal(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
) -> Result<ThreadSummary, DaemonError> {
    let provider = app.thread_provider(workspace_id, thread_id).await?;
    ProviderRuntime::for_provider(&provider)
        .clear_goal(app, workspace_id, thread_id)
        .await?;

    app.with_thread_mut(workspace_id, thread_id, |thread| {
        thread.goal = None;
    })
    .await?;
    let thread = app.thread_summary(workspace_id, thread_id).await?;
    app.emit(
        Some(workspace_id.to_string()),
        Some(thread_id.to_string()),
        UnifiedEvent::ThreadUpdated {
            thread: thread.clone(),
        },
    );
    let _ = app.persist_local_state().await;
    Ok(thread)
}

pub(super) async fn start_review(
    app: &AppState,
    request: StartReviewRequest,
) -> Result<CommandResponse, DaemonError> {
    let provider = app
        .thread_provider(&request.workspace_id, &request.thread_id)
        .await?;
    if !app
        .provider_capabilities(&request.workspace_id, &provider)
        .await
        .supports_review
    {
        return Err(DaemonError::BadRequest(format!(
            "the {} provider does not support code review",
            provider.as_str()
        )));
    }
    ProviderRuntime::for_provider(&provider)
        .start_review(app, &request)
        .await?;

    Ok(CommandResponse {
        ok: true,
        message: Some("review started".to_string()),
    })
}

pub(super) async fn interrupt_turn(
    app: &AppState,
    workspace_id: String,
    thread_id: String,
) -> Result<CommandResponse, DaemonError> {
    let provider = app.thread_provider(&workspace_id, &thread_id).await?;
    ProviderRuntime::for_provider(&provider)
        .interrupt(app, &workspace_id, &thread_id)
        .await?;

    Ok(CommandResponse {
        ok: true,
        message: Some("interrupt requested".to_string()),
    })
}

/// Disconnects a project: shuts down its agent processes, drops it from the
/// live set and from persisted state. Thread history stored by the providers
/// themselves (Codex/Claude session files) is untouched, so re-adding the
/// folder restores those threads.
pub(super) async fn remove_workspace(
    app: &AppState,
    workspace_id: &str,
) -> Result<CommandResponse, DaemonError> {
    let removed = {
        let mut workspaces = app.inner.workspaces.lock().await;
        workspaces.remove(workspace_id)
    };
    let Some(removed) = removed else {
        return Err(DaemonError::NotFound("workspace not found".to_string()));
    };

    if let Some(session) = removed.codex_session {
        let _ = session.shutdown().await;
    }
    if let Some(runtime) = removed.claude_runtime {
        let _ = runtime.shutdown().await;
    }
    if let Some(runtime) = removed.opencode_runtime {
        runtime.shutdown().await;
    }
    for (_, runtime) in removed.acp_runtimes {
        runtime.shutdown().await;
    }

    // Isolated checkouts are only reachable through their thread; dropping the
    // project without them would strand every one of them on disk.
    for thread in removed.threads.values() {
        if let Some(variant) = thread.summary.variant.as_ref() {
            crate::variant::remove(&removed.summary.path, variant).await;
        }
    }

    let normalized_path = normalize_workspace_path(&removed.summary.path);
    app.inner
        .saved_workspaces
        .lock()
        .await
        .remove(&normalized_path);
    app.inner
        .interactive_requests
        .lock()
        .await
        .retain(|(request_workspace, _), _| request_workspace != workspace_id);
    app.inner
        .operational_conditions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|(condition_workspace, _), _| condition_workspace != workspace_id);
    app.inner
        .service_notices
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|notice| notice.workspace_id != workspace_id);
    let _ = app.persist_local_state().await;
    app.emit(
        None,
        None,
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );
    Ok(CommandResponse {
        ok: true,
        message: Some("workspace removed".to_string()),
    })
}

/// Whether any still-pending interactive request targets this thread. Checked
/// after a response removes its own entry: restoring `Running` while a second
/// concurrent request is still waiting on the user would misreport the thread
/// and hide the remaining prompt.
async fn thread_has_pending_interactive_request(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
) -> bool {
    app.inner
        .interactive_requests
        .lock()
        .await
        .iter()
        .any(|((request_workspace, _), pending)| {
            request_workspace == workspace_id
                && pending.request.thread_id.as_deref() == Some(thread_id)
        })
}

/// Retires an approval whose agent is gone. The card leaves the transcript as
/// cancelled and the thread stops waiting on an answer nobody can deliver.
async fn discard_unanswerable_interactive_request(
    app: &AppState,
    workspace_id: &str,
    request_id: &str,
    thread_id: Option<&str>,
) {
    app.inner
        .interactive_requests
        .lock()
        .await
        .remove(&(workspace_id.to_string(), request_id.to_string()));
    if let Some(thread_id) = thread_id {
        let still_waiting =
            thread_has_pending_interactive_request(app, workspace_id, thread_id).await;
        let _ = app
            .with_thread_mut(workspace_id, thread_id, |thread| {
                if !still_waiting && matches!(thread.status, ThreadStatus::WaitingForInput) {
                    thread.status = ThreadStatus::Error;
                    thread.last_error =
                        Some("The agent exited before this approval was answered".to_string());
                    thread.updated_at = Utc::now();
                }
            })
            .await;
        let _ = app
            .resolve_interactive_request_item(
                workspace_id,
                thread_id,
                request_id,
                Some(InteractiveRequestResolution {
                    outcome: InteractiveRequestOutcome::Cancelled,
                    resolved_at: Utc::now(),
                }),
            )
            .await;
    }
    app.emit(
        Some(workspace_id.to_string()),
        None,
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );
}

pub(super) async fn respond_to_interactive_request(
    app: &AppState,
    workspace_id: String,
    request_id: String,
    response: InteractiveResponsePayload,
) -> Result<CommandResponse, DaemonError> {
    let resolution = InteractiveRequestResolution::from_response(&response, Utc::now());
    let pending = {
        let requests = app.inner.interactive_requests.lock().await;
        requests
            .get(&(workspace_id.clone(), request_id.clone()))
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("interactive request not found".to_string()))?
    };
    validate_interactive_response(&pending.request, &response)?;
    let request_key = (workspace_id.clone(), request_id.clone());
    // Claude approvals resolve through the hook handler's oneshot; the Codex
    // session must not be touched for them.
    let is_claude_approval = app
        .inner
        .claude_approvals
        .lock()
        .await
        .contains_key(&request_key);
    if is_claude_approval {
        let InteractiveResponsePayload::Approval { decision } = response else {
            return Err(DaemonError::BadRequest(
                "Claude interactive requests require an approval response".to_string(),
            ));
        };
        if let Some(sender) = app.inner.claude_approvals.lock().await.remove(&request_key) {
            let _ = sender.send(decision);
        }
        app.inner
            .interactive_requests
            .lock()
            .await
            .remove(&request_key);
        if let Some(thread_id) = pending.request.thread_id {
            let still_waiting =
                thread_has_pending_interactive_request(app, &workspace_id, &thread_id).await;
            app.with_thread_mut(&workspace_id, &thread_id, |thread| {
                // Only revive threads that are actually waiting on this
                // approval; the turn may have died in the meantime and
                // forcing Running back would leave a permanent spinner. And
                // another pending request may still target this thread —
                // answering one of two concurrent approvals must keep it
                // waiting for the other.
                if !still_waiting && matches!(thread.status, ThreadStatus::WaitingForInput) {
                    thread.status = ThreadStatus::Running;
                }
            })
            .await?;
            app.resolve_interactive_request_item(
                &workspace_id,
                &thread_id,
                &request_id,
                Some(resolution),
            )
            .await?;
        }
        app.emit(
            Some(workspace_id),
            None,
            UnifiedEvent::Snapshot {
                snapshot: app.snapshot().await,
            },
        );
        return Ok(CommandResponse {
            ok: true,
            message: Some("response sent".to_string()),
        });
    }
    if pending.request.method == "session/request_permission" {
        let InteractiveResponsePayload::Approval { decision } = response else {
            return Err(DaemonError::BadRequest(
                "ACP permission requests require an approval response".to_string(),
            ));
        };
        if let Err(error) = app
            .respond_acp_permission(
                &workspace_id,
                pending.request.thread_id.as_deref(),
                &request_id,
                decision,
            )
            .await
        {
            // The agent that raised this approval is gone, so nobody can act
            // on the decision. Leaving the card answerable would park the
            // thread on `waiting_for_input` forever, one dead prompt at a
            // time; retire it instead and say why.
            if matches!(error, DaemonError::NotFound(_)) {
                discard_unanswerable_interactive_request(
                    app,
                    &workspace_id,
                    &request_id,
                    pending.request.thread_id.as_deref(),
                )
                .await;
                return Err(DaemonError::BadRequest(
                    "This approval is no longer live — the agent exited before it was answered. Send the message again.".to_string(),
                ));
            }
            return Err(error);
        }
        app.inner
            .interactive_requests
            .lock()
            .await
            .remove(&request_key);
        if let Some(thread_id) = pending.request.thread_id {
            let still_waiting =
                thread_has_pending_interactive_request(app, &workspace_id, &thread_id).await;
            app.with_thread_mut(&workspace_id, &thread_id, |thread| {
                if !still_waiting && matches!(thread.status, ThreadStatus::WaitingForInput) {
                    thread.status = ThreadStatus::Running;
                }
            })
            .await?;
            app.resolve_interactive_request_item(
                &workspace_id,
                &thread_id,
                &request_id,
                Some(resolution),
            )
            .await?;
        }
        app.emit(
            Some(workspace_id),
            None,
            UnifiedEvent::Snapshot {
                snapshot: app.snapshot().await,
            },
        );
        return Ok(CommandResponse {
            ok: true,
            message: Some("response sent".to_string()),
        });
    }
    if pending.request.method == "x.ai/exit_plan_mode" {
        let InteractiveResponsePayload::PlanApproval { outcome, feedback } = response else {
            return Err(DaemonError::BadRequest(
                "ACP plan reviews require a plan approval response".to_string(),
            ));
        };
        if let Err(error) = app
            .respond_acp_plan_approval(
                &workspace_id,
                pending.request.thread_id.as_deref(),
                &request_id,
                outcome,
                feedback,
            )
            .await
        {
            if matches!(error, DaemonError::NotFound(_)) {
                discard_unanswerable_interactive_request(
                    app,
                    &workspace_id,
                    &request_id,
                    pending.request.thread_id.as_deref(),
                )
                .await;
                return Err(DaemonError::BadRequest(
                    "This plan review is no longer live — the agent exited before it was answered. Send the message again.".to_string(),
                ));
            }
            return Err(error);
        }
        app.inner
            .interactive_requests
            .lock()
            .await
            .remove(&request_key);
        if let Some(thread_id) = pending.request.thread_id {
            let still_waiting =
                thread_has_pending_interactive_request(app, &workspace_id, &thread_id).await;
            app.with_thread_mut(&workspace_id, &thread_id, |thread| {
                if !still_waiting && matches!(thread.status, ThreadStatus::WaitingForInput) {
                    thread.status = ThreadStatus::Running;
                }
            })
            .await?;
            app.resolve_interactive_request_item(
                &workspace_id,
                &thread_id,
                &request_id,
                Some(resolution),
            )
            .await?;
        }
        app.emit(
            Some(workspace_id),
            None,
            UnifiedEvent::Snapshot {
                snapshot: app.snapshot().await,
            },
        );
        return Ok(CommandResponse {
            ok: true,
            message: Some("response sent".to_string()),
        });
    }
    if pending.request.method == "opencode/permission" {
        let InteractiveResponsePayload::Approval { decision } = response else {
            return Err(DaemonError::BadRequest(
                "OpenCode permission requests require an approval response".to_string(),
            ));
        };
        let thread_id = pending.request.thread_id.ok_or_else(|| {
            DaemonError::BadRequest("OpenCode permission request has no thread".to_string())
        })?;
        app.respond_opencode_permission(&workspace_id, &thread_id, &request_id, decision)
            .await?;
        app.inner
            .interactive_requests
            .lock()
            .await
            .remove(&request_key);
        let still_waiting =
            thread_has_pending_interactive_request(app, &workspace_id, &thread_id).await;
        app.with_thread_mut(&workspace_id, &thread_id, |thread| {
            if !still_waiting && matches!(thread.status, ThreadStatus::WaitingForInput) {
                thread.status = ThreadStatus::Running;
            }
        })
        .await?;
        app.resolve_interactive_request_item(
            &workspace_id,
            &thread_id,
            &request_id,
            Some(resolution),
        )
        .await?;
        return Ok(CommandResponse {
            ok: true,
            message: Some("response sent".to_string()),
        });
    }
    if pending.request.method == "opencode/question" {
        let InteractiveResponsePayload::Question { answers } = response else {
            return Err(DaemonError::BadRequest(
                "OpenCode questions require question answers".to_string(),
            ));
        };
        let thread_id = pending.request.thread_id.clone().ok_or_else(|| {
            DaemonError::BadRequest("OpenCode question has no thread".to_string())
        })?;
        let ordered_answers = pending
            .request
            .questions
            .iter()
            .map(|question| answers.get(&question.id).cloned().unwrap_or_default())
            .collect();
        app.respond_opencode_question(&workspace_id, &thread_id, &request_id, ordered_answers)
            .await?;
        app.inner
            .interactive_requests
            .lock()
            .await
            .remove(&request_key);
        let still_waiting =
            thread_has_pending_interactive_request(app, &workspace_id, &thread_id).await;
        app.with_thread_mut(&workspace_id, &thread_id, |thread| {
            if !still_waiting && matches!(thread.status, ThreadStatus::WaitingForInput) {
                thread.status = ThreadStatus::Running;
            }
        })
        .await?;
        app.resolve_interactive_request_item(
            &workspace_id,
            &thread_id,
            &request_id,
            Some(resolution),
        )
        .await?;
        return Ok(CommandResponse {
            ok: true,
            message: Some("response sent".to_string()),
        });
    }
    // Claude approvals and ACP permissions were answered above; anything left
    // here is a Codex app-server request and has to go back over its JSON-RPC
    // connection.
    if let Some(thread_id) = pending.request.thread_id.as_deref() {
        let provider = app.thread_provider(&workspace_id, thread_id).await?;
        if !matches!(
            ProviderRuntime::for_provider(&provider),
            ProviderRuntime::Codex
        ) {
            return Err(DaemonError::BadRequest(
                "Claude interactive requests are not yet routable through FalconDeck".to_string(),
            ));
        }
    }
    let session = app.session_for(&workspace_id).await?;

    let result = match (&pending.request.kind, response) {
        (InteractiveRequestKind::Approval, InteractiveResponsePayload::Approval { decision }) => {
            codex_approval_response(&pending.request.method, &pending.params, &decision)
        }
        (InteractiveRequestKind::Question, InteractiveResponsePayload::Question { answers }) => {
            json!({
                "answers": answers
                    .into_iter()
                    .map(|(question_id, question_answers)| {
                        (question_id, json!({ "answers": question_answers }))
                    })
                    .collect::<serde_json::Map<String, Value>>()
            })
        }
        (InteractiveRequestKind::Approval, _) => {
            return Err(DaemonError::BadRequest(
                "interactive approval requires an approval response".to_string(),
            ));
        }
        (InteractiveRequestKind::Question, _) => {
            return Err(DaemonError::BadRequest(
                "interactive question requires question answers".to_string(),
            ));
        }
        (InteractiveRequestKind::PlanApproval, _) => {
            return Err(DaemonError::BadRequest(
                "plan approval requests are only supported by their originating ACP runtime"
                    .to_string(),
            ));
        }
    };

    session.respond_to_request(pending.raw_id, result).await?;

    app.inner
        .interactive_requests
        .lock()
        .await
        .remove(&(workspace_id.clone(), request_id.clone()));

    if let Some(thread_id) = pending.request.thread_id {
        let still_waiting =
            thread_has_pending_interactive_request(app, &workspace_id, &thread_id).await;
        app.with_thread_mut(&workspace_id, &thread_id, |thread| {
            // See the Claude branch above: never force Running onto a thread
            // whose turn already ended or that another pending request still
            // holds in WaitingForInput.
            if !still_waiting && matches!(thread.status, ThreadStatus::WaitingForInput) {
                thread.status = ThreadStatus::Running;
            }
        })
        .await?;
        app.resolve_interactive_request_item(
            &workspace_id,
            &thread_id,
            &request_id,
            Some(resolution),
        )
        .await?;
    }

    app.emit(
        Some(workspace_id),
        None,
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );

    Ok(CommandResponse {
        ok: true,
        message: Some("response sent".to_string()),
    })
}

fn validate_interactive_response(
    request: &InteractiveRequest,
    response: &InteractiveResponsePayload,
) -> Result<(), DaemonError> {
    match (&request.kind, response) {
        (InteractiveRequestKind::Approval, InteractiveResponsePayload::Approval { decision }) => {
            let supported = if let Some(decisions) = &request.approval_decisions {
                decisions.contains(decision)
            } else {
                // Old persisted requests predate capability advertisement.
                matches!(decision, ApprovalDecision::Allow | ApprovalDecision::Deny)
            };
            if supported {
                Ok(())
            } else {
                Err(DaemonError::BadRequest(
                    "interactive approval decision was not offered by the provider".to_string(),
                ))
            }
        }
        (InteractiveRequestKind::Approval, _) => Err(DaemonError::BadRequest(
            "interactive approval requires an approval response".to_string(),
        )),
        (InteractiveRequestKind::Question, InteractiveResponsePayload::Question { answers }) => {
            if request.questions.is_empty() {
                return Err(DaemonError::BadRequest(
                    "interactive question did not provide any questions".to_string(),
                ));
            }
            let expected_ids = request
                .questions
                .iter()
                .map(|question| question.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            if expected_ids.len() != request.questions.len() {
                return Err(DaemonError::BadRequest(
                    "interactive question contains duplicate question identifiers".to_string(),
                ));
            }
            if answers
                .keys()
                .any(|question_id| !expected_ids.contains(question_id.as_str()))
            {
                return Err(DaemonError::BadRequest(
                    "interactive response contains an unknown question identifier".to_string(),
                ));
            }
            if request.questions.iter().any(|question| {
                answers.get(&question.id).is_none_or(|values| {
                    values.is_empty() || values.iter().any(|value| value.trim().is_empty())
                })
            }) {
                return Err(DaemonError::BadRequest(
                    "every interactive question requires a non-empty answer".to_string(),
                ));
            }
            Ok(())
        }
        (InteractiveRequestKind::Question, _) => Err(DaemonError::BadRequest(
            "interactive question requires question answers".to_string(),
        )),
        (InteractiveRequestKind::PlanApproval, InteractiveResponsePayload::PlanApproval { .. }) => {
            Ok(())
        }
        (InteractiveRequestKind::PlanApproval, _) => Err(DaemonError::BadRequest(
            "interactive plan review requires a plan approval response".to_string(),
        )),
    }
}

pub(super) async fn collaboration_modes(
    app: &AppState,
    workspace_id: &str,
) -> Result<Vec<CollaborationModeSummary>, DaemonError> {
    let workspaces = app.inner.workspaces.lock().await;
    let workspace = workspaces
        .get(workspace_id)
        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
    Ok(workspace
        .summary
        .agents
        .iter()
        .find(|agent| agent.provider == workspace.summary.default_provider)
        .map(|agent| agent.collaboration_modes.clone())
        .unwrap_or_else(|| workspace.summary.collaboration_modes.clone()))
}

pub(super) async fn load_codex_provider_skills(
    _app: &AppState,
    session: &Arc<CodexSession>,
) -> Result<Vec<SkillSummary>, DaemonError> {
    let value = session
        .send_request("skills/list", json!({ "limit": 200 }))
        .await
        .unwrap_or(Value::Null);
    Ok(parse_codex_provider_skills(&value))
}

pub(super) async fn refresh_connected_workspace_metadata(
    app: &AppState,
    workspace_id: &str,
) -> Result<WorkspaceSummary, DaemonError> {
    let (workspace_path, codex_session, claude_runtime) = {
        let workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        (
            workspace.summary.path.clone(),
            workspace.codex_session.clone(),
            workspace.claude_runtime.clone(),
        )
    };

    let codex_metadata = match codex_session.as_ref() {
        Some(session) => Some(session.provider_metadata().await?),
        None => None,
    };
    let claude_metadata = match claude_runtime.as_ref() {
        Some(runtime) => Some(runtime.provider_metadata().await),
        None => None,
    };
    let file_backed_skills = discover_file_backed_skills(&workspace_path);
    let codex_provider_skills = match codex_session.as_ref() {
        Some(session) => load_codex_provider_skills(app, session)
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let merged_skills = merge_skills(
        file_backed_skills
            .into_iter()
            .chain(codex_provider_skills)
            .collect(),
    );
    let codex_skills = skills_for_provider(&merged_skills, AgentProvider::CODEX);
    let claude_skills = skills_for_provider(&merged_skills, AgentProvider::CLAUDE);

    let summary = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        workspace.summary.skills = merged_skills;

        if let Some(metadata) = codex_metadata {
            update_workspace_agent_summary(
                &mut workspace.summary.agents,
                AgentProvider::CODEX,
                metadata,
                codex_skills,
            );
        }
        if let Some(metadata) = claude_metadata {
            update_workspace_agent_summary(
                &mut workspace.summary.agents,
                AgentProvider::CLAUDE,
                metadata,
                claude_skills,
            );
        }

        workspace.summary.status = if workspace.summary.agents.iter().all(|agent| {
            matches!(
                agent.account.status,
                falcondeck_core::AccountStatus::NeedsAuth
            )
        }) {
            WorkspaceStatus::NeedsAuth
        } else {
            WorkspaceStatus::Ready
        };

        workspace.summary.clone()
    };

    app.persist_local_state().await?;
    Ok(summary)
}

const CODEX_RECONNECT_MAX_ATTEMPTS: u32 = 5;

fn codex_reconnect_delay(attempt: u32) -> Duration {
    Duration::from_secs(1 << attempt.min(4))
}

#[derive(Debug)]
enum CodexReconnectAttempt {
    /// The workspace was removed; stop reconnecting for good.
    WorkspaceGone,
    /// A live session is already attached (another reconnect won); stop.
    AlreadyConnected,
    Reconnected,
    Failed(String),
}

/// Respawn the Codex app-server for a workspace after an unexpected exit.
/// Bounded attempts double as the respawn-storm guard: a fresh session that
/// dies immediately re-enters here, and after five failures recovery stays
/// manual until the user reconnects the workspace.
pub(super) async fn run_codex_reconnect(app: &AppState, workspace_id: &str) {
    let mut last_error = "unknown error".to_string();
    for attempt in 0..CODEX_RECONNECT_MAX_ATTEMPTS {
        tokio::time::sleep(codex_reconnect_delay(attempt)).await;
        // Never race the daemon's own shutdown with a fresh app-server spawn.
        if app.is_shutting_down() {
            return;
        }
        match try_codex_reconnect(app, workspace_id).await {
            CodexReconnectAttempt::WorkspaceGone | CodexReconnectAttempt::AlreadyConnected => {
                return;
            }
            CodexReconnectAttempt::Reconnected => {
                app.clear_operational_condition(workspace_id, "codex_connection");
                app.clear_operational_condition(workspace_id, "codex_bootstrap");
                app.emit(
                    Some(workspace_id.to_string()),
                    None,
                    UnifiedEvent::Snapshot {
                        snapshot: app.snapshot().await,
                    },
                );
                return;
            }
            CodexReconnectAttempt::Failed(error) => last_error = error,
        }
    }

    let failure = format!("Codex reconnect failed: {last_error}");
    {
        let mut workspaces = app.inner.workspaces.lock().await;
        if let Some(workspace) = workspaces.get_mut(workspace_id)
            && let Some(agent) = workspace
                .summary
                .agents
                .iter_mut()
                .find(|agent| agent.provider == AgentProvider::CODEX)
        {
            agent.account = falcondeck_core::AccountSummary {
                status: falcondeck_core::AccountStatus::Unknown,
                label: failure.clone(),
            };
        }
    }
    let _ = app.upsert_operational_condition(
        workspace_id.to_string(),
        "codex_connection",
        falcondeck_core::ServiceLevel::Error,
        failure,
        Some("codex-reconnect".to_string()),
    );
    app.emit(
        Some(workspace_id.to_string()),
        None,
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );
}

async fn try_codex_reconnect(app: &AppState, workspace_id: &str) -> CodexReconnectAttempt {
    let workspace_path = {
        let workspaces = app.inner.workspaces.lock().await;
        let Some(workspace) = workspaces.get(workspace_id) else {
            return CodexReconnectAttempt::WorkspaceGone;
        };
        if workspace
            .codex_session
            .as_ref()
            .is_some_and(|session| !session.is_closed())
        {
            return CodexReconnectAttempt::AlreadyConnected;
        }
        workspace.summary.path.clone()
    };

    let bootstrap = match CodexSession::connect(
        workspace_id.to_string(),
        workspace_path,
        app.provider_bin(&AgentProvider::CODEX),
        app.clone(),
    )
    .await
    {
        Ok(bootstrap) => bootstrap,
        Err(error) => return CodexReconnectAttempt::Failed(error.to_string()),
    };
    // In-memory thread state stays authoritative: bootstrap.threads is
    // deliberately dropped; only the session handle and metadata refresh.
    let CodexBootstrap {
        session,
        account,
        models,
        collaboration_modes,
        threads: _,
    } = bootstrap;

    let mut workspaces = app.inner.workspaces.lock().await;
    let stale = match workspaces.get_mut(workspace_id) {
        None => Some(CodexReconnectAttempt::WorkspaceGone),
        Some(workspace)
            if workspace
                .codex_session
                .as_ref()
                .is_some_and(|session| !session.is_closed()) =>
        {
            Some(CodexReconnectAttempt::AlreadyConnected)
        }
        Some(_) => None,
    };
    if let Some(outcome) = stale {
        drop(workspaces);
        let _ = session.shutdown().await;
        return outcome;
    }
    let workspace = workspaces
        .get_mut(workspace_id)
        .expect("workspace checked above");
    workspace.codex_session = Some(session);
    let codex_skills = workspace
        .summary
        .agents
        .iter()
        .find(|agent| agent.provider == AgentProvider::CODEX)
        .map(|agent| agent.skills.clone())
        .unwrap_or_default();
    update_workspace_agent_summary(
        &mut workspace.summary.agents,
        AgentProvider::CODEX,
        CodexProviderMetadata {
            account,
            models,
            collaboration_modes,
        },
        codex_skills,
    );
    for thread in workspace.threads.values_mut() {
        if thread.summary.provider == AgentProvider::CODEX {
            thread.requires_resume = true;
        }
    }
    workspace.summary.updated_at = Utc::now();
    CodexReconnectAttempt::Reconnected
}

pub(super) async fn thread_detail(
    app: &AppState,
    request: &ThreadDetailRequest,
) -> Result<ThreadDetail, DaemonError> {
    let should_refresh_codex_goal = {
        let workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(&request.thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        thread.summary.provider == AgentProvider::CODEX
            && (thread.requires_resume || thread.summary.goal.is_none())
    };
    if should_refresh_codex_goal {
        match app
            .resume_codex_thread_if_needed(&request.workspace_id, &request.thread_id)
            .await
        {
            Ok(session) => match session
                .send_request("thread/goal/get", json!({ "threadId": request.thread_id }))
                .await
            {
                Ok(result) => {
                    let goal = crate::codex::parse_thread_goal(&result);
                    let mut changed = false;
                    app.with_thread_mut(&request.workspace_id, &request.thread_id, |thread| {
                        if thread.goal != goal {
                            thread.goal = goal;
                            changed = true;
                        }
                    })
                    .await?;
                    if changed {
                        let thread = app
                            .thread_summary(&request.workspace_id, &request.thread_id)
                            .await?;
                        app.emit(
                            Some(request.workspace_id.clone()),
                            Some(request.thread_id.clone()),
                            UnifiedEvent::ThreadUpdated { thread },
                        );
                    }
                }
                Err(error) => tracing::debug!(
                    workspace_id = %request.workspace_id,
                    thread_id = %request.thread_id,
                    %error,
                    "could not refresh Codex thread goal"
                ),
            },
            Err(error) => tracing::debug!(
                workspace_id = %request.workspace_id,
                thread_id = %request.thread_id,
                %error,
                "could not resume Codex thread for goal refresh"
            ),
        }
    }
    let workspaces = app.inner.workspaces.lock().await;
    let workspace = workspaces
        .get(&request.workspace_id)
        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
    let thread = workspace
        .threads
        .get(&request.thread_id)
        .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
    let workspace_summary = workspace.summary.clone();
    let thread_summary = thread.summary.clone();
    let mut detail = thread_detail_window(&thread.items, request)?;
    settle_thread_detail_tool_items(&mut detail.items, &thread.summary.status, Utc::now());
    // A restored ACP thread carries only its summary; the transcript lives in
    // the agent's session store. Kick off a background session/load replay so
    // opening the thread fills it in instead of showing an empty conversation.
    let needs_native_hydration = thread.items.is_empty()
        && thread.summary.native_session_id.is_some()
        && thread.summary.provider_transport.as_deref() == Some("native")
        && !matches!(thread.summary.status, ThreadStatus::Running);
    let needs_acp_hydration = thread.items.is_empty()
        && thread.summary.native_session_id.is_some()
        && thread.summary.provider != AgentProvider::CODEX
        && thread.summary.provider != AgentProvider::CLAUDE
        && thread.summary.provider_transport.as_deref() != Some("native")
        && !matches!(thread.summary.status, ThreadStatus::Running);
    drop(workspaces);
    if needs_native_hydration {
        app.schedule_opencode_thread_hydration(&request.workspace_id, &request.thread_id);
    } else if needs_acp_hydration {
        app.schedule_acp_thread_hydration(&request.workspace_id, &request.thread_id);
    }
    let items = with_renderable_attachment_previews_for_items(detail.items).await;

    Ok(ThreadDetail {
        workspace: workspace_summary,
        thread: app.build_thread_summary_from_clone(thread_summary).await,
        items,
        has_older: detail.has_older,
        oldest_item_id: detail.oldest_item_id,
        newest_item_id: detail.newest_item_id,
        is_partial: detail.is_partial,
    })
}

/// Projects stale transient tools using the containing thread's terminal
/// outcome. This is a read-path safety net only; authoritative stored items
/// are settled by the normal terminal turn handlers.
fn settle_thread_detail_tool_items(
    items: &mut [ConversationItem],
    thread_status: &ThreadStatus,
    settled_at: chrono::DateTime<Utc>,
) {
    let settlement = match thread_status {
        ThreadStatus::Idle => ToolSettlement::Completed,
        ThreadStatus::Error => ToolSettlement::Failed,
        ThreadStatus::Running | ThreadStatus::WaitingForInput => return,
    };
    settle_tool_call_items(items, settled_at, settlement);
}

struct ThreadDetailWindow {
    items: Vec<ConversationItem>,
    has_older: bool,
    oldest_item_id: Option<String>,
    newest_item_id: Option<String>,
    is_partial: bool,
}

fn thread_detail_window(
    items: &[ConversationItem],
    request: &ThreadDetailRequest,
) -> Result<ThreadDetailWindow, DaemonError> {
    const DEFAULT_TAIL_LIMIT: usize = 150;
    const DEFAULT_BEFORE_LIMIT: usize = 100;
    const MAX_PAGE_SIZE: usize = 500;

    let clamp_limit = |limit: Option<usize>, default_limit| {
        limit.unwrap_or(default_limit).clamp(1, MAX_PAGE_SIZE)
    };
    let build_window =
        |window: Vec<ConversationItem>, has_older: bool, is_partial: bool| ThreadDetailWindow {
            oldest_item_id: window
                .first()
                .map(|item| conversation_item_id(item).to_string()),
            newest_item_id: window
                .last()
                .map(|item| conversation_item_id(item).to_string()),
            items: window,
            has_older,
            is_partial,
        };

    match request.mode {
        ThreadDetailMode::Full => Ok(build_window(items.to_vec(), false, false)),
        ThreadDetailMode::Tail => {
            let limit = clamp_limit(request.limit, DEFAULT_TAIL_LIMIT);
            let start = items.len().saturating_sub(limit);
            let window = items[start..].to_vec();
            Ok(build_window(window, start > 0, start > 0))
        }
        ThreadDetailMode::Before => {
            let before_item_id = request.before_item_id.as_ref().ok_or_else(|| {
                DaemonError::BadRequest("before_item_id is required for before mode".to_string())
            })?;
            let before_index = items
                .iter()
                .position(|item| conversation_item_id(item) == before_item_id)
                .ok_or_else(|| {
                    DaemonError::BadRequest(
                        "before_item_id was not found in the thread".to_string(),
                    )
                })?;
            let limit = clamp_limit(request.limit, DEFAULT_BEFORE_LIMIT);
            let start = before_index.saturating_sub(limit);
            let window = items[start..before_index].to_vec();
            Ok(build_window(window, start > 0, true))
        }
    }
}

fn conversation_item_id(item: &ConversationItem) -> &str {
    match item {
        ConversationItem::UserMessage { id, .. }
        | ConversationItem::AssistantMessage { id, .. }
        | ConversationItem::Reasoning { id, .. }
        | ConversationItem::CodeReview { id, .. }
        | ConversationItem::ContextCompaction { id, .. }
        | ConversationItem::Artifact { id, .. }
        | ConversationItem::Unsupported { id, .. }
        | ConversationItem::Image { id, .. }
        | ConversationItem::WebSearch { id, .. }
        | ConversationItem::FileChange { id, .. }
        | ConversationItem::ToolCall { id, .. }
        | ConversationItem::Plan { id, .. }
        | ConversationItem::Diff { id, .. }
        | ConversationItem::Service { id, .. }
        | ConversationItem::InteractiveRequest { id, .. } => id,
    }
}

pub(super) async fn mark_thread_read(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    read_seq: u64,
) -> Result<ThreadSummary, DaemonError> {
    let mut changed = false;
    {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        if read_seq > thread.summary.attention.last_read_seq {
            thread.summary.attention.last_read_seq = read_seq;
            changed = true;
        }
    }

    let thread = app.thread_summary(workspace_id, thread_id).await?;
    if changed {
        app.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ThreadUpdated {
                thread: thread.clone(),
            },
        );
        app.persist_local_state().await?;
    }
    Ok(thread)
}

/// Walks `last_read_seq` back far enough that the thread reads as unread
/// again. `mark_thread_read` is deliberately monotonic-forward, so the inverse
/// gets its own entry point rather than a "go backwards" flag on the read
/// path, where a stale client retry could silently un-read a thread.
pub(super) async fn mark_thread_unread(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
) -> Result<ThreadSummary, DaemonError> {
    let mut changed = false;
    {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        // A thread the agent has never spoken in has nothing to be unread
        // about: `unread` is `activity_seq > read_seq`, so with no activity no
        // `read_seq` can make it true. Leave it alone instead of erroring.
        let target = thread
            .summary
            .attention
            .last_agent_activity_seq
            .saturating_sub(1);
        if thread.summary.attention.last_agent_activity_seq > 0
            && thread.summary.attention.last_read_seq > target
        {
            thread.summary.attention.last_read_seq = target;
            changed = true;
        }
    }

    let thread = app.thread_summary(workspace_id, thread_id).await?;
    if changed {
        app.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ThreadUpdated {
                thread: thread.clone(),
            },
        );
        app.persist_local_state().await?;
    }
    Ok(thread)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn omitted_harness_modes_use_local_permissive_defaults() {
        assert_eq!(
            default_permission_mode(&AgentProvider::CODEX),
            Some("never")
        );
        assert_eq!(
            default_sandbox_mode(&AgentProvider::CODEX),
            Some("danger-full-access")
        );
        assert_eq!(
            default_permission_mode(&AgentProvider::CLAUDE),
            Some("bypassPermissions")
        );
        assert_eq!(
            default_permission_mode(&AgentProvider::new("grok")),
            Some("always-approve")
        );
        assert_eq!(
            default_permission_mode(&AgentProvider::new("opencode")),
            Some("always-approve")
        );
    }

    fn question_request(question_ids: &[&str]) -> InteractiveRequest {
        InteractiveRequest {
            request_id: "request-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            method: "item/tool/requestUserInput".to_string(),
            kind: InteractiveRequestKind::Question,
            approval_decisions: Some(Vec::new()),
            title: "Answer question".to_string(),
            detail: None,
            command: None,
            path: None,
            turn_id: Some("turn-1".to_string()),
            item_id: Some("item-1".to_string()),
            questions: question_ids
                .iter()
                .map(|id| falcondeck_core::InteractiveQuestion {
                    id: (*id).to_string(),
                    header: "Question".to_string(),
                    question: "Choose a value".to_string(),
                    is_other: false,
                    is_secret: false,
                    options: None,
                })
                .collect(),
            created_at: Utc::now(),
        }
    }

    #[test]
    fn interactive_response_accepts_complete_question_answers() {
        let response = InteractiveResponsePayload::Question {
            answers: HashMap::from([("region".to_string(), vec!["London".to_string()])]),
        };

        assert!(validate_interactive_response(&question_request(&["region"]), &response).is_ok());
    }

    fn approval_request(decisions: Option<Vec<ApprovalDecision>>) -> InteractiveRequest {
        InteractiveRequest {
            kind: InteractiveRequestKind::Approval,
            approval_decisions: decisions,
            title: "Allow tests?".to_string(),
            method: "item/commandExecution/requestApproval".to_string(),
            command: Some("npm test".to_string()),
            questions: Vec::new(),
            ..question_request(&[])
        }
    }

    #[test]
    fn plan_reviews_only_accept_plan_approval_responses() {
        let request = InteractiveRequest {
            kind: InteractiveRequestKind::PlanApproval,
            approval_decisions: None,
            title: "Review implementation plan".to_string(),
            method: "x.ai/exit_plan_mode".to_string(),
            detail: Some("## Plan".to_string()),
            questions: Vec::new(),
            ..question_request(&[])
        };
        let response = InteractiveResponsePayload::PlanApproval {
            outcome: falcondeck_core::PlanApprovalOutcome::Cancelled,
            feedback: Some("Add a rollback test".to_string()),
        };

        assert!(validate_interactive_response(&request, &response).is_ok());
        assert!(
            validate_interactive_response(
                &request,
                &InteractiveResponsePayload::Approval {
                    decision: ApprovalDecision::Allow,
                },
            )
            .is_err()
        );
    }

    #[test]
    fn interactive_response_rejects_decisions_the_provider_did_not_offer() {
        let request = approval_request(Some(vec![ApprovalDecision::Allow, ApprovalDecision::Deny]));
        let response = InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::AlwaysAllow,
        };

        let error = validate_interactive_response(&request, &response)
            .expect_err("unsupported persistent approval must fail");
        assert_eq!(
            error.to_string(),
            "interactive approval decision was not offered by the provider"
        );
    }

    #[test]
    fn legacy_interactive_approvals_allow_once_or_deny_but_not_persistence() {
        let request = approval_request(None);
        for decision in [ApprovalDecision::Allow, ApprovalDecision::Deny] {
            assert!(
                validate_interactive_response(
                    &request,
                    &InteractiveResponsePayload::Approval { decision },
                )
                .is_ok()
            );
        }
        assert!(
            validate_interactive_response(
                &request,
                &InteractiveResponsePayload::Approval {
                    decision: ApprovalDecision::AlwaysAllow,
                },
            )
            .is_err()
        );
    }

    #[test]
    fn interactive_response_rejects_missing_question_answers() {
        let response = InteractiveResponsePayload::Question {
            answers: HashMap::new(),
        };

        let error = validate_interactive_response(&question_request(&["region"]), &response)
            .expect_err("missing answer must fail");
        assert_eq!(
            error.to_string(),
            "every interactive question requires a non-empty answer"
        );
    }

    #[test]
    fn interactive_response_rejects_unknown_question_identifiers() {
        let response = InteractiveResponsePayload::Question {
            answers: HashMap::from([
                ("region".to_string(), vec!["London".to_string()]),
                ("injected".to_string(), vec!["value".to_string()]),
            ]),
        };

        let error = validate_interactive_response(&question_request(&["region"]), &response)
            .expect_err("unknown identifier must fail");
        assert_eq!(
            error.to_string(),
            "interactive response contains an unknown question identifier"
        );
    }

    #[test]
    fn interactive_response_rejects_blank_secret_without_echoing_it() {
        let response = InteractiveResponsePayload::Question {
            answers: HashMap::from([("token".to_string(), vec!["   ".to_string()])]),
        };

        let error = validate_interactive_response(&question_request(&["token"]), &response)
            .expect_err("blank answer must fail");
        assert_eq!(
            error.to_string(),
            "every interactive question requires a non-empty answer"
        );
    }

    fn assistant_message(id: &str) -> ConversationItem {
        ConversationItem::AssistantMessage {
            id: id.to_string(),
            text: format!("message {id}"),
            phase: None,
            memory_citation: None,
            citations: Vec::new(),
            lifecycle: ContentLifecycle::Complete,
            error: None,
            created_at: Utc::now(),
        }
    }

    fn hydrated_thread(session_id: &str, preview: &str) -> crate::codex::HydratedThread {
        crate::codex::HydratedThread {
            summary: ThreadSummary {
                id: session_id.to_string(),
                workspace_id: "workspace-1".to_string(),
                title: format!("Hydrated {session_id}"),
                provider: AgentProvider::CLAUDE,
                native_session_id: Some(session_id.to_string()),
                provider_transport: None,
                handoff_from: None,
                origin: None,
                status: ThreadStatus::Idle,
                updated_at: Utc::now(),
                last_message_preview: Some(preview.to_string()),
                latest_turn_id: None,
                latest_plan: None,
                latest_diff: None,
                last_tool: None,
                last_error: None,
                agent: ThreadAgentParams::default(),
                attention: ThreadAttention::default(),
                is_archived: false,
                is_pinned: false,
                goal: None,
                queued_turns: Vec::new(),
                variant: None,
            },
            items: vec![assistant_message(&format!("assistant-{session_id}"))],
            title_is_provider_preview: false,
        }
    }

    fn managed_thread(thread_id: &str, status: ThreadStatus) -> ManagedThread {
        let mut thread = hydrated_thread(thread_id, "preview");
        thread.summary.status = status;
        ManagedThread::with_items(thread.summary, thread.items)
    }

    #[test]
    fn reconnecting_a_workspace_keeps_threads_that_are_mid_turn() {
        // The hydrated view is what a restart-time reconnect rebuilds: the
        // last turn recorded as interrupted by shutdown.
        let mut hydrated = HashMap::from([
            ("running".to_string(), {
                let mut stale = managed_thread("running", ThreadStatus::Error);
                stale.summary.last_error = Some(SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string());
                stale
            }),
            ("idle".to_string(), managed_thread("idle", ThreadStatus::Idle)),
        ]);
        let previous = HashMap::from([
            (
                "running".to_string(),
                managed_thread("running", ThreadStatus::Running),
            ),
            (
                "waiting".to_string(),
                managed_thread("waiting", ThreadStatus::WaitingForInput),
            ),
            (
                "finished".to_string(),
                managed_thread("finished", ThreadStatus::Idle),
            ),
        ]);

        carry_over_live_threads(&mut hydrated, previous);

        // Live work wins over the rebuilt copy, including a thread the
        // hydrated view does not know about at all.
        assert_eq!(hydrated["running"].summary.status, ThreadStatus::Running);
        assert_eq!(hydrated["running"].summary.last_error, None);
        assert_eq!(
            hydrated["waiting"].summary.status,
            ThreadStatus::WaitingForInput
        );
        // Nothing was in flight for these, so the rebuilt view stands.
        assert_eq!(hydrated["idle"].summary.status, ThreadStatus::Idle);
        assert!(!hydrated.contains_key("finished"));
    }

    fn persisted_thread(thread_id: &str, session_id: Option<&str>) -> PersistedThreadState {
        PersistedThreadState {
            thread_id: thread_id.to_string(),
            updated_at: Some(Utc::now()),
            provider: Some(AgentProvider::CLAUDE),
            native_session_id: session_id.map(ToOwned::to_owned),
            provider_transport: None,
            handoff_from: None,
            origin: None,
            title: Some(format!("Persisted {thread_id}")),
            manual_title: false,
            ai_title_generated: true,
            status: Some(ThreadStatus::Idle),
            last_error: None,
            last_read_seq: 0,
            last_agent_activity_seq: 0,
            variant: None,
            agent: ThreadAgentParams::default(),
            queued_requests: Vec::new(),
        }
    }

    #[test]
    fn provider_preview_does_not_count_as_generated_title_after_restore() {
        let mut hydrated = hydrated_thread("thread-1", "answer");
        hydrated.summary.title = "Opening prompt preview".to_string();
        let mut managed = ManagedThread::with_items(hydrated.summary, hydrated.items);
        let mut state = persisted_thread("thread-1", Some("thread-1"));
        state.title = Some("Opening prompt preview".to_string());

        restore_persisted_title_state(&mut managed, &state, "Opening prompt preview", true);

        assert!(!managed.ai_title_generated);
        // A prompt preview reads like a real title, so only the flag keeps the
        // titler eligible to replace it.
        assert!(managed.title_is_provider_preview);
        managed.items.push(ConversationItem::UserMessage {
            id: "user-1".to_string(),
            text: "Opening prompt preview".to_string(),
            attachments: Vec::new(),
            created_at: Utc::now(),
            turn_id: None,
            previous_turn_id: None,
        });
        assert!(super::should_generate_ai_thread_title(&managed));
    }

    #[test]
    fn generated_title_outlives_provider_preview_after_restore() {
        let mut hydrated = hydrated_thread("thread-1", "answer");
        hydrated.summary.title = "Opening prompt preview".to_string();
        let mut managed = ManagedThread::with_items(hydrated.summary, hydrated.items);
        let mut state = persisted_thread("thread-1", Some("thread-1"));
        state.title = Some("Concise generated title".to_string());

        restore_persisted_title_state(&mut managed, &state, "Opening prompt preview", true);

        assert_eq!(managed.summary.title, "Concise generated title");
        assert!(managed.ai_title_generated);
        assert!(!managed.title_is_provider_preview);
    }

    #[test]
    fn bare_restored_threads_keep_their_persisted_agent_params() {
        let mut state = persisted_thread("codex-thread-x", None);
        state.agent = ThreadAgentParams {
            model_id: Some("gpt-5.6-sol".to_string()),
            reasoning_effort: Some("low".to_string()),
            service_tier: Some("priority".to_string()),
            ..ThreadAgentParams::default()
        };
        let states = HashMap::from([("codex-thread-x".to_string(), state)]);

        let merged =
            merge_hydrated_threads_with_persisted_state(Vec::new(), &states, "w", None, Utc::now());

        assert_eq!(merged.len(), 1);
        let agent = &merged[0].summary.agent;
        assert_eq!(agent.model_id.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(agent.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(agent.service_tier.as_deref(), Some("priority"));
    }

    #[test]
    fn merge_missing_from_lets_provider_reported_params_win() {
        let mut hydrated = ThreadAgentParams {
            model_id: Some("gpt-5.6-terra".to_string()),
            ..ThreadAgentParams::default()
        };
        hydrated.merge_missing_from(&ThreadAgentParams {
            model_id: Some("gpt-5.6-sol".to_string()),
            service_tier: Some("priority".to_string()),
            ..ThreadAgentParams::default()
        });
        // The provider's own record wins where it says anything; persisted
        // values only fill the silence.
        assert_eq!(hydrated.model_id.as_deref(), Some("gpt-5.6-terra"));
        assert_eq!(hydrated.service_tier.as_deref(), Some("priority"));
    }

    #[test]
    fn restored_thread_adopts_the_transcript_hydrated_under_its_session_id() {
        let mut state = persisted_thread("claude-thread-x", Some("session-1"));
        state.status = Some(ThreadStatus::Running);
        let states = HashMap::from([("claude-thread-x".to_string(), state)]);

        let merged = merge_hydrated_threads_with_persisted_state(
            vec![hydrated_thread("session-1", "hello")],
            &states,
            "workspace-1",
            None,
            Utc::now(),
        );

        // One thread, owned id, with the hydrated transcript — not an empty
        // restored thread plus a session-id duplicate.
        assert_eq!(merged.len(), 1);
        let thread = &merged[0];
        assert_eq!(thread.summary.id, "claude-thread-x");
        assert_eq!(thread.items.len(), 1);
        assert_eq!(
            thread.summary.last_message_preview.as_deref(),
            Some("hello")
        );
        // A turn that was mid-flight when the daemon went away is surfaced as
        // an error, not left phantom-running.
        assert_eq!(thread.summary.status, ThreadStatus::Error);
        assert_eq!(
            thread.summary.last_error.as_deref(),
            Some(SHUTDOWN_INTERRUPTED_TURN_ERROR)
        );
    }

    #[test]
    fn direct_provider_hydration_keeps_shutdown_interruption_until_acknowledged() {
        let mut state = persisted_thread("thread-1", Some("thread-1"));
        state.status = Some(ThreadStatus::Error);
        state.last_error = Some(SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string());
        let states = HashMap::from([("thread-1".to_string(), state)]);

        let merged = merge_hydrated_threads_with_persisted_state(
            vec![hydrated_thread("thread-1", "partial answer")],
            &states,
            "workspace-1",
            None,
            Utc::now(),
        );

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].summary.status, ThreadStatus::Error);
        assert_eq!(
            merged[0].summary.last_error.as_deref(),
            Some(SHUTDOWN_INTERRUPTED_TURN_ERROR)
        );
        assert_eq!(merged[0].items.len(), 1);
    }

    #[test]
    fn legacy_session_id_twin_state_is_dropped_in_favor_of_the_owning_thread() {
        // Older builds persisted the same conversation twice: once under the
        // FalconDeck thread id and once under the raw session id.
        let states = HashMap::from([
            (
                "claude-thread-x".to_string(),
                persisted_thread("claude-thread-x", Some("session-1")),
            ),
            (
                "session-1".to_string(),
                persisted_thread("session-1", Some("session-1")),
            ),
        ]);

        let merged = merge_hydrated_threads_with_persisted_state(
            vec![hydrated_thread("session-1", "hello")],
            &states,
            "workspace-1",
            None,
            Utc::now(),
        );

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].summary.id, "claude-thread-x");
        assert_eq!(merged[0].items.len(), 1);
    }

    async fn seed_workspace_with_thread(app: &AppState, workspace_id: &str, thread_id: &str) {
        let now = Utc::now();
        let thread = ThreadSummary {
            id: thread_id.to_string(),
            workspace_id: workspace_id.to_string(),
            title: "Thread".to_string(),
            provider: AgentProvider::CLAUDE,
            native_session_id: None,
            provider_transport: None,
            handoff_from: None,
            origin: None,
            status: ThreadStatus::Running,
            updated_at: now,
            last_message_preview: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: None,
            last_tool: None,
            last_error: None,
            agent: ThreadAgentParams::default(),
            attention: ThreadAttention::default(),
            is_archived: false,
            is_pinned: false,
            goal: None,
            queued_turns: Vec::new(),
            variant: None,
        };
        let workspace = WorkspaceSummary {
            id: workspace_id.to_string(),
            path: "/tmp/project".to_string(),
            status: WorkspaceStatus::Ready,
            agents: Vec::new(),
            skills: Vec::new(),
            default_provider: AgentProvider::CLAUDE,
            models: Vec::new(),
            collaboration_modes: Vec::new(),
            account: falcondeck_core::AccountSummary::default(),
            current_thread_id: Some(thread_id.to_string()),
            connected_at: now,
            updated_at: now,
            last_error: None,
        };
        app.inner.workspaces.lock().await.insert(
            workspace_id.to_string(),
            ManagedWorkspace {
                summary: workspace,
                codex_session: None,
                claude_runtime: None,
                opencode_runtime: None,
                acp_runtimes: HashMap::new(),
                threads: [(thread_id.to_string(), ManagedThread::new(thread))]
                    .into_iter()
                    .collect(),
            },
        );
    }

    #[tokio::test]
    async fn acknowledging_shutdown_interruption_clears_it_without_bumping_recency() {
        let temp_dir = tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            temp_dir.path().join("daemon-state.json"),
        );
        seed_workspace_with_thread(&app, "workspace-1", "thread-1").await;
        let interrupted_at = Utc::now() - chrono::Duration::minutes(5);
        app.with_thread_mut("workspace-1", "thread-1", |thread| {
            thread.status = ThreadStatus::Error;
            thread.last_error = Some(SHUTDOWN_INTERRUPTED_TURN_ERROR.to_string());
            thread.updated_at = interrupted_at;
        })
        .await
        .unwrap();

        let handle = update_thread(
            &app,
            falcondeck_core::UpdateThreadRequest {
                workspace_id: "workspace-1".to_string(),
                thread_id: "thread-1".to_string(),
                title: None,
                provider: None,
                model_id: None,
                reasoning_effort: None,
                collaboration_mode_id: None,
                service_tier: None,
                pinned: None,
                acknowledge_interruption: Some(true),
                permission_mode: None,
                approval_policy: None,
                sandbox_mode: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(handle.thread.status, ThreadStatus::Idle);
        assert_eq!(handle.thread.last_error, None);
        assert_eq!(handle.thread.updated_at, interrupted_at);
    }

    #[tokio::test]
    async fn edits_a_queued_turn_in_place_preserving_attachments() {
        let temp_dir = tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            temp_dir.path().join("daemon-state.json"),
        );
        seed_workspace_with_thread(&app, "workspace-1", "thread-1").await;
        {
            let mut workspaces = app.inner.workspaces.lock().await;
            let thread = workspaces
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("thread-1")
                .unwrap();
            thread
                .queued_requests
                .push(super::super::QueuedTurnRequest {
                    id: "queued-1".to_string(),
                    request: SendTurnRequest {
                        workspace_id: "workspace-1".to_string(),
                        thread_id: "thread-1".to_string(),
                        inputs: vec![
                            TurnInputItem::Text {
                                id: None,
                                text: "original words".to_string(),
                            },
                            TurnInputItem::Image(ImageInput {
                                id: "img-1".to_string(),
                                name: None,
                                mime_type: Some("image/png".to_string()),
                                url: "file:///tmp/img.png".to_string(),
                                local_path: Some("/tmp/img.png".to_string()),
                            }),
                        ],
                        selected_skills: Vec::new(),
                        provider: None,
                        model_id: None,
                        reasoning_effort: None,
                        user_item_id: None,
                        approval_policy: None,
                        service_tier: None,
                        permission_mode: None,
                        sandbox_mode: None,
                        steer: false,
                    },
                    summary: falcondeck_core::QueuedTurnSummary {
                        id: "queued-1".to_string(),
                        preview: "original words".to_string(),
                        text: "original words".to_string(),
                        attachment_count: 1,
                        queued_at: Utc::now(),
                    },
                });
            thread
                .summary
                .queued_turns
                .push(falcondeck_core::QueuedTurnSummary {
                    id: "queued-1".to_string(),
                    preview: "original words".to_string(),
                    text: "original words".to_string(),
                    attachment_count: 1,
                    queued_at: Utc::now(),
                });
        }

        edit_queued_turn(&app, "workspace-1", "thread-1", "queued-1", "  new words  ")
            .await
            .unwrap();

        let workspaces = app.inner.workspaces.lock().await;
        let thread = workspaces
            .get("workspace-1")
            .unwrap()
            .threads
            .get("thread-1")
            .unwrap();
        let queued = &thread.queued_requests[0];
        assert!(matches!(
            &queued.request.inputs[0],
            TurnInputItem::Text { text, .. } if text == "new words"
        ));
        // The attachment materialized at queue time must ride along untouched.
        assert!(matches!(&queued.request.inputs[1], TurnInputItem::Image(_)));
        let entry = &thread.summary.queued_turns[0];
        assert_eq!(
            (entry.preview.as_str(), entry.text.as_str()),
            ("new words", "new words")
        );

        drop(workspaces);
        let missing = edit_queued_turn(&app, "workspace-1", "thread-1", "queued-2", "x").await;
        assert!(missing.is_err());
        let empty = edit_queued_turn(&app, "workspace-1", "thread-1", "queued-1", "   ").await;
        assert!(empty.is_err());
    }

    #[test]
    fn unowned_hydrated_sessions_and_bare_persisted_threads_survive_the_merge() {
        let states = HashMap::from([(
            "claude-thread-x".to_string(),
            persisted_thread("claude-thread-x", Some("session-gone")),
        )]);

        let mut merged = merge_hydrated_threads_with_persisted_state(
            vec![hydrated_thread("session-2", "imported")],
            &states,
            "workspace-1",
            None,
            Utc::now(),
        );

        merged.sort_by(|left, right| left.summary.id.cmp(&right.summary.id));
        // The terminal-CLI session with no owning thread stays an import of
        // its own; the persisted thread whose session file is gone restores
        // bare rather than disappearing.
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].summary.id, "claude-thread-x");
        assert!(merged[0].items.is_empty());
        assert_eq!(merged[1].summary.id, "session-2");
        assert_eq!(merged[1].items.len(), 1);
    }

    #[tokio::test]
    async fn materializes_data_url_images_into_durable_local_files() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let app = AppState::new_with_state_path("0.1.0".to_string(), HashMap::new(), state_path);
        let inputs = vec![TurnInputItem::Image(ImageInput {
            id: "img-1".to_string(),
            name: Some("diagram.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: "data:image/png;base64,aGVsbG8=".to_string(),
            local_path: None,
        })];

        let normalized = normalize_turn_inputs(&app, "workspace-1", "thread-1", &inputs)
            .await
            .unwrap();

        let TurnInputItem::Image(image) = &normalized[0] else {
            panic!("expected image input");
        };
        let local_path = image
            .local_path
            .as_deref()
            .expect("expected normalized local path");
        assert!(local_path.ends_with("img-1.png"));
        assert_eq!(image.url, local_path);
        assert_eq!(tokio::fs::read(local_path).await.unwrap(), b"hello");
    }

    #[tokio::test]
    async fn materializes_data_url_when_local_path_does_not_exist_on_this_host() {
        // The iOS app sends its on-device picker path alongside the inline
        // payload; that path must not be trusted on the daemon host.
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let app = AppState::new_with_state_path("0.1.0".to_string(), HashMap::new(), state_path);
        let inputs = vec![TurnInputItem::Image(ImageInput {
            id: "img-1".to_string(),
            name: Some("photo.jpg".to_string()),
            mime_type: Some("image/jpeg".to_string()),
            url: "data:image/jpeg;base64,aGVsbG8=".to_string(),
            local_path: Some(
                "file:///var/mobile/Containers/Data/Application/ABC/Library/Caches/ImagePicker/photo.jpg"
                    .to_string(),
            ),
        })];

        let normalized = normalize_turn_inputs(&app, "workspace-1", "thread-1", &inputs)
            .await
            .unwrap();

        let TurnInputItem::Image(image) = &normalized[0] else {
            panic!("expected image input");
        };
        let local_path = image
            .local_path
            .as_deref()
            .expect("expected normalized local path");
        assert!(local_path.ends_with("img-1.jpg"));
        assert_eq!(image.url, local_path);
        assert_eq!(tokio::fs::read(local_path).await.unwrap(), b"hello");
    }

    #[tokio::test]
    async fn keeps_local_path_that_exists_on_this_host() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let existing = temp_dir.path().join("img.png");
        tokio::fs::write(&existing, b"png-bytes").await.unwrap();
        let app = AppState::new_with_state_path("0.1.0".to_string(), HashMap::new(), state_path);
        let inputs = vec![TurnInputItem::Image(ImageInput {
            id: "img-1".to_string(),
            name: None,
            mime_type: Some("image/png".to_string()),
            url: "data:image/png;base64,aGVsbG8=".to_string(),
            local_path: Some(existing.to_string_lossy().to_string()),
        })];

        let normalized = normalize_turn_inputs(&app, "workspace-1", "thread-1", &inputs)
            .await
            .unwrap();

        let TurnInputItem::Image(image) = &normalized[0] else {
            panic!("expected image input");
        };
        assert_eq!(
            image.local_path.as_deref(),
            Some(existing.to_string_lossy().as_ref())
        );
        assert_eq!(image.url, existing.to_string_lossy());
    }

    #[test]
    fn parses_image_data_urls_strictly() {
        let parsed =
            parse_image_data_url("data:image/webp;base64,aGVsbG8=").expect("valid data url");
        assert_eq!(parsed.media_type, "image/webp");
        assert_eq!(parsed.bytes, b"hello");
        assert!(parse_image_data_url("data:text/plain;base64,aGVsbG8=").is_err());
        assert!(parse_image_data_url("data:image/png,hello").is_err());
    }

    #[test]
    fn derives_attachment_extension_from_validated_image_media_type() {
        assert_eq!(
            image_file_extension(Some("diagram.txt"), Some("image/png"), "image/png",),
            "png"
        );
        assert_eq!(
            image_file_extension(Some("diagram.jpeg"), Some("image/webp"), "image/webp",),
            "webp"
        );
    }

    #[tokio::test]
    async fn compacts_inline_preview_urls_when_local_file_exists() {
        let temp_dir = tempdir().unwrap();
        let diagram_path = temp_dir.path().join("diagram.png");
        tokio::fs::write(&diagram_path, b"png-bytes").await.unwrap();
        let diagram_path = diagram_path.to_string_lossy().to_string();
        let image = ImageInput {
            id: "img-1".to_string(),
            name: Some("diagram.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: "data:image/png;base64,aGVsbG8=".to_string(),
            local_path: Some(diagram_path.clone()),
        };
        let mut total_image_bytes = 0;

        let normalized = normalize_image_input(
            &AppState::new_with_state_path(
                "0.1.0".to_string(),
                HashMap::new(),
                temp_dir.path().join("falcondeck-daemon-state.json"),
            ),
            "workspace-1",
            "thread-1",
            &image,
            &mut total_image_bytes,
        )
        .await
        .unwrap();

        assert_eq!(normalized.url, diagram_path);
        assert_eq!(
            normalized.local_path.as_deref(),
            Some(diagram_path.as_str())
        );
    }

    #[tokio::test]
    async fn keeps_materialized_attachments_within_daemon_state_root() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let app = AppState::new_with_state_path("0.1.0".to_string(), HashMap::new(), state_path);
        let image = ImageInput {
            id: "../../image".to_string(),
            name: Some("diagram.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: "data:image/png;base64,aGVsbG8=".to_string(),
            local_path: None,
        };

        let parsed = parse_image_data_url(&image.url).unwrap();
        let local_path = persist_inline_image_attachment(
            &app,
            "../../workspace",
            "../../thread",
            &image,
            parsed,
        )
        .await
        .unwrap();

        assert!(Path::new(&local_path).starts_with(temp_dir.path().join("attachments")));
        assert!(!local_path.contains("../"));
    }

    #[test]
    fn rejects_oversized_images_before_materializing_them() {
        let image = ImageInput {
            id: "large".to_string(),
            name: Some("panorama.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: String::new(),
            local_path: None,
        };
        let mut total = 0;

        let error =
            record_image_attachment_size(&image, MAX_IMAGE_ATTACHMENT_BYTES + 1, &mut total)
                .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("panorama.png is too large. Images must be 3.5 MB or smaller.")
        );
    }

    #[tokio::test]
    async fn oversized_inline_images_are_not_written_to_disk() {
        let temp_dir = tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "0.1.0".to_string(),
            HashMap::new(),
            temp_dir.path().join("daemon-state.json"),
        );
        let image = ImageInput {
            id: "large".to_string(),
            name: Some("panorama.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: format!(
                "data:image/png;base64,{}",
                BASE64.encode(vec![0_u8; MAX_IMAGE_ATTACHMENT_BYTES as usize + 1])
            ),
            local_path: None,
        };

        let error = normalize_turn_inputs(
            &app,
            "workspace-1",
            "thread-1",
            &[TurnInputItem::Image(image)],
        )
        .await
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("panorama.png is too large. Images must be 3.5 MB or smaller.")
        );
        assert!(!temp_dir.path().join("attachments").exists());
    }

    #[test]
    fn rejects_image_batches_over_the_aggregate_budget() {
        let image = ImageInput {
            id: "batch".to_string(),
            name: Some("batch.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: String::new(),
            local_path: None,
        };
        let mut total = MAX_TOTAL_IMAGE_ATTACHMENT_BYTES - 1;

        let error = record_image_attachment_size(&image, 2, &mut total).unwrap_err();

        assert!(
            error.to_string().contains(
                "Those images are too large together. Attach no more than 10 MB at once."
            )
        );
    }

    #[test]
    fn thread_detail_window_returns_tail_metadata_for_mobile_pages() {
        let items = vec![
            assistant_message("msg-1"),
            assistant_message("msg-2"),
            assistant_message("msg-3"),
            assistant_message("msg-4"),
        ];

        let detail = thread_detail_window(
            &items,
            &ThreadDetailRequest {
                workspace_id: "workspace-1".to_string(),
                thread_id: "thread-1".to_string(),
                mode: ThreadDetailMode::Tail,
                limit: Some(2),
                before_item_id: None,
            },
        )
        .unwrap();

        assert_eq!(
            detail
                .items
                .iter()
                .map(conversation_item_id)
                .collect::<Vec<_>>(),
            vec!["msg-3", "msg-4"]
        );
        assert!(detail.has_older);
        assert_eq!(detail.oldest_item_id.as_deref(), Some("msg-3"));
        assert_eq!(detail.newest_item_id.as_deref(), Some("msg-4"));
        assert!(detail.is_partial);
    }

    #[test]
    fn thread_detail_window_returns_previous_page_and_metadata() {
        let items = vec![
            assistant_message("msg-1"),
            assistant_message("msg-2"),
            assistant_message("msg-3"),
            assistant_message("msg-4"),
            assistant_message("msg-5"),
        ];

        let detail = thread_detail_window(
            &items,
            &ThreadDetailRequest {
                workspace_id: "workspace-1".to_string(),
                thread_id: "thread-1".to_string(),
                mode: ThreadDetailMode::Before,
                limit: Some(2),
                before_item_id: Some("msg-4".to_string()),
            },
        )
        .unwrap();

        assert_eq!(
            detail
                .items
                .iter()
                .map(conversation_item_id)
                .collect::<Vec<_>>(),
            vec!["msg-2", "msg-3"]
        );
        assert!(detail.has_older);
        assert_eq!(detail.oldest_item_id.as_deref(), Some("msg-2"));
        assert_eq!(detail.newest_item_id.as_deref(), Some("msg-3"));
        assert!(detail.is_partial);
    }

    #[test]
    fn thread_detail_projects_stale_tools_with_the_thread_outcome() {
        let pending_file_change = || ConversationItem::FileChange {
            id: "patch-1".to_string(),
            changes: Vec::new(),
            status: "awaiting_approval".to_string(),
            lifecycle: falcondeck_core::ToolLifecycle::AwaitingApproval,
            created_at: Utc::now(),
            completed_at: None,
        };
        let settled_at = Utc::now();

        let mut failed_items = vec![pending_file_change()];
        settle_thread_detail_tool_items(&mut failed_items, &ThreadStatus::Error, settled_at);
        assert!(matches!(
            &failed_items[0],
            ConversationItem::FileChange {
                status,
                lifecycle: falcondeck_core::ToolLifecycle::Failed,
                completed_at: Some(completed_at),
                ..
            } if status == "failed" && *completed_at == settled_at
        ));

        let mut idle_items = vec![pending_file_change()];
        settle_thread_detail_tool_items(&mut idle_items, &ThreadStatus::Idle, settled_at);
        assert!(matches!(
            &idle_items[0],
            ConversationItem::FileChange {
                status,
                lifecycle: falcondeck_core::ToolLifecycle::Succeeded,
                ..
            } if status == "completed"
        ));

        let mut running_items = vec![pending_file_change()];
        settle_thread_detail_tool_items(&mut running_items, &ThreadStatus::Running, settled_at);
        assert!(matches!(
            &running_items[0],
            ConversationItem::FileChange {
                status,
                lifecycle: falcondeck_core::ToolLifecycle::AwaitingApproval,
                completed_at: None,
                ..
            } if status == "awaiting_approval"
        ));
    }

    #[test]
    fn codex_reconnect_backoff_doubles_up_to_sixteen_seconds() {
        assert_eq!(codex_reconnect_delay(0), Duration::from_secs(1));
        assert_eq!(codex_reconnect_delay(1), Duration::from_secs(2));
        assert_eq!(codex_reconnect_delay(2), Duration::from_secs(4));
        assert_eq!(codex_reconnect_delay(3), Duration::from_secs(8));
        assert_eq!(codex_reconnect_delay(4), Duration::from_secs(16));
    }

    #[tokio::test]
    async fn codex_reconnect_bails_out_when_workspace_is_gone() {
        let temp_dir = tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            temp_dir.path().join("daemon-state.json"),
        );

        let outcome = try_codex_reconnect(&app, "missing-workspace").await;
        assert!(matches!(outcome, CodexReconnectAttempt::WorkspaceGone));
    }

    #[tokio::test]
    async fn codex_reconnect_reports_failure_when_the_binary_is_missing() {
        let temp_dir = tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::from([(
                AgentProvider::CODEX,
                "definitely-missing-codex-binary".to_string(),
            )]),
            temp_dir.path().join("daemon-state.json"),
        );
        app.inner.workspaces.lock().await.insert(
            "workspace-1".to_string(),
            ManagedWorkspace {
                summary: WorkspaceSummary {
                    id: "workspace-1".to_string(),
                    path: temp_dir.path().to_string_lossy().to_string(),
                    status: WorkspaceStatus::Ready,
                    agents: Vec::new(),
                    skills: Vec::new(),
                    default_provider: AgentProvider::CODEX,
                    models: Vec::new(),
                    collaboration_modes: Vec::new(),
                    account: falcondeck_core::AccountSummary::default(),
                    current_thread_id: None,
                    connected_at: Utc::now(),
                    updated_at: Utc::now(),
                    last_error: None,
                },
                codex_session: None,
                claude_runtime: None,
                opencode_runtime: None,
                acp_runtimes: HashMap::new(),
                threads: HashMap::new(),
            },
        );

        let outcome = try_codex_reconnect(&app, "workspace-1").await;
        assert!(matches!(outcome, CodexReconnectAttempt::Failed(_)));
    }

    #[test]
    fn queued_attachment_previews_require_image_bytes() {
        assert_eq!(
            queued_attachment_preview_mime_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(
            queued_attachment_preview_mime_type(b"\xff\xd8\xffrest"),
            Some("image/jpeg")
        );
        assert_eq!(queued_attachment_preview_mime_type(b"not an image"), None);
    }
}

pub(crate) fn queued_attachment_preview_mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some("image/tiff")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(
            &bytes[8..12],
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1"
        )
    {
        Some("image/heic")
    } else {
        None
    }
}
