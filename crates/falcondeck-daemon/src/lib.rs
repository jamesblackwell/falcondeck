//! Local daemon runtime for `FalconDeck`.
//!
//! This crate owns the localhost-first control plane that brokers workspaces,
//! agent sessions, remote pairing, and the HTTP API consumed by the desktop,
//! mobile, and remote web shells.

pub mod acp;
pub mod acp_conformance;
pub mod acp_protocol;
mod agent_binary;
mod api;
mod app;
mod claude;
mod codex;
mod connectors;
mod error;
mod git;
mod skills;
mod ssh_config;
mod variant;
mod workspace_files;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use falcondeck_core::AgentProvider;

pub use agent_binary::{AgentBinaryResolution, ResolutionDiagnostics, resolve_agent_binary};
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
    /// Optional persisted state location for daemon-local state.
    pub state_path: Option<PathBuf>,
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
            state_path: None,
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
    pub async fn shutdown(mut self) -> Result<(), std::io::Error> {
        if let Some(restore_task) = self.restore_task.take() {
            restore_task.abort();
        }
        let _ = self.state.shutdown().await;
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.join_handle.await.unwrap_or(Ok(()))
    }
}

/// Starts the daemon in-process and returns a handle for interacting with it.
pub async fn spawn_embedded(config: DaemonConfig) -> Result<EmbeddedDaemonHandle, DaemonError> {
    // reqwest and tokio-tungstenite may enable different rustls crypto
    // backends in the final desktop binary. Pick one before any relay TLS
    // connection is created; otherwise rustls panics in a background worker.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let provider_bins = config.resolved_provider_bins();
    let state = AppState::new_with_state_path_and_extension_runtime(
        "0.1.0".to_string(),
        provider_bins,
        config.state_path.unwrap_or_else(|| {
            std::env::var("FALCONDECK_STATE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    PathBuf::from(
                        std::env::var("HOME")
                            .map(|home| format!("{home}/.falcondeck/daemon-state.json"))
                            .unwrap_or_else(|_| ".falcondeck/daemon-state.json".to_string()),
                    )
                })
        }),
        config.deno_bin,
    );
    let listener = TcpListener::bind(config.bind_addr).await?;
    let local_addr = listener.local_addr()?;
    // The Claude PreToolUse hook posts back to this URL; record the actual
    // bound address since the configured port may be 0 (OS-assigned).
    state.set_local_base_url(format!("http://{local_addr}"));
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    // Binding the listener is the daemon's readiness boundary. Restore can
    // touch OS keychains and other slow or unavailable services, so it must
    // never delay the local API from coming online.
    let restore_state = state.clone();
    let restore_task = tokio::spawn(async move {
        if let Err(error) = restore_state.restore_local_state().await {
            tracing::warn!("failed to restore daemon local state: {error}");
        }
    });
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
        restore_task: Some(restore_task),
        shutdown: Some(shutdown_tx),
        join_handle,
    })
}

/// Runs the daemon until the process receives `Ctrl-C`.
pub async fn run(config: DaemonConfig) -> Result<(), DaemonError> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "falcondeck_daemon=info,tower_http=info".to_string()),
        )
        .try_init()
        .ok();

    let handle = spawn_embedded(config).await?;
    tracing::info!("falcondeck-daemon listening on {}", handle.local_addr);
    tokio::signal::ctrl_c().await?;
    handle.shutdown().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
