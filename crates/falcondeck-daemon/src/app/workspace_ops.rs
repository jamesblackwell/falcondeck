use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use falcondeck_core::{
    ConversationItem, ImageInput, SetThreadGoalRequest, ThreadDetail, ThreadDetailMode,
    ThreadDetailRequest, ThreadGoal, TurnInputItem,
};
use uuid::Uuid;

use super::*;

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
                        return refresh_connected_workspace_metadata(app, &existing_id).await;
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
    let workspace_id =
        existing_workspace_id.unwrap_or_else(|| format!("workspace-{}", Uuid::new_v4().simple()));
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
            }) => (Some(session), account, models, collaboration_modes, threads),
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
                let _ = app.emit_service(
                    Some(workspace_id.clone()),
                    None,
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
    for state in persisted_thread_states.values() {
        if threads
            .iter()
            .any(|thread| thread.summary.id == state.thread_id)
        {
            continue;
        }
        let restored_status = match state.status.clone().unwrap_or(ThreadStatus::Idle) {
            ThreadStatus::Running => ThreadStatus::Error,
            other => other,
        };
        let restored_last_error = state.last_error.clone().or_else(|| {
            matches!(state.status, Some(ThreadStatus::Running))
                .then(|| "FalconDeck was closed while this turn was running".to_string())
        });
        threads.push(crate::codex::HydratedThread {
            summary: ThreadSummary {
                id: state.thread_id.clone(),
                workspace_id: workspace_id.clone(),
                title: state
                    .title
                    .clone()
                    .unwrap_or_else(|| "Restored thread".to_string()),
                provider: state.provider.clone().unwrap_or(AgentProvider::CODEX),
                native_session_id: state.native_session_id.clone(),
                status: restored_status,
                updated_at: state
                    .updated_at
                    .or_else(|| persisted_workspace_ref.and_then(|workspace| workspace.updated_at))
                    .unwrap_or(now),
                last_message_preview: None,
                latest_turn_id: None,
                latest_plan: None,
                latest_diff: None,
                last_tool: None,
                last_error: restored_last_error,
                agent: ThreadAgentParams::default(),
                attention: ThreadAttention::default(),
                is_archived: false,
                is_pinned: false,
                goal: None,
                queued_turns: Vec::new(),
            },
            items: Vec::new(),
        });
    }
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

    app.inner.workspaces.lock().await.insert(
        workspace_id.clone(),
        ManagedWorkspace {
            summary: summary.clone(),
            codex_session,
            claude_runtime: Some(claude_runtime),
            acp_runtimes: HashMap::new(),
            threads: threads
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
                        thread.summary.attention.last_read_seq = state.last_read_seq;
                        thread.summary.attention.last_agent_activity_seq =
                            state.last_agent_activity_seq;
                    }
                    (thread.summary.id.clone(), {
                        let mut managed = ManagedThread::with_items(thread.summary, thread.items);
                        if let Some(state) = persisted_thread_states.get(&managed.summary.id) {
                            managed.manual_title = state.manual_title;
                            // A rename made in FalconDeck outlives whatever the
                            // provider's session file says the title is.
                            if state.manual_title
                                && let Some(title) = state.title.clone()
                            {
                                managed.summary.title = title;
                            }
                            managed.ai_title_generated = state.ai_title_generated
                                || (!is_placeholder_thread_title(&managed.summary.title)
                                    && !is_provisional_thread_title(&managed.summary.title));
                        }
                        managed
                    })
                })
                .collect(),
        },
    );
    app.inner.saved_workspaces.lock().await.insert(
        path_string,
        persisted_workspace_ref
            .cloned()
            .unwrap_or(PersistedWorkspaceState {
                path: summary.path.clone(),
                current_thread_id: summary.current_thread_id.clone(),
                updated_at: Some(summary.updated_at),
                default_provider: Some(summary.default_provider.clone()),
                last_error: None,
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
                thread_states: Vec::new(),
            }),
    );

    app.emit(
        Some(workspace_id.clone()),
        None,
        UnifiedEvent::Snapshot {
            snapshot: app.snapshot().await,
        },
    );

    app.persist_local_state().await?;

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

