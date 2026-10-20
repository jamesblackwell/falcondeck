import XCTest
@testable import FalconDeckMac

private func task(_ id: String, project: String = "p1") -> JSON {
    .object(["id": .string(id), "workspace_id": .string(project), "title": .string(id), "provider": .string("codex"), "status": .string("idle"), "updated_at": .string("2026-10-20T08:00:00Z")])
}

private let snapshot: JSON = .object(["event": .object(["type": .string("snapshot"), "snapshot": .object([
    "workspaces": .array(["p1", "p2"].map { .object(["id": .string($0), "path": .string("/tmp/\($0)"), "default_provider": .string("codex")]) }),
    "threads": .array([]), "interactive_requests": .array([])
])])])

private actor TestDaemon: DaemonServing {
    struct Mutation: Sendable { var path: [String]; var method: String; var body: JSON }
    private var mutations: [Mutation] = []
    private var suspendCreation = false
    private var creationContinuation: CheckedContinuation<Void, Never>?
    private var creationWaiter: CheckedContinuation<Void, Never>?
    private var sentItemIDs: [String] = []
    private var detailRequests: [String: CheckedContinuation<JSON, Error>] = [:]
    private var detailWaiters: [String: CheckedContinuation<Void, Never>] = [:]
    private var sendContinuation: CheckedContinuation<JSON, Error>?
    private var sendWaiter: CheckedContinuation<Void, Never>?

    func snapshot() async throws -> JSON { FalconDeckMacTestsSnapshot() }
    func events() async throws -> AsyncThrowingStream<JSON, Error> {
        AsyncThrowingStream { $0.yield(FalconDeckMacTestsSnapshot()) }
    }
    func disconnect() async {}
    func threadDetail(projectID: String, threadID: String, before: String?) async throws -> JSON {
        try await withCheckedThrowingContinuation {
            detailRequests[threadID] = $0
            detailWaiters.removeValue(forKey: threadID)?.resume()
        }
    }
    func waitForDetail(_ id: String) async {
        if detailRequests[id] != nil { return }
        await withCheckedContinuation { detailWaiters[id] = $0 }
    }
    func finishDetail(_ id: String, text: String) {
        detailRequests.removeValue(forKey: id)?.resume(returning: .object([
            "thread": task(id), "items": .array([.object(["id": .string("m-\(id)"), "kind": .string("assistant_message"), "text": .string(text)])])
        ]))
    }
    func connectProject(path: String) async throws -> Project { Project(.object(["id": .string("p1"), "path": .string(path)])) }
    func startThread(projectID: String, provider: String?, modelID: String?) async throws -> AgentTask { AgentTask(task("created", project: projectID)) }
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String?) async throws -> JSON {
        if let userItemID { sentItemIDs.append(userItemID) }
        return try await withCheckedThrowingContinuation {
            sendContinuation = $0
            sendWaiter?.resume(); sendWaiter = nil
        }
    }
    func waitForSend() async {
        if sendContinuation != nil { return }
        await withCheckedContinuation { sendWaiter = $0 }
    }
    func finishSend(fail: Bool = false) {
        if fail { sendContinuation?.resume(throwing: PilotError("Connection lost")) }
        else { sendContinuation?.resume(returning: .null) }
        sendContinuation = nil
    }
    func requestJSON(_ path: [String], method: String, query: [URLQueryItem], body: JSON?) async throws -> JSON {
        mutations.append(.init(path: path, method: method, body: body ?? .null))
        if method == "POST", path.count == 4, path.last == "threads" {
            if suspendCreation {
                await withCheckedContinuation {
                    creationContinuation = $0; creationWaiter?.resume(); creationWaiter = nil
                }
            }
            return .object(["thread": task("created", project: path[2])])
        }
        if method == "PATCH", path.count == 5 { return .object(["thread": task(path[4], project: path[2])]) }
        if method == "POST", path.last == "turns" {
            return try await sendTurn(projectID: path[2], threadID: path[4], text: body?["inputs"].array.first?["text"].string ?? "", userItemID: body?["user_item_id"].string)
        }
        throw PilotError("Unexpected test request: \(method) \(path)")
    }
    func setCreationSuspended() { suspendCreation = true }
    func waitForCreation() async {
        if creationContinuation != nil { return }
        await withCheckedContinuation { creationWaiter = $0 }
    }
    func finishCreation() { creationContinuation?.resume(); creationContinuation = nil }
    func recordedMutations() -> [Mutation] { mutations }
    func recordedItemIDs() -> [String] { sentItemIDs }
    func finishRecoveryDetail(_ id: String, items: [JSON] = [], queued: [JSON] = [], hasOlder: Bool = false) {
        detailRequests.removeValue(forKey: id)?.resume(returning: .object([
            "thread": task(id).setting("queued_turns", .array(queued)), "items": .array(items), "has_older": .bool(hasOlder)
        ]))
    }
    func interrupt(projectID: String, threadID: String) async throws {}
    func respond(projectID: String, requestID: String, response: JSON) async throws {}
    func markRead(projectID: String, threadID: String, readSeq: Int) async throws {}
}

