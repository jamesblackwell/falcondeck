//! Storage API tests use only a private data root and never run cleanup on HOME.
use falcondeck_core::{
    HealthResponse,
    storage::{StoragePreferences, StorageReport},
};
use falcondeck_daemon::{DaemonConfig, spawn_embedded};
#[tokio::test]
async fn storage_api_reports_disk_persists_switches_and_requires_confirmation() {
    falcondeck_daemon::disable_real_provider_binaries_for_tests();
    let root = tempfile::tempdir().unwrap();
    let daemon = spawn_embedded(DaemonConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        state_path: Some(root.path().join("state.json")),
        background_restore: false,
        ..Default::default()
    })
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let url = daemon.base_url();
    let health: HealthResponse = client
        .get(format!("{url}/api/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(health.ok);
    assert!(health.free_bytes.is_some());
    assert_eq!(health.volumes.len(),1);
    assert!(health.volumes[0].free_bytes.is_some());
    let p = StoragePreferences {
        scheduled: false,
        clear_caches: false,
        reclaim_checkouts: false,
        delete_old_artifacts: false,
        delete_old_experiments: false,
        warnings: false,
    };
    let saved: StoragePreferences = client
        .patch(format!("{url}/api/storage/preferences"))
        .json(&p)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved, p);
    let report: StorageReport = client
        .get(format!("{url}/api/storage"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(report.preferences, p);
    assert!(report.free_bytes.is_some());
    assert!(report.variants.is_empty());
    assert_eq!(report.volumes.len(),health.volumes.len());
    assert_eq!(report.volumes[0].id,health.volumes[0].id);
    assert!(report.volumes[0].free_bytes.is_some());
    for (path, body) in [
        ("cleanup", serde_json::json!({"confirmed":false})),
        (
            "snapshots",
            serde_json::json!({"targets":[],"confirmed":true}),
        ),
        (
            "snapshots",
            serde_json::json!({"targets":[{"workspace_id":"x","thread_id":"x"}],"confirmed":false}),
        ),
        (
            "variant",
            serde_json::json!({"workspace_id":"x","thread_id":"x","action":"reclaim","confirmed":false}),
        ),
    ] {
        let response = client
            .post(format!("{url}/api/storage/{path}"))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
    let snapshots=client.post(format!("{url}/api/storage/snapshots"))
        .json(&serde_json::json!({"targets":[{"workspace_id":"missing","thread_id":"missing"}],"confirmed":true}))
        .send().await.unwrap().error_for_status().unwrap()
        .json::<falcondeck_core::storage::StorageRun>().await.unwrap();
    assert!(snapshots.finished_at.is_some());
    assert!(
        snapshots
            .entries
            .iter()
            .any(|entry| entry.contains("Unknown workspace"))
    );
    let response = client
        .post(format!("{url}/api/storage/cleanup"))
        .json(&serde_json::json!({"confirmed":true}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    daemon.shutdown().await.unwrap();
}
