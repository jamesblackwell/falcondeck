//! Encrypted report hosting: who may do what, the bounds, and retention.
use super::*;

fn state(directory: &tempfile::TempDir) -> AppState {
    let now = Utc::now();
    let mut session: SessionRecord = serde_json::from_value(serde_json::json!({
        "session_id": "session", "pairing_id": "pairing", "daemon_token": "daemon",
        "created_at": now, "updated_at": now, "updates": []
    }))
    .unwrap();
    for (id, revoked) in [("phone", None), ("old-phone", Some(now))] {
        let device: TrustedDeviceRecord = serde_json::from_value(serde_json::json!({
            "device_id": id, "client_token": id, "created_at": now, "revoked_at": revoked
        }))
        .unwrap();
        session.devices.insert(id.to_owned(), device);
    }
    let data = PersistedState {
        sessions: HashMap::from([("session".to_owned(), session)]),
        ..Default::default()
    };
    let backend = Arc::new(crate::persistence::FileBackend::new(
        directory.path().join("state.json"),
    ));
    AppState::from_parts(
        "test".to_owned(),
        Duration::minutes(10),
        RetentionConfig::default(),
        data,
        backend,
        true,
    )
}

fn report(bytes: usize, ttl_seconds: i64) -> PutRelayReportRequest {
    PutRelayReportRequest {
        envelope: EncryptedEnvelope {
            snapshot_hint: false,
            encryption_variant: Default::default(),
            ciphertext: "x".repeat(bytes),
            scope_hint: None,
        },
        ttl_seconds,
    }
}

const DAY: i64 = 24 * 60 * 60;

#[tokio::test]
async fn capabilities_advertise_the_limits_a_client_must_respect() {
    let directory = tempfile::tempdir().unwrap();
    let reports = state(&directory).push_capabilities().reports.unwrap();
    assert_eq!(reports.max_bytes, MAX_REPORT_BYTES);
    assert_eq!(reports.max_ttl_seconds, 30 * DAY);
}

#[test]
fn a_relay_that_omits_reports_means_no_report_calls() {
    let capabilities: RelayPushCapabilities =
        serde_json::from_str(r#"{"expo":true,"apns":[]}"#).unwrap();
    assert!(capabilities.reports.is_none());
}

#[tokio::test]
async fn the_daemon_stores_and_a_paired_device_reads() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory);
    let stored = state
        .put_report("session", "daemon", "rpt_1", report(100, DAY))
        .await
        .unwrap();
    assert_eq!(stored.size_bytes, 100);
    let read = state.get_report("session", "phone", "rpt_1").await.unwrap();
    assert_eq!(read.envelope.ciphertext.len(), 100);
    let list = state.list_reports("session", "phone").await.unwrap();
    assert_eq!(list.reports, [stored]);
}

#[tokio::test]
async fn only_the_daemon_may_store_and_revoked_devices_read_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory);
    let forged = state
        .put_report("session", "phone", "rpt_1", report(10, DAY))
        .await;
    assert!(matches!(forged, Err(RelayError::Unauthorized(_))));
    state
        .put_report("session", "daemon", "rpt_1", report(10, DAY))
        .await
        .unwrap();
    for token in ["old-phone", "nobody"] {
        assert!(matches!(
            state.get_report("session", token, "rpt_1").await,
            Err(RelayError::Unauthorized(_))
        ));
        assert!(matches!(
            state.list_reports("session", token).await,
            Err(RelayError::Unauthorized(_))
        ));
    }
}

#[tokio::test]
async fn sizes_ids_and_ttls_are_bounded() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory);
    for (id, request) in [
        ("rpt_big", report(MAX_REPORT_BYTES + 1, DAY)),
        ("rpt_empty", report(0, DAY)),
        ("rpt_ttl", report(10, 0)),
        ("../escape", report(10, DAY)),
    ] {
        assert!(
            matches!(
                state.put_report("session", "daemon", id, request).await,
                Err(RelayError::BadRequest(_))
            ),
            "{id}"
        );
    }
    let stored = state
        .put_report("session", "daemon", "rpt_max", report(10, 365 * DAY))
        .await
        .unwrap();
    assert!(stored.expires_at <= Utc::now() + Duration::seconds(30 * DAY));
}

