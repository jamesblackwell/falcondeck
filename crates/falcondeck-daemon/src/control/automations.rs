//! Schedule validation, due-time calculation and automation state rules.
//!
//! Cron triggers use exactly five fields (`minute hour day-of-month month
//! day-of-week`) evaluated in an explicit IANA timezone. Occurrences are
//! resolved as local wall-clock times first and then mapped to UTC through
//! `chrono-tz`, which gives the daylight-saving semantics the product
//! requires: ambiguous local times run once at the earlier instant and
//! nonexistent local times are skipped rather than shifted. The five-field
//! format is deliberately hand-rolled: off-the-shelf cron iterators evaluate
//! fields against the fed datetime in one fixed zone and cannot express
//! "choose the earlier of two instants" or "skip the gap" per occurrence.

use std::collections::BTreeSet;

use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc,
};
use chrono_tz::Tz;
use falcondeck_core::control::{
    Automation, AutomationConcurrencyPolicy, AutomationMisfirePolicy, AutomationRun,
    AutomationRunStatus, AutomationState, AutomationTarget, AutomationTask, AutomationTrigger,
};

use super::ControlError;

/// Minimum seconds between interval runs.
pub const MIN_INTERVAL_SECONDS: u64 = 60;
/// How far ahead a next occurrence may be calculated. Sparse-but-valid
/// schedules (Feb 29) resolve within one leap cycle; anything longer is
/// treated as uncalculable and rejected.
const DAY_SCAN_HORIZON: i64 = 366 * 5;
/// Limits for definition fields (PRD §22.1).
pub const MAX_NAME_CHARS: usize = 120;
pub const MAX_DESCRIPTION_CHARS: usize = 2000;
pub const MAX_INSTRUCTION_CHARS: usize = 32_000;
pub const MAX_MARKER_CHARS: usize = 100;
pub const MAX_REQUIRED_CONNECTORS: usize = 32;
pub const MAX_CONNECTOR_NAME_CHARS: usize = 64;
/// Permission or sandbox modes that count as elevated authority.
const ELEVATED_MODES: [&str; 2] = ["bypassPermissions", "danger-full-access"];

/// Parsed five-field cron expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSpec {
    minutes: BTreeSet<u32>,
    hours: BTreeSet<u32>,
    days_of_month: BTreeSet<u32>,
    months: BTreeSet<u32>,
    days_of_week: BTreeSet<u32>,
    dom_restricted: bool,
    dow_restricted: bool,
}

struct CronField {
    values: BTreeSet<u32>,
    unrestricted: bool,
}

fn parse_names(segment: &str, names: &[&str], offset: u32) -> Option<u32> {
    let normalized = segment.to_ascii_lowercase();
    if normalized.len() < 3 {
        return None;
    }
    names
        .iter()
        .position(|name| normalized.starts_with(name))
        .map(|index| index as u32 + offset)
}

fn parse_field(
    label: &str,
    raw: &str,
    min: u32,
    max: u32,
    names: &[&str],
    name_offset: u32,
) -> Result<CronField, String> {
    let mut values = BTreeSet::new();
    let mut unrestricted = false;
    for item in raw.split(',') {
        let item = item.trim();
        if item.is_empty() {
            return Err(format!("{label} contains an empty list item"));
        }
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => {
                let step: u32 = step
                    .parse()
                    .map_err(|_| format!("{label} step {step:?} is not a number"))?;
                if step == 0 {
                    return Err(format!("{label} step must be at least 1"));
                }
                (range, step)
            }
            None => (item, 1),
        };
        let (start, end) = if range == "*" {
            if step == 1 && raw == "*" {
                unrestricted = true;
            }
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            let start = parse_value(start, names, name_offset)
                .ok_or_else(|| format!("{label} value {start:?} is invalid"))?;
            let end = parse_value(end, names, name_offset)
                .ok_or_else(|| format!("{label} value {end:?} is invalid"))?;
            (start, end)
        } else {
            let value = parse_value(range, names, name_offset)
                .ok_or_else(|| format!("{label} value {range:?} is invalid"))?;
            if step == 1 {
                (value, value)
            } else {
                (value, max)
            }
        };
        if start < min || end > max || start > end {
            return Err(format!(
                "{label} range {start}-{end} is outside {min}-{max}"
            ));
        }
        let mut value = start;
        while value <= end {
            values.insert(value);
            value += step;
        }
    }
    if values.is_empty() {
        return Err(format!("{label} matches no values"));
    }
    Ok(CronField {
        values,
        unrestricted,
    })
}

