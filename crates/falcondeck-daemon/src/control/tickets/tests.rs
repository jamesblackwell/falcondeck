use super::*;
use crate::control::{ControlDeps, ControlService};
use falcondeck_core::control::{
    ControlExecuteRequest, ControlOrigin, ControlRequestContext, ControlSearchRequest,
};
use serde_json::{Value, json};

fn actor() -> TicketActor {
    TicketActor {
        name: "Juno".into(),
        context: ControlRequestContext {
            origin: ControlOrigin::Mcp,
            thread_id: Some("thread-juno".into()),
            ..Default::default()
        },
    }
}
fn create(title: &str) -> CreateTicketArgs {
    CreateTicketArgs {
        title: title.into(),
        ..Default::default()
    }
}
fn read(resource: &str) -> ControlGetRequest {
    serde_json::from_value(json!({"resource":resource, "limit":100})).unwrap()
}

#[tokio::test]
async fn tickets_survive_reload_and_comments_keep_authorship() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("tickets/tickets.json");
    let store = TicketStore::new(path.clone());
    let first = store
        .create(create("Company launch"), actor())
        .await
        .unwrap();
    assert_eq!(first.id, "T-1");
    let result = store
        .comment(
            CommentTicketArgs {
                ticket_id: first.id.clone(),
                body: "Budget agreed.".into(),
            },
            actor(),
        )
        .await
        .unwrap();
    assert_eq!(result.comments[0].author, actor());
    assert_eq!(result.updated_by, actor());
    let store = TicketStore::new(path);
    let second = store.create(create("Reporting"), actor()).await.unwrap();
    assert_eq!(second.id, "T-2");
    let response = store.get(&read("tickets")).await.unwrap();
    assert_eq!(response.data[0]["comments"][0]["body"], "Budget agreed.");
}

#[tokio::test]
async fn tickets_closure_requires_fresh_single_line_outcome_and_reopen_clears_it() {
    let temp = tempfile::tempdir().unwrap();
    let store = TicketStore::new(temp.path().join("tickets.json"));
    let mut closed = create("Launch");
    closed.state = TicketState::Done;
    assert!(store.create(closed, actor()).await.is_err());
    let ticket = store.create(create("Launch"), actor()).await.unwrap();
    for state in [TicketState::Done, TicketState::Dropped] {
        let mut args = UpdateTicketArgs {
            ticket_id: ticket.id.clone(),
            state: Some(state),
            ..Default::default()
        };
        assert!(store.update(args.clone(), actor()).await.is_err());
        args.closing_note = Some("line one\nline two".into());
        assert!(store.update(args.clone(), actor()).await.is_err());
        args.closing_note = Some("Shipped.".into());
        assert_eq!(store.update(args, actor()).await.unwrap().state, state);
        assert_eq!(store.get(&read("tickets")).await.unwrap().data, json!([]));
        let result = store
            .update(
                UpdateTicketArgs {
                    ticket_id: ticket.id.clone(),
                    state: Some(TicketState::Active),
                    ..Default::default()
                },
                actor(),
            )
            .await
            .unwrap();
        assert_eq!(result.closing_note, None);
    }
}

