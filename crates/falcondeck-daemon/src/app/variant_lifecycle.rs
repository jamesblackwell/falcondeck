//! Event-driven variant cleanup. Never inventories existing threads at startup.
use super::*;

pub(super) const GRACE: std::time::Duration = std::time::Duration::from_secs(72 * 60 * 60);

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
        crate::variant::restore(&project, &variant)
            .await
            .map_err(DaemonError::Rpc)?;
        Ok(crate::variant::sparse_hint(&project, &variant.path).await)
    }

    /// Called only for a newly completed successful turn, never restored state.
    pub(super) fn schedule_variant_reap(&self, workspace: &str, thread: &str) {
        let app = self.clone();
        let (workspace, thread) = (workspace.to_string(), thread.to_string());
        tokio::spawn(async move {
            let completed = {
                let workspaces = app.inner.workspaces.lock().await;
                let Some(t) = workspaces
                    .get(&workspace)
                    .and_then(|w| w.threads.get(&thread))
                else {
                    return;
                };
                if t.summary.variant.is_none() {
                    return;
                }
                t.summary.updated_at
            };
            tokio::time::sleep(GRACE).await;
            app.reap_finished_variant(&workspace, &thread, completed, Utc::now())
                .await;
        });
    }

    pub(super) async fn reap_finished_variant(
        &self,
        workspace_id: &str,
        thread_id: &str,
        completed: chrono::DateTime<Utc>,
        now: chrono::DateTime<Utc>,
    ) -> Option<crate::variant::Reclaim> {
        let gate = self.variant_gate(workspace_id, thread_id).await;
        let _guard = gate.lock().await;
        let (project, variant) = {
            let workspaces = self.inner.workspaces.lock().await;
            let w = workspaces.get(workspace_id)?;
            let t = w.threads.get(thread_id)?;
            if t.summary.updated_at != completed
                || (now - completed).to_std().ok()? < GRACE
                || t.summary.status != ThreadStatus::Idle
                || t.summary.is_pinned
                || t.summary.is_pinned_in_project
                || !t.summary.queued_turns.is_empty()
                || !t.queued_requests.is_empty()
                || t.dispatching_request.is_some()
            {
                return None;
            }
            (w.summary.path.clone(), t.summary.variant.clone()?)
        };
        let result = crate::variant::reclaim_if_safe(&project, &variant).await;
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
        self.note_variant_disk(workspace_id, bytes);
    }

    fn note_variant_disk(&self, workspace_id: &str, bytes: u64) {
        let low = bytes < 25 * 1024 * 1024 * 1024;
        let previous = self.inner.variant_disk_low.swap(low, Ordering::Relaxed);
        if low && !previous {
            let _ = self.upsert_operational_condition(workspace_id.to_string(), "variant-disk-pressure",
                ServiceLevel::Warning,
                format!("Mac storage is low ({:.1} GiB available). Isolated checkouts may fill the disk. Review retained worktrees before creating more.", bytes as f64 / 1073741824.0),
                Some("worktree-lifecycle".into()));
        } else if !low && previous {
            let workspaces: Vec<_> = self
                .inner
                .operational_conditions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .filter(|c| c.key == "variant-disk-pressure")
                .map(|c| c.workspace_id.clone())
                .collect();
            for workspace in workspaces {
                self.clear_operational_condition(&workspace, "variant-disk-pressure");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_disk_warning_emits_once_per_crossing() {
        let root = tempfile::tempdir().unwrap();
        let app = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            root.path().join("state.json"),
        );
        let mut events = app.inner.broadcaster.subscribe();
        app.note_variant_disk("workspace", 24 * 1024 * 1024 * 1024);
        assert!(events.try_recv().is_ok());
        while events.try_recv().is_ok() {}
        app.note_variant_disk("workspace", 23 * 1024 * 1024 * 1024);
        assert!(events.try_recv().is_err());
        app.note_variant_disk("workspace", 26 * 1024 * 1024 * 1024);
        while events.try_recv().is_ok() {}
        assert!(!app.inner.variant_disk_low.load(Ordering::Relaxed));
        app.note_variant_disk("workspace", 24 * 1024 * 1024 * 1024);
        assert!(events.try_recv().is_ok());
    }
}
