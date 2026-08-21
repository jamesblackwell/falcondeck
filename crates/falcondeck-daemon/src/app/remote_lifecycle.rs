use chrono::Utc;
use falcondeck_core::{
    PairingAuthority, PairingPublicKeyBundle, PairingStatusResponse, RemoteConnectionStatus,
    RemotePairingSession, RemoteStatusResponse, StartPairingRequest, StartPairingResponse,
    StartRemotePairingRequest,
    crypto::{
        LocalBoxKeyPair, build_pairing_public_key_bundle, decode_secure_pairing_code,
        encode_secure_pairing_code, generate_data_key, generate_pairing_authority_secret,
        pairing_authority_public_key, sign_pairing_authority_daemon_bundle,
        verify_pairing_authority_client_bundle, verify_pairing_authority_daemon_bundle,
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
    decode_fixed_base64, delete_remote_secrets_async, host_label, load_remote_secrets_async,
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

/// Hard cap on remembered trusted client bundles so a hostile relay replaying
/// pairing claims cannot grow the list without bound.
pub(super) const MAX_TRUSTED_CLIENT_BUNDLES: usize = 32;

/// Records a client bundle that completed a pairing claim, deduplicated by
/// encryption public key (newest bundle wins) and capped at
/// [`MAX_TRUSTED_CLIENT_BUNDLES`] (oldest entry evicted). Only bundles in this
/// list may be served the session data key through the ephemeral
/// request-bootstrap channel.
pub(super) fn remember_trusted_client_bundle(
    trusted: &mut Vec<PairingPublicKeyBundle>,
    bundle: &PairingPublicKeyBundle,
) {
    if let Some(existing) = trusted
        .iter_mut()
        .find(|existing| existing.public_key == bundle.public_key)
    {
        *existing = bundle.clone();
        return;
    }
    if trusted.len() >= MAX_TRUSTED_CLIENT_BUNDLES {
        trusted.remove(0);
    }
    trusted.push(bundle.clone());
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
        let preferences = self.preferences().await.notifications;
        let enabled_for_kind = match kind {
            "turn-complete" => preferences.notify_on_turn_complete,
            "approval" | "question" => preferences.notify_on_input_required,
            "turn-error" => preferences.notify_on_error,
            _ => preferences.enabled,
        };
        if !preferences.enabled || !enabled_for_kind {
            return;
        }
        if preferences.suppress_when_desktop_active && self.desktop_is_active() {
            return;
        }
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
        {
            let secure_storage_key = remote_secret_storage_key(
                relay_url,
                &pairing.pairing_id,
                pairing.session_id.as_deref(),
            );
            if let Err(error) = delete_remote_secrets_async(secure_storage_key).await {
                tracing::warn!("failed to clear remote secure storage: {error}");
            }
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
        remote.trusted_client_bundles.clear();
        remote.trusted_client_devices.clear();
        remote.unresumed_remote = None;
    }

    pub async fn remote_status(&self) -> RemoteStatusResponse {
        // The bridge is daemon-owned and must survive a task that exits while
        // the app is restoring state or the network is coming back. Starting
        // it here also repairs older installs that persisted a trusted
        // pairing while the in-memory bridge task was lost.
        self.ensure_remote_bridge_running().await;

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
                let response = build_remote_status_response(&remote);
                drop(remote);
                // A previous caller may have disconnected while secure
                // storage was being written. Do not return a code that only
                // exists in memory; retrying the pairing request must make
                // the pending session durable before handing it back.
                self.persist_local_state().await?;
                return Ok(response);
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
        let daemon_bundle = build_pairing_public_key_bundle(&local_key_pair);
        let pairing_authority_secret = generate_pairing_authority_secret();
        let pairing_authority = PairingAuthority {
            public_key: pairing_authority_public_key(&pairing_authority_secret).map_err(
                |error| {
                    DaemonError::Rpc(format!("failed to build secure pairing authority: {error}"))
                },
            )?,
            daemon_bundle_signature: sign_pairing_authority_daemon_bundle(
                &pairing_authority_secret,
                &daemon_bundle,
            )
            .map_err(|error| {
                DaemonError::Rpc(format!(
                    "failed to authenticate daemon pairing keys: {error}"
                ))
            })?,
        };
        let response = client
            .post(format!("{relay_url}/v1/pairings"))
            .json(&StartPairingRequest {
                label: Some(host_label()),
                ttl_seconds: Some(600),
                existing_session_id: existing_session_id.clone(),
                daemon_token: existing_daemon_token.clone(),
                daemon_bundle: Some(daemon_bundle),
                pairing_authority: Some(pairing_authority),
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

        let reused_existing_pairing = seed_pairing.is_some();
        // The state for the pairing that was just minted. Never seeded with a
        // previous pairing's device: carrying the old device_id made the
        // bridge treat the new pairing as an already-trusted restore, skip
        // claim polling entirely, and never publish a bootstrap — the newly
        // claimed phone then hung on "Securing session…" forever.
        let new_pairing_state = RemotePairingState {
            pairing_id: pairing.pairing_id.clone(),
            pairing_code: encode_secure_pairing_code(
                &pairing.pairing_code,
                &pairing_authority_secret,
            ),
            session_id: Some(pairing.session_id.clone()),
            device_id: None,
            trusted_at: None,
            expires_at: pairing.expires_at,
            client_bundle: None,
            local_key_pair,
            data_key,
        };
        // A previous pairing that already trusts a device keeps serving it:
        // the bridge reconnects with the old pairing state while the new
        // pairing is watched separately for its claim.
        let carried_pairing = seed_pairing.filter(|previous| previous.device_id.is_some());

        let response = {
            let mut remote = self.inner.remote.lock().await;
            reconcile_remote_runtime_state(&mut remote);
            let additional_pairing = remote.task.is_some();
            if let Some(task) = remote.pairing_watch_task.take() {
                task.abort();
            }
            remote.relay_url = Some(relay_url.clone());
            remote.daemon_token = Some(pairing.daemon_token.clone());
            remote.last_error = None;
            remote.unresumed_remote = None;

            if additional_pairing {
                remote.pending_pairing = Some(new_pairing_state.clone());
                let app = self.clone();
                let watch_task = tokio::spawn(async move {
                    app.watch_pairing_claim(relay_url, pairing.daemon_token, pairing.pairing_id)
                        .await;
                });
                remote.pairing_watch_task = Some(watch_task);
            } else if let Some(previous_pairing) = carried_pairing {
                // Bridge task is down but a trusted device exists: reconnect
                // for it immediately with the previous pairing state, and
                // watch the new pairing's claim on the side exactly like an
                // additional-device pairing.
                remote.status = RemoteConnectionStatus::Connecting;
                remote.pending_pairing = Some(new_pairing_state.clone());
                remote.pairing = Some(previous_pairing);
                self.spawn_remote_bridge_locked(
                    &mut remote,
                    relay_url.clone(),
                    pairing.daemon_token.clone(),
                );
                let app = self.clone();
                let watch_task = tokio::spawn(async move {
                    app.watch_pairing_claim(relay_url, pairing.daemon_token, pairing.pairing_id)
                        .await;
                });
                remote.pairing_watch_task = Some(watch_task);
            } else {
                remote.status = RemoteConnectionStatus::PairingPending;
                remote.pending_pairing = None;
                if !reused_existing_pairing {
                    // A brand-new pairing mints fresh key material; bundles
                    // trusted for the previous session must not carry over.
                    remote.trusted_client_bundles.clear();
                    remote.trusted_client_devices.clear();
                }
                remote.pairing = Some(new_pairing_state.clone());
                self.spawn_remote_bridge_locked(&mut remote, relay_url, pairing.daemon_token);
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

        let (rotation_command, rotation_completed) = {
            let mut remote = self.inner.remote.lock().await;
            let (pairing, client_bundles) = match rotate_remote_session_key(&mut remote, device_id)
            {
                Ok(rotation) => rotation,
                Err(error) => {
                    // Relay revocation has already succeeded. Stop the
                    // bridge rather than risk publishing more ciphertext
                    // under a key retained by the revoked device.
                    if let Some(task) = remote.task.take() {
                        task.abort();
                    }
                    remote.command_tx = None;
                    remote.status = RemoteConnectionStatus::Error;
                    remote.last_error = Some(error.to_string());
                    return Err(error);
                }
            };
            if let Some(command_tx) = remote.command_tx.clone() {
                let (completed_tx, completed_rx) = tokio::sync::oneshot::channel();
                (
                    Some((
                        command_tx,
                        RemoteBridgeCommand::RotateSessionKey {
                            pairing: Box::new(pairing),
                            client_bundles,
                            completed: completed_tx,
                        },
                    )),
                    Some(completed_rx),
                )
            } else {
                (None, None)
            }
        };

        // Durably replace the old data key before publishing any ciphertext
        // under the new one. A crash can then only require re-bootstrap; it
        // cannot silently restore the revoked device's key.
        if let Err(error) = self.persist_local_state().await {
            // Fail closed. Publishing with an undurable rotation could restore
            // the revoked device's old key after a crash. Removing the secret
            // store entry also prevents a stale on-disk metadata snapshot from
            // reconnecting with that key after restart; the user can safely
            // establish a fresh pairing once storage is healthy.
            let secure_storage_key = {
                let mut remote = self.inner.remote.lock().await;
                if let Some(task) = remote.task.take() {
                    task.abort();
                }
                remote.command_tx = None;
                remote.status = RemoteConnectionStatus::Error;
                remote.last_error = Some(format!(
                    "Remote access stopped because the rotated session key could not be saved: {error}"
                ));
                remote.pairing.as_ref().map(|pairing| {
                    remote_secret_storage_key(
                        &relay_url,
                        &pairing.pairing_id,
                        pairing.session_id.as_deref(),
                    )
                })
            };
            if let Some(secure_storage_key) = secure_storage_key
                && let Err(delete_error) = delete_remote_secrets_async(secure_storage_key).await
            {
                tracing::warn!(%delete_error, "failed to remove stale remote secrets after key-rotation persistence failure");
            }
            return Err(error);
        }

        let mut restart_for_rotation = false;
        if let Some((command_tx, command)) = rotation_command {
            if command_tx.send(command).is_err() {
                restart_for_rotation = true;
            } else if let Some(rotation_completed) = rotation_completed {
                match tokio::time::timeout(Duration::from_secs(20), rotation_completed).await {
                    Ok(Ok(Ok(()))) => {}
                    Ok(Ok(Err(error))) => {
                        tracing::warn!(%error, "key rotation publish failed; restarting relay bridge");
                        restart_for_rotation = true;
                    }
                    Ok(Err(_)) | Err(_) => {
                        tracing::warn!(
                            "key rotation publish did not complete; restarting relay bridge"
                        );
                        restart_for_rotation = true;
                    }
                }
            }
        } else {
            restart_for_rotation = true;
        }

        if restart_for_rotation {
            let mut remote = self.inner.remote.lock().await;
            if let Some(task) = remote.task.take() {
                task.abort();
            }
            remote.command_tx = None;
            remote.status = RemoteConnectionStatus::Connecting;
            remote.last_error = None;
            self.spawn_remote_bridge_locked(&mut remote, relay_url, daemon_token);
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
                        {
                            let secure_storage_key = remote_secret_storage_key(
                                current_relay_url,
                                &current_pairing.pairing_id,
                                current_pairing.session_id.as_deref(),
                            );
                            if let Err(error) =
                                delete_remote_secrets_async(secure_storage_key).await
                            {
                                tracing::warn!("failed to clear remote secure storage: {error}");
                            }
                        }
                        remote.relay_url = None;
                        remote.daemon_token = None;
                        remote.pairing = None;
                        remote.trusted_client_bundles.clear();
                        remote.trusted_client_devices.clear();
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

    /// Start the bridge if a persisted pairing exists but its worker task is
    /// no longer alive. This is deliberately idempotent: callers may invoke
    /// it from status polling, startup recovery, and a worker's exit path.
    async fn ensure_remote_bridge_running(&self) {
        let mut remote = self.inner.remote.lock().await;
        reconcile_remote_runtime_state(&mut remote);

        if remote.task.is_some()
            || remote.pending_pairing.is_some()
            || matches!(
                remote.status,
                RemoteConnectionStatus::Error | RemoteConnectionStatus::Revoked
            )
        {
            return;
        }

        let (Some(relay_url), Some(daemon_token), Some(pairing)) = (
            remote.relay_url.clone(),
            remote.daemon_token.clone(),
            remote.pairing.as_ref(),
        ) else {
            return;
        };

        if pairing.device_id.is_none() && pairing.expires_at <= Utc::now() {
            return;
        }

        tracing::warn!(
            pairing_id = %pairing.pairing_id,
            session_id = ?pairing.session_id,
            "restarting stopped remote relay bridge"
        );
        remote.status = if pairing.device_id.is_some() {
            RemoteConnectionStatus::Connecting
        } else {
            RemoteConnectionStatus::PairingPending
        };
        remote.last_error = None;
        self.spawn_remote_bridge_locked(&mut remote, relay_url, daemon_token);
    }

    fn spawn_remote_bridge_locked(
        &self,
        remote: &mut RemoteBridgeState,
        relay_url: String,
        daemon_token: String,
    ) {
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let app = self.clone();
        let task = tokio::spawn(async move {
            app.run_remote_bridge(relay_url, daemon_token, command_rx)
                .await;

            // A worker can finish before the next status poll (for example
            // during early startup). Respawn the supervisor from a DETACHED
            // task: calling it inline would observe this task as unfinished
            // and early-return, leaving the bridge down until the next
            // remote_status poll — which never comes when no UI is open.
            tokio::spawn(async move {
                sleep(Duration::from_secs(1)).await;
                app.ensure_remote_bridge_running().await;
            });
        });
        remote.command_tx = Some(command_tx);
        remote.task = Some(task);
    }

    async fn wait_for_claim_and_connect(
        &self,
        relay_url: String,
        daemon_token: String,
        mut pairing: RemotePairingState,
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
                    verify_pairing_status_authority(&pairing, &response)
                        .map_err(RemoteBridgeError::Persistent)?;
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

        // The authority secret is a one-use pairing grant. Once the daemon has
        // verified the claimed client, neither reconnect nor bootstrap needs
        // it, so do not retain it in memory or persisted desktop state.
        pairing.pairing_code.clear();

        {
            let mut remote = self.inner.remote.lock().await;
            remote.status = RemoteConnectionStatus::DeviceTrusted;
            if let Some(current_pairing) = remote.pairing.as_mut() {
                current_pairing.device_id = Some(device_id.clone());
                current_pairing.client_bundle = client_bundle.clone();
                current_pairing.pairing_code.clear();
                if current_pairing.trusted_at.is_none() {
                    current_pairing.trusted_at = Some(Utc::now());
                }
            }
            if let Some(bundle) = client_bundle.as_ref() {
                remember_trusted_client_bundle(&mut remote.trusted_client_bundles, bundle);
                remote
                    .trusted_client_devices
                    .insert(device_id.clone(), bundle.clone());
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

        // Persistence is required for reconnecting after a restart, but a
        // storage outage must never prevent an otherwise valid live pairing
        // from reaching the relay. The next supervised attempt will retry the
        // write while this attempt proceeds with the in-memory keys.
        if let Err(error) = self.persist_local_state().await {
            tracing::warn!(%error, "failed to persist remote pairing state before connecting");
        }

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

            if response.client_bundle.is_some() {
                let pending_pairing = {
                    let remote = self.inner.remote.lock().await;
                    remote
                        .pending_pairing
                        .as_ref()
                        .filter(|pairing| pairing.pairing_id == pairing_id)
                        .cloned()
                };
                let Some(pending_pairing) = pending_pairing else {
                    return;
                };
                if let Err(error) = verify_pairing_status_authority(&pending_pairing, &response) {
                    self.set_pairing_watch_error(&relay_url, &daemon_token, &pairing_id, error)
                        .await;
                    return;
                }
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
                        {
                            (None, false)
                        } else if remote
                            .pending_pairing
                            .as_ref()
                            .is_none_or(|current_pairing| current_pairing.pairing_id != pairing_id)
                        {
                            // The pending pairing was cleared (bridge hiccup,
                            // status churn) after the phone already claimed on
                            // the relay. The claim was still authorized on our
                            // session, so remember the bundle: the phone's
                            // periodic request-bootstrap can then recover
                            // instead of being refused forever.
                            remember_trusted_client_bundle(
                                &mut remote.trusted_client_bundles,
                                &client_bundle,
                            );
                            remote
                                .trusted_client_devices
                                .insert(device_id.clone(), client_bundle.clone());
                            (None, true)
                        } else {
                            let Some(current_pairing) = remote.pending_pairing.as_mut() else {
                                return;
                            };
                            current_pairing.session_id = Some(session_id);
                            current_pairing.device_id = Some(device_id.clone());
                            current_pairing.client_bundle = Some(client_bundle.clone());
                            if current_pairing.trusted_at.is_none() {
                                current_pairing.trusted_at = Some(Utc::now());
                            }
                            // The signed claim has consumed the one-use
                            // authority grant. Bootstrap only needs the key
                            // bundles and session data key from here onward.
                            current_pairing.pairing_code.clear();
                            let pairing_snapshot = current_pairing.clone();
                            remote.pending_pairing = None;
                            remote.pairing_watch_task = None;
                            remember_trusted_client_bundle(
                                &mut remote.trusted_client_bundles,
                                &client_bundle,
                            );
                            remote
                                .trusted_client_devices
                                .insert(device_id, client_bundle.clone());
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
        let persisted_remote = remote.clone();
        let storage_key = secure_storage_key.clone();
        let secrets = load_remote_secrets_async(persisted_remote, storage_key).await?;
        let local_key_pair = LocalBoxKeyPair::from_secret_key_base64(
            &secrets.local_secret_key_base64,
        )
        .map_err(|error| {
            DaemonError::BadRequest(format!("invalid persisted local key pair: {error}"))
        })?;
        let data_key = decode_fixed_base64::<32>(&secrets.data_key_base64).map_err(|error| {
            DaemonError::BadRequest(format!("invalid persisted relay data key: {error}"))
        })?;
        let mut trusted_client_bundles = remote.trusted_client_bundles.clone();
        let mut trusted_client_devices = remote.trusted_client_devices.clone();
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
        // Seed the allowlist with the primary device's pairing bundle so
        // installs persisted before the list existed keep keyless recovery.
        if let Some(bundle) = pairing.client_bundle.as_ref() {
            remember_trusted_client_bundle(&mut trusted_client_bundles, bundle);
            if let Some(device_id) = pairing.device_id.as_ref() {
                trusted_client_devices.insert(device_id.clone(), bundle.clone());
            }
        }

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
            current.trusted_client_bundles = trusted_client_bundles;
            current.trusted_client_devices = trusted_client_devices;
            current.last_error = None;
            current.unresumed_remote = None;
            self.spawn_remote_bridge_locked(&mut current, relay_url, daemon_token);
        }

        Ok(())
    }
}

/// Removes every bootstrap route to a revoked device and rotates the shared
/// data key. This is kept as one synchronous state transition so callers can
/// persist and publish only internally consistent state.
pub(super) fn rotate_remote_session_key(
    remote: &mut RemoteBridgeState,
    revoked_device_id: &str,
) -> Result<(RemotePairingState, Vec<PairingPublicKeyBundle>), DaemonError> {
    remote.trusted_client_devices.remove(revoked_device_id);
    // The older vector had no device ids. Rebuild it solely from the indexed
    // records so an unidentifiable legacy/revoked bundle can never receive
    // the rotated key through request-bootstrap.
    remote.trusted_client_bundles = remote.trusted_client_devices.values().cloned().collect();

    let remaining_primary = remote
        .trusted_client_devices
        .iter()
        .next()
        .map(|(device_id, bundle)| (device_id.clone(), bundle.clone()));
    let pairing = remote
        .pairing
        .as_mut()
        .ok_or_else(|| DaemonError::Rpc("remote pairing state is missing".to_string()))?;
    pairing.data_key = generate_data_key();
    if pairing.device_id.as_deref() == Some(revoked_device_id) {
        if let Some((remaining_device_id, remaining_bundle)) = remaining_primary {
            pairing.device_id = Some(remaining_device_id);
            pairing.client_bundle = Some(remaining_bundle);
        } else {
            // Keep the established session marker so the bridge can
            // reconnect, but never re-bootstrap the revoked primary.
            pairing.client_bundle = None;
        }
    }

    Ok((pairing.clone(), remote.trusted_client_bundles.clone()))
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

fn verify_pairing_status_authority(
    pairing: &RemotePairingState,
    response: &PairingStatusResponse,
) -> Result<(), String> {
    let client_bundle = response
        .client_bundle
        .as_ref()
        .ok_or_else(|| "relay pairing omitted client key material".to_string())?;
    let (relay_pairing_code, authority_secret) = decode_secure_pairing_code(&pairing.pairing_code)
        .map_err(|_| "pending pairing has no secure authority; start a new pairing".to_string())?;
    let expected_authority_public_key = pairing_authority_public_key(&authority_secret)
        .map_err(|error| format!("pending pairing authority is invalid: {error}"))?;
    let authority = response
        .pairing_authority
        .as_ref()
        .ok_or_else(|| "relay pairing omitted its secure authority".to_string())?;
    if authority.public_key != expected_authority_public_key {
        return Err("relay pairing returned an unexpected secure authority".to_string());
    }
    let daemon_bundle = response
        .daemon_bundle
        .as_ref()
        .ok_or_else(|| "relay pairing omitted daemon key material".to_string())?;
    verify_pairing_authority_daemon_bundle(
        &authority.public_key,
        daemon_bundle,
        &authority.daemon_bundle_signature,
    )
    .map_err(|_| "relay pairing substituted daemon key material".to_string())?;
    if daemon_bundle != &build_pairing_public_key_bundle(&pairing.local_key_pair) {
        return Err("relay pairing daemon key material does not match this daemon".to_string());
    }
    let claim_challenge = response
        .claim_challenge
        .as_deref()
        .ok_or_else(|| "relay pairing omitted the secure claim challenge".to_string())?;
    let authority_signature = response
        .pairing_authority_signature
        .as_deref()
        .ok_or_else(|| "relay pairing omitted the secure client proof".to_string())?;
    verify_pairing_authority_client_bundle(
        &expected_authority_public_key,
        &relay_pairing_code,
        claim_challenge,
        client_bundle,
        authority_signature,
    )
    .map_err(|_| "relay pairing substituted client key material".to_string())
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
                    // This synthesized fallback only renders when the relay's
                    // authoritative device list is unavailable; without relay
                    // reachability no device can be live, so never claim so.
                    connected: false,
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
                daemon_rpc_ready: matches!(&status, RemoteConnectionStatus::Connected),
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

/// The pairing advertised to clients as a code another device could still use.
/// A claimed pairing is spent: the relay only lets the original identity key
/// re-claim it, so a second device is always rejected. Advertising one anyway
/// is what kept the desktop showing a live-looking QR long after a phone had
/// finished pairing. Expired-but-unclaimed pairings stay visible so the UI can
/// say they expired rather than have the card vanish mid-scan.
fn response_pairing(remote: &RemoteBridgeState) -> Option<&RemotePairingState> {
    has_live_remote_task(remote)
        .then(|| status_pairing(remote))
        .flatten()
        .filter(|pairing| pairing.device_id.is_none())
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
