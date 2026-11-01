import XCTest
@testable import FalconDeckNative

private actor ScopeRelay: RelayServing {
    var pauses = 0
    var canPause = true
    var interests: [Set<String>] = []
    var scopes: [SyncIndexScope?] = []
    var calls: [String] = []
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) -> JSON { calls.append(method); return .null }
    func setInterest(_ threads: Set<String>) { interests.append(threads) }
    func setIndexScope(_ scope: SyncIndexScope?) { scopes.append(scope) }
    func pauseIfIdle() -> Bool { pauses += 1; return canPause }
    func block() { canPause = false }
}

private actor ExtensionRelay: RelayServing {
    var calls: [(String, JSON)] = []
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) -> JSON {
        calls.append((method, params))
        let views = params["thread_ids"].array.map { id in
            JSON.object(["extension_id": .string("x"), "view_id": .string("v"), "scope": .object(["kind": .string("thread"), "id": id]), "value": .object([:])])
        }
        return .object(["catalog": .array([]), "views": .array(views)])
    }
}

@MainActor final class SyncScopeTests: XCTestCase {
    private func thread(_ id: String, project: String = "p", stamp: String = "2026-11-01T10:00:00Z", status: String = "idle") -> JSON {
        .object(["id": .string(id), "workspace_id": .string(project), "updated_at": .string(stamp), "status": .string(status)])
    }
    private func update(_ model: AppModel, seq: Int, thread id: String, event: JSON) {
        model.receive(RelayUpdate(connectionID: model.connectionID, event: .events([.object(["seq": .number(Double(seq)), "thread_id": .string(id), "event": event])])))
    }

    func testEventScopeTagMatchesTheDaemonKnownAnswer() {
        let key = Data((0..<32).map { UInt8($0) })
        XCTAssertEqual(EventScope.tag(thread: "thread-1", key: key), "aoXdKz1fn4Xc6qk6")
        XCTAssertNotEqual(EventScope.tag(thread: "thread-2", key: key), EventScope.tag(thread: "thread-1", key: key))
        XCTAssertNotEqual(EventScope.tag(thread: "thread-1", key: Data(repeating: 9, count: 32)), EventScope.tag(thread: "thread-1", key: key))
        let many = Set((0..<100).map { "thread-\($0)" })
        XCTAssertEqual(EventScope.tags(for: many, key: key).count, EventScope.maxTags)
        XCTAssertFalse(EventScope.tag(thread: "thread-1", key: key).contains { "+/=".contains($0) })
    }

    func testIndexRequestAsksForTheNewestRowsOfTheOpenListsOnly() {
        let params = SyncIndexScope(workspaceIDs: ["a", "b"]).params(selected: "open")
        XCTAssertEqual(params["selected_thread_id"].string, "open")
        XCTAssertEqual(params["recent_per_workspace"].int, 5)
        XCTAssertEqual(params["recent_workspace_ids"].array.map(\.string), ["a", "b"])
        XCTAssertEqual(params["recent_chats"].int, 20)
        XCTAssertEqual(SyncIndexScope(workspaceIDs: (0..<40).map(String.init)).params(selected: nil)["recent_workspace_ids"].array.count, 16)
        XCTAssertEqual(SyncIndexScope().params(selected: nil)["selected_thread_id"], .null)
    }

    func testIndexRowsAndCursorsMeanNoPageCallsAfterASync() async throws {
        let relay = ScopeRelay(), model = AppModel.testing(relay: relay)
        model.connected = true
        let index = JSON.object([
            "token": .string("t"), "agent_catalogs": .array([]), "model_catalogs": .array([]),
            "snapshot": .object(["workspaces": .array([.object(["id": .string("p")]), .object(["id": .string("chat")])]), "threads": .array([thread("one"), thread("two")])]),
            "counts": .object(["p": .object(["total": .number(40)]), "chat": .object(["total": .number(1)])]),
            "initial_cursors": .object(["p": .number(2), "chat": .null]),
        ])
        model.receive(RelayUpdate(connectionID: model.connectionID, event: .snapshot(try CompactSync.expand(index))))
        XCTAssertEqual(model.tasks.map(\.id).sorted(), ["one", "two"])
        let plan = TaskPagePlan(connectionID: model.connectionID, token: "t", connected: true, sort: "last_updated", scopes: [TaskPageScope(projectID: "p"), TaskPageScope(projectID: "chat")])
        await model.loadInitialTaskPages(plan)
        let calls = await relay.calls
        XCTAssertEqual(calls, [], "the index already carried both lists' first rows")
        XCTAssertTrue(model.hasMoreTasks("p"), "Show more continues after the shipped rows")
        XCTAssertFalse(model.hasMoreTasks("chat"), "a fully shipped list has nothing more")
        XCTAssertEqual(model.syncIndex?.cursors[CompactSync.key(project: "p", folder: nil)], .number(2))
    }

