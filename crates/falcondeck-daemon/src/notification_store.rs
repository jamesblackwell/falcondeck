//! Durable store behind the notification centre.
//!
//! `<state dir>/notifications/notifications.json` holds the records, oldest
//! first; long bodies live beside it in `bodies/` so the list stays small to
//! rewrite. Recording must never lose an attention event to a storage problem:
//! a failed write keeps the record in memory for the next save, and a bad or
//! future file is left untouched while this daemon runs from memory.
use std::collections::VecDeque;
use std::path::PathBuf;

use chrono::{DateTime, Duration, Utc};
use falcondeck_core::notifications::{
    MarkNotificationsReadRequest, NotificationCounts, NotificationImportance, NotificationKind,
    NotificationListRequest, NotificationListResponse, NotificationRecord, NotificationReportRef,
    NotificationTarget,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const VERSION: u32 = 1;
/// Everything older than this is dropped, read or not.
const RETENTION_DAYS: i64 = 90;
/// Hard ceiling, so the file stays cheap to rewrite whatever the traffic.
const MAX_RECORDS: usize = 5_000;
const DEFAULT_PAGE: usize = 50;
const MAX_PAGE: usize = 200;
/// How long the relay keeps a report. The daemon's own copy follows `RETENTION_DAYS`.
pub(crate) const REPORT_TTL_DAYS: i64 = 30;

/// Notices one sender may send, so an agent cannot spam James.
pub(crate) const NOTICES_PER_HOUR: usize = 3;
pub(crate) const NOTICES_PER_DAY: usize = 10;
pub(crate) const HIGH_NOTICES_PER_DAY: usize = 2;
/// Notices all agents together may send, however many tasks are running.
pub(crate) const ALL_NOTICES_PER_DAY: usize = 30;
/// Daily slots only a high-importance notice can take, so a noisy day cannot
/// shut out the one that matters.
pub(crate) const HIGH_NOTICES_RESERVED: usize = 5;
/// Folded event keys kept per record. Replays arrive close to the original.
const MAX_FOLDED_KEYS: usize = 32;
const MAX_RESOLVED_EARLY: usize = 64;

/// A record as saved: the wire record plus what only the daemon needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    #[serde(flatten)]
    record: NotificationRecord,
    /// The same event never records twice: a request, a review, or a turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dedupe_key: Option<String>,
    /// Keys of earlier events folded into this record, so a replay of one is
    /// still recognised after a later event took over `dedupe_key`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    folded_keys: Vec<String>,
    /// Who sent a notice, for rate limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sender: Option<String>,
    /// Which session key the hosted report copy was encrypted with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    report_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u32,
    next_id: u64,
    next_seq: u64,
    records: Vec<Stored>,
}

impl Default for File {
    fn default() -> Self {
        Self {
            version: VERSION,
            next_id: 1,
            next_seq: 1,
            records: vec![],
        }
    }
}

/// One attention event to record.
#[derive(Debug, Clone)]
pub(crate) struct NewNotification {
    pub kind: NotificationKind,
    pub title: String,
    pub preview: String,
    pub bot: Option<String>,
    pub thread_id: Option<String>,
    pub workspace_id: Option<String>,
    pub target: Option<NotificationTarget>,
    pub importance: NotificationImportance,
    pub dedupe_key: Option<String>,
    /// Fold into this thread's unread record of the same kind.
    pub coalesce: bool,
    pub sender: Option<String>,
    pub body: Option<String>,
}

/// What recording did. Only `Duplicate` means the event was already known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Recorded {
    Created(Box<NotificationRecord>),
    /// An unread record for the same thread now carries this event.
    Coalesced(Box<NotificationRecord>),
    Duplicate(Box<NotificationRecord>),
}

impl Recorded {
    pub(crate) fn record(&self) -> &NotificationRecord {
        match self {
            Self::Created(record) | Self::Coalesced(record) | Self::Duplicate(record) => record,
        }
    }
}

/// Why a notice was not recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NoticeRefused {
    RateLimited {
        limit: &'static str,
        retry_after: Duration,
    },
    Storage(String),
}

/// A report that should be on the relay and is not, or is under an old key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingReport {
    pub record: NotificationRecord,
    pub body: String,
}

struct State {
    file: File,
    loaded: bool,
    /// False when the file on disk is not ours to overwrite.
    writable: bool,
    /// Keys resolved before their record arrived: a request is published
    /// before it is recorded, so a quick answer can win the race.
    resolved_early: VecDeque<String>,
}

pub(crate) struct NotificationStore {
    dir: PathBuf,
    state: Mutex<State>,
}

