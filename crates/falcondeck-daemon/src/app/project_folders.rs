use falcondeck_core::{ProjectFolder, ProjectFolderAction, ProjectFolderMutation, WorkspaceKind};
use uuid::Uuid;

use super::AppState;
use crate::error::DaemonError;

impl AppState {
    pub(super) async fn validate_project_folder_mutation(
        &self,
        mutation: &ProjectFolderMutation,
    ) -> Result<(), DaemonError> {
        let workspaces = self.inner.workspaces.lock().await;
        let workspace = workspaces
            .get(&mutation.workspace_id)
            .ok_or_else(|| DaemonError::NotFound("Project not found".into()))?;
        if workspace.summary.kind != WorkspaceKind::Project {
            return Err(DaemonError::BadRequest("Folders belong to projects".into()));
        }
        if let ProjectFolderAction::MoveThread { thread_id, .. } = &mutation.action {
            if !workspace.threads.contains_key(thread_id) {
                return Err(DaemonError::NotFound(
                    "Task not found in this project".into(),
                ));
            }
        }
        Ok(())
    }
}

pub(super) fn apply_mutation(
    folders: &mut Vec<ProjectFolder>,
    mutation: ProjectFolderMutation,
) -> Result<(), DaemonError> {
    let workspace_id = mutation.workspace_id;
    let find = |id: &str| {
        folders
            .iter()
            .position(|folder| folder.id == id && folder.workspace_id == workspace_id)
            .ok_or_else(|| DaemonError::NotFound("Folder not found in this project".into()))
    };
    match mutation.action {
        ProjectFolderAction::Create { name } => {
            let name = validate_name(folders, &workspace_id, None, &name)?;
            folders.push(ProjectFolder {
                id: Uuid::new_v4().to_string(),
                workspace_id,
                name,
                collapsed: false,
                thread_ids: Vec::new(),
            });
        }
        ProjectFolderAction::Rename { folder_id, name } => {
            let index = find(&folder_id)?;
            let name = validate_name(folders, &workspace_id, Some(&folder_id), &name)?;
            folders[index].name = name;
        }
        ProjectFolderAction::SetCollapsed {
            folder_id,
            collapsed,
        } => {
            let index = find(&folder_id)?;
            folders[index].collapsed = collapsed;
        }
        ProjectFolderAction::Delete { folder_id } => {
            let index = find(&folder_id)?;
            folders.remove(index);
        }
        ProjectFolderAction::MoveThread {
            thread_id,
            folder_id,
        } => {
            let destination = folder_id.as_deref().map(find).transpose()?;
            for folder in folders
                .iter_mut()
                .filter(|folder| folder.workspace_id == workspace_id)
            {
                folder.thread_ids.retain(|id| id != &thread_id);
            }
            if let Some(index) = destination {
                folders[index].thread_ids.push(thread_id);
            }
        }
    }
    Ok(())
}

