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
            "question".to_owned(),
            Some("workspace".to_owned()),
            Some("thread".to_owned()),
            Some("Native parity".to_owned()),
            None,
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
        .dispatch_push_notifications(
            "session",
            "question".to_owned(),
            None,
            Some("thread".to_owned()),
            None,
            None,
        )
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
        .dispatch_push_notifications(
            "session",
            "question".to_owned(),
            None,
            Some("thread".to_owned()),
            None,
            None,
        )
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
            "turn-complete".to_owned(),
            None,
            Some("other-thread".to_owned()),
            None,
            None,
        )
        .await;
    assert!(events.try_recv().is_err());
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
