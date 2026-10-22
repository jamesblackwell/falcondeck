import XCTest
@testable import FalconDeckNative

private actor FeatureRelay: RelayServing {
    var calls: [(String, JSON)] = []
    let failTurn: Bool
    let failChat: Bool
    init(failTurn: Bool = false, failChat: Bool = false) { self.failTurn = failTurn; self.failChat = failChat }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) throws -> JSON {
        calls.append((method, params))
        if method == "turn.start", failTurn { throw PilotError("Synthetic send failure") }
        if method == "chat.create" {
            if failChat { throw PilotError("Synthetic chat failure") }
            return .object(["id": .string("project"), "path": .string("/work/project"), "default_provider": .string("codex")])
        }
        if method == "thread.start" { return .object(["thread": .object(["id": .string("created-task"), "workspace_id": params["workspace_id"], "provider": params["provider"], "status": .string("idle"), "title": .string("New task")])]) }
        return .object(["ok": .bool(true)])
    }
    func requests() -> [(String, JSON)] { calls }
}

@MainActor final class TaskFeatureTests: XCTestCase {
    private let task = AgentTask(.object(["id": .string("task"), "workspace_id": .string("project"), "provider": .string("codex"), "status": .string("idle")]))

    func testDraftFirstSendCreatesOneTaskThenSendsWithCapturedSettings() async {
        let relay = FeatureRelay()
        let controlled = AppModel.testing(relay: relay)
        controlled.connected = true; controlled.projects = Demo.projects
        let draft = controlled.draftTask(project: Demo.projects[0], folderID: nil)
        let chat = controlled.chat(for: draft)
        chat.draft = "Hello native"; chat.modelID = "chosen-model"; chat.effort = "high"
        chat.overrides = ["sandbox_mode": .string("read-only")]
        chat.isolation = "isolated"
        await controlled.send(draft)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.start", "thread.update", "turn.start"])
        XCTAssertEqual(calls[0].1["model_id"].string, "chosen-model")
        XCTAssertEqual(calls[0].1["isolation"].string, "isolated")
        XCTAssertEqual(calls[1].1["isolation"], .null)
        XCTAssertEqual(calls[2].1["isolation"], .null)
        XCTAssertEqual(calls[2].1["sandbox_mode"].string, "read-only")
        XCTAssertEqual(calls[2].1["approval_policy"], .null)
        XCTAssertEqual(controlled.selection, .task("created-task"))
        XCTAssertTrue(chat.draft.isEmpty)
        XCTAssertEqual(controlled.tasks.count, 1)
    }

    func testNewTasksDefaultToProjectFolderAndCasualChatsCannotInheritIsolation() async {
        for casual in [false, true] {
            let relay = FeatureRelay(), model = AppModel.testing(relay: relay)
            let project = Project(Demo.projects[0].raw.setting("kind", .string(casual ? "casual" : "project")))
            model.projects = [project]; model.connected = true
            let draft = model.draftTask(project: project, folderID: nil), chat = model.chat(for: draft)
            XCTAssertEqual(chat.isolation, "project_folder")
            if casual { chat.isolation = "isolated" }
            chat.draft = "Start a task"
            await model.send(draft)
            let calls = await relay.requests()
            XCTAssertEqual(calls.first?.1["isolation"].string, "project_folder")
            XCTAssertTrue(calls.filter { $0.0 != "thread.start" }.allSatisfy { $0.1["isolation"] == .null })
            XCTAssertNil(model.chats["created-task"]?.overrides["isolation"])
        }
    }

    func testFailedFirstSendKeepsDraftOnCreatedTaskWithoutCreatingAgain() async {
        let relay = FeatureRelay(failTurn: true)
        let model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = Demo.projects
        let draft = model.draftTask(project: Demo.projects[0], folderID: nil)
        model.chat(for: draft).draft = "Keep this message"
        await model.send(draft)
        let calls = await relay.requests()
        XCTAssertEqual(calls.filter { $0.0 == "thread.start" }.count, 1)
        XCTAssertEqual(model.chats["created-task"]?.draft, "Keep this message")
        XCTAssertNotNil(model.chats["created-task"]?.error)
        XCTAssertEqual(model.selection, .task("created-task"))
    }

