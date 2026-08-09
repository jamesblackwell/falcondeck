//! Command-line entry point for FalconDeck's reusable ACP conformance probe.

#[tokio::main]
async fn main() {
    let code = falcondeck_daemon::acp_conformance::run_cli(std::env::args().skip(1)).await;
    if code != 0 {
        std::process::exit(code);
    }
}
