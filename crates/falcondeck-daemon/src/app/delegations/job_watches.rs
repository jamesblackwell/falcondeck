//! Durable local job signals. Never reruns the watched command or reads its output.
use super::*;

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(super) struct JobWatch {
    id: String,
    pub(super) workspace: String,
    pub(super) thread: String,
    pid: Option<u32>,
    process_identity: Option<String>,
    result_file: Option<PathBuf>,
    deadline: DateTime<Utc>,
    outcome: Option<String>,
    next_attempt: Option<DateTime<Utc>>,
    pub(super) delivered: Option<DateTime<Utc>>,
}

#[derive(PartialEq, Debug)]
enum ProcessState {
    Running(String),
    Gone,
    Unknown,
}

async fn process_state(pid: u32) -> ProcessState {
    // Start time distinguishes a reused pid after a daemon restart. A zombie
    // has exited even if its parent has not reaped it yet.
    let output = timeout(
        Duration::from_secs(3),
        tokio::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "lstart=", "-o", "stat="])
            .env("LC_ALL", "C")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let Ok(Ok(output)) = output else {
        return ProcessState::Unknown;
    };
    if output.status.code() == Some(1) && output.stdout.is_empty() {
        return ProcessState::Gone;
    }
    if !output.status.success() {
        return ProcessState::Unknown;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut words: Vec<_> = text.split_whitespace().collect();
    let Some(state) = words.pop() else {
        return ProcessState::Unknown;
    };
    if state.starts_with('Z') {
        return ProcessState::Gone;
    }
    if words.len() != 5 {
        return ProcessState::Unknown;
    }
    ProcessState::Running(words.join(" "))
}

impl JobWatch {
    fn wait(&self) -> TaskWait {
        TaskWait {
            reason: format!("Detached job {}", self.id),
            deadline: self.deadline,
        }
    }

    async fn signal(&self, now: DateTime<Utc>) -> Option<String> {
        if let Some(path) = &self.result_file {
            match tokio::fs::metadata(path).await {
                Ok(_) => return Some("result file appeared; inspect the result".into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Some("state unknown: result file could not be checked".into()),
            }
        }
        if let Some(pid) = self.pid {
            match process_state(pid).await {
                ProcessState::Gone => {
                    return Some(
                        "process exited; exit status unknown; inspect the result file if supplied"
                            .into(),
                    );
                }
                ProcessState::Running(identity)
                    if Some(&identity) == self.process_identity.as_ref() => {}
                _ => {
                    return Some(
                        "state unknown: process identity unavailable or pid reused".into(),
                    );
                }
            }
        }
        (now >= self.deadline).then(|| "timeout passed; inspect the job before retrying".into())
    }
}

impl AppState {
    pub(in crate::app) async fn watch_job(
        &self,
        workspace: &str,
        thread: &str,
        pid: Option<u32>,
        result_file: Option<PathBuf>,
        deadline: DateTime<Utc>,
    ) -> Result<String, DaemonError> {
        if pid.is_none() && result_file.is_none() {
            return Err(DaemonError::BadRequest(
                "Supply pid and/or result_file".into(),
            ));
        }
        if pid.is_some_and(|p| p <= 1 || p > i32::MAX as u32)
            || result_file
                .as_ref()
                .is_some_and(|p| !p.is_absolute() || p.as_os_str().len() > 4096)
            || deadline <= Utc::now()
        {
            return Err(DaemonError::BadRequest(
                "Use a valid pid, absolute result_file path and future deadline".into(),
            ));
        }
        if self.is_cloud_thread(thread) {
            return Err(DaemonError::BadRequest(
                "Job watches run on the local daemon host only".into(),
            ));
        }
        self.thread_summary(workspace, thread).await?;
        let identity = if let Some(pid) = pid {
            match process_state(pid).await {
                ProcessState::Running(value) => Some(value),
                _ => None,
            }
        } else {
            None
        };
        let job = JobWatch {
            id: Uuid::new_v4().to_string(),
            workspace: workspace.into(),
            thread: thread.into(),
            pid,
            process_identity: identity,
            result_file,
            deadline,
            ..Default::default()
        };
        let id = job.id.clone();
        self.edit_delegations(|l| {
            if l.jobs
                .iter()
                .filter(|j| j.thread == thread && j.delivered.is_none())
                .count()
                >= 16
            {
                return Err(DaemonError::BadRequest(
                    "At most 16 pending job watches per thread".into(),
                ));
            }
            for task in l
                .tasks
                .iter_mut()
                .filter(|t| t.workspace == workspace && t.thread == thread && !t.closed)
            {
                task.waiting = Some(job.wait());
                task.deadline_reported = false;
                task.waiting_notified = false;
            }
            l.jobs.push(job);
            Ok(())
        })
        .await??;
        self.project_task_waits().await?;
        self.start_delegation_monitor();
        Ok(id)
    }

