//! The `ControlService` implementation: search, get, execute and the run
//! ledger the scheduler drives. See the [module docs](super) for the layout.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Datelike, Timelike, Utc};
use falcondeck_core::control::{
    AgentControlSettings, AuditResult, Automation, AutomationRun, AutomationRunStatus,
    AutomationState, ControlAuditEntry, ControlDomain, ControlErrorDetail, ControlExecuteRequest,
    ControlExecuteResponse, ControlGetRequest, ControlGetResponse, ControlOrigin,
    ControlRequestContext, ControlSearchRequest, ControlSearchResponse, ControlStateChanged,
    FieldError,
};
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, Semaphore};
use uuid::Uuid;

use super::registry::{self, Capability, ops};
use super::{automations, redaction, store};
use crate::app::AppState;

/// Initial daemon-wide cap on concurrently active automation runs.
pub const MAX_CONCURRENT_AUTOMATION_RUNS: usize = 4;

/// A structured control error. The wire shape is [`ControlErrorDetail`];
/// constructors map onto the documented error-code catalogue.
#[derive(Debug, Clone)]
pub struct ControlError(pub ControlErrorDetail);

impl ControlError {
    /// Builds an error from a code, message and retryability.
    pub fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self(ControlErrorDetail {
            code: code.to_string(),
            message: message.into(),
            retryable,
            field_errors: Vec::new(),
            current_revision: None,
            suggested_action: None,
        })
    }

    /// Attaches a field-level error.
    pub fn with_field(mut self, field: &str, message: impl Into<String>) -> Self {
        self.0.field_errors.push(FieldError {
            field: field.to_string(),
            message: message.into(),
        });
        self
    }

    /// Attaches a suggested action.
    pub fn with_suggested_action(mut self, action: impl Into<String>) -> Self {
        self.0.suggested_action = Some(action.into());
        self
    }

    /// Attaches the current resource revision.
    pub fn with_current_revision(mut self, revision: u64) -> Self {
        self.0.current_revision = Some(revision);
        self
    }

    /// A validation failure with a field pointer.
    pub fn field(field: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self::new("invalid_arguments", message.clone(), false).with_field(field, message)
    }

    /// Arguments that do not match the operation schema.
    pub fn invalid_arguments(message: impl Into<String>) -> Self {
        Self::new("invalid_arguments", message, false)
    }

    /// A schedule that cannot be used.
    pub fn invalid_schedule(message: impl Into<String>, field: Option<&str>) -> Self {
        let error = Self::new("invalid_schedule", message, true);
        match field {
            Some(field) => {
                let message = error.0.message.clone();
                error.with_field(field, message)
            }
            None => error,
        }
    }

    /// A timezone that is not an IANA identifier.
    pub fn invalid_timezone(name: &str) -> Self {
        Self::new(
            "invalid_timezone",
            format!("Timezone {name:?} is not an IANA timezone identifier."),
            true,
        )
        .with_field(
            "timezone",
            "Use an identifier such as Europe/London.".to_string(),
        )
        .with_suggested_action("Retry with an IANA timezone identifier such as Europe/London.")
    }

    /// An operation identifier that is not registered.
    pub fn unknown_operation(operation: &str) -> Self {
        Self::new(
            "unknown_operation",
            format!("Operation {operation:?} is not a registered FalconDeck capability."),
            false,
        )
        .with_suggested_action("Call falcondeck_search to discover supported operations.")
    }

    /// A resource selector that is not known.
    pub fn unknown_resource(resource: &str) -> Self {
        Self::new(
            "unknown_resource",
            format!("Resource {resource:?} is not readable through falcondeck_get."),
            false,
        )
        .with_suggested_action(
            "Use one of: agent_control.settings, automations, automation, automation.runs, control.audit.",
        )
    }

    /// A resource that does not exist.
    pub fn resource_not_found(kind: &str, id: &str) -> Self {
        Self::new(
            "resource_not_found",
            format!("{kind} {id:?} was not found."),
            false,
        )
    }

    /// The control interface is disabled globally for MCP callers.
    pub fn interface_disabled(message: impl Into<String>) -> Self {
        Self::new("interface_disabled", message, false)
    }

    /// The control interface is disabled for one provider.
    pub fn provider_disabled(message: impl Into<String>) -> Self {
        Self::new("provider_disabled", message, false)
    }

    /// A revision-aware mutation without the revision the caller read.
    pub fn revision_required() -> Self {
        Self::new(
            "revision_required",
            "expected_revision is required for this operation",
            false,
        )
        .with_suggested_action("Read the current automation and retry with its revision.")
    }

    /// A mutation based on a stale revision.
    pub fn revision_conflict(expected: u64, current: u64, id: &str) -> Self {
        Self::new(
            "revision_conflict",
            format!("Automation {id} changed after it was read."),
            true,
        )
        .with_current_revision(current)
        .with_suggested_action(format!(
            "Read the automation again, reconcile the changes and retry with expected_revision {current} (caller sent {expected})."
        ))
    }

    /// An idempotency key reused with different arguments.
    pub fn idempotency_conflict() -> Self {
        Self::new(
            "idempotency_conflict",
            "This idempotency key was already used with different arguments.",
            false,
        )
        .with_suggested_action("Reuse the key only for identical retries, or supply a new key.")
    }

    /// A workspace that cannot back an automation.
    pub fn workspace_unavailable(path: &str) -> Self {
        Self::new(
            "workspace_unavailable",
            format!("Workspace path {path:?} is not an available directory on this host."),
            false,
        )
        .with_field(
            "target.workspace_path",
            "Use an existing absolute path such as /Users/me/Code/project.",
        )
    }

    /// A provider this daemon cannot run.
    pub fn provider_unavailable(provider: &str) -> Self {
        Self::new(
            "provider_unavailable",
            format!("Provider {provider:?} is not configured or discoverable on this daemon."),
            false,
        )
        .with_field(
            "target.provider",
            "Use a provider the daemon can run, such as codex or claude.".to_string(),
        )
    }

    /// A required connector that is not available.
    pub fn connector_unavailable(name: &str) -> Self {
        Self::new(
            "connector_unavailable",
            format!(
                "Required connector {name:?} is not available to the target provider and workspace."
            ),
            true,
        )
        .with_field(
            "required_connectors",
            format!("Remove {name:?} or configure it in connectors.json."),
        )
    }

    /// Elevated authority that settings do not allow.
    pub fn elevated_permissions_disabled() -> Self {
        Self::new(
            "elevated_permissions_disabled",
            "This automation uses an elevated permission or sandbox mode, and elevated automations are disabled.",
            false,
        )
        .with_suggested_action(
            "Enable allow_elevated_automations in agent control settings, or remove the elevated mode.",
        )
    }

    /// A failed execution.
    pub fn execution_failed(message: impl Into<String>) -> Self {
        Self::new("execution_failed", message, true)
    }

    /// The control store cannot be used.
    pub fn storage_unavailable(message: impl Into<String>) -> Self {
        Self::new("storage_unavailable", message, false).with_suggested_action(
            "Resolve the agent-control.json problem reported by the daemon and restart.",
        )
    }

    /// An unexpected internal failure.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal_error", message, false)
    }

    fn into_envelope(self, operation: &str) -> ControlExecuteResponse {
        ControlExecuteResponse {
            ok: false,
            operation: operation.to_string(),
            data: None,
            error: Some(store::bounded_error_detail(self.0)),
        }
    }
}

