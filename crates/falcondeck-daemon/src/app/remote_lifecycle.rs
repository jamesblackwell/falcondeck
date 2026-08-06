use chrono::Utc;
use falcondeck_core::{
    PairingStatusResponse, RemoteConnectionStatus, RemotePairingSession, RemoteStatusResponse,
    StartPairingRequest, StartPairingResponse, StartRemotePairingRequest,
    crypto::{
        LocalBoxKeyPair, build_pairing_public_key_bundle, generate_data_key,
        verify_pairing_public_key_bundle,
    },
};
use serde_json::Value;
use tokio::{
    sync::mpsc,
    time::{Duration, sleep},
};

use crate::error::DaemonError;

use super::{
    AppState, PersistedRemoteState, RemoteBridgeCommand, RemoteBridgeState, RemotePairingState,
    decode_fixed_base64, delete_remote_secrets, host_label, load_remote_secrets,
    normalize_relay_url, remote_secret_storage_key,
};

/// Classifies errors from the remote relay connection so the retry loop can
/// apply appropriate backoff.  Most errors (network drops, broadcast lag) are
/// transient and should retry quickly.  Only permanent failures (channel
/// closed, internal shutdown) use exponential backoff.
pub(super) enum RemoteBridgeError {
    Transient(String),
    Persistent(String),
}

impl RemoteBridgeError {
    fn message(&self) -> &str {
        match self {
            Self::Transient(msg) | Self::Persistent(msg) => msg,
        }
    }

    fn is_transient(&self) -> bool {
        matches!(self, Self::Transient(_))
    }
}

/// All bare `String` errors produced by `.map_err(|e| format!(...))` are
/// treated as transient by default — only explicitly-constructed `Persistent`
/// values bypass fast retry.
impl From<String> for RemoteBridgeError {
    fn from(s: String) -> Self {
        Self::Transient(s)
    }
}

fn relay_error_detail_from_body(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }

    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| Some(trimmed.to_string()))
}

pub(super) async fn relay_request_error(response: reqwest::Response, context: &str) -> String {
    let status = response.status();
    let detail = match response.text().await {
        Ok(body) => relay_error_detail_from_body(&body),
        Err(_) => None,
    };

    match detail {
        Some(detail) => format!("{context} failed with status {status}: {detail}"),
        None => format!("{context} failed with status {status}"),
    }
}

pub(super) fn should_clear_persisted_remote_for_bridge_error(
    error_msg: &str,
    has_trusted_device: bool,
) -> bool {
    !has_trusted_device && is_remote_bridge_missing_session_error(error_msg)
}

pub(super) fn is_remote_bridge_auth_error(error_msg: &str) -> bool {
    error_msg.contains("invalid daemon token") || error_msg.contains("invalid session token")
}

fn is_remote_bridge_missing_session_error(error_msg: &str) -> bool {
    error_msg.contains("session not found")
}

impl AppState {
    /// Best-effort: forward an attention event to the relay so devices that
    /// are not connected can receive a push notification. A missing or dead
    /// bridge simply drops the request.
    pub(super) async fn notify_remote_attention(
        &self,
        kind: &str,
        workspace_id: &str,
        thread_id: Option<String>,
    ) {
        let command_tx = { self.inner.remote.lock().await.command_tx.clone() };
        if let Some(command_tx) = command_tx {
            let _ = command_tx.send(super::RemoteBridgeCommand::NotifyAttention {
                kind: kind.to_string(),
                workspace_id: Some(workspace_id.to_string()),
                thread_id,
            });
        }
    }

    pub(super) async fn clear_remote_bridge_state(&self) {
        let mut remote = self.inner.remote.lock().await;
        if let (Some(relay_url), Some(pairing)) =
            (remote.relay_url.as_ref(), remote.pairing.as_ref())
            && let Err(error) = delete_remote_secrets(remote_secret_storage_key(
                relay_url,
                &pairing.pairing_id,
                pairing.session_id.as_deref(),
            ))
        {
            tracing::warn!("failed to clear remote secure storage: {error}");
        }
        if let Some(task) = remote.task.take() {
            task.abort();
        }
        if let Some(task) = remote.pairing_watch_task.take() {
            task.abort();
        }
        remote.status = RemoteConnectionStatus::Inactive;
        remote.relay_url = None;
        remote.pairing = None;
        remote.pending_pairing = None;
        remote.daemon_token = None;
        remote.last_error = None;
        remote.command_tx = None;
    }

