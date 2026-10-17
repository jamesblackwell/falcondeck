import XCTest
import os
@testable import FalconDeckNative

private actor PairingRelay: RelayServing {
    let onClaim: (@Sendable () -> Void)?
    init(onClaim: (@Sendable () -> Void)? = nil) { self.onClaim = onClaim }
    private(set) var inputs: [PairingInput] = []
    private(set) var restores = 0
    private var holdRestore = false
    private var restoreGate: CheckedContinuation<Void, Never>?
    private var onConnect: (@MainActor @Sendable (UUID) -> Void)?
    func setConnectionCallback(_ callback: @escaping @MainActor @Sendable (UUID) -> Void) { onConnect = callback }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) async throws {
        inputs.append(input)
        if let onClaim { onClaim(); throw PilotError("Ticket request failed") }
        await onConnect?(connectionID)
    }
    func restore(connectionID: UUID) async -> Bool {
        restores += 1
        if holdRestore { await withCheckedContinuation { restoreGate = $0 } }
        return !inputs.isEmpty
    }
    func pauseRestore() { holdRestore = true }
    func isRestoring() -> Bool { restoreGate != nil }
    func releaseRestore() { holdRestore = false; restoreGate?.resume(); restoreGate = nil }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) -> JSON { .null }
}

@MainActor final class PairingFlowTests: XCTestCase {
    func testUnitTestHostDoesNotUseASavedPairingOrRecording() throws {
        XCTAssertTrue(FalconDeckNativeApp.isUnitTestHost, "Xcode must expose the unit-test bundle before app startup")
        let host = FalconDeckNativeApp.makeModel()
        XCTAssertTrue(host.relay is UnavailablePreviewRelay)
        XCTAssertNil(try host.sessionLoader())
        XCTAssertNil(host.voice.pendingURL)
        XCTAssertFalse(host.restoringSession)
    }
    // Public synthetic authority seed; no real pairing/session credentials.
    private let code = "ABC123.\(Data(repeating: 7, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: ""))"

    func testClaimedIdentitySchedulesRecoveryWhenTheTicketRequestFails() async {
        let saved = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let store = OSAllocatedUnfairLock<SavedSession?>(initialState: nil)
        let relay = PairingRelay(onClaim: { store.withLock { $0 = saved } })
        let model = AppModel.testing(relay: relay, sessionLoader: { store.withLock { $0 } })
        model.restoringSession = false; model.pairingText = code
        await model.pair(relayURL: PairingInput.defaultRelay)
        XCTAssertTrue(model.hasSession)
        XCTAssertTrue(model.pairingPending)
        XCTAssertNotNil(model.reconnectTask, "The first HTTP failure has no socket reader to schedule recovery")
        model.reconnectTask?.cancel(); model.reconnectTask = nil
    }
    func testAnEarlySocketFailureIsRetriedAfterPairingFinishes() async {
        let relay = PairingRelay()
        // Use the relay callback to reproduce an error before pair() returns,
        // when the model has not yet exposed its newly saved session.
        let connected = AppModel.testing(relay: relay)
        await relay.setConnectionCallback { [weak connected] id in connected?.receive(.init(connectionID: id, event: .error("Handshake failed"))) }
        connected.pairingText = code; connected.restoringSession = false
        await connected.pair(relayURL: PairingInput.defaultRelay)
        XCTAssertTrue(connected.hasSession)
        XCTAssertNotNil(connected.reconnectTask)
        connected.reconnectTask?.cancel(); connected.reconnectTask = nil
    }

    func testScanConnectsOnceAndWaitsForSnapshotBeforeOpeningWorkspace() async {
        let relay = PairingRelay()
        let model = AppModel.testing(relay: relay)
        model.restoringSession = false
        await model.receivePairingPayload(code)
        var inputs = await relay.inputs
        XCTAssertEqual(inputs.count, 1)
        XCTAssertEqual(inputs.first?.code, "ABC123")
        XCTAssertTrue(model.pairingPending)
        XCTAssertTrue(model.showConnection)
        await model.receivePairingPayload(code)
        await model.pair(relayURL: PairingInput.defaultRelay)
        inputs = await relay.inputs
        XCTAssertEqual(inputs.count, 1, "Repeated camera/deep-link events must not reclaim a single-use code")
        model.receive(.init(connectionID: UUID(), event: .snapshot(.object([:]))))
        XCTAssertTrue(model.pairingPending)
        model.receive(.init(connectionID: model.connectionID, event: .snapshot(.object([:]))))
        XCTAssertFalse(model.pairingPending)
        XCTAssertFalse(model.showConnection)
        XCTAssertTrue(model.hasSession)
    }

