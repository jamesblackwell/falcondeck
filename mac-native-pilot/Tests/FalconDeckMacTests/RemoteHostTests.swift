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

final class RemoteHostTests: XCTestCase {
    private let code = "ABC." + Data(repeating: 7, count: 32).base64EncodedString()

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
