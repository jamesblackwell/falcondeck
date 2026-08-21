//! Sustained process-tree memory monitoring and optional-runtime admission.
//!
//! A short compiler or provider spike is normal. FalconDeck changes state only
//! after three consecutive samples, then uses a lower recovery threshold so
//! the warning and runtime gate cannot flap around one boundary.

use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
};

use falcondeck_core::{AgentProvider, ServiceLevel, ThreadStatus};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, get_current_pid};
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::error::DaemonError;

use super::AppState;

const SAMPLE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);
// Six restored Codex workspaces currently settle around 1.7 GiB on macOS.
// Leave ordinary multi-workspace use alone while catching the multi-gigabyte
// optional-provider fan-out that caused the observed system-memory crash.
const PRESSURE_THRESHOLD_BYTES: u64 = 2_560 * 1024 * 1024;
const RECOVERY_THRESHOLD_BYTES: u64 = 2_048 * 1024 * 1024;
const REQUIRED_SAMPLES: u8 = 3;
const MAX_CONCURRENT_OPTIONAL_STARTS: usize = 2;
const CONDITION_KEY: &str = "runtime-memory-pressure";
const CONDITION_SOURCE: &str = "runtime-health";
const START_PAUSED_MESSAGE: &str = "FalconDeck has paused starting another optional agent while memory use is high. Close an idle agent thread or wait for memory to recover, then try again.";

pub(super) struct RuntimeHealth {
    under_pressure: AtomicBool,
    optional_start_slots: Semaphore,
}

impl Default for RuntimeHealth {
    fn default() -> Self {
        Self {
            under_pressure: AtomicBool::new(false),
            optional_start_slots: Semaphore::new(MAX_CONCURRENT_OPTIONAL_STARTS),
        }
    }
}

