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
    ApprovalDecision, ApprovalRequest, CollaborationModeSummary, CommandResponse,
    ConnectWorkspaceRequest, ConversationItem, DaemonInfo, DaemonSnapshot, EncryptedEnvelope,
    EventEnvelope, HealthResponse, PairingPublicKeyBundle, PairingStatusResponse,
    RelayClientMessage, RelayServerMessage, RelayUpdateBody, RemoteConnectionStatus,
    RemotePairingSession, RemoteStatusResponse, SendTurnRequest, ServiceLevel, SessionKeyMaterial,
    StartPairingRequest, StartPairingResponse, StartRemotePairingRequest, StartReviewRequest,
    StartThreadRequest, ThreadCodexParams, ThreadDetail, ThreadHandle, ThreadStatus, ThreadSummary,
    TurnInputItem, UnifiedEvent, WorkspaceStatus, WorkspaceSummary,
    crypto::{LocalBoxKeyPair, decrypt_json, encrypt_json, generate_data_key},
};
use futures_util::{SinkExt, StreamExt};
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
    approvals: Mutex<HashMap<(String, String), PendingServerRequest>>,
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
}

#[derive(Clone)]
struct PendingServerRequest {
    raw_id: Value,
    request: ApprovalRequest,
}

struct RemoteBridgeState {
    status: RemoteConnectionStatus,
    relay_url: Option<String>,
    pairing: Option<RemotePairingState>,
    daemon_token: Option<String>,
    last_error: Option<String>,
    task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct RemotePairingState {
    pairing_id: String,
    pairing_code: String,
    session_id: Option<String>,
    expires_at: chrono::DateTime<Utc>,
    local_key_pair: LocalBoxKeyPair,
    data_key: [u8; 32],
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
struct PersistedAppState {
    workspaces: Vec<String>,
    remote: Option<PersistedRemoteState>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedRemoteState {
    relay_url: String,
    daemon_token: String,
    pairing_id: String,
    pairing_code: String,
    session_id: Option<String>,
    expires_at: chrono::DateTime<Utc>,
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
                approvals: Mutex::new(HashMap::new()),
                remote: Mutex::new(RemoteBridgeState {
                    status: RemoteConnectionStatus::Inactive,
                    relay_url: None,
                    pairing: None,
                    daemon_token: None,
                    last_error: None,
                    task: None,
                }),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.inner.broadcaster.subscribe()
    }

    pub async fn restore_local_state(&self) -> Result<(), DaemonError> {
        let persisted = load_persisted_app_state(&self.inner.state_path).await?;
        for path in persisted.workspaces {
            if let Err(error) = self
                .connect_workspace(ConnectWorkspaceRequest { path: path.clone() })
                .await
            {
                tracing::warn!("failed to restore workspace {path}: {error}");
            }
        }

        if let Some(remote) = persisted.remote {
            if remote.session_id.is_none() && relay_url_looks_legacy_loopback(&remote.relay_url) {
                tracing::info!(
                    "skipping legacy loopback remote pairing {} for relay {}",
                    remote.pairing_id,
                    remote.relay_url
                );
                self.clear_remote_bridge_state().await;
                self.persist_local_state().await?;
            } else if remote.session_id.is_none() && remote.expires_at <= Utc::now() {
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
        remote.status = RemoteConnectionStatus::Inactive;
        remote.relay_url = None;
        remote.pairing = None;
        remote.daemon_token = None;
        remote.last_error = None;
    }

    pub async fn remote_status(&self) -> RemoteStatusResponse {
        let remote = self.inner.remote.lock().await;
        RemoteStatusResponse {
            status: remote.status.clone(),
            relay_url: remote.relay_url.clone(),
            pairing: remote.pairing.as_ref().map(|pairing| pairing.to_response()),
            last_error: remote.last_error.clone(),
        }
    }

    pub async fn start_remote_pairing(
        &self,
        request: StartRemotePairingRequest,
    ) -> Result<RemoteStatusResponse, DaemonError> {
        let relay_url = normalize_relay_url(&request.relay_url)?;
        let client = reqwest::Client::new();
        let local_key_pair = LocalBoxKeyPair::generate();
        let data_key = generate_data_key();
        let pairing = client
            .post(format!("{relay_url}/v1/pairings"))
            .json(&StartPairingRequest {
                label: Some(host_label()),
                ttl_seconds: Some(600),
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

        let remote_pairing = RemotePairingState {
            pairing_id: pairing.pairing_id.clone(),
            pairing_code: pairing.pairing_code.clone(),
            session_id: None,
            expires_at: pairing.expires_at,
            local_key_pair,
            data_key,
        };

        let response = {
            let mut remote = self.inner.remote.lock().await;
            if let Some(task) = remote.task.take() {
                task.abort();
            }
            remote.status = RemoteConnectionStatus::WaitingForClaim;
            remote.relay_url = Some(relay_url.clone());
            remote.pairing = Some(remote_pairing.clone());
            remote.daemon_token = Some(pairing.daemon_token.clone());
            remote.last_error = None;

            let app = self.clone();
            let task = tokio::spawn(async move {
                app.run_remote_bridge(relay_url, pairing.daemon_token, remote_pairing)
                    .await;
            });
            remote.task = Some(task);
            RemoteStatusResponse {
                status: remote.status.clone(),
                relay_url: remote.relay_url.clone(),
                pairing: remote.pairing.as_ref().map(|pairing| pairing.to_response()),
                last_error: remote.last_error.clone(),
            }
        };

        self.persist_local_state().await?;

        Ok(response)
    }

    pub async fn snapshot(&self) -> DaemonSnapshot {
        let workspaces = self.inner.workspaces.lock().await;
        let approvals = self.inner.approvals.lock().await;

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

        let mut approval_list = approvals
            .values()
            .map(|request| request.request.clone())
            .collect::<Vec<_>>();
        approval_list.sort_by(|left, right| right.created_at.cmp(&left.created_at));

        DaemonSnapshot {
            daemon: self.inner.daemon.clone(),
            workspaces: workspace_list,
            threads,
            approvals: approval_list,
        }
    }

    pub async fn connect_workspace(
        &self,
        request: ConnectWorkspaceRequest,
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
            let workspaces = self.inner.workspaces.lock().await;
            if let Some(existing) = workspaces
                .values()
                .find(|workspace| workspace.summary.path == path_string)
            {
                return Ok(existing.summary.clone());
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
        let current_thread_id = threads.first().map(|thread| thread.summary.id.clone());
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
            updated_at: now,
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
                    .map(|thread| {
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
        let thread = self
            .upsert_thread(&request.workspace_id, &request.thread_id, |thread| {
                thread.status = ThreadStatus::Running;
                thread.codex.model_id = request.model_id.clone().or(thread.codex.model_id.clone());
                thread.codex.reasoning_effort = request
                    .reasoning_effort
                    .clone()
                    .or(thread.codex.reasoning_effort.clone());
                thread.codex.collaboration_mode_id = request
                    .collaboration_mode_id
                    .clone()
                    .or(thread.codex.collaboration_mode_id.clone());
                thread.codex.approval_policy = Some(approval_policy.clone());
                thread.codex.service_tier = request
                    .service_tier
                    .clone()
                    .or(thread.codex.service_tier.clone());
            })
            .await?;
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

    pub async fn respond_to_approval(
        &self,
        workspace_id: String,
        request_id: String,
        decision: ApprovalDecision,
    ) -> Result<CommandResponse, DaemonError> {
        let session = self.session_for(&workspace_id).await?;
        let pending = self
            .inner
            .approvals
            .lock()
            .await
            .remove(&(workspace_id.clone(), request_id.clone()))
            .ok_or_else(|| DaemonError::NotFound("approval request not found".to_string()))?;

        let decision = match decision {
            ApprovalDecision::Allow => "allow",
            ApprovalDecision::Deny => "deny",
            ApprovalDecision::AlwaysAllow => "always_allow",
        };

        session
            .respond_to_request(
                pending.raw_id,
                json!({
                    "decision": decision,
                    "acceptSettings": {"forSession": true}
                }),
            )
            .await?;

        if let Some(thread_id) = pending.request.thread_id {
            self.with_thread_mut(&workspace_id, &thread_id, |thread| {
                thread.status = ThreadStatus::Running;
            })
            .await?;
            self.resolve_approval_item(&workspace_id, &thread_id, &request_id)
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
            message: Some("approval sent".to_string()),
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
        let result = self
            .wait_for_claim_and_connect(relay_url, daemon_token, pairing)
            .await;

        if let Err(error) = result {
            let mut remote = self.inner.remote.lock().await;
            let should_clear_pairing = remote.pairing.as_ref().is_some_and(|pairing| {
                pairing.session_id.is_none() && pairing.expires_at <= Utc::now()
            });
            remote.status = if should_clear_pairing {
                RemoteConnectionStatus::Inactive
            } else {
                RemoteConnectionStatus::Error
            };
            remote.last_error = Some(error);
            if should_clear_pairing {
                remote.relay_url = None;
                remote.daemon_token = None;
                remote.pairing = None;
            }
            drop(remote);
            let _ = self.persist_local_state().await;
        }
    }

    async fn wait_for_claim_and_connect(
        &self,
        relay_url: String,
        daemon_token: String,
        pairing: RemotePairingState,
    ) -> Result<(), String> {
        let client = reqwest::Client::new();
        let (session_id, client_bundle) = loop {
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
                }
            }

            if let Some(session_id) = response.session_id {
                let client_bundle = response.client_bundle.ok_or_else(|| {
                    "relay pairing completed without client key material".to_string()
                })?;
                break (session_id, client_bundle);
            }

            sleep(Duration::from_secs(2)).await;
        };

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

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::Connected;
            remote.last_error = None;
        }

        self.persist_local_state()
            .await
            .map_err(|error| format!("failed to persist connected remote state: {error}"))?;

        send_relay_message(
            &mut writer,
            &RelayClientMessage::RpcRegister {
                method: "approval.respond".to_string(),
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
                message = reader.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let parsed = serde_json::from_str::<RelayServerMessage>(&text)
                                .map_err(|error| format!("invalid relay message: {error}"))?;
                            if let RelayServerMessage::RpcRequest { request_id, method, params } = parsed {
                                self.handle_remote_rpc(&mut writer, &pairing.data_key, request_id, method, params).await?;
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
            "approval.respond" => {
                let workspace_id = extract_string(&params, &["workspaceId", "workspace_id"])
                    .ok_or_else(|| "approval.respond missing workspaceId".to_string())?;
                let request_id_param = extract_string(&params, &["requestId", "request_id"])
                    .ok_or_else(|| "approval.respond missing requestId".to_string())?;
                let decision = match extract_string(&params, &["decision"]).as_deref() {
                    Some("allow") => ApprovalDecision::Allow,
                    Some("deny") => ApprovalDecision::Deny,
                    Some("always_allow") => ApprovalDecision::AlwaysAllow,
                    _ => {
                        send_relay_message(
                            writer,
                            &RelayClientMessage::RpcResult {
                                request_id,
                                ok: false,
                                result: None,
                                error: Some(
                                    encrypt_json(
                                        data_key,
                                        &json!({ "message": "unsupported approval decision" }),
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
                    .respond_to_approval(workspace_id, request_id_param, decision)
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
            expires_at: remote.expires_at,
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
            current.status = if pairing.session_id.is_some() {
                RemoteConnectionStatus::Connecting
            } else {
                RemoteConnectionStatus::WaitingForClaim
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
        let mut workspace_paths = workspaces
            .values()
            .map(|workspace| workspace.summary.path.clone())
            .collect::<Vec<_>>();
        workspace_paths.sort();
        workspace_paths.dedup();
        drop(workspaces);

        let remote = self.inner.remote.lock().await;
        let persisted = PersistedAppState {
            workspaces: workspace_paths,
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
        if method.ends_with("requestApproval") {
            let request_id = normalize_request_id(&raw_id);
            let request = ApprovalRequest {
                request_id: request_id.clone(),
                workspace_id: workspace_id.to_string(),
                thread_id: extract_thread_id(&params),
                method: method.to_string(),
                title: extract_string(&params, &["reason", "title"])
                    .unwrap_or_else(|| approval_title(method)),
                detail: extract_string(&params, &["message", "description"]),
                command: extract_string(&params, &["command"]),
                path: extract_string(&params, &["path"]),
                created_at: Utc::now(),
            };

            self.inner.approvals.lock().await.insert(
                (workspace_id.to_string(), request_id.clone()),
                PendingServerRequest {
                    raw_id,
                    request: request.clone(),
                },
            );

            if let Some(thread_id) = request.thread_id.clone() {
                self.with_thread_mut(workspace_id, &thread_id, |thread| {
                    thread.status = ThreadStatus::WaitingForApproval;
                })
                .await?;
            }

            self.emit(
                Some(workspace_id.to_string()),
                request.thread_id.clone(),
                UnifiedEvent::ApprovalRequest {
                    request: request.clone(),
                },
            );
            if let Some(thread_id) = params
                .get("threadId")
                .or_else(|| params.get("thread_id"))
                .and_then(Value::as_str)
            {
                self.push_conversation_item(
                    workspace_id,
                    thread_id,
                    ConversationItem::Approval {
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

    async fn resolve_approval_item(
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
            ConversationItem::Approval { id, .. } => id == request_id,
            _ => false,
        }) else {
            return Ok(());
        };
        if let ConversationItem::Approval { resolved, .. } = &mut thread.items[index] {
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
        | ConversationItem::Approval { id, .. } => id,
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
        expires_at: pairing.expires_at,
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
    use falcondeck_core::{ImageInput, TurnInputItem, WorkspaceStatus};
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
                expires_at: Utc::now() - Duration::seconds(5),
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
                expires_at: Utc::now() + Duration::minutes(10),
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
