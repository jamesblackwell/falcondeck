use super::{
    source::{self, CaptureLimits, SourceCapture, SourceDelta},
    store,
};
use crate::error::DaemonError;
use chrono::{DateTime, Utc};
use falcondeck_core::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Mutex,
};

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    public: CloudSettings,
    provider_token: String,
    openai_api_key: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            public: CloudSettings {
                enabled: false,
                has_provider_token: false,
                has_openai_api_key: false,
                team_id: None,
                project_id: None,
                image: String::new(),
                timeout_minutes: 30,
                node_binary: "node".into(),
                runtime_path: String::new(),
                worker_daemon_url: String::new(),
                worker_daemon_sha256: String::new(),
                allowed_domains: vec!["api.openai.com".into()],
            },
            provider_token: String::new(),
            openai_api_key: String::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct CaptureRecord {
    preview: CloudSourcePreview,
    root: PathBuf,
    source: SourceCapture,
}
#[derive(Clone, Serialize, Deserialize)]
struct JobRecord {
    job: CloudJob,
    request: CreateCloudJobRequest,
    root: PathBuf,
    sandbox_id: String,
    gateway_url: Option<String>,
    gateway_token: Option<String>,
    #[serde(default)]
    provider_scope: Option<(String, String)>,
    #[serde(default)]
    awaiting_user_after_resume: bool,
}
#[derive(Default, Serialize, Deserialize)]
struct Registry {
    jobs: BTreeMap<String, JobRecord>,
    #[serde(default)]
    collection_attempts: BTreeMap<String, u8>,
}
#[derive(Clone, Serialize, Deserialize)]
struct ResultRecord {
    output: SourceCapture,
    delta: SourceDelta,
    native_sessions: Vec<Value>,
    binary_patch_base64: Option<String>,
    #[serde(default)]
    native_detail: Option<CloudJobDetail>,
    #[serde(default)]
    import_baseline: Option<SourceCapture>,
}