/// Dependencies the control service uses for deep validation and dispatch.
/// Tests drive the service with `app: None` to exercise store behaviour
/// without live providers.
pub struct ControlDeps<'a> {
    /// The owning daemon state, when available.
    pub app: Option<&'a AppState>,
}

impl<'a> ControlDeps<'a> {
    /// An empty dependency set: deep validation is skipped.
    pub fn none() -> Self {
        Self { app: None }
    }
}

/// Where a run came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunSource {
    /// A manual `automation.run_now`.
    Manual {
        /// The origin that requested the run.
        origin: ControlOrigin,
    },
    /// The scheduler dispatching a due occurrence.
    Scheduled,
}

/// The daemon-owned control service.
pub struct ControlService {
    path: PathBuf,
    state: Mutex<store::PersistedControlState>,
    mutation: Mutex<()>,
    /// `Some(reason)` while the persisted store is unusable; the service
    /// rejects requests with `storage_unavailable` until it is restored.
    storage_error: StdMutex<Option<String>>,
    /// Wakes the scheduler after definition and run changes.
    scheduler_notify: Notify,
    scheduler_started: AtomicBool,
    /// Daemon-wide cap on concurrently active automation runs.
    run_slots: Semaphore,
}

impl ControlService {
    /// Creates a service backed by `path`. Call [`ControlService::restore`]
    /// before serving requests.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(store::PersistedControlState::default()),
            mutation: Mutex::new(()),
            storage_error: StdMutex::new(None),
            scheduler_notify: Notify::new(),
            scheduler_started: AtomicBool::new(false),
            run_slots: Semaphore::new(MAX_CONCURRENT_AUTOMATION_RUNS),
        }
    }

    /// The store path, for diagnostics.
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Why the store is unusable, when it is.
    pub fn storage_error(&self) -> Option<String> {
        self.storage_error
            .lock()
            .expect("control storage lock")
            .clone()
    }

    /// Loads persisted control state. Returns a human-readable warning when
    /// the store was unreadable (scheduling stays disabled until resolved).
    pub async fn restore(&self) -> Result<Option<String>, String> {
        let now = Utc::now();
        let loaded = match store::load(&self.path).await {
            Ok(state) => state,
            Err(store::LoadFailure::Malformed { error }) => {
                let recovery = store::preserve_recovery_copy(&self.path, now).await;
                let message = match recovery {
                    Some(path) => format!(
                        "{} The malformed file was preserved at {}.",
                        error,
                        path.display()
                    ),
                    None => format!(
                        "{error} The malformed file was left in place at {}.",
                        self.path.display()
                    ),
                };
                self.degrade(message.clone());
                return Ok(Some(message));
            }
            Err(store::LoadFailure::UnsupportedVersion { version }) => {
                let message = format!(
                    "agent-control.json declares schema version {version}, which this FalconDeck does not understand; the file was left untouched at {}.",
                    self.path.display()
                );
                self.degrade(message.clone());
                return Ok(Some(message));
            }
            Err(store::LoadFailure::TooLarge { bytes }) => {
                let message = format!(
                    "agent-control.json is {bytes} bytes, above the {}-byte limit; the file was left untouched.",
                    8 * 1024 * 1024
                );
                self.degrade(message.clone());
                return Ok(Some(message));
            }
        };
        let mut next = loaded;
        store::cancel_in_flight_runs(&mut next, now);
        for automation in &mut next.automations {
            if automation.state != AutomationState::Enabled {
                continue;
            }
            let dispatched: BTreeSet<String> = next.occurrence_keys.iter().cloned().collect();
            match automations::reconcile_misfire(automation, now, &dispatched) {
                Ok(automations::MisfirePlan::UpToDate) => {}
                Ok(automations::MisfirePlan::Advance(occurrence)) => {
                    automation.next_run_at = occurrence.map(|occurrence| occurrence.at);
                }
                Err(error) => {
                    // A definition that no longer validates keeps its stored
                    // schedule but stops dispatching until repaired.
                    tracing::warn!(
                        automation = %automation.id,
                        error = %error.0.message,
                        "stored automation trigger no longer validates after restore"
                    );
                    automation.state = AutomationState::Failed;
                }
            }
        }
        store::compact(&mut next, now);
        if let Err(error) = store::persist(&self.path, &next).await {
            return Err(format!(
                "failed to persist restored control state: {}",
                error.0.message
            ));
        }
        *self.state.lock().await = next;
        *self.storage_error.lock().expect("control storage lock") = None;
        Ok(None)
    }

    fn degrade(&self, message: String) {
        *self.storage_error.lock().expect("control storage lock") = Some(message);
        if let Ok(mut state) = self.state.try_lock() {
            *state = store::PersistedControlState::default();
        }
    }

    fn ensure_usable(&self) -> Result<(), ControlError> {
        match self.storage_error() {
            Some(reason) => Err(ControlError::storage_unavailable(reason)),
            None => Ok(()),
        }
    }

    /// Ensures MCP-originated requests are allowed by current settings.
    /// Tool removal alone is insufficient: provider processes may have cached
    /// a tool catalogue, so enforcement is server-side on every request.
    pub fn ensure_mcp_enabled(
        &self,
        settings: &AgentControlSettings,
        provider: Option<&falcondeck_core::AgentProvider>,
    ) -> Result<(), ControlError> {
        if !settings.enabled {
            return Err(ControlError::interface_disabled(
                "FalconDeck agent control is disabled globally.",
            ));
        }
        if let Some(provider) = provider
            && settings
                .providers
                .get(provider)
                .is_some_and(|settings| !settings.enabled)
        {
            return Err(ControlError::provider_disabled(format!(
                "FalconDeck agent control is disabled for provider {provider}."
            )));
        }
        Ok(())
    }

    fn enforce_origin(
        &self,
        context: &ControlRequestContext,
        settings: &AgentControlSettings,
    ) -> Result<(), ControlError> {
        if context.origin == ControlOrigin::Mcp {
            self.ensure_mcp_enabled(settings, context.provider.as_ref())?;
        }
        Ok(())
    }

    /// Capability discovery.
    pub async fn search(
        &self,
        request: ControlSearchRequest,
        context: &ControlRequestContext,
    ) -> Result<ControlSearchResponse, ControlError> {
        self.ensure_usable()?;
        let settings = self.state.lock().await.settings.clone();
        self.enforce_origin(context, &settings)?;
        let mcp_allowed = context.origin != ControlOrigin::Mcp
            || self
                .ensure_mcp_enabled(&settings, context.provider.as_ref())
                .is_ok();
        let results = registry::search(&request, &|_capability: &Capability| mcp_allowed);
        Ok(ControlSearchResponse { results })
    }

    /// Control reads: settings, automations, runs and audit history.
    pub async fn get(
        &self,
        request: ControlGetRequest,
        context: &ControlRequestContext,
    ) -> Result<ControlGetResponse, ControlError> {
        self.ensure_usable()?;
        let state = self.state.lock().await.clone();
        self.enforce_origin(context, &state.settings)?;
        let limit = request
            .limit
            .clamp(1, falcondeck_core::control::CONTROL_PAGE_LIMIT_MAX);
        match request.resource.as_str() {
            "agent_control.settings" => Ok(ControlGetResponse {
                resource: request.resource.clone(),
                data: redaction::redacted(
                    serde_json::to_value(&state.settings)
                        .map_err(|error| ControlError::internal(error.to_string()))?,
                ),
                next_cursor: None,
            }),
            "automations" => list_automations(&state, &request, limit),
            "automation" => {
                let id = request.id.as_deref().ok_or_else(|| {
                    ControlError::invalid_arguments("resource 'automation' requires id")
                        .with_field("id", "Supply the automation id from the automations list.")
                })?;
                // A single explicit read is the one place the full
                // instruction is returned.
                let automation = state
                    .automations
                    .iter()
                    .find(|automation| automation.id == id)
                    .ok_or_else(|| ControlError::resource_not_found("automation", id))?;
                Ok(ControlGetResponse {
                    resource: request.resource.clone(),
                    data: redaction::redacted(
                        serde_json::to_value(automation)
                            .map_err(|error| ControlError::internal(error.to_string()))?,
                    ),
                    next_cursor: None,
                })
            }
            "automation.runs" => list_runs(&state, &request, limit),
            "control.audit" => list_audit(&state, &request, limit),
            other => Err(ControlError::unknown_resource(other)),
        }
    }

    /// Executes one registered operation. Returns the response envelope —
    /// control-level failures are reported through `ok: false`, not as
    /// transport errors — plus the state-change event for the daemon to
    /// broadcast.
    pub async fn execute(
        &self,
        request: ControlExecuteRequest,
        context: &ControlRequestContext,
        deps: &ControlDeps<'_>,
    ) -> (ControlExecuteResponse, Option<ControlStateChanged>) {
        if let Err(error) = self.ensure_usable() {
            return (error.into_envelope(&request.operation), None);
        }
        let Some(capability) = registry::find(&request.operation) else {
            return (
                ControlError::unknown_operation(&request.operation)
                    .into_envelope(&request.operation),
                None,
            );
        };
        let settings = self.state.lock().await.settings.clone();
        if let Err(error) = self.enforce_origin(context, &settings) {
            return (error.into_envelope(&request.operation), None);
        }

        // Idempotency replay: scoped to origin + provider + operation + key.
        if let Some(key) = request.idempotency_key.as_deref() {
            let scope = idempotency_scope(context, &request.operation);
            let arguments_hash = arguments_hash(&request.arguments);
            let replay = {
                let state = self.state.lock().await;
                state
                    .idempotency_records
                    .iter()
                    .find(|record| record.key == key && record.scope == scope)
                    .cloned()
            };
            if let Some(record) = replay {
                if record.arguments_hash != arguments_hash {
                    return (
                        ControlError::idempotency_conflict().into_envelope(&request.operation),
                        None,
                    );
                }
                let response: ControlExecuteResponse = serde_json::from_value(record.response)
                    .unwrap_or_else(|_| {
                        ControlError::internal("stored idempotent response was unreadable")
                            .into_envelope(&request.operation)
                    });
                return (response, None);
            }
        }

        let outcome = self
            .execute_operation(capability, &request, context, deps, &settings)
            .await;
        let (response, mut domains) = match outcome {
            Ok((data, domains)) => (
                ControlExecuteResponse {
                    ok: true,
                    operation: request.operation.clone(),
                    data: Some(data),
                    error: None,
                },
                domains,
            ),
            Err(error) => (
                error.into_envelope(&request.operation),
                vec![ControlDomain::Audit],
            ),
        };

        // Audit every mutation outcome once validation has begun.
        let audit_entry = ControlAuditEntry {
            id: format!("audit-{}", Uuid::new_v4().simple()),
            occurred_at: Utc::now(),
            context: context.clone(),
            operation: request.operation.clone(),
            resource_type: Some(resource_type(&request.operation).to_string()),
            resource_id: response
                .data
                .as_ref()
                .and_then(|data| data.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string),
            result: if response.ok {
                AuditResult::Success
            } else {
                AuditResult::Failure
            },
            summary: audit_summary(&request, &response),
        };
        match self.append_audit(audit_entry).await {
            Ok(()) => {
                if !domains.contains(&ControlDomain::Audit) {
                    domains.push(ControlDomain::Audit);
                }
            }
            Err(error) => {
                tracing::warn!(
                    error = %error.0.message,
                    operation = %request.operation,
                    "failed to persist control audit entry"
                );
            }
        }

        // Record idempotency for any outcome after validation began.
        if let Some(key) = request.idempotency_key.as_deref() {
            let record = store::IdempotencyRecord {
                key: key.to_string(),
                scope: idempotency_scope(context, &request.operation),
                arguments_hash: arguments_hash(&request.arguments),
                response: serde_json::to_value(&response)
                    .unwrap_or_else(|_| json!({ "ok": response.ok })),
                created_at: Utc::now(),
            };
            if let Err(error) = self.record_idempotency(record).await {
                tracing::warn!(
                    error = %error.0.message,
                    "failed to persist control idempotency record"
                );
            }
        }

        let store_revision = self.state.lock().await.store_revision;
        let event = (store_revision > 0).then_some(ControlStateChanged {
            store_revision,
            domains,
        });
        self.scheduler_notify.notify_one();
        (response, event)
    }

    async fn execute_operation(
        &self,
        capability: &Capability,
        request: &ControlExecuteRequest,
        context: &ControlRequestContext,
        deps: &ControlDeps<'_>,
        settings: &AgentControlSettings,
    ) -> Result<(Value, Vec<ControlDomain>), ControlError> {
        match capability.id {
            ops::SETTINGS_UPDATE => self.update_settings(&request.arguments).await,
            ops::AUTOMATION_CREATE => {
                self.create_automation(&request.arguments, deps, settings)
                    .await
            }
            ops::AUTOMATION_UPDATE => self.update_automation(request, deps, settings).await,
            ops::AUTOMATION_PAUSE => {
                self.set_automation_state(request, AutomationState::Paused)
                    .await
            }
            ops::AUTOMATION_RESUME => {
                self.set_automation_state(request, AutomationState::Enabled)
                    .await
            }
            ops::AUTOMATION_RUN_NOW => {
                self.run_automation_now(&request.arguments, context.origin.clone())
                    .await
            }
            ops::AUTOMATION_DELETE => self.delete_automation(request).await,
            other => Err(ControlError::internal(format!(
                "operation {other} is registered but not implemented"
            ))),
        }
    }

    async fn update_settings(
        &self,
        arguments: &serde_json::Map<String, Value>,
    ) -> Result<(Value, Vec<ControlDomain>), ControlError> {
        let args: registry::UpdateSettingsArgs = decode_arguments(arguments)?;
        if args.is_empty() {
            return Err(ControlError::invalid_arguments(
                "at least one settings field is required",
            )
            .with_field(
                "arguments",
                "Supply enabled, providers, default_timezone, allow_elevated_automations or confirmation_policy.",
            ));
        }
        if let Some(timezone) = &args.default_timezone {
            automations::parse_timezone(timezone)?;
        }
        let mut domains = vec![ControlDomain::Settings];
        self.mutate(|state, _now| {
            if let Some(enabled) = args.enabled {
                state.settings.enabled = enabled;
            }
            if let Some(providers) = &args.providers {
                state.settings.providers = providers
                    .iter()
                    .map(|(provider, settings)| {
                        (
                            falcondeck_core::AgentProvider::new(provider.clone()),
                            settings.clone(),
                        )
                    })
                    .collect();
            }
            if let Some(timezone) = &args.default_timezone {
                state.settings.default_timezone = timezone.clone();
            }
            if let Some(allow) = args.allow_elevated_automations {
                state.settings.allow_elevated_automations = allow;
            }
            if let Some(policy) = &args.confirmation_policy {
                state.settings.confirmation_policy = policy.clone();
            }
            let data = serde_json::to_value(state.settings.clone())
                .map_err(|error| ControlError::internal(error.to_string()))?;
            Ok((data, std::mem::take(&mut domains)))
        })
        .await
    }

    async fn create_automation(
        &self,
        arguments: &serde_json::Map<String, Value>,
        deps: &ControlDeps<'_>,
        settings: &AgentControlSettings,
    ) -> Result<(Value, Vec<ControlDomain>), ControlError> {
        let args: registry::CreateAutomationArgs = decode_arguments(arguments)?;
        automations::validate_definition(
            &args.name,
            args.description.as_deref(),
            &args.task,
            &args.target,
            &args.required_connectors,
        )?;
        let now = Utc::now();
        let next = automations::validate_trigger(&args.trigger, now)?;
        let elevated = automations::is_elevated_mode(
            args.target.permission_mode.as_deref(),
            args.target.sandbox_mode.as_deref(),
        );
        if elevated && !settings.allow_elevated_automations {
            return Err(ControlError::elevated_permissions_disabled());
        }
        self.validate_against_daemon(deps, &args.target, &args.required_connectors)
            .await?;
        let automation = Automation {
            id: format!("automation-{}", Uuid::new_v4().simple()),
            revision: 1,
            name: args.name.trim().to_string(),
            description: args.description,
            trigger: args.trigger,
            task: args.task,
            target: args.target,
            state: AutomationState::Enabled,
            concurrency_policy: args.concurrency_policy,
            misfire_policy: args.misfire_policy,
            elevated,
            required_connectors: args.required_connectors,
            created_at: now,
            updated_at: now,
            next_run_at: Some(next.at),
            last_run_at: None,
            latest_outcome: None,
        };
        let data = automation_value(&automation);
        self.mutate(|state, _now| {
            state.automations.push(automation);
            Ok((data.clone(), vec![ControlDomain::Automations]))
        })
        .await
    }

    async fn update_automation(
        &self,
        request: &ControlExecuteRequest,
        deps: &ControlDeps<'_>,
        settings: &AgentControlSettings,
    ) -> Result<(Value, Vec<ControlDomain>), ControlError> {
        let args: registry::UpdateAutomationArgs = decode_arguments(&request.arguments)?;
        if args.is_empty() {
            return Err(ControlError::invalid_arguments(
                "at least one automation field is required",
            ));
        }
        require_revision(request)?;
        // Deep validation runs against the proposed target before mutating.
        if let Some(target) = &args.target {
            let connectors = args.required_connectors.clone().unwrap_or_default();
            self.validate_against_daemon(deps, target, &connectors)
                .await?;
        }
        let automation_id = args.automation_id.clone();
        let trigger_changed = args.trigger.is_some();
        self.mutate(move |state, now| {
            let automation = state
                .automations
                .iter_mut()
                .find(|automation| automation.id == automation_id)
                .ok_or_else(|| ControlError::resource_not_found("automation", &automation_id))?;
            require_revision_for(request, automation)?;
            if let Some(name) = &args.name {
                automation.name = name.trim().to_string();
            }
            if let Some(description) = &args.description {
                automation.description = Some(description.clone());
            }
            if let Some(trigger) = &args.trigger {
                automation.trigger = trigger.clone();
            }
            if let Some(task) = &args.task {
                automation.task = task.clone();
            }
            if let Some(target) = &args.target {
                automation.target = target.clone();
            }
            if let Some(connectors) = &args.required_connectors {
                automation.required_connectors = connectors.clone();
            }
            if let Some(policy) = args.concurrency_policy {
                automation.concurrency_policy = policy;
            }
            if let Some(policy) = args.misfire_policy {
                automation.misfire_policy = policy;
            }
            automations::validate_definition(
                &automation.name,
                automation.description.as_deref(),
                &automation.task,
                &automation.target,
                &automation.required_connectors,
            )?;
            let elevated = automations::is_elevated_mode(
                automation.target.permission_mode.as_deref(),
                automation.target.sandbox_mode.as_deref(),
            );
            if elevated && !settings.allow_elevated_automations {
                return Err(ControlError::elevated_permissions_disabled());
            }
            automation.elevated = elevated;
            if trigger_changed {
                let next = automations::validate_trigger(&automation.trigger, now)?;
                automation.next_run_at = Some(next.at);
                // A completed one-time automation that is rescheduled
                // becomes enabled again.
                if automation.state == AutomationState::Completed {
                    automation.state = AutomationState::Enabled;
                }
            }
            automation.updated_at = now;
            automation.revision += 1;
            Ok((
                automation_value(automation),
                vec![ControlDomain::Automations],
            ))
        })
        .await
    }

    async fn set_automation_state(
        &self,
        request: &ControlExecuteRequest,
        target_state: AutomationState,
    ) -> Result<(Value, Vec<ControlDomain>), ControlError> {
        let args: registry::AutomationRefArgs = decode_arguments(&request.arguments)?;
        require_revision(request)?;
        let automation_id = args.automation_id.clone();
        self.mutate(move |state, now| {
            let automation = state
                .automations
                .iter_mut()
                .find(|automation| automation.id == automation_id)
                .ok_or_else(|| ControlError::resource_not_found("automation", &automation_id))?;
            require_revision_for(request, automation)?;
            let changing = automation.state != target_state;
            match (target_state, automation.state) {
                (AutomationState::Paused, AutomationState::Paused)
                | (AutomationState::Enabled, AutomationState::Enabled) => {
                    // Idempotent: nothing to change.
                }
                (AutomationState::Enabled, AutomationState::Completed)
                | (AutomationState::Enabled, AutomationState::Failed) => {
                    return Err(ControlError::invalid_arguments(
                        "a terminal automation cannot be resumed; update its trigger instead",
                    ));
                }
                _ => {
                    automation.state = target_state;
                    if changing {
                        automation.updated_at = now;
                        automation.revision += 1;
                        if target_state == AutomationState::Enabled {
                            // Resuming recalculates the next occurrence from now.
                            let dispatched: BTreeSet<String> =
                                state.occurrence_keys.iter().cloned().collect();
                            let next = automations::advance_after(automation, now, &dispatched)?;
                            automation.next_run_at = next.map(|next| next.at);
                        }
                    }
                }
            }
            Ok((
                automation_value(automation),
                vec![ControlDomain::Automations],
            ))
        })
        .await
    }

    async fn run_automation_now(
        &self,
        arguments: &serde_json::Map<String, Value>,
        origin: ControlOrigin,
    ) -> Result<(Value, Vec<ControlDomain>), ControlError> {
        let args: registry::AutomationRefArgs = decode_arguments(arguments)?;
        let run = self
            .enqueue_run(&args.automation_id, None, RunSource::Manual { origin })
            .await?;
        let data = serde_json::to_value(&run)
            .map_err(|error| ControlError::internal(error.to_string()))?;
        Ok((data, vec![ControlDomain::Runs]))
    }

    async fn delete_automation(
        &self,
        request: &ControlExecuteRequest,
    ) -> Result<(Value, Vec<ControlDomain>), ControlError> {
        let args: registry::AutomationRefArgs = decode_arguments(&request.arguments)?;
        require_revision(request)?;
        let automation_id = args.automation_id.clone();
        let deleted_id = automation_id.clone();
        self.mutate(move |state, _now| {
            let index = state
                .automations
                .iter()
                .position(|automation| automation.id == deleted_id)
                .ok_or_else(|| ControlError::resource_not_found("automation", &deleted_id))?;
            require_revision_for(request, &state.automations[index])?;
            state.automations.remove(index);
            // Run history is retained for inspection.
            Ok(((), vec![ControlDomain::Automations]))
        })
        .await?;
        let _ = &automation_id;
        Ok((
            json!({ "ok": true, "message": "automation deleted", "id": automation_id }),
            vec![ControlDomain::Automations],
        ))
    }

    async fn validate_against_daemon(
        &self,
        deps: &ControlDeps<'_>,
        target: &falcondeck_core::control::AutomationTarget,
        required_connectors: &[String],
    ) -> Result<(), ControlError> {
        let Some(app) = deps.app else {
            return Ok(());
        };
        if !std::path::Path::new(&target.workspace_path).is_dir() {
            return Err(ControlError::workspace_unavailable(&target.workspace_path));
        }
        if !app.is_known_provider(&target.provider).await {
            return Err(ControlError::provider_unavailable(target.provider.as_str()));
        }
        for connector in required_connectors {
            let available = crate::connectors::load_mcp_servers(
                &target.workspace_path,
                target.provider.as_str(),
            );
            let known = available.iter().any(|server| server.name == *connector)
                || connector == crate::connectors::BUILTIN_CONNECTOR_NAME;
            if !known {
                return Err(ControlError::connector_unavailable(connector));
            }
        }
        Ok(())
    }

    /// Queues a run for an automation, respecting its concurrency policy.
    /// `scheduled_for` carries the occurrence time for scheduler dispatches;
    /// manual runs pass `None` and never consume a schedule occurrence.
    #[allow(clippy::too_many_lines)]
    pub async fn enqueue_run(
        &self,
        automation_id: &str,
        scheduled_for: Option<DateTime<Utc>>,
        source: RunSource,
    ) -> Result<AutomationRun, ControlError> {
        let _ = source;
        let automation_id = automation_id.to_string();
        self.mutate(move |state, now| {
            let automation = state
                .automations
                .iter()
                .find(|automation| automation.id == automation_id)
                .ok_or_else(|| ControlError::resource_not_found("automation", &automation_id))?
                .clone();
            if !matches!(
                automation.state,
                AutomationState::Enabled | AutomationState::Paused
            ) {
                return Err(ControlError::invalid_arguments(format!(
                    "automation {} is {} and cannot run",
                    automation.id,
                    state_name(automation.state)
                )));
            }
            let active = state
                .runs
                .iter()
                .filter(|run| {
                    run.automation_id == automation.id && run.status == AutomationRunStatus::Running
                })
                .count();
            let queued = state
                .runs
                .iter()
                .filter(|run| {
                    run.automation_id == automation.id && run.status == AutomationRunStatus::Queued
                })
                .count();
            let disposition =
                automations::overlap_disposition(active, queued, automation.concurrency_policy);
            let mut run = AutomationRun {
                id: format!("run-{}", Uuid::new_v4().simple()),
                automation_id: automation.id.clone(),
                automation_name: automation.name.clone(),
                automation_revision: automation.revision,
                status: AutomationRunStatus::Queued,
                scheduled_for,
                queued_at: now,
                started_at: None,
                finished_at: None,
                runtime_workspace_id: None,
                thread_id: None,
                turn_id: None,
                outcome_preview: None,
                error: None,
            };
            match disposition {
                automations::OverlapDisposition::Start => {}
                automations::OverlapDisposition::Queue => {
                    run.outcome_preview = Some("Queued behind the active occurrence".to_string());
                }
                automations::OverlapDisposition::Skip => {
                    run.status = AutomationRunStatus::SkippedOverlap;
                    run.finished_at = Some(now);
                    run.outcome_preview = Some(
                        "Occurrence skipped because a previous occurrence is still active"
                            .to_string(),
                    );
                }
            }
            state.runs.push(run.clone());
            if let Some(occurrence) = scheduled_for {
                // Scheduler dispatch: consume this occurrence and advance.
                let mut dispatched: BTreeSet<String> =
                    state.occurrence_keys.iter().cloned().collect();
                if let Some(automation_mut) = state
                    .automations
                    .iter_mut()
                    .find(|automation| automation.id == automation_id)
                {
                    let key = occurrence_key_for(&automation_mut.trigger, occurrence);
                    if let Some(key) = key {
                        let scoped = format!("{}:{}", automation_mut.id, key);
                        dispatched.insert(scoped.clone());
                        state.occurrence_keys.push(scoped);
                    }
                    let next = automations::advance_after(automation_mut, now, &dispatched)?;
                    automation_mut.next_run_at = next.map(|next| next.at);
                    automation_mut.last_run_at = Some(now);
                }
            }
            Ok((run, vec![ControlDomain::Runs, ControlDomain::Automations]))
        })
        .await
        .map(|(run, _)| run)
    }

    /// Moves a queued run into the running state, capturing the resolved
    /// workspace and thread.
    pub async fn mark_run_running(
        &self,
        run_id: &str,
        runtime_workspace_id: &str,
        thread_id: &str,
    ) -> Result<(), ControlError> {
        let run_id = run_id.to_string();
        self.mutate(move |state, now| {
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.id == run_id)
                .ok_or_else(|| ControlError::resource_not_found("run", &run_id))?;
            run.status = AutomationRunStatus::Running;
            run.started_at = Some(now);
            run.runtime_workspace_id = Some(runtime_workspace_id.to_string());
            run.thread_id = Some(thread_id.to_string());
            Ok(((), vec![ControlDomain::Runs]))
        })
        .await
        .map(|((), _)| ())
    }

    /// Records a turn id on a running run.
    pub async fn record_run_turn(&self, run_id: &str, turn_id: &str) -> Result<(), ControlError> {
        let run_id = run_id.to_string();
        self.mutate(move |state, _now| {
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.id == run_id)
                .ok_or_else(|| ControlError::resource_not_found("run", &run_id))?;
            run.turn_id = Some(turn_id.to_string());
            Ok(((), vec![ControlDomain::Runs]))
        })
        .await
        .map(|((), _)| ())
    }

    /// Finishes a run, updates the automation's latest outcome and completes
    /// one-time automations after their execution attempt.
    pub async fn finish_run(
        &self,
        run_id: &str,
        status: AutomationRunStatus,
        preview: Option<String>,
        error: Option<ControlErrorDetail>,
    ) -> Result<(), ControlError> {
        let run_id = run_id.to_string();
        self.mutate(move |state, now| {
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.id == run_id)
                .ok_or_else(|| ControlError::resource_not_found("run", &run_id))?;
            run.status = status;
            run.finished_at = Some(now);
            run.outcome_preview = preview.as_deref().map(store::bounded_preview);
            run.error = error.map(store::bounded_error_detail);
            let automation_id = run.automation_id.clone();
            let summary = run
                .outcome_preview
                .clone()
                .or_else(|| run.error.as_ref().map(|error| error.message.clone()));
            if let Some(automation) = state
                .automations
                .iter_mut()
                .find(|automation| automation.id == automation_id)
            {
                automation.last_run_at = Some(now);
                automation.latest_outcome =
                    Some(falcondeck_core::control::AutomationOutcomeSummary {
                        status,
                        finished_at: now,
                        preview: summary.map(|preview| store::bounded_preview(&preview)),
                    });
                // One-time automations complete after an execution attempt,
                // successful or not.
                if matches!(
                    automation.trigger,
                    falcondeck_core::control::AutomationTrigger::Once { .. }
                ) && automation.state == AutomationState::Enabled
                {
                    automation.state = AutomationState::Completed;
                    automation.next_run_at = None;
                    automation.updated_at = now;
                    automation.revision += 1;
                }
            }
            Ok(((), vec![ControlDomain::Runs, ControlDomain::Automations]))
        })
        .await
        .map(|((), _)| ())
    }

    /// Marks a run skipped because a required dependency was unavailable at
    /// execution time.
    pub async fn skip_run_dependency(
        &self,
        run_id: &str,
        connector: &str,
    ) -> Result<(), ControlError> {
        let run_id = run_id.to_string();
        let connector = connector.to_string();
        self.mutate(move |state, now| {
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.id == run_id)
                .ok_or_else(|| ControlError::resource_not_found("run", &run_id))?;
            run.status = AutomationRunStatus::SkippedDependency;
            run.finished_at = Some(now);
            run.outcome_preview = Some(format!("Required connector {connector:?} is unavailable"));
            Ok(((), vec![ControlDomain::Runs]))
        })
        .await
        .map(|((), _)| ())
    }

    /// Fails a queued or running run when dispatch itself errors.
    pub async fn fail_run(&self, run_id: &str, message: &str) -> Result<(), ControlError> {
        self.finish_run(
            run_id,
            AutomationRunStatus::Failed,
            Some(message.to_string()),
            Some(ControlError::execution_failed(message.to_string()).0),
        )
        .await
    }

    /// The earliest next run across dispatchable automations.
    pub async fn next_due_at(&self) -> Option<DateTime<Utc>> {
        let state = self.state.lock().await;
        state
            .automations
            .iter()
            .filter(|automation| automations::is_dispatchable(automation.state))
            .filter_map(|automation| automation.next_run_at)
            .min()
    }

    /// Queued run ids for the scheduler to dispatch, oldest first.
    pub async fn queued_runs(&self) -> Vec<String> {
        let state = self.state.lock().await;
        let mut runs: Vec<&AutomationRun> = state
            .runs
            .iter()
            .filter(|run| run.status == AutomationRunStatus::Queued)
            .collect();
        runs.sort_by(|a, b| a.queued_at.cmp(&b.queued_at).then(a.id.cmp(&b.id)));
        runs.iter().map(|run| run.id.clone()).collect()
    }

    /// Automation ids whose `next_run_at` is due, in due order.
    pub async fn due_automations(&self, now: DateTime<Utc>) -> Vec<(String, DateTime<Utc>)> {
        let state = self.state.lock().await;
        let mut due: Vec<(String, DateTime<Utc>)> = state
            .automations
            .iter()
            .filter(|automation| automations::is_dispatchable(automation.state))
            .filter_map(|automation| {
                automation
                    .next_run_at
                    .filter(|next| *next <= now)
                    .map(|next| (automation.id.clone(), next))
            })
            .collect();
        due.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
        due
    }

    /// Snapshot of one automation, for the dispatcher.
    pub async fn automation(&self, automation_id: &str) -> Option<Automation> {
        self.state
            .lock()
            .await
            .automations
            .iter()
            .find(|automation| automation.id == automation_id)
            .cloned()
    }

    /// Snapshot of one run, for the dispatcher and event observers.
    pub async fn run(&self, run_id: &str) -> Option<AutomationRun> {
        self.state
            .lock()
            .await
            .runs
            .iter()
            .find(|run| run.id == run_id)
            .cloned()
    }

    /// Current store revision, for event payloads.
    pub async fn store_revision(&self) -> u64 {
        self.state.lock().await.store_revision
    }

    /// Snapshot of the current agent-control settings.
    pub async fn settings_snapshot(&self) -> AgentControlSettings {
        self.state.lock().await.settings.clone()
    }

    /// Persists a managed automation's native thread id. The definition
    /// revision increments because this is a durable change, but the store
    /// change is internal: it never rewrites the schedule.
    pub async fn set_managed_thread(
        &self,
        automation_id: &str,
        thread_id: &str,
    ) -> Result<(), ControlError> {
        let automation_id = automation_id.to_string();
        let thread_id = thread_id.to_string();
        self.mutate(move |state, now| {
            let automation = state
                .automations
                .iter_mut()
                .find(|automation| automation.id == automation_id)
                .ok_or_else(|| ControlError::resource_not_found("automation", &automation_id))?;
            let already = matches!(
                &automation.target.thread,
                falcondeck_core::control::AutomationThreadTarget::Managed {
                    thread_id: Some(existing),
                } if *existing == thread_id
            );
            if already {
                return Ok(((), vec![]));
            }
            automation.target.thread = falcondeck_core::control::AutomationThreadTarget::Managed {
                thread_id: Some(thread_id),
            };
            automation.updated_at = now;
            automation.revision += 1;
            Ok(((), vec![ControlDomain::Automations]))
        })
        .await
        .map(|((), _)| ())
    }

    /// Wakes the scheduler after definition or run changes.
    pub fn notify_scheduler(&self) {
        self.scheduler_notify.notify_one();
    }

    /// Awaits the next scheduler wake-up.
    pub async fn scheduler_notified(&self) {
        self.scheduler_notify.notified().await;
    }

    /// The run-slot semaphore shared by all dispatched runs.
    pub fn run_slots(&self) -> &Semaphore {
        &self.run_slots
    }

    /// Marks the scheduler as started; returns false when it already runs.
    pub fn mark_scheduler_started(&self) -> bool {
        !self.scheduler_started.swap(true, Ordering::AcqRel)
    }

    async fn mutate<F, T>(&self, mutation: F) -> Result<(T, Vec<ControlDomain>), ControlError>
    where
        F: FnOnce(
            &mut store::PersistedControlState,
            DateTime<Utc>,
        ) -> Result<(T, Vec<ControlDomain>), ControlError>,
    {
        let _guard = self.mutation.lock().await;
        self.ensure_usable()?;
        let now = Utc::now();
        let mut next = self.state.lock().await.clone();
        let outcome = mutation(&mut next, now)?;
        next.store_revision += 1;
        store::compact(&mut next, now);
        store::persist(&self.path, &next).await?;
        *self.state.lock().await = next;
        self.scheduler_notify.notify_one();
        Ok(outcome)
    }

    async fn append_audit(&self, entry: ControlAuditEntry) -> Result<(), ControlError> {
        self.mutate(|state, _now| {
            state.audit.push(entry.clone());
            Ok(((), vec![ControlDomain::Audit]))
        })
        .await
        .map(|((), _)| ())
    }

    async fn record_idempotency(
        &self,
        record: store::IdempotencyRecord,
    ) -> Result<(), ControlError> {
        self.mutate(|state, _now| {
            state
                .idempotency_records
                .retain(|existing| !(existing.key == record.key && existing.scope == record.scope));
            state.idempotency_records.push(record.clone());
            Ok(((), vec![]))
        })
        .await
        .map(|((), _)| ())
    }
}

