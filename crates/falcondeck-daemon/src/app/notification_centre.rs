//! The one way an attention event leaves the daemon: record it, then deliver
//! it. Anything pushed is in the notification centre, and nothing that gates
//! delivery (preferences, desktop presence, a dead relay) can stop a record.
//!
//! Noise is decided before both steps, so the push and the history never
//! disagree. docs/NOTIFICATION-CENTRE.md explains the turn-completion rule.
use super::remote_lifecycle::{
    AttentionPush, notification_markdown_preview, notification_message_preview,
};
use super::*;
use crate::notification_store::{NewNotification, Recorded};
use falcondeck_core::ThreadOrigin;
use falcondeck_core::control::{ControlDomain, ControlStateChanged};
use falcondeck_core::notifications::{
    MarkNotificationsReadRequest, NotificationCounts, NotificationImportance, NotificationKind,
    NotificationListRequest, NotificationListResponse, NotificationRecord, NotificationTarget,
};
use falcondeck_core::reviews::Review;

/// What happened. Each variant is one call site's worth of attention.
#[derive(Debug, Clone)]
pub(super) enum AttentionEvent {
    /// An approval or question is waiting.
    Request(Box<InteractiveRequest>),
    /// A turn finished cleanly.
    TurnComplete {
        workspace_id: String,
        thread_id: String,
    },
    /// A turn failed.
    TurnError {
        workspace_id: String,
        thread_id: String,
    },
    /// A review was published.
    Review(Box<Review>),
}

impl AttentionEvent {
    pub(super) fn turn(workspace_id: &str, thread_id: &str, failed: bool) -> Self {
        let (workspace_id, thread_id) = (workspace_id.to_string(), thread_id.to_string());
        if failed {
            Self::TurnError {
                workspace_id,
                thread_id,
            }
        } else {
            Self::TurnComplete {
                workspace_id,
                thread_id,
            }
        }
    }
    pub(super) fn request(request: &InteractiveRequest) -> Self {
        Self::Request(Box::new(request.clone()))
    }
}

/// `input:<workspace>:<request>`, shared by recording and resolving.
fn input_key(workspace_id: &str, request_id: &str) -> String {
    format!("input:{workspace_id}:{request_id}")
}
fn review_key(review_id: &str) -> String {
    format!("review:{review_id}")
}

/// Whether a clean completion is worth a line: true when nobody else will tell
/// James and the thread has actually stopped. `quiet_marker` is the reply a
/// running automation treats as "nothing to report".
fn completion_is_notable(
    summary: &ThreadSummary,
    reply: Option<&str>,
    parent_is_watching: bool,
    quiet_marker: Option<&str>,
) -> bool {
    // A queued message starts straight away, so this is not the end of the work.
    if !summary.queued_turns.is_empty() {
        return false;
    }
    // The parent asked to hear about it; it decides what reaches James.
    if parent_is_watching {
        return false;
    }
    // Bot runs report home in their own turn, or finish silently on purpose.
    if matches!(
        &summary.origin,
        Some(ThreadOrigin::Automation {
            bot_id: Some(_),
            ..
        })
    ) {
        return false;
    }
    if let (Some(marker), Some(reply)) = (quiet_marker, reply)
        && reply.trim() == marker.trim()
    {
        return false;
    }
    true
}

impl AppState {
    /// Records the event, then delivers it. Every attention event goes through
    /// here. Noise produces neither a record nor a push; a repeat of an event
    /// already recorded produces no second push.
    pub(super) async fn record_and_deliver_attention(&self, event: AttentionEvent) {
        let Some((new, push)) = self.attention_record(event).await else {
            return;
        };
        let recorded = self.inner.notifications.record(new, Utc::now()).await;
        if matches!(recorded, Recorded::Duplicate(_)) {
            return;
        }
        self.emit_notifications_changed().await;
        self.deliver_attention(push).await;
    }

