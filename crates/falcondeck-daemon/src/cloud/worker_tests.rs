//! Cost-free exercise of native worker admission through the real HTTP client.
use super::*;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, Method, Uri},
};
use std::{fs, process::Command as StdCommand};

const PROVIDER_TOKEN: &str = "private-provider-worker-integration-token";
const MODEL_KEY: &str = "private-model-worker-integration-key";
const GATEWAY_TOKEN: &str = "private-gateway-worker-integration-token";

type WorkerCalls = Arc<Mutex<Vec<(String, String, Value)>>>;

async fn fake_worker(
    State(calls): State<WorkerCalls>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    let authorization = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    calls
        .lock()
        .await
        .push((uri.path().to_string(), authorization, body));
    assert_eq!(method, Method::POST);
    Json(match uri.path() {
        "/api/workspaces/connect" => json!({"id":"worker-ws"}),
        "/api/workspaces/worker-ws/threads" => json!({"thread":{"id":"native-thread"}}),
        "/api/workspaces/worker-ws/threads/native-thread/turns" => {
            json!({"ok":true,"message":null})
        }
        path => panic!("Unexpected worker route: {path}"),
    })
}

struct WorkerServer(tokio::task::JoinHandle<()>);
impl Drop for WorkerServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn git(root: &Path, arguments: &[&str]) {
    let output = StdCommand::new("git")
        .current_dir(root)
        .args(arguments)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(output.status.success(), "test git operation failed");
}

