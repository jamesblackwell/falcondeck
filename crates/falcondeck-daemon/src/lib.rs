//! Local daemon runtime for `FalconDeck`.
//!
//! This crate owns the localhost-first control plane that brokers workspaces,
//! agent sessions, remote pairing, and the HTTP API consumed by the desktop,
//! mobile, and remote web shells.

pub mod acp;
pub mod acp_conformance;
pub mod acp_protocol;
mod activity;
mod agent_binary;
mod agent_context;
mod agent_orphans;
mod agy;
mod api;
mod app;
mod claude;
mod codex;
mod connector_catalog;
mod connector_logos;
mod connector_oauth;
mod connector_proxy;
mod connectors;
pub mod control;
pub mod desktop_presence;
mod error;
pub mod extension_mcp;
mod git;
pub mod harness_conformance;
pub mod logging;
pub(crate) mod opencode;
pub mod opencode_conformance;
#[cfg(unix)]
mod process_limits;
mod prompts;
mod ship;
mod skill_library;
mod skills;
mod ssh_config;
mod state_lock;
pub mod stdio_helper;
mod terminal;
pub mod unreal_agent_acp;
mod variant;
mod workspace_files;
mod workspace_icons;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use falcondeck_core::AgentProvider;

pub use agent_binary::{
    AgentBinaryResolution, BinaryResolutionSource, ResolutionDiagnostics, resolve_agent_binary,
};
pub use app::AppState;
pub use error::DaemonError;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

/// Runtime configuration for an embedded daemon instance.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Socket address bound by the daemon HTTP server.
    pub bind_addr: SocketAddr,
    /// Executable name or path per provider id. Providers left out fall back to
    /// their id as the command name, so a new provider needs no new field here.
    pub provider_bins: HashMap<String, String>,
    /// Executable name or path used for Codex-backed sessions. Superseded by a
    /// `codex` entry in `provider_bins`; kept as a named field so existing
    /// embedders keep compiling.
    pub codex_bin: String,
    /// Executable name or path used for Claude-backed sessions. See `codex_bin`.
    pub claude_bin: String,
    /// Executable name or path used for the sandboxed extension runtime.
    pub deno_bin: String,
    /// Optional bundled `cua-driver` binary. Set only by the desktop embedding.
    pub computer_use_bin: Option<String>,
    /// Host application identity supplied to the embedded computer-use runtime.
    /// Defaults to the Tauri desktop identity when omitted by older embedders.
    pub computer_use_host_bundle_id: Option<String>,
    /// Optional persisted state location for daemon-local state.
    pub state_path: Option<PathBuf>,
    /// Restores sessions, extensions, and the transcript index after the
    /// listener is up. Control state is loaded either way. Tests that only
    /// drive the control API turn this off so they do not scan the user's
    /// real session files.
    pub background_restore: bool,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            bind_addr: SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                falcondeck_core::DEFAULT_DAEMON_PORT,
            ),
            provider_bins: HashMap::new(),
            codex_bin: "codex".to_string(),
            claude_bin: "claude".to_string(),
            deno_bin: "deno".to_string(),
            computer_use_bin: None,
            computer_use_host_bundle_id: None,
            state_path: None,
            background_restore: true,
        }
    }
}

impl DaemonConfig {
    /// Folds the legacy named binary fields into the provider map. Explicit map
    /// entries win, so a caller that has moved to `provider_bins` is never
    /// overridden by the defaults still sitting on the named fields.
    fn resolved_provider_bins(&self) -> HashMap<AgentProvider, String> {
        let mut resolved = self
            .provider_bins
            .iter()
            .map(|(provider, bin)| (AgentProvider::new(provider.clone()), bin.clone()))
            .collect::<HashMap<_, _>>();
        resolved
            .entry(AgentProvider::CODEX)
            .or_insert_with(|| self.codex_bin.clone());
        resolved
            .entry(AgentProvider::CLAUDE)
            .or_insert_with(|| self.claude_bin.clone());
        resolved
    }
}

pub struct EmbeddedDaemonHandle {
    /// Resolved local bind address for the embedded daemon.
    pub local_addr: SocketAddr,
    state: AppState,
    restore_task: Option<JoinHandle<()>>,
    shutdown: Option<oneshot::Sender<()>>,
    join_handle: JoinHandle<Result<(), std::io::Error>>,
    _state_lock: Arc<state_lock::StateLock>,
}

