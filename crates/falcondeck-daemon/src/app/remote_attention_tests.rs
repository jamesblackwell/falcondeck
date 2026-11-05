use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{Json, http::StatusCode, routing::post};
use falcondeck_core::{NotificationPreferences, RelayNotifyRequest};

use super::*;
use crate::app::{AppState, RemotePairingState};

fn preferences(suppress: bool) -> NotificationPreferences {
    NotificationPreferences {
        suppress_when_desktop_active: suppress,
        ..Default::default()
    }
}

#[test]
fn desktop_activity_never_holds_back_a_review() {
    let prefs = preferences(true);
    assert_eq!(
        attention_policy("review", &prefs, true),
        AttentionPolicy::Deliver
    );
    for kind in ["approval", "question", "turn-complete", "turn-error"] {
        assert_eq!(
            attention_policy(kind, &prefs, true),
            AttentionPolicy::DesktopActive,
            "{kind}"
        );
        assert_eq!(
            attention_policy(kind, &prefs, false),
            AttentionPolicy::Deliver
        );
    }
}

#[test]
fn notification_preferences_still_silence_reviews() {
    let off = NotificationPreferences {
        notify_on_input_required: false,
        ..preferences(false)
    };
    assert_eq!(
        attention_policy("review", &off, false),
        AttentionPolicy::OffByPreference
    );
    let master = NotificationPreferences {
        enabled: false,
        ..preferences(false)
    };
    assert_eq!(
        attention_policy("review", &master, false),
        AttentionPolicy::OffByPreference
    );
}

#[test]
fn counters_separate_each_outcome_per_kind() {
    let mut counters = BTreeMap::new();
    count_push(&mut counters, "review", PushOutcome::Delivered);
    count_push(&mut counters, "review", PushOutcome::Lost);
    count_push(&mut counters, "approval", PushOutcome::DesktopActive);
    count_push(&mut counters, "approval", PushOutcome::OffByPreference);
    count_push(&mut counters, "approval", PushOutcome::Settled);
    count_push(&mut counters, "approval", PushOutcome::Expired);
    count_push(&mut counters, "approval", PushOutcome::Evicted);
    assert_eq!(
        (counters["review"].delivered, counters["review"].lost),
        (1, 1)
    );
    let approval = &counters["approval"];
    assert_eq!(approval.suppressed_desktop_active, 1);
    assert_eq!(approval.suppressed_preferences, 1);
    assert_eq!(
        (approval.settled, approval.expired, approval.evicted),
        (1, 1, 1)
    );
    assert_eq!(approval.delivered, 0);
    assert!(counters["review"].last_at.is_some());
}

#[test]
fn review_retries_finish_inside_the_relay_dedupe_window() {
    let total: std::time::Duration = NOTIFY_RETRY_DELAYS
        .iter()
        .map(|delay| *delay + NOTIFY_ATTEMPT_TIMEOUT)
        .sum();
    assert!(total < std::time::Duration::from_secs(60), "{total:?}");
}