impl RuntimeHealth {
    pub(super) async fn optional_start_permit(&self) -> Result<SemaphorePermit<'_>, DaemonError> {
        self.ensure_start_allowed()?;
        let permit =
            self.optional_start_slots.acquire().await.map_err(|_| {
                DaemonError::Process("optional runtime start gate closed".to_string())
            })?;
        // Pressure may have started while this request waited for a slot.
        self.ensure_start_allowed()?;
        Ok(permit)
    }

    fn ensure_start_allowed(&self) -> Result<(), DaemonError> {
        if self.under_pressure.load(Ordering::Acquire) {
            return Err(DaemonError::Process(START_PAUSED_MESSAGE.to_string()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PressureTransition {
    None,
    Entered,
    Recovered,
}

#[derive(Default)]
struct PressureTracker {
    pressured: bool,
    high_samples: u8,
    low_samples: u8,
}

impl PressureTracker {
    fn observe(&mut self, resident_bytes: u64) -> PressureTransition {
        if self.pressured {
            self.high_samples = 0;
            if resident_bytes <= RECOVERY_THRESHOLD_BYTES {
                self.low_samples = self.low_samples.saturating_add(1);
                if self.low_samples >= REQUIRED_SAMPLES {
                    self.pressured = false;
                    self.low_samples = 0;
                    return PressureTransition::Recovered;
                }
            } else {
                self.low_samples = 0;
            }
            return PressureTransition::None;
        }

        self.low_samples = 0;
        if resident_bytes >= PRESSURE_THRESHOLD_BYTES {
            self.high_samples = self.high_samples.saturating_add(1);
            if self.high_samples >= REQUIRED_SAMPLES {
                self.pressured = true;
                self.high_samples = 0;
                return PressureTransition::Entered;
            }
        } else {
            self.high_samples = 0;
        }
        PressureTransition::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProcessTreeUsage {
    resident_bytes: u64,
    process_count: usize,
}

#[derive(Debug, Clone, Copy)]
struct ProcessSample {
    pid: u32,
    parent: Option<u32>,
    resident_bytes: u64,
}

fn owned_process_usage(root_pid: u32, samples: &[ProcessSample]) -> ProcessTreeUsage {
    let mut children = HashMap::<u32, Vec<&ProcessSample>>::new();
    let mut root = None;
    for sample in samples {
        if sample.pid == root_pid {
            root = Some(sample);
        }
        if let Some(parent) = sample.parent {
            children.entry(parent).or_default().push(sample);
        }
    }

    let mut resident_bytes = 0_u64;
    let mut process_count = 0_usize;
    let mut pending = vec![root_pid];
    let mut visited = HashSet::new();
    while let Some(pid) = pending.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if pid == root_pid {
            if let Some(sample) = root {
                resident_bytes = resident_bytes.saturating_add(sample.resident_bytes);
                process_count += 1;
            }
        } else if let Some(sample) = samples.iter().find(|sample| sample.pid == pid) {
            resident_bytes = resident_bytes.saturating_add(sample.resident_bytes);
            process_count += 1;
        }
        if let Some(descendants) = children.get(&pid) {
            pending.extend(descendants.iter().map(|sample| sample.pid));
        }
    }

    ProcessTreeUsage {
        resident_bytes,
        process_count,
    }
}

fn sample_process_tree() -> Result<ProcessTreeUsage, &'static str> {
    let root_pid = get_current_pid()?.as_u32();
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().without_tasks(),
    );
    let samples = system
        .processes()
        .iter()
        .map(|(pid, process)| ProcessSample {
            pid: pid.as_u32(),
            parent: process.parent().map(|parent| parent.as_u32()),
            resident_bytes: process.memory(),
        })
        .collect::<Vec<_>>();
    Ok(owned_process_usage(root_pid, &samples))
}

fn gigabytes(bytes: u64) -> f64 {
    bytes as f64 / 1_000_000_000.0
}

impl AppState {
    /// Starts one low-frequency monitor for the daemon and every process it
    /// owns. Called only by the embedded-daemon entry point, not by unit-test
    /// state constructors.
    pub(crate) fn start_runtime_health_monitor(&self) {
        let app = self.clone();
        tokio::spawn(async move {
            let mut tracker = PressureTracker::default();
            loop {
                tokio::time::sleep(SAMPLE_INTERVAL).await;
                if app.is_shutting_down() {
                    return;
                }
                let usage = match tokio::task::spawn_blocking(sample_process_tree).await {
                    Ok(Ok(usage)) => usage,
                    Ok(Err(error)) => {
                        tracing::debug!(%error, "runtime memory sample unavailable");
                        continue;
                    }
                    Err(error) => {
                        tracing::debug!(%error, "runtime memory sampler stopped");
                        continue;
                    }
                };

                match tracker.observe(usage.resident_bytes) {
                    PressureTransition::None => {}
                    PressureTransition::Entered => {
                        app.inner
                            .runtime_health
                            .under_pressure
                            .store(true, Ordering::Release);
                        let reaped = app.reap_idle_optional_runtimes().await;
                        tracing::warn!(
                            resident_bytes = usage.resident_bytes,
                            process_count = usage.process_count,
                            reaped_optional_runtimes = reaped,
                            "FalconDeck process tree is under sustained memory pressure"
                        );
                        let recovery = if reaped == 0 {
                            "New optional agents are paused until memory recovers.".to_string()
                        } else {
                            format!(
                                "Stopped {reaped} idle optional agent process{}; new optional agents are paused until memory recovers.",
                                if reaped == 1 { "" } else { "es" },
                            )
                        };
                        let message = format!(
                            "FalconDeck and its agent processes are using {:.1} GB across {} processes. {recovery}",
                            gigabytes(usage.resident_bytes),
                            usage.process_count,
                        );
                        if let Err(error) = app.upsert_operational_condition(
                            String::new(),
                            CONDITION_KEY,
                            ServiceLevel::Warning,
                            message,
                            Some(CONDITION_SOURCE.to_string()),
                        ) {
                            tracing::warn!(%error, "failed to publish runtime memory warning");
                        }
                    }
                    PressureTransition::Recovered => {
                        app.inner
                            .runtime_health
                            .under_pressure
                            .store(false, Ordering::Release);
                        app.clear_operational_condition("", CONDITION_KEY);
                        tracing::info!(
                            resident_bytes = usage.resident_bytes,
                            process_count = usage.process_count,
                            "FalconDeck process-tree memory recovered"
                        );
                    }
                }
            }
        });
    }

    /// Stops only optional provider processes that have no live turn. Core
    /// runtimes and running/waiting threads are never touched.
    async fn reap_idle_optional_runtimes(&self) -> usize {
        let (opencode, acp) = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let mut opencode = Vec::new();
            let mut acp = Vec::new();
            for workspace in workspaces.values_mut() {
                let active_providers = workspace
                    .threads
                    .values()
                    .filter(|thread| {
                        matches!(
                            thread.summary.status,
                            ThreadStatus::Running | ThreadStatus::WaitingForInput
                        )
                    })
                    .map(|thread| thread.summary.provider.clone())
                    .collect::<HashSet<_>>();

                if !active_providers.contains(&AgentProvider::OPENCODE)
                    && let Some(runtime) = workspace.opencode_runtime.take()
                {
                    opencode.push(runtime);
                }
                let idle_providers = workspace
                    .acp_runtimes
                    .keys()
                    .filter(|provider| !active_providers.contains(*provider))
                    .cloned()
                    .collect::<Vec<_>>();
                for provider in idle_providers {
                    if let Some(runtime) = workspace.acp_runtimes.remove(&provider) {
                        acp.push(runtime);
                    }
                }
            }
            (opencode, acp)
        };

        let count = opencode.len() + acp.len();
        for runtime in opencode {
            runtime.shutdown().await;
        }
        for runtime in acp {
            runtime.shutdown().await;
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pressure_needs_sustained_samples_and_hysteresis() {
        let mut tracker = PressureTracker::default();
        assert_eq!(
            tracker.observe(PRESSURE_THRESHOLD_BYTES),
            PressureTransition::None
        );
        assert_eq!(
            tracker.observe(PRESSURE_THRESHOLD_BYTES),
            PressureTransition::None
        );
        assert_eq!(
            tracker.observe(PRESSURE_THRESHOLD_BYTES),
            PressureTransition::Entered
        );
        assert_eq!(
            tracker.observe(PRESSURE_THRESHOLD_BYTES - 1),
            PressureTransition::None
        );
        assert_eq!(
            tracker.observe(RECOVERY_THRESHOLD_BYTES),
            PressureTransition::None
        );
        assert_eq!(
            tracker.observe(RECOVERY_THRESHOLD_BYTES),
            PressureTransition::None
        );
        assert_eq!(
            tracker.observe(RECOVERY_THRESHOLD_BYTES),
            PressureTransition::Recovered
        );
    }

    #[test]
    fn interrupted_spikes_do_not_enter_pressure() {
        let mut tracker = PressureTracker::default();
        assert_eq!(
            tracker.observe(PRESSURE_THRESHOLD_BYTES),
            PressureTransition::None
        );
        assert_eq!(
            tracker.observe(PRESSURE_THRESHOLD_BYTES - 1),
            PressureTransition::None
        );
        assert_eq!(
            tracker.observe(PRESSURE_THRESHOLD_BYTES),
            PressureTransition::None
        );
        assert_eq!(
            tracker.observe(PRESSURE_THRESHOLD_BYTES),
            PressureTransition::None
        );
    }

    #[test]
    fn process_usage_includes_only_root_descendants() {
        let usage = owned_process_usage(
            10,
            &[
                ProcessSample {
                    pid: 10,
                    parent: Some(1),
                    resident_bytes: 100,
                },
                ProcessSample {
                    pid: 11,
                    parent: Some(10),
                    resident_bytes: 200,
                },
                ProcessSample {
                    pid: 12,
                    parent: Some(11),
                    resident_bytes: 300,
                },
                ProcessSample {
                    pid: 20,
                    parent: Some(1),
                    resident_bytes: 9_000,
                },
            ],
        );
        assert_eq!(
            usage,
            ProcessTreeUsage {
                resident_bytes: 600,
                process_count: 3
            }
        );
    }

    #[tokio::test]
    async fn runtime_starts_are_rejected_while_pressured() {
        let health = RuntimeHealth::default();
        health.under_pressure.store(true, Ordering::Release);
        let error = health.optional_start_permit().await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("paused starting another optional agent")
        );
    }
}
