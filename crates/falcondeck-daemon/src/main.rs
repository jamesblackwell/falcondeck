use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use falcondeck_core::DEFAULT_DAEMON_PORT;
use falcondeck_daemon::{DaemonConfig, run};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::args()
        .skip(1)
        .find_map(|arg| arg.strip_prefix("--port=").map(str::to_string))
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_DAEMON_PORT);

    let codex_bin = std::env::args()
        .skip(1)
        .find_map(|arg| arg.strip_prefix("--codex-bin=").map(str::to_string))
        .unwrap_or_else(|| "codex".to_string());
    let claude_bin = std::env::args()
        .skip(1)
        .find_map(|arg| arg.strip_prefix("--claude-bin=").map(str::to_string))
        .unwrap_or_else(|| "claude".to_string());

    let config = DaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        codex_bin,
        claude_bin,
        state_path: None,
    };

    run(config).await?;
    Ok(())
}
