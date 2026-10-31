use super::*;
use falcondeck_core::{ThreadExecutionTarget, UpdateCloudSettingsRequest};
use serde_json::json;
use std::{fs, process::Command};
use tempfile::TempDir;

const WORKSPACE: &str = "source-workspace";
const PUBLIC_THREAD: &str = "cloud-66d0d1fc-eed4-4e11-bab9-82bd3da29099";

fn git(root: &std::path::Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(output.status.success(), "test Git operation failed");
    output.stdout
}

async fn source_app() -> (TempDir, AppState, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.name", "Cloud thread test"]);
    git(&root, &["config", "user.email", "cloud@test.invalid"]);
    fs::write(root.join("source.txt"), "committed\n").unwrap();
    git(&root, &["add", "source.txt"]);
    git(&root, &["commit", "-qm", "fixture"]);
    let app = AppState::new_with_state_path(
        "test".into(),
        HashMap::new(),
        directory.path().join("state.json"),
    );
    // Tests drive observation explicitly; no provider polling or native CLI is
    // needed to exercise the ordinary thread projection.
    app.inner
        .cloud_projection
        .started
        .store(true, Ordering::Release);
    let now = Utc::now();
    let summary: WorkspaceSummary = serde_json::from_value(json!({
        "id":WORKSPACE,"path":root,"status":"ready",
        "connected_at":now,"updated_at":now,
    }))
    .unwrap();
    app.inner.workspaces.lock().await.insert(
        WORKSPACE.into(),
        ManagedWorkspace {
            summary,
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::new(),
            threads: HashMap::new(),
        },
    );
    // Any accidental provider invocation would fail. Creating the ordinary
    // cloud thread must only capture source and register its identity.
    app.cloud_manager()
        .update_settings(
            serde_json::from_value::<UpdateCloudSettingsRequest>(json!({
                "enabled":true,"provider_token":"fixture-provider-token",
                "openai_api_key":"fixture-model-key","team_id":"fixture-team",
                "project_id":"fixture-project","image":format!("worker@sha256:{}", "a".repeat(64)),
                "node_binary":"/usr/bin/false","runtime_path":"/not-executed/cloud-runtime.mjs",
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    (directory, app, root)
}

fn start_request(key: &str) -> StartThreadRequest {
    serde_json::from_value(json!({
        "workspace_id":WORKSPACE,"execution_target":"cloud",
        "provider":"codex","idempotency_key":key,
    }))
    .unwrap()
}

fn native_detail() -> CloudJobDetail {
    let now = Utc::now();
    serde_json::from_value(json!({
        "workspace":{"id":"native-workspace","path":"/workspace/project","status":"ready","connected_at":now,"updated_at":now},
        "thread":{"id":PUBLIC_THREAD,"workspace_id":WORKSPACE,"title":"Cloud task","execution_target":"cloud","status":"running","updated_at":now},
        "items":[{"kind":"assistant_message","id":"reply","text":"First chunk","created_at":now}],
        "interactive_requests":[],"is_live":true,"collected_at":null,
    })).unwrap()
}

fn native_request() -> InteractiveRequest {
    serde_json::from_value(json!({
        "request_id":"native-request","workspace_id":"native-workspace",
        "thread_id":"native-thread","method":"item/commandExecution/requestApproval",
        "kind":"approval","title":"Run tests","questions":[],"created_at":Utc::now(),
    }))
    .unwrap()
}

#[tokio::test]
async fn ordinary_cloud_creation_is_deduplicated_and_keeps_local_dirty_source_and_index() {
    let (_directory, app, root) = source_app().await;
    fs::write(root.join("source.txt"), "staged edit\n").unwrap();
    git(&root, &["add", "source.txt"]);
    fs::write(root.join("source.txt"), "current dirty bytes\n").unwrap();
    fs::write(root.join("new.txt"), "untracked bytes\n").unwrap();
    let index_before = git(&root, &["write-tree"]);
    let handle = app
        .start_thread(start_request("same-cloud-creation"))
        .await
        .unwrap();
    let retry = app
        .start_thread(start_request("same-cloud-creation"))
        .await
        .unwrap();
    assert_eq!(handle.thread.id, retry.thread.id);
    assert!(handle.thread.id.starts_with("cloud-"));
    assert_eq!(handle.thread.execution_target, ThreadExecutionTarget::Cloud);
    assert_eq!(handle.workspace.id, WORKSPACE);
    assert_eq!(index_before, git(&root, &["write-tree"]));
    assert_eq!(
        fs::read_to_string(root.join("source.txt")).unwrap(),
        "current dirty bytes\n"
    );
    let job_id = &handle.thread.cloud.as_ref().unwrap().job_id;
    let job = app.cloud_manager().get(job_id).await.unwrap();
    assert!(job.source.included_paths.contains(&"source.txt".into()));
    assert!(job.source.included_paths.contains(&"new.txt".into()));
    assert!(
        job.worker.is_none(),
        "new conversation must not start paid compute before Send"
    );
    let snapshot = app.snapshot().await;
    assert_eq!(
        snapshot
            .threads
            .iter()
            .filter(|thread| thread.id == handle.thread.id)
            .count(),
        1
    );
    assert!(
        app.require_cloud_thread("another-workspace", &handle.thread.id)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn ordinary_cloud_thread_never_uses_the_source_project_for_git_or_files() {
    let (_directory, app, root) = source_app().await;
    let thread = app
        .start_thread(start_request("cloud-file-boundary"))
        .await
        .unwrap()
        .thread;
    assert!(app.git_status(WORKSPACE, Some(&thread.id)).await.is_err());
    assert!(
        app.workspace_files(WORKSPACE, Some(&thread.id), None)
            .await
            .is_err()
    );
    assert!(
        app.workspace_file(WORKSPACE, Some(&thread.id), "source.txt")
            .await
            .is_err()
    );
    let local = app
        .workspace_file(WORKSPACE, None, "source.txt")
        .await
        .unwrap();
    let edit = falcondeck_core::WriteWorkspaceFileRequest {
        content: "This belongs only in the cloud\n".into(),
        expected_version: local.version,
    };
    assert!(
        app.write_workspace_file(WORKSPACE, Some(&thread.id), "source.txt", &edit)
            .await
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(root.join("source.txt")).unwrap(),
        "committed\n"
    );
}

#[tokio::test]
async fn cloud_threads_use_the_same_project_folders_pins_and_archive_operations() {
    let (_directory, app, _root) = source_app().await;
    let thread = app
        .start_thread(start_request("cloud-organization"))
        .await
        .unwrap()
        .thread;
    let preferences = app.update_preferences(serde_json::from_value(json!({
        "project_folder":{"workspace_id":WORKSPACE,"action":"create","name":"Background work"},
    })).unwrap()).await.unwrap();
    let folder = preferences
        .project_folders
        .iter()
        .find(|folder| folder.name == "Background work")
        .unwrap();
    let moved = app.update_preferences(serde_json::from_value(json!({
        "project_folder":{"workspace_id":WORKSPACE,"action":"move_thread","thread_id":thread.id,"folder_id":folder.id},
    })).unwrap()).await.unwrap();
    assert!(
        moved
            .project_folders
            .iter()
            .any(|folder| folder.thread_ids.contains(&thread.id))
    );
    let pinned = app
        .update_thread(
            serde_json::from_value(json!({
                "workspace_id":WORKSPACE,"thread_id":thread.id,"pinned":true,
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(pinned.thread.is_pinned);
    assert!(
        app.archive_thread(WORKSPACE, &thread.id)
            .await
            .unwrap()
            .is_archived
    );
    assert!(
        !app.unarchive_thread(WORKSPACE, &thread.id)
            .await
            .unwrap()
            .is_archived
    );
    let snapshot = app.snapshot().await;
    let row = snapshot
        .threads
        .iter()
        .find(|row| row.id == thread.id)
        .unwrap();
    assert_eq!(row.execution_target, ThreadExecutionTarget::Cloud);
    assert!(row.is_pinned && !row.is_archived);
}

#[test]
fn native_requests_are_namespaced_once_in_both_pending_and_transcript_views() {
    let mut detail = native_detail();
    let request = native_request();
    detail.interactive_requests.push(request.clone());
    detail
        .detail
        .items
        .push(ConversationItem::InteractiveRequest {
            id: "approval-item".into(),
            request: Box::new(request),
            created_at: Utc::now(),
            resolved: false,
            resolution: None,
        });
    namespace_requests(&mut detail, WORKSPACE, PUBLIC_THREAD);
    namespace_requests(&mut detail, WORKSPACE, PUBLIC_THREAD);
    let expected = format!("{PUBLIC_THREAD}/native-request");
    assert_eq!(detail.interactive_requests[0].request_id, expected);
    assert_eq!(detail.interactive_requests[0].workspace_id, WORKSPACE);
    assert_eq!(
        detail.interactive_requests[0].thread_id.as_deref(),
        Some(PUBLIC_THREAD)
    );
    let ConversationItem::InteractiveRequest { request, .. } = detail.detail.items.last().unwrap()
    else {
        panic!("missing request item")
    };
    assert_eq!(request.request_id, expected);
    assert_eq!(request.workspace_id, WORKSPACE);
    assert_eq!(request.thread_id.as_deref(), Some(PUBLIC_THREAD));
}

#[tokio::test]
async fn polling_publishes_regular_transcript_events_and_removes_lost_approvals() {
    let (_directory, app, _root) = source_app().await;
    let handle = app
        .start_thread(start_request("cloud-observer-fixture"))
        .await
        .unwrap();
    let public_thread = handle.thread.id.clone();
    let mut events = app.subscribe();
    let mut detail = native_detail();
    detail.detail.thread = handle.thread;
    let mut request = native_request();
    request.request_id = format!("{public_thread}/native-request");
    request.workspace_id = WORKSPACE.into();
    request.thread_id = Some(public_thread.clone());
    detail.interactive_requests.push(request.clone());
    app.observe_cloud_detail(detail.clone()).await;
    let mut added = false;
    let mut approval = false;
    while let Ok(envelope) = events.try_recv() {
        assert_eq!(envelope.workspace_id.as_deref(), Some(WORKSPACE));
        assert_eq!(envelope.thread_id.as_deref(), Some(public_thread.as_str()));
        added |= matches!(envelope.event, UnifiedEvent::ConversationItemAdded { .. });
        approval |= matches!(envelope.event, UnifiedEvent::InteractiveRequest { .. });
    }
    assert!(
        added && approval,
        "ordinary clients need transcript and approval events"
    );
    let snapshot = app.snapshot().await;
    assert_eq!(snapshot.interactive_requests, vec![request]);
    let row = snapshot
        .threads
        .iter()
        .find(|row| row.id == public_thread)
        .unwrap();
    assert_eq!(row.attention.pending_approval_count, 1);

    detail = app.inner.cloud_projection.details.lock().await[&public_thread].clone();
    app.observe_cloud_detail(detail.clone()).await;
    assert!(
        events.try_recv().is_err(),
        "unchanged polls must not re-emit transcript events"
    );
    let ConversationItem::AssistantMessage { text, .. } = &mut detail.detail.items[0] else {
        panic!("missing reply")
    };
    *text = "Finished reply".into();
    detail.interactive_requests.clear();
    detail.is_live = false;
    app.observe_cloud_detail(detail).await;
    let mut updated = false;
    let mut cleared = false;
    while let Ok(envelope) = events.try_recv() {
        match &envelope.event {
            UnifiedEvent::ConversationItemUpdated { .. } => updated = true,
            UnifiedEvent::Snapshot { snapshot } => {
                cleared = snapshot.interactive_requests.is_empty()
            }
            _ => {}
        }
    }
    assert!(
        updated,
        "ordinary transcript reducer must receive changed native content"
    );
    assert!(
        cleared,
        "lost or resolved approvals must disappear without a page reload"
    );
    assert!(app.cloud_interactive_requests().await.is_empty());
    let snapshot = app.snapshot().await;
    let row = snapshot
        .threads
        .iter()
        .find(|row| row.id == public_thread)
        .unwrap();
    assert_eq!(row.attention.pending_approval_count, 0);
}

#[tokio::test]
async fn cloud_read_receipts_use_coordinator_activity_sequences() {
    let (_directory, app, _root) = source_app().await;
    let handle = app
        .start_thread(start_request("cloud-read-receipt"))
        .await
        .unwrap();
    let public_thread = handle.thread.id.clone();
    let mut detail = native_detail();
    detail.detail.thread = handle.thread;
    app.observe_cloud_detail(detail).await;
    let snapshot = app.snapshot().await;
    let first = snapshot
        .threads
        .iter()
        .find(|row| row.id == public_thread)
        .unwrap();
    let first_activity = first.attention.last_agent_activity_seq;
    assert!(first_activity > 0);
    app.mark_thread_read(WORKSPACE, &public_thread, first_activity)
        .await
        .unwrap();
    let mut detail = app.inner.cloud_projection.details.lock().await[&public_thread].clone();
    detail.detail.thread = app
        .require_cloud_thread(WORKSPACE, &public_thread)
        .await
        .unwrap();
    let ConversationItem::AssistantMessage { text, .. } = &mut detail.detail.items[0] else {
        panic!("missing reply")
    };
    *text = "A later assistant update".into();
    app.observe_cloud_detail(detail).await;
    let snapshot = app.snapshot().await;
    let updated = snapshot
        .threads
        .iter()
        .find(|row| row.id == public_thread)
        .unwrap();
    assert_eq!(updated.attention.last_read_seq, first_activity);
    assert!(updated.attention.last_agent_activity_seq > first_activity);
    assert!(updated.attention.unread);
}

#[tokio::test]
async fn restored_cloud_read_receipts_cannot_outrun_the_new_coordinator_clock() {
    let (_directory, app, _root) = source_app().await;
    let handle = app
        .start_thread(start_request("cloud-restored-read-receipt"))
        .await
        .unwrap();
    let public_thread = handle.thread.id;
    app.mutate_cloud_thread(WORKSPACE, &public_thread, |thread| {
        thread.attention.last_read_seq = 10_000;
        thread.attention.last_agent_activity_seq = 10_000;
    })
    .await
    .unwrap();
    // Cloud operational metadata survives separately from the local daemon
    // snapshot. A newly started coordinator can initially have a lower clock.
    app.inner.sequence.store(1, Ordering::Release);
    let mut detail = native_detail();
    detail.detail.thread = app
        .require_cloud_thread(WORKSPACE, &public_thread)
        .await
        .unwrap();
    app.observe_cloud_detail(detail).await;
    let snapshot = app.snapshot().await;
    let row = snapshot
        .threads
        .iter()
        .find(|row| row.id == public_thread)
        .unwrap();
    assert!(row.attention.last_agent_activity_seq > 10_000);
    assert!(row.attention.unread);
}
