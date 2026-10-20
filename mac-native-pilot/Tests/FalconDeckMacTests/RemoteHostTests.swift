import Foundation
import XCTest
@testable import FalconDeckMac

private final class RemoteMemoryCredentials: NativeRemoteCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: NativeSavedSession] = [:]
    func load(hostID: String) throws -> NativeSavedSession? {
        lock.lock(); defer { lock.unlock() }
        return values[hostID]
    }
    func save(_ session: NativeSavedSession, hostID: String) throws {
        lock.lock(); defer { lock.unlock() }
        values[hostID] = session
    }
    func remove(hostID: String) throws {
        lock.lock(); defer { lock.unlock() }
        values.removeValue(forKey: hostID)
    }
}

private actor RemoteTestTransport: NativeRemoteTransport {
    private let hostID: String
    private var sink: AsyncStream<NativeRelayUpdate>.Continuation?
    private var generation = UUID()
    private var generations: [UUID] = []
    init(hostID: String) { self.hostID = hostID }
    func events() -> AsyncStream<NativeRelayUpdate> {
        let (stream, sink) = AsyncStream<NativeRelayUpdate>.makeStream()
        self.sink = sink
        return stream
    }
    func pair(_ input: NativePairingInput, connectionID: UUID) {
        generation = connectionID
        generations.append(connectionID)
        emit(.snapshot(.object(["workspaces": .array([.object(["id": .string("same-workspace")])]), "host": .string(hostID)])))
        emit(.status("Connected", connected: true))
    }
    func restore(connectionID: UUID) -> Bool { generation = connectionID; return true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func selectThread(_ id: String?) { }
    func setForeground(_ active: Bool) { }
    func call(_ method: String, params: JSON) -> JSON {
        .object(["host": .string(hostID), "method": .string(method), "params": params])
    }
    private func emit(_ event: NativeRelayEvent) { sink?.yield(.init(connectionID: generation, event: event)) }
    func emitOldSnapshot() {
        guard let first = generations.first else { return }
        sink?.yield(.init(connectionID: first, event: .snapshot(.object(["stale": .bool(true)]))))
    }
    func emitLive(_ values: [JSON]) { emit(.events(values)) }
    func emitRefreshedSnapshot(_ value: JSON, rebase: [JSON]) { emit(.snapshot(value, rebase: rebase)) }
}

private final class RemoteTestFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: RemoteTestTransport] = [:]
    func transport(_ id: String) -> RemoteTestTransport {
        lock.lock(); defer { lock.unlock() }
        if let value = values[id] { return value }
        let value = RemoteTestTransport(hostID: id)
        values[id] = value
        return value
    }
}

private actor RemoteGatedTransport: NativeRemoteTransport {
    private var eventWaiter: CheckedContinuation<AsyncStream<NativeRelayUpdate>, Never>?
    private var startWaiter: CheckedContinuation<Void, Never>?
    private var eventsStarted = false
    private(set) var pairCount = 0
    func events() async -> AsyncStream<NativeRelayUpdate> {
        await withCheckedContinuation { waiter in
            eventWaiter = waiter
            eventsStarted = true
            startWaiter?.resume(); startWaiter = nil
        }
    }
    func waitUntilEventsStart() async {
        if eventsStarted { return }
        await withCheckedContinuation { startWaiter = $0 }
    }
    func releaseEvents() {
        eventWaiter?.resume(returning: AsyncStream { $0.finish() }); eventWaiter = nil
    }
    func pair(_ input: NativePairingInput, connectionID: UUID) { pairCount += 1 }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func selectThread(_ id: String?) { }
    func setForeground(_ active: Bool) { }
    func call(_ method: String, params: JSON) -> JSON { .null }
}

final class RemoteHostTests: XCTestCase {
    private let code = "ABC." + Data(repeating: 7, count: 32).base64EncodedString()

    @MainActor func testDisablingDuringTransportSetupPreventsPairing() async throws {
        let suite = "RemoteHostTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = RemoteGatedTransport()
        let manager = NativeHostManager(defaults: defaults, credentials: RemoteMemoryCredentials(), factory: { _ in transport })
        let pairing = Task { try await manager.addHost(name: "Server", pairingText: code) }
        await transport.waitUntilEventsStart()
        let id = try XCTUnwrap(manager.hosts.first?.id)
        await manager.setEnabled(hostID: id, enabled: false)
        await transport.releaseEvents()
        do {
            _ = try await pairing.value
            XCTFail("A disabled host must not finish its suspended pairing")
        } catch is CancellationError { }
        let pairCount = await transport.pairCount
        XCTAssertEqual(pairCount, 0)
        XCTAssertEqual(manager.hosts.first?.status, .disconnected)
    }

