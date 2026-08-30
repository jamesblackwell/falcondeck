//! Durable bounded execution broker for extension-owned orchestration runs.
//!
//! This module deliberately knows nothing about Mission acceptance criteria or
//! planning. It persists an opaque owner checkpoint, enforces the v1 lease,
//! journals provider intents before dispatch, and drives at most one automatic
//! turn at a time in an existing coordinator task.

use std::{collections::HashMap, path::Path, time::Duration as StdDuration};

use chrono::{Duration, Utc};
use falcondeck_core::{
    AgentProvider, SendTurnRequest, ThreadStatus, TurnInputItem,
    orchestration::{
        DEFAULT_LEASE_MINUTES, ExtensionOperationStatus, ExtensionOrchestrationEffect,
        ExtensionPendingContinuation, ExtensionRunCommand, ExtensionRunGate, ExtensionRunOperation,
        ExtensionRunOutcome, ExtensionRunSummary, MAX_AUTOMATIC_TURNS, MAX_CHECKPOINT_BYTES,
        MAX_LEASE_MINUTES, MAX_OPERATION_PROMPT_BYTES,
    },
};
use serde::{Deserialize, Serialize};

use super::{AppState, extension_host::ExtensionEvent, storage::write_atomically, workspace_ops};
use crate::error::DaemonError;

const STORE_VERSION: u32 = 1;
const MAX_STORE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RUNS: usize = 256;
const MAX_OPERATIONS_PER_RUN: usize = 32;
const MAX_TITLE_CHARS: usize = 120;
const MAX_OBJECTIVE_CHARS: usize = 12_000;
const MAX_FINGERPRINT_CHARS: usize = 256;
const DRIVER_POLL: StdDuration = StdDuration::from_millis(500);
const MISSIONS_EXTENSION_ID: &str = "falcondeck.missions";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct OrchestrationRegistry {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    runs: HashMap<String, ExtensionRunSummary>,
}

fn store_version() -> u32 {
    STORE_VERSION
}

impl Default for OrchestrationRegistry {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            runs: HashMap::new(),
        }
    }
}

/// Trust class attached by the daemon call path, never by extension input.
pub(super) enum EffectActor<'a> {
    /// A host-rendered extension action selected by a human.
    Human,
    /// An extension tool call bound to a provider task by the bridge.
    AgentTool {
        workspace_id: Option<&'a str>,
        thread_id: Option<&'a str>,
    },
}

pub(super) fn orchestration_path(state_path: &Path) -> std::path::PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("extension-runs.json")
}

pub(super) async fn restore(app: &AppState) -> Result<(), DaemonError> {
    let registry = load_registry(&app.inner.orchestration_path).await?;
    let deadline_guards = registry
        .runs
        .values()
        .filter(|run| run.gate != ExtensionRunGate::Closed)
        .map(|run| (run.id.clone(), run.deadline_at))
        .collect::<Vec<_>>();
    *app.inner.orchestration_runs.lock().await = registry;
    persist(app).await?;
    for (run_id, deadline_at) in deadline_guards {
        spawn_deadline_guard(app, run_id, deadline_at);
    }
    Ok(())
}

async fn load_registry(path: &Path) -> Result<OrchestrationRegistry, DaemonError> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.len() > MAX_STORE_BYTES => {
            return Err(DaemonError::BadRequest(format!(
                "orchestration store exceeds the {MAX_STORE_BYTES}-byte limit"
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OrchestrationRegistry::default());
        }
        Err(error) => return Err(error.into()),
    }
    let mut registry: OrchestrationRegistry =
        serde_json::from_slice(&tokio::fs::read(path).await?)?;
    if registry.version > STORE_VERSION {
        return Err(DaemonError::BadRequest(format!(
            "orchestration store version {} is newer than supported version {STORE_VERSION}",
            registry.version
        )));
    }
    if registry.runs.len() > MAX_RUNS {
        return Err(DaemonError::BadRequest(format!(
            "orchestration store exceeds the {MAX_RUNS}-run limit"
        )));
    }
    let now = Utc::now();
    for run in registry.runs.values_mut() {
        validate_run(run)?;
        let mut ambiguous = false;
        for operation in &mut run.operations {
            if matches!(
                operation.status,
                ExtensionOperationStatus::Dispatching | ExtensionOperationStatus::Acknowledged
            ) {
                operation.status = ExtensionOperationStatus::OutcomeUnknown;
                operation.updated_at = now;
                operation.message = Some(
                    "Daemon restarted before provider acceptance could be reconciled".to_string(),
                );
                ambiguous = true;
            } else if operation.status == ExtensionOperationStatus::Queued {
                operation.status = ExtensionOperationStatus::Cancelled;
                operation.updated_at = now;
                operation.message =
                    Some("Queued continuation cancelled during restart reconciliation".to_string());
            }
        }
        if ambiguous {
            run.gate = ExtensionRunGate::Paused;
            run.pause_reason = Some("Provider outcome is unknown after daemon restart".to_string());
        }
        run.pending_continuation = None;
        run.updated_at = now;
        expire_if_needed(run, now);
    }
    Ok(registry)
}

