import XCTest
@testable import FalconDeckNative

private actor DeliveryRelay: RelayServing {
    private var gates: [String: CheckedContinuation<JSON, Error>] = [:]
    private var history: [JSON] = []
    private var historyThread: JSON?
    private var holdHistory = false
    private(set) var calls: [(String, JSON)] = []
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) async throws -> JSON {
        if holdHistory { holdHistory = false; return try await call("thread.detail", params: .null) }
        return .object(["thread": historyThread ?? task.raw, "items": .array(history)])
    }
    func pauseNextHistory() { holdHistory = true }
    func setHistory(_ value: [JSON], thread: JSON? = nil) { history = value; historyThread = thread }
    func call(_ method: String, params: JSON) async throws -> JSON {
        calls.append((method, params))
        if method == "thread.start" || method == "turn.start" || method == "thread.detail" {
            return try await withCheckedThrowingContinuation { gates[method] = $0 }
        }
        return .object(["ok": .bool(true)])
    }
    func wait(_ method: String) async {
        for _ in 0..<2_000 { if gates[method] != nil { return }; try? await Task.sleep(for: .milliseconds(1)) }
    }
    func finish(_ method: String, _ value: JSON) { gates.removeValue(forKey: method)?.resume(returning: value) }
    func fail(_ method: String) { gates.removeValue(forKey: method)?.resume(throwing: PilotError("Local fixture failed")) }
}

