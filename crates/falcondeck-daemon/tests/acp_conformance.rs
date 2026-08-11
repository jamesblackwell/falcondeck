use std::{path::PathBuf, time::Duration};

use falcondeck_daemon::acp_conformance::{CheckStatus, ProbeOptions, Report, run_probe};

fn fixture_command(scenario: &str) -> Vec<String> {
    vec![
        "node".to_string(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/acp_conformance_agent.mjs")
            .display()
            .to_string(),
        scenario.to_string(),
    ]
}

fn options(scenario: &str, cwd: PathBuf) -> ProbeOptions {
    ProbeOptions::new(fixture_command(scenario), cwd).with_timeout(Duration::from_secs(3))
}

fn status(report: &Report, name: &str) -> CheckStatus {
    report
        .checks
        .iter()
        .find(|check| check.name == name)
        .unwrap_or_else(|| panic!("missing check {name}: {:#?}", report.checks))
        .status
}

#[tokio::test]
async fn live_probe_exercises_permission_cancel_resume_and_unknown_events() {
    let cwd = tempfile::tempdir().expect("temporary workspace should be created");
    let report = run_probe(
        &options("normal", cwd.path().to_path_buf())
            .with_live_checks(true)
            .with_restart_check(true),
    )
    .await;

    for name in [
        "Initialize",
        "Session creation",
        "Text streaming",
        "Tool lifecycle",
        "Cancellation",
        "Session resume",
        "Process restart",
    ] {
        assert_eq!(status(&report, name), CheckStatus::Pass, "{name}");
    }
    assert_eq!(
        report.unhandled_update_kinds,
        ["available_commands_update".to_string()]
            .into_iter()
            .collect()
    );
    assert_eq!(
        report.unknown_update_kinds,
        ["provider_extension".to_string()].into_iter().collect()
    );
    assert!(report.stderr_tail.contains("fixture adapter diagnostic"));
    assert!(!report.has_failures());
}

#[tokio::test]
async fn handshake_probe_does_not_make_live_requests() {
    let cwd = tempfile::tempdir().expect("temporary workspace should be created");
    let report = run_probe(&options("normal", cwd.path().to_path_buf())).await;

    assert_eq!(status(&report, "Initialize"), CheckStatus::Pass);
    assert_eq!(status(&report, "Session creation"), CheckStatus::Skipped);
    assert!(report.observed_update_kinds.is_empty());
}

#[tokio::test]
async fn protocol_mismatch_is_a_failed_check() {
    let cwd = tempfile::tempdir().expect("temporary workspace should be created");
    let report = run_probe(&options("protocol-mismatch", cwd.path().to_path_buf())).await;

    assert_eq!(status(&report, "Initialize"), CheckStatus::Fail);
    assert!(report.has_failures());
}

#[tokio::test]
async fn malformed_stdout_is_reported_without_panicking() {
    let cwd = tempfile::tempdir().expect("temporary workspace should be created");
    let report = run_probe(&options("malformed", cwd.path().to_path_buf())).await;

    assert_eq!(status(&report, "Initialize"), CheckStatus::Fail);
    assert!(report.checks[0].detail.contains("invalid JSON"));
}

#[tokio::test]
async fn adapter_exit_is_reported_without_panicking() {
    let cwd = tempfile::tempdir().expect("temporary workspace should be created");
    let report = run_probe(&options("exit", cwd.path().to_path_buf())).await;

    assert_eq!(status(&report, "Initialize"), CheckStatus::Fail);
    assert!(report.checks[0].detail.contains("stdout closed"));
}

#[tokio::test]
async fn request_error_preserves_adapter_message() {
    let cwd = tempfile::tempdir().expect("temporary workspace should be created");
    let report = run_probe(&options("request-error", cwd.path().to_path_buf())).await;

    assert_eq!(status(&report, "Initialize"), CheckStatus::Fail);
    assert!(
        report.checks[0]
            .detail
            .contains("fixture initialize failure")
    );
}

#[tokio::test]
async fn request_timeout_becomes_a_failed_check() {
    let cwd = tempfile::tempdir().expect("temporary workspace should be created");
    let report = run_probe(
        &ProbeOptions::new(fixture_command("timeout"), cwd.path().to_path_buf())
            .with_timeout(Duration::from_millis(100)),
    )
    .await;

    assert_eq!(status(&report, "Initialize"), CheckStatus::Fail);
    assert!(report.checks[0].detail.contains("timed out"));
}