pub(super) async fn start_thread(
    app: &AppState,
    request: StartThreadRequest,
) -> Result<ThreadHandle, DaemonError> {
    let (provider, default_model_id) = {
        let workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let provider = request
            .provider
            .clone()
            .unwrap_or_else(|| workspace.summary.default_provider.clone());
        let agent = workspace
            .summary
            .agents
            .iter()
            .find(|agent| agent.provider == provider)
            .cloned();
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
        )
    };
    let approval_policy = request
        .approval_policy
        .unwrap_or_else(|| "on-request".to_string());
    let model_id = request.model_id.clone().or(default_model_id);
    let StartedThread {
        thread_id,
        title,
        native_session_id,
    } = ProviderRuntime::for_provider(&provider)
        .start_thread(
            app,
            StartThreadSpec {
                workspace_id: &request.workspace_id,
                model_id: model_id.as_deref(),
                sandbox_mode: request.sandbox_mode.as_deref(),
                approval_policy: &approval_policy,
            },
        )
        .await?;
    let now = Utc::now();

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
            collaboration_mode_id: None,
            approval_policy: Some(approval_policy),
            service_tier: None,
            permission_mode: request.permission_mode,
            sandbox_mode: request.sandbox_mode,
        },
        attention: ThreadAttention::default(),
        is_archived: false,
        is_pinned: false,
        goal: None,
        queued_turns: Vec::new(),
    };
    workspace.summary.current_thread_id = Some(thread_id.clone());
    workspace.summary.default_provider = provider;
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

    for input in inputs {
        match input {
            TurnInputItem::Text { .. } => normalized.push(input.clone()),
            TurnInputItem::Image(image) => normalized.push(TurnInputItem::Image(
                normalize_image_input(app, workspace_id, thread_id, image).await?,
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
) -> Result<ImageInput, DaemonError> {
    let image_url = image.url.trim();

    if let Some(local_path) = image
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let mut normalized = image.clone();
        normalized.url = compact_image_reference_url(image, local_path);
        return Ok(normalized);
    }

    if image_url.starts_with("data:") {
        let local_path =
            persist_inline_image_attachment(app, workspace_id, thread_id, image).await?;
        let mut normalized = image.clone();
        normalized.url = local_path.clone();
        normalized.local_path = Some(local_path);
        return Ok(normalized);
    }

    if Path::new(image_url).is_absolute() {
        let mut normalized = image.clone();
        normalized.local_path = Some(image_url.to_string());
        normalized.url = image_url.to_string();
        return Ok(normalized);
    }

    Ok(image.clone())
}

async fn persist_inline_image_attachment(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    image: &ImageInput,
) -> Result<String, DaemonError> {
    let parsed = parse_image_data_url(&image.url)?;
    let extension = image_file_extension(
        image.name.as_deref(),
        image.mime_type.as_deref(),
        &parsed.media_type,
    );
    let attachments_root = app
        .inner
        .state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("attachments")
        .join(sanitized_attachment_path_segment(workspace_id, "workspace"))
        .join(sanitized_attachment_path_segment(thread_id, "thread"));
    tokio::fs::create_dir_all(&attachments_root).await?;

    let file_path = attachments_root.join(format!(
        "{}.{}",
        sanitized_attachment_file_stem(&image.id),
        extension
    ));
    tokio::fs::write(&file_path, parsed.bytes).await?;

    Ok(file_path.to_string_lossy().to_string())
}

struct ParsedImageDataUrl {
    media_type: String,
    bytes: Vec<u8>,
}

fn parse_image_data_url(url: &str) -> Result<ParsedImageDataUrl, DaemonError> {
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

    let bytes = BASE64.decode(encoded).map_err(|error| {
        DaemonError::BadRequest(format!("invalid image attachment base64 payload: {error}"))
    })?;

    Ok(ParsedImageDataUrl { media_type, bytes })
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
    matches!(status, ThreadStatus::Running | ThreadStatus::WaitingForInput)
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
        workspaces
            .get(&request.workspace_id)
            .and_then(|workspace| {
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

    ProviderRuntime::for_provider(&provider)
        .steer(
            app,
            TurnSpec {
                workspace_id: &request.workspace_id,
                thread_id: &request.thread_id,
                thread: &thread,
                inputs: normalized_inputs,
                selected_skills: &selected_skills,
                approval_policy: request
                    .approval_policy
                    .as_deref()
                    .unwrap_or("on-request"),
                requested_model_id: request.model_id.as_deref(),
                requested_reasoning_effort: request.reasoning_effort.as_deref(),
                service_tier: request.service_tier.as_deref(),
                requires_resume: false,
            },
        )
        .await?;

    // Appended only once the message is actually in the agent's input: a
    // transcript entry for a write that failed would be a lie.
    app.push_conversation_item(
        &request.workspace_id,
        &request.thread_id,
        build_user_message_item(normalized_inputs),
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
        let preview = normalized_inputs
            .iter()
            .find_map(|input| match input {
                TurnInputItem::Text { text, .. } => Some(text.trim()),
                TurnInputItem::Image(_) => None,
            })
            .unwrap_or("")
            .chars()
            .take(140)
            .collect::<String>();
        let attachment_count = normalized_inputs
            .iter()
            .filter(|input| matches!(input, TurnInputItem::Image(_)))
            .count();
        let mut stored = request.clone();
        stored.inputs = normalized_inputs.to_vec();
        thread.queued_requests.push(super::QueuedTurnRequest {
            id: id.clone(),
            request: stored,
        });
        thread
            .summary
            .queued_turns
            .push(falcondeck_core::QueuedTurnSummary {
                id,
                preview,
                attachment_count,
                queued_at: Utc::now(),
            });
        thread.summary.updated_at = Utc::now();
        thread.summary.clone()
    };
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
                {
                    return;
                }
                let next = thread.queued_requests.remove(0);
                thread
                    .summary
                    .queued_turns
                    .retain(|queued| queued.id != next.id);
                thread.summary.updated_at = Utc::now();
                (next, thread.summary.clone())
            };
            let (next, summary) = next;
            app.emit(
                Some(workspace_id.clone()),
                Some(thread_id.clone()),
                UnifiedEvent::ThreadUpdated { thread: summary },
            );
            if let Err(error) = send_turn(&app, next.request).await {
                // send_turn already marked the thread Error and emitted; the
                // failure path below dispatches the next queued turn in line.
                tracing::warn!(%error, thread = %thread_id, "queued turn failed to dispatch");
            }
        });
    }
}