impl EmbeddedDaemonHandle {
    /// Returns the base HTTP URL for the embedded daemon.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.local_addr)
    }

    /// Returns the number of local threads whose turns have not yet ended.
    pub async fn active_thread_count(&self) -> usize {
        self.state.active_thread_count().await
    }

    /// The daemon-owned agent control service, for embedders and tests.
    pub fn control(&self) -> &control::ControlService {
        self.state.control()
    }

    /// The daemon state, for embedders that drive scheduler and control
    /// entry points directly.
    pub fn app_state(&self) -> &AppState {
        &self.state
    }

    /// Waits until persisted daemon state has finished restoring.
    ///
    /// The local HTTP listener intentionally becomes available before this
    /// work completes. Integration tests and other embedded callers that need
    /// restored state, rather than only API readiness, can synchronize on the
    /// stronger boundary explicitly.
    pub async fn wait_until_restored(&mut self) -> Result<(), tokio::task::JoinError> {
        if let Some(restore_task) = self.restore_task.take() {
            restore_task.await?;
        }
        Ok(())
    }

    /// Stops the daemon and waits for the server task to exit.
    /// State ownership remains held by outstanding [`AppState`] clones until
    /// their background work completes or the embedding runtime drops them.
    pub async fn shutdown(mut self) -> Result<(), std::io::Error> {
        if let Some(restore_task) = self.restore_task.take() {
            restore_task.abort();
        }
        let state_result = self.state.shutdown().await.map_err(std::io::Error::other);
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let server_result = self
            .join_handle
            .await
            .unwrap_or_else(|error| Err(std::io::Error::other(error)));
        state_result.and(server_result)
    }
}

/// Starts the daemon in-process and returns a handle for interacting with it.
pub async fn spawn_embedded(config: DaemonConfig) -> Result<EmbeddedDaemonHandle, DaemonError> {
    // reqwest and tokio-tungstenite may enable different rustls crypto
    // backends in the final desktop binary. Pick one before any relay TLS
    // connection is created; otherwise rustls panics in a background worker.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let provider_bins = config.resolved_provider_bins();
    let state_path = config.state_path.unwrap_or_else(|| {
        std::env::var("FALCONDECK_STATE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(
                    std::env::var("HOME")
                        .map(|home| format!("{home}/.falcondeck/daemon-state.json"))
                        .unwrap_or_else(|_| ".falcondeck/daemon-state.json".to_string()),
                )
            })
    });
    // Acquire before logging, restore, or scheduler startup can mutate any
    // daemon-owned state. All desktop and standalone entry points share this.
    let state_lock = Arc::new(state_lock::StateLock::acquire(&state_path)?);
    // Installed here rather than in `run`: the desktop app embeds the daemon
    // and never goes through that path, so every diagnostic it logged used to
    // be dropped on the floor.
    logging::init(&state_path);
    #[cfg(unix)]
    if let Err(error) = process_limits::prepare_file_descriptor_limit() {
        tracing::warn!(%error, "failed to raise daemon file descriptor limit");
    }
    let state = AppState::new_with_state_path_and_runtimes_and_host(
        "0.1.0".to_string(),
        provider_bins,
        state_path,
        config.deno_bin,
        config.computer_use_bin,
        config.computer_use_host_bundle_id,
    );
    state.retain_state_lock(Arc::clone(&state_lock));
    state.begin_local_restore();
    // Scheduled definitions are small, local, and must be present before the
    // listener advertises readiness. Otherwise an early snapshot or mutation
    // can observe an empty registry and the background restore can overwrite
    // a newly-created task.
    state.restore_scheduled_tasks().await?;
    // Control state is small and must be loaded before the listener
    // advertises readiness: a degraded store disables scheduling and is
    // surfaced as an operational condition rather than a startup failure.
    if let Err(error) = state.restore_control_state().await {
        tracing::warn!("failed to restore agent control state: {error}");
    }
    let listener = TcpListener::bind(config.bind_addr).await?;
    let local_addr = listener.local_addr()?;
    // A failed bind must not leave a detached scheduler holding state ownership
    // or executing automations for a runtime that never became available.
    control::scheduler::start(&state);
    // The Claude PreToolUse hook posts back to this URL; record the actual
    // bound address since the configured port may be 0 (OS-assigned).
    state.set_local_base_url(format!("http://{local_addr}"));
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    // Binding the listener is the daemon's readiness boundary. Restore can
    // touch OS keychains and other slow or unavailable services, so it must
    // never delay the local API from coming online.
    let restore_state = state.clone();
    let restore_task = config.background_restore.then(|| {
        tokio::spawn(async move {
            // Prior daemons that died ungracefully strand their agent children:
            // an `opencode serve` holds ~80-90MB forever, and an ACP agent holds
            // both memory and the binary version it was started on. Reap them
            // before this daemon starts spawning its own.
            if let Some(state_dir) = restore_state.state_dir() {
                opencode::reap_orphaned_servers(&state_dir).await;
                agent_orphans::reap(&state_dir, agent_orphans::ACP_REGISTRY_FILE, "acp agent")
                    .await;
            }
            if let Err(error) = restore_state.restore_local_state().await {
                tracing::warn!("failed to restore daemon local state: {error}");
                restore_state.finish_local_restore();
                restore_state.emit_event(
                    None,
                    None,
                    falcondeck_core::UnifiedEvent::Snapshot {
                        snapshot: restore_state.snapshot().await,
                    },
                );
            }
            // Warm the message-search excerpts once threads are known, so the
            // first search does not pay for the whole session-file walk.
            restore_state.start_thread_search_index();
        })
    });
    if !config.background_restore {
        // begin_local_restore already moved the phase to loading. Nothing
        // else will finish it when the background task is skipped.
        state.finish_local_restore();
    }
    let router = api::router(state.clone());

    let join_handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
    });

    Ok(EmbeddedDaemonHandle {
        local_addr,
        state,
        restore_task,
        shutdown: Some(shutdown_tx),
        join_handle,
        _state_lock: state_lock,
    })
}