pub(crate) struct CloudManager {
    root: PathBuf,
    mutation: Mutex<()>,
    execution: Mutex<()>,
    supervisor_started: std::sync::atomic::AtomicBool,
    client: reqwest::Client,
}
impl CloudManager {
    pub(crate) fn new(state_path: &Path) -> Arc<Self> {
        let root = state_path.with_file_name("cloud");
        if let Ok(Some(mut registry)) = store::read_json::<Registry>(&root.join("jobs.json")) {
            let mut changed = false;
            for record in registry.jobs.values_mut() {
                if matches!(
                    record.job.status,
                    CloudJobStatus::Provisioning | CloudJobStatus::Stopping
                ) {
                    record.job.status = CloudJobStatus::Unknown;
                    record.job.error=Some("Coordinator restarted during a cloud operation. Inspect or stop this job before launching another.".into());
                    changed = true;
                }
            }
            if changed {
                let _ = store::write_json(&root.join("jobs.json"), &registry);
            }
        }
        let manager = Arc::new(Self {
            root: state_path.with_file_name("cloud"),
            mutation: Mutex::new(()),
            execution: Mutex::new(()),
            supervisor_started: std::sync::atomic::AtomicBool::new(false),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .expect("HTTP client"),
        });
        manager.start_supervisor();
        manager
    }
    fn start_supervisor(self: &Arc<Self>) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        if self
            .supervisor_started
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return;
        }
        let weak = Arc::downgrade(self);
        handle.spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(15));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            timer.tick().await;
            loop {
                timer.tick().await;
                let Some(manager) = weak.upgrade() else {
                    break;
                };
                let _ = manager.supervise_tick().await;
            }
        });
    }
    pub(crate) async fn supervise_tick(&self) -> Result<(), DaemonError> {
        let Ok(_execution) = self.execution.try_lock() else {
            return Ok(());
        };
        for job in self.list_stored().await? {
            if matches!(
                job.status,
                CloudJobStatus::Provisioning | CloudJobStatus::Stopped | CloudJobStatus::Expired
            ) {
                continue;
            }
            let refreshed = self.get_inner(&job.id).await?;
            if matches!(
                refreshed.status,
                CloudJobStatus::Completed | CloudJobStatus::Failed
            ) && refreshed.worker.is_some()
            {
                if refreshed.result.is_none() {
                    if self.collect_inner(&job.id).await.is_err() {
                        let attempts = {
                            let _gate = self.mutation.lock().await;
                            let mut registry = self.registry()?;
                            let counter = registry
                                .collection_attempts
                                .entry(job.id.clone())
                                .or_default();
                            *counter = counter.saturating_add(1);
                            let attempts = *counter;
                            self.save(&registry)?;
                            attempts
                        };
                        if attempts >= 3 {
                            let stopped = self.stop_inner(&job.id).await?;
                            if stopped.status == CloudJobStatus::Stopped {
                                self.set_status(&job.id,CloudJobStatus::Stopped,Some("Automatic collection failed after three attempts. The stopped sandbox is retained for up to 24 hours; resume it to retry collection.".into())).await?;
                            }
                        } else {
                            self.set_status(&job.id,refreshed.status,Some("Automatic result collection failed. The bounded worker is retained for retry; its configured lifetime still applies.".into())).await?;
                        }
                        continue;
                    }
                }
                self.stop_inner(&job.id).await?;
            }
        }
        Ok(())
    }
    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn settings_private(&self) -> Result<Settings, DaemonError> {
        Ok(store::read_json(&self.path("settings.json"))?.unwrap_or_default())
    }
    fn settings_for_job(&self, record: &JobRecord) -> Result<Settings, DaemonError> {
        let mut settings = self.settings_private()?;
        if let Some((team, project)) = &record.provider_scope {
            settings.public.team_id = Some(team.clone());
            settings.public.project_id = Some(project.clone());
        }
        Ok(settings)
    }
    fn registry(&self) -> Result<Registry, DaemonError> {
        Ok(store::read_json(&self.path("jobs.json"))?.unwrap_or_default())
    }
    fn save(&self, registry: &Registry) -> Result<(), DaemonError> {
        store::write_json(&self.path("jobs.json"), registry)
    }
    fn capture_path(&self, id: &str) -> Result<PathBuf, DaemonError> {
        validate_id(id)?;
        Ok(self.path(&format!("capture-{id}.json")))
    }
    fn import_baseline_path(&self, id: &str) -> Result<PathBuf, DaemonError> {
        validate_id(id)?;
        Ok(self.path(&format!("import-base-{id}.json")))
    }
    fn result_path(&self, id: &str) -> Result<PathBuf, DaemonError> {
        validate_id(id)?;
        Ok(self.path(&format!("result-{id}.json")))
    }
    fn capture_record(&self, id: &str) -> Result<CaptureRecord, DaemonError> {
        store::read_json(&self.capture_path(id)?)?
            .ok_or_else(|| DaemonError::NotFound("Source capture not found".into()))
    }
    pub(crate) async fn settings(&self) -> Result<CloudSettings, DaemonError> {
        let _gate = self.mutation.lock().await;
        Ok(self.settings_private()?.public)
    }
    pub(crate) async fn update_settings(
        &self,
        r: UpdateCloudSettingsRequest,
    ) -> Result<CloudSettings, DaemonError> {
        let _gate = self.mutation.lock().await;
        let mut s = self.settings_private()?;
        if let Some(v) = r.enabled {
            s.public.enabled = v;
        }
        if let Some(v) = r.provider_token {
            s.provider_token = v.trim().into();
        }
        if let Some(v) = r.openai_api_key {
            s.openai_api_key = v.trim().into();
        }
        if let Some(v) = r.team_id {
            s.public.team_id = nonempty(v);
        }
        if let Some(v) = r.project_id {
            s.public.project_id = nonempty(v);
        }
        if let Some(v) = r.image {
            s.public.image = v;
        }
        if let Some(v) = r.timeout_minutes {
            if !(1..=1440).contains(&v) {
                return Err(bad("Cloud lifetime must be between 1 and 1440 minutes"));
            }
            s.public.timeout_minutes = v;
        }
        if let Some(v) = r.node_binary {
            s.public.node_binary = v;
        }
        if let Some(v) = r.runtime_path {
            s.public.runtime_path = v;
        }
        if let Some(v) = r.worker_daemon_url {
            s.public.worker_daemon_url = v;
        }
        if let Some(v) = r.worker_daemon_sha256 {
            s.public.worker_daemon_sha256 = v;
        }
        if let Some(v) = r.allowed_domains {
            s.public.allowed_domains = v;
        }
        s.public.has_provider_token = !s.provider_token.is_empty();
        s.public.has_openai_api_key = !s.openai_api_key.is_empty();
        validate_settings(&s, false)?;
        store::write_json(&self.path("settings.json"), &s)?;
        Ok(s.public)
    }
    pub(crate) async fn capture(
        &self,
        workspace_id: String,
        root: PathBuf,
    ) -> Result<CloudSourcePreview, DaemonError> {
        let source = source::capture_source(&root, CaptureLimits::default())
            .await
            .map_err(|_| bad("Source capture rejected unsafe or oversized files"))?;
        let id = uuid::Uuid::new_v4().to_string();
        let preview = CloudSourcePreview {
            id: id.clone(),
            workspace_id,
            base_head: source.base_head.clone(),
            tree_hash: source.tree_hash.clone(),
            included_paths: source.files.iter().map(|f| f.path.clone()).collect(),
            excluded_paths: source.excluded_paths.clone(),
            total_bytes: source.total_bytes,
            created_at: Utc::now(),
        };
        let _gate = self.mutation.lock().await;
        store::write_json(
            &self.capture_path(&id)?,
            &CaptureRecord {
                preview: preview.clone(),
                root,
                source,
            },
        )?;
        Ok(preview)
    }
    pub(crate) async fn create(
        self: &Arc<Self>,
        r: CreateCloudJobRequest,
        root: PathBuf,
    ) -> Result<CloudJob, DaemonError> {
        self.start_supervisor();
        if r.prompt.trim().is_empty() || r.prompt.len() > 128 * 1024 {
            return Err(bad("Enter a prompt of at most 128 KiB"));
        }
        if r.idempotency_key.len() < 8 || r.idempotency_key.len() > 128 {
            return Err(bad(
                "A stable idempotency key of 8–128 characters is required",
            ));
        }
        // Check before capturing; exact retries must work even after a local edit.
        {
            let _gate = self.mutation.lock().await;
            if let Some(job) = existing_request(&self.registry()?, &r)? {
                return Ok(job);
            }
        }
        let capture_id = match &r.source_capture_id {
            Some(id) => id.clone(),
            None => self.capture(r.workspace_id.clone(), root.clone()).await?.id,
        };
        let _gate = self.mutation.lock().await;
        let settings = self.settings_private()?;
        validate_settings(&settings, true)?;
        let mut registry = self.registry()?;
        if let Some(job) = existing_request(&registry, &r)? {
            return Ok(job);
        }
        if registry.jobs.values().any(|j| holds_slot(j.job.status)) {
            return Err(DaemonError::Conflict(
                "Another cloud job is active or needs reconciliation".into(),
            ));
        }
        let capture = self.capture_record(&capture_id)?;
        if capture.preview.workspace_id != r.workspace_id || capture.root != root {
            return Err(bad("Source capture belongs to another workspace"));
        }
        source::validate_capture(&capture.source, CaptureLimits::default())
            .map_err(|_| bad("Source capture no longer validates"))?;
        // The reviewed capture is immutable; unrelated ongoing local work stays local.
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let job = CloudJob {
            id: id.clone(),
            workspace_id: r.workspace_id.clone(),
            source: capture.preview,
            status: CloudJobStatus::Provisioning,
            prompt: r.prompt.clone(),
            model_id: r.model_id.clone(),
            worker: None,
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
            expires_at: None,
        };
        registry.jobs.insert(
            id.clone(),
            JobRecord {
                job: job.clone(),
                request: r,
                root,
                sandbox_id: format!("fd-cloud-{id}"),
                gateway_url: None,
                gateway_token: None,
                awaiting_user_after_resume: false,
                provider_scope: Some((
                    settings.public.team_id.clone().unwrap_or_default(),
                    settings.public.project_id.clone().unwrap_or_default(),
                )),
            },
        );
        self.save(&registry)?;
        let this = self.clone();
        tokio::spawn(async move {
            this.launch(id, settings, capture.source).await;
        });
        Ok(job)
    }
    async fn launch(self: Arc<Self>, id: String, settings: Settings, source: SourceCapture) {
        let _execution = self.execution.lock().await;
        let outcome = self.launch_inner(&id, &settings, source).await;
        if outcome.is_err() {
            let _gate = self.mutation.lock().await;
            if let Ok(mut r) = self.registry() {
                if let Some(j) = r.jobs.get_mut(&id) {
                    // A killed coordinator or a timed-out SDK call may already have allocated.
                    j.job.status = CloudJobStatus::Unknown;
                    j.job.error=Some("Cloud launch outcome is unknown. Inspect or stop this job before starting another.".into());
                    j.job.updated_at = Utc::now();
                    let _ = self.save(&r);
                }
            }
        }
    }
    async fn launch_inner(
        &self,
        id: &str,
        s: &Settings,
        source: SourceCapture,
    ) -> Result<(), DaemonError> {
        let record = self.record(id).await?;
        let created=self.runtime(s,json!({"operation":"create","name":record.sandbox_id,"image":s.public.image,"timeout_ms":u64::from(s.public.timeout_minutes)*60_000,"cpus":2,"allowed_domains":s.public.allowed_domains,"worker_daemon_url":s.public.worker_daemon_url,"worker_daemon_sha256":s.public.worker_daemon_sha256,"openai_api_key":s.openai_api_key,"source":source})).await?;
        let gateway_url = required_str(&created, "gateway_url")?;
        validate_gateway(&gateway_url)?;
        let gateway_token = required_str(&created, "gateway_token")?;
        if gateway_token.len() < 24 {
            return Err(bad("Worker gateway credential is invalid"));
        }
        let sandbox_id = required_str(&created, "sandbox_id")?;
        if sandbox_id != record.sandbox_id {
            return Err(bad("Runtime returned a different sandbox identity"));
        }
        let max_expiry =
            record.job.created_at + chrono::Duration::minutes(i64::from(s.public.timeout_minutes));
        let expiry = created
            .get("expires_at")
            .and_then(Value::as_str)
            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.with_timezone(&Utc))
            .unwrap_or(max_expiry)
            .min(max_expiry);
        {
            let _gate = self.mutation.lock().await;
            let mut r = self.registry()?;
            let j = r.jobs.get_mut(id).ok_or_else(not_found)?;
            j.gateway_url = Some(gateway_url);
            j.gateway_token = Some(gateway_token);
            j.job.expires_at = Some(expiry);
            self.save(&r)?;
        }
        let mut record = self.record(id).await?;
        let workspace = self
            .worker(
                &record,
                "POST",
                "/api/workspaces/connect",
                Some(json!({"path":"/workspace/project","kind":"project"})),
            )
            .await?;
        let wid = required_str(&workspace, "id")?;
        validate_segment(&wid)?;
        let thread=self.worker(&record,"POST",&format!("/api/workspaces/{wid}/threads"),Some(json!({"workspace_id":wid,"provider":"codex","model_id":record.job.model_id,"approval_policy":"on-request","sandbox_mode":"workspace-write"}))).await?;
        let tid = required_str(
            thread
                .get("thread")
                .ok_or_else(|| bad("Worker thread handle is incomplete"))?,
            "id",
        )?;
        validate_segment(&wid)?;
        validate_segment(&tid)?;
        record.job.worker = Some(CloudWorkerLocator {
            workspace_id: wid.clone(),
            thread_id: tid.clone(),
            provider: "codex".into(),
        });
        {
            let _gate = self.mutation.lock().await;
            let mut r = self.registry()?;
            r.jobs.get_mut(id).ok_or_else(not_found)?.job.worker = record.job.worker.clone();
            self.save(&r)?;
        }
        // Persist the locator before admission. A lost response must never resend this first prompt.
        self.worker(&record,"POST",&format!("/api/workspaces/{wid}/threads/{tid}/turns"),Some(json!({"workspace_id":wid,"thread_id":tid,"inputs":[{"type":"text","text":record.job.prompt}],"model_id":record.job.model_id,"user_item_id":format!("user-cloud-{id}")}))).await?;
        let _gate = self.mutation.lock().await;
        let mut r = self.registry()?;
        let j = r.jobs.get_mut(id).ok_or_else(not_found)?;
        j.job.status = CloudJobStatus::Running;
        j.job.updated_at = Utc::now();
        self.save(&r)
    }
    pub(crate) async fn list(&self) -> Result<Vec<CloudJob>, DaemonError> {
        let jobs = self.list_stored().await?;
        let mut refreshed = Vec::with_capacity(jobs.len());
        for job in jobs {
            if matches!(
                job.status,
                CloudJobStatus::Running
                    | CloudJobStatus::AwaitingInput
                    | CloudJobStatus::Unknown
                    | CloudJobStatus::Provisioning
                    | CloudJobStatus::Stopping
            ) {
                refreshed.push(self.get(&job.id).await.unwrap_or(job));
            } else {
                refreshed.push(job);
            }
        }
        Ok(refreshed)
    }
    async fn list_stored(&self) -> Result<Vec<CloudJob>, DaemonError> {
        let _gate = self.mutation.lock().await;
        let mut jobs = self
            .registry()?
            .jobs
            .into_values()
            .map(|r| r.job)
            .collect::<Vec<_>>();
        jobs.sort_by_key(|j| std::cmp::Reverse(j.created_at));
        Ok(jobs)
    }
    async fn record(&self, id: &str) -> Result<JobRecord, DaemonError> {
        validate_id(id)?;
        let _gate = self.mutation.lock().await;
        self.registry()?.jobs.remove(id).ok_or_else(not_found)
    }
    pub(crate) async fn get(&self, id: &str) -> Result<CloudJob, DaemonError> {
        let Ok(_execution) = self.execution.try_lock() else {
            return Ok(self.record(id).await?.job);
        };
        self.get_inner(id).await
    }
    async fn get_inner(&self, id: &str) -> Result<CloudJob, DaemonError> {
        let record = self.record(id).await?;
        if matches!(
            record.job.status,
            CloudJobStatus::Stopped | CloudJobStatus::Expired
        ) {
            return Ok(record.job);
        }
        if record.job.expires_at.is_some_and(|t| t <= Utc::now()) {
            return self.set_status(id, CloudJobStatus::Expired, None).await;
        }
        if record.job.status == CloudJobStatus::Provisioning {
            return Ok(record.job);
        }
        if record.job.worker.is_some() {
            if let Ok(detail) = self.detail(id).await {
                let status = match detail.thread.status {
                    ThreadStatus::Idle | ThreadStatus::Error
                        if detail.thread.background_task_count > 0 =>
                    {
                        CloudJobStatus::Running
                    }
                    ThreadStatus::Idle if record.awaiting_user_after_resume => {
                        CloudJobStatus::AwaitingInput
                    }
                    ThreadStatus::Idle => CloudJobStatus::Completed,
                    ThreadStatus::Running => CloudJobStatus::Running,
                    ThreadStatus::WaitingForInput => CloudJobStatus::AwaitingInput,
                    ThreadStatus::Error => CloudJobStatus::Failed,
                };
                let error = record
                    .job
                    .error
                    .as_ref()
                    .filter(|v| v.starts_with("Automatic"))
                    .cloned();
                return self.set_status(id, status, error).await;
            }
        }
        if record.job.status == CloudJobStatus::Unknown {
            let settings = {
                let _gate = self.mutation.lock().await;
                self.settings_for_job(&record)?
            };
            if let Ok(v) = self
                .runtime(
                    &settings,
                    json!({"operation":"inspect","sandbox_id":record.sandbox_id}),
                )
                .await
            {
                if v.get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|v| matches!(v, "stopped" | "deleted"))
                {
                    return self.set_status(id, CloudJobStatus::Stopped, None).await;
                }
            }
        }
        Ok(record.job)
    }
    async fn set_status(
        &self,
        id: &str,
        status: CloudJobStatus,
        error: Option<String>,
    ) -> Result<CloudJob, DaemonError> {
        let _gate = self.mutation.lock().await;
        let mut r = self.registry()?;
        let j = r.jobs.get_mut(id).ok_or_else(not_found)?;
        j.job.status = status;
        j.job.error = error;
        j.job.updated_at = Utc::now();
        let job = j.job.clone();
        self.save(&r)?;
        Ok(job)
    }
    pub(crate) async fn detail(&self, id: &str) -> Result<ThreadDetail, DaemonError> {
        let record = self.record(id).await?;
        let w =
            record.job.worker.as_ref().ok_or_else(|| {
                DaemonError::Conflict("Native worker is not connected yet".into())
            })?;
        let value = self
            .worker(
                &record,
                "GET",
                &format!(
                    "/api/workspaces/{}/threads/{}?mode=full&refresh_native=true",
                    w.workspace_id, w.thread_id
                ),
                None,
            )
            .await?;
        serde_json::from_value(value)
            .map_err(|_| bad("Worker returned an incompatible native thread"))
    }
    pub(crate) async fn detail_with_requests(
        &self,
        id: &str,
    ) -> Result<CloudJobDetail, DaemonError> {
        let record = self.record(id).await?;
        if !matches!(
            record.job.status,
            CloudJobStatus::Stopped | CloudJobStatus::Expired
        ) {
            if let Ok(detail) = self.detail_live(id).await {
                return Ok(detail);
            }
        }
        if record.job.result.is_none() {
            return Err(bad(
                "Native worker is unavailable; collect this turn before stopping to retain a transcript view",
            ));
        }
        let artifact: ResultRecord =
            store::read_json(&self.result_path(id)?)?.ok_or_else(|| {
                bad("Native worker is unavailable and no collected transcript export is retained")
            })?;
        let mut detail = artifact.native_detail.ok_or_else(|| {
            bad("Collected native sessions have no saved view; source results remain available")
        })?;
        detail.is_live = false;
        detail.interactive_requests.clear();
        detail.collected_at = record.job.result.map(|r| r.collected_at);
        Ok(detail)
    }
    async fn detail_live(&self, id: &str) -> Result<CloudJobDetail, DaemonError> {
        let detail = self.detail(id).await?;
        let record = self.record(id).await?;
        let w = record.job.worker.as_ref().ok_or_else(not_found)?;
        let snapshot = self.worker(&record, "GET", "/api/snapshot", None).await?;
        let requests = snapshot
            .get("interactive_requests")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let interactive_requests = requests
            .into_iter()
            .filter(|r| {
                r.get("workspace_id").and_then(Value::as_str) == Some(w.workspace_id.as_str())
                    && r.get("thread_id").and_then(Value::as_str) == Some(w.thread_id.as_str())
            })
            .map(serde_json::from_value)
            .collect::<Result<Vec<InteractiveRequest>, _>>()
            .map_err(|_| bad("Worker pending requests are incompatible"))?;
        Ok(CloudJobDetail {
            detail,
            interactive_requests,
            is_live: true,
            collected_at: None,
        })
    }
    pub(crate) async fn send_turn(
        &self,
        id: &str,
        mut request: SendTurnRequest,
    ) -> Result<CommandResponse, DaemonError> {
        let _execution = self.execution.lock().await;
        let _gate = self.mutation.lock().await;
        let mut registry = self.registry()?;
        if registry
            .jobs
            .iter()
            .any(|(other, r)| other != id && holds_slot(r.job.status))
        {
            return Err(DaemonError::Conflict("Another cloud job is active".into()));
        }
        let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
        if !matches!(
            record.job.status,
            CloudJobStatus::Running | CloudJobStatus::AwaitingInput | CloudJobStatus::Completed
        ) {
            return Err(DaemonError::Conflict(
                "Cloud job cannot accept another turn in its current state".into(),
            ));
        }
        let w = record.job.worker.clone().ok_or_else(not_found)?;
        request.workspace_id = w.workspace_id.clone();
        request.thread_id = w.thread_id.clone();
        let body = serde_json::to_value(request)?;
        record.awaiting_user_after_resume = false;
        record.job.status = CloudJobStatus::Unknown;
        record.job.updated_at = Utc::now();
        record.job.result = None;
        record.job.error=Some("Turn admission is pending. Inspect the native thread before retrying if the coordinator disconnects".into());
        let worker_record = record.clone();
        // A restart after native admission must retain the active slot and never resend.
        registry.collection_attempts.remove(id);
        self.save(&registry)?;
        let response = self
            .worker(
                &worker_record,
                "POST",
                &format!(
                    "/api/workspaces/{}/threads/{}/turns",
                    w.workspace_id, w.thread_id
                ),
                Some(body),
            )
            .await;
        let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
        record.job.status = if response.is_ok() {
            CloudJobStatus::Running
        } else {
            CloudJobStatus::Unknown
        };
        record.job.updated_at = Utc::now();
        record.job.result = None;
        if response.is_ok() {
            record.job.error = None;
        }
        if response.is_err() {
            record.job.error = Some(
                "Turn admission outcome is unknown; inspect the native thread before retrying"
                    .into(),
            );
        }
        self.save(&registry)?;
        parse_command(response?)
    }
    pub(crate) async fn interrupt(&self, id: &str) -> Result<CommandResponse, DaemonError> {
        let record = self.record(id).await?;
        let w = record.job.worker.as_ref().ok_or_else(not_found)?;
        parse_command(
            self.worker(
                &record,
                "POST",
                &format!(
                    "/api/workspaces/{}/threads/{}/interrupt",
                    w.workspace_id, w.thread_id
                ),
                Some(json!({})),
            )
            .await?,
        )
    }
    pub(crate) async fn respond(
        &self,
        id: &str,
        request_id: &str,
        approval: bool,
        body: Value,
    ) -> Result<CommandResponse, DaemonError> {
        validate_segment(request_id)?;
        let record = self.record(id).await?;
        let w = record.job.worker.as_ref().ok_or_else(not_found)?;
        parse_command(
            self.worker(
                &record,
                "POST",
                &format!(
                    "/api/workspaces/{}/{}/{}/respond",
                    w.workspace_id,
                    if approval {
                        "approvals"
                    } else {
                        "interactive-requests"
                    },
                    request_id
                ),
                Some(body),
            )
            .await?,
        )
    }
    pub(crate) async fn collect(&self, id: &str) -> Result<CloudJob, DaemonError> {
        let _execution = self.execution.lock().await;
        self.collect_inner(id).await
    }
    async fn collect_inner(&self, id: &str) -> Result<CloudJob, DaemonError> {
        let job = self.get_inner(id).await?;
        if !matches!(
            job.status,
            CloudJobStatus::Completed | CloudJobStatus::Failed
        ) {
            return Err(DaemonError::Conflict(
                "Interrupt or finish the native turn before collecting results".into(),
            ));
        }
        let native_detail = self.detail_live(id).await.ok();
        let _gate = self.mutation.lock().await;
        let mut registry = self.registry()?;
        let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
        let settings = self.settings_for_job(record)?;
        let capture = self.capture_record(&record.job.source.id)?;
        let export = self
            .runtime(
                &settings,
                json!({"operation":"export","sandbox_id":record.sandbox_id}),
            )
            .await?;
        let mut baseline:SourceCapture=serde_json::from_value(json!({"files":export.get("baseline_files"),"baseHead":capture.source.base_head,"treeHash":export.get("tree_hash"),"excludedPaths":[],"totalBytes":0})).map_err(|_|bad("Worker export baseline is invalid"))?;
        baseline.total_bytes = decoded_size(&baseline)?;
        source::validate_capture(&baseline, CaptureLimits::default())
            .map_err(|_| bad("Worker export baseline fingerprint is invalid"))?;
        if baseline.tree_hash != capture.source.tree_hash {
            return Err(bad("Worker export does not match the uploaded source"));
        }
        let files = export
            .get("current_files")
            .cloned()
            .ok_or_else(|| bad("Worker export has no source files"))?;
        let mut output:SourceCapture=serde_json::from_value(json!({"files":files,"baseHead":capture.source.base_head,"treeHash":export.get("current_tree_hash").and_then(Value::as_str).unwrap_or(""),"excludedPaths":export.get("excluded_paths").cloned().unwrap_or_else(||json!([])),"totalBytes":0})).map_err(|_|bad("Worker source export is invalid"))?;
        output.total_bytes = decoded_size(&output)?;
        source::validate_capture(&output, CaptureLimits::default())
            .map_err(|_| bad("Worker result contains unsafe or oversized paths"))?;
        let import_baseline: SourceCapture = store::read_json(&self.import_baseline_path(id)?)?
            .unwrap_or_else(|| capture.source.clone());
        let delta = source::delta_between(&import_baseline, &output)
            .map_err(|_| bad("Worker result does not match its source baseline"))?;
        let native_sessions = export
            .get("native_sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let result = CloudJobResult {
            collected_at: Utc::now(),
            tree_hash: output.tree_hash.clone(),
            changed_paths: delta.files.iter().map(|f| f.path.clone()).collect(),
            deleted_paths: delta.deleted_paths.clone(),
            native_session_count: native_sessions.len(),
            imported_at: None,
        };
        store::write_json(
            &self.result_path(id)?,
            &ResultRecord {
                output,
                delta,
                native_sessions: native_sessions.clone(),
                import_baseline: Some(import_baseline),
                native_detail: if native_sessions.is_empty() {
                    None
                } else {
                    native_detail
                },
                binary_patch_base64: export
                    .get("binary_patch_base64")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
        )?;
        record.job.result = Some(result);
        record.job.updated_at = Utc::now();
        let job = record.job.clone();
        self.save(&registry)?;
        Ok(job)
    }
    pub(crate) async fn import(&self, id: &str) -> Result<CloudJob, DaemonError> {
        let _execution = self.execution.lock().await;
        let _gate = self.mutation.lock().await;
        let mut registry = self.registry()?;
        let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
        if !matches!(
            record.job.status,
            CloudJobStatus::Completed
                | CloudJobStatus::Failed
                | CloudJobStatus::Stopped
                | CloudJobStatus::Expired
        ) {
            return Err(DaemonError::Conflict(
                "Finish or stop this job before importing".into(),
            ));
        }
        let result = record
            .job
            .result
            .as_mut()
            .ok_or_else(|| bad("Collect the result before importing"))?;
        if result.imported_at.is_some() {
            return Ok(record.job.clone());
        }
        let artifact: ResultRecord = store::read_json(&self.result_path(id)?)?
            .ok_or_else(|| bad("Collected result is unavailable"))?;
        let capture = self.capture_record(&record.job.source.id)?;
        source::import_delta(&record.root,artifact.import_baseline.as_ref().unwrap_or(&capture.source),&artifact.delta,CaptureLimits::default()).await.map_err(|_|DaemonError::Conflict("Local source changed or result could not be applied safely; no automatic merge is attempted".into()))?;
        store::write_json(&self.import_baseline_path(id)?, &artifact.output)?;
        result.imported_at = Some(Utc::now());
        record.job.updated_at = Utc::now();
        let job = record.job.clone();
        self.save(&registry)?;
        Ok(job)
    }
    pub(crate) async fn resume(&self, id: &str) -> Result<CloudJob, DaemonError> {
        let _execution = self.execution.lock().await;
        let (record, settings) = {
            let _gate = self.mutation.lock().await;
            let mut registry = self.registry()?;
            if registry
                .jobs
                .iter()
                .any(|(other, r)| other != id && holds_slot(r.job.status))
            {
                return Err(DaemonError::Conflict("Another cloud job is active".into()));
            }
            let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
            let settings = self.settings_for_job(record)?;
            validate_settings(&settings, true)?;
            if !matches!(
                record.job.status,
                CloudJobStatus::Stopped | CloudJobStatus::Expired
            ) {
                return Err(DaemonError::Conflict(
                    "Stop or reconcile this cloud job before resuming".into(),
                ));
            }
            if record.job.worker.is_none() {
                return Err(DaemonError::Conflict(
                    "This job never connected a native thread. Start a new task after stopping it"
                        .into(),
                ));
            }
            record.awaiting_user_after_resume = true;
            record.job.status = CloudJobStatus::Provisioning;
            record.job.error = None;
            record.job.result = None;
            record.job.updated_at = Utc::now();
            let copy = record.clone();
            registry.collection_attempts.remove(id);
            self.save(&registry)?;
            (copy, settings)
        };
        let outcome=self.runtime(&settings,json!({"operation":"resume","sandbox_id":record.sandbox_id,"openai_api_key":settings.openai_api_key,"timeout_ms":u64::from(settings.public.timeout_minutes)*60_000})).await;
        let update = async {
            let reply = outcome?;
            if required_str(&reply, "sandbox_id")? != record.sandbox_id {
                return Err(bad("Runtime returned a different sandbox identity"));
            }
            let gateway = required_str(&reply, "gateway_url")?;
            validate_gateway(&gateway)?;
            let token = required_str(&reply, "gateway_token")?;
            if token.len() < 24 {
                return Err(bad("Worker gateway credential is invalid"));
            }
            let deadline =
                Utc::now() + chrono::Duration::minutes(i64::from(settings.public.timeout_minutes));
            let expires_at = reply
                .get("expires_at")
                .and_then(Value::as_str)
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.with_timezone(&Utc))
                .unwrap_or(deadline)
                .min(deadline);
            // Journal the rotated capability before permitting any further native call.
            {
                let _gate = self.mutation.lock().await;
                let mut registry = self.registry()?;
                let item = registry.jobs.get_mut(id).ok_or_else(not_found)?;
                item.gateway_url = Some(gateway);
                item.gateway_token = Some(token);
                item.job.expires_at = Some(expires_at);
                self.save(&registry)?;
            }
            // The restored native store can finish loading shortly after HTTP health.
            for _ in 0..20 {
                if let Ok(detail) = self.detail(id).await {
                    let status = match detail.thread.status {
                        ThreadStatus::Idle | ThreadStatus::Error
                            if detail.thread.background_task_count > 0 =>
                        {
                            CloudJobStatus::Running
                        }
                        ThreadStatus::Idle => CloudJobStatus::AwaitingInput,
                        ThreadStatus::Running => CloudJobStatus::Running,
                        ThreadStatus::WaitingForInput => CloudJobStatus::AwaitingInput,
                        ThreadStatus::Error => CloudJobStatus::Failed,
                    };
                    return self.set_status(id, status, None).await;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(bad("The resumed native thread is not yet reachable"))
        }
        .await;
        match update {
            Ok(job)=>Ok(job),
            Err(_)=>self.set_status(id,CloudJobStatus::Unknown,Some("Resume outcome is unknown or the retained snapshot is unavailable. Inspect or stop this job; no replacement sandbox was created.".into())).await,
        }
    }
    pub(crate) async fn stop(&self, id: &str) -> Result<CloudJob, DaemonError> {
        let _execution = self.execution.lock().await;
        self.stop_inner(id).await
    }
    async fn stop_inner(&self, id: &str) -> Result<CloudJob, DaemonError> {
        let _gate = self.mutation.lock().await;
        let mut registry = self.registry()?;
        let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
        if matches!(
            record.job.status,
            CloudJobStatus::Stopped | CloudJobStatus::Expired
        ) {
            return Ok(record.job.clone());
        }
        record.job.status = CloudJobStatus::Stopping;
        record.job.updated_at = Utc::now();
        let snapshot = record.clone();
        self.save(&registry)?;
        let settings = self.settings_for_job(&snapshot)?;
        let outcome = self
            .runtime(
                &settings,
                json!({"operation":"stop","sandbox_id":snapshot.sandbox_id}),
            )
            .await;
        let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
        let confirmed = outcome
            .as_ref()
            .ok()
            .and_then(|v| v.get("status"))
            .and_then(Value::as_str)
            .is_some_and(|v| matches!(v, "stopped" | "deleted"));
        record.job.status = if confirmed {
            CloudJobStatus::Stopped
        } else {
            CloudJobStatus::Unknown
        };
        record.job.error = if confirmed {
            None
        } else {
            Some(
                "Stop outcome is unknown. Inspect this sandbox before launching another job."
                    .into(),
            )
        };
        if record.job.status == CloudJobStatus::Stopped {
            record.gateway_token = None;
            record.gateway_url = None;
        }
        record.job.updated_at = Utc::now();
        let job = record.job.clone();
        self.save(&registry)?;
        Ok(job)
    }
    async fn runtime(&self, s: &Settings, mut input: Value) -> Result<Value, DaemonError> {
        input["credentials"] = json!({"token":s.provider_token,"teamId":s.public.team_id,"projectId":s.public.project_id});
        // Credentials go only through private stdin; neither argv nor inherited env carries them.
        let home = self.path("runtime-home");
        store::write_json(&home.join("ready.json"), &json!({"version":1}))?;
        let mut command = Command::new(&s.public.node_binary);
        command
            .arg(&s.public.runtime_path)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| bad("Cloud runtime could not start; check its configured path"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| bad("Cloud runtime input unavailable"))?;
        let bytes = serde_json::to_vec(&input)?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| bad("Cloud runtime output unavailable"))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| bad("Cloud runtime output unavailable"))?;
        let operation = async {
            let write = async move {
                stdin.write_all(&bytes).await?;
                drop(stdin);
                Ok::<(), std::io::Error>(())
            };
            let out = read_bounded(&mut stdout, 256 << 20);
            let err = read_bounded(&mut stderr, 64 << 10);
            let (_, out, _) = tokio::try_join!(write, out, err)
                .map_err(|_| bad("Cloud runtime connection failed"))?;
            let status = child
                .wait()
                .await
                .map_err(|_| bad("Cloud runtime did not exit cleanly"))?;
            if !status.success() || out.len() > 256 << 20 {
                return Err(bad(
                    "Cloud runtime operation failed; inspect the retained job before retrying",
                ));
            }
            serde_json::from_slice(&out)
                .map_err(|_| bad("Cloud runtime returned an invalid response"))
        };
        tokio::time::timeout(Duration::from_secs(180), operation)
            .await
            .map_err(|_| bad("Cloud runtime timed out; operation outcome may be unknown"))?
    }
    async fn worker(
        &self,
        record: &JobRecord,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, DaemonError> {
        let base = record
            .gateway_url
            .as_ref()
            .ok_or_else(|| bad("Cloud worker gateway is unavailable"))?;
        validate_gateway(base)?;
        let token = record
            .gateway_token
            .as_ref()
            .ok_or_else(|| bad("Cloud worker credential is unavailable"))?;
        let mut request = self
            .client
            .request(
                reqwest::Method::from_bytes(method.as_bytes())
                    .map_err(|_| bad("Invalid worker method"))?,
                format!("{}{path}", base.trim_end_matches('/')),
            )
            .bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| {
            bad("Cloud worker is unreachable; its native process may still be running")
        })?;
        if !response.status().is_success() {
            return Err(bad(
                "Cloud worker request failed; inspect the native thread before retrying",
            ));
        }
        if response.content_length().is_some_and(|n| n > 64 << 20) {
            return Err(bad("Cloud worker response is too large"));
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| bad("Cloud worker response was interrupted"))?
        {
            if bytes.len() + chunk.len() > 64 << 20 {
                return Err(bad("Cloud worker response is too large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| bad("Cloud worker returned an invalid response"))
    }
}
async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> std::io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            return Ok(result);
        }
        if result.len() + n > limit {
            return Err(std::io::Error::other("Cloud runtime output limit exceeded"));
        }
        result.extend_from_slice(&buffer[..n]);
    }
}
fn existing_request(
    r: &Registry,
    input: &CreateCloudJobRequest,
) -> Result<Option<CloudJob>, DaemonError> {
    if let Some(j) = r
        .jobs
        .values()
        .find(|j| j.request.idempotency_key == input.idempotency_key)
    {
        if j.request.workspace_id != input.workspace_id
            || j.request.prompt != input.prompt
            || j.request.source_capture_id != input.source_capture_id
            || j.request.model_id != input.model_id
        {
            return Err(DaemonError::Conflict(
                "Idempotency key was already used with a different request".into(),
            ));
        }
        return Ok(Some(j.job.clone()));
    }
    Ok(None)
}
fn holds_slot(s: CloudJobStatus) -> bool {
    !matches!(s, CloudJobStatus::Stopped | CloudJobStatus::Expired)
}

