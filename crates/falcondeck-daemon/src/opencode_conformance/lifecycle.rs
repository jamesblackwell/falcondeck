use std::{collections::HashMap, sync::Arc, time::Duration};

use reqwest::Method;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{ProbeOptions, Report};
use crate::{
    error::DaemonError,
    opencode::{Delivery, OpenCodeRuntime},
};

pub(super) async fn probe_interactions(
    runtime: &Arc<OpenCodeRuntime>,
    cwd: &str,
    report: &mut Report,
) {
    let outcome = async {
        let session = runtime.create_session(cwd, None, Some("build")).await?;
        let checked = async {
            qualify_permissions(runtime, &session).await?;
            qualify_form(runtime, &session).await
        }
        .await;
        let _ = runtime.interrupt(&session).await;
        runtime.delete_session(&session).await;
        checked
    }
    .await;
    report.record(
        "permission allow/deny and typed form replies",
        outcome,
        |()| "requests settle; labels map to typed field values".into(),
    );
}

async fn qualify_permissions(
    runtime: &Arc<OpenCodeRuntime>,
    session: &str,
) -> Result<(), DaemonError> {
    runtime
        .request(
            Method::PATCH,
            &format!("/api/session/{session}"),
            Some(json!({"permissions":[
                {"action":"falcondeck-qualification","resource":"*","effect":"ask"}
            ]})),
        )
        .await?;
    for decision in ["once", "reject"] {
        let request_id = format!("per_{}", Uuid::new_v4().simple());
        let ask_runtime = Arc::clone(runtime);
        let ask_session = session.to_owned();
        let id = request_id.clone();
        let asking = tokio::spawn(async move {
            ask_runtime
                .request(
                    Method::POST,
                    &format!("/api/session/{ask_session}/permission"),
                    Some(
                        json!({"id":id,"action":"falcondeck-qualification","resources":["probe"]}),
                    ),
                )
                .await
        });
        let reply = async {
            until(|| async {
                Ok(runtime
                    .pending_permissions(session)
                    .await?
                    .iter()
                    .any(|p| p["id"] == request_id))
            })
            .await?;
            runtime
                .reply_permission(session, &request_id, decision)
                .await
        }
        .await;
        if reply.is_err() {
            asking.abort();
        }
        reply?;
        asking
            .await
            .map_err(|e| DaemonError::Process(e.to_string()))??;
        if !runtime.pending_permissions(session).await?.is_empty() {
            return Err(DaemonError::Rpc(
                "Permission reply left a pending request".into(),
            ));
        }
    }
    Ok(())
}

async fn qualify_form(runtime: &OpenCodeRuntime, session: &str) -> Result<(), DaemonError> {
    let form = runtime
        .request(
            Method::POST,
            &format!("/api/session/{session}/form"),
            Some(json!({"title":"FalconDeck qualification", "fields":[
                {"key":"choice","type":"string","required":true,"options":[{"label":"Friendly label","value":"internal-value"}]},
                {"key":"count","type":"integer","required":true},
                {"key":"amount","type":"number","required":true},
                {"key":"dependent","type":"string","required":true,"when":[{"key":"amount","op":"eq","value":3}]},
                {"key":"enabled","type":"boolean","required":true},
                {"key":"tags","type":"multiselect","required":true,"options":[{"label":"One","value":"one"}]}
            ]})),
        )
        .await?;
    let id = form
        .pointer("/data/id")
        .and_then(Value::as_str)
        .ok_or_else(|| DaemonError::Rpc("Form create returned no id".into()))?;
    if !runtime
        .pending_questions(session)
        .await?
        .iter()
        .any(|f| f["id"] == id)
    {
        return Err(DaemonError::Rpc("Created form was not listed".into()));
    }
    runtime
        .reply_question(
            session,
            id,
            vec![
                vec!["Friendly label".into()],
                vec!["3.0".into()],
                vec!["3.0".into()],
                vec!["active".into()],
                vec!["false".into()],
                vec!["One".into()],
            ],
        )
        .await?;
    if !runtime.pending_questions(session).await?.is_empty() {
        return Err(DaemonError::Rpc("Form reply left a pending form".into()));
    }
    Ok(())
}

pub(super) async fn probe_execution(
    runtime: &Arc<OpenCodeRuntime>,
    options: &ProbeOptions,
    cwd: &str,
    model: &str,
    report: &mut Report,
) {
    let outcome = async {
        let session = runtime
            .create_session(cwd, Some(model), Some("build"))
            .await?;
        let checked = qualify_execution(runtime, options, cwd, model, &session).await;
        let _ = runtime.interrupt(&session).await;
        runtime.delete_session(&session).await;
        checked
    }
    .await;
    report.record("native execution lifecycle", outcome, |detail| detail);
}