#[tokio::test]
async fn expired_reports_are_unreadable_at_once_and_pruned_on_the_next_pass() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory);
    state
        .put_report("session", "daemon", "rpt_1", report(10, DAY))
        .await
        .unwrap();
    state
        .inner
        .store
        .lock()
        .await
        .data
        .sessions
        .get_mut("session")
        .unwrap()
        .reports
        .get_mut("rpt_1")
        .unwrap()
        .expires_at = Utc::now() - Duration::seconds(1);
    assert!(matches!(
        state.get_report("session", "phone", "rpt_1").await,
        Err(RelayError::NotFound(_))
    ));
    assert!(
        state
            .list_reports("session", "phone")
            .await
            .unwrap()
            .reports
            .is_empty()
    );
    state.force_prune().await.unwrap();
    assert!(
        state.inner.store.lock().await.data.sessions["session"]
            .reports
            .is_empty()
    );
}

#[tokio::test]
async fn rewriting_a_report_keeps_its_age_for_key_rotation() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory);
    let first = state
        .put_report("session", "daemon", "rpt_1", report(10, DAY))
        .await
        .unwrap();
    let second = state
        .put_report("session", "daemon", "rpt_1", report(20, DAY))
        .await
        .unwrap();
    assert_eq!(second.created_at, first.created_at);
    assert_eq!(second.size_bytes, 20);
    assert_eq!(
        state
            .list_reports("session", "phone")
            .await
            .unwrap()
            .reports
            .len(),
        1
    );
}

#[tokio::test]
async fn a_session_over_its_quota_loses_its_oldest_reports_first() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory);
    let full = MAX_REPORT_BYTES_PER_SESSION / MAX_REPORT_BYTES;
    for index in 0..full {
        state
            .put_report(
                "session",
                "daemon",
                &format!("rpt_{index}"),
                report(MAX_REPORT_BYTES, DAY),
            )
            .await
            .unwrap();
    }
    state
        .put_report(
            "session",
            "daemon",
            "rpt_new",
            report(MAX_REPORT_BYTES, DAY),
        )
        .await
        .unwrap();
    let list = state.list_reports("session", "phone").await.unwrap();
    assert_eq!(list.reports.len(), full);
    assert_eq!(list.reports[0].report_id, "rpt_new");
    assert!(matches!(
        state.get_report("session", "phone", "rpt_0").await,
        Err(RelayError::NotFound(_))
    ));
}

#[tokio::test]
async fn reports_survive_a_restart_of_a_file_backed_relay() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory);
    state
        .put_report("session", "daemon", "rpt_1", report(10, DAY))
        .await
        .unwrap();
    let saved = serde_json::to_value(&state.inner.store.lock().await.data).unwrap();
    assert_eq!(
        saved["sessions"]["session"]["reports"]["rpt_1"]["report_id"],
        "rpt_1"
    );
    let on_disk = std::fs::read_to_string(directory.path().join("state.json")).unwrap();
    assert!(
        on_disk.contains("rpt_1"),
        "the store is written before the daemon is told"
    );
}

#[test]
fn a_notice_push_carries_its_ids_and_an_older_push_does_not() {
    let notice = crate::push::apns_payload(
        "Title",
        "Body",
        "s",
        Some("w"),
        None,
        "agent-notice",
        None,
        "c",
        Some("N-1"),
        Some("rpt_1"),
    )
    .unwrap();
    assert_eq!(notice["notificationId"], "N-1");
    assert_eq!(notice["reportId"], "rpt_1");
    assert_eq!(notice["threadId"], serde_json::Value::Null);
    let plain = crate::push::apns_payload(
        "Title",
        "Body",
        "s",
        Some("w"),
        Some("t"),
        "turn-complete",
        None,
        "c",
        None,
        None,
    )
    .unwrap();
    assert!(plain.get("notificationId").is_none());
    assert!(plain.get("reportId").is_none());
}

#[test]
fn notice_text_is_the_summary_with_a_calm_fallback() {
    assert_eq!(
        push_notification_content("agent-notice", Some("Deploy finished"), Some("All green.")),
        ("Deploy finished", "All green.")
    );
    assert_eq!(
        push_notification_content("agent-notice", None, Some("  ")),
        ("FalconDeck", "An agent sent you a notice")
    );
}
