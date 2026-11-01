use super::*;
use serde_json::json;

fn actor(name: &str) -> ReviewActor {
    ReviewActor {
        name: name.into(),
        context: ControlRequestContext {
            origin: ControlOrigin::Mcp,
            thread_id: Some(format!("thread-{name}")),
            ..Default::default()
        },
    }
}
fn james(origin: ControlOrigin) -> ReviewActor {
    ReviewActor {
        name: "James".into(),
        context: ControlRequestContext {
            origin,
            ..Default::default()
        },
    }
}
fn source() -> ReviewSource {
    ReviewSource {
        thread_id: Some("thread-Juno".into()),
        workspace_id: Some("workspace-1".into()),
        bot: Some("Juno".into()),
    }
}
async fn access(root: &Path) -> EvidenceAccess {
    EvidenceAccess {
        policy: FileAccessPolicy::build([root.to_path_buf()], None).await,
        home: None,
        workspace_dir: Some(root.to_path_buf()),
    }
}
fn args(items: Vec<ReviewItemInput>) -> CreateReviewArgs {
    CreateReviewArgs {
        title: "Pricing page".into(),
        ask: "Ship the new hero?".into(),
        recommendation: "Ship B: it tested 12% better.".into(),
        items,
        ..Default::default()
    }
}
fn item(title: &str, evidence: Vec<ReviewEvidenceInput>) -> ReviewItemInput {
    ReviewItemInput {
        title: title.into(),
        note: "Look at the headline.".into(),
        evidence,
    }
}
fn file(path: &Path) -> ReviewEvidenceInput {
    ReviewEvidenceInput {
        path: Some(path.to_string_lossy().into_owned()),
        ..Default::default()
    }
}
fn read(resource: &str, filters: serde_json::Value) -> ControlGetRequest {
    serde_json::from_value(json!({"resource":resource, "filters":filters, "limit":100})).unwrap()
}
fn answer(id: &str, items: serde_json::Value) -> RespondReviewArgs {
    serde_json::from_value(json!({"review_id":id, "items":items})).unwrap()
}

struct Fixture {
    store: ReviewStore,
    root: tempfile::TempDir,
    access: EvidenceAccess,
}
async fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let access = access(&root_path).await;
    let store = ReviewStore::new(root_path.join("state/reviews"));
    Fixture {
        store,
        root,
        access,
    }
}

