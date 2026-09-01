use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use falcondeck_core::{ConversationItem, UnifiedEvent};
use tokio::sync::mpsc;

use super::{AppState, extension_host::ExtensionEvent, extensions::ExtensionPackage};

pub(super) const MAX_QUEUED_EVENTS_PER_EXTENSION: usize = 256;

pub(super) struct ExtensionEventQueue {
    sender: mpsc::Sender<ExtensionEvent>,
    cancelled: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
}

impl ExtensionEventQueue {
    fn enqueue(&self, event: ExtensionEvent) {
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        match self.sender.try_send(event) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                let dropped = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                tracing::warn!(
                    dropped,
                    queue_limit = MAX_QUEUED_EVENTS_PER_EXTENSION,
                    "dropping newest extension event because its queue is full"
                );
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

pub(super) type ExtensionEventQueues = StdMutex<HashMap<String, ExtensionEventQueue>>;

impl AppState {
    pub(super) fn enqueue_extension_event(&self, event: ExtensionEvent) {
        let queues = self
            .inner
            .extension_event_queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for queue in queues.values() {
            queue.enqueue(event.clone());
        }
    }

    /// Delivers a capability-specific event only to its owning extension.
    /// Orchestration run identifiers and update cadence are not broadcast to
    /// unrelated extensions.
    pub(super) fn enqueue_extension_event_for(&self, extension_id: &str, event: ExtensionEvent) {
        let queues = self
            .inner
            .extension_event_queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(queue) = queues.get(extension_id) {
            queue.enqueue(event);
        }
    }

    pub(super) async fn sync_extension_event_workers(&self) {
        let packages = self.inner.extensions.lock().await.enabled_packages();
        let enabled_ids = packages
            .iter()
            .map(|package| package.id.as_str())
            .collect::<HashSet<_>>();
        let mut queues = self
            .inner
            .extension_event_queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        queues.retain(|extension_id, queue| {
            let retained = enabled_ids.contains(extension_id.as_str());
            if !retained {
                queue.cancel();
            }
            retained
        });

        for package in packages {
            if queues.contains_key(&package.id) {
                continue;
            }
            let (sender, receiver) = mpsc::channel(MAX_QUEUED_EVENTS_PER_EXTENSION);
            let cancelled = Arc::new(AtomicBool::new(false));
            let dropped = Arc::new(AtomicU64::new(0));
            queues.insert(
                package.id.clone(),
                ExtensionEventQueue {
                    sender,
                    cancelled: cancelled.clone(),
                    dropped,
                },
            );
            let app = self.clone();
            tokio::spawn(run_extension_event_worker(
                app, package, receiver, cancelled,
            ));
        }
    }

    pub(super) fn stop_extension_event_workers(&self) {
        let mut queues = self
            .inner
            .extension_event_queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for queue in queues.values() {
            queue.cancel();
        }
        queues.clear();
    }
}

pub(super) fn lifecycle_event(
    workspace_id: Option<&str>,
    thread_id: Option<&str>,
    event: &UnifiedEvent,
) -> Option<ExtensionEvent> {
    match event {
        UnifiedEvent::ThreadUpdated { thread } => Some(ExtensionEvent::ThreadUpdated {
            workspace_id: thread.workspace_id.clone(),
            thread_id: thread.id.clone(),
        }),
        UnifiedEvent::TurnStart { turn_id } => Some(ExtensionEvent::TurnStarted {
            workspace_id: workspace_id?.to_string(),
            thread_id: thread_id?.to_string(),
            turn_id: turn_id.clone(),
        }),
        UnifiedEvent::TurnEnd { turn_id, .. } => Some(ExtensionEvent::TurnEnded {
            workspace_id: workspace_id?.to_string(),
            thread_id: thread_id?.to_string(),
            turn_id: turn_id.clone(),
        }),
        UnifiedEvent::InteractiveRequest { request } => Some(ExtensionEvent::AttentionOpened {
            workspace_id: request.workspace_id.clone(),
            thread_id: request.thread_id.clone(),
            request_id: request.request_id.clone(),
        }),
        UnifiedEvent::ConversationItemUpdated {
            item:
                ConversationItem::InteractiveRequest {
                    id,
                    request,
                    resolved: true,
                    ..
                },
        } => Some(ExtensionEvent::AttentionResolved {
            workspace_id: request.workspace_id.clone(),
            thread_id: request.thread_id.clone(),
            request_id: id.clone(),
        }),
        UnifiedEvent::ControlStateChanged { change }
            if change
                .domains
                .contains(&falcondeck_core::control::ControlDomain::Automations)
                || change
                    .domains
                    .contains(&falcondeck_core::control::ControlDomain::Runs) =>
        {
            Some(ExtensionEvent::AutomationsUpdated)
        }
        _ => None,
    }
}

async fn run_extension_event_worker(
    app: AppState,
    package: ExtensionPackage,
    mut receiver: mpsc::Receiver<ExtensionEvent>,
    cancelled: Arc<AtomicBool>,
) {
    while let Some(event) = receiver.recv().await {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let host = app.inner.extension_hosts.lock().await.host(&package.id);
        let mut host = host.lock().await;
        let (storage, can_read_threads, can_orchestrate, can_manage_automations) = {
            let registry = app.inner.extensions.lock().await;
            if !registry.is_enabled(&package.id) {
                continue;
            }
            (
                registry.storage(&package.id),
                registry.has_grant(&package.id, super::extensions::THREADS_READ_PERMISSION),
                registry.has_grant(&package.id, super::extensions::ORCHESTRATION_PERMISSION),
                registry.has_grant(&package.id, super::extensions::AUTOMATIONS_PERMISSION),
            )
        };
        let thread_summaries = if can_read_threads {
            Some(app.extension_thread_summaries().await)
        } else {
            None
        };
        let orchestration_runs = if can_orchestrate {
            Some(super::orchestration::owned_runs(&app, &package.id).await)
        } else {
            None
        };
        let owned_automations = if can_manage_automations {
            Some(app.control().owned_automations(&package.id).await)
        } else {
            None
        };
        let result = host
            .dispatch_event(
                &package,
                &event,
                &storage,
                thread_summaries.as_deref(),
                orchestration_runs.as_deref(),
                owned_automations.as_deref(),
            )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                mark_extension_event_error(&app, &package.id, &error.to_string()).await;
                continue;
            }
        };
        if cancelled.load(Ordering::Acquire)
            || !app.inner.extensions.lock().await.is_enabled(&package.id)
        {
            continue;
        }
        if !result.orchestration_effects.is_empty() {
            mark_extension_event_error(
                &app,
                &package.id,
                "orchestration effects are not accepted from lossy lifecycle events",
            )
            .await;
            continue;
        }
        if !result.automation_effects.is_empty() {
            mark_extension_event_error(
                &app,
                &package.id,
                "Automation effects are not accepted from lossy lifecycle events",
            )
            .await;
            continue;
        }
        let updated_views = match app
            .inner
            .extensions
            .lock()
            .await
            .commit_action(&package.id, result.storage, result.published_views)
            .await
        {
            Ok(updated_views) => updated_views,
            Err(error) => {
                mark_extension_event_error(&app, &package.id, &error.to_string()).await;
                continue;
            }
        };
        drop(host);
        for view in updated_views {
            app.emit(
                None,
                view.scope
                    .as_ref()
                    .filter(|scope| scope.kind == "thread")
                    .map(|scope| scope.id.clone()),
                UnifiedEvent::ExtensionViewUpdated {
                    extension_id: view.extension_id.clone(),
                    view_id: view.view_id.clone(),
                    scope: view.scope.clone(),
                    view: Some(view),
                },
            );
        }
    }
}

