use std::{collections::HashMap, str::FromStr, sync::atomic::Ordering};

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use falcondeck_core::{
    AgentProvider, CommandResponse, CreateScheduledTaskRequest, ScheduledTaskDetail,
    ScheduledTaskRunStatus, ScheduledTaskRunSummary, ScheduledTaskRunTrigger,
    ScheduledTaskSchedule, ScheduledTaskStatus, ScheduledTaskSummary, SendTurnRequest,
    StartThreadRequest, ThreadStatus, TurnInputItem, UnifiedEvent, UpdateScheduledTaskRequest,
    WorkspaceStatus, WorkspaceSummary,
    control::{
        Automation, AutomationConcurrencyPolicy, AutomationMisfirePolicy, AutomationOutcomeSummary,
        AutomationRun, AutomationRunStatus, AutomationRunTrigger, AutomationState,
        AutomationTarget, AutomationTask, AutomationThreadTarget, AutomationTrigger, ControlDomain,
        ControlStateChanged,
    },
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::time::{Duration, MissedTickBehavior, interval, sleep};
use uuid::Uuid;

use super::{
    AppState,
    notifications::{is_failed_turn_status, is_interrupt_turn_status},
    write_atomically,
};
use crate::error::DaemonError;

const STORE_VERSION: u32 = 1;
const RUN_HISTORY_LIMIT: usize = 50;
pub(super) const MAX_CONCURRENT_RUNS: usize = 2;
const MIN_RECURRING_INTERVAL_MINUTES: i64 = 5;
const TASK_LIMIT: usize = 500;
const MAX_STORE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_TITLE_BYTES: usize = 256;
const SCHEDULER_IDLE_POLL: Duration = Duration::from_secs(60);
const RUN_TERMINAL_POLL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PersistedScheduledTask {
    pub(super) detail: ScheduledTaskDetail,
    #[serde(default)]
    pub(super) runs: Vec<ScheduledTaskRunSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ScheduledTaskRegistry {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    tasks: HashMap<String, PersistedScheduledTask>,
}

fn store_version() -> u32 {
    STORE_VERSION
}

impl Default for ScheduledTaskRegistry {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            tasks: HashMap::new(),
        }
    }
}

impl ScheduledTaskRegistry {
    pub(super) fn summaries(&self) -> Vec<ScheduledTaskSummary> {
        let mut tasks = self
            .tasks
            .values()
            .map(|task| task.detail.summary.clone())
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| {
            (
                task.next_run_at.is_none(),
                task.next_run_at,
                task.title.clone(),
            )
        });
        tasks
    }

    fn task_mut(&mut self, task_id: &str) -> Result<&mut PersistedScheduledTask, DaemonError> {
        self.tasks
            .get_mut(task_id)
            .ok_or_else(|| DaemonError::NotFound("scheduled task not found".to_string()))
    }
}

#[derive(Debug)]
struct ParsedRule {
    frequency: Frequency,
    interval: i64,
    weekdays: Vec<Weekday>,
    hour: Option<u32>,
    minute: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frequency {
    Minutely,
    Hourly,
    Daily,
    Weekly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnqueueDisposition {
    Start,
    Coalesce,
    Skip,
}

pub(super) fn scheduled_tasks_path(state_path: &std::path::Path) -> std::path::PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("scheduled-tasks.json")
}

pub(super) async fn load_registry(
    path: &std::path::Path,
    now: DateTime<Utc>,
) -> Result<ScheduledTaskRegistry, DaemonError> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.len() > MAX_STORE_BYTES => {
            return Err(DaemonError::BadRequest(format!(
                "scheduled task store exceeds the {MAX_STORE_BYTES}-byte limit"
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ScheduledTaskRegistry::default());
        }
        Err(error) => return Err(error.into()),
    }
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(error) => return Err(error.into()),
    };
    let mut registry: ScheduledTaskRegistry = serde_json::from_str(&contents)?;
    if registry.version > STORE_VERSION {
        return Err(DaemonError::BadRequest(format!(
            "scheduled task store version {} is newer than supported version {STORE_VERSION}",
            registry.version
        )));
    }
    if registry.tasks.len() > TASK_LIMIT {
        return Err(DaemonError::BadRequest(format!(
            "scheduled task store exceeds the {TASK_LIMIT}-task limit"
        )));
    }
    for task in registry.tasks.values_mut() {
        validate_text("title", &task.detail.summary.title, MAX_TITLE_BYTES)?;
        validate_text("prompt", &task.detail.prompt, MAX_PROMPT_BYTES)?;
        validate_schedule_for_restore(&task.detail.summary.schedule)?;
        trim_runs(&mut task.runs);
        if task.detail.summary.prompt_preview.is_empty() {
            task.detail.summary.prompt_preview = prompt_preview(&task.detail.prompt);
        }
        for run in &mut task.runs {
            if matches!(
                run.status,
                ScheduledTaskRunStatus::Queued
                    | ScheduledTaskRunStatus::Running
                    | ScheduledTaskRunStatus::AwaitingInput
            ) {
                run.status = ScheduledTaskRunStatus::Interrupted;
                run.completed_at = Some(now);
                run.preview = Some("Daemon stopped before the run completed".to_string());
            }
        }
        task.detail.summary.last_run = task.runs.last().cloned();
        reconcile_next_run(&mut task.detail, now, true)?;
    }
    Ok(registry)
}

fn validate_schedule_for_restore(schedule: &ScheduledTaskSchedule) -> Result<(), DaemonError> {
    match schedule {
        ScheduledTaskSchedule::Once { timezone, .. } => {
            parse_timezone(timezone)?;
        }
        ScheduledTaskSchedule::Recurring { rrule, timezone } => {
            parse_timezone(timezone)?;
            let parsed = parse_rule(rrule)?;
            if parsed.frequency == Frequency::Minutely
                && parsed.interval < MIN_RECURRING_INTERVAL_MINUTES
            {
                return Err(DaemonError::BadRequest(
                    "recurring tasks must be at least five minutes apart".to_string(),
                ));
            }
        }
    }
    Ok(())
}

pub(super) async fn persist_registry(app: &AppState) -> Result<(), DaemonError> {
    let _persistence = app.inner.persistence.lock().await;
    let payload = {
        let registry = app.inner.scheduled_tasks.lock().await;
        serde_json::to_vec_pretty(&*registry)?
    };
    if payload.len() as u64 > MAX_STORE_BYTES {
        return Err(DaemonError::BadRequest(format!(
            "scheduled task store exceeds the {MAX_STORE_BYTES}-byte limit"
        )));
    }
    write_atomically(&app.inner.scheduled_tasks_path, payload).await
}

pub(super) async fn restore(app: &AppState) -> Result<(), DaemonError> {
    let _mutation = app.inner.scheduled_mutation.lock().await;
    let registry = load_registry(&app.inner.scheduled_tasks_path, Utc::now()).await?;
    *app.inner.scheduled_tasks.lock().await = registry;
    persist_registry(app).await?;
    Ok(())
}

/// Moves every losslessly representable V1 task into agent-control, the
/// canonical scheduler. Definitions keep their stable ids so a crash between
/// the two atomic store writes is self-healing on the next startup instead of
/// producing a duplicate definition or executor. RRULEs that cannot be
/// represented exactly remain in the legacy registry and are still surfaced
/// by the Scheduled dashboard compatibility projection.
pub(super) async fn migrate_compatible(app: &AppState) -> usize {
    let _mutation = app.inner.scheduled_mutation.lock().await;
    let candidates = app
        .inner
        .scheduled_tasks
        .lock()
        .await
        .tasks
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let now = Utc::now();
    let mut migrated = Vec::new();
    let mut imported = false;
    for task in candidates {
        let Some(workspace_path) = app.workspace_path(&task.detail.summary.workspace_id).await
        else {
            tracing::warn!(
                task_id = %task.detail.summary.id,
                workspace_id = %task.detail.summary.workspace_id,
                "legacy scheduled task could not be migrated because its workspace is unknown"
            );
            continue;
        };
        let Some((automation, runs)) = legacy_automation(&task, &workspace_path, now) else {
            tracing::info!(
                task_id = %task.detail.summary.id,
                "keeping non-lossless legacy scheduled task under legacy execution ownership"
            );
            continue;
        };
        match app
            .control()
            .import_legacy_automation(automation, runs)
            .await
        {
            Ok(crate::control::LegacyImportOutcome::Imported) => {
                imported = true;
                migrated.push(task.detail.summary.id.clone());
            }
            Ok(crate::control::LegacyImportOutcome::AlreadyPresent) => {
                migrated.push(task.detail.summary.id.clone());
            }
            Err(error) => {
                tracing::warn!(
                    task_id = %task.detail.summary.id,
                    error = %error.0.message,
                    "failed to import legacy scheduled task; leaving legacy executor authoritative"
                );
            }
        }
    }
    if migrated.is_empty() {
        return 0;
    }
    {
        let mut registry = app.inner.scheduled_tasks.lock().await;
        for task_id in &migrated {
            registry.tasks.remove(task_id);
        }
    }
    // The control store is written first. If pruning the retired store fails,
    // keep the migrated definitions removed from memory so this daemon cannot
    // double-execute them; next startup deduplicates by stable id and retries
    // this prune before the legacy scheduler starts.
    if let Err(error) = persist_registry(app).await {
        tracing::warn!(%error, "migrated scheduled tasks but could not prune the legacy store");
    }
    if imported {
        app.emit_control_state_change(ControlStateChanged {
            store_revision: app.control().store_revision().await,
            domains: vec![ControlDomain::Automations, ControlDomain::Runs],
        });
    }
    migrated.len()
}

