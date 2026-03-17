use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use chrono::Utc;
use falcondeck_core::{
    ApprovalDecision, CollaborationModeSummary, CommandResponse,
    ConnectWorkspaceRequest, ConversationItem, DaemonInfo, DaemonSnapshot, EncryptedEnvelope,
    EventEnvelope, HealthResponse, PairingPublicKeyBundle, PairingStatusResponse,
    RelayClientMessage, RelayServerMessage, RelayUpdateBody, RemoteConnectionStatus,
    RemotePairingSession, RemoteStatusResponse, SendTurnRequest, ServiceLevel, SessionKeyMaterial,
    StartPairingRequest, StartPairingResponse, StartRemotePairingRequest, StartReviewRequest, StartThreadRequest,
    ThreadCodexParams, ThreadDetail, ThreadHandle, ThreadStatus, ThreadSummary, TurnInputItem,
    UnifiedEvent, UpdateThreadRequest, WorkspaceStatus, WorkspaceSummary, InteractiveQuestion,
    InteractiveQuestionOption, InteractiveRequest, InteractiveRequestKind, InteractiveResponsePayload,
    crypto::{LocalBoxKeyPair, decrypt_json, encrypt_json, generate_data_key},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    fs,
    sync::{Mutex, broadcast},
    task::JoinHandle,
    time::{Duration, sleep},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::debug;
use uuid::Uuid;

use crate::{
    codex::{
        CodexBootstrap, CodexSession, extract_string, extract_thread_id, extract_thread_title,
        parse_account, parse_thread_plan,
    },
    error::DaemonError,
};

#[derive(Clone)]
pub struct AppState {
    inner: Arc<InnerState>,
}

struct InnerState {
    daemon: DaemonInfo,
    codex_bin: String,
    state_path: PathBuf,
    sequence: AtomicU64,
    broadcaster: broadcast::Sender<EventEnvelope>,
    workspaces: Mutex<HashMap<String, ManagedWorkspace>>,
    interactive_requests: Mutex<HashMap<(String, String), PendingServerRequest>>,
    remote: Mutex<RemoteBridgeState>,
}

struct ManagedWorkspace {
    summary: WorkspaceSummary,
    session: Arc<CodexSession>,
    collaboration_modes: Vec<CollaborationModeSummary>,
    threads: HashMap<String, ManagedThread>,
}

struct ManagedThread {
    summary: ThreadSummary,
    items: Vec<ConversationItem>,
    assistant_items: HashMap<String, usize>,
    reasoning_items: HashMap<String, usize>,
    tool_items: HashMap<String, usize>,
    requires_resume: bool,
}

#[derive(Clone)]
struct PendingServerRequest {
    raw_id: Value,
    request: InteractiveRequest,
}

struct RemoteBridgeState {
    status: RemoteConnectionStatus,
    relay_url: Option<String>,
    pairing: Option<RemotePairingState>,
    daemon_token: Option<String>,
    last_error: Option<String>,
    task: Option<JoinHandle<()>>,
    pairing_watch_task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct RemotePairingState {
    pairing_id: String,
    pairing_code: String,
    session_id: Option<String>,
    device_id: Option<String>,
    trusted_at: Option<chrono::DateTime<Utc>>,
    expires_at: chrono::DateTime<Utc>,
    client_bundle: Option<PairingPublicKeyBundle>,
    local_key_pair: LocalBoxKeyPair,
    data_key: [u8; 32],
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
struct PersistedAppState {
    #[serde(default, deserialize_with = "deserialize_persisted_workspaces")]
    workspaces: Vec<PersistedWorkspaceState>,
    remote: Option<PersistedRemoteState>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct PersistedWorkspaceState {
    path: String,
    current_thread_id: Option<String>,
    updated_at: Option<chrono::DateTime<Utc>>,
    #[serde(default)]
    archived_thread_ids: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
enum PersistedWorkspaceEntry {
    LegacyPath(String),
    State(PersistedWorkspaceState),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedRemoteState {
    relay_url: String,
    daemon_token: String,
    pairing_id: String,
    pairing_code: String,
    session_id: Option<String>,
    device_id: Option<String>,
    trusted_at: Option<chrono::DateTime<Utc>>,
    expires_at: chrono::DateTime<Utc>,
    client_public_key: Option<String>,
    local_secret_key_base64: String,
    data_key_base64: String,
}

impl AppState {
    pub fn new(version: String, codex_bin: String) -> Self {
        Self::new_with_state_path(version, codex_bin, default_state_path())
    }

    pub fn new_with_state_path(version: String, codex_bin: String, state_path: PathBuf) -> Self {
        let (broadcaster, _) = broadcast::channel(512);
        Self {
            inner: Arc::new(InnerState {
                daemon: DaemonInfo {
                    version,
                    started_at: Utc::now(),
                },
                codex_bin,
                state_path,
                sequence: AtomicU64::new(1),
                broadcaster,
                workspaces: Mutex::new(HashMap::new()),
                interactive_requests: Mutex::new(HashMap::new()),
                remote: Mutex::new(RemoteBridgeState {
                    status: RemoteConnectionStatus::Inactive,
                    relay_url: None,
                    pairing: None,
                    daemon_token: None,
                    last_error: None,
                    task: None,
                    pairing_watch_task: None,
                }),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.inner.broadcaster.subscribe()
    }

    pub async fn restore_local_state(&self) -> Result<(), DaemonError> {
        let persisted = load_persisted_app_state(&self.inner.state_path).await?;
        for workspace in persisted.workspaces {
            if let Err(error) = self
                .connect_workspace_internal(
                    ConnectWorkspaceRequest {
                        path: workspace.path.clone(),
                    },
                    Some(&workspace),
                )
                .await
            {
                tracing::warn!("failed to restore workspace {}: {error}", workspace.path);
            }
        }

        if let Some(remote) = persisted.remote {
            if remote.device_id.is_none() && relay_url_looks_legacy_loopback(&remote.relay_url) {
                tracing::info!(
                    "skipping legacy loopback remote pairing {} for relay {}",
                    remote.pairing_id,
                    remote.relay_url
                );
                self.clear_remote_bridge_state().await;
                self.persist_local_state().await?;
            } else if remote.device_id.is_none() && remote.expires_at <= Utc::now() {
                tracing::info!(
                    "skipping expired persisted remote pairing {}",
                    remote.pairing_id
                );
                self.clear_remote_bridge_state().await;
                self.persist_local_state().await?;
            } else if let Err(error) = self.resume_remote_bridge(remote).await {
                tracing::warn!("failed to restore remote bridge: {error}");
            }
        }

        Ok(())
    }

    pub async fn health(&self) -> HealthResponse {
        let workspaces = self.inner.workspaces.lock().await.len();
        HealthResponse {
            ok: true,
            version: self.inner.daemon.version.clone(),
            workspaces,
        }
    }

    async fn clear_remote_bridge_state(&self) {
        let mut remote = self.inner.remote.lock().await;
        if let Some(task) = remote.task.take() {
            task.abort();
        }
        if let Some(task) = remote.pairing_watch_task.take() {
            task.abort();
        }
        remote.status = RemoteConnectionStatus::Inactive;
        remote.relay_url = None;
        remote.pairing = None;
        remote.daemon_token = None;
        remote.last_error = None;
    }

    pub async fn remote_status(&self) -> RemoteStatusResponse {
        let snapshot = {
            let remote = self.inner.remote.lock().await;
            (
                build_remote_status_response(&remote),
                remote.relay_url.clone(),
                remote
                    .pairing
                    .as_ref()
                    .and_then(|pairing| pairing.session_id.clone()),
                remote.daemon_token.clone(),
            )
        };

        let (mut status, relay_url, session_id, daemon_token) = snapshot;
        if let (Some(relay_url), Some(session_id), Some(daemon_token)) =
            (relay_url, session_id, daemon_token)
        {
            if let Ok(remote_status) = self
                .fetch_remote_status(&relay_url, &session_id, &daemon_token)
                .await
            {
                status.trusted_devices = remote_status.devices;
                status.presence = Some(remote_status.presence);
            }
        }

        status
    }

    pub async fn start_remote_pairing(
        &self,
        request: StartRemotePairingRequest,
    ) -> Result<RemoteStatusResponse, DaemonError> {
        let relay_url = normalize_relay_url(&request.relay_url)?;
        let existing_remote = {
            let remote = self.inner.remote.lock().await;
            let should_reuse_pending = remote.relay_url.as_deref() == Some(relay_url.as_str())
                && matches!(remote.status, RemoteConnectionStatus::PairingPending)
                && remote
                    .pairing
                    .as_ref()
                    .is_some_and(|pairing| pairing.expires_at > Utc::now());
            if should_reuse_pending {
                return Ok(build_remote_status_response(&remote));
            }
            if remote.relay_url.as_deref() == Some(relay_url.as_str()) {
                remote.pairing.clone().zip(remote.daemon_token.clone())
            } else {
                None
            }
        };

        {
            let remote = self.inner.remote.lock().await;
            if remote.relay_url.as_deref() == Some(relay_url.as_str())
                && matches!(
                    remote.status,
                    RemoteConnectionStatus::Revoked | RemoteConnectionStatus::Error
                )
            {
                drop(remote);
                self.clear_remote_bridge_state().await;
            }
        }
        let client = reqwest::Client::new();
        let (local_key_pair, data_key, existing_session_id, existing_daemon_token, seed_pairing) =
            if let Some((pairing, daemon_token)) = existing_remote {
                (
                    pairing.local_key_pair.clone(),
                    pairing.data_key,
                    pairing.session_id.clone(),
                    Some(daemon_token),
                    Some(pairing),
                )
            } else {
                (
                    LocalBoxKeyPair::generate(),
                    generate_data_key(),
                    None,
                    None,
                    None,
                )
            };
        let pairing = client
            .post(format!("{relay_url}/v1/pairings"))
            .json(&StartPairingRequest {
                label: Some(host_label()),
                ttl_seconds: Some(600),
                existing_session_id: existing_session_id.clone(),
                daemon_token: existing_daemon_token.clone(),
                daemon_bundle: Some(PairingPublicKeyBundle {
                    encryption_variant: falcondeck_core::EncryptionVariant::DataKeyV1,
                    public_key: local_key_pair.public_key_base64().to_string(),
                }),
            })
            .send()
            .await
            .map_err(|error| DaemonError::Rpc(format!("failed to contact relay: {error}")))?
            .error_for_status()
            .map_err(|error| DaemonError::Rpc(format!("relay pairing request failed: {error}")))?
            .json::<StartPairingResponse>()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to parse relay pairing response: {error}"))
            })?;

        let remote_pairing = if let Some(previous_pairing) = seed_pairing {
            RemotePairingState {
                pairing_id: pairing.pairing_id.clone(),
                pairing_code: pairing.pairing_code.clone(),
                session_id: Some(pairing.session_id.clone()),
                device_id: previous_pairing.device_id,
                trusted_at: previous_pairing.trusted_at,
                expires_at: pairing.expires_at,
                client_bundle: None,
                local_key_pair,
                data_key,
            }
        } else {
            RemotePairingState {
                pairing_id: pairing.pairing_id.clone(),
                pairing_code: pairing.pairing_code.clone(),
                session_id: Some(pairing.session_id.clone()),
                device_id: None,
                trusted_at: None,
                expires_at: pairing.expires_at,
                client_bundle: None,
                local_key_pair,
                data_key,
            }
        };

        let response = {
            let mut remote = self.inner.remote.lock().await;
            let additional_pairing = remote.task.is_some();
            if !additional_pairing {
                if let Some(task) = remote.task.take() {
                    task.abort();
                }
            }
            if let Some(task) = remote.pairing_watch_task.take() {
                task.abort();
            }
            if !additional_pairing {
                remote.status = RemoteConnectionStatus::PairingPending;
            }
            remote.relay_url = Some(relay_url.clone());
            remote.pairing = Some(remote_pairing.clone());
            remote.daemon_token = Some(pairing.daemon_token.clone());
            remote.last_error = None;

            if additional_pairing {
                let app = self.clone();
                let watch_task = tokio::spawn(async move {
                    app.watch_pairing_claim(relay_url, pairing.daemon_token, pairing.pairing_id)
                        .await;
                });
                remote.pairing_watch_task = Some(watch_task);
            } else {
                let app = self.clone();
                let task = tokio::spawn(async move {
                    app.run_remote_bridge(relay_url, pairing.daemon_token, remote_pairing)
                        .await;
                });
                remote.task = Some(task);
            }
            build_remote_status_response(&remote)
        };

        self.persist_local_state().await?;

        Ok(response)
    }

    pub async fn snapshot(&self) -> DaemonSnapshot {
        let workspaces = self.inner.workspaces.lock().await;
        let interactive_requests = self.inner.interactive_requests.lock().await;

        let mut workspace_list = workspaces
            .values()
            .map(|workspace| workspace.summary.clone())
            .collect::<Vec<_>>();
        workspace_list.sort_by(|left, right| left.path.cmp(&right.path));

        let mut threads = workspaces
            .values()
            .flat_map(|workspace| {
                workspace
                    .threads
                    .values()
                    .map(|thread| thread.summary.clone())
            })
            .collect::<Vec<_>>();
        threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

        let mut interactive_request_list = interactive_requests
            .values()
            .map(|request| request.request.clone())
            .collect::<Vec<_>>();
        interactive_request_list.sort_by(|left, right| right.created_at.cmp(&left.created_at));

        DaemonSnapshot {
            daemon: self.inner.daemon.clone(),
            workspaces: workspace_list,
            threads,
            interactive_requests: interactive_request_list,
        }
    }

    pub async fn connect_workspace(
        &self,
        request: ConnectWorkspaceRequest,
    ) -> Result<WorkspaceSummary, DaemonError> {
        self.connect_workspace_internal(request, None).await
    }

    async fn connect_workspace_internal(
        &self,
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

        {
            let mut workspaces = self.inner.workspaces.lock().await;
            if let Some(existing) = workspaces
                .values()
                .find(|workspace| workspace.summary.path == path_string)
            {
                let existing_summary = existing.summary.clone();
                let existing_id = existing_summary.id.clone();
                let preferred_thread_id = persisted_workspace
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
                    if let Some(updated_at) =
                        persisted_workspace.and_then(|workspace| workspace.updated_at)
                    {
                        workspace.summary.updated_at = updated_at;
                    }
                    let summary = workspace.summary.clone();
                    drop(workspaces);
                    self.persist_local_state().await?;
                    return Ok(summary);
                }
                return Ok(existing_summary);
            }
        }

        let workspace_id = format!("workspace-{}", Uuid::new_v4().simple());
        let CodexBootstrap {
            session,
            account,
            models,
            collaboration_modes,
            mut threads,
        } = CodexSession::connect(
            workspace_id.clone(),
            path_string.clone(),
            self.inner.codex_bin.clone(),
            self.clone(),
        )
        .await?;

        let now = Utc::now();
        threads.sort_by(|left, right| right.summary.updated_at.cmp(&left.summary.updated_at));
        let current_thread_id = persisted_workspace
            .and_then(|workspace| workspace.current_thread_id.as_deref())
            .and_then(|thread_id| {
                threads
                    .iter()
                    .find(|thread| thread.summary.id == thread_id)
                    .map(|thread| thread.summary.id.clone())
            })
            .or_else(|| threads.first().map(|thread| thread.summary.id.clone()));
        let summary = WorkspaceSummary {
            id: workspace_id.clone(),
            path: path_string,
            status: if matches!(account.status, falcondeck_core::AccountStatus::NeedsAuth) {
                WorkspaceStatus::NeedsAuth
            } else {
                WorkspaceStatus::Ready
            },
            models,
            collaboration_modes: collaboration_modes.clone(),
            account,
            current_thread_id,
            connected_at: now,
            updated_at: persisted_workspace
                .and_then(|workspace| workspace.updated_at)
                .unwrap_or(now),
            last_error: None,
        };

        self.inner.workspaces.lock().await.insert(
            workspace_id.clone(),
            ManagedWorkspace {
                summary: summary.clone(),
                session,
                collaboration_modes,
                threads: threads
                    .into_iter()
                    .map(|mut thread| {
                        if persisted_workspace
                            .map(|pw| pw.archived_thread_ids.contains(&thread.summary.id))
                            .unwrap_or(false)
                        {
                            thread.summary.is_archived = true;
                        }
                        (
                            thread.summary.id.clone(),
                            ManagedThread::with_items(thread.summary, thread.items),
                        )
                    })
                    .collect(),
            },
        );

        self.emit(
            Some(workspace_id),
            None,
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );

        self.persist_local_state().await?;

        Ok(summary)
    }

    pub async fn start_thread(
        &self,
        request: StartThreadRequest,
    ) -> Result<ThreadHandle, DaemonError> {
        let session = self.session_for(&request.workspace_id).await?;
        let workspace_path = session.workspace_path().to_string();
        let approval_policy = request
            .approval_policy
            .unwrap_or_else(|| "on-request".to_string());

        let result = session
            .send_request(
                "thread/start",
                json!({
                    "cwd": workspace_path,
                    "model": request.model_id,
                    "collaborationMode": request.collaboration_mode_id,
                    "approvalPolicy": approval_policy
                }),
            )
            .await?;
        let thread_id = extract_thread_id(&result).ok_or_else(|| {
            DaemonError::Rpc("thread/start did not return a thread id".to_string())
        })?;
        let title = extract_thread_title(&result).unwrap_or_else(|| "New thread".to_string());
        let now = Utc::now();

        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(&request.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = ThreadSummary {
            id: thread_id.clone(),
            workspace_id: request.workspace_id.clone(),
            title,
            status: ThreadStatus::Idle,
            updated_at: now,
            last_message_preview: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: None,
            last_tool: None,
            last_error: None,
            codex: ThreadCodexParams {
                model_id: request.model_id,
                reasoning_effort: None,
                collaboration_mode_id: request.collaboration_mode_id,
                approval_policy: Some(approval_policy),
                service_tier: None,
            },
            is_archived: false,
        };
        workspace.summary.current_thread_id = Some(thread_id.clone());
        workspace.summary.updated_at = now;
        workspace
            .threads
            .insert(thread_id.clone(), ManagedThread::new(thread.clone()));
        let workspace_summary = workspace.summary.clone();
        drop(workspaces);

        self.emit(
            Some(request.workspace_id),
            Some(thread_id),
            UnifiedEvent::ThreadStarted {
                thread: thread.clone(),
            },
        );

        Ok(ThreadHandle {
            workspace: workspace_summary,
            thread,
        })
    }

    pub async fn archive_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        thread.summary.is_archived = true;
        let summary = thread.summary.clone();
        drop(workspaces);
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );
        let _ = self.persist_local_state().await;
        Ok(summary)
    }

    pub async fn unarchive_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        thread.summary.is_archived = false;
        let summary = thread.summary.clone();
        drop(workspaces);
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );
        let _ = self.persist_local_state().await;
        Ok(summary)
    }

    pub async fn send_turn(
        &self,
        request: SendTurnRequest,
    ) -> Result<CommandResponse, DaemonError> {
        let session = self.session_for(&request.workspace_id).await?;
        let approval_policy = request
            .approval_policy
            .unwrap_or_else(|| "on-request".to_string());
        let workspace_path = session.workspace_path().to_string();

        let inputs = if request.inputs.is_empty() {
            return Err(DaemonError::BadRequest(
                "at least one input item is required".to_string(),
            ));
        } else {
            request.inputs.clone()
        };

        let user_message = build_user_message_item(&inputs);
        let (thread, requires_resume) = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get_mut(&request.workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let now = Utc::now();
            let managed = workspace
                .threads
                .entry(request.thread_id.clone())
                .or_insert_with(|| {
                    ManagedThread::new(ThreadSummary {
                        id: request.thread_id.clone(),
                        workspace_id: request.workspace_id.clone(),
                        title: "Untitled thread".to_string(),
                        status: ThreadStatus::Idle,
                        updated_at: now,
                        last_message_preview: None,
                        latest_turn_id: None,
                        latest_plan: None,
                        latest_diff: None,
                        last_tool: None,
                        last_error: None,
                        codex: ThreadCodexParams::default(),
                        is_archived: false,
                    })
                });
            managed.summary.status = ThreadStatus::Running;
            managed.summary.codex.model_id =
                request.model_id.clone().or(managed.summary.codex.model_id.clone());
            managed.summary.codex.reasoning_effort = request
                .reasoning_effort
                .clone()
                .or(managed.summary.codex.reasoning_effort.clone());
            managed.summary.codex.collaboration_mode_id = request
                .collaboration_mode_id
                .clone()
                .or(managed.summary.codex.collaboration_mode_id.clone());
            managed.summary.codex.approval_policy = Some(approval_policy.clone());
            managed.summary.codex.service_tier = request
                .service_tier
                .clone()
                .or(managed.summary.codex.service_tier.clone());
            managed.summary.updated_at = now;
            workspace.summary.current_thread_id = Some(managed.summary.id.clone());
            workspace.summary.updated_at = now;
            (managed.summary.clone(), managed.requires_resume)
        };
        self.push_conversation_item(
            &request.workspace_id,
            &request.thread_id,
            user_message.clone(),
            false,
        )
        .await?;
        self.emit(
            Some(request.workspace_id.clone()),
            Some(request.thread_id.clone()),
            UnifiedEvent::ThreadUpdated { thread },
        );

        if requires_resume {
            session.resume_thread(&request.thread_id).await?;
            let mut workspaces = self.inner.workspaces.lock().await;
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
                    "input": codex_inputs(&inputs),
                    "cwd": workspace_path,
                    "model": request.model_id,
                    "effort": request.reasoning_effort,
                    "collaborationMode": collaboration_mode_payload(
                        request.collaboration_mode_id.as_deref(),
                        request.model_id.as_deref(),
                        request.reasoning_effort.as_deref(),
                    ),
                    "approvalPolicy": approval_policy,
                    "serviceTier": request.service_tier
                }),
            )
            .await?;

        Ok(CommandResponse {
            ok: true,
            message: Some("turn started".to_string()),
        })
    }

    pub async fn update_thread(
        &self,
        request: UpdateThreadRequest,
    ) -> Result<ThreadHandle, DaemonError> {
        let (thread, workspace_summary) = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let workspace = workspaces
                .get_mut(&request.workspace_id)
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
            let thread = workspace
                .threads
                .get_mut(&request.thread_id)
                .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
            let now = Utc::now();

            thread.summary.codex.model_id = request.model_id.clone();
            thread.summary.codex.reasoning_effort = request.reasoning_effort.clone();
            thread.summary.codex.collaboration_mode_id = request.collaboration_mode_id.clone();
            thread.summary.updated_at = now;
            workspace.summary.current_thread_id = Some(request.thread_id.clone());
            workspace.summary.updated_at = now;

            (thread.summary.clone(), workspace.summary.clone())
        };

        self.emit(
            Some(request.workspace_id.clone()),
            Some(request.thread_id.clone()),
            UnifiedEvent::ThreadUpdated {
                thread: thread.clone(),
            },
        );

        Ok(ThreadHandle {
            workspace: workspace_summary,
            thread,
        })
    }

    pub async fn start_review(
        &self,
        request: StartReviewRequest,
    ) -> Result<CommandResponse, DaemonError> {
        let session = self.session_for(&request.workspace_id).await?;
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

    pub async fn interrupt_turn(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<CommandResponse, DaemonError> {
        let session = self.session_for(&workspace_id).await?;
        let turn_id = {
            let workspaces = self.inner.workspaces.lock().await;
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

    pub async fn respond_to_interactive_request(
        &self,
        workspace_id: String,
        request_id: String,
        response: InteractiveResponsePayload,
    ) -> Result<CommandResponse, DaemonError> {
        let session = self.session_for(&workspace_id).await?;
        let pending = self
            .inner
            .interactive_requests
            .lock()
            .await
            .remove(&(workspace_id.clone(), request_id.clone()))
            .ok_or_else(|| DaemonError::NotFound("interactive request not found".to_string()))?;

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
            (InteractiveRequestKind::Question, InteractiveResponsePayload::Question { answers }) => json!({
                "answers": answers
                    .into_iter()
                    .map(|(question_id, question_answers)| {
                        (question_id, json!({ "answers": question_answers }))
                    })
                    .collect::<serde_json::Map<String, Value>>()
            }),
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

        session
            .respond_to_request(pending.raw_id, result)
            .await?;

        if let Some(thread_id) = pending.request.thread_id {
            self.with_thread_mut(&workspace_id, &thread_id, |thread| {
                thread.status = ThreadStatus::Running;
            })
            .await?;
            self.resolve_interactive_request_item(&workspace_id, &thread_id, &request_id)
                .await?;
        }

        self.emit(
            Some(workspace_id),
            None,
            UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        );

        Ok(CommandResponse {
            ok: true,
            message: Some("response sent".to_string()),
        })
    }

    pub async fn collaboration_modes(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<CollaborationModeSummary>, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        Ok(workspace.collaboration_modes.clone())
    }

    pub async fn thread_detail(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadDetail, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;

        Ok(ThreadDetail {
            workspace: workspace.summary.clone(),
            thread: thread.summary.clone(),
            items: thread.items.clone(),
        })
    }

    async fn run_remote_bridge(
        &self,
        relay_url: String,
        daemon_token: String,
        pairing: RemotePairingState,
    ) {
        let mut backoff_seconds = 1u64;
        loop {
            let result = self
                .wait_for_claim_and_connect(
                    relay_url.clone(),
                    daemon_token.clone(),
                    pairing.clone(),
                )
                .await;
            match result {
                Ok(()) => {
                    backoff_seconds = 1;
                }
                Err(error) => {
                    let mut remote = self.inner.remote.lock().await;
                    let should_clear_pairing = remote.pairing.as_ref().is_some_and(|pairing| {
                        pairing.device_id.is_none() && pairing.expires_at <= Utc::now()
                    });
                    let revoked = error.contains("invalid session token")
                        || error.contains("session not found")
                        || error.contains("trusted device");
                    remote.status = if should_clear_pairing {
                        RemoteConnectionStatus::Inactive
                    } else if revoked {
                        RemoteConnectionStatus::Revoked
                    } else if backoff_seconds >= 8 {
                        RemoteConnectionStatus::Offline
                    } else {
                        RemoteConnectionStatus::Degraded
                    };
                    remote.last_error = Some(error);
                    if should_clear_pairing || revoked {
                        remote.relay_url = None;
                        remote.daemon_token = None;
                        remote.pairing = None;
                    }
                    drop(remote);
                    let _ = self.persist_local_state().await;
                    if should_clear_pairing || revoked {
                        break;
                    }
                    sleep(Duration::from_secs(backoff_seconds)).await;
                    backoff_seconds = (backoff_seconds * 2).min(16);
                }
            }
        }
    }

    async fn wait_for_claim_and_connect(
        &self,
        relay_url: String,
        daemon_token: String,
        pairing: RemotePairingState,
    ) -> Result<(), String> {
        // If we already have a trusted device with session + client key material,
        // skip polling the pairing endpoint entirely — the pairing may have expired
        // but the session is still valid.
        let (session_id, device_id, client_bundle) = if let (
            Some(session_id),
            Some(device_id),
            Some(client_bundle),
        ) = (
            pairing.session_id.clone(),
            pairing.device_id.clone(),
            pairing.client_bundle.clone(),
        ) {
            tracing::info!(
                "trusted device already present, skipping pairing poll (session={session_id}, device={device_id})"
            );
            (session_id, device_id, client_bundle)
        } else {
            // No trusted device yet — poll pairing status until claimed
            let client = reqwest::Client::new();
            loop {
                let response = client
                    .get(format!("{relay_url}/v1/pairings/{}", pairing.pairing_id))
                    .bearer_auth(&daemon_token)
                    .send()
                    .await
                    .map_err(|error| format!("failed to poll relay pairing: {error}"))?
                    .error_for_status()
                    .map_err(|error| format!("relay pairing status failed: {error}"))?
                    .json::<PairingStatusResponse>()
                    .await
                    .map_err(|error| format!("failed to parse relay pairing status: {error}"))?;

                if response.status == falcondeck_core::PairingStatus::Expired {
                    return Err("relay pairing expired before it was claimed".to_string());
                }

                {
                    let mut remote = self.inner.remote.lock().await;
                    if let Some(current_pairing) = remote.pairing.as_mut() {
                        current_pairing.session_id = response.session_id.clone();
                        current_pairing.device_id = response.device_id.clone();
                        current_pairing.client_bundle = response.client_bundle.clone();
                        if response.device_id.is_some() && current_pairing.trusted_at.is_none() {
                            current_pairing.trusted_at = Some(Utc::now());
                        }
                    }
                }

                if let (Some(session_id), Some(device_id)) =
                    (response.session_id, response.device_id)
                {
                    let client_bundle = response.client_bundle.ok_or_else(|| {
                        "relay pairing completed without client key material".to_string()
                    })?;
                    break (session_id, device_id, client_bundle);
                }

                {
                    let mut remote = self.inner.remote.lock().await;
                    remote.status = RemoteConnectionStatus::PairingPending;
                    remote.last_error = None;
                }
                sleep(Duration::from_secs(2)).await;
            }
        };

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::DeviceTrusted;
            if let Some(current_pairing) = remote.pairing.as_mut() {
                current_pairing.device_id = Some(device_id.clone());
                current_pairing.client_bundle = Some(client_bundle.clone());
                if current_pairing.trusted_at.is_none() {
                    current_pairing.trusted_at = Some(Utc::now());
                }
            }
            remote.last_error = None;
        }

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::Connecting;
            if let Some(current_pairing) = remote.pairing.as_mut() {
                current_pairing.session_id = Some(session_id.clone());
            }
            remote.last_error = None;
        }

        self.persist_local_state()
            .await
            .map_err(|error| format!("failed to persist remote pairing state: {error}"))?;

        self.connect_remote_session(relay_url, daemon_token, session_id, pairing, client_bundle)
            .await
    }

    async fn watch_pairing_claim(
        &self,
        relay_url: String,
        daemon_token: String,
        pairing_id: String,
    ) {
        let client = reqwest::Client::new();
        loop {
            let response = match client
                .get(format!("{relay_url}/v1/pairings/{pairing_id}"))
                .bearer_auth(&daemon_token)
                .send()
                .await
            {
                Ok(response) => match response.error_for_status() {
                    Ok(response) => match response.json::<PairingStatusResponse>().await {
                        Ok(payload) => payload,
                        Err(error) => {
                            self.set_pairing_watch_error(
                                &relay_url,
                                &daemon_token,
                                &pairing_id,
                                format!("failed to parse relay pairing status: {error}"),
                            )
                            .await;
                            sleep(Duration::from_secs(2)).await;
                            continue;
                        }
                    },
                    Err(error) => {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            format!("relay pairing status failed: {error}"),
                        )
                        .await;
                        sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                },
                Err(error) => {
                    self.set_pairing_watch_error(
                        &relay_url,
                        &daemon_token,
                        &pairing_id,
                        format!("failed to poll relay pairing: {error}"),
                    )
                    .await;
                    sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };

            if !self
                .pairing_watch_still_current(&relay_url, &daemon_token, &pairing_id)
                .await
            {
                return;
            }

            match response.status {
                falcondeck_core::PairingStatus::Pending => {
                    {
                        let mut remote = self.inner.remote.lock().await;
                        if let Some(current_pairing) = remote.pairing.as_mut() {
                            if current_pairing.pairing_id == pairing_id {
                                current_pairing.session_id = response.session_id.clone();
                                current_pairing.client_bundle = response.client_bundle.clone();
                            }
                        }
                        remote.last_error = None;
                    }
                    sleep(Duration::from_secs(2)).await;
                }
                falcondeck_core::PairingStatus::Expired => {
                    let should_persist = {
                        let mut remote = self.inner.remote.lock().await;
                        if remote.relay_url.as_deref() != Some(relay_url.as_str())
                            || remote.daemon_token.as_deref() != Some(daemon_token.as_str())
                        {
                            false
                        } else {
                            if let Some(current_pairing) = remote.pairing.as_ref() {
                                if current_pairing.pairing_id == pairing_id {
                                    remote.last_error = Some(
                                        "remote pairing expired before it was claimed".to_string(),
                                    );
                                }
                            }
                            remote.pairing_watch_task = None;
                            true
                        }
                    };
                    if should_persist {
                        let _ = self.persist_local_state().await;
                    }
                    return;
                }
                falcondeck_core::PairingStatus::Claimed => {
                    let Some(session_id) = response.session_id.clone() else {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            "relay pairing was claimed without a session id".to_string(),
                        )
                        .await;
                        return;
                    };
                    let Some(device_id) = response.device_id.clone() else {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            "relay pairing was claimed without a device id".to_string(),
                        )
                        .await;
                        return;
                    };
                    let Some(client_bundle) = response.client_bundle.clone() else {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            "relay pairing completed without client key material".to_string(),
                        )
                        .await;
                        return;
                    };

                    let restart =
                        {
                            let mut remote = self.inner.remote.lock().await;
                            if remote.relay_url.as_deref() != Some(relay_url.as_str())
                                || remote.daemon_token.as_deref() != Some(daemon_token.as_str())
                            {
                                None
                            } else if remote.pairing.as_ref().is_none_or(|current_pairing| {
                                current_pairing.pairing_id != pairing_id
                            }) {
                                None
                            } else {
                                {
                                    let current_pairing =
                                        remote.pairing.as_mut().expect("pairing checked above");
                                    current_pairing.session_id = Some(session_id);
                                    current_pairing.device_id = Some(device_id);
                                    current_pairing.client_bundle = Some(client_bundle);
                                    if current_pairing.trusted_at.is_none() {
                                        current_pairing.trusted_at = Some(Utc::now());
                                    }
                                }
                                let next_pairing = remote
                                    .pairing
                                    .as_ref()
                                    .expect("pairing updated above")
                                    .clone();
                                remote.status = RemoteConnectionStatus::Connecting;
                                remote.last_error = None;
                                if let Some(task) = remote.task.take() {
                                    task.abort();
                                }
                                remote.pairing_watch_task = None;
                                Some(next_pairing)
                            }
                        };

                    if let Some(pairing) = restart {
                        let app = self.clone();
                        let restart_relay_url = relay_url.clone();
                        let restart_daemon_token = daemon_token.clone();
                        let task = tokio::spawn(async move {
                            app.run_remote_bridge(restart_relay_url, restart_daemon_token, pairing)
                                .await;
                        });
                        {
                            let mut remote = self.inner.remote.lock().await;
                            if remote.relay_url.as_deref() == Some(relay_url.as_str())
                                && remote.daemon_token.as_deref() == Some(daemon_token.as_str())
                            {
                                remote.task = Some(task);
                            } else {
                                task.abort();
                            }
                        }
                        let _ = self.persist_local_state().await;
                    }
                    return;
                }
            }
        }
    }

    async fn connect_remote_session(
        &self,
        relay_url: String,
        daemon_token: String,
        session_id: String,
        pairing: RemotePairingState,
        client_bundle: PairingPublicKeyBundle,
    ) -> Result<(), String> {
        let ws_url = relay_ws_url(&relay_url, &session_id, &daemon_token);
        let (socket, _) = connect_async(&ws_url)
            .await
            .map_err(|error| format!("failed to connect daemon relay websocket: {error}"))?;
        let (mut writer, mut reader) = socket.split();
        let client_wrapped_data_key = pairing
            .local_key_pair
            .wrap_data_key(&client_bundle.public_key, &pairing.data_key)
            .map_err(|error| format!("failed to wrap remote session key: {error}"))?;
        let daemon_wrapped_data_key = pairing
            .local_key_pair
            .wrap_data_key(
                pairing.local_key_pair.public_key_base64(),
                &pairing.data_key,
            )
            .map_err(|error| format!("failed to wrap daemon session key: {error}"))?;
        let session_material = SessionKeyMaterial {
            encryption_variant: falcondeck_core::EncryptionVariant::DataKeyV1,
            daemon_public_key: pairing.local_key_pair.public_key_base64().to_string(),
            client_public_key: client_bundle.public_key,
            client_wrapped_data_key,
            daemon_wrapped_data_key: Some(daemon_wrapped_data_key),
        };

        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));

        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "interactive.respond".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "thread.start".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "thread.detail".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "turn.start".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "turn.interrupt".to_string(),
            },
        )
        .await?;
        send_relay_message(
            &mut writer,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::SessionBootstrap {
                    material: session_material,
                },
            },
        )
        .await?;

        let snapshot_event = EventEnvelope {
            seq: 0,
            emitted_at: Utc::now(),
            workspace_id: None,
            thread_id: None,
            event: UnifiedEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        };
        send_relay_message(
            &mut writer,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::Encrypted {
                    envelope: encrypt_remote_daemon_event(&pairing.data_key, &snapshot_event)?,
                },
            },
        )
        .await?;

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::Connected;
            remote.last_error = None;
        }

        self.persist_local_state()
            .await
            .map_err(|error| format!("failed to persist connected remote state: {error}"))?;

        let mut events = self.subscribe();
        loop {
            tokio::select! {
                event = events.recv() => {
                    let event = event.map_err(|error| format!("remote event stream ended: {error}"))?;
                    send_relay_message(
                        &mut writer,
                        &RelayClientMessage::Update {
                            body: RelayUpdateBody::Encrypted {
                                envelope: encrypt_remote_daemon_event(&pairing.data_key, &event)?,
                            },
                        },
                    ).await?;
                }
                _ = heartbeat.tick() => {
                    send_relay_message(&mut writer, &RelayClientMessage::Ping).await?;
                }
                message = reader.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let parsed = serde_json::from_str::<RelayServerMessage>(&text)
                                .map_err(|error| format!("invalid relay message: {error}"))?;
                            match parsed {
                                RelayServerMessage::RpcRequest { request_id, method, params } => {
                                    self.handle_remote_rpc(&mut writer, &pairing.data_key, request_id, method, params).await?;
                                }
                                RelayServerMessage::ActionRequested { action, payload } => {
                                    self.handle_queued_remote_action(&mut writer, &pairing.data_key, action.action_id, action.action_type, payload).await?;
                                }
                                RelayServerMessage::Pong | RelayServerMessage::Presence { .. } | RelayServerMessage::ActionUpdated { .. } | RelayServerMessage::Ready { .. } | RelayServerMessage::Sync { .. } | RelayServerMessage::Update { .. } | RelayServerMessage::Ephemeral { .. } | RelayServerMessage::RpcRegistered { .. } | RelayServerMessage::RpcUnregistered { .. } | RelayServerMessage::RpcResult { .. } | RelayServerMessage::Error { .. } => {}
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            return Err("relay websocket disconnected".to_string());
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => {
                            return Err(format!("relay websocket error: {error}"));
                        }
                    }
                }
            }
        }
    }

    async fn fetch_remote_status(
        &self,
        relay_url: &str,
        session_id: &str,
        daemon_token: &str,
    ) -> Result<falcondeck_core::TrustedDevicesResponse, DaemonError> {
        reqwest::Client::new()
            .get(format!(
                "{}/v1/sessions/{}/devices",
                relay_url.trim_end_matches('/'),
                session_id
            ))
            .bearer_auth(daemon_token)
            .send()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to fetch relay remote status: {error}"))
            })?
            .error_for_status()
            .map_err(|error| {
                DaemonError::Rpc(format!("relay remote status request failed: {error}"))
            })?
            .json::<falcondeck_core::TrustedDevicesResponse>()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to parse relay remote status: {error}"))
            })
    }

    async fn pairing_watch_still_current(
        &self,
        relay_url: &str,
        daemon_token: &str,
        pairing_id: &str,
    ) -> bool {
        let remote = self.inner.remote.lock().await;
        remote.relay_url.as_deref() == Some(relay_url)
            && remote.daemon_token.as_deref() == Some(daemon_token)
            && remote
                .pairing
                .as_ref()
                .is_some_and(|pairing| pairing.pairing_id == pairing_id)
    }

    async fn set_pairing_watch_error(
        &self,
        relay_url: &str,
        daemon_token: &str,
        pairing_id: &str,
        error: String,
    ) {
        let should_persist = {
            let mut remote = self.inner.remote.lock().await;
            if remote.relay_url.as_deref() != Some(relay_url)
                || remote.daemon_token.as_deref() != Some(daemon_token)
                || !remote
                    .pairing
                    .as_ref()
                    .is_some_and(|pairing| pairing.pairing_id == pairing_id)
            {
                false
            } else {
                remote.last_error = Some(error);
                true
            }
        };
        if should_persist {
            let _ = self.persist_local_state().await;
        }
    }

    async fn handle_remote_rpc(
        &self,
        writer: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        data_key: &[u8; 32],
        request_id: String,
        method: String,
        params: EncryptedEnvelope,
    ) -> Result<(), String> {
        let params: Value = decrypt_json(data_key, &params)
            .map_err(|error| format!("failed to decrypt remote rpc payload: {error}"))?;
        match method.as_str() {
            "snapshot.current" => {
                let snapshot = self.snapshot().await;
                send_relay_message(
                    writer,
                    &RelayClientMessage::RpcResult {
                        request_id,
                        ok: true,
                        result: Some(
                            encrypt_json(data_key, &snapshot)
                                .map_err(|error| format!("failed to encrypt rpc result: {error}"))?,
                        ),
                        error: None,
                    },
                )
                .await?;
            }
            "thread.start" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "thread.start missing workspaceId".to_string())?;
                let request = StartThreadRequest {
                    workspace_id,
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                    approval_policy: extract_string(
                        &params,
                        &["approvalPolicy", "approval_policy"],
                    ),
                };
                match self.start_thread(request).await {
                    Ok(handle) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: true,
                                result: Some(encrypt_json(data_key, &handle).map_err(|error| {
                                    format!("failed to encrypt rpc result: {error}")
                                })?),
                                error: None,
                            },
                        )
                        .await?;
                    }
                    Err(error) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: false,
                                result: None,
                                error: Some(
                                    encrypt_json(
                                        data_key,
                                        &json!({ "message": error.to_string() }),
                                    )
                                    .map_err(
                                        |encrypt_error| {
                                            format!("failed to encrypt rpc error: {encrypt_error}")
                                        },
                                    )?,
                                ),
                            },
                        )
                        .await?;
                    }
                }
            }
            "thread.detail" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "thread.detail missing workspaceId".to_string())?;
                let thread_id = extract_string(&params, &["threadId", "thread_id"])
                    .ok_or_else(|| "thread.detail missing threadId".to_string())?;
                match self.thread_detail(&workspace_id, &thread_id).await {
                    Ok(detail) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: true,
                                result: Some(encrypt_json(data_key, &detail).map_err(|error| {
                                    format!("failed to encrypt rpc result: {error}")
                                })?),
                                error: None,
                            },
                        )
                        .await?;
                    }
                    Err(error) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: false,
                                result: None,
                                error: Some(
                                    encrypt_json(
                                        data_key,
                                        &json!({ "message": error.to_string() }),
                                    )
                                    .map_err(
                                        |encrypt_error| {
                                            format!("failed to encrypt rpc error: {encrypt_error}")
                                        },
                                    )?,
                                ),
                            },
                        )
                        .await?;
                    }
                }
            }
            "thread.update" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "thread.update missing workspaceId".to_string())?;
                let thread_id = extract_string(&params, &["threadId", "thread_id"])
                    .ok_or_else(|| "thread.update missing threadId".to_string())?;
                let request = UpdateThreadRequest {
                    workspace_id,
                    thread_id,
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    reasoning_effort: extract_string(
                        &params,
                        &["reasoningEffort", "reasoning_effort"],
                    ),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                };
                match self.update_thread(request).await {
                    Ok(handle) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: true,
                                result: Some(encrypt_json(data_key, &handle).map_err(|error| {
                                    format!("failed to encrypt rpc result: {error}")
                                })?),
                                error: None,
                            },
                        )
                        .await?;
                    }
                    Err(error) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: false,
                                result: None,
                                error: Some(
                                    encrypt_json(
                                        data_key,
                                        &json!({ "message": error.to_string() }),
                                    )
                                    .map_err(
                                        |encrypt_error| {
                                            format!("failed to encrypt rpc error: {encrypt_error}")
                                        },
                                    )?,
                                ),
                            },
                        )
                        .await?;
                    }
                }
            }
            "turn.start" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "turn.start missing workspaceId".to_string())?;
                let thread_id = extract_string(&params, &["threadId", "thread_id"])
                    .ok_or_else(|| "turn.start missing threadId".to_string())?;
                let inputs = params
                    .get("inputs")
                    .cloned()
                    .and_then(|value| serde_json::from_value(value).ok())
                    .unwrap_or_default();
                let request = SendTurnRequest {
                    workspace_id,
                    thread_id,
                    inputs,
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    reasoning_effort: extract_string(
                        &params,
                        &["reasoningEffort", "reasoning_effort"],
                    ),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                    approval_policy: extract_string(
                        &params,
                        &["approvalPolicy", "approval_policy"],
                    ),
                    service_tier: extract_string(&params, &["serviceTier", "service_tier"]),
                };
                match self.send_turn(request).await {
                    Ok(response) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: true,
                                result: Some(encrypt_json(data_key, &response).map_err(
                                    |error| format!("failed to encrypt rpc result: {error}"),
                                )?),
                                error: None,
                            },
                        )
                        .await?;
                    }
                    Err(error) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: false,
                                result: None,
                                error: Some(
                                    encrypt_json(
                                        data_key,
                                        &json!({ "message": error.to_string() }),
                                    )
                                    .map_err(
                                        |encrypt_error| {
                                            format!("failed to encrypt rpc error: {encrypt_error}")
                                        },
                                    )?,
                                ),
                            },
                        )
                        .await?;
                    }
                }
            }
            "turn.interrupt" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "turn.interrupt missing workspaceId".to_string())?;
                let thread_id = extract_string(&params, &["threadId", "thread_id"])
                    .ok_or_else(|| "turn.interrupt missing threadId".to_string())?;
                match self.interrupt_turn(workspace_id, thread_id).await {
                    Ok(response) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: true,
                                result: Some(encrypt_json(data_key, &response).map_err(
                                    |error| format!("failed to encrypt rpc result: {error}"),
                                )?),
                                error: None,
                            },
                        )
                        .await?;
                    }
                    Err(error) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: false,
                                result: None,
                                error: Some(
                                    encrypt_json(
                                        data_key,
                                        &json!({ "message": error.to_string() }),
                                    )
                                    .map_err(
                                        |encrypt_error| {
                                            format!("failed to encrypt rpc error: {encrypt_error}")
                                        },
                                    )?,
                                ),
                            },
                        )
                        .await?;
                    }
                }
            }
            "interactive.respond" | "approval.respond" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "interactive.respond missing workspaceId".to_string())?;
                let request_id_param = extract_string(&params, &["requestId", "request_id"])
                    .ok_or_else(|| "interactive.respond missing requestId".to_string())?;
                let response = match parse_interactive_response_params(&params) {
                    Ok(response) => response,
                    Err(message) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: false,
                                result: None,
                                error: Some(
                                    encrypt_json(
                                        data_key,
                                        &json!({ "message": message }),
                                    )
                                    .map_err(
                                        |encrypt_error| {
                                            format!("failed to encrypt rpc error: {encrypt_error}")
                                        },
                                    )?,
                                ),
                            },
                        )
                        .await?;
                        return Ok(());
                    }
                };

                match self
                    .respond_to_interactive_request(workspace_id, request_id_param, response)
                    .await
                {
                    Ok(_) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: true,
                                result: Some(
                                    encrypt_json(data_key, &json!({ "ok": true })).map_err(
                                        |error| format!("failed to encrypt rpc result: {error}"),
                                    )?,
                                ),
                                error: None,
                            },
                        )
                        .await?;
                    }
                    Err(error) => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: false,
                                result: None,
                                error: Some(
                                    encrypt_json(
                                        data_key,
                                        &json!({ "message": error.to_string() }),
                                    )
                                    .map_err(
                                        |encrypt_error| {
                                            format!("failed to encrypt rpc error: {encrypt_error}")
                                        },
                                    )?,
                                ),
                            },
                        )
                        .await?;
                    }
                }
            }
            _ => {
                send_relay_message(
                    writer,
                    &RelayClientMessage::RpcResult {
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(
                            encrypt_json(data_key, &json!({ "message": format!("unsupported remote rpc method `{method}`") }))
                                .map_err(|encrypt_error| format!("failed to encrypt rpc error: {encrypt_error}"))?,
                        ),
                    },
                )
                .await?;
            }
        }

        Ok(())
    }

    async fn handle_queued_remote_action(
        &self,
        writer: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        data_key: &[u8; 32],
        action_id: String,
        action_type: String,
        payload: EncryptedEnvelope,
    ) -> Result<(), String> {
        send_relay_message(
            writer,
            &RelayClientMessage::ActionUpdate {
                action_id: action_id.clone(),
                status: falcondeck_core::QueuedRemoteActionStatus::Executing,
                error: None,
                result: None,
            },
        )
        .await?;

        let params: Value = decrypt_json(data_key, &payload)
            .map_err(|error| format!("failed to decrypt queued action payload: {error}"))?;

        let outcome: Result<Value, DaemonError> = match action_type.as_str() {
            "thread.start" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "thread.start missing workspaceId".to_string())?;
                let request = StartThreadRequest {
                    workspace_id,
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                    approval_policy: extract_string(
                        &params,
                        &["approvalPolicy", "approval_policy"],
                    ),
                };
                self.start_thread(request)
                    .await
                    .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
            }
            "thread.update" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "thread.update missing workspaceId".to_string())?;
                let thread_id = extract_string(&params, &["threadId", "thread_id"])
                    .ok_or_else(|| "thread.update missing threadId".to_string())?;
                let request = UpdateThreadRequest {
                    workspace_id,
                    thread_id,
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    reasoning_effort: extract_string(
                        &params,
                        &["reasoningEffort", "reasoning_effort"],
                    ),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                };
                self.update_thread(request)
                    .await
                    .and_then(|handle| serde_json::to_value(handle).map_err(DaemonError::from))
            }
            "turn.start" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "turn.start missing workspaceId".to_string())?;
                let thread_id = extract_string(&params, &["threadId", "thread_id"])
                    .ok_or_else(|| "turn.start missing threadId".to_string())?;
                let inputs = params
                    .get("inputs")
                    .cloned()
                    .and_then(|value| serde_json::from_value(value).ok())
                    .unwrap_or_default();
                let request = SendTurnRequest {
                    workspace_id,
                    thread_id,
                    inputs,
                    model_id: extract_string(&params, &["modelId", "model_id"]),
                    reasoning_effort: extract_string(
                        &params,
                        &["reasoningEffort", "reasoning_effort"],
                    ),
                    collaboration_mode_id: extract_string(
                        &params,
                        &["collaborationModeId", "collaboration_mode_id"],
                    ),
                    approval_policy: extract_string(
                        &params,
                        &["approvalPolicy", "approval_policy"],
                    ),
                    service_tier: extract_string(&params, &["serviceTier", "service_tier"]),
                };
                self.send_turn(request)
                    .await
                    .and_then(|response| serde_json::to_value(response).map_err(DaemonError::from))
            }
            "turn.interrupt" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "turn.interrupt missing workspaceId".to_string())?;
                let thread_id = extract_string(&params, &["threadId", "thread_id"])
                    .ok_or_else(|| "turn.interrupt missing threadId".to_string())?;
                self.interrupt_turn(workspace_id, thread_id)
                    .await
                    .and_then(|response| serde_json::to_value(response).map_err(DaemonError::from))
            }
            "thread.archive" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "thread.archive missing workspaceId".to_string())?;
                let thread_id = extract_string(&params, &["threadId", "thread_id"])
                    .ok_or_else(|| "thread.archive missing threadId".to_string())?;
                self.archive_thread(&workspace_id, &thread_id)
                    .await
                    .and_then(|summary| serde_json::to_value(summary).map_err(DaemonError::from))
            }
            "thread.unarchive" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "thread.unarchive missing workspaceId".to_string())?;
                let thread_id = extract_string(&params, &["threadId", "thread_id"])
                    .ok_or_else(|| "thread.unarchive missing threadId".to_string())?;
                self.unarchive_thread(&workspace_id, &thread_id)
                    .await
                    .and_then(|summary| serde_json::to_value(summary).map_err(DaemonError::from))
            }
            "interactive.respond" | "approval.respond" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "interactive.respond missing workspaceId".to_string())?;
                let request_id_param = extract_string(&params, &["requestId", "request_id"])
                    .ok_or_else(|| "interactive.respond missing requestId".to_string())?;
                let response = parse_interactive_response_params(&params)?;
                self.respond_to_interactive_request(workspace_id, request_id_param, response)
                    .await
                    .and_then(|response| serde_json::to_value(response).map_err(DaemonError::from))
            }
            other => Err(DaemonError::BadRequest(format!(
                "unsupported queued action `{other}`"
            ))),
        };

        match outcome {
            Ok(value) => {
                send_relay_message(
                    writer,
                    &RelayClientMessage::ActionUpdate {
                        action_id,
                        status: falcondeck_core::QueuedRemoteActionStatus::Completed,
                        error: None,
                        result: Some(encrypt_json(data_key, &value).map_err(|error| {
                            format!("failed to encrypt queued action result: {error}")
                        })?),
                    },
                )
                .await?;
            }
            Err(error) => {
                send_relay_message(
                    writer,
                    &RelayClientMessage::ActionUpdate {
                        action_id,
                        status: falcondeck_core::QueuedRemoteActionStatus::Failed,
                        error: Some(error.to_string()),
                        result: None,
                    },
                )
                .await?;
            }
        }

        Ok(())
    }

    async fn resume_remote_bridge(&self, remote: PersistedRemoteState) -> Result<(), DaemonError> {
        let local_key_pair = LocalBoxKeyPair::from_secret_key_base64(
            &remote.local_secret_key_base64,
        )
        .map_err(|error| {
            DaemonError::BadRequest(format!("invalid persisted local key pair: {error}"))
        })?;
        let data_key = decode_fixed_base64::<32>(&remote.data_key_base64).map_err(|error| {
            DaemonError::BadRequest(format!("invalid persisted relay data key: {error}"))
        })?;
        let pairing = RemotePairingState {
            pairing_id: remote.pairing_id,
            pairing_code: remote.pairing_code,
            session_id: remote.session_id,
            device_id: remote.device_id,
            trusted_at: remote.trusted_at,
            expires_at: remote.expires_at,
            client_bundle: remote
                .client_public_key
                .map(|public_key| PairingPublicKeyBundle {
                    encryption_variant: falcondeck_core::EncryptionVariant::DataKeyV1,
                    public_key,
                }),
            local_key_pair,
            data_key,
        };
        let relay_url = remote.relay_url;
        let daemon_token = remote.daemon_token;

        {
            let mut current = self.inner.remote.lock().await;
            if let Some(task) = current.task.take() {
                task.abort();
            }
            current.status = if pairing.device_id.is_some() {
                RemoteConnectionStatus::DeviceTrusted
            } else if pairing.session_id.is_some() {
                RemoteConnectionStatus::Connecting
            } else {
                RemoteConnectionStatus::PairingPending
            };
            current.relay_url = Some(relay_url.clone());
            current.daemon_token = Some(daemon_token.clone());
            current.pairing = Some(pairing.clone());
            current.last_error = None;

            let app = self.clone();
            let task = tokio::spawn(async move {
                app.run_remote_bridge(relay_url, daemon_token, pairing)
                    .await;
            });
            current.task = Some(task);
        }

        Ok(())
    }

    async fn persist_local_state(&self) -> Result<(), DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let mut persisted_workspaces = workspaces
            .values()
            .map(|workspace| {
                let archived_thread_ids = workspace
                    .threads
                    .values()
                    .filter(|thread| thread.summary.is_archived)
                    .map(|thread| thread.summary.id.clone())
                    .collect();
                PersistedWorkspaceState {
                    path: workspace.summary.path.clone(),
                    current_thread_id: workspace.summary.current_thread_id.clone(),
                    updated_at: Some(workspace.summary.updated_at),
                    archived_thread_ids,
                }
            })
            .collect::<Vec<_>>();
        persisted_workspaces.sort_by(|left, right| left.path.cmp(&right.path));
        persisted_workspaces.dedup_by(|left, right| left.path == right.path);
        drop(workspaces);

        let remote = self.inner.remote.lock().await;
        let persisted = PersistedAppState {
            workspaces: persisted_workspaces,
            remote: persisted_remote_state(&remote),
        };
        drop(remote);

        persist_app_state(&self.inner.state_path, &persisted).await
    }

    pub async fn ingest_notification(
        &self,
        workspace_id: &str,
        method: &str,
        params: Value,
    ) -> Result<(), DaemonError> {
        match method {
            "thread/started" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let title = extract_thread_title(&params)
                        .unwrap_or_else(|| "Untitled thread".to_string());
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.title = title.clone();
                            thread.status = ThreadStatus::Idle;
                            if let Some(model_id) =
                                extract_string(&params, &["model", "modelId", "model_id"])
                            {
                                thread.codex.model_id = Some(model_id);
                            }
                            if let Some(reasoning_effort) = extract_string(
                                &params,
                                &["effort", "reasoningEffort", "reasoning_effort"],
                            ) {
                                thread.codex.reasoning_effort = Some(reasoning_effort);
                            }
                            if let Some(approval_policy) =
                                extract_string(&params, &["approvalPolicy", "approval_policy"])
                            {
                                thread.codex.approval_policy = Some(approval_policy);
                            }
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadStarted { thread },
                    );
                }
            }
            "thread/name/updated" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let title = extract_thread_title(&params)
                        .unwrap_or_else(|| "Untitled thread".to_string());
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.title = title.clone();
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                }
            }
            "turn/started" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let turn_id = extract_string(&params, &["turnId", "turn_id"])
                        .unwrap_or_else(|| "turn".to_string());
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.status = ThreadStatus::Running;
                            thread.latest_turn_id = Some(turn_id.clone());
                            thread.last_error = None;
                            if let Some(model_id) =
                                extract_string(&params, &["model", "modelId", "model_id"])
                            {
                                thread.codex.model_id = Some(model_id);
                            }
                            if let Some(reasoning_effort) = extract_string(
                                &params,
                                &["effort", "reasoningEffort", "reasoning_effort"],
                            ) {
                                thread.codex.reasoning_effort = Some(reasoning_effort);
                            }
                            if let Some(approval_policy) =
                                extract_string(&params, &["approvalPolicy", "approval_policy"])
                            {
                                thread.codex.approval_policy = Some(approval_policy);
                            }
                            if let Some(service_tier) =
                                extract_string(&params, &["serviceTier", "service_tier"])
                            {
                                thread.codex.service_tier = Some(service_tier);
                            }
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::TurnStart { turn_id },
                    );
                }
            }
            "turn/completed" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let turn_id = extract_string(&params, &["turnId", "turn_id"])
                        .unwrap_or_else(|| "turn".to_string());
                    let status = extract_string(&params, &["status"])
                        .unwrap_or_else(|| "completed".to_string());
                    let error = extract_string(&params, &["error"]).or_else(|| {
                        extract_string(params.get("error").unwrap_or(&Value::Null), &["message"])
                    });
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.status = if error.is_some() {
                                ThreadStatus::Error
                            } else {
                                ThreadStatus::Idle
                            };
                            thread.last_error = error.clone();
                        })
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id.clone()),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::TurnEnd {
                            turn_id,
                            status,
                            error,
                        },
                    );
                }
            }
            "turn/plan/updated" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let plan = parse_thread_plan(&params);
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.latest_plan = plan.clone();
                        })
                        .await?;
                    if let Some(plan) = plan {
                        self.push_conversation_item(
                            workspace_id,
                            &thread_id,
                            ConversationItem::Plan {
                                id: format!(
                                    "plan-{}",
                                    extract_string(&params, &["turnId", "turn_id"])
                                        .unwrap_or_else(|| thread_id.clone())
                                ),
                                plan,
                                created_at: Utc::now(),
                            },
                            true,
                        )
                        .await?;
                    }
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::ThreadUpdated { thread },
                    );
                }
            }
            "turn/diff/updated" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let diff = extract_string(&params, &["diff", "patch"]);
                    if let Some(diff) = diff {
                        let thread = self
                            .upsert_thread(workspace_id, &thread_id, |thread| {
                                thread.latest_diff = Some(diff.clone());
                            })
                            .await?;
                        self.push_conversation_item(
                            workspace_id,
                            &thread_id,
                            ConversationItem::Diff {
                                id: format!(
                                    "diff-{}",
                                    extract_string(&params, &["turnId", "turn_id"])
                                        .unwrap_or_else(|| thread_id.clone())
                                ),
                                diff,
                                created_at: Utc::now(),
                            },
                            true,
                        )
                        .await?;
                        self.emit(
                            Some(workspace_id.to_string()),
                            Some(thread_id),
                            UnifiedEvent::ThreadUpdated { thread },
                        );
                    }
                }
            }
            "item/agentMessage/delta" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let item_id = extract_string(&params, &["itemId", "item_id"])
                        .unwrap_or_else(|| "message".to_string());
                    let delta = extract_string(&params, &["delta"]).unwrap_or_default();
                    self.upsert_thread(workspace_id, &thread_id, |thread| {
                        thread.last_message_preview = Some(truncate_preview(
                            &format!(
                                "{}{}",
                                thread.last_message_preview.clone().unwrap_or_default(),
                                delta
                            ),
                            160,
                        ));
                    })
                    .await?;
                    let detail = self
                        .thread_detail(workspace_id, &thread_id)
                        .await
                        .ok()
                        .and_then(|detail| {
                            detail.items.into_iter().find(|item| match item {
                                ConversationItem::AssistantMessage { id, .. } => id == &item_id,
                                _ => false,
                            })
                        });
                    let next = match detail {
                        Some(ConversationItem::AssistantMessage {
                            id,
                            text,
                            created_at,
                        }) => ConversationItem::AssistantMessage {
                            id,
                            text: format!("{text}{delta}"),
                            created_at,
                        },
                        _ => ConversationItem::AssistantMessage {
                            id: item_id.clone(),
                            text: delta.clone(),
                            created_at: Utc::now(),
                        },
                    };
                    self.push_conversation_item(workspace_id, &thread_id, next, true)
                        .await?;
                    self.emit(
                        Some(workspace_id.to_string()),
                        Some(thread_id),
                        UnifiedEvent::Text { item_id, delta },
                    );
                }
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let item_id = extract_string(&params, &["itemId", "item_id"])
                        .unwrap_or_else(|| "reasoning".to_string());
                    let delta = extract_string(&params, &["delta"]).unwrap_or_default();
                    let existing = self
                        .thread_detail(workspace_id, &thread_id)
                        .await
                        .ok()
                        .and_then(|detail| {
                            detail.items.into_iter().find(|item| match item {
                                ConversationItem::Reasoning { id, .. } => id == &item_id,
                                _ => false,
                            })
                        });
                    let next = match existing {
                        Some(ConversationItem::Reasoning {
                            id,
                            summary,
                            content,
                            created_at,
                        }) => {
                            if method.ends_with("summaryTextDelta") {
                                ConversationItem::Reasoning {
                                    id,
                                    summary: Some(format!(
                                        "{}{}",
                                        summary.unwrap_or_default(),
                                        delta
                                    )),
                                    content,
                                    created_at,
                                }
                            } else {
                                ConversationItem::Reasoning {
                                    id,
                                    summary,
                                    content: format!("{content}{delta}"),
                                    created_at,
                                }
                            }
                        }
                        _ => ConversationItem::Reasoning {
                            id: item_id,
                            summary: if method.ends_with("summaryTextDelta") {
                                Some(delta.clone())
                            } else {
                                None
                            },
                            content: if method.ends_with("summaryTextDelta") {
                                String::new()
                            } else {
                                delta
                            },
                            created_at: Utc::now(),
                        },
                    };
                    self.push_conversation_item(workspace_id, &thread_id, next, true)
                        .await?;
                }
            }
            "item/started" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let item = params.get("item").unwrap_or(&params);
                    let item_id =
                        extract_string(item, &["id"]).unwrap_or_else(|| "item".to_string());
                    let kind = extract_string(item, &["kind", "type"])
                        .unwrap_or_else(|| "tool".to_string());
                    if !should_surface_tool_item(&kind) {
                        return Ok(());
                    }
                    let title = extract_string(item, &["title", "label", "command"])
                        .or_else(|| {
                            extract_string(
                                item.get("command").unwrap_or(&Value::Null),
                                &["command"],
                            )
                        })
                        .unwrap_or_else(|| kind.clone());
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.status = ThreadStatus::Running;
                            thread.last_tool = Some(title.clone());
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
                        UnifiedEvent::ToolCallStart {
                            item_id: item_id.clone(),
                            title: title.clone(),
                            kind: kind.clone(),
                        },
                    );
                    self.push_conversation_item(
                        workspace_id,
                        &thread_id,
                        ConversationItem::ToolCall {
                            id: item_id,
                            title,
                            tool_kind: kind,
                            status: "running".to_string(),
                            output: None,
                            exit_code: None,
                            created_at: Utc::now(),
                            completed_at: None,
                        },
                        true,
                    )
                    .await?;
                }
            }
            "item/completed" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let item = params.get("item").unwrap_or(&params);
                    let item_id =
                        extract_string(item, &["id"]).unwrap_or_else(|| "item".to_string());
                    let kind = extract_string(item, &["kind", "type"])
                        .unwrap_or_else(|| "tool".to_string());
                    if !should_surface_tool_item(&kind) {
                        return Ok(());
                    }
                    let title = extract_string(item, &["title", "label", "command"])
                        .or_else(|| {
                            extract_string(
                                item.get("command").unwrap_or(&Value::Null),
                                &["command"],
                            )
                        })
                        .unwrap_or_else(|| kind.clone());
                    let status = extract_string(item, &["status"])
                        .unwrap_or_else(|| "completed".to_string());
                    let exit_code = item
                        .get("exitCode")
                        .or_else(|| item.get("exit_code"))
                        .and_then(Value::as_i64)
                        .map(|value| value as i32);
                    let thread = self
                        .upsert_thread(workspace_id, &thread_id, |thread| {
                            thread.last_tool = Some(title.clone());
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
                        UnifiedEvent::ToolCallEnd {
                            item_id: item_id.clone(),
                            title: title.clone(),
                            kind: kind.clone(),
                            status: status.clone(),
                            exit_code,
                        },
                    );
                    let existing_output = item
                        .get("output")
                        .or_else(|| item.get("result"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    self.push_conversation_item(
                        workspace_id,
                        &thread_id,
                        ConversationItem::ToolCall {
                            id: item_id.clone(),
                            title: title.clone(),
                            tool_kind: kind.clone(),
                            status: status.clone(),
                            output: existing_output,
                            exit_code,
                            created_at: Utc::now(),
                            completed_at: Some(Utc::now()),
                        },
                        true,
                    )
                    .await?;
                    if kind.eq_ignore_ascii_case("fileChange")
                        || kind.eq_ignore_ascii_case("file_change")
                    {
                        self.emit(
                            Some(workspace_id.to_string()),
                            Some(thread_id),
                            UnifiedEvent::File {
                                item_id: Some(item_id),
                                path: extract_string(item, &["path"]),
                                summary: title,
                            },
                        );
                    }
                }
            }
            "error" => {
                let thread_id = extract_thread_id(&params);
                let message =
                    extract_string(&params, &["message"]).unwrap_or_else(|| params.to_string());
                self.emit_service(
                    Some(workspace_id.to_string()),
                    thread_id,
                    ServiceLevel::Error,
                    message,
                    Some(method.to_string()),
                )?;
            }
            "account/updated" => {
                let mut workspaces = self.inner.workspaces.lock().await;
                if let Some(workspace) = workspaces.get_mut(workspace_id) {
                    workspace.summary.account = parse_account(&params);
                    workspace.summary.status = workspace_status_after_account_update(
                        &workspace.summary.status,
                        &workspace.summary.account.status,
                    );
                    workspace.summary.updated_at = Utc::now();
                }
            }
            "model/rerouted" => {
                if let Some(thread_id) = extract_thread_id(&params) {
                    let rerouted_model = extract_string(
                        &params,
                        &[
                            "toModel",
                            "to_model",
                            "model",
                            "modelId",
                            "model_id",
                            "reroutedModel",
                            "rerouted_model",
                        ],
                    );
                    if let Some(model_id) = rerouted_model {
                        let thread = self
                            .upsert_thread(workspace_id, &thread_id, |thread| {
                                thread.codex.model_id = Some(model_id.clone());
                            })
                            .await?;
                        self.emit(
                            Some(workspace_id.to_string()),
                            Some(thread_id),
                            UnifiedEvent::ThreadUpdated { thread },
                        );
                    }
                }
            }
            _ => {
                debug!("ignoring unsupported codex notification: {method}");
            }
        }

        Ok(())
    }

    pub async fn ingest_server_request(
        &self,
        workspace_id: &str,
        raw_id: Value,
        method: &str,
        params: Value,
    ) -> Result<(), DaemonError> {
        if method.ends_with("requestApproval") || method == "item/tool/requestUserInput" {
            let request_id = normalize_request_id(&raw_id);
            let request = if method.ends_with("requestApproval") {
                InteractiveRequest {
                    request_id: request_id.clone(),
                    workspace_id: workspace_id.to_string(),
                    thread_id: extract_thread_id(&params),
                    method: method.to_string(),
                    kind: InteractiveRequestKind::Approval,
                    title: extract_string(&params, &["reason", "title"])
                        .unwrap_or_else(|| approval_title(method)),
                    detail: extract_string(&params, &["message", "description"]),
                    command: extract_string(&params, &["command"]),
                    path: extract_string(&params, &["path"]),
                    turn_id: extract_string(&params, &["turnId", "turn_id"]),
                    item_id: extract_string(&params, &["itemId", "item_id"]),
                    questions: Vec::new(),
                    created_at: Utc::now(),
                }
            } else {
                let questions = parse_interactive_questions(&params);
                InteractiveRequest {
                    request_id: request_id.clone(),
                    workspace_id: workspace_id.to_string(),
                    thread_id: extract_thread_id(&params),
                    method: method.to_string(),
                    kind: InteractiveRequestKind::Question,
                    title: extract_string(&params, &["title"])
                        .unwrap_or_else(|| "Answer question".to_string()),
                    detail: extract_string(&params, &["message", "description"]).or_else(|| {
                        Some(format!(
                            "{} question{} from the agent.",
                            questions.len(),
                            if questions.len() == 1 { "" } else { "s" }
                        ))
                    }),
                    command: None,
                    path: None,
                    turn_id: extract_string(&params, &["turnId", "turn_id"]),
                    item_id: extract_string(&params, &["itemId", "item_id"]),
                    questions,
                    created_at: Utc::now(),
                }
            };

            self.inner.interactive_requests.lock().await.insert(
                (workspace_id.to_string(), request_id.clone()),
                PendingServerRequest {
                    raw_id,
                    request: request.clone(),
                },
            );

            if let Some(thread_id) = request.thread_id.clone() {
                self.with_thread_mut(workspace_id, &thread_id, |thread| {
                    thread.status = ThreadStatus::WaitingForInput;
                })
                .await?;
            }

            self.emit(
                Some(workspace_id.to_string()),
                request.thread_id.clone(),
                UnifiedEvent::InteractiveRequest {
                    request: request.clone(),
                },
            );
            if let Some(thread_id) = request.thread_id.clone() {
                self.push_conversation_item(
                    workspace_id,
                    &thread_id,
                    ConversationItem::InteractiveRequest {
                        id: request_id,
                        request,
                        created_at: Utc::now(),
                        resolved: false,
                    },
                    false,
                )
                .await?;
            }
            return Ok(());
        }

        self.emit_service(
            Some(workspace_id.to_string()),
            extract_thread_id(&params),
            ServiceLevel::Warning,
            format!("FalconDeck has not implemented interactive handling for {method} yet."),
            Some(method.to_string()),
        )?;

        Ok(())
    }

    pub fn emit_service(
        &self,
        workspace_id: Option<String>,
        thread_id: Option<String>,
        level: ServiceLevel,
        message: String,
        raw_method: Option<String>,
    ) -> Result<(), DaemonError> {
        if let (Some(workspace_id), Some(thread_id)) = (workspace_id.clone(), thread_id.clone()) {
            let app = self.clone();
            let service_message = message.clone();
            let service_level = level.clone();
            tokio::spawn(async move {
                let _ = app
                    .push_conversation_item(
                        &workspace_id,
                        &thread_id,
                        ConversationItem::Service {
                            id: format!("service-{}", Uuid::new_v4().simple()),
                            level: service_level,
                            message: service_message,
                            created_at: Utc::now(),
                        },
                        false,
                    )
                    .await;
            });
        }
        self.emit(
            workspace_id,
            thread_id,
            UnifiedEvent::Service {
                level,
                message,
                raw_method,
            },
        );
        Ok(())
    }

    fn emit(&self, workspace_id: Option<String>, thread_id: Option<String>, event: UnifiedEvent) {
        let envelope = EventEnvelope {
            seq: self.inner.sequence.fetch_add(1, Ordering::Relaxed),
            emitted_at: Utc::now(),
            workspace_id,
            thread_id,
            event,
        };
        let _ = self.inner.broadcaster.send(envelope);
    }

    async fn session_for(&self, workspace_id: &str) -> Result<Arc<CodexSession>, DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .map(|workspace| Arc::clone(&workspace.session))
            .ok_or_else(|| DaemonError::NotFound(format!("workspace {workspace_id} not found")))
    }

    pub async fn git_status(
        &self,
        workspace_id: &str,
    ) -> Result<falcondeck_core::GitStatusResponse, DaemonError> {
        let session = self.session_for(workspace_id).await?;
        crate::git::git_status(session.workspace_path()).await
    }

    pub async fn git_diff(
        &self,
        workspace_id: &str,
        path: Option<&str>,
    ) -> Result<falcondeck_core::GitDiffResponse, DaemonError> {
        let session = self.session_for(workspace_id).await?;
        crate::git::git_diff(session.workspace_path(), path).await
    }

    async fn upsert_thread<F>(
        &self,
        workspace_id: &str,
        thread_id: &str,
        updater: F,
    ) -> Result<ThreadSummary, DaemonError>
    where
        F: FnOnce(&mut ThreadSummary),
    {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let now = Utc::now();
        let thread = workspace
            .threads
            .entry(thread_id.to_string())
            .or_insert_with(|| {
                ManagedThread::new(ThreadSummary {
                    id: thread_id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    title: "Untitled thread".to_string(),
                    status: ThreadStatus::Idle,
                    updated_at: now,
                    last_message_preview: None,
                    latest_turn_id: None,
                    latest_plan: None,
                    latest_diff: None,
                    last_tool: None,
                    last_error: None,
                    codex: ThreadCodexParams::default(),
                    is_archived: false,
                })
            });
        updater(&mut thread.summary);
        thread.summary.updated_at = now;
        workspace.summary.current_thread_id = Some(thread.summary.id.clone());
        workspace.summary.updated_at = now;
        Ok(thread.summary.clone())
    }

    async fn with_thread_mut<F>(
        &self,
        workspace_id: &str,
        thread_id: &str,
        updater: F,
    ) -> Result<(), DaemonError>
    where
        F: FnOnce(&mut ThreadSummary),
    {
        self.upsert_thread(workspace_id, thread_id, updater).await?;
        Ok(())
    }
}

