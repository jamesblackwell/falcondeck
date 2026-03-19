//! Local daemon runtime for `FalconDeck`.
//!
//! This crate owns the localhost-first control plane that brokers workspaces,
//! agent sessions, remote pairing, and the HTTP API consumed by the desktop,
//! mobile, and remote web shells.

mod api;
mod app;
mod claude;
mod codex;
mod error;
mod git;
mod skills;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

pub use app::AppState;
pub use error::DaemonError;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

/// Runtime configuration for an embedded daemon instance.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Socket address bound by the daemon HTTP server.
    pub bind_addr: SocketAddr,
    /// Executable name or path used for Codex-backed sessions.
    pub codex_bin: String,
    /// Executable name or path used for Claude-backed sessions.
    pub claude_bin: String,
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
            codex_bin: "codex".to_string(),
            claude_bin: "claude".to_string(),
            state_path: None,
        }
    }
}

pub struct EmbeddedDaemonHandle {
    /// Resolved local bind address for the embedded daemon.
    pub local_addr: SocketAddr,
    state: AppState,
    shutdown: Option<oneshot::Sender<()>>,
    join_handle: JoinHandle<Result<(), std::io::Error>>,
}

impl EmbeddedDaemonHandle {
    /// Returns the base HTTP URL for the embedded daemon.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.local_addr)
    }

    /// Stops the daemon and waits for the server task to exit.
    pub async fn shutdown(mut self) -> Result<(), std::io::Error> {
        let _ = self.state.shutdown().await;
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.join_handle.await.unwrap_or(Ok(()))
    }
}

/// Starts the daemon in-process and returns a handle for interacting with it.
pub async fn spawn_embedded(config: DaemonConfig) -> Result<EmbeddedDaemonHandle, DaemonError> {
    let state = AppState::new_with_state_path(
        "0.1.0".to_string(),
        config.codex_bin,
        config.claude_bin,
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
    );
    if let Err(error) = state.restore_local_state().await {
        tracing::warn!("failed to restore daemon local state: {error}");
    }
    let router = api::router(state.clone());
    let listener = TcpListener::bind(config.bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

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