fn legacy_automation(
    task: &PersistedScheduledTask,
    workspace_path: &str,
    now: DateTime<Utc>,
) -> Option<(Automation, Vec<AutomationRun>)> {
    let detail = &task.detail;
    let trigger = legacy_trigger(detail)?;
    let state = match detail.summary.status {
        ScheduledTaskStatus::Active => AutomationState::Enabled,
        ScheduledTaskStatus::Paused => AutomationState::Paused,
        ScheduledTaskStatus::Completed => AutomationState::Completed,
    };
    let runs = task
        .runs
        .iter()
        .map(|run| legacy_run(detail, run, now))
        .collect::<Vec<_>>();
    let latest_outcome = runs.last().and_then(|run| {
        run.finished_at.map(|finished_at| AutomationOutcomeSummary {
            status: run.status,
            finished_at,
            preview: run.outcome_preview.clone(),
        })
    });
    let elevated = crate::control::automations::is_elevated_mode(
        detail.permission_mode.as_deref(),
        detail.sandbox_mode.as_deref(),
    );
    let automation = Automation {
        id: detail.summary.id.clone(),
        revision: 1,
        name: detail.summary.title.clone(),
        description: None,
        trigger,
        task: AutomationTask::Prompt {
            instruction: detail.prompt.clone(),
        },
        target: AutomationTarget {
            workspace_path: workspace_path.to_string(),
            provider: detail.summary.provider.clone(),
            thread: AutomationThreadTarget::NewEachRun,
            model_id: detail.model_id.clone(),
            permission_mode: detail.permission_mode.clone(),
            sandbox_mode: detail.sandbox_mode.clone(),
            reasoning_effort: detail.reasoning_effort.clone(),
            collaboration_mode_id: detail.collaboration_mode_id.clone(),
            approval_policy: detail.approval_policy.clone(),
            isolation: Some(detail.isolation),
            selected_skills: detail
                .selected_skills
                .iter()
                .map(|skill| skill.skill_id.clone())
                .collect(),
        },
        state,
        // V1 scheduled tasks coalesced one pending run and ran missed one-time
        // tasks once while skipping missed recurring occurrences.
        concurrency_policy: AutomationConcurrencyPolicy::QueueOne,
        misfire_policy: if matches!(detail.summary.schedule, ScheduledTaskSchedule::Once { .. }) {
            AutomationMisfirePolicy::RunOnce
        } else {
            AutomationMisfirePolicy::Skip
        },
        elevated,
        required_connectors: Vec::new(),
        created_at: detail.created_at,
        updated_at: detail.summary.updated_at,
        next_run_at: detail.summary.next_run_at,
        last_run_at: runs
            .last()
            .and_then(|run| run.started_at.or(Some(run.queued_at))),
        latest_outcome,
    };
    Some((automation, runs))
}

fn legacy_trigger(detail: &ScheduledTaskDetail) -> Option<AutomationTrigger> {
    match &detail.summary.schedule {
        ScheduledTaskSchedule::Once { run_at, .. } => {
            Some(AutomationTrigger::Once { run_at: *run_at })
        }
        ScheduledTaskSchedule::Recurring { rrule, timezone } => {
            let parsed = parse_rule(rrule).ok()?;
            if parsed.interval != 1
                || !matches!(parsed.frequency, Frequency::Daily | Frequency::Weekly)
            {
                return None;
            }
            let minute = parsed.minute.unwrap_or(0);
            let hour = parsed.hour.unwrap_or(0);
            let day_field = if parsed.frequency == Frequency::Weekly {
                let weekdays = if parsed.weekdays.is_empty() {
                    let timezone = parse_timezone(timezone).ok()?;
                    vec![detail.created_at.with_timezone(&timezone).weekday()]
                } else {
                    parsed.weekdays
                };
                weekdays
                    .into_iter()
                    .map(cron_weekday)
                    .collect::<Vec<_>>()
                    .join(",")
            } else {
                "*".to_string()
            };
            Some(AutomationTrigger::Cron {
                expression: format!("{minute} {hour} * * {day_field}"),
                timezone: timezone.clone(),
            })
        }
    }
}

fn cron_weekday(day: Weekday) -> &'static str {
    match day {
        Weekday::Mon => "MON",
        Weekday::Tue => "TUE",
        Weekday::Wed => "WED",
        Weekday::Thu => "THU",
        Weekday::Fri => "FRI",
        Weekday::Sat => "SAT",
        Weekday::Sun => "SUN",
    }
}

fn legacy_run(
    detail: &ScheduledTaskDetail,
    run: &ScheduledTaskRunSummary,
    now: DateTime<Utc>,
) -> AutomationRun {
    let status = match run.status {
        ScheduledTaskRunStatus::Queued => AutomationRunStatus::Queued,
        ScheduledTaskRunStatus::Running | ScheduledTaskRunStatus::AwaitingInput => {
            AutomationRunStatus::Cancelled
        }
        ScheduledTaskRunStatus::Succeeded => AutomationRunStatus::Succeeded,
        ScheduledTaskRunStatus::Failed => AutomationRunStatus::Failed,
        ScheduledTaskRunStatus::Interrupted => AutomationRunStatus::Cancelled,
        ScheduledTaskRunStatus::Skipped => AutomationRunStatus::SkippedOverlap,
    };
    let trigger = match run.trigger {
        ScheduledTaskRunTrigger::Scheduled => AutomationRunTrigger::Scheduled,
        ScheduledTaskRunTrigger::Late => AutomationRunTrigger::Late,
        ScheduledTaskRunTrigger::Manual => AutomationRunTrigger::Manual,
    };
    let terminal = status.is_terminal();
    AutomationRun {
        id: run.id.clone(),
        automation_id: detail.summary.id.clone(),
        automation_name: detail.summary.title.clone(),
        automation_revision: 1,
        status,
        trigger,
        scheduled_for: Some(run.scheduled_for),
        queued_at: run.started_at.unwrap_or(run.scheduled_for),
        started_at: run.started_at,
        finished_at: run.completed_at.or(terminal.then_some(now)),
        runtime_workspace_id: Some(run.workspace_id.clone()),
        thread_id: run.thread_id.clone(),
        turn_id: None,
        outcome_preview: run.preview.clone(),
        error: None,
    }
}

pub(super) fn start_scheduler(app: &AppState) {
    if app
        .inner
        .scheduled_scheduler_started
        .swap(true, Ordering::AcqRel)
    {
        app.inner.scheduled_notify.notify_one();
        return;
    }
    let app = app.clone();
    tokio::spawn(async move {
        scheduler_loop(app).await;
    });
}

async fn scheduler_loop(app: AppState) {
    loop {
        if app.is_shutting_down() {
            return;
        }
        let now = Utc::now();
        let due = {
            let registry = app.inner.scheduled_tasks.lock().await;
            registry
                .tasks
                .values()
                .filter(|task| task.detail.summary.status == ScheduledTaskStatus::Active)
                .filter_map(|task| {
                    task.detail
                        .summary
                        .next_run_at
                        .filter(|next| *next <= now)
                        .map(|next| {
                            let trigger = match task.detail.summary.schedule {
                                ScheduledTaskSchedule::Once { run_at, .. } if run_at < now => {
                                    ScheduledTaskRunTrigger::Late
                                }
                                _ => ScheduledTaskRunTrigger::Scheduled,
                            };
                            (task.detail.summary.id.clone(), next, trigger)
                        })
                })
                .min_by_key(|(_, next, _)| *next)
        };
        if let Some((task_id, scheduled_for, trigger)) = due {
            if let Err(error) = enqueue_run(&app, &task_id, trigger, scheduled_for).await {
                tracing::warn!(task_id, %error, "failed to enqueue scheduled task run");
                tokio::select! {
                    _ = sleep(Duration::from_secs(5)) => {},
                    _ = app.inner.scheduled_notify.notified() => {},
                }
            }
            continue;
        }
        let next = {
            let registry = app.inner.scheduled_tasks.lock().await;
            registry
                .tasks
                .values()
                .filter(|task| task.detail.summary.status == ScheduledTaskStatus::Active)
                .filter_map(|task| task.detail.summary.next_run_at)
                .min()
        };
        let wait = next
            .and_then(|next| (next - Utc::now()).to_std().ok())
            .map_or(SCHEDULER_IDLE_POLL, |duration| {
                duration.min(SCHEDULER_IDLE_POLL)
            });
        tokio::select! {
            _ = sleep(wait) => {},
            _ = app.inner.scheduled_notify.notified() => {},
        }
    }
}

pub(super) async fn create(
    app: &AppState,
    request: CreateScheduledTaskRequest,
) -> Result<ScheduledTaskDetail, DaemonError> {
    validate_definition(app, &request).await?;
    let now = Utc::now();
    let id = format!("scheduled-{}", Uuid::new_v4().simple());
    let mut detail = ScheduledTaskDetail {
        summary: ScheduledTaskSummary {
            id: id.clone(),
            title: request.title.trim().to_string(),
            prompt_preview: prompt_preview(&request.prompt),
            status: ScheduledTaskStatus::Active,
            schedule: request.schedule,
            workspace_id: request.workspace_id,
            provider: request.provider,
            next_run_at: None,
            last_run: None,
            updated_at: now,
        },
        prompt: request.prompt.trim().to_string(),
        model_id: request.model_id,
        reasoning_effort: request.reasoning_effort,
        collaboration_mode_id: request.collaboration_mode_id,
        approval_policy: request.approval_policy,
        permission_mode: request.permission_mode,
        sandbox_mode: request.sandbox_mode,
        isolation: request.isolation,
        selected_skills: request.selected_skills,
        created_at: now,
    };
    let workspace = app
        .inner
        .workspaces
        .lock()
        .await
        .get(&detail.summary.workspace_id)
        .map(|workspace| workspace.summary.clone())
        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
    validate_task_against_workspace(&detail, &workspace, true)?;
    reconcile_next_run(&mut detail, now, false)?;
    let _mutation = app.inner.scheduled_mutation.lock().await;
    {
        let mut registry = app.inner.scheduled_tasks.lock().await;
        if registry.tasks.len() >= TASK_LIMIT {
            return Err(DaemonError::BadRequest(format!(
                "scheduled task limit of {TASK_LIMIT} reached"
            )));
        }
        registry.tasks.insert(
            id,
            PersistedScheduledTask {
                detail: detail.clone(),
                runs: Vec::new(),
            },
        );
    }
    if let Err(error) = persist_registry(app).await {
        app.inner
            .scheduled_tasks
            .lock()
            .await
            .tasks
            .remove(&detail.summary.id);
        return Err(error);
    }
    start_scheduler(app);
    app.inner.scheduled_notify.notify_one();
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskCreated {
            task: detail.summary.clone(),
        },
    );
    Ok(detail)
}

pub(super) async fn list(app: &AppState) -> Vec<ScheduledTaskSummary> {
    app.inner.scheduled_tasks.lock().await.summaries()
}