impl NotificationStore {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            state: Mutex::new(State {
                file: File::default(),
                loaded: false,
                writable: true,
                resolved_early: VecDeque::new(),
            }),
        }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("notifications.json")
    }

    fn body_path(&self, id: &str) -> PathBuf {
        self.dir.join("bodies").join(format!("{id}.md"))
    }

    async fn ensure_loaded(&self, state: &mut State) {
        if state.loaded {
            return;
        }
        state.loaded = true;
        let bytes = match tokio::fs::read(self.path()).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                tracing::warn!(%error, "notification store unreadable; running from memory");
                state.writable = false;
                return;
            }
        };
        match serde_json::from_slice::<File>(&bytes) {
            Ok(file) if file.version == VERSION && file.next_id > 0 && file.next_seq > 0 => {
                state.file = file;
            }
            Ok(file) => {
                tracing::warn!(
                    version = file.version,
                    "unsupported notification store; file left untouched"
                );
                state.writable = false;
            }
            Err(error) => {
                tracing::warn!(%error, "invalid notification store; file left untouched");
                state.writable = false;
            }
        }
    }

    /// The change stays in memory if the write fails, and the next one retries.
    async fn save(&self, state: &State) {
        if !state.writable {
            return;
        }
        let payload = match serde_json::to_vec(&state.file) {
            Ok(payload) => payload,
            Err(error) => {
                tracing::warn!(%error, "could not encode notifications");
                return;
            }
        };
        if let Err(error) = crate::app::storage::write_atomically(&self.path(), payload).await {
            tracing::warn!(%error, "could not save notifications");
        }
    }

    async fn prune(&self, state: &mut State, now: DateTime<Utc>) {
        let cutoff = now - Duration::days(RETENTION_DAYS);
        let mut removed = Vec::new();
        state.file.records.retain(|stored| {
            let keep = stored.record.created_at >= cutoff;
            if !keep && stored.record.has_body {
                removed.push(stored.record.id.clone());
            }
            keep
        });
        let records = &mut state.file.records;
        // Over the ceiling the least valuable go first: read completions, then
        // anything read, then the oldest. The newest record always survives.
        let stages: [fn(&Stored) -> bool; 3] = [
            |s| s.record.is_read() && s.record.kind == NotificationKind::TurnComplete,
            |s| s.record.is_read() && !s.record.is_waiting(),
            |_| true,
        ];
        for stage in stages {
            let mut excess = records.len().saturating_sub(MAX_RECORDS);
            if excess == 0 {
                break;
            }
            let last = records.len() - 1;
            let mut index = 0;
            records.retain(|stored| {
                let at = index;
                index += 1;
                let drop = excess > 0 && at != last && stage(stored);
                if drop {
                    excess -= 1;
                    if stored.record.has_body {
                        removed.push(stored.record.id.clone());
                    }
                }
                !drop
            });
        }
        for id in removed {
            let _ = tokio::fs::remove_file(self.body_path(&id)).await;
        }
    }

    fn counts(file: &File) -> NotificationCounts {
        NotificationCounts {
            unread_count: file.records.iter().filter(|s| !s.record.is_read()).count(),
            needs_you_count: file
                .records
                .iter()
                .filter(|s| s.record.is_waiting())
                .count(),
            latest_seq: file.next_seq - 1,
        }
    }

    fn bump_seq(file: &mut File) -> u64 {
        let seq = file.next_seq;
        file.next_seq += 1;
        seq
    }

    fn insert(file: &mut File, new: NewNotification, now: DateTime<Utc>) -> NotificationRecord {
        let id = format!("N-{}", file.next_id);
        file.next_id += 1;
        let seq = Self::bump_seq(file);
        let report = new.body.as_ref().map(|_| NotificationReportRef {
            report_id: format!("rpt_{}", uuid::Uuid::new_v4().simple()),
            expires_at: now + Duration::days(REPORT_TTL_DAYS),
            hosted: false,
        });
        let record = NotificationRecord {
            id,
            seq,
            kind: new.kind,
            title: new.title,
            preview: new.preview,
            bot: new.bot,
            thread_id: new.thread_id,
            workspace_id: new.workspace_id,
            created_at: now,
            read_at: None,
            resolved_at: None,
            target: new.target,
            importance: new.importance,
            has_body: new.body.is_some(),
            body: None,
            report,
            repeat_count: 0,
        };
        file.records.push(Stored {
            record: record.clone(),
            dedupe_key: new.dedupe_key,
            folded_keys: Vec::new(),
            sender: new.sender,
            report_key: None,
        });
        record
    }

    /// Records one attention event. The same event never records twice, and a
    /// coalescing event refreshes the thread's unread record instead of adding
    /// a row, so a back-and-forth stays one line until James reads it.
    pub(crate) async fn record(&self, new: NewNotification, now: DateTime<Utc>) -> Recorded {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        self.prune(state, now).await;
        if let Some(key) = new.dedupe_key.as_deref()
            && let Some(existing) = state.file.records.iter().rev().find(|stored| {
                stored.dedupe_key.as_deref() == Some(key)
                    || stored.folded_keys.iter().any(|folded| folded == key)
            })
        {
            return Recorded::Duplicate(Box::new(existing.record.clone()));
        }
        let coalesced = new
            .coalesce
            .then(|| {
                state.file.records.iter().rposition(|stored| {
                    !stored.record.is_read()
                        && stored.record.kind == new.kind
                        && stored.record.thread_id == new.thread_id
                        && stored.record.workspace_id == new.workspace_id
                })
            })
            .flatten();
        let result = if let Some(index) = coalesced {
            let mut stored = state.file.records.remove(index);
            stored.record.seq = Self::bump_seq(&mut state.file);
            stored.record.title = new.title;
            stored.record.preview = new.preview;
            stored.record.created_at = now;
            stored.record.repeat_count += 1;
            if let Some(key) = std::mem::replace(&mut stored.dedupe_key, new.dedupe_key) {
                if stored.folded_keys.len() == MAX_FOLDED_KEYS {
                    stored.folded_keys.remove(0);
                }
                stored.folded_keys.push(key);
            }
            let record = stored.record.clone();
            state.file.records.push(stored);
            Recorded::Coalesced(Box::new(record))
        } else {
            let answered = new
                .dedupe_key
                .as_ref()
                .is_some_and(|key| state.resolved_early.contains(key));
            let mut record = Self::insert(&mut state.file, new, now);
            if answered && let Some(stored) = state.file.records.last_mut() {
                stored.record.resolved_at = Some(now);
                stored.record.read_at = Some(now);
                record = stored.record.clone();
            }
            Recorded::Created(Box::new(record))
        };
        self.prune(state, now).await;
        self.save(state).await;
        result
    }

    /// Records an agent's notice under the rate limits, atomically with the
    /// check. A retry of the same notice from the same sender within the hour
    /// replays the first record instead of pushing James twice.
    pub(crate) async fn record_notice(
        &self,
        new: NewNotification,
        now: DateTime<Utc>,
    ) -> Result<Recorded, NoticeRefused> {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        self.prune(state, now).await;
        let notices = || {
            state
                .file
                .records
                .iter()
                .filter(|stored| stored.record.kind == NotificationKind::AgentNotice)
        };
        let hour = now - Duration::hours(1);
        let day = now - Duration::days(1);
        if let Some(existing) = notices().rev().find(|stored| {
            stored.sender == new.sender
                && stored.record.created_at > hour
                && stored.record.title == new.title
                && stored.record.preview == new.preview
        }) {
            return Ok(Recorded::Duplicate(Box::new(existing.record.clone())));
        }
        let sent: Vec<_> = notices()
            .filter(|stored| stored.sender == new.sender)
            .map(|stored| (stored.record.created_at, stored.record.importance))
            .collect();
        let everyone: Vec<_> = notices().map(|stored| stored.record.created_at).collect();
        // `times` is oldest first: a slot frees when the oldest in the window ages out.
        let limited = |limit, times: Vec<DateTime<Utc>>, since, max, window: Duration| {
            let inside: Vec<_> = times.into_iter().filter(|at| *at > since).collect();
            (inside.len() >= max).then(|| NoticeRefused::RateLimited {
                limit,
                retry_after: inside[inside.len() - max] + window - now,
            })
        };
        let at = |high: bool| {
            sent.iter()
                .filter(|(_, importance)| !high || *importance == NotificationImportance::High)
                .map(|(at, _)| *at)
                .collect::<Vec<_>>()
        };
        let high = new.importance == NotificationImportance::High;
        let refused = limited(
            "3 per hour",
            at(false),
            hour,
            NOTICES_PER_HOUR,
            Duration::hours(1),
        )
        .or_else(|| {
            limited(
                "10 per day",
                at(false),
                day,
                NOTICES_PER_DAY,
                Duration::days(1),
            )
        })
        .or_else(|| {
            high.then(|| {
                limited(
                    "2 high-importance per day",
                    at(true),
                    day,
                    HIGH_NOTICES_PER_DAY,
                    Duration::days(1),
                )
            })
            .flatten()
        })
        .or_else(|| {
            limited(
                if high {
                    "30 per day across all agents"
                } else {
                    "25 per day across all agents, with 5 kept for high importance"
                },
                everyone,
                day,
                if high {
                    ALL_NOTICES_PER_DAY
                } else {
                    ALL_NOTICES_PER_DAY - HIGH_NOTICES_RESERVED
                },
                Duration::days(1),
            )
        });
        if let Some(refused) = refused {
            return Err(refused);
        }
        // Ids restart when the index could not be loaded, so writing a body
        // here could overwrite a report the preserved index still points at.
        if new.body.is_some() && !state.writable {
            return Err(NoticeRefused::Storage(
                "notification history could not be loaded, so a report cannot be kept".into(),
            ));
        }
        let id = format!("N-{}", state.file.next_id);
        if let Some(body) = &new.body {
            let path = self.body_path(&id);
            let write = async {
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(&path, body).await
            };
            write
                .await
                .map_err(|error| NoticeRefused::Storage(error.to_string()))?;
        }
        let record = Self::insert(&mut state.file, new, now);
        self.prune(state, now).await;
        self.save(state).await;
        Ok(Recorded::Created(Box::new(record)))
    }

    /// One page, newest first, with counts across the whole store.
    pub(crate) async fn list(
        &self,
        request: &NotificationListRequest,
        now: DateTime<Utc>,
    ) -> NotificationListResponse {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        self.prune(state, now).await;
        let limit = request.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
        let mut matching = state
            .file
            .records
            .iter()
            .rev()
            .map(|stored| &stored.record)
            .filter(|record| request.before_seq.is_none_or(|before| record.seq < before))
            .filter(|record| record.matches(request.filter));
        let items: Vec<_> = matching.by_ref().take(limit).cloned().collect();
        let next_before_seq = matching
            .next()
            .and_then(|_| items.last().map(|record| record.seq));
        NotificationListResponse {
            items,
            next_before_seq,
            counts: Self::counts(&state.file),
        }
    }

    /// Counts for a badge.
    pub(crate) async fn status(&self) -> NotificationCounts {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        Self::counts(&state.file)
    }

    /// Whether James has dealt with a record. Reading settles most, but an
    /// open request or review still waits on him: opening its thread reads it.
    pub(crate) async fn is_settled(&self, id: &str) -> bool {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        state.file.records.iter().any(|stored| {
            stored.record.id == id && stored.record.is_read() && !stored.record.is_waiting()
        })
    }

    /// One record with its body.
    pub(crate) async fn get(&self, id: &str) -> Option<NotificationRecord> {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        let mut record = state
            .file
            .records
            .iter()
            .find(|stored| stored.record.id == id)?
            .record
            .clone();
        if record.has_body {
            record.body = tokio::fs::read_to_string(self.body_path(id)).await.ok();
        }
        Some(record)
    }

    /// Marks records read. Returns whether anything changed.
    pub(crate) async fn mark_read(
        &self,
        request: &MarkNotificationsReadRequest,
        now: DateTime<Utc>,
    ) -> bool {
        self.update(
            now,
            |record| {
                (request.ids.contains(&record.id)
                    || request
                        .up_to_seq
                        .is_some_and(|seq| record.seq <= seq && record.matches(request.filter)))
                    && !record.is_read()
            },
            |record| record.read_at = Some(now),
        )
        .await
    }

    /// Opening a thread on any device reads what it was announcing. Reviews and
    /// notices carry their own content, so they stay unread until opened.
    pub(crate) async fn mark_thread_read(
        &self,
        workspace_id: &str,
        thread_id: &str,
        now: DateTime<Utc>,
    ) -> bool {
        self.update(
            now,
            |record| {
                !record.is_read()
                    && matches!(
                        record.kind,
                        NotificationKind::TurnComplete
                            | NotificationKind::Error
                            | NotificationKind::InputRequired
                    )
                    && record.thread_id.as_deref() == Some(thread_id)
                    && record.workspace_id.as_deref() == Some(workspace_id)
            },
            |record| record.read_at = Some(now),
        )
        .await
    }

    /// Reports that are not on the relay under this key and still have life
    /// left, oldest first. Answering from a phone never depends on this list.
    pub(crate) async fn pending_reports(
        &self,
        key: &str,
        now: DateTime<Utc>,
    ) -> Vec<PendingReport> {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        let candidates: Vec<_> = state
            .file
            .records
            .iter()
            .filter(|stored| stored.report_key.as_deref() != Some(key))
            .filter(|stored| {
                stored
                    .record
                    .report
                    .as_ref()
                    .is_some_and(|report| report.expires_at > now)
            })
            .map(|stored| stored.record.clone())
            .collect();
        drop(guard);
        let mut pending = Vec::with_capacity(candidates.len());
        for record in candidates {
            match tokio::fs::read_to_string(self.body_path(&record.id)).await {
                Ok(body) => pending.push(PendingReport { record, body }),
                Err(error) => tracing::warn!(id = %record.id, %error, "report body unreadable"),
            }
        }
        pending
    }

    /// The relay holds this report under this key.
    pub(crate) async fn mark_report_hosted(&self, id: &str, key: &str) {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        let Some(stored) = state
            .file
            .records
            .iter_mut()
            .find(|stored| stored.record.id == id)
        else {
            return;
        };
        stored.report_key = Some(key.to_string());
        if let Some(report) = &mut stored.record.report {
            report.hosted = true;
        }
        self.save(state).await;
    }

    /// The request or review was dealt with, wherever that happened.
    pub(crate) async fn resolve(&self, dedupe_key: &str, now: DateTime<Utc>) -> bool {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        let Some(stored) = state.file.records.iter_mut().rev().find(|stored| {
            stored.dedupe_key.as_deref() == Some(dedupe_key) && stored.record.resolved_at.is_none()
        }) else {
            if state.resolved_early.len() == MAX_RESOLVED_EARLY {
                state.resolved_early.pop_front();
            }
            state.resolved_early.push_back(dedupe_key.to_string());
            return false;
        };
        stored.record.resolved_at = Some(now);
        stored.record.read_at.get_or_insert(now);
        self.save(state).await;
        true
    }

    /// The newest open record under `prefix`. Unlike `resolve` it remembers
    /// nothing on a miss: with no exact key, a later event could be mistaken
    /// for this one and arrive already answered.
    pub(crate) async fn resolve_newest(&self, prefix: &str, now: DateTime<Utc>) -> bool {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        let Some(stored) = state.file.records.iter_mut().rev().find(|stored| {
            stored.record.resolved_at.is_none()
                && stored
                    .dedupe_key
                    .as_deref()
                    .is_some_and(|key| key.starts_with(prefix))
        }) else {
            return false;
        };
        stored.record.resolved_at = Some(now);
        stored.record.read_at.get_or_insert(now);
        self.save(state).await;
        true
    }

    /// Settles open records under `prefix` that nobody can answer now: those
    /// recorded before `before_seq`, or all of them without one. Going by order
    /// rather than sparing one record means two events racing cannot retire
    /// each other. Returns whether any changed.
    pub(crate) async fn retire_open(
        &self,
        prefix: &str,
        before_seq: Option<u64>,
        now: DateTime<Utc>,
    ) -> bool {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        let mut changed = false;
        for stored in &mut state.file.records {
            let under_prefix = stored
                .dedupe_key
                .as_deref()
                .is_some_and(|key| key.starts_with(prefix));
            if under_prefix
                && stored.record.resolved_at.is_none()
                && before_seq.is_none_or(|seq| stored.record.seq < seq)
            {
                stored.record.resolved_at = Some(now);
                stored.record.read_at.get_or_insert(now);
                changed = true;
            }
        }
        if changed {
            self.save(state).await;
        }
        changed
    }

    async fn update(
        &self,
        now: DateTime<Utc>,
        wanted: impl Fn(&NotificationRecord) -> bool,
        change: impl Fn(&mut NotificationRecord),
    ) -> bool {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        self.prune(state, now).await;
        let mut changed = false;
        for stored in &mut state.file.records {
            if wanted(&stored.record) {
                change(&mut stored.record);
                changed = true;
            }
        }
        if changed {
            self.save(state).await;
        }
        changed
    }
}

