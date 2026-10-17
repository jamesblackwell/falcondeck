import XCTest
@testable import FalconDeckNative

private actor PushHTTPMock: PushHTTP {
    private(set) var requests: [URLRequest] = []
    let available: Bool
    var gated: Bool
    var failedClears = 0
    var gate: CheckedContinuation<Void, Never>?
    init(available: Bool = true, gated: Bool = false) { self.available = available; self.gated = gated }
    func send(_ request: URLRequest) async throws -> (Data, Int) {
        requests.append(request)
        if request.httpMethod != "POST" {
            return (Data("{\"apns\":[{\"topic\":\"org.example.native\",\"environment\":\"sandbox\"}]}".utf8), available ? 200 : 404)
        }
        if gated { gated = false; await withCheckedContinuation { gate = $0 } }
        if let body = request.httpBody.flatMap({ try? JSONDecoder().decode(JSON.self, from: $0) }), body["registration"] == .null, failedClears > 0 {
            failedClears -= 1
            throw URLError(.timedOut) // The relay may have applied the clear before losing its response.
        }
        return (Data("{\"ok\":true}".utf8), available ? 200 : 404)
    }
    func release() { gate?.resume(); gate = nil }
    func hasBlockedPost() -> Bool { gate != nil }
    func failNextUnregister() { failedClears = 1 }
}

private actor PushRelay: RelayServing {
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .object([:]) }
    func call(_ method: String, params: JSON) -> JSON { .object([:]) }
}

