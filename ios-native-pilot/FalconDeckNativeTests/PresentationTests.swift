import XCTest
@testable import FalconDeckNative

final class PresentationTests: XCTestCase {
    func testHookExitAndDecisionEvidenceIsNeverSilent() {
        for (payload, silent) in [
            ("{\"context\":[],\"exit_code\":\"1\"}", false),
            ("{\"context\":[],\"exit_code\":1.5}", false),
            ("{\"context\":[],\"exit_code\":true}", false),
            ("{\"context\":[],\"exit_code\":18446744073709551616}", false),
            ("{\"context\":[],\"exit_code\":null,\"exitCode\":2}", false),
            ("{\"context\":[],\"exitCode\":\"1\"}", false),
            ("{\"context\":[],\"exit_code\":null,\"exitCode\":0}", true),
            ("{\"context\":[]}", true),
            ("{\"context\":[],\"exit_code\":0,\"outcome\":\"error\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"outcome\":null}", false),
            ("{\"context\":[],\"exit_code\":0,\"outcome\":\"success\"}", true),
            ("{\"context\":[],\"exit_code\":0,\"decision\":\"block\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"reason\":\"denied\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"additionalContext\":\"details\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"systemMessage\":\"notice\"}", false),
            ("{\"context\":[],\"exit_code\":0,\"decision\":\" \",\"reason\":\"\",\"additionalContext\":null,\"systemMessage\":[]}", true),
            ("{\"context\":[],\"exit_code\":0,\"unrelated_metadata\":{\"durationMs\":1}}", true),
        ] {
            for prefix in ["Claude hook output: ", "Claude hook success: "] {
                let row = Message(.object(["kind": .string("service"), "message": .string(prefix + payload)]))
                XCTAssertEqual(row.isSilentClaudeHookReceipt, silent, payload)
            }
        }
    }

    func testCachedSilentHooksDoNotRenderOrExport() {
        let silent = Message(.object(["id": .string("silent"), "kind": .string("service"),
            "message": .string("Claude hook output: {\"exit_code\":0,\"stdout\":\"\"}")]))
        let failure = Message(.object(["id": .string("failure"), "kind": .string("service"),
            "message": .string("Claude hook output: {\"exit_code\":1}")]))
        XCTAssertEqual(UserTextProjection.messages([silent, failure]).map(\.id), ["failure"])
        let markdown = TranscriptExport.markdown([silent, failure], title: "Hooks", partial: false)
        XCTAssertFalse(markdown.contains("\"exit_code\":0"))
        XCTAssertTrue(markdown.contains("\"exit_code\":1"))
    }

    func testTaskLinksKeepStableIDsAndRejectOtherActions() {
        let text = try! AttributedString(markdown: "[Renamed task](falcondeck://thread/task-123)")
        XCTAssertEqual(String(text.characters), "Renamed task")
        XCTAssertEqual(text.runs.first?.link.flatMap { TranscriptThreadLink.parse($0.absoluteString) }, "task-123")
        for value in ["falcondeck://thread/", "falcondeck://pair/task", "falcondeck://thread/task?delete=true", "falcondeck://thread/%2E%2E", "falcondeck://thread/%2Fetc", "falcondeck://thread/%ZZ", "falcondeck://thread/task%0A123", "falcondeck://thread/task%0A"] {
            XCTAssertNil(TranscriptThreadLink.parse(value), value)
        }
    }

    func testInitialHistoryMatchesExposSmallTailAndOlderPagesRemainAvailable() {
        let task = AgentTask(.object(["id": .string("t"), "workspace_id": .string("p")]))
        let tail = NativeRequest.history(task: task, before: nil)
        XCTAssertEqual(tail["limit"].int, 20)
        XCTAssertEqual(tail["mode"].string, "tail")
        XCTAssertTrue(tail["strict_limit"].bool)
        XCTAssertFalse(tail["inline_images"].bool)
        XCTAssertTrue(tail["compact_workspace"].bool)
        let older = NativeRequest.history(task: task, before: "first-visible")
        XCTAssertEqual(older["limit"].int, 50)
        XCTAssertEqual(older["mode"].string, "before")
        XCTAssertEqual(older["before_item_id"].string, "first-visible")
    }

