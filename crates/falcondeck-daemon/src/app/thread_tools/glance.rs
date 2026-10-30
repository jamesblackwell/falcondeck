//! One compact row per thread, shared by list, changes, and wait so agents
//! learn a single shape. A row says what the thread was last asked and what it
//! last said, from the cheapest source available: items in memory, then the
//! search-index excerpts. Without either, the summary preview is shown as a
//! `Preview:` because its author is unknown (Codex previews are the opening
//! prompt, Claude's the last message of either side).
use super::*;
use chrono::DateTime;
use std::path::Path;

pub(super) const ASKED_CHARS: usize = 120;
pub(super) const LATEST_CHARS: usize = 200;
/// Copied per thread before rendering; rows cap far lower.
const KEEP_CHARS: usize = 600;

#[derive(Default)]
pub(super) struct Glance {
    pub asked: Option<String>,
    pub latest: Option<String>,
    /// The summary preview, only when no request is known.
    pub preview: Option<String>,
    /// Every cached user excerpt, for literal query matching.
    pub excerpts: Vec<String>,
}

fn kept(text: &str) -> Option<String> {
    Some(text.trim())
        .filter(|t| !t.is_empty())
        .map(|t| capped(t, KEEP_CHARS))
}

impl Glance {
    pub(super) fn of(
        thread: &ManagedThread,
        excerpt: Option<&thread_search::SessionExcerpt>,
    ) -> Self {
        let mut glance = Self::default();
        // Newest first: replies seen before the first user message answer it.
        // An image-only request still ends the turn, keeping the pair aligned.
        let mut known_request = false;
        for item in thread.items.iter().rev() {
            match item {
                ConversationItem::UserMessage { text, .. } => {
                    glance.asked = kept(text);
                    known_request = true;
                    break;
                }
                ConversationItem::AssistantMessage { text, .. } if glance.latest.is_none() => {
                    glance.latest = kept(text);
                }
                _ => {}
            }
        }
        if let Some(excerpt) = excerpt {
            glance.excerpts = excerpt
                .opening
                .iter()
                .chain(&excerpt.recent)
                .cloned()
                .collect();
            // Loaded items are authoritative once they include a request. An
            // indexed request without a reply is simply unanswered.
            if !known_request && !glance.excerpts.is_empty() {
                known_request = true;
                glance.asked = excerpt.recent.last().or(excerpt.opening.last()).cloned();
                glance.latest = glance
                    .latest
                    .take()
                    .or_else(|| excerpt.latest_reply.clone());
            }
        }
        if !known_request && glance.latest.is_none() {
            glance.preview = thread
                .summary
                .last_message_preview
                .as_deref()
                .and_then(kept);
        }
        glance
    }

    pub(super) fn matches(&self, needle: &str) -> bool {
        [&self.asked, &self.latest, &self.preview]
            .into_iter()
            .flatten()
            .chain(&self.excerpts)
            .any(|text| text.to_lowercase().contains(needle))
    }

    /// `Asked`/`Latest`/`Preview` lines at the given widths and indent.
    pub(super) fn lines(&self, prefix: &str, asked: usize, latest: usize) -> String {
        let mut text = String::new();
        for (label, value, cap) in [
            ("Asked", &self.asked, asked),
            ("Latest", &self.latest, latest),
            ("Preview", &self.preview, latest),
        ] {
            if let Some(value) = value {
                text.push_str(&format!("{prefix}{label}: {}\n", line(value, cap)));
            }
        }
        text
    }
}

pub(super) fn ago(at: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let seconds = (now - at).num_seconds().max(0);
    match seconds {
        0..60 => format!("{seconds}s ago"),
        60..3600 => format!("{}m ago", seconds / 60),
        3600..86_400 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

pub(super) fn status_name(status: &ThreadStatus) -> &'static str {
    match status {
        ThreadStatus::Idle => "idle",
        ThreadStatus::Running => "running",
        ThreadStatus::WaitingForInput => "waiting_for_input",
        ThreadStatus::Error => "error",
    }
}

/// Status with the attention that matters most, in the list filter's words.
pub(super) fn state(summary: &ThreadSummary) -> String {
    let attention = &summary.attention;
    let pending = attention.pending_approval_count + attention.pending_question_count;
    if pending > 0 {
        let mut parts = Vec::new();
        for (count, label) in [
            (attention.pending_approval_count, "approval"),
            (attention.pending_question_count, "question"),
        ] {
            match count {
                0 => {}
                1 => parts.push(label.to_string()),
                n => parts.push(format!("{n} {label}s")),
            }
        }
        return format!("awaiting_approval ({})", parts.join(", "));
    }
    status_name(&summary.status).to_string()
}

/// Per-row context the caller knows but the summary does not.
pub(super) struct RowContext<'a> {
    pub now: DateTime<Utc>,
    pub caller: &'a str,
    /// Project label, set when rows span several projects.
    pub project: Option<&'a str>,
    pub folder: Option<&'a str>,
    pub excerpts: bool,
}

