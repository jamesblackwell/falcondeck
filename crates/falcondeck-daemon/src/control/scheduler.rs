//! Background scheduler for agent-control automations.
//!
//! The scheduler is a daemon background task that wakes when the next due
//! instant arrives, when a definition changes, or when a run finishes. It
//! enqueues due occurrences through the control service (which applies
//! concurrency and misfire policy) and dispatches queued runs through the
//! existing workspace, thread and turn machinery. Completion is observed on
//! the normalized daemon event stream, never by polling the provider.

use std::collections::HashSet;
use std::sync::{Arc, Mutex as StdMutex};

use chrono::{DateTime, Utc};
use falcondeck_core::control::{
    AutomationRunStatus, AutomationThreadTarget, ControlDomain, ControlOrigin,
    ControlRequestContext, ControlStateChanged,
};
use falcondeck_core::{
    ThreadDetailMode, ThreadDetailRequest, ThreadOrigin, ThreadStatus, TurnInputItem, UnifiedEvent,
};
use tokio::sync::broadcast;
use tokio::time::{Duration, MissedTickBehavior, interval, sleep};

use super::service::RunSource;
use crate::app::AppState;

/// Defensive reconciliation cadence; the fast path is the notify channel.
const SCHEDULER_IDLE_POLL: Duration = Duration::from_secs(60);
/// How often a dispatched run re-checks thread state if events lag.
const RUN_TERMINAL_POLL: Duration = Duration::from_secs(30);

/// Starts the scheduler once per daemon. Later calls only wake it.
pub fn start(app: &AppState) {
    if !app.control().mark_scheduler_started() {
        app.control().notify_scheduler();
        return;
    }
    let app = app.clone();
    tokio::spawn(async move {
        scheduler_loop(app).await;
    });
}

async fn scheduler_loop(app: AppState) {
    // Run ids with a live executor task. Kept in shared state so executors
    // deregister themselves when the provider turn settles.
    let in_flight: Arc<StdMutex<HashSet<String>>> = Arc::new(StdMutex::new(HashSet::new()));
    loop {
        if app.is_shutting_down() {
            return;
        }
        if let Err(error) = dispatch_due(&app, &in_flight).await {
            tracing::warn!(%error, "failed to dispatch due automations");
        }
        spawn_queued_runs(&app, &in_flight).await;
        let next_due = app.control().next_due_at().await;
        let wait = next_due
            .and_then(|next| (next - Utc::now()).to_std().ok())
            .map_or(SCHEDULER_IDLE_POLL, |duration| {
                duration.min(SCHEDULER_IDLE_POLL)
            });
        tokio::select! {
            () = app.control().scheduler_notified() => {}
            () = sleep(wait) => {}
        }
    }
}

/// Enqueues every due occurrence. The control service applies the
/// concurrency policy, consumes the occurrence and advances the schedule.
async fn dispatch_due(
    app: &AppState,
    in_flight: &Arc<StdMutex<HashSet<String>>>,
) -> Result<(), String> {
    let now = Utc::now();
    for (automation_id, due_at) in app.control().due_automations(now).await {
        let run = app
            .control()
            .enqueue_run(&automation_id, Some(due_at), RunSource::Scheduled)
            .await
            .map_err(|error| error.0.message)?;
        if run.status == AutomationRunStatus::Queued {
            in_flight
                .lock()
                .expect("control scheduler lock")
                .insert(run.id.clone());
            dispatch_claimed(app, &run.id, in_flight).await;
        }
        emit_runs_changed(app).await;
    }
    Ok(())
}

/// Dispatches one queued run unless its automation already has a running
/// occurrence, which is the queue_one concurrency policy. Returns whether an
/// executor was spawned.
pub async fn try_execute_queued(app: &AppState, run_id: &str) -> bool {
    // The atomic claim covers both gates at once: only queued runs are
    // taken, and a run whose automation already has an active occurrence
    // (queue_one) stays queued.
    if !app.control().claim_run_if_automation_free(run_id).await {
        return false;
    }
    let app = app.clone();
    let run_id = run_id.to_string();
    tokio::spawn(async move {
        execute_run(&app, &run_id).await;
    });
    true
}

