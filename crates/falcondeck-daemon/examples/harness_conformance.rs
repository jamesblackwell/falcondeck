//! Command-line entry point for FalconDeck's Claude and Codex conformance probes.

#[tokio::main]
async fn main() {
    let code = falcondeck_daemon::harness_conformance::run_cli(std::env::args().skip(1)).await;
    if code != 0 {
        std::process::exit(code);
    }
}
