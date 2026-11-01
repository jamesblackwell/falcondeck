use super::AppState;
use falcondeck_core::{
    DaemonSnapshot, ExtensionSnapshot, ThreadStatus, ThreadSummary, WorkspaceKind,
    sync_index::{SyncIndex, SyncIndexRequest, SyncThreadPage, WorkspaceIndexCount},
};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    time::{Duration, Instant},
};

const PAGE_BYTES: usize = 48 * 1024;
const INDEX_BYTES: usize = 64 * 1024;
const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(600);
/// Bounds on the opt-in first page; a request cannot widen them.
const PLAN_MAX_PER_WORKSPACE: usize = 20;
const PLAN_MAX_WORKSPACES: usize = 16;
const PLAN_MAX_CHATS: usize = 50;
/// Most recent unread and failed rows shipped on top of the recent ones, so a
/// long tail of old unread threads cannot inflate every refresh.
const PLAN_UNREAD_ROWS: usize = 10;
const PLAN_ERROR_ROWS: usize = 10;

struct FrozenIndex {
    token: String,
    created: Instant,
    threads: Vec<ThreadSummary>,
    workspaces: BTreeMap<String, FrozenWorkspace>,
    extensions: ExtensionSnapshot,
    folders: Vec<falcondeck_core::ProjectFolder>,
    bytes: usize,
    #[cfg(test)]
    page_order_builds: usize,
}

#[derive(Default)]
struct FrozenWorkspace {
    indices: Vec<usize>,
    orders: [Option<Vec<usize>>; 3],
}

impl FrozenIndex {
    fn workspace_rows(&mut self, workspace: &str, sort: &str) -> (&[ThreadSummary], &[usize]) {
        let Some(rows) = self.workspaces.get_mut(workspace) else {
            return (&self.threads, &[]);
        };
        let order = match sort {
            "alphabetical" => 1,
            "priority" => 2,
            _ => 0,
        };
        let indices = rows.orders[order].get_or_insert_with(|| {
            #[cfg(test)]
            {
                self.page_order_builds += 1;
            }
            let mut indices = rows.indices.clone();
            if order == 1 {
                // Cache the lowercase key once per row, not per comparison.
                indices.sort_by_cached_key(|&i| {
                    (
                        self.threads[i].title.to_lowercase(),
                        self.threads[i].id.as_str(),
                    )
                });
            } else {
                indices.sort_by(|&a, &b| {
                    let a = &self.threads[a];
                    let b = &self.threads[b];
                    let rank = if order == 2 {
                        priority(a, None).cmp(&priority(b, None))
                    } else {
                        std::cmp::Ordering::Equal
                    };
                    rank.then_with(|| b.updated_at.cmp(&a.updated_at))
                        .then_with(|| a.id.cmp(&b.id))
                });
            }
            indices
        });
        (&self.threads, indices)
    }
}
#[derive(Default)]
pub(super) struct SyncIndexCache {
    entries: VecDeque<FrozenIndex>,
}

