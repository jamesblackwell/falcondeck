import XCTest
@testable import FalconDeckNative

@MainActor final class SessionCacheTests: XCTestCase {
    private func session(device: String = "fixture", secret: UInt8 = 1) -> SavedSession {
        SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: device, token: "fixture", secret: Data(repeating: secret, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
    }
    private func root() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appending(path: "NativeCacheTests-\(UUID())")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    private func row(_ id: String = "t", project: String = "p", status: String = "idle") -> JSON {
        .object(["id": .string(id), "workspace_id": .string(project), "title": .string("Private task"), "status": .string(status), "updated_at": .string(id)])
    }
    private func item(_ id: String, text: String = "Private answer") -> JSON {
        .object(["id": .string(id), "kind": .string("assistant_message"), "text": .string(text)])
    }
    private func input(tasks: [JSON]? = nil, histories: [String: CachedHistory]? = nil) -> SessionCacheInput {
        SessionCacheInput(projects: [.object(["id": .string("p"), "path": .string("/private/project"), "skills": .array([.string("large catalog")])])], tasks: tasks ?? [row()], preferences: .object([:]), selectedID: "t", histories: histories ?? ["t": CachedHistory(items: [item("answer")], hasOlder: false)])
    }
    func testEncryptedRoundTripAndPairingIsolation() async throws {
        let root = try root(), store = try SessionCacheStore(session: session(), root: root)
        try await store.save(input())
        let cache = await store.load()
        XCTAssertEqual(cache?.histories["t"]?.items.first?["text"].string, "Private answer")
        XCTAssertEqual(cache?.projects.first?["skills"].array, [])
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!.allObjects.compactMap { $0 as? URL }.filter { $0.lastPathComponent == "preview" }
        XCTAssertEqual(files.count, 1)
        let bytes = try Data(contentsOf: files[0])
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("Private answer"))
        let other = try SessionCacheStore(session: session(device: "different"), root: root)
        let otherCache = await other.load(); XCTAssertNil(otherCache)
        // Same device namespace with different secret cannot authenticate it.
        let wrongKey = try SessionCacheStore(session: session(secret: 2), root: root)
        let wrongCache = await wrongKey.load(); XCTAssertNil(wrongCache)
    }
    func testHistoryBoundsKeepAContiguousSuffixAndExcludePendingSends() async throws {
        let store = try SessionCacheStore(session: session(), root: root())
        let history = (0..<180).map { item("\($0)", text: String(repeating: "a", count: 900)) }
            + [item("pending").setting("pending", .bool(true))]
        try await store.save(input(histories: ["t": CachedHistory(items: history, hasOlder: false)]))
        let cache = await store.load(), saved = cache!.histories["t"]!
        XCTAssertTrue(saved.hasOlder)
        XCTAssertEqual(saved.items.last?["id"].string, "179")
        XCTAssertLessThan(saved.items.count, 150)
        XCTAssertLessThanOrEqual(try saved.items.reduce(0) { try $0 + $1.data().count }, 64 * 1024)
        let ids = saved.items.map { Int($0["id"].string)! }
        XCTAssertEqual(ids, Array(ids.first!...179))
    }
    func testOversizedNewestItemDoesNotLeaveAGapInHistory() async throws {
        let store = try SessionCacheStore(session: session(), root: root())
        try await store.save(input(histories: ["t": CachedHistory(items: [item("old"), item("large", text: String(repeating: "x", count: 70_000))], hasOlder: false)]))
        let cache = await store.load(); XCTAssertNil(cache?.histories["t"])
    }
    func testSelectedTaskAndEachProjectSurviveSummaryBudget() async throws {
        let store = try SessionCacheStore(session: session(), root: root())
        let rows = (0..<300).map { row("\($0)") } + [row("t", project: "other")]
        try await store.save(input(tasks: rows))
        let cache = await store.load()
        XCTAssertEqual(cache?.tasks.count, 200)
        XCTAssertEqual(cache?.tasks.first?["id"].string, "t")
        XCTAssertTrue(cache!.tasks.contains { $0["workspace_id"].string == "p" })
    }
    func testStreamingRetainsSettledHistoryAndArchiveEvictsIt() async throws {
        let store = try SessionCacheStore(session: session(), root: root())
        try await store.save(input())
        try await store.save(input(tasks: [row(status: "running")], histories: ["t": CachedHistory(items: [item("streaming", text: "Partial")], hasOlder: false)]))
        var cache = await store.load()
        XCTAssertEqual(cache?.histories["t"]?.items.first?["id"].string, "answer")
        try await store.save(input(tasks: [row().setting("is_archived", .bool(true))]))
        cache = await store.load(); XCTAssertTrue(cache!.tasks.isEmpty); XCTAssertTrue(cache!.histories.isEmpty)
    }
    func testClearPreventsAnAlreadyScheduledSaveFromRecreatingTheCache() async throws {
        let store = try SessionCacheStore(session: session(), root: root())
        try await store.save(input()); try await store.clear(); try await store.save(input())
        let cache = await store.load(); XCTAssertNil(cache)
    }
    func testCachedTranscriptNeedsFreshHistoryBeforeReadAcknowledgement() async throws {
        let model = AppModel.testing(relay: CacheHistoryRelay())
        let store = try SessionCacheStore(session: session(), root: root())
        model.sessionCache = store; model.hasLiveSnapshot = true
        let task = AgentTask(row()); model.tasks = [task]
        let chat = model.chat(for: task)
        chat.loaded = true; chat.needsRefresh = true
        chat.transcript.items = [Message(item("cached"))]
        await model.loadChat(task)
        XCTAssertFalse(chat.needsRefresh)
        XCTAssertEqual(chat.transcript.items.first?.id, "fresh")
        await model.savePreview()
        let cache = await store.load(); XCTAssertEqual(cache?.histories["t"]?.items.first?["id"].string, "fresh")
    }
    func testRelaunchHydratesProjectsAndHistoryWithoutRestoringSyncTokens() async throws {
        let session = session(), root = try root(), store = try SessionCacheStore(session: session, root: root)
        try await store.save(input())
        let defaults = UserDefaults(suiteName: "NativeCacheHydrationTests")!
        let model = AppModel(relay: CacheHistoryRelay(), voice: VoiceRecorder(defaults: defaults), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { session }, sessionCacheRoot: root)
        model.pendingSelection = .task("t")
        await model.restorePreview()
        XCTAssertEqual(model.projects.first?.id, "p")
        XCTAssertEqual(model.selection, .task("t"))
        XCTAssertEqual(model.chats["t"]?.transcript.items.first?.id, "answer")
        XCTAssertTrue(model.chats["t"]!.needsRefresh)
        XCTAssertNil(model.syncIndex)
        XCTAssertFalse(model.hasLiveSnapshot)
        // An interim save without a daemon snapshot cannot erase the cache.
        model.tasks = []; await model.savePreview()
        let kept = await store.load(); XCTAssertEqual(kept?.tasks.count, 1)
    }