pub(super) async fn detail(
    app: &AppState,
    task_id: &str,
) -> Result<ScheduledTaskDetail, DaemonError> {
    app.inner
        .scheduled_tasks
        .lock()
        .await
        .tasks
        .get(task_id)
        .map(|task| task.detail.clone())
        .ok_or_else(|| DaemonError::NotFound("scheduled task not found".to_string()))
}

pub(super) async fn runs(
    app: &AppState,
    task_id: &str,
) -> Result<Vec<ScheduledTaskRunSummary>, DaemonError> {
    app.inner
        .scheduled_tasks
        .lock()
        .await
        .tasks
        .get(task_id)
        .map(|task| task.runs.iter().rev().cloned().collect())
        .ok_or_else(|| DaemonError::NotFound("scheduled task not found".to_string()))
}

pub(super) async fn update(
    app: &AppState,
    task_id: &str,
    request: UpdateScheduledTaskRequest,
) -> Result<ScheduledTaskDetail, DaemonError> {
    let _mutation = app.inner.scheduled_mutation.lock().await;
    let now = Utc::now();
    let schedule_changed = request.schedule.is_some();
    let execution_settings_changed = request.provider.is_some()
        || request.workspace_id.is_some()
        || request.model_id.is_some()
        || request.reasoning_effort.is_some()
        || request.collaboration_mode_id.is_some()
        || request.approval_policy.is_some()
        || request.permission_mode.is_some()
        || request.sandbox_mode.is_some()
        || request.isolation.is_some()
        || request.selected_skills.is_some();
    let current = detail(app, task_id).await?;
    if current.summary.status == ScheduledTaskStatus::Completed
        && request.status.is_some()
        && !schedule_changed
    {
        return Err(DaemonError::BadRequest(
            "update the schedule to reactivate a completed one-time task".to_string(),
        ));
    }
    let target_workspace_id = request
        .workspace_id
        .as_deref()
        .unwrap_or(&current.summary.workspace_id);
    let workspace = if execution_settings_changed {
        Some(
            app.inner
                .workspaces
                .lock()
                .await
                .get(target_workspace_id)
                .map(|workspace| workspace.summary.clone())
                .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?,
        )
    } else {
        None
    };
    let (updated, previous) = {
        let mut registry = app.inner.scheduled_tasks.lock().await;
        let mut next = registry
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("scheduled task not found".to_string()))?;
        let task = &mut next;
        if request.status == Some(ScheduledTaskStatus::Completed) {
            return Err(DaemonError::BadRequest(
                "completed is managed by the scheduler".to_string(),
            ));
        }
        if let Some(title) = request.title {
            validate_text("title", &title, MAX_TITLE_BYTES)?;
            task.detail.summary.title = title.trim().to_string();
        }
        if let Some(prompt) = request.prompt {
            validate_text("prompt", &prompt, MAX_PROMPT_BYTES)?;
            task.detail.summary.prompt_preview = prompt_preview(&prompt);
            task.detail.prompt = prompt.trim().to_string();
        }
        if let Some(status) = request.status {
            task.detail.summary.status = status;
            if status == ScheduledTaskStatus::Paused {
                skip_coalesced_pending_runs(task, now);
            }
        }
        if let Some(schedule) = request.schedule {
            validate_schedule(&schedule, now)?;
            task.detail.summary.schedule = schedule;
            if task.detail.summary.status == ScheduledTaskStatus::Completed {
                task.detail.summary.status = ScheduledTaskStatus::Active;
            }
        }
        if let Some(workspace_id) = request.workspace_id {
            task.detail.summary.workspace_id = workspace_id;
        }
        if let Some(provider) = request.provider {
            task.detail.summary.provider = provider;
        }
        if let Some(value) = request.model_id {
            task.detail.model_id = value;
        }
        if let Some(value) = request.reasoning_effort {
            task.detail.reasoning_effort = value;
        }
        if let Some(value) = request.collaboration_mode_id {
            task.detail.collaboration_mode_id = value;
        }
        if let Some(value) = request.approval_policy {
            task.detail.approval_policy = value;
        }
        if let Some(value) = request.permission_mode {
            task.detail.permission_mode = value;
        }
        if let Some(value) = request.sandbox_mode {
            task.detail.sandbox_mode = value;
        }
        if let Some(value) = request.isolation {
            task.detail.isolation = value;
        }
        if let Some(value) = request.selected_skills {
            task.detail.selected_skills = value;
        }
        task.detail.summary.updated_at = now;
        reconcile_next_run(&mut task.detail, now, false)?;
        if schedule_changed
            && task.detail.summary.status == ScheduledTaskStatus::Active
            && let ScheduledTaskSchedule::Once { run_at, .. } = &task.detail.summary.schedule
        {
            task.detail.summary.status = ScheduledTaskStatus::Active;
            task.detail.summary.next_run_at = Some(*run_at);
        }
        if execution_settings_changed {
            validate_task_against_workspace(
                &task.detail,
                workspace
                    .as_ref()
                    .expect("execution settings load their target workspace"),
                false,
            )?;
        }
        let updated = task.detail.clone();
        let previous = registry
            .tasks
            .insert(task_id.to_string(), next)
            .expect("scheduled task was read under the mutation lock");
        (updated, previous)
    };
    if let Err(error) = persist_registry(app).await {
        app.inner
            .scheduled_tasks
            .lock()
            .await
            .tasks
            .insert(task_id.to_string(), previous);
        return Err(error);
    }
    app.inner.scheduled_notify.notify_one();
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskUpdated {
            task: updated.summary.clone(),
        },
    );
    Ok(updated)
}

pub(super) async fn delete(app: &AppState, task_id: &str) -> Result<CommandResponse, DaemonError> {
    let _mutation = app.inner.scheduled_mutation.lock().await;
    let removed = app
        .inner
        .scheduled_tasks
        .lock()
        .await
        .tasks
        .remove(task_id)
        .ok_or_else(|| DaemonError::NotFound("scheduled task not found".to_string()))?;
    let active = removed
        .runs
        .iter()
        .rev()
        .find(|run| is_active_run(run) && run.thread_id.is_some())
        .and_then(|run| {
            run.thread_id
                .as_ref()
                .map(|thread_id| (run.workspace_id.clone(), thread_id.clone()))
        });
    if let Err(error) = persist_registry(app).await {
        app.inner
            .scheduled_tasks
            .lock()
            .await
            .tasks
            .insert(task_id.to_string(), removed);
        return Err(error);
    }
    drop(_mutation);
    if let Some((workspace_id, thread_id)) = active
        && let Err(error) = app.interrupt_turn(workspace_id, thread_id).await
    {
        tracing::warn!(%error, %task_id, "failed to interrupt deleted scheduled task run");
    }
    app.inner.scheduled_notify.notify_one();
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskDeleted {
            task_id: task_id.to_string(),
        },
    );
    Ok(CommandResponse {
        ok: true,
        message: Some("scheduled task deleted".to_string()),
    })
}

pub(super) async fn run_now(
    app: &AppState,
    task_id: &str,
) -> Result<ScheduledTaskRunSummary, DaemonError> {
    enqueue_run(app, task_id, ScheduledTaskRunTrigger::Manual, Utc::now()).await
}

async fn enqueue_run(
    app: &AppState,
    task_id: &str,
    trigger: ScheduledTaskRunTrigger,
    scheduled_for: DateTime<Utc>,
) -> Result<ScheduledTaskRunSummary, DaemonError> {
    let _mutation = app.inner.scheduled_mutation.lock().await;
    let now = Utc::now();
    let (run, task_summary, should_spawn, previous) = {
        let mut registry = app.inner.scheduled_tasks.lock().await;
        let previous = registry
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("scheduled task not found".to_string()))?;
        let task = registry.task_mut(task_id)?;
        let active_count = task.runs.iter().filter(|run| is_active_run(run)).count();
        let disposition = enqueue_disposition(active_count, trigger)?;
        if disposition == EnqueueDisposition::Skip {
            let run = ScheduledTaskRunSummary {
                id: format!("run-{}", Uuid::new_v4().simple()),
                task_id: task_id.to_string(),
                status: ScheduledTaskRunStatus::Skipped,
                trigger,
                scheduled_for,
                started_at: None,
                completed_at: Some(now),
                workspace_id: task.detail.summary.workspace_id.clone(),
                thread_id: None,
                preview: Some(
                    "Occurrence skipped because one coalesced run is already pending".to_string(),
                ),
            };
            task.runs.push(run.clone());
            trim_runs(&mut task.runs);
            task.detail.summary.last_run = task.runs.last().cloned();
            reconcile_next_run(&mut task.detail, now, false)?;
            (run, task.detail.summary.clone(), false, previous)
        } else {
            let run = ScheduledTaskRunSummary {
                id: format!("run-{}", Uuid::new_v4().simple()),
                task_id: task_id.to_string(),
                status: ScheduledTaskRunStatus::Queued,
                trigger,
                scheduled_for,
                started_at: None,
                completed_at: None,
                workspace_id: task.detail.summary.workspace_id.clone(),
                thread_id: None,
                preview: if disposition == EnqueueDisposition::Coalesce {
                    Some("Coalesced while the previous run is active".to_string())
                } else {
                    None
                },
            };
            task.runs.push(run.clone());
            trim_runs(&mut task.runs);
            task.detail.summary.last_run = task.runs.last().cloned();
            reconcile_next_run(&mut task.detail, now, false)?;
            (
                run,
                task.detail.summary.clone(),
                disposition == EnqueueDisposition::Start,
                previous,
            )
        }
    };
    if let Err(error) = persist_registry(app).await {
        app.inner
            .scheduled_tasks
            .lock()
            .await
            .tasks
            .insert(task_id.to_string(), previous);
        return Err(error);
    }
    let event = if run.status == ScheduledTaskRunStatus::Skipped {
        UnifiedEvent::ScheduledTaskRunUpdated {
            task_id: task_id.to_string(),
            run: run.clone(),
        }
    } else {
        UnifiedEvent::ScheduledTaskRunStarted {
            task_id: task_id.to_string(),
            run: run.clone(),
        }
    };
    app.emit(None, None, event);
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskUpdated { task: task_summary },
    );
    if should_spawn {
        spawn_run(app, task_id, &run.id);
    }
    Ok(run)
}

fn spawn_run(app: &AppState, task_id: &str, run_id: &str) {
    let app = app.clone();
    let task_id = task_id.to_string();
    let run_id = run_id.to_string();
    tokio::spawn(async move {
        execute_run(app, task_id, run_id).await;
    });
}

