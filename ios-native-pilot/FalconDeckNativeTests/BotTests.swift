import XCTest
@testable import FalconDeckNative

private actor BotRelay: RelayServing {
    private var calls: [(String, JSON)] = []
    private let response: JSON
    private let holding: Bool
    private var pending: CheckedContinuation<JSON, Never>?
    private var ready: CheckedContinuation<Void, Never>?
    init(response: JSON = .object(["ok": .bool(true)]), holding: Bool = false) { self.response = response; self.holding = holding }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { response }
    func call(_ method: String, params: JSON) async -> JSON {
        calls.append((method, params))
        if holding { return await withCheckedContinuation { pending = $0; ready?.resume(); ready = nil } }
        return response
    }
    func requests() -> [(String, JSON)] { calls }
    func waitForRequest() async { if pending == nil { await withCheckedContinuation { ready = $0 } } }
    func finish() { pending?.resume(returning: response); pending = nil }
}

@MainActor final class BotTests: XCTestCase {
    private var profile: JSON {
        .object(["id": .string("bot-one"), "name": .string("Release helper"), "workspace_id": .string("bot-project"), "thread_id": .string("bot-home"), "dedicated_workspace": .bool(true), "space_path": .string("/demo/bot/space"), "instructions": .string("Coordinate releases.")])
    }

    func testMissingBotPreferenceIsCompatibleAndPromotedProjectsRemainVisible() {
        let model = AppModel.testing(relay: BotRelay())
        XCTAssertTrue(model.bots.isEmpty)
        let promoted = profile.setting("id", .string("promoted")).setting("thread_id", .string("existing-task")).setting("workspace_id", .string("real-project")).setting("dedicated_workspace", .bool(false))
        model.preferences = .object(["bots": .array([profile, promoted, .object(["id": .string("incomplete")])])])
        XCTAssertEqual(model.bots.count, 2)
        XCTAssertEqual(model.botTaskIDs, ["bot-home", "existing-task"])
        XCTAssertEqual(model.botWorkspaceIDs, ["bot-project"])
        XCTAssertTrue(model.bots[0].canStartThreads, "Older profiles default to allowing delegation")
    }

    func testPromotingATaskOmitsHarnessSettingsAndUpdatesPreserveDelegationChoice() throws {
        var draft = NativeBotDraft()
        draft.name = "  Release helper  "; draft.existingTaskID = "existing"; draft.provider = "claude"; draft.modelID = "ignored"
        let promoted = try draft.mutation()
        XCTAssertEqual(promoted["name"].string, "Release helper")
        XCTAssertEqual(promoted["thread_id"].string, "existing")
        XCTAssertEqual(promoted["provider"], .null); XCTAssertEqual(promoted["model_id"], .null)
        draft.canStartThreads = false
        let updated = try draft.mutation(bot: NativeBot(raw: profile))
        XCTAssertEqual(updated["action"].string, "update")
        XCTAssertEqual(updated["id"].string, "bot-one")
        XCTAssertEqual(updated["can_start_threads"], .bool(false))
        XCTAssertEqual(updated["thread_id"], .null)
    }

    func testBotAndDocumentLimitsCountUTF8Bytes() throws {
        var draft = NativeBotDraft()
        draft.name = "Bot"; draft.instructions = String(repeating: "🦅", count: 8_001)
        XCTAssertThrowsError(try draft.mutation())
        draft.instructions = ""; draft.name = "Bot\nTwo"
        XCTAssertThrowsError(try draft.mutation())
        for filename in ["../notes.md", ".hidden", "folder/note", "folder\\note", "bad\nname", ""] {
            XCTAssertThrowsError(try NativeBotDocument.validate(name: filename))
        }
        XCTAssertThrowsError(try NativeBotDocument.validate(name: String(repeating: "🦅", count: 46)))
        XCTAssertThrowsError(try NativeBotDocument.validate(name: "notes.md", content: String(repeating: "🦅", count: 262_145)))
        XCTAssertNoThrow(try NativeBotDocument.validate(name: "Release notes.md", content: "Editable from iPhone."))
    }

