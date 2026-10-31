//! Cloud execution behind the ordinary thread contract. Only operational
//! metadata is journaled here; conversation contents remain native exports.
use super::*;
use sha2::Digest;

pub(super) fn turn_receipt(
    record: &JobRecord,
    request: &SendTurnRequest,
) -> Result<Option<CommandResponse>, DaemonError> {
    let Some(id) = &request.user_item_id else {
        return Ok(None);
    };
    if let Some(hash) = record.turn_receipts.get(id) {
        let actual = format!("{:x}", sha2::Sha256::digest(serde_json::to_vec(request)?));
        if hash != &actual {
            return Err(DaemonError::Conflict(
                "This user message id already belongs to another cloud turn".into(),
            ));
        }
        return Ok(Some(CommandResponse {
            ok: true,
            message: Some(
                "This cloud message was already accepted; inspect the task for its current state"
                    .into(),
            ),
        }));
    }
    Ok(None)
}

pub(super) fn remember_turn(
    record: &mut JobRecord,
    request: &SendTurnRequest,
) -> Result<(), DaemonError> {
    if let Some(id) = &request.user_item_id {
        if id.len() > 256 {
            return Err(bad("Cloud user message id exceeds its size limit"));
        }
        record.turn_receipts.insert(
            id.clone(),
            format!("{:x}", sha2::Sha256::digest(serde_json::to_vec(request)?)),
        );
    }
    Ok(())
}

pub(crate) fn job_id(public_id: &str) -> Option<&str> {
    public_id
        .strip_prefix("cloud-")
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
}

fn public_id(id: &str) -> String {
    format!("cloud-{id}")
}

fn summary(record: &JobRecord, native: Option<&ThreadSummary>) -> ThreadSummary {
    let native = native.or_else(|| {
        record
            .thread_summary
            .as_ref()
            .filter(|summary| summary.native_session_id.is_some())
    });
    let mut value = native
        .cloned()
        .or_else(|| record.thread_summary.clone())
        .unwrap_or_else(|| ThreadSummary {
            id: public_id(&record.job.id),
            workspace_id: record.job.workspace_id.clone(),
            execution_target: ThreadExecutionTarget::Cloud,
            cloud: None,
            title: record
                .job
                .prompt
                .lines()
                .next()
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(80).collect())
                .unwrap_or_else(|| "New task".into()),
            provider: AgentProvider::CODEX,
            native_session_id: record.job.worker.as_ref().map(|w| w.thread_id.clone()),
            provider_transport: None,
            handoff_from: None,
            origin: None,
            status: ThreadStatus::Idle,
            updated_at: record.job.updated_at,
            last_message_preview: None,
            latest_turn_id: None,
            latest_plan: None,
            latest_diff: None,
            last_tool: None,
            last_error: None,
            agent: ThreadAgentParams {
                model_id: record.job.model_id.clone(),
                ..Default::default()
            },
            attention: Default::default(),
            is_archived: false,
            is_pinned: false,
            is_pinned_in_project: false,
            goal: None,
            queued_turns: vec![],
            variant: None,
        });
    if let Some(saved) = &record.thread_summary {
        value.is_archived = saved.is_archived;
        value.is_pinned = saved.is_pinned;
        value.is_pinned_in_project = saved.is_pinned_in_project;
        value.origin = saved.origin.clone();
        value.handoff_from = saved.handoff_from.clone();
        value.attention.last_read_seq = saved.attention.last_read_seq;
        value.attention.last_agent_activity_seq = saved.attention.last_agent_activity_seq;
        value.agent.merge_missing_from(&saved.agent);
    }
    value.id = public_id(&record.job.id);
    value.workspace_id = record.job.workspace_id.clone();
    value.execution_target = ThreadExecutionTarget::Cloud;
    value.native_session_id = record
        .job
        .worker
        .as_ref()
        .map(|worker| worker.thread_id.clone());
    value.cloud = Some(CloudThreadMetadata {
        job_id: record.job.id.clone(),
        status: record.job.status,
        error: record.job.error.clone(),
        has_result: record.job.result.is_some(),
    });
    value.variant = None;
    value.updated_at = value.updated_at.max(record.job.updated_at);
    value.last_error = record.job.error.clone().or(value.last_error);
    if let Some(title) = &record.custom_title {
        value.title = title.clone();
    }
    value.status = match record.job.status {
        CloudJobStatus::Provisioning if record.deferred_launch => ThreadStatus::Idle,
        CloudJobStatus::Provisioning | CloudJobStatus::Stopping => ThreadStatus::Running,
        CloudJobStatus::Running => native
            .map(|thread| {
                if thread.status == ThreadStatus::Idle && thread.attention.background_task_count > 0
                {
                    ThreadStatus::Running
                } else {
                    thread.status.clone()
                }
            })
            .unwrap_or(ThreadStatus::Running),
        CloudJobStatus::AwaitingInput => native
            .map(|s| s.status.clone())
            .unwrap_or(ThreadStatus::Idle),
        CloudJobStatus::Failed | CloudJobStatus::Unknown => ThreadStatus::Error,
        _ => ThreadStatus::Idle,
    };
    if value.last_message_preview.is_none() && !record.job.prompt.is_empty() {
        value.last_message_preview = Some(record.job.prompt.chars().take(300).collect());
    }
    if matches!(
        record.job.status,
        CloudJobStatus::Stopped | CloudJobStatus::Expired
    ) {
        value.attention.pending_approval_count = 0;
        value.attention.pending_question_count = 0;
        value.attention.background_task_count = 0;
    }
    value
}

