import AppIntents
import XCTest
@testable import FalconDeckNative

@MainActor final class NativeShortcutTests: XCTestCase {
    private func demo() -> AppModel {
        let model = AppModel.testing(relay: UnavailablePreviewRelay())
        model.demo = true; model.projects = Demo.projects; model.restoringSession = false
        return model
    }
    private func fixture() throws -> (AppModel, SavedSession, URL) {
        let root = FileManager.default.temporaryDirectory.appending(path: "ShortcutTests-\(UUID())")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let suite = "ShortcutTests-\(UUID())", defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let model = AppModel(relay: UnavailablePreviewRelay(), voice: VoiceRecorder(defaults: defaults), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { session }, sessionCacheRoot: root.appending(path: "cache"), inputDraftRoot: root.appending(path: "input"))
        return (model, session, root)
    }
    func testNewThreadProjectSwitchKeepsIndependentInputAttachmentsAndHarnessSettings() {
        let model = demo(), first = Demo.projects[0], second = Demo.projects[1]
        model.selection = .draft(first.id, "folder")
        let original = model.chat(for: model.draftTask(project: first, folderID: "folder"))
        original.draft = "Keep this prompt"; original.modelID = "first-model"; original.effort = "high"
        original.attachments = [NativeAttachment(id: "image", name: "Image.jpg", mimeType: "image/jpeg", data: Data([1]))]
        model.selectDraftProject(first.id)
        XCTAssertEqual(model.selection, .draft(first.id, "folder"))
        model.selectDraftProject(second.id)
        let other = model.chat(for: model.draftTask(project: second, folderID: nil))
        XCTAssertTrue(other.draft.isEmpty); XCTAssertTrue(other.attachments.isEmpty)
        other.draft = "Other project"; other.modelID = "second-model"
        model.selectDraftProject(first.id)
        XCTAssertEqual(original.draft, "Keep this prompt"); XCTAssertEqual(original.attachments.count, 1)
        XCTAssertEqual(original.modelID, "first-model"); XCTAssertEqual(other.draft, "Other project")
        // Folder input remains in its folder, rather than overwriting root input.
        XCTAssertEqual(model.selection, .draft(first.id, nil))
        XCTAssertTrue(model.chat(for: model.draftTask(project: first, folderID: nil)).draft.isEmpty)
    }
    func testAnExistingThreadCannotBeMovedByTheNewDraftPicker() {
        let model = demo(); model.selection = .task("existing")
        model.selectDraftProject(Demo.projects[1].id)
        XCTAssertEqual(model.selection, .task("existing"))
    }
    func testActualNewTaskIntentAppendsPromptWithoutSendingOrOverwritingTheDraft() async throws {
        let model = demo(), project = Demo.projects[0]
        let chat = model.chat(for: model.draftTask(project: project, folderID: nil)); chat.draft = "Existing draft"
        let context = NativeIntentContext(model: model)
        let intent = NewNativeTaskIntent()
        intent.context = context; intent.project = NativeProjectEntity(project: project, pairing: NativeIntentContext.demoPairing)
        intent.prompt = "  Added from Shortcuts  "
        _ = try await intent.perform()
        XCTAssertEqual(chat.draft, "Existing draft\n\nAdded from Shortcuts")
        XCTAssertEqual(model.selection, .draft(project.id, nil)); XCTAssertTrue(model.tasks.isEmpty)
        XCTAssertNil(chat.submission); XCTAssertFalse(chat.sending)
    }
    func testOpenProjectAndActivityIntentsRevealEvenAnUnchangedSelection() async throws {
        let model = demo(), project = Demo.projects[0]
        let open = OpenNativeProjectIntent(); open.context = NativeIntentContext(model: model)
        open.project = NativeProjectEntity(project: project, pairing: NativeIntentContext.demoPairing)
        model.selection = .draft(project.id, nil)
        let before = model.detailRequestID
        _ = try await open.perform()
        XCTAssertNotEqual(model.detailRequestID, before)
        XCTAssertEqual(model.selection, .draft(project.id, nil))
        let activity = OpenNativeActivityIntent(); activity.context = NativeIntentContext(model: model)
        _ = try await activity.perform()
        XCTAssertEqual(model.selection, .activity)
    }
    func testColdIntentWaitsForInputRecoveryAndWinsOverTheSavedNavigation() async throws {
        let (model, session, root) = try fixture(), project = Demo.projects[0]
        let store = try DraftStore(session: session, root: root.appending(path: "input"))
        try await store.save(SavedDraft(id: "draft:falcondeck:root", text: "Recovered draft", attachments: [], modelID: "", effort: "", provider: "codex", overrides: [:]))
        try await store.saveSelection(.task("old-selection"))
        let cache = try SessionCacheStore(session: session, root: root.appending(path: "cache"))
        try await cache.save(SessionCacheInput(projects: [project.raw], tasks: [], preferences: .object([:]), selectedID: nil, histories: [:]))
        let context = NativeIntentContext(model: model)
        let entities = try await context.projects(), entity = try XCTUnwrap(entities.first)
        try await context.open(.newTask(projectID: entity.projectID, prompt: "New prompt"), project: entity)
        XCTAssertEqual(model.pendingShortcuts.count, 1); XCTAssertTrue(model.chats.isEmpty)
        model.hasSession = true
        await model.restoreInputs(session: session); await model.restorePreview(session: session)
        model.restoringSession = false; model.applyPendingShortcut()
        XCTAssertTrue(model.pendingShortcuts.isEmpty); XCTAssertNil(model.pendingSelection)
        XCTAssertEqual(model.selection, .draft(project.id, nil))
        XCTAssertEqual(model.chat(for: model.draftTask(project: project, folderID: nil)).draft, "Recovered draft\n\nNew prompt")
    }
    func testColdShortcutsKeepEveryPromptWhenActivityOpensAfterThem() async throws {
        let model = demo(), project = Demo.projects[0]
        model.restoringSession = true
        let context = NativeIntentContext(model: model)
        let entity = NativeProjectEntity(project: project, pairing: NativeIntentContext.demoPairing)
        try await context.open(.newTask(projectID: project.id, prompt: "First prompt"), project: entity)
        try await context.open(.newTask(projectID: project.id, prompt: "Second prompt"), project: entity)
        try await context.open(.activity)
        XCTAssertEqual(model.pendingShortcuts.count, 3); XCTAssertTrue(model.chats.isEmpty)
        model.restoringSession = false; model.applyPendingShortcut()
        XCTAssertEqual(model.selection, .activity)
        XCTAssertEqual(model.chat(for: model.draftTask(project: project, folderID: nil)).draft, "First prompt\n\nSecond prompt")
        XCTAssertTrue(model.pendingShortcuts.isEmpty); XCTAssertTrue(model.tasks.isEmpty)
        model.applyPendingShortcut()
        XCTAssertEqual(model.chat(for: model.draftTask(project: project, folderID: nil)).draft, "First prompt\n\nSecond prompt")
    }
    func testTooManyColdShortcutsFailExplicitlyWithoutReplacingAcceptedRequests() async throws {
        let model = demo(); model.restoringSession = true
        let context = NativeIntentContext(model: model)
        try await context.open(.newTask(projectID: Demo.projects[0].id, prompt: "Keep this"))
        for _ in 0..<15 { try await context.open(.activity) }
        do { try await context.open(.activity); XCTFail("Expected an explicit queue limit") } catch { }
        XCTAssertEqual(model.pendingShortcuts.count, 16)
        model.restoringSession = false; model.applyPendingShortcut()
        XCTAssertEqual(model.chat(for: model.draftTask(project: Demo.projects[0], folderID: nil)).draft, "Keep this")
    }
    func testProjectQueriesUseTheCurrentPairingAndLiveCatalog() async throws {
        let model = demo()
        let query = NativeProjectQuery(); query.context = NativeIntentContext(model: model)
        let original = try await query.suggestedEntities()
        let entity = try XCTUnwrap(original.first { $0.projectID == "falcondeck" })
        let wrong = NativeProjectEntity(project: Demo.projects[0], pairing: String(repeating: "a", count: 64))
        let stale = try await query.entities(for: [wrong.id]); XCTAssertTrue(stale.isEmpty)
        do { try await query.context.open(.newTask(projectID: wrong.projectID, prompt: "Wrong computer"), project: wrong); XCTFail("Expected pairing rejection") } catch { }
        model.projects = model.projects.map { $0.id == "falcondeck" ? Project($0.raw.setting("path", .string("/Projects/Renamed project"))) : $0 }
        let refreshed = try await query.entities(for: [entity.id])
        XCTAssertEqual(refreshed.first?.name, "Renamed project")
        let found = try await query.entities(matching: "Renamed")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(refreshed.first?.pairing, NativeIntentContext.demoPairing)
    }
    func testPendingSubmissionAndOversizedShortcutCannotOverwriteInput() async throws {
        let model = demo(), project = Demo.projects[0]
        let ownContext = NativeIntentContext(model: model)
        let entity = NativeProjectEntity(project: project, pairing: NativeIntentContext.demoPairing)
        let chat = model.chat(for: model.draftTask(project: project, folderID: nil)); chat.draft = "Pending input"
        chat.submission = SavedSubmission(id: "pending", text: chat.draft, attachments: [])
        try await ownContext.open(.newTask(projectID: project.id, prompt: "More"), project: entity)
        XCTAssertEqual(chat.draft, "Pending input"); XCTAssertNotNil(chat.submission)
        do { try await ownContext.open(.newTask(projectID: nil, prompt: String(repeating: "a", count: 65537))); XCTFail("Expected prompt limit") } catch { }
    }
    func testQueriesPreferLiveSnapshotArrivingDuringCacheReadIncludingAnEmptyWorkspace() async throws {
        for empty in [false, true] {
            let (model, _, _) = try fixture()
            let gate = HeldProjectCache()
            let context = NativeIntentContext(model: model, cacheLoader: { _, _ in await gate.load() })
            let request = Task { try await context.projects() }
            await gate.waitForRead()
            model.projects = empty ? [] : [Demo.projects[1]]; model.hasLiveSnapshot = true
            await gate.finish([Demo.projects[0]])
            let result = try await request.value
            XCTAssertEqual(result.map(\.projectID), model.projects.map(\.id))
            let next = try await context.projects()
            XCTAssertEqual(next.map(\.projectID), model.projects.map(\.id))
        }
    }
}

private actor HeldProjectCache {
    private var pending: CheckedContinuation<[Project], Never>?
    private var ready: CheckedContinuation<Void, Never>?
    func load() async -> [Project] {
        await withCheckedContinuation { pending = $0; ready?.resume(); ready = nil }
    }
    func waitForRead() async { if pending == nil { await withCheckedContinuation { ready = $0 } } }
    func finish(_ projects: [Project]) { pending?.resume(returning: projects); pending = nil }
}
