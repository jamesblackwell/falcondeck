//! ACP facade for `unreal-agent-runner`, which accepts one JSON request per
//! process and emits native session items as JSONL. The runner remains the
//! owner of session history; this process only translates its live events.

use std::{collections::HashMap, io::Write, path::PathBuf, process::Stdio, sync::Arc};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, mpsc, oneshot},
};
use uuid::Uuid;

use crate::agent_binary::resolve_agent_binary;

/// Pseudo executable in `providers.json`. `AcpRuntime` replaces it with the
/// current FalconDeck executable, so packaged desktop builds work too.
pub const COMMAND: &str = "falcondeck-unreal-agent-acp";

pub fn configured_runner_bin(env: Option<&HashMap<String, String>>) -> String {
    env.and_then(|env| env.get("UNREAL_AGENT_RUNNER_BIN"))
        .cloned()
        .or_else(|| std::env::var("UNREAL_AGENT_RUNNER_BIN").ok())
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| "unreal-agent-runner".to_string())
}

#[derive(Clone)]
struct Session {
    cwd: PathBuf,
    instructions: String,
    model: Option<String>,
}

struct State {
    sessions: HashMap<String, Session>,
    running: HashMap<String, oneshot::Sender<()>>,
}

type SharedState = Arc<Mutex<State>>;
type Sender = mpsc::UnboundedSender<Value>;

fn result(output: &Sender, id: &Value, value: Value) {
    let _ = output.send(json!({ "jsonrpc": "2.0", "id": id, "result": value }));
}

fn error(output: &Sender, id: &Value, message: impl AsRef<str>) {
    let _ = output.send(json!({
        "jsonrpc": "2.0", "id": id,
        "error": { "code": -32000, "message": message.as_ref() }
    }));
}

fn update(output: &Sender, session_id: &str, value: Value) {
    let _ = output.send(json!({
        "jsonrpc": "2.0", "method": "session/update",
        "params": { "sessionId": session_id, "update": value }
    }));
}

fn session_reply(session_id: &str) -> Value {
    let mut reply = json!({
        "sessionId": session_id,
        "configOptions": [{
            "id": "permission", "name": "Tool access", "category": "permission",
            "currentValue": "always-approve",
            "options": [{ "value": "always-approve", "label": "Full access" }]
        }]
    });
    if let Some(model) = advertised_model() {
        reply["models"] = json!({
            "currentModelId": model,
            "availableModels": [{ "id": model, "name": model }]
        });
    }
    reply
}

fn advertised_model() -> Option<String> {
    std::env::var("UNREAL_HARNESS_LLM_MODEL")
        .ok()
        .filter(|model| !model.trim().is_empty())
        .or_else(|| {
            let provider = std::env::var("UNREAL_HARNESS_LLM_PROVIDER").unwrap_or_default();
            (provider.is_empty() || provider == "openai").then(|| "gpt-6-astra".to_string())
        })
}

fn session_file(session: &Session, id: &str) -> PathBuf {
    session
        .cwd
        .join(".harness/sessions")
        .join(format!("{id}.session.jsonl"))
}

fn metadata_file(session: &Session, id: &str) -> PathBuf {
    session
        .cwd
        .join(".harness/sessions")
        .join(format!("{id}.falcondeck.json"))
}

fn runner_path() -> String {
    let bin = configured_runner_bin(None);
    resolve_agent_binary(&bin, &bin).executable
}

/// Called only from the reserved `mcp-unreal-agent-acp` process role.
pub async fn run() -> i32 {
    let state = Arc::new(Mutex::new(State {
        sessions: HashMap::new(),
        running: HashMap::new(),
    }));
    let (output, mut receiver) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = receiver.recv().await {
            let Ok(mut line) = serde_json::to_vec(&value) else {
                continue;
            };
            line.push(b'\n');
            if stdout.write_all(&line).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        handle(message, &state, &output).await;
    }
    for (_, cancel) in state.lock().await.running.drain() {
        let _ = cancel.send(());
    }
    drop(output);
    let _ = writer.await;
    0
}

