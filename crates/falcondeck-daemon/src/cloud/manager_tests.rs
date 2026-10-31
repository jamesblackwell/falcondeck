use super::*;
use std::{fs, process::Command as StdCommand};
use tempfile::TempDir;

fn manager() -> (TempDir, Arc<CloudManager>) {
    let directory = tempfile::tempdir().unwrap();
    let manager = CloudManager::new(&directory.path().join("daemon.json"));
    (directory, manager)
}

fn request() -> CreateCloudJobRequest {
    CreateCloudJobRequest {
        workspace_id: "local-workspace".into(),
        prompt: "Update the project".into(),
        source_capture_id: None,
        idempotency_key: "stable-request-0001".into(),
        model_id: Some("test-model".into()),
    }
}

fn preview() -> CloudSourcePreview {
    CloudSourcePreview {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: "local-workspace".into(),
        base_head: None,
        tree_hash: "captured-tree".into(),
        included_paths: vec!["tracked.txt".into()],
        excluded_paths: vec![".env".into()],
        total_bytes: 9,
        created_at: Utc::now(),
    }
}

fn record(root: PathBuf, source: CloudSourcePreview, status: CloudJobStatus) -> JobRecord {
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    JobRecord {
        job: CloudJob {
            id: id.clone(),
            workspace_id: source.workspace_id.clone(),
            source,
            status,
            prompt: request().prompt,
            model_id: request().model_id,
            worker: None,
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
            expires_at: None,
        },
        request: request(),
        root,
        sandbox_id: format!("fd-cloud-{id}"),
        gateway_url: Some("https://native-worker.vercel.run".into()),
        gateway_token: Some("private-worker-token-never-public".into()),
        provider_scope: None,
        awaiting_user_after_resume: false,
        thread_summary: None,
        thread_request: None,
        deferred_launch: false,
        pending_turn: None,
        custom_title: None,
        turn_receipts: BTreeMap::new(),
        cancel_requested: false,
        allocation_started: false,
    }
}

fn save_record(manager: &CloudManager, record: JobRecord) -> String {
    let id = record.job.id.clone();
    let mut registry = manager.registry().unwrap();
    registry.jobs.insert(id.clone(), record);
    manager.save(&registry).unwrap();
    id
}

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = StdCommand::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?} failed");
    output.stdout
}

fn repository() -> TempDir {
    let directory = tempfile::tempdir().unwrap();
    git(directory.path(), &["init", "-q"]);
    git(
        directory.path(),
        &["config", "user.email", "cloud@test.invalid"],
    );
    git(
        directory.path(),
        &["config", "user.name", "Cloud manager test"],
    );
    fs::write(directory.path().join("tracked.txt"), b"baseline\n").unwrap();
    git(directory.path(), &["add", "tracked.txt"]);
    git(directory.path(), &["commit", "-qm", "initial"]);
    directory
}

fn configured_settings() -> Settings {
    let mut settings = Settings::default();
    settings.public.enabled = true;
    settings.public.has_provider_token = true;
    settings.public.has_openai_api_key = true;
    settings.public.team_id = Some("team-test".into());
    settings.public.project_id = Some("project-test".into());
    settings.public.image = format!("node@sha256:{}", "b".repeat(64));
    settings.provider_token = "private-provider-test-token".into();
    settings.openai_api_key = "private-model-test-key".into();
    settings.public.runtime_path = "/nonexistent/cloud-runtime.mjs".into();
    settings.public.worker_daemon_url = "https://downloads.example.invalid/worker".into();
    settings.public.worker_daemon_sha256 = "a".repeat(64);
    settings
}

fn cloud_thread_request() -> StartThreadRequest {
    serde_json::from_value(json!({
        "workspace_id":"local-workspace", "execution_target":"cloud", "provider":"codex",
        "idempotency_key":"unified-cloud-thread-0001", "model_id":"test-model",
        "approval_policy":"on-request", "sandbox_mode":"workspace-write"
    })).unwrap()
}