fn validate_name(
    folders: &[ProjectFolder],
    workspace_id: &str,
    except: Option<&str>,
    name: &str,
) -> Result<String, DaemonError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(DaemonError::BadRequest(
            "Use a folder name of 1–100 characters".into(),
        ));
    }
    if folders.iter().any(|folder| {
        folder.workspace_id == workspace_id
            && Some(folder.id.as_str()) != except
            && folder.name.to_lowercase() == name.to_lowercase()
    }) {
        return Err(DaemonError::Conflict(
            "A folder with that name already exists".into(),
        ));
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{ManagedThread, ManagedWorkspace, storage::load_preferences};
    use falcondeck_core::{
        ThreadSummary, UnifiedEvent, UpdatePreferencesRequest, WorkspaceSummary,
    };
    use serde_json::json;
    use std::collections::HashMap;

    fn mutation(action: ProjectFolderAction) -> ProjectFolderMutation {
        ProjectFolderMutation {
            workspace_id: "project".into(),
            action,
        }
    }

    #[test]
    fn folder_edits_validate_before_changing_membership() {
        let mut folders = Vec::new();
        apply_mutation(
            &mut folders,
            mutation(ProjectFolderAction::Create {
                name: " Chores ".into(),
            }),
        )
        .unwrap();
        let id = folders[0].id.clone();
        assert_eq!(folders[0].name, "Chores");
        assert!(
            apply_mutation(
                &mut folders,
                mutation(ProjectFolderAction::Create {
                    name: "chores".into()
                })
            )
            .is_err()
        );
        for name in ["", "\n", "a\nb", &"x".repeat(101)] {
            assert!(
                apply_mutation(
                    &mut folders,
                    mutation(ProjectFolderAction::Rename {
                        folder_id: id.clone(),
                        name: name.into()
                    })
                )
                .is_err()
            );
        }
        apply_mutation(
            &mut folders,
            mutation(ProjectFolderAction::MoveThread {
                thread_id: "task".into(),
                folder_id: Some(id.clone()),
            }),
        )
        .unwrap();
        let before = folders.clone();
        assert!(
            apply_mutation(
                &mut folders,
                mutation(ProjectFolderAction::MoveThread {
                    thread_id: "task".into(),
                    folder_id: Some("missing".into())
                })
            )
            .is_err()
        );
        assert_eq!(folders, before);
        let mut foreign = mutation(ProjectFolderAction::Delete { folder_id: id });
        foreign.workspace_id = "other-project".into();
        assert!(apply_mutation(&mut folders, foreign).is_err());
        assert_eq!(folders, before);
    }

    #[test]
    fn moving_and_deleting_folders_preserves_tasks_and_one_membership() {
        let mut folders = Vec::new();
        for name in ["Chores", "Research"] {
            apply_mutation(
                &mut folders,
                mutation(ProjectFolderAction::Create { name: name.into() }),
            )
            .unwrap();
        }
        let first = folders[0].id.clone();
        let second = folders[1].id.clone();
        for target in [&first, &second, &second] {
            apply_mutation(
                &mut folders,
                mutation(ProjectFolderAction::MoveThread {
                    thread_id: "task".into(),
                    folder_id: Some(target.clone()),
                }),
            )
            .unwrap();
        }
        assert!(folders[0].thread_ids.is_empty());
        assert_eq!(folders[1].thread_ids, ["task"]);
        apply_mutation(
            &mut folders,
            mutation(ProjectFolderAction::SetCollapsed {
                folder_id: second.clone(),
                collapsed: true,
            }),
        )
        .unwrap();
        apply_mutation(
            &mut folders,
            mutation(ProjectFolderAction::Rename {
                folder_id: second.clone(),
                name: "Maintenance".into(),
            }),
        )
        .unwrap();
        assert!(folders[1].collapsed);
        assert_eq!(folders[1].name, "Maintenance");
        apply_mutation(
            &mut folders,
            mutation(ProjectFolderAction::MoveThread {
                thread_id: "task".into(),
                folder_id: None,
            }),
        )
        .unwrap();
        assert!(folders.iter().all(|folder| folder.thread_ids.is_empty()));
        apply_mutation(
            &mut folders,
            mutation(ProjectFolderAction::Delete { folder_id: second }),
        )
        .unwrap();
        assert_eq!(folders.len(), 1);
    }

    async fn app(path: std::path::PathBuf) -> AppState {
        let app = AppState::new_with_state_path("test".into(), HashMap::new(), path);
        let summary: WorkspaceSummary = serde_json::from_value(json!({
            "id": "project", "path": "/projects/demo", "status": "ready",
            "connected_at": "2026-10-15T00:00:00Z", "updated_at": "2026-10-15T00:00:00Z",
        }))
        .unwrap();
        let thread: ThreadSummary = serde_json::from_value(json!({
            "id": "task", "workspace_id": "project", "title": "Background work", "status": "idle", "updated_at": "2026-10-15T00:00:00Z",
        })).unwrap();
        app.inner.workspaces.lock().await.insert(
            "project".into(),
            ManagedWorkspace {
                summary,
                codex_session: None,
                claude_runtime: None,
                agy_runtime: None,
                opencode_runtime: None,
                acp_runtimes: HashMap::new(),
                threads: HashMap::from([("task".into(), ManagedThread::new(thread))]),
            },
        );
        app
    }

    #[tokio::test]
    async fn concurrent_edits_persist_and_emit_preferences_and_moved_task() {
        let temp = tempfile::tempdir().unwrap();
        let app = app(temp.path().join("state.json")).await;
        let request = |action| UpdatePreferencesRequest {
            project_folder: Some(mutation(action)),
            ..Default::default()
        };
        let (first, second) = tokio::join!(
            app.update_preferences(request(ProjectFolderAction::Create {
                name: "Chores".into()
            })),
            app.update_preferences(request(ProjectFolderAction::Create {
                name: "Research".into()
            })),
        );
        first.unwrap();
        second.unwrap();
        let folders = app.preferences().await.project_folders;
        assert_eq!(folders.len(), 2);
        let id = folders[0].id.clone();
        let mut events = app.subscribe();
        app.update_preferences(request(ProjectFolderAction::MoveThread {
            thread_id: "task".into(),
            folder_id: Some(id.clone()),
        }))
        .await
        .unwrap();
        assert!(matches!(
            events.recv().await.unwrap().event,
            UnifiedEvent::PreferencesUpdated { .. }
        ));
        assert!(
            matches!(events.recv().await.unwrap().event, UnifiedEvent::ThreadUpdated { ref thread } if thread.id == "task")
        );
        app.update_preferences(request(ProjectFolderAction::SetCollapsed {
            folder_id: id.clone(),
            collapsed: true,
        }))
        .await
        .unwrap();
        let saved = load_preferences(&app.inner.preferences_path).await.unwrap();
        assert_eq!(saved, app.preferences().await);
        assert!(saved.project_folders[0].collapsed);
        assert_eq!(saved.project_folders[0].thread_ids, ["task"]);
        assert!(
            app.update_preferences(request(ProjectFolderAction::MoveThread {
                thread_id: "foreign-task".into(),
                folder_id: Some(id.clone())
            }))
            .await
            .is_err()
        );
        app.update_preferences(request(ProjectFolderAction::Delete { folder_id: id }))
            .await
            .unwrap();
        assert!(app.has_thread("project", "task").await);
    }
}
