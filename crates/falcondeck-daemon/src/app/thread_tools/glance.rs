//! One compact row per thread, shared by list, changes, and wait so agents
//! learn a single shape. A row says what the thread was last asked and what it
//! last said, from the cheapest source available: items in memory, then the
//! search-index excerpts, then the summary preview when that preview is not
//! just an echo of a user message (Codex previews are the opening prompt).
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
    pub opening: Option<String>,
    /// Every cached user excerpt, for literal query matching.
    pub excerpts: Vec<String>,
}

fn kept(text: &str) -> Option<String> {
    Some(text.trim())
        .filter(|t| !t.is_empty())
        .map(|t| capped(t, KEEP_CHARS))
}

/// True when `a` and `b` are the same message, allowing for either side
/// being a truncated preview.
fn same_text(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .trim_end_matches(['…', '.'])
            .to_lowercase()
    };
    let (a, b) = (norm(a), norm(b));
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    !short.is_empty() && long.starts_with(&short) && (short == long || short.chars().count() >= 12)
}

impl Glance {
    pub(super) fn of(
        thread: &ManagedThread,
        excerpt: Option<&thread_search::SessionExcerpt>,
    ) -> Self {
        let mut glance = Self::default();
        // Newest first: replies seen before the first user message answer it.
        for item in thread.items.iter().rev() {
            match item {
                ConversationItem::UserMessage { text, .. } => {
                    glance.asked = kept(text);
                    if glance.asked.is_some() {
                        break;
                    }
                }
                ConversationItem::AssistantMessage { text, .. } if glance.latest.is_none() => {
                    glance.latest = kept(text);
                }
                _ => {}
            }
        }
        if let Some(excerpt) = excerpt {
            glance.opening = excerpt.opening.first().cloned();
            glance.excerpts = excerpt
                .opening
                .iter()
                .chain(&excerpt.recent)
                .cloned()
                .collect();
            // Loaded items are authoritative once they include a request.
            if glance.asked.is_none() {
                glance.asked = excerpt.recent.last().or(excerpt.opening.last()).cloned();
                if glance.latest.is_none() {
                    glance.latest = excerpt.latest_reply.clone();
                }
            }
        }
        let loaded_request = thread
            .items
            .iter()
            .any(|i| matches!(i, ConversationItem::UserMessage { .. }));
        if glance.latest.is_none()
            && !loaded_request
            && let Some(preview) = thread
                .summary
                .last_message_preview
                .as_deref()
                .and_then(kept)
            && !glance
                .asked
                .iter()
                .chain(&glance.excerpts)
                .any(|user| same_text(user, &preview))
        {
            glance.latest = Some(preview);
        }
        glance
    }

    pub(super) fn matches(&self, needle: &str) -> bool {
        [&self.asked, &self.latest, &self.opening]
            .into_iter()
            .flatten()
            .chain(&self.excerpts)
            .any(|text| text.to_lowercase().contains(needle))
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

/// `- **Title** `id` — state · age · provider · facts`, then indented
/// Goal/extra/Asked/Latest/Error lines. `extra` carries attention and deltas.
pub(super) fn row(
    summary: &ThreadSummary,
    glance: &Glance,
    cx: &RowContext<'_>,
    extra: &[String],
) -> String {
    let t = summary;
    let mut facts = vec![state(t), ago(t.updated_at, cx.now), t.provider.to_string()];
    if let Some(project) = cx.project {
        facts.push(format!("project {}", line(project, 60)));
    }
    if let Some(folder) = cx.folder {
        facts.push(format!("folder {}", line(folder, 60)));
    }
    if let Some(variant) = &t.variant {
        facts.push(format!("branch {}", line(&variant.branch, 80)));
    }
    if let Some(ThreadOrigin::AgentSpawn { parent_thread_id }) = &t.origin {
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
    let mut text = format!(
        "- **{}** `{}` — {}\n",
        line(&t.title, 120),
        line(&t.id, 128),
        facts.join(" · ")
    );
    if let Some(goal) = &t.goal {
        text.push_str(&format!("  Goal: {}\n", line(&goal.objective, ASKED_CHARS)));
    }
    for extra in extra {
        text.push_str(&format!("  {extra}\n"));
    }
    if cx.excerpts {
        if let Some(asked) = &glance.asked {
            text.push_str(&format!("  Asked: {}\n", line(asked, ASKED_CHARS)));
        }
        if let Some(latest) = &glance.latest {
            text.push_str(&format!("  Latest: {}\n", line(latest, LATEST_CHARS)));
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_text_tolerates_truncated_previews_but_not_short_prefixes() {
        assert!(same_text(
            "Please can we um improve the UI of the automations page a bit?",
            "Please can we um improve the UI...",
        ));
        assert!(same_text("debug", "debug"));
        assert!(!same_text("fix", "fix the login flow"));
        assert!(!same_text("", "anything"));
    }
}