async fn execute_run(app: AppState, task_id: String, run_id: String) {
    let permit = match app.inner.scheduled_run_slots.acquire().await {
        Ok(permit) => permit,
        Err(_) => return,
    };
    if app.is_shutting_down() {
        let _ = finish_run(
            &app,
            &task_id,
            &run_id,
            ScheduledTaskRunStatus::Interrupted,
            Some("Daemon is shutting down".to_string()),
        )
        .await;
        return;
    }
    if !run_is_queued(&app, &task_id, &run_id).await {
        return;
    }
    let task = match detail(&app, &task_id).await {
        Ok(task) => task,
        Err(_) => return,
    };
    if let Err(error) = validate_run_dependencies(&app, &task).await {
        if run_is_queued(&app, &task_id, &run_id).await {
            let _ = finish_run(
                &app,
                &task_id,
                &run_id,
                ScheduledTaskRunStatus::Failed,
                Some(error.to_string()),
            )
            .await;
        }
        return;
    }
    let started = app
        .start_thread(StartThreadRequest {
            workspace_id: task.summary.workspace_id.clone(),
            provider: Some(task.summary.provider.clone()),
            model_id: task.model_id.clone(),
            collaboration_mode_id: task.collaboration_mode_id.clone(),
            approval_policy: task.approval_policy.clone(),
            sandbox_mode: task.sandbox_mode.clone(),
            permission_mode: task.permission_mode.clone(),
            isolation: task.isolation,
            handoff_from: None,
        })
        .await;
    let handle = match started {
        Ok(handle) => handle,
        Err(error) => {
            let _ = finish_run(
                &app,
                &task_id,
                &run_id,
                ScheduledTaskRunStatus::Failed,
                Some(error.to_string()),
            )
            .await;
            return;
        }
    };
    if let Err(error) = mark_run_running(
        &app,
        &task_id,
        &run_id,
        &task.summary.workspace_id,
        &handle.thread.id,
    )
    .await
    {
        tracing::warn!(%error, %task_id, %run_id, "scheduled task run was cancelled during thread creation");
        if let Err(interrupt_error) = app
            .interrupt_turn(task.summary.workspace_id.clone(), handle.thread.id.clone())
            .await
        {
            tracing::warn!(%interrupt_error, %task_id, %run_id, "failed to interrupt cancelled scheduled task thread");
        }
        if run_is_queued(&app, &task_id, &run_id).await {
            let _ = finish_run(
                &app,
                &task_id,
                &run_id,
                ScheduledTaskRunStatus::Failed,
                Some(error.to_string()),
            )
            .await;
        }
        return;
    }
    let origin = falcondeck_core::ThreadOrigin::ScheduledTask {
        task_id: task_id.clone(),
        title: task.summary.title.clone(),
    };
    let _ = app
        .with_thread_mut(&task.summary.workspace_id, &handle.thread.id, |thread| {
            thread.origin = Some(origin)
        })
        .await;
    if let Ok(thread) = app
        .thread_summary(&task.summary.workspace_id, &handle.thread.id)
        .await
    {
        app.emit(
            Some(task.summary.workspace_id.clone()),
            Some(handle.thread.id.clone()),
            UnifiedEvent::ThreadUpdated { thread },
        );
    }
    // Subscribe only after publishing the new thread's provenance. That
    // metadata event carries start_thread's initial Idle state and must never
    // be mistaken for a completed non-Codex turn. Subscribing immediately
    // before send_turn still captures the Running and terminal transitions.
    let mut events = app.subscribe();
    let expects_turn_end = task.summary.provider == AgentProvider::CODEX;
    let dispatch_started_at = Utc::now();
    let response = dispatch_turn_if_run_is_active(
        &app,
        &task_id,
        &run_id,
        &handle.thread.id,
        SendTurnRequest {
            workspace_id: task.summary.workspace_id.clone(),
            thread_id: handle.thread.id.clone(),
            inputs: vec![TurnInputItem::Text {
                id: None,
                text: task.prompt.clone(),
            }],
            selected_skills: task.selected_skills.clone(),
            provider: Some(task.summary.provider),
            model_id: task.model_id,
            reasoning_effort: task.reasoning_effort,
            approval_policy: task.approval_policy,
            service_tier: None,
            permission_mode: task.permission_mode,
            sandbox_mode: task.sandbox_mode,
            steer: false,
            user_item_id: None,
            resume_interrupted: false,
        },
    )
    .await;
    if let Err(error) = response {
        if let Err(interrupt_error) = app
            .interrupt_turn(task.summary.workspace_id.clone(), handle.thread.id.clone())
            .await
        {
            tracing::warn!(%interrupt_error, %task_id, %run_id, "failed to interrupt undispatched scheduled task thread");
        }
        let _ = finish_run(
            &app,
            &task_id,
            &run_id,
            ScheduledTaskRunStatus::Failed,
            Some(error.to_string()),
        )
        .await;
        return;
    }
    let mut terminal_poll = interval(RUN_TERMINAL_POLL);
    terminal_poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // `interval` ticks immediately once. Consume that tick so the fallback is
    // genuinely periodic and normal provider events remain the fast path.
    terminal_poll.tick().await;
    loop {
        let event = tokio::select! {
            event = events.recv() => Some(event),
            _ = terminal_poll.tick() => None,
        };
        let Some(event) = event else {
            if let Ok(thread) = app
                .thread_summary(&task.summary.workspace_id, &handle.thread.id)
                .await
                && let Some((status, preview)) =
                    terminal_run_from_thread_since(&thread, dispatch_started_at)
            {
                let _ = finish_run(&app, &task_id, &run_id, status, preview).await;
                break;
            }
            continue;
        };
        match event {
            Ok(envelope)
                if envelope.workspace_id.as_deref() == Some(&task.summary.workspace_id)
                    && envelope.thread_id.as_deref() == Some(&handle.thread.id) =>
            {
                match envelope.event.clone() {
                    UnifiedEvent::InteractiveRequest { .. } => {
                        let _ = update_run(&app, &task_id, &run_id, |run| {
                            run.status = ScheduledTaskRunStatus::AwaitingInput
                        })
                        .await;
                    }
                    UnifiedEvent::TurnEnd { status, error, .. } => {
                        let shutting_down = app.is_shutting_down();
                        let succeeded =
                            turn_completed_successfully(&status, error.as_deref(), shutting_down);
                        let state = if shutting_down {
                            ScheduledTaskRunStatus::Interrupted
                        } else if succeeded {
                            ScheduledTaskRunStatus::Succeeded
                        } else {
                            ScheduledTaskRunStatus::Failed
                        };
                        let preview = if shutting_down {
                            Some("Daemon stopped before the run completed".to_string())
                        } else if succeeded {
                            app.thread_summary(&task.summary.workspace_id, &handle.thread.id)
                                .await
                                .ok()
                                .and_then(|thread| thread.last_message_preview)
                        } else {
                            error.or_else(|| Some(format!("Turn ended with status {status}")))
                        };
                        let _ = finish_run(&app, &task_id, &run_id, state, preview).await;
                        break;
                    }
                    UnifiedEvent::ThreadUpdated { thread } => {
                        // Codex normally supplies the richer TurnEnd event, but
                        // an app-server crash can only produce an Error thread
                        // update. Settle that failure immediately as well.
                        let terminal = (!expects_turn_end || thread.status == ThreadStatus::Error)
                            .then(|| terminal_run_from_thread_since(&thread, dispatch_started_at))
                            .flatten();
                        if let Some((status, preview)) = terminal {
                            let _ = finish_run(&app, &task_id, &run_id, status, preview).await;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                tracing::warn!(
                    task_id,
                    run_id,
                    skipped,
                    "scheduled task executor lagged behind the daemon event stream"
                );
                if let Ok(thread) = app
                    .thread_summary(&task.summary.workspace_id, &handle.thread.id)
                    .await
                {
                    let terminal = terminal_run_from_thread_since(&thread, dispatch_started_at);
                    if let Some((status, preview)) = terminal {
                        let _ = finish_run(&app, &task_id, &run_id, status, preview).await;
                        break;
                    }
                }
            }
            Err(broadcast::error::RecvError::Closed) => {
                let _ = finish_run(
                    &app,
                    &task_id,
                    &run_id,
                    ScheduledTaskRunStatus::Interrupted,
                    Some("Daemon event stream closed".to_string()),
                )
                .await;
                break;
            }
        }
    }
    drop(permit);
}

async fn dispatch_turn_if_run_is_active(
    app: &AppState,
    task_id: &str,
    run_id: &str,
    thread_id: &str,
    request: SendTurnRequest,
) -> Result<CommandResponse, DaemonError> {
    let run_is_active = || async {
        app.inner
            .scheduled_tasks
            .lock()
            .await
            .tasks
            .get(task_id)
            .and_then(|task| task.runs.iter().find(|run| run.id == run_id))
            .is_some_and(|run| {
                run.status == ScheduledTaskRunStatus::Running
                    && run.thread_id.as_deref() == Some(thread_id)
            })
    };
    {
        let _mutation = app.inner.scheduled_mutation.lock().await;
        if !run_is_active().await {
            return Err(DaemonError::BadRequest(
                "scheduled task run was cancelled before dispatch".to_string(),
            ));
        }
    }

    let response = app.send_turn(request).await?;

    // A pause/delete may win while the provider call is in flight. Recheck
    // after dispatch and interrupt in the caller if ownership disappeared;
    // this keeps mutations responsive without letting an orphaned turn run.
    let _mutation = app.inner.scheduled_mutation.lock().await;
    if !run_is_active().await {
        return Err(DaemonError::BadRequest(
            "scheduled task run was cancelled during dispatch".to_string(),
        ));
    }
    Ok(response)
}

async fn run_is_queued(app: &AppState, task_id: &str, run_id: &str) -> bool {
    app.inner
        .scheduled_tasks
        .lock()
        .await
        .tasks
        .get(task_id)
        .and_then(|task| task.runs.iter().find(|run| run.id == run_id))
        .is_some_and(|run| run.status == ScheduledTaskRunStatus::Queued)
}

async fn mark_run_running(
    app: &AppState,
    task_id: &str,
    run_id: &str,
    workspace_id: &str,
    thread_id: &str,
) -> Result<(), DaemonError> {
    let _mutation = app.inner.scheduled_mutation.lock().await;
    let (run, task_summary, previous) = {
        let mut registry = app.inner.scheduled_tasks.lock().await;
        let previous = registry
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("scheduled task not found".to_string()))?;
        let task = registry.task_mut(task_id)?;
        let run = task
            .runs
            .iter_mut()
            .find(|run| run.id == run_id)
            .ok_or_else(|| DaemonError::NotFound("scheduled task run not found".to_string()))?;
        if run.status != ScheduledTaskRunStatus::Queued {
            return Err(DaemonError::BadRequest(
                "scheduled task run is no longer queued".to_string(),
            ));
        }
        run.status = ScheduledTaskRunStatus::Running;
        run.started_at = Some(Utc::now());
        run.workspace_id = workspace_id.to_string();
        run.thread_id = Some(thread_id.to_string());
        let run = run.clone();
        task.detail.summary.last_run = task.runs.last().cloned();
        task.detail.summary.updated_at = Utc::now();
        (run, task.detail.summary.clone(), previous)
    };
    if let Err(error) = persist_registry(app).await {
        app.inner
            .scheduled_tasks
            .lock()
            .await
            .tasks
            .insert(task_id.to_string(), previous);
        return Err(error);
    }
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskRunUpdated {
            task_id: task_id.to_string(),
            run,
        },
    );
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskUpdated { task: task_summary },
    );
    Ok(())
}

