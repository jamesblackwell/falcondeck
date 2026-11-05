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
use crate::control::RunTurn;
use crate::notification_store::{NewNotification, NoticeRefused, Recorded};
use chrono::{DateTime, SecondsFormat};
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
    /// An agent has something to say. No decision needed.
    Notice(Box<AgentNotice>),
}

/// A notice from `falcondeck_notify`, after validation.
#[derive(Debug, Clone)]
pub(super) struct AgentNotice {
    pub title: String,
    pub summary: String,
    pub body: Option<String>,
    pub importance: NotificationImportance,
    /// `bot:<name>` or `thread:<id>`: who the rate limits count.
    pub sender: String,
    pub bot: Option<String>,
    pub workspace_id: String,
    pub thread_id: String,
}

/// What happened to an event. Only notices can be refused; everything else
/// is recorded or was noise, and callers have nothing to do either way.
#[derive(Debug)]
pub(super) enum AttentionOutcome {
    Noise,
    Recorded(Recorded),
    Refused(NoticeRefused),
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

/// One request event. A provider's request id alone does not identify it:
/// Codex ids are JSON-RPC ids that restart at 0 with each process, and these
/// keys outlive it by 90 days. `created_at` is minted once per event and
/// travels with the transcript card, which is how resolving finds it again.
fn input_key(workspace_id: &str, request_id: &str, created_at: DateTime<Utc>) -> String {
    let at = created_at.to_rfc3339_opts(SecondsFormat::Nanos, true);
    format!("{}{at}", input_key_prefix(workspace_id, request_id))
}
fn input_key_prefix(workspace_id: &str, request_id: &str) -> String {
    format!("input:{workspace_id}:{request_id}:")
}
fn review_key(review_id: &str) -> String {
    format!("review:{review_id}")
}

/// Whether a clean completion is worth a line: true when nobody else will tell
/// James and the thread has actually stopped. `run` is the automation run
/// this turn belongs to, if any.
fn completion_is_notable(
    summary: &ThreadSummary,
    reply: Option<&str>,
    parent_is_watching: bool,
    run: Option<&RunTurn>,
) -> bool {
    // A queued message starts straight away, so this is not the end of the work.
    if !summary.queued_turns.is_empty() {
        return false;
    }
    // The parent asked to hear about it; it decides what reaches James.
    if parent_is_watching {
        return false;
    }
    let Some(run) = run else {
        // James's own follow-up in a run's thread, whatever started the thread.
        return true;
    };
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
    !matches!(
        (run.quiet_marker.as_deref(), reply),
        (Some(marker), Some(reply)) if reply.trim() == marker.trim()
    )
}

impl AppState {
    /// Records the event, then delivers it. Every attention event goes through
    /// here. Noise produces neither a record nor a push; a repeat of an event
    /// already recorded produces no second push.
    pub(super) async fn record_and_deliver_attention(
        &self,
        event: AttentionEvent,
    ) -> AttentionOutcome {
        let notice = matches!(event, AttentionEvent::Notice(_));
        let replaces = match &event {
            AttentionEvent::Request(request) => {
                Some(input_key_prefix(&request.workspace_id, &request.request_id))
            }
            _ => None,
        };
        let Some((new, mut push)) = self.attention_record(event).await else {
            return AttentionOutcome::Noise;
        };
        let now = Utc::now();
        let recorded = if notice {
            match self.inner.notifications.record_notice(new, now).await {
                Ok(recorded) => recorded,
                Err(refused) => return AttentionOutcome::Refused(refused),
            }
        } else {
            self.inner.notifications.record(new, now).await
        };
        // The daemon tracks one pending request per id, so an earlier one with
        // this id has been replaced: only the new event can be answered now.
        if let (Some(prefix), Recorded::Created(record)) = (&replaces, &recorded) {
            let store = &self.inner.notifications;
            store.retire_open(prefix, Some(record.seq), now).await;
        }
        if matches!(recorded, Recorded::Duplicate(_)) || recorded.record().resolved_at.is_some() {
            return AttentionOutcome::Recorded(recorded);
        }
        self.emit_notifications_changed().await;
        let record = recorded.record();
        push.notification_id = Some(record.id.clone());
        push.report_id = record
            .report
            .as_ref()
            .map(|report| report.report_id.clone());
        if push.report_id.is_some() {
            // The push should not beat the report to the relay: the Mac may
            // sleep the moment it is sent. Only the wait is bounded, because a
            // slow relay must not hold a notice back; the upload itself carries on.
            let app = self.clone();
            let upload = tokio::spawn(async move { app.sync_relay_reports().await });
            let _ = tokio::time::timeout(REPORT_UPLOAD_WAIT, upload).await;
        }
        self.deliver_attention(push).await;
        AttentionOutcome::Recorded(recorded)
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
            AttentionEvent::Notice(notice) => Some(notice_record(*notice)),
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
            dedupe_key: Some(input_key(
                &workspace_id,
                &request.request_id,
                request.created_at,
            )),
            coalesce: false,
            sender: None,
            body: None,
        };
        let push = AttentionPush {
            kind: if question { "question" } else { "approval" },
            workspace_id: Some(workspace_id),
            thread_id,
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
        let (summary, reply, answer_id) = {
            let workspaces = self.inner.workspaces.lock().await;
            let thread = workspaces.get(&workspace_id)?.threads.get(&thread_id)?;
            (
                thread.summary.clone(),
                notification_message_preview(&thread.items),
                latest_answer_id(&thread.items),
            )
        };
        let run = self
            .control()
            .run_for_turn(&thread_id, summary.latest_turn_id.as_deref())
            .await;
        let notable = completion_is_notable(
            &summary,
            reply.as_deref(),
            self.parent_watches_completion(&thread_id),
            run.as_ref(),
        );
        if !notable {
            return None;
        }
        let bot = self.bot_for_thread(&thread_id).await.map(|bot| bot.name);
        // A Claude turn settles at its result, and again when the process goes.
        // A background task can also wake it under the same turn id, so the
        // turn alone does not identify a completion: the answer it ended on does.
        let dedupe_key = summary.latest_turn_id.as_ref().map(|turn| {
            let answer = answer_id.as_deref().unwrap_or_default();
            format!("turn:{workspace_id}:{thread_id}:{turn}:{answer}")
        });
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
        let new = NewNotification {
            kind: NotificationKind::Error,
            title,
            preview,
            bot,
            target: thread_target(&workspace_id, Some(&thread_id)),
            thread_id: Some(thread_id.clone()),
            workspace_id: Some(workspace_id.clone()),
            importance: NotificationImportance::Normal,
            // Each failure is news, even a retry of the same turn. Unread ones
            // fold into one row, and the relay holds a repeat to one a minute.
            dedupe_key: None,
            coalesce: true,
            sender: None,
            body: None,
        };
        let push = AttentionPush {
            kind: "turn-error",
            workspace_id: Some(workspace_id),
            thread_id: Some(thread_id),
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
            ..AttentionPush::default()
        };
        (new, push)
    }