    func testAnIndexWithoutCursorsStillPagesEachScope() async {
        let model = AppModel.testing(relay: ScopeRelay())
        XCTAssertTrue(CompactSync.initialCursors(.null).isEmpty)
        XCTAssertTrue(CompactSync.initialCursors(.object([:])).isEmpty)
        model.syncIndex = CompactSync(token: "t", counts: .object(["p": .object(["total": .number(3)])]))
        XCTAssertTrue(model.hasMoreTasks("p"))
    }

    func testLiveStreamInterestIsTheLastThreeOpenedPlusWorkInFlight() async throws {
        let relay = ScopeRelay(), model = AppModel.testing(relay: relay)
        for id in ["a", "b", "c", "d"] { model.selection = .task(id) }
        XCTAssertEqual(model.eventInterest, ["b", "c", "d"])
        let chat = model.chat(for: AgentTask(thread("a")))
        chat.loading = true
        XCTAssertEqual(model.eventInterest, ["a", "b", "c", "d"])
        chat.loading = false
        model.updateEventInterest()
        try await Task.sleep(for: .milliseconds(50))
        let pushed = await relay.interests
        XCTAssertEqual(pushed.last, ["b", "c", "d"])
        // Unchanged interest is not resent.
        let before = pushed.count
        model.updateEventInterest(); model.updateEventInterest()
        try await Task.sleep(for: .milliseconds(20))
        let after = await relay.interests.count
        XCTAssertEqual(after, before)
    }

    func testSummaryUpdateMarksAnOutOfScopeTranscriptStaleButNotTheOpenOne() async {
        let model = AppModel.testing(relay: ScopeRelay())
        model.connected = true
        model.tasks = [AgentTask(thread("open")), AgentTask(thread("away"))]
        model.selection = .task("open")
        let open = model.chat(for: model.task("open")!), away = model.chat(for: model.task("away")!)
        open.loaded = true; away.loaded = true
        let updated = thread("away", stamp: "2026-11-01T11:00:00Z")
        // Without scoped delivery its events still arrive; nothing is stale.
        update(model, seq: 1, thread: "away", event: .object(["type": .string("thread-updated"), "thread": updated]))
        XCTAssertFalse(away.needsRefresh)
        model.receive(RelayUpdate(connectionID: model.connectionID, event: .capabilities(scoped: true)))
        update(model, seq: 2, thread: "away", event: .object(["type": .string("thread-updated"), "thread": thread("away", stamp: "2026-11-01T11:05:00Z")]))
        update(model, seq: 3, thread: "open", event: .object(["type": .string("thread-updated"), "thread": thread("open", stamp: "2026-11-01T11:05:00Z")]))
        XCTAssertTrue(away.needsRefresh)
        XCTAssertFalse(open.needsRefresh, "the open thread keeps receiving its own stream")
    }

    func testClosingTheSocketWaitsForTheGraceAndForIdleWork() async throws {
        let relay = ScopeRelay(), provider = BackgroundTaskFixture()
        let model = AppModel(relay: relay, backgroundExecution: BackgroundExecution(provider: provider), sessionLoader: { nil })
        model.hasSession = true; model.connected = true; model.restoringSession = false
        model.syncScope.pauseGrace = .milliseconds(30)
        // Returning inside the grace keeps the live connection.
        model.setForeground(false); model.scheduleBackgroundPause()
        model.setForeground(true)
        try await Task.sleep(for: .milliseconds(80))
        var pauses = await relay.pauses
        XCTAssertEqual(pauses, 0); XCTAssertTrue(model.connected)
        XCTAssertEqual(provider.ended.count, provider.next, "every grace-period assertion ends")
        // Staying away closes it, once, and foregrounding reconnects.
        model.setForeground(false); model.scheduleBackgroundPause()
        try await Task.sleep(for: .milliseconds(120))
        pauses = await relay.pauses
        XCTAssertEqual(pauses, 1); XCTAssertFalse(model.connected); XCTAssertTrue(model.syncScope.paused)
        model.setForeground(true)
        XCTAssertFalse(model.syncScope.paused)
        await model.foregroundRefresh?.value
        // A request in flight refuses the pause and leaves the app connected.
        await relay.block(); model.connected = true
        model.setForeground(false); model.scheduleBackgroundPause()
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertTrue(model.connected)
        model.setForeground(true)
    }