    @MainActor func testRefreshPublishesRebasedMetadataAtomicallyAfterLiveEvents() async throws {
        let suite = "RemoteHostTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let factory = RemoteTestFactory()
        let manager = NativeHostManager(defaults: defaults, credentials: RemoteMemoryCredentials(), factory: { factory.transport($0) })
        let id = try await manager.addHost(name: "Server", pairingText: code)
        for _ in 0..<30 { await Task.yield() }
        let workspace = JSON.object(["id": .string("project"), "current_thread_id": .string("a"), "path": .string("/srv/project"), "kind": .string("project")])
        let threadA = JSON.object(["id": .string("a"), "workspace_id": .string("project"), "status": .string("idle"), "updated_at": .string("2026-10-20T08:00:00Z")])
        let threadB = threadA.setting("id", .string("b")).setting("updated_at", .string("2026-10-20T08:00:01Z"))
        let started = JSON.object(["workspace_id": .string("project"), "thread_id": .string("b"), "event": .object(["type": .string("thread-started"), "thread": threadB])])
        let text = JSON.object(["workspace_id": .string("project"), "thread_id": .string("b"), "event": .object(["type": .string("text"), "item_id": .string("assistant-b"), "delta": .string("Live text")])])
        let staleSnapshot = JSON.object(["workspaces": .array([workspace]), "threads": .array([threadA])])
        var updates = manager.events().makeAsyncIterator()
        await factory.transport(id).emitLive([started, text])
        guard let live = await updates.next(), case .events(let values) = live.event else { return XCTFail("Expected the original live events") }
        XCTAssertEqual(values, [started, text])

        await factory.transport(id).emitRefreshedSnapshot(staleSnapshot, rebase: [started, text])
        guard let refreshed = await updates.next(), case .snapshot(let snapshot) = refreshed.event else { return XCTFail("The refresh must publish one final snapshot, without replaying live events") }
        XCTAssertEqual(snapshot["threads"].array.map { $0["id"].string }, ["a", "b"], "Selection reconciliation must never see the stale snapshot that omits newly selected thread b")
        XCTAssertEqual(snapshot["workspaces"].array[0]["current_thread_id"], .string("b"))
        XCTAssertEqual(manager.snapshots[id], snapshot)
        await manager.setEnabled(hostID: id, enabled: false)
    }

    @MainActor func testIndependentHostsDoNotCollideAndRouteMutationsToTheirOwnDaemon() async throws {
        let suite = "RemoteHostTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let factory = RemoteTestFactory()
        let manager = NativeHostManager(defaults: defaults, credentials: RemoteMemoryCredentials(), factory: { factory.transport($0) })
        let first = try await manager.addHost(name: "First", pairingText: code)
        let second = try await manager.addHost(name: "Second", pairingText: code)
        for _ in 0..<100 where manager.snapshots.count != 2 { await Task.yield() }
        XCTAssertEqual(manager.snapshots[first]?["host"].string, first)
        XCTAssertEqual(manager.snapshots[second]?["host"].string, second)
        let params = JSON.object(["workspace_id": .string("same-workspace"), "thread_id": .string("same-thread")])
        let response = try await manager.call(hostID: second, method: "turn.start", params: params)
        XCTAssertEqual(response["host"].string, second)
        XCTAssertEqual(response["params"], params)
        let globalFirst = NativeHostManager.namespace(hostID: first, id: "same-workspace")
        let globalSecond = NativeHostManager.namespace(hostID: second, id: "same-workspace")
        XCTAssertNotEqual(globalFirst, globalSecond)
        XCTAssertEqual(NativeHostManager.split(globalSecond).hostID, second)
        XCTAssertEqual(NativeHostManager.split(globalSecond).id, "same-workspace")
        await manager.setEnabled(hostID: first, enabled: false)
        await manager.setEnabled(hostID: second, enabled: false)
    }