fn parse_value(segment: &str, names: &[&str], name_offset: u32) -> Option<u32> {
    if let Ok(value) = segment.parse::<u32>() {
        return Some(value);
    }
    parse_names(segment, names, name_offset)
}

const MONTH_NAMES: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const DAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

impl CronSpec {
    /// Parses a five-field cron expression. Six-field expressions (with
    /// seconds) are rejected rather than guessed at.
    pub fn parse(expression: &str) -> Result<Self, String> {
        let fields: Vec<&str> = expression.split_whitespace().collect();
        if fields.len() == 6 {
            return Err(
                "cron expressions must use exactly five fields (seconds fields are not supported)"
                    .to_string(),
            );
        }
        if fields.len() != 5 {
            return Err(format!(
                "cron expressions must use exactly five fields, found {}",
                fields.len()
            ));
        }
        let minutes = parse_field("minute", fields[0], 0, 59, &[], 0)?;
        let hours = parse_field("hour", fields[1], 0, 23, &[], 0)?;
        let days_of_month = parse_field("day of month", fields[2], 1, 31, &[], 0)?;
        let raw_months = parse_field("month", fields[3], 1, 12, &MONTH_NAMES, 1)?;
        let months = BTreeSet::from_iter(raw_months.values.iter().map(|m| m - 1));
        // 7 is an alias for Sunday in classic cron.
        let mut dows = BTreeSet::new();
        let dow_field = parse_field("day of week", fields[4], 0, 7, &DAY_NAMES, 0)?;
        for dow in dow_field.values.iter() {
            dows.insert(if *dow == 7 { 0 } else { *dow });
        }
        Ok(Self {
            minutes: minutes.values,
            hours: hours.values,
            dom_restricted: !days_of_month.unrestricted,
            dow_restricted: !dow_field.unrestricted,
            days_of_month: days_of_month.values,
            months,
            days_of_week: dows,
        })
    }

    fn day_matches(&self, date: NaiveDate) -> bool {
        if !self.months.contains(&(date.month() - 1)) {
            return false;
        }
        let dom_ok = self.days_of_month.contains(&date.day());
        // 0 = Sunday through 6 = Saturday, matching chrono's weekday numbering.
        let dow_ok = self
            .days_of_week
            .contains(&(date.weekday().num_days_from_sunday()));
        match (self.dom_restricted, self.dow_restricted) {
            // Vixie semantics: two restricted fields OR together.
            (true, true) => dom_ok || dow_ok,
            (true, false) => dom_ok,
            (false, true) => dow_ok,
            (false, false) => true,
        }
    }
}

/// The next calculable occurrence of a trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NextOccurrence {
    /// UTC instant the occurrence runs at.
    pub at: DateTime<Utc>,
    /// Stable occurrence key: identical for the two instants an ambiguous
    /// local time resolves to, so a dispatched occurrence cannot repeat.
    pub key: String,
}

/// Parses and validates an IANA timezone identifier.
pub fn parse_timezone(name: &str) -> Result<Tz, ControlError> {
    name.parse::<Tz>()
        .map_err(|_| ControlError::invalid_timezone(name))
}