    pub(super) fn spawn_report_sync(&self) {
        let app = self.clone();
        tokio::spawn(async move { app.sync_relay_reports().await });
    }

    /// Puts every live report on the relay under the current session key:
    /// after a notice, on each connection (so a report written while the relay
    /// was out of reach goes up), and after a key rotation (the old ciphertext
    /// is unreadable by the devices that remain). Idempotent and best-effort;
    /// the daemon's own copy stays the source of truth.
    pub(super) async fn sync_relay_reports(&self) {
        let _serial = self.inner.report_sync.lock().await;
        let (relay_url, token, session_id, data_key) = {
            let remote = self.inner.remote.lock().await;
            let (Some(relay_url), Some(token), Some(pairing)) = (
                remote.relay_url.clone(),
                remote.daemon_token.clone(),
                remote.pairing.as_ref(),
            ) else {
                return;
            };
            let Some(session_id) = pairing.session_id.clone() else {
                return;
            };
            (relay_url, token, session_id, pairing.data_key)
        };
        let key_id = report_key_id(&session_id, &data_key);
        let store = &self.inner.notifications;
        let pending = store.pending_reports(&key_id, Utc::now()).await;
        if pending.is_empty() {
            return;
        }
        let client = reqwest::Client::new();
        let Some(limits) = relay_report_limits(&client, &relay_url).await else {
            return;
        };
        for pending in pending {
            let Some(reference) = pending.record.report.clone() else {
                continue;
            };
            let plain = report_plaintext(
                &pending.record,
                &reference.report_id,
                &session_id,
                &pending.body,
            );
            let ttl = (reference.expires_at - Utc::now())
                .num_seconds()
                .min(limits.max_ttl_seconds);
            let envelope = match falcondeck_core::crypto::encrypt_json(&data_key, &plain) {
                Ok(envelope) if envelope.ciphertext.len() <= limits.max_bytes && ttl > 0 => {
                    envelope
                }
                Ok(_) => {
                    tracing::warn!(id = %pending.record.id, "report stays on the daemon: over relay limits");
                    continue;
                }
                Err(error) => {
                    tracing::warn!(%error, "could not encrypt report");
                    continue;
                }
            };
            let url = format!(
                "{relay_url}/v1/sessions/{session_id}/reports/{}",
                reference.report_id
            );
            let sent = client
                .put(url)
                .bearer_auth(&token)
                .json(&falcondeck_core::PutRelayReportRequest {
                    envelope,
                    ttl_seconds: ttl,
                })
                .timeout(REPORT_UPLOAD_TIMEOUT)
                .send()
                .await
                .and_then(reqwest::Response::error_for_status);
            match sent {
                Ok(_) => store.mark_report_hosted(&pending.record.id, &key_id).await,
                Err(error) => {
                    tracing::warn!(%error, "report upload failed; retrying on the next connection");
                    return;
                }
            }
        }
    }

