use std::path::PathBuf;

use chrono::Duration;
use falcondeck_core::{
    ClaimPairingRequest, ClaimPairingResponse, DaemonSnapshot, EncryptionVariant, HealthResponse,
    PairingPublicKeyBundle, RemoteStatusResponse, StartRemotePairingRequest, WorkspaceStatus,
    crypto::LocalBoxKeyPair,
};
use falcondeck_daemon::{DaemonConfig, spawn_embedded};
use falcondeck_relay::{AppState as RelayState, router as relay_router};
use tempfile::TempDir;

fn test_config() -> DaemonConfig {
    DaemonConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
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

fn test_bundle() -> PairingPublicKeyBundle {
    let key_pair = LocalBoxKeyPair::generate();
    PairingPublicKeyBundle {
        encryption_variant: EncryptionVariant::DataKeyV1,
        public_key: key_pair.public_key_base64().to_string(),
    }
}
