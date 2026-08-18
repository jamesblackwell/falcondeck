//! Live steer probe: drives a real ACP agent through the daemon's own
//! `AcpRuntime` — prompt, steer mid-stream via cancel-and-re-prompt, and
//! report what actually happened on the wire.
//!
//! Usage: cargo run -p falcondeck-daemon --example steer_probe -- [MODEL_ID]

use std::{collections::HashMap, sync::Arc, time::Duration};

use falcondeck_daemon::acp::{AcpEvent, AcpProviderConfig, AcpRuntime};
use serde_json::json;
use tokio::{sync::mpsc, time::timeout};

#[tokio::main]
async fn main() {
    let model = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "zai-coding-plan/glm-5.3".to_string());
    let config = AcpProviderConfig {
        id: "opencode".to_string(),
        label: "OpenCode".to_string(),
        command: vec!["opencode".to_string(), "acp".to_string()],
        env: HashMap::new(),
        transport: Default::default(),
    };
    let (events, mut receiver) = mpsc::unbounded_channel::<AcpEvent>();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let runtime = AcpRuntime::connect(config, &cwd, events)
        .await
        .expect("connect");
    eprintln!("connected");
    let session_id = runtime
        .ensure_session("steer-probe-thread", None, &cwd, None, None)
        .await
        .expect("session");
    eprintln!("session: {session_id}");
    if let Err(error) = runtime
        .apply_session_preferences(&session_id, Some(&model), None, None, None)
        .await
    {
        eprintln!("set model failed: {error}");
    } else {
        eprintln!("model set: {model}");
    }

    let prompt_runtime = Arc::clone(&runtime);
    let prompt_session = session_id.clone();
    let turn = tokio::spawn(async move {
        prompt_runtime
            .prompt(
                &prompt_session,
                vec![json!({
                    "type": "text",
                    "text": "Count from 1 to 80, one number per line. No tools. No commentary."
                })],
            )
            .await
    });

    let started = std::time::Instant::now();
    let mut steer_at: Option<Duration> = None;
    let mut steered = false;
    let mut segments: Vec<String> = vec![String::new()];
    let mut ended = 0usize;
    loop {
        let event = match timeout(Duration::from_secs(180), receiver.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => {
                eprintln!("event channel closed");
                break;
            }
            Err(_) => {
                eprintln!("TIMED OUT waiting for events");
                break;
            }
        };
        let at = started.elapsed();
        match event {
            AcpEvent::MessageDelta { text, .. } => {
                segments.last_mut().unwrap().push_str(&text);
                if !steered {
                    steered = true;
                    steer_at = Some(at);
                    eprintln!("[{at:?}] >>> steering now (after first delta)");
                    let outcome = runtime
                        .steer_with_cancel(
                            &session_id,
                            vec![json!({
                                "type": "text",
                                "text": "Stop counting immediately. Reply with exactly: STEERED-OK"
                            })],
                        )
                        .await;
                    eprintln!("[{:?}] >>> steer outcome: {outcome:?}", started.elapsed());
                }
            }
            AcpEvent::TurnEnded {
                stop_reason, error, ..
            } => {
                ended += 1;
                eprintln!("[{at:?}] [turn-ended #{ended}] stop={stop_reason:?} error={error:?}");
                eprintln!(
                    "  segment #{ended} text ({} chars): {:?}",
                    segments.last().unwrap().len(),
                    truncate(segments.last().unwrap(), 120)
                );
                segments.push(String::new());
                if ended >= 2 {
                    break;
                }
            }
            _ => {}
        }
    }
    match timeout(Duration::from_secs(30), turn).await {
        Ok(Ok(result)) => eprintln!("prompt() returned: {result:?}"),
        Ok(Err(join)) => eprintln!("prompt task panicked: {join}"),
        Err(_) => eprintln!("prompt() never returned"),
    }
    if let Some(steer_at) = steer_at {
        eprintln!("steer sent at {steer_at:?} after turn start");
    }
    let steered_reply = segments.iter().any(|text| text.contains("STEERED-OK"));
    eprintln!("steer reply observed: {steered_reply}");
    runtime.shutdown().await;
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max / 2).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(max / 2)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{head} …[cut]… {tail}")
}
