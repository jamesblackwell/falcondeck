//! Review inbox hooks into the daemon: who asked, what evidence may be read,
//! telling the agent how James decided, and the push notification.
use super::*;
use falcondeck_core::reviews::{Review, ReviewDelivery};

use crate::control::EvidenceAccess;

impl AppState {
    /// Whether the review inbox is switched on (Settings → General).
    pub(crate) async fn review_inbox_enabled(&self) -> bool {
        self.inner.preferences.lock().await.review_inbox_enabled
    }

    /// The workspace and bot behind the thread an agent published a review from.
    /// A bot's home resolves to its current home, even after a harness switch.
    pub(crate) async fn review_source(
        &self,
        thread_id: Option<&str>,
    ) -> (Option<String>, Option<String>) {
        let Some(thread_id) = thread_id else {
            return (None, None);
        };
        if let Some(bot) = self.bot_for_thread(thread_id).await {
            return (Some(bot.workspace_id), Some(bot.name));
        }
        (self.thread_workspace(thread_id).await.ok(), None)
    }

    /// The paths an agent may attach: exactly what a phone may open with
    /// `file.stat`, plus the thread's folder for relative paths.
    pub(crate) async fn review_evidence_access(
        &self,
        workspace_id: Option<&str>,
        thread_id: Option<&str>,
    ) -> EvidenceAccess {
        let params = serde_json::json!({"workspace_id": workspace_id, "thread_id": thread_id});
        let (policy, home, workspace_dir) = self.file_preview_access(&params).await.into_parts();
        EvidenceAccess {
            policy,
            home,
            workspace_dir,
        }
    }

    /// Sends James's response to the thread that asked: a bot's current home,
    /// or the source thread. A busy turn is steered; an idle thread starts one.
    pub(crate) async fn deliver_review_response(&self, review: &Review) -> ReviewDelivery {
        let outcome = self.try_deliver_review_response(review).await;
        let at = Utc::now();
        match outcome {
            Ok(()) => ReviewDelivery::Delivered { at },
            Err(error) => {
                tracing::warn!(review = %review.id, "review response not delivered: {error}");
                ReviewDelivery::Failed { at, error }
            }
        }
    }

