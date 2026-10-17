import XCTest
@testable import FalconDeckNative

private actor PageRelay: RelayServing {
    var pending: CheckedContinuation<JSON, Error>?
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async throws -> JSON { try await withCheckedThrowingContinuation { pending = $0 } }
    func wait() async { while pending == nil { await Task.yield() } }
    func finish(_ result: JSON) { pending?.resume(returning: result); pending = nil }
}

@MainActor final class CompactSyncTests: XCTestCase {
    private func row(_ id: String, stamp: String = "2026-10-17T10:00:00Z") -> AgentTask {
        AgentTask(.object(["id": .string(id), "workspace_id": .string("p"), "updated_at": .string(stamp), "status": .string("idle")]))
    }
    private func counts(_ total: Int) -> JSON { .object(["p": .object(["total": .number(Double(total))])]) }
    func testCatalogReferencesAreExpandedAndInvalidReferencesFail() throws {
        var index = JSON.object(["token": .string("index"), "snapshot": .object(["workspaces": .array([.object(["id": .string("p")])])]), "agent_catalogs": .array([.object(["provider": .string("codex")])]), "model_catalogs": .array([.array([.object(["id": .string("m")])])]), "workspace_agents": .object(["p": .array([.number(0)])]), "workspace_models": .object(["p": .number(0)])])
        let expanded = try CompactSync.expand(index)
        XCTAssertEqual(expanded["workspaces"].array[0]["agents"].array[0]["provider"].string, "codex")
        XCTAssertEqual(expanded["workspaces"].array[0]["models"].array[0]["id"].string, "m")
        index = index.setting("workspace_agents", .object(["p": .array([.number(99)])]))
        XCTAssertThrowsError(try CompactSync.expand(index))
    }
    func testPartialIndexRetainsLoadedRowsAndHydratedFields() {
        var index = CompactSync(token: "index", counts: counts(3))
        let detailed = AgentTask(row("one").raw.setting("goal", .object(["objective": .string("Finish")])))
        let retained = index.retain([row("one")], previous: [detailed, row("two")], projectIDs: ["p"], hidden: [], selected: nil)
        XCTAssertEqual(retained.map(\.id), ["one", "two"])
        XCTAssertEqual(retained[0].goal["objective"].string, "Finish")
        XCTAssertEqual(index.carried, ["two"])
    }
    func testACompletePagePrunesOnlyUnconfirmedCarriedRows() async {
        let relay = PageRelay()
        let controlled = AppModel.testing(relay: relay)
        controlled.connected = true; controlled.tasks = [row("stale"), row("live")]
        var index = CompactSync(token: "index", counts: counts(2)); index.carried = ["stale", "live"]; index.touched = ["live"]
        controlled.syncIndex = index
        let pending = Task { await controlled.loadTaskPage("p") }
        await relay.wait()
        await relay.finish(.object(["token": .string("index"), "workspace_id": .string("p"), "threads": .array([]), "next_cursor": .null]))
        await pending.value
        XCTAssertEqual(controlled.tasks.map(\.id), ["live"])
        XCTAssertFalse(controlled.hasMoreTasks("p"))
    }
    func testLatePageCannotReviveATaskArchivedByALiveEvent() async throws {
        let relay = PageRelay(), model = AppModel.testing(relay: relay)
        model.connected = true; model.tasks = [row("task")]
        model.syncIndex = CompactSync(token: "index", counts: counts(1))
        let pending = Task { await model.loadTaskPage("p") }
        await relay.wait()
        let archived = row("task", stamp: "2026-10-17T10:01:00Z").raw.setting("is_archived", .bool(true))
        model.receive(RelayUpdate(connectionID: model.connectionID, event: .events([.object(["seq": .number(1), "thread_id": .string("task"), "event": .object(["type": .string("thread-updated"), "thread": archived])])])))
        await relay.finish(.object(["token": .string("index"), "workspace_id": .string("p"), "threads": .array([row("task").raw]), "next_cursor": .null]))
        await pending.value
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertTrue(model.tasks.isEmpty)
        XCTAssertTrue(model.archivedTasks.first?.archived == true)
    }

    func testInitialPagesLoadEachUnloadedScopeOnceAndKeepCancelledReadResults() async {
        let relay = PageRelay(), model = AppModel.testing(relay: relay)
        model.connected = true
        model.syncIndex = CompactSync(token: "index", counts: counts(3))
        let plan = TaskPagePlan(connectionID: model.connectionID, token: "index", connected: true, sort: "last_updated", scopes: [TaskPageScope(projectID: "p")])
        let load = Task { await model.loadInitialTaskPages(plan) }
        await relay.wait()
        load.cancel()
        await relay.finish(.object(["token": .string("index"), "workspace_id": .string("p"), "threads": .array([row("one").raw]), "next_cursor": .number(1)]))
        await load.value
        XCTAssertEqual(model.tasks.map(\.id), ["one"])
        XCTAssertEqual(model.syncIndex?.cursors[CompactSync.key(project: "p", folder: nil)], .number(1))
        // This would hang if reopening silently fetched the next page.
        await model.loadInitialTaskPages(plan)
        XCTAssertTrue(model.taskPageLoads.isEmpty)
    }

    func testARefreshedIndexLoadsTheStillExpandedScopeAgain() async {
        let relay = PageRelay(), model = AppModel.testing(relay: relay)
        model.connected = true
        for token in ["one", "two"] {
            model.syncIndex = CompactSync(token: token, counts: counts(1))
            let plan = TaskPagePlan(connectionID: model.connectionID, token: token, connected: true, sort: "last_updated", scopes: [TaskPageScope(projectID: "p")])
            let load = Task { await model.loadInitialTaskPages(plan) }
            await relay.wait()
            await relay.finish(.object(["token": .string(token), "workspace_id": .string("p"), "threads": .array([row(token).raw]), "next_cursor": .null]))
            await load.value
            XCTAssertNotNil(model.task(token))
        }
    }
}