/// A relay whose notify endpoint answers with `statuses` in order.
async fn relay(statuses: Vec<u16>) -> (String, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let router = axum::Router::new().route(
        "/v1/sessions/session/notify",
        post(move |Json(request): Json<RelayNotifyRequest>| {
            match request.kind.as_str() {
                "agent-notice" => {
                    assert_eq!(request.notification_id.as_deref(), Some("N-1"));
                    assert_eq!(request.report_id.as_deref(), Some("rpt_1"));
                    assert_eq!(request.thread_title.as_deref(), Some("Deploy finished"));
                }
                _ => assert_eq!(request.review_id.as_deref(), Some("R-1")),
            }
            let call = counter.fetch_add(1, Ordering::SeqCst);
            let status = statuses[call.min(statuses.len() - 1)];
            async move { StatusCode::from_u16(status).unwrap() }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, calls)
}

fn test_pairing() -> RemotePairingState {
    RemotePairingState {
        pairing_id: "pairing".to_string(),
        pairing_code: "code".to_string(),
        session_id: Some("session".to_string()),
        device_id: None,
        trusted_at: None,
        expires_at: Utc::now(),
        client_bundle: None,
        local_key_pair: falcondeck_core::crypto::LocalBoxKeyPair::generate(),
        data_key: [0; 32],
    }
}

/// A phone to deliver to, for tests that only care what would be pushed.
pub(in crate::app) async fn pair_for_tests(app: &AppState) {
    let mut remote = app.inner.remote.lock().await;
    remote.pairing.get_or_insert_with(test_pairing);
}

async fn app_with_relay(url: &str, directory: &tempfile::TempDir) -> AppState {
    let app = AppState::new_with_state_path(
        "test".to_string(),
        Default::default(),
        directory.path().join("state.json"),
    );
    {
        let mut remote = app.inner.remote.lock().await;
        remote.relay_url = Some(url.to_string());
        remote.daemon_token = Some("daemon".to_string());
        remote.pairing = Some(test_pairing());
    }
    app
}

fn review() -> AttentionPush {
    AttentionPush {
        kind: "review",
        preview: Some("Juno needs a decision: Pricing".to_string()),
        review_id: Some("R-1".to_string()),
        ..AttentionPush::default()
    }
}

async fn counters(app: &AppState) -> falcondeck_core::AttentionDeliveryCounter {
    let status = build_remote_status_response(&*app.inner.remote.lock().await);
    status.attention.into_iter().next().unwrap_or_default()
}

fn approval() -> AttentionPush {
    AttentionPush {
        kind: "approval",
        notification_id: Some("N-1".to_string()),
        thread_id: Some("thread-1".to_string()),
        ..AttentionPush::default()
    }
}

async fn held_ids(app: &AppState) -> Vec<Option<String>> {
    let mut ids = vec![];
    while let Some(push) = app.next_held_push().await {
        ids.push(push.notification_id.clone());
        app.push_written().await;
    }
    ids
}

async fn age_held_pushes(app: &AppState, minutes: i64) {
    let mut remote = app.inner.remote.lock().await;
    for held in &mut remote.held_pushes.queue {
        held.held_at -= chrono::Duration::minutes(minutes);
    }
}

/// A recorded request, its record id, and the push that announced it.
async fn recorded_request(app: &AppState, key: &str) -> AttentionPush {
    let record = app
        .inner
        .notifications
        .record(
            crate::notification_store::NewNotification {
                kind: falcondeck_core::notifications::NotificationKind::InputRequired,
                title: "Task".to_string(),
                preview: "Approval needed".to_string(),
                bot: None,
                thread_id: Some("thread-1".to_string()),
                workspace_id: Some("workspace-1".to_string()),
                target: None,
                importance: falcondeck_core::notifications::NotificationImportance::Normal,
                dedupe_key: Some(key.to_string()),
                coalesce: false,
                sender: None,
                body: None,
            },
            Utc::now(),
        )
        .await;
    AttentionPush {
        notification_id: Some(record.record().id.clone()),
        ..approval()
    }
}

#[tokio::test]
async fn a_review_the_relay_will_not_take_waits_for_the_socket() {
    let (url, _calls) = relay(vec![404]).await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    app.deliver_acknowledged(review()).await;
    let waiting = counters(&app).await;
    assert_eq!((waiting.held, waiting.delivered), (1, 0));
    let push = app.next_held_push().await.unwrap();
    assert_eq!(push.review_id.as_deref(), Some("R-1"));
}

/// The reviewer's repro: nothing took the push, and a bridge coming back does
/// not make it lost and delivered at once.
#[tokio::test]
async fn a_held_push_that_goes_out_counts_once_as_delivered() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(approval()).await;
    let waiting = counters(&app).await;
    assert_eq!(
        (waiting.held, waiting.delivered, waiting.lost),
        (1, 0, 0),
        "waiting, not lost"
    );
    assert_eq!(held_ids(&app).await, [Some("N-1".to_string())]);
    let done = counters(&app).await;
    assert_eq!((done.held, done.delivered, done.lost), (0, 1, 0));
    assert!(app.next_held_push().await.is_none(), "it goes out once");
}

#[tokio::test]
async fn a_bridge_dropped_unread_loses_nothing_and_claims_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    // A healthy session that dies before it reads: the push never entered it.
    let (bridge, commands) = tokio::sync::mpsc::unbounded_channel();
    app.inner.remote.lock().await.command_tx = Some(bridge);
    app.deliver_attention(approval()).await;
    drop(commands);
    let waiting = counters(&app).await;
    assert_eq!((waiting.held, waiting.delivered), (1, 0));
    assert_eq!(held_ids(&app).await, [Some("N-1".to_string())]);
}

