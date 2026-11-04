use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{Json, http::StatusCode, routing::post};
use falcondeck_core::{NotificationPreferences, RelayNotifyRequest};
use tokio::sync::mpsc;

use super::*;
use crate::app::{AppState, RemoteBridgeCommand};

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
fn counters_separate_each_reason_per_kind() {
    let mut counters = BTreeMap::new();
    record_attention(&mut counters, "review", AttentionPolicy::Deliver, true);
    record_attention(&mut counters, "review", AttentionPolicy::Deliver, false);
    record_attention(
        &mut counters,
        "approval",
        AttentionPolicy::DesktopActive,
        true,
    );
    record_attention(
        &mut counters,
        "approval",
        AttentionPolicy::OffByPreference,
        true,
    );
    assert_eq!(
        (counters["review"].sent, counters["review"].no_bridge),
        (1, 1)
    );
    assert_eq!(counters["approval"].suppressed_desktop_active, 1);
    assert_eq!(counters["approval"].suppressed_preferences, 1);
    assert_eq!(counters["approval"].sent, 0);
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
        remote.pairing = Some(crate::app::RemotePairingState {
            pairing_id: "pairing".to_string(),
            pairing_code: "code".to_string(),
            session_id: Some("session".to_string()),
            device_id: None,
            trusted_at: None,
            expires_at: Utc::now(),
            client_bundle: None,
            local_key_pair: falcondeck_core::crypto::LocalBoxKeyPair::generate(),
            data_key: [0; 32],
        });
    }
    app
}

fn review_command() -> RemoteBridgeCommand {
    RemoteBridgeCommand::NotifyAttention {
        kind: "review".to_string(),
        workspace_id: None,
        thread_id: None,
        message_preview: Some("Juno needs a decision: Pricing".to_string()),
        review_id: Some("R-1".to_string()),
        title: None,
        notification_id: None,
        report_id: None,
        ignore_presence: false,
    }
}

async fn attach_bridge(app: &AppState) -> mpsc::UnboundedReceiver<RemoteBridgeCommand> {
    let (bridge, commands) = mpsc::unbounded_channel();
    app.inner.remote.lock().await.command_tx = Some(bridge);
    commands
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

#[tokio::test]
async fn the_fallback_uses_the_bridge_in_place_now() {
    let (url, _calls) = relay(vec![404]).await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    // The channel captured when the push was queued has gone by the time HTTP
    // gives up; the bridge restarted with a new one.
    drop(attach_bridge(&app).await);
    let mut restarted = attach_bridge(&app).await;
    app.deliver_acknowledged(review_command()).await;
    assert!(restarted.try_recv().is_ok());
    assert_eq!(counters(&app).await.sent, 1);
}

#[tokio::test]
async fn a_push_the_dead_bridge_could_not_take_waits_and_only_then_counts() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    drop(attach_bridge(&app).await);
    app.deliver_attention(approval()).await;
    let held = counters(&app).await;
    assert_eq!((held.sent, held.no_bridge), (0, 1), "nothing took it");

    let mut restarted = attach_bridge(&app).await;
    app.flush_held_pushes().await;
    assert!(matches!(
        restarted.try_recv(),
        Ok(RemoteBridgeCommand::NotifyAttention { notification_id: Some(id), .. }) if id == "N-1"
    ));
    assert_eq!(counters(&app).await.sent, 1);
    app.flush_held_pushes().await;
    assert!(restarted.try_recv().is_err(), "a held push goes out once");
}

#[tokio::test]
async fn a_failed_socket_write_is_held_without_counting_twice() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    let mut bridge = attach_bridge(&app).await;
    app.deliver_attention(approval()).await;
    let command = bridge.try_recv().unwrap();
    assert_eq!(counters(&app).await.sent, 1);
    app.hold_push(command, true).await;
    app.flush_held_pushes().await;
    assert!(bridge.try_recv().is_ok());
    assert_eq!(counters(&app).await.sent, 1);
}

#[tokio::test]
async fn held_pushes_are_bounded_newest_first_and_forgotten_with_the_pairing() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    for index in 0..MAX_HELD_PUSHES + 3 {
        app.deliver_attention(AttentionPush {
            notification_id: Some(format!("N-{index}")),
            ..approval()
        })
        .await;
    }
    let mut bridge = attach_bridge(&app).await;
    app.flush_held_pushes().await;
    assert!(matches!(
        bridge.try_recv(),
        Ok(RemoteBridgeCommand::NotifyAttention { notification_id: Some(id), .. }) if id == "N-3"
    ));

    app.inner.remote.lock().await.command_tx = None;
    app.deliver_attention(approval()).await;
    app.clear_remote_bridge_state().await;
    let mut paired_again = attach_bridge(&app).await;
    app.flush_held_pushes().await;
    assert!(paired_again.try_recv().is_err());
}

#[tokio::test]
async fn a_held_push_that_went_stale_is_dropped() {
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay("http://127.0.0.1:9", &directory).await;
    app.deliver_attention(approval()).await;
    app.inner
        .remote
        .lock()
        .await
        .held_pushes
        .front_mut()
        .unwrap()
        .held_at -= HELD_PUSH_TTL + std::time::Duration::from_secs(1);
    let mut bridge = attach_bridge(&app).await;
    app.flush_held_pushes().await;
    assert!(bridge.try_recv().is_err());
}

#[tokio::test]
async fn a_review_retries_until_the_relay_acknowledges_it() {
    let (url, calls) = relay(vec![503, 200]).await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    let mut bridge = attach_bridge(&app).await;
    app.deliver_acknowledged(review_command()).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(
        bridge.try_recv().is_err(),
        "an acknowledged push is not resent"
    );
}

#[tokio::test]
async fn a_relay_without_the_endpoint_gets_the_review_over_the_socket() {
    let (url, calls) = relay(vec![404]).await;
    let directory = tempfile::tempdir().unwrap();
    let app = app_with_relay(&url, &directory).await;
    let mut bridge = attach_bridge(&app).await;
    app.deliver_acknowledged(review_command()).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(matches!(
        bridge.try_recv(),
        Ok(RemoteBridgeCommand::NotifyAttention { review_id: Some(id), .. }) if id == "R-1"
    ));
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
    assert_eq!(status.attention[0].sent, 1);
    assert_eq!(status.attention[0].suppressed_desktop_active, 0);
}

#[tokio::test]
async fn a_review_with_no_route_is_not_counted_as_sent() {
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
        (status.attention[0].sent, status.attention[0].no_bridge),
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