/// Claims a queued run and dispatches it. The in-flight registration only
/// prevents double spawns within one wake: whether the run was claimed
/// (no longer queued) or declined (still queued, retried next wake), the
/// id is released so later wakes can act on it again.
async fn dispatch_claimed(
    app: &AppState,
    run_id: &str,
    in_flight: &Arc<StdMutex<HashSet<String>>>,
) {
    let _ = try_execute_queued(app, run_id).await;
    in_flight
        .lock()
        .expect("control scheduler lock")
        .remove(run_id);
}

/// Spawns executors for queued runs that do not have one yet (manual
/// `run_now` and `queue_one` backlog).
async fn spawn_queued_runs(app: &AppState, in_flight: &Arc<StdMutex<HashSet<String>>>) {
    let queued = app.control().queued_runs().await;
    let spawnable = {
        let mut guard = in_flight.lock().expect("control scheduler lock");
        queued
            .into_iter()
            .filter(|run_id| guard.insert(run_id.clone()))
            .collect::<Vec<_>>()
    };
    for run_id in spawnable {
        dispatch_claimed(app, &run_id, in_flight).await;
    }
}

async fn emit_runs_changed(app: &AppState) {
    let revision = app.control().store_revision().await;
    app.emit_control_state_change(ControlStateChanged {
        store_revision: revision,
        domains: vec![ControlDomain::Runs, ControlDomain::Automations],
    });
}

/// Statuses reported by providers that mean the turn stopped on request.
fn is_interrupt_turn_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "canceled" | "cancelled" | "interrupted" | "aborted"
    )
}

fn is_failed_turn_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "failed" | "failure" | "error" | "errored"
    )
}