    pub(super) async fn job_waits(
        &self,
    ) -> Result<HashMap<(String, String), TaskWait>, DaemonError> {
        let store = self.delegation_store().await?;
        let ledger = store.lock().await;
        let mut waits = HashMap::new();
        for job in ledger
            .jobs
            .iter()
            .filter(|j| j.delivered.is_none() && j.outcome.is_none())
        {
            let key = (job.workspace.clone(), job.thread.clone());
            let wait = waits.entry(key).or_insert_with(|| job.wait());
            if job.deadline < wait.deadline {
                *wait = job.wait();
            }
        }
        Ok(waits)
    }

    pub(super) async fn poll_job_watches(&self) -> Result<(), DaemonError> {
        let jobs = self.delegation_store().await?.lock().await.jobs.clone();
        for job in jobs.into_iter().filter(|j| j.delivered.is_none()) {
            if job.next_attempt.is_some_and(|at| at > Utc::now()) {
                continue;
            }
            let outcome = match job.outcome.clone() {
                Some(value) => value,
                None => match job.signal(Utc::now()).await {
                    Some(value) => value,
                    None => continue,
                },
            };
            // Persist the signal before admission. A failed provider start or
            // daemon restart retains the wake; delivery is at least once.
            self.edit_delegations(|l| {
                if let Some(j) = l.jobs.iter_mut().find(|j| j.id == job.id) {
                    j.outcome = Some(outcome.clone());
                    j.next_attempt = Some(Utc::now() + ChronoDuration::minutes(5));
                }
                for t in l
                    .tasks
                    .iter_mut()
                    .filter(|t| t.thread == job.thread && t.waiting == Some(job.wait()))
                {
                    t.waiting = None;
                }
            })
            .await?;
            let request: SendTurnRequest = serde_json::from_value(json!({
                "workspace_id": job.workspace, "thread_id": job.thread,
                "user_item_id": format!("user-job-watch-{}", job.id),
                "inputs": [{"type":"text", "text": format!("FalconDeck detached job {}: {outcome}. Verify the job before repeating side effects; continue the pending task.", job.id)}]
            }))?;
            // Provider startup must not hold up deadlines or other job watches.
            let key = format!("job:{}", job.id);
            if !self
                .inner
                .delegation_sends
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key.clone())
            {
                continue;
            }
            let app = self.clone();
            tokio::spawn(async move {
                match app.send_automatic_turn(request).await {
                    Ok(_) => {
                        if let Err(error) = app
                            .edit_delegations(|l| {
                                if let Some(j) = l.jobs.iter_mut().find(|j| j.id == job.id) {
                                    j.delivered = Some(Utc::now());
                                }
                            })
                            .await
                        {
                            tracing::warn!(%error, "job admission receipt could not be saved");
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, watch = %job.id, "job wake retained for retry")
                    }
                }
                app.inner
                    .delegation_sends
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&key);
            });
        }
        self.project_task_waits().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::thread_tools::tests::{call, fixture};

    async fn ready(app: &AppState) {
        app.finish_local_restore();
        app.inner
            .delegation_monitor_started
            .store(true, Ordering::Release);
        app.with_thread_mut("workspace-1", "thread-1", |s| {
            s.status = ThreadStatus::Running
        })
        .await
        .unwrap();
    }

    async fn queued(app: &AppState) -> Vec<String> {
        app.inner.workspaces.lock().await["workspace-1"].threads["thread-1"]
            .queued_requests
            .iter()
            .flat_map(|q| {
                q.request.inputs.iter().filter_map(|i| match i {
                    falcondeck_core::TurnInputItem::Text { text, .. } => Some(text.clone()),
                    _ => None,
                })
            })
            .collect()
    }