    pub async fn remote_status(&self) -> RemoteStatusResponse {
        let snapshot = {
            let mut remote = self.inner.remote.lock().await;
            reconcile_remote_runtime_state(&mut remote);
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
            && let Ok(remote_status) = self
                .fetch_remote_status(&relay_url, &session_id, &daemon_token)
                .await
        {
            status.trusted_devices = remote_status.devices;
            status.presence = Some(remote_status.presence);
        }

        status
    }

    pub async fn start_remote_pairing(
        &self,
        request: StartRemotePairingRequest,
    ) -> Result<RemoteStatusResponse, DaemonError> {
        let relay_url = normalize_relay_url(&request.relay_url)?;
        let existing_remote = {
            let mut remote = self.inner.remote.lock().await;
            reconcile_remote_runtime_state(&mut remote);
            let has_live_task = has_live_remote_task(&remote);
            let should_reuse_pending = remote.relay_url.as_deref() == Some(relay_url.as_str())
                && status_pairing(&remote).is_some_and(|pairing| pairing.expires_at > Utc::now())
                && has_live_task
                && (matches!(remote.status, RemoteConnectionStatus::PairingPending)
                    || remote.pending_pairing.is_some());
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
        let response = client
            .post(format!("{relay_url}/v1/pairings"))
            .json(&StartPairingRequest {
                label: Some(host_label()),
                ttl_seconds: Some(600),
                existing_session_id: existing_session_id.clone(),
                daemon_token: existing_daemon_token.clone(),
                daemon_bundle: Some(build_pairing_public_key_bundle(&local_key_pair)),
            })
            .send()
            .await
            .map_err(|error| DaemonError::Rpc(format!("failed to contact relay: {error}")))?;
        let response = if response.status().is_success() {
            response
        } else {
            return Err(DaemonError::Rpc(
                relay_request_error(response, "relay pairing request").await,
            ));
        };
        let pairing = response
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
            reconcile_remote_runtime_state(&mut remote);
            let additional_pairing = remote.task.is_some();
            if !additional_pairing && let Some(task) = remote.task.take() {
                task.abort();
            }
            if let Some(task) = remote.pairing_watch_task.take() {
                task.abort();
            }
            if !additional_pairing {
                remote.status = RemoteConnectionStatus::PairingPending;
            }
            remote.relay_url = Some(relay_url.clone());
            remote.daemon_token = Some(pairing.daemon_token.clone());
            remote.last_error = None;

            if additional_pairing {
                remote.pending_pairing = Some(RemotePairingState {
                    device_id: None,
                    trusted_at: None,
                    client_bundle: None,
                    ..remote_pairing.clone()
                });
                let app = self.clone();
                let watch_task = tokio::spawn(async move {
                    app.watch_pairing_claim(relay_url, pairing.daemon_token, pairing.pairing_id)
                        .await;
                });
                remote.pairing_watch_task = Some(watch_task);
            } else {
                remote.pending_pairing = None;
                remote.pairing = Some(remote_pairing.clone());
                let (command_tx, command_rx) = mpsc::unbounded_channel();
                let app = self.clone();
                let task = tokio::spawn(async move {
                    app.run_remote_bridge(relay_url, pairing.daemon_token, command_rx)
                        .await;
                });
                remote.command_tx = Some(command_tx);
                remote.task = Some(task);
            }
            build_remote_status_response(&remote)
        };

        self.persist_local_state().await?;

        Ok(response)
    }

    pub async fn revoke_remote_device(
        &self,
        device_id: &str,
    ) -> Result<RemoteStatusResponse, DaemonError> {
        let (relay_url, session_id, daemon_token) =
            {
                let remote = self.inner.remote.lock().await;
                let relay_url = remote.relay_url.clone().ok_or_else(|| {
                    DaemonError::Rpc("remote relay is not configured".to_string())
                })?;
                let session_id = remote
                    .pairing
                    .as_ref()
                    .and_then(|pairing| pairing.session_id.clone())
                    .ok_or_else(|| DaemonError::Rpc("remote session is not ready".to_string()))?;
                let daemon_token = remote.daemon_token.clone().ok_or_else(|| {
                    DaemonError::Rpc("remote daemon token is missing".to_string())
                })?;
                (relay_url, session_id, daemon_token)
            };

        let response = reqwest::Client::new()
            .delete(format!(
                "{}/v1/sessions/{}/devices/{}",
                relay_url.trim_end_matches('/'),
                session_id,
                device_id
            ))
            .bearer_auth(&daemon_token)
            .send()
            .await
            .map_err(|error| {
                DaemonError::Rpc(format!("failed to revoke remote device: {error}"))
            })?;
        if !response.status().is_success() {
            return Err(DaemonError::Rpc(
                relay_request_error(response, "remote device revoke request").await,
            ));
        }

        Ok(self.remote_status().await)
    }

    async fn run_remote_bridge(
        &self,
        relay_url: String,
        daemon_token: String,
        mut command_rx: mpsc::UnboundedReceiver<RemoteBridgeCommand>,
    ) {
        let mut backoff_seconds = 1u64;
        loop {
            let Some(pairing) = ({
                let remote = self.inner.remote.lock().await;
                current_pairing_for_remote_attempt(&remote, &relay_url, &daemon_token)
            }) else {
                break;
            };

            let result = self
                .wait_for_claim_and_connect(
                    relay_url.clone(),
                    daemon_token.clone(),
                    pairing.clone(),
                    &mut command_rx,
                )
                .await;
            match result {
                Ok(()) => {
                    backoff_seconds = 1;
                }
                Err(error) => {
                    let error_msg = error.message().to_string();
                    let is_transient = error.is_transient();

                    let mut remote = self.inner.remote.lock().await;
                    let has_trusted_device = remote
                        .pairing
                        .as_ref()
                        .is_some_and(|pairing| pairing.device_id.is_some());
                    let should_clear_pairing = remote.pairing.as_ref().is_some_and(|pairing| {
                        pairing.device_id.is_none() && pairing.expires_at <= Utc::now()
                    });
                    let should_reset_persisted_remote =
                        should_clear_persisted_remote_for_bridge_error(
                            &error_msg,
                            has_trusted_device,
                        );
                    let auth_error = is_remote_bridge_auth_error(&error_msg);
                    remote.status = if should_clear_pairing {
                        RemoteConnectionStatus::Inactive
                    } else if should_reset_persisted_remote {
                        RemoteConnectionStatus::Revoked
                    } else if auth_error
                        || (has_trusted_device
                            && is_remote_bridge_missing_session_error(&error_msg))
                    {
                        RemoteConnectionStatus::Error
                    } else if !is_transient && backoff_seconds >= 8 {
                        RemoteConnectionStatus::Offline
                    } else {
                        RemoteConnectionStatus::Degraded
                    };
                    remote.last_error = Some(error_msg);
                    if should_clear_pairing || should_reset_persisted_remote {
                        if let (Some(current_relay_url), Some(current_pairing)) =
                            (remote.relay_url.as_ref(), remote.pairing.as_ref())
                            && let Err(error) = delete_remote_secrets(remote_secret_storage_key(
                                current_relay_url,
                                &current_pairing.pairing_id,
                                current_pairing.session_id.as_deref(),
                            ))
                        {
                            tracing::warn!("failed to clear remote secure storage: {error}");
                        }
                        remote.relay_url = None;
                        remote.daemon_token = None;
                        remote.pairing = None;
                    }
                    drop(remote);
                    let _ = self.persist_local_state().await;
                    if should_clear_pairing || should_reset_persisted_remote {
                        break;
                    }
                    if is_transient {
                        sleep(Duration::from_secs(backoff_seconds)).await;
                        backoff_seconds = (backoff_seconds * 2).min(10);
                    } else {
                        sleep(Duration::from_secs(backoff_seconds)).await;
                        backoff_seconds = (backoff_seconds * 2).min(16);
                    }
                }
            }
        }
    }

    async fn wait_for_claim_and_connect(
        &self,
        relay_url: String,
        daemon_token: String,
        pairing: RemotePairingState,
        command_rx: &mut mpsc::UnboundedReceiver<RemoteBridgeCommand>,
    ) -> Result<(), RemoteBridgeError> {
        // If we already have a trusted device with a session, skip polling the
        // pairing endpoint entirely. Older trusted sessions may not have a
        // persisted signed client bundle, but they can still resume by relying
        // on the previously stored data key.
        let (session_id, device_id, client_bundle) = if let (Some(session_id), Some(device_id)) =
            (pairing.session_id.clone(), pairing.device_id.clone())
        {
            let client_bundle = match pairing.client_bundle.clone() {
                Some(client_bundle) => {
                    verify_pairing_public_key_bundle(&client_bundle).map_err(|error| {
                            RemoteBridgeError::Persistent(format!(
                                "trusted client bundle is not signed; please pair the remote device again: {error}"
                            ))
                        })?;
                    Some(client_bundle)
                }
                None => {
                    tracing::warn!(
                        "trusted remote restored without client bootstrap material; relying on persisted client data key"
                    );
                    None
                }
            };

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
                    .map_err(|error| format!("failed to poll relay pairing: {error}"))?;
                let response = if response.status().is_success() {
                    response
                } else {
                    return Err(RemoteBridgeError::Transient(
                        relay_request_error(response, "relay pairing status").await,
                    ));
                };
                let response = response
                    .json::<PairingStatusResponse>()
                    .await
                    .map_err(|error| format!("failed to parse relay pairing status: {error}"))?;

                if let Some(client_bundle) = response.client_bundle.as_ref() {
                    verify_pairing_public_key_bundle(client_bundle).map_err(|error| {
                        RemoteBridgeError::Persistent(format!(
                            "relay pairing returned an invalid client bundle: {error}"
                        ))
                    })?;
                }

                if response.status == falcondeck_core::PairingStatus::Expired {
                    return Err(RemoteBridgeError::Persistent(
                        "relay pairing expired before it was claimed".to_string(),
                    ));
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
                        RemoteBridgeError::Persistent(
                            "relay pairing completed without client key material".to_string(),
                        )
                    })?;
                    break (session_id, device_id, Some(client_bundle));
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
                current_pairing.client_bundle = client_bundle.clone();
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

        self.connect_remote_session(
            relay_url,
            daemon_token,
            session_id,
            pairing,
            client_bundle,
            command_rx,
        )
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
                Ok(response) => {
                    let response = if response.status().is_success() {
                        response
                    } else {
                        self.set_pairing_watch_error(
                            &relay_url,
                            &daemon_token,
                            &pairing_id,
                            relay_request_error(response, "relay pairing status").await,
                        )
                        .await;
                        sleep(Duration::from_secs(2)).await;
                        continue;
                    };

                    match response.json::<PairingStatusResponse>().await {
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
                    }
                }
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

            if let Some(client_bundle) = response.client_bundle.as_ref()
                && let Err(error) = verify_pairing_public_key_bundle(client_bundle)
            {
                self.set_pairing_watch_error(
                    &relay_url,
                    &daemon_token,
                    &pairing_id,
                    format!("relay pairing returned an invalid client bundle: {error}"),
                )
                .await;
                sleep(Duration::from_secs(2)).await;
                continue;
            }

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
                        if let Some(current_pairing) = remote.pending_pairing.as_mut()
                            && current_pairing.pairing_id == pairing_id
                        {
                            current_pairing.session_id = response.session_id.clone();
                            current_pairing.client_bundle = response.client_bundle.clone();
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
                            if let Some(current_pairing) = remote.pending_pairing.as_ref()
                                && current_pairing.pairing_id == pairing_id
                            {
                                remote.last_error = Some(
                                    "remote pairing expired before it was claimed".to_string(),
                                );
                            }
                            remote.pending_pairing = None;
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

                    let (command_to_publish, should_persist) = {
                        let mut remote = self.inner.remote.lock().await;
                        if remote.relay_url.as_deref() != Some(relay_url.as_str())
                            || remote.daemon_token.as_deref() != Some(daemon_token.as_str())
                            || remote
                                .pending_pairing
                                .as_ref()
                                .is_none_or(|current_pairing| {
                                    current_pairing.pairing_id != pairing_id
                                })
                        {
                            (None, false)
                        } else {
                            let Some(current_pairing) = remote.pending_pairing.as_mut() else {
                                return;
                            };
                            current_pairing.session_id = Some(session_id);
                            current_pairing.device_id = Some(device_id);
                            current_pairing.client_bundle = Some(client_bundle.clone());
                            if current_pairing.trusted_at.is_none() {
                                current_pairing.trusted_at = Some(Utc::now());
                            }
                            let pairing_snapshot = current_pairing.clone();
                            remote.pending_pairing = None;
                            remote.pairing_watch_task = None;
                            if let Some(command_tx) = remote.command_tx.clone() {
                                remote.last_error = None;
                                (
                                    Some((
                                        command_tx,
                                        RemoteBridgeCommand::PublishBootstrap {
                                            pairing: Box::new(pairing_snapshot),
                                            client_bundle: Box::new(client_bundle),
                                        },
                                    )),
                                    true,
                                )
                            } else {
                                remote.last_error = Some(
                                    "Additional remote pairing finished after the desktop relay bridge stopped. Generate a fresh pairing code.".to_string(),
                                );
                                remote.status = if remote
                                    .pairing
                                    .as_ref()
                                    .is_some_and(|pairing| pairing.device_id.is_some())
                                {
                                    RemoteConnectionStatus::Offline
                                } else {
                                    RemoteConnectionStatus::Inactive
                                };
                                (None, true)
                            }
                        }
                    };

                    if let Some((command_tx, command)) = command_to_publish {
                        let _ = command_tx.send(command);
                    }
                    if should_persist {
                        let _ = self.persist_local_state().await;
                    }
                    return;
                }
            }
        }
    }

    pub(super) async fn resume_remote_bridge(
        &self,
        remote: PersistedRemoteState,
    ) -> Result<(), DaemonError> {
        let secure_storage_key = remote.secure_storage_key.clone().unwrap_or_else(|| {
            remote_secret_storage_key(
                &remote.relay_url,
                &remote.pairing_id,
                remote.session_id.as_deref(),
            )
        });
        let secrets = load_remote_secrets(&remote, &secure_storage_key)?;
        let local_key_pair = LocalBoxKeyPair::from_secret_key_base64(
            &secrets.local_secret_key_base64,
        )
        .map_err(|error| {
            DaemonError::BadRequest(format!("invalid persisted local key pair: {error}"))
        })?;
        let data_key = decode_fixed_base64::<32>(&secrets.data_key_base64).map_err(|error| {
            DaemonError::BadRequest(format!("invalid persisted relay data key: {error}"))
        })?;
        let pairing = RemotePairingState {
            pairing_id: remote.pairing_id,
            pairing_code: remote.pairing_code,
            session_id: remote.session_id,
            device_id: remote.device_id,
            trusted_at: remote.trusted_at,
            expires_at: remote.expires_at,
            client_bundle: remote.client_bundle,
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
            current.pending_pairing = None;
            current.last_error = None;

            let (command_tx, command_rx) = mpsc::unbounded_channel();
            let app = self.clone();
            let task = tokio::spawn(async move {
                app.run_remote_bridge(relay_url, daemon_token, command_rx)
                    .await;
            });
            current.command_tx = Some(command_tx);
            current.task = Some(task);
        }

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

pub(super) fn build_remote_status_response(remote: &RemoteBridgeState) -> RemoteStatusResponse {
    let status = effective_remote_status(remote);
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
                    status: if matches!(&status, RemoteConnectionStatus::Revoked) {
                        falcondeck_core::TrustedDeviceStatus::Revoked
                    } else {
                        falcondeck_core::TrustedDeviceStatus::Active
                    },
                    created_at: trusted_at,
                    last_seen_at: matches!(&status, RemoteConnectionStatus::Connected)
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
                daemon_connected: matches!(&status, RemoteConnectionStatus::Connected),
                last_seen_at: matches!(&status, RemoteConnectionStatus::Connected).then(Utc::now),
            })
    });

    RemoteStatusResponse {
        status,
        relay_url: remote.relay_url.clone(),
        pairing: response_pairing(remote).map(|pairing| pairing.to_response()),
        trusted_devices,
        presence,
        last_error: remote.last_error.clone(),
    }
}

