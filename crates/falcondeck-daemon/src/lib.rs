mod api;
mod app;
mod codex;
mod error;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

pub use app::AppState;
pub use error::DaemonError;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub bind_addr: SocketAddr,
    pub codex_bin: String,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            bind_addr: SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                falcondeck_core::DEFAULT_DAEMON_PORT,
            ),
            codex_bin: "codex".to_string(),
        }
    }
}

pub struct EmbeddedDaemonHandle {
    pub local_addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    join_handle: JoinHandle<Result<(), std::io::Error>>,
}

impl EmbeddedDaemonHandle {
    pub fn base_url(&self) -> String {
        format!("http://{}", self.local_addr)
    }

    pub async fn shutdown(mut self) -> Result<(), std::io::Error> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.join_handle.await.unwrap_or(Ok(()))
    }
}

pub async fn spawn_embedded(config: DaemonConfig) -> Result<EmbeddedDaemonHandle, DaemonError> {
    let state = AppState::new("0.1.0".to_string(), config.codex_bin);
    let router = api::router(state);
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
        shutdown: Some(shutdown_tx),
        join_handle,
    })
}

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
