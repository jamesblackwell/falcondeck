import UIKit
import XCTest
@testable import FalconDeckNative

@MainActor final class BackgroundReliabilityTests: XCTestCase {
    func testExpirationAndNormalCompletionEndEachAssertionExactlyOnce() {
        let provider = BackgroundTaskFixture(), work = BackgroundExecution(provider: provider)
        var expirations = 0
        let first = work.begin("save") { expirations += 1 }, second = work.begin("voice")
        provider.expire(1); provider.expire(1); first.finish()
        XCTAssertTrue(first.expired); XCTAssertEqual(expirations, 1)
        XCTAssertEqual(provider.ended, [1])
        second.finish(); provider.expire(2); second.finish()
        XCTAssertFalse(second.expired); XCTAssertEqual(provider.ended, [1, 2])
    }
    func testSynchronousExpirationAndDeniedExecutionDoNotLeakIdentifiers() {
        let provider = BackgroundTaskFixture(); provider.expireImmediately = true
        let lease = BackgroundExecution(provider: provider).begin("save")
        XCTAssertTrue(lease.expired); XCTAssertEqual(provider.ended, [1])
        lease.finish(); XCTAssertEqual(provider.ended, [1])
        provider.deny = true
        let denied = BackgroundExecution(provider: provider).begin("save")
        denied.finish(); XCTAssertEqual(provider.ended, [1])
    }
    func testBackgroundFlushCapturesLatestInputBeforeSuspendingAndNeverReadsANewPairingsDrafts() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "NativeBackground-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let store = try DraftStore(session: session, root: root)
        let provider = BackgroundTaskFixture()
        let model = AppModel(relay: UnavailablePreviewRelay(), backgroundExecution: BackgroundExecution(provider: provider), sessionLoader: { nil })
        model.draftStore = store
        let task = AgentTask(.object(["id": .string("task")]))
        let chat = model.chat(for: task); chat.draft = "Latest unsent text 🦅"
        model.selection = .task(task.id)
        model.scheduleInputSave(task.id, chat: chat)
        model.saveBeforeSuspension()
        let saving = model.backgroundSave
        model.draftStore = nil; model.chats = [:]
        await saving?.value
        let saved = try await store.load(), selection = try await store.loadSelection()
        XCTAssertEqual(saved.first?.text, "Latest unsent text 🦅")
        XCTAssertEqual(selection, .task(task.id))
        XCTAssertTrue(model.draftSaves.isEmpty)
        XCTAssertNil(model.backgroundSave)
        XCTAssertEqual(provider.ended, [1])
        try await store.clear()
        do { try await store.save(saved[0]); XCTFail("A late save must not recreate a forgotten pairing") }
        catch { }
    }
    func testForegroundTransitionsCoalesceRefreshAndInactiveDoesNotFlush() async {
        let relay = BackgroundRefreshRelay(), provider = BackgroundTaskFixture()
        let model = AppModel(relay: relay, backgroundExecution: BackgroundExecution(provider: provider), sessionLoader: { nil })
        model.hasSession = true; model.connected = true; model.restoringSession = false
        model.setForeground(false); model.setForeground(false)
        XCTAssertEqual(provider.next, 0)
        model.setForeground(true); model.setForeground(true)
        model.setForeground(false); model.setForeground(true)
        for _ in 0..<100 { if await relay.refreshes == 1 { break }; await Task.yield() }
        let count = await relay.refreshes; XCTAssertEqual(count, 1)
        await relay.release(); await model.foregroundRefresh?.value
    }
    func testDelayedBackgroundBatchCannotOverwriteNewerInputOrResurrectASentDraft() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "DraftOrdering-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let store = try DraftStore(session: session, root: root), chat = ChatSession()
        chat.draft = "Old background snapshot"; let old = chat.saved(id: "task")
        chat.draft = "New transcript saved before deleting its audio"; let new = chat.saved(id: "task")
        try await store.save(new)
        try await store.saveSelection(.task("new"), revision: new.writeRevision)
        // Deliberately commit the older capture after the newer foreground save.
        try await store.saveInputs([old], preferences: [:], revision: old.writeRevision)
        try await store.saveSelection(.task("old"), revision: old.writeRevision)
        let recovered = try await store.load(), selection = try await store.loadSelection()
        XCTAssertEqual(recovered.first?.text, new.text); XCTAssertEqual(selection, .task("new"))
        XCTAssertEqual(recovered.first?.writeRevision, 0, "A process-local write clock must not be restored from disk")
        chat.draft = ""; try await store.save(chat.saved(id: "task"))
        try await store.save(old)
        let afterSend = try await store.load(); XCTAssertTrue(afterSend.isEmpty)

        let cache = try SessionCacheStore(session: session, root: root.appending(path: "cache"))
        var stale = SessionCacheInput(projects: [], tasks: [], preferences: .string("old"), selectedID: nil, histories: [:], writeRevision: InputWriteRevision.next())
        var latest = stale; latest.preferences = .string("new"); latest.writeRevision = InputWriteRevision.next()
        try await cache.save(latest); try await cache.save(stale)
        let preview = await cache.load(); XCTAssertEqual(preview?.preferences, .string("new"))
        // An identical newer save also advances the write guard.
        stale.writeRevision = InputWriteRevision.next(); latest.writeRevision = InputWriteRevision.next()
        try await cache.save(latest); try await cache.save(stale)
        let unchanged = await cache.load(); XCTAssertEqual(unchanged?.preferences, .string("new"))
    }
    func testFailedNewerWriteDoesNotSilentlySkipAPendingTranscriptSave() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "FailedWriteOrdering-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let store = try DraftStore(session: session, root: root), chat = ChatSession()
        chat.draft = "Seed"; try await store.save(chat.saved(id: "task"))
        chat.draft = "Transcript"; let transcript = chat.saved(id: "task")
        chat.draft = "Newer edit"; let newer = chat.saved(id: "task")
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!.allObjects.compactMap { $0 as? URL }
        let file = try XCTUnwrap(files.first { $0.pathExtension == "draft" })
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        do { try await store.save(newer); XCTFail("Expected an actual disk write failure") } catch { }
        try FileManager.default.removeItem(at: file)
        try await store.save(transcript)
        let saved = try await store.load(); XCTAssertEqual(saved.first?.text, "Transcript")
    }
}

@MainActor final class BackgroundTaskFixture: BackgroundTaskProviding {
    var next = 0
    var ended: [Int] = []
    var expireImmediately = false
    var deny = false
    private var handlers: [Int: @MainActor @Sendable () -> Void] = [:]
    func begin(_ name: String, expiration: @escaping @MainActor @Sendable () -> Void) -> UIBackgroundTaskIdentifier {
        if deny { return .invalid }
        next += 1; handlers[next] = expiration
        if expireImmediately { expiration() }
        return UIBackgroundTaskIdentifier(rawValue: next)
    }
    func end(_ id: UIBackgroundTaskIdentifier) { ended.append(id.rawValue) }
    func expire(_ id: Int) { handlers[id]?() }
}

private actor BackgroundRefreshRelay: RelayServing {
    var refreshes = 0
    private var gate: CheckedContinuation<Void, Never>?
    func refresh() async { refreshes += 1; await withCheckedContinuation { gate = $0 } }
    func release() { gate?.resume(); gate = nil }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) -> JSON { .null }
}