#[cfg(unix)]
#[tokio::test]
async fn native_worker_launch_is_authenticated_and_retries_survive_restart_without_readmission() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    fs::create_dir(&project).unwrap();
    git(&project, &["init", "-q"]);
    git(&project, &["config", "user.name", "Cloud worker test"]);
    git(&project, &["config", "user.email", "worker@test.invalid"]);
    fs::write(project.join("tracked.txt"), "captured baseline\n").unwrap();
    git(&project, &["add", "tracked.txt"]);
    git(&project, &["commit", "-qm", "baseline"]);

    let calls: WorkerCalls = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let worker_url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .fallback(fake_worker)
        .with_state(calls.clone());
    let _worker = WorkerServer(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));

    let adapter_path = directory.path().join("fake-adapter.py");
    let input_path = directory.path().join("runtime-input.json");
    let invocations_path = directory.path().join("runtime-invocations");
    let runtime_response = json!({
        "gateway_url": worker_url,
        "gateway_token": GATEWAY_TOKEN,
        "workspace_path": "/workspace/project",
        "expires_at": (Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
    });
    // The adapter verifies that neither inherited environment nor argv carries
    // coordinator credentials. Its only credential source is JSON stdin.
    fs::write(
        &adapter_path,
        format!(
            r#"import json, os, sys
request = json.load(sys.stdin)
secrets = (request['credentials']['token'], request['openai_api_key'])
assert all(secret not in value for secret in secrets for value in os.environ.values())
assert all(secret not in value for secret in secrets for value in sys.argv)
with open({input_path}, 'w') as output:
    json.dump(request, output)
with open({invocations_path}, 'a') as output:
    output.write('x')
response = json.loads({response})
response['sandbox_id'] = request['name']
print(json.dumps(response))
"#,
            input_path = serde_json::to_string(input_path.to_str().unwrap()).unwrap(),
            invocations_path = serde_json::to_string(invocations_path.to_str().unwrap()).unwrap(),
            response = serde_json::to_string(&runtime_response.to_string()).unwrap(),
        ),
    )
    .unwrap();
    let manager_path = directory.path().join("daemon.json");
    let manager = CloudManager::new(&manager_path);
    let mut settings = Settings::default();
    settings.public.enabled = true;
    settings.public.has_provider_token = true;
    settings.public.has_openai_api_key = true;
    settings.public.team_id = Some("team-worker-test".into());
    settings.public.project_id = Some("project-worker-test".into());
    settings.public.image = format!("node@sha256:{}", "b".repeat(64));
    settings.public.node_binary = "/usr/bin/python3".into();
    settings.public.runtime_path = adapter_path.to_str().unwrap().into();
    settings.public.worker_daemon_url = "https://downloads.example.invalid/worker".into();
    settings.public.worker_daemon_sha256 = "a".repeat(64);
    settings.provider_token = PROVIDER_TOKEN.into();
    settings.openai_api_key = MODEL_KEY.into();
    store::write_json(&manager.path("settings.json"), &settings).unwrap();
    let request = CreateCloudJobRequest {
        workspace_id: "local-workspace".into(),
        prompt: "Continue with a native Codex thread".into(),
        source_capture_id: None,
        idempotency_key: "worker-launch-retry-0001".into(),
        model_id: Some("native-test-model".into()),
    };
    let admitted = manager
        .create(request.clone(), project.clone())
        .await
        .unwrap();
    assert_eq!(admitted.status, CloudJobStatus::Provisioning);
    let running = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let job = manager.list().await.unwrap().remove(0);
            if job.status != CloudJobStatus::Provisioning {
                break job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        running.status,
        CloudJobStatus::Running,
        "{:?}",
        running.error
    );
    let native = running.worker.as_ref().unwrap();
    assert_eq!(native.workspace_id, "worker-ws");
    assert_eq!(native.thread_id, "native-thread");
    assert_eq!(native.provider, "codex");

    let input: Value = serde_json::from_slice(&fs::read(&input_path).unwrap()).unwrap();
    assert_eq!(input["operation"], "create");
    assert_eq!(input["name"], format!("fd-cloud-{}", running.id));
    assert_eq!(input["credentials"]["token"], PROVIDER_TOKEN);
    assert_eq!(input["openai_api_key"], MODEL_KEY);
    assert_eq!(input["source"]["treeHash"], running.source.tree_hash);
    assert_eq!(fs::read_to_string(&invocations_path).unwrap(), "x");
    let public = serde_json::to_string(&manager.list().await.unwrap()).unwrap();
    for secret in [PROVIDER_TOKEN, MODEL_KEY, GATEWAY_TOKEN] {
        assert!(!public.contains(secret));
    }
    assert!(!public.contains(&worker_url));
    let history = calls.lock().await.clone();
    assert_eq!(history.len(), 3);
    for (_, authorization, _) in &history {
        assert_eq!(authorization, &format!("Bearer {GATEWAY_TOKEN}"));
    }
    assert_eq!(history[0].2["path"], "/workspace/project");
    assert_eq!(history[1].2["provider"], "codex");
    assert_eq!(history[1].2["model_id"], "native-test-model");
    assert_eq!(history[2].2["thread_id"], "native-thread");
    assert_eq!(history[2].2["inputs"][0]["text"], request.prompt);

    // Retry after a restart and a local source edit must resolve the durable
    // request first, without recapture, allocation, or native prompt admission.
    drop(manager);
    fs::write(project.join("tracked.txt"), "edited after admission\n").unwrap();
    let restarted = CloudManager::new(&manager_path);
    let retried = restarted
        .create(request.clone(), project.clone())
        .await
        .unwrap();
    assert_eq!(retried, running);
    assert_eq!(fs::read_to_string(&invocations_path).unwrap(), "x");
    assert_eq!(calls.lock().await.len(), 3);
    let mut conflicting = request;
    conflicting.prompt = "A different request".into();
    assert!(matches!(
        restarted.create(conflicting, project).await,
        Err(DaemonError::Conflict(_))
    ));
}

fn stored_native_job(root: PathBuf, status: CloudJobStatus) -> JobRecord {
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let request = CreateCloudJobRequest {
        workspace_id: "local-workspace".into(),
        prompt: "Original native prompt".into(),
        source_capture_id: None,
        idempotency_key: format!("native-job-{id}"),
        model_id: None,
    };
    JobRecord {
        job: CloudJob {
            id: id.clone(),
            workspace_id: request.workspace_id.clone(),
            source: CloudSourcePreview {
                id: uuid::Uuid::new_v4().to_string(),
                workspace_id: request.workspace_id.clone(),
                base_head: None,
                tree_hash: "test-baseline".into(),
                included_paths: Vec::new(),
                excluded_paths: Vec::new(),
                total_bytes: 0,
                created_at: now,
            },
            status,
            prompt: request.prompt.clone(),
            model_id: None,
            worker: Some(CloudWorkerLocator {
                workspace_id: "worker-ws".into(),
                thread_id: "native-thread".into(),
                provider: "codex".into(),
            }),
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
            expires_at: None,
        },
        request,
        root,
        sandbox_id: format!("fd-cloud-{id}"),
        gateway_url: None,
        gateway_token: None,
        provider_scope: Some(("original-team".into(), "original-project".into())),
        awaiting_user_after_resume: false,
    }
}

