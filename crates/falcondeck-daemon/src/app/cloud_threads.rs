//! Cloud execution is an owner of an ordinary thread, not a second inbox.
//! Only a bounded, in-memory projection is kept here; native history and saved
//! exports remain owned by CloudManager and the worker's harness.
use super::*;
use falcondeck_core::{
    CloudJobDetail, CloudJobStatus, InteractiveRequest, InteractiveResponseRequest,
};

#[derive(Default)]
pub(super) struct CloudProjection {
    started: AtomicBool,
    details: Mutex<HashMap<String, CloudJobDetail>>,
}

impl AppState {
    pub(super) fn seed_cloud_sequence(&self, thread: &ThreadSummary) {
        let clock = thread
            .attention
            .last_read_seq
            .max(thread.attention.last_agent_activity_seq);
        self.inner
            .sequence
            .fetch_max(clock.saturating_add(1), Ordering::AcqRel);
    }
    pub(super) fn is_cloud_thread(&self, thread_id: &str) -> bool {
        crate::cloud::manager::job_id(thread_id).is_some()
    }

    pub(super) async fn require_cloud_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, DaemonError> {
        let mut thread = self
            .cloud_manager()
            .thread_summaries()
            .await?
            .into_iter()
            .find(|thread| thread.id == thread_id && thread.workspace_id == workspace_id)
            .ok_or_else(|| DaemonError::NotFound("cloud task not found in this project".into()))?;
        self.seed_cloud_sequence(&thread);
        let counts = self
            .cloud_interactive_requests()
            .await
            .into_iter()
            .filter(|request| {
                request.workspace_id == workspace_id
                    && request.thread_id.as_deref() == Some(thread_id)
            })
            .fold((0, 0), |(approvals, questions), request| {
                let (a, q) = interactive_request_attention_delta(&request.kind);
                (approvals + a, questions + q)
            });
        refresh_thread_attention(&mut thread, counts.0, counts.1);
        Ok(thread)
    }