    @MainActor func testRepairRejectsUpdatesFromPreviousConnectionAndDisabledHosts() async throws {
        let suite = "RemoteHostTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let factory = RemoteTestFactory()
        let manager = NativeHostManager(defaults: defaults, credentials: RemoteMemoryCredentials(), factory: { factory.transport($0) })
        let id = try await manager.addHost(name: "Server", pairingText: code)
        try await manager.repair(hostID: id, pairingText: code)
        for _ in 0..<30 { await Task.yield() }
        await factory.transport(id).emitOldSnapshot()
        for _ in 0..<30 { await Task.yield() }
        XCTAssertEqual(manager.snapshots[id]?["stale"], .null)
        await manager.setEnabled(hostID: id, enabled: false)
        await factory.transport(id).emitOldSnapshot()
        for _ in 0..<30 { await Task.yield() }
        XCTAssertEqual(manager.hosts.first?.status, .disconnected)
        XCTAssertEqual(manager.snapshots[id]?["stale"], .null)
        do {
            _ = try await manager.call(hostID: id, method: "turn.start")
            XCTFail("Disabled hosts must not accept mutations")
        } catch { }
    }

    @MainActor func testMetadataRestoresDisconnectedAndContainsNoPairingSecret() async throws {
        let suite = "RemoteHostTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let factory = RemoteTestFactory()
        let manager = NativeHostManager(defaults: defaults, credentials: RemoteMemoryCredentials(), factory: { factory.transport($0) })
        let id = try await manager.addHost(name: "Server", pairingText: code, sshTarget: "user@example.com", sshPort: 2222)
        for _ in 0..<30 { await Task.yield() }
        let bytes = try XCTUnwrap(defaults.data(forKey: "native.remote.hosts.v1"))
        let persisted = String(decoding: bytes, as: UTF8.self)
        XCTAssertFalse(persisted.contains(code))
        XCTAssertFalse(persisted.contains("dataKey"))
        XCTAssertFalse(persisted.contains("token"))
        let restored = NativeHostManager(defaults: defaults, credentials: RemoteMemoryCredentials(), factory: { factory.transport($0) })
        XCTAssertEqual(restored.hosts.first?.id, id)
        XCTAssertEqual(restored.hosts.first?.sshPort, 2222)
        XCTAssertEqual(restored.hosts.first?.status, .disconnected)
        XCTAssertTrue(restored.snapshots.isEmpty)
        await manager.setEnabled(hostID: id, enabled: false)
    }

    @MainActor func testSSHConfigDefaultPortRemainsUnsetAcrossMetadataRoundTrip() async throws {
        let suite = "RemoteHostTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let factory = RemoteTestFactory()
        let manager = NativeHostManager(defaults: defaults, credentials: RemoteMemoryCredentials(), factory: { factory.transport($0) })
        let id = try await manager.addHost(name: "Server", pairingText: code, sshTarget: "ops-alias")
        XCTAssertNil(manager.hosts.first?.sshPort)
        let restored = NativeHostManager(defaults: defaults, credentials: RemoteMemoryCredentials(), factory: { factory.transport($0) })
        XCTAssertNil(restored.hosts.first?.sshPort, "An SSH config alias must not become an explicit -p 22 override")
        try manager.update(hostID: id, name: "Server", sshTarget: "ops-alias", sshPort: 2222)
        XCTAssertEqual(manager.hosts.first?.sshPort, 2222)
        XCTAssertThrowsError(try manager.update(hostID: id, name: "Server", sshTarget: "ops-alias", sshPort: 0))
        try manager.update(hostID: id, name: "Server", sshTarget: "ops-alias", sshPort: nil)
        XCTAssertNil(manager.hosts.first?.sshPort)
        await manager.setEnabled(hostID: id, enabled: false)
    }

    @MainActor func testRemovingOneHostPreservesOtherHostCredential() async throws {
        let suite = "RemoteHostTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let factory = RemoteTestFactory(), vault = RemoteMemoryCredentials()
        let manager = NativeHostManager(defaults: defaults, credentials: vault, factory: { factory.transport($0) })
        let first = try await manager.addHost(name: "First", pairingText: code)
        let second = try await manager.addHost(name: "Second", pairingText: code)
        let fixture = NativeSavedSession(relay: URL(string: NativePairingInput.defaultRelay)!, sessionID: "synthetic", deviceID: "synthetic", token: "synthetic", secret: Data(repeating: 1, count: 32), daemonKey: "synthetic", daemonIdentity: "synthetic")
        try vault.save(fixture, hostID: first)
        try vault.save(fixture, hostID: second)
        try await manager.remove(hostID: first)
        XCTAssertNil(try vault.load(hostID: first))
        XCTAssertNotNil(try vault.load(hostID: second))
        XCTAssertEqual(manager.hosts.map(\.id), [second])
        await manager.setEnabled(hostID: second, enabled: false)
    }
}
