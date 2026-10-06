use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
};

use chrono::Utc;
use falcondeck_core::{
    AgentProvider, InteractiveResponsePayload, ThreadStatus, TurnInputItem, WorkspaceStatus,
    WorkspaceSummary,
};
use serde_json::json;
use tempfile::TempDir;
use tokio::{
    sync::mpsc,
    time::{Duration, timeout},
};

use crate::{
    acp::{AcpEvent, AcpProviderConfig, AcpRuntime, ProviderTransport},
    app::{AppState, ManagedWorkspace},
    connectors::BuiltinConnectors,
};

async fn fixture() -> (
    TempDir,
    AppState,
    Arc<AcpRuntime>,
    mpsc::UnboundedReceiver<AcpEvent>,
    String,
) {
    let temp = tempfile::tempdir().unwrap();
    let app = AppState::new_with_state_path(
        "test".into(),
        HashMap::new(),
        temp.path().join("state.json"),
    );
    let provider = AgentProvider::new("hermes");
    let path = temp.path().to_string_lossy().into_owned();
    let (sender, receiver) = mpsc::unbounded_channel();
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hermes_phase2_agent.mjs");
    let runtime = AcpRuntime::connect(
        AcpProviderConfig {
            id: "hermes".into(),
            label: "Hermes".into(),
            command: vec!["node".into(), script.to_string_lossy().into_owned()],
            env: HashMap::new(),
            transport: ProviderTransport::Acp,
        },
        &path,
        sender,
    )
    .await
    .unwrap();
    runtime
        .ensure_workspace_metadata(&path, &BuiltinConnectors::default())
        .await
        .unwrap();
    let session = runtime
        .ensure_session(
            "thread",
            None,
            &path,
            None,
            &BuiltinConnectors::default(),
            None,
            None,
        )
        .await
        .unwrap();
    app.inner.workspaces.lock().await.insert(
        "workspace".into(),
        ManagedWorkspace {
            summary: WorkspaceSummary {
                id: "workspace".into(),
                path,
                kind: falcondeck_core::WorkspaceKind::Project,
                status: WorkspaceStatus::Ready,
                agents: vec![],
                skills: vec![],
                default_provider: provider.clone(),
                models: vec![],
                collaboration_modes: vec![],
                account: Default::default(),
                current_thread_id: Some("thread".into()),
                connected_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
                icon: None,
            },
            codex_session: None,
            claude_runtime: None,
            agy_runtime: None,
            opencode_runtime: None,
            acp_runtimes: HashMap::from([(provider.clone(), runtime.clone())]),
            threads: HashMap::new(),
        },
    );
    app.upsert_thread("workspace", "thread", |thread| {
        thread.provider = provider;
        thread.native_session_id = Some(session.clone());
        thread.agent.permission_mode = Some("default".into());
        thread.agent.model_id = Some("openai-codex:gpt-5.6-luna".into());
        thread.status = ThreadStatus::Running;
    })
    .await
    .unwrap();
    (temp, app, runtime, receiver, session)
}

#[tokio::test]
async fn rejected_models_never_start_a_prompt_or_replace_the_saved_selection() {
    let (_temp, app, runtime, _events, session) = fixture().await;
    app.with_thread_mut("workspace", "thread", |thread| {
        thread.status = ThreadStatus::Idle;
    })
    .await
    .unwrap();
    assert!(
        super::set_hermes_thread_model(&app, "workspace", "thread", &Some("invalid:model".into()))
            .await
            .is_err()
    );
    assert_eq!(
        app.thread_summary("workspace", "thread")
            .await
            .unwrap()
            .agent
            .model_id
            .as_deref(),
        Some("openai-codex:gpt-5.6-luna")
    );
    app.with_thread_mut("workspace", "thread", |thread| {
        thread.agent.model_id = Some("invalid:model".into());
        thread.status = ThreadStatus::Running;
    })
    .await
    .unwrap();
    let result = super::start_acp_turn(
        &app,
        "workspace",
        "thread",
        &AgentProvider::new("hermes"),
        &[TurnInputItem::Text {
            id: None,
            text: "Must not execute".into(),
        }],
        &[],
        super::AcpTurnStartOptions {
            wait_for_startup: true,
            resume_interrupted: false,
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(
        app.thread_summary("workspace", "thread")
            .await
            .unwrap()
            .agent
            .model_id,
        runtime.session_model_id(&session).await
    );
    assert_eq!(
        runtime.request("probe/state", json!({})).await.unwrap()["promptCount"],
        0
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn approval_queue_preserves_exact_choices_and_settles_every_completion_path() {
    for action in ["exact", "full-access", "cancel", "timeout", "disconnect"] {
        let (_temp, app, runtime, mut events, session) = fixture().await;
        if action == "full-access" {
            app.with_thread_mut("workspace", "thread", |thread| {
                thread.agent.permission_mode = Some("always-approve".into());
            })
            .await
            .unwrap();
        }
        let r = runtime.clone();
        let s = session.clone();
        let text = if matches!(action, "timeout" | "disconnect") {
            action
        } else {
            "permission"
        };
        let prompt =
            tokio::spawn(
                async move { r.prompt(&s, vec![json!({"type":"text","text":text})]).await },
            );
        let mut replay = HashSet::new();
        let request = loop {
            let event = timeout(Duration::from_secs(5), events.recv())
                .await
                .unwrap()
                .unwrap();
            let request = match &event {
                AcpEvent::PermissionRequest { request_id, .. } => Some(request_id.clone()),
                _ => None,
            };
            app.apply_acp_event("workspace", &runtime, event, &mut replay)
                .await
                .unwrap();
            if let Some(request) = request {
                break request;
            }
        };
        match action {
            "exact" => {
                let pending = app.inner.interactive_requests.lock().await;
                let offered = pending[&("workspace".into(), request.clone())]
                    .request
                    .approval_options
                    .as_ref()
                    .unwrap();
                assert_eq!(offered.len(), 4);
                drop(pending);
                crate::app::workspace_ops::respond_to_interactive_request(
                    &app,
                    "workspace".into(),
                    request.clone(),
                    InteractiveResponsePayload::ApprovalOption {
                        option_id: format!("{session}:d"),
                    },
                )
                .await
                .unwrap();
            }
            "cancel" => runtime.cancel(&session).await.unwrap(),
            "full-access" => assert!(app.inner.interactive_requests.lock().await.is_empty()),
            _ => {}
        }
        loop {
            let event = timeout(Duration::from_secs(5), events.recv())
                .await
                .unwrap()
                .unwrap();
            let ended = matches!(event, AcpEvent::TurnEnded { .. });
            app.apply_acp_event("workspace", &runtime, event, &mut replay)
                .await
                .unwrap();
            if ended {
                break;
            }
        }
        let outcome = timeout(Duration::from_secs(5), prompt)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.is_err(), action == "disconnect");
        assert!(app.inner.interactive_requests.lock().await.is_empty());
        if matches!(action, "exact" | "full-access") {
            let state = runtime.request("probe/state", json!({})).await.unwrap();
            let suffix = if action == "exact" { "d" } else { "a" };
            assert_eq!(
                state["responses"][0]["result"]["outcome"]["optionId"],
                format!("{session}:{suffix}")
            );
        }
        runtime.shutdown().await;
    }
}
