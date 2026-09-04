use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use falcondeck_core::DEFAULT_DAEMON_PORT;
use falcondeck_daemon::{DaemonConfig, run};

/// Parses repeated `--provider-bin=<id>=<path>` flags into a provider map. This
/// is the general form; `--codex-bin=`/`--claude-bin=` remain as shorthands.
fn provider_bin_overrides() -> HashMap<String, String> {
    std::env::args()
        .skip(1)
        .filter_map(|arg| arg.strip_prefix("--provider-bin=").map(str::to_string))
        .filter_map(|value| {
            let (provider, bin) = value.split_once('=')?;
            let provider = provider.trim().to_ascii_lowercase();
            let bin = bin.trim();
            (!provider.is_empty() && !bin.is_empty()).then(|| (provider, bin.to_string()))
        })
        .collect()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Provisioning probes an installed binary before replacing it, so
    // `--version` has to answer and exit rather than start a daemon.
    if std::env::args().skip(1).any(|arg| arg == "--version") {
        println!("falcondeck-daemon {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    // The desktop shell embeds this crate and calls the same dispatcher. A
    // built-in connector must never fall through into GUI/daemon startup.
    let first_arg = std::env::args_os().nth(1);
    if let Some(helper) = falcondeck_daemon::stdio_helper::from_first_arg(first_arg.as_deref()) {
        std::process::exit(falcondeck_daemon::stdio_helper::run(helper).await);
    }

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
        provider_bins: provider_bin_overrides(),
        codex_bin,
        claude_bin,
        deno_bin: std::env::args()
            .skip(1)
            .find_map(|arg| arg.strip_prefix("--deno-bin=").map(str::to_string))
            .unwrap_or_else(|| "deno".to_string()),
        computer_use_bin: std::env::args()
            .skip(1)
            .find_map(|arg| arg.strip_prefix("--cua-driver-bin=").map(str::to_string))
            .or_else(|| {
                std::env::var("FALCONDECK_CUA_DRIVER_BIN")
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            }),
        state_path: None,
    };

    run(config).await?;
    Ok(())
}
