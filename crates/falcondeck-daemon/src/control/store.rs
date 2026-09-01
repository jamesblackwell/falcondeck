//! Persisted control state: settings, automations, bounded run history,
//! audit entries, idempotency records and dispatched occurrence keys.
//!
//! The store lives beside the daemon state file as `agent-control.json`,
//! written atomically with restrictive permissions. Definitions are durable;
//! operational data is bounded per PRD §12.4. A malformed file is preserved
//! under a timestamped recovery name and leaves the service disabled until
//! the user resolves the problem, rather than being silently replaced.

use std::path::{Path, PathBuf};

use base64::Engine;
use chrono::{DateTime, Utc};
use falcondeck_core::control::{
    AgentControlSettings, Automation, AutomationRun, AutomationRunStatus, ControlAuditEntry,
    ControlErrorDetail,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::ControlError;
use super::redaction;

/// Current control store schema version.
pub const SCHEMA_VERSION: u32 = 1;
/// Run records retained per automation.
pub const RUNS_PER_AUTOMATION: usize = 100;
/// Total run records retained.
pub const TOTAL_RUNS: usize = 1_000;
/// Audit entries retained.
pub const AUDIT_LIMIT: usize = 500;
/// Idempotency records retained.
pub const IDEMPOTENCY_LIMIT: usize = 128;
/// Idempotency record lifetime.
pub const IDEMPOTENCY_TTL: chrono::Duration = chrono::Duration::hours(24);
/// Occurrence keys retained (per store; keys are automation-scoped strings).
const OCCURRENCE_KEYS_LIMIT: usize = 512;
/// Maximum store size accepted on load.
const MAX_STORE_BYTES: u64 = 8 * 1024 * 1024;

/// The complete persisted control state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersistedControlState {
    /// Store schema version.
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    /// Monotonic revision of the whole store; increments on each mutation.
    #[serde(default)]
    pub store_revision: u64,
    /// Agent-control settings.
    #[serde(default)]
    pub settings: AgentControlSettings,
    /// Automation definitions.
    #[serde(default)]
    pub automations: Vec<Automation>,
    /// Bounded run history.
    #[serde(default)]
    pub runs: Vec<AutomationRun>,
    /// Bounded audit trail.
    #[serde(default)]
    pub audit: Vec<ControlAuditEntry>,
    /// Bounded idempotency records.
    #[serde(default)]
    pub idempotency_records: Vec<IdempotencyRecord>,
    /// Dispatched occurrence keys, so ambiguous local times and misfire
    /// replays cannot dispatch the same occurrence twice.
    #[serde(default)]
    pub occurrence_keys: Vec<String>,
}

fn default_schema_version() -> u32 {
    SCHEMA_VERSION
}

/// One remembered idempotent execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IdempotencyRecord {
    /// Caller-supplied key.
    pub key: String,
    /// Scope string: origin, provider and operation.
    pub scope: String,
    /// Hash of the canonical arguments JSON.
    pub arguments_hash: u64,
    /// The response that was returned.
    pub response: Value,
    /// When the record was created.
    pub created_at: DateTime<Utc>,
}

/// Why a store could not be loaded.
#[derive(Debug)]
pub enum LoadFailure {
    /// The file exists but does not parse or validate.
    Malformed { error: String },
    /// The file declares a schema version this daemon cannot read.
    UnsupportedVersion { version: u32 },
    /// The file exceeds the size limit.
    TooLarge { bytes: u64 },
}

impl Default for PersistedControlState {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            store_revision: 0,
            settings: default_settings(),
            automations: Vec::new(),
            runs: Vec::new(),
            audit: Vec::new(),
            idempotency_records: Vec::new(),
            occurrence_keys: Vec::new(),
        }
    }
}

fn default_settings() -> AgentControlSettings {
    let mut settings = AgentControlSettings::default();
    // The product default timezone is the host's IANA zone, never a fixed
    // UTC offset.
    if let Ok(zone) = iana_time_zone::get_timezone()
        && !zone.trim().is_empty()
        && zone.parse::<chrono_tz::Tz>().is_ok()
    {
        settings.default_timezone = zone;
    }
    settings
}