async fn mark_extension_event_error(app: &AppState, extension_id: &str, error: &str) {
    if let Err(persist_error) = app
        .inner
        .extensions
        .lock()
        .await
        .mark_error(extension_id, error)
        .await
    {
        tracing::warn!(%persist_error, %extension_id, "failed to record extension event error");
        return;
    }
    let catalog = app.inner.extensions.lock().await.snapshot().catalog;
    app.emit(
        None,
        None,
        UnifiedEvent::ExtensionCatalogUpdated { catalog },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread_event(index: usize) -> ExtensionEvent {
        ExtensionEvent::ThreadUpdated {
            workspace_id: "workspace-1".to_string(),
            thread_id: format!("thread-{index}"),
        }
    }

    #[tokio::test]
    async fn queue_is_bounded_and_drops_the_newest_event() {
        let (sender, mut receiver) = mpsc::channel(MAX_QUEUED_EVENTS_PER_EXTENSION);
        let dropped = Arc::new(AtomicU64::new(0));
        let queue = ExtensionEventQueue {
            sender,
            cancelled: Arc::new(AtomicBool::new(false)),
            dropped: dropped.clone(),
        };
        for index in 0..=MAX_QUEUED_EVENTS_PER_EXTENSION {
            queue.enqueue(thread_event(index));
        }

        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        assert_eq!(receiver.recv().await, Some(thread_event(0)));
        let mut last = None;
        while let Ok(event) = receiver.try_recv() {
            last = Some(event);
        }
        assert_eq!(
            last,
            Some(thread_event(MAX_QUEUED_EVENTS_PER_EXTENSION - 1))
        );
    }

    #[test]
    fn public_events_serialize_only_lifecycle_identifiers() {
        let event = ExtensionEvent::AttentionOpened {
            workspace_id: "workspace-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            request_id: "request-1".to_string(),
        };

        assert_eq!(
            serde_json::to_value(event).expect("event should serialize"),
            serde_json::json!({
                "type": "attention.opened",
                "workspaceId": "workspace-1",
                "threadId": "thread-1",
                "requestId": "request-1",
            })
        );

        let run_event = ExtensionEvent::OrchestrationUpdated {
            workspace_id: "workspace-1".to_string(),
            run_id: "run-1".to_string(),
        };
        assert_eq!(
            serde_json::to_value(run_event).expect("run event should serialize"),
            serde_json::json!({
                "type": "orchestration.updated",
                "workspaceId": "workspace-1",
                "runId": "run-1",
            })
        );
    }

    #[tokio::test]
    async fn workers_follow_daemon_owned_enablement() {
        let state_dir = tempfile::tempdir().expect("temporary daemon state");
        let app = AppState::new_with_state_path(
            "test".to_string(),
            HashMap::new(),
            state_dir.path().join("state.json"),
        );
        app.restore_local_state()
            .await
            .expect("extension registry should restore");

        {
            let queues = app
                .inner
                .extension_event_queues
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(queues.contains_key("falcondeck.thread-tags"));
            assert!(!queues.contains_key("falcondeck.mini-zen"));
        }

        app.update_extension("falcondeck.mini-zen", true)
            .await
            .expect("Mini Zen should enable");
        assert!(
            app.inner
                .extension_event_queues
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key("falcondeck.mini-zen")
        );

        app.update_extension("falcondeck.mini-zen", false)
            .await
            .expect("Mini Zen should disable");
        assert!(
            !app.inner
                .extension_event_queues
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key("falcondeck.mini-zen")
        );
        app.shutdown().await.expect("test daemon should stop");
    }
}
