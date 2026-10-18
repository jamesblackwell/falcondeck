import Foundation
import XCTest
@testable import FalconDeckNative

@MainActor final class StartupRecoveryTests: XCTestCase {
    private func fixture(relay: any RelayServing) throws -> (AppModel, SavedSession, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appending(path: "NativeStartup-\(UUID())")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let input = root.appending(path: "input"), cache = root.appending(path: "cache")
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let suite = "NativeStartup-\(UUID())", defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let model = AppModel(relay: relay, voice: VoiceRecorder(defaults: defaults), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { session }, sessionCacheRoot: cache, inputDraftRoot: input)
        return (model, session, input, cache)
    }
    func testCorruptNavigationDoesNotDiscardRecoveredInputOrDisableSaving() async throws {
        let (model, session, root, _) = try fixture(relay: UnavailablePreviewRelay())
        let store = try DraftStore(session: session, root: root)
        try await store.save(SavedDraft(id: "task", text: "Keep my draft", attachments: [], modelID: "model", effort: "high", provider: "codex", overrides: [:]))
        try await store.saveSelection(.task("task"))
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!.allObjects.compactMap { $0 as? URL }
        try Data("Corrupted navigation file".utf8).write(to: XCTUnwrap(files.first { $0.lastPathComponent == "selection" }))
        await model.restoreInputs(session: session)
        XCTAssertNotNil(model.draftStore)
        XCTAssertEqual(model.savedDrafts["task"]?.text, "Keep my draft")
        XCTAssertNil(model.pendingSelection)
        XCTAssertTrue(model.error?.contains("input has been restored") == true)
        let chat = model.chat(for: AgentTask(.object(["id": .string("task"), "provider": .string("codex")])))
        XCTAssertEqual(chat.draft, "Keep my draft")
        chat.draft = "Updated draft"; await model.saveAllInputs()
        let recovered = try await store.load()
        XCTAssertEqual(recovered.first?.text, "Updated draft")
    }
    func testForgettingDuringInputRestoreCannotPublishTheOldPreviewOrReconnect() async throws {
        let relay = PausedStartupRelay()
        let (model, session, inputRoot, cacheRoot) = try fixture(relay: relay)
        let inputs = try DraftStore(session: session, root: inputRoot)
        try await inputs.saveSelection(.task("old-task"))
        let cache = try SessionCacheStore(session: session, root: cacheRoot)
        try await cache.save(SessionCacheInput(projects: [.object(["id": .string("old-project"), "path": .string("/old")])], tasks: [.object(["id": .string("old-task"), "workspace_id": .string("old-project")])], preferences: .null, selectedID: "old-task", histories: [:]))
        let startup = Task { await model.start() }
        for _ in 0..<1000 {
            if await relay.waiting { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        let waiting = await relay.waiting; XCTAssertTrue(waiting)
        await model.forget()
        await relay.release()
        await startup.value
        XCTAssertFalse(model.hasSession)
        XCTAssertTrue(model.projects.isEmpty); XCTAssertTrue(model.tasks.isEmpty)
        XCTAssertNil(model.sessionCache); XCTAssertTrue(model.savedDrafts.isEmpty)
        let restores = await relay.restores; XCTAssertEqual(restores, 0)
    }
}

private actor PausedStartupRelay: RelayServing {
    private var gate: CheckedContinuation<Void, Never>?
    private var released = false
    var waiting: Bool { gate != nil }
    private(set) var restores = 0
    func release() { released = true; gate?.resume(); gate = nil }
    func selectThread(_ id: String?) async {
        if id == "old-task", !released { await withCheckedContinuation { gate = $0 } }
    }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func restore(connectionID: UUID) -> Bool { restores += 1; return true }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) -> JSON { .null }
}