/// Path of the control store for a given daemon state path.
pub fn control_store_path(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("agent-control.json")
}

/// Loads the store. A missing file yields defaults; a broken file yields a
/// [`LoadFailure`] and is left untouched.
pub async fn load(path: &Path) -> Result<PersistedControlState, LoadFailure> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PersistedControlState::default());
        }
        Err(error) => {
            return Err(LoadFailure::Malformed {
                error: format!("failed to read {}: {error}", path.display()),
            });
        }
    };
    if metadata.len() > MAX_STORE_BYTES {
        return Err(LoadFailure::TooLarge {
            bytes: metadata.len(),
        });
    }
    let contents =
        tokio::fs::read_to_string(path)
            .await
            .map_err(|error| LoadFailure::Malformed {
                error: format!("failed to read {}: {error}", path.display()),
            })?;
    let state: PersistedControlState =
        serde_json::from_str(&contents).map_err(|error| LoadFailure::Malformed {
            error: format!("invalid control store JSON: {error}"),
        })?;
    if state.schema_version > SCHEMA_VERSION {
        return Err(LoadFailure::UnsupportedVersion {
            version: state.schema_version,
        });
    }
    Ok(state)
}

/// Atomically writes the store: unique temp file, 0600 permissions, sync,
/// rename. Never partially overwrites the previous file.
pub async fn persist(path: &Path, state: &PersistedControlState) -> Result<(), ControlError> {
    let payload = serde_json::to_vec_pretty(state).map_err(|error| {
        ControlError::internal(format!("failed to encode control state: {error}"))
    })?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| storage_write_error(path, error))?;
    }
    let temp = path.with_extension(format!("json.tmp.{}", uuid::Uuid::new_v4().simple()));
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temp)
        .await
        .map_err(|error| storage_write_error(&temp, error))?;
    use tokio::io::AsyncWriteExt;
    let write_outcome = async {
        file.write_all(&payload).await?;
        file.sync_all().await
    }
    .await;
    if let Err(error) = write_outcome {
        drop(file);
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(storage_write_error(&temp, error));
    }
    drop(file);
    if let Err(error) = tokio::fs::rename(&temp, path).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(storage_write_error(path, error));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
    }
    Ok(())
}

fn storage_write_error(path: &Path, error: std::io::Error) -> ControlError {
    ControlError::storage_unavailable(format!(
        "failed to write control state {}: {error}",
        path.display()
    ))
}

/// Copies a malformed store aside under a timestamped recovery name so the
/// user can repair it while the daemon runs with a fresh, disabled store.
pub async fn preserve_recovery_copy(path: &Path, now: DateTime<Utc>) -> Option<PathBuf> {
    let recovery = path.with_extension(format!("recovery.{}.json", now.format("%Y%m%dT%H%M%S")));
    match tokio::fs::copy(path, &recovery).await {
        Ok(_) => Some(recovery),
        Err(error) => {
            tracing::warn!(
                %error,
                path = %path.display(),
                "failed to preserve malformed control store"
            );
            None
        }
    }
}

