use super::AppState;
use falcondeck_core::{
    DaemonSnapshot, ExtensionSnapshot, ThreadStatus, ThreadSummary,
    sync_index::{SyncIndex, SyncThreadPage, WorkspaceIndexCount},
};
use std::{
    collections::{BTreeMap, VecDeque},
    time::{Duration, Instant},
};

const PAGE_BYTES: usize = 48 * 1024;
const INDEX_BYTES: usize = 64 * 1024;
const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(600);

struct FrozenIndex {
    token: String,
    created: Instant,
    threads: Vec<ThreadSummary>,
    extensions: ExtensionSnapshot,
    bytes: usize,
}
#[derive(Default)]
pub(super) struct SyncIndexCache {
    entries: VecDeque<FrozenIndex>,
}

pub(super) fn row(thread: &ThreadSummary) -> ThreadSummary {
    // Project directly: large artifacts and queued prompts are never cloned.
    ThreadSummary {
        id: thread.id.clone(),
        workspace_id: thread.workspace_id.clone(),
        title: thread.title.chars().take(512).collect(),
        provider: thread.provider.clone(),
        native_session_id: None,
        provider_transport: thread.provider_transport.clone(),
        handoff_from: thread.handoff_from.clone(),
        origin: thread.origin.clone(),
        status: thread.status.clone(),
        updated_at: thread.updated_at,
        last_message_preview: thread
            .last_message_preview
            .as_ref()
            .map(|s| s.chars().take(256).collect()),
        latest_turn_id: thread.latest_turn_id.clone(),
        latest_plan: None,
        latest_diff: None,
        last_tool: thread
            .last_tool
            .as_ref()
            .map(|s| s.chars().take(128).collect()),
        last_error: None,
        agent: thread.agent.clone(),
        attention: thread.attention.clone(),
        is_archived: thread.is_archived,
        is_pinned: thread.is_pinned,
        is_pinned_in_project: thread.is_pinned_in_project,
        goal: None,
        queued_turns: Vec::new(),
        variant: thread.variant.clone(),
    }
}

fn priority(thread: &ThreadSummary, selected: Option<&str>) -> u8 {
    if selected == Some(thread.id.as_str()) {
        0
    } else if thread.is_pinned || thread.is_pinned_in_project {
        1
    } else if thread.attention.pending_approval_count + thread.attention.pending_question_count > 0
    {
        2
    } else if thread.status == ThreadStatus::Running {
        3
    } else {
        4
    }
}