    func testMutationMergesOnlyItsBotAndRetainsOtherPreferences() async throws {
        let saved = profile.setting("name", .string("Renamed"))
        let relay = BotRelay(response: .object(["bot": saved]))
        let model = AppModel.testing(relay: relay)
        let sibling = profile.setting("id", .string("other")).setting("thread_id", .string("other-home"))
        model.preferences = .object(["bots": .array([profile, sibling]), "workspace_order": .array([.string("project")])])
        var draft = NativeBotDraft(bot: NativeBot(raw: profile)); draft.name = "Renamed"
        let result = try await model.saveBot(draft, bot: NativeBot(raw: profile))
        XCTAssertEqual(result.name, "Renamed")
        XCTAssertEqual(model.bots.map(\.name), ["Renamed", "Release helper"])
        XCTAssertEqual(model.preferences["workspace_order"], .array([.string("project")]))
        let calls = await relay.requests()
        XCTAssertEqual(calls.first?.0, "bots.mutate")
        XCTAssertEqual(calls.first?.1["action"].string, "update")
    }

    func testLateMutationReplyCannotUndoANewerPreferenceEvent() async throws {
        let saved = profile.setting("name", .string("Older response"))
        let relay = BotRelay(response: .object(["bot": saved]), holding: true)
        let model = AppModel.testing(relay: relay)
        model.preferences = .object(["bots": .array([profile])])
        var draft = NativeBotDraft(bot: NativeBot(raw: profile)); draft.name = "Older response"
        let save = Task { try await model.saveBot(draft, bot: NativeBot(raw: profile)) }
        await relay.waitForRequest()
        model.preferences = model.preferences.setting("bots", .array([profile.setting("name", .string("Newer event"))]))
        await relay.finish(); _ = try await save.value
        XCTAssertEqual(model.bots.first?.name, "Newer event")
    }