fn status_pairing(remote: &RemoteBridgeState) -> Option<&RemotePairingState> {
    remote.pending_pairing.as_ref().or(remote.pairing.as_ref())
}

pub(super) fn prune_finished_remote_tasks(remote: &mut RemoteBridgeState) {
    if remote.task.as_ref().is_some_and(|task| task.is_finished()) {
        remote.task = None;
        remote.command_tx = None;
    }
    if remote
        .pairing_watch_task
        .as_ref()
        .is_some_and(|task| task.is_finished())
    {
        remote.pairing_watch_task = None;
    }
}

fn clear_unserviceable_pending_pairing(remote: &mut RemoteBridgeState) {
    if remote.pending_pairing.is_none() {
        return;
    }

    if let Some(task) = remote.pairing_watch_task.take() {
        task.abort();
    }
    remote.pending_pairing = None;
    remote.last_error.get_or_insert_with(|| {
        "Additional remote pairing was cancelled because the desktop relay bridge stopped. Generate a fresh pairing code.".to_string()
    });
}

pub(super) fn reconcile_remote_runtime_state(remote: &mut RemoteBridgeState) {
    prune_finished_remote_tasks(remote);

    if remote.task.is_none() && remote.pending_pairing.is_some() {
        clear_unserviceable_pending_pairing(remote);
    }

    if remote.pairing_watch_task.is_none() && remote.pending_pairing.is_some() {
        clear_unserviceable_pending_pairing(remote);
    }

    if remote.task.is_none() {
        remote.command_tx = None;
        if !matches!(
            remote.status,
            RemoteConnectionStatus::Inactive
                | RemoteConnectionStatus::Revoked
                | RemoteConnectionStatus::Error
        ) {
            remote.status = if remote
                .pairing
                .as_ref()
                .is_some_and(|pairing| pairing.device_id.is_some())
            {
                RemoteConnectionStatus::Offline
            } else {
                RemoteConnectionStatus::Inactive
            };
        }
    }
}