impl CloudManager {
    pub(crate) async fn thread_queue_command(
        &self,
        public: &str,
        action: &str,
        params: &Value,
    ) -> Result<CommandResponse, DaemonError> {
        let id = job_id(public).ok_or_else(not_found)?;
        let record = self.record(id).await?;
        if !matches!(
            record.job.status,
            CloudJobStatus::Running | CloudJobStatus::AwaitingInput | CloudJobStatus::Completed
        ) {
            return Err(DaemonError::Conflict(
                "Cloud queue changes require a reachable worker".into(),
            ));
        }
        let worker = record.job.worker.as_ref().ok_or_else(not_found)?;
        let base = format!(
            "/api/workspaces/{}/threads/{}/queue",
            worker.workspace_id, worker.thread_id
        );
        let (method, path, body) = if action == "reorder" {
            let ids = params
                .get("queued_ids")
                .and_then(Value::as_array)
                .ok_or_else(|| bad("Missing queue order"))?;
            for id in ids {
                validate_segment(id.as_str().ok_or_else(|| bad("Invalid queued turn id"))?)?;
            }
            (
                "POST",
                format!("{base}/reorder"),
                Some(json!({"queued_ids":ids})),
            )
        } else {
            let queued = params
                .get("queued_id")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("Missing queued turn id"))?;
            validate_segment(queued)?;
            match action {
                "remove" => ("DELETE", format!("{base}/{queued}"), None),
                "steer" => ("POST", format!("{base}/{queued}/steer"), None),
                "edit" => {
                    let text = params
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad("Missing queued turn text"))?;
                    (
                        "PATCH",
                        format!("{base}/{queued}"),
                        Some(json!({"text":text})),
                    )
                }
                _ => return Err(bad("Unsupported cloud queue operation")),
            }
        };
        parse_command(self.worker(&record, method, &path, body).await?)
    }
    pub(crate) async fn thread_for_retry_key(
        &self,
        workspace_id: &str,
        key: &str,
    ) -> Result<Option<ThreadSummary>, DaemonError> {
        let _gate = self.mutation.lock().await;
        Ok(self
            .registry()?
            .jobs
            .values()
            .find(|r| r.job.workspace_id == workspace_id && r.request.idempotency_key == key)
            .map(|r| summary(r, None)))
    }
    pub(crate) async fn thread_summaries(&self) -> Result<Vec<ThreadSummary>, DaemonError> {
        let _gate = self.mutation.lock().await;
        Ok(self
            .registry()?
            .jobs
            .values()
            .map(|record| summary(record, None))
            .collect())
    }

    pub(crate) async fn start_thread(
        self: &Arc<Self>,
        request: StartThreadRequest,
        root: PathBuf,
    ) -> Result<ThreadSummary, DaemonError> {
        if request
            .provider
            .as_ref()
            .is_some_and(|p| p != &AgentProvider::CODEX)
        {
            return Err(bad("Cloud execution currently supports Codex only"));
        }
        if request.isolation != ThreadIsolation::ProjectFolder {
            return Err(bad(
                "Cloud already uses a private source copy; local isolation does not apply",
            ));
        }
        if request.handoff_from.is_some() || request.handoff_context.is_some() {
            return Err(bad(
                "Cloud context handoff has not been qualified. Start with an explicit task description",
            ));
        }
        let key = request
            .idempotency_key
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if !(8..=128).contains(&key.len()) {
            return Err(bad("A cloud retry key must be 8–128 characters"));
        }
        {
            let _gate = self.mutation.lock().await;
            let registry = self.registry()?;
            if let Some(existing) = registry
                .jobs
                .values()
                .find(|r| r.request.idempotency_key == key)
            {
                if existing.thread_request.as_ref() != Some(&request) || existing.root != root {
                    return Err(DaemonError::Conflict(
                        "Cloud retry key already belongs to another creation request".into(),
                    ));
                }
                return Ok(summary(existing, None));
            }
            validate_settings(&self.settings_private()?, true)?;
        }
        let capture = self
            .capture(request.workspace_id.clone(), root.clone())
            .await?;
        let _gate = self.mutation.lock().await;
        let mut registry = self.registry()?;
        // Capture can run concurrently. Recheck the durable retry key under the
        // mutation lock so retries never register two threads or allocate twice.
        if let Some(existing) = registry
            .jobs
            .values()
            .find(|r| r.request.idempotency_key == key)
        {
            if existing.thread_request.as_ref() != Some(&request) || existing.root != root {
                return Err(DaemonError::Conflict(
                    "Cloud retry key already belongs to another creation request".into(),
                ));
            }
            return Ok(summary(existing, None));
        }
        let settings = self.settings_private()?;
        validate_settings(&settings, true)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let mut record = JobRecord {
            job: CloudJob {
                id: id.clone(),
                workspace_id: request.workspace_id.clone(),
                source: capture.clone(),
                status: CloudJobStatus::Provisioning,
                prompt: String::new(),
                model_id: request.model_id.clone(),
                worker: None,
                result: None,
                error: None,
                created_at: now,
                updated_at: now,
                expires_at: None,
            },
            request: CreateCloudJobRequest {
                workspace_id: request.workspace_id.clone(),
                prompt: String::new(),
                source_capture_id: Some(capture.id),
                idempotency_key: key,
                model_id: request.model_id.clone(),
            },
            root,
            sandbox_id: format!("fd-cloud-{id}"),
            gateway_url: None,
            gateway_token: None,
            provider_scope: Some((
                settings.public.team_id.unwrap_or_default(),
                settings.public.project_id.unwrap_or_default(),
            )),
            awaiting_user_after_resume: false,
            deferred_launch: true,
            pending_turn: None,
            thread_summary: None,
            thread_request: Some(request.clone()),
            custom_title: None,
            turn_receipts: BTreeMap::new(),
            cancel_requested: false,
            allocation_started: false,
        };
        let mut thread = summary(&record, None);
        thread.agent.model_id = request.model_id;
        thread.agent.approval_policy = request.approval_policy;
        thread.agent.sandbox_mode = request.sandbox_mode;
        thread.agent.permission_mode = request.permission_mode;
        thread.agent.collaboration_mode_id = request.collaboration_mode_id;
        record.thread_summary = Some(thread.clone());
        registry.jobs.insert(id, record);
        self.save(&registry)?;
        Ok(thread)
    }

    pub(crate) async fn mutate_summary<F>(
        &self,
        public: &str,
        update: F,
    ) -> Result<ThreadSummary, DaemonError>
    where
        F: FnOnce(&mut ThreadSummary),
    {
        let id = job_id(public).ok_or_else(not_found)?;
        let _gate = self.mutation.lock().await;
        let mut registry = self.registry()?;
        let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
        let mut value = summary(record, None);
        update(&mut value);
        // Location and source ownership are not mutable settings.
        value.id = public_id(id);
        value.workspace_id = record.job.workspace_id.clone();
        value.execution_target = ThreadExecutionTarget::Cloud;
        value.variant = None;
        if record.thread_summary.as_ref() == Some(&value) {
            return Ok(value);
        }
        record.thread_summary = Some(value.clone());
        self.save(&registry)?;
        Ok(value)
    }

    pub(crate) async fn thread_detail(&self, public: &str) -> Result<CloudJobDetail, DaemonError> {
        let id = job_id(public).ok_or_else(not_found)?;
        let record = self.record(id).await?;
        let mut detail = self.detail_with_requests(id).await?;
        detail.detail.thread = summary(&record, Some(&detail.detail.thread));
        detail.detail.thread.attention.pending_approval_count = detail
            .interactive_requests
            .iter()
            .filter(|request| {
                matches!(
                    request.kind,
                    InteractiveRequestKind::Approval | InteractiveRequestKind::PlanApproval
                )
            })
            .count() as u32;
        detail.detail.thread.attention.pending_question_count = detail
            .interactive_requests
            .iter()
            .filter(|request| matches!(request.kind, InteractiveRequestKind::Question))
            .count() as u32;
        // Requests must be globally unique on the coordinator, while their
        // provider-native ids remain unchanged inside the worker.
        let remap = |request: &mut InteractiveRequest| {
            request.request_id = format!("{public}/{}", request.request_id);
            request.workspace_id = record.job.workspace_id.clone();
            request.thread_id = Some(public.to_string());
        };
        for request in &mut detail.interactive_requests {
            remap(request);
        }
        for item in &mut detail.detail.items {
            if let ConversationItem::InteractiveRequest { request, .. } = item {
                remap(request);
            }
        }
        // Native metadata is a cache of the worker's own state, not a second
        // conversation store. Only summary fields are persisted here.
        let projected = detail.detail.thread.clone();
        self.mutate_summary(public, |stored| *stored = projected)
            .await?;
        Ok(detail)
    }

    pub(crate) async fn send_thread_turn(
        self: &Arc<Self>,
        public: &str,
        request: SendTurnRequest,
    ) -> Result<CommandResponse, DaemonError> {
        let id = job_id(public).ok_or_else(not_found)?;
        if request
            .provider
            .as_ref()
            .is_some_and(|p| p != &AgentProvider::CODEX)
        {
            return Err(bad("Cloud execution currently supports Codex only"));
        }
        if !request.selected_skills.is_empty()
            || request
                .inputs
                .iter()
                .any(|input| !matches!(input, TurnInputItem::Text { .. }))
        {
            return Err(bad(
                "Cloud currently accepts text prompts; local skills and attachments are not transferred",
            ));
        }
        let first = {
            let _gate = self.mutation.lock().await;
            let mut registry = self.registry()?;
            let record = registry.jobs.get(id).ok_or_else(not_found)?;
            if record.job.workspace_id != request.workspace_id {
                return Err(not_found());
            }
            if let Some(response) = turn_receipt(record, &request)? {
                return Ok(response);
            }
            if record.cancel_requested
                && (record.deferred_launch
                    || record.job.worker.is_none()
                    || matches!(
                        record.job.status,
                        CloudJobStatus::Stopping | CloudJobStatus::Unknown
                    ))
            {
                return Err(DaemonError::Conflict("Cloud setup was cancelled or is still stopping; start a new task after cleanup finishes".into()));
            }
            if record.deferred_launch {
                if registry
                    .jobs
                    .iter()
                    .any(|(other, r)| other != id && !r.deferred_launch && holds_slot(r.job.status))
                {
                    return Err(DaemonError::Conflict(
                        "Another cloud task is active or needs reconciliation".into(),
                    ));
                }
                let settings = self.settings_for_job(record)?;
                validate_settings(&settings, true)?;
                let source = self.capture_record(&record.job.source.id)?.source;
                let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
                record.job.prompt = request
                    .inputs
                    .iter()
                    .filter_map(|i| {
                        if let TurnInputItem::Text { text, .. } = i {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if record.job.prompt.trim().is_empty() || record.job.prompt.len() > 128 * 1024 {
                    return Err(bad("Enter a prompt of at most 128 KiB"));
                }
                remember_turn(record, &request)?;
                record.pending_turn = Some(request.clone());
                record.deferred_launch = false;
                record.job.updated_at = Utc::now();
                self.save(&registry)?;
                Some((settings, source))
            } else {
                // A duplicate Send while first-launch is underway is admitted
                // only when it names the very same pending user message.
                if record.job.status == CloudJobStatus::Provisioning
                    && record.pending_turn.as_ref() == Some(&request)
                {
                    return Ok(CommandResponse {
                        ok: true,
                        message: Some("Cloud task is preparing".into()),
                    });
                }
                None
            }
        };
        if let Some((settings, source)) = first {
            let this = self.clone();
            let id = id.to_string();
            tokio::spawn(async move {
                this.launch(id, settings, source).await;
            });
            return Ok(CommandResponse {
                ok: true,
                message: Some("Cloud task is preparing".into()),
            });
        }
        let record = self.record(id).await?;
        if matches!(
            record.job.status,
            CloudJobStatus::Stopped | CloudJobStatus::Expired
        ) {
            let resumed = self.resume(id).await?;
            if !matches!(
                resumed.status,
                CloudJobStatus::AwaitingInput | CloudJobStatus::Completed | CloudJobStatus::Running
            ) {
                return Err(DaemonError::Conflict(
                    resumed
                        .error
                        .unwrap_or_else(|| "Cloud resume is not ready".into()),
                ));
            }
        }
        self.sync_thread_settings(id).await?;
        self.send_turn(id, request).await
    }

    async fn sync_thread_settings(&self, id: &str) -> Result<(), DaemonError> {
        let record = self.record(id).await?;
        let Some(stored) = &record.thread_summary else {
            return Ok(());
        };
        let worker = record.job.worker.as_ref().ok_or_else(not_found)?;
        let mut payload = serde_json::to_value(&stored.agent)?;
        payload["workspace_id"] = json!(worker.workspace_id);
        payload["thread_id"] = json!(worker.thread_id);
        if let Some(title) = &record.custom_title {
            payload["title"] = json!(title);
        }
        self.worker(
            &record,
            "PATCH",
            &format!(
                "/api/workspaces/{}/threads/{}",
                worker.workspace_id, worker.thread_id
            ),
            Some(payload),
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn update_thread(
        &self,
        public: &str,
        request: UpdateThreadRequest,
    ) -> Result<ThreadSummary, DaemonError> {
        let id = job_id(public).ok_or_else(not_found)?;
        let current = self.record(id).await?;
        if current.job.workspace_id != request.workspace_id {
            return Err(not_found());
        }
        if request
            .provider
            .as_ref()
            .is_some_and(|p| p != &AgentProvider::CODEX)
        {
            return Err(bad("A cloud task's harness cannot be changed"));
        }
        let projected = self
            .mutate_summary(public, |value| {
                value.updated_at = Utc::now();
                if let Some(title) = &request.title {
                    value.title = title.clone();
                }
                if let Some(v) = &request.model_id {
                    value.agent.model_id = v.clone();
                }
                if let Some(v) = &request.reasoning_effort {
                    value.agent.reasoning_effort = v.clone();
                }
                if let Some(v) = &request.collaboration_mode_id {
                    value.agent.collaboration_mode_id = v.clone();
                }
                if let Some(v) = &request.service_tier {
                    value.agent.service_tier = v.clone();
                }
                if let Some(v) = &request.approval_policy {
                    value.agent.approval_policy = v.clone();
                }
                if let Some(v) = &request.sandbox_mode {
                    value.agent.sandbox_mode = v.clone();
                }
                if let Some(v) = &request.permission_mode {
                    value.agent.permission_mode = v.clone();
                }
                if let Some(v) = request.pinned {
                    value.is_pinned = v;
                    if v {
                        value.is_pinned_in_project = false;
                    }
                }
                if let Some(v) = request.pinned_in_project {
                    value.is_pinned_in_project = v;
                    if v {
                        value.is_pinned = false;
                    }
                }
            })
            .await?;
        {
            let _gate = self.mutation.lock().await;
            let mut registry = self.registry()?;
            let record = registry.jobs.get_mut(id).ok_or_else(not_found)?;
            if let Some(title) = &request.title {
                record.custom_title = Some(title.clone());
            }
            self.save(&registry)?;
        }
        if current.job.worker.is_some()
            && matches!(
                current.job.status,
                CloudJobStatus::Running | CloudJobStatus::Completed | CloudJobStatus::AwaitingInput
            )
        {
            let worker = current.job.worker.as_ref().ok_or_else(not_found)?;
            let mut payload = serde_json::to_value(request)?;
            payload["workspace_id"] = json!(worker.workspace_id);
            payload["thread_id"] = json!(worker.thread_id);
            self.worker(
                &current,
                "PATCH",
                &format!(
                    "/api/workspaces/{}/threads/{}",
                    worker.workspace_id, worker.thread_id
                ),
                Some(payload),
            )
            .await?;
        }
        Ok(projected)
    }
}
