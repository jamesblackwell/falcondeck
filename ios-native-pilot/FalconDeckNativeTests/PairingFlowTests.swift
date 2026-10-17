import XCTest
@testable import FalconDeckNative

private actor PairingRelay: RelayServing {
    private(set) var inputs: [PairingInput] = []
    private(set) var restores = 0
    private var holdRestore = false
    private var restoreGate: CheckedContinuation<Void, Never>?
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { inputs.append(input) }
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
    // Public synthetic authority seed; no real pairing/session credentials.
    private let code = "ABC123.\(Data(repeating: 7, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: ""))"

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
