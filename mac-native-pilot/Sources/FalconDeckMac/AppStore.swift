import AppKit
import Foundation
import Observation

protocol DaemonServing: Sendable {
    func snapshot() async throws -> JSON
    func threadDetail(projectID: String, threadID: String, before: String?) async throws -> JSON
    func connectProject(path: String) async throws -> Project
    func startThread(projectID: String, provider: String?, modelID: String?) async throws -> AgentTask
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String?) async throws -> JSON
    func interrupt(projectID: String, threadID: String) async throws
    func respond(projectID: String, requestID: String, response: JSON) async throws
    func markRead(projectID: String, threadID: String, readSeq: Int) async throws
    func events() async throws -> AsyncThrowingStream<JSON, Error>
    func disconnect() async
    func requestJSON(_ path: [String], method: String, query: [URLQueryItem], body: JSON?) async throws -> JSON
}

extension DaemonServing {
    func requestJSON(_ path: [String], method: String, query: [URLQueryItem], body: JSON?) async throws -> JSON {
        throw PilotError("This daemon transport does not support this operation.")
    }
}

extension DaemonClient: DaemonServing {}

@MainActor @Observable final class AppStore {
    var projects: [Project] = []
    var allProjects: [Project] = []
    var tasks: [AgentTask] = []
    var preferences: JSON = .object([:])
    var snapshotRaw: JSON = .null
    var selectedSection = "project"
    var selectedExtensionID: String?
    var selectedPanelID: String?
    var showArchived = false
    var sortOrder = "last_updated"
    var eventRevision = 0
    var terminalCreationRequest: UUID?
    var showInspector = UserDefaults.standard.bool(forKey: "falcondeck.native.inspector") {
        didSet { UserDefaults.standard.set(showInspector, forKey: "falcondeck.native.inspector") }
    }
    var showTerminal = UserDefaults.standard.bool(forKey: "falcondeck.native.terminal") {
        didSet { UserDefaults.standard.set(showTerminal, forKey: "falcondeck.native.terminal") }
    }
    private(set) var selectedProjectID: String?
    private(set) var selectedTaskID: String?
    private(set) var transcript = Transcript()
    private(set) var isConnected = false
    private(set) var isLoading = false
    private(set) var isSending = false
    private(set) var isLoadingOlder = false
    private(set) var hasOlder = false
    private(set) var connectionStatus = "Connecting…"
    var errorMessage: String?
    var searchText = ""
    var provider = "codex"
    private var drafts: [String: String] = [:]
    private var composerPayloads: [String: JSON] = [:]
    private var inputSubmissions: [String: NativePendingSubmission] = [:]
    private var inputRevision: UInt64 = 0
    @ObservationIgnored private var inputWriteTask: Task<Void, Never>?
    @ObservationIgnored private var didLoadInputs = false
    private var requests: [JSON] = []
    @ObservationIgnored private let client: any DaemonServing
    @ObservationIgnored private let inputStore: NativeInputStore?
    @ObservationIgnored private var connectionTask: Task<Void, Never>?
    @ObservationIgnored private var loadID = UUID()
    @ObservationIgnored private var connectionID = UUID()
    @ObservationIgnored private var bufferedEvents: [JSON] = []
    @ObservationIgnored private var bufferedOverflow = false
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?
    @ObservationIgnored private var hostTask: Task<Void, Never>?
    @ObservationIgnored private var localSnapshot: JSON = .null
    private var remoteSnapshots: [String: JSON] = [:]
    private var remoteStatuses: [String: NativeHostStatus] = [:]
    @ObservationIgnored private var preferenceRevision: [String: UInt64] = [:]
    @ObservationIgnored private var preferenceWrites: [String: Task<Void, Error>] = [:]
    @ObservationIgnored private var lastReadSequences: [String: Int] = [:]
    private struct Navigation: Equatable {
        var section: String
        var project: String?
        var task: String?
    }
    @ObservationIgnored private var navigationHistory: [Navigation] = []
    @ObservationIgnored private var navigationIndex = -1
    @ObservationIgnored private var restoringNavigation = false
    var selectedHostID: String? { selectedProjectID.flatMap { NativeHostManager.split($0).hostID } }
    var isSelectedHostConnected: Bool {
        guard let host = selectedHostID else { return isConnected }
        return remoteStatuses[host] == .connected
    }

    init(client: any DaemonServing = DaemonClient(), inputStore: NativeInputStore? = nil) {
        self.client = client
        self.inputStore = inputStore ?? (client is DaemonClient ? .shared : nil)
        if client is DaemonClient {
            selectedProjectID = UserDefaults.standard.string(forKey: "falcondeck.native.selectedProject")
            selectedTaskID = UserDefaults.standard.string(forKey: "falcondeck.native.selectedTask")
            selectedSection = UserDefaults.standard.string(forKey: "falcondeck.native.selectedSection") ?? "project"
        }
    }