#[allow(clippy::too_many_lines)]
async fn execute_run(app: &AppState, run_id: &str) {
    // The permit is held for the lifetime of the dispatch, bounding daemon
    // wide concurrent automation runs.
    let _permit = match app.control().run_slots().acquire().await {
        Ok(permit) => permit,
        Err(_) => return,
    };
    let Some(run) = app.control().run(run_id).await else {
        return;
    };
    // The dispatcher claims the run (Queued -> Running) before spawning
    // this task, so anything else here is a settled run.
    if run.status != AutomationRunStatus::Running {
        return;
    }
    if app.is_shutting_down() {
        let _ = app
            .control()
            .finish_run(
                run_id,
                AutomationRunStatus::Cancelled,
                Some("Daemon stopped before the run completed".to_string()),
                None,
            )
            .await;
        emit_runs_changed(app).await;
        return;
    }
    let Some(automation) = app.control().automation(&run.automation_id).await else {
        let _ = app
            .control()
            .fail_run(run_id, "automation definition was deleted before dispatch")
            .await;
        emit_runs_changed(app).await;
        return;
    };

    // Required connectors are re-checked at execution time.
    for connector in &automation.required_connectors {
        let available = crate::connectors::load_mcp_servers(
            &automation.target.workspace_path,
            automation.target.provider.as_str(),
        );
        let known = available.iter().any(|server| server.name == *connector)
            || connector == crate::connectors::BUILTIN_CONNECTOR_NAME;
        if !known {
            let _ = app.control().skip_run_dependency(run_id, connector).await;
            emit_runs_changed(app).await;
            return;
        }
    }

    // Workspace resolution: canonical path first, then the connect flow.
    let workspace = match app
        .resolve_or_connect_workspace_path(&automation.target.workspace_path)
        .await
    {
        Ok(workspace) => workspace,
        Err(error) => {
            let _ = app
                .control()
                .fail_run(
                    run_id,
                    &format!(
                        "workspace {} is unavailable: {error}",
                        automation.target.workspace_path
                    ),
                )
                .await;
            emit_runs_changed(app).await;
            return;
        }
    };

    // Thread resolution per the automation's thread strategy.
    let thread_id = match resolve_thread(app, &automation, &workspace.id).await {
        Ok(thread_id) => thread_id,
        Err(error) => {
            let _ = app.control().fail_run(run_id, &error).await;
            emit_runs_changed(app).await;
            return;
        }
    };

    if let Err(error) = app
        .control()
        .mark_run_running(run_id, &workspace.id, &thread_id)
        .await
    {
        tracing::warn!(error = %error.0.message, run_id, "automation run was cancelled during thread resolution");
        return;
    }
    emit_runs_changed(app).await;

    // Subscribe before dispatch: turn events emitted between subscribe and
    // send_turn must be observed.
    let mut events = app.subscribe();
    let expects_turn_end = automation.target.provider == falcondeck_core::AgentProvider::CODEX;
    let dispatch_started_at = Utc::now();
    let instruction = automation.task.instruction().to_string();
    let response = app
        .send_turn(falcondeck_core::SendTurnRequest {
            workspace_id: workspace.id.clone(),
            thread_id: thread_id.clone(),
            inputs: vec![TurnInputItem::Text {
                id: None,
                text: instruction,
            }],
            selected_skills: automation
                .target
                .selected_skills
                .iter()
                .map(|skill_id| falcondeck_core::SelectedSkillReference {
                    skill_id: skill_id.clone(),
                    alias: format!("/{skill_id}"),
                })
                .collect(),
            provider: Some(automation.target.provider.clone()),
            model_id: automation.target.model_id.clone(),
            reasoning_effort: automation.target.reasoning_effort.clone(),
            approval_policy: automation.target.approval_policy.clone(),
            service_tier: None,
            permission_mode: automation.target.permission_mode.clone(),
            sandbox_mode: automation.target.sandbox_mode.clone(),
            steer: false,
            user_item_id: None,
            resume_interrupted: false,
        })
        .await;
    if let Err(error) = response {
        let _ = app
            .control()
            .fail_run(run_id, &format!("failed to dispatch turn: {error}"))
            .await;
        emit_runs_changed(app).await;
        return;
    }

    let mut dispatched_turn_id: Option<String> = None;
    let mut terminal_poll = interval(RUN_TERMINAL_POLL);
    terminal_poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // `interval` ticks immediately once; consume that tick so the fallback is
    // genuinely periodic and provider events stay the fast path.
    terminal_poll.tick().await;
    loop {
        let event = tokio::select! {
            event = events.recv() => Some(event),
            _ = terminal_poll.tick() => None,
        };
        let Some(event) = event else {
            if let Some((status, preview)) =
                terminal_state_from_thread(app, &workspace.id, &thread_id, dispatch_started_at)
                    .await
            {
                finish_with_classification(app, run_id, &automation.id, status, preview, None)
                    .await;
                emit_runs_changed(app).await;
                return;
            }
            continue;
        };
        match event {
            Ok(envelope)
                if envelope.workspace_id.as_deref() == Some(workspace.id.as_str())
                    && envelope.thread_id.as_deref() == Some(thread_id.as_str()) =>
            {
                match envelope.event.clone() {
                    UnifiedEvent::TurnStart { turn_id } => {
                        // The first turn start after dispatch is the
                        // automation's own turn: turns are serialized per
                        // thread, and later turns queue behind it.
                        if dispatched_turn_id.is_none() {
                            dispatched_turn_id = Some(turn_id.clone());
                            let _ = app.control().record_run_turn(run_id, &turn_id).await;
                        }
                    }
                    UnifiedEvent::TurnEnd {
                        turn_id,
                        status,
                        error,
                    } => {
                        // A turn that started before this dispatch (a user
                        // turn already in flight) must not settle the run.
                        if Some(turn_id.as_str()) != dispatched_turn_id.as_deref() {
                            continue;
                        }
                        let shutting_down = app.is_shutting_down();
                        let succeeded = !shutting_down
                            && error.is_none()
                            && !is_failed_turn_status(&status)
                            && !is_interrupt_turn_status(&status);
                        let final_status = if shutting_down {
                            AutomationRunStatus::Cancelled
                        } else if succeeded {
                            AutomationRunStatus::Succeeded
                        } else if is_interrupt_turn_status(&status) {
                            AutomationRunStatus::Cancelled
                        } else {
                            AutomationRunStatus::Failed
                        };
                        let preview = if shutting_down {
                            Some("Daemon stopped before the run completed".to_string())
                        } else if succeeded {
                            final_assistant_text(app, &workspace.id, &thread_id).await
                        } else {
                            error.clone()
                        };
                        finish_with_classification(
                            app,
                            run_id,
                            &automation.id,
                            final_status,
                            preview,
                            error,
                        )
                        .await;
                        emit_runs_changed(app).await;
                        return;
                    }
                    UnifiedEvent::ThreadUpdated { thread } => {
                        // Codex normally supplies the richer TurnEnd event,
                        // but a runtime crash can only produce an Error
                        // thread update. Settle that failure immediately. An
                        // Idle thread is only trusted once the automation's
                        // own turn has started: on a shared thread, a user
                        // turn finishing first would otherwise settle the
                        // run with the wrong outcome.
                        let terminal = ((!expects_turn_end && dispatched_turn_id.is_some())
                            || thread.status == ThreadStatus::Error)
                            .then(|| {
                                (thread.updated_at >= dispatch_started_at)
                                    .then(|| terminal_state_from_summary(&thread))
                                    .flatten()
                            })
                            .flatten();
                        if let Some((status, preview)) = terminal {
                            finish_with_classification(
                                app,
                                run_id,
                                &automation.id,
                                status,
                                preview,
                                None,
                            )
                            .await;
                            emit_runs_changed(app).await;
                            return;
                        }
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                tracing::warn!(
                    run_id,
                    skipped,
                    "automation executor lagged behind the daemon event stream"
                );
                if let Some((status, preview)) =
                    terminal_state_from_thread(app, &workspace.id, &thread_id, dispatch_started_at)
                        .await
                {
                    finish_with_classification(app, run_id, &automation.id, status, preview, None)
                        .await;
                    emit_runs_changed(app).await;
                    return;
                }
            }
            Err(broadcast::error::RecvError::Closed) => {
                let _ = app
                    .control()
                    .finish_run(
                        run_id,
                        AutomationRunStatus::Cancelled,
                        Some("Daemon event stream closed".to_string()),
                        None,
                    )
                    .await;
                emit_runs_changed(app).await;
                return;
            }
        }
    }
}

/// Applies the conditional no-action classification before persisting the
/// terminal state.
async fn finish_with_classification(
    app: &AppState,
    run_id: &str,
    automation_id: &str,
    status: AutomationRunStatus,
    preview: Option<String>,
    error: Option<String>,
) {
    let status = match app.control().automation(automation_id).await {
        Some(automation) if status == AutomationRunStatus::Succeeded => {
            super::automations::classify_conditional_outcome(&automation.task, preview.as_deref())
        }
        _ => status,
    };
    let error_detail =
        error.map(|message| super::service::ControlError::execution_failed(message).0);
    let _ = app
        .control()
        .finish_run(run_id, status, preview, error_detail)
        .await;
}

/// The final assistant message text, used for previews and the no-action
/// marker comparison.
async fn final_assistant_text(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
) -> Option<String> {
    let detail = app
        .thread_detail_with_request(&ThreadDetailRequest {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            mode: ThreadDetailMode::Full,
            limit: None,
            before_item_id: None,
        })
        .await
        .ok()?;
    detail.items.iter().rev().find_map(|item| match item {
        falcondeck_core::ConversationItem::AssistantMessage { text, .. } => {
            (!text.trim().is_empty()).then(|| text.clone())
        }
        _ => None,
    })
}

fn terminal_state_from_summary(
    thread: &falcondeck_core::ThreadSummary,
) -> Option<(AutomationRunStatus, Option<String>)> {
    match thread.status {
        ThreadStatus::Error => Some((
            AutomationRunStatus::Failed,
            thread
                .last_message_preview
                .clone()
                .or_else(|| Some("thread ended in error".to_string())),
        )),
        ThreadStatus::Idle => Some((
            AutomationRunStatus::Succeeded,
            thread.last_message_preview.clone(),
        )),
        _ => None,
    }
}

async fn terminal_state_from_thread(
    app: &AppState,
    workspace_id: &str,
    thread_id: &str,
    dispatch_started_at: DateTime<Utc>,
) -> Option<(AutomationRunStatus, Option<String>)> {
    let thread = app.thread_summary(workspace_id, thread_id).await.ok()?;
    (thread.updated_at >= dispatch_started_at)
        .then(|| terminal_state_from_summary(&thread))
        .flatten()
}

/// Resolves the native thread for one automation run. On success returns
/// the thread id; on failure, a message recorded on the run.
async fn resolve_thread(
    app: &AppState,
    automation: &falcondeck_core::control::Automation,
    workspace_id: &str,
) -> Result<String, String> {
    match &automation.target.thread {
        AutomationThreadTarget::Existing { thread_id } => {
            match app.thread_summary(workspace_id, thread_id).await {
                Ok(thread) if thread.provider == automation.target.provider => {
                    Ok(thread_id.clone())
                }
                Ok(thread) => Err(format!(
                    "thread {thread_id} is bound to {}, not {}",
                    thread.provider.as_str(),
                    automation.target.provider.as_str()
                )),
                Err(_) => Err(format!(
                    "thread {thread_id} does not exist in the target workspace"
                )),
            }
        }
        AutomationThreadTarget::NewEachRun => {
            start_automation_thread(app, automation, workspace_id).await
        }
        AutomationThreadTarget::Managed { thread_id } => {
            if let Some(thread_id) = thread_id
                && let Ok(thread) = app.thread_summary(workspace_id, thread_id).await
                && thread.provider == automation.target.provider
            {
                return Ok(thread_id.clone());
            }
            // Managed threads are created once and remembered; the stored id
            // persists back into the definition with a revision bump. A
            // provider change leaves the old id behind, so we open a new
            // thread rather than send the new provider into the old one.
            let created = start_automation_thread(app, automation, workspace_id).await?;
            let _ = app
                .control()
                .set_managed_thread(&automation.id, &created)
                .await;
            Ok(created)
        }
    }
}

async fn start_automation_thread(
    app: &AppState,
    automation: &falcondeck_core::control::Automation,
    workspace_id: &str,
) -> Result<String, String> {
    let started = app
        .start_thread(falcondeck_core::StartThreadRequest {
            workspace_id: workspace_id.to_string(),
            provider: Some(automation.target.provider.clone()),
            model_id: automation.target.model_id.clone(),
            collaboration_mode_id: automation.target.collaboration_mode_id.clone(),
            approval_policy: automation.target.approval_policy.clone(),
            sandbox_mode: automation.target.sandbox_mode.clone(),
            permission_mode: automation.target.permission_mode.clone(),
            isolation: automation
                .target
                .isolation
                .clone()
                .unwrap_or(falcondeck_core::ThreadIsolation::ProjectFolder),
            handoff_from: None,
        })
        .await;
    let handle = match started {
        Ok(handle) => handle,
        Err(error) => {
            return Err(format!("failed to create thread: {error}"));
        }
    };

    let thread_id = handle.thread.id.clone();
    // Provenance: the thread's origin shows which automation created it.
    let origin = ThreadOrigin::Automation {
        automation_id: automation.id.clone(),
        name: automation.name.clone(),
    };
    let _ = app
        .with_thread_mut(workspace_id, &thread_id, |thread| {
            thread.origin = Some(origin)
        })
        .await;
    if let Ok(thread) = app.thread_summary(workspace_id, &thread_id).await {
        app.emit_event(
            Some(workspace_id.to_string()),
            Some(thread_id.clone()),
            UnifiedEvent::ThreadUpdated { thread },
        );
    }
    Ok(thread_id)
}

/// A read context for scheduler-originated internal operations.
#[allow(dead_code)]
fn scheduler_context() -> ControlRequestContext {
    ControlRequestContext {
        origin: ControlOrigin::Scheduler,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupt_and_failure_statuses_are_classified() {
        assert!(is_interrupt_turn_status("Cancelled"));
        assert!(is_interrupt_turn_status("interrupted"));
        assert!(is_failed_turn_status("failed"));
        assert!(is_failed_turn_status("ERROR"));
        assert!(!is_failed_turn_status("completed"));
    }
}