pub(super) async fn send_turn(
    app: &AppState,
    request: SendTurnRequest,
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

    let approval_policy = request
        .approval_policy
        .unwrap_or_else(|| "on-request".to_string());

    let user_message = build_user_message_item(&inputs);
    let (thread, requires_resume, provider, selected_skills) = {
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
                })
            });
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
        managed.summary.agent.permission_mode = request.permission_mode.clone().or(managed
            .summary
            .agent
            .permission_mode
            .clone());
        managed.summary.agent.sandbox_mode = request.sandbox_mode.clone().or(managed
            .summary
            .agent
            .sandbox_mode
            .clone());
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
        (
            managed.summary.clone(),
            managed.requires_resume,
            provider,
            selected_skills,
        )
    };
    app.push_conversation_item(
        &request.workspace_id,
        &request.thread_id,
        user_message.clone(),
        false,
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
                requires_resume,
            },
        )
        .await;

    if let Err(error) = start_result {
        let error_message = error.to_string();
        let _ = app
            .with_thread_mut(&request.workspace_id, &request.thread_id, |thread| {
                thread.status = ThreadStatus::Error;
                thread.last_error = Some(error_message.clone());
                thread.updated_at = Utc::now();
            })
            .await;
        // A failed start must not strand messages queued behind it.
        app.dispatch_next_queued_turn(&request.workspace_id, &request.thread_id);
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
        }

        if let Some(model_id) = request.model_id.clone() {
            thread.summary.agent.model_id = model_id;
        }
        if let Some(reasoning_effort) = request.reasoning_effort.clone() {
            thread.summary.agent.reasoning_effort = reasoning_effort;
        }
        if let Some(pinned) = request.pinned {
            thread.summary.is_pinned = pinned;
        }
        if let Some(permission_mode) = request.permission_mode.clone() {
            thread.summary.agent.permission_mode =
                permission_mode.filter(|mode| !mode.eq_ignore_ascii_case("default"));
        }
        if let Some(sandbox_mode) = request.sandbox_mode.clone() {
            thread.summary.agent.sandbox_mode = sandbox_mode;
        }
        // Pin toggles must not bump recency: updated_at drives the sidebar
        // sort, and unpinning a stale thread should return it to its place.
        let is_pin_only_update = request.title.is_none()
            && request.model_id.is_none()
            && request.reasoning_effort.is_none()
            && request.permission_mode.is_none()
            && request.sandbox_mode.is_none()
            && request.pinned.is_some();
        if !is_pin_only_update {
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
    let decision = match decision {
        ApprovalDecision::Allow => "accept",
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
    for (_, runtime) in removed.acp_runtimes {
        runtime.shutdown().await;
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

pub(super) async fn respond_to_interactive_request(
    app: &AppState,
    workspace_id: String,
    request_id: String,
    response: InteractiveResponsePayload,
) -> Result<CommandResponse, DaemonError> {
    let pending = {
        let requests = app.inner.interactive_requests.lock().await;
        requests
            .get(&(workspace_id.clone(), request_id.clone()))
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("interactive request not found".to_string()))?
    };
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
            app.with_thread_mut(&workspace_id, &thread_id, |thread| {
                // Only revive threads that are actually waiting on this
                // approval; the turn may have died in the meantime and
                // forcing Running back would leave a permanent spinner.
                if matches!(thread.status, ThreadStatus::WaitingForInput) {
                    thread.status = ThreadStatus::Running;
                }
            })
            .await?;
            app.resolve_interactive_request_item(&workspace_id, &thread_id, &request_id)
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
        app.respond_acp_permission(
            &workspace_id,
            pending.request.thread_id.as_deref(),
            &request_id,
            decision,
        )
        .await?;
        app.inner
            .interactive_requests
            .lock()
            .await
            .remove(&request_key);
        if let Some(thread_id) = pending.request.thread_id {
            app.with_thread_mut(&workspace_id, &thread_id, |thread| {
                if matches!(thread.status, ThreadStatus::WaitingForInput) {
                    thread.status = ThreadStatus::Running;
                }
            })
            .await?;
            app.resolve_interactive_request_item(&workspace_id, &thread_id, &request_id)
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
    };

    session.respond_to_request(pending.raw_id, result).await?;

    app.inner
        .interactive_requests
        .lock()
        .await
        .remove(&(workspace_id.clone(), request_id.clone()));

    if let Some(thread_id) = pending.request.thread_id {
        app.with_thread_mut(&workspace_id, &thread_id, |thread| {
            // See the Claude branch above: never force Running onto a thread
            // whose turn already ended.
            if matches!(thread.status, ThreadStatus::WaitingForInput) {
                thread.status = ThreadStatus::Running;
            }
        })
        .await?;
        app.resolve_interactive_request_item(&workspace_id, &thread_id, &request_id)
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
                let _ = app.emit_service(
                    Some(workspace_id.to_string()),
                    None,
                    falcondeck_core::ServiceLevel::Info,
                    "Codex reconnected".to_string(),
                    Some("codex-reconnect".to_string()),
                );
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
    let _ = app.emit_service(
        Some(workspace_id.to_string()),
        None,
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
    let detail = thread_detail_window(&thread.items, request)?;
    drop(workspaces);

    Ok(ThreadDetail {
        workspace: workspace_summary,
        thread: app.build_thread_summary_from_clone(thread_summary).await,
        items: detail.items,
        has_older: detail.has_older,
        oldest_item_id: detail.oldest_item_id,
        newest_item_id: detail.newest_item_id,
        is_partial: detail.is_partial,
    })
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

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use tempfile::tempdir;

    use super::*;

    fn assistant_message(id: &str) -> ConversationItem {
        ConversationItem::AssistantMessage {
            id: id.to_string(),
            text: format!("message {id}"),
            created_at: Utc::now(),
        }
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
        let image = ImageInput {
            id: "img-1".to_string(),
            name: Some("diagram.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: "data:image/png;base64,aGVsbG8=".to_string(),
            local_path: Some("/tmp/diagram.png".to_string()),
        };

        let normalized = normalize_image_input(
            &AppState::new_with_state_path(
                "0.1.0".to_string(),
                HashMap::new(),
                Path::new("/tmp/falcondeck-daemon-state.json").to_path_buf(),
            ),
            "workspace-1",
            "thread-1",
            &image,
        )
        .await
        .unwrap();

        assert_eq!(normalized.url, "/tmp/diagram.png");
        assert_eq!(normalized.local_path.as_deref(), Some("/tmp/diagram.png"));
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

        let local_path =
            persist_inline_image_attachment(&app, "../../workspace", "../../thread", &image)
                .await
                .unwrap();

        assert!(Path::new(&local_path).starts_with(temp_dir.path().join("attachments")));
        assert!(!local_path.contains("../"));
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
                acp_runtimes: HashMap::new(),
                threads: HashMap::new(),
            },
        );

        let outcome = try_codex_reconnect(&app, "workspace-1").await;
        assert!(matches!(outcome, CodexReconnectAttempt::Failed(_)));
    }
}