/// `state · age · provider[ model]` and whichever facts apply, in a fixed order.
pub(super) fn facts(t: &ThreadSummary, cx: &RowContext<'_>, model: bool) -> String {
    let provider = match t.agent.model_id.as_deref().filter(|_| model) {
        Some(model) => format!("{} {}", t.provider, line(model, 60)),
        None => t.provider.to_string(),
    };
    let mut facts = vec![state(t), ago(t.updated_at, cx.now), provider];
    if let Some(project) = cx.project {
        facts.push(format!("project {}", line(project, 60)));
    }
    if let Some(folder) = cx.folder {
        facts.push(format!("folder {}", line(folder, 60)));
    }
    if let Some(variant) = &t.variant {
        facts.push(format!("branch {}", line(&variant.branch, 80)));
    }
    if let Some(ThreadOrigin::AgentSpawn {
        parent_thread_id, ..
    }) = &t.origin
    {
        facts.push(if parent_thread_id == cx.caller {
            "your child".into()
        } else {
            format!("parent {}", line(parent_thread_id, 128))
        });
    }
    if !t.queued_turns.is_empty() {
        facts.push(format!("{} queued", t.queued_turns.len()));
    }
    if t.attention.background_task_count > 0 {
        facts.push(format!("{} background", t.attention.background_task_count));
    }
    if t.is_pinned || t.is_pinned_in_project {
        facts.push("pinned".into());
    }
    if t.is_archived {
        facts.push("archived".into());
    }
    if t.attention.unread {
        facts.push("unread".into());
    }
    facts.join(" · ")
}

/// `- **Title** `id` — facts`, then indented Goal, `extra` (attention and
/// deltas), Asked/Latest/Preview, and Error lines.
pub(super) fn row(
    summary: &ThreadSummary,
    glance: &Glance,
    cx: &RowContext<'_>,
    extra: &[String],
) -> String {
    let t = summary;
    let mut text = format!(
        "- **{}** `{}` — {}\n",
        line(&t.title, 120),
        line(&t.id, 128),
        facts(t, cx, false)
    );
    if let Some(goal) = &t.goal {
        text.push_str(&format!("  Goal: {}\n", line(&goal.objective, ASKED_CHARS)));
    }
    for extra in extra {
        text.push_str(&format!("  {extra}\n"));
    }
    if cx.excerpts {
        text.push_str(&glance.lines("  ", ASKED_CHARS, LATEST_CHARS));
    }
    if t.status == ThreadStatus::Error
        && let Some(error) = &t.last_error
    {
        text.push_str(&format!("  Error: {}\n", line(error, ASKED_CHARS)));
    }
    text
}

/// Last path segment, which is how people name projects.
pub(super) fn project_name(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
}

impl AppState {
    /// Pending approval/question counts per thread, as snapshots compute them.
    pub(super) async fn attention_counts(&self) -> HashMap<(String, String), (u32, u32)> {
        let requests = self.inner.interactive_requests.lock().await;
        let mut counts: HashMap<(String, String), (u32, u32)> = HashMap::new();
        for pending in requests.values() {
            if let Some(thread) = &pending.request.thread_id {
                let (approvals, questions) =
                    threads::interactive_request_attention_delta(&pending.request.kind);
                let entry = counts
                    .entry((pending.request.workspace_id.clone(), thread.clone()))
                    .or_default();
                entry.0 += approvals;
                entry.1 += questions;
            }
        }
        counts
    }

    /// One thread's summary (with live attention) and glance.
    pub(super) async fn thread_glance(
        &self,
        workspace: &str,
        thread: &str,
    ) -> Result<(ThreadSummary, Glance), DaemonError> {
        let (summary, glance) = {
            let workspaces = self.inner.workspaces.lock().await;
            let managed = workspaces
                .get(workspace)
                .and_then(|ws| ws.threads.get(thread))
                .ok_or_else(|| DaemonError::NotFound("thread not found".into()))?;
            let index = self
                .inner
                .thread_search
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let excerpt = managed
                .summary
                .native_session_id
                .as_ref()
                .and_then(|id| index.sessions.get(id));
            (managed.summary.clone(), Glance::of(managed, excerpt))
        };
        Ok((self.build_thread_summary_from_clone(summary).await, glance))
    }

    /// Keeps cached user excerpts and latest replies current for threads whose
    /// transcripts are not loaded. Waits briefly; a slow scan finishes behind.
    pub(super) async fn refresh_excerpts(&self) {
        if self.thread_search_index_is_fresh() {
            return;
        }
        let state = self.clone();
        let scan = tokio::spawn(async move { state.refresh_thread_search_index(true).await });
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), scan).await;
    }
}