impl ManagedThread {
    fn new(summary: ThreadSummary) -> Self {
        Self {
            summary,
            items: Vec::new(),
            assistant_items: HashMap::new(),
            reasoning_items: HashMap::new(),
            tool_items: HashMap::new(),
            requires_resume: false,
        }
    }

    fn with_items(summary: ThreadSummary, items: Vec<ConversationItem>) -> Self {
        let mut thread = Self::new(summary);
        for (index, item) in items.into_iter().enumerate() {
            let id = conversation_item_identity(&item).to_string();
            match &item {
                ConversationItem::AssistantMessage { .. } => {
                    thread.assistant_items.insert(id, index);
                }
                ConversationItem::Reasoning { .. } => {
                    thread.reasoning_items.insert(id, index);
                }
                ConversationItem::ToolCall { .. } => {
                    thread.tool_items.insert(id, index);
                }
                _ => {}
            }
            thread.items.push(item);
        }
        thread.requires_resume = true;
        thread
    }
}

impl AppState {
    async fn push_conversation_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        item: ConversationItem,
        update_existing: bool,
    ) -> Result<(), DaemonError> {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;

        let id = conversation_item_identity(&item);
        let existing_index = match &item {
            ConversationItem::AssistantMessage { .. } => thread.assistant_items.get(id).copied(),
            ConversationItem::Reasoning { .. } => thread.reasoning_items.get(id).copied(),
            ConversationItem::ToolCall { .. } => thread.tool_items.get(id).copied(),
            _ => thread
                .items
                .iter()
                .position(|entry| conversation_item_identity(entry) == id),
        };

        if update_existing {
            if let Some(index) = existing_index {
                thread.items[index] = item.clone();
                drop(workspaces);
                self.emit(
                    Some(workspace_id.to_string()),
                    Some(thread_id.to_string()),
                    UnifiedEvent::ConversationItemUpdated { item },
                );
                return Ok(());
            }
        }

        let index = thread.items.len();
        match &item {
            ConversationItem::AssistantMessage { .. } => {
                thread.assistant_items.insert(id.to_string(), index);
            }
            ConversationItem::Reasoning { .. } => {
                thread.reasoning_items.insert(id.to_string(), index);
            }
            ConversationItem::ToolCall { .. } => {
                thread.tool_items.insert(id.to_string(), index);
            }
            _ => {}
        }
        thread.items.push(item.clone());
        drop(workspaces);
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ConversationItemAdded { item },
        );
        Ok(())
    }

    async fn resolve_interactive_request_item(
        &self,
        workspace_id: &str,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), DaemonError> {
        let mut workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let thread = workspace
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| DaemonError::NotFound("thread not found".to_string()))?;
        let Some(index) = thread.items.iter().position(|item| match item {
            ConversationItem::InteractiveRequest { id, .. } => id == request_id,
            _ => false,
        }) else {
            return Ok(());
        };
        if let ConversationItem::InteractiveRequest { resolved, .. } = &mut thread.items[index] {
            *resolved = true;
        }
        let item = thread.items[index].clone();
        drop(workspaces);
        self.emit(
            Some(workspace_id.to_string()),
            Some(thread_id.to_string()),
            UnifiedEvent::ConversationItemUpdated { item },
        );
        Ok(())
    }
}