private func FalconDeckMacTestsSnapshot() -> JSON { snapshot }

final class StateTests: XCTestCase {
    func testUTF16ReplayIsIdempotentAndGapRequestsRecovery() {
        var transcript = Transcript()
        let delta: JSON = .object(["type": .string("text"), "item_id": .string("m1"), "delta": .string("Hi 🦅"), "start_offset": .number(0), "end_offset": .number(5)])
        transcript.apply(delta)
        transcript.apply(delta)
        XCTAssertEqual(transcript.items.first?.text, "Hi 🦅")
        transcript.apply(delta.setting("start_offset", .number(9)).setting("end_offset", .number(14)))
        XCTAssertTrue(transcript.needsRecovery)
        XCTAssertEqual(transcript.items.first?.text, "Hi 🦅")
    }

    @MainActor func testLateHistoryCannotReplaceDifferentTask() async {
        let client = TestDaemon()
        let subject = AppStore(client: client)
        subject.applyEnvelope(snapshot)
        subject.tasks = [AgentTask(task("a")), AgentTask(task("b"))]
        let first = Task { await subject.selectTask("a") }
        await client.waitForDetail("a")
        let second = Task { await subject.selectTask("b") }
        await client.waitForDetail("b")
        await client.finishDetail("b", text: "Task B")
        await second.value
        await client.finishDetail("a", text: "Task A")
        await first.value
        XCTAssertEqual(subject.selectedTaskID, "b")
        XCTAssertEqual(subject.messages.first?.text, "Task B")
    }

    @MainActor func testLiveDeltaDuringHistoryLoadIsRetained() async {
        let client = TestDaemon()
        let subject = AppStore(client: client)
        subject.applyEnvelope(snapshot)
        subject.tasks = [AgentTask(task("a"))]
        let load = Task { await subject.selectTask("a") }
        await client.waitForDetail("a")
        subject.applyEnvelope(.object(["thread_id": .string("a"), "event": .object([
            "type": .string("text"), "item_id": .string("m-a"), "delta": .string("!"), "start_offset": .number(5), "end_offset": .number(6)
        ])]))
        await client.finishDetail("a", text: "Hello")
        await load.value
        XCTAssertEqual(subject.messages.first?.text, "Hello!")
    }

    @MainActor func testFailedSendPreservesDraftInItsOwnTaskAfterNavigation() async throws {
        let client = TestDaemon(), store = AppStore(client: client)
        await store.reconnect()
        for _ in 0..<1000 where !store.isConnected { await Task.yield() }
        guard store.isConnected else { XCTFail("Test stream failed to connect"); return }
        store.draft = "Original input"
        let sending = Task { await store.send() }
        await client.waitForSend()
        store.selectProject("p2")
        store.draft = "Different project"
        await client.finishSend(fail: true)
        await sending.value
        XCTAssertEqual(store.draft, "Different project")
        XCTAssertTrue(store.errorMessage?.contains("Send wasn’t confirmed") == true)
        let load = Task { await store.selectTask("created") }
        await client.waitForDetail("created")
        await client.finishDetail("created", text: "")
        await load.value
        XCTAssertEqual(store.draft, "Original input")
    }

    @MainActor func testSendCapturesProviderAndPreservesNewTextAndAttachmentsDuringCreation() async {
        let client = TestDaemon(), store = AppStore(client: client)
        await store.reconnect()
        for _ in 0..<1000 where !store.isConnected { await Task.yield() }
        guard store.isConnected else { return XCTFail("Test stream failed to connect") }
        await client.setCreationSuspended()
        store.draft = "First message"
        let originalPayload: JSON = .object(["attachments": .array([.object(["id": .string("old")])]), "quote": .string("Original quote")])
        let changedPayload: JSON = .object(["attachments": .array([.object(["id": .string("new")])]), "quote": .string("New quote")])
        store.setComposerPayload(originalPayload, key: store.composerKey)
        let sending = Task { await store.sendInputs([.object(["type": .string("text"), "text": .string("First message")])], settings: ["model_id": .null, "reasoning_effort": .null]) }
        await client.waitForCreation()
        store.provider = "claude"
        store.draft = "New text while creating"
        store.setComposerPayload(changedPayload, key: store.composerKey)
        await client.finishCreation()
        await client.waitForSend()
        let pending = store.pendingSubmission
        XCTAssertEqual(pending?.provider, "codex")
        XCTAssertEqual(pending?.draft, "First message")
        XCTAssertEqual(pending?.payload, originalPayload)
        XCTAssertEqual(pending?.status, .uncertain)
        let mutations = await client.recordedMutations()
        XCTAssertEqual(mutations.first?.body["provider"], .string("codex"))
        let patch = mutations.first { $0.method == "PATCH" }?.body
        XCTAssertEqual(patch?.fields["model_id"], .some(.null))
        XCTAssertEqual(patch?.fields["reasoning_effort"], .some(.null))
        XCTAssertNil(patch?.fields["approval_policy"], "Absent settings must preserve the thread's remembered choice")
        XCTAssertEqual(mutations.last?.body["user_item_id"].string, pending?.userItemID)
        await client.finishSend()
        await sending.value
        XCTAssertNil(store.pendingSubmission)
        XCTAssertEqual(store.draft, "New text while creating")
        XCTAssertEqual(store.composerPayload(key: store.composerKey), changedPayload)
    }

