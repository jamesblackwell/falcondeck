import XCTest
@testable import FalconDeckNative

private actor ControlledRelay: RelayServing {
    private var pending: CheckedContinuation<JSON, Error>?
    private var waiter: CheckedContinuation<Void, Never>?
    private var lastParams: JSON = .null
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    // Deliberately allow an old response to finish after disconnect, just as a
    // response already received by the transport can resume the UI later.
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) async throws -> JSON { try await call("thread.detail", params: .null) }
    func call(_ method: String, params: JSON) async throws -> JSON {
        lastParams = params
        if method == "thread.archive" { return .object(["ok": .bool(true)]) }
        if method == "thread.unarchive" { return .object(["thread": params.setting("id", params["thread_id"]).setting("is_archived", .bool(false))]) }
        return try await withCheckedThrowingContinuation {
            pending = $0; waiter?.resume(); waiter = nil
        }
    }
    func params() -> JSON { lastParams }
    func waitForRequest() async {
        if pending != nil { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func complete(_ result: JSON) { pending?.resume(returning: result); pending = nil }
    func fail(_ error: Error) { pending?.resume(throwing: error); pending = nil }
}

@MainActor final class SessionTests: XCTestCase {
    private let task = AgentTask(.object(["id": .string("live-task"), "workspace_id": .string("live-project"), "title": .string("Original title"), "status": .string("running")]))

    private func summary(_ task: AgentTask, seq: Int = 1) -> ClientEvent {
        .events([.object(["seq": .number(Double(seq)), "thread_id": .string(task.id), "event": .object(["type": .string("thread-updated"), "thread": task.raw])])])
    }

    func testCoalescedStreamingDoesNotDiscardALocalRename() async throws {
        for sameBatch in [true, false] {
            let model = AppModel.testing(relay: ControlledRelay())
            model.tasks = [task]
            let chat = model.chat(for: task); chat.loaded = true
            chat.transcript.items = [Message(.object(["id": .string("answer"), "kind": .string("assistant_message"), "text": .string("Hello")]))]
            // The daemon coalescer keeps a merged delta in its original slot
            // while advancing its sequence past an intervening thread summary.
            let delta = JSON.object(["seq": .number(12), "thread_id": .string(task.id), "event": .object(["type": .string("text"), "item_id": .string("answer"), "delta": .string(" there")])])
            let renamed = AgentTask(task.raw.setting("title", .string("Renamed on desktop")))
            if sameBatch, case .events(let rows) = summary(renamed, seq: 11) {
                model.receive(.init(connectionID: model.connectionID, event: .events([delta] + rows)))
            } else {
                model.receive(.init(connectionID: model.connectionID, event: .events([delta])))
                model.receive(.init(connectionID: model.connectionID, event: summary(renamed, seq: 11)))
            }
            model.receive(.init(connectionID: model.connectionID, event: .events([delta])))
            try await Task.sleep(for: .milliseconds(250))
            XCTAssertEqual(model.task(task.id)?.title, "Renamed on desktop")
            XCTAssertEqual(chat.transcript.items.last?.text, "Hello there", "Duplicate delivery must not append the same text twice")
        }
    }

    func testEventDeduplicationIsBoundedAndAcceptsUnseenLowerSequences() {
        var sequences = RecentEventSequences()
        XCTAssertTrue(sequences.insert(20))
        XCTAssertTrue(sequences.insert(10))
        XCTAssertFalse(sequences.insert(20))
        for seq in 21...8212 { XCTAssertTrue(sequences.insert(seq)) }
        XCTAssertFalse(sequences.insert(8212))
        XCTAssertTrue(sequences.insert(19), "A previously unseen lower sequence is valid after coalescing")
        XCTAssertTrue(sequences.insert(10), "The duplicate cache must have a bounded lifetime")
    }

    func testItemUpdatePreventsAnOlderReadFromRepopulatingTheCache() async throws {
        let relay = ControlledRelay(), model = AppModel.testing(relay: relay)
        let read = Task { try await model.fullItem(task, itemID: "image") }
        await relay.waitForRequest()
        let newer = JSON.object(["id": .string("image"), "kind": .string("image"), "text": .string("New content")])
        model.receive(.init(connectionID: model.connectionID, event: .events([.object(["seq": .number(1), "thread_id": .string(task.id), "event": .object(["type": .string("conversation-item-updated"), "item": newer])])])))
        await relay.complete(newer.setting("text", .string("Old content")))
        _ = try await read.value
        XCTAssertTrue(model.itemCache.isEmpty, "An update received during a read invalidates its captured result")
        guard model.itemCache.isEmpty else { return }
        let fresh = Task { try await model.fullItem(task, itemID: "image") }
        await relay.waitForRequest()
        await relay.complete(newer)
        let result = try await fresh.value
        XCTAssertEqual(result["text"].string, "New content")
    }

    func testArchiveAndRestoreKeepUnsentTextAndAttachmentsInTheSameLaunch() async throws {
        let model = AppModel.testing(relay: ControlledRelay())
        model.connected = true; model.tasks = [task]
        let chat = model.chat(for: task)
        chat.draft = "Keep my unfinished message"
        chat.attachments = [NativeAttachment(id: "image", name: "Fixture.png", mimeType: "image/png", data: Data([1]))]
        await model.archive(task)
        let archived = try XCTUnwrap(model.archivedTasks.first)
        try await model.unarchive(archived)
        let restored = model.chat(for: try XCTUnwrap(model.task(task.id)))
        XCTAssertEqual(restored.draft, "Keep my unfinished message")
        XCTAssertEqual(restored.attachments.map(\.id), ["image"])
    }

    func testOlderHistoryDoesNotReplayAlreadyAppliedLiveText() async {
        let relay = ControlledRelay(), model = AppModel.testing(relay: relay)
        model.tasks = [task]
        let chat = model.chat(for: task); chat.loaded = true; chat.hasOlder = true; chat.oldestID = "answer"
        chat.transcript.items = [Message(.object(["id": .string("answer"), "kind": .string("assistant_message"), "text": .string("Hello")]))]
        let load = Task { await model.loadChat(task, older: true) }
        await relay.waitForRequest()
        model.receive(.init(connectionID: model.connectionID, event: .events([.object(["seq": .number(1), "thread_id": .string(task.id), "event": .object(["type": .string("text"), "item_id": .string("answer"), "delta": .string(" 🦅")])])])))
        let older = JSON.object(["id": .string("older"), "kind": .string("user_message"), "text": .string("Earlier request")])
        await relay.complete(.object(["thread": task.raw, "items": .array([older]), "has_older": .bool(false)]))
        await load.value
        XCTAssertEqual(chat.transcript.items.map(\.id), ["older", "answer"])
        XCTAssertEqual(chat.transcript.items.last?.text, "Hello 🦅")
    }

    func testLateArchiveListKeepsLocalRestoresAndNewArchives() async throws {
        for restoring in [false, true] {
            let relay = ControlledRelay(), model = AppModel.testing(relay: relay)
            let archived = AgentTask(task.raw.setting("id", .string("archived")).setting("is_archived", .bool(true)))
            model.connected = true; model.tasks = [task]; model.archivedTasks = [archived]
            let load = Task { try await model.loadArchived() }
            await relay.waitForRequest()
            if restoring { try await model.unarchive(archived) } else { await model.archive(task) }
            await relay.complete(.object(["threads": .array([archived.raw])]))
            try await load.value
            if restoring {
                XCTAssertTrue(model.archivedTasks.isEmpty)
                XCTAssertTrue(model.tasks.contains { $0.id == archived.id })
            } else { XCTAssertEqual(Set(model.archivedTasks.map(\.id)), [task.id, archived.id]) }
        }
    }

    func testEveryWaiterRejectsAMediaReadFromThePreviousConnection() async {
        let relay = ControlledRelay(), model = AppModel.testing(relay: relay)
        let first = Task { try await model.fullItem(task, itemID: "image") }
        await relay.waitForRequest()
        var joined = false
        let second = Task { joined = true; return try await model.fullItem(task, itemID: "image") }
        while !joined { await Task.yield() }
        await model.useDemo()
        await relay.complete(.object(["id": .string("image"), "kind": .string("image")]))
        for read in [first, second] {
            do { _ = try await read.value; XCTFail("All shared waiters must reject a previous connection's media") }
            catch { XCTAssertTrue(error is CancellationError) }
        }
        XCTAssertTrue(model.itemCache.isEmpty)
    }

    func testDemoCancelsPendingSummariesAndRejectsOldSnapshotsAndErrors() async throws {
        let model = AppModel.testing(relay: ControlledRelay())
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
        let model = AppModel.testing(relay: ControlledRelay())
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
            let model = AppModel.testing(relay: ControlledRelay())
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
        let controlled = AppModel.testing(relay: relay)
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
        let controlled = AppModel.testing(relay: relay)
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

    func testReconnectRestoresAnUnconfirmedSendIntoRetainedChat() async {
        let relay = ControlledRelay()
        let controlled = AppModel.testing(relay: relay)
        controlled.tasks = [task]; controlled.connected = true; controlled.hasSession = true
        let chat = controlled.chat(for: task)
        chat.draft = "Keep across reconnect"
        let attachment = NativeAttachment(id: "image", name: "Fixture.png", mimeType: "image/png", data: Data([0]))
        chat.attachments = [attachment]
        let send = Task { await controlled.send(task) }
        await relay.waitForRequest()
        XCTAssertTrue(chat.draft.isEmpty)
        await controlled.reconnect()
        await relay.complete(.object(["ok": .bool(true)]))
        await send.value
        XCTAssertEqual(chat.draft, "Keep across reconnect")
        XCTAssertEqual(chat.attachments.map(\.id), [attachment.id])
        XCTAssertNotNil(chat.notice)
    }

    func testAnEarlyEchoSurvivesBothStartedAndQueuedAcknowledgements() async {
        for (status, response) in [("running", "started"), ("running", "queued"), ("idle", "queued")] {
            let relay = ControlledRelay()
            let model = AppModel.testing(relay: relay)
            let task = AgentTask(self.task.raw.setting("status", .string(status)))
            model.tasks = [task]; model.connected = true
            let chat = model.chat(for: task); chat.draft = "Confirmed message"
            let send = Task { await model.send(task) }
            await relay.waitForRequest()
            let params = await relay.params()
            let echo = JSON.object(["id": params["user_item_id"], "kind": .string("user_message"), "text": .string("Confirmed message")])
            model.receive(RelayUpdate(connectionID: model.connectionID, event: .events([.object(["seq": .number(1), "thread_id": .string(task.id), "event": .object(["type": .string("conversation-item-added"), "item": echo])])])))
            await relay.complete(.object(["ok": .bool(true), "message": .string(response)]))
            await send.value
            XCTAssertEqual(chat.transcript.items.count, 1)
            XCTAssertFalse(chat.transcript.items[0].raw["pending"].bool)
            XCTAssertTrue(chat.pendingQueue.isEmpty)
        }
    }

    func testHistoryBufferOverflowKeepsLiveTranscriptAndShowsRecoveryError() async {
        let relay = ControlledRelay()
        let model = AppModel.testing(relay: relay)
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
        XCTAssertNotNil(chat.historyError)
        XCTAssertFalse(chat.loaded)
        XCTAssertFalse(chat.loading)
    }

    func testLeavingAConversationDoesNotDiscardItsValidInFlightHistory() async {
        let relay = ControlledRelay()
        let controlled = AppModel.testing(relay: relay)
        controlled.tasks = [task]
        let load = Task { await controlled.loadChat(task) }
        await relay.waitForRequest()
        load.cancel()
        // Reopening while the first read is pending shares that load.
        await controlled.loadChat(task)
        let item = JSON.object(["id": .string("reply"), "kind": .string("assistant_message"), "text": .string("Loaded once")])
        await relay.complete(.object(["thread": task.raw, "items": .array([item])]))
        await load.value
        let chat = controlled.chat(for: task)
        XCTAssertTrue(chat.loaded)
        XCTAssertFalse(chat.loading)
        XCTAssertEqual(chat.transcript.items.first?.text, "Loaded once")
    }

    func testHistoryCannotReviveAConversationArchivedDuringTheRequest() async {
        let relay = ControlledRelay()
        let controlled = AppModel.testing(relay: relay)
        controlled.tasks = [task]; controlled.connected = true
        let load = Task { await controlled.loadChat(task) }
        await relay.waitForRequest()
        await controlled.archive(task)
        let newer = task.raw.setting("updated_at", .string("2026-10-17T12:00:00Z"))
        await relay.complete(.object(["thread": newer, "items": .array([])]))
        await load.value
        XCTAssertTrue(controlled.tasks.isEmpty)
        XCTAssertTrue(controlled.archivedTasks.first?.archived == true)
        XCTAssertNil(controlled.chats[task.id])
    }

    func testAnOlderPageFailureDoesNotInvalidateAlreadyLoadedHistory() async {
        let relay = ControlledRelay()
        let model = AppModel.testing(relay: relay)
        model.tasks = [task]
        let chat = model.chat(for: task)
        chat.loaded = true; chat.hasOlder = true; chat.oldestID = "first"
        chat.transcript.items = [Message(.object(["id": .string("first"), "kind": .string("assistant_message"), "text": .string("Already readable")]))]
        let load = Task { await model.loadChat(task, older: true) }
        await relay.waitForRequest()
        await relay.fail(PilotError("Older page unavailable"))
        await load.value
        XCTAssertTrue(chat.loaded)
        XCTAssertFalse(chat.loading)
        XCTAssertNil(chat.historyError)
        XCTAssertEqual(chat.olderHistoryError, "Older page unavailable")
        XCTAssertEqual(chat.transcript.items.first?.text, "Already readable")
    }
}