#[tokio::test]
async fn ordinary_cloud_creation_is_lazy_durable_and_idempotent() {
    let (directory, manager) = manager();
    let repository = repository();
    store::write_json(&manager.path("settings.json"), &configured_settings()).unwrap();
    let request = cloud_thread_request();
    let first = manager.start_thread(request.clone(), repository.path().to_path_buf()).await.unwrap();
    assert_eq!(first.execution_target, ThreadExecutionTarget::Cloud);
    assert_eq!(first.status, ThreadStatus::Idle);
    assert!(job_id(&first.id).is_some());
    let record = manager.record(job_id(&first.id).unwrap()).await.unwrap();
    assert!(record.deferred_launch);
    assert!(record.job.worker.is_none());
    assert!(record.gateway_url.is_none());
    // Retry after edits still refers to the original source and thread.
    fs::write(repository.path().join("tracked.txt"), "changed after create").unwrap();
    let retry = manager.start_thread(request.clone(), repository.path().to_path_buf()).await.unwrap();
    assert_eq!(retry.id, first.id);
    assert_eq!(manager.registry().unwrap().jobs.len(), 1);
    let reopened = CloudManager::new(&directory.path().join("daemon.json"));
    assert_eq!(reopened.thread_summaries().await.unwrap()[0].status, ThreadStatus::Idle);
    assert!(reopened.record(job_id(&first.id).unwrap()).await.unwrap().deferred_launch);
    let mut other = request;
    other.model_id = Some("another-model".into());
    assert!(matches!(manager.start_thread(other, repository.path().to_path_buf()).await, Err(DaemonError::Conflict(_))));
}

#[tokio::test]
async fn ordinary_cloud_settings_keep_creation_retry_identity_and_metadata() {
    let (_directory, manager) = manager();
    let repository = repository();
    store::write_json(&manager.path("settings.json"), &configured_settings()).unwrap();
    let request = cloud_thread_request();
    let thread = manager.start_thread(request.clone(), repository.path().to_path_buf()).await.unwrap();
    let changed = manager.update_thread(&thread.id, serde_json::from_value(json!({
        "workspace_id":thread.workspace_id,"thread_id":thread.id,"title":"Cloud cleanup",
        "reasoning_effort":"high","approval_policy":"never","sandbox_mode":"danger-full-access",
        "pinned":true
    })).unwrap()).await.unwrap();
    assert_eq!(changed.title, "Cloud cleanup");
    assert_eq!(changed.agent.reasoning_effort.as_deref(), Some("high"));
    assert!(changed.is_pinned);
    // Changing settings must not invalidate the original creation retry key.
    assert_eq!(manager.start_thread(request, repository.path().to_path_buf()).await.unwrap().id, thread.id);
    let stable = manager.thread_summaries().await.unwrap()[0].clone();
    manager.mutate_summary(&thread.id, |_| {}).await.unwrap();
    assert_eq!(manager.thread_summaries().await.unwrap()[0], stable);
    let record = manager.record(job_id(&thread.id).unwrap()).await.unwrap();
    assert_eq!(record.custom_title.as_deref(), Some("Cloud cleanup"));
    assert!(record.deferred_launch);
}

