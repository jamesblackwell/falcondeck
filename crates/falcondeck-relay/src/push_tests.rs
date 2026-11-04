use super::*;
use crate::persistence::PersistenceBackend;
use axum::{Json, extract::State, http::HeaderMap, routing::post};
use falcondeck_core::{ApnsEnvironment, PushRegistration};

async fn mock_server() -> (
    String,
    mpsc::Receiver<(HeaderMap, serde_json::Value)>,
    tokio::task::JoinHandle<()>,
) {
    let (sender, receiver) = mpsc::channel(10);
    let router = axum::Router::new()
        .route(
            "/{*path}",
            post(
                |State(sender): State<mpsc::Sender<(HeaderMap, serde_json::Value)>>,
                 headers: HeaderMap,
                 Json(payload): Json<serde_json::Value>| async move {
                    sender.send((headers, payload)).await.unwrap();
                    Json(serde_json::json!({"data":[{"status":"ok"}]}))
                },
            ),
        )
        .with_state(sender);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/send", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (endpoint, receiver, task)
}

fn notify(kind: &str, thread_id: Option<String>) -> RelayNotifyRequest {
    RelayNotifyRequest {
        kind: kind.to_owned(),
        workspace_id: None,
        thread_id,
        thread_title: None,
        message_preview: None,
        review_id: None,
    }
}

fn state(directory: &tempfile::TempDir, expo: String, apns: Option<Arc<ApnsProvider>>) -> AppState {
    let now = Utc::now();
    let mut session: SessionRecord=serde_json::from_value(serde_json::json!({"session_id":"session","pairing_id":"pairing","daemon_token":"daemon","created_at":now,"updated_at":now,"updates":[]})).unwrap();
    for id in ["expo", "native"] {
        let device: TrustedDeviceRecord = serde_json::from_value(
            serde_json::json!({"device_id":id,"client_token":id,"created_at":now}),
        )
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
    let mut state = AppState::from_parts(
        "test".to_owned(),
        Duration::minutes(10),
        RetentionConfig::default(),
        data,
        backend,
        true,
    );
    let inner = Arc::get_mut(&mut state.inner).unwrap();
    inner.push_endpoint = expo;
    inner.apns = apns;
    state
}

fn native(token: &str) -> PushRegistration {
    PushRegistration::Apns {
        token: token.to_owned(),
        topic: "org.example.native".to_owned(),
        environment: ApnsEnvironment::Sandbox,
    }
}

#[tokio::test]
async fn expo_and_native_receive_separate_payloads_and_persist_across_restart() {
    let (expo, mut expo_events, expo_task) = mock_server().await;
    let (apns, mut apns_events, apns_task) = mock_server().await;
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(ApnsProvider::mock(apns));
    let state = state(&directory, expo, Some(provider));
    state
        .register_push_token(
            "session",
            "expo",
            "expo",
            Some("ExponentPushToken[legacy]".to_owned()),
        )
        .await
        .unwrap();
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    state
        .dispatch_push_notifications(
            "session",
            RelayNotifyRequest {
                workspace_id: Some("workspace".to_owned()),
                thread_title: Some("Native parity".to_owned()),
                ..notify("question", Some("thread".to_owned()))
            },
        )
        .await;
    let (_, expo) = tokio::time::timeout(StdDuration::from_secs(5), expo_events.recv())
        .await
        .unwrap()
        .unwrap();
    let (headers, apns) = tokio::time::timeout(StdDuration::from_secs(5), apns_events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(expo[0]["to"], "ExponentPushToken[legacy]");
    assert_eq!(expo[0]["data"]["threadId"], "thread");
    assert_eq!(headers["apns-topic"], "org.example.native");
    assert_eq!(headers["apns-push-type"], "alert");
    assert!(
        headers["authorization"]
            .to_str()
            .unwrap()
            .starts_with("Bearer ")
    );
    assert_eq!(apns["aps"]["alert"]["title"], "Native parity");
    assert_eq!(apns["threadId"], "thread");
    let saved = crate::persistence::load_file_state(&directory.path().join("state.json"))
        .await
        .unwrap();
    let devices = &saved.sessions["session"].devices;
    assert_eq!(
        devices["expo"].push_token.as_deref(),
        Some("ExponentPushToken[legacy]")
    );
    assert_eq!(
        devices["native"]
            .push_registration
            .as_ref()
            .unwrap()
            .registration,
        native("aabb")
    );
    expo_task.abort();
    apns_task.abort();
}

#[tokio::test]
async fn late_native_rejection_cannot_clear_a_replacement_or_expo_token() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(
        &directory,
        String::new(),
        Some(Arc::new(ApnsProvider::mock("http://127.0.0.1".to_owned()))),
    );
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    let old = state.inner.store.lock().await.data.sessions["session"].devices["native"].clone();
    state
        .register_push_registration("session", "native", "native", Some(native("ccdd")))
        .await
        .unwrap();
    state
        .clear_dead_native_registration(
            "session",
            "native",
            old.persist_generation,
            old.push_registration.as_ref().unwrap(),
        )
        .await;
    assert_eq!(
        state.inner.store.lock().await.data.sessions["session"].devices["native"]
            .push_registration
            .as_ref()
            .unwrap()
            .registration,
        native("ccdd")
    );
    state
        .register_push_token(
            "session",
            "native",
            "native",
            Some("ExponentPushToken[new]".to_owned()),
        )
        .await
        .unwrap();
    state
        .clear_dead_native_registration(
            "session",
            "native",
            old.persist_generation,
            old.push_registration.as_ref().unwrap(),
        )
        .await;
    assert_eq!(
        state.inner.store.lock().await.data.sessions["session"].devices["native"]
            .push_token
            .as_deref(),
        Some("ExponentPushToken[new]")
    );
}

#[tokio::test]
async fn absent_apns_cannot_replace_legacy_registration_and_own_device_auth_remains() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, "http://127.0.0.1".to_owned(), None);
    state
        .register_push_token(
            "session",
            "expo",
            "expo",
            Some("ExponentPushToken[old]".to_owned()),
        )
        .await
        .unwrap();
    assert!(
        state
            .register_push_registration("session", "expo", "expo", Some(native("aabb")))
            .await
            .is_err()
    );
    assert!(
        state
            .register_push_registration("session", "native", "expo", None)
            .await
            .is_err()
    );
    assert_eq!(
        state.inner.store.lock().await.data.sessions["session"].devices["expo"]
            .push_token
            .as_deref(),
        Some("ExponentPushToken[old]")
    );
    assert!(state.push_capabilities().apns.is_empty());
}