/// Computes the next cron occurrence strictly after `after`, in `tz`.
///
/// Nonexistent local times (a spring-forward gap) are skipped: the wall
/// clock never exists, so no occurrence is invented. Ambiguous local times
/// (a fall-back fold) resolve to the earlier instant; the occurrence key
/// keeps the second resolution from dispatching again.
pub fn next_cron_occurrence(
    spec: &CronSpec,
    tz: Tz,
    after: DateTime<Utc>,
) -> Option<NextOccurrence> {
    let after_local = after.with_timezone(&tz).naive_local();
    let mut date = after_local.date();
    let hours: Vec<u32> = spec.hours.iter().copied().collect();
    let minutes: Vec<u32> = spec.minutes.iter().copied().collect();
    for _ in 0..DAY_SCAN_HORIZON {
        if spec.day_matches(date) {
            for &hour in &hours {
                for &minute in &minutes {
                    let candidate = date
                        .and_hms_opt(hour, minute, 0)
                        .expect("cron fields are within chrono bounds");
                    if candidate <= after_local {
                        continue;
                    }
                    match tz.from_local_datetime(&candidate) {
                        LocalResult::Single(instant) => {
                            return Some(occurrence(instant.with_timezone(&Utc), candidate));
                        }
                        // Ambiguous: run once, at the earlier instant.
                        LocalResult::Ambiguous(earliest, _) => {
                            return Some(occurrence(earliest.with_timezone(&Utc), candidate));
                        }
                        // Nonexistent: skip this wall-clock occurrence.
                        LocalResult::None => continue,
                    }
                }
            }
        }
        date += Duration::days(1);
    }
    None
}

fn occurrence(at: DateTime<Utc>, wall_clock: NaiveDateTime) -> NextOccurrence {
    NextOccurrence {
        key: format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}",
            wall_clock.year(),
            wall_clock.month(),
            wall_clock.day(),
            wall_clock.hour(),
            wall_clock.minute()
        ),
        at,
    }
}

/// Computes the next occurrence of any trigger strictly after `after`.
pub fn next_occurrence(
    trigger: &AutomationTrigger,
    after: DateTime<Utc>,
) -> Result<Option<NextOccurrence>, ControlError> {
    match trigger {
        AutomationTrigger::Once { run_at } => {
            if *run_at > after {
                Ok(Some(NextOccurrence {
                    at: *run_at,
                    key: run_at.to_rfc3339(),
                }))
            } else {
                Ok(None)
            }
        }
        AutomationTrigger::Cron {
            expression,
            timezone,
        } => {
            let tz = parse_timezone(timezone).map_err(|error| {
                let message = error.0.message.clone();
                error.with_field("trigger.timezone", message)
            })?;
            let spec = CronSpec::parse(expression).map_err(|message| {
                ControlError::invalid_schedule(message, Some("trigger.expression"))
            })?;
            Ok(next_cron_occurrence(&spec, tz, after))
        }
        AutomationTrigger::Interval {
            every_seconds,
            anchor_at,
        } => {
            if *every_seconds < MIN_INTERVAL_SECONDS {
                return Err(ControlError::invalid_schedule(
                    format!(
                        "interval triggers must be at least {MIN_INTERVAL_SECONDS} seconds apart"
                    ),
                    Some("trigger.every_seconds"),
                ));
            }
            let anchor = anchor_at.timestamp();
            let every = *every_seconds as i64;
            let mut step = (after.timestamp() - anchor).div_euclid(every) + 1;
            let mut at = anchor + step * every;
            while at <= after.timestamp() {
                step += 1;
                at = anchor + step * every;
            }
            Ok(Some(NextOccurrence {
                at: DateTime::from_timestamp(at, 0)
                    .ok_or_else(|| ControlError::internal("interval arithmetic overflowed"))?,
                key: at.to_string(),
            }))
        }
    }
}

/// Validates a trigger and requires a calculable next occurrence from `now`.
pub fn validate_trigger(
    trigger: &AutomationTrigger,
    now: DateTime<Utc>,
) -> Result<NextOccurrence, ControlError> {
    match trigger {
        AutomationTrigger::Once { run_at } => {
            if *run_at <= now {
                return Err(ControlError::invalid_schedule(
                    "one-time triggers must run in the future",
                    Some("trigger.run_at"),
                )
                .with_suggested_action(
                    "Set trigger.run_at to a future RFC 3339 timestamp with an offset.",
                ));
            }
        }
        AutomationTrigger::Cron { .. } | AutomationTrigger::Interval { .. } => {}
    }
    next_occurrence(trigger, now)?.ok_or_else(|| {
        ControlError::invalid_schedule(
            "the schedule has no calculable next occurrence",
            Some("trigger"),
        )
    })
}