fn terminal_run_from_thread(
    thread: &falcondeck_core::ThreadSummary,
) -> Option<(ScheduledTaskRunStatus, Option<String>)> {
    match thread.status {
        ThreadStatus::Idle => Some((
            ScheduledTaskRunStatus::Succeeded,
            thread.last_message_preview.clone(),
        )),
        ThreadStatus::Error => Some((
            ScheduledTaskRunStatus::Failed,
            thread
                .last_error
                .clone()
                .or_else(|| thread.last_message_preview.clone())
                .or_else(|| Some("Scheduled task thread failed".to_string())),
        )),
        ThreadStatus::Running | ThreadStatus::WaitingForInput => None,
    }
}

fn terminal_run_from_thread_since(
    thread: &falcondeck_core::ThreadSummary,
    dispatch_started_at: DateTime<Utc>,
) -> Option<(ScheduledTaskRunStatus, Option<String>)> {
    (thread.updated_at >= dispatch_started_at)
        .then(|| terminal_run_from_thread(thread))
        .flatten()
}

fn turn_completed_successfully(status: &str, error: Option<&str>, shutting_down: bool) -> bool {
    !shutting_down
        && error.is_none()
        && !is_failed_turn_status(status)
        && !is_interrupt_turn_status(status)
}

async fn finish_run(
    app: &AppState,
    task_id: &str,
    run_id: &str,
    status: ScheduledTaskRunStatus,
    preview: Option<String>,
) -> Result<(), DaemonError> {
    let _mutation = app.inner.scheduled_mutation.lock().await;
    let now = Utc::now();
    let (finished, updated, next_queued, previous) = {
        let mut registry = app.inner.scheduled_tasks.lock().await;
        let previous = registry
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("scheduled task not found".to_string()))?;
        let task = registry.task_mut(task_id)?;
        let run = task
            .runs
            .iter_mut()
            .find(|run| run.id == run_id)
            .ok_or_else(|| DaemonError::NotFound("scheduled task run not found".to_string()))?;
        run.status = status;
        run.completed_at = Some(now);
        run.preview = preview;
        let finished = run.clone();
        task.detail.summary.last_run = task.runs.last().cloned();
        task.detail.summary.updated_at = now;
        let next_queued = task
            .runs
            .iter()
            .find(|run| run.status == ScheduledTaskRunStatus::Queued)
            .map(|run| run.id.clone());
        if matches!(
            task.detail.summary.schedule,
            ScheduledTaskSchedule::Once { .. }
        ) && next_queued.is_none()
        {
            task.detail.summary.status = ScheduledTaskStatus::Completed;
            task.detail.summary.next_run_at = None;
        }
        (finished, task.detail.summary.clone(), next_queued, previous)
    };
    if let Err(error) = persist_registry(app).await {
        app.inner
            .scheduled_tasks
            .lock()
            .await
            .tasks
            .insert(task_id.to_string(), previous);
        return Err(error);
    }
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskRunUpdated {
            task_id: task_id.to_string(),
            run: finished,
        },
    );
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskUpdated { task: updated },
    );
    if let Some(run_id) = next_queued {
        spawn_run(app, task_id, &run_id);
    }
    Ok(())
}

async fn update_run(
    app: &AppState,
    task_id: &str,
    run_id: &str,
    update: impl FnOnce(&mut ScheduledTaskRunSummary),
) -> Result<(), DaemonError> {
    let _mutation = app.inner.scheduled_mutation.lock().await;
    let (run, task_summary, previous) = {
        let mut registry = app.inner.scheduled_tasks.lock().await;
        let previous = registry
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| DaemonError::NotFound("scheduled task not found".to_string()))?;
        let task = registry.task_mut(task_id)?;
        let run = task
            .runs
            .iter_mut()
            .find(|run| run.id == run_id)
            .ok_or_else(|| DaemonError::NotFound("scheduled task run not found".to_string()))?;
        update(run);
        let run = run.clone();
        task.detail.summary.last_run = task.runs.last().cloned();
        task.detail.summary.updated_at = Utc::now();
        (run, task.detail.summary.clone(), previous)
    };
    if let Err(error) = persist_registry(app).await {
        app.inner
            .scheduled_tasks
            .lock()
            .await
            .tasks
            .insert(task_id.to_string(), previous);
        return Err(error);
    }
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskRunUpdated {
            task_id: task_id.to_string(),
            run,
        },
    );
    app.emit(
        None,
        None,
        UnifiedEvent::ScheduledTaskUpdated { task: task_summary },
    );
    Ok(())
}

pub(super) async fn interrupt_active_runs(app: &AppState) -> Result<(), DaemonError> {
    let _mutation = app.inner.scheduled_mutation.lock().await;
    let now = Utc::now();
    let mut updates = Vec::new();
    let previous = app.inner.scheduled_tasks.lock().await.clone();
    {
        let mut registry = app.inner.scheduled_tasks.lock().await;
        for task in registry.tasks.values_mut() {
            for run in &mut task.runs {
                if matches!(
                    run.status,
                    ScheduledTaskRunStatus::Queued
                        | ScheduledTaskRunStatus::Running
                        | ScheduledTaskRunStatus::AwaitingInput
                ) {
                    run.status = ScheduledTaskRunStatus::Interrupted;
                    run.completed_at = Some(now);
                    run.preview = Some("Daemon shut down before the run completed".to_string());
                    updates.push((task.detail.summary.id.clone(), run.clone()));
                }
            }
            task.detail.summary.last_run = task.runs.last().cloned();
        }
    }
    if let Err(error) = persist_registry(app).await {
        *app.inner.scheduled_tasks.lock().await = previous;
        return Err(error);
    }
    for (task_id, run) in updates {
        app.emit(
            None,
            None,
            UnifiedEvent::ScheduledTaskRunUpdated { task_id, run },
        );
    }
    Ok(())
}

async fn validate_definition(
    app: &AppState,
    request: &CreateScheduledTaskRequest,
) -> Result<(), DaemonError> {
    validate_text("title", &request.title, MAX_TITLE_BYTES)?;
    validate_text("prompt", &request.prompt, MAX_PROMPT_BYTES)?;
    validate_schedule(&request.schedule, Utc::now())?;
    validate_provider(app, &request.workspace_id, &request.provider).await
}

async fn validate_provider(
    app: &AppState,
    workspace_id: &str,
    provider: &falcondeck_core::AgentProvider,
) -> Result<(), DaemonError> {
    let workspaces = app.inner.workspaces.lock().await;
    let workspace = workspaces
        .get(workspace_id)
        .ok_or_else(|| DaemonError::NotFound("workspace not found".to_string()))?;
    if !workspace
        .summary
        .agents
        .iter()
        .any(|agent| &agent.provider == provider)
    {
        return Err(DaemonError::BadRequest(format!(
            "provider {} is not available in this workspace",
            provider
        )));
    }
    Ok(())
}

async fn validate_run_dependencies(
    app: &AppState,
    task: &ScheduledTaskDetail,
) -> Result<(), DaemonError> {
    let workspace = app
        .inner
        .workspaces
        .lock()
        .await
        .get(&task.summary.workspace_id)
        .map(|workspace| workspace.summary.clone())
        .ok_or_else(|| {
            DaemonError::NotFound("scheduled task workspace is unavailable".to_string())
        })?;
    validate_task_against_workspace(task, &workspace, true)
}

fn validate_task_against_workspace(
    task: &ScheduledTaskDetail,
    workspace: &WorkspaceSummary,
    require_ready: bool,
) -> Result<(), DaemonError> {
    if require_ready
        && !matches!(
            workspace.status,
            WorkspaceStatus::Ready | WorkspaceStatus::Busy
        )
    {
        return Err(DaemonError::BadRequest(format!(
            "scheduled task workspace is not ready ({:?})",
            workspace.status
        )));
    }
    let agent = workspace
        .agents
        .iter()
        .find(|agent| agent.provider == task.summary.provider)
        .ok_or_else(|| {
            DaemonError::BadRequest(format!(
                "provider {} is no longer available in this workspace",
                task.summary.provider
            ))
        })?;
    let selected_model = task
        .model_id
        .as_ref()
        .map(|model_id| {
            agent
                .models
                .iter()
                .find(|model| model.id == *model_id)
                .ok_or_else(|| {
                    DaemonError::BadRequest(format!(
                        "model {model_id} is no longer available for {}",
                        task.summary.provider
                    ))
                })
        })
        .transpose()?;
    if let (Some(effort), Some(model)) = (task.reasoning_effort.as_ref(), selected_model)
        && !model
            .supported_reasoning_efforts
            .iter()
            .any(|candidate| candidate.reasoning_effort == *effort)
    {
        return Err(DaemonError::BadRequest(format!(
            "reasoning effort {effort} is no longer available for model {}",
            model.id
        )));
    }
    if let Some(mode_id) = task.collaboration_mode_id.as_ref()
        && !agent
            .collaboration_modes
            .iter()
            .any(|mode| mode.id == *mode_id)
    {
        return Err(DaemonError::BadRequest(format!(
            "collaboration mode {mode_id} is no longer available"
        )));
    }
    if let Some(sandbox_mode) = task.sandbox_mode.as_ref()
        && !agent.capabilities.sandbox_modes.is_empty()
        && !agent.capabilities.sandbox_modes.contains(sandbox_mode)
    {
        return Err(DaemonError::BadRequest(format!(
            "sandbox mode {sandbox_mode} is no longer available"
        )));
    }
    if let Some(permission_mode) = task.permission_mode.as_ref()
        && !permission_mode.eq_ignore_ascii_case("default")
        && !agent.capabilities.permission_modes.is_empty()
        && !agent
            .capabilities
            .permission_modes
            .contains(permission_mode)
    {
        return Err(DaemonError::BadRequest(format!(
            "permission mode {permission_mode} is no longer available"
        )));
    }
    for selected in &task.selected_skills {
        let available = workspace.skills.iter().any(|skill| {
            (skill.id == selected.skill_id || skill.alias.eq_ignore_ascii_case(&selected.alias))
                && skill.supports_provider(&task.summary.provider)
        });
        if !available {
            return Err(DaemonError::BadRequest(format!(
                "skill {} is no longer available for {}",
                selected.alias, task.summary.provider
            )));
        }
    }
    Ok(())
}

