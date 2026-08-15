//! Command-line entry point for FalconDeck's OpenCode native conformance probe.

#[tokio::main]
async fn main() {
    let code = falcondeck_daemon::opencode_conformance::run_cli(std::env::args().skip(1)).await;
    if code != 0 {
        std::process::exit(code);
    }
}