    /// Clients refetch on this, as they do for reviews.
    async fn emit_notifications_changed(&self) {
        self.emit_control_state_change(ControlStateChanged {
            store_revision: self.control().store_revision().await,
            domains: vec![ControlDomain::Notifications],
        });
    }

    /// A pending approval or question was dealt with, on any device.
    /// `created_at` comes from the transcript card, which always goes out
    /// before the record. With no card only an open record can match.
    pub(super) async fn resolve_request_notification(
        &self,
        workspace_id: &str,
        request_id: &str,
        created_at: Option<DateTime<Utc>>,
    ) {
        let store = &self.inner.notifications;
        let now = Utc::now();
        let resolved = match created_at {
            Some(at) => {
                let key = input_key(workspace_id, request_id, at);
                store.resolve(&key, now).await
            }
            None => {
                let prefix = input_key_prefix(workspace_id, request_id);
                store.resolve_newest(&prefix, now).await
            }
        };
        if resolved {
            self.emit_notifications_changed().await;
        }
    }

    /// Pending requests live in memory, so none survives a restart. Runs at
    /// startup, before any provider can raise a new one.
    pub(crate) async fn retire_unanswerable_requests(&self) {
        let store = &self.inner.notifications;
        if store.retire_open("input:", None, Utc::now()).await {
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

const REPORT_UPLOAD_WAIT: std::time::Duration =
    std::time::Duration::from_secs(if cfg!(test) { 1 } else { 5 });
const REPORT_UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// What this relay accepts, or `None` for a relay without report hosting.
async fn relay_report_limits(
    client: &reqwest::Client,
    relay_url: &str,
) -> Option<falcondeck_core::RelayReportCapabilities> {
    let response = client
        .get(format!("{relay_url}/v1/push-capabilities"))
        .timeout(REPORT_UPLOAD_TIMEOUT)
        .send()
        .await
        .ok()?;
    response
        .json::<falcondeck_core::RelayPushCapabilities>()
        .await
        .ok()?
        .reports
}

/// Names a session key without revealing it, to spot reports under an old one.
fn report_key_id(session_id: &str, data_key: &[u8; 32]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::new()
        .chain_update(b"falcondeck-report-key\0")
        .chain_update(session_id.as_bytes())
        .chain_update(b"\0")
        .chain_update(data_key)
        .finalize();
    digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// What the phone decrypts. It carries its own ids because the relay chooses
/// what to serve: a client rejects a report that does not match its request.
fn report_plaintext(
    record: &NotificationRecord,
    report_id: &str,
    session_id: &str,
    body: &str,
) -> Value {
    json!({
        "version": 1,
        "report_id": report_id,
        "session_id": session_id,
        "notification_id": record.id,
        "title": record.title,
        "summary": record.preview,
        "body": body,
        "bot": record.bot,
        "thread_id": record.thread_id,
        "workspace_id": record.workspace_id,
        "importance": record.importance,
        "created_at": record.created_at,
    })
}

fn notice_record(notice: AgentNotice) -> (NewNotification, AttentionPush) {
    let AgentNotice {
        title,
        summary,
        body,
        importance,
        sender,
        bot,
        workspace_id,
        thread_id,
    } = notice;
    let new = NewNotification {
        kind: NotificationKind::AgentNotice,
        title: title.clone(),
        preview: summary.clone(),
        bot,
        target: thread_target(&workspace_id, Some(&thread_id)),
        thread_id: Some(thread_id.clone()),
        workspace_id: Some(workspace_id.clone()),
        importance,
        dedupe_key: None,
        coalesce: false,
        sender: Some(sender),
        body,
    };
    let push = AttentionPush {
        kind: "agent-notice",
        workspace_id: Some(workspace_id),
        thread_id: Some(thread_id),
        preview: Some(summary),
        title: Some(title),
        ignore_presence: importance == NotificationImportance::High,
        ..AttentionPush::default()
    };
    (new, push)
}

fn display_title(title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        "Task".into()
    } else {
        title.into()
    }
}

fn latest_answer_id(items: &[ConversationItem]) -> Option<String> {
    items.iter().rev().find_map(|item| match item {
        ConversationItem::AssistantMessage { id, .. } => Some(id.clone()),
        _ => None,
    })
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
    // Reviews allow a multi-line title; the relay refuses a control character.
    let title = review
        .title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let line = format!("{who} needs a decision: {title}");
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

    async fn bridge(app: &AppState) {
        remote_lifecycle::pair_for_tests(app).await;
    }

    /// What a live session would write.
    async fn pushed(app: &AppState) -> Vec<(String, Option<String>)> {
        let mut pushes = vec![];
        while let Some((push, claim)) = app.next_held_push().await {
            app.push_written(claim).await;
            pushes.push((push.kind.to_string(), push.preview));
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
        bridge(&app).await;
        app.set_desktop_activity(false);
        reply(&app, "All **tests** pass.").await;
        finish(&app).await;
        let records = history(&app).await;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, NotificationKind::TurnComplete);
        assert_eq!(records[0].preview, "All tests pass.");
        assert_eq!(
            pushed(&app).await,
            [(
                "turn-complete".to_string(),
                Some("All tests pass.".to_string())
            )]
        );
    }

    #[tokio::test]
    async fn delivery_suppression_never_stops_a_record() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
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
        // Nothing to deliver to at all.
        app.inner.remote.lock().await.pairing = None;
        app.record_and_deliver_attention(AttentionEvent::request(&request("r2")))
            .await;
        assert!(pushed(&app).await.is_empty());
        assert_eq!(history(&app).await.len(), 3);
    }

    #[tokio::test]
    async fn a_repeated_event_pushes_once() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        let request = request("r1");
        for _ in 0..3 {
            app.record_and_deliver_attention(AttentionEvent::request(&request))
                .await;
        }
        assert_eq!(pushed(&app).await.len(), 1);
        assert_eq!(history(&app).await.len(), 1);
    }

    /// What a provider does: the card first, then the event.
    async fn ask(app: &AppState, request: &InteractiveRequest) {
        app.push_conversation_item(
            "workspace-1",
            "thread-1",
            ConversationItem::InteractiveRequest {
                id: request.request_id.clone(),
                request: Box::new(request.clone()),
                created_at: request.created_at,
                resolved: false,
                resolution: None,
            },
            false,
        )
        .await
        .unwrap();
        app.record_and_deliver_attention(AttentionEvent::request(request))
            .await;
    }

    async fn answer(app: &AppState, id: &str) {
        app.resolve_interactive_request_item("workspace-1", "thread-1", id, None)
            .await
            .unwrap();
    }

    async fn needs_you(app: &AppState) -> usize {
        app.notifications_list(&NotificationListRequest {
            filter: NotificationFilter::NeedsYou,
            ..Default::default()
        })
        .await
        .items
        .len()
    }

    /// Codex ids are JSON-RPC ids: each new process starts again at 0.
    #[tokio::test]
    async fn a_new_process_reusing_an_answered_request_id_still_alerts() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        ask(&app, &request("0")).await;
        assert_eq!(pushed(&app).await.len(), 1);
        answer(&app, "0").await;
        ask(&app, &request("0")).await;
        assert_eq!(pushed(&app).await.len(), 1);
        assert_eq!(history(&app).await.len(), 2);
        assert_eq!(needs_you(&app).await, 1, "the new one is waiting");
        answer(&app, "0").await;
        assert_eq!(needs_you(&app).await, 0);
    }

