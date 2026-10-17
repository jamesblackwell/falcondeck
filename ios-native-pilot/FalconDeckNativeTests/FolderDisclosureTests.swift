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