/// Applies every retention bound. Runs during mutations and after run
/// completion; order matters only in that per-automation trimming happens
/// before the global cap.
pub fn compact(state: &mut PersistedControlState, now: DateTime<Utc>) {
    for automation_id in state
        .automations
        .iter()
        .map(|a| a.id.clone())
        .collect::<Vec<_>>()
    {
        let mut runs: Vec<&AutomationRun> = state
            .runs
            .iter()
            .filter(|run| run.automation_id == automation_id)
            .collect();
        if runs.len() > RUNS_PER_AUTOMATION {
            // Newest first by (queued_at, id).
            runs.sort_by(|a, b| b.queued_at.cmp(&a.queued_at).then(b.id.cmp(&a.id)));
            let keep: std::collections::BTreeSet<String> = runs
                .into_iter()
                .take(RUNS_PER_AUTOMATION)
                .map(|r| r.id.clone())
                .collect();
            let automation_id = automation_id.clone();
            state
                .runs
                .retain(|run| run.automation_id != automation_id || keep.contains(&run.id));
        }
    }
    if state.runs.len() > TOTAL_RUNS {
        let mut runs = std::mem::take(&mut state.runs);
        runs.sort_by(|a, b| b.queued_at.cmp(&a.queued_at).then(b.id.cmp(&a.id)));
        let keep: std::collections::BTreeSet<String> =
            runs.iter().take(TOTAL_RUNS).map(|r| r.id.clone()).collect();
        runs.retain(|run| keep.contains(&run.id));
        state.runs = runs;
    }
    if state.audit.len() > AUDIT_LIMIT {
        let mut audit = std::mem::take(&mut state.audit);
        audit.sort_by(|a, b| b.occurred_at.cmp(&a.occurred_at).then(b.id.cmp(&a.id)));
        let keep: std::collections::BTreeSet<String> = audit
            .iter()
            .take(AUDIT_LIMIT)
            .map(|a| a.id.clone())
            .collect();
        audit.retain(|entry| keep.contains(&entry.id));
        state.audit = audit;
    }
    state
        .idempotency_records
        .retain(|record| now.signed_duration_since(record.created_at) < IDEMPOTENCY_TTL);
    if state.idempotency_records.len() > IDEMPOTENCY_LIMIT {
        // Oldest records are dropped first.
        state
            .idempotency_records
            .sort_by_key(|record| record.created_at);
        let excess = state.idempotency_records.len() - IDEMPOTENCY_LIMIT;
        state.idempotency_records.drain(..excess);
    }
    if state.occurrence_keys.len() > OCCURRENCE_KEYS_LIMIT {
        let excess = state.occurrence_keys.len() - OCCURRENCE_KEYS_LIMIT;
        state.occurrence_keys.drain(..excess);
    }
}

/// Marks in-flight runs cancelled at restore time.
pub fn cancel_in_flight_runs(state: &mut PersistedControlState, now: DateTime<Utc>) {
    for run in &mut state.runs {
        if !run.status.is_terminal() {
            run.status = AutomationRunStatus::Cancelled;
            run.finished_at = Some(now);
            run.outcome_preview = Some("Daemon stopped before the run completed".to_string());
        }
    }
}

/// Sort tuple column for cursor pagination.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CursorPayload {
    key: String,
    id: String,
}