    func testRecordingAndReadAloudKeepTheConnection() async throws {
        let relay = ScopeRelay()
        let model = AppModel(relay: relay, backgroundExecution: BackgroundExecution(provider: BackgroundTaskFixture()), sessionLoader: { nil })
        model.hasSession = true; model.connected = true; model.restoringSession = false
        model.syncScope.pauseGrace = .milliseconds(20)
        model.readAloud.messageID = "speaking"
        model.setForeground(false); model.scheduleBackgroundPause()
        try await Task.sleep(for: .milliseconds(100))
        let pauses = await relay.pauses
        XCTAssertEqual(pauses, 0); XCTAssertTrue(model.connected)
        model.setForeground(true)
    }

    func testSidebarListsTheNewestRowsPlusAnyOlderOneThatNeedsYou() {
        func row(_ id: Int, status: String = "idle", unread: Bool = false) -> AgentTask {
            AgentTask(.object(["id": .string("t\(id)"), "workspace_id": .string("p"), "status": .string(status), "updated_at": .string("2026-11-01T10:00:00Z"),
                               "attention": .object(["unread": .bool(unread)])]))
        }
        let rows = (0..<12).map { row($0, status: $0 == 7 ? "running" : $0 == 9 ? "error" : "idle", unread: $0 == 10) }
        XCTAssertEqual(SidebarRows.visible(rows, limit: 5).map(\.id), ["t0", "t1", "t2", "t3", "t4", "t7", "t9", "t10"])
        XCTAssertEqual(SidebarRows.visible(rows, limit: 15).count, 12)
        XCTAssertEqual(SidebarRows.visible(Array(rows.prefix(3)), limit: 5).count, 3)
    }

    func testExtensionViewsLoadForListedThreadsAndLaterRowsAskOnce() async throws {
        let relay = ExtensionRelay(), model = AppModel.testing(relay: relay)
        model.connected = true
        model.tasks = [AgentTask(thread("a")), AgentTask(thread("b"))]
        model.extensions.setBase(.object([:]), token: "t")
        await model.extensions.load(model: model)
        var calls = await relay.calls
        XCTAssertEqual(calls.map(\.0), ["sync.extensions"])
        XCTAssertEqual(calls[0].1["thread_ids"].array.map(\.string), ["a", "b"])
        XCTAssertEqual(model.extensions.views.count, 2)
        // Rows that appear later (Show more, an opened task) are fetched together, once.
        model.extensions.ensureThreads(["c", "d", "a"], model: model)
        model.extensions.ensureThreads(["c"], model: model)
        try await Task.sleep(for: .milliseconds(500))
        calls = await relay.calls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(Set(calls[1].1["thread_ids"].array.map(\.string)), ["c", "d"])
        XCTAssertEqual(model.extensions.views.count, 4)
        model.extensions.ensureThreads(["a", "c"], model: model)
        try await Task.sleep(for: .milliseconds(400))
        let after = await relay.calls.count
        XCTAssertEqual(after, 2, "already requested threads are not fetched again")
    }

    func testMeterCountsKindsAndBytes() {
        var meter = SyncMeter()
        meter.record("wire.in", bytes: 100); meter.record("wire.in", bytes: 50); meter.record("event.text")
        let report = meter.report()
        XCTAssertEqual(report.entries["wire.in"], SyncMeter.Entry(count: 2, bytes: 150))
        XCTAssertEqual(report.entries["event.text"], SyncMeter.Entry(count: 1, bytes: 0))
        XCTAssertEqual(report.totalBytes, 150)
        meter.reset(); XCTAssertTrue(meter.report().entries.isEmpty)
    }
}