fn state_name(state: AutomationState) -> &'static str {
    match state {
        AutomationState::Enabled => "enabled",
        AutomationState::Paused => "paused",
        AutomationState::Completed => "completed",
        AutomationState::Failed => "failed",
    }
}

/// Reconstructs the stable occurrence key for a dispatched instant. Keys
/// match what [`automations::next_occurrence`] computed: the local wall
/// clock for cron schedules, the timestamp for intervals and RFC 3339 for
/// one-time triggers.
fn occurrence_key_for(
    trigger: &falcondeck_core::control::AutomationTrigger,
    occurrence: DateTime<Utc>,
) -> Option<String> {
    use falcondeck_core::control::AutomationTrigger;
    match trigger {
        AutomationTrigger::Once { .. } => Some(occurrence.to_rfc3339()),
        AutomationTrigger::Interval { .. } => Some(occurrence.timestamp().to_string()),
        AutomationTrigger::Cron { timezone, .. } => {
            let tz = automations::parse_timezone(timezone).ok()?;
            let local = occurrence.with_timezone(&tz).naive_local();
            Some(format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}",
                local.year(),
                local.month(),
                local.day(),
                local.hour(),
                local.minute()
            ))
        }
    }
}

fn automation_value(automation: &Automation) -> Value {
    let mut value =
        serde_json::to_value(automation).unwrap_or_else(|_| json!({ "id": automation.id }));
    if let Some(map) = value.as_object_mut() {
        map.insert(
            "resolved_schedule".to_string(),
            json!(automations::schedule_summary(&automation.trigger)),
        );
    }
    value
}