#[tokio::test]
async fn ordinary_cloud_first_send_is_journaled_before_allocation_and_deduplicated() {
    let (_directory, manager) = manager();
    let repository = repository();
    store::write_json(&manager.path("settings.json"), &configured_settings()).unwrap();
    let thread = manager.start_thread(cloud_thread_request(), repository.path().to_path_buf()).await.unwrap();
    // Hold allocation behind this gate. The adapter fixture path does not
    // exist, and no provider or model requests are made in this test.
    let allocation_gate = manager.execution.lock().await;
    let request: SendTurnRequest = serde_json::from_value(json!({
        "workspace_id":thread.workspace_id,"thread_id":thread.id,
        "inputs":[{"type":"text","text":"Preserve my current working files"}],
        "model_id":"test-model","reasoning_effort":"high","approval_policy":"never",
        "sandbox_mode":"danger-full-access","user_item_id":"user-stable-cloud-0001"
    })).unwrap();
    assert!(manager.send_thread_turn(&thread.id, request.clone()).await.unwrap().ok);
    assert!(manager.send_thread_turn(&thread.id, request.clone()).await.unwrap().ok);
    let record = manager.record(job_id(&thread.id).unwrap()).await.unwrap();
    assert_eq!(record.pending_turn, Some(request.clone()));
    assert!(!record.deferred_launch);
    assert!(record.job.worker.is_none());
    assert_eq!(record.job.prompt, "Preserve my current working files");
    assert_eq!(manager.registry().unwrap().jobs.len(), 1);
    // The receipt still prevents replay after the native launch has moved
    // beyond the pending-turn stage, including an ambiguous restart.
    let mut registry = manager.registry().unwrap();
    let stored = registry.jobs.get_mut(job_id(&thread.id).unwrap()).unwrap();
    stored.pending_turn = None;
    stored.job.status = CloudJobStatus::Unknown;
    manager.save(&registry).unwrap();
    assert!(manager.send_thread_turn(&thread.id, request.clone()).await.unwrap().ok);
    let mut changed = request;
    changed.inputs = vec![TurnInputItem::Text { id:None, text:"Different turn using the same id".into() }];
    assert!(matches!(manager.send_thread_turn(&thread.id, changed).await, Err(DaemonError::Conflict(_))));
    drop(allocation_gate);
}

#[tokio::test]
async fn ordinary_cloud_rejects_unqualified_harness_and_cross_owner_source() {
    let (_directory, manager) = manager();
    let repository = repository();
    store::write_json(&manager.path("settings.json"), &configured_settings()).unwrap();
    let mut request = cloud_thread_request();
    request.provider = Some(AgentProvider::CLAUDE);
    assert!(manager.start_thread(request, repository.path().to_path_buf()).await.unwrap_err().to_string().contains("Codex"));
    assert!(manager.registry().unwrap().jobs.is_empty());
    assert!(job_id("cloud-not-an-id").is_none());
}

#[tokio::test]
async fn ordinary_cloud_cancel_before_allocation_is_immediate_durable_and_never_launches() {
    let (directory, manager) = manager();
    let repository = repository();
    store::write_json(&manager.path("settings.json"), &configured_settings()).unwrap();
    let thread = manager.start_thread(cloud_thread_request(), repository.path().to_path_buf()).await.unwrap();
    let request: SendTurnRequest = serde_json::from_value(json!({
        "workspace_id":thread.workspace_id,"thread_id":thread.id,
        "inputs":[{"type":"text","text":"Do not dispatch after I stop setup"}],
        "user_item_id":"user-cancel-cloud-0001"
    })).unwrap();
    let allocation_gate = manager.execution.lock().await;
    manager.send_thread_turn(&thread.id, request).await.unwrap();
    let raw_id = job_id(&thread.id).unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(200), manager.cancel_preparing(raw_id)).await.unwrap().unwrap().ok);
    let pending = manager.record(raw_id).await.unwrap();
    assert!(pending.cancel_requested);
    assert!(!pending.allocation_started);
    assert_eq!(pending.job.status, CloudJobStatus::Stopping);
    assert!(pending.job.worker.is_none());
    // Reopening the journal and reconciling it must preserve the cancellation,
    // even before the original process gets a chance to run its cleanup task.
    let reopened = CloudManager::new(&directory.path().join("daemon.json"));
    reopened.supervise_tick().await.unwrap();
    assert_eq!(reopened.record(raw_id).await.unwrap().job.status, CloudJobStatus::Stopped);
    let source = manager.capture_record(&pending.job.source.id).unwrap().source;
    manager.launch_inner(raw_id, &configured_settings(), source).await.unwrap();
    drop(allocation_gate);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let record = manager.record(raw_id).await.unwrap();
            if record.job.status == CloudJobStatus::Stopped {
                assert!(!record.allocation_started);
                assert!(record.job.worker.is_none());
                assert!(record.gateway_url.is_none());
                break;
            }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
}