    func testGoalDemoLifecycleAndBudget() async throws {
        let model = AppModel.testing(relay: FeatureRelay())
        model.demo = true; model.tasks = [task]
        try await model.setGoal(task, objective: "Finish the work", budget: 2000)
        let active = try XCTUnwrap(model.tasks.first)
        XCTAssertEqual(active.goal["objective"].string, "Finish the work")
        XCTAssertEqual(active.goal["token_budget"].int, 2000)
        try await model.setGoal(active, status: "paused")
        XCTAssertEqual(model.tasks.first?.goal["status"].string, "paused")
        try await model.setGoal(try XCTUnwrap(model.tasks.first), clear: true)
        XCTAssertEqual(model.tasks.first?.goal, .null)
    }

    func testClearGoalUsesTheSharedRPCForActivePausedAndCompletedGoals() async throws {
        for provider in ["codex", "claude"] {
            for status in provider == "codex" ? ["active", "paused", "complete"] : ["active", "complete"] {
                let source = AgentTask(task.raw.setting("provider", .string(provider)).setting("goal", .object(["objective": .string("Finish this work"), "status": .string(status)])))
                let relay = GoalRelay(result: source.raw.setting("goal", .null))
                let model = AppModel.testing(relay: relay); model.connected = true; model.tasks = [source]
                let chat = model.chat(for: source); chat.draft = "Keep my unsent message"
                try await model.setGoal(source, clear: true)
                let calls = await relay.calls
                XCTAssertEqual(calls.count, 1)
                XCTAssertEqual(calls.first?.0, "thread.goal.clear")
                XCTAssertEqual(calls.first?.1, .object(["workspace_id": .string(source.projectID), "thread_id": .string(source.id)]))
                XCTAssertEqual(model.task(source.id)?.goal, .null)
                XCTAssertEqual(model.tasks.count, 1)
                XCTAssertEqual(chat.draft, "Keep my unsent message")
            }
        }
    }
    func testFailedGoalDeletionKeepsTheGoalAndCanBeRetried() async throws {
        let source = AgentTask(task.raw.setting("goal", .object(["objective": .string("Keep until confirmed"), "status": .string("complete")])))
        let relay = GoalRelay(result: source.raw.setting("goal", .null), failFirst: true)
        let model = AppModel.testing(relay: relay); model.connected = true; model.tasks = [source]
        do { try await model.setGoal(source, clear: true); XCTFail("Expected the synthetic RPC error") }
        catch { XCTAssertEqual(model.task(source.id)?.goal, source.goal) }
        try await model.setGoal(source, clear: true)
        XCTAssertEqual(model.task(source.id)?.goal, .null)
    }

    func testQueueEditKeepsFullTextAndRemoveUsesStableID() async throws {
        let model = AppModel.testing(relay: FeatureRelay())
        let queued = AgentTask(task.raw.setting("queued_turns", .array([.object(["id": .string("queue-1"), "text": .string("Old message"), "preview": .string("Old")])])))
        model.demo = true; model.tasks = [queued]
        let text = String(repeating: "Full message ", count: 100)
        try await model.queueAction(queued, queuedID: "queue-1", action: "edit", text: text)
        XCTAssertEqual(model.tasks.first?.queued.first?["text"].string, text)
        try await model.queueAction(try XCTUnwrap(model.tasks.first), queuedID: "queue-1", action: "remove")
        XCTAssertTrue(model.tasks.first?.queued.isEmpty == true)
    }