async fn handle(message: Value, state: &SharedState, output: &Sender) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let id = message.get("id");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            if let Some(id) = id {
                let mut init = json!({
                    "protocolVersion": 1,
                    "agentInfo": { "name": "unreal-agent", "title": "Unreal Agent", "version": "1" },
                    "authMethods": [],
                    "agentCapabilities": {
                        "loadSession": true,
                        "mcpCapabilities": { "http": false, "sse": false },
                        "promptCapabilities": { "image": false }
                    }
                });
                if let Some(model) = advertised_model() {
                    init["models"] = json!([{ "id": model, "name": model, "default": true }]);
                }
                result(output, id, init);
            }
        }
        "session/new" => {
            let Some(id) = id else { return };
            let Some(cwd) = params.get("cwd").and_then(Value::as_str) else {
                error(output, id, "session/new requires cwd");
                return;
            };
            let cwd = PathBuf::from(cwd);
            if !cwd.is_dir() {
                error(output, id, "session/new cwd is not a directory");
                return;
            }
            let session_id = Uuid::new_v4().to_string();
            let session = Session {
                cwd,
                instructions: params
                    .get("instructions")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                model: None,
            };
            if let Err(err) = persist_metadata(&session, &session_id).await {
                error(output, id, err);
                return;
            }
            state
                .lock()
                .await
                .sessions
                .insert(session_id.clone(), session);
            result(output, id, session_reply(&session_id));
        }
        "session/load" => {
            let Some(id) = id else { return };
            let Some(session_id) = valid_session_id(&params) else {
                error(output, id, "session/load requires a UUID sessionId");
                return;
            };
            let Some(cwd) = params.get("cwd").and_then(Value::as_str) else {
                error(output, id, "session/load requires cwd");
                return;
            };
            let cwd = PathBuf::from(cwd);
            let session = match load_metadata(&cwd, &session_id).await {
                Ok(session) => session,
                Err(err) => {
                    error(output, id, err);
                    return;
                }
            };
            let history = match tokio::fs::read_to_string(session_file(&session, &session_id)).await
            {
                Ok(history) => history,
                Err(err) => {
                    error(
                        output,
                        id,
                        format!("Unreal Agent session cannot be loaded: {err}"),
                    );
                    return;
                }
            };
            state
                .lock()
                .await
                .sessions
                .insert(session_id.clone(), session);
            replay(&history, output, &session_id);
            result(output, id, session_reply(&session_id));
        }
        "session/set_model" => {
            let Some(id) = id else { return };
            let Some(session_id) = valid_session_id(&params) else {
                error(output, id, "session/set_model requires a UUID sessionId");
                return;
            };
            let Some(model) = params
                .get("modelId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                error(output, id, "session/set_model requires modelId");
                return;
            };
            let mut state = state.lock().await;
            if let Some(session) = state.sessions.get_mut(&session_id) {
                session.model = Some(model.to_string());
                result(output, id, session_reply(&session_id));
            } else {
                error(output, id, "unknown session");
            }
        }
        "session/set_config_option" => {
            let Some(id) = id else { return };
            let Some(session_id) = valid_session_id(&params) else {
                error(
                    output,
                    id,
                    "session/set_config_option requires a UUID sessionId",
                );
                return;
            };
            if params.get("configId").and_then(Value::as_str) == Some("permission")
                && params.get("value").and_then(Value::as_str) == Some("always-approve")
                && state.lock().await.sessions.contains_key(&session_id)
            {
                result(output, id, session_reply(&session_id));
            } else {
                error(output, id, "Unreal Agent supports full access only");
            }
        }
        "session/prompt" => {
            let Some(id) = id.cloned() else { return };
            let Some(session_id) = valid_session_id(&params) else {
                error(output, &id, "session/prompt requires a UUID sessionId");
                return;
            };
            let Some(blocks) = params.get("prompt").and_then(Value::as_array) else {
                error(output, &id, "session/prompt requires text content");
                return;
            };
            if blocks
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) != Some("text"))
            {
                error(output, &id, "Unreal Agent runner accepts text prompts only");
                return;
            }
            let prompt = blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<String>();
            let mut state_guard = state.lock().await;
            let Some(session) = state_guard.sessions.get(&session_id).cloned() else {
                error(output, &id, "unknown session");
                return;
            };
            if state_guard.running.contains_key(&session_id) {
                error(output, &id, "session already has a running prompt");
                return;
            }
            let (cancel, cancelled) = oneshot::channel();
            state_guard.running.insert(session_id.clone(), cancel);
            drop(state_guard);
            let state = Arc::clone(state);
            let output = output.clone();
            tokio::spawn(async move {
                let outcome = run_prompt(&session, &session_id, &prompt, &output, cancelled).await;
                state.lock().await.running.remove(&session_id);
                match outcome {
                    Ok(stop_reason) => result(&output, &id, json!({ "stopReason": stop_reason })),
                    Err(err) => error(&output, &id, err),
                }
            });
        }
        "session/cancel" => {
            if let Some(session_id) = valid_session_id(&params)
                && let Some(cancel) = state.lock().await.running.remove(&session_id)
            {
                let _ = cancel.send(());
            }
            if let Some(id) = id {
                result(output, id, json!({}));
            }
        }
        "session/delete" => {
            if let Some(session_id) = valid_session_id(&params) {
                if let Some(session) = state.lock().await.sessions.remove(&session_id) {
                    // Discovery sessions never run the native harness. Remove
                    // only their adapter metadata; completed history belongs
                    // to the runner and must remain resumable.
                    if !session_file(&session, &session_id).exists() {
                        let _ = tokio::fs::remove_file(metadata_file(&session, &session_id)).await;
                    }
                }
            }
            if let Some(id) = id {
                result(output, id, json!({}));
            }
        }
        _ => {
            if let Some(id) = id {
                error(output, id, format!("unsupported ACP method {method}"));
            }
        }
    }
}