    var messages: [Message] { transcript.items }
    var selectedProject: Project? { allProjects.first { $0.id == selectedProjectID } }
    var selectedTask: AgentTask? { tasks.first { $0.id == selectedTaskID } }
    var extensions: JSON { extensionsForHost(selectedHostID) }
    func extensionsForHost(_ hostID: String?) -> JSON {
        guard let hostID else { return snapshotRaw["extensions"] }
        return NativeHostProjection.snapshot(remoteSnapshots[hostID] ?? .null, host: hostID)["extensions"]
    }
    var composerKey: String { draftKey }
    var pendingSubmission: NativePendingSubmission? {
        inputSubmissions.values.first { $0.composerKey == draftKey || $0.sourceKey == draftKey || ($0.threadID != nil && $0.threadID == selectedTaskID) }
    }
    var isRunning: Bool { selectedTask?.status == "running" }
    var pendingRequests: [JSON] { requests.filter { $0["thread_id"].string == selectedTaskID } }
    var availableProviders: [String] {
        let offered = selectedProject?.raw["agents"].array.map { $0["provider"].string }.filter { !$0.isEmpty } ?? []
        return offered.isEmpty ? ["codex", "claude"] : offered
    }
    private var draftKey: String { selectedTaskID ?? "draft:\(selectedProjectID ?? "none")" }
    var draft: String {
        get { drafts[draftKey, default: ""] }
        set { drafts[draftKey] = newValue; scheduleInputSave() }
    }
    var filteredTasks: [AgentTask] {
        tasks.filter {
            $0.projectID == selectedProjectID && !$0.raw["is_archived"].bool &&
            (searchText.isEmpty || $0.title.localizedCaseInsensitiveContains(searchText) || $0.preview.localizedCaseInsensitiveContains(searchText))
        }.sorted {
            if $0.raw["is_pinned"].bool != $1.raw["is_pinned"].bool { return $0.raw["is_pinned"].bool }
            return $0.updatedAt > $1.updatedAt
        }
    }

    func reconnect() async {
        if client is DaemonClient, hostTask == nil {
            let updates = NativeHostManager.shared.events()
            hostTask = Task { [weak self] in
                for await update in updates {
                    guard !Task.isCancelled else { return }
                    self?.receiveHost(update)
                }
            }
            NativeHostManager.shared.start()
        }
        if !didLoadInputs {
            do {
                let saved = try await inputStore?.load() ?? .init()
                for (key, value) in saved.drafts where drafts[key] == nil { drafts[key] = value }
                for (key, value) in saved.payloads where composerPayloads[key] == nil { composerPayloads[key] = value }
                for (key, var value) in saved.submissions where inputSubmissions[key] == nil {
                    // A check or POST interrupted by app termination cannot establish delivery.
                    if value.status == .checking { value.status = .uncertain }
                    inputSubmissions[key] = value
                }
                didLoadInputs = true
            } catch { errorMessage = "Saved input couldn’t be read. \(error.localizedDescription)" }
        }
        connectionTask?.cancel()
        connectionID = UUID()
        let identity = connectionID
        await client.disconnect()
        isConnected = false
        connectionStatus = "Connecting…"
        connectionTask = Task { [weak self] in
            var attempt = 0
            while !Task.isCancelled {
                guard let self, self.connectionID == identity else { return }
                do {
                    let stream = try await self.client.events()
                    for try await envelope in stream {
                        guard !Task.isCancelled, self.connectionID == identity else { return }
                        self.applyEnvelope(envelope)
                        if envelope["event"]["type"].string == "snapshot" {
                            attempt = 0
                            self.isConnected = true
                            self.connectionStatus = "Connected to your Mac"
                            self.errorMessage = nil
                            if let id = self.selectedTaskID {
                                let navigation = self.loadID
                                Task {
                                    guard self.selectedTaskID == id, self.loadID == navigation else { return }
                                    await self.selectTask(id)
                                }
                            }
                        }
                    }
                    if Task.isCancelled { return }
                    throw PilotError("The daemon connection closed.")
                } catch {
                    guard !Task.isCancelled, self.connectionID == identity else { return }
                    self.isConnected = false
                    self.connectionStatus = "Reconnecting…"
                    self.errorMessage = "Couldn’t connect to the local runtime. \(error.localizedDescription)"
                    await self.client.disconnect()
                    attempt = min(attempt + 1, 5)
                    do { try await Task.sleep(for: .seconds(min(pow(2.0, Double(attempt - 1)), 15))) }
                    catch { return }
                }
            }
        }
    }

    func selectProject(_ id: String) {
        selectedSection = "project"
        guard selectedProjectID != id else { return }
        selectedProjectID = id
        newTask()
        let latest = filteredTasks.first
        if let latest {
            Task {
                guard selectedProjectID == id, selectedTaskID == nil else { return }
                await selectTask(latest.id)
            }
        }
    }

    func newTask() {
        NativeAudioPlayback.shared.stopRealtime()
        selectedSection = selectedProject?.raw["kind"].string == "casual" ? "chats" : "project"
        loadID = UUID()
        selectedTaskID = nil
        transcript = Transcript()
        bufferedEvents = []
        bufferedOverflow = false
        isLoading = false
        hasOlder = false
        provider = selectedProject?.raw["default_provider"].string ?? "codex"
        if !availableProviders.contains(provider) { provider = availableProviders.first ?? "codex" }
        errorMessage = nil
        recordNavigation()
    }

    func selectTask(_ id: String) async {
        NativeAudioPlayback.shared.stopRealtime()
        guard let task = tasks.first(where: { $0.id == id }) else { return }
        let identity = UUID()
        loadID = identity
        selectedTaskID = id
        selectedProjectID = task.projectID
        if let host = NativeHostManager.split(task.projectID).hostID {
            Task { await NativeHostManager.shared.selectThread(hostID: host, threadID: NativeHostManager.split(id).id) }
        }
        if selectedSection != "pins" {
            selectedSection = allProjects.first(where: { $0.id == task.projectID })?.raw["kind"].string == "casual" ? "chats" : "project"
        }
        recordNavigation()
        provider = task.provider
        transcript = Transcript()
        bufferedEvents = []
        bufferedOverflow = false
        hasOlder = false
        isLoading = true
        defer {
            if loadID == identity {
                isLoading = false
                scheduleRecoveryIfNeeded(for: id)
                markSelectedTaskRead()
            }
        }
        do {
            let detail = try await loadDetail(task: task)
            guard loadID == identity, selectedTaskID == id else { return }
            transcript = Transcript(items: detail["items"].array.map(Message.init))
            hasOlder = detail["has_older"].bool
            upsertTask(detail["thread"])
            for event in bufferedEvents { transcript.apply(event) }
            if bufferedOverflow { transcript.needsRecovery = true }
            bufferedEvents = []
            errorMessage = nil
            markSelectedTaskRead()
        } catch {
            guard loadID == identity else { return }
            errorMessage = "Couldn’t load this task. \(error.localizedDescription)"
        }
    }