@MainActor final class MessageDeliveryTests: XCTestCase {
    private func setup(provider: String = "codex", draft: Bool = false, running: Bool = false) -> (AppModel, DeliveryRelay, AgentTask, ChatSession) {
        let relay = DeliveryRelay(), model = AppModel.testing(relay: relay)
        model.projects = Demo.projects; model.connected = true
        let task = draft ? model.draftTask(project: Demo.projects[0], folderID: nil) : AgentTask(.object(["id": .string("existing"), "workspace_id": .string(Demo.projects[0].id), "provider": .string(provider), "status": .string(running ? "running" : "idle")]))
        if !draft { model.tasks = [task] }
        model.selection = draft ? .draft(task.projectID, nil) : .task(task.id)
        let chat = model.chat(for: task); chat.loaded = true; chat.draft = "Hello from the phone"
        return (model, relay, task, chat)
    }
    private func created(_ source: AgentTask) -> JSON {
        .object(["thread": .object(["id": .string("created"), "workspace_id": .string(source.projectID), "provider": .string(source.provider), "status": .string("idle")])])
    }
    private func event(_ model: AppModel, task: AgentTask, seq: Int, _ value: JSON) {
        model.applyEnvelope(.object(["seq": .number(Double(seq)), "thread_id": .string(task.id), "event": value]))
    }
    private func status(_ chat: ChatSession, running: Bool = false) -> String? {
        ConversationActivity.label(blocks: [], running: running, submitting: chat.sending && chat.outgoingMessage?.phase == .sending, accepted: chat.outgoingMessage?.awaitingAgent == true)
    }
    func testFirstMessageIsVisibleBeforeTaskCreationAndKeepsItsIdentityThroughAcceptance() async throws {
        let (model, relay, draft, chat) = setup(draft: true)
        let send = Task { await model.send(draft) }
        await relay.wait("thread.start")
        XCTAssertTrue(chat.draft.isEmpty)
        let optimistic = try XCTUnwrap(chat.transcript.items.first)
        XCTAssertEqual(optimistic.text, "Hello from the phone"); XCTAssertEqual(status(chat), "Sending…")
        XCTAssertTrue(model.tasks.isEmpty)
        let delivery = try XCTUnwrap(chat.outgoingMessage); delivery.entranceClaimed = true
        let surface = model.detailContentID
        await relay.finish("thread.start", created(draft)); await relay.wait("turn.start")
        let destination = try XCTUnwrap(model.chats["created"])
        XCTAssertEqual(destination.transcript.items.map(\.id), [optimistic.id])
        XCTAssertTrue(destination.outgoingMessage === delivery); XCTAssertTrue(delivery.entranceClaimed)
        XCTAssertTrue(chat.transcript.items.isEmpty); XCTAssertNil(chat.submission)
        XCTAssertEqual(model.detailContentID, surface)
        await relay.finish("turn.start", .object(["ok": .bool(true), "message": .string("started")])); await send.value
        XCTAssertEqual(status(destination), "Thinking…"); XCTAssertNil(destination.submission)
        XCTAssertEqual(destination.transcript.items.map(\.id), [optimistic.id])
        model.selection = .draft(draft.projectID, nil)
        XCTAssertNotEqual(model.detailContentID, surface, "Leaving the task must restore normal independent conversation identity")
    }
    func testExistingMessagesImmediatelySendAndReconcileForAllMajorHarnesses() async throws {
        for provider in ["codex", "claude", "opencode"] {
            let (model, relay, task, chat) = setup(provider: provider)
            let send = Task { await model.send(task) }; await relay.wait("turn.start")
            XCTAssertTrue(chat.draft.isEmpty); XCTAssertEqual(chat.transcript.items.count, 1)
            XCTAssertEqual(status(chat), "Sending…")
            let id = try XCTUnwrap(chat.outgoingMessage?.id)
            await relay.finish("turn.start", .object(["ok": .bool(true), "message": .string("started")])); await send.value
            XCTAssertEqual(status(chat), "Thinking…"); XCTAssertNil(chat.submission)
            event(model, task: task, seq: 1, .object(["type": .string("turn-start"), "turn_id": .string("started-turn")]))
            XCTAssertEqual(status(chat), "Thinking…", "Starting must not remove the fallback before the task summary arrives")
            event(model, task: task, seq: 2, .object(["type": .string("thread-updated"), "thread": task.raw.setting("status", .string("running"))]))
            XCTAssertEqual(status(chat), "Thinking…", "A coalesced running summary must not flash an empty status")
            await model.loadChat(task)
            XCTAssertEqual(chat.transcript.items.map(\.id), [id], "A refresh ahead of the echo must preserve the accepted local row")
            event(model, task: task, seq: 3, .object(["type": .string("conversation-item-added"), "item": .object(["id": .string(id), "kind": .string("user_message"), "text": .string("Hello from the phone")])]))
            XCTAssertEqual(chat.transcript.items.map(\.id), [id]); XCTAssertFalse(chat.transcript.items[0].raw["pending"].bool)
        }
    }
    func testAnEarlyEchoAcknowledgesSendingAndFastTurnCompletionCannotCreatePhantomThinking() async throws {
        let (model, relay, task, chat) = setup()
        let send = Task { await model.send(task) }; await relay.wait("turn.start")
        let id = try XCTUnwrap(chat.outgoingMessage?.id)
        event(model, task: task, seq: 1, .object(["type": .string("conversation-item-added"), "item": .object(["id": .string(id), "kind": .string("user_message"), "text": .string("Hello from the phone")])]))
        XCTAssertEqual(status(chat), "Thinking…")
        event(model, task: task, seq: 2, .object(["type": .string("turn-end"), "status": .string("completed")]))
        await relay.finish("turn.start", .object(["ok": .bool(true)])); await send.value
        XCTAssertNil(status(chat)); XCTAssertEqual(chat.transcript.items.count, 1)
    }
    func testFailedCreationRestoresInputAlongsideNewerEditsWithoutSendingATurn() async {
        let (model, relay, task, chat) = setup(draft: true)
        let attachment = NativeAttachment(id: "photo", name: "Photo.jpg", mimeType: "image/jpeg", data: Data([1]))
        chat.attachments = [attachment]
        let send = Task { await model.send(task) }; await relay.wait("thread.start")
        chat.draft = "A newer draft"
        await relay.fail("thread.start"); await send.value
        XCTAssertEqual(chat.draft, "Hello from the phone\n\nA newer draft")
        XCTAssertEqual(chat.attachments, [attachment]); XCTAssertTrue(chat.transcript.items.isEmpty)
        XCTAssertNil(chat.outgoingMessage); XCTAssertNil(chat.submission); XCTAssertFalse(chat.sending)
        let calls = await relay.calls; XCTAssertFalse(calls.contains { $0.0 == "turn.start" })
    }
    func testACompletedTurnRecoveredFromHistoryEndsTheLocalThinkingFallback() async throws {
        let (model, relay, task, chat) = setup()
        let send = Task { await model.send(task) }; await relay.wait("turn.start")
        let id = try XCTUnwrap(chat.outgoingMessage?.id)
        await relay.finish("turn.start", .object(["ok": .bool(true)])); await send.value
        XCTAssertEqual(status(chat), "Thinking…")
        await relay.setHistory([
            .object(["id": .string(id), "kind": .string("user_message"), "text": .string("Hello from the phone")]),
            .object(["id": .string("reply"), "kind": .string("assistant_message"), "text": .string("Finished while disconnected."), "lifecycle": .string("complete")])
        ])
        await model.loadChat(task)
        XCTAssertNil(status(chat)); XCTAssertEqual(chat.transcript.items.count, 2)
    }
    func testFailedFirstTurnIsRecoveredOnTheCreatedTaskAndNeverRetriesAutomatically() async throws {
        let (model, relay, task, source) = setup(draft: true)
        let send = Task { await model.send(task) }; await relay.wait("thread.start")
        await relay.finish("thread.start", created(task)); await relay.wait("turn.start")
        let destination = try XCTUnwrap(model.chats["created"]); destination.draft = "Newer follow-up"
        await relay.fail("turn.start"); await send.value
        XCTAssertEqual(destination.draft, "Hello from the phone\n\nNewer follow-up")
        XCTAssertTrue(source.draft.isEmpty); XCTAssertNil(source.submission)
        XCTAssertTrue(destination.transcript.items.isEmpty); XCTAssertNil(destination.outgoingMessage)
        let calls = await relay.calls; XCTAssertEqual(calls.filter { $0.0 == "turn.start" }.count, 1)
    }
    func testACompletedTailBeyondTheUserMessageEndsThinkingAndKeepsUnconfirmedInput() async throws {
        let (model, relay, task, chat) = setup()
        let send = Task { await model.send(task) }; await relay.wait("turn.start")
        await relay.finish("turn.start", .object(["ok": .bool(true)])); await send.value
        await relay.setHistory([.object(["id": .string("later-reply"), "kind": .string("assistant_message"), "text": .string("Finished beyond the recent tail."), "lifecycle": .string("complete")])], thread: task.raw.setting("latest_turn_id", .string("accepted-turn")))
        await model.loadChat(task)
        XCTAssertNil(status(chat)); XCTAssertEqual(chat.transcript.items.count, 2)
        XCTAssertEqual(chat.transcript.items.last?.text, "Hello from the phone", "Never discard accepted input using another turn's metadata")
    }
    func testACompletedTurnWithoutOutputStopsThinkingWhenItsNewTurnIsRecovered() async throws {
        let (model, relay, task, chat) = setup()
        let send = Task { await model.send(task) }; await relay.wait("turn.start")
        let id = try XCTUnwrap(chat.outgoingMessage?.id)
        await relay.finish("turn.start", .object(["ok": .bool(true)])); await send.value
        await relay.setHistory([.object(["id": .string(id), "kind": .string("user_message"), "text": .string("Hello from the phone")])], thread: task.raw.setting("latest_turn_id", .string("finished-without-output")))
        await model.loadChat(task)
        XCTAssertNil(status(chat)); XCTAssertEqual(chat.transcript.items.count, 1)
    }
    func testAnOlderHistoryResponseCannotSettleOrDiscardANewerAcceptedSend() async throws {
        let (model, relay, task, chat) = setup()
        let first = Task { await model.send(task) }; await relay.wait("turn.start")
        let firstID = try XCTUnwrap(chat.outgoingMessage?.id)
        await relay.finish("turn.start", .object(["ok": .bool(true)])); await first.value
        await relay.pauseNextHistory()
        let read = Task { await model.loadChat(task) }; await relay.wait("thread.detail")
        chat.draft = "A second message"
        let second = Task { await model.send(task) }; await relay.wait("turn.start")
        let secondID = try XCTUnwrap(chat.outgoingMessage?.id)
        await relay.finish("turn.start", .object(["ok": .bool(true)])); await second.value
        let oldItems: [JSON] = [
            .object(["id": .string(firstID), "kind": .string("user_message"), "text": .string("Hello from the phone")]),
            .object(["id": .string("first-reply"), "kind": .string("assistant_message"), "text": .string("First turn finished")])
        ]
        await relay.setHistory(oldItems, thread: task.raw.setting("status", .string("running")))
        await relay.finish("thread.detail", .object(["thread": task.raw.setting("latest_turn_id", .string("old-turn")), "items": .array(oldItems)])); await read.value
        for _ in 0..<1_000 { if !chat.loading && !chat.needsRefresh { break }; await Task.yield() }
        XCTAssertEqual(chat.outgoingMessage?.id, secondID)
        XCTAssertTrue(chat.transcript.items.contains { $0.id == secondID && $0.raw["pending"].bool })
        XCTAssertEqual(status(chat), "Thinking…")
    }
    func testCompletionRecoveredBeforeALateAcceptanceGetsOneFreshReadAfterAcceptance() async throws {
        let (model, relay, task, chat) = setup()
        let send = Task { await model.send(task) }; await relay.wait("turn.start")
        await relay.pauseNextHistory()
        let read = Task { await model.loadChat(task) }; await relay.wait("thread.detail")
        let completed = JSON.object(["thread": task.raw, "items": .array([.object(["id": .string("completed-reply"), "kind": .string("assistant_message"), "text": .string("Done before acceptance arrived")])])])
        await relay.finish("thread.detail", completed); await read.value
        XCTAssertEqual(status(chat), "Sending…")
        await relay.pauseNextHistory()
        await relay.finish("turn.start", .object(["ok": .bool(true)])); await send.value
        await relay.wait("thread.detail")
        await relay.finish("thread.detail", completed)
        for _ in 0..<1_000 { if !chat.loading { break }; await Task.yield() }
        XCTAssertNil(status(chat)); XCTAssertFalse(chat.outgoingMessage?.needsHistoryRecheck ?? true)
    }
    func testQueuedAcknowledgementDoesNotPretendTheFollowupHasStartedThinking() async {
        let (model, relay, task, chat) = setup(running: true)
        let send = Task { await model.send(task) }; await relay.wait("turn.start")
        XCTAssertEqual(status(chat, running: true), "Sending…"); XCTAssertEqual(chat.pendingQueue.count, 1)
        await relay.finish("turn.start", .object(["ok": .bool(true), "message": .string("queued")])); await send.value
        XCTAssertEqual(chat.outgoingMessage?.phase, .queued); XCTAssertFalse(chat.outgoingMessage?.awaitingAgent ?? true)
        XCTAssertTrue(chat.transcript.items.isEmpty); XCTAssertNil(chat.submission)
    }
    func testInterruptedDraftTransferRecoversOnlyTheTaskCopyAndKeepsNewerSourceInput() {
        let pending = SavedSubmission(id: "same-client-id", text: "First message", attachments: [])
        let source = SavedDraft(id: "draft:p:root", text: "Next project draft", attachments: [], modelID: "", effort: "", provider: "codex", overrides: [:], submission: pending)
        let destination = SavedDraft(id: "created", text: "", attachments: [], modelID: "", effort: "", provider: "codex", overrides: [:], submission: pending)
        let recovered = SavedDraft.resolveSubmissionOwners([source, destination])
        let sourceChat = ChatSession(), taskChat = ChatSession()
        sourceChat.restore(recovered[0]); taskChat.restore(recovered[1])
        XCTAssertEqual(sourceChat.draft, "Next project draft"); XCTAssertNil(sourceChat.submission)
        XCTAssertEqual(taskChat.draft, "First message"); XCTAssertEqual(taskChat.submission?.id, pending.id)
    }
    func testDraftChangesAndNavigationDuringRecoverySaveDoNotRetargetTheFirstSend() async throws {
        let (model, relay, task, chat) = setup(draft: true)
        let root = FileManager.default.temporaryDirectory.appending(path: "SendRecovery-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let store = try DraftStore(session: session, root: root); model.draftStore = store
        let gate = DraftWriteGate()
        let blocked = Task { await store.holdForDeliveryTest(gate) }
        let ready = await Task.detached { gate.waitForStart() }.value
        XCTAssertTrue(ready)
        let send = Task { await model.send(task) }
        for _ in 0..<100 { if chat.submission != nil { break }; await Task.yield() }
        XCTAssertNotNil(chat.submission)
        chat.provider = "claude"
        model.selection = .settings
        gate.release.signal(); await blocked.value
        await relay.wait("thread.start")
        let calls = await relay.calls
        XCTAssertEqual(calls.first { $0.0 == "thread.start" }?.1["provider"].string, "codex")
        await relay.finish("thread.start", created(task)); await relay.wait("turn.start")
        await relay.finish("turn.start", .object(["ok": .bool(true)])); await send.value
        XCTAssertEqual(model.selection, .settings)
        await model.saveAllInputs()
        let saved = try await store.load()
        XCTAssertNil(saved.first { $0.id == task.id }?.submission)
        XCTAssertNil(saved.first { $0.id == "created" }?.submission)
    }
}

private final class DraftWriteGate: @unchecked Sendable {
    let started = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    func waitForStart() -> Bool { started.wait(timeout: .now() + 3) == .success }
}

private extension DraftStore {
    func holdForDeliveryTest(_ gate: DraftWriteGate) {
        gate.started.signal()
        _ = gate.release.wait(timeout: .now() + 3)
    }
}
