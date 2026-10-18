import XCTest
import Observation
@testable import FalconDeckNative

@MainActor final class ModelCatalogTests: XCTestCase {
    private var emptyProject: Project {
        Project(Demo.projects[0].raw.setting("agents", .array(Demo.projects[0].raw["agents"].array.map { $0.setting("models", .array([])) })))
    }
    private func workspaceUpdate(_ model: AppModel) {
        model.receive(.init(connectionID: model.connectionID, event: .events([.object(["seq": .number(1), "event": .object(["type": .string("workspace-updated"), "workspace": Demo.projects[0].raw])])])))
    }
    func testNewAndExistingComposersHydrateAndShareThePendingRead() async {
        for draft in [false, true] {
            let relay = ModelRelay(), model = AppModel.testing(relay: relay)
            model.connected = true; model.projects = [emptyProject]
            let task = draft ? model.draftTask(project: emptyProject, folderID: nil) : Demo.tasks[0]
            let first = Task { await model.loadModels(task, timeout: .seconds(2)) }
            await relay.waitForRequests(1)
            let second = Task { await model.loadModels(task, timeout: .seconds(2)) }
            await Task.yield()
            XCTAssertTrue(model.catalog(task).modelsLoading, "The RPC acknowledgement is not the model catalog")
            workspaceUpdate(model)
            await first.value; await second.value
            XCTAssertFalse(model.catalog(task).modelsLoading)
            XCTAssertNil(model.catalog(task).modelsError)
            XCTAssertFalse(model.projects[0].models(for: task.provider).isEmpty)
            let calls = await relay.calls
            XCTAssertEqual(calls.count, 1)
            XCTAssertEqual(calls.first?["provider"].string, task.provider)
        }
    }
    func testReconnectPlaceholderDoesNotFinishTheModelRequest() async {
        let relay = ModelRelay(), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = [emptyProject]
        let task = Demo.tasks[0], catalog = model.catalog(Demo.tasks[0])
        let load = Task { await model.loadModels(task, timeout: .seconds(2)) }
        await relay.waitForRequests(1)
        model.projects = [Project(emptyProject.raw.setting("agents", .array(emptyProject.raw["agents"].array.map {
            $0.setting("models_loading", .bool(true))
        })))]
        model.projects = [Project(emptyProject.raw.setting("status", .string("connecting")).setting("agents", .array(emptyProject.raw["agents"].array.map {
            $0.setting("models_loading", .bool(false)).setting("account", .object(["status": .string("unknown"), "label": .string("Codex reconnecting")]))
        })))]
        // Publish after the polling loop has had a chance to see the intermediate
        // workspace placeholder, as happens while a lazy provider boots.
        try? await Task.sleep(for: .milliseconds(450))
        let stillLoading = catalog.modelsLoading, error = catalog.modelsError
        workspaceUpdate(model); await load.value
        XCTAssertTrue(stillLoading, "A reconnect placeholder is not a finished empty catalog")
        XCTAssertNil(error)
        XCTAssertNil(catalog.modelsError)
    }
    func testLiveCatalogClearsErrorsWithoutAnotherPickerRequest() async {
        let model = AppModel.testing(relay: ModelRelay())
        model.connected = true; model.projects = [emptyProject]
        await model.loadModels(Demo.tasks[0], timeout: .milliseconds(20))
        XCTAssertNotNil(model.catalog(Demo.tasks[0]).modelsError)
        workspaceUpdate(model)
        XCTAssertNil(model.catalog(Demo.tasks[0]).modelsError, "Late authoritative metadata must recover an already open picker")
    }
    func testCatalogUpdateInvalidatesAnObservedPicker() {
        let model = AppModel.testing(relay: ModelRelay())
        model.projects = [emptyProject]
        let changed = expectation(description: "Model picker observed workspace metadata")
        withObservationTracking { _ = model.effectiveModels(projectID: emptyProject.id, provider: "codex") } onChange: { changed.fulfill() }
        workspaceUpdate(model)
        wait(for: [changed], timeout: 1)
    }
    func testFastEmptyHydrationDoesNotWaitForTheFullTimeout() async {
        let relay = ModelRelay(), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = [emptyProject]
        let load = Task { await model.loadModels(Demo.tasks[0], timeout: .seconds(2)) }
        await relay.waitForRequests(1)
        let loading = emptyProject.raw.setting("agents", .array(emptyProject.raw["agents"].array.map { $0.setting("models_loading", .bool(true)) }))
        model.projects = [Project(loading)]
        model.projects = [emptyProject]
        await load.value
        XCTAssertNotNil(model.catalog(Demo.tasks[0]).modelsError)
        XCTAssertFalse(model.catalog(Demo.tasks[0]).modelsError!.contains("too long"))
    }
    func testFailedHydrationCanBeRetried() async {
        let relay = ModelRelay(failFirst: true), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = [emptyProject]
        let task = Demo.tasks[0]
        await model.loadModels(task)
        XCTAssertNotNil(model.catalog(task).modelsError)
        let retry = Task { await model.loadModels(task, force: true, timeout: .seconds(2)) }
        await relay.waitForRequests(2); workspaceUpdate(model); await retry.value
        XCTAssertNil(model.catalog(task).modelsError)
    }
    func testMissingCatalogHasABoundedLoadingState() async {
        let model = AppModel.testing(relay: ModelRelay())
        model.connected = true; model.projects = [emptyProject]
        await model.loadModels(Demo.tasks[0], timeout: .milliseconds(20))
        XCTAssertFalse(model.catalog(Demo.tasks[0]).modelsLoading)
        XCTAssertTrue(model.catalog(Demo.tasks[0]).modelsError?.contains("too long") == true)
    }
    func testOldHydrationCannotChangeTheNewConnection() async {
        let relay = ModelRelay(), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = [emptyProject]
        let task = Demo.tasks[0], oldCatalog = model.catalog(Demo.tasks[0])
        let load = Task { await model.loadModels(task, timeout: .seconds(2)) }
        await relay.waitForRequests(1)
        await model.useDemo(); await load.value
        XCTAssertFalse(oldCatalog === model.catalog(task))
        XCTAssertNil(model.catalog(task).modelsError)
        XCTAssertFalse(model.catalog(task).modelsLoading)
    }
    func testReconnectingMakesAFailedPickerEligibleToLoadAgain() async {
        let relay = ModelRelay(failFirst: true), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = [emptyProject]
        let task = Demo.tasks[0]
        await model.loadModels(task)
        XCTAssertNotNil(model.catalog(task).modelsError)
        model.receive(.init(connectionID: model.connectionID, event: .status("Computer offline", connected: false)))
        model.receive(.init(connectionID: model.connectionID, event: .status("Connected", connected: true)))
        let retry = Task { await model.loadModels(task, timeout: .seconds(2)) }
        await relay.waitForRequests(2); workspaceUpdate(model); await retry.value
        XCTAssertNil(model.catalog(task).modelsError)
    }
    func testRetryReadsFreshMetadataBeforeWarmingTheProviderAgain() async {
        let relay = ModelRelay(), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = [emptyProject]
        let retry = Task { await model.loadModels(Demo.tasks[0], force: true, timeout: .seconds(2)) }
        await relay.waitForRequests(1); workspaceUpdate(model); await retry.value
        let refreshes = await relay.refreshes
        XCTAssertEqual(refreshes, 1)
    }
    func testConcurrentRetriesShareHydrationAndAnAsynchronousRefresh() async {
        let relay = ModelRelay(), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = [emptyProject]
        // A coalesced relay refresh may return before its snapshot is delivered.
        await relay.setRefreshAction { [weak model] in
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                model?.projects = Demo.projects
            }
        }
        let first = Task { await model.loadModels(Demo.tasks[0], force: true, timeout: .seconds(2)) }
        await relay.waitForRequests(1)
        let second = Task { await model.loadModels(Demo.tasks[0], force: true, timeout: .seconds(2)) }
        await first.value; await second.value
        let calls = await relay.calls, refreshes = await relay.refreshes
        XCTAssertEqual(refreshes, 1); XCTAssertEqual(calls.count, 1)
        XCTAssertFalse(model.projects[0].models(for: "codex").isEmpty)
        XCTAssertNil(model.catalog(Demo.tasks[0]).modelsError)
    }
    func testExistingLiveCatalogDoesNotNeedAnotherHydration() async {
        let relay = ModelRelay(), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = Demo.projects
        await model.loadModels(Demo.tasks[0])
        let calls = await relay.calls
        XCTAssertTrue(calls.isEmpty)
    }
    func testModelAndReasoningChoicesReachBothFirstAndExistingTurns() async throws {
        for draft in [false, true] {
            let relay = ModelRelay(), model = AppModel.testing(relay: relay)
            model.connected = true; model.projects = Demo.projects; model.tasks = Demo.tasks
            let task = draft ? model.draftTask(project: Demo.projects[0], folderID: nil) : Demo.tasks[0]
            let chat = model.chat(for: task)
            chat.modelID = "demo-model"; chat.effort = "high"; chat.draft = "Use my chosen settings"
            await model.send(task)
            let turns = await relay.turns
            let turn = try XCTUnwrap(turns.first)
            XCTAssertEqual(turn["model_id"].string, "demo-model")
            XCTAssertEqual(turn["reasoning_effort"].string, "high")
        }
    }
    func testVersionedClaudeModelsKeepTheirReasoningMetadata() {
        let project = Project(.object(["agents": .array([.object(["provider": .string("claude"), "models": .array([.object(["id": .string("opus"), "default_reasoning_effort": .string("high")])])])])]))
        let resolved = project.resolvedModel(for: "claude", id: "claude-opus-4-6-20260101")
        XCTAssertEqual(resolved?.label, "Opus 4.6")
        XCTAssertEqual(resolved?.efforts, ["high"])
        XCTAssertEqual(resolved?.id, "claude-opus-4-6-20260101")
        XCTAssertTrue(project.resolvedModel(for: "claude", id: "unknown-model")?.efforts.isEmpty == true)
    }
    func testACatalogThatBecomesEmptyCanBeHydratedAgain() async {
        let relay = ModelRelay(), model = AppModel.testing(relay: relay)
        model.connected = true; model.projects = [emptyProject]
        let task = Demo.tasks[0]
        let first = Task { await model.loadModels(task, timeout: .seconds(2)) }
        await relay.waitForRequests(1); workspaceUpdate(model); await first.value
        model.projects = [emptyProject]
        await model.loadModels(task, timeout: .milliseconds(20))
        let calls = await relay.calls
        XCTAssertEqual(calls.count, 2, "A provider restart can empty a previously hydrated live catalog")
    }
    func testALateLiveCatalogClearsTheEarlierLoadingError() async {
        let model = AppModel.testing(relay: ModelRelay())
        model.connected = true; model.projects = [emptyProject]
        let task = Demo.tasks[0]
        await model.loadModels(task, timeout: .milliseconds(20))
        XCTAssertNotNil(model.catalog(task).modelsError)
        workspaceUpdate(model)
        await model.loadModels(task)
        XCTAssertNil(model.catalog(task).modelsError)
    }
    func testLegacyWorkspaceCatalogIsUsedWhenTheAgentOmitsItsModels() {
        let model = JSON.object(["id": .string("chosen"), "label": .string("Chosen model")])
        let project = Project(.object(["id": .string("project"), "default_provider": .string("codex"), "agents": .array([.object(["provider": .string("codex")])]), "models": .array([model])]))
        XCTAssertEqual(project.models(for: "codex").map(\.id), ["chosen"])
        XCTAssertTrue(project.models(for: "claude").isEmpty)
    }
    func testReasoningUsesTheAdvertisedDefaultWhenNoEffortListIsProvided() {
        let model = AgentModel(raw: .object(["id": .string("model"), "default_reasoning_effort": .string("high")]))
        XCTAssertEqual(model.efforts, ["high"])
        XCTAssertTrue(AgentModel(raw: .object(["id": .string("no-reasoning")])).efforts.isEmpty)
    }
}

private actor ModelRelay: RelayServing {
    private(set) var calls: [JSON] = []
    private(set) var turns: [JSON] = []
    private(set) var refreshes = 0
    private var refreshAction: (@MainActor @Sendable () -> Void)?
    let failFirst: Bool
    init(failFirst: Bool = false) { self.failFirst = failFirst }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func setRefreshAction(_ action: @escaping @MainActor @Sendable () -> Void) { refreshAction = action }
    func refresh() async { refreshes += 1; await refreshAction?() }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) throws -> JSON {
        if method == "turn.start" { turns.append(params) }
        if method == "thread.start" { return .object(["thread": Demo.tasks[0].raw.setting("id", .string("created"))]) }
        if method == "provider.hydrate" {
            calls.append(params)
            if failFirst, calls.count == 1 { throw PilotError("Catalog unavailable") }
        }
        return .object(["ok": .bool(true)])
    }
    func waitForRequests(_ count: Int) async { while calls.count < count { await Task.yield() } }
}