    /// What to store and push for an event, or `None` when it is noise.
    async fn attention_record(
        &self,
        event: AttentionEvent,
    ) -> Option<(NewNotification, AttentionPush)> {
        match event {
            AttentionEvent::Request(request) => Some(self.request_record(*request).await),
            AttentionEvent::TurnComplete {
                workspace_id,
                thread_id,
            } => self.completion_record(workspace_id, thread_id).await,
            AttentionEvent::TurnError {
                workspace_id,
                thread_id,
            } => Some(self.error_record(workspace_id, thread_id).await),
            AttentionEvent::Review(review) => Some(self.review_record(&review)),
        }
    }

    /// A display title for a thread, and the bot it belongs to.
    async fn attention_source(
        &self,
        workspace_id: &str,
        thread_id: Option<&str>,
    ) -> (String, Option<String>) {
        let Some(thread_id) = thread_id else {
            return ("FalconDeck".into(), None);
        };
        let title = self
            .thread_summary(workspace_id, thread_id)
            .await
            .ok()
            .map(|thread| thread.title)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| "Task".into());
        let bot = self.bot_for_thread(thread_id).await.map(|bot| bot.name);
        (title, bot)
    }

    async fn request_record(
        &self,
        request: InteractiveRequest,
    ) -> (NewNotification, AttentionPush) {
        let workspace_id = request.workspace_id.clone();
        let thread_id = request.thread_id.clone();
        let (title, bot) = self
            .attention_source(&workspace_id, thread_id.as_deref())
            .await;
        let question = request.kind == InteractiveRequestKind::Question;
        let lead = if question {
            "Question"
        } else {
            "Approval needed"
        };
        let preview = notification_markdown_preview(&request.title)
            .map_or_else(|| lead.to_string(), |text| format!("{lead}: {text}"));
        let new = NewNotification {
            kind: NotificationKind::InputRequired,
            title,
            preview,
            bot,
            target: thread_target(&workspace_id, thread_id.as_deref()),
            thread_id: thread_id.clone(),
            workspace_id: Some(workspace_id.clone()),
            importance: NotificationImportance::Normal,
            dedupe_key: Some(input_key(&workspace_id, &request.request_id)),
            coalesce: false,
            sender: None,
            body: None,
        };
        let push = AttentionPush {
            kind: if question { "question" } else { "approval" },
            workspace_id: Some(workspace_id),
            thread_id,
            preview: None,
            ..AttentionPush::default()
        };
        (new, push)
    }

    async fn completion_record(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Option<(NewNotification, AttentionPush)> {
        // Never hydrate native history for a notification.
        let (summary, reply) = {
            let workspaces = self.inner.workspaces.lock().await;
            let thread = workspaces.get(&workspace_id)?.threads.get(&thread_id)?;
            (
                thread.summary.clone(),
                notification_message_preview(&thread.items),
            )
        };
        let quiet_marker = self.control().quiet_marker_for_thread(&thread_id).await;
        let notable = completion_is_notable(
            &summary,
            reply.as_deref(),
            self.parent_watches_completion(&thread_id),
            quiet_marker.as_deref(),
        );
        if !notable {
            return None;
        }
        let bot = self.bot_for_thread(&thread_id).await.map(|bot| bot.name);
        let dedupe_key = summary
            .latest_turn_id
            .as_ref()
            .map(|turn| format!("turn:{workspace_id}:{thread_id}:{turn}"));
        let new = NewNotification {
            kind: NotificationKind::TurnComplete,
            title: display_title(&summary.title),
            preview: reply.clone().unwrap_or_else(|| "Finished.".into()),
            bot,
            target: thread_target(&workspace_id, Some(&thread_id)),
            thread_id: Some(thread_id.clone()),
            workspace_id: Some(workspace_id.clone()),
            importance: NotificationImportance::Normal,
            dedupe_key,
            coalesce: true,
            sender: None,
            body: None,
        };
        let push = AttentionPush {
            kind: "turn-complete",
            workspace_id: Some(workspace_id),
            thread_id: Some(thread_id),
            preview: reply,
            ..AttentionPush::default()
        };
        Some((new, push))
    }

    async fn error_record(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> (NewNotification, AttentionPush) {
        let summary = self.thread_summary(&workspace_id, &thread_id).await.ok();
        let (title, bot) = self.attention_source(&workspace_id, Some(&thread_id)).await;
        let preview = summary
            .as_ref()
            .and_then(|thread| thread.last_error.as_deref())
            .and_then(notification_markdown_preview)
            .unwrap_or_else(|| "The latest run ended with an error.".into());
        let dedupe_key = summary
            .and_then(|thread| thread.latest_turn_id)
            .map(|turn| format!("error:{workspace_id}:{thread_id}:{turn}"));
        let new = NewNotification {
            kind: NotificationKind::Error,
            title,
            preview,
            bot,
            target: thread_target(&workspace_id, Some(&thread_id)),
            thread_id: Some(thread_id.clone()),
            workspace_id: Some(workspace_id.clone()),
            importance: NotificationImportance::Normal,
            dedupe_key,
            coalesce: true,
            sender: None,
            body: None,
        };
        let push = AttentionPush {
            kind: "turn-error",
            workspace_id: Some(workspace_id),
            thread_id: Some(thread_id),
            preview: None,
            ..AttentionPush::default()
        };
        (new, push)
    }

    fn review_record(&self, review: &Review) -> (NewNotification, AttentionPush) {
        let new = NewNotification {
            kind: NotificationKind::Review,
            title: review.title.clone(),
            preview: notification_markdown_preview(&review.ask)
                .unwrap_or_else(|| "Needs a decision.".into()),
            bot: review.bot.clone(),
            target: Some(NotificationTarget::Review {
                review_id: review.id.clone(),
            }),
            thread_id: review.source_thread_id.clone(),
            workspace_id: review.source_workspace_id.clone(),
            importance: NotificationImportance::Normal,
            dedupe_key: Some(review_key(&review.id)),
            coalesce: false,
            sender: None,
            body: None,
        };
        let push = AttentionPush {
            kind: "review",
            workspace_id: review
                .source_workspace_id
                .clone()
                .filter(|id| !id.is_empty()),
            thread_id: review.source_thread_id.clone(),
            preview: Some(review_push_line(review)),
            review_id: Some(review.id.clone()),
        };
        (new, push)
    }

    /// Clients refetch on this, as they do for reviews.
    async fn emit_notifications_changed(&self) {
        self.emit_control_state_change(ControlStateChanged {
            store_revision: self.control().store_revision().await,
            domains: vec![ControlDomain::Notifications],
        });
    }

    /// A pending approval or question was dealt with, on any device.
    pub(super) async fn resolve_request_notification(&self, workspace_id: &str, request_id: &str) {
        let key = input_key(workspace_id, request_id);
        if self.inner.notifications.resolve(&key, Utc::now()).await {
            self.emit_notifications_changed().await;
        }
    }

    /// A review was answered or withdrawn.
    pub(crate) async fn resolve_review_notification(&self, review_id: &str) {
        let key = review_key(review_id);
        if self.inner.notifications.resolve(&key, Utc::now()).await {
            self.emit_notifications_changed().await;
        }
    }

    /// Opening a thread on any device reads what it was announcing.
    pub(super) async fn read_thread_notifications(&self, workspace_id: &str, thread_id: &str) {
        let store = &self.inner.notifications;
        if store
            .mark_thread_read(workspace_id, thread_id, Utc::now())
            .await
        {
            self.emit_notifications_changed().await;
        }
    }

    pub(crate) async fn notifications_list(
        &self,
        request: &NotificationListRequest,
    ) -> NotificationListResponse {
        self.inner.notifications.list(request, Utc::now()).await
    }

    pub(crate) async fn notification_get(
        &self,
        id: &str,
    ) -> Result<NotificationRecord, DaemonError> {
        self.inner
            .notifications
            .get(id)
            .await
            .ok_or_else(|| DaemonError::NotFound("notification not found".into()))
    }

    /// Marks records read for every device and returns the new counts.
    pub(crate) async fn notifications_mark_read(
        &self,
        request: &MarkNotificationsReadRequest,
    ) -> NotificationCounts {
        if self
            .inner
            .notifications
            .mark_read(request, Utc::now())
            .await
        {
            self.emit_notifications_changed().await;
        }
        self.inner.notifications.status().await
    }
}

fn display_title(title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        "Task".into()
    } else {
        title.into()
    }
}