    func testCustomRelayRequiresOneReviewAndThenConnectsAutomatically() async {
        let relay = PairingRelay()
        let model = AppModel.testing(relay: relay)
        model.restoringSession = false
        let link = "falcondeck-native://pair?code=\(code)&relay=https://relay.example.com/"
        await model.receivePairingPayload(link)
        var inputs = await relay.inputs
        XCTAssertTrue(inputs.isEmpty)
        XCTAssertEqual(model.pairingRelayReview?.relay.absoluteString, "https://relay.example.com")
        await model.acceptPairingRelay()
        inputs = await relay.inputs
        XCTAssertEqual(inputs.count, 1)
        XCTAssertEqual(inputs.first?.relay.absoluteString, "https://relay.example.com")
        XCTAssertNil(model.pairingRelayReview)
        XCTAssertTrue(model.pairingPending)
    }

    func testBareScanRespectsExplicitSelfHostedRelay() async {
        let relay = PairingRelay()
        let model = AppModel.testing(relay: relay)
        model.restoringSession = false
        await model.receivePairingPayload(code, relayURL: "https://relay.example.com")
        XCTAssertEqual(model.pairingRelayReview?.relay.host(), "relay.example.com")
        await model.acceptPairingRelay()
        let inputs = await relay.inputs
        XCTAssertEqual(inputs.first?.relay.host(), "relay.example.com")
    }

    func testIncomingLinkWaitsForStartupRestore() async {
        let relay = PairingRelay()
        let model = AppModel.testing(relay: relay)
        await model.receivePairingPayload("falcondeck-native://pair?code=\(code)")
        let before = await relay.inputs
        XCTAssertTrue(before.isEmpty)
        await model.start()
        for _ in 0..<50 {
            if await relay.inputs.count == 1 { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let inputs = await relay.inputs
        XCTAssertEqual(inputs.count, 1)
        XCTAssertFalse(model.restoringSession)
    }

    func testConnectionFailureRetriesSavedSessionInsteadOfClaimingAgain() async {
        let relay = PairingRelay()
        let model = AppModel.testing(relay: relay)
        model.restoringSession = false
        await model.receivePairingPayload(code)
        model.receive(.init(connectionID: model.connectionID, event: .error("Computer unavailable")))
        XCTAssertTrue(model.pairingPending)
        await model.reconnect()
        let inputs = await relay.inputs
        let restores = await relay.restores
        XCTAssertEqual(inputs.count, 1)
        XCTAssertEqual(restores, 1)
        XCTAssertTrue(model.pairingPending)
        await model.forget()
        XCTAssertFalse(model.pairingPending)
        XCTAssertFalse(model.hasSession)
    }

    func testInvalidLinkShowsErrorWithoutConnectingOrClearingExistingWorkspace() async {
        let relay = PairingRelay()
        let model = AppModel.testing(relay: relay)
        model.restoringSession = false
        await model.useDemo()
        let tasks = model.tasks.map(\.id)
        await model.receivePairingPayload("falcondeck-native://pair?code=incomplete")
        let inputs = await relay.inputs
        XCTAssertTrue(inputs.isEmpty)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.tasks.map(\.id), tasks)
        XCTAssertTrue(model.demo)
        XCTAssertFalse(model.pairingPending)
    }

    func testIncomingLinkDuringReconnectIsConsumedAfterRecoveryFinishes() async {
        let relay = PairingRelay()
        let model = AppModel.testing(relay: relay)
        model.restoringSession = false; model.hasSession = true
        await relay.pauseRestore()
        let recovery = Task { await model.reconnect() }
        for _ in 0..<50 {
            if await relay.isRestoring() { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(model.busy)
        await model.receivePairingPayload("falcondeck-native://pair?code=\(code)")
        let before = await relay.inputs
        XCTAssertTrue(before.isEmpty)
        await relay.releaseRestore()
        await recovery.value
        for _ in 0..<50 {
            if await relay.inputs.count == 1 { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let inputs = await relay.inputs
        XCTAssertEqual(inputs.count, 1)
        XCTAssertTrue(model.pairingPending)
    }
}