    func testDemoPinsAreMutuallyExclusiveAndModelDoesNotChangePermissions() async throws {
        let model = AppModel.testing(relay: FeatureRelay())
        let pinned = AgentTask(task.raw.setting("is_pinned", .bool(true)).setting("agent", .object(["sandbox_mode": .string("read-only")])))
        model.demo = true; model.tasks = [pinned]
        _ = try await model.taskRequest(pinned, method: "thread.update", fields: ["pinned_in_project": .bool(true), "model_id": .string("model")])
        XCTAssertFalse(model.tasks[0].pinned)
        XCTAssertTrue(model.tasks[0].pinnedInProject)
        XCTAssertEqual(model.tasks[0].raw["agent"]["sandbox_mode"].string, "read-only")
    }
    func testFailedChatCreationKeepsTheRecordingAndExistingDraft() async throws {
        let suite = "speech-recovery-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let recording = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1]).write(to: recording)
        defaults.set(recording.path, forKey: "native.voice.pending")
        defer { try? FileManager.default.removeItem(at: recording); defaults.removePersistentDomain(forName: suite) }
        let model = AppModel.testing(relay: FeatureRelay(failChat: true), voice: VoiceRecorder(defaults: defaults))
        model.connected = true
        let project = Project(.object(["id": .string("project"), "path": .string("/work/project")]))
        model.projects = [project]; model.selection = .draft(project.id, nil)
        let chat = model.chat(for: model.draftTask(project: project, folderID: nil)); chat.draft = "Keep my draft"
        let inserted = await model.insertRecoveredSpeech("Recovered text")
        XCTAssertFalse(inserted)
        XCTAssertEqual(chat.draft, "Keep my draft")
        XCTAssertEqual(model.voice.pendingURL, recording)
        XCTAssertTrue(FileManager.default.fileExists(atPath: recording.path))
    }
    func testRecoveredSpeechAppendsToARetainedDraftAfterSuccessfulCreation() async throws {
        let suite = "speech-insert-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel.testing(relay: FeatureRelay(), voice: VoiceRecorder(defaults: defaults))
        let root = FileManager.default.temporaryDirectory.appending(path: "RecoveredSpeech-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let store = try DraftStore(session: session, root: root); model.draftStore = store
        model.connected = true
        let project = Project(.object(["id": .string("project"), "path": .string("/work/project")]))
        model.projects = [project]
        let chat = model.chat(for: model.draftTask(project: project, folderID: nil)); chat.draft = "Keep my draft"
        let inserted = await model.insertRecoveredSpeech("Recovered text")
        XCTAssertTrue(inserted)
        XCTAssertEqual(chat.draft, "Keep my draft\n\nRecovered text")
        XCTAssertEqual(model.selection, .draft(project.id, nil))
        let saved = try await store.load()
        XCTAssertEqual(saved.first?.text, "Keep my draft\n\nRecovered text")
    }
    func testRecoveredSpeechSurvivesSocketReplacementDuringItsDraftWrite() async throws {
        let suite = "speech-reconnect-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let root = FileManager.default.temporaryDirectory.appending(path: "SpeechReconnect-\(UUID())")
        let recording = root.appending(path: "recording.m4a")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data([1]).write(to: recording)
        defer { try? FileManager.default.removeItem(at: root); defaults.removePersistentDomain(forName: suite) }
        defaults.set(recording.path, forKey: "native.voice.pending")
        let model = AppModel.testing(relay: FeatureRelay(), voice: VoiceRecorder(defaults: defaults))
        model.connected = true; model.hasSession = true
        let project = Project(.object(["id": .string("project"), "path": .string("/work/project")]))
        model.projects = [project]
        let chat = model.chat(for: model.draftTask(project: project, folderID: nil)); chat.draft = "Keep my draft"
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let store = try DraftStore(session: session, root: root.appending(path: "input")); model.draftStore = store
        let gate = RecoveryWriteGate()
        let blocking = Task.detached { await store.holdForRecoveryTest(gate) }
        await Task.detached { gate.waitForStart() }.value
        defer { gate.release.signal() }
        let recovery = Task { await model.insertRecoveredSpeech("Recovered text") }
        for _ in 0..<1000 where !chat.draft.contains("Recovered text") { try await Task.sleep(for: .milliseconds(1)) }
        XCTAssertTrue(chat.draft.contains("Recovered text"))
        let connection = model.connectionID, scope = model.sessionScope
        await model.reconnect()
        XCTAssertNotEqual(model.connectionID, connection); XCTAssertEqual(model.sessionScope, scope)
        gate.release.signal(); await blocking.value
        let inserted = await recovery.value
        XCTAssertTrue(inserted); XCTAssertNil(model.voice.pendingURL)
        XCTAssertEqual(chat.draft, "Keep my draft\n\nRecovered text")
    }
}

private final class RecoveryWriteGate: @unchecked Sendable {
    let started = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    func waitForStart() { started.wait() }
}
private extension DraftStore {
    /// Deliberately occupy this actor's executor to reproduce a delayed disk
    /// write; the UI actor remains free to replace the socket in the meantime.
    func holdForRecoveryTest(_ gate: RecoveryWriteGate) { gate.started.signal(); gate.release.wait() }
}

private actor GoalRelay: RelayServing {
    let result: JSON
    let failFirst: Bool
    private(set) var calls: [(String, JSON)] = []
    init(result: JSON, failFirst: Bool = false) { self.result = result; self.failFirst = failFirst }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) throws -> JSON {
        calls.append((method, params))
        if failFirst, calls.count == 1 { throw PilotError("Synthetic goal clear failure") }
        return result
    }
}