    func testHarnessProjectionHidesScaffoldingAndKeepsTypedQuery() {
        XCTAssertEqual(UserTextProjection.project("<environment_context>private scaffold</environment_context>\n<user_query>Hello 👋</user_query>"), .prompt("Hello 👋", automated: false))
        XCTAssertEqual(UserTextProjection.project("# AGENTS.md instructions for /project\n<INSTRUCTIONS>rules</INSTRUCTIONS>"), .hidden)
        XCTAssertEqual(UserTextProjection.project("<environment_context>half a streamed block"), .hidden)
        XCTAssertEqual(UserTextProjection.project("<falcondeck_automation>Sent by scheduled task</falcondeck_automation>\nRun tests"), .prompt("Run tests", automated: true))
        XCTAssertEqual(UserTextProjection.project("<system-reminder>FalconDeck resume: continue</system-reminder>"), .service("Resumed after FalconDeck closed"))
    }
    func testSkillEchoDeduplicationDoesNotDropImageOnlyMessages() {
        let text = "Use the FalconDeck skill defined at /skills/a.md. Follow it as the governing skill for this request.\nHello"
        let rows = [message("u1", kind: "user_message", text: "Hello"), message("t", kind: "tool_call"), message("u2", kind: "user_message", text: text), Message(.object(["id": .string("image"), "kind": .string("user_message"), "text": .string("<environment_context>hidden</environment_context>"), "attachments": .array([.object(["url": .string("example")])])]))]
        let projected = UserTextProjection.messages(rows)
        XCTAssertEqual(projected.map(\.id), ["u1", "t", "image"])
        XCTAssertEqual(projected.last?.text, "")
    }
    func testCollapsedToolRunsKeepFailuresOutsideTheFold() {
        let rows = [message("t1", kind: "tool_call"), message("r", kind: "reasoning"), message("t2", kind: "tool_call"), Message(message("error", kind: "tool_call").raw.setting("status", .string("failed")))]
        let blocks = TranscriptBlock.build(rows, preferences: ConversationPreferences(raw: .null), running: false)
        XCTAssertEqual(blocks.count, 2)
        XCTAssertTrue(blocks[0].grouped)
        XCTAssertEqual(blocks[0].items.map(\.id), ["t1", "r", "t2"])
        XCTAssertFalse(blocks[1].grouped)
    }
    func testActionsStayOnTheLastAssistantResponseOfEachTurn() {
        let rows = [message("u1", kind: "user_message", text: "First request"), message("commentary", kind: "assistant_message"), message("tool", kind: "tool_call"), message("final1", kind: "assistant_message"), message("u2", kind: "user_message", text: "Second request"), message("final2", kind: "assistant_message")]
        XCTAssertEqual(TranscriptBlock.actionMessageIDs(rows), ["final1", "final2"])
    }
    func testStreamingReplyDoesNotLeaveAnEarlierCommentaryActionBar() {
        let rows = [message("commentary", kind: "assistant_message"), Message(message("streaming", kind: "assistant_message").raw.setting("lifecycle", .string("streaming")))]
        XCTAssertTrue(TranscriptBlock.actionMessageIDs(rows).isEmpty)
    }
    func testHiddenHarnessMessagesDoNotSplitAssistantActionBars() {
        let rows = [message("u", kind: "user_message", text: "Review this"), message("commentary", kind: "assistant_message", text: "Checking"), message("scaffold", kind: "user_message", text: "<environment_context>private</environment_context>"), message("final", kind: "assistant_message", text: "Done")]
        XCTAssertEqual(TranscriptBlock.actionMessageIDs(rows), ["final"])
    }
    func testOnlyTrailingReasoningRemainsStreaming() {
        let rows = [Message(message("r1", kind: "reasoning").raw.setting("lifecycle", .string("streaming"))), Message(message("r2", kind: "reasoning").raw.setting("lifecycle", .string("streaming")))]
        let blocks = TranscriptBlock.build(rows, preferences: ConversationPreferences(raw: .null), running: true)
        XCTAssertFalse(blocks[0].items[0].streaming)
        XCTAssertTrue(blocks[1].items[0].streaming)
    }
    func testThinkingFallbackMatchesExposPlainLabels() {
        XCTAssertEqual(ConversationActivity.label(blocks: [], running: true, submitting: false), "Thinking…")
        XCTAssertEqual(ConversationActivity.label(blocks: [], running: false, submitting: true), "Sending…")
        XCTAssertNil(ConversationActivity.label(blocks: [], running: false, submitting: false))
        let reply = TranscriptBlock(items: [message("reply", kind: "assistant_message")], grouped: false, firstDiff: false)
        XCTAssertEqual(ConversationActivity.label(blocks: [reply], running: true, submitting: false), "Thinking…")
    }
    func testReasoningHeaderFollowsLifecycleAndUsesOneSummaryLine() {
        let thought = message("thought", kind: "reasoning")
        XCTAssertEqual(ConversationActivity.reasoningLabel(thought), "Thought")
        XCTAssertEqual(ConversationActivity.reasoningLabel(Message(thought.raw.setting("lifecycle", .string("streaming")))), "Thinking…")
        XCTAssertEqual(ConversationActivity.reasoningLabel(Message(thought.raw.setting("lifecycle", .string("interrupted")))), "Thought interrupted")
        XCTAssertEqual(ConversationActivity.reasoningLabel(Message(thought.raw.setting("lifecycle", .string("error")))), "Thought failed")
        XCTAssertEqual(ConversationActivity.reasoningLabel(Message(thought.raw.setting("summary", .string("\n  A short summary  \nA longer explanation")))), "A short summary")
    }
    func testSettledThoughtsShowElapsedTimeAndOnlyExpandWithNewText() {
        let thought = message("thought", kind: "reasoning")
        XCTAssertEqual(ConversationActivity.reasoningLabel(Message(thought.raw.setting("duration_ms", .number(12_400)))), "Thought for 12s")
        XCTAssertEqual(ConversationActivity.reasoningLabel(Message(thought.raw.setting("duration_ms", .number(400)))), "Thought")
        XCTAssertEqual(ConversationActivity.reasoningLabel(Message(thought.raw.setting("summary", .string("Planning")).setting("duration_ms", .number(75_000)))), "Planning · 1m 15s")
        // A thought with nothing beyond its label has nothing to expand.
        XCTAssertEqual(ConversationActivity.reasoningBody(thought), "")
        XCTAssertEqual(ConversationActivity.reasoningBody(Message(thought.raw.setting("summary", .string("Planning")))), "")
        XCTAssertEqual(ConversationActivity.reasoningBody(Message(thought.raw.setting("summary", .string("Planning")).setting("content", .string("Planning")))), "")
        XCTAssertEqual(ConversationActivity.reasoningBody(Message(thought.raw.setting("summary", .string("Planning\nCheck the relay first")))), "Check the relay first")
        XCTAssertEqual(ConversationActivity.reasoningBody(Message(thought.raw.setting("content", .string("Full reasoning")))), "Full reasoning")
    }
    func testImageSyntaxWithManyBackslashesParsesPromptly() {
        let hostile = "![" + String(repeating: "\\", count: 60) + "](https://example.com)x"
        let start = Date()
        XCTAssertEqual(TranscriptMarkdownParser.parse(hostile).count, 1)
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
        XCTAssertEqual(TranscriptMarkdownParser.parse("![A \\] chart](https://example.com/c.png)"), [.image(alt: "A \\] chart", destination: "https://example.com/c.png")])
    }
    func testSpawnedTasksFollowTheirParentAndPullTheFamilyUp() {
        func task(_ id: String, parent: String? = nil) -> AgentTask {
            var raw = JSON.object(["id": .string(id), "workspace_id": .string("p")])
            if let parent { raw = raw.setting("origin", .object(["kind": .string("agent_spawn"), "parent_thread_id": .string(parent)])) }
            return AgentTask(raw)
        }
        // Sorted input: the child ran most recently, so its family leads.
        let nested = SpawnNesting.nest([task("child", parent: "parent"), task("other"), task("parent"), task("grandchild", parent: "child"), task("orphan", parent: "missing")])
        XCTAssertEqual(nested.tasks.map(\.id), ["parent", "child", "grandchild", "other", "orphan"])
        XCTAssertEqual(nested.depth, ["child": 1, "grandchild": 2])
        // Several siblings exercise the family-rank sort.
        let siblings = SpawnNesting.nest([task("late", parent: "root"), task("root"), task("early", parent: "root"), task("middle", parent: "root")])
        XCTAssertEqual(siblings.tasks.map(\.id), ["root", "late", "early", "middle"])
        let cycle = SpawnNesting.nest([task("a", parent: "b"), task("b", parent: "a")])
        XCTAssertEqual(Set(cycle.tasks.map(\.id)), ["a", "b"])
        let flat = [task("x"), task("y")]
        XCTAssertEqual(SpawnNesting.nest(flat).tasks.map(\.id), ["x", "y"])
    }
    func testLiveReasoningAndToolsDoNotGetADuplicateThinkingIndicator() {
        let thought = Message(message("thought", kind: "reasoning").raw.setting("lifecycle", .string("streaming")))
        let tool = Message(message("tool", kind: "tool_call").raw.setting("status", .string("running")))
        for block in [TranscriptBlock(items: [thought], grouped: false, firstDiff: false), TranscriptBlock(items: [tool], grouped: false, firstDiff: false), TranscriptBlock(items: [tool, thought], grouped: true, firstDiff: false)] {
            XCTAssertNil(ConversationActivity.label(blocks: [block], running: true, submitting: false))
        }
        let completed = TranscriptBlock(items: [message("tool", kind: "tool_call")], grouped: true, firstDiff: false)
        XCTAssertEqual(ConversationActivity.label(blocks: [completed], running: true, submitting: false), "Thinking…")
    }
    func testInProgressToolsOwnTheirVisibleActivityIndicator() {
        let tool = Message(message("tool", kind: "tool_call").raw.setting("status", .string("in_progress")))
        let block = TranscriptBlock(items: [tool], grouped: true, firstDiff: false)
        XCTAssertTrue(tool.running)
        XCTAssertTrue(block.running)
        XCTAssertTrue(ConversationPreferences(raw: .object(["tool_details_mode": .string("auto")])).opens(tool))
        XCTAssertNil(ConversationActivity.label(blocks: [block], running: true, submitting: false))
        XCTAssertNil(ConversationActivity.label(blocks: [TranscriptBlock(items: [tool], grouped: false, firstDiff: false)], running: true, submitting: false))
    }
    func testSummaryOrderingParsesFractionalSecondsAndProtectsTerminalState() {
        let current = JSON.object(["updated_at": .string("2026-10-17T10:00:00.12Z"), "status": .string("idle")])
        let old = current.setting("updated_at", .string("2026-10-17T10:00:00.1Z")).setting("status", .string("running"))
        XCTAssertTrue(TaskSummaryOrder.isStale(old, comparedTo: current))
        XCTAssertTrue(TaskSummaryOrder.isStale(current.setting("status", .string("running")), comparedTo: current))
        XCTAssertFalse(TaskSummaryOrder.isStale(current.setting("updated_at", .string("2026-10-17T10:00:00.13Z")).setting("status", .string("running")), comparedTo: current))
    }
    private func message(_ id: String, kind: String, text: String = "") -> Message { Message(.object(["id": .string(id), "kind": .string(kind), "text": .string(text)])) }
}