#[tokio::test]
async fn background_client_can_receive_push_without_closing_rpc_socket() {
    let (endpoint, mut events, task) = mock_server().await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(
        &directory,
        String::new(),
        Some(Arc::new(ApnsProvider::mock(endpoint))),
    );
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    let (peer, _queue, ready) = state
        .register_peer("session", RelayPeerRole::Client, Some("native".to_owned()))
        .await
        .unwrap();
    assert!(matches!(
        ready,
        RelayServerMessage::Ready {
            client_activity_supported: true,
            ..
        }
    ));
    state
        .dispatch_push_notifications("session", notify("question", Some("thread".to_owned())))
        .await;
    assert!(
        events.try_recv().is_err(),
        "legacy/foreground clients retain suppression"
    );
    state
        .handle_message(
            "session",
            &peer,
            RelayPeerRole::Client,
            RelayClientMessage::ClientActivity { foreground: false },
        )
        .await
        .unwrap();
    state
        .dispatch_push_notifications("session", notify("question", Some("thread".to_owned())))
        .await;
    assert!(
        tokio::time::timeout(StdDuration::from_secs(5), events.recv())
            .await
            .unwrap()
            .is_some()
    );
    state
        .handle_message(
            "session",
            &peer,
            RelayPeerRole::Client,
            RelayClientMessage::Ping,
        )
        .await
        .unwrap();
    state
        .handle_message(
            "session",
            &peer,
            RelayPeerRole::Client,
            RelayClientMessage::ClientActivity { foreground: true },
        )
        .await
        .unwrap();
    state
        .dispatch_push_notifications(
            "session",
            notify("turn-complete", Some("other-thread".to_owned())),
        )
        .await;
    assert!(events.try_recv().is_err());
    task.abort();
}

fn review(id: &str) -> RelayNotifyRequest {
    RelayNotifyRequest {
        review_id: Some(id.to_owned()),
        message_preview: Some(format!("Juno needs a decision: {id}")),
        ..notify("review", Some("bot-home".to_owned()))
    }
}