fn valid_session_id(params: &Value) -> Option<String> {
    let id = params.get("sessionId")?.as_str()?;
    Uuid::parse_str(id).ok().map(|_| id.to_string())
}

async fn persist_metadata(session: &Session, id: &str) -> Result<(), String> {
    let path = metadata_file(session, id);
    std::fs::create_dir_all(path.parent().expect("metadata has parent"))
        .map_err(|err| format!("cannot create Unreal Agent session directory: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            path.parent().expect("metadata has parent"),
            std::fs::Permissions::from_mode(0o700),
        )
        .map_err(|err| format!("cannot secure Unreal Agent session directory: {err}"))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|err| format!("cannot create Unreal Agent session metadata: {err}"))?;
    file.write_all(
        json!({ "instructions": session.instructions })
            .to_string()
            .as_bytes(),
    )
    .map_err(|err| format!("cannot save Unreal Agent session metadata: {err}"))
}

async fn load_metadata(cwd: &std::path::Path, id: &str) -> Result<Session, String> {
    let mut session = Session {
        cwd: cwd.to_path_buf(),
        instructions: String::new(),
        model: None,
    };
    let body = tokio::fs::read_to_string(metadata_file(&session, id))
        .await
        .map_err(|err| format!("Unreal Agent session metadata cannot be loaded: {err}"))?;
    let metadata: Value = serde_json::from_str(&body)
        .map_err(|err| format!("Unreal Agent session metadata is invalid: {err}"))?;
    session.instructions = metadata
        .get("instructions")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(session)
}

async fn run_prompt(
    session: &Session,
    session_id: &str,
    prompt: &str,
    output: &Sender,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<&'static str, String> {
    let mut request = json!({ "prompt": prompt, "session_id": session_id });
    request["system_prompt"] = json!(format!(
        "You are an AI coding agent working in the user's project.\n\n{}",
        session.instructions
    ));
    if let Some(model) = &session.model {
        request["model"] = json!(model);
    }

    let mut child = Command::new(runner_path())
        .arg("-workspace")
        .arg(&session.cwd)
        .arg("-session-directory")
        .arg(session.cwd.join(".harness/sessions"))
        .arg("-log-directory")
        .arg(session.cwd.join(".harness/logs"))
        .current_dir(&session.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("cannot launch unreal-agent-runner: {err}"))?;
    let mut stdin = child.stdin.take().ok_or("runner stdin unavailable")?;
    stdin
        .write_all(request.to_string().as_bytes())
        .await
        .map_err(|err| format!("cannot send Unreal Agent prompt: {err}"))?;
    drop(stdin);
    let stdout = child.stdout.take().ok_or("runner stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("runner stderr unavailable")?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr.take(65_536).read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).trim().to_string()
    });
    let mut lines = BufReader::new(stdout).lines();
    let mut reported_error = None;
    loop {
        tokio::select! {
            _ = &mut cancelled => {
                let _ = child.kill().await;
                return Ok("cancelled");
            }
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    if let Ok(item) = serde_json::from_str::<Value>(&line) {
                        if item.get("type").and_then(Value::as_str) == Some("error") {
                            reported_error = item.get("message").and_then(Value::as_str).map(str::to_string);
                        } else {
                            if let Some(message) = item.pointer("/Data/Response/Failure/Message").and_then(Value::as_str) {
                                reported_error = Some(message.to_string());
                            }
                            project_item(&item, output, session_id, false);
                        }
                    }
                }
                Ok(None) => break,
                Err(err) => return Err(format!("cannot read Unreal Agent output: {err}")),
            }
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|err| format!("cannot wait for Unreal Agent: {err}"))?;
    if status.success() && reported_error.is_none() {
        return Ok("end_turn");
    }
    let stderr = stderr_task.await.unwrap_or_default();
    Err(reported_error.unwrap_or_else(|| {
        if stderr.is_empty() {
            format!("Unreal Agent exited with {status}")
        } else {
            format!("Unreal Agent exited with {status}: {stderr}")
        }
    }))
}

