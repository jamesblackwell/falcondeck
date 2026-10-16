//! Coordinator reads: thread summaries, change feeds, and role-filtered views.
use super::*;

const SUMMARY: &str = "falcondeck_thread_summary";
const CHANGES: &str = "falcondeck_thread_changes";

fn at(minutes_ago: i64) -> chrono::DateTime<Utc> {
    Utc::now() - chrono::Duration::minutes(minutes_ago)
}

fn item(value: Value) -> ConversationItem {
    serde_json::from_value(value).unwrap()
}

fn command(
    id: &str,
    command: &str,
    output: &str,
    exit_code: i32,
    minutes_ago: i64,
) -> ConversationItem {
    item(json!({
        "kind":"tool_call", "id":id, "title":command, "tool_kind":"command",
        "status":"completed", "output":output, "exit_code":exit_code,
        "detail":{"kind":"command_execution","command":command,"cwd":"/tmp"},
        "created_at":at(minutes_ago)
    }))
}

async fn add_thread(
    app: &AppState,
    id: &str,
    title: &str,
    status: ThreadStatus,
    updated_minutes_ago: i64,
    items: Vec<ConversationItem>,
) {
    let mut workspaces = app.inner.workspaces.lock().await;
    let ws = workspaces.get_mut("workspace-1").unwrap();
    let mut summary = ws.threads["thread-1"].summary.clone();
    summary.id = id.into();
    summary.title = title.into();
    summary.status = status;
    summary.native_session_id = None;
    summary.updated_at = at(updated_minutes_ago);
    let mut thread = ManagedThread::new(summary);
    thread.items = items;
    ws.threads.insert(id.into(), thread);
}

async fn add_pending(app: &AppState, thread: &str, kind: &str, title: &str, command: Option<&str>) {
    let request: falcondeck_core::InteractiveRequest = serde_json::from_value(json!({
        "request_id": format!("req-{thread}-{kind}"), "workspace_id":"workspace-1", "thread_id":thread,
        "method":"item/commandExecution/requestApproval", "kind":kind, "title":title,
        "detail":null, "command":command, "path":null, "turn_id":null, "item_id":null,
        "questions": if kind == "question" {
            json!([{"id":"q1","header":"Pick","question":"Which database should I use?","is_other":false,"is_secret":false,"options":null}])
        } else { json!([]) },
        "created_at":Utc::now()
    }))
    .unwrap();
    app.inner.interactive_requests.lock().await.insert(
        ("workspace-1".into(), request.request_id.clone()),
        super::super::super::PendingServerRequest {
            raw_id: json!(1),
            request,
            params: json!({}),
        },
    );
}

async fn text(app: &AppState, name: &str, arguments: Value) -> String {
    app.invoke_extension_tool(call(name, arguments))
        .await
        .unwrap()
        .result
        .as_str()
        .unwrap()
        .to_string()
}

fn worker_items(root: &str) -> Vec<ConversationItem> {
    vec![
        item(
            json!({"kind":"user_message","id":"u-old","text":"earlier request","attachments":[],"created_at":at(120)}),
        ),
        item(
            json!({"kind":"assistant_message","id":"a-old","text":"earlier reply","created_at":at(119)}),
        ),
        item(
            json!({"kind":"user_message","id":"u1","text":"Fix the sync bug and commit","attachments":[],"created_at":at(30)}),
        ),
        item(
            json!({"kind":"tool_call","id":"e1","title":"Edit src/sync.rs","tool_kind":"Edit","status":"completed","created_at":at(29)}),
        ),
        item(
            json!({"kind":"file_change","id":"f1","status":"completed","changes":[
            {"path":format!("{root}/src/lib.rs"),"change_kind":"update","diff":"+x"},
            {"path":"src/old.rs","change_kind":"rename","move_path":"src/new.rs","diff":""}
        ],"created_at":at(28)}),
        ),
        command(
            "t1",
            "cargo test -p falcondeck-daemon",
            "test result: FAILED",
            101,
            27,
        ),
        command(
            "t2",
            "cargo test -p falcondeck-daemon",
            "test result: ok",
            0,
            26,
        ),
        command(
            "c1",
            "npx tsc --noEmit -p apps/desktop/tsconfig.app.json",
            "",
            0,
            25,
        ),
        command(
            "r1",
            ".agents/skills/autoreview/scripts/autoreview --mode local",
            "clean",
            0,
            24,
        ),
        command(
            "g1",
            "git commit -m 'Fix sync'",
            "[main 2896d18] Fix sync replay\n 2 files changed",
            0,
            23,
        ),
        item(
            json!({"kind":"assistant_message","id":"a1","text":"Fixed the replay bug and committed 2896d18.","created_at":at(22)}),
        ),
    ]
}