@MainActor final class DraftRecoveryTests: XCTestCase {
    func testOneDamagedDraftDoesNotHideOtherRecoverableInput() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://relay.example")!, sessionID: "fixture", deviceID: "device", token: "unused", secret: Data(repeating: 7, count: 32), daemonKey: "unused", daemonIdentity: "unused")
        let store = try DraftStore(session: session, root: root)
        try await store.save(SavedDraft(id: "damaged", text: "Older input", attachments: [], modelID: "", effort: "", provider: "codex", overrides: [:]))
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!.allObjects.compactMap { $0 as? URL }
        let damaged = try XCTUnwrap(files.first { $0.pathExtension == "draft" })
        try await store.save(SavedDraft(id: "healthy", text: "Keep this input", attachments: [], modelID: "", effort: "", provider: "codex", overrides: [:]))
        try Data("Damaged encrypted file".utf8).write(to: damaged)
        let loaded = try await store.load()
        XCTAssertEqual(loaded.map(\.id), ["healthy"])
        XCTAssertEqual(loaded.first?.text, "Keep this input")
        XCTAssertTrue(FileManager.default.fileExists(atPath: damaged.path), "Unreadable input must remain available for recovery")
    }
    func testDraftStorageIsEncryptedAndIsolatedByPairing() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let secret = Data(repeating: 7, count: 32)
        let session = SavedSession(relay: URL(string: "https://relay.example")!, sessionID: "one", deviceID: "device", token: "unused", secret: secret, daemonKey: "unused", daemonIdentity: "unused")
        let store = try DraftStore(session: session, root: root)
        let value = SavedDraft(id: "task", text: "Private recovery text", attachments: [], modelID: "model", effort: "high", provider: "codex", overrides: [:])
        try await store.save(value); try await store.saveSelection(.task("task"))
        let loaded = try await store.load()
        XCTAssertEqual(loaded.first?.text, value.text)
        let selected = try await store.loadSelection()
        XCTAssertEqual(selected, .task("task"))
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!.allObjects.compactMap { $0 as? URL }.filter { $0.pathExtension == "draft" }
        XCTAssertFalse(String(decoding: try Data(contentsOf: XCTUnwrap(files.first)), as: UTF8.self).contains(value.text))
        let other = SavedSession(relay: session.relay, sessionID: "two", deviceID: "device", token: "unused", secret: secret, daemonKey: "unused", daemonIdentity: "unused")
        let second = try DraftStore(session: other, root: root)
        let empty = try await second.load()
        XCTAssertTrue(empty.isEmpty)
    }
    func testUnconfirmedRecoveryNeverDuplicatesTextAcrossRelaunches() {
        let pending = SavedSubmission(id: "submitted", text: "Sent text", attachments: [])
        let value = SavedDraft(id: "task", text: "New text", attachments: [], modelID: "", effort: "", provider: "codex", overrides: [:], submission: pending)
        let chat = ChatSession(); chat.restore(value)
        XCTAssertEqual(chat.draft, "Sent text\n\nNew text")
        let next = ChatSession(); next.restore(chat.saved(id: "task"))
        XCTAssertEqual(next.draft, chat.draft)
        next.transcript.upsert(Message(.object(["id": .string("submitted"), "kind": .string("user_message"), "text": .string("Sent text")])))
        next.settleSubmission()
        XCTAssertNil(next.submission)
        XCTAssertEqual(next.draft, "New text")
    }
    func testAnAlreadyDeliveredRecoveredDraftIsClearedAfterHistoryLoads() {
        let chat = ChatSession()
        chat.restore(SavedDraft(id: "task", text: "", attachments: [], modelID: "", effort: "", provider: "codex", overrides: [:], submission: SavedSubmission(id: "submitted", text: "Sent text", attachments: [])))
        chat.transcript.upsert(Message(.object(["id": .string("submitted"), "kind": .string("user_message"), "text": .string("Sent text")])))
        chat.settleSubmission()
        XCTAssertEqual(chat.draft, "")
        XCTAssertNil(chat.submission)
    }
}