/// How many records each kind holds, for logs and tests.
#[cfg(test)]
impl NotificationStore {
    async fn kinds(&self) -> std::collections::HashMap<NotificationKind, usize> {
        let mut guard = self.state.lock().await;
        let state = &mut *guard;
        self.ensure_loaded(state).await;
        let mut kinds = std::collections::HashMap::new();
        for stored in &state.file.records {
            *kinds.entry(stored.record.kind).or_default() += 1;
        }
        kinds
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use falcondeck_core::notifications::NotificationFilter;

    fn now() -> DateTime<Utc> {
        "2026-11-04T12:00:00Z".parse().unwrap()
    }

    fn store() -> (tempfile::TempDir, NotificationStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = NotificationStore::new(temp.path().join("notifications"));
        (temp, store)
    }

    #[tokio::test]
    async fn racing_replacements_leave_the_newest_open_in_either_order() {
        let temp = tempfile::tempdir().unwrap();
        let store = NotificationStore::new(temp.path().join("notifications"));
        let now = Utc::now();
        let first = store
            .record(event(NotificationKind::InputRequired, "input:w:0:a"), now)
            .await;
        let second = store
            .record(event(NotificationKind::InputRequired, "input:w:0:b"), now)
            .await;
        let (first, second) = (first.record().clone(), second.record().clone());
        store.retire_open("input:w:0:", Some(second.seq), now).await;
        store.retire_open("input:w:0:", Some(first.seq), now).await;
        assert!(store.is_settled(&first.id).await);
        assert!(!store.is_settled(&second.id).await);
        assert_eq!(store.status().await.needs_you_count, 1);
    }

    fn event(kind: NotificationKind, key: &str) -> NewNotification {
        NewNotification {
            kind,
            title: "Fix login".into(),
            preview: "Done.".into(),
            bot: None,
            thread_id: Some("thread-1".into()),
            workspace_id: Some("workspace-1".into()),
            target: None,
            importance: NotificationImportance::Normal,
            dedupe_key: Some(key.into()),
            coalesce: false,
            sender: None,
            body: None,
        }
    }

    fn notice(sender: &str, title: &str) -> NewNotification {
        NewNotification {
            title: title.into(),
            sender: Some(sender.into()),
            dedupe_key: None,
            ..event(NotificationKind::AgentNotice, "")
        }
    }

    fn page(limit: usize) -> NotificationListRequest {
        NotificationListRequest {
            limit: Some(limit),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn the_same_event_records_once() {
        let (_temp, store) = store();
        let first = store
            .record(event(NotificationKind::InputRequired, "input:1"), now())
            .await;
        let again = store
            .record(event(NotificationKind::InputRequired, "input:1"), now())
            .await;
        assert!(matches!(first, Recorded::Created(_)));
        assert!(matches!(again, Recorded::Duplicate(_)));
        assert_eq!(first.record().id, again.record().id);
        assert_eq!(store.list(&page(10), now()).await.items.len(), 1);
    }

    #[tokio::test]
    async fn completions_fold_into_the_threads_unread_record_until_it_is_read() {
        let (_temp, store) = store();
        let turn = |key: &str, preview: &str| NewNotification {
            coalesce: true,
            preview: preview.into(),
            ..event(NotificationKind::TurnComplete, key)
        };
        let first = store.record(turn("turn:1", "One"), now()).await;
        let other = store
            .record(event(NotificationKind::Review, "review:R-1"), now())
            .await;
        let later = now() + Duration::minutes(5);
        let second = store.record(turn("turn:2", "Two"), later).await;
        assert!(matches!(second, Recorded::Coalesced(_)));
        assert_eq!(second.record().id, first.record().id);
        assert_eq!(second.record().repeat_count, 1);
        assert_eq!(second.record().created_at, later);
        let list = store.list(&page(10), later).await;
        assert_eq!(list.items.len(), 2);
        // A refreshed record moves back to the top of the list.
        assert_eq!(list.items[0].preview, "Two");
        assert_eq!(list.items[1].id, other.record().id);

        // The second key was remembered when the first was replaced.
        assert!(matches!(
            store.record(turn("turn:2", "Two"), later).await,
            Recorded::Duplicate(_)
        ));

        assert!(
            store
                .mark_thread_read("workspace-1", "thread-1", later)
                .await
        );
        let third = store.record(turn("turn:3", "Three"), later).await;
        assert!(matches!(third, Recorded::Created(_)));
        assert_ne!(third.record().id, first.record().id);
    }

    #[tokio::test]
    async fn read_state_survives_a_restart_and_mark_all_stops_at_what_was_seen() {
        let (temp, store) = store();
        let first = store
            .record(event(NotificationKind::Error, "a"), now())
            .await;
        let seen = store.status().await.latest_seq;
        let newer = store
            .record(event(NotificationKind::Error, "b"), now())
            .await;
        let request = MarkNotificationsReadRequest {
            up_to_seq: Some(seen),
            ..Default::default()
        };
        assert!(store.mark_read(&request, now()).await);
        assert!(
            !store.mark_read(&request, now()).await,
            "already read changes nothing"
        );

        let reopened = NotificationStore::new(temp.path().join("notifications"));
        let list = reopened.list(&page(10), now()).await;
        assert_eq!(list.counts.unread_count, 1);
        let by_id = |id: &str| list.items.iter().find(|r| r.id == id).unwrap();
        assert_eq!(by_id(&first.record().id).read_at, Some(now()));
        assert_eq!(by_id(&newer.record().id).read_at, None);
    }

    #[tokio::test]
    async fn opening_a_thread_leaves_reviews_and_notices_unread() {
        let (_temp, store) = store();
        store
            .record(event(NotificationKind::TurnComplete, "a"), now())
            .await;
        store
            .record(event(NotificationKind::InputRequired, "b"), now())
            .await;
        store
            .record(event(NotificationKind::Review, "c"), now())
            .await;
        store
            .record(event(NotificationKind::AgentNotice, "d"), now())
            .await;
        assert!(
            store
                .mark_thread_read("workspace-1", "thread-1", now())
                .await
        );
        let list = store.list(&page(10), now()).await;
        let unread: Vec<_> = list
            .items
            .iter()
            .filter(|r| !r.is_read())
            .map(|r| r.kind)
            .collect();
        assert_eq!(
            unread,
            [NotificationKind::AgentNotice, NotificationKind::Review]
        );
        // Reading a request is not answering it.
        assert_eq!(list.counts.needs_you_count, 2);
    }

    #[tokio::test]
    async fn resolving_clears_needs_you_and_reads_the_record() {
        let (_temp, store) = store();
        store
            .record(event(NotificationKind::InputRequired, "input:1"), now())
            .await;
        assert_eq!(store.status().await.needs_you_count, 1);
        assert!(store.resolve("input:1", now()).await);
        assert!(!store.resolve("input:1", now()).await);
        let status = store.status().await;
        assert_eq!((status.needs_you_count, status.unread_count), (0, 0));
        let waiting = NotificationListRequest {
            filter: NotificationFilter::NeedsYou,
            ..Default::default()
        };
        assert!(store.list(&waiting, now()).await.items.is_empty());
        // History keeps it.
        assert_eq!(store.list(&page(10), now()).await.items.len(), 1);
    }

    #[tokio::test]
    async fn filters_and_paging_walk_the_history() {
        let (_temp, store) = store();
        for index in 0..5 {
            store
                .record(event(NotificationKind::Error, &format!("e{index}")), now())
                .await;
        }
        store
            .record(
                NewNotification {
                    bot: Some("Juno".into()),
                    ..event(NotificationKind::TurnComplete, "bot")
                },
                now(),
            )
            .await;
        let first = store.list(&page(4), now()).await;
        assert_eq!(first.items.len(), 4);
        let second = store
            .list(
                &NotificationListRequest {
                    limit: Some(4),
                    before_seq: first.next_before_seq,
                    ..Default::default()
                },
                now(),
            )
            .await;
        assert_eq!(second.items.len(), 2);
        assert_eq!(second.next_before_seq, None);
        let bots = NotificationListRequest {
            filter: NotificationFilter::Bots,
            ..Default::default()
        };
        assert_eq!(
            store.list(&bots, now()).await.items[0].bot.as_deref(),
            Some("Juno")
        );
    }

    #[tokio::test]
    async fn retention_drops_old_records_and_their_bodies() {
        let (temp, store) = store();
        let old = now() - Duration::days(RETENTION_DAYS + 1);
        let with_body = NewNotification {
            body: Some("# Report".into()),
            ..notice("bot:Juno", "Old")
        };
        let record = store.record_notice(with_body, old).await.unwrap();
        let body = temp
            .path()
            .join("notifications/bodies")
            .join(format!("{}.md", record.record().id));
        assert!(body.exists());
        store
            .record(event(NotificationKind::Error, "new"), now())
            .await;
        let list = store.list(&page(10), now()).await;
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].kind, NotificationKind::Error);
        assert!(!body.exists());
    }

    #[tokio::test]
    async fn the_ceiling_evicts_read_completions_before_anything_james_has_not_seen() {
        let (_temp, store) = store();
        {
            let mut guard = store.state.lock().await;
            guard.loaded = true;
            for index in 0..MAX_RECORDS {
                let id = NotificationStore::bump_seq(&mut guard.file);
                guard.file.records.push(Stored {
                    record: NotificationRecord {
                        id: format!("N-{id}"),
                        seq: id,
                        kind: if index == 0 {
                            NotificationKind::Review
                        } else {
                            NotificationKind::TurnComplete
                        },
                        title: String::new(),
                        preview: String::new(),
                        bot: None,
                        thread_id: None,
                        workspace_id: None,
                        created_at: now(),
                        read_at: (index % 2 == 1).then(now),
                        resolved_at: None,
                        target: None,
                        importance: NotificationImportance::Normal,
                        has_body: false,
                        body: None,
                        report: None,
                        repeat_count: 0,
                    },
                    dedupe_key: None,
                    folded_keys: Vec::new(),
                    sender: None,
                    report_key: None,
                });
            }
        }
        store
            .record(event(NotificationKind::Error, "newest"), now())
            .await;
        let kinds = store.kinds().await;
        assert_eq!(kinds.values().sum::<usize>(), MAX_RECORDS);
        assert_eq!(
            kinds[&NotificationKind::Review],
            1,
            "unread review survives"
        );
        assert_eq!(kinds[&NotificationKind::Error], 1, "newest survives");
        let unread = store.status().await.unread_count;
        assert_eq!(
            unread,
            MAX_RECORDS / 2 + 1,
            "only read records were evicted"
        );
    }

    #[tokio::test]
    async fn a_future_file_is_left_alone_and_events_still_record_in_memory() {
        let (temp, store) = store();
        let path = temp.path().join("notifications/notifications.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let future = r#"{"version":2,"next_id":9,"next_seq":9,"records":[]}"#;
        std::fs::write(&path, future).unwrap();
        store
            .record(event(NotificationKind::Error, "a"), now())
            .await;
        assert_eq!(store.status().await.unread_count, 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), future);
    }

    #[tokio::test]
    async fn a_notice_cannot_overwrite_a_report_when_the_index_will_not_load() {
        let (temp, store) = store();
        let dir = temp.path().join("notifications");
        std::fs::create_dir_all(dir.join("bodies")).unwrap();
        std::fs::write(dir.join("notifications.json"), "not json").unwrap();
        std::fs::write(dir.join("bodies/N-1.md"), "the original").unwrap();
        let report = NewNotification {
            body: Some("a newer report".into()),
            ..notice("bot:juno", "Report")
        };
        let refused = store.record_notice(report, now()).await.unwrap_err();
        assert!(matches!(refused, NoticeRefused::Storage(_)));
        assert_eq!(
            std::fs::read_to_string(dir.join("bodies/N-1.md")).unwrap(),
            "the original"
        );
        let plain = store
            .record_notice(notice("bot:juno", "Short"), now())
            .await;
        assert!(matches!(plain, Ok(Recorded::Created(_))));
    }

    #[tokio::test]
    async fn an_answer_that_beats_its_record_still_resolves_it() {
        let (_temp, store) = store();
        assert!(!store.resolve("input:1", now()).await);
        let late = store
            .record(event(NotificationKind::InputRequired, "input:1"), now())
            .await;
        assert!(late.record().resolved_at.is_some());
        let counts = store.status().await;
        assert_eq!((counts.unread_count, counts.needs_you_count), (0, 0));
    }

    #[tokio::test]
    async fn a_replay_of_a_folded_event_is_still_a_duplicate() {
        let (_temp, store) = store();
        let folding = |key| NewNotification {
            coalesce: true,
            ..event(NotificationKind::TurnComplete, key)
        };
        store.record(folding("turn:a"), now()).await;
        store.record(folding("turn:b"), now()).await;
        let replay = store.record(folding("turn:a"), now()).await;
        assert!(matches!(replay, Recorded::Duplicate(_)));
        assert_eq!(replay.record().repeat_count, 1);
    }

    #[tokio::test]
    async fn a_failed_write_keeps_the_record_and_the_next_save_retries() {
        let (temp, store) = store();
        let dir = temp.path().join("notifications");
        // Loaded fine, then the disk stops cooperating.
        store.status().await;
        std::fs::write(&dir, "a file where the folder should be").unwrap();
        let first = store
            .record(event(NotificationKind::Error, "a"), now())
            .await;
        assert!(matches!(first, Recorded::Created(_)));
        std::fs::remove_file(&dir).unwrap();
        store
            .record(event(NotificationKind::Error, "b"), now())
            .await;
        let reopened = NotificationStore::new(dir);
        assert_eq!(reopened.list(&page(10), now()).await.items.len(), 2);
    }

    #[tokio::test]
    async fn notices_are_limited_per_sender_and_tell_the_agent_when_to_retry() {
        let (_temp, store) = store();
        for index in 0..NOTICES_PER_HOUR {
            store
                .record_notice(notice("bot:Juno", &format!("n{index}")), now())
                .await
                .unwrap();
        }
        let refused = store
            .record_notice(notice("bot:Juno", "over"), now())
            .await
            .unwrap_err();
        assert_eq!(
            refused,
            NoticeRefused::RateLimited {
                limit: "3 per hour",
                retry_after: Duration::hours(1)
            }
        );
        // One sender's limit is not another's.
        store
            .record_notice(notice("bot:Vulcan", "fine"), now())
            .await
            .unwrap();
        // The hour passes.
        let later = now() + Duration::minutes(61);
        store
            .record_notice(notice("bot:Juno", "later"), later)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn the_daily_limit_outlasts_the_hourly_window() {
        let (_temp, store) = store();
        for index in 0..NOTICES_PER_DAY {
            let at = now() + Duration::minutes(21 * index as i64);
            store
                .record_notice(notice("bot:Juno", &format!("n{index}")), at)
                .await
                .unwrap();
        }
        let at = now() + Duration::hours(6);
        let refused = store
            .record_notice(notice("bot:Juno", "over"), at)
            .await
            .unwrap_err();
        assert!(matches!(
            refused,
            NoticeRefused::RateLimited {
                limit: "10 per day",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn high_importance_has_its_own_smaller_allowance() {
        let (_temp, store) = store();
        let high = |title: &str, at: i64| {
            (
                NewNotification {
                    importance: NotificationImportance::High,
                    ..notice("bot:Juno", title)
                },
                now() + Duration::hours(at),
            )
        };
        for (new, at) in [high("a", 0), high("b", 2)] {
            store.record_notice(new, at).await.unwrap();
        }
        let (new, at) = high("c", 4);
        let refused = store.record_notice(new, at).await.unwrap_err();
        assert!(matches!(
            refused,
            NoticeRefused::RateLimited {
                limit: "2 high-importance per day",
                ..
            }
        ));
        // A normal notice still goes through.
        store
            .record_notice(notice("bot:Juno", "normal"), at)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn all_agents_share_a_daily_ceiling_with_room_kept_for_high_importance() {
        let (_temp, store) = store();
        let open = ALL_NOTICES_PER_DAY - HIGH_NOTICES_RESERVED;
        for index in 0..open {
            store
                .record_notice(notice(&format!("thread:{index}"), "n"), now())
                .await
                .unwrap();
        }
        let refused = store
            .record_notice(notice("thread:new", "n"), now())
            .await
            .unwrap_err();
        assert!(matches!(
            refused,
            NoticeRefused::RateLimited {
                limit: "25 per day across all agents, with 5 kept for high importance",
                ..
            }
        ));
        let high = |sender: String| NewNotification {
            importance: NotificationImportance::High,
            ..notice(&sender, "urgent")
        };
        for index in 0..HIGH_NOTICES_RESERVED {
            store
                .record_notice(high(format!("thread:high{index}")), now())
                .await
                .unwrap();
        }
        let refused = store
            .record_notice(high("thread:last".into()), now())
            .await
            .unwrap_err();
        assert!(matches!(
            refused,
            NoticeRefused::RateLimited {
                limit: "30 per day across all agents",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn mark_all_can_keep_to_one_filter() {
        let (_temp, store) = store();
        store
            .record_notice(notice("bot:Juno", "n"), now())
            .await
            .unwrap();
        store
            .record(event(NotificationKind::TurnComplete, "turn"), now())
            .await;
        store
            .mark_read(
                &MarkNotificationsReadRequest {
                    up_to_seq: Some(2),
                    filter: NotificationFilter::Bots,
                    ..Default::default()
                },
                now(),
            )
            .await;
        assert_eq!(store.status().await.unread_count, 1, "the rest stay unread");
    }

    #[tokio::test]
    async fn a_retried_notice_replays_instead_of_pushing_twice_and_costs_nothing() {
        let (_temp, store) = store();
        let first = store
            .record_notice(notice("bot:Juno", "Same"), now())
            .await
            .unwrap();
        for _ in 0..NOTICES_PER_HOUR + 1 {
            let again = store
                .record_notice(notice("bot:Juno", "Same"), now())
                .await
                .unwrap();
            assert!(matches!(again, Recorded::Duplicate(_)));
            assert_eq!(again.record().id, first.record().id);
        }
        assert_eq!(store.status().await.unread_count, 1);
    }

    #[tokio::test]
    async fn reports_stay_pending_until_hosted_and_again_after_a_key_change() {
        let (_temp, store) = store();
        let new = NewNotification {
            body: Some("# Report".into()),
            ..notice("bot:Juno", "Report")
        };
        let recorded = store.record_notice(new, now()).await.unwrap();
        let id = recorded.record().id.clone();
        let pending = store.pending_reports("key-1", now()).await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].body, "# Report");

        store.mark_report_hosted(&id, "key-1").await;
        assert!(store.pending_reports("key-1", now()).await.is_empty());
        assert!(store.get(&id).await.unwrap().report.unwrap().hosted);

        // The session key rotated after a device was revoked.
        assert_eq!(store.pending_reports("key-2", now()).await.len(), 1);
        // A report past its relay lifetime stays on the daemon only.
        let late = now() + Duration::days(REPORT_TTL_DAYS + 1);
        assert!(store.pending_reports("key-2", late).await.is_empty());
    }

    #[tokio::test]
    async fn bodies_come_back_only_on_a_single_read() {
        let (_temp, store) = store();
        let new = NewNotification {
            body: Some("# Report".into()),
            ..notice("bot:Juno", "Report")
        };
        let recorded = store.record_notice(new, now()).await.unwrap();
        let listed = store.list(&page(10), now()).await;
        assert!(listed.items[0].has_body);
        assert_eq!(listed.items[0].body, None);
        let read = store.get(&recorded.record().id).await.unwrap();
        assert_eq!(read.body.as_deref(), Some("# Report"));
        assert_eq!(
            read.report.as_ref().unwrap().expires_at,
            now() + Duration::days(REPORT_TTL_DAYS)
        );
    }
}
