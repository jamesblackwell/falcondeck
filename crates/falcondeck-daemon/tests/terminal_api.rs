use std::path::PathBuf;
use std::time::Duration;

use falcondeck_core::terminal::{TerminalClientFrame, TerminalServerFrame};
use falcondeck_daemon::{DaemonConfig, spawn_embedded};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

fn test_config() -> DaemonConfig {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("daemon-state.json");
    let _ = temp_dir.keep();
    DaemonConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        state_path: Some(state_path),
        ..DaemonConfig::default()
    }
}

fn workspace_dir() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap().to_string();
    (dir, path)
}

async fn next_frame(
    socket: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> TerminalServerFrame {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .unwrap_or_default();
        let message = tokio::time::timeout(remaining, socket.next())
            .await
            .expect("timed out waiting for terminal websocket frame")
            .expect("terminal websocket closed")
            .expect("websocket error");
        let Message::Text(text) = message else {
            continue;
        };
        let frame: TerminalServerFrame = serde_json::from_str(&text).expect("valid frame");
        match frame {
            TerminalServerFrame::TerminalPong | TerminalServerFrame::TerminalAttached { .. } => {
                continue;
            }
            _ => return frame,
        }
    }
}

fn frame_text(frame: &TerminalServerFrame) -> String {
    use base64::Engine as _;
    match frame {
        TerminalServerFrame::TerminalOutput { chunk }
        | TerminalServerFrame::TerminalReplay { chunk } => String::from_utf8_lossy(
            &base64::engine::general_purpose::STANDARD
                .decode(&chunk.data_base64)
                .unwrap(),
        )
        .to_string(),
        _ => String::new(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_http_and_websocket_round_trip() {
    // Keep the login shell deterministic across machines. SAFETY: test-only.
    unsafe { std::env::set_var("SHELL", "/bin/sh") };
    let daemon = spawn_embedded(test_config()).await.unwrap();
    let client = reqwest::Client::new();

    // Opening a terminal for an unknown workspace must 404.
    let missing = client
        .post(format!(
            "{}/api/workspaces/does-not-exist/terminals",
            daemon.base_url()
        ))
        .json(&serde_json::json!({ "cols": 80, "rows": 24 }))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);

    let (_dir, cwd) = workspace_dir();
    let workspace: falcondeck_core::WorkspaceSummary = client
        .post(format!("{}/api/workspaces/connect", daemon.base_url()))
        .json(&serde_json::json!({ "path": cwd }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let opened: falcondeck_core::terminal::TerminalOpenedResponse = client
        .post(format!(
            "{}/api/workspaces/{}/terminals",
            daemon.base_url(),
            workspace.id
        ))
        .json(&serde_json::json!({ "cols": 80, "rows": 24 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(opened.session.workspace_id, workspace.id);

    // The list route reflects the live session.
    let listed: falcondeck_core::terminal::TerminalListResponse = client
        .get(format!(
            "{}/api/workspaces/{}/terminals",
            daemon.base_url(),
            workspace.id
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed.sessions.len(), 1);
    assert_eq!(listed.sessions[0].id, opened.session.id);

    let (mut socket, _response) = tokio_tungstenite::connect_async(format!(
        "{}/api/terminals/{}/ws?since_seq=0",
        daemon.base_url().replace("http://", "ws://"),
        opened.session.id
    ))
    .await
    .unwrap();

    let marker = "falcondeck-terminal-http-marker";
    let input = TerminalClientFrame::TerminalInput {
        data_base64: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            format!("echo {marker}\n"),
        ),
    };
    socket
        .send(Message::Text(serde_json::to_string(&input).unwrap().into()))
        .await
        .unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut seen = String::new();
    loop {
        let frame = next_frame(&mut socket).await;
        seen.push_str(&frame_text(&frame));
        if seen.contains(marker) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for echoed marker; seen={seen:?}"
        );
    }

    // Closing through HTTP tears the session down and notifies the socket.
    let closed = client
        .post(format!(
            "{}/api/terminals/{}/close",
            daemon.base_url(),
            opened.session.id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(closed.status(), reqwest::StatusCode::OK);

    let frame = next_frame(&mut socket).await;
    assert!(matches!(frame, TerminalServerFrame::TerminalExited { .. }));

    // The list is empty again once the exit watcher reaped the session.
    let mut listed_empty = false;
    for _ in 0..50 {
        let listed: falcondeck_core::terminal::TerminalListResponse = client
            .get(format!(
                "{}/api/workspaces/{}/terminals",
                daemon.base_url(),
                workspace.id
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if listed.sessions.is_empty() {
            listed_empty = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(listed_empty, "session was reaped after close");
    daemon.shutdown().await.unwrap();
}