    pub(super) async fn cloud_source_workspace(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<WorkspaceSummary, DaemonError> {
        self.require_cloud_thread(workspace_id, thread_id).await?;
        self.inner
            .workspaces
            .lock()
            .await
            .get(workspace_id)
            .map(|workspace| workspace.summary.clone())
            .ok_or_else(|| DaemonError::NotFound("source project not found".into()))
    }

    pub(super) async fn start_cloud_thread(
        &self,
        request: StartThreadRequest,
    ) -> Result<ThreadHandle, DaemonError> {
        let workspace = self
            .inner
            .workspaces
            .lock()
            .await
            .get(&request.workspace_id)
            .map(|workspace| workspace.summary.clone())
            .ok_or_else(|| DaemonError::NotFound("source project not found".into()))?;
        let thread = self
            .cloud_manager()
            .start_thread(request, PathBuf::from(&workspace.path))
            .await?;
        self.emit(
            Some(workspace.id.clone()),
            Some(thread.id.clone()),
            UnifiedEvent::ThreadStarted {
                thread: thread.clone(),
            },
        );
        self.start_cloud_observer();
        Ok(ThreadHandle { workspace, thread })
    }

    pub(super) async fn mutate_cloud_thread<F: FnOnce(&mut ThreadSummary)>(
        &self,
        workspace_id: &str,
        thread_id: &str,
        update: F,
    ) -> Result<ThreadSummary, DaemonError> {
        self.require_cloud_thread(workspace_id, thread_id).await?;
        let thread = self
            .cloud_manager()
            .mutate_summary(thread_id, |thread| {
                update(thread);
                let approvals = thread.attention.pending_approval_count;
                let questions = thread.attention.pending_question_count;
                refresh_thread_attention(thread, approvals, questions);
            })
            .await?;
        self.emit(
            Some(workspace_id.into()),
            Some(thread_id.into()),
            UnifiedEvent::ThreadUpdated {
                thread: thread.clone(),
            },
        );
        Ok(thread)
    }

    pub(super) async fn publish_cloud_summary(&self, thread_id: &str) {
        if let Ok(threads) = self.cloud_manager().thread_summaries().await
            && let Some(thread) = threads.into_iter().find(|thread| thread.id == thread_id)
        {
            self.emit(
                Some(thread.workspace_id.clone()),
                Some(thread_id.into()),
                UnifiedEvent::ThreadUpdated { thread },
            );
        }
    }

    pub(super) async fn cloud_interactive_requests(&self) -> Vec<InteractiveRequest> {
        self.inner
            .cloud_projection
            .details
            .lock()
            .await
            .values()
            .filter(|detail| detail.is_live)
            .flat_map(|detail| detail.interactive_requests.clone())
            .collect()
    }

    async fn fetch_cloud_detail(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<CloudJobDetail, DaemonError> {
        let workspace = self.cloud_source_workspace(workspace_id, thread_id).await?;
        let mut detail = match self.cloud_manager().thread_detail(thread_id).await {
            Ok(detail) => detail,
            Err(error) => {
                let thread = self.require_cloud_thread(workspace_id, thread_id).await?;
                if thread.native_session_id.is_some()
                    || thread.latest_turn_id.is_some()
                    || !thread.cloud.as_ref().is_some_and(|cloud| {
                        matches!(
                            cloud.status,
                            CloudJobStatus::Provisioning
                                | CloudJobStatus::Stopping
                                | CloudJobStatus::Stopped
                                | CloudJobStatus::Failed
                                | CloudJobStatus::Unknown
                        )
                    })
                {
                    return Err(error);
                }
                // A newly created cloud thread is already navigable before
                // allocation and the first native turn have completed.
                CloudJobDetail {
                    detail: ThreadDetail {
                        workspace: workspace.clone(),
                        thread,
                        items: vec![],
                        has_older: false,
                        oldest_item_id: None,
                        newest_item_id: None,
                        is_partial: false,
                    },
                    interactive_requests: vec![],
                    is_live: false,
                    collected_at: None,
                }
            }
        };
        detail.detail.workspace = workspace;
        namespace_requests(&mut detail, workspace_id, thread_id);
        Ok(detail)
    }

    pub(super) async fn cloud_thread_detail(
        &self,
        request: &ThreadDetailRequest,
    ) -> Result<ThreadDetail, DaemonError> {
        let detail = self
            .fetch_cloud_detail(&request.workspace_id, &request.thread_id)
            .await?;
        self.observe_cloud_detail(detail.clone()).await;
        let mut detail = self
            .inner
            .cloud_projection
            .details
            .lock()
            .await
            .get(&request.thread_id)
            .map(|detail| detail.detail.clone())
            .unwrap_or(detail.detail);
        let window = workspace_ops::thread_detail_window(&detail.items, request)?;
        detail.items = window.items;
        detail.has_older = window.has_older;
        detail.oldest_item_id = window.oldest_item_id;
        detail.newest_item_id = window.newest_item_id;
        detail.is_partial = window.is_partial;
        if request.compact_workspace.unwrap_or(false) {
            detail.workspace = snapshot_projection::workspace(&detail.workspace, true);
        }
        Ok(detail)
    }

    pub(super) async fn respond_to_cloud_request(
        &self,
        workspace_id: &str,
        thread_id: &str,
        request_id: &str,
        response: InteractiveResponsePayload,
    ) -> Result<CommandResponse, DaemonError> {
        // Recheck the current worker, rather than answering a cached approval
        // after its process has gone away or its compute has stopped.
        let detail = self.fetch_cloud_detail(workspace_id, thread_id).await?;
        let public_id = format!("{thread_id}/{request_id}");
        if !detail.is_live
            || !detail
                .interactive_requests
                .iter()
                .any(|request| request.request_id == public_id)
        {
            return Err(DaemonError::Conflict(
                "This cloud request is no longer live. Refresh the task before answering.".into(),
            ));
        }
        let result = self
            .cloud_manager()
            .respond(
                crate::cloud::manager::job_id(thread_id).unwrap(),
                request_id,
                false,
                serde_json::to_value(InteractiveResponseRequest { response })?,
            )
            .await?;
        self.poll_cloud_thread(workspace_id, thread_id).await;
        Ok(result)
    }

    pub(super) fn start_cloud_observer(&self) {
        if self
            .inner
            .cloud_projection
            .started
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let app = self.clone();
        self.spawn_background_task(async move {
            while app
                .sleep_unless_shutting_down(std::time::Duration::from_secs(2))
                .await
            {
                let Ok(threads) = app.cloud_manager().thread_summaries().await else {
                    continue;
                };
                for thread in threads {
                    if app.is_shutting_down() {
                        return;
                    }
                    // Stopped exports are immutable. Poll them again only after
                    // a lifecycle change, not on every sidebar refresh.
                    let cached = app
                        .inner
                        .cloud_projection
                        .details
                        .lock()
                        .await
                        .get(&thread.id)
                        .cloned();
                    let stopped = thread.cloud.as_ref().is_some_and(|cloud| {
                        matches!(
                            cloud.status,
                            CloudJobStatus::Stopped | CloudJobStatus::Expired
                        )
                    });
                    if stopped
                        && cached
                            .as_ref()
                            .is_some_and(|detail| detail.detail.thread == thread && !detail.is_live)
                    {
                        continue;
                    }
                    app.poll_cloud_thread(&thread.workspace_id, &thread.id)
                        .await;
                }
            }
        });
    }

    async fn poll_cloud_thread(&self, workspace_id: &str, thread_id: &str) {
        match self.fetch_cloud_detail(workspace_id, thread_id).await {
            Ok(detail) => self.observe_cloud_detail(detail).await,
            Err(_) => {
                // Provider reconciliation owns sanitized errors. Never turn a
                // failed cloud read into a local-thread lookup or new worker.
                let had_requests = {
                    let mut cache = self.inner.cloud_projection.details.lock().await;
                    if let Some(detail) = cache.get_mut(thread_id) {
                        let had_requests =
                            detail.is_live && !detail.interactive_requests.is_empty();
                        detail.is_live = false;
                        had_requests
                    } else {
                        false
                    }
                };
                self.publish_cloud_summary(thread_id).await;
                if had_requests {
                    self.emit(
                        Some(workspace_id.into()),
                        Some(thread_id.into()),
                        UnifiedEvent::Snapshot {
                            snapshot: self.snapshot().await,
                        },
                    );
                }
            }
        }
    }

    async fn observe_cloud_detail(&self, mut detail: CloudJobDetail) {
        self.seed_cloud_sequence(&detail.detail.thread);
        let id = detail.detail.thread.id.clone();
        let workspace_id = detail.detail.thread.workspace_id.clone();
        let old = self
            .inner
            .cloud_projection
            .details
            .lock()
            .await
            .get(&id)
            .cloned();
        let old_items = old
            .as_ref()
            .map(|old| old.detail.items.as_slice())
            .unwrap_or_default();
        let agent_changed = detail.detail.items.iter().any(|item| {
            !matches!(
                item,
                ConversationItem::UserMessage { .. } | ConversationItem::Service { .. }
            ) && old_items.iter().find(|old| {
                workspace_ops::conversation_item_id(old)
                    == workspace_ops::conversation_item_id(item)
            }) != Some(item)
        });
        if agent_changed {
            // The native worker and coordinator have different sequence clocks.
            // Read receipts must use the same clock as this event stream.
            let activity_seq = self.inner.sequence.load(Ordering::Acquire);
            if let Ok(thread) = self
                .cloud_manager()
                .mutate_summary(&id, |thread| {
                    thread.attention.last_agent_activity_seq = activity_seq;
                })
                .await
            {
                detail.detail.thread.attention.last_agent_activity_seq =
                    thread.attention.last_agent_activity_seq;
            }
        }
        let counts = detail
            .interactive_requests
            .iter()
            .filter(|_| detail.is_live)
            .fold((0, 0), |(approvals, questions), request| {
                let (a, q) = interactive_request_attention_delta(&request.kind);
                (approvals + a, questions + q)
            });
        refresh_thread_attention(&mut detail.detail.thread, counts.0, counts.1);
        let attention = detail.detail.thread.attention.clone();
        let _ = self
            .cloud_manager()
            .mutate_summary(&id, |thread| thread.attention = attention)
            .await;
        self.inner
            .cloud_projection
            .details
            .lock()
            .await
            .insert(id.clone(), detail.clone());
        for item in &detail.detail.items {
            let previous = old_items.iter().find(|old| {
                workspace_ops::conversation_item_id(old)
                    == workspace_ops::conversation_item_id(item)
            });
            let event = match previous {
                Some(previous) if previous == item => continue,
                Some(_) => UnifiedEvent::ConversationItemUpdated { item: item.clone() },
                None => UnifiedEvent::ConversationItemAdded { item: item.clone() },
            };
            self.emit(Some(workspace_id.clone()), Some(id.clone()), event);
        }
        if old
            .as_ref()
            .is_none_or(|old| old.detail.thread != detail.detail.thread)
        {
            self.emit(
                Some(workspace_id.clone()),
                Some(id.clone()),
                UnifiedEvent::ThreadUpdated {
                    thread: detail.detail.thread.clone(),
                },
            );
        }
        let old_requests = old
            .as_ref()
            .filter(|old| old.is_live)
            .map(|old| old.interactive_requests.as_slice())
            .unwrap_or_default();
        let requests = if detail.is_live {
            detail.interactive_requests.as_slice()
        } else {
            &[]
        };
        if old_requests != requests {
            for request in requests {
                if !old_requests.contains(request) {
                    self.emit(
                        Some(workspace_id.clone()),
                        Some(id.clone()),
                        UnifiedEvent::InteractiveRequest {
                            request: request.clone(),
                        },
                    );
                }
            }
            // The ordinary snapshot reducer removes resolved or lost approvals
            // even if the native harness did not retain a matching item.
            self.emit(
                Some(workspace_id),
                Some(id),
                UnifiedEvent::Snapshot {
                    snapshot: self.snapshot().await,
                },
            );
        }
    }
}

fn namespace_requests(detail: &mut CloudJobDetail, workspace_id: &str, thread_id: &str) {
    let remap = |request: &mut InteractiveRequest| {
        if !request.request_id.starts_with(&format!("{thread_id}/")) {
            request.request_id = format!("{thread_id}/{}", request.request_id);
        }
        request.workspace_id = workspace_id.into();
        request.thread_id = Some(thread_id.into());
    };
    for request in &mut detail.interactive_requests {
        remap(request);
    }
    for item in &mut detail.detail.items {
        if let ConversationItem::InteractiveRequest { request, .. } = item {
            remap(request);
        }
    }
}

#[cfg(test)]
mod tests;