pub(super) fn has_live_remote_task(remote: &RemoteBridgeState) -> bool {
    remote.task.is_some()
}

fn effective_remote_status(remote: &RemoteBridgeState) -> RemoteConnectionStatus {
    if has_live_remote_task(remote)
        || matches!(
            remote.status,
            RemoteConnectionStatus::Inactive
                | RemoteConnectionStatus::Revoked
                | RemoteConnectionStatus::Error
        )
    {
        return remote.status.clone();
    }

    if remote
        .pairing
        .as_ref()
        .is_some_and(|pairing| pairing.device_id.is_some())
    {
        RemoteConnectionStatus::Offline
    } else {
        RemoteConnectionStatus::Inactive
    }
}

fn response_pairing(remote: &RemoteBridgeState) -> Option<&RemotePairingState> {
    has_live_remote_task(remote)
        .then(|| status_pairing(remote))
        .flatten()
}

pub(super) fn current_pairing_for_remote_attempt(
    remote: &RemoteBridgeState,
    relay_url: &str,
    daemon_token: &str,
) -> Option<RemotePairingState> {
    if remote.relay_url.as_deref() != Some(relay_url)
        || remote.daemon_token.as_deref() != Some(daemon_token)
    {
        return None;
    }

    remote.pairing.clone()
}