fn decode_arguments<T: serde::de::DeserializeOwned>(
    arguments: &serde_json::Map<String, Value>,
) -> Result<T, ControlError> {
    serde_json::from_value(Value::Object(arguments.clone())).map_err(|error| {
        ControlError::invalid_arguments(format!(
            "arguments do not match the operation schema: {error}"
        ))
        .with_suggested_action("Call falcondeck_search with detail full to see the schema.")
    })
}

fn require_revision(request: &ControlExecuteRequest) -> Result<u64, ControlError> {
    request
        .expected_revision
        .ok_or_else(ControlError::revision_required)
}

fn require_revision_for(
    request: &ControlExecuteRequest,
    automation: &Automation,
) -> Result<(), ControlError> {
    let expected = require_revision(request)?;
    if expected != automation.revision {
        return Err(ControlError::revision_conflict(
            expected,
            automation.revision,
            &automation.id,
        ));
    }
    Ok(())
}

fn idempotency_scope(context: &ControlRequestContext, operation: &str) -> String {
    format!(
        "{}|{}|{}",
        origin_token(context),
        context
            .provider
            .as_ref()
            .map(|provider| provider.as_str())
            .unwrap_or("-"),
        operation
    )
}

fn origin_token(context: &ControlRequestContext) -> &'static str {
    match context.origin {
        ControlOrigin::DesktopUi => "desktop_ui",
        ControlOrigin::Mcp => "mcp",
        ControlOrigin::RemoteRpc => "remote_rpc",
        ControlOrigin::Scheduler => "scheduler",
        ControlOrigin::System => "system",
    }
}

