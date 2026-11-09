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
    for (path, body) in [
        ("cleanup", serde_json::json!({"confirmed":false})),
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
        assert!(
            response.status().is_client_error(),
            "{path}: {}",
            response.status()
        );
    }
    let response = client
        .post(format!("{url}/api/storage/cleanup"))
        .json(&serde_json::json!({"confirmed":true}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    daemon.shutdown().await.unwrap();
}
