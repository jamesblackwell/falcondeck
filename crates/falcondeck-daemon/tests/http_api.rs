use std::path::PathBuf;

use chrono::Duration;
use falcondeck_core::{
    ClaimPairingRequest, ClaimPairingResponse, DaemonSnapshot, HealthResponse,
    PairingChallengeRequest, PairingChallengeResponse, RelayUpdateBody, RelayUpdatesResponse,
    RemoteStatusResponse, StartRemotePairingRequest, WorkspaceStatus,
    crypto::{
        LocalBoxKeyPair, LocalIdentityKeyPair, build_pairing_public_key_bundle,
        sign_pairing_claim_challenge,
    },
};
use falcondeck_daemon::{DaemonConfig, spawn_embedded};
use falcondeck_relay::{AppState as RelayState, router as relay_router};
use tempfile::TempDir;

fn test_config() -> DaemonConfig {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let _ = temp_dir.keep();
    DaemonConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        state_path: Some(state_path),
        ..DaemonConfig::default()
    }
}

fn test_config_with_state_path(state_path: PathBuf) -> DaemonConfig {
    DaemonConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        state_path: Some(state_path),
        ..DaemonConfig::default()
    }
}

async fn spawn_relay(temp_dir: &TempDir) -> String {
    let state = RelayState::load(
        "test".to_string(),
        temp_dir.path().join("relay-state.json"),
        Duration::seconds(300),
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, relay_router(state)).await.unwrap();
    });
    format!("http://{addr}")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .expect("repo root")
        .to_path_buf()
}