    @MainActor func testUncertainDeliveryBlocksResendAndExactHistoryIdentityConfirmsIt() async {
        let client = TestDaemon(), store = AppStore(client: client)
        await store.reconnect()
        for _ in 0..<1000 where !store.isConnected { await Task.yield() }
        guard store.isConnected else { return XCTFail("Test stream failed to connect") }
        store.draft = "Maybe delivered"
        let sending = Task { await store.sendInputs([.object(["type": .string("text"), "text": .string("Maybe delivered")])]) }
        await client.waitForSend()
        let itemID = store.pendingSubmission?.userItemID ?? "missing"
        await client.finishSend(fail: true)
        await sending.value
        store.draft = "Newer edit"
        await store.sendInputs([.object(["type": .string("text"), "text": .string("Newer edit")])])
        await store.retryPendingSubmission()
        let sentIDs = await client.recordedItemIDs()
        XCTAssertEqual(sentIDs.count, 1)
        let checking = Task { await store.recheckPendingSubmission() }
        await client.waitForDetail("created")
        await client.finishRecoveryDetail("created", items: [.object(["id": .string(itemID), "kind": .string("user_message"), "text": .string("Maybe delivered")])])
        await checking.value
        XCTAssertNil(store.pendingSubmission)
        XCTAssertEqual(store.draft, "Newer edit")
    }

    @MainActor func testNewQueueEntryKeepsDeliveryUncertainAndDismissNeedsRiskAcknowledgement() async {
        let client = TestDaemon(), store = AppStore(client: client)
        await store.reconnect()
        for _ in 0..<1000 where !store.isConnected { await Task.yield() }
        guard store.isConnected else { return XCTFail("Test stream failed to connect") }
        store.draft = "Original"
        store.setComposerPayload(.object(["attachments": .array([.object(["id": .string("old")])])]), key: store.composerKey)
        let sending = Task { await store.sendInputs([.object(["type": .string("text"), "text": .string("Original")])]) }
        await client.waitForSend()
        await client.finishSend(fail: true)
        await sending.value
        store.draft = "Newer"
        store.setComposerPayload(.object(["attachments": .array([.object(["id": .string("new")])])]), key: store.composerKey)
        let checking = Task { await store.recheckPendingSubmission() }
        let queued: [JSON] = [.object(["id": .string("queued-random"), "text": .string("Original")])]
        await client.waitForDetail("created")
        await client.finishRecoveryDetail("created", queued: queued)
        await client.waitForDetail("created")
        await client.finishRecoveryDetail("created", queued: queued)
        await checking.value
        XCTAssertEqual(store.pendingSubmission?.status, .uncertain)
        await store.dismissPendingSubmission()
        XCTAssertNotNil(store.pendingSubmission)
        await store.dismissPendingSubmission(acknowledgeDeliveryRisk: true)
        XCTAssertNil(store.pendingSubmission)
        XCTAssertEqual(store.draft, "Original\n\nNewer")
        XCTAssertEqual(store.composerPayload(key: store.composerKey)["attachments"].array.map { $0["id"].string }, ["old", "new"])
    }

    @MainActor func testManualRetryChecksAgainAndNeverMatchesOnlyMessageText() async {
        let client = TestDaemon(), store = AppStore(client: client)
        await store.reconnect()
        for _ in 0..<1000 where !store.isConnected { await Task.yield() }
        guard store.isConnected else { return XCTFail("Test stream failed to connect") }
        store.draft = "Repeated prompt"
        let sending = Task { await store.sendInputs([.object(["type": .string("text"), "text": .string("Repeated prompt")])]) }
        await client.waitForSend()
        let itemID = store.pendingSubmission?.userItemID ?? "missing"
        await client.finishSend(fail: true)
        await sending.value
        let checking = Task { await store.recheckPendingSubmission() }
        let differentMessage: JSON = .object(["id": .string("user-another-send"), "kind": .string("user_message"), "text": .string("Repeated prompt")])
        await client.waitForDetail("created")
        await client.finishRecoveryDetail("created", items: [differentMessage])
        await client.waitForDetail("created")
        await client.finishRecoveryDetail("created", items: [differentMessage])
        await checking.value
        XCTAssertEqual(store.pendingSubmission?.status, .checkedMissing)
        let retrying = Task { await store.retryPendingSubmission() }
        await client.waitForDetail("created")
        await client.finishRecoveryDetail("created", items: [differentMessage.setting("id", .string(itemID))])
        await retrying.value
        let sentIDs = await client.recordedItemIDs()
        XCTAssertEqual(sentIDs.count, 1, "Late confirmation must stop the explicit retry before a second POST")
        XCTAssertNil(store.pendingSubmission)
    }

