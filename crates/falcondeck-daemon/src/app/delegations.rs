//! Bounded, durable outcome outbox. Native harnesses remain the history store.
use super::*;
use chrono::DateTime;
use falcondeck_core::{TaskWait, ThreadOrigin};
use serde::{Deserialize, Serialize};

const RETENTION_DAYS: i64 = 7;
const MAX_REPORTS: usize = 100;
const MAX_TASKS: usize = 200;
const REPORT_PREFIX: &str = "user-delegation-report-";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum ResultDelivery {
    Wake,
    #[default]
    Batch,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
struct Delegation {
    id: String,
    bot_id: String,
    workspace: String,
    thread: String,
    delivery: ResultDelivery,
    admitted: bool,
    active: bool,
    turn: Option<String>,
    waiting: Option<TaskWait>,
    deadline_reported: bool,
    last_state: String,
    resumed: bool,
    closed: bool,
    waiting_notified: bool,
    same_turn_resume: bool,
    declared_finished: bool,
    missing_since: Option<DateTime<Utc>>,
    stale_reported: bool,
    input_key: Option<String>,
    #[serde(default = "Utc::now")]
    created: DateTime<Utc>,
    #[serde(default = "Utc::now")]
    changed: DateTime<Utc>,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
struct Report {
    id: String,
    bot_id: String,
    thread: String,
    text: String,
    wake: bool,
    #[serde(default = "Utc::now")]
    created: DateTime<Utc>,
    attempts: u8,
    next_attempt: Option<DateTime<Utc>>,
    urgent: bool,
    accepted: Option<DateTime<Utc>>,
    injections: u8,
    escalated: bool,
    recovery: bool,
}

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(super) struct Ledger {
    tasks: Vec<Delegation>,
    reports: Vec<Report>,
    // Old date map is retained for loading the first implementation.
    daily: HashMap<String, chrono::NaiveDate>,
    daily_sent: HashMap<String, DateTime<Utc>>,
    attempts: HashMap<String, Vec<DateTime<Utc>>>,
    expired: HashMap<String, usize>,
    upgraded: bool,
    registration_version: u8,
    alerts: Vec<Alert>,
    recovery: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
struct Alert {
    id: String,
    bot_id: String,
    reports: Vec<String>,
    text: String,
    delivered: bool,
    #[serde(default = "Utc::now")]
    created: DateTime<Utc>,
}

#[derive(Clone)]
struct Observation {
    summary: ThreadSummary,
    reply: Option<String>,
    input_key: Option<String>,
}

impl AppState {
    fn delegation_path(&self) -> PathBuf {
        self.inner.state_path.with_extension("delegations.json")
    }

    async fn delegation_store(&self) -> Result<&Mutex<Ledger>, DaemonError> {
        self.inner.delegations.get_or_try_init(|| async {
            let mut ledger: Ledger = match tokio::fs::read(self.delegation_path()).await {
                Ok(bytes) => match serde_json::from_slice(&bytes) {
                    Ok(value) => value,
                    Err(error) => {
                        // Keep the evidence, never make unrelated startup or bot
                        // admission depend on parsing optional coordination state.
                        let backup = self.delegation_path().with_extension(format!("corrupt-{}.json", Uuid::new_v4().simple()));
                        tokio::fs::rename(self.delegation_path(), &backup).await?;
                        tracing::error!(%error, path = %backup.display(), "quarantined unreadable delegation ledger");
                        let incident = Uuid::new_v4().to_string();
                        let mut fresh = Ledger { upgraded: true, registration_version: 2, recovery: Some(incident.clone()), ..Default::default() };
                        for bot in self.preferences().await.bots {
                            let text = "FalconDeck could not read delegated-work tracking. Check pending jobs and re-message tasks to restore watches; previous reports and deadlines could not be recovered.".to_string();
                            fresh.reports.push(Report { id: Uuid::new_v4().to_string(), bot_id: bot.id.clone(), text: text.clone(), wake: true, urgent: false, recovery: true, created: Utc::now(), ..Default::default() });

                        }
                        fresh.alerts.push(Alert { id: format!("tracking-recovery:{incident}"), bot_id: fresh.reports.first().map(|r| r.bot_id.clone()).unwrap_or_default(), text: "Delegated-work tracking was unreadable. Check pending tasks and re-message them to restore outcome watches and deadlines.".into(), created: Utc::now(), ..Default::default() });
                        if let Err(error) = self.save_delegations(&fresh).await { tracing::error!(%error, "could not persist tracking recovery notice"); }
                        fresh
                    }
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ledger::default(),
                Err(e) => return Err(e.into()),
            };
            ledger.tasks.retain(|t| !t.id.is_empty() && !t.thread.is_empty() && !t.bot_id.is_empty());
            for report in &mut ledger.reports {
                report.urgent |= ["failed/interrupted:", "needs input", "waiting deadline passed", "task deleted"].iter().any(|text| report.text.contains(text));
            }
            for task in &mut ledger.tasks {
                // Old ordinary idle records must not become perpetual reminders.
                if !task.active && task.waiting.is_none() && (task.last_state.starts_with("finished (") || task.last_state == "turn ended; completion unverified") {
                    task.closed = true;
                    task.same_turn_resume = !task.last_state.starts_with("finished (");
                }
            }
            Ok(Mutex::new(ledger))
        }).await
    }

    async fn save_delegations(&self, ledger: &Ledger) -> Result<(), DaemonError> {
        storage::write_atomically(&self.delegation_path(), serde_json::to_vec(ledger)?).await
    }

    /// Writers serialize publication, but serialization/fsync never holds the
    /// read lock used by context injection and completion notification routing.
    async fn edit_delegations<T>(
        &self,
        edit: impl FnOnce(&mut Ledger) -> T,
    ) -> Result<T, DaemonError> {
        let _writer = self.inner.delegation_persistence.lock().await;
        let store = self.delegation_store().await?;
        let mut next = store.lock().await.clone();
        let before = next.clone();
        let result = edit(&mut next);
        if next != before {
            self.save_delegations(&next).await?;
            *store.lock().await = next;
        }
        Ok(result)
    }

    pub(super) async fn track_delegation(
        &self,
        bot_id: &str,
        summary: &ThreadSummary,
        delivery: ResultDelivery,
    ) -> Result<String, DaemonError> {
        let id = Uuid::new_v4().to_string();
        let result = self
            .edit_delegations(|ledger| {
                prune(ledger, Utc::now());
                let waiting = ledger
                    .tasks
                    .iter()
                    .filter(|t| t.workspace == summary.workspace_id && t.thread == summary.id)
                    .find_map(|t| t.waiting.clone());
                let stronger = ledger.tasks.iter().any(|t| {
                    t.bot_id == bot_id
                        && t.thread == summary.id
                        && t.delivery == ResultDelivery::Wake
                });
                ledger
                    .tasks
                    .retain(|t| t.bot_id != bot_id || t.thread != summary.id);
                ledger.tasks.push(Delegation {
                    id: id.clone(),
                    bot_id: bot_id.into(),
                    workspace: summary.workspace_id.clone(),
                    thread: summary.id.clone(),
                    delivery: if stronger {
                        ResultDelivery::Wake
                    } else {
                        delivery
                    },
                    active: true,
                    turn: summary.latest_turn_id.clone(),
                    waiting,
                    created: Utc::now(),
                    changed: Utc::now(),
                    ..Default::default()
                });
                Ok(id.clone())
            })
            .await;
        match result {
            Ok(result) => {
                self.start_delegation_monitor();
                result
            }
            Err(error) => {
                let app = self.clone();
                let owner = bot_id.to_string();
                let task = summary.id.clone();
                tokio::spawn(async move {
                    if let Some(bot) = app
                        .preferences()
                        .await
                        .bots
                        .into_iter()
                        .find(|b| b.id == owner)
                    {
                        let notice = super::notification_centre::AgentNotice {
                            title: format!("{} cannot save task tracking", bot.name),
                            summary: format!(
                                "A message to task {task} is continuing, but its outcome watch could not be saved. Check the task and repair tracking storage."
                            ),
                            body: None,
                            importance:
                                falcondeck_core::notifications::NotificationImportance::High,
                            sender: format!("bot:{}", bot.name),
                            bot: Some(bot.name),
                            workspace_id: bot.workspace_id,
                            thread_id: bot.thread_id,
                        };
                        app.record_and_deliver_attention(
                            super::notification_centre::AttentionEvent::DelegationAlert {
                                notice: Box::new(notice),
                                key: format!(
                                    "tracking-write-failed:{owner}:{}",
                                    Utc::now().date_naive()
                                ),
                            },
                        )
                        .await;
                    }
                });
                Err(error)
            }
        }
    }

    pub(super) async fn admit_delegation(&self, id: &str) -> Result<(), DaemonError> {
        self.edit_delegations(|l| {
            if let Some(t) = l.tasks.iter_mut().find(|t| t.id == id) {
                t.admitted = true;
            }
        })
        .await
    }

    pub(super) async fn reject_delegation(&self, id: &str, error: &str) -> Result<(), DaemonError> {
        self.edit_delegations(|l| {
            if let Some(t) = l.tasks.iter_mut().find(|t| t.id == id) {
                t.admitted = true;
                t.active = false;
                t.closed = true;
                t.same_turn_resume = false;
                t.last_state = format!(
                    "dispatch failed before a confirmed turn start: {}",
                    short(error, 600)
                );
                t.changed = Utc::now();
                let mut report = report_for(t, None, None, false, Utc::now());
                // Admission failure is already returned to this caller.
                report.wake = false;
                push_report(l, report);
            }
        })
        .await
    }

    pub(super) async fn await_first_delegated_turn(&self, id: &str) -> Result<(), DaemonError> {
        self.edit_delegations(|l| {
            if let Some(t) = l.tasks.iter_mut().find(|t| t.id == id) {
                t.admitted = true;
                t.active = false;
                t.last_state = "not dispatched yet".into();
            }
        })
        .await
    }

    pub(super) fn start_delegation_monitor(&self) {
        if self
            .inner
            .delegation_monitor_started
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                let app = AppState { inner };
                if app.is_shutting_down() {
                    return;
                }
                // Readiness precedes optional reporting. In particular, do not
                // race a report wake with native interrupted-session recovery.
                if app.local_restore_phase() != DaemonRestorePhase::Ready {
                    continue;
                }
                if let Err(error) = app.upgrade_delegations().await {
                    tracing::error!(%error, "optional relationship recovery failed; tracking continues");
                }
                if let Err(error) = app.poll_delegations(false).await {
                    tracing::error!(%error, "delegation monitor failed; retained outbox");
                    tokio::time::sleep(Duration::from_secs(4)).await;
                }
            }
        });
    }

    pub(super) async fn restore_delegations(&self) -> Result<(), DaemonError> {
        // Preserve known interruption receipts now; historical metadata recovery
        // runs only after readiness so it cannot delay native workspace resume.
        self.poll_observations(true).await?;
        self.start_delegation_monitor();
        Ok(())
    }

    async fn upgrade_delegations(&self) -> Result<(), DaemonError> {
        if self
            .delegation_store()
            .await?
            .lock()
            .await
            .registration_version
            >= 2
        {
            return Ok(());
        }
        let bots = self.preferences().await.bots;
        let edges = self.delegation_relationships().await;
        let summaries: HashMap<_, _> = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .flat_map(|ws| ws.threads.values())
            .map(|t| {
                let mut s = sync_index::row(&t.summary);
                s.last_error = t.summary.last_error.clone();
                (s.id.clone(), s)
            })
            .collect();
        let mut owners: HashMap<String, String> = bots
            .iter()
            .flat_map(|b| {
                std::iter::once(b.thread_id.clone())
                    .chain(b.previous_thread_ids.clone())
                    .map(|id| (id, b.id.clone()))
            })
            .collect();
        for s in summaries.values() {
            if let Some(ThreadOrigin::Automation {
                bot_id: Some(id), ..
            }) = &s.origin
            {
                owners.insert(s.id.clone(), id.clone());
            }
        }
        // Creation ancestry is used only for reporting registration here. The
        // provenance branch owns restoring/backfilling ThreadOrigin itself.
        for _ in 0..32 {
            let mut added = Vec::new();
            for s in summaries.values() {
                if let Some(ThreadOrigin::AgentSpawn {
                    parent_thread_id, ..
                }) = &s.origin
                {
                    if let Some(owner) = owners.get(parent_thread_id) {
                        if !owners.contains_key(&s.id) {
                            added.push((s.id.clone(), owner.clone()));
                        }
                    }
                }
            }
            for (from, to, _, created) in &edges {
                if *created {
                    if let Some(owner) = owners.get(from) {
                        if !owners.contains_key(to) {
                            added.push((to.clone(), owner.clone()));
                        }
                    }
                }
            }
            if added.is_empty() {
                break;
            }
            owners.extend(added);
        }
        let mut related: HashMap<(String, String), DateTime<Utc>> = HashMap::new();
        for (id, owner) in &owners {
            if summaries
                .get(id)
                .is_some_and(|s| matches!(s.origin, Some(ThreadOrigin::AgentSpawn { .. })))
            {
                related.insert((owner.clone(), id.clone()), summaries[id].updated_at);
            }
        }
        for (from, to, at, _) in edges {
            if let Some(owner) = owners.get(&from) {
                related
                    .entry((owner.clone(), to))
                    .and_modify(|old| *old = (*old).max(at))
                    .or_insert(at);
            }
        }
        let children: Vec<_> = related
            .into_iter()
            .filter_map(|((owner, id), at)| {
                if bots.iter().any(|b| b.thread_id == id) {
                    return None;
                }
                let s = summaries.get(&id)?;
                let live = matches!(
                    s.status,
                    ThreadStatus::Running | ThreadStatus::WaitingForInput
                ) || is_shutdown_interrupted(&s.status, s.last_error.as_deref());
                if !live && (s.is_archived || at < Utc::now() - ChronoDuration::days(7)) {
                    return None;
                }
                Some((owner, s.clone()))
            })
            .collect();
        self.edit_delegations(|l| {
            let mut recovered = Vec::new();
            for (bot, s) in children {
                if l.tasks.iter().any(|t| t.bot_id == bot && t.thread == s.id) {
                    continue;
                }
                let inflight = matches!(
                    s.status,
                    ThreadStatus::Running | ThreadStatus::WaitingForInput
                ) || is_shutdown_interrupted(&s.status, s.last_error.as_deref());
                let task = Delegation {
                    id: Uuid::new_v4().to_string(),
                    bot_id: bot,
                    workspace: s.workspace_id.clone(),
                    thread: s.id.clone(),
                    active: inflight,
                    admitted: true,
                    closed: !inflight,
                    turn: s.latest_turn_id.clone(),
                    created: Utc::now(),
                    changed: Utc::now(),
                    last_state: if inflight {
                        "upgrade recovered in-flight work".into()
                    } else {
                        "upgrade found an idle task; verify its latest outcome".into()
                    },
                    ..Default::default()
                };
                if !inflight {
                    recovered.push(report_for(
                        &task,
                        Some(&s),
                        None,
                        s.status == ThreadStatus::Error,
                        Utc::now(),
                    ));
                }
                l.tasks.push(task);
            }
            merge_reports(l, recovered);
            l.upgraded = true;
            l.registration_version = 2;
        })
        .await
    }

    /// One linear snapshot per tick; no transcript hydration, artifact clones,
    /// task-by-task workspace scans or per-task ledger rewrites.
    async fn observations(&self) -> (HashMap<(String, String), Observation>, bool) {
        let mut out = HashMap::new();
        let ids: HashSet<_> = match self.delegation_store().await {
            Ok(store) => store
                .lock()
                .await
                .tasks
                .iter()
                .map(|t| (t.workspace.clone(), t.thread.clone()))
                .collect(),
            Err(_) => return (out, false),
        };
        {
            let workspaces = self.inner.workspaces.lock().await;
            for ws in workspaces.values() {
                for t in ws.threads.values() {
                    if !ids.contains(&(ws.summary.id.clone(), t.summary.id.clone())) {
                        continue;
                    }
                    let mut summary = sync_index::row(&t.summary);
                    summary.last_error = t.summary.last_error.as_deref().map(|s| short(s, 600));
                    if t.transient_retry_in_flight
                        || t.dispatching_request.is_some()
                        || !t.queued_requests.is_empty()
                            && summary.status != ThreadStatus::WaitingForInput
                    {
                        summary.status = ThreadStatus::Running;
                    }
                    if summary.provider == AgentProvider::CODEX
                        && summary.status == ThreadStatus::Running
                        && ws.codex_session.as_ref().is_some_and(|s| s.is_closed())
                    {
                        summary.status = ThreadStatus::Error;
                        summary.last_error =
                            Some("Codex app-server disconnected during tracked turn".into());
                    }
                    let latest_reply = t.items.iter().rev().find_map(|i| {
                        if let ConversationItem::AssistantMessage {
                            text,
                            created_at,
                            lifecycle: ContentLifecycle::Complete,
                            ..
                        } = i
                        {
                            Some((short(text, 400), *created_at))
                        } else {
                            None
                        }
                    });
                    summary.last_message_at = latest_reply.as_ref().map(|(_, at)| *at);
                    let reply = latest_reply.map(|(text, _)| text);
                    let input_key = t.items.iter().rev().find_map(|item| match item {
                        ConversationItem::InteractiveRequest {
                            id,
                            created_at,
                            resolved: false,
                            ..
                        } => Some(format!("{id}:{created_at}")),
                        _ => None,
                    });
                    out.insert(
                        (ws.summary.id.clone(), summary.id.clone()),
                        Observation {
                            summary,
                            reply,
                            input_key,
                        },
                    );
                }
            }
        }
        // Cloud summaries are already a bounded projection; fetch once, not per watch.
        let mut cloud_known = false;
        if let Ok(threads) = self.cloud_manager().thread_summaries().await {
            cloud_known = true;
            for summary in threads {
                if ids.contains(&(summary.workspace_id.clone(), summary.id.clone())) {
                    out.insert(
                        (summary.workspace_id.clone(), summary.id.clone()),
                        Observation {
                            reply: None,
                            summary,
                            input_key: None,
                        },
                    );
                }
            }
        }
        (out, cloud_known)
    }

    async fn poll_observations(&self, restarting: bool) -> Result<(), DaemonError> {
        let (observations, cloud_known) = self.observations().await;
        let known_workspaces: HashSet<_> = self
            .inner
            .workspaces
            .lock()
            .await
            .iter()
            .filter(|(_, w)| w.summary.status == WorkspaceStatus::Ready)
            .map(|(id, _)| id.clone())
            .collect();
        let saved: HashSet<_> = self
            .inner
            .saved_workspaces
            .lock()
            .await
            .values()
            .filter_map(|w| w.id.clone())
            .collect();
        let ready = self.local_restore_phase() == DaemonRestorePhase::Ready;
        let present: HashSet<_> = self.inner.workspaces.lock().await.keys().cloned().collect();
        self.edit_delegations(|l| {
            let now = Utc::now();
            let mut reports = Vec::new();
            for t in &mut l.tasks {
                if !t.closed && !t.stale_reported && now-t.created >= ChronoDuration::days(7) {
                    t.stale_reported = true;
                    reports.push(Report { id: Uuid::new_v4().to_string(), bot_id: t.bot_id.clone(), thread: t.thread.clone(), text: format!("Task [{}] has remained open for over seven days. Check progress or declare it finished; tracking remains active.", t.thread), urgent: true, wake: true, created: now, ..Default::default() });
                }
                let observation = observations.get(&(t.workspace.clone(), t.thread.clone()));
                let definitively_missing = if self.is_cloud_thread(&t.thread) {
                    cloud_known
                } else {
                    known_workspaces.contains(&t.workspace)
                        || ready && !saved.contains(&t.workspace) && !present.contains(&t.workspace)
                };
                if let Some(observation) = observation {
                    t.missing_since = None;
                    if observation.summary.status == ThreadStatus::WaitingForInput && observation.input_key.is_some() && t.input_key != observation.input_key {
                        t.input_key = observation.input_key.clone();
                        t.last_state = "new input request".into();
                    }
                }
                if observation.is_none() && definitively_missing && !t.closed {
                    let since = *t.missing_since.get_or_insert(now);
                    if now - since < ChronoDuration::minutes(2) {
                        continue;
                    }
                    t.active = false;
                    t.closed = true;
                    t.same_turn_resume = false;
                    t.waiting = None;
                    t.last_state = "task deleted or unavailable in its owning workspace".into();
                    t.changed = now;
                    reports.push(report_for(t, None, None, true, now));
                } else if let Some(report) = observe(
                    t,
                    observation.map(|o| &o.summary),
                    observation.and_then(|o| o.reply.as_deref()),
                    restarting,
                    now,
                ) {
                    reports.push(report);
                }
            }
            merge_reports(l, reports);
            prune(l, now);
        })
        .await?;
        self.project_task_waits().await
    }

    pub(super) async fn poll_delegations(&self, restarting: bool) -> Result<(), DaemonError> {
        self.poll_observations(restarting).await?;
        self.daily_delegation_summary().await?;
        self.escalate_delegations().await?;
        self.deliver_delegation_wakes().await
    }

    pub(super) async fn delegation_context(
        &self,
        thread: &str,
    ) -> Result<(String, Vec<String>), DaemonError> {
        let Some(bot) = self
            .bot_for_thread(thread)
            .await
            .filter(|b| b.thread_id == thread)
        else {
            return Ok(Default::default());
        };
        let store = match self.delegation_store().await {
            Ok(s) => s,
            Err(error) => {
                tracing::error!(%error, "outcome context unavailable; allowing bot turn");
                return Ok(Default::default());
            }
        };
        let l = store.lock().await;
        {
            let mut reports: Vec<_> = l
                .reports
                .iter()
                .filter(|r| r.bot_id == bot.id && r.injections < 3)
                .collect();
            reports.sort_by_key(|r| {
                (
                    r.accepted.is_some(),
                    !r.urgent,
                    std::cmp::Reverse(r.created),
                )
            });
            reports.truncate(30);
            let ids: Vec<_> = reports.iter().map(|r| r.id.clone()).collect();
            let mut text = reports
                .iter()
                .map(|r| r.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let collapsed = l
                .reports
                .iter()
                .filter(|r| r.bot_id == bot.id && r.injections >= 3 && !ids.contains(&r.id))
                .count();
            if collapsed > 0 {
                text.push_str(&format!("\n{collapsed} previously presented reports remain unacknowledged; inspect task history. Details are no longer repeated on every turn."));
            }
            if let Some(count) = l.expired.get(&bot.id).filter(|n| **n > 0) {
                text.push_str(&format!(
                    "\n{count} older reports expired; inspect native task history."
                ));
            }
            if text.is_empty() {
                return Ok(Default::default());
            }
            Ok((
                format!(
                    "\n\n## Delegated outcomes (daemon)\n{text}\nAfter reading, call falcondeck_acknowledge_results with report_ids {}. This confirms receipt, not task completion. Do not message sources merely to acknowledge.\n",
                    json!(ids)
                ),
                ids,
            ))
        }
    }

    /// Provider startup succeeded with these exact reports in its context.
    /// Receipt stops automatic report retries; acknowledgement still owns removal.
    pub(super) async fn accepted_delegation_context(
        &self,
        thread: &str,
        ids: &[String],
        automatic: bool,
    ) {
        if ids.is_empty() {
            return;
        }
        let Some(bot) = self
            .bot_for_thread(thread)
            .await
            .filter(|b| b.thread_id == thread)
        else {
            return;
        };
        if let Err(error) = self
            .edit_delegations(|l| {
                let now = Utc::now();
                for r in l
                    .reports
                    .iter_mut()
                    .filter(|r| r.bot_id == bot.id && ids.contains(&r.id))
                {
                    r.accepted.get_or_insert(now);
                    r.injections = r.injections.saturating_add(1);
                    r.wake = false;
                    if automatic {
                        r.attempts = r.attempts.saturating_add(1);
                    }
                }
                if automatic {
                    l.attempts.entry(bot.id).or_default().push(now);
                }
            })
            .await
        {
            tracing::error!(%error, "could not persist accepted report receipt; retained outbox");
        }
    }

    /// Only an explicit tool call from the current home can confirm receipt.
    /// Native admission, ACP startup and scheduled bot runs cannot consume it.
    pub(super) async fn acknowledge_bot_delegations(
        &self,
        thread: &str,
        ids: &[String],
    ) -> Result<(), DaemonError> {
        let bot = self
            .bot_for_thread(thread)
            .await
            .filter(|b| b.thread_id == thread)
            .ok_or_else(|| {
                DaemonError::BadRequest(
                    "Only a bot's current home can acknowledge its outcomes".into(),
                )
            })?;
        self.edit_delegations(|l| {
            l.reports
                .retain(|r| r.bot_id != bot.id || !ids.contains(&r.id));
            l.expired.remove(&bot.id);
        })
        .await
    }

    async fn deliver_delegation_wakes(&self) -> Result<(), DaemonError> {
        if self.local_restore_phase() != DaemonRestorePhase::Ready || self.is_shutting_down() {
            return Ok(());
        }
        for bot in self.preferences().await.bots {
            if bot.status.is_resting() {
                continue;
            }
            let Some(workspace) = self.bot_workspace(&bot).await else {
                continue;
            };
            let Ok(home) = self.thread_summary(&workspace, &bot.thread_id).await else {
                continue;
            };
            if home.is_archived
                || !matches!(home.status, ThreadStatus::Idle | ThreadStatus::Error)
                || !home.queued_turns.is_empty()
                || home.attention.pending_approval_count + home.attention.pending_question_count > 0
            {
                continue;
            }
            if is_shutdown_interrupted(&home.status, home.last_error.as_deref()) {
                continue;
            }
            if self
                .inner
                .delegation_sends
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains(&bot.id)
            {
                continue;
            }
            let ready = self
                .edit_delegations(|l| {
                    let now = Utc::now();
                    let attempts = l.attempts.entry(bot.id.clone()).or_default();
                    attempts.retain(|at| now.signed_duration_since(*at) < ChronoDuration::days(1));
                    if attempts.len() >= 6
                        || attempts
                            .iter()
                            .filter(|at| now.signed_duration_since(**at) < ChronoDuration::hours(1))
                            .count()
                            >= 3
                    {
                        return false;
                    }
                    let ready = l.reports.iter().any(|r| {
                        r.bot_id == bot.id
                            && r.wake
                            && r.accepted.is_none()
                            && r.injections < 3
                            && now.signed_duration_since(r.created).num_milliseconds() >= 500
                            && r.next_attempt.is_none_or(|at| at <= now)
                    });
                    if !ready {
                        return false;
                    }
                    for r in l.reports.iter_mut().filter(|r| {
                        r.bot_id == bot.id && r.wake && r.accepted.is_none() && r.injections < 3
                    }) {
                        r.next_attempt = Some(now + ChronoDuration::minutes(5));
                    }
                    true
                })
                .await?;
            if !ready {
                continue;
            }
            self.inner
                .delegation_sends
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(bot.id.clone());
            let app = self.clone();
            tokio::spawn(async move {
                let request = serde_json::from_value(
                    json!({"workspace_id": workspace, "thread_id": bot.thread_id,
                    "user_item_id":format!("{REPORT_PREFIX}{}", Uuid::new_v4().simple()),
                    "inputs":[{"type":"text","text":"FalconDeck delegated outcomes need attention. Read the outcome context and acknowledge receipt with falcondeck_acknowledge_results. Do not repeat interrupted jobs without checking their state."}]}),
                );
                if let Ok(request) = request {
                    dispatch_with_lease(app.clone(), request, Duration::from_secs(30)).await;
                }
                app.inner
                    .delegation_sends
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&bot.id);
            });
        }
        Ok(())
    }

    async fn daily_delegation_summary(&self) -> Result<(), DaemonError> {
        self.edit_delegations(|l| {
            let now = Utc::now();
            let mut oldest: HashMap<String, DateTime<Utc>> = HashMap::new();
            for (bot, at) in l.tasks.iter().filter(|t| !t.closed).map(|t| (&t.bot_id, t.created))
                .chain(l.reports.iter().filter(|r| !r.thread.is_empty()).map(|r| (&r.bot_id, r.created))) {
                oldest.entry(bot.clone()).and_modify(|old| *old = (*old).min(at)).or_insert(at);
            }
            for (bot, first) in oldest {
                if now - first < ChronoDuration::days(1) { continue; }
                let stagger = bot.bytes().fold(0u64, |n,b| n.wrapping_mul(31).wrapping_add(b as u64)) % 60;
                let due = l.daily_sent.get(&bot).map(|t| *t + ChronoDuration::days(1))
                    .unwrap_or(first + ChronoDuration::days(1) + ChronoDuration::minutes(stagger as i64));
                if now < due { continue; }
                let pending = l.reports.iter().filter(|r| r.bot_id == bot && !r.thread.is_empty()).count();
                let mut tasks: Vec<_> = l.tasks.iter().filter(|t| t.bot_id == bot && !t.closed).collect();
                tasks.sort_by_key(|t| std::cmp::Reverse(t.changed));
                let text = tasks.iter().take(10).map(|t| format!("- [{}]: {}{}", t.thread, if t.active { "turn pending" } else { &t.last_state }, if now-t.created >= ChronoDuration::days(7) { "; open more than seven days: check progress" } else { "" })).collect::<Vec<_>>().join("\n");
                push_report(l, Report { id: Uuid::new_v4().to_string(), bot_id: bot.clone(), text: format!("Daily delegated-work check: {pending} unacknowledged outcomes. Inspect recent task history and resolve pending work.\n{text}"), wake: true, created: now, ..Default::default() });
                l.daily_sent.insert(bot, now);
            }
        }).await
    }

    async fn escalate_delegations(&self) -> Result<(), DaemonError> {
        self.edit_delegations(|l| {
            let now = Utc::now();
            let claimed: HashSet<_> = l
                .alerts
                .iter()
                .flat_map(|a| a.reports.iter().cloned())
                .collect();
            let bots: HashSet<_> = l
                .reports
                .iter()
                .filter(|r| {
                    r.urgent
                        && r.accepted.is_none()
                        && !r.escalated
                        && now - r.created >= ChronoDuration::hours(2)
                        && !claimed.contains(&r.id)
                })
                .map(|r| r.bot_id.clone())
                .collect();
            for bot in bots {
                let reports: Vec<_> = l
                    .reports
                    .iter()
                    .filter(|r| {
                        r.bot_id == bot
                            && r.urgent
                            && r.accepted.is_none()
                            && !r.escalated
                            && now - r.created >= ChronoDuration::hours(2)
                            && !claimed.contains(&r.id)
                    })
                    .collect();
                l.alerts.push(Alert {
                    id: format!("delegation-escalation:{}", Uuid::new_v4()),
                    bot_id: bot,
                    reports: reports.iter().map(|r| r.id.clone()).collect(),
                    text: reports
                        .iter()
                        .map(|r| r.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    delivered: false,
                    created: now,
                });
            }
        })
        .await?;
        let alerts = self
            .delegation_store()
            .await?
            .lock()
            .await
            .alerts
            .iter()
            .filter(|a| !a.delivered)
            .cloned()
            .collect::<Vec<_>>();
        let bots = self.preferences().await.bots;
        for alert in alerts {
            let bot = bots.iter().find(|b| b.id == alert.bot_id);
            let name = bot.map(|b| b.name.as_str()).unwrap_or("FalconDeck");
            let notice = super::notification_centre::AgentNotice {
                title: format!("{name} needs help with delegated work"),
                summary: short(
                    &format!(
                        "{}: {}. Check the task; the bot has not received its outcome.",
                        short(name, 40),
                        short(&alert.text, 100)
                    ),
                    200,
                ),
                body: Some(alert.text.clone()),
                importance: falcondeck_core::notifications::NotificationImportance::High,
                sender: format!("bot:{name}"),
                bot: bot.map(|b| b.name.clone()),
                workspace_id: bot.map(|b| b.workspace_id.clone()).unwrap_or_default(),
                thread_id: bot.map(|b| b.thread_id.clone()).unwrap_or_default(),
            };
            let recorded = self
                .record_and_deliver_attention(
                    super::notification_centre::AttentionEvent::DelegationAlert {
                        notice: Box::new(notice),
                        key: alert.id.clone(),
                    },
                )
                .await;
            if let super::notification_centre::AttentionOutcome::Refused(reason) = recorded {
                return Err(DaemonError::Process(format!(
                    "escalation remains pending: {reason:?}"
                )));
            }
            self.edit_delegations(|l| {
                if let Some(a) = l.alerts.iter_mut().find(|a| a.id == alert.id) {
                    a.delivered = true;
                }
                for r in l
                    .reports
                    .iter_mut()
                    .filter(|r| alert.reports.contains(&r.id))
                {
                    r.escalated = true;
                }
            })
            .await?;
        }
        Ok(())
    }

    pub(super) async fn bot_tracks_completion(&self, thread: &str, turn: Option<&str>) -> bool {
        // A peer's private home reply must remain James's notification, and a
        // resting coordinator cannot be the only audience for a worker result.
        if self.bot_for_thread(thread).await.is_some() {
            return false;
        }
        let bots = self.preferences().await.bots;
        let homes: HashMap<_, _> = bots
            .into_iter()
            .filter(|b| !b.status.is_resting())
            .map(|b| (b.thread_id, b.id))
            .collect();
        let active: HashSet<_> = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .flat_map(|w| w.threads.values())
            .filter_map(|t| {
                if t.summary.is_archived
                    || t.summary.status == ThreadStatus::Error
                    || t.summary.attention.pending_approval_count
                        + t.summary.attention.pending_question_count
                        > 0
                {
                    None
                } else {
                    homes.get(&t.summary.id).cloned()
                }
            })
            .collect();
        let Some(store) = self.inner.delegations.get() else {
            return false;
        };
        let l = store.lock().await;
        l.tasks.iter().any(|t| {
            t.thread == thread
                && active.contains(&t.bot_id)
                && (t.active
                    || t.turn.as_deref() == turn
                        && l.reports
                            .iter()
                            .any(|r| r.bot_id == t.bot_id && r.thread == thread))
        })
    }

    pub(super) async fn owns_delegation(
        &self,
        bot: Option<&str>,
        thread: &str,
    ) -> Result<bool, DaemonError> {
        Ok(self
            .delegation_store()
            .await?
            .lock()
            .await
            .tasks
            .iter()
            .any(|t| Some(t.bot_id.as_str()) == bot && t.thread == thread))
    }

    pub(super) async fn declare_task_wait(
        &self,
        workspace: &str,
        thread: &str,
        waiting: Option<TaskWait>,
    ) -> Result<(), DaemonError> {
        self.declare_task_wait_by(workspace, thread, waiting, None)
            .await
    }

    pub(super) async fn declare_task_wait_by(
        &self,
        workspace: &str,
        thread: &str,
        waiting: Option<TaskWait>,
        actor: Option<&str>,
    ) -> Result<(), DaemonError> {
        let found = self
            .edit_delegations(|l| {
                let mut found = false;
                for t in l
                    .tasks
                    .iter_mut()
                    .filter(|t| t.workspace == workspace && t.thread == thread)
                {
                    if t.closed {
                        if waiting.is_none() {
                            found = true;
                            t.declared_finished = true;
                            t.same_turn_resume = false;
                            t.waiting = None;
                            t.last_state = "finished (declared by task or coordinator)".into();
                            continue;
                        }
                        if t.same_turn_resume || t.last_state.starts_with("waiting deadline passed")
                        {
                            t.closed = false;
                            t.active = true;
                            t.created = Utc::now();
                        } else {
                            continue;
                        }
                    }
                    found = true;
                    if t.waiting == waiting && waiting.is_some() {
                        continue;
                    }
                    t.waiting = waiting.clone();
                    t.waiting_notified = false;
                    t.deadline_reported = false;
                    t.changed = Utc::now();
                    if waiting.is_none() {
                        t.declared_finished = true;
                        t.last_state = "finished (declared by task or coordinator)".into();
                        if actor == Some(t.bot_id.as_str()) {
                            t.active = false;
                            t.closed = true;
                            t.same_turn_resume = false;
                        } else {
                            t.active = true;
                        }
                    }
                }
                found
            })
            .await?;
        if !found {
            return Err(DaemonError::BadRequest(
                "Task has no open tracking interval; re-message it before declaring a wait".into(),
            ));
        }
        self.project_task_waits().await?;
        if self.is_cloud_thread(thread) {
            self.publish_cloud_summary(thread).await;
        }
        Ok(())
    }

    pub(super) async fn project_delegation_wait(&self, summary: &mut ThreadSummary) {
        if let Some(store) = self.inner.delegations.get() {
            summary.attention.task_wait = store
                .lock()
                .await
                .tasks
                .iter()
                .find(|t| {
                    t.workspace == summary.workspace_id && t.thread == summary.id && !t.closed
                })
                .and_then(|t| t.waiting.clone());
        }
    }

    async fn project_task_waits(&self) -> Result<(), DaemonError> {
        let tasks = self.delegation_store().await?.lock().await.tasks.clone();
        let waits: HashMap<_, _> = tasks
            .into_iter()
            .filter(|t| !t.closed)
            .filter_map(|t| t.waiting.map(|w| ((t.workspace, t.thread), w)))
            .collect();
        let mut changes = Vec::new();
        {
            let mut workspaces = self.inner.workspaces.lock().await;
            for ws in workspaces.values_mut() {
                for t in ws.threads.values_mut() {
                    let wait = waits
                        .get(&(ws.summary.id.clone(), t.summary.id.clone()))
                        .cloned();
                    if t.summary.attention.task_wait != wait {
                        t.summary.attention.task_wait = wait;
                        let approvals = t.summary.attention.pending_approval_count;
                        let questions = t.summary.attention.pending_question_count;
                        threads::refresh_thread_attention(&mut t.summary, approvals, questions);
                        changes.push(t.summary.clone());
                    }
                }
            }
        }
        for thread in changes {
            self.emit(
                Some(thread.workspace_id.clone()),
                Some(thread.id.clone()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
        Ok(())
    }
}

async fn dispatch_with_lease(app: AppState, request: SendTurnRequest, lease: Duration) {
    // A timeout releases only the caller's lease. The owned provider future
    // must finish its admission/cleanup instead of being cancelled at Running.
    let mut send = tokio::spawn(async move { app.send_automatic_turn(request).await });
    match timeout(lease, &mut send).await {
        Ok(Ok(Ok(_))) => {}
        Ok(Ok(Err(error))) => tracing::warn!(%error, "delegation dispatch failed; report retained"),
        Ok(Err(error)) => tracing::warn!(%error, "delegation send task failed"),
        Err(error) => tracing::warn!(%error, "delegation lease expired; send continues"),
    }
}

pub(super) fn is_report_turn(items: &[ConversationItem]) -> bool {
    items
        .iter()
        .rev()
        .find_map(|i| match i {
            ConversationItem::UserMessage { id, text, .. } => Some(
                id.starts_with(REPORT_PREFIX)
                    || text.starts_with("FalconDeck delegated outcomes need attention."),
            ),
            _ => None,
        })
        .unwrap_or(false)
}

fn short(text: &str, max: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn report_for(
    t: &Delegation,
    summary: Option<&ThreadSummary>,
    reply: Option<&str>,
    urgent: bool,
    now: DateTime<Utc>,
) -> Report {
    Report {
        id: Uuid::new_v4().to_string(),
        bot_id: t.bot_id.clone(),
        thread: t.thread.clone(),
        text: format!(
            "- {} [{}]: {}; status={}{}\n  Latest reply: {}",
            summary.map(|s| s.title.as_str()).unwrap_or("Task"),
            t.thread,
            t.last_state,
            summary
                .map(|s| format!("{:?}", s.status))
                .unwrap_or_else(|| "unavailable".into()),
            if t.resumed { "; resumed turn" } else { "" },
            reply
                .map(|s| short(s, 400))
                .unwrap_or_else(|| "unavailable".into())
        ),
        wake: urgent || t.delivery == ResultDelivery::Wake && t.closed,
        urgent,
        created: now,
        ..Default::default()
    }
}

fn merge_reports(l: &mut Ledger, reports: Vec<Report>) {
    if reports.is_empty() {
        return;
    }
    let mut latest = HashMap::new();
    let mut urgent = Vec::new();
    for r in std::mem::take(&mut l.reports) {
        if r.urgent && r.accepted.is_none() && !r.thread.is_empty() {
            urgent.push(r);
        } else {
            latest.insert((r.bot_id.clone(), r.thread.clone(), r.recovery), r);
        }
    }
    for r in reports {
        let key = (r.bot_id.clone(), r.thread.clone(), r.recovery);
        latest.remove(&key);
        if r.urgent && r.accepted.is_none() && !r.thread.is_empty() {
            urgent.push(r);
        } else {
            latest.insert(key, r);
        }
    }
    l.reports = latest.into_values().chain(urgent).collect();
}

fn push_report(l: &mut Ledger, report: Report) {
    merge_reports(l, vec![report]);
}

fn prune(l: &mut Ledger, now: DateTime<Utc>) {
    let cutoff = now - ChronoDuration::days(RETENTION_DAYS);
    let mut dropped = HashMap::<String, usize>::new();
    l.reports.retain(|r| {
        let keep = r.created >= cutoff
            || r.recovery && r.accepted.is_none()
            || r.urgent && r.accepted.is_none() && !r.escalated;
        if !keep {
            *dropped.entry(r.bot_id.clone()).or_default() += 1;
        }
        keep
    });
    l.tasks.retain(|t| !t.closed || t.changed >= cutoff);
    let owners: HashSet<_> = l.tasks.iter().map(|t| t.bot_id.clone()).collect();
    for owner in owners {
        let mut closed: Vec<_> = l
            .tasks
            .iter()
            .filter(|t| t.bot_id == owner && t.closed)
            .collect();
        closed.sort_by_key(|t| std::cmp::Reverse(t.changed));
        let keep: HashSet<_> = closed
            .into_iter()
            .take(MAX_TASKS)
            .map(|t| t.id.clone())
            .collect();
        l.tasks
            .retain(|t| t.bot_id != owner || !t.closed || keep.contains(&t.id));
    }
    let bots: HashSet<_> = l.reports.iter().map(|r| r.bot_id.clone()).collect();
    for bot in bots {
        let mut reports: Vec<_> = l.reports.iter().filter(|r| r.bot_id == bot).collect();
        reports.sort_by_key(|r| (r.injections >= 3, !r.urgent, std::cmp::Reverse(r.created)));
        let keep: HashSet<_> = reports
            .into_iter()
            .take(MAX_REPORTS)
            .map(|r| r.id.clone())
            .collect();
        l.reports.retain(|r| {
            let retained = r.bot_id != bot || keep.contains(&r.id) || r.accepted.is_none();
            if !retained {
                *dropped.entry(r.bot_id.clone()).or_default() += 1;
            }
            retained
        });
    }
    for (bot, n) in dropped {
        *l.expired.entry(bot).or_default() += n;
    }
    l.alerts.retain(|a| !a.delivered || a.created >= cutoff);
    for attempts in l.attempts.values_mut() {
        attempts.retain(|at| now.signed_duration_since(*at) < ChronoDuration::days(1));
    }
}

fn observe(
    t: &mut Delegation,
    summary: Option<&ThreadSummary>,
    reply: Option<&str>,
    restarting: bool,
    now: DateTime<Utc>,
) -> Option<Report> {
    if !t.admitted {
        return None;
    }
    let was_waiting = t.waiting.is_some();
    let mut urgent = false;
    let state = if t.waiting.as_ref().is_some_and(|w| w.deadline <= now)
        && !t.deadline_reported
        && !t.closed
    {
        t.deadline_reported = true;
        t.waiting = None;
        t.active = false;
        t.closed = true;
        t.same_turn_resume = false;
        urgent = true;
        Some("waiting deadline passed; tracking stopped until explicit follow-up".to_string())
    } else if restarting && t.active && !t.closed {
        t.active = false;
        t.last_state =
            "interrupted by daemon restart; outcome unknown; inspect native recovery state".into();
        urgent = true;
        Some(t.last_state.clone())
    } else if restarting {
        None
    } else if let Some(s) = summary {
        if !t.active && is_shutdown_interrupted(&s.status, s.last_error.as_deref()) {
            return None;
        }
        let busy = s.status == ThreadStatus::Running;
        let fresh_reply = s.last_message_at.is_some_and(|at| at > t.changed);
        if t.closed {
            if !(t.same_turn_resume
                && t.turn == s.latest_turn_id
                && (busy
                    || fresh_reply
                    || matches!(
                        s.status,
                        ThreadStatus::WaitingForInput | ThreadStatus::Error
                    )))
            {
                return None;
            }
            t.closed = false;
            t.active = true;
            t.resumed = true;
        }
        if !busy && !t.active && t.waiting_notified && t.turn == s.latest_turn_id && fresh_reply {
            t.active = true;
            t.waiting = None;
            t.resumed = true;
        }
        if busy {
            if !t.active {
                t.resumed = t.last_state != "not dispatched yet";
                // Same-id Claude background wake: the parked wait has resumed.
                // A polling turn with a new id leaves its wait intact.
                if t.waiting_notified && t.turn == s.latest_turn_id {
                    t.waiting = None;
                }
            }
            t.active = true;
            t.last_state = "running".into();
            t.turn = s.latest_turn_id.clone();
            return None;
        }
        if s.status == ThreadStatus::WaitingForInput {
            if t.last_state == "needs input" {
                return None;
            }
            t.active = false;
            urgent = true;
            Some("needs input".into())
        } else if s.status == ThreadStatus::Error && !t.closed {
            t.active = false;
            t.closed = true;
            t.same_turn_resume = false;
            t.waiting = None;
            urgent = true;
            Some(format!(
                "failed/interrupted: {}",
                short(
                    s.last_error
                        .as_deref()
                        .unwrap_or("unknown provider failure"),
                    600
                )
            ))
        } else if t.active {
            t.active = false;
            if t.waiting.is_some() || s.attention.background_task_count > 0 {
                if t.waiting_notified {
                    return None;
                }
                t.waiting_notified = true;
                Some("waiting (declared or background work pending)".into())
            } else {
                t.closed = true;
                t.same_turn_resume = !t.declared_finished;
                Some(if t.declared_finished {
                    "finished (declared by task)".into()
                } else {
                    "turn ended; completion unverified".into()
                })
            }
        } else {
            None
        }
    } else {
        None
    };
    state.map(|state| {
        t.last_state = state;
        t.changed = now;
        let mut report = report_for(t, summary, reply, urgent, now);
        // Waiting is informational, not another paid completion each poll.
        if !urgent && was_waiting && !t.closed {
            report.wake = false;
        }
        report
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::thread_tools::tests::{call, fixture};
    use falcondeck_core::{BotMutation, BotProfile};

    async fn bot(app: &AppState) -> BotProfile {
        app.finish_local_restore();
        // These tests drive observations explicitly, without racing the timer.
        app.inner
            .delegation_monitor_started
            .store(true, Ordering::Release);
        let value = app
            .mutate_bot(BotMutation::Create {
                name: "Coordinator".into(),
                instructions: String::new(),
                provider: None,
                model_id: None,
                thread_id: Some("thread-1".into()),
            })
            .await
            .unwrap();
        serde_json::from_value(value["bot"].clone()).unwrap()
    }

    async fn target(app: &AppState) -> ThreadSummary {
        let mut summary = app.thread_summary("workspace-1", "thread-1").await.unwrap();
        summary.id = "reused".into();
        summary.origin = None;
        summary.status = ThreadStatus::Running;
        summary.latest_turn_id = Some("delegated-turn".into());
        app.inner
            .workspaces
            .lock()
            .await
            .get_mut("workspace-1")
            .unwrap()
            .threads
            .insert(summary.id.clone(), ManagedThread::new(summary.clone()));
        summary
    }

    fn task(summary: &ThreadSummary, delivery: ResultDelivery) -> Delegation {
        Delegation {
            id: "watch".into(),
            bot_id: "bot".into(),
            workspace: summary.workspace_id.clone(),
            thread: summary.id.clone(),
            delivery,
            admitted: true,
            active: true,
            turn: summary.latest_turn_id.clone(),
            waiting: None,
            deadline_reported: false,
            last_state: String::new(),
            resumed: false,
            created: Utc::now(),
            changed: Utc::now(),
            ..Default::default()
        }
    }

    async fn track(
        app: &AppState,
        bot: &BotProfile,
        summary: &ThreadSummary,
        delivery: ResultDelivery,
    ) -> String {
        let id = app
            .track_delegation(&bot.id, summary, delivery)
            .await
            .unwrap();
        app.admit_delegation(&id).await.unwrap();
        id
    }
    async fn status(app: &AppState, state: ThreadStatus) {
        app.with_thread_mut("workspace-1", "reused", |t| t.status = state)
            .await
            .unwrap();
    }
    async fn report_list(app: &AppState) -> Vec<Report> {
        app.delegation_store()
            .await
            .unwrap()
            .lock()
            .await
            .reports
            .clone()
    }
    async fn ack(app: &AppState) {
        let ids = report_list(app)
            .await
            .into_iter()
            .map(|r| r.id)
            .collect::<Vec<_>>();
        app.acknowledge_bot_delegations("thread-1", &ids)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn background_wait_same_turn_wake_reports_final_reply() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Wake).await;
        app.declare_task_wait(
            "workspace-1",
            "reused",
            Some(TaskWait {
                reason: "ci".into(),
                deadline: Utc::now() + ChronoDuration::hours(1),
            }),
        )
        .await
        .unwrap();
        status(&app, ThreadStatus::Idle).await;
        app.poll_observations(false).await.unwrap();
        assert!(!report_list(&app).await[0].wake);
        ack(&app).await;
        status(&app, ThreadStatus::Running).await;
        app.poll_observations(false).await.unwrap();
        status(&app, ThreadStatus::Idle).await;
        app.poll_observations(false).await.unwrap();
        let r = report_list(&app).await;
        assert_eq!(r.len(), 1);
        assert!(r[0].wake && r[0].text.contains("resumed turn"));
        ack(&app).await;
        assert!(
            !app.parent_watches_completion("reused", Some("delegated-turn"))
                .await
        );
    }

    #[tokio::test]
    async fn same_turn_attention_after_an_idle_segment_is_not_missed() {
        let (app, _temp) = fixture().await;
        bot(&app).await;
        let mut summary = target(&app).await;
        let mut task = task(&summary, ResultDelivery::Batch);
        summary.status = ThreadStatus::Idle;
        assert!(observe(&mut task, Some(&summary), None, false, Utc::now()).is_some());
        summary.status = ThreadStatus::WaitingForInput;
        let report = observe(&mut task, Some(&summary), None, false, Utc::now()).unwrap();
        assert!(report.wake && report.text.contains("needs input"));
    }

    #[tokio::test]
    async fn fast_same_turn_background_reply_is_not_missed_between_ticks() {
        let (app, _temp) = fixture().await;
        let mut s = target(&app).await;
        let mut t = task(&s, ResultDelivery::Wake);
        t.waiting = Some(TaskWait {
            reason: "job".into(),
            deadline: Utc::now() + ChronoDuration::hours(1),
        });
        s.status = ThreadStatus::Idle;
        let now = Utc::now();
        assert!(!observe(&mut t, Some(&s), None, false, now).unwrap().wake);
        s.last_message_at = Some(now + ChronoDuration::seconds(1));
        let r = observe(
            &mut t,
            Some(&s),
            Some("build done"),
            false,
            now + ChronoDuration::seconds(2),
        )
        .unwrap();
        assert!(r.wake && r.text.contains("build done"));
        assert!(t.waiting.is_none());
    }

    #[tokio::test]
    async fn attention_always_wakes_even_under_batch() {
        let (app, _temp) = fixture().await;
        let mut s = target(&app).await;
        for state in [ThreadStatus::Error, ThreadStatus::WaitingForInput] {
            let mut t = task(&s, ResultDelivery::Batch);
            s.status = state;
            assert!(
                observe(&mut t, Some(&s), None, false, Utc::now())
                    .unwrap()
                    .wake
            );
            assert!(observe(&mut t, Some(&s), None, false, Utc::now()).is_none());
        }
        let mut t = task(&s, ResultDelivery::Batch);
        assert!(
            observe(&mut t, Some(&s), None, true, Utc::now())
                .unwrap()
                .wake
        );
        assert!(observe(&mut t, Some(&s), None, true, Utc::now()).is_none());
        let mut t = task(&s, ResultDelivery::Batch);
        t.waiting = Some(TaskWait {
            reason: "deadline".into(),
            deadline: Utc::now() - ChronoDuration::seconds(1),
        });
        assert!(observe(&mut t, None, None, false, Utc::now()).unwrap().wake);
        assert!(t.closed && t.waiting.is_none());
        assert!(observe(&mut t, None, None, true, Utc::now()).is_none());
    }

    #[tokio::test]
    async fn waiting_poll_cycles_and_restarts_do_not_wake_repeatedly() {
        let (app, _temp) = fixture().await;
        let mut s = target(&app).await;
        let mut t = task(&s, ResultDelivery::Wake);
        t.waiting = Some(TaskWait {
            reason: "ci".into(),
            deadline: Utc::now() + ChronoDuration::hours(9),
        });
        s.status = ThreadStatus::Idle;
        assert!(
            !observe(&mut t, Some(&s), None, false, Utc::now())
                .unwrap()
                .wake
        );
        for cycle in 0..6 {
            assert!(observe(&mut t, Some(&s), None, true, Utc::now()).is_none());
            s.status = ThreadStatus::Running;
            s.latest_turn_id = Some(format!("poll-{cycle}"));
            assert!(observe(&mut t, Some(&s), None, false, Utc::now()).is_none());
            s.status = ThreadStatus::Idle;
            assert!(observe(&mut t, Some(&s), None, false, Utc::now()).is_none());
        }
        let deadline = t.waiting.as_ref().unwrap().deadline;
        assert!(observe(&mut t, None, None, false, deadline).unwrap().wake);
        for _ in 0..3 {
            assert!(observe(&mut t, None, None, true, deadline).is_none());
        }
    }

    #[tokio::test]
    async fn message_tool_tracks_a_reused_nonchild_and_preserves_wake_on_followup() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        target(&app).await;
        for arguments in [
            json!({"thread_id":"reused", "message":"Review the changes", "result_delivery":"wake"}),
            json!({"thread_id":"reused", "message":"Include restart coverage"}),
        ] {
            app.invoke_extension_tool(call("falcondeck_message_thread", arguments))
                .await
                .unwrap();
        }
        app.poll_observations(false).await.unwrap();
        assert!(report_list(&app).await.is_empty());
        {
            let mut workspaces = app.inner.workspaces.lock().await;
            let t = workspaces
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("reused")
                .unwrap();
            assert!(t.summary.origin.is_none());
            assert_eq!(t.queued_requests.len(), 1);
            t.queued_requests.clear();
            t.summary.queued_turns.clear();
            t.summary.status = ThreadStatus::Idle;
        }
        app.poll_observations(false).await.unwrap();
        let reports = report_list(&app).await;
        assert_eq!(reports.len(), 1);
        assert!(reports[0].wake && reports[0].bot_id == b.id);
        // Reuse after the first turn settled preserves the coordinator's intent.
        app.track_delegation(
            &b.id,
            &app.thread_summary("workspace-1", "reused").await.unwrap(),
            ResultDelivery::Batch,
        )
        .await
        .unwrap();
        assert_eq!(
            app.delegation_store().await.unwrap().lock().await.tasks[0].delivery,
            ResultDelivery::Wake
        );
        let disk: Ledger =
            serde_json::from_slice(&tokio::fs::read(app.delegation_path()).await.unwrap()).unwrap();
        assert_eq!(disk.reports[0].id, reports[0].id);
    }

    #[tokio::test]
    async fn followup_cannot_downgrade_wake_or_erase_shared_deadline() {
        let (app, _temp) = fixture().await;
        bot(&app).await;
        target(&app).await;
        for args in [
            json!({"thread_id":"reused","message":"Review the change","result_delivery":"wake"}),
            json!({"thread_id":"reused","message":"Also include the regression"}),
        ] {
            app.invoke_extension_tool(call("falcondeck_message_thread", args))
                .await
                .unwrap();
        }
        let wait = TaskWait {
            reason: "ci".into(),
            deadline: Utc::now() + ChronoDuration::hours(1),
        };
        app.declare_task_wait("workspace-1", "reused", Some(wait.clone()))
            .await
            .unwrap();
        let s = app.thread_summary("workspace-1", "reused").await.unwrap();
        let id = app
            .track_delegation("other-bot", &s, ResultDelivery::Batch)
            .await
            .unwrap();
        app.admit_delegation(&id).await.unwrap();
        let l = app.delegation_store().await.unwrap().lock().await;
        assert_eq!(l.tasks.len(), 2);
        assert_eq!(l.tasks[0].delivery, ResultDelivery::Wake);
        assert!(l.tasks.iter().all(|t| t.waiting.as_ref() == Some(&wait)));
    }

    #[tokio::test]
    async fn bot_finished_declaration_does_not_wake_its_own_home() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Wake).await;
        status(&app, ThreadStatus::Idle).await;
        app.poll_observations(false).await.unwrap();
        ack(&app).await;
        app.invoke_extension_tool(call(
            "falcondeck_task_state",
            json!({"thread_id":"reused","state":"finished"}),
        ))
        .await
        .unwrap();
        app.poll_observations(false).await.unwrap();
        assert!(report_list(&app).await.is_empty());
    }

    #[tokio::test]
    async fn corrupt_ledger_is_quarantined_without_aborting_startup_or_context() {
        let (app, temp) = fixture().await;
        let b = bot(&app).await;
        app.persist_local_state().await.unwrap();
        tokio::fs::write(app.delegation_path(), b"{broken")
            .await
            .unwrap();
        let restored = AppState::new_with_state_path(
            "test".into(),
            HashMap::from([(
                AgentProvider::CLAUDE,
                temp.path().join("missing").display().to_string(),
            )]),
            app.inner.state_path.clone(),
        );
        assert!(restored.restore_local_state().await.is_ok());
        assert!(
            restored
                .delegation_context(&b.thread_id)
                .await
                .unwrap()
                .0
                .contains("could not read")
        );
        restored.escalate_delegations().await.unwrap();
        restored.escalate_delegations().await.unwrap();
        let notes = restored
            .notifications_list(&falcondeck_core::notifications::NotificationListRequest::default())
            .await
            .items
            .into_iter()
            .filter(|n| {
                n.kind == falcondeck_core::notifications::NotificationKind::AgentNotice
                    && n.preview.contains("tracking was unreadable")
            })
            .collect::<Vec<_>>();
        assert_eq!(notes.len(), 1, "recovery notices: {notes:?}");
        let ledger = restored.delegation_store().await.unwrap().lock().await;
        assert!(ledger.upgraded && ledger.tasks.is_empty() && ledger.recovery.is_some());
        drop(ledger);
        let again = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            app.inner.state_path.clone(),
        );
        *again.inner.preferences.lock().await = restored.preferences().await;
        again.escalate_delegations().await.unwrap();
        assert_eq!(
            again
                .notifications_list(
                    &falcondeck_core::notifications::NotificationListRequest::default()
                )
                .await
                .items
                .into_iter()
                .filter(
                    |n| n.kind == falcondeck_core::notifications::NotificationKind::AgentNotice
                        && n.preview.contains("tracking was unreadable")
                )
                .count(),
            1
        );
        assert!(
            std::fs::read_dir(temp.path())
                .unwrap()
                .flatten()
                .any(|p| p.file_name().to_string_lossy().contains("corrupt-"))
        );
        assert!(serde_json::from_str::<Ledger>(r#"{"tasks":[],"future_field":42}"#).is_ok());
        assert!(
            serde_json::from_str::<Delegation>(r#"{"id":"old","bot_id":"bot","thread":"thread"}"#)
                .is_ok()
        );
    }

    #[tokio::test]
    async fn reports_survive_failure_restart_and_scheduled_runs_until_home_receipt() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        status(&app, ThreadStatus::Error).await;
        app.poll_observations(false).await.unwrap();
        let (_, ids) = app.delegation_context("thread-1").await.unwrap();
        assert!(!ids.is_empty());
        // Admission/startup is not receipt, including ACP's asynchronous failure.
        app.with_thread_mut("workspace-1", "thread-1", |s| {
            s.status = ThreadStatus::Error
        })
        .await
        .unwrap();
        assert_eq!(app.delegation_context("thread-1").await.unwrap().1, ids);
        let mut run = s;
        run.id = "scheduled-run".into();
        run.origin = Some(falcondeck_core::ThreadOrigin::Automation {
            automation_id: "a".into(),
            name: "n".into(),
            bot_id: Some(b.id.clone()),
        });
        app.inner
            .workspaces
            .lock()
            .await
            .get_mut("workspace-1")
            .unwrap()
            .threads
            .insert(run.id.clone(), ManagedThread::new(run));
        assert!(
            app.delegation_context("scheduled-run")
                .await
                .unwrap()
                .1
                .is_empty()
        );
        assert!(
            app.acknowledge_bot_delegations("scheduled-run", &ids)
                .await
                .is_err()
        );
        let restored = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            app.inner.state_path.clone(),
        );
        assert_eq!(
            restored
                .delegation_store()
                .await
                .unwrap()
                .lock()
                .await
                .reports
                .len(),
            1
        );
        app.acknowledge_bot_delegations("thread-1", &ids)
            .await
            .unwrap();
        assert!(report_list(&app).await.is_empty());
    }

    #[tokio::test]
    async fn stalled_writer_does_not_block_bot_context_and_failed_ack_preserves_outbox() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        status(&app, ThreadStatus::Idle).await;
        app.poll_observations(false).await.unwrap();
        let gate = app.inner.delegation_persistence.lock().await;
        assert!(
            timeout(
                Duration::from_millis(200),
                app.delegation_context("thread-1")
            )
            .await
            .is_ok()
        );
        drop(gate);
        let ids = app.delegation_context("thread-1").await.unwrap().1;
        let path = app.delegation_path();
        tokio::fs::remove_file(&path).await.unwrap();
        tokio::fs::create_dir(&path).await.unwrap();
        assert!(
            app.acknowledge_bot_delegations("thread-1", &ids)
                .await
                .is_err()
        );
        assert!(!report_list(&app).await.is_empty());
    }

    #[tokio::test]
    async fn deleted_thread_is_terminal_and_cannot_generate_daily_wakes_forever() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        app.declare_task_wait(
            "workspace-1",
            "reused",
            Some(TaskWait {
                reason: "build".into(),
                deadline: Utc::now() + ChronoDuration::hours(1),
            }),
        )
        .await
        .unwrap();
        app.inner
            .workspaces
            .lock()
            .await
            .get_mut("workspace-1")
            .unwrap()
            .threads
            .remove("reused");
        app.poll_observations(false).await.unwrap();
        assert!(report_list(&app).await.is_empty());
        app.edit_delegations(|l| {
            l.tasks[0].missing_since = Some(Utc::now() - ChronoDuration::minutes(3))
        })
        .await
        .unwrap();
        app.poll_observations(false).await.unwrap();
        assert!(report_list(&app).await[0].text.contains("deleted"));
        ack(&app).await;
        for _ in 0..3 {
            app.daily_delegation_summary().await.unwrap();
            app.poll_observations(true).await.unwrap();
            assert!(report_list(&app).await.is_empty());
        }
        assert!(
            app.delegation_store().await.unwrap().lock().await.tasks[0]
                .waiting
                .is_none()
        );
    }

    #[tokio::test]
    async fn paused_bots_and_peer_homes_do_not_black_hole_james_notifications() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Wake).await;
        app.inner.preferences.lock().await.bots[0].status = falcondeck_core::BotStatus::Paused;
        assert!(
            !app.parent_watches_completion("reused", Some("delegated-turn"))
                .await
        );
        app.inner.preferences.lock().await.bots[0].status = falcondeck_core::BotStatus::Active;
        let home = app.thread_summary("workspace-1", "thread-1").await.unwrap();
        track(&app, &b, &home, ResultDelivery::Batch).await;
        assert!(
            !app.parent_watches_completion("thread-1", home.latest_turn_id.as_deref())
                .await
        );
    }

    #[tokio::test]
    async fn failed_dispatch_is_not_a_successful_idle_completion_or_an_extra_wake() {
        let (app, _temp) = fixture().await;
        bot(&app).await;
        target(&app).await;
        status(&app, ThreadStatus::Idle).await;
        assert!(
            app.invoke_extension_tool(call(
                "falcondeck_message_thread",
                json!({"thread_id":"reused","message":"Run the review","result_delivery":"wake"})
            ))
            .await
            .is_err()
        );
        let r = report_list(&app).await;
        assert_eq!(r.len(), 1);
        assert!(r[0].text.contains("dispatch failed"));
        assert!(!r[0].wake);
        assert!(!r[0].text.contains("turn ended"));
    }

    #[tokio::test]
    async fn fresh_work_does_not_inherit_an_old_daily_date_and_old_work_is_staggered() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        app.delegation_store()
            .await
            .unwrap()
            .lock()
            .await
            .daily
            .insert(
                b.id.clone(),
                Utc::now().date_naive() - ChronoDuration::days(4),
            );
        app.daily_delegation_summary().await.unwrap();
        assert!(report_list(&app).await.is_empty());
        app.edit_delegations(|l| l.tasks[0].created = Utc::now() - ChronoDuration::days(2))
            .await
            .unwrap();
        app.daily_delegation_summary().await.unwrap();
        assert_eq!(report_list(&app).await.len(), 1);
        ack(&app).await;
        app.daily_delegation_summary().await.unwrap();
        assert!(report_list(&app).await.is_empty());
    }

    #[tokio::test]
    async fn wake_attempts_have_per_report_and_per_bot_bounds_and_failures_stay_pending() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        status(&app, ThreadStatus::Error).await;
        app.poll_observations(false).await.unwrap();
        for _ in 0..8 {
            app.edit_delegations(|l| {
                for r in &mut l.reports {
                    r.created = Utc::now() - ChronoDuration::seconds(2);
                    r.next_attempt = None;
                }
            })
            .await
            .unwrap();
            app.deliver_delegation_wakes().await.unwrap();
            timeout(Duration::from_secs(5), async {
                loop {
                    if app.inner.delegation_sends.lock().unwrap().is_empty() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        let l = app.delegation_store().await.unwrap().lock().await;
        assert_eq!(
            l.reports[0].attempts, 0,
            "failed sends spend no paid-turn budget"
        );
        assert!(l.reports[0].wake);
        assert!(l.attempts[&b.id].is_empty());
    }

    #[tokio::test]
    async fn quiet_report_turns_and_newest_urgent_first() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let item = ConversationItem::UserMessage {
            id: format!("{REPORT_PREFIX}test"),
            text: "report".into(),
            attachments: Vec::new(),
            turn_id: None,
            previous_turn_id: None,
            created_at: Utc::now(),
        };
        assert!(is_report_turn(&[item]));
        app.edit_delegations(|l| {
            for n in 0..40 {
                l.reports.push(Report {
                    id: n.to_string(),
                    bot_id: b.id.clone(),
                    thread: n.to_string(),
                    text: format!("result {n}"),
                    wake: n == 39,
                    created: Utc::now() + ChronoDuration::seconds(n),
                    ..Default::default()
                });
            }
        })
        .await
        .unwrap();
        let (_, ids) = app.delegation_context("thread-1").await.unwrap();
        assert_eq!(ids.len(), 30);
        assert_eq!(ids[0], "39");
        assert!(!ids.contains(&"0".to_string()));
    }

    #[tokio::test]
    async fn upgrade_recovers_existing_children_and_codex_disconnect_is_urgent() {
        let (app, _temp) = fixture().await;
        bot(&app).await;
        target(&app).await;
        app.with_thread_mut("workspace-1", "reused", |s| {
            s.origin = Some(falcondeck_core::ThreadOrigin::AgentSpawn {
                parent_thread_id: "thread-1".into(),
                dispatched_at: None,
            });
            s.provider = AgentProvider::CODEX;
        })
        .await
        .unwrap();
        app.upgrade_delegations().await.unwrap();
        assert_eq!(
            app.delegation_store()
                .await
                .unwrap()
                .lock()
                .await
                .tasks
                .len(),
            1
        );
        app.fail_active_provider_threads(
            "workspace-1",
            &AgentProvider::CODEX,
            "Codex app-server disconnected while running",
        )
        .await;
        app.poll_observations(false).await.unwrap();
        assert!(
            report_list(&app)
                .await
                .iter()
                .any(|r| r.wake && r.text.contains("disconnected"))
        );
        app.upgrade_delegations().await.unwrap();
        assert_eq!(
            app.delegation_store()
                .await
                .unwrap()
                .lock()
                .await
                .tasks
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn wait_badges_never_mask_live_input_or_work_and_expire() {
        let (app, _temp) = fixture().await;
        let mut summary = target(&app).await;
        summary.attention.task_wait = Some(TaskWait {
            reason: "build".into(),
            deadline: Utc::now() + ChronoDuration::hours(1),
        });
        for state in [
            ThreadStatus::Running,
            ThreadStatus::WaitingForInput,
            ThreadStatus::Idle,
        ] {
            summary.status = state.clone();
            threads::refresh_thread_attention(&mut summary, 0, 0);
            assert_eq!(
                summary.attention.badge_label.as_deref(),
                match state {
                    ThreadStatus::WaitingForInput => Some("Awaiting response"),
                    ThreadStatus::Idle => Some("Waiting"),
                    _ => None,
                }
            );
        }
        summary.attention.task_wait.as_mut().unwrap().deadline =
            Utc::now() - ChronoDuration::seconds(1);
        threads::refresh_thread_attention(&mut summary, 0, 0);
        assert!(summary.attention.badge_label.is_none());
    }

    #[tokio::test]
    async fn transient_retry_and_queued_steer_do_not_settle_the_logical_turn() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Wake).await;
        {
            let mut workspaces = app.inner.workspaces.lock().await;
            let t = workspaces
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("reused")
                .unwrap();
            t.summary.status = ThreadStatus::Error;
            t.transient_retry_in_flight = true;
        }
        app.poll_observations(false).await.unwrap();
        assert!(report_list(&app).await.is_empty());
        {
            let mut workspaces = app.inner.workspaces.lock().await;
            let t = workspaces
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("reused")
                .unwrap();
            t.transient_retry_in_flight = false;
            t.summary.status = ThreadStatus::Idle;
            t.dispatching_request = Some(serde_json::from_value(json!({"id":"steer", "request":{"workspace_id":"workspace-1", "thread_id":"reused", "inputs":[{"type":"text","text":"steer"}]}, "summary":{"id":"steer","preview":"steer","queued_at":Utc::now()}})).unwrap());
        }
        app.poll_observations(false).await.unwrap();
        assert!(report_list(&app).await.is_empty());
    }

    #[tokio::test]
    async fn thousands_of_stale_records_are_pruned_and_tick_is_bounded() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        {
            let mut ws = app.inner.workspaces.lock().await;
            let w = ws.get_mut("workspace-1").unwrap();
            for n in 0..3700 {
                let mut c = s.clone();
                c.id = format!("t{n}");
                c.status = ThreadStatus::Idle;
                w.threads.insert(c.id.clone(), ManagedThread::new(c));
            }
        }
        app.edit_delegations(|l| {
            for n in 0..3000 {
                let mut c = s.clone();
                c.id = format!("t{n}");
                let mut t = task(&c, ResultDelivery::Batch);
                t.id = format!("d{n}");
                t.bot_id = b.id.clone();
                t.active = false;
                t.closed = true;
                l.tasks.push(t);
            }
        })
        .await
        .unwrap();
        app.poll_observations(false).await.unwrap();
        assert!(
            app.delegation_store()
                .await
                .unwrap()
                .lock()
                .await
                .tasks
                .len()
                <= MAX_TASKS
        );
        let started = std::time::Instant::now();
        for _ in 0..3 {
            app.poll_observations(false).await.unwrap();
        }
        println!(
            "bounded tick: {:?} for three ticks after 3000-record upgrade",
            started.elapsed()
        );
        app.edit_delegations(|l| prune(l, Utc::now() + ChronoDuration::days(8)))
            .await
            .unwrap();
        assert!(
            app.delegation_store()
                .await
                .unwrap()
                .lock()
                .await
                .tasks
                .is_empty()
        );
    }

    #[tokio::test]
    async fn unread_closed_batch_results_get_the_daily_fallback() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        status(&app, ThreadStatus::Idle).await;
        app.poll_observations(false).await.unwrap();
        app.edit_delegations(|l| {
            assert!(l.tasks[0].closed);
            l.reports[0].created = Utc::now() - ChronoDuration::days(2);
        })
        .await
        .unwrap();
        app.daily_delegation_summary().await.unwrap();
        let reports = report_list(&app).await;
        assert!(
            reports
                .iter()
                .any(|r| r.wake && r.text.contains("1 unacknowledged"))
        );
        app.daily_delegation_summary().await.unwrap();
        assert_eq!(report_list(&app).await.len(), 2, "no digest storm");
    }

    #[tokio::test]
    async fn every_distinct_input_request_is_urgent_and_never_finished() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        for _ in 0..3 {
            status(&app, ThreadStatus::WaitingForInput).await;
            app.poll_observations(false).await.unwrap();
            let reports = report_list(&app).await;
            assert_eq!(reports.len(), 1);
            assert!(
                reports[0].urgent && reports[0].wake && reports[0].text.contains("needs input")
            );
            assert!(!reports[0].text.contains("turn ended"));
            app.poll_observations(false).await.unwrap();
            assert_eq!(report_list(&app).await.len(), 1);
            ack(&app).await;
            status(&app, ThreadStatus::Running).await;
            app.poll_observations(false).await.unwrap();
        }
    }

    #[tokio::test]
    async fn new_approval_is_detected_even_without_a_running_poll_between_requests() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        status(&app, ThreadStatus::WaitingForInput).await;
        for i in 0..2 {
            let id = format!("request-{i}");
            let item=ConversationItem::InteractiveRequest { id:id.clone(), request:Box::new(serde_json::from_value(json!({"request_id":id,"workspace_id":"workspace-1","thread_id":"reused","method":"item/commandExecution/requestApproval","kind":"approval","title":"Run next command","questions":[],"created_at":Utc::now()})).unwrap()), created_at:Utc::now(), resolved:false,resolution:None };
            app.inner
                .workspaces
                .lock()
                .await
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("reused")
                .unwrap()
                .items
                .push(item);
            app.poll_observations(false).await.unwrap();
            assert!(
                report_list(&app)
                    .await
                    .iter()
                    .any(|r| r.urgent && r.text.contains("needs input"))
            );
            ack(&app).await;
            app.poll_observations(false).await.unwrap();
            assert!(report_list(&app).await.is_empty());
        }
    }

    #[tokio::test]
    async fn open_old_work_and_more_than_two_hundred_live_interests_are_retained() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Wake).await;
        app.declare_task_wait(
            "workspace-1",
            "reused",
            Some(TaskWait {
                reason: "long job".into(),
                deadline: Utc::now() + ChronoDuration::days(10),
            }),
        )
        .await
        .unwrap();
        app.edit_delegations(|l| {
            l.tasks[0].created = Utc::now() - ChronoDuration::days(8);
            let mut old = l.tasks[0].clone();
            for i in 0..205 {
                old.id = format!("open-{i}");
                l.tasks.push(old.clone());
            }
            prune(l, Utc::now());
            assert_eq!(l.tasks.len(), 206);
        })
        .await
        .unwrap();
        app.poll_observations(false).await.unwrap();
        assert!(
            app.delegation_store()
                .await
                .unwrap()
                .lock()
                .await
                .tasks
                .iter()
                .all(|t| !t.closed && t.waiting.is_some())
        );
        assert!(
            report_list(&app)
                .await
                .iter()
                .any(|r| r.urgent && r.text.contains("seven days"))
        );
    }

    #[tokio::test]
    async fn urgent_unreceived_results_escalate_once_coalesced_per_bot_and_survive_restart() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        app.with_thread_mut("workspace-1", "reused", |s| {
            s.status = ThreadStatus::Error;
            s.last_error = Some("exit 143".into());
        })
        .await
        .unwrap();
        app.poll_observations(false).await.unwrap();
        app.edit_delegations(|l| {
            let report = &mut l.reports[0];
            report.created = Utc::now() - ChronoDuration::hours(3);
            report.attempts = 3;
            let mut second = report.clone();
            second.id = "deleted-case".into();
            second.thread = "deleted-job".into();
            second.text = "Deleted deployment check needs investigation".into();
            l.reports.push(second);
            l.attempts.insert(b.id.clone(), vec![Utc::now(); 6]);
        })
        .await
        .unwrap();
        app.inner.preferences.lock().await.bots[0].status = falcondeck_core::BotStatus::Paused;
        app.escalate_delegations().await.unwrap();
        app.escalate_delegations().await.unwrap();
        let notes = app
            .notifications_list(&falcondeck_core::notifications::NotificationListRequest::default())
            .await
            .items;
        assert_eq!(notes.len(), 1);
        assert!(notes[0].title.contains(&b.name));
        assert!(notes[0].body.is_none());
        assert!(
            app.notification_get(&notes[0].id)
                .await
                .unwrap()
                .body
                .unwrap()
                .contains("exit 143")
        );
        assert_eq!(notes[0].thread_id.as_deref(), Some("thread-1"));
        assert!(notes[0].preview.contains("reused"));
        assert!(
            app.delegation_store()
                .await
                .unwrap()
                .lock()
                .await
                .reports
                .iter()
                .all(|r| r.escalated)
        );
        let restored = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            app.inner.state_path.clone(),
        );
        *restored.inner.preferences.lock().await = app.preferences().await;
        restored.escalate_delegations().await.unwrap();
        assert_eq!(
            restored
                .notifications_list(
                    &falcondeck_core::notifications::NotificationListRequest::default()
                )
                .await
                .items
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn accepted_receipt_stops_automatic_wakes_and_full_context_repeats() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Wake).await;
        status(&app, ThreadStatus::Error).await;
        app.poll_observations(false).await.unwrap();
        for _ in 0..3 {
            let (text, ids) = app.delegation_context("thread-1").await.unwrap();
            assert!(text.contains("Latest reply:"));
            app.accepted_delegation_context("thread-1", &ids, false)
                .await;
        }
        for _ in 0..50 {
            let (text, ids) = app.delegation_context("thread-1").await.unwrap();
            assert!(ids.is_empty() && !text.contains("Latest reply:"));
            assert!(text.len() < 500);
        }
        app.edit_delegations(|l| l.reports[0].created = Utc::now() - ChronoDuration::hours(3))
            .await
            .unwrap();
        app.escalate_delegations().await.unwrap();
        assert!(
            app.notifications_list(
                &falcondeck_core::notifications::NotificationListRequest::default()
            )
            .await
            .items
            .is_empty()
        );
        assert!(!report_list(&app).await[0].wake);
        app.edit_delegations(|l| {
            l.reports.push(Report {
                id: "new-batch".into(),
                bot_id: b.id,
                text: "new work".into(),
                created: Utc::now(),
                ..Default::default()
            })
        })
        .await
        .unwrap();
        assert_eq!(
            app.delegation_context("thread-1").await.unwrap().1,
            vec!["new-batch"]
        );
    }

    #[tokio::test]
    async fn unreceived_batch_results_outrank_previously_received_urgent_details() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        app.edit_delegations(|l| {
            for i in 0..40 {
                l.reports.push(Report {
                    id: format!("old-{i}"),
                    bot_id: b.id.clone(),
                    thread: format!("old-{i}"),
                    urgent: true,
                    accepted: Some(Utc::now()),
                    injections: 1,
                    created: Utc::now(),
                    ..Default::default()
                });
            }
            l.reports.push(Report {
                id: "fresh".into(),
                bot_id: b.id.clone(),
                text: "new batch completion".into(),
                created: Utc::now(),
                ..Default::default()
            });
        })
        .await
        .unwrap();
        assert_eq!(
            app.delegation_context("thread-1").await.unwrap().1[0],
            "fresh"
        );
    }

    #[tokio::test]
    async fn lease_timeout_does_not_cancel_provider_admission_or_strand_running() {
        let (app, _temp) = fixture().await;
        bot(&app).await;
        app.with_thread_mut("workspace-1", "thread-1", |s| s.native_session_id = None)
            .await
            .unwrap();
        let guard = app.delegation_store().await.unwrap().lock().await;
        let request=serde_json::from_value(json!({"workspace_id":"workspace-1","thread_id":"thread-1","user_item_id":"user-delegation-report-test","inputs":[{"type":"text","text":"FalconDeck delegated outcomes need attention."}]})).unwrap();
        dispatch_with_lease(app.clone(), request, Duration::from_millis(80)).await;
        drop(guard);
        timeout(Duration::from_secs(3), async {
            loop {
                if app
                    .thread_summary("workspace-1", "thread-1")
                    .await
                    .unwrap()
                    .status
                    == ThreadStatus::Error
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("provider cleanup was cancelled by the lease");
    }

    #[tokio::test]
    async fn reconnect_absence_is_not_a_deleted_task_and_terminal_wait_is_rejected() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        track(&app, &b, &s, ResultDelivery::Batch).await;
        {
            let mut ws = app.inner.workspaces.lock().await;
            let w = ws.get_mut("workspace-1").unwrap();
            w.summary.status = WorkspaceStatus::Connecting;
            w.threads.remove("reused");
        }
        app.poll_observations(false).await.unwrap();
        assert!(report_list(&app).await.is_empty());
        {
            let mut ws = app.inner.workspaces.lock().await;
            let w = ws.get_mut("workspace-1").unwrap();
            w.summary.status = WorkspaceStatus::Ready;
            w.threads.insert(s.id.clone(), ManagedThread::new(s));
        }
        app.invoke_extension_tool(call(
            "falcondeck_task_state",
            json!({"thread_id":"reused","state":"finished"}),
        ))
        .await
        .unwrap();
        assert!(
            app.declare_task_wait(
                "workspace-1",
                "reused",
                Some(TaskWait {
                    reason: "ignored?".into(),
                    deadline: Utc::now() + ChronoDuration::hours(1)
                })
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn ledger_write_failure_cannot_block_a_reused_thread_message() {
        let (app, _temp) = fixture().await;
        bot(&app).await;
        target(&app).await;
        app.delegation_store().await.unwrap();
        tokio::fs::create_dir(app.delegation_path()).await.unwrap();
        app.invoke_extension_tool(call(
            "falcondeck_message_thread",
            json!({"thread_id":"reused","message":"Please finish the review"}),
        ))
        .await
        .unwrap();
        assert_eq!(
            app.inner.workspaces.lock().await["workspace-1"].threads["reused"]
                .queued_requests
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn upgrade_recovers_scheduled_run_children_and_reused_message_relationships() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        let mut run = s.clone();
        run.id = "scheduled-parent".into();
        run.origin = Some(ThreadOrigin::Automation {
            automation_id: "a".into(),
            name: "schedule".into(),
            bot_id: Some(b.id.clone()),
        });
        let mut child = s.clone();
        child.id = "scheduled-child".into();
        child.origin = Some(ThreadOrigin::AgentSpawn {
            parent_thread_id: run.id.clone(),
            dispatched_at: None,
        });
        {
            let mut ws = app.inner.workspaces.lock().await;
            let w = ws.get_mut("workspace-1").unwrap();
            for s in [run, child] {
                w.threads.insert(s.id.clone(), ManagedThread::new(s));
            }
        }
        app.analytics_agent_message("thread-1", "reused", "Review the changes", "queue");
        app.upgrade_delegations().await.unwrap();
        let l = app.delegation_store().await.unwrap().lock().await;
        assert!(
            l.tasks
                .iter()
                .any(|t| t.thread == "scheduled-child" && t.bot_id == b.id)
        );
        assert!(
            l.tasks
                .iter()
                .any(|t| t.thread == "reused" && t.bot_id == b.id)
        );
        drop(l);
        assert!(
            app.thread_summary("workspace-1", "reused")
                .await
                .unwrap()
                .origin
                .is_none()
        );
    }
    #[tokio::test]
    async fn combined_failed_delegation_escalates_to_phone_with_bot_only_setting() {
        let (app, _temp) = fixture().await;
        let b = bot(&app).await;
        let s = target(&app).await;
        let patch = serde_json::from_value(json!({"only_push_from_bots":true})).unwrap();
        app.update_preferences(UpdatePreferencesRequest {
            notifications: Some(patch),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(app.preferences().await.notifications).unwrap()["only_push_from_bots"],
            true
        );
        remote_lifecycle::pair_for_tests(&app).await;
        app.set_desktop_activity(false);
        track(&app, &b, &s, ResultDelivery::Batch).await;
        app.with_thread_mut("workspace-1", "reused", |s| {
            s.status = ThreadStatus::Error;
            s.origin = Some(ThreadOrigin::AgentSpawn {
                parent_thread_id: "thread-1".into(),
                dispatched_at: Some(Utc::now()),
            });
            s.last_error = Some("exit 143: build was killed".into());
        })
        .await
        .unwrap();
        app.record_and_deliver_attention(super::super::notification_centre::AttentionEvent::turn(
            "workspace-1",
            "reused",
            true,
        ))
        .await;
        assert!(
            app.next_held_push().await.is_none(),
            "dispatched worker error was not suppressed in the combined setup"
        );
        app.poll_observations(false).await.unwrap();
        app.edit_delegations(|l| {
            l.reports[0].created = Utc::now() - ChronoDuration::hours(3);
            l.attempts.insert(b.id.clone(), vec![Utc::now(); 6]);
        })
        .await
        .unwrap();
        app.inner.preferences.lock().await.bots[0].status = falcondeck_core::BotStatus::Paused;
        app.escalate_delegations().await.unwrap();
        let (push, claim) = app
            .next_held_push()
            .await
            .expect("urgent escalation was suppressed by bot-only push");
        assert_eq!(push.kind, "agent-notice");
        assert_eq!(push.thread_id.as_deref(), Some("thread-1"));
        assert!(push.title.as_deref().unwrap().contains(&b.name));
        app.push_written(claim).await;
        app.escalate_delegations().await.unwrap();
        assert!(app.next_held_push().await.is_none());
    }

    #[tokio::test]
    async fn combined_direct_user_reply_beats_report_marker_and_real_home_errors_push() {
        let (app, _temp) = fixture().await;
        bot(&app).await;
        app.update_preferences(UpdatePreferencesRequest {
            notifications: Some(
                serde_json::from_value(json!({"only_push_from_bots":true})).unwrap(),
            ),
            ..Default::default()
        })
        .await
        .unwrap();
        remote_lifecycle::pair_for_tests(&app).await;
        app.set_desktop_activity(false);
        {
            let mut ws = app.inner.workspaces.lock().await;
            let t = ws
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("thread-1")
                .unwrap();
            let mut attention = serde_json::to_value(&t.summary.attention).unwrap();
            attention["reply_to_user"] = json!(true);
            t.summary.attention = serde_json::from_value(attention).unwrap();
            assert_eq!(
                serde_json::to_value(&t.summary.attention).unwrap()["reply_to_user"],
                true
            );
            t.summary.latest_turn_id = Some("user-turn".into());
            t.summary.status = ThreadStatus::Idle;
            t.items.push(serde_json::from_value(json!({"kind":"user_message","id":"user-delegation-report-mixed","attachments":[],"text":"FalconDeck delegated outcomes need attention.","created_at":Utc::now()})).unwrap());
            t.items.push(serde_json::from_value(json!({"kind":"assistant_message","id":"answer-for-james","text":"Here is the result you asked for.","created_at":Utc::now()})).unwrap());
        }
        app.record_and_deliver_attention(super::super::notification_centre::AttentionEvent::turn(
            "workspace-1",
            "thread-1",
            false,
        ))
        .await;
        let (push, claim) = app
            .next_held_push()
            .await
            .expect("mixed user/report reply disappeared");
        assert_eq!(push.kind, "turn-complete");
        app.push_written(claim).await;
        {
            let mut ws = app.inner.workspaces.lock().await;
            let t = ws
                .get_mut("workspace-1")
                .unwrap()
                .threads
                .get_mut("thread-1")
                .unwrap();
            let mut attention = serde_json::to_value(&t.summary.attention).unwrap();
            attention["reply_to_user"] = json!(false);
            t.summary.attention = serde_json::from_value(attention).unwrap();
            t.summary.latest_turn_id = Some("automatic-turn".into());
        }
        app.record_and_deliver_attention(super::super::notification_centre::AttentionEvent::turn(
            "workspace-1",
            "thread-1",
            false,
        ))
        .await;
        assert!(
            app.next_held_push().await.is_none(),
            "routine report reply pushed"
        );
        app.with_thread_mut("workspace-1", "thread-1", |s| {
            s.status = ThreadStatus::Error;
            s.last_error = Some("provider disconnected".into());
        })
        .await
        .unwrap();
        app.record_and_deliver_attention(super::super::notification_centre::AttentionEvent::turn(
            "workspace-1",
            "thread-1",
            true,
        ))
        .await;
        let (push, _) = app
            .next_held_push()
            .await
            .expect("real bot-home error was hidden");
        assert_eq!(push.kind, "turn-error");
    }
}