#[tokio::test]
async fn summary_digests_outcome_files_commits_checks_and_attention() {
    let (app, _temp) = fixture().await;
    let root = app.inner.workspaces.lock().await["workspace-1"]
        .summary
        .path
        .clone();
    add_thread(
        &app,
        "worker",
        "Sync fix",
        ThreadStatus::WaitingForInput,
        20,
        worker_items(&root),
    )
    .await;
    add_pending(
        &app,
        "worker",
        "approval",
        "Run command",
        Some("git push origin main"),
    )
    .await;

    let out = text(&app, SUMMARY, json!({"thread_id":"worker"})).await;
    for part in [
        "## Sync fix",
        "ATTENTION: waiting on approval \"Run command\" (git push origin main) — resolve in FalconDeck UI.",
        "Status: waiting_for_input",
        "Last user request (",
        "Fix the sync bug and commit",
        "Fixed the replay bug and committed 2896d18.",
        "Files changed (3): src/lib.rs, src/old.rs -> src/new.rs, src/sync.rs",
        "Commits (1): 2896d18 Fix sync replay",
        "tests passed at",
        "2 runs",
        "typecheck passed",
        "autoreview passed",
        "Transcript: scanned 11 items (complete)",
    ] {
        assert!(out.contains(part), "missing {part:?} in\n{out}");
    }
    assert!(!out.contains(&format!("{root}/src/lib.rs")), "{out}");
    assert!(!out.contains("earlier request"), "{out}");

    // One question, several ids, deduped; the ordinary thread has no flag.
    add_pending(&app, "worker", "question", "Question", None).await;
    let out = text(
        &app,
        SUMMARY,
        json!({"thread_id":"worker","thread_ids":["worker","thread-1"]}),
    )
    .await;
    assert_eq!(out.matches("## Sync fix").count(), 1, "{out}");
    assert!(
        out.contains("waiting on user question \"Question\" (Which database should I use?)"),
        "{out}"
    );
    assert_eq!(out.matches("ATTENTION").count(), 1, "{out}");
    assert!(out.contains("## Auth setup"), "{out}");
}