fn validate_run(run: &ExtensionRunSummary) -> Result<(), DaemonError> {
    validate_text("run id", &run.id, 128)?;
    validate_text("owner extension id", &run.owner_extension_id, 128)?;
    validate_text("workspace id", &run.workspace_id, 512)?;
    validate_text("coordinator thread id", &run.coordinator_thread_id, 512)?;
    validate_text("title", &run.title, MAX_TITLE_CHARS)?;
    validate_text("objective", &run.objective, MAX_OBJECTIVE_CHARS)?;
    validate_checkpoint(&run.checkpoint)?;
    if run.operations.len() > MAX_OPERATIONS_PER_RUN {
        return Err(DaemonError::BadRequest(format!(
            "run operation journal exceeds {MAX_OPERATIONS_PER_RUN} entries"
        )));
    }
    for operation in &run.operations {
        validate_text("operation id", &operation.id, 128)?;
        validate_prompt(&operation.prompt)?;
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, max_chars: usize) -> Result<(), DaemonError> {
    if value.trim().is_empty() || value.chars().count() > max_chars {
        return Err(DaemonError::BadRequest(format!(
            "{label} must contain 1-{max_chars} characters"
        )));
    }
    Ok(())
}

fn validate_prompt(prompt: &str) -> Result<(), DaemonError> {
    if prompt.trim().is_empty() || prompt.len() > MAX_OPERATION_PROMPT_BYTES {
        return Err(DaemonError::BadRequest(format!(
            "automatic turn prompt must contain 1-{MAX_OPERATION_PROMPT_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_checkpoint(checkpoint: &serde_json::Value) -> Result<(), DaemonError> {
    if serde_json::to_vec(checkpoint)?.len() > MAX_CHECKPOINT_BYTES {
        return Err(DaemonError::BadRequest(format!(
            "orchestration checkpoint exceeds {MAX_CHECKPOINT_BYTES} bytes"
        )));
    }
    Ok(())
}

async fn persist(app: &AppState) -> Result<(), DaemonError> {
    let _persistence = app.inner.persistence.lock().await;
    let payload = serde_json::to_vec_pretty(&*app.inner.orchestration_runs.lock().await)?;
    if payload.len() as u64 > MAX_STORE_BYTES {
        return Err(DaemonError::BadRequest(format!(
            "orchestration store exceeds the {MAX_STORE_BYTES}-byte limit"
        )));
    }
    write_atomically(&app.inner.orchestration_path, payload).await
}

/// Owner-only projection supplied to the public extension facet.
pub(super) async fn owned_runs(app: &AppState, extension_id: &str) -> Vec<ExtensionRunSummary> {
    let mut runs = app
        .inner
        .orchestration_runs
        .lock()
        .await
        .runs
        .values()
        .filter(|run| run.owner_extension_id == extension_id)
        .cloned()
        .collect::<Vec<_>>();
    runs.sort_by_key(|run| std::cmp::Reverse(run.updated_at));
    runs
}

/// Applies one short extension reduction, then starts any durable work outside
/// the extension-host callback. Effects are serialized and persisted together.
pub(super) async fn apply_effects(
    app: &AppState,
    extension_id: &str,
    effects: Vec<ExtensionOrchestrationEffect>,
    actor: EffectActor<'_>,
) -> Result<Vec<ExtensionRunSummary>, DaemonError> {
    if effects.len() > 1 {
        return Err(DaemonError::BadRequest(
            "an extension callback may return at most one orchestration effect".to_string(),
        ));
    }
    if effects.is_empty() {
        return Ok(owned_runs(app, extension_id).await);
    }

    let effect = effects.into_iter().next().expect("one effect");
    validate_effect_actor(&effect, &actor)?;
    if extension_id != MISSIONS_EXTENSION_ID {
        return Err(DaemonError::BadRequest(
            "orchestration grants are currently limited to the bundled Missions extension"
                .to_string(),
        ));
    }

    // Resolve and validate a newly adopted task before taking the mutation
    // lock. Existing-run mutations are checked against the authenticated tool
    // task again inside the registry transition.
    if let ExtensionOrchestrationEffect::CreateRun {
        workspace_id,
        coordinator_thread_id,
        ..
    } = &effect
    {
        let thread = app
            .thread_summary(workspace_id, coordinator_thread_id)
            .await?;
        if thread.provider != AgentProvider::CLAUDE {
            return Err(DaemonError::BadRequest(
                "Missions v1 requires a Claude task with an authenticated per-turn tool bridge; Codex and OpenCode remain ineligible until their workspace-wide bridge can bind an exact task"
                    .to_string(),
            ));
        }
        if thread.status != ThreadStatus::Idle {
            return Err(DaemonError::BadRequest(
                "Missions v1 can adopt only an idle coordinator task".to_string(),
            ));
        }
        if thread.is_archived {
            return Err(DaemonError::BadRequest(
                "an archived task cannot coordinate a Mission".to_string(),
            ));
        }
    }

    let _mutation = app.inner.orchestration_mutation.lock().await;
    let previous = app.inner.orchestration_runs.lock().await.clone();
    let changed_run_id = {
        let mut registry = app.inner.orchestration_runs.lock().await;
        apply_effect(&mut registry, extension_id, effect, &actor)?
    };
    if let Err(error) = persist(app).await {
        *app.inner.orchestration_runs.lock().await = previous;
        return Err(error);
    }
    drop(_mutation);
    if let Some(run) = app
        .inner
        .orchestration_runs
        .lock()
        .await
        .runs
        .get(&changed_run_id)
        .cloned()
    {
        enqueue_run_updated(app, &run);
        if run.gate != ExtensionRunGate::Closed {
            spawn_deadline_guard(app, run.id.clone(), run.deadline_at);
        }
    }
    spawn_driver(app, changed_run_id);
    Ok(owned_runs(app, extension_id).await)
}

fn validate_effect_actor(
    effect: &ExtensionOrchestrationEffect,
    actor: &EffectActor<'_>,
) -> Result<(), DaemonError> {
    let human_effect = matches!(
        effect,
        ExtensionOrchestrationEffect::CreateRun { .. }
            | ExtensionOrchestrationEffect::HumanCommand { .. }
    );
    match (human_effect, actor) {
        (true, EffectActor::Human) | (false, EffectActor::AgentTool { .. }) => Ok(()),
        (true, _) => Err(DaemonError::BadRequest(
            "creating or controlling a run requires a human extension action".to_string(),
        )),
        (false, _) => Err(DaemonError::BadRequest(
            "checkpoint and completion effects require a coordinator tool call".to_string(),
        )),
    }
}

fn apply_effect(
    registry: &mut OrchestrationRegistry,
    extension_id: &str,
    effect: ExtensionOrchestrationEffect,
    actor: &EffectActor<'_>,
) -> Result<String, DaemonError> {
    let now = Utc::now();
    match effect {
        ExtensionOrchestrationEffect::CreateRun {
            run_id,
            workspace_id,
            coordinator_thread_id,
            title,
            objective,
            checkpoint,
            initial_prompt,
        } => {
            if registry.runs.len() >= MAX_RUNS {
                return Err(DaemonError::BadRequest(format!(
                    "orchestration run limit of {MAX_RUNS} reached"
                )));
            }
            if registry.runs.contains_key(&run_id) {
                return Err(DaemonError::BadRequest(
                    "orchestration run id already exists".to_string(),
                ));
            }
            if registry.runs.values().any(|run| {
                run.gate != ExtensionRunGate::Closed
                    && run.workspace_id == workspace_id
                    && run.coordinator_thread_id == coordinator_thread_id
            }) {
                return Err(DaemonError::BadRequest(
                    "that task already coordinates an open run".to_string(),
                ));
            }
            validate_text("run id", &run_id, 128)?;
            validate_text("title", &title, MAX_TITLE_CHARS)?;
            validate_text("objective", &objective, MAX_OBJECTIVE_CHARS)?;
            validate_checkpoint(&checkpoint)?;
            let mut operations = Vec::new();
            let gate = if let Some(prompt) = initial_prompt {
                validate_prompt(&prompt)?;
                operations.push(new_operation(format!("{run_id}-turn-1"), prompt, now));
                ExtensionRunGate::Open
            } else {
                ExtensionRunGate::Paused
            };
            registry.runs.insert(
                run_id.clone(),
                ExtensionRunSummary {
                    id: run_id.clone(),
                    owner_extension_id: extension_id.to_string(),
                    workspace_id,
                    coordinator_thread_id,
                    title,
                    objective,
                    gate,
                    outcome: None,
                    pause_reason: (gate == ExtensionRunGate::Paused)
                        .then(|| "Waiting for a human to start".to_string()),
                    checkpoint,
                    policy_revision: 1,
                    journal_sequence: u64::from(!operations.is_empty()),
                    approval_generation: 1,
                    automatic_turns_started: 0,
                    max_automatic_turns: MAX_AUTOMATIC_TURNS,
                    created_at: now,
                    updated_at: now,
                    deadline_at: now + Duration::minutes(DEFAULT_LEASE_MINUTES),
                    last_progress_fingerprint: None,
                    pending_continuation: None,
                    completion_proposed: false,
                    operations,
                },
            );
            Ok(run_id)
        }
        ExtensionOrchestrationEffect::UpdateCheckpoint {
            run_id,
            expected_policy_revision,
            checkpoint,
        } => {
            let run = owned_run_mut(registry, extension_id, &run_id)?;
            authorize_tool_run(run, actor)?;
            expect_revision(run, expected_policy_revision)?;
            validate_checkpoint(&checkpoint)?;
            run.checkpoint = checkpoint;
            bump_policy(run, now);
            Ok(run_id)
        }
        ExtensionOrchestrationEffect::RequestContinuation {
            run_id,
            expected_policy_revision,
            operation_id,
            checkpoint,
            progress_fingerprint,
            prompt,
        } => {
            let run = owned_run_mut(registry, extension_id, &run_id)?;
            authorize_tool_run(run, actor)?;
            expect_open_revision(run, expected_policy_revision, now)?;
            if run.pending_continuation.is_some() {
                return Err(DaemonError::BadRequest(
                    "a continuation is already pending for this run".to_string(),
                ));
            }
            if run
                .operations
                .iter()
                .any(|operation| operation.id == operation_id)
            {
                return Err(DaemonError::BadRequest(
                    "operation id already exists in this run".to_string(),
                ));
            }
            validate_text("operation id", &operation_id, 128)?;
            validate_text(
                "progress fingerprint",
                &progress_fingerprint,
                MAX_FINGERPRINT_CHARS,
            )?;
            validate_prompt(&prompt)?;
            validate_checkpoint(&checkpoint)?;
            run.checkpoint = checkpoint;
            run.pending_continuation = Some(ExtensionPendingContinuation {
                operation_id,
                prompt,
                progress_fingerprint,
                requested_at: now,
            });
            bump_policy(run, now);
            Ok(run_id)
        }
        ExtensionOrchestrationEffect::ProposeCompletion {
            run_id,
            expected_policy_revision,
            checkpoint,
        } => {
            let run = owned_run_mut(registry, extension_id, &run_id)?;
            authorize_tool_run(run, actor)?;
            expect_open_revision(run, expected_policy_revision, now)?;
            validate_checkpoint(&checkpoint)?;
            run.checkpoint = checkpoint;
            run.completion_proposed = true;
            run.pending_continuation = None;
            bump_policy(run, now);
            Ok(run_id)
        }
        ExtensionOrchestrationEffect::PauseForHuman {
            run_id,
            expected_policy_revision,
            checkpoint,
            reason,
        } => {
            let run = owned_run_mut(registry, extension_id, &run_id)?;
            authorize_tool_run(run, actor)?;
            expect_open_revision(run, expected_policy_revision, now)?;
            validate_checkpoint(&checkpoint)?;
            validate_text("pause reason", &reason, 500)?;
            run.checkpoint = checkpoint;
            run.pending_continuation = None;
            run.gate = ExtensionRunGate::Paused;
            run.pause_reason = Some(reason);
            bump_policy(run, now);
            Ok(run_id)
        }
        ExtensionOrchestrationEffect::HumanCommand {
            run_id,
            expected_policy_revision,
            command,
            resume_prompt,
            operation_id,
        } => {
            let run = owned_run_mut(registry, extension_id, &run_id)?;
            expect_revision(run, expected_policy_revision)?;
            apply_human_command(run, command, resume_prompt, operation_id, now)?;
            Ok(run_id)
        }
    }
}

fn owned_run_mut<'a>(
    registry: &'a mut OrchestrationRegistry,
    extension_id: &str,
    run_id: &str,
) -> Result<&'a mut ExtensionRunSummary, DaemonError> {
    let run = registry
        .runs
        .get_mut(run_id)
        .ok_or_else(|| DaemonError::NotFound("orchestration run not found".to_string()))?;
    if run.owner_extension_id != extension_id {
        return Err(DaemonError::NotFound(
            "orchestration run not owned by this extension".to_string(),
        ));
    }
    Ok(run)
}

fn authorize_tool_run(
    run: &ExtensionRunSummary,
    actor: &EffectActor<'_>,
) -> Result<(), DaemonError> {
    match actor {
        EffectActor::AgentTool {
            workspace_id: Some(workspace_id),
            thread_id: Some(thread_id),
        } if *workspace_id == run.workspace_id && *thread_id == run.coordinator_thread_id => Ok(()),
        _ => Err(DaemonError::BadRequest(
            "this tool call is not bound to the run's coordinator task".to_string(),
        )),
    }
}

fn expect_revision(run: &ExtensionRunSummary, expected: u64) -> Result<(), DaemonError> {
    if run.policy_revision != expected {
        return Err(DaemonError::BadRequest(format!(
            "orchestration revision conflict: expected {expected}, current {}",
            run.policy_revision
        )));
    }
    Ok(())
}

fn expect_open_revision(
    run: &mut ExtensionRunSummary,
    expected: u64,
    now: chrono::DateTime<Utc>,
) -> Result<(), DaemonError> {
    expect_revision(run, expected)?;
    expire_if_needed(run, now);
    if run.gate != ExtensionRunGate::Open {
        return Err(DaemonError::BadRequest(
            "orchestration run is not open for automatic work".to_string(),
        ));
    }
    Ok(())
}

fn bump_policy(run: &mut ExtensionRunSummary, now: chrono::DateTime<Utc>) {
    run.policy_revision = run.policy_revision.saturating_add(1);
    run.updated_at = now;
}

fn apply_human_command(
    run: &mut ExtensionRunSummary,
    command: ExtensionRunCommand,
    resume_prompt: Option<String>,
    operation_id: Option<String>,
    now: chrono::DateTime<Utc>,
) -> Result<(), DaemonError> {
    match command {
        ExtensionRunCommand::Pause => {
            if run.gate == ExtensionRunGate::Closed {
                return Err(DaemonError::BadRequest("run is already closed".to_string()));
            }
            cancel_queued(run, "Cancelled by human pause", now);
            run.pending_continuation = None;
            run.gate = ExtensionRunGate::Paused;
            run.pause_reason = Some("Paused by human".to_string());
        }
        ExtensionRunCommand::Resume => {
            if run.gate != ExtensionRunGate::Paused {
                return Err(DaemonError::BadRequest(
                    "only a paused run can be resumed".to_string(),
                ));
            }
            if run
                .operations
                .iter()
                .any(|operation| operation.status == ExtensionOperationStatus::OutcomeUnknown)
            {
                return Err(DaemonError::BadRequest(
                    "an unknown provider outcome must be reconciled before resume".to_string(),
                ));
            }
            if now >= run.deadline_at {
                return Err(DaemonError::BadRequest(
                    "the mission deadline has elapsed; extend it before resuming".to_string(),
                ));
            }
            run.gate = ExtensionRunGate::Open;
            run.pause_reason = None;
            run.approval_generation = run.approval_generation.saturating_add(1);
            if let Some(prompt) = resume_prompt {
                let operation_id = operation_id.ok_or_else(|| {
                    DaemonError::BadRequest("resume_prompt requires operation_id".to_string())
                })?;
                queue_operation(run, operation_id, prompt, now)?;
            } else if operation_id.is_some() {
                return Err(DaemonError::BadRequest(
                    "operation_id requires resume_prompt".to_string(),
                ));
            }
        }
        ExtensionRunCommand::Extend => {
            if run.gate == ExtensionRunGate::Closed {
                return Err(DaemonError::BadRequest("run is already closed".to_string()));
            }
            let maximum = run.created_at + Duration::minutes(MAX_LEASE_MINUTES);
            let extended = run.deadline_at + Duration::minutes(DEFAULT_LEASE_MINUTES);
            run.deadline_at = extended.min(maximum);
            if run.deadline_at <= now {
                return Err(DaemonError::BadRequest(
                    "the maximum mission lease has already elapsed".to_string(),
                ));
            }
            run.approval_generation = run.approval_generation.saturating_add(1);
        }
        ExtensionRunCommand::AcceptCompletion => {
            if !run.completion_proposed || run.gate != ExtensionRunGate::Paused {
                return Err(DaemonError::BadRequest(
                    "completion can be accepted only after coordinator review is ready".to_string(),
                ));
            }
            close_run(
                run,
                ExtensionRunOutcome::Completed,
                "Completion accepted",
                now,
            );
        }
        ExtensionRunCommand::CloseIncomplete => {
            cancel_queued(run, "Cancelled when run closed", now);
            close_run(
                run,
                ExtensionRunOutcome::ClosedIncomplete,
                "Closed incomplete by human",
                now,
            );
        }
    }
    bump_policy(run, now);
    Ok(())
}

fn close_run(
    run: &mut ExtensionRunSummary,
    outcome: ExtensionRunOutcome,
    reason: &str,
    now: chrono::DateTime<Utc>,
) {
    run.gate = ExtensionRunGate::Closed;
    run.outcome = Some(outcome);
    run.pause_reason = Some(reason.to_string());
    run.pending_continuation = None;
    run.updated_at = now;
}

fn cancel_queued(run: &mut ExtensionRunSummary, reason: &str, now: chrono::DateTime<Utc>) {
    for operation in &mut run.operations {
        if operation.status == ExtensionOperationStatus::Queued {
            operation.status = ExtensionOperationStatus::Cancelled;
            operation.updated_at = now;
            operation.message = Some(reason.to_string());
            run.journal_sequence = run.journal_sequence.saturating_add(1);
        }
    }
}

fn new_operation(id: String, prompt: String, now: chrono::DateTime<Utc>) -> ExtensionRunOperation {
    ExtensionRunOperation {
        id,
        prompt,
        status: ExtensionOperationStatus::Queued,
        created_at: now,
        updated_at: now,
        provider_turn_id: None,
        source_turn_id_before_dispatch: None,
        message: None,
    }
}

fn queue_operation(
    run: &mut ExtensionRunSummary,
    operation_id: String,
    prompt: String,
    now: chrono::DateTime<Utc>,
) -> Result<(), DaemonError> {
    validate_text("operation id", &operation_id, 128)?;
    validate_prompt(&prompt)?;
    if run
        .operations
        .iter()
        .any(|operation| operation.id == operation_id)
    {
        return Err(DaemonError::BadRequest(
            "operation id already exists in this run".to_string(),
        ));
    }
    if run
        .operations
        .iter()
        .any(|operation| !operation.status.is_terminal())
    {
        return Err(DaemonError::BadRequest(
            "run already has an unresolved automatic operation".to_string(),
        ));
    }
    if run.operations.len() >= MAX_OPERATIONS_PER_RUN {
        return Err(DaemonError::BadRequest(
            "run operation journal is full".to_string(),
        ));
    }
    run.operations
        .push(new_operation(operation_id, prompt, now));
    run.journal_sequence = run.journal_sequence.saturating_add(1);
    Ok(())
}

fn expire_if_needed(run: &mut ExtensionRunSummary, now: chrono::DateTime<Utc>) {
    if run.gate != ExtensionRunGate::Closed && now >= run.deadline_at {
        cancel_queued(run, "Cancelled when mission deadline elapsed", now);
        close_run(
            run,
            ExtensionRunOutcome::Expired,
            "Mission deadline elapsed",
            now,
        );
        run.policy_revision = run.policy_revision.saturating_add(1);
    }
}

fn spawn_driver(app: &AppState, run_id: String) {
    let app = app.clone();
    tokio::spawn(async move {
        if let Err(error) = drive_run(&app, &run_id).await {
            tracing::warn!(%error, %run_id, "orchestration run driver stopped");
        }
    });
}

fn spawn_deadline_guard(app: &AppState, run_id: String, expected_deadline: chrono::DateTime<Utc>) {
    let app = app.clone();
    tokio::spawn(async move {
        let delay = (expected_deadline - Utc::now())
            .to_std()
            .unwrap_or(StdDuration::ZERO);
        tokio::time::sleep(delay).await;
        let should_apply = app
            .inner
            .orchestration_runs
            .lock()
            .await
            .runs
            .get(&run_id)
            .is_some_and(|run| {
                run.gate != ExtensionRunGate::Closed && run.deadline_at == expected_deadline
            });
        if !should_apply {
            return;
        }
        let result = mutate_run(&app, &run_id, |run, now| {
            // An older guard becomes a no-op after a human extends the lease.
            if run.deadline_at == expected_deadline {
                expire_if_needed(run, now);
            }
            Ok(())
        })
        .await;
        if let Err(error) = result {
            tracing::warn!(%error, %run_id, "failed to apply orchestration deadline");
        }
    });
}

async fn drive_run(app: &AppState, run_id: &str) -> Result<(), DaemonError> {
    loop {
        let snapshot = {
            let registry = app.inner.orchestration_runs.lock().await;
            let Some(run) = registry.runs.get(run_id) else {
                return Ok(());
            };
            run.clone()
        };
        if snapshot.gate == ExtensionRunGate::Closed {
            return Ok(());
        }
        let thread = match app
            .thread_summary(&snapshot.workspace_id, &snapshot.coordinator_thread_id)
            .await
        {
            Ok(thread) => thread,
            Err(error) => {
                pause_run(
                    app,
                    run_id,
                    format!("Coordinator task is unavailable: {error}"),
                )
                .await?;
                return Ok(());
            }
        };

        if Utc::now() >= snapshot.deadline_at {
            mutate_run(app, run_id, |run, now| {
                expire_if_needed(run, now);
                Ok(())
            })
            .await?;
            return Ok(());
        }

        let current = snapshot
            .operations
            .iter()
            .rev()
            .find(|operation| !operation.status.is_terminal())
            .cloned();
        match current {
            Some(operation) if operation.status == ExtensionOperationStatus::Queued => match thread
                .status
            {
                ThreadStatus::Idle if snapshot.gate == ExtensionRunGate::Open => {
                    if snapshot.automatic_turns_started >= snapshot.max_automatic_turns {
                        pause_run(app, run_id, "Automatic turn limit reached".to_string()).await?;
                        return Ok(());
                    }
                    let source_turn_id = thread.latest_turn_id.clone();
                    mark_dispatching(app, run_id, &operation.id, source_turn_id.clone()).await?;
                    let request = background_request(&thread, operation.prompt.clone());
                    match workspace_ops::send_background_turn(app, request).await {
                        Ok(_) => {
                            let provider_turn_id = app
                                .thread_summary(
                                    &snapshot.workspace_id,
                                    &snapshot.coordinator_thread_id,
                                )
                                .await
                                .ok()
                                .and_then(|summary| summary.latest_turn_id)
                                .filter(|turn_id| Some(turn_id) != source_turn_id.as_ref());
                            mutate_operation(
                                app,
                                run_id,
                                &operation.id,
                                ExtensionOperationStatus::Acknowledged,
                                provider_turn_id,
                                None,
                            )
                            .await?;
                        }
                        Err(error) => {
                            if workspace_ops::is_background_admission_conflict(&error) {
                                reject_operation(
                                        app,
                                        run_id,
                                        &operation.id,
                                        "A human message won task admission; automatic work was not queued",
                                    )
                                    .await?;
                            } else {
                                mark_unknown(app, run_id, &operation.id, error.to_string()).await?;
                            }
                            return Ok(());
                        }
                    }
                }
                ThreadStatus::Running => tokio::time::sleep(DRIVER_POLL).await,
                ThreadStatus::WaitingForInput => {
                    pause_run(
                        app,
                        run_id,
                        "Coordinator task needs human input".to_string(),
                    )
                    .await?;
                    return Ok(());
                }
                ThreadStatus::Error => {
                    reject_operation(
                        app,
                        run_id,
                        &operation.id,
                        "Coordinator task is in an error state",
                    )
                    .await?;
                    return Ok(());
                }
                ThreadStatus::Idle => return Ok(()),
            },
            Some(operation) if operation.status == ExtensionOperationStatus::Dispatching => {
                // The task that persisted Dispatching owns the provider call.
                // Other driver instances must not infer an outcome while that
                // in-process admission is still completing. Crash restoration
                // converts this state to OutcomeUnknown before drivers start.
                tokio::time::sleep(DRIVER_POLL).await;
            }
            Some(operation) if operation.status == ExtensionOperationStatus::Acknowledged => {
                let observed_turn_id = thread.latest_turn_id.clone().filter(|turn_id| {
                    Some(turn_id) != operation.source_turn_id_before_dispatch.as_ref()
                });
                if operation.provider_turn_id.is_none()
                    && let Some(turn_id) = observed_turn_id.clone()
                {
                    mutate_operation(
                        app,
                        run_id,
                        &operation.id,
                        ExtensionOperationStatus::Acknowledged,
                        Some(turn_id),
                        None,
                    )
                    .await?;
                    continue;
                }
                match thread.status {
                    ThreadStatus::Running => tokio::time::sleep(DRIVER_POLL).await,
                    ThreadStatus::Idle => {
                        if operation.provider_turn_id.is_some() || observed_turn_id.is_some() {
                            settle_operation(app, run_id, &operation.id).await?;
                        } else {
                            mark_unknown(
                                app,
                                run_id,
                                &operation.id,
                                "Coordinator returned idle without an attributable provider turn receipt"
                                    .to_string(),
                            )
                            .await?;
                            return Ok(());
                        }
                    }
                    ThreadStatus::WaitingForInput => {
                        pause_run(
                            app,
                            run_id,
                            "Coordinator task needs human input".to_string(),
                        )
                        .await?;
                        return Ok(());
                    }
                    ThreadStatus::Error => {
                        settle_failed_operation(app, run_id, &operation.id).await?;
                        return Ok(());
                    }
                }
            }
            Some(_) => return Ok(()),
            None if snapshot.pending_continuation.is_some() => match thread.status {
                ThreadStatus::Idle => materialize_continuation(app, run_id).await?,
                ThreadStatus::Running => tokio::time::sleep(DRIVER_POLL).await,
                ThreadStatus::WaitingForInput => {
                    pause_run(
                        app,
                        run_id,
                        "Coordinator task needs human input".to_string(),
                    )
                    .await?;
                    return Ok(());
                }
                ThreadStatus::Error => {
                    pause_run(app, run_id, "Coordinator source turn failed".to_string()).await?;
                    return Ok(());
                }
            },
            None if snapshot.completion_proposed => {
                if thread.status == ThreadStatus::Idle {
                    mutate_run(app, run_id, |run, now| {
                        run.gate = ExtensionRunGate::Paused;
                        run.pause_reason = Some("Completion is ready for human review".to_string());
                        bump_policy(run, now);
                        Ok(())
                    })
                    .await?;
                    return Ok(());
                }
                tokio::time::sleep(DRIVER_POLL).await;
            }
            None => return Ok(()),
        }
    }
}

fn background_request(thread: &falcondeck_core::ThreadSummary, prompt: String) -> SendTurnRequest {
    let (permission_mode, sandbox_mode, approval_policy) =
        if thread.provider == AgentProvider::CODEX {
            (
                Some("on-request".to_string()),
                Some("workspace-write".to_string()),
                Some("on-request".to_string()),
            )
        } else {
            (
                Some("acceptEdits".to_string()),
                thread.agent.sandbox_mode.clone(),
                Some("on-request".to_string()),
            )
        };
    SendTurnRequest {
        workspace_id: thread.workspace_id.clone(),
        thread_id: thread.id.clone(),
        inputs: vec![TurnInputItem::Text {
            id: None,
            text: prompt,
        }],
        selected_skills: Vec::new(),
        provider: Some(thread.provider.clone()),
        model_id: thread.agent.model_id.clone(),
        reasoning_effort: thread.agent.reasoning_effort.clone(),
        approval_policy,
        service_tier: thread.agent.service_tier.clone(),
        permission_mode,
        sandbox_mode,
        steer: false,
        user_item_id: None,
        resume_interrupted: false,
    }
}

async fn mutate_run(
    app: &AppState,
    run_id: &str,
    update: impl FnOnce(&mut ExtensionRunSummary, chrono::DateTime<Utc>) -> Result<(), DaemonError>,
) -> Result<(), DaemonError> {
    let _mutation = app.inner.orchestration_mutation.lock().await;
    let previous = app.inner.orchestration_runs.lock().await.clone();
    {
        let mut registry = app.inner.orchestration_runs.lock().await;
        let run = registry
            .runs
            .get_mut(run_id)
            .ok_or_else(|| DaemonError::NotFound("orchestration run not found".to_string()))?;
        update(run, Utc::now())?;
    }
    if let Err(error) = persist(app).await {
        *app.inner.orchestration_runs.lock().await = previous;
        return Err(error);
    }
    if let Some(run) = app
        .inner
        .orchestration_runs
        .lock()
        .await
        .runs
        .get(run_id)
        .cloned()
    {
        enqueue_run_updated(app, &run);
    }
    Ok(())
}

fn enqueue_run_updated(app: &AppState, run: &ExtensionRunSummary) {
    app.enqueue_extension_event_for(
        &run.owner_extension_id,
        ExtensionEvent::OrchestrationUpdated {
            workspace_id: run.workspace_id.clone(),
            run_id: run.id.clone(),
        },
    );
}

async fn mark_dispatching(
    app: &AppState,
    run_id: &str,
    operation_id: &str,
    source_turn_id: Option<String>,
) -> Result<(), DaemonError> {
    mutate_run(app, run_id, |run, now| {
        if run.automatic_turns_started >= run.max_automatic_turns {
            return Err(DaemonError::BadRequest(
                "automatic turn limit reached".to_string(),
            ));
        }
        let operation = find_operation_mut(run, operation_id)?;
        if operation.status != ExtensionOperationStatus::Queued {
            return Err(DaemonError::BadRequest(
                "operation is no longer queued".to_string(),
            ));
        }
        operation.status = ExtensionOperationStatus::Dispatching;
        operation.updated_at = now;
        operation.source_turn_id_before_dispatch = source_turn_id;
        run.automatic_turns_started = run.automatic_turns_started.saturating_add(1);
        run.journal_sequence = run.journal_sequence.saturating_add(1);
        run.updated_at = now;
        Ok(())
    })
    .await
}

async fn mutate_operation(
    app: &AppState,
    run_id: &str,
    operation_id: &str,
    status: ExtensionOperationStatus,
    provider_turn_id: Option<String>,
    message: Option<String>,
) -> Result<(), DaemonError> {
    mutate_run(app, run_id, |run, now| {
        let operation = find_operation_mut(run, operation_id)?;
        operation.status = status;
        operation.updated_at = now;
        if provider_turn_id.is_some() {
            operation.provider_turn_id = provider_turn_id;
        }
        operation.message = message;
        run.journal_sequence = run.journal_sequence.saturating_add(1);
        run.updated_at = now;
        Ok(())
    })
    .await
}

fn find_operation_mut<'a>(
    run: &'a mut ExtensionRunSummary,
    operation_id: &str,
) -> Result<&'a mut ExtensionRunOperation, DaemonError> {
    run.operations
        .iter_mut()
        .find(|operation| operation.id == operation_id)
        .ok_or_else(|| DaemonError::NotFound("orchestration operation not found".to_string()))
}

async fn settle_operation(
    app: &AppState,
    run_id: &str,
    operation_id: &str,
) -> Result<(), DaemonError> {
    mutate_run(app, run_id, |run, now| {
        settle_operation_in_run(run, operation_id, now)
    })
    .await
}

fn settle_operation_in_run(
    run: &mut ExtensionRunSummary,
    operation_id: &str,
    now: chrono::DateTime<Utc>,
) -> Result<(), DaemonError> {
    let operation = find_operation_mut(run, operation_id)?;
    operation.status = ExtensionOperationStatus::Settled;
    operation.updated_at = now;
    operation.message = Some("Coordinator turn settled".to_string());
    run.journal_sequence = run.journal_sequence.saturating_add(1);
    if run.completion_proposed {
        run.gate = ExtensionRunGate::Paused;
        run.pause_reason = Some("Completion is ready for human review".to_string());
        bump_policy(run, now);
    } else if run.pending_continuation.is_some() {
        materialize_continuation_in_run(run, now)?;
    } else if run.gate == ExtensionRunGate::Open {
        run.gate = ExtensionRunGate::Paused;
        run.pause_reason =
            Some("Coordinator turn ended without choosing a Mission disposition".to_string());
        bump_policy(run, now);
    }
    run.updated_at = now;
    Ok(())
}

async fn settle_failed_operation(
    app: &AppState,
    run_id: &str,
    operation_id: &str,
) -> Result<(), DaemonError> {
    mutate_run(app, run_id, |run, now| {
        let operation = find_operation_mut(run, operation_id)?;
        operation.status = ExtensionOperationStatus::Settled;
        operation.updated_at = now;
        operation.message = Some("Coordinator turn ended in an error state".to_string());
        run.gate = ExtensionRunGate::Paused;
        run.pause_reason = Some("Coordinator turn failed".to_string());
        run.pending_continuation = None;
        run.journal_sequence = run.journal_sequence.saturating_add(1);
        bump_policy(run, now);
        Ok(())
    })
    .await
}

async fn materialize_continuation(app: &AppState, run_id: &str) -> Result<(), DaemonError> {
    mutate_run(app, run_id, |run, now| {
        materialize_continuation_in_run(run, now)
    })
    .await
}

fn materialize_continuation_in_run(
    run: &mut ExtensionRunSummary,
    now: chrono::DateTime<Utc>,
) -> Result<(), DaemonError> {
    let pending = run
        .pending_continuation
        .take()
        .ok_or_else(|| DaemonError::BadRequest("run has no pending continuation".to_string()))?;
    if run.last_progress_fingerprint.as_deref() == Some(&pending.progress_fingerprint) {
        run.gate = ExtensionRunGate::Paused;
        run.pause_reason = Some("No durable progress since the previous turn".to_string());
        bump_policy(run, now);
        return Ok(());
    }
    if run.automatic_turns_started >= run.max_automatic_turns {
        run.gate = ExtensionRunGate::Paused;
        run.pause_reason = Some("Automatic turn limit reached".to_string());
        bump_policy(run, now);
        return Ok(());
    }
    if now >= run.deadline_at {
        expire_if_needed(run, now);
        return Ok(());
    }
    run.last_progress_fingerprint = Some(pending.progress_fingerprint);
    queue_operation(run, pending.operation_id, pending.prompt, now)?;
    run.updated_at = now;
    Ok(())
}

async fn pause_run(app: &AppState, run_id: &str, reason: String) -> Result<(), DaemonError> {
    mutate_run(app, run_id, |run, now| {
        if run.gate != ExtensionRunGate::Closed {
            run.gate = ExtensionRunGate::Paused;
            run.pause_reason = Some(reason);
            bump_policy(run, now);
        }
        Ok(())
    })
    .await
}

async fn reject_operation(
    app: &AppState,
    run_id: &str,
    operation_id: &str,
    reason: &str,
) -> Result<(), DaemonError> {
    mutate_run(app, run_id, |run, now| {
        let operation = find_operation_mut(run, operation_id)?;
        operation.status = ExtensionOperationStatus::Rejected;
        operation.updated_at = now;
        operation.message = Some(reason.to_string());
        run.gate = ExtensionRunGate::Paused;
        run.pause_reason = Some(reason.to_string());
        run.journal_sequence = run.journal_sequence.saturating_add(1);
        bump_policy(run, now);
        Ok(())
    })
    .await
}

async fn mark_unknown(
    app: &AppState,
    run_id: &str,
    operation_id: &str,
    reason: String,
) -> Result<(), DaemonError> {
    mutate_run(app, run_id, |run, now| {
        let operation = find_operation_mut(run, operation_id)?;
        operation.status = ExtensionOperationStatus::OutcomeUnknown;
        operation.updated_at = now;
        operation.message = Some(reason);
        run.gate = ExtensionRunGate::Paused;
        run.pause_reason = Some("Provider acceptance could not be proved".to_string());
        run.journal_sequence = run.journal_sequence.saturating_add(1);
        bump_policy(run, now);
        Ok(())
    })
    .await
}

/// Pauses every open run owned by a disabled or revoked extension.
pub(super) async fn pause_owned_runs(
    app: &AppState,
    extension_id: &str,
    reason: &str,
) -> Result<(), DaemonError> {
    let _mutation = app.inner.orchestration_mutation.lock().await;
    let previous = app.inner.orchestration_runs.lock().await.clone();
    let now = Utc::now();
    let mut changed_runs = Vec::new();
    {
        let mut registry = app.inner.orchestration_runs.lock().await;
        for run in registry.runs.values_mut().filter(|run| {
            run.owner_extension_id == extension_id && run.gate != ExtensionRunGate::Closed
        }) {
            cancel_queued(run, reason, now);
            run.pending_continuation = None;
            run.gate = ExtensionRunGate::Paused;
            run.pause_reason = Some(reason.to_string());
            bump_policy(run, now);
            changed_runs.push(run.clone());
        }
    }
    if !changed_runs.is_empty()
        && let Err(error) = persist(app).await
    {
        *app.inner.orchestration_runs.lock().await = previous;
        return Err(error);
    }
    drop(_mutation);
    for run in changed_runs {
        enqueue_run_updated(app, &run);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run() -> ExtensionRunSummary {
        let now = Utc::now();
        ExtensionRunSummary {
            id: "run-1".to_string(),
            owner_extension_id: MISSIONS_EXTENSION_ID.to_string(),
            workspace_id: "workspace-1".to_string(),
            coordinator_thread_id: "thread-1".to_string(),
            title: "Ship feature".to_string(),
            objective: "Implement and verify the feature".to_string(),
            gate: ExtensionRunGate::Open,
            outcome: None,
            pause_reason: None,
            checkpoint: json!({ "disposition": "planning" }),
            policy_revision: 1,
            journal_sequence: 0,
            approval_generation: 1,
            automatic_turns_started: 0,
            max_automatic_turns: MAX_AUTOMATIC_TURNS,
            created_at: now,
            updated_at: now,
            deadline_at: now + Duration::minutes(DEFAULT_LEASE_MINUTES),
            last_progress_fingerprint: None,
            pending_continuation: None,
            completion_proposed: false,
            operations: Vec::new(),
        }
    }

    #[test]
    fn continuation_is_materialized_once_and_repeated_progress_pauses() {
        let mut run = run();
        let now = Utc::now();
        run.pending_continuation = Some(ExtensionPendingContinuation {
            operation_id: "operation-1".to_string(),
            prompt: "Continue the mission".to_string(),
            progress_fingerprint: "fingerprint-a".to_string(),
            requested_at: now,
        });
        materialize_continuation_in_run(&mut run, now).expect("first continuation");
        assert_eq!(run.operations.len(), 1);
        assert_eq!(
            run.last_progress_fingerprint.as_deref(),
            Some("fingerprint-a")
        );

        run.operations[0].status = ExtensionOperationStatus::Settled;
        run.pending_continuation = Some(ExtensionPendingContinuation {
            operation_id: "operation-2".to_string(),
            prompt: "Try again".to_string(),
            progress_fingerprint: "fingerprint-a".to_string(),
            requested_at: now,
        });
        materialize_continuation_in_run(&mut run, now).expect("stall transition");
        assert_eq!(run.operations.len(), 1);
        assert_eq!(run.gate, ExtensionRunGate::Paused);
        assert!(
            run.pause_reason
                .as_deref()
                .unwrap()
                .contains("No durable progress")
        );
    }

    #[test]
    fn automatic_turn_limit_is_a_hard_gate() {
        let mut run = run();
        run.automatic_turns_started = MAX_AUTOMATIC_TURNS;
        run.pending_continuation = Some(ExtensionPendingContinuation {
            operation_id: "operation-5".to_string(),
            prompt: "Continue".to_string(),
            progress_fingerprint: "new-progress".to_string(),
            requested_at: Utc::now(),
        });
        materialize_continuation_in_run(&mut run, Utc::now()).expect("bounded pause");
        assert_eq!(run.gate, ExtensionRunGate::Paused);
        assert!(run.operations.is_empty());
        assert_eq!(
            run.pause_reason.as_deref(),
            Some("Automatic turn limit reached")
        );
    }

    #[test]
    fn completion_requires_a_paused_proposal() {
        let mut run = run();
        let error = apply_human_command(
            &mut run,
            ExtensionRunCommand::AcceptCompletion,
            None,
            None,
            Utc::now(),
        )
        .expect_err("active run cannot be accepted");
        assert!(error.to_string().contains("completion"));

        run.completion_proposed = true;
        run.gate = ExtensionRunGate::Paused;
        apply_human_command(
            &mut run,
            ExtensionRunCommand::AcceptCompletion,
            None,
            None,
            Utc::now(),
        )
        .expect("human accepts proposal");
        assert_eq!(run.gate, ExtensionRunGate::Closed);
        assert_eq!(run.outcome, Some(ExtensionRunOutcome::Completed));
    }

    #[test]
    fn coordinator_tool_effects_require_exact_daemon_bound_task_identity() {
        let run = run();
        for actor in [
            EffectActor::AgentTool {
                workspace_id: None,
                thread_id: None,
            },
            EffectActor::AgentTool {
                workspace_id: Some("workspace-1"),
                thread_id: Some("spoofed-thread"),
            },
        ] {
            let error = authorize_tool_run(&run, &actor).expect_err("identity must be exact");
            assert!(error.to_string().contains("coordinator task"));
        }

        authorize_tool_run(
            &run,
            &EffectActor::AgentTool {
                workspace_id: Some("workspace-1"),
                thread_id: Some("thread-1"),
            },
        )
        .expect("matching bridge identity is authorized");
    }

    #[test]
    fn a_turn_without_a_disposition_pauses_instead_of_leaving_a_zombie_run() {
        let mut run = run();
        let now = Utc::now();
        run.operations.push(new_operation(
            "operation-1".to_string(),
            "Work".to_string(),
            now,
        ));
        run.operations[0].status = ExtensionOperationStatus::Acknowledged;

        settle_operation_in_run(&mut run, "operation-1", now).expect("turn should settle");

        assert_eq!(run.operations[0].status, ExtensionOperationStatus::Settled);
        assert_eq!(run.gate, ExtensionRunGate::Paused);
        assert!(
            run.pause_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("without choosing"))
        );
    }

    #[test]
    fn deadline_expiry_closes_even_a_paused_run() {
        let mut run = run();
        run.gate = ExtensionRunGate::Paused;
        run.deadline_at = Utc::now() - Duration::seconds(1);

        expire_if_needed(&mut run, Utc::now());

        assert_eq!(run.gate, ExtensionRunGate::Closed);
        assert_eq!(run.outcome, Some(ExtensionRunOutcome::Expired));
    }
}