@MainActor final class PushTests: XCTestCase {
    private func target(_ token: String? = "aabb", enabled: Bool = true, device: String = "device") -> PushTarget {
        let session = SavedSession(relay: URL(string: "https://relay.example")!, sessionID: "session", deviceID: device, token: "client-secret", secret: Data(repeating: 0, count: 32), daemonKey: "daemon", daemonIdentity: "identity")
        return PushTarget(session: session, token: token, topic: "org.example.native", environment: "sandbox", enabled: enabled)
    }
    func testNativeRegistrationUsesOwnAuthenticatedEndpointAndRotatesToken() async throws {
        let http = PushHTTPMock(), sync = PushRegistrationSync(http: http)
        let first = await sync.update(target()); XCTAssertEqual(first, .registered)
        let duplicate = await sync.update(target()); XCTAssertEqual(duplicate, .registered)
        let rotated = await sync.update(target("ccdd")); XCTAssertEqual(rotated, .registered)
        let requests = await http.requests
        XCTAssertEqual(requests.count, 4)
        XCTAssertEqual(requests.last?.url?.path, "/v1/sessions/session/devices/device/push-registration")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer client-secret")
        let body = try JSONDecoder().decode(JSON.self, from: XCTUnwrap(requests.last?.httpBody))
        XCTAssertEqual(body["registration"]["provider"].string, "apns")
        XCTAssertEqual(body["registration"]["token"].string, "ccdd")
    }
    func testLegacyRelayStaysUsableWithoutSendingNativeTokenToExpo() async {
        let http = PushHTTPMock(available: false), sync = PushRegistrationSync(http: http)
        let status = await sync.update(target()); XCTAssertEqual(status, .unavailable)
        let requests = await http.requests
        XCTAssertEqual(requests.count, 1); XCTAssertNotEqual(requests[0].httpMethod, "POST")
    }
    func testDisableWinsOverInflightRegistration() async throws {
        let http = PushHTTPMock(gated: true), sync = PushRegistrationSync(http: http)
        let enabled = target(), disabled = target(enabled: false)
        let first = Task { await sync.update(enabled) }
        for _ in 0..<100 {
            if await http.hasBlockedPost() { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let blocked = await http.hasBlockedPost(); XCTAssertTrue(blocked)
        let off = Task { await sync.update(disabled) }
        await http.release()
        _ = await first.value
        let final = await off.value; XCTAssertEqual(final, .disabled)
        let requests = await http.requests
        let body = try JSONDecoder().decode(JSON.self, from: XCTUnwrap(requests.last?.httpBody))
        XCTAssertEqual(body["registration"], .null)
    }
    func testForgetAndSwitchClearThePreviousDevice() async throws {
        let http = PushHTTPMock(), sync = PushRegistrationSync(http: http)
        _ = await sync.update(target())
        _ = await sync.update(target(device: "second"))
        _ = await sync.update(nil)
        let posts = await http.requests.filter { $0.httpMethod == "POST" }
        XCTAssertEqual(posts.count, 4)
        XCTAssertEqual(posts[1].url?.path, "/v1/sessions/session/devices/device/push-registration")
        XCTAssertEqual(posts[3].url?.path, "/v1/sessions/session/devices/second/push-registration")
        for index in [1, 3] {
            let body = try JSONDecoder().decode(JSON.self, from: XCTUnwrap(posts[index].httpBody))
            XCTAssertEqual(body["registration"], .null)
        }
    }
    func testNotificationDestinationsRequireBoundedRoutingFields() {
        let info: [AnyHashable: Any] = ["sessionId": "session", "workspaceId": "workspace", "threadId": "thread"]
        XCTAssertEqual(NotificationDestination(userInfo: info)?.threadID, "thread")
        XCTAssertNil(NotificationDestination(userInfo: ["threadId": "thread"]))
        XCTAssertNil(NotificationDestination(userInfo: info.merging(["threadId": "bad\nroute"]) { _, new in new }))
        XCTAssertNil(NotificationDestination(userInfo: info.merging(["threadId": String(repeating: "x", count: 1025)]) { _, new in new }))
    }
    func testDisabledLegacyConnectionsDoNotAccumulateFailedUnregistration() async {
        let http = PushHTTPMock(available: false), sync = PushRegistrationSync(http: http)
        let first = await sync.update(target(enabled: false)); XCTAssertEqual(first, .disabled)
        let second = await sync.update(target(enabled: false, device: "second")); XCTAssertEqual(second, .disabled)
        let forgotten = await sync.update(nil); XCTAssertEqual(forgotten, .disabled)
    }
    func testWaitingForAppleStillClearsPersistedRegistrationWhenForgotten() async throws {
        let http = PushHTTPMock(), sync = PushRegistrationSync(http: http)
        let waiting = await sync.update(target(nil)); XCTAssertEqual(waiting, .waitingForToken)
        let forgotten = await sync.update(nil); XCTAssertEqual(forgotten, .disabled)
        let requests = await http.requests
        XCTAssertEqual(requests.count, 1)
        let body = try JSONDecoder().decode(JSON.self, from: XCTUnwrap(requests.first?.httpBody))
        XCTAssertEqual(body["registration"], .null)
    }
    func testReenableRegistersAgainAfterUncertainDisable() async throws {
        let http = PushHTTPMock(), sync = PushRegistrationSync(http: http)
        _ = await sync.update(target())
        await http.failNextUnregister()
        let failed = await sync.update(target(enabled: false)); XCTAssertEqual(failed, .failed)
        let restored = await sync.update(target()); XCTAssertEqual(restored, .registered)
        let requests = await http.requests
        let body = try JSONDecoder().decode(JSON.self, from: XCTUnwrap(requests.last?.httpBody))
        XCTAssertEqual(body["registration"]["token"].string, "aabb")
        XCTAssertGreaterThan(requests.count, 3)
    }
    func testColdModelForgetUsesSavedCredentialsEvenBeforeAppleRegistration() async throws {
        let http = PushHTTPMock(), sync = PushRegistrationSync(http: http)
        let suite = "ColdPushTests-\(UUID())", saved = target().session
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let push = NativePushNotifications(defaults: defaults, sync: sync)
        let model = AppModel(relay: PushRelay(), push: push, notifications: LocalNotifications(defaults: defaults), sessionLoader: { saved })
        model.hasSession = true
        await model.forget()
        let requests = await http.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer client-secret")
        let body = try JSONDecoder().decode(JSON.self, from: XCTUnwrap(requests[0].httpBody))
        XCTAssertEqual(body["registration"], .null)
        XCTAssertFalse(model.hasSession)
    }
}
