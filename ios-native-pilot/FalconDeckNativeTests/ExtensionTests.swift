import XCTest
@testable import FalconDeckNative

private actor ExtensionRelay: RelayServing {
    var pending: CheckedContinuation<JSON, Error>?
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async throws -> JSON { try await withCheckedThrowingContinuation { pending = $0 } }
    func wait() async { while pending == nil { await Task.yield() } }
    func finish(_ value: JSON) { pending?.resume(returning: value); pending = nil }
}

@MainActor final class ExtensionTests: XCTestCase {
    private let id = NativeExtensions.stagesID
    private var task: AgentTask { AgentTask(.object(["id": .string("task"), "status": .string("idle")])) }
    private func view(_ stage: String) -> JSON { .object(["extension_id": .string(id), "view_id": .string("thread-tags"), "scope": .object(["kind": .string("thread"), "id": .string("task")]), "value": .object(["tagIds": .array([.string(stage)])])]) }
    private func catalog(_ contributions: JSON = .object([:])) -> JSON { .object(["id": .string(id), "enabled": .bool(true), "contributes": contributions]) }
    func testLiveStageAndDeletionWinAgainstALateExtensionSnapshot() async {
        for deleting in [false, true] {
            let relay = ExtensionRelay(), model = AppModel.testing(relay: relay)
            model.connected = true
            let store = model.extensions
            store.setBase(.null, token: "index")
            let pending = Task { await store.load(model: model) }
            await relay.wait()
            store.apply(.object(["type": .string("extension-catalog-updated"), "catalog": .array([catalog()])]))
            store.apply(.object(["type": .string("extension-view-updated"), "view": view("done")]))
            if deleting { store.apply(.object(["type": .string("extension-view-updated"), "extension_id": .string(id), "view_id": .string("thread-tags"), "scope": view("done")["scope"], "view": .null])) }
            await relay.finish(.object(["catalog": .array([]), "views": .array([view("backlog")])]))
            await pending.value
            XCTAssertEqual(store.catalog.count, 1)
            if deleting { XCTAssertNil(store.stage(task)) } else { XCTAssertEqual(store.stage(task)?["id"].string, "done") }
        }
    }
    func testAReplacementSnapshotRemovesOldUntouchedViews() async {
        let relay = ExtensionRelay(), model = AppModel.testing(relay: relay)
        model.connected = true
        let store = model.extensions
        store.catalog = [catalog()]; store.views = [view("done")]
        store.setBase(.null, token: "replacement")
        let pending = Task { await store.load(model: model) }
        await relay.wait()
        await relay.finish(.object(["catalog": .array([catalog()]), "views": .array([])]))
        await pending.value
        XCTAssertTrue(store.views.isEmpty)
        XCTAssertNil(store.stage(task))
    }
    func testDemoMarkReadAdvancesReadSequence() async {
        let model = AppModel.testing(relay: ExtensionRelay())
        model.demo = true
        let unread = AgentTask(task.raw.setting("attention", .object(["unread": .bool(true), "last_agent_activity_seq": .number(5), "last_read_seq": .number(2)])))
        model.tasks = [unread]
        await model.markRead(unread)
        XCTAssertFalse(model.tasks[0].unread)
        XCTAssertEqual(model.tasks[0].raw["attention"]["last_read_seq"].int, 5)
    }
    func testOrdinaryTagIndexValuesDoNotOverrideDeclarativeFilterDefinitions() {
        let store = NativeExtensions()
        let document = JSON.object(["version": .number(1), "root": .object(["type": .string("select"), "label": .string("Stages"), "options": .array([.object(["value": .string("done"), "label": .string("Done")])]), "binding": .object(["view": .string("thread-tags"), "path": .array([.string("tagIds")]), "operator": .string("includes_any")])])])
        store.catalog = [catalog(.object(["sidebarFilters": .array([.object(["id": .string("stage"), "view": .string("tag-index"), "ui": document])])]))]
        store.views = [view("done"), .object(["extension_id": .string(id), "view_id": .string("tag-index"), "value": .object(["tags": .array([])])])]
        XCTAssertTrue(store.filters.first?.supported == true)
        store.selections[store.filters[0].id] = ["done"]
        XCTAssertTrue(store.matches(task))
        store.selections[store.filters[0].id] = ["backlog"]
        XCTAssertFalse(store.matches(task))
    }
    func testSuggestionsRequireEnabledDeclaredViewsAndAnIdleTask() {
        let store = NativeExtensions()
        store.catalog = [catalog(.object(["composerSuggestions": .array([.object(["view": .string("follow-ups")])])]))]
        store.views = [.object(["extension_id": .string(id), "view_id": .string("follow-ups"), "scope": .object(["kind": .string("thread"), "id": .string("task")]), "value": .object(["actions": .array([.object(["id": .string("first"), "label": .string("First"), "prompt": .string("First prompt")]), .object(["id": .string("preferred"), "label": .string("Preferred"), "prompt": .string("Preferred prompt")])]), "preferredActionId": .string("preferred")])])]
        XCTAssertEqual(store.suggestions(task)?.actions.first?["id"].string, "preferred")
        XCTAssertNil(store.suggestions(AgentTask(task.raw.setting("status", .string("running")))))
        let offer = store.suggestions(task)!
        store.dismissed[task.id] = offer.key
        XCTAssertNil(store.suggestions(task))
        store.dismissed = [:]; store.catalog = [catalog().setting("enabled", .bool(false))]
        XCTAssertNil(store.suggestions(task))
    }
    func testPanelDocumentsRejectUnknownAndExcessivelyDeepNodes() {
        XCTAssertFalse(ExtensionDocument.valid(.object(["type": .string("script"), "text": .string("anything")])) )
        var node = JSON.object(["type": .string("text"), "text": .string("Safe")])
        XCTAssertTrue(ExtensionDocument.valid(node))
        for _ in 0..<13 { node = .object(["type": .string("stack"), "children": .array([node])]) }
        XCTAssertFalse(ExtensionDocument.valid(node))
    }
    func testBackgroundWorkIsRunningBeforeUnreadIsReadyForReview() {
        let working = AgentTask(task.raw.setting("attention", .object(["background_task_count": .number(1), "unread": .bool(true)])))
        XCTAssertEqual(ActivitySection.section(working, requests: []), .running)
        XCTAssertEqual(ActivitySection.section(working, requests: [.object(["thread_id": .string(task.id)])]), .blocked)
        let failed = AgentTask(working.raw.setting("status", .string("error")))
        XCTAssertEqual(ActivitySection.section(failed, requests: []), .failed)
    }
    func testProjectDomainAcceptsURLsAndRejectsInvalidHosts() {
        XCTAssertEqual(ProjectDomain.normalize("https://Example.COM/path"), "example.com")
        XCTAssertNil(ProjectDomain.normalize(".example.com"))
        XCTAssertNil(ProjectDomain.normalize("one..two.com"))
        XCTAssertNil(ProjectDomain.normalize("localhost"))
    }
}
