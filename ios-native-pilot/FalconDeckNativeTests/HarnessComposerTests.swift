import XCTest
@testable import FalconDeckNative

@MainActor final class HarnessComposerTests: XCTestCase {
    func testEveryHarnessHydratesNewAndExistingComposersAndKeepsItsWireIDs() async throws {
        for (provider, modelID, effort) in HarnessPreview.selections {
            for draft in [true, false] {
                let relay = HarnessRelay(), model = AppModel.testing(relay: relay)
                let project = HarnessPreview.project
                model.projects = [Project(project.raw.setting("agents", .array(project.raw["agents"].array.map { $0.setting("models", .array([])) })))]; model.connected = true
                var task = AgentTask(Demo.tasks[0].raw.setting("provider", .string(provider)))
                if draft {
                    task = model.draftTask(project: project, folderID: nil)
                    model.chooseProvider(provider, task: task, chat: model.chat(for: task))
                    task = model.draftTask(project: project, folderID: nil)
                }
                let load = Task { await model.loadModels(task, timeout: .seconds(2)) }
                await relay.waitForHydration()
                model.projects = [project]; await load.value
                XCTAssertNil(model.catalog(task).modelsError, provider)
                let chat = model.chat(for: task)
                chat.chooseModel(modelID); chat.chooseEffort(effort); chat.draft = "Local fixture"
                await model.send(task)
                let calls = await relay.calls
                let turn = try XCTUnwrap(calls.last { $0.0 == "turn.start" }?.1)
                XCTAssertEqual(turn["provider"].string, provider)
                XCTAssertEqual(turn["model_id"].string, modelID)
                XCTAssertEqual(turn["reasoning_effort"].string, effort)
            }
        }
    }
    func testProviderSwitchRestoresChoicesWithoutLeakingModesOrLosingInput() {
        let model = AppModel.testing(relay: HarnessRelay()), project = HarnessPreview.project
        model.projects = [project]
        var task = model.draftTask(project: project, folderID: nil)
        let chat = model.chat(for: task); chat.draft = "Keep my draft"
        for (provider, modelID, effort) in HarnessPreview.selections {
            model.chooseProvider(provider, task: task, chat: chat)
            task = model.draftTask(project: project, folderID: nil)
            chat.chooseModel(modelID); chat.chooseEffort(effort)
            chat.overrides["collaboration_mode_id"] = .string(provider == "opencode" ? "build" : "default")
            if provider == "codex" { chat.overrides["sandbox_mode"] = .string("workspace-write") }
        }
        for (provider, modelID, effort) in HarnessPreview.selections {
            model.chooseProvider(provider, task: task, chat: chat)
            task = model.draftTask(project: project, folderID: nil)
            XCTAssertEqual(task.provider, provider); XCTAssertEqual(chat.modelID, modelID); XCTAssertEqual(chat.effort, effort)
            XCTAssertEqual(chat.draft, "Keep my draft")
            if provider != "codex" { XCTAssertNil(chat.overrides["sandbox_mode"]) }
        }
        let folderTask = model.draftTask(project: project, folderID: "folder")
        XCTAssertEqual(folderTask.provider, "opencode")
        XCTAssertEqual(model.chat(for: folderTask).modelID, "openrouter/z-ai/glm-5")
    }
    func testExistingTaskKeepsItsOwnSettingsAndCannotSwitchProvider() {
        let model = AppModel.testing(relay: HarnessRelay()); model.projects = [HarnessPreview.project]
        for (provider, modelID, effort) in HarnessPreview.selections {
            let task = AgentTask(Demo.tasks[0].raw.setting("id", .string(provider)).setting("provider", .string(provider)).setting("agent", .object(["model_id": .string(modelID), "reasoning_effort": .string(effort)])))
            let chat = model.chat(for: task)
            model.chooseProvider("claude", task: task, chat: chat)
            XCTAssertEqual(chat.provider, provider); XCTAssertEqual(chat.modelID, modelID); XCTAssertEqual(chat.effort, effort)
        }
    }
    func testRestoredDraftForARemovedHarnessFallsBackWithoutLeakingItsSettings() {
        let model = AppModel.testing(relay: HarnessRelay())
        let project = Project(HarnessPreview.project.raw.setting("agents", .array([HarnessPreview.project.raw["agents"].array[0]])))
        model.projects = [project]
        let task = model.draftTask(project: project, folderID: nil)
        model.savedDrafts[task.id] = SavedDraft(id: task.id, text: "Keep this input", attachments: [], modelID: "fable", effort: "max", provider: "claude", overrides: ["permission_mode": .string("acceptEdits")])
        let restoredTask = model.draftTask(project: project, folderID: nil), chat = model.chat(for: restoredTask)
        XCTAssertEqual(restoredTask.provider, "codex"); XCTAssertEqual(chat.provider, "codex")
        XCTAssertEqual(chat.draft, "Keep this input"); XCTAssertTrue(chat.modelID.isEmpty); XCTAssertTrue(chat.overrides.isEmpty)
    }
    func testRestoredExistingDraftKeepsInputAndExplicitChoicesButRefreshesRecordedDefaults() {
        let model = AppModel.testing(relay: HarnessRelay())
        let task = AgentTask(Demo.tasks[0].raw.setting("agent", .object(["model_id": .string("fresh"), "reasoning_effort": .null])))
        model.savedDrafts[task.id] = SavedDraft(id: task.id, text: "My draft", attachments: [], modelID: "old", effort: "low", provider: task.provider, overrides: [:])
        let chat = model.chat(for: task)
        XCTAssertEqual(chat.modelID, "fresh"); XCTAssertEqual(chat.effort, ""); XCTAssertEqual(chat.draft, "My draft")
        let pending = AgentTask(task.raw.setting("id", .string("pending")))
        model.savedDrafts[pending.id] = SavedDraft(id: pending.id, text: "My pick", attachments: [], modelID: "chosen", effort: "high", provider: pending.provider, overrides: ["model_id": .string("chosen"), "reasoning_effort": .string("high")])
        let picked = model.chat(for: pending)
        XCTAssertEqual(picked.modelID, "chosen"); XCTAssertEqual(picked.effort, "high")
    }
    func testCachedThreadMetadataCannotAcknowledgeAnUnsubmittedChoice() {
        let model = AppModel.testing(relay: HarnessRelay())
        let task = AgentTask(Demo.tasks[0].raw.setting("agent", .object(["model_id": .string("chosen"), "reasoning_effort": .null])))
        model.previewTaskIDs = [task.id]
        model.savedDrafts[task.id] = SavedDraft(id: task.id, text: "My draft", attachments: [], modelID: "chosen", effort: "", provider: task.provider, overrides: ["model_id": .string("chosen"), "reasoning_effort": .null])
        let chat = model.chat(for: task)
        model.tasks = [task]
        XCTAssertEqual(chat.overrides["model_id"], .string("chosen"))
        XCTAssertEqual(chat.overrides["reasoning_effort"], .null)
        // An identical authoritative detail row may not change the task array;
        // it still acknowledges settings and retires the preview marker.
        model.upsertTask(task.raw)
        XCTAssertNil(chat.overrides["model_id"])
        XCTAssertNil(chat.overrides["reasoning_effort"])
        XCTAssertFalse(model.previewTaskIDs.contains(task.id))
    }
    func testFreshThreadSettingsFollowTheDaemonWithoutOverwritingUnsentPicks() {
        let model = AppModel.testing(relay: HarnessRelay())
        var task = AgentTask(Demo.tasks[0].raw.setting("agent", .object(["model_id": .string("old"), "reasoning_effort": .string("low")])))
        model.tasks = [task]
        let chat = model.chat(for: task); chat.draft = "Unsent text"
        task = AgentTask(task.raw.setting("agent", .object(["model_id": .string("remote"), "reasoning_effort": .null])))
        model.upsertTask(task.raw)
        XCTAssertEqual(chat.modelID, "remote"); XCTAssertEqual(chat.effort, "")
        chat.chooseModel("mine"); chat.chooseEffort("high")
        task = AgentTask(task.raw.setting("agent", .object(["model_id": .string("another"), "reasoning_effort": .string("medium")])))
        model.upsertTask(task.raw)
        XCTAssertEqual(chat.modelID, "mine"); XCTAssertEqual(chat.effort, "high")
        task = AgentTask(task.raw.setting("agent", .object(["model_id": .string("mine"), "reasoning_effort": .string("high")])))
        model.upsertTask(task.raw)
        XCTAssertNil(chat.overrides["model_id"]); XCTAssertNil(chat.overrides["reasoning_effort"])
        XCTAssertEqual(chat.draft, "Unsent text")
    }
    func testProviderDefaultsAndCapabilitiesDoNotLeakFromAnotherHarness() {
        let raw = HarnessPreview.project.raw.setting("default_provider", .null)
        let onlyOpenCode = Project(raw.setting("agents", .array([raw["agents"].array[2]])))
        XCTAssertEqual(onlyOpenCode.defaultProvider, "opencode")
        let legacy = Project(.object(["default_provider": .string("codex"), "capabilities": .object(["supports_images": .bool(true)])]))
        XCTAssertEqual(legacy.capabilities("unknown"), .null)
        XCTAssertTrue(legacy.capabilities("codex")["supports_images"].bool)
    }
    func testRememberedSelectionsDropRemovedModelsAndAccessModes() {
        let old = ComposerSelection(modelID: "removed", effort: "high", overrides: ["model_id": .string("removed"), "reasoning_effort": .string("high"), "sandbox_mode": .string("danger-full-access"), "permission_mode": .string("never"), "approval_policy": .string("never"), "collaboration_mode_id": .string("removed")])
        let value = old.validated(project: HarnessPreview.project, provider: "opencode")
        XCTAssertEqual(value.modelID, ""); XCTAssertEqual(value.effort, ""); XCTAssertTrue(value.overrides.isEmpty)
    }
    func testChangingModelsClearsReasoningAndSpeedButPreservesPermissions() {
        let chat = ChatSession(); chat.provider = "codex"
        chat.overrides = ["service_tier": .string("fast"), "sandbox_mode": .string("read-only")]
        chat.chooseEffort("high"); chat.chooseModel("gpt-5.4")
        XCTAssertEqual(chat.effort, ""); XCTAssertEqual(chat.overrides["reasoning_effort"], .null)
        XCTAssertNil(chat.overrides["service_tier"]); XCTAssertEqual(chat.overrides["sandbox_mode"], .string("read-only"))
        chat.chooseModel("")
        XCTAssertEqual(chat.overrides["model_id"], .null)
    }
    func testOpenCodeVariantsAndModelsWithoutReasoningUseAdvertisedMetadata() {
        let project = HarnessPreview.project
        XCTAssertEqual(project.resolvedModel(for: "opencode", id: "openrouter/z-ai/glm-5")?.efforts, ["default", "low", "high", "max"])
        XCTAssertTrue(project.resolvedModel(for: "opencode", id: "google/gemini-plain")!.efforts.isEmpty)
        XCTAssertTrue(project.resolvedModel(for: "opencode", id: "default")!.efforts.isEmpty)
    }
    func testClaudeVersionAndExtendedContextRetainReasoningWithoutChangingIDs() {
        for (id, label) in [("claude-fable-5", "Fable 5"), ("claude-fable-5-1[1m]", "Fable 5.1 (1M)"), ("claude-fable-5[1m]", "Fable 5 (1M)")] {
            let value = HarnessPreview.project.resolvedModel(for: "claude", id: id)
            XCTAssertEqual(value?.id, id); XCTAssertEqual(value?.label, label); XCTAssertEqual(value?.efforts.last, "max")
        }
    }
    func testProviderChoicesSurviveEncryptedRelaunchAndStayPairingScoped() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 1, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let store = try DraftStore(session: session, root: root)
        let model = AppModel.testing(relay: HarnessRelay()); model.projects = [HarnessPreview.project]
        let task = model.draftTask(project: HarnessPreview.project, folderID: nil), chat = model.chat(for: task)
        model.chooseProvider("claude", task: task, chat: chat); chat.chooseModel("fable"); chat.chooseEffort("max")
        try await store.saveComposerPreferences(model.composerPreferences)
        let restored = AppModel.testing(relay: HarnessRelay()); restored.projects = [HarnessPreview.project]
        restored.composerPreferences = try await store.loadComposerPreferences()
        let draft = restored.draftTask(project: HarnessPreview.project, folderID: "another")
        XCTAssertEqual(draft.provider, "claude"); XCTAssertEqual(restored.chat(for: draft).effort, "max")
        let other = SavedSession(relay: session.relay, sessionID: session.sessionID, deviceID: "other", token: session.token, secret: session.secret, daemonKey: session.daemonKey, daemonIdentity: session.daemonIdentity)
        let otherStore = try DraftStore(session: other, root: root), otherPreferences = try await otherStore.loadComposerPreferences()
        XCTAssertTrue(otherPreferences.isEmpty)
        await model.useDemo(); XCTAssertTrue(model.composerPreferences.isEmpty)
    }
}

private actor HarnessRelay: RelayServing {
    private(set) var calls: [(String, JSON)] = []
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) -> JSON {
        calls.append((method, params))
        if method == "thread.start" { return .object(["thread": Demo.tasks[0].raw.setting("provider", params["provider"]).setting("id", .string("created"))]) }
        return .object(["ok": .bool(true)])
    }
    func waitForHydration() async { while !calls.contains(where: { $0.0 == "provider.hydrate" }) { await Task.yield() } }
}