#[tokio::test]
async fn a_failed_write_keeps_its_place_and_its_age() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(approval()).await;
    app.deliver_attention(AttentionPush {
        notification_id: Some("N-2".to_string()),
        ..approval()
    })
    .await;
    age_held_pushes(&app, 50).await;
    assert!(app.next_held_push().await.is_some());
    app.push_unwritten().await;
    assert_eq!(counters(&app).await.held, 2);
    age_held_pushes(&app, 11).await;
    assert_eq!(held_ids(&app).await, Vec::<Option<String>>::new());
    assert_eq!(
        counters(&app).await.expired,
        2,
        "the clock was not restarted"
    );
}

#[tokio::test]
async fn held_pushes_are_bounded_newest_first_and_counted_when_dropped() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    for index in 0..MAX_HELD_PUSHES + 3 {
        app.deliver_attention(AttentionPush {
            notification_id: Some(format!("N-{index}")),
            ..approval()
        })
        .await;
    }
    let waiting = counters(&app).await;
    assert_eq!((waiting.held, waiting.evicted), (MAX_HELD_PUSHES as u64, 3));
    let first = app.next_held_push().await.unwrap();
    assert_eq!(first.notification_id.as_deref(), Some("N-3"));
}

fn completion(id: usize) -> AttentionPush {
    AttentionPush {
        kind: "turn-complete",
        notification_id: Some(format!("C-{id}")),
        ..AttentionPush::default()
    }
}

#[tokio::test]
async fn a_full_queue_gives_up_completions_before_what_waits_on_james() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(approval()).await;
    // A kind that stays on the socket; what ranks it is `ignore_presence`.
    app.deliver_attention(AttentionPush {
        kind: "turn-error",
        notification_id: Some("high".to_string()),
        ignore_presence: true,
        ..AttentionPush::default()
    })
    .await;
    for index in 0..MAX_HELD_PUSHES {
        app.deliver_attention(completion(index)).await;
    }
    let ids = held_ids(&app).await;
    assert_eq!(ids.len(), MAX_HELD_PUSHES);
    assert_eq!(ids[0].as_deref(), Some("N-1"), "the approval survives");
    assert_eq!(ids[1].as_deref(), Some("high"), "so does the high notice");
    assert_eq!(
        ids[2].as_deref(),
        Some("C-2"),
        "the oldest completions went"
    );
}

#[tokio::test]
async fn a_completion_cannot_push_out_a_queue_of_approvals() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    for index in 0..MAX_HELD_PUSHES {
        app.deliver_attention(AttentionPush {
            notification_id: Some(format!("N-{index}")),
            ..approval()
        })
        .await;
    }
    app.deliver_attention(completion(0)).await;
    let ids = held_ids(&app).await;
    assert_eq!(ids.len(), MAX_HELD_PUSHES);
    assert_eq!(ids[0].as_deref(), Some("N-0"));
    assert!(ids.iter().all(|id| id.as_deref() != Some("C-0")));
    let completions = counters_for(&app, "turn-complete").await;
    assert_eq!((completions.evicted, completions.held), (1, 0));
}

#[tokio::test]
async fn a_full_queue_drops_the_oldest_of_equal_rank() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    for index in 0..=MAX_HELD_PUSHES {
        app.deliver_attention(completion(index)).await;
    }
    assert_eq!(held_ids(&app).await[0].as_deref(), Some("C-1"));
}

#[tokio::test]
async fn a_claimed_push_is_offered_once_until_its_write_settles() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(approval()).await;
    assert!(app.next_held_push().await.is_some());
    assert_eq!(counters(&app).await.held, 1, "queued until it is written");
    assert!(app.next_held_push().await.is_none(), "no second writer");
    app.push_unwritten().await;
    assert!(app.next_held_push().await.is_some(), "free again");
    app.push_written().await;
    let done = counters(&app).await;
    assert_eq!((done.held, done.delivered), (0, 1));
    assert!(app.next_held_push().await.is_none());
}

