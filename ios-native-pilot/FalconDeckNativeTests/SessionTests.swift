import XCTest
@testable import FalconDeckNative

private actor ControlledRelay: RelayServing {
    private var pending: CheckedContinuation<JSON, Error>?
    private var waiter: CheckedContinuation<Void, Never>?
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    // Deliberately allow an old response to finish after disconnect, just as a
    // response already received by the transport can resume the UI later.
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) async throws -> JSON { try await call("thread.detail", params: .null) }
    func call(_ method: String, params: JSON) async throws -> JSON {
        try await withCheckedThrowingContinuation {
            pending = $0; waiter?.resume(); waiter = nil
        }
    }
    func waitForRequest() async {
        if pending != nil { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func complete(_ result: JSON) { pending?.resume(returning: result); pending = nil }
}

@MainActor final class SessionTests: XCTestCase {
    private let task = AgentTask(.object(["id": .string("live-task"), "workspace_id": .string("live-project"), "title": .string("Original title"), "status": .string("running")]))

    private func summary(_ task: AgentTask, seq: Int = 1) -> ClientEvent {
        .events([.object(["seq": .number(Double(seq)), "thread_id": .string(task.id), "event": .object(["type": .string("thread-updated"), "thread": task.raw])])])
    }

    func testDemoCancelsPendingSummariesAndRejectsOldSnapshotsAndErrors() async throws {
        let model = AppModel(relay: ControlledRelay())
        let oldID = model.connectionID
        model.receive(RelayUpdate(connectionID: oldID, event: summary(task)))
        await model.useDemo()
        model.receive(RelayUpdate(connectionID: oldID, event: .snapshot(.object(["threads": .array([task.raw])]))))
        model.receive(RelayUpdate(connectionID: oldID, event: .error("Old connection failed")))
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertTrue(model.demo)
        XCTAssertEqual(model.tasks.map(\.id), Demo.tasks.map(\.id))
        XCTAssertNil(model.error)
    }

    func testForgetCancelsPendingSummaryAndRejectsQueuedEvents() async throws {
        let model = AppModel(relay: ControlledRelay())
        model.hasSession = true
        let oldID = model.connectionID
        model.receive(RelayUpdate(connectionID: oldID, event: summary(task)))
        await model.forget()
        model.receive(RelayUpdate(connectionID: oldID, event: .snapshot(.object(["threads": .array([task.raw])]))))
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertTrue(model.tasks.isEmpty)
        XCTAssertFalse(model.hasSession)
        XCTAssertEqual(model.status, "Not connected")
    }

    func testTurnEndPreservesDaemonErrorAndRetryStatuses() async throws {
        for status in ["error", "running"] {
            let model = AppModel(relay: ControlledRelay())
            model.tasks = [task]
            let updated = AgentTask(task.raw.setting("status", .string(status)))
            model.receive(RelayUpdate(connectionID: model.connectionID, event: summary(updated)))
            let end = JSON.object(["seq": .number(2), "thread_id": .string(task.id), "event": .object(["type": .string("turn-end"), "status": .string(status == "running" ? "running" : "failed")])])
            model.receive(RelayUpdate(connectionID: model.connectionID, event: .events([end])))
            try await Task.sleep(for: .milliseconds(250))
            XCTAssertEqual(model.tasks.first?.status, status)
        }
    }

    func testOldHistoryResponseCannotPopulateDemoWorkspace() async {
        let relay = ControlledRelay()
        let controlled = AppModel(relay: relay)
        controlled.tasks = [task]
        let load = Task { await controlled.loadChat(task) }
        await relay.waitForRequest()
        await controlled.useDemo()
        await relay.complete(.object(["thread": task.raw, "items": .array([])]))
        await load.value
        XCTAssertTrue(controlled.demo)
        XCTAssertFalse(controlled.tasks.contains { $0.id == task.id })
        XCTAssertTrue(controlled.chats.isEmpty)
    }

    func testInterruptAcknowledgementDoesNotOverwriteNewerTaskState() async {
        let relay = ControlledRelay()
        let controlled = AppModel(relay: relay)
        controlled.tasks = [task]
        let stop = Task { await controlled.stop(task) }
        await relay.waitForRequest()
        let newer = AgentTask(task.raw.setting("title", .string("Renamed while stopping")).setting("latest_turn_id", .string("next-turn")))
        controlled.tasks = [newer]
        await relay.complete(.object(["ok": .bool(true), "message": .string("interrupt requested")]))
        await stop.value
        XCTAssertEqual(controlled.tasks.first?.title, newer.title)
        XCTAssertEqual(controlled.tasks.first?.status, "running")
        XCTAssertEqual(controlled.tasks.first?.latestTurnID, "next-turn")
    }

    func testHistoryBufferOverflowKeepsLiveTranscriptAndShowsRecoveryError() async {
        let relay = ControlledRelay()
        let model = AppModel(relay: relay)
        model.tasks = [task]
        let chat = model.chat(for: task)
        let load = Task { await model.loadChat(task) }
        await relay.waitForRequest()
        for seq in 1...2049 {
            let event = JSON.object(["seq": .number(Double(seq)), "thread_id": .string(task.id), "event": .object([
                "type": .string("text"), "item_id": .string("reply"), "delta": .string("a"),
                "start_offset": .number(Double(seq - 1)), "end_offset": .number(Double(seq))
            ])])
            model.receive(RelayUpdate(connectionID: model.connectionID, event: .events([event])))
        }
        await relay.complete(.object(["thread": task.raw, "items": .array([])]))
        await load.value
        XCTAssertEqual(chat.transcript.items.first?.text.count, 2049)
        XCTAssertNotNil(chat.error)
        XCTAssertFalse(chat.loaded)
        XCTAssertFalse(chat.loading)
    }
}