async fn qualify_execution(
    runtime: &OpenCodeRuntime,
    options: &ProbeOptions,
    cwd: &str,
    model: &str,
    session: &str,
) -> Result<String, DaemonError> {
    let models = runtime.runner_models().await?;
    let variant = models
        .get(model)
        .and_then(|model| {
            model
                .variants
                .iter()
                .find(|v| *v == "low")
                .or_else(|| model.variants.first())
        })
        .map(String::as_str);
    runtime.set_model(session, model, variant).await?;
    let info = runtime
        .request(Method::GET, &format!("/api/session/{session}"), None)
        .await?;
    if info.pointer("/data/model/variant").and_then(Value::as_str) != variant {
        return Err(DaemonError::Rpc(
            "Selected reasoning variant was not retained".into(),
        ));
    }
    runtime
        .request(
            Method::PATCH,
            &format!("/api/session/{session}"),
            Some(json!({
                "permissions":[{"action":"*","resource":"*","effect":"allow"}]
            })),
        )
        .await?;
    let first = message_id();
    runtime.prompt(session, &first,
        "Use the shell tool to run `sleep 5; printf FALCONDECK_TOOL_OK` in the foreground. Do not delegate or run it in the background. After it finishes, follow the latest user instruction.",
        &[], Delivery::Queue).await?;
    await_running_tool(runtime, session, &first).await?;
    let steer = message_id();
    for _ in 0..2 {
        runtime
            .prompt(
                session,
                &steer,
                "After the shell finishes, reply with exactly FALCONDECK_STEER_OK.",
                &[],
                Delivery::Steer,
            )
            .await?;
    }
    let messages = wait(runtime, session, &first).await?;
    let has_tool = messages.iter().any(|m| {
        m["content"].as_array().is_some_and(|parts| {
            parts.iter().any(|p| {
                p["type"] == "tool"
                    && p["state"]["status"] == "completed"
                    && p["state"]["content"]
                        .to_string()
                        .contains("FALCONDECK_TOOL_OK")
            })
        })
    });
    let has_reply = messages.iter().any(|m| {
        m["type"] == "assistant" && m["content"].to_string().contains("FALCONDECK_STEER_OK")
    });
    let history = runtime.messages(session).await?;
    if !has_tool || !has_reply || history.iter().filter(|m| m["id"] == steer).count() != 1 {
        return Err(DaemonError::Rpc(
            "Steering, tool completion, or idempotent admission did not match".into(),
        ));
    }
    let count = qualify_history(runtime, options, cwd, session, &first).await?;
    qualify_interruption(runtime, session).await?;
    Ok(format!(
        "{model}; variant={variant:?}; tool, steer deduplication, {count}-message reload and interrupt passed"
    ))
}

async fn qualify_history(
    runtime: &OpenCodeRuntime,
    options: &ProbeOptions,
    cwd: &str,
    session: &str,
    first: &str,
) -> Result<usize, DaemonError> {
    // Steered inputs promote together; queued inputs would each run a model turn.
    // Cross the page cap with agent-owned records and drain in one model call.
    for index in 0..205 {
        runtime
            .request(
                Method::POST,
                &format!("/api/session/{session}/synthetic"),
                Some(json!({
                    "id": message_id(), "text":format!("History pagination qualification {index}"),
                    "delivery":"steer", "resume":false
                })),
            )
            .await?;
    }
    let prompt = message_id();
    runtime
        .prompt(
            session,
            &prompt,
            "The preceding synthetic messages are pagination test data. Reply exactly HISTORY_OK.",
            &[],
            Delivery::Steer,
        )
        .await?;
    wait(runtime, session, &prompt).await?;
    let history = runtime.messages(session).await?;
    let since = runtime.messages_since(session, first).await?;
    if history.len() <= 200 || since.iter().filter(|m| m["type"] == "synthetic").count() != 205 {
        return Err(DaemonError::Rpc(
            "Native history pagination dropped records".into(),
        ));
    }
    let reloaded = OpenCodeRuntime::spawn(&options.command, cwd, &HashMap::new()).await?;
    let restored = reloaded.messages(session).await;
    reloaded.shutdown().await;
    if restored? != history {
        return Err(DaemonError::Rpc(
            "Native history changed across server reload".into(),
        ));
    }
    Ok(history.len())
}

async fn qualify_interruption(runtime: &OpenCodeRuntime, session: &str) -> Result<(), DaemonError> {
    let stop = message_id();
    runtime.prompt(session, &stop,
        "Use the shell tool to run `sleep 20` in the foreground. Do not delegate or background it.",
        &[], Delivery::Queue).await?;
    await_running_tool(runtime, session, &stop).await?;
    runtime.interrupt(session).await?;
    let stopped = tokio::time::timeout(
        Duration::from_secs(15),
        runtime.wait_until_idle(session, &stop),
    )
    .await
    .map_err(|_| DaemonError::Rpc("Interrupted turn did not settle".into()))?;
    if !matches!(stopped, Err(ref error) if error.to_string().to_ascii_lowercase().contains("interrupt"))
    {
        return Err(DaemonError::Rpc(
            "Interrupted turn was not classified as interrupted".into(),
        ));
    }
    Ok(())
}

async fn await_running_tool(
    runtime: &OpenCodeRuntime,
    session: &str,
    prompt: &str,
) -> Result<(), DaemonError> {
    until(|| async {
        let messages = runtime.messages(session).await?;
        // Admission precedes projection; wait for the anchor before inspecting
        // tools so the first poll cannot mistake this normal gap for failure.
        Ok(messages
            .iter()
            .position(|m| m["id"] == prompt)
            .is_some_and(|index| {
                messages[index + 1..].iter().any(|m| {
                    m["content"].as_array().is_some_and(|parts| {
                        parts
                            .iter()
                            .any(|p| p["type"] == "tool" && p["state"]["status"] == "running")
                    })
                })
            }))
    })
    .await
}

async fn wait(
    runtime: &OpenCodeRuntime,
    session: &str,
    prompt: &str,
) -> Result<Vec<Value>, DaemonError> {
    tokio::time::timeout(
        Duration::from_secs(90),
        runtime.wait_until_idle(session, prompt),
    )
    .await
    .map_err(|_| DaemonError::Rpc("Native qualification turn timed out".into()))?
}

fn message_id() -> String {
    format!("msg_{}", Uuid::new_v4().simple())
}

async fn until<F, Fut>(mut check: F) -> Result<(), DaemonError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<bool, DaemonError>>,
{
    tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            if check().await? {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| DaemonError::Rpc("Timed out waiting for a native lifecycle transition".into()))?
}
