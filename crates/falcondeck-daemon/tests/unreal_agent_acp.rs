use std::{path::Path, process::Stdio, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdout, Command},
    time::timeout,
};

fn start_adapter() -> (Child, Lines<BufReader<ChildStdout>>) {
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/unreal_agent_runner.mjs");
    let mut child = Command::new(env!("CARGO_BIN_EXE_falcondeck-daemon"))
        .arg("mcp-unreal-agent-acp")
        .env("UNREAL_AGENT_RUNNER_BIN", fixture)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("start ACP adapter");
    let lines = BufReader::new(child.stdout.take().expect("adapter stdout")).lines();
    (child, lines)
}

async fn send(child: &mut Child, id: i64, method: &str, params: Value) {
    let mut line =
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
    line.push('\n');
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(line.as_bytes())
        .await
        .unwrap();
}

async fn receive(lines: &mut Lines<BufReader<ChildStdout>>, id: i64) -> Vec<Value> {
    timeout(Duration::from_secs(10), async {
        let mut received = Vec::new();
        loop {
            let line = lines
                .next_line()
                .await
                .unwrap()
                .expect("adapter stayed open");
            let message: Value = serde_json::from_str(&line).unwrap();
            let finished = message.get("id").and_then(Value::as_i64) == Some(id);
            received.push(message);
            if finished {
                return received;
            }
        }
    })
    .await
    .expect("adapter response within 10 seconds")
}

#[tokio::test]
async fn prompt_cancel_and_reload_native_history() {
    let workspace = tempfile::tempdir().unwrap();
    let (mut child, mut lines) = start_adapter();
    send(&mut child, 1, "initialize", json!({})).await;
    assert_eq!(
        receive(&mut lines, 1).await[0]["result"]["protocolVersion"],
        1
    );

    send(
        &mut child,
        2,
        "session/new",
        json!({ "cwd": workspace.path(), "instructions": "Follow project instructions" }),
    )
    .await;
    let created = receive(&mut lines, 2).await;
    let session_id = created[0]["result"]["sessionId"].as_str().unwrap();
    let session_id = session_id.to_string();

    send(&mut child, 30, "session/set_config_option", json!({
        "sessionId": session_id, "configId": "permission", "value": "always-approve"
    })).await;
    assert_eq!(receive(&mut lines, 30).await[0]["result"]["sessionId"], session_id);
    send(&mut child, 31, "session/set_model", json!({
        "sessionId": session_id, "modelId": "gpt-6-astra"
    })).await;
    assert_eq!(receive(&mut lines, 31).await[0]["result"]["sessionId"], session_id);

    send(
        &mut child,
        3,
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "hello" }] }),
    )
    .await;
    let events = receive(&mut lines, 3).await;
    assert_eq!(events.last().unwrap()["result"]["stopReason"], "end_turn");
    assert!(events.iter().any(|event| {
        event
            .pointer("/params/update/content/text")
            .and_then(Value::as_str)
            == Some("ECHO:hello")
    }));

    send(
        &mut child,
        4,
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "wait" }] }),
    )
    .await;
    send(
        &mut child,
        5,
        "session/cancel",
        json!({ "sessionId": session_id }),
    )
    .await;
    let events = receive(&mut lines, 4).await;
    assert_eq!(events.last().unwrap()["result"]["stopReason"], "cancelled");
    child.kill().await.unwrap();

    let (mut child, mut lines) = start_adapter();
    send(&mut child, 1, "initialize", json!({})).await;
    receive(&mut lines, 1).await;
    send(
        &mut child,
        2,
        "session/load",
        json!({ "cwd": workspace.path(), "sessionId": session_id }),
    )
    .await;
    let events = receive(&mut lines, 2).await;
    assert_eq!(events.last().unwrap()["result"]["sessionId"], session_id);
    assert!(events.iter().any(|event| {
        event
            .pointer("/params/update/content/text")
            .and_then(Value::as_str)
            == Some("hello")
    }));
    assert!(events.iter().any(|event| {
        event
            .pointer("/params/update/content/text")
            .and_then(Value::as_str)
            == Some("ECHO:hello")
    }));
    child.kill().await.unwrap();
}