private actor ReadStateRelay: RelayServing {
    private var summary: JSON
    private let failUnread: Bool
    private let suspendUnread: Bool
    private var pending: CheckedContinuation<Void, Never>?
    private var calls: [(String, JSON)] = []
    init(task: AgentTask, failUnread: Bool = false, suspendUnread: Bool = false) {
        summary = task.raw; self.failUnread = failUnread; self.suspendUnread = suspendUnread
    }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async throws -> JSON {
        calls.append((method, params))
        if method == "thread.mark_unread" {
            if suspendUnread { await withCheckedContinuation { pending = $0 } }
            if failUnread { throw PilotError("Couldn't mark this task unread.") }
        }
        let seq = summary["attention"]["last_agent_activity_seq"].int
        let unread = method == "thread.mark_unread"
        let attention = summary["attention"].setting("unread", .bool(unread))
            .setting("last_read_seq", .number(Double(unread ? seq - 1 : params["read_seq"].int)))
        summary = summary.setting("attention", attention)
        return summary
    }
    func requests() -> [(String, JSON)] { calls }
    func waitForUnread() async { while pending == nil { await Task.yield() } }
    func finishUnread() { pending?.resume(); pending = nil }
}

@MainActor final class TaskReadStateTests: XCTestCase {
    private func task(seq: Int = 5, unread: Bool = false) -> AgentTask {
        AgentTask(.object(["id": .string("read-task"), "workspace_id": .string("project"), "status": .string("idle"),
            "attention": .object(["unread": .bool(unread), "last_agent_activity_seq": .number(Double(seq)), "last_read_seq": .number(Double(unread ? seq - 1 : seq))])]))
    }
    private func setup(_ task: AgentTask, relay: ReadStateRelay) -> AppModel {
        let model = AppModel.testing(relay: relay)
        model.connected = true; model.tasks = [task]; model.selection = .task(task.id)
        return model
    }
    func testManualUnreadUsesTheDaemonContractAndSurvivesAutomaticRead() async {
        let task = task(), relay = ReadStateRelay(task: task)
        let model = setup(task, relay: relay)
        await model.markRead(task, unread: true)
        let unread = model.task(task.id)!
        XCTAssertTrue(unread.unread)
        XCTAssertEqual(unread.raw["attention"]["last_read_seq"].int, 4)
        await model.markRead(unread, automatic: true)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.mark_unread"])
        XCTAssertEqual(calls[0].1, .object(["workspace_id": .string("project"), "thread_id": .string(task.id)]))
    }
    func testReopeningTheSameTaskAllowsAutomaticReadAgain() async {
        let task = task(), relay = ReadStateRelay(task: task)
        let model = setup(task, relay: relay)
        await model.markRead(task, unread: true)
        // On iPhone, Back hides the detail without changing the selection.
        model.selection = .task(task.id)
        await model.markRead(model.task(task.id)!, automatic: true)
        XCTAssertFalse(model.task(task.id)!.unread)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.mark_unread", "thread.mark_read"])
    }
    func testFailedUnreadDoesNotBlockLaterAutomaticReads() async {
        let task = task(unread: true), relay = ReadStateRelay(task: task, failUnread: true)
        let model = setup(task, relay: relay)
        await model.markRead(task, unread: true)
        XCTAssertEqual(model.error, "Couldn't mark this task unread.")
        await model.markRead(task, automatic: true)
        XCTAssertFalse(model.task(task.id)!.unread)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.mark_unread", "thread.mark_read"])
    }
    func testUnreadSuppressionFollowsTheDaemonsSettledActivitySequence() async {
        let task = task(), relay = ReadStateRelay(task: self.task(seq: 8))
        let model = setup(task, relay: relay)
        await model.markRead(task, unread: true)
        let settled = model.task(task.id)!
        XCTAssertEqual(settled.activitySeq, 8)
        await model.markRead(settled, automatic: true)
        XCTAssertTrue(model.task(task.id)!.unread)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.mark_unread"])
    }
    func testNavigationDuringUnreadRequestDoesNotRestoreSuppression() async {
        let task = task(), relay = ReadStateRelay(task: self.task(seq: 8), suspendUnread: true)
        let model = setup(task, relay: relay)
        let mark = Task { await model.markRead(task, unread: true) }
        await relay.waitForUnread()
        model.selection = .activity
        model.selection = .task(task.id)
        await relay.finishUnread()
        let succeeded = await mark.value
        XCTAssertTrue(succeeded)
        await model.markRead(model.task(task.id)!, automatic: true)
        XCTAssertFalse(model.task(task.id)!.unread)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.mark_unread", "thread.mark_read"])
    }
    func testNewAgentActivityReleasesUnreadSuppression() async {
        let task = task(), relay = ReadStateRelay(task: self.task(seq: 6))
        let model = setup(task, relay: relay)
        model.demo = true
        await model.markRead(task, unread: true)
        model.demo = false
        let newer = self.task(seq: 6, unread: true)
        model.upsertTask(newer.raw)
        await model.markRead(newer, automatic: true)
        XCTAssertFalse(model.task(task.id)!.unread)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.mark_read"])
    }
}

