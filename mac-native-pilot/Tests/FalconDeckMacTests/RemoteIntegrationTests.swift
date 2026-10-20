import Foundation
import XCTest
@testable import FalconDeckMac

private final class RemoteIntegrationVault: NativeRemoteCredentialStore, @unchecked Sendable {
    let lock = NSLock()
    var session: NativeSavedSession?
    func load(hostID: String) throws -> NativeSavedSession? { lock.lock(); defer { lock.unlock() }; return session }
    func save(_ session: NativeSavedSession, hostID: String) throws { lock.lock(); defer { lock.unlock() }; self.session = session }
    func remove(hostID: String) throws { lock.lock(); defer { lock.unlock() }; session = nil }
}

final class RemoteIntegrationTests: XCTestCase {
    func testRealRustRelayPairingEncryptedSnapshotMutationAndReconnect() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["FALCONDECK_REMOTE_TEST_ISOLATED"] == "1",
              let daemonText = environment["FALCONDECK_REMOTE_TEST_DAEMON"],
              let relay = environment["FALCONDECK_REMOTE_TEST_RELAY"],
              let daemonURL = URL(string: daemonText),
              let relayURL = URL(string: relay),
              [daemonURL, relayURL].allSatisfy({ $0.scheme == "http" && ["127.0.0.1", "localhost"].contains($0.host ?? "") }) else {
            throw XCTSkip("Set explicit isolated loopback daemon/relay endpoints to run the encrypted integration test.")
        }
        let daemon = daemonURL
        let (initialData, _) = try await URLSession.shared.data(from: daemon.appending(path:"api/snapshot"))
        let initial = try JSON.decode(initialData)
        guard initial["workspaces"].array.isEmpty else { throw XCTSkip("The integration test requires a fresh isolated daemon.") }
        let (remoteData, _) = try await URLSession.shared.data(from: daemon.appending(path:"api/remote/status"))
        guard try JSON.decode(remoteData)["trusted_devices"].array.isEmpty else {
            throw XCTSkip("The integration test requires an isolated daemon without trusted devices.")
        }
        var request = URLRequest(url: daemon.appending(path:"api/remote/pairing"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField:"Content-Type")
        request.httpBody = try JSON.object(["relay_url": .string(relay)]).data()
        let (data, response) = try await URLSession.shared.data(for:request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let state = try JSON.decode(data)
        let secureCode = state["pairing"]["pairing_code"].string
        XCTAssertFalse(secureCode.isEmpty)
        let vault = RemoteIntegrationVault()
        let client = NativeRelayClient(hostID:"isolated-smoke", credentials:vault)
        let stream = await client.events()
        let connected = expectation(description:"Fresh encrypted snapshot and connected state")
        let reconnected = expectation(description:"Reconnect anchors fresh snapshot")
        let reader = Task {
            var count = 0
            for await update in stream {
                if case .status(_, connected:true) = update.event {
                    count += 1
                    if count == 1 { connected.fulfill() }
                    if count == 2 { reconnected.fulfill() }
                }
            }
        }
        defer { reader.cancel() }
        try await client.pair(NativePairingInput(text:secureCode, relay:relay), connectionID:UUID())
        await fulfillment(of:[connected], timeout:35)
        let before = try await client.call("preferences.read", params:.object([:]))
        XCTAssertNotEqual(before, .null)
        let changed = try await client.call("preferences.update", params:.object(["auto_resume_interrupted_sessions": .bool(false)]))
        XCTAssertEqual(changed["auto_resume_interrupted_sessions"], .bool(false))
        let read = try await client.call("preferences.read", params:.object([:]))
        XCTAssertEqual(read["auto_resume_interrupted_sessions"], .bool(false))
        let order = (0..<900).map { JSON.string("synthetic-large-transfer-workspace-\($0)") }
        let large = try await client.call("preferences.update", params:.object(["workspace_order": .array(order)]))
        XCTAssertEqual(large["workspace_order"].array.count, 900, "Both upload and response must traverse chunks-v1")
        let saved = try XCTUnwrap(vault.load(hostID:"isolated-smoke"))
        XCTAssertEqual(saved.dataKey?.count, 32)
        try await client.disconnect(forget:false)
        // Add and revoke a second independent client while the first is
        // offline. The first must recover from its now-stale saved data key.
        let (pairData, pairResponse) = try await URLSession.shared.data(for:request)
        XCTAssertEqual((pairResponse as? HTTPURLResponse)?.statusCode, 200)
        let secondCode = try JSON.decode(pairData)["pairing"]["pairing_code"].string
        let otherVault = RemoteIntegrationVault()
        let other = NativeRelayClient(hostID:"isolated-other", credentials:otherVault)
        let secondStream = await other.events()
        let secondConnected = expectation(description:"Second independent client")
        let otherReader = Task {
            for await update in secondStream {
                if case .status(_, connected:true) = update.event { secondConnected.fulfill(); break }
            }
        }
        defer { otherReader.cancel() }
        try await other.pair(NativePairingInput(text:secondCode, relay:relay), connectionID:UUID())
        await fulfillment(of:[secondConnected], timeout:35)
        let secondSession = try XCTUnwrap(otherVault.load(hostID:"isolated-other"))
        var revoke = URLRequest(url:daemon.appending(path:"api/remote/devices/\(secondSession.deviceID)"))
        revoke.httpMethod = "DELETE"
        let (_, revokeResponse) = try await URLSession.shared.data(for:revoke)
        XCTAssertEqual((revokeResponse as? HTTPURLResponse)?.statusCode, 200)
        try await other.disconnect(forget:true)
        let restored = try await client.restore(connectionID:UUID())
        XCTAssertTrue(restored)
        await fulfillment(of:[reconnected], timeout:35)
        let rotated = try XCTUnwrap(vault.load(hostID:"isolated-smoke"))
        XCTAssertNotEqual(rotated.dataKey, saved.dataKey, "The reconnect must authenticate and install the rotated content key")
        let snapshot = try await client.call("snapshot.current", params:.object(["include_archived_threads":.bool(false)]))
        XCTAssertEqual(snapshot["workspaces"].array.count, 0)
        try await client.disconnect(forget:true)
        XCTAssertNil(try vault.load(hostID:"isolated-smoke"))
        var revokeFirst = URLRequest(url:daemon.appending(path:"api/remote/devices/\(saved.deviceID)"))
        revokeFirst.httpMethod = "DELETE"
        let (_, cleanupResponse) = try await URLSession.shared.data(for:revokeFirst)
        XCTAssertEqual((cleanupResponse as? HTTPURLResponse)?.statusCode, 200)
    }
}
