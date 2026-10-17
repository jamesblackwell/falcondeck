import XCTest
@testable import FalconDeckNative

private actor FolderRelay: RelayServing {
    var pending: CheckedContinuation<JSON, Error>?
    var mutation: JSON = .null
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async throws -> JSON {
        mutation = params["project_folder"]
        return try await withCheckedThrowingContinuation { pending = $0 }
    }
    func requested() -> JSON? { pending == nil ? nil : mutation }
    func finish(_ result: Result<JSON, Error>) { let current = pending; pending = nil; current?.resume(with: result) }
}

@MainActor final class FolderDisclosureTests: XCTestCase {
    private let folder = ProjectFolder(raw: .object(["id": .string("f"), "workspace_id": .string("p"), "collapsed": .bool(true)]))
    private func preferences(collapsed: Bool) -> JSON { .object(["project_folders": .array([folder.raw.setting("collapsed", .bool(collapsed))])]) }
    func testPreferenceAndFolderWritesSerializeTheirFullSnapshotResponses() async throws {
        let relay = PreferenceRaceRelay(), model = AppModel.testing(relay: relay)
        let first = Task { try await model.updatePreferences(.object(["workspace_order": .array([.string("p")])])) }
        await relay.waitForFirst()
        var joined = false
        let second = Task { joined = true; try await model.folderMutation(projectID: "p", action: "set_collapsed", folderID: "f", collapsed: false) }
        while !joined { await Task.yield() }
        for _ in 0..<5 { await Task.yield() }
        let before = await relay.calls
        XCTAssertEqual(before, 1, "Folder mutations and other preference writes must share one writer")
        await relay.finishFirst()
        try await first.value; try await second.value
        XCTAssertEqual(model.preferences["project_folders"].array.first?["collapsed"], .bool(false))
        XCTAssertEqual(model.preferences["workspace_order"].array, [.string("p")])
    }
    func testLivePreferencesWinOverAnOlderWriteResponse() async throws {
        let relay = PreferenceRaceRelay(), model = AppModel.testing(relay: relay)
        let save = Task { try await model.updatePreferences(.object(["workspace_order": .array([.string("p")])])) }
        await relay.waitForFirst()
        let latest = JSON.object(["workspace_order": .array([.string("p")]), "updated_on_desktop": .bool(true)])
        model.receive(.init(connectionID: model.connectionID, event: .events([.object(["seq": .number(1), "event": .object(["type": .string("preferences-updated"), "preferences": latest])])])))
        await relay.finishFirst(); try await save.value
        XCTAssertEqual(model.preferences, latest)
    }
    private func request(_ relay: FolderRelay) async -> JSON {
        for _ in 0..<1_000 {
            if let params = await relay.requested() { return params }
            try? await Task.sleep(for: .milliseconds(1))
        }
        XCTFail("Expected a folder save"); return .null
    }
    private func settled(_ state: FolderDisclosures) async {
        for _ in 0..<1_000 {
            if state.saving.isEmpty { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
        XCTFail("Folder save did not settle")
    }
    func testRapidTapsStayResponsiveAndPersistTheLatestIntentSerially() async {
        let relay = FolderRelay(), state = FolderDisclosures()
        let model = AppModel.testing(relay: relay); model.preferences = preferences(collapsed: true)
        state.toggle(folder, model: model)
        XCTAssertTrue(state.isExpanded(folder))
        let first = await request(relay)
        XCTAssertFalse(first["collapsed"].bool)
        state.toggle(folder, model: model)
        XCTAssertFalse(state.isExpanded(folder), "A pending save must not block closing the folder")
        await relay.finish(.success(preferences(collapsed: false)))
        let second = await request(relay)
        XCTAssertTrue(second["collapsed"].bool)
        XCTAssertFalse(state.isExpanded(model.folders[0]), "The first acknowledgement must not reopen the folder")
        await relay.finish(.success(preferences(collapsed: true)))
        await settled(state)
        XCTAssertFalse(state.isExpanded(model.folders[0]))
        XCTAssertTrue(state.overrides.isEmpty)
    }
    func testFailedSaveRestoresSyncedStateAndReportsTheFailure() async {
        let relay = FolderRelay(), state = FolderDisclosures()
        let model = AppModel.testing(relay: relay); model.preferences = preferences(collapsed: true)
        state.toggle(folder, model: model)
        _ = await request(relay)
        await relay.finish(.failure(PilotError("Offline")))
        await settled(state)
        XCTAssertFalse(state.isExpanded(model.folders[0]))
        XCTAssertEqual(model.error, "Offline")
    }
    func testNewConnectionRejectsThePreviousFolderAcknowledgement() async {
        let relay = FolderRelay(), state = FolderDisclosures()
        let model = AppModel.testing(relay: relay); model.preferences = preferences(collapsed: true)
        state.toggle(folder, model: model)
        _ = await request(relay)
        await model.useDemo(); state.reset()
        let current = model.preferences
        await relay.finish(.success(preferences(collapsed: false)))
        await Task.yield()
        XCTAssertEqual(model.preferences, current)
        XCTAssertNil(model.error)
        XCTAssertTrue(state.overrides.isEmpty)
    }
}

private actor PreferenceRaceRelay: RelayServing {
    private var pending: CheckedContinuation<JSON, Never>?
    private var ready: CheckedContinuation<Void, Never>?
    private(set) var calls = 0
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async -> JSON {
        calls += 1
        if calls == 1 { return await withCheckedContinuation { pending = $0; ready?.resume(); ready = nil } }
        return Self.first.setting("project_folders", .array([.object(["id": .string("f"), "collapsed": .bool(false)])]))
    }
    private static let first = JSON.object(["workspace_order": .array([.string("p")])])
    func waitForFirst() async { if pending == nil { await withCheckedContinuation { ready = $0 } } }
    func finishFirst() { pending?.resume(returning: Self.first); pending = nil }
}
