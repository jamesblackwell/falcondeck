use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use falcondeck_core::{ImageInput, TurnInputItem};
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
    let CodexBootstrap {
        session: codex_session,
        account: codex_account,
        models: codex_models,
        collaboration_modes: codex_collaboration_modes,
        threads: codex_threads,
    } = CodexSession::connect(
        workspace_id.clone(),
        path_string.clone(),
        app.inner.codex_bin.clone(),
        app.clone(),
    )
    .await?;
    let ClaudeBootstrap {
        runtime: claude_runtime,
        account: claude_account,
        models: claude_models,
        collaboration_modes: claude_collaboration_modes,
        capabilities: claude_capabilities,
        threads: claude_threads,
    } = ClaudeRuntime::connect(path_string.clone(), app.inner.claude_bin.clone()).await?;
    let file_backed_skills = discover_file_backed_skills(&path_string);
    let codex_provider_skills = load_codex_provider_skills(app, &codex_session)
        .await
        .unwrap_or_default();
    let merged_skills = merge_skills(
        file_backed_skills
            .into_iter()
            .chain(codex_provider_skills)
            .collect(),
    );
    let codex_skills = skills_for_provider(&merged_skills, AgentProvider::Codex);
    let claude_skills = skills_for_provider(&merged_skills, AgentProvider::Claude);

    let now = Utc::now();
    let mut threads = codex_threads;
    threads.extend(claude_threads.into_iter().map(|mut thread| {
        thread.summary.workspace_id = workspace_id.clone();
        crate::codex::HydratedThread {
            summary: thread.summary,
            items: thread.items,
        }
    }));
    threads.sort_by(|left, right| right.summary.updated_at.cmp(&left.summary.updated_at));
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
                provider: state.provider.clone().unwrap_or(AgentProvider::Codex),
                native_session_id: state.native_session_id.clone(),
                status: restored_status,
                updated_at: now,
                last_message_preview: None,
                latest_turn_id: None,
                latest_plan: None,
                latest_diff: None,
                last_tool: None,
                last_error: restored_last_error,
                agent: ThreadAgentParams::default(),
                attention: ThreadAttention::default(),
                is_archived: false,
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
    let agents = vec![
        WorkspaceAgentSummary {
            provider: AgentProvider::Codex,
            account: codex_account.clone(),
            models: codex_models.clone(),
            collaboration_modes: codex_collaboration_modes.clone(),
            skills: codex_skills.clone(),
            supports_plan_mode: true,
            supports_native_plan_mode: true,
            capabilities: AgentCapabilitySummary {
                supports_review: true,
            },
        },
        WorkspaceAgentSummary {
            provider: AgentProvider::Claude,
            account: claude_account.clone(),
            models: claude_models.clone(),
            collaboration_modes: claude_collaboration_modes.clone(),
            skills: claude_skills.clone(),
            supports_plan_mode: true,
            supports_native_plan_mode: true,
            capabilities: claude_capabilities,
        },
    ];
    let default_provider = persisted_workspace_ref
        .and_then(|workspace| workspace.default_provider.clone())
        .unwrap_or(AgentProvider::Codex);
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
        supports_plan_mode: true,
        supports_native_plan_mode: true,
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
            codex_session: Some(codex_session),
            claude_runtime: Some(claude_runtime),
            threads: threads
                .into_iter()
                .map(|mut thread| {
                    if persisted_workspace_ref
                        .map(|pw| pw.archived_thread_ids.contains(&thread.summary.id))
                        .unwrap_or(false)
                    {
                        thread.summary.is_archived = true;
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
    let (provider, supports_native_plan_mode, default_model_id) = {
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
            agent
                .as_ref()
                .map(|agent| agent.supports_native_plan_mode)
                .unwrap_or(workspace.summary.supports_native_plan_mode),
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
    let (thread_id, title, native_session_id) = match provider {
        AgentProvider::Codex => {
            let session = app.session_for(&request.workspace_id).await?;
            let workspace_path = session.workspace_path().to_string();
            let result = session
                .send_request(
                    "thread/start",
                    json!({
                        "cwd": workspace_path,
                        "model": model_id,
                        "collaborationMode": collaboration_mode_payload(
                            request.collaboration_mode_id.as_deref(),
                            model_id.as_deref(),
                            None,
                            supports_native_plan_mode,
                        ),
                        "approvalPolicy": approval_policy
                    }),
                )
                .await?;
            (
                extract_thread_id(&result).ok_or_else(|| {
                    DaemonError::Rpc("thread/start did not return a thread id".to_string())
                })?,
                extract_thread_title(&result).unwrap_or_else(|| "New thread".to_string()),
                extract_thread_id(&result),
            )
        }
        AgentProvider::Claude => (
            format!("claude-thread-{}", Uuid::new_v4().simple()),
            "New Claude thread".to_string(),
            None,
        ),
    };
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
            collaboration_mode_id: request.collaboration_mode_id,
            approval_policy: Some(approval_policy),
            service_tier: None,
        },
        attention: ThreadAttention::default(),
        is_archived: false,
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

pub(super) async fn send_turn(
    app: &AppState,
    request: SendTurnRequest,
) -> Result<CommandResponse, DaemonError> {
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
    let approval_policy = request
        .approval_policy
        .unwrap_or_else(|| "on-request".to_string());

    let user_message = build_user_message_item(&inputs);
    let (thread, requires_resume, use_plan_mode_shim, provider, selected_skills) = {
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
        managed.summary.agent.collaboration_mode_id = request
            .collaboration_mode_id
            .clone()
            .or(managed.summary.agent.collaboration_mode_id.clone());
        managed.summary.agent.approval_policy = Some(approval_policy.clone());
        managed.summary.agent.service_tier = request.service_tier.clone().or(managed
            .summary
            .agent
            .service_tier
            .clone());
        let use_plan_mode_shim = should_use_plan_mode_shim(
            &workspace.summary,
            &provider,
            request.collaboration_mode_id.as_deref(),
        );
        let selected_skills = resolve_selected_skills(
            &workspace.summary.skills,
            &request.selected_skills,
            &provider,
        );
        if !managed.manual_title
            && !managed.ai_title_generated
            && is_placeholder_thread_title(&managed.summary.title)
        {
            if let Some(title) = provisional_thread_title_from_inputs(&inputs) {
                managed.summary.title = title;
            }
        }
        managed.summary.updated_at = now;
        workspace.summary.current_thread_id = Some(managed.summary.id.clone());
        workspace.summary.default_provider = provider.clone();
        workspace.summary.updated_at = now;
        (
            managed.summary.clone(),
            managed.requires_resume,
            use_plan_mode_shim,
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

    let start_result: Result<(), DaemonError> = match provider {
        AgentProvider::Codex => {
            let session = app.session_for(&request.workspace_id).await?;
            let workspace_path = session.workspace_path().to_string();
            if requires_resume {
                session.resume_thread(&request.thread_id).await?;
                let mut workspaces = app.inner.workspaces.lock().await;
                if let Some(workspace) = workspaces.get_mut(&request.workspace_id) {
                    if let Some(thread) = workspace.threads.get_mut(&request.thread_id) {
                        thread.requires_resume = false;
                    }
                }
            }

            session
                .send_request(
                    "turn/start",
                    json!({
                        "threadId": request.thread_id,
                        "input": codex_inputs_with_plan_mode_shim(&inputs, &selected_skills, use_plan_mode_shim),
                        "cwd": workspace_path,
                        "model": request.model_id,
                        "effort": request.reasoning_effort,
                        "collaborationMode": collaboration_mode_payload(
                            request.collaboration_mode_id.as_deref(),
                            request.model_id.as_deref(),
                            request.reasoning_effort.as_deref(),
                            !use_plan_mode_shim,
                        ),
                        "approvalPolicy": approval_policy,
                        "serviceTier": request.service_tier
                    }),
                )
                .await?;
            Ok(())
        }
        AgentProvider::Claude => {
            let runtime = app.claude_runtime_for(&request.workspace_id).await?;
            let session_id = thread.native_session_id.clone();
            let spawn = runtime
                .spawn_turn(
                    &request.thread_id,
                    session_id.as_deref(),
                    &claude_prompt_from_inputs(&inputs, &selected_skills),
                    thread.agent.model_id.as_deref(),
                    thread.agent.reasoning_effort.as_deref(),
                    is_claude_plan_mode(thread.agent.collaboration_mode_id.as_deref()),
                )
                .await?;
            app.with_thread_mut(&request.workspace_id, &request.thread_id, |thread| {
                thread.native_session_id = Some(spawn.session_id.clone());
            })
            .await?;
            let app = app.clone();
            let workspace_id = request.workspace_id.clone();
            let thread_id = request.thread_id.clone();
            tokio::spawn(async move {
                app.monitor_claude_turn(
                    workspace_id,
                    thread_id,
                    spawn.session_id,
                    spawn.stdout,
                    spawn.stderr,
                )
                .await;
            });
            Ok(())
        }
    };

    if let Err(error) = start_result {
        let error_message = error.to_string();
        let _ = app
            .with_thread_mut(&request.workspace_id, &request.thread_id, |thread| {
                thread.status = ThreadStatus::Error;
                thread.last_error = Some(error_message.clone());
                thread.updated_at = Utc::now();
            })
            .await;
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

        if let Some(provider) = request.provider.clone() {
            if provider != thread.summary.provider {
                return Err(DaemonError::BadRequest(
                    "threads are permanently bound to their original provider".to_string(),
                ));
            }
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

        thread.summary.agent.model_id = request.model_id.clone();
        thread.summary.agent.reasoning_effort = request.reasoning_effort.clone();
        thread.summary.agent.collaboration_mode_id = request.collaboration_mode_id.clone();
        thread.summary.updated_at = now;
        workspace.summary.current_thread_id = Some(request.thread_id.clone());
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

pub(super) async fn start_review(
    app: &AppState,
    request: StartReviewRequest,
) -> Result<CommandResponse, DaemonError> {
    let provider = app
        .thread_provider(&request.workspace_id, &request.thread_id)
        .await?;
    if provider != AgentProvider::Codex {
        return Err(DaemonError::BadRequest(
            "code review is only available for Codex threads in this milestone".to_string(),
        ));
    }
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
    if provider == AgentProvider::Claude {
        let runtime = app.claude_runtime_for(&workspace_id).await?;
        runtime.interrupt_turn(&thread_id).await?;
        return Ok(CommandResponse {
            ok: true,
            message: Some("interrupt requested".to_string()),
        });
    }

    let session = app.session_for(&workspace_id).await?;
    let turn_id = {
        let workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        workspace
            .threads
            .get(&thread_id)
            .and_then(|thread| thread.summary.latest_turn_id.clone())
            .ok_or_else(|| DaemonError::BadRequest("no active turn to interrupt".to_string()))?
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

    Ok(CommandResponse {
        ok: true,
        message: Some("interrupt requested".to_string()),
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
    if let Some(thread_id) = pending.request.thread_id.as_deref() {
        let provider = app.thread_provider(&workspace_id, thread_id).await?;
        if provider != AgentProvider::Codex {
            return Err(DaemonError::BadRequest(
                "Claude interactive requests are not yet routable through FalconDeck".to_string(),
            ));
        }
    }
    let session = app.session_for(&workspace_id).await?;

    let result = match (&pending.request.kind, response) {
        (InteractiveRequestKind::Approval, InteractiveResponsePayload::Approval { decision }) => {
            let decision = match decision {
                ApprovalDecision::Allow => "allow",
                ApprovalDecision::Deny => "deny",
                ApprovalDecision::AlwaysAllow => "always_allow",
            };
            json!({
                "decision": decision,
                "acceptSettings": {"forSession": true}
            })
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
            thread.status = ThreadStatus::Running;
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
    let codex_skills = skills_for_provider(&merged_skills, AgentProvider::Codex);
    let claude_skills = skills_for_provider(&merged_skills, AgentProvider::Claude);

    let summary = {
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        workspace.summary.skills = merged_skills;

        if let Some(metadata) = codex_metadata {
            update_workspace_agent_summary(
                &mut workspace.summary.agents,
                AgentProvider::Codex,
                metadata,
                codex_skills,
            );
        }
        if let Some(metadata) = claude_metadata {
            update_workspace_agent_summary(
                &mut workspace.summary.agents,
                AgentProvider::Claude,
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

pub(super) async fn thread_detail(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
) -> Result<ThreadDetail, DaemonError> {
    let workspaces = app.inner.workspaces.lock().await;
    let workspace = workspaces
        .get(workspace_id)
        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
    let thread = workspace
        .threads
        .get(thread_id)
        .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
    let workspace_summary = workspace.summary.clone();
    let thread_summary = thread.summary.clone();
    let items = thread.items.clone();
    drop(workspaces);

    Ok(ThreadDetail {
        workspace: workspace_summary,
        thread: app.build_thread_summary_from_clone(thread_summary).await,
        items,
    })
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
    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn materializes_data_url_images_into_durable_local_files() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let app = AppState::new_with_state_path(
            "0.1.0".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            state_path,
        );
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
                "codex".to_string(),
                "claude".to_string(),
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
        let app = AppState::new_with_state_path(
            "0.1.0".to_string(),
            "codex".to_string(),
            "claude".to_string(),
            state_path,
        );
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
}
