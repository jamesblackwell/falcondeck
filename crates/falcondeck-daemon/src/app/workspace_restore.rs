use futures_util::{StreamExt, stream};

use super::{AppState, PersistedWorkspaceState};

// Share startup I/O without launching every saved project's CLI at once.
const WORKSPACE_RESTORE_CONCURRENCY: usize = 4;

impl AppState {
    pub(super) async fn restore_workspaces(
        &self,
        workspaces: Vec<PersistedWorkspaceState>,
        auto_resume: bool,
    ) {
        stream::iter(workspaces)
            .for_each_concurrent(WORKSPACE_RESTORE_CONCURRENCY, |workspace| {
                self.restore_one_persisted_workspace(workspace, auto_resume)
            })
            .await;
    }
}