fn validate_id(id: &str) -> Result<(), DaemonError> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| bad("Invalid cloud record identifier"))
}
fn validate_segment(id: &str) -> Result<(), DaemonError> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_:".contains(&c))
    {
        return Err(bad("Invalid native request identifier"));
    }
    Ok(())
}
fn validate_gateway(base: &str) -> Result<(), DaemonError> {
    let u = reqwest::Url::parse(base).map_err(|_| bad("Worker gateway URL is invalid"))?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err(bad("Worker gateway URL is invalid"));
    }
    let host = u.host_str().unwrap_or("");
    if u.scheme() != "https" || !host.ends_with(".vercel.run") || u.port().is_some() {
        #[cfg(test)]
        if u.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost") {
            return Ok(());
        }
        return Err(bad(
            "Worker gateway must use the sandbox provider's HTTPS domain",
        ));
    }
    Ok(())
}
fn validate_settings(s: &Settings, launch: bool) -> Result<(), DaemonError> {
    if !(1..=1440).contains(&s.public.timeout_minutes) || s.public.node_binary.is_empty() {
        return Err(bad("Cloud runtime settings are invalid"));
    }
    if s.public.allowed_domains.len() > 64
        || s.public.allowed_domains.iter().any(|d| {
            d.is_empty()
                || d.len() > 253
                || d.contains('*')
                || !d
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
        })
    {
        return Err(bad("Worker network domains must be explicit hostnames"));
    }
    if s.provider_token.len() > 4096
        || s.openai_api_key.len() > 4096
        || s.openai_api_key.contains(['\r', '\n', '\0'])
        || s.public.team_id.as_ref().is_some_and(|v| v.len() > 4096)
        || s.public.project_id.as_ref().is_some_and(|v| v.len() > 4096)
    {
        return Err(bad("Cloud credentials have an unsupported format"));
    }
    if launch {
        if !s.public.enabled || s.provider_token.is_empty() || s.openai_api_key.is_empty() {
            return Err(bad(
                "Enable cloud tasks and configure the provider token and model API key",
            ));
        }
        if s.public.team_id.as_deref().is_none_or(str::is_empty)
            || s.public.project_id.as_deref().is_none_or(str::is_empty)
        {
            return Err(bad("Configure the provider team and project IDs"));
        }
        let Some((image, digest)) = s.public.image.rsplit_once("@sha256:") else {
            return Err(bad("Configure a digest-pinned worker image"));
        };
        if image.is_empty()
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_digit() || b"abcdef".contains(&c))
            || !image
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"./_-".contains(&c))
        {
            return Err(bad("Configure a digest-pinned worker image"));
        }
        if !Path::new(&s.public.runtime_path).is_absolute() {
            return Err(bad("Configure an absolute cloud runtime adapter path"));
        }
        if !s.public.worker_daemon_url.is_empty() || !s.public.worker_daemon_sha256.is_empty() {
            let u = reqwest::Url::parse(&s.public.worker_daemon_url)
                .map_err(|_| bad("Configure a pinned HTTPS worker daemon URL"))?;
            if u.scheme() != "https"
                || !u.username().is_empty()
                || u.password().is_some()
                || u.query().is_some()
                || u.fragment().is_some()
                || u.port().is_some()
            {
                return Err(bad(
                    "Worker daemon download must use HTTPS without credentials or query parameters",
                ));
            }
            if s.public.worker_daemon_sha256.len() != 64
                || !s
                    .public
                    .worker_daemon_sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || b"abcdef".contains(&c))
            {
                return Err(bad("Configure the worker daemon SHA-256"));
            }
        }
    }
    Ok(())
}
fn decoded_size(capture: &SourceCapture) -> Result<u64, DaemonError> {
    use base64::Engine as _;
    let limits = CaptureLimits::default();
    if capture.files.len() > limits.max_files {
        return Err(bad("Worker source export exceeds the file limit"));
    }
    let mut total = 0u64;
    for file in &capture.files {
        if file.content_base64.len() as u64 > (limits.max_file_bytes.saturating_add(2) / 3) * 4 {
            return Err(bad("Worker source export exceeds the file size limit"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&file.content_base64)
            .map_err(|_| bad("Worker source export is invalid"))?;
        if bytes.len() as u64 > limits.max_file_bytes {
            return Err(bad("Worker source export exceeds the file size limit"));
        }
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| bad("Worker source export exceeds the size limit"))?;
        if total > limits.max_total_bytes {
            return Err(bad("Worker source export exceeds the size limit"));
        }
    }
    Ok(total)
}

fn nonempty(s: String) -> Option<String> {
    let s = s.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}
fn bad(s: &str) -> DaemonError {
    DaemonError::BadRequest(s.into())
}
fn not_found() -> DaemonError {
    DaemonError::NotFound("Cloud job not found".into())
}
fn required_str(v: &Value, key: &str) -> Result<String, DaemonError> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| bad("Cloud runtime returned an incomplete response"))
}
fn parse_command(v: Value) -> Result<CommandResponse, DaemonError> {
    serde_json::from_value(v).map_err(|_| bad("Worker command response is incompatible"))
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "worker_tests.rs"]
mod worker_tests;