#[tokio::test]
async fn create_freezes_small_evidence_and_references_large_files() {
    let f = fixture().await;
    let dir = f.root.path().canonicalize().unwrap();
    let small = dir.join("hero.png");
    std::fs::write(&small, b"\x89PNG-original").unwrap();
    let big = dir.join("capture.pdf");
    std::fs::write(&big, vec![b'x'; (SNAPSHOT_MAX_FILE_BYTES + 1) as usize]).unwrap();

    let review = f
        .store
        .create(
            args(vec![item(
                "Hero",
                vec![
                    file(&small),
                    file(&big),
                    ReviewEvidenceInput {
                        url: Some("https://example.com/preview".into()),
                        title: Some("Staging".into()),
                        ..Default::default()
                    },
                ],
            )]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
    assert_eq!(review.id, "R-1");
    assert_eq!(review.status, ReviewStatus::Open);
    let evidence = &review.items[0].evidence;
    assert_eq!(evidence[0].kind, ReviewEvidenceKind::Image);
    assert!(evidence[0].snapshotted);
    let copy = PathBuf::from(evidence[0].open_path.as_deref().unwrap());
    assert!(
        copy.starts_with(
            f.root
                .path()
                .canonicalize()
                .unwrap()
                .join("state/reviews/R-1")
        )
    );
    assert_eq!(std::fs::read(&copy).unwrap(), b"\x89PNG-original");
    // What James approves cannot change underneath him.
    std::fs::write(&small, b"changed later").unwrap();
    assert_eq!(std::fs::read(&copy).unwrap(), b"\x89PNG-original");
    assert_eq!(evidence[0].original_path.as_deref(), small.to_str());

    assert!(!evidence[1].snapshotted);
    assert_eq!(evidence[1].open_path.as_deref(), big.to_str());
    assert_eq!(evidence[2].kind, ReviewEvidenceKind::Url);
    assert!(evidence[2].open_path.is_none());
}

#[tokio::test]
async fn evidence_outside_the_preview_policy_is_refused_and_leaves_nothing_behind() {
    let f = fixture().await;
    let dir = f.root.path().canonicalize().unwrap();
    let secret = dir.join(".env");
    std::fs::write(&secret, "TOKEN=abc").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let elsewhere = outside.path().join("notes.md");
    std::fs::write(&elsewhere, "hi").unwrap();
    let ok = dir.join("ok.md");
    std::fs::write(&ok, "# ok").unwrap();

    for bad in [secret, elsewhere, dir.join("missing.md")] {
        let error = f
            .store
            .create(
                args(vec![item("Doc", vec![file(&ok), file(&bad)])]),
                actor("Juno"),
                source(),
                &f.access,
            )
            .await
            .unwrap_err();
        assert_eq!(error.0.code, "invalid_arguments", "{bad:?}");
        assert!(error.0.message.contains(bad.to_str().unwrap()));
    }
    // The first, valid file was copied before the second failed: cleaned up.
    assert!(!dir.join("state/reviews/R-1").exists());
    let listing = f
        .store
        .get(&read("reviews", json!({"include_closed":true})))
        .await
        .unwrap();
    assert_eq!(listing.data, json!([]));
}

#[tokio::test]
async fn validation_requires_one_line_ask_a_recommendation_and_an_item() {
    let f = fixture().await;
    let create = |change: fn(&mut CreateReviewArgs)| {
        let mut a = args(vec![item("Hero", vec![])]);
        change(&mut a);
        f.store.create(a, actor("Juno"), source(), &f.access)
    };
    assert!(create(|a| a.recommendation = "  ".into()).await.is_err());
    assert!(create(|a| a.ask = "two\nlines".into()).await.is_err());
    assert!(create(|a| a.items.clear()).await.is_err());
    assert!(create(|a| a.title = "".into()).await.is_err());
    assert!(
        create(|a| a.going_ahead_at = Some(Utc::now() - chrono::Duration::hours(1)))
            .await
            .is_err()
    );
    assert!(
        create(|a| a.going_ahead_at = Some(Utc::now() + chrono::Duration::hours(2)))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn only_james_can_respond_and_agents_are_refused_by_origin() {
    let f = fixture().await;
    let review = f
        .store
        .create(
            args(vec![item("Hero", vec![]), item("Footer", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
    let respond = answer(
        &review.id,
        json!([{"item_id":"i1","decision":"approve"},{"item_id":"i2","decision":"approve"}]),
    );
    // The author, another agent, the scheduler and system all fail.
    for who in [actor("Juno"), actor("Atlas")] {
        let error = f.store.respond(respond.clone(), who).await.unwrap_err();
        assert_eq!(error.0.code, "review_forbidden");
    }
    for origin in [ControlOrigin::Scheduler, ControlOrigin::System] {
        let error = f
            .store
            .respond(respond.clone(), james(origin))
            .await
            .unwrap_err();
        assert_eq!(error.0.code, "review_forbidden");
    }
    let still = f.store.get(&read("review", json!({}))).await;
    assert!(still.is_err()); // no id supplied
    // James on the desktop and on a paired phone both qualify.
    let done = f
        .store
        .respond(respond.clone(), james(ControlOrigin::RemoteRpc))
        .await
        .unwrap();
    assert_eq!(done.status, ReviewStatus::Approved);
    assert!(done.responded_at.is_some());
    let error = f
        .store
        .respond(respond, james(ControlOrigin::DesktopUi))
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "review_closed");
}

#[tokio::test]
async fn per_item_decisions_set_the_status_and_feedback_is_kept_verbatim() {
    let f = fixture().await;
    let make = || {
        f.store.create(
            args(vec![
                item("Hero", vec![]),
                item("Pricing", vec![]),
                item("Footer", vec![]),
            ]),
            actor("Juno"),
            source(),
            &f.access,
        )
    };
    let review = make().await.unwrap();
    let done = f
        .store
        .respond(
            answer(
                &review.id,
                json!([
                    {"item_id":"i1","decision":"approve"},
                    {"item_id":"i2","decision":"request_changes","feedback":"  Make the toggle\n  default to annual.  "},
                    {"item_id":"i3","decision":"reject","feedback":"Cut it."}
                ]),
            ),
            james(ControlOrigin::RemoteRpc),
        )
        .await
        .unwrap();
    assert_eq!(done.status, ReviewStatus::ChangesRequested);
    assert_eq!(done.items[0].feedback, None);
    assert_eq!(
        done.items[1].feedback.as_deref(),
        Some("Make the toggle\n  default to annual.")
    );
    assert_eq!(done.items[2].decision, Some(ReviewDecision::Reject));

    // Rejection without any change request is "rejected"; all approvals approve.
    let review = make().await.unwrap();
    let done = f
        .store
        .respond(
            answer(
                &review.id,
                json!([
                    {"item_id":"i1","decision":"approve"},
                    {"item_id":"i2","decision":"reject"},
                    {"item_id":"i3","decision":"approve"}
                ]),
            ),
            james(ControlOrigin::DesktopUi),
        )
        .await
        .unwrap();
    assert_eq!(done.status, ReviewStatus::Rejected);
}

#[tokio::test]
async fn one_overall_decision_covers_items_without_their_own() {
    let f = fixture().await;
    let review = f
        .store
        .create(
            args(vec![item("Hero", vec![]), item("Footer", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
    // A decision for one item alone is not enough.
    let error = f
        .store
        .respond(
            answer(&review.id, json!([{"item_id":"i1","decision":"approve"}])),
            james(ControlOrigin::RemoteRpc),
        )
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "invalid_arguments");
    for bad in [
        json!([{"item_id":"nope","decision":"approve"}]),
        json!([{"item_id":"i1","decision":"approve"},{"item_id":"i1","decision":"reject"}]),
    ] {
        let mut args = answer(&review.id, bad);
        args.decision = Some(ReviewDecision::Approve);
        assert!(
            f.store
                .respond(args, james(ControlOrigin::RemoteRpc))
                .await
                .is_err()
        );
    }
    let mut args = answer(
        &review.id,
        json!([{"item_id":"i2","decision":"request_changes","feedback":"Smaller logo."}]),
    );
    args.decision = Some(ReviewDecision::Approve);
    args.note = Some("Otherwise good.".into());
    let done = f
        .store
        .respond(args, james(ControlOrigin::RemoteRpc))
        .await
        .unwrap();
    assert_eq!(done.status, ReviewStatus::ChangesRequested);
    assert_eq!(done.items[0].decision, Some(ReviewDecision::Approve));
    assert_eq!(done.overall_decision, Some(ReviewDecision::Approve));
    assert_eq!(done.overall_note.as_deref(), Some("Otherwise good."));
}

#[tokio::test]
async fn agents_change_only_their_own_open_reviews_and_james_can_dismiss() {
    let f = fixture().await;
    let review = f
        .store
        .create(
            args(vec![item("Hero", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
    let update = |id: &str| UpdateReviewArgs {
        review_id: id.into(),
        recommendation: Some("Ship A instead.".into()),
        add_items: vec![item("Footer", vec![])],
        ..Default::default()
    };
    let error = f
        .store
        .update(update(&review.id), actor("Atlas"), &f.access)
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "review_forbidden");
    let error = f
        .store
        .withdraw(
            WithdrawReviewArgs {
                review_id: review.id.clone(),
                reason: None,
            },
            actor("Atlas"),
        )
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "review_forbidden");

    let updated = f
        .store
        .update(update(&review.id), actor("Juno"), &f.access)
        .await
        .unwrap();
    assert_eq!(updated.recommendation, "Ship A instead.");
    assert_eq!(updated.items.len(), 2);
    assert_eq!(updated.items[1].id, "i2");
    assert_eq!(updated.items[0].id, "i1");

    let withdrawn = f
        .store
        .withdraw(
            WithdrawReviewArgs {
                review_id: review.id.clone(),
                reason: Some("Superseded.".into()),
            },
            actor("Juno"),
        )
        .await
        .unwrap();
    assert_eq!(withdrawn.status, ReviewStatus::Withdrawn);
    // A withdrawn review takes no response and no further edits.
    let error = f
        .store
        .respond(
            answer(&review.id, json!([])),
            james(ControlOrigin::DesktopUi),
        )
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "review_closed");
    assert!(
        f.store
            .update(update(&review.id), actor("Juno"), &f.access)
            .await
            .is_err()
    );

    let other = f
        .store
        .create(
            args(vec![item("Hero", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
    let dismissed = f
        .store
        .withdraw(
            WithdrawReviewArgs {
                review_id: other.id,
                reason: None,
            },
            james(ControlOrigin::DesktopUi),
        )
        .await
        .unwrap();
    assert_eq!(dismissed.status, ReviewStatus::Withdrawn);
}

#[tokio::test]
async fn an_agent_may_have_five_open_reviews_and_closing_one_frees_a_slot() {
    let f = fixture().await;
    let mut ids = vec![];
    for _ in 0..AGENT_OPEN_REVIEWS {
        ids.push(
            f.store
                .create(
                    args(vec![item("Hero", vec![])]),
                    actor("Juno"),
                    source(),
                    &f.access,
                )
                .await
                .unwrap()
                .id,
        );
    }
    let error = f
        .store
        .create(
            args(vec![item("Hero", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "review_limit");
    // Another agent and James are unaffected.
    for who in [actor("Atlas"), james(ControlOrigin::DesktopUi)] {
        f.store
            .create(args(vec![item("Hero", vec![])]), who, source(), &f.access)
            .await
            .unwrap();
    }
    f.store
        .withdraw(
            WithdrawReviewArgs {
                review_id: ids[0].clone(),
                reason: None,
            },
            actor("Juno"),
        )
        .await
        .unwrap();
    f.store
        .create(
            args(vec![item("Hero", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn reviews_survive_reload_list_newest_first_and_hide_closed_by_default() {
    let f = fixture().await;
    let first = f
        .store
        .create(
            args(vec![item("A", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
    let second = f
        .store
        .create(
            args(vec![item("B", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
    f.store
        .withdraw(
            WithdrawReviewArgs {
                review_id: first.id.clone(),
                reason: None,
            },
            actor("Juno"),
        )
        .await
        .unwrap();
    let store = ReviewStore::new(f.root.path().canonicalize().unwrap().join("state/reviews"));
    let open = store.get(&read("reviews", json!({}))).await.unwrap();
    assert_eq!(open.data.as_array().unwrap().len(), 1);
    assert_eq!(open.data[0]["id"], second.id.as_str());
    let all = store
        .get(&read("reviews", json!({"include_closed":true})))
        .await
        .unwrap();
    assert_eq!(all.data[0]["id"], second.id.as_str());
    assert_eq!(all.data[1]["id"], first.id.as_str());
    let withdrawn = store
        .get(&read("reviews", json!({"status":"withdrawn"})))
        .await
        .unwrap();
    assert_eq!(withdrawn.data.as_array().unwrap().len(), 1);
    let one = store
        .get(&serde_json::from_value(json!({"resource":"review","id":"R-2"})).unwrap())
        .await
        .unwrap();
    assert_eq!(one.data["items"][0]["title"], "B");
    let third = store
        .create(
            args(vec![item("C", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
    assert_eq!(third.id, "R-3");
    assert_eq!(
        store
            .get(&serde_json::from_value(json!({"resource":"review","id":"R-9"})).unwrap())
            .await
            .unwrap_err()
            .0
            .code,
        "resource_not_found"
    );
}

#[tokio::test]
async fn an_unreadable_or_future_file_is_left_untouched() {
    let f = fixture().await;
    let dir = f.root.path().canonicalize().unwrap().join("state/reviews");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("reviews.json");
    let future = r#"{"version":2,"next_id":1,"reviews":[]}"#;
    std::fs::write(&path, future).unwrap();
    let error = f
        .store
        .create(
            args(vec![item("A", vec![])]),
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap_err();
    assert_eq!(error.0.code, "storage_unavailable");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), future);
}

#[tokio::test]
async fn response_message_quotes_feedback_verbatim_per_item() {
    let f = fixture().await;
    let review = f
        .store
        .create(
            CreateReviewArgs {
                title: "Pricing page".into(),
                ask: "Ship the new hero?".into(),
                recommendation: "Ship B.".into(),
                items: vec![
                    item("Hero", vec![]),
                    item("Pricing table", vec![]),
                    item("Footer", vec![]),
                ],
                ..Default::default()
            },
            actor("Juno"),
            source(),
            &f.access,
        )
        .await
        .unwrap();
    let mut respond = answer(
        &review.id,
        json!([
            {"item_id":"i1","decision":"approve"},
            {"item_id":"i2","decision":"request_changes","feedback":"Make the annual toggle default.\n\nKeep the Pro badge."},
        ]),
    );
    respond.decision = Some(ReviewDecision::Reject);
    respond.note = Some("Footer needs a rethink, not a tweak.".into());
    let done = f
        .store
        .respond(respond, james(ControlOrigin::RemoteRpc))
        .await
        .unwrap();
    assert_eq!(
        response_message(&done),
        "[FalconDeck review response] James responded to your review R-1 \"Pricing page\".\n\
Ask: Ship the new hero?\n\
Result: Changes requested\n\
Whole-review decision: Rejected\n\
\n\
Item 1 of 3: Hero\n\
Decision: Approved\n\
\n\
Item 2 of 3: Pricing table\n\
Decision: Changes requested\n\
Feedback:\n\
> Make the annual toggle default.\n\
>\n\
> Keep the Pro badge.\n\
\n\
Item 3 of 3: Footer\n\
Decision: Rejected\n\
\n\
Note from James on the whole review:\n\
> Footer needs a rethink, not a tweak.\n\
\n\
This review is closed. Act on the decisions above; publish a new review if you need another decision."
    );
}

#[test]
fn fallback_message_carries_the_same_content_as_a_plain_message() {
    let mut a = args(vec![ReviewItemInput {
        title: "Hero".into(),
        note: "Mobile capture attached.".into(),
        evidence: vec![
            ReviewEvidenceInput {
                path: Some("/tmp/hero.png".into()),
                caption: Some("Mobile".into()),
                ..Default::default()
            },
            ReviewEvidenceInput {
                url: Some("https://example.com/p".into()),
                title: Some("Staging".into()),
                ..Default::default()
            },
        ],
    }]);
    a.going_ahead_at = Some("2030-01-02T09:00:00Z".parse().unwrap());
    let text = fallback_message(&a);
    for needle in [
        "# Decision needed: Pricing page",
        "**Ask:** Ship the new hero?",
        "**Recommendation:** Ship B: it tested 12% better.",
        "2030-01-02 09:00 UTC unless you say no",
        "## 1. Hero",
        "Mobile capture attached.",
        "[/tmp/hero.png](/tmp/hero.png): Mobile",
        "[Staging](https://example.com/p)",
    ] {
        assert!(text.contains(needle), "{needle}\n{text}");
    }
}
