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
        try await withCheckedThrowingContinuation {
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

    func testApprovalScopesAndExplicitEmptyDecisionsArePreserved() {
        XCTAssertTrue(ApprovalChoice.choices(for: .object(["approval_decisions": .array([])])).isEmpty)
        let choices = ApprovalChoice.choices(for: .object(["approval_options": .array([
            .object(["option_id": .string("allow-only-this-command"), "label": .string("Allow this command"), "decision": .string("allow")])
        ])]))
        XCTAssertEqual(choices.first?.response["option_id"].string, "allow-only-this-command")
        XCTAssertEqual(choices.first?.response["kind"].string, "approval_option")
    }
}