    async fn try_deliver_review_response(&self, review: &Review) -> Result<(), String> {
        let (workspace_id, thread_id) = if let Some(bot) = &review.bot {
            let preferences = self.preferences().await;
            let bot = preferences
                .bots
                .iter()
                .find(|profile| profile.name == *bot)
                .ok_or_else(|| format!("the bot {bot} no longer exists"))?;
            (bot.workspace_id.clone(), bot.thread_id.clone())
        } else {
            let thread_id = review
                .source_thread_id
                .clone()
                .ok_or("the review was published without a source thread")?;
            let workspace_id = self
                .thread_workspace(&thread_id)
                .await
                .map_err(|error| error.to_string())?;
            (workspace_id, thread_id)
        };
        let request: SendTurnRequest = serde_json::from_value(serde_json::json!({
            "workspace_id": workspace_id,
            "thread_id": thread_id,
            "inputs": [{"type": "text", "text": crate::control::response_message(review)}],
            "steer": true
        }))
        .map_err(|error| error.to_string())?;
        self.send_automatic_turn(request)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Record the review and push "Juno needs a decision: …" to paired devices
    /// that are not looking.
    pub(crate) async fn notify_review_created(&self, review: &Review) {
        self.record_and_deliver_attention(super::notification_centre::AttentionEvent::Review(
            Box::new(review.clone()),
        ))
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::thread_tools::tests::fixture;
    use falcondeck_core::control::{ControlExecuteRequest, ControlOrigin, ControlRequestContext};
    use falcondeck_core::{BotProfile, BotStatus, UpdatePreferencesRequest};
    use serde_json::{Value, json};

    fn context(origin: ControlOrigin, thread: Option<&str>) -> ControlRequestContext {
        ControlRequestContext {
            origin,
            provider: Some(AgentProvider::CLAUDE),
            thread_id: thread.map(str::to_string),
            ..Default::default()
        }
    }

    async fn execute(
        app: &AppState,
        origin: ControlOrigin,
        thread: Option<&str>,
        operation: &str,
        arguments: Value,
    ) -> Value {
        let request: ControlExecuteRequest =
            serde_json::from_value(json!({"operation": operation, "arguments": arguments}))
                .unwrap();
        serde_json::to_value(app.control_execute(request, &context(origin, thread)).await).unwrap()
    }

    fn publish(evidence: Value) -> Value {
        json!({
            "title": "Pricing page",
            "ask": "Ship the new hero?",
            "recommendation": "Ship B: it tested 12% better.",
            "items": [
                {"title": "Hero", "note": "Mobile capture.", "evidence": evidence},
                {"title": "Footer"}
            ]
        })
    }

    /// A fake Claude whose stdin we can read back, wired to `workspace-1`.
    #[cfg(unix)]
    async fn capture_turns(app: &AppState, temp: &tempfile::TempDir) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = temp.path().join("fake-claude-review");
        let capture = temp.path().join("captured-review-messages");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nwhile IFS= read -r input; do\nprintf '%s\\n' \"$input\" >> '{}'\ndone\n",
                capture.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = crate::claude::ClaudeRuntime::for_test(
            temp.path().to_string_lossy().into(),
            script.to_string_lossy().into(),
        );
        let mut workspaces = app.inner.workspaces.lock().await;
        let workspace = workspaces.get_mut("workspace-1").unwrap();
        workspace.claude_runtime = Some(runtime);
        // The fixture thread points at a session that does not exist on disk.
        workspace
            .threads
            .get_mut("thread-1")
            .unwrap()
            .summary
            .native_session_id = None;
        workspace
            .summary
            .agents
            .push(falcondeck_core::WorkspaceAgentSummary {
                models_loading: false,
                provider: AgentProvider::CLAUDE,
                label: "Claude".into(),
                account: Default::default(),
                models: vec![],
                collaboration_modes: vec![],
                skills: vec![],
                capabilities: falcondeck_core::AgentCapabilitySummary::claude(),
            });
        capture
    }

    async fn captured(path: &std::path::Path, needle: &str) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let text = std::fs::read_to_string(path).unwrap_or_default();
                if text.contains(needle) {
                    return text;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the agent received the response")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn publish_snapshot_respond_and_deliver_to_the_source_thread() {
        let (app, temp) = fixture().await;
        let capture = capture_turns(&app, &temp).await;
        let project = temp.path().join("project-a").canonicalize().unwrap();
        let shot = project.join("hero.png");
        std::fs::write(&shot, b"\x89PNG-hero").unwrap();

        let created = execute(
            &app,
            ControlOrigin::Mcp,
            Some("thread-1"),
            "review.create",
            publish(json!([{"path": shot, "caption": "Mobile"}])),
        )
        .await;
        assert_eq!(created["ok"], true, "{created}");
        let review = &created["data"];
        assert_eq!(review["source_thread_id"], "thread-1");
        assert_eq!(review["source_workspace_id"], "workspace-1");
        assert_eq!(review["created_by"]["name"], "thread-1");
        let evidence = &review["items"][0]["evidence"][0];
        assert_eq!(evidence["snapshotted"], true);
        let copy = evidence["open_path"].as_str().unwrap().to_string();

        // The review folder is on the file-preview allow-list, so a phone can open it.
        let meta = app
            .dispatch_remote_rpc("file.stat", json!({"path": copy}))
            .await
            .unwrap();
        assert_eq!(meta["kind"], "image");
        assert_eq!(meta["size_bytes"], 9);
        // ...and a path outside every root still is not.
        assert!(
            app.dispatch_remote_rpc("file.stat", json!({"path": "/etc/hosts"}))
                .await
                .is_err()
        );

        // An agent, including the author, cannot answer its own review.
        let answer = json!({"review_id": "R-1", "decision": "approve"});
        for thread in [Some("thread-1"), None] {
            let refused = execute(
                &app,
                ControlOrigin::Mcp,
                thread,
                "review.respond",
                answer.clone(),
            )
            .await;
            assert_eq!(refused["ok"], false);
            assert_eq!(refused["error"]["code"], "review_forbidden", "{refused}");
        }
        let scheduler = execute(
            &app,
            ControlOrigin::Scheduler,
            None,
            "review.respond",
            answer.clone(),
        )
        .await;
        assert_eq!(scheduler["error"]["code"], "review_forbidden");
        assert!(!capture.exists(), "nothing reached the agent");

        let responded = execute(
            &app,
            ControlOrigin::RemoteRpc,
            None,
            "review.respond",
            json!({
                "review_id": "R-1",
                "items": [
                    {"item_id": "i1", "decision": "request_changes", "feedback": "Make the annual toggle default."},
                    {"item_id": "i2", "decision": "approve"}
                ],
                "note": "Thanks."
            }),
        )
        .await;
        assert_eq!(responded["ok"], true, "{responded}");
        assert_eq!(responded["data"]["status"], "changes_requested");
        assert_eq!(responded["data"]["delivery"]["state"], "delivered");

        let seen = captured(&capture, "[FalconDeck review response]").await;
        for needle in [
            "James responded to your review R-1",
            "Result: Changes requested",
            "Item 1 of 2: Hero",
            "Decision: Changes requested",
            "> Make the annual toggle default.",
            "Item 2 of 2: Footer",
            "> Thanks.",
        ] {
            assert!(seen.contains(needle), "{needle}\n{seen}");
        }
        // The decision is final.
        let again = execute(
            &app,
            ControlOrigin::DesktopUi,
            None,
            "review.respond",
            answer,
        )
        .await;
        assert_eq!(again["error"]["code"], "review_closed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_bots_response_goes_to_its_current_home_not_the_thread_it_published_from() {
        let (app, temp) = fixture().await;
        let capture = capture_turns(&app, &temp).await;
        app.inner.preferences.lock().await.bots.push(BotProfile {
            id: "bot-juno".into(),
            name: "Juno".into(),
            workspace_id: "workspace-1".into(),
            dedicated_workspace: false,
            thread_id: "thread-1".into(),
            previous_thread_ids: vec!["thread-old".into()],
            space_path: temp.path().join("space").to_string_lossy().into(),
            instructions: String::new(),
            can_start_threads: true,
            context_files: Vec::new(),
            icon: None,
            status: BotStatus::Active,
        });
        // Published from a former home; the review still belongs to Juno.
        let created = execute(
            &app,
            ControlOrigin::Mcp,
            Some("thread-old"),
            "review.create",
            publish(json!([])),
        )
        .await;
        assert_eq!(created["ok"], true, "{created}");
        assert_eq!(created["data"]["bot"], "Juno");
        assert_eq!(created["data"]["created_by"]["name"], "Juno");

        let responded = execute(
            &app,
            ControlOrigin::DesktopUi,
            None,
            "review.respond",
            json!({"review_id": "R-1", "decision": "approve"}),
        )
        .await;
        assert_eq!(
            responded["data"]["delivery"]["state"], "delivered",
            "{responded}"
        );
        captured(&capture, "James responded to your review R-1").await;
    }

    #[tokio::test]
    async fn a_response_is_kept_even_when_the_source_thread_is_gone() {
        let (app, _temp) = fixture().await;
        let created = execute(
            &app,
            ControlOrigin::Mcp,
            Some("ghost-thread"),
            "review.create",
            publish(json!([])),
        )
        .await;
        assert_eq!(created["ok"], true, "{created}");
        let responded = execute(
            &app,
            ControlOrigin::RemoteRpc,
            None,
            "review.respond",
            json!({"review_id": "R-1", "decision": "reject", "note": "No."}),
        )
        .await;
        assert_eq!(responded["ok"], true, "{responded}");
        assert_eq!(responded["data"]["status"], "rejected");
        assert_eq!(responded["data"]["delivery"]["state"], "failed");
        assert!(responded["data"]["delivery"]["error"].as_str().is_some());
    }

    #[tokio::test]
    async fn switched_off_the_inbox_stores_nothing_and_returns_a_plain_message() {
        let (app, _temp) = fixture().await;
        assert!(app.review_inbox_enabled().await, "on by default");
        app.update_preferences(UpdatePreferencesRequest {
            review_inbox_enabled: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
        let created = execute(
            &app,
            ControlOrigin::Mcp,
            Some("thread-1"),
            "review.create",
            publish(json!([{"path": "/tmp/hero.png", "caption": "Mobile"}])),
        )
        .await;
        assert_eq!(created["ok"], true, "{created}");
        assert_eq!(created["data"]["review_inbox"], "off");
        assert_eq!(created["data"]["delivered_as"], "message");
        let message = created["data"]["message"].as_str().unwrap();
        for needle in [
            "Pricing page",
            "Ship the new hero?",
            "Ship B: it tested 12% better.",
            "## 1. Hero",
            "[/tmp/hero.png](/tmp/hero.png): Mobile",
            "## 2. Footer",
        ] {
            assert!(message.contains(needle), "{needle}\n{message}");
        }
        let list: falcondeck_core::control::ControlGetRequest = serde_json::from_value(
            json!({"resource": "reviews", "filters": {"include_closed": true}}),
        )
        .unwrap();
        let listed = app
            .control_get(list, &context(ControlOrigin::DesktopUi, None))
            .await
            .unwrap();
        assert_eq!(listed.data, json!([]));

        // Switching it back on restores normal behaviour.
        app.update_preferences(UpdatePreferencesRequest {
            review_inbox_enabled: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
        let created = execute(
            &app,
            ControlOrigin::Mcp,
            Some("thread-1"),
            "review.create",
            publish(json!([])),
        )
        .await;
        assert_eq!(created["data"]["id"], "R-1");
    }

    #[tokio::test]
    async fn remote_rpcs_are_registered_and_only_the_response_mutates() {
        let (app, _temp) = fixture().await;
        for method in ["reviews.list", "review.get", "review.respond"] {
            assert!(super::super::remote_bridge::REMOTE_RPC_METHODS.contains(&method));
        }

        // No source thread: the response is recorded without starting a turn.
        execute(
            &app,
            ControlOrigin::Mcp,
            None,
            "review.create",
            publish(json!([])),
        )
        .await;
        let listed = app
            .dispatch_remote_rpc("reviews.list", json!({}))
            .await
            .unwrap();
        assert_eq!(listed["data"][0]["id"], "R-1");
        let one = app
            .dispatch_remote_rpc("review.get", json!({"id": "R-1"}))
            .await
            .unwrap();
        assert_eq!(one["data"]["items"][1]["title"], "Footer");
        // A phone answers through its fixed origin.
        let responded = app
            .dispatch_remote_rpc(
                "review.respond",
                json!({"review_id": "R-1", "decision": "approve"}),
            )
            .await
            .unwrap();
        assert_eq!(responded["ok"], true, "{responded}");
        assert_eq!(responded["data"]["status"], "approved");
    }

    #[test]
    fn the_push_line_names_the_bot_and_stays_within_the_relay_bound() {
        let mut review: Review = serde_json::from_value(json!({
            "id": "R-1", "title": "Pricing page", "ask": "?", "recommendation": "x",
            "going_ahead_at": null, "body": "", "status": "open", "items": [],
            "source_thread_id": null, "source_workspace_id": null, "bot": "Juno",
            "created_by": {"name": "Juno", "context": {"origin": "mcp"}},
            "created_at": "2026-11-01T10:00:00Z", "updated_at": "2026-11-01T10:00:00Z",
            "folder": null, "responded_at": null, "overall_decision": null,
            "overall_note": null, "delivery": null
        }))
        .unwrap();
        use crate::app::notification_centre::review_push_line;
        assert_eq!(
            review_push_line(&review),
            "Juno needs a decision: Pricing page"
        );
        review.bot = None;
        review.title = "  Long ".repeat(80);
        let line = review_push_line(&review);
        assert!(line.starts_with("An agent needs a decision: Long"));
        assert_eq!(line.chars().count(), 200);
        assert!(line.ends_with('…'));
    }

    #[tokio::test]
    async fn preferences_default_on_and_older_files_stay_on() {
        assert!(falcondeck_core::FalconDeckPreferences::default().review_inbox_enabled);
        assert!(
            serde_json::from_value::<falcondeck_core::FalconDeckPreferences>(json!({}))
                .unwrap()
                .review_inbox_enabled
        );
    }
}