/// Encodes an opaque cursor from a stable sort tuple.
pub fn encode_cursor(key: &str, id: &str) -> String {
    let payload = CursorPayload {
        key: key.to_string(),
        id: id.to_string(),
    };
    let json = serde_json::to_string(&payload).unwrap_or_default();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

/// Decodes a cursor produced by [`encode_cursor`].
pub fn decode_cursor(cursor: &str) -> Option<(String, String)> {
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .ok()?;
    let payload = serde_json::from_slice::<CursorPayload>(&json).ok()?;
    Some((payload.key, payload.id))
}

/// Default projection for automation list rows (PRD §30.1). The full
/// instruction is omitted.
pub const DEFAULT_AUTOMATION_LIST_FIELDS: &[&str] = &[
    "id",
    "revision",
    "owner",
    "name",
    "state",
    "trigger",
    "target.provider",
    "target.workspace_path",
    "elevated",
    "required_connectors",
    "concurrency_policy",
    "misfire_policy",
    "next_run_at",
    "last_run_at",
    "latest_outcome",
];

/// Reads a dotted path out of a JSON value.
pub fn dotted_get<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

/// Projects `fields` (dotted paths) out of a row, rebuilding nested objects
/// for dotted paths. Empty `fields` returns the row unchanged.
pub fn project_fields(row: &Value, fields: &[String]) -> Value {
    if fields.is_empty() {
        return row.clone();
    }
    let mut projected = serde_json::Map::new();
    for field in fields {
        if let Some(value) = dotted_get(row, field) {
            insert_dotted(&mut projected, field, value.clone());
        }
    }
    Value::Object(projected)
}

fn insert_dotted(map: &mut serde_json::Map<String, Value>, path: &str, value: Value) {
    match path.split_once('.') {
        None => {
            map.insert(path.to_string(), value);
        }
        Some((head, tail)) => {
            let entry = map
                .entry(head.to_string())
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            if let Value::Object(nested) = entry {
                insert_dotted(nested, tail, value);
            }
        }
    }
}

/// Projects with the default automation list projection.
pub fn project_automation_list_row(row: &Value) -> Value {
    let fields: Vec<String> = DEFAULT_AUTOMATION_LIST_FIELDS
        .iter()
        .map(|field| field.to_string())
        .collect();
    project_fields(row, &fields)
}

/// Parses a filter value as a scalar-or-array string match.
pub fn filter_matches(filter: &Value, actual: Option<&str>) -> bool {
    match filter {
        Value::Array(values) => values.iter().any(|value| {
            value
                .as_str()
                .is_some_and(|expected| Some(expected) == actual)
        }),
        Value::String(expected) => actual == Some(expected.as_str()),
        Value::Null => true,
        _ => false,
    }
}

/// Truncates a run outcome preview to the retention bound.
pub fn bounded_preview(text: &str) -> String {
    redaction::bounded_preview(text, 1000)
}

/// Truncates an error message to the retention bound.
pub fn bounded_error_message(text: &str) -> String {
    redaction::bounded_preview(text, 2000)
}

/// Strips a structured error detail down to its bounded wire shape.
pub fn bounded_error_detail(mut detail: ControlErrorDetail) -> ControlErrorDetail {
    detail.message = bounded_error_message(&detail.message);
    detail
}

#[cfg(test)]
mod tests {
    use super::*;
    use falcondeck_core::control::{AuditResult, ControlOrigin, ControlRequestContext};
    use serde_json::json;

    fn automation(id: &str, updated_at: &str) -> Automation {
        serde_json::from_value(json!({
            "id": id,
            "revision": 1,
            "name": format!("Automation {id}"),
            "trigger": {
                "kind": "interval",
                "every_seconds": 3600,
                "anchor_at": "2026-08-16T00:00:00Z",
            },
            "task": {"kind": "prompt", "instruction": "Do the thing."},
            "target": {
                "workspace_path": "/repo",
                "provider": "codex",
                "thread": {"kind": "managed", "thread_id": null},
            },
            "state": "enabled",
            "concurrency_policy": "skip",
            "misfire_policy": "skip",
            "created_at": updated_at,
            "updated_at": updated_at,
            "next_run_at": "2026-08-16T01:00:00Z",
        }))
        .unwrap()
    }

    fn run(id: &str, automation_id: &str, queued_at: &str) -> AutomationRun {
        run_with_status(id, automation_id, queued_at, "succeeded")
    }

    fn run_with_status(
        id: &str,
        automation_id: &str,
        queued_at: &str,
        status: &str,
    ) -> AutomationRun {
        serde_json::from_value(json!({
            "id": id,
            "automation_id": automation_id,
            "automation_name": "Automation",
            "automation_revision": 1,
            "status": status,
            "queued_at": queued_at,
        }))
        .unwrap()
    }

    fn audit(id: &str, occurred_at: &str) -> ControlAuditEntry {
        ControlAuditEntry {
            id: id.to_string(),
            occurred_at: DateTime::parse_from_rfc3339(occurred_at)
                .unwrap()
                .with_timezone(&Utc),
            context: ControlRequestContext {
                origin: ControlOrigin::DesktopUi,
                ..Default::default()
            },
            operation: "automation.create".to_string(),
            resource_type: None,
            resource_id: None,
            result: AuditResult::Success,
            summary: "Created automation".to_string(),
        }
    }

    #[tokio::test]
    async fn missing_store_produces_defaults_with_host_timezone() {
        let dir = tempfile::tempdir().unwrap();
        let state = load(&dir.path().join("absent.json")).await.unwrap();
        assert_eq!(state.schema_version, SCHEMA_VERSION);
        assert!(state.settings.enabled);
        assert!(
            state.settings.default_timezone.contains('/'),
            "default timezone should be an IANA identifier, got {}",
            state.settings.default_timezone
        );
    }

    #[tokio::test]
    async fn round_trip_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-control.json");
        let mut state = PersistedControlState::default();
        state
            .automations
            .push(automation("automation-1", "2026-08-16T10:00:00Z"));
        state.store_revision = 7;
        persist(&path, &state).await.unwrap();
        let reloaded = load(&path).await.unwrap();
        assert_eq!(reloaded, state);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "control store must be 0600");
        }
        // No temp files remain after the rename.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains("tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[tokio::test]
    async fn malformed_file_is_reported_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-control.json");
        std::fs::write(&path, "{not json").unwrap();
        let failure = load(&path).await.unwrap_err();
        assert!(matches!(failure, LoadFailure::Malformed { .. }));
        // The malformed bytes are preserved byte-for-byte.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
        let recovery = preserve_recovery_copy(&path, Utc::now()).await.unwrap();
        assert_eq!(std::fs::read_to_string(&recovery).unwrap(), "{not json");
    }

    #[tokio::test]
    async fn unsupported_schema_version_is_reported_without_recovery_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-control.json");
        std::fs::write(&path, r#"{"schema_version": 99}"#).unwrap();
        assert!(matches!(
            load(&path).await,
            Err(LoadFailure::UnsupportedVersion { version: 99 })
        ));
        // Untouched: a valid future file must never be overwritten or copied
        // aside as if it were garbage.
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"schema_version": 99}"#
        );
    }

    #[tokio::test]
    async fn write_failure_leaves_previous_state_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("agent-control.json");
        let state = PersistedControlState {
            store_revision: 3,
            ..PersistedControlState::default()
        };
        persist(&path, &state).await.unwrap();
        // Point persistence at a directory-as-file to force a write failure.
        let blocker = dir.path().join("blocker");
        std::fs::create_dir_all(&blocker).unwrap();
        let failure = persist(&blocker, &state).await;
        assert!(failure.is_err());
        assert_eq!(load(&path).await.unwrap().store_revision, 3);
    }

    #[test]
    fn compaction_bounds_runs_audit_and_idempotency() {
        let now = Utc::now();
        let mut state = PersistedControlState::default();
        state
            .automations
            .push(automation("automation-1", "2026-08-16T10:00:00Z"));
        for index in 0..(RUNS_PER_AUTOMATION + 20) {
            state.runs.push(run(
                &format!("run-{index:03}"),
                "automation-1",
                "2026-08-16T10:00:00Z",
            ));
        }
        for index in 0..(AUDIT_LIMIT + 10) {
            state
                .audit
                .push(audit(&format!("audit-{index:03}"), "2026-08-16T10:00:00Z"));
        }
        for index in 0..(IDEMPOTENCY_LIMIT + 5) {
            state.idempotency_records.push(IdempotencyRecord {
                key: format!("key-{index:03}"),
                scope: "mcp|codex|automation.create".to_string(),
                arguments_hash: index as u64,
                response: json!({}),
                created_at: now,
            });
        }
        compact(&mut state, now);
        assert_eq!(state.runs.len(), RUNS_PER_AUTOMATION);
        assert_eq!(state.audit.len(), AUDIT_LIMIT);
        assert_eq!(state.idempotency_records.len(), IDEMPOTENCY_LIMIT);
    }

    #[test]
    fn idempotency_records_expire_after_24_hours() {
        let now = Utc::now();
        let mut state = PersistedControlState::default();
        state.idempotency_records.push(IdempotencyRecord {
            key: "fresh".to_string(),
            scope: "scope".to_string(),
            arguments_hash: 1,
            response: json!({}),
            created_at: now - chrono::Duration::hours(2),
        });
        state.idempotency_records.push(IdempotencyRecord {
            key: "stale".to_string(),
            scope: "scope".to_string(),
            arguments_hash: 2,
            response: json!({}),
            created_at: now - chrono::Duration::hours(25),
        });
        compact(&mut state, now);
        assert_eq!(state.idempotency_records.len(), 1);
        assert_eq!(state.idempotency_records[0].key, "fresh");
    }

    #[test]
    fn total_run_cap_spans_automations() {
        let now = Utc::now();
        let mut state = PersistedControlState::default();
        // 15 automations x 80 runs: every automation stays under its
        // per-automation cap, so only the global cap can bound the total.
        for automation_index in 0..15 {
            let automation_id = format!("automation-{automation_index}");
            state
                .automations
                .push(automation(&automation_id, "2026-08-16T10:00:00Z"));
            for index in 0..80 {
                state.runs.push(run(
                    &format!("run-{automation_id}-{index:03}"),
                    &automation_id,
                    "2026-08-16T10:00:00Z",
                ));
            }
        }
        assert_eq!(state.runs.len(), 15 * 80);
        compact(&mut state, now);
        assert_eq!(state.runs.len(), TOTAL_RUNS);
    }

    #[test]
    fn per_automation_cap_binds_before_the_global_cap() {
        let now = Utc::now();
        let mut state = PersistedControlState::default();
        state
            .automations
            .push(automation("automation-a", "2026-08-16T10:00:00Z"));
        for index in 0..600 {
            state.runs.push(run(
                &format!("run-a-{index:03}"),
                "automation-a",
                "2026-08-16T10:00:00Z",
            ));
        }
        compact(&mut state, now);
        assert_eq!(state.runs.len(), RUNS_PER_AUTOMATION);
    }

    #[test]
    fn in_flight_runs_are_cancelled_at_restore() {
        let now = Utc::now();
        let mut state = PersistedControlState::default();
        state.runs.push(run_with_status(
            "run-queued",
            "automation-1",
            "2026-08-16T10:00:00Z",
            "queued",
        ));
        let mut running = run("run-running", "automation-1", "2026-08-16T10:00:00Z");
        running.status = AutomationRunStatus::Running;
        state.runs.push(running);
        state
            .runs
            .push(run("run-done", "automation-1", "2026-08-16T10:00:00Z"));
        cancel_in_flight_runs(&mut state, now);
        assert_eq!(state.runs[0].status, AutomationRunStatus::Cancelled);
        assert_eq!(state.runs[1].status, AutomationRunStatus::Cancelled);
        assert_eq!(state.runs[2].status, AutomationRunStatus::Succeeded);
        assert!(state.runs[0].finished_at.is_some());
    }

    #[test]
    fn cursors_round_trip_opaquely() {
        let cursor = encode_cursor("2026-08-16T14:22:10Z", "automation-9fc78b39");
        let (key, id) = decode_cursor(&cursor).unwrap();
        assert_eq!(key, "2026-08-16T14:22:10Z");
        assert_eq!(id, "automation-9fc78b39");
        assert!(decode_cursor("not-a-cursor").is_none());
    }

    #[test]
    fn field_projection_omits_instructions_in_default_rows() {
        let row = serde_json::to_value(automation("automation-1", "2026-08-16T10:00:00Z")).unwrap();
        let projected = project_automation_list_row(&row);
        assert!(
            projected.get("task").is_none(),
            "instruction is omitted from list rows"
        );
        assert_eq!(projected["id"], json!("automation-1"));
        assert_eq!(projected["target"]["provider"], json!("codex"));
        assert_eq!(projected["next_run_at"], json!("2026-08-16T01:00:00Z"));

        let projected = project_fields(&row, &["id".to_string(), "target.provider".to_string()]);
        assert_eq!(
            projected,
            json!({"id": "automation-1", "target": {"provider": "codex"}})
        );
    }

    #[test]
    fn filters_match_scalars_and_arrays() {
        assert!(filter_matches(&json!("enabled"), Some("enabled")));
        assert!(!filter_matches(&json!("paused"), Some("enabled")));
        assert!(filter_matches(
            &json!(["enabled", "paused"]),
            Some("paused")
        ));
        assert!(!filter_matches(&json!(["paused"]), Some("enabled")));
        assert!(filter_matches(&Value::Null, None));
        assert!(!filter_matches(&json!("enabled"), None));
    }
}