    func loadOlder() async {
        guard hasOlder, !isLoadingOlder, let task = selectedTask, let before = messages.first?.id else { return }
        let identity = loadID
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let detail = try await loadDetail(task: task, before: before)
            guard loadID == identity else { return }
            transcript.prepend(detail["items"].array.map(Message.init))
            hasOlder = detail["has_older"].bool
        } catch { if loadID == identity { errorMessage = error.localizedDescription } }
    }

    func openProject(path: String) async {
        do {
            let project = try await client.connectProject(path: path)
            if !projects.contains(where: { $0.id == project.id }) { projects.append(project) }
            if !allProjects.contains(where: { $0.id == project.id }) { allProjects.append(project) }
            selectProject(project.id)
        } catch { errorMessage = error.localizedDescription }
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await sendInputs([.object(["type": .string("text"), "text": .string(text)])])
    }

    func interrupt() async {
        guard let task = selectedTask else { return }
        do {
            if selectedHostID == nil { try await client.interrupt(projectID: task.projectID, threadID: task.id) }
            else { _ = try await request(["api", "workspaces", task.projectID, "threads", task.id, "interrupt"], method: "POST") }
        }
        catch { errorMessage = error.localizedDescription }
    }

    func respond(request: JSON, response: JSON) async throws {
        if NativeHostManager.split(request["workspace_id"].string).hostID == nil {
            try await client.respond(projectID: request["workspace_id"].string, requestID: request["request_id"].string, response: response)
        } else {
            _ = try await self.request(["api", "workspaces", request["workspace_id"].string, "interactive-requests", request["request_id"].string, "respond"], method: "POST", body: .object(["response": response]))
        }
        requests.removeAll { $0["request_id"] == request["request_id"] }
    }

    func applyEnvelope(_ envelope: JSON, originHost: String? = nil, notifyPlatform: Bool = true) {
        eventRevision &+= 1
        let event = envelope["event"], taskID = envelope["thread_id"].string
        if event["type"].string != "snapshot", originHost == nil {
            localSnapshot = NativeHostProjection.reduce(localSnapshot, envelope: envelope)
            snapshotRaw = localSnapshot
        }
        if client is DaemonClient, notifyPlatform { NativePlatform.shared.handle(envelope, hostID: originHost) }
        if taskID == selectedTaskID { NativeAudioPlayback.shared.handleRealtime(event, taskID: taskID) }
        switch event["type"].string {
        case "snapshot":
            if selectedHostID == nil { NativeAudioPlayback.shared.stopRealtime() }
            let snapshot = event["snapshot"]
            localSnapshot = snapshot
            snapshotRaw = snapshot
            preferences = snapshot["preferences"] == .null ? .object([:]) : snapshot["preferences"]
            preferenceRevision["local", default: 0] &+= 1
            allProjects = snapshot["workspaces"].array.map(Project.init)
            projects = snapshot["workspaces"].array.filter { !["scratch", "casual"].contains($0["kind"].string) }.map(Project.init)
            tasks = snapshot["threads"].array.map(AgentTask.init)
            requests = snapshot["interactive_requests"].array
            appendRemoteIndexes()
            if !allProjects.contains(where: { $0.id == selectedProjectID }) {
                let projectIDs = Set(projects.map(\.id))
                selectedProjectID = tasks.filter { projectIDs.contains($0.projectID) }.max { $0.updatedAt < $1.updatedAt }?.projectID ?? projects.first?.id
                newTask()
            }
            if let id = selectedTaskID, !tasks.contains(where: { $0.id == id }) { newTask() }
        case "thread-started", "thread-updated":
            upsertTask(event["thread"])
            if event["thread"]["id"].string == selectedTaskID { markSelectedTaskRead() }
        case "workspace-updated":
            let project = Project(event["workspace"])
            if let index = allProjects.firstIndex(where: { $0.id == project.id }) { allProjects[index] = project }
            else { allProjects.append(project) }
            guard !["scratch", "casual"].contains(project.raw["kind"].string) else { return }
            if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project }
            else { projects.append(project) }
        case "interactive-request":
            requests.removeAll { $0["request_id"] == event["request"]["request_id"] }
            requests.append(event["request"])
        case "conversation-item-added", "conversation-item-updated":
            let item = event["item"]
            if item["kind"].string == "interactive_request", item["resolved"].bool {
                requests.removeAll { $0["request_id"] == item["request"]["request_id"] }
            }
        case "turn-end": break
        case "preferences-updated":
            preferenceRevision[originHost ?? "local", default: 0] &+= 1
            if originHost == nil { preferences = event["preferences"]; snapshotRaw = snapshotRaw.setting("preferences", preferences) }
        case "extension-catalog-updated":
            if originHost == nil { snapshotRaw = snapshotRaw.setting("extensions", snapshotRaw["extensions"].setting("catalog", event["catalog"])) }
        case "extension-view-updated":
            guard originHost == nil else { break }
            var views = snapshotRaw["extensions"]["views"].array
            views.removeAll { $0["extension_id"] == event["extension_id"] && $0["view_id"] == event["view_id"] && $0["scope"] == event["scope"] }
            if event["view"] != .null { views.append(event["view"]) }
            snapshotRaw = snapshotRaw.setting("extensions", snapshotRaw["extensions"].setting("views", .array(views)))
        default: break
        }
        guard taskID == selectedTaskID else { return }
        if isLoading {
            if bufferedEvents.count < 8192 { bufferedEvents.append(event) }
            else { bufferedOverflow = true }
        }
        else { transcript.apply(event) }
        scheduleRecoveryIfNeeded(for: taskID)
    }

    private func scheduleRecoveryIfNeeded(for taskID: String) {
        if transcript.needsRecovery, recoveryTask == nil, !isLoading {
            let navigation = loadID
            recoveryTask = Task {
                defer { recoveryTask = nil }
                guard selectedTaskID == taskID, loadID == navigation else { return }
                await selectTask(taskID)
            }
        }
    }

    private func upsertTask(_ raw: JSON) {
        let task = AgentTask(raw)
        guard !task.id.isEmpty else { return }
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            if tasks[index].updatedAt > task.updatedAt { return }
            tasks[index] = task
        } else { tasks.append(task) }
    }

    func selectSection(_ section: String) {
        selectedSection = section
        if section == "chats" || section == "pins" {
            let candidates = tasks.filter { task in
                if section == "pins" { return task.pinned && !task.raw["is_archived"].bool }
                return allProjects.first(where: { $0.id == task.projectID })?.raw["kind"].string == "casual" && !task.raw["is_archived"].bool
            }.sorted { $0.updatedAt > $1.updatedAt }
            if !candidates.contains(where: { $0.id == selectedTaskID }) {
                if let task = candidates.first {
                    selectedProjectID = task.projectID
                    selectedTaskID = task.id
                    transcript = Transcript()
                    isLoading = true
                    Task { guard self.selectedSection == section else { return }; await self.selectTask(task.id) }
                } else {
                    selectedProjectID = section == "chats" ? allProjects.first(where: { $0.raw["kind"].string == "casual" })?.id : nil
                    newTask()
                    selectedSection = section
                }
            }
        }
        recordNavigation()
    }

    private func recordNavigation() {
        let entry = Navigation(section: selectedSection, project: selectedProjectID, task: selectedTaskID)
        if !restoringNavigation, (!navigationHistory.indices.contains(navigationIndex) || navigationHistory[navigationIndex] != entry) {
            if navigationIndex + 1 < navigationHistory.count { navigationHistory.removeSubrange((navigationIndex + 1)... ) }
            navigationHistory.append(entry)
            if navigationHistory.count > 100 { navigationHistory.removeFirst() }
            navigationIndex = navigationHistory.count - 1
        }
        if client is DaemonClient {
            UserDefaults.standard.set(selectedProjectID, forKey: "falcondeck.native.selectedProject")
            UserDefaults.standard.set(selectedTaskID, forKey: "falcondeck.native.selectedTask")
            UserDefaults.standard.set(selectedSection, forKey: "falcondeck.native.selectedSection")
        }
    }

    func navigateHistory(_ delta: Int) async {
        let target = navigationIndex + delta
        guard navigationHistory.indices.contains(target) else { return }
        navigationIndex = target
        let entry = navigationHistory[target]
        restoringNavigation = true
        defer { restoringNavigation = false; recordNavigation() }
        selectedProjectID = entry.project
        selectedSection = entry.section
        if let id = entry.task, tasks.contains(where: { $0.id == id }) {
            if ["project", "chats", "pins"].contains(entry.section) { await selectTask(id) }
            else { selectedTaskID = id }
        } else { newTask(); selectedSection = entry.section }
    }

    func navigateTask(_ delta: Int) async {
        let candidates = tasks.filter { $0.projectID == selectedProjectID && (showArchived || !$0.raw["is_archived"].bool) }.sorted { $0.updatedAt > $1.updatedAt }
        guard !candidates.isEmpty else { return }
        let current = candidates.firstIndex { $0.id == selectedTaskID } ?? 0
        await selectTask(candidates[(current + delta + candidates.count) % candidates.count].id)
    }

    func selectExtensionPanel(extensionID: String, panelID: String) {
        selectedExtensionID = extensionID; selectedPanelID = panelID; selectedSection = "extension-panel"
    }

    func request(_ path: String, method: String = "GET", body: JSON? = nil, hostID: String? = nil) async throws -> JSON {
        guard let components = URLComponents(string: path), components.scheme == nil, components.host == nil else {
            throw PilotError("Use a daemon API path.")
        }
        let parts = components.percentEncodedPath.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }
        return try await request(parts, method: method, query: components.queryItems ?? [], body: body, hostID: hostID)
    }

    func request(path: String, method: String = "GET", body: JSON? = nil, hostID: String? = nil) async throws -> JSON {
        try await request(path, method: method, body: body, hostID: hostID)
    }

    func request(_ path: [String], method: String = "GET", query: [URLQueryItem] = [], body: JSON? = nil, hostID: String? = nil) async throws -> JSON {
        let pathHosts = Set(path.compactMap { NativeHostManager.split($0).hostID })
        guard pathHosts.count <= 1, hostID == nil || pathHosts.isEmpty || pathHosts.contains(hostID!) else { throw PilotError("This operation combines projects from different servers.") }
        var scopedBody = body
        if var fields = body?.fields, path.count >= 3, path[0] == "api", path[1] == "workspaces" {
            fields["workspace_id"] = .string(path[2])
            if path.count >= 5, path[3] == "threads" { fields["thread_id"] = .string(path[4]) }
            scopedBody = .object(fields)
        }
        if let host = hostID ?? pathHosts.first {
            let rawPath = path.map { NativeHostManager.split($0).id }
            let relations = Set(["workspace_id", "workspaceId", "thread_id", "threadId", "folder_id", "folderId", "request_id", "requestId"])
            let rawQuery = query.map { item in
                URLQueryItem(name: item.name, value: relations.contains(item.name) ? item.value.map { NativeHostManager.split($0).id } : item.value)
            }
            let rawBody = try scopedBody.map { try NativeHostProjection.rawIDs($0, host: host) }
            let result = try await NativeHostManager.shared.request(hostID: host, path: rawPath, method: method, query: rawQuery, body: rawBody)
            return NativeHostProjection.response(result, host: host, path: rawPath)
        }
        return try await client.requestJSON(path, method: method, query: query, body: scopedBody)
    }

    func daemonEndpoint() async throws -> URL {
        if let local = client as? DaemonClient { return try await local.discover() }
        throw PilotError("No local daemon endpoint is available.")
    }

    func refresh() async {
        do {
            let snapshot = try await client.snapshot()
            applyEnvelope(.object(["event": .object(["type": .string("snapshot"), "snapshot": snapshot])]))
        } catch { errorMessage = error.localizedDescription }
    }

    func refreshSnapshot() async { await refresh() }

    func updatePreferences(_ patch: JSON) async throws {
        try await writePreferences(patch, hostID: nil)
    }

    var navigationPreferences: JSON {
        var result = preferences.fields
        let arrays = ["workspace_order", "hidden_workspace_ids", "project_folders"]
        let maps = ["workspace_icons", "workspace_colors"]
        for host in remoteSnapshots.keys.sorted() {
            let remote = NativeHostProjection.snapshot(remoteSnapshots[host] ?? .null, host: host)["preferences"]
            for key in arrays { result[key] = .array((result[key] ?? .null).array + remote[key].array) }
            for key in maps {
                result[key] = .object((result[key] ?? .null).fields.merging(remote[key].fields) { _, remote in remote })
            }
        }
        return .object(result)
    }

    func updateNavigationPreferences(_ patch: JSON, hostID: String?) async throws {
        var fields = patch.fields
        for key in ["workspace_order", "hidden_workspace_ids"] where fields[key] != nil {
            fields[key] = .array(fields[key]!.array.filter { NativeHostManager.split($0.string).hostID == hostID })
        }
        for key in ["workspace_icons", "workspace_colors"] where fields[key] != nil {
            fields[key] = .object(fields[key]!.fields.filter { NativeHostManager.split($0.key).hostID == hostID })
        }
        if let folders = fields["project_folders"] {
            fields["project_folders"] = .array(folders.array.filter { NativeHostManager.split($0["workspace_id"].string).hostID == hostID })
        }
        try await writePreferences(.object(fields), hostID: hostID)
    }

    private func writePreferences(_ patch: JSON, hostID: String?) async throws {
        let key = hostID ?? "local", previous = preferenceWrites[hostID ?? "local"]
        let write = Task { @MainActor in
            _ = try? await previous?.value
            _ = try await self.request("/api/preferences", method: "PATCH", body: patch, hostID: hostID)
            let revision = self.preferenceRevision[key, default: 0]
            let value = try await self.request("/api/preferences", hostID: hostID)
            guard self.preferenceRevision[key, default: 0] == revision else { return }
            if let hostID {
                // request() projects relation IDs for its consumer; snapshots remain raw.
                let raw = NativeHostProjection.rawIDs(value)
                self.remoteSnapshots[hostID] = (self.remoteSnapshots[hostID] ?? .object([:])).setting("preferences", raw)
            } else {
                self.preferences = value
                self.snapshotRaw = self.snapshotRaw.setting("preferences", value)
                self.localSnapshot = self.localSnapshot.setting("preferences", value)
            }
            self.eventRevision &+= 1
        }
        preferenceWrites[key] = write
        try await write.value
    }

    func updateTask(_ task: AgentTask, patch: JSON) async throws {
        let result = try await request(["api", "workspaces", task.projectID, "threads", task.id], method: "PATCH", body: patch)
        let raw = result["thread"] == .null ? result : result["thread"]
        upsertTask(raw)
    }

    func acceptTask(_ raw: JSON) async {
        let value = raw["thread"] == .null ? raw : raw["thread"]
        upsertTask(value)
        await selectTask(value["id"].string)
    }

    func newChat() async {
        let navigation = loadID, host = selectedHostID
        do {
            let result = try await request("/api/chats", method: "POST", hostID: host)
            let project = Project(result["workspace"] == .null ? result : result["workspace"])
            if !project.id.isEmpty {
                allProjects.removeAll { $0.id == project.id }; allProjects.append(project)
            }
            if !result["thread"]["id"].string.isEmpty {
                upsertTask(result["thread"])
                guard loadID == navigation else { return }
                selectedProjectID = project.id
                await selectTask(result["thread"]["id"].string)
            } else {
                guard loadID == navigation else { return }
                selectedProjectID = project.id; newTask()
            }
            selectedSection = "chats"
        } catch { errorMessage = error.localizedDescription }
    }

    func sendInputs(_ inputs: [JSON], settings: [String: JSON] = [:], preserveComposer: Bool = false) async {
        guard isSelectedHostConnected, !isSending, !inputs.isEmpty, pendingSubmission == nil, let projectID = selectedProjectID else { return }
        guard !preserveComposer || selectedTask != nil else {
            errorMessage = "Select an existing task before sending a suggested follow-up."; return
        }
        // Capture the destination and every input before saving or making any request.
        await submit(capturedSubmission(inputs: inputs, settings: settings, projectID: projectID, preserveComposer: preserveComposer))
    }

    private func capturedSubmission(inputs: [JSON], settings: [String: JSON], projectID: String, preserveComposer: Bool = false) -> NativePendingSubmission {
        let id = "user-\(UUID().uuidString.lowercased())", key = draftKey
        let task = selectedTask
        let recoveryText = preserveComposer ? inputs.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n\n") : draft
        return NativePendingSubmission(id: id, userItemID: id, sourceKey: key, composerKey: key,
            projectID: projectID, threadID: task?.id, provider: task?.provider ?? provider,
            inputs: inputs, settings: settings, draft: recoveryText, payload: preserveComposer ? .object([:]) : composerPayload(key: key),
            knownQueueIDs: Set(task?.raw["queued_turns"].array.map { $0["id"].string } ?? []), preserveComposer: preserveComposer ? true : nil)
    }

    private func submit(_ captured: NativePendingSubmission) async {
        guard !isSending else { return }
        let navigation = loadID
        var submission = captured
        var turnWasPosted = false
        var creationWasPosted = false
        submission.status = .prepared; submission.lastError = nil
        isSending = true; errorMessage = nil
        defer { isSending = false }
        inputSubmissions[submission.id] = submission
        do {
            // The recovery identity exists on disk before any mutation can reach the daemon.
            try await persistInputState()
            if submission.threadID == nil {
                var fields = submission.settings.filter { ["model_id", "permission_mode", "approval_policy", "sandbox_mode", "collaboration_mode_id", "isolation"].contains($0.key) }
                fields["workspace_id"] = .string(submission.projectID); fields["provider"] = .string(submission.provider)
                creationWasPosted = true
                let result = try await request(["api", "workspaces", submission.projectID, "threads"], method: "POST", body: .object(fields))
                let created = AgentTask(result["thread"] == .null ? result : result["thread"])
                guard !created.id.isEmpty else { throw PilotError("The daemon did not return the new task.") }
                upsertTask(created.raw)
                submission.threadID = created.id; submission.composerKey = created.id
                submission.knownQueueIDs = Set(created.raw["queued_turns"].array.map { $0["id"].string })
                if loadID == navigation, draftKey == submission.sourceKey {
                    // New edits follow the still-selected project composer into its created task.
                    drafts[created.id] = drafts.removeValue(forKey: submission.sourceKey)
                    composerPayloads[created.id] = composerPayloads.removeValue(forKey: submission.sourceKey)
                    selectedTaskID = created.id; transcript = Transcript()
                } else {
                    // Navigation cannot strand the captured input or move newer edits to another task.
                    drafts[created.id] = drafts[created.id] ?? submission.draft
                    composerPayloads[created.id] = composerPayloads[created.id] ?? submission.payload
                    if drafts[submission.sourceKey] == submission.draft { drafts.removeValue(forKey: submission.sourceKey) }
                    if composerPayload(key: submission.sourceKey) == submission.payload { composerPayloads.removeValue(forKey: submission.sourceKey) }
                }
                inputSubmissions[submission.id] = submission
                try await persistInputState()
            }
            guard let threadID = submission.threadID else { throw PilotError("The task is unavailable.") }
            let keys = ["model_id", "reasoning_effort", "permission_mode", "approval_policy", "sandbox_mode", "service_tier", "collaboration_mode_id"]
            let patch = submission.settings.filter { keys.contains($0.key) }
            if !patch.isEmpty {
                let result = try await request(["api", "workspaces", submission.projectID, "threads", threadID], method: "PATCH", body: .object(patch))
                let raw = result["thread"] == .null ? result : result["thread"]
                if !raw["id"].string.isEmpty { upsertTask(raw) }
            }
            // Persist the uncertain state before POST: a crash at any later point requires a read.
            submission.status = .uncertain
            inputSubmissions[submission.id] = submission
            try await persistInputState()
            turnWasPosted = true
            var fields = submission.settings.filter { ["model_id", "reasoning_effort", "permission_mode", "approval_policy", "sandbox_mode", "service_tier", "steer", "selected_skills", "resume_interrupted"].contains($0.key) }
            fields["workspace_id"] = .string(submission.projectID); fields["thread_id"] = .string(threadID)
            fields["inputs"] = .array(submission.inputs); fields["user_item_id"] = .string(submission.userItemID)
            _ = try await request(["api", "workspaces", submission.projectID, "threads", threadID, "turns"], method: "POST", body: .object(fields))
            acknowledgeSubmission(submission)
            try await persistInputState()
        } catch {
            if !turnWasPosted { submission.status = .prepared }
            submission.lastError = error.localizedDescription
            if creationWasPosted, submission.threadID == nil {
                submission.lastError = "Task creation wasn’t confirmed. No message was sent; retrying may leave an extra empty task. \(error.localizedDescription)"
            }
            inputSubmissions[submission.id] = submission
            // Saving may itself have failed. Retain the in-memory record and never retransmit.
            try? await persistInputState()
            errorMessage = submission.status == .prepared
                ? "Message wasn’t sent. Your input is kept. \(submission.lastError ?? error.localizedDescription)"
                : "Send wasn’t confirmed. Check delivery before retrying. \(error.localizedDescription)"
        }
    }

    private func acknowledgeSubmission(_ submission: NativePendingSubmission) {
        if submission.preserveComposer != true {
            for key in Set([submission.sourceKey, submission.composerKey]) {
                if drafts[key] == submission.draft { drafts.removeValue(forKey: key) }
                if composerPayload(key: key) == submission.payload { composerPayloads.removeValue(forKey: key) }
            }
        }
        inputSubmissions.removeValue(forKey: submission.id)
    }

    func recheckPendingSubmission() async {
        guard !isSending, var submission = pendingSubmission, submission.status != .checking else { return }
        guard let threadID = submission.threadID else {
            submission.status = .prepared; inputSubmissions[submission.id] = submission
            try? await persistInputState(); return
        }
        submission.status = .checking; submission.lastError = nil
        inputSubmissions[submission.id] = submission
        do {
            let task = AgentTask(.object(["id": .string(threadID), "workspace_id": .string(submission.projectID), "provider": .string(submission.provider)]))
            var detail = try await loadDetail(task: task)
            var queued = detail["thread"]["queued_turns"].array
            var cursors = Set<String>()
            var found = false
            for _ in 0..<500 {
                if detail["items"].array.contains(where: { $0["id"].string == submission.userItemID }) { found = true; break }
                guard detail["has_older"].bool else { break }
                guard let before = detail["items"].array.first?["id"].string.nonempty, cursors.insert(before).inserted else {
                    throw PilotError("The full conversation could not be checked. Delivery is still uncertain.")
                }
                detail = try await loadDetail(task: task, before: before)
            }
            if !found, detail["has_older"].bool { throw PilotError("The conversation is too large to finish checking. Delivery is still uncertain.") }
            if !found {
                // Re-read the newest page after pagination to catch a queue dispatch during the scan.
                let latest = try await loadDetail(task: task)
                found = latest["items"].array.contains { $0["id"].string == submission.userItemID }
                queued += latest["thread"]["queued_turns"].array
            }
            guard inputSubmissions[submission.id] != nil else { return }
            if found { acknowledgeSubmission(submission) }
            else if queued.contains(where: { !submission.knownQueueIDs.contains($0["id"].string) }) {
                // Queue summaries do not carry user_item_id. Similar text is not proof of identity.
                submission.status = .uncertain
                submission.lastError = "A new queued message may be this send. Inspect the queue or let it run, then check again."
                inputSubmissions[submission.id] = submission
            } else {
                submission.status = .checkedMissing
                submission.lastError = "This message ID was not found in the conversation or queue. You can retry it manually."
                inputSubmissions[submission.id] = submission
            }
            try await persistInputState()
        } catch {
            guard inputSubmissions[submission.id] != nil else { return }
            submission.status = .uncertain; submission.lastError = error.localizedDescription
            inputSubmissions[submission.id] = submission
            try? await persistInputState()
            errorMessage = "Delivery couldn’t be checked. \(error.localizedDescription)"
        }
    }

    func retryPendingSubmission() async {
        guard isSelectedHostConnected, !isSending, let submission = pendingSubmission,
              submission.status == .prepared || submission.status == .checkedMissing else { return }
        if submission.status == .checkedMissing {
            // Delivery can change after the first check; read again at the explicit retry action.
            await recheckPendingSubmission()
            guard let checked = inputSubmissions[submission.id], checked.status == .checkedMissing,
                  pendingSubmission?.id == submission.id else { return }
            await submit(checked)
        } else { await submit(submission) }
    }

    func recoverPendingSubmission() async {
        guard !isSending, let submission = pendingSubmission else { return }
        restoreSubmissionInput(submission)
        do { try await persistInputState() } catch { errorMessage = error.localizedDescription }
    }

    func dismissPendingSubmission(acknowledgeDeliveryRisk: Bool = false) async {
        guard !isSending, let submission = pendingSubmission, submission.status != .checking,
              submission.status == .prepared || submission.status == .checkedMissing || acknowledgeDeliveryRisk else { return }
        restoreSubmissionInput(submission)
        inputSubmissions.removeValue(forKey: submission.id)
        do { try await persistInputState() }
        catch { inputSubmissions[submission.id] = submission; errorMessage = error.localizedDescription }
    }

    private func restoreSubmissionInput(_ submission: NativePendingSubmission) {
        let key = submission.composerKey
        let current = drafts[key, default: ""]
        if current.isEmpty { drafts[key] = submission.draft }
        else if !submission.draft.isEmpty, current != submission.draft, !current.hasPrefix(submission.draft + "\n\n") {
            drafts[key] = submission.draft + "\n\n" + current
        }
        var payload = composerPayload(key: key).fields
        let existing = payload["attachments"]?.array ?? []
        let recovered = submission.payload["attachments"].array
        let recoveredIDs = Set(recovered.map { $0["id"].string })
        if !recovered.isEmpty { payload["attachments"] = .array(recovered + existing.filter { !recoveredIDs.contains($0["id"].string) }) }
        let quote = submission.payload["quote"].string, currentQuote = payload["quote"]?.string ?? ""
        if currentQuote.isEmpty { payload["quote"] = .string(quote) }
        else if !quote.isEmpty, currentQuote != quote, !currentQuote.hasPrefix(quote + "\n\n") { payload["quote"] = .string(quote + "\n\n" + currentQuote) }
        composerPayloads[key] = .object(payload)
    }

    func composerPayload(key: String) -> JSON { composerPayloads[key] ?? .object([:]) }
    func setComposerPayload(_ value: JSON, key: String) { composerPayloads[key] = value; scheduleInputSave() }

    private func scheduleInputSave() {
        inputRevision &+= 1
        inputWriteTask?.cancel()
        inputWriteTask = Task {
            do { try await Task.sleep(for: .milliseconds(250)); try await persistInputState() }
            catch is CancellationError {}
            catch { errorMessage = "Input couldn’t be saved. \(error.localizedDescription)" }
        }
    }

    func persistInputState() async throws {
        guard inputStore == nil || didLoadInputs else {
            // A locked keychain or unreadable file must never be overwritten by an empty session.
            throw PilotError("Saved input has not been restored. Reconnect to unlock input recovery before sending.")
        }
        inputRevision &+= 1
        try await inputStore?.save(.init(drafts: drafts, payloads: composerPayloads, submissions: inputSubmissions), revision: inputRevision)
    }

    func selectHost(_ id: String?) async {
        if let id, let project = allProjects.first(where: { NativeHostManager.split($0.id).hostID == id }) { selectProject(project.id) }
        else if let project = projects.first(where: { NativeHostManager.split($0.id).hostID == nil }) { selectProject(project.id) }
    }

    func prepareForQuit() async {
        connectionTask?.cancel(); connectionTask = nil
        recoveryTask?.cancel(); recoveryTask = nil
        hostTask?.cancel(); hostTask = nil
        inputWriteTask?.cancel(); inputWriteTask = nil
        connectionID = UUID(); loadID = UUID()
        NativeAudioPlayback.shared.stop()
        NativeAudioPlayback.shared.stopRealtime()
        await client.disconnect()
        if client is DaemonClient {
            for host in NativeHostManager.shared.hosts { await NativeHostManager.shared.disconnect(hostID: host.id) }
        }
        try? await persistInputState()
    }

    func markSelectedTaskRead() {
        guard client is DaemonClient, NSApp?.isActive == true, NSApp?.keyWindow != nil,
              NativePlatform.nativeDesktopPresence() != false,
              ["project", "chats", "pins"].contains(selectedSection), let task = selectedTask,
              !isLoading else { return }
        let sequence = task.raw["attention"]["last_agent_activity_seq"].int
        guard sequence > (lastReadSequences[task.id] ?? -1) else { return }
        lastReadSequences[task.id] = sequence
        let navigation = loadID
        Task {
            guard selectedTaskID == task.id, loadID == navigation, NSApp?.isActive == true else { return }
            do {
                if NativeHostManager.split(task.projectID).hostID == nil {
                    try await client.markRead(projectID: task.projectID, threadID: task.id, readSeq: sequence)
                } else {
                    _ = try await request(["api", "workspaces", task.projectID, "threads", task.id, "read"], method: "POST", body: .object(["read_seq": .number(Double(sequence))]))
                }
            } catch { if lastReadSequences[task.id] == sequence { lastReadSequences.removeValue(forKey: task.id) } }
        }
    }

    private func loadDetail(task: AgentTask, before: String? = nil) async throws -> JSON {
        guard NativeHostManager.split(task.projectID).hostID != nil else {
            return try await client.threadDetail(projectID: task.projectID, threadID: task.id, before: before)
        }
        var query = [URLQueryItem(name: "mode", value: before == nil ? "tail" : "before"), URLQueryItem(name: "limit", value: "60"), URLQueryItem(name: "strict_limit", value: "true"), URLQueryItem(name: "inline_images", value: "false")]
        if let before { query.append(.init(name: "before_item_id", value: before)) }
        return try await request(["api", "workspaces", task.projectID, "threads", task.id], query: query)
    }

    private func appendRemoteIndexes() {
        for (host, value) in remoteSnapshots {
            let projected = NativeHostProjection.snapshot(value, host: host)
            allProjects += projected["workspaces"].array.map(Project.init)
            projects += projected["workspaces"].array.filter { !["scratch", "casual"].contains($0["kind"].string) }.map(Project.init)
            tasks += projected["threads"].array.map(AgentTask.init)
            requests += projected["interactive_requests"].array
        }
    }

    func receiveHost(_ update: NativeHostUpdate) {
        switch update.event {
        case .snapshot(let value):
            remoteStatuses[update.hostID] = .connected
            remoteSnapshots[update.hostID] = value
            preferenceRevision[update.hostID, default: 0] &+= 1
            if client is DaemonClient { NativePlatform.shared.handle(.object(["event": .object(["type": .string("snapshot"), "snapshot": value])]), hostID: update.hostID) }
            rebuildIndexes()
            recoverRemoteSelection(hostID: update.hostID)
        case .events(let values), .rebase(let values):
            for value in values {
                remoteSnapshots[update.hostID] = NativeHostProjection.reduce(remoteSnapshots[update.hostID] ?? .object([:]), envelope: value)
                if client is DaemonClient { NativePlatform.shared.handle(value, hostID: update.hostID) }
                if value["event"]["type"].string == "snapshot" {
                    preferenceRevision[update.hostID, default: 0] &+= 1
                    rebuildIndexes()
                    recoverRemoteSelection(hostID: update.hostID)
                    continue
                }
                let scoped = NativeHostProjection.envelope(value, host: update.hostID)
                applyEnvelope(scoped, originHost: update.hostID, notifyPlatform: false)
            }
        case .removed:
            if client is DaemonClient { NativePlatform.shared.handle(.object(["event": .object(["type": .string("snapshot"), "snapshot": .object([:])])]), hostID: update.hostID) }
            remoteSnapshots.removeValue(forKey: update.hostID)
            remoteStatuses.removeValue(forKey: update.hostID)
            rebuildIndexes()
        case .status(let status, _): remoteStatuses[update.hostID] = status; eventRevision &+= 1
        }
    }

    private func rebuildIndexes() {
        allProjects = localSnapshot["workspaces"].array.map(Project.init)
        projects = allProjects.filter { !["scratch", "casual"].contains($0.raw["kind"].string) }
        tasks = localSnapshot["threads"].array.map(AgentTask.init)
        requests = localSnapshot["interactive_requests"].array
        appendRemoteIndexes()
        if let id = selectedProjectID, !allProjects.contains(where: { $0.id == id }) {
            selectedProjectID = projects.first?.id
            newTask()
        } else if let id = selectedTaskID, !tasks.contains(where: { $0.id == id }) { newTask() }
        eventRevision &+= 1
    }

    private func recoverRemoteSelection(hostID: String) {
        guard selectedHostID == hostID, let taskID = selectedTaskID, !isLoading else { return }
        let navigation = loadID
        Task {
            guard loadID == navigation, selectedTaskID == taskID, selectedHostID == hostID else { return }
            await selectTask(taskID)
        }
    }
}