    #[tokio::test]
    async fn a_new_process_reusing_an_unanswered_request_id_still_alerts() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        ask(&app, &request("0")).await;
        assert_eq!(pushed(&app).await.len(), 1);
        ask(&app, &request("0")).await;
        assert_eq!(pushed(&app).await.len(), 1);
    }

    /// The same id with a new timestamp cannot be told from a new process, so
    /// it alerts; but only the newest can be answered, so one row waits.
    #[tokio::test]
    async fn a_replayed_request_retires_the_row_it_replaced() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        let first = request("0");
        let mut replay = first.clone();
        replay.created_at = first.created_at + chrono::Duration::seconds(5);
        ask(&app, &first).await;
        assert_eq!(pushed(&app).await.len(), 1);
        ask(&app, &replay).await;
        assert_eq!(pushed(&app).await.len(), 1);
        assert_eq!(history(&app).await.len(), 2);
        assert_eq!(needs_you(&app).await, 1);
        answer(&app, "0").await;
        assert_eq!(needs_you(&app).await, 0, "no stuck row after answering");
    }

    #[tokio::test]
    async fn a_held_push_for_a_replaced_request_stays_quiet() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        ask(&app, &request("0")).await;
        ask(&app, &request("0")).await;
        assert_eq!(pushed(&app).await.len(), 1, "only the live one");
    }

    #[tokio::test]
    async fn another_requests_row_survives_a_replay() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        ask(&app, &request("1")).await;
        ask(&app, &request("0")).await;
        ask(&app, &request("0")).await;
        assert_eq!(needs_you(&app).await, 2);
    }

    #[tokio::test]
    async fn startup_settles_requests_that_died_with_the_process_only() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        ask(&app, &request("0")).await;
        let review = crate::notification_store::NewNotification {
            kind: NotificationKind::Review,
            title: "Pricing".into(),
            preview: "Juno needs a decision".into(),
            bot: None,
            thread_id: None,
            workspace_id: None,
            target: None,
            importance: NotificationImportance::Normal,
            dedupe_key: Some(review_key("R-1")),
            coalesce: false,
            sender: None,
            body: None,
        };
        app.inner.notifications.record(review, Utc::now()).await;
        assert_eq!(needs_you(&app).await, 2);
        app.retire_unanswerable_requests().await;
        let waiting = app
            .notifications_list(&NotificationListRequest {
                filter: NotificationFilter::NeedsYou,
                ..Default::default()
            })
            .await
            .items;
        assert_eq!(waiting.len(), 1);
        assert_eq!(
            waiting[0].kind,
            NotificationKind::Review,
            "still answerable"
        );
    }

    async fn cards_resolved(app: &AppState) -> Vec<bool> {
        let workspaces = app.inner.workspaces.lock().await;
        workspaces["workspace-1"].threads["thread-1"]
            .items
            .iter()
            .filter_map(|item| match item {
                ConversationItem::InteractiveRequest { resolved, .. } => Some(*resolved),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn an_answer_settles_the_newest_card_under_a_reused_id() {
        let (app, _temp) = fixture().await;
        ask(&app, &request("0")).await;
        answer(&app, "0").await;
        ask(&app, &request("0")).await;
        assert_eq!(cards_resolved(&app).await, [true, false]);
        answer(&app, "0").await;
        assert_eq!(cards_resolved(&app).await, [true, true]);
    }

    #[tokio::test]
    async fn a_reloaded_transcript_still_settles_the_newest_card() {
        let (app, _temp) = fixture().await;
        ask(&app, &request("0")).await;
        answer(&app, "0").await;
        ask(&app, &request("0")).await;
        {
            let mut workspaces = app.inner.workspaces.lock().await;
            let thread = workspaces
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("thread-1")
                .unwrap();
            let items = thread.items.clone();
            thread.replace_items(items);
        }
        answer(&app, "0").await;
        assert_eq!(cards_resolved(&app).await, [true, true]);
    }

    #[tokio::test]
    async fn a_repeated_answer_cannot_silence_the_next_use_of_the_id() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        ask(&app, &request("0")).await;
        assert_eq!(pushed(&app).await.len(), 1);
        answer(&app, "0").await;
        answer(&app, "0").await;
        ask(&app, &request("0")).await;
        assert_eq!(pushed(&app).await.len(), 1);
        assert_eq!(needs_you(&app).await, 1, "not recorded as already answered");
    }

    #[tokio::test]
    async fn an_answer_that_beats_its_record_still_settles_it() {
        let (app, _temp) = fixture().await;
        let request = request("0");
        app.push_conversation_item(
            "workspace-1",
            "thread-1",
            ConversationItem::InteractiveRequest {
                id: "0".into(),
                request: Box::new(request.clone()),
                created_at: request.created_at,
                resolved: false,
                resolution: None,
            },
            false,
        )
        .await
        .unwrap();
        answer(&app, "0").await;
        app.record_and_deliver_attention(AttentionEvent::request(&request))
            .await;
        assert_eq!(needs_you(&app).await, 0);
    }

    fn answer_again(app: &AppState, text: &'static str) -> impl Future<Output = ()> {
        // A wake keeps the turn id; only a new message arrives.
        async move {
            let mut workspaces = app.inner.workspaces.lock().await;
            let thread = workspaces
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("thread-1")
                .unwrap();
            thread.items.push(
                serde_json::from_value(json!({
                    "kind": "assistant_message", "id": uuid::Uuid::new_v4().to_string(),
                    "text": text, "lifecycle": "complete", "created_at": Utc::now()
                }))
                .unwrap(),
            );
        }
    }

    #[tokio::test]
    async fn a_result_after_a_background_wake_alerts_under_the_same_turn_id() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        reply(&app, "Waiting on the tests.").await;
        finish(&app).await;
        answer_again(&app, "The tests passed.").await;
        finish(&app).await;
        assert_eq!(pushed(&app).await.len(), 2);
        let records = history(&app).await;
        assert_eq!(records.len(), 1, "one unread line");
        assert_eq!(records[0].preview, "The tests passed.");
    }

    #[tokio::test]
    async fn a_turn_settling_twice_on_the_same_answer_alerts_once() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        reply(&app, "Done.").await;
        finish(&app).await;
        finish(&app).await;
        assert_eq!(pushed(&app).await.len(), 1);
    }

    #[tokio::test]
    async fn every_failure_of_a_retried_turn_alerts() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        reply(&app, "Trying.").await;
        for _ in 0..3 {
            app.record_and_deliver_attention(AttentionEvent::turn("workspace-1", "thread-1", true))
                .await;
        }
        assert_eq!(pushed(&app).await.len(), 3);
        assert_eq!(history(&app).await.len(), 1, "one unread line");
    }

    #[tokio::test]
    async fn james_following_up_in_a_bots_run_thread_alerts_as_usual() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        reply(&app, "Report sent.").await;
        app.inner
            .workspaces
            .lock()
            .await
            .get_mut("workspace-1")
            .unwrap()
            .threads
            .get_mut("thread-1")
            .unwrap()
            .summary
            .origin = Some(ThreadOrigin::Automation {
            automation_id: "a".into(),
            bot_id: Some("b".into()),
            name: "n".into(),
        });
        finish(&app).await;
        assert_eq!(pushed(&app).await.len(), 1);
    }

    #[test]
    fn a_multi_line_review_title_makes_a_push_the_relay_accepts() {
        let review: Review = serde_json::from_value(json!({
            "id": "R-1", "revision": 1, "title": "Pricing\n\tpage\u{7}now", "ask": "Ship?",
            "recommendation": "Yes", "body": "", "status": "open", "items": [],
            "created_by": {"name": "Juno", "context": {"origin": "mcp"}},
            "created_at": Utc::now(), "updated_at": Utc::now()
        }))
        .unwrap();
        assert_eq!(
            review_push_line(&review),
            "An agent needs a decision: Pricing page now"
        );
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
        bridge(&app).await;
        app.set_desktop_activity(false);
        for text in ["First", "Second", "Third"] {
            reply(&app, text).await;
            finish(&app).await;
        }
        let records = history(&app).await;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].preview, "Third");
        assert_eq!(records[0].repeat_count, 2);
        assert_eq!(pushed(&app).await.len(), 3);
    }

    #[tokio::test]
    async fn noise_is_neither_recorded_nor_pushed() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
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
        assert!(pushed(&app).await.is_empty());
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
        let quiet = |marker: Option<&str>| RunTurn {
            quiet_marker: marker.map(str::to_string),
        };
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
        assert!(!completion_is_notable(
            &bot_run,
            Some("Done."),
            false,
            Some(&quiet(None))
        ));
        assert!(
            completion_is_notable(&bot_run, Some("Done."), false, None),
            "James's own follow-up"
        );
        let run = summary(Some(ThreadOrigin::Automation {
            automation_id: "a".into(),
            bot_id: None,
            name: "n".into(),
        }));
        assert!(completion_is_notable(
            &run,
            Some("Inbox has two urgent emails."),
            false,
            Some(&quiet(Some("NO_ACTION")))
        ));
        assert!(!completion_is_notable(
            &run,
            Some("NO_ACTION"),
            false,
            Some(&quiet(Some("NO_ACTION")))
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

#[cfg(test)]
mod notice_tests {
    use super::*;
    use crate::app::thread_tools::{NOTIFY, tests::fixture};
    use axum::{Json, extract::State, http::HeaderMap, routing::get};
    use falcondeck_core::notifications::NotificationListRequest;
    use std::sync::{Arc, Mutex as StdLock};

    async fn notify(app: &AppState, arguments: Value) -> Result<String, String> {
        app.invoke_thread_tool(NOTIFY, &arguments, Some("thread-1"), None)
            .await
            .map(|response| serde_json::to_string(&response).unwrap())
            .map_err(|error| error.to_string())
    }

    /// What a live session would write.
    async fn pushes(app: &AppState) -> Vec<AttentionPush> {
        let mut pushes = vec![];
        while let Some((push, claim)) = app.next_held_push().await {
            app.push_written(claim).await;
            pushes.push(push);
        }
        pushes
    }

    async fn only(app: &AppState) -> AttentionPush {
        let mut all = pushes(app).await;
        assert_eq!(all.len(), 1);
        all.remove(0)
    }

    /// A relay without `/notify` answers 404, so the push reaches the socket a
    /// moment later, as it does on a relay that has not been deployed yet.
    async fn next_push(app: &AppState) -> AttentionPush {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some((push, claim)) = app.next_held_push().await {
                    app.push_written(claim).await;
                    return push;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("no push arrived")
    }

    async fn bridge(app: &AppState) {
        remote_lifecycle::pair_for_tests(app).await;
    }

    async fn records(app: &AppState) -> Vec<NotificationRecord> {
        app.notifications_list(&NotificationListRequest::default())
            .await
            .items
    }

    #[tokio::test]
    async fn a_notice_reaches_the_phone_and_the_centre() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        let sent = notify(
            &app,
            json!({"title": "Deploy finished", "summary": "All green."}),
        )
        .await
        .unwrap();
        assert!(sent.contains("N-1"), "{sent}");
        let list = records(&app).await;
        assert_eq!(list[0].kind, NotificationKind::AgentNotice);
        assert_eq!(list[0].title, "Deploy finished");
        assert_eq!(
            list[0].target,
            thread_target("workspace-1", Some("thread-1"))
        );
        assert!(!list[0].has_body);
        let AttentionPush {
            kind,
            title,
            preview,
            notification_id,
            report_id,
            ..
        } = only(&app).await;
        assert_eq!(kind, "agent-notice");
        assert_eq!(title.as_deref(), Some("Deploy finished"));
        assert_eq!(preview.as_deref(), Some("All green."));
        assert_eq!(notification_id.as_deref(), Some("N-1"));
        assert_eq!(report_id, None);
    }

    #[tokio::test]
    async fn at_the_desk_a_normal_notice_is_quiet_and_a_high_one_is_not() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(true);
        notify(&app, json!({"title": "One", "summary": "Normal."}))
            .await
            .unwrap();
        assert!(pushes(&app).await.is_empty());
        notify(
            &app,
            json!({"title": "Two", "summary": "High.", "importance": "high"}),
        )
        .await
        .unwrap();
        assert_eq!(pushes(&app).await.len(), 1);
        assert_eq!(records(&app).await.len(), 2, "both are in the history");
    }

    #[tokio::test]
    async fn the_limit_refuses_with_directions_and_nothing_is_stored_or_pushed() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        for index in 0..3 {
            notify(&app, json!({"title": format!("n{index}"), "summary": "s"}))
                .await
                .unwrap();
        }
        pushes(&app).await;
        let error = notify(&app, json!({"title": "over", "summary": "s"}))
            .await
            .unwrap_err();
        assert!(
            error.contains("3 per hour") && error.contains("does not alert him"),
            "{error}"
        );
        assert_eq!(records(&app).await.len(), 3);
        assert!(pushes(&app).await.is_empty());
    }

    #[tokio::test]
    async fn a_retry_is_not_sent_twice() {
        let (app, _temp) = fixture().await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        let arguments = json!({"title": "Same", "summary": "Same."});
        notify(&app, arguments.clone()).await.unwrap();
        let again = notify(&app, arguments).await.unwrap();
        assert!(again.contains("already sent"), "{again}");
        assert_eq!(pushes(&app).await.len(), 1);
    }

    #[tokio::test]
    async fn arguments_are_bounded_and_an_agent_cannot_speak_for_another() {
        let (app, _temp) = fixture().await;
        for bad in [
            json!({"title": "  ", "summary": "s"}),
            json!({"title": "t", "summary": "\n"}),
            json!({"title": "t", "summary": "s", "sender": "bot:Juno"}),
            json!({"title": "t", "summary": "s", "thread_id": "other"}),
            json!({"title": "t", "summary": "s", "importance": "urgent"}),
            json!({"title": "t", "summary": "s", "body": "x".repeat(64_001)}),
        ] {
            assert!(notify(&app, bad.clone()).await.is_err(), "{bad}");
        }
        assert!(records(&app).await.is_empty());
        let long = json!({"title": "t".repeat(500), "summary": "s".repeat(500)});
        notify(&app, long).await.unwrap();
        let record = &records(&app).await[0];
        assert_eq!(record.title.chars().count(), 120);
        assert_eq!(record.preview.chars().count(), 200);
    }

    #[tokio::test]
    async fn the_tool_requires_a_real_calling_thread() {
        let (app, _temp) = fixture().await;
        let arguments = json!({"title": "t", "summary": "s"});
        assert!(
            app.invoke_thread_tool(NOTIFY, &arguments, None, None)
                .await
                .is_err()
        );
        assert!(
            app.invoke_thread_tool(NOTIFY, &arguments, Some("nope"), None)
                .await
                .is_err()
        );
        assert!(records(&app).await.is_empty());
    }

    #[derive(Clone, Default)]
    struct Relay {
        reports: bool,
        puts: Arc<StdLock<Vec<(String, falcondeck_core::PutRelayReportRequest)>>>,
        slow: std::time::Duration,
    }

    async fn capabilities(State(relay): State<Relay>) -> Json<Value> {
        tokio::time::sleep(relay.slow).await;
        Json(if relay.reports {
            json!({"expo": true, "apns": [], "reports": {"max_bytes": 262144, "max_ttl_seconds": 2592000}})
        } else {
            json!({"expo": true, "apns": []})
        })
    }

    async fn put(
        State(relay): State<Relay>,
        axum::extract::Path((session, report)): axum::extract::Path<(String, String)>,
        headers: HeaderMap,
        Json(request): Json<falcondeck_core::PutRelayReportRequest>,
    ) -> Json<Value> {
        assert_eq!(session, "session-1");
        assert_eq!(headers["authorization"], "Bearer daemon-token");
        relay.puts.lock().unwrap().push((report, request));
        Json(json!({}))
    }

    async fn paired(app: &AppState, relay: &Relay, key: [u8; 32]) {
        let router = axum::Router::new()
            .route("/v1/push-capabilities", get(capabilities))
            .route(
                "/v1/sessions/{session}/reports/{report}",
                axum::routing::put(put),
            )
            .with_state(relay.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut remote = app.inner.remote.lock().await;
        remote.relay_url = Some(url);
        remote.daemon_token = Some("daemon-token".into());
        remote.pairing = Some(RemotePairingState {
            pairing_id: "pairing".into(),
            pairing_code: "code".into(),
            session_id: Some("session-1".into()),
            device_id: None,
            trusted_at: None,
            expires_at: Utc::now(),
            client_bundle: None,
            local_key_pair: falcondeck_core::crypto::LocalBoxKeyPair::generate(),
            data_key: key,
        });
    }

    const REPORT: &str = "# Launch\n\nThe secret pricing change shipped.";

    #[tokio::test]
    async fn a_slow_relay_holds_the_notice_back_only_briefly_and_still_gets_the_report() {
        let (app, _temp) = fixture().await;
        let relay = Relay {
            reports: true,
            slow: REPORT_UPLOAD_WAIT + std::time::Duration::from_millis(300),
            ..Default::default()
        };
        paired(&app, &relay, [7; 32]).await;
        bridge(&app).await;
        notify(
            &app,
            json!({"title": "Launch", "summary": "Shipped.", "body": REPORT}),
        )
        .await
        .unwrap();
        assert!(relay.puts.lock().unwrap().is_empty(), "the wait ran out");
        let uploaded = async {
            while relay.puts.lock().unwrap().is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), uploaded)
            .await
            .expect("the upload outlives the wait");
    }

    #[tokio::test]
    async fn a_report_goes_up_encrypted_and_binds_itself_to_its_ids() {
        let (app, _temp) = fixture().await;
        let relay = Relay {
            reports: true,
            ..Default::default()
        };
        let key = [7; 32];
        paired(&app, &relay, key).await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        notify(
            &app,
            json!({"title": "Launch", "summary": "Shipped.", "body": REPORT}),
        )
        .await
        .unwrap();

        let (report_id, request) = relay.puts.lock().unwrap().remove(0);
        assert!(
            !serde_json::to_string(&request)
                .unwrap()
                .contains("secret pricing")
        );
        let plain: Value = falcondeck_core::crypto::decrypt_json(&key, &request.envelope).unwrap();
        assert_eq!(plain["body"], REPORT);
        assert_eq!(plain["report_id"], report_id);
        assert_eq!(plain["session_id"], "session-1");
        assert_eq!(plain["notification_id"], "N-1");
        assert!(request.ttl_seconds <= 30 * 24 * 60 * 60);

        let record = app.notification_get("N-1").await.unwrap();
        assert_eq!(record.body.as_deref(), Some(REPORT));
        assert!(record.report.as_ref().unwrap().hosted);
        let AttentionPush {
            report_id: pushed, ..
        } = next_push(&app).await;
        assert_eq!(
            pushed.as_deref(),
            Some(report_id.as_str()),
            "the push sends the id, never the text"
        );
    }

    #[tokio::test]
    async fn the_current_relay_gets_no_report_calls_and_the_notice_still_lands() {
        let (app, _temp) = fixture().await;
        let relay = Relay::default();
        paired(&app, &relay, [7; 32]).await;
        bridge(&app).await;
        app.set_desktop_activity(false);
        notify(
            &app,
            json!({"title": "Launch", "summary": "Shipped.", "body": REPORT}),
        )
        .await
        .unwrap();
        assert!(relay.puts.lock().unwrap().is_empty());
        next_push(&app).await;
        let record = app.notification_get("N-1").await.unwrap();
        assert_eq!(
            record.body.as_deref(),
            Some(REPORT),
            "the phone reads it from the daemon"
        );
        assert!(!record.report.unwrap().hosted);
    }

    #[tokio::test]
    async fn a_rotated_key_reuploads_and_a_second_pass_does_nothing() {
        let (app, _temp) = fixture().await;
        let relay = Relay {
            reports: true,
            ..Default::default()
        };
        paired(&app, &relay, [7; 32]).await;
        notify(
            &app,
            json!({"title": "Launch", "summary": "Shipped.", "body": REPORT}),
        )
        .await
        .unwrap();
        relay.puts.lock().unwrap().clear();

        app.sync_relay_reports().await;
        assert!(
            relay.puts.lock().unwrap().is_empty(),
            "already hosted under this key"
        );

        let rotated = [9; 32];
        app.inner
            .remote
            .lock()
            .await
            .pairing
            .as_mut()
            .unwrap()
            .data_key = rotated;
        app.sync_relay_reports().await;
        let (_, request) = relay.puts.lock().unwrap().remove(0);
        let plain: Value =
            falcondeck_core::crypto::decrypt_json(&rotated, &request.envelope).unwrap();
        assert_eq!(plain["body"], REPORT);
    }

    #[test]
    fn list_filters_parse_from_the_query_string() {
        let uri: axum::http::Uri = "/api/notifications?filter=needs_you&limit=5&before_seq=9"
            .parse()
            .unwrap();
        let axum::extract::Query(request) =
            axum::extract::Query::<NotificationListRequest>::try_from_uri(&uri).unwrap();
        assert_eq!(
            request.filter,
            falcondeck_core::notifications::NotificationFilter::NeedsYou
        );
        assert_eq!((request.limit, request.before_seq), (Some(5), Some(9)));
    }
}
