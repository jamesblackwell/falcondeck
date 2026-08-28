//! Command-line entry point for FalconDeck's harness conformance suite.
//!
//! Cost-free by default (catalogs, CLI flags, ACP handshake). Missing
//! binaries are skipped. Pass `--live` to spend tokens on current cheap-tier models.

#[tokio::main]
async fn main() {
    let code = falcondeck_daemon::harness_conformance::run_cli(std::env::args().skip(1)).await;
    if code != 0 {
        std::process::exit(code);
    }
}
