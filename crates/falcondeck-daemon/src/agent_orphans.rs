//! Crash-orphan registry for long-lived agent processes.
//!
//! A warm runtime normally dies with the daemon: children are spawned with
//! `kill_on_drop`, and shutdown stops each one explicitly. Neither holds when
//! the daemon is killed outright — the agent keeps running, holding its model
//! in memory and its binary version pinned, with nothing left to stop it.
//!
//! Each daemon records the processes it starts and, at startup, kills the ones
//! whose owning daemon is gone. Entries carry markers matched against the live
//! command line so a recycled pid is never the one that gets the kill.

use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};

/// Registry files, one per process family, under the daemon state directory.
pub const OPENCODE_REGISTRY_FILE: &str = "opencode-servers.json";
pub const ACP_REGISTRY_FILE: &str = "acp-agents.json";

#[derive(Serialize, Deserialize)]
pub struct RegisteredProcess {
    child_pid: u32,
    daemon_pid: u32,
    /// Substrings that must all appear in the live command line before this
    /// pid is treated as the process that was registered. An entry written by
    /// an older daemon has none, and is dropped rather than killed: an
    /// unverifiable pid is not worth a signal.
    #[serde(default)]
    markers: Vec<String>,
}

/// Records a freshly spawned process against this daemon.
pub fn register(state_dir: &Path, registry_file: &str, child_pid: u32, markers: Vec<String>) {
    let mut entries = load(state_dir, registry_file);
    entries.retain(|entry| entry.child_pid != child_pid && process_alive(entry.child_pid));
    entries.push(RegisteredProcess {
        child_pid,
        daemon_pid: std::process::id(),
        markers,
    });
    store(state_dir, registry_file, &entries);
}

/// Drops a process this daemon stopped on purpose. The entry would expire on
/// its own once the pid stopped being alive; removing it now keeps a recycled
/// pid from briefly reading as a reap candidate.
pub fn forget(state_dir: &Path, registry_file: &str, child_pid: u32) {
    let mut entries = load(state_dir, registry_file);
    let before = entries.len();
    entries.retain(|entry| entry.child_pid != child_pid && process_alive(entry.child_pid));
    if entries.len() != before {
        store(state_dir, registry_file, &entries);
    }
}

/// Kills processes whose owning daemon is gone. Run once at daemon startup,
/// off the readiness path (it shells out to `ps`/`kill`).
pub async fn reap(state_dir: &Path, registry_file: &str, label: &'static str) {
    let state_dir = state_dir.to_path_buf();
    let registry_file = registry_file.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let entries = load(&state_dir, &registry_file);
        let mut kept = Vec::new();
        let mut reaped = 0usize;
        for entry in entries {
            let owned_by_this_daemon = entry.daemon_pid == std::process::id();
            if !owned_by_this_daemon && process_alive(entry.daemon_pid) {
                // Another live daemon owns this process; leave both alone.
                kept.push(entry);
                continue;
            }
            if owned_by_this_daemon {
                // Our own entry from before a restart within one pid: the
                // process is ours to manage, not to reap.
                kept.push(entry);
                continue;
            }
            if command_matches(entry.child_pid, &entry.markers) {
                let _ = std::process::Command::new("kill")
                    .arg(entry.child_pid.to_string())
                    .status();
                reaped += 1;
            }
            // Dead process, recycled pid, or now-killed orphan: drop the entry.
        }
        store(&state_dir, &registry_file, &kept);
        reaped
    })
    .await;
    match result {
        Ok(reaped) if reaped > 0 => {
            tracing::info!(
                reaped,
                label,
                "reaped orphaned agent processes from prior daemons"
            );
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(%error, label, "agent orphan reap task failed"),
    }
}

/// Whether the pid still names the process that was registered. An entry with
/// no markers cannot be verified, so it never matches.
fn command_matches(pid: u32, markers: &[String]) -> bool {
    if markers.is_empty() {
        return false;
    }
    let Ok(output) = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
    else {
        return false;
    };
    let command = String::from_utf8_lossy(&output.stdout);
    markers
        .iter()
        .all(|marker| command.contains(marker.as_str()))
}

fn load(state_dir: &Path, registry_file: &str) -> Vec<RegisteredProcess> {
    std::fs::read(state_dir.join(registry_file))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn store(state_dir: &Path, registry_file: &str, entries: &[RegisteredProcess]) {
    if let Ok(bytes) = serde_json::to_vec(entries) {
        let _ = std::fs::write(state_dir.join(registry_file), bytes);
    }
}

fn process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_without_markers_is_never_killed() {
        assert!(!command_matches(std::process::id(), &[]));
    }

    #[test]
    fn markers_must_all_appear_in_the_live_command_line() {
        let pid = std::process::id();
        assert!(command_matches(pid, &["falcondeck".to_string()]));
        assert!(!command_matches(
            pid,
            &[
                "falcondeck".to_string(),
                "definitely-not-in-this-command".to_string()
            ]
        ));
    }

    #[test]
    fn registering_then_forgetting_leaves_no_entry() {
        let dir = tempfile::tempdir().expect("temp dir");
        let pid = std::process::id();
        register(
            dir.path(),
            "test-registry.json",
            pid,
            vec!["marker".to_string()],
        );
        assert_eq!(load(dir.path(), "test-registry.json").len(), 1);
        forget(dir.path(), "test-registry.json", pid);
        assert!(load(dir.path(), "test-registry.json").is_empty());
    }

    #[test]
    fn a_process_this_daemon_owns_survives_the_reaper() {
        let dir = tempfile::tempdir().expect("temp dir");
        let pid = std::process::id();
        register(
            dir.path(),
            "test-owned.json",
            pid,
            vec!["falcondeck".to_string()],
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(reap(dir.path(), "test-owned.json", "test"));
        assert_eq!(load(dir.path(), "test-owned.json").len(), 1);
    }
}