fn arguments_hash(arguments: &serde_json::Map<String, Value>) -> u64 {
    use std::hash::{Hash, Hasher};
    let canonical = serde_json::to_string(arguments).unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    canonical.hash(&mut hasher);
    hasher.finish()
}

fn resource_type(operation: &str) -> &'static str {
    if operation.starts_with("automation.") {
        "automation"
    } else if operation.starts_with("agent_control.") {
        "agent_control"
    } else {
        "control"
    }
}

fn audit_summary(request: &ControlExecuteRequest, response: &ControlExecuteResponse) -> String {
    // Redacted summaries only: never instruction bodies.
    let automation_id = request
        .arguments
        .get("automation_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            response
                .data
                .as_ref()
                .and_then(|data| data.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let name = response
        .data
        .as_ref()
        .and_then(|data| data.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let subject = match (&automation_id, &name) {
        (Some(id), Some(name)) => format!("{name} ({id})"),
        (Some(id), None) => id.clone(),
        (None, Some(name)) => name.clone(),
        (None, None) => String::new(),
    };
    let verb = match request.operation.as_str() {
        ops::SETTINGS_UPDATE => "Updated agent control settings",
        ops::AUTOMATION_CREATE => "Created automation",
        ops::AUTOMATION_UPDATE => "Updated automation",
        ops::AUTOMATION_PAUSE => "Paused automation",
        ops::AUTOMATION_RESUME => "Resumed automation",
        ops::AUTOMATION_RUN_NOW => "Ran automation",
        ops::AUTOMATION_DELETE => "Deleted automation",
        _ => "Executed operation",
    };
    if response.ok {
        if subject.is_empty() {
            verb.to_string()
        } else {
            format!("{verb} {subject}")
        }
    } else {
        let code = response
            .error
            .as_ref()
            .map(|error| error.code.as_str())
            .unwrap_or("unknown");
        if subject.is_empty() {
            format!("Failed: {verb} ({code})")
        } else {
            format!("Failed: {verb} {subject} ({code})")
        }
    }
}

fn list_automations(
    state: &store::PersistedControlState,
    request: &ControlGetRequest,
    limit: usize,
) -> Result<ControlGetResponse, ControlError> {
    let mut rows: Vec<(&Automation, Value)> = state
        .automations
        .iter()
        .map(|automation| {
            (
                automation,
                serde_json::to_value(automation).unwrap_or(Value::Null),
            )
        })
        .filter(|(_, row)| row.is_object())
        .filter(|(_, row)| {
            request
                .filters
                .iter()
                .all(|(field, expected)| filter_row(row, field, expected))
        })
        .collect();
    // Stable ordering: updated_at descending, id ascending.
    rows.sort_by(|(a, _), (b, _)| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    let page = paginate(rows, &request.cursor, limit, |(automation, _)| {
        (automation.updated_at.to_rfc3339(), automation.id.clone())
    })?;
    let data: Vec<Value> = page
        .rows
        .iter()
        .map(|(automation, row)| {
            let mut projected = if request.fields.is_empty() {
                store::project_automation_list_row(row)
            } else {
                store::project_fields(row, &request.fields)
            };
            if let Some(map) = projected.as_object_mut() {
                map.insert(
                    "resolved_schedule".to_string(),
                    json!(automations::schedule_summary(&automation.trigger)),
                );
            }
            redaction::redacted(projected)
        })
        .collect();
    Ok(ControlGetResponse {
        resource: "automations".to_string(),
        data: Value::Array(data),
        next_cursor: page.next_cursor,
    })
}

fn list_runs(
    state: &store::PersistedControlState,
    request: &ControlGetRequest,
    limit: usize,
) -> Result<ControlGetResponse, ControlError> {
    let automation_id = request.id.clone().or_else(|| {
        request
            .filters
            .get("automation_id")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    if request.resource == "automation.runs"
        && automation_id.is_none()
        && !request.filters.is_empty()
    {
        return Err(ControlError::invalid_arguments(
            "automation.runs requires an automation id or an automation_id filter",
        ));
    }
    let mut rows: Vec<(&AutomationRun, Value)> = state
        .runs
        .iter()
        .filter(|run| {
            automation_id
                .as_deref()
                .is_none_or(|id| run.automation_id == id)
        })
        .map(|run| (run, serde_json::to_value(run).unwrap_or(Value::Null)))
        .filter(|(_, row)| row.is_object())
        .filter(|(_, row)| {
            request
                .filters
                .iter()
                .all(|(field, expected)| filter_row(row, field, expected))
        })
        .collect();
    rows.sort_by(|(a, _), (b, _)| b.queued_at.cmp(&a.queued_at).then(a.id.cmp(&b.id)));
    let page = paginate(rows, &request.cursor, limit, |(run, _)| {
        (run.queued_at.to_rfc3339(), run.id.clone())
    })?;
    let data: Vec<Value> = page
        .rows
        .iter()
        .map(|(_, row)| {
            let projected = if request.fields.is_empty() {
                (*row).clone()
            } else {
                store::project_fields(row, &request.fields)
            };
            redaction::redacted(projected)
        })
        .collect();
    Ok(ControlGetResponse {
        resource: "automation.runs".to_string(),
        data: Value::Array(data),
        next_cursor: page.next_cursor,
    })
}

fn list_audit(
    state: &store::PersistedControlState,
    request: &ControlGetRequest,
    limit: usize,
) -> Result<ControlGetResponse, ControlError> {
    let mut rows: Vec<(&ControlAuditEntry, Value)> = state
        .audit
        .iter()
        .map(|entry| (entry, serde_json::to_value(entry).unwrap_or(Value::Null)))
        .filter(|(_, row)| row.is_object())
        .filter(|(_, row)| {
            request
                .filters
                .iter()
                .all(|(field, expected)| filter_row(row, field, expected))
        })
        .collect();
    rows.sort_by(|(a, _), (b, _)| b.occurred_at.cmp(&a.occurred_at).then(a.id.cmp(&b.id)));
    let page = paginate(rows, &request.cursor, limit, |(entry, _)| {
        (entry.occurred_at.to_rfc3339(), entry.id.clone())
    })?;
    let data: Vec<Value> = page
        .rows
        .iter()
        .map(|(_, row)| {
            let projected = if request.fields.is_empty() {
                (*row).clone()
            } else {
                store::project_fields(row, &request.fields)
            };
            redaction::redacted(projected)
        })
        .collect();
    Ok(ControlGetResponse {
        resource: "control.audit".to_string(),
        data: Value::Array(data),
        next_cursor: page.next_cursor,
    })
}

fn filter_row(row: &Value, field: &str, expected: &Value) -> bool {
    let actual = match field {
        "provider" => row
            .get("target")
            .and_then(|target| target.get("provider"))
            .and_then(Value::as_str),
        "origin" => row
            .get("context")
            .and_then(|context| context.get("origin"))
            .and_then(Value::as_str),
        other => row.get(other).and_then(Value::as_str),
    };
    store::filter_matches(expected, actual)
}

struct Page<T> {
    rows: Vec<T>,
    next_cursor: Option<String>,
}

/// Cursor pagination over rows already sorted by (key descending, id
/// ascending). The cursor encodes the last emitted tuple; the next page
/// starts strictly after it, so removed rows never re-serve entries.
fn paginate<T, F>(
    rows: Vec<T>,
    cursor: &Option<String>,
    limit: usize,
    key: F,
) -> Result<Page<T>, ControlError>
where
    F: Fn(&T) -> (String, String),
{
    let mut start = 0;
    if let Some(cursor) = cursor {
        let (cursor_key, cursor_id) = store::decode_cursor(cursor)
            .ok_or_else(|| ControlError::invalid_arguments("cursor is not a valid page cursor"))?;
        start = rows
            .iter()
            .position(|row| {
                let (row_key, row_id) = key(row);
                // After the cursor tuple in (key desc, id asc) order.
                row_key < cursor_key || (row_key == cursor_key && row_id > cursor_id)
            })
            .unwrap_or(rows.len());
    }
    let mut page_rows: Vec<T> = rows.into_iter().skip(start).collect();
    let has_more = page_rows.len() > limit;
    page_rows.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            page_rows
                .last()
                .map(|row| {
                    let (row_key, row_id) = key(row);
                    store::encode_cursor(&row_key, &row_id)
                })
                .unwrap_or_default()
        })
        .filter(|cursor| !cursor.is_empty());
    Ok(Page {
        rows: page_rows,
        next_cursor,
    })
}