pub(super) fn row(thread: &ThreadSummary) -> ThreadSummary {
    // Project directly: large artifacts and queued prompts are never cloned.
    ThreadSummary {
        execution_target: thread.execution_target,
        cloud: thread.cloud.clone(),
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

fn recency(a: &ThreadSummary, b: &ThreadSummary) -> std::cmp::Ordering {
    b.updated_at
        .cmp(&a.updated_at)
        .then_with(|| a.id.cmp(&b.id))
}

/// The rows a phone renders without asking again: the newest rows of the
/// lists it shows now, and everything that must stay visible regardless of
/// age. Returns the rows (most important first) and, for each workspace whose
/// newest rows were delivered as an unbroken prefix, the cursor after it.
fn plan_rows<'a>(
    threads: &'a [ThreadSummary],
    snapshot: &DaemonSnapshot,
    hidden: &HashSet<&String>,
    request: &SyncIndexRequest,
) -> (Vec<&'a ThreadSummary>, BTreeMap<String, Option<usize>>) {
    let selected = request.selected_thread_id.as_deref();
    let per_workspace = request
        .recent_per_workspace
        .unwrap_or(0)
        .clamp(1, PLAN_MAX_PER_WORKSPACE);
    let chats = request.recent_chats.unwrap_or(0).min(PLAN_MAX_CHATS);
    let casual: HashSet<&String> = snapshot
        .workspaces
        .iter()
        .filter(|workspace| workspace.kind == WorkspaceKind::Casual)
        .map(|workspace| &workspace.id)
        .collect();
    let bot_homes: HashSet<&str> = snapshot
        .preferences
        .bots
        .iter()
        .map(|bot| bot.thread_id.as_str())
        .collect();

    let mut by_workspace = BTreeMap::<&str, Vec<&ThreadSummary>>::new();
    for thread in threads {
        by_workspace
            .entry(thread.workspace_id.as_str())
            .or_default()
            .push(thread);
    }
    for rows in by_workspace.values_mut() {
        rows.sort_by(|a, b| recency(a, b));
    }

    let mut picked = HashSet::<&str>::new();
    let mut cursors = BTreeMap::new();
    let mut prefix = |workspace: &str, delivered: usize, total: usize| {
        cursors.insert(
            workspace.to_owned(),
            (delivered < total).then_some(delivered),
        );
    };
    for workspace in request
        .recent_workspace_ids
        .iter()
        .take(PLAN_MAX_WORKSPACES)
    {
        if casual.contains(workspace) || hidden.contains(workspace) {
            continue;
        }
        let rows = by_workspace
            .get(workspace.as_str())
            .map_or(&[][..], Vec::as_slice);
        for thread in rows.iter().take(per_workspace) {
            picked.insert(thread.id.as_str());
        }
        prefix(workspace, rows.len().min(per_workspace), rows.len());
    }
    // Casual chats are one short list across many one-thread workspaces. The
    // newest rows overall are a prefix of each workspace's own order.
    let mut recent_chats: Vec<&ThreadSummary> = threads
        .iter()
        .filter(|thread| casual.contains(&thread.workspace_id))
        .collect();
    recent_chats.sort_by(|a, b| recency(a, b));
    let mut delivered = BTreeMap::<&str, usize>::new();
    for thread in recent_chats.into_iter().take(chats) {
        picked.insert(thread.id.as_str());
        *delivered.entry(thread.workspace_id.as_str()).or_default() += 1;
    }
    for (workspace, count) in delivered {
        let total = by_workspace.get(workspace).map_or(0, Vec::len);
        prefix(workspace, count, total);
    }

    let visible = |thread: &ThreadSummary| !hidden.contains(&thread.workspace_id);
    let mut unread: Vec<&ThreadSummary> = Vec::new();
    let mut failed: Vec<&ThreadSummary> = Vec::new();
    for thread in threads {
        let attention = &thread.attention;
        if selected == Some(thread.id.as_str())
            || bot_homes.contains(thread.id.as_str())
            || thread.is_pinned
            || thread.is_pinned_in_project
            || attention.pending_approval_count + attention.pending_question_count > 0
            || thread.status == ThreadStatus::WaitingForInput
        {
            picked.insert(thread.id.as_str());
        } else if visible(thread) {
            if thread.status == ThreadStatus::Running || attention.background_task_count > 0 {
                picked.insert(thread.id.as_str());
            } else if thread.status == ThreadStatus::Error {
                failed.push(thread);
            } else if attention.unread {
                unread.push(thread);
            }
        }
    }
    unread.sort_by(|a, b| recency(a, b));
    failed.sort_by(|a, b| recency(a, b));
    picked.extend(unread.iter().take(PLAN_UNREAD_ROWS).map(|t| t.id.as_str()));
    picked.extend(failed.iter().take(PLAN_ERROR_ROWS).map(|t| t.id.as_str()));

    let mut rows: Vec<&ThreadSummary> = threads
        .iter()
        .filter(|thread| picked.contains(thread.id.as_str()))
        .collect();
    rows.sort_by(|a, b| {
        priority(a, selected)
            .cmp(&priority(b, selected))
            .then_with(|| recency(a, b))
    });
    (rows, cursors)
}

#[cfg(test)]
fn freeze(snapshot: DaemonSnapshot, selected: Option<&str>) -> (SyncIndex, FrozenIndex) {
    freeze_with(
        snapshot,
        &SyncIndexRequest {
            selected_thread_id: selected.map(str::to_owned),
            ..Default::default()
        },
    )
}

fn freeze_with(
    mut snapshot: DaemonSnapshot,
    request: &SyncIndexRequest,
) -> (SyncIndex, FrozenIndex) {
    let selected = request.selected_thread_id.as_deref();
    let token = uuid::Uuid::new_v4().to_string();
    // snapshot_projection(true) already filtered and projected these rows.
    // Transfer its buffer instead of copying every row a second time.
    let threads = std::mem::take(&mut snapshot.threads);
    let extensions = std::mem::take(&mut snapshot.extensions);
    let mut index = SyncIndex {
        token: token.clone(),
        snapshot,
        agent_catalogs: Vec::new(),
        workspace_agents: BTreeMap::new(),
        model_catalogs: Vec::new(),
        workspace_models: BTreeMap::new(),
        counts: BTreeMap::new(),
        initial_cursors: BTreeMap::new(),
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
    let hidden_ids: HashSet<_> = index
        .snapshot
        .preferences
        .hidden_workspace_ids
        .iter()
        .collect();
    let hidden: HashSet<_> = index
        .snapshot
        .workspaces
        .iter()
        .filter(|workspace| {
            workspace.kind != WorkspaceKind::Casual && hidden_ids.contains(&workspace.id)
        })
        .map(|workspace| &workspace.id)
        .collect();
    // Keep hidden rows in the frozen view for paging when a project is shown.
    // The open thread remains eligible for the bounded bootstrap page.
    if request.recent_per_workspace.is_some() {
        let (rows, cursors) = plan_rows(&threads, &index.snapshot, &hidden, request);
        let mut bytes = serde_json::to_vec(&index).map_or(INDEX_BYTES, |s| s.len());
        for thread in rows {
            bytes += serde_json::to_vec(thread).map_or(PAGE_BYTES, |s| s.len()) + 1;
            index.snapshot.threads.push(thread.clone());
        }
        index.initial_cursors = cursors;
        tracing::debug!(
            rows = index.snapshot.threads.len(),
            bytes,
            "planned initial rows"
        );
    } else {
        let mut initial: Vec<_> = threads
            .iter()
            .filter(|thread| {
                selected == Some(thread.id.as_str()) || !hidden.contains(&thread.workspace_id)
            })
            .collect();
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
    }
    let mut workspaces = BTreeMap::<String, FrozenWorkspace>::new();
    for (i, thread) in threads.iter().enumerate() {
        workspaces
            .entry(thread.workspace_id.clone())
            .or_default()
            .indices
            .push(i);
    }
    for rows in workspaces.values_mut() {
        rows.indices.shrink_to_fit();
    }
    // Reserve the indices plus all three lazy orders in the cache budget so
    // subsequent paging cannot grow a retained view beyond its admission size.
    let order_bytes = threads.len() * 4 * std::mem::size_of::<usize>()
        + workspaces.len() * std::mem::size_of::<FrozenWorkspace>()
        + workspaces.keys().map(String::len).sum::<usize>();
    let folders = index.snapshot.preferences.project_folders.clone();
    let bytes = serde_json::to_vec(&folders).map_or(CACHE_BYTES, |s| s.len())
        + serde_json::to_vec(&threads).map_or(CACHE_BYTES, |s| s.len())
        + serde_json::to_vec(&extensions).map_or(CACHE_BYTES, |s| s.len())
        + order_bytes;
    (
        index,
        FrozenIndex {
            token,
            created: Instant::now(),
            threads,
            workspaces,
            extensions,
            folders,
            bytes,
            #[cfg(test)]
            page_order_builds: 0,
        },
    )
}

impl AppState {
    #[cfg(test)]
    pub(super) async fn sync_index_open(
        &self,
        selected: Option<&str>,
    ) -> Result<SyncIndex, String> {
        self.sync_index_open_with(&SyncIndexRequest {
            selected_thread_id: selected.map(str::to_owned),
            ..Default::default()
        })
        .await
    }

    pub(super) async fn sync_index_open_with(
        &self,
        request: &SyncIndexRequest,
    ) -> Result<SyncIndex, String> {
        let mut snapshot = self.snapshot_projection(true).await;
        for workspace in &mut snapshot.workspaces {
            workspace.skills.clear();
            for agent in &mut workspace.agents {
                agent.skills.clear();
            }
        }
        let (index, frozen) = freeze_with(snapshot, request);
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
        folder_id: Option<&str>,
    ) -> Result<SyncThreadPage, String> {
        let mut cache = self.inner.sync_indexes.lock().await;
        let view = cache
            .entries
            .iter_mut()
            .find(|v| v.token == token && v.created.elapsed() < CACHE_TTL)
            .ok_or("sync_index_expired")?;
        // Membership is frozen with the index, like the task order. Live moves
        // also emit the task summary so clients need not restart their index.
        let members = folder_id.map(|id| {
            view.folders
                .iter()
                .find(|folder| folder.id == id && folder.workspace_id == workspace)
                .map(|folder| folder.thread_ids.iter().cloned().collect::<HashSet<_>>())
                .unwrap_or_default()
        });
        let (threads, rows) = view.workspace_rows(workspace, sort);
        let filtered;
        let rows = if let Some(members) = members {
            filtered = rows
                .iter()
                .copied()
                .filter(|&i| members.contains(&threads[i].id))
                .collect::<Vec<_>>();
            filtered.as_slice()
        } else {
            rows
        };
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
        for &i in rows.iter().skip(cursor).take(limit.clamp(1, 50)) {
            let thread = &threads[i];
            let size = serde_json::to_vec(thread).map_err(|e| e.to_string())?.len();
            if !page.threads.is_empty() && bytes + size > PAGE_BYTES {
                break;
            }
            if bytes + size + 1 > PAGE_BYTES {
                return Err("sync row exceeds page budget".into());
            }
            page.threads.push(thread.clone());
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

    // Test sources contain full summaries, unlike the production compact input.
    fn freeze_fixture(
        mut snapshot: DaemonSnapshot,
        selected: Option<&str>,
    ) -> (SyncIndex, FrozenIndex) {
        snapshot.threads = snapshot
            .threads
            .iter()
            .filter(|thread| !thread.is_archived)
            .map(row)
            .collect();
        freeze(snapshot, selected)
    }

    #[test]
    fn freezing_projected_rows_keeps_the_owned_buffer() {
        let mut source = fixture();
        source.threads = source.threads.iter().map(row).collect();
        let buffer = source.threads.as_ptr();
        let title = source.threads[0].title.as_ptr();
        let expected = serde_json::to_vec(&source.threads).unwrap();
        let (_, frozen) = freeze(source, None);
        assert_eq!(
            frozen.threads.as_ptr(),
            buffer,
            "compact rows must not be projected twice"
        );
        assert_eq!(frozen.threads[0].title.as_ptr(), title);
        assert_eq!(serde_json::to_vec(&frozen.threads).unwrap(), expected);
    }

    #[tokio::test]
    async fn blocked_snapshot_metadata_does_not_block_thread_reads_or_updates() {
        let temp = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            Default::default(),
            temp.path().join("state.json"),
        );
        let extensions = app.inner.extensions.lock().await;
        let index = app.sync_index_open(None);
        tokio::pin!(index);
        assert!(futures_util::poll!(&mut index).is_pending());
        assert!(
            app.inner.workspaces.try_lock().is_ok(),
            "an optional metadata lock must not hold every thread read/update hostage"
        );
        assert!(app.inner.interactive_requests.try_lock().is_ok());
        drop(extensions);
        index.await.unwrap();
    }

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

    #[test]
    fn hidden_project_rows_wait_for_paging_but_keep_counts_and_selection() {
        let mut source = fixture();
        source.preferences.hidden_workspace_ids = vec!["workspace-0".into(), "workspace-39".into()];
        source.workspaces[0].kind = WorkspaceKind::Casual;
        source.threads.retain(|thread| {
            thread.workspace_id == "workspace-0" || thread.workspace_id == "workspace-39"
        });
        let (index, frozen) = freeze_fixture(source.clone(), None);
        assert!(
            index
                .snapshot
                .threads
                .iter()
                .all(|thread| thread.workspace_id != "workspace-39")
        );
        assert!(
            index
                .snapshot
                .threads
                .iter()
                .any(|thread| thread.workspace_id == "workspace-0")
        );
        assert_eq!(index.counts["workspace-39"].total, 50);
        assert_eq!(
            frozen
                .threads
                .iter()
                .filter(|thread| thread.workspace_id == "workspace-39")
                .count(),
            50
        );

        let (selected, _) = freeze_fixture(source, Some("thread-1999"));
        assert_eq!(selected.snapshot.threads[0].id, "thread-1999");
        assert_eq!(
            selected
                .snapshot
                .threads
                .iter()
                .filter(|thread| thread.workspace_id == "workspace-39")
                .count(),
            1
        );
    }

    #[test]
    fn frozen_pages_cache_each_sort_and_preserve_ordering_and_scope() {
        let mut source = fixture();
        source.threads.truncate(8);
        for (i, thread) in source.threads.iter_mut().enumerate() {
            thread.title = ["z", "Alpha", "alpha", "É", "é", "Beta", "beta", "a"][i].into();
            thread.updated_at += chrono::Duration::seconds((i % 3) as i64);
            thread.is_pinned = i == 5;
            thread.status = if i == 6 {
                ThreadStatus::Running
            } else {
                ThreadStatus::Idle
            };
        }
        let (_, mut view) = freeze_fixture(source, None);
        for sort in ["last_updated", "alphabetical", "priority", "unknown"] {
            let mut expected: Vec<_> = view.threads.iter().collect();
            expected.sort_by(|a, b| {
                let order = match sort {
                    "alphabetical" => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
                    "priority" => priority(a, None)
                        .cmp(&priority(b, None))
                        .then_with(|| b.updated_at.cmp(&a.updated_at)),
                    _ => b.updated_at.cmp(&a.updated_at),
                };
                order.then_with(|| a.id.cmp(&b.id))
            });
            let expected: Vec<_> = expected.iter().map(|t| t.id.clone()).collect();
            for _ in 0..2 {
                let (threads, indices) = view.workspace_rows("workspace-0", sort);
                let actual: Vec<_> = indices.iter().map(|&i| threads[i].id.clone()).collect();
                assert_eq!(actual, expected);
            }
        }
        assert_eq!(view.page_order_builds, 3);
        assert!(view.workspace_rows("missing", "alphabetical").1.is_empty());
        assert_eq!(view.page_order_builds, 3);
    }

    #[tokio::test]
    async fn project_folder_pages_are_bounded_scoped_and_frozen() {
        let temp = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            Default::default(),
            temp.path().join("state.json"),
        );
        let mut source = fixture();
        source
            .preferences
            .project_folders
            .push(falcondeck_core::ProjectFolder {
                id: "chores".into(),
                workspace_id: "workspace-0".into(),
                name: "Chores".into(),
                collapsed: false,
                thread_ids: vec![
                    "thread-3".into(),
                    "thread-40".into(),
                    "thread-49".into(),
                    "thread-1999".into(),
                ],
            });
        let (index, frozen) = freeze_fixture(source, None);
        app.inner
            .sync_indexes
            .lock()
            .await
            .entries
            .push_back(frozen);
        let first = app
            .sync_index_threads(
                &index.token,
                "workspace-0",
                0,
                "alphabetical",
                2,
                Some("chores"),
            )
            .await
            .unwrap();
        assert_eq!(
            first
                .threads
                .iter()
                .map(|thread| thread.id.as_str())
                .collect::<Vec<_>>(),
            ["thread-3", "thread-40"]
        );
        assert_eq!(first.next_cursor, Some(2));
        // A live metadata edit cannot shift the meaning of this cursor.
        app.inner.preferences.lock().await.project_folders.clear();
        let second = app
            .sync_index_threads(
                &index.token,
                "workspace-0",
                2,
                "alphabetical",
                2,
                Some("chores"),
            )
            .await
            .unwrap();
        assert_eq!(
            second
                .threads
                .iter()
                .map(|thread| thread.id.as_str())
                .collect::<Vec<_>>(),
            ["thread-49"]
        );
        assert!(second.next_cursor.is_none());
        assert!(serde_json::to_vec(&second).unwrap().len() <= PAGE_BYTES);
        let foreign = app
            .sync_index_threads(
                &index.token,
                "workspace-39",
                0,
                "alphabetical",
                50,
                Some("chores"),
            )
            .await
            .unwrap();
        assert!(foreign.threads.is_empty());
    }

    fn planned(source: DaemonSnapshot, request: SyncIndexRequest) -> (SyncIndex, FrozenIndex) {
        let mut source = source;
        source.threads = source
            .threads
            .iter()
            .filter(|thread| !thread.is_archived)
            .map(row)
            .collect();
        freeze_with(source, &request)
    }

    fn ids(index: &SyncIndex) -> Vec<&str> {
        index
            .snapshot
            .threads
            .iter()
            .map(|t| t.id.as_str())
            .collect()
    }

    #[tokio::test]
    async fn planned_first_page_ships_the_newest_rows_and_a_matching_cursor() {
        let request = SyncIndexRequest {
            recent_per_workspace: Some(5),
            recent_workspace_ids: vec!["workspace-0".into(), "workspace-1".into()],
            ..Default::default()
        };
        let (index, frozen) = planned(fixture(), request);
        assert_eq!(
            ids(&index).len(),
            10,
            "only the two listed workspaces ship rows: {:?}",
            ids(&index)
        );
        assert_eq!(index.initial_cursors["workspace-0"], Some(5));
        assert_eq!(index.initial_cursors["workspace-1"], Some(5));
        assert_eq!(index.initial_cursors.len(), 2);
        assert_eq!(
            index.counts["workspace-0"].total, 50,
            "counts stay complete"
        );

        // The cursor continues exactly where the prefix ended.
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
        let next = app
            .sync_index_threads(&index.token, "workspace-0", 5, "last_updated", 10, None)
            .await
            .unwrap();
        let shipped: HashSet<_> = index
            .snapshot
            .threads
            .iter()
            .filter(|t| t.workspace_id == "workspace-0")
            .map(|t| t.id.clone())
            .collect();
        assert_eq!(shipped.len(), 5);
        assert!(next.threads.iter().all(|t| !shipped.contains(&t.id)));
        assert_eq!(next.threads.len(), 10);
    }

    #[test]
    fn planned_first_page_keeps_chats_pins_bots_and_attention_but_bounds_the_tail() {
        let mut source = fixture();
        // workspaces 2..=4 are casual chats with 50 rows each; 5 is hidden.
        for n in 2..=4 {
            source.workspaces[n].kind = WorkspaceKind::Casual;
        }
        source.preferences.hidden_workspace_ids = vec!["workspace-5".into()];
        source.threads[149].is_pinned = true; // workspace-2, older than the newest chats
        source.threads[1500].is_pinned_in_project = true; // workspace-30, not listed
        source.threads[1501].status = ThreadStatus::Running;
        source.threads[1502].attention.pending_question_count = 1;
        source.threads[250].status = ThreadStatus::Running; // workspace-5, hidden: skipped
        for thread in source.threads.iter_mut().skip(1600).take(40) {
            thread.attention.unread = true; // 40 unread in workspaces 32..=39
        }
        for thread in source.threads.iter_mut().skip(1700).take(30) {
            thread.status = ThreadStatus::Error;
        }
        source.preferences.bots.push(
            serde_json::from_value(json!({
                "id": "bot-1", "name": "Atlas", "workspace_id": "workspace-39",
                "dedicated_workspace": true, "thread_id": "thread-1999",
                "space_path": "/bots/atlas"
            }))
            .unwrap(),
        );
        let request = SyncIndexRequest {
            selected_thread_id: Some("thread-1250".into()),
            recent_per_workspace: Some(5),
            recent_workspace_ids: vec!["workspace-0".into(), "workspace-5".into()],
            recent_chats: Some(12),
        };
        let (index, _) = planned(source, request);
        let shipped = ids(&index);
        assert_eq!(shipped[0], "thread-1250", "the open thread leads");
        let has = |id: &str| shipped.contains(&id);
        assert!(has("thread-1999"), "bot home");
        assert!(has("thread-149"), "pinned chat");
        assert!(
            has("thread-1500"),
            "pinned in project, even when not listed"
        );
        assert!(has("thread-1501") && has("thread-1502"), "running, waiting");
        assert!(
            !has("thread-250"),
            "hidden project's running row waits for paging"
        );
        // 5 recent for workspace-0 only (workspace-5 is hidden), 12 chats,
        // and bounded unread/failed tails rather than all 40 + 30.
        let in_ws = |ws: &str| {
            index
                .snapshot
                .threads
                .iter()
                .filter(|t| t.workspace_id == ws)
                .count()
        };
        assert_eq!(in_ws("workspace-0"), 5);
        assert_eq!(in_ws("workspace-5"), 0);
        let unread = index
            .snapshot
            .threads
            .iter()
            .filter(|t| t.attention.unread)
            .count();
        let failed = index
            .snapshot
            .threads
            .iter()
            .filter(|t| t.status == ThreadStatus::Error)
            .count();
        assert_eq!((unread, failed), (PLAN_UNREAD_ROWS, PLAN_ERROR_ROWS));
        let chat_rows = ["workspace-2", "workspace-3", "workspace-4"].map(in_ws);
        assert_eq!(
            chat_rows.iter().sum::<usize>(),
            12 + 1,
            "12 newest chats plus the pin"
        );
        // Chat cursors claim only the unbroken newest prefix: the pin does
        // not extend it, and workspaces that shipped nothing still need a page.
        assert_eq!(index.initial_cursors["workspace-2"], Some(12));
        assert!(!index.initial_cursors.contains_key("workspace-3"));
        assert!(!index.initial_cursors.contains_key("workspace-4"));
        assert!(!index.initial_cursors.contains_key("workspace-5"));
        assert_eq!(index.initial_cursors["workspace-0"], Some(5));
        assert!(
            serde_json::to_vec(&index.snapshot.threads).unwrap().len() < 64 * 1024,
            "the planned rows stay small"
        );
    }

    #[test]
    fn small_workspaces_report_an_exhausted_cursor() {
        let mut source = fixture();
        source
            .threads
            .retain(|t| t.workspace_id != "workspace-1" || t.id.ends_with('0'));
        let request = SyncIndexRequest {
            recent_per_workspace: Some(5),
            recent_workspace_ids: vec!["workspace-1".into(), "workspace-missing".into()],
            ..Default::default()
        };
        let (index, _) = planned(source, request);
        assert_eq!(
            index.initial_cursors["workspace-1"], None,
            "nothing left to page"
        );
        assert_eq!(index.initial_cursors["workspace-missing"], None);
        let json = serde_json::to_value(&index).unwrap();
        assert!(json["initial_cursors"]["workspace-1"].is_null());
    }

    /// `FD_SNAPSHOT=/path/to/snapshot.json cargo test -p falcondeck-daemon \
    ///   measure_real_snapshot_index -- --ignored --nocapture`
    /// reads a real `/api/snapshot` body and prints what each index costs.
    #[test]
    #[ignore = "measurement against a captured snapshot"]
    fn measure_real_snapshot_index() {
        let path = std::env::var("FD_SNAPSHOT").expect("FD_SNAPSHOT");
        let mut source: DaemonSnapshot =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        source.threads = source
            .threads
            .iter()
            .filter(|thread| !thread.is_archived)
            .map(row)
            .collect();
        for workspace in &mut source.workspaces {
            workspace.skills.clear();
            for agent in &mut workspace.agents {
                agent.skills.clear();
            }
        }
        let first_project = source
            .workspaces
            .iter()
            .find(|w| {
                w.kind != WorkspaceKind::Casual
                    && source.threads.iter().any(|t| t.workspace_id == w.id)
            })
            .map(|w| w.id.clone())
            .unwrap();
        let size = |index: &SyncIndex| serde_json::to_vec(index).unwrap().len();
        let (legacy, _) = freeze(source.clone(), None);
        let request = SyncIndexRequest {
            recent_per_workspace: Some(5),
            recent_workspace_ids: vec![first_project],
            recent_chats: Some(20),
            ..Default::default()
        };
        let (planned, _) = freeze_with(source.clone(), &request);
        let rows_bytes = serde_json::to_vec(&planned.snapshot.threads).unwrap().len();
        let page_calls_before = source
            .workspaces
            .iter()
            .filter(|w| {
                w.kind == WorkspaceKind::Casual
                    && source.threads.iter().any(|t| t.workspace_id == w.id)
            })
            .count()
            + 1;
        eprintln!(
            "legacy index: {} bytes, {} rows | planned index: {} bytes, {} rows ({} bytes of rows), {} initial cursors | first-sync page calls before: {} after: 0",
            size(&legacy),
            legacy.snapshot.threads.len(),
            size(&planned),
            planned.snapshot.threads.len(),
            rows_bytes,
            planned.initial_cursors.len(),
            page_calls_before,
        );
    }

    #[test]
    fn requests_without_options_are_unchanged() {
        let (index, _) = freeze_fixture(fixture(), Some("thread-1999"));
        assert!(index.initial_cursors.is_empty());
        let json = serde_json::to_value(&index).unwrap();
        assert!(
            json.get("initial_cursors").is_none(),
            "legacy wire shape is identical"
        );
        assert!(
            serde_json::from_value::<SyncIndexRequest>(
                json!({"selected_thread_id": "x", "future": 1})
            )
            .is_ok()
        );
    }

    #[tokio::test]
    async fn large_library_has_bounded_initial_index_and_complete_frozen_pages() {
        let source = fixture();
        let full_size = serde_json::to_vec(&source).unwrap().len();
        let (index, frozen) = freeze_fixture(source, Some("thread-1999"));
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
                .sync_index_threads(
                    &index.token,
                    "workspace-0",
                    cursor,
                    "alphabetical",
                    10,
                    None,
                )
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
        assert_eq!(
            app.inner.sync_indexes.lock().await.entries[0].page_order_builds,
            1,
            "paging a frozen workspace must reuse its order instead of sorting it again"
        );
        // A new view cannot silently change an old page's source.
        let (other, next) = freeze_fixture(fixture(), None);
        app.inner.sync_indexes.lock().await.entries.push_back(next);
        assert_ne!(index.token, other.token);
        assert_eq!(
            app.sync_index_threads(&index.token, "workspace-0", 0, "alphabetical", 10, None)
                .await
                .unwrap()
                .threads[0]
                .title,
            "Thread 0000"
        );
        app.inner.sync_indexes.lock().await.entries[0].created = Instant::now() - CACHE_TTL;
        assert_eq!(
            app.sync_index_threads(&index.token, "workspace-0", 0, "alphabetical", 10, None)
                .await
                .unwrap_err(),
            "sync_index_expired"
        );
    }
}