#[tokio::test]
async fn ordinary_cloud_cancel_after_allocation_stops_only_the_existing_identity() {
    let (directory, manager) = manager();
    let repository = repository();
    let operations = directory.path().join("cancel-operations.json");
    let adapter = directory.path().join("cancel-adapter.py");
    fs::write(&adapter, format!(r#"import json, sys
request = json.load(sys.stdin)
assert request['operation'] == 'stop'
with open({}, 'w') as output:
    json.dump({{'operation':request['operation'], 'sandbox_id':request['sandbox_id']}}, output)
print(json.dumps({{'status':'stopped'}}))
"#, serde_json::to_string(operations.to_str().unwrap()).unwrap())).unwrap();
    let mut settings = configured_settings();
    settings.public.node_binary = "/usr/bin/python3".into();
    settings.public.runtime_path = adapter.to_str().unwrap().into();
    store::write_json(&manager.path("settings.json"), &settings).unwrap();
    let thread = manager.start_thread(cloud_thread_request(), repository.path().to_path_buf()).await.unwrap();
    let raw_id = job_id(&thread.id).unwrap();
    let allocation_gate = manager.execution.lock().await;
    let mut registry = manager.registry().unwrap();
    let stored = registry.jobs.get_mut(raw_id).unwrap();
    stored.deferred_launch = false;
    stored.allocation_started = true;
    let sandbox_id = stored.sandbox_id.clone();
    manager.save(&registry).unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(200), manager.cancel_preparing(raw_id)).await.unwrap().unwrap().ok);
    assert!(!operations.exists());
    drop(allocation_gate);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if manager.record(raw_id).await.unwrap().job.status == CloudJobStatus::Stopped { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let operation: Value = serde_json::from_slice(&fs::read(operations).unwrap()).unwrap();
    assert_eq!(operation, json!({"operation":"stop","sandbox_id":sandbox_id}));
    assert!(manager.record(raw_id).await.unwrap().job.worker.is_none());
}

#[tokio::test]
async fn settings_keep_credentials_private_across_restart_and_allow_explicit_clear() {
    let (directory, manager) = manager();
    let public = manager
        .update_settings(UpdateCloudSettingsRequest {
            provider_token: Some("  private-provider-test-token  ".into()),
            openai_api_key: Some("  private-model-test-key  ".into()),
            team_id: Some(" team-example ".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(public.has_provider_token && public.has_openai_api_key);
    assert_eq!(public.team_id.as_deref(), Some("team-example"));
    let response = serde_json::to_string(&public).unwrap();
    assert!(!response.contains("private-provider-test-token"));
    assert!(!response.contains("private-model-test-key"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(manager.path("settings.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&manager.root).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let reopened = CloudManager::new(&directory.path().join("daemon.json"));
    assert_eq!(reopened.settings().await.unwrap(), public);
    let private = reopened.settings_private().unwrap();
    assert_eq!(private.provider_token, "private-provider-test-token");
    assert_eq!(private.openai_api_key, "private-model-test-key");
    let cleared = reopened
        .update_settings(UpdateCloudSettingsRequest {
            provider_token: Some(String::new()),
            openai_api_key: Some("   ".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!cleared.has_provider_token && !cleared.has_openai_api_key);
    assert!(
        reopened
            .settings_private()
            .unwrap()
            .provider_token
            .is_empty()
    );
    assert!(
        reopened
            .settings_private()
            .unwrap()
            .openai_api_key
            .is_empty()
    );
}

#[tokio::test]
async fn rejected_settings_do_not_persist_or_echo_new_credentials() {
    let (_directory, manager) = manager();
    let error = manager
        .update_settings(UpdateCloudSettingsRequest {
            provider_token: Some("private-provider-test-token".into()),
            openai_api_key: Some("private-model-test-key".into()),
            allowed_domains: Some(vec!["*.example.invalid".into()]),
            ..Default::default()
        })
        .await
        .unwrap_err()
        .to_string();
    assert!(!error.contains("private-provider-test-token"));
    assert!(!error.contains("private-model-test-key"));
    let settings = manager.settings().await.unwrap();
    assert!(!settings.has_provider_token && !settings.has_openai_api_key);
    assert!(!manager.path("settings.json").exists());
}

#[tokio::test]
async fn durable_exact_retry_works_without_settings_source_or_new_allocation() {
    let (directory, manager) = manager();
    let nonexistent = directory.path().join("source-no-longer-present");
    let saved = record(nonexistent.clone(), preview(), CloudJobStatus::Completed);
    let expected = saved.job.clone();
    save_record(&manager, saved);
    drop(manager);
    let reopened = CloudManager::new(&directory.path().join("daemon.json"));
    let retry = reopened.create(request(), nonexistent).await.unwrap();
    assert_eq!(retry, expected);
    assert_eq!(reopened.list().await.unwrap().len(), 1);
    let public = serde_json::to_string(&reopened.list().await.unwrap()).unwrap();
    assert!(!public.contains("private-worker-token-never-public"));
    assert!(!public.contains("native-worker.vercel.run"));
    assert!(!public.contains("sandbox_id"));
}

#[tokio::test]
async fn reused_retry_key_rejects_each_changed_request_field() {
    let (directory, manager) = manager();
    let root = directory.path().join("missing-source");
    save_record(
        &manager,
        record(root.clone(), preview(), CloudJobStatus::Completed),
    );
    let mut changed_prompt = request();
    changed_prompt.prompt.push_str(" differently");
    let mut changed_workspace = request();
    changed_workspace.workspace_id = "different-workspace".into();
    let mut changed_model = request();
    changed_model.model_id = None;
    let mut changed_capture = request();
    changed_capture.source_capture_id = Some(uuid::Uuid::new_v4().to_string());
    for request in [
        changed_prompt,
        changed_workspace,
        changed_model,
        changed_capture,
    ] {
        assert!(matches!(
            manager.create(request, root.clone()).await,
            Err(DaemonError::Conflict(_))
        ));
    }
    assert_eq!(manager.list().await.unwrap().len(), 1);
}

#[tokio::test]
async fn restart_marks_unfinished_operations_unknown_and_retains_the_allocation_slot() {
    let (directory, manager) = manager();
    let repository = repository();
    let source = manager
        .capture("local-workspace".into(), repository.path().into())
        .await
        .unwrap();
    let id = save_record(
        &manager,
        record(
            repository.path().into(),
            source.clone(),
            CloudJobStatus::Provisioning,
        ),
    );
    store::write_json(&manager.path("settings.json"), &configured_settings()).unwrap();
    drop(manager);
    let reopened = CloudManager::new(&directory.path().join("daemon.json"));
    let restored = reopened.list_stored().await.unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].id, id);
    assert_eq!(restored[0].status, CloudJobStatus::Unknown);
    assert!(restored[0].error.as_deref().unwrap().contains("restarted"));
    let mut next = request();
    next.idempotency_key = "different-request-0002".into();
    next.source_capture_id = Some(source.id);
    assert!(matches!(
        reopened.create(next, repository.path().into()).await,
        Err(DaemonError::Conflict(_))
    ));
    assert_eq!(
        reopened.registry().unwrap().jobs[&id].sandbox_id,
        format!("fd-cloud-{id}")
    );
    assert_eq!(reopened.list_stored().await.unwrap().len(), 1);
    assert!(!reopened.path("runtime-home").exists());
}

#[test]
fn gateway_allowlist_rejects_alternate_hosts_credentials_and_url_injection() {
    for accepted in ["https://worker.vercel.run", "https://worker.vercel.run/"] {
        assert!(validate_gateway(accepted).is_ok(), "rejected {accepted}");
    }
    for rejected in [
        "http://worker.vercel.run",
        "https://vercel.run",
        "https://worker.vercel.run.attacker.invalid",
        "https://attackervercel.run",
        "https://worker.vercel.run@attacker.invalid",
        "https://user:private-gateway-secret@worker.vercel.run",
        "https://worker.vercel.run/api/health",
        "https://worker.vercel.run?token=private-gateway-secret",
        "https://worker.vercel.run#private-gateway-secret",
        "https://worker.vercel.run:8443",
        "https://127.0.0.1",
        "https://[::1]",
    ] {
        let error = validate_gateway(rejected).unwrap_err().to_string();
        assert!(!error.contains("private-gateway-secret"));
    }
}

#[tokio::test]
async fn import_requires_collected_result_and_rejects_changed_local_baseline_atomically() {
    let (_directory, manager) = manager();
    let repository = repository();
    let root = repository.path();
    let preview = manager
        .capture("local-workspace".into(), root.into())
        .await
        .unwrap();
    let baseline = manager.capture_record(&preview.id).unwrap().source;
    let id = save_record(
        &manager,
        record(root.into(), preview, CloudJobStatus::Completed),
    );
    assert!(
        matches!(manager.import(&id).await, Err(DaemonError::BadRequest(message)) if message.contains("Collect"))
    );
    fs::write(root.join("tracked.txt"), b"cloud edit\n").unwrap();
    fs::write(root.join("a-new.txt"), b"cloud addition\n").unwrap();
    let output = source::capture_source(root, CaptureLimits::default())
        .await
        .unwrap();
    let delta = source::delta_between(&baseline, &output).unwrap();
    fs::remove_file(root.join("a-new.txt")).unwrap();
    fs::write(root.join("tracked.txt"), b"new local work\n").unwrap();
    store::write_json(
        &manager.result_path(&id).unwrap(),
        &ResultRecord {
            output: output.clone(),
            delta,
            native_sessions: Vec::new(),
            native_detail: None,
            import_baseline: None,
            binary_patch_base64: None,
        },
    )
    .unwrap();
    let mut registry = manager.registry().unwrap();
    registry.jobs.get_mut(&id).unwrap().job.result = Some(CloudJobResult {
        collected_at: Utc::now(),
        tree_hash: output.tree_hash.clone(),
        changed_paths: vec!["a-new.txt".into(), "tracked.txt".into()],
        deleted_paths: Vec::new(),
        native_session_count: 0,
        imported_at: None,
    });
    manager.save(&registry).unwrap();
    let index = fs::read(root.join(".git/index")).unwrap();
    assert!(matches!(
        manager.import(&id).await,
        Err(DaemonError::Conflict(_))
    ));
    assert_eq!(
        fs::read(root.join("tracked.txt")).unwrap(),
        b"new local work\n"
    );
    assert!(!root.join("a-new.txt").exists());
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert!(
        manager.registry().unwrap().jobs[&id]
            .job
            .result
            .as_ref()
            .unwrap()
            .imported_at
            .is_none()
    );
    fs::write(root.join("tracked.txt"), b"baseline\n").unwrap();
    let imported = manager.import(&id).await.unwrap();
    assert!(imported.result.as_ref().unwrap().imported_at.is_some());
    assert_eq!(
        store::read_json::<SourceCapture>(&manager.import_baseline_path(&id).unwrap()).unwrap(),
        Some(output.clone())
    );
    assert_eq!(fs::read(root.join("tracked.txt")).unwrap(), b"cloud edit\n");
    assert_eq!(
        fs::read(root.join("a-new.txt")).unwrap(),
        b"cloud addition\n"
    );
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    // Repeating the explicit import only returns its durable receipt.
    fs::write(root.join("tracked.txt"), b"work after import\n").unwrap();
    assert_eq!(manager.import(&id).await.unwrap(), imported);
    assert_eq!(
        fs::read(root.join("tracked.txt")).unwrap(),
        b"work after import\n"
    );

    // A native follow-up keeps the original capture while advancing only the
    // delta since the last result that was imported successfully.
    fs::write(root.join("tracked.txt"), b"cloud follow-up edit\n").unwrap();
    let follow_up_output = source::capture_source(root, CaptureLimits::default())
        .await
        .unwrap();
    let follow_up_delta = source::delta_between(&output, &follow_up_output).unwrap();
    assert_eq!(follow_up_delta.files.len(), 1);
    assert_eq!(follow_up_delta.files[0].path, "tracked.txt");
    fs::write(root.join("tracked.txt"), b"cloud edit\n").unwrap();
    fs::write(root.join("local-untracked.txt"), b"unrelated local work\n").unwrap();
    fs::write(root.join("local-staged.txt"), b"staged local work\n").unwrap();
    git(root, &["add", "local-staged.txt"]);
    fs::write(root.join("local-staged.txt"), b"unstaged local work\n").unwrap();
    let follow_up_index = fs::read(root.join(".git/index")).unwrap();
    store::write_json(
        &manager.result_path(&id).unwrap(),
        &ResultRecord {
            output: follow_up_output.clone(),
            delta: follow_up_delta,
            native_sessions: Vec::new(),
            native_detail: None,
            import_baseline: Some(output),
            binary_patch_base64: None,
        },
    )
    .unwrap();
    let mut registry = manager.registry().unwrap();
    registry.jobs.get_mut(&id).unwrap().job.result = Some(CloudJobResult {
        collected_at: Utc::now(),
        tree_hash: follow_up_output.tree_hash.clone(),
        changed_paths: vec!["tracked.txt".into()],
        deleted_paths: Vec::new(),
        native_session_count: 0,
        imported_at: None,
    });
    manager.save(&registry).unwrap();
    let follow_up_import = manager.import(&id).await.unwrap();
    assert!(follow_up_import.result.unwrap().imported_at.is_some());
    assert_eq!(
        fs::read(root.join("tracked.txt")).unwrap(),
        b"cloud follow-up edit\n"
    );
    assert_eq!(
        fs::read(root.join("a-new.txt")).unwrap(),
        b"cloud addition\n"
    );
    assert_eq!(
        fs::read(root.join("local-untracked.txt")).unwrap(),
        b"unrelated local work\n"
    );
    assert_eq!(
        fs::read(root.join("local-staged.txt")).unwrap(),
        b"unstaged local work\n"
    );
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), follow_up_index);
    assert_eq!(
        git(root, &["show", ":local-staged.txt"]),
        b"staged local work\n"
    );
    assert_eq!(
        store::read_json::<SourceCapture>(&manager.import_baseline_path(&id).unwrap()).unwrap(),
        Some(follow_up_output)
    );
    assert_eq!(
        manager.capture_record(&imported.source.id).unwrap().source,
        baseline
    );
}

#[cfg(unix)]
#[tokio::test]
async fn failed_runtime_is_private_unknown_and_is_never_reallocated_on_exact_retry() {
    let (directory, manager) = manager();
    let repository = repository();
    let script = directory.path().join("fake-runtime.sh");
    let input_path = directory.path().join("runtime-input.json");
    let invocation_path = directory.path().join("runtime-invocations");
    fn quote(path: &Path) -> String {
        format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
    }
    fs::write(
        &script,
        format!(
            "printf x >> {}\n/bin/cat > {}\n/bin/cat {} >&2\nexit 1\n",
            quote(&invocation_path),
            quote(&input_path),
            quote(&input_path),
        ),
    )
    .unwrap();
    let mut settings = configured_settings();
    settings.public.node_binary = "/bin/sh".into();
    settings.public.runtime_path = script.to_str().unwrap().into();
    store::write_json(&manager.path("settings.json"), &settings).unwrap();
    let request = request();
    let created = manager
        .create(request.clone(), repository.path().into())
        .await
        .unwrap();
    assert_eq!(created.status, CloudJobStatus::Provisioning);
    let unknown = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let job = manager.list_stored().await.unwrap().remove(0);
            if job.status == CloudJobStatus::Unknown {
                break job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(unknown.id, created.id);
    let input: Value = serde_json::from_slice(&fs::read(&input_path).unwrap()).unwrap();
    assert_eq!(input["operation"], "create");
    assert_eq!(input["name"], format!("fd-cloud-{}", created.id));
    assert_eq!(input["credentials"]["token"], "private-provider-test-token");
    assert_eq!(input["openai_api_key"], "private-model-test-key");
    let public = serde_json::to_string(&unknown).unwrap();
    assert!(!public.contains("private-provider-test-token"));
    assert!(!public.contains("private-model-test-key"));
    assert_eq!(
        manager
            .create(request, repository.path().into())
            .await
            .unwrap(),
        unknown
    );
    assert_eq!(fs::read(&invocation_path).unwrap(), b"x");
    assert_eq!(manager.list_stored().await.unwrap().len(), 1);
}