#[derive(Clone)]
struct JournalWorker {
    registry_path: PathBuf,
    job_id: String,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}
async fn worker_with_lost_admission_reply(
    State(state): State<JournalWorker>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (axum::http::StatusCode, Json<Value>) {
    assert_eq!(
        headers["authorization"].to_str().unwrap(),
        format!("Bearer {GATEWAY_TOKEN}")
    );
    let registry: Registry = store::read_json(&state.registry_path).unwrap().unwrap();
    let journal = &registry.jobs[&state.job_id];
    // Read the actual durable journal while the request is being admitted.
    assert_eq!(journal.job.status, CloudJobStatus::Unknown);
    assert!(!journal.awaiting_user_after_resume);
    assert!(journal.job.error.as_deref().unwrap().contains("pending"));
    assert!(journal.job.result.is_none());
    assert_eq!(body["workspace_id"], "worker-ws");
    assert_eq!(body["thread_id"], "native-thread");
    state
        .calls
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    (
        axum::http::StatusCode::BAD_GATEWAY,
        Json(json!({"error":"reply lost after native admission"})),
    )
}

#[tokio::test]
async fn followup_turn_journals_unknown_before_admission_and_restart_cannot_resend_it() {
    use std::sync::atomic::Ordering;
    let directory = tempfile::tempdir().unwrap();
    let state_path = directory.path().join("daemon.json");
    let manager = CloudManager::new(&state_path);
    let mut record = stored_native_job(directory.path().into(), CloudJobStatus::Completed);
    record.awaiting_user_after_resume = true;
    let id = record.job.id.clone();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    record.gateway_url = Some(format!("http://{}", listener.local_addr().unwrap()));
    record.gateway_token = Some(GATEWAY_TOKEN.into());
    let mut registry = Registry::default();
    registry.jobs.insert(id.clone(), record);
    manager.save(&registry).unwrap();
    let worker = JournalWorker {
        registry_path: manager.path("jobs.json"),
        job_id: id.clone(),
        calls: calls.clone(),
    };
    let router = Router::new()
        .fallback(worker_with_lost_admission_reply)
        .with_state(worker);
    let _server = WorkerServer(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let turn:SendTurnRequest=serde_json::from_value(json!({
        "workspace_id":"client-cannot-override-workspace","thread_id":"client-cannot-override-thread",
        "inputs":[{"type":"text","text":"Follow up on the same native thread"}],
    })).unwrap();
    assert!(manager.send_turn(&id, turn.clone()).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let saved = manager.registry().unwrap().jobs.remove(&id).unwrap();
    assert_eq!(saved.job.status, CloudJobStatus::Unknown);
    assert!(holds_slot(saved.job.status));
    assert!(saved.job.error.as_deref().unwrap().contains("unknown"));
    drop(manager);
    let restarted = CloudManager::new(&state_path);
    let restored = restarted.registry().unwrap().jobs.remove(&id).unwrap();
    assert_eq!(restored.job.worker, saved.job.worker);
    assert_eq!(restored.sandbox_id, saved.sandbox_id);
    assert!(matches!(
        restarted.send_turn(&id, turn).await,
        Err(DaemonError::Conflict(_))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[derive(Clone)]
struct RestoredWorker {
    registry_path: PathBuf,
    job_id: String,
    detail: Value,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}
async fn restored_native_worker(
    State(state): State<RestoredWorker>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Json<Value> {
    assert_eq!(method, Method::GET);
    assert_eq!(
        uri.path(),
        "/api/workspaces/worker-ws/threads/native-thread"
    );
    assert_eq!(
        headers["authorization"].to_str().unwrap(),
        format!("Bearer {GATEWAY_TOKEN}")
    );
    let registry: Registry = store::read_json(&state.registry_path).unwrap().unwrap();
    let record = &registry.jobs[&state.job_id];
    // The rotated capability must reach durable storage before native hydration.
    assert_eq!(record.gateway_token.as_deref(), Some(GATEWAY_TOKEN));
    let call = state
        .calls
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        record.job.status,
        if call == 0 {
            CloudJobStatus::Provisioning
        } else {
            CloudJobStatus::AwaitingInput
        }
    );
    assert!(record.awaiting_user_after_resume);
    Json(state.detail)
}

#[cfg(unix)]
#[tokio::test]
async fn resume_uses_retained_sandbox_and_native_ids_with_rotated_gateway_and_original_scope() {
    use std::sync::atomic::Ordering;
    let directory = tempfile::tempdir().unwrap();
    let state_path = directory.path().join("daemon.json");
    let manager = CloudManager::new(&state_path);
    let record = stored_native_job(directory.path().into(), CloudJobStatus::Stopped);
    let id = record.job.id.clone();
    let native = record.job.worker.clone();
    let sandbox_id = record.sandbox_id.clone();
    let now = Utc::now().to_rfc3339();
    let detail = json!({
        "workspace":{"id":"worker-ws","path":"/workspace/project","status":"ready","connected_at":now,"updated_at":now},
        "thread":{"id":"native-thread","workspace_id":"worker-ws","title":"Restored native task","status":"idle","updated_at":now},
        "items":[],
    });
    serde_json::from_value::<ThreadDetail>(detail.clone()).unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = format!("http://{}", listener.local_addr().unwrap());
    let state = RestoredWorker {
        registry_path: manager.path("jobs.json"),
        job_id: id.clone(),
        detail,
        calls: calls.clone(),
    };
    let router = Router::new()
        .fallback(restored_native_worker)
        .with_state(state);
    let _server = WorkerServer(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let input_path = directory.path().join("resume-input.json");
    let adapter_path = directory.path().join("resume-adapter.py");
    let response = json!({"sandbox_id":sandbox_id,"gateway_url":gateway,"gateway_token":GATEWAY_TOKEN,"expires_at":(Utc::now()+chrono::Duration::minutes(5)).to_rfc3339()});
    fs::write(
        &adapter_path,
        format!(
            r#"import json, sys
request = json.load(sys.stdin)
assert request['operation'] == 'resume'
with open({input}, 'w') as output:
    json.dump(request, output)
print({response})
"#,
            input = serde_json::to_string(input_path.to_str().unwrap()).unwrap(),
            response = serde_json::to_string(&response.to_string()).unwrap()
        ),
    )
    .unwrap();
    let mut settings = Settings::default();
    settings.public.enabled = true;
    settings.public.team_id = Some("newly-selected-team".into());
    settings.public.project_id = Some("newly-selected-project".into());
    settings.public.image = format!("node@sha256:{}", "b".repeat(64));
    settings.public.node_binary = "/usr/bin/python3".into();
    settings.public.runtime_path = adapter_path.to_str().unwrap().into();
    settings.public.worker_daemon_url = "https://downloads.example.invalid/worker".into();
    settings.public.worker_daemon_sha256 = "a".repeat(64);
    settings.provider_token = PROVIDER_TOKEN.into();
    settings.openai_api_key = MODEL_KEY.into();
    store::write_json(&manager.path("settings.json"), &settings).unwrap();
    let mut registry = Registry::default();
    registry.jobs.insert(id.clone(), record);
    manager.save(&registry).unwrap();
    let resumed = manager.resume(&id).await.unwrap();
    assert_eq!(resumed.status, CloudJobStatus::AwaitingInput);
    assert_eq!(resumed.worker, native);
    assert!(resumed.error.is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let input: Value = serde_json::from_slice(&fs::read(input_path).unwrap()).unwrap();
    assert_eq!(input["operation"], "resume");
    assert_eq!(input["sandbox_id"], sandbox_id);
    assert!(input.get("name").is_none());
    assert_eq!(input["credentials"]["teamId"], "original-team");
    assert_eq!(input["credentials"]["projectId"], "original-project");
    assert_eq!(input["openai_api_key"], MODEL_KEY);
    assert_eq!(input["timeout_ms"], 30 * 60_000);
    let saved = manager.registry().unwrap().jobs.remove(&id).unwrap();
    assert_eq!(saved.sandbox_id, sandbox_id);
    assert_eq!(saved.gateway_token.as_deref(), Some(GATEWAY_TOKEN));
    assert!(saved.awaiting_user_after_resume);
    assert!(holds_slot(resumed.status));
    manager.supervise_tick().await.unwrap();
    assert_eq!(
        manager.get(&id).await.unwrap().status,
        CloudJobStatus::AwaitingInput
    );
    drop(manager);
    let restarted = CloudManager::new(&state_path);
    restarted.supervise_tick().await.unwrap();
    let waiting = restarted.registry().unwrap().jobs.remove(&id).unwrap();
    assert_eq!(waiting.job.status, CloudJobStatus::AwaitingInput);
    assert!(waiting.awaiting_user_after_resume);
    assert_eq!(waiting.gateway_token.as_deref(), Some(GATEWAY_TOKEN));
    // The fake adapter accepts only resume: any premature collect/stop would fail.
}

#[derive(Clone)]
struct IdleWorker {
    detail: Value,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}
async fn idle_worker_snapshot(
    State(state): State<IdleWorker>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Json<Value> {
    assert_eq!(method, Method::GET);
    assert_eq!(
        headers["authorization"].to_str().unwrap(),
        format!("Bearer {GATEWAY_TOKEN}")
    );
    state
        .calls
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Json(match uri.path() {
        "/api/workspaces/worker-ws/threads/native-thread" => state.detail,
        "/api/snapshot" => json!({"interactive_requests":[]}),
        path => panic!("Unexpected supervisor worker route: {path}"),
    })
}

#[cfg(unix)]
#[tokio::test]
async fn supervisor_collects_native_results_then_stops_compute_and_retains_an_offline_view() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    fs::create_dir(&project).unwrap();
    git(&project, &["init", "-q"]);
    git(&project, &["config", "user.name", "Supervisor test"]);
    git(
        &project,
        &["config", "user.email", "supervisor@test.invalid"],
    );
    fs::write(project.join("tracked.txt"), "original source\n").unwrap();
    git(&project, &["add", "tracked.txt"]);
    git(&project, &["commit", "-qm", "baseline"]);
    let baseline = source::capture_source(&project, CaptureLimits::default())
        .await
        .unwrap();
    fs::write(project.join("tracked.txt"), "cloud result\n").unwrap();
    let output = source::capture_source(&project, CaptureLimits::default())
        .await
        .unwrap();
    fs::write(project.join("tracked.txt"), "original source\n").unwrap();
    let state_path = directory.path().join("daemon.json");
    let manager = CloudManager::new(&state_path);
    let preview = manager
        .capture("local-workspace".into(), project.clone())
        .await
        .unwrap();
    let mut record = stored_native_job(project.clone(), CloudJobStatus::Completed);
    record.job.source = preview;
    let id = record.job.id.clone();
    assert!(holds_slot(record.job.status));
    let now = Utc::now().to_rfc3339();
    let detail = json!({
        "workspace":{"id":"worker-ws","path":"/workspace/project","status":"ready","connected_at":now,"updated_at":now},
        "thread":{"id":"native-thread","workspace_id":"worker-ws","title":"Finished native task","status":"idle","updated_at":now},
        "items":[],
    });
    serde_json::from_value::<ThreadDetail>(detail.clone()).unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    record.gateway_url = Some(format!("http://{}", listener.local_addr().unwrap()));
    record.gateway_token = Some(GATEWAY_TOKEN.into());
    let router = Router::new()
        .fallback(idle_worker_snapshot)
        .with_state(IdleWorker {
            detail,
            calls: calls.clone(),
        });
    let server = WorkerServer(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let export = json!({"version":1,"tree_hash":baseline.tree_hash,"current_tree_hash":output.tree_hash,"baseline_files":baseline.files,"current_files":output.files,"deleted_paths":[],"excluded_paths":[],"binary_patch_base64":"","native_sessions":[{"path":".codex/sessions/session.jsonl","content_base64":"e30K"}]});
    let script = directory.path().join("supervisor-runtime.py");
    let log = directory.path().join("runtime-operations");
    fs::write(
        &script,
        format!(
            r#"import json, sys
request = json.load(sys.stdin)
with open({log}, 'a') as output:
    output.write(request['operation'] + '\n')
print(json.dumps(request), file=sys.stderr)
if request['operation'] == 'export':
    print({export})
elif request['operation'] == 'stop':
    print(json.dumps({{'sandbox_id':request['sandbox_id'], 'status':'stopped'}}))
else:
    raise AssertionError('Unexpected runtime operation')
"#,
            log = serde_json::to_string(log.to_str().unwrap()).unwrap(),
            export = serde_json::to_string(&export.to_string()).unwrap()
        ),
    )
    .unwrap();
    let mut settings = Settings::default();
    settings.public.node_binary = "/usr/bin/python3".into();
    settings.public.runtime_path = script.to_str().unwrap().into();
    settings.provider_token = PROVIDER_TOKEN.into();
    settings.openai_api_key = MODEL_KEY.into();
    store::write_json(&manager.path("settings.json"), &settings).unwrap();
    let mut registry = Registry::default();
    registry.jobs.insert(id.clone(), record);
    manager.save(&registry).unwrap();
    manager.supervise_tick().await.unwrap();
    let saved = manager.registry().unwrap().jobs.remove(&id).unwrap();
    assert_eq!(saved.job.status, CloudJobStatus::Stopped);
    assert!(!holds_slot(saved.job.status));
    let result = saved.job.result.as_ref().unwrap();
    assert_eq!(result.changed_paths, vec!["tracked.txt"]);
    assert_eq!(result.native_session_count, 1);
    assert!(result.imported_at.is_none());
    assert!(saved.gateway_url.is_none() && saved.gateway_token.is_none());
    assert_eq!(fs::read_to_string(log).unwrap(), "export\nstop\n");
    assert_eq!(
        fs::read_to_string(project.join("tracked.txt")).unwrap(),
        "original source\n"
    );
    server.0.abort();
    drop(manager);
    let restarted = CloudManager::new(&state_path);
    let archived = restarted.detail_with_requests(&id).await.unwrap();
    assert!(!archived.is_live);
    assert!(archived.collected_at.is_some());
    assert!(archived.interactive_requests.is_empty());
    assert_eq!(archived.detail.thread.id, "native-thread");
    let public = serde_json::to_string(&(saved.job, archived)).unwrap();
    for secret in [PROVIDER_TOKEN, MODEL_KEY, GATEWAY_TOKEN] {
        assert!(!public.contains(secret));
    }
    let artifact: ResultRecord = store::read_json(&restarted.result_path(&id).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(artifact.native_sessions.len(), 1);
    assert!(artifact.native_detail.is_some());
}

#[tokio::test]
async fn supervisor_keeps_compute_while_native_background_work_remains() {
    use std::sync::atomic::Ordering;
    for native_status in ["idle", "error"] {
        let directory = tempfile::tempdir().unwrap();
        let manager = CloudManager::new(&directory.path().join("daemon.json"));
        let mut record = stored_native_job(directory.path().into(), CloudJobStatus::Running);
        let id = record.job.id.clone();
        let now = Utc::now().to_rfc3339();
        let detail = json!({"workspace":{"id":"worker-ws","path":"/workspace/project","status":"ready","connected_at":now,"updated_at":now},"thread":{"id":"native-thread","workspace_id":"worker-ws","title":"Background work remains","status":native_status,"background_task_count":1,"updated_at":now},"items":[]});
        serde_json::from_value::<ThreadDetail>(detail.clone()).unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        record.gateway_url = Some(format!("http://{}", listener.local_addr().unwrap()));
        record.gateway_token = Some(GATEWAY_TOKEN.into());
        let router = Router::new()
            .fallback(idle_worker_snapshot)
            .with_state(IdleWorker {
                detail,
                calls: calls.clone(),
            });
        let _server = WorkerServer(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }));
        let mut registry = Registry::default();
        registry.jobs.insert(id.clone(), record);
        manager.save(&registry).unwrap();
        assert_eq!(
            manager.get(&id).await.unwrap().status,
            CloudJobStatus::Running
        );
        manager.supervise_tick().await.unwrap();
        let saved = manager.registry().unwrap().jobs.remove(&id).unwrap();
        assert_eq!(saved.job.status, CloudJobStatus::Running);
        assert!(holds_slot(saved.job.status));
        assert!(saved.job.result.is_none() && saved.job.error.is_none());
        assert!(saved.gateway_token.is_some());
        // Only native status reads: no snapshot/export/stop despite foreground idle/error.
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(manager.registry().unwrap().collection_attempts.is_empty());
    }
}
