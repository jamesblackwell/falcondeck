import Foundation
import Observation
import XCTest
@testable import FalconDeckMac

private actor IntegrationDaemon: DaemonServing {
    struct Request: Sendable {
        let path: [String]
        let method: String
        let query: [URLQueryItem]
        let body: JSON?
    }

    private(set) var requests: [Request] = []
    private var suspendedPreferenceRead: CheckedContinuation<JSON, Error>?
    private var preferenceReadWaiter: CheckedContinuation<Void, Never>?
    private var suspendPreferences = false
    private var chatWorkspace: JSON = .null
    private var detailThreads: [String: JSON] = [:]

    func snapshot() async throws -> JSON { integrationSnapshot() }
    func events() async throws -> AsyncThrowingStream<JSON, Error> { AsyncThrowingStream { $0.finish() } }
    func disconnect() async {}
    func connectProject(path: String) async throws -> Project { Project(integrationProject("local", path: path)) }
    func startThread(projectID: String, provider: String?, modelID: String?) async throws -> AgentTask {
        AgentTask(integrationTask("created", project: projectID))
    }
    func threadDetail(projectID: String, threadID: String, before: String?) async throws -> JSON {
        .object([
            "thread": detailThreads[threadID] ?? integrationTask(threadID, project: projectID),
            "items": .array([.object(["id": .string("message"), "kind": .string("assistant_message"), "text": .string("Local history")])]),
            "has_older": .bool(false)
        ])
    }
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String?) async throws -> JSON { .null }
    func interrupt(projectID: String, threadID: String) async throws {}
    func respond(projectID: String, requestID: String, response: JSON) async throws {}
    func markRead(projectID: String, threadID: String, readSeq: Int) async throws {}

    func requestJSON(_ path: [String], method: String, query: [URLQueryItem], body: JSON?) async throws -> JSON {
        requests.append(.init(path: path, method: method, query: query, body: body))
        if path == ["api", "chats"], method == "POST" { return chatWorkspace }
        if path == ["api", "preferences"], method == "GET", suspendPreferences {
            return try await withCheckedThrowingContinuation { continuation in
                suspendedPreferenceRead = continuation
                preferenceReadWaiter?.resume()
                preferenceReadWaiter = nil
            }
        }
        return .object([:])
    }

    func suspendPreferenceReads() { suspendPreferences = true }
    func setChatWorkspace(_ workspace: JSON) { chatWorkspace = workspace }
    func setDetailThread(_ thread: JSON) { detailThreads[thread["id"].string] = thread }
    func waitForPreferenceRead() async {
        if suspendedPreferenceRead != nil { return }
        await withCheckedContinuation { preferenceReadWaiter = $0 }
    }
    func finishPreferenceRead(_ value: JSON) {
        suspendedPreferenceRead?.resume(returning: value)
        suspendedPreferenceRead = nil
    }
}

private actor IntegrationRefreshTransport: NativeRemoteTransport {
    private var sink: AsyncStream<NativeRelayUpdate>.Continuation?
    private var connectionID = UUID()
    let initialSnapshot: JSON
    init(initialSnapshot: JSON) { self.initialSnapshot = initialSnapshot }
    func events() -> AsyncStream<NativeRelayUpdate> {
        AsyncStream { sink = $0 }
    }
    func pair(_ input: NativePairingInput, connectionID: UUID) {
        self.connectionID = connectionID
        emit(.snapshot(initialSnapshot))
    }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func selectThread(_ id: String?) { }
    func setForeground(_ active: Bool) { }
    func call(_ method: String, params: JSON) -> JSON { .null }
    func emit(_ event: NativeRelayEvent) { sink?.yield(.init(connectionID: connectionID, event: event)) }
}

private func integrationProject(_ id: String, kind: String = "project", path: String? = nil) -> JSON {
    .object([
        "id": .string(id), "kind": .string(kind), "path": .string(path ?? "/tmp/\(id)"),
        "default_provider": .string("codex")
    ])
}