#[tokio::test]
async fn health_and_snapshot_routes_work_with_cors() {
    let daemon = spawn_embedded(test_config()).await.unwrap();
    let client = reqwest::Client::new();

    let health = client
        .get(format!("{}/api/health", daemon.base_url()))
        .header("Origin", "http://127.0.0.1:1420")
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), reqwest::StatusCode::OK);
    assert_eq!(
        health.headers().get("access-control-allow-origin").unwrap(),
        "http://127.0.0.1:1420"
    );
    let health: HealthResponse = health.json().await.unwrap();
    assert!(health.ok);

    let snapshot = client
        .get(format!("{}/api/snapshot", daemon.base_url()))
        .send()
        .await
        .unwrap();
    let snapshot: DaemonSnapshot = snapshot.json().await.unwrap();
    assert!(snapshot.workspaces.is_empty());

    let preflight = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/api/workspaces/connect", daemon.base_url()),
        )
        .header("Origin", "http://127.0.0.1:1420")
        .header("Access-Control-Request-Method", "POST")
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), reqwest::StatusCode::OK);
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "http://127.0.0.1:1420"
    );

    // Foreign web origins must not be granted CORS access to the
    // unauthenticated approval API.
    let foreign = client
        .get(format!("{}/api/health", daemon.base_url()))
        .header("Origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), reqwest::StatusCode::OK);
    assert!(
        foreign
            .headers()
            .get("access-control-allow-origin")
            .is_none()
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn rejects_requests_with_non_loopback_host_headers() {
    let daemon = spawn_embedded(test_config()).await.unwrap();
    let client = reqwest::Client::new();

    // DNS rebinding: the browser resolves an attacker hostname to 127.0.0.1,
    // so the request arrives with a foreign Host header. It must be refused.
    let rebound = client
        .get(format!("{}/api/health", daemon.base_url()))
        .header(reqwest::header::HOST, "evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(rebound.status(), reqwest::StatusCode::FORBIDDEN);

    // A normal loopback request (reqwest sets Host to 127.0.0.1:<port>).
    let normal = client
        .get(format!("{}/api/health", daemon.base_url()))
        .send()
        .await
        .unwrap();
    assert_eq!(normal.status(), reqwest::StatusCode::OK);

    // The Claude hook posts with curl semantics: no Origin header, loopback
    // Host. It must keep working.
    let hook = client
        .post(format!(
            "{}/api/claude/hooks/pre-tool-use",
            daemon.base_url()
        ))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(hook.status(), reqwest::StatusCode::OK);

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn connect_workspace_bootstraps_codex_when_available() {
    if std::process::Command::new("codex")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }

    let daemon = spawn_embedded(test_config()).await.unwrap();
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/api/workspaces/connect", daemon.base_url()))
        .json(&serde_json::json!({
            "path": repo_root()
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let workspace: falcondeck_core::WorkspaceSummary = response.json().await.unwrap();
    assert_eq!(workspace.path, repo_root().to_string_lossy());
    assert!(matches!(
        workspace.status,
        WorkspaceStatus::Ready | WorkspaceStatus::NeedsAuth
    ));

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn remote_pairing_streams_snapshot_updates_into_the_relay() {
    let relay_dir = tempfile::tempdir().unwrap();
    let relay_base = spawn_relay(&relay_dir).await;
    let daemon = spawn_embedded(test_config()).await.unwrap();
    let client = reqwest::Client::new();

    let remote = client
        .post(format!("{}/api/remote/pairing", daemon.base_url()))
        .json(&StartRemotePairingRequest {
            relay_url: relay_base.clone(),
        })
        .send()
        .await
        .unwrap()
        .json::<RemoteStatusResponse>()
        .await
        .unwrap();

    let pairing = remote.pairing.unwrap();
    let claim = claim_pairing_with_challenge(
        &client,
        &relay_base,
        &pairing.pairing_code,
        "remote-web-test",
        &LocalBoxKeyPair::generate(),
    )
    .await;

    let mut connected = false;
    for _ in 0..20 {
        let status = client
            .get(format!("{}/api/remote/status", daemon.base_url()))
            .send()
            .await
            .unwrap()
            .json::<RemoteStatusResponse>()
            .await
            .unwrap();
        if status.status == falcondeck_core::RemoteConnectionStatus::Connected {
            connected = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert!(connected, "daemon never connected to relay");

    let response = client
        .post(format!("{}/api/workspaces/connect", daemon.base_url()))
        .json(&serde_json::json!({
            "path": repo_root()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);

    let updates = client
        .get(format!(
            "{relay_base}/v1/sessions/{}/updates?after_seq=0",
            claim.session_id
        ))
        .bearer_auth(claim.client_token)
        .send()
        .await
        .unwrap()
        .json::<falcondeck_core::RelayUpdatesResponse>()
        .await
        .unwrap();

    assert!(
        updates.updates.iter().any(|update| matches!(
            update.body,
            falcondeck_core::RelayUpdateBody::SessionBootstrap { .. }
        )),
        "relay updates should include encrypted session bootstrap material"
    );
    assert!(
        updates.updates.iter().any(|update| matches!(
            update.body,
            falcondeck_core::RelayUpdateBody::Encrypted { .. }
        )),
        "relay updates should include encrypted daemon events"
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn trusted_remote_reconnects_after_daemon_restart_without_repairing() {
    let relay_dir = tempfile::tempdir().unwrap();
    let daemon_dir = tempfile::tempdir().unwrap();
    let state_path = daemon_dir.path().join("daemon-state.json");
    let relay_base = spawn_relay(&relay_dir).await;
    let client = reqwest::Client::new();

    let mut daemon = spawn_embedded(test_config_with_state_path(state_path.clone()))
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        daemon.wait_until_restored(),
    )
    .await
    .expect("initial daemon state restoration timed out")
    .expect("initial daemon state restoration task failed");
    let remote = client
        .post(format!("{}/api/remote/pairing", daemon.base_url()))
        .json(&StartRemotePairingRequest {
            relay_url: relay_base.clone(),
        })
        .send()
        .await
        .unwrap()
        .json::<RemoteStatusResponse>()
        .await
        .unwrap();
    let pairing = remote.pairing.unwrap();
    let claim = claim_pairing_with_challenge(
        &client,
        &relay_base,
        &pairing.pairing_code,
        "restart-test-phone",
        &LocalBoxKeyPair::generate(),
    )
    .await;
    let first_status = wait_for_connected(&client, &daemon.base_url(), "initial pairing").await;
    assert_eq!(
        first_status
            .presence
            .as_ref()
            .map(|presence| presence.session_id.as_str()),
        Some(claim.session_id.as_str())
    );
    // The code is spent once a device claims it, so it must stop being offered.
    assert!(first_status.pairing.is_none());
    daemon.shutdown().await.unwrap();

    let persisted_after_shutdown: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(&state_path)
            .await
            .expect("shutdown should leave a persisted daemon state file"),
    )
    .expect("persisted daemon state should be valid JSON");
    assert_eq!(
        persisted_after_shutdown.pointer("/remote/device_id"),
        Some(&serde_json::Value::String(claim.device_id.clone())),
        "shutdown must durably retain the trusted remote before restart: {persisted_after_shutdown}"
    );

    let mut restarted = spawn_embedded(test_config_with_state_path(state_path))
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        restarted.wait_until_restored(),
    )
    .await
    .expect("restarted daemon state restoration timed out")
    .expect("restarted daemon state restoration task failed");
    let restored_status =
        wait_for_connected(&client, &restarted.base_url(), "restart restoration").await;
    let restored_presence = restored_status
        .presence
        .as_ref()
        .expect("trusted session should restore");
    assert_eq!(restored_presence.session_id, claim.session_id);
    assert!(restored_status.pairing.is_none());
    assert_eq!(restored_status.trusted_devices.len(), 1);
    assert_eq!(
        restored_status.trusted_devices[0].device_id,
        claim.device_id
    );

    restarted.shutdown().await.unwrap();
}

#[tokio::test]
async fn additional_remote_pairings_reuse_the_session_and_publish_a_new_bootstrap() {
    let relay_dir = tempfile::tempdir().unwrap();
    let relay_base = spawn_relay(&relay_dir).await;
    let daemon = spawn_embedded(test_config()).await.unwrap();
    let client = reqwest::Client::new();

    let first_remote = client
        .post(format!("{}/api/remote/pairing", daemon.base_url()))
        .json(&StartRemotePairingRequest {
            relay_url: relay_base.clone(),
        })
        .send()
        .await
        .unwrap()
        .json::<RemoteStatusResponse>()
        .await
        .unwrap();
    let first_pairing = first_remote.pairing.unwrap();
    let first_claim = claim_pairing_with_challenge(
        &client,
        &relay_base,
        &first_pairing.pairing_code,
        "phone",
        &LocalBoxKeyPair::generate(),
    )
    .await;

    wait_for_connected(&client, &daemon.base_url(), "additional pairing").await;

    let second_remote = client
        .post(format!("{}/api/remote/pairing", daemon.base_url()))
        .json(&StartRemotePairingRequest {
            relay_url: relay_base.clone(),
        })
        .send()
        .await
        .unwrap()
        .json::<RemoteStatusResponse>()
        .await
        .unwrap();
    let second_pairing = second_remote.pairing.unwrap();
    assert_eq!(
        second_pairing.session_id.as_deref(),
        Some(first_claim.session_id.as_str())
    );

    let second_key_pair = LocalBoxKeyPair::generate();
    let second_client_public_key = second_key_pair.public_key_base64().to_string();
    let second_claim = claim_pairing_with_challenge(
        &client,
        &relay_base,
        &second_pairing.pairing_code,
        "tablet",
        &second_key_pair,
    )
    .await;

    assert_eq!(second_claim.session_id, first_claim.session_id);
    assert_ne!(second_claim.device_id, first_claim.device_id);

    let final_status = wait_for_trusted_device_count(&client, &daemon.base_url(), 2).await;
    assert_eq!(final_status.trusted_devices.len(), 2);

    let second_updates = wait_for_device_bootstrap(
        &client,
        &relay_base,
        &second_claim.session_id,
        &second_claim.client_token,
        &second_client_public_key,
    )
    .await;

    assert!(
        second_updates.updates.iter().any(|update| {
            matches!(
                &update.body,
                RelayUpdateBody::SessionBootstrap { material }
                    if material.client_public_key == second_client_public_key
            )
        }),
        "second trusted device should receive its own bootstrap material"
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn keyless_trusted_client_can_request_a_fresh_bootstrap_over_the_ephemeral_channel() {
    use futures_util::SinkExt;

    let relay_dir = tempfile::tempdir().unwrap();
    let relay_base = spawn_relay(&relay_dir).await;
    let daemon = spawn_embedded(test_config()).await.unwrap();
    let client = reqwest::Client::new();

    let remote = client
        .post(format!("{}/api/remote/pairing", daemon.base_url()))
        .json(&StartRemotePairingRequest {
            relay_url: relay_base.clone(),
        })
        .send()
        .await
        .unwrap()
        .json::<RemoteStatusResponse>()
        .await
        .unwrap();
    let pairing = remote.pairing.unwrap();
    let device_key_pair = LocalBoxKeyPair::generate();
    let device_public_key = device_key_pair.public_key_base64().to_string();
    let claim = claim_pairing_with_challenge(
        &client,
        &relay_base,
        &pairing.pairing_code,
        "keyless-client-test",
        &device_key_pair,
    )
    .await;

    wait_for_connected(&client, &daemon.base_url(), "keyless bootstrap").await;

    // The initial connect already publishes a bootstrap for the paired
    // device; remember how many exist so the re-request is distinguishable.
    let initial_updates = wait_for_device_bootstrap(
        &client,
        &relay_base,
        &claim.session_id,
        &claim.client_token,
        &device_public_key,
    )
    .await;
    let initial_bootstrap_count = count_device_bootstraps(&initial_updates, &device_public_key);

    // Simulate a trusted device that still holds its client token and local
    // key pair but lost the session data key: connect a plain client
    // websocket and ask for a fresh bootstrap over the ephemeral channel.
    let ticket = client
        .post(format!(
            "{relay_base}/v1/sessions/{}/ws-ticket",
            claim.session_id
        ))
        .bearer_auth(&claim.client_token)
        .send()
        .await
        .unwrap()
        .json::<falcondeck_core::RelayWebSocketTicketResponse>()
        .await
        .unwrap();
    let ws_base = relay_base.replace("http://", "ws://");
    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "{ws_base}/v1/updates/ws?session_id={}&ticket={}",
        claim.session_id, ticket.ticket
    ))
    .await
    .unwrap();
    let send_bootstrap_request = |bundle: falcondeck_core::PairingPublicKeyBundle| {
        serde_json::to_string(&serde_json::json!({
            "type": "ephemeral",
            "body": {
                "kind": "request-bootstrap",
                "device_id": claim.device_id,
                "client_bundle": bundle,
            },
        }))
        .unwrap()
    };

    // A fresh self-signed bundle (what a compromised relay could mint) is
    // sent first; it must be ignored because it never completed pairing.
    let attacker_bundle = build_pairing_public_key_bundle(&LocalBoxKeyPair::generate());
    let attacker_public_key = attacker_bundle.public_key.clone();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            send_bootstrap_request(attacker_bundle).into(),
        ))
        .await
        .unwrap();

    // The device's own pairing bundle must be served a fresh bootstrap.
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            send_bootstrap_request(build_pairing_public_key_bundle(&device_key_pair)).into(),
        ))
        .await
        .unwrap();

    // The daemon must answer with a durable SessionBootstrap wrapped to the
    // requester's public key, delivered through the normal replay path.
    let mut republished = None;
    for _ in 0..40 {
        let updates =
            fetch_relay_updates(&client, &relay_base, &claim.session_id, &claim.client_token).await;
        if count_device_bootstraps(&updates, &device_public_key) > initial_bootstrap_count {
            republished = Some(updates);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let updates =
        republished.expect("keyless client should receive bootstrap material for its own bundle");

    // The websocket delivers messages in order, so by the time the device's
    // re-request was served the attacker request had already been processed —
    // and it must not have produced any bootstrap material.
    assert_eq!(
        count_device_bootstraps(&updates, &attacker_public_key),
        0,
        "an unpaired self-signed bundle must never be served the data key"
    );

    daemon.shutdown().await.unwrap();
}

/// Relay claims are challenge-bound: request a single-use challenge, sign it
/// with the client identity secret key, then claim with the signature.
async fn claim_pairing_with_challenge(
    client: &reqwest::Client,
    relay_base: &str,
    pairing_code: &str,
    label: &str,
    key_pair: &LocalBoxKeyPair,
) -> ClaimPairingResponse {
    let challenge = client
        .post(format!("{relay_base}/v1/pairings/challenge"))
        .json(&PairingChallengeRequest {
            pairing_code: pairing_code.to_string(),
        })
        .send()
        .await
        .unwrap()
        .json::<PairingChallengeResponse>()
        .await
        .unwrap();
    let identity = LocalIdentityKeyPair::from_box_key_pair(key_pair);
    client
        .post(format!("{relay_base}/v1/pairings/claim"))
        .json(&ClaimPairingRequest {
            pairing_code: pairing_code.to_string(),
            label: Some(label.to_string()),
            client_bundle: Some(build_pairing_public_key_bundle(key_pair)),
            challenge_signature: sign_pairing_claim_challenge(
                &identity,
                pairing_code,
                &challenge.challenge,
            ),
        })
        .send()
        .await
        .unwrap()
        .json::<ClaimPairingResponse>()
        .await
        .unwrap()
}

async fn wait_for_connected(
    client: &reqwest::Client,
    daemon_base_url: &str,
    phase: &str,
) -> RemoteStatusResponse {
    // A full workspace test run can briefly starve the bridge task while
    // native integration binaries start in parallel. Keep this bounded, but
    // allow the production reconnect supervisor enough time for more than one
    // backoff attempt before diagnosing a failure.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let status = client
            .get(format!("{daemon_base_url}/api/remote/status"))
            .send()
            .await
            .unwrap()
            .json::<RemoteStatusResponse>()
            .await
            .unwrap();
        if status.status == falcondeck_core::RemoteConnectionStatus::Connected {
            return status;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("daemon never connected to relay during {phase}; last status: {status:?}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

async fn wait_for_trusted_device_count(
    client: &reqwest::Client,
    daemon_base_url: &str,
    expected_devices: usize,
) -> RemoteStatusResponse {
    for _ in 0..40 {
        let status = client
            .get(format!("{daemon_base_url}/api/remote/status"))
            .send()
            .await
            .unwrap()
            .json::<RemoteStatusResponse>()
            .await
            .unwrap();
        if status.trusted_devices.len() >= expected_devices {
            return status;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    panic!("daemon never reported {expected_devices} trusted devices");
}

async fn fetch_relay_updates(
    client: &reqwest::Client,
    relay_base: &str,
    session_id: &str,
    client_token: &str,
) -> RelayUpdatesResponse {
    client
        .get(format!(
            "{relay_base}/v1/sessions/{session_id}/updates?after_seq=0"
        ))
        .bearer_auth(client_token)
        .send()
        .await
        .unwrap()
        .json::<RelayUpdatesResponse>()
        .await
        .unwrap()
}

fn count_device_bootstraps(updates: &RelayUpdatesResponse, client_public_key: &str) -> usize {
    updates
        .updates
        .iter()
        .filter(|update| {
            matches!(
                &update.body,
                RelayUpdateBody::SessionBootstrap { material }
                    if material.client_public_key == client_public_key
            )
        })
        .count()
}

async fn wait_for_device_bootstrap(
    client: &reqwest::Client,
    relay_base: &str,
    session_id: &str,
    client_token: &str,
    expected_client_public_key: &str,
) -> RelayUpdatesResponse {
    for _ in 0..40 {
        let updates = fetch_relay_updates(client, relay_base, session_id, client_token).await;
        if count_device_bootstraps(&updates, expected_client_public_key) > 0 {
            return updates;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    panic!("relay never published bootstrap material for the new trusted device");
}