private actor PlanResponseRelay: RelayServing {
    private let fail: Bool
    private var calls: [(String, JSON)] = []
    init(fail: Bool = false) { self.fail = fail }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) throws -> JSON {
        calls.append((method, params))
        if fail { throw PilotError("Plan response unavailable") }
        return .object(["ok": .bool(true)])
    }
    func requests() -> [(String, JSON)] { calls }
}

@MainActor final class PlanResponseTests: XCTestCase {
    private var request: JSON { .object(["request_id": .string("plan-review"), "workspace_id": .string("project"), "thread_id": .string("task"), "kind": .string("plan_approval"), "detail": .string("Review this plan.")]) }

    func testAllPlanOutcomesReachTheExistingDaemonContractWithoutSendingTheComposer() async throws {
        for (action, outcome) in [(PlanReviewAction.approve, "approved"), (.requestChanges, "cancelled"), (.abandon, "abandoned")] {
            let relay = PlanResponseRelay(), model = AppModel.testing(relay: relay)
            model.connected = true; model.requests = [request]
            let task = AgentTask(.object(["id": .string("task"), "workspace_id": .string("project")]))
            let chat = model.chat(for: task); chat.draft = "Keep my separate follow-up."
            let response = try XCTUnwrap(action.response(for: request, feedback: " Revise validation. "))
            try await model.respond(request: request, response: response)
            let calls = await relay.requests()
            XCTAssertEqual(calls.map(\.0), ["interactive.respond"])
            XCTAssertEqual(calls[0].1["workspace_id"].string, "project")
            XCTAssertEqual(calls[0].1["request_id"].string, "plan-review")
            XCTAssertEqual(calls[0].1["response"]["kind"].string, "plan_approval")
            XCTAssertEqual(calls[0].1["response"]["outcome"].string, outcome)
            XCTAssertEqual(calls[0].1["response"]["feedback"], action == .requestChanges ? .string("Revise validation.") : .null)
            XCTAssertTrue(model.requests.isEmpty)
            XCTAssertEqual(chat.draft, "Keep my separate follow-up.")
        }
    }
    func testFailedPlanResponsesLeaveThePendingReviewAndComposerIntact() async throws {
        for action in [PlanReviewAction.approve, .requestChanges, .abandon] {
            let relay = PlanResponseRelay(fail: true), model = AppModel.testing(relay: relay)
            model.connected = true; model.requests = [request]
            let task = AgentTask(.object(["id": .string("task"), "workspace_id": .string("project")]))
            let chat = model.chat(for: task); chat.draft = "Keep my separate follow-up."
            let response = try XCTUnwrap(action.response(for: request, feedback: "Revise validation."))
            do {
                try await model.respond(request: request, response: response)
                XCTFail("A failed submission must remain available for retry")
            } catch { XCTAssertEqual(error.localizedDescription, "Plan response unavailable") }
            XCTAssertEqual(model.requests, [request])
            XCTAssertEqual(chat.draft, "Keep my separate follow-up.")
        }
    }
}