async fn next_push(
    events: &mut mpsc::Receiver<(HeaderMap, serde_json::Value)>,
) -> (HeaderMap, serde_json::Value) {
    tokio::time::timeout(StdDuration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn a_review_reaches_a_device_whose_socket_still_looks_live() {
    let (endpoint, mut events, task) = mock_server().await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(
        &directory,
        String::new(),
        Some(Arc::new(ApnsProvider::mock(endpoint))),
    );
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    let (_peer, _queue, _ready) = state
        .register_peer("session", RelayPeerRole::Client, Some("native".to_owned()))
        .await
        .unwrap();
    state
        .dispatch_push_notifications("session", notify("question", Some("thread".to_owned())))
        .await;
    assert!(events.try_recv().is_err(), "other kinds keep suppression");
    state
        .dispatch_push_notifications("session", review("R-1"))
        .await;
    let (_, payload) = next_push(&mut events).await;
    assert_eq!(payload["reviewId"], "R-1");
    assert_eq!(payload["kind"], "review");
    assert_eq!(
        payload["aps"]["alert"]["body"],
        "Juno needs a decision: R-1"
    );
    task.abort();
}

#[tokio::test]
async fn reviews_dedupe_per_review_and_never_collapse_into_each_other() {
    let (endpoint, mut events, task) = mock_server().await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(
        &directory,
        String::new(),
        Some(Arc::new(ApnsProvider::mock(endpoint))),
    );
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    for id in ["R-1", "R-1", "R-2"] {
        state
            .dispatch_push_notifications("session", review(id))
            .await;
    }
    let (first, first_payload) = next_push(&mut events).await;
    let (second, second_payload) = next_push(&mut events).await;
    let mut ids = [
        first_payload["reviewId"].clone(),
        second_payload["reviewId"].clone(),
    ];
    ids.sort_by_key(|id| id.to_string());
    assert_eq!(ids, ["R-1", "R-2"]);
    assert_ne!(first["apns-collapse-id"], second["apns-collapse-id"]);
    tokio::time::sleep(StdDuration::from_millis(100)).await;
    assert!(events.try_recv().is_err(), "the repeat of R-1 is dropped");
    task.abort();
}

#[tokio::test]
async fn delivery_health_reports_registration_and_last_result_per_device() {
    let router = axum::Router::new().route(
        "/3/device/{token}",
        post(|| async {
            (
                axum::http::StatusCode::FORBIDDEN,
                Json(serde_json::json!({"reason":"TopicDisallowed"})),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let directory = tempfile::tempdir().unwrap();
    let state = state(
        &directory,
        String::new(),
        Some(Arc::new(ApnsProvider::mock(endpoint))),
    );
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    state
        .dispatch_push_notifications("session", review("R-1"))
        .await;
    let record = tokio::time::timeout(StdDuration::from_secs(5), async {
        loop {
            let response = state.trusted_devices_response("session").await.unwrap();
            let push = response
                .devices
                .iter()
                .find(|device| device.device_id == "native")
                .and_then(|device| device.push.clone())
                .unwrap();
            if let Some(record) = push.last_delivery {
                assert_eq!(push.provider.as_deref(), Some("apns"));
                return record;
            }
            tokio::time::sleep(StdDuration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(record.outcome, PushDeliveryOutcome::Rejected);
    assert_eq!(record.kind, "review");
    assert_eq!(record.detail.as_deref(), Some("APNs 403 TopicDisallowed"));
    let unregistered = state.trusted_devices_response("session").await.unwrap();
    let expo = unregistered
        .devices
        .iter()
        .find(|device| device.device_id == "expo")
        .unwrap();
    assert_eq!(
        expo.push,
        Some(DevicePushHealth {
            provider: None,
            last_delivery: None
        })
    );
    task.abort();
}

#[tokio::test]
async fn test_push_bypasses_presence_and_reports_each_device() {
    let (endpoint, mut events, task) = mock_server().await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(
        &directory,
        String::new(),
        Some(Arc::new(ApnsProvider::mock(endpoint))),
    );
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    let (_peer, _queue, _ready) = state
        .register_peer("session", RelayPeerRole::Client, Some("native".to_owned()))
        .await
        .unwrap();
    assert!(matches!(
        state.send_test_push("session", "native").await,
        Err(RelayError::Unauthorized(_))
    ));
    let mut results = state
        .send_test_push("session", "daemon")
        .await
        .unwrap()
        .results;
    results.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].device_id, "expo");
    assert_eq!(
        (results[0].provider.as_deref(), results[0].outcome),
        (None, None)
    );
    assert_eq!(results[1].provider.as_deref(), Some("apns"));
    assert_eq!(results[1].outcome, Some(PushDeliveryOutcome::Accepted));
    assert_eq!(next_push(&mut events).await.1["kind"], "test");
    assert!(matches!(
        state.send_test_push("session", "daemon").await,
        Err(RelayError::TooManyRequests(_))
    ));
    task.abort();
}

#[tokio::test]
async fn test_push_clears_a_token_expo_calls_dead_and_names_other_failures() {
    let router = axum::Router::new().route(
        "/send",
        post(|Json(payload): Json<serde_json::Value>| async move {
            let token = payload[0]["to"].as_str().unwrap_or_default();
            let error = if token.contains("dead") {
                "DeviceNotRegistered"
            } else {
                "MismatchSenderId"
            };
            Json(serde_json::json!({"data":[{"status":"error","details":{"error":error}}]}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/send", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, endpoint, None);
    for (device, token) in [
        ("expo", "ExponentPushToken[dead]"),
        ("native", "ExponentPushToken[old]"),
    ] {
        state
            .register_push_token("session", device, device, Some(token.to_owned()))
            .await
            .unwrap();
    }
    let results = state
        .send_test_push("session", "daemon")
        .await
        .unwrap()
        .results;
    for result in results {
        if result.device_id == "expo" {
            assert_eq!(result.outcome, Some(PushDeliveryOutcome::Unregistered));
        } else {
            assert_eq!(result.outcome, Some(PushDeliveryOutcome::Rejected));
            assert_eq!(result.detail.as_deref(), Some("MismatchSenderId"));
        }
    }
    let store = state.inner.store.lock().await;
    let devices = &store.data.sessions["session"].devices;
    assert!(devices["expo"].push_token.is_none());
    assert!(devices["native"].push_token.is_some());
    drop(store);
    task.abort();
}

#[tokio::test]
async fn a_review_dropped_at_capacity_is_not_acknowledged_and_can_retry() {
    let (endpoint, mut events, task) = mock_server().await;
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(ApnsProvider::mock(endpoint));
    let state = state(&directory, String::new(), Some(provider.clone()));
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    let permits = std::iter::from_fn(|| provider.reserve()).collect::<Vec<_>>();
    assert!(matches!(
        state.notify("session", "daemon", review("R-1")).await,
        Err(RelayError::TooManyRequests(_))
    ));
    drop(permits);
    state
        .notify("session", "daemon", review("R-1"))
        .await
        .unwrap();
    assert_eq!(next_push(&mut events).await.1["reviewId"], "R-1");
    task.abort();
}

#[tokio::test]
async fn http_notify_is_daemon_only_and_validated() {
    let (endpoint, mut events, task) = mock_server().await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(
        &directory,
        String::new(),
        Some(Arc::new(ApnsProvider::mock(endpoint))),
    );
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    assert!(matches!(
        state.notify("session", "native", review("R-1")).await,
        Err(RelayError::Unauthorized(_))
    ));
    let mut bad = review("R-1");
    bad.review_id = Some("x".repeat(300));
    assert!(matches!(
        state.notify("session", "daemon", bad).await,
        Err(RelayError::BadRequest(_))
    ));
    state
        .notify("session", "daemon", review("R-1"))
        .await
        .unwrap();
    assert_eq!(next_push(&mut events).await.1["reviewId"], "R-1");
    task.abort();
}

#[tokio::test]
#[ignore = "set FALCONDECK_RELAY_TEST_DATABASE_URL to an isolated PostgreSQL test database"]
async fn native_and_legacy_registrations_round_trip_in_postgres_with_generation_guards() {
    let url = std::env::var("FALCONDECK_RELAY_TEST_DATABASE_URL").unwrap();
    let backend = Arc::new(
        crate::persistence::PostgresBackend::connect(&url)
            .await
            .unwrap(),
    );
    let directory = tempfile::tempdir().unwrap();
    let mut state = state(
        &directory,
        "http://127.0.0.1".to_owned(),
        Some(Arc::new(ApnsProvider::mock("http://127.0.0.1".to_owned()))),
    );
    let data = state.inner.store.lock().await.data.clone();
    let session = &data.sessions["session"];
    backend
        .persist_pairing(Some(&session.meta()), None)
        .await
        .unwrap();
    for device in session.devices.values() {
        backend
            .persist_device(&session.meta(), Some(device), true)
            .await
            .unwrap();
    }
    let inner = Arc::get_mut(&mut state.inner).unwrap();
    inner.backend = backend.clone();
    inner.needs_flush = false;
    state
        .register_push_token(
            "session",
            "expo",
            "expo",
            Some("ExponentPushToken[unchanged]".to_owned()),
        )
        .await
        .unwrap();
    state
        .register_push_registration("session", "native", "native", Some(native("aabb")))
        .await
        .unwrap();
    let old = state.inner.store.lock().await.data.sessions["session"].devices["native"].clone();
    state
        .register_push_registration("session", "native", "native", Some(native("ccdd")))
        .await
        .unwrap();
    backend
        .persist_device(&session.meta(), Some(&old), false)
        .await
        .unwrap();
    let loaded = crate::persistence::load_postgres_state(&backend)
        .await
        .unwrap();
    assert_eq!(
        loaded.sessions["session"].devices["native"]
            .push_registration
            .as_ref()
            .unwrap()
            .registration,
        native("ccdd")
    );
    assert_eq!(
        loaded.sessions["session"].devices["expo"]
            .push_token
            .as_deref(),
        Some("ExponentPushToken[unchanged]")
    );
    state
        .register_push_registration("session", "native", "native", None)
        .await
        .unwrap();
    let loaded = crate::persistence::load_postgres_state(&backend)
        .await
        .unwrap();
    assert!(
        loaded.sessions["session"].devices["native"]
            .push_registration
            .is_none()
    );
    backend
        .remove_sessions(&["session".to_owned()])
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires an isolated FALCONDECK_RELAY_TEST_DATABASE_URL with schema creation privileges"]
async fn postgres_upgrade_preserves_existing_client_tokens_push_and_replay_sequence() {
    let url = std::env::var("FALCONDECK_RELAY_TEST_DATABASE_URL").unwrap();
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    let connection = tokio::spawn(async move {
        connection.await.unwrap();
    });
    let schema = format!("native_upgrade_{}", Uuid::new_v4().simple());
    client
        .batch_execute(&format!(
            "CREATE SCHEMA {schema}; SET search_path TO {schema};"
        ))
        .await
        .unwrap();
    client
        .batch_execute(include_str!("../tests/fixtures/pre-native-push.sql"))
        .await
        .unwrap();
    let daemon = secret_verifier("legacy-daemon");
    let bearer = secret_verifier("legacy-client");
    client.execute("INSERT INTO relay_sessions (session_id,pairing_id,daemon_token,created_at,updated_at,next_seq,oldest_lost_seq) VALUES ('legacy-session','pairing',$1,NOW(),NOW(),71,70)",&[&daemon]).await.unwrap();
    client.execute("INSERT INTO relay_devices (session_id,device_id,client_token,created_at,push_token) VALUES ('legacy-session','legacy-device',$1,NOW(),'ExponentPushToken[existing]')",&[&bearer]).await.unwrap();
    let mut scoped = reqwest::Url::parse(&url).unwrap();
    scoped
        .query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={schema}"));
    let state = AppState::load_postgres_with_retention(
        "upgrade-test".to_owned(),
        scoped.to_string(),
        Duration::minutes(10),
        RetentionConfig::default(),
    )
    .await
    .unwrap();
    state
        .authenticate_session("legacy-session", "legacy-client")
        .await
        .unwrap();
    state
        .register_push_token(
            "legacy-session",
            "legacy-client",
            "legacy-device",
            Some("ExponentPushToken[rotated]".to_owned()),
        )
        .await
        .unwrap();
    let device=client.query_one("SELECT client_token,push_token,persist_generation,push_registration FROM relay_devices WHERE device_id='legacy-device'",&[]).await.unwrap();
    assert_eq!(device.get::<_, String>("client_token"), bearer);
    assert_eq!(
        device.get::<_, String>("push_token"),
        "ExponentPushToken[rotated]"
    );
    assert_eq!(device.get::<_, i64>("persist_generation"), 1);
    assert!(
        device
            .get::<_, Option<serde_json::Value>>("push_registration")
            .is_none()
    );
    let session=client.query_one("SELECT next_seq,oldest_lost_seq,daemon_token FROM relay_sessions WHERE session_id='legacy-session'",&[]).await.unwrap();
    assert_eq!(session.get::<_, i64>("next_seq"), 71);
    assert_eq!(session.get::<_, i64>("oldest_lost_seq"), 70);
    assert_eq!(session.get::<_, String>("daemon_token"), daemon);
    drop(state);
    let restarted = AppState::load_postgres_with_retention(
        "upgrade-test".to_owned(),
        scoped.to_string(),
        Duration::minutes(10),
        RetentionConfig::default(),
    )
    .await
    .unwrap();
    restarted
        .authenticate_session("legacy-session", "legacy-client")
        .await
        .unwrap();
    drop(restarted);
    client
        .batch_execute(&format!(
            "SET search_path TO public; DROP SCHEMA {schema} CASCADE;"
        ))
        .await
        .unwrap();
    drop(client);
    connection.await.unwrap();
}