private func integrationTask(_ id: String, project: String = "local") -> JSON {
    .object([
        "id": .string(id), "workspace_id": .string(project), "title": .string(id),
        "provider": .string("codex"), "status": .string("idle"), "updated_at": .string("2026-10-20T08:00:00Z")
    ])
}

private func integrationSnapshot(projects: [JSON] = [integrationProject("local")],
                                 tasks: [JSON] = [integrationTask("task")],
                                 preferences: JSON = .object(["theme": .string("local-theme")])) -> JSON {
    .object([
        "workspaces": .array(projects), "threads": .array(tasks),
        "interactive_requests": .array([]), "preferences": preferences
    ])
}

private func integrationEnvelope(_ event: JSON) -> JSON { .object(["event": event]) }
private func integrationSnapshotEnvelope(_ value: JSON) -> JSON {
    integrationEnvelope(.object(["type": .string("snapshot"), "snapshot": value]))
}

private final class IntegrationObservationChanges: @unchecked Sendable {
    var count = 0
}

final class NativeStoreIntegrationTests: XCTestCase {
    @MainActor func testLocalThreadPatchUsesPathScopeAndPreservesExplicitNull() async throws {
        let daemon = IntegrationDaemon(), store = AppStore(client: daemon)
        let patch: JSON = .object([
            "workspace_id": .string("wrong-workspace"), "thread_id": .string("wrong-thread"),
            "model_id": .null, "permission_mode": .null, "title": .string("Updated title")
        ])
        _ = try await store.request(["api", "workspaces", "project/a", "threads", "thread?#"], method: "PATCH", body: patch)

        let requests = await daemon.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, ["api", "workspaces", "project/a", "threads", "thread?#"])
        XCTAssertEqual(request.method, "PATCH")
        XCTAssertEqual(request.body?["workspace_id"], .string("project/a"))
        XCTAssertEqual(request.body?["thread_id"], .string("thread?#"))
        XCTAssertEqual(request.body?.fields["model_id"], .null)
        XCTAssertEqual(request.body?.fields["permission_mode"], .null)
        XCTAssertNil(request.body?.fields["sandbox_mode"], "An omitted setting must remain omitted")
        XCTAssertEqual(request.body?["title"], .string("Updated title"))
    }

    @MainActor func testStringAPIPathDecodesIDsWithoutLosingQueryValues() async throws {
        let daemon = IntegrationDaemon(), store = AppStore(client: daemon)
        _ = try await store.request("/api/workspaces/project%2Fa/threads/thread%3F%23?before_item_id=item%26x%3D1&inline_images=false")

        let requests = await daemon.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, ["api", "workspaces", "project/a", "threads", "thread?#"])
        XCTAssertEqual(request.query.first { $0.name == "before_item_id" }?.value, "item&x=1")
        XCTAssertEqual(request.query.first { $0.name == "inline_images" }?.value, "false")
    }

    @MainActor func testThreadSettingsMutationReceivesRequiredScopeWithoutDroppingInheritedValues() async throws {
        let daemon = IntegrationDaemon(), store = AppStore(client: daemon)
        let task = AgentTask(integrationTask("settings-task", project: "settings-project"))
        try await store.updateTask(task, patch: .object([
            "model_id": .null, "permission_mode": .string("accept_edits"), "collaboration_mode_id": .null
        ]))

        let requests = await daemon.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, ["api", "workspaces", "settings-project", "threads", "settings-task"])
        XCTAssertEqual(request.method, "PATCH")
        XCTAssertEqual(request.body?["workspace_id"], .string("settings-project"))
        XCTAssertEqual(request.body?["thread_id"], .string("settings-task"))
        XCTAssertEqual(request.body?.fields["model_id"], .null)
        XCTAssertEqual(request.body?.fields["collaboration_mode_id"], .null)
        XCTAssertEqual(request.body?["permission_mode"], .string("accept_edits"))
    }

    @MainActor func testCrossHostTargetsAreRejectedBeforeTransport() async {
        let daemon = IntegrationDaemon(), store = AppStore(client: daemon)
        let project = NativeHostManager.namespace(hostID: "server-a", id: "project")
        let thread = NativeHostManager.namespace(hostID: "server-b", id: "thread")
        do {
            _ = try await store.request(["api", "workspaces", project, "threads", thread], method: "PATCH", body: .object(["title": .string("No mutation")]))
            XCTFail("An operation must not combine entity IDs from different servers")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("different servers"))
        }
        do {
            _ = try await store.request(["api", "workspaces", project], hostID: "server-b")
            XCTFail("An explicit server must agree with the path's server")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("different servers"))
        }
        let requests = await daemon.requests
        XCTAssertTrue(requests.isEmpty)
    }

    @MainActor func testStreamingDoesNotInvalidateNavigationOrExtensionProjections() async {
        let store = AppStore(client: IntegrationDaemon(), readVisibility: { false })
        store.applyEnvelope(integrationSnapshotEnvelope(integrationSnapshot()))
        await store.selectTask("task")
        store.receiveHost(.init(hostID: "server-a", event: .snapshot(integrationSnapshot())))
        let changes = IntegrationObservationChanges()
        withObservationTracking {
            _ = store.navigationPreferences
            _ = store.extensions
            _ = store.extensionsForHost("server-a")
        } onChange: { changes.count += 1 }

        let text: JSON = .object([
            "thread_id": .string("task"), "event": .object([
                "type": .string("text"), "item_id": .string("message"), "delta": .string("!")
            ])
        ])
        store.receiveHost(.init(hostID: "server-a", event: .events([text])))
        store.applyEnvelope(text)

        XCTAssertEqual(changes.count, 0, "Text envelopes must update the transcript without rebuilding unrelated sidebar projections")
        XCTAssertEqual(store.messages.first?.text, "Local history!")
    }

    @MainActor func testRemoteMetadataEventsRefreshAndRemovalRetractsObservedProjections() {
        let store = AppStore(client: IntegrationDaemon())
        store.applyEnvelope(integrationSnapshotEnvelope(integrationSnapshot()))
        let remote = integrationSnapshot().setting("extensions", .object(["views": .array([])]))
        store.receiveHost(.init(hostID: "server-a", event: .snapshot(remote)))
        let navigationChanges = IntegrationObservationChanges(), extensionChanges = IntegrationObservationChanges()
        withObservationTracking { _ = store.navigationPreferences } onChange: { navigationChanges.count += 1 }
        withObservationTracking { _ = store.extensionsForHost("server-a") } onChange: { extensionChanges.count += 1 }
        let remotePreferences: JSON = .object([
            "workspace_colors": .object(["local": .string("blue")]),
            "project_folders": .array([.object(["id": .string("folder"), "workspace_id": .string("local"), "thread_ids": .array([.string("task")])])])
        ])
        store.receiveHost(.init(hostID: "server-a", event: .events([
            integrationEnvelope(.object(["type": .string("preferences-updated"), "preferences": remotePreferences])),
            integrationEnvelope(.object(["type": .string("extension-view-updated"), "extension_id": .string("notes"), "view_id": .string("panel"), "scope": .object(["kind": .string("thread"), "id": .string("task")]), "view": .object(["extension_id": .string("notes"), "view_id": .string("panel"), "scope": .object(["kind": .string("thread"), "id": .string("task")])])]))
        ])))

        XCTAssertEqual(navigationChanges.count, 1)
        XCTAssertEqual(extensionChanges.count, 1)
        XCTAssertEqual(store.navigationPreferences["workspace_colors"]["remote:server-a:local"], .string("blue"))
        XCTAssertEqual(store.navigationPreferences["project_folders"].array.first?["thread_ids"], .array([.string("remote:server-a:task")]))
        XCTAssertEqual(store.extensionsForHost("server-a")["views"].array.first?["scope"]["id"], .string("remote:server-a:task"))
        store.receiveHost(.init(hostID: "server-a", event: .removed))
        XCTAssertEqual(store.extensionsForHost("server-a"), .null)
        XCTAssertEqual(store.navigationPreferences["workspace_colors"]["remote:server-a:local"], .null)
        XCTAssertTrue(store.navigationPreferences["project_folders"].array.isEmpty)
    }

    @MainActor func testRemoteSnapshotMergesWithoutReplacingLocalPreferencesOrSelection() async {
        let store = AppStore(client: IntegrationDaemon())
        let local = integrationSnapshot()
        store.applyEnvelope(integrationSnapshotEnvelope(local))
        await store.selectTask("task")
        let remote = integrationSnapshot(preferences: .object(["theme": .string("remote-theme")]))

        store.receiveHost(.init(hostID: "server-a", event: .snapshot(remote)))

        XCTAssertEqual(Set(store.allProjects.map(\.id)), ["local", "remote:server-a:local"])
        XCTAssertEqual(Set(store.tasks.map(\.id)), ["task", "remote:server-a:task"])
        XCTAssertEqual(store.preferences["theme"], .string("local-theme"))
        XCTAssertEqual(store.snapshotRaw, local, "The local snapshot must remain local")
        XCTAssertEqual(store.selectedProjectID, "local")
        XCTAssertEqual(store.selectedTaskID, "task")
        XCTAssertEqual(store.messages.first?.text, "Local history")
    }

    @MainActor func testRemoteRefreshRebasesBeforeReconcilingSelectedThreadAndDraft() async throws {
        let suite = "NativeStoreIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let initial = integrationSnapshot(tasks: [integrationTask("a")])
        let transport = IntegrationRefreshTransport(initialSnapshot: initial)
        let manager = NativeHostManager(defaults: defaults, factory: { _ in transport })
        let store = AppStore(client: IntegrationDaemon())
        store.applyEnvelope(integrationSnapshotEnvelope(integrationSnapshot(projects: [], tasks: [])))
        var updates = manager.events().makeAsyncIterator()
        let code = "ABC." + Data(repeating: 7, count: 32).base64EncodedString()
        let host = try await manager.addHost(name: "Server", pairingText: code)
        while let update = await updates.next() {
            store.receiveHost(update)
            if case .snapshot = update.event { break }
        }
        let thread = integrationTask("b").setting("updated_at", .string("2026-10-20T08:00:01Z"))
        let started = JSON.object(["workspace_id": .string("local"), "thread_id": .string("b"), "event": .object(["type": .string("thread-started"), "thread": thread])])
        await transport.emit(.events([started]))
        let liveStart = await updates.next()
        store.receiveHost(try XCTUnwrap(liveStart))
        let selected = NativeHostManager.namespace(hostID: host, id: "b")
        // Selecting is independent of the detail request: this fixture has no
        // registered relay, so its history read fails while selection remains.
        await store.selectTask(selected)
        store.draft = "Unsent reply for b"
        store.setComposerPayload(.object(["model_id": .string("chosen-model")]), key: selected)
        let text = JSON.object(["workspace_id": .string("local"), "thread_id": .string("b"), "event": .object(["type": .string("text"), "item_id": .string("assistant-b"), "delta": .string("Live text")])])
        await transport.emit(.events([text]))
        let liveText = await updates.next()
        store.receiveHost(try XCTUnwrap(liveText))

        // The RPC was captured before b was created, while both envelopes have
        // already reached the UI. The delivery boundary must publish them once.
        await transport.emit(.snapshot(initial, rebase: [started, text]))
        let refreshed = await updates.next()
        store.receiveHost(try XCTUnwrap(refreshed))
        XCTAssertEqual(store.selectedTaskID, selected)
        XCTAssertEqual(store.selectedProjectID, NativeHostManager.namespace(hostID: host, id: "local"))
        XCTAssertEqual(store.composerKey, selected)
        XCTAssertEqual(store.draft, "Unsent reply for b")
        XCTAssertEqual(store.composerPayload(key: selected)["model_id"], .string("chosen-model"))
        XCTAssertEqual(store.messages.last?.text, "Live text", "The rebase must not apply transcript text twice")

        // A final authoritative snapshot that truly omits b still removes its
        // selection; only the intermediate stale refresh state is suppressed.
        await transport.emit(.snapshot(initial))
        let authoritative = await updates.next()
        store.receiveHost(try XCTUnwrap(authoritative))
        XCTAssertNil(store.selectedTaskID)
        await manager.setEnabled(hostID: host, enabled: false)
    }

    @MainActor func testRemoteWorkspaceEventCannotLeakIntoLocalIndexesAfterRemoval() async {
        let store = AppStore(client: IntegrationDaemon())
        let local = integrationSnapshot()
        store.applyEnvelope(integrationSnapshotEnvelope(local))
        store.receiveHost(.init(hostID: "server-a", event: .snapshot(integrationSnapshot(projects: [], tasks: []))))
        let event = integrationEnvelope(.object(["type": .string("workspace-updated"), "workspace": integrationProject("new-remote")]))
        store.receiveHost(.init(hostID: "server-a", event: .events([event])))
        XCTAssertTrue(store.projects.contains { $0.id == "remote:server-a:new-remote" })

        store.receiveHost(.init(hostID: "server-a", event: .removed))
        XCTAssertEqual(store.projects.map(\.id), ["local"])
        XCTAssertEqual(store.allProjects.map(\.id), ["local"])
        XCTAssertEqual(store.snapshotRaw, local)

        // Another host rebuild must not resurrect the removed host's event.
        store.receiveHost(.init(hostID: "server-b", event: .snapshot(integrationSnapshot(projects: [], tasks: []))))
        store.receiveHost(.init(hostID: "server-b", event: .removed))
        XCTAssertEqual(store.projects.map(\.id), ["local"])
    }

    @MainActor func testRemoteSnapshotInsideEventBatchRemainsScopedToItsServer() async {
        let store = AppStore(client: IntegrationDaemon())
        let local = integrationSnapshot()
        store.applyEnvelope(integrationSnapshotEnvelope(local))
        await store.selectTask("task")
        store.receiveHost(.init(hostID: "server-a", event: .snapshot(integrationSnapshot(projects: [], tasks: []))))
        let remote = integrationSnapshot(preferences: .object(["theme": .string("remote-theme")]))

        store.receiveHost(.init(hostID: "server-a", event: .events([integrationSnapshotEnvelope(remote)])))

        XCTAssertEqual(store.snapshotRaw, local)
        XCTAssertEqual(store.preferences["theme"], .string("local-theme"))
        XCTAssertEqual(Set(store.allProjects.map(\.id)), ["local", "remote:server-a:local"])
        XCTAssertEqual(Set(store.tasks.map(\.id)), ["task", "remote:server-a:task"])
        XCTAssertEqual(store.selectedProjectID, "local")
        XCTAssertEqual(store.selectedTaskID, "task")
        XCTAssertEqual(store.messages.first?.text, "Local history")
        store.receiveHost(.init(hostID: "server-a", event: .removed))
        XCTAssertEqual(store.projects.map(\.id), ["local"])
        XCTAssertEqual(store.tasks.map(\.id), ["task"])
    }

    @MainActor func testPinsScopeSelectsTaskWithDaemonPinnedFlag() async {
        let daemon = IntegrationDaemon(), store = AppStore(client: daemon)
        let pinned = integrationTask("pinned-task").setting("is_pinned", .bool(true))
        await daemon.setDetailThread(pinned)
        store.applyEnvelope(integrationSnapshotEnvelope(integrationSnapshot(tasks: [integrationTask("task"), pinned])))
        await store.selectTask("task")

        store.selectSection("pins")
        for _ in 0..<1000 {
            if !store.isLoading { break }
            await Task.yield()
        }

        XCTAssertFalse(store.isLoading, "Pinned task history should finish loading")
        XCTAssertEqual(store.selectedSection, "pins")
        XCTAssertEqual(store.selectedProjectID, "local")
        XCTAssertEqual(store.selectedTaskID, "pinned-task")
        XCTAssertEqual(store.selectedTask?.pinned, true)
        XCTAssertEqual(store.messages.first?.text, "Local history")
    }

    @MainActor func testChatsScopeResolvesCasualWorkspaceAndClearsProjectTask() async {
        let store = AppStore(client: IntegrationDaemon())
        let snapshot = integrationSnapshot(projects: [integrationProject("local"), integrationProject("casual", kind: "casual")])
        store.applyEnvelope(integrationSnapshotEnvelope(snapshot))
        await store.selectTask("task")
        store.draft = "Project draft"

        store.selectSection("chats")

        XCTAssertEqual(store.selectedSection, "chats")
        XCTAssertEqual(store.selectedProjectID, "casual")
        XCTAssertEqual(store.selectedProject?.raw["kind"], .string("casual"))
        XCTAssertNil(store.selectedTaskID)
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertEqual(store.draft, "", "Chats must have a draft separate from the selected project task")
        XCTAssertEqual(store.projects.map(\.id), ["local"], "Casual workspaces belong in Chats, outside Projects")
    }

    @MainActor func testNewChatAcceptsBareWorkspaceSummaryAndStartsAnIndependentDraft() async {
        let daemon = IntegrationDaemon(), store = AppStore(client: daemon)
        store.applyEnvelope(integrationSnapshotEnvelope(integrationSnapshot()))
        await store.selectTask("task")
        store.draft = "Project draft"
        // POST /api/chats returns the WorkspaceSummary itself, without a
        // workspace wrapper or a newly created thread.
        await daemon.setChatWorkspace(integrationProject("new-chat", kind: "casual"))

        await store.newChat()

        XCTAssertEqual(store.selectedSection, "chats")
        XCTAssertEqual(store.selectedProjectID, "new-chat")
        XCTAssertEqual(store.selectedProject?.raw["kind"], .string("casual"))
        XCTAssertNil(store.selectedTaskID)
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertEqual(store.draft, "")
        store.draft = "A new casual conversation"
        XCTAssertEqual(store.draft, "A new casual conversation")
        XCTAssertEqual(store.composerKey, "draft:new-chat")
        let requests = await daemon.requests
        XCTAssertEqual(requests.map(\.path), [["api", "chats"]])
        XCTAssertEqual(requests.map(\.method), ["POST"])
    }

    @MainActor func testPreferenceEventArrivingDuringReadCannotBeRewoundByStaleResponse() async throws {
        let daemon = IntegrationDaemon(), store = AppStore(client: daemon)
        store.applyEnvelope(integrationSnapshotEnvelope(integrationSnapshot()))
        await daemon.suspendPreferenceReads()
        let write = Task { try await store.updatePreferences(.object(["theme": .string("requested-theme")])) }
        await daemon.waitForPreferenceRead()

        let latest: JSON = .object(["theme": .string("newer-event-theme"), "notifications_enabled": .bool(true)])
        store.applyEnvelope(integrationEnvelope(.object(["type": .string("preferences-updated"), "preferences": latest])))
        await daemon.finishPreferenceRead(.object(["theme": .string("stale-read-theme")]))
        try await write.value

        XCTAssertEqual(store.preferences, latest)
        XCTAssertEqual(store.snapshotRaw["preferences"], latest)
        // Rebuilding combined indexes also exercises the cached local snapshot.
        store.receiveHost(.init(hostID: "server-a", event: .snapshot(integrationSnapshot(projects: [], tasks: []))))
        store.receiveHost(.init(hostID: "server-a", event: .removed))
        XCTAssertEqual(store.preferences, latest)
        let requests = await daemon.requests
        XCTAssertEqual(requests.map(\.method), ["PATCH", "GET"])
    }
}