impl RemotePairingState {
    fn to_response(&self) -> RemotePairingSession {
        RemotePairingSession {
            pairing_id: self.pairing_id.clone(),
            pairing_code: self.pairing_code.clone(),
            session_id: self.session_id.clone(),
            expires_at: self.expires_at,
        }
    }
}

fn build_remote_status_response(remote: &RemoteBridgeState) -> RemoteStatusResponse {
    let trusted_devices = remote
        .pairing
        .as_ref()
        .and_then(|pairing| {
            pairing
                .device_id
                .as_ref()
                .zip(pairing.trusted_at)
                .map(|(device_id, trusted_at)| falcondeck_core::TrustedDevice {
                    device_id: device_id.clone(),
                    session_id: pairing.session_id.clone().unwrap_or_default(),
                    label: Some("FalconDeck Remote".to_string()),
                    status: if matches!(remote.status, RemoteConnectionStatus::Revoked) {
                        falcondeck_core::TrustedDeviceStatus::Revoked
                    } else {
                        falcondeck_core::TrustedDeviceStatus::Active
                    },
                    created_at: trusted_at,
                    last_seen_at: matches!(remote.status, RemoteConnectionStatus::Connected)
                        .then(Utc::now),
                    revoked_at: None,
                })
        })
        .into_iter()
        .collect();
    let presence = remote.pairing.as_ref().and_then(|pairing| {
        pairing
            .session_id
            .as_ref()
            .map(|session_id| falcondeck_core::MachinePresence {
                session_id: session_id.clone(),
                daemon_connected: matches!(remote.status, RemoteConnectionStatus::Connected),
                last_seen_at: matches!(remote.status, RemoteConnectionStatus::Connected)
                    .then(Utc::now),
            })
    });

    RemoteStatusResponse {
        status: remote.status.clone(),
        relay_url: remote.relay_url.clone(),
        pairing: remote.pairing.as_ref().map(|pairing| pairing.to_response()),
        trusted_devices,
        presence,
        last_error: remote.last_error.clone(),
    }
}

