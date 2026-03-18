use std::path::PathBuf;

use chrono::Duration;
use falcondeck_core::{
    ClaimPairingRequest, ClaimPairingResponse, DaemonSnapshot, HealthResponse,
    PairingPublicKeyBundle, RelayUpdateBody, RelayUpdatesResponse, RemoteStatusResponse,
    StartRemotePairingRequest, WorkspaceStatus,
    crypto::{LocalBoxKeyPair, build_pairing_public_key_bundle},
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
        "*"
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
        "*"
    );

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
    let claim = client
        .post(format!("{relay_base}/v1/pairings/claim"))
        .json(&ClaimPairingRequest {
            pairing_code: pairing.pairing_code.clone(),
            label: Some("remote-web-test".to_string()),
            client_bundle: Some(test_bundle()),
        })
        .send()
        .await
        .unwrap()
        .json::<ClaimPairingResponse>()
        .await
        .unwrap();

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
    let first_claim = client
        .post(format!("{relay_base}/v1/pairings/claim"))
        .json(&ClaimPairingRequest {
            pairing_code: first_pairing.pairing_code.clone(),
            label: Some("phone".to_string()),
            client_bundle: Some(test_bundle()),
        })
        .send()
        .await
        .unwrap()
        .json::<ClaimPairingResponse>()
        .await
        .unwrap();

    wait_for_connected(&client, &daemon.base_url()).await;

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

    let second_bundle = test_bundle();
    let second_client_public_key = second_bundle.public_key.clone();
    let second_claim = client
        .post(format!("{relay_base}/v1/pairings/claim"))
        .json(&ClaimPairingRequest {
            pairing_code: second_pairing.pairing_code.clone(),
            label: Some("tablet".to_string()),
            client_bundle: Some(second_bundle),
        })
        .send()
        .await
        .unwrap()
        .json::<ClaimPairingResponse>()
        .await
        .unwrap();

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

fn test_bundle() -> PairingPublicKeyBundle {
    let key_pair = LocalBoxKeyPair::generate();
    build_pairing_public_key_bundle(&key_pair)
}

async fn wait_for_connected(
    client: &reqwest::Client,
    daemon_base_url: &str,
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
        if status.status == falcondeck_core::RemoteConnectionStatus::Connected {
            return status;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    panic!("daemon never connected to relay");
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

async fn wait_for_device_bootstrap(
    client: &reqwest::Client,
    relay_base: &str,
    session_id: &str,
    client_token: &str,
    expected_client_public_key: &str,
) -> RelayUpdatesResponse {
    for _ in 0..40 {
        let updates = client
            .get(format!(
                "{relay_base}/v1/sessions/{session_id}/updates?after_seq=0"
            ))
            .bearer_auth(client_token)
            .send()
            .await
            .unwrap()
            .json::<RelayUpdatesResponse>()
            .await
            .unwrap();
        if updates.updates.iter().any(|update| {
            matches!(
                &update.body,
                RelayUpdateBody::SessionBootstrap { material }
                    if material.client_public_key == expected_client_public_key
            )
        }) {
            return updates;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    panic!("relay never published bootstrap material for the new trusted device");
}