fn prompt_preview(prompt: &str) -> String {
    const LIMIT: usize = 160;
    let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let preview = chars.by_ref().take(LIMIT).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}…")
    } else {
        preview
    }
}

fn validate_text(field: &str, value: &str, max_bytes: usize) -> Result<(), DaemonError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(DaemonError::BadRequest(format!("{field} is required")));
    }
    if trimmed.len() > max_bytes {
        return Err(DaemonError::BadRequest(format!("{field} is too long")));
    }
    Ok(())
}

fn validate_schedule(
    schedule: &ScheduledTaskSchedule,
    now: DateTime<Utc>,
) -> Result<(), DaemonError> {
    match schedule {
        ScheduledTaskSchedule::Once { run_at, timezone } => {
            parse_timezone(timezone)?;
            if *run_at <= now {
                return Err(DaemonError::BadRequest(
                    "one-time tasks must be scheduled in the future".to_string(),
                ));
            }
        }
        ScheduledTaskSchedule::Recurring { rrule, timezone } => {
            parse_timezone(timezone)?;
            let parsed = parse_rule(rrule)?;
            if parsed.frequency == Frequency::Minutely
                && parsed.interval < MIN_RECURRING_INTERVAL_MINUTES
            {
                return Err(DaemonError::BadRequest(
                    "recurring tasks must be at least five minutes apart".to_string(),
                ));
            }
            let _ = next_recurring_occurrence(&parsed, timezone, now, now)?;
        }
    }
    Ok(())
}

fn reconcile_next_run(
    detail: &mut ScheduledTaskDetail,
    now: DateTime<Utc>,
    restoring: bool,
) -> Result<(), DaemonError> {
    if restoring
        && matches!(detail.summary.schedule, ScheduledTaskSchedule::Once { .. })
        && detail.summary.last_run.is_some()
    {
        detail.summary.status = ScheduledTaskStatus::Completed;
        detail.summary.next_run_at = None;
        return Ok(());
    }
    if detail.summary.status != ScheduledTaskStatus::Active {
        detail.summary.next_run_at = None;
        return Ok(());
    }
    detail.summary.next_run_at = match &detail.summary.schedule {
        ScheduledTaskSchedule::Once { run_at, .. } => {
            if restoring && *run_at <= now && detail.summary.last_run.is_none() {
                Some(now)
            } else if detail.summary.last_run.is_some() {
                None
            } else {
                Some(*run_at)
            }
        }
        ScheduledTaskSchedule::Recurring { rrule, timezone } => {
            let parsed = parse_rule(rrule)?;
            next_recurring_occurrence(&parsed, timezone, detail.created_at, now)?
        }
    };
    Ok(())
}

fn parse_timezone(value: &str) -> Result<Tz, DaemonError> {
    Tz::from_str(value)
        .map_err(|_| DaemonError::BadRequest("timezone must be a valid IANA timezone".to_string()))
}

fn parse_rule(rrule: &str) -> Result<ParsedRule, DaemonError> {
    let raw = rrule.trim().strip_prefix("RRULE:").unwrap_or(rrule.trim());
    let mut values = HashMap::new();
    for part in raw.split(';') {
        let (key, value) = part.split_once('=').ok_or_else(|| {
            DaemonError::BadRequest("RRULE fields must use KEY=VALUE syntax".to_string())
        })?;
        let key = key.to_ascii_uppercase();
        if !matches!(
            key.as_str(),
            "FREQ" | "INTERVAL" | "BYDAY" | "BYHOUR" | "BYMINUTE"
        ) {
            return Err(DaemonError::BadRequest(format!(
                "RRULE field {key} is not supported in scheduled tasks"
            )));
        }
        if value.is_empty()
            || values
                .insert(key.clone(), value.to_ascii_uppercase())
                .is_some()
        {
            return Err(DaemonError::BadRequest(format!(
                "RRULE field {key} must appear once with a value"
            )));
        }
    }
    let frequency = match values.get("FREQ").map(String::as_str) {
        Some("MINUTELY") => Frequency::Minutely,
        Some("HOURLY") => Frequency::Hourly,
        Some("DAILY") => Frequency::Daily,
        Some("WEEKLY") => Frequency::Weekly,
        _ => {
            return Err(DaemonError::BadRequest(
                "RRULE FREQ must be MINUTELY, HOURLY, DAILY, or WEEKLY".to_string(),
            ));
        }
    };
    let interval = values.get("INTERVAL").map_or(Ok(1), |value| {
        value.parse::<i64>().map_err(|_| {
            DaemonError::BadRequest("RRULE INTERVAL must be a positive integer".to_string())
        })
    })?;
    if !(1..=10_000).contains(&interval) {
        return Err(DaemonError::BadRequest(
            "RRULE INTERVAL is outside the supported range".to_string(),
        ));
    }
    let maximum_interval = match frequency {
        Frequency::Minutely => 10_000,
        Frequency::Hourly => 8_760,
        Frequency::Daily => 365,
        Frequency::Weekly => 52,
    };
    if interval > maximum_interval {
        return Err(DaemonError::BadRequest(format!(
            "RRULE INTERVAL exceeds the supported {maximum_interval} limit for this frequency"
        )));
    }
    let weekdays = values
        .get("BYDAY")
        .map(|value| {
            value
                .split(',')
                .map(parse_weekday)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    if frequency != Frequency::Weekly && !weekdays.is_empty() {
        return Err(DaemonError::BadRequest(
            "BYDAY is supported only for WEEKLY scheduled tasks".to_string(),
        ));
    }
    let hour = parse_rule_number(&values, "BYHOUR", 23)?;
    let minute = parse_rule_number(&values, "BYMINUTE", 59)?;
    if frequency == Frequency::Minutely && (hour.is_some() || minute.is_some()) {
        return Err(DaemonError::BadRequest(
            "MINUTELY rules do not support BYHOUR or BYMINUTE".to_string(),
        ));
    }
    if frequency == Frequency::Hourly && hour.is_some() {
        return Err(DaemonError::BadRequest(
            "HOURLY rules do not support BYHOUR".to_string(),
        ));
    }
    Ok(ParsedRule {
        frequency,
        interval,
        weekdays,
        hour,
        minute,
    })
}

fn parse_rule_number(
    values: &HashMap<String, String>,
    key: &str,
    max: u32,
) -> Result<Option<u32>, DaemonError> {
    values
        .get(key)
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| DaemonError::BadRequest(format!("RRULE {key} must be an integer")))
                .and_then(|number| {
                    if number <= max {
                        Ok(number)
                    } else {
                        Err(DaemonError::BadRequest(format!(
                            "RRULE {key} is outside the supported range"
                        )))
                    }
                })
        })
        .transpose()
}

fn parse_weekday(value: &str) -> Result<Weekday, DaemonError> {
    match value {
        "MO" => Ok(Weekday::Mon),
        "TU" => Ok(Weekday::Tue),
        "WE" => Ok(Weekday::Wed),
        "TH" => Ok(Weekday::Thu),
        "FR" => Ok(Weekday::Fri),
        "SA" => Ok(Weekday::Sat),
        "SU" => Ok(Weekday::Sun),
        _ => Err(DaemonError::BadRequest(
            "RRULE BYDAY contains an unsupported weekday".to_string(),
        )),
    }
}

