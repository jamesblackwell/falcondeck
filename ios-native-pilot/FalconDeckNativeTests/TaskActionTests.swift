import XCTest
@testable import FalconDeckNative

private actor ActionRelay: RelayServing {
    let source: JSON
    var calls: [(String, JSON)] = []
    init(_ source: JSON) { self.source = source }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .object(["items": .array([]), "has_older": .bool(false)]) }
    func call(_ method: String, params: JSON) -> JSON {
        calls.append((method, params))
        switch method {
        case "thread.start", "thread.fork": return .object(["thread": source.setting("id", .string("destination")).setting("provider", params["provider"].string.isEmpty ? source["provider"] : params["provider"])])
        case "workspace.skills": return .object(["skills": .array([])])
        case "workspace.prompts": return .object(["prompts": .array([])])
        default: return .object(["ok": .bool(true)])
        }
    }
    func requests() -> [(String, JSON)] { calls }
}

@MainActor final class TaskActionTests: XCTestCase {
    private var source: AgentTask { AgentTask(.object(["id": .string("source"), "workspace_id": .string(Demo.projects[0].id), "provider": .string("codex"), "status": .string("idle"), "title": .string("Original"), "agent": .object(["model_id": .string("chosen"), "sandbox_mode": .string("read-only")])])) }
    private func setup() -> (AppModel, ActionRelay) {
        let relay = ActionRelay(source.raw), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = Demo.projects; model.tasks = [source]; model.selection = .task(source.id)
        return (model, relay)
    }
    func testEditBranchesBeforeTheUserTurnAndLeavesOriginalDraftAlone() async throws {
        let (model, relay) = setup()
        model.chat(for: source).draft = "Keep this draft"
        let message = Message(.object(["id": .string("user"), "kind": .string("user_message"), "text": .string("Edit this"), "previous_turn_id": .string("before")]))
        try await model.branch(source, message: message, retry: false)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.fork"])
        XCTAssertEqual(calls[0].1["last_turn_id"].string, "before")
        XCTAssertEqual(model.chats["source"]?.draft, "Keep this draft")
        XCTAssertEqual(model.chats["destination"]?.draft, "Edit this")
        XCTAssertEqual(model.selection, .task("destination"))
    }
    func testRetryOfTheFirstMessageCreatesANewTaskWithExistingPermissions() async throws {
        let (model, relay) = setup()
        let message = Message(.object(["id": .string("user"), "kind": .string("user_message"), "text": .string("Try again")]))
        try await model.branch(source, message: message, retry: true)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.start", "turn.start"])
        XCTAssertEqual(calls[0].1["sandbox_mode"].string, "read-only")
        XCTAssertEqual(calls[1].1["thread_id"].string, "destination")
        XCTAssertEqual(calls[1].1["inputs"].array.first?["text"].string, "Try again")
    }
    func testHandoffCreatesContextPendingDestinationWithoutStartingAnAgentTurn() async throws {
        let (model, relay) = setup()
        let chat = model.chat(for: source)
        chat.loaded = true; chat.transcript.items = [Message(.object(["id": .string("u"), "kind": .string("user_message"), "text": .string("Preserve this objective")]))]
        try await model.handoff(source, provider: "claude")
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["thread.start", "thread.update"])
        XCTAssertEqual(calls[0].1["handoff_from"]["thread_id"].string, "source")
        XCTAssertTrue(calls[0].1["handoff_context"].string.contains("Preserve this objective"))
        XCTAssertFalse(calls.contains { $0.0 == "turn.start" || $0.0 == "turn.interrupt" })
        XCTAssertEqual(model.tasks.first(where: { $0.id == "source" })?.title, "Original")
    }
    func testResumeUsesTheDedicatedContractAndPreservesComposerText() async {
        let (model, relay) = setup()
        let interrupted = AgentTask(source.raw.setting("status", .string("error")).setting("last_error", .string("FalconDeck was closed while this turn was running")))
        model.chat(for: interrupted).draft = "Keep my follow-up"
        await model.resumeInterrupted(interrupted)
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), ["turn.start"])
        XCTAssertTrue(calls[0].1["resume_interrupted"].bool)
        XCTAssertTrue(calls[0].1["inputs"].array.isEmpty)
        XCTAssertEqual(model.chat(for: interrupted).draft, "Keep my follow-up")
    }
    func testSuggestedActionsDoNotConsumeTheUsersDraftOrAttachments() async {
        let (model, relay) = setup()
        let chat = model.chat(for: source)
        chat.draft = "My unfinished thought"
        chat.attachments = [NativeAttachment(id: "image", name: "Image.jpg", mimeType: "image/jpeg", data: Data([1]))]
        await model.send(source, textOverride: "Run the tests")
        let calls = await relay.requests()
        XCTAssertEqual(chat.draft, "My unfinished thought")
        XCTAssertEqual(chat.attachments.count, 1)
        XCTAssertEqual(calls.last?.1["inputs"].array.count, 1)
        XCTAssertEqual(calls.last?.1["inputs"].array.first?["text"].string, "Run the tests")
    }
    func testSkillMentionsAreDeduplicatedAndDoNotMatchFilePaths() {
        let skill = JSON.object(["id": .string("review"), "alias": .string("/review")])
        let selected = ComposerCatalog.selected("/review then /review and /review/file.md with x/review", skills: [skill])
        XCTAssertEqual(selected, [.object(["skill_id": .string("review"), "alias": .string("/review")])])
        XCTAssertEqual(ComposerCatalog.alias("$My_Skill"), "/my-skill")
        XCTAssertFalse(ComposerCatalog.supports(skill.setting("providers", .array([.string("claude")])), provider: "codex"))
    }
    func testHandoffBoundsVeryLongUnicodeContextAndMarksTheOmission() {
        let input = String(repeating: "👋", count: 500_000)
        let context = HandoffContext.build([Message(.object(["id": .string("a"), "kind": .string("assistant_message"), "text": .string(input)]))], title: "Long", partial: true)
        XCTAssertLessThan(context.unicodeScalars.count, 480_000)
        XCTAssertTrue(context.contains("Middle history omitted"))
        XCTAssertTrue(context.contains("Partial export"))
        XCTAssertFalse(context.contains("�"))
    }
}
