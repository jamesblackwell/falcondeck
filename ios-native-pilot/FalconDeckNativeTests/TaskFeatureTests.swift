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
        await controlled.send(draft)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.start", "thread.update", "turn.start"])
        XCTAssertEqual(calls[0].1["model_id"].string, "chosen-model")
        XCTAssertEqual(calls[2].1["sandbox_mode"].string, "read-only")
        XCTAssertEqual(calls[2].1["approval_policy"], .null)
        XCTAssertEqual(controlled.selection, .task("created-task"))
        XCTAssertTrue(chat.draft.isEmpty)
        XCTAssertEqual(controlled.tasks.count, 1)
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
    func testRecoveredSpeechAppendsToARetainedDraftAfterSuccessfulCreation() async {
        let suite = "speech-insert-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel.testing(relay: FeatureRelay(), voice: VoiceRecorder(defaults: defaults))
        model.connected = true
        let project = Project(.object(["id": .string("project"), "path": .string("/work/project")]))
        model.projects = [project]
        let chat = model.chat(for: model.draftTask(project: project, folderID: nil)); chat.draft = "Keep my draft"
        let inserted = await model.insertRecoveredSpeech("Recovered text")
        XCTAssertTrue(inserted)
        XCTAssertEqual(chat.draft, "Keep my draft\n\nRecovered text")
        XCTAssertEqual(model.selection, .draft(project.id, nil))
    }
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