fn next_recurring_occurrence(
    rule: &ParsedRule,
    timezone: &str,
    anchor: DateTime<Utc>,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, DaemonError> {
    let timezone = parse_timezone(timezone)?;
    let anchor = anchor
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(anchor);
    let anchor_local = anchor.with_timezone(&timezone);
    let mut candidate = after + ChronoDuration::minutes(1);
    candidate = candidate
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(candidate);
    let limit = candidate + ChronoDuration::days(370);
    while candidate <= limit {
        let local = candidate.with_timezone(&timezone);
        let elapsed_minutes = (candidate - anchor).num_minutes();
        let frequency_matches = match rule.frequency {
            Frequency::Minutely => {
                elapsed_minutes >= 0 && elapsed_minutes.rem_euclid(rule.interval) == 0
            }
            Frequency::Hourly => {
                let elapsed_hours = (candidate - anchor).num_hours();
                elapsed_hours >= 0
                    && elapsed_hours.rem_euclid(rule.interval) == 0
                    && local.minute() == rule.minute.unwrap_or(anchor_local.minute())
            }
            Frequency::Daily => {
                let elapsed_days = local
                    .date_naive()
                    .signed_duration_since(anchor_local.date_naive())
                    .num_days();
                elapsed_days >= 0
                    && elapsed_days.rem_euclid(rule.interval) == 0
                    && local.hour() == rule.hour.unwrap_or(anchor_local.hour())
                    && local.minute() == rule.minute.unwrap_or(anchor_local.minute())
            }
            Frequency::Weekly => {
                let local_week_start = local.date_naive()
                    - ChronoDuration::days(i64::from(local.weekday().num_days_from_monday()));
                let anchor_week_start = anchor_local.date_naive()
                    - ChronoDuration::days(i64::from(
                        anchor_local.weekday().num_days_from_monday(),
                    ));
                let elapsed_weeks = local_week_start
                    .signed_duration_since(anchor_week_start)
                    .num_days()
                    .div_euclid(7);
                elapsed_weeks >= 0
                    && elapsed_weeks.rem_euclid(rule.interval) == 0
                    && (if rule.weekdays.is_empty() {
                        local.weekday() == anchor_local.weekday()
                    } else {
                        rule.weekdays.contains(&local.weekday())
                    })
                    && local.hour() == rule.hour.unwrap_or(anchor_local.hour())
                    && local.minute() == rule.minute.unwrap_or(anchor_local.minute())
            }
        };
        if frequency_matches
            && (rule.weekdays.is_empty() || rule.weekdays.contains(&local.weekday()))
        {
            return Ok(Some(candidate));
        }
        candidate += ChronoDuration::minutes(1);
    }
    Err(DaemonError::BadRequest(
        "RRULE does not produce an occurrence within the supported horizon".to_string(),
    ))
}

fn trim_runs(runs: &mut Vec<ScheduledTaskRunSummary>) {
    while runs.len() > RUN_HISTORY_LIMIT {
        let index = runs.iter().position(|run| !is_active_run(run)).unwrap_or(0);
        runs.remove(index);
    }
}

fn is_active_run(run: &ScheduledTaskRunSummary) -> bool {
    matches!(
        run.status,
        ScheduledTaskRunStatus::Queued
            | ScheduledTaskRunStatus::Running
            | ScheduledTaskRunStatus::AwaitingInput
    )
}

fn enqueue_disposition(
    active_count: usize,
    trigger: ScheduledTaskRunTrigger,
) -> Result<EnqueueDisposition, DaemonError> {
    if active_count > 0 && trigger == ScheduledTaskRunTrigger::Manual {
        return Err(DaemonError::BadRequest(
            "this task already has an active run".to_string(),
        ));
    }
    Ok(match active_count {
        0 => EnqueueDisposition::Start,
        1 => EnqueueDisposition::Coalesce,
        _ => EnqueueDisposition::Skip,
    })
}

fn skip_coalesced_pending_runs(task: &mut PersistedScheduledTask, now: DateTime<Utc>) {
    for run in &mut task.runs {
        if run.status == ScheduledTaskRunStatus::Queued {
            run.status = ScheduledTaskRunStatus::Skipped;
            run.completed_at = Some(now);
            run.preview =
                Some("Pending occurrence skipped because the task was paused".to_string());
        }
    }
    task.detail.summary.last_run = task.runs.last().cloned();
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn task_for_dependency_test() -> ScheduledTaskDetail {
        serde_json::from_value(serde_json::json!({
            "id": "scheduled-1",
            "title": "Dependency check",
            "prompt_preview": "Check dependencies",
            "status": "active",
            "schedule": { "kind": "recurring", "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", "timezone": "UTC" },
            "workspace_id": "workspace-1",
            "provider": "codex",
            "updated_at": "2026-08-13T08:00:00Z",
            "prompt": "Check dependencies",
            "model_id": "gpt-test",
            "isolation": "project_folder",
            "selected_skills": [{ "skill_id": "skill-1", "alias": "/skill-1" }],
            "created_at": "2026-08-13T08:00:00Z"
        }))
        .unwrap()
    }

    fn workspace_for_dependency_test() -> WorkspaceSummary {
        serde_json::from_value(serde_json::json!({
            "id": "workspace-1",
            "path": "/tmp/workspace",
            "status": "ready",
            "agents": [{
                "provider": "codex",
                "label": "Codex",
                "account": { "status": "ready", "label": "Ready" },
                "models": [{
                    "id": "gpt-test",
                    "label": "GPT Test",
                    "is_default": true,
                    "default_reasoning_effort": null,
                    "supported_reasoning_efforts": []
                }],
                "collaboration_modes": [],
                "skills": [],
                "capabilities": { "sandbox_modes": [], "permission_modes": [] }
            }],
            "skills": [{
                "id": "skill-1",
                "label": "Skill 1",
                "alias": "/skill-1",
                "availability": "codex",
                "providers": ["codex"],
                "source_kind": "provider_native",
                "provider_translations": {}
            }],
            "default_provider": "codex",
            "current_thread_id": null,
            "connected_at": "2026-08-13T08:00:00Z",
            "updated_at": "2026-08-13T08:00:00Z",
            "last_error": null
        }))
        .unwrap()
    }

    fn thread_with_status(
        status: &str,
        last_error: Option<&str>,
    ) -> falcondeck_core::ThreadSummary {
        serde_json::from_value(serde_json::json!({
            "id": "thread-1",
            "workspace_id": "workspace-1",
            "title": "Scheduled run",
            "provider": "claude",
            "status": status,
            "updated_at": "2026-08-13T08:00:00Z",
            "last_message_preview": "Finished work",
            "latest_turn_id": "turn-1",
            "latest_plan": null,
            "latest_diff": null,
            "last_tool": null,
            "last_error": last_error
        }))
        .unwrap()
    }

    #[test]
    fn recurring_rule_respects_london_wall_clock_across_dst() {
        let rule = parse_rule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0").unwrap();
        let after = Utc.with_ymd_and_hms(2026, 3, 28, 10, 0, 0).unwrap();
        let next = next_recurring_occurrence(&rule, "Europe/London", after, after)
            .unwrap()
            .unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 3, 29, 8, 0, 0).unwrap());
    }

    #[test]
    fn recurring_rule_skips_a_nonexistent_dst_wall_time() {
        let rule = parse_rule("FREQ=DAILY;BYHOUR=1;BYMINUTE=30").unwrap();
        let anchor = Utc.with_ymd_and_hms(2026, 3, 28, 1, 30, 0).unwrap();
        let next = next_recurring_occurrence(&rule, "Europe/London", anchor, anchor)
            .unwrap()
            .unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 3, 30, 0, 30, 0).unwrap());
    }

    #[test]
    fn recurring_rule_uses_first_instant_in_a_dst_fold() {
        let rule = parse_rule("FREQ=DAILY;BYHOUR=1;BYMINUTE=30").unwrap();
        let anchor = Utc.with_ymd_and_hms(2026, 10, 24, 0, 30, 0).unwrap();
        let next = next_recurring_occurrence(&rule, "Europe/London", anchor, anchor)
            .unwrap()
            .unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 10, 25, 0, 30, 0).unwrap());
    }

    #[test]
    fn interval_is_anchored_to_task_creation() {
        let rule = parse_rule("FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0").unwrap();
        let anchor = Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap();
        let after = Utc.with_ymd_and_hms(2026, 8, 13, 9, 0, 0).unwrap();
        let next = next_recurring_occurrence(&rule, "Europe/London", anchor, after)
            .unwrap()
            .unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 8, 15, 8, 0, 0).unwrap());
    }

    #[test]
    fn minutely_interval_ignores_creation_seconds() {
        let rule = parse_rule("FREQ=MINUTELY;INTERVAL=5").unwrap();
        let anchor = Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 45).unwrap();
        let next = next_recurring_occurrence(&rule, "UTC", anchor, anchor)
            .unwrap()
            .unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 8, 13, 8, 5, 0).unwrap());
    }

    #[test]
    fn hourly_interval_ignores_creation_seconds() {
        let rule = parse_rule("FREQ=HOURLY;INTERVAL=2;BYMINUTE=0").unwrap();
        let anchor = Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 45).unwrap();
        let next = next_recurring_occurrence(&rule, "UTC", anchor, anchor)
            .unwrap()
            .unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 8, 13, 10, 0, 0).unwrap());
    }

    #[test]
    fn unsupported_rrule_fields_are_rejected_instead_of_ignored() {
        assert!(parse_rule("FREQ=DAILY;COUNT=2").is_err());
        assert!(parse_rule("FREQ=DAILY;BYHOUR=9;BYHOUR=10").is_err());
    }

    #[test]
    fn overlapping_occurrences_coalesce_only_one_pending_run() {
        assert_eq!(MAX_CONCURRENT_RUNS, 2);
        assert_eq!(
            enqueue_disposition(0, ScheduledTaskRunTrigger::Scheduled).unwrap(),
            EnqueueDisposition::Start
        );
        assert_eq!(
            enqueue_disposition(1, ScheduledTaskRunTrigger::Scheduled).unwrap(),
            EnqueueDisposition::Coalesce
        );
        assert_eq!(
            enqueue_disposition(2, ScheduledTaskRunTrigger::Scheduled).unwrap(),
            EnqueueDisposition::Skip
        );
        assert!(enqueue_disposition(1, ScheduledTaskRunTrigger::Manual).is_err());
    }

    #[test]
    fn pausing_skips_every_run_that_has_not_started() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 9, 0, 0).unwrap();
        let mut task = PersistedScheduledTask {
            detail: task_for_dependency_test(),
            runs: [
                ("running", ScheduledTaskRunStatus::Running),
                ("queued-1", ScheduledTaskRunStatus::Queued),
                ("queued-2", ScheduledTaskRunStatus::Queued),
            ]
            .into_iter()
            .map(|(id, status)| ScheduledTaskRunSummary {
                id: id.to_string(),
                task_id: "scheduled-1".to_string(),
                status,
                trigger: ScheduledTaskRunTrigger::Scheduled,
                scheduled_for: now,
                started_at: None,
                completed_at: None,
                workspace_id: "workspace-1".to_string(),
                thread_id: None,
                preview: None,
            })
            .collect(),
        };

        skip_coalesced_pending_runs(&mut task, now);

        assert_eq!(task.runs[0].status, ScheduledTaskRunStatus::Running);
        assert_eq!(task.runs[1].status, ScheduledTaskRunStatus::Skipped);
        assert_eq!(task.runs[2].status, ScheduledTaskRunStatus::Skipped);
    }

    #[test]
    fn provider_thread_updates_settle_scheduled_runs() {
        let (status, preview) =
            terminal_run_from_thread(&thread_with_status("idle", None)).unwrap();
        assert_eq!(status, ScheduledTaskRunStatus::Succeeded);
        assert_eq!(preview.as_deref(), Some("Finished work"));

        let (status, preview) =
            terminal_run_from_thread(&thread_with_status("error", Some("Provider failed")))
                .unwrap();
        assert_eq!(status, ScheduledTaskRunStatus::Failed);
        assert_eq!(preview.as_deref(), Some("Provider failed"));

        assert!(terminal_run_from_thread(&thread_with_status("running", None)).is_none());
        assert!(terminal_run_from_thread(&thread_with_status("waiting_for_input", None)).is_none());
    }

    #[test]
    fn pre_dispatch_idle_metadata_does_not_settle_a_provider_run() {
        let idle = thread_with_status("idle", None);
        let after_origin_update = Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 1).unwrap();
        assert!(terminal_run_from_thread_since(&idle, after_origin_update).is_none());

        let before_terminal_update = Utc.with_ymd_and_hms(2026, 8, 13, 7, 59, 59).unwrap();
        assert!(terminal_run_from_thread_since(&idle, before_terminal_update).is_some());
    }

    #[test]
    fn codex_terminal_statuses_follow_the_daemon_classifier() {
        assert!(turn_completed_successfully("completed", None, false));
        assert!(turn_completed_successfully("incomplete", None, false));
        assert!(!turn_completed_successfully("failed", None, false));
        assert!(!turn_completed_successfully("cancelled", None, false));
        assert!(!turn_completed_successfully(
            "completed",
            Some("provider error"),
            false
        ));
        assert!(!turn_completed_successfully("completed", None, true));
    }

    #[test]
    fn scheduled_runs_fail_instead_of_falling_back_when_dependencies_change() {
        let task = task_for_dependency_test();
        let workspace = workspace_for_dependency_test();
        validate_task_against_workspace(&task, &workspace, true).unwrap();

        let mut missing_model = workspace.clone();
        missing_model.agents[0].models.clear();
        assert!(validate_task_against_workspace(&task, &missing_model, true).is_err());

        let mut missing_skill = workspace.clone();
        missing_skill.skills.clear();
        assert!(validate_task_against_workspace(&task, &missing_skill, true).is_err());

        let mut offline = workspace;
        offline.status = WorkspaceStatus::Disconnected;
        assert!(validate_task_against_workspace(&task, &offline, true).is_err());
        assert!(validate_task_against_workspace(&task, &offline, false).is_ok());
    }

    #[test]
    fn minutely_rule_rejects_intervals_below_five_minutes() {
        let schedule = ScheduledTaskSchedule::Recurring {
            rrule: "FREQ=MINUTELY;INTERVAL=4".to_string(),
            timezone: "UTC".to_string(),
        };
        assert!(validate_schedule(&schedule, Utc::now()).is_err());
    }

    #[test]
    fn one_time_rule_rejects_past_creation_time() {
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 9, 0, 0).unwrap();
        let schedule = ScheduledTaskSchedule::Once {
            run_at: now - ChronoDuration::minutes(1),
            timezone: "Europe/London".to_string(),
        };
        assert!(validate_schedule(&schedule, now).is_err());
    }

    #[test]
    fn run_history_keeps_latest_fifty_entries() {
        let mut runs = (0..51)
            .map(|index| ScheduledTaskRunSummary {
                id: index.to_string(),
                task_id: "task".to_string(),
                status: ScheduledTaskRunStatus::Succeeded,
                trigger: ScheduledTaskRunTrigger::Manual,
                scheduled_for: Utc::now(),
                started_at: None,
                completed_at: None,
                workspace_id: "workspace".to_string(),
                thread_id: None,
                preview: None,
            })
            .collect::<Vec<_>>();
        trim_runs(&mut runs);
        assert_eq!(runs.len(), RUN_HISTORY_LIMIT);
        assert_eq!(runs[0].id, "1");
    }

    #[test]
    fn legacy_daily_task_converts_without_losing_execution_or_history() {
        let mut task = PersistedScheduledTask {
            detail: task_for_dependency_test(),
            runs: vec![ScheduledTaskRunSummary {
                id: "run-legacy".to_string(),
                task_id: "scheduled-1".to_string(),
                status: ScheduledTaskRunStatus::Succeeded,
                trigger: ScheduledTaskRunTrigger::Manual,
                scheduled_for: Utc.with_ymd_and_hms(2026, 8, 13, 9, 0, 0).unwrap(),
                started_at: Some(Utc.with_ymd_and_hms(2026, 8, 13, 9, 0, 1).unwrap()),
                completed_at: Some(Utc.with_ymd_and_hms(2026, 8, 13, 9, 0, 5).unwrap()),
                workspace_id: "workspace-1".to_string(),
                thread_id: Some("thread-legacy".to_string()),
                preview: Some("Done".to_string()),
            }],
        };
        task.detail.reasoning_effort = Some("high".to_string());
        task.detail.collaboration_mode_id = Some("default".to_string());
        task.detail.approval_policy = Some("never".to_string());
        task.detail.permission_mode = Some("never".to_string());
        task.detail.sandbox_mode = Some("workspace-write".to_string());

        let (automation, runs) = legacy_automation(
            &task,
            "/tmp/workspace",
            Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap(),
        )
        .expect("daily schedules migrate losslessly");

        assert_eq!(automation.id, task.detail.summary.id);
        assert_eq!(automation.task.instruction(), task.detail.prompt);
        assert_eq!(automation.target.workspace_path, "/tmp/workspace");
        assert_eq!(automation.target.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            automation.target.collaboration_mode_id.as_deref(),
            Some("default")
        );
        assert_eq!(automation.target.approval_policy.as_deref(), Some("never"));
        assert_eq!(automation.target.permission_mode.as_deref(), Some("never"));
        assert_eq!(
            automation.target.sandbox_mode.as_deref(),
            Some("workspace-write")
        );
        assert_eq!(
            automation.target.isolation,
            Some(falcondeck_core::ThreadIsolation::ProjectFolder)
        );
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, "run-legacy");
        assert_eq!(runs[0].trigger, AutomationRunTrigger::Manual);
        assert_eq!(runs[0].thread_id.as_deref(), Some("thread-legacy"));
    }

    #[test]
    fn non_lossless_legacy_interval_stays_under_legacy_execution_ownership() {
        let mut task = PersistedScheduledTask {
            detail: task_for_dependency_test(),
            runs: Vec::new(),
        };
        task.detail.summary.schedule = ScheduledTaskSchedule::Recurring {
            rrule: "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0".to_string(),
            timezone: "Europe/London".to_string(),
        };

        assert!(
            legacy_automation(&task, "/tmp/workspace", Utc::now()).is_none(),
            "an every-other-day RRULE must not be approximated as cron"
        );
    }

    #[tokio::test]
    async fn legacy_import_is_deduplicated_by_stable_definition_and_run_ids() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-control.json");
        let service = crate::control::ControlService::new(path.clone());
        service.restore().await.unwrap();
        let task = PersistedScheduledTask {
            detail: task_for_dependency_test(),
            runs: vec![ScheduledTaskRunSummary {
                id: "run-legacy".to_string(),
                task_id: "scheduled-1".to_string(),
                status: ScheduledTaskRunStatus::Succeeded,
                trigger: ScheduledTaskRunTrigger::Scheduled,
                scheduled_for: Utc.with_ymd_and_hms(2026, 8, 13, 9, 0, 0).unwrap(),
                started_at: None,
                completed_at: Some(Utc.with_ymd_and_hms(2026, 8, 13, 9, 0, 5).unwrap()),
                workspace_id: "workspace-1".to_string(),
                thread_id: Some("thread-legacy".to_string()),
                preview: Some("Done".to_string()),
            }],
        };
        let converted = legacy_automation(&task, "/tmp/workspace", Utc::now()).unwrap();

        assert_eq!(
            service
                .import_legacy_automation(converted.0.clone(), converted.1.clone())
                .await
                .unwrap(),
            crate::control::LegacyImportOutcome::Imported
        );
        assert_eq!(
            service
                .import_legacy_automation(converted.0, converted.1)
                .await
                .unwrap(),
            crate::control::LegacyImportOutcome::AlreadyPresent
        );

        let persisted = crate::control::store::load(&path).await.unwrap();
        assert_eq!(persisted.automations.len(), 1);
        assert_eq!(persisted.runs.len(), 1);
    }

    #[tokio::test]
    async fn restore_interrupts_inflight_runs_and_recovers_unstarted_one_time_task() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scheduled-tasks.json");
        let run_at = Utc.with_ymd_and_hms(2026, 8, 13, 8, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 8, 13, 9, 0, 0).unwrap();
        let payload = serde_json::json!({
            "version": 1,
            "tasks": {
                "scheduled-1": {
                    "detail": {
                        "id": "scheduled-1",
                        "title": "Morning briefing",
                        "status": "active",
                        "schedule": { "kind": "once", "run_at": run_at, "timezone": "Europe/London" },
                        "workspace_id": "workspace-1",
                        "provider": "codex",
                        "next_run_at": run_at,
                        "last_run": null,
                        "updated_at": run_at,
                        "prompt": "Prepare the briefing",
                        "isolation": "project_folder",
                        "selected_skills": [],
                        "created_at": run_at
                    },
                    "runs": [{
                        "id": "run-1",
                        "task_id": "scheduled-1",
                        "status": "running",
                        "trigger": "scheduled",
                        "scheduled_for": run_at,
                        "started_at": run_at,
                        "workspace_id": "workspace-1"
                    }]
                },
                "scheduled-2": {
                    "detail": {
                        "id": "scheduled-2",
                        "title": "Unstarted briefing",
                        "status": "active",
                        "schedule": { "kind": "once", "run_at": run_at, "timezone": "Europe/London" },
                        "workspace_id": "workspace-1",
                        "provider": "codex",
                        "next_run_at": run_at,
                        "last_run": null,
                        "updated_at": run_at,
                        "prompt": "Prepare the briefing",
                        "isolation": "project_folder",
                        "selected_skills": [],
                        "created_at": run_at
                    },
                    "runs": []
                }
            }
        });
        tokio::fs::write(&path, serde_json::to_vec(&payload).unwrap())
            .await
            .unwrap();

        let restored = load_registry(&path, now).await.unwrap();
        let task = restored.tasks.get("scheduled-1").unwrap();
        assert_eq!(task.runs[0].status, ScheduledTaskRunStatus::Interrupted);
        assert_eq!(task.detail.summary.status, ScheduledTaskStatus::Completed);
        assert_eq!(task.detail.summary.next_run_at, None);
        assert_eq!(
            restored
                .tasks
                .get("scheduled-2")
                .unwrap()
                .detail
                .summary
                .next_run_at,
            Some(now)
        );
    }
}