    async fn poll(app: &AppState) {
        app.poll_job_watches().await.unwrap();
        timeout(Duration::from_secs(5), async {
            loop {
                if !app
                    .inner
                    .delegation_sends
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .any(|k| k.starts_with("job:"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn job_watch_wakes_on_process_exit_and_does_not_repeat() {
        let (app, _temp) = fixture().await;
        ready(&app).await;
        let mut child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        app.watch_job(
            "workspace-1",
            "thread-1",
            Some(pid),
            None,
            Utc::now() + ChronoDuration::hours(1),
        )
        .await
        .unwrap();
        assert!(
            app.thread_summary("workspace-1", "thread-1")
                .await
                .unwrap()
                .attention
                .task_wait
                .is_some()
        );
        poll(&app).await;
        assert!(queued(&app).await.is_empty());
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        poll(&app).await;
        assert_eq!(queued(&app).await.len(), 1);
        assert!(queued(&app).await[0].contains("process exited"));
        poll(&app).await;
        assert_eq!(queued(&app).await.len(), 1);
        assert!(
            app.thread_summary("workspace-1", "thread-1")
                .await
                .unwrap()
                .attention
                .task_wait
                .is_none()
        );
    }

    #[tokio::test]
    async fn job_watch_file_and_timeout_wake_after_restart() {
        for file_signal in [true, false] {
            let (app, temp) = fixture().await;
            ready(&app).await;
            let file = temp.path().join("result");
            app.invoke_extension_tool(call(
                "falcondeck_watch_job",
                json!({"result_file":file,"deadline":Utc::now()+ChronoDuration::hours(1)}),
            ))
            .await
            .unwrap();
            if file_signal {
                tokio::fs::write(&file, "done").await.unwrap();
            } else {
                app.edit_delegations(|l| {
                    l.jobs[0].deadline = Utc::now() - ChronoDuration::seconds(1)
                })
                .await
                .unwrap();
            }
            let restored = AppState::new_with_state_path(
                "test".into(),
                HashMap::new(),
                app.inner.state_path.clone(),
            );
            *restored.inner.workspaces.lock().await =
                std::mem::take(&mut *app.inner.workspaces.lock().await);
            ready(&restored).await;
            poll(&restored).await;
            let messages = queued(&restored).await;
            assert_eq!(messages.len(), 1);
            assert!(messages[0].contains(if file_signal {
                "result file appeared"
            } else {
                "timeout passed"
            }));
            poll(&restored).await;
            assert_eq!(queued(&restored).await.len(), 1);
        }
    }

    #[tokio::test]
    async fn restarted_pid_checks_file_first_and_unknown_identity_wakes() {
        for file_signal in [true, false] {
            let (app, temp) = fixture().await;
            ready(&app).await;
            let file = temp.path().join("result");
            app.watch_job(
                "workspace-1",
                "thread-1",
                Some(std::process::id()),
                Some(file.clone()),
                Utc::now() + ChronoDuration::hours(1),
            )
            .await
            .unwrap();
            app.edit_delegations(|l| l.jobs[0].process_identity = Some("different process".into()))
                .await
                .unwrap();
            if file_signal {
                tokio::fs::write(&file, "done").await.unwrap();
            }
            let restored = AppState::new_with_state_path(
                "test".into(),
                HashMap::new(),
                app.inner.state_path.clone(),
            );
            *restored.inner.workspaces.lock().await =
                std::mem::take(&mut *app.inner.workspaces.lock().await);
            ready(&restored).await;
            poll(&restored).await;
            assert!(queued(&restored).await[0].contains(if file_signal {
                "result file appeared"
            } else {
                "state unknown"
            }));
        }
    }

    #[tokio::test]
    async fn exited_pid_wakes_after_restart_and_a_live_pid_keeps_waiting() {
        let (app, _temp) = fixture().await;
        ready(&app).await;
        let mut child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        app.watch_job(
            "workspace-1",
            "thread-1",
            child.id(),
            None,
            Utc::now() + ChronoDuration::hours(1),
        )
        .await
        .unwrap();
        let restored = AppState::new_with_state_path(
            "test".into(),
            HashMap::new(),
            app.inner.state_path.clone(),
        );
        *restored.inner.workspaces.lock().await =
            std::mem::take(&mut *app.inner.workspaces.lock().await);
        ready(&restored).await;
        poll(&restored).await;
        assert!(queued(&restored).await.is_empty());
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        poll(&restored).await;
        assert!(queued(&restored).await[0].contains("process exited"));
    }

    #[tokio::test]
    async fn finish_cancels_untracked_job_and_failed_admission_retains_signal() {
        let (app, temp) = fixture().await;
        ready(&app).await;
        let file = temp.path().join("result");
        app.watch_job(
            "workspace-1",
            "thread-1",
            None,
            Some(file.clone()),
            Utc::now() + ChronoDuration::hours(1),
        )
        .await
        .unwrap();
        app.invoke_extension_tool(call("falcondeck_task_state", json!({"state":"finished"})))
            .await
            .unwrap();
        tokio::fs::write(&file, "done").await.unwrap();
        poll(&app).await;
        assert!(queued(&app).await.is_empty());
        app.watch_job(
            "workspace-1",
            "thread-1",
            None,
            Some(file),
            Utc::now() + ChronoDuration::hours(1),
        )
        .await
        .unwrap();
        // A missing workspace makes admission fail before any provider can start.
        let workspace = app
            .inner
            .workspaces
            .lock()
            .await
            .remove("workspace-1")
            .unwrap();
        poll(&app).await;
        {
            let store = app.delegation_store().await.unwrap();
            let ledger = store.lock().await;
            assert!(ledger.jobs[1].outcome.is_some());
            assert!(ledger.jobs[1].delivered.is_none());
        }
        app.inner
            .workspaces
            .lock()
            .await
            .insert("workspace-1".into(), workspace);
        app.edit_delegations(|l| l.jobs[1].next_attempt = None)
            .await
            .unwrap();
        poll(&app).await;
        assert_eq!(queued(&app).await.len(), 1);
    }

    #[tokio::test]
    async fn job_watch_rejects_invalid_or_foreign_registration() {
        let (app, _temp) = fixture().await;
        ready(&app).await;
        for args in [
            json!({"deadline":Utc::now()+ChronoDuration::hours(1)}),
            json!({"pid":0,"deadline":Utc::now()+ChronoDuration::hours(1)}),
            json!({"result_file":"relative","deadline":Utc::now()+ChronoDuration::hours(1)}),
            json!({"pid":2,"thread_id":"another","deadline":Utc::now()+ChronoDuration::hours(1)}),
        ] {
            assert!(
                app.invoke_extension_tool(call("falcondeck_watch_job", args))
                    .await
                    .is_err()
            );
        }
    }
}