    func testFreshSnapshotWinsOverDiskSummaryAndPrunesRemovedProjects() async throws {
        let model = AppModel.testing(relay: CacheHistoryRelay())
        model.cachedAt = .now
        let old = row().setting("title", .string("Old title")).setting("updated_at", .string("2099-01-01T00:00:00Z"))
        model.tasks = [AgentTask(old), AgentTask(row("removed", project: "gone"))]
        let fresh = row().setting("title", .string("Fresh title"))
        model.receive(RelayUpdate(connectionID: model.connectionID, event: .snapshot(.object([
            "workspaces": .array([.object(["id": .string("p"), "path": .string("/p")])]),
            "threads": .array([fresh]), "native_sync": .object(["token": .string("fresh"), "counts": .object(["p": .object(["total": .number(1)])])])
        ]))))
        XCTAssertEqual(model.tasks.map(\.title), ["Fresh title"])
        XCTAssertTrue(model.hasLiveSnapshot)
    }

    func testFirstLivePageCanReplaceACachedSummaryWithANewerLocalClock() {
        let model = AppModel.testing(relay: CacheHistoryRelay())
        model.tasks = [AgentTask(row().setting("title", .string("Cached title")).setting("updated_at", .string("2099-01-01T00:00:00Z")))]
        model.previewTaskIDs = ["t"]
        model.upsertTask(row().setting("title", .string("Authoritative title")).setting("updated_at", .string("2026-01-01T00:00:00Z")))
        XCTAssertEqual(model.task("t")?.title, "Authoritative title")
        XCTAssertFalse(model.previewTaskIDs.contains("t"))
        // Once authoritative, the usual live-event stale-response guard applies.
        model.upsertTask(row().setting("title", .string("Stale response")).setting("updated_at", .string("2000-01-01T00:00:00Z")))
        XCTAssertEqual(model.task("t")?.title, "Authoritative title")
    }

    func testSyncBannerSurvivesCachedDataAndHidesOnlyWhenLive() {
        let model = AppModel.testing(relay: CacheHistoryRelay())
        model.hasSession = true; model.cachedAt = .now; model.status = "Connecting…"
        XCTAssertEqual(NativeSyncStatus.resolve(model)?.title, "Reconnecting…")
        XCTAssertTrue(NativeSyncStatus.resolve(model)!.detail.contains("saved"))
        model.networkAvailable = false
        XCTAssertEqual(NativeSyncStatus.resolve(model)?.title, "You’re offline")
        model.networkAvailable = true; model.connected = true
        XCTAssertNotNil(NativeSyncStatus.resolve(model))
        model.hasLiveSnapshot = true
        XCTAssertNil(NativeSyncStatus.resolve(model))
    }
}

private actor CacheHistoryRelay: RelayServing {
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON {
        .object(["thread": task.raw, "items": .array([.object(["id": .string("fresh"), "kind": .string("assistant_message"), "text": .string("Fresh history")])]), "has_older": .bool(false)])
    }
    func call(_ method: String, params: JSON) -> JSON { .null }
}