fn normalize_request_id(value: &Value) -> String {
    match value {
        Value::String(string) => string.clone(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn conversation_item_identity(item: &ConversationItem) -> &str {
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

fn codex_inputs(inputs: &[TurnInputItem]) -> Vec<Value> {
    inputs
        .iter()
        .map(|item| match item {
            TurnInputItem::Text { text, .. } => json!({
                "type": "text",
                "text": text,
            }),
            TurnInputItem::Image(image) => {
                if let Some(local_path) = image
                    .local_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                {
                    json!({
                        "type": "localImage",
                        "path": local_path,
                    })
                } else if image.url.starts_with("http://")
                    || image.url.starts_with("https://")
                    || image.url.starts_with("data:")
                {
                    json!({
                        "type": "image",
                        "url": image.url,
                    })
                } else {
                    json!({
                        "type": "localImage",
                        "path": image.url,
                    })
                }
            }
        })
        .collect()
}

fn collaboration_mode_payload(
    mode_id: Option<&str>,
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Value {
    let Some(mode_id) = mode_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Value::Null;
    };

    let mut settings = serde_json::Map::new();
    if let Some(model_id) = model_id.map(str::trim).filter(|value| !value.is_empty()) {
        settings.insert("model".to_string(), json!(model_id));
    }
    if let Some(reasoning_effort) = reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        settings.insert("reasoning_effort".to_string(), json!(reasoning_effort));
    }

    json!({
        "mode": mode_id,
        "settings": settings,
    })
}

fn build_user_message_item(inputs: &[TurnInputItem]) -> ConversationItem {
    let mut text = String::new();
    let mut attachments = Vec::new();

    for input in inputs {
        match input {
            TurnInputItem::Text { text: next, .. } => {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(next);
            }
            TurnInputItem::Image(image) => attachments.push(image.clone()),
        }
    }

    ConversationItem::UserMessage {
        id: format!("user-{}", Uuid::new_v4().simple()),
        text,
        attachments,
        created_at: Utc::now(),
    }
}

fn approval_title(method: &str) -> String {
    match method {
        "item/commandExecution/requestApproval" => "Approve command".to_string(),
        "item/fileChange/requestApproval" => "Approve file change".to_string(),
        "skill/requestApproval" => "Approve skill".to_string(),
        other => format!("Approve {}", other.rsplit('/').next().unwrap_or("request")),
    }
}

fn parse_interactive_questions(params: &Value) -> Vec<InteractiveQuestion> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .map(|question| InteractiveQuestion {
                    id: extract_string(question, &["id"]).unwrap_or_else(|| Uuid::new_v4().to_string()),
                    header: extract_string(question, &["header"])
                        .unwrap_or_else(|| "Question".to_string()),
                    question: extract_string(question, &["question"])
                        .unwrap_or_else(|| "Provide additional input.".to_string()),
                    is_other: question
                        .get("isOther")
                        .or_else(|| question.get("is_other"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    is_secret: question
                        .get("isSecret")
                        .or_else(|| question.get("is_secret"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    options: question.get("options").and_then(Value::as_array).map(|options| {
                        options
                            .iter()
                            .map(|option| InteractiveQuestionOption {
                                label: extract_string(option, &["label"])
                                    .unwrap_or_else(|| "Option".to_string()),
                                description: extract_string(option, &["description"])
                                    .unwrap_or_default(),
                            })
                            .collect()
                    }),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_interactive_response_params(
    params: &Value,
) -> Result<InteractiveResponsePayload, String> {
    if let Some(response) = params.get("response") {
        if let Some(kind) = extract_string(response, &["kind"]) {
            return match kind.as_str() {
                "approval" => match extract_string(response, &["decision"]).as_deref() {
                    Some("allow") => Ok(InteractiveResponsePayload::Approval {
                        decision: ApprovalDecision::Allow,
                    }),
                    Some("deny") => Ok(InteractiveResponsePayload::Approval {
                        decision: ApprovalDecision::Deny,
                    }),
                    Some("always_allow") => Ok(InteractiveResponsePayload::Approval {
                        decision: ApprovalDecision::AlwaysAllow,
                    }),
                    _ => Err("unsupported approval decision".to_string()),
                },
                "question" => Ok(InteractiveResponsePayload::Question {
                    answers: response
                        .get("answers")
                        .and_then(Value::as_object)
                        .map(|answers| {
                            answers
                                .iter()
                                .map(|(question_id, value)| {
                                    let answer_values = value
                                        .as_array()
                                        .map(|items| {
                                            items.iter()
                                                .filter_map(Value::as_str)
                                                .map(str::to_string)
                                                .collect::<Vec<_>>()
                                        })
                                        .or_else(|| {
                                            value.get("answers").and_then(Value::as_array).map(|items| {
                                                items.iter()
                                                    .filter_map(Value::as_str)
                                                    .map(str::to_string)
                                                    .collect::<Vec<_>>()
                                            })
                                        })
                                        .unwrap_or_default();
                                    (question_id.clone(), answer_values)
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                }),
                _ => Err("unsupported interactive response kind".to_string()),
            };
        }
    }

    match extract_string(params, &["decision"]).as_deref() {
        Some("allow") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::Allow,
        }),
        Some("deny") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::Deny,
        }),
        Some("always_allow") => Ok(InteractiveResponsePayload::Approval {
            decision: ApprovalDecision::AlwaysAllow,
        }),
        _ => Err("interactive response payload is missing a supported response".to_string()),
    }
}

fn truncate_preview(input: &str, limit: usize) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut result = trimmed
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

fn should_surface_tool_item(kind: &str) -> bool {
    !matches!(
        kind,
        "userMessage"
            | "user_message"
            | "agentMessage"
            | "agent_message"
            | "reasoning"
            | "reasoningSummary"
            | "reasoning_summary"
    )
}

fn default_state_path() -> PathBuf {
    let home = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join(".falcondeck").join("daemon-state.json")
}

async fn load_persisted_app_state(path: &PathBuf) -> Result<PersistedAppState, DaemonError> {
    match fs::read_to_string(path).await {
        Ok(contents) => serde_json::from_str(&contents).map_err(DaemonError::from),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PersistedAppState::default())
        }
        Err(error) => Err(DaemonError::Io(error)),
    }
}

fn deserialize_persisted_workspaces<'de, D>(
    deserializer: D,
) -> Result<Vec<PersistedWorkspaceState>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Vec::<PersistedWorkspaceEntry>::deserialize(deserializer)?;
    Ok(entries
        .into_iter()
        .map(|entry| match entry {
            PersistedWorkspaceEntry::LegacyPath(path) => PersistedWorkspaceState {
                path,
                current_thread_id: None,
                updated_at: None,
                archived_thread_ids: Vec::new(),
            },
            PersistedWorkspaceEntry::State(workspace) => workspace,
        })
        .collect())
}

async fn persist_app_state(path: &PathBuf, state: &PersistedAppState) -> Result<(), DaemonError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(state)?;
    fs::write(&tmp_path, payload).await?;
    fs::rename(&tmp_path, path).await?;
    Ok(())
}

fn persisted_remote_state(remote: &RemoteBridgeState) -> Option<PersistedRemoteState> {
    let relay_url = remote.relay_url.clone()?;
    let daemon_token = remote.daemon_token.clone()?;
    let pairing = remote.pairing.as_ref()?;
    Some(PersistedRemoteState {
        relay_url,
        daemon_token,
        pairing_id: pairing.pairing_id.clone(),
        pairing_code: pairing.pairing_code.clone(),
        session_id: pairing.session_id.clone(),
        device_id: pairing.device_id.clone(),
        trusted_at: pairing.trusted_at,
        expires_at: pairing.expires_at,
        client_public_key: pairing
            .client_bundle
            .as_ref()
            .map(|bundle| bundle.public_key.clone()),
        local_secret_key_base64: pairing.local_key_pair.secret_key_base64(),
        data_key_base64: encode_base64(&pairing.data_key),
    })
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let b0 = bytes[index];
        let b1 = if index + 1 < bytes.len() {
            bytes[index + 1]
        } else {
            0
        };
        let b2 = if index + 2 < bytes.len() {
            bytes[index + 2]
        } else {
            0
        };

        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if index + 1 < bytes.len() {
            output.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if index + 2 < bytes.len() {
            output.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            output.push('=');
        }
        index += 3;
    }
    output
}

fn decode_fixed_base64<const N: usize>(value: &str) -> Result<[u8; N], String> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }

    let mut decoded = Vec::with_capacity((bytes.len() / 4) * 3);
    for chunk in bytes.chunks(4) {
        let c0 = sextet(chunk[0]).ok_or_else(|| "invalid base64 character".to_string())?;
        let c1 = sextet(chunk[1]).ok_or_else(|| "invalid base64 character".to_string())?;
        let c2 = if chunk[2] == b'=' {
            None
        } else {
            Some(sextet(chunk[2]).ok_or_else(|| "invalid base64 character".to_string())?)
        };
        let c3 = if chunk[3] == b'=' {
            None
        } else {
            Some(sextet(chunk[3]).ok_or_else(|| "invalid base64 character".to_string())?)
        };

        decoded.push((c0 << 2) | (c1 >> 4));
        if let Some(c2) = c2 {
            decoded.push(((c1 & 0x0f) << 4) | (c2 >> 2));
            if let Some(c3) = c3 {
                decoded.push(((c2 & 0x03) << 6) | c3);
            }
        }
    }

    <[u8; N]>::try_from(decoded.as_slice()).map_err(|_| "invalid decoded length".to_string())
}

fn workspace_status_after_account_update(
    current_status: &WorkspaceStatus,
    account_status: &falcondeck_core::AccountStatus,
) -> WorkspaceStatus {
    match account_status {
        falcondeck_core::AccountStatus::NeedsAuth => WorkspaceStatus::NeedsAuth,
        _ if matches!(current_status, WorkspaceStatus::NeedsAuth) => WorkspaceStatus::Ready,
        _ => current_status.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use chrono::{Duration, Utc};
    use falcondeck_core::{
        ConversationItem, ImageInput, ThreadCodexParams, ThreadStatus, ThreadSummary,
        TurnInputItem, WorkspaceStatus,
    };
    use serde_json::json;
    use tempfile::tempdir;

    use super::{
        AppState, PersistedAppState, PersistedRemoteState, codex_inputs,
        collaboration_mode_payload, should_surface_tool_item,
        workspace_status_after_account_update,
    };

    #[test]
    fn filters_internal_codex_item_kinds_from_tool_timeline() {
        assert!(!should_surface_tool_item("userMessage"));
        assert!(!should_surface_tool_item("agentMessage"));
        assert!(!should_surface_tool_item("reasoning"));
        assert!(should_surface_tool_item("commandExecution"));
    }

    #[test]
    fn builds_structured_collaboration_mode_payload() {
        let payload = collaboration_mode_payload(Some("plan"), Some("gpt-5.4"), Some("high"));
        assert_eq!(
            payload,
            json!({
                "mode": "plan",
                "settings": {
                    "model": "gpt-5.4",
                    "reasoning_effort": "high"
                }
            })
        );
    }

    #[test]
    fn encodes_local_images_for_codex() {
        let payload = codex_inputs(&[TurnInputItem::Image(ImageInput {
            id: "img-1".to_string(),
            name: Some("diagram.png".to_string()),
            mime_type: Some("image/png".to_string()),
            url: "ignored".to_string(),
            local_path: Some("/tmp/diagram.png".to_string()),
        })]);
        assert_eq!(
            payload,
            vec![json!({
                "type": "localImage",
                "path": "/tmp/diagram.png"
            })]
        );
    }

    #[test]
    fn account_updates_do_not_clobber_runtime_status() {
        assert_eq!(
            workspace_status_after_account_update(
                &WorkspaceStatus::Busy,
                &falcondeck_core::AccountStatus::Ready,
            ),
            WorkspaceStatus::Busy
        );
        assert_eq!(
            workspace_status_after_account_update(
                &WorkspaceStatus::NeedsAuth,
                &falcondeck_core::AccountStatus::Ready,
            ),
            WorkspaceStatus::Ready
        );
        assert_eq!(
            workspace_status_after_account_update(
                &WorkspaceStatus::Error,
                &falcondeck_core::AccountStatus::NeedsAuth,
            ),
            WorkspaceStatus::NeedsAuth
        );
    }

    #[test]
    fn persisted_state_reads_legacy_workspace_paths() {
        let payload = json!({
            "workspaces": ["/tmp/project-a", "/tmp/project-b"],
            "remote": null
        });
        let persisted: PersistedAppState = serde_json::from_value(payload).unwrap();
        assert_eq!(
            persisted.workspaces,
            vec![
                super::PersistedWorkspaceState {
                    path: "/tmp/project-a".to_string(),
                    current_thread_id: None,
                    updated_at: None,
                    archived_thread_ids: Vec::new(),
                },
                super::PersistedWorkspaceState {
                    path: "/tmp/project-b".to_string(),
                    current_thread_id: None,
                    updated_at: None,
                    archived_thread_ids: Vec::new(),
                },
            ]
        );
    }

    #[test]
    fn persisted_state_reads_workspace_thread_selection() {
        let payload = json!({
            "workspaces": [
                {
                    "path": "/tmp/project-a",
                    "current_thread_id": "thread-123"
                }
            ],
            "remote": null
        });
        let persisted: PersistedAppState = serde_json::from_value(payload).unwrap();
        assert_eq!(
            persisted.workspaces,
            vec![super::PersistedWorkspaceState {
                path: "/tmp/project-a".to_string(),
                current_thread_id: Some("thread-123".to_string()),
                updated_at: None,
                archived_thread_ids: Vec::new(),
            }]
        );
    }

    #[test]
    fn restored_threads_require_resume_but_new_threads_do_not() {
        let summary = ThreadSummary {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Thread".to_string(),
            status: ThreadStatus::Idle,
            updated_at: Utc::now(),
            last_message_preview: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: None,
            last_tool: None,
            last_error: None,
            codex: ThreadCodexParams::default(),
            is_archived: false,
        };

        let new_thread = super::ManagedThread::new(summary.clone());
        assert!(!new_thread.requires_resume);

        let restored_thread = super::ManagedThread::with_items(
            summary,
            vec![ConversationItem::AssistantMessage {
                id: "assistant-1".to_string(),
                text: "hello".to_string(),
                created_at: Utc::now(),
            }],
        );
        assert!(restored_thread.requires_resume);
    }

    #[tokio::test]
    async fn restore_skips_expired_unclaimed_remote_pairing() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let persisted = PersistedAppState {
            workspaces: vec![],
            remote: Some(PersistedRemoteState {
                relay_url: "https://connect.falcondeck.com".to_string(),
                daemon_token: "daemon-token".to_string(),
                pairing_id: "pairing-1".to_string(),
                pairing_code: "ABCDEFGHJKLM".to_string(),
                session_id: None,
                device_id: None,
                trusted_at: None,
                expires_at: Utc::now() - Duration::seconds(5),
                client_public_key: None,
                local_secret_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
                data_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            }),
        };

        tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
            .await
            .unwrap();

        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            PathBuf::from(&state_path),
        );
        app.restore_local_state().await.unwrap();

        let remote = app.inner.remote.lock().await;
        assert_eq!(
            remote.status,
            falcondeck_core::RemoteConnectionStatus::Inactive
        );
        assert!(remote.relay_url.is_none());
        assert!(remote.daemon_token.is_none());
        assert!(remote.pairing.is_none());
        drop(remote);

        let persisted_after: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        assert!(persisted_after.remote.is_none());
    }

    #[tokio::test]
    async fn restore_skips_legacy_loopback_remote_pairing() {
        let temp_dir = tempdir().unwrap();
        let state_path = temp_dir.path().join("daemon-state.json");
        let persisted = PersistedAppState {
            workspaces: vec![],
            remote: Some(PersistedRemoteState {
                relay_url: "http://127.0.0.1:54871".to_string(),
                daemon_token: "daemon-token".to_string(),
                pairing_id: "pairing-legacy".to_string(),
                pairing_code: "ABCDEFGHJKLM".to_string(),
                session_id: None,
                device_id: None,
                trusted_at: None,
                expires_at: Utc::now() + Duration::minutes(10),
                client_public_key: None,
                local_secret_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
                data_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            }),
        };

        tokio::fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
            .await
            .unwrap();

        let app = AppState::new_with_state_path(
            "test".to_string(),
            "codex".to_string(),
            PathBuf::from(&state_path),
        );
        app.restore_local_state().await.unwrap();

        let remote = app.inner.remote.lock().await;
        assert_eq!(
            remote.status,
            falcondeck_core::RemoteConnectionStatus::Inactive
        );
        assert!(remote.relay_url.is_none());
        assert!(remote.daemon_token.is_none());
        assert!(remote.pairing.is_none());
        drop(remote);

        let persisted_after: PersistedAppState =
            serde_json::from_slice(&tokio::fs::read(&state_path).await.unwrap()).unwrap();
        assert!(persisted_after.remote.is_none());
    }
}

fn normalize_relay_url(input: &str) -> Result<String, DaemonError> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(DaemonError::BadRequest("relay_url is required".to_string()));
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(DaemonError::BadRequest(
            "relay_url must start with http:// or https://".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn relay_ws_url(relay_url: &str, session_id: &str, token: &str) -> String {
    let base = if let Some(rest) = relay_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = relay_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        relay_url.to_string()
    };
    format!("{base}/v1/updates/ws?session_id={session_id}&token={token}")
}

fn relay_url_looks_legacy_loopback(relay_url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(relay_url) else {
        return false;
    };

    matches!(
        parsed.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    )
}

fn host_label() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "FalconDeck desktop".to_string())
}

fn encrypt_remote_daemon_event(
    data_key: &[u8; 32],
    event: &EventEnvelope,
) -> Result<EncryptedEnvelope, String> {
    encrypt_json(
        data_key,
        &json!({
            "kind": "daemon-event",
            "event": event,
        }),
    )
    .map_err(|error| format!("failed to encrypt relay update: {error}"))
}

async fn send_relay_message(
    writer: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    message: &RelayClientMessage,
) -> Result<(), String> {
    let payload = serde_json::to_string(message)
        .map_err(|error| format!("failed to encode relay message: {error}"))?;
    writer
        .send(Message::Text(payload.into()))
        .await
        .map_err(|error| format!("failed to send relay message: {error}"))
}