#[tokio::test]
async fn a_push_being_written_cannot_be_evicted_or_expired() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    for index in 0..MAX_HELD_PUSHES {
        app.deliver_attention(AttentionPush {
            notification_id: Some(format!("N-{index}")),
            ..approval()
        })
        .await;
    }
    assert!(app.next_held_push().await.is_some());
    age_held_pushes(&app, HELD_PUSH_TTL_MINUTES + 1).await;
    expire_held_locked(&mut *app.inner.remote.lock().await, Utc::now());
    let left = counters(&app).await;
    assert_eq!((left.held, left.expired), (1, MAX_HELD_PUSHES as u64 - 1));
    for index in 0..MAX_HELD_PUSHES {
        app.deliver_attention(AttentionPush {
            notification_id: Some(format!("M-{index}")),
            ..approval()
        })
        .await;
    }
    app.push_written().await;
    let done = counters(&app).await;
    assert_eq!(
        (done.delivered, done.evicted, done.held),
        (1, 1, MAX_HELD_PUSHES as u64 - 1),
        "M-0 made way when the queue filled, not the one being written"
    );
}

#[tokio::test]
async fn an_expired_push_never_costs_a_fresh_one_its_place() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    for index in 0..MAX_HELD_PUSHES {
        app.deliver_attention(AttentionPush {
            notification_id: Some(format!("N-{index}")),
            ..approval()
        })
        .await;
    }
    age_held_pushes(&app, HELD_PUSH_TTL_MINUTES + 1).await;
    // The lowest rank there is: anything live would have turned it away.
    app.deliver_attention(completion(0)).await;
    assert_eq!(held_ids(&app).await, [Some("C-0".to_string())]);
    let completions = counters_for(&app, "turn-complete").await;
    assert_eq!(completions.evicted, 0);
    assert_eq!(
        counters_for(&app, "approval").await.expired,
        MAX_HELD_PUSHES as u64
    );
}

async fn counters_for(app: &AppState, kind: &str) -> falcondeck_core::AttentionDeliveryCounter {
    let status = build_remote_status_response(&*app.inner.remote.lock().await);
    status
        .attention
        .into_iter()
        .find(|counter| counter.kind == kind)
        .unwrap_or_default()
}

#[tokio::test]
async fn forgetting_the_pairing_loses_what_was_held_and_says_so() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(approval()).await;
    app.clear_remote_bridge_state().await;
    let gone = counters(&app).await;
    assert_eq!((gone.held, gone.lost), (0, 1));
    pair_for_tests(&app).await;
    assert!(app.next_held_push().await.is_none());
}

#[tokio::test]
async fn a_push_past_the_hour_expires_by_the_wall_clock() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(approval()).await;
    age_held_pushes(&app, HELD_PUSH_TTL_MINUTES + 1).await;
    assert!(app.next_held_push().await.is_none());
    let done = counters(&app).await;
    assert_eq!((done.held, done.expired, done.delivered), (0, 1, 0));
}

#[tokio::test]
async fn status_stops_calling_a_push_held_once_its_hour_is_up() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(approval()).await;
    age_held_pushes(&app, HELD_PUSH_TTL_MINUTES + 1).await;
    let status = app.remote_status().await;
    assert_eq!(
        (status.attention[0].held, status.attention[0].expired),
        (0, 1)
    );
}

/// The reviewer's repro: Needs You 0, and the phone still buzzes.
#[tokio::test]
async fn a_request_answered_while_held_never_pushes() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    let key = "input:workspace-1:0:2026-11-04T00:00:00Z";
    app.deliver_attention(recorded_request(&app, key).await)
        .await;
    assert!(app.inner.notifications.resolve(key, Utc::now()).await);
    assert!(app.next_held_push().await.is_none());
    let done = counters(&app).await;
    assert_eq!((done.settled, done.delivered, done.held), (1, 0, 0));
}

/// Opening a thread reads its input rows, which does not answer them.
#[tokio::test]
async fn a_request_read_but_unanswered_still_pushes() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    let key = "input:workspace-1:0:2026-11-04T00:00:00Z";
    app.deliver_attention(recorded_request(&app, key).await)
        .await;
    let store = &app.inner.notifications;
    assert!(
        store
            .mark_thread_read("workspace-1", "thread-1", Utc::now())
            .await
    );
    assert!(app.next_held_push().await.is_some());
}

