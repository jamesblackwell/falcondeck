//! Event-driven variant cleanup. Never inventories existing threads at startup.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct Eligibility {
    pub completed_at: chrono::DateTime<Utc>,
    pub eligible_after: chrono::DateTime<Utc>,
}

pub(super) const GRACE: std::time::Duration = std::time::Duration::from_secs(72 * 60 * 60);

fn eligible(
    t: &ManagedThread,
    completed: chrono::DateTime<Utc>,
    now: chrono::DateTime<Utc>,
) -> bool {
    t.variant_reap
        .as_ref()
        .is_some_and(|e| e.completed_at == completed && e.eligible_after <= now)
        && (now - completed).to_std().is_ok_and(|age| age >= GRACE)
        && t.summary.status == ThreadStatus::Idle
        && !t.summary.is_pinned
        && !t.summary.is_pinned_in_project
        && t.summary.queued_turns.is_empty()
        && t.queued_requests.is_empty()
        && t.dispatching_request.is_none()
}

impl AppState {
    pub(super) async fn variant_gate(&self, workspace: &str, thread: &str) -> Arc<Mutex<()>> {
        self.inner
            .variant_gates
            .lock()
            .await
            .entry((workspace.to_string(), thread.to_string()))
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(super) async fn restore_variant_for_turn(
        &self,
        workspace: &str,
        thread: &str,
    ) -> Result<Option<String>, DaemonError> {
        let target = {
            let workspaces = self.inner.workspaces.lock().await;
            workspaces.get(workspace).and_then(|w| {
                w.threads
                    .get(thread)
                    .and_then(|t| t.summary.variant.clone())
                    .map(|v| (w.summary.path.clone(), v))
            })
        };
        let Some((project, variant)) = target else {
            return Ok(None);
        };
        if crate::variant::restore(&project, &variant)
            .await
            .map_err(DaemonError::Rpc)?
        {
            self.with_managed_thread_mut(workspace, thread, |t| t.variant_reap = None)
                .await?;
            self.persist_local_state().await?;
            self.inner
                .variant_dependency_watches
                .lock()
                .await
                .remove(&(workspace.to_string(), thread.to_string()));
        }
        self.watch_variant_dependencies(workspace, thread).await;
        Ok(crate::variant::sparse_hint(&project, &variant.path).await)
    }

    pub(super) async fn recover_variant_preparations(&self) {
        let preparing = {
            let ws = self.inner.workspaces.lock().await;
            ws.iter()
                .flat_map(|(workspace, w)| {
                    w.threads
                        .iter()
                        .filter(|(_, t)| t.queued_requests.iter().any(|q| q.preparing_variant))
                        .map(move |(thread, _)| (workspace.clone(), thread.clone()))
                })
                .collect::<Vec<_>>()
        };
        for (workspace, thread) in preparing {
            self.watch_variant_dependencies(&workspace, &thread).await;
        }
    }

    pub(super) async fn watch_variant_dependencies(&self, workspace: &str, thread: &str) {
        let target = {
            let ws = self.inner.workspaces.lock().await;
            ws.get(workspace)
                .and_then(|w| w.threads.get(thread))
                .and_then(|t| {
                    t.summary.variant.as_ref().map(|v| {
                        (
                            v.path.clone(),
                            t.queued_requests.iter().any(|q| q.preparing_variant),
                        )
                    })
                })
        };
        let Some((path, preparing)) = target else {
            return;
        };
        if !crate::variant::has_dependency_job(&path) {
            if !preparing {
                return;
            }
            crate::variant::interrupt_missing_dependency_job(&path);
        }
        let key = (workspace.to_string(), thread.to_string());
        if !self
            .inner
            .variant_dependency_watches
            .lock()
            .await
            .insert(key.clone())
        {
            return;
        }
        let _ = self.upsert_scoped_operational_condition(workspace.to_string(), Some(thread.to_string()), "variant-dependencies",
            ServiceLevel::Info, "Preparing isolated checkout dependencies in the background; queued turns wait until ready.".into(), Some("variant-setup".into()));
        let app = self.clone();
        self.spawn_background_task(async move {
            app.finish_variant_dependencies(&key.0, &key.1, &path).await;
            // Keep the watch key until a new restore starts a new job, so
            // repeated file views do not repeat a completed cold-fallback notice.
        });
    }

    pub(super) async fn finish_variant_dependencies(
        &self,
        workspace: &str,
        thread: &str,
        path: &str,
    ) {
        let messages = crate::variant::wait_dependencies(path).await;
        if messages.is_empty() {
            self.clear_scoped_operational_condition(
                workspace,
                Some(thread),
                "variant-dependencies",
            );
        } else {
            let _ = self.upsert_scoped_operational_condition(
                workspace.to_string(),
                Some(thread.to_string()),
                "variant-dependencies",
                ServiceLevel::Warning,
                messages.join("\n"),
                Some("variant-setup".into()),
            );
        }
    }

    pub(super) async fn checkout_guard(
        &self,
        workspace: &str,
        thread: Option<&str>,
    ) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        if let Some(thread) = thread {
            Some(
                self.variant_gate(workspace, thread)
                    .await
                    .lock_owned()
                    .await,
            )
        } else {
            None
        }
    }