fn replay(history: &str, output: &Sender, session_id: &str) {
    for line in history.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) == Some("item") {
            if let Some(item) = record.pointer("/data/Item") {
                project_item(item, output, session_id, true);
            }
        }
    }
}

fn project_item(item: &Value, output: &Sender, session_id: &str, replaying: bool) {
    match item.get("Kind").and_then(Value::as_str) {
        Some("input")
            if replaying
                && item.pointer("/Data/Kind").and_then(Value::as_str) == Some("external") =>
        {
            if let Some(text) = item.pointer("/Data/Payload").and_then(Value::as_str) {
                update(
                    output,
                    session_id,
                    json!({ "sessionUpdate": "user_message_chunk", "messageId": item.pointer("/Data/ID").and_then(Value::as_str), "content": { "type": "text", "text": text } }),
                );
            }
        }
        Some("model_response") => {
            if let Some(items) = item
                .pointer("/Data/Response/Output")
                .and_then(Value::as_array)
            {
                for part in items {
                    match part.get("Type").and_then(Value::as_str) {
                        Some("message")
                            if part.pointer("/Data/Role").and_then(Value::as_str)
                                == Some("assistant") =>
                        {
                            if let Some(text) = part
                                .pointer("/Data/Text")
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty())
                            {
                                let kind = if part.pointer("/Data/Phase").and_then(Value::as_str)
                                    == Some("analysis")
                                {
                                    "agent_thought_chunk"
                                } else {
                                    "agent_message_chunk"
                                };
                                update(
                                    output,
                                    session_id,
                                    json!({ "sessionUpdate": kind, "messageId": part.get("ProviderID").and_then(Value::as_str), "content": { "type": "text", "text": text } }),
                                );
                            }
                        }
                        Some("reasoning") => {
                            if let Some(summary) =
                                part.pointer("/Data/Summary").and_then(Value::as_array)
                            {
                                for text in summary.iter().filter_map(Value::as_str) {
                                    update(
                                        output,
                                        session_id,
                                        json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": text } }),
                                    );
                                }
                            }
                        }
                        Some("tool_call") => {
                            if let (Some(call_id), Some(name)) = (
                                part.pointer("/Data/CallID").and_then(Value::as_str),
                                part.pointer("/Data/Name").and_then(Value::as_str),
                            ) {
                                update(
                                    output,
                                    session_id,
                                    json!({ "sessionUpdate": "tool_call", "toolCallId": call_id, "title": name, "kind": "execute", "status": "in_progress" }),
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        Some("tool_call_status") => {
            if let Some(call_id) = item.pointer("/Data/CallID").and_then(Value::as_str) {
                let failed = item
                    .pointer("/Data/Status/Error")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty());
                let settled = failed
                    || item
                        .pointer("/Data/Operations")
                        .and_then(Value::as_array)
                        .is_some_and(|ops| {
                            !ops.is_empty()
                                && ops.iter().all(|op| {
                                    op.get("Status").and_then(Value::as_str) == Some("completed")
                                })
                        });
                if settled {
                    update(
                        output,
                        session_id,
                        json!({ "sessionUpdate": "tool_call_update", "toolCallId": call_id, "status": if failed { "failed" } else { "completed" } }),
                    );
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_native_messages_and_tools() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        project_item(
            &json!({ "Kind": "model_response", "Data": { "Response": { "Output": [
            { "Type": "message", "Data": { "Role": "assistant", "Text": "hello" } },
            { "Type": "tool_call", "Data": { "CallID": "one", "Name": "Bash" } }
        ] } } }),
            &tx,
            "session",
            false,
        );
        assert_eq!(
            rx.try_recv()
                .unwrap()
                .pointer("/params/update/sessionUpdate")
                .and_then(Value::as_str),
            Some("agent_message_chunk")
        );
        assert_eq!(
            rx.try_recv()
                .unwrap()
                .pointer("/params/update/toolCallId")
                .and_then(Value::as_str),
            Some("one")
        );
    }
}
