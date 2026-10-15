use falcondeck_core::{ConnectWorkspaceRequest, WorkspaceStatus};
use futures_util::{StreamExt, stream};
use tokio::time::{Duration, timeout};

use super::{
    AppState, PersistedWorkspaceState, persisted_turn_was_cut_off, workspace_kind_for_path,
};
use crate::error::DaemonError;

pub(super) const WORKSPACE_RESTORE_CONCURRENCY: usize = 4;
const WORKSPACE_RESTORE_TIMEOUT: Duration = Duration::from_secs(30);

/// Sidebar membership is metadata, not a request to start an agent process.
/// Scheduled work connects through its dispatch path when it is actually due.
pub(super) fn needs_startup_connection(workspace: &PersistedWorkspaceState) -> bool {
    workspace.thread_states.iter().any(|thread| {
        !workspace.archived_thread_ids.contains(&thread.thread_id)
            && (persisted_turn_was_cut_off(thread.status.as_ref(), thread.last_error.as_deref())
                || !thread.queued_requests.is_empty())
    })
}

impl AppState {
    pub(super) async fn restore_workspaces(
        &self,
        workspaces: Vec<PersistedWorkspaceState>,
        auto_resume: bool,
    ) {
        self.restore_workspaces_with_deadline(workspaces, auto_resume, WORKSPACE_RESTORE_TIMEOUT)
            .await;
    }

    async fn restore_workspaces_with_deadline(
        &self,
        workspaces: Vec<PersistedWorkspaceState>,
        auto_resume: bool,
        deadline: Duration,
    ) {
        stream::iter(workspaces)
            .for_each_concurrent(WORKSPACE_RESTORE_CONCURRENCY, |workspace| {
                self.restore_one_persisted_workspace(workspace, auto_resume, deadline)
            })
            .await;
    }

    /// Retry inline so the same restore worker owns both attempts. A second
    /// timeout leaves the project available for lazy providers and a later
    /// user action, rather than keeping startup or the scheduler waiting.
    async fn restore_one_persisted_workspace(
        &self,
        workspace: PersistedWorkspaceState,
        auto_resume: bool,
        deadline: Duration,
    ) {
        let path = &workspace.path;
        for attempt in 0..2 {
            if self.is_shutting_down() {
                return;
            }
            let result = timeout(
                deadline,
                self.connect_workspace_internal(
                    ConnectWorkspaceRequest {
                        path: path.clone(),
                        kind: workspace_kind_for_path(path),
                    },
                    Some(&workspace),
                ),
            )
            .await;
            match result {
                Ok(Ok(_)) => {
                    if auto_resume {
                        self.spawn_interrupted_thread_resume(&workspace).await;
                    }
                    return;
                }
                Ok(Err(error)) => {
                    tracing::warn!("failed to restore workspace {path}: {error}");
                    let _ = self
                        .update_workspace_placeholder_status(
                            path,
                            WorkspaceStatus::Disconnected,
                            Some(error.to_string()),
                        )
                        .await;
                    return;
                }
                Err(_) => {
                    tracing::warn!(%path, attempt = attempt + 1, "workspace restore timed out")
                }
            }
        }
        let workspace_id = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .find(|current| current.summary.path == *path)
            .map(|current| current.summary.id.clone());
        if let Some(id) = workspace_id {
            self.inner.lazy_workspaces.lock().await.insert(id);
        }
        let _ = self
            .update_workspace_placeholder_status(
                path,
                WorkspaceStatus::Ready,
                Some("Provider discovery timed out; the project will reconnect on use".to_string()),
            )
            .await;
    }

    /// A restored project starts providers only on a user action or task
    /// dispatch. Share the explicit connect gate so simultaneous clients and
    /// catalog hydration cannot bootstrap the same project twice.
    pub(super) async fn connect_workspace_on_demand(
        &self,
        workspace_id: &str,
    ) -> Result<(), DaemonError> {
        if !self
            .inner
            .lazy_workspaces
            .lock()
            .await
            .contains(workspace_id)
        {
            return Ok(());
        }
        let path = self
            .workspace_path(workspace_id)
            .await
            .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
        let gate = {
            let mut gates = self.inner.workspace_connect_gates.lock().await;
            std::sync::Arc::clone(
                gates
                    .entry(path.clone())
                    .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _gate = gate.lock().await;
        if !self
            .inner
            .lazy_workspaces
            .lock()
            .await
            .contains(workspace_id)
        {
            return Ok(());
        }
        self.connect_workspace_internal(
            ConnectWorkspaceRequest {
                kind: workspace_kind_for_path(&path),
                path,
            },
            None,
        )
        .await?;
        Ok(())
    }
}

#[cfg(all(test, unix))]
#[path = "workspace_restore_tests.rs"]
mod tests;