fn freeze(mut snapshot: DaemonSnapshot, selected: Option<&str>) -> (SyncIndex, FrozenIndex) {
    let token = uuid::Uuid::new_v4().to_string();
    let threads: Vec<_> = snapshot
        .threads
        .iter()
        .filter(|t| !t.is_archived)
        .map(row)
        .collect();
    snapshot.threads.clear();
    let extensions = std::mem::take(&mut snapshot.extensions);
    let mut index = SyncIndex {
        token: token.clone(),
        snapshot,
        agent_catalogs: Vec::new(),
        workspace_agents: BTreeMap::new(),
        model_catalogs: Vec::new(),
        workspace_models: BTreeMap::new(),
        counts: BTreeMap::new(),
    };
    for workspace in &mut index.snapshot.workspaces {
        let mut references = Vec::new();
        for agent in std::mem::take(&mut workspace.agents) {
            let position = index
                .agent_catalogs
                .iter()
                .position(|a| a == &agent)
                .unwrap_or_else(|| {
                    index.agent_catalogs.push(agent);
                    index.agent_catalogs.len() - 1
                });
            references.push(position);
        }
        index
            .workspace_agents
            .insert(workspace.id.clone(), references);
        let models = std::mem::take(&mut workspace.models);
        let position = index
            .model_catalogs
            .iter()
            .position(|m| m == &models)
            .unwrap_or_else(|| {
                index.model_catalogs.push(models);
                index.model_catalogs.len() - 1
            });
        index
            .workspace_models
            .insert(workspace.id.clone(), position);
        index
            .counts
            .insert(workspace.id.clone(), WorkspaceIndexCount::default());
    }
    for thread in &threads {
        let count = index.counts.entry(thread.workspace_id.clone()).or_default();
        count.total += 1;
        count.running += usize::from(thread.status == ThreadStatus::Running);
        count.unread += usize::from(thread.attention.unread);
        count.awaiting += usize::from(
            thread.attention.pending_approval_count + thread.attention.pending_question_count > 0,
        );
    }
    let mut initial: Vec<_> = threads.iter().collect();
    initial.sort_by(|a, b| {
        priority(a, selected)
            .cmp(&priority(b, selected))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut bytes = serde_json::to_vec(&index).map_or(INDEX_BYTES, |s| s.len());
    for thread in initial.into_iter().take(50) {
        let size = serde_json::to_vec(thread).map_or(PAGE_BYTES, |s| s.len());
        if bytes + size + 1 > INDEX_BYTES {
            break;
        }
        index.snapshot.threads.push(thread.clone());
        bytes += size + 1;
    }
    let bytes = serde_json::to_vec(&threads).map_or(CACHE_BYTES, |s| s.len())
        + serde_json::to_vec(&extensions).map_or(CACHE_BYTES, |s| s.len());
    (
        index,
        FrozenIndex {
            token,
            created: Instant::now(),
            threads,
            extensions,
            bytes,
        },
    )
}

impl AppState {
    pub(super) async fn sync_index_open(
        &self,
        selected: Option<&str>,
    ) -> Result<SyncIndex, String> {
        let mut snapshot = self.snapshot_projection(true).await;
        for workspace in &mut snapshot.workspaces {
            workspace.skills.clear();
            for agent in &mut workspace.agents {
                agent.skills.clear();
            }
        }
        let (index, frozen) = freeze(snapshot, selected);
        if frozen.bytes > CACHE_BYTES {
            return Err("Remote index exceeds cache budget".into());
        }
        let mut cache = self.inner.sync_indexes.lock().await;
        cache
            .entries
            .retain(|entry| entry.created.elapsed() < CACHE_TTL);
        while cache.entries.len() >= 16
            || cache.entries.iter().map(|e| e.bytes).sum::<usize>() + frozen.bytes > CACHE_BYTES
        {
            cache.entries.pop_front();
        }
        cache.entries.push_back(frozen);
        tracing::info!(
            bytes = serde_json::to_vec(&index).map_or(0, |s| s.len()),
            rows = index.snapshot.threads.len(),
            "compact sync index prepared"
        );
        Ok(index)
    }

    pub(super) async fn sync_index_threads(
        &self,
        token: &str,
        workspace: &str,
        cursor: usize,
        sort: &str,
        limit: usize,
    ) -> Result<SyncThreadPage, String> {
        let cache = self.inner.sync_indexes.lock().await;
        let view = cache
            .entries
            .iter()
            .find(|v| v.token == token && v.created.elapsed() < CACHE_TTL)
            .ok_or("sync_index_expired")?;
        let mut rows: Vec<_> = view
            .threads
            .iter()
            .filter(|t| t.workspace_id == workspace)
            .collect();
        rows.sort_by(|a, b| {
            let order = match sort {
                "alphabetical" => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
                "priority" => priority(a, None)
                    .cmp(&priority(b, None))
                    .then_with(|| b.updated_at.cmp(&a.updated_at)),
                _ => b.updated_at.cmp(&a.updated_at),
            };
            order.then_with(|| a.id.cmp(&b.id))
        });
        if cursor > rows.len() {
            return Err("invalid sync page cursor".into());
        }
        let mut page = SyncThreadPage {
            token: token.into(),
            workspace_id: workspace.into(),
            threads: Vec::new(),
            next_cursor: None,
        };
        let mut bytes = serde_json::to_vec(&page).map_err(|e| e.to_string())?.len() + 20;
        for thread in rows.iter().skip(cursor).take(limit.clamp(1, 50)) {
            let size = serde_json::to_vec(thread).map_err(|e| e.to_string())?.len();
            if !page.threads.is_empty() && bytes + size > PAGE_BYTES {
                break;
            }
            if bytes + size + 1 > PAGE_BYTES {
                return Err("sync row exceeds page budget".into());
            }
            page.threads.push((*thread).clone());
            bytes += size + 1;
        }
        let next = cursor + page.threads.len();
        page.next_cursor = (next < rows.len()).then_some(next);
        Ok(page)
    }

    pub(super) async fn sync_index_extensions(
        &self,
        token: &str,
    ) -> Result<ExtensionSnapshot, String> {
        let cache = self.inner.sync_indexes.lock().await;
        cache
            .entries
            .iter()
            .find(|v| v.token == token && v.created.elapsed() < CACHE_TTL)
            .map(|v| v.extensions.clone())
            .ok_or_else(|| "sync_index_expired".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> DaemonSnapshot {
        let now = "2026-09-05T12:00:00Z";
        serde_json::from_value(json!({
            "daemon": {"version": "test", "started_at": now},
            "workspaces": (0..40).map(|n| json!({
                "id": format!("workspace-{n}"), "path": format!("/projects/{n}"),
                "status": "ready", "connected_at": now, "updated_at": now,
                "models": (0..30).map(|model| json!({"id": format!("model-{model}"), "label": format!("Model {model}"), "is_default": model == 0, "supported_reasoning_efforts": []})).collect::<Vec<_>>()
            })).collect::<Vec<_>>(),
            "threads": (0..2000).map(|n| json!({
                "id": format!("thread-{n}"), "workspace_id": format!("workspace-{}", n / 50),
                "title": format!("Thread {n:04}"), "status": "idle", "updated_at": now,
                "last_message_preview": "a".repeat(400), "latest_diff": "patch".repeat(1000)
            })).collect::<Vec<_>>(),
            "interactive_requests": []
        })).unwrap()
    }

    #[tokio::test]
    async fn large_library_has_bounded_initial_index_and_complete_frozen_pages() {
        let source = fixture();
        let full_size = serde_json::to_vec(&source).unwrap().len();
        let (index, frozen) = freeze(source, Some("thread-1999"));
        let bytes = serde_json::to_vec(&index).unwrap().len();
        assert!(bytes <= INDEX_BYTES, "index is {bytes} bytes");
        eprintln!("compact fixture: {bytes} initial JSON bytes, {full_size} full JSON bytes");
        assert!(bytes * 20 < full_size);
        assert_eq!(index.snapshot.threads[0].id, "thread-1999");
        assert_eq!(index.counts.len(), 40);
        assert_eq!(index.counts.values().map(|v| v.total).sum::<usize>(), 2000);
        assert_eq!(index.model_catalogs.len(), 1);
        assert!(
            index
                .snapshot
                .threads
                .iter()
                .all(|t| t.latest_diff.is_none())
        );
        let temp = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            Default::default(),
            temp.path().join("state.json"),
        );
        app.inner
            .sync_indexes
            .lock()
            .await
            .entries
            .push_back(frozen);
        let mut cursor = 0;
        let mut ids = std::collections::HashSet::new();
        loop {
            let page = app
                .sync_index_threads(&index.token, "workspace-0", cursor, "alphabetical", 10)
                .await
                .unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() <= PAGE_BYTES);
            for thread in page.threads {
                assert!(ids.insert(thread.id));
            }
            match page.next_cursor {
                Some(next) => {
                    assert!(next > cursor);
                    cursor = next;
                }
                None => break,
            }
        }
        assert_eq!(ids.len(), 50);
        // A new view cannot silently change an old page's source.
        let (other, next) = freeze(fixture(), None);
        app.inner.sync_indexes.lock().await.entries.push_back(next);
        assert_ne!(index.token, other.token);
        assert_eq!(
            app.sync_index_threads(&index.token, "workspace-0", 0, "alphabetical", 10)
                .await
                .unwrap()
                .threads[0]
                .title,
            "Thread 0000"
        );
        app.inner.sync_indexes.lock().await.entries[0].created = Instant::now() - CACHE_TTL;
        assert_eq!(
            app.sync_index_threads(&index.token, "workspace-0", 0, "alphabetical", 10)
                .await
                .unwrap_err(),
            "sync_index_expired"
        );
    }
}
