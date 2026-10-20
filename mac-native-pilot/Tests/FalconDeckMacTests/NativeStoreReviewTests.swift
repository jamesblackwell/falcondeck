import Foundation
import XCTest
@testable import FalconDeckMac

private func reviewTask(_ id: String, project: String = "p", pinned: Bool = false) -> JSON {
    .object(["id": .string(id), "workspace_id": .string(project), "provider": .string("codex"),
        "title": .string(id), "status": .string("idle"), "is_pinned": .bool(pinned),
        "updated_at": .string("2026-10-20T08:00:00Z"),
        "attention": .object(["last_agent_activity_seq": .number(4), "last_read_seq": .number(0)])])
}

private func reviewSnapshot(_ tasks: [JSON]) -> JSON {
    .object(["workspaces": .array([
        .object(["id": .string("p"), "path": .string("/tmp/p"), "kind": .string("project")]),
        .object(["id": .string("chat"), "path": .string("/tmp/chat"), "kind": .string("casual")])
    ]), "threads": .array(tasks), "interactive_requests": .array([])])
}

private func reviewEnvelope(_ event: JSON) -> JSON { .object(["event": event]) }
private func reviewSnapshotEnvelope(_ tasks: [JSON]) -> JSON {
    reviewEnvelope(.object(["type": .string("snapshot"), "snapshot": reviewSnapshot(tasks)]))
}

private actor ReviewDaemon: DaemonServing {
    var rows: [String: JSON] = [:]
    var heldDetails = Set<String>()
    var details: [String: CheckedContinuation<JSON, Error>] = [:]
    var detailWaiters: [String: CheckedContinuation<Void, Never>] = [:]
    var snapshotContinuation: CheckedContinuation<JSON, Error>?
    var snapshotWaiter: CheckedContinuation<Void, Never>?
    var readCalls: [String] = []
    var failDetails = false
    var preferences: JSON = .object([:])
    var holdReads = false
    var readCompletions: [CheckedContinuation<Void, Never>] = []
    var readWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func configure(_ tasks: [JSON]) { rows = Dictionary(uniqueKeysWithValues: tasks.map { ($0["id"].string, $0) }) }
    func hold(_ key: String) { heldDetails.insert(key) }
    func release(_ key: String) { heldDetails.remove(key) }
    func failHistory() { failDetails = true }
    func suspendReads() { holdReads = true }
    func finishReads() { holdReads = false; for completion in readCompletions { completion.resume() }; readCompletions = [] }
    func waitReads(_ count: Int) async {
        if readCalls.count >= count { return }
        await withCheckedContinuation { readWaiters.append((count, $0)) }
    }
    func snapshot() async throws -> JSON {
        try await withCheckedThrowingContinuation {
            snapshotContinuation = $0; snapshotWaiter?.resume(); snapshotWaiter = nil
        }
    }
    func waitSnapshot() async {
        if snapshotContinuation != nil { return }
        await withCheckedContinuation { snapshotWaiter = $0 }
    }
    func finishSnapshot(_ value: JSON) { snapshotContinuation?.resume(returning: value); snapshotContinuation = nil }
    func threadDetail(projectID: String, threadID: String, before: String?) async throws -> JSON {
        if failDetails { throw PilotError("Unreadable history") }
        let key = threadID + (before == nil ? "" : ":older")
        if heldDetails.contains(key) {
            return try await withCheckedThrowingContinuation {
                details[key] = $0; detailWaiters.removeValue(forKey: key)?.resume()
            }
        }
        return detail(threadID)
    }
    func detail(_ id: String) -> JSON {
        .object(["thread": rows[id] ?? reviewTask(id), "items": .array([
            .object(["id": .string("message-" + id), "kind": .string("assistant_message"), "text": .string(id)])
        ]), "has_older": .bool(true)])
    }
    func waitDetail(_ key: String) async {
        if details[key] != nil { return }
        await withCheckedContinuation { detailWaiters[key] = $0 }
    }
    func finishDetail(_ key: String, id: String) { details.removeValue(forKey: key)?.resume(returning: detail(id)) }
    func events() async throws -> AsyncThrowingStream<JSON, Error> { AsyncThrowingStream { _ in } }
    func disconnect() async {}
    func connectProject(path: String) async throws -> Project { Project(.object(["id": .string("p"), "path": .string(path)])) }
    func startThread(projectID: String, provider: String?, modelID: String?) async throws -> AgentTask { AgentTask(reviewTask("created")) }
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String?) async throws -> JSON { .null }
    func interrupt(projectID: String, threadID: String) async throws {}
    func respond(projectID: String, requestID: String, response: JSON) async throws {}
    func markRead(projectID: String, threadID: String, readSeq: Int) async throws {
        readCalls.append(threadID)
        let ready = readWaiters.filter { $0.0 <= readCalls.count }
        readWaiters.removeAll { $0.0 <= readCalls.count }
        for (_, waiter) in ready { waiter.resume() }
        if holdReads { await withCheckedContinuation { readCompletions.append($0) } }
    }
    func requestJSON(_ path: [String], method: String, query: [URLQueryItem], body: JSON?) async throws -> JSON {
        if path == ["api", "preferences"] {
            if method == "PATCH", let body { preferences = body }
            return preferences
        }
        return .null
    }
}