/// Runs the daemon until the process receives `Ctrl-C` or `SIGTERM`.
pub async fn run(config: DaemonConfig) -> Result<(), DaemonError> {
    // Logging is installed by `spawn_embedded`, which this shares with the
    // desktop app so both get the same sink.
    let handle = spawn_embedded(config).await?;
    tracing::info!("falcondeck-daemon listening on {}", handle.local_addr);
    wait_for_shutdown_signal().await;
    handle.shutdown().await?;
    Ok(())
}

async fn wait_for_shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(_) => {
                    let _ = ctrl_c.await;
                    return;
                }
            };
        tokio::select! {
            _ = ctrl_c => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_lock_is_retained_until_background_state_clones_are_gone() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("daemon-state.json");
        let lock = Arc::new(state_lock::StateLock::acquire(&state_path).unwrap());
        let state = AppState::new_with_state_path_and_runtimes(
            "test".to_string(),
            HashMap::new(),
            state_path.clone(),
            "deno".to_string(),
            None,
        );
        state.retain_state_lock(Arc::clone(&lock));
        let background_state = state.clone();
        drop(lock);
        drop(state);

        assert!(matches!(
            state_lock::StateLock::acquire(&state_path),
            Err(DaemonError::Conflict(_))
        ));
        drop(background_state);
        let _next_owner = state_lock::StateLock::acquire(&state_path).unwrap();
    }

    #[tokio::test]
    async fn graceful_shutdown_retains_state_ownership_while_old_state_can_write() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("daemon-state.json");
        let config = || DaemonConfig {
            bind_addr: ([127, 0, 0, 1], 0).into(),
            state_path: Some(state_path.clone()),
            background_restore: false,
            ..DaemonConfig::default()
        };
        let first = spawn_embedded(config()).await.unwrap();
        let retained_state = first.app_state().clone();
        first.shutdown().await.unwrap();

        assert!(retained_state.is_shutting_down());
        assert!(matches!(
            spawn_embedded(config()).await,
            Err(DaemonError::Conflict(_))
        ));
        drop(retained_state);
        // The scheduler was notified by shutdown and releases its state clone.
        tokio::task::yield_now().await;
        let second = spawn_embedded(config()).await.unwrap();
        second.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn embedded_shutdown_reports_persistence_failure() {
        let directory = tempfile::tempdir().unwrap();
        let daemon = spawn_embedded(DaemonConfig {
            bind_addr: ([127, 0, 0, 1], 0).into(),
            state_path: Some(directory.path().join("daemon-state.json")),
            background_restore: false,
            ..DaemonConfig::default()
        })
        .await
        .unwrap();
        // Make the scheduled-task store unwritable without depending on user
        // permissions (the test may run as an administrator).
        let scheduled_path = directory.path().join("scheduled-tasks.json");
        tokio::fs::remove_file(&scheduled_path).await.unwrap();
        tokio::fs::create_dir(&scheduled_path).await.unwrap();
        let address = daemon.local_addr;

        assert!(daemon.shutdown().await.is_err());
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
        assert!(directory.path().join("daemon-state.json").exists());
    }

    #[tokio::test]
    async fn shutdown_finishes_registered_writers_before_state_is_reused() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("daemon-state.json");
        let config = || DaemonConfig {
            bind_addr: ([127, 0, 0, 1], 0).into(),
            state_path: Some(state_path.clone()),
            background_restore: false,
            ..DaemonConfig::default()
        };
        let daemon = spawn_embedded(config()).await.unwrap();
        let state = daemon.app_state().clone();
        let marker = directory.path().join("writer-finished");
        let task_marker = marker.clone();
        assert!(daemon.app_state().spawn_background_task(async move {
            state.wait_for_shutdown().await;
            tokio::fs::write(task_marker, "finished").await.unwrap();
        }));

        daemon.shutdown().await.unwrap();

        assert!(marker.exists());
        let next = spawn_embedded(config()).await.unwrap();
        next.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_signal_is_visible_to_waiters_registered_after_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let daemon = spawn_embedded(DaemonConfig {
            bind_addr: ([127, 0, 0, 1], 0).into(),
            state_path: Some(directory.path().join("daemon-state.json")),
            background_restore: false,
            ..DaemonConfig::default()
        })
        .await
        .unwrap();
        let state = daemon.app_state().clone();
        daemon.shutdown().await.unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(1), state.wait_for_shutdown())
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_cancels_an_admitted_provider_bootstrap_before_restarting() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let started = directory.path().join("provider-started");
        let executable = directory.path().join("pending-codex");
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nif [ \"$1\" = app-server ]; then\n : > '{}'\n exec /bin/cat >/dev/null\nfi\n",
                started.display(),
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = || DaemonConfig {
            bind_addr: ([127, 0, 0, 1], 0).into(),
            state_path: Some(directory.path().join("daemon-state.json")),
            codex_bin: executable.to_string_lossy().into_owned(),
            claude_bin: "/usr/bin/false".to_string(),
            provider_bins: HashMap::from([("agy".to_string(), "/usr/bin/false".to_string())]),
            background_restore: false,
            ..DaemonConfig::default()
        };
        let daemon = spawn_embedded(config()).await.unwrap();
        daemon
            .app_state()
            .connect_workspace(falcondeck_core::ConnectWorkspaceRequest {
                path: workspace.to_string_lossy().into_owned(),
                kind: Default::default(),
            })
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !started.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        let shutdown_started = std::time::Instant::now();
        tokio::time::timeout(std::time::Duration::from_secs(5), daemon.shutdown())
            .await
            .unwrap()
            .unwrap();
        eprintln!(
            "pending-provider shutdown took {:?}",
            shutdown_started.elapsed()
        );
        let next = spawn_embedded(config()).await.unwrap();
        next.shutdown().await.unwrap();
    }

    #[test]
    fn daemon_installs_a_rustls_crypto_provider() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn legacy_binary_fields_fill_in_the_provider_map() {
        let config = DaemonConfig {
            codex_bin: "/opt/codex".to_string(),
            claude_bin: "/opt/claude".to_string(),
            ..DaemonConfig::default()
        };

        let resolved = config.resolved_provider_bins();
        assert_eq!(
            resolved.get(&AgentProvider::CODEX).map(String::as_str),
            Some("/opt/codex")
        );
        assert_eq!(
            resolved.get(&AgentProvider::CLAUDE).map(String::as_str),
            Some("/opt/claude")
        );
    }

    #[test]
    fn provider_map_entries_win_over_the_legacy_fields() {
        let config = DaemonConfig {
            provider_bins: HashMap::from([
                ("codex".to_string(), "/custom/codex".to_string()),
                ("opencode".to_string(), "/custom/opencode".to_string()),
            ]),
            ..DaemonConfig::default()
        };

        let resolved = config.resolved_provider_bins();
        assert_eq!(
            resolved.get(&AgentProvider::CODEX).map(String::as_str),
            Some("/custom/codex")
        );
        // Untouched by the map, so the legacy default still applies.
        assert_eq!(
            resolved.get(&AgentProvider::CLAUDE).map(String::as_str),
            Some("claude")
        );
        assert_eq!(
            resolved
                .get(&AgentProvider::new("opencode".to_string()))
                .map(String::as_str),
            Some("/custom/opencode")
        );
    }
}