fn thread_target(workspace_id: &str, thread_id: Option<&str>) -> Option<NotificationTarget> {
    thread_id.map(|thread_id| NotificationTarget::Thread {
        workspace_id: workspace_id.to_string(),
        thread_id: thread_id.to_string(),
    })
}

/// The push body. The relay bounds notification text at 256 characters.
pub(super) fn review_push_line(review: &Review) -> String {
    let who = review.bot.as_deref().unwrap_or("An agent");
    let line = format!("{who} needs a decision: {}", review.title.trim());
    if line.chars().count() <= 200 {
        return line;
    }
    let mut cut: String = line.chars().take(199).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::thread_tools::tests::fixture;
    use falcondeck_core::notifications::{NotificationFilter, NotificationListRequest};
    use falcondeck_core::{NotificationPreferencesPatch, UpdatePreferencesRequest};
    use tokio::sync::mpsc;

    async fn bridge(app: &AppState) -> mpsc::UnboundedReceiver<RemoteBridgeCommand> {
        let (tx, rx) = mpsc::unbounded_channel();
        app.inner.remote.lock().await.command_tx = Some(tx);
        rx
    }

    fn pushed(
        rx: &mut mpsc::UnboundedReceiver<RemoteBridgeCommand>,
    ) -> Vec<(String, Option<String>)> {
        let mut pushes = vec![];
        while let Ok(command) = rx.try_recv() {
            if let RemoteBridgeCommand::NotifyAttention {
                kind,
                message_preview,
                ..
            } = command
            {
                pushes.push((kind, message_preview));
            }
        }
        pushes
    }

    async fn history(app: &AppState) -> Vec<NotificationRecord> {
        app.notifications_list(&NotificationListRequest::default())
            .await
            .items
    }

    async fn reply(app: &AppState, text: &str) {
        let mut workspaces = app.inner.workspaces.lock().await;
        let thread = workspaces
            .get_mut("workspace-1")
            .unwrap()
            .threads
            .get_mut("thread-1")
            .unwrap();
        thread.items.push(
            serde_json::from_value(json!({
                "kind": "assistant_message", "id": uuid::Uuid::new_v4().to_string(), "text": text,
                "lifecycle": "complete", "created_at": Utc::now()
            }))
            .unwrap(),
        );
        let turns = thread.summary.latest_turn_id.as_deref().map_or(0, str::len);
        thread.summary.latest_turn_id = Some("t".repeat(turns + 1));
    }

    async fn finish(app: &AppState) {
        app.record_and_deliver_attention(AttentionEvent::turn("workspace-1", "thread-1", false))
            .await;
    }

    async fn set_notifications(app: &AppState, patch: NotificationPreferencesPatch) {
        app.update_preferences(UpdatePreferencesRequest {
            notifications: Some(patch),
            ..Default::default()
        })
        .await
        .unwrap();
    }

    fn request(id: &str) -> InteractiveRequest {
        serde_json::from_value(json!({
            "request_id": id, "workspace_id": "workspace-1", "thread_id": "thread-1",
            "method": "item/commandExecution/requestApproval", "kind": "approval",
            "title": "Run `npm test`", "detail": null, "command": null, "path": null,
            "turn_id": null, "item_id": null, "questions": [], "created_at": Utc::now()
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn a_pushed_event_is_stored_with_the_same_text() {
        let (app, _temp) = fixture().await;
        let mut rx = bridge(&app).await;
        app.set_desktop_activity(false);
        reply(&app, "All **tests** pass.").await;
        finish(&app).await;
        let records = history(&app).await;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, NotificationKind::TurnComplete);
        assert_eq!(records[0].preview, "All tests pass.");
        assert_eq!(
            pushed(&mut rx),
            [(
                "turn-complete".to_string(),
                Some("All tests pass.".to_string())
            )]
        );
    }

    #[tokio::test]
    async fn delivery_suppression_never_stops_a_record() {
        let (app, _temp) = fixture().await;
        let mut rx = bridge(&app).await;
        // At the desk.
        app.set_desktop_activity(true);
        reply(&app, "One.").await;
        finish(&app).await;
        // Master switch off.
        app.set_desktop_activity(false);
        set_notifications(
            &app,
            NotificationPreferencesPatch {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .await;
        app.record_and_deliver_attention(AttentionEvent::request(&request("r1")))
            .await;
        // No bridge at all.
        app.inner.remote.lock().await.command_tx = None;
        app.record_and_deliver_attention(AttentionEvent::request(&request("r2")))
            .await;
        assert!(pushed(&mut rx).is_empty());
        assert_eq!(history(&app).await.len(), 3);
    }

    #[tokio::test]
    async fn a_repeated_event_pushes_once() {
        let (app, _temp) = fixture().await;
        let mut rx = bridge(&app).await;
        app.set_desktop_activity(false);
        for _ in 0..3 {
            app.record_and_deliver_attention(AttentionEvent::request(&request("r1")))
                .await;
        }
        assert_eq!(pushed(&mut rx).len(), 1);
        assert_eq!(history(&app).await.len(), 1);
    }

    #[tokio::test]
    async fn a_requests_record_resolves_when_it_is_answered() {
        let (app, _temp) = fixture().await;
        app.record_and_deliver_attention(AttentionEvent::request(&request("r1")))
            .await;
        let waiting = NotificationListRequest {
            filter: NotificationFilter::NeedsYou,
            ..Default::default()
        };
        let list = app.notifications_list(&waiting).await;
        assert_eq!(list.items[0].preview, "Approval needed: Run npm test");
        assert_eq!(list.counts.needs_you_count, 1);
        app.resolve_interactive_request_item("workspace-1", "thread-1", "r1", None)
            .await
            .unwrap();
        let list = app.notifications_list(&waiting).await;
        assert!(list.items.is_empty());
        assert_eq!(list.counts.unread_count, 0);
    }

    #[tokio::test]
    async fn back_and_forth_in_one_thread_is_one_unread_line_but_every_turn_pushes() {
        let (app, _temp) = fixture().await;
        let mut rx = bridge(&app).await;
        app.set_desktop_activity(false);
        for text in ["First", "Second", "Third"] {
            reply(&app, text).await;
            finish(&app).await;
        }
        let records = history(&app).await;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].preview, "Third");
        assert_eq!(records[0].repeat_count, 2);
        assert_eq!(pushed(&mut rx).len(), 3);
    }

    #[tokio::test]
    async fn noise_is_neither_recorded_nor_pushed() {
        let (app, _temp) = fixture().await;
        let mut rx = bridge(&app).await;
        app.set_desktop_activity(false);
        reply(&app, "Working on the next step.").await;
        {
            let mut workspaces = app.inner.workspaces.lock().await;
            let thread = workspaces
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("thread-1")
                .unwrap();
            thread.summary.queued_turns = vec![
                serde_json::from_value(json!({
                    "id": "q", "preview": "next", "text": "next", "attachment_count": 0,
                    "queued_at": Utc::now()
                }))
                .unwrap(),
            ];
        }
        finish(&app).await;
        assert!(history(&app).await.is_empty());
        assert!(pushed(&mut rx).is_empty());
    }

    fn summary(origin: Option<ThreadOrigin>) -> ThreadSummary {
        serde_json::from_value::<ThreadSummary>(json!({
            "id": "t", "workspace_id": "w", "title": "T", "status": "idle",
            "updated_at": Utc::now(), "provider": "claude",
        }))
        .map(|mut summary| {
            summary.origin = origin;
            summary
        })
        .unwrap()
    }

    #[test]
    fn the_completion_rule() {
        let plain = summary(None);
        assert!(completion_is_notable(&plain, Some("Done."), false, None));
        assert!(
            completion_is_notable(&plain, None, false, None),
            "no reply text still counts"
        );
        assert!(
            !completion_is_notable(&plain, Some("Done."), true, None),
            "parent will report"
        );
        let spawned = summary(Some(ThreadOrigin::AgentSpawn {
            parent_thread_id: "p".into(),
            dispatched_at: None,
        }));
        assert!(
            completion_is_notable(&spawned, Some("Done."), false, None),
            "nobody else will say"
        );
        let bot_run = summary(Some(ThreadOrigin::Automation {
            automation_id: "a".into(),
            bot_id: Some("b".into()),
            name: "n".into(),
        }));
        assert!(!completion_is_notable(&bot_run, Some("Done."), false, None));
        let run = summary(Some(ThreadOrigin::Automation {
            automation_id: "a".into(),
            bot_id: None,
            name: "n".into(),
        }));
        assert!(completion_is_notable(
            &run,
            Some("Inbox has two urgent emails."),
            false,
            Some("NO_ACTION")
        ));
        assert!(!completion_is_notable(
            &run,
            Some("NO_ACTION"),
            false,
            Some("NO_ACTION")
        ));
    }

    #[tokio::test]
    async fn opening_the_thread_reads_its_records_on_every_device() {
        let (app, _temp) = fixture().await;
        reply(&app, "Done.").await;
        finish(&app).await;
        assert_eq!(app.inner.notifications.status().await.unread_count, 1);
        let mut events = app.subscribe();
        app.mark_thread_read("workspace-1", "thread-1", 1)
            .await
            .unwrap();
        assert_eq!(app.inner.notifications.status().await.unread_count, 0);
        let mut told = false;
        while let Ok(envelope) = events.try_recv() {
            told |= matches!(&envelope.event, UnifiedEvent::ControlStateChanged { change }
                if change.domains.contains(&ControlDomain::Notifications));
        }
        assert!(told, "other devices are told to refetch");
    }

    #[tokio::test]
    async fn phones_read_and_mark_over_remote_rpc() {
        let (app, _temp) = fixture().await;
        app.record_and_deliver_attention(AttentionEvent::request(&request("r1")))
            .await;
        for method in [
            "notifications.list",
            "notification.get",
            "notifications.mark_read",
        ] {
            assert!(
                remote_bridge::REMOTE_RPC_METHODS.contains(&method),
                "{method}"
            );
        }
        let list = app
            .dispatch_remote_rpc("notifications.list", json!({}))
            .await
            .unwrap();
        assert_eq!(list["items"][0]["kind"], "input_required");
        assert_eq!(list["unread_count"], 1);
        let id = list["items"][0]["id"].as_str().unwrap();
        let record = app
            .dispatch_remote_rpc("notification.get", json!({"id": id}))
            .await
            .unwrap();
        assert_eq!(record["target"]["type"], "thread");
        let counts = app
            .dispatch_remote_rpc("notifications.mark_read", json!({"ids": [id]}))
            .await
            .unwrap();
        assert_eq!(counts["unread_count"], 0);
    }
}