    /// Only a successful completion observed by this version creates eligibility.
    /// Older persisted threads have None and never enter automatic cleanup.
    pub(super) async fn schedule_variant_reap(&self, workspace: &str, thread: &str) {
        {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(t) = workspaces
                .get_mut(workspace)
                .and_then(|w| w.threads.get_mut(thread))
            else {
                return;
            };
            if t.summary.variant.is_none()
                || t.summary.status != ThreadStatus::Idle
                || !t
                    .turn_started_at
                    .is_some_and(|started| started >= self.inner.daemon.started_at)
            {
                return;
            }
            t.variant_reap = Some(Eligibility {
                completed_at: t.summary.updated_at,
                eligible_after: t.summary.updated_at + chrono::Duration::hours(72),
            });
        }
        if let Err(e) = self.persist_local_state().await {
            tracing::warn!(%e, "failed to persist variant cleanup eligibility");
            // Without a durable opt-in, this completion does not authorize reaping.
            let _ = self
                .with_managed_thread_mut(workspace, thread, |t| t.variant_reap = None)
                .await;
        }
    }

    pub(super) fn start_variant_maintenance(&self) {
        if self
            .inner
            .variant_maintenance_started
            .swap(true, Ordering::Relaxed)
        {
            return;
        }
        let app = self.clone();
        self.spawn_background_task(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    () = app.wait_for_shutdown() => return,
                    _ = tick.tick() => {}
                }
                if app.is_shutting_down() {
                    return;
                }
                app.check_variant_disk("").await;
                if app
                    .inner
                    .variant_reap_tick_running
                    .swap(true, Ordering::Relaxed)
                {
                    continue;
                }
                let cleanup = app.clone();
                app.spawn_background_task(async move {
                    cleanup.variant_maintenance_tick(Utc::now()).await;
                    cleanup
                        .inner
                        .variant_reap_tick_running
                        .store(false, Ordering::Relaxed);
                });
            }
        });
    }

    pub(super) async fn variant_maintenance_tick(&self, now: chrono::DateTime<Utc>) {
        let eligible = {
            let ws = self.inner.workspaces.lock().await;
            ws.iter()
                .flat_map(|(wid, w)| {
                    w.threads.iter().filter_map(move |(tid, t)| {
                        t.variant_reap
                            .as_ref()
                            .filter(|e| e.eligible_after <= now)
                            .map(|e| (wid.clone(), tid.clone(), e.completed_at))
                    })
                })
                .take(4)
                .collect::<Vec<_>>()
        };
        let had_eligible = !eligible.is_empty();
        for (workspace, thread, completed) in eligible {
            let result = self
                .reap_finished_variant(&workspace, &thread, completed, now)
                .await;
            let _ = self
                .with_managed_thread_mut(&workspace, &thread, |t| {
                    if t.variant_reap
                        .as_ref()
                        .is_some_and(|e| e.completed_at == completed)
                    {
                        match result {
                            Some(crate::variant::Reclaim::Kept(_)) => {
                                if let Some(e) = t.variant_reap.as_mut() {
                                    e.eligible_after = now + chrono::Duration::hours(6);
                                }
                            }
                            _ => t.variant_reap = None,
                        }
                    }
                })
                .await;
        }
        if had_eligible {
            let _ = self.persist_local_state().await;
        }
    }

    pub(super) async fn reap_finished_variant(
        &self,
        workspace_id: &str,
        thread_id: &str,
        completed: chrono::DateTime<Utc>,
        now: chrono::DateTime<Utc>,
    ) -> Option<crate::variant::Reclaim> {
        let (project, variant) = {
            let workspaces = self.inner.workspaces.lock().await;
            let w = workspaces.get(workspace_id)?;
            let t = w.threads.get(thread_id)?;
            if !eligible(t, completed, now) {
                return None;
            }
            (w.summary.path.clone(), t.summary.variant.clone()?)
        };
        let assessment = match crate::variant::assess(&project, &variant).await {
            Ok(assessment) => assessment,
            Err(result) => return Some(result),
        };
        let gate = self.variant_gate(workspace_id, thread_id).await;
        let _guard = gate.lock().await;
        {
            let ws = self.inner.workspaces.lock().await;
            let t = ws.get(workspace_id)?.threads.get(thread_id)?;
            if !eligible(t, completed, now) || t.summary.variant.as_ref() != Some(&variant) {
                return None;
            }
        }
        let result = crate::variant::finish_reclaim(&project, &variant, assessment).await;
        tracing::info!(thread_id, path = %variant.path, ?result, "finished-thread checkout reclaim");
        Some(result)
    }

    pub(super) async fn check_variant_disk(&self, workspace_id: &str) {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let path = std::path::PathBuf::from(home).join(".falcondeck");
        let Some(bytes) = crate::variant::available_disk(&path).await else {
            return;
        };
        self.note_variant_disk(workspace_id, bytes).await;
    }

    async fn note_variant_disk(&self, _workspace_id: &str, bytes: u64) {
        use falcondeck_core::notifications::{NotificationImportance, NotificationKind};
        let _guard = self.inner.variant_disk_gate.lock().await;
        let marker = self.inner.state_path.with_extension("disk-pressure");
        if bytes >= 30 * 1024 * 1024 * 1024 {
            if let Ok(key) = tokio::fs::read_to_string(&marker).await {
                if self.inner.notifications.resolve(&key, Utc::now()).await {
                    self.emit_notifications_changed().await;
                }
                let _ = tokio::fs::remove_file(marker).await;
            }
            self.inner.variant_disk_low.store(false, Ordering::Relaxed);
            return;
        }
        if bytes >= 25 * 1024 * 1024 * 1024 {
            return;
        }
        let key = match tokio::fs::read_to_string(&marker).await {
            Ok(key) => key,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let key = format!("storage-pressure:{}", Uuid::new_v4());
                if let Some(parent) = marker.parent() {
                    if tokio::fs::create_dir_all(parent).await.is_err() {
                        return;
                    }
                }
                let temp = marker.with_extension(format!("{}.tmp", Uuid::new_v4()));
                if tokio::fs::write(&temp, &key).await.is_err() {
                    return;
                }
                if tokio::fs::rename(&temp, &marker).await.is_err() {
                    let _ = tokio::fs::remove_file(temp).await;
                    return;
                }
                key
            }
            Err(_) => return,
        };
        let result = self.inner.notifications.record(crate::notification_store::NewNotification {
            kind: NotificationKind::AgentNotice,
            title: "Storage is running low".into(),
            preview: format!("{:.1} GiB available. Review retained isolated checkouts before creating more.", bytes as f64 / 1073741824.0),
            body: None, bot: None, thread_id: None, workspace_id: None, target: None,
            importance: NotificationImportance::Normal, dedupe_key: Some(key), coalesce: false, sender: None,
        }, Utc::now()).await;
        self.inner.variant_disk_low.store(true, Ordering::Relaxed);
        if matches!(result, crate::notification_store::Recorded::Created(_)) {
            self.emit_notifications_changed().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_wakes_variant_maintenance_between_ticks() {
        let root = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            root.path().join("state.json"),
        );
        // Hold the empty cleanup worker so its registration proves the
        // immediate tick finished and maintenance reached its interval wait.
        let workspaces = app.inner.workspaces.lock().await;
        app.start_variant_maintenance();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if app
                    .inner
                    .background_tasks
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len()
                    >= 2
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("maintenance must complete its initial tick");
        drop(workspaces);
        tokio::time::timeout(std::time::Duration::from_secs(2), app.shutdown())
            .await
            .expect("shutdown must wake maintenance without its 300-second tick")
            .unwrap();
    }

    #[tokio::test]
    async fn low_disk_warning_emits_once_per_crossing() {
        let root = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            root.path().join("state.json"),
        );
        let mut events = app.inner.broadcaster.subscribe();
        app.note_variant_disk("workspace", 24 * 1024 * 1024 * 1024)
            .await;
        assert!(events.try_recv().is_ok());
        while events.try_recv().is_ok() {}
        app.note_variant_disk("workspace", 23 * 1024 * 1024 * 1024)
            .await;
        assert!(events.try_recv().is_err());
        app.note_variant_disk("workspace", 31 * 1024 * 1024 * 1024)
            .await;
        while events.try_recv().is_ok() {}
        assert!(!app.inner.variant_disk_low.load(Ordering::Relaxed));
        app.note_variant_disk("workspace", 24 * 1024 * 1024 * 1024)
            .await;
        assert!(events.try_recv().is_ok());
    }
    #[tokio::test]
    async fn disk_warning_is_global_persists_across_restart_and_rearms_only_above_thirty_gib() {
        use falcondeck_core::notifications::NotificationListRequest;
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state.json");
        let app = AppState::new_with_state_path("test".into(), HashMap::new(), state.clone());
        app.note_variant_disk("project-a", 24 * 1024 * 1024 * 1024)
            .await;
        let first = app
            .notifications_list(&NotificationListRequest::default())
            .await;
        assert_eq!(first.items.len(), 1);
        assert!(first.items[0].workspace_id.is_none());
        drop(app);
        let restarted = AppState::new_with_state_path("test".into(), HashMap::new(), state);
        restarted
            .note_variant_disk("project-b", 23 * 1024 * 1024 * 1024)
            .await;
        restarted
            .note_variant_disk("project-b", 27 * 1024 * 1024 * 1024)
            .await;
        restarted
            .note_variant_disk("project-b", 24 * 1024 * 1024 * 1024)
            .await;
        assert_eq!(
            restarted
                .notifications_list(&NotificationListRequest::default())
                .await
                .items
                .len(),
            1
        );
        restarted
            .note_variant_disk("project-b", 31 * 1024 * 1024 * 1024)
            .await;
        restarted
            .note_variant_disk("project-b", 24 * 1024 * 1024 * 1024)
            .await;
        assert_eq!(
            restarted
                .notifications_list(&NotificationListRequest::default())
                .await
                .items
                .len(),
            2
        );
    }
}