#[tokio::test]
async fn summary_without_loaded_items_stays_cheap_and_bounded() {
    let (app, _temp) = fixture().await;
    app.with_thread_mut("workspace-1", "thread-1", |t| {
        t.last_message_preview = Some("cached preview".into());
        t.last_error = Some("provider exited".into());
        t.status = ThreadStatus::Error;
    })
    .await
    .unwrap();
    let out = text(&app, SUMMARY, json!({"thread_ids":["thread-1"]})).await;
    for part in [
        "ATTENTION: errored: provider exited",
        "Last preview: cached preview",
        "Error: provider exited",
        "Transcript: not loaded",
    ] {
        assert!(out.contains(part), "missing {part:?} in\n{out}");
    }
    for i in 0..20 {
        add_thread(
            &app,
            &format!("t{i}"),
            &"long title ".repeat(30),
            ThreadStatus::Idle,
            1,
            vec![assistant("a", &"x".repeat(5000))],
        )
        .await;
    }
    let ids: Vec<_> = (0..20).map(|i| format!("t{i}")).collect();
    let out = text(&app, SUMMARY, json!({"thread_ids":ids,"max_chars":2000})).await;
    assert!(out.chars().count() <= 2000, "{}", out.chars().count());
    let ids: Vec<_> = (0..21).map(|i| format!("t{i}")).collect();
    for arguments in [
        json!({}),
        json!({"thread_ids":[]}),
        json!({"thread_ids":ids}),
        json!({"thread_id":" "}),
        json!({"thread_id":"missing"}),
        json!({"thread_id":"thread-1","role":"user"}),
    ] {
        assert!(
            app.invoke_extension_tool(call(SUMMARY, arguments))
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn changes_lists_recent_activity_with_deltas_and_flags_blocked_first() {
    let (app, _temp) = fixture().await;
    let root = app.inner.workspaces.lock().await["workspace-1"]
        .summary
        .path
        .clone();
    add_thread(
        &app,
        "worker",
        "Sync fix",
        ThreadStatus::Idle,
        20,
        worker_items(&root),
    )
    .await;
    add_thread(
        &app,
        "blocked",
        "Needs approval",
        ThreadStatus::WaitingForInput,
        50,
        vec![],
    )
    .await;
    add_pending(&app, "blocked", "approval", "Edit file", None).await;
    add_thread(&app, "stale", "Old work", ThreadStatus::Idle, 600, vec![item(json!({"kind":"user_message","id":"s1","text":"old stuff","attachments":[],"created_at":at(600)}))]).await;
    add_thread(&app, "archived", "Archived", ThreadStatus::Idle, 5, vec![]).await;
    app.with_thread_mut("workspace-1", "archived", |t| t.is_archived = true)
        .await
        .unwrap();

    let out = text(&app, CHANGES, json!({"since":"45m"})).await;
    let blocked = out.find("Needs approval").expect(&out);
    let worker = out.find("Sync fix").expect(&out);
    assert!(blocked < worker, "{out}");
    assert!(
        out.contains("**ATTENTION: waiting on approval \"Edit file\""),
        "{out}"
    );
    assert!(out.contains("(`worker`) — idle"), "{out}");
    // Only the window's items count: the old user/assistant pair is excluded.
    assert!(
        out.contains("1 user msg, 1 assistant msg, 3 files, 1 commit, autoreview passed, typecheck passed, tests passed, 1 failed tool(s); last reply: Fixed the replay bug"),
        "{out}"
    );
    for absent in ["Old work", "Archived", "Auth setup"] {
        assert!(!out.contains(absent), "{absent} in\n{out}");
    }
    assert!(out.contains("Changed: 2 of"), "{out}");
    let now = out
        .lines()
        .find_map(|l| l.strip_prefix("Now: "))
        .and_then(|l| l.split_whitespace().next())
        .unwrap()
        .to_string();
    let later = text(&app, CHANGES, json!({"since":now})).await;
    assert!(
        later.contains("Changed: 0 of") && later.contains("No thread activity"),
        "{later}"
    );
    let archived = text(&app, CHANGES, json!({"since":"1h","include_archived":true})).await;
    assert!(archived.contains("Archived"), "{archived}");
    for arguments in [
        json!({}),
        json!({"since":"soon"}),
        json!({"since":"1h","thread_id":"x"}),
    ] {
        assert!(
            app.invoke_extension_tool(call(CHANGES, arguments))
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn view_role_returns_final_assistant_message_with_timestamps_and_flags() {
    let (app, _temp) = fixture().await;
    let long = format!("Final outcome: {}", "detail ".repeat(400));
    set_items(
        &app,
        vec![
            user("u1", "question"),
            assistant("a1", "interim"),
            item(json!({"kind":"tool_call","id":"t1","title":"exec","tool_kind":"command","status":"completed","created_at":at(1)})),
            item(json!({"kind":"assistant_message","id":"a2","text":long,"created_at":"2026-10-16T09:15:00Z"})),
            user("u2", "follow-up"),
        ],
    )
    .await;
    let out = text(
        &app,
        VIEW,
        json!({"thread_id":"thread-1","role":"assistant","limit":1,"preview_chars":24000}),
    )
    .await;
    assert!(
        out.contains("Id: a2 | 2026-10-16T09:15:00Z | offset=0"),
        "{out}"
    );
    assert!(out.contains(long.trim_end()), "{out}");
    assert!(
        !out.contains("interim") && !out.contains("follow-up"),
        "{out}"
    );
    assert!(
        out.contains("Scope: assistant.") && out.contains("Status: idle | Last activity:"),
        "{out}"
    );
    let users = text(
        &app,
        VIEW,
        json!({"thread_id":"thread-1","role":"user","include_tools":true}),
    )
    .await;
    assert!(
        users.contains("question") && users.contains("follow-up") && !users.contains("Id: t1"),
        "{users}"
    );
    // Default reads keep the 1200-character preview and gain timestamps.
    let plain = text(&app, VIEW, json!({"thread_id":"thread-1"})).await;
    assert!(plain.contains("next_offset=1200"), "{plain}");
    assert!(
        app.invoke_extension_tool(call(VIEW, json!({"thread_id":"thread-1","role":"tool"})))
            .await
            .is_err()
    );

    app.with_thread_mut("workspace-1", "thread-1", |t| {
        t.status = ThreadStatus::WaitingForInput
    })
    .await
    .unwrap();
    add_pending(
        &app,
        "thread-1",
        "approval",
        "Run command",
        Some("rm -rf build"),
    )
    .await;
    let flagged = text(&app, VIEW, json!({"thread_id":"thread-1","limit":1})).await;
    assert!(
        flagged.contains("Status: waiting_for_input")
            && flagged.contains("ATTENTION: waiting on approval \"Run command\" (rm -rf build)"),
        "{flagged}"
    );
}