/// Whether captured authority settings count as elevated.
pub fn is_elevated_mode(permission_mode: Option<&str>, sandbox_mode: Option<&str>) -> bool {
    [permission_mode, sandbox_mode]
        .into_iter()
        .flatten()
        .any(|mode| ELEVATED_MODES.contains(&mode))
}

/// Validates every definition-level field that does not need daemon context.
pub fn validate_definition(
    name: &str,
    description: Option<&str>,
    task: &AutomationTask,
    target: &AutomationTarget,
    required_connectors: &[String],
) -> Result<(), ControlError> {
    let char_len = |text: &str| text.chars().count();
    if name.trim().is_empty() || char_len(name) > MAX_NAME_CHARS {
        return Err(ControlError::field(
            "name",
            format!("name must be 1-{MAX_NAME_CHARS} characters"),
        ));
    }
    if let Some(description) = description
        && char_len(description) > MAX_DESCRIPTION_CHARS
    {
        return Err(ControlError::field(
            "description",
            format!("description must be at most {MAX_DESCRIPTION_CHARS} characters"),
        ));
    }
    let instruction = task.instruction();
    if instruction.trim().is_empty() || char_len(instruction) > MAX_INSTRUCTION_CHARS {
        return Err(ControlError::field(
            "task.instruction",
            format!("instruction must be 1-{MAX_INSTRUCTION_CHARS} characters"),
        ));
    }
    if let AutomationTask::ConditionalPrompt {
        no_action_marker, ..
    } = task
        && (no_action_marker.trim().is_empty()
            || char_len(no_action_marker) > MAX_MARKER_CHARS
            || no_action_marker.contains(['\n', '\r']))
    {
        return Err(ControlError::field(
            "task.no_action_marker",
            format!("no-action marker must be 1-{MAX_MARKER_CHARS} characters on a single line"),
        ));
    }
    if !target.workspace_path.starts_with('/') {
        return Err(ControlError::field(
            "target.workspace_path",
            "workspace_path must be an absolute path",
        ));
    }
    if target.provider.as_str().trim().is_empty() {
        return Err(ControlError::field(
            "target.provider",
            "provider must not be empty",
        ));
    }
    if required_connectors.len() > MAX_REQUIRED_CONNECTORS {
        return Err(ControlError::field(
            "required_connectors",
            format!("at most {MAX_REQUIRED_CONNECTORS} connectors may be required"),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for connector in required_connectors {
        if connector.trim().is_empty() || char_len(connector) > MAX_CONNECTOR_NAME_CHARS {
            return Err(ControlError::field(
                "required_connectors",
                format!("connector names must be 1-{MAX_CONNECTOR_NAME_CHARS} characters"),
            ));
        }
        if !seen.insert(connector.clone()) {
            return Err(ControlError::field(
                "required_connectors",
                format!("connector {connector:?} is listed more than once"),
            ));
        }
    }
    Ok(())
}

/// Classifies a finished conditional run from the final assistant text.
pub fn classify_conditional_outcome(
    task: &AutomationTask,
    final_text: Option<&str>,
) -> AutomationRunStatus {
    if let AutomationTask::ConditionalPrompt {
        no_action_marker, ..
    } = task
        && let Some(text) = final_text
        && text.trim() == no_action_marker.trim()
    {
        return AutomationRunStatus::SucceededNoAction;
    }
    AutomationRunStatus::Succeeded
}

/// Advances a recurring automation after a dispatched or missed occurrence,
/// skipping occurrence keys that were already dispatched.
pub fn advance_after(
    automation: &Automation,
    now: DateTime<Utc>,
    dispatched_keys: &std::collections::BTreeSet<String>,
) -> Result<Option<NextOccurrence>, ControlError> {
    let mut search_from = now;
    for _ in 0..64 {
        let Some(next) = next_occurrence(&automation.trigger, search_from)? else {
            return Ok(None);
        };
        let key = format!("{}:{}", automation.id, next.key);
        if !dispatched_keys.contains(&key) {
            return Ok(Some(NextOccurrence {
                at: next.at,
                key: next.key,
            }));
        }
        search_from = next.at + Duration::seconds(1);
    }
    Ok(None)
}

/// Reconcile a definition after daemon downtime per its misfire policy.
/// Returns the next occurrence to dispatch (or skip).
pub fn reconcile_misfire(
    automation: &Automation,
    now: DateTime<Utc>,
    dispatched_keys: &std::collections::BTreeSet<String>,
) -> Result<MisfirePlan, ControlError> {
    let Some(stored_next) = automation.next_run_at else {
        return Ok(MisfirePlan::UpToDate);
    };
    if stored_next > now {
        return Ok(MisfirePlan::UpToDate);
    }
    match automation.misfire_policy {
        AutomationMisfirePolicy::Skip => {
            let next = advance_after(automation, now, dispatched_keys)?;
            Ok(MisfirePlan::Advance(next))
        }
        AutomationMisfirePolicy::RunOnce => {
            // Run one missed occurrence immediately, then continue normally.
            Ok(MisfirePlan::Advance(Some(NextOccurrence {
                at: now,
                key: stored_next.to_rfc3339(),
            })))
        }
    }
}

/// What restore-time reconciliation decided for one automation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MisfirePlan {
    /// `next_run_at` is still in the future; nothing to do.
    UpToDate,
    /// Replace `next_run_at` with this occurrence (or `None` when the
    /// schedule is exhausted).
    Advance(Option<NextOccurrence>),
}

/// Whether an automation accepts dispatch in its current state.
pub fn is_dispatchable(state: AutomationState) -> bool {
    state == AutomationState::Enabled
}

/// Whether a run status counts as occupying the automation's run slot.
pub fn run_is_active(run: &AutomationRun) -> bool {
    matches!(
        run.status,
        AutomationRunStatus::Queued | AutomationRunStatus::Running
    )
}

/// Decides what to do with a due occurrence given active runs and policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlapDisposition {
    /// Dispatch now.
    Start,
    /// Record a queued occurrence, dispatched when the active run finishes.
    Queue,
    /// Record a `skipped_overlap` occurrence.
    Skip,
}

pub fn overlap_disposition(
    active_runs: usize,
    queued_runs: usize,
    policy: AutomationConcurrencyPolicy,
) -> OverlapDisposition {
    if active_runs == 0 {
        return OverlapDisposition::Start;
    }
    match policy {
        AutomationConcurrencyPolicy::Skip => OverlapDisposition::Skip,
        AutomationConcurrencyPolicy::QueueOne => {
            if queued_runs == 0 {
                OverlapDisposition::Queue
            } else {
                OverlapDisposition::Skip
            }
        }
        AutomationConcurrencyPolicy::Allow => OverlapDisposition::Start,
    }
}

/// A short human-readable schedule summary for list rows and responses.
pub fn schedule_summary(trigger: &AutomationTrigger) -> String {
    match trigger {
        AutomationTrigger::Once { run_at } => {
            format!("once at {}", run_at.to_rfc3339())
        }
        AutomationTrigger::Cron {
            expression,
            timezone,
        } => format!("cron \"{expression}\" ({timezone})"),
        AutomationTrigger::Interval { every_seconds, .. } => {
            if *every_seconds % 86400 == 0 {
                format!("every {} days", every_seconds / 86400)
            } else if *every_seconds % 3600 == 0 {
                format!("every {} hours", every_seconds / 3600)
            } else if *every_seconds % 60 == 0 {
                format!("every {} minutes", every_seconds / 60)
            } else {
                format!("every {every_seconds} seconds")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cron(expression: &str) -> CronSpec {
        CronSpec::parse(expression).unwrap()
    }

    fn utc(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn next_utc(spec: &CronSpec, tz: Tz, after: &str) -> String {
        next_cron_occurrence(spec, tz, utc(after))
            .unwrap()
            .at
            .to_rfc3339()
    }

    #[test]
    fn parses_five_field_expressions() {
        let spec = cron("0 8 * * 1-5");
        assert_eq!(spec.minutes, [0].into_iter().collect());
        assert_eq!(spec.hours, [8].into_iter().collect());
        assert!(!spec.dom_restricted);
        assert!(spec.dow_restricted);
    }

    #[test]
    fn rejects_six_field_expressions() {
        let error = CronSpec::parse("0 0 8 * * 1-5").unwrap_err();
        assert!(error.contains("five fields"), "{error}");
        assert!(CronSpec::parse("0 8 * *").is_err());
        assert!(CronSpec::parse("").is_err());
        assert!(CronSpec::parse("60 8 * * *").is_err());
        assert!(CronSpec::parse("0 25 * * *").is_err());
        assert!(CronSpec::parse("0 8 0 * *").is_err());
        assert!(CronSpec::parse("0 8 * * 8").is_err());
        assert!(CronSpec::parse("0 8 * * sun-fri").is_ok());
        assert!(CronSpec::parse("*/15 * * * *").is_ok());
        assert!(CronSpec::parse("0 8 */2 * *").is_ok());
        assert!(CronSpec::parse("30 9 * jan-jun,dec *").is_ok());
        assert!(CronSpec::parse("0 8 * * 7").is_ok(), "7 is a Sunday alias");
    }

    #[test]
    fn weekday_cron_in_london_resolves_to_utc() {
        let spec = cron("0 8 * * 1-5");
        let tz: Tz = "Europe/London".parse().unwrap();
        // Late August: BST, so 08:00 local is 07:00 UTC.
        assert_eq!(
            next_utc(&spec, tz, "2026-08-14T12:00:00Z"),
            "2026-08-17T07:00:00+00:00"
        );
        // After the October clock change: GMT, so 08:00 local is 08:00 UTC.
        assert_eq!(
            next_utc(&spec, tz, "2026-10-30T12:00:00Z"),
            "2026-11-02T08:00:00+00:00"
        );
    }

    #[test]
    fn nonexistent_local_time_is_skipped() {
        // London springs forward at 2027-03-28: 01:00 local does not exist.
        let spec = cron("0 1 * * *");
        let tz: Tz = "Europe/London".parse().unwrap();
        assert_eq!(
            next_utc(&spec, tz, "2027-03-27T12:00:00Z"),
            "2027-03-29T00:00:00+00:00",
            "the 01:00 gap is skipped, not shifted (Mar 29 01:00 BST = 00:00 UTC)"
        );
    }

    #[test]
    fn ambiguous_local_time_runs_once_at_the_earlier_instant() {
        // London falls back at 2026-10-25: 01:30 local occurs twice.
        let spec = cron("30 1 * * *");
        let tz: Tz = "Europe/London".parse().unwrap();
        let next = next_cron_occurrence(&spec, tz, utc("2026-10-24T12:00:00Z")).unwrap();
        // 01:30 BST is 00:30 UTC; the later 01:30 GMT would be 01:30 UTC.
        assert_eq!(next.at.to_rfc3339(), "2026-10-25T00:30:00+00:00");
        assert_eq!(next.key, "2026-10-25T01:30");
        // Searching from inside the fold never returns the second 01:30.
        let after_fold = next.at + Duration::seconds(1);
        let next = next_cron_occurrence(&spec, tz, after_fold).unwrap();
        assert_eq!(next.at.to_rfc3339(), "2026-10-26T01:30:00+00:00");
    }

    #[test]
    fn vixie_dom_dow_or_semantics() {
        let tz: Tz = "UTC".parse().unwrap();
        // Both restricted: the 1st OR any Monday matches.
        let spec = cron("0 0 1 * 1");
        // 2026-08-01 is a Saturday, 2026-08-03 is a Monday.
        assert_eq!(
            next_utc(&spec, tz, "2026-07-31T00:00:00Z"),
            "2026-08-01T00:00:00+00:00"
        );
        assert_eq!(
            next_utc(&spec, tz, "2026-08-01T00:00:00Z"),
            "2026-08-03T00:00:00+00:00"
        );
        // Only dow restricted: day-of-month is ignored.
        let spec = cron("0 0 * * 0");
        assert_eq!(
            next_utc(&spec, tz, "2026-08-14T12:00:00Z"),
            "2026-08-16T00:00:00+00:00"
        );
    }

    #[test]
    fn impossible_schedules_have_no_next_occurrence() {
        let tz: Tz = "UTC".parse().unwrap();
        let spec = cron("0 0 31 2 *");
        assert!(next_cron_occurrence(&spec, tz, utc("2026-08-16T00:00:00Z")).is_none());
    }

    #[test]
    fn interval_and_once_next_occurrences() {
        let trigger = AutomationTrigger::Interval {
            every_seconds: 1800,
            anchor_at: utc("2026-08-16T00:00:00Z"),
        };
        let next = next_occurrence(&trigger, utc("2026-08-16T00:45:00Z"))
            .unwrap()
            .unwrap();
        assert_eq!(next.at, utc("2026-08-16T01:00:00Z"));
        // Exactly on a boundary counts as past, not due.
        let next = next_occurrence(&trigger, utc("2026-08-16T01:00:00Z"))
            .unwrap()
            .unwrap();
        assert_eq!(next.at, utc("2026-08-16T01:30:00Z"));

        let once = AutomationTrigger::Once {
            run_at: utc("2026-08-17T10:00:00Z"),
        };
        assert!(
            next_occurrence(&once, utc("2026-08-17T10:00:00Z"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn interval_minimum_is_enforced() {
        let trigger = AutomationTrigger::Interval {
            every_seconds: 30,
            anchor_at: utc("2026-08-16T00:00:00Z"),
        };
        let error = next_occurrence(&trigger, utc("2026-08-16T00:00:00Z")).unwrap_err();
        assert_eq!(error.0.code, "invalid_schedule");
    }

    #[test]
    fn validate_trigger_requires_future_once_and_valid_timezone() {
        let now = utc("2026-08-16T12:00:00Z");
        let past = AutomationTrigger::Once {
            run_at: utc("2026-08-16T00:00:00Z"),
        };
        assert_eq!(
            validate_trigger(&past, now).unwrap_err().0.code,
            "invalid_schedule"
        );
        let bad_tz = AutomationTrigger::Cron {
            expression: "0 8 * * *".into(),
            timezone: "London".into(),
        };
        let error = validate_trigger(&bad_tz, now).unwrap_err();
        assert_eq!(error.0.code, "invalid_timezone");
        assert!(
            error
                .0
                .field_errors
                .iter()
                .any(|field| field.field == "trigger.timezone")
        );
        let ok = AutomationTrigger::Cron {
            expression: "0 8 * * 1-5".into(),
            timezone: "Europe/London".into(),
        };
        let next = validate_trigger(&ok, now).unwrap();
        assert!(next.at > now);
    }

    #[test]
    fn elevated_modes_are_detected() {
        assert!(is_elevated_mode(Some("bypassPermissions"), None));
        assert!(is_elevated_mode(None, Some("danger-full-access")));
        assert!(!is_elevated_mode(
            Some("acceptEdits"),
            Some("workspace-write")
        ));
        assert!(!is_elevated_mode(None, None));
    }

    #[test]
    fn conditional_classification_requires_exact_marker() {
        let task = AutomationTask::ConditionalPrompt {
            instruction: "Check deployments.".into(),
            no_action_marker: "FALCONDECK_NO_ACTION".into(),
        };
        assert_eq!(
            classify_conditional_outcome(&task, Some("  FALCONDECK_NO_ACTION \n")),
            AutomationRunStatus::SucceededNoAction
        );
        assert_eq!(
            classify_conditional_outcome(&task, Some("FALCONDECK_NO_ACTION-ish")),
            AutomationRunStatus::Succeeded
        );
        assert_eq!(
            classify_conditional_outcome(&task, None),
            AutomationRunStatus::Succeeded
        );
    }
}