final class NativeStoreReviewTests: XCTestCase {
    @MainActor func testChatsDoesNotSelectAGloballyPinnedChat() async {
        let store = AppStore(client: ReviewDaemon())
        store.applyEnvelope(reviewSnapshotEnvelope([reviewTask("pinned-chat", project: "chat", pinned: true)]))
        store.selectSection("chats")
        XCTAssertNil(store.selectedTaskID)
        XCTAssertEqual(store.selectedSection, "chats")
        store.newTask() // Also invalidates any incorrectly queued selection before test teardown.
        await Task.yield()
    }

    @MainActor func testOpeningAnUnpinnedSearchResultLeavesPins() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon)
        let rows = [reviewTask("pinned", pinned: true), reviewTask("plain")]
        await daemon.configure(rows)
        store.applyEnvelope(reviewSnapshotEnvelope(rows))
        await store.selectTask("pinned")
        store.selectSection("pins")
        await store.selectTask("plain")
        XCTAssertEqual(store.selectedSection, "project")
        XCTAssertEqual(store.selectedTaskID, "plain")
    }

    @MainActor func testQueuedScopeSelectionCannotReplaceANewDraft() async {
        let store = AppStore(client: ReviewDaemon())
        store.applyEnvelope(reviewSnapshotEnvelope([reviewTask("chat-task", project: "chat")]))
        store.selectSection("chats")
        store.newTask()
        store.draft = "Keep the new chat draft"
        for _ in 0..<20 { await Task.yield() }
        XCTAssertNil(store.selectedTaskID)
        XCTAssertEqual(store.draft, "Keep the new chat draft")
    }

    @MainActor func testStaleSnapshotReadCannotRewindAnArrivingThreadEvent() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon)
        let old = reviewTask("task")
        store.applyEnvelope(reviewSnapshotEnvelope([old]))
        let refresh = Task { await store.refresh() }
        await daemon.waitSnapshot()
        let newer = old.setting("title", .string("New title")).setting("updated_at", .string("2026-10-20T09:00:00Z"))
        store.applyEnvelope(reviewEnvelope(.object(["type": .string("thread-updated"), "thread": newer])))
        await daemon.finishSnapshot(reviewSnapshot([old]))
        await refresh.value
        XCTAssertEqual(store.tasks.first?.title, "New title")
    }

    @MainActor func testOlderPageLoadingBelongsToItsSelectedTask() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon)
        let rows = [reviewTask("a"), reviewTask("b")]
        await daemon.configure(rows)
        store.applyEnvelope(reviewSnapshotEnvelope(rows))
        await store.selectTask("a")
        await daemon.hold("a:older")
        let olderA = Task { await store.loadOlder() }
        await daemon.waitDetail("a:older")
        await store.selectTask("b")
        XCTAssertFalse(store.isLoadingOlder, "A's pending request must not block B's pagination")
        guard !store.isLoadingOlder else {
            await daemon.finishDetail("a:older", id: "a")
            await olderA.value
            return
        }
        await daemon.hold("b:older")
        let olderB = Task { await store.loadOlder() }
        await daemon.waitDetail("b:older")
        await daemon.finishDetail("a:older", id: "a")
        await olderA.value
        XCTAssertTrue(store.isLoadingOlder, "A's completion must not clear B's busy flag")
        await daemon.finishDetail("b:older", id: "b")
        await olderB.value
        XCTAssertFalse(store.isLoadingOlder)
        XCTAssertEqual(store.messages.first?.text, "b")
    }

    @MainActor func testFailedHistoryDoesNotMarkTheTaskRead() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon, readVisibility: { true })
        await daemon.failHistory()
        store.applyEnvelope(reviewSnapshotEnvelope([reviewTask("unread")]))
        await store.selectTask("unread")
        for _ in 0..<20 { await Task.yield() }
        let calls = await daemon.readCalls
        XCTAssertTrue(calls.isEmpty)
    }

    @MainActor func testAbandonedReadDoesNotSuppressTheNextVisibleRead() async {
        var visibilityChecks = 0
        var visible = true
        let daemon = ReviewDaemon()
        let store = AppStore(client: daemon, readVisibility: {
            visibilityChecks += 1
            return visible && visibilityChecks != 2
        })
        await daemon.configure([reviewTask("task")])
        store.applyEnvelope(reviewSnapshotEnvelope([reviewTask("task")]))
        await store.selectTask("task")
        for _ in 0..<20 { await Task.yield() }
        visible = true
        store.markSelectedTaskRead()
        for _ in 0..<20 { await Task.yield() }
        let calls = await daemon.readCalls
        XCTAssertEqual(calls, ["task"], "A skipped dispatch must leave the read watermark retryable")
    }

    @MainActor func testHistoryNavigationDoesNotSuppressANewerUserNavigation() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon)
        let rows = ["a", "b", "c", "d"].map { reviewTask($0) }
        await daemon.configure(rows)
        store.applyEnvelope(reviewSnapshotEnvelope(rows))
        await store.selectTask("a")
        await store.selectTask("b")
        await daemon.hold("a")
        let back = Task { await store.navigateHistory(-1) }
        await daemon.waitDetail("a")
        await store.selectTask("c")
        await store.selectTask("d")
        await daemon.finishDetail("a", id: "a")
        await back.value
        await daemon.release("a")
        await store.navigateHistory(-1)
        XCTAssertEqual(store.selectedTaskID, "c")
    }

    @MainActor func testTranscriptRecoveryKeepsTheSettingsSectionSelected() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon)
        let row = reviewTask("task")
        await daemon.configure([row])
        store.applyEnvelope(reviewSnapshotEnvelope([row]))
        await store.selectTask("task")
        store.selectSection("settings")
        store.applyEnvelope(.object(["thread_id": .string("task"), "event": .object([
            "type": .string("text"), "item_id": .string("missing"), "delta": .string("x"),
            "start_offset": .number(20), "end_offset": .number(21)
        ])]))
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(store.selectedSection, "settings")
        XCTAssertEqual(store.messages.first?.text, "task")
    }

    @MainActor func testRebaseUpdatesMetadataWithoutReapplyingTranscriptDeltas() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon)
        store.applyEnvelope(reviewSnapshotEnvelope([]))
        store.receiveHost(.init(hostID: "h", event: .snapshot(reviewSnapshot([reviewTask("task")]))))
        // A local transport fixture lets us select the namespaced task without a real relay.
        let scoped = reviewTask("remote:h:task")
        await daemon.configure([scoped])
        store.tasks = [AgentTask(scoped)]
        await store.selectTask("remote:h:task")
        let event: JSON = .object(["thread_id": .string("task"), "event": .object([
            "type": .string("text"), "item_id": .string("delta"), "delta": .string("hello")
        ])])
        store.receiveHost(.init(hostID: "h", event: .events([event])))
        XCTAssertEqual(store.messages.last?.text, "hello")
        store.receiveHost(.init(hostID: "h", event: .rebase([event])))
        XCTAssertEqual(store.messages.last?.text, "hello")
    }

    @MainActor func testMixedHostProjectOrderSurvivesPerHostPreferenceWrites() async throws {
        let store = AppStore(client: ReviewDaemon())
        store.applyEnvelope(reviewSnapshotEnvelope([]))
        store.receiveHost(.init(hostID: "h", event: .snapshot(reviewSnapshot([]))))
        try await store.updateNavigationPreferences(.object([
            "workspace_order": .array([.string("remote:h:p"), .string("p")])
        ]), hostID: nil)
        XCTAssertEqual(store.navigationPreferences["workspace_order"].array.map(\.string), ["remote:h:p", "p"])
        store.receiveHost(.init(hostID: "h", event: .removed))
        XCTAssertEqual(store.navigationPreferences["workspace_order"].array.map(\.string), ["p"])
        store.receiveHost(.init(hostID: "h", event: .snapshot(reviewSnapshot([]))))
        XCTAssertEqual(store.navigationPreferences["workspace_order"].array.map(\.string), ["remote:h:p", "p"])
    }

    @MainActor func testBackAndForwardRestoreTheExactExtensionPanel() async {
        let store = AppStore(client: ReviewDaemon())
        store.applyEnvelope(reviewSnapshotEnvelope([]))
        store.selectExtensionPanel(extensionID: "ext", panelID: "a")
        store.selectExtensionPanel(extensionID: "ext", panelID: "b")
        await store.navigateHistory(-1)
        XCTAssertEqual(store.selectedSection, "extension-panel")
        XCTAssertEqual(store.selectedPanelID, "a")
        await store.navigateHistory(1)
        XCTAssertEqual(store.selectedPanelID, "b")
    }

    @MainActor func testExplicitlyUnreadTaskCanBeMarkedReadWhenReopened() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon, readVisibility: { true })
        let original = reviewTask("task")
        await daemon.configure([original])
        store.applyEnvelope(reviewSnapshotEnvelope([original]))
        await store.selectTask("task")
        for _ in 0..<20 { await Task.yield() }
        store.newTask()
        let unread = original.setting("updated_at", .string("2026-10-20T10:00:00Z"))
            .setting("attention", .object(["last_agent_activity_seq": .number(4), "last_read_seq": .number(3)]))
        await daemon.configure([unread])
        store.applyEnvelope(reviewEnvelope(.object(["type": .string("thread-updated"), "thread": unread])))
        await store.selectTask("task")
        for _ in 0..<20 { await Task.yield() }
        let calls = await daemon.readCalls
        XCTAssertEqual(calls, ["task", "task"])
    }

    @MainActor func testDelayedReadAcknowledgmentCannotSuppressANewerReadSession() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon, readVisibility: { true })
        let original = reviewTask("task")
        await daemon.configure([original])
        await daemon.suspendReads()
        store.applyEnvelope(reviewSnapshotEnvelope([original]))
        await store.selectTask("task")
        await daemon.waitReads(1)
        store.newTask()
        let unread = original.setting("updated_at", .string("2026-10-20T10:00:00Z"))
            .setting("attention", .object(["last_agent_activity_seq": .number(4), "last_read_seq": .number(3)]))
        await daemon.configure([unread])
        store.applyEnvelope(reviewEnvelope(.object(["type": .string("thread-updated"), "thread": unread])))
        await store.selectTask("task")
        for _ in 0..<20 { await Task.yield() }
        let calls = await daemon.readCalls
        await daemon.finishReads()
        XCTAssertEqual(calls, ["task", "task"])
    }

    @MainActor func testRecoveryRetriesWhenItsHistoryStillContainsAStreamGap() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon)
        let row = reviewTask("task")
        await daemon.configure([row])
        store.applyEnvelope(reviewSnapshotEnvelope([row]))
        await store.selectTask("task")
        await daemon.hold("task")
        let gap: JSON = .object(["thread_id": .string("task"), "event": .object([
            "type": .string("text"), "item_id": .string("missing"), "delta": .string("x"),
            "start_offset": .number(20), "end_offset": .number(21)
        ])])
        store.applyEnvelope(gap)
        await daemon.waitDetail("task")
        store.applyEnvelope(gap)
        await daemon.finishDetail("task", id: "task")
        await daemon.waitDetail("task")
        await daemon.release("task")
        await daemon.finishDetail("task", id: "task")
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(store.isLoading)
        XCTAssertNil(store.errorMessage)
        XCTAssertEqual(store.messages.first?.text, "task")
    }

    @MainActor func testKeyboardTaskNavigationUsesTheVisibleSidebarOrder() async {
        let daemon = ReviewDaemon(), store = AppStore(client: daemon)
        let rows = ["a", "b", "c"].map { reviewTask($0) }
        await daemon.configure(rows)
        store.applyEnvelope(reviewSnapshotEnvelope(rows))
        store.registerTaskNavigation(["c", "a"], section: "project", projectID: "p")
        await store.navigateTask(1)
        XCTAssertEqual(store.selectedTaskID, "c", "A new composer starts at the first visible task")
        await store.navigateTask(1)
        XCTAssertEqual(store.selectedTaskID, "a", "Filtered-out B must not be selected")
        store.selectSection("settings")
        await store.navigateTask(1)
        XCTAssertEqual(store.selectedSection, "settings", "A stale navigator cannot navigate an unrelated screen")
    }

    @MainActor func testClosedProjectsDoNotConsumeAnotherHostsSavedOrderSlots() async throws {
        let store = AppStore(client: ReviewDaemon())
        store.applyEnvelope(reviewSnapshotEnvelope([]))
        let remote = reviewSnapshot([]).setting("preferences", .object([
            "workspace_order": .array([.string("closed-project"), .string("p")])
        ]))
        store.receiveHost(.init(hostID: "h", event: .snapshot(remote)))
        try await store.updateNavigationPreferences(.object([
            "workspace_order": .array([.string("remote:h:p"), .string("p")])
        ]), hostID: nil)
        XCTAssertEqual(store.navigationPreferences["workspace_order"].array.map(\.string), ["remote:h:p", "p"])
    }
}