#[tokio::test]
async fn tickets_reject_deeper_nesting_cycles_and_reparenting_a_parent() {
    let temp = tempfile::tempdir().unwrap();
    let store = TicketStore::new(temp.path().join("tickets.json"));
    let parent = store.create(create("Launch"), actor()).await.unwrap();
    let mut args = create("Marketing");
    args.parent_id = Some(parent.id.clone());
    let child = store.create(args, actor()).await.unwrap();
    let mut args = create("Nested");
    args.parent_id = Some(child.id.clone());
    assert!(store.create(args, actor()).await.is_err());
    for parent_id in [&parent.id, &child.id] {
        assert!(
            store
                .update(
                    UpdateTicketArgs {
                        ticket_id: parent.id.clone(),
                        parent_id: Some(parent_id.clone()),
                        ..Default::default()
                    },
                    actor()
                )
                .await
                .is_err()
        );
    }
    let other = store
        .create(create("Other project"), actor())
        .await
        .unwrap();
    assert!(
        store
            .update(
                UpdateTicketArgs {
                    ticket_id: parent.id,
                    parent_id: Some(other.id),
                    ..Default::default()
                },
                actor()
            )
            .await
            .is_err()
    );
    assert!(
        store
            .comment(
                CommentTicketArgs {
                    ticket_id: "T-404".into(),
                    body: "hello".into()
                },
                actor()
            )
            .await
            .is_err()
    );
    assert!(
        store
            .comment(
                CommentTicketArgs {
                    ticket_id: child.id.clone(),
                    body: "  ".into()
                },
                actor()
            )
            .await
            .is_err()
    );
    assert!(
        store
            .comment(
                CommentTicketArgs {
                    ticket_id: child.id,
                    body: "Child update".into()
                },
                actor()
            )
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn tickets_concurrent_creates_have_distinct_durable_ids() {
    let temp = tempfile::tempdir().unwrap();
    let store = TicketStore::new(temp.path().join("tickets.json"));
    let (a, b) = tokio::join!(
        store.create(create("One"), actor()),
        store.create(create("Two"), actor())
    );
    assert_ne!(a.unwrap().id, b.unwrap().id);
    assert_eq!(
        store
            .get(&read("tickets"))
            .await
            .unwrap()
            .data
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn tickets_bad_or_future_store_is_preserved_and_failed_save_is_not_visible() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("tickets.json");
    for bytes in [
        b"bad".as_slice(),
        br#"{"version":99,"next_id":1,"tickets":[]}"#.as_slice(),
    ] {
        tokio::fs::write(&path, bytes).await.unwrap();
        let store = TicketStore::new(path.clone());
        assert!(store.create(create("One"), actor()).await.is_err());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
    }
    let blocker = temp.path().join("blocker");
    tokio::fs::write(&blocker, "file").await.unwrap();
    let store = TicketStore::new(blocker.join("tickets.json"));
    assert!(store.create(create("One"), actor()).await.is_err());
    tokio::fs::remove_file(&blocker).await.unwrap();
    assert_eq!(store.get(&read("tickets")).await.unwrap().data, json!([]));
}

#[tokio::test]
async fn tickets_control_get_execute_discovery_filters_pagination_and_idempotency() {
    let temp = tempfile::tempdir().unwrap();
    let service = ControlService::new(temp.path().join("agent-control.json"));
    service.restore().await.unwrap();
    let context = actor().context;
    let search = service
        .search(
            ControlSearchRequest {
                domain: Some("ticket".into()),
                ..Default::default()
            },
            &context,
        )
        .await
        .unwrap();
    assert_eq!(search.results.len(), 3);
    for capability in search.results {
        assert!(
            capability
                .description
                .contains("Most changes should just be done")
                || capability
                    .description
                    .contains("most changes should just be done")
        );
    }
    let execute = |operation: &str, arguments: Value| -> ControlExecuteRequest {
        serde_json::from_value(json!({"operation":operation, "arguments":arguments, "idempotency_key":format!("test-{operation}")})).unwrap()
    };
    let request = execute(
        "ticket.create",
        json!({"title":"Launch", "owner":"Juno", "project":"/tmp/project", "priority":"P1"}),
    );
    let (result, event) = service
        .execute(request.clone(), &context, &ControlDeps::none())
        .await;
    assert!(result.ok, "{result:?}");
    assert!(
        event
            .unwrap()
            .domains
            .contains(&falcondeck_core::control::ControlDomain::Tickets)
    );
    assert_eq!(
        service
            .execute(request, &context, &ControlDeps::none())
            .await
            .0
            .data,
        result.data
    );
    assert_eq!(
        result.data.unwrap()["created_by"]["context"]["thread_id"],
        "thread-juno"
    );
    let comment = execute(
        "ticket.comment",
        json!({"ticket_id":"T-1", "body":"For the record."}),
    );
    assert!(
        service
            .execute(comment, &context, &ControlDeps::none())
            .await
            .0
            .ok
    );
    let invalid = execute("ticket.update", json!({"ticket_id":"T-1", "state":"done"}));
    assert!(
        !service
            .execute(invalid, &context, &ControlDeps::none())
            .await
            .0
            .ok
    );
    let filtered = serde_json::from_value(json!({"resource":"tickets", "filters":{"owner":"Juno", "project":"/tmp/project", "priority":"P1"}, "limit":1})).unwrap();
    assert_eq!(
        service
            .get(filtered, &context)
            .await
            .unwrap()
            .data
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let detail = serde_json::from_value(json!({"resource":"ticket", "id":"T-1"})).unwrap();
    assert_eq!(
        service.get(detail, &context).await.unwrap().data["comments"][0]["author"]["context"]["thread_id"],
        "thread-juno"
    );
    // A second item makes the bounded list return a resumable cursor.
    let second = serde_json::from_value(
        json!({"operation":"ticket.create", "arguments":{"title":"Second"}}),
    )
    .unwrap();
    assert!(
        service
            .execute(second, &context, &ControlDeps::none())
            .await
            .0
            .ok
    );
    let page = service
        .get(
            serde_json::from_value(json!({"resource":"tickets", "limit":1})).unwrap(),
            &context,
        )
        .await
        .unwrap();
    assert_eq!(page.next_cursor.as_deref(), Some("1"));
    let page = service
        .get(
            serde_json::from_value(json!({"resource":"tickets", "limit":1, "cursor":"1"})).unwrap(),
            &context,
        )
        .await
        .unwrap();
    assert_eq!(page.data[0]["id"], "T-2");
}