    func testMutationReplyIsRejectedAfterConnectionChanges() async throws {
        let relay = BotRelay(response: .object(["bot": profile]), holding: true)
        let model = AppModel.testing(relay: relay)
        var draft = NativeBotDraft(); draft.name = "Release helper"
        let save = Task { try await model.saveBot(draft) }
        await relay.waitForRequest()
        await model.useDemo()
        let demoBots = model.bots
        await relay.finish()
        do { _ = try await save.value; XCTFail("An old computer's response must be rejected") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(model.bots, demoBots)
    }

    func testLateCreateReplyCannotResurrectABotRemovedByNewerEvents() async throws {
        let relay = BotRelay(response: .object(["bot": profile]), holding: true)
        let model = AppModel.testing(relay: relay)
        var draft = NativeBotDraft(); draft.name = "Release helper"
        let save = Task { try await model.saveBot(draft) }
        await relay.waitForRequest()
        model.preferences = .object(["bots": .array([profile])])
        model.preferences = .object(["bots": .array([])])
        await relay.finish(); _ = try await save.value
        XCTAssertTrue(model.bots.isEmpty)
    }

    func testDocumentMutationsCarryNestedOptimisticVersionContract() async throws {
        let relay = BotRelay(), model = AppModel.testing(relay: relay), bot = NativeBot(raw: profile)
        try await model.writeBotDocument(bot, name: "Notes.md", content: "New document")
        try await model.writeBotDocument(bot, name: "Notes.md", content: "Edit", expectedVersion: "version-one")
        try await model.deleteBotDocument(bot, name: "Notes.md", expectedVersion: "version-two")
        let calls = await relay.requests()
        XCTAssertEqual(calls.map(\.0), Array(repeating: "bots.document.mutate", count: 3))
        XCTAssertEqual(calls[0].1["id"].string, bot.id)
        XCTAssertEqual(calls[0].1["mutation"]["expected_version"], .null)
        XCTAssertEqual(calls[1].1["mutation"]["expected_version"].string, "version-one")
        XCTAssertEqual(calls[2].1["mutation"]["action"].string, "delete")
        XCTAssertEqual(calls[2].1["mutation"]["expected_version"].string, "version-two")
    }

    func testDocumentReadsCannotTreatMalformedPayloadsAsEmptyFiles() async {
        let bot = NativeBot(raw: profile)
        let model = AppModel.testing(relay: BotRelay(response: .object(["name": .string("Notes.md"), "version": .string("hash")])) )
        do { _ = try await model.readBotDocument(bot, name: "Notes.md"); XCTFail("Missing content must fail") }
        catch { XCTAssertTrue(error is PilotError) }
        do { _ = try await model.botDocuments(bot); XCTFail("A malformed document list must fail") }
        catch { XCTAssertTrue(error is PilotError) }
    }

    func testOpeningABotHydratesHomeMissingFromCompactIndex() async {
        let home = JSON.object(["id": .string("bot-home"), "workspace_id": .string("bot-project"), "provider": .string("claude"), "title": .string("Release helper"), "status": .string("idle")])
        let model = AppModel.testing(relay: BotRelay(response: .object(["thread": home, "items": .array([])])))
        model.connected = true
        XCTAssertTrue(model.tasks.isEmpty)
        let opened = await model.openBot(NativeBot(raw: profile))
        XCTAssertTrue(opened)
        XCTAssertEqual(model.selection, .task("bot-home"))
        XCTAssertEqual(model.task("bot-home")?.provider, "claude")
        XCTAssertTrue(model.chats["bot-home"]?.loaded ?? false)
    }

    func testDemoDocumentsRejectBlindOverwritesAndStaleSaves() async throws {
        let model = AppModel.testing(relay: BotRelay())
        model.demo = true; model.preferences = .object(["bots": .array([profile])])
        let bot = NativeBot(raw: profile)
        try await model.writeBotDocument(bot, name: "Notes.md", content: "First")
        let initial = try await model.readBotDocument(bot, name: "Notes.md")
        do { try await model.writeBotDocument(bot, name: "Notes.md", content: "Blind overwrite"); XCTFail("A new file cannot overwrite an existing document") }
        catch { XCTAssertTrue(error is PilotError) }
        try await model.writeBotDocument(bot, name: "Notes.md", content: "Second", expectedVersion: initial.version)
        do { try await model.deleteBotDocument(bot, name: "Notes.md", expectedVersion: initial.version); XCTFail("A stale delete must fail") }
        catch { XCTAssertTrue(error is PilotError) }
        let edited = try await model.readBotDocument(bot, name: "Notes.md")
        XCTAssertEqual(edited.content, "Second")
        try await model.deleteBotDocument(bot, name: "Notes.md", expectedVersion: edited.version)
        let names = try await model.botDocuments(bot)
        XCTAssertTrue(names.isEmpty)
    }

    func testDelegatedTasksStayAcrossProjectsAndExcludeUnrelatedTasks() {
        let model = AppModel.testing(relay: BotRelay())
        func task(_ id: String, project: String, parent: String, archived: Bool = false) -> AgentTask {
            AgentTask(.object(["id": .string(id), "workspace_id": .string(project), "origin": .object(["kind": .string("agent_spawn"), "parent_thread_id": .string(parent)]), "is_archived": .bool(archived)]))
        }
        model.tasks = [task("first", project: "a", parent: "bot-home"), task("second", project: "b", parent: "bot-home"), task("unrelated", project: "a", parent: "elsewhere"), task("archived", project: "b", parent: "bot-home", archived: true)]
        XCTAssertEqual(Set(model.delegatedTasks(for: NativeBot(raw: profile)).map(\.id)), ["first", "second"])
    }
}