#[tokio::test]
async fn a_held_push_rechecks_preferences_and_presence_as_it_goes() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(approval()).await;
    hold_phone_pushes(&app).await;
    assert!(app.next_held_push().await.is_none(), "back at the Mac");
    assert_eq!(counters(&app).await.suppressed_desktop_active, 1);

    app.set_desktop_activity(false);
    app.deliver_attention(approval()).await;
    app.update_preferences(falcondeck_core::UpdatePreferencesRequest {
        notifications: Some(falcondeck_core::NotificationPreferencesPatch {
            enabled: Some(false),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await
    .unwrap();
    assert!(app.next_held_push().await.is_none(), "turned off meanwhile");
    assert_eq!(counters(&app).await.suppressed_preferences, 1);
}

#[tokio::test]
async fn a_high_notice_still_goes_out_with_him_at_the_mac() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(AttentionPush {
        kind: "turn-error",
        ignore_presence: true,
        ..AttentionPush::default()
    })
    .await;
    hold_phone_pushes(&app).await;
    assert!(app.next_held_push().await.is_some());
}

/// A relay socket that reports each notify frame, and how a session is run
/// against it end to end.
async fn relay_socket() -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
) {
    use axum::{Router, extract::WebSocketUpgrade, routing::get};
    let (frames, received) = tokio::sync::mpsc::unbounded_channel();
    let router = Router::new()
        .route(
            "/v1/sessions/session/ws-ticket",
            post(|| async {
                Json(falcondeck_core::RelayWebSocketTicketResponse {
                    ticket: "test-ticket".into(),
                    expires_at: Utc::now() + chrono::Duration::minutes(1),
                })
            }),
        )
        .route(
            "/v1/updates/ws",
            get(move |upgrade: WebSocketUpgrade| {
                let frames = frames.clone();
                async move {
                    upgrade.on_upgrade(move |mut socket| async move {
                        while let Some(Ok(message)) = socket.recv().await {
                            if let axum::extract::ws::Message::Text(text) = message {
                                let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
                                if frame["type"] == "notify" {
                                    let _ = frames.send(frame);
                                }
                            }
                        }
                    })
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, received)
}

async fn next_frame(
    frames: &mut tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
) -> serde_json::Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), frames.recv())
        .await
        .expect("no push reached the relay")
        .unwrap()
}

async fn live_session(
    app: &AppState,
    url: String,
) -> tokio::task::JoinHandle<Result<(), RemoteBridgeError>> {
    let app = app.clone();
    let mut pairing = test_pairing();
    pairing.device_id = Some("device".to_string());
    pairing.expires_at = Utc::now() + chrono::Duration::hours(1);
    tokio::spawn(async move {
        let (_commands, mut commands) = tokio::sync::mpsc::unbounded_channel();
        let mut retry = RemoteBridgeRetry::default();
        app.connect_remote_session(
            url,
            "daemon".to_string(),
            "session".to_string(),
            pairing,
            None,
            &mut commands,
            &mut retry,
        )
        .await
    })
}

async fn claimed(app: &AppState) -> bool {
    let remote = app.inner.remote.lock().await;
    let front = remote.held_pushes.queue.front();
    front.is_some_and(|held| held.writing)
}

/// Revoking a device or rotating keys aborts the session mid-write.
#[tokio::test]
async fn an_aborted_session_leaves_its_push_queued_and_it_goes_out_once() {
    let (url, mut frames) = relay_socket().await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    app.set_desktop_activity(false);
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    app.inner.remote.lock().await.held_pushes.write_gate = Some(gate.clone());
    app.deliver_attention(approval()).await;

    let session = live_session(&app, url.clone()).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !claimed(&app).await {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the session never picked the push up");
    session.abort();
    let _ = session.await;
    let stuck = counters(&app).await;
    assert_eq!((stuck.held, stuck.delivered), (1, 0), "counted, not lost");

    gate.add_permits(1);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while claimed(&app).await {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the drain never gave the push back");
    let next = live_session(&app, url).await;
    assert_eq!(next_frame(&mut frames).await["notification_id"], "N-1");
    let silence = tokio::time::timeout(std::time::Duration::from_millis(300), frames.recv());
    assert!(silence.await.is_err(), "it went out once");
    next.abort();
    let done = counters(&app).await;
    assert_eq!((done.held, done.delivered), (0, 1));
}

#[tokio::test]
async fn a_live_session_writes_what_waited_and_what_comes_next() {
    let (url, mut frames) = relay_socket().await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    app.set_desktop_activity(false);
    let key = "input:workspace-1:0:2026-11-04T00:00:00Z";
    app.deliver_attention(recorded_request(&app, key).await)
        .await;
    app.deliver_attention(AttentionPush {
        notification_id: Some("N-waited".to_string()),
        ..approval()
    })
    .await;
    assert!(app.inner.notifications.resolve(key, Utc::now()).await);

    let session = live_session(&app, url).await;
    let first = next_frame(&mut frames).await;
    assert_eq!(
        first["notification_id"], "N-waited",
        "the answered one stays quiet"
    );

    app.deliver_attention(AttentionPush {
        notification_id: Some("N-next".to_string()),
        ..approval()
    })
    .await;
    assert_eq!(next_frame(&mut frames).await["notification_id"], "N-next");
    session.abort();
    let done = counters(&app).await;
    assert_eq!(
        (done.delivered, done.settled, done.held),
        (2, 1, 0),
        "every push is accounted for"
    );
}

#[tokio::test]
async fn a_review_retries_until_the_relay_acknowledges_it() {
    let (url, calls) = relay(vec![503, 200]).await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    app.deliver_acknowledged(review()).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(
        app.next_held_push().await.is_none(),
        "an acknowledged push is not resent"
    );
    assert_eq!(counters(&app).await.delivered, 1);
}

#[tokio::test]
async fn a_review_reaches_the_relay_with_an_active_desktop_and_no_bridge() {
    let (url, calls) = relay(vec![200]).await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    *app.inner.desktop_active_until.lock().unwrap() =
        Some(Utc::now() + chrono::Duration::minutes(5));
    app.update_preferences(falcondeck_core::UpdatePreferencesRequest {
        notifications: Some(falcondeck_core::NotificationPreferencesPatch {
            suppress_when_desktop_active: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await
    .unwrap();
    app.deliver_attention(AttentionPush {
        kind: "review",
        workspace_id: None,
        thread_id: None,
        preview: Some("Juno needs a decision: Pricing".to_string()),
        review_id: Some("R-1".to_string()),
        ..AttentionPush::default()
    })
    .await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the review never reached the relay");
    let status = build_remote_status_response(&*app.inner.remote.lock().await);
    assert_eq!(status.attention[0].delivered, 1);
    assert_eq!(status.attention[0].suppressed_desktop_active, 0);
}

#[tokio::test]
async fn a_review_with_no_phone_paired_is_lost() {
    let directory = tempfile::tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".to_string(),
        Default::default(),
        directory.path().join("state.json"),
    );
    app.deliver_attention(AttentionPush {
        kind: "review",
        workspace_id: None,
        thread_id: None,
        preview: None,
        review_id: Some("R-1".to_string()),
        ..AttentionPush::default()
    })
    .await;
    let status = build_remote_status_response(&*app.inner.remote.lock().await);
    assert_eq!(
        (status.attention[0].delivered, status.attention[0].lost),
        (0, 1)
    );
}

async fn hold_phone_pushes(app: &AppState) {
    *app.inner.desktop_active_until.lock().unwrap() =
        Some(Utc::now() + chrono::Duration::minutes(5));
    app.update_preferences(falcondeck_core::UpdatePreferencesRequest {
        notifications: Some(falcondeck_core::NotificationPreferencesPatch {
            suppress_when_desktop_active: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await
    .unwrap();
}

fn notice(high: bool) -> AttentionPush {
    AttentionPush {
        kind: "agent-notice",
        title: Some("Deploy finished".to_string()),
        preview: Some("All green.".to_string()),
        notification_id: Some("N-1".to_string()),
        report_id: Some("rpt_1".to_string()),
        ignore_presence: high,
        ..AttentionPush::default()
    }
}

#[tokio::test]
async fn a_high_notice_reaches_the_relay_acknowledged_with_its_ids() {
    let (url, calls) = relay(vec![200]).await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    hold_phone_pushes(&app).await;
    app.deliver_attention(notice(true)).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the notice never reached the relay");
}

#[tokio::test]
async fn a_normal_notice_waits_while_james_is_at_the_mac() {
    let (url, calls) = relay(vec![200]).await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    hold_phone_pushes(&app).await;
    app.deliver_attention(notice(false)).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let status = build_remote_status_response(&*app.inner.remote.lock().await);
    assert_eq!(status.attention[0].suppressed_desktop_active, 1);
}