    @MainActor func testSuggestedFollowupPreservesMatchingDraftAndAttachments() async {
        let client = TestDaemon(), store = AppStore(client: client)
        await store.reconnect()
        for _ in 0..<1000 where !store.isConnected { await Task.yield() }
        guard store.isConnected else { return XCTFail("Test stream failed to connect") }
        store.tasks = [AgentTask(task("existing"))]
        let selecting = Task { await store.selectTask("existing") }
        await client.waitForDetail("existing")
        await client.finishDetail("existing", text: "")
        await selecting.value
        store.draft = "Suggested prompt"
        let payload: JSON = .object(["attachments": .array([.object(["id": .string("unsent-image")])]), "quote": .string("Keep this quote")])
        store.setComposerPayload(payload, key: store.composerKey)
        let sending = Task { await store.sendInputs([.object(["type": .string("text"), "text": .string("Suggested prompt")])], preserveComposer: true) }
        await client.waitForSend()
        XCTAssertEqual(store.pendingSubmission?.preserveComposer, true)
        XCTAssertEqual(store.pendingSubmission?.draft, "Suggested prompt")
        XCTAssertEqual(store.pendingSubmission?.payload, .object([:]))
        let mutations = await client.recordedMutations()
        XCTAssertEqual(mutations.last?.path, ["api", "workspaces", "p1", "threads", "existing", "turns"])
        await client.finishSend()
        await sending.value
        XCTAssertNil(store.pendingSubmission)
        XCTAssertEqual(store.draft, "Suggested prompt", "An external prompt must not consume even an identical composer draft")
        XCTAssertEqual(store.composerPayload(key: store.composerKey), payload)
    }

    @MainActor func testSuggestedFollowupRequiresExistingTask() async {
        let client = TestDaemon(), store = AppStore(client: client)
        await store.reconnect()
        for _ in 0..<1000 where !store.isConnected { await Task.yield() }
        guard store.isConnected else { return XCTFail("Test stream failed to connect") }
        store.draft = "Unsent project draft"
        await store.sendInputs([.object(["type": .string("text"), "text": .string("External prompt")])], preserveComposer: true)
        let mutations = await client.recordedMutations()
        XCTAssertTrue(mutations.isEmpty)
        XCTAssertNil(store.pendingSubmission)
        XCTAssertEqual(store.draft, "Unsent project draft")
    }

    func testInputLedgerDecodesOldSnapshotsAndPreservesIdentityAcrossRelaunch() throws {
        let old = try JSONDecoder().decode(NativeInputSnapshot.self, from: Data("{\"drafts\":{\"a\":\"saved\"},\"payloads\":{}}".utf8))
        XCTAssertEqual(old.drafts["a"], "saved")
        XCTAssertTrue(old.submissions.isEmpty)
        let pending = NativePendingSubmission(id: "user-stable", userItemID: "user-stable", sourceKey: "draft:p", composerKey: "t", projectID: "p", threadID: "t", provider: "claude", inputs: [.object(["type": .string("text"), "text": .string("saved")])], settings: ["model_id": .null], draft: "saved", payload: .object([:]), knownQueueIDs: ["queued-before"], status: .uncertain)
        let restored = try JSONDecoder().decode(NativeInputSnapshot.self, from: JSONEncoder().encode(NativeInputSnapshot(submissions: [pending.id: pending])))
        XCTAssertEqual(restored.submissions[pending.id], pending)
        XCTAssertEqual(restored.submissions[pending.id]?.settings["model_id"], .some(.null))
    }

    func testApprovalScopesAndExplicitEmptyDecisionsArePreserved() {
        XCTAssertTrue(ApprovalChoice.choices(for: .object(["approval_decisions": .array([])])).isEmpty)
        let choices = ApprovalChoice.choices(for: .object(["approval_options": .array([
            .object(["option_id": .string("allow-only-this-command"), "label": .string("Allow this command"), "decision": .string("allow")])
        ])]))
        XCTAssertEqual(choices.first?.response["option_id"].string, "allow-only-this-command")
        XCTAssertEqual(choices.first?.response["kind"].string, "approval_option")
    }
}
